const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
// Üretim modeli: Seedream v5 Pro (edit). Kullanıcının GERÇEK fotoğraflarını
// referans alıp (image_urls — 10 taneye kadar) o kişiyi yeni bir sahnede
// yeniden fotoğraflar.
//
// NEDEN PuLID DEĞİL: PuLID yüzü bir kimlik-embedding'inden SIFIRDAN sentezler;
// bu, cilt dokusunu kaybettirip "plastik/AI" görünüme yol açıyordu ve
// id_weight yüksekken sahneyi ezdiği için arka planlar tamamen çöküyordu
// ("hiçbir fotoğrafta arka plan yok"). Edit modeli gerçek foto piksellerinden
// çalıştığı için hem cilt/yüz doğal kalır hem sahne ayakta durur. Ayrıca
// Seedream TEK referans yerine 3 referansın HEPSİNİ birden görür → kimlik
// sadakati belirgin biçimde daha yüksek.
const GEN_MODEL = "bytedance/seedream/v5/pro/edit";
// Stil başına üretilecek foto. Her biri FARKLI bir sahne varyantıdır (bkz.
// STYLE_SCENES) — aynı sahnenin 5 kopyası değil, 5 ayrı gerçek ortam.
const IMAGES_PER_STYLE = 5; // DatingConfig.photosPerSet ile senkron (ödenen vaat)
// Kullanıcıdan istenen referans foto sayısı (client ile senkron).
const REFERENCE_PHOTO_COUNT = 3;
// Bir chunk (tek görsel) fal tarafında hata verirse kaç kez yeniden denenir.
const MAX_CHUNK_RETRIES = 2;

// Bu fonksiyonların gerçek public URL'i (fal.ai webhook hedefi).
const FUNCTIONS_BASE = "https://europe-west1-rise-up-9235f.cloudfunctions.net";

// PhotoStyle.id -> stil başına IMAGES_PER_STYLE adet AYRI sahne varyantı.
// lib/core/constants/dating_constants.dart PhotoStyle.coreStyles ile EL İLE
// senkron tutulmalı.
//
// Sahneler bilinçli olarak ÇOK SOMUT yazıldı: "elegant portrait" gibi soyut
// ifadeler modeli stüdyo-vari, arka plansız yakın çekime itiyordu. Somut mekân
// + kıyafet + ışık tarifi, arka planın gerçekten oluşmasını sağlar.
const STYLE_SCENES = {
  elegance: [
    "standing in a modern hotel lobby, wearing a well-fitted charcoal blazer over a white shirt, soft daylight from a tall window to the side, marble and warm lamps visible behind",
    "seated at a marble bar counter in an upscale restaurant, wearing a navy suit without a tie, warm evening interior lighting, shelves of bottles softly blurred behind",
    "walking along a city street at golden hour wearing a tailored coat, blurred shopfronts and passers-by behind, low warm sunlight",
    "leaning against the glass facade of an office building in daylight, wearing a light grey suit, city skyline and reflections behind",
    "in an art gallery with white walls and framed artwork behind, wearing a black turtleneck, soft even gallery lighting",
  ],
  athletic: [
    "in a modern gym with weights, machines and mirrors visible behind, wearing a fitted training t-shirt, natural overhead lighting, light sweat on the skin",
    "outdoors on a running track at sunrise wearing athletic gear, empty stadium seating and warm low sun behind",
    "in a boxing gym with punching bags and brick walls behind, wearing a tank top and hand wraps, window light from the left",
    "on a forest hiking trail wearing sportswear with a small backpack, dappled sunlight through the trees behind",
    "on an outdoor basketball court in late afternoon holding a ball, chain-link fence and apartment buildings behind",
  ],
  traveller: [
    "standing on a cobbled street in an old European town, historic facades and cafe awnings behind, wearing a casual jacket, soft overcast daylight",
    "at a mountain viewpoint wearing a light outdoor jacket, valley and distant peaks stretching out behind, bright natural daylight",
    "on a coastal cliff path with the open sea and horizon behind, wearing a linen shirt moving slightly in the breeze, sunny day",
    "in a busy street market with colourful stalls and hanging goods behind, wearing a casual shirt, warm afternoon light",
    "on the wooden deck of a boat with a harbour and moored sailboats behind, sunglasses pushed up on the head, bright daylight",
  ],
  oldmoney: [
    "seated in a leather armchair in a wood-panelled library, bookshelves behind, wearing a cream knit sweater, warm lamp light",
    "standing on the stone terrace of a countryside estate, wearing a navy blazer over a polo shirt, manicured lawn and old trees behind",
    "on a yacht club dock wearing a light sweater over a collared shirt, moored boats and calm water behind, clear daylight",
    "beside wooden stables in an equestrian setting, wearing a quilted jacket, paddock and fencing behind, natural daylight",
    "in a classic dining room with antique furniture and a large window, wearing a crisp tailored shirt, soft window light",
  ],
  nightout: [
    "in a dimly lit cocktail bar, warm amber lighting, blurred bottles and pendant lamps behind, wearing a dark shirt",
    "on a rooftop bar at night with out-of-focus city lights spread out behind, wearing a fitted jacket",
    "on a neon-lit city street at night, reflections on wet pavement and glowing signs behind, wearing a leather jacket",
    "at a lively restaurant table with warm string lights and other diners blurred behind, wearing a casual button-up shirt",
    "outside a venue at night under a soft street lamp, brick wall and warm light spill behind, smart casual outfit",
  ],
  beach: [
    "standing on a sandy beach at golden hour, breaking waves and open ocean behind, wearing an open linen shirt",
    "walking along the shoreline in swim shorts, bright midday sun, sea and wet sand behind",
    "sitting on weathered wooden beach steps, palm trees and dunes behind, warm late afternoon light",
    "at a thatched-roof beach bar with the sea visible behind, wearing a casual short-sleeve shirt",
    "standing on coastal rocks with sea spray and the horizon behind, wearing a plain t-shirt, natural daylight",
  ],
  car: [
    "standing beside a dark luxury sedan on a city street in the evening, wearing a smart jacket, warm street lighting and buildings behind",
    "leaning on the front of a sports car in an underground car park, dramatic overhead lighting, concrete pillars behind",
    "next to a car parked on a mountain road, sweeping scenic valley view behind, clear daylight",
    "opening the door of a luxury car outside a modern glass building, daytime, city reflections behind",
    "seated on the sill of an open car door at a scenic overlook at sunset, warm low light, landscape behind",
  ],
};

