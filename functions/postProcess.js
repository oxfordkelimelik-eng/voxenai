// Üretilen görsele hafif "gerçek telefon kamerası" dokusu ekler: film
// grain benzeri gürültü + gerçekçi JPEG sıkıştırma. AI üretim modelleri
// genelde çok temiz/yüksek kaliteli JPEG'ler döner (kalite ~95+, gürültüsüz)
// — bu, "yapay zeka ürettiği belli oluyor" hissinin bir parçası. Gerçek
// telefon fotoğrafları hem hafif sensör gürültüsü hem de daha düşük/tutarsız
// JPEG kalitesi taşır.
//
// FAIL-SAFE: bu adım tamamen kozmetik/ikincil. Hata olursa orijinal buffer
// olduğu gibi kaydedilir — kullanıcı asla bu adım yüzünden boş sonuç görmez.

const sharp = require("sharp");

// Gerçek telefon kamerası JPEG'lerine yakın kalite. AI çıktıları genelde
// bunun üzerinde (~95+) geliyor — düşürmek "temiz" hissi kırar.
const JPEG_QUALITY = 86;
// Grain katmanının opaklığı (0-255). Çok düşük tutulmalı — amaç fark
// edilmeyen bir doku, göze batan bir efekt değil.
const GRAIN_ALPHA = 22;
// Gürültü genliği (gri ton ±). Yüksek olursa "bozuk görüntü" gibi durur.
const GRAIN_AMPLITUDE = 14;

/**
 * Rastgele luminance gürültüsünden düşük-opaklıklı bir RGBA PNG üretir.
 * sharp'ın composite() ile "overlay" harmanlamasında kullanılır.
 */
async function buildGrainLayer(width, height) {
  const buf = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = 128 + Math.round((Math.random() - 0.5) * 2 * GRAIN_AMPLITUDE);
    const gray = Math.max(0, Math.min(255, v));
    const off = p * 4;
    buf[off] = gray;
    buf[off + 1] = gray;
    buf[off + 2] = gray;
    buf[off + 3] = GRAIN_ALPHA;
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Görsele hafif grain + gerçekçi JPEG sıkıştırma uygular. Herhangi bir
 * adımda hata olursa ORİJİNAL buffer'ı döner (üretimi asla bloklamaz).
 */
async function addPhoneCameraTexture(buf) {
  try {
    const image = sharp(buf);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return buf;

    const grain = await buildGrainLayer(meta.width, meta.height);
    return await image
      .composite([{ input: grain, blend: "overlay" }])
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.error("Post-processing başarısız (orijinal görsel kullanılıyor):", e);
    return buf;
  }
}

module.exports = { addPhoneCameraTexture };
