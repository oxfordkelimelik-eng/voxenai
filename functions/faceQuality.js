// Referans selfie kalite kapısı VE üretim çıktısı kimlik denetimi.
//
// İKİ AYRI GÖREV:
//   1) analyzeReferences() — kullanıcı fotoğraf seçerken (prepareReferencePhotos):
//      net/tek yüz kontrolü + en iyi referansın öne alınması + kaynak kimlik
//      vektörünün (ortalama descriptor) hesaplanması.
//   2) matchesIdentity() — fal.ai'den dönen HER üretilmiş görsel için
//      (falInferenceWebhook): o görseldeki yüzün, kaynak selfie'lerin kimlik
//      vektörüne yeterince yakın olup olmadığını kontrol eder. Yeterince
//      yakın değilse çağıran taraf o chunk'ı otomatik yeniden üretir (bkz.
//      falPhotos.js maybeRetryChunk) — kullanıcı hiçbir zaman "yüzü bozuk"
//      bir fotoğraf görmez.
//
// GEÇMİŞ NOT: Bu ikinci adım (kimlik karşılaştırması) bir ara koddan tamamen
// kaldırılmıştı ("üretim modeli zaten kimlik koşullu, ek kontrol gereksiz"
// varsayımıyla). Pratikte edit modelleri (nano-banana-pro/edit dahil) zaman
// zaman yüz şeklini bozan çıktılar üretebiliyor ve bunu yakalayan hiçbir
// mekanizma yoktu. Artık her chunk TEK görsel ürettiği için (num_images:1),
// "bu görsel geçmedi" = "bu chunk'ı yeniden üret" doğrudan mevcut retry
// altyapısına oturuyor — vaat edilen foto sayısı yine bozulmuyor.
//
// @tensorflow/tfjs-node (native) yerine bilerek saf WASM backend — native
// derleme Windows'ta ve Cloud Functions'ta kırılgandı; WASM platform bağımsız.
//
// GENİŞLETİLMİŞ RED KRİTERLERİ (3. görev): "net/tek yüz" yeterli değil —
// bulanık (Laplacian varyansı) ve aşırı pozlanmış (histogram clipping)
// referanslar da elenir. Bunlar "çöp girdi = çöp çıktı"nın somut örnekleri:
// özellikle ağır beautify/filtre uygulanmış selfie'ler genelde hem aşırı
// yumuşak (düşük varyans) hem aşırı parlak gelir — bu iki kontrol dolaylı
// olarak bu selfie'leri de yakalar (özel bir "filtre tespiti" değil, ama
// pratikte örtüşüyor).

const path = require("path");
const sharp = require("sharp");

// Yüzün kadrajda kaplaması gereken asgari oran (kenar). Bunun altındaki
// yüzler "net değil/uzak" sayılır.
// GEVŞETİLDİ (2026-07-26, "çok zor kabul ediyor" geri bildirimi): 0.12 -> 0.06.
const MIN_FACE_RATIO = 0.06;
// ssd_mobilenetv1 tespit güveni eşiği. GEVŞETİLDİ: 0.5 -> 0.35.
const MIN_DETECTION_CONFIDENCE = 0.35;

// Laplacian varyansı bu değerin ALTINDAYSA bulanık say.
// GEVŞETİLDİ (2026-07-26 kullanıcı geri bildirimi: "iyi çektiğim halde
// bulanık diyor"): 60 hâlâ gerçek, net telefon selfie'lerini yanlışlıkla
// reddediyordu — telefon kameralarının doğal (hafif) yumuşatma/ISO gürültü
// azaltma işlemede varyansı düşürebiliyor. 60 -> 25.
const BLUR_VARIANCE_MIN = 25;
// Görselin bu ORANDAN FAZLASI (0-1) neredeyse beyazsa (>250/255) aşırı
// pozlanmış say. GEVŞETİLDİ (2026-07-26): 0.45 -> 0.65.
const OVEREXPOSURE_CLIP_MAX = 0.65;

// Kimlik eşleşme eşiği (öklid mesafesi, düşük = daha benzer). face-api.js'in
// standart eşiği ~0.6, ama bu modelin (2018, face-api.js recognition net)
// belgelenmiş bir zayıflığı var: yanlış-red oranı modern modellere (ör.
// ArcFace/buffalo_l) göre yüksek — yani GERÇEKTE aynı kişi olan üretimleri
// bile gereksiz yere "eşleşmedi" sayıp retry'ye gönderiyor. ArcFace'e geçmek
// Cloud Functions'ta ek risk (native/WASM ONNX, ~190MB model, soğuk başlangıç
// — bkz. proje notları) taşıdığı için önce BEDAVA olan bu ayarı deniyoruz:
// eşik 0.60 -> 0.63 gevşetildi. Stil/ışık değişince aynı kişi zaten
// 0.55-0.65 aralığına düşebiliyordu; bu değişiklik yalnızca daha önce
// sınırda reddedilen gerçek-eşleşmeleri kabul etmeyi hedefliyor.
// KALİBRASYON NOTU: bu değer gerçek kullanıcı verisiyle kalibre edilmedi.
// 2026-07-23 GERÇEK VERİ (edit mimarisi, elegance): sınırda iyi yüzler
// RED(0.648) ve RED(0.758) ile eleniyordu — 5 fotodan 2'si boşuna kaybolup
// kullanıcı 3 foto alıyordu (retry=0). Eşik 0.63 -> 0.70: 0.648 gibi sınırda-
// kabul edilebilir yüzler geçer, 0.758 gibi açıkça yanlış yüzler yine reddedilir.
// Asıl çözüm buildEditPrompt'taki güçlendirilmiş yüz-sadakati (mesafeler zaten
// düşmeli); bu eşik yalnızca sınır kayıplarını azaltıyor.
//
// 0.70 -> 0.55 SIKILAŞTIRILDI (2026-08-04, İLK KEZ GERÇEK DAĞILIMLA):
// 2026-07-28'den itibaren loglanan 60 ölçümün TAMAMI geçti — yani 0.70 eşiği
// hiçbir zaman devreye girmedi, fiilen kapalı bir kapıydı. Gerçek dağılım:
//   0.210 ... 0.498 (58 kare, ana kütle)  |  0.534  |  [boşluk]  |  0.646
// 0.646'lık kare kullanıcı tarafından "taban fotoğraf gibi, yüz benzememiş"
// diye işaretlendi (smokinli, loş sahne). 0.534 ile 0.646 arasındaki doğal
// boşluk eşik için doğru yer: onaylanmış-kötü kareyi eler, ana kütleye ve
// 0.534'e dokunmaz (60 karede yalnızca 1 ret = %1.7).
// Ret = kare atılmaz, ÖNCE yeniden denenir (OPENAI_DIRECT_MAX_ATTEMPTS=2);
// iki deneme de tutmazsa o kare eksik kalır. Foto kaybı görülürse 0.60'a
// çekilebilir; "yüz benzemiyor" şikayeti sürerse 0.50'ye.
const FACE_MATCH_THRESHOLD = 0.55;

let _initPromise = null;
let _faceapi = null;

async function ensureModelsLoaded() {
  if (_faceapi) return _faceapi;
  if (!_initPromise) {
    _initPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      await tf.setBackend("wasm");
      await tf.ready();
      const modelPath = path.join(__dirname, "models");
      // Tespit + tanıma birlikte yüklenir — kimlik karşılaştırması için
      // landmark68 (hizalama) ve recognition (128 boyutlu descriptor) şart.
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
      _faceapi = faceapi;
      return faceapi;
    })();
  }
  return _initPromise;
}

// Yüz tespiti/tanıma için maksimum kenar uzunluğu. Modern telefon fotoları
// tam çözünürlükte tensöre çevrilince OOM oluyordu; ~800px fazlasıyla
// yeterli ve tensör boyutunu ~25x küçültür.
const MAX_FACE_DIM = 800;

/**
 * Görsel buffer'ını tensöre çevirir VE uygulanan küçültme ölçeğini döner
 * (scale=1 → küçültülmedi). Çağıran taraf, tensör-uzayındaki bir kutuyu
 * (ör. yüz bounding box) ORİJİNAL görsel piksel koordinatına
 * `box / scale` ile geri çevirebilir — bkz. detectSingleFace.
 *
 * DEKODER: jpeg-js YERİNE sharp (2026-08-07). jpeg-js SADECE JPEG çözer;
 * havuzdaki bazı şablonlar JPEG değil (PNG/WebP) ve onlarda `SOI not found`
 * ile patlıyordu. Gerçek etki canlı logda görüldü: hem şablon kırpma
 * ("Şablon hazırlama başarısız: SOI not found" → kırpma hiç yapılamıyor,
 * yüz oranı düzeltmesi kayboluyor) hem de ten rengi kapısı (o karelerde
 * ölçüm hiç çalışmıyor) sessizce devre dışı kalıyordu. sharp tüm yaygın
 * formatları çözer.
 *
 * DAVRANIŞ AYNI TUTULDU: EXIF döndürmesi BİLİNÇLİ olarak uygulanmıyor
 * (`.rotate()` yok) — jpeg-js de uygulamıyordu ve referans fotoğraflar bu
 * noktaya gelmeden zaten normalizeExifOrientation'dan geçiyor. Buraya rotate
 * eklemek mevcut kimlik ölçümlerini sessizce kaydırırdı.
 */
async function bufferToTensorScaled(buf) {
  const tf = require("@tensorflow/tfjs");
  // ensureAlpha + srgb: girdi gri tonlama ya da CMYK olsa bile her zaman
  // 4 kanal RGBA gelir — aşağıdaki şerit-alma döngüsü jpeg-js'inkiyle
  // birebir aynı kalır.
  const { data, info } = await sharp(buf)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const longEdge = Math.max(width, height);
  const scale = longEdge <= MAX_FACE_DIM ? 1 : MAX_FACE_DIM / longEdge;
  const tensor = tf.tidy(() => {
    const full = tf.tensor3d(rgb, [height, width, 3]);
    if (scale === 1) return full;
    return tf.image
      .resizeBilinear(full, [Math.round(height * scale), Math.round(width * scale)])
      .toInt();
  });
  return { tensor, scale };
}

