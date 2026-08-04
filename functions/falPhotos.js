const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const { GEMINI_KEY } = require("./identityCaption");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_QUEUE_BASE = "https://queue.fal.run";
// Senkron (webhook'suz) fal endpoint — face swap için (kısa iş, webhook içinde
// bloklamak sorun değil).
const FAL_SYNC_BASE = "https://fal.run";
// FACE SWAP modeli. İKİ AŞAMALI ÜRETİM'in 2. aşaması: GEN_MODEL sahneyi + kişiyi
// üretir, sonra bu model kullanıcının GERÇEK yüzünü o sahnenin üstüne yerleştirir
// — böylece kimlik/göz/ifade sorunları yapısal olarak çözülür (model yüzü sıfırdan
// sentezlemez, gerçek yüz piksellerini kullanır).
// NOT: fal bu endpoint'i "deprecated" işaretledi ama hâlâ çağrılabilir ($0.05).
// Kaldırılırsa buradan Segmind faceswap-v4 gibi bir alternatife geçilebilir.
// DAVRANIŞ: swap başarısız olursa görsel HAM haliyle KULLANILMAZ — kimlik
// kapısını geçemeyen görsel gibi elenir, retry hakkı varsa tekrar denenir,
// yoksa chunk/stil başarısız sayılıp paket kredisi otomatik iade edilir
// (bkz. falInferenceWebhook + finalizeChunk). Kullanıcı asla kendi yüzü
// olmayan bir fotoğraf görmez.
const FACE_SWAP_MODEL = "easel-ai/advanced-face-swap";
// Üretim modeli: Nano Banana Pro (edit) — GPT Image 2 denemesi geri alındı
// (bkz. MODEL GEÇMİŞİ madde 6): "auto" image_size ile bile netlik/arka plan/
// göz sorunları düzelmedi, nano-banana-pro'ya geri dönüldü.
//
// MODEL GEÇMİŞİ (aynı hatayı tekrarlamamak için):
//  1) nano-banana-2/edit  → arka planlar gerçekçi değildi.
//  2) flux-pulid          → yüzü embedding'den SIFIRDAN sentezlediği için
//     plastik görünüm; id_weight sahneyi ezdiğinden arka plan hiç oluşmuyordu.
//  3) seedream/v5/pro/edit→ arka plan oluştu ama "kişi ön planda, arka plan
//     arkada" katmanlı/yapıştırma hissi sürdü.
//  4) nano-banana-pro/edit → gerçekçilik odaklı, bakeoff'ta iyi ama gpt-image-2
//     kadar doğal bulunmamıştı ($0.15/foto, en pahalısı).
//  5) openai/gpt-image-2/edit → bakeoff'ta (yanlışlıkla auto'ya düşen eski
//     şemayla) beğenilmişti; ana akışta doğru şema + "portrait_4_3" preset'iyle
//     test edilince netlik/arka plan/göz bozuldu; "auto"ya dönülünce de DÜZELMEDİ.
//  6) nano-banana-pro/edit (şu an, GERİ DÖNÜŞ) → GPT Image 2 canlı akışta genel
//     olarak tatmin etmedi, madde 4'teki modele geri dönüldü.
//
// ÖNEMLİ SINIR: bunların hepsi "edit" ailesidir ve kişiyi korunacak bir nesne
// olarak ele alır — bu yüzden bir miktar katman/yapıştırma hissi yapısaldır.
// Bunu kökten çözmenin yolu kullanıcıya özel LoRA eğitimidir (kişi sahneyle
// birlikte sıfırdan üretilir); maliyet/bekleme nedeniyle şimdilik seçilmedi.
const GEN_MODEL = "fal-ai/nano-banana-pro/edit";

// Desteklenen fal.ai üretim modelleri — client startPhotoGeneration'a "model"
// alanıyla hangisini seçtiğini bildirir (bkz. exports.startPhotoGeneration).
const MODEL_CATALOG = {
  "nano-banana-pro": {
    endpoint: GEN_MODEL,
    buildInput: (prompt, imageUrls, seed) => ({
      prompt,
      image_urls: imageUrls,
      aspect_ratio: "3:4",
      resolution: "1K",
      num_images: 1,
      output_format: "jpeg",
      seed,
      safety_tolerance: "4",
    }),
  },
  // NOT (2026-07-27): bu fal-wrapped "gpt-image-2" girdisi ARTIK
  // KULLANILMIYOR (bkz. useOpenAiDirect — tek buton artık doğrudan OpenAI'ye
  // gidiyor) ama SİLİNMEDİ. Kısa geçmiş: doğrudan OpenAI -> bu fal yoluna
  // dönüldü (gerçek testte 5 fotoğrafın 4'ü iyiydi) -> şeması bir kez yanlış
  // tahmin edilip 422 hatasına yol açtı, commit 38e16f6'dan doğru şemayla geri
  // alındı -> şimdi tekrar doğrudan OpenAI'ye dönüldü (bkz. OPENAI_MODEL_ID
  // tanımının altındaki not) çünkü artık AYNI kapsamlı prompt + AYNI iki
  // katmanlı kalite kapısını kullanıyor, moderasyon/kalite riski kalmadı.
  // İleride tekrar fal'a dönmek istenirse bu girdi hazır bekliyor.
  "gpt-image-2": {
    endpoint: "openai/gpt-image-2/edit",
    buildInput: (prompt, imageUrls, seed) => ({
      prompt,
      image_urls: imageUrls,
      image_size: "auto",
      quality: "medium",
      num_images: 1,
      output_format: "jpeg",
      seed,
    }),
  },
};
const DEFAULT_MODEL_ID = "nano-banana-pro";

// "Fotoğraflarımı Oluştur" (tek buton) artık DOĞRUDAN OpenAI API'sine gidiyor
// (bkz. generateWithOpenAI/runOpenAiDirectChunk, useOpenAiDirect = true).
// runOpenAiDirectChunk artık buildEditPromptSimple DEĞİL, fal yoluyla AYNI
// kapsamlı buildEditPrompt'u ve AYNI referans setini (crop hariç tüm
// selfie'ler + tam boy) kullanıyor — artık iki yol arasında PROMPT/GÖRSEL
// FARKI yok, sadece hangi API'ye gidildiği farklı. fal-wrapped "gpt-image-2"
// MODEL_CATALOG girdisi SİLİNMEDİ (yukarıda) — geri dönmek istenirse
// useOpenAiDirect `false` yapılabilir.
const OPENAI_MODEL_ID = "gpt-image-2";
const OPENAI_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";

