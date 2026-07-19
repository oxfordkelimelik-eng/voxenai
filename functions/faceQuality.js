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

const path = require("path");

// Yüzün kadrajda kaplaması gereken asgari oran (kenar). Bunun altındaki
// yüzler "net değil/uzak" sayılır. Aşırı katı olmasın diye gevşek tutuldu.
const MIN_FACE_RATIO = 0.12;
// ssd_mobilenetv1 tespit güveni eşiği.
const MIN_DETECTION_CONFIDENCE = 0.5;

// Kimlik eşleşme eşiği (öklid mesafesi, düşük = daha benzer). face-api.js'in
// standart eşiği ~0.6. Biraz gevşetildi çünkü stil/ışık değişince aynı kişi
// 0.55-0.65 aralığına düşebiliyor; aşırı katı olursa çoğu üretim gereksiz
// yere elenip retry bütçesini tüketir. YÜZ HÂLÂ ÇOK BOZUK geliyorsa bu
// değeri DÜŞÜR (ör. 0.55) — daha az toleranslı olur.
const FACE_MATCH_THRESHOLD = 0.6;

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

function bufferToTensor(buf) {
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
  return tf.tidy(() => {
    const full = tf.tensor3d(rgb, [height, width, 3]);
    const longEdge = Math.max(width, height);
    if (longEdge <= MAX_FACE_DIM) return full;
    const scale = MAX_FACE_DIM / longEdge;
    return tf.image
      .resizeBilinear(full, [Math.round(height * scale), Math.round(width * scale)])
      .toInt();
  });
}

/**
 * Bir JPEG buffer'ında yüz TESPİTİ yapar (tanıma yok). Döner:
 *   { ok: true, area } → kadrajda yeterince büyük TAM OLARAK bir yüz var.
 *   { ok: false }      → yüz yok, çok küçük, ya da birden fazla yüz.
 */
async function detectSingleFace(buf) {
  const faceapi = await ensureModelsLoaded();
  const tensor = bufferToTensor(buf);
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
    return { ok: true, area: (b.width * b.height) / (w * h) };
  } finally {
    tensor.dispose();
  }
}

/**
 * Bir JPEG buffer'ından yüz descriptor'ı (128 boyutlu kimlik vektörü)
 * çıkarır. Yüz bulunamazsa null döner.
 */
async function descriptorFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const tensor = bufferToTensor(buf);
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
 *   unclearIndices:  net/tek yüz kontrolünü geçemeyen fotoğrafların
 *                     0-tabanlı indeksleri (kullanıcının seçim sırasıyla).
 *   bestIndex:        geçerli fotoğraflar arasında en büyük yüze sahip
 *                     olanın indeksi (üretime gönderilecek referans sırasında
 *                     başa alınır).
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
  const descriptors = [];

  for (let idx = 0; idx < buffers.length; idx++) {
    try {
      const r = await detectSingleFace(buffers[idx]);
      if (r.ok) {
        if (r.area > bestArea) {
          bestArea = r.area;
          bestIndex = idx;
        }
      } else {
        unclearIndices.push(idx);
        continue;
      }
    } catch {
      unclearIndices.push(idx);
      continue;
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

  return { unclearIndices, bestIndex, refDescriptor, totalCount: buffers.length };
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