/**
 * Edit modeline verilen tam talimat. Üç parçadan oluşur:
 *  1) KİMLİK: referans fotoğraflardaki kişinin yüzünü aynen koru (modelin en
 *     sık hatası, "benzer ama başka biri" üretmek).
 *  2) SAHNE: somut mekân/kıyafet/ışık (arka planın oluşmasını garanti eder).
 *  3) GERÇEKÇİLİK: gözenekli/rötuşsuz cilt, doğal asimetri, gerçek kamera
 *     dili + yarım boy kadraj (arka planın GÖRÜNMESİ için şart) ve "AI gibi
 *     durma" yasakları.
 */
function buildPrompt(styleId, variantIdx) {
  const variants = STYLE_SCENES[styleId];
  const scene = variants[variantIdx % variants.length];
  return (
    "Photograph the exact same person shown in the reference images, in a completely new setting. " +
    "Preserve their facial identity precisely: same bone structure, eyes, nose, mouth, jawline, " +
    "skin tone, hairline and age. They must be immediately recognisable as the same individual. " +
    "Do not beautify, slim, or alter their face in any way.\n\n" +
    "Scene: " + scene + ".\n\n" +
    "Framing: natural half-body or waist-up shot with the surroundings clearly visible behind them — " +
    "the location must be readable, not a blank or blurred-out studio backdrop. " +
    "Style: an authentic candid photograph that looks like it was taken by a friend on a good camera. " +
    "Natural unretouched skin with visible pores, real texture and slight imperfections, natural facial " +
    "asymmetry, individual hair strands, realistic fabric folds. Shot on a full-frame camera with a 50mm " +
    "lens at f/2.0, available natural light, true-to-life colours, gentle depth of field. " +
    "Absolutely avoid: airbrushed or plastic skin, waxy sheen, beauty filter, over-smoothing, " +
    "oversaturated colours, CGI or 3D render look, illustration, cartoon, symmetrical AI face, " +
    "studio backdrop, text, watermark, extra fingers or distorted hands."
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
 * fal.ai queue API'sine bir Seedream edit işi gönderir (tek görsel). Bir stilin
 * TEK bir chunk'ı için çağrılır — chunkIdx hem webhook'un hangi sonucu
 * işleyeceğini belirler HEM DE hangi sahne varyantının üretileceğini seçer
 * (chunk 0..4 -> STYLE_SCENES[style][0..4]). Böylece bir stildeki 5 foto
 * birbirinin kopyası değil, 5 farklı gerçek ortam olur.
 *
 * Kullanıcının TÜM referans fotoğrafları (3 adet) image_urls ile gönderilir —
 * model kişiyi birden fazla açıdan gördüğü için kimlik sadakati artar.
 */
async function submitStyleJob(uid, jobId, styleId, chunkIdx, referenceImageUrls, seed) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}&chunk=${chunkIdx}`;
  const input = {
    prompt: buildPrompt(styleId, chunkIdx),
    image_urls: referenceImageUrls,
    image_size: "portrait_4_3", // dikey dating fotoğrafı
    num_images: 1,
    output_format: "jpeg",
    seed,
    enable_safety_checker: false, // girdi zaten moderasyondan geçti; çıktı
    // safety_checker'ı meşru portrelerde boş sonuç üretebiliyor.
  };
  const resp = await fetch(
    `${FAL_QUEUE_BASE}/${GEN_MODEL}?fal_webhook=${encodeURIComponent(webhookUrl)}`,
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
 * ADIM 1/2 — DOĞRULAMA. Kullanıcı 5 referans selfie'sini Storage'a yükledikten
 * sonra, HENÜZ HİÇBİR KREDİ/BAKİYE HARCANMADAN ve fal.ai'ye hiçbir üretim işi
 * gönderilmeden çağrılır. Fotoğrafla ilgili TÜM kapılar burada çalışır:
 *   - +18/uygunsuz içerik (Cloud Vision SafeSearch)
 *   - net/tek yüz kapısı + en iyi referans seçimi (ssd_mobilenetv1 tespiti)
 * Buradan bir HttpsError dönerse client hâlâ fotoğraf seçme ekranındadır ve
 * kullanıcı ilgili fotoğrafı değiştirir. Bu fonksiyon BAŞARIYLA dönerse
 * fotoğraf kaynaklı hiçbir uyarı kalmaz — client ancak o zaman üretim
 * loader'ını başlatır ve startPhotoGeneration'ı çağırır.
 *
 * Başarılıysa işi 'ready' durumunda hazırlar: fal referans URL'leri ve üretim
 * modeline verilecek "primary" referans (en net/en büyük yüzlü selfie) dokümana
 * yazılır; referans selfie'ler Storage'dan silinir (KVKK — biyometrik veri).
 *
 * data: { jobId: string } -> { ok: true }
 */
exports.prepareReferencePhotos = onCall(
  // Yalnızca ssd_mobilenetv1 tespit modeli yükleniyor (descriptor YOK) →
  // eskisine göre çok daha hafif. minInstances:1 ile soğuk başlangıç (model
  // yeniden yükleme) gecikmesi ortadan kaldırıldı — "kontrol çok uzun sürüyor"
  // şikayetinin başlıca nedeni buydu.
  {
    secrets: [FAL_KEY],
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 120,
    minInstances: 1,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { jobId } = request.data || {};
    if (!jobId) {
      throw new HttpsError("invalid-argument", "jobId zorunlu.");
    }

    // Referansları indir (+ içerik moderasyonu, bkz. uploadReferencePhotos) ve
    // fal'a yükle. Buradaki HttpsError doğrudan kullanıcıya gider.
    const { urls: refUrls, buffers: refBuffers } = await uploadReferencePhotos(uid, jobId);

    // Net/tek yüz kapısı + en iyi referansın öne alınması. Seedream referansların
    // HEPSİNİ kullanır, ama ilk sıradakine daha çok ağırlık verme eğilimindedir;
    // bu yüzden en net yüzlü foto başa taşınır. Fail-safe: kontrolün KENDİSİ
    // (tfjs/tespit) hata verirse üretim bloklanmaz, sıra olduğu gibi kalır.
    let orderedRefUrls = refUrls;
    try {
      const { analyzeReferences } = require("./faceQuality");
      const analysis = await analyzeReferences(refBuffers);
      if (analysis.unclearIndices.length > 0) {
        // unclearIndices, kullanıcının seçtiği fotoğraf sırasıyla (0-tabanlı)
        // birebir eşleşir — client'a 1-tabanlı sıra numarası olarak gösterilir.
        const positions = analysis.unclearIndices.map((i) => i + 1);
        const many = positions.length > 1;
        const label = many
          ? `${positions.slice(0, -1).join(", ")}. ve ${positions[positions.length - 1]}. fotoğraflar`
          : `${positions[0]}. fotoğraf`;
        throw new HttpsError(
          "invalid-argument",
          `${label} net değil ya da yüzün yeterince görünmüyor. Lütfen ` +
          `${many ? "bunları" : "bunu"} net, iyi aydınlatılmış, tek kişinin ` +
          "göründüğü selfie ile değiştirip tekrar dene.",
          { unclearPhotoIndices: analysis.unclearIndices }
        );
      }
      if (analysis.bestIndex != null && refUrls[analysis.bestIndex]) {
        const best = refUrls[analysis.bestIndex];
        orderedRefUrls = [best, ...refUrls.filter((u) => u !== best)];
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("Yüz kontrolü başarısız (referans sırası korunuyor):", e);
    }

    // Tüm kapılar geçildi — işi 'ready' olarak hazırla. Bakiye HENÜZ düşülmez;
    // o startPhotoGeneration'ın (adım 2/2) işi.
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
    await jobRef.set({
      status: "ready",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      errorMessage: null,
      // Tümü üretime gönderilir (en net olan başta) — bkz. submitStyleJob.
      falRefUrls: orderedRefUrls,
    });

    // Referans selfie'ler artık gerekmiyor (fal kopyası var).
    await deleteTrainingPhotos(uid, jobId);

    return { ok: true };
  }
);

/**
 * ADIM 2/2 — ÜRETİM. YALNIZCA prepareReferencePhotos başarıyla tamamlandıktan
 * (iş 'ready' olduktan) sonra çağrılabilir; fotoğrafla ilgili tüm doğrulamalar
 * o adımda bitmiştir. Burada bakiye kontrolü + düşme (client atlayamaz) ve
 * her stil için chunk'lara bölünmüş edit işlerinin gönderimi yapılır.
 *
 * data: { styles: string[], jobId: string } -> { jobId }
 */
exports.startPhotoGeneration = onCall(
  { secrets: [FAL_KEY], region: "europe-west1", memory: "512MiB", timeoutSeconds: 180 },
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

    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);

    // Doğrulama adımı atlanamaz: iş 'ready' değilse üretim başlamaz.
    const prepSnap = await jobRef.get();
    if (!prepSnap.exists || prepSnap.data().status !== "ready") {
      throw new HttpsError(
        "failed-precondition",
        "Fotoğraflar henüz doğrulanmadı. Lütfen baştan tekrar dene."
      );
    }
    const refUrls = prepSnap.data().falRefUrls;
    if (!Array.isArray(refUrls) || refUrls.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        "Referans fotoğrafları hazır değil. Lütfen baştan tekrar dene."
      );
    }

    // Bakiye kontrolü + düşme + işi 'generating'e geçirme — tek transaction.
    // Ücretsiz deneme: daha önce kullanılmadıysa 1 stil ücretsiz (bakiye 0 olsa bile).
    const unitsNeeded = styleUnitsFor(styles.length);
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

      // merge — prepareReferencePhotos'un yazdığı falRefUrls korunur.
      tx.set(jobRef, {
        status: "generating",
        styles,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingStyles: styles.length,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsToCharge,
        usedFreeTier,
      }, { merge: true });
    });

    try {
      for (const styleId of styles) {
        // Stil başına IMAGES_PER_STYLE (5) foto = 5 ayrı istek ("chunk"), her
        // biri FARKLI bir sahne varyantı (chunk index -> STYLE_SCENES sırası).
        // İstekler PARALEL gönderilir — sıralı POST loader'ı gereksiz uzatıyordu.
        const submissions = await Promise.all(
          Array.from({ length: IMAGES_PER_STYLE }, async (_, i) => {
            const seed = Math.floor(Math.random() * 2147483647);
            const falJob = await submitStyleJob(uid, jobId, styleId, i, refUrls, seed);
            return [String(i), {
              requestId: falJob.request_id,
              photoUrls: [],
              status: "pending",
              retries: 0,
              seed,
            }];
          })
        );
        const chunks = Object.fromEntries(submissions);
        // Nokta içeren anahtar yerine iç içe nesne — set(merge) bunu derin
        // birleştirir; "results.styleId" düz alan adı olarak yorumlanmaz.
        await jobRef.set({
          results: { [styleId]: { status: "pending", photoUrls: [], chunks } },
        }, { merge: true });
      }
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
 * fal.ai bir chunk'ın (stilin bir parçasının) işi tamamlanınca (webhook)
 * çağrılır. Çıktıyı indirir, kalite kapısından geçirir, geçenleri Storage'a
 * yazar ve iş dokümanını (atomik + idempotent) günceller. Kimlik benzerliği
 * düşükse chunk'ı bir kez otomatik yeniden üretir. Bir stilin TÜM chunk'ları
 * bitince sonuçlar birleştirilir (bkz. finalizeChunk).
 */
exports.falInferenceWebhook = onRequest(
  {
    secrets: [FAL_KEY], // otomatik yeniden üretim fal'a yeni iş gönderiyor
    region: "europe-west1",
    // Artık face-api YÜKLENMİYOR (kimlik sadakati PuLID id_weight ile modelin
    // içinde) — webhook yalnızca sonuç görselini indirip Storage'a yazıyor.
    memory: "512MiB",
    timeoutSeconds: 120,
    minInstances: 1,
  },
  async (req, res) => {
    const uid = req.query.uid;
    const jobId = req.query.jobId;
    const styleId = req.query.style;
    const chunkIdx = req.query.chunk;
    if (!uid || !jobId || !styleId || chunkIdx === undefined) {
      res.status(400).send("uid/jobId/style/chunk eksik");
      return;
    }
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      res.status(404).send("job bulunamadı");
      return;
    }
    const job = jobSnap.data();
    const chunk = job.results?.[styleId]?.chunks?.[chunkIdx];
    if (!chunk) {
      res.status(404).send("chunk bulunamadı");
      return;
    }

    // request_id doğrulaması (anti-spoofing).
    const requestId = req.body?.request_id;
    if (!requestId || requestId !== chunk.requestId) {
      res.status(403).send("request_id uyuşmuyor");
      return;
    }

    // Idempotency: fal webhook'u aynı çağrıyı birden çok kez gönderebilir.
    // Bu chunk zaten sonuçlandıysa hiçbir şey yapma.
    if (chunk.status === "done" || chunk.status === "failed") {
      res.status(200).send("zaten işlendi");
      return;
    }

    if (req.body?.status !== "OK" && req.body?.status !== "COMPLETED") {
      // fal.ai üretimi başarısız — GERÇEK nedeni logla (moderasyon, model
      // hatası, geçersiz parametre vb.). "Bazı stiller üretilemedi"nin kök
      // nedeni burada görünür.
      let errDetail = "";
      try {
        errDetail = JSON.stringify(req.body?.error || req.body?.payload || req.body).slice(0, 400);
      } catch { errDetail = String(req.body?.status); }
      console.error(`fal.ai üretim başarısız (style=${styleId}, chunk=${chunkIdx}): status=${req.body?.status} ${errDetail}`);
      if (await maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // Çıktıları paralel indir.
    const images = req.body?.payload?.images || [];
    if (images.length === 0) {
      console.error(`fal.ai OK döndü ama görsel yok (style=${styleId}, chunk=${chunkIdx}):`,
        JSON.stringify(req.body?.payload || {}).slice(0, 300));
      if (await maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
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
      if (await maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // Kimlik sadakati PuLID (id_weight) ile üretimde sağlandığı için çıktı
    // görsellerini ARTIK ELEMİYORUZ — üretilen her foto saklanır (vaat edilen
    // stil başına 10 sayısı böylece korunur).
    let photoUrls = [];
    try {
      photoUrls = await Promise.all(downloaded.map(async ({ i, buf }) => {
        // chunkIdx dosya adına eklenir — aksi halde farklı chunk'ların aynı
        // "i" indeksli görselleri birbirinin üstüne yazardı.
        const path = `dating_results/${uid}/${jobId}/${styleId}_${chunkIdx}_${i}.jpg`;
        await bucket().file(path).save(buf, { metadata: { contentType: "image/jpeg" } });
        return `gs://${bucket().name}/${path}`;
      }));
    } catch (e) {
      console.error("Sonuç görseli kaydetme hatası:", e);
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    if (photoUrls.length === 0) {
      if (await maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor");
        return;
      }
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    await finalizeChunk(uid, jobId, styleId, chunkIdx, { photoUrls });
    res.status(200).send("ok");
  }
);

