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
//
// EKSİK GİRİŞ = SESSİZCE ₺0 (2026-09-20, gerçek olay): 19 Eylül'de paketler
// 5/10/25'e geçince bu tablo GÜNCELLENMEDİ. priceForProduct bilmediği bir
// productId'de 0 döndürüyor — panelde "AI Foto Diamond (25 + 3 analiz)"
// satışı ₺0 göründü. Krediler doğruydu (payments.js ayrı bir yoldan,
// PRODUCT_CREDITS'ten okuyor) — yalnızca panelin CİRO SAYACI kördü.
// Apple'ın işlemin kendisine sorulmasıyla doğrulandı: kredi tarafı sağlamdı,
// yalnızca bu tablo eksikti.
const PRODUCT_PRICES_TRY = {
  dating_pack_photos5: 349,
  dating_pack_photos10: 499,
  dating_pack_photos25: 999,
  // Opsiyonel analiz eklentili paketler (2026-09-21) — bkz. payments.js
  // PRODUCT_CREDITS aynı başlık. Bu tablo unutulursa aynı ₺0 hatası
  // tekrarlanır (yukarıdaki not), o yüzden yeni ürün eklenirken İKİSİ
  // BİRDEN güncellenmeli.
  dating_pack_photos5_solo: 349,
  dating_pack_photos5_analysis1: 499,
  dating_pack_photos10_solo: 499,
  dating_pack_photos10_analysis3: 799,
  dating_pack_photos25_solo: 999,
  dating_pack_photos25_analysis5: 1299,
  // Eski paketler — geçmiş satışlar hâlâ bu ID'lerle kayıtlı, satıştan
  // kalksalar bile geçmiş rapor tutarlılığı için burada kalıyorlar.
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
// TAVAN 60 -> 200 (2026-09-13). 60, panelin gerçek kullanımına dar geldi:
// 4 sekme + yenile düğmesi + iş detayına girip geri dönmek tek oturumda
// onlarca çağrı demek ve sayaç dolduğunda panel 10 dakika boyunca TAMAMEN
// kullanılamaz hale geliyordu (gerçek olay: 5 dakikada 60/60). Asıl kök
// sebep önbellek anahtarının oynaklığıydı (bkz. ops_providers.dart
// toRange) ve o düzeltildi; bu tavan artışı ikinci savunma katmanı —
// sınır hâlâ var (kazara sonsuz döngüyü yine keser) ama normal kullanımı
// engellemiyor. Paneli tek kişi çağırıyor, maliyet riski yok.
const RL_OPS = { max: 200, windowMs: 10 * 60 * 1000,
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
    // ONAY BEKLEYEN (2026-09-22): otomatik onay YOK — kullanıcı ödemesini
    // yaptı ve biz onaylayana kadar hiçbir kare göremiyor. Bu sayaç panelde
    // en üstte durmalı; unutulan bir iş doğrudan bekleyen bir müşteri demek.
    pendingApprovalJobs: jobs.filter((j) => j.status === "pendingApproval").length,
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

    // ONAY EKRANI İÇİN (2026-09-22): her kare, imzalı URL'inin YANINDA ham
    // gs:// adresiyle birlikte dönüyor. Panel seçimi gs:// üzerinden
    // gönderir — imzalı URL süreli ve tek kullanımlık olduğu için kimlik
    // olarak kullanılamaz.
    const results = {};
    for (const [styleId, r] of Object.entries(job.results || {})) {
      results[styleId] = {
        status: r.status || null,
        photoUrls: await Promise.all((r.photoUrls || []).map(resolveGsUrl)),
        photoRefs: (r.photoUrls || []).slice(),
      };
    }

    // Teslim edilmiş (onaylanmış) kareler — eski işlerde bu alan YOKTUR,
    // orada teslim listesi results.photoUrls'ün kendisidir.
    const approvedRefs = job.approvedPhotoUrls || [];
    const approvedPhotos = await Promise.all(approvedRefs.map(resolveGsUrl));

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
      // Onay ekranı: kaç kare seçilebilir (photoCount), kaçı üretildi
      // (generateCount), şu an teslim edilmiş olanlar hangileri.
      photoCount: job.photoCount || 0,
      generateCount: job.generateCount || 0,
      approvedPhotos,
      approvedRefs,
      approvedAt: job.approvedAt ? job.approvedAt.toMillis() : null,
      approvedBy: safeString(job.approvedBy),
      packUnitsCharged: job.packUnitsCharged || 0,
      errorMessage: safeString(job.errorMessage),
      createdAt: job.createdAt ? job.createdAt.toMillis() : null,
      updatedAt: job.updatedAt ? job.updatedAt.toMillis() : null,
      results,
      rejectedFrames,
    };
  }
);

