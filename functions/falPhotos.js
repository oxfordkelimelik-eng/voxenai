const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
const TRAINING_MODEL = "fal-ai/flux-lora-fast-training";
const INFERENCE_MODEL = "fal-ai/flux-lora";

// Bu fonksiyonların gerçek public URL'i deploy sonrası
// `firebase functions:list` ile öğrenilip fal.ai'ye webhook_url olarak
// verilir. Region + proje id'sinden tahmini URL:
const FUNCTIONS_BASE = "https://europe-west1-rise-up-9235f.cloudfunctions.net";

// PhotoStyle.id -> fal.ai prompt açıklaması. lib/core/constants/dating_constants.dart
// PhotoStyle.coreStyles ile EL İLE senkron tutulmalı.
const STYLE_PROMPTS = {
  elegance: "an elegant, charismatic, well-groomed portrait, sharp studio lighting, upscale attire",
  athletic: "an athletic, dynamic, fit portrait, gym or outdoor sport setting, confident pose",
  traveller: "a world traveller portrait, scenic landmark background, adventurous casual outfit",
  oldmoney: "a classic old-money aesthetic portrait, tailored blazer, refined interior background",
  nightout: "a night-out social portrait, stylish club/bar lighting, trendy outfit",
  beach: "a beach body portrait, sunny coastline background, fit and relaxed",
  car: "a prestige portrait next to a luxury car, confident stance, urban background",
};

function styleUnitsFor(styleCount) {
  // Bakiye "stil/set" cinsinden tutulur — bkz. DatingConfig.photosPerSet.
  return styleCount;
}

/**
 * 5 eğitim fotoğrafını Storage'dan okuyup fal.ai'nin kabul ettiği bir ZIP
 * haline getirir, fal.ai storage'a yükler ve indirilebilir URL döner.
 */
async function buildTrainingZipUrl(uid, jobId) {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  const prefix = `dating_training/${uid}/${jobId}/`;
  const [files] = await bucket().getFiles({ prefix });
  if (files.length === 0) {
    throw new HttpsError("failed-precondition", "Eğitim fotoğrafları bulunamadı.");
  }
  for (const file of files) {
    const [buf] = await file.download();
    zip.addFile(file.name.split("/").pop(), buf);
  }
  const zipBuffer = zip.toBuffer();

  const uploadResp = await fetch("https://fal.run/storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY.value()}`,
      "content-type": "application/zip",
    },
    body: zipBuffer,
  });
  if (!uploadResp.ok) {
    throw new HttpsError("internal", `fal.ai storage yükleme hatası: ${uploadResp.status}`);
  }
  const { url } = await uploadResp.json();
  return url;
}

/**
 * fal.ai queue API'sine bir iş gönderir (training veya inference).
 */