/**
 * Bir chunk için yeniden üretim hakkı varsa aynı boyutta yeni fal işi
 * kuyruğa alır. Döner: true = yeniden kuyruğa alındı (finalize etme).
 */
async function maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef) {
  const retries = chunk?.retries || 0;
  const refUrls = job.falRefUrls;
  if (retries >= MAX_CHUNK_RETRIES || !Array.isArray(refUrls) || refUrls.length === 0) {
    return false;
  }
  try {
    // Yeni seed — takılan/başarısız üretimi farklı bir çıktı ile kurtar.
    // Aynı chunkIdx → aynı sahne varyantı korunur.
    const seed = Math.floor(Math.random() * 2147483647);
    const falJob = await submitStyleJob(uid, jobId, styleId, chunkIdx, refUrls, seed);
    await jobRef.set({
      results: {
        [styleId]: {
          chunks: {
            [chunkIdx]: {
              requestId: falJob.request_id,
              photoUrls: [],
              status: "pending",
              retries: retries + 1,
              seed,
            },
          },
        },
      },
    }, { merge: true });
    return true;
  } catch (e) {
    console.error("Otomatik chunk yeniden üretimi başlatılamadı:", e);
    return false;
  }
}

/**
 * Bir chunk'ın sonucunu ATOMİK ve IDEMPOTENT şekilde işler:
 *  - Chunk zaten 'done'/'failed' ise hiçbir şey yapmaz (çift-teslimat koruması).
 *  - Stilin TÜM chunk'ları bitince: en az bir chunk foto ürettiyse stil 'done'
 *    (kısmi başarı dahil, chunk'ların photoUrls'leri birleştirilir), hiçbiri
 *    üretmediyse stil 'failed'.
 *  - Stil de bu çağrıda yeni sonuçlandıysa: pendingStyles azaltılır ve son
 *    stil de bitince iş genelinde başarı/iade kararı verilir — hepsi TEK
 *    transaction içinde (chunk → stil → iş, üç seviye tek atomik yazım).
 */
