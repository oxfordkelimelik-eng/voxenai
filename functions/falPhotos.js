const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const {
  admin, db, bucket,
  assertSafeId, enforceRateLimit, checkAppAttestation, signedDownloadUrl,
  PENDING_APPROVAL_WARN_MS, PENDING_APPROVAL_CANCEL_MS,
} = require("./_shared");

// HIZ SINIRLARI — her ikisi de GERÇEK PARA harcayan uç noktalar.
// Değerler normal kullanımın belirgin üstünde, otomatik istismarın belirgin
// altında: bir kullanıcı 10 fotoluk bir üretimi hazırlayıp başlatır, hata
// olursa birkaç kez tekrar dener. Saatte 10 hazırlık / 8 üretim bunu rahat
// karşılar; döngüye alınmış bir script ise ilk dakikada durur.
const RL_PREPARE = { max: 10, windowMs: 60 * 60 * 1000,
  message: "Çok fazla fotoğraf hazırlama isteği gönderdin. Bir saat sonra tekrar dene." };
const RL_GENERATE = { max: 8, windowMs: 60 * 60 * 1000,
  message: "Çok fazla üretim isteği gönderdin. Bir saat sonra tekrar dene." };

// NOT (2026-08-20): identityCaption.js (Gemini tabanlı caption üretimi) SİLİNDİ.
// Gemini projeden tamamen kaldırıldı; kimlik ve beden bilgisi artık yalnızca
// (a) kullanıcının referans fotoğrafları — OpenAI onları doğrudan görüyor — ve
// (b) kullanıcının formdaki boy/vücut tipi seçimi (bodyProfile) üzerinden gelir.

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
// TEST MODELİ (2026-09-26): "Fotoğraflarımı Oluştur Versiyon 2" butonu.
// Takma ad (gpt-image-2.5-sunburst) değil TARİHLİ sürüm: P800 ölçülerek
// ayarlandı, model OpenAI tarafında sessizce kayarsa karşılaştırma bozulur.
// Yalnızca ops hesabına açık (bkz. startPhotoGeneration).
const OPENAI_MODEL_V25_ID = "gpt-image-2.5-sunburst-2026-09-08";
// QWEN KALDIRILDI (2026-10-10, kullanıcı kararı: "3. buton olan qwen
// butonunu direkt kaldıralım"). Yüklü eski uygulama Versiyon 3 butonunda hâlâ
// bu kimlikleri gönderebilir; sunucu isteği Buton 1'e (gpt-image-2 + p800)
// çevirir (bkz. startPhotoGeneration).
const QWEN_LEGACY_MODEL_IDS = new Set(["qwen-image-2.1-pro", "qwen-image-2.0-pro-2026-06-22"]);
// Üretimi senkron bu fonksiyon içinde yapan modeller (webhook'suz yol).
const OPENAI_DIRECT_MODELS = new Set([OPENAI_MODEL_ID, OPENAI_MODEL_V25_ID]);
const OPS_ONLY_MODELS = new Set([OPENAI_MODEL_V25_ID]);
// opsPanel.js OPS_EMAIL ile EL İLE senkron (döngüsel require'dan kaçınmak için).
const OPS_EMAIL = "destek@voxenai.com.tr";
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
// 2026-10-07: "Versiyon 2" butonu — gpt-image-2 + kısa prompt (~300 kelime,
// bkz. buildEditPromptCompact). Buton 1 (p800) ile tek fark prompt.
const PHOTO_MODE_COMPACT = "compact";
const PHOTO_MODES = [
  PHOTO_MODE_FULL, PHOTO_MODE_STAGED, PHOTO_MODE_SHORT,
  PHOTO_MODE_P300, PHOTO_MODE_P800, PHOTO_MODE_P1400, PHOTO_MODE_COMPACT,
];
// Stil başına üretilecek foto. Her biri FARKLI bir sahne varyantıdır (bkz.
// STYLE_SCENES) — aynı sahnenin kopyası değil, ayrı gerçek ortamlar.
// STYLE_SCENES'te stil başına 20 varyant var, bu yüzden 10'a çıkmak
// (2026-08-12, eskiden 5) tekrarsız çeşitliliği bozmuyor — pickScene'in
// modulo'su 20'nin altında hiç devreye girmiyor.
// PAKET BOYLARI (2026-09-18) — DatingConfig.photoPackSizes ile EL İLE senkron.
// Bir iş TEK SEFERDE bu kadar foto üretir; 10'luk paket iki adet 5'lik üretim
// DEĞİLDİR (kullanıcı kararı). 25'lik pakette toplam süre 8-10 dakikayı
// bulabilir — istemci loader'ında bu uyarı gösteriliyor.
const PHOTO_PACK_SIZES = [5, 10, 25];

// FAZLA ÜRETİM + ELLE ONAY (2026-09-22, kullanıcı kararı).
//
// Kullanıcının SATIN ALDIĞI sayıdan fazlasını üretip, teslim edilecekleri
// ops panelinden ELLE seçiyoruz. Amaç: kalite kapılarının yakalayamadığı
// kusurlu kareler (kafa oranı, bakış, yumuşaklık — bkz. 2026-09-22 analizi)
// kullanıcıya hiç ulaşmasın.
//
// Üçünde de +5 kare üretilir; ölçülen maliyet ~$0.243/foto olduğuna göre iş
// başına ~$1.2 ek maliyet demek (5'lik pakette maliyet iki katına çıkar,
// 25'likte %20 artar).
//
// photoCount = kullanıcıya VAAT EDİLEN ve ÜCRETLENDİRİLEN sayı (bakiye,
// iade ve onay üst sınırı hep buna bakar). generateCount = arka planda
// üretilen sayı. İkisini ayrı tutmak şart: iade hesabı vaat edilene,
// üretim/chunk sayısı ise üretilene bakmak zorunda.
const PHOTO_PACK_OVERPRODUCTION = { 5: 10, 10: 15, 25: 30 };

// SÜRÜM KAPISI (2026-09-22): onay akışı yalnızca yeni istemcinin
// `holdForApproval: true` gönderdiği işlerde açılır. Bayrak yoksa eski
// davranış — vaat edilen kadar üretim, doğrudan dating_results, status=done.
// Böylece güncellenmemiş telefonlar hâlâ foto alır; yeni sürüm onay bekler.
/**
 * Mağaza inceleme (demo) hesabı mı? Liste kodda değil, Firestore
 * config/reviewDemo {emails: [...]} belgesinde — istemciler okuyamaz/yazamaz
 * (firestore.rules varsayılan red), hesap değişince deploy gerekmez.
 * Doğrulanmamış e-posta ya da okuma hatası = demo değil (onay akışı korunur).
 */
async function isReviewDemoAccount(auth) {
  const email = String((auth && auth.token && auth.token.email) || "").trim().toLowerCase();
  if (!email || !(auth.token.email_verified)) return false;
  try {
    const snap = await db.doc("config/reviewDemo").get();
    const list = snap.exists ? snap.get("emails") : null;
    return Array.isArray(list) && list.map((e) => String(e).trim().toLowerCase()).includes(email);
  } catch (e) {
    console.error("İnceleme hesabı listesi okunamadı (onay akışı korunuyor):", e.message || e);
    return false;
  }
}

function generateCountFor(photoCount, holdForApproval = false) {
  if (!holdForApproval) return photoCount;
  return PHOTO_PACK_OVERPRODUCTION[photoCount] || photoCount;
}

// İş, üretim bittiğinde DOĞRUDAN "done" olmaz: önce bu duruma geçer ve
// ops panelinden onaylanana kadar burada bekler. Kullanıcı bu aşamada
// hiçbir kare görmez (kareler staging yolunda, bkz. deliverPhotoPath).
// Yalnızca holdForApproval=true işlerde kullanılır.
const JOB_STATUS_PENDING_APPROVAL = "pendingApproval";

/**
 * Üretilen karenin yazılacağı Storage yolu.
 *
 * holdForApproval=true  → dating_staging (kullanıcı okuyamaz; onay kopyalar)
 * holdForApproval=false → dating_results (eski doğrudan teslim)
 *
 * Staging gerekçesi (2026-09-22): Firestore private/** + Storage
 * dating_results/{uid}/** kullanıcıya açık; üretimi results'a yazıp UI'da
 * filtrelemek elenen kareleri teknik olarak bırakırdı. Onaylananlar
 * opsApprovePhotos ile dating_results'a kopyalanır.
 */
function deliverPhotoPath(uid, jobId, styleId, chunkIdx, i, holdForApproval = false) {
  const root = holdForApproval ? "dating_staging" : "dating_results";
  return `${root}/${uid}/${jobId}/${styleId}_${chunkIdx}_${i}.jpg`;
}

/** @deprecated — deliverPhotoPath(..., true) ile aynı; test/eski çağrılar. */
function stagingPhotoPath(uid, jobId, styleId, chunkIdx, i) {
  return deliverPhotoPath(uid, jobId, styleId, chunkIdx, i, true);
}
// Sonuç haritasındaki tek kova anahtarı (stil kalktı). Eski istemciler
// results[styleId] okuduğu için o istekte anahtar styleId olarak korunur —
// bkz. startPhotoGeneration'daki bucketId.
const PHOTO_BUCKET_ID = "photos";
// Eski istemci `styles: [...]` gönderdiğinde stil başına kaç foto sayılacağı.
// Eski dünyada 1 stil = 10 foto idi; bu sabit yalnızca o çeviri için var.
const LEGACY_PHOTOS_PER_STYLE = 10;
// Ücretsiz ilk deneme artık TÜM stili (10 foto) değil, tek bir stildeki TEK
// fotoğrafı üretir — kalanı hiç ÜRETİLMEZ (kilitli kalır, API maliyeti
// yok). Kullanıcı paket alıp tekrar "Oluştur"a basınca YENİ bir iş tam
// IMAGES_PER_STYLE ile çalışır. Bkz. startPhotoGeneration + finalizeChunk.
const FREE_TIER_CHUNK_COUNT = 1;
// Kullanıcıdan istenen referans: 3 canlı yüz (ön/sağ/sol). Flutter
// DatingConfig.faceCaptureCount ile senkron.
// GÖĞÜS-ÜSTÜ 2 KARE KALDIRILDI (2026-09-06, kullanıcı kararı) — gerekçe
// faceQuality.js'in başındaki notta. Özet: o kareleri okuyan tek yer üretim
// prompt'uydu, çıktıyı eleyen hiçbir kapı onlara bakmıyordu ve kafa oranı
// kararını taban fotoğrafla çelişkiye sokuyorlardı.
//
// 5 SELFIE (2026-10-08, kullanıcı kararı): ön, hafif sağ, hafif sol, tam sağ,
// tam sol. Model kafa yönünü selfie'den alıyor; şablon açısına yakın bir
// selfie olunca (bkz. orderRefsByPose) bakış ilk denemede doğru çıkıyor —
// 3 açıyla (0.05/0.76/0.77) yarı-profil şablonlara yakın kare yoktu.
// Mağazadaki eski uygulama 3 göndermeye devam ettiği için ikisi de kabul.
// Yüz ışığı ve teni: base'in ışık deseni + kişinin kendi boynuna göre ton
// (faceRelight.relightFace) — bkz. postTasks.layers. 2026-10-14 yeniden açık
// (kullanıcı: "yüzdeki ışık base ile aynı olmalı, selfiedeki ile değil").
const FACE_LIGHT_TRANSFER = true;
// SADE AKIŞ (2026-10-29, 60d42504, kullanıcı: "yapıyı komple değiştiriyoruz;
// cilt tonu, ışık, kafa bakış yeri, kafa büyümesi, kafa oturması, vücutla ten
// uyumu — yaptığın detaylı işlemleri en basite indirge; tek isteğim base
// fotodaki yüz ile selfiedeki yüzün tam orantılı değişimi"). 60d42504'te
// kareleri son katmanlar bozdu: c3 kafanın arkası silinmiş, c4 kafa büyümüş,
// c5 kafa küçük ve önde, c6 göğüste dikdörtgen ten lekesi (kutulu el tonu),
// c9 arkada şablon silüeti.
// Akış: şablon (saçı SİLİNMEDEN) → kısa prompt'la tek üretim (yön sapınca
// ikinci üretim aynen) → kapılar yalnız ELER → geri yerleştirme → siyah-beyaz
// → teslim. Üretimden sonra pikseli değiştiren katmanların hepsi kapalı: uzuv
// kroması, yüz parlaması, kutulu el tonu, göz açıklığı, GFPGAN, yüz ışığı,
// ten alanı, yüz detayı, kıyafet rengi, arka plan geri yükleme, kafa ölçeği,
// kafa çevresi/saçak/bukle dolgusu, kulaklık, ışıklı filtre. Kalanlar: tüm
// kareyi şablona hizalama (kayma+ölçek), artefakt onarımı (yalnız kapı yüzde
// dikiş görürse), şablonda gözlük varsa en son dar maskeyle gözlük ekleme.
// 2026-10-30 (922f1371, kullanıcı: "ışıklandırma yok, ten uyumu yok, kafa
// büyük ve yapıştırılmış gibi, netlik bozuluyor"): son adımlar
// postTasks.simpleFinish — kafa bükme (headWarp: dolgusuz küçültme), yüz sahne
// ışığı (faceTone: ölçülen fazla parlaklığı/rengi/ışık yönünü şablona
// oturtur; eski ışık/ten katmanları yüzü AÇIYORDU), yüz detayı (keskinlik +
// gren). Hazırlıkta 5 açılı sette yan profil şartı (gazeGate.selfieSideCoverage).
// false: 2026-10-28 akışı aynen geri gelir.
const SIMPLE_PIPELINE = true;
const FACE_PHOTO_COUNT = 5;
// SIK AÇILI ÇEKİM (2026-11-16, kullanıcı kararı; bkz. selfieOrderForYaw): yeni uygulama
// 10 kare çeker (ön, sağa 4 adım, sola 4 adım, çene aşağı). Modele yine şablon başına
// FACE_PHOTO_COUNT kare gider — seçim prepareSelfieSet'te, çizilecek açı + eğime göre.
// Ücretli ve kimlik tarafı adımlar (Vision, ten pigmenti, kimlik descriptor sırası)
// yalnız ilk FACE_PHOTO_COUNT'u kullanır; uygulama ilk 5'i eski 5 açıya en yakın
// karelerden yükler. Eski sürümler (3/5) aynen çalışır.
const MAX_FACE_PHOTOS = 10;
const ALLOWED_FACE_PHOTO_COUNTS = [3, 5, MAX_FACE_PHOTOS];
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

// STİL MANTIĞI KALDIRILDI (2026-09-18, kullanıcı kararı) — TEK SAHNE HAVUZU.
//
// Eskiden kullanıcı bir "stil" seçiyor ve yalnızca o stilin 20 sahnesi
// kullanılıyordu. Stil seçimi arayüzden tamamen kalktı; artık paket yalnızca
// FOTO SAYISI belirliyor (5 / 10 / 25) ve şablonlar yalnızca BOY BANDINA
// (short / middle / tall) göre seçiliyor.
//
// NEDEN BİRLEŞTİRMEK ZORUNLU: pickScene sahneyi `variantIdx % havuzBoyu` ile
// seçiyor. Tek stilin havuzu 20 sahne olduğu için 25 fotoluk pakette 21-25.
// fotoğraflar İLK 5 SAHNEYİ TEKRAR EDERDİ — kullanıcı aynı mekânda iki kare
// görürdü. Beş stilin sahneleri birleşince havuz 100'e çıkıyor ve 25 foto
// rahatça tekrarsız kalıyor.
//
// STYLE_SCENES SİLİNMEDİ, yalnızca artık tek havuz olarak okunuyor: sahne
// metinleri değerli ve kategorilere ayrılmış hâlleri okunabilirliği
// koruyor. Sıra sabit (elegance, athletic, traveller, nightout, car) —
// pickScene zaten jobId ile karıştırdığı için sıranın kendisi çeşitliliği
// etkilemiyor, ama sabit olması aynı işin tekrar çalıştığında aynı sonucu
// vermesini (determinizm) koruyor.
const ALL_SCENES = Object.values(STYLE_SCENES).flat();

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
 * BİRLEŞİK sahne havuzundan (ALL_SCENES, 100 varyant) jobId'e göre
 * DETERMİNİSTİK ama İŞE ÖZGÜ karışık bir sıra üretir. Aynı iş içindeki her
 * chunk (variantIdx 0..fotoSayısı-1) bu karışık sıradan sırayla alır — set
 * içinde hiç tekrar olmaz, çünkü en büyük paket (25) havuzun çok altında.
 * Farklı bir iş (farklı jobId) FARKLI bir alt küme/sıra kullanır — böylece
 * tekrar tekrar üretmek hep aynı arka planları vermez (bkz. "arka planları
 * hep aynı üretiyorsun" şikayeti — kök neden buydu: eskiden sabit ilk-5
 * seçilirdi).
 *
 * bucketId tohuma DAHİL (2026-09-18): stil kalktıktan sonra tek kova var ve
 * değeri sabit; tohumda kalması eski işlerin aynı sahneleri üretmesini
 * (determinizm) korur ve ileride birden çok kova gerekirse çakışmayı önler.
 */
function pickScene(bucketId, jobId, variantIdx) {
  const pool = ALL_SCENES;
  const seed = seedFromString(`${jobId}:${bucketId}`);
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
    "BODY CUE (the person's own form answers — the source for build; never " +
    "idealise or slim the body beyond what they stated): " + parts.join(", ") + ".\n\n"
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
function buildEditPrompt(identityCaption, bodyProfile) {
  // Beden bilgisi artık YALNIZCA kullanıcının formdaki seçimi (bodyProfile).
  // Eskiden burada tam boy fotoğraftan Gemini ile çıkarılan bir "REFERENCE
  // BODY" cümlesi de vardı; tam boy foto istenmediği için kaldırıldı.
  const bodyBlock = bodyProfileHint(bodyProfile);

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
    "The OTHER images are reference photos of a DIFFERENT specific real person (the target person) — " +
    "all of them close-up views of the target's face. They are the ONLY source of truth for their " +
    "facial identity and structure.\n\n" +
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
    "UP FACE reference photos — identical facial features, identical " +
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
    "hands, fingers, legs, feet — ALL the same colour as the target person's real skin. Read that tone " +
    "from the close-up selfies and carry it onto every limb, so the whole body reads as ONE person. " +
    "It is a SERIOUS ERROR to change only the face while leaving the arms, hands, legs or any " +
    "other body part the base person's original skin colour. This applies to EVERY case regardless of " +
    "how large or subtle the tone difference is — whether the base person is much darker or much " +
    "lighter than the target, or the difference is more subtle (e.g. medium, olive, tan, or any other " +
    "intermediate tone) — always recolour the ENTIRE body, limb by limb, to match the target's EXACT " +
    "skin tone precisely, never an approximation or a tone partway between the base and the target. " +
    "Check the arms and legs specifically. The result must have ONE consistent skin colour everywhere, " +
    "never a patchwork of two different skin colours on the same person. Before finishing, re-check " +
    "every visible limb one by one — if the legs, feet, arms or hands still show ANY trace of the base " +
    "person's original skin tone, that is a failure and must be corrected before the image is final.\n\n" +
    "BODY: match the target person's real build, weight and height. If they are heavier, slimmer, taller " +
    "or shorter than the base person, reshape the body accordingly and resize the SAME clothing to fit " +
    "naturally. Keep the body anatomically whole and coherent — correct number of arms, legs, hands and " +
    "fingers, natural joints and proportions, nothing merged, missing, duplicated or distorted.\n\n" +
    "EYEWEAR (sunglasses/glasses) — THE BASE PHOTO DECIDES, NEVER THE REFERENCES: if the person in the " +
    "BASE photo is NOT wearing eyewear, the output must have NO glasses or sunglasses whatsoever. The " +
    "target's reference photos frequently show them wearing sunglasses — that eyewear belongs to " +
    "THEIR photo, not to this scene, and carrying it over is a FAILURE. " +
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
    "one third of the shoulder span — not against the picture frame. CRITICAL when the build changes: you are " +
    "also reshaping the body to the target's real build; if that makes the shoulders and torso narrower " +
    "than the base person's, the head MUST shrink by the same proportion. A head left at its original " +
    "size on a narrowed body reads as oversized even though nothing about the head changed. The close-up " +
    "face references are zoomed-in for identity detail ONLY — never use their zoom level as a size " +
    "reference. The head must never look oversized, bobble-headed, pushed forward, or too big for the " +
    "shoulders.\n\n" +
    "SINGLE PERSON: the target person appears EXACTLY ONCE. Do not duplicate their face onto other people " +
    "in the scene; any background people stay different, generic, unrelated people.\n\n" +
    "LIGHTING (strict): the face's skin colour and tone must look IDENTICAL to the reference photos — " +
    "as if no extra light was added at all. Absolutely do NOT brighten, whiten, lighten, glow, shine, " +
    "shimmer or add any radiance, sheen or luminous quality to the skin — the face must NOT look lit-up, " +
    "highlighted or enhanced compared to the rest of the scene. " +
    // "TEK İZİN VERİLEN DÜZELTME" MADDESİ KALDIRILDI (2026-09-16), P800'deki
    // "strip that extra light" ile aynı gerekçe: modele yüzdeki ışığı
    // DÜZELTME izni vermek, onu yüzü yeniden boyamaya davet ediyor ve sonuç
    // düz gri blok oluyor. Parlama artık selfie modele girmeden önce
    // alınıyor (faceShine.normalizeSelfieLighting), bu yüzden modelin
    // düzeltecek bir şeyi yok.
    "Do NOT attempt any lighting correction on the face at all — no relighting, no shadow removal, no " +
    "flattening of bright areas. The references have already been normalised. " +
    "The face must sit under the exact same light direction, intensity and colour as " +
    "the rest of the base scene, with no separate or extra light on it. There must be NO unexplained " +
    "dark blotch, black smudge, dirty patch or hard shadow stuck on the face — facial skin stays clean " +
    "and evenly toned in the person's real colour.\n" +
    // AÇIK RENKLİ BLOK ARTEFAKTI (2026-09-14). Prompt şimdiye kadar yalnızca
    // KOYU lekeyi yasaklıyordu; kullanıcının şikâyet ettiği kusur ise tersi:
    // alın, kaş ve burun üstünde düz GRİ/BEYAZ, keskin ve düz kenarlı
    // bloklar. İki iş üst üste bu yüzden çok ret aldı (7160f104 ve 420fd8c6:
    // 33 reddin 19'u artefakt kaynaklı, 7160f104 chunk 1 altı deneme boyunca
    // aynı yerde tekrarladı). Kapı bunu eliyor ama asıl çözüm üretimde
    // oluşmasını engellemek — ret döngüsü süre ve OpenAI kredisi yakıyor.
    "Equally, there must be NO flat grey, white or washed-out patch sitting on the facial skin: no " +
    "rectangular or straight-edged block, no thin streak or line across the forehead, brows, nose, " +
    "cheeks or chin, and no region that looks pasted on, painted over or pixelated differently from " +
    "the skin around it. Real skin has continuous tone and texture — every part of the face must blend " +
    "smoothly into the next with no hard or geometric borders anywhere.\n" +
    // Bkz. buildEditPromptP800'deki aynı başlık (2026-09-17): yamaların
    // ölçülen konumu yüzün KENARI (X=0.05/0.06/0.93/0.95), yani bu bir
    // dikiş kusuru. Asıl üretim modu P800 ama bu yol da aynı korumayı almalı.
    "FACE EDGE: the boundary where your edited face meets the original hair, temples and ears must be " +
    "invisible. Never end the edit at a straight line and never leave a block, rectangle or dull patch " +
    "along the hairline, temples, outer brows or the sides of the forehead. Carry skin texture and " +
    "tone continuously outward into the hairline so the edited region has no detectable edge.\n\n" +
    "CRAFT: keep it looking like an ordinary, unedited phone photo of a real person — natural skin with " +
    "real texture, and do NOT invent blemishes or facial asymmetry not present in the references. True-" +
    "to-life colour and contrast, natural available light, no added brightness or glow.\n\n" +
    "FACE RENDERING QUALITY — spend your detail budget on the face. It must be the sharpest, cleanest " +
    "region of the frame: crisp eyes with visible catchlights and iris detail, defined lashes and brow " +
    "hairs, clean lip edges, and skin that reads as living tissue with fine pores and natural " +
    "subsurface warmth. \"Unedited phone photo\" and \"no airbrush\" mean do not SMOOTH or beautify — " +
    "they do NOT mean render the face rough, noisy or low-resolution. The face must never look " +
    "pixelated, mushy, grainy, blocky, plasticky, dull, flat or lifeless, and must never be softer or " +
    "lower-resolution than the clothing and background around it. Do not add fake studio light, glow " +
    "or sheen to achieve this — the liveliness comes from resolved detail and accurate colour under " +
    "the scene's own light, not from extra brightness.\n\n" +
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
    "face, skin that looks brighter or whiter than the reference photos, " +
    "changing or regenerating the background, keeping the " +
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
function buildEditPromptSimple(bodyProfile) {
  const bodyBits = [];
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
function buildStage1Prompt(identityCaption, bodyProfile) {
  // Bkz. buildEditPrompt — beden bilgisi yalnızca bodyProfile'dan gelir.
  const bodyBlock = bodyProfileHint(bodyProfile);

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
    "reference photos. The EXACT nose (bridge width, " +
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
function shortBodyNote(bodyProfile) {
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
  // TEK YETKİLİ KAYNAK: kullanıcının formda seçtiği vücut tipi.
  // (2026-08-20) Tam boy fotoğraf artık istenmiyor; ondan türetilen ikincil
  // "caption" gözlemi ve onun seçimle çelişme kontrolü kaldırıldı — zaten
  // çelişki durumunda kullanıcının seçimi kazanıyordu.
  let s = `\n\nTARGET BUILD — the person's stated build: ${label || ht}.`;
  if (bt) s += ` Reshape the base person's body accordingly: ${bt}.`;

  return s;
}

/**
 * ~300 KELİME — merdivenin en yalın basamağı.
 * Yapı: görev -> korunacaklar -> değişecekler -> kalite. Tekrar YOK; her kural
 * yalnızca bir kez ve en kısa haliyle söylenir.
 */
function buildEditPromptP300(identityCaption, bodyProfile) {
  return (
    "TASK: edit the FIRST image — it is your only canvas. Replace the person in it with the person in " +
    "the other reference photos. Never output a reference photo; the result must be the first image, " +
    "edited.\n\n" +
    "KEEP EXACTLY AS IN THE FIRST IMAGE: background, location, lighting, camera angle, framing, body " +
    "pose, head rotation, TILT and gaze direction, head size relative to the shoulders, and every " +
    "clothing item and accessory (glasses, jewellery, watches, bags, shoes). If that person is in " +
    "profile or three-quarter view, stay in that view — never turn or straighten the head toward the " +
    "camera. Ignore how the target is posed or where they look in their own selfies.\n\n" +
    "CHANGE ONLY THE PERSON, using their close-up face photos:\n" +
    "- Face: copy their exact nose, eyebrows, eyes, lips, jaw, chin, cheekbones and face outline. Same " +
    "shapes, same proportions. Do not beautify, symmetrise, round or puff the face. Keep their own " +
    "natural expression. It must unmistakably be the same person.\n" +
    "- Skin: their true tone from the selfies, applied evenly to every visible area — face, neck, " +
    "chest, arms, hands, legs. Never two-tone, never lightened or given a glow.\n" +
    "- Head size + gaze: match the BASE head-to-shoulder ratio (never selfie zoom) and the BASE gaze " +
    "direction exactly.\n" +
    "- Body: their real build, height and weight, resizing the same clothing to fit. If this makes the " +
    "shoulders narrower than the base person's, scale the HEAD DOWN by the same amount — a head left at " +
    "its original size on a narrowed body looks oversized." +
    shortBodyNote(bodyProfile) + "\n\n" +
    (identityCaption ? `The target person: ${identityCaption}\n\n` : "") +
    "QUALITY: an ordinary, unedited phone photo. Natural skin texture, no plastic airbrush, no added " +
    "brightness. Tattoos only if visible in the target's own photos. Eyewear comes ONLY from the first " +
    "image: if it has none, add none — the target's own photos often show sunglasses and copying them " +
    "over is a failure. If the first image has eyewear, keep it and match the visible face parts to the " +
    "selfies precisely. Clean temporary blemishes only. No distorted hands or extra limbs."
  );
}

/**
 * ADI ESKİ: A/B'yi kazandığında (2026-07-29) ~706 kelimeydi. Her ölçülmüş
 * kusur düzeltmesi bir paragraf ekledi ve 2026-09-20'de ~1850 kelimeye çıktı;
 * o uzunluk hiçbir zaman diğer modlarla karşılaştırılmadı.
 *
 * KISALTMA (2026-09-27, kullanıcı kararı, ~1850 -> ~1400 kelime):
 * - Vücut tipi kaldırıldı (shortBodyNote + "form cevaplarına göre yeniden
 *   şekillendir"). Bedeli: model kullanıcının vücudunu hiç görmediği için
 *   (tam boy foto 2026-08-20'den beri yok) çıktıdaki vücut artık şablonun
 *   vücudu. Dolgun/ortalama farkı örneklerde zaten zayıftı.
 * - TOP PRIORITIES ile numaralı adımların tekrarı ayıklandı: eski 4) HEAD
 *   SIZE (P3 kaldı), P4 SKIN TONE (3) kaldı, prosedürü daha güçlü), eski
 *   5)'in P2/P2b tekrarı (yalnız "gözler açık" cümlesi kaldı).
 * - NO FLAT LIGHT PATCHES silindi: FACE EDGE aynı kusuru ölçülmüş kök
 *   nedeniyle anlatıyor, kusur ayrıca faceRepair.js ile onarılıyor.
 * - FACE RENDERING QUALITY yarıya indi.
 * İKİNCİ TUR (aynı gün, ~1363 -> ~1000 kelime):
 * - FACE EDGE silindi ve QUALITY'deki "selfie normalize edildi, yeniden
 *   ışıklandırma yapma" cümleleri kısaldı: ikisi de sonradan çürüyen yama
 *   teorileri için yazılmıştı (bkz. hafıza notu face-artifact-is-a-seam).
 * - Küçük tekrarlar: CHANGE ONLY THE PERSON TASK'a katıldı; 1) FACE'teki P1
 *   tekrarı, HAIR'deki benzetme, SKIN TONE'daki prosedür öncesi tekrar ve
 *   P2b'deki "profilde aynı açıda kal" (a/b/c zaten kapsıyor) çıktı.
 * SONRAKİ TURLAR (aynı gün): bakış kısaltıldı; kafa boyutu tabandaki kafaya
 *   bağlandı; vücut maddesi P3/KALİTE'ye dağıtıldı; KALİTE tek paragraf oldu
 *   ve "telefon fotoğrafı" yerine "BİRİNCİ görsel kadar net" dendi; öncelikler
 *   ve numaralı adımlar tek listede birleşti; kafa dönüşündeki burun ucu /
 *   uzak kulak ölçümü kaldırıldı. Gerekçeler ilgili satırların yanında.
 * Etkisi ölçülmeden önceki uzunluğa dönülmek istenirse: commit geçmişi.
 *
 * A/B KAZANANI: 6 mod karşılaştırıldı, bu en tutarlı sonucu verdi ve tek buton
 * artık bunu gönderiyor (bkz. module_flows.dart). Mod değiştirmek yerine,
 * gözlenen somut bir hataya karşı tek cümle eklemek tercih edilir.
 *
 * 3. MADDEYE EKLENEN "uzuv uzuv kontrol" CÜMLESİ (2026-08-09): gerçek çıktıda
 * yüz ve boyun doğru tonda, ELLER taban kişinin tonunda kaldı. p800'ün ten
 * talimatı hatayı TANIMLIYORDU ama "bitirmeden önce tek tek kontrol et" adımı
 * yoktu — o adım yalnızca tam prompt'ta vardı (buildEditPrompt, "re-check
 * every visible limb one by one"). Kanıtlanmış ifade oradan alındı.
 * Etkisi TEN ÖLÇÜM loglarından sayıyla izlenebilir: bu cümle işe yarıyorsa
 * RED[skin] oranı ve buna bağlı retry sayısı düşmeli.
 *
 * 4. MADDEDEKİ (eski 5.) "gözler açık ve canlı" CÜMLESİ (2026-08-09): kullanıcı
 * çıktılarda gözlerin yarı kapalı/uykulu çıktığını bildirdi. p800 gözden
 * yalnızca üç yerde söz ediyordu (yapıyı kopyala, bakış yönü, gözlük kaldır);
 * göz KALİTESİ hakkında tek kelime yoktu. Tam prompt'ta ise var ("never a
 * blank dead-eyed stare... natural catch-light"), bir başka varyantta "never
 * ... half-closed or dead-eyed" olarak geçiyor — ifade oradan alındı.
 * KRİTİK: "gözleri büyüt" DENMEZ; tam prompt bunu açıkça yasaklıyor ("their
 * real eye shape IS their identity"). Cümle yalnızca artefaktı (yarı kapalı /
 * kırpma anı) yasaklar ve gözü büyütmeyi ayrıca men eder.
 *
 * QUALITY MADDESİNE EKLENEN EKLEM/PARMAK LEKESİ CÜMLESİ (2026-08-09): aynı
 * gerçek vakada (hindistan cevizi tutan kare) kullanıcı ayrıca parmaklarda ve
 * sol dirsekte doğal olmayan, lekeli bir gölgelenme fark etti — bu, ten
 * TONU uyuşmazlığından (madde 3) FARKLI bir hata sınıfı: düz yanlış renk
 * değil, lokal/düzensiz bir karartı. Yüz için zaten var olan "no unexplained
 * dark blotch" yasağı ("no unexplained dark blotch, black smudge, dirty
 * patch or hard shadow" — bkz. buildEditPrompt'taki LIGHTING bölümü) yalnızca
 * yüze uygulanıyordu; aynı yasak burada ellere/parmaklara/kollara/dirseğe de
 * genişletildi.
 */
function buildEditPromptP800(identityCaption, bodyProfile) {
  // 2026-10-08 (kullanıcı: "bakış açısı tamamen aynı olmalı", "yüzdeki ışık
  // base ile tamamen aynı olmalı"): kafa yönü + bakış EN BAŞA, açık bir
  // okuma prosedürüyle (burnun yönü, görünen yanak, kulak görünürlüğü) —
  // ölçülmüş bir değer YAZILMAZ (bkz. gaze-tell-direction-upfront), model
  // tabandan kendisi okur. Yeni C) kuralı yüzün ışığını tabandan ister; eski
  // "selfie tonunu olduğu gibi taşı, yüzü yeniden aydınlatma" cümlesi
  // kaldırıldı — gün batımı sahnesinde yüz nötr kalıyordu (9d9507f0 c9) ve
  // siyah-beyaz sahnede renkli kalıyordu (c4).
  // 2026-10-09 SADELEŞTİRME: tekrarlar tek yere toplandı ("selfie'den yalnız
  // kimlik" TASK'ta, dikiş CLEAN EDGES'te, ışık C'de). C'deki "aynı parlak/
  // gölge taraf, aynı kontrast" çıkarıldı — f9f3b5c0'da her yüzde gereksiz
  // gölge vardı; yerine "tabanda olmayan gölge ekleme". Kural sırası aynı.
  // 2026-10-10 (3cd612ba): "tüm gözlükleri kaldır" gömleğe asılı gözlüğü de
  // sildi (c3 d1) — yalnız yüzdeki kaldırılır (judgeEyewear da yalnız onu
  // ekler). Şablon saçının silüeti kalıyordu (c6 d2, c9 d2) → taşan yerde arka
  // plan. C'deki ten cümlesi 3)'ün tekrarıydı.
  // 2026-10-11 KISALTMA (kullanıcı: "promptun genel yapısında kısaltman
  // gereken yerler varsa kısalt"): kurallar ve sıra aynı, hiçbir kural
  // çıkarılmadı. TASK'ın iki paragrafı birleşti; A'daki okuma prosedürü ve
  // CLEAN EDGES'in kendini tekrarlayan dikiş cümleleri sıkıştırıldı.
  // 2026-10-14 (kullanıcı: "gözler uyuşuk yorgun gibi kapalı durmamalı"):
  // "tabandaki ifadeyi koru" cümlesi kısık gözlü manken pozunu da taşıyordu
  // (cbdbef13 c0/c8/c29) — ifade ağız+ruh hâline daraltıldı, göz açıklığı
  // ayrı EYES bölümünde selfie'nin en açık karesinden isteniyor.
  // Yerel A/B (aynı 4 şablon, 2 tur): göz kapağı cümlesi göz açıklığını
  // 0.30-0.35'ten 0.33-0.40'a çıkardı (selfie 0.43) → kaldı. Yüzün sahneye
  // göre parlaklığı (1.25→1.27, 1.70→1.67), kafa boyu ve "dönük kafa aynı
  // kafatası" cümleleri ölçüyü değiştirmedi → çıkarıldı; pozlama
  // faceRelight'ta (2026-10-16'ya kadar faceLight.matchFaceExposure), kafa
  // boyu headScale'de.
  // 2026-10-16 GERİ ALINDI (kullanıcı, c29a2b31 c3/c6: "prompt değişikliği
  // öncesi bakışlar tutuyordu"): EYES bölümü "göz kapakları ve açıklığı
  // selfie'den" diyordu — selfie'nin merceğe bakan gözü de geldi; c6'da base
  // irisi göz köşesinde (0.76), çıktıda ortada (0.58). İfade ve göz cümlesi
  // 2026-10-13 hâline döndü: model yönlendirilmediğinde base bakışını
  // kendiliğinden taklit ediyor (bkz. bakış yönünü prompt'a yazma denemesi).
  // 2026-10-16 KISALTMA (kullanıcı, 6dd26e3e: "prompt çok uzun olduysa
  // ayarlama yapabilirsin"): 604 → 485 kelime, kural çıkarılmadı. TASK'taki
  // tekrar, CLEAN EDGES ve QUALITY sıkıştırıldı; A'ya "tam profil tam profil
  // kalır" eklendi (c4: base tam sola dönük, çıktı üç çeyrek). Yerel A/B (aynı
  // 5 şablon, d44 selfie'leri, birer kare): kafa açısı c8'de eski 0.84 / yeni
  // 0.61 (şablon 0.54), diğer dördünde eşit; bakış beşinde de base yönünde.
  // AYNI GÜN KISMEN GERİ ALINDI (629b45de, kullanıcı: c1 "yüz yapısı
  // değişmiş", c9 saç): kısaltma kimlikten "(highest priority after rule A)",
  // "round, puff", "length-to-width ratio"; saçtan "never from the BASE person
  // and never invented" ifadelerini düşürmüştü. TASK, 1) 2) 3) eski metne
  // birebir döndü; A/B/C ve son bölümler kısa kaldı. Kimlik/saç metnine kısaltma
  // için dokunma — A/B'de kimlik ölçülmemişti.
  // 2026-10-17 (0eeb75c8 c3, kullanıcı: "şablondaki şapka çıktıda yok"): şapka
  // için kural yoktu; "yalnız kafa değişir" + "saç yalnız selfie'den" + "base
  // kişisinden hiçbir şey kalmasın" ile model şapkayı kişiye ait sayıp sildi.
  // Ayrı bir "KEEP HEADWEAR" bölümü A/B'de (d44 selfie, c3 şablonu, 2/2)
  // şapkayı geri getirmedi; kural çakışan iki yerin İÇİNE yazılınca (TASK'taki
  // değişmeyenler listesi + 2) HAIR) 2/2 şapka korundu. +40 kelime (562).
  // 2026-10-18 (10ee6a46 c5, kullanıcı: "dümdüz bakması gerekirken bakış
  // yönü kaymış"): A'ya "kameraya tam karşıdan bakan baş tam karşıdan kalır"
  // eklendi (yerel A/B'de ≥0.20 sapma 3/12 → 3/12, şapka korundu). Aynı gün
  // 3b4f51cb'de c7 yine döndü (+0.24) ve c1'de bakış aşağıdan öne kaydı;
  // kullanıcı kararıyla yerine GENEL kural: "BASE nereye bakıyorsa çıktı
  // oraya — aşağı/yukarı/düz/sağ/sol". Prompt BAŞINA koşullu cümle şapkayı
  // 2/2 silmişti; kural A'nın içinde kalmalı.
  // 2026-10-19 (ca61076a c1, kullanıcı: "base'de iki kulak görünüyorsa çıktıda
  // da iki kulak görünsün"): A'ya kulak cümlesi. Yerel A/B (6 cephe şablonu × 2,
  // d44 selfie'leri): ort |sapma| 0.111 → 0.089, ≥0.15 sapma 3/12 → 3/12; elle
  // tutulan gözlüklü şablonda (d87 c6) gözlük 1/2 yüze çıktı (şimdiki 0/2).
  // 2026-10-21 (017dbe34 c5, kullanıcı: "saçı silmişsin"): model şablonun
  // gür saçını kullanıcının kafasının üstünde yarı saydam kubbe bırakıp kendi
  // saçını seyrek çizdi; kubbe temizlenince tepe silinmiş göründü. Sonradan
  // maskeli onarım tutmadı (5 deneme, model mevcut saçı korudu) → 2) HAIR'e
  // "kendi saçı kendi yoğunluğunda, opak", CLEAN EDGES'e "taşan yerde arka
  // plan katı, saç katmanı değil". A'daki kulak ifadesi iki kez geçiyordu →
  // tek cümle; bakış listesi kısaldı (aynı beş yön). Kimlik/şapka metnine
  // dokunulmadı.
  // 2026-10-29 SADE AKIŞ (60d42504, kullanıcı: "yapıyı komple değiştiriyoruz,
  // prompttan gereksiz bölmeleri kaldır, düzenle ve kısalt; tek isteğim base
  // fotodaki yüz ile selfiedeki yüzün tam orantılı değişimi"; bkz.
  // SIMPLE_PIPELINE). A (yön/bakış), B (kafa-gövde) ve C (ışık) tek HEAD
  // bölümünde; SKIN, REMOVE, CLEAN EDGES, QUALITY birer-ikişer cümle.
  // KİMLİK ve SAÇ paragrafları BİREBİR eski metin (629b45de: o ikisini
  // kısaltmak yüz yapısını ve saçı değiştirmişti; şapka kuralı saç
  // paragrafında). Gözlük kaldırılır, şablonda varsa en son eyewear.js ekler.
  // AYNI GÜN SON KONTROL: TASK "gövde ve eller BASE'deki gibi kalır" derken
  // SKIN "ellere de TARGET teni" diyordu — modelin şablonun elini olduğu gibi
  // bırakmasının olası bir sebebi (bkz. hand-tone-mismatch); artık "gövde şekli ve el
  // pozisyonları" kalır, ten SKIN'den. Saçtaki "His" → "The TARGET's"
  // (kadın kullanıcılar).
  // 2026-10-30 (kullanıcı: "gereksiz prompt detaylarını kaldıralım, yüzde
  // boyama yapma"): "siyah-beyazsa çıktı da" (faceLight.matchGrayscale zaten
  // yapıyor), SKIN'deki "BASE gibi aydınlat" (TASK + HEAD'de var) ve
  // "geçici lekeleri hafifçe temizle" (güzelleştirme = boyama) çıkarıldı.
  // 2026-10-30 SON HÂL (kullanıcı: "ek üretim/şablon seçimi yok; promptu çok
  // düzgün, sade ve akıcı yap"): sade akışın üç açığı prompt'ta.
  // - Kafa boyu/yeri: "boyu omuza göre aynı" yanında somut çapa — gözler
  //   BASE gözlerinin yerinde ve aynı aralıkta (yüz hizalamanın ölçüsü göz
  //   arası; boy, yer ve eğim tek cümlede). Göz BOYU yazılmadı: kimliktir.
  // - Ten: "tek beden, tek ten"; kol ve el BASE konumunda ama yeni yüzün
  //   tonunda (model şablon elini bırakıyordu, bkz. hand-tone-mismatch).
  // - Saç izi: saç silme kapalı; BASE saç modelinin hiçbir parçası (şekil,
  //   yükseklik, hacim, kabarık, kakül, bukle — "its": kullanıcının kendi
  //   buklesi serbest) kurulmaz, taşan yerde zemin katı.
  // - Işık: "yüz BASE ışığını alır" → yön, renk ve GÜÇ (parlaklık değil:
  //   koyu tenli kullanıcıyı açık tenli şablona göre açardı), fazla gölge yok.
  // - 2026-10-19 kulak kuralı geri geldi (sade metinde düşmüştü).
  // Kimlik paragrafı aynen; saç paragrafının şapka ve "never from the BASE
  // person and never invented" cümleleri aynen (629b45de, 0eeb75c8).
  // 2026-10-30 AKŞAM (kullanıcı: "kafa büyük kalıyor ve önde duruyor, geride
  // ve dik durmalı"; 922f1371'de c5 +12, c7 +22, c9 +24 yüz kutusu): eski
  // uzun sürümlerin (48bd0ee/a07aa19) somut ifadeleri geri geldi — duruş
  // ("BASE kadar dik ve omuzların üstünde geride"), "boyu selfie'den alma,
  // onlar yakın çekim", boyun genişliği ve "oversized, pushed forward or
  // pasted on" yasağı. Hata yönü büyütme olduğu için "yüz BASE yüzünden büyük
  // değil"; göz çapası aynen. Yüz alanı/çene çapası YAZILMADI: kel kullanıcıda
  // saç çizgisi, uzun yüzde çene kimliği bozar. DİKKAT: 10-13 A/B'de kafa boyu
  // cümlesi ölçüyü değiştirmemişti; güvence headWarp (düz zeminde).
  // Işık cümlesi vücuda bağlandı: 922'de model vücudu zaten kullanıcı tonuna
  // çekiyor (şablondan 1-5 L koyu), parlayan yalnız yüz (+6…+15 L). Sahneyi
  // yeniden ışıklamak tabanı değiştirir; hedef "yüz vücuttaki ışığı alır".
  // QUALITY: "face swap değil" ve "boyun/kıyafetten yumuşak değil" (48bd0ee).
  // AYNI AKŞAM dış inceleme (kullanıcı onayı, seçilerek): "aynı göz aralığı"
  // göz aralığını değiştir diye okunabilirdi → "tüm kafayı ölçekle, tek
  // özelliği değil; gözler BASE gözlerinin yerine" (iki göz aynı iki noktada =
  // aralık zaten eşit, ölçek çapası korunur). Kol/el "BASE ışık ve gölgesi
  // kalır, yalnız ton" (düz boya riski). "composite". ALINMAYANLAR: kimlik/saç
  // paragrafını yeniden yazma (629b45de, 017dbe34), ifadeyi "anatomiye uyarla"
  // (c29a2b31), bakışı ayrı bölüme taşıma, kulak/profil kuralını ve ışıktaki
  // "strength"i atma, kimliği kafa konumunun önüne alma.
  // 2026-10-30 GECE ÇENE ÇAPASI (kullanıcı onayı, c2e8eff1 c9: "kafa büyük ve
  // önde, boyun gözükmeli; bir tık küçültse çözülür"): gözler doğru yerde
  // (Δ+0.02 yüz boyu) ama göz→çene %15 uzun (c8 %20, c6 %23), çene 0.13-0.17
  // aşağıda, çene-yaka boşluğu 0.21→0.06. Göz çapası tek başına uzun yüzü
  // aşağı büyütüyor. Çene çapası "bütün kafayı küçült, basıklaştırma"
  // şartıyla eklendi (yukarıdaki "uzun yüzde çene kimliği bozar" kaygısı
  // bu yüzden: ölçek tek parça). API'siz yazıldı, üretimle doğrulanmadı.
  return (
    "TASK: The FIRST image is the BASE photo and your only canvas; the other images are close-up " +
    "SELFIES of the TARGET person. Return the BASE photo with one change: the BASE person's head " +
    "becomes the TARGET's. Everything else stays exactly as in the BASE: background, lighting, " +
    "framing, pose, body shape, hand positions, clothing, accessories and any hat or cap. From the " +
    "selfies take only facial identity, eye colour, hair and skin tone, never their head angle, gaze, " +
    "expression or light: they face the lens only because they are selfies." +
    "\n\nHEAD: The new head takes the exact place of the BASE head: same position on the neck, same " +
    "turn, tilt and chin height, held as upright and as far back over the shoulders as the BASE head. " +
    "It keeps the BASE head's size against the shoulders; the selfies are zoomed-in close-ups, so " +
    "never take size from them. The new face is no larger than the BASE face, if anything slightly " +
    "smaller: scale the whole head, never single features, so that the TARGET's eyes land where the " +
    "BASE eyes were and look exactly where the BASE eyes looked, and the chin tip lands no lower than " +
    "the BASE chin tip, with the same strip of neck or collar showing below it. A longer face is " +
    "scaled down as a whole, never squashed. " +
    "The neck keeps its BASE width and angle, so the head grows from this body, never oversized, " +
    "pushed forward or pasted on. If both ears show in the BASE, both show in the result; a full " +
    "profile stays a full profile. Never turn the head toward the camera, straighten, enlarge or " +
    "shrink it. Light the face with the same BASE light that falls on the body: same direction, " +
    "colour and strength, no extra shadows." +
    "\n\nIDENTITY (highest priority after HEAD): Copy the selfie person feature by feature: eyes, " +
    "eyebrows, nose, lips, jaw, chin, cheekbones, face outline and length-to-width ratio. Do not " +
    "beautify, symmetrise, average, round, puff, widen or stretch. Keep the BASE expression; add no " +
    "smile. Eyes are open and clear, never half-closed or enlarged. Keep moles, freckles, scars and " +
    "facial hair." +
    "\n\nHAIR: Hairline, density, length, texture and colour come from the selfies only, never from " +
    "the BASE person and never invented. Keep nothing of the BASE hairstyle: not its shape, height, " +
    "volume, quiff, fringe or curls. The TARGET's hair is solid and opaque at its own density, " +
    "never thinned, faded or see-through. Bald or balding stays bald or balding to the same degree. If " +
    "the BASE wears a hat or cap, keep that exact hat (shape, colour, logo, angle) on the TARGET head; " +
    "only the hair showing around it is the TARGET's." +
    "\n\nSKIN: One body, one skin tone: the face, ears, neck, chest, arms and hands all get the " +
    "TARGET's tone. The arms and hands keep their BASE position, light and shadows, but match the new " +
    "face's tone exactly." +
    "\n\nREMOVE: Glasses and sunglasses on the face, tattoos, and any earphones or headphones. " +
    "Eyewear on the clothing, on the head or in a hand stays." +
    "\n\nCLEAN EDGES: Nothing of the BASE person's head or hair remains: no outline, halo, ghost or " +
    "double edge. Where the BASE hair or head reached further than the TARGET's, continue the " +
    "surrounding background there, solid, with no trace of hair. No seam at the hairline, jaw or neck." +
    "\n\nQUALITY: It looks as if the BASE photo was simply taken with the TARGET in it: an ordinary, " +
    "unedited phone photo, not a face swap or composite. No retouching, smoothing, airbrush, glow or beauty filter. " +
    "The face is sharp, with natural skin texture, never softer or smoother than the neck and " +
    "clothing around it."
  );
}

/**
 * "Versiyon 2" butonunun prompt'u. 2026-10-10 (kullanıcı: "yeni promptun ana
 * hatları kalarak iyice sadeleştirilmiş versiyonu"): P800'ün bölüm sırası
 * birebir korunur (A kafa yönü+bakış, B kafa-gövde, C yüz ışığı, kimlik, saç,
 * ten, kaldır, temiz kenar, kalite); her bölüm tek-iki cümleye indirildi.
 * Gözlük P800'deki gibi kaldırılır, şablonda varsa en son eklenir (bkz.
 * eyewear.js). Model gpt-image-2 (Buton 1 ile aynı).
 */
function buildEditPromptCompact() {
  return (
    "TASK: The FIRST image is the BASE and the only canvas. Replace its person with the TARGET from " +
    "the other images (selfies). Keep everything else unchanged: background, lighting, framing, pose, " +
    "body, clothing and accessories. Take only identity, hair, eyes and skin tone from the selfies, " +
    "never head angle, head size, gaze, expression or light.\n\n" +
    "A) HEAD & GAZE (MOST IMPORTANT): The new head points the same way as the BASE head by the same " +
    "amount: same nose direction, same visible cheek and ears, same tilt and chin height. Never turn " +
    "it toward the camera or re-centre it. The eyes look at the same point as the BASE eyes.\n\n" +
    "B) HEAD ON BODY: Same place, size and lean on the BASE neck; the neck keeps its width and " +
    "angle.\n\n" +
    "C) LIGHT: Light the face like the BASE face, never like the selfies: same direction, brightness " +
    "and colour of light. Add no extra shadow. If the BASE is black and white, so is the face.\n\n" +
    "IDENTITY: Copy the TARGET's eyes, brows, nose, lips, jaw, chin and face shape exactly. No " +
    "beautifying or reshaping. Keep the BASE expression.\n\n" +
    "HAIR: Hairline, length, texture and colour from the selfies; bald stays bald.\n\n" +
    "SKIN: One continuous TARGET tone on all visible skin.\n\n" +
    "REMOVE: Glasses and sunglasses on the face, tattoos, and all earphones and headphones " +
    "(AirPods, in-ear, over-ear) from the selfies or the BASE: the ears are bare. Eyewear on the " +
    "clothing or in a hand stays.\n\n" +
    "CLEAN EDGES: Nothing of the BASE person remains: no ghost, outline or double edge. Where the " +
    "BASE hair or head reached further, continue the background. Hairline, ears, jaw and neck blend " +
    "seamlessly.\n\n" +
    "QUALITY: An ordinary, unedited phone photo, not a face swap. No glow or filters. The face is the " +
    "sharpest part of the frame: in-focus eyes, visible skin texture, never blurry or waxy."
  );
}

/**
 * ~1400 KELİME — karmaşık image-to-image için üst bant.
 * P800'ün üstüne, gerçek kullanıcı testlerinde TEKRARLAYAN hataların her biri
 * için birer kısa madde ekler (bu maddelerin hepsi gözlemlenmiş sorunlardan
 * gelir, "her ihtimale karşı" yazılmış değildir).
 */
function buildEditPromptP1400(identityCaption, bodyProfile) {
  return (
    buildEditPromptP800(identityCaption, bodyProfile) + "\n\n" +
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
    "identity detail only — never treat their zoom level as a size reference. Take the head-to-shoulder " +
    "proportion from the base photo.\n\n" +
    "- INVENTED SMILE: an open smile or grin appeared that is not in the target's references. Keep " +
    "whatever calm, natural expression they actually have.\n\n" +
    "- BORROWED SUNGLASSES: the target wore sunglasses in their own reference photos, and that " +
    "eyewear was carried into a base scene that had none. Eyewear is decided " +
    "ONLY by the base photo — if the base person wears none, the output has none.\n\n" +
    "- DUPLICATED FACE: the target's face was pasted onto other people in the scene. The target appears " +
    "exactly once; any background people stay generic and unrelated.\n\n" +
    "- UNEXPLAINED DARK PATCH: a black smudge or dirty patch was left on the face. Facial skin stays " +
    "clean and evenly toned in the person's real colour."
  );
}

function buildEditPromptShort(identityCaption, bodyProfile) {
  const bodyBits = [];
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
    "COPY EXACTLY from the target's close-up face photos (never the chest-up ones for identity): their exact " +
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

// BAKİYE ARTIK FOTO CİNSİNDEN (2026-09-18, stil mantığı kaldırıldı).
//
// ESKİDEN: photoBalance "stil/set" sayardı ve 1 birim = 10 foto demekti.
// Paketler 5/10/25 fotoya geçince bu birim anlamsızlaştı — 5 foto bir
// "birimin yarısı" olurdu. Artık photoBalance doğrudan FOTOĞRAF sayar.
//
// MEVCUT CÜZDANLAR: ölçüldü (2026-09-18) — 229 cüzdanın 6'sında bakiye var,
// toplam 18 birim = 180 foto. Bu 6 doküman ×10 ile foto birimine çevrilmeli;
// hak birebir korunur (1 birim -> 10 foto, 5 birim -> 50 foto). Çevrim
// YAPILMADAN bu kod canlıya alınırsa o 6 kullanıcı bakiyesini 10 kat AZ
// görür (1 foto sanır) — üretim engellenir ama kredi KAYBOLMAZ.
function photoUnitsFor(photoCount) {
  return photoCount; // bakiye "foto" cinsinden — bkz. DatingConfig.
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

// signedDownloadUrl -> _shared.js'e taşındı (opsPanel.js de kullanıyor).

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

// BOYUN PARAGRAFI YALNIZ UZUN BOYDA (2026-11-17, kullanıcı: "genel fotolarda boyun uzatma var
// gibi, bu sadece uzun boylu kişiler için çalışmalı"). naturalSwap.describeHeadAndNeck (11-15,
// "boyun içe kaçmasın", 11-13 "uzun boylunun boynu uzun olur") boyu bilmeden her kareye
// gidiyordu. f8c1718b (170-175, short): ham çene 8 karenin 7'sinde şablondan YUKARIDA (c6
// −0.16, c2 −0.13, c4 −0.12 yüz eni; paragraftan önce 7 iş ortanca +0.057 aşağıdaydı) → boyun
// uzuyor, c4'te kafa "yapışık" duruyor. Uzun boy bandı dışında prompt 11-15 öncesiyle bayt
// bayt aynı tek cümle.
function isTallNeck(bodyProfile) {
  return !!(bodyProfile && HEIGHT_RANGE_TO_BAND[bodyProfile.heightRange] === "tall");
}

// STİLLER (2026-09-28, yeniden eklendi — kullanıcı kararı). İstemci
// `style` alanıyla gönderir; lib/core/constants/dating_constants.dart
// PhotoStyle.coreStyles ile EL İLE senkron tutulmalı.
//
// Klasör yapısı: dating_templates/{stil}/{short|middle|tall}/*.jpg
// Klasörler elle oluşturulduğu için yazım farklarına tolerans var: stil
// klasörü için aşağıdaki adlar, boy bandı için "middle" yerine "mid" de
// kabul edilir. Stil klasörü BOŞSA eski boy-bandı havuzuna düşülür —
// klasörler doldurulana kadar üretim durmaz.
const PHOTO_STYLE_IDS = ["elegance", "datenight", "traveller", "oldmoney"];
const STYLE_FOLDER_ALIASES = {
  elegance: ["elegance"],
  datenight: ["datenight", "date-night", "date_night", "date night"],
  traveller: ["traveller", "traveler"],
  oldmoney: ["oldmoney", "old-money", "old_money", "old money"],
};
const BAND_FOLDER_ALIASES = {
  short: ["short"],
  middle: ["middle", "mid"],
  tall: ["tall"],
};

// Havuzdaki taban görselleri döner.
//
// styleId verilirse önce dating_templates/{stil}/{band}/, sonra stilin
// tamamı denenir. heightRange verilirse o boya karşılık gelen alt klasör
// denenir (dating_templates/{band}/). O klasör BOŞSA sessizce tüm havuza
// düşülür — böylece kullanıcı henüz bantlara ayırmamışsa üretim durmaz
// (fail-safe: yanlış boy bandı, hiç üretim yapamamaktan iyidir).
// Döner: { files: Storage File[], band: string|null, style: string|null }
async function listTemplateFiles(heightRange, styleId = null) {
  const band = HEIGHT_RANGE_TO_BAND[heightRange] || null;
  const isImage = (f) => !f.name.endsWith("/") && /\.(jpe?g|png|webp)$/i.test(f.name);

  if (styleId && STYLE_FOLDER_ALIASES[styleId]) {
    for (const folder of STYLE_FOLDER_ALIASES[styleId]) {
      if (band) {
        for (const b of BAND_FOLDER_ALIASES[band]) {
          const [inBand] = await bucket().getFiles({ prefix: `${TEMPLATE_ROOT}/${folder}/${b}/` });
          const banded = inBand.filter(isImage);
          if (banded.length > 0) return { files: banded, band, style: styleId };
        }
      }
      const [inStyle] = await bucket().getFiles({ prefix: `${TEMPLATE_ROOT}/${folder}/` });
      const styled = inStyle.filter(isImage);
      if (styled.length > 0) {
        console.warn(`STİL BANDI BOŞ: ${TEMPLATE_ROOT}/${folder}/${band || "?"}/ — stilin tüm klasörü kullanılıyor`);
        return { files: styled, band: null, style: styleId };
      }
    }
    console.warn(`STİL KLASÖRÜ BOŞ: ${styleId} — boy-bandı havuzuna düşülüyor`);
  }

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
 * Referans selfie'lerini Storage'dan okur, OpenAI'nin çekebileceği imzalı bir
 * Firebase Storage URL'i üretir. Döner: { urls: string[], buffers: Buffer[] }
 *
 * NOT (2026-08-20): eskiden burada önce fal.ai CDN'e yüklenip (uploadToFalStorage)
 * başarısız olursa imzalı URL'e düşülüyordu. Üretim artık her zaman doğrudan
 * OpenAI'ye gittiği için (bkz. useOpenAiDirect, hep true) fal.ai bu adımda
 * gereksiz bir ara durak/round-trip'ten ibaretti — imzalı URL zaten OpenAI
 * tarafından sorunsuz çekilebiliyor, doğrudan o kullanılıyor artık. fal.ai bu
 * akıştan tamamen çıkarıldı (FAL_KEY bu handler'ın secrets listesinden de
 * kaldırıldı, bkz. prepareReferencePhotos).
 */
async function uploadReferencePhotos(uid, jobId) {
  const prefix = `dating_training/${uid}/${jobId}/`;
  const [files] = await bucket().getFiles({ prefix });
  // Sayısal sıra: 10'lu çekimde photo_10 olursa ada göre sıralama onu photo_1'in
  // arkasına koyardı (yükleme sırası = poz sırası, ilk FACE_PHOTO_COUNT özel).
  const photoNo = (f) => {
    const m = /photo_(\d+)/.exec(f.name);
    return m ? Number(m[1]) : Infinity;
  };
  const photoFiles = files
    .filter((f) => !f.name.endsWith("/") && f.name.includes("photo_"))
    .sort((a, b) => photoNo(a) - photoNo(b) || a.name.localeCompare(b.name));
  if (photoFiles.length === 0) {
    throw new HttpsError("failed-precondition", "Referans fotoğrafları bulunamadı.");
  }
  const results = await Promise.all(photoFiles.map(async (file, idx) => {
    const [raw] = await file.download();

    // EXIF Orientation'ı piksellere uygula — fal/yüz kapısı yan-ters
    // referans görmesin (bkz. postProcess.normalizeExifOrientation).
    const { normalizeExifOrientation } = require("./postProcess");
    const buf = await normalizeExifOrientation(raw);

    // +18/uygunsuz içerik kapısı — OpenAI'ye hiçbir görsel gönderilmeden önce.
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

    // SELFIE IŞIK NORMALİZASYONU (2026-09-16) — ARTEFAKT REDDİNİN KÖK NEDENİ.
    //
    // Ölçüm: son 12 işte 44 artefakt reddi, tarifleri neredeyse aynı —
    // "Grey patch on forehead", "Grey patch on left cheek". Alın ve yanak,
    // yani selfie'de flaşın vurduğu yerler. Prompt modele "strip that extra
    // light" diyor, model yüzü yeniden boyuyor ve oraya düz gri blok
    // bırakıyor (bkz. faceShine.normalizeSelfieLighting başlığı).
    //
    // Parlamayı BURADA, sayısal olarak alıyoruz; model artık düzeltecek bir
    // şey görmediği için boyamıyor. Düzeltilmiş baytlar Storage'a GERİ
    // YAZILIYOR, çünkü modele giden şey imzalı URL — tampon değil.
    //
    // FAIL-SAFE: normalizasyon başarısız olursa (yüz bulunamadı, parlama yok,
    // hata) orijinal kare aynen kullanılır, üretim asla engellenmez.
    // SADE AKIŞTA KAPALI (2026-10-29): teori 09-17'de çürüdü (artefaktın kök
    // nedeni dikiş, bkz. faceRepair.js) ve selfie pikselini değiştiriyordu;
    // modele kullanıcının selfie'si olduğu gibi gider.
    let outBuf = buf;
    if (!SIMPLE_PIPELINE) try {
      const { normalizeSelfieLighting } = require("./faceShine");
      const norm = await normalizeSelfieLighting(buf);
      if (norm.applied && norm.buf) {
        await file.save(norm.buf, { contentType: "image/jpeg", resumable: false });
        outBuf = norm.buf;
        console.log(
          `SELFIE IŞIK NORMALİZASYONU (foto ${idx + 1}): UYGULANDI ` +
          `parlamaOranı=${norm.shineRatio.toFixed(3)} piksel=${norm.changed}`
        );
      } else {
        console.log(
          `SELFIE IŞIK NORMALİZASYONU (foto ${idx + 1}): atlandı [${norm.reason}]` +
          `${norm.shineRatio != null ? ` parlamaOranı=${norm.shineRatio.toFixed(3)}` : ""}`
        );
      }
    } catch (e) {
      console.error("Selfie ışık normalizasyonu atlandı (orijinal kare kullanılıyor):", e);
    }

    const url = await signedDownloadUrl(file);
    return { url, buf: outBuf };
  }));
  return { urls: results.map((r) => r.url), buffers: results.map((r) => r.buf) };
}

/**
 * fal.ai queue API'sine bir Seedream edit işi gönderir (tek görsel). Bir stilin
 * TEK bir chunk'ı için çağrılır — chunkIdx hem webhook'un hangi sonucu
 * işleyeceğini belirler HEM DE hangi sahne varyantının üretileceğini seçer
 * (chunk 0..IMAGES_PER_STYLE-1 -> STYLE_SCENES[style][aynı aralık]). Böylece
 * bir stildeki IMAGES_PER_STYLE (10) foto birbirinin kopyası değil, 10 farklı
 * gerçek ortam olur.
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
async function submitStyleJob(uid, jobId, styleId, chunkIdx, templateUrl, refUrls, identityCaption, bodyProfile, modelId = DEFAULT_MODEL_ID) {
  const webhookUrl = `${FUNCTIONS_BASE}/falInferenceWebhook?uid=${uid}&jobId=${jobId}&style=${styleId}&chunk=${chunkIdx}`;
  const model = MODEL_CATALOG[modelId] || MODEL_CATALOG[DEFAULT_MODEL_ID];
  const prompt = buildEditPrompt(identityCaption, bodyProfile);
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

// Eşzamanlı OpenAI images/edits çağrısını sınırlar — acquireFaceSwapSlot ile
// BİREBİR AYNI desen (bkz. FACE_SWAP_MAX_CONCURRENCY başlığı). OpenAI
// gpt-image-2 bu endpoint için "5 input-images per min" limiti uyguluyor;
// mimarimiz IMAGES_PER_STYLE (10) chunk'ı Promise.all ile paralel ürettiği
// için (bkz. startPhotoGeneration'daki dispatch) bu limit aşılıyordu.
// GERÇEK OLAY (2026-08-13): bir chunk hem 1. hem 2. denemesinde 429'u
// tüketip TAMAMEN sessizce kayboldu (hiçbir log satırı bırakmadan) —
// kullanıcı 10 yerine 8 foto aldı. fal'ınkinden (10) daha sıkı bir limit
// olduğu için tavan 2'ye sabitlendi — bu kuyruk PROCESS-İÇİ olduğundan
// (Cloud Functions yük altında 2. bir instance açarsa o da kendi kuyruğunu
// çalıştırır) pay bırakmak için düşük tutuldu; 429 yine gelirse mevcut
// retry (aşağıda) devreye girer.
// 2 -> 6 (2026-10-11, kullanıcı: "çok yavaş, fazla maliyet olmadan
// hızlandır"). Ölçüldü (iş 3b16bf69): 10 karenin ilk üretimi 72-218. sn
// arasında ikişer ikişer bitti, kafa çevresi/gözlük çağrıları da aynı 2'li
// kuyrukta bekledi; iş 645 sn sürdü. Son bir ayda gerçek oran sınırı 429'u
// HİÇ yok (09-14/15'teki 415 kayıt "credit_balance_exhausted" — kredi
// bitmesi). Çağrı sayısı değişmez, maliyet aynı; 429 gelirse aşağıdaki
// bekle-yeniden-dene yolu devrede.
const OPENAI_IMAGE_MAX_CONCURRENCY = 6;
let _openaiImageActive = 0;
const _openaiImageWaitQueue = [];

function acquireOpenAiImageSlot() {
  if (_openaiImageActive < OPENAI_IMAGE_MAX_CONCURRENCY) {
    _openaiImageActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _openaiImageWaitQueue.push(resolve));
}

function releaseOpenAiImageSlot() {
  const next = _openaiImageWaitQueue.shift();
  if (next) next();
  else _openaiImageActive--;
}

/**
 * OpenAI'nin KENDİ images/edits endpoint'ine doğrudan senkron istek atar.
 * fal.ai'nin aksine SUNUCU görsel URL'i değil, ham görsel BAYTLARINI
 * multipart/form-data ile bekliyor — bu yüzden her imageUrl önce indirilir.
 * Döner: JPEG buffer (PNG istenip 97 kalitede çevrilir, bkz. pngToDeliverJpeg), ya da (moderasyon reddi/hata/429 dahil tüm durumlarda)
 * null — FAIL-SAFE, çağıran taraf null'da chunk'ı retry'siz başarısız sayar
 * (bkz. runOpenAiDirectChunk, MAX_CHUNK_RETRIES=0 politikasıyla tutarlı).
 *
 * images dizisi hem URL (string) hem HAM BUFFER kabul eder — 3 aşamalı
 * pipeline'da (mod 2) sonraki aşamaların tuvali bir önceki aşamanın
 * buffer'ıdır, Storage'a yazıp URL üretmeye gerek yok.
 */
const GEN_JPEG_QUALITY = 97;
/** Üretim çıktısı (PNG) → aşağı akışın beklediği JPEG, neredeyse kayıpsız. */
async function pngToDeliverJpeg(buf) {
  return require("sharp")(buf).jpeg({ quality: GEN_JPEG_QUALITY, chromaSubsampling: "4:4:4" }).toBuffer();
}

// 1.5 KAT ÇÖZÜNÜRLÜK (2026-10-22, kullanıcı onayı, iş başı sınır 1.80 $):
// auto boyutta (~1.57 MP) yüz 100-140 px kalıyor, detay (iris, sakal teli,
// kulak) sığmıyordu. 1632x2176 ile aynı alan; ölçülen çıktı tokeni 1544 →
// 2399, kare ~0.10 → ~0.127 $ (girdi tokeni boyuttan bağımsız). Boyut ilk
// görselin (taban) en-boyunda: kenarlar 16'nın katı, en çok 3840, oran ≤ 3.
// KAPATILDI (2026-10-25, b7cd18da, kullanıcı: "yüz değişmeye başlamış"):
// 1.5 katta çıkan tek iş, kendi selfie vektörüne 0.469 uzaklıkta kaldı;
// aynı kişinin auto boyutlu 7 işi 0.354-0.406. Aynı 10 şablonun hepsinde yüz
// daha dar/uzun, sakal seyrek çizildi. Son katmanlar kimliği değiştirmiyor
// (eski ham karelerde ham 0.338 → son 0.339), fark üretimin kendisinden.
const HI_RES_ON = false;
const HI_RES_AREA = 1632 * 2176;
const HI_RES_MAX_EDGE = 3840;
// BASE EN-BOYUNDA ÇIKTI (2026-11-08, 27deeec2 c7, kullanıcı: "yüzü yana genişletmişsin"):
// auto boyutta model ~1.57 MP döndürüyor (c5 1086x1448) ama oranı kendi seçiyor;
// c7 1036x1518 (0.682, şablon 0.750) geldi, EN-BOY DÜZELTME kareyi dikeyde %9
// bastırdı, yüz %10 geniş göründü. Aynı alan (1024x1536 ≈ auto) şablon oranında
// istenir: ücret aynı, bastırma gerekmez. HI_RES (1.5x alan) kimliği değiştirmişti;
// burada alan değişmiyor. Geri dönüş: false (auto).
const OUTPUT_ASPECT_LOCK = true;
const AUTO_AREA = 1024 * 1536;

/** İlk görselin boyutundan istenecek çıktı boyutu ("WxH"). SAF. */
function hiResSize(w, h, area = HI_RES_AREA) {
  if (!(w > 0) || !(h > 0)) return null;
  const r = Math.max(1 / 3, Math.min(3, w / h));
  let W = Math.sqrt(area * r);
  let H = W / r;
  const k = Math.min(1, HI_RES_MAX_EDGE / Math.max(W, H));
  W = Math.max(16, Math.round((W * k) / 16) * 16);
  H = Math.max(16, Math.round((H * k) / 16) * 16);
  // 16'ya yuvarlama oranı %0.5'e kadar kaydırabiliyor (EN-BOY DÜZELTME eşiği):
  // ±4 adım içinde, alan ±%3te kalan ve oranı en yakın çift seçilir.
  const A0 = W * H;
  let best = { W, H, err: Math.abs(W / H - r) / r };
  for (let dw = -64; dw <= 64; dw += 16) {
    const w2 = W + dw;
    if (w2 < 16 || w2 > HI_RES_MAX_EDGE) continue;
    const h2 = Math.max(16, Math.round(w2 / r / 16) * 16);
    if (h2 > HI_RES_MAX_EDGE || Math.abs(w2 * h2 - A0) > 0.03 * A0) continue;
    const err = Math.abs(w2 / h2 - r) / r;
    if (err < best.err - 1e-9) best = { W: w2, H: h2, err };
  }
  return `${best.W}x${best.H}`;
}

async function generateWithOpenAI(prompt, imageUrls, model = OPENAI_MODEL_ID, { n = 1 } = {}) {
  try {
    const buffers = await Promise.all(imageUrls.map(async (url) => {
      if (Buffer.isBuffer(url)) return url; // zaten ham görsel (pipeline ara çıktısı)
      const r = await fetch(url);
      if (!r.ok) throw new Error(`referans indirilemedi: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }));

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    if (HI_RES_ON || OUTPUT_ASPECT_LOCK) {
      try {
        const m = await require("sharp")(buffers[0]).metadata();
        const swap = (m.orientation || 1) >= 5;
        const size = hiResSize(swap ? m.height : m.width, swap ? m.width : m.height, HI_RES_ON ? HI_RES_AREA : AUTO_AREA);
        if (size) form.append("size", size);
      } catch (e) {
        console.error("OpenAI üretim boyutu ölçülemedi (auto):", e.message || e);
      }
    }
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
    // PNG İSTE, BİZ JPEG'E ÇEVİR (2026-10-19, 99bacae0, kullanıcı: "yüzde
    // piksellik gözüküyor, netlik bozulmamalı"): OpenAI JPEG'i 75 kalitede
    // döndürüyor (kuantalama tablosu 8,6,5,8,12,20…; output_compression=100
    // YOK SAYILIYOR — aynı tablo). ~150 px'lik yüzde 8x8 bloklar çıkıyor, yüz
    // detayı keskinleştirmesi (×1.2–1.8) onları büyütüyordu. PNG kayıpsız
    // (blok ölçüsü 1.02, JPEG 1.26–1.35), token/ücret aynı. Aşağı akış JPEG
    // bekliyor (jpeg-js, yukarıdaki not): 97 kalite, renk alt örneklemesi
    // yok (blok ölçüsü 1.06).
    form.append("output_format", "png");
    buffers.forEach((buf, i) => {
      form.append("image[]", new Blob([buf], { type: "image/jpeg" }), `ref_${i}.jpg`);
    });
    // n > 1: aynı çağrıda birden fazla aday (bkz. İKİ ADAY); dönüş dizi.
    if (n > 1) {
      form.append("n", String(n));
      const list = await postOpenAiImageEdit(form, buffers.length, { all: true });
      return list ? await Promise.all(list.map(pngToDeliverJpeg)) : list;
    }

    const out = await postOpenAiImageEdit(form, buffers.length);
    return out ? await pngToDeliverJpeg(out) : out;
  } catch (e) {
    console.error("OpenAI images/edits hata:", e.message || e);
    return null;
  }
}

// KAFA KÜÇÜLTME AI DOLGUSU (2026-10-09, kullanıcı kararı: "OpenAI maskeli
// düzenleme"). Küçülen kafanın açtığı arka plan deliği doku dolgusuyla
// yapılı sahnelerde (tabela, perde, tavan) yamalı görünüyordu. Model maskeye
// sıkı uymuyor, kırpımı baştan çiziyor — bu yüzden promptta arka plandaki
// diğer kişilerin korunması AÇIKÇA istenir (ilk sürüm "no person" diyordu,
// model arka plandaki insanları silip kenarda kopukluk üretti). Dönen
// görselden yalnızca delik pikselleri alınır (bkz. headScale finishInpaint).
// Kafayı olduğu boyda tutma cümlesi (2026-10-09, 61079257 c6): model kafayı
// eski büyük boyunda yeniden çizip kenarını deliğe taşıyordu (yüzün yanında
// saydam profil). Cümleyle delikteki kişi payı 0.069 → 0.012, 0.070 → 0.043.
const HEAD_INPAINT_PROMPT = "Edit only the transparent masked area. It is the part of the background that was hidden behind the person's head; the head is now smaller. The person's head, hair, face and ears must stay exactly where and as large as they are now: do not enlarge, extend, move or redraw them, and do not continue their outline into the masked area. Fill it with the background that would be visible there, continuing exactly the surrounding walls, signs, lines, plants, objects, lighting, depth of field, blur and grain. Do not draw hair, a head, a face or skin inside the mask. Keep everything outside the mask exactly as it is, including the main person and any other people or objects in the background.";

/**
 * Kafa küçültme deliğini maskeli düzenlemeyle doldurur. Dönüş: PNG buffer ya
 * da null (FAIL-SAFE: çağıran kafayı küçültmeden bırakır, retry yok).
 */
// KAFA SAÇAĞI TEMİZLİĞİ prompt'u (2026-10-10, bkz. headScale
// prepareHeadFringeRepaint): maske kafanın çevresindeki halka; içinde yalnızca
// arka plan olmalı.
const HEAD_FRINGE_PROMPT = "Edit only the transparent masked area. It lies around the person's head and must contain only background. Remove every loose hair strand, wisp, faint hair, halo or outline in it and fill it with the background that continues the surroundings exactly: walls, curtains, windows, sky, objects, lighting, blur and grain. Every straight line or edge that enters the mask (a wall joint, a door frame, a window edge, a horizon) continues straight through it and leaves at exactly the height and angle where it meets the mask on the other side. Add no new line, pole, edge or object that does not already come in from outside the mask. The person's head, hair, face and ears outside the mask stay exactly where and as large as they are: do not extend the hair or the head into the mask. Do not draw hair, a head, a face or skin inside the mask. Keep everything outside the mask exactly as it is.";

// İsteğe bağlı son AI adımlarının tahmini maliyeti (low kalite, ölçülen
// ~$0.015 / ~$0.019 + pay) — bkz. jobContext maliyet sınırı.
const EST_FILL_USD = 0.018;
const EST_EYEWEAR_USD = 0.022;
// YÖN İÇİN İKİNCİ ÜRETİM (bkz. resampleIfYawDrifts): ilk kare şablonun
// yönünden RESAMPLE_YAW_MIN kadar saparsa bir kez daha üretilir, ikisinden
// yönü yakın olan alınır. Önce aynı çağrıda iki aday (n=2) denendi: OpenAI
// girdi görsellerini aday başına yeniden ücretlendiriyor ($0.10 → $0.19) ve
// her uygun karede ödeniyordu; sıralı üretim yalnız sapan karede (~%40) öder.
// Maliyet: tek üretim ~$0.10 (gözlüğe ayrıca pay bırakılmaz: kullanıcı
// kararı, doğru bakış önce gelir). Bütçe o an yoksa yer açılmasını bekler
// (bkz. jobContext waitReserveOptional).
// DÜZ BAKAN şablonda (işaretli yön TWO_CANDIDATE_YAW_MAX altında) eşik
// RESAMPLE_YAW_MIN, dönük şablonda RESAMPLE_YAW_MIN_ANGLED (aşağıda). Önce
// yalnız düz şablondaydı: 0.45 (düz + orta) ilk canlı işte (dd788c00) 4 kare tetikledi; kullanıcı
// yalnız düz şablonlu olanı (c0, −0.06 → −0.47) sorunlu buldu, dönük
// şablonlarda (−0.29/−0.40/0.36) fazladan dönme gözle fark edilmiyordu ve
// bütçe ilk sapan kareye gidip asıl gerekeni atlatıyordu. Sapmalar
// TWO_CANDIDATE_TIE_YAW'dan az farklıysa kimliği daha yakın kare seçilir.
// 0.10 → 0.15 (2026-10-19, kullanıcı kararı): 45 tekrar çiftinde tek karenin
// ≥0.10 sapma oranı %40, ≥0.15 %16; hafif dönmeler gözle sorun değil,
// ikinci üretim (~$0.10) yalnız belirgin dönmede (tenis karesi ~0.4-0.5).
const RESAMPLE_YAW_MIN = 0.15;
// DÖNÜK ŞABLONDA DA (2026-10-20, 7c17ea3f c2, kullanıcı: "kafa çok dönmüş"):
// şablon 0.59 → çıktı 0.80 (işaretli) yalnız düz şablonda çalışan ikinci
// üretime girmedi; yaw kapısı da iki ölçü profil bölgesinde olduğu için
// sustu. Dönük şablonda eşik daha yüksek: dd788c00'da 0.29-0.40 şablonlardaki
// hafif fazla dönme gözle fark edilmemişti; c2'deki 0.21 fark edildi.
const RESAMPLE_YAW_MIN_ANGLED = 0.20;
// DÜZ ŞABLONUN ÖNCELİĞİ: dd788c00'da (eşik dönük şablonları da kapsarken)
// bütçe önce dönük karelere gitti, asıl gereken düz şablonlu c0 (−0.06 →
// −0.47) ATLANDI[maliyet-bütçesi] ile reddedildi. Dönük şablon bütçeyi
// BEKLEMEZ ve ancak sonrasında bu kadar pay boş kalıyorsa ikinci üretir.
const ANGLED_RESAMPLE_HEADROOM_USD = 0.20;
// İlk kare 3B fazla dönmeden ZATEN elenecekse (2026-11-13, bkz. resampleIfYawDrifts):
// düz kare önceliği yerine yalnız geç gelen gözlük adımlarına pay. 0.05 inceleme
// sonrası 0.10: ~4 AI gözlük düzenlemesi (EST_EYEWEAR_USD 0.022) — daha azı gözlüğün
// "sınır aşılarak ekleniyor" yolunu olası kılıyordu. e67abb0e c7: 1.352+0.11+0.10=1.562.
const ANGLED_REJECT_HEADROOM_USD = 0.10;
// 0.10 → 0.11 (2026-11-13): 94 medium üretimde 0.0927-0.1071, 24'ü 0.10'un üstünde;
// tahmin üst sınır olmalı ki iş sınırı (takeSlot) gerçekten tutsun.
const EST_RESAMPLE_USD = 0.11;
const RESAMPLE_WAIT_MAX_MS = 150 * 1000;
const TWO_CANDIDATE_YAW_MAX = 0.25;
const TWO_CANDIDATE_TIE_YAW = 0.05;

/**
 * İki/çok adaydan seçilecek olanın indeksi. rows: { drift (|işaretli yön
 * farkı|, ölçülemezse Infinity), dist (kimlik mesafesi ya da null) }. Yönü
 * şablona en yakın; sapmalar TWO_CANDIDATE_TIE_YAW'dan az farklıysa kimliği
 * yakın olan. SAF.
 *
 * KAPIYI GEÇEN ÖNCE (2026-11-13, iş e67abb0e c9, kullanıcı: "tüm dediğim hataları
 * çöz"): iki aday yön=[0.35,0.43] kimlik=[0.53,0.45] → yönü yakın olan 1. seçildi,
 * kimlik kapısında (0.50) elendi; 2. aday her iki kapıyı da geçiyordu. Artık
 * adaylardan bir kısmı kimlik (< distMax) VE yön (sapma < driftMax) kapısını
 * geçiyorsa seçim yalnız onların arasında yapılır; hepsi geçiyor ya da hiçbiri
 * geçmiyorsa eski kural aynen.
 */
function chooseCandidate(rows, { distMax = require("./faceQuality").FACE_MATCH_THRESHOLD, driftMax = OUTPUT_YAW_DRIFT_MAX } = {}) {
  // over3d (varsa): YAW KAPISI'nın 3B fazla dönme kararı (yawOver3d) — true ise kapıdan elenir.
  const passes = (r) => r.dist != null && r.dist < distMax && r.drift <= driftMax && r.over3d !== true;
  const ok = rows.map((r, i) => (passes(r) ? i : -1)).filter((i) => i >= 0);
  const pool = ok.length > 0 && ok.length < rows.length ? ok : rows.map((_, i) => i);
  let best = pool[0];
  for (const i of pool.slice(1)) {
    const a = rows[i], b = rows[best];
    const tie = Math.abs(a.drift - b.drift) < TWO_CANDIDATE_TIE_YAW && a.dist != null && b.dist != null;
    if (tie ? a.dist < b.dist : a.drift < b.drift) best = i;
  }
  return best;
}

/**
 * Kafa ölçeği/çevresi dolgusu — yerel LaMa (2026-10-12, bkz. lamaFill.js;
 * OpenAI maliyeti yok). Hata fırlatmaz: başarısızlıkta { buf: null, reason },
 * çağıran küçültmeyi geri alır. k: log parçası.
 */
const LOCAL_FILL_TIMEOUT_MS = 120000;
async function fillHeadJobLocally(job, base) {
  const t0 = Date.now();
  let timer = null;
  try {
    const { finishInpaintLama } = require("./lamaFill");
    const limit = Math.max(10000, Math.min(LOCAL_FILL_TIMEOUT_MS, jobTimeLeftMs() - POST_AI_MIN_LEFT_MS / 2));
    const r = await Promise.race([
      finishInpaintLama(job, base),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), limit); }),
    ]);
    if (!r) return { buf: null, reason: "yerel-dolgu-süre", k: `yerelDolgu=süre(${Date.now() - t0}ms)` };
    return { buf: r.buf, reason: null, k: `yerelDolgu parça=${r.runs} ölçek=${r.scale.toFixed(2)}${r.coarse != null ? ` kaba=${r.coarse.toFixed(2)}` : ""} süre=${r.ms}ms` };
  } catch (e) {
    console.error("Yerel dolgu (LaMa) hata:", e);
    return { buf: null, reason: "yerel-dolgu-hata", k: "yerelDolgu=hata" };
  } finally {
    clearTimeout(timer);
  }
}

// YALNIZ HİZA İKİNCİ DENEME (2026-10-27, kullanıcı: "kafa vücuda tam otursun,
// geride ve dik olsun; bazı fotoğraflarda kafa önde kalıyordu"). Kalıntı
// yargıcı küçültmeyi reddedince kafa geride/dik konuma da taşınmıyordu
// (e25dc241: c0 c1 c4 c9). İz küçültmenin açtığı büyük delikten geliyor (c4:
// şablonun kabarık saçının örttüğü kapı kemeri bozuk doldu). Plan kayma,
// dönüş ya da kaldırma da içeriyorsa aynı kare küçültmesiz yeniden işlenir
// ve yargıca bir kez daha sorulur: yerel tekrarda c0/c4 temiz, yargıç ikisini
// de geçirdi. Döner teslim edilecek kare ya da null (eski hâl kalır).
async function alignOnlyAfterResidue(preBuf, tpl, templateEyewear, styleId, chunkIdx) {
  if (jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
    console.log(`KAFA HİZA (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
    return null;
  }
  try {
    const hs = await runPostTask("headScale", { buf: preBuf, tpl, templateEyewear, noShrink: true });
    if (!hs.applied) {
      console.log(`KAFA HİZA (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${hs.reason}] ${hs.ölçü}`);
      return null;
    }
    let out = hs.buf;
    let k = "delik yok";
    if (hs.inpaint) {
      const sf = await runPostTask("surroundPrep", { buf: hs.buf, tpl, extraHole: hs.holeMask, newHead: hs.headMask });
      if (!sf.applied) {
        console.log(`KAFA HİZA (style=${styleId}, chunk=${chunkIdx}): ATLANDI[çevre-${sf.reason}] ${hs.ölçü}`);
        return null;
      }
      const fin = await fillHeadJobLocally(sf.inpaint.job, sf.inpaint.base);
      if (!fin.buf) {
        console.log(`KAFA HİZA (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fin.reason}] ${hs.ölçü} ${fin.k}`);
        return null;
      }
      out = await secondSurroundPass(fin.buf, tpl, styleId, chunkIdx);
      k = fin.k;
    }
    const ghost = await judgeScaledHead(out, tpl, preBuf);
    const gk = !ghost ? "kalıntı=ölçülemedi" : ghost.ok ? (ghost.bad ? `kalıntı=VAR(${ghost.where}: ${ghost.detail})` : "kalıntı=yok") : `kalıntı=ölçülemedi[${ghost.reason}]`;
    const bad = !!(ghost && ghost.ok && ghost.bad);
    console.log(`KAFA HİZA (style=${styleId}, chunk=${chunkIdx}): ${bad ? "ATLANDI[ghost-after-align]" : "UYGULANDI"} ${hs.ölçü} ${hs.delik} ${k} ${gk}`);
    return bad ? null : out;
  } catch (e) {
    console.error("OpenAI yolu: yalnız hiza ikinci denemesi hata verdi (atlanıyor):", e);
    return null;
  }
}

// KAFA ÇEVRESİ İKİNCİ GEÇİŞ (2026-10-25, d0d4c001 c6/c2). Tek dolgu kalın
// hayalet saçın çoğunu silip kenarında ince bir çizgi (c6: şablon saçının
// dış hattı) ya da küçültme deliğinin üstünde açık bir blok bırakıyordu;
// kalıntı kapısı (judgeScaledHead) bunu görüp küçültmeyi geri aldı — c2 ve
// c6'da kafa büyük kaldı (ghost-after-scale). Dolu kare yeniden taranır,
// kalan kusur aynı yerel dolguyla silinir: iki karede de çizgi/blok gitti,
// küçültme temiz kaldı. Süre bütçesi yetmezse ilk geçiş olduğu gibi kalır.
const SURROUND_SECOND_PASS_MIN_LEFT_MS = 240 * 1000;
async function secondSurroundPass(buf, tpl, styleId, chunkIdx) {
  if (!Buffer.isBuffer(buf) || !Buffer.isBuffer(tpl)) return buf;
  if (jobTimeLeftMs() < SURROUND_SECOND_PASS_MIN_LEFT_MS) {
    console.log(`KAFA ÇEVRESİ 2. GEÇİŞ (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
    return buf;
  }
  try {
    const sf = await runPostTask("surroundPrep", { buf, tpl });
    const sp = `hayalet=${sf.ghostPx ?? "null"} saçak=${sf.fringePx ?? "null"} şerit=${sf.bandPx ?? "null"} yüzOvalindeKorunan=${sf.ovalPx ?? 0} şablonDışıSaç=${sf.userHairPx ?? 0}`;
    if (!sf.applied) {
      console.log(`KAFA ÇEVRESİ 2. GEÇİŞ (style=${styleId}, chunk=${chunkIdx}): TEMİZ[${sf.reason}] ${sp}`);
      return buf;
    }
    const fin = await fillHeadJobLocally(sf.inpaint.job, sf.inpaint.base);
    console.log(`KAFA ÇEVRESİ 2. GEÇİŞ (style=${styleId}, chunk=${chunkIdx}): ${fin.buf ? "TEMİZLENDİ" : `ATLANDI[${fin.reason}]`} ${sp} ${fin.k}`);
    return fin.buf || buf;
  } catch (e) {
    console.error("OpenAI yolu: kafa çevresi 2. geçiş hata verdi (ilk geçiş kalıyor):", e);
    return buf;
  }
}

async function inpaintHeadHoleWithOpenAI(imagePng, maskPng, prompt = HEAD_INPAINT_PROMPT, { timeoutMs = POST_AI_TIMEOUT_MS } = {}) {
  // MALİYET SINIRI: bütçe yetmiyorsa çağrı yapılmaz; çağıran adımı atlar.
  const slot = tryReserveOptional(EST_FILL_USD);
  if (!slot) return { skipped: "maliyet-bütçesi" };
  try {
    const form = new FormData();
    form.append("model", OPENAI_MODEL_ID);
    form.append("prompt", prompt);
    // LOW (2026-10-11, maliyet sınırı): dönen görselden yalnız maskedeki dar
    // şerit alınıyor; d44b63e8 c2/c4/c5'te low ile medium gözle ayırt
    // edilemedi (taş duvar, ağaç kenarı dahil), uyum kaymaları aynı (2-4 px).
    // Çıktı token'ı 1756 -> 196, çağrı ~$0.062 -> ~$0.015.
    form.append("quality", "low");
    form.append("size", "1024x1024");
    form.append("output_format", "png");
    form.append("image[]", new Blob([imagePng], { type: "image/png" }), "crop.png");
    form.append("mask", new Blob([maskPng], { type: "image/png" }), "mask.png");
    return await postOpenAiImageEdit(form, 1, { timeoutMs });
  } catch (e) {
    console.error("OpenAI kafa dolgusu hata:", e.message || e);
    return null;
  } finally {
    slot.release();
  }
}

/**
 * generateWithOpenAI'nin ağ isteği kısmı — eşzamanlılık kuyruğuna (bkz.
 * OPENAI_IMAGE_MAX_CONCURRENCY) ayrı bir fonksiyon olarak çıkarıldı ki slot
 * alma/bırakma try/finally ile HER çıkış yolunda (başarı, hata, tükenen
 * retry) garanti olsun.
 */
// OPENAI ÇAĞRI ZAMAN AŞIMI (2026-10-11, iş d44b63e8): fetch'in zaman aşımı
// yoktu; iki çağrı "fetch failed" ile 5 ve 12+ dakika asılı kaldı, eşzamanlılık
// slotlarının ikisini de tuttu ve iş 900 sn sınırını aşıp "Zaman aşımı" ile
// düştü (7/10 kare bitmişken). Asılı çağrı artık bu sürede kesilir ve null
// döner — mevcut hata yolu, retry EKLENMEDİ (bkz. fal-credit-burn-incident).
const OPENAI_IMAGE_TIMEOUT_MS = 300000;

// İŞ SÜRE BÜTÇESİ (2026-10-11, iş d44b63e8): startPhotoGeneration 900 sn
// çalışabiliyor; son katmanlar (kafa çevresi, gözlük) sona yığılınca iş sınırı
// aştı, 7/10 kare bitmişken "Zaman aşımı" ile düştü ve hepsi iade edildi.
// Her chunk çalışması bitiş zamanını AsyncLocalStorage ile taşır; isteğe bağlı
// AI adımları süre azalınca atlanır (kare onlarsız teslim edilir), yeni üretim
// denemesi başlatılmaz, her OpenAI çağrısı kalan süreyle sınırlanır.
const { jobClock, recordUsage, tryReserveOptional, waitReserveOptional, runOptional, hardCapAllows, ledgerSummary, releaseMandatoryReserve, createLedger, chunkContext } = require("./jobContext");
const JOB_TIME_LIMIT_MS = 900 * 1000; // startPhotoGeneration timeoutSeconds ile senkron
const JOB_FINALIZE_RESERVE_MS = 45 * 1000; // son kayıt/teslim için pay
const GEN_ATTEMPT_MIN_LEFT_MS = 300 * 1000; // yeni üretim denemesi için gereken süre
const POST_AI_MIN_LEFT_MS = 150 * 1000; // isteğe bağlı AI son adımı için gereken süre
const EYEWEAR_MIN_LEFT_MS = 90 * 1000;
// Camdan göz ikinci yargısı (2026-11-06, bkz. GÖZLÜK EN SON, taşıma): çağrı
// ~1 sn sürüyor; zaman aşımı kalan süreyle sınırlanır (jobTimeLeftMs zaten 45 sn
// teslim payını düşüyor). Yalnız bundan az süre kaldıysa sorulmaz ve taşıma
// yapılmaz. Sabit 25 sn eşik, 25-90 sn kala kareyi gözlüksüz bırakıyordu.
const LENS_JUDGE_MIN_LEFT_MS = 5 * 1000;
const LENS_JUDGE_MAX_TIMEOUT_MS = 20 * 1000;
const EYEWEAR_WAIT_MAX_MS = 90 * 1000; // bütçe için en fazla bekleme (bkz. GÖZLÜK EN SON)
const POST_AI_TIMEOUT_MS = 150 * 1000;

function jobTimeLeftMs() {
  const st = jobClock.getStore();
  return st && st.deadline ? st.deadline - Date.now() : Infinity;
}

// MUTLAK MALİYET TAVANI (2026-11-19, bkz. jobContext.hardCapAllows): çağrının
// tahmini, kendi kalite ayarından (ölçülen: low ~$0.015, medium ~$0.10,
// high ~$0.21 çağrı başına) × aday sayısı. Tavanı aşacaksa çağrı yapılmaz.
const IMAGE_CALL_EST_USD = { low: 0.02, medium: 0.11, high: 0.22 };
function imageCallEstUsd(form) {
  const q = String((form && form.get && form.get("quality")) || "medium");
  const n = Math.max(1, Number((form && form.get && form.get("n")) || 1) || 1);
  return (IMAGE_CALL_EST_USD[q] ?? IMAGE_CALL_EST_USD.high) * n;
}
async function postOpenAiImageEdit(form, refCount, { timeoutMs = OPENAI_IMAGE_TIMEOUT_MS, all = false } = {}) {
  const est = imageCallEstUsd(form);
  if (!hardCapAllows(est)) {
    const L = ledgerSummary();
    console.warn(`MALİYET TAVANI: görüntü çağrısı yapılmadı (tahmin $${est.toFixed(3)}, harcanan $${L ? L.spentUsd.toFixed(3) : "?"}, tavan $${L ? L.limitUsd.toFixed(2) : "?"})`);
    return null;
  }
  await acquireOpenAiImageSlot();
  try {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Slot beklenirken süre azalmış olabilir: kalan süreden fazla bekleme.
      const left = jobTimeLeftMs() - 5000;
      const limitMs = Math.min(timeoutMs, left);
      if (limitMs < 20000) {
        console.warn(`OpenAI images/edits atlandı: işin süresi bitiyor (kalan ${Math.round(left / 1000)}sn)`);
        return null;
      }
      let resp;
      try {
        resp = await fetch(OPENAI_IMAGE_EDIT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_KEY.value()}` },
          body: form,
          signal: AbortSignal.timeout(limitMs),
        });
      } catch (e) {
        console.error(`OpenAI images/edits ağ hatası ya da zaman aşımı (sınır ${Math.round(limitMs / 1000)}sn, deneme ${attempt}): ${e.name || ""} ${e.message || e}`);
        return null;
      }
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
        const usd = recordUsage(String(form.get("model") || OPENAI_MODEL_ID), u);
        console.log(
          `MALIYET GORSEL: girdi=${u.input_tokens ?? "?"} ` +
          `(metin=${d.text_tokens ?? "?"} gorsel=${d.image_tokens ?? "?"}) ` +
          `cikti=${u.output_tokens ?? "?"} toplam=${u.total_tokens ?? "?"} ` +
          `kalite=${form.get("quality") || "?"} referansSayisi=${refCount} aday=${(json.data || []).length} usd=${usd.toFixed(4)}`
        );
      }
      if (all) return json.data.filter((x) => x && x.b64_json).map((x) => Buffer.from(x.b64_json, "base64"));
      return Buffer.from(b64, "base64");
    }
    return null;
  } finally {
    releaseOpenAiImageSlot();
  }
}

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

// GÜNEŞ GÖZLÜĞÜ KAPISI KALDIRILDI (2026-09-06): gpt-4o'ya sorulan bu kontrol
// yalnızca göğüs-üstü iki kare için vardı, o kareler kalkınca dayanağı da
// kalmadı. Selfie'de koyu gözlük zaten yüz tespitini zorlaştırıp "net değil"
// kapısına takılıyor ve üretim prompt'u gözlüğü sahneye taşımayı ayrıca
// yasaklıyor ("BORROWED SUNGLASSES").

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
// KARARSIZ CEVAP RETRY LİMİTİ (2026-08-21): gpt-4o'nun içerik politikası
// reddi ("I'm sorry, I can't assist with that") DETERMİNİSTİK DEĞİL — aynı
// görsel çiftinde bazen reddediyor, bazen normal cevap veriyor. Önceden
// tek denemede kararsızlık = sessizce kabul demekti, yani bu kapı o karede
// FİİLEN hiç çalışmamış oluyordu. 2 deneme (orijinal + 1 retry), maliyeti
// ihmal edilebilir düzeyde artırırken gerçek bir değerlendirme alma şansını
// belirgin yükseltir.
const VISION_INCONCLUSIVE_MAX_ATTEMPTS = 2;

// KAFA AÇIKLIĞI DÜŞÜŞ TOLERANSI (2026-09-06). Vision, omuz genişliğine kaç
// kafa sığdığını taban ve çıktı için AYRI AYRI ölçüyor; seçenekler 0.5'lik
// kademeler (1.5 / 2 / 2.5 / 3 / 3.5 / 4). Çıktıda bu sayının düşmesi kafanın
// büyümesi demektir.
//
// 0.5 = TEK KADEME. Sıkı seçildi çünkü kullanıcı bunu en önemli madde olarak
// bildirdi ve bu kapı şu an FİİLEN YOK: 21 günlük üretim logunda (135 kare)
// eski "HEAD_VS_SHOULDERS" sorusu 135 kez "HEAD_NORMAL" dedi, tek bir kare
// bile elenmedi. Sayısal büyüme kapısı da ölü (bkz. faceQuality
// OUTPUT_FACE_GROWTH_MAX notu: gözlenen maksimum 1.19, eşik 1.45).
//
// KALİBRASYON: eşik önce veri olmadan kondu, aynı gün (2026-09-06) 77
// güvenilir geçmiş taban/çıktı çifti üzerinde sınandı — üretim logu
// beklenmedi. Ölçüm 77 karenin 4'ünü tetikledi (%5.2); bunların sayısal kafa
// büyümesi 1.114 / 1.103 / 1.097 ve 0.997 çıktı, sonuncusu yanlış pozitifti
// ve aşağıdaki sayısal hakem (VISION_PROPORTION_GROWTH_MIN) onu eliyor.
// Kapının fiilî eleme oranı %3.9 ve elenen üç kare gözle de bozuk.
const VISION_HEAD_SPAN_DROP_MAX = 0.5;

// VISION'IN KAFA REDDİ İÇİN SAYISAL ALT SINIR (2026-09-06).
// Kapı 77 geçmiş kare üzerinde denendi; tetiklendiği 4 karenin sayısal
// büyümesi 1.114 / 1.103 / 1.097 ve 0.997 idi (genel medyan 1.02, tüm setin
// maksimumu 1.26). Sonuncusunda kafa hiç büyümemişti ve gözle de normaldi.
// 1.05, "hiç büyüme yok" ile "belirgin büyüme" arasını ayırır: sayısal ölçüm
// bunun altındaysa Vision'ın kafa reddi geçersiz sayılır.
// Böylece kapı 77 karede 4 değil 3 kareyi eler (%5.2 -> %3.9).
const VISION_PROPORTION_GROWTH_MIN = 1.05;

/**
 * İnce kafa/omuz ölçüm satırlarını sayıya çevirir ve oranı hesaplar.
 *
 * SADECE ÖLÇÜM — hiçbir kareyi ELEMEZ (gerekçe: Vision prompt'undaki
 * "İNCE KAFA/OMUZ ÖLÇÜMÜ" notu). Eşik ancak gerçek dağılım biriktikten
 * sonra tartışılır.
 *
 * oran = omuz genişliği / kafa genişliği, yani "omuza kaç kafa sığıyor".
 * Kafa büyüdükçe DÜŞER. fark = çıktı oranı - taban oranı; NEGATİF fark,
 * kafanın şablona göre büyüdüğü anlamına gelir.
 *
 * Omuz ölçülemediğinde model 0 yazar (kadraj dışı/gizli) — o tarafın oranı
 * null bırakılır. Kanıt yokken sayı uydurmak, kalibrasyonu bozar.
 */
function headWidthMeasurement({ baseHeadWLine, baseShoulderWLine, outHeadWLine, outShoulderWLine } = {}) {
  const num = (line) => {
    if (!line) return null;
    const m = /:\s*(\d+(?:\.\d+)?)/.exec(line);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const ratio = (shoulder, head) =>
    shoulder != null && head != null && shoulder > 0 && head > 0 ? shoulder / head : null;

  const baseHead = num(baseHeadWLine);
  const baseShoulder = num(baseShoulderWLine);
  const outHead = num(outHeadWLine);
  const outShoulder = num(outShoulderWLine);
  const baseRatio = ratio(baseShoulder, baseHead);
  const outRatio = ratio(outShoulder, outHead);
  return {
    baseHead, baseShoulder, outHead, outShoulder,
    baseRatio, outRatio,
    diff: baseRatio != null && outRatio != null ? outRatio - baseRatio : null,
  };
}

/**
 * Vision kalite kontrolü — İKİ AYRI ÇAĞRI (2026-08-22 yeniden yapılandırma).
 *
 * KÖK NEDEN (gerçek veri, 2026-08-21 üretimi): 8 kararsızlığın 8'i de
 * REFERANSLI promptta yaşandı; referans göndermeyen yedek prompt 3 kez
 * çalıştı ve HİÇ reddedilmedi. Yani politika reddini tetikleyen şey,
 * gerçek bir kişinin fotoğraflarını gönderip yüz hatlarını karşılaştırtmak
 * (OpenAI'nin yüz tanıma politikası) — prompt'un nasıl çerçevelendiği
 * değil.
 *
 * ESKİ TASARIMIN HATASI: 10 kontrolün (A-J) yalnızca İKİSİ (A hat sadakati,
 * D saç) referans gerektiriyordu; diğer sekizi (artefakt, ten tutarlılığı,
 * kafa/omuz oranı, boyun bağlantısı, bakış, el, parlaklık, yönelim) sadece
 * ÇIKTIYA bakıyordu. Hepsi tek prompt'ta olduğu için, iki referanslı soru
 * yüzünden gelen ret SEKİZ referanssız kontrolü de birlikte götürüyordu.
 *
 * YENİ TASARIM (+ 2026-09-06 base karşılaştırması):
 *   ÇAĞRI 1 ("base" | "self") — kafa / bakış / ten / bağlantı.
 *     base: çıktı + TABAN. Bakış ve kafa boyutu şablonla karşılaştırılır.
 *     self: yalnızca çıktı (taban yoksa).
 *   ÇAĞRI 2 ("ref")  — yalnızca A + D, yüz referanslarıyla.
 *
 * Çağrı 1 başarısız olursa çağrı 2 HİÇ YAPILMAZ.
 */
async function assessOutputWithVision(buf, referenceImages, opts = {}) {
  const baseImage = opts && opts.baseImage != null ? opts.baseImage : null;
  const baseContext = baseImage ? [baseImage] : [];
  const mode1 = baseImage ? "base" : "self";
  const self = await assessOutputWithVisionRetrying(buf, baseContext, mode1);
  // SADE AKIŞTA TEN REDDİ ELEMEZ (2026-11-04): çağıran "skin" reddini yalnız
  // loglayıp kareyi kabul ediyor. O yüzden çağrı 2 (saç + hat sadakati)
  // atlanmamalı — atlansaydı ten uyarılı kare saç/yüz kontrolünden hiç
  // geçmeden kabul edilirdi. Çağrı 2 reddederse onun sebebi döner; geçerse
  // "skin" sonucu döner (çağıran loglayıp kabul eder).
  const skinOnly = !self.ok && self.reason === "skin" && SIMPLE_PIPELINE;
  if (!self.ok && !skinOnly) return self;

  const refs = (Array.isArray(referenceImages) ? referenceImages : [referenceImages])
    .filter((r) => r != null);
  if (refs.length === 0) return self;

  const ref = await assessOutputWithVisionRetrying(buf, refs, "ref");
  if (!ref.ok) return ref;
  if (skinOnly) return self;
  if (ref.inconclusive) {
    console.warn(
      "Vision hat-sadakati sorusu kararsız kaldı (politika reddi) — " +
      "çağrı-1 kontroller GEÇTİ, kimlik kararı sayısal kapıya bırakıldı"
    );
  }
  return { ...self, inconclusive: self.inconclusive };
}

/** Tek bir Vision sorusunu, kararsız kalırsa sınırlı sayıda tekrar dener. */
async function assessOutputWithVisionRetrying(buf, refs, mode, attempt = 1) {
  const result = await assessOutputWithVisionOnce(buf, refs, mode);
  if (!result.inconclusive) return result;
  if (attempt < VISION_INCONCLUSIVE_MAX_ATTEMPTS) {
    console.warn(
      `Vision (${mode}) kararsız/reddedilmiş cevap verdi — tekrar deneniyor ` +
      `(deneme ${attempt + 1}/${VISION_INCONCLUSIVE_MAX_ATTEMPTS})`
    );
    return assessOutputWithVisionRetrying(buf, refs, mode, attempt + 1);
  }
  return result;
}

// REFERANS GEREKTİREN kontroller — YALNIZCA bu ikisi (A: hat sadakati,
// D: saç). Diğer sekiz kontrol referans görmeden yapılabildiği için ayrı
// çağrıya taşındı (bkz. assessOutputWithVision başlığı).
//
// DİL SEÇİMİ: "aynı kişi mi", "kimlik", "bu kişi" gibi ifadeler bilinçli
// olarak YOK — politika sınıflandırıcısını tetikleyen tam olarak bu çerçeve.
// Soru bir GEOMETRİ KOPYALAMA denetimi olarak kuruluyor.
const VISION_REF_PROMPT =
  "You are an automated QA step inside an image-editing pipeline.\n" +
  "IMAGE 1 is the pipeline's OUTPUT. The remaining images are the SOURCE the " +
  "pipeline was instructed to reproduce. Report rendering fidelity only.\n\n" +
  "A) FEATURE SHAPE FIDELITY — were the feature SHAPES in the source " +
  "reproduced in IMAGE 1? Compare nose shape and width, eyebrow thickness and " +
  "arch, eye shape and spacing, lip shape and thickness, and jaw, chin and " +
  "cheekbone structure. Differences in angle, lighting, styling and expression " +
  "are expected and fine — judge only whether the underlying SHAPES were " +
  "copied. If the shapes are clearly different, the render failed.\n" +
  "D) HAIR — judge only GROSS mismatches against the source, never styling: " +
  "does IMAGE 1 add hair the source does not have (source bald or clearly " +
  "balding, IMAGE 1 with a full head of hair), or a hairline/length that is " +
  "clearly not from the source? Messy, windblown, differently combed or " +
  "partly hidden hair is fine and passes.\n" +
  // ÇOĞUNLUK KURALI (2026-09-13, gerçek vaka job f483d510): bu kapı TEK bir
  // işte 5 kare eledi ("Hair added where the source has none"), kullanıcı
  // fotoğrafları inceledi ve kişinin GÜR DALGALI SAÇI olduğunu doğruladı —
  // beşi de yanlış pozitif. Eski metin "source bald or clearly balding"
  // diyordu ve model bunu TEK BİR kaynağa bakarak uyguluyordu: cevaplardan
  // biri bunu açıkça ele veriyor — "IMAGE 1 has a full head of hair while ONE
  // SOURCE shows a clearly balding head". Islak, geriye yatık, şapkalı ya da
  // tepeden ışık alan tek bir selfie tüm işi zehirliyordu. Karar artık
  // kaynakların ÇOĞUNLUĞUNA bağlı; tek bir belirsiz kare kapıyı tetikleyemez.
  "Decide this from the SOURCES AS A WHOLE, never from a single source image: " +
  "only report a mismatch if the CLEAR MAJORITY of the source images agree. " +
  "A single source that looks balding because the hair is wet, slicked back, " +
  "under a hat, cropped out of frame or lit from above is NOT evidence — if " +
  "the other sources show hair, the person has hair and this passes.\n\n" +
  "Reply on exactly one line, one of:\n" +
  "GOOD: <why it passes>\n" +
  "BAD_FEATURES: <which feature shapes differ>\n" +
  "BAD_HAIR: <e.g. hair added where the source has none>";

// Politika reddini azaltmak için sistem mesajı. İÇERİĞİ DOĞRU: kullanıcı
// kendi fotoğraflarını kendi üretimi için yüklüyor ve sonucu denetliyoruz;
// kimse tanımlanmıyor/isimlendirilmiyor.
const VISION_SYSTEM_MSG =
  "You are an automated quality-assurance component inside an image-" +
  "generation pipeline. You evaluate the pipeline's own rendered output " +
  "against source material the user supplied for their own generation job. " +
  "You report rendering defects only — you never identify, name, or " +
  "speculate about who anyone is.";

async function assessOutputWithVisionOnce(buf, referenceImages, mode = "self") {
  try {
    const b64 = buf.toString("base64");
    // "ref" = yüz kaynakları; "base" = taban. "self" = yalnız çıktı.
    const refs = (mode === "ref" || mode === "base")
      ? (Array.isArray(referenceImages) ? referenceImages : [referenceImages])
          .filter((r) => r != null)
      : [];

    const prompt = mode === "ref"
      ? (VISION_REF_PROMPT)
      : mode === "base"
      ? ("You are a quality checker for an AI image-editing pipeline.\n" +
         "IMAGE 1 is the pipeline OUTPUT. IMAGE 2 is the BASE canvas that was edited — it is the " +
         "source of truth for HEAD SIZE (head vs shoulders) and GAZE (where the eyes look).\n\n" +
         "B) RENDERING QUALITY — is the face in IMAGE 1 free of AI artifacts? It fails if you see a " +
         "puffed/swollen/rounded/melted face, warped lips, mouth, eyes or nose, an unnaturally stretched " +
         "or rectangular face, an unexplained dark blotch or smudge, or a generally deformed face.\n" +
         "C) SKIN TONE CONSISTENCY — in IMAGE 1 only: is skin colour the SAME on face, neck, chest/" +
         "shoulders if visible, forearms and hands? Shading is fine; two different people's tones on " +
         "one body (face matching target, arms still the base person's tone) is HANDS_OR_ARMS_MISMATCH.\n" +
         "E) HEAD SPAN — do NOT judge whether the two images 'match'. MEASURE each image separately and " +
         "report both numbers; the comparison is done elsewhere. For one image, lay the width of the " +
         "head (ear to ear) against the width of the shoulders (shoulder point to shoulder point) and " +
         "answer: how many head-widths fit across the shoulders? A normal adult is about 3. A " +
         "bobble-headed render is 2 or less. Report 1.5, 2, 2.5, 3, 3.5 or 4, choosing the nearest. " +
         "Use NO_SHOULDERS only if that image shows no shoulder at all — a partly visible, turned or " +
         "clothed shoulder still counts and must be measured. Measure IMAGE 2 (base) first, then " +
         "IMAGE 1 (output), and let the two answers differ if that is what you see.\n" +
         "F) NECK/HEAD ATTACHMENT — on IMAGE 1: stretched neck, pasted seam, floating head, or head " +
         "pushed back in depth vs shoulders → fail. Ordinary tilts are fine.\n" +
         "G) GAZE — again do NOT judge 'matching'. Report where the eyes look in EACH image separately, " +
         "using the viewer's left/right (not the person's). Answer CAMERA when the irises meet the lens, " +
         "LEFT or RIGHT when they look to that side of the frame, UP or DOWN when the vertical is what " +
         "stands out, and AWAY only when the eyes are visible but their direction genuinely cannot be " +
         "read. NEVER copy IMAGE 2's token onto IMAGE 1 to look consistent. If one image meets the " +
         "lens and the other looks off-camera, the two lines MUST differ. After the two tokens, also " +
         "judge whether they look at the SAME point: SAME only if the irises sit in the same place in " +
         "the eye opening and aim at the same spot in the scene. Both labelled CAMERA (or both LEFT) " +
         "can still be DIFFERENT if one looks slightly off. Report IMAGE 2 (base) first, then IMAGE 1 " +
         "(output).\n" +
         // 2026-09-09 kullanıcı bildirimi (job 52781069, teslim edilen
         // elegance_6): el silik/yumuşak çıkmıştı ama bu satır tek cümleydi
         // ve model NORMAL dedi. Sayısal netlik oranı (UZUV TEN ÖLÇÜM'deki
         // yüzeGöreNetlik) eşik yapılamıyor — 131 ölçümlük dağılımda 0.06'ya
         // kadar inen ONLARCA kare sorunsuz teslim edilmiş, oran tek başına
         // iyi/kötü ayırmıyor. Bu yüzden çözüm sayısal eşik değil, sorunun
         // kendisini "self" modundaki (2069) ayrıntı seviyesine çıkarmak:
         // modele neyin kusur SAYILMADIĞI da söylenince yargı keskinleşiyor.
         "H) HAND QUALITY — look specifically at any visible hand or fingers in IMAGE 1. It fails if " +
         "they look blurry, smeared, soft or melted COMPARED TO the rest of the photo's sharpness, or " +
         "anatomically wrong (extra or missing fingers, fused fingers, an impossible joint). A hand " +
         "that is resting, clasped, holding an object, in motion or partly hidden is completely " +
         "normal — only fail a hand that is actually rendered badly.\n" +
         "I) FACE EXPOSURE — IMAGE 1 face blown out / unnaturally luminous vs its scene → fail.\n" +
         "J) HEAD ORIENTATION FIT — IMAGE 1 head orientation must fit its body/scene AND match IMAGE 2's " +
         "head attitude (turn/tilt). Wrong-for-scene or clearly different from base → fail.\n" +
         "K) BODY INTEGRITY — is the person in IMAGE 1 fully OPAQUE and solid? It fails if any part of " +
         "the body — arm, shoulder, torso, hand — is semi-transparent so that the background (railing, " +
         "furniture, sea, wall) shows THROUGH it, if the silhouette smears into the background as a " +
         "double exposure, or if a limb dissolves or is cut off mid-air. Ordinary occlusion (an object " +
         "in front of the person) and motion blur are fine.\n" +
         "L) HEAD VS BODY — look ONLY at IMAGE 1. Does the face point the same way the torso / walk / " +
         "shoulders are going, or was the face rotated toward the camera to make it easier to draw? " +
         "ALIGNED: head and body share one direction (a 3/4 portrait whose chest also faces that way " +
         "is ALIGNED). PULLED_TO_CAMERA: the body is walking or turned aside but the face has been " +
         "yanked toward the lens so the eyes meet the camera. Ignore IMAGE 2 for this line.\n" +
         "M) FACE vs ARM LIGHT — look ONLY at IMAGE 1. Compare the LIGHT on the face with the LIGHT on " +
         "visible bare arms or hands (ignore clothes). MATCHED: one lighting setup — if the face is " +
         "lit, the arms show the same key light, similar highlight strength and the same direction. " +
         "FACE_OVERLIT: the face is clearly lit (sheen, key-light, flash/studio look) while the arms/" +
         "hands stay matte and much darker, as if they were shot under a different light. Ordinary " +
         "portrait falloff that still reaches the arms is MATCHED. Skin-tone differences are question " +
         "C, not this line.\n" +
         // YÜZ ARTEFAKT SORUSU (2026-09-13) — kullanıcı TESLİM EDİLMİŞ üç
         // karede "yüzde boyalar/lekeler" bildirdi. Bu bir yanlış-KABUL:
         // hiçbir mevcut kapı görmüyordu. FACE_EXPOSURE yalnızca TÜM yüzün
         // patlamasını arıyor; bu kusur küçük, lokal ve KESKİN KENARLI.
         // Sayısal ölçüm de eklendi ama iki sınıfı ayıramadı (bkz.
         // faceArtifact.js) — bu soru o boşluğu kapatan katman.
         "N) FACE ARTIFACT — look closely at the skin of the face (forehead, brows, cheeks, nose, " +
         "chin). It fails if there is a PATCH that does not belong to the photograph: a small flat " +
         "area of grey, white or washed-out colour sitting on the skin, a straight-edged or " +
         "rectangular block, a smear, a streak, or a region that looks pasted on or painted over. " +
         "The giveaway is the EDGE — real light and shadow fade smoothly into skin, these patches " +
         "have a hard or geometric border and lose the skin's colour. Ordinary highlights, shine, " +
         "stubble, scars, moles, freckles and soft shadows are NORMAL and pass — only classify a " +
         "patch you can clearly see does not belong.\n\n" +
         // AWAY PARÇALANDI (2026-09-13) — bkz. gazeGate.js başlığı. Tek bir
         // AWAY kovası hem sağa hem sola uzağa bakışı içine alıyordu ve
         // "taban AWAY / çıktı AWAY" eşit sayılıp geçiyordu (job f0bc4d5c
         // c1: kullanıcı "tamamen farklı yere bakıyor" dedi, kare teslim
         // edilmişti). Çıplak AWAY hâlâ seçenek: modelin yönü gerçekten
         // seçemediği durumda kullanacağı kaçış kapısı, ve o durumda kapı
         // elemiyor. AÇIKLAMA SATIR BLOĞUNUN DIŞINDA: "tam on dört satır"
         // talimatının arasına düz metin koymak biçimi bozuyordu.
         "For the two gaze lines below: LEFT/RIGHT/UP/DOWN mean the eyes are " +
         "turned that way but still roughly towards the viewer's side of the " +
         "scene; the AWAY_* values mean the eyes are directed off into the " +
         "distance, and you must still say WHICH WAY — AWAY_LEFT and AWAY_RIGHT " +
         "are from the VIEWER'S point of view as you look at the image. Use the " +
         "bare AWAY only when you genuinely cannot tell which way the eyes " +
         "point.\n\n" +
         // İNCE KAFA/OMUZ ÖLÇÜMÜ (2026-09-22) — SADECE ÖLÇÜM, KAPI DEĞİL.
         //
         // NEDEN: HEAD_SPAN satırları (yukarıda) kafa/omuz oranını ZATEN
         // soruyor ama ölçeği kaba (0.5 kademe) ve pratikte tek kovaya
         // doyuyor: 2026-09-22'de 84 karenin 77'si "2.5 / 2.5" geldi.
         // Kullanıcının gözle "kafa çok büyük" dediği iki kare de 2.5/2.5
         // ölçüldü — biri sayısal büyümenin o günkü rekoruna (1.20) sahipti.
         // Yani sinyal yok değil, ÇÖZÜNÜRLÜK yok.
         //
         // YÖNTEM: tek bir "kaç kafa sığıyor" yargısı yerine İKİ HAM ÖLÇÜM
         // isteniyor (kafa genişliği ve omuz genişliği, kare genişliğinin
         // yüzdesi olarak) ve oran KODDA hesaplanıyor. Bu, dosyanın kendi
         // kuralının bir adım ilerisi: "yargıyı elinden al, ÖLÇÜM iste".
         // Yüzde tamsayı olarak istenir çünkü model ondalık uydurmaya
         // meyilli; 1 birim = kare genişliğinin %1'i zaten yeterli çözünürlük.
         //
         // BU SATIRLAR HİÇBİR KAREYİ ELEMEZ. Yalnızca loglanır. Eşik ancak
         // gerçek dağılım biriktikten ve kullanıcının işaretlediği kareleri
         // işaretlemediklerinden AYIRDIĞI kanıtlandıktan sonra konulabilir.
         "For the four width lines below: measure how WIDE the head is (temple " +
         "to temple, ignoring hair volume) and how WIDE the shoulders are " +
         "(outer edge to outer edge of the deltoids), each as a percentage of " +
         "the FULL IMAGE WIDTH, as a whole number. Measure IMAGE 2 for the " +
         "BASE_ lines and IMAGE 1 for the OUTPUT_ lines. These are raw " +
         "measurements of two different photos — they will often differ, and " +
         "you must never copy one into the other. If the shoulders are cropped " +
         "out of frame or hidden, answer 0 for that shoulder line.\n\n" +
         "Reply on exactly nineteen lines:\n" +
         "FACE_ARTIFACT: <NONE | PATCH>\n" +
         "BODY_INTEGRITY: <SOLID | TRANSPARENT_OR_GHOSTED>\n" +
         "HEAD_ORIENTATION: <FITS_SCENE | WRONG_FOR_SCENE>\n" +
         "HEAD_VS_BODY: <ALIGNED | PULLED_TO_CAMERA>\n" +
         "BASE_HEAD_SPAN: <1.5 | 2 | 2.5 | 3 | 3.5 | 4 | NO_SHOULDERS>\n" +
         "OUTPUT_HEAD_SPAN: <1.5 | 2 | 2.5 | 3 | 3.5 | 4 | NO_SHOULDERS>\n" +
         "BASE_HEAD_W: <whole number, % of image width>\n" +
         "BASE_SHOULDER_W: <whole number, % of image width, or 0>\n" +
         "OUTPUT_HEAD_W: <whole number, % of image width>\n" +
         "OUTPUT_SHOULDER_W: <whole number, % of image width, or 0>\n" +
         "BASE_GAZE: <CAMERA | LEFT | RIGHT | UP | DOWN | AWAY_LEFT | AWAY_RIGHT | AWAY_UP | AWAY_DOWN | AWAY>\n" +
         "OUTPUT_GAZE: <CAMERA | LEFT | RIGHT | UP | DOWN | AWAY_LEFT | AWAY_RIGHT | AWAY_UP | AWAY_DOWN | AWAY>\n" +
         "GAZE_POINT: <SAME | DIFFERENT>\n" +
         "NECK_ATTACHMENT: <NORMAL | STRETCHED_OR_DETACHED | PUSHED_BACK>\n" +
         "SKIN_TONE: <CONSISTENT | HANDS_OR_ARMS_MISMATCH>\n" +
         "HAND_QUALITY: <NORMAL | BLURRY_OR_MALFORMED>\n" +
         "FACE_EXPOSURE: <NORMAL | BLOWN_OUT>\n" +
         "FACE_ARM_LIGHT: <MATCHED | FACE_OVERLIT>\n" +
         "<verdict>: <SHORT reason, max 12 words>\n\n" +
         "Decide the first eighteen lines before the verdict. The head-span, width and gaze lines are " +
         "MEASUREMENTS, " +
         "not judgements — report what each image actually shows even when the two disagree, and never " +
         "copy one line into the other just to look consistent. The four width lines never decide the " +
         "verdict on their own; report them honestly and judge the verdict from the other lines. " +
         "Binding rules — the verdict MUST match " +
         "whichever of these fired, however clean the rest looks: OUTPUT_HEAD_SPAN smaller than " +
         "BASE_HEAD_SPAN (fewer head-widths across the shoulders means a bigger head) -> " +
         "BAD_PROPORTION. " +
         "STRETCHED_OR_DETACHED or PUSHED_BACK -> BAD_ATTACHMENT. HANDS_OR_ARMS_MISMATCH -> BAD_SKIN. " +
         "BLURRY_OR_MALFORMED -> BAD_HANDS. BLOWN_OUT -> BAD_EXPOSURE. FACE_OVERLIT -> BAD_FACE_LIGHT. " +
         "WRONG_FOR_SCENE -> BAD_ORIENTATION. TRANSPARENT_OR_GHOSTED -> BAD_GHOSTING. " +
         // GAZE_POINT'İ BAD_GAZE'E BAĞLAYAN KURAL BURADAN KALDIRILDI
         // (2026-09-18).
         //
         // GAZE_POINT kapısı 2026-09-16'da ölçümle kaldırılmıştı (bkz. aşağıda
         // gazePointLine'ın yanındaki gerekçe) — ama YALNIZCA SATIR KAPISI
         // kaldırılmıştı. Bu bağlayıcı kural burada kalınca model, GAZE_POINT
         // DIFFERENT gördüğü her karede verdict'i BAD_GAZE yazmaya devam etti
         // ve aşağıdaki "BAD_GAZE -> reason:gaze" güvencesi o reddi aynen
         // uyguladı. Yani kapı kaldırıldı sanılırken ARKA KAPIDAN elemeye
         // devam ediyordu.
         //
         // KANIT (2026-09-16..18, 21 iş, 212 ret): 106 vision-gaze reddinin
         // 97'sinin gerekçe metni harfi harfine GAZE_POINT'in ifadesiydi
         // ("eyes look at a different point than the base"). Yani iki gün
         // önce kaldırılmasına karar verilen kapı, tüm retlerin %46'sını tek
         // başına üretiyordu.
         "PATCH -> BAD_ARTIFACT. " +
         "Check every question before answering GOOD. Verdict is one of:\n" +
         "GOOD: <why it passes>\n" +
         "BAD_ARTIFACT: <e.g. grey rectangular patch above the left brow>\n" +
         "BAD_QUALITY: <what looks broken>\n" +
         "BAD_SKIN: <where the tone mismatches, e.g. hands darker than face>\n" +
         "BAD_PROPORTION: <e.g. head too large vs base shoulders>\n" +
         "BAD_ATTACHMENT: <e.g. neck stretched, head floating behind the body, head pushed back>\n" +
         "BAD_HANDS: <e.g. fingers blurry/melted, wrong finger count>\n" +
         "BAD_EXPOSURE: <e.g. face blown out, detail lost to white>\n" +
         "BAD_FACE_LIGHT: <e.g. face flash-lit, arms still dark and matte>\n" +
         "BAD_GAZE: <e.g. eyes look at a different point than the base>\n" +
         "BAD_ORIENTATION: <e.g. head turn differs from base>\n" +
         "BAD_GHOSTING: <e.g. right arm see-through, railing visible through torso>\n" +
         "BAD_PULLED: <e.g. walking aside but face yanked to the lens>")
      : ("You are a quality checker for an AI image-editing pipeline.\n" +
         "IMAGE 1 was produced by an edit. Judge the rendered result itself:\n" +
         "B) RENDERING QUALITY — is the face in IMAGE 1 free of AI artifacts? It fails if you see a " +
         "puffed/swollen/rounded/melted face, warped lips, mouth, eyes or nose, an unnaturally stretched " +
         "or rectangular face, an unexplained dark blotch or smudge, or a generally deformed face.\n" +
         "C) SKIN TONE CONSISTENCY — is the skin colour the SAME across the whole visible body in " +
         "IMAGE 1? Compare the face against the neck, chest/shoulders if visible, forearms and hands, " +
         "one by one. Shading from light and shadow is normal, but if the hands, arms or chest are " +
         "noticeably darker or lighter in TONE than the face — as if two different people's skin were " +
         "combined — classify it as a mismatch below. A face that matches the target while arms stay " +
         "the base person's tone is ALWAYS a mismatch.\n" +
         "E) HEAD SIZE — compare, do not glance. Ignore the face identity itself. Put the width of the " +
         "head side by side with the width of the shoulders in IMAGE 1 and classify what you see:\n" +
         "  HEAD_NORMAL — the shoulders are roughly three head-widths across; the head belongs to " +
         "that body.\n" +
         "  HEAD_LARGE — the shoulders are barely two head-widths or less; OR the head clearly " +
         "dominates the frame / looks bobble-headed / pushed forward relative to the torso. Prefer " +
         "HEAD_LARGE when unsure between NORMAL and LARGE if the head reads oversized.\n" +
         "  HEAD_SMALL — the head is noticeably too small for the shoulders.\n" +
         "  NO_SHOULDERS — use ONLY when neither shoulder is inside the frame at all. A partly " +
         "visible, turned or clothed shoulder still counts as visible, so judge it.\n" +
         "F) NECK/HEAD ATTACHMENT — look specifically at where the head meets the neck and shoulders. " +
         "It fails if the neck looks unnaturally stretched or elongated, the head sits behind the " +
         "body's own depth plane as if pasted from a different photo, there is a visible seam, gap or " +
         "floating disconnect at the neck, OR the head/neck is pushed noticeably backward relative to " +
         "the torso — as if the head were set further back in depth than the shoulders it sits on, " +
         "reading as detached or sunken rather than resting naturally atop the spine. Normal head " +
         "tilts, turns and ordinary neck length are fine — only classify a clear structural problem " +
         "below.\n" +
         "G) GAZE DIRECTION — do the eyes look where this head and body imply they should for the " +
         "scene? It fails if: (1) the head/torso face one way but the irises clearly point somewhere " +
         "disconnected; (2) the pose is clearly looking away / profile / three-quarter but the eyes " +
         "have been forced toward the camera; (3) wall-eyed, cross-eyed, or otherwise structurally " +
         "broken gaze. A person simply looking away from the camera, looking down, or looking at " +
         "something off-frame in a way that MATCHES the head pose is completely normal — only " +
         "classify a gaze that is anatomically broken OR clearly fights the head/scene orientation.\n" +
         "H) HAND QUALITY — look specifically at any visible hand or fingers. It fails if they look " +
         "blurry, smeared, soft/melted compared to the rest of the sharply-rendered photo, or " +
         "anatomically wrong (extra or missing fingers, fused fingers, an impossible joint). Hands " +
         "resting, clasped, holding an object, or partly hidden are completely normal — only classify " +
         "a hand that is rendered badly.\n" +
         "I) FACE EXPOSURE — look at the brightness of the face itself, compared to the rest of the " +
         "photo. It fails if the face is BLOWN OUT: washed out, glowing, lit far brighter than the " +
         "scene around it, with facial detail lost to flat white areas on the forehead, nose or " +
         "cheeks, as if a light were shining only on the face. Normal bright daylight, natural " +
         "highlights and ordinary skin sheen are fine — only classify a face that has visibly lost " +
         "detail to overexposure or looks unnaturally luminous versus its own scene.\n" +
         "J) HEAD ORIENTATION FIT — does the head sit in the scene the way the body and setting " +
         "imply it should? It fails if the head is turned to an angle that does not fit the body's " +
         "posture or what the person is meant to be facing in the scene — e.g. the torso, shoulders " +
         "and situation point one way but the head is rotated somewhere unrelated, so the person " +
         "looks like they are facing the wrong way for the photo. Ordinary candid angles, looking " +
         "off-camera, and relaxed head tilts are fine — only classify a head whose orientation " +
         "clearly does not belong to the body/scene it was placed in.\n" +
         "K) BODY INTEGRITY — is the person fully OPAQUE and solid? It fails if any part of the body — " +
         "arm, shoulder, torso, hand — is semi-transparent so that the background (railing, furniture, " +
         "sea, wall) shows THROUGH it, if the silhouette smears into the background as a double " +
         "exposure, or if a limb dissolves or is cut off mid-air. Ordinary occlusion (an object in " +
         "front of the person) and motion blur are fine.\n" +
         "L) HEAD VS BODY — does the face point the same way the torso / walk / shoulders are going, " +
         "or was the face rotated toward the camera to make it easier to draw? ALIGNED if head and " +
         "body share one direction. PULLED_TO_CAMERA if the body walks or turns aside but the face " +
         "was yanked toward the lens.\n" +
         "M) FACE vs ARM LIGHT — compare the LIGHT on the face with the LIGHT on visible bare arms " +
         "or hands (ignore clothes). MATCHED if they share one lighting. FACE_OVERLIT if the face is " +
         "clearly lit (sheen, key-light, flash/studio look) while the arms/hands stay matte and much " +
         "darker, as if shot under a different light. Ordinary portrait falloff that still reaches " +
         "the arms is MATCHED. Skin-tone differences are question C, not this line.\n" +
         // YÜZ ARTEFAKT SORUSU — taban modundaki N) ile aynı gerekçe ve aynı
         // metin (bkz. oradaki başlık). İki mod da aynı kusuru görmeliydi.
         "N) FACE ARTIFACT — look closely at the skin of the face (forehead, brows, cheeks, nose, " +
         "chin). It fails if there is a PATCH that does not belong to the photograph: a small flat " +
         "area of grey, white or washed-out colour sitting on the skin, a straight-edged or " +
         "rectangular block, a smear, a streak, or a region that looks pasted on or painted over. " +
         "The giveaway is the EDGE — real light and shadow fade smoothly into skin, these patches " +
         "have a hard or geometric border and lose the skin's colour. Ordinary highlights, shine, " +
         "stubble, scars, moles, freckles and soft shadows are NORMAL and pass — only classify a " +
         "patch you can clearly see does not belong.\n\n" +
         "Reply on exactly twelve lines:\n" +
         "FACE_ARTIFACT: <NONE | PATCH>\n" +
         "BODY_INTEGRITY: <SOLID | TRANSPARENT_OR_GHOSTED>\n" +
         "HEAD_ORIENTATION: <FITS_SCENE | WRONG_FOR_SCENE>\n" +
         "HEAD_VS_BODY: <ALIGNED | PULLED_TO_CAMERA>\n" +
         "HEAD_VS_SHOULDERS: <HEAD_NORMAL | HEAD_LARGE | HEAD_SMALL | NO_SHOULDERS>\n" +
         "NECK_ATTACHMENT: <NORMAL | STRETCHED_OR_DETACHED | PUSHED_BACK>\n" +
         "SKIN_TONE: <CONSISTENT | HANDS_OR_ARMS_MISMATCH>\n" +
         "GAZE_DIRECTION: <NATURAL | WRONG_DIRECTION>\n" +
         "HAND_QUALITY: <NORMAL | BLURRY_OR_MALFORMED>\n" +
         "FACE_EXPOSURE: <NORMAL | BLOWN_OUT>\n" +
         "FACE_ARM_LIGHT: <MATCHED | FACE_OVERLIT>\n" +
         "<verdict>: <SHORT reason, max 12 words>\n\n" +
         "Decide the first eleven lines before the verdict. Binding rules — the verdict MUST match " +
         "whichever of these fired, however clean the rest looks: PATCH -> BAD_ARTIFACT. " +
         "HEAD_LARGE -> BAD_PROPORTION. " +
         "STRETCHED_OR_DETACHED or PUSHED_BACK -> BAD_ATTACHMENT. HANDS_OR_ARMS_MISMATCH -> BAD_SKIN. " +
         "WRONG_DIRECTION -> BAD_GAZE. BLURRY_OR_MALFORMED -> BAD_HANDS. BLOWN_OUT -> BAD_EXPOSURE. " +
         "FACE_OVERLIT -> BAD_FACE_LIGHT. " +
         "WRONG_FOR_SCENE -> BAD_ORIENTATION. TRANSPARENT_OR_GHOSTED -> BAD_GHOSTING. " +
         "PULLED_TO_CAMERA -> BAD_PULLED. " +
         "Check every question before answering GOOD. Verdict is one of:\n" +
         "GOOD: <why it passes>\n" +
         "BAD_ARTIFACT: <e.g. grey rectangular patch above the left brow>\n" +
         "BAD_QUALITY: <what looks broken>\n" +
         "BAD_SKIN: <where the tone mismatches, e.g. hands darker than face>\n" +
         "BAD_PROPORTION: <e.g. head too large for the shoulders>\n" +
         "BAD_ATTACHMENT: <e.g. neck stretched, head floating behind the body, head pushed back>\n" +
         "BAD_GAZE: <e.g. eyes point a different way than the head is turned>\n" +
         "BAD_HANDS: <e.g. fingers blurry/melted, wrong finger count>\n" +
         "BAD_EXPOSURE: <e.g. face blown out, detail lost to white>\n" +
         "BAD_FACE_LIGHT: <e.g. face flash-lit, arms still dark and matte>\n" +
         "BAD_ORIENTATION: <e.g. head turned away from what the body faces>\n" +
         "BAD_GHOSTING: <e.g. right arm see-through, railing visible through torso>\n" +
         "BAD_PULLED: <e.g. walking aside but face yanked to the lens>");

    // Çıktı her zaman detail "high" (kusurlar ince ayrıntıda). Selfie'ler
    // için bkz. aşağıdaki LOW DETAIL notu.
    const content = [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" } },
    ];
    // SELFIE'LER LOW DETAIL (2026-10-11, maliyet sınırı): "ref" çağrısı 6
    // görselle ~6700 token'dı. Selfie'ler low (85 token) gidince 42 karelik
    // arşiv kümesinde (3 iş + vision retleri) kararların 42'si de aynı kaldı,
    // kare başı Vision $0.027 -> $0.015. Çıktı ve taban (base çağrısı) high.
    // Kümede kimlik/saç reddi yoktu — kimlik ayrıca sayısal ölçülüyor.
    for (const r of refs) {
      const refUrl = Buffer.isBuffer(r)
        ? `data:image/jpeg;base64,${r.toString("base64")}`
        : r; // public URL (fal CDN / imzalı Firebase URL)
      content.push({ type: "image_url", image_url: { url: refUrl, detail: mode === "ref" ? "low" : "high" } });
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
        max_tokens: 200,
        temperature: 0,
        messages: [
          { role: "system", content: VISION_SYSTEM_MSG },
          { role: "user", content },
        ],
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
      recordUsage(VISION_MODEL, u);
      console.log(
        `MALIYET VISION: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} ` +
        `toplam=${u.total_tokens ?? "?"} model=${VISION_MODEL} gorselSayisi=${refs.length + 1}`
      );
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();

    // DOKUZ SATIRLI CEVAP: Vision önce sekiz zorunlu SINIFLANDIRMA yapıyor
    // (kafa/omuz, boyun bağlantısı, ten rengi, bakış, el, parlaklık, kafa
    // yönelimi, gövde bütünlüğü), karar en son satırda geliyor.
    // Gerekçe: serbest metin isteyince model her kareye rutin olarak
    // "GOOD: ...correct proportions" yazıyordu — kafa gövdeye göre gözle
    // görülür büyük olan karelerde bile (5/5 geçmişti).
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
    // NECK_ATTACHMENT / SKIN_TONE: HEAD_VS_SHOULDERS ile AYNI sebepten zorunlu
    // sınıflandırma satırları (2026-08-07) — serbest metindeki BAD_SKIN de bu
    // sınıflandırma eklenmeden önce gerçek bir vakada (elleri koyu kalmış bir
    // kare) "GEÇTİ" demişti; HEAD_VS_SHOULDERS'ı düzelten aynı yöntem
    // (zorunlu sınıf + bağlayıcı kural) burada da uygulanıyor.
    // GAZE_DIRECTION (2026-08-12): AYNI yöntem, aynı gerekçe — kullanıcı
    // örneği, kafa açısı/YAW ölçümü temiz çıktığı hâlde bakış yönü gözle
    // yanlış duran bir kare bildirdi. NECK_ATTACHMENT'a PUSHED_BACK eklendi
    // (aynı olayda "boyun çok geride" tarifi STRETCHED_OR_DETACHED'e girmiyordu).
    // HAND_QUALITY (2026-08-13): AYNI yöntem — kullanıcı, netlik kapısının
    // (tüm kareye bakan Laplacian varyansı) ve ten kapısının (yalnızca RENK
    // ölçen) yakalamadığı bir "elin silik/bulanık çıkması" örneği bildirdi.
    // Yerel el kalitesini deterministik ölçen bir katman yok — bu soru Vision'a
    // ekleniyor (aynı çağrı, ek maliyet yok).
    const isNeckLine = (l) => /^NECK_ATTACHMENT/.test(l.toUpperCase());
    const isSkinLine = (l) => /^SKIN_TONE/.test(l.toUpperCase());
    const isGazeLine = (l) => /^GAZE_DIRECTION/.test(l.toUpperCase());
    const isHandLine = (l) => /^HAND_QUALITY/.test(l.toUpperCase());
    // FACE_EXPOSURE / HEAD_ORIENTATION (2026-08-21): AYNI yöntem, aynı gerekçe
    // — kullanıcı, tüm kapıları geçmiş bir karede (elegance chunk=3) "yüz çok
    // parlak çıkmış" ve "yüz doğru yere bakacak şekilde oturamamış" bildirdi.
    // Parlaklık için deterministik bir çıktı kapısı YOK (assessImageQuality'nin
    // isOverexposed'u yalnızca GİRDİ selfie'lerinde kullanılıyor ve TÜM KAREYE
    // bakıyor — sahne normalken yalnızca yüzü parlayan kareyi göremez).
    // Yönelim için de YAW kapısı var ama o şablonla sayısal farkı ölçüyor;
    // "kafa gövdenin/sahnenin baktığı yere bakmıyor" başka bir sorudur.
    const isExposureLine = (l) => /^FACE_EXPOSURE/.test(l.toUpperCase());
    const isOrientationLine = (l) => /^HEAD_ORIENTATION/.test(l.toUpperCase());
    // BODY_INTEGRITY (2026-09-06): AYNI yöntem, aynı gerekçe — kullanıcı, tüm
    // kapıları geçip TESLİM EDİLEN bir karede (job 1181577f, elegance chunk=6,
    // yat/marina) sağ kolun ve gövdenin YARI SAYDAM çıktığını, arkadaki
    // korkuluğun kolun içinden göründüğünü bildirdi. Hiçbir katman saydamlık/
    // hayalet birleşmeyi ölçmüyordu: ten kapısı rengi, netlik kapısı bulanıklığı,
    // boyun kapısı yalnızca kafa-gövde bağlantısını görüyor.
    const isIntegrityLine = (l) => /^BODY_INTEGRITY/.test(l.toUpperCase());
    // HEAD_VS_BODY (2026-09-06): şablon yaw'ı ölçülemezse yaw katmanı susuyor
    // ve Vision tabanı CAMERA diye yalanlayabiliyor (b64a0a65 c3 kahve yürüyüş).
    // Bu satır YALNIZCA çıktıya bakar: gövde/yürüyüş bir yöne, yüz merceğe
    // çekilmişse PULLED_TO_CAMERA.
    const isHeadBodyLine = (l) => /^HEAD_VS_BODY/.test(l.toUpperCase());
    // FACE_ARM_LIGHT (2026-09-07, b1d6972b): yüz ışıklı, kollar mat/koyu.
    // Ham L* eşiği şikâyetli ve şikâyetsiz kareleri ayıramadı; bu satır
    // ışık yönünü/şiddetini görür, ten tonunu (SKIN_TONE) karıştırmaz.
    const isFaceLightLine = (l) => /^FACE_ARM_LIGHT/.test(l.toUpperCase());
    // FACE_ARTIFACT (2026-09-13): yüzdeki lokal yama/leke. Bu satırın
    // TANINMASI ŞART — verdictLine aşağıda "bilinen satır olmayan ilk
    // satır" olarak seçiliyor, tanınmayan bir sınıf satırı verdict sanılıp
    // ayrıştırma bozulurdu.
    const isArtifactLine = (l) => /^FACE_ARTIFACT/.test(l.toUpperCase());
    const isGazePointLine = (l) => /^GAZE_POINT/.test(l.toUpperCase());
    // KARŞILAŞTIRMAYI ARTIK KOD YAPIYOR (2026-09-06). Taban modunda Vision'a
    // "kafa oranı/bakış tabanla eşleşiyor mu?" diye SORMUYORUZ; iki görselin
    // ölçümünü AYRI AYRI isteyip farkı burada hesaplıyoruz.
    //
    // NEDEN: 21 günlük üretim logu (146 kare) bu iki sorunun ölü olduğunu
    // gösterdi — HEAD_VS_SHOULDERS 135/135 "HEAD_NORMAL", GAZE_DIRECTION
    // 135/135 "NATURAL". Yani model, kullanıcının gözle "kafa çok büyük" ve
    // "yanlış yere bakıyor" dediği kareler dahil HİÇBİR kareye kusur demedi.
    // Bu, dosyada 2026-08-04'te belgelenen örüntünün aynısı: "eşleşiyor mu?"
    // gibi tek adımlı bir yargı sorusuna model rutin olarak "evet" diyor.
    // Çözüm de aynı: yargıyı elinden al, ÖLÇÜM iste.
    const isBaseSpanLine = (l) => /^BASE_HEAD_SPAN/.test(l.toUpperCase());
    const isOutSpanLine = (l) => /^OUTPUT_HEAD_SPAN/.test(l.toUpperCase());
    // İNCE KAFA/OMUZ ÖLÇÜMÜ (2026-09-22) — bkz. prompt'taki aynı başlıklı not.
    // SIRA ÖNEMLİ: _HEAD_SPAN testleri bu dördünden ÖNCE tanımlı; yine de
    // kalıplar birbirine karışmıyor çünkü _HEAD_W ile _HEAD_SPAN ayrı ekler.
    // Bu dördü verdictLine elemesine de eklenmek ZORUNDA (aşağıda): tanınmayan
    // bir ölçüm satırı "verdict" sanılırsa tüm ayrıştırma bozulur.
    const isBaseHeadWLine = (l) => /^BASE_HEAD_W\b/.test(l.toUpperCase());
    const isBaseShoulderWLine = (l) => /^BASE_SHOULDER_W\b/.test(l.toUpperCase());
    const isOutHeadWLine = (l) => /^OUTPUT_HEAD_W\b/.test(l.toUpperCase());
    const isOutShoulderWLine = (l) => /^OUTPUT_SHOULDER_W\b/.test(l.toUpperCase());
    const isBaseGazeLine = (l) => /^BASE_GAZE/.test(l.toUpperCase());
    const isOutGazeLine = (l) => /^OUTPUT_GAZE/.test(l.toUpperCase());
    const headsLine = lines.find(isHeadLine);
    const neckLine = lines.find(isNeckLine);
    const skinLine = lines.find(isSkinLine);
    const gazeLine = lines.find(isGazeLine);
    const handLine = lines.find(isHandLine);
    const exposureLine = lines.find(isExposureLine);
    const orientationLine = lines.find(isOrientationLine);
    const integrityLine = lines.find(isIntegrityLine);
    const headBodyLine = lines.find(isHeadBodyLine);
    const faceLightLine = lines.find(isFaceLightLine);
    const gazePointLine = lines.find(isGazePointLine);
    const baseSpanLine = lines.find(isBaseSpanLine);
    const outSpanLine = lines.find(isOutSpanLine);
    const baseGazeLine = lines.find(isBaseGazeLine);
    const outGazeLine = lines.find(isOutGazeLine);
    const artifactLine = lines.find(isArtifactLine);
    const baseHeadWLine = lines.find(isBaseHeadWLine);
    const baseShoulderWLine = lines.find(isBaseShoulderWLine);
    const outHeadWLine = lines.find(isOutHeadWLine);
    const outShoulderWLine = lines.find(isOutShoulderWLine);
    const verdictLine = lines.find(
      (l) => !isHeadLine(l) && !isNeckLine(l) && !isSkinLine(l) && !isGazeLine(l) &&
             !isHandLine(l) && !isExposureLine(l) && !isOrientationLine(l) &&
             !isIntegrityLine(l) && !isHeadBodyLine(l) && !isFaceLightLine(l) &&
             !isGazePointLine(l) && !isArtifactLine(l) &&
             !isBaseSpanLine(l) && !isOutSpanLine(l) &&
             !isBaseGazeLine(l) && !isOutGazeLine(l) &&
             !isBaseHeadWLine(l) && !isBaseShoulderWLine(l) &&
             !isOutHeadWLine(l) && !isOutShoulderWLine(l)
    ) || "";
    if (headsLine) console.log(`VISION ÖLÇÜM (kafa/omuz): ${headsLine}`);
    if (neckLine) console.log(`VISION ÖLÇÜM (boyun bağlantısı): ${neckLine}`);
    if (skinLine) console.log(`VISION ÖLÇÜM (ten rengi): ${skinLine}`);
    if (gazeLine) console.log(`VISION ÖLÇÜM (bakış yönü): ${gazeLine}`);
    if (handLine) console.log(`VISION ÖLÇÜM (el kalitesi): ${handLine}`);
    if (exposureLine) console.log(`VISION ÖLÇÜM (yüz parlaklığı): ${exposureLine}`);
    if (orientationLine) console.log(`VISION ÖLÇÜM (kafa yönelimi): ${orientationLine}`);
    if (integrityLine) console.log(`VISION ÖLÇÜM (gövde bütünlüğü): ${integrityLine}`);
    if (headBodyLine) console.log(`VISION ÖLÇÜM (kafa/gövde): ${headBodyLine}`);
    if (faceLightLine) console.log(`VISION ÖLÇÜM (yüz/kol ışığı): ${faceLightLine}`);
    if (artifactLine) console.log(`VISION ÖLÇÜM (yüz artefakt): ${artifactLine}`);
    if (gazePointLine) console.log(`VISION ÖLÇÜM (bakış noktası): ${gazePointLine}`);
    if (baseSpanLine || outSpanLine) console.log(`VISION ÖLÇÜM (kafa açıklığı): ${baseSpanLine || "—"} / ${outSpanLine || "—"}`);
    if (baseGazeLine || outGazeLine) console.log(`VISION ÖLÇÜM (bakış): ${baseGazeLine || "—"} / ${outGazeLine || "—"}`);
    // İNCE KAFA/OMUZ ORANI — YALNIZCA ÖLÇÜM, HİÇBİR KAREYİ ELEMEZ
    // (2026-09-22; gerekçe prompt'taki aynı başlıklı notta).
    {
      const m = headWidthMeasurement({
        baseHeadWLine, baseShoulderWLine, outHeadWLine, outShoulderWLine,
      });
      if (m.baseHead != null || m.outHead != null) {
        const f = (v) => (v != null ? v.toFixed(2) : "—");
        console.log(
          `VISION ÖLÇÜM (kafa/omuz ince): taban kafa=${m.baseHead ?? "—"} omuz=${m.baseShoulder ?? "—"} oran=${f(m.baseRatio)}` +
          ` | çıktı kafa=${m.outHead ?? "—"} omuz=${m.outShoulder ?? "—"} oran=${f(m.outRatio)}` +
          ` | fark=${m.diff != null ? (m.diff >= 0 ? "+" : "") + m.diff.toFixed(2) : "—"}`
        );
      }
    }

    const verdictDetail = () =>
      verdictLine.includes(":") ? verdictLine.slice(verdictLine.indexOf(":") + 1).trim().slice(0, 120) : null;

    // ÖLÇÜM KARŞILAŞTIRMASI — KULLANICININ 1. VE 2. ÖNCELİĞİ.
    // Omuz genişliğine sığan kafa sayısı ÇIKTIDA azaldıysa kafa büyümüş
    // demektir (3 kafa sığan omuzda 2 sığıyorsa kafa belirgin büyük). Tek
    // kademe (0.5) düşüş bile reddedilir: kullanıcı bunu en önemli madde
    // olarak bildirdi ve reddedilen kare zaten yeniden üretiliyor.
    // Ölçülemeyen taraf (NO_SHOULDERS / sayı yok) kapıyı sessizce devre dışı
    // bırakır — kanıt yokken kare elenmez.
    const spanOf = (line) => {
      if (!line) return null;
      const m = /:\s*([\d.]+)/.exec(line);
      const v = m ? Number(m[1]) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const baseSpan = spanOf(baseSpanLine);
    const outSpan = spanOf(outSpanLine);
    if (baseSpan != null && outSpan != null && baseSpan - outSpan >= VISION_HEAD_SPAN_DROP_MAX) {
      return {
        ok: false, reason: "proportion", inconclusive: false,
        detail: verdictDetail() || `kafa açıklığı ${baseSpan} -> ${outSpan}`,
      };
    }
    // BAKIŞ: İKİ SATIR DA OKUNABİLİYORSA VE FARKLIYSA ELEME (2026-09-07).
    //
    // 2026-09-06'da bu kapı kapalıydı: 4 uyuşmazlığın 3'ü tabanın yanlış
    // okunmasıydı. b1d6972b teslim chunk 0 bunu boşa çıkardı — satırlar
    // CAMERA / RIGHT idi, kullanıcı "tabanla aynı yere bakmıyor" dedi ve
    // kare geçti. Artık karşılaştırma kodda: taban ve çıktı token'ı farklıysa
    // (AWAY / satır yok hariç, fail-safe) reason=gaze.
    {
      const { isGazeMismatch, parseGazeToken } = require("./gazeGate");
      if (isGazeMismatch(baseGazeLine, outGazeLine)) {
        // ÖLÇÜLEN TOKENLAR DIŞARI TAŞINIYOR (2026-09-14): çağıran taraf
        // bunları bir sonraki denemenin düzeltici uyarısına yazıyor —
        // "gözü kameraya çektin" gibi sabit ve çoğu zaman YANLIŞ bir
        // teşhis yerine gerçek sapma bildiriliyor (bkz. retryCorrectionPrefix).
        return {
          ok: false, reason: "gaze", inconclusive: false,
          detail: verdictDetail() || `${baseGazeLine} / ${outGazeLine}`,
          gazeBase: parseGazeToken(baseGazeLine),
          gazeOut: parseGazeToken(outGazeLine),
        };
      }
    }

    // HEAD_LARGE bağlayıcıdır: model sınıfı "büyük" deyip verdict'i GOOD
    // bırakırsa (talimata rağmen olabiliyor) kare yine de reddedilir —
    // sınıflandırma satırı kararın kendisinden daha güvenilir bir sinyal.
    // (Bu satır artık yalnızca referanssız "self" modunda üretiliyor; taban
    // modunda yerini yukarıdaki iki-ölçüm karşılaştırması aldı.)
    if (headsLine && /HEAD_LARGE/i.test(headsLine)) {
      return { ok: false, reason: "proportion", detail: verdictDetail() || "HEAD_LARGE", inconclusive: false };
    }
    // STRETCHED_OR_DETACHED / PUSHED_BACK bağlayıcıdır — aynı gerekçe: boyun/
    // kafa bağlantı sorunu ana prompt'ta yasaklanıyor ama önceden onu
    // doğrulayan hiçbir ikinci katman yoktu (bkz. kullanıcı örneği, elegance_4_0.jpg
    // ve 2026-08-12 "boyun çok geride" bildirimi — PUSHED_BACK bu ikincisi için
    // eklendi, STRETCHED_OR_DETACHED'in kapsamadığı ayrı bir hata türü).
    if (neckLine && /STRETCHED_OR_DETACHED|PUSHED_BACK/i.test(neckLine)) {
      const which = /PUSHED_BACK/i.test(neckLine) ? "PUSHED_BACK" : "STRETCHED_OR_DETACHED";
      return { ok: false, reason: "attachment", detail: verdictDetail() || which, inconclusive: false };
    }
    // WRONG_DIRECTION bağlayıcıdır — aynı yöntem: 2026-08-12'de kullanıcı,
    // sayısal YAW ölçümü eşiğin (0.30) altında kaldığı hâlde kafanın "olması
    // gereken yere bakmadığını" bildirdi. Sayısal ölçüm kafa DÖNÜKLÜĞÜNÜ,
    // bu soru ise gözün/bakışın kendisini değerlendiriyor — farklı sinyaller.
    if (gazeLine && /WRONG_DIRECTION/i.test(gazeLine)) {
      return { ok: false, reason: "gaze", detail: verdictDetail() || "WRONG_DIRECTION", inconclusive: false };
    }
    // GAZE_POINT KAPISI KALDIRILDI (2026-09-16) — ÖLÇÜMLE.
    //
    // Bu satır bir zamanlar eliyordu: "kaba token aynı kalsa bile bakış
    // noktası ayrı" (b1d6972b c1/c2/c3). Sonra 2026-09-08'de profil kafada
    // güvenilmez olduğu anlaşıldı ve çağıran tarafta yaw>PROFILE_UNRELIABLE_MIN
    // ise reddi geçersiz sayan bir yama eklendi. Yama yetmedi.
    //
    // SON 12 İŞİN ÖLÇÜMÜ (47 gaze reddi):
    //   1. deneme: 31 gaze reddi   |  2. deneme: 21 artefakt reddi
    //   47 gaze reddinin 17'si (%36) BİR SONRAKİ denemede ARTEFAKTA dönüştü.
    //   Gaze'in gaze olarak tekrarı yalnızca 7.
    // Yani bu kapı kusuru düzeltmiyor, kusur SINIFI değiştiriyor: model
    // "gözleri düzelt" uyarısını alıp yüzü yeniden boyuyor ve alnında gri
    // blok bırakıyor. İş 515543e5 chunk 8 bunu çıplak gösteriyor —
    // gaze→artefakt→gaze→artefakt→gaze, 5 denemede hiç yakınsamadan.
    //
    // NEDEN BU KAPI, kaba token kapısı değil: bu soru irisin göz boşluğu
    // İÇİNDEKİ tam konumunu karşılaştırıyor — yorumsal ve tekrarlanabilir
    // değil. İki kare arka arkaya SAME/DIFFERENT alabiliyor. Kaba
    // isGazeMismatch (BASE_GAZE vs OUTPUT_GAZE, yukarıda) gerçek kusuru —
    // taban yana bakarken çıktının merceğe dönmesi — zaten yakalıyor ve
    // ölçümde o kusurun tamamı (10/29) kaba tokenla görünür durumda.
    //
    // limb-ghost'ta (2026-09-15) aynı gerekçeyle aynı karar verildi ve
    // doğru çıktı: yorumsal bir kapının yanlış elemesi, yakaladığı gerçek
    // kusurdan pahalıya mal oluyor.
    //
    // GAZE_POINT satırı prompt'ta DURUYOR ve loglanıyor (bkz. gazePointLine) —
    // ölçüm olarak izlemeye devam ediyoruz, yalnızca ELEME yetkisi alındı.
    if (gazePointLine && /DIFFERENT/i.test(gazePointLine)) {
      console.log(
        "VISION ÖLÇÜM (bakış noktası): DIFFERENT — kapı kaldırıldığı için " +
        "eleme yapılmadı (2026-09-16, bkz. yukarıdaki gerekçe)"
      );
    }
    // BLURRY_OR_MALFORMED bağlayıcıdır — aynı yöntem: 2026-08-13'te kullanıcı,
    // tüm-kare netlik kapısı ve RENK-odaklı ten kapısı geçtiği hâlde elin
    // silik/bulanık çıktığı bir kare bildirdi. İkisi de yerel el detayını
    // ölçmüyor — bu soru o boşluğu kapatıyor.
    if (handLine && /BLURRY_OR_MALFORMED/i.test(handLine)) {
      return { ok: false, reason: "hands", detail: verdictDetail() || "BLURRY_OR_MALFORMED", inconclusive: false };
    }
    // PATCH bağlayıcıdır (2026-09-13) — kullanıcı TESLİM EDİLMİŞ üç karede
    // "yüzde boyalar/lekeler" bildirdi ve hiçbir mevcut kapı bunu görmüyordu.
    // Sayısal ölçüm de eklendi (faceArtifact.js) ama iki sınıfı ayıramadı,
    // bu yüzden ELEME BU SATIRDAN geliyor; sayısal taraf yalnızca logluyor.
    //
    // AYRI SEBEP ("artifact"), "quality" DEĞİL: sayısal hakem yalnızca
    // "identity" sebebini geçersiz kılabiliyor (bkz. visionRejectionOverridden)
    // ve bu kusur kimlik mesafesiyle ölçülemez — yüz doğru kişinin yüzü
    // olabilir, üstünde yama olabilir.
    if (artifactLine && /PATCH/i.test(artifactLine)) {
      return { ok: false, reason: "artifact", detail: verdictDetail() || "FACE_ARTIFACT PATCH", inconclusive: false };
    }
    // BLOWN_OUT bağlayıcıdır — kullanıcı vakası (elegance chunk=3): yüz aşırı
    // parlak çıkmıştı, hiçbir sayısal kapı bunu ölçmüyor (bkz. isExposureLine
    // tanımının yanındaki gerekçe).
    if (exposureLine && /BLOWN_OUT/i.test(exposureLine)) {
      return { ok: false, reason: "exposure", detail: verdictDetail() || "BLOWN_OUT", inconclusive: false };
    }
    // WRONG_FOR_SCENE bağlayıcıdır — aynı kullanıcı vakası: kafa, gövdenin/
    // sahnenin baktığı yere bakmıyordu. YAW kapısı (şablonla sayısal fark)
    // bunu geçirmişti (sapma -0.16, eşik 0.30).
    if (orientationLine && /WRONG_FOR_SCENE/i.test(orientationLine)) {
      return { ok: false, reason: "orientation", detail: verdictDetail() || "WRONG_FOR_SCENE", inconclusive: false };
    }
    // TRANSPARENT_OR_GHOSTED bağlayıcıdır — bkz. isIntegrityLine tanımının
    // yanındaki gerçek vaka (yarı saydam kol, teslim edilmişti).
    if (integrityLine && /TRANSPARENT_OR_GHOSTED/i.test(integrityLine)) {
      return { ok: false, reason: "ghosting", detail: verdictDetail() || "TRANSPARENT_OR_GHOSTED", inconclusive: false };
    }
    // PULLED_TO_CAMERA bağlayıcıdır ama ALIGNED lastik damgadır (f94c3cec:
    // 10/10 ALIGNED, kahve yürüyüşü yine geçti). Asıl eleme sayısal kapıda
    // (bkz. isPulledToCameraNumeric). Vision bir kez PULLED derse yine red.
    if (headBodyLine && /PULLED_TO_CAMERA/i.test(headBodyLine)) {
      return { ok: false, reason: "pulled-to-camera", detail: verdictDetail() || "PULLED_TO_CAMERA", inconclusive: false };
    }
    // FACE_OVERLIT bağlayıcıdır — yüz ışıklı, kollar mat/koyu (b1d6972b
    // teslim chunk 0/1/2). Ham L* eşiği bağlanmadı: şikâyetsiz karelerde
    // de yüz-kol L* farkı yüksekti.
    if (faceLightLine && /FACE_OVERLIT/i.test(faceLightLine)) {
      return { ok: false, reason: "face-light", detail: verdictDetail() || "FACE_OVERLIT", inconclusive: false };
    }

    const answer = verdictLine.toUpperCase();

    // HANDS_OR_ARMS_MISMATCH bağlayıcıdır ama EN SONA alındı (2026-09-06).
    // Sebep: "skin" reddi artık sayısal ölçümle geçersiz kılınabiliyor (bkz.
    // runOpenAiDirectChunk'taki VISION TEN REDDİ bloğu). Eskisi gibi ilk
    // sıradayken erken dönseydi, ten reddi affedilen bir kare bakış/el/
    // parlaklık/hayalet satırlarına HİÇ bakılmadan kabul edilirdi. Şimdi
    // diğer tüm sınıflandırmalar önce çalışıyor; buraya gelen kare yalnızca
    // ten sorunu bildirilmiş karedir.
    //
    // Serbest metin başka bir kusur bildiriyorsa ONU döndürürüz: Vision bazen
    // yüzü bozuk bir kareyi ten satırında da işaretliyor (gerçek vaka: job
    // 1181577f, elegance c3 deneme=1 — kullanıcı "yüz bozulmuş, doğru ret"
    // dedi). O reddin sayısal ten ölçümüyle affedilmemesi gerekir.
    if (skinLine && /HANDS_OR_ARMS_MISMATCH/i.test(skinLine)) {
      if (answer.startsWith("BAD_QUALITY")) return { ok: false, reason: "quality", detail: verdictDetail(), inconclusive: false };
      if (answer.startsWith("BAD_FEATURES") || answer.startsWith("BAD_IDENTITY")) {
        return { ok: false, reason: "identity", detail: verdictDetail(), inconclusive: false };
      }
      if (answer.startsWith("BAD_HAIR")) return { ok: false, reason: "hair", detail: verdictDetail(), inconclusive: false };
      return { ok: false, reason: "skin", detail: verdictDetail() || "HANDS_OR_ARMS_MISMATCH", inconclusive: false };
    }
    // Gerekçe: verdict satırındaki iki nokta üst üstesinden sonrası (yoksa boş).
    const detail = verdictDetail();
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
    // BAD_ATTACHMENT: NECK_ATTACHMENT satırı yakalayamazsa (beklenmedik format)
    // diye verdict satırından ayrıca güvence — aynı "identity" dışı, hakem
    // tarafından geçersiz kılınamaz sebep ailesi.
    if (answer.startsWith("BAD_ATTACHMENT")) return { ok: false, reason: "attachment", detail, inconclusive: false };
    // BAD_GAZE VERDICT'İ ARTIK ELEMİYOR (2026-09-18) — ARKA KAPI KAPATILDI.
    //
    // Bu satır "GAZE_DIRECTION satırı yakalayamazsa diye güvence" olarak
    // eklenmişti. Ama buraya GELEBİLMEK için karenin gaze SATIRLARININ
    // hepsinden temiz geçmiş olması gerekiyor: GAZE_DIRECTION
    // WRONG_DIRECTION ve isGazeMismatch (BASE_GAZE/OUTPUT_GAZE) kontrolleri
    // yukarıda ve ikisi de erken return ediyor. Yani bu satıra ulaşan bir
    // BAD_GAZE, satırların hiçbirinin desteklemediği bir verdict demektir.
    //
    // Pratikte bu verdict'in TEK kaynağı GAZE_POINT'ti: kaldırılmasına
    // 2026-09-16'da karar verilen o kapı, prompt'taki bağlayıcı kural
    // sayesinde verdict'e yazılıyor ve buradan eleniyordu. 212 retin 106'sı
    // (%50) bu yoldan geliyordu; 97'sinin gerekçesi harfiyen GAZE_POINT'in
    // cümlesiydi. Kapı kaldırıldıysa verdict'i de bağlamamalı.
    //
    // ÖLÇÜM DURUYOR: satır hâlâ isteniyor ve loglanıyor (bkz. gazePointLine),
    // yalnızca ELEME yetkisi alındı — GAZE_POINT satır kapısıyla aynı usul.
    if (answer.startsWith("BAD_GAZE")) {
      console.log(
        `VISION ÖLÇÜM (bakış verdict'i): BAD_GAZE — gaze satırları temiz ` +
        `geçtiği için eleme yapılmadı (2026-09-18, bkz. yukarıdaki gerekçe)` +
        `${detail ? ` — "${detail}"` : ""}`
      );
      // AÇIKÇA KABUL DÖNÜLÜYOR: aşağıda "BAD ile başlayan her şey -> quality"
      // diye bir yakalayıcı var (referanssız mod için). Sadece loglayıp
      // düşseydik BAD_GAZE oraya takılır ve red sınıfı değişerek aynı kare
      // yine elenirdi. Buraya gelen kare tüm satır kapılarından geçmiştir.
      return { ok: true, reason: null, detail, inconclusive: false };
    }
    // BAD_HANDS: HAND_QUALITY satırı yakalayamazsa diye verdict satırından
    // ayrıca güvence — aynı desen.
    if (answer.startsWith("BAD_HANDS")) return { ok: false, reason: "hands", detail, inconclusive: false };
    // BAD_EXPOSURE / BAD_ORIENTATION: sınıflandırma satırı yakalayamazsa
    // (beklenmedik format) diye verdict satırından ayrıca güvence — diğer
    // "identity" dışı sebeplerle aynı desen (hakem tarafından geçersiz
    // kılınamaz, bkz. visionRejectionOverridden).
    // BAD_ARTIFACT: FACE_ARTIFACT satırı yakalayamazsa (beklenmedik format)
    // diye verdict satırından ayrıca güvence — diğer "identity" dışı
    // sebeplerle aynı desen.
    if (answer.startsWith("BAD_ARTIFACT")) return { ok: false, reason: "artifact", detail, inconclusive: false };
    if (answer.startsWith("BAD_EXPOSURE")) return { ok: false, reason: "exposure", detail, inconclusive: false };
    if (answer.startsWith("BAD_ORIENTATION")) return { ok: false, reason: "orientation", detail, inconclusive: false };
    // BAD_GHOSTING: BODY_INTEGRITY satırı yakalayamazsa diye verdict satırından
    // ayrıca güvence — diğer "identity" dışı sebeplerle aynı desen.
    if (answer.startsWith("BAD_GHOSTING")) return { ok: false, reason: "ghosting", detail, inconclusive: false };
    if (answer.startsWith("BAD_PULLED")) return { ok: false, reason: "pulled-to-camera", detail, inconclusive: false };
    if (answer.startsWith("BAD_FACE_LIGHT")) return { ok: false, reason: "face-light", detail, inconclusive: false };
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

// Reddedilen kareler Storage'a yazılır. Başlangıçta yalnızca A/B teşhisi
// içindi ("Vision haklı mı?" sorusu gözle doğrulanabilsin diye); 2026-08-15
// ile 2026-11-04 arasında kullanıcıya da gösterildi ("Elenen Kareler").
// 2026-11-04: kullanıcı erişimi kapatıldı (storage.rules + istemci); kareler
// artık yalnız ops onay ızgarasında (opsGetJobDetail, imzalı URL) görünür —
// onay akışında reddedilen son kare bitirilip panelde seçilebildiği için
// (FINISH_REJECTED_FRAMES) hâlâ ürünün parçası, false yapılamaz.
// SAKLAMA: kova yaşam döngüsü (bucket lifecycle, 2026-11-04):
//   7 gün  dating_training/, dating_debug/selfies/ (biyometrik: selfie)
//   30 gün dating_debug/{layers,headscale,surround,resample,eyewear}/, dating_rejected/
//   90 gün dating_staging/ (onay bekleme iptali 30 günde — bkz.
//          cleanupOverduePendingApproval — dosyalar karardan önce silinmez)
// Kural kovada tanımlı (repo'da dosya yok); okumak için admin SDK
// bucket.getMetadata().lifecycle. Hesap silmede payments.deleteAccount
// bunların hepsini TTL beklemeden siler.
const SAVE_REJECTED_FRAMES = true;
const DEBUG_ROOT = "dating_rejected";

// GEÇİCİ KAFA ÖLÇEĞİ TEŞHİSİ (2026-10-13): kullanıcı küçültme UYGULANDI
// olan karelerde küçültme ÖNCESİ hâli de görmek istedi — gerçek üretimde
// kanıtlamak için. İşe yaradıktan sonra false yapılıp bırakılabilir
// (dosyalar dating_debug/headscale/ altında, otomatik silinmiyor).
// 2026-10-26 yeniden açık (9987f742 c6 "saçın üstünde şekil kayması": gri
// tutam ham üretimden mi, küçültme dolgusundan mı bilinmiyordu).
const DEBUG_HEAD_SCALE_BEFORE = true;
// GEÇİCİ IŞIK TEŞHİSİ (2026-10-16): son katmanlara GİRMEDEN önceki kare
// (dating_debug/layers/). c29a2b31'de yalnız katman sonrası vardı; yeni yüz
// ışığını aynı girdiyle eskisiyle kıyaslamak mümkün olmadı.
// 2026-10-26 yeniden açık (bkz. DEBUG_HEAD_SCALE_BEFORE).
const DEBUG_SAVE_PRE_LAYERS = true;
// KAFA ÇEVRESİ İLK DOLGU SONRASI (2026-10-26, aynı teşhis): ikinci geçişten
// önceki kare (dating_debug/surround/).
const DEBUG_SAVE_SURROUND_FILL = true;
// TEŞHİS KAYITLARI YALNIZ PANEL HESABININ İŞLERİNDE (2026-10-26):
// dating_debug otomatik silinmiyor; gerçek kullanıcıların kareleri orada
// birikmesin. Test işleri panel hesabıyla yapılıyor (opsPanel OPS_EMAIL).
const DEBUG_SAVE_EMAIL = "destek@voxenai.com.tr";
const _debugSaveUid = new Map();
function debugSaveAllowed(uid) {
  if (!_debugSaveUid.has(uid)) {
    _debugSaveUid.set(uid, admin.auth().getUser(uid)
      .then((u) => (u.email || "").toLowerCase().trim() === DEBUG_SAVE_EMAIL)
      .catch(() => false));
  }
  return _debugSaveUid.get(uid);
}
// YÖN İKİNCİ ÜRETİMİ yapılan karede iki üretim de (dating_debug/resample/),
// eşiği gerçek örneklerle ayarlamak için (2026-10-19, kullanıcı isteği).
const DEBUG_SAVE_RESAMPLE = false;
// IŞIKLI SON KATMAN (2026-10-21, bkz. faceGlow.js) — kapatmak için false.
// SADE AKIŞTA DA AÇIK (2026-10-31, kullanıcı: "ışık olayını son çıktı üzerine
// aynı mantıkta ekleyelim"): kişi 0.6 / sahne 0.3, yalnız koyu sahnede, en son
// (gözlükten sonra). 21e56b20'de yerelde 10 karenin 7'sine uygulandı; tüm
// kareye ton eğrisi olduğu için faceTone'un yüz-vücut uyumu bozulmuyor.
// 2026-11-22 OTOMATİK KAPALI (kullanıcı: "ışıklı kısmı da bizim çıktılara manuel ekleyebileceğimiz bir
// filtre haline getir"): yan yana karşılaştırmada fark görülmedi (18 karede ort. +0.6..+3.2 L, yüz
// tavanları yüzünden FaceApp etkisinin ~üçte biri). Artık onay ekranında ☀ ile elle, tüm sahneye 0.6
// (faceGlow.applyManualGlow, opsPanel.opsToggleGlow). Geri dönüş: true.
const GLOW_ON = false;
// SELFIE'DEN YÜZ DETAYI (2026-10-22, bkz. faceDetailTransfer.js) — kapatmak
// için false. Süre bütçesinde bu kadar kalmadıysa atlanır (yerel, ~5 sn).
// KAPATILDI (2026-10-25, b7cd18da 10/10 karede uygulandı): telefon
// selfie'sinin ince katmanı detay değil gürültü taşıyor — yanak/alında benek
// ve açık leke (23579e24 karelerinde önce/sonra). 47 px yüze 53 ters üçgenle
// bile uygulandı (c1). Kimlik ölçüsü bunu görmüyor (0.364 → 0.356).
const SELFIE_DETAIL_ON = false;
const SELFIE_DETAIL_MIN_LEFT_MS = 60000;
// KULAKLIK SİLME (2026-10-25, bkz. earbuds.js — OWLv2 tespit + LaMa dolgu,
// yerel, ücretsiz, kare başına ~5 sn) — kapatmak için false. SADE AKIŞTA
// kapalı: kulaklık yalnız prompt'la kaldırılır.
const EARBUD_REMOVE_ON = !SIMPLE_PIPELINE;
const EARBUD_MIN_LEFT_MS = 45000;
// YÜZ NETLİĞİ (2026-10-26, bkz. faceRestore.js — GFPGAN, özellik maskesi,
// kare başına kimlik kapısı; yerel, ücretsiz, kare başına ~3-5 sn) —
// kapatmak için false. Ardından gelen kafa ölçeği/çevre/gözlük adımlarına
// süre kalsın diye eşik yüksek. SADE AKIŞTA kapalı.
const FACE_RESTORE_ON = !SIMPLE_PIPELINE;
const FACE_RESTORE_MIN_LEFT_MS = 120000;
// GÖZ AÇIKLIĞI (2026-10-27, bkz. eyeOpen.js — ağır kapaklı gözde üst kapak
// en çok açıklığın %25'i kadar kalkar; yerel, ücretsiz, kare başına ~1 sn,
// kimlik kapılı) — kapatmak için false. SADE AKIŞTA kapalı.
const EYE_OPEN_ON = !SIMPLE_PIPELINE;
const EYE_OPEN_MIN_LEFT_MS = 120000;

// gate string -> kullanıcıya gösterilecek Türkçe gerekçe. saveRejectedFrame
// çağrılarındaki TÜM gate değerlerini kapsar (hem runOpenAiDirectChunk'taki
// "math-...", "yaw-drift", "skin-tone", "eyes-closed", "head-dx" hem fal
// webhook yolundaki "vision-..." — bkz. assessOutputWithVision reason'ları).
const REJECTION_REASON_LABELS = {
  "math-identity": "Yüz, referans fotoğraflarınla yeterince eşleşmedi",
  "math-head-ratio": "Kafa boyutu kareye göre orantısız",
  "math-head-grew": "Kafa, taban fotoğraftakinden belirgin büyük çıktı",
  "math-blurry": "Yüz bulanık çıktı",
  "yaw-drift": "Baş açısı şablondan çok saptı",
  "yaw-to-camera": "Taban fotoğraf profilken baş kameraya çevrilmiş",
  "yaw-over-rotate": "Baş, tabandakinden belirgin daha fazla yana dönmüş",
  "yaw-pulled-to-camera": "Yüz, gövdenin/yürüyüşün baktığı yerden kameraya çevrilmiş",
  "math-no-face+vision-inconclusive": "Yüz net tespit edilemedi",
  "vision-pulled-to-camera": "Yüz, gövdenin/yürüyüşün baktığı yerden kameraya çevrilmiş",
  "skin-tone": "Ten tonu tutarsızlığı tespit edildi",
  "eyes-closed": "Gözler kapalı/yarı kapalı çıktı",
  "head-dx": "Baş konumu şablona göre kaydı",
  "vision-proportion": "Kafa boyutu taban/omuz oranına uymuyor",
  "vision-attachment": "Boyun/baş bağlantısı doğal görünmüyor",
  "vision-skin": "El/kol teni yüz teniyle uyuşmuyor",
  "vision-gaze": "Bakış yönü taban fotoğrafla uyuşmuyor",
  "iris-gaze": "Bakış yönü taban fotoğrafla uyuşmuyor",
  "vision-hands": "Eller bulanık/bozuk çıktı",
  "vision-identity": "Yüz hatları referansla yeterince eşleşmedi",
  "vision-hair": "Saç uyumsuzluğu tespit edildi",
  "vision-quality": "Genel görsel kalite yetersiz",
  "vision-no-evidence": "Görsel netlik/kimlik kanıtı yetersiz",
  "vision-exposure": "Yüz aşırı parlak çıktı, detay kayboldu",
  "vision-artifact": "Yüzde yama/leke tespit edildi",
  "face-artifact": "Yüzde yama/leke tespit edildi",
  "head-ghost": "Kafanın çevresinde şablondaki kişiden iz kaldı",
  "vision-orientation": "Kafa yönü sahneye/gövdeye uymuyor",
  "vision-ghosting": "Gövde/kol yarı saydam çıktı (arka plan içinden görünüyor)",
  "limb-ghost": "El/kol yarı saydam, bozuk ya da sıvanmış çıktı",
  "yaw-under-rotate": "Baş, tabandaki profil dönüşünü bitirmemiş",
  "gaze-opposite": "Gözler tabandakinin tersi yöne bakıyor",
  "hat-lost": "Şablondaki şapka/bere çıktıda yok, kafa şapka hacmine uzamış",
  "vision-face-light": "Yüz ışığı kol/el ışığıyla uyuşmuyor",
  // NOT: no-face-* etiketleri KALDIRILDI (2026-08-22) — artık eleme sebebi
  // değiller (bkz. KONUM KAPISI'ndaki geri alma gerekçesi). O kuralın kısa
  // süre yürürlükte olduğu dönemde kaydedilen kareler etkilenmez: gerekçe
  // metni Firestore'a KAYIT ANINDA çözülüp yazılıyor, bu haritadan sonradan
  // okunmuyor.
};
const DEFAULT_REJECTION_REASON_LABEL = "Kalite kontrolünden geçemedi";
function humanRejectionReason(gate) {
  return REJECTION_REASON_LABELS[gate] || DEFAULT_REJECTION_REASON_LABEL;
}

/**
 * Reddedilen bir kareyi teşhis + kullanıcıya gösterim için saklar. Dosya adı
 * kararın TÜM bağlamını taşır (mod, chunk, deneme, hangi kapı, mesafe) —
 * böylece görsele bakarken neden elendiği ayrıca aranmaz. Storage yazımı
 * tamamen fail-safe: hata üretimi etkilemez, yalnızca loglanır. Firestore
 * yazımı (kullanıcının göreceği kayıt) AYRI bir fail-safe katman — o
 * başarısız olsa bile kare zaten Storage'da durur, sadece panelde görünmez.
 */
// KULLANILAN ŞABLON KAYDI (2026-10-07). Bir chunk denemeler arasında yedek
// şablona geçebildiği için "bu kare hangi şablondan üretildi" bilgisi deneme
// anında tutulur: anahtar `${jobId}/${styleId}/${chunkIdx}`, değer Storage'daki
// şablon dosya adı. saveRejectedFrame buradan okur (her çağrı yerine ayrı
// parametre eklemek yerine), teslim adımı chunkTemplates'e yazar.
// Eskiden yalnızca İLK seçilen şablonlar templateNames'e yazılıyordu; yedeğe
// geçilen kare (ör. 9496348c chunk 1) kendi şablonuyla incelenemiyordu.
const CHUNK_TEMPLATE = new Map();

// AĞIR SON KATMAN KİLİDİ (2026-10-08 gerçek olay, iş 6f9e524e). Kafa ölçeği
// (headScale.js) ve ten alanı (skinTone.js) kareyi tam çözünürlükte birkaç
// kez açıyor ve segmentasyon modelleri çalıştırıyor. 10 chunk paralel
// koştuğu için 3 chunk aynı anda bu adıma gelince süreç 2GiB'ı aştı ve
// öldü ("Memory limit of 2048 MiB exceeded") — o 3 kare kayboldu, iş zaman
// aşımına düştü. Bu katmanlar kare başına ~1-2 sn sürdüğü için sıraya almak
// toplam süreyi neredeyse etkilemez, tepe belleği ise tek kareye indirir.
let _postLayerTail = Promise.resolve();
function withPostLayerLock(fn) {
  const run = _postLayerTail.then(fn, fn);
  _postLayerTail = run.catch(() => {});
  return run;
}
// WORKER HAVUZU (2026-10-11, bkz. postPool.js): ağır son katman görevi
// (postTasks.js) havuz açıksa ayrı iş parçacığında paralel, değilse aynı kod
// bu kilitle ana iş parçacığında sırayla çalışır.
// SÜRE SINIRI (2026-11-18, 156fa173 c0): havuz görevinin zaman aşımı yoktu;
// istek 900 sn'de kapanınca Cloud Run CPU'yu kısıyor (cpuIdle), asılı görev
// fiilen donuyor ve iş %97'de kalıyordu. Her görev işin kalan süresiyle
// sınırlı (kuyruk dahil); bitirme görevleri teslim/onay adımlarına
// FINISH_RESERVE_MS bırakır. Süre dolarsa görev hata döner, çağıran katmanı
// atlar (bitirme atlanırsa kare ham hâliyle gider, bkz. CHUNK_FINISH_REGRESSED).
const FINISH_RESERVE_MS = 60 * 1000;
const FINISH_TASKS = new Set(["simpleFinish", "layers", "handRepairPrep", "handRepairFinish"]);
function runPostTask(name, payload) {
  const pool = require("./postPool");
  if (pool.enabled()) {
    const left = jobTimeLeftMs();
    const timeoutMs = Number.isFinite(left) ? left - (FINISH_TASKS.has(name) ? FINISH_RESERVE_MS : 0) : null;
    return pool.run(name, payload, { timeoutMs });
  }
  return withPostLayerLock(() => require("./postTasks")[name](payload));
}
const chunkTemplateKey = (jobId, styleId, chunkIdx) => `${jobId}/${styleId}/${chunkIdx}`;
// Chunk'ın o anki şablonu kırpıldıysa geri yerleştirme bilgisi
// ({ originalBuf, geo, cropBuf }). Reddedilen kareler de admin panelinden
// onaylanabildiği için (bkz. opsPanel REJECTED_PREFIX) kaydedilmeden önce
// orijinal şablona geri yerleştirilir (2026-10-08, 9d9507f0: kırpık kare
// panelde "kırpılan foto eski yerine geri konmamış" olarak göründü).
const CHUNK_RESTORE = new Map();
// REDDEDİLEN KARE DE BİTİRİLİR (2026-10-20, 7c17ea3f, kullanıcı: "gözlüğü
// ekleyememiş", "siyah beyaz renge uyduramamış"): admin panelinde reddedilen
// kareler de teslim edilebiliyor, ama kapıda takıldıkları anki HAM hâlleriyle
// kaydediliyordu — siyah-beyaz eşleme, yüz ışığı, kafa ölçeği/çevresi ve
// gözlük yalnız geçen kareye uygulanıyordu (c0 siyah-beyaz sahnede renkli yüz,
// c5 gözlüksüz). Chunk'ın son reddedilen karesi burada tutulur; chunk hiç
// geçen kare vermezse o kare teslim karesiyle AYNI son işlemlerden geçip
// kendi reddedilen yolunun üstüne yazılır. Chunk yine başarısız sayılır
// (kullanıcıya kendiliğinden gitmez), yalnız panelde bitmiş hâli görünür.
const CHUNK_LAST_REJECTED = new Map();
const FINISH_REJECTED_FRAMES = true;
// Modele saçı silinmiş taban giden chunk'lar (bkz. TEMPLATE_HAIR_ERASE):
// model şablonun buklesini görmediği için BUKLE KALINTISI atlanır.
const CHUNK_HAIR_ERASED = new Set();
// Bitirme adımları yüzü bozduğu için HAM kareyle teslim edilen chunk'lar
// (bkz. "BİTİRME KİMLİK" ölçümü). İş dokümanına chunkFinishRegressed olarak
// yazılır; panelde "bu kare bitirilmeden gitti" bilgisi için.
const CHUNK_FINISH_REGRESSED = new Set();
// Bitirme sonrası kimlik mesafesinin hamdan en fazla ne kadar artabileceği.
// face-api mesafesinde 0.05, aynı karede ışık/keskinlik farkından gelen
// doğal oynamanın (gözlemlenen 0.01-0.03) üstünde; birlikte eşik (0.50)
// şartı da arandığı için iyi karelerdeki küçük artış geri alma üretmez.
const FINISH_REGRESS_DELTA = 0.05;

async function saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, meta) {
  if (!SAVE_REJECTED_FRAMES) return;
  let path;
  try {
    const parts = [
      `${styleId}_c${chunkIdx}_att${attempt}`,
      `mode-${meta.mode || "?"}`,
      `gate-${meta.gate || "?"}`,
      meta.distance != null ? `dist-${meta.distance.toFixed(3)}` : null,
    ].filter(Boolean);
    path = `${DEBUG_ROOT}/${uid}/${jobId}/${parts.join("__")}.jpg`;
    let saveBuf = buf;
    const rs = CHUNK_RESTORE.get(chunkTemplateKey(jobId, styleId, chunkIdx));
    if (rs) {
      try {
        const { recompositeIntoOriginal } = require("./postProcess");
        const { alignToTemplate } = require("./align");
        const a = rs.cropBuf ? await alignToTemplate(buf, rs.cropBuf) : null;
        const rec = await recompositeIntoOriginal(a && a.applied ? a.buf : buf, rs.originalBuf, rs.geo, { logTag: ` (reddedilen, style=${styleId}, chunk=${chunkIdx})` });
        if (rec) saveBuf = await require("sharp")(rec).jpeg({ quality: 92 }).toBuffer();
      } catch (e) {
        console.error("Reddedilen kare geri yerleştirilemedi (kırpık hâli kaydediliyor):", e.message || e);
      }
    }
    await bucket().file(path).save(saveBuf, { metadata: { contentType: "image/jpeg" } });
    console.log(`REDDEDİLEN KARE KAYDEDİLDİ: ${path}${meta.detail ? ` | Vision gerekçesi: ${meta.detail}` : ""}`);
    if (Buffer.isBuffer(buf)) CHUNK_LAST_REJECTED.set(chunkTemplateKey(jobId, styleId, chunkIdx), { buf, path, gate: meta.gate || "?" });
  } catch (e) {
    console.error("Reddedilen kare kaydedilemedi (teşhis kaybı, üretim etkilenmedi):", e.message || e);
    return;
  }
  try {
    // FieldValue.serverTimestamp() arrayUnion İÇİNDE kullanılamaz (Firestore
    // hata verir) — bu yüzden Timestamp.now() (Cloud Functions'ta sunucu
    // saatiyle aynı, güvenilir).
    await db.doc(`users/${uid}/private/genData/genJobs/${jobId}`).set({
      rejectedFrames: admin.firestore.FieldValue.arrayUnion({
        path, gsUrl: `gs://${bucket().name}/${path}`,
        styleId, chunkIdx, attempt, gate: meta.gate || "?",
        template: CHUNK_TEMPLATE.get(chunkTemplateKey(jobId, styleId, chunkIdx)) || null,
        reason: humanRejectionReason(meta.gate),
        detail: meta.detail || null,
        rejectedAt: admin.firestore.Timestamp.now(),
      }),
    }, { merge: true });
  } catch (e) {
    console.error("Reddedilen kare Firestore kaydı başarısız (panelde görünmeyecek):", e.message || e);
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
// Chunk başına en fazla deneme (2026-08-16, 2'den 6'ya çıkarıldı — kullanıcı
// onayıyla, "10 foto garantisi" isteği). ÖNEMLİ AYRIM (bkz. 2026-07-22 kredi
// yakma olayı, [[fal-credit-burn-incident]]): bu YALNIZCA KALİTE KAPISI
// reddi retry'idir (chunk'ın çıktısı kimlik/yaw/ten/dx/göz kapılarından
// geçemedi) — ALTYAPI/SAĞLAYICI hatası retry'i (fetch failed, 429 vb.) HÂLÂ
// YASAK ve bu sayaçtan TAMAMEN AYRI (bkz. generateForMode null dönerse
// "ÜRETİM BAŞARISIZ" log satırı — o da bu sayacı kullanıyor ama asıl 429
// koruması OPENAI_IMAGE_MAX_CONCURRENCY kuyruğunda, burada değil).
// Her deneme GERÇEK OpenAI ücreti — 6, chunk başına en kötü ihtimalle ~6x
// maliyet demek. Bu sayıyı ARTIRMADAN önce mutlaka kullanıcıya danış (aynı
// kural yaw/dx eşiklerinde de geçerli, dosyanın diğer yerlerine bkz.).
// Şablon havuzu bu sayıyla SENKRON tutulmalı (bkz. IMAGES_PER_STYLE * 6
// dispatch'teki pickTemplatesFromPool çağrısı + candidates dizisi) — aksi
// halde 3. denemeden sonra "farklı şablon" diye aynı şablon tekrar denenir.
const OPENAI_DIRECT_MAX_ATTEMPTS = 6;
// ONAY AKIŞINDA TEK DENEME (2026-10-11, kullanıcı kararı: "5'li pakette
// ürettiğimiz 10 foto reddedilenlerle birlikte toplam 10 olsun", 10 karenin
// maliyeti 1.5 $'ı geçmesin). Kapıdan geçemeyen kare yeniden üretilmez; ham
// hâliyle reddedilen kareler arasına kaydedilir, admin onay ekranında görür
// ve isterse onaylar. Eski istemci (holdForApproval yok) 6 denemede kalır —
// orada vaat edilen sayı kadar üretiliyor, yedek kare yok.
const HOLD_MAX_ATTEMPTS = 1;

// AYNI KAPI TEKRAR SINIRI (2026-09-13) — bkz. runOpenAiDirectChunk içindeki
// gateRejectCounts başlığı. Bir "yorum" kapısı aynı chunk'ta bu kadar kez
// elerse o chunk için devre dışı kalır.
//
// DEĞER NEDEN 2: gerçek veride (job f483d510 chunk 3) kapı 1., 2. ve 3.
// denemede aynı şekilde eledi. İkinci tekrar, kusurun çıktıda değil kapının
// yargısında olduğuna dair yeterli kanıt: iki farklı şablonla, iki farklı
// üretimle, düzeltici uyarıyla aynı sonuç alınmışsa üçüncüsü de aynı gelir.
// 3 yapsaydık f483d510'daki israfın yalnızca son denemesini önlerdik.
const GATE_REPEAT_DISABLE_AFTER = 2;

// ===========================================================================
// ARTEFAKT ONARIM BÜTÇESİ VE KİMLİK TOLERANSI (2026-09-18)
// ===========================================================================
//
// ÖLÇÜM (2026-09-16..18, 21 iş): 212 reddin 74'ü (%35) artefakt —
// face-artifact 47, vision-artifact 27. Aynı dönemde onarım YALNIZCA 30 kez
// denendi ve 24'ü BAŞARILI oldu (%80). Yani onarım çalışıyor, sorun onarımın
// ÇOĞU ARTEFAKTA HİÇ ULAŞAMAMASI:
//
//   1) Onarım chunk başına BİR KEZ deneniyordu (artifactRepairTried). Bir
//      chunk 6 denemenin 4'ünde yama üretebiliyor; ilk denemeden sonrakiler
//      onarıma hiç girmeden reddediliyordu.
//   2) TAM KARE Vision'ın artefakt reddi (vision-artifact, 27 ret) onarım
//      yoluna HİÇ UĞRAMIYORDU — o red, kırpma kapısından ÖNCE, doğrudan
//      reddediyordu.
//   3) 30 onarımın 6'sı yalnızca kimlik kontrolünden düştü (ölçülen: 0.512
//      gibi eşiğin hemen üstü değerler).
//
// BÜTÇE NEDEN 3: onarım tek görsel + kısa prompt; bir REDDİN bedeli ise tam
// bir yeniden üretim (daha uzun prompt, daha çok görsel) + bir deneme
// hakkının yanması. Yani onarım redden UCUZ — bütçeyi 1'den 3'e çıkarmak
// beklenen maliyeti DÜŞÜRÜYOR. Sınırsız değil: aynı chunk üç kez onarılıp
// hâlâ yamalıysa kusur karede daha derindir, dördüncüsü para yakar.
// (Bu, OPENAI_DIRECT_MAX_ATTEMPTS'ten AYRI bir sayaçtır ve deneme hakkı
// tüketmez — bkz. o sabitin başlığındaki kredi yakma uyarısı.)
// 2026-11-19 KAPALI (sade akış, kullanıcı: "fazlalıkları çıkar"): onarım yüzü OpenAI ile yeniden
// çizen ikinci bir üretim ($0.23, kimlik 0.58'e kadar izinli); patlamaları üreten selfie ışığı
// dikey hatası 11-18'de düzeldi. Yamalı kare artık onarılmaz, face-artifact etiketiyle onaya
// düşer. Geri dönüş: 3.
const ARTIFACT_REPAIR_MAX_PER_CHUNK = 0;

// KİMLİK: MUTLAK EŞİK DEĞİL, SÜRÜKLENME ÖLÇÜLÜR.
//
// Onarımın kimlik kontrolü FACE_MATCH_THRESHOLD'u (0.50) mutlak sınır
// sayıyordu. Ama doğru soru "bu kare eşiğin altında mı" değil, "ONARIM
// kimliği bozdu mu": kare onarımdan ÖNCE zaten kimlik kapısından geçmişti.
// Mesafesi 0.46 olan bir kare onarımdan sonra 0.512 ölçülünce çöpe gidiyor
// ve yerine YENİ bir üretim yapılıyordu — oysa onarım göz/kaş ve ağız
// bantlarına hiç dokunmuyor (bkz. faceRepair.js), yani bu fark ölçüm
// gürültüsü mertebesinde.
//
// Onarım yine de kimliği bozabilir, o yüzden iki kapı birden aranır:
// sürüklenme bu kadarı geçmeyecek VE hiçbir koşulda sert tavanı aşmayacak.
const REPAIR_IDENTITY_MAX_DRIFT = 0.08;
const REPAIR_IDENTITY_HARD_MAX = 0.58;

/**
 * Yüz yamasını onarmayı dener ve onarımı kimlik + artefakt kapısından
 * geçirir. İKİ ÇAĞIRAN VAR (tam kare Vision reddi ve kırpma kapısı reddi),
 * bu yüzden ortak fonksiyon.
 *
 * preDist: onarımdan ÖNCEKİ karenin kimlik mesafesi (null olabilir).
 *
 * Döner: { ok:true, buf, dist } — onarılmış kare kullanılabilir
 *        { ok:false, why }      — çağıran ESKİ kareyle normal redde düşer
 * ASLA throw etmez.
 */
// YÜZ ONARIMI BÜTÇEDEN (2026-11-19, 248a0e72: 4 onarım × ~$0.20 zorunlu
// sayılıp iş $2.36 tuttu). Onarım + yeniden yargı isteğe bağlı adım gibi yer
// ayırır; yer yoksa onarılmaz, kare onarımın başarısız olduğu hâldeki gibi elenir.
// EL ONARIMI ADIMI (2026-11-20, kullanıcı: "eller siyahi kişinin elleri kalmış … 1.50 sınırına
// yaklaşabilirsin"; bkz. handRepair.js). Sıra (inceleme): ucuz koşul (pigment) → süre → YEREL
// hazırlık (worker; ücretsiz eleme, maske) → bütçe ayırması (süre bittikçe beklemez) → süre
// yeniden → görsel kuyruğu + ücretli çağrı (kalan süreye bağlı zaman aşımı) → YEREL bitiş
// (worker; hizalama, yapıştırma, doğrulama). Reddedilen karelerde yapılmaz (teslim edilecek
// karelerle bütçe yarışmasın). Döner: onarılmış kare ya da null.
const HAND_REPAIR_MIN_LEFT_MS = 180 * 1000;
const HAND_REPAIR_BUDGET_WAIT_MS = 60 * 1000;
// Ücretli çağrıdan sonra bitiş görevi + kalan teslim adımları için bırakılan süre.
const HAND_REPAIR_AFTER_MS = 90 * 1000;
const HAND_REPAIR_MIN_CALL_MS = 60 * 1000;
async function handRepairStep({ buf, tpl, chunkIdx, styleId, rawBuf, mstUser, mstTpl, rejected = false }) {
  const tag = `style=${styleId}, chunk=${chunkIdx}`;
  const hr = require("./handRepair");
  const n = (v, d = 1) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
  const t0 = Date.now();
  try {
    if (!hr.HAND_REPAIR.ON) return null;
    if (!hr._testables.eligible(mstUser, mstTpl)) {
      console.log(`EL ONARIMI (${tag}): ATLANDI[pigment] MST ${mstUser ?? "?"}/${mstTpl ?? "?"}`);
      return null;
    }
    if (rejected) {
      console.log(`EL ONARIMI (${tag}): ATLANDI[reddedilen-kare] MST ${mstUser}/${mstTpl}`);
      return null;
    }
    if (jobTimeLeftMs() < HAND_REPAIR_MIN_LEFT_MS) {
      console.log(`EL ONARIMI (${tag}): ATLANDI[süre] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
      return null;
    }
    const prep = await runPostTask("handRepairPrep", { buf, rawBuf, tpl: Buffer.isBuffer(tpl) ? tpl : null });
    const pre = `MST ${mstUser}/${mstTpl} hamFark=${n(prep && prep.rawGap)} önceFark=${n(prep && prep.gapBefore)} alan=${n(prep && prep.areaVsFace, 2)}`;
    if (!prep || !prep.ok) {
      console.log(`EL ONARIMI (${tag}): ATLANDI[${(prep && prep.reason) || "hazırlık"}] ${pre} ${Date.now() - t0}ms`);
      return null;
    }
    const keepWaiting = () => jobTimeLeftMs() >= HAND_REPAIR_AFTER_MS + HAND_REPAIR_MIN_CALL_MS;
    const { slot, waitedMs } = await waitReserveOptional(hr.HAND_REPAIR.EST_USD, { maxWaitMs: HAND_REPAIR_BUDGET_WAIT_MS, keepWaiting });
    if (!slot) {
      const L = ledgerSummary();
      console.log(`EL ONARIMI (${tag}): ATLANDI[bütçe] ${pre} ${Math.round(waitedMs / 1000)}sn beklendi, harcanan $${L ? L.spentUsd.toFixed(3) : "?"} tavan $${L ? L.limitUsd.toFixed(2) : "?"}`);
      return null;
    }
    let edited;
    try {
      const callMs = Math.min(hr.HAND_REPAIR.TIMEOUT_MS, jobTimeLeftMs() - HAND_REPAIR_AFTER_MS);
      if (!(callMs >= HAND_REPAIR_MIN_CALL_MS)) {
        console.log(`EL ONARIMI (${tag}): ATLANDI[süre] ${pre} kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        return null;
      }
      const geo = prep.geo;
      const size = hiResSize(geo.cw, geo.chh, AUTO_AREA);
      await acquireOpenAiImageSlot();
      try {
        edited = await runOptional(() => hr.editHands({
          cropPng: Buffer.from(prep.cropPng), maskPng: Buffer.from(prep.maskPng), faceJpg: Buffer.from(prep.faceJpg), geo,
        }, { apiKey: OPENAI_KEY.value(), size, timeoutMs: callMs }));
      } finally {
        releaseOpenAiImageSlot();
      }
    } finally {
      slot.release();
    }
    if (!Buffer.isBuffer(edited)) {
      console.log(`EL ONARIMI (${tag}): ATLANDI[${(edited && edited.error) || "çıktı-yok"}] ${pre} ${Date.now() - t0}ms`);
      return null;
    }
    const fin = await runPostTask("handRepairFinish", {
      buf, edited, alpha8: prep.alpha8, geo: prep.geo, tpl: Buffer.isBuffer(tpl) ? tpl : null,
    });
    console.log(`EL ONARIMI (${tag}): ${fin && fin.applied ? "UYGULANDI" : `ATLANDI[${(fin && fin.reason) || "bitiş"}]`} ${pre} sonraFark=${n(fin && fin.gapAfter)} yapı=${n(fin && fin.struct, 2)} kayma=${fin && fin.shift ? fin.shift.join("/") : "-"} ${Date.now() - t0}ms`);
    return fin && fin.applied && fin.buf ? (Buffer.isBuffer(fin.buf) ? fin.buf : Buffer.from(fin.buf)) : null;
  } catch (e) {
    console.error(`EL ONARIMI (${tag}) hata verdi (kare olduğu gibi):`, e.message || e);
    return null;
  }
}

const EST_REPAIR_USD = 0.23;
const REPAIR_BUDGET_WAIT_MS = 90000; // diğer kareler zorunlu paylarını bıraktıkça yer açılır (kapılar 1.5-3 dk yayılır)
async function tryArtifactRepair(args) {
  const { slot, waitedMs } = await waitReserveOptional(EST_REPAIR_USD, { maxWaitMs: REPAIR_BUDGET_WAIT_MS });
  if (!slot) {
    const L = ledgerSummary();
    console.warn(`YÜZ ONARIMI ATLANDI[bütçe]: ${Math.round(waitedMs / 1000)}sn beklendi, harcanan $${L ? L.spentUsd.toFixed(3) : "?"} ayrılan $${L ? L.reservedUsd.toFixed(3) : "?"} tavan $${L ? L.limitUsd.toFixed(2) : "?"}`);
    return { ok: false, why: "bütçe" };
  }
  try {
    return await runOptional(() => tryArtifactRepairInner(args));
  } finally {
    slot.release();
  }
}
async function tryArtifactRepairInner({ buf, faceBox, apiKey, refDescriptor, preDist }) {
  try {
    const { repairFaceArtifact } = require("./faceRepair");
    const { judgeFaceArtifact } = require("./faceArtifactCrop");

    const rep = await repairFaceArtifact(buf, faceBox, apiKey);
    if (!rep.ok || !rep.buf) return { ok: false, why: `yapılamadı[${rep.reason}]` };

    let dist = null;
    let idOk = true;
    if (refDescriptor) {
      try {
        const { matchesIdentity } = require("./faceQuality");
        const m = await matchesIdentity(rep.buf, refDescriptor);
        dist = m.distance;
        if (dist != null) {
          idOk = m.match
            || (preDist != null
                && dist <= preDist + REPAIR_IDENTITY_MAX_DRIFT
                && dist <= REPAIR_IDENTITY_HARD_MAX);
        }
        // dist null ise ölçülemedi demektir — ölçememek kusur kanıtı
        // değildir, dosyanın her yerindeki fail-safe yönü (engelleme yok).
      } catch (e) {
        console.error("Onarım kimlik kontrolü hata verdi (onarım kabul ediliyor):", e.message || e);
      }
    }
    const d = dist != null ? dist.toFixed(3) : "ölçülmedi";
    if (!idOk) {
      return { ok: false, why: `kimlik bozuldu (mesafe=${d}, öncesi=${preDist != null ? preDist.toFixed(3) : "?"})` };
    }

    // Onarım kimliği korudu; yama gerçekten gitmiş mi? Kırpma kapısı tam
    // kare satırından daha duyarlı (bkz. judgeFaceArtifact gerekçesi), bu
    // yüzden doğrulama İKİ çağıran için de ondan yapılıyor.
    const re = await judgeFaceArtifact(rep.buf, faceBox, apiKey);
    if (re.ok && !re.bad) return { ok: true, buf: rep.buf, dist };
    return { ok: false, why: re.ok ? `yama sürüyor (bölge="${re.where}")` : `doğrulanamadı[${re.reason}]` };
  } catch (e) {
    console.error("Yüz onarımı çağrısı hata verdi (normal redde düşülüyor):", e.message || e);
    return { ok: false, why: "hata" };
  }
}

// KAFA KALINTI KAPISI (gpt-4.1, bkz. headGhost.js) 2026-11-06 KAPATILDI
// (kullanıcı: "kaldıralım"): 10-17..11-02 işlerinin kayıtlı loglarında 103
// kararın hepsi GEÇTİ; elle etiketlenmiş belirgin izli 15 karenin 15'ini
// geçirdi — her karede ücret, sıfır yakalama. İz artık son adımda yerel
// detektörle temizleniyor (ghostDetect.js + ghostClean). Kapı kapalıyken
// "head-ghost" reddi olmadığı için onun tekrar talimatı (retryCorrectionBody
// head-ghost) da tetiklenmez. Kafa küçültme sonrası yargıç (judgeScaledHead)
// ayrı: yalnız SIMPLE_PIPELINE=false akışında çalışır, ona dokunulmadı.
const HEAD_GHOST_GATE_ON = false;

// Bu kapılar tekrar sayacına GİRER (Vision'ın öznel yargısı — yanlış pozitif
// verebilir). Listede OLMAYAN her kapı (math-*, yaw-*, head-dx, eyes-closed,
// skin-tone) asla devre dışı bırakılmaz: onlar sayısal ölçüm yapar ve
// tekrarlamaları gerçek sapmanın kanıtıdır.
//
// eyes-closed BİLEREK DIŞARIDA: göreceli sayısal ölçüm (kişinin kendi
// referans açıklığıyla kıyas), yorum değil.
//
// limb-ghost ÇIKARILDI (2026-09-14): kapının kendisi kaldırıldı — dört
// doğrulanmış vakanın dördünde de yanlış eledi (bkz. runOpenAiDirectChunk
// içindeki "UZUV KIRPMA YARGISI KALDIRILDI" başlığı).
//
// face-artifact EKLENDİ (2026-09-14): yeni ve yorum tabanlı bir kapı.
// Yanlış pozitif verirse aynı chunk'ı tüketmesin — limb-ghost'un yaptığı
// hatanın tekrarlanmaması için baştan koruma altında.
const GATE_REPEAT_ELIGIBLE = new Set([
  "vision-hair",
  "face-artifact",
  // head-ghost EKLENDİ (2026-10-10): Vision yorumu; yanlış pozitif chunk'ı
  // tüketmesin.
  "head-ghost",
]);

// YAW (KAFANIN YANA DÖNÜKLÜĞÜ) SAPMA SINIRI (2026-08-11).
//
// SORUN: kullanıcı şikâyeti "kafa doğru yere bakmıyor". KONUM ÖLÇÜM verisi bunu
// doğruladı — ölçülen sapmaların en büyüğü konum/boyut değil, YAW.
// Gerçek eşleştirilmiş veri (10 kare, şablon yaw -> çıktı yaw):
//   0.19->0.43  0.12->0.37  0.80->0.67  1.00->0.80  0.03->0.17
//   0.70->0.48  0.06->0.44  1.00->1.00  0.29->0.69  0.06->0.07
//   sapma:  +0.24 +0.25 -0.13 -0.20 +0.14 -0.22 +0.38 0.00 +0.40 +0.01
//
// ÖRÜNTÜ: model kafayı ORTAYA çekiyor (regression to the mean) — şablon önden
// bakıyorsa (yaw<0.5) çıktı 6/6 vakada DAHA ÇOK yana dönmüş; şablon profildeyse
// 3/4 vakada kameraya DAHA ÇOK dönmüş.
//
// NEDEN KAPI, NEDEN DÜZELTME DEĞİL: yaw 3B bir dönüştür, 2B karede geometrik
// olarak düzeltilemez (kafayı döndüremezsin). Tek deterministik çare, sapan
// kareyi eleyip mevcut retry'a bırakmak — retry zaten FARKLI ŞABLON deniyor
// (bkz. prepareNextUsable), yani ikinci çekilişte düzgün çıkma şansı var.
//
// 0.30: gözlenen 10 sapmanın 2'sini (0.38 ve 0.40) eler, normal varyasyona
// (<=0.25) dokunmaz. Foto kaybı riski düşük tutuldu — eşik gerçek dağılım
// büyüdükçe kalibre edilecek (dosyadaki diğer kapılarla aynı usul).
//
// 0.25 DENENDİ VE VAZGEÇİLDİ (2026-09-06). 21 günlük gerçek dağılım (146
// ölçüm): p50=0.13, p90=0.33, p95=0.41, maks=0.59. Simetrik eşiği 0.30'dan
// 0.25'e çekmek elenen kare oranını %14.4'ten %19.9'a çıkarıyordu — ve gözle
// doğrulama bu bedelin karşılıksız olduğunu gösterdi: sapması +0.29 ve +0.22
// olan iki kare (26df8451 c4/c8) gözle sorunsuzdu. Sapmanın BÜYÜKLÜĞÜ tek
// başına kusur kanıtı değil; YÖNÜ belirleyici (bkz. aşağıdaki kural).
// 0.30 -> 0.20 SIKILAŞTIRILDI (2026-10-08, kullanıcı kararı: "base foto bakış
// açısı ile çıktı bakış açısı tamamen aynı olmalı"). 9d9507f0'da şikâyet
// edilen kareler: c3 0.31→0.56 (+0.25), c6 0.06→0.49 (+0.44), c9 0.07→0.57
// (+0.50). 2026-09-06'da 0.25'te gözle sorunsuz bulunan +0.22/+0.29 kareler
// artık elenecek — kullanıcı bu bedeli açıkça kabul etti.
// 0.20 -> 0.35 GEVŞETİLDİ (2026-10-10, iş 3cd612ba, kullanıcı: "gereksiz yere
// ret vermemeli"). 0.20'de 6 retin 5'i yaw-drift'ti; +0.30 (c9 d1), +0.27
// (c6 d2), +0.22 (c9 d2) kullanıcıya göre iyi kareydi ve retler saçak
// temizliğinden geçmediği için şablon saçı üstlerinde kaldı. +0.47 (c6 d1)
// gözle de dönmüştü → hâlâ elenir. 9d9507f0 c3'teki +0.25 şikâyeti artık
// geçer; bedel bilinerek.
const OUTPUT_YAW_DRIFT_MAX = 0.35;
// Yaw kapısında yüz bulunamazsa yeniden denenen tespit güveni (bkz. YAW KAPISI).
const LOW_CONF_FACE = 0.1;

// KAFAYI KAMERAYA ÇEVİRME KAPISI (2026-09-06, kullanıcının 2. önceliği).
// Kullanıcının bildirdiği somut kare (job 1181577f, elegance c6, Monaco/yat):
// tabandaki kişi TAM PROFİLDE (yaw 1.00) sağa bakarken, çıktıda gövde profil
// kalmış ama KAFA omzun üzerinden kameraya döndürülmüş (yaw 0.80). Sapma
// -0.20, yani genel eşiğin (0.30) altında — hiçbir kapıya takılmadan teslim
// edilmişti.
//
// Bu, prompt'ta zaten yasaklanan bilinen bir model davranışı: yüzü kolay
// üretmek için kafayı ortaya/kameraya çekmek. Kural bu yüzden YÖNE DUYARLI:
// yalnızca profil-dışına DOĞRU (yaw AZALARAK) kayan kareler elenir; kafanın
// daha da yana dönmesi (yaw artışı) bu kuralı tetiklemez.
//
// ŞABLON PROFİL ŞARTI: taban zaten cepheden bakıyorsa (düşük yaw) küçük bir
// azalma anlamsızdır; kural yalnızca tabanın belirgin profil olduğu karelerde
// çalışır. Gerçek üretim verisiyle maliyet ölçüldü (146 ölçüm):
//   sapma<=-0.18 ve şablonYaw>=0.70  ->  6 kare (%4.1)
// Karşılaştırma: simetrik eşiği 0.25'e çekmek %19.9'a dokunuyordu. Yani bu
// kural, doğrulanmış hatayı yakalarken maliyeti beşte birine indiriyor.
//
// 0.18 EŞİĞİ İKİ GÖZLE DOĞRULANMIŞ NOKTA ARASINDA SEÇİLDİ:
//   -0.197 (1181577f c6, şablon 1.00) → kullanıcı "reddedilmeliydi" dedi
//   -0.148 (26df8451 c7, şablon 0.95) → gözle sorunsuz, elenmemeli
// 0.20 denenmişti ama kullanıcının karesi (-0.197) eşiğin KILPAYI altında
// kalıp kaçıyordu.
const YAW_TO_CAMERA_TEMPLATE_MIN = 0.70;
const YAW_TO_CAMERA_DROP_MAX = 0.18;
// ÜÇÜNCÜ ŞART (2026-09-06, b64a0a65 c7 att2): şablon profil + yaw düşüşü
// yetmez — çıktı GERÇEKTEN cepheye inmiş olmalı. 0.51 hâlâ üç çeyrek / yana
// bakıştı (yat, mavi ceket) ve kullanıcı "geçmeliydi" dedi. 0.35, kaldırılan
// göğüs-üstü "tam önden" sınırıyla aynı yer: onun altında cepheden okunuyor.
const YAW_TO_CAMERA_OUTPUT_MAX = 0.35;

// FAZLA DÖNME (2026-09-06, b64a0a65 c0 Citi polo): kafa tabanla AYNI yöne
// bakarken dönüş abartılmış (şablon 0.27 → çıktı 0.49, sapma +0.22). Genel
// yaw eşiği 0.30 bunu kaçırdı; 0.25'e indirmek de yetmezdi ve daha önce
// yanlış pozitif üretmişti. Bu kural eşiği indirmez: yalnızca taban zaten
// dönükken (≥0.20) çıktının ondan ≥0.18 daha profil olmasını eler.
const YAW_OVER_ROTATE_TEMPLATE_MIN = 0.20;
const YAW_OVER_ROTATE_RISE_MIN = 0.18;
// İŞARETLİ FAZLA DÖNME (2026-10-20, 3d1d2a71 c0, kullanıcı: "yanlış yöne
// bakıyor, tip kaymış"): iki ölçü de profil bölgesindeyken kapı susuyordu
// (ÖLÇÜLEMEDİ[profile]); c0 0.63→0.88, c6 -0.70→-0.92, 7c17ea3f c2
// -0.59→-0.80 teslim edildi. İşaretsiz ölçü de kaçırıyordu (dd788c00 c2
// -0.40→-0.61 GEÇTİ, işaretsiz fark 0.06). İŞARETLİ poz aynı yönde belirgin
// daha büyükse baş daha çok dönmüştür — profilde de, değilken de. 60 tarihî
// ölçümde bu eşiği aşan 8 karenin 3'ü zaten reddedilmişti; +0.18 ve altı geçer.
const YAW_OVER_ROTATE_PROFILE_SIGNED_MIN = 0.20;
// 3B fazla dönme (2026-11-10, bkz. YAW KAPISI "3B FAZLA DÖNME"): derece; ağ ±YAW3D_MAX_ABS'de
// güvenilir; şablon neredeyse cepheyse (|yaw| < YAW3D_FRONT_DEG) yön şartı aranmaz.
const YAW_OVER_ROTATE_3D_DEG = 10;
const YAW3D_MAX_ABS = 50;
const YAW3D_FRONT_DEG = 5;

/**
 * 3B fazla dönme kararı (YAW KAPISI ile yön ikinci üretimi AYNI kuralı kullansın
 * diye tek yerde, 2026-11-13). tpl/out: headPose3dOf sonucu ya da null. SAF.
 * Döner { use3d, over, d } — d: |çıktı yaw| − |şablon yaw| (derece) ya da null.
 */
function yawOver3d(tpl, out) {
  const use3d = !!(tpl && out && tpl.src === "mesh" && out.src === "mesh" &&
    Number.isFinite(tpl.yaw) && Number.isFinite(out.yaw) &&
    Math.abs(tpl.yaw) <= YAW3D_MAX_ABS && Math.abs(out.yaw) <= YAW3D_MAX_ABS);
  const d = use3d ? Math.abs(out.yaw) - Math.abs(tpl.yaw) : null;
  const over = use3d && (tpl.yaw * out.yaw > 0 || Math.abs(tpl.yaw) < YAW3D_FRONT_DEG) && d >= YAW_OVER_ROTATE_3D_DEG;
  return { use3d, over, d };
}

// "Yüz yok + Vision kararsız" birleşik reddi için yüz kutusu kanıtı
// (2026-09-06, b64a0a65 c7 att1: telefona bakan kare, oran 0.173, vektör yok).
// Oran buysa yüz kadrajda duruyor demektir — ölçememek "yüz yok" değildir.
const FACE_EVIDENCE_RATIO_MIN = 0.08;

// KAFA YERLEŞİMİ (dx) KAPISI (2026-08-13, gerçek olay): measureHeadPlacement
// eskiden yalnızca ÖLÇÜYORDU, hiçbir kareyi elemiyordu (bkz. faceQuality.js
// başlığı — "önde/arkada" üç ayrı nedenden olabilir, hangisi bilinmeden
// DÜZELTME yazmak riskli). Ama ELEMEK bu riski taşımıyor — bariz aykırı bir
// kareyi atıp retry'a bırakmak, nedeni bilmeden de yapılabilir (yaw kapısıyla
// aynı mantık, bkz. yukarıdaki not).
// Gerçek olay: kullanıcı "kafa tam oturmamış" dediği bir kare bildirdi;
// job'daki 9 kareden 8'inin dx'i 0.01-0.09 bandındayken, şikayet edilen kare
// dx=0.26 ölçülmüştü ve hiçbir kapıya takılmadan teslim edilmişti.
//
// 0.15 -> 0.22 GEVŞETİLDİ (2026-08-13, aynı gün): 0.15 bir sonraki gerçek
// üretimde dx=0.18 ölçülen bir kareyi eledi — kullanıcı o kareyi gözle
// inceleyip UYUMLU/iyi olarak onayladı (yanlış pozitif). 0.22, 0.18'i rahat
// geçirir (0.04 pay) ve orijinal kötü örneği (0.26) yine eler — iki gerçek
// veri noktası arasında kalan bir değer.
const OUTPUT_HEAD_DX_MAX = 0.22;

/**
 * Modele gidecek YÜZ referanslarını verir.
 *
 * DİLİM NEDEN DURUYOR: göğüs-üstü kareler 2026-09-06'da kaldırıldı, ama daha
 * ÖNCE hazırlanmış işlerin dokümanında 5 URL duruyor ve son ikisi göğüs-üstü
 * kare. O ikisini yüz referansı sanıp modele vermek kimlik sadakatini bozar
 * (uzaktan çekilmiş, küçük yüz). Bu yüzden liste her hâlükârda ilk
 * FACE_PHOTO_COUNT kareyle sınırlanıyor.
 */
// SELFIE'Yİ BASE POZUNA ÇEVİRME (2026-10-31, bkz. headPose3d.js) — kapatmak
// için false; o zaman 10-30 yön eşleşmesi (EXIF düzeltilmiş) çalışır.
// 2026-11-03 KAPATILDI (kullanıcı: "baş base açısına çevrilmesine, yatıklık
// ve bakışın base'e göre ayarlanmasına gerek yok, promptta veriyoruz").
const REF_REPOSE_ON = false;
// REFERANSI BASE'E UYDURMA (2026-11-01, 831a00a4 — bkz. refMatch.js): base
// pozuna çevrilen selfie'nin bakışı, kapağı, yan yatıklığı ve ağız köşesi de
// base'den ölçülüp uydurulur; model bunları da selfie'den kopyalıyor.
// 2026-11-03 KAPATILDI (8ee5afa0, kullanıcı: "göz kapağı kaldırılmasın, ağız
// köşesi indirilmesin"): köşe base'in altına indiği için 5 karede kişi
// somurtkan göründü; kapak hem selfie'de hem çıktıda iki kez kaldırılıyordu.
const REF_MATCH_ON = false;
// TÜM SELFIE'LER (2026-11-03, kullanıcı: "en yakın 1'i seçmeyelim, 5'ini de
// gönderelim ki yapay zeka kişinin yüzünü tam anlayabilsin"): poz süzgeci,
// aynalama ve çevirme yok; 5 selfie ışığı eşitlenmiş olarak (bkz.
// selfieLight.js) base'e en yakın açıdaki önde gider. false = orderRefsByPose.
const SELFIE_SET_ALL = true;
const SELFIE_LIGHT_FLATTEN = true;
// İLK SELFIE BASE AÇISINDA (2026-11-03, b932fd71: 5 ham selfie ile baş yine selfie'lere
// çekildi — c3 +32°, c4 −15°, c8 −13°, çoğunda baş 8-18° yukarı). Kullanıcı: "5 selfie
// kalsın, base açısına en yakın selfie base açısına çevrilip ilk sıraya konsun; kalan 4
// kimlik için olduğu gibi". Bakış/ağız/kapak uydurması yok; FIRST_REF_GAZE yalnız
// yatay iris kaydırması (refMatch "gaze") — kullanıcı: "gözlerin bakış yönünü çözmemiz lazım".
// 2026-11-08 KAPATILDI (kullanıcı: "bu çevirme işi hoşuma gitmedi, kaldıralım ve bir
// daha önermeyelim"): yerel denemede pitch çevirmesi alında leke / yüz uzaması yaptı.
// Selfie de çıktı da 3B ağla ÇEVRİLMEZ; selfie'ler olduğu gibi (ışığı eşitlenmiş) gider.
const SELFIE_FIRST_REPOSE = false;
// PROMPTTA BASE POZU SAYIYLA (2026-11-08, kullanıcı: "base fotonun dönüş açısını,
// çene yerini vs matematiksel olarak alıp prompta verelim"; bkz.
// naturalSwap.describeBasePose). 3B ağ yaw/pitch/roll + 68 noktadan çene ucu ve
// yüz eni, modele giden tuvalde (tplBufForYaw). Baş açısı paragrafına girer.
// Geri dönüş: false (prompt bayt bayt eskiye döner).
const PROMPT_POSE_ON = true;
const PROMPT_ROLL_MAX_YAW = 25;
const PROMPT_ROLL_MAX_PITCH = 15;
/**
 * Base'in prompta yazılacak pozu; ölçülemezse null. Hepsi 3B yüz ağından
 * (headPose3dOf): açılar + yüz eni + çene ucu (ağ noktası 152), görüntüye oran.
 * 2026-11-08 inceleme: 68 noktalı çene hattı dönük başta yüz enini %25'e kadar
 * fazla veriyordu (27deeec2 c0 0.114 / ağ 0.091); ağ yoksa (68 nokta yedeği)
 * yaw ±55°'de tıkanıyor — o zaman prompta HİÇ sayı yazılmaz (prompt eskisi gibi).
 */
async function basePromptPose(buf, pose3d) {
  if (!pose3d || pose3d.src !== "mesh" || !Number.isFinite(pose3d.yaw)) return null;
  // Roll yalnız kameraya yakın ve az eğik başta: güçlü yaw/pitch'te Euler roll
  // göz çizgisiyle çelişiyor (27deeec2 c3: 3B −3.6° tepe sağa, göz çizgisi
  // −6.6° tepe sola; c7: 3B 29°, göz çizgisi 8°). Yanlış sayı yön vermekten kötü.
  const pitchOk = Number.isFinite(pose3d.pitch);
  const rollOk = pitchOk && Number.isFinite(pose3d.roll) && Math.abs(pose3d.yaw) < PROMPT_ROLL_MAX_YAW && Math.abs(pose3d.pitch) < PROMPT_ROLL_MAX_PITCH;
  const fin = (v) => (Number.isFinite(v) ? v : null);
  return {
    yaw: pose3d.yaw, pitch: pitchOk ? pose3d.pitch : null, roll: rollOk ? pose3d.roll : null,
    chinX: fin(pose3d.chinX), chinY: fin(pose3d.chinY), faceW: fin(pose3d.faceW),
  };
}
// SELFIE KAFA KIRPIMI (2026-11-08, kullanıcı: "1'i uygula", bkz. selfieCrop.js):
// 5 selfie de yalnız kafa + saç kalacak şekilde kırpılıp gider (omuz/gövde yön
// ipucu gitmez; saç kesilmez). Çıktıda baş çevirme reddedildi.
// 2026-11-08 KAPATILDI: canlı test 27deeec2 ort |Δyaw| 8.9° (öncesi ~7.5-8.3°),
// sapma yine öbür selfie'lerin açısına → poz ipucu gövde değil yüz; kullanıcı kapattı.
const SELFIE_HEAD_CROP = false;
// Aynı (önbellekteki) selfie Buffer'ı her chunk'ta yeniden kırpılmasın.
const HEAD_CROP_CACHE = new WeakMap();
function headCropOf(buf) {
  if (!HEAD_CROP_CACHE.has(buf)) {
    const p = runPostTask("cropSelfieHead", { buf }).then((r) => (r && r.buf ? { ...r, buf: Buffer.from(r.buf) } : r));
    p.catch(() => HEAD_CROP_CACHE.delete(buf));
    HEAD_CROP_CACHE.set(buf, p);
  }
  return HEAD_CROP_CACHE.get(buf);
}
// POZA YAKIN SELFIE SETİ (2026-11-08, 173acc7f c6 +6→+19°, c7 −40→−25°): 5 ham
// selfie gidince model başı öbür selfie'lerin açısına çekiyor. Onur arşivi:
// tek çevrilmiş selfie (11-02, 8ee5afa0) ort |Δyaw| 1.2° (n=10); 5 selfie +
// ilk çevrilmiş (11-03..11-06) 7.5° (n=30), 13-22° sapmalar; kimlik mesafesi
// iki dönemde aynı (~0.68 / ~0.67-0.71). Açık: şablona POSE_NEAR_DEG'den yakın
// selfie'ler gider (en az POSE_NEAR_MIN_KEEP en yakın). KAPALI — 11-03 kullanıcı
// kararı "5'i de gitsin"; açmak kullanıcı onayı + ücretli test ister.
const SELFIE_SET_POSE_NEAR = false;
const POSE_NEAR_DEG = 20;
const POSE_NEAR_MIN_KEEP = 2;
const FIRST_REF_GAZE = true;
// KOYU CAMLI GÖZLÜK BASE'DEN TAŞINIR (2026-11-03, 8ee5afa0 c4 tek cam + yanak bandı;
// bkz. sunglassTransfer.js). false = her gözlük yapay zeka düzenlemesiyle.
const SUNGLASS_TRANSFER_ON = true;
// GÖZLÜK TÜM ÇIKTILARDAN KALDIRILDI (2026-11-17, kullanıcı kararı, f8c1718b: c4/c9 çerçeve
// şablondan farklı ve yamuk, c5 cam yarım). Ana üretim gözlüğü zaten kaldırıyor; şablonun
// gözlüğünü geri koyan son adım (koyu cam taşıma + yapay zeka ekleme + kendi göz/cam tonu)
// hiç çalışmaz. Şablonda gözlük YARGISI sürer: kafa ölçeği, bakış kilidi ve bakış kapısı
// "şablon gözü camın arkasında" bilgisini kullanıyor. Geri açmak için true.
const EYEWEAR_ADD_ON = false;
// DOĞAL YER DEĞİŞTİRME ÇEKİRDEĞİ (2026-11-01, bkz. naturalSwap.js): referans
// base'e hazırlandıysa P800 yerine kısa "kişiyi değiştir, yüzü referanstaki
// gibi kopyala" talimatı. false = eski P800 (tek satır geri dönüş).
const NATURAL_SWAP_ON = true;
// ŞAPKALI ŞABLON PROMPTU (2026-11-06, bkz. hatDetect.js, naturalSwap.buildSelfieSetPrompt):
// model şablonun şapkasını düşürüyordu (6 karede 1 kaldı; selfie seti promptunda
// 3/3 düştü, ikisinde yarı saydam iz, 0eeb c10'da alna basılı logo teslim edildi).
// Şablonda şapka varsa saç cümlesine yerinde şapka cümlesi eklenir; yoksa prompt
// bugünküyle bayt bayt aynı. Tespit yerel/ücretsiz (skinSeg 'others' VE OWLv2),
// prepareSelfieSet ile paralel başlar. Aynı sonuç teslimde de kullanılır: geri
// yerleştirmede şablon şapka bölgesi yamadan gelir (postProcess keepMask: yumuşak
// kenar şablonun asıl şapkasını kubbe gibi karıştırıyordu), bitirmede model şapkayı
// tuttuysa ghostClean şapkayı iz saymaz (templateHat). false = her şablonda bugünkü
// prompt, geri yerleştirme ve bitirme.
// ŞABLON BİLGİ TABLOSU (2026-11-15, kullanıcı kararı; bkz. scripts/buildTemplateMeta.js,
// templateMeta/*.json). Üretim öncesi şablon ölçümleri (2B/3B poz, prompt pozu, şapka yok
// kararı) her karede yeniden yapılmak yerine tablodan okunur. Eşleşme ÖZGÜN şablon
// baytlarının md5'iyle (Storage md5Hash ile aynı); hazırlanan tuvalin kırpım oranı da
// tabloyla tutmalı (prepareTemplate değişirse tablo kendiliğinden devre dışı kalır).
// Tablo yoksa/eşleşmezse eskisi gibi ölçülür. Şapkalı şablon (maske gerekir) her zaman
// canlıda ölçülür. GERİ DÖNÜŞ: false + deploy (yedek: ciktilar/yedek/canli_2026-11-14_1337UTC_functions.tgz).
const TEMPLATE_META_ON = true;
let TEMPLATE_META = null;
function templateMetaIndex() {
  if (TEMPLATE_META) return TEMPLATE_META;
  TEMPLATE_META = new Map();
  try {
    const dir = require("path").join(__dirname, "templateMeta");
    for (const f of require("fs").readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const j = JSON.parse(require("fs").readFileSync(require("path").join(dir, f), "utf8"));
      if (!j || j.version < 2 || !j.templates) continue;
      for (const [name, t] of Object.entries(j.templates)) {
        if (t && t.md5 && t.raw && !t.err) TEMPLATE_META.set(t.md5, { name, raw: t.raw });
      }
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.error("ŞABLON TABLOSU okunamadı (ölçüme devam):", e.message || e);
  }
  return TEMPLATE_META;
}
// origBuf: indirilen özgün şablon; cropped/faceRatio: bu karede hazırlanan tuval. Tutmazsa null.
function templateMetaFor(origBuf, cropped, faceRatio) {
  if (!TEMPLATE_META_ON || !Buffer.isBuffer(origBuf)) return null;
  const idx = templateMetaIndex();
  if (!idx.size) return null;
  const md5 = require("crypto").createHash("md5").update(origBuf).digest("base64");
  const m = idx.get(md5);
  if (!m) return null;
  if (m.raw.cropped !== !!cropped) return { miss: "kırpım-farklı", name: m.name };
  if (Number.isFinite(m.raw.faceRatio) !== Number.isFinite(faceRatio) ||
    (Number.isFinite(faceRatio) && Math.abs(m.raw.faceRatio - faceRatio) > 1e-6)) return { miss: "yüzOranı-farklı", name: m.name };
  return m;
}

const HAT_PROMPT_ON = true;
// GÖZLÜKLÜ ŞABLON BAKIŞI (2026-11-20, bkz. naturalSwap GAZE_SENTENCE_EYEWEAR): şablonun gözü camın
// arkasındaysa bakış yönü yazılmaz, iris yüz yönünde ortada istenir. false = eski cümle (bayt bayt).
const EYEWEAR_GAZE_PROMPT_ON = true;
/** SAF. Vision yargısı okunduysa o; okunamadıysa yerel gözlük payı ≥ IRIS_TPL_GLASS_SKIP. */
function eyewearGazeOn(vision, share) {
  if (vision && vision.ok) return vision.eyewear === true;
  return share != null && Number.isFinite(share) && share >= require("./gazeGate").IRIS_TPL_GLASS_SKIP;
}
// Kalan süre bundan azsa tespit atlanır (hat=false = bugünkü prompt; bkz. jobTimeLeftMs).
const HAT_DETECT_MIN_LEFT_MS = 300 * 1000;
// Havuz meşgulse üretimi bekletmesin: bu sürede bitmezse hat=false.
const HAT_DETECT_TIMEOUT_MS = 60 * 1000;
// Şablon (modele giden tuval baytları) başına bir kez; yeniden deneme/ikinci üretim aynı sonucu kullanır.
const TEMPLATE_HAT_CACHE = new Map();
function templateHatOf(buf, styleId, chunkIdx) {
  if (!Buffer.isBuffer(buf)) return Promise.resolve({ hat: false, reason: "no-buffer" });
  const key = require("crypto").createHash("sha1").update(buf).digest("hex");
  if (!TEMPLATE_HAT_CACHE.has(key)) {
    if (TEMPLATE_HAT_CACHE.size > 200) TEMPLATE_HAT_CACHE.clear();
    const p = (async () => {
      const left = jobTimeLeftMs();
      let r;
      if (left < HAT_DETECT_MIN_LEFT_MS) {
        r = { hat: false, reason: "süre-bütçesi" };
      } else {
        let timer;
        try {
          r = await Promise.race([
            runPostTask("templateHat", { tpl: buf }),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ hat: false, reason: "zaman-aşımı" }), HAT_DETECT_TIMEOUT_MS); }),
          ]);
        } catch (e) {
          r = { hat: false, reason: "hata" };
          console.error("Şablon şapka tespiti hata verdi (bugünkü prompt):", e.message || e);
        } finally {
          clearTimeout(timer);
        }
      }
      const n = (v) => (v != null && Number.isFinite(v) ? v.toFixed(3) : "null");
      console.log(`ŞAPKA ŞABLONDA (style=${styleId}, chunk=${chunkIdx}): ${r.hat ? "VAR" : `YOK[${r.reason || "-"}]`} owl=${n(r.score)}${r.q ? `(${r.q})` : ""} saç=${n(r.hair)} alan=${n(r.area)} süre=${r.ms ?? "null"}ms`);
      return r;
    })();
    // Hata/süre sonucu önbellekte kalmasın: sonraki deneme yeniden ölçebilir.
    p.then((r) => { if (r && (r.reason === "hata" || r.reason === "zaman-aşımı" || r.reason === "süre-bütçesi")) TEMPLATE_HAT_CACHE.delete(key); });
    TEMPLATE_HAT_CACHE.set(key, p);
  }
  return TEMPLATE_HAT_CACHE.get(key);
}
// Selfie yaw'ları iş boyunca değişmez; URL başına bir kez ölçülür.
const REF_YAW_CACHE = new Map();
function refYawOf(url) {
  if (!REF_YAW_CACHE.has(url)) {
    if (REF_YAW_CACHE.size > 200) REF_YAW_CACHE.clear();
    REF_YAW_CACHE.set(url, (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        // EXIF DÖNDÜRMESİ (2026-10-31, 21e56b20): Storage'daki selfie ham
        // telefon baytı; yüz ölçümü EXIF'i uygulamıyor (bkz. faceQuality
        // bufferToTensorScaled). Hazırlık [0.02,−0.33,0.39,−0.87,0.84]
        // ölçtü, burada [−0.53,null,0.11,1.00,−0.09] çıktı — düz şablonlara
        // sağa dönük selfie gitti, baş +20°'ye döndü. 3B poz (derece) da
        // burada, döndürülmüş görüntüde (bkz. headPose3d).
        const raw = Buffer.from(await r.arrayBuffer());
        const b = await require("sharp")(raw).rotate().jpeg({ quality: 95 }).toBuffer();
        const { headPoseOf } = require("./faceQuality");
        const p = (await headPoseOf(b)) || (await headPoseOf(b, LOW_CONF_FACE));
        const p3 = await require("./headPose3d").headPose3dOf(b, { loose: false });
        if (!p && !p3) return null;
        return {
          yaw: p ? p.yaw : null, yawSigned: p && p.yawSigned != null ? p.yawSigned : null,
          deg: p3 ? p3.yaw : null, pitch: p3 ? p3.pitch : null, src3d: p3 ? p3.src : null,
        };
      } catch (e) {
        console.error("Selfie yaw ölçümü başarısız (atlanıyor):", e.message || e);
        return null;
      }
    })());
  }
  return REF_YAW_CACHE.get(url);
}

// Işığı eşitlenmiş selfie (URL başına iş boyunca bir kez; bkz. SELFIE_SET_ALL).
const SELFIE_FETCH_MS = 45000;
const SELFIE_FETCH_TRIES = 2;
const FLAT_SELFIE_CACHE = new Map();
function flatSelfieOf(url) {
  if (!FLAT_SELFIE_CACHE.has(url)) {
    if (FLAT_SELFIE_CACHE.size > 40) FLAT_SELFIE_CACHE.clear();
    // 2026-11-08 (173acc7f): iş başında 10 kare aynı anda yüklenirken 15 sn'lik
    // indirme sınırı aşıldı; 5 selfie'nin 4'ü "hata" ile URL olarak gitti ve 6
    // karede ilk selfie base açısına HİÇ çevrilmedi (ilk=kapalı). İndirme ücretsiz:
    // sınır uzun, bir kez tekrar; ışık eşitleme düşerse ham selfie Buffer gider
    // (çevirme yine çalışır).
    const p = (async () => {
      let raw = null, lastErr = null;
      for (let k = 0; k < SELFIE_FETCH_TRIES && !raw; k++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(SELFIE_FETCH_MS) });
          if (!r.ok) throw new Error(`selfie indirilemedi: ${r.status}`);
          raw = Buffer.from(await r.arrayBuffer());
        } catch (e) {
          lastErr = e;
        }
      }
      if (!raw) throw lastErr || new Error("selfie indirilemedi");
      const plain = async (reason) => ({ buf: await require("sharp")(raw).rotate().jpeg({ quality: 95 }).toBuffer(), applied: false, reason });
      if (!SELFIE_LIGHT_FLATTEN) return plain("kapalı");
      try {
        const res = await runPostTask("flattenSelfie", { buf: raw });
        return { ...res, buf: Buffer.from(res.buf) };
      } catch (e) {
        console.error("Selfie ışığı eşitlenemedi (ham selfie gider):", e.message || e);
        return plain("hata");
      }
    })();
    p.catch(() => FLAT_SELFIE_CACHE.delete(url));
    FLAT_SELFIE_CACHE.set(url, p);
  }
  return FLAT_SELFIE_CACHE.get(url);
}

// TAHMİNE GÖRE SIRA (2026-11-16, kullanıcı onayı; 5 Onur işi × 10 şablon, 49 kare, 3B ağ):
// çıktı baş açısını şablon değil İLK sıradaki selfie belirliyor ve orta açılar ~%20 fazla
// dönük çiziliyor. İlk selfie −24.5° olan üç şablon (−20.7/−17.3/−25.9) → çıktı −31.2/−27.6/
// −29.6; +13.4° → +16.2/+18.2; −44° → −39.9/−45.4; +49.9° → +50.8 (uçta kazanç yok). Bu
// yüzden öne "açısı en yakın" değil "ÇİZİLECEK açısı en yakın" selfie konur: c5 (şablon
// −34.8) −44 yerine −24.5 alır (beklenen −29.4; eski sırada 5 işin 5'inde −42.6..−47.5).
// Diğer 9 şablonda sıra değişmiyor. Kazanç tek kişinin setinden; "ilk sıra mı, en yakın
// selfie mi" ayrılmadı → ilk işte c5'in POZ 3B ÖLÇÜM satırına bak. Kapatmak için false.
const SELFIE_PRED_ORDER = true;
const PRED_GAIN_MID = 1.2;
const PRED_GAIN_FULL_DEG = 30;
const PRED_GAIN_NONE_DEG = 44;
function predictedOutYaw(deg) {
  if (!Number.isFinite(deg)) return null;
  const a = Math.abs(deg);
  const t = Math.min(1, Math.max(0, (a - PRED_GAIN_FULL_DEG) / (PRED_GAIN_NONE_DEG - PRED_GAIN_FULL_DEG)));
  return deg * (PRED_GAIN_MID + (1 - PRED_GAIN_MID) * t);
}
// EĞİM DE SEÇİMDE (2026-11-16, sık açılı çekim): yalnız aday sayısı FACE_PHOTO_COUNT'tan
// fazlaysa (yeni 10'lu çekim). Model eğimi selfie setinden alıyor (11-12: çıktı ≈ +3.4 +
// 0.38·şablon, selfie'ler hep düz); çene-aşağı kare yalnız eğik şablonda öne gelsin.
// Ağırlık 0.5: 10° eğim farkı 5° yön farkı kadar sayılır (yön kusuru kullanıcıya daha
// görünür). 3/5'li eski setlerde eğim hiç kullanılmaz → sıra bayt bayt eski.
const PRED_PITCH_WEIGHT = 0.5;
// Şablondan bu kadar DAHA AŞAĞI bakan kare sona: ağırlık tek başına çene-aşağı kareyi düz
// şablonun 5'linden çıkarmıyordu (ön, sağ1, aşağı, sol1… → 3. sıra). Yalnız tek yön: düz
// kareleri eğik şablonda cezalandırmak (ilk denemede iki yönlüydü) önden çekilmiş aşağı
// kareyi −44° dönük eğik şablonun (c2) ilk sırasına koyuyordu → baş düzleşirdi.
const PRED_PITCH_EXCLUDE_DEG = 15;
const PRED_PITCH_EXCLUDE_COST = 1000;
// AŞAĞI BAKAN ŞABLONA EĞİMCE EN YAKIN SELFIE (2026-11-17, kullanıcı kararı; f8c1718b: 10
// karenin 10'unda çıktı başı şablondan yukarıda, ort. +8.9°, c9 −20.9 → +5.4). Çene-aşağı
// kare önden çekildiği için yön maliyeti onu dönük şablonun 5'lisine hiç sokmuyordu.
// Şablon PITCH_ADD_TPL_DEG'den aşağı bakıyorsa eğimce en yakın selfie — 5'linin geri
// kalanından en az MARGIN daha aşağı bakıyorsa — 2. sıraya girer (ilk sıra yönü belirlediği
// için değişmez), 5'linin sonuncusu çıkar. 3/5'li eski setlerde çalışmaz (usePitch).
const PITCH_ADD_ON = true;
const PITCH_ADD_TPL_DEG = -7;
const PITCH_ADD_MARGIN_DEG = 5;
/**
 * Selfie açıları (derece; ölçülemeyen null) ve şablon açısından gönderim sırası.
 * predict=true: çizilecek açıya göre; false: ham açıya göre (eski kural). bestErr:
 * setin şablona en yakın ÇİZİLECEK açısının uzaklığı (yalnız yön; ölçü yoksa null).
 * pitch: { selfie: [derece|null], tpl: derece } verilirse ve aday sayısı
 * FACE_PHOTO_COUNT'u aşarsa eğim farkı da maliyete eklenir. SAF.
 */
// 10'LU HAVUZDA İLK SIRA + PROFİL KORUMASI (2026-11-19, kullanıcı: "5 selfie'yi şablonun baş
// yönüne göre en mantıklı şekilde seç"; 12 iş, 117 kare, Onur + Kutay, iş-dışı-bırakma doğrulaması,
// scratchpad sel5/). Yalnız aday > FACE_PHOTO_COUNT ve predict iken; 3/5'li setler bayt bayt eski.
// (1) 30-40° selfie'ler büyütülmüyor: Kutay −36.6 ilk → çıktı −35.1 (n=7), +39.9 → +38.0 (n=6);
//     eski eğri −40.5/+42.2 bekliyordu. Kazancın bittiği yer 44° değil 36° (iki kişide ayrı ayrı
//     30-37°). Yaw MAE 3.46 → 3.11 (iç içe doğrulamada da 3.12; 30-44° bandında 4.62 → 2.18).
//     Bu eğri YALNIZ ilk sırayı seçer: maliyetin tamamına uygulanınca Onur'un +34.9'u düz
//     şablonların 5'lisine giriyordu. Terfi ancak yalnız yönce de kesin daha yakınsa — selfie
//     eğimi (seviyeli karelerde etkisiz) tek başına ilk sırayı değiştirmesin (çürütme: Onur
//     T +38 eğim yüzünden 34.9 → 40.8, üç modelde de kötü). Örnek: Kutay T 37-40, +28.1 ilkken
//     çıktı ort. +32.8 (az dönük), +39.9 ilkken +38.0.
// (2) Düz şablonda (|T| ≤ 20) 2-5. sırada ≥35° selfie gitmez, yerine sıradaki seviyeli kare
//     (profil çekmesi, bkz. 10-26 bulgusu; bu veride n=3, hepsi profile doğru +11.5° fazla dönük —
//     tek başına anlamlı değil, bu yüzden ayrı bayrak + log). Seviyeli şablona yedek olarak
//     çene-aşağı kare konmaz. Yeterli yedek yoksa profil geri girer.
const POOL_RANK1_ON = true;
const POOL_GAIN_NONE_DEG = 36;
const PROFILE_GUARD_ON = true;
const PROFILE_GUARD_TPL_DEG = 20;
const PROFILE_GUARD_SELFIE_DEG = 35;
const CHIN_DOWN_SELFIE_DEG = -10;
function predictedOutYawPool(deg) {
  if (!Number.isFinite(deg)) return null;
  const t = Math.min(1, Math.max(0, (Math.abs(deg) - PRED_GAIN_FULL_DEG) / (POOL_GAIN_NONE_DEG - PRED_GAIN_FULL_DEG)));
  return deg * (PRED_GAIN_MID + (1 - PRED_GAIN_MID) * t);
}
function selfieOrderForYaw(selfieDegs, tYaw, predict = true, pitch = null) {
  const plan = selfieOrderCore(selfieDegs, tYaw, predict, pitch);
  const n = selfieDegs.length;
  if (n <= FACE_PHOTO_COUNT || !predict || !Number.isFinite(tYaw)) return plan;
  const usePitch = !!(pitch && Array.isArray(pitch.selfie) && Number.isFinite(pitch.tpl));
  const sp = (i) => (usePitch && Number.isFinite(pitch.selfie[i]) ? pitch.selfie[i] : null);
  const excluded = (i) => sp(i) != null && pitch.tpl - sp(i) > PRED_PITCH_EXCLUDE_DEG;
  const yawErr = (i) => (Number.isFinite(selfieDegs[i]) ? Math.abs(predictedOutYawPool(selfieDegs[i]) - tYaw) : Infinity);
  const poolCost = (i) => {
    const e = yawErr(i);
    if (!Number.isFinite(e) || sp(i) == null) return e;
    return e + PRED_PITCH_WEIGHT * Math.abs(sp(i) - pitch.tpl) + (excluded(i) ? PRED_PITCH_EXCLUDE_COST : 0);
  };
  let order = plan.order.slice();
  const extra = {};
  if (POOL_RANK1_ON) {
    let r1 = order[0];
    for (const i of order) if (poolCost(i) < poolCost(r1) || (poolCost(i) === poolCost(r1) && i < r1)) r1 = i;
    if (r1 !== order[0] && Number.isFinite(poolCost(r1)) && yawErr(r1) < yawErr(order[0])) {
      const from = order.indexOf(r1);
      order.splice(from, 1);
      order.unshift(r1);
      // Eğim eki (çene-aşağı kare) 2. sırada kalır.
      if (plan.pitchAdd && plan.pitchAdd.idx !== r1) {
        order.splice(order.indexOf(plan.pitchAdd.idx), 1);
        order.splice(1, 0, plan.pitchAdd.idx);
      }
      extra.promoted = { idx: r1, from };
    }
  }
  if (PROFILE_GUARD_ON && Math.abs(tYaw) <= PROFILE_GUARD_TPL_DEG) {
    const isProfile = (i) => Number.isFinite(selfieDegs[i]) && Math.abs(selfieDegs[i]) >= PROFILE_GUARD_SELFIE_DEG;
    const levelTpl = usePitch && pitch.tpl > PITCH_ADD_TPL_DEG;
    const top = order.slice(0, FACE_PHOTO_COUNT);
    if (top.slice(1).some(isProfile)) {
      const keep = [top[0], ...top.slice(1).filter((i) => !isProfile(i))];
      for (const i of order.slice(FACE_PHOTO_COUNT)) {
        if (keep.length >= FACE_PHOTO_COUNT) break;
        if (isProfile(i) || !Number.isFinite(selfieDegs[i]) || excluded(i)) continue;
        if (levelTpl && sp(i) != null && sp(i) < CHIN_DOWN_SELFIE_DEG) continue;
        keep.push(i);
      }
      for (const i of top) if (keep.length < FACE_PHOTO_COUNT && !keep.includes(i)) keep.push(i);
      const five = keep.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const dropped = top.filter((i) => !five.includes(i));
      if (dropped.length) {
        order = [...five, ...order.filter((i) => !five.includes(i))];
        extra.profileGuard = dropped;
      }
    }
  }
  return { ...plan, order, ...extra };
}
/** Eski kural (3/5'li setler ve 10'lu havuzun temeli). SAF. */
function selfieOrderCore(selfieDegs, tYaw, predict = true, pitch = null) {
  const n = selfieDegs.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (!Number.isFinite(tYaw)) return { order: idx, bestErr: null };
  const usePitch = n > FACE_PHOTO_COUNT && pitch && Array.isArray(pitch.selfie) && Number.isFinite(pitch.tpl);
  const err = (i, p) => {
    const d = selfieDegs[i];
    if (!Number.isFinite(d)) return Infinity;
    return Math.abs((p ? predictedOutYaw(d) : d) - tYaw);
  };
  const cost = (i) => {
    const e = err(i, predict);
    if (!usePitch || !Number.isFinite(e)) return e;
    const sp = pitch.selfie[i];
    if (!Number.isFinite(sp)) return e;
    const dp = Math.abs(sp - pitch.tpl);
    return e + PRED_PITCH_WEIGHT * dp + (pitch.tpl - sp > PRED_PITCH_EXCLUDE_DEG ? PRED_PITCH_EXCLUDE_COST : 0);
  };
  const order = idx.slice().sort((a, b) => cost(a) - cost(b) || a - b);
  const best = Math.min(...idx.map((i) => err(i, true)));
  // Aşağı bakan şablon: eğimce en yakın (ve 5'liden belirgin aşağı bakan) selfie 2. sıraya.
  let pitchAdd = null;
  if (usePitch && PITCH_ADD_ON && pitch.tpl <= PITCH_ADD_TPL_DEG) {
    const sp = (i) => (Number.isFinite(pitch.selfie[i]) ? pitch.selfie[i] : null);
    const cand = idx.filter((i) => sp(i) != null && Number.isFinite(selfieDegs[i]));
    const j = cand.length ? cand.reduce((a, b) => (Math.abs(sp(b) - pitch.tpl) < Math.abs(sp(a) - pitch.tpl) ? b : a)) : null;
    const top = order.slice(0, FACE_PHOTO_COUNT);
    const topMin = Math.min(...top.filter((i) => i !== j).map((i) => (sp(i) == null ? Infinity : sp(i))));
    if (j != null && order[0] !== j && sp(j) <= topMin - PITCH_ADD_MARGIN_DEG) {
      const k = order.indexOf(j);
      order.splice(k, 1);
      order.splice(1, 0, j);
      pitchAdd = { idx: j, from: k };
    }
  }
  return { order, bestErr: Number.isFinite(best) ? best : null, ...(pitchAdd ? { pitchAdd } : {}) };
}

/**
 * TÜM SELFIE SETİ (2026-11-03, bkz. SELFIE_SET_ALL): ilk FACE_PHOTO_COUNT
 * selfie'nin hepsi, ışığı eşitlenmiş Buffer olarak; ÇİZİLECEK baş açısı base'e
 * en yakın olan önde (bkz. SELFIE_PRED_ORDER; yalnız sıra — süzgeç, aynalama,
 * çevirme yok). Bir selfie hazırlanamazsa yerine kendi URL'i gider. Hata =
 * refUrls aynen.
 */
async function prepareSelfieSet(refUrls, tplPose3d, styleId, chunkIdx, attempt, tplMatch = null) {
  try {
    const faces = poseCandidateRefUrls(refUrls);
    if (!faces.length) return refUrls;
    const flatOf = (u) => flatSelfieOf(u).catch((e) => {
      console.error("Selfie ışığı eşitlenemedi (orijinal gider):", e.message || e);
      return null;
    });
    // 3/5'li sette ışık eşitleme ölçümle paralel (eski davranış); 10'lu sette yalnız
    // seçilen FACE_PHOTO_COUNT kare eşitlenir (süre).
    const many = faces.length > FACE_PHOTO_COUNT;
    const [poses, flatsAll] = await Promise.all([
      Promise.all(faces.map(refYawOf)),
      many ? Promise.resolve(null) : Promise.all(faces.map(flatOf)),
    ]);
    const tYaw = tplPose3d && Number.isFinite(tplPose3d.yaw) ? tplPose3d.yaw : null;
    const dist = (i) => (tYaw != null && poses[i] && Number.isFinite(poses[i].deg) ? Math.abs(poses[i].deg - tYaw) : Infinity);
    const tPitch = tplPose3d && tplPose3d.src === "mesh" && Number.isFinite(tplPose3d.pitch) ? tplPose3d.pitch : null;
    const plan = selfieOrderForYaw(
      poses.map((p) => (p && Number.isFinite(p.deg) ? p.deg : null)), tYaw, SELFIE_PRED_ORDER,
      { selfie: poses.map((p) => (p && Number.isFinite(p.pitch) ? p.pitch : null)), tpl: tPitch });
    let order = many ? plan.order.slice(0, FACE_PHOTO_COUNT) : plan.order;
    const flats = flatsAll || [];
    if (many) {
      const got = await Promise.all(order.map((i) => flatOf(faces[i])));
      order.forEach((i, k) => { flats[i] = got[k]; });
    }
    let poseDropped = [];
    if (SELFIE_SET_POSE_NEAR && tYaw != null) {
      const near = order.filter((i, k) => k < POSE_NEAR_MIN_KEEP || dist(i) <= POSE_NEAR_DEG);
      poseDropped = order.filter((i) => !near.includes(i));
      order = near;
    }
    const f1 = (v) => (v != null && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "null");
    const f2 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(2) : "-");
    const desc = order.map((i) => {
      const f = flats[i];
      const light = !f ? "hata" : f.applied ? `ışık ${f2(f.spread)}→${f2(f.after)}` : `ışık[${f.reason}]`;
      return `${i}:${f1(poses[i] && poses[i].deg)}${many ? `/${f1(poses[i] && poses[i].pitch)}` : ""} ${light}`;
    });
    const out = order.map((i) => (flats[i] && flats[i].buf ? flats[i].buf : faces[i]));
    let firstDesc = "kapalı";
    // İlk selfie'nin (çevrildiyse çevrilmiş) yaw'ı: şablon saçı kırpması
    // kafayı bu selfie'den izdüşürür, açı uzaksa kırpmaz (bkz. TRIM_GATE).
    let firstYaw = poses[order[0]] && Number.isFinite(poses[order[0]].deg) ? poses[order[0]].deg : null;
    if (SELFIE_FIRST_REPOSE && tYaw != null && Buffer.isBuffer(out[0])) {
      try {
        const pitch = tplPose3d.src === "mesh" ? tplPose3d.pitch : null;
        const rp = await runPostTask("reposeSelfie", { buf: out[0], yaw: tYaw, pitch, mirror: false, base: FIRST_REF_GAZE ? tplMatch : null, only: ["gaze"] });
        if (rp && rp.buf) out[0] = Buffer.from(rp.buf);
        const pa = rp && rp.after, pb = rp && rp.before;
        if (rp && rp.applied && pa && Number.isFinite(pa.yaw)) firstYaw = pa.yaw;
        else if (rp && pb && Number.isFinite(pb.yaw)) firstYaw = pb.yaw;
        firstDesc = !rp ? "hata" : `${rp.applied ? `çevrildi ${pb ? `${f1(pb.yaw)}/${f1(pb.pitch)}` : "?"}→${pa ? `${f1(pa.yaw)}/${f1(pa.pitch)}` : "?"}` : `çevrilmedi[${rp.reason}]`} bakış=${!FIRST_REF_GAZE ? "kapalı" : !tplMatch ? "base-ölçülemedi" : rp.match ? (rp.match.applied ? rp.match.log : `dokunulmadı(${rp.match.log})`) : "yok"}`;
      } catch (e) {
        firstDesc = "hata";
        console.error("İlk selfie base açısına çevrilemedi (olduğu gibi):", e.message || e);
      }
    }
    // Kafa kırpımı (bkz. SELFIE_HEAD_CROP): ilk selfie çevrildikten SONRA (çevirme
    // bağlam ister). Kırpılamayan selfie aynen gider.
    let cropDesc = "kapalı";
    if (SELFIE_HEAD_CROP) {
      const crops = await Promise.all(out.map((b) => (Buffer.isBuffer(b)
        ? headCropOf(b).catch((e) => ({ applied: false, reason: `hata:${e.message || e}` }))
        : Promise.resolve({ applied: false, reason: "url" }))));
      crops.forEach((c, k) => { if (c && c.applied && Buffer.isBuffer(c.buf)) out[k] = c.buf; });
      cropDesc = `[${crops.map((c) => (!c ? "hata" : c.applied ? `${c.box.width}x${c.box.height}(${f2(c.frac)}${c.seg ? "" : ",segsiz"})` : `ATLANDI[${c.reason}]`)).join(", ")}]`;
    }
    const notSent = many ? plan.order.slice(FACE_PHOTO_COUNT) : [];
    console.log(`SELFIE SETİ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${order.length}/${faces.length} selfie${notSent.length ? ` gitmeyen=[${notSent.map((i) => `${i}:${f1(poses[i] && poses[i].deg)}/${f1(poses[i] && poses[i].pitch)}`).join(", ")}]` : ""}${poseDropped.length ? ` pozaUzakÇıkarılan=[${poseDropped.map((i) => f1(poses[i] && poses[i].deg)).join(", ")}]` : ""} şablon=${f1(tYaw)}/${f1(tplPose3d && tplPose3d.pitch)} sıra=[${desc.join(", ")}] ilk=${firstDesc} kafaKırpım=${cropDesc} beklenen=${f1((many && POOL_RANK1_ON ? predictedOutYawPool : predictedOutYaw)(firstYaw))} enYakınÇizim=${plan.bestErr == null ? "-" : `${plan.bestErr.toFixed(1)}°`}${plan.pitchAdd ? ` eğimEk=${plan.pitchAdd.idx}:${f1(poses[plan.pitchAdd.idx] && poses[plan.pitchAdd.idx].pitch)}(sıra ${plan.pitchAdd.from + 1}→2)` : ""}${plan.promoted ? ` ilkTerfi=${plan.promoted.idx}:${f1(poses[plan.promoted.idx] && poses[plan.promoted.idx].deg)}(sıra ${plan.promoted.from + 1}→1)` : ""}${plan.profileGuard ? ` profilKoruma=[${plan.profileGuard.map((i) => `${i}:${f1(poses[i] && poses[i].deg)}`).join(", ")}]` : ""}`);
    Object.defineProperty(out, "firstYaw", { value: firstYaw, enumerable: false });
    Object.defineProperty(out, "reachErr", { value: plan.bestErr, enumerable: false });
    return out;
  } catch (e) {
    console.error("Selfie seti hazırlanamadı (sıra değişmedi):", e.message || e);
    return refUrls;
  }
}

/**
 * Yüz selfie'lerini kafa yönü şablona en yakın olan öne gelecek şekilde
 * sıralar (bkz. gazeGate.poseMatchedOrder). Düz/yarı dönük şablonda tam
 * profil selfie'ler çıkarılır (bkz. gazeGate.poseFilteredRefs); o zaman
 * yalnız kalan yüzler döner (üretim zaten yalnız ilk FACE_PHOTO_COUNT'u
 * kullanır, eski işlerin göğüs-üstü kareleri yüz sanılmasın). Yoksa yüz dışı
 * referanslar sonda aynen kalır. Hata = sıra değişmez.
 * 2026-10-30: şablonun ve selfie'lerin işaretli yönü ölçülebiliyorsa bunların
 * yerine yalnız şablonla aynı yöne bakan selfie'ler gider, gerekirse biri
 * aynalanmış Buffer olarak (bkz. gazeGate.poseMatchedRefSet).
 */
async function orderRefsByPose(refUrls, templateYaw, styleId, chunkIdx, attempt, templateYawSigned = null, tplPose3d = null, tplMatch = null) {
  try {
    const faces = faceRefUrls(refUrls);
    if (faces.length < 2 || templateYaw == null) return refUrls;
    const poses = await Promise.all(faces.map(refYawOf));
    const yaws = poses.map((p) => (p ? p.yaw : null));
    const { poseMatchedOrder, poseFilteredRefs, poseMatchedRefSet, poseRefPlanDeg } = require("./gazeGate");
    const f2 = (v) => (v != null ? v.toFixed(2) : "null");
    const f1 = (v) => (v != null && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "null");
    // SELFIE BASE POZUNDA (2026-10-31, bkz. headPose3d.js): yöne en yakın
    // selfie seçilir, kalan yaw/pitch farkı yüz ağıyla çevrilir. Model başı
    // giden selfie'nin pozuna çektiği için selfie base pozunda gider.
    const plan = REF_REPOSE_ON && tplPose3d
      ? poseRefPlanDeg(poses.map((p) => (p ? p.deg : null)), tplPose3d.yaw, {
        pitches: poses.map((p) => (p ? p.pitch : null)),
        tplPitch: tplPose3d.src === "mesh" ? tplPose3d.pitch : null,
        noMesh: poses.map((p) => !p || p.src3d !== "mesh"),
      })
      : null;
    if (plan) {
      const tgt = { yaw: tplPose3d.yaw, pitch: tplPose3d.src === "mesh" ? tplPose3d.pitch : null };
      const res = await Promise.all(plan.keep.map(async (k) => {
        try {
          const r = await fetch(faces[k.i], { signal: AbortSignal.timeout(15000) });
          if (!r.ok) return null;
          const raw = Buffer.from(await r.arrayBuffer());
          const rp = await runPostTask("reposeSelfie", { buf: raw, yaw: tgt.yaw, pitch: tgt.pitch, mirror: k.mirror, base: tplMatch });
          return { rp, buf: rp && rp.buf ? Buffer.from(rp.buf) : null };
        } catch (e) {
          console.error("Selfie base pozuna çevrilemedi (atlanıyor):", e.message || e);
          return null;
        }
      }));
      const desc = res.map((x, j) => {
        const k = plan.keep[j];
        const tag = `${k.i}${k.mirror ? "ayna" : ""}`;
        if (!x || !x.rp) return `${tag}:hata`;
        const a = x.rp.after, b = x.rp.before;
        return x.rp.applied
          ? `${tag}:${f1(b.yaw)}/${f1(b.pitch)}→${a ? `${f1(a.yaw)}/${f1(a.pitch)}` : "?"}`
          : `${tag}:${b ? `${f1(b.yaw)}/${f1(b.pitch)}` : ""}[${x.rp.reason}]`;
      });
      console.log(`REFERANS SIRASI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): POZ-3B${plan.reason ? `[${plan.reason}]` : ""} şablon=${f1(tplPose3d.yaw)}/${f1(tplPose3d.pitch)}[${tplPose3d.src}] selfie=[${poses.map((p) => (p ? `${f1(p.deg)}/${f1(p.pitch)}` : "null")).join(",")}] giden=[${desc.join(",")}]`);
      const matchDesc = !REF_MATCH_ON ? "KAPALI" : !tplMatch ? "ATLANDI[base-ölçülemedi]" : res.map((x, j) => {
        const tag = `${plan.keep[j].i}${plan.keep[j].mirror ? "ayna" : ""}`;
        const m = x && x.rp && x.rp.match;
        return m ? `${tag}: ${m.applied ? "UYGULANDI" : "dokunulmadı"} ${m.log}` : `${tag}: yok`;
      }).join(" | ");
      console.log(`REFERANS BASE'E UYDURMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${matchDesc}`);
      const ok = res.filter((x) => x && x.buf).map((x) => x.buf);
      if (ok.length) return ok;
    }
    // Yalnız şablonla aynı yöne bakan selfie'ler (gerekirse bir aynalı).
    const ms = poseMatchedRefSet(poses.map((p) => (p ? p.yawSigned : null)), templateYawSigned);
    if (ms) {
      const out = await Promise.all(ms.keep.map(async (k) => {
        if (!k.mirror) return faces[k.i];
        try {
          const r = await fetch(faces[k.i], { signal: AbortSignal.timeout(15000) });
          if (!r.ok) return null;
          return await require("sharp")(Buffer.from(await r.arrayBuffer())).rotate().flop().jpeg({ quality: 95 }).toBuffer();
        } catch (e) {
          console.error("Selfie aynalanamadı (atlanıyor):", e.message || e);
          return null;
        }
      }));
      const refs = out.filter(Boolean);
      console.log(`REFERANS SIRASI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): YÖN-EŞLEŞMESİ${ms.reason ? `[${ms.reason}]` : ""} şablonİşaretli=${f2(templateYawSigned)} selfieİşaretli=[${poses.map((p) => f2(p && p.yawSigned)).join(",")}] giden=[${ms.keep.map((k) => `${k.i}${k.mirror ? "ayna" : ""}:${f2(k.yaw)}`).join(",")}]`);
      if (refs.length) return refs;
    }
    const pf = poseFilteredRefs(yaws, templateYaw);
    const p = poseMatchedOrder(pf.keep.map((i) => yaws[i]), templateYaw);
    const order = p.order.map((k) => pf.keep[k]);
    const f = (v) => (v != null ? v.toFixed(2) : "null");
    console.log(`REFERANS SIRASI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${p.swapped ? "DEĞİŞTİ" : `AYNI[${p.reason}]`} şablonYaw=${f(templateYaw)} selfieYaw=[${yaws.map(f).join(",")}] sıra=[${order.join(",")}] kazanç=${f(p.gain)} profilÇıkarılan=[${pf.dropped.join(",")}]`);
    if (pf.dropped.length) return order.map((i) => faces[i]);
    if (!p.swapped) return refUrls;
    return [...order.map((i) => faces[i]), ...refUrls.slice(faces.length)];
  } catch (e) {
    console.error("Poza göre referans sıralaması başarısız (sıra değişmedi):", e.message || e);
    return refUrls;
  }
}

// DÜZ BAŞ UYARISI DENENDİ, ALINMADI (2026-10-18, iş 10ee6a46 c5, kullanıcı:
// "dümdüz bakması gerekirken bakış yönü kaymış"). 111 karede şablon yaw <
// 0.25 olan 39 karenin ortalama sapması +0.20 (yarısı ≥ 0.2), profilde -0.02:
// model düz bakan başı sistematik olarak yana çeviriyor; selfie açıları bunu
// açıklamadı. Şablon yaw < 0.15 iken prompt BAŞINA "BASE HEAD FACES THE
// CAMERA SQUARELY ... do not turn it even slightly" eklendi. Yerel A/B (6
// cephe şablonu × 2, d44 selfie'leri): sapma ≥ 0.20 olan kare 3/12 → 1/12,
// AMA şapkalı şablonda (0ee c3) şapka 2/2 SİLİNDİ (eskide 2/2 duruyordu) ve
// elle tutulan gözlüklü şablonda (d87 c6) bir cam yüzde kaldı (1/2). Başa
// konan "kafayı yeniden kur" cümlesi, şapka/gözlük kurallarını bastırıyor.

function faceRefUrls(refUrls) {
  if (!Array.isArray(refUrls) || refUrls.length === 0) return [];
  return refUrls.slice(0, FACE_PHOTO_COUNT);
}

/** Poz seçimine aday tüm yüz selfie'leri (10'lu çekimde 10; eski işlerde 3/5). */
function poseCandidateRefUrls(refUrls) {
  if (!Array.isArray(refUrls) || refUrls.length === 0) return [];
  return refUrls.slice(0, MAX_FACE_PHOTOS);
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

/**
 * ÖNCEKİ DENEMENİN HATASINI MODELE SÖYLEYEN DÜZELTİCİ ÖN-EK (2026-09-09).
 *
 * GERÇEK OLAY: job 52781069 chunk 7 (5/5 red) ve db963457 chunk 5 (5/6 red)
 * — her denemede FARKLI şablon kullanıldığı hâlde model hep AYNI hataya
 * düştü: taban RIGHT/LEFT'e bakarken çıktının gözünü CAMERA'ya çekti.
 * Yani şablonu değiştirmek yetmiyor; modele "geçen sefer şunu yanlış
 * yaptın" denmediği sürece aynı önyargı tekrarlanıyor (eğitim verisinde
 * kameraya bakan yüz baskın).
 *
 * Bu ön-ek prompt'un EN BAŞINA konur — sistem/talimat metninde en çok
 * ağırlık verilen konum. Yalnızca retry'da (attempt > 1) ve yalnızca
 * önceki reddin sebebi biliniyorsa eklenir.
 */
// DÜZELTİRKEN BAŞKA ŞEYİ BOZMA (2026-09-15, ÖLÇÜLMÜŞ YAN ETKİ).
//
// Leke yasağı ilk üretimde çalışıyor ama retry'da bozuluyordu: yasak
// sonrası 11 artefakt reddinin yalnızca 2'si 1. denemede, 9'u RETRY'da
// çıktı. Sebep zincirleme: gaze reddinden sonra yapılan 9 retry'ın 5'inde
// (%56) yeni bir LEKE belirdi. Düzeltici uyarı modeli yüze odaklıyor, model
// o bölgeyi yeniden boyuyor ve boyarken düz bir yama bırakıyor.
//
// Bu ek, her düzeltici uyarının SONUNA konur: yalnızca söyleneni düzelt,
// gerisini olduğu gibi bırak. Tek bir kusuru düzeltirken yenisini üretmek
// ret döngüsünün asıl yakıtıydı.
const RETRY_DO_NO_HARM =
  "While you fix this, change NOTHING else. Keep the identity, framing, " +
  "pose, clothing, background and lighting exactly as they were. In " +
  "particular do not repaint the facial skin: leave it continuous and " +
  "evenly toned, with no flat grey or white patch, no straight-edged block " +
  "and no streak anywhere on the forehead, brows, nose, cheeks or chin. " +
  "Fix the one defect named above and leave the rest of the frame alone.\n\n";

function retryCorrectionPrefix(lastGate, gazeFacts = null, artifactWhere = null, yawFacts = null) {
  const body = retryCorrectionBody(lastGate, gazeFacts, artifactWhere, yawFacts);
  // Boş uyarıya ek koyma — uyarı yoksa ortada düzeltilecek bir şey de yok.
  return body ? body + RETRY_DO_NO_HARM : "";
}

// Yaw değeri (0 önden … 1 profil) için kısa tarif.
function yawWords(y) {
  if (y < 0.15) return "facing the camera almost straight on";
  if (y < 0.35) return "turned slightly to the side";
  if (y < 0.6) return "in a three-quarter view";
  return "close to profile";
}

function retryCorrectionBody(lastGate, gazeFacts = null, artifactWhere = null, yawFacts = null) {
  if (!lastGate) return "";
  const g = String(lastGate);
  if (g === "vision-gaze" || g === "iris-gaze") {
    // ÖLÇÜLEN YÖNÜ SÖYLE (2026-09-14). Eski metin her red için "gözü
    // kameraya çektin" DİYORDU — oysa gerçek retlerin çoğunda kusur bu
    // değil: taban sağa bakarken çıktı sola bakıyor, ikisi de kameraya
    // bakmıyor. Yanlış teşhis modele yanlış düzeltmeyi yaptırıyor ve aynı
    // hata tekrarlanıyor: son 40 işte 108 reddin 46'sı (%42.6) gaze ve
    // aynı chunk'ta 2 kez üst üste gaze reddi ALTI ayrı işte görüldü
    // (420fd8c6 c0/c5/c9, 7160f104 c7, 944d30fe c7, 0c609c0e c2 ...).
    //
    // Artık Vision'ın ÖLÇTÜĞÜ iki token prompt'a yazılıyor, böylece model
    // neyi yanlış yaptığını okuyor. Ölçüm yoksa eski genel metne düşülür.
    if (gazeFacts && gazeFacts.base && gazeFacts.out) {
      return (
        "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
        `In the base photo (FIRST image) the eyes look ${gazeFacts.base}. ` +
        `Your last render had them looking ${gazeFacts.out} instead — that is ` +
        "the defect, and repeating it fails again.\n" +
        `Your output MUST have the eyes looking ${gazeFacts.base}, matching the ` +
        "base exactly: the same side, the same angle, and the irises sitting " +
        "in the same corner of the eye opening. Look at the FIRST image again " +
        "and copy the iris position before you finish. Do not 'improve' the " +
        "pose, do not centre the eyes, and do not turn them toward the lens " +
        "unless the base itself looks at the lens.\n\n"
      );
    }
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render pointed the eyes somewhere other than where the base " +
      "person is looking. Before you finish, look at the FIRST image again " +
      "and copy the exact iris position inside each eye: whichever way the " +
      "base looks — to a side, down, away or at the lens — your output must " +
      "look the same way, at the same angle, with the irises in the same " +
      "corner of the eye opening. Do not 'improve' the pose and do not centre " +
      "the eyes.\n\n"
    );
  }
  if (g === "yaw-drift" || g === "yaw-to-camera" || g === "yaw-over-rotate" ||
      g === "yaw-under-rotate" || g === "yaw-pulled-to-camera" || g === "head-dx") {
    // YÖNE GÖRE UYARI (2026-10-08, 9d9507f0 c6/c9): eski metin her durumda
    // "kafayı kameraya çevirme" diyordu; oysa şablon önden bakarken model
    // kafayı YANA çevirmişti. Ölçülen göreli sapma (daha çok / daha az dönük)
    // söylenir — mutlak yön değil, o yanlış ölçülebiliyor (bkz.
    // gaze-tell-direction-upfront).
    if (yawFacts && yawFacts.tpl != null && yawFacts.out != null) {
      const more = yawFacts.out > yawFacts.tpl;
      return (
        "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
        `Your last render turned the head ${more ? "FURTHER AWAY from the camera" : "TOWARD the camera"} ` +
        `than the BASE person. In the BASE the head is ${yawWords(yawFacts.tpl)}; yours was ${yawWords(yawFacts.out)}. ` +
        "Copy the BASE head turn exactly: the nose points the same way by the same amount, the same cheek " +
        "and the same amount of each ear is visible, and the eyes look at the same point as in the BASE. " +
        "Ignore the selfies' head angle completely.\n\n"
      );
    }
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render changed the head angle. Keep the BASE person's head " +
      "turn exactly: same degree of profile, same tilt, same position on the " +
      "shoulders. Do not rotate the head toward the camera, do not straighten " +
      "it, do not re-centre it.\n\n"
    );
  }
  if (g === "head-ghost") {
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render left a faint trace of the BASE person around the new head: an outline " +
      "of their hair, head, face or glasses. Wherever the BASE person's hair, head or glasses " +
      "reached beyond the new head, draw only the background that belongs there, continuing " +
      "the surroundings. Nothing of the BASE person may remain, not even a see-through edge.\n\n"
    );
  }
  if (g === "limb-ghost") {
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render produced malformed hands. Render every visible hand " +
      "with the correct number of separate, clearly defined fingers, in sharp " +
      "focus, matching the base image's hand position exactly. Fused, " +
      "duplicated, blurred or missing fingers are an automatic failure.\n\n"
    );
  }
  if (g === "skin-tone" || g === "vision-skin") {
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render left the arms and hands a different tone from the " +
      "face. Apply the target's skin tone to EVERY visible piece of skin — " +
      "face, neck, chest, arms, hands — as one continuous tone.\n\n"
    );
  }
  if (g === "vision-artifact" || g === "face-artifact") {
    // ÖLÇÜLEN BÖLGEYİ SÖYLE (2026-09-14, gaze'deki aynı düzeltme).
    //
    // Kapı zaten "forehead and nose" gibi bir bölge üretiyor ama uyarı bunu
    // taşımıyordu; model genel bir "yüzde leke bırakma" cümlesi okuyup aynı
    // yere yine leke koyuyordu. İş 3db3ba68'de chunk 2 ve 8 ikişer kez üst
    // üste AYNI bölgeden (alın/burun) elendi. Bölge adı verilince model
    // düzeltmeyi nereye uygulayacağını biliyor.
    const where = artifactWhere && String(artifactWhere).trim();
    const whereSentence = where && !/^none$/i.test(where)
      ? `The defect was on the ${where} — look there first and render that ` +
        "area as clean, continuous skin.\n"
      : "";
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render left a patch on the face that did not belong to the " +
      "photograph — a flat grey/white block or smear sitting on the skin with " +
      "a hard edge.\n" +
      whereSentence +
      // DİKİŞ VURGUSU (2026-09-17): ölçüm bu kusurun yüzün KENARINDA
      // oluştuğunu gösterdi (yedi karede X=0.05..0.08 ve 0.93..0.95), yani
      // modelin düzenlemeyi bitirdiği sınırda. Genel "yüzü temiz çiz"
      // uyarısı bu sınırı adreslemiyordu.
      "This defect almost always sits where your edit ENDS — along the " +
      "hairline, the temples, the outer brows or the sides of the forehead. " +
      "Do not stop the edit at a hard line there: blend the new skin " +
      "outward into the hairline and temples so the boundary is invisible.\n" +
      "Render the facial skin as one continuous, evenly lit " +
      "surface with natural pores and tone across the whole face. No flat " +
      "blocks, no straight-edged areas, no washed-out regions on the " +
      "forehead, brows, cheeks, nose or chin.\n\n"
    );
  }
  if (g === "math-identity" || g === "vision-identity") {
    return (
      "PREVIOUS ATTEMPT WAS REJECTED — READ THIS FIRST.\n" +
      "Your last render did not look like the person in the selfies. Copy " +
      "their facial structure feature by feature: nose shape and width, eye " +
      "shape and spacing, eyebrow form, lip shape, jaw and cheekbone lines.\n\n"
    );
  }
  return "";
}

/**
 * İlk kare şablonun yönünden RESAMPLE_YAW_MIN kadar saptıysa bir kez daha
 * üretir ve chooseCandidate ile ikisinden birini döndürür. Ölçülemezse,
 * bütçe/süre yetmezse ya da ikinci üretim başarısızsa ilk kare döner.
 */
// İKİNCİ ÜRETİMLER KAPALI (2026-11-19, kullanıcı: "çok basit ve sade, fazlalıkları çıkar").
// Yön ikinci üretimi 3B reddinden sonra 7 denemede 1 kurtardı; YAW_FIX cümlesi 11-15/11-16'da
// gürültü ölçüldü; şapka ikinci üretimi bir günden kısa canlıydı, kanıtlı başarısı yok. Her biri
// ~$0.11 + 150 sn'ye kadar bekleme ve bütçe bekleme kodunun çoğunu sürüyordu. Kare her karede
// tek üretim; yön/şapka kapıları yalnız ELER (onay panelinde etiket). Geri dönüş: true.
const SECOND_GEN_ON = false;
// Şablon ten pigmenti (gpt-4.1-mini) yalnız yüz sahne ışığı (postTasks FINISH.FACE_TONE) içindi; o
// kapalıyken sorulmaz. FACE_TONE geri açılırsa bu da true yapılmalı.
// 2026-11-20: true. FACE_TONE 13:20'de açıldı, bu false kaldı → 64bff386'da siyahi şablonların koyu
// yüzü "loş ışık" sayıldı, kullanıcının yüzü ×0.73-0.89 karardı (log pigment[MST 5/?]).
const TPL_MST_FOR_FACE_TONE = true;
const YAW_FIX_ON = SECOND_GEN_ON;
// KARŞILIĞI OLMAYAN AÇIDA İKİNCİ ÜRETİM YOK (2026-11-16, kullanıcı onayı): selfie setinde
// şablon açısına çizilebilecek kare yoksa ikinci üretim aynı girdiyle aynı yöne sapıyor.
// Ölçüm (11-13..11-16, ilk kare 3B'den elenecekken yapılan ikinci üretimler): c1 (en yakın
// çizim 12.1°) 4 denemede 1 kurtarma, c9 (8.3°) 2 denemede 0; son işte ikisi de kötüleşti
// (11.4→14.6°, 14.5→19.3°). Yalnız ilk kare 3B kapıdan ZATEN elenecekse atlanır; geçecek
// karede eski akış aynen. Eşik: karşılığı olan şablonlar ≤5.4°, olmayanlar ≥8.3°.
// 0 = kapalı.
const UNREACHABLE_SKIP_DEG = 8;
// ŞAPKA KAPISI (2026-11-19, bkz. üretim döngüsü "ŞAPKA KAPISI"). Kapatmak için false.
const HAT_GATE_ON = true;
// ÜRETİM SONRASI KAPILAR KAPALI (2026-11-22, kullanıcı: "14 hariç diğerlerini üretim kısmından
// kaldıralım"). Onay akışında kare başına tek üretim (HOLD_MAX_ATTEMPTS 1) ve ikinci üretimler
// kapalı (SECOND_GEN_ON) olduğu için kapılar kareyi düzeltmiyor, yalnız "elendi" etiketi koyuyordu;
// 64bff386'da iki etiketin ikisi de Vision bakış satırındandı (c5 yanlış ret). Kapanan: kimlik/
// netlik/kafa oranı (assessOutputFace), yaw + 3B poz, zıt bakış, ten kapısı, Vision denetimi
// (~$0.16/iş gpt-4o), göz kapalı, yüz artefakt kırpımı, kafa konumu (dx), şapka kapısı. Her kare
// geçmiş sayılır ve onay paneline gider; geri yerleştirme (hizalama + dikiş kapısı, döngü sonrası)
// ve D bitirme adımları aynen çalışır. Kaybedilen: panelde kapı etiketi (kimlik kapısı engelli
// sınıftaydı, artık admin gözü tek güvence), POZ 3B ÖLÇÜM logu, eksik teslimde otomatik iade.
// Geri dönüş: true.
const OUTPUT_GATES_ON = false;

async function resampleIfYawDrifts(first, { templateYawSigned, templateYawUnsigned = null, templatePose3d = null, refDescriptor, styleId, chunkIdx, attempt, uid, jobId, regenerate, reachErr = null }) {
  const { headPoseOf } = require("./faceQuality");
  const tag = `style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}`;
  const f = (v) => (v == null || !isFinite(v) ? "null" : v.toFixed(2));
  const measure = async (b) => {
    const p = (await headPoseOf(b)) || (await headPoseOf(b, LOW_CONF_FACE));
    const s = p && p.yawSigned != null ? p.yawSigned : null;
    return { b, s, drift: s != null ? Math.abs(s - templateYawSigned) : Infinity };
  };
  // 3B fazla dönme (YAW KAPISI'nın aynı kuralı, yawOver3d): yalnız yerel ağ, API yok.
  const gate3d = async (r) => {
    // Şablon ağla ölçülemediyse/profildeyse kapı 3B kullanmaz → ölçüm boşa (süre).
    if (!templatePose3d || templatePose3d.src !== "mesh" || !Number.isFinite(templatePose3d.yaw) ||
      Math.abs(templatePose3d.yaw) > YAW3D_MAX_ABS) return;
    let op3 = null;
    try { op3 = await require("./headPose3d").headPose3dOf(r.b); } catch (e) { console.error("3B poz ölçümü (ikinci üretim) başarısız:", e.message || e); }
    const g = yawOver3d(templatePose3d, op3);
    r.over3d = g.over;
    r.d3 = g.d;
    r.y3 = op3 && Number.isFinite(op3.yaw) ? op3.yaw : null;
  };
  try {
    const a = await measure(first);
    const minDrift = Math.abs(templateYawSigned) < TWO_CANDIDATE_YAW_MAX ? RESAMPLE_YAW_MIN : RESAMPLE_YAW_MIN_ANGLED;
    if (a.s == null || a.drift < minDrift) return first;
    if (jobTimeLeftMs() < GEN_ATTEMPT_MIN_LEFT_MS) {
      console.log(`YÖN İKİNCİ ÜRETİM (${tag}): ATLANDI[süre] şablon=${f(templateYawSigned)} yön=${f(a.s)}`);
      return first;
    }
    if (UNREACHABLE_SKIP_DEG > 0 && Number.isFinite(reachErr) && reachErr >= UNREACHABLE_SKIP_DEG) {
      await gate3d(a);
      if (a.over3d) {
        console.log(`YÖN İKİNCİ ÜRETİM (${tag}): ATLANDI[selfie-açısı-yok] şablon=${f(templateYawSigned)} yön=${f(a.s)} Δ3B=${f(a.d3)} enYakınÇizim=${reachErr.toFixed(1)}° eşik=${UNREACHABLE_SKIP_DEG}°`);
        return first;
      }
    }
    const angled = minDrift === RESAMPLE_YAW_MIN_ANGLED;
    if (angled) {
      // ELENECEK KARE ÖNCE (2026-11-13, e67abb0e c5/c7 ve 41589067 c7): düz şablon
      // payı (0.20) sınırı $0.002-0.016 farkla aştırıp ikinci üretimi kapattı; o anda
      // bekleyen düz kare yoktu, iş $0.30-0.41 boş bitti, üç kare de 3B fazla dönmeden
      // elendi (onay akışında yeniden deneme yok → kare kayıp). İlk kare 3B kapıdan
      // ZATEN elenecekse pay ANGLED_REJECT_HEADROOM_USD'ye iner; geçecekse eski kural.
      // İş sınırı (takeSlot) aynen geçerli.
      if (a.over3d === undefined) await gate3d(a);
      // EKSİK DÖNME DE ELENECEK SAYILIR (2026-11-19, 6a02687c c2): ilk kare yaw
      // kapısında RED[yaw-under-rotate] aldı (şablon 0.88 → 0.55) ama burada yalnız
      // 3B fazla dönmeye bakıldığı için pay 0.20 istendi, ikinci üretim atlandı ve
      // iş $0.25 boş bitti. Kapıyla aynı ölçü (headYawOf, işaretsiz) ve aynı kural.
      if (!a.over3d && templateYawUnsigned != null) {
        try {
          const { headYawOf } = require("./faceQuality");
          const u = (await headYawOf(a.b)) ?? (await headYawOf(a.b, LOW_CONF_FACE));
          a.under = require("./headBodyGate").isUnderRotated(templateYawUnsigned, u);
        } catch (e) { a.under = false; }
      }
      const willReject = !!(a.over3d || a.under);
      const headroom = willReject ? ANGLED_REJECT_HEADROOM_USD : ANGLED_RESAMPLE_HEADROOM_USD;
      const L0 = ledgerSummary();
      const fits = () => !L0 || L0.spentUsd + L0.reservedUsd + EST_RESAMPLE_USD + headroom <= L0.limitUsd;
      // ELENECEK KARE BEKLER (2026-11-19, 6a02687c c2): o anda diğer karelerin
      // zorunlu payları (0.13/kare) henüz serbest değildi, iş sonunda $0.25 boş kaldı.
      // Kare zaten elenecekse paylar boşalana dek (süre sınırı içinde) beklenir;
      // mutlak tavan (hardCapAllows) çağrı öncesi yine denetler.
      if (willReject && !fits()) {
        const t0 = Date.now();
        while (!fits() && Date.now() - t0 + 3000 <= RESAMPLE_WAIT_MAX_MS && jobTimeLeftMs() >= GEN_ATTEMPT_MIN_LEFT_MS) {
          await new Promise((r) => setTimeout(r, 3000));
        }
        if (fits()) console.log(`YÖN İKİNCİ ÜRETİM (${tag}): elenecek kare, pay için ${Math.round((Date.now() - t0) / 1000)}sn beklendi`);
      }
      if (!fits()) {
        L0.skipped++;
        console.log(`YÖN İKİNCİ ÜRETİM (${tag}): ATLANDI[düz-şablon-payı] şablon=${f(templateYawSigned)} yön=${f(a.s)} kapı3B=${a.over3d ? "red" : "geçer"} eksikDönme=${a.under ? "red" : "geçer"} Δ3B=${f(a.d3)} harcanan=${L0.spentUsd.toFixed(3)} ayrılan=${L0.reservedUsd.toFixed(3)} sınır=${L0.limitUsd.toFixed(2)}`);
        return first;
      }
    }
    const { slot, waitedMs } = angled
      ? { slot: tryReserveOptional(EST_RESAMPLE_USD), waitedMs: 0 }
      : await waitReserveOptional(EST_RESAMPLE_USD, {
        maxWaitMs: RESAMPLE_WAIT_MAX_MS,
        keepWaiting: () => jobTimeLeftMs() >= GEN_ATTEMPT_MIN_LEFT_MS,
      });
    if (!slot) {
      const L = ledgerSummary();
      const led = L ? ` harcanan=${L.spentUsd.toFixed(3)} ayrılan=${L.reservedUsd.toFixed(3)} sınır=${L.limitUsd.toFixed(2)}` : "";
      console.log(`YÖN İKİNCİ ÜRETİM (${tag}): ATLANDI[maliyet-bütçesi] bekleme=${Math.round(waitedMs / 1000)}sn şablon=${f(templateYawSigned)} yön=${f(a.s)}${led}`);
      return first;
    }
    if (waitedMs > 0) console.log(`YÖN İKİNCİ ÜRETİM (${tag}): bütçe ${Math.round(waitedMs / 1000)}sn beklendi`);
    let second, fix = null;
    try {
      // Maliyet yalnız bu slottan: chunk'ın zorunlu payı sonraki Vision'a kalır (runOptional).
      // YÖN DÜZELTMESİ: ilk kare 3B kapıdan elenecekse ikinci üretime ölçülen fazla dönüş yazılır.
      if (YAW_FIX_ON && templatePose3d && a.over3d === undefined) await gate3d(a);
      fix = YAW_FIX_ON && a.over3d && Number.isFinite(a.d3) && Number.isFinite(a.y3)
        ? { over: a.d3, side: a.y3 > 0 ? "right" : "left" } : null;
      second = await runOptional(() => regenerate(fix));
    } finally {
      slot.release();
    }
    if (!second) {
      console.warn(`YÖN İKİNCİ ÜRETİM (${tag}): üretim başarısız, ilk kare kullanılıyor`);
      return first;
    }
    const b = await measure(second);
    const rows = [a, b];
    for (const r of rows) r.dist = await identityDistanceOf(r.b, refDescriptor);
    // Seçim 3B kapıyı da bilsin (chooseCandidate: kapıyı geçen aday önce).
    if (templatePose3d) for (const r of rows) if (r.over3d === undefined) await gate3d(r);
    const k = chooseCandidate(rows);
    // EŞİK AYARI İÇİN KAYIT (2026-10-19, kullanıcı isteği): iki üretim de
    // saklanır (dosya adında seçilen işaretli); eşik gerçek örneklerle ayarlanacak.
    if (DEBUG_SAVE_RESAMPLE && uid && jobId) {
      rows.forEach((r, i) => bucket()
        .file(`dating_debug/resample/${uid}/${jobId}/c${chunkIdx}_a${attempt}_${i + 1}${i === k ? "_secilen" : ""}_yon${f(r.s)}_sablon${f(templateYawSigned)}.jpg`)
        .save(r.b, { metadata: { contentType: "image/jpeg" } })
        .catch((e) => console.error("YÖN İKİNCİ ÜRETİM: kayıt başarısız (atlanıyor):", e.message || e)));
    }
    console.log(`YÖN İKİNCİ ÜRETİM (${tag}): düzeltme=${fix ? `${Math.round(fix.over)}°${fix.side === "left" ? "sol" : "sağ"}` : "yok"} seçilen=${k + 1} şablon=${f(templateYawSigned)} yön=[${rows.map((r) => f(r.s)).join(",")}] sapma=[${rows.map((r) => f(r.drift)).join(",")}] kimlik=[${rows.map((r) => f(r.dist)).join(",")}] Δ3B=[${rows.map((r) => f(r.d3)).join(",")}] kapı3B=[${rows.map((r) => (r.over3d == null ? "-" : r.over3d ? "red" : "geçer")).join(",")}]`);
    return rows[k].b;
  } catch (e) {
    console.error(`YÖN İKİNCİ ÜRETİM (${tag}) hata verdi, ilk kare kullanılıyor:`, e.message || e);
    return first;
  }
}

// swapRefs: base'e hazırlanmış referans sayısı (bkz. naturalSwap.js; 0 = hazırlanamadı).
async function generateForMode(mode, templateUrl, refUrls, identityCaption, bodyProfile, styleId, chunkIdx, refDescriptor, retryHint = "", imageModel = OPENAI_MODEL_ID, swapRefs = 0, swapOpts = {}) {
  const faceUrls = faceRefUrls(refUrls);
  const bestFaceUrl = faceUrls[0];
  // Taban + yüz açıları. Kafa ölçeği artık yalnızca tabandan okunuyor.
  const fullSet = [templateUrl, ...faceUrls];
  const promptBuilders = {
    [PHOTO_MODE_P300]: buildEditPromptP300,
    [PHOTO_MODE_SHORT]: buildEditPromptShort,
    [PHOTO_MODE_P800]: buildEditPromptP800,
    [PHOTO_MODE_P1400]: buildEditPromptP1400,
    [PHOTO_MODE_COMPACT]: buildEditPromptCompact,
  };
  const build = promptBuilders[mode] || buildEditPrompt; // varsayılan: tam prompt

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
      retryHint + buildStage1Prompt(identityCaption, bodyProfile),
      fullSet,
      imageModel
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
      [cur, templateUrl, bestFaceUrl],
      imageModel
    );
    if (!s2) {
      console.warn(`Pipeline aşama 2 başarısız, önceki çıktıyla devam (style=${styleId}, chunk=${chunkIdx})`);
    } else {
      ({ buf: cur, dist: curDist } = await acceptStageIfIdentityHolds(
        cur, curDist, s2, refDescriptor, "2", styleId, chunkIdx));
    }

    const s3 = await generateWithOpenAI(
      buildStage3Prompt(),
      [cur, bestFaceUrl],
      imageModel
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
  // retryHint EN BAŞA: önceki denemenin somut hatası, genel talimatlardan
  // önce okunsun (bkz. retryCorrectionPrefix gerekçesi).
  // AÇI REHBERİ GERİ ALINDI (2026-10-08, kullanıcı kararı): şablonun kafa
  // kırpımını ek görsel olarak vermek bakışı düzeltmedi (9d9507f0 c9: bakış
  // tamamen yanlış). Tekrar denemeden önce o işin karelerine bak.
  // DOĞAL YER DEĞİŞTİRME (2026-11-01, bkz. naturalSwap.js): referans base'in
  // açı/bakış/ifadesine hazırlandıysa kısa "kişiyi değiştir" talimatı; yoksa P800.
  const prompt = retryHint + (swapRefs > 0 && mode === PHOTO_MODE_P800
    ? require("./naturalSwap").buildNaturalSwapPrompt(Math.min(swapRefs, faceUrls.length), { prepared: !SELFIE_SET_ALL, hat: !!(swapOpts && swapOpts.hat), pose: (swapOpts && swapOpts.pose) || null, eyewear: !!(swapOpts && swapOpts.eyewear) })
    : build(identityCaption, bodyProfile));
  return await generateWithOpenAI(prompt, fullSet, imageModel);
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

// YENİDEN DENEMEDE ŞABLON TIRMANMASI (2026-09-22).
//
// GERÇEK OLAY (iş 0150e03a, chunk 2): denemeler sırasıyla 0.224 -> 0.147 ->
// 0.254 yüz oranlı şablonlarla yapıldı. Teslim edilen kare 3. denemeden
// geldi ve kullanıcı "kafa çok büyük" diye işaretledi. Model hata yapmamıştı
// — büyüme 0.96, yani şablona SADIK kalmıştı. Kusur şablon seçimindeydi:
// yedek, ilk şablondan belirgin daha büyük kafalı bir kareydi.
//
// KURAL: yalnızca YENİDEN DENEMEDE ve yalnızca BÜYÜK BANDA tırmanırken
// devreye girer — yedeğin yüz oranı hem 0.20'nin hem de ilk şablonun
// üstündeyse o yedek atlanır, sıradaki denenir.
//
// İLK DENEME BİLEREK MUAF: 2026-09-22 verisinde en büyük yüz oranlı üç kare
// (0.292 / 0.270 / 0.264) İLK denemeden geldi ve üçü de gözle sorunsuzdu.
// Yani "büyük yüzlü şablon" tek başına kötü değil; kötü olan, bir retry'nin
// kadrajı sessizce büyütmesi. Bu yüzden kural mutlak bir üst sınır DEĞİL.
//
// ATLANAN ŞABLON ÇÖPE GİTMEZ: hiç uygun aday kalmazsa atlananların EN KÜÇÜK
// yüz oranlısı kullanılır — "her denemede yeni şablon" davranışı korunur,
// aksi halde chunk aynı şablonda sıkışırdı (bkz. "YENİDEN DENEME = YENİ
// ŞABLON" notu).
const TEMPLATE_RETRY_LARGE_FACE_RATIO = 0.20;

// ŞABLON SAÇI ÖN TEMİZLİĞİ (2026-10-27, e25dc241, bkz. templateHair.js).
// Doğrulama (kullanıcının saçı düzgün çıkmış 5 karesi selfie yerine, aynı
// P800 prompt'u, c1/c2/c9 şablonları): üçünde de saç selfiedeki gibi tam ve
// opak, şablonun saç kalıbı/alnı yok; baş yönü şablona 0.04-0.11 (e25
// teslimleri 0.29-0.51 sapmıştı).
// KAFATASI (2026-10-27, kullanıcı: "kafa çok büyük ve önde"): saç yerine
// yalnız zemin konunca model kafayı aşağı indirdi ya da sahneyi yeniden
// kadrajladı (c1 iki testte, c9 çene 0.32). Kel kafatası bırakınca (bkz.
// templateHair ERASE_FILL) kısa saçta c1 çene 0.05 / yüz 0.95, c9 0.02 / 1.03;
// kıvırcıkta c2 0.007 / 0.90 — saç yine selfiedeki gibi tam ve opak.
// SADE AKIŞTA kapalı (60d42504 c3: kafanın arkası silinmiş): model şablonun
// kafasını olduğu gibi görür, boyu ve yeri oradan okur.
// 2026-11-03 GERİ AÇILDI (80fc7ec4 c0/c2/c5, kullanıcı: "saç üstü silüet
// olmaması lazım … kesin olarak en sade ve kolay şekilde maliyeti olmadan"):
// ham model çıktısında base saçı yarı saydam hayalet olarak duruyordu; sonradan
// temizlik (ghostClean) c0'da büyük LaMa dolgusuyla bulanık leke + kesik kafa
// tepesi bıraktı. Model base saçını hiç görmezse kalıp kopyalanamaz (API yok,
// LaMa yerel). Saçı silinen chunk'ta ghostClean atlanır. Bilinen risk: 60d42504
// c3 "kafanın arkası silinmiş" (10-29'da kapatılma sebebi).
// 2026-11-03 (Cursor, kullanıcı: "direkt aynı şey yapılıyorsa bu riskin
// alınmaması lazım"): tam silme 60d42504 c3/c5 şablonlarında yerelde yeniden
// denendi, kafatası tahmini yine enseyi gökyüzüne çevirdi → KAPALI kalıyor.
// Yerine KIRPMA (TEMPLATE_HAIR_TRIM, bkz. templateHair.trimTemplateHair):
// yalnız beklenen kullanıcı kafasının dışına taşan şablon saçı silinir, kafanın
// içine ve yüz çevresine dokunulmaz; kafatası tahmini yok.
const TEMPLATE_HAIR_ERASE = false;
// 2026-11-04 KIRPMA DA KAPATILDI (inceleme + deploy öncesi doğrulama, 80 kare
// yerelde): kırpma dönük/aşağı bakan şablonlarda kafanın arkasını/tepesini düz
// kesiyordu (7e0 c3, 7e0 c0, b932 c3/c0); poz kapıları eklendikten sonra da
// önden şablonlarda iki kare kesildi (b93 c7 tepe düz, 80f c0 ense basamak).
// Hiç kesmeyen sıkı kapılarda 80 karenin yalnız 6'sı kırpılıyor ve yalnız
// birinde görünür fark var — fayda yok, risk var. Kullanıcı: "direkt aynı şey
// yapılıyorsa bu riskin alınmaması lazım". Kapalıyken orijinal şablon gider,
// saç silüeti için ghostClean (simpleFinish) çalışır (11-03 gecesi öncesi akış).
const TEMPLATE_HAIR_TRIM = false;
// Selfie'ler arası kimlik kapısı ret verir mi (bkz. HAZIRLIK KİMLİK). Kapalı:
// eşik 0.72 başka kişiyi ayırmıyor, yalnız log.
const SELFIE_IDENTITY_REJECT = false;
// Kırpma kapıları (dönük/aşağı bakan şablon, selfie açı farkı, pay):
// bkz. templateHair.TRIM_GATE (2026-11-04 inceleme).

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
    // ŞABLON NETLİĞİ — YALNIZCA ÖLÇÜM (2026-09-22).
    //
    // NEDEN GÖRECELİ: çıktının netlik kapısı mutlak (BLUR_VARIANCE_MIN=25) ve
    // fiilen ölü — 2026-09-22'de en bulanık kare bile 103 ölçtü. Ama kullanıcı
    // o gün netlik=200 civarındaki iki kareyi "netlik bozuk" diye işaretledi.
    // Mutlak eşiği yukarı çekmek TUZAK: Laplacian varyansı sahneye bağlı,
    // yumuşak ışıklı/bokeh'li bir şablon doğal olarak düşük değer verir.
    // Anlamlı olan, çıktının KENDİ ŞABLONUNA göre ne kadar yumuşadığı.
    // Bu yüzden şablonun netliği de ölçülüp KALITE ÖLÇÜM satırına yazılıyor.
    // Şimdilik hiçbir kareyi elemez; eşik ancak dağılım birikince konulabilir.
    //
    // ÖLÇÜM ÜRETİME GİDEN TUVALDE yapılır (kırpıldıysa kırpılmış olanda),
    // çünkü çıktı o kadrajda üretiliyor ve karşılaştırma ancak öyle adil olur.
    const blurOf = async (b) => {
      if (SIMPLE_PIPELINE) return null; // yalnız log; sade akışta ölçülmez
      try {
        const { assessImageQuality } = require("./faceQuality");
        return (await assessImageQuality(b)).blurScore;
      } catch (e) {
        console.error("Şablon netlik ölçümü başarısız (atlanıyor):", e.message || e);
        return null;
      }
    };

    if (face.ratio >= TEMPLATE_MIN_FACE_RATIO) {
      const blurScore = await blurOf(buf);
      console.log(`ŞABLON OK (style=${styleId}, chunk=${chunkIdx}): yüzOranı=${face.ratio.toFixed(3)} netlik=${blurScore != null ? blurScore.toFixed(1) : "null"} — kırpma gerekmiyor`);
      // sourceBuf: kırpma YAPILMADIĞINDA `input` bir URL STRING'idir (üretim
      // API'si URL kabul ettiği için bilinçli). Ama ten rengi kapısı taban
      // görselin PİKSELLERİNE ihtiyaç duyuyor ve string'i sharp'a verince
      // "Input file is missing" ile patlıyordu (2026-08-09 canlı log). Buffer
      // burada zaten indirilmişti, atmak yerine ölçüm için taşınıyor.
      return { ...noCrop, faceRatio: face.ratio, sourceBuf: buf, blurScore };
    }

    const { cropForFaceRatio, computeFaceCropGeometry } = require("./postProcess");
    // Kırpma kişinin içinden geçmesin (bkz. postProcess.fitCropToPerson).
    let personBox = null;
    try {
      const { mainPersonBox } = require("./sceneRestore");
      personBox = await mainPersonBox(buf, face.box);
    } catch (e) {
      console.error("Şablon kişi kutusu ölçülemedi (kırpma genişletilmeyecek):", e.message || e);
    }
    const [cropped, geo] = await Promise.all([
      cropForFaceRatio(buf, face.box, face.ratio, TEMPLATE_TARGET_FACE_RATIO, personBox),
      computeFaceCropGeometry(buf, face.box, face.ratio, TEMPLATE_TARGET_FACE_RATIO, personBox),
    ]);
    if (!cropped || !geo) {
      return { ...noCrop, faceRatio: face.ratio, sourceBuf: buf, blurScore: await blurOf(buf) };
    }
    const croppedBlur = await blurOf(cropped);
    // Kişiye sığdırma kırpmayı genişlettiyse etkin yüz oranı hedefin altındadır.
    const effRatio = face.ratio * geo.imgW / geo.cropW;
    console.log(`ŞABLON KIRPILDI (style=${styleId}, chunk=${chunkIdx}): yüzOranı ${face.ratio.toFixed(3)} -> ${effRatio.toFixed(3)} (hedef ${TEMPLATE_TARGET_FACE_RATIO}${geo.fitted ? ", kişiye sığdırıldı" : ""}) netlik=${croppedBlur != null ? croppedBlur.toFixed(1) : "null"}`);
    // Kırpma sonrası ETKİN oran hedeftir — kalite kapısı kırpılmış tuvale
    // baktığı için karşılaştırma da onunla yapılmalı.
    return {
      input: cropped, restore: { originalBuf: buf, geo },
      usable: true, faceRatio: effRatio,
      blurScore: croppedBlur,
    };
  } catch (e) {
    console.error("Şablon hazırlama başarısız (orijinal kullanılıyor):", e.message || e);
    return noCrop;
  }
}

async function runOpenAiDirectChunk(uid, jobId, styleId, chunkIdx, templateUrls, refUrls, identityCaption, bodyProfile, refDescriptor, jobRef, mode = PHOTO_MODE_FULL, refEyeOpenness = null, refSkinTone = null, refHasFaceShine = false, holdForApproval = false, imageModel = OPENAI_MODEL_ID, templateNames = null, refSkinLight = null, refSkinMst = null) {
  // KUYRUK HEARTBEAT (2026-09-10 gerçek olay): aynı kullanıcı üst üste iki
  // job başlattığında, her ikisinin chunk'ları AYNI process-içi
  // OPENAI_IMAGE_MAX_CONCURRENCY (=2) kuyruğunu paylaşıyor. Kuyrukta bekleyen
  // (acquireOpenAiImageSlot içinde bekleyen) bir chunk hiçbir log yazmaz ve
  // aşağıdaki attempt-döngüsü heartbeat'ine (satır ~3170) hiç girmez — çünkü
  // döngü henüz başlamamıştır. Sonuç: updatedAt 5+ dakika bayatlar,
  // cleanupStuckGenJobs işi "takılı" sanıp öldürür, kullanıcı iki kez üst üste
  // "Zaman aşımı" alır (gerçek örnek: iki job aynı anda 20 chunk'ı 2 slotta
  // paylaştı, ikisi de öldü). Bu interval, kuyrukta geçirilen süre dahil
  // fonksiyonun TÜM ömrü boyunca çalışır — attempt döngüsünün varlığından
  // bağımsızdır. Fire-and-forget: hata sessizce yutulur, üretimi bloklamaz.
  // CHUNK BAZLI KALP ATIŞI (2026-11-04): iş dokümanının updatedAt'i tüm
  // chunk'ların ortak nabzı; tek bir chunk canlıyken diğerlerinin öldüğü
  // görülemiyordu. Her chunk kendi kaydına startedAt + lastHeartbeatAt yazar;
  // cleanupStuckGenJobs bu alanlarla chunk'ı TEK BAŞINA kapatabilir (bkz.
  // CHUNK_HEARTBEAT_STALE_MS). Hatalar yutulur, üretimi bloklamaz.
  // Nabız, iş defterindeki o ana kadarki harcamayı (costUsd, MUTLAK değer)
  // da taşır: fonksiyon zaman aşımında ya da çökmede harcama en fazla bir
  // nabız aralığı geride kalır. Çağrı başına ayrı yazım yapılmaz — 30
  // chunk'lık işte aynı doküman finalizeChunk transaction'larıyla çakışırdı.
  const ledger = ledgerSummary();
  const chunkBeat = (extra = {}) => jobRef.set({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(ledger ? { costUsd: Number(ledger.spentUsd.toFixed(4)) } : {}),
    results: { [styleId]: { chunks: { [String(chunkIdx)]: {
      lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(), ...extra,
    } } } },
  }, { merge: true }).catch(() => {});
  chunkBeat({ startedAt: admin.firestore.FieldValue.serverTimestamp() });
  // NABIZ SÜRE DOLUNCA DURUR (2026-11-18, 156fa173 c0): istek 900 sn'de
  // kapandıktan sonra örnek yaşamaya devam etti, asılı chunk nabız atmayı
  // sürdürdü ve temizlik onu "canlı" sanıp iş %97'de kaldı. İşin süresi
  // dolunca nabız kesilir; chunk hâlâ bitmediyse temizlik onu kapatır.
  const leftAtStart = jobTimeLeftMs();
  const beatUntil = Date.now() + (Number.isFinite(leftAtStart) ? leftAtStart + JOB_FINALIZE_RESERVE_MS : JOB_TIME_LIMIT_MS);
  const heartbeatTimer = setInterval(() => {
    if (Date.now() > beatUntil) {
      clearInterval(heartbeatTimer);
      console.warn(`NABIZ DURDU (style=${styleId}, chunk=${chunkIdx}): iş süresi doldu, chunk hâlâ bitmedi`);
      return;
    }
    chunkBeat();
  }, 90 * 1000);
  try {
    return await runOpenAiDirectChunkInner(uid, jobId, styleId, chunkIdx, templateUrls, refUrls, identityCaption, bodyProfile, refDescriptor, jobRef, mode, refEyeOpenness, refSkinTone, refHasFaceShine, holdForApproval, imageModel, templateNames, refSkinLight, refSkinMst);
  } finally {
    clearInterval(heartbeatTimer);
    releaseMandatoryReserve();
    CHUNK_TEMPLATE.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
    CHUNK_RESTORE.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
    CHUNK_LAST_REJECTED.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
    CHUNK_HAIR_ERASED.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
    CHUNK_FINISH_REGRESSED.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
  }
}

/**
 * KÜÇÜLTME SONRASI KALINTI: önce şablon kişisinin izi (judgeHeadGhost), o
 * temizse küçültme öncesi kareyle karşılaştırıp eski büyük kafanın izi
 * (judgeScaleResidue — 2026-10-16, c29a2b31 c1: saçın üstünde koyu yarı
 * saydam başlık kaldı, ilk soru "yok" dedi). FAIL-SAFE: hata/okunamayan
 * cevap elemez. Döner judgeHeadGhost biçimi ya da null.
 */
async function judgeScaledHead(out, tpl, preBuf) {
  try {
    const { judgeHeadGhost, judgeScaleResidue } = require("./headGhost");
    const { detectMainFace } = require("./faceQuality");
    const fd = (await detectMainFace(out)) || (await detectMainFace(out, LOW_CONF_FACE));
    if (!fd || !fd.box) return null;
    const ghost = await judgeHeadGhost(out, tpl, fd.box, OPENAI_KEY.value());
    if ((ghost && ghost.ok && ghost.bad) || !Buffer.isBuffer(preBuf)) return ghost;
    const res = await judgeScaleResidue(out, preBuf, fd.box, OPENAI_KEY.value());
    if (res && res.ok && res.bad) return { ...res, where: `küçültmeİzi-${res.where}` };
    return ghost && ghost.ok ? ghost : res;
  } catch (e) {
    console.error("OpenAI yolu: küçültme sonrası kalıntı kontrolü hata verdi (atlanıyor):", e);
    return null;
  }
}

async function runOpenAiDirectChunkInner(uid, jobId, styleId, chunkIdx, templateUrls, refUrls, identityCaption, bodyProfile, refDescriptor, jobRef, mode = PHOTO_MODE_FULL, refEyeOpenness = null, refSkinTone = null, refHasFaceShine = false, holdForApproval = false, imageModel = OPENAI_MODEL_ID, templateNames = null, refSkinLight = null, refSkinMst = null) {
  const maxAttempts = holdForApproval ? HOLD_MAX_ATTEMPTS : OPENAI_DIRECT_MAX_ATTEMPTS;
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
  // İlk denemede kullanılan şablonun yüz oranı — yedeklerin buna göre
  // "tırmanıp tırmanmadığı" ölçülür (bkz. TEMPLATE_RETRY_LARGE_FACE_RATIO).
  let baselineTemplateFaceRatio = null;
  const prepareNextUsable = async ({ avoidEscalation = false } = {}) => {
    const skipped = [];
    while (nextCandidate < urls.length) {
      const p = await prepareTemplate(urls[nextCandidate], styleId, chunkIdx);
      p.idx = nextCandidate++;
      if (!p.usable) continue;
      const tooBig = avoidEscalation &&
        baselineTemplateFaceRatio != null &&
        p.faceRatio != null &&
        p.faceRatio > TEMPLATE_RETRY_LARGE_FACE_RATIO &&
        p.faceRatio > baselineTemplateFaceRatio;
      if (tooBig) {
        console.log(
          `ŞABLON ATLANDI (style=${styleId}, chunk=${chunkIdx}): yedeğin yüz oranı ` +
          `${p.faceRatio.toFixed(3)} — hem ${TEMPLATE_RETRY_LARGE_FACE_RATIO} üstünde hem de ilk ` +
          `şablondan (${baselineTemplateFaceRatio.toFixed(3)}) büyük, kadrajı büyütmemek için sıradaki deneniyor`
        );
        skipped.push(p);
        continue;
      }
      return p;
    }
    // Hiç uygun aday kalmadı: atlananların EN KÜÇÜK yüz oranlısına dön.
    // Boş dönmek, chunk'ı aynı şablonda sıkıştırırdı.
    if (skipped.length) {
      skipped.sort((a, b) => (a.faceRatio ?? 1) - (b.faceRatio ?? 1));
      return skipped[0];
    }
    return null;
  };

  let prepared = await prepareNextUsable();
  if (!prepared) {
    console.warn(`ŞABLON: hiçbir aday uygun değil (style=${styleId}, chunk=${chunkIdx}) — birincil ile devam ediliyor`);
    prepared = await prepareTemplate(urls[0], styleId, chunkIdx);
    prepared.idx = 0;
  }
  // Kullanılan şablonun Storage adı (templateNames urls ile aynı sırada).
  const noteTemplate = (idx) => {
    const name = Array.isArray(templateNames) ? templateNames[idx] : null;
    if (name) CHUNK_TEMPLATE.set(chunkTemplateKey(jobId, styleId, chunkIdx), name);
    else CHUNK_TEMPLATE.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
  };
  noteTemplate(prepared.idx);
  let {
    input: templateInput, restore, faceRatio: templateFaceRatio,
    sourceBuf: templateSourceBuf, blurScore: templateBlurScore,
  } = prepared;
  const noteRestore = () => {
    const key = chunkTemplateKey(jobId, styleId, chunkIdx);
    if (restore) CHUNK_RESTORE.set(key, { ...restore, cropBuf: Buffer.isBuffer(templateInput) ? templateInput : null });
    else CHUNK_RESTORE.delete(key);
  };
  noteRestore();
  baselineTemplateFaceRatio = templateFaceRatio ?? null;

  // Şablonun yaw'ı (yana dönüklüğü) — YAW KAPISI için şablon başına BİR KEZ
  // ölçülür. undefined = henüz ölçülmedi; null = ölçülemedi (kapı devre dışı).
  // Şablon değişirse aşağıda undefined'a döndürülür ki yeniden ölçülsün.
  let templateYaw;
  // İşaretli, eğiklikten bağımsız yön (bkz. faceQuality.signedYawFromLandmarks);
  // templateYaw ile birlikte ölçülür ve sıfırlanır.
  let templateYawSigned = null;
  // Şablonun 3B pozu (derece, bkz. headPose3d) — templateYaw ile birlikte.
  let templatePose3d = null;
  // Şablonun bakış/kapak/yatıklık/ağız ölçüsü (bkz. refMatch) — templatePose3d ile birlikte.
  let templateRefMatch = null;
  // Şablon şapka tespiti sözü (bkz. templateHatOf) — templatePose3d ile birlikte.
  let templateHatP = null;
  // Prompta giden base pozu (açılar + çene yeri + yüz eni, bkz. basePromptPose) — templatePose3d ile birlikte.
  let templatePromptPose = null;
  // Şablon bilgi tablosu kaydı (bkz. templateMetaFor) — templatePose3d ile birlikte.
  let templateMeta = null;
  // Şablon iris ölçümü (ZIT BAKIŞ kapısı) — templateYaw gibi şablon başına bir kez.
  let templateIris;
  let templateEyeGlass; // ZIT BAKIŞ: şablon gözünde gözlük payı (bkz. gazeGate.IRIS_TPL_GLASS_SKIP)
  let templateEyeGlassP = null; // aynı ölçü, üretimden önce başlatılır (bkz. EYEWEAR_GAZE_PROMPT_ON)
  // Şablon gözlük yargısı (headGhost.judgeEyewear) üretimden önce; bitirmedeki GÖZLÜK adımı aynısını kullanır.
  let templateEyewearPreP = null;
  let templateEyewearPre = null;
  let finalBuf = null;
  // Modele giden taban (saçı silinmiş kopya) ve hangi şablon için hazırlandığı.
  let genTemplateInput = null;
  let genTemplateFor;
  // SON REDDİN SEBEBİ — bir sonraki denemenin prompt'una düzeltici uyarı
  // olarak geçer (bkz. retryCorrectionPrefix). Şablon değiştirmek tek
  // başına yetmiyor: model aynı önyargıyı (gözü kameraya çekme) farklı
  // şablonda da tekrarlıyordu.
  let lastRejectGate = null;
  // YÜZ ONARIMI BÜTÇESİ — chunk başına sayılır (2026-09-18, eskiden tek
  // seferlikti). Gerekçe ve ölçüm: ARTIFACT_REPAIR_MAX_PER_CHUNK başlığı.
  let artifactRepairsUsed = 0;
  // AYNI KAPI TEKRAR SAYACI (2026-09-13). gate -> o kapıdan kaç kez elendik.
  //
  // NEDEN: job f483d510'da chunk 3, "vision-hair" kapısından ÜÇ KEZ ÜST ÜSTE
  // elendi (a1, a2, a3 — hepsi "Hair added where the source has none"). Üç
  // denemenin üçü de yeni bir şablonla ve düzeltici uyarıyla yapıldı, üçü de
  // aynı yerde takıldı. Sebep açık: kusur ÇIKTIDA değil, kapının KAYNAĞI
  // yorumlamasındaydı (kullanıcı fotoğrafları inceledi, kişinin gür saçı
  // var). Böyle bir durumda yeniden üretmek kusuru düzeltemez — yalnızca
  // süre ve OpenAI kredisi yakar, kullanıcı da eksik kare alır.
  //
  // KURAL: bir kapı aynı chunk'ta GATE_REPEAT_DISABLE_AFTER kez elerse, o
  // kapı BU CHUNK için devre dışı bırakılır ve sonraki denemede kare o
  // kapıdan geçer. Diğer tüm kapılar çalışmaya devam eder — yani kare hâlâ
  // kimlik/yaw/göz/pozlama denetiminden geçmek zorunda.
  //
  // KAPSAM BİLEREK DAR: yalnızca "yorum" kapıları (Vision'ın öznel yargısı)
  // bu muafiyete girer. Deterministik ölçüm kapıları (math-*, yaw-*, head-dx)
  // ASLA devre dışı bırakılmaz — onlar sayısal ölçüm yapar, tekrar etmeleri
  // gerçek bir sapmanın kanıtıdır, model önyargısının değil.
  const gateRejectCounts = new Map();
  const disabledGates = new Set();
  // Son bakış reddinde Vision'ın ÖLÇTÜĞÜ yönler ({base, out}) — bir sonraki
  // denemenin düzeltici uyarısında kullanılır (bkz. retryCorrectionPrefix).
  let lastGazeFacts = null;
  // Son yaw reddinde ölçülen şablon/çıktı yaw'ı (bkz. retryCorrectionBody).
  let lastYawFacts = null;
  // Son artefakt reddinde kapının bildirdiği BÖLGE ("forehead and nose" gibi)
  // — aynı şekilde bir sonraki denemenin uyarısına yazılır.
  let lastArtifactWhere = null;
  /**
   * Bir reddi tekrar sayacına işler ve sınıra ulaşıldıysa kapıyı bu chunk
   * için devre dışı bırakır. Kapı zaten devre dışıysa bu fonksiyona hiç
   * gelinmez (çağrı yerinde disabledGates kontrol edilir).
   */
  const recordGateRejection = (gate) => {
    if (!GATE_REPEAT_ELIGIBLE.has(gate)) return;
    const n = (gateRejectCounts.get(gate) || 0) + 1;
    gateRejectCounts.set(gate, n);
    if (n >= GATE_REPEAT_DISABLE_AFTER) {
      disabledGates.add(gate);
      console.warn(
        `KAPI DEVRE DIŞI (style=${styleId}, chunk=${chunkIdx}): "${gate}" bu chunk'ta ` +
        `${n} kez üst üste eledi — kusur çıktıda değil kapının yargısında olabilir, ` +
        `bu chunk için kapı atlanıyor (diğer kapılar çalışmaya devam ediyor)`
      );
    }
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // SÜRE BÜTÇESİ: yeni deneme işi 900 sn sınırına taşımasın (bkz.
    // jobTimeLeftMs). Retry sınırını DÜŞÜRÜR, artırmaz.
    if (attempt > 1 && jobTimeLeftMs() < GEN_ATTEMPT_MIN_LEFT_MS) {
      console.warn(`SÜRE BÜTÇESİ (style=${styleId}, chunk=${chunkIdx}): deneme ${attempt} başlatılmıyor, kalan ${Math.round(jobTimeLeftMs() / 1000)}sn`);
      break;
    }
    // HEARTBEAT (2026-09-07 gerçek olay, 2026-09-10'da runOpenAiDirectChunk
    // sarmalayıcısındaki setInterval ile GENİŞLETİLDİ — bkz. fonksiyon başı):
    // cleanupStuckGenJobs her 5 dakikada bir 'generating' işlerde updatedAt'i
    // kontrol ediyor. Bu satır her deneme başında EK bir tazeleme —
    // setInterval'in 90sn'lik periyodu zaten bunu kapsıyor ama deneme anında
    // taze bir zaman damgası garantilemek için fazladan bir yazım maliyetsiz.
    // Fire-and-forget: bu heartbeat'in başarısız olması üretimi bloklamamalı.
    jobRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});

    // YENİDEN DENEME = YENİ ŞABLON (2026-08-04): eskiden her deneme AYNI
    // tuvali kullanıyordu. Sorun şablondan geliyorsa tekrar denemek boşuna —
    // gerçek örnek: 0.802 ve 0.800, iki denemede neredeyse aynı sonuç, çünkü
    // ikisi de arka plandaki yanlış kişiye kırpılmış aynı şablondu. Elde
    // yedek varsa artık onunla deneniyor.
    if (attempt > 1) {
      const next = await prepareNextUsable({ avoidEscalation: true });
      if (next) {
        ({
          input: templateInput, restore, faceRatio: templateFaceRatio,
          sourceBuf: templateSourceBuf, blurScore: templateBlurScore,
        } = next);
        templateYaw = undefined; // yeni şablon -> yaw yeniden ölçülmeli
        templateYawSigned = null;
        templatePose3d = null;
        templateRefMatch = null;
        templateHatP = null;
        templatePromptPose = null;
        templateMeta = null;
        templateIris = undefined;
        templateEyeGlass = undefined;
        templateEyeGlassP = null;
        templateEyewearPreP = null;
        templateEyewearPre = null;
        noteRestore();
        noteTemplate(next.idx);
        console.log(`ŞABLON DEĞİŞTİRİLDİ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): önceki şablon kalite kapısını geçemedi, yedekle deneniyor`);
      }
    }
    // ŞABLON BAKIŞ YÖNLENDİRMESİ KALDIRILDI (2026-09-18) — ÖLÇÜMLE ÇÜRÜDÜ,
    // ÜSTELİK REDDİN KENDİSİNİ ÜRETİYORDU. TEKRAR EKLEMEDEN ÖNCE OKU.
    //
    // 2026-09-17'de buraya "şablonun bakış yönünü measureIrisGaze ile ölç ve
    // prompt'a yaz" eklendi. Ertesi gün 37 gerçek Vision kararı ölçüldü:
    //
    // 1) ÖLÇÜM ARACI YANLIŞTI. Kendi irisX ölçümüm ile Vision'ın BASE_GAZE'i
    //    35 karşılaştırmanın 25'inde ÇELİŞTİ. irisX neredeyse her şablona
    //    "CAMERA" diyordu (0.47-0.62 arası kümeleniyor) çünkü irisX gözün
    //    KUTUSU içindeki iris konumunu ölçer — insan yana bakarken bile iris
    //    kutunun ortasına yakın kalır, yönü belirleyen KAFA yönelimidir.
    //    Örnek: irisX=0.512 -> "CAMERA" dedim, Vision "LEFT" dedi.
    //
    // 2) BU YÜZDEN REDDİ KENDİM ÜRETTİM. Yanlış "CAMERA" ölçümü prompt'a
    //    "merceğe bak" yazdırdı, model İTAAT ETTİ, Vision "taban yana
    //    bakıyordu" deyip reddetti. O günün 8 gaze reddinin 8'i de aynı
    //    desendeydi: LEFT->CAMERA 4 ret / 0 geçiş, RIGHT->CAMERA 4 ret /
    //    0 geçiş.
    //
    // 3) YÖNLENDİRMESİZ HAL ZATEN DAHA İYİYDİ: RIGHT->RIGHT 11 geçiş / 2 ret,
    //    CAMERA->CAMERA 6 geçiş / 0 ret, LEFT->LEFT 4 geçiş / 1 ret. Model
    //    yönlendirilmediğinde tabanın bakışını kendiliğinden taklit ediyor.
    //
    // DERS: bakış yönünü prompt'a yazmadan önce ölçümün Vision'ın BASE_GAZE'i
    // ile uyuştuğunu KANITLA. Yanlış yönlendirme, yönlendirmemekten kötüdür —
    // model itaat eder ve kusuru sen yaratırsın. Ret alındıktan SONRA çalışan
    // retryCorrectionPrefix güvenlidir (Vision'ın kendi ölçtüğü yönü söyler).

    // let: uzuv kroma düzeltmesi (aşağıda) düzeltilmiş kareyle DEĞİŞTİRİR.
    const retryHint = attempt > 1
      ? retryCorrectionPrefix(lastRejectGate, lastGazeFacts, lastArtifactWhere, lastYawFacts)
      : "";
    if (retryHint) {
      console.log(`DÜZELTİCİ UYARI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): önceki red "${lastRejectGate}" — prompt'a hedefli uyarı eklendi`);
    }
    // Sıra ÖNEMLİ: retryHint (varsa) en başta — "önceki deneme reddedildi"
    // uyarısı ilk okunacak şey olmalı. Bakış hedefi hemen ardından gelir ve
    // her denemede tekrarlanır, çünkü kusur ilk denemede de oluşuyor.
    // Şablon yaw'ı üretimden ÖNCE ölçülür (YAW KAPISI aynı değeri kullanır):
    // selfie sırası buna göre seçilir (bkz. orderRefsByPose).
    if (templateYaw === undefined) {
      const { headPoseOf } = require("./faceQuality");
      const tplBufForYaw = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
      const tMeta0 = Date.now();
      templateMeta = templateMetaFor(templateSourceBuf || (restore && restore.originalBuf) || null, Buffer.isBuffer(templateInput), templateFaceRatio);
      if (templateMeta && !templateMeta.miss) {
        const r = templateMeta.raw;
        templateYaw = r.pose2d ? r.pose2d.yaw : null;
        templateYawSigned = r.pose2d && r.pose2d.yawSigned != null ? r.pose2d.yawSigned : null;
        templatePose3d = r.pose3d || null;
        templatePromptPose = PROMPT_POSE_ON && SELFIE_SET_ALL && templatePose3d ? r.promptPose || null : null;
      } else {
        const tp = (await headPoseOf(tplBufForYaw)) || (await headPoseOf(tplBufForYaw, LOW_CONF_FACE));
        templateYaw = tp ? tp.yaw : null;
        templateYawSigned = tp && tp.yawSigned != null ? tp.yawSigned : null;
        templatePose3d = await require("./headPose3d").headPose3dOf(tplBufForYaw);
        templatePromptPose = PROMPT_POSE_ON && SELFIE_SET_ALL && templatePose3d ? await basePromptPose(tplBufForYaw, templatePose3d) : null;
      }
      console.log(`ŞABLON TABLOSU (style=${styleId}, chunk=${chunkIdx}): ${!TEMPLATE_META_ON ? "KAPALI" : templateMeta && !templateMeta.miss ? `OKUNDU ${templateMeta.name}` : templateMeta ? `ÖLÇÜLDÜ[${templateMeta.miss}] ${templateMeta.name}` : "ÖLÇÜLDÜ[tabloda-yok]"} süre=${Date.now() - tMeta0}ms`);
      templateRefMatch = (REF_MATCH_ON || (SELFIE_SET_ALL && FIRST_REF_GAZE && SELFIE_FIRST_REPOSE)) && templatePose3d ? await require("./refMatch").baseFeatures(tplBufForYaw) : null;
      const f1 = (v) => (v != null && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "null");
      const p2 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(2) : "null");
      const pp = templatePromptPose;
      console.log(`PROMPT POZU (style=${styleId}, chunk=${chunkIdx}): ${pp ? `yaw=${f1(pp.yaw)} pitch=${f1(pp.pitch)} roll=${f1(pp.roll)} çene=${p2(pp.chinX)}/${p2(pp.chinY)} yüzEni=${p2(pp.faceW)}` : PROMPT_POSE_ON ? "ÖLÇÜLEMEDİ" : "KAPALI"}`);
    }
    // Modele giden tuval tplBufForYaw ile aynı (saç silme/kırpma kapalı); yalnız selfie seti yolunda.
    if (!templateHatP && HAT_PROMPT_ON && NATURAL_SWAP_ON && SELFIE_SET_ALL) {
      const metaHat = templateMeta && !templateMeta.miss && templateMeta.raw.hat && templateMeta.raw.hat.hat === false ? templateMeta.raw.hat : null;
      if (metaHat) {
        console.log(`ŞAPKA ŞABLONDA (style=${styleId}, chunk=${chunkIdx}): YOK[${metaHat.reason || "-"}] kaynak=tablo`);
        templateHatP = Promise.resolve({ ...metaHat, fromTable: true });
      } else {
        templateHatP = templateHatOf(Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf, styleId, chunkIdx);
      }
    }
    // Gözlüklü şablon bakışı: iki ölçü selfie hazırlığıyla paralel koşar. Karar Vision yargısı
    // (yerel gözlük payı 0.23-0.42 aralığında gözlüklü ve gözlüksüz şablonları ayıramadı, kütüphane
    // taraması 11-20); Vision okunamazsa yerel pay ≥ IRIS_TPL_GLASS_SKIP. ZIT BAKIŞ kapısı yerel payı kullanır.
    if (!templateEyewearPreP && EYEWEAR_GAZE_PROMPT_ON && NATURAL_SWAP_ON && SELFIE_SET_ALL) {
      const src = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
      if (templateEyeGlass === undefined && !templateEyeGlassP) {
        templateEyeGlassP = Buffer.isBuffer(src)
          ? runPostTask("eyeGlassShare", { tpl: src }).then((r) => (r ? r.share : null)).catch(() => null)
          : Promise.resolve(null);
      }
      templateEyewearPreP = !Buffer.isBuffer(src) ? Promise.resolve({ ok: false, reason: "no-template" }) : (async () => {
        try {
          const { detectMainFace } = require("./faceQuality");
          const fd = (await detectMainFace(src)) || (await detectMainFace(src, LOW_CONF_FACE));
          return fd && fd.box
            ? await require("./headGhost").judgeEyewear(src, fd.box, OPENAI_KEY.value())
            : { ok: false, reason: "no-face-template" };
        } catch (e) {
          console.error("Üretim öncesi şablon gözlük yargısı hata verdi:", e.message || e);
          return { ok: false, reason: "error" };
        }
      })();
    }
    const genRefUrls = SELFIE_SET_ALL
      ? await prepareSelfieSet(refUrls, templatePose3d, styleId, chunkIdx, attempt, templateRefMatch)
      : await orderRefsByPose(refUrls, templateYaw, styleId, chunkIdx, attempt, templateYawSigned, templatePose3d, templateRefMatch);
    // ŞABLON SAÇI ÖN TEMİZLİĞİ (bkz. templateHair.js): modele saçı silinmiş
    // kopya gider; kapılar ve son katmanlar orijinal şablonla çalışır.
    if (genTemplateFor !== templateInput) {
      genTemplateFor = templateInput;
      genTemplateInput = templateInput;
      CHUNK_HAIR_ERASED.delete(chunkTemplateKey(jobId, styleId, chunkIdx));
      if (TEMPLATE_HAIR_ERASE) {
        const src = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
        const er = src ? await require("./templateHair").eraseTemplateHair(src) : { buf: null, reason: "no-source" };
        console.log(`ŞABLON SAÇI (style=${styleId}, chunk=${chunkIdx}): ${er.buf ? "SİLİNDİ" : `ATLANDI[${er.reason}]`} saçPx=${er.hairPx ?? "null"} alınPx=${er.foreheadPx ?? "null"} telPx=${er.strandPx ?? "null"} maskePx=${er.maskPx ?? "null"} süre=${er.ms ?? "null"}ms`);
        if (er.buf) {
          genTemplateInput = er.buf;
          CHUNK_HAIR_ERASED.add(chunkTemplateKey(jobId, styleId, chunkIdx));
        }
      } else if (TEMPLATE_HAIR_TRIM) {
        // ŞABLON SAÇI KIRPMA: beklenen kafa = base pozuna çevrilmiş ilk selfie
        // (genRefUrls[0]; Buffer değilse indirilir). Kırpılan chunk'ta ghostClean
        // atlanır (CHUNK_HAIR_ERASED): dış saç zaten modele gitmiyor.
        const src = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
        // Poz kapıları (bkz. TRIM_GATE): ölçülemeyen poz da kırpılmaz.
        const tpY = templatePose3d && Number.isFinite(templatePose3d.yaw) ? templatePose3d.yaw : null;
        const tpP = templatePose3d && templatePose3d.src === "mesh" && Number.isFinite(templatePose3d.pitch) ? templatePose3d.pitch : null;
        const fY = Number.isFinite(genRefUrls.firstYaw) ? genRefUrls.firstYaw : null;
        const { trimTemplateHair, trimPoseSkip, trimShareSkip } = require("./templateHair");
        const poseSkip = trimPoseSkip(tpY, tpP, fY);
        let selfie = !poseSkip && genRefUrls.length ? genRefUrls[0] : null;
        if (typeof selfie === "string") {
          try {
            const r = await fetch(selfie, { signal: AbortSignal.timeout(15000) });
            selfie = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
          } catch (e) {
            console.error("Kırpma için ilk selfie indirilemedi (atlanıyor):", e.message || e);
            selfie = null;
          }
        }
        let tr = poseSkip ? { buf: null, reason: poseSkip }
          : src ? await trimTemplateHair(src, Buffer.isBuffer(selfie) ? selfie : null) : { buf: null, reason: "no-source" };
        const shareSkip = tr.buf ? trimShareSkip(tr.trimFrac) : null;
        if (shareSkip) tr = { ...tr, buf: null, reason: shareSkip };
        const f3 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(3) : "null");
        const f1 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(1) : "null");
        console.log(`ŞABLON SAÇI KIRPMA (style=${styleId}, chunk=${chunkIdx}): ${tr.buf ? "KIRPILDI" : `ATLANDI[${tr.reason}]`} saçPx=${tr.hairPx ?? "null"} dışSaçPx=${tr.trimPx ?? "null"} pay=${f3(tr.trimFrac)} kafaPx=${tr.headPx ?? "null"} şablonYaw=${f1(tpY)} şablonPitch=${f1(tpP)} ilkSelfieYaw=${f1(fY)} süre=${tr.ms ?? "null"}ms`);
        if (tr.buf) {
          genTemplateInput = tr.buf;
          CHUNK_HAIR_ERASED.add(chunkTemplateKey(jobId, styleId, chunkIdx));
        }
      }
    }
    // Doğal yer değiştirme: tüm selfie seti (SELFIE_SET_ALL) ya da base'e
    // hazırlanmış referans (base pozuna çevrilmiş Buffer + şablon ölçüsü).
    const swapRefs = !NATURAL_SWAP_ON || !genRefUrls.length ? 0
      : SELFIE_SET_ALL ? faceRefUrls(genRefUrls).length
      : templateRefMatch && genRefUrls.every((r) => Buffer.isBuffer(r)) ? genRefUrls.length : 0;
    console.log(`ÇEKİRDEK (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${swapRefs ? `DOĞAL-YER-DEĞİŞTİRME referans=${swapRefs}${SELFIE_SET_ALL ? " [tüm set]" : ""}` : `P800[${!NATURAL_SWAP_ON ? "kapalı" : !templateRefMatch ? "base-ölçülemedi" : "referans-hazırlanamadı"}]`}`);
    const tplHat = swapRefs && templateHatP ? await templateHatP : null;
    if (templateEyeGlass === undefined && templateEyeGlassP) templateEyeGlass = await templateEyeGlassP;
    if (!templateEyewearPre && templateEyewearPreP) templateEyewearPre = await templateEyewearPreP;
    const eyewearGaze = !!(swapRefs && EYEWEAR_GAZE_PROMPT_ON && eyewearGazeOn(templateEyewearPre, templateEyeGlass));
    if (swapRefs && EYEWEAR_GAZE_PROMPT_ON && attempt === 1) {
      const ew = templateEyewearPre;
      console.log(`GÖZLÜK BAKIŞI (style=${styleId}, chunk=${chunkIdx}): ${eyewearGaze ? "ORTADA" : "ŞABLONDAN"} vision=${ew && ew.ok ? (ew.eyewear ? "var" : "yok") : `?[${(ew && ew.reason) || "-"}]`} gözGörünür=${ew && ew.ok ? ew.eyesVisible : "null"} gözlükPayı=${templateEyeGlass != null ? templateEyeGlass.toFixed(2) : "null"}`);
    }
    const swapOpts = { hat: !!(tplHat && tplHat.hat), pose: templatePromptPose, eyewear: eyewearGaze };
    let buf = await generateForMode(
      mode, genTemplateInput, genRefUrls, identityCaption, bodyProfile, styleId, chunkIdx,
      refDescriptor, retryHint, imageModel, swapRefs, swapOpts
    );
    // YÖN İÇİN İKİNCİ ÜRETİM (2026-10-19, ca61076a, kullanıcı: "bakış hiçbir
    // şekilde base fotodan başka yere sapmamalı"; akış kullanıcı onaylı):
    // model başı ~üç çeyrek açıya çekiyor; düz/orta açılı şablonda kendi hafif
    // dönüşünü büyütüyor. Prompt (4 varyant), tuvali dikleştirme, poz rehberi
    // görseli, sonradan geometrik çevirme, az selfie ve şablona yüz yerleştirme
    // denendi, hiçbiri tek üretimde çözmedi. Aynı şablonda iki üretim arası
    // fark ise büyük: 45 tekrar çiftinde tek karenin ≥0.15 sapma oranı %16,
    // iki kareden iyisininki %2 (≥0.10: %40 → %13). İlk kare sapınca bir kez
    // daha üretilir (aynı prompt), yönü yakın olan alınır. Bütçe/süre
    // yetmezse ilk kare kalır. DÜZELTME CÜMLESİ DENENDİ, ALINMADI: prompt
    // sonuna ölçülen yönü yazmak yön sayısını iyileştirdi (0.103 → 0.074)
    // ama başın yatıklığını bozdu (fark 2.1° → 3.8°; 13° yatık şablonda baş
    // dikleşip ters yana döndü). Kullanıcı: "doğru yere bakan görseli cümleyle
    // yanlış seçiyor".
    if (SECOND_GEN_ON && buf && mode !== PHOTO_MODE_STAGED && templateYawSigned != null) {
      buf = await resampleIfYawDrifts(buf, {
        templateYawSigned, templateYawUnsigned: Number.isFinite(templateYaw) ? templateYaw : null, templatePose3d, refDescriptor, styleId, chunkIdx, attempt, uid, jobId,
        reachErr: genRefUrls && Number.isFinite(genRefUrls.reachErr) ? genRefUrls.reachErr : null,
        // fix: ilk karenin ölçülen 3B fazla dönmesi (bkz. naturalSwap describeBasePose yawFix).
        regenerate: (fix) => generateForMode(
          mode, genTemplateInput, genRefUrls, identityCaption, bodyProfile, styleId, chunkIdx,
          refDescriptor, retryHint, imageModel, swapRefs,
          fix && swapOpts && swapOpts.pose ? { ...swapOpts, pose: { ...swapOpts.pose, yawFix: fix } } : swapOpts
        ),
      });
    }
    // ŞAPKA KAPISI (2026-11-19, 6a02687c c1, kullanıcı: "berenin olmadığı yerde
    // kafayı uzatmış, bu şekilde yapmamalı"). Model şablonun şapkasını/beresini
    // düşürünce kafayı şapka hacmine uzatıyor. Aynı bereli şablonda 8 işte bere
    // yalnız 2 kez korundu; hiçbir kapı bakmıyordu, kare teslim ediliyordu.
    // Ölçü ücretsiz/yerel (ghostClean.measureHatKept: korunan 0.84-0.90, düşen
    // 0.00). Düşmüşse bir kez daha üretilir (kare zaten elenecek: elenecek kare
    // payı, paylar boşalana dek süre içinde beklenir; mutlak tavan çağrıda
    // denetlenir). İkincisinde de yoksa kare elenir (hat-lost, onayda engelli).
    if (buf && OUTPUT_GATES_ON && HAT_GATE_ON && tplHat && tplHat.hat) {
      const tplBufForHat = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
      const measureHat = (b) => (Buffer.isBuffer(tplBufForHat)
        ? runPostTask("hatKept", { out: b, tpl: tplBufForHat }).catch((e) => { console.error("Şapka kapısı ölçümü başarısız:", e.message || e); return null; })
        : Promise.resolve(null));
      const tagH = `style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}`;
      const fh = (h) => (h ? `pay=${h.share.toFixed(2)} alan=${h.area.toFixed(2)}` : "ölçülemedi");
      let h = await measureHat(buf);
      if (SECOND_GEN_ON && h && !h.kept) {
        const L0 = ledgerSummary();
        const fits = () => !L0 || L0.spentUsd + L0.reservedUsd + EST_RESAMPLE_USD + ANGLED_REJECT_HEADROOM_USD <= L0.limitUsd;
        const t0 = Date.now();
        while (!fits() && Date.now() - t0 + 3000 <= RESAMPLE_WAIT_MAX_MS && jobTimeLeftMs() >= GEN_ATTEMPT_MIN_LEFT_MS) {
          await new Promise((r) => setTimeout(r, 3000));
        }
        const slot = fits() && jobTimeLeftMs() >= GEN_ATTEMPT_MIN_LEFT_MS ? tryReserveOptional(EST_RESAMPLE_USD) : null;
        if (!slot) {
          if (L0) L0.skipped++;
          console.log(`ŞAPKA İKİNCİ ÜRETİM (${tagH}): ATLANDI[${fits() ? "süre" : "bütçe"}] ilk=${fh(h)}${L0 ? ` harcanan=${L0.spentUsd.toFixed(3)} ayrılan=${L0.reservedUsd.toFixed(3)}` : ""}`);
        } else {
          try {
            // İkinci üretimde şapka promptta açıkça (bkz. naturalSwap hatFixLine).
            const b2 = await runOptional(() => generateForMode(
              mode, genTemplateInput, genRefUrls, identityCaption, bodyProfile, styleId, chunkIdx,
              refDescriptor, retryHint, imageModel, swapRefs, { ...swapOpts, hatFix: (tplHat && tplHat.q) || true }
            ));
            const h2 = b2 ? await measureHat(b2) : null;
            console.log(`ŞAPKA İKİNCİ ÜRETİM (${tagH}): şapkaCümlesi=${(tplHat && tplHat.q) || "hat"} ilk=${fh(h)} ikinci=${b2 ? fh(h2) : "üretilemedi"} → ${h2 && h2.kept ? "ikinci alındı" : "ilk kaldı"} (${Math.round((Date.now() - t0) / 1000)}sn)`);
            if (h2 && h2.kept) { buf = b2; h = h2; }
          } finally { slot.release(); }
        }
      }
      console.log(`ŞAPKA KAPISI (${tagH}): ${h ? (h.kept ? "GEÇTİ" : "RED[hat-lost]") : "ÖLÇÜLEMEDİ"} ${fh(h)}`);
      if (h && !h.kept) {
        lastRejectGate = "hat-lost";
        await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
          mode, gate: lastRejectGate, distance: null, detail: `şapka ${fh(h)}`,
        });
        if (attempt < maxAttempts) continue;
        break;
      }
    }
    if (!buf) {
      // ÖNCEDEN BURADA HİÇ LOG YOKTU (2026-08-13 gerçek olay): bir chunk
      // OpenAI 429'unu iki denemesinde de tüketip TAMAMEN sessizce
      // kayboluyordu — loglarda o chunk'ın var olduğu bile görünmüyordu,
      // sebep ancak diğer tüm chunk'lar tek tek elenerek bulunabiliyordu.
      console.warn(`ÜRETİM BAŞARISIZ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): generateForMode null döndü (muhtemelen OpenAI 429/hata — yukarıdaki "OpenAI images/edits başarısız" satırına bak)`);
      // lastRejectGate BİLEREK sıfırlanmıyor: burada üretim hiç olmadı, bu bir
      // kalite reddi değil.
      // ALTYAPI HATASINDA YENİ ÜRETİM YOK (2026-11-04 inceleme; kullanıcı
      // kuralı 2026-07-22: "en ufak hata çıkarsa da kredi harcamadan hiç
      // üretmesin", bkz. fal-credit-burn-incident). Onaysız akışta (eski
      // istemci, inceleme demo hesabı) burası `continue` ile 6 denemeye kadar
      // yeni ücretli üretim açabiliyordu; zaman aşımı faturalanmış olabilir.
      // Kalite reddi denemeleri (aşağıdaki kapılar) etkilenmez.
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
    if (buf && !OUTPUT_GATES_ON && attempt === 1) {
      console.log(`KAPILAR (style=${styleId}, chunk=${chunkIdx}): KAPALI[OUTPUT_GATES_ON=false] kare elenmeden geri yerleştirmeye gidiyor`);
    }
    if (OUTPUT_GATES_ON && refDescriptor) {
      let mathOk = true;
      let mathDist = null;
      let mathReason = null;
      let mathFaceRatio = null;
      let outEyeOpenness = null;
      let outYaw = null;
      // Kafa büyümesi (çıktı yüzOranı / şablon yüzOranı) — Vision'ın kafa
      // boyutu reddi için SAYISAL HAKEM olarak kullanılıyor (bkz. aşağıdaki
      // VISION_PROPORTION_GROWTH_MIN).
      let headGrowth = null;
      try {
        const { assessOutputFace } = require("./faceQuality");
        const q = await assessOutputFace(buf, refDescriptor, templateFaceRatio);
        mathOk = q.ok;
        mathDist = q.distance;
        mathReason = q.reason;
        mathFaceRatio = q.faceRatio != null ? q.faceRatio : null;
        outEyeOpenness = q.eyeOpenness != null ? q.eyeOpenness : null;
        outYaw = q.profileDegree != null ? q.profileDegree : null;
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
        if (templateFaceRatio && q.faceRatio) headGrowth = q.faceRatio / templateFaceRatio;
        const gr = headGrowth != null ? headGrowth.toFixed(2) : "null";
        const pd = q.profileDegree != null ? q.profileDegree.toFixed(2) : "null";
        // ŞABLONA GÖRE NETLİK (2026-09-22) — yalnızca ölçüm, eleme yok.
        // netlikOranı = çıktı netliği / şablon netliği. 1'in altı, çıktının
        // kendi tabanından daha yumuşak geldiği anlamına gelir. Mutlak eşik
        // neden yanlış olurdu: bkz. prepareTemplate'teki "ŞABLON NETLİĞİ" notu.
        const tbs = templateBlurScore != null ? templateBlurScore.toFixed(1) : "null";
        const br = (templateBlurScore && q.blurScore != null && templateBlurScore > 0)
          ? (q.blurScore / templateBlurScore).toFixed(2)
          : "null";
        console.log(`KALITE ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${q.ok ? "GEÇTİ" : "RED[" + q.reason + "]"} mesafe=${d} profil=${pd} yüzOranı=${fr} büyüme=${gr} netlik=${bs} şablonNetlik=${tbs} netlikOranı=${br} eşik=${require("./faceQuality").FACE_MATCH_THRESHOLD}`);
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
        lastRejectGate = `math-${mathReason || "?"}`;
        await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
          mode, gate: lastRejectGate, distance: mathDist,
        });
        if (attempt < maxAttempts) continue;
        break;
      }
      if (noFace) {
        const why = mathReason === "profile"
          ? `yüz PROFİLDEN görünüyor, kimlik mesafesi (${mathDist != null ? mathDist.toFixed(3) : "?"}) güvenilmez`
          : "yüz tespit edilemedi (gözlük/açı olabilir)";
        console.warn(`KALITE: ${why} — kare atılmıyor, karar Vision'a devredildi (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt})`);
      }

      // YAW KAPISI — kafa şablondakinden BAŞKA yöne bakıyor mu?
      // (bkz. OUTPUT_YAW_DRIFT_MAX: gerçek veri + "modelin kafayı ortaya
      // çekmesi" örüntüsü). Vision'dan ÖNCE, bilinçli: elenecek kare için
      // boşuna gpt-4o çağrısı yapılmasın.
      // Şablon yaw'ı ŞABLON BAŞINA bir kez ölçülür (deneme başına değil);
      // şablon değişince yeniden ölçülür (bkz. yukarıdaki sıfırlama).
      try {
        const { headYawOf, headPoseOf, PROFILE_UNRELIABLE_MIN } = require("./faceQuality");
        const { isPulledToCameraNumeric, isUnderRotated } = require("./headBodyGate");
        const tplBufForYaw = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
        if (templateYaw === undefined) {
          const tp = (await headPoseOf(tplBufForYaw)) || (await headPoseOf(tplBufForYaw, LOW_CONF_FACE));
          templateYaw = tp ? tp.yaw : null;
          templateYawSigned = tp && tp.yawSigned != null ? tp.yawSigned : null;
        }
        // DÜŞÜK GÜVENLE YENİDEN ÖLÇ (2026-10-08, 272e656a c0): kalite
        // ölçümü yüzü 0.35 güvenle bulamayınca yaw null kalıyor ve bu kapı
        // "ölçülemedi" deyip susuyordu. O kare şablon 0.07 iken 0.44 yana
        // dönüktü (teslim sonrası ölçüm) ve kullanıcı "bakış yeri farklı"
        // diye işaretledi. Yalnızca yaw için 0.1 güvenle yeniden denenir.
        if (outYaw == null) outYaw = await headYawOf(buf, LOW_CONF_FACE);
        const outPose = templateYawSigned != null ? (await headPoseOf(buf)) || (await headPoseOf(buf, LOW_CONF_FACE)) : null;
        const outYawSigned = outPose && outPose.yawSigned != null ? outPose.yawSigned : null;
        const pulledNoTpl = isPulledToCameraNumeric(templateYaw ?? null, outYaw ?? null);
        // Fail-safe: ikisinden biri ölçülemediyse eski yaw kapıları susar.
        // Şablon yaw'ı yokken çıktı merceğe dönükse HEAD_VS_BODY sayısal
        // reddi devreye girer (kahve + çanta yürüyüşü, f94c3cec c3).
        if (templateYaw != null && outYaw != null) {
          const drift = outYaw - templateYaw;
          // YÖN SAPMASI İŞARETLİ (2026-10-19, ca61076a): işaretsiz farkta ters
          // yana dönen baş küçük fark görünüyordu (-0.07 → +0.33 kapıdan 0.26
          // ile geçti). Diğer kurallar büyüklüğe bakar, işaretsiz ölçüde kalır.
          const driftSigned = templateYawSigned != null && outYawSigned != null ? outYawSigned - templateYawSigned : null;
          const bad = Math.abs(driftSigned != null ? driftSigned : drift) > OUTPUT_YAW_DRIFT_MAX;
          // Kafa, profil tabandan kameraya doğru çevrilmiş mi? (bkz.
          // YAW_TO_CAMERA_DROP_MAX — yöne duyarlı ikinci kural.
          // YAW_TO_CAMERA_OUTPUT_MAX: çıktı hâlâ yana bakıyorsa eleme yok.)
          const toCamera = templateYaw >= YAW_TO_CAMERA_TEMPLATE_MIN &&
                           drift <= -YAW_TO_CAMERA_DROP_MAX &&
                           outYaw < YAW_TO_CAMERA_OUTPUT_MAX;
          // Aynı yöne bakarken dönüş abartılmış mı? (bkz. YAW_OVER_ROTATE_*)
          const overRotate = templateYaw >= YAW_OVER_ROTATE_TEMPLATE_MIN &&
                             drift >= YAW_OVER_ROTATE_RISE_MIN;
          const underRotate = isUnderRotated(templateYaw, outYaw);
          const overRotateSigned = driftSigned != null && templateYawSigned * outYawSigned > 0 &&
            Math.abs(outYawSigned) - Math.abs(templateYawSigned) >= YAW_OVER_ROTATE_PROFILE_SIGNED_MIN;
          // PROFİL İSTİSNASI (2026-09-08 gerçek olay, job aaf8b1ea c1_att1):
          // profileDegreeFromLandmarks (headYawOf'un temeli) kimlik
          // mesafesinde AYNI SEBEPTEN güvenilmez sayılıyor (bkz.
          // PROFILE_UNRELIABLE_MIN, faceQuality.js) — kafa yüksek derecede
          // yana dönükken burun/göz-köşesi geometrisi doğrusallığını
          // kaybediyor. Şablon 0.52, çıktı 0.90 ölçüldü, sapma eşiği (0.30)
          // büyük farkla aştı ve kare RED[yaw-drift] oldu — ama kullanıcı
          // görsel karşılaştırmada kareyi kabul edilebilir buldu. Kimlik
          // kapısıyla TUTARLI olacak şekilde: şablon YA DA çıktı zaten
          // güvenilmez bölgedeyse (>0.45) sert red yerine Vision'a devret.
          // DELİK KAPATILDI (2026-10-08, 9d9507f0 c6/c9): eskiden İKİSİNDEN
          // BİRİ profil bölgesindeyse ölçüm "güvenilmez" sayılıyordu. Ama
          // önden bakan şablonda (0.06) çıktı 0.49'a döndüğünde bu tam olarak
          // yakalanması gereken hataydı ve kapı susuyordu. Profilde ölçüm
          // BÜYÜKLÜĞÜ doğrusal değil, YÖNÜ değil: biri profil eşiğinin altında,
          // öbürü üstündeyse sapma en az o farktır. Yalnızca İKİSİ DE profil
          // bölgesindeyken ölçüm güvenilmez sayılır.
          // EKSİK DÖNME PROFİLDE DE GEÇERLİ (2026-10-16, 6dd26e3e c4/c7):
          // kural yalnız profil şablonlarda çalışır, yani iki ölçü de hep
          // "güvenilmez" bölgede — 2026-10-08'den beri hiç tetiklenemedi (c4
          // 0.90→0.63 teslim edildi). Profilde büyüklük doğrusal değil ama yön
          // güvenilir: çıktı belirgin daha az dönükse daha az dönüktür.
          const yawUnreliable = templateYaw > PROFILE_UNRELIABLE_MIN && outYaw > PROFILE_UNRELIABLE_MIN && !underRotate;
          // 3B FAZLA DÖNME (2026-11-10, 7bbdad12 c2/c5/c7): 2B landmark ölçüsü başın kalkmasını
          // (pitch) dönme sanıyordu — c2 3B'de +0.9° dönme, +16° kalkık, RED[yaw-over-rotate].
          // 230 çift yerel ölçüm: onaylı karelerin %90'ı ≤9.2° fazla dönük; kullanıcının şikâyet
          // ettiği 7c17ea3f c2 +10.6°. İki karede de 3B ağ varsa ve dönüş ±YAW3D_MAX_ABS içindeyse
          // (ağ profilde tıkanıyor) fazla dönme kararı 3B'den; yoksa eski 2B kurallar.
          let op3 = null;
          if (templatePose3d) {
            try { op3 = await require("./headPose3d").headPose3dOf(buf); } catch (e) { console.error("3B poz ölçümü (çıktı) başarısız:", e.message || e); }
          }
          const { use3d, over: over3d } = yawOver3d(templatePose3d, op3);
          const profileOver = use3d ? over3d : overRotateSigned;
          const overRotateEff = use3d ? false : overRotate;
          const yawVerdict = profileOver ? "RED[yaw-over-rotate]"
            : yawUnreliable ? "ÖLÇÜLEMEDİ[profile]"
            : bad ? "RED[yaw-drift]"
            : toCamera ? "RED[yaw-to-camera]"
            : overRotateEff ? "RED[yaw-over-rotate]"
            : underRotate ? "RED[yaw-under-rotate]"
            : "GEÇTİ";
          // GEÇEN kareler de loglanıyor — eşik ancak gerçek dağılım görülerek
          // kalibre edilebilir (dosyadaki diğer kapılarla aynı usul).
          // 3B POZ (2026-10-31, derece): selfie çevirmenin etkisi burada izlenir.
          if (templatePose3d) {
            try {
              const op = op3;
              const g = (v) => (v != null && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "null");
              const dp = op && op.pitch != null && templatePose3d.pitch != null ? op.pitch - templatePose3d.pitch : null;
              console.log(`POZ 3B ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): şablon=${g(templatePose3d.yaw)}/${g(templatePose3d.pitch)} çıktı=${op ? `${g(op.yaw)}/${g(op.pitch)}` : "null"} Δyaw=${op ? g(op.yaw - templatePose3d.yaw) : "null"}° Δpitch=${g(dp)}°`);
            } catch (e) {
              console.error("3B poz ölçümü (çıktı) başarısız:", e.message || e);
            }
          }
          console.log(`YAW ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${yawVerdict} çıktı=${outYaw.toFixed(2)} şablon=${templateYaw.toFixed(2)} sapma=${drift >= 0 ? "+" : ""}${drift.toFixed(2)} işaretliSapma=${driftSigned != null ? `${driftSigned >= 0 ? "+" : ""}${driftSigned.toFixed(2)} [${templateYawSigned.toFixed(2)}→${outYawSigned.toFixed(2)}]` : "null"} eşik=${OUTPUT_YAW_DRIFT_MAX} kameraya=${toCamera} fazlaDönme=${overRotateEff} fazlaDönme3B=${use3d ? over3d : "yok"} eksikDönme=${underRotate} çekildi=${pulledNoTpl}`);
          if (profileOver || (!yawUnreliable && (bad || toCamera || overRotateEff || underRotate))) {
            lastRejectGate = profileOver ? "yaw-over-rotate" : bad ? "yaw-drift" : toCamera ? "yaw-to-camera" : overRotateEff ? "yaw-over-rotate" : "yaw-under-rotate";
            lastYawFacts = { tpl: templateYaw, out: outYaw, tplSigned: templateYawSigned, outSigned: outYawSigned };
            await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
              mode, gate: lastRejectGate,
              distance: mathDist,
              detail: `çıktı=${outYaw.toFixed(2)} şablon=${templateYaw.toFixed(2)}`,
            });
            if (attempt < maxAttempts) continue;
            break;
          }
        } else if (pulledNoTpl) {
          console.log(`YAW ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): RED[yaw-pulled-to-camera] çıktı=${outYaw.toFixed(2)} şablon=null çekildi=true`);
          lastRejectGate = "yaw-pulled-to-camera";
          await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
            mode, gate: "yaw-pulled-to-camera",
            distance: mathDist,
            detail: `çıktı=${outYaw.toFixed(2)} şablon=null`,
          });
          if (attempt < maxAttempts) continue;
          break;
        } else {
          console.log(`YAW ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ÖLÇÜLEMEDİ çıktı=${outYaw != null ? outYaw.toFixed(2) : "null"} şablon=${templateYaw != null ? templateYaw.toFixed(2) : "null"} çekildi=false`);
        }
      } catch (e) {
        console.error("OpenAI yolu: yaw kapısı hata verdi (bu katman atlanıyor):", e);
      }

      // İRİS BAKIŞI KAPISI KALDIRILDI (2026-09-07): job aaf8b1ea'da 36 redden
      // 21'i bu kapıdan geldi, chunk başına 4-6 denemeyi tüketip kullanıcının
      // OpenAI kredisini gereksiz yere yaktı (eşik/ölçüm gürültüye karşı çok
      // hassastı). Kaba Vision BASE_GAZE/OUTPUT_GAZE karşılaştırması
      // (isGazeMismatch, aşağıdaki VISION ÖLÇÜM bloğunda) bakış yönü
      // uyuşmazlığını hâlâ yakalıyor — o daha az agresif ve yanlış pozitif
      // oranı düşük.
      //
      // ZIT BAKIŞ (2026-10-25, d0d4c001 c7): Vision şablonu yana, çıktıyı
      // ters yana bakan kareyi geçirdi. Yalnız kaba hata elenir (bkz.
      // gazeGate.isIrisGazeOpposite); yerel ölçüm, ücretsiz, ikinci üretim yok.
      try {
        const { measureIrisGaze } = require("./faceQuality");
        const { isIrisGazeOpposite, IRIS_TPL_GLASS_SKIP } = require("./gazeGate");
        const tplBufForGaze = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
        if (templateEyeGlass === undefined) {
          templateEyeGlass = Buffer.isBuffer(tplBufForGaze)
            ? await runPostTask("eyeGlassShare", { tpl: tplBufForGaze }).then((r) => (r ? r.share : null)).catch(() => null)
            : null;
        }
        if (templateEyeGlass != null && templateEyeGlass >= IRIS_TPL_GLASS_SKIP) {
          if (templateIris === undefined) {
            templateIris = null;
            console.log(`ZIT BAKIŞ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[şablon-gözlük] gözlükPayı=${templateEyeGlass.toFixed(2)}`);
          }
        } else if (templateIris === undefined) {
          templateIris = Buffer.isBuffer(tplBufForGaze)
            ? (await measureIrisGaze(tplBufForGaze)) || (await measureIrisGaze(tplBufForGaze, LOW_CONF_FACE))
            : null;
        }
        if (templateIris) {
          const outIris = (await measureIrisGaze(buf)) || (await measureIrisGaze(buf, LOW_CONF_FACE));
          const opposite = isIrisGazeOpposite(templateIris, outIris);
          const g = (v) => (v ? `${v.irisX.toFixed(2)}/göz${v.eyes}/${Math.round(v.eyeWidth)}px/koyuluk=${v.eyeCheek != null ? v.eyeCheek.toFixed(2) : "null"}` : "null");
          console.log(`ZIT BAKIŞ (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${opposite ? "RED[gaze-opposite]" : "GEÇTİ"} şablon=${g(templateIris)} çıktı=${g(outIris)}`);
          if (opposite) {
            lastRejectGate = "gaze-opposite";
            await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
              mode, gate: lastRejectGate,
              distance: mathDist,
              detail: `irisX çıktı=${outIris.irisX.toFixed(2)} şablon=${templateIris.irisX.toFixed(2)}`,
            });
            if (attempt < maxAttempts) continue;
            break;
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: zıt bakış kapısı hata verdi (bu katman atlanıyor):", e);
      }

      // templateInput kırpma yapıldıysa Buffer, yapılmadıysa URL string'idir.
      // Ten düzeltmesi + ten kapısı + Vision (şablon karşılaştırması) hepsi
      // aynı piksel buffer'ını kullanır.
      const tplBuf = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;

      // Sayısal ten ölçümü — Vision'ın "el/kol teni uyuşmuyor" reddi için de
      // hakem olarak kullanılır (bkz. aşağıdaki VISION TEN REDDİ bloğu).
      let skinVsFace = null;

      // UZUV KROMA + TEN KAPISI — Vision'dan ÖNCE (2026-09-06).
      // Eskiden Vision BAD_SKIN, kroma düzeltmesinden önce reddedip düzeltilabilir
      // kareleri retry'a atıyordu. Sıra: düzelt → ölç → Vision (kafa/bakış/…).
      // SADE AKIŞTA atlanır (bkz. SIMPLE_PIPELINE): üretilen kareye dokunulmaz.
      if (!SIMPLE_PIPELINE) try {
        const { correctLimbChroma } = require("./faceQuality");
        const cc = await correctLimbChroma(buf, tplBuf, refSkinTone);
        const db = cc.deltaBefore != null ? cc.deltaBefore.toFixed(1) : "null";
        const da = cc.deltaAfter != null ? cc.deltaAfter.toFixed(1) : "null";
        const ar = cc.areaRatio != null ? cc.areaRatio.toFixed(3) : "null";
        console.log(`KROMA DÜZELTME (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${cc.applied ? "UYGULANDI" : `ATLANDI[${cc.reason}]`} yüzUzuvFarkıÖnce=${db} sonra=${da} alanOranı=${ar}${cc.shift != null ? ` kayma=${cc.shift.toFixed(1)}` : ""}`);
        if (cc.applied && cc.buf) buf = cc.buf;
      } catch (e) {
        console.error("OpenAI yolu: uzuv kroma düzeltmesi hata verdi (atlanıyor):", e);
      }

      // YÜZ PARLAMASI — selfie flaş/anahtar ışığı çıktı yüzüne kopyalanmışsa
      // speküler lekeleri alır. Genel sahne güneşini karartmaz (alan tavanı).
      if (!SIMPLE_PIPELINE) try {
        const { reduceFaceSpecular } = require("./faceShine");
        const sh = await reduceFaceSpecular(buf, { selfieLit: !!refHasFaceShine });
        const sr = sh.shineRatio != null ? sh.shineRatio.toFixed(3) : "null";
        console.log(
          `YÜZ PARLAMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
          `${sh.applied ? "ALINDI" : `ATLANDI[${sh.reason}]`} oran=${sr}` +
          `${sh.changed != null ? ` piksel=${sh.changed}` : ""} selfieIşık=${!!refHasFaceShine}`
        );
        if (sh.applied && sh.buf) buf = sh.buf;
      } catch (e) {
        console.error("OpenAI yolu: yüz parlama düzeltmesi hata verdi (atlanıyor):", e);
      }

      // TEN KAPISI — KARAR ÖLÇÜSÜ: "uzuvlar ÇIKTININ KENDİ YÜZÜYLE aynı tonda
      // mı?" (2026-09-06 kullanıcı kararı: "ten yüz ile aynı şekilde boyanacak,
      // aynıysa reddetme"). Uzuvlar zaten yukarıda yüz tonuna BOYANIYOR; boyama
      // sonrası kare kendi içinde tutarlıysa RED YOK.
      //
      // Hedef ton neden SELFIE DEĞİL: selfie tonu nötr ışıkta ölçülüyor, sahne
      // ışığı altındaki kareyi ona zorlamak farkı şişiriyor. Ölçüm yöntemi
      // (üç-noktalı taban/hedef karşılaştırması) ve eşiği (0.60) aynen korunuyor
      // — yalnızca hedef ton değişti. Selfie hedefli değer TEŞHİS için loglanır.
      try {
        const { assessSkinToneConsistency, measureFaceToneVsRef } = require("./faceQuality");
        // HEDEF TON = null → ÇIKTININ KENDİ YÜZÜ (bkz. assessSkinToneConsistency
        // başlığındaki refSkinTone açıklaması). Soru artık "selfie tonundan ne
        // kadar uzak" değil, "uzuvlar yüzle aynı mı".
        skinVsFace = await assessSkinToneConsistency(buf, tplBuf, null);
        const rt = skinVsFace.ratio != null ? skinVsFace.ratio.toFixed(3) : "null";
        // Teşhis: selfie hedefli eski ölçüm yalnızca loglanır, karar vermez.
        let selfieRatio = "null";
        if (!SIMPLE_PIPELINE) try {
          const st = await assessSkinToneConsistency(buf, tplBuf, refSkinTone);
          selfieRatio = st.ratio != null ? st.ratio.toFixed(3) : "null";
        } catch { /* teşhis ölçümü kareyi etkilemez */ }
        // Teşhis: "çıktının yüzü selfie tonunda mı?" — kullanıcının 3. maddesi.
        // Eşiği veriyle koyabilmek için önce yalnızca ölçülüp loglanıyor
        // (bkz. measureFaceToneVsRef başlığı).
        let faceVsSelfie = "null";
        if (!SIMPLE_PIPELINE) try {
          const fv = await measureFaceToneVsRef(buf, refSkinTone);
          if (fv) faceVsSelfie = fv.chroma.toFixed(1);
        } catch { /* teşhis ölçümü kareyi etkilemez */ }
        console.log(
          `TEN ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
          `${skinVsFace.ok ? (skinVsFace.reason ? `ÖLÇÜLEMEDİ[${skinVsFace.reason}]` : "GEÇTİ") : (SIMPLE_PIPELINE ? "UYARI[skin, sade akışta eleme yok]" : "RED[skin]")} ` +
          `yüzeGöreOran=${rt} örnek=${skinVsFace.sampled ?? "null"} ` +
          `(teşhis selfieHedef=${selfieRatio} yüzSelfieFarkı=${faceVsSelfie})`
        );
        // SADE AKIŞTA YALNIZ LOG (2026-11-04): bu kapı "uzuvlar yüzden farklı
        // tonda mı" sorusunu ham karede soruyor; sade akışın bitirme adımı
        // (postTasks.simpleFinish → skinTone yüz-kilitli düzeltme) tam olarak
        // bu farkı kapatıyor. 30 Ekim sonrası loglarda 4 kare bu kapıda
        // elendi, hepsi bitirme adımının düzelteceği türdendi; kare başı
        // ~0.13 $ boşa gidiyordu. Ölçüm kalıyor, karar kalkıyor.
        if (!skinVsFace.ok && !SIMPLE_PIPELINE) {
          lastRejectGate = "skin-tone";
          await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
            mode, gate: "skin-tone", distance: mathDist,
            detail: `yüzeGöreOran=${rt}`,
          });
          if (attempt < maxAttempts) continue;
          break;
        }
      } catch (e) {
        console.error("OpenAI yolu: ten rengi kontrolü hata verdi (bu katman atlanıyor):", e);
      }

      let visionOk = true;
      let visionDetail = null;
      let visionReason = null;
      let visionInconclusive = true;
      try {
        // Taban gönderiliyor: kafa boyutu ve bakış ölçümü ona göre yapılıyor.
        const v = await assessOutputWithVision(buf, faceRefUrls(refUrls), {
          baseImage: tplBuf,
        });
        visionOk = v.ok;
        visionDetail = v.detail;
        visionReason = v.reason;
        visionInconclusive = !!v.inconclusive;
        // Bakış reddinde ÖLÇÜLEN yönler bir sonraki denemenin düzeltici
        // uyarısına taşınır (bkz. retryCorrectionPrefix, 2026-09-14).
        if (v.gazeBase && v.gazeOut) lastGazeFacts = { base: v.gazeBase, out: v.gazeOut };
        // NOT: buradaki "GAZE_POINT reddi profilde geçersiz sayılır" yaması
        // 2026-09-16'da KALDIRILDI — çünkü GAZE_POINT kapısının kendisi
        // kaldırıldı (bkz. assessOutputWithVision içindeki gerekçe). Yama,
        // güvenilmez bir kapıyı yalnızca profil kafada susturuyordu; ölçüm
        // kapının profil dışında da kusur sınıfını gaze'den artefakta
        // çevirdiğini gösterdi, bu yüzden kapı tümden gitti ve yamaya
        // gerek kalmadı.
        console.log(`VISION ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${visionOk ? (visionInconclusive ? "KARARSIZ(kabul)" : "GEÇTİ") : "RED[" + visionReason + "]"}${visionDetail ? ` — "${visionDetail}"` : ""}`);
      } catch (e) {
        console.error("OpenAI yolu: Vision kontrolü hata verdi (fail-safe kabul):", e);
      }

      if (noFace && visionInconclusive) {
        // Yüz kutusu duruyorsa ölçememek "yüz yok" değildir (b64a0a65 c7 att1:
        // kafa aşağı telefona bakıyor, oran 0.173, vektör yok, kare sağlamdı).
        const hasFaceBox = mathFaceRatio != null && mathFaceRatio >= FACE_EVIDENCE_RATIO_MIN;
        if (!hasFaceBox) {
          console.warn(`KALITE: yüz tespit edilemedi VE Vision karar veremedi — kanıt yok, kare reddedildi (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt})`);
          // retryCorrectionPrefix bu kapıyı tanımaz (boş hint döner) — bilinçli:
          // "ölçemedim" modele söylenecek somut bir hata değil.
          lastRejectGate = "math-no-face+vision-inconclusive";
          await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
            mode, gate: "math-no-face+vision-inconclusive", distance: null,
          });
          if (attempt < maxAttempts) continue;
          break;
        }
        console.warn(`KALITE: vektör yok ama yüz kutusu var (oran=${mathFaceRatio.toFixed(3)}) — birleşik red yok, kare Vision kararsız-kabul ile devam (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt})`);
      }
      if (!visionOk && visionRejectionOverridden(visionReason, mathDist)) {
        console.warn(`VISION REDDİ GEÇERSİZ SAYILDI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): mesafe=${mathDist.toFixed(3)} < ${VISION_OVERRIDE_MAX_DISTANCE} — Vision "${visionDetail || "identity"}" demişti, sayısal kanıt güçlü olduğu için kare KABUL edildi`);
        visionOk = true;
      }
          // VISION KAFA BOYUTU REDDİ İÇİN SAYISAL HAKEM (2026-09-06).
          // Yeni kafa açıklığı ölçümü 77 geçmiş kare üzerinde denendi: 4 kareyi
          // eledi. Bu 4 karenin sayısal büyümesi 1.114 / 1.103 / 1.097 ve
          // 0.997 çıktı (genel medyan 1.02). Yani üçünde kafa gerçekten ~%10
          // büyümüştü, dördüncüsünde HİÇ büyüme yoktu — gözle bakıldığında da
          // o karede kafa normaldi, Vision yanılmıştı.
          // Kural: Vision "kafa büyük" derken sayısal ölçüm hiç büyüme
          // görmüyorsa red geçersiz sayılır. Ölçüm YAPILAMADIYSA hakem yok,
          // Vision'ın reddi aynen geçerli kalır.
          if (!visionOk && visionReason === "proportion" &&
              headGrowth != null && headGrowth < VISION_PROPORTION_GROWTH_MIN) {
            console.warn(
              `VISION KAFA REDDİ GEÇERSİZ SAYILDI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `büyüme=${headGrowth.toFixed(3)} < ${VISION_PROPORTION_GROWTH_MIN} — sayısal ölçüm kafada büyüme ` +
              `görmedi, Vision "${visionDetail || "kafa büyük"}" demişti, kare KABUL edildi`
            );
            visionOk = true;
          }
          // VISION TEN REDDİ ARTIK BAĞLAYICI DEĞİL (2026-09-06 kullanıcı kararı).
      // Gerçek vaka (job 1181577f): elegance c1 ve c3, HANDS_OR_ARMS_MISMATCH
      // ile elendi; kullanıcı iki karede de gözle ten sorunu olmadığını, ikisinin
      // de kabul edilmesi gerektiğini söyledi. Vision'ın bu sorusu ışık/gölgeyi
      // ton farkı sanabiliyor. Sayısal ölçüm (uzuv teni ↔ çıktının kendi yüzü)
      // "tutarlı" diyorsa Vision'ın ten reddi geçersiz sayılır. Hedef ve
      // taban yüz tonu ayırt edilemiyorsa (indistinguishable) hakem yine
      // geçer: sayısal kapı da fark görememiştir, Vision'ın ışık/gölgeyi
      // ton sanması bu durumda bağlanmaz (b1d6972b c4a3). Ölçüm YOKSA
      // (yüz yok / yetersiz örnek) hakem yok — Vision'ın reddi kalır.
      if (!visionOk && visionReason === "skin" &&
          skinVsFace && skinVsFace.ok &&
          (skinVsFace.ratio != null || skinVsFace.reason === "indistinguishable")) {
        const skinRef = skinVsFace.ratio != null
          ? `yüzeGöreOran=${skinVsFace.ratio.toFixed(3)}`
          : "neden=indistinguishable";
        console.warn(
          `VISION TEN REDDİ GEÇERSİZ SAYILDI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
          `${skinRef} — sayısal ölçüm teni tutarlı/ayırt-edilemez buldu, ` +
          `Vision "${visionDetail || "HANDS_OR_ARMS_MISMATCH"}" demişti, kare KABUL edildi`
        );
        visionOk = true;
      }
      // SADE AKIŞTA VISION TEN REDDİ DE ELEMEZ (2026-11-04 inceleme): sayısal
      // ten kapısı sade akışta yalnız log (yukarıda TEN ÖLÇÜM); Vision'ın
      // HANDS_OR_ARMS_MISMATCH reddi ise yalnız sayısal ölçüm "tutarlı"
      // dediğinde geçersiz sayılıyordu — yani sayısal kapının UYARI verdiği
      // kareler bu kez vision-skin olarak eleniyordu (arka kapı, bkz.
      // removed-gate-back-door). Ten farkını bitirme adımı (simpleFinish →
      // skinTone yüz-kilitli) kapatıyor; kullanıcı: "eleme yapmadan".
      if (!visionOk && visionReason === "skin" && SIMPLE_PIPELINE) {
        console.warn(
          `VISION TEN REDDİ YALNIZ LOG (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
          `sade akışta ten farkı elemez (bitirme adımı düzeltir), Vision "${visionDetail || "HANDS_OR_ARMS_MISMATCH"}" demişti, kare KABUL edildi`
        );
        visionOk = true;
      }
      // TAM KARE ARTEFAKT REDDİ DE ÖNCE ONARILIR (2026-09-18).
      //
      // Bu yol daha önce onarıma HİÇ uğramıyordu: aşağıdaki blok kareyi
      // doğrudan reddediyor ve `continue` ile bir sonraki denemeye geçiyordu,
      // yani onarımı yapan kırpma kapısına (çok aşağıda) hiç gelinmiyordu.
      // Ölçümde bu, 27 vision-artifact reddinin tamamının onarımsız yanması
      // demekti — oysa aynı onarım diğer yolda 30 denemenin 24'ünde yamayı
      // gideriyor.
      //
      // Yüz kutusu burada henüz hesaplanmamış (aşağıda, faceBoxForArtifact).
      // Bu yüzden yalnızca artefakt reddinde ve yalnızca bütçe varken bir
      // detectMainFace çağrısı yapılıyor — diğer red sebeplerinde bu blok
      // hiç çalışmaz, ek maliyet doğurmaz.
      if (!visionOk && visionReason === "artifact"
          && artifactRepairsUsed < ARTIFACT_REPAIR_MAX_PER_CHUNK) {
        try {
          const { detectMainFace } = require("./faceQuality");
          const fd = await detectMainFace(buf);
          if (!fd || !fd.box) {
            console.log(
              `YÜZ ONARIMI (tam kare) (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `ATLANDI[yüz-yok] — normal redde düşülüyor`
            );
          } else {
            artifactRepairsUsed++;
            const rr = await tryArtifactRepair({
              buf, faceBox: fd.box, apiKey: OPENAI_KEY.value(),
              refDescriptor, preDist: mathDist,
            });
            if (rr.ok) {
              buf = rr.buf;
              visionOk = true;
              console.log(
                `YÜZ ONARIMI (tam kare) (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
                `BAŞARILI — yama giderildi (Vision "${visionDetail || "PATCH"}", ` +
                `kimlik mesafesi=${rr.dist != null ? rr.dist.toFixed(3) : "ölçülmedi"}, ` +
                `bütçe ${artifactRepairsUsed}/${ARTIFACT_REPAIR_MAX_PER_CHUNK}), kare KABUL edildi`
              );
            } else {
              console.warn(
                `YÜZ ONARIMI (tam kare) (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
                `${rr.why} — normal redde düşülüyor ` +
                `(bütçe ${artifactRepairsUsed}/${ARTIFACT_REPAIR_MAX_PER_CHUNK})`
              );
            }
          }
        } catch (e) {
          console.error("Tam kare artefakt onarımı hata verdi (normal redde düşülüyor):", e.message || e);
        }
      }
      if (!visionOk) {
        const visionGate = `vision-${visionReason || "?"}`;
        // AYNI KAPI TEKRAR KIRICISI (2026-09-13, bkz. gateRejectCounts).
        // Kapı bu chunk'ta zaten sınıra ulaşmışsa red BAĞLAYICI DEĞİL.
        if (disabledGates.has(visionGate)) {
          console.warn(
            `VISION REDDİ ATLANDI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
            `"${visionGate}" kapısı bu chunk için devre dışı — Vision "${visionDetail || visionGate}" ` +
            `demişti, kare KABUL edildi`
          );
          visionOk = true;
        } else {
          recordGateRejection(visionGate);
          lastRejectGate = visionGate;
          // Tam-kare artefakt reddinde ayrı bir "bölge" satırı yok; gerekçe
          // metni ("Grey patch on forehead and nose") bölgeyi zaten içeriyor
          // ve bir sonraki denemenin uyarısına o taşınır.
          if (visionReason === "artifact") lastArtifactWhere = visionDetail || null;
          await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
            mode, gate: lastRejectGate, distance: mathDist, detail: visionDetail,
          });
          if (attempt < maxAttempts) continue;
          break;
        }
      }

      // DÖRDÜNCÜ KAPI — GÖZ AÇIKLIĞI (deterministik, göreceli).
      // Kullanıcı şikâyeti: çıktıda gözler yarı kapalı, kişi uykulu duruyor.
      // MUTLAK eşik YOK — çıktı, kişinin KENDİ referans selfie'lerindeki göz
      // açıklığıyla karşılaştırılır. Doğal dar gözlü kullanıcı böylece
      // cezalandırılmaz; yalnızca kendi normalinden belirgin kapalı çıkan
      // kareler (modelin artefaktı) elenir. Ölçülemezse kapı sessizce
      // devre dışı (fail-safe) — bkz. eyesLookClosedVsReference.
      try {
        const { eyesLookClosedVsReference } = require("./faceQuality");
        const oe = outEyeOpenness != null ? outEyeOpenness.toFixed(3) : "null";
        const re = refEyeOpenness != null ? refEyeOpenness.toFixed(3) : "null";
        const closed = eyesLookClosedVsReference(outEyeOpenness, refEyeOpenness);
        // GEÇEN kareler de loglanıyor — eşikler ancak gerçek dağılım
        // görülerek kalibre edilebilir (dosyadaki diğer kapılarla aynı usul).
        console.log(`GÖZ ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${closed ? "RED[eyes]" : (outEyeOpenness == null || refEyeOpenness == null ? "ÖLÇÜLEMEDİ" : "GEÇTİ")} çıktı=${oe} referans=${re}`);
        if (closed) {
          lastRejectGate = "eyes-closed";
          await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
            mode, gate: "eyes-closed", distance: mathDist,
            detail: `çıktı=${oe} referans=${re}`,
          });
          if (attempt < maxAttempts) continue;
          break;
        }
      } catch (e) {
        console.error("OpenAI yolu: göz açıklığı kontrolü hata verdi (bu katman atlanıyor):", e);
      }

      // YÜZ ARTEFAKT ÖLÇÜMÜ — ELEMİYOR, YALNIZCA LOGLUYOR (2026-09-13).
      //
      // Kullanıcı teslim edilmiş karelerde "yüzde boyalar/lekeler" bildirdi
      // (23eb1a78_2, f0bc4d5c_5, f0bc4d5c_3). Bu bir yanlış-KABUL: kusurlu
      // kare kullanıcıya gidiyor ve hiçbir mevcut kapı bunu görmüyor.
      //
      // SAYISAL ÖLÇÜM BAĞLAYICI DEĞİL — KALİBRE EDİLEMEDİ (2026-09-14).
      // 41 gerçek kare üzerinde, gözle DOĞRULANMIŞ sınıflarla ölçüldü ve iki
      // sınıf AYRILMADI: lekeli kareler %1.531/%0.644/%0.372/%0.193, temiz
      // kareler %0.365/%0.333/%0.145/%0.121 — iç içe geçmiş. Doluluk da
      // ayırmadı (lekeli 0.27-0.61, temiz 0.40-0.79). Hiçbir eşik hem lekeyi
      // yakalayıp hem temizi geçirmiyor; eleseydik düzeltmeye çalıştığımız
      // yanlış-red sorununun aynısını üretirdik.
      //
      // Kök sebep çözünürlük: lekeli karelerde yüz kutusu 90-95px, yani leke
      // 5x5 piksel; temiz karelerde yüz 120-157px ve doğal ten dokusu daha
      // çok piksel kaplıyor. Ölçüm "kaç piksel anormal" diyor ama
      // anormalliğin TÜRÜNÜ ayırt edemiyor.
      //
      // ELEME İŞİNİ ALTTAKİ KIRPMA KAPISI YAPIYOR. Bu ölçüm loglamaya devam
      // ediyor: daha iyi bir ölçüm (kenar keskinliği, doku analizi) denemek
      // için veri biriktiriyor — usul KONUM KAPISI/dx ve UZUV TEN ÖLÇÜMÜ
      // ile aynı (bkz. faceArtifact.js).
      //
      // fd (yüz kutusu) ALTTAKİ KAPIYA DA GEREKLİ — bir kez tespit edilip
      // ikisinde de kullanılıyor, ikinci bir detectMainFace çağrısı yok.
      let faceBoxForArtifact = null;
      try {
        const { measureFacePatch } = require("./faceArtifact");
        const { detectMainFace } = require("./faceQuality");
        const fd = await detectMainFace(buf);
        if (!fd || !fd.box) {
          console.log(`YÜZ ARTEFAKT ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[yüz-yok]`);
        } else {
          faceBoxForArtifact = fd.box;
          // Ölçüm yalnız log (elemez); sade akışta yalnız yüz kutusu alınır.
          const fp = SIMPLE_PIPELINE ? { ok: false, reason: "sade-akış" } : await measureFacePatch(buf, fd.box);
          if (!fp.ok) {
            console.log(`YÜZ ARTEFAKT ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${fp.reason}]`);
          } else {
            console.log(
              `YÜZ ARTEFAKT ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `leke=${(fp.fraction * 100).toFixed(3)}% px=${fp.px} ` +
              `doluluk=${fp.fill != null ? fp.fill.toFixed(2) : "null"} ` +
              `konum=${fp.at ? `(${fp.at.x.toFixed(2)},${fp.at.y.toFixed(2)})` : "yok"} ` +
              `tenL=${fp.skinL.toFixed(1)} tenKroma=${fp.skinChroma.toFixed(1)} [ELEMİYOR]`
            );
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: yüz artefakt ölçümü hata verdi (bu katman atlanıyor):", e);
      }

      // YÜZ ARTEFAKT KAPISI — YAKINLAŞTIRILMIŞ KIRPMA (2026-09-14). ELER.
      //
      // Tam karede sorulan FACE_ARTIFACT satırı (assessOutputWithVision,
      // 2026-09-13) bir kareyi yakaladı ama aynı gün 944d30fe_8'i KAÇIRDI —
      // kaşında gözle bariz beyaz yama vardı ve kare teslim edildi. Sebep
      // ölçek: 1170x1462'lik karede leke 5x5 piksel. Yüz kutusunu kırpıp
      // 768px'e büyütmek onu ~25x25 yapıyor.
      //
      // Yöntem limbBox.js'te kanıtlandı (bkz. o dosyanın başlığı): tam
      // karede model her kareye "SOLID" diyordu, kırpmada altı karenin
      // altısında doğru cevap verdi.
      //
      // FAIL-SAFE: yüz bulunamadı / kutu çok küçük / cevap okunamadı ->
      // kapı ELEMEZ. Dosyadaki tüm Vision kapılarıyla aynı yön.
      if (faceBoxForArtifact) {
        try {
          const { judgeFaceArtifact } = require("./faceArtifactCrop");
          const fa = await judgeFaceArtifact(buf, faceBoxForArtifact, OPENAI_KEY.value());
          if (!fa.ok) {
            console.log(`YÜZ ARTEFAKT KIRPMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${fa.reason}]`);
          } else if (fa.bad && disabledGates.has("face-artifact")) {
            console.warn(
              `YÜZ ARTEFAKT KIRPMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `RED ATLANDI — kapı bu chunk için devre dışı, kare KABUL edildi`
            );
          } else if (fa.bad) {
            // ÖNCE ONAR, SONRA RED (2026-09-17) — bkz. faceRepair.js başlığı.
            //
            // Bu kusuru ÖNLEMEK için üç teori denendi ve üçü de ölçümle
            // çürüdü (selfie flaşı / kenar dikişi / sayısal tespit). Kusur
            // modelin kendi üretim gürültüsü; prompt'la engellenemiyor.
            //
            // Ama kapı yamayı GÖRÜYOR ve yerini biliyor. Kareyi atıp baştan
            // üretmek yerine (tam üretim maliyeti + yeni kusur riski)
            // yalnızca yüz bölgesini maskeleyip yeniden çizdiriyoruz; poz,
            // kıyafet, arka plan ve kadraj maske dışında kaldığı için
            // piksel piksel korunuyor.
            //
            // Onarım CHUNK BAŞINA BÜTÇELİ (2026-09-18, eskiden tek seferlik):
            // bkz. ARTIFACT_REPAIR_MAX_PER_CHUNK başlığındaki ölçüm. Bütçe
            // dolduysa ya da onarım tutmazsa akış aşağıdaki normal redde
            // düşer — yani en kötü ihtimalle bugünkü davranış.
            let repaired = false;
            if (artifactRepairsUsed < ARTIFACT_REPAIR_MAX_PER_CHUNK) {
              artifactRepairsUsed++;
              const rr = await tryArtifactRepair({
                buf, faceBox: faceBoxForArtifact, apiKey: OPENAI_KEY.value(),
                refDescriptor, preDist: mathDist,
              });
              if (rr.ok) {
                buf = rr.buf;
                repaired = true;
                console.log(
                  `YÜZ ONARIMI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
                  `BAŞARILI — yama giderildi (önceki bölge="${fa.where}", ` +
                  `kimlik mesafesi=${rr.dist != null ? rr.dist.toFixed(3) : "ölçülmedi"}, ` +
                  `bütçe ${artifactRepairsUsed}/${ARTIFACT_REPAIR_MAX_PER_CHUNK}), kare KABUL edildi`
                );
              } else {
                console.warn(
                  `YÜZ ONARIMI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
                  `${rr.why} — normal redde düşülüyor ` +
                  `(bütçe ${artifactRepairsUsed}/${ARTIFACT_REPAIR_MAX_PER_CHUNK})`
                );
              }
            } else {
              console.log(
                `YÜZ ONARIMI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
                (ARTIFACT_REPAIR_MAX_PER_CHUNK === 0 ? "ATLANDI[kapalı]" : `ATLANDI — chunk onarım bütçesi doldu (${ARTIFACT_REPAIR_MAX_PER_CHUNK})`)
              );
            }
            if (repaired) {
              // Onarıldı: bu kapıdan geçmiş sayılır, akış normal şekilde
              // sonraki kapılara/kaydetmeye devam eder.
            } else {
            recordGateRejection("face-artifact");
            console.log(
              `YÜZ ARTEFAKT KIRPMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `RED[face-artifact] bölge="${fa.where}" gerekçe="${fa.detail}"`
            );
            lastRejectGate = "face-artifact";
            lastArtifactWhere = fa.where || null;
            await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
              mode, gate: "face-artifact", distance: mathDist,
              detail: `${fa.where || "?"} — ${fa.detail}`,
            });
            if (attempt < maxAttempts) continue;
            break;
            }
          } else {
            console.log(`YÜZ ARTEFAKT KIRPMA (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): GEÇTİ`);
          }
        } catch (e) {
          console.error("OpenAI yolu: yüz artefakt kırpma kapısı hata verdi (bu katman atlanıyor):", e);
        }
      }

      // UZUV KAPISI — hayalet/saydam el ELER, ten farkı yalnızca ÖLÇER.
      //
      // ESKİ KATMAN (measureLimbSharpness) KALDIRILDI: "en büyük ten
      // bileşenini" uzuv sayıyordu ve şikâyet edilen iki karede oranı 0.85 ve
      // 0.68 ölçtü — 101 karelik gerçek dağılımın p75'inin ÜSTÜ. Ölçtüğü şey
      // silik el değil, keskin boyun/göğüstü idi. Yerine konum bilgisi
      // dışarıdan alınıyor (bkz. limbBox.js başlığı: Person kutusuna kırpma +
      // numaralı ızgara; altı karenin altısında uzvu doğru buldu).
      //
      // ELEME YALNIZCA KIRPMA YARGISINDAN: hayalet el saydamlık kusuru olduğu
      // için Laplacian onu göremiyor (chunk 1'in hayalet eli yüz cildinden
      // 2.53 kat "keskin" ölçüldü). Yakınlaştırılmış kırpmada sorulan soru ise
      // altı karenin altısında doğru cevap verdi.
      //
      // TEN FARKI ELEMİYOR: sinyal kromada değil AÇIKLIKTA (şikâyet edilen üç
      // karede 7.3 / 9.2 / 9.8, temiz karelerde 0.4 / 4.0), ama kask karesi
      // aradaki bantta ve altı kare eşiğe yetmez. Gerçek dağılım toplanana
      // kadar bağlayıcı DEĞİL — KONUM KAPISI/dx'in izlediği aynı yol.
      // SADE AKIŞTA ATLANIR: kutuların tek etkili kullanıcısı el tonu
      // düzeltmesiydi (kapalı); geri kalanı yalnız log, kare başına gpt-4o +
      // Google Vision çağrısı.
      if (!SIMPLE_PIPELINE) try {
        const { locateLimbRegions, googleObjectAnnotator } = require("./limbBox");
        const { measureLimbRegion } = require("./faceQuality");
        const loc = await locateLimbRegions(buf, OPENAI_KEY.value(), googleObjectAnnotator());
        if (!loc.ok) {
          console.log(`UZUV KONUM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${loc.reason}]`);
        } else if (!loc.boxes.length) {
          console.log(`UZUV KONUM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): görünür çıplak uzuv YOK`);
        } else {
          const m = await measureLimbRegion(buf, loc.boxes);
          if (!m.ok) {
            console.log(`UZUV TEN ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${m.reason}]`);
          } else {
            console.log(
              `UZUV TEN ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `açıklıkFarkı=${m.maxDeltaL != null ? m.maxDeltaL.toFixed(1) : "null"} ` +
              `kroma=${m.maxChroma != null ? m.maxChroma.toFixed(1) : "null"} ` +
              `yüzeGöreNetlik=${m.worstRatio != null ? m.worstRatio.toFixed(2) : "null"} ` +
              `bölge=${m.regions.length} uzuvPx=${m.regions.map((r) => r.skinPx).join("/")}`
            );
          }
          // ================================================================
          // UZUV KIRPMA YARGISI (limb-ghost) KALDIRILDI — 2026-09-14
          // ================================================================
          //
          // KULLANICI KARARI, GERÇEK VERİYE DAYANIYOR. Kapı, doğruladığımız
          // DÖRT vakanın dördünde de YANLIŞ eledi:
          //   • 0c609c0e c3/c8 — "Fingers appear fused or duplicated"
          //     (kullanıcı: eller net ve kusursuz)
          //   • f483d510 c7   — "Hand structure is unclear or malformed"
          //     (kullanıcı: "eli bile gözükmüyor, elleri cepte")
          //   • 78e53593 c0   — "Fingers appear fused or duplicated"
          //     (kullanıcı: bardak tutan el, parmaklar ayrı ve doğru)
          //
          // 2026-09-13'te iki onarım denendi (NOT_VISIBLE sınıfı + görünürlük
          // doğrulaması, ve ikinci-görüş hakemi) ama kapının temel sorunu
          // onarılabilir değil: model, SAYDAM NESNE TUTAN eli (bardak, şişe,
          // cam) sistematik olarak "kaynaşmış/çoğalmış parmak" sanıyor —
          // camın içinden görünen parmaklar gerçek fotoğrafın doğal
          // görüntüsü. Yanlış-red maliyeti (kullanıcı kare kaybediyor +
          // OpenAI kredisi yanıyor) ispatlanmış; buna karşılık kapının
          // yakaladığı GERÇEK hayalet el vakası hiç doğrulanamadı.
          //
          // BOŞLUK OLUŞMUYOR — aynı kusuru gören İKİ Vision satırı duruyor
          // ve ikisi de bağlayıcı (aynı çağrı, ek maliyet yok):
          //   • HAND_QUALITY: BLURRY_OR_MALFORMED -> "hands" reddi
          //     (2026-08-13, tam da "el silik/bulanık çıktı" şikâyeti için)
          //   • BODY_INTEGRITY: TRANSPARENT_OR_GHOSTED -> "ghosting" reddi
          //     (2026-09-06, "kol yarı saydam, korkuluk içinden görünüyor")
          //
          // UZUV TEN ÖLÇÜMÜ (yukarıda) KALIYOR: zaten elemiyordu, yalnızca
          // ölçüp logluyor ve gelecekte kalibre edilebilecek veri biriktiriyor.
          // locateLimbRegions de kalıyor — ten ölçümü onun kutularını kullanıyor.

          // EL TONU DÜZELTMESİ (2026-09-18) — ELEMEZ, DÜZELTİR.
          //
          // KULLANICI ŞİKÂYETİ: üç TESLİM EDİLMİŞ karede eller taban kişinin
          // eli gibi kalmış. İki farklı kullanıcının aynı sahnesindeki eller
          // BİREBİR AYNI çıktı — model şablonun ellerine dokunmuyor.
          //
          // NEDEN BURADA: locateLimbRegions'ın kutuları tam burada hazır ve
          // ek maliyeti yok (aynı çağrı ten ölçümü için zaten yapılıyor).
          // Ten araması YALNIZCA bu kutuların içinde yapılır; kum, gökyüzü
          // ve kıyafet kutunun dışında kaldığı için boyanamaz.
          //
          // NEDEN ELEME DEĞİL DÜZELTME: eşik koyup reddetmek ölçüldü ve
          // 385 karenin %37'sini elerdi — ret zaten asıl maliyet kalemi.
          // SADE AKIŞTA atlanır: kutunun içi kaydırılınca 60d42504 c6'da
          // göğüste dikdörtgen ten lekesi kaldı.
          if (!SIMPLE_PIPELINE) try {
            const { correctHandToneInBoxes } = require("./faceQuality");
            const hc = await correctHandToneInBoxes(buf, loc.boxes);
            console.log(
              `EL TONU DÜZELTME (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `${hc.applied ? "UYGULANDI" : `ATLANDI[${hc.reason}]`} ` +
              `yüzeGöreAçıklık=${hc.deltaLBefore != null ? hc.deltaLBefore.toFixed(1) : "null"}` +
              `${hc.applied ? ` -> ${hc.deltaLAfter.toFixed(1)} kaymaL=${hc.shiftL.toFixed(1)} kutu=${hc.boxesFixed}` : ""}` +
              // Kumaş koruması ölçülüyor: kaç kutu "el değil yüzey" diye
              // atlandı ve boyanan alan yüzün kaç katı (bkz. faceQuality.js
              // kumaş koruması başlığı). Eşikler ancak bu dağılım görülerek
              // kalibre edilebilir — dosyadaki diğer kapılarla aynı usul.
              `${hc.skippedFabric ? ` kumaşAtlanan=${hc.skippedFabric}` : ""}` +
              `${hc.areaVsFace != null ? ` alanYüzeGöre=${hc.areaVsFace.toFixed(2)}` : ""}`
            );
            if (hc.applied && hc.buf) buf = hc.buf;
          } catch (e) {
            console.error("OpenAI yolu: el tonu düzeltmesi hata verdi (atlanıyor):", e);
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: uzuv kapısı hata verdi (bu katman atlanıyor):", e);
      }

      // BEŞİNCİ KAPI — KAFA YERLEŞİMİ (dx, deterministik). tplBuf ile AYNI
      // (kırpılmış) koordinat uzayında ölçülür — bkz. measureHeadPlacement
      // başlığı: kırpılmışı kırpılmamışla kıyaslamak kaymayı yanlış ölçer.
      // Yalnızca dx elenir (en temiz sinyal — dy pitch'ten etkilenir, dy'nin
      // kendisi bu yüzden bağlayıcı DEĞİL, yalnızca loglanır).
      //
      // PITCH FARKI DA LOGLANIYOR (2026-08-13, henüz ELEMEYEN ek ölçüm):
      // dy'yi tek başına kapı yapmak riskli çünkü kafa pitch'i (yukarı/aşağı
      // eğim) ŞABLONDAN FARKLI OLABİLİR — bu bir hata değil, prompt'un
      // bilerek izin verdiği bir şey ("only the head's angle/gaze may
      // differ"). dy'deki bir sapmanın gerçek kayma mı yoksa meşru pitch
      // farkı mı olduğunu ayırt edebilmek için pitchFarkı = pitch - şablon
      // pitch de burada loglanıyor. Yaw'da yaptığımız gibi (ayrı ölç, kapıla,
      // sonra dx'i güvenle kullan) — dy için de aynı yolu izleyebilmek için
      // önce (pitchFarkı, dy) çiftlerinin gerçek dağılımını görmemiz lazım.
      try {
        const { measureHeadPlacement, PROFILE_UNRELIABLE_MIN } = require("./faceQuality");
        const p = await measureHeadPlacement(buf, tplBuf);
        // no-face-* RED KURALI GERİ ALINDI (2026-08-22, KULLANICI GÖRSEL
        // DOĞRULAMASI). 2026-08-21'de burayı "yüz yok -> RED" yapmıştım;
        // bir gün sonraki üretimde İKİ yanlış pozitif verdi ve kullanıcı
        // her ikisinin de gözle GAYET İYİ olduğunu doğruladı:
        //
        //  • no-face-template (chunk=6/deneme=2): tespit edilemeyen yüz
        //    ÇIKTIDA değil, BİZİM ŞABLONUMUZDAydı (log: YAW şablon=null,
        //    ŞABLON KIRPILDI 0.123->0.17). Çıktının kendisi sorunsuzdu —
        //    kimlik 0.315, Vision GEÇTİ, göz/el/kroma temiz. Kendi şablon
        //    havuzumuzdaki bir tespit sorunu için KULLANICININ karesini
        //    atmak yanlış; ölçüm yapılamaması kusur kanıtı değildir.
        //
        //  • no-face-output (chunk=6/deneme=3): burada zaten DOĞRU tasarım
        //    yukarıda mevcuttu — assessOutputFace "no-face"i sert ret DEĞİL,
        //    "dedektörüm göremedi" sayıp kararı Vision'a devrediyor (bkz.
        //    2717-2741, güneş gözlüklü kare olayı). Ben o gerekçeli tasarımı
        //    burada eziyordum.
        //
        // 2026-08-21'deki chunk=8 vakasını yanlış teşhis etmişim: oradaki
        // gerçek kusur sinyali netlik=69.8 (aşırı bulanık) idi, "yüz yok"
        // değil. Ayrıca Vision artık kararsız kalmıyor (self/ref ayrımından
        // sonra 10/10 karar verdi), dolayısıyla "yüz yok" karelerini Vision'a
        // devretmek güvenli: gerçekten kör kalınan durumu aşağıdaki
        // "noFace && visionInconclusive" kuralı zaten yakalıyor.
        if (!p.ok) {
          console.log(`KONUM KAPISI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${p.reason}]`);
        } else {
          // PROFİL İSTİSNASI (2026-09-08 gerçek olay, job aaf8b1ea c2_att4):
          // dx, yüz kutusunun merkezinden hesaplanıyor — kafa yüksek derecede
          // yana dönükken (yaw kimlik/yaw kapısındaki PROFILE_UNRELIABLE_MIN
          // eşiğini aşınca) kutunun görünen kısmı asimetrikleşir ve merkez
          // kayar. Bu karede pitchFarkı=-2.96 (normalde ±0.05 civarı) zaten
          // aynı landmark bozulmasını gösteriyordu — kullanıcı görsel
          // karşılaştırmada kareyi kabul edilebilir buldu. dx de aynı
          // ölçüm ailesinden olduğu için profilde ona da güvenilmiyor.
          const yawUnreliable = (p.yaw != null && p.yaw > PROFILE_UNRELIABLE_MIN) ||
                                 (p.tplYaw != null && p.tplYaw > PROFILE_UNRELIABLE_MIN);
          const bad = !yawUnreliable && Math.abs(p.dx) > OUTPUT_HEAD_DX_MAX;
          const pitchFarki = (p.pitch != null && p.tplPitch != null) ? (p.pitch - p.tplPitch) : null;
          console.log(`KONUM KAPISI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ${yawUnreliable ? "ÖLÇÜLEMEDİ[profile]" : (bad ? "RED[head-dx]" : "GEÇTİ")} dx=${p.dx.toFixed(2)} dy=${p.dy.toFixed(2)} pitchFarkı=${pitchFarki != null ? pitchFarki.toFixed(2) : "null"} eşik=${OUTPUT_HEAD_DX_MAX}`);
          if (bad) {
            lastRejectGate = "head-dx";
            await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
              mode, gate: "head-dx", distance: mathDist,
              detail: `dx=${p.dx.toFixed(2)}`,
            });
            if (attempt < maxAttempts) continue;
            break;
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: kafa yerleşimi kapısı hata verdi (bu katman atlanıyor):", e);
      }
    }

    // KAFA ÇEVRESİ KALINTI KAPISI (2026-10-10) — bkz. headGhost.js. Şablon
    // kişisinden kafanın çevresinde kalan iz (saç halesi, saç teli, gözlük
    // camı, saydam profil). Diğer BÜTÜN kapılardan sonra: yalnızca kabul
    // edilecek kare için sorulur. Yorum kapısı — aynı chunk'ta
    // GATE_REPEAT_DISABLE_AFTER kez elerse bu chunk için devre dışı kalır.
    // FAIL-SAFE: yüz yok / cevap okunamadı -> ELEMEZ.
    // 2026-11-06 KAPATILDI (bkz. HEAD_GHOST_GATE_ON).
    if (!HEAD_GHOST_GATE_ON) {
      // Kapı yok: iz ghostClean + ghostDetect ile son adımda temizlenir.
    } else if (!disabledGates.has("head-ghost")) {
      try {
        const { judgeHeadGhost } = require("./headGhost");
        const { detectMainFace } = require("./faceQuality");
        const tplForGhost = Buffer.isBuffer(templateInput) ? templateInput : templateSourceBuf;
        const fd = (await detectMainFace(buf)) || (await detectMainFace(buf, LOW_CONF_FACE));
        if (!fd || !fd.box || !Buffer.isBuffer(tplForGhost)) {
          console.log(`KAFA KALINTI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${!fd || !fd.box ? "yüz-yok" : "şablon-yok"}]`);
        } else {
          const gh = await judgeHeadGhost(buf, tplForGhost, fd.box, OPENAI_KEY.value());
          if (!gh.ok) {
            console.log(`KAFA KALINTI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI[${gh.reason}]`);
          } else if (gh.bad) {
            recordGateRejection("head-ghost");
            console.log(
              `KAFA KALINTI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ` +
              `RED[head-ghost] bölge="${gh.where}" gerekçe="${gh.detail}"`
            );
            lastRejectGate = "head-ghost";
            await saveRejectedFrame(uid, jobId, styleId, chunkIdx, attempt, buf, {
              mode, gate: "head-ghost", distance: mathDist,
              detail: `${gh.where || "?"} — ${gh.detail}`,
            });
            if (attempt < maxAttempts) continue;
            break;
          } else {
            console.log(`KAFA KALINTI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): GEÇTİ`);
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: kafa kalıntı kapısı hata verdi (bu katman atlanıyor):", e);
      }
    } else {
      console.warn(`KAFA KALINTI (style=${styleId}, chunk=${chunkIdx}, deneme=${attempt}): ATLANDI — kapı bu chunk için devre dışı`);
    }

    finalBuf = buf;
    break;
  }

  // Geçen kare yoksa son reddedilen kare bitirilip kendi yoluna yazılır
  // (bkz. CHUNK_LAST_REJECTED).
  let rejectedFinishPath = null;
  if (!finalBuf) {
    const lr = FINISH_REJECTED_FRAMES ? CHUNK_LAST_REJECTED.get(chunkTemplateKey(jobId, styleId, chunkIdx)) : null;
    if (!lr) {
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      return;
    }
    finalBuf = lr.buf;
    rejectedFinishPath = lr.path;
    console.log(`REDDEDİLEN KARE BİTİRİLİYOR (style=${styleId}, chunk=${chunkIdx}): kapı=${lr.gate} → ${lr.path}`);
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
    let recompositedOk = false;
    // ŞABLONDA ŞAPKA (bkz. HAT_PROMPT_ON): geri yerleştirme maskesi + bitirme koruması.
    const tplHatFin = templateHatP ? await templateHatP : null;
    const hatKeepMask = tplHatFin && tplHatFin.hat && tplHatFin.maskPng
      ? { png: Buffer.isBuffer(tplHatFin.maskPng) ? tplHatFin.maskPng : Buffer.from(tplHatFin.maskPng), fwFrac: tplHatFin.fwFrac }
      : null;
    // ŞABLONA HİZALAMA (2026-10-08, 9d9507f0 c0 — bkz. align.js): model tuvali
    // kaydırıp büyüttüyse çıktı şablon koordinatlarına geri çekilir. Kırpılan
    // şablonda geri yerleştirmeden ÖNCE (kırpılmış tuvallerin karşılaştırması),
    // kırpılmayanda en-boy düzeltmesinden SONRA yapılır.
    const alignStep = async (buf, tpl, where) => {
      try {
        const { alignToTemplate } = require("./align");
        const a = await alignToTemplate(buf, tpl);
        const n = (v, d = 3) => (v != null ? v.toFixed(d) : "null");
        console.log(`HİZALAMA (style=${styleId}, chunk=${chunkIdx}, ${where}): ${a.applied ? "UYGULANDI" : `ATLANDI[${a.reason}]`} ölçek=${n(a.s)} kayma=${n(a.tx, 1)},${n(a.ty, 1)} iyileşme=${n(a.gain, 2)}`);
        return a.applied && a.buf ? a.buf : buf;
      } catch (e) {
        console.error("OpenAI yolu: hizalama hata verdi (atlanıyor):", e);
        return buf;
      }
    };
    if (restore && Buffer.isBuffer(templateInput)) {
      deliverBuf = await alignStep(deliverBuf, templateInput, "kırpılmış");
    }
    // Geri yerleştirilen karenin şablonu: tuval büyütüldüyse (bkz.
    // postProcess.recompositeScale) aynı boyuta getirilmiş orijinal.
    let tplOriginal = restore ? restore.originalBuf : null;
    if (restore) {
      const { recompositeScale } = require("./postProcess");
      let scale = 1;
      try {
        scale = recompositeScale((await require("sharp")(deliverBuf).metadata()).width, restore.geo);
      } catch (e) {
        console.error("OpenAI yolu: geri yerleştirme ölçeği ölçülemedi (orijinal boyut):", e.message || e);
      }
      let recomposited = await recompositeIntoOriginal(deliverBuf, restore.originalBuf, restore.geo, { scale, keepMask: hatKeepMask, logTag: ` (style=${styleId}, chunk=${chunkIdx})` });
      if (recomposited && scale !== 1) {
        try {
          tplOriginal = await require("sharp")(restore.originalBuf).resize(Math.round(restore.geo.imgW * scale), Math.round(restore.geo.imgH * scale), { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
        } catch (e) {
          console.error("OpenAI yolu: şablon büyütülemedi (orijinal boyutta geri yerleştiriliyor):", e.message || e);
          scale = 1;
          recomposited = await recompositeIntoOriginal(deliverBuf, restore.originalBuf, restore.geo, { keepMask: hatKeepMask, logTag: ` (style=${styleId}, chunk=${chunkIdx})` });
        }
      }
      if (recomposited) {
        deliverBuf = recomposited;
        recompositedOk = true;
        console.log(`ŞABLON GERİ YERLEŞTİRİLDİ (style=${styleId}, chunk=${chunkIdx}): ${scale === 1 ? "orijinal boyuta döndürüldü" : `tuval ×${scale.toFixed(2)} (${Math.round(restore.geo.imgW * scale)}x${Math.round(restore.geo.imgH * scale)})`}`);
      } else {
        console.warn(`ŞABLON GERİ YERLEŞTİRME BAŞARISIZ (style=${styleId}, chunk=${chunkIdx}) — kırpılmış sonuç kullanılıyor`);
      }
    }

    // EN-BOY ORANI GERİ ALMA (2026-10-08, bb2cc441 c2). Boyut parametresi
    // gönderilmiyor; model şablonu kendi seçtiği orana GERİYOR (şablon 0.800,
    // çıktı 0.755). Ölçüldü: çıktıyı şablon oranına geri germek arka planı
    // örtüştürüyor, kırpmak örtüştürmüyor. Gerilmiş kare hem kafayı dikeyde
    // büyük gösteriyor hem de arka plan geri yüklemesini (en-boy uyuşmazlığı)
    // ve kafa ölçeğini bozuyordu. Kırpılan şablonlar geri yerleştirmede zaten
    // böyle boyutlanıyor; burada yalnızca kırpma yapılmamış kareler.
    if (!recompositedOk) {
      try {
        const tplForAspect = restore ? (Buffer.isBuffer(templateInput) ? templateInput : null) : templateSourceBuf;
        if (tplForAspect) {
          const sharp = require("sharp");
          const [om, tm] = await Promise.all([sharp(deliverBuf).metadata(), sharp(tplForAspect).metadata()]);
          const swap = (tm.orientation || 1) >= 5;
          const tAspect = swap ? tm.height / tm.width : tm.width / tm.height;
          const oAspect = om.width / om.height;
          if (Math.abs(oAspect - tAspect) > 0.005 * tAspect) {
            const h = Math.round(om.width / tAspect);
            deliverBuf = await sharp(deliverBuf).resize(om.width, h, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
            console.log(`EN-BOY DÜZELTİLDİ (style=${styleId}, chunk=${chunkIdx}): ${om.width}x${om.height} (${oAspect.toFixed(3)}) -> ${om.width}x${h} (şablon ${tAspect.toFixed(3)})`);
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: en-boy geri alma hata verdi (atlanıyor):", e);
      }
      if (!restore && templateSourceBuf) deliverBuf = await alignStep(deliverBuf, templateSourceBuf, "tam kare");
    }

    // SİYAH-BEYAZ ŞABLON (bkz. faceLight.matchGrayscale).
    try {
      const tplForGray = recompositedOk ? tplOriginal : (restore ? (Buffer.isBuffer(templateInput) ? templateInput : null) : templateSourceBuf);
      if (tplForGray) {
        const { matchGrayscale } = require("./faceLight");
        const g = await matchGrayscale(deliverBuf, tplForGray);
        if (g.applied && g.buf) {
          deliverBuf = g.buf;
          console.log(`SİYAH-BEYAZ (style=${styleId}, chunk=${chunkIdx}): UYGULANDI şablonDoygunluk=${g.satT.toFixed(1)} çıktıDoygunluk=${g.satO.toFixed(1)}`);
        }
      }
    } catch (e) {
      console.error("OpenAI yolu: siyah-beyaz eşleme hata verdi (atlanıyor):", e);
    }

    // KAFA YERLEŞİMİ ÖLÇÜMÜ — yalnızca ÖLÇER, hiçbir kareyi elemez, hiçbir
    // pikseli değiştirmez (bkz. measureHeadPlacement başlığı: "önde/arkada"
    // en az üç ayrı nedenden olabilir, hangisi olduğu bilinmeden düzeltme
    // yazmak yanlış problemi çözme riskidir).
    //
    // KOORDİNAT UZAYI EŞLEŞMESİ ZORUNLU: kırpılmış çıktıyı kırpılmamış
    // şablonla karşılaştırmak, kırpmanın geometri dönüşümünü "kayma" sanmaya
    // yol açar. Bu yüzden şablon eşi, çıktının HANGİ uzayda olduğuna göre
    // seçiliyor; doğru eş yoksa ölçüm sessizce yanlış referansla yapılmaz,
    // atlanır ve sebebi loglanır. Sade akışta ölçülmez (yalnız log).
    if (!SIMPLE_PIPELINE) try {
      const { measureHeadPlacement } = require("./faceQuality");
      let refTpl = null;
      if (recompositedOk) refTpl = tplOriginal;            // ikisi de orijinal uzayda
      else if (restore) refTpl = Buffer.isBuffer(templateInput) ? templateInput : null; // ikisi de kırpılmış
      else refTpl = templateSourceBuf;                              // hiç kırpma olmadı
      if (!refTpl) {
        console.log(`KONUM ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}): ATLANDI[no-original]`);
      } else {
        const p = await measureHeadPlacement(deliverBuf, refTpl);
        const n = (v, d = 2) => (v != null ? v.toFixed(d) : "null");
        if (!p.ok) {
          console.log(`KONUM ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${p.reason}]`);
        } else {
          // dx/dy birimi: ŞABLONUN YÜZ GENİŞLİĞİ. dx>0 sağa, dy>0 aşağı kaymış.
          // dx en temiz sinyal; dy pitch'ten etkilenir (bkz. başlıktaki tuzak).
          console.log(`KONUM ÖLÇÜM (style=${styleId}, chunk=${chunkIdx}): dx=${n(p.dx)} dy=${n(p.dy)} ölçek=${n(p.scale)} pitch=${n(p.pitch)} yaw=${n(p.yaw)} [şablon: pitch=${n(p.tplPitch)} yaw=${n(p.tplYaw)}]`);
        }
      }
    } catch (e) {
      console.error("OpenAI yolu: kafa yerleşimi ölçümü hata verdi (atlanıyor):", e);
    }

    // AĞIR SON KATMANLAR SIRAYLA (2026-10-08, bellek aşımı olayı — bkz.
    // POST_LAYER_LOCK): kafa ölçeği ve ten alanı tam çözünürlüklü kopyalar
    // ve segmentasyon modelleri kullanır; paralel chunk'lar aynı anda
    // girince süreç 2GiB'ı aştı.
    // ŞABLON GÖZLÜĞÜ — kafa ölçeğinden ÖNCE sorulur (2026-10-10, 790bd56b
    // c1): gözlüklü şablonda göz noktaları camın altında kayıyor, yüz oranı
    // parçaları birbirini tutmuyor (gözÇene 0.96, kaşBurun 1.16) ve kafa
    // gereksiz yere 0.93'e küçültüldü. Gözlük varsa kafa ölçeği gözsüz
    // ölçüyle yapılır (3cd612ba'da tamamen atlamak c1/c2/c9'u büyük bıraktı).
    // Sonuç GÖZLÜK EN SON adımında da kullanılır.
    // Kapılardan geçti: bu karenin zorunlu maliyet payının kalanı isteğe
    // bağlı son adımlara açılır (bkz. jobContext).
    releaseMandatoryReserve();
    let tplForEyewear = null;
    if (recompositedOk) tplForEyewear = tplOriginal;
    else if (restore) tplForEyewear = Buffer.isBuffer(templateInput) ? templateInput : null;
    else tplForEyewear = templateSourceBuf;
    // SADE AKIŞTA DA AÇIK (2026-10-29 son kontrol, kullanıcı 10-19: "gözlüklü
    // fotoğrafları gözlüksüz göstermeyelim"): dar maskeli, en son, kafanın
    // yerine/boyuna/tenine dokunmaz.
    let templateEyewear = { ok: false, reason: "no-template" };
    let tplFaceBox = null;
    // Üretimden önce aynı şablon kişisi için sorulduysa (bkz. EYEWEAR_GAZE_PROMPT_ON) Vision yeniden
    // sorulmaz — kırpım ya da orijinal, kişi aynı. Yüz kutusu (yerel) yine bu kare için bulunur.
    if (Buffer.isBuffer(tplForEyewear)) {
      try {
        const { detectMainFace } = require("./faceQuality");
        const { judgeEyewear } = require("./headGhost");
        const fdT = (await detectMainFace(tplForEyewear)) || (await detectMainFace(tplForEyewear, LOW_CONF_FACE));
        tplFaceBox = fdT && fdT.box ? fdT.box : null;
        templateEyewear = templateEyewearPre && templateEyewearPre.ok ? templateEyewearPre
          : tplFaceBox ? await judgeEyewear(tplForEyewear, tplFaceBox, OPENAI_KEY.value()) : { ok: false, reason: "no-face-template" };
      } catch (e) {
        console.error("OpenAI yolu: şablon gözlük yargısı hata verdi:", e);
        templateEyewear = { ok: false, reason: "error" };
      }
    }
    const tplHasEyewear = templateEyewear.ok && templateEyewear.eyewear === true;
    // ŞABLON PİGMENTİ (bkz. skinPigment.js): sade akışın yüz sahne ışığı ya da
    // eski akışın pozlaması için; selfie pigmenti yoksa sorulmaz — kare başına
    // bir küçük çağrı (gpt-4.1-mini, düşük çözünürlük).
    // 2026-11-19: sade akışta tek tüketicisi yüz sahne ışığıydı (postTasks FINISH.FACE_TONE kapalı);
    // kare başına ücretli, zaman aşımsız çağrı boşuna yapılmasın.
    let tplSkinMst = null;
    if (((SIMPLE_PIPELINE && TPL_MST_FOR_FACE_TONE) || require("./faceRelight").EXPOSURE_ON) && refSkinMst && tplFaceBox) {
      tplSkinMst = await require("./skinPigment").estimateMst([tplForEyewear], OPENAI_KEY.value(), [tplFaceBox]);
      console.log(`ŞABLON TEN PİGMENTİ (style=${styleId}, chunk=${chunkIdx}): ${tplSkinMst != null ? `MST ${tplSkinMst}` : "ölçülemedi"} kullanıcı=MST ${refSkinMst}`);
    }

    // GÖZ AÇIKLIĞI (2026-10-27, bkz. eyeOpen.js): yüz netliğinden ÖNCE —
    // bükmenin çift doğrusal örneklemesi irisi hafif yumuşatıyor, GFPGAN onu
    // geri keskinleştirir. Gözlük en son eklendiği için burada göz açık.
    if (EYE_OPEN_ON) {
      try {
        if (jobTimeLeftMs() < EYE_OPEN_MIN_LEFT_MS) {
          console.log(`GÖZ AÇIKLIĞI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const t0 = Date.now();
          const eo = await require("./eyeOpen").openEyes(deliverBuf, refDescriptor);
          if (eo.applied && eo.buf) deliverBuf = eo.buf;
          const n = (v) => (v != null ? v.toFixed(3) : "null");
          console.log(`GÖZ AÇIKLIĞI (style=${styleId}, chunk=${chunkIdx}): ${eo.applied ? "UYGULANDI" : `ATLANDI[${eo.reason}]`} açıklık=${n(eo.ap)} kaldırma=${n(eo.lift)} kimlik=${n(eo.id0)}→${n(eo.id1)} ${Date.now() - t0}ms`);
        }
      } catch (e) {
        console.error("OpenAI yolu: göz açıklığı hata verdi (atlanıyor):", e);
      }
    }

    // YÜZ NETLİĞİ (2026-10-26, bkz. faceRestore.js): ışık/ten/detay
    // katmanlarından ÖNCE — yüz ışığı ve gren eşleme onarılmış yüzde çalışır
    // (sonra koşsa yüz detayı katmanının eklediği greni siler).
    if (FACE_RESTORE_ON) {
      try {
        if (jobTimeLeftMs() < FACE_RESTORE_MIN_LEFT_MS) {
          console.log(`YÜZ NETLİĞİ (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const { restoreFace } = require("./faceRestore");
          const fr = await restoreFace(deliverBuf, refDescriptor);
          if (fr.applied && fr.buf) deliverBuf = fr.buf;
          const n = (v) => (v != null ? v.toFixed(3) : "null");
          const denenen = (fr.tried || []).map((t) => `${t.blend}:${n(t.id)}`).join(" ");
          console.log(`YÜZ NETLİĞİ (style=${styleId}, chunk=${chunkIdx}): ${fr.applied ? `UYGULANDI güç=${fr.blend}` : `ATLANDI[${fr.reason}]`} kimlik=${n(fr.id0)}${denenen ? ` denenen=${denenen}` : ""}${fr.ms != null ? ` ${fr.ms}ms` : ""}`);
        }
      } catch (e) {
        console.error("OpenAI yolu: yüz netliği hata verdi (atlanıyor):", e);
      }
    }

    // TEN ALANI, YÜZ DETAYI, ARKA PLAN GERİ YÜKLEME, SİYAH-BEYAZ SON — tek
    // görev (bkz. postTasks.layers; açıklamalar orada). Worker havuzu varsa
    // kareler paralel, yoksa eskisi gibi kilitte sırayla.
    let bgRestored = false;
    // Sade akışta da (2026-11-01, 831a00a4): "kafa küçük/basık" modelden mi son
    // adımlardan mı, ham kare olmadan ayrılamadı.
    if (DEBUG_SAVE_PRE_LAYERS && (await debugSaveAllowed(uid))) {
      bucket()
        .file(`dating_debug/layers/${uid}/${jobId}/raw_c${chunkIdx}.jpg`)
        .save(deliverBuf, { metadata: { contentType: "image/jpeg" } })
        .catch((e) => console.error("IŞIK DEBUG: katman öncesi kare kaydı başarısız (atlanıyor):", e));
    }
    if (SIMPLE_PIPELINE) {
      // SADE AKIŞIN SON ADIMLARI (2026-10-30, bkz. postTasks.simpleFinish):
      // şablon kafası izi (selfie kafa çizgisi dışındaki şablon saçı/şapkası,
      // yerel LaMa), kafa bükme (boy), yüz sahne ışığı (parlaklık, renk, ışık
      // yönü), yüz detayı (keskinlik + gren). Eski katmanlar (ışık/ten alanı,
      // arka plan geri yükleme, kafa ölçeği + dolgu) kapalı kalır.
      try {
        // Şablon izi temizliği worker'da LaMa kullanır: model ana iş
        // parçacığında bir kez iner (bkz. lamaFill.ensureModel).
        try {
          await require("./lamaFill").ensureModel();
        } catch (e) {
          console.error("OpenAI yolu: LaMa modeli indirilemedi (şablon izi temizliği atlanabilir):", e.message || e);
        }
        // BİTİRME SONRASI KİMLİK ÖLÇÜMÜ (2026-11-04): kapılar ham kareyi
        // ölçüyor, teslim edilen kare ise bitirme adımlarından (kafa bükme,
        // yüz tonu, ten, yüz detayı, gözlük) geçmiş hâli. Bu adımların yüzü
        // bozup bozmadığı hiç ölçülmüyordu. Önce/sonra aynı ölçümle (face-api
        // mesafesi) karşılaştırılır; her karede loglanır. GERİ ALMA yalnız
        // açık gerilemede: mesafe hem eşiğin üstüne çıkmış hem de hamdan
        // FINISH_REGRESS_DELTA'dan fazla artmışsa, ya da bitirme sonrası yüz
        // artık bulunamıyorsa ham kare teslim edilir. Ölçüm hatası akışı
        // durdurmaz.
        const rawBeforeFinish = deliverBuf;
        let dBefore = null;
        if (refDescriptor) try {
          const q0 = await require("./faceQuality").assessOutputFace(deliverBuf, refDescriptor);
          dBefore = q0.distance;
        } catch { /* ölçüm yoksa geri alma kararı verilmez */ }
        const r = await runPostTask("simpleFinish", {
          buf: deliverBuf, tpl: Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null, styleId, chunkIdx,
          templateEyewear: tplHasEyewear, mstUser: refSkinMst, mstTpl: tplSkinMst,
          refUrls: Array.isArray(refUrls) ? refUrls : null, jobKey: `${uid}/${jobId}`,
          refDescriptor: refDescriptor ? Array.from(refDescriptor) : null,
          hairErased: CHUNK_HAIR_ERASED.has(chunkTemplateKey(jobId, styleId, chunkIdx)),
          deadline: Number.isFinite(jobTimeLeftMs()) ? Date.now() + jobTimeLeftMs() : null,
          templateHat: !!(tplHatFin && tplHatFin.hat),
        });
        if (r && r.buf) deliverBuf = Buffer.isBuffer(r.buf) ? r.buf : Buffer.from(r.buf);
        if (refDescriptor && r && r.buf) try {
          const fq = require("./faceQuality");
          const q1 = await fq.assessOutputFace(deliverBuf, refDescriptor);
          const dAfter = q1.distance;
          const delta = dBefore != null && dAfter != null ? dAfter - dBefore : null;
          const lostFace = dBefore != null && q1.reason === "no-face";
          const regressed = delta != null && delta > FINISH_REGRESS_DELTA && dAfter > fq.FACE_MATCH_THRESHOLD;
          const f3 = (v) => (v != null ? v.toFixed(3) : "null");
          const verdict = lostFace ? "GERİ ALINDI[yüz-kayboldu]" : regressed ? "GERİ ALINDI[kimlik-geriledi]" : (delta == null ? "ÖLÇÜLEMEDİ" : "GEÇTİ");
          console.log(`BİTİRME KİMLİK (style=${styleId}, chunk=${chunkIdx}): ${verdict} önce=${f3(dBefore)} sonra=${f3(dAfter)} fark=${f3(delta)} eşik=${fq.FACE_MATCH_THRESHOLD} izinliArtış=${FINISH_REGRESS_DELTA}`);
          if (lostFace || regressed) {
            deliverBuf = rawBeforeFinish;
            CHUNK_FINISH_REGRESSED.add(chunkTemplateKey(jobId, styleId, chunkIdx));
          }
        } catch (e) {
          console.error("Bitirme sonrası kimlik ölçümü hata verdi (kare bitirilmiş hâliyle kalıyor):", e.message || e);
        }
        // EL ONARIMI (2026-11-20, bkz. handRepair.js): şablon kişisi kullanıcıdan koyu tenliyse
        // görünen el/kol/göğüs derisi maskeli düzenlemeyle kullanıcının tenine çizilir.
        // Bütçe ayırması + mutlak tavan; sığmazsa ya da doğrulama tutmazsa kare olduğu gibi.
        await handRepairStep({ buf: deliverBuf, tpl: tplForEyewear, chunkIdx, styleId, rawBuf: rawBeforeFinish, mstUser: refSkinMst, mstTpl: tplSkinMst, rejected: !!rejectedFinishPath })
          .then((b) => { if (b) deliverBuf = b; });
      } catch (e) {
        console.error("OpenAI yolu: sade akış son adımları hata verdi (atlanıyor):", e);
        // Kare bitirme adımlarından geçmeden (ham) teslim ediliyor — panelde görünsün.
        CHUNK_FINISH_REGRESSED.add(chunkTemplateKey(jobId, styleId, chunkIdx));
        if (/süre sınırı/.test(String(e && e.message))) {
          console.warn(`BİTİRME ATLANDI[süre] (style=${styleId}, chunk=${chunkIdx}): ${e.message} kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        }
      }
    } else try {
      const r = await runPostTask("layers", {
        buf: deliverBuf, tpl: Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null, styleId, chunkIdx,
        faceLight: FACE_LIGHT_TRANSFER, templateEyewear: tplHasEyewear, skinLight: refSkinLight,
        mstUser: refSkinMst, mstTpl: tplSkinMst,
      });
      deliverBuf = r.buf;
      bgRestored = r.bgRestored;
    } catch (e) {
      console.error("OpenAI yolu: son katmanlar hata verdi (atlanıyor):", e);
    }

    // KAFA ÖLÇEĞİ ARKA PLANDAN SONRA (2026-10-11, d44b63e8): küçültmenin
    // açtığı delik böylece şablonun gerçek arka planıyla çevrili olur ve kafa
    // çevresi temizliğiyle TEK AI çağrısında dolar (eskiden iki ayrı çağrı;
    // ikisi de kafanın çevresinde farklı tonlu/tırtıklı izler bırakıyordu).
    const preScaleBuf = deliverBuf;
    let pendingScale = null;
    // KAFA ÖLÇEĞİ DÜZELTMESİ (2026-10-07, kullanıcı kararı: elemek yerine
    // çöz). Kafa yüz noktalarıyla ölçülür ve şablondaki kafayla aynı boya
    // getirilir (bkz. headScale.js). Emin olunamayan her durumda (omuz kadraj
    // dışı, kafa başka bir şeye değiyor, sahne yeniden kadrajlanmış)
    // dokunulmaz. Gözlüklü şablonda göz noktaları kullanılmaz, yalnız
    // küçültülür (bkz. headScale eyewearFaceRatio — 3cd612ba c1/c2/c9).
    if (!SIMPLE_PIPELINE) try {
      if (!Buffer.isBuffer(tplForEyewear)) {
        console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[no-template]`);
      } else {
        const hs = await runPostTask("headScale", { buf: deliverBuf, tpl: tplForEyewear, templateEyewear: tplHasEyewear });
        if (hs.applied && DEBUG_HEAD_SCALE_BEFORE && (await debugSaveAllowed(uid))) {
          // GEÇİCİ TEŞHİS (2026-10-13, kullanıcı: "küçültmeden önceki hali de
          // kaydedelim"). Üretimde kabul edilen karelerde küçültme ÖNCESİ hiç
          // saklanmıyordu — yalnızca reddedilenler dating_rejected'a yazılıyordu
          // (bkz. saveRejectedFrame). Fail-safe: hata üretimi etkilemez.
          bucket()
            .file(`dating_debug/headscale/${uid}/${jobId}/pre_c${chunkIdx}.jpg`)
            .save(preScaleBuf, { metadata: { contentType: "image/jpeg" } })
            .catch((e) => console.error("KAFA ÖLÇEK DEBUG: önce-kare kaydı başarısız (atlanıyor):", e));
        }
        if (hs.applied && hs.inpaint) {
          pendingScale = { hs, ölçü: `${hs.ölçü} ${hs.delik}`, tpl: tplForEyewear };
        } else if (hs.applied) {
          // Delik yok (büyütme ya da dolgu gerekmeyen küçültme).
          deliverBuf = hs.buf;
          console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${hs.ölçü} ${hs.delik}`);
        } else {
          console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${hs.reason}] ${hs.ölçü}`);
        }
      }
    } catch (e) {
      console.error("OpenAI yolu: kafa ölçeği düzeltmesi hata verdi (atlanıyor):", e);
    }

    // KAFA ÇEVRESİ (2026-10-11, iş d44b63e8, kullanıcı: "kafanın üst
    // kısmındaki silüetlenme, renklenme, küçültmeden dolayı oynama gibi
    // problemleri kesin olarak çözmeliyiz"). Arka plan, şablon kafasının
    // silüeti dışında şablondan geldi; kafanın çevresinde dolgu yalnızca
    // gerçek kusura girer: küçültmenin açtığı delik, hayalet saç, saçak
    // telleri (bkz. headSurround.js). Kusur yoksa dolgu yapılmaz. Dolgu
    // başarısızsa kafa küçültülmez, kare geri yüklenmiş hâliyle kalır.
    // Retry yok. Gözlükten ÖNCE (yüzün dışına taşan camı silmesin).
    // YEREL DOLGU (2026-10-12, e0eb8dd5): OpenAI yerine LaMa (bkz.
    // lamaFill.js) — OpenAI dolgusu kayma kapısında reddedilip c4/c8'i
    // küçültmesiz bıraktı, kabul edilenlerde yay (c1) ve boyanmış saç (c7)
    // kaldı. Yerel model maske dışını değiştirmediği için kapı yok.
    if (bgRestored) {
      const scaled = pendingScale;
      pendingScale = null;
      try {
        const base = scaled ? scaled.hs.buf : deliverBuf;
        const sf = await runPostTask("surroundPrep", { buf: base, tpl: Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null, extraHole: scaled ? scaled.hs.holeMask : null, newHead: scaled ? scaled.hs.headMask : null });
        const sp = `şerit=${sf.bandPx ?? "null"} delik=${sf.holePx ?? 0} hayalet=${sf.ghostPx ?? "null"} saçak=${sf.fringePx ?? "null"} saydamHayalet=${sf.sheerPx ?? 0} şablonKafası=${sf.tplPx ?? "yok"} yüzOvalindeKorunan=${sf.ovalPx ?? 0} şablonDışıSaç=${sf.userHairPx ?? 0}`;
        let fin = null;
        let why = null;
        if (!sf.applied) {
          why = sf.reason;
          console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${why}] ${sp}`);
        } else if (jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
          why = "süre-bütçesi";
          console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${why}] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn ${sp}`);
        } else {
          fin = await fillHeadJobLocally(sf.inpaint.job, sf.inpaint.base);
          why = fin.reason;
          console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): ${fin.buf ? "TEMİZLENDİ" : `ATLANDI[${why}]`} ${sp} ${fin.k}`);
          if (fin.buf && DEBUG_SAVE_SURROUND_FILL && (await debugSaveAllowed(uid))) {
            bucket()
              .file(`dating_debug/surround/${uid}/${jobId}/fill1_c${chunkIdx}.png`)
              .save(fin.buf, { metadata: { contentType: "image/png" } })
              .catch((e) => console.error("KAFA ÇEVRESİ DEBUG: ilk dolgu kaydı başarısız (atlanıyor):", e));
          }
          // Kalıntı kapısından ÖNCE: ince hayalet kalıntısı küçültmeyi geri aldırmasın.
          if (fin.buf) fin.buf = await secondSurroundPass(fin.buf, Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null, styleId, chunkIdx);
        }
        // Temizlenecek kusur yoksa (küçültme de yok) kare olduğu gibi kalır.
        let out = fin && fin.buf ? fin.buf : (!scaled ? deliverBuf : null);
        if (scaled) {
          // KÜÇÜLTME SONRASI KALINTI (2026-10-10): model kafayı eski boyunda
          // çizip iz bıraktıysa küçültme geri alınır. Kapı bu chunk'ta devre
          // dışıysa (ham karede de iz görüyordu) sorulmaz.
          let ghost = null;
          if (out && Buffer.isBuffer(scaled.tpl) && !disabledGates.has("head-ghost")) {
            ghost = await judgeScaledHead(out, scaled.tpl, preScaleBuf);
          }
          const gk = ghost ? (ghost.ok ? (ghost.bad ? `kalıntı=VAR(${ghost.where}: ${ghost.detail})` : "kalıntı=yok") : `kalıntı=ölçülemedi[${ghost.reason}]`) : "kalıntı=sorulmadı";
          if (!out) {
            console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[çevre-${why}] ${scaled.ölçü}`);
          } else if (ghost && ghost.ok && ghost.bad) {
            console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[ghost-after-scale] ${scaled.ölçü} ${gk}`);
            out = null;
            // Küçültme reddedildi ama plan kafayı geriye/dike de alıyordu:
            // küçültmesiz yeniden dene (bkz. alignOnlyAfterResidue).
            if (scaled.hs.moves && scaled.hs.s != null && scaled.hs.s < 1) {
              out = await alignOnlyAfterResidue(preScaleBuf, scaled.tpl, tplHasEyewear, styleId, chunkIdx);
            }
          } else {
            console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${scaled.ölçü} ${gk}`);
          }
        }
        if (out) {
          deliverBuf = out;
          // Gri şablonda dolgu renk getirmesin (SİYAH-BEYAZ SON bundan önceydi).
          if (fin && fin.buf && Buffer.isBuffer(tplForEyewear)) {
            const { matchGrayscale } = require("./faceLight");
            const g = await matchGrayscale(deliverBuf, tplForEyewear);
            if (g.applied && g.buf) deliverBuf = g.buf;
          }
        } else {
          deliverBuf = preScaleBuf;
          // KÜÇÜLTME REDDİNDE TEMİZLİK KAYBOLMASIN (2026-10-17, 0eeb75c8 c11/c12):
          // küçültme kalıntı yüzünden geri alınınca kare çevre temizliğinden
          // ÖNCEKİ hâline dönüyordu — şablon kafasının hayaleti (c12 gri saç,
          // c11 camda koyu yansıma) teslime kaldı. Kafa küçültülmeden, yalnız
          // kusurlara (hayalet/saçak) aynı temizlik yeniden uygulanır.
          if (scaled) {
            if (jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
              console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): KÜÇÜLTMESİZ ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
            } else {
              const sf2 = await runPostTask("surroundPrep", { buf: preScaleBuf, tpl: Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null });
              const sp2 = `şerit=${sf2.bandPx ?? "null"} hayalet=${sf2.ghostPx ?? "null"} saçak=${sf2.fringePx ?? "null"} yüzOvalindeKorunan=${sf2.ovalPx ?? 0} şablonDışıSaç=${sf2.userHairPx ?? 0}`;
              if (!sf2.applied) {
                console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): KÜÇÜLTMESİZ ATLANDI[${sf2.reason}] ${sp2}`);
              } else {
                const fin2 = await fillHeadJobLocally(sf2.inpaint.job, sf2.inpaint.base);
                if (fin2.buf) fin2.buf = await secondSurroundPass(fin2.buf, Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null, styleId, chunkIdx);
                if (fin2.buf) {
                  deliverBuf = fin2.buf;
                  if (Buffer.isBuffer(tplForEyewear)) {
                    const { matchGrayscale } = require("./faceLight");
                    const g = await matchGrayscale(deliverBuf, tplForEyewear);
                    if (g.applied && g.buf) deliverBuf = g.buf;
                  }
                }
                console.log(`KAFA ÇEVRESİ (style=${styleId}, chunk=${chunkIdx}): KÜÇÜLTMESİZ ${fin2.buf ? "TEMİZLENDİ" : `ATLANDI[${fin2.reason}]`} ${sp2} ${fin2.k}`);
              }
            }
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: kafa çevresi hata verdi (atlanıyor):", e);
        deliverBuf = preScaleBuf;
      }
    }

    // GERİ YÜKLEME YOKSA (sahne yeniden kadrajlanmış vb.) eski yol: KAFA
    // KÜÇÜLTME DOLGUSU (2026-10-12'den beri yerel LaMa, bkz. lamaFill.js).
    // Başarısızlıkta kafa küçültülmez (kullanıcı kararı: retry yok, bozuk
    // dolgu yerine dokunulmamış kare).
    if (pendingScale && jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
      console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn ${pendingScale.ölçü}`);
      pendingScale = null;
    }
    if (pendingScale) {
      const { hs, ölçü, tpl } = pendingScale;
      pendingScale = null;
      try {
        const fin = await fillHeadJobLocally(hs.inpaint.job, hs.inpaint.base);
        const k = fin.k;
        // KÜÇÜLTME SONRASI KALINTI (2026-10-10): dolgu kafanın yanında iz
        // bırakmışsa (model kafayı eski boyunda çizdi) küçültme geri alınır.
        // Ham kare kalıntı kapısından geçtiği için iz küçültmeden gelir. Kapı
        // bu chunk'ta devre dışıysa (ham karede de iz görüyordu) sorulmaz.
        let ghost = null;
        if (fin.buf && Buffer.isBuffer(tpl) && !disabledGates.has("head-ghost")) {
          ghost = await judgeScaledHead(fin.buf, tpl, preScaleBuf);
        }
        const gk = ghost ? (ghost.ok ? (ghost.bad ? `kalıntı=VAR(${ghost.where}: ${ghost.detail})` : "kalıntı=yok") : `kalıntı=ölçülemedi[${ghost.reason}]`) : "kalıntı=sorulmadı";
        if (fin.buf && ghost && ghost.ok && ghost.bad) {
          console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[ghost-after-scale] ${ölçü} ${k} ${gk}`);
        } else if (fin.buf) {
          deliverBuf = fin.buf;
          console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${ölçü} ${k} ${gk}`);
        } else {
          console.log(`KAFA ÖLÇEK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fin.reason}] ${ölçü} ${k}`);
        }
      } catch (e) {
        console.error("OpenAI yolu: kafa dolgusu hata verdi (küçültülmedi):", e);
      }
    }

    // KAFA SAÇAĞI TEMİZLİĞİ — yalnız arka plan geri yüklenemediyse (geri
    // yüklendiyse KAFA ÇEVRESİ yaptı). 790bd56b: c0 şablonun kıvırcık saç
    // telleri yeni kafanın üstünde kaldı, c2 yüzün yanında ikinci yüz kenarı
    // (bkz. headScale prepareHeadFringeRepaint). FAIL-SAFE, retry yok.
    try {
      if (!SIMPLE_PIPELINE && !bgRestored && Buffer.isBuffer(tplForEyewear)) {
        if (jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
          console.log(`KAFA SAÇAĞI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const fr = await runPostTask("fringePrep", { buf: deliverBuf, tpl: tplForEyewear });
          if (!fr.applied) {
            console.log(`KAFA SAÇAĞI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fr.reason}]${fr.bodyIou != null ? ` gövdeIoU=${fr.bodyIou.toFixed(3)}` : ""}`);
          } else {
            const ai = await inpaintHeadHoleWithOpenAI(fr.inpaint.image, fr.inpaint.mask, HEAD_FRINGE_PROMPT);
            const fin = Buffer.isBuffer(ai) ? await runPostTask("finishInpaint", { job: fr.inpaint.job, ai, base: fr.inpaint.base }) : { buf: null, reason: (ai && ai.skipped) || "inpaint-failed" };
            const k = `delikPx=${fr.holePx} saçakPx=${fr.fringePx} hayaletPx=${fr.ghostPx ?? "null"} kayma=${fin.shift != null ? fin.shift.toFixed(1) : "null"} kenarUyumsuz=${fin.resid != null ? fin.resid.toFixed(2) : "null"} delikteKişi=${fin.person != null ? fin.person.toFixed(3) : "null"} dokuDolgusu=${fin.fallback != null ? fin.fallback.toFixed(3) : "null"}`;
            if (fin.buf) {
              deliverBuf = fin.buf;
              console.log(`KAFA SAÇAĞI (style=${styleId}, chunk=${chunkIdx}): TEMİZLENDİ ${k}`);
              const { matchGrayscale } = require("./faceLight");
              const g = await matchGrayscale(deliverBuf, tplForEyewear);
              if (g.applied && g.buf) deliverBuf = g.buf;
            } else {
              console.log(`KAFA SAÇAĞI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fin.reason}] ${k}`);
            }
          }
        }
      }
    } catch (e) {
      console.error("OpenAI yolu: kafa saçağı temizliği hata verdi (atlanıyor):", e);
    }

    // BUKLE KALINTISI (2026-10-26, 9987f742 c5, kullanıcı: "base fotonun
    // saçından kalıntı kendi saçımla birleşmiş"; bkz. curlRemnant.js):
    // şablonun içinden arka plan görünen buklesi kullanıcının saçına
    // eklendiyse yerel LaMa onu çevresindeki saçla kapatır. Yalnız şablonda
    // böyle bir halka varsa çıktıya bakılır. Kafa çevresinden SONRA (kafanın
    // yeri bitti), selfie detayı ve gözlükten ÖNCE. Şablon kareyle hizalı
    // olmalı (arka plan geri yüklendi). Yerel, ücretsiz, retry yok.
    if (bgRestored && Buffer.isBuffer(tplForEyewear)) {
      try {
        if (CHUNK_HAIR_ERASED.has(chunkTemplateKey(jobId, styleId, chunkIdx))) {
          console.log(`BUKLE KALINTISI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[şablon-saçı-silindi]`);
        } else if (jobTimeLeftMs() < POST_AI_MIN_LEFT_MS) {
          console.log(`BUKLE KALINTISI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const cr = await runPostTask("curlRemnantPrep", { buf: deliverBuf, tpl: tplForEyewear });
          const k = `şablonHalkası=${cr.loops ?? "null"} kapalıDelik=${cr.holes ?? 0} açıkSaç=${cr.lights ?? 0} dolgu=${cr.holePx ?? 0}px/${cr.fillFace2 != null ? cr.fillFace2.toFixed(3) : "null"}yüz² çıktıDelik=${cr.outHolePx ?? "null"} şablonDelik=${cr.tplHolePx ?? "null"}`;
          if (!cr.applied) {
            console.log(`BUKLE KALINTISI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${cr.reason}] ${k}`);
          } else {
            const fin = await fillHeadJobLocally(cr.inpaint.job, cr.inpaint.base);
            if (fin.buf) {
              deliverBuf = fin.buf;
              // Gri şablonda dolgu renk getirmesin.
              const { matchGrayscale } = require("./faceLight");
              const g = await matchGrayscale(deliverBuf, tplForEyewear);
              if (g.applied && g.buf) deliverBuf = g.buf;
            }
            console.log(`BUKLE KALINTISI (style=${styleId}, chunk=${chunkIdx}): ${fin.buf ? "TEMİZLENDİ" : `ATLANDI[${fin.reason}]`} ${k} ${fin.k}`);
          }
        }
      } catch (e) {
        console.error("OpenAI yolu: bukle kalıntısı hata verdi (atlanıyor):", e);
      }
    }

    // SELFIE'DEN YÜZ DETAYI (2026-10-22, bkz. faceDetailTransfer.js): yüzün
    // yeri ve boyu bittikten sonra (kafa ölçeği, çevre dolguları), gözlükten
    // ÖNCE (camın/çerçevenin üstüne selfie dokusu binmesin). Yerel, ücretsiz.
    if (SELFIE_DETAIL_ON) {
      try {
        if (jobTimeLeftMs() < SELFIE_DETAIL_MIN_LEFT_MS) {
          console.log(`YÜZ DETAYI SELFIE (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const selfies = (await Promise.all(faceRefUrls(refUrls).map(async (u) => {
            try {
              if (Buffer.isBuffer(u)) return u;
              const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
              return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
            } catch (e) {
              console.error("Yüz detayı: selfie indirilemedi (atlanıyor):", e.message || e);
              return null;
            }
          }))).filter(Boolean);
          const sd = await runPostTask("selfieDetail", { buf: deliverBuf, selfies });
          if (sd.applied && sd.buf) deliverBuf = sd.buf;
          console.log(`YÜZ DETAYI SELFIE (style=${styleId}, chunk=${chunkIdx}): ${sd.applied ? "UYGULANDI" : `ATLANDI[${sd.reason}]`} ${sd.ölçü}`);
        }
      } catch (e) {
        console.error("OpenAI yolu: selfie yüz detayı hata verdi (atlanıyor):", e);
      }
    }

    // KULAKLIK (2026-10-25, bkz. earbuds.js): prompt'un kaçırdığı kulak içi
    // kulaklık, yüz yeri bittikten sonra silinir. Gözlükten önce (gözlük
    // dolgusu kulağa yakın çerçeveyi etkilemesin).
    if (EARBUD_REMOVE_ON) {
      try {
        if (jobTimeLeftMs() < EARBUD_MIN_LEFT_MS) {
          console.log(`KULAKLIK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const { removeEarbuds } = require("./earbuds");
          const eb = await removeEarbuds(deliverBuf);
          if (eb.applied && eb.buf) deliverBuf = eb.buf;
          const kutu = eb.found.map((f) => `${f.score.toFixed(2)}@${Math.round(f.cx)},${Math.round(f.cy)}/${Math.round(f.w)}px`).join(" ");
          console.log(`KULAKLIK (style=${styleId}, chunk=${chunkIdx}): ${eb.applied ? `SİLİNDİ ${kutu}` : `YOK[${eb.reason}]${eb.best != null ? ` enYüksek=${eb.best.toFixed(3)}` : ""}`}`);
        }
      } catch (e) {
        console.error("OpenAI yolu: kulaklık silme hata verdi (atlanıyor):", e);
      }
    }

    // DOĞRULANMIŞ KARE (2026-11-04, bkz. finalCheck.js): bu noktaya kadar
    // yüz kimlik/geometri ölçümlerinden geçti. Gözlük, ışıklı katman ve
    // doku bundan sonra; teslimden önce son kare bununla karşılaştırılır ve
    // bozulma varsa bu kare (ışıksız) teslim edilir. Gözlük eklenmiş karede
    // yalnız bozuk dosya/boyut değişikliği geri alınır (aşağıda SON DOĞRULAMA).
    const verifiedBuf = deliverBuf;
    let eyewearApplied = false;

    // GÖZLÜK EN SON (2026-10-10, kullanıcı kararı: "önce yüz şekli tamamen
    // bitsin, gözlüğü en son ekle"). Ana üretim gözlüğü her zaman kaldırır;
    // kimlik, kafa ölçeği ve yüz katmanları gözlüksüz yüzde çalıştı. Şablonda
    // gözlük varsa şablonun gözlüğü burada, bitmiş yüze eklenir (bkz.
    // eyewear.js). FAIL-SAFE: yargı/ekleme başarısızsa kare gözlüksüz teslim
    // edilir, retry yok.
    try {
      if (!EYEWEAR_ADD_ON) {
        console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): KAPALI[tüm çıktılar gözlüksüz] şablonda=${templateEyewear.ok ? (templateEyewear.eyewear ? "var" : "yok") : "?"}`);
      } else if (Buffer.isBuffer(tplForEyewear)) {
        const ew = templateEyewear; // kafa ölçeğinden önce soruldu
        if (!ew.ok) {
          console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[şablon-belirlenemedi:${ew.reason || "?"}]`);
        } else if (!ew.eyewear) {
          console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): şablonda yok`);
        } else if (SUNGLASS_TRANSFER_ON && ew.eyesVisible === false && await (async () => {
          // KOYU CAM: base'in kendi gözlüğü taşınır (bkz. sunglassTransfer.js);
          // olmazsa aşağıdaki yapay zeka yolu.
          try {
            const st = await runPostTask("sunglassTransfer", { buf: deliverBuf, tpl: tplForEyewear });
            if (st && st.applied && st.buf) {
              // CAMDAN GÖZ İKİNCİ YARGI (2026-11-06, bkz. headGhost.judgeLensEyes):
              // ana yargı renkli camda yanlış NO diyebiliyor (12 yapay koyu tonun
              // 11'inde, 7e04933e c4'te NO); taşıma yalnız iki camı kapsayan
              // büyütülmüş bantta da iki cam NO ise. Hata / zaman aşımı / okunamadı
              // / MAYBE -> taşıma yok, yapay zeka yolu. keepEyes eşlemesi değişmez
              // ('own' yalnız ana yargı YES'te; koyu camda 'own' camı saydamlaştırdı,
              // bkz. eyewear.keepOwnEyes). Yalnız taşıma uygulanacakken: ~$0.0011.
              // BİLİNEN AÇIK: d87c25b4 c6'da göz camdan görünürken iki kez NO/NO
              // dedi; kesin çözüm değil, ek güvenlik ağı.
              let lj = { ok: false, reason: "süre-bütçesi", eyesThrough: null };
              if (jobTimeLeftMs() >= LENS_JUDGE_MIN_LEFT_MS) {
                try {
                  const { judgeLensEyes, lensBandRect } = require("./headGhost");
                  const { faceLandmarks } = require("./faceQuality");
                  const lm = (await faceLandmarks(tplForEyewear)) || (await faceLandmarks(tplForEyewear, LOW_CONF_FACE));
                  const meta = await require("sharp")(tplForEyewear).metadata();
                  const band = lensBandRect(lm ? lm.pts : null, (lm && lm.box) || tplFaceBox, meta.width, meta.height);
                  // Zaman aşımı kalan süreyle sınırlı (en az 3 sn, en çok 20 sn).
                  const timeoutMs = Math.max(3000, Math.min(LENS_JUDGE_MAX_TIMEOUT_MS, jobTimeLeftMs() - 2000));
                  lj = band ? await judgeLensEyes(tplForEyewear, band, OPENAI_KEY.value(), { timeoutMs }) : { ok: false, reason: "no-band", eyesThrough: null };
                } catch (e) {
                  console.error("Gözlük cam göz yargısı hata verdi (taşıma yok):", e.message || e);
                  lj = { ok: false, reason: "error", eyesThrough: null };
                }
              }
              if (!require("./headGhost").lensJudgeAllowsTransfer(lj)) {
                // Yapay zeka yolu EYEWEAR_MIN_LEFT_MS altında çalışmıyor: o zaman
                // kare gözlüksüz gider (base gözü taşımaktansa). Ayrı yazılır ki
                // yargının yol açtığı gözlüksüz teslimler sayılabilsin.
                const noTime = jobTimeLeftMs() < EYEWEAR_MIN_LEFT_MS;
                console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): taşıma ATLANDI[lens-judge] cam=${lj.lenses ? lj.lenses.join("/") : `?(${lj.reason || "?"})`} ham="${lj.raw || ""}" yaw=${st.yawT != null ? st.yawT.toFixed(0) : "?"}/${st.yawO != null ? st.yawO.toFixed(0) : "?"} kalan=${Math.round(jobTimeLeftMs() / 1000)}sn — ${noTime ? "süre yok, gözlüksüz" : "yapay zeka yolu"}`);
                return false;
              }
              deliverBuf = Buffer.from(st.buf);
              eyewearApplied = true;
              console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): BASE'DEN TAŞINDI camPx=${st.lensPx} gözArası=${Math.round(st.iod)}px yaw=${st.yawT != null ? st.yawT.toFixed(0) : "?"}/${st.yawO != null ? st.yawO.toFixed(0) : "?"} kısalma=${st.foreshorten != null ? st.foreshorten.toFixed(3) : "null"} kapsama=${(st.cover || []).map((c) => (c == null ? "-" : c.toFixed(2))).join("/")} dışPay=${st.outFrac != null ? st.outFrac.toFixed(2) : "null"} kapalıKoyu=${st.holePx ?? 0} gri=${st.grayOut ? "evet" : "hayır"}${st && st.eyeSpread ? ` gözYayılım=${st.eyeSpread.map((v) => (v == null ? "-" : v.toFixed(1))).join("/")}` : ""} camYargı=${lj.lenses.join("/")} ham="${lj.raw || ""}" ${st.ms}ms`);
              return true;
            }
            console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): taşıma ATLANDI[${st ? st.reason : "?"}] yaw=${st && st.yawT != null ? st.yawT.toFixed(0) : "?"}/${st && st.yawO != null ? st.yawO.toFixed(0) : "?"}${st && st.foreshorten != null ? ` kısalma=${st.foreshorten.toFixed(3)}` : ""}${st && st.cover ? ` kapsama=${st.cover.map((c) => (c == null ? "-" : c.toFixed(2))).join("/")}` : ""}${st && st.outFrac != null ? ` dışPay=${st.outFrac.toFixed(2)}` : ""}${st && st.eyeSpread ? ` gözYayılım=${st.eyeSpread.map((v) => (v == null ? "-" : v.toFixed(1))).join("/")}` : ""} — yapay zeka yolu`);
          } catch (e) {
            console.error("Gözlük taşıma hata verdi (yapay zeka yolu):", e.message || e);
          }
          return false;
        })()) {
          // taşındı
        } else if (jobTimeLeftMs() < EYEWEAR_MIN_LEFT_MS) {
          console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[süre-bütçesi] kalan=${Math.round(jobTimeLeftMs() / 1000)}sn`);
        } else {
          const { prepareEyewear, EYEWEAR_ADD_PROMPT } = require("./eyewear");
          const job = await prepareEyewear(deliverBuf, tplForEyewear);
          // GÖZLÜKSÜZ TESLİM YOK (2026-10-19, kullanıcı: "gözlüklü fotoğrafları
          // gözlüksüz göstermeyelim"): bütçe yoksa yer açılmasını bekler;
          // yine yoksa sınırı bir gözlük (~$0.02) kadar aşarak eklenir.
          let slot = null;
          if (job.finish) {
            const r = await waitReserveOptional(EST_EYEWEAR_USD, {
              maxWaitMs: EYEWEAR_WAIT_MAX_MS,
              keepWaiting: () => jobTimeLeftMs() >= EYEWEAR_MIN_LEFT_MS + 5000,
            });
            slot = r.slot;
            if (!slot) {
              const L = ledgerSummary();
              console.warn(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): bütçe ${Math.round(r.waitedMs / 1000)}sn beklendi, yer açılmadı — SINIR AŞILARAK ekleniyor${L ? ` harcanan=${L.spentUsd.toFixed(3)} sınır=${L.limitUsd.toFixed(2)}` : ""}`);
              slot = { release() {} };
            } else if (r.waitedMs > 0) {
              console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): bütçe ${Math.round(r.waitedMs / 1000)}sn beklendi`);
            }
          }
          if (!job.finish) {
            console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${job.reason}] — gözlüksüz teslim`);
          } else {
            const form = new FormData();
            form.append("model", OPENAI_MODEL_ID);
            form.append("prompt", EYEWEAR_ADD_PROMPT);
            // LOW (2026-10-11, maliyet sınırı): d44b63e8 c2/c5/c6'da çerçeve,
            // cam ve yansıma medium'la aynı kaldı; çağrı ~$0.066 -> ~$0.019.
            // gpt-image-1-mini denendi: yüzü bozdu, kullanılamaz.
            form.append("quality", "low");
            form.append("size", "1024x1024");
            form.append("output_format", "png");
            form.append("image[]", new Blob([job.image], { type: "image/png" }), "photo.png");
            form.append("image[]", new Blob([job.ref], { type: "image/png" }), "glasses.png");
            form.append("mask", new Blob([job.mask], { type: "image/png" }), "mask.png");
            const ai = await postOpenAiImageEdit(form, 2, { timeoutMs: POST_AI_TIMEOUT_MS }).finally(() => slot.release());
            if (!ai) {
              console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): ATLANDI[edit-failed] — gözlüksüz teslim`);
            } else {
              // AYAR İÇİN KAYIT (2026-10-30, "gözlük yapay duruyor"): modelin ham
              // gözlük çıktısı saklanmıyordu, bileştirme yerelde denenemiyordu.
              // Yalnız panel hesabının işlerinde (bkz. debugSaveAllowed).
              if (await debugSaveAllowed(uid)) {
                const dir = `dating_debug/eyewear/${uid}/${jobId}/c${chunkIdx}`;
                for (const [name, b] of [["girdi", job.image], ["sablon_gozluk", job.ref], ["ai", ai], ["teslim_oncesi", deliverBuf]]) {
                  bucket().file(`${dir}_${name}.png`).save(b, { metadata: { contentType: "image/png" } })
                    .catch((e) => console.error("GÖZLÜK: kayıt başarısız (atlanıyor):", e.message || e));
                }
              }
              // Camın içi: görünür camda kendi gözü, koyu camda gözsüz cam (bkz. eyewear.keepOwnEyes).
              const fin = await job.finish(ai, { keepEyes: templateEyewear.eyesVisible === true ? "own" : "hide", ownEyeRunner: (p) => runPostTask("eyewearOwnEye", p) });
              deliverBuf = fin.buf;
              eyewearApplied = true;
              console.log(`GÖZLÜK (style=${styleId}, chunk=${chunkIdx}): EKLENDİ gözArası=${Math.round(job.iod)}px taşmaEklendi=${fin.grown.toFixed(3)} kendiGözPx=${fin.lensPx || 0} kendiGözCam=${fin.ownEye ? (fin.ownEye.applied ? "UYGULANDI" : fin.ownEye.reason) : "-"} camTonu=${fin.lensTint ? (fin.lensTint.applied ? "UYGULANDI" : fin.lensTint.reason) : "-"}${fin.grownRejected ? ` taşmaReddedildi=${fin.grownRejected.toFixed(3)}` : ""}`);
              // Şablon griyse eklenen gözlük renk getirmesin.
              const { matchGrayscale } = require("./faceLight");
              const g = await matchGrayscale(deliverBuf, tplForEyewear);
              if (g.applied && g.buf) deliverBuf = g.buf;
            }
          }
        }
      }
    } catch (e) {
      console.error("OpenAI yolu: gözlük ekleme hata verdi (gözlüksüz teslim):", e);
    }

    // IŞIKLI (2026-10-21): yalnız koyu arka planlı karede, bkz. faceGlow.js.
    // EN SONDA: kafa çevresi/gözlük dolguları şablon arka planıyla çalışıyor;
    // önce aydınlatılsa kafa çevresine aydınlatılmamış şablon pikseli girer.
    // Gri karede renk kayması uygulanmaz (faceGlow gri kareyi tanır).
    if (GLOW_ON) {
      try {
        const gl = await runPostTask("glow", { buf: deliverBuf, tpl: Buffer.isBuffer(tplForEyewear) ? tplForEyewear : null });
        if (gl.applied && gl.buf) {
          deliverBuf = gl.buf;
          console.log(`IŞIKLI (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${gl.ölçü}`);
        } else {
          console.log(`IŞIKLI (style=${styleId}, chunk=${chunkIdx}): ${gl.ölçü}`);
        }
      } catch (e) {
        console.error("OpenAI yolu: ışıklı katman hata verdi (atlanıyor):", e);
      }
    }

    let textured = await addPhoneCameraTexture(deliverBuf);
    // SON DOĞRULAMA (2026-11-04, bkz. finalCheck.js): teslim edilecek kare
    // doğrulanmış kareyle yapısal karşılaştırılır. Bozulma varsa doğrulanmış
    // kare (ışıksız) dokulanıp teslim edilir — gözlüklü karede yalnız bozuk
    // dosya/boyut değişikliğinde (gözlük kutuyu kaydırır); bilgi dokümana
    // chunkFinalFallback olarak yazılır. Reddedilen-kare bitirmesinde de
    // çalışır (panelde görünen kare de sağlam olsun).
    try {
      const { validateFinalOutput, shouldRevert } = require("./finalCheck");
      const fv = await validateFinalOutput(verifiedBuf, textured, { eyewear: eyewearApplied });
      const f3 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(3) : "null");
      const f0 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(0) : "null");
      // GÖZLÜKLÜ KAREDE GERİ ALMA YOK (2026-11-04 inceleme, bkz.
      // finalCheck.shouldRevert): 80fc7ec4 c8'de doğru taşınmış gözlük her
      // denemede geri alınıp kare gözlüksüz teslim ediliyordu.
      const revert = shouldRevert(fv, { eyewear: eyewearApplied });
      console.log(`SON DOĞRULAMA (style=${styleId}, chunk=${chunkIdx}): ${fv.ok ? (fv.reason ? `ÖLÇÜLEMEDİ[${fv.reason === "error" ? fv.error : fv.reason}]` : "GEÇTİ") : revert ? `GERİ ALINDI[${fv.reason}]` : `UYARI[${fv.reason}, gözlüklü kare korundu]`} kutuKayma=${f3(fv.boxShift)} kutuÖlçek=${f3(fv.boxScale)} noktaKayma=${f3(fv.ptsShift)} netlik=${f0(fv.sharpBefore)}→${f0(fv.sharpAfter)} oran=${f3(fv.sharpRatio)} gözlük=${eyewearApplied ? "evet" : "hayır"} yüz=${fv.faceBefore ? "var" : "yok"}→${fv.faceAfter ? "var" : "yok"} ${fv.ms ?? "?"}ms`);
      if (revert) {
        textured = await addPhoneCameraTexture(verifiedBuf);
        if (!rejectedFinishPath) {
          await jobRef.set({ chunkFinalFallback: { [String(chunkIdx)]: fv.reason } }, { merge: true })
            .catch((e) => console.error("Son doğrulama kaydı yazılamadı:", e.message || e));
        }
      }
    } catch (e) {
      console.error("Son doğrulama hata verdi (kare olduğu gibi teslim):", e.message || e);
    }
    if (rejectedFinishPath) {
      await bucket().file(rejectedFinishPath).save(textured, { metadata: { contentType: "image/jpeg" } });
      console.log(`REDDEDİLEN KARE BİTİRİLDİ (style=${styleId}, chunk=${chunkIdx}): ${rejectedFinishPath}`);
      await finalizeChunk(uid, jobId, styleId, chunkIdx, { failed: true });
      return;
    }
    // holdForApproval → staging; aksi halde doğrudan dating_results.
    const path = deliverPhotoPath(uid, jobId, styleId, chunkIdx, 0, holdForApproval);
    await bucket().file(path).save(textured, { metadata: { contentType: "image/jpeg" } });
    // Teslim edilen karenin GERÇEK şablonu (yedeğe geçildiyse yedek) — admin
    // paneli çıktıyı yanında gösteriyor. Hata üretimi etkilemez.
    const usedTemplate = CHUNK_TEMPLATE.get(chunkTemplateKey(jobId, styleId, chunkIdx));
    const finishRegressed = CHUNK_FINISH_REGRESSED.has(chunkTemplateKey(jobId, styleId, chunkIdx));
    if (usedTemplate || finishRegressed) {
      await jobRef.set({
        ...(usedTemplate ? { chunkTemplates: { [String(chunkIdx)]: usedTemplate } } : {}),
        ...(finishRegressed ? { chunkFinishRegressed: { [String(chunkIdx)]: true } } : {}),
      }, { merge: true })
        .catch((e) => console.error("Şablon kaydı yazılamadı (panelde görünmeyecek):", e.message || e));
    }
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
    // OPENAI_KEY (2026-10-29): TEN PİGMENTİ (skinPigment.js, bkz. faceRelight
    // POZLAMA) selfie setinden bir kez Monk Skin Tone tahmini alıyor —
    // gpt-4.1-mini, düşük çözünürlük, ~5 küçük istek. Önceki not ("gerekmiyor")
    // artık geçersiz.
    secrets: [OPENAI_KEY],
    region: "europe-west1",
    memory: "2GiB",
    // Yüz modeli yüklemesi + moderasyon; soğuk başlangıçta 120 sn yetmeyebilir.
    timeoutSeconds: 180,
    minInstances: 1,
  },
  async (request) => withRejectedSelfieCleanup(request, async () => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    checkAppAttestation(request, "prepareReferencePhotos");
    const { jobId, bodyProfile } = request.data || {};
    if (!jobId) {
      throw new HttpsError("invalid-argument", "jobId zorunlu.");
    }
    // jobId Firestore/Storage yollarına gömülüyor — biçimi istemciye
    // bırakılmıyor (bkz. assertSafeId).
    assertSafeId(jobId, "jobId");
    // Gemini caption + moderasyon + yüz analizi = her çağrı maliyetli.
    await enforceRateLimit(uid, "prepareReferencePhotos", RL_PREPARE);
    // Formdan gelen boy/vücut tipi — prompt'ta ikincil ipucu (foto öncelikli).
    const safeBodyProfile = (bodyProfile && typeof bodyProfile === "object")
      ? {
          heightRange: typeof bodyProfile.heightRange === "string" ? bodyProfile.heightRange : null,
          bodyType: typeof bodyProfile.bodyType === "string" ? bodyProfile.bodyType : null,
          gender: typeof bodyProfile.gender === "string" ? bodyProfile.gender : null,
        }
      : null;
    // Referansları indir (+ içerik moderasyonu, bkz. uploadReferencePhotos) ve
    // imzalı URL üret. Buradaki HttpsError doğrudan kullanıcıya gider.
    const { urls: refUrls, buffers: refBuffers } = await uploadReferencePhotos(uid, jobId);

    if (!ALLOWED_FACE_PHOTO_COUNTS.includes(refBuffers.length)) {
      throw new HttpsError(
        "invalid-argument",
        "Yüz çekimi eksik ya da fazla görünüyor; lütfen yüz çekimini baştan yap. " +
        `Yüklenen: ${refBuffers.length}.`,
        { expectedCount: MAX_FACE_PHOTOS, allowedCounts: ALLOWED_FACE_PHOTO_COUNTS, actualCount: refBuffers.length }
      );
    }

    // Net/tek yüz kapısı (+ bulanıklık/aşırı pozlama) + en iyi referansın
    // öne alınması + kaynak kimlik vektörü. Fail-safe: kontrolün KENDİSİ
    // (tfjs/tespit) hata verirse üretim bloklanmaz, sıra olduğu gibi kalır ve
    // refDescriptor null bırakılır (o durumda falInferenceWebhook'taki kimlik
    // kapısı da devre dışı kalır).
    let orderedRefUrls = refUrls;
    let refDescriptor = null;
    let refEyeOpenness = null;
    let refSkinTone = null;
    let refHasFaceShine = false;
    // IŞIKSIZ TEN (2026-10-16, L2 ortam ışık rengi — bkz. sceneLight.js):
    // selfie yüz rengi / selfie sahnesinin ışığı. Yüz ışığı adımı yüzü
    // "bu ten × base'in ışığı" rengine (kısmen) çeker. Ölçülemezse L2 kapalı.
    // SADE AKIŞTA ölçülmez (tek kullanıcısı postTasks.layers, kapalı).
    let refSkinLight = null;
    if (!SIMPLE_PIPELINE) try {
      const { selfieSkinLight } = require("./sceneLight");
      const sl = await selfieSkinLight(refBuffers);
      if (sl) refSkinLight = sl.skin;
      console.log(`HAZIRLIK IŞIKSIZ TEN: ${sl ? `[${sl.skin.map((v) => v.toFixed(2)).join("/")}] kare=${sl.n}` : "ölçülemedi"}`);
    } catch (e) {
      console.error("Hazırlık: ışıksız ten ölçülemedi (ortam ışık rengi kapalı):", e.message || e);
    }
    // TEN PİGMENTİ (2026-10-29, bkz. faceRelight.js POZLAMA): ışıktan bağımsız
    // Monk Skin Tone tahmini, vizyon modelinden. Şablon tarafı son adımlardan
    // hemen önce (templateEyewear ile aynı yerde) hesaplanır. Sade akışta da
    // açık (2026-10-30): yüz sahne ışığı (faceTone) iki kişinin ten farkını
    // bununla ayırır.
    // 2026-11-04: ölçüm ücretsiz yerel kontrollerden SONRA (aşağıda) — önceden
    // reddedilen her yükleme denemesi bu ücretli çağrıyı da yapıyordu.
    let refSkinMst = null;
    try {
      const { analyzeReferences } = require("./faceQuality");
      // Açı tekrarı kontrolü yalnızca eski 3'lü akışta: 5 açılı canlı çekim
      // açıları zaten dayatıyor ve hafif dönük kare cepheyle kimlik vektöründe
      // yakın çıkıp yanlışlıkla "aynı açı" sayılabilir.
      const analysis = await analyzeReferences(refBuffers, { dedup: refBuffers.length < FACE_PHOTO_COUNT });
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
      // SELFIE'LER ARASI KİMLİK (2026-11-04, bkz. faceQuality.identityOutliers):
      // beş karenin aynı kişiye ait olduğu daha önce hiç kontrol edilmiyordu.
      // Ölçüm her işte loglanır (eşik kalibrasyonu için), ret yalnız aykırı
      // kare bulunduğunda ve ölçüm güvenilirse.
      {
        const md = Array.isArray(analysis.identityMinDist) ? analysis.identityMinDist : [];
        const out = analysis.identityOutlierIndices || [];
        // YALNIZ LOG (2026-11-04 inceleme): 3 kişinin yerel selfie setlerinde
        // farklı kişi selfie↔selfie uzaklığı medyan 0.65, %94'ü ≤0.72; araya
        // konan başka kişinin selfie'si 300 denemede 1 kez yakalandı. Kapı
        // korumuyor ama yanlış alarmda kullanıcıyı yüklemede durdurur. Ölçüm
        // loglanır (kalibrasyon için); ret yok. SELFIE_IDENTITY_REJECT=true
        // yalnız gerçek verilerle eşik kalibre edildikten sonra.
        console.log(`HAZIRLIK KİMLİK: ${analysis.identityUnreliable ? "ÖLÇÜLEMEDİ[çoğunluk-aykırı]" : (out.length ? "AYKIRI[" + out.map((i) => i + 1).join(",") + "]" : "TUTARLI")} enYakın=[${md.map((v) => (v != null ? v.toFixed(3) : "null")).join(",")}] eşik=${require("./faceQuality").SELFIE_IDENTITY_MAX}${out.length && !SELFIE_IDENTITY_REJECT ? " (yalnız log, ret yok)" : ""}`);
        if (out.length > 0 && SELFIE_IDENTITY_REJECT) {
          const { label, many } = posLabel(out);
          throw new HttpsError(
            "invalid-argument",
            `${label} diğer karelerdeki kişiyle eşleşmiyor gibi görünüyor. ` +
            `Üretilen fotoğrafların sana benzemesi için beş karede de aynı ` +
            `kişi olmalı; ${many ? "bunları" : "bunu"} kendi yüzünün net ` +
            `göründüğü bir kareyle değiştirip tekrar dene.`,
            { identityMismatchPhotoIndices: out }
          );
        }
      }
      // Gözü APAÇIK kapalı kare (kırpma anı). Kısık/dar göz buraya GİRMEZ —
      // eşik bilinçli olarak çok düşük (bkz. faceQuality CLOSED_EYE_MAX).
      // Mesaj suçlayıcı değil yardımcı: kullanıcı neyi değiştireceğini bilsin.
      if (analysis.closedEyeIndices && analysis.closedEyeIndices.length > 0) {
        const { label, many } = posLabel(analysis.closedEyeIndices);
        throw new HttpsError(
          "invalid-argument",
          `${label} gözler kapalı görünüyor. Üretilen fotoğraflarda bakışın ` +
          `canlı çıkması için ${many ? "bunları" : "bunu"} gözlerin açık ` +
          `olduğu bir kareyle değiştir.`,
          { closedEyePhotoIndices: analysis.closedEyeIndices }
        );
      }
      // YAN PROFİL ŞART (2026-10-30, bkz. gazeGate.selfieSideCoverage):
      // 922f1371'de beş selfie de cepheye yakındı ve yana dönük şablonlarda
      // kafa yanlış yöne çevrildi. Yalnız 5 açılı sette; ölçülemezse geçer.
      if (refBuffers.length >= FACE_PHOTO_COUNT) {
        let cov = null;
        try {
          const { headPoseOf } = require("./faceQuality");
          const yaws = [];
          for (const b of refBuffers) {
            const p = (await headPoseOf(b)) || (await headPoseOf(b, LOW_CONF_FACE));
            yaws.push(p && p.yawSigned != null ? p.yawSigned : null);
          }
          cov = require("./gazeGate").selfieSideCoverage(yaws);
          console.log(`HAZIRLIK YAN PROFİL: ${cov.ok ? "VAR" : "YOK[hepsi-cephe]"} enÇokDönüş=${cov.maxTurn != null ? cov.maxTurn.toFixed(2) : "null"} yönler=[${yaws.map((v) => (v != null ? v.toFixed(2) : "null")).join(",")}]`);
        } catch (e) {
          console.error("Hazırlık: selfie yönleri ölçülemedi (yan profil kontrolü atlanıyor):", e.message || e);
        }
        if (cov && !cov.ok) {
          throw new HttpsError(
            "invalid-argument",
            "Fotoğrafların hepsi önden çekilmiş görünüyor; sağ ve sol karelerde " +
            "başın yana dönmemiş. Yana bakan pozların doğru çıkması için yüz " +
            "çekimini tekrarla ve sağ/sol adımlarında başını iyice yana çevir " +
            "(yanağın tam görünecek şekilde).",
            { profileMissing: cov.missing }
          );
        }
      }
      // En iyi yüzü listenin başına al: modele verilen ilk referans kimlik
      // sadakatinde en ağır basan kare (bkz. generateForMode bestFaceUrl).
      if (analysis.bestIndex != null &&
          analysis.bestIndex < refUrls.length &&
          refUrls[analysis.bestIndex]) {
        // 10'lu çekimde de TÜM kareler kalır (poz seçimi hepsinden yapılır);
        // eskiden ilk FACE_PHOTO_COUNT'a kırpılıyordu.
        const faceUrls = refUrls.slice(0, MAX_FACE_PHOTOS);
        const best = faceUrls[analysis.bestIndex];
        orderedRefUrls = [best, ...faceUrls.filter((u) => u !== best)];
      }
      if (analysis.refDescriptor) {
        refDescriptor = Array.from(analysis.refDescriptor); // Firestore için düz dizi
      }
      // Kişinin KENDİ göz açıklığı normali — çıktı kapısı bunu referans alır
      // (mutlak eşik kullanılmaz, bkz. eyesLookClosedVsReference).
      if (analysis.refEyeOpenness != null) {
        refEyeOpenness = analysis.refEyeOpenness;
      }
      // Kullanıcının GERÇEK ten tonu — ten kapısı artık çıktının kendi
      // yüzüne değil buna güvenebiliyor (bkz. assessSkinToneConsistency
      // başlığı, 2026-08-09 gerçek vaka).
      if (Array.isArray(analysis.refSkinTone)) {
        refSkinTone = analysis.refSkinTone;
      }
      if (analysis.refHasFaceShine) refHasFaceShine = true;
      console.log(
        `HAZIRLIK REFERANS: yüz=${refBuffers.length} referansSayisi=${orderedRefUrls.length}`
      );
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
    try {
      // Selfie başına bir ücretli çağrı → 10'lu çekimde de yalnız ilk FACE_PHOTO_COUNT.
      refSkinMst = await require("./skinPigment").estimateMst(refBuffers.slice(0, FACE_PHOTO_COUNT), OPENAI_KEY.value());
      console.log(`HAZIRLIK TEN PİGMENTİ: ${refSkinMst != null ? `MST ${refSkinMst}` : "ölçülemedi"}`);
    } catch (e) {
      console.error("Hazırlık: ten pigmenti ölçülemedi (pozlama katmanı atlanacak):", e.message || e);
    }

    // METİN CAPTION ADIMI TAMAMEN KALDIRILDI (2026-08-20).
    //
    // Geçmiş: identityCaption (yüz/ten/yaş tarifi) 2026-08-02'de, bodyCaption
    // (tam boydan beden oranı tarifi) ise bugün kaldırıldı; ikisi de Gemini
    // çağrısıydı ve Gemini artık projede yok.
    //
    // Neden gerek kalmadı:
    //   - Kimlik: OpenAI referans fotoğrafları DOĞRUDAN görüyor; ayrı bir metin
    //     tarifine ihtiyaç yok (caption'lar zaten sıklıkla kırık geliyordu).
    //   - Beden: tam boy fotoğraf artık İSTENMİYOR (kullanıcı kararı) — boy ve
    //     vücut tipi onboarding formundan alınıyor ve `shortBodyNote` bunu
    //     ZATEN tek yetkili kaynak sayıyordu; caption yalnızca ikincil bir
    //     gözlemdi ve seçimle çeliştiğinde eleniyordu.
    // Kazanç: bir dış bağımlılık, bir gecikme kaynağı (gerçek olayda 1dk45sn
    // gecikip "deadline exceeded"e yol açmıştı) ve bir maliyet kalemi gitti.

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
      // Face swap kaynağı: ilk kare = ön yüz (çekim sırası ön/sağ/sol).
      // Swap cepheden en iyi çalıştığı için ön kareyi kullanıyoruz (bkz.
      // falInferenceWebhook + faceSwap).
      ...(refUrls[0] ? { primaryFaceUrl: refUrls[0] } : {}),
      ...(refDescriptor ? { refDescriptor } : {}),
      ...(refEyeOpenness != null ? { refEyeOpenness } : {}),
      ...(refSkinTone ? { refSkinTone } : {}),
      ...(refSkinLight ? { refSkinLight } : {}),
      ...(refSkinMst ? { refSkinMst } : {}),
      ...(refHasFaceShine ? { refHasFaceShine: true } : {}),
      ...(safeBodyProfile ? { bodyProfile: safeBodyProfile } : {}),
      facePhotoCount: refBuffers.length,
      referencePhotoCount: orderedRefUrls.length,
    });

    // Form beden profilini kullanıcıya özel sakla (sonraki üretimler / analitik).
    if (safeBodyProfile) {
      await db.doc(`users/${uid}/private/datingProfile`).set({
        ...safeBodyProfile,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // NOT (2026-08-21): burada ARTIK silinmiyor — fal.ai kaldırıldıktan sonra
    // "fal kopyası var" varsayımı geçersiz kaldı. Referans selfie'ler,
    // startPhotoGeneration OpenAI'den senkron olarak tekrar indirdiği için
    // üretim TAMAMEN bitene kadar Storage'da kalmalı (silinirse OpenAI'nin
    // indirme isteği 403 alır, TÜM chunk'lar başarısız olur — bkz.
    // startPhotoGeneration'daki deleteTrainingPhotos çağrısı, gerçek üretim
    // sonrasına taşındı).

    return { ok: true };
  })
);

/**
 * REDDEDİLEN YÜKLEMENİN SELFIE'LERİ SİLİNİR (2026-11-04 inceleme, KVKK):
 * hazırlık bir selfie kapısında (içerik, bulanık, gözler kapalı, yan profil
 * yok, sayı) 'invalid-argument' ile reddedince iş dokümanı hiç yazılmıyor ve
 * dating_training/{uid}/{jobId}/ altındaki selfie'ler kalıyordu (09-06..09-24
 * 61 kullanıcıdan 441 dosya). İstemci her denemede yeni jobId üretir
 * (module_flows Uuid().v4()), reddedilen klasör bir daha kullanılmaz.
 */
async function withRejectedSelfieCleanup(request, fn) {
  try {
    return await fn();
  } catch (e) {
    const jobId = request && request.data ? request.data.jobId : null;
    const uid = request && request.auth ? request.auth.uid : null;
    if (e instanceof HttpsError && e.code === "invalid-argument" && uid && typeof jobId === "string") {
      let safe = true;
      try { assertSafeId(jobId, "jobId"); } catch { safe = false; }
      if (safe) {
        await deleteTrainingPhotos(uid, jobId);
        console.log(`HAZIRLIK REDDİ: selfie'ler silindi (uid=${uid}, job=${jobId}) sebep="${String(e.message).slice(0, 80)}"`);
      }
    }
    throw e;
  }
}

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
  //
  // timeoutSeconds 540->900 (2026-08-16): OPENAI_DIRECT_MAX_ATTEMPTS 2->6
  // olunca en kötü ihtimalde tek bir chunk 6 deneme boyunca (her biri gerçek
  // bir OpenAI çağrısı + Vision + kapılar) sürebilir; OPENAI_IMAGE_MAX_CONCURRENCY
  // kuyruğu (=2) 10 chunk'ı sıraya soktuğunda toplam süre eski 540sn sınırını
  // rahat aşabilir. İstemci tarafı (module_flows.dart HttpsCallableOptions)
  // BUNUNLA SENKRON tutulmalı — aksi halde istemci sunucudan önce vazgeçip
  // "network connection lost" görür (bkz. 2026-08-15 gerçek olay, aynı kökten
  // — client/server timeout uyumsuzluğu).
  {
    secrets: [FAL_KEY, OPENAI_KEY],
    region: "europe-west1",
    // 2GiB -> 4GiB (2026-10-08 gerçek olay, iş 6f9e524e): kafa ölçeği ve ten
    // alanı katmanları eklendikten sonraki ilk üretimde süreç "Memory limit
    // of 2048 MiB exceeded with 2060 MiB used" ile öldü; o an son adımdaki 3
    // kare kayboldu ve iş "Zaman aşımı" ile düştü. Katmanlar ayrıca
    // POST_LAYER_LOCK ile sıraya alındı; bu artış güvenlik payı.
    // 4GiB -> 8GiB, 4 vCPU, örnek başına tek iş (2026-10-11, kullanıcı:
    // "genel hızı hızlandıralım" → worker threads). Son katmanlar artık 3
    // worker'da paralel (bkz. postPool.js); her worker modelleri ayrı yükler.
    // Aynı örneğe ikinci iş düşerse bellek iki katına çıkardı — concurrency 1.
    // 8GiB -> 16GiB (2026-10-26 gerçek olay, iş bac1a9e1): yerel modeller
    // (yüz netliği GFPGAN, MoveNet, kulaklık OWLv2) eklendikten sonraki ilk
    // üretimde "Memory limit of 8192 MiB exceeded with 8429 MiB used"; 9 kare
    // kayboldu. Önceki iş (d0d4c001) bu modeller olmadan %77-81'de geziyordu.
    // Ek maliyet iş başına ~0.01 $ (bellek GiB-saniye).
    // 16GiB/4 → 32GiB/8 (2026-11-18, iş 156fa173): 10 karenin son adımları
    // 3 worker'da sıraya girip CPU %100'de ~10 dk sürdü (bellek tepe %64 ≈
    // 10 GiB). 7 worker (bkz. postPool.POST_WORKERS_MAX) ile kareler ~2 kat
    // paralel biter; saniye başı ücret 2 kat, süre ~yarı → iş başı maliyet ~aynı.
    // maxInstances 12 (2026-11-18, kullanıcı kararı): bölge bellek kotası 400 GiB;
    // 32 GiB × 20 örnek = 640 GiB deploy'u reddetti. 12 × 32 = 384 GiB. Örnek başına
    // tek iş (concurrency 1) → en fazla 12 üretim aynı anda; artış için kota iste.
    memory: "32GiB",
    cpu: 8,
    maxInstances: 12,
    concurrency: 1,
    timeoutSeconds: JOB_TIME_LIMIT_MS / 1000, // 900 — süre bütçesi bununla senkron (bkz. jobTimeLeftMs)
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    checkAppAttestation(request, "startPhotoGeneration");
    const { styles, photoCount: rawPhotoCount, jobId, model: rawModel, mode: rawMode, holdForApproval: rawHold, style: rawStyle } = request.data || {};
    const jobDeadline = Date.now() + JOB_TIME_LIMIT_MS - JOB_FINALIZE_RESERVE_MS;
    // GPT 2.5 KALDIRILDI (2026-10-07): "Versiyon 2" butonu artık gpt-image-2 +
    // kısa prompt. Yüklü eski uygulama hâlâ 2.5 modelini gönderiyor; yeni
    // build yayına girene kadar o istek buraya çevrilir.
    // Qwen de kaldırıldı (2026-10-10): eski uygulamanın Versiyon 3 isteği
    // Buton 1 olarak üretilir.
    const legacyV25 = rawModel === OPENAI_MODEL_V25_ID;
    const legacyQwen = QWEN_LEGACY_MODEL_IDS.has(rawModel);
    const model = legacyV25 || legacyQwen ? OPENAI_MODEL_ID : rawModel;
    const mode = legacyV25 ? PHOTO_MODE_COMPACT : legacyQwen ? PHOTO_MODE_P800 : rawMode;
    if (!jobId) {
      throw new HttpsError("invalid-argument", "jobId zorunlu.");
    }
    assertSafeId(jobId, "jobId");
    // STİL (2026-09-28): yeni istemci gönderir; göndermeyen eski istemci
    // stilsiz (boy-bandı havuzu) davranışında kalır.
    if (rawStyle !== undefined && rawStyle !== null && !PHOTO_STYLE_IDS.includes(rawStyle)) {
      throw new HttpsError("invalid-argument", `Bilinmeyen stil: ${rawStyle}`);
    }
    const photoStyle = rawStyle || null;

    // SÜRÜM KAPISI: yalnızca açıkça true gönderen (yeni) istemci onay
    // akışına girer. Bayrak yok / false → eski doğrudan teslim.
    // MAĞAZA İNCELEME HESABI (2026-10-11, Play "giriş bilgisi eksik" reddi,
    // kullanıcı kararı): hakemin işi onay beklemeden teslim edilir — inceleme
    // saatini bilemiyoruz, hakem "oluşturuluyor" ekranında takılmasın.
    const reviewDemo = await isReviewDemoAccount(request.auth);
    const holdForApproval = rawHold === true && !reviewDemo;
    if (reviewDemo) console.log(`İNCELEME HESABI (${jobId}): onay atlandı, doğrudan teslim`);

    // ESKİ İSTEMCİ UYUMLULUĞU (2026-09-18) — ATLANAMAZ, GERÇEK OLAY VAR.
    //
    // 2026-09-10'da sunucu, istemci güncellenmeden önce değiştirildi ve
    // telefonlardaki sürüm eski alanı göndermeye devam ettiği için 41 işten
    // 40'ı başarısız oldu, 25 kullanıcı hiç foto alamadı (bkz. ücretsiz
    // deneme bloğundaki not). Aynı hatayı tekrarlamamak için bu fonksiyon
    // HER İKİ isteği de kabul eder:
    //
    //   YENİ istemci : { photoCount: 5 | 10 | 25 }
    //   ESKİ istemci : { styles: ["elegance"] }  -> stil başına 10 foto
    //
    // Eski istemci ayrıca sonucu `results[styleId]` altında okur; bu yüzden
    // aşağıda kova anahtarı (bucketId) eski istekte styleId olarak KALIR.
    // Böylece güncellenmemiş telefonlar çalışmaya devam eder.
    const legacyStyles = Array.isArray(styles) && styles.length > 0 ? styles : null;
    let photoCount;
    if (rawPhotoCount !== undefined) {
      photoCount = Number(rawPhotoCount);
      if (!Number.isInteger(photoCount) || !PHOTO_PACK_SIZES.includes(photoCount)) {
        throw new HttpsError(
          "invalid-argument",
          `photoCount ${PHOTO_PACK_SIZES.join(" / ")} olmalı.`
        );
      }
    } else if (legacyStyles) {
      photoCount = legacyStyles.length * LEGACY_PHOTOS_PER_STYLE;
    } else {
      throw new HttpsError("invalid-argument", "photoCount zorunlu.");
    }
    // Sonuç haritasının anahtarı. Yeni istemcide sabit; eski istemcide
    // gönderdiği stil adı (o istemci sonucu bu anahtarla arıyor).
    const bucketId = legacyStyles && rawPhotoCount === undefined
      ? legacyStyles[0]
      : PHOTO_BUCKET_ID;
    assertSafeId(bucketId, "bucketId");
    // OpenAI görsel üretimi + Vision kontrolü = çağrı başına en yüksek maliyet.
    await enforceRateLimit(uid, "startPhotoGeneration", RL_GENERATE);
    // Tek buton bu alanı 'gpt-image-2' gönderir -> useOpenAiDirect=true,
    // doğrudan OpenAI'ye gider (bkz. OPENAI_MODEL_ID tanımı). MODEL_CATALOG
    // içindeki "gpt-image-2" girdisi (fal-wrapped, artık kullanılmıyor) bu
    // kontrolü zaten geçirdiği için ayrıca eklemeye gerek yok.
    if (model !== undefined && !MODEL_CATALOG[model] && !OPENAI_DIRECT_MODELS.has(model)) {
      throw new HttpsError("invalid-argument", `Bilinmeyen model: ${model}`);
    }
    if (OPS_ONLY_MODELS.has(model)) {
      const email = (request.auth.token.email || "").toLowerCase().trim();
      if (email !== OPS_EMAIL || request.auth.token.email_verified === false) {
        throw new HttpsError("permission-denied", "Bu model yalnızca test hesabına açık.");
      }
    }
    // Model gönderilmezse OpenAI (2026-11-04 inceleme; kullanıcı kuralı: yalnız
    // OpenAI): istemci 'model' alanını boş bırakabiliyor (module_flows ?modelId)
    // ve eski varsayılan DEFAULT_MODEL_ID fal yoluna (nano-banana-pro) düşüyordu.
    const modelId = model || OPENAI_MODEL_ID;
    // Prompt stratejisi (bkz. PHOTO_MODES). Yalnızca OpenAI doğrudan yolunda
    // anlamlı; fal yolu her zaman kapsamlı buildEditPrompt kullanır.
    if (mode !== undefined && !PHOTO_MODES.includes(mode)) {
      throw new HttpsError("invalid-argument", `Bilinmeyen mod: ${mode}`);
    }
    // SADE AKIŞ (2026-11-19): her istemci tek prompt yoluna (p800 + doğal yer değiştirme) gider;
    // eski mod değerleri hâlâ kabul edilir (eski istemci invalid-argument almasın) ama yok sayılır.
    const photoMode = PHOTO_MODE_P800;

    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);

    // İŞİ 'failed' YAP VE HATAYI YENİDEN FIRLAT (2026-09-10 gerçek olay):
    // 'ready' durumundaki bir iş, üretim başlamadan HttpsError ile
    // reddedildiğinde (bakiye yok, referans eksik, havuz boş...) doküman
    // 'ready' olarak KALIYORDU. cleanupStuckGenJobs 'ready' işleri de tarıyor
    // ve 5 dakika sonra "Zaman aşımı — işlem tamamlanamadı" yazıyordu — yani
    // kullanıcı "paketin yok" yerine 5 dakika sonra alakasız bir zaman aşımı
    // görüyordu (10 Eylül: 41 işten 40'ı böyle "başarısız" göründü; 25
    // kullanıcı hiç bakiyesi olmadan denemişti). Bu yol artık ANINDA ve
    // DOĞRU mesajla sonuçlanır.
    const failJobAndRethrow = async (e) => {
      // Çift başlatma reddi (bkz. transaction içindeki durum kontrolü):
      // iş başka çağrıda sürüyor, dokunma.
      if (e && e.doNotFailJob) throw e;
      try {
        // KVKK (2026-11-04 inceleme): bu uç durumda da biyometrik alanlar ve
        // selfie'ler silinir — iş 'failed' olduktan sonra yeniden başlatılamaz
        // (istemci "baştan tekrar dene" ile yeni jobId alır).
        await jobRef.set({
          status: "failed",
          errorMessage: e instanceof HttpsError ? e.message : "Üretim başlatılamadı.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...biometricFieldDeletes(),
        }, { merge: true });
      } catch (writeErr) {
        // İşi işaretleyemesek bile ASIL hatayı kaybetme.
        console.error("İş 'failed' olarak işaretlenemedi:", writeErr);
      }
      await deleteTrainingPhotos(uid, jobId);
      throw e;
    };

    // Doğrulama adımı atlanamaz: iş 'ready' değilse üretim başlamaz.
    const prepSnap = await jobRef.get();
    if (!prepSnap.exists || prepSnap.data().status !== "ready") {
      // Burada iş zaten 'ready' DEĞİL — işaretlenecek bir şey yok.
      // İş zaten başlamış/bitmişse (ilk çağrı transaction'ı geçmiş, ikinci
      // dokunma/yeniden deneme buraya geliyor) 'already-exists' (2026-11-04
      // inceleme): failed-precondition istemcide hata ekranı açıyordu, oysa iş
      // çalışıyordu. Aşağıdaki transaction içi kontrolle aynı kural.
      const st = prepSnap.exists ? prepSnap.data().status : null;
      if (["generating", JOB_STATUS_PENDING_APPROVAL, "done"].includes(st)) {
        throw new HttpsError("already-exists", "Bu üretim zaten başlatıldı.");
      }
      throw new HttpsError(
        "failed-precondition",
        "Fotoğraflar henüz doğrulanmadı. Lütfen baştan tekrar dene."
      );
    }
    const refUrls = prepSnap.data().falRefUrls;
    if (!Array.isArray(refUrls) || refUrls.length === 0) {
      await failJobAndRethrow(new HttpsError(
        "failed-precondition",
        "Referans fotoğrafları hazır değil. Lütfen baştan tekrar dene."
      ));
    }
    const prepData = prepSnap.data();
    // Kişi-değişimi edit'i için kullanıcı referansları + kimlik/beden metni.
    const identityCaption = prepData.identityCaption || null;
    const bodyProfile = prepData.bodyProfile || {};
    const refDescriptor = prepData.refDescriptor || null; // OpenAI yolunda kimlik kapısı için
    // Kişinin KENDİ göz açıklığı normali — çıktı göz kapısı mutlak eşik yerine
    // bunu referans alır (bkz. faceQuality.eyesLookClosedVsReference).
    const refEyeOpenness = prepData.refEyeOpenness != null ? prepData.refEyeOpenness : null;
    // Kullanıcının GERÇEK ten tonu [L,a,b] — ten kapısı bunu hedef ton olarak
    // kullanır (bkz. faceQuality.assessSkinToneConsistency başlığı).
    const refSkinTone = Array.isArray(prepData.refSkinTone) ? prepData.refSkinTone : null;
    const refHasFaceShine = !!prepData.refHasFaceShine;
    // Kişinin ışıksız teni [r,g,b] (L2 ortam ışık rengi; eski işlerde yok).
    const refSkinLight = Array.isArray(prepData.refSkinLight) ? prepData.refSkinLight : null;
    // Kişinin pigmenti (Monk Skin Tone 1-10, ışıktan bağımsız; bkz. faceRelight
    // POZLAMA). Eski işlerde yok — o halde pozlama katmanı atlanır.
    const refSkinMst = Number.isFinite(prepData.refSkinMst) ? prepData.refSkinMst : null;

    // TABAN GÖRSELLERİ bakiye DÜŞÜLMEDEN önce seç (havuz boşsa kredi
    // harcanmadan net hata). Kategoriler kaldırıldı (2026-08-02): tek düz
    // havuzdan, kullanıcının ÖNCEKİ işlerinde kullanılmamışlara öncelik
    // vererek seçilir — bkz. pickTemplatesFromPool / recentTemplateNames.
    // BOY BANDI (2026-08-02): kullanıcının seçtiği boya uygun alt klasör
    // varsa yalnızca oradan seçilir — bkz. listTemplateFiles / HEIGHT_RANGE_TO_BAND.
    const { files, band: templateBand, style: templateStyle } =
      await listTemplateFiles(bodyProfile.heightRange, photoStyle);
    if (files.length === 0) {
      await failJobAndRethrow(new HttpsError(
        "failed-precondition",
        `Taban görsel havuzu boş. Firebase Storage'da ${TEMPLATE_ROOT}/ ` +
        `klasörüne (veya boy bantlarına: ${TEMPLATE_HEIGHT_BANDS.join(" / ")}) ` +
        `AI ile üretilmiş taslak görseller yükle.`
      ));
    }
    console.log(
      `ŞABLON HAVUZU: ${files.length} görsel` +
      ` (istenenStil=${photoStyle || "yok"}, kullanılanStil=${templateStyle || "yok"})` +
      (templateBand ? ` (boy bandı=${templateBand}, boy=${bodyProfile.heightRange})`
                    : ` (bant yok — tüm havuz, boy=${bodyProfile.heightRange || "belirtilmemiş"})`)
    );
    const recentNames = await recentTemplateNames(uid);
    // Her chunk için (OPENAI_DIRECT_MAX_ATTEMPTS - 1) YEDEK şablon seçilir
    // (2026-08-16, 2 yedekten 5 yedeğe çıkarıldı — "10 foto garantisi" için
    // deneme sayısı 6'ya çıkarılırken BUNUNLA SENKRON tutulmalı, aksi halde
    // ileri denemeler "farklı şablon" sanıp aynı şablonu tekrar dener). İki
    // ayrı işe yararlar:
    //  1) birincil KULLANILAMAZSA (yüz yok / yüz çok küçük) atlanıp yedeğe
    //     geçilir — bkz. prepareTemplate,
    //  2) bir deneme kalite kapısını geçemezse SONRAKİ deneme yeni bir
    //     şablonla yapılır — aynı bozuk şablonla tekrar denemek boşuna.
    // Yedekler ayrı tutulur; lockedCount ve ücretsiz-deneme hesabı yalnızca
    // BİRİNCİL listeye bakar, yedeklerin varlığı bu sayıları değiştirmez.
    // NOT: havuz (files) bu kadar çeşitliliği kaldıramayacak kadar küçükse
    // pickTemplatesFromPool aynı dosyayı döngüsel tekrarla doldurur (bkz. o
    // fonksiyonun ve aşağıdaki TEKİLLEŞTİRME'nin gerekçesi) — bazı boy/beden
    // bantlarında son denemeler yine de aynı şablona düşebilir, fail-safe.
    //
    // 25'LİK PAKET VE HAVUZ BOYU (2026-09-18, ölçüldü): istenen şablon sayısı
    // photoCount * 6'dır — 25 foto için 150. Gerçek havuzlar bundan küçük
    // (short 59, middle 72, tall 83), bu yüzden pickTemplatesFromPool döngüsel
    // tekrarla doldurur. TESLİM EDİLEN kareler yine de tekrarsızdır (25 < 59);
    // tekrar yalnızca YEDEK listesine düşer, yani bir chunk çok kez reddedilirse
    // ileri denemeleri aynı tabana dönebilir. Kabul edilebilir; bant başına
    // şablon eklemek bunu tamamen giderir.
    // generateCount = fazla üretim dahil ÜRETİLECEK kare sayısı; photoCount
    // ise vaat edilen/ücretlendirilen sayı (bkz. PHOTO_PACK_OVERPRODUCTION).
    // holdForApproval yoksa generateCount === photoCount (eski davranış).
    // Şablon ihtiyacı üretilen sayıya göre hesaplanır.
    const generateCount = generateCountFor(photoCount, holdForApproval);
    const pickedAll = pickTemplatesFromPool(
      files, jobId, generateCount * OPENAI_DIRECT_MAX_ATTEMPTS, recentNames
    );
    const primaryTemplates = pickedAll.slice(0, generateCount);
    const spareTemplates = pickedAll.slice(generateCount);

    // Bakiye kontrolü + düşme + işi 'generating'e geçirme — tek transaction.
    // Bakiye artık FOTO cinsinden (bkz. photoUnitsFor başlığı).
    const unitsNeeded = photoUnitsFor(photoCount);
    let unitsToCharge = unitsNeeded;
    let usedFreeTier = false;
    let packConsumed = null;

    await db.runTransaction(async (tx) => {
      // ÇİFT BAŞLATMA KORUMASI (2026-11-04): 'ready' kontrolü yukarıda
      // transaction DIŞINDA yapılıyor; iki eş zamanlı çağrı (çift dokunma,
      // istemci yeniden denemesi) ikisi de 'ready' görüp ikisi de bakiye
      // düşebiliyordu. Durum burada, cüzdanla AYNI transaction'da yeniden
      // okunur; 'ready' değilse hiçbir şey yazılmaz.
      const jobNow = await tx.get(jobRef);
      if (!jobNow.exists || jobNow.data().status !== "ready") {
        // İş zaten başlamış/bitmişse 'already-exists': istemci bu kodda hata
        // ekranına geçmez, iş dokümanını dinlemeye devam eder ve sonucu
        // gösterir (bkz. module_flows startPhotoGeneration catch'i —
        // yalnız unauthenticated/failed-precondition hata ekranı açar).
        const started = jobNow.exists &&
          ["generating", JOB_STATUS_PENDING_APPROVAL, "done"].includes(jobNow.data().status);
        const e = new HttpsError(
          started ? "already-exists" : "failed-precondition",
          started
            ? "Bu üretim zaten başlatıldı."
            : "Fotoğraflar henüz doğrulanmadı. Lütfen baştan tekrar dene."
        );
        // İş 'failed' YAPILMAMALI: başka bir çağrı onu meşru olarak
        // 'generating'e aldı; failJobAndRethrow o üretimi bozardı.
        e.doNotFailJob = true;
        throw e;
      }
      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.data() || {
        photoBalance: 0,
        analysisBalance: 0,
        freePhotoUsed: false,
      };

      const balance = wallet.photoBalance || 0;
      if (balance < unitsNeeded) {
        // AI FOTO ÜCRETSİZ DENEMESİ KAPATILDI (2026-09-15).
        //
        // GEÇMİŞ: 2026-09-09'da kapatılmış ama 10 Eylül'de geri açılmıştı.
        // Sebep sıralama hatasıydı: sunucu kapatıldığında ücretsiz denemesi
        // KAPALI istemci sürümü henüz App Store'da değildi. Telefonlardaki
        // sürüm hâlâ "1 stil ücretsiz" sanıp istek atıyor, sunucu reddediyordu
        // — 41 işten 40'ı başarısız oldu, 25 kullanıcı hiç foto alamadı.
        //
        // ŞİMDİ GÜVENLİ, çünkü planlanan üç adımın üçü de tamamlandı:
        //   (1) ücretsiz denemesi kapalı istemci App Store'da yayında,
        //   (2) kullanıcılar o sürüme geçti,
        //   (3) sunucu kapatıldı — burası.
        // Ölçüm bunu doğruluyor: 11 Eylül'de 25 ücretsiz iş vardı, 14 ve 15
        // Eylül'de SIFIR. Yani eski sürümde kalan kullanıcı pratikte yok.
        //
        // Eski bir istemci yine de denerse aşağıdaki mesajı alır — sessizce
        // başarısız olmaz, ne yapması gerektiğini okur.
        if (balance > 0) {
          // Bakiyesi var ama istenen foto sayısından az — net yönlendirme yap.
          throw new HttpsError(
            "failed-precondition",
            `Paketinde ${balance} fotoğraf hakkın var ama ${photoCount} fotoğraf ` +
            `istendi. Daha küçük bir paket seç ya da yeni paket al.`
          );
        } else if (!wallet.freePhotoUsed) {
          // Hiç paket almamış ve ücretsiz hakkını da hiç kullanmamış hesap:
          // büyük ihtimalle ücretsiz deneme bekleyen ESKİ bir istemci.
          // Genel "hakkın kalmadı" mesajı burada yanıltıcı olurdu.
          throw new HttpsError(
            "failed-precondition",
            "Ücretsiz deneme sona erdi. Devam etmek için AI Foto paketi al."
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
        // PAKET DEFTERİ (2026-10-12): kullanıcının seçtiği paket düşülür
        // (bkz. photoPacks.js). Tam iadede aynı paket geri verilir.
        const { chargePacks } = require("./photoPacks");
        const ch = chargePacks(wallet.photoBalance, wallet.photoPacks, photoCount);
        walletUpdate.photoPacks = ch.packs;
        packConsumed = ch.consumed;
      }
      if (usedFreeTier) {
        walletUpdate.freePhotoUsed = true;
      }
      tx.set(walletRef, walletUpdate, { merge: true });

      // merge — prepareReferencePhotos'un yazdığı falRefUrls/refDescriptor/
      // identityCaption korunur.
      tx.set(jobRef, {
        status: "generating",
        // photoCount YENİ ALAN; `styles` yalnızca eski istemci gönderdiyse
        // yazılır (ops paneli ve eski raporlar onu okuyabilsin diye).
        photoCount,
        // Arka planda üretilen (fazla üretim dahil) kare sayısı. Onay üst
        // sınırı photoCount'tur, generateCount değil.
        generateCount,
        // true → staging + pendingApproval; false/yok → doğrudan teslim.
        holdForApproval,
        bucketId,
        ...(legacyStyles ? { styles: legacyStyles } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Tek kova var; "kaç kova bitmeyi bekliyor" sayacı artık hep 1.
        pendingStyles: 1,
        results: {},
        errorMessage: null,
        packUnitsCharged: unitsToCharge,
        // Defterden düşülen paket boyu (null: serbest haktan) — tam iadede geri verilir.
        packConsumed,
        usedFreeTier,
        model: modelId, // hangi model kullanıldı — izleme/karşılaştırma için
        photoMode, // hangi prompt stratejisi — A/B karşılaştırması için
        photoStyle, // kullanıcının seçtiği stil (null = eski istemci)
        templateStyle: templateStyle || null, // gerçekten kullanılan stil klasörü
      }, { merge: true });
    }).catch(failJobAndRethrow);

    // TEKRAR AÇILDI (2026-07-27): tek "Fotoğraflarımı Oluştur" butonu artık
    // fal.ai SARMALAMASI değil, doğrudan OpenAI'nin kendi API'sine gidiyor
    // (bkz. runOpenAiDirectChunk — artık kapsamlı buildEditPrompt + fal
    // yoluyla AYNI referans seti + AYNI iki katmanlı kalite kapısını
    // kullanıyor). MODEL_CATALOG'daki "gpt-image-2" (fal-ai/gpt-image-2/edit)
    // girdisi SİLİNMEDİ, sadece kullanılmıyor — geri dönmek istenirse bu
    // satır `false` yapılabilir.
    const useOpenAiDirect = OPENAI_DIRECT_MODELS.has(modelId);

    // TEKRAR FİLTRESİ İÇİN GEÇMİŞ (2026-08-02): bu işte GERÇEKTEN üretilen
    // taban görsellerin adları kaydedilir; sonraki işler bunları eleyerek
    // seçim yapar (bkz. recentTemplateNames). Ücretsiz denemede yalnızca
    // üretilen ilk kare sayılır — kilitli kalanlar "görülmüş" değildir.
    const usedTemplateNames = [
      ...new Set(
        (usedFreeTier
          ? primaryTemplates.slice(0, FREE_TIER_CHUNK_COUNT)
          : primaryTemplates
        ).map((f) => f.name)
      ),
    ];
    await jobRef.set({ templateNames: usedTemplateNames }, { merge: true });
    // Silme (finally / refundAndFail) bu bloğun içinden yapılır; kopya önce.
    await keepSelfiesForReview(uid, jobId);

    try {
      if (useOpenAiDirect) {
        // OPENAI DOĞRUDAN YOLU — webhook YOK. Her chunk için önce 'pending'
        // kaydı yazılır (finalizeChunk'ın idempotent guard'ı bunu bekliyor —
        // bkz. finalizeChunk), SONRA üretim TAM OLARAK burada, senkron
        // bekleniyor (webhook'un yapacağı işi runOpenAiDirectChunk yapıyor).
        // Fonksiyon bu Promise.all bitmeden dönmez — bkz. onCall timeoutSeconds.
        // Tek kova (stil kalktı): photoCount kadar chunk PARALEL üretilir.
        // 10'luk paket iki adet 5'lik üretim DEĞİLDİR — tek işte 10 chunk
        // (kullanıcı kararı, 2026-09-18).
        //
        // Ücretsiz denemede sadece İLK chunk üretilir; kalanı hiç
        // ÇALIŞTIRILMAZ (API maliyeti yok) — "chunks" haritasına da GİRMEZ ki
        // finalizeChunk'ın "tüm chunk'lar bitti mi" kontrolü yalnızca
        // gerçekten üretilenleri beklesin. Kilitli kalan sayısı ayrı bir
        // alanda (lockedCount) saklanır — istemci kilit/"paket al" kartlarını
        // buradan gösterir.
        {
          const picked = usedFreeTier
            ? primaryTemplates.slice(0, FREE_TIER_CHUNK_COUNT)
            : primaryTemplates;
          // KİLİTLİ SAYISI VAAT EDİLENE GÖRE (2026-09-22): kullanıcıya
          // "paket alırsan şu kadarı daha açılır" derken fazla üretimi
          // saymak yanıltıcı olurdu — o kareler ona satılmıyor.
          const lockedCount = Math.max(0, photoCount - picked.length);
          const initialChunks = Object.fromEntries(
            picked.map((_, i) => [String(i), { photoUrls: [], status: "pending", retries: 0 }])
          );
          await jobRef.set({
            results: { [bucketId]: {
              status: "pending", photoUrls: [], chunks: initialChunks,
              ...(lockedCount > 0 ? { lockedCount } : {}),
            } },
          }, { merge: true });

          // İŞ GENELİNDE İMZALI-URL ÖNBELLEĞİ (2026-09-21, gerçek olay
          // fccde0af): eski "TEKİLLEŞTİRME" (2026-08-12, aşağıda kaldı)
          // yalnızca HER CHUNK'IN KENDİ aday listesini tekilleştiriyordu.
          // Çakışma ÇAPRAZ çıkabiliyor — chunk i'nin birincili chunk j'nin
          // yedeğiyle AYNI dosya olabilir (havuz küçükse pickTemplatesFromPool
          // döngüsel tekrar eder), ve chunk'lar PARALEL (Promise.all)
          // çalıştığı için ikisi AYNI ANDA signedDownloadUrl'i (=
          // file.setMetadata) çağırabiliyordu. Gerçek örnek: 56'lık havuzda
          // iki chunk aynı dosyaya düştü, GCS "metadata was edited during
          // the operation" ile patladı, bütün iş (10 chunk, hiçbiri
          // denenmeden) çöktü. Çözüm: her benzersiz dosya için TÜM İŞ
          // boyunca TEK signedDownloadUrl çağrısı — sonuç bu Map'te
          // önbelleklenip chunk'lar arasında paylaşılıyor.
          const signedUrlCache = new Map();
          const cachedSignedUrl = (file) => {
            if (!signedUrlCache.has(file.name)) {
              signedUrlCache.set(file.name, signedDownloadUrl(file));
            }
            return signedUrlCache.get(file.name);
          };

          // MALİYET DEFTERİ (bkz. jobContext): tüm chunk'lar aynı defteri
          // paylaşır; isteğe bağlı AI adımları sınırı aşmayacaksa çalışır.
          // Ara toplam chunk nabzıyla yazılır (bkz. runOpenAiDirectChunk
          // chunkBeat); iş sonunda kesin toplam aşağıda yazılır.
          const costLedger = createLedger(picked.length);
          // YEREL DOLGU MODELİ ISINMASI (bkz. lamaFill.js): model indirme +
          // oturum açma örnek başına bir kez 10-20 sn; kareler kafa çevresine
          // gelene kadar arka planda (ayrı iş parçacığı) hazır olur. Sade
          // akışta LaMa'yı kullanan adım yok (saç silme ve dolgular kapalı).
          if (!SIMPLE_PIPELINE) require("./lamaFill").warmup().catch((e) => console.error("Yerel dolgu ısınması başarısız (ilk kullanımda yeniden denenecek):", e.message || e));
          // Yüz netliği modeli (340 MB, bkz. faceRestore.js) de aynı şekilde.
          if (FACE_RESTORE_ON) require("./faceRestore").warmup().catch((e) => console.error("Yüz netliği ısınması başarısız (ilk kullanımda yeniden denenecek):", e.message || e));
          await Promise.all(picked.map(async (file, i) => {
            // [birincil, yedek1..yedek5] — her chunk'ın KENDİ yedekleri var
            // (i, generateCount+i, 2*generateCount+i, ... konumları), böylece
            // paralel çalışan chunk'lar aynı yedeğe düşüp aynı kareyi üretmez.
            // ADIM generateCount OLMALI (photoCount DEĞİL): yedek listesi
            // üretilen chunk sayısına göre dilimlendi, adım küçük kalırsa
            // farklı chunk'lar aynı yedeğe düşer.
            // Yedek sayısı (OPENAI_DIRECT_MAX_ATTEMPTS - 1 = 5) o sabitle
            // senkron — bkz. tanımının yanındaki gerekçe.
            const candidates = [
              file,
              ...Array.from(
                { length: OPENAI_DIRECT_MAX_ATTEMPTS - 1 },
                (_, k) => spareTemplates[k * generateCount + i]
              ),
            ].filter(Boolean);
            // TEKİLLEŞTİRME (2026-08-12): bu chunk'ın KENDİ adayları içinde
            // aynı dosya birden fazla kez geçebiliyordu (havuz küçükse).
            // Çapraz (chunk'lar arası) tekilleştirme artık signedUrlCache'te
            // — bkz. yukarıdaki başlık. 25'lik pakette bu yol daha sık
            // devreye girer: havuz 150'ye yetmediği için yedekler tekrarlı
            // gelebilir.
            const uniqueCandidates = [
              ...new Map(candidates.map((f) => [f.name, f])).values(),
            ];
            try {
              const urls = await Promise.all(uniqueCandidates.map(cachedSignedUrl));
              await jobClock.run(chunkContext(jobDeadline, costLedger), () => runOpenAiDirectChunk(
                uid, jobId, bucketId, i, urls, refUrls, identityCaption,
                bodyProfile, refDescriptor, jobRef, photoMode, refEyeOpenness, refSkinTone, refHasFaceShine,
                holdForApproval, modelId, uniqueCandidates.map((f) => f.name), refSkinLight, refSkinMst
              ));
            } catch (e) {
              // TEK CHUNK'IN HATASI BÜTÜN İŞİ GÖTÜRMESİN (2026-09-21, aynı
              // olay): burada catch yoktu, bir chunk'ın hatası (imzalı URL
              // üretimindeki transient GCS hatası dahil) Promise.all'u anında
              // reddedip GERİ KALAN chunk'ları (bazıları çoktan başarılı
              // olsa bile) tam iptale ve tam iadeye düşürüyordu. Artık bu
              // chunk finalizeChunk({failed:true}) ile düzgünce kapatılıyor
              // (idempotent guard'lı — bkz. tanımının yanındaki not) ve
              // mevcut "EKSİK TESLİM = HAK İADESİ" mantığı yalnızca BU birim
              // için iade yapar, diğer chunk'lar etkilenmez.
              console.error(
                `Chunk hazırlığı başarısız (style=${bucketId}, chunk=${i}) — bu birim düşürülüyor:`, e
              );
              await finalizeChunk(uid, jobId, bucketId, i, { failed: true });
            }
          }));
          console.log(
            `MALIYET İŞ (${jobId}): harcanan=$${costLedger.spentUsd.toFixed(3)} sınır=$${costLedger.limitUsd.toFixed(2)} ` +
            `kare=${picked.length} bütçedenAtlananAdım=${costLedger.skipped}`
          );
          // KALICI MALİYET (2026-11-04): defter yalnız log'daydı; panelin
          // "onaylı kare başına maliyet" gösterebilmesi için dokümana
          // yazılıyor. Ölçülmüş API maliyeti (üretim + Vision + isteğe bağlı
          // AI adımları, bkz. costBasis); iş durumunu değiştirmez, yazılamazsa
          // akış bozulmaz.
          try {
            await jobRef.set({
              costUsd: Number(costLedger.spentUsd.toFixed(4)),
              // Kaynak: OpenAI yanıtlarındaki gerçek token kullanımı × fatura
              // ile kalibre edilmiş birim fiyat (jobContext.PRICES). Yerel
              // adımlar (LaMa, face-api) API maliyeti doğurmaz.
              costBasis: "openai-usage-tokens",
              costLimitUsd: Number(costLedger.limitUsd.toFixed(2)),
              costSkippedSteps: costLedger.skipped,
            }, { merge: true });
          } catch (e) {
            console.error("Maliyet dokümana yazılamadı (akış etkilenmez):", e.message || e);
          }
        }
      } else {
        // fal.ai YOLU — submit hızlı döner, webhook sonuçlandırıyor.
        // fal 2026-08-20'de akıştan çıkarıldı; bu dal yalnızca geri dönmek
        // gerekirse diye duruyor (bkz. useOpenAiDirect).
        const picked = usedFreeTier
          ? primaryTemplates.slice(0, FREE_TIER_CHUNK_COUNT)
          : primaryTemplates;
        const lockedCount = primaryTemplates.length - picked.length;
        const submissions = await Promise.all(
          picked.map(async (file, i) => {
            const templateUrl = await signedDownloadUrl(file);
            const falJob = await submitStyleJob(
              uid, jobId, bucketId, i, templateUrl, refUrls, identityCaption, bodyProfile, modelId
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
          results: { [bucketId]: {
            status: "pending", photoUrls: [], chunks,
            ...(lockedCount > 0 ? { lockedCount } : {}),
          } },
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
    } finally {
      // Referans selfie'ler artık kesin gerekmiyor: OpenAI doğrudan yolu
      // (useOpenAiDirect) SENKRON çalışıyor, bu noktaya gelindiğinde her
      // chunk için tüm indirme/üretim denemeleri (başarılı ya da başarısız)
      // zaten bitmiştir (bkz. yukarıdaki Promise.all). finally ile hem
      // başarı hem hata yolunda çalışır — KVKK silme garantisi bozulmaz.
      await deleteTrainingPhotos(uid, jobId);
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
          const refFaces = faceRefUrls(job.falRefUrls);
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
        // holdForApproval → staging; aksi halde doğrudan dating_results.
        const path = deliverPhotoPath(uid, jobId, styleId, chunkIdx, i, !!job.holdForApproval);
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
      job.identityCaption || null, job.bodyProfile || {}, modelId
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
    // GEÇ YAZMA KORUMASI (2026-11-04): iş zaten uç duruma geldiyse (temizlik
    // 'failed' yapıp iade etti; onay 'done' yaptı; süresi doldu) geç gelen
    // chunk sonucu yazılmaz. Eskiden yalnız chunk'ın kendi durumuna
    // bakılıyordu: temizlik sonrası gelen son chunk, işi yeniden
    // 'pendingApproval'a çevirebilir ya da İKİNCİ kez tam iade yapabilirdi.
    if (["failed", "done", JOB_STATUS_PENDING_APPROVAL, "expired"].includes(j.status)) {
      console.warn(`finalizeChunk (${jobId} ${styleId}/c${chunkIdx}): iş zaten '${j.status}', geç sonuç yok sayıldı`);
      return;
    }
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
      // NOT: eskiden ayrı bir `failedCount` vardı ve iade "başarısız stil
      // sayısı + eksik stil sayısı" olarak hesaplanırdı. Foto birimine
      // geçince bu hesap yanlış oldu; iade artık doğrudan EKSİK FOTO sayısı
      // üzerinden yapılıyor (bkz. missingPhotos) ve başarısız kovanın
      // fotoğrafları da o toplamın içinde.

      // EKSİK TESLİM = HAK İADESİ (2026-08-04; "7-10 foto" gevşetmesi
      // 2026-08-16'da geri alındı — bkz. OPENAI_DIRECT_MAX_ATTEMPTS: artık
      // chunk başarısız olsa bile 6 denemeye kadar FARKLI şablonlarla tekrar
      // deneniyor, yani eksik teslim tasarım gereği NADİR olmalı; olduğunda
      // yine tam iade mantıklı). Bir stil "done" sayılıyordu ve iade
      // almıyordu, tek bir fotoğraf bile üretilmişse — yani 5 fotoluk ödeme
      // yapıp 4 alan kullanıcı hiçbir şey geri almıyordu. Artık teslim
      // edilen foto sayısı BEKLENENDEN azsa o stilin birimi geri veriliyor;
      // kullanıcı setin tamamını (IMAGES_PER_STYLE) baştan üretebiliyor.
      //
      // "Beklenen" = AÇILAN chunk sayısı. Bu tanım ücretsiz denemeyi ve
      // kilitli fotoğrafları doğru şekilde dışarıda bırakır: ücretsiz
      // denemede zaten yalnızca FREE_TIER_CHUNK_COUNT kadar chunk açılıyor
      // (kilitli kalanlar hiç chunk değil), dolayısıyla 1/1 teslim "tam"
      // sayılır. Ayrıca packUnitsCharged>0 koşulu, ücretsiz denemede
      // (charged=0) iade yapılmasını ayrıca engeller.
      const expectedChunkCount = (k) => {
        if (k === styleId) return chunkKeys.length;
        const ch = (j.results || {})[k]?.chunks;
        return ch ? Object.keys(ch).length : 0;
      };
      // İADE ARTIK FOTO BAŞINA (2026-09-18, birim değişikliğinin zorunlu
      // sonucu). ESKİDEN birim "stil"di ve eksik teslimde O STİLİN 1 birimi
      // iade edilirdi — 10 fotodan 7'si gelse 1 birim (=10 foto) geri gelirdi.
      // Artık photoBalance FOTO sayıyor: 25'lik pakette 22 foto teslim
      // edilirse eski mantık yalnızca 1 foto iade ederdi, yani kullanıcı 3
      // fotoyu kaybederdi. Doğrusu EKSİK KALAN KADAR iade etmek.
      // FAZLA ÜRETİMDE İADE VAAT EDİLENE GÖRE (2026-09-22). Artık üretilen
      // (generateCount) kullanıcıya vaat edilenden (photoCount) fazla; eski
      // hesap "açılan chunk kadar kare gelmediyse iade et" diyordu ve 5'lik
      // pakette 10 chunk'ın 9'u gelince — kullanıcı 5 karesini eksiksiz
      // alacak olmasına rağmen — iade üretirdi. Ölçüt: teslim edilebilir
      // kare sayısı vaat edilenin altına düştü mü?
      const deliverableCount = Object.keys(results).reduce((sum, k) => {
        const r = results[k];
        if (!Array.isArray(r?.photoUrls)) return sum;
        return sum + (r.status === "done" ? r.photoUrls.length : 0);
      }, 0);
      const promisedCount = j.photoCount || expectedChunkCount(styleId) || 0;
      const missingPhotos = Math.max(0, promisedCount - deliverableCount);
      const incompleteCount = missingPhotos > 0 ? 1 : 0;

      // KALICI ÖLÇÜM (2026-11-04): kapı sayaçları ve teslim edilebilir kare
      // sayısı şimdiye kadar yalnız log'da ve panelin anlık hesabındaydı
      // (opsPanel.extractGateCounts). İş dokümanına yazılınca stil bazlı
      // geçiş oranı ve "onaylı kare başına maliyet" sorgulanabilir olur.
      // rejectedFrames dizisi saveRejectedFrame ile kare kare birikiyor;
      // burada iş kapanırken bir kez özetleniyor.
      {
        const gateCounts = {};
        for (const f of Array.isArray(j.rejectedFrames) ? j.rejectedFrames : []) {
          const g = f && typeof f.gate === "string" && f.gate ? f.gate : "?";
          gateCounts[g] = (gateCounts[g] || 0) + 1;
        }
        update.gateCounts = gateCounts;
        update.rejectedCount = Array.isArray(j.rejectedFrames) ? j.rejectedFrames.length : 0;
        update.deliverableCount = deliverableCount;
        update.generatedCount = j.generateCount || expectedChunkCount(styleId) || 0;
      }
      // İş uç duruma geliyor: biyometrik alanlar dokümandan silinir (bkz.
      // JOB_BIOMETRIC_FIELDS). Aşağıdaki dallar status'u pendingApproval /
      // done / failed yapar; üçünde de üretim bitmiştir.
      Object.assign(update, biometricFieldDeletes());

      if (successCount > 0) {
        // Kısmi başarı: üretilenleri göster, TESLİM EDİLMEYEN HER FOTO için
        // hak iade et.
        if (missingPhotos > 0 && (j.packUnitsCharged || 0) > 0) {
          const refundUnits = Math.min(missingPhotos, j.packUnitsCharged || 0);
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
              `EKSİK TESLİM: beklenenden ${missingPhotos} foto az üretildi ` +
              `— ${refundUnits} foto hakkı iade edildi (uid=${uid}, job=${jobId})`
            );
          }
        }
        // SÜRÜM KAPISI: holdForApproval yoksa eski davranış — doğrudan done.
        // Bayrak varsa üretim bitti ≠ teslim; opsApprovePhotos "done" yapar.
        if (j.holdForApproval) {
          update.status = JOB_STATUS_PENDING_APPROVAL;
          update.pendingApprovalAt = admin.firestore.FieldValue.serverTimestamp();
        } else {
          update.status = "done";
        }
      } else {
        // Hiç stil üretilmedi — tam iade.
        const walletSnap = await tx.get(walletRef);
        const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
        const walletUpdate = {
          photoBalance: (wallet.photoBalance || 0) + (j.packUnitsCharged || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        // Tam iade: düşülen paket de geri verilir (bkz. photoPacks.js).
        if (j.packConsumed) walletUpdate.photoPacks = require("./photoPacks").addPack(wallet.photoPacks, j.packConsumed);
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

// SELFIE İNCELEME KAYDI (2026-11-01, kullanıcı isteği: "bilgisayar açık
// kalmasa da kaydedilsin, çıktıların yanında görebileyim"). config/selfieReview
// `uids` listesindeki hesabın BİR SONRAKİ üretiminde selfie'ler silinmeden önce
// dating_debug/selfies/{uid}/{jobId}/'e kopyalanır ve uid listeden düşer (tek
// seferlik). Ops paneli iş detayında gösterir (opsGetJobDetail.selfies).
// Liste boşsa hiçbir şey yapmaz; hata üretimi asla engellemez.
const SELFIE_REVIEW_DOC = "config/selfieReview";
const SELFIE_REVIEW_PREFIX = "dating_debug/selfies/";
async function keepSelfiesForReview(uid, jobId) {
  try {
    const ref = db.doc(SELFIE_REVIEW_DOC);
    const snap = await ref.get();
    const uids = snap.exists && Array.isArray(snap.get("uids")) ? snap.get("uids") : [];
    if (!uids.includes(uid)) return;
    const [files] = await bucket().getFiles({ prefix: `dating_training/${uid}/${jobId}/` });
    const photos = files.filter((f) => f.name.includes("photo_"));
    if (!photos.length) return;
    const dir = `${SELFIE_REVIEW_PREFIX}${uid}/${jobId}/`;
    await Promise.all(photos.map((f) => f.copy(bucket().file(dir + f.name.slice(f.name.lastIndexOf("/") + 1)))));
    await ref.update({ uids: admin.firestore.FieldValue.arrayRemove(uid) });
    console.log(`SELFIE İNCELEME KAYDI (${jobId}): ${photos.length} selfie → ${dir}`);
  } catch (e) {
    console.error(`Selfie inceleme kaydı başarısız (${jobId}), üretim sürüyor:`, e.message || e);
  }
}

// İŞ DOKÜMANINDAKİ BİYOMETRİK ALANLAR (2026-11-04, KVKK). Selfie'ler
// Storage'dan üretim başlar başlamaz siliniyordu ama prepareReferencePhotos'un
// dokümana yazdığı 128 boyutlu yüz vektörü (refDescriptor), ten ölçümleri ve
// selfie adresleri süresiz kalıyordu. Bunların hepsi yalnız üretim SIRASINDA
// gerekir (startPhotoGeneration başta belleğe alır, bkz. ~7356-7367); iş
// uç duruma gelince (pendingApproval/done/failed/expired) silinir. Ops paneli
// ve onay akışı bu alanları kullanmaz.
const JOB_BIOMETRIC_FIELDS = [
  "refDescriptor", "refSkinTone", "refSkinMst", "refSkinLight",
  "refEyeOpenness", "refHasFaceShine", "falRefUrls", "primaryFaceUrl",
];
function biometricFieldDeletes() {
  const o = {};
  for (const k of JOB_BIOMETRIC_FIELDS) o[k] = admin.firestore.FieldValue.delete();
  return o;
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
    if (!jobSnap.exists ||
        jobSnap.data().status === "failed" ||
        jobSnap.data().status === "done" ||
        jobSnap.data().status === JOB_STATUS_PENDING_APPROVAL) {
      return; // zaten sonuçlanmış (onay bekleyen işe dokunma)
    }
    const job = jobSnap.data();
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
    const walletUpdate = {
      photoBalance: (wallet.photoBalance || 0) + unitsToRefund,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    // Tam iade: düşülen paket de geri verilir (bkz. photoPacks.js).
    if (job.packConsumed && unitsToRefund >= (job.packUnitsCharged || 0) && unitsToRefund > 0) {
      walletUpdate.photoPacks = require("./photoPacks").addPack(wallet.photoPacks, job.packConsumed);
    }
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
      ...biometricFieldDeletes(),
    }, { merge: true });
  });
  await deleteTrainingPhotos(uid, jobId);
}

/**
 * Webhook teslimatı güvenilmez olabilir — uzun süredir 'generating' takılı
 * kalan işleri başarısız sayıp iade eder.
 *
 * 'ready' İŞLER BURAYA DÜŞMEZ (2026-09-10 gerçek olay). Akış iki adımlı:
 * prepareReferencePhotos işi 'ready' yapar (bakiye DÜŞÜLMEZ), sonra kullanıcı
 * stil seçip startPhotoGeneration'ı çağırır. Yani 'ready', kullanıcının stil
 * seçim ekranında beklediği NORMAL bir durum — hata değil. Eskiden 5 dakika
 * sonra "Zaman aşımı — işlem tamamlanamadı" yazılıyordu; client job dokümanını
 * canlı dinlediği için kullanıcı stil seçerken ekranı bir anda hata ekranına
 * dönüyordu. Gerçek etki (10 Eylül): üç kullanıcı toplam 12 kez böyle "hata"
 * aldı, bakiyeleri duruyordu ama hata gördükleri için üst üste paket satın
 * aldılar (biri 4 paket alıp 3'ünü hiç kullanmadan bıraktı).
 *
 * 'uploading' yalnızca eski/kalıntı işler için (artık üretilmiyor).
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
      const uid = doc.ref.parent.parent.parent.parent.id; // users/{uid}/private/genData/genJobs/{jobId}
      const job = doc.data();
      // BİTMİŞ KARELER KORUNUR (2026-11-18): nabız artık süre dolunca
      // kesildiği için (bkz. NABIZ SÜRE DOLUNCA DURUR) tek bir asılı chunk işi
      // bayatlatabilir. Chunk'ı başlamış işte önce bekleyen chunk'lar tek tek
      // kapatılır — finalizeChunk biten kareleri teslim eder, eksik kadar iade
      // eder. Hiç chunk yoksa ya da iş hâlâ kapanmadıysa eski tam iade.
      if (job.status === "generating") {
        let closed = 0;
        for (const [styleId, r] of Object.entries(job.results || {})) {
          for (const [idx, c] of Object.entries((r && r.chunks) || {})) {
            if (!c || c.status !== "pending" || !c.startedAt) continue;
            console.warn(`Takılı chunk kapatılıyor (bayat iş): ${doc.ref.path} ${styleId}/c${idx}`);
            await finalizeChunk(uid, doc.id, styleId, idx, { failed: true });
            closed++;
          }
        }
        if (closed) {
          const after = (await doc.ref.get()).data() || {};
          if (after.status !== "generating" && after.status !== "uploading") continue;
        }
      }
      console.warn(`Takılı iş temizleniyor: ${doc.ref.path}`);
      await refundAndFail(uid, doc.id, job.packUnitsCharged || 0, "Zaman aşımı — işlem tamamlanamadı.");
    }

    // CHUNK BAZLI TAKILMA (2026-11-04): iş dokümanı canlı (başka chunk'lar
    // nabız atıyor) ama bir chunk'ın kendi nabzı kesilmişse o chunk tek
    // başına 'failed' kapatılır; finalizeChunk idempotent olduğu için chunk
    // sonradan yine de bitirirse sonucu yok sayılır, iş diğer chunk'larla
    // normal kapanır (eksik kare iadesi finalizeChunk'ta). Nabzı hiç olmayan
    // (eski sürümde başlamış) chunk'lara dokunulmaz.
    const live = await db
      .collectionGroup("genJobs")
      .where("status", "==", "generating")
      .where("updatedAt", ">=", cutoff)
      .get();
    const staleMs = CHUNK_HEARTBEAT_STALE_MS;
    for (const doc of live.docs) {
      const uid = doc.ref.parent.parent.parent.parent.id;
      const job = doc.data();
      for (const [styleId, r] of Object.entries(job.results || {})) {
        for (const [idx, c] of Object.entries((r && r.chunks) || {})) {
          if (!c || c.status !== "pending") continue;
          const beat = c.lastHeartbeatAt || c.startedAt;
          if (!beat || typeof beat.toMillis !== "function") continue;
          // SÜRESİ GEÇMİŞ CHUNK (2026-11-18, 156fa173 c0): nabız atsa bile
          // fonksiyon süresini aşmış chunk artık sonuç üretemez (istek kapandı,
          // CPU kısıldı) — nabza bakmadan kapatılır.
          const started = c.startedAt && typeof c.startedAt.toMillis === "function" ? c.startedAt.toMillis() : null;
          const overdue = started != null && Date.now() - started > CHUNK_MAX_AGE_MS;
          if (!overdue && Date.now() - beat.toMillis() < staleMs) continue;
          console.warn(`Takılı chunk kapatılıyor: ${doc.ref.path} ${styleId}/c${idx} sonNabız=${Math.round((Date.now() - beat.toMillis()) / 1000)}sn önce${overdue ? ` başlangıç=${Math.round((Date.now() - started) / 1000)}sn önce (süre aşıldı)` : ""}`);
          await finalizeChunk(uid, doc.id, styleId, idx, { failed: true });
        }
      }
    }
  }
);
// Bir chunk'ın nabzı bu kadar süre kesilmişse takılı sayılır. Nabız 90 sn'de
// bir atar; 6 dk = dört kaçırılmış atış, tek bir Firestore yazım hatasıyla
// yanlış kapanmaz.
const CHUNK_HEARTBEAT_STALE_MS = 6 * 60 * 1000;
// Fonksiyon süresi (900 sn) + 2 dk pay: bundan yaşlı pending chunk nabızdan
// bağımsız kapatılır (bkz. SÜRESİ GEÇMİŞ CHUNK).
const CHUNK_MAX_AGE_MS = JOB_TIME_LIMIT_MS + 2 * 60 * 1000;

/**
 * 'ready' işlerin KVKK temizliği — cleanupStuckGenJobs'tan ayrı tutuldu
 * (bkz. oradaki gerekçe). Kullanıcı stil seçim ekranında saatlerce
 * bekleyebilir; bu yüzden burada eşik 24 saat ve iş 'failed' YAPILMAZ —
 * yalnızca selfie'ler silinir ve iş 'expired' işaretlenir. Client 'expired'i
 * hata olarak göstermez (yalnızca 'failed' hata ekranı açar), dolayısıyla
 * ekranda bekleyen kimse yanlışlıkla hata görmez.
 */
exports.cleanupExpiredReadyJobs = onSchedule(
  { schedule: "every 60 minutes", region: "europe-west1", timeoutSeconds: 300 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const expired = await db
      .collectionGroup("genJobs")
      .where("status", "==", "ready")
      .where("updatedAt", "<", cutoff)
      .get();

    for (const doc of expired.docs) {
      const uid = doc.ref.parent.parent.parent.parent.id;
      console.warn(`Süresi dolmuş 'ready' iş temizleniyor: ${doc.ref.path}`);
      await doc.ref.set({
        status: "expired",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...biometricFieldDeletes(),
      }, { merge: true });
      await deleteTrainingPhotos(uid, doc.id);
    }
  }
);

/**
 * ONAY BEKLEME SÜRESİ (2026-11-04). 'pendingApproval' için hiçbir süre
 * sınırı yoktu: kullanıcı ödemiş, kareler hazır, admin onaylamadıkça iş
 * sonsuza dek bekliyordu; staging TTL'si dolunca da panelde karesi olmayan
 * "onay bekleyen" iş kalacaktı. İki eşik:
 *  • PENDING_WARN_MS (3 gün): iş `pendingApprovalOverdue: true` işaretlenir
 *    ve uyarı loglanır (panel bunu kırmızı gösterebilir). İş durumu değişmez.
 *  • PENDING_CANCEL_MS (30 gün): iş iptal edilir, düşülen hakkın HENÜZ İADE
 *    EDİLMEMİŞ kısmı iade edilir (bkz. pendingCancelRefund), kullanıcıya iade
 *    mesajı yazılır ve bildirim gider; staging ve reddedilen kare dosyaları
 *    silinir. Staging TTL'si (90 gün) bundan uzun olduğu için dosyalar
 *    karardan önce silinmez.
 * Onay zaten yapılmış işler (status done) bu sorguya girmez.
 */
const PENDING_WARN_MS = PENDING_APPROVAL_WARN_MS;
const PENDING_CANCEL_MS = PENDING_APPROVAL_CANCEL_MS;
exports.cleanupOverduePendingApproval = onSchedule(
  { schedule: "every 60 minutes", region: "europe-west1", timeoutSeconds: 300 },
  async () => {
    const now = Date.now();
    const warnCutoff = admin.firestore.Timestamp.fromMillis(now - PENDING_WARN_MS);
    const snap = await db
      .collectionGroup("genJobs")
      .where("status", "==", JOB_STATUS_PENDING_APPROVAL)
      .where("pendingApprovalAt", "<", warnCutoff)
      .get();
    let warned = 0, cancelled = 0;
    for (const doc of snap.docs) {
      const uid = doc.ref.parent.parent.parent.parent.id;
      const job = doc.data();
      const waitedMs = now - (job.pendingApprovalAt ? job.pendingApprovalAt.toMillis() : now);
      if (waitedMs >= PENDING_CANCEL_MS) {
        console.warn(`ONAY SÜRESİ DOLDU: ${doc.ref.path} ${Math.round(waitedMs / 86400000)} gün bekledi — iptal ve iade`);
        if (await cancelPendingApprovalJob(uid, doc.id)) cancelled++;
      } else if (job.pendingApprovalOverdue !== true) {
        console.warn(`ONAY GECİKTİ: ${doc.ref.path} ${Math.round(waitedMs / 3600000)} saattir onay bekliyor`);
        await doc.ref.set({ pendingApprovalOverdue: true }, { merge: true });
        warned++;
      }
    }
    if (warned || cancelled) console.log(`ONAY BEKLEME TARAMASI: uyarı=${warned} iptal=${cancelled} toplamBekleyen=${snap.size}`);
  }
);

/**
 * Onay bekleme iptalinde iade edilecek miktar. SAF. İş onaya düşerken eksik
 * kareler için kısmi iade yapılmış olabilir (finalizeChunk → refundedUnits);
 * iptal yalnız KALANI iade eder. Paket defteri yalnız hiç iade yapılmamışsa
 * geri verilir: kısmi iade serbest hak olarak eklendi, paket de geri gelirse
 * defter bakiyeyi aşar (bkz. refundAndFail'deki aynı kural).
 * Döner { units, totalRefunded, returnPack }.
 */
function pendingCancelRefund(job) {
  const charged = Math.max(0, Number(job.packUnitsCharged) || 0);
  const already = Math.min(charged, Math.max(0, Number(job.refundedUnits) || 0));
  const units = charged - already;
  return {
    units,
    totalRefunded: already + units,
    returnPack: !!job.packConsumed && already === 0 && units > 0,
  };
}

/** Onayı çok geciken işi iptal eder: kalan hak iadesi, 'failed'. İptal
 *  yapıldıysa true döner. */
async function cancelPendingApprovalJob(uid, jobId) {
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  const jobRef = db.doc(`users/${uid}/private/genData/genJobs/${jobId}`);
  let refund = null;
  await db.runTransaction(async (tx) => {
    refund = null;
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data().status !== JOB_STATUS_PENDING_APPROVAL) return;
    const job = jobSnap.data();
    const r = pendingCancelRefund(job);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };
    const walletUpdate = {
      photoBalance: (wallet.photoBalance || 0) + r.units,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (r.returnPack) {
      walletUpdate.photoPacks = require("./photoPacks").addPack(wallet.photoPacks, job.packConsumed);
    }
    if (job.usedFreeTier === true) walletUpdate.freePhotoUsed = false;
    tx.set(walletRef, walletUpdate, { merge: true });
    tx.set(jobRef, {
      status: "failed",
      errorMessage: "Fotoğrafların onay sürecinde beklemede kaldı; hakkın hesabına iade edildi, dilediğin zaman yeniden üretebilirsin.",
      refundedUnits: r.totalRefunded,
      cancelRefundedUnits: r.units,
      cancelledReason: "pending-approval-timeout",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    refund = r;
  });
  if (!refund) return false;
  console.warn(`ONAY İPTALİ (uid=${uid}, job=${jobId}): iade=${refund.units} toplamİade=${refund.totalRefunded} paketGeri=${refund.returnPack ? "evet" : "hayır"}`);
  // İptal edilen işin kareleri artık kimseye teslim edilmeyecek; kullanıcının
  // yüzünü taşıdıkları için TTL beklenmeden silinir (KVKK).
  await Promise.all([
    bucket().deleteFiles({ prefix: `dating_staging/${uid}/${jobId}/` }),
    bucket().deleteFiles({ prefix: `${DEBUG_ROOT}/${uid}/${jobId}/` }),
  ]).catch((e) => console.error(`Onay iptali: dosyalar silinemedi (${jobId}, TTL silecek):`, e.message || e));
  await require("./notifications").sendPushToUser(uid, {
    title: "Fotoğraf hakkın iade edildi",
    body: "Fotoğrafların onay sürecinde beklemede kaldı; hakkın hesabına geri yüklendi, dilediğin zaman yeniden üretebilirsin.",
    data: { type: "photos_refunded", jobId },
  });
  return true;
}

// Saf yardımcıların testten erişilebilmesi için. index.js barrel'ı yalnızca
// seçili Cloud Function isimlerini dışa açtığı için (bkz. o dosyadaki liste)
// _testables ASLA bir fonksiyon olarak deploy edilmez — opsPanel.js'teki
// aynı desen.
exports._testables = {
  hiResSize,
  basePromptPose,
  retryCorrectionPrefix,
  chooseCandidate,
  templateMetaIndex,
  templateMetaFor,
  yawOver3d,
  pngToDeliverJpeg,
  buildEditPromptP800,
  prepareTemplate,
  orderRefsByPose,
  prepareSelfieSet,
  predictedOutYaw,
  selfieOrderForYaw,
  selfieOrderCore,
  UNREACHABLE_SKIP_DEG,
  generateForMode,
  PHOTO_MODE_P800,
  headWidthMeasurement,
  TEMPLATE_RETRY_LARGE_FACE_RATIO,
  generateCountFor,
  deliverPhotoPath,
  jobClock,
  jobTimeLeftMs,
  JOB_TIME_LIMIT_MS,
  JOB_FINALIZE_RESERVE_MS,
  pendingCancelRefund,
};
