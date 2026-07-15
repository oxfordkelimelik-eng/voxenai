const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
// Zero-shot referans-görsel düzenleme modeli — kullanıcı başına eğitim YOK.
// 5 selfie doğrudan referans olarak verilir, saniyeler içinde sonuç döner.
// Nano Banana 2, kimlik/yüz sadakati konusunda güçlü (kalite öncelikli).
const EDIT_MODEL = "fal-ai/nano-banana-2/edit";
// 1 = en katı, 6 = en gevşek (varsayılan 4). Kullanıcı selfie'si işleyen
// bir uygulamada varsayılandan daha katı moderasyon tercih edildi.
const SAFETY_TOLERANCE = "2";

const NUM_IMAGES = 10; // stil başına üretilen foto (DatingConfig.photosPerSet)
// Kalite kapısından bu sayının altında foto geçerse stil bir kez otomatik
// yeniden üretilir (kimlik sapması olan üretimleri kurtarmak için).
const MIN_PASS_FOR_STYLE = 4;
const MAX_STYLE_RETRIES = 1;

// Bu fonksiyonların gerçek public URL'i (fal.ai webhook hedefi).
const FUNCTIONS_BASE = "https://europe-west1-rise-up-9235f.cloudfunctions.net";

// PhotoStyle.id -> sahne/stil betimlemesi. lib/core/constants/dating_constants.dart
// PhotoStyle.coreStyles ile EL İLE senkron tutulmalı.
const STYLE_SCENES = {
  elegance: "an elegant, charismatic, well-groomed portrait, sharp studio lighting, upscale attire",
  athletic: "an athletic, dynamic, fit portrait, gym or outdoor sport setting, confident pose",
  traveller: "a world traveller portrait, scenic landmark background, adventurous casual outfit",
  oldmoney: "a classic old-money aesthetic portrait, tailored blazer, refined interior background",
  nightout: "a night-out social portrait, stylish club/bar lighting, trendy outfit",
  beach: "a beach body portrait, sunny coastline background, fit and relaxed",
  car: "a prestige portrait next to a luxury car, confident stance, urban background",
};

// Kimlik-koruma yönergesiyle sarılmış tam prompt. Referans görsellerdeki
// KİŞİNİN yüz kimliğini/hatlarını koruması açıkça istenir — zero-shot edit
// modellerinde yüz benzerliğini ölçülebilir şekilde artırır.
function buildPrompt(styleId) {
  const scene = STYLE_SCENES[styleId];
  return (
    "Generate a photorealistic photo of the SAME person shown in the reference " +
    "images. Preserve their exact facial identity, bone structure, and unique " +
    "features so they remain clearly recognizable. Do not change their face, " +
    "age, or ethnicity. Scene and style: " + scene + "."
  );
}

function styleUnitsFor(styleCount) {
  return styleCount; // bakiye "stil/set" cinsinden — bkz. DatingConfig.
}

/**
 * Referans selfie'lerini Storage'dan okur, fal.ai storage'ına yükler (edit
 * modelleri yalnızca fal'ın erişebileceği URL kabul eder) VE aynı buffer'ları
 * kalite kapısı için geri döner (ikinci indirmeye gerek kalmasın).
 * Döner: { urls: string[], buffers: Buffer[] }
 */
async function uploadToFalStorage(buf, fileName) {
  // 1) İmzasız yükleme URL'i al
  const initResp = await fetch(
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=gcs",
    {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY.value()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_type: "image/jpeg",
        file_name: fileName,
      }),
    }
  );
  if (!initResp.ok) {
    const txt = await initResp.text();
    throw new HttpsError(
      "internal",
      `fal.ai upload initiate hatası: ${initResp.status} ${txt.slice(0, 120)}`
    );
  }
  const initJson = await initResp.json();
  const uploadUrl = initJson.upload_url || initJson.uploadUrl;
  const fileUrl = initJson.file_url || initJson.fileUrl || initJson.url;
  if (!uploadUrl || !fileUrl) {
    throw new HttpsError("internal", "fal.ai upload URL alınamadı.");
  }

  // 2) Dosyayı imzalı URL'e yükle
  const putResp = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: buf,
  });
  if (!putResp.ok) {
    const txt = await putResp.text();
    throw new HttpsError(
      "internal",
      `fal.ai dosya yükleme hatası: ${putResp.status} ${txt.slice(0, 80)}`
    );
  }
  return fileUrl;
}