async function finalizeChunk(uid, jobId, styleId, chunkIdx, { photoUrls = [], failed = false }) {
  const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  // Boş sonuç = başarısız chunk (kullanıcıya boş galeri gösterme).
  if (!failed && (!Array.isArray(photoUrls) || photoUrls.length === 0)) {
    failed = true;
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return;
    const j = snap.data();
    const chunks = j.results?.[styleId]?.chunks || {};
    const chunk = chunks[chunkIdx];
    if (!chunk || chunk.status === "done" || chunk.status === "failed") return; // idempotent no-op

    const mergedChunks = {
      ...chunks,
      [chunkIdx]: { ...chunk, status: failed ? "failed" : "done", photoUrls },
    };
    const chunkKeys = Object.keys(mergedChunks);
    const styleTerminal = chunkKeys.every(
      (k) => mergedChunks[k].status === "done" || mergedChunks[k].status === "failed"
    );

    // İç içe nesne — set(merge) derin birleştirir; kardeş chunk'lar/stiller
    // etkilenmez (bkz. dosyanın diğer yerlerindeki aynı desen).
    const update = {
      results: { [styleId]: { chunks: { [chunkIdx]: mergedChunks[chunkIdx] } } },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!styleTerminal) {
      tx.set(jobRef, update, { merge: true });
      return;
    }

    // Stilin tüm chunk'ları bitti — nihai stil sonucunu hesapla (birleştir).
    const styleMergedUrls = chunkKeys.flatMap((k) => mergedChunks[k].photoUrls || []);
    const styleFailed = styleMergedUrls.length === 0;
    update.results[styleId].status = styleFailed ? "failed" : "done";
    update.results[styleId].photoUrls = styleMergedUrls;

    const newPending = Math.max(0, (j.pendingStyles ?? (j.styles?.length || 1)) - 1);
    update.pendingStyles = newPending;

    if (newPending === 0) {
      const results = {
        ...(j.results || {}),
        [styleId]: { status: update.results[styleId].status, photoUrls: update.results[styleId].photoUrls },
      };
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
 * Webhook teslimatı güvenilmez olabilir — uzun süredir 'generating' takılı
 * kalan işleri başarısız sayıp iade eder. 'ready' (doğrulaması geçmiş ama
 * kullanıcı üretime hiç geçmemiş) işler de buraya düşer: bakiye zaten
 * düşülmediği için iade 0'dır, ama kimlik vektörü geride kalmasın diye iş
 * kapatılır. 'uploading' yalnızca eski/kalıntı işler için (artık üretilmiyor).
 */
exports.cleanupStuckGenJobs = onSchedule(
  { schedule: "every 5 minutes", region: "europe-west1", timeoutSeconds: 120 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
    const stuck = await db
      .collectionGroup("genJobs")
      .where("status", "in", ["uploading", "ready", "generating"])
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