/**
 * Bir JPEG buffer'ında yüz TESPİTİ yapar (tanıma yok). Döner:
 *   { ok: true, area, box } → kadrajda yeterince büyük TAM OLARAK bir yüz
 *     var. box, ORİJİNAL görsel piksel koordinatlarında {x,y,width,height}
 *     (kırpma için — bkz. postProcess.cropFaceRegion).
 *   { ok: false }      → yüz yok, çok küçük, ya da birden fazla yüz.
 */
async function detectSingleFace(buf, { minFaceRatio = MIN_FACE_RATIO } = {}) {
  const faceapi = await ensureModelsLoaded();
  const { tensor, scale } = await bufferToTensorScaled(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    const [h, w] = tensor.shape;
    const big = faces.filter((f) => {
      const ratio = Math.max(f.box.width / w, f.box.height / h);
      return ratio >= minFaceRatio;
    });
    if (big.length !== 1) return { ok: false };
    const b = big[0].box;
    const box = {
      x: b.x / scale, y: b.y / scale,
      width: b.width / scale, height: b.height / scale,
    };
    // ratio = yüzün kadrajı kaplama oranı (uzun kenar). Tam boy referansın
    // GERÇEKTEN tam boy olup olmadığını ayırt etmek için kullanılır
    // (yüz büyükse = yakın selfie, gövde görünmüyor — bkz. analyzeReferences).
    const ratio = Math.max(b.width / w, b.height / h);
    return { ok: true, area: (b.width * b.height) / (w * h), ratio, box };
  } finally {
    tensor.dispose();
  }
}

// Tam boy referansta yüz kadrajın küçük bir kısmıdır — yüz selfie eşiği
// (MIN_FACE_RATIO) ile reddedilmemeli.
// GEVŞETİLDİ (2026-07-26 kullanıcı geri bildirimi: "boydan seçtiğimiz
// fotoğrafı sürekli reddediyor"): uzaktan çekilmiş gerçek tam boy karelerde
// yüz çok küçük kalıp 0.04 altında tespit edilemiyordu → 0.015'e düşürüldü.
const MIN_FACE_RATIO_BODY = 0.015;
// ...ama yüz kadrajın ÜST sınırından da BÜYÜKSE bu tam boy değil, yakın bir
// selfie/portredir — gövde görünmüyordur, reddet. Kaba oran tahmini:
// tam boy yüz ~0.13, bel üstü ~0.28, baş-omuz selfie ~0.5. Eşik 0.35 -> 0.45:
// bel/kalça üstü kadrajları da (yüz biraz daha büyük görünse de) kabul eder,
// yalnızca gerçekten baş-omuz yakın çekimini eler. Client tarafı
// (GuidedCaptureScreen pose kontrolü) asıl "ayaklar kadrajda mı"yı tutuyor;
// bu sunucu kapısı yalnızca "sadece yüz gönderilmiş" durumunu yakalar.
const MAX_FACE_RATIO_BODY = 0.45;
// Açı çeşitliliği kapısı: iki YÜZ karesinin kimlik vektörü birbirine bu
// mesafeden yakınsa neredeyse aynı kare/açı sayılır (kullanıcı ör. 3 kez
// cepheden çekmiş) — farklı açı kimlik sadakatini artırır. MUHAFAZAKÂR:
// vektör mesafesi kimliği ölçer, açıyı değil (aynı kişinin farklı açıları da
// yakın çıkabilir) → yalnızca neredeyse-aynı kareleri yakalamak için düşük
// tutuldu (yanlış-red riski). Gerçek veriyle KALİBRE EDİLMEDİ; canlı çekim
// zaten yaw ile açı çeşitliliğini dayattığı için bu bir güvenlik ağıdır.
const DEDUP_MIN_DISTANCE = 0.25;

// İki 128-boyut descriptor arasındaki öklid mesafesi (faceapi'ye async
// erişim gerekmeden — dedup senkron çalışsın).
function euclideanDistanceLocal(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Laplacian varyansı (bulanıklık ölçütü — düşük = bulanık) ve aşırı pozlama
 * (neredeyse-beyaz piksel oranı) hesaplar. Yalnızca referans SEÇİMİNDE
 * kullanılır (üretim çıktısında değil — çıktının netliği zaten prompt'un
 * "CRAFT" bölümünde bilinçli olarak kusurlu isteniyor, orayı bulanıklık
 * kontrolüyle elemek amaca aykırı olurdu).
 */
async function assessImageQuality(buf) {
  const gray = sharp(buf).resize({ width: 600, withoutEnlargement: true }).grayscale();

  const [lap, exposure] = await Promise.all([
    gray.clone()
      // Laplacian kenar kernel'i; offset:128 negatif değerlerin 0'a
      // kırpılıp varyansı yapay düşürmesini önler (varyans sabit ekleme
      // altında değişmez, yalnızca kırpılmayı engelliyoruz).
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
      .raw()
      .toBuffer(),
    gray.clone().threshold(250).raw().toBuffer(),
  ]);

  let mean = 0;
  for (let i = 0; i < lap.length; i++) mean += lap[i];
  mean /= lap.length;
  let variance = 0;
  for (let i = 0; i < lap.length; i++) {
    const d = lap[i] - mean;
    variance += d * d;
  }
  variance /= lap.length;

  let clipped = 0;
  for (let i = 0; i < exposure.length; i++) if (exposure[i] > 0) clipped++;
  const clippedFraction = clipped / exposure.length;

  return {
    blurScore: variance,
    isBlurry: variance < BLUR_VARIANCE_MIN,
    clippedFraction,
    isOverexposed: clippedFraction > OVEREXPOSURE_CLIP_MAX,
  };
}

/**
 * Bir JPEG buffer'ından yüz descriptor'ı (128 boyutlu kimlik vektörü)
 * çıkarır. Yüz bulunamazsa null döner.
 */
async function descriptorFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = await bufferToTensorScaled(buf);
  try {
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: MIN_DETECTION_CONFIDENCE,
      }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!result) return null;
    // Nirengi noktaları BU çağrıda zaten çıkarıldı — göz açıklığını buradan
    // okumak ek bir model geçişi gerektirmiyor (bkz. EAR başlığı).
    return {
      descriptor: result.descriptor,
      eyeOpenness: eyeOpennessFromLandmarks(result.landmarks),
    };
  } finally {
    tensor.dispose();
  }
}

/**
 * descriptorFromBuffer'ın genişletilmiş hali: kimlik vektörünün YANINDA yüz
 * kutusunun görsele oranını da döndürür (kafa oransallığı kontrolü için).
 * Döner: { descriptor, faceRatio } — yüz yoksa null. faceRatio = yüz
 * kutusunun uzun kenarının görsel uzun kenarına oranı (küçük yüz -> düşük,
 * bobble-head/oransız büyük kafa -> yüksek).
 */
async function descriptorAndBoxFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = await bufferToTensorScaled(buf);
  try {
    const [h, w] = tensor.shape; // [height, width, 3]
    // EŞİK AÇIKÇA VERİLİYOR: seçeneksiz çağrıldığında face-api kendi
    // varsayılanını (minConfidence 0.5) kullanıyordu, oysa projenin kalibre
    // edilmiş eşiği 0.35. Tutarlılık için açıkça geçiliyor.
    // NOT: bu tek başına "no-face" sorununu ÇÖZMEZ — 2026-08-03 çıktıları
    // üzerinde ölçüldüğünde tespit skorları zaten 0.93-0.99 aralığındaydı,
    // yani eşik hiç bağlayıcı değildi.
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: MIN_DETECTION_CONFIDENCE,
      }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!result) return null;
    const box = result.detection.box;
    const faceRatio = Math.max(box.width / w, box.height / h);
    return {
      descriptor: result.descriptor,
      faceRatio,
      profileDegree: profileDegreeFromLandmarks(result.landmarks),
      eyeOpenness: eyeOpennessFromLandmarks(result.landmarks),
    };
  } finally {
    tensor.dispose();
  }
}

// ---------------------------------------------------------------------------
// GÖZ AÇIKLIĞI (EAR — Eye Aspect Ratio)
//
// SORUN (2026-08-09, kullanıcı geri bildirimi): çıktılarda gözler yarı kapalı
// görünüp kişi "uykulu/ölü bakışlı" çıkabiliyor. Kaynak iki yerde olabilir:
// (a) referans selfie'de gözler zaten kısık — model onu KİMLİK sanıp kopyalar
// (prompt zaten "gözlerin gerçek şekli kimliktir" diyor), (b) model kareyi
// göz kırpma anındaymış gibi üretir.
//
// EAR = göz yüksekliğinin genişliğine oranı; 68 nirengi noktasından hesaplanır
// ve ÖLÇEKTEN BAĞIMSIZDIR (oran). Noktalar zaten çıkarılıyor, ek maliyet yok.
//
// ADALET UYARISI — BURASI ÖNEMLİ: göz açıklığı kişiden kişiye, etnik kökene,
// gülümsemeye ve kamera açısına göre büyük ölçüde değişir. SABİT bir eşikle
// "gözün yeterince açık değil" demek, doğal olarak dar gözlü kullanıcıları
// sistematik biçimde reddeder. Bu yüzden:
//   - Referans elemesi yalnızca APAÇIK kapalı göz için (CLOSED_EYE_MAX çok
//     düşük tutuldu — kırpma anı/kapalı göz, "kısık göz" değil).
//   - Çıktı kapısı MUTLAK eşik kullanmaz; kişinin KENDİ referansıyla
//     karşılaştırır (bkz. eyesLookClosedVsReference).
// ---------------------------------------------------------------------------

