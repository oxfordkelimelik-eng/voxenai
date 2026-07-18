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
// Sahneler CİNSİYET BELİRTMEZ (zamir kullanılmaz) — cinsiyet referans
// fotoğraflardan gelir. "he/she" yazmak, modeli kullanıcının cinsiyetinden
// bağımsız olarak o cinsiyete zorluyor.
//
// Her varyant dört şeyi birlikte tarif eder: MEKÂN + O ANDA NE YAPTIĞI +
// İFADE + IŞIK. "Ne yaptığı" kritik: poz vermiş donuk bir figür yerine bir
// ana yakalanmış izlenimi, fotoğrafı "çekilmiş" gösteren şeydir.
const STYLE_SCENES = {
  elegance: [
    "Mid-step through the lobby of a boutique hotel, adjusting a cuff and glancing off-camera with a relaxed half-smile, wearing a well-cut charcoal blazer over an open white shirt. Behind: a marble reception desk, warm brass lamps, and a tall arched window spilling soft late-afternoon light across the floor",
    "Leaning on one forearm at the marble counter of a dimly lit restaurant bar, holding a glass of wine, laughing at something just out of frame. Behind: backlit shelves of bottles, low pendant lights, a bartender blurred mid-motion",
    "Crossing a European city street at golden hour in a tailored camel coat, hands in pockets, calm and unposed, looking slightly away from the lens. Behind: blurred shopfronts, warm low sun flaring between buildings, out-of-focus passers-by",
    "Standing at the railing of a rooftop terrace at dusk in a light grey suit with the collar open, one hand resting on the rail, easy natural smile. Behind: glass towers with lit windows against a deep blue evening sky",
    "Pausing in a quiet art gallery, hands in pockets, head turned to study a painting with a thoughtful expression, wearing a fine black turtleneck. Behind: white walls, large framed artworks, soft even ceiling light",
  ],
  athletic: [
    "Resting between sets on a gym bench, forearms on knees, catching breath and looking up with a slight grin, wearing a fitted training t-shirt damp with sweat. Behind: racks of weights, mirrors and machines under natural overhead light",
    "Mid-stride on an outdoor running track at sunrise, breath visible in cool air, focused expression, wearing technical running gear. Behind: empty stadium seating and a low warm sun casting long shadows",
    "Wrapping hands with tape in a worn boxing gym, head down in concentration then glancing up, wearing a loose tank top. Behind: hanging heavy bags, exposed brick and dusty window light from the left",
    "Stopping on a forest hiking trail to look back over one shoulder with an open smile, wearing technical outerwear and a small backpack. Behind: tall trees with dappled sunlight breaking through the canopy",
    "Holding a basketball on one hip on an outdoor court in late afternoon, mid-conversation, relaxed and smiling. Behind: chain-link fencing, painted court lines and apartment blocks in warm side light",
  ],
  traveller: [
    "Walking a narrow cobbled street in an old European town, looking up at the buildings with genuine curiosity, wearing a casual jacket with a bag slung across the body. Behind: weathered stone facades, cafe awnings and shuttered windows under soft overcast light",
    "Standing at a mountain viewpoint with a light outdoor jacket, wind in the hair, quietly taking in the view with a small satisfied smile. Behind: a wide valley falling away to layered blue peaks in clear daylight",
    "On a coastal cliff path with a linen shirt moving in the breeze, one hand shielding the eyes from the sun, laughing. Behind: open sea, a long horizon line and scattered white clouds",
    "Browsing a stall in a busy street market, mid-gesture talking to the vendor, wearing a simple casual shirt. Behind: colourful hanging goods, crates of produce and warm dappled afternoon light",
    "Sitting on the wooden deck of a boat with sunglasses pushed up on the head, one arm over the rail, easy unposed expression. Behind: a working harbour, moored sailboats and bright reflected water",
  ],
  oldmoney: [
    "Settled into a worn leather armchair in a wood-panelled library, a book resting on one knee, looking up mid-thought, wearing a cream cable-knit sweater. Behind: floor-to-ceiling bookshelves and the warm pool of a brass reading lamp",
    "Standing on the stone terrace of a countryside estate with a hand in one pocket, turning toward the camera with a relaxed smile, wearing a navy blazer over a polo. Behind: a manicured lawn, mature oak trees and soft morning haze",
    "On a wooden yacht club dock, coiling a rope, glancing up with an unhurried expression, wearing a light sweater over a collared shirt. Behind: moored boats, masts and calm water under clear daylight",
    "Beside weathered stable doors, resting a hand on the timber, calm and at ease, wearing a quilted jacket. Behind: a paddock, white fencing and long grass in soft natural daylight",
    "At the head of a classic dining room table, mid-conversation with a warm expression, wearing a crisp tailored shirt with sleeves rolled. Behind: antique furniture, framed pictures and light from a tall sash window",
  ],
  nightout: [
    "At the counter of a dim cocktail bar, turning toward the camera mid-laugh with a drink in hand, wearing a dark shirt with the top button open. Behind: warm amber light, blurred bottles and glowing pendant lamps",
    "On a rooftop bar at night, leaning back against the railing with a relaxed grin, wearing a well-fitted jacket. Behind: a wide spread of out-of-focus city lights and a dark skyline",
    "Walking a neon-lit street at night, hands in jacket pockets, glancing sideways with a half-smile, wearing a leather jacket. Behind: glowing signs reflected in wet pavement and passing headlights",
    "At a busy restaurant table, mid-conversation and gesturing with one hand, genuine laughter, wearing a casual button-up. Behind: warm string lights, other diners softly blurred and candles on tables",
    "Standing outside a venue at night under a street lamp, checking a phone then looking up, smart casual outfit. Behind: a brick wall, warm light spill from a doorway and soft bokeh from traffic",
  ],
  beach: [
    "Standing barefoot on wet sand at golden hour, an open linen shirt catching the breeze, looking out toward the water with a calm smile. Behind: breaking waves, a low warm sun and a long empty shoreline",
    "Walking out of the shallows, running a hand back through wet hair, laughing, wearing swim shorts. Behind: bright midday sea, foam and sunlit water",
    "Sitting on weathered wooden beach steps with forearms on knees, relaxed and looking off to the side, wearing a light shirt. Behind: palm fronds, dune grass and warm late-afternoon light",
    "Leaning on the bamboo counter of a thatched beach bar with a cold drink, mid-conversation, wearing a casual short-sleeve shirt. Behind: the open sea framed by the bar's roof and hanging lights",
    "Standing on dark coastal rocks with a plain t-shirt, arms loose, watching the swell with an unguarded expression. Behind: sea spray, deep blue water and a clean horizon under natural daylight",
  ],
  car: [
    "Standing beside a dark luxury sedan on a city street in the evening, one hand on the roof, turning toward the camera with a relaxed expression, wearing a smart jacket. Behind: warm street lighting, shopfronts and soft traffic bokeh",
    "Leaning back against the front of a sports car in an underground car park, arms loosely crossed, calm and direct, wearing a dark jacket. Behind: concrete pillars and dramatic overhead lighting pooling on the floor",
    "Standing at the open door of a car parked on a mountain road, one foot on the sill, looking out at the view then back to the lens. Behind: a sweeping valley, winding road and clear bright daylight",
    "Mid-motion closing a car door outside a modern glass building in daytime, glancing up with an easy smile, wearing a well-fitted coat. Behind: reflective glass, city reflections and clean daylight",
    "Sitting on the sill of an open car door at a scenic overlook at sunset, elbows on knees, quietly taking in the view. Behind: a warm low sun, a wide landscape and long golden light",
  ],
};

