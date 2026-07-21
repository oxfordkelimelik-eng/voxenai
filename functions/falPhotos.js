const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const { GEMINI_KEY } = require("./identityCaption");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
// Üretim modeli: GPT Image 2 (edit, orta kalite) — 4 model bakeoff testinde
// (nano-banana-pro, nano-banana, seedream-v4.5, gpt-image-2) en doğal/en az
// yapay sonucu bu verdi; ana akışa buradan geçirildi.
//
// MODEL GEÇMİŞİ (aynı hatayı tekrarlamamak için):
//  1) nano-banana-2/edit  → arka planlar gerçekçi değildi.
//  2) flux-pulid          → yüzü embedding'den SIFIRDAN sentezlediği için
//     plastik görünüm; id_weight sahneyi ezdiğinden arka plan hiç oluşmuyordu.
//  3) seedream/v5/pro/edit→ arka plan oluştu ama "kişi ön planda, arka plan
//     arkada" katmanlı/yapıştırma hissi sürdü.
//  4) nano-banana-pro/edit → gerçekçilik odaklıydı ama bakeoff'ta gpt-image-2
//     kadar doğal bulunmadı ($0.15/foto, en pahalısıydı).
//  5) openai/gpt-image-2/edit (orta kalite, şu an) → bakeoff'ta beğenildi,
//     ayrıca $0.061/foto ile nano-banana-pro'dan ucuz.
//
// ÖNEMLİ SINIR: bunların hepsi "edit" ailesidir ve kişiyi korunacak bir nesne
// olarak ele alır — bu yüzden bir miktar katman/yapıştırma hissi yapısaldır.
// Bunu kökten çözmenin yolu kullanıcıya özel LoRA eğitimidir (kişi sahneyle
// birlikte sıfırdan üretilir); maliyet/bekleme nedeniyle şimdilik seçilmedi.
const GEN_MODEL = "openai/gpt-image-2/edit";
// Stil başına üretilecek foto. Her biri FARKLI bir sahne varyantıdır (bkz.
// STYLE_SCENES) — aynı sahnenin 5 kopyası değil, 5 ayrı gerçek ortam.
const IMAGES_PER_STYLE = 5; // DatingConfig.photosPerSet ile senkron (ödenen vaat)
// Kullanıcıdan istenen referans: 3 canlı yüz (ön/sağ/sol) + 1 zorunlu tam boy.
const REFERENCE_PHOTO_COUNT = 4;
const FACE_PHOTO_COUNT = 3;
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
    "Leaning on one forearm at the marble counter of a dimly lit restaurant bar, holding a glass of wine, laughing at something just out of frame. Behind: backlit shelves of bottles, low pendant lights, a bartender clearly visible mid-motion",
    "Crossing a European city street under flat overcast daylight in a tailored camel coat, hands in pockets, calm and unposed, looking slightly away from the lens. Behind: shopfronts and passers-by, all clearly visible and in sharp focus, grey even light",
    "Standing at the railing of a rooftop terrace at dusk in a light grey suit with the collar open, one hand resting on the rail, easy natural smile. Behind: glass towers with lit windows against a deep blue evening sky",
    "Pausing in a quiet art gallery, hands in pockets, head turned to study a painting with a thoughtful expression, wearing a fine black turtleneck. Behind: white walls, large framed artworks, soft even ceiling light",
  ],
  athletic: [
    "Resting between sets on a gym bench, forearms on knees, catching breath and looking up with a slight grin, wearing a fitted training t-shirt damp with sweat. Behind: racks of weights, mirrors and machines under natural overhead light",
    "Mid-stride on an outdoor running track under flat grey morning light, breath visible in cool air, focused expression, wearing technical running gear. Behind: empty stadium seating under an overcast sky",
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
    "At the counter of a dim cocktail bar, turning toward the camera mid-laugh with a drink in hand, wearing a dark shirt with the top button open. Behind: warm amber light, bottles on shelves and glowing pendant lamps, all clearly visible",
    "On a rooftop bar at night, leaning back against the railing with a relaxed grin, wearing a well-fitted jacket. Behind: a wide spread of city lights and a dark skyline, sharp and clearly visible",
    "Walking a neon-lit street at night, hands in jacket pockets, glancing sideways with a half-smile, wearing a leather jacket. Behind: glowing signs reflected in wet pavement and passing headlights, all in sharp focus",
    "At a busy restaurant table, mid-conversation and gesturing with one hand, genuine laughter, wearing a casual button-up. Behind: warm string lights, other diners clearly visible and candles on tables",
    "Standing outside a venue at night under a street lamp, checking a phone then looking up, smart casual outfit. Behind: a brick wall, warm light spill from a doorway and passing traffic, all clearly visible",
  ],
  beach: [
    "Standing barefoot on wet sand under bright midday sun, an open linen shirt catching the breeze, looking out toward the water with a calm smile. Behind: breaking waves and a long empty shoreline, clear and sharp",
    "Walking out of the shallows, running a hand back through wet hair, laughing, wearing swim shorts. Behind: bright midday sea, foam and sunlit water",
    "Sitting on weathered wooden beach steps with forearms on knees, relaxed and looking off to the side, wearing a light shirt, under flat overcast beach light. Behind: palm fronds and dune grass under a grey sky",
    "Leaning on the bamboo counter of a thatched beach bar with a cold drink, mid-conversation, wearing a casual short-sleeve shirt. Behind: the open sea framed by the bar's roof and hanging lights",
    "Standing on dark coastal rocks with a plain t-shirt, arms loose, watching the swell with an unguarded expression. Behind: sea spray, deep blue water and a clean horizon under natural daylight",
  ],
  car: [
    "Standing beside a dark luxury sedan on a city street in the evening, one hand on the roof, turning toward the camera with a relaxed expression, wearing a smart jacket. Behind: warm street lighting, shopfronts and passing traffic, all clearly visible and in sharp focus",
    "Leaning back against the front of a sports car in an underground car park, arms loosely crossed, calm and direct, wearing a dark jacket. Behind: concrete pillars and dramatic overhead lighting pooling on the floor",
    "Standing at the open door of a car parked on a mountain road, one foot on the sill, looking out at the view then back to the lens. Behind: a sweeping valley, winding road and clear bright daylight",
    "Mid-motion closing a car door outside a modern glass building in daytime, glancing up with an easy smile, wearing a well-fitted coat. Behind: reflective glass, city reflections and clean daylight",
    "Sitting on the sill of an open car door at a scenic overlook under flat midday light, elbows on knees, quietly taking in the view. Behind: a wide landscape under a plain bright sky",
  ],
};