// Bunun ALTI "göz fiilen kapalı / kırpma anı" sayılır. Açık göz tipik olarak
// 0.25-0.35 bandındadır, kapalı göz 0.05-0.12. 0.13 bilinçli olarak DÜŞÜK:
// amaç kısık gözü elemek değil, yalnızca kapalı gözü yakalamak.
const CLOSED_EYE_MAX = 0.13;
// "Rahat açık" kabul edilen bant — yalnızca en iyi referans PUANLAMASINDA
// normalizasyon için kullanılır, eleme eşiği DEĞİLDİR.
const EYE_OPEN_GOOD = 0.28;

function eyeAspectRatio(p1, p2, p3, p4, p5, p6) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = d(p1, p4);
  if (!isFinite(width) || width < 1e-6) return null;
  return (d(p2, p6) + d(p3, p5)) / (2 * width);
}

/**
 * İki gözün ortalama EAR'ını döner (0'a yakın = kapalı). Ölçülemezse null.
 * 68-nokta şemasında sol göz 36-41, sağ göz 42-47 indislerindedir.
 */
function eyeOpennessFromLandmarks(landmarks) {
  try {
    const lm = landmarks && landmarks.positions;
    if (!lm || lm.length < 48) return null;
    const left = eyeAspectRatio(lm[36], lm[37], lm[38], lm[39], lm[40], lm[41]);
    const right = eyeAspectRatio(lm[42], lm[43], lm[44], lm[45], lm[46], lm[47]);
    if (left == null && right == null) return null;
    if (left == null) return right;
    if (right == null) return left;
    return (left + right) / 2;
  } catch (e) {
    return null; // fail-safe: ölçemezsek kontrol devre dışı kalır
  }
}

/**
 * Yüzün ne kadar yandan göründüğünü kabaca ölçer: 0 = tam önden,
 * 1'e yakın = tam profil. Burun ucunun İKİ GÖZ KÖŞESİ arasındaki yatay
 * konumundan hesaplanır — kafa yana döndükçe burun bir kenara kayar.
 * Ölçülemezse null.
 *
 * NEDEN GEREKLİ (2026-08-04): face-api'nin kimlik vektörü çoğunlukla önden
 * yüzlerle eğitilmiştir; kafa yana döndüğünde mesafe KİMLİKTEN BAĞIMSIZ
 * olarak şişer. Gerçek ölçüm (aynı kullanıcı, aynı iş):
 *   profil<=0.45 -> mesafe 0.259, 0.292, 0.307, 0.329  (dar küme)
 *   profil >0.45 -> mesafe 0.373, 0.606, 0.802         (dağınık)
 * 0.802'lik kare GÖZLE GAYET İYİYDİ (telefonuna bakan, profilden bir kare)
 * ama kimlik kapısı onu eledi ve kullanıcı 5 yerine 4 foto aldı. Yani o
 * kapı profil karelerde kimliği değil, POZU ölçüyordu.
 */
function profileDegreeFromLandmarks(landmarks) {
  try {
    const lm = landmarks && landmarks.positions;
    if (!lm || lm.length < 46) return null;
    const leftEyeOuter = lm[36];
    const rightEyeOuter = lm[45];
    const noseTip = lm[30];
    const span = rightEyeOuter.x - leftEyeOuter.x;
    if (!isFinite(span) || Math.abs(span) < 1e-6) return null;
    const rel = (noseTip.x - leftEyeOuter.x) / span; // 0.5 = tam ortada
    return Math.min(1, Math.abs(rel - 0.5) * 2);
  } catch (e) {
    return null; // fail-safe: ölçemezsek eskisi gibi davran
  }
}

/**
 * Referans fotoğrafları analiz eder.
 * Yeni akış: [ön, sağ, sol, tamBoy] — son kare beden referansı (küçük yüz OK).
 * facePhotoCount (varsayılan 3): ilk N kare yüz; kimlik vektörü tercihen
 * bunlardan ortalanır. bestIndex/bestBox yüz karelerinden seçilir.
 */
async function analyzeReferences(buffers, { facePhotoCount = 3 } = {}) {
  const unclearIndices = [];
  const notFullBodyIndices = [];
  // Gözü APAÇIK kapalı (kırpma anı) yüz kareleri — kullanıcıdan değiştirmesi
  // istenir. Gözü kısık olanlar buraya GİRMEZ (bkz. CLOSED_EYE_MAX).
  const closedEyeIndices = [];
  // Yüz karelerinin göz açıklıkları — çıktı kapısının "bu kişinin KENDİ
  // normali" referansı (bkz. eyesLookClosedVsReference).
  const faceEyeOpenness = [];
  // Yüz karelerinin ten tonları (Lab) — ten kapısının artık ÇIKTININ kendi
  // yüzüne değil, kullanıcının GERÇEK selfie tonuna güvenebilmesi için (bkz.
  // assessSkinToneConsistency'nin refSkinTone parametresi).
  const faceTones = [];
  let bestIndex = null;
  let bestArea = -1;
  let bestBox = null;
  const descriptors = [];
  // Sadece YÜZ karelerinin descriptor'ları (index'iyle) — açı dedup için.
  const faceDescriptors = [];

  for (let idx = 0; idx < buffers.length; idx++) {
    const isBodyRef = idx >= facePhotoCount;
    let detection;
    try {
      detection = await detectSingleFace(buffers[idx], {
        minFaceRatio: isBodyRef ? MIN_FACE_RATIO_BODY : MIN_FACE_RATIO,
      });
    } catch {
      unclearIndices.push(idx);
      continue;
    }
    if (!detection.ok) {
      unclearIndices.push(idx);
      continue;
    }
    // Tam boy referansı GERÇEKTEN tam boy mu: yüz kadrajın küçük bir kısmı
    // olmalı. Yüz üst orandan büyükse bu yakın bir selfie'dir, gövde
    // görünmüyordur — ayrı bir hata olarak işaretle (mesajı "net değil"den
    // farklı: kullanıcıya "tam boy ver" demeliyiz).
    if (isBodyRef && detection.ratio > MAX_FACE_RATIO_BODY) {
      notFullBodyIndices.push(idx);
      continue;
    }
    // Yüz var ama fotoğrafın genel kalitesi düşükse (bulanık/aşırı pozlanmış)
    // yine reddedilir — referans, üretimin kalite tavanını belirliyor.
    // Fail-safe: kalite kontrolünün KENDİSİ hata verirse yalnızca yüz
    // tespiti şartı uygulanır (bu ikincil kontrol üretimi bloklamaz).
    try {
      const quality = await assessImageQuality(buffers[idx]);
      if (quality.isBlurry || quality.isOverexposed) {
        unclearIndices.push(idx);
        continue;
      }
    } catch (e) {
      console.error("Görsel kalite kontrolü başarısız (yalnızca yüz tespiti uygulanıyor):", e);
    }
    // Kimlik vektörü + göz açıklığı TEK geçişte çıkarılır (bkz.
    // descriptorFromBuffer). bestIndex puanlaması göz açıklığını kullandığı
    // için bu adım artık puanlamadan ÖNCE yapılıyor.
    let eyeOpenness = null;
    try {
      const r = await descriptorFromBuffer(buffers[idx]);
      // Kimlik ortalamasına yüz karelerini önceliklendir; beden karesi
      // düşük çözünürlüklü yüzle ortalamayı bozmasın.
      if (r && !isBodyRef) {
        eyeOpenness = r.eyeOpenness;
        descriptors.push(r.descriptor);
        faceDescriptors.push({ idx, d: r.descriptor });
      } else if (r && isBodyRef && descriptors.length === 0) {
        descriptors.push(r.descriptor);
      }
    } catch {
      // Descriptor çıkarılamaması bu referansı net-değil saymaz (tespit zaten
      // geçti) — yalnızca ortalamaya katkısı olmaz.
    }

    // TEN TONU: göz durumundan bağımsız, geçen her yüz karesinden toplanır
    // (rawPixels + sampleFaceTone, assessSkinToneConsistency'nin taban/çıktı
    // için kullandığı AYNI yöntem — üç taraf aynı ölçekte kıyaslansın diye).
    // Fail-safe: çıkarılamazsa yalnızca ortalamaya katkısı olmaz.
    if (!isBodyRef) {
      try {
        const px = await rawPixels(buffers[idx]);
        const tone = px ? sampleFaceTone(px, detection.box) : null;
        if (tone) faceTones.push(tone);
      } catch {
        // yut — bu referansı elemez
      }
    }

    // GÖZÜ KAPALI YÜZ KARESİ: yalnızca APAÇIK kapalı olanlar (kırpma anı)
    // işaretlenir — kısık/dar göz DEĞİL (bkz. CLOSED_EYE_MAX'taki adalet
    // notu). Tam boy karesinde göz aranmaz: orada yüz zaten uzak ve küçük,
    // ölçüm güvenilmez.
    if (!isBodyRef && eyeOpenness != null && eyeOpenness < CLOSED_EYE_MAX) {
      closedEyeIndices.push(idx);
      faceEyeOpenness.push(eyeOpenness);
      continue; // bu kare bestIndex yarışına girmesin
    }
    if (!isBodyRef && eyeOpenness != null) faceEyeOpenness.push(eyeOpenness);

    // EN İYİ REFERANS PUANI: eskiden SADECE yüz alanına bakılıyordu. Göz
    // açıklığı ikincil çarpan olarak eklendi — yüz büyüklüğünün YERİNİ
    // ALMIYOR (büyük yüz kimlik sadakati için kritik: yüksek çözünürlüklü
    // kırpma oradan çıkıyor), yalnızca yakın yarışları gözü açık olanın
    // lehine çeviriyor. Çarpan 0.6-1.0 bandında: en kötü ihtimalde %40
    // ceza, yani belirgin daha büyük bir yüz yine kazanır. Ölçülemeyen
    // göz nötr (1.0) sayılır — ölçememek ceza sebebi değildir.
    if (!isBodyRef) {
      const eyeFactor = eyeOpenness == null
        ? 1
        : 0.6 + 0.4 * Math.min(1, eyeOpenness / EYE_OPEN_GOOD);
      const score = detection.area * eyeFactor;
      if (score > bestArea) {
        bestArea = score;
        bestIndex = idx;
        bestBox = detection.box;
      }
    }
  }

  // Açı çeşitliliği: iki yüz karesi neredeyse aynı açıdaysa ikincisini
  // işaretle (kullanıcı onu farklı bir açıyla değiştirsin). Muhafazakâr eşik
  // — bkz. DEDUP_MIN_DISTANCE.
  const duplicateIndices = [];
  for (let a = 0; a < faceDescriptors.length; a++) {
    for (let b = a + 1; b < faceDescriptors.length; b++) {
      const dist = euclideanDistanceLocal(faceDescriptors[a].d, faceDescriptors[b].d);
      if (dist < DEDUP_MIN_DISTANCE && !duplicateIndices.includes(faceDescriptors[b].idx)) {
        duplicateIndices.push(faceDescriptors[b].idx);
      }
    }
  }

  let refDescriptor = null;
  if (descriptors.length > 0) {
    const len = descriptors[0].length;
    const avg = new Float32Array(len);
    for (const d of descriptors) {
      for (let i = 0; i < len; i++) avg[i] += d[i] / descriptors.length;
    }
    refDescriptor = avg;
  }

  // Kişinin KENDİ göz açıklığı normali (medyan — tek bir kısık kare
  // ortalamayı kaydırmasın). Çıktı kapısı mutlak eşik yerine bunu kullanır,
  // böylece doğal dar gözlü kullanıcılar cezalandırılmaz.
  let refEyeOpenness = null;
  if (faceEyeOpenness.length > 0) {
    const sorted = [...faceEyeOpenness].sort((a, b) => a - b);
    refEyeOpenness = sorted[Math.floor(sorted.length / 2)];
  }

  // Kullanıcının GERÇEK ten tonu (kanal başına medyan — medianLab, aynı
  // fonksiyon assessSkinToneConsistency'nin yüz-bandı örneklemesinde de
  // kullanılıyor). Firestore'a düz [L,a,b] dizisi olarak gider.
  const refSkinTone = faceTones.length > 0 ? medianLab(faceTones) : null;

  return {
    unclearIndices,
    notFullBodyIndices,
    duplicateIndices,
    closedEyeIndices,
    refEyeOpenness,
    refSkinTone,
    bestIndex,
    bestBox,
    refDescriptor,
    totalCount: buffers.length,
  };
}

