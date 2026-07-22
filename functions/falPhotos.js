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
// Stil başına üretilecek foto. Her biri FARKLI bir sahne varyantıdır (bkz.
// STYLE_SCENES) — aynı sahnenin 5 kopyası değil, 5 ayrı gerçek ortam.
const IMAGES_PER_STYLE = 5; // DatingConfig.photosPerSet ile senkron (ödenen vaat)
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

function buildPrompt(styleId, variantIdx, identityCaption, bodyProfile, extras = {}, jobId = "") {
  const scene = pickScene(styleId, jobId, variantIdx);
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
    "EXPRESSION: the person must NOT smile, grin, laugh or show teeth in this photo, or in ANY of the " +
    "photos in this set — no exceptions, even if the scene text above describes smiling, laughing or " +
    "grinning, and even if they are smiling in some of the reference photos. Give them a neutral, calm, " +
    "closed-mouth, naturally reserved expression instead — serious or thoughtful is correct, a slight " +
    "closed-mouth ease is fine, but never an open smile, grin or laugh.\n\n" +
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
    "SINGLE PERSON: this exact person must appear EXACTLY ONCE in the photo. Do not duplicate their " +
    "face or likeness onto anyone else in the scene — any other people in the background (passers-by, " +
    "other diners, other gym-goers, etc.) must be different, unrelated people, generic and not this " +
    "person's face. Do not create a mirror or reflection of them elsewhere in the frame either.\n\n" +
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
    "photos exactly, misaligned or wandering eye gaze, ANY smile, grin, laugh or visible teeth, a stiff " +
    "posed mannequin stance, heavy artistic background blur/bokeh that hides the " +
    "location, a flat/fake-looking backdrop with no real depth, a perfectly clean/curated backdrop, " +
    "professional editorial photography look, this person's face duplicated onto anyone else in the " +
    "scene, garbled or illegible fake text/lettering on any sign, menu, screen, watch face, book cover " +
    "or packaging visible in the frame (leave such surfaces blank, blurred-plain or genuinely readable " +
    "rather than inventing gibberish characters), overlaid UI text, watermark, distorted hands."
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

async function submitStyleJob(
  uid, jobId, styleId, chunkIdx, referenceImageUrls, seed,
  identityCaption, bodyProfile, promptExtras = {}
) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}&chunk=${chunkIdx}`;
  const input = {
    prompt: buildPrompt(styleId, chunkIdx, identityCaption, bodyProfile, {
      bodyCaption: promptExtras.bodyCaption || null,
      wardrobeNote: promptExtras.wardrobeNote || null,
    }, jobId),
    image_urls: referenceImageUrls,
    // Nano Banana Pro şeması: image_size YOK, aspect_ratio + resolution var.
    aspect_ratio: "3:4", // dikey dating fotoğrafı
    // 1K: 2K'nın ürettiği aşırı keskinlik/mikro-detay "hiperrealist/CGI"
    // hissine yol açabiliyordu — telefon fotoğrafları bu kadar keskin değil.
    resolution: "1K",
    num_images: 1,
    output_format: "jpeg",
    seed,
    // 1 = en katı, 6 = en gevşek. Girdi zaten Vision SafeSearch'ten geçti;
    // burada katı bir eşik meşru portrelerde boş sonuç üretiyordu.
    safety_tolerance: "4",
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
      // Face swap kaynağı: ilk kare = ön yüz (çekim sırası ön/sağ/sol/tamboy).
      // Swap cepheden en iyi çalıştığı için ön kareyi kullanıyoruz (bkz.
      // falInferenceWebhook + faceSwap). fal CDN kopyası; Storage silinse de kalır.
      ...(refUrls[0] ? { primaryFaceUrl: refUrls[0] } : {}),
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
    // FACE SWAP (2. aşama): üretilen sahnenin üstüne kullanıcının GERÇEK yüzünü
    // yerleştir. img.url zaten fal CDN'de public bir URL — doğrudan target_image
    // olarak geçilebilir, yeniden yüklemeye gerek yok.
    //
    // ÖNEMLİ: swap başarısız olursa görsel HAM (swap'siz) haliyle KULLANILMAZ —
    // null döner ve aşağıda filtrelenir. Bu görsel, tıpkı kimlik kapısını
    // geçemeyen bir görsel gibi "passed" listesine hiç girmez; mevcut
    // retry/finalizeChunk/iade mantığı (aşağıdaki "passed.length === 0" bloğu)
    // aynen devreye girer — kullanıcı asla kendi yüzü olmayan bir fotoğraf
    // görmez ve tüm retry hakları tükenirse o chunk/stil başarısız sayılıp
    // paket kredisi otomatik iade edilir (bkz. finalizeChunk).
    const swapGender = genderForSwap(job.bodyProfile);
    let downloaded = [];
    try {
      const attempts = await Promise.all(images.map(async (img, i) => {
        let sourceUrl = img.url;
        if (job.primaryFaceUrl) {
          const swappedUrl = await faceSwap(job.primaryFaceUrl, img.url, swapGender);
          if (!swappedUrl) {
            console.error(`face swap başarısız — görsel elendi (style=${styleId}, chunk=${chunkIdx}), swap'siz gösterilmeyecek`);
            return null;
          }
          sourceUrl = swappedUrl;
        }
        const imgResp = await fetch(sourceUrl);
        if (!imgResp.ok) throw new Error(`indirilemedi: ${imgResp.status}`);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        return { i, buf };
      }));
      downloaded = attempts.filter(Boolean);
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

    // FACE SWAP başarısız olup downloaded boş kaldıysa RETRY YAPILMAZ — bilerek.
    // Kimlik-kapısı reddinin aksine (yeni seed farklı/geçerli bir yüz üretebilir),
    // swap başarısızlığı genelde fal.ai swap altyapısının o an sorunlu/kapalı
    // olmasından kaynaklanır (bkz. 2026-07-22 olayı: "fetch failed" ile saatlerce
    // sürekli başarısız oldu). Yeni bir nano-banana-pro üretimi bu durumu
    // DÜZELTMEZ, sadece anlamsız yere ekstra üretim maliyeti (kredi) yakar.
    // Bu yüzden burada chunk DOĞRUDAN başarısız sayılır — job/stil seviyesindeki
    // mevcut otomatik iade (finalizeChunk) yine de devreye girer.
    if (downloaded.length === 0) {
      console.error(`face swap başarısız (retry yapılmadan chunk başarısız sayılıyor): style=${styleId}, chunk=${chunkIdx}`);
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