// Chunk index (0-4) -> kompozisyon tarifi. Stil FARK ETMEKSİZİN her stildeki
// 5 foto bu 5 kompozisyonu kullanır — böylece bir setin fotoğrafları birbirinin
// aynı "stüdyo portresi" formülünün kopyaları değil, gerçek bir telefon
// galerisindeki gibi ÇEŞİTLİ kadraj/mesafe/bulanıklık taşır (bazısı yakın ve
// arka plan bulanık, bazısı geniş ve her şey net, bazısı ön planda bir nesne
// var vb.). Bu, "hepsi aynı formülde" görünüp set hâlinde yapay durma
// sorununu hedefler.
// HİÇBİR kompozisyonda arka plan bulanıklaştırılmaz — hepsi baştan sona NET.
// Çeşitlilik yalnızca kadraj/mesafe/açıdan gelir (blur'dan değil).
const COMPOSITIONS = [
  // 0: Yakın omuz üstü — arka plan yine net/okunur.
  "Tight head-and-shoulders framing, the subject fills most of the frame, the background " +
  "stays fully sharp and clearly visible behind them (like a phone camera's deep focus, no " +
  "background blur at all).",
  // 1: Bel boyu, hafif merkez dışı, arka plan net.
  "Waist-up framing, the subject positioned slightly off-centre, the background sharp and " +
  "clearly readable — every shape, colour and detail behind them stays in focus.",
  // 2: Geniş/tam boy, kişi küçük, sahne baskın, tamamen net — "ortam fotoğrafı".
  "Wide environmental shot where the subject is a smaller element within the frame rather than " +
  "filling it — the whole scene stays in sharp focus from near to far, the location itself is " +
  "as much the subject as the person.",
  // 3: Orta mesafe, kenarda, kadrajın önünde bir şey var — o da net.
  "Medium-distance shot, the subject positioned toward one side of the frame with open space on " +
  "the other side, something genuinely sits in the near foreground (a railing, a plant, a " +
  "doorway, a shoulder) and is JUST as sharp and in focus as the subject and the background.",
  // 4: Gündelik, hafif eğik açı — arka plan yine net.
  "Casual close-range framing from a slightly informal handheld angle, as if a friend quickly " +
  "raised their phone — not perfectly centred or level, but the background stays fully sharp " +
  "and clearly visible, no blur.",
];

