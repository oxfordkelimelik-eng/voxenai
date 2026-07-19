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
// yüzler "net değil/uzak" sayılır. Aşırı katı olmasın diye gevşek tutuldu.
const MIN_FACE_RATIO = 0.12;
// ssd_mobilenetv1 tespit güveni eşiği.
const MIN_DETECTION_CONFIDENCE = 0.5;

// Laplacian varyansı bu değerin ALTINDAYSA bulanık say. Gerçek kullanıcı
// fotoğraflarıyla KALİBRE EDİLMEDİ — bilinçli olarak gevşek (az false-positive,
// yalnızca belirgin bulanıklığı yakalar). Şikayet devam ederse yükselt.
const BLUR_VARIANCE_MIN = 60;
// Görselin bu ORANDAN FAZLASI (0-1) neredeyse beyazsa (>250/255) aşırı
// pozlanmış say. Meşru parlak/backlit selfie'leri elememek için gevşek.
const OVEREXPOSURE_CLIP_MAX = 0.45;

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
// KALİBRASYON NOTU: bu değer gerçek kullanıcı verisiyle kalibre edilmedi,
// tahmini bir ayardır. Üretimde hâlâ yüz bozukluğu şikayeti gelirse DÜŞÜR
// (ör. 0.58) — daha az toleranslı olur. Retry'lerin çoğu boşa gidiyorsa
// (yüz aslında doğru ama sürekli eleniyorsa) daha da YÜKSELT (ör. 0.66).
const FACE_MATCH_THRESHOLD = 0.63;

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
 * JPEG buffer'ı tensöre çevirir VE uygulanan küçültme ölçeğini döner
 * (scale=1 → küçültülmedi). Çağıran taraf, tensör-uzayındaki bir kutuyu
 * (ör. yüz bounding box) ORİJİNAL görsel piksel koordinatına
 * `box / scale` ile geri çevirebilir — bkz. detectSingleFace.
 */
function bufferToTensorScaled(buf) {
  const tf = require("@tensorflow/tfjs");
  const jpeg = require("jpeg-js");
  const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width, height, data } = decoded;
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
async function detectSingleFace(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor, scale } = bufferToTensorScaled(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    const [h, w] = tensor.shape;
    const big = faces.filter((f) => {
      const ratio = Math.max(f.box.width / w, f.box.height / h);
      return ratio >= MIN_FACE_RATIO;
    });
    if (big.length !== 1) return { ok: false };
    const b = big[0].box;
    const box = {
      x: b.x / scale, y: b.y / scale,
      width: b.width / scale, height: b.height / scale,
    };
    return { ok: true, area: (b.width * b.height) / (w * h), box };
  } finally {
    tensor.dispose();
  }
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
  const { tensor } = bufferToTensorScaled(buf);
  try {
    const result = await faceapi
      .detectSingleFace(tensor)
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? result.descriptor : null;
  } finally {
    tensor.dispose();
  }
}

/**
 * 3 referans selfie'yi analiz eder. Döner:
 *   unclearIndices:  net/tek yüz kontrolünü VEYA bulanıklık/aşırı pozlama
 *                     kontrolünü geçemeyen fotoğrafların 0-tabanlı indeksleri
 *                     (kullanıcının seçim sırasıyla).
 *   bestIndex:        geçerli fotoğraflar arasında en büyük yüze sahip
 *                     olanın indeksi (üretime gönderilecek referans sırasında
 *                     başa alınır).
 *   bestBox:          bestIndex'teki fotoğrafta yüzün ORİJİNAL piksel
 *                     koordinatlarındaki kutusu — yüz-merkezli ek bir kırpılmış
 *                     referans üretmek için kullanılır (bkz. postProcess.
 *                     cropFaceRegion, falPhotos.prepareReferencePhotos).
 *   refDescriptor:    geçerli referans fotoğraflardan çıkarılan descriptor'ların
 *                     ORTALAMASI (Float32Array) — üretilen her görselin kimlik
 *                     karşılaştırmasında kullanılır. Hiçbir geçerli fotoğraftan
 *                     descriptor çıkarılamazsa null (kimlik kapısı devre dışı
 *                     kalır, fail-safe).
 */
async function analyzeReferences(buffers) {
  const unclearIndices = [];
  let bestIndex = null;
  let bestArea = -1;
  let bestBox = null;
  const descriptors = [];

  for (let idx = 0; idx < buffers.length; idx++) {
    let detection;
    try {
      detection = await detectSingleFace(buffers[idx]);
    } catch {
      unclearIndices.push(idx);
      continue;
    }
    if (!detection.ok) {
      unclearIndices.push(idx);
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
    if (detection.area > bestArea) {
      bestArea = detection.area;
      bestIndex = idx;
      bestBox = detection.box;
    }
    try {
      const d = await descriptorFromBuffer(buffers[idx]);
      if (d) descriptors.push(d);
    } catch {
      // Descriptor çıkarılamaması bu referansı net-değil saymaz (tespit zaten
      // geçti) — yalnızca ortalamaya katkısı olmaz.
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

  return { unclearIndices, bestIndex, bestBox, refDescriptor, totalCount: buffers.length };
}

/**
 * Üretilen bir görselin, kaynak kimlik vektörüne (refDescriptor) yeterince
 * benzeyip benzemediğini kontrol eder. Döner: { match: boolean, distance }.
 * Yüz bulunamazsa (nadir — model bazen kadraj dışına taşırabilir) match:false.
 */
async function matchesIdentity(buf, refDescriptor) {
  const faceapi = await ensureModelsLoaded();
  const d = await descriptorFromBuffer(buf);
  if (!d) return { match: false, distance: null };
  const ref = refDescriptor instanceof Float32Array
    ? refDescriptor
    : Float32Array.from(refDescriptor);
  const distance = faceapi.euclideanDistance(ref, d);
  return { match: distance < FACE_MATCH_THRESHOLD, distance };
}

module.exports = { analyzeReferences, matchesIdentity, FACE_MATCH_THRESHOLD };
