// SİYAH-BEYAZ ŞABLON — son geçiş. Yüzün ışığı ve teni faceRelight.js'te
// (2026-10-16); buradaki pozlama/renk açısı (matchFaceExposure, 2026-10-14)
// ve düz eğim (transferFaceLight, 2026-10-15'e kadar) onun yerine kaldırıldı.

const sharp = require("sharp");

// SİYAH-BEYAZ ŞABLON (2026-10-08, 9d9507f0 c4): şablon renksizken model yüzü
// renkli çizdi — gri bir sahnede pembe bir yüz. Şablonun ortalama renk
// doygunluğu bu eşiğin altındaysa çıktı da gri tonlamaya çekilir.
const GRAY_SAT_MAX = 4;
// YÜZ RENKLİYSE SİYAH-BEYAZ DEĞİL (2026-11-03, 80fc7ec4 c9 ve 7e04933e c2):
// gri duvar önünde renkli yüz — tüm kare 2.9/2.3 ama yüz 45.9/56.7; kare
// griye çevrildi, taşınan gözlük çevresinde renkli base derisi turuncu leke
// kaldı. Gerçek siyah-beyaz fotoğrafta yüz de 0-3.
const GRAY_FACE_SAT_MAX = 10;

/** Şablon yüzünün iç bölgesinde ortalama doygunluk; yüz yoksa null. */
async function faceSaturation(buf) {
  const { detectMainFace } = require("./faceQuality");
  const img = await sharp(buf).rotate().removeAlpha().png().toBuffer();
  const fc = (await detectMainFace(img)) || (await detectMainFace(img, 0.1));
  if (!fc || !fc.box) return null;
  const m = await sharp(img).metadata();
  const b = fc.box;
  const left = Math.max(0, Math.round(b.x + b.width * 0.2)), top = Math.max(0, Math.round(b.y + b.height * 0.15));
  const width = Math.min(m.width - left, Math.round(b.width * 0.6)), height = Math.min(m.height - top, Math.round(b.height * 0.6));
  if (width < 8 || height < 8) return null;
  return meanSaturation(await sharp(img).extract({ left, top, width, height }).png().toBuffer());
}

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
  let satF = null;
  try { satF = await faceSaturation(templateBuf); } catch (_) { satF = null; }
  if (satF != null && satF >= GRAY_FACE_SAT_MAX) return { buf: null, applied: false, reason: "color-face", satT, satF };
  // Çıktının ortalamasına bakılmaz (2026-10-09, f9f3b5c0 c4): gri sahnede
  // küçük renkli bir yüz ortalamayı 0.5'te bırakıp "zaten gri" sayıldı.
  const satO = await meanSaturation(outputBuf);
  if (satO < 0.05) return { buf: null, applied: false, reason: "already-gray", satT, satO };
  const buf = await sharp(outputBuf).greyscale().toColourspace("srgb").png().toBuffer();
  return { buf, applied: true, reason: null, satT, satO, satF };
}

module.exports = { matchGrayscale, meanSaturation, faceSaturation, _testables: { GRAY_FACE_SAT_MAX } };