/**
 * Referans selfie'lerini Storage'dan okur, fal.ai storage'ına yükler (edit
 * modelleri yalnızca fal'ın erişebileceği URL kabul eder) VE aynı buffer'ları
 * kalite kapısı için geri döner (ikinci indirmeye gerek kalmasın).
 * Döner: { urls: string[], buffers: Buffer[] }
 */
async function uploadReferencePhotos(uid, jobId) {
  const prefix = `dating_training/${uid}/${jobId}/`;
  const [files] = await bucket().getFiles({ prefix });
  // GCS klasör placeholder'larını ele (adı / ile biten boş "dosyalar").
  const photoFiles = files.filter((f) => !f.name.endsWith("/") && f.name.includes("photo_"));
  if (photoFiles.length === 0) {
    throw new HttpsError("failed-precondition", "Referans fotoğrafları bulunamadı.");
  }
  const results = await Promise.all(photoFiles.map(async (file, idx) => {
    const [buf] = await file.download();
    const url = await uploadToFalStorage(buf, `ref_${idx}.jpg`);
    return { url, buf };
  }));
  return { urls: results.map((r) => r.url), buffers: results.map((r) => r.buf) };
}

/**
 * fal.ai queue API'sine bir görsel düzenleme (edit) işi gönderir.
 */
async function submitStyleJob(uid, jobId, styleId, imageUrls) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}`;
  const input = {
    prompt: buildPrompt(styleId),
    image_urls: imageUrls,
    num_images: NUM_IMAGES,
    aspect_ratio: "3:4", // portrait
    resolution: "2K", // dating fotoğrafı — kalite öncelikli
    output_format: "jpeg",
    safety_tolerance: SAFETY_TOLERANCE,
  };
  const resp = await fetch(
    `${FAL_QUEUE_BASE}/${EDIT_MODEL}?fal_webhook=${encodeURIComponent(webhookUrl)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY.value()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
  if (!resp.ok) {
    const txt = await resp.text();
    throw new HttpsError("internal", `fal.ai iş gönderimi başarısız: ${resp.status} ${txt.slice(0, 120)}`);
  }
  return await resp.json(); // { request_id, ... }
}

/**
 * Kullanıcı 5 referans selfie'sini Storage'a yükledikten SONRA çağrılır.
 * Bakiye kontrolü + düşme (client atlayamaz), referansları fal'a yükleme,
 * kalite kapısı için kaynak kimlik vektörünü BİR KEZ hesaplama, ve her
 * stil için edit işi gönderme. Referans selfie'ler bu noktadan sonra
 * gerekmediği için hemen silinir (KVKK — biyometrik veriyi geride bırakma).
 *
 * data: { styles: string[], jobId: string } -> { jobId }
 */