/**
 * Edit modeline verilen tam talimat. ÖNCELİK SIRASI bilinçli: model uzun
 * prompt'larda önce gelen ve en çok tekrar eden talimata ağırlık veriyor.
 * Bu yüzden SAHNE en başta ve en vurgulu; kimlik kısıtı kısa ama kesin;
 * "bütünleşme" tek cümleye indirildi (önceki sürümde uzun bir bütünleşme/
 * derinlik bloğu vardı — modele yüzü "yeniden yorumlama" lisansı verip hem
 * kimlik kaymasına hem de sahnenin gölgede kalıp alakasız arka plan
 * üretilmesine yol açtı; SCENE ile rekabet eden metin azaltıldı).
 *
 * variantIdx AYNI ZAMANDA kompozisyonu seçer (bkz. COMPOSITIONS) — sahne
 * içeriği stile göre, kompozisyon (yalnızca kadraj/mesafe/açı — ASLA blur)
 * chunk index'e göre değişir. Böylece 5 foto hem farklı ortamlarda hem farklı
 * çekim tarzlarında, ama arka plan HER ZAMAN net.
 *
 * identityCaption (opsiyonel): Gemini Flash'in referans fotoğraflara bakıp
 * çıkardığı kısa fiziksel tarif (bkz. identityCaption.js). Görsel + metin
 * sinyali hizalandığında kimlik sadakati ölçülebilir artıyor; ayrıca modelin
 * "cildi aç/yaşı küçült" varsayılan eğilimini yazılı ten tonu/yaş bastırıyor.
 * null ise (Gemini çağrısı başarısız olduysa) bu cümle sessizce atlanır.
 */
// Form alanları (boy/vücut tipi) → kısa İngilizce ipucu. Fotoğraf ÇAKIŞIRSA
// fotoğraf kazanır — bu metin yalnızca tamamlayıcıdır.
const BODY_TYPE_HINTS = {
  slim: "slim / lean build",
  athletic: "athletic / sporty build",
  average: "average build",
  solid: "solid / fuller build",
};
const HEIGHT_HINTS = {
  under160: "under 160 cm",
  "160-165": "about 160–165 cm",
  "165-170": "about 165–170 cm",
  "170-175": "about 170–175 cm",
  "175-180": "about 175–180 cm",
  "180-185": "about 180–185 cm",
  "185-190": "about 185–190 cm",
  "190+": "190 cm or taller",
};

function bodyProfileHint(bodyProfile) {
  if (!bodyProfile || typeof bodyProfile !== "object") return "";
  const parts = [];
  const bt = BODY_TYPE_HINTS[bodyProfile.bodyType];
  const ht = HEIGHT_HINTS[bodyProfile.heightRange];
  if (bt) parts.push(bt);
  if (ht) parts.push(ht);
  if (parts.length === 0) return "";
  return (
    "SECONDARY BODY CUE (form answers — use only to fill gaps; if the full-body " +
    "reference photo contradicts this, ALWAYS trust the photo, never idealise or " +
    "reshape the body to match the form): " + parts.join(", ") + ".\n\n"
  );
}

