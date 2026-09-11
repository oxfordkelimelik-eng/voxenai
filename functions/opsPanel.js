// Uygulama-içi gizli işletim paneli — satın alma + üretim istatistikleri.
//
// GÜVENLİK: Firestore rules'a dokunulmadı (users/{uid}/private/** hâlâ
// yalnızca sahibi tarafından okunabilir). Bunun yerine buradaki iki callable,
// çağıranın Firebase ID token'ındaki email claim'ini OPS_EMAIL ile
// karşılaştırıp eşleşmezse reddediyor; eşleşirse Admin SDK ile (rules'ı
// bypass ederek) tüm kullanıcılardaki veriyi toplayıp döndürüyor. İsimler
// bilinçli olarak nötr ("ops", "admin" değil) — güvenliğin kendisi email
// kontrolüne dayanıyor, bu sadece ek bir gizlilik katmanı.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  admin, db, bucket, assertSafeId, signedDownloadUrl,
  enforceRateLimit, checkAppAttestation,
} = require("./_shared");

// productId -> TL fiyat. payments.js'teki PRODUCT_CREDITS ile EL İLE senkron
// tutulmalı (kredi tarafı orada, fiyat tarafı burada — panel sadece ciro
// göstermek için fiyatı biliyor, doğrulama akışı fiyata bakmaz).
const PRODUCT_PRICES_TRY = {
  dating_pack_photo10: 349,
  dating_pack_photo50: 999,
  dating_pack_analysis1: 99,
  dating_pack_analysis5: 249,
};

function priceForProduct(productId) {
  return PRODUCT_PRICES_TRY[productId] || 0;
}

// Küçük harfe normalize edilmiş — Firebase/IdP tarafı email case'ini garanti
// aynı tutmuyor (Gmail case-insensitive'dir), tam eşitlik yanlışlıkla
// erişimi reddedebilirdi.
const OPS_EMAIL = "destek@voxenai.com.tr";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

// Hız sınırı: bu paneli tek kullanıcı çağırıyor, aşırı sık çağrı için gerçek
// bir ihtiyaç yok — düşük ama makul bir tavan, hem yanlış-email deneme
// gürültüsünü hem de kazara sonsuz döngü/otomatik yenileme riskini keser.
const RL_OPS = { max: 60, windowMs: 10 * 60 * 1000,
  message: "Çok fazla istek gönderildi. Bir süre sonra tekrar dene." };

/**
 * assertOps'un email karşılaştırma mantığı — SAF fonksiyon (I/O yok), test
 * edilebilirlik için ayrıldı (bkz. functions/test/opsPanel.test.js).
 * email_verified undefined İSE true kabul edilir (mevcut `!== false`
 * davranışı bilerek korunuyor — bazı token'larda bu alan hiç gelmeyebilir).
 */
function isAuthorizedOpsEmail(tokenEmail, tokenEmailVerified) {
  const email = (tokenEmail || "").toLowerCase().trim();
  return !!email && email === OPS_EMAIL && tokenEmailVerified !== false;
}

async function assertOps(request, fnName) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş gerekli.");
  }
  if (!isAuthorizedOpsEmail(request.auth.token.email, request.auth.token.email_verified)) {
    // Generic mesaj — "ops"/"admin" kelimesi geçmez, panelin varlığını ifşa
    // etmez. Yanlış email de dahil HER durumda aynı hata/mesaj döner —
    // "email var ama yanlış" ile "email yok" arasında ayrım yapılmaz.
    throw new HttpsError("permission-denied", "Yetkisiz.");
  }
  // App Check + hız sınırı, YALNIZCA email eşleştikten sonra kontrol edilir
  // — yanlış email zaten en erken noktada (yukarıda) reddedilir, bu iki
  // kontrol geçerli kullanıcı için ek savunma katmanıdır.
  checkAppAttestation(request, fnName);
  await enforceRateLimit(request.auth.uid, fnName, RL_OPS);
}

/** doc path: users/{uid}/private/.../{collectionId}/{docId} -> uid çıkar.
 * SAF fonksiyon — gerçek Firestore DocumentReference gerektirmez, sadece
 * .parent/.id property'lerine bakar (bkz. test dosyasındaki düz obje mock). */
