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
const { db, bucket, assertSafeId, signedDownloadUrl } = require("./_shared");

const OPS_EMAIL = "kutayalptekin3@gmail.com";
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

function assertOps(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş gerekli.");
  }
  const email = request.auth.token.email;
  if (!email || email !== OPS_EMAIL || request.auth.token.email_verified === false) {
    // Generic mesaj — "ops"/"admin" kelimesi geçmez, panelin varlığını ifşa etmez.
    throw new HttpsError("permission-denied", "Yetkisiz.");
  }
}

/** doc path: users/{uid}/private/.../{collectionId}/{docId} -> uid çıkar. */
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

exports.opsGetOverview = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    assertOps(request);
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
      const gateCounts = {};
      for (const f of rejectedFrames) {
        const gate = f.gate || "?";
        gateCounts[gate] = (gateCounts[gate] || 0) + 1;
      }
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
        gateCounts,
        createdAt: d.createdAt ? d.createdAt.toMillis() : null,
        updatedAt: d.updatedAt ? d.updatedAt.toMillis() : null,
      };
    });

    const summary = {
      totalPurchases: purchases.length,
      uniqueBuyers: new Set(purchases.map((p) => p.uid)).size,
      productCounts: purchases.reduce((acc, p) => {
        acc[p.productId] = (acc[p.productId] || 0) + 1;
        return acc;
      }, {}),
      totalJobs: jobs.length,
      uniqueProducers: new Set(jobs.map((j) => j.uid)).size,
      statusCounts: jobs.reduce((acc, j) => {
        acc[j.status] = (acc[j.status] || 0) + 1;
        return acc;
      }, {}),
      totalDelivered: jobs.reduce((n, j) => n + j.deliveredCount, 0),
      totalRejected: jobs.reduce((n, j) => n + j.rejectedCount, 0),
    };

    return { summary, purchases, jobs };
  }
);

exports.opsGetJobDetail = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30 },
  async (request) => {
    assertOps(request);
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
      if (!gsUrl || typeof gsUrl !== "string") return null;
      const m = /^gs:\/\/[^/]+\/(.+)$/.exec(gsUrl);
      if (!m) return gsUrl; // zaten https ise olduğu gibi dön
      try {
        return await signedDownloadUrl(bucket().file(m[1]));
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
