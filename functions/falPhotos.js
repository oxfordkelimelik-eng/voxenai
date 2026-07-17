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
// 1 = en katı, 6 = en gevşek. Varsayılan 4 — "2" kullanıcı selfielerinde
// sıkça moderasyon reddi / boş sonuç üretiyordu ("Bazı stiller üretilemedi").
const SAFETY_TOLERANCE = "4";

const NUM_IMAGES = 10; // stil başına üretilen foto (DatingConfig.photosPerSet)
// Kalite kapısından bu sayının altında foto geçerse stil bir kez otomatik
// yeniden üretilir (kimlik sapması olan üretimleri kurtarmak için).
const MIN_PASS_FOR_STYLE = 2; // 4 çok katıydı — az geçen üretimleri gereksiz yere fail ediyordu
const MAX_STYLE_RETRIES = 2;

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

// fal.ai sağlayıcı tarafı kalıcı hataları (bakiye bitti / hesap kilitli).
// Bunlar geçici değildir; kullanıcıya net mesaj gösterilmeli ve paket iade
// edilmeli — "internal" olarak gizlenmemeli.
const FAL_SERVICE_DOWN_MSG =
  "AI foto servisi şu anda kullanılamıyor. Lütfen daha sonra tekrar dene " +
  "— paket hakkın iade edildi.";

function isFalServiceOutage(status, body) {
  if (status === 402 || status === 429) return true;
  const b = (body || "").toLowerCase();
  return status === 403 && (
    b.includes("exhausted balance") ||
    b.includes("user is locked") ||
    b.includes("top up")
  );
}

/**
 * Referans selfie'lerini Storage'dan okur, fal.ai storage'ına yükler (edit
 * modelleri yalnızca fal'ın erişebileceği URL kabul eder) VE aynı buffer'ları
 * kalite kapısı için geri döner (ikinci indirmeye gerek kalmasın).
 * Döner: { urls: string[], buffers: Buffer[] }
 */
async function uploadToFalStorage(buf, fileName) {
  // Güncel fal CDN v3 initiate + PUT. Eski alpha/gcs endpoint'i sık 404/500 veriyor.
  const endpoints = [
    "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=gcs",
  ];
  let lastErr = "";
  for (const endpoint of endpoints) {
    try {
      const initResp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Key ${FAL_KEY.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_type: "image/jpeg",
          file_name: fileName,
        }),
      });
      if (!initResp.ok) {
        lastErr = `${initResp.status} ${(await initResp.text()).slice(0, 100)}`;
        continue;
      }
      const initJson = await initResp.json();
      const uploadUrl = initJson.upload_url || initJson.uploadUrl;
      const fileUrl = initJson.file_url || initJson.fileUrl || initJson.url;
      if (!uploadUrl || !fileUrl) {
        lastErr = "upload_url/file_url yok";
        continue;
      }
      const putResp = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: buf,
      });
      if (!putResp.ok) {
        lastErr = `PUT ${putResp.status}`;
        continue;
      }
      return fileUrl;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new HttpsError("internal", `fal.ai upload başarısız: ${lastErr}`);
}

/**
 * Firebase Storage'dan fal.ai'ın çekebileceği herkese-açık okuma URL'i.
 *
 * NOT: getSignedUrl() 'iam.serviceAccounts.signBlob' izni ister; Cloud
 * Functions'ın varsayılan compute service account'ında bu izin genelde yok
 * (SigningError). Bunun yerine dosyaya bir download token verip Firebase'in
 * token'lı public URL'ini üretiyoruz — bu signBlob GEREKTİRMEZ ve fal.ai
 * tarafından erişilebilir. URL yalnızca token'ı bilene açıktır.
 */