function uidFromDocPath(docRef) {
  // parent = collection, parent.parent = doc(uid), ... users/{uid} her zaman
  // path'in ilk iki segmenti (bkz. tüm genData/payments path'leri).
  let cur = docRef;
  while (cur.parent && cur.parent.id !== "users") {
    cur = cur.parent.parent;
    if (!cur) return null;
  }
  return cur ? cur.id : null;
}

/** gs://bucket/path -> path. https:// URL ise null (çağıran orijinali kullanır). */
function gsPathFromUrl(gsUrl) {
  if (!gsUrl || typeof gsUrl !== "string") return null;
  const m = /^gs:\/\/[^/]+\/(.+)$/.exec(gsUrl);
  return m ? m[1] : null;
}

/**
 * Firestore'daki bazı eski dokümanlarda "string" alanlar (detail, reason vb.)
 * yanlışlıkla obje olarak yazılmış olabiliyor — bu, Flutter tarafında
 * `as String?` cast'inde "type 'Map<...>' is not a subtype of type 'String?'"
 * hatasına yol açıyordu. Panel hiçbir zaman ham obje döndürmemeli; obje ise
 * JSON'a çevrilip gösterilir, aksi hâlde string'e zorlanır.
 */
function safeString(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** rejectedFrames dizisinden gate -> sayaç. */
function extractGateCounts(rejectedFrames) {
  const counts = {};
  for (const f of rejectedFrames || []) {
    const gate = safeString(f && f.gate) || "?";
    counts[gate] = (counts[gate] || 0) + 1;
  }
  return counts;
}

/** Birden fazla işin gateCounts'unu tek toplam haritada birleştirir. */
function aggregateGateCounts(jobs) {
  const total = {};
  for (const j of jobs || []) {
    for (const [gate, n] of Object.entries(j.gateCounts || {})) {
      total[gate] = (total[gate] || 0) + n;
    }
  }
  return total;
}

/** processedPurchases doküman listesinden özet — ciro (TL) dahil. */
function buildPurchaseSummary(purchases) {
  return {
    totalPurchases: purchases.length,
    uniqueBuyers: new Set(purchases.map((p) => p.uid)).size,
    productCounts: purchases.reduce((acc, p) => {
      acc[p.productId] = (acc[p.productId] || 0) + 1;
      return acc;
    }, {}),
    totalRevenueTry: purchases.reduce((n, p) => n + priceForProduct(p.productId), 0),
  };
}

// Türkiye saatine göre "YYYY-MM-DD" gün anahtarı — Cloud Functions runtime'ı
// UTC çalıştığı için Intl ile İstanbul ofseti uygulanır (sabit +03 yerine
// bunu kullanmak DST gibi durumlarda da doğru kalır).
const TR_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
});
function trDayKey(millis) {
  if (!millis) return "?";
  return TR_DAY_FORMATTER.format(new Date(millis)); // en-CA -> "YYYY-MM-DD"
}

/**
 * Satın almaları TR gününe göre gruplar: her gün için satış adedi, ciro,
 * ve ürün kırılımı. Panelin "günlük detaylı çıktı" ihtiyacı için — tarihe
 * göre azalan sırada (en yeni gün önce) döner.
 */