/**
 * Üretilen bir görselin, kaynak kimlik vektörüne (refDescriptor) yeterince
 * benzeyip benzemediğini kontrol eder. Döner: { match: boolean, distance }.
 * Yüz bulunamazsa (nadir — model bazen kadraj dışına taşırabilir) match:false.
 */
async function matchesIdentity(buf, refDescriptor) {
  const faceapi = await ensureModelsLoaded();
  const r = await descriptorFromBuffer(buf);
  if (!r) return { match: false, distance: null };
  const ref = refDescriptor instanceof Float32Array
    ? refDescriptor
    : Float32Array.from(refDescriptor);
  const distance = faceapi.euclideanDistance(ref, r.descriptor);
  return { match: distance < FACE_MATCH_THRESHOLD, distance };
}

// Üretilen çıktı karesinin yüzünün, taban SAHNEDEKİ kadrajın makul bir
// kısmını kaplaması beklenir. Bunun ALTI = yüz ya kadraj dışı ya da
// tespit güvenilmez; ÜSTÜ = oransız büyük kafa (bobble-head artefaktı).
//
// 0.75 -> 0.45 (2026-08-04): 62 gerçek ölçümde aralık 0.076-0.241 çıktı,
// yani 0.75 hiçbir zaman devreye girmedi (ölü eşik). 0.45 hâlâ gözlenen
// tavanın çok üstünde — yalnızca gerçekten grotesk bobble-head'i yakalar,
// meşru yakın plan kadrajlara dokunmaz.
const OUTPUT_FACE_RATIO_MIN = 0.05;
const OUTPUT_FACE_RATIO_MAX = 0.45;

// ŞABLONA GÖRE BÜYÜME SINIRI (2026-08-04). Sabit eşiğin zayıflığı şu:
// çıktının yüz oranı KADRAJA bağlı — uzak sahnede 0.08, yakın planda 0.24
// normaldir, dolayısıyla tek bir sayı ikisini birden yakalayamaz. Kadrajdan
// bağımsız soru şudur: model, ŞABLONDAKİ kafayı büyüttü mü?
// Gerçek eşleştirilmiş veri (şablon oranı -> çıktı oranı, 13 kare):
//   1.03, 1.15, 0.92, 0.80, 0.98, 0.78, 1.22, 0.74, 1.23, 1.03, 0.86, 1.02
// yani gözlenen bant ~0.74-1.23. 1.45 bunun belirgin üstünde: normal
// varyasyona dokunmaz, yalnızca bariz büyütmeyi eler.
// DÜRÜST SINIR: bu kontrol KABA büyümeyi yakalar; "dar omuzda kafa büyük
// duruyor" gibi ince oransızlığı YAKALAMAZ, çünkü yüz kutusu omuz genişliği
// hakkında bilgi taşımaz. O iş Vision'ın HEAD_VS_SHOULDERS sınıfına ait.
const OUTPUT_FACE_GROWTH_MAX = 1.45;

// Bu derecenin üstünde kafa yana dönüktür ve kimlik mesafesi güvenilmez
// sayılır (bkz. profileDegreeFromLandmarks). 0.45, gerçek ölçümde önden
// karelerin oluşturduğu dar kümenin (maks 0.32) üstünde, profil karelerin
// (0.69+) altındadır.
const PROFILE_UNRELIABLE_MIN = 0.45;

// ...ama profil istisnasının da bir TAVANI var. Profil pozu mesafeyi şişirir,
// evet, ama sınırsız değil: bu değerin üstündeki bir mesafe artık "poz
// yüzünden" diye açıklanamaz, kare gerçekten bozuktur.
// GERÇEK OLAY (2026-08-04): mesafe 0.802'lik profil kare, şablonun ANA
// ÖZNESİ tespit edilemediği için ARKA PLANDAKİ bir yolcuya kırpılmıştı;
// model o kişiyi kullanıcıya çevirmeye çalışmıştı. Tavan olmasaydı bu kare
// Vision'a devredilir ve muhtemelen teslim edilirdi.
// Gözlenen profil mesafeleri: 0.373 / 0.606 (ikisi de sağlam, 0.606 zaten
// kullanıcıya teslim edilmişti) ve 0.802 (bozuk). 0.70 ikisini ayırır.
const PROFILE_DEFER_MAX_DISTANCE = 0.70;

// KURTARMA EŞİĞİ (2026-08-03): profil/yan bakış karelerinde SSD skoru normal
// eşiğin altına düşüp yüz "yok" sayılıyordu. Gerçek ölçüm: 2026-08-03
// üretiminde 5 karenin 3'ü "no-face" verdi; bunlardan biri (Madrid terası,
// kişi yana bakıyor, elinde gözlük) 0.35'te hiç bulunamazken 0.20'de
// skor=0.251 ile bulundu ve yüz oranı 0.163 çıktı — yani yüz ORADAYDI.
// Bu bir sorun, çünkü yüz bulunamayınca KAFA ORANI ölçümü de kayboluyor ve
// oransız kafayı yakalayacak tek sayısal kapı devre dışı kalıyor.
//
// Ayrım şu: düşük skorlu tespit KİMLİK karşılaştırması için güvenilmez
// (descriptor gürültülü olur), ama kutunun BOYUTU için yeterlidir. Bu yüzden
// kurtarma tespiti yalnızca faceRatio ölçmek için kullanılır; kimlik kararı
// hâlâ "yüz yok" olarak Vision'a devredilir.
const RESCUE_DETECTION_CONFIDENCE = 0.2;

/**
 * Normal eşikte yüz bulunamadığında SADECE kafa oranını ölçmek için düşük
 * eşikli ikinci deneme. Döner: faceRatio | null. Kimlik için KULLANILMAZ.
 */
async function rescueFaceRatio(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = await bufferToTensorScaled(buf);
  try {
    const [h, w] = tensor.shape;
    const faces = await faceapi.detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({
      minConfidence: RESCUE_DETECTION_CONFIDENCE,
    }));
    if (faces.length === 0) return null;
    let best = faces[0];
    for (const f of faces) {
      if (f.box.width * f.box.height > best.box.width * best.box.height) best = f;
    }
    return Math.max(best.box.width / w, best.box.height / h);
  } catch (e) {
    return null; // fail-safe: kurtarma başarısız olursa eskisi gibi davran
  } finally {
    tensor.dispose();
  }
}

/**
 * Üretilen çıktı karesi için BİRLEŞİK kalite kapısı (best-of-N seçimi ve
 * "bozuk kareyi yeniden üret" için): kimlik + netlik + kafa oranı.
 * Döner: { ok, distance, faceRatio, blurScore, reason }.
 *  - ok:false + reason: hangi kontrolün elediği (log/teşhis için).
 *  - distance: kimlik mesafesi (best-of-N sıralaması için de kullanılır;
 *    yüz yoksa null).
 * NOT: bu, referans SEÇİMİ değil, ÜRETİM ÇIKTISI kalitesi içindir — bu yüzden
 * assessImageQuality'nin bulanıklık eşiği (BLUR_VARIANCE_MIN) burada da
 * yeniden kullanılır (aynı kalibrasyon).
 */