exports.startPhotoGeneration = onCall(
  // Referans descriptor'ı burada hesaplandığı için face-api modelleri yükleniyor
  // — 1GiB gerekiyor. (Kalite kapısı katmanı fail-safe; hata olursa filtresiz
  // devam edilir, üretim akışı bloklanmaz.)
  { secrets: [FAL_KEY], region: "europe-west1", memory: "1GiB", timeoutSeconds: 180 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { styles, jobId } = request.data || {};
    if (!Array.isArray(styles) || styles.length === 0 || !jobId) {
      throw new HttpsError("invalid-argument", "styles ve jobId zorunlu.");
    }
    const invalidStyle = styles.find((s) => !STYLE_SCENES[s]);
    if (invalidStyle) {
      throw new HttpsError("invalid-argument", `Bilinmeyen stil: ${invalidStyle}`);
    }

    const unitsNeeded = styleUnitsFor(styles.length);
    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);

    // Bakiye kontrolü + düşme + iş dokümanı oluşturma — tek transaction.
    // Ücretsiz deneme: daha önce kullanılmadıysa 1 stil ücretsiz (bakiye 0 olsa bile).
    let unitsToCharge = unitsNeeded;
    let usedFreeTier = false;

    await db.runTransaction(async (tx) => {
      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.data() || {
        photoBalance: 0,
        analysisBalance: 0,
        freePhotoUsed: false,
      };

      if ((wallet.photoBalance || 0) < unitsNeeded) {
        if (!wallet.freePhotoUsed && styles.length === 1) {
          unitsToCharge = 0;
          usedFreeTier = true;
        } else if (!wallet.freePhotoUsed && styles.length > 1) {
          throw new HttpsError(
            "failed-precondition",
            "Ücretsiz deneme için yalnızca 1 stil seçebilirsin. Daha fazlası için paket al."
          );
        } else {
          throw new HttpsError("failed-precondition", "Yetersiz paket bakiyesi.");
        }
      }

      const walletUpdate = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (unitsToCharge > 0) {
        walletUpdate.photoBalance = wallet.photoBalance - unitsToCharge;
      }
      if (usedFreeTier) {
        walletUpdate.freePhotoUsed = true;
      }
      tx.set(walletRef, walletUpdate, { merge: true });

      tx.set(jobRef, {
        status: "uploading",
        styles,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingStyles: styles.length,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsToCharge,
        usedFreeTier,
      });
    });

    try {
      const { urls: refUrls, buffers: refBuffers } = await uploadReferencePhotos(uid, jobId);

      // Kalite kapısı için kaynak kimlik vektörünü BİR KEZ hesapla (fail-safe).
      let refDescriptor = null;
      try {
        const { averageDescriptor } = require("./faceQuality");
        const desc = await averageDescriptor(refBuffers);
        if (desc) refDescriptor = Array.from(desc); // Firestore için düz dizi
      } catch (e) {
        console.error("Referans descriptor hesaplanamadı (kalite kapısı devre dışı):", e);
      }

      await jobRef.set({
        status: "generating",
        falRefUrls: refUrls,
        refDescriptor, // null olabilir — o durumda kalite kapısı atlanır
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // Referans selfie'leri artık gerekmiyor (fal kopyası + descriptor var).
      await deleteTrainingPhotos(uid, jobId);

      for (const styleId of styles) {
        const falJob = await submitStyleJob(uid, jobId, styleId, refUrls);
        // Nokta içeren anahtar yerine iç içe nesne — set(merge) bunu derin
        // birleştirir; "results.styleId" düz alan adı olarak yorumlanmaz.
        await jobRef.set({
          results: { [styleId]: { requestId: falJob.request_id, photoUrls: [], status: "pending", retries: 0 } },
        }, { merge: true });
      }
    } catch (e) {
      console.error("startPhotoGeneration hata:", e);
      await refundAndFail(uid, jobId, unitsToCharge, "Üretim başlatılamadı.");
      if (e instanceof HttpsError) throw e;
      const msg = (e && e.message) ? String(e.message).slice(0, 160) : "Üretim başlatılamadı.";
      throw new HttpsError("internal", msg);
    }

    return { jobId };
  }
);

/**
 * fal.ai bir stilin işi tamamlanınca (webhook) çağrılır. Çıktıyı indirir,
 * kalite kapısından geçirir, geçenleri Storage'a yazar ve iş dokümanını
 * (atomik + idempotent) günceller. Kimlik benzerliği düşükse stili bir kez
 * otomatik yeniden üretir.
 */
exports.falInferenceWebhook = onRequest(
  {
    secrets: [FAL_KEY], // otomatik yeniden üretim fal'a yeni iş gönderiyor
    region: "europe-west1",
    memory: "1GiB", // tfjs-wasm + face-api modelleri
    timeoutSeconds: 180,
    minInstances: 1, // soğuk başlangıçta model yeniden yüklemesini önle
  },
  async (req, res) => {
    const uid = req.query.uid;
    const jobId = req.query.jobId;
    const styleId = req.query.style;
    if (!uid || !jobId || !styleId) {
      res.status(400).send("uid/jobId/style eksik");
      return;
    }
    const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      res.status(404).send("job bulunamadı");
      return;
    }
    const job = jobSnap.data();
    const styleResult = job.results?.[styleId];

    // request_id doğrulaması (anti-spoofing).
    const requestId = req.body?.request_id;
    if (!requestId || requestId !== styleResult?.requestId) {
      res.status(403).send("request_id uyuşmuyor");
      return;
    }

    // Idempotency: fal webhook'u aynı çağrıyı birden çok kez gönderebilir.
    // Bu stil zaten sonuçlandıysa hiçbir şey yapma.
    if (styleResult.status === "done" || styleResult.status === "failed") {
      res.status(200).send("zaten işlendi");
      return;
    }

    if (req.body?.status !== "OK" && req.body?.status !== "COMPLETED") {
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // Çıktıları paralel indir.
    const images = req.body?.payload?.images || [];
    let downloaded = [];
    try {
      downloaded = await Promise.all(images.map(async (img, i) => {
        const imgResp = await fetch(img.url);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        return { i, buf };
      }));
    } catch (e) {
      console.error("Sonuç görseli indirme hatası:", e);
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // Kalite kapısı: önbellekteki kaynak kimlik vektörüyle karşılaştır
    // (referansları YENİDEN indirip embed ETMEZ — bir kez startPhotoGeneration'da
    // hesaplandı). Herhangi bir hata olursa filtresiz devam (fail-safe).
    let passed = downloaded;
    try {
      if (job.refDescriptor) {
        const { filterByFaceMatch } = require("./faceQuality");
        passed = await filterByFaceMatch(downloaded, job.refDescriptor, (d) => d.buf);
      }
    } catch (e) {
      console.error("Kalite kapısı hatası (filtresiz devam ediliyor):", e);
      passed = downloaded;
    }

    // Otomatik yeniden üretim: çok az foto kimlik eşiğini geçtiyse ve henüz
    // yeniden üretim hakkı varsa, bu stili yeni bir edit işiyle tekrar dene.
    const retries = styleResult.retries || 0;
    if (
      job.refDescriptor &&
      passed.length < MIN_PASS_FOR_STYLE &&
      retries < MAX_STYLE_RETRIES &&
      Array.isArray(job.falRefUrls) &&
      job.falRefUrls.length > 0
    ) {
      try {
        const falJob = await submitStyleJob(uid, jobId, styleId, job.falRefUrls);
        await jobRef.set({
          results: {
            [styleId]: {
              requestId: falJob.request_id,
              photoUrls: [],
              status: "pending",
              retries: retries + 1,
            },
          },
        }, { merge: true });
        res.status(200).send("yeniden üretiliyor");
        return;
      } catch (e) {
        // Yeniden üretim başlatılamadı — eldeki sonuçlarla devam et.
        console.error("Otomatik yeniden üretim başlatılamadı:", e);
      }
    }

    // Son karar: geçen varsa onları, hiç geçen yoksa (nadir) boş sonuç
    // göstermemek için tümünü kaydet.
    const toSave = passed.length > 0 ? passed : downloaded;
    let photoUrls = [];
    try {
      photoUrls = await Promise.all(toSave.map(async ({ i, buf }) => {
        const path = `dating_results/${uid}/${jobId}/${styleId}_${i}.jpg`;
        await bucket().file(path).save(buf, { metadata: { contentType: "image/jpeg" } });
        return `gs://${bucket().name}/${path}`;
      }));
    } catch (e) {
      console.error("Sonuç görseli kaydetme hatası:", e);
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }

    await finalizeStyle(uid, jobId, styleId, { photoUrls });
    res.status(200).send("ok");
  }
);

/**
 * Bir stilin sonucunu ATOMİK ve IDEMPOTENT şekilde işler:
 *  - Stil zaten 'done'/'failed' ise hiçbir şey yapmaz (çift-teslimat koruması).
 *  - pendingStyles'ı transaction içinde azaltır (yarış koşulu yok).
 *  - Son stil de bittiğinde: herhangi bir stil başarısızsa TÜM paketi iade
 *    edip işi 'failed' yapar; aksi halde 'done'.
 */
async function finalizeStyle(uid, jobId, styleId, { photoUrls = [], failed = false }) {
  const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return;
    const j = snap.data();
    const cur = j.results?.[styleId]?.status;
    if (cur === "done" || cur === "failed") return; // idempotent no-op

    const newPending = Math.max(0, (j.pendingStyles ?? (j.styles?.length || 1)) - 1);
    // İç içe nesne — set(merge) derin birleştirir; requestId/retries korunur.
    const update = {
      results: { [styleId]: { status: failed ? "failed" : "done", photoUrls } },
      pendingStyles: newPending,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (newPending === 0) {
      const results = j.results || {};
      const anyFailed = failed || Object.keys(results).some(
        (k) => k !== styleId && results[k]?.status === "failed"
      );
      if (anyFailed) {
        // Mevcut politika: herhangi bir stil başarısızsa tüm paketi iade et.
        const walletSnap = await tx.get(walletRef);
        const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
        tx.set(walletRef, {
          photoBalance: (wallet.photoBalance || 0) + (j.packUnitsCharged || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        update.status = "failed";
        update.errorMessage = "Bazı stiller üretilemedi.";
      } else {
        update.status = "done";
      }
    }
    tx.set(jobRef, update, { merge: true });
  });
}

// Referans selfie'lerini Firebase Storage'dan siler (KVKK). Zaten silinmişse
// no-op. startPhotoGeneration üretim başlar başlamaz çağırır.
async function deleteTrainingPhotos(uid, jobId) {
  try {
    await bucket().deleteFiles({ prefix: `dating_training/${uid}/${jobId}/` });
  } catch (e) {
    console.error("Eğitim fotoğrafları silinemedi:", e);
  }
}

/**
 * Bir işi tamamen 'failed' işaretler ve düşülen paket bakiyesini iade eder.
 * startPhotoGeneration'ın erken (stil gönderiminden önceki) hatalarında ve
 * takılı-iş temizliğinde kullanılır.
 */
async function refundAndFail(uid, jobId, unitsToRefund, errorMessage) {
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data().status === "failed" || jobSnap.data().status === "done") {
      return; // zaten sonuçlanmış
    }
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
    tx.set(walletRef, {
      photoBalance: (wallet.photoBalance || 0) + unitsToRefund,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(jobRef, {
      status: "failed",
      errorMessage,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  await deleteTrainingPhotos(uid, jobId);
}

/**
 * Webhook teslimatı güvenilmez olabilir — uzun süredir 'uploading'/'generating'
 * takılı kalan işleri başarısız sayıp iade eder.
 */
exports.cleanupStuckGenJobs = onSchedule(
  { schedule: "every 5 minutes", region: "europe-west1", timeoutSeconds: 120 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
    const stuck = await db
      .collectionGroup("genJobs")
      .where("status", "in", ["uploading", "generating"])
      .where("updatedAt", "<", cutoff)
      .get();

    for (const doc of stuck.docs) {
      const uid = doc.ref.parent.parent.parent.parent.id; // users/{uid}/private/genJobs/{jobId}
      const job = doc.data();
      console.warn(`Takılı iş temizleniyor: ${doc.ref.path}`);
      await refundAndFail(uid, doc.id, job.packUnitsCharged || 0, "Zaman aşımı — işlem tamamlanamadı.");
    }
  }
);
