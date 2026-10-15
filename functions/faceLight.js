// SİYAH-BEYAZ ŞABLON — son geçiş. Yüzün ışığı ve teni faceRelight.js'te
// (2026-10-16); buradaki pozlama/renk açısı (matchFaceExposure, 2026-10-14)
// ve düz eğim (transferFaceLight, 2026-10-15'e kadar) onun yerine kaldırıldı.

const sharp = require("sharp");

// SİYAH-BEYAZ ŞABLON (2026-10-08, 9d9507f0 c4): şablon renksizken model yüzü
// renkli çizdi — gri bir sahnede pembe bir yüz. Şablonun ortalama renk
// doygunluğu bu eşiğin altındaysa çıktı da gri tonlamaya çekilir.
const GRAY_SAT_MAX = 4;

/** Ortalama doygunluk (max−min kanal), 0-255. */
async function meanSaturation(buf) {
  const { data } = await sharp(buf).removeAlpha().resize(256, 256, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  let s = 0;
  for (let i = 0; i < data.length; i += 3) s += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
  return s / (data.length / 3);
}

async function matchGrayscale(outputBuf, templateBuf) {
  const satT = await meanSaturation(templateBuf);
  if (satT >= GRAY_SAT_MAX) return { buf: null, applied: false, reason: "color-template", satT };
  // Çıktının ortalamasına bakılmaz (2026-10-09, f9f3b5c0 c4): gri sahnede
  // küçük renkli bir yüz ortalamayı 0.5'te bırakıp "zaten gri" sayıldı.
  const satO = await meanSaturation(outputBuf);
  if (satO < 0.05) return { buf: null, applied: false, reason: "already-gray", satT, satO };
  const buf = await sharp(outputBuf).greyscale().toColourspace("srgb").png().toBuffer();
  return { buf, applied: true, reason: null, satT, satO };
}

module.exports = { matchGrayscale, meanSaturation };