async function assessOutputFace(buf, refDescriptor, templateFaceRatio = null) {
  const faceapi = await ensureModelsLoaded();
  let distance = null;
  let faceRatio = null;
  let blurScore = null;

  const db = await descriptorAndBoxFromBuffer(buf);
  if (!db) {
    // Yüz normal eşikte bulunamadı → kimlik ölçülemez, karar Vision'a gider.
    // Ama KAFA ORANI'nı yine de ölçmeyi dene (bkz. rescueFaceRatio): oransız
    // büyük kafa, kimlikten bağımsız ve tek başına eleme sebebidir.
    const rescued = await rescueFaceRatio(buf);
    if (rescued !== null && rescued > OUTPUT_FACE_RATIO_MAX) {
      return { ok: false, distance: null, faceRatio: rescued, blurScore: null, reason: "head-ratio" };
    }
    return { ok: false, distance: null, faceRatio: rescued, blurScore: null, reason: "no-face" };
  }
  faceRatio = db.faceRatio;

  const ref = refDescriptor instanceof Float32Array
    ? refDescriptor
    : Float32Array.from(refDescriptor);
  distance = faceapi.euclideanDistance(ref, db.descriptor);

  // 1) Kimlik: yüz kullanıcıya benziyor mu?
  if (distance >= FACE_MATCH_THRESHOLD) {
    // PROFİL İSTİSNASI: kafa belirgin şekilde yana dönükse bu mesafe
    // GÜVENİLMEZ (bkz. profileDegreeFromLandmarks'taki ölçüm). Kareyi sert
    // reddetmek yerine, "no-face"te olduğu gibi kararı GÖRÜNTÜYÜ GERÇEKTEN
    // GÖREBİLEN Vision'a devrediyoruz — Vision referans selfie'lerle
    // karşılaştırma yapabildiği için profilde bizden daha yetkin.
    const pd = db.profileDegree;
    if (pd != null && pd > PROFILE_UNRELIABLE_MIN && distance < PROFILE_DEFER_MAX_DISTANCE) {
      return {
        ok: false, distance, faceRatio, blurScore,
        reason: "profile", profileDegree: pd,
      };
    }
    return { ok: false, distance, faceRatio, blurScore, reason: "identity", profileDegree: pd };
  }
  // 2) Kafa oranı: oransız büyük/küçük kafa (bobble-head) artefaktı?
  if (faceRatio < OUTPUT_FACE_RATIO_MIN || faceRatio > OUTPUT_FACE_RATIO_MAX) {
    return { ok: false, distance, faceRatio, blurScore, reason: "head-ratio", profileDegree: db.profileDegree };
  }
  // 2b) Şablona göre büyüme: model kafayı büyüttü mü? Sabit eşikten farkı,
  // kadrajdan bağımsız olması (bkz. OUTPUT_FACE_GROWTH_MAX).
  if (templateFaceRatio && templateFaceRatio > 0) {
    const growth = faceRatio / templateFaceRatio;
    if (growth > OUTPUT_FACE_GROWTH_MAX) {
      return { ok: false, distance, faceRatio, blurScore, reason: "head-grew", growth, profileDegree: db.profileDegree };
    }
  }
  // 3) Netlik: bariz bulanık/eritilmiş yüz? (fail-safe: kontrol hata verirse geç)
  try {
    const q = await assessImageQuality(buf);
    blurScore = q.blurScore;
    if (q.isBlurry) {
      return { ok: false, distance, faceRatio, blurScore, reason: "blurry", profileDegree: db.profileDegree };
    }
  } catch (e) {
    console.error("assessOutputFace netlik kontrolü başarısız (netlik atlanıyor):", e);
  }
  // eyeOpenness yalnızca ÖLÇÜM olarak taşınır — bu fonksiyon onunla kare
  // ELEMEZ. Kararı çağıran taraf verir, çünkü eşik kişinin kendi referans
  // açıklığına göreceli (bkz. eyesLookClosedVsReference).
  return {
    ok: true, distance, faceRatio, blurScore, reason: null,
    profileDegree: db.profileDegree, eyeOpenness: db.eyeOpenness,
  };
}

// ÇIKTI GÖZ KAPISI — MUTLAK EŞİK YOK, KİŞİNİN KENDİ NORMALİNE GÖRECELİ.
//
// Neden göreceli: doğal olarak dar gözlü bir kullanıcı sabit eşikte HER
// karede elenirdi. Referansı kendi selfie'lerinden aldığımız için "dar göz"
// onun normali sayılır; yalnızca çıktı kendi normalinden BELİRGİN daha kapalı
// olduğunda müdahale ederiz — o zaman bu kimlik değil, modelin artefaktıdır.
//
// İKİ ŞART BİRDEN aranır (VE): hem orana hem mutlak tabana takılmalı. Tek
// başına oran, referansı zaten geniş olan birinde çok hassas olurdu; tek
// başına mutlak taban ise dar gözlüleri cezalandırırdı.
const OUTPUT_EYE_MIN_RATIO = 0.62;
const OUTPUT_EYE_ABS_FLOOR = 0.20;

/**
 * Döner: true = çıktı gözleri kişinin kendi referansına göre kapalı sayılır.
 * Ölçülemeyen her durumda false (fail-safe: kapı sessizce devre dışı kalır,
 * asla iyi bir kareyi kanıtsız elemez).
 */
function eyesLookClosedVsReference(outputEyeOpenness, refEyeOpenness) {
  if (outputEyeOpenness == null || refEyeOpenness == null) return false;
  if (!(refEyeOpenness > 0)) return false;
  return outputEyeOpenness < refEyeOpenness * OUTPUT_EYE_MIN_RATIO
    && outputEyeOpenness < OUTPUT_EYE_ABS_FLOOR;
}

/**
 * TABAN ŞABLONUNDAKİ ANA kişinin yüzünü bulur (kadrajdaki EN BÜYÜK yüz —
 * arka planda duran kişiler değil). detectSingleFace'ten farkı: "tam olarak
 * 1 yüz" şartı YOK (şablonlarda arkada insanlar olabilir) ve asgari oran
 * filtresi YOK (amacı zaten KÜÇÜK yüzleri bulmak).
 *
 * Döner: { ratio, box } | null.
 *  - ratio: yüzün kadrajı kaplama oranı (assessOutputFace'teki ile aynı tanım)
 *  - box:   ORİJİNAL görsel koordinatlarında yüz kutusu (kırpma için)
 */
async function detectMainFace(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor, scale } = await bufferToTensorScaled(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    if (faces.length === 0) return null;
    const [h, w] = tensor.shape;
    let best = faces[0];
    for (const f of faces) {
      if (f.box.width * f.box.height > best.box.width * best.box.height) best = f;
    }
    const b = best.box;
    return {
      ratio: Math.max(b.width / w, b.height / h),
      box: {
        x: b.x / scale, y: b.y / scale,
        width: b.width / scale, height: b.height / scale,
      },
    };
  } finally {
    tensor.dispose();
  }
}

// ---------------------------------------------------------------------------
// TEN RENGİ TUTARLILIĞI KAPISI (assessSkinToneConsistency)
//
// SORUN (2026-08-07, gerçek çıktı): elleriyle hindistan cevizi tutan bir karede
// yüz hedef kişinin ten renginde, ELLER ise taban fotoğraftaki kişinin
// (belirgin daha koyu) ten renginde kalmıştı. Ana prompt bunu zaten açıkça
// yasaklıyor ("SKIN COLOUR — WHOLE BODY, NO EXCEPTIONS") ve Vision kapısına da
// bu AYNI kare için "yüz ile eller aynı tonda mı?" diye soruluyordu — Vision
// "consistent skin tone" deyip GEÇİRDİ. Yani tek başına LLM yargısı bu hatayı
// yakalamıyor; ölçülebilir/deterministik bir ikinci kanıt gerekiyor.
//
// NEDEN "BU PİKSEL TEN Mİ?" DİYE SORMUYORUZ: ten rengi aralığı (YCbCr) kum,
// ahşap, hindistan cevizi kabuğu gibi arka plan nesneleriyle fena hâlde
// örtüşür — tam da bu karede. Böyle bir kural tek başına arka planı "bozuk
// ten" sanardı.
//
// BUNUN YERİNE — ÜÇ NOKTALI KARŞILAŞTIRMA: elimizde TABAN fotoğraf da var ve
// hata modu tam olarak "modelin taban kişinin tenini vücutta bırakması". Yani
// asıl soru şu: bu piksel YENİ kişinin yüz tonuna mı, yoksa ESKİ (taban)
// kişinin yüz tonuna mı daha yakın? Arka plan nesneleri ikisine de rastgele
// uzaklıktadır; "eski tona belirgin yakın" olmak ayırt edici bir kanıttır.
//
// AYIRT EDİCİLİK ŞARTI: taban kişi ile hedef kişinin ten tonu zaten birbirine
// yakınsa bu testin hiçbir ayırt etme gücü yoktur (her piksel ikisine de eşit
// uzaklıkta olur) — o durumda ölçüm yapılmaz, kare GEÇER. Yani kapı yalnızca
// kanıtın gerçekten var olabileceği durumda konuşur.
// ---------------------------------------------------------------------------