function buildDailyBreakdown(purchases) {
  const byDay = new Map();
  for (const p of purchases) {
    const day = trDayKey(p.createdAt);
    if (!byDay.has(day)) {
      byDay.set(day, { day, count: 0, revenueTry: 0, productCounts: {}, items: [] });
    }
    const bucket = byDay.get(day);
    bucket.count += 1;
    bucket.revenueTry += priceForProduct(p.productId);
    bucket.productCounts[p.productId] = (bucket.productCounts[p.productId] || 0) + 1;
    // Panelin günlük kartında "kim, ne aldı, ne zaman" gösterebilmesi için
    // satır bazlı liste — sadece toplamlar yetersizdi.
    bucket.items.push({
      email: p.email || null,
      productId: p.productId,
      priceTry: priceForProduct(p.productId),
      createdAt: p.createdAt,
    });
  }
  for (const bucket of byDay.values()) {
    bucket.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** genJobs doküman listesinden özet — kapı dağılımı ve iş türü sayaçları dahil. */
function buildJobSummary(jobs) {
  return {
    totalJobs: jobs.length,
    uniqueProducers: new Set(jobs.map((j) => j.uid)).size,
    statusCounts: jobs.reduce((acc, j) => {
      acc[j.status] = (acc[j.status] || 0) + 1;
      return acc;
    }, {}),
    totalDelivered: jobs.reduce((n, j) => n + j.deliveredCount, 0),
    totalRejected: jobs.reduce((n, j) => n + j.rejectedCount, 0),
    gateCounts: aggregateGateCounts(jobs),
    // İş türü kırılımı: ücretsiz deneme / paket ücretiyle / başarısız.
    // Panelde bu ayrımı elle çıkarmak gerekiyordu — burada bir kez hesaplanır.
    freeTierJobs: jobs.filter((j) => j.usedFreeTier).length,
    paidJobs: jobs.filter((j) => !j.usedFreeTier && j.packUnitsCharged > 0).length,
    failedJobs: jobs.filter((j) => j.status === "failed").length,
  };
}

exports.opsGetOverview = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    await assertOps(request, "opsGetOverview");
    const { sinceMillis, untilMillis } = request.data || {};
    const until = untilMillis ? new Date(untilMillis) : new Date();
    const since = sinceMillis ? new Date(sinceMillis) : new Date(until.getTime() - DEFAULT_WINDOW_MS);

    // Admin (OPS_EMAIL) hesabının kendi test satın almalarını ciro/satış
    // istatistiklerinden dışlamak için uid'i gerekiyor. Bulunamazsa (örn.
    // hesap yoksa) sessizce hiçbir şey filtrelenmez.
    let opsUid = null;
    try {
      opsUid = (await admin.auth().getUserByEmail(OPS_EMAIL)).uid;
    } catch { /* admin hesabı yoksa filtrelenecek bir şey yok */ }

    const [purchaseSnap, jobSnap] = await Promise.all([
      db.collectionGroup("processedPurchases")
        .where("createdAt", ">=", since)
        .where("createdAt", "<=", until)
        .orderBy("createdAt", "desc")
        .get(),
      db.collectionGroup("genJobs")
        .where("createdAt", ">=", since)
        .where("createdAt", "<=", until)
        .orderBy("createdAt", "desc")
        .limit(200)
        .get(),
    ]);

    const purchases = purchaseSnap.docs
      .filter((doc) => uidFromDocPath(doc.ref) !== opsUid)
      .map((doc) => {
        const d = doc.data();
        return {
          uid: uidFromDocPath(doc.ref),
          orderId: doc.id,
          productId: d.productId || null,
          platform: d.platform || null,
          creditedField: d.creditedField || null,
          creditedAmount: d.creditedAmount || 0,
          priceTry: priceForProduct(d.productId),
          createdAt: d.createdAt ? d.createdAt.toMillis() : null,
        };
      });

    const jobs = jobSnap.docs.map((doc) => {
      const d = doc.data();
      const results = d.results || {};
      const deliveredCount = Object.values(results).reduce(
        (n, r) => n + ((r && r.photoUrls && r.photoUrls.length) || 0), 0
      );
      const rejectedFrames = Array.isArray(d.rejectedFrames) ? d.rejectedFrames : [];
      return {
        uid: uidFromDocPath(doc.ref),
        jobId: doc.id,
        status: d.status || null,
        styles: d.styles || null,
        photoMode: d.photoMode || null,
        model: d.model || null,
        usedFreeTier: !!d.usedFreeTier,
        packUnitsCharged: d.packUnitsCharged || 0,
        errorMessage: safeString(d.errorMessage),
        deliveredCount,
        rejectedCount: rejectedFrames.length,
        gateCounts: extractGateCounts(rejectedFrames),
        createdAt: d.createdAt ? d.createdAt.toMillis() : null,
        updatedAt: d.updatedAt ? d.updatedAt.toMillis() : null,
      };
    });

    // Panelde "hangi kullanıcı" sorusu email ile cevaplanıyor — uid tek
    // başına anlamsız. Firebase Auth toplu sorgu 100'lük sayfalar hâlinde
    // yapılır (getUsers tek çağrıda en fazla 100 identifier kabul eder).
    const uids = Array.from(new Set(
      [...purchases, ...jobs].map((x) => x.uid).filter(Boolean)
    ));
    const emailByUid = new Map();
    for (let i = 0; i < uids.length; i += 100) {
      const batch = uids.slice(i, i + 100).map((uid) => ({ uid }));
      try {
        const result = await admin.auth().getUsers(batch);
        for (const u of result.users) emailByUid.set(u.uid, u.email || null);
      } catch (e) {
        console.error("ops: kullanıcı email çözümleme hatası (atlanıyor):", e.message || e);
      }
    }
    for (const p of purchases) p.email = emailByUid.get(p.uid) || null;
    for (const j of jobs) j.email = emailByUid.get(j.uid) || null;

    const summary = {
      ...buildPurchaseSummary(purchases),
      ...buildJobSummary(jobs),
    };

    return { summary, purchases, jobs, dailyBreakdown: buildDailyBreakdown(purchases) };
  }
);