async function submitFalJob(model, input, webhookUrl) {
  const resp = await fetch(`${FAL_QUEUE_BASE}/${model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY.value()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new HttpsError("internal", `fal.ai iş gönderimi başarısız: ${resp.status} ${txt.slice(0, 120)}`);
  }
  return await resp.json(); // { request_id, status_url, response_url, ... }
}

/**
 * Adım 1: kullanıcı 5 eğitim fotoğrafını Storage'a yükledikten SONRA bu
 * fonksiyonu çağırır. Sunucu tarafında bakiye kontrolü + düşme yapılır
 * (client asla bunu atlayamaz), sonra fal.ai LoRA eğitimi başlatılır.
 *
 * data: { styles: string[], jobId: string }
 * dönüş: { jobId: string }
 */
exports.startPhotoGeneration = onCall(
  { secrets: [FAL_KEY], region: "europe-west1", memory: "512MiB", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { styles, jobId } = request.data || {};
    if (!Array.isArray(styles) || styles.length === 0 || !jobId) {
      throw new HttpsError("invalid-argument", "styles ve jobId zorunlu.");
    }
    const invalidStyle = styles.find((s) => !STYLE_PROMPTS[s]);
    if (invalidStyle) {
      throw new HttpsError("invalid-argument", `Bilinmeyen stil: ${invalidStyle}`);
    }

    const unitsNeeded = styleUnitsFor(styles.length);
    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);

    // Bakiye kontrolü + düşme + iş dokümanı oluşturma — tek transaction.
    await db.runTransaction(async (tx) => {
      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
      if ((wallet.photoBalance || 0) < unitsNeeded) {
        throw new HttpsError("failed-precondition", "Yetersiz paket bakiyesi.");
      }
      tx.set(walletRef, {
        photoBalance: wallet.photoBalance - unitsNeeded,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(jobRef, {
        status: "uploading",
        styles,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        falTrainingRequestId: null,
        falLoraUrl: null,
        pendingStyles: styles.length,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsNeeded,
      });
    });

    try {
      const zipUrl = await buildTrainingZipUrl(uid, jobId);
      const webhookUrl = `${FUNCTIONS_BASE}/falTrainingWebhook?uid=${uid}&jobId=${jobId}`;
      const falJob = await submitFalJob(
        TRAINING_MODEL,
        { images_data_url: zipUrl, steps: 1000 },
        webhookUrl
      );
      await jobRef.set({
        status: "training",
        falTrainingRequestId: falJob.request_id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error("startPhotoGeneration hata:", e);
      await refundAndFail(uid, jobId, unitsNeeded, "Eğitim başlatılamadı.");
      throw e instanceof HttpsError ? e : new HttpsError("internal", "Üretim başlatılamadı.");
    }

    return { jobId };
  }
);

/**
 * fal.ai eğitim işi tamamlanınca (webhook) çağrılır. Beklenen istek
 * gövdesi fal.ai queue webhook formatı: { status, payload, request_id }.
 */
exports.falTrainingWebhook = onRequest(
  { secrets: [FAL_KEY], region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (req, res) => {
    const uid = req.query.uid;
    const jobId = req.query.jobId;
    if (!uid || !jobId) {
      res.status(400).send("uid/jobId eksik");
      return;
    }
    const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      res.status(404).send("job bulunamadı");
      return;
    }
    const job = jobSnap.data();

    // Anti-spoofing: fal.ai webhook'larında HMAC imzası yok — bu yüzden
    // yalnızca bizim daha önce kaydettiğimiz request_id ile eşleşen
    // çağrıları kabul ediyoruz.
    const requestId = req.body?.request_id;
    if (!requestId || requestId !== job.falTrainingRequestId) {
      res.status(403).send("request_id uyuşmuyor");
      return;
    }

    if (req.body?.status !== "OK" && req.body?.status !== "COMPLETED") {
      await refundAndFail(uid, jobId, job.packUnitsCharged, "Eğitim başarısız oldu.");
      res.status(200).send("ok");
      return;
    }

    const loraUrl = req.body?.payload?.diffusers_lora_file?.url;
    if (!loraUrl) {
      await refundAndFail(uid, jobId, job.packUnitsCharged, "Eğitim çıktısı geçersiz.");
      res.status(200).send("ok");
      return;
    }

    await jobRef.set({
      status: "generating",
      falLoraUrl: loraUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    try {
      for (const styleId of job.styles) {
        const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}`;
        const falJob = await submitFalJob(
          INFERENCE_MODEL,
          {
            prompt: STYLE_PROMPTS[styleId],
            loras: [{ path: loraUrl }],
            num_images: 10, // DatingConfig.photosPerSet
            image_size: "portrait_4_3",
          },
          webhookUrl
        );
        await jobRef.set({
          [`results.${styleId}`]: { requestId: falJob.request_id, photoUrls: [], status: "pending" },
        }, { merge: true });
      }
    } catch (e) {
      console.error("Inference gönderim hatası:", e);
      await refundAndFail(uid, jobId, job.packUnitsCharged, "Üretim başlatılamadı.");
    }

    res.status(200).send("ok");
  }
);

/**
 * fal.ai bir stilin inference işi tamamlanınca (webhook) çağrılır. Çıktıyı
 * indirip Firebase Storage'a kalıcı olarak kopyalar (fal.ai CDN URL ömrüne
 * bağımlı kalmamak için) ve iş dokümanını günceller.
 */