// Ölçüm bu uzun kenarda yapılır. Ten tonu düşük frekanslı bir sinyal —
// küçültmek hem gürültüyü azaltır hem CPU'yu (kare başına ~10ms) düşürür.
const SKIN_WORK_MAX_DIM = 384;
// Taban ve hedef yüz tonu arasında EN AZ bu kadar Lab farkı olmalı ki test
// ayırt edici sayılsın. Altındaysa ölçüm yapılmaz (bkz. yukarıdaki gerekçe).
const SKIN_MIN_DISCRIMINATION = 10;
// Bir piksel "eski tona ait" sayılmak için eski tona, yeni tondan bu kadar
// DAHA yakın olmalı. Sıfır olsaydı gölge/ışık gürültüsü kararı savurur.
const SKIN_LEFTOVER_MARGIN = 6;
// Yüz DIŞINDAKİ ten benzeri piksellerin bu oranı "eski tona ait" çıkarsa
// kare reddedilir. Muhafazakâr seçildi: yanlış pozitif, İYİ bir karenin
// ücretli olarak yeniden üretilmesi demek (bkz. 2026-07-22 kredi olayı).
const SKIN_MISMATCH_RATIO_MAX = 0.30;
// Bu sayıdan az ten benzeri piksel varsa (ör. sadece yüz görünüyor, vücut
// kadraj dışı/giyinik) kanıt yetersizdir — ölçüm yapılmaz, kare GEÇER.
const SKIN_MIN_SAMPLE_PIXELS = 300;

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * sRGB -> CIELAB (D65). Lab tercih edildi çünkü ten tonu farkı burada
 * ALGISAL mesafeye karşılık gelir; ham RGB mesafesi aynı işi görmez.
 */
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Klasik YCbCr ten-aralığı kuralı. Tek başına ten TESPİTİ için güvenilmez
 * (bkz. yukarıdaki not) — burada yalnızca ÖN ELEME olarak kullanılıyor:
 * gökyüzü/asfalt/yeşillik gibi apaçık ten olmayan pikselleri ucuza atar,
 * asıl kararı üç-noktalı karşılaştırma verir.
 */
function isSkinLike(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

// Ortalama DEĞİL medyan: tek bir parlak yansıma ya da koyu gölge ortalamayı
// kaydırır, medyanı kaydırmaz.
function medianLab(samples) {
  if (samples.length === 0) return null;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const col = samples.map((s) => s[c]).sort((a, b) => a - b);
    out.push(col[Math.floor(col.length / 2)]);
  }
  return out;
}

// L (açıklık) ağırlığı bilinçli olarak 1'den küçük: farklı kişilerin ten
// farkı hem L hem a/b'de görünür, ama GÖLGE neredeyse yalnızca L'yi
// oynatır. L'yi tam ağırlıkla saysaydık gölgede kalan bir el "başka kişi"
// gibi ölçülürdü.
const LAB_L_WEIGHT = 0.6;
function labDistance(p, q) {
  const dl = (p[0] - q[0]) * LAB_L_WEIGHT;
  const da = p[1] - q[1];
  const db = p[2] - q[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Görseli ölçüm boyutuna indirip ham RGB piksellerini döner. */
async function rawPixels(buf) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, SKIN_WORK_MAX_DIM / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  const { data } = await sharp(buf)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width, height, scale };
}

/**
 * Yüz kutusunun YANAK BANDINDAN (yatay orta %60, dikey %45-%80) ten tonunu
 * örnekler. Bu bant bilinçli: gözler, kaşlar, saç çizgisi ve ağız dışarıda
 * kalır — bunlar ten değil ve tonu kaydırırlar.
 */
function sampleFaceTone(px, box) {
  const s = px.scale;
  const x0 = Math.max(0, Math.floor((box.x + box.width * 0.20) * s));
  const x1 = Math.min(px.width, Math.ceil((box.x + box.width * 0.80) * s));
  const y0 = Math.max(0, Math.floor((box.y + box.height * 0.45) * s));
  const y1 = Math.min(px.height, Math.ceil((box.y + box.height * 0.80) * s));
  const samples = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * px.width + x) * 3;
      const r = px.data[o], g = px.data[o + 1], b = px.data[o + 2];
      if (isSkinLike(r, g, b)) samples.push(rgbToLab(r, g, b));
    }
  }
  return medianLab(samples);
}

/**
 * ÇIKTIDAKİ ten renginin vücut genelinde tutarlı olup olmadığını ÖLÇER.
 *
 * outputBuf    : üretilen kare
 * templateBuf  : üretimde kullanılan TABAN fotoğraf (aynı kadraj/kırpma)
 * refSkinTone  : [L,a,b] — kullanıcının GERÇEK selfie tonu (bkz.
 *                analyzeReferences.refSkinTone), OPSİYONEL.
 *
 * REFSKINTONE NEDEN EKLENDİ (2026-08-09 gerçek vaka): eskiden "hedef ton"
 * ÇIKTININ KENDİ yüzünden alınıyordu. Gerçek bir vakada taban kişi (koyu
 * tenli) ile çıktı arasındaki ölçülen fark yalnızca ~9 birim çıktı — gözle
 * BARİZ farklı iki insan olmasına rağmen. Sebep: model çıktının YÜZÜNÜ de
 * (ellerden az olsa da) tabanın tonuna doğru hafifçe çekmiş olabilir — yani
 * "doğru ton" için kullanılan referansın kendisi hafif kirliydi. Kullanıcının
 * selfie'lerinden bağımsız bir ton çıkarıp ONU referans almak bu kör noktayı
 * kapatıyor; ayrıca artık YÜZ DE teste dahil edilebiliyor (aşağıya bkz.).
 *
 * refSkinTone verilMEZse (eski çağıranlarla geriye dönük uyum, ya da
 * kullanıcının hiçbir selfie'sinden ton çıkarılamadıysa): ESKİ davranışa
 * döner — hedef ton çıktının kendi yüzünden alınır, yüz bölgesi taramadan
 * hariç tutulur (kendisiyle karşılaştırmak anlamsız olurdu).
 *
 * Döner: { ok, reason, ratio, sampled, faceDelta }
 *   ok:false + reason:"skin" → vücutta (refSkinTone varsa yüz DAHİL) taban
 *     kişinin teni kalmış.
 *   ok:true  + reason:"indistinguishable" | "insufficient-sample" | null
 *     → ölçüm yapılamadı ya da sorun yok (ikisi de KABUL — fail-safe).
 *
 * FAIL-SAFE: her hata durumunda ok:true. Bu kapı ASLA teknik bir aksaklık
 * yüzünden iyi bir kareyi elemez (dosyadaki diğer ikincil katmanlarla aynı
 * felsefe).
 */