/**
 * jobId'den uid bulur — panelde işlerin listesi genelde uid ile birlikte
 * gelir, ama sadece jobId biliniyorsa (örn. dosya adından/loglardan) uid'i
 * bulmak için collectionGroup taraması gerekir. opsGetJobDetail bu uid'i
 * gerektirdiği için, önce bu çağrılır.
 */
exports.opsFindJobByJobId = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    await assertOps(request, "opsFindJobByJobId");
    const { jobId } = request.data || {};
    if (!jobId) {
      throw new HttpsError("invalid-argument", "jobId zorunlu.");
    }
    assertSafeId(jobId, "jobId");

    const snap = await db.collectionGroup("genJobs").get();
    let found = null;
    snap.forEach((d) => { if (d.id === jobId) found = d; });
    if (!found) {
      throw new HttpsError("not-found", "İş bulunamadı.");
    }
    return { uid: uidFromDocPath(found.ref), jobId };
  }
);

exports.opsGetJobDetail = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30 },
  async (request) => {
    await assertOps(request, "opsGetJobDetail");
    const { uid, jobId } = request.data || {};
    if (!uid || !jobId) {
      throw new HttpsError("invalid-argument", "uid ve jobId zorunlu.");
    }
    assertSafeId(uid, "uid");
    assertSafeId(jobId, "jobId");

    const snap = await db.doc(`users/${uid}/private/genData/genJobs/${jobId}`).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "İş bulunamadı.");
    }
    const job = snap.data();

    async function resolveGsUrl(gsUrl) {
      const path = gsPathFromUrl(gsUrl);
      if (path == null) return gsUrl || null; // gs:// değilse (https zaten) olduğu gibi dön
      try {
        return await signedDownloadUrl(bucket().file(path));
      } catch (e) {
        console.error("ops: gs:// çözümleme hatası (atlanıyor):", e.message || e);
        return null;
      }
    }

    const results = {};
    for (const [styleId, r] of Object.entries(job.results || {})) {
      results[styleId] = {
        status: r.status || null,
        photoUrls: await Promise.all((r.photoUrls || []).map(resolveGsUrl)),
      };
    }

    const rejectedFrames = await Promise.all(
      (job.rejectedFrames || []).map(async (f) => ({
        gate: safeString(f.gate),
        chunkIdx: f.chunkIdx ?? null,
        attempt: f.attempt ?? null,
        reason: safeString(f.reason),
        detail: safeString(f.detail),
        rejectedAt: safeString(f.rejectedAt),
        url: await resolveGsUrl(f.gsUrl),
      }))
    );

    let email = null;
    try {
      const userRecord = await admin.auth().getUser(uid);
      email = userRecord.email || null;
    } catch (e) {
      console.error("ops: kullanıcı email çözümleme hatası (atlanıyor):", e.message || e);
    }

    return {
      uid, jobId, email,
      status: job.status || null,
      styles: job.styles || null,
      photoMode: job.photoMode || null,
      model: job.model || null,
      usedFreeTier: !!job.usedFreeTier,
      packUnitsCharged: job.packUnitsCharged || 0,
      errorMessage: safeString(job.errorMessage),
      createdAt: job.createdAt ? job.createdAt.toMillis() : null,
      updatedAt: job.updatedAt ? job.updatedAt.toMillis() : null,
      results,
      rejectedFrames,
    };
  }
);

// Test-only exports — barrel dosyası (index.js) bu ismi SEÇMEDİĞİ için
// gerçek bir Cloud Function olarak deploy edilmez, sadece
// functions/test/opsPanel.test.js bunları require eder.
exports._testables = {
  isAuthorizedOpsEmail,
  uidFromDocPath,
  gsPathFromUrl,
  extractGateCounts,
  aggregateGateCounts,
  buildPurchaseSummary,
  buildJobSummary,
  safeString,
  buildDailyBreakdown,
};
