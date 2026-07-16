// Yüz-benzerliği kalite kapısı: üretilen çıktıları kaynak selfie'lerle
// karşılaştırıp düşük benzerlikli olanları eler.
//
// TASARIM: bu modüldeki HER ŞEY, çağıran taraf (falPhotos.js) için
// try/catch ile sarılı, isteğe bağlı bir zenginleştirmedir. Model yükleme,
// yüz tespiti veya karşılaştırma herhangi bir noktada başarısız olursa,
// çağıran taraf filtresiz (tüm görselleri gösteren) davranışa geri döner.
// Bu, ödeme akışını taşıyan webhook'un bu kalite katmanındaki bir hataya
// karşı asla kırılmamasını garanti eder.
//
// @tensorflow/tfjs-node (native binding) yerine bilerek saf WASM backend
// kullanılıyor — native derleme Windows geliştirme makinesinde başarısız
// oldu ve Cloud Functions'ta da kırılgan olurdu. WASM platform bağımsızdır.

const path = require("path");

// Standart face-api.js eşiği ~0.6. Biraz gevşetildi — stil/ışık değişince
// aynı kişi 0.55–0.65 aralığına düşebiliyor; aşırı eleme üretimi bozuyordu.
const FACE_MATCH_THRESHOLD = 0.68;

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
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
      _faceapi = faceapi;
      return faceapi;
    })();
  }
  return _initPromise;
}

// Yüz tespiti için gereken maksimum kenar uzunluğu. Modern telefon fotoları
// (ör. 4000x3000) tam çözünürlükte tensöre çevrilince bellek patlıyordu (OOM,
// 1GiB limiti aşıyordu). ~800px yüz tespiti/tanıma için fazlasıyla yeterli ve
// tensör boyutunu ~25x küçültür.
const MAX_FACE_DIM = 800;

function bufferToTensor(faceapi, buf) {
  const tf = require("@tensorflow/tfjs");
  const jpeg = require("jpeg-js");
  // maxMemoryUsageInMB: jpeg-js'in çok büyük görsellerde patlamasını sınırla.
  const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width, height, data } = decoded;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  // Tensörleri tidy içinde oluştur/küçült ki ara tensörler hemen serbest kalsın.
  return tf.tidy(() => {
    const full = tf.tensor3d(rgb, [height, width, 3]);
    const longEdge = Math.max(width, height);
    if (longEdge <= MAX_FACE_DIM) return full;
    // Oranı koruyarak küçült — büyük tensör tidy sonunda dispose edilir.
    const scale = MAX_FACE_DIM / longEdge;
    const newH = Math.round(height * scale);
    const newW = Math.round(width * scale);
    return tf.image.resizeBilinear(full, [newH, newW]).toInt();
  });
}

/**
 * Bir JPEG buffer'ından yüz descriptor'ı (128 boyutlu kimlik vektörü)
 * çıkarır. Yüz bulunamazsa null döner.
 */
async function descriptorFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const tensor = bufferToTensor(faceapi, buf);
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
 * Birden fazla referans selfie buffer'ından ortalama (kanonik) kimlik
 * vektörünü hesaplar. Hiçbirinde yüz bulunamazsa null döner.
 */
async function averageDescriptor(buffers) {
  const faceapi = await ensureModelsLoaded();
  const descriptors = [];
  for (const buf of buffers) {
    try {
      const d = await descriptorFromBuffer(buf);
      if (d) descriptors.push(d);
    } catch {
      // Tek bir referans fotoğrafın işlenememesi tüm işlemi düşürmesin.
    }
  }
  if (descriptors.length === 0) return null;
  const len = descriptors[0].length;
  const avg = new Float32Array(len);
  for (const d of descriptors) {
    for (let i = 0; i < len; i++) avg[i] += d[i] / descriptors.length;
  }
  return avg;
}

/**
 * [{ buf, ... }] listesini kaynak kimlik vektörüyle karşılaştırıp YALNIZCA
 * eşiği geçenleri döner (geçen yoksa boş dizi). Fallback/yeniden-üretim
 * kararı çağırana bırakılır (bkz. falInferenceWebhook) — böylece gerçek
 * geçen sayısı bilinir ve gerekirse stil yeniden üretilebilir.
 *
 * referenceDescriptor düz bir sayı dizisi de olabilir (Firestore'dan okunmuş);
 * gerekirse Float32Array'e çevrilir.
 */
async function filterByFaceMatch(items, referenceDescriptor, getBuf) {
  const faceapi = await ensureModelsLoaded();
  const ref = referenceDescriptor instanceof Float32Array
    ? referenceDescriptor
    : Float32Array.from(referenceDescriptor);
  const scored = await Promise.all(items.map(async (item) => {
    try {
      const d = await descriptorFromBuffer(getBuf(item));
      if (!d) return { item, distance: null };
      return { item, distance: faceapi.euclideanDistance(ref, d) };
    } catch {
      return { item, distance: null };
    }
  }));
  return scored
    .filter((s) => s.distance !== null && s.distance < FACE_MATCH_THRESHOLD)
    .map((s) => s.item);
}

module.exports = { averageDescriptor, filterByFaceMatch, FACE_MATCH_THRESHOLD };