async function assessSkinToneConsistency(outputBuf, templateBuf, refSkinTone = null) {
  try {
    if (!outputBuf || !templateBuf) return { ok: true, reason: "insufficient-sample" };

    const [outFace, tplFace] = await Promise.all([
      detectMainFace(outputBuf),
      detectMainFace(templateBuf),
    ]);
    if (!outFace || !tplFace) return { ok: true, reason: "insufficient-sample" };

    const [outPx, tplPx] = await Promise.all([rawPixels(outputBuf), rawPixels(templateBuf)]);
    if (!outPx || !tplPx) return { ok: true, reason: "insufficient-sample" };

    const baseTone = sampleFaceTone(tplPx, tplFace.box); // eski (taban) kişi — HER ZAMAN taban çıktıdan
    const usingRealRef = Array.isArray(refSkinTone) && refSkinTone.length === 3;
    // Hedef ton: TERCİHEN kullanıcının gerçek selfie tonu; yoksa eski
    // davranışa düş (çıktının kendi yüzü).
    const targetTone = usingRealRef ? refSkinTone : sampleFaceTone(outPx, outFace.box);
    if (!targetTone || !baseTone) return { ok: true, reason: "insufficient-sample" };

    // Ayırt edicilik şartı — bkz. başlıktaki gerekçe.
    const faceDelta = labDistance(targetTone, baseTone);
    if (faceDelta < SKIN_MIN_DISCRIMINATION) {
      return { ok: true, reason: "indistinguishable", faceDelta };
    }

    // Yüz bölgesi yalnızca hedef ton ÇIKTIDAN alındığında taramadan hariç
    // tutulur (kendisiyle karşılaştırmak anlamsız olurdu). Gerçek selfie
    // referansı varken yüz de dahil edilir — "çıktının yüzü de mi hafif
    // kirli" sorusu artık cevaplanabiliyor.
    const s = outPx.scale;
    const fx0 = (outFace.box.x) * s, fx1 = (outFace.box.x + outFace.box.width) * s;
    const fy0 = (outFace.box.y) * s, fy1 = (outFace.box.y + outFace.box.height) * s;

    let sampled = 0;
    let leftover = 0;
    for (let y = 0; y < outPx.height; y++) {
      for (let x = 0; x < outPx.width; x++) {
        if (!usingRealRef && x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue; // yüz bölgesi
        const o = (y * outPx.width + x) * 3;
        const r = outPx.data[o], g = outPx.data[o + 1], b = outPx.data[o + 2];
        if (!isSkinLike(r, g, b)) continue;
        sampled++;
        const lab = rgbToLab(r, g, b);
        const dTarget = labDistance(lab, targetTone);
        const dBase = labDistance(lab, baseTone);
        if (dBase + SKIN_LEFTOVER_MARGIN < dTarget) leftover++;
      }
    }

    if (sampled < SKIN_MIN_SAMPLE_PIXELS) {
      return { ok: true, reason: "insufficient-sample", sampled, faceDelta };
    }
    const ratio = leftover / sampled;
    if (ratio > SKIN_MISMATCH_RATIO_MAX) {
      return { ok: false, reason: "skin", ratio, sampled, faceDelta };
    }
    return { ok: true, reason: null, ratio, sampled, faceDelta };
  } catch (e) {
    console.error("Ten rengi kontrolü hata verdi (fail-safe kabul):", e.message || e);
    return { ok: true, reason: "insufficient-sample" };
  }
}

// ---------------------------------------------------------------------------
// UZUV KROMA DÜZELTİCİSİ (correctLimbChroma)
//
// NEDEN: assessSkinToneConsistency bozuk kareyi YAKALAR ama düzeltemez — kare
// atılır ve (retry hakkı varsa) yeniden üretilir, yani para yanar. Oysa hatanın
// kendisi deterministik olarak çözülebilir: model doğru yüzü üretmiş, sadece
// uzuvların RENGİ eski kişiden kalmış. Renk kaydırmak üretmekten hem bedava
// hem risksiz (kimliğe dokunmaz).
//
// SADECE a*/b* KAYDIRILIR, L* ASLA: L* sahnenin ışığını taşır. Gerçek bir
// fotoğrafta yüz parlak ışıkta, eller gölgede olabilir — bu DOĞRU ve
// korunmalı. L*'yi de eşitlersek el "yapıştırılmış" görünür. Bozuk olan ışık
// değil, ton.
//
// HEDEF TON, SELFIE DEĞİL ÇIKTININ KENDİ YÜZÜDÜR: refSkinTone selfie'nin
// NÖTR ışığında ölçüldü; sahne ışığı altında ona zorlamak yüzü sahneyle
// çatıştırır. Fotoğrafın kendi içinde tutarlı olması için doğru referans,
// aynı ışığı almış olan çıktının kendi yüzüdür. refSkinTone yalnızca "bu
// piksel eski kişiden mi kalmış?" ayrımında kullanılır.
//
// NEDEN BAĞLANTILI BİLEŞEN, NEDEN DOĞRUDAN "leftover" DEĞİL: leftover kümesi
// düzeltmek istediğimiz hatanın KENDİSİYLE tanımlı. Ton hatası ön kolda
// kademeliyse (genelde öyledir) yalnızca "yanlış" pikselleri kaydırmak kolun
// ortasından geçen bir DİKİŞ bırakır. Bu yüzden leftover yalnızca kaydırma
// MİKTARINI ve hangi bileşenin bozuk olduğunu belirler; kaydırma o bileşenin
// TAMAMINA tek tip uygulanır.
//
// ALAN TAVANI (fail-safe): isSkinLike'ın bilinen yanlış pozitifleri var (kum,
// ahşap, bej kumaş — bkz. isSkinLike başlığı). Bej bir takım elbise, taban
// kişi açık tenliyken "leftover" koşulunu sağlayabilir. Düzeltilecek alan
// karenin belli bir oranını aşarsa kıyafet/arka plan yakalanmış demektir ve
// HİÇBİR ŞEY yapılmaz — takımı lekelemektense düzeltmeyi atlamak yeğdir.
// ---------------------------------------------------------------------------

// Tam eşleme bilinçli olarak YAPILMAZ: gerçek insanlarda el ve ön kol güneş
// yüzünden yüzden bir tık daha koyu/kırmızıdır. Tam eşitlemek yapay okunur.
const CHROMA_FIX_STRENGTH = 0.9;
// Bir bileşenin "bozuk" sayılması için içindeki leftover piksel oranı.
const CHROMA_FIX_COMPONENT_LEFTOVER_MIN = 0.35;
// Bundan küçük bileşenler (çalışma çözünürlüğünde piksel) gürültüdür.
const CHROMA_FIX_MIN_COMPONENT_PX = 120;
// Düzeltilen alan karenin bu oranını aşarsa düzeltme HİÇ uygulanmaz.
const CHROMA_FIX_MAX_AREA_RATIO = 0.25;
// Bu kadarlık bir kaydırma gözle görünmez; boşuna JPEG'i yeniden kodlama.
const CHROMA_FIX_MIN_SHIFT = 1.5;
// Delikleri kapatıp bileşeni bütünleştiren morfolojik yarıçap.
const CHROMA_FIX_CLOSE_RADIUS = 2;

/** CIELAB -> sRGB (rgbToLab'in tersi, D65). */
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  const G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  const B = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  const enc = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [enc(R), enc(G), enc(B)];
}

// Yalnızca renklilik farkı (a*/b*). L* bilinçli olarak DIŞARIDA: ışık farkını
// "hata" saymak istemiyoruz (bkz. başlıktaki gerekçe).
function chromaDistance(p, q) {
  const da = p[1] - q[1], db = p[2] - q[2];
  return Math.sqrt(da * da + db * db);
}

function medianOf(values) {
  if (values.length === 0) return null;
  const a = Float64Array.from(values).sort();
  return a[Math.floor(a.length / 2)];
}

// Ayrılabilir kutu dilate/erode — r küçük olduğu için bu yeterince hızlı.
function boxMorph(src, W, H, r, dilate) {
  const hit = dilate ? 1 : 0;
  const tmp = new Uint8Array(W * H), dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= W) continue;
        if (src[y * W + xx] === hit) { v = hit; break; }
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= H) continue;
        if (tmp[yy * W + x] === hit) { v = hit; break; }
      }
      dst[y * W + x] = v;
    }
  }
  return dst;
}

/**
 * Uzuvlardaki (yüz HARİÇ) ten renginin çıktının kendi yüz tonuna uymadığı
 * bölgeleri deterministik olarak düzeltir.
 *
 * outputBuf   : üretilen kare
 * templateBuf : üretimde kullanılan taban fotoğraf (eski kişinin tonu için)
 * refSkinTone : [L,a,b] kullanıcının gerçek selfie tonu
 *
 * Döner: { applied, reason, buf, deltaBefore, deltaAfter, areaRatio, shift }
 *   applied:false -> buf null, çağıran orijinali kullanmaya devam eder.
 *
 * FAIL-SAFE: her hata/kararsızlık durumunda applied:false. Bu düzeltici ASLA
 * teknik bir aksaklık yüzünden kareyi bozmaz (dosyadaki diğer katmanlarla
 * aynı felsefe).
 */
async function correctLimbChroma(outputBuf, templateBuf, refSkinTone) {
  const skip = (reason, extra = {}) => ({ applied: false, reason, buf: null, ...extra });
  try {
    if (!outputBuf || !templateBuf) return skip("insufficient-input");
    if (!Array.isArray(refSkinTone) || refSkinTone.length !== 3) return skip("no-ref-tone");

    const [outFace, tplFace] = await Promise.all([
      detectMainFace(outputBuf), detectMainFace(templateBuf),
    ]);
    if (!outFace || !tplFace) return skip("no-face");

    const [outPx, tplPx] = await Promise.all([rawPixels(outputBuf), rawPixels(templateBuf)]);
    if (!outPx || !tplPx) return skip("insufficient-input");

    const baseTone = sampleFaceTone(tplPx, tplFace.box);  // eski (taban) kişi
    const faceTone = sampleFaceTone(outPx, outFace.box);  // HEDEF: çıktının kendi yüzü
    if (!baseTone || !faceTone) return skip("insufficient-sample");

    // Taban ile kullanıcı tonu zaten aynıysa "eski ton kalmış" kavramı
    // ölçülemez (bkz. SKIN_MIN_DISCRIMINATION gerekçesi).
    if (labDistance(refSkinTone, baseTone) < SKIN_MIN_DISCRIMINATION) {
      return skip("indistinguishable");
    }

    const W = outPx.width, H = outPx.height, N = W * H;
    const s = outPx.scale;
    // Yüz kutusu DÜZELTİLMEZ — o, hedef tonun kaynağı.
    const fx0 = outFace.box.x * s, fx1 = (outFace.box.x + outFace.box.width) * s;
    const fy0 = outFace.box.y * s, fy1 = (outFace.box.y + outFace.box.height) * s;

    const skin = new Uint8Array(N), leftover = new Uint8Array(N);
    const labA = new Float32Array(N), labB = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue;
        const i = y * W + x, o = i * 3;
        const r = outPx.data[o], g = outPx.data[o + 1], b = outPx.data[o + 2];
        if (!isSkinLike(r, g, b)) continue;
        skin[i] = 1;
        const lab = rgbToLab(r, g, b);
        labA[i] = lab[1]; labB[i] = lab[2];
        if (labDistance(lab, baseTone) + SKIN_LEFTOVER_MARGIN < labDistance(lab, refSkinTone)) {
          leftover[i] = 1;
        }
      }
    }

    // Düzeltme ÖNCESİ ölçüm: tüm uzuv teni ile yüz arasındaki renklilik farkı.
    const allA = [], allB = [];
    for (let i = 0; i < N; i++) if (skin[i]) { allA.push(labA[i]); allB.push(labB[i]); }
    if (allA.length < SKIN_MIN_SAMPLE_PIXELS) return skip("insufficient-sample");
    const limbTone = [0, medianOf(allA), medianOf(allB)];
    const deltaBefore = chromaDistance(faceTone, limbTone);

    // Delikleri kapat: bileşen bütün bir uzuv olsun, delik deşik olmasın.
    const closed = boxMorph(
      boxMorph(skin, W, H, CHROMA_FIX_CLOSE_RADIUS, true),
      W, H, CHROMA_FIX_CLOSE_RADIUS, false,
    );

    // Bağlantılı bileşenler (8-komşuluk, yığınla BFS — özyineleme yok).
    const label = new Int32Array(N).fill(-1);
    const selected = new Uint8Array(N);
    let selectedCount = 0;
    const stack = [];
    for (let start = 0; start < N; start++) {
      if (!closed[start] || label[start] !== -1) continue;
      label[start] = start;
      stack.length = 0; stack.push(start);
      const members = [];
      let leftoverCount = 0;
      while (stack.length) {
        const i = stack.pop();
        members.push(i);
        if (leftover[i]) leftoverCount++;
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
            const j = yy * W + xx;
            if (closed[j] && label[j] === -1) { label[j] = start; stack.push(j); }
          }
        }
      }
      if (members.length < CHROMA_FIX_MIN_COMPONENT_PX) continue;
      if (leftoverCount / members.length < CHROMA_FIX_COMPONENT_LEFTOVER_MIN) continue;
      // Bu bileşen bozuk: TAMAMI kaydırılır (dikiş olmasın).
      for (const i of members) { selected[i] = 1; selectedCount++; }
    }

    if (selectedCount === 0) {
      return skip("nothing-to-fix", { deltaBefore, areaRatio: 0 });
    }
    const areaRatio = selectedCount / N;
    if (areaRatio > CHROMA_FIX_MAX_AREA_RATIO) {
      // Muhtemelen kıyafet/arka plan yakalandı — hiçbir şey yapma.
      return skip("area-too-large", { deltaBefore, areaRatio });
    }

    // Kaydırma miktarı LEFTOVER piksellerden gelir (bozukluğun kendisinden),
    // ama uygulaması yukarıda bileşenin tamamına yayıldı.
    const lefA = [], lefB = [];
    for (let i = 0; i < N; i++) if (selected[i] && leftover[i]) { lefA.push(labA[i]); lefB.push(labB[i]); }
    if (lefA.length < SKIN_MIN_SAMPLE_PIXELS) {
      return skip("insufficient-sample", { deltaBefore, areaRatio });
    }
    const shiftA = (faceTone[1] - medianOf(lefA)) * CHROMA_FIX_STRENGTH;
    const shiftB = (faceTone[2] - medianOf(lefB)) * CHROMA_FIX_STRENGTH;
    if (Math.sqrt(shiftA * shiftA + shiftB * shiftB) < CHROMA_FIX_MIN_SHIFT) {
      return skip("shift-negligible", { deltaBefore, areaRatio });
    }

    // Düzeltme SONRASI beklenen ölçüm (aynı piksel kümesi üzerinde).
    const afterA = [], afterB = [];
    for (let i = 0; i < N; i++) {
      if (!skin[i]) continue;
      afterA.push(labA[i] + (selected[i] ? shiftA : 0));
      afterB.push(labB[i] + (selected[i] ? shiftB : 0));
    }
    const deltaAfter = chromaDistance(faceTone, [0, medianOf(afterA), medianOf(afterB)]);

    // Maskeyi tam çözünürlüğe taşı ve kenarları yumuşat (bant oluşmasın).
    const meta = await sharp(outputBuf).metadata();
    if (!meta.width || !meta.height) return skip("insufficient-input", { deltaBefore, areaRatio });
    const maskWork = Buffer.alloc(N);
    for (let i = 0; i < N; i++) maskWork[i] = selected[i] ? 255 : 0;
    const feather = Math.max(1, Math.round(Math.max(meta.width, meta.height) / 260));
    const maskFull = await sharp(maskWork, { raw: { width: W, height: H, channels: 1 } })
      .resize(meta.width, meta.height, { fit: "fill" })
      .blur(feather)
      .raw().toBuffer();

    const { data, info } = await sharp(outputBuf).removeAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < info.width * info.height; i++) {
      const alpha = maskFull[i] / 255;
      if (alpha <= 0.004) continue;
      const o = i * 3;
      const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
      // L* KORUNUR — yalnızca renklilik kayar (bkz. başlık).
      const [r, g, b] = labToRgb(lab[0], lab[1] + shiftA * alpha, lab[2] + shiftB * alpha);
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
    }
    const buf = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 3 },
    }).jpeg({ quality: 95 }).toBuffer();

    return {
      applied: true, reason: null, buf,
      deltaBefore, deltaAfter, areaRatio,
      shift: Math.sqrt(shiftA * shiftA + shiftB * shiftB),
    };
  } catch (e) {
    console.error("Uzuv kroma düzeltmesi hata verdi (fail-safe atlandı):", e.message || e);
    return skip("error");
  }
}