exports.falInferenceWebhook = onRequest(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 },
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
    const expected = job.results?.[styleId]?.requestId;
    const requestId = req.body?.request_id;
    if (!requestId || requestId !== expected) {
      res.status(403).send("request_id uyuşmuyor");
      return;
    }

    if (req.body?.status !== "OK" && req.body?.status !== "COMPLETED") {
      await markStyleFailed(uid, jobId, styleId, job);
      res.status(200).send("ok");
      return;
    }

    const images = req.body?.payload?.images || [];
    const photoUrls = [];
    try {
      for (let i = 0; i < images.length; i++) {
        const imgResp = await fetch(images[i].url);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const path = `dating_results/${uid}/${jobId}/${styleId}_${i}.jpg`;
        const file = bucket().file(path);
        await file.save(buf, { metadata: { contentType: "image/jpeg" } });
        // Herkese açık YAPILMAZ — storage.rules zaten yalnızca sahibine
        // izin veriyor. Client, Firebase Auth token'ıyla `gs://` yolunu
        // FirebaseStorage SDK üzerinden çözüp indirir (bkz. module_flows.dart).
        photoUrls.push(`gs://${bucket().name}/${path}`);
      }
    } catch (e) {
      console.error("Sonuç görseli kopyalama hatası:", e);
      await markStyleFailed(uid, jobId, styleId, job);
      res.status(200).send("ok");
      return;
    }

    const pendingStyles = Math.max(0, (job.pendingStyles || 1) - 1);
    await jobRef.set({
      [`results.${styleId}`]: { requestId, photoUrls, status: "done" },
      pendingStyles,
      status: pendingStyles === 0 ? "done" : "generating",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // İş bittiyse eğitim selfie'lerini sil (KVKK — aydınlatma metni "işlem
    // sonrası kullanılmaz" diyor; biyometrik veriyi geride bırakma).
    if (pendingStyles === 0) {
      await deleteTrainingPhotos(uid, jobId);
    }

    res.status(200).send("ok");
  }
);

// Eğitim selfie'lerini Firebase Storage'dan siler. İş sonuçlandığında
// (başarı ya da kalıcı başarısızlık) çağrılır — biyometrik veriyi
// gereğinden uzun tutmamak için (KVKK/GDPR).
async function deleteTrainingPhotos(uid, jobId) {
  try {
    await bucket().deleteFiles({ prefix: `dating_training/${uid}/${jobId}/` });
  } catch (e) {
    console.error("Eğitim fotoğrafları silinemedi:", e);
  }
}

async function markStyleFailed(uid, jobId, styleId, job) {
  const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
  const pendingStyles = Math.max(0, (job.pendingStyles || 1) - 1);
  await jobRef.set({
    [`results.${styleId}`]: { requestId: job.results?.[styleId]?.requestId, photoUrls: [], status: "failed" },
    pendingStyles,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  if (pendingStyles === 0) {
    await refundAndFail(uid, jobId, job.packUnitsCharged, "Bazı stiller üretilemedi.");
  }
}

/**
 * Başarısız/zaman aşımına uğrayan bir işi 'failed' işaretler ve düşülen
 * paket bakiyesini iade eder — kullanıcı başarısız üretim için ödeme
 * kaybetmesin diye.
 */
async function refundAndFail(uid, jobId, unitsToRefund, errorMessage) {
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  const jobRef = db.doc(`users/${uid}/private/genJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data().status === "failed" || jobSnap.data().status === "done") {
      return; // zaten sonuçlanmış — tekrar iade etme
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
  // İş kalıcı olarak başarısız oldu — eğitim selfie'lerini de temizle.
  await deleteTrainingPhotos(uid, jobId);
}

/**
 * fal.ai webhook teslimatı güvenilmez olabilir (ağ sorunu, soğuk başlangıç
 * vb.) — bu zamanlanmış fonksiyon, uzun süredir 'training'/'generating'
 * durumunda takılı kalan işleri bulup başarısız sayar ve iade eder. Gerçek
 * bir "durumu fal.ai'den tekrar sorgula" adımı, fal.ai'nin status_url'i
 * job dokümanına eklendikten sonra genişletilebilir.
 */
exports.cleanupStuckGenJobs = onSchedule(
  { schedule: "every 10 minutes", region: "europe-west1", timeoutSeconds: 120 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
    const stuck = await db
      .collectionGroup("genJobs")
      .where("status", "in", ["uploading", "training", "generating"])
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
