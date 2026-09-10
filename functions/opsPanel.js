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
  db, bucket, assertSafeId, signedDownloadUrl,
  enforceRateLimit, checkAppAttestation,
} = require("./_shared");

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

/** rejectedFrames dizisinden gate -> sayaç. */
function extractGateCounts(rejectedFrames) {
  const counts = {};
  for (const f of rejectedFrames || []) {
    const gate = (f && f.gate) || "?";
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

/** processedPurchases doküman listesinden özet. */
function buildPurchaseSummary(purchases) {
  return {
    totalPurchases: purchases.length,
    uniqueBuyers: new Set(purchases.map((p) => p.uid)).size,
    productCounts: purchases.reduce((acc, p) => {
      acc[p.productId] = (acc[p.productId] || 0) + 1;
      return acc;
    }, {}),
  };
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

    const purchases = purchaseSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        uid: uidFromDocPath(doc.ref),
        orderId: doc.id,
        productId: d.productId || null,
        platform: d.platform || null,
        creditedField: d.creditedField || null,
        creditedAmount: d.creditedAmount || 0,
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
        errorMessage: d.errorMessage || null,
        deliveredCount,
        rejectedCount: rejectedFrames.length,
        gateCounts: extractGateCounts(rejectedFrames),
        createdAt: d.createdAt ? d.createdAt.toMillis() : null,
        updatedAt: d.updatedAt ? d.updatedAt.toMillis() : null,
      };
    });

    const summary = {
      ...buildPurchaseSummary(purchases),
      ...buildJobSummary(jobs),
    };

    return { summary, purchases, jobs };
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
        gate: f.gate || null,
        chunkIdx: f.chunkIdx ?? null,
        attempt: f.attempt ?? null,
        reason: f.reason || null,
        detail: f.detail || null,
        rejectedAt: f.rejectedAt || null,
        url: await resolveGsUrl(f.gsUrl),
      }))
    );

    return {
      uid, jobId,
      status: job.status || null,
      styles: job.styles || null,
      photoMode: job.photoMode || null,
      model: job.model || null,
      usedFreeTier: !!job.usedFreeTier,
      packUnitsCharged: job.packUnitsCharged || 0,
      errorMessage: job.errorMessage || null,
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
};
