// Referans selfie kalite kapısı: YALNIZCA yüz TESPİTİ yapar (kimlik vektörü
// / descriptor YOK). İki iş görür:
//   1) Net/tek yüz kontrolü — bulanık, yüzsüz veya çok kişili selfie'leri
//      üretim başlamadan, para harcanmadan eler.
//   2) 5 selfie arasından en iyi (en büyük/en net) yüzü seçer — üretim modeli
//      (flux-pulid) tek referans görsel aldığı için "primary" referans budur.
//
// TASARIM: descriptor tabanlı kimlik karşılaştırması KALDIRILDI. Üretim artık
// kimlik-koşullu bir modelle (flux-pulid, id_weight) yapılıyor; kimlik sadakati
// modelin içinde sağlanıyor, bu yüzden çıktı görsellerini ayrıca embed edip
// filtrelemeye gerek yok. Böylece hem ağır face_recognition modeli (6.4MB)
// yüklenmiyor (daha hızlı), hem de çıktıdan foto elenmediği için vaat edilen
// sayı (stil başına 10) korunuyor.
//
// @tensorflow/tfjs-node (native) yerine bilerek saf WASM backend — native
// derleme Windows'ta ve Cloud Functions'ta kırılgandı; WASM platform bağımsız.

const path = require("path");

// Yüzün kadrajda kaplaması gereken asgari oran (kenar). Bunun altındaki
// yüzler "net değil/uzak" sayılır. Aşırı katı olmasın diye gevşek tutuldu.
const MIN_FACE_RATIO = 0.12;
// ssd_mobilenetv1 tespit güveni eşiği.
const MIN_DETECTION_CONFIDENCE = 0.5;

let _initPromise = null;
let _faceapi = null;

async function ensureDetectorLoaded() {
  if (_faceapi) return _faceapi;
  if (!_initPromise) {
    _initPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      await tf.setBackend("wasm");
      await tf.ready();
      // Yalnızca tespit modeli — landmark/recognition YÜKLENMEZ (hız).
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(path.join(__dirname, "models"));
      _faceapi = faceapi;
      return faceapi;
    })();
  }
  return _initPromise;
}

// Yüz tespiti için maksimum kenar uzunluğu. Modern telefon fotoları tam
// çözünürlükte tensöre çevrilince OOM oluyordu; ~800px tespit için fazlasıyla
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
 * Bir JPEG buffer'ında yüz TESPİTİ yapar. Döner:
 *   { ok: true, area } → kadrajda yeterince büyük TAM OLARAK bir yüz var.
 *   { ok: false }      → yüz yok, çok küçük, ya da birden fazla yüz.
 * area, en iyi referansı seçmek için kullanılan (0..1) göreli yüz alanıdır.
 */
async function detectSingleFace(buf) {
  const faceapi = await ensureDetectorLoaded();
  const tensor = bufferToTensor(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    const [h, w] = tensor.shape;
    // Yeterince büyük yüzleri say (küçük/arka plan yüzlerini görmezden gel).
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
 * 5 referans selfie'yi analiz eder. Döner:
 *   unclearIndices: net/tek yüz kontrolünü geçemeyen fotoğrafların 0-tabanlı
 *                   indeksleri (kullanıcının seçim sırasıyla aynı).
 *   bestIndex:      geçerli fotoğraflar arasında en büyük yüze sahip olanın
 *                   indeksi (üretim modeline verilecek "primary" referans).
 *                   Hiç geçerli yok ya da tespit başarısızsa null.
 */
async function analyzeReferences(buffers) {
  const unclearIndices = [];
  let bestIndex = null;
  let bestArea = -1;
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
      }
    } catch {
      // Tespit hatası = net-değil say (güvenli taraf).
      unclearIndices.push(idx);
    }
  }
  return { unclearIndices, bestIndex, totalCount: buffers.length };
}

module.exports = { analyzeReferences };
