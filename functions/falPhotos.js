const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
// Zero-shot referans-görsel düzenleme modeli — kullanıcı başına eğitim YOK.
// 5 selfie doğrudan referans olarak verilir, ~10-20 sn içinde sonuç döner.
// (Eskiden: flux-lora-fast-training + flux-lora, ~15-30 dk + ~$2/kullanıcı.)
const EDIT_MODEL = "fal-ai/bytedance/seedream/v5/lite/edit";

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
 * Kullanıcının Storage'a yüklediği referans selfie'lerini okuyup fal.ai'nin
 * kendi storage'ına yükler (fal.ai edit modelleri yalnızca herkese açık/fal
 * tarafından erişilebilir URL kabul eder — Firebase Storage dosyalarımız
 * özel olduğu için doğrudan gs:// veremeyiz). Dönen URL'ler edit isteğinde
 * `image_urls` olarak referans verilir; eğitim YAPILMAZ.
 */
async function uploadReferencePhotos(uid, jobId) {
  const prefix = `dating_training/${uid}/${jobId}/`;
  const [files] = await bucket().getFiles({ prefix });
  if (files.length === 0) {
    throw new HttpsError("failed-precondition", "Referans fotoğrafları bulunamadı.");
  }
  // Paralel indir+yükle — 5 selfie sırayla yüklenince toplam bekleme süresi
  // gereksiz yere katlanıyordu.
  return Promise.all(files.map(async (file) => {
    const [buf] = await file.download();
    const uploadResp = await fetch("https://fal.run/storage/upload", {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY.value()}`,
        "content-type": "image/jpeg",
      },
      body: buf,
    });
    if (!uploadResp.ok) {
      throw new HttpsError("internal", `fal.ai storage yükleme hatası: ${uploadResp.status}`);
    }
    const { url } = await uploadResp.json();
    return url;
  }));
}

/**
 * fal.ai queue API'sine bir görsel düzenleme (edit) işi gönderir.
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
 * Kullanıcı 5 referans selfie'sini Storage'a yükledikten SONRA bu fonksiyonu
 * çağırır. Sunucu tarafında bakiye kontrolü + düşme yapılır (client asla
 * bunu atlayamaz), sonra her seçilen stil için doğrudan fal.ai referans-
 * görsel düzenleme isteği (EDIT_MODEL) gönderilir — eğitim aşaması YOK.
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
        pendingStyles: styles.length,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsNeeded,
      });
    });

    try {
      const refUrls = await uploadReferencePhotos(uid, jobId);
      await jobRef.set({
        status: "generating",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      for (const styleId of styles) {
        const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}`;
        const falJob = await submitFalJob(
          EDIT_MODEL,
          {
            prompt: STYLE_PROMPTS[styleId],
            image_urls: refUrls,
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
      console.error("startPhotoGeneration hata:", e);
      await refundAndFail(uid, jobId, unitsNeeded, "Üretim başlatılamadı.");
      throw e instanceof HttpsError ? e : new HttpsError("internal", "Üretim başlatılamadı.");
    }

    return { jobId };
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
    let photoUrls = [];
    try {
      // Paralel indir+yükle — seri döngü, fal saniyeler içinde üretse bile
      // 10 görsel için gereksiz onlarca saniye eklenmesine neden oluyordu.
      photoUrls = await Promise.all(images.map(async (img, i) => {
        const imgResp = await fetch(img.url);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const path = `dating_results/${uid}/${jobId}/${styleId}_${i}.jpg`;
        await bucket().file(path).save(buf, { metadata: { contentType: "image/jpeg" } });
        // Herkese açık YAPILMAZ — storage.rules zaten yalnızca sahibine
        // izin veriyor. Client, Firebase Auth token'ıyla `gs://` yolunu
        // FirebaseStorage SDK üzerinden çözüp indirir (bkz. module_flows.dart).
        return `gs://${bucket().name}/${path}`;
      }));
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
 * vb.) — bu zamanlanmış fonksiyon, uzun süredir 'generating' durumunda
 * takılı kalan işleri bulup başarısız sayar ve iade eder. Zero-shot edit
 * modeli saniyeler içinde sonuçlanır (eski LoRA eğitimindeki gibi dakikalar
 * sürmez), bu yüzden eşik kısa tutuldu. Gerçek bir "durumu fal.ai'den
 * tekrar sorgula" adımı, fal.ai'nin status_url'i job dokümanına
 * eklendikten sonra genişletilebilir.
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