/**
 * Edit modeline verilen tam talimat. Dört bölümden oluşur:
 *  1) KİMLİK: kişi tanınabilir kalmalı.
 *  2) BÜTÜNLEŞME (kritik): bu YENİ bir fotoğraf — yüz sahnenin ışığına göre
 *     YENİDEN aydınlatılmalı. Önceki sürümde "yüzü hiçbir şekilde değiştirme"
 *     dendiği için model yüzü birebir kopyalayıp yapıştırıyordu; sonuç
 *     "kesme-yapıştırma" gibi duruyordu. Artık ışık/açı/ifade uyumu açıkça
 *     isteniyor, kimlik ise korunuyor.
 *  3) SAHNE: mekân + eylem + ifade + ışık (arka planı gerçekten kurar).
 *  4) ZANAAT + YASAKLAR: gerçek kamera dili, rötuşsuz cilt, "AI görünümü" yasağı.
 */
function buildPrompt(styleId, variantIdx) {
  const variants = STYLE_SCENES[styleId];
  const scene = variants[variantIdx % variants.length];
  return (
    "Create a brand-new photograph of the person from the reference images.\n\n" +
    "IDENTITY: Keep them genuinely recognisable — same bone structure, eye shape and colour, " +
    "nose, mouth, jawline, hairline, skin tone and apparent age.\n\n" +
    "INTEGRATION (most important): This is a NEW photograph actually taken in the location below — " +
    "it is NOT a cut-out of the reference face placed onto a background. Re-light the face and body to " +
    "match the direction, colour temperature and softness of the scene's light. Shadows across the face, " +
    "catchlights in the eyes, and skin tone must all agree with the environment. Head angle, gaze, posture " +
    "and expression must suit the moment described. Hair, collar and shoulders must sit naturally in the " +
    "scene with consistent grain and focus. No pasted-on look, no mismatched lighting, no sharp cut-out " +
    "edges, no floating head, no sticker effect.\n\n" +
    "SCENE: " + scene + ".\n\n" +
    "FRAMING: a natural half-body or waist-up shot with the environment clearly readable behind — " +
    "never a blank, plain or studio backdrop.\n\n" +
    "CRAFT: an authentic candid photograph, the kind a friend takes on a good camera. Natural unretouched " +
    "skin with visible pores and real texture, faint blemishes and natural facial asymmetry, individual " +
    "flyaway hairs, realistic fabric folds and creases. Full-frame camera, 35mm or 50mm lens at f/2.0, " +
    "available natural light, true-to-life colour, gentle depth of field, a touch of real lens character.\n\n" +
    "AVOID: airbrushed or plastic skin, waxy sheen, beauty filter, over-smoothing, oversaturated colour, " +
    "HDR glow, CGI or 3D render look, illustration, cartoon, perfectly symmetrical AI face, vacant " +
    "expression, stiff posed mannequin stance, studio backdrop, text, watermark, distorted hands."
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
    // 3:4 dikey, yüksek çözünürlük. Hazır "portrait_4_3" preset'i daha düşük
    // çözünürlüklü; cilt gözenekleri/saç telleri gibi doğallık veren detaylar
    // ancak bu ölçekte korunuyor (Seedream sınırı: 1024–2048 px).
    image_size: { width: 1536, height: 2048 },
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