async function signedDownloadUrl(file) {
  const token = require("crypto").randomUUID();
  await file.setMetadata({
    metadata: { firebaseStorageDownloadTokens: token },
  });
  const encodedPath = encodeURIComponent(file.name);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket().name}` +
    `/o/${encodedPath}?alt=media&token=${token}`;
}

/**
 * Referans selfie'lerini Storage'dan okur, fal.ai CDN'e (veya imzalı GCS
 * URL'sine) yükler. Döner: { urls: string[], buffers: Buffer[] }
 */
async function uploadReferencePhotos(uid, jobId) {
  const prefix = `dating_training/${uid}/${jobId}/`;
  const [files] = await bucket().getFiles({ prefix });
  const photoFiles = files
    .filter((f) => !f.name.endsWith("/") && f.name.includes("photo_"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (photoFiles.length === 0) {
    throw new HttpsError("failed-precondition", "Referans fotoğrafları bulunamadı.");
  }
  const results = await Promise.all(photoFiles.map(async (file, idx) => {
    const [buf] = await file.download();

    // +18/uygunsuz içerik kapısı — fal.ai'ye hiçbir görsel gönderilmeden önce.
    // Vision API'nin kendisi hata verirse fail-open (loglanır, engellenmez);
    // gerçek bir tespit ise her zaman engeller (bkz. contentModeration.js).
    try {
      const { isExplicit } = require("./contentModeration");
      if (await isExplicit(buf)) {
        throw new HttpsError(
          "invalid-argument",
          `${idx + 1}. fotoğraf uygunsuz/yetişkin içerik olarak tespit edildi. ` +
          "Lütfen bu fotoğrafı uygun bir profil fotoğrafıyla değiştirip tekrar dene.",
          { explicitPhotoIndex: idx }
        );
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("İçerik moderasyonu kontrolü başarısız (filtresiz devam ediliyor):", e);
    }

    let url;
    try {
      url = await uploadToFalStorage(buf, `ref_${idx}.jpg`);
    } catch (e) {
      // fal CDN düşerse imzalı Firebase URL ile devam et (fal dış URL kabul eder).
      console.warn("fal upload başarısız, signed URL kullanılıyor:", e.message || e);
      url = await signedDownloadUrl(file);
    }
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
    if (isFalServiceOutage(resp.status, txt)) {
      console.error(`fal.ai servis kesintisi (submit): ${resp.status} ${txt.slice(0, 160)}`);
      throw new HttpsError("unavailable", FAL_SERVICE_DOWN_MSG);
    }
    throw new HttpsError("internal", `fal.ai iş gönderimi başarısız: ${resp.status} ${txt.slice(0, 120)}`);
  }
  return await resp.json(); // { request_id, ... }
}

/**
 * Kullanıcı 5 referans selfie'sini Storage'a yükledikten SONRA çağrılır.
 * Önce referansları indirir + içerik moderasyonu yapar + fal'a yükler +
 * kimlik kalite kapısını (bulanık/net olmayan selfie) çalıştırır — bunların
 * HİÇBİRİ bakiye düşülmeden veya fal'a üretim işi gönderilmeden önce
 * gerçekleşmez. Böylece uygunsuz içerik ya da net olmayan fotoğraflar,
 * kullanıcı ücret ödemeden ve loading ekranına hiç girmeden reddedilir.
 * Ancak bu kapılar geçilince: bakiye kontrolü + düşme (client atlayamaz),
 * ve her stil için edit işi gönderme. Referans selfie'ler bu noktadan sonra
 * gerekmediği için hemen silinir (KVKK — biyometrik veriyi geride bırakma).
 *
 * data: { styles: string[], jobId: string } -> { jobId }
 */
exports.startPhotoGeneration = onCall(
  // Referans descriptor'ı burada hesaplandığı için face-api modelleri (tfjs-wasm
  // + 3 model) yükleniyor. 1GiB, modeller + selfie tensörleriyle birlikte
  // aşılıyordu (OOM → "internal"); 2GiB'ye çıkarıldı. Ayrıca selfie'ler kalite
  // kapısında ~800px'e küçültülüyor (bkz. faceQuality.bufferToTensor).
  { secrets: [FAL_KEY], region: "europe-west1", memory: "2GiB", timeoutSeconds: 180 },
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

    // Referansları indir (+ içerik moderasyonu, bkz. uploadReferencePhotos) ve
    // fal'a yükle. Bu adım bakiye/ücret ve fal üretim işinden ÖNCE gelir —
    // burada atılan bir HttpsError (ör. uygunsuz içerik) doğrudan kullanıcıya
    // gider, hiçbir bakiye/iş dokümanı oluşturulmamış olur.
    const { urls: refUrls, buffers: refBuffers } = await uploadReferencePhotos(uid, jobId);

    // Kimlik kalite kapısı: kaynak selfie'lerden kaç tanesinde net bir yüz
    // vektörü çıkarılamadığını kontrol et. Fail-safe — bu kontrolün kendisi
    // (tfjs/face-api) hata verirse filtresiz devam edilir, akış bloklanmaz.
    let refDescriptor = null;
    try {
      const { computeReferenceQuality } = require("./faceQuality");
      const quality = await computeReferenceQuality(refBuffers);
      if (quality.avgDescriptor) refDescriptor = Array.from(quality.avgDescriptor);
      if (quality.unclearIndices.length > 1) {
        // unclearIndices, kullanıcının seçtiği fotoğraf sırasıyla (0-tabanlı)
        // birebir eşleşir — client'a 1-tabanlı sıra numarası olarak gösterilir.
        const positions = quality.unclearIndices.map((i) => i + 1);
        const label = positions.length === 2
          ? `${positions[0]}. ve ${positions[1]}. fotoğraflar`
          : `${positions.slice(0, -1).join(", ")}. ve ${positions[positions.length - 1]}. fotoğraflar`;
        throw new HttpsError(
          "invalid-argument",
          `${label} net değil ya da yüzün yeterince görünmüyor. Lütfen bu ` +
          "fotoğrafları net, iyi aydınlatılmış, tek kişinin göründüğü " +
          "selfie'lerle değiştirip tekrar dene.",
          { unclearPhotoIndices: quality.unclearIndices }
        );
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("Kimlik kalite kontrolü başarısız (filtresiz devam ediliyor):", e);
    }

    const unitsNeeded = styleUnitsFor(styles.length);
    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);

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

      const balance = wallet.photoBalance || 0;
      if (balance < unitsNeeded) {
        if (!wallet.freePhotoUsed && styles.length === 1) {
          unitsToCharge = 0;
          usedFreeTier = true;
        } else if (!wallet.freePhotoUsed && styles.length > 1) {
          throw new HttpsError(
            "failed-precondition",
            "Ücretsiz deneme için yalnızca 1 stil seçebilirsin. Daha fazlası için paket al."
          );
        } else if (balance > 0) {
          // Bakiyesi var ama seçtiği stil sayısından az — net yönlendirme yap.
          throw new HttpsError(
            "failed-precondition",
            `Paketinde ${balance} stil hakkın var ama ${styles.length} stil seçtin. ` +
            `${balance} stil seç ya da daha fazla paket al.`
          );
        } else {
          throw new HttpsError(
            "failed-precondition",
            "Paket hakkın kalmadı. Devam etmek için AI Foto paketi al."
          );
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
        status: "generating",
        styles,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingStyles: styles.length,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsToCharge,
        usedFreeTier,
        falRefUrls: refUrls,
        ...(refDescriptor ? { refDescriptor } : {}),
      });
    });

    try {
      for (const styleId of styles) {
        const falJob = await submitStyleJob(uid, jobId, styleId, refUrls);
        // Nokta içeren anahtar yerine iç içe nesne — set(merge) bunu derin
        // birleştirir; "results.styleId" düz alan adı olarak yorumlanmaz.
        await jobRef.set({
          results: { [styleId]: { requestId: falJob.request_id, photoUrls: [], status: "pending", retries: 0 } },
        }, { merge: true });
      }

      // Referans selfie'leri artık gerekmiyor (fal kopyası + descriptor var).
      await deleteTrainingPhotos(uid, jobId);
    } catch (e) {
      console.error("startPhotoGeneration hata:", e);
      // Servis kesintisinde (fal bakiye/kilit) kullanıcıya net mesaj + iade.
      const outage = e instanceof HttpsError && e.code === "unavailable";
      await refundAndFail(
        uid,
        jobId,
        unitsToCharge,
        outage ? FAL_SERVICE_DOWN_MSG : "Üretim başlatılamadı.",
      );
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
    memory: "2GiB", // tfjs-wasm + face-api modelleri + sonuç görselleri (OOM önlemi)
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
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
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
      // fal.ai üretimi başarısız — GERÇEK nedeni logla (moderasyon, model
      // hatası, vb.). "Bazı stiller üretilemedi"nin kök nedeni burada görünür.
      let errDetail = "";
      try {
        errDetail = JSON.stringify(req.body?.error || req.body?.payload || req.body).slice(0, 400);
      } catch { errDetail = String(req.body?.status); }
      console.error(`fal.ai üretim başarısız (style=${styleId}): status=${req.body?.status} ${errDetail}`);
      if (await maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // Çıktıları paralel indir.
    const images = req.body?.payload?.images || [];
    if (images.length === 0) {
      console.error(`fal.ai OK döndü ama görsel yok (style=${styleId}):`,
        JSON.stringify(req.body?.payload || {}).slice(0, 300));
      if (await maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }
    let downloaded = [];
    try {
      downloaded = await Promise.all(images.map(async (img, i) => {
        const imgResp = await fetch(img.url);
        if (!imgResp.ok) throw new Error(`indirilemedi: ${imgResp.status}`);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        return { i, buf };
      }));
    } catch (e) {
      console.error("Sonuç görseli indirme hatası:", e);
      if (await maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
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
    if (
      job.refDescriptor &&
      passed.length < MIN_PASS_FOR_STYLE &&
      await maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef)
    ) {
      res.status(200).send("yeniden üretiliyor");
      return;
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

    if (photoUrls.length === 0) {
      if (await maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeStyle(uid, jobId, styleId, { failed: true });
      res.status(200).send("ok");
      return;
    }

    await finalizeStyle(uid, jobId, styleId, { photoUrls });
    res.status(200).send("ok");
  }
);

/**
 * Stil için yeniden üretim hakkı varsa yeni fal işi kuyruğa alır.
 * Döner: true = yeniden kuyruğa alındı (finalize etme).
 */
async function maybeRetryStyle(uid, jobId, styleId, job, styleResult, jobRef) {
  const retries = styleResult?.retries || 0;
  if (
    retries >= MAX_STYLE_RETRIES ||
    !Array.isArray(job.falRefUrls) ||
    job.falRefUrls.length === 0
  ) {
    return false;
  }
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
    return true;
  } catch (e) {
    console.error("Otomatik yeniden üretim başlatılamadı:", e);
    return false;
  }
}

/**
 * Bir stilin sonucunu ATOMİK ve IDEMPOTENT şekilde işler:
 *  - Stil zaten 'done'/'failed' ise hiçbir şey yapmaz (çift-teslimat koruması).
 *  - pendingStyles'ı transaction içinde azaltır (yarış koşulu yok).
 *  - Son stil de bittiğinde: EN AZ BİR stil fotoğraf ürettiyse iş 'done'
 *    (kısmi başarı). Hiçbir stil üretmediyse paket iade + 'failed'.
 */
async function finalizeStyle(uid, jobId, styleId, { photoUrls = [], failed = false }) {
  const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  // Boş sonuç = başarısız stil (kullanıcıya boş galeri gösterme).
  if (!failed && (!Array.isArray(photoUrls) || photoUrls.length === 0)) {
    failed = true;
  }
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
      const results = { ...(j.results || {}), [styleId]: update.results[styleId] };
      const successCount = Object.keys(results).filter((k) => {
        const r = results[k];
        return r?.status === "done" && Array.isArray(r.photoUrls) && r.photoUrls.length > 0;
      }).length;
      const failedCount = Object.keys(results).filter(
        (k) => results[k]?.status === "failed"
      ).length;

      if (successCount > 0) {
        // Kısmi başarı: üretilen stilleri göster. Başarısız stil birimleri iade.
        if (failedCount > 0 && (j.packUnitsCharged || 0) > 0) {
          const refundUnits = Math.min(failedCount, j.packUnitsCharged || 0);
          const walletSnap = await tx.get(walletRef);
          const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
          tx.set(walletRef, {
            photoBalance: (wallet.photoBalance || 0) + refundUnits,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        update.status = "done";
      } else {
        // Hiç stil üretilmedi — tam iade.
        const walletSnap = await tx.get(walletRef);
        const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
        const walletUpdate = {
          photoBalance: (wallet.photoBalance || 0) + (j.packUnitsCharged || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (j.usedFreeTier === true) {
          walletUpdate.freePhotoUsed = false;
        }
        tx.set(walletRef, walletUpdate, { merge: true });
        update.status = "failed";
        // Bu mesaj, üretilen görsellerin kaynak selfie'lerle kimlik eşleşme
        // eşiğini (bkz. faceQuality.FACE_MATCH_THRESHOLD) tutturamamasından
        // gelir — girdi fotoğrafının "bulanık" olmasından değil. Kullanıcıya
        // gerçek nedeni ve işe yarayan bir öneri sunar.
        update.errorMessage =
          "Üretilen fotoğraflar yüzünle yeterince eşleşmedi. Farklı ışıkta/açıda " +
          "çekilmiş, yüzünün net ve tek başına göründüğü selfie'lerle tekrar dene.";
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
  const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data().status === "failed" || jobSnap.data().status === "done") {
      return; // zaten sonuçlanmış
    }
    const job = jobSnap.data();
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
    const walletUpdate = {
      photoBalance: (wallet.photoBalance || 0) + unitsToRefund,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    // İş ücretsiz hakla başlatıldıysa ve foto üretilemedise ücretsiz hakkı da
    // geri ver — aksi halde kullanıcı hiç foto almadan ücretsiz denemesini
    // kaybediyordu ("Yetersiz paket bakiyesi" ile kilitleniyordu).
    if (job.usedFreeTier === true) {
      walletUpdate.freePhotoUsed = false;
    }
    tx.set(walletRef, walletUpdate, { merge: true });
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
      const uid = doc.ref.parent.parent.parent.parent.parent.id; // users/{uid}/private/genData/genJobs/{jobId}
      const job = doc.data();
      console.warn(`Takılı iş temizleniyor: ${doc.ref.path}`);
      await refundAndFail(uid, doc.id, job.packUnitsCharged || 0, "Zaman aşımı — işlem tamamlanamadı.");
    }
  }
);