// ============================================================
// FOTO ONAYI (2026-09-22, kullanıcı kararı)
// ------------------------------------------------------------
// Üretim artık kullanıcıya doğrudan teslim etmiyor: kareler staging'e
// yazılıyor, iş "pendingApproval"da bekliyor ve YALNIZCA buradan onaylanan
// kareler kullanıcının klasörüne kopyalanıyor (bkz. falPhotos.js
// stagingPhotoPath). Otomatik onay YOK — kullanıcı kararı.
// ============================================================

const STAGING_PREFIX = "dating_staging/";
const RESULTS_PREFIX = "dating_results/";

/**
 * Onaylanan staging yolunu kullanıcının okuyabildiği sonuç yoluna çevirir.
 * Yalnızca ön eki değiştirir; dosya adı korunur ki aynı kare iki kez
 * onaylanırsa üzerine yazılsın, kopyası çoğalmasın.
 */
function resultPathForStaging(stagingPath) {
  return RESULTS_PREFIX + stagingPath.slice(STAGING_PREFIX.length);
}

/**
 * Seçilen gs:// adreslerini doğrular.
 *
 * GÜVENLİK: yol, İSTEMCİDEN gelir. Doğrulamadan kopyalamak, ops hesabı ele
 * geçirilirse bucket'ın herhangi bir dosyasını kullanıcının klasörüne
 * taşımaya izin verirdi. Bu yüzden her yol hem staging ön ekinde hem de
 * TAM OLARAK bu uid/jobId altında olmak zorunda; ayrıca yalnızca işin
 * kendi ürettiği kareler (staged kümesi) kabul edilir.
 *
 * SAF fonksiyon — testten doğrudan çağrılabilsin diye Firestore/Storage'a
 * dokunmaz.
 */
function validateApprovalSelection({ selected, staged, uid, jobId, maxCount }) {
  if (!Array.isArray(selected)) {
    throw new HttpsError("invalid-argument", "selectedUrls dizi olmalı.");
  }
  if (selected.length > maxCount) {
    throw new HttpsError(
      "invalid-argument",
      `En fazla ${maxCount} fotoğraf onaylanabilir (${selected.length} seçildi).`
    );
  }
  const stagedSet = new Set(staged);
  const expectedPrefix = `${STAGING_PREFIX}${uid}/${jobId}/`;
  const paths = [];
  const seen = new Set();
  for (const url of selected) {
    if (!stagedSet.has(url)) {
      throw new HttpsError("invalid-argument", "Bu işe ait olmayan fotoğraf seçildi.");
    }
    if (seen.has(url)) {
      throw new HttpsError("invalid-argument", "Aynı fotoğraf iki kez seçilmiş.");
    }
    seen.add(url);
    const path = gsPathFromUrl(url);
    if (!path || !path.startsWith(expectedPrefix) || path.includes("..")) {
      throw new HttpsError("invalid-argument", "Geçersiz fotoğraf yolu.");
    }
    paths.push(path);
  }
  return paths;
}

/** İşin staging'deki TÜM karelerini (results.*.photoUrls) tek listede toplar. */
function stagedPhotoUrls(job) {
  const out = [];
  for (const r of Object.values(job.results || {})) {
    for (const u of r?.photoUrls || []) out.push(u);
  }
  return out;
}