// ÜRETİM MODLARI — client "mode" alanıyla hangisini istediğini bildirir
// (3 ayrı "Fotoğraflarımı Oluştur" butonu, A/B karşılaştırması için).
// Üçü de AYNI modeli (OpenAI gpt-image-2), AYNI 3 görseli ve AYNI iki
// katmanlı kalite kapısını kullanır — TEK FARK prompt stratejisi:
//   full   : tek atım, kapsamlı buildEditPrompt (~2600 kelime) — mevcut sürüm
//   staged : 3 ardışık üretim çağrısı (kimlik -> geometri/bakış -> ışık),
//            her aşama kısa ve odaklı; MALİYET 3x
//   short  : tek atım, buildEditPromptShort (~350 kelime, ana odaklar korunmuş)
const PHOTO_MODE_FULL = "full";
const PHOTO_MODE_STAGED = "staged";
const PHOTO_MODE_SHORT = "short";
// PROMPT UZUNLUĞU MERDİVENİ (2026-07-29): tek değişkeni prompt uzunluğu olan
// A/B testi. Hepsi Buton-1 ile AYNI şekilde çalışır (tek atım, aynı görsel
// seti, aynı kalite kapısı) — SADECE prompt uzunluğu farklıdır.
//   p300  ~300 kelime  | en yalın
//   short ~470 kelime  | mevcut (Buton-3)
//   p800  ~800 kelime  | pratikte "en verimli" bandın ortası
//   p1400 ~1400 kelime | karmaşık image-to-image için üst bant
//   full  ~2900 kelime | mevcut (Buton-1), getirisi azalan bölge
const PHOTO_MODE_P300 = "p300";
const PHOTO_MODE_P800 = "p800";
const PHOTO_MODE_P1400 = "p1400";
const PHOTO_MODES = [
  PHOTO_MODE_FULL, PHOTO_MODE_STAGED, PHOTO_MODE_SHORT,
  PHOTO_MODE_P300, PHOTO_MODE_P800, PHOTO_MODE_P1400,
];
// Stil başına üretilecek foto. Her biri FARKLI bir sahne varyantıdır (bkz.
// STYLE_SCENES) — aynı sahnenin 5 kopyası değil, 5 ayrı gerçek ortam.
const IMAGES_PER_STYLE = 5; // DatingConfig.photosPerSet ile senkron (ödenen vaat)
// Ücretsiz ilk deneme artık TÜM stili (5 foto) değil, tek bir stildeki TEK
// fotoğrafı üretir — kalan 4'ü hiç ÜRETİLMEZ (kilitli kalır, API maliyeti
// yok). Kullanıcı paket alıp tekrar "Oluştur"a basınca YENİ bir iş tam
// IMAGES_PER_STYLE ile çalışır. Bkz. startPhotoGeneration + finalizeChunk.
const FREE_TIER_CHUNK_COUNT = 1;
// Kullanıcıdan istenen referans: 3 canlı yüz (ön/sağ/sol) + 1 zorunlu tam boy.
const REFERENCE_PHOTO_COUNT = 4;
const FACE_PHOTO_COUNT = 3;
// Bir chunk (tek görsel) fal tarafında hata verirse kaç kez yeniden denenir.
// 0 = HİÇ RETRY YOK (bilinçli tercih): kimlik-kapısı reddi, indirme hatası ya
// da kayıt hatası — hangi sebeple olursa olsun chunk tek denemede başarısız
// olursa doğrudan finalizeChunk({failed:true}) ile sonlandırılır. Amaç: bir
// chunk için ASLA birden fazla nano-banana-pro üretim ücreti ödenmemesi —
// önceki değer (2) "en kötü ihtimalde 3 kat maliyet" riskini taşıyordu
// (bkz. 2026-07-22 kredi-yakma olayı). Maliyet artık foto başına en fazla
// 1 nano-banana-pro + 1 face-swap denemesiyle sınırlı; karşılığında bazı
// fotoğraflar (özellikle kimlik eşiğini ilk seferde tutturamayanlar) artık
// otomatik kurtarılmadan başarısız sayılabilir — paket kredisi mevcut iade
// mantığıyla (bkz. finalizeChunk) yine de geri verilir.
const MAX_CHUNK_RETRIES = 0;

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
    "Mid-step through the lobby of a boutique hotel, adjusting a cuff and glancing off-camera with a calm, composed expression, wearing a well-cut charcoal blazer over an open white shirt. Behind: a marble reception desk, warm brass lamps, and a tall arched window spilling soft late-afternoon light across the floor",
    "Leaning on one forearm at the marble counter of a dimly lit restaurant bar, holding a glass of wine, quietly amused at something just out of frame, a closed-mouth ease. Behind: backlit shelves of bottles, low pendant lights, a bartender clearly visible mid-motion",
    "Crossing a European city street under flat overcast daylight in a tailored camel coat, hands in pockets, calm and unposed, looking slightly away from the lens. Behind: shopfronts and passers-by, all clearly visible and in sharp focus, grey even light",
    "Standing at the railing of a rooftop terrace at dusk in a light grey suit with the collar open, one hand resting on the rail, a calm, unreadable expression. Behind: glass towers with lit windows against a deep blue evening sky",
    "Pausing in a quiet art gallery, hands in pockets, head turned to study a painting with a thoughtful expression, wearing a fine black turtleneck. Behind: white walls, large framed artworks, soft even ceiling light",
    "Waiting at a polished hotel bar counter, one hand resting on a folded newspaper, glancing toward the door with quiet composure, wearing a fitted navy suit jacket. Behind: dark wood panelling, a row of backlit spirit bottles and a low chandelier",
    "Standing at a tall window in a private members' club, one hand in a trouser pocket, looking out at the street below with a steady gaze, wearing a fine merino jumper. Behind: heavy velvet curtains, leather armchairs and a low fireplace glow",
    "Walking through a marble-floored arcade of high-end shopfronts, glancing at a window display with mild interest, wearing a tailored overcoat. Behind: warm shop lighting, polished stone columns and reflections in the glass",
    "Seated at a small table on a quiet café terrace, turning a coffee cup with two fingers, looking out at the street with a calm, distant expression, wearing a crisp open-collar shirt. Behind: wrought-iron chairs, striped awnings and soft midday light",
    "Standing in the doorway of an old opera house foyer, adjusting a cufflink, glancing up at the ornate ceiling, wearing a charcoal three-piece suit. Behind: gilded mouldings, a sweeping staircase and warm gallery lighting",
    "Standing at the floor-to-ceiling window of a penthouse living room, holding a crystal tumbler, looking out over the city at night, wearing a fine dark polo. Behind: a skyline of lit towers, a low designer sofa and soft interior lamps",
    "Examining a painting in a private art auction preview room, hands clasped behind the back, studying the canvas closely, wearing a tailored grey suit. Behind: spotlit artworks, a hushed gallery floor and a discreet price card",
    "Leaning on a grand piano in a five-star hotel lounge, glancing toward the pianist, wearing a fine black dinner jacket. Behind: velvet seating, low gold lighting and a wall of aged mirrors",
    "Pausing at the top of private jet boarding steps, glancing back over one shoulder, wearing a fine wool overcoat. Behind: the aircraft's open door, a stretch of tarmac and a soft evening sky",
    "Standing at the edge of a rooftop infinity pool at a five-star hotel, drink in hand, looking out at the skyline, wearing swim shorts and an open shirt. Behind: the pool's mirrored surface and a dense city view beyond",
    "Walking through the marble atrium of a grand hotel, glancing up at a suspended chandelier, wearing a tailored navy suit. Behind: a central fountain, gold-trimmed columns and a sweeping reception desk",
    "Standing still in a couture tailor's fitting room, arms slightly raised as a jacket is pinned, glancing at the mirror, wearing a half-finished bespoke suit. Behind: bolts of fine fabric, a large gilt mirror and warm studio light",
    "Leaning over a glass display case in a high-end watch boutique, examining a timepiece, wearing a tailored blazer. Behind: illuminated cabinets of watches and a discreet, minimal shop interior",
    "Standing in a grand hotel ballroom before an event, adjusting a bow tie, glancing toward the entrance, wearing a black-tie dinner suit. Behind: rows of set tables, tall windows and elaborate ceiling mouldings",
    "Seated in the private terrace of an exclusive members' club, one arm along the back of a chair, looking out over a manicured park, wearing a fine linen jacket. Behind: topiary hedges, wrought-iron furniture and soft afternoon light",
  ],
  athletic: [
    "Resting between sets on a gym bench, forearms on knees, catching breath and looking up with quiet focus, wearing a fitted training t-shirt damp with sweat. Behind: racks of weights, mirrors and machines under natural overhead light",
    "Mid-stride on an outdoor running track under flat grey morning light, breath visible in cool air, focused expression, wearing technical running gear. Behind: empty stadium seating under an overcast sky",
    "Wrapping hands with tape in a worn boxing gym, head down in concentration then glancing up, wearing a loose tank top. Behind: hanging heavy bags, exposed brick and dusty window light from the left",
    "Stopping on a forest hiking trail to look back over one shoulder with calm satisfaction, wearing technical outerwear and a small backpack. Behind: tall trees with dappled sunlight breaking through the canopy",
    "Holding a basketball on one hip on an outdoor court in late afternoon, mid-conversation, relaxed and focused. Behind: chain-link fencing, painted court lines and apartment blocks in warm side light",
    "Climbing a steep rock face on an outdoor bouldering wall, chalk dust on the hands, concentrating on the next hold, wearing fitted climbing gear. Behind: other coloured routes on the rock and a cluster of climbers waiting below",
    "Cycling along a riverside path in the early morning, upright on the bars, glancing ahead with steady focus, wearing a fitted cycling jacket. Behind: a calm river, a low bridge and mist rising off the water",
    "Doing a resistance-band stretch on an outdoor track infield, one leg extended, looking down in concentration, wearing training shorts and a vest. Behind: a running track, distant floodlights and a cloudy sky",
    "Paddling a kayak on a calm lake at dawn, oar mid-stroke, looking toward the far shore with quiet effort, wearing a fitted rash guard. Behind: still water, low mist and pine-covered hills",
    "Standing at a chin-up bar in an outdoor calisthenics park, chalk on the hands, pausing between sets with steady breathing, wearing a fitted tank top. Behind: metal bars, rubber flooring and other people training in the distance",
    "Pausing mid-serve on a private tennis court at a country club, racquet resting on the shoulder, wearing fitted tennis whites. Behind: manicured clay courts, a clubhouse veranda and neatly trimmed hedges",
    "Standing at the rooftop gym of a luxury hotel, towel over one shoulder, looking out at the skyline between sets, wearing fitted training gear. Behind: floor-to-ceiling glass, city towers and modern equipment",
    "Stretching on the open deck of a private yacht at sunrise, one arm overhead, looking out at the calm water, wearing swim shorts. Behind: polished teak decking, coiled rope and open sea",
    "Walking down a fairway at a private golf club, club resting on the shoulder, glancing toward the next hole, wearing a fitted polo and trousers. Behind: manicured greens, tall trees and a distant clubhouse",
    "Mid-rally on a padel court at an upscale sports club, paddle raised, focused on the ball, wearing fitted sportswear. Behind: glass court walls, other members watching and clean modern lighting",
    "Pausing on an alpine ski slope, goggles pushed up, looking out at the mountain range, wearing a fitted ski jacket. Behind: fresh snow, a chairlift line and distant peaks under bright daylight",
    "Climbing out of a private villa pool after a morning lap, one hand on the tiled edge, wearing swim trunks. Behind: a long infinity pool, manicured gardens and a modern villa facade",
    "Standing beside a polo pony at the edge of a field, helmet under one arm, adjusting a glove, wearing polo whites. Behind: a manicured polo field, parked cars and a marquee in the distance",
    "Warming up in an equestrian arena, one hand on the horse's bridle, focused expression, wearing riding boots and a fitted jacket. Behind: raked sand, white rails and a stable block beyond",
    "Chalking up at a modern glass-walled bouldering gym, studying the wall before a climb, wearing fitted climbing gear. Behind: colourful holds, skylights and other climbers in soft focus distance",
  ],
  traveller: [
    "Walking a narrow cobbled street in an old European town, looking up at the buildings with genuine curiosity, wearing a casual jacket with a bag slung across the body. Behind: weathered stone facades, cafe awnings and shuttered windows under soft overcast light",
    "Standing at a mountain viewpoint with a light outdoor jacket, wind in the hair, quietly taking in the view with calm focus. Behind: a wide valley falling away to layered blue peaks in clear daylight",
    "On a coastal cliff path with a linen shirt moving in the breeze, one hand shielding the eyes from the sun, looking out at the horizon. Behind: open sea, a long horizon line and scattered white clouds",
    "Browsing a stall in a busy street market, mid-gesture talking to the vendor, wearing a simple casual shirt. Behind: colourful hanging goods, crates of produce and warm dappled afternoon light",
    "Sitting on the wooden deck of a boat with sunglasses pushed up on the head, one arm over the rail, easy unposed expression. Behind: a working harbour, moored sailboats and bright reflected water",
    "Studying a paper map at a train station platform, glancing up at the departures board, wearing a canvas jacket with a daypack. Behind: an old iron platform roof, a waiting train and scattered travellers",
    "Walking across a stone bridge in an old town at dusk, pausing to look down at the water, wearing a light scarf and jacket. Behind: lit windows along the riverbank and reflections on the water",
    "Standing at the rail of a ferry deck, hair moving in the wind, watching the coastline pass, wearing a windbreaker. Behind: open water, distant cliffs and a trailing wake",
    "Wandering through a spice market, examining a stall of dried goods with interest, wearing a loose linen shirt. Behind: hanging sacks, colourful spices and shafts of light through a canvas roof",
    "Resting on a low stone wall along a hiking trail, adjusting a boot lace, looking out at the landscape, wearing hiking trousers and a light jacket. Behind: rolling hills, a dirt path and scattered wildflowers",
    "Sitting in a first-class airport lounge, coffee cup in hand, looking out at the tarmac through a tall window, wearing a smart travel jacket. Behind: leather armchairs, soft lighting and parked aircraft beyond the glass",
    "Standing at the bow of a private yacht sailing near a rocky coastline, wind in the hair, looking ahead, wearing a light linen shirt. Behind: turquoise water, distant cliffs and a clear sky",
    "Standing at the edge of an infinity pool at a five-star seaside resort, looking out at the horizon where pool meets sea, wearing swim shorts. Behind: sun loungers, palm trees and a calm ocean",
    "Walking through the courtyard of a historic palazzo hotel, glancing up at the surrounding balconies, wearing a linen suit jacket. Behind: a central fountain, potted citrus trees and warm stone archways",
    "Standing on a helicopter viewing platform, hair blown by the rotor wash, looking out at a mountain range, wearing a fitted flight jacket. Behind: the helicopter, distant peaks and clear sky",
    "Seated by the window of a luxury train carriage, one arm on the sill, watching the landscape pass, wearing a fine knit sweater. Behind: polished wood panelling, brass fittings and blurred countryside outside the glass",
    "Standing beside a fire pit at a desert luxury camp at dusk, hands in pockets, looking out at the dunes, wearing a light desert-toned jacket. Behind: a plush tent, scattered lanterns and a darkening sky",
    "Standing on the terrace of a private Mediterranean villa, one hand on the stone balustrade, looking out at the sea, wearing a linen shirt. Behind: bougainvillea, terracotta tiles and a bright blue coastline",
    "Standing on the deck of a safari lodge at golden hour, binoculars in hand, looking out over the plain, wearing khaki safari wear. Behind: a thatched lodge roof, wooden decking and a wide savanna",
    "Standing at a rooftop bar of a boutique hotel in an old city, glancing out over the rooftops, wearing a light linen jacket. Behind: terracotta rooftops, church domes and a warm evening sky",
  ],
  oldmoney: [
    "Settled into a worn leather armchair in a wood-panelled library, a book resting on one knee, looking up mid-thought, wearing a cream cable-knit sweater. Behind: floor-to-ceiling bookshelves and the warm pool of a brass reading lamp",
    "Standing on the stone terrace of a countryside estate with a hand in one pocket, turning toward the camera with calm ease, wearing a navy blazer over a polo. Behind: a manicured lawn, mature oak trees and soft morning haze",
    "On a wooden yacht club dock, coiling a rope, glancing up with an unhurried expression, wearing a light sweater over a collared shirt. Behind: moored boats, masts and calm water under clear daylight",
    "Beside weathered stable doors, resting a hand on the timber, calm and at ease, wearing a quilted jacket. Behind: a paddock, white fencing and long grass in soft natural daylight",
    "At the head of a classic dining room table, mid-conversation with a warm expression, wearing a crisp tailored shirt with sleeves rolled. Behind: antique furniture, framed pictures and light from a tall sash window",
    "Walking a gravel path through a walled kitchen garden, examining a row of plants, wearing a waxed jacket over a jumper. Behind: espaliered fruit trees, a greenhouse and weathered brick walls",
    "Standing at a tack room doorway, cleaning a bridle with a cloth, glancing out toward the paddock, wearing a quilted gilet. Behind: rows of hanging leather tack and a dusty wooden interior",
    "Seated on the steps of a country house porch, a spaniel resting nearby, looking out at the drive, wearing corduroy trousers and a knit jumper. Behind: climbing ivy, a gravel drive and parked estate cars",
    "Leaning on a five-bar gate at the edge of a field, one boot on the rail, surveying the land, wearing a flat cap and tweed jacket. Behind: rolling farmland and a distant tree line",
    "Standing in a wood-panelled billiard room, chalking a cue, glancing toward the window light, wearing a fine v-neck sweater. Behind: a green baize table, mounted trophies and heavy curtains",
    "Standing in the gravel driveway of a château, one hand on a vintage car's wing, looking back toward the house, wearing a tweed jacket. Behind: an ivy-covered stone facade and tall windows",
    "Sitting alone in a private chapel on a family estate, hands resting on a pew, looking toward the stained glass, wearing a dark wool coat. Behind: worn stone arches and soft coloured light",
    "Standing in a formal drawing room beneath a crystal chandelier, one hand resting on a mantelpiece, wearing a fine tweed suit. Behind: gilt-framed portraits, silk drapes and antique furniture",
    "Crouching in a stone wine cellar of a country estate, examining a dust-covered bottle by candlelight, wearing a rolled-sleeve shirt. Behind: racks of aging bottles and arched brick ceilings",
    "Standing pitch-side at a polo match with a glass of champagne, watching the play, wearing a linen blazer. Behind: a manicured polo field, parked vintage cars and marquees",
    "Descending a grand staircase in a manor house, one hand on the banister, looking down toward the hall, wearing a fine dinner jacket. Behind: oil portraits, a checkered marble floor and tall arched windows",
    "Seated at a leather-topped desk in a private study, spinning an antique globe, wearing a cable-knit sweater. Behind: floor-to-ceiling bookshelves and a tall sash window with garden views",
    "Standing on the dock of a rowing club boathouse at dawn, coiling a line, looking out over still water, wearing a quarter-zip jumper. Behind: wooden boat racks and mist rising off the river",
    "Standing at the entrance of a formal garden maze, hand resting on a clipped hedge, looking down one of the paths, wearing a waxed jacket. Behind: manicured box hedges and a distant folly",
    "Sitting by the fire in a hunting lodge great room, glass in hand, looking into the flames, wearing a heavy wool sweater. Behind: mounted antlers, worn leather sofas and a stone fireplace",
  ],
  nightout: [
    "At the counter of a dim cocktail bar, turning toward the camera mid-conversation with a drink in hand, wearing a dark shirt with the top button open. Behind: warm amber light, bottles on shelves and glowing pendant lamps, all clearly visible",
    "On a rooftop bar at night, leaning back against the railing with quiet confidence, wearing a well-fitted jacket. Behind: a wide spread of city lights and a dark skyline, sharp and clearly visible",
    "Walking a neon-lit street at night, hands in jacket pockets, glancing sideways with calm focus, wearing a leather jacket. Behind: glowing signs reflected in wet pavement and passing headlights, all in sharp focus",
    "At a busy restaurant table, mid-conversation and gesturing with one hand, engaged and animated, wearing a casual button-up. Behind: warm string lights, other diners clearly visible and candles on tables",
    "Standing outside a venue at night under a street lamp, checking a phone then looking up, smart casual outfit. Behind: a brick wall, warm light spill from a doorway and passing traffic, all clearly visible",
    "Queuing outside a club entrance at night, hands in coat pockets, glancing down the street, wearing a dark overcoat. Behind: a lit marquee sign, a short queue and wet pavement reflections",
    "Leaning against a taxi at the kerb late at night, waiting, glancing back toward a venue doorway, wearing a fitted blazer. Behind: passing headlights, a lit shopfront and a damp street",
    "At a rooftop lounge table, pouring a drink for someone off-frame, wearing an open-collar shirt. Behind: string lights, low sofas and a hazy city skyline at dusk",
    "Walking down a set of stone steps from a hillside bar, one hand on the rail, looking ahead, wearing a dark casual jacket. Behind: warm lantern light and a view of the city below",
    "Standing at a jazz club entrance, checking a coat into a cloakroom window, wearing a dark suit without a tie. Behind: a velvet rope, dim signage and a glimpse of the stage lighting inside",
    "Standing at a VIP table in an upscale nightclub, glass raised slightly, looking out at the dance floor, wearing a fitted black shirt. Behind: laser lights, a bottle service setup and a crowded floor beyond the rope",
    "Standing at a casino table at night, chips stacked in hand, watching the dealer, wearing a dark tailored blazer. Behind: green felt tables, low gold lighting and blurred figures at neighbouring tables",
    "Leaning on a rooftop champagne bar rail at night, glass in hand, looking out over the illuminated city, wearing a fine dark suit jacket. Behind: a dense skyline and strings of warm lights",
    "Standing in a private karaoke lounge, microphone loosely in hand, glancing toward friends off-frame, wearing an open-collar shirt. Behind: velvet booths, coloured mood lighting and a screen glow",
    "Standing at the hidden entrance of a speakeasy-style bar, knocking on a plain door, wearing a dark overcoat. Behind: a dim alley, a small brass plaque and a single bulb overhead",
    "Sitting at a five-star hotel bar late at night, glass in hand, glancing toward the entrance, wearing a fitted dinner shirt. Behind: backlit marble, rows of premium spirits and low pendant lighting",
    "Standing on a yacht party deck at night, drink in hand, looking out at the city lights across the water, wearing a linen shirt open at the collar. Behind: string lights, deck furniture and a glittering shoreline",
    "Leaning against a velvet banquette in an art-deco cocktail lounge, glass in hand, looking toward the bar, wearing a fitted suit. Behind: geometric brass fittings, mirrored walls and warm low lighting",
    "Standing at the unmarked doorway of an exclusive members-only lounge, being greeted by a host, wearing a dark tailored coat. Behind: a discreet brass sign, soft interior glow and a doorman's silhouette",
    "Standing on a penthouse party balcony at night, drink in hand, looking out over the illuminated skyline, wearing an open-collar shirt. Behind: string lights, low furniture and a dense city view",
  ],
  beach: [
    "Standing barefoot on wet sand under bright midday sun, an open linen shirt catching the breeze, looking out toward the water with calm focus. Behind: breaking waves and a long empty shoreline, clear and sharp",
    "Walking out of the shallows, running a hand back through wet hair, looking out at the horizon, wearing swim shorts. Behind: bright midday sea, foam and sunlit water",
    "Sitting on weathered wooden beach steps with forearms on knees, relaxed and looking off to the side, wearing a light shirt, under flat overcast beach light. Behind: palm fronds and dune grass under a grey sky",
    "Leaning on the bamboo counter of a thatched beach bar with a cold drink, mid-conversation, wearing a casual short-sleeve shirt. Behind: the open sea framed by the bar's roof and hanging lights",
    "Standing on dark coastal rocks with a plain t-shirt, arms loose, watching the swell with an unguarded expression. Behind: sea spray, deep blue water and a clean horizon under natural daylight",
    "Carrying a surfboard under one arm walking up from the shoreline, looking back at the waves, wearing board shorts. Behind: distant surfers in the water and a bright open sky",
    "Sitting cross-legged on a beach towel adjusting a watch strap, looking down in concentration, wearing swim shorts. Behind: scattered beach umbrellas and sunbathers in the distance",
    "Rinsing off at an outdoor beach shower, hand raised to the water, glancing toward the sea, wearing swim shorts. Behind: weathered wooden shower stalls and a glimpse of the beach",
    "Walking along a boardwalk at golden hour, one hand trailing along the rail, looking out at the sunset, wearing a loose shirt over trunks. Behind: dune grass, a wooden walkway and the sun low over the water",
    "Standing at the edge of a beach volleyball court brushing sand off the hands, watching play resume, wearing athletic shorts. Behind: a sand court, a net and a few other players",
    "Sitting under a private cabana at a five-star beach resort, adjusting a sunglasses strap, looking out at the sea, wearing swim shorts. Behind: white curtains, a daybed and turquoise water",
    "Standing on the deck of an overwater bungalow, looking down through the glass floor panel at the reef below, wearing swim shorts. Behind: thatched roofing and a clear lagoon stretching to the horizon",
    "Sitting at the edge of a beach club infinity pool, legs in the water, looking out toward the sea beyond the pool's edge, wearing swim trunks. Behind: sun loungers, a pool bar and a bright horizon",
    "Standing on the swimming platform of a yacht anchored near a beach, about to step down into the water, wearing swim shorts. Behind: the yacht's stern, clear shallow water and a sandy shoreline",
    "Leaning on a bar stool at a sunset beach bar at a luxury resort, drink in hand, looking out at the horizon, wearing a linen shirt. Behind: tiki torches, thatched roofing and an orange sunset sky",
    "Standing on a private island dock at dusk, bag over one shoulder, looking back toward a waiting boat, wearing rolled linen trousers. Behind: turquoise shallows, a wooden dock and palm silhouettes",
    "Standing on the terrace of a beachfront villa, coffee in hand, looking out at the sea over an infinity edge, wearing a light robe over swimwear. Behind: a private pool, palm trees and open ocean",
    "Standing on the trampoline net of a catamaran sailing near shore, one hand on a rope, looking out at the coastline, wearing swim shorts. Behind: taut sails, blue water and a distant beach",
    "Reclining on a daybed beside a resort spa pool, adjusting a towel, looking toward the water, wearing swim shorts. Behind: tropical planting, a quiet infinity pool and soft midday light",
    "Standing on the tender boat approaching shore from a superyacht, hand on the rail, looking toward the beach ahead, wearing swim shorts and an open shirt. Behind: the anchored superyacht and a stretch of white sand",
  ],
  car: [
    "Standing beside a dark luxury sedan on a city street in the evening, one hand on the roof, turning toward the camera with a relaxed expression, wearing a smart jacket. Behind: warm street lighting, shopfronts and passing traffic, all clearly visible and in sharp focus",
    "Leaning back against the front of a sports car in an underground car park, arms loosely crossed, calm and direct, wearing a dark jacket. Behind: concrete pillars and dramatic overhead lighting pooling on the floor",
    "Standing at the open door of a car parked on a mountain road, one foot on the sill, looking out at the view then back to the lens. Behind: a sweeping valley, winding road and clear bright daylight",
    "Mid-motion closing a car door outside a modern glass building in daytime, glancing up with calm composure, wearing a well-fitted coat. Behind: reflective glass, city reflections and clean daylight",
    "Sitting on the sill of an open car door at a scenic overlook under flat midday light, elbows on knees, quietly taking in the view. Behind: a wide landscape under a plain bright sky",
    "Wiping down the bonnet of a classic car in a private garage, focused on the work, wearing a rolled-sleeve shirt. Behind: tool racks, other stored cars and warm workshop lighting",
    "Standing at a fuel station at night, replacing the nozzle, glancing at the car, wearing a dark jacket. Behind: bright canopy lighting and a quiet forecourt",
    "Checking a tyre pressure gauge crouched beside a parked car on a gravel driveway, wearing casual trousers and a jumper. Behind: a country house facade and parked vehicles",
    "Adjusting the wing mirror of a car parked on a coastal road, glancing at the sea beyond, wearing a light jacket. Behind: cliffside road, guardrail and open ocean",
    "Sitting in the driver's seat with the door open, one foot out, tying a shoelace before setting off, wearing a smart casual outfit. Behind: an underground car park and rows of parked cars",
    "Standing on a supercar showroom floor, hand resting on a bonnet, looking down the row of cars, wearing a tailored blazer. Behind: polished concrete, dramatic spotlighting and gleaming paintwork",
    "Standing at a five-star hotel valet stand, handing over a set of keys, wearing a smart overcoat. Behind: a grand entrance, a red carpet and a line of luxury cars",
    "Standing in a private garage collection, running a hand along a classic car's fender, wearing a rolled-sleeve shirt. Behind: rows of vintage and modern cars under warm gallery lighting",
    "Crouching in a race track pit lane, checking a tyre, wearing a fitted racing jacket. Behind: a parked race car, pit equipment and empty grandstands",
    "Standing beside a car on the lawn of a concours d'elegance, polishing cloth in hand, wearing a smart casual blazer. Behind: rows of immaculate classic cars and marquee tents",
    "Standing beside a sports car at a mountain pass hairpin turn, looking out at the view before getting in, wearing a fitted jacket. Behind: a winding road, guardrails and layered mountain ridges",
    "Standing in a marina car park beside a convertible, sea breeze in the hair, looking toward the boats, wearing a light linen shirt. Behind: rows of yacht masts and sparkling water",
    "Standing at the starting line of a vintage car rally, adjusting driving gloves, wearing a period-style driving jacket. Behind: a row of classic cars, checkered flags and a small crowd",
    "Standing on a private airstrip beside a car with a jet parked behind, glancing back toward the aircraft, wearing a tailored coat. Behind: open tarmac, the private jet and a clear sky",
    "Standing under the porte-cochère of a grand hotel as a chauffeur holds the car door, wearing a fine suit. Behind: uniformed staff, an ornate entrance canopy and warm evening light",
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

// Bir string'den deterministik sayısal tohum üretir (kripto amaçlı değil,
// sadece çeşitlilik seçimi için basit bir hash — bkz. pickScene).
function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — basit, hızlı, deterministik PRNG.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bir stilin sahne havuzundan (stil başına 20 varyant) jobId+styleId'e göre
 * DETERMİNİSTİK ama İŞE ÖZGÜ karışık bir sıra üretir. Aynı iş içindeki 5
 * chunk (variantIdx 0-4) bu karışık sıradan İLK 5'i alır — set içinde hiç
 * tekrar olmaz. Farklı bir iş (farklı jobId) aynı stili seçse bile FARKLI
 * bir alt küme/sıra kullanır — böylece aynı stili tekrar tekrar test etmek
 * artık hep aynı 5 arka planı vermez (bkz. "arka planları hep aynı
 * üretiyorsun" şikayeti — kök neden buydu: eskiden sabit ilk-5 seçilirdi).
 */
function pickScene(styleId, jobId, variantIdx) {
  const pool = STYLE_SCENES[styleId];
  const seed = seedFromString(`${jobId}:${styleId}`);
  const rand = mulberry32(seed);
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return pool[order[variantIdx % order.length]];
}

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

/**
 * EDIT prompt'u: image_urls[0] = TABAN görsel (sahne + jenerik kişi), sonraki
 * görseller = kullanıcının referansları. Görev: arka planı/sahneyi/pozu/ışığı/
 * kadrajı AYNEN koru, SADECE kadrajdaki kişiyi kullanıcıya dönüştür — yüz +
 * TEN RENGİ + VÜCUT/KİLO dahil. Bu bir face-swap DEĞİL (o sadece yüz yapar);
 * tam kişi-değişimi edit'i. Arka plan piksel-birebir korunmaz ama edit modeli
 * gerçek taban pikselini gördüğü için metinden üretmeye göre çok daha sadık.
 */
function buildEditPrompt(identityCaption, bodyCaption, bodyProfile) {
  let bodyBlock = "";
  if (bodyCaption) {
    bodyBlock +=
      "REFERENCE BODY (match this build/weight, do not idealise or slim down): " +
      bodyCaption + "\n\n";
  }
  bodyBlock += bodyProfileHint(bodyProfile);

  return (
    "#0 RULE — WHICH IMAGE TO EDIT (get this right first): the FIRST image is the ONLY canvas. Your " +
    "output must be a heavily edited version of THAT FIRST image — same background, same scene, same " +
    "framing — with only the person changed. The OTHER images (the target person's own selfies/photos) " +
    "are REFERENCE MATERIAL ONLY — you look at them to copy the person's face/skin/body, but you NEVER " +
    "output one of them directly or mostly-unedited. If your result looks like an unedited or barely-" +
    "edited copy of the second, third or any later image, that is a COMPLETE FAILURE — it means you " +
    "edited the wrong image. Always check: does my output have the FIRST image's background, scene and " +
    "framing? If not, start over on the first image.\n\n" +
    "#1 RULE, ABOVE EVERYTHING ELSE — EXACT FACE STRUCTURE: The single most important requirement is " +
    "that the output face is structurally IDENTICAL to the target person's close-up selfies, feature by " +
    "feature. Treat the selfies as the exact blueprint and stay as close to them as physically possible " +
    "— when unsure, always copy the selfie rather than invent. Reproduce with precision: the EXACT nose " +
    "(its bridge width, length, tip shape and nostrils), the EXACT eyebrows (their thickness, arch shape, " +
    "length and spacing), the EXACT eyes (their shape, size, slant, spacing and eyelids), the EXACT lips " +
    "and the EXACT jaw/chin/cheekbone shape. Do NOT redesign, average, beautify, symmetrise or 'improve' " +
    "any of these. A stranger must be able to place the output and a selfie side by side and see the SAME " +
    "person's exact face. Only the head's ANGLE and the GAZE direction may change to match the base photo " +
    "— the underlying facial geometry must not.\n\n" +
    "#2 RULE — HEAD SIZE MUST FOLLOW THE BODY: the head must stay in the same proportion to the body as " +
    "in the BASE photo — measured against SHOULDER WIDTH, not against the picture frame. This matters " +
    "most when you resize the body: if the target person is slimmer or narrower than the base person, " +
    "you must SCALE THE HEAD DOWN BY THE SAME AMOUNT as the shoulders and torso. Keeping the head at its " +
    "original size on a narrowed body makes it look oversized — that is a failure, and it is the most " +
    "common way this goes wrong. Never enlarge the head or puff/swell the face.\n\n" +
    "#3 RULE — HEAD ORIENTATION AND GAZE COPY THE BASE, NEVER THE SELFIES: look at the FIRST image (the " +
    "base photo) and see exactly how that person's HEAD IS TURNED and where their eyes point — straight " +
    "at the camera, or off to a side, up, down or away. The output must reproduce that EXACT head " +
    "rotation and gaze. This covers ALL THREE axes: the left/right turn, the up/down chin angle, and the " +
    "sideways TILT (how much the head leans toward one shoulder). Do not straighten a tilted or angled " +
    "head into a neutral upright pose — copy the base person's exact head attitude. Completely IGNORE " +
    "how the person is posed in their own selfies — their selfies are for face/skin/body only, never " +
    "for head angle or gaze.\n" +
    "PROFILE / TURNED-AWAY POSES ARE NOT AN EXCUSE: if the base person is shown in profile or " +
    "three-quarter view (face turned to the side, one ear toward the camera), the output MUST stay in " +
    "that same profile or three-quarter view. Do NOT rotate the head toward the camera to make the face " +
    "easier to draw or to make it look more like the front-facing selfies. Rendering a frontal face " +
    "where the base photo shows a profile is a FAILURE, even if the resulting face resembles the person " +
    "well. Instead, reconstruct how THIS person's face looks from that same angle.\n\n" +
    "You are given several images. The FIRST image is a BASE PHOTO: a scene with a person in it. " +
    "The OTHER images are reference photos of a DIFFERENT specific real person (the target person). " +
    "Among these reference photos, the LAST one is a distant, full-body photo — use it ONLY to judge " +
    "the target person's body build, height and weight; their face in that photo is too small/distant " +
    "to be reliable, so COMPLETELY IGNORE it for facial structure. ALL the OTHER reference photos " +
    "(every one except the base photo and that last full-body one) are close-up views of the target's " +
    "face — these, and ONLY these, are the source of truth for their facial identity and structure.\n\n" +
    "TASK: reproduce the BASE PHOTO keeping its background, environment, location, furniture, objects, " +
    "lighting, colours, camera angle, framing, composition and body pose EXACTLY the same — do " +
    "NOT move, redesign, regenerate or reinterpret the background or the scene in any way. ONLY change the " +
    "PERSON so they become the TARGET person from the reference images.\n\n" +
    "CLOTHING AND ACCESSORIES STAY IDENTICAL — this is strict and non-negotiable: every clothing item, " +
    "its exact colour, pattern, cut and fit; every accessory including glasses/sunglasses, jewellery " +
    "(necklaces, rings, bracelets, earrings), watches, hats, belts, bags and shoes must remain PIXEL-FOR-" +
    "PIXEL the same as in the BASE PHOTO. Do not add, remove, resize, recolour or restyle ANY clothing " +
    "item or accessory, and do not let the target person's reference photos influence what they wear — " +
    "their reference photos are for FACE, SKIN TONE and BODY BUILD only, never for outfit or accessories. " +
    "The ONLY three things that change from the base photo are: the face, the skin tone/colour, and the " +
    "body height/weight/build. Everything else (scene, pose, outfit, accessories) is identical to the base.\n\n" +
    "FACE FIDELITY (most important): copy the TARGET person's face EXACTLY as it appears in their CLOSE-" +
    "UP FACE reference photos (never the distant full-body one) — identical facial features, identical " +
    "bone structure, eyes, nose, mouth, lips, jawline, eyebrows, hairline and hair, and their SAME " +
    "natural expression. This must clearly and unmistakably be the SAME person as in the reference " +
    "photos, recognisable at a glance. Make only the tiny, minimal adjustment needed to fit the base " +
    "photo's head angle and lighting — do NOT reinterpret, redraw, beautify, slim, age, symmetrise, or " +
    "in any way restyle their face, and do NOT change their facial expression. If in doubt, stay closer " +
    "to the reference face, not further. Do NOT blend, average or merge the base photo's original " +
    "person's facial features into the result — the output face must be 100% the target person's face, " +
    "never a mix of the two faces.\n\n" +
    "FACE SHAPE (do not deform): the overall SHAPE and outline of the face must stay EXACTLY as in the " +
    "references — same face length-to-width ratio, same jaw and chin shape, same cheek width. If the " +
    "reference face is oval/narrow/round/square, keep that exact shape. Do NOT round it out, do NOT puff, " +
    "swell, widen, fatten or inflate the cheeks or jaw, and do NOT stretch or squash it into a more " +
    "rectangular/boxy or a rounder shape. The bone structure is fixed identity — only the head's angle " +
    "changes to match the base pose, never the underlying face shape itself.\n\n" +
    "LIPS AND MOUTH: keep the exact lip shape, thickness, width and outline from the reference photos — " +
    "the exact same upper and lower lip fullness and the same mouth width. Do NOT thin, plump, widen, " +
    "reshape or distort the lips. The individual features — eyes, eyebrows, nose and lips — must all " +
    "stay identical to the selfies; ONLY the gaze/viewing angle may differ to match the base pose, and " +
    "the person must never look like a different, unfamiliar person.\n\n" +
    "IMPERFECT SELFIE ANGLES: some of the close-up face references may have been taken from a slightly " +
    "awkward angle by the user themselves — this is normal. You may gently correct ONLY the obvious " +
    "wide-angle lens/perspective distortion (e.g. a nose that looks bulged because the phone was very " +
    "close), but do this by the smallest amount possible and NEVER as an excuse to redesign the face. " +
    "The person's actual facial structure — the real shape and size of their eyes, lips, nose, " +
    "cheekbones and jaw — must stay EXACTLY as in the references. Do NOT beautify or 'improve' it. The " +
    "result must be the SAME recognisable person, with the SAME face, in every photo generated for them " +
    "— consistent and unchanging from photo to photo, never a slightly different or prettier face.\n\n" +
    "SKIN COLOUR — WHOLE BODY, NO EXCEPTIONS: the target person's skin colour must be applied to EVERY " +
    "single piece of visible skin in the photo — face, neck, ears, chest, shoulders, arms, forearms, " +
    "hands, fingers, legs, feet — ALL the same colour as the target person's real skin. It is a SERIOUS " +
    "ERROR to change only the face while leaving the arms, hands, legs or any other body part the base " +
    "person's original skin colour. This applies to EVERY case regardless of how large or subtle the tone " +
    "difference is — whether the base person is much darker or much lighter than the target, or the " +
    "difference is more subtle (e.g. medium, olive, tan, or any other intermediate tone) — always recolour " +
    "the ENTIRE body, limb by limb, to match the target's EXACT skin tone precisely, never an approximation " +
    "or a tone partway between the base and the target. Check the arms and legs specifically. The result " +
    "must have ONE consistent skin colour everywhere, never a patchwork of two different skin colours on " +
    "the same person. Before finishing, re-check every visible limb one by one — if the legs, feet, arms " +
    "or hands still show ANY trace of the base person's original skin tone, that is a failure and must be " +
    "corrected before the image is final.\n\n" +
    "BODY: match the target person's real build, weight and height. If they are heavier, slimmer, taller " +
    "or shorter than the base person, reshape the body accordingly and resize the SAME clothing to fit " +
    "naturally. Keep the body anatomically whole and coherent — correct number of arms, legs, hands and " +
    "fingers, natural joints and proportions, nothing merged, missing, duplicated or distorted.\n\n" +
    "EYEWEAR (sunglasses/glasses) — THE BASE PHOTO DECIDES, NEVER THE REFERENCES: if the person in the " +
    "BASE photo is NOT wearing eyewear, the output must have NO glasses or sunglasses whatsoever. The " +
    "target's reference photos frequently show them wearing sunglasses (especially the distant full-body " +
    "one) — that eyewear belongs to THEIR photo, not to this scene, and carrying it over is a FAILURE. " +
    "Never add, invent or borrow eyewear that the base photo does not already have.\n" +
    "If the person in the base photo DOES wear sunglasses or glasses, keep " +
    "that eyewear EXACTLY as in the base photo — same frame shape, colour, size, position and " +
    "reflections. But the eyewear must NOT change the face underneath it. Because the eyes are hidden, " +
    "the VISIBLE parts carry the identity and must match the target's selfies with extra precision: the " +
    "EXACT nose (bridge width, length, tip shape, nostrils), the EXACT mouth and lips, the EXACT jawline, " +
    "chin and cheekbones, and the EXACT eyebrows wherever they show above or around the frames. Do NOT " +
    "reshape or widen the nose to 'fit' the glasses, and do NOT drift toward a generic face just because " +
    "the eyes are covered — reconstruct the face exactly as it is in the selfies, then place the base " +
    "photo's eyewear on top of it.\n\n" +
    "TATTOOS / SKIN MARKINGS: do NOT invent or add any tattoos, and do NOT keep the base person's " +
    "tattoos. The target person's skin only has a tattoo if it is clearly visible in THEIR OWN reference " +
    "photos. If their references show no tattoos, the output skin must be completely clean with no " +
    "tattoos anywhere. If the base photo's person has tattoos but the target does not, remove them.\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    bodyBlock +
    "EXPRESSION: reproduce the target person's OWN natural expression from their reference photos — do " +
    "not change it. Do NOT invent or add an open smile, grin or laugh that is not present in their " +
    "reference photos, and equally do not force a stiff neutral face if their references are not neutral. " +
    "Keep whatever calm, natural expression they actually have. The exact shape of the eyes, eyelids, " +
    "mouth and lips must stay IDENTICAL to the reference photos — do NOT restyle, enlarge, narrow, lift " +
    "or reshape them to look more 'attractive', 'awake' or 'confident'. Their real eye and lip shape IS " +
    "their identity; changing it makes it a different person.\n\n" +
    "FACE SMOOTHNESS: gently clean up distracting TEMPORARY skin flaws on the FACE only — remove " +
    "blemishes, spots, harsh acne, razor bumps and stray noise. This is a small cleanup, NOT a " +
    "brightening or glow effect — the skin's colour and tone must stay exactly as dark/light as the " +
    "reference photos, only cleaner. Keep it natural: preserve real skin texture and the person's " +
    "permanent, identity-defining features (moles, freckles, scars, beard, wrinkles) — do NOT flatten " +
    "the face into a plastic, waxy, over-airbrushed mask, and do NOT make it look shinier, lighter or " +
    "more radiant than the references.\n\n" +
    "GAZE (critical — get this right): the eyes must look in EXACTLY the same direction as the person in " +
    "the BASE photo is looking. This is decided ONLY by the base photo, NEVER by the target's reference " +
    "photos — ignore where the person looks in their selfies. First determine where the base subject is " +
    "looking (straight into the camera, or off to a specific side, up, down or away), then make the " +
    "output eyes and irises point in that SAME direction. If the base person looks into the lens, the " +
    "output looks into the lens; if the base person looks away to the left, the output looks away to the " +
    "left. Both eyes aligned and coherent — never cross-eyed, wall-eyed or wandering, never a blank " +
    "dead-eyed stare. Eyes clear and sharp with natural catch-light, both pupils and irises well " +
    "defined.\n\n" +
    "HEAD POSE: keep the head at the SAME orientation and angle as the person in the base photo, but " +
    "held upright and firmly, naturally connected to and aligned with the neck and shoulders — the head " +
    "must sit correctly on the neck with no gap, seam, mismatch, floating or pasted-on look where the " +
    "head meets the neck. Not tilted, drooping, slumped or leaning. A confident, well-balanced head " +
    "position.\n\n" +
    "FACE STRUCTURE UNDER ROTATION: when the head is turned or seen at an angle (three-quarter or " +
    "profile), keep the person's true 3D facial STRUCTURE intact — the real shape and proportions of " +
    "the nose, cheekbones, jaw, chin, brow and the spacing of the features must stay correct and " +
    "consistent for that same person from any angle. Rotating the view must NOT stretch, flatten, warp, " +
    "widen or distort the face or change who the person is.\n\n" +
    "HEAD SIZE (scale it with the body): keep the head in the SAME proportion to the body as the person " +
    "already in the BASE photo. Judge this against SHOULDER WIDTH — on a normal adult the head is about " +
    "one third of the shoulder span — not against the picture frame. CRITICAL when the build changes: " +
    "you are also reshaping the body to the target's real build; if that makes the shoulders and torso " +
    "narrower than the base person's, the head MUST shrink by the same proportion. A head left at its " +
    "original size on a narrowed body reads as oversized even though nothing about the head changed. " +
    "The close-up face references are zoomed-in for identity detail ONLY — never use their zoom level " +
    "as a size reference. The head must never look oversized, bobble-headed or too big for the " +
    "shoulders.\n\n" +
    "SINGLE PERSON: the target person appears EXACTLY ONCE. Do not duplicate their face onto other people " +
    "in the scene; any background people stay different, generic, unrelated people.\n\n" +
    "LIGHTING (strict): the face's skin colour and tone must look IDENTICAL to the reference photos — " +
    "as if no extra light was added at all. Absolutely do NOT brighten, whiten, lighten, glow, shine, " +
    "shimmer or add any radiance, sheen or luminous quality to the skin — the face must NOT look lit-up, " +
    "highlighted or enhanced compared to the rest of the scene. The ONLY lighting fix allowed is removing " +
    "genuinely BAD lighting: harsh shadows across the eyes or nose, or the face being so dark it is hard " +
    "to see. Otherwise the face must sit under the exact same light direction, intensity and colour as " +
    "the rest of the base scene, with no separate or extra light on it. There must be NO unexplained " +
    "dark blotch, black smudge, dirty patch or hard shadow stuck on the face — facial skin stays clean " +
    "and evenly toned in the person's real colour.\n\n" +
    "CRAFT: keep it looking like an ordinary, unedited phone photo of a real person — natural skin with " +
    "real texture, and do NOT invent blemishes or facial asymmetry not present in the references. True-" +
    "to-life colour and contrast, natural available light, no added brightness or glow.\n\n" +
    "AVOID: reinterpreting or restyling the target's face, making the face look like a different or only-" +
    "similar person, changing the shape or size of the eyes/lips/nose/jaw, thinning/plumping/widening or " +
    "reshaping the lips, enlarging or opening the eyes beyond the references, rounding/puffing/swelling/" +
    "widening/fattening the face or cheeks, making the face more rectangular/boxy or rounder than the " +
    "references, changing the face's length-to-width ratio, an unexplained dark patch/shadow/black smudge " +
    "on the face, prettifying or beautifying the face, airbrushed or plastic skin, beauty-" +
    "filter smoothing, CGI/3D-render look, a symmetrical or idealised AI face, changing the target's " +
    "expression, adding an invented smile/laugh, a tilted/drooping/leaning head, a head that floats, is " +
    "pasted on or does not join the " +
    "neck cleanly, an oversized/bobble-head or a head bigger than the base subject's head, a head-to-body " +
    "ratio different from the base photo, adding tattoos not present in the target's references, keeping " +
    "the base person's tattoos, a gaze pointing somewhere different from the base subject's gaze, copying " +
    "the gaze direction from the target's selfies instead of the base photo, a face that is " +
    "stretched/warped/distorted or changes structure when turned to an angle or profile, leaving obvious " +
    "acne/blemishes/spots/blotches on the face, a dull/muddy/underexposed or unevenly lit face, harsh " +
    "shadows or blown-out highlights on the face, an artificially glowing/glossy/shiny/luminous/lit-up " +
    "face, skin that looks brighter or whiter than the reference photos, using the distant full-body " +
    "reference photo's face for facial structure, changing or regenerating the background, keeping the " +
    "base person's original skin colour ANYWHERE on the body (especially arms/hands/legs), a two-tone " +
    "patchwork of skin colours, keeping the base person's body shape, ANY change to clothing, outfit, " +
    "glasses, jewellery, watches, hats, belts, bags or shoes compared to the base photo, copying the " +
    "target reference person's clothing onto the output, garbled fake text on signs/screens, watermark, " +
    "distorted hands, extra/missing/duplicated limbs."
  );
}

/**
 * GPT2 (doğrudan OpenAI) yolu için MİNİMAL prompt — buildEditPrompt'a HİÇ
 * dokunmuyor, ayrı ve bağımsız (nano-banana-pro'yu etkilemez).
 *
 * GEREKÇE (2026-07-25, kullanıcı testi): kullanıcı ChatGPT'nin kendi arayüzüne
 * SADECE 2 fotoğraf (kendi fotoğrafı + hedef foto) atıp tek cümlelik bir
 * talimatla ("bu ikisini değiştir") çok iyi sonuç alıyor. Önceki sürüm (3
 * görsel + çok maddeli İngilizce paragraf) hâlâ o kaliteyi yakalayamadı — bu
 * fonksiyon tek bir kısa talimata indirildi, sadece gerçekten gözlemlenmiş iki
 * soruna (ten rengi sadece yüzde kalması, zorla gülümseme) karşı birer kısa
 * ek cümle bırakıldı. Sonuç yetersiz kalırsa BURAYA, tek tek, gerçekten
 * gözlemlenen soruna göre madde eklenmeli — baştan her ihtimale karşı
 * doldurmak yerine.
 */
function buildEditPromptSimple(bodyCaption, bodyProfile) {
  const bodyBits = [];
  if (bodyCaption) bodyBits.push(bodyCaption);
  const bt = bodyProfile && BODY_TYPE_HINTS[bodyProfile.bodyType];
  const ht = bodyProfile && HEIGHT_HINTS[bodyProfile.heightRange];
  if (bt) bodyBits.push(bt);
  if (ht) bodyBits.push(ht);
  const bodyNote = bodyBits.length
    ? ` Match this body build (do not idealise or slim down): ${bodyBits.join(", ")}.`
    : "";

  return (
    "Replace the person in the first photo with the person in the second photo: same face, same body " +
    "build and height, and their skin tone applied evenly to their whole body (not just the face)." +
    bodyNote +
    " Keep everything else in the first photo exactly the same — background, pose, lighting, clothing, " +
    "accessories, camera angle. Keep the second person's own natural expression; don't add a smile, " +
    "grin or laugh that isn't already there."
  );
}

/* ============================================================
 * MOD 2 — 3 AŞAMALI PIPELINE PROMPT'LARI
 * ============================================================
 * buildEditPrompt (~2600 kelime) tek atımda gönderiliyor ve modelin
 * dikkatinin seyreldiğinden şüpheleniyoruz (bkz. #0/#1/#2/#3 kurallarını en
 * başa taşıma ihtiyacı). Bu mod aynı ana odakları KORUYARAK üç ardışık
 * üretim çağrısına böler; her aşamanın çıktısı bir sonrakinin TABAN görseli
 * olur. Böylece her çağrıda model daha az sayıda kurala odaklanır.
 *
 * BİLİNEN RİSK (kullanıcıya açıkça söylendi): her aşama görseli YENİDEN
 * üretir ("sadece şuraya dokun" kilidi yok), yani 1. aşamada iyi çıkan yüz
 * 2./3. aşamada tekrar bozulabilir. Ayrıca maliyet 3 katına çıkar. Bu mod
 * tam da bunu ÖLÇMEK için ayrı bir buton olarak duruyor.
 */

// AŞAMA 1: kimlik — yüz + ten + vücut. Kompozisyon/ışık düzeltmesi YOK.
function buildStage1Prompt(identityCaption, bodyCaption, bodyProfile) {
  let bodyBlock = "";
  if (bodyCaption) {
    bodyBlock +=
      "REFERENCE BODY (match this build/weight, do not idealise or slim down): " +
      bodyCaption + "\n\n";
  }
  bodyBlock += bodyProfileHint(bodyProfile);

  return (
    "STAGE 1 of 3 — PERSON REPLACEMENT. Do this one job only.\n\n" +
    "The FIRST image is the BASE PHOTO and it is your ONLY canvas: your output must be that same photo " +
    "with only the person swapped. The other images show a DIFFERENT real person (the target). Never " +
    "output one of those reference images — if your result does not have the FIRST image's background " +
    "and framing, you have failed.\n\n" +
    "Replace the person in the base photo with the target person. Keep the background, location, " +
    "lighting, camera angle, framing, body pose, and EVERY clothing item and accessory (glasses, " +
    "jewellery, watches, hats, bags, shoes) exactly as they are in the base photo — the reference photos " +
    "are for FACE, SKIN and BODY only, never for outfit. EYEWEAR especially: if the base person wears " +
    "none, the output has none — the target's own photos often show sunglasses and carrying them over " +
    "is a failure.\n\n" +
    "FACE — copy it exactly: reproduce the target's face feature by feature from their close-up " +
    "reference photos (ignore the distant full-body one for the face). The EXACT nose (bridge width, " +
    "length, tip, nostrils), EXACT eyebrows (thickness, arch, length, spacing), EXACT eyes (shape, size, " +
    "slant, spacing, eyelids), EXACT lips (shape, thickness, width) and the EXACT jaw, chin and " +
    "cheekbone shape. Keep their real face outline and length-to-width ratio — never round, puff, swell, " +
    "widen or stretch it. Do NOT beautify, symmetrise, average or redesign anything. Keep their own " +
    "natural expression; do not add a smile that is not in their references. Never blend the base " +
    "person's features into the result.\n\n" +
    "SKIN COLOUR — the target's real skin tone must be applied to EVERY visible piece of skin: face, " +
    "neck, ears, chest, arms, hands, legs, feet. Never leave any body part in the base person's original " +
    "skin colour and never produce a two-tone patchwork. Do not lighten, brighten or add glow — keep " +
    "their true tone exactly as in their photos.\n\n" +
    "BODY — match the target's real build, weight and height; resize the SAME clothing to fit naturally. " +
    "Keep the body anatomically correct.\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    bodyBlock +
    "TATTOOS: only if clearly visible in the target's own photos. Remove the base person's tattoos; if " +
    "the target has none, the skin is clean.\n\n" +
    "HEAD ORIENTATION: keep the head turned exactly as it is in the base photo. If that person is shown " +
    "in profile or three-quarter view (face to the side, one ear toward the camera), your output stays " +
    "in that same view — never rotate the head toward the camera to make the face easier to draw or " +
    "more like the front-facing selfies. Ignore how the target is posed in their own selfies.\n\n" +
    "HEAD MUST SCALE WITH THE BODY: you are reshaping the body to the target's real build. If that makes " +
    "the shoulders and torso narrower than the base person's, scale the HEAD DOWN by the same proportion " +
    "(judge it against shoulder width — an adult head is roughly a third of the shoulder span). A head " +
    "left at its original size on a narrowed body reads as oversized. Also keep the head's TILT and chin " +
    "angle exactly as in the base photo — do not straighten a tilted head.\n\n" +
    "Leave only the fine gaze/lighting polish to a later stage — head rotation, tilt and scaling are " +
    "YOUR job, because your output may be used as-is if a later stage is discarded."
  );
}

// AŞAMA 2: geometri — kafa boyutu, boyun birleşimi, bakış yönü.
// GİRDİ: [aşama-1 çıktısı, orijinal taban, en iyi yüz]
function buildStage2Prompt() {
  return (
    "STAGE 2 of 3 — HEAD GEOMETRY AND GAZE. Do this one job only.\n\n" +
    "The FIRST image is your canvas (a photo of a person in a scene). The SECOND image is the ORIGINAL " +
    "reference composition — use it ONLY to read the correct head size and gaze direction. The THIRD " +
    "image is the person's real face — use it ONLY to keep their identity unchanged.\n\n" +
    "Fix exactly three things in the first image, changing nothing else:\n\n" +
    "1) HEAD SIZE: make the head the right size for the BODY IT IS ON in the first image — judge it " +
    "against that body's SHOULDER WIDTH (an adult head is roughly a third of the shoulder span), not " +
    "against the picture frame. Use the SECOND image only to see what head-to-shoulder proportion the " +
    "original composition had. IMPORTANT: the body in the first image may have been narrowed to match a " +
    "slimmer person; in that case the head must be scaled DOWN to match those narrower shoulders, not " +
    "left at the original size. If the head looks too large for the shoulders, or the face looks puffed " +
    "or swollen, shrink and slim it to a natural, anatomically correct size. A bobble-head is a " +
    "failure.\n\n" +
    "2) HEAD AND NECK JOIN: the head must sit firmly on the neck, aligned with the shoulders, with a " +
    "clean natural join — no gap, seam, mismatch, floating or pasted-on look, and no drooping. This is " +
    "about the JOIN, not the angle: if the person in the SECOND image holds their head tilted or at an " +
    "angle, keep that same tilt (see point 3) — do not straighten it.\n\n" +
    "3) HEAD ORIENTATION AND GAZE: look at the SECOND image and see exactly how that person's HEAD IS " +
    "POSED — its left/right turn, its up/down chin angle, and its sideways TILT toward one shoulder — " +
    "and where their eyes point. Reproduce that EXACT head attitude and gaze on all three axes. If the " +
    "SECOND image shows a profile or three-quarter view, your output must stay in that same view — never " +
    "rotate the head toward the camera to make the face easier or more recognisable, and never " +
    "straighten a tilted head into a neutral upright pose. Both eyes aligned and coherent, fully open, " +
    "clear, with natural catch-light — never cross-eyed, wandering, half-closed or dead-eyed.\n\n" +
    "CRITICAL: do NOT change the person's identity while doing this. Their facial structure — nose, " +
    "eyebrows, eyes, lips, jaw, cheekbones and face shape — must stay exactly as it is (cross-check " +
    "against the THIRD image). Do not change the background, clothing, accessories, pose, skin tone or " +
    "expression."
  );
}

// AŞAMA 3: rötuş — ışık, ten temizliği, gerçekçilik. Yapıya DOKUNMAZ.
function buildStage3Prompt() {
  return (
    "STAGE 3 of 3 — LIGHT AND SKIN POLISH. Do this one job only, very gently.\n\n" +
    "The FIRST image is your canvas. The SECOND image is the person's real face photo — use it ONLY to " +
    "check that you are keeping their true skin colour and identity.\n\n" +
    "Make these small corrections and nothing else:\n\n" +
    "1) LIGHTING: remove genuinely bad lighting only — harsh shadows falling across the eyes or nose, a " +
    "face so dark it is hard to see, blown-out highlights, or any unexplained dark blotch, black smudge " +
    "or dirty patch on the face. The face must sit under the same light direction, intensity and colour " +
    "as the rest of the scene.\n\n" +
    "2) SKIN TONE: keep the person's TRUE skin colour exactly as in the second image. Do NOT brighten, " +
    "whiten, lighten or add any glow, sheen, shine or radiance. The face must not look lit-up or " +
    "enhanced compared to the rest of the photo. Skin tone must stay even and consistent across the " +
    "whole body.\n\n" +
    "3) SKIN CLEANUP: gently clean temporary blemishes, spots and stray noise on the face. Preserve real " +
    "skin texture and permanent identity features (moles, freckles, scars, beard, wrinkles). Never " +
    "produce plastic, waxy or airbrushed skin.\n\n" +
    "CRITICAL: change NOTHING structural. Do not alter the face shape, nose, eyebrows, eyes, lips, jaw, " +
    "head size, gaze direction, expression, pose, clothing, accessories or background. The result should " +
    "look like an ordinary, unedited phone photo of a real person."
  );
}

/* ============================================================
 * MOD 3 — KISALTILMIŞ TEK PROMPT
 * ============================================================
 * buildEditPrompt'un ANA ODAKLARI korunarak ~2600 kelimeden ~350 kelimeye
 * indirildi. Hipotez: görsel modellerin metin encoder'ı çok uzun promptta
 * dikkatini kaybediyor; kısa ve net bir talimat daha iyi sonuç verebilir
 * (kanıt: kullanıcının ChatGPT'de tek cümlelik komutla aldığı iyi sonuç).
 * Korunan odaklar: doğru tuval, yüz yapısı kilidi, tüm-vücut ten, vücut,
 * kıyafet/arka plan sabitliği, kafa boyutu, bakış yönü, ifade, ışık, dövme.
 */
/**
 * Beden/boy ipuçlarını tek cümlede toplar — uzunluk merdiveni prompt'ları
 * (p300/p800/p1400) bunu paylaşır, her birinde tekrar yazılmasın diye.
 */
// Kullanıcının formda SEÇTİĞİ beden tipi -> modelin uygulayabileceği SOMUT
// geometri. Etiketin kendisi ("athletic / sporty build") modele ne YAPACAĞINI
// söylemiyordu; bu tablo omuz/gövde/kol düzeyinde ne değişeceğini söylüyor.
// ATLETİK ≠ KASLI (2026-08-02 düzeltmesi): önceki metin athletic için
// "fill out the chest and arms with LEAN MUSCLE" + "clear V-taper" diyordu;
// model bunu vücut geliştirici gibi yorumluyordu. Formdaki "Atletik"
// seçeneği sıradan bir kullanıcı için "spor yapan, formda, fazlalığı
// olmayan" demek — kas sergileyen biri demek DEĞİL. Artık kas yerine
// "fazla yağ yok / düz karın / dik duruş" tarif ediliyor.
//
// GERÇEK KİLOYA YAKINLIK: formda kg/cm alanı YOK, elimizdeki tek beyan bu
// dört kategori. O yüzden her madde iki yönlü fren içeriyor — hem
// "abartma" hem "güzelleştirme/inceltme" yasak. Modelin varsayılan
// eğilimi herkesi ideal/fit göstermek olduğu için özellikle 'average' ve
// 'solid' maddelerinde bu fren açıkça yazıldı.
const BODY_TYPE_DIRECTIVE = {
  slim: "give them a genuinely slim, light frame: narrow shoulders and rib cage, a flat chest, thin " +
    "arms, and a narrow waist and thighs, with the clothing hanging loosely rather than being filled out",
  athletic: "give them a fit, trim everyday build — someone who exercises regularly, NOT a bodybuilder: " +
    "no excess weight at the waist, a flat stomach and upright posture, shoulders only slightly wider " +
    "than average. Do NOT add bulging muscles, visible abs, an inflated chest or an exaggerated V-taper",
  average: "give them ordinary everyday adult proportions — neither noticeably slim nor heavy, shoulders " +
    "and waist in normal balance, a naturally soft stomach (not flat, not toned), and no visible muscle " +
    "definition. This is the most common real build; do not idealise or slim it down",
  solid: "give them a genuinely heavier, fuller frame: a broader and thicker torso, a fuller chest and " +
    "midsection that clearly carries weight, fuller arms and thighs, and a slightly fuller face and " +
    "neck, with the clothing sitting tighter across the middle. Do not slim them down",
};

/**
 * Vücut yönergesi. KULLANICININ SEÇİMİ BELİRLEYİCİDİR.
 *
 * ÖNCEKİ HÂLİ HATALIYDI (2026-08-02): bodyCaption (fotoğraftan Gemini'nin
 * çıkardığı serbest metin) ile kullanıcının form seçimi aynı cümlede yan yana
 * diziliyordu ve BİRBİRİYLE ÇELİŞİYORDU — gerçek çıktı:
 *   "Their build: average build, athletic / sporty build, about 170–175 cm"
 * Model hem "average" hem "athletic" duyuyordu. Üstelik bodyCaption'ların
 * TAMAMI birkaç kelimede kesikti ("The person appears to be") ve ikisinde
 * prompt metni sızmıştı (bkz. identityCaption.js isUsableCaption).
 *
 * Artık: kullanıcının seçtiği boy + beden tipi tek yetkili kaynak, somut
 * geometriye çevriliyor; kafa oranı da bu seçime bağlanıyor. bodyCaption
 * yalnızca DOĞRULANMIŞSA ve seçimle çelişmeyecek şekilde ek bir gözlem
 * cümlesi olarak veriliyor.
 */
function shortBodyNote(bodyCaption, bodyProfile) {
  const bt = bodyProfile && BODY_TYPE_DIRECTIVE[bodyProfile.bodyType];
  const label = bodyProfile && BODY_TYPE_HINTS[bodyProfile.bodyType];
  const ht = bodyProfile && HEIGHT_HINTS[bodyProfile.heightRange];
  if (!bt && !ht) return "";

  // BOY ARTIK PROMPT'A GİRMİYOR (2026-08-03): kullanıcının boyu, şablon
  // havuzunun hangi bandından (short/middle/tall) seçim yapılacağını
  // belirliyor — yani taban fotoğraf zaten doğru boy oranında geliyor.
  // Prompt'ta ayrıca "şu kadar kafa boyu uzun" demek ölçülemez bir talimattı:
  // kareler çoğunlukla bel/göğüs üstü, bacaklar görünmüyor, dolayısıyla model
  // bu ölçüyü uygulayamıyordu. Kafa boyutu artık tek bir yerde, OMUZ
  // GENİŞLİĞİNE bağlı olarak yönetiliyor (bkz. prompt'taki "3) HEAD SIZE").
  let s = `\n\nTARGET BUILD — based on their own full-body reference and their stated build: ` +
    `${label || ht}.`;
  if (bt) s += ` Reshape the base person's body accordingly: ${bt}.`;
  // bodyCaption (fotoğraftan otomatik gözlem) YALNIZCA tam bir cümleyse ve
  // kullanıcının seçimiyle çelişmiyorsa ek bilgi olarak veriliyor; çelişirse
  // seçim kazanır. Kırık/kesik caption'lar zaten identityCaption.js'te
  // eleniyor, bu ikinci bir emniyet kemeri.
  const cap = typeof bodyCaption === "string" ? bodyCaption.trim() : "";
  const capUsable = cap.length >= 40 && /[.!?]$/.test(cap);
  const conflicts = capUsable && label &&
    Object.values(BODY_TYPE_HINTS)
      .filter((v) => v !== label)
      .some((v) => cap.toLowerCase().includes(v.split(" ")[0].toLowerCase()));
  if (capUsable && !conflicts) {
    s += ` Their own full-body photo also shows: ${cap} Use this only for details the line above does ` +
      `not cover; where they disagree, the user's stated build wins.`;
  }

  return s;
}

/**
 * ~300 KELİME — merdivenin en yalın basamağı.
 * Yapı: görev -> korunacaklar -> değişecekler -> kalite. Tekrar YOK; her kural
 * yalnızca bir kez ve en kısa haliyle söylenir.
 */
function buildEditPromptP300(identityCaption, bodyCaption, bodyProfile) {
  return (
    "TASK: edit the FIRST image — it is your only canvas. Replace the person in it with the person in " +
    "the other reference photos. Never output a reference photo; the result must be the first image, " +
    "edited.\n\n" +
    "KEEP EXACTLY AS IN THE FIRST IMAGE: background, location, lighting, camera angle, framing, body " +
    "pose, head rotation, TILT and gaze direction, head size relative to the shoulders, and every " +
    "clothing item and accessory (glasses, jewellery, watches, bags, shoes). If that person is in " +
    "profile or three-quarter view, stay in that view — never turn or straighten the head toward the " +
    "camera. Ignore how the target is posed or where they look in their own selfies.\n\n" +
    "CHANGE ONLY THE PERSON, using their close-up face photos (the distant full-body photo is for body " +
    "only):\n" +
    "- Face: copy their exact nose, eyebrows, eyes, lips, jaw, chin, cheekbones and face outline. Same " +
    "shapes, same proportions. Do not beautify, symmetrise, round or puff the face. Keep their own " +
    "natural expression. It must unmistakably be the same person.\n" +
    "- Skin: their true tone, applied evenly to every visible area — face, neck, arms, hands, legs. " +
    "Never two-tone, never lightened or given a glow.\n" +
    "- Body: their real build, height and weight, resizing the same clothing to fit. If this makes the " +
    "shoulders narrower than the base person's, scale the HEAD DOWN by the same amount — a head left at " +
    "its original size on a narrowed body looks oversized." +
    shortBodyNote(bodyCaption, bodyProfile) + "\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    "QUALITY: an ordinary, unedited phone photo. Natural skin texture, no plastic airbrush, no added " +
    "brightness. Tattoos only if visible in the target's own photos. Eyewear comes ONLY from the first " +
    "image: if it has none, add none — the target's own photos often show sunglasses and copying them " +
    "over is a failure. If the first image has eyewear, keep it and match the visible face parts to the " +
    "selfies precisely. Clean temporary blemishes only. No distorted hands or extra limbs."
  );
}

/**
 * ~800 KELİME — pratikte en verimli kabul edilen bandın ortası.
 * P300 ile aynı iskelet, ama her maddeye modelin en sık yaptığı hataya karşı
 * tek bir netleştirici cümle eklenmiş (tekrar değil, ayrıntı).
 */
function buildEditPromptP800(identityCaption, bodyCaption, bodyProfile) {
  return (
    "TASK: the FIRST image is your only canvas. The other images are reference photos of a different " +
    "real person (the target). Edit the FIRST image so the person in it becomes the target. Never " +
    "output a reference photo — if your result lacks the first image's background and framing, you " +
    "edited the wrong image.\n\n" +
    "REFERENCES: the LAST one is a distant full-body photo — use it ONLY for build; ignore its face. " +
    "The others are close-up face photos, the only source of truth for facial identity and hair. " +
    "References tell you the person's face, hair, skin and build — never their clothing, accessories " +
    "or pose.\n\n" +
    "CHANGE ONLY THE PERSON — their face, hair, skin tone and body build, per the numbered steps " +
    "below. Everything else stays identical to the first image: background, lighting, camera angle, " +
    "framing, pose, and every clothing item and accessory.\n\n" +
    "1) FACE — highest priority. Copy the target's structure feature by feature from the close-up " +
    "photos: nose, eyebrows, eyes, lips, jaw, chin, cheekbones, face outline and length-to-width " +
    "ratio. Do not beautify, symmetrise, average, round, puff, widen or stretch. Keep their own " +
    "expression; add no smile that is not there. The output face is 100% the target's, never blended " +
    "with the base person's.\n\n" +
    "2) HAIR — part of who they are, so take it from the SAME close-up selfies, never from the base " +
    "person and never invented: their hairline, density, length, texture and colour. If the target is " +
    "bald or balding, the output is bald or balding to exactly the same degree — giving them hair " +
    "they do not have is as wrong as giving them someone else's nose.\n\n" +
    "3) SKIN TONE — the target's true colour on every visible area of skin. Any limb left in the base " +
    "person's tone, or a two-tone patchwork, is a serious error. No brightening, whitening, glow or " +
    "sheen.\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    "4) HEAD SIZE — the most common failure; this rule OVERRIDES the body step below if they ever " +
    "conflict. The head must stay in scale with the shoulders it sits on: narrow shoulders mean a " +
    "SMALLER head, never a large one. Take the shoulder width in your finished image and size the head " +
    "to that — if reshaping the body narrowed the shoulders, the head must shrink with them, because " +
    "a head kept at its old size on narrowed shoulders reads as oversized. Never enlarge the head or " +
    "puff the face. The close-up references are zoomed in for detail only — never take head scale from " +
    "them.\n\n" +
    "5) HEAD ANGLE AND GAZE: keep the head's rotation and tilt exactly as in the first image, on all " +
    "three axes (left/right turn, up/down chin, sideways lean), and keep the eyes looking at the same " +
    "point in the scene — if the base person looks away from the camera, the output looks away too. " +
    "If the base shows a profile or three-quarter view, stay in it; rotating the head or the eyes " +
    "toward the camera to make the face easier is a failure. Ignore how the target is posed or where " +
    "they look in their own selfies.\n\n" +
    "6) BODY — reshape it to the target's real build (specified below), resizing the SAME clothing to " +
    "fit the new shape naturally; do not swap or restyle any garment. Keep limbs, fingers and joints " +
    "anatomically correct." +
    shortBodyNote(bodyCaption, bodyProfile) + "\n\n" +
    "EYEWEAR — the output NEVER has glasses or sunglasses. If the base person wears them, drop them " +
    "entirely and paint the target's own eyes, brows and nose bridge in that area — no lens, frame, " +
    "tint, rim, shadow or leftover trace of them anywhere.\n\n" +
    "TATTOOS: the output has none — remove the base person's.\n\n" +
    "QUALITY: the face sits under the scene's existing light; add none of your own. The result must " +
    "look like an ordinary unedited phone photo — real skin texture, no airbrush, beauty filter or " +
    "CGI look. Gently clean temporary blemishes while keeping permanent features (moles, freckles, " +
    "scars, beard)."
  );
}

/**
 * ~1400 KELİME — karmaşık image-to-image için üst bant.
 * P800'ün üstüne, gerçek kullanıcı testlerinde TEKRARLAYAN hataların her biri
 * için birer kısa madde ekler (bu maddelerin hepsi gözlemlenmiş sorunlardan
 * gelir, "her ihtimale karşı" yazılmış değildir).
 */
function buildEditPromptP1400(identityCaption, bodyCaption, bodyProfile) {
  return (
    buildEditPromptP800(identityCaption, bodyCaption, bodyProfile) + "\n\n" +
    "OBSERVED FAILURE MODES — each of these has actually happened before; check your result against " +
    "every one of them before finishing:\n\n" +
    "- WRONG CANVAS: the output came back as the user's own reference photo, almost unedited. Verify " +
    "your result carries the FIRST image's background, scene and framing.\n\n" +
    "- A DIFFERENT PERSON: the face looked clean and natural but belonged to someone else — often a " +
    "lightened version of the base person rather than the target. Compare your face against the " +
    "close-up references feature by feature; if a stranger could not place them side by side and see " +
    "the same person, start again.\n\n" +
    "- FACE STRUCTURE DRIFTING UNDER ROTATION: when the head is turned to a three-quarter or profile " +
    "view, the nose, cheekbones and jaw got stretched or reshaped. Keep the person's true 3D facial " +
    "geometry consistent from every angle; a turned head must still be the same skull.\n\n" +
    "- SWOLLEN OR ROUNDED FACE: cheeks and jaw were inflated, turning a narrow face into a round one. " +
    "The bone structure is fixed identity — only the head's angle may change, never its shape.\n\n" +
    "- DISTORTED LIPS: lip thickness and mouth width drifted. Copy them exactly.\n\n" +
    "- SLEEPY OR MISMATCHED EYES: half-closed, vacant or incoherent eyes. The eyes, eyelids, mouth and " +
    "micro-expressions must sit together coherently and look awake, alert and self-assured. If the " +
    "person's eyes look very narrow in their selfies you may open them slightly, but only a little, " +
    "keeping the same eye shape.\n\n" +
    "- SKIN TONE STOPPING AT THE NECK: the face was recoloured but the arms, hands or legs kept the " +
    "base person's tone. Re-check every visible limb one by one before finishing.\n\n" +
    "- GLOWING FACE: the skin was brightened or given a sheen so the face looked lit separately from " +
    "the scene. The face must not look enhanced compared to the rest of the photo.\n\n" +
    "- HEAD NOT JOINING THE NECK: the head floated, looked pasted on, or sat at a tilt. It must sit " +
    "upright and firmly on the neck, aligned with the shoulders, with a clean natural join.\n\n" +
    "- OVERSIZED HEAD: the head grew relative to the body. The close-up references are zoomed in for " +
    "identity detail only — never treat their zoom level as a size reference.\n\n" +
    "- INVENTED SMILE: an open smile or grin appeared that is not in the target's references. Keep " +
    "whatever calm, natural expression they actually have.\n\n" +
    "- BORROWED SUNGLASSES: the target wore sunglasses in their own reference photos (often the distant " +
    "full-body one), and that eyewear was carried into a base scene that had none. Eyewear is decided " +
    "ONLY by the base photo — if the base person wears none, the output has none.\n\n" +
    "- DUPLICATED FACE: the target's face was pasted onto other people in the scene. The target appears " +
    "exactly once; any background people stay generic and unrelated.\n\n" +
    "- UNEXPLAINED DARK PATCH: a black smudge or dirty patch was left on the face. Facial skin stays " +
    "clean and evenly toned in the person's real colour."
  );
}

function buildEditPromptShort(identityCaption, bodyCaption, bodyProfile) {
  const bodyBits = [];
  if (bodyCaption) bodyBits.push(bodyCaption);
  const bt = bodyProfile && BODY_TYPE_HINTS[bodyProfile.bodyType];
  const ht = bodyProfile && HEIGHT_HINTS[bodyProfile.heightRange];
  if (bt) bodyBits.push(bt);
  if (ht) bodyBits.push(ht);
  const bodyNote = bodyBits.length
    ? ` Their build: ${bodyBits.join(", ")} — match it, do not idealise or slim down.`
    : "";

  return (
    "Edit the FIRST image (your only canvas) by replacing the person in it with the person shown in the " +
    "other reference images. Never output a reference image — the result must keep the FIRST image's " +
    "background, scene and framing.\n\n" +
    "KEEP IDENTICAL to the first image: background, location, lighting, camera angle, framing, body " +
    "pose, and every clothing item and accessory (glasses, jewellery, watches, hats, bags, shoes). Also " +
    "keep the head the SAME size relative to the body — judged against shoulder width — as the person " +
    "already in it; if you narrow the body to match the target's build, scale the head down by the same " +
    "amount, never leave it at its original size on a narrower body. And keep the SAME head rotation, " +
    "tilt and gaze direction as that person; ignore how the target is posed in their own selfies. If " +
    "that person is shown in profile or three-quarter view, stay in that view — never turn or straighten " +
    "the head toward the camera to make the face easier or more recognisable. Both eyes must stay aligned " +
    "and coherent, pointed together at that same exact spot — never cross-eyed, wall-eyed or wandering. " +
    "The head must sit firmly and naturally on the neck, upright and well-connected, never tilted loosely, " +
    "drooping, floating or pasted-on.\n\n" +
    "COPY EXACTLY from the target's close-up face photos (never the distant full-body one): their exact " +
    "nose, eyebrows, eyes, lips, jaw, chin, cheekbones and face outline — same shapes, same proportions, " +
    "same face length-to-width ratio. Do not beautify, symmetrise, average, round, puff or widen the " +
    "face. Keep their own natural expression; add no smile that isn't already there. The output must be " +
    "unmistakably the same person as the selfies. Their selfies may be taken at an awkward close-up " +
    "angle — you may undo that lens distortion, but only slightly, never as an excuse to redesign the " +
    "face.\n\n" +
    "ALSO CHANGE: their true skin tone, applied evenly to EVERY visible piece of skin (face, neck, arms, " +
    "hands, legs, feet — never a two-tone patchwork, never lightened or given a glow), and their real " +
    "body build, height and weight, resizing the same clothing to fit naturally." + bodyNote + "\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    "EYEWEAR is decided ONLY by the base photo: if the base person wears no glasses or sunglasses, the " +
    "output must have none — the target's own photos often show sunglasses, and copying that over is a " +
    "failure. If the base person DOES wear eyewear, keep it exactly, but do not let it change " +
    "the face under it — with the eyes hidden, match the nose, mouth, jaw and cheekbones to the selfies " +
    "even more precisely, and never widen the nose to suit the frames.\n\n" +
    "Tattoos only if visible in the target's own photos; remove the base person's tattoos. Fix only " +
    "genuinely bad lighting (harsh shadows, an unexplained dark blotch, a too-dark face) without " +
    "brightening the skin. Gently clean temporary blemishes and spots on the face, but keep real skin " +
    "texture and permanent features (moles, freckles, scars, beard). Keep it looking like an ordinary, " +
    "unedited phone photo — natural skin texture, no plastic airbrush, no distorted hands or extra limbs."
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

// ============================================================
// FACE SWAP TABAN GÖRSEL HAVUZU
// ============================================================
// Kullanıcı Firebase Storage'daki bu klasörlere AI ÜRETİMİ jenerik taslak
// fotoğraflar yükler (GERÇEK kişi DEĞİL — catfish + telif + mağaza politikası
// riski). Üretimde nano-banana-pro yerine bu tabanların üstüne kullanıcının
// yüzü swap'lenir; arka plan/vücut/poz tabandan aynen korunur.
//
// KLASÖR YAPISI — TEK DÜZ HAVUZ (2026-08-02):
//   dating_templates/*.jpg
// Eskiden stil/gender/bodyType alt klasörleri ve fallback zinciri vardı;
// kategoriler kaldırıldı (kullanıcı kararı) — tüm taban görseller tek klasöre
// yüklenir ve her üretimde bu havuzdan rastgele seçilir.
const TEMPLATE_ROOT = "dating_templates";

// BOY BANDINA GÖRE ŞABLON HAVUZU (2026-08-02).
//
// NEDEN: bir fotoğrafta boy, kişinin sahnedeki nesnelere (kapı, araba,
// korkuluk, diğer insanlar) göre oranıyla okunur. Kompozisyon/arka plan
// "birebir korunacak" kuralımız yüzünden kişiyi sahne içinde uzatmak/
// kısaltmak geometrik olarak imkansız (bkz. shortBodyNote'taki açıklama) —
// kişiyi büyütürsek kadraj taşar, küçültürsek üstte boşluk açılır ve model
// orayı arka plan uydurarak doldurur.
//
// ÇÖZÜM: boyu üretim sırasında zorlamak yerine, ŞABLONUN KENDİSİNDEN gelmesi.
// Kullanıcının seçtiği boya uygun kadrajlı şablonlar seçilir; boy bilgisi
// böylece prompt'a değil, TUVAL SEÇİMİNE yansır.
//
// Bantlar (kullanıcı kararı): 175 ve altı short, 175-185 middle, 185+ tall.
const TEMPLATE_HEIGHT_BANDS = ["short", "middle", "tall"];
const HEIGHT_RANGE_TO_BAND = {
  under160: "short",
  "160-165": "short",
  "165-170": "short",
  "170-175": "short",
  "175-180": "middle",
  "180-185": "middle",
  "185-190": "tall",
  "190+": "tall",
};

// Havuzdaki taban görselleri döner.
//
// heightRange verilirse önce o boya karşılık gelen alt klasör denenir
// (dating_templates/{band}/). O klasör BOŞSA sessizce tüm havuza düşülür —
// böylece kullanıcı henüz bantlara ayırmamışsa üretim durmaz (fail-safe:
// yanlış boy bandı, hiç üretim yapamamaktan iyidir).
// Döner: { files: Storage File[], band: string|null }
async function listTemplateFiles(heightRange) {
  const band = HEIGHT_RANGE_TO_BAND[heightRange] || null;
  const isImage = (f) => !f.name.endsWith("/") && /\.(jpe?g|png|webp)$/i.test(f.name);

  if (band) {
    const [inBand] = await bucket().getFiles({ prefix: `${TEMPLATE_ROOT}/${band}/` });
    const banded = inBand.filter(isImage);
    if (banded.length > 0) return { files: banded, band };
    console.warn(`ŞABLON BANDI BOŞ: ${TEMPLATE_ROOT}/${band}/ — tüm havuza düşülüyor (boy=${heightRange})`);
  }

  // Tüm havuz. Bant klasörleri de bu listeye dahil olur (alt klasörler
  // getFiles prefix'ine giriyor) — bantlara ayrılmamış eski/düz yüklemeler
  // için doğru davranış budur.
  const [found] = await bucket().getFiles({ prefix: `${TEMPLATE_ROOT}/` });
  return { files: found.filter(isImage), band: null };
}

/**
 * Havuzdan `count` taban görsel seçer.
 *
 * TEKRAR ETMEME (2026-08-02): `recentNames` = bu kullanıcının önceki
 * işlerinde kullanılmış dosya adları (bkz. recentTemplateNames). Önce HİÇ
 * kullanılmamışlar arasından seçilir; havuz tükenirse (kullanıcı havuzdaki
 * her şeyi görmüşse) kalan ihtiyaç en eski kullanılanlardan tamamlanır —
 * yani havuz küçük olsa bile üretim asla durmaz, sadece tekrar en geç olur.
 *
 * Sıra jobId'den türeyen DETERMİNİSTİK tohumla karıştırılır: aynı iş yeniden
 * işlenirse (retry) aynı tabanları verir, farklı iş farklı sıra alır.
 */
function pickTemplatesFromPool(files, jobId, count, recentNames = []) {
  const recent = new Set(recentNames);
  const rand = mulberry32(seedFromString(`${jobId}:tpl`));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const fresh = shuffle(files.filter((f) => !recent.has(f.name)));
  if (fresh.length >= count) return fresh.slice(0, count);

  // Havuz yetmedi — kalanı, EN ESKİ kullanılmışlardan (recentNames sırası
  // yeniden-eskiye) tamamla, böylece en son görülenler en son tekrar eder.
  const staleOrder = new Map(recentNames.map((n, i) => [n, i]));
  const stale = files
    .filter((f) => recent.has(f.name))
    .sort((a, b) => (staleOrder.get(b.name) ?? 0) - (staleOrder.get(a.name) ?? 0));

  const picked = [...fresh, ...stale].slice(0, count);
  // Havuz count'tan da azsa (ör. 3 dosya, 5 gerekiyor) döngüsel tekrarla doldur.
  if (picked.length === 0) return [];
  return Array.from({ length: count }, (_, i) => picked[i % picked.length]);
}

/**
 * Kullanıcının son işlerinde kullanılmış taban görsel adlarını (yeniden
 * eskiye) döner — pickTemplatesFromPool bunları elemek için kullanır.
 * Her iş bittiğinde kullanılan adlar job dokümanına `templateNames` olarak
 * yazılır (bkz. startPhotoGeneration).
 */
async function recentTemplateNames(uid, limit = 40) {
  try {
    const snap = await db
      .collection(`users/${uid}/private/genData/genJobs`)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const names = [];
    for (const doc of snap.docs) {
      const used = doc.data().templateNames;
      if (Array.isArray(used)) names.push(...used);
    }
    return names;
  } catch (e) {
    // Geçmiş okunamazsa üretimi ENGELLEME — sadece tekrar riski artar.
    console.error("Taban görsel geçmişi okunamadı (tekrar filtresi atlanıyor):", e);
    return [];
  }
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
// Form gender ('male'|'female'|'na'|null) -> easel-ai gender_0 (zorunlu alan).
// 'na'/null nötr 'non-binary'ye eşlenir (swap kalitesini en az etkileyen güvenli
// varsayılan).
function genderForSwap(bodyProfile) {
  const g = bodyProfile && bodyProfile.gender;
  return g === "male" || g === "female" ? g : "non-binary";
}

// Eşzamanlı face-swap çağrısını sınırlar (bkz. faceSwapQueue). fal.ai bu
// endpoint için "concurrent requests limit of 10" uyguluyor — mimarimiz 20
// chunk'ı (4 stil x 5) paralel ürettiği için bu limit aşılıyordu ve HER swap
// 429 ile başarısız olup ham görsele düşüyordu (kullanıcı hiçbir zaman
// swap'lenmiş foto görmedi — "hiçbir fark yok" şikayetinin kök nedeni buydu).
// 10'un altında tutmak için 4'e sabitlendi — bu kuyruk PROCESS-İÇİ olduğundan
// (Cloud Functions yük altında 2. bir instance açarsa o da kendi kuyruğunu
// çalıştırır) toplamın 10'u aşmaması için bilerek düşük tutuldu; 429 yine de
// gelirse retry (aşağıda) devreye girer.
const FACE_SWAP_MAX_CONCURRENCY = 4;
let _faceSwapActive = 0;
const _faceSwapWaitQueue = [];

function acquireFaceSwapSlot() {
  if (_faceSwapActive < FACE_SWAP_MAX_CONCURRENCY) {
    _faceSwapActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _faceSwapWaitQueue.push(resolve));
}

function releaseFaceSwapSlot() {
  const next = _faceSwapWaitQueue.shift();
  if (next) next();
  else _faceSwapActive--;
}

/**
 * Kullanıcının gerçek yüzünü (faceUrl) üretilen sahnenin (targetUrl) üstüne
 * yerleştirir. Senkron fal.run çağrısı. Döner: swap'lenmiş görselin URL'i, ya da
 * herhangi bir hata/başarısızlıkta null (FAIL-SAFE — çağıran taraf o zaman ham
 * üretimi kullanır; endpoint kaldırılsa bile üretim bloklanmaz).
 *
 * Eşzamanlılık kuyruğu (acquireFaceSwapSlot) + 429'da backoff'lu retry (max 3
 * deneme) ile fal'ın "concurrent requests limit" hatasına karşı korunur.
 */
async function faceSwap(faceUrl, targetUrl, gender) {
  await acquireFaceSwapSlot();
  try {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(`${FAL_SYNC_BASE}/${FACE_SWAP_MODEL}`, {
          method: "POST",
          headers: {
            Authorization: `Key ${FAL_KEY.value()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            face_image_0: faceUrl,
            gender_0: gender,
            target_image: targetUrl,
            workflow_type: "user_hair", // kullanıcının gerçek saçı korunsun
            upscale: true,
          }),
        });
        if (resp.status === 429 && attempt < maxAttempts) {
          // Eşzamanlılık limiti — kısa süre sonra diğer istekler biteceği için
          // artan bekleme ile tekrar dene (1s, 2s).
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        if (!resp.ok) {
          console.error(`face swap başarısız (deneme ${attempt}): ${resp.status} ${(await resp.text()).slice(0, 200)}`);
          return null;
        }
        const json = await resp.json();
        return json?.image?.url || null;
      } catch (e) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        console.error("face swap hata (ham üretim kullanılacak):", e.message || e);
        return null;
      }
    }
    return null;
  } finally {
    releaseFaceSwapSlot();
  }
}

// Bir chunk için KİŞİ-DEĞİŞİMİ EDIT işini fal KUYRUĞUNA gönderir (webhook'lu).
// image_urls[0] = taban görsel (sahne + jenerik kişi), sonraki görseller =
// kullanıcının referansları. nano-banana-pro/edit, buildEditPrompt talimatıyla
// arka planı koruyup kadrajdaki kişiyi kullanıcıya dönüştürür (yüz + TEN RENGİ +
// KİLO/VÜCUT dahil — face-swap'in yapamadığı tam kişi değişimi). İş bitince fal
// webhook'u çağırır (indir + kimlik kapısı + texture + kaydet).
async function submitStyleJob(uid, jobId, styleId, chunkIdx, templateUrl, refUrls, identityCaption, bodyCaption, bodyProfile, modelId = DEFAULT_MODEL_ID) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}&chunk=${chunkIdx}`;
  const model = MODEL_CATALOG[modelId] || MODEL_CATALOG[DEFAULT_MODEL_ID];
  const prompt = buildEditPrompt(identityCaption, bodyCaption, bodyProfile);
  const seed = Math.floor(Math.random() * 2147483647);
  // İLK sıra taban (düzenlenecek sahne), sonrası kullanıcı referansları (kimlik).
  const input = model.buildInput(prompt, [templateUrl, ...refUrls], seed);
  const resp = await fetch(
    `${FAL_QUEUE_BASE}/${model.endpoint}?fal_webhook=${encodeURIComponent(webhookUrl)}`,
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
    throw new HttpsError("internal", `fal.ai edit gönderimi başarısız: ${resp.status} ${txt.slice(0, 120)}`);
  }
  return await resp.json(); // { request_id, ... }
}

/**
 * OpenAI'nin KENDİ images/edits endpoint'ine doğrudan senkron istek atar.
 * fal.ai'nin aksine SUNUCU görsel URL'i değil, ham görsel BAYTLARINI
 * multipart/form-data ile bekliyor — bu yüzden her imageUrl önce indirilir.
 * Döner: PNG buffer, ya da (moderasyon reddi/hata/429 dahil tüm durumlarda)
 * null — FAIL-SAFE, çağıran taraf null'da chunk'ı retry'siz başarısız sayar
 * (bkz. runOpenAiDirectChunk, MAX_CHUNK_RETRIES=0 politikasıyla tutarlı).
 *
 * images dizisi hem URL (string) hem HAM BUFFER kabul eder — 3 aşamalı
 * pipeline'da (mod 2) sonraki aşamaların tuvali bir önceki aşamanın
 * buffer'ıdır, Storage'a yazıp URL üretmeye gerek yok.
 */
async function generateWithOpenAI(prompt, imageUrls) {
  try {
    const buffers = await Promise.all(imageUrls.map(async (url) => {
      if (Buffer.isBuffer(url)) return url; // zaten ham görsel (pipeline ara çıktısı)
      const r = await fetch(url);
      if (!r.ok) throw new Error(`referans indirilemedi: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }));

    const form = new FormData();
    form.append("model", OPENAI_MODEL_ID);
    form.append("prompt", prompt);
    // MALİYET (2026-07-27 kullanıcı talebi): "high" foto başına ~$0.21 idi,
    // "medium" ~4x daha ucuz (~$0.05). Kalite kapısı (assessOutputFace +
    // Vision) bozuk kareleri zaten eliyor; medium'da tanınabilirlik yeterli.
    form.append("quality", "medium");
    // KRİTİK DÜZELTME (2026-07-28): bu alan EKSİKTİ. OpenAI'nin images/edits
    // API'sinde output_format'ın VARSAYILANI PNG'dir, JPEG DEĞİL. Biz
    // dönen görseli JPEG sanıp jpeg-js ile decode etmeye çalışıyorduk
    // (assessOutputFace -> bufferToTensorScaled), bu da HER TEK fotoğrafta
    // "Error: SOI not found" ile patlıyordu (SOI = JPEG'in başlangıç
    // imzası, PNG'de yok). runOpenAiDirectChunk'taki catch bloğu bu hatayı
    // yutup kaliteyi HİÇ KONTROL ETMEDEN chunk'ı kabul ediyordu — yani iki
    // katmanlı kalite kapımız (kimlik+netlik+kafa oranı + Vision) OpenAI-
    // direct'e geçtiğimizden beri HİÇ ÇALIŞMIYORDU (loglarda 24 saatte 10/10
    // chunk'ta doğrulandı). Şimdi JPEG açıkça isteniyor.
    form.append("output_format", "jpeg");
    buffers.forEach((buf, i) => {
      form.append("image[]", new Blob([buf], { type: "image/jpeg" }), `ref_${i}.jpg`);
    });

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await fetch(OPENAI_IMAGE_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY.value()}` },
        body: form,
      });
      if (resp.status === 429 && attempt < maxAttempts) {
        // OpenAI oran limiti. ÖNEMLİ (2026-07-29 gerçek log): limit "input
        // images per min" üzerinden geliyor ("Limit 5, Used 5") ve OpenAI
        // cevabın içinde ne kadar bekleneceğini SÖYLÜYOR ("Please try again
        // in 12s"). Eski sabit backoff (1.5sn/3sn) DAKİKALIK bir pencere için
        // çok kısaydı ve retry'ler de 429 alıyordu. Artık ipucu ayrıştırılıp
        // ona uyuluyor; yoksa üstel backoff'a düşülüyor (tavan 30sn).
        let waitMs = attempt * 5000;
        try {
          const txt = await resp.clone().text();
          const m = txt.match(/try again in ([\d.]+)\s*(ms|s)\b/i);
          if (m) {
            const v = parseFloat(m[1]);
            waitMs = /ms/i.test(m[2]) ? v : v * 1000;
            waitMs = Math.min(waitMs + 500, 30000); // küçük emniyet payı
          }
        } catch { /* ipucu okunamadı — üstel backoff kullanılır */ }
        console.warn(`OpenAI 429 (oran limiti), ${Math.round(waitMs / 1000)}sn beklenip tekrar denenecek (deneme ${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const json = await resp.json();
      if (!resp.ok || json.error) {
        console.error(`OpenAI images/edits başarısız (deneme ${attempt}): ${resp.status} ${JSON.stringify(json.error || json).slice(0, 300)}`);
        return null;
      }
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) {
        console.error("OpenAI images/edits OK ama görsel yok:", JSON.stringify(json).slice(0, 300));
        return null;
      }
      // MALİYET ÖLÇÜMÜ: OpenAI gerçek token sayılarını cevapta döndürüyor.
      // Proje API anahtarı faturalama uçlarını okuyamadığı için (admin key
      // gerekiyor) net maliyeti ancak buradan ÖLÇEBİLİYORUZ — tahmin değil.
      if (json.usage) {
        const u = json.usage;
        const d = u.input_tokens_details || {};
        console.log(
          `MALIYET GORSEL: girdi=${u.input_tokens ?? "?"} ` +
          `(metin=${d.text_tokens ?? "?"} gorsel=${d.image_tokens ?? "?"}) ` +
          `cikti=${u.output_tokens ?? "?"} toplam=${u.total_tokens ?? "?"} ` +
          `kalite=medium referansSayisi=${buffers.length}`
        );
      }
      return Buffer.from(b64, "base64");
    }
    return null;
  } catch (e) {
    console.error("OpenAI images/edits hata:", e.message || e);
    return null;
  }
}

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// Vision kalite kontrol modeli. gpt-4o görsel yargı için güçlü ve uygun
// maliyetli: 2 görsel (çıktı + referans selfie) "high" detail ile ~1500-2000
// giriş token'ı ≈ kare başına ~$0.005-0.01. "low" detail (512px) kimlik
// karşılaştırması için yeterli değildi, bilinçli olarak "high" seçildi.
const VISION_MODEL = "gpt-4o";

/**
 * VISION KALİTE KONTROLÜ (ikinci katman): üretilen çıktı karesini gpt-4o
 * vision'a gönderir ve İKİ şeyi birden sorar:
 *   1) KİMLİK — bu, referans selfie'deki KİŞİYLE AYNI kişi mi?
 *   2) KALİTE — yüz doğal mı, yoksa AI artefaktıyla bozulmuş mu?
 *
 * KİMLİK KARŞILAŞTIRMASI NEDEN EKLENDİ (2026-07-28, gerçek olay): kullanıcı
 * "tamamen farklı biri" olan bir çıktı bildirdi; loglar o karenin İKİ kapıdan
 * da geçtiğini gösterdi. Sebep: (a) matematiksel kapı face-api.js'in 2018
 * modelini kullanıyor ve eşiği (FACE_MATCH_THRESHOLD=0.70) foto kaybını
 * önlemek için bilinçli olarak gevşetilmişti; (b) Vision'a o zamana kadar
 * SADECE çıktı gönderiliyordu, referans selfie GÖSTERİLMİYORDU — yani
 * "bu senin yüzün mü?" sorusu hiç sorulmuyordu. Kendi içinde düzgün görünen
 * ama BAŞKA BİRİNE ait bir yüz bu testten rahatça geçiyordu. Artık iki görsel
 * yan yana gönderiliyor ve gpt-4o insan gibi karşılaştırıyor.
 *
 * referenceImages: kullanıcının referans yüz fotoğraf(lar)ı — tek bir URL/
 * Buffer ya da DİZİ (3 selfie: ön/sağ/sol). Boş/null ise kimlik
 * karşılaştırması ATLANIR ve yalnızca eski kalite kontrolü yapılır (geriye
 * dönük güvenli). ÇOKLU selfie tercih edilir: model kişiyi üç açıdan görünce,
 * özellikle çıktı yana dönükken kimlik yargısı belirgin şekilde isabetlenir
 * (üretim tarafındaki "hangisi tuval" karışması riski BURADA YOK — bu bir
 * sohbet çağrısı, görsel düzenleme değil).
 *
 * Döner: { ok, reason } — ok:false ise reason "identity" | "quality".
 * FAIL-SAFE: API hatası / belirsiz cevap / kota → ok:true (Vision katmanı
 * ASLA iyi bir kareyi hata yüzünden elemez; yalnızca AÇIKÇA reddettiğinde
 * eler). Böylece bu katman çökse bile üretim durmaz.
 */
async function assessOutputWithVision(buf, referenceImages) {
  try {
    const b64 = buf.toString("base64");
    const refs = (Array.isArray(referenceImages) ? referenceImages : [referenceImages])
      .filter((r) => r != null);
    const hasRef = refs.length > 0;

    // ÇERÇEVELEME NOTU (2026-07-30): bu prompt bilinçli olarak "bu iki
    // fotoğraftaki kişi aynı kişi mi?" DEMİYOR. Öyle sorulduğunda gpt-4o
    // içerik politikası gereği reddediyordu ("I'm sorry, I can't help with
    // identifying or comparing people") — gerçek logda 5 karenin 2'sinde.
    // Ret, fail-safe kabule düşüyor ve kapı sessizce devre dışı kalıyordu.
    // Artık soru bir DÜZENLEME İŞİNİN SADAKAT DENETİMİ olarak kuruluyor:
    // "bu edit, kaynak materyaldeki yüz hatlarını doğru kopyalamış mı?"
    // Bu, istediğimiz bilginin aynısı ama kimlik tespiti sorusu değil.
    const prompt = hasRef
      ? ("You are a quality checker for an AI image-editing pipeline.\n" +
         "IMAGE 1 was produced by an edit. The REMAINING images are the SOURCE MATERIAL the edit was " +
         "instructed to copy the facial features from.\n\n" +
         "Judge how faithfully the edit reproduced that source material:\n" +
         "A) FEATURE FIDELITY — do the facial features rendered in IMAGE 1 match the shapes in the " +
         "source images? Check the nose shape and width, eyebrow thickness and arch, eye shape and " +
         "spacing, lip shape and thickness, and the jaw, chin and cheekbone structure. Differences in " +
         "angle, lighting, styling and expression are expected and fine — you are only judging whether " +
         "the underlying feature SHAPES were copied faithfully. If the features are clearly different " +
         "shapes, the edit failed.\n" +
         "B) RENDERING QUALITY — is the face in IMAGE 1 free of AI artifacts? It fails if you see a " +
         "puffed/swollen/rounded/melted face, warped lips, mouth, eyes or nose, an unnaturally stretched " +
         "or rectangular face, an unexplained dark blotch or smudge, or a generally deformed face.\n" +
         "C) SKIN TONE CONSISTENCY — is the skin colour the SAME across the whole visible body in " +
         "IMAGE 1? Compare the face against the neck, forearms and hands. Shading from light and shadow " +
         "is normal, but if the hands or arms are noticeably darker or lighter in TONE than the face — " +
         "as if two different people's skin were combined — that fails.\n" +
         "D) HAIR — judge only GROSS mismatches against the source images, never styling: is the " +
         "person in IMAGE 1 given hair the source person does not have (source bald or clearly " +
         "balding, IMAGE 1 with a full head of hair), or a hairline/length that is obviously someone " +
         "else's? Messy, windblown, differently combed or partly hidden hair is fine and passes.\n" +
         "E) HEAD SIZE — compare, do not glance. Ignore the face itself. Put the width of the head " +
         "side by side with the width of the shoulders in IMAGE 1 and classify what you see:\n" +
         "  HEAD_NORMAL — the shoulders are roughly three head-widths across; the head belongs to " +
         "that body.\n" +
         "  HEAD_LARGE — the shoulders are barely two head-widths or less; the head is too big for " +
         "the body, or the body too narrow for the head, so it reads as pasted on.\n" +
         "  HEAD_SMALL — the head is noticeably too small for the shoulders.\n" +
         "  NO_SHOULDERS — use ONLY when neither shoulder is inside the frame at all. A partly " +
         "visible, turned or clothed shoulder still counts as visible, so judge it.\n\n" +
         "Reply on exactly two lines:\n" +
         "HEAD_VS_SHOULDERS: <HEAD_NORMAL | HEAD_LARGE | HEAD_SMALL | NO_SHOULDERS>\n" +
         "<verdict>: <SHORT reason, max 12 words>\n\n" +
         "Decide line 1 before the verdict; if line 1 is HEAD_LARGE the verdict MUST be " +
         "BAD_PROPORTION, however clean the face looks. Check all five questions before answering " +
         "GOOD. Verdict is one of:\n" +
         "GOOD: <why it passes>\n" +
         "BAD_FEATURES: <which feature shapes differ>\n" +
         "BAD_QUALITY: <what looks broken>\n" +
         "BAD_SKIN: <where the tone mismatches, e.g. hands darker than face>\n" +
         "BAD_HAIR: <e.g. hair added to a bald person>\n" +
         "BAD_PROPORTION: <e.g. head too large for the shoulders>")
      : ("You are a strict photo quality checker for AI-generated portrait photos. " +
         "Look ONLY at the main person's face and body. Is the face natural and " +
         "undistorted, or is it visibly broken by an AI artifact? Reject (bad) if you " +
         "see any of: a puffed/swollen/rounded/melted face, warped or distorted lips, " +
         "mouth, eyes or nose, an unnaturally rectangular/stretched face, mismatched " +
         "or asymmetric features that look wrong, an unexplained dark blotch or smudge " +
         "on the face, a head that looks pasted on or wrongly sized, or generally a " +
         "face that looks deformed/uncanny. Accept (good) if the face looks like a " +
         "normal, natural real photo of a person, even if not perfect. " +
         "Answer with ONLY one word: GOOD or BAD.");

    // detail "high": kimlik karşılaştırması için yüz ayrıntısı şart; "low"
    // (512px) yüz hatlarını ayırt etmeye yetmiyor. Maliyet farkı ihmal
    // edilebilir (~1500 giriş token'ı ≈ yarım cent).
    const content = [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" } },
    ];
    for (const r of refs) {
      const refUrl = Buffer.isBuffer(r)
        ? `data:image/jpeg;base64,${r.toString("base64")}`
        : r; // public URL (fal CDN / imzalı Firebase URL)
      content.push({ type: "image_url", image_url: { url: refUrl, detail: "high" } });
    }

    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY.value()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        // Karar + kısa gerekçe için yeterli. Gerekçe TEŞHİS içindir: Vision'ın
        // haklı mı yoksa gürültülü mü olduğunu ancak "neden reddettiğini"
        // görerek anlayabiliriz (bkz. 2026-07-30: 0.305 mesafeli en iyi kare
        // reddedilirken 0.448'lik kare kabul edildi — sayıyla örtüşmüyor).
        max_tokens: 60,
        temperature: 0,
        messages: [{ role: "user", content }],
      }),
    });
    // inconclusive: Vision KARAR VEREMEDİ (HTTP hatası, politika reddi ya da
    // ayrıştırılamayan cevap). ok:true ile aynı şey DEĞİL — çağıran taraf,
    // başka hiçbir kanıtı yoksa (ör. matematiksel kapı da yüzü görememişse)
    // kareyi kabul etmemeyi seçebilsin diye ayrı bir bayrak.
    if (!resp.ok) {
      console.error(`Vision kalite kontrolü HTTP ${resp.status} — fail-safe kabul`);
      return { ok: true, reason: null, detail: null, inconclusive: true };
    }
    const json = await resp.json();
    // MALİYET ÖLÇÜMÜ — bkz. generateWithOpenAI'daki aynı gerekçe.
    if (json.usage) {
      const u = json.usage;
      console.log(
        `MALIYET VISION: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} ` +
        `toplam=${u.total_tokens ?? "?"} model=${VISION_MODEL} gorselSayisi=${refs.length + 1}`
      );
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();

    // İKİ SATIRLI CEVAP: Vision önce kafa/omuz SINIFLANDIRMASI yapıyor, karar
    // ikinci satırda geliyor. Gerekçe: tek satır isteyince model her kareye
    // rutin olarak "GOOD: ...correct proportions" yazıyordu — kafa gövdeye
    // göre gözle görülür büyük olan karelerde bile (5/5 geçmişti).
    //
    // SAYI YERİNE SINIF (2026-08-04): ilk sürüm "omuz genişliğine kaç kafa
    // sığıyor" diye SAYI istiyor, omuz kırpılmışsa UNKNOWN'a izin veriyordu.
    // Sonuç: 5 karenin 5'inde de UNKNOWN geldi — model kaçış kapısını her
    // seferinde kullandı, kontrol yine hiçbir şey elemedi. Artık ayrık sınıf
    // isteniyor (modeller sınıflandırmada sayısal tahminden çok daha
    // güvenilir) ve NO_SHOULDERS yalnızca iki omuz da kadraj dışındaysa
    // geçerli.
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const isHeadLine = (l) => /^HEAD(_VS_SHOULDERS|S_ACROSS_SHOULDERS)/.test(l.toUpperCase());
    const headsLine = lines.find(isHeadLine);
    const verdictLine = lines.find((l) => !isHeadLine(l)) || "";
    if (headsLine) console.log(`VISION ÖLÇÜM (kafa/omuz): ${headsLine}`);

    // HEAD_LARGE bağlayıcıdır: model sınıfı "büyük" deyip verdict'i GOOD
    // bırakırsa (talimata rağmen olabiliyor) kare yine de reddedilir —
    // sınıflandırma satırı kararın kendisinden daha güvenilir bir sinyal.
    if (headsLine && /HEAD_LARGE/i.test(headsLine)) {
      const d = verdictLine.includes(":") ? verdictLine.slice(verdictLine.indexOf(":") + 1).trim().slice(0, 120) : null;
      return { ok: false, reason: "proportion", detail: d || "HEAD_LARGE", inconclusive: false };
    }

    const answer = verdictLine.toUpperCase();
    // Gerekçe: verdict satırındaki iki nokta üst üstesinden sonrası (yoksa boş).
    const detail = verdictLine.includes(":")
      ? verdictLine.slice(verdictLine.indexOf(":") + 1).trim().slice(0, 120)
      : null;
    // BAD_FEATURES = yeni çerçevelemedeki ad; BAD_IDENTITY eski cevaplarla
    // uyum için korunuyor. İkisi de içeride "identity" sebebine eşlenir ki
    // sayısal hakem kuralı (visionRejectionOverridden) aynen çalışsın.
    if (answer.startsWith("BAD_FEATURES")) return { ok: false, reason: "identity", detail, inconclusive: false };
    if (answer.startsWith("BAD_IDENTITY")) return { ok: false, reason: "identity", detail, inconclusive: false };
    // BAD_SKIN ayrı bir sebep: sayısal hakem kuralı bunu ASLA geçersiz kılamaz
    // (kimlik mesafesi vücut ten tutarlılığı hakkında hiçbir şey söylemez —
    // bkz. visionRejectionOverridden yalnızca "identity" ile ilgilenir).
    if (answer.startsWith("BAD_SKIN")) return { ok: false, reason: "skin", detail, inconclusive: false };
    // BAD_HAIR de ayrı sebep — ve bu AYRIM ÖNEMLİ: saç uyuşmazlığını
    // "identity" altına koysaydık sayısal hakem onu geçersiz kılabilirdi
    // (bkz. visionRejectionOverridden, mesafe<0.35). face-api'nin kimlik
    // vektörü yüz noktalarından çıkar, SAÇI HİÇ GÖRMEZ — yani kel birine
    // saç eklenmiş bir kare pekâlâ 0.30 mesafeyle gelip affedilirdi.
    if (answer.startsWith("BAD_HAIR")) return { ok: false, reason: "hair", detail, inconclusive: false };
    // BAD_PROPORTION da ayrı sebep: kafa/omuz oranı bozukluğunu kimlik mesafesi
    // ÖLÇEMEZ (yüz doğru olabilir, boyutu yanlış olabilir — gerçek örnek:
    // 2026-08-01, mesafe 0.256 "çok iyi" iken kafa gövdeye göre büyüktü).
    // "identity" DIŞINDAKİ sebepler sayısal hakem tarafından geçersiz
    // kılınamaz — bkz. visionRejectionOverridden.
    if (answer.startsWith("BAD_PROPORTION")) return { ok: false, reason: "proportion", detail, inconclusive: false };
    if (answer.startsWith("BAD_QUALITY")) return { ok: false, reason: "quality", detail, inconclusive: false };
    if (answer.startsWith("BAD")) return { ok: false, reason: "quality", detail, inconclusive: false }; // referanssız mod
    if (answer.startsWith("GOOD")) return { ok: true, reason: null, detail, inconclusive: false };
    // Ayrıştırılamayan cevap (çoğunlukla politika reddi) → fail-safe kabul,
    // ama KARARSIZ olarak işaretlenir.
    console.warn(`Vision kalite kontrolü belirsiz/reddedilmiş cevap ("${raw.slice(0, 70)}") — fail-safe kabul (kararsız)`);
    return { ok: true, reason: null, detail: null, inconclusive: true };
  } catch (e) {
    console.error("Vision kalite kontrolü hata (fail-safe kabul):", e.message || e);
    return { ok: true, reason: null, detail: null, inconclusive: true };
  }
}

// Vision "farklı kişi" dediğinde, SAYISAL kimlik ölçümü bu değerden iyiyse
// Vision'ın reddi GEÇERSİZ sayılır (sayısal ölçüm hakem olur).
//
// NEDEN (2026-07-30 gerçek veri): Vision'ın kararları sayısal mesafeyle
// örtüşmüyordu — 0.305 (koşunun EN İYİ skoru) RED alırken 0.448 GEÇTİ.
// Aynı soruya (bu aynı kişi mi?) iki ölçüm çelişince, güçlü sayısal kanıtın
// gürültülü olabilen tek bir model yargısını geçersiz kılması makul.
//
// SINIR — YALNIZCA "identity" REDDİ İÇİN: Vision "quality" (yüz deforme)
// dediğinde bu kural ASLA uygulanmaz, çünkü kimlik mesafesi deformasyon
// hakkında hiçbir şey söylemez; şişmiş/çarpık bir yüz de pekâlâ düşük mesafe
// verebilir. Orada Vision tek yetkili kalır.
//
// 0.35 muhafazakâr seçildi: kabul eşiğimiz 0.70, yani bu onun yarısı —
// "sınırda" değil, açıkça güçlü bir eşleşme.
const VISION_OVERRIDE_MAX_DISTANCE = 0.35;

function visionRejectionOverridden(visionReason, distance) {
  return visionReason === "identity"
    && distance != null
    && distance < VISION_OVERRIDE_MAX_DISTANCE;
}

// A/B karşılaştırma dönemi boyunca REDDEDİLEN kareler Storage'a yazılır ki
// "Vision haklı mı?" sorusu gözle doğrulanabilsin. Karşılaştırma bitince
// false yapılıp bu depolama kapatılabilir.
const SAVE_REJECTED_FRAMES = true;
const DEBUG_ROOT = "dating_rejected";

/**
 * Reddedilen bir kareyi teşhis için saklar. Dosya adı kararın TÜM bağlamını
 * taşır (mod, chunk, deneme, hangi kapı, mesafe) — böylece görsele bakarken
 * neden elendiği ayrıca aranmaz. Tamamen fail-safe: kaydetme hatası üretimi
 * etkilemez, yalnızca loglanır.
 */
async function saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, meta) {
  if (!SAVE_REJECTED_FRAMES) return;
  try {
    const parts = [
      `${styleId}_c${chunkIdx}_att${attempt}`,
      `mode-${meta.mode || "?"}`,
      `gate-${meta.gate || "?"}`,
      meta.distance != null ? `dist-${meta.distance.toFixed(3)}` : null,
    ].filter(Boolean);
    const path = `${DEBUG_ROOT}/${uid}/${jobId}/${parts.join("__")}.jpg`;
    await bucket().file(path).save(buf, { metadata: { contentType: "image/jpeg" } });
    console.log(`REDDEDİLEN KARE KAYDEDİLDİ: ${path}${meta.detail ? ` | Vision gerekçesi: ${meta.detail}` : ""}`);
  } catch (e) {
    console.error("Reddedilen kare kaydedilemedi (teşhis kaybı, üretim etkilenmedi):", e.message || e);
  }
}

/**
 * Bir chunk'ın TAM yaşam döngüsünü SENKRON olarak yürütür (OpenAI doğrudan
 * yolu — webhook YOK, fal'ın submit+webhook akışının aksine). startPhotoGeneration
 * içinde çağrılır. Kimlik kapısı + texture + kaydet + finalizeChunk hepsi burada;
 * webhook'taki mantıkla AYNI kurallar (retry yok, MAX_CHUNK_RETRIES=0 — bkz. o
 * sabitin açıklaması) tekrar uygulanıyor çünkü bu iki yol asla aynı chunk için
 * birlikte çalışmıyor, kod paylaşımı yerine bilinçli olarak ayrı tutuldu (fal
 * webhook'u dış bir HTTP isteği, bu ise doğrudan senkron çağrı zinciri).
 */
// Chunk başına en fazla deneme (ilk + kalite-tetikli 1 retry) — fal
// webhook'undaki maybeRetryBadChunk ile AYNI "1 kez yeniden dene" politikası.
// Firestore bayrağı GEREKMİYOR (fal'daki gibi async/webhook re-entry riski
// yok — bu tek bir senkron çağrı zinciri, döngü aynı fonksiyon içinde).
const OPENAI_DIRECT_MAX_ATTEMPTS = 2;

/**
 * refUrls'i yüz kareleri ve tam boy karesi olarak ayırır.
 * prepareReferencePhotos sırayı garanti ediyor: [en iyi yüz, diğer yüzler...,
 * tam boy] — bestIndex her zaman yüz karelerinden seçildiği için tam boy
 * asla öne alınmaz, hep sonda kalır (bkz. analyzeReferences).
 */
function splitRefUrls(refUrls) {
  if (!Array.isArray(refUrls) || refUrls.length === 0) return { faceUrls: [], bodyUrl: null };
  if (refUrls.length === 1) return { faceUrls: [refUrls[0]], bodyUrl: null };
  return { faceUrls: refUrls.slice(0, -1), bodyUrl: refUrls[refUrls.length - 1] };
}

/**
 * Bir denemede ham görseli üretir — MOD'a göre tek atım ya da 3 aşamalı
 * pipeline. Döner: Buffer | null.
 *
 * GÖRSEL SAYISI GEÇMİŞİ:
 *  - Başlangıç: [taban, TÜM yüzler, tam boy] (5 görsel).
 *  - 2026-07-27: 3'e indirildi [taban, en iyi yüz, tam boy] — OpenAI bazen
 *    HANGİ görselin "taban/tuval" olduğunu karıştırıp kullanıcının kendi tam
 *    boy fotoğrafını çıktı olarak döndürüyordu.
 *  - 2026-07-28 (şu an): TEKRAR 3 yüz karesine çıkarıldı. Gerekçe: tek ön
 *    selfie ile model taban sahnedeki açıyı/bakışı doğru kuramıyordu (önden
 *    bakması gereken karelerde yana bakan yüzler çıktı). Taban karışması
 *    riskine karşı artık prompt'un EN BAŞINDA açık bir "#0 KURAL — ilk görsel
 *    TEK tuvaldir, diğerlerini asla çıktı olarak döndürme" uyarısı var; o
 *    kural 27 Temmuz'daki indirimle BİRLİKTE eklenmişti, yani koruma
 *    görsel sayısından bağımsız olarak yerinde duruyor.
 */
/**
 * Bir görselin kaynak kimlik vektörüne uzaklığını döner (düşük = daha benzer).
 * Yüz bulunamazsa / hata olursa null. Yerel hesap — API maliyeti YOK.
 */
async function identityDistanceOf(buf, refDescriptor) {
  if (!refDescriptor) return null;
  try {
    const { matchesIdentity } = require("./faceQuality");
    const { distance } = await matchesIdentity(buf, refDescriptor);
    return distance;
  } catch (e) {
    console.error("Aşama kimlik ölçümü başarısız (aşama kabul ediliyor):", e.message || e);
    return null;
  }
}

// Bir pipeline aşamasının kimliği bu kadar BOZMASINA izin verilir. Aşamalar
// geometri/ışık düzeltmesi karşılığında ufak bir sapma yapabilir; bundan
// fazlası kabul edilmez ve aşama çıktısı ATILIR (bir önceki aşamaya dönülür).
const STAGE_IDENTITY_TOLERANCE = 0.03;

/**
 * Bir aşama çıktısını, kimliği kabul edilemez ölçüde bozmuyorsa kabul eder.
 *
 * NEDEN (2026-07-29, gerçek veri): 3 aşamalı pipeline çalıştığında 4/4 kare
 * Vision'dan RED[identity] aldı; aşama 3 (veya 2) çöküp devre dışı kaldığında
 * 5/5 kare GEÇTİ. Yani aşamalar kimliği bozuyordu. Prompt'ta zaten "hiçbir
 * yapısal şeyi değiştirme" yazıyor ama generative model her geçişte görüntüyü
 * SIFIRDAN üretiyor — metin bunu engelleyemiyor. Çözüm aşamayı kaldırmak
 * DEĞİL, çıktısını ÖLÇMEK: aşama kimliği bozduysa çıktısı atılır, bir önceki
 * aşamanın görseliyle devam edilir. Böylece aşamalar yalnızca fayda
 * sağladıklarında hayatta kalır ("aşama yerini hak etmeli").
 */
async function acceptStageIfIdentityHolds(prev, prevDist, next, refDescriptor, label, styleId, chunkIdx) {
  if (!next) return { buf: prev, dist: prevDist };
  const d = await identityDistanceOf(next, refDescriptor);
  // Ölçemiyorsak (kimlik vektörü yok / yüz bulunamadı) eski davranış: kabul.
  if (d == null || prevDist == null) {
    return { buf: next, dist: d != null ? d : prevDist };
  }
  if (d <= prevDist + STAGE_IDENTITY_TOLERANCE) {
    console.log(`AŞAMA ${label} KABUL (style=${styleId}, chunk=${chunkIdx}): mesafe ${prevDist.toFixed(3)} -> ${d.toFixed(3)}`);
    return { buf: next, dist: d };
  }
  console.warn(`AŞAMA ${label} REDDEDİLDİ — kimliği bozdu (style=${styleId}, chunk=${chunkIdx}): mesafe ${prevDist.toFixed(3)} -> ${d.toFixed(3)} (tolerans ${STAGE_IDENTITY_TOLERANCE})`);
  return { buf: prev, dist: prevDist };
}

async function generateForMode(mode, templateUrl, refUrls, identityCaption, bodyCaption, bodyProfile, styleId, chunkIdx, refDescriptor) {
  const { faceUrls, bodyUrl } = splitRefUrls(refUrls);
  const bestFaceUrl = faceUrls[0];
  // Tam görsel seti: taban + TÜM yüz açıları + tam boy.
  const fullSet = [templateUrl, ...faceUrls, ...(bodyUrl ? [bodyUrl] : [])];

  if (mode === PHOTO_MODE_STAGED) {
    // MOD 2 — 3 AŞAMALI PIPELINE. Her aşamanın çıktısı bir sonrakinin TUVALİ.
    // Maliyet 3x; ara aşama çıktıları Storage'a YAZILMAZ, bellekte taşınır.
    // Aşama 1 KİMLİK aşaması olduğu için tüm yüz açılarını alır; aşama 2/3
    // geometri ve ışık işi yapar, orada tek yüz karesi çapa olarak yeterli
    // (fazladan görsel prompt'taki "ÜÇÜNCÜ görsel" göndermelerini bulandırır).
    //
    // KİMLİK KORUMASI: her aşamadan sonra kimlik mesafesi ölçülür; aşama
    // kimliği tolerans üstünde bozduysa çıktısı ATILIR (bkz.
    // acceptStageIfIdentityHolds). Ölçüm yereldir, API maliyeti yoktur.
    const s1 = await generateWithOpenAI(
      buildStage1Prompt(identityCaption, bodyCaption, bodyProfile),
      fullSet
    );
    if (!s1) {
      console.warn(`Pipeline aşama 1 başarısız (style=${styleId}, chunk=${chunkIdx})`);
      return null;
    }
    let cur = s1;
    let curDist = await identityDistanceOf(s1, refDescriptor);

    // Aşama 2 tuvali = güncel çıktı. Orijinal taban (doğru kafa oranı +
    // bakış yönü kaynağı) ve en iyi yüz (kimlik çapası) referans olarak gider.
    const s2 = await generateWithOpenAI(
      buildStage2Prompt(),
      [cur, templateUrl, bestFaceUrl]
    );
    if (!s2) {
      console.warn(`Pipeline aşama 2 başarısız, önceki çıktıyla devam (style=${styleId}, chunk=${chunkIdx})`);
    } else {
      ({ buf: cur, dist: curDist } = await acceptStageIfIdentityHolds(
        cur, curDist, s2, refDescriptor, "2", styleId, chunkIdx));
    }

    const s3 = await generateWithOpenAI(
      buildStage3Prompt(),
      [cur, bestFaceUrl]
    );
    if (!s3) {
      console.warn(`Pipeline aşama 3 başarısız, önceki çıktıyla devam (style=${styleId}, chunk=${chunkIdx})`);
      return cur;
    }
    ({ buf: cur } = await acceptStageIfIdentityHolds(
      cur, curDist, s3, refDescriptor, "3", styleId, chunkIdx));
    return cur;
  }

  // TEK ATIM MODLARI: hepsi AYNI görsel setini ve aynı kalite kapısını
  // kullanır — aralarındaki TEK fark prompt uzunluğudur (bkz. PHOTO_MODES
  // uzunluk merdiveni). Böylece A/B testinde tek değişken izole edilir.
  const promptBuilders = {
    [PHOTO_MODE_P300]: buildEditPromptP300,
    [PHOTO_MODE_SHORT]: buildEditPromptShort,
    [PHOTO_MODE_P800]: buildEditPromptP800,
    [PHOTO_MODE_P1400]: buildEditPromptP1400,
  };
  const build = promptBuilders[mode] || buildEditPrompt; // varsayılan: tam prompt
  const prompt = build(identityCaption, bodyCaption, bodyProfile);
  return await generateWithOpenAI(prompt, fullSet);
}

// Şablondaki kişi kadrajda bu orandan KÜÇÜKSE şablon yakınlaştırılır.
// 2026-07-29 gerçek verisi: 0.091-0.101 oranlı şablon en kötü kimliği
// (0.524-0.550) verdi; 0.162-0.193 oranlılar en iyisini (0.316-0.375).
const TEMPLATE_MIN_FACE_RATIO = 0.13;
// Kırpma sonrası hedeflenen yüz oranı (iyi çalışan şablonların bandı).
const TEMPLATE_TARGET_FACE_RATIO = 0.17;

// BU ORANIN ALTINDAKİ ŞABLON HİÇ KULLANILMAZ (2026-08-04). Kırpma, olmayan
// ayrıntıyı yaratamaz — ve daha kötüsü, yüz bu kadar küçükken dedektör ANA
// ÖZNEYİ hiç bulamayıp arka plandaki birini "en büyük yüz" sanabiliyor.
// GERÇEK OLAY: Coachella şablonunda (1170x1462) öndeki adam hiç tespit
// edilmedi; bulunan 7 yüzün hepsi 10-12 pikseldi ve en büyüğü arka plandaki
// bir yolcuydu. Kırpma oraya odaklandı, model o kişiyi kullanıcıya çevirmeye
// çalıştı, iki deneme de 0.80 mesafeyle reddedildi -> kullanıcı 5 yerine 4
// foto aldı (ve bedelini ödemişti).
// EŞİK VERİDEN: 80 eşleşmiş kare (şablon oranı -> kimlik mesafesi):
//   <0.06  -> n=3,  ortalama 0.633, maks 0.802   (hepsi aynı 0.020'lik şablon)
//   >=0.06 -> n=77, ortalama 0.348, maks 0.646
// Gözlenen en düşük sağlam şablon 0.061. 0.020 ile 0.061 arasında hiç veri
// yok; 0.05 bu boşluğa oturur.
const TEMPLATE_UNUSABLE_FACE_RATIO = 0.05;

/**
 * Taban şablonunu üretime hazırlar: kişi kadrajda çok küçükse şablonu
 * YAKINLAŞTIRIR (bkz. postProcess.cropForFaceRatio gerekçesi).
 *
 * GERİ YERLEŞTİRME (2026-08-02): kırpma yapıldıysa, OpenAI üretimi
 * BİTTİKTEN SONRA sonucu orijinal (kırpılmamış) tuvale geri koyabilmek için
 * hem orijinal buffer hem de kırpma geometrisi de döndürülüyor — bkz.
 * postProcess.recompositeIntoOriginal ve bu fonksiyonun çağrıldığı yer
 * (runOpenAiDirectChunk). Amaç: taban fotoğrafın arka planı/kompozisyonu
 * kırpma nedeniyle asla değişmesin, sadece yüzün olduğu bölge güncellensin.
 *
 * Döner: {
 *   input: kırpılmış Buffer ya da orijinal templateUrl string'i (OpenAI'ye
 *          giden budur — generateWithOpenAI ikisini de kabul eder),
 *   restore: kırpma yapıldıysa { originalBuf, geo }, yapılmadıysa null,
 * }
 * FAIL-SAFE: her hata durumunda { input: templateUrl, restore: null } döner,
 * üretim asla bloklanmaz.
 */
async function prepareTemplate(templateUrl, styleId, chunkIdx) {
  const noCrop = { input: templateUrl, restore: null, usable: true };
  try {
    const r = await fetch(templateUrl);
    if (!r.ok) return noCrop;
    const buf = Buffer.from(await r.arrayBuffer());

    const { detectMainFace } = require("./faceQuality");
    const face = await detectMainFace(buf);
    if (!face) {
      // KULLANILAMAZ ŞABLON (2026-08-04): yüzü tespit edilemeyen bir şablon
      // yalnızca "kırpamıyoruz" demek değil — model için de zor demek.
      // Gerçek örnek: loş smokinli sahne, yüz kadrajın %7'si; üretim kimlik
      // mesafesi 0.646 ile geldi (ana kütle 0.21-0.50) ve kullanıcı "taban
      // fotoğrafı göstermişsin, yüz benzememiş" diye işaretledi. Böyle
      // şablonlar artık kullanılmıyor, yerine yedek şablon seçiliyor.
      console.warn(`ŞABLON KULLANILAMAZ: yüz bulunamadı (style=${styleId}, chunk=${chunkIdx}) — yedek şablon denenecek`);
      return { input: templateUrl, restore: null, usable: false };
    }
    // Bulunan yüz bu kadar küçükse muhtemelen ANA ÖZNE DEĞİL, arka plandaki
    // biridir — kırpma onu merkeze alıp yanlış kişiyi düzenletir
    // (bkz. TEMPLATE_UNUSABLE_FACE_RATIO gerekçesi).
    if (face.ratio < TEMPLATE_UNUSABLE_FACE_RATIO) {
      console.warn(`ŞABLON KULLANILAMAZ: yüz çok küçük (yüzOranı=${face.ratio.toFixed(3)} < ${TEMPLATE_UNUSABLE_FACE_RATIO}, ana özne yerine arka plandaki biri olabilir) (style=${styleId}, chunk=${chunkIdx}) — yedek şablon denenecek`);
      return { input: templateUrl, restore: null, usable: false };
    }
    if (face.ratio >= TEMPLATE_MIN_FACE_RATIO) {
      console.log(`ŞABLON OK (style=${styleId}, chunk=${chunkIdx}): yüzOranı=${face.ratio.toFixed(3)} — kırpma gerekmiyor`);
      return { ...noCrop, faceRatio: face.ratio };
    }

    const { cropForFaceRatio, computeFaceCropGeometry } = require("./postProcess");
    const [cropped, geo] = await Promise.all([
      cropForFaceRatio(buf, face.box, face.ratio, TEMPLATE_TARGET_FACE_RATIO),
      computeFaceCropGeometry(buf, face.box, face.ratio, TEMPLATE_TARGET_FACE_RATIO),
    ]);
    if (!cropped || !geo) return { ...noCrop, faceRatio: face.ratio };
    console.log(`ŞABLON KIRPILDI (style=${styleId}, chunk=${chunkIdx}): yüzOranı ${face.ratio.toFixed(3)} -> hedef ${TEMPLATE_TARGET_FACE_RATIO}`);
    // Kırpma sonrası ETKİN oran hedeftir — kalite kapısı kırpılmış tuvale
    // baktığı için karşılaştırma da onunla yapılmalı.
    return {
      input: cropped, restore: { originalBuf: buf, geo },
      usable: true, faceRatio: TEMPLATE_TARGET_FACE_RATIO,
    };
  } catch (e) {
    console.error("Şablon hazırlama başarısız (orijinal kullanılıyor):", e.message || e);
    return noCrop;
  }
}

async function runOpenAiDirectChunk(uid, jobId, styleId, chunkIdx, templateUrls, refUrls, identityCaption, bodyCaption, bodyProfile, refDescriptor, jobRef, mode = PHOTO_MODE_FULL) {
  // Şablon bir kez hazırlanır (kırpma gerekiyorsa burada olur) ve tüm
  // denemelerde aynı tuval kullanılır — her retry'de yeniden kırpmak gereksiz.
  // `restore`: kırpma yapıldıysa, üretim bittikten sonra sonucu ORİJİNAL
  // (kırpılmamış) taban fotoğrafa geri yerleştirmek için gereken bilgi —
  // bkz. prepareTemplate ve aşağıdaki kaydetme adımı.
  //
  // YEDEK ŞABLON (2026-08-04): templateUrls = [birincil, yedek...]. Aday
  // sırayla denenir; KULLANILAMAZ olan atlanır (yüz yok ya da yüz çok küçük
  // — bkz. prepareTemplate). Hiçbiri uygun değilse birincil ile devam edilir:
  // üretimi bloklamak, kötü kare riskinden daha kötüdür (fail-safe).
  const urls = Array.isArray(templateUrls) ? templateUrls : [templateUrls];
  let nextCandidate = 0;
  const prepareNextUsable = async () => {
    while (nextCandidate < urls.length) {
      const p = await prepareTemplate(urls[nextCandidate++], styleId, chunkIdx);
      if (p.usable) return p;
    }
    return null;
  };

  let prepared = await prepareNextUsable();
  if (!prepared) {
    console.warn(`ŞABLON: hiçbir aday uygun değil (style=${styleId}, chunk=${chunkIdx}) — birincil ile devam ediliyor`);
    prepared = await prepareTemplate(urls[0], styleId, chunkIdx);
  }
  let { input: templateInput, restore, faceRatio: templateFaceRatio } = prepared;

  let finalBuf = null;
  for (let attempt = 1; attempt <= OPENAI_DIRECT_MAX_ATTEMPTS; attempt++) {
    // YENİDEN DENEME = YENİ ŞABLON (2026-08-04): eskiden her deneme AYNI
    // tuvali kullanıyordu. Sorun şablondan geliyorsa tekrar denemek boşuna —
    // gerçek örnek: 0.802 ve 0.800, iki denemede neredeyse aynı sonuç, çünkü
    // ikisi de arka plandaki yanlış kişiye kırpılmış aynı şablondu. Elde
    // yedek varsa artık onunla deneniyor.
    if (attempt > 1) {
      const next = await prepareNextUsable();
      if (next) {
        ({ input: templateInput, restore, faceRatio: templateFaceRatio } = next);
        console.log(`ŞABLON DEĞİŞTİRİLDİ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): önceki şablon kalite kapısını geçemedi, yedekle deneniyor`);
      }
    }
    const buf = await generateForMode(
      mode, templateInput, refUrls, identityCaption, bodyCaption, bodyProfile, styleId, chunkIdx,
      refDescriptor
    );
    if (!buf) {
      if (attempt < OPENAI_DIRECT_MAX_ATTEMPTS) continue;
      break;
    }

    // KALİTE KAPISI — fal webhook'uyla BİREBİR AYNI iki katman: önce kimlik+
    // netlik+kafa oranı (assessOutputFace), sonra onu geçenler için Vision
    // AI (assessOutputWithVision) — yüz şekli/dudak deformasyonu gibi
    // matematikle ölçülemeyen bozuklukları yakalar.
    //
    // SERTLEŞTİRME (2026-07-28): iki kontrol artık BAĞIMSIZ try/catch'lerde.
    // Eskiden ikisi TEK try bloğundaydı — assessOutputFace beklenmedik bir
    // hatayla patlarsa (gerçek örnek: output_format eksikliği yüzünden
    // OpenAI PNG döndürüyordu, jpeg-js "SOI not found" ile patlıyordu),
    // Vision kontrolü de HİÇ ÇALIŞMADAN chunk sessizce kabul ediliyordu —
    // yani TEK bir katmandaki hata İKİ katmanı da devre dışı bırakıyordu.
    // Şimdi bir katman patlarsa sadece O katman atlanır, diğeri yine çalışır.
    if (refDescriptor) {
      let mathOk = true;
      let mathDist = null;
      let mathReason = null;
      try {
        const { assessOutputFace } = require("./faceQuality");
        const q = await assessOutputFace(buf, refDescriptor, templateFaceRatio);
        mathOk = q.ok;
        mathDist = q.distance;
        mathReason = q.reason;
        // ÖLÇÜM (2026-07-28): GEÇEN kareler de loglanıyor. Eskiden sadece
        // elenenler loglanıyordu, bu yüzden "geçen bir kare hangi mesafedeydi"
        // sorusuna veri yoktu ve FACE_MATCH_THRESHOLD tahminle ayarlanıyordu.
        // Artık gerçek dağılım görülebilir -> eşik veriyle kalibre edilebilir.
        const d = q.distance != null ? q.distance.toFixed(3) : "null";
        const fr = q.faceRatio != null ? q.faceRatio.toFixed(3) : "null";
        const bs = q.blurScore != null ? q.blurScore.toFixed(1) : "null";
        // büyüme = çıktı yüz oranı / şablon yüz oranı (bkz.
        // OUTPUT_FACE_GROWTH_MAX). Eşiği veriyle kalibre edebilmek için
        // GEÇEN karelerde de loglanıyor.
        const gr = (templateFaceRatio && q.faceRatio)
          ? (q.faceRatio / templateFaceRatio).toFixed(2) : "null";
        const pd = q.profileDegree != null ? q.profileDegree.toFixed(2) : "null";
        console.log(`KALITE ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${q.ok ? "GEÇTİ" : "RED[" + q.reason + "]"} mesafe=${d} profil=${pd} yüzOranı=${fr} büyüme=${gr} netlik=${bs} eşik=${require("./faceQuality").FACE_MATCH_THRESHOLD}`);
      } catch (e) {
        console.error("OpenAI yolu: kimlik/netlik kontrolü hata verdi (bu katman atlanıyor, Vision yine çalışacak):", e);
      }
      // "no-face" AYRI ELE ALINIR (2026-07-30): bu, "kare bozuk" demek DEĞİL,
      // "yüz dedektörüm yüzü göremedi" demek. Gerçek örnek: güneş gözlüklü
      // Versailles şablonunda üretilen kare gözle GAYET İYİYDİ ama face-api
      // gözler kapalı olduğu için yüz noktalarını çıkaramadı ve kare boşuna
      // atıldı (bir üretim de boşa gitti). Artık böyle kareler doğrudan
      // elenmiyor, kararı GÖRÜNTÜYÜ GERÇEKTEN GÖREBİLEN Vision'a devrediyor.
      // "profile" AYNI MANTIKLA eklendi (2026-08-04): kafa yana dönükse
      // kimlik mesafesi pozu ölçer, kimliği değil — gerçek örnek: telefonuna
      // bakan profil kare, mesafe 0.802 ile elendi, kullanıcı 5 yerine 4 foto
      // aldı, oysa kare gözle gayet iyiydi. Bu da sert ret değil, Vision'a
      // devir sebebidir.
      const noFace = !mathOk && (mathReason === "no-face" || mathReason === "profile");
      if (!mathOk && !noFace) {
        await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
          mode, gate: `math-${mathReason || "?"}`, distance: mathDist,
        });
        if (attempt < OPENAI_DIRECT_MAX_ATTEMPTS) continue;
        break;
      }
      if (noFace) {
        const why = mathReason === "profile"
          ? `yüz PROFİLDEN görünüyor, kimlik mesafesi (${mathDist != null ? mathDist.toFixed(3) : "?"}) güvenilmez`
          : "yüz tespit edilemedi (gözlük/açı olabilir)";
        console.warn(`KALITE: ${why} — kare atılmıyor, karar Vision'a devredildi (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt})`);
      }

      let visionOk = true;
      let visionDetail = null;
      let visionReason = null;
      let visionInconclusive = true; // çağrı hiç yapılamazsa da kararsız sayılır
      try {
        // Referans selfie'ler de gönderiliyor -> Vision hat-sadakatini de
        // değerlendirebiliyor (bkz. assessOutputWithVision gerekçesi).
        const v = await assessOutputWithVision(buf, splitRefUrls(refUrls).faceUrls);
        visionOk = v.ok;
        visionDetail = v.detail;
        visionReason = v.reason;
        visionInconclusive = !!v.inconclusive;
        console.log(`VISION ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${v.ok ? (v.inconclusive ? "KARARSIZ(kabul)" : "GEÇTİ") : "RED[" + v.reason + "]"}${v.detail ? ` — "${v.detail}"` : ""}`);
      } catch (e) {
        console.error("OpenAI yolu: Vision kontrolü hata verdi (fail-safe kabul):", e);
      }

      // İKİ KAPI DA KÖR KALDIYSA kareyi kabul etmiyoruz: matematiksel kapı
      // yüzü görememiş VE Vision da karar verememişse elimizde hiçbir kanıt
      // yok. Böyle bir kareyi geçirmek, gerçekten bozuk (yüzsüz) bir görselin
      // kullanıcıya gitmesi riskini taşır — kanıtsızlıkta güvenli taraf ret.
      if (noFace && visionInconclusive) {
        console.warn(`KALITE: yüz tespit edilemedi VE Vision karar veremedi — kanıt yok, kare reddedildi (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt})`);
        await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
          mode, gate: "math-no-face+vision-inconclusive", distance: null,
        });
        if (attempt < OPENAI_DIRECT_MAX_ATTEMPTS) continue;
        break;
      }
      // Sayısal ölçüm hakem: kimlik mesafesi açıkça iyiyse Vision'ın "farklı
      // kişi" reddi geçersiz sayılır (bkz. visionRejectionOverridden).
      if (!visionOk && visionRejectionOverridden(visionReason, mathDist)) {
        console.warn(`VISION REDDİ GEÇERSİZ SAYILDI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): mesafe=${mathDist.toFixed(3)} < ${VISION_OVERRIDE_MAX_DISTANCE} — Vision "${visionDetail || "identity"}" demişti, sayısal kanıt güçlü olduğu için kare KABUL edildi`);
        visionOk = true;
      }
      if (!visionOk) {
        await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
          mode, gate: `vision-${visionReason || "?"}`, distance: mathDist, detail: visionDetail,
        });
        if (attempt < OPENAI_DIRECT_MAX_ATTEMPTS) continue;
        break;
      }
    }

    finalBuf = buf;
    break;
  }

  if (!finalBuf) {
    await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
    return;
  }

  try {
    const { addPhoneCameraTexture, recompositeIntoOriginal } = require("./postProcess");

    // GERİ YERLEŞTİRME: kalite kapısı KIRPILMIŞ (yüze yakın) tuval üzerinde
    // çalıştı — yüz oranı/kimlik ölçümü ve Vision karşılaştırması bunu
    // gerektiriyor, geniş orijinal tuvalde yüz çok küçük kalırdı. Kare
    // KABUL edildikten SONRA, kırpma yapılmışsa sonuç orijinal (kırpılmamış)
    // taban fotoğrafa geri yerleştirilir — böylece taban fotoğrafın arka
    // planı/kompozisyonu HİÇBİR ZAMAN kırpılmış hâliyle kullanıcıya gitmez.
    let deliverBuf = finalBuf;
    if (restore) {
      const recomposited = await recompositeIntoOriginal(finalBuf, restore.originalBuf, restore.geo);
      if (recomposited) {
        deliverBuf = recomposited;
        console.log(`ŞABLON GERİ YERLEŞTİRİLDİ (style=${styleId}, chunk=${chunkIdx}): orijinal boyuta döndürüldü`);
      } else {
        console.warn(`ŞABLON GERİ YERLEŞTİRME BAŞARISIZ (style=${styleId}, chunk=${chunkIdx}) — kırpılmış sonuç kullanılıyor`);
      }
    }

    const textured = await addPhoneCameraTexture(deliverBuf);
    const path = `dating_results/${uid}/${jobId}/${styleId}_${chunkIdx}_0.jpg`;
    await bucket().file(path).save(textured, { metadata: { contentType: "image/jpeg" } });
    await finalizeChunk(uid, jobId, styleId, chunkIdx, { photoUrls: [`gs://${bucket().name}/${path}`] });
  } catch (e) {
    console.error("OpenAI yolu: sonuç kaydetme hatası:", e);
    await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
  }
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
    const { jobId, bodyProfile } = request.data || {};
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
      // NOT (2026-07-27): daha önce burada en net yüzden kırpılmış ek bir
      // referans (faceCropUrl, postProcess.cropFaceRegion) üretilip listenin
      // başına ekleniyordu. KALDIRILDI — kırpılmış kare doğal bir fotoğraf
      // değil, modele yapay/parçalı bir görüntü veriyordu ve model bunun
      // zoom seviyesini yanlışlıkla ölçek referansı sanıp kafayı büyütme gibi
      // artefaktlara yol açabiliyordu (bkz. OpenAI-direct yolunda aynı
      // sebeple primaryFaceUrl'in zaten crop KULLANMAMASI). Artık HER İKİ
      // üretim yolu da (fal + OpenAI-direct) SADECE kullanıcının orijinal,
      // kırpılmamış fotoğraflarını (orderedRefUrls) kullanıyor.
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("Yüz kontrolü başarısız (kimlik kapısı devre dışı, üretim engellenmiyor):", e);
    }

    // Gemini ön-işlem (fail-safe): tam boy beden tarifi.
    //
    // identityCaption KALDIRILDI (2026-08-02, kullanıcı kararı): Gemini'nin
    // yüz/ten/yaş tarifini prompt'a ekleyen bu adım hem yavaşlık riski
    // taşıyordu (3 model sırayla deneniyordu, gerçek olayda tek bir modelin
    // cevabı 1dk45sn sürüp "deadline exceeded"e yol açtı) hem de üretilen
    // tarifler sıklıkla kırık/kullanılamaz çıkıyordu (bkz. isUsableCaption).
    // Kimlik artık YALNIZCA referans fotoğrafların kendisinden geliyor —
    // OpenAI zaten görselleri doğrudan görüyor, ayrı bir metin tarifine
    // ihtiyaç yok. bodyCaption KORUNDU: boy/beden seçimi zaten kullanıcının
    // formundan (bodyProfile) geliyor ve öncelikli sayılıyor (bkz.
    // shortBodyNote), bodyCaption yalnızca tam cümleyse ek bilgi olarak
    // ekleniyor — riski aynı ama katkısı identityCaption'dan farklı ve
    // ikincil konumda olduğu için tutuldu.
    // styleWardrobes de KALDIRILDI: hiçbir prompt fonksiyonuna hiç
    // geçmiyordu, yalnızca Firestore'a yazılıp duran kullanılmayan bir
    // Gemini çağrısıydı.
    let bodyCaption = null;
    try {
      const { describeBodyBuild } = require("./identityCaption");
      const bodyBuffer = refBuffers.length > FACE_PHOTO_COUNT
        ? refBuffers[refBuffers.length - 1]
        : null;
      bodyCaption = await describeBodyBuild(bodyBuffer);
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
      // Face swap kaynağı: ilk kare = ön yüz (çekim sırası ön/sağ/sol/tamboy).
      // Swap cepheden en iyi çalıştığı için ön kareyi kullanıyoruz (bkz.
      // falInferenceWebhook + faceSwap). fal CDN kopyası; Storage silinse de kalır.
      ...(refUrls[0] ? { primaryFaceUrl: refUrls[0] } : {}),
      ...(refDescriptor ? { refDescriptor } : {}),
      ...(bodyCaption ? { bodyCaption } : {}),
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
  // OpenAI doğrudan yolu (bkz. runOpenAiDirectChunk) bu fonksiyonun İÇİNDE
  // senkron olarak tamamlanıyor (webhook yok) — kimlik kapısı için tfjs/
  // face-api yükleniyor (2GiB gerektiriyor, bkz. faceQuality.js diğer
  // kullanımları) ve OpenAI üretimi + olası 429 backoff'ları zaman alabilir.
  {
    secrets: [FAL_KEY, OPENAI_KEY],
    region: "europe-west1",
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { styles, jobId, model, mode } = request.data || {};
    if (!Array.isArray(styles) || styles.length === 0 || !jobId) {
      throw new HttpsError("invalid-argument", "styles ve jobId zorunlu.");
    }
    const invalidStyle = styles.find((s) => !STYLE_SCENES[s]);
    if (invalidStyle) {
      throw new HttpsError("invalid-argument", `Bilinmeyen stil: ${invalidStyle}`);
    }
    // Tek buton bu alanı 'gpt-image-2' gönderir -> useOpenAiDirect=true,
    // doğrudan OpenAI'ye gider (bkz. OPENAI_MODEL_ID tanımı). MODEL_CATALOG
    // içindeki "gpt-image-2" girdisi (fal-wrapped, artık kullanılmıyor) bu
    // kontrolü zaten geçirdiği için ayrıca eklemeye gerek yok.
    if (model !== undefined && !MODEL_CATALOG[model]) {
      throw new HttpsError("invalid-argument", `Bilinmeyen model: ${model}`);
    }
    const modelId = model || DEFAULT_MODEL_ID;
    // Prompt stratejisi (bkz. PHOTO_MODES). Yalnızca OpenAI doğrudan yolunda
    // anlamlı; fal yolu her zaman kapsamlı buildEditPrompt kullanır.
    if (mode !== undefined && !PHOTO_MODES.includes(mode)) {
      throw new HttpsError("invalid-argument", `Bilinmeyen mod: ${mode}`);
    }
    const photoMode = mode || PHOTO_MODE_FULL;

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
    // Kişi-değişimi edit'i için kullanıcı referansları + kimlik/beden metni.
    const identityCaption = prepData.identityCaption || null;
    const bodyCaption = prepData.bodyCaption || null;
    const bodyProfile = prepData.bodyProfile || {};
    const refDescriptor = prepData.refDescriptor || null; // OpenAI yolunda kimlik kapısı için

    // TABAN GÖRSELLERİ bakiye DÜŞÜLMEDEN önce seç (havuz boşsa kredi
    // harcanmadan net hata). Kategoriler kaldırıldı (2026-08-02): tek düz
    // havuzdan, kullanıcının ÖNCEKİ işlerinde kullanılmamışlara öncelik
    // vererek seçilir — bkz. pickTemplatesFromPool / recentTemplateNames.
    // BOY BANDI (2026-08-02): kullanıcının seçtiği boya uygun alt klasör
    // varsa yalnızca oradan seçilir — bkz. listTemplateFiles / HEIGHT_RANGE_TO_BAND.
    const { files, band: templateBand } = await listTemplateFiles(bodyProfile.heightRange);
    if (files.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        `Taban görsel havuzu boş. Firebase Storage'da ${TEMPLATE_ROOT}/ ` +
        `klasörüne (veya boy bantlarına: ${TEMPLATE_HEIGHT_BANDS.join(" / ")}) ` +
        `AI ile üretilmiş taslak görseller yükle.`
      );
    }
    console.log(
      `ŞABLON HAVUZU: ${files.length} görsel` +
      (templateBand ? ` (boy bandı=${templateBand}, boy=${bodyProfile.heightRange})`
                    : ` (bant yok — tüm havuz, boy=${bodyProfile.heightRange || "belirtilmemiş"})`)
    );
    const recentNames = await recentTemplateNames(uid);
    // Her chunk için İKİ YEDEK şablon da seçilir. İki ayrı işe yararlar:
    //  1) birincil KULLANILAMAZSA (yüz yok / yüz çok küçük) atlanıp yedeğe
    //     geçilir — bkz. prepareTemplate,
    //  2) bir deneme kalite kapısını geçemezse SONRAKİ deneme yeni bir
    //     şablonla yapılır — aynı bozuk şablonla tekrar denemek boşuna.
    // İki yedek, "birincil kullanılamaz + ilk deneme de başarısız" durumunda
    // bile 2. denemeye taze bir şablon kalmasını garanti eder.
    // Yedekler ayrı tutulur; lockedCount ve ücretsiz-deneme hesabı yalnızca
    // BİRİNCİL listeye bakar, yedeklerin varlığı bu sayıları değiştirmez.
    const templatesByStyle = {};
    const sparesByStyle = {};
    for (const styleId of styles) {
      const all = pickTemplatesFromPool(files, jobId, IMAGES_PER_STYLE * 3, recentNames);
      templatesByStyle[styleId] = all.slice(0, IMAGES_PER_STYLE);
      sparesByStyle[styleId] = all.slice(IMAGES_PER_STYLE);
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
        model: modelId, // hangi model kullanıldı — izleme/karşılaştırma için
        photoMode, // hangi prompt stratejisi — A/B karşılaştırması için
      }, { merge: true });
    });

    // TEKRAR AÇILDI (2026-07-27): tek "Fotoğraflarımı Oluştur" butonu artık
    // fal.ai SARMALAMASI değil, doğrudan OpenAI'nin kendi API'sine gidiyor
    // (bkz. runOpenAiDirectChunk — artık kapsamlı buildEditPrompt + fal
    // yoluyla AYNI referans seti + AYNI iki katmanlı kalite kapısını
    // kullanıyor). MODEL_CATALOG'daki "gpt-image-2" (fal-ai/gpt-image-2/edit)
    // girdisi SİLİNMEDİ, sadece kullanılmıyor — geri dönmek istenirse bu
    // satır `false` yapılabilir.
    const useOpenAiDirect = modelId === OPENAI_MODEL_ID;

    // TEKRAR FİLTRESİ İÇİN GEÇMİŞ (2026-08-02): bu işte GERÇEKTEN üretilen
    // taban görsellerin adları kaydedilir; sonraki işler bunları eleyerek
    // seçim yapar (bkz. recentTemplateNames). Ücretsiz denemede yalnızca
    // üretilen ilk kare sayılır — kilitli kalanlar "görülmüş" değildir.
    const usedTemplateNames = [
      ...new Set(
        styles.flatMap((styleId) => {
          const full = templatesByStyle[styleId];
          const gen = usedFreeTier ? full.slice(0, FREE_TIER_CHUNK_COUNT) : full;
          return gen.map((f) => f.name);
        })
      ),
    ];
    await jobRef.set({ templateNames: usedTemplateNames }, { merge: true });

    try {
      if (useOpenAiDirect) {
        // OPENAI DOĞRUDAN YOLU — webhook YOK. Her chunk için önce 'pending'
        // kaydı yazılır (finalizeChunk'ın idempotent guard'ı bunu bekliyor —
        // bkz. finalizeChunk), SONRA üretim TAM OLARAK burada, senkron
        // bekleniyor (webhook'un yapacağı işi runOpenAiDirectChunk yapıyor).
        // Fonksiyon bu Promise.all bitmeden dönmez — bkz. onCall timeoutSeconds.
        await Promise.all(styles.map(async (styleId) => {
          const fullPicked = templatesByStyle[styleId];
          // Ücretsiz denemede sadece İLK chunk üretilir; kalanı hiç
          // ÇALIŞTIRILMAZ (API maliyeti yok) — "chunks" haritasına da
          // GİRMEZ ki finalizeChunk'ın "tüm chunk'lar bitti mi" kontrolü
          // yalnızca gerçekten üretilenleri beklesin. Kilitli kalan sayısı
          // ayrı bir alanda (lockedCount) saklanır — istemci kilit/"paket al"
          // kartlarını buradan gösterir.
          const picked = usedFreeTier ? fullPicked.slice(0, FREE_TIER_CHUNK_COUNT) : fullPicked;
          const lockedCount = fullPicked.length - picked.length;
          const initialChunks = Object.fromEntries(
            picked.map((_, i) => [String(i), { photoUrls: [], status: "pending", retries: 0 }])
          );
          await jobRef.set({
            results: { [styleId]: {
              status: "pending", photoUrls: [], chunks: initialChunks,
              ...(lockedCount > 0 ? { lockedCount } : {}),
            } },
          }, { merge: true });

          const spares = sparesByStyle[styleId] || [];
          await Promise.all(picked.map(async (file, i) => {
            // [birincil, yedek1, yedek2] — her chunk'ın KENDİ yedekleri var
            // (i ve IMAGES_PER_STYLE+i konumları), böylece paralel çalışan
            // chunk'lar aynı yedeğe düşüp aynı kareyi üretmez.
            const candidates = [file, spares[i], spares[IMAGES_PER_STYLE + i]].filter(Boolean);
            const urls = await Promise.all(candidates.map(signedDownloadUrl));
            await runOpenAiDirectChunk(
              uid, jobId, styleId, i, urls, refUrls, identityCaption,
              bodyCaption, bodyProfile, refDescriptor, jobRef, photoMode
            );
          }));
        }));
      } else {
        // fal.ai YOLU — submit hızlı döner, webhook sonuçlandırıyor.
        await Promise.all(styles.map(async (styleId) => {
          const fullPicked = templatesByStyle[styleId];
          const picked = usedFreeTier ? fullPicked.slice(0, FREE_TIER_CHUNK_COUNT) : fullPicked;
          const lockedCount = fullPicked.length - picked.length;
          const submissions = await Promise.all(
            picked.map(async (file, i) => {
              const templateUrl = await signedDownloadUrl(file);
              const falJob = await submitStyleJob(
                uid, jobId, styleId, i, templateUrl, refUrls, identityCaption, bodyCaption, bodyProfile, modelId
              );
              return [String(i), {
                requestId: falJob.request_id,
                photoUrls: [],
                status: "pending",
                retries: 0,
              }];
            })
          );
          const chunks = Object.fromEntries(submissions);
          await jobRef.set({
            results: { [styleId]: {
              status: "pending", photoUrls: [], chunks,
              ...(lockedCount > 0 ? { lockedCount } : {}),
            } },
          }, { merge: true });
        }));
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
 * çağrılır. Çıktıyı indirir, KİMLİK KAPISINDAN geçirir (job.refDescriptor ile
 * karşılaştırma — bkz. faceQuality.matchesIdentity), geçemezse chunk'ı
 * otomatik yeniden üretir. Geçenlere hafif post-processing (film grain +
 * gerçekçi JPEG sıkıştırma, bkz. postProcess.js) uygulanıp Storage'a yazılır.
 * Bir stilin TÜM chunk'ları bitince sonuçlar birleştirilir (bkz. finalizeChunk).
 */
exports.falInferenceWebhook = onRequest(
  {
    // FAL_KEY: otomatik yeniden üretim fal'a yeni iş gönderir.
    // OPENAI_KEY: Vision AI kalite kontrolü (bkz. assessOutputWithVision).
    secrets: [FAL_KEY, OPENAI_KEY],
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

    // Kuyruğa giden iş = FACE SWAP (bkz. submitStyleJob). Dönen payload
    // swap'lenmiş görseli taşır. easel-ai TEKİL { image: {...} } döndürür;
    // nano-banana döneminden kalan { images: [...] } biçimini de defansif
    // destekle (yanlış parse'da chunk fail-safe biter, sonsuz döngü YOK çünkü
    // MAX_CHUNK_RETRIES=0).
    const payload = req.body?.payload || {};
    const images = Array.isArray(payload.images) && payload.images.length
      ? payload.images
      : (payload.image && payload.image.url ? [payload.image] : []);
    if (images.length === 0) {
      console.error(`fal.ai OK döndü ama görsel yok (style=${styleId}, chunk=${chunkIdx}):`,
        JSON.stringify(payload).slice(0, 400));
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }
    // Swap zaten kuyrukta yapıldı — burada sadece indir (webhook'ta ek swap YOK).
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
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      res.status(200).send("ok");
      return;
    }

    // KALİTE KAPISI (birleşik): her chunk tam olarak 1 görsel ürettiği için
    // ("num_images:1"), bu görsel kimlik + netlik + kafa oranı kontrolünden
    // geçmezse KULLANICIYA HİÇ GÖSTERİLMEDEN chunk BİR KEZ yeniden üretilir
    // (bkz. faceQuality.assessOutputFace, maybeRetryBadChunk). Fail-safe:
    // refDescriptor yoksa ya da kontrolün kendisi hata verirse filtre
    // uygulanmaz — üretim asla bu ikincil kapı yüzünden bloklanmaz.
    let passed = downloaded;
    let checked = null;
    if (job.refDescriptor) {
      try {
        const { assessOutputFace } = require("./faceQuality");
        checked = await Promise.all(downloaded.map(async (d) => {
          const q = await assessOutputFace(d.buf, job.refDescriptor);
          return { ...d, ...q };
        }));
        // "no-face" doğrudan elenmez, kararı Vision'a devreder (bkz. OpenAI
        // yolundaki aynı gerekçe: gözlük/açı yüzünden dedektörün yüzü
        // görememesi, karenin bozuk olduğu anlamına gelmiyor).
        passed = checked.filter((d) => d.ok || d.reason === "no-face");
        // ÖLÇÜM: geçen kareler de loglanıyor (eşiği veriyle kalibre edebilmek
        // için — bkz. OpenAI yolundaki aynı gerekçe).
        console.log(`KALITE ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, eşik=${require("./faceQuality").FACE_MATCH_THRESHOLD}): ` +
          checked.map((d) => (d.ok ? "GEÇTİ" : (d.reason === "no-face" ? "YÜZ YOK→Vision'a" : `RED[${d.reason}]`)) +
            `(mesafe=${d.distance != null ? d.distance.toFixed(3) : "null"}` +
            ` yüzOranı=${d.faceRatio != null ? d.faceRatio.toFixed(3) : "null"}` +
            ` netlik=${d.blurScore != null ? d.blurScore.toFixed(1) : "null"})`).join(", "));

        // İKİNCİ KATMAN — VISION: matematiksel kapıyı geçen kareler gpt-4o
        // vision'a gönderilir. TÜM yüz selfie'leri (3 açı) DE gönderilir,
        // böylece Vision "aynı kişi mi?" sorusunu üç açıdan karşılaştırarak
        // yanıtlar (bkz. assessOutputWithVision). Maliyet SADECE buraya kadar
        // gelen karelere ödenir. Fail-safe: hata durumunda ok:true döner,
        // iyi kareler asla boşuna elenmez.
        if (passed.length > 0) {
          const refFaces = splitRefUrls(job.falRefUrls).faceUrls;
          const visionChecked = await Promise.all(passed.map(async (d) => ({
            d, v: await assessOutputWithVision(d.buf, refFaces),
          })));
          // Sayısal ölçüm hakem: kimlik mesafesi açıkça iyiyse Vision'ın
          // "farklı kişi" reddi geçersiz sayılır (bkz. visionRejectionOverridden).
          for (const x of visionChecked) {
            if (!x.v.ok && visionRejectionOverridden(x.v.reason, x.d.distance)) {
              console.warn(`VISION REDDİ GEÇERSİZ SAYILDI (style=${styleId}, chunk=${chunkIdx}): mesafe=${x.d.distance.toFixed(3)} < ${VISION_OVERRIDE_MAX_DISTANCE} — Vision "${x.v.detail || "identity"}" demişti, kare KABUL edildi`);
              x.v = { ...x.v, ok: true, overridden: true };
            }
            // İki kapı da kör kaldıysa (yüz tespit edilemedi VE Vision karar
            // veremedi) kanıt yok — güvenli taraf ret.
            if (x.v.ok && x.v.inconclusive && x.d.reason === "no-face") {
              console.warn(`KALITE: yüz tespit edilemedi VE Vision karar veremedi — kanıt yok, kare reddedildi (style=${styleId}, chunk=${chunkIdx})`);
              x.v = { ...x.v, ok: false, reason: "no-evidence" };
            }
          }
          const visionPassed = visionChecked.filter((x) => x.v.ok).map((x) => x.d);
          console.log(`VISION ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}): ` +
            visionChecked.map((x) => (x.v.ok ? (x.v.overridden ? "GEÇTİ(hakem)" : "GEÇTİ") : `RED[${x.v.reason}]`) +
              (x.v.detail ? ` — "${x.v.detail}"` : "")).join(", "));
          // Reddedilenleri teşhis için sakla (fal yolu; bkz. saveRejectedFrame).
          for (const x of visionChecked) {
            if (!x.v.ok) {
              await saveRejectedFrame(uid, jobId, styleId, chunkIdx, 1, x.d.buf, {
                mode: "fal", gate: `vision-${x.v.reason || "?"}`,
                distance: x.d.distance, detail: x.v.detail,
              });
            }
          }
          passed = visionPassed;
        }
      } catch (e) {
        console.error("Kalite kontrolü başarısız (filtresiz devam ediliyor):", e);
        passed = downloaded;
        checked = null;
      }
    }

    if (passed.length === 0) {
      // Kalite kapısını geçemedi — BİR KEZ yeniden üret (chunk başına en fazla
      // 1 ek üretim ücreti; sonsuz döngü YOK, badRetried bayrağı). Bu, "best-
      // of-N her kare 3x üret" yerine seçilen maliyet-etkin yol: yalnızca
      // GERÇEKTEN bozuk çıkan kareler için ekstra ödenir. Genel
      // MAX_CHUNK_RETRIES=0 (maybeRetryChunk) politikasından AYRI ve ondan
      // önce denenir.
      if (await maybeRetryBadChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef)) {
        res.status(200).send("yeniden üretiliyor (kalite kapısı)");
        return;
      }
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
 * Chunk retry — ARTIK DEVRE DIŞI (MAX_CHUNK_RETRIES=0, tek deneme politikası,
 * bkz. o sabitin açıklaması). Her zaman false döner: başarısız chunk doğrudan
 * finalizeChunk({failed}) ile sonlandırılır, paket kredisi iade edilir. Retry
 * yeniden bir face-swap işi başlatmak demektir ve swap altyapısı o an sorunlu
 * ise sadece boşa kredi yakar (bkz. 2026-07-22 olayı). İmza korunuyor ki
 * çağıran taraflar değişmesin.
 */
async function maybeRetryChunk() {
  return false;
}

/**
 * KALİTE KAPISINI geçemeyen (kimlik / netlik / kafa oranı — bkz.
 * faceQuality.assessOutputFace) bir chunk için SINIRLI (chunk başına EN FAZLA
 * 1 kez) yeniden deneme. maybeRetryChunk'tan (genel politika, hep false)
 * BİLİNÇLİ olarak AYRI tutuldu:
 *  - Kullanıcının seçtiği maliyet-etkin yaklaşım: her kareyi 3x üretmek
 *    (best-of-N) yerine, yalnızca GERÇEKTEN bozuk çıkan kareler 1 kez daha
 *    denenir. Ortalama maliyet ~1.2-1.5x (3x değil).
 *  - Kredi riski SINIRLI ve ÖNGÖRÜLEBİLİR: chunk başına en fazla 1 ek üretim
 *    ücreti (~$0.05), `badRetried` bayrağıyla sonsuz döngü imkansız (bkz.
 *    2026-07-22 kredi yakma olayı — o olayda sınırsız/kontrolsüz retry vardı,
 *    bu FARKLI: tek seferlik, kalite kapısına bağlı).
 * Firestore'daki chunk kaydı templateUrl SAKLAMIYOR — taban görsel,
 * pickTemplatesFromPool'un jobId+styleId'den türeyen DETERMİNİSTİK
 * tohumlaması sayesinde burada yeniden hesaplanıyor (aynı girdiyle her zaman
 * aynı dosya/sırayı üretir). Yeni bir seed (submitStyleJob içinde rastgele)
 * kullanıldığı için tekrar denemede farklı/daha iyi bir kare çıkma şansı var.
 */
async function maybeRetryBadChunk(uid, jobId, styleId, chunkIdx, chunk, job, jobRef) {
  if (chunk.badRetried) return false; // hakkı zaten kullanılmış

  // Idempotency: webhook aynı isteği birden çok kez gönderebilir — bayrağı
  // transaction içinde TEK sefer işaretle, aynı anda iki retry tetiklenmesin.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return false;
    const d = snap.data();
    const c = d.results?.[styleId]?.chunks?.[chunkIdx];
    if (!c || c.badRetried || c.status === "done" || c.status === "failed") {
      return false;
    }
    tx.set(jobRef, {
      results: { [styleId]: { chunks: { [chunkIdx]: { ...c, badRetried: true } } } },
    }, { merge: true });
    return true;
  });
  if (!claimed) return false;

  try {
    // Taban görsel ARTIK yeniden hesaplanamaz: seçim havuzun anlık içeriğine
    // ve kullanıcının geçmişine bağlı (bkz. pickTemplatesFromPool) — aynı
    // tohum aynı dosyayı garanti etmiyor. Bu yüzden işin kendi kaydındaki
    // templateNames kullanılıyor (startPhotoGeneration yazıyor).
    const names = Array.isArray(job.templateNames) ? job.templateNames : [];
    const name = names[Number(chunkIdx)];
    const file = name ? bucket().file(name) : null;
    const refUrls = job.falRefUrls;
    if (!file || !Array.isArray(refUrls) || refUrls.length === 0) {
      console.error(`Kalite retry: taban görsel/referans yeniden kurulamadı (style=${styleId}, chunk=${chunkIdx})`);
      return false;
    }
    const templateUrl = await signedDownloadUrl(file);
    const modelId = job.model || DEFAULT_MODEL_ID;
    const falJob = await submitStyleJob(
      uid, jobId, styleId, chunkIdx, templateUrl, refUrls,
      job.identityCaption || null, job.bodyCaption || null, job.bodyProfile || {}, modelId
    );
    await jobRef.set({
      results: { [styleId]: { chunks: { [chunkIdx]: {
        ...chunk, badRetried: true, requestId: falJob.request_id,
        status: "pending", photoUrls: [],
      } } } },
    }, { merge: true });
    console.warn(`Kalite retry tetiklendi (style=${styleId}, chunk=${chunkIdx}), yeni requestId=${falJob.request_id}`);
    return true;
  } catch (e) {
    console.error("Kalite retry'i başarısız (chunk düşürülüyor):", e);
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

      // EKSİK TESLİM = HAK İADESİ (2026-08-04). Bir stil "done" sayılıyordu
      // ve iade almıyordu, tek bir fotoğraf bile üretilmişse — yani 5 fotoluk
      // ödeme yapıp 4 alan kullanıcı hiçbir şey geri almıyordu. Artık teslim
      // edilen foto sayısı BEKLENENDEN azsa o stilin birimi geri veriliyor;
      // kullanıcı 5 fotoyu baştan üretebiliyor.
      //
      // "Beklenen" = o stil için AÇILAN chunk sayısı. Bu tanım ücretsiz
      // denemeyi ve kilitli fotoğrafları doğru şekilde dışarıda bırakır:
      // ücretsiz denemede zaten yalnızca FREE_TIER_CHUNK_COUNT kadar chunk
      // açılıyor (kilitli 4 foto hiç chunk değil), dolayısıyla 1/1 teslim
      // "tam" sayılır. Ayrıca packUnitsCharged>0 koşulu, ücretsiz denemede
      // (charged=0) iade yapılmasını ayrıca engeller.
      const expectedChunkCount = (k) => {
        if (k === styleId) return chunkKeys.length;
        const ch = (j.results || {})[k]?.chunks;
        return ch ? Object.keys(ch).length : 0;
      };
      const incompleteCount = Object.keys(results).filter((k) => {
        const r = results[k];
        if (r?.status !== "done" || !Array.isArray(r.photoUrls)) return false;
        const expected = expectedChunkCount(k);
        return expected > 0 && r.photoUrls.length < expected;
      }).length;

      if (successCount > 0) {
        // Kısmi başarı: üretilen stilleri göster. Başarısız VE eksik teslim
        // edilen stillerin birimleri iade edilir.
        const creditUnits = failedCount + incompleteCount;
        if (creditUnits > 0 && (j.packUnitsCharged || 0) > 0) {
          const refundUnits = Math.min(creditUnits, j.packUnitsCharged || 0);
          const walletSnap = await tx.get(walletRef);
          const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
          tx.set(walletRef, {
            photoBalance: (wallet.photoBalance || 0) + refundUnits,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          update.refundedUnits = refundUnits;
          if (incompleteCount > 0) {
            // İstemci bu alanı görüp kullanıcıya "hakkın iade edildi, tekrar
            // üretebilirsin" diyebilsin diye ayrıca işaretleniyor.
            update.incompleteDelivery = true;
            console.warn(
              `EKSİK TESLİM: ${incompleteCount} stil beklenenden az foto üretti ` +
              `— ${refundUnits} hak iade edildi (uid=${uid}, job=${jobId})`
            );
          }
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