function buildPrompt(styleId, variantIdx, identityCaption, bodyProfile, extras = {}) {
  const variants = STYLE_SCENES[styleId];
  const scene = variants[variantIdx % variants.length];
  const composition = COMPOSITIONS[variantIdx % COMPOSITIONS.length];
  const bodyCaption = extras.bodyCaption || null;
  const wardrobeNote = extras.wardrobeNote || null;

  let bodyBlock = "";
  if (bodyCaption) {
    bodyBlock +=
      "BODY FROM FULL-BODY REFERENCE (primary — match this build, do not idealise): " +
      bodyCaption + "\n\n";
  }
  bodyBlock += bodyProfileHint(bodyProfile);

  let wardrobeBlock = "";
  if (wardrobeNote) {
    wardrobeBlock =
      "WARDROBE / VIBE for this style (keep natural and wearable for THIS person; " +
      "do not turn into a fashion editorial): " + wardrobeNote + "\n\n";
  }

  return (
    "Photograph this EXACT scene, precisely as described — do not simplify, generalise or substitute " +
    "any part of it: " + scene + ".\n\n" +
    "The person in the reference images must be placed into this scene, fully recognisable: same face " +
    "shape, bone structure, eyes, nose, mouth, jawline, hairline, skin tone and age as the references. " +
    (identityCaption ? `Specifically, this person: ${identityCaption} ` : "") +
    "Do not reshape or reinterpret their face, and do not lighten their skin or make them look younger " +
    "than the references. Their skin tone must be perfectly consistent across face, neck, hands and any " +
    "other visible skin — no colour or tone shift between face and body, as if lit by the same light. " +
    "Match body proportions, shoulder width and overall build to the full-body reference photo when it " +
    "is present — do not invent a fitter, taller or differently shaped body.\n\n" +
    "EXPRESSION: look at the person's actual resting expression in the reference photos and preserve " +
    "it. If they are not smiling in the references, do NOT force a smile, grin or laugh onto them even " +
    "if the scene text above describes one — a neutral, calm or naturally reserved expression is " +
    "correct if that is what the references show. Only give them a smile if they are already smiling " +
    "in some of the reference photos.\n\n" +
    "GAZE: both eyes must look in the SAME, coherent direction, consistent with the described pose — " +
    "never cross-eyed, misaligned, wall-eyed or wandering, and never one eye looking at the camera " +
    "while the other looks elsewhere. If the scene has them looking at the camera/lens, both eyes " +
    "converge naturally on it; if looking away, at an object, or off-frame, both eyes point together " +
    "in that same direction with a natural, believable gaze — never a blank, unfocused or dead-eyed " +
    "stare.\n\n" +
    "PROPORTIONS: the head must be a REALISTIC, anatomically correct size relative to the rest of the " +
    "body — on a normal adult, the head is roughly one-seventh to one-eighth of their total standing " +
    "height, and shoulder width is roughly two to three head-widths. One of the reference photos is a " +
    "tightly cropped close-up of the face for identity detail only — do NOT use that crop's zoom level " +
    "or framing as a scale reference, and do NOT enlarge the head to match it. Scale the head strictly " +
    "against the body proportions shown in the full-body reference photo; the head must never look " +
    "oversized, bobble-headed or disproportionate to the shoulders and body in the final image.\n\n" +
    bodyBlock +
    wardrobeBlock +
    "Match the lighting, shadows and colour temperature on their face and clothes to the scene's own " +
    "light source so they look genuinely PRESENT in that place — not a cut-out pasted onto a backdrop " +
    "— but the scene and its exact setting described above always take priority over any other " +
    "consideration.\n\n" +
    "FRAMING: " + composition + " The environment must stay clearly visible, detailed and identifiable " +
    "around them — never a blank or plain backdrop. This is an ordinary phone photo, not an artistic " +
    "portrait-mode shot, so avoid any heavy, artistic background blur or bokeh that hides the location. " +
    "But do NOT force an unnatural, uniform, forensic sharpness across the whole frame either — the " +
    "background must look like a REAL place with real depth (foreground, midground, distance), with " +
    "the same kind of natural, ordinary depth and light falloff a real phone camera produces, never a " +
    "flat backdrop or a cutout pasted behind the subject.\n\n" +
    "CRAFT: this is a candid photo taken by a friend on an ordinary phone and posted to Instagram — " +
    "unremarkable, a little imperfectly framed, NOT a professional or editorial photoshoot. Keep the " +
    "person's skin natural and non-airbrushed (do not smooth, beautify or plasticise it) but do NOT " +
    "invent blemishes, spots, uneven tone or facial asymmetry that isn't already visible in the " +
    "reference photos — the face should look like a normal, unedited phone photo of THIS exact person, " +
    "not an exaggerated or distressed version of them. Other natural, non-facial imperfections are " +
    "welcome: flyaway hairs out of place, a slightly unposed or off-guard expression, a little sensor " +
    "noise/grain in shadow areas, realistic fabric creases, the top of the head slightly cropped or the " +
    "subject not quite centred, a faintly tilted horizon. Natural available light with realistic, " +
    "sometimes slightly mixed colour temperature, true-to-life (not boosted) colour and contrast.\n\n" +
    "AVOID: airbrushed or plastic skin, beauty-filter smoothing, studio-perfect lighting, oversaturated " +
    "or HDR colour, CGI/3D-render look, a symmetrical or idealised AI face, exaggerated skin blemishes " +
    "or facial asymmetry not present in the references, artificially enlarged, brightened, lightened or " +
    "overly symmetrical eyes (\"anime eye\" look) — eye size, shape and colour must match the reference " +
    "photos exactly, misaligned or wandering eye gaze, a forced smile or expression not present in the " +
    "references, a stiff posed mannequin stance, heavy artistic background blur/bokeh that hides the " +
    "location, a flat/fake-looking backdrop with no real depth, a perfectly clean/curated backdrop, " +
    "professional editorial photography look, text, watermark, distorted hands."
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
    const [raw] = await file.download();

    // EXIF Orientation'ı piksellere uygula — fal/yüz kapısı yan-ters
    // referans görmesin (bkz. postProcess.normalizeExifOrientation).
    const { normalizeExifOrientation } = require("./postProcess");
    const buf = await normalizeExifOrientation(raw);

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
 * Kullanıcının TÜM referans fotoğrafları (yüz-crop dahil 4 adet) image_urls
 * ile gönderilir — model kişiyi birden fazla açıdan gördüğü için kimlik
 * sadakati artar. identityCaption -> buildPrompt'a geçilir (bkz. orada).
 */
async function submitStyleJob(
  uid, jobId, styleId, chunkIdx, referenceImageUrls, seed,
  identityCaption, bodyProfile, promptExtras = {}
) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}&chunk=${chunkIdx}`;
  const input = {
    prompt: buildPrompt(styleId, chunkIdx, identityCaption, bodyProfile, {
      bodyCaption: promptExtras.bodyCaption || null,
      wardrobeNote: promptExtras.wardrobeNote || null,
    }),
    image_urls: referenceImageUrls,
    // GPT Image 2 GERÇEK şeması (fal.ai resmi dokümantasyonu doğrulandı):
    // aspect_ratio/resolution/safety_tolerance YOK — image_size (obje/preset),
    // quality, num_images, output_format var. Önceki sürümde yanlışlıkla
    // "size" (string) kullanılmıştı — bu isim şemada YOK, muhtemelen sessizce
    // yok sayılıp varsayılana (image_size: auto, quality: high) düşüyordu.
    //
    // image_size PRESET (özel {width,height} DEĞİL): modelin kendi native
    // çözünürlük kovalarından biri — rastgele bir özel boyut (ör. 768x1024)
    // modelin optimize olmadığı bir noktayı zorlayıp ince artefaktlara yol
    // açabilir; preset hem doğru dikey (3:4) oranı hem muhtemelen daha
    // yüksek/daha "doğru" bir çözünürlüğü garantiler.
    image_size: "portrait_4_3", // dikey dating fotoğrafı için en yakın preset
    quality: "medium", // istenen kalite katmanı ($0.061/foto) — artık GERÇEKTEN uygulanıyor
    num_images: 1,
    output_format: "jpeg",
    seed,
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
 * ADIM 1/2 — DOĞRULAMA. Kullanıcı 3 referans selfie'sini Storage'a yükledikten
 * sonra, HENÜZ HİÇBİR KREDİ/BAKİYE HARCANMADAN ve fal.ai'ye hiçbir üretim işi
 * gönderilmeden çağrılır. Fotoğrafla ilgili TÜM kapılar burada çalışır:
 *   - +18/uygunsuz içerik (Cloud Vision SafeSearch)
 *   - net/tek yüz kapısı + en iyi referans seçimi + kaynak kimlik vektörü
 *     (ssd_mobilenetv1 tespit + landmark68 + recognition — bkz. faceQuality.js)
 * Buradan bir HttpsError dönerse client hâlâ fotoğraf seçme ekranındadır ve
 * kullanıcı ilgili fotoğrafı değiştirir. Bu fonksiyon BAŞARIYLA dönerse
 * fotoğraf kaynaklı hiçbir uyarı kalmaz — client ancak o zaman üretim
 * loader'ını başlatır ve startPhotoGeneration'ı çağırır.
 *
 * Başarılıysa işi 'ready' durumunda hazırlar: fal referans URL'leri (+ yüz-
 * merkezli kırpılmış bir ek referans, en başta), kaynak kimlik vektörü
 * (refDescriptor) ve kısa bir kimlik tarifi (identityCaption — bkz.
 * identityCaption.js) dokümana yazılır; referans selfie'ler Storage'dan
 * silinir (KVKK — biyometrik veri geride bırakılmaz, yalnızca türetilmiş
 * 128 sayılık vektör ve birkaç cümlelik metin tutulur).
 *
 * data: { jobId: string } -> { ok: true }
 */
exports.prepareReferencePhotos = onCall(
  // Tespit + landmark + recognition (3 model) yükleniyor — bkz. faceQuality.js.
  // Bu üçü birlikte önceki bir sürümde de 2GiB gerektirmişti (1GiB'de model +
  // selfie tensörleriyle OOM oluyordu). minInstances:1 ile soğuk başlangıç
  // (model yeniden yükleme) gecikmesi ortadan kaldırıldı.
  {
    secrets: [FAL_KEY, GEMINI_KEY],
    region: "europe-west1",
    memory: "2GiB",
    // Gemini kimlik + beden + wardrobe paralel; soğuk başlangıçta 120 sn yetmeyebilir.
    timeoutSeconds: 180,
    minInstances: 1,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { jobId, bodyProfile, styles: prepStyles } = request.data || {};
    if (!jobId) {
      throw new HttpsError("invalid-argument", "jobId zorunlu.");
    }
    // Formdan gelen boy/vücut tipi — prompt'ta ikincil ipucu (foto öncelikli).
    const safeBodyProfile = (bodyProfile && typeof bodyProfile === "object")
      ? {
          heightRange: typeof bodyProfile.heightRange === "string" ? bodyProfile.heightRange : null,
          bodyType: typeof bodyProfile.bodyType === "string" ? bodyProfile.bodyType : null,
          gender: typeof bodyProfile.gender === "string" ? bodyProfile.gender : null,
        }
      : null;
    // Wardrobe notları için seçilen stiller (opsiyonel; yoksa atlanır).
    const stylesForWardrobe = Array.isArray(prepStyles)
      ? prepStyles.filter((s) => typeof s === "string" && STYLE_SCENES[s])
      : [];

    // Referansları indir (+ içerik moderasyonu, bkz. uploadReferencePhotos) ve
    // fal'a yükle. Buradaki HttpsError doğrudan kullanıcıya gider.
    const { urls: refUrls, buffers: refBuffers } = await uploadReferencePhotos(uid, jobId);

    // Net/tek yüz kapısı (+ bulanıklık/aşırı pozlama) + en iyi referansın
    // öne alınması + kaynak kimlik vektörü. Fail-safe: kontrolün KENDİSİ
    // (tfjs/tespit) hata verirse üretim bloklanmaz, sıra olduğu gibi kalır ve
    // refDescriptor null bırakılır (o durumda falInferenceWebhook'taki kimlik
    // kapısı da devre dışı kalır).
    let orderedRefUrls = refUrls;
    let refDescriptor = null;
    let faceCropUrl = null;
    try {
      const { analyzeReferences } = require("./faceQuality");
      const analysis = await analyzeReferences(refBuffers, {
        facePhotoCount: Math.min(FACE_PHOTO_COUNT, refBuffers.length),
      });
      // Fotoğraf sırası (0-tabanlı) client'a 1-tabanlı sıra no olarak gösterilir.
      const posLabel = (indices) => {
        const positions = indices.map((i) => i + 1);
        const many = positions.length > 1;
        const label = many
          ? `${positions.slice(0, -1).join(", ")}. ve ${positions[positions.length - 1]}. fotoğraflar`
          : `${positions[0]}. fotoğraf`;
        return { label, many };
      };
      if (analysis.unclearIndices.length > 0) {
        const { label, many } = posLabel(analysis.unclearIndices);
        throw new HttpsError(
          "invalid-argument",
          `${label} net değil, bulanık ya da aşırı pozlanmış olabilir. Lütfen ` +
          `${many ? "bunları" : "bunu"} net, iyi aydınlatılmış, tek kişinin ` +
          "göründüğü selfie ile değiştirip tekrar dene.",
          { unclearPhotoIndices: analysis.unclearIndices }
        );
      }
      // Tam boy karesinde gövde görünmüyor (yakın selfie gönderilmiş).
      if (analysis.notFullBodyIndices && analysis.notFullBodyIndices.length > 0) {
        const { label, many } = posLabel(analysis.notFullBodyIndices);
        throw new HttpsError(
          "invalid-argument",
          `${label} tam boy değil — yüz çok yakın, gövden görünmüyor. Lütfen ` +
          `baştan (en azından belden) aşağısı kadrajda olan, gövdeni gösteren ` +
          `bir fotoğraf ${many ? "bunlarla" : "bununla"} değiştir.`,
          { notFullBodyPhotoIndices: analysis.notFullBodyIndices }
        );
      }
      // İki yüz karesi neredeyse aynı açıda — farklı açı iste.
      if (analysis.duplicateIndices && analysis.duplicateIndices.length > 0) {
        const { label, many } = posLabel(analysis.duplicateIndices);
        throw new HttpsError(
          "invalid-argument",
          `${label} başka bir kareyle neredeyse aynı açıda görünüyor. Daha iyi ` +
          `sonuç için ${many ? "bunları" : "bunu"} farklı bir açıdan (ör. hafif ` +
          `yana dönük) çekip tekrar dene.`,
          { duplicatePhotoIndices: analysis.duplicateIndices }
        );
      }
      if (analysis.bestIndex != null && refUrls[analysis.bestIndex]) {
        const best = refUrls[analysis.bestIndex];
        orderedRefUrls = [best, ...refUrls.filter((u) => u !== best)];
      }
      if (analysis.refDescriptor) {
        refDescriptor = Array.from(analysis.refDescriptor); // Firestore için düz dizi
      }
      // Yüz-merkezli kırpılmış ek referans: en net/en büyük yüzlü fotoğraftan,
      // yüzü kadrajın baskın öğesi yapan yüksek-çözünürlüklü bir crop üretip
      // referans listesinin EN BAŞINA ekle (bkz. postProcess.cropFaceRegion).
      // Edit modellerinde referansın efektif yüz çözünürlüğü kimlik
      // sadakatiyle doğrudan orantılı. Fail-safe: crop üretilemezse atlanır.
      if (analysis.bestIndex != null && analysis.bestBox) {
        try {
          const { cropFaceRegion } = require("./postProcess");
          const cropBuf = await cropFaceRegion(refBuffers[analysis.bestIndex], analysis.bestBox);
          if (cropBuf) {
            faceCropUrl = await uploadToFalStorage(cropBuf, "ref_face_crop.jpg");
          }
        } catch (e) {
          console.error("Yüz crop referansı yüklenemedi (atlanıyor):", e);
        }
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("Yüz kontrolü başarısız (kimlik kapısı devre dışı, üretim engellenmiyor):", e);
    }
    if (faceCropUrl) {
      orderedRefUrls = [faceCropUrl, ...orderedRefUrls];
    }

    // Gemini ön-işlem (paralel, fail-safe): kimlik + tam boy beden + stil wardrobe.
    let identityCaption = null;
    let bodyCaption = null;
    let styleWardrobes = {};
    try {
      const {
        describeIdentity,
        describeBodyBuild,
        describeStyleWardrobes,
      } = require("./identityCaption");
      const faceBuffers = refBuffers.slice(0, FACE_PHOTO_COUNT);
      const bodyBuffer = refBuffers.length > FACE_PHOTO_COUNT
        ? refBuffers[refBuffers.length - 1]
        : null;
      const [idCap, bodyCap, wardrobes] = await Promise.all([
        describeIdentity(faceBuffers.length ? faceBuffers : refBuffers),
        describeBodyBuild(bodyBuffer),
        stylesForWardrobe.length
          ? describeStyleWardrobes(refBuffers, stylesForWardrobe)
          : Promise.resolve({}),
      ]);
      identityCaption = idCap;
      bodyCaption = bodyCap;
      styleWardrobes = wardrobes || {};
    } catch (e) {
      console.error("Gemini ön-işlem başarısız (caption'sız devam):", e);
    }

    // Tüm kapılar geçildi — işi 'ready' olarak hazırla. Bakiye HENÜZ düşülmez;
    // o startPhotoGeneration'ın (adım 2/2) işi.
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
    await jobRef.set({
      status: "ready",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      errorMessage: null,
      // Yüz crop'u (varsa) en başta, ardından en net orijinal — bkz. submitStyleJob.
      falRefUrls: orderedRefUrls,
      ...(refDescriptor ? { refDescriptor } : {}),
      ...(identityCaption ? { identityCaption } : {}),
      ...(bodyCaption ? { bodyCaption } : {}),
      ...(Object.keys(styleWardrobes).length ? { styleWardrobes } : {}),
      ...(safeBodyProfile ? { bodyProfile: safeBodyProfile } : {}),
    });

    // Form beden profilini kullanıcıya özel sakla (sonraki üretimler / analitik).
    if (safeBodyProfile) {
      await db.doc(`users/${uid}/private/datingProfile`).set({
        ...safeBodyProfile,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

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
    const prepData = prepSnap.data();
    const identityCaption = prepData.identityCaption || null;
    const bodyProfile = prepData.bodyProfile || null;
    const bodyCaption = prepData.bodyCaption || null;
    const styleWardrobes = prepData.styleWardrobes || {};

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

      // merge — prepareReferencePhotos'un yazdığı falRefUrls/refDescriptor/
      // identityCaption korunur.
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
      // Stiller + chunk'lar paralel (4 stil × 5 = 20 fal işi tek turda).
      await Promise.all(styles.map(async (styleId) => {
        const submissions = await Promise.all(
          Array.from({ length: IMAGES_PER_STYLE }, async (_, i) => {
            const seed = Math.floor(Math.random() * 2147483647);
            const falJob = await submitStyleJob(
              uid, jobId, styleId, i, refUrls, seed, identityCaption, bodyProfile, {
                bodyCaption,
                wardrobeNote: styleWardrobes[styleId] || null,
              }
            );
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
        await jobRef.set({
          results: { [styleId]: { status: "pending", photoUrls: [], chunks } },
        }, { merge: true });
      }));
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
 * çağrılır. Çıktıyı indirir, KİMLİK KAPISINDAN geçirir (job.refDescriptor ile
 * karşılaştırma — bkz. faceQuality.matchesIdentity), geçemezse chunk'ı
 * otomatik yeniden üretir. Geçenlere hafif post-processing (film grain +
 * gerçekçi JPEG sıkıştırma, bkz. postProcess.js) uygulanıp Storage'a yazılır.
 * Bir stilin TÜM chunk'ları bitince sonuçlar birleştirilir (bkz. finalizeChunk).
 */
exports.falInferenceWebhook = onRequest(
  {
    secrets: [FAL_KEY], // otomatik yeniden üretim fal'a yeni iş gönderiyor
    region: "europe-west1",
    // Kimlik kapısı için tespit+landmark+recognition (3 model) yükleniyor —
    // bkz. faceQuality.js. Bu kombinasyon önceki bir sürümde de 2GiB
    // gerektirmişti (1GiB'de OOM). sharp (post-processing) hafif.
    memory: "2GiB",
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

    // KİMLİK KAPISI: her chunk tam olarak 1 görsel ürettiği için ("num_images:1"),
    // bu görselin yüzü kaynak selfie'lere (job.refDescriptor) yeterince
    // benzemiyorsa, o görseli KULLANICIYA HİÇ GÖSTERMEDEN chunk'ı yeniden
    // üretmeyi dene (bkz. faceQuality.matchesIdentity, maybeRetryChunk).
    // Fail-safe: refDescriptor yoksa (prepareReferencePhotos'ta hesaplanamadıysa)
    // ya da kontrolün kendisi hata verirse, filtre uygulanmaz — üretim asla
    // bu ikincil kapı yüzünden bloklanmaz.
    let passed = downloaded;
    if (job.refDescriptor) {
      try {
        const { matchesIdentity } = require("./faceQuality");
        const checked = await Promise.all(downloaded.map(async (d) => {
          const { match, distance } = await matchesIdentity(d.buf, job.refDescriptor);
          return { ...d, match, distance };
        }));
        passed = checked.filter((d) => d.match);
        if (passed.length < checked.length) {
          console.warn(`Kimlik kapısı elendi (style=${styleId}, chunk=${chunkIdx}): ` +
            checked.map((d) => `${d.match ? "OK" : "RED"}(${d.distance?.toFixed(3)})`).join(", "));
        }
      } catch (e) {
        console.error("Kimlik kontrolü başarısız (filtresiz devam ediliyor):", e);
        passed = downloaded;
      }
    }

    if (passed.length === 0) {
      // Bu görsel(ler) kimlik eşiğini geçemedi — retry hakkı varsa yeni bir
      // seed ile aynı sahne/kompozisyonu tekrar dene. Kullanıcı bunu asla
      // görmez (finalizeChunk'a hiç gitmiyor).
      if (await maybeRetryChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor (kimlik eşiği)");
        return;
      }
      // Retry hakkı bitti — bu chunk'ı başarısız say (diğer chunk'lar/stiller
      // etkilenmez, kısmi başarı mekanizması zaten var).
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // POST-PROCESSING: hafif film grain + gerçekçi JPEG sıkıştırma (bkz.
    // postProcess.js) — AI çıktısına özgü "çok temiz" hissi kırar. Fail-safe:
    // bir görselde hata olursa o görsel orijinal haliyle kaydedilir.
    let photoUrls = [];
    try {
      const { addPhoneCameraTexture } = require("./postProcess");
      photoUrls = await Promise.all(passed.map(async ({ i, buf }) => {
        const textured = await addPhoneCameraTexture(buf);
        // chunkIdx dosya adına eklenir — aksi halde farklı chunk'ların aynı
        // "i" indeksli görselleri birbirinin üstüne yazardı.
        const path = `dating_results/${uid}/${jobId}/${styleId}_${chunkIdx}_${i}.jpg`;
        await bucket().file(path).save(textured, { metadata: { contentType: "image/jpeg" } });
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
    const falJob = await submitStyleJob(
      uid, jobId, styleId, chunkIdx, refUrls, seed,
      job.identityCaption || null, job.bodyProfile || null, {
        bodyCaption: job.bodyCaption || null,
        wardrobeNote: (job.styleWardrobes && job.styleWardrobes[styleId]) || null,
      }
    );
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
        // En olası neden: üretilen görseller kaynak selfie'lerle kimlik eşleşme
        // eşiğini (bkz. faceQuality.FACE_MATCH_THRESHOLD) tutturamadı ve tüm
        // retry hakları tükendi (bkz. maybeRetryChunk çağrıları). Teorik olarak
        // fal API hatası/moderasyon reddi de aynı "tüm chunk'lar failed" sonucuna
        // yol açabilir — gerçek sebep her zaman Cloud Functions loglarında
        // (falInferenceWebhook console.error/console.warn satırları) görünür.
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