exports.opsApprovePhotos = onCall(
  { region: "europe-west1", memory: "512MiB", timeoutSeconds: 300 },
  async (request) => {
    await assertOps(request, "opsApprovePhotos");
    const { uid, jobId, selectedUrls } = request.data || {};
    if (!uid || !jobId) {
      throw new HttpsError("invalid-argument", "uid ve jobId zorunlu.");
    }
    assertSafeId(uid, "uid");
    assertSafeId(jobId, "jobId");

    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
    const snap = await jobRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "İş bulunamadı.");
    const job = snap.data();

    // Üst sınır kullanıcının SATIN ALDIĞI sayıdır (fazla üretilen değil).
    const maxCount = job.photoCount || 0;
    if (maxCount <= 0) {
      throw new HttpsError("failed-precondition", "İşin foto sayısı okunamadı.");
    }

    const paths = validateApprovalSelection({
      selected: selectedUrls,
      staged: stagedPhotoUrls(job),
      uid, jobId, maxCount,
    });

    // Kopyalama — onaylananlar kullanıcının okuyabildiği yola taşınır.
    // Tek tek hata yakalanıyor: bir dosya kopyalanamazsa TÜM onay çökmesin,
    // kopyalanabilenler teslim edilsin ve eksik olan logda görünsün.
    const approvedUrls = [];
    for (const path of paths) {
      const dest = resultPathForStaging(path);
      try {
        await bucket().file(path).copy(bucket().file(dest));
        approvedUrls.push(`gs://${bucket().name}/${dest}`);
      } catch (e) {
        console.error(`ONAY: kopyalama başarısız (${path}):`, e.message || e);
      }
    }
    if (approvedUrls.length === 0) {
      throw new HttpsError("internal", "Hiçbir fotoğraf kopyalanamadı.");
    }

    // ELLE YÜKLENENLER KORUNUR: onay birden çok kez çalıştırılabilir
    // (seçim değiştirilebilir), ama panelden yüklenmiş dış fotoğrafların
    // silinmemesi gerekir — onlar staging'den gelmiyor.
    const manualUrls = (job.approvedPhotoUrls || []).filter(
      (u) => (gsPathFromUrl(u) || "").includes("/manual_")
    );

    await jobRef.set({
      approvedPhotoUrls: [...approvedUrls, ...manualUrls],
      status: "done",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: request.auth.token.email || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    const { sendPushToUser } = require("./notifications");
    const pushed = await sendPushToUser(uid, {
      title: "📸 Fotoğrafların hazır!",
      body: "AI dating fotoğrafların hesabına eklendi — Fotoğraflarım'dan bakabilirsin.",
      data: { type: "photos_ready", jobId },
    });

    console.log(
      `ONAY: ${approvedUrls.length} foto teslim edildi (uid=${uid}, job=${jobId}, ` +
      `push=${pushed ? "gitti" : "gitmedi"})`
    );
    return { approved: approvedUrls.length, manualKept: manualUrls.length, pushed };
  }
);

/**
 * Panelden ELLE yüklenen fotoğrafı kullanıcının teslim listesine ekler.
 *
 * Yükleme, ops istemcisi tarafından doğrudan Storage'a yapılır (storage.rules
 * yalnızca ops email'ine bu yol altında yazma izni verir); burada yalnızca
 * yolun beklenen yerde olduğu doğrulanıp iş dokümanına işleniyor. Böylece
 * büyük dosya callable payload'ından geçmek zorunda kalmıyor.
 */
exports.opsAttachUploadedPhoto = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    await assertOps(request, "opsAttachUploadedPhoto");
    const { uid, jobId, path } = request.data || {};
    if (!uid || !jobId || !path) {
      throw new HttpsError("invalid-argument", "uid, jobId ve path zorunlu.");
    }
    assertSafeId(uid, "uid");
    assertSafeId(jobId, "jobId");

    // Yol İSTEMCİDEN geliyor — tam olarak bu kullanıcının bu işine ait,
    // "manual_" ile başlayan bir dosya olmak zorunda.
    const expected = `${RESULTS_PREFIX}${uid}/${jobId}/manual_`;
    if (typeof path !== "string" || !path.startsWith(expected) || path.includes("..")) {
      throw new HttpsError("invalid-argument", "Geçersiz yol.");
    }
    const file = bucket().file(path);
    const [exists] = await file.exists();
    if (!exists) {
      throw new HttpsError("not-found", "Yüklenen dosya bulunamadı.");
    }

    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
    const snap = await jobRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "İş bulunamadı.");

    await jobRef.set({
      approvedPhotoUrls: admin.firestore.FieldValue.arrayUnion(
        `gs://${bucket().name}/${path}`
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`ELLE YÜKLEME: foto eklendi (uid=${uid}, job=${jobId}, path=${path})`);
    return { ok: true };
  }
);

// Test-only exports — barrel dosyası (index.js) bu ismi SEÇMEDİĞİ için
// gerçek bir Cloud Function olarak deploy edilmez, sadece
// functions/test/opsPanel.test.js bunları require eder.
exports._testables = {
  isAuthorizedOpsEmail,
  uidFromDocPath,
  gsPathFromUrl,
  validateApprovalSelection,
  resultPathForStaging,
  stagedPhotoUrls,
  extractGateCounts,
  aggregateGateCounts,
  buildPurchaseSummary,
  buildJobSummary,
  safeString,
  buildDailyBreakdown,
  priceForProduct,
  PRODUCT_PRICES_TRY,
};