// ---------------------------------------------------------------------------
// KAFA YERLEŞİMİ ÖLÇÜMÜ (measureHeadPlacement) — ÖLÇER, ELEMEZ
//
// NEDEN: kullanıcının bildirdiği asıl sorun "kafayı tam olması gereken yere
// yerleştirememesi — bazen çok önde bazen çok arkada". Mevcut kapılar kafanın
// BOYUTUNU (faceRatio, büyüme) ve AÇISINI (profileDegree) ölçüyor ama
// KONUMUNU hiç ölçmüyor. Bu fonksiyon o boşluğu kapatır.
//
// HİÇBİR KAREYİ ELEMEZ. Sebep: "önde/arkada" en az üç ayrı nedenden olabilir
// ve düzeltmeleri birbirinden tamamen farklıdır:
//   1) Karede öteleme          -> dx/dy    -> geometrik hizalama çözer
//   2) Baş açısı (pitch)       -> pitch    -> hizalama ÇÖZMEZ, prompt işi
//   3) Ölçek                   -> scale    -> mevcut büyüme kapısıyla çakışır
// Hangisi olduğu bilinmeden düzeltme yazmak yanlış problemi çözme riskidir.
//
// TUZAK (ölçümü okurken): dy ile pitch birbirini TAKLİT EDER — kafa aşağı
// eğilince yüz kutusunun merkezi de aşağı kayar, yani pitch değişimi dy'de
// sahte bir sinyal üretir. dx bundan etkilenmez ve en temiz göstergedir
// (yalnızca yaw'dan etkilenir, o da ayrıca ölçülüyor).
//
// BİRİM: dx/dy piksel değil, ŞABLONUN YÜZ GENİŞLİĞİ cinsindendir ("kafa
// genişliği"). Farklı boyutlu görseller arasında karşılaştırılabilir olsun
// diye; piksel cinsinden loglamak dağılımı okunamaz yapardı.
// ---------------------------------------------------------------------------

/**
 * Kafanın yukarı/aşağı eğimi için vekil ölçü: burun ucunun, göz hattı ile çene
 * ucu arasındaki göreli dikey konumu. Nötrde ~0.5; kafa aşağı eğilince alt yüz
 * kısalır ve oran büyür, yukarı kalkınca küçülür. profileDegree yaw'ı ölçüyor,
 * bu onun pitch karşılığı. Ölçülemezse null (fail-safe).
 */
function pitchRatioFromLandmarks(landmarks) {
  try {
    const lm = landmarks && landmarks.positions;
    if (!lm || lm.length < 68) return null;
    const eyeY = (lm[36].y + lm[45].y) / 2; // dış göz köşeleri
    const span = lm[8].y - eyeY;            // göz hattı -> çene ucu
    if (!isFinite(span) || Math.abs(span) < 1e-6) return null;
    return (lm[30].y - eyeY) / span;        // burun ucunun göreli yeri
  } catch (e) {
    return null;
  }
}

/** Yüz kutusunu NORMALİZE koordinatlarda (0-1) + açı vekilleriyle döner. */
async function detectPlacement(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = await bufferToTensorScaled(buf);
  try {
    const [h, w] = tensor.shape;
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: MIN_DETECTION_CONFIDENCE,
      }))
      .withFaceLandmarks();
    if (!result) return null;
    const b = result.detection.box;
    return {
      cx: (b.x + b.width / 2) / w,
      cy: (b.y + b.height / 2) / h,
      wNorm: b.width / w,
      pitch: pitchRatioFromLandmarks(result.landmarks),
      yaw: profileDegreeFromLandmarks(result.landmarks),
    };
  } finally {
    tensor.dispose();
  }
}

/**
 * Yalnızca yaw (kafanın yana dönüklüğü) ölçer: 0 = tam önden, 1 = tam profil.
 * Ölçülemezse null (fail-safe — çağıran kapı sessizce devre dışı kalır).
 */
async function headYawOf(buf) {
  try {
    if (!buf) return null;
    const p = await detectPlacement(buf);
    return p ? p.yaw : null;
  } catch (e) {
    console.error("Yaw ölçümü hata verdi (atlanıyor):", e.message || e);
    return null;
  }
}

/**
 * Çıktıdaki kafanın, ŞABLONDAKİ kafaya göre nereye oturduğunu ölçer.
 *
 * ÖNEMLİ: iki görsel AYNI koordinat uzayında olmalı — kırpılmış çıktıyı
 * kırpılmamış şablonla karşılaştırmak, kırpmanın geometri dönüşümünü "kayma"
 * sanmaya yol açar. Çağıran taraf doğru eşi seçmekle yükümlü (bkz. çağrı yeri).
 *
 * Döner: { ok, reason, dx, dy, scale, pitch, tplPitch, yaw, tplYaw }
 *   dx>0: çıktının kafası şablona göre SAĞDA. dy>0: AŞAĞIDA.
 */
async function measureHeadPlacement(outputBuf, templateBuf) {
  try {
    if (!outputBuf || !templateBuf) return { ok: false, reason: "insufficient-input" };
    const [o, t] = await Promise.all([
      detectPlacement(outputBuf), detectPlacement(templateBuf),
    ]);
    if (!o || !t) {
      return { ok: false, reason: !o && !t ? "no-face-both" : (!o ? "no-face-output" : "no-face-template") };
    }
    const unit = t.wNorm; // 1 birim = şablonun yüz genişliği
    if (!(unit > 1e-6)) return { ok: false, reason: "degenerate" };
    return {
      ok: true, reason: null,
      dx: (o.cx - t.cx) / unit,
      dy: (o.cy - t.cy) / unit,
      scale: o.wNorm / t.wNorm,
      pitch: o.pitch, tplPitch: t.pitch,
      yaw: o.yaw, tplYaw: t.yaw,
    };
  } catch (e) {
    console.error("Kafa yerleşimi ölçümü hata verdi (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

module.exports = {
  analyzeReferences,
  assessSkinToneConsistency,
  correctLimbChroma,
  measureHeadPlacement,
  headYawOf,
  eyesLookClosedVsReference,
  CLOSED_EYE_MAX,
  matchesIdentity,
  assessOutputFace,
  detectMainFace,
  FACE_MATCH_THRESHOLD,
};
