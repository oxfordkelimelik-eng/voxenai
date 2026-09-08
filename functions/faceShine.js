/**
 * Yüz speküler parlamasını üretim sonrası alır.
 *
 * Model, ışıklı selfie'deki flaş/anahtar ışığı parlamasını çıktı yüzüne
 * kopyalar. Kollar sahne ışığında kalır, yüz ayrı " parlaktır". Ham L*
 * eşiği (yüz vs kol) bunu ayıramadı; bu katman YALNIZCA yüzdeki küçük,
 * doygunluğu düşük parlak lekeleri (speküler) medyan ten L*'sine çeker.
 *
 * Tüm yüzü karartmaz: speküler alan yüz teninin %18'ini aşarsa bu genel
 * güneş/sahne ışığıdır, dokunulmaz.
 */

const sharp = require("sharp");

const SELFIE_SHINE_MIN = 0.04;
// 0.05 -> 0.03 (2026-09-07 kullanıcı bildirimi: "ışık altında çekilmişse yüz
// çok parlak çıkıyor"). Job aaf8b1ea'da çıktı parlaması 0.046 / 0.044 / 0.036
// ölçüldü ve ÜÇÜ DE "no-shine" ile atlandı — eski eşiğin hemen altındalardı.
// Selfie'de parlama SELFIE_SHINE_MIN'i (0.04) tutturamadığında selfieLit=false
// kalıyor, o zaman da gevşek eşik (OUTPUT_SHINE_MIN_IF_SELFIE) devreye
// girmiyordu: iki eşik birbirini kilitliyordu. SHINE_AREA_MAX (%18) tavanı
// genel sahne güneşini hâlâ koruyor, yani bu düşüş tüm yüzü karartmaz.
const OUTPUT_SHINE_MIN = 0.03;
const OUTPUT_SHINE_MIN_IF_SELFIE = 0.015;
const SHINE_AREA_MAX = 0.18;
// 10 -> 7 (2026-09-09 kullanıcı bildirimi, job d13df6ce): elegance_6'da
// parlama oranı 0.002 ölçülüp "no-shine" ile ATLANDI, ama kare gözle parlaktı.
// Sebep: bu eşik yalnızca SERT/nokta parlamaları (medyan ten L*'sinin 10 birim
// üstü) sayıyordu; yumuşak-yaygın flaş aydınlanması (yüzün geneli birkaç birim
// parlak) hiç yakalanmıyordu. 7'ye indirmek o bandı da kapsıyor.
// SHINE_AREA_MAX (%18) tavanı hâlâ genel sahne güneşini koruyor: parlak alan
// yüzün beşte birini aşarsa bu "ışık" değil "sahne" sayılıp dokunulmuyor.
const SPECULAR_L_ABOVE = 7;
const SPECULAR_CHROMA_MAX = 22;
// 0.72 -> 0.88 (aynı bildirim): job d13df6ce'de elegance_4/7/9'da düzeltme
// UYGULANDI (oran 0.042 / 0.064 / 0.126) ama kullanıcı kareleri hâlâ "çok
// parlak" buldu — yani kapı doğru tetikleniyordu, düzeltmenin gücü yetersizdi.
// 0.88 speküler pikseli medyan ten tonuna neredeyse tam çeker; tamamen 1.0
// yapmıyoruz ki cilt dokusu düzleşip "plastik" görünüm oluşmasın.
const REDUCE_STRENGTH = 0.88;
const MIN_SKIN_PX = 80;

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

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

function isSkinLike(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/** Flaş lekesi ten aralığının dışına (neredeyse beyaz) taşar. */
function isNearWhite(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b > 220;
}

function medianOf(values) {
  if (!values.length) return null;
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function chromaOf(lab) {
  return Math.hypot(lab[1], lab[2]);
}

/** Alın + yanak; göz ve ağız bandı dışarıda (diş/göz akı speküler sanılmasın). */
function inShineBand(x, y, box, scale) {
  const fx = box.x * scale, fy = box.y * scale;
  const fw = box.width * scale, fh = box.height * scale;
  const rx = (x - fx) / fw;
  const ry = (y - fy) / fh;
  if (rx < 0.12 || rx > 0.88 || ry < 0.10 || ry > 0.74) return false;
  if (ry >= 0.28 && ry < 0.46) return false;
  return true;
}

function isSpecularLab(lab, medianL) {
  if (lab[0] < medianL + SPECULAR_L_ABOVE) return false;
  return chromaOf(lab) <= SPECULAR_CHROMA_MAX;
}

/**
 * Çalışma piksellerinde speküler oranı.
 * px: { data, width, height, scale }  box: orijinal koordinat yüz kutusu
 */
function specularStatsFromPixels(px, box) {
  if (!px || !box) return null;
  const Ls = [];
  const skinIdx = [];
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (!inShineBand(x, y, box, px.scale)) continue;
      const o = (y * px.width + x) * 3;
      const r = px.data[o], g = px.data[o + 1], b = px.data[o + 2];
      const lab = rgbToLab(r, g, b);
      if (isSkinLike(r, g, b)) {
        skinIdx.push({ o, lab, forceSpec: false });
        Ls.push(lab[0]);
      } else if (isNearWhite(r, g, b)) {
        skinIdx.push({ o, lab, forceSpec: true });
      }
    }
  }
  if (Ls.length < MIN_SKIN_PX) return null;
  const medianL = medianOf(Ls);
  let spec = 0;
  for (const s of skinIdx) {
    if (s.forceSpec || isSpecularLab(s.lab, medianL)) spec++;
  }
  return {
    shineRatio: spec / skinIdx.length,
    medianL,
    skinCount: skinIdx.length,
    specCount: spec,
  };
}

/**
 * Speküler piksellerin L*'sini medyana çeker. data yerinde değişir.
 * Döner: değişen piksel sayısı.
 */
function applySpecularReduction(data, width, height, box, scale, medianL) {
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inShineBand(x, y, box, scale)) continue;
      const o = (y * width + x) * 3;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const lab = rgbToLab(r, g, b);
      const spec = isNearWhite(r, g, b) || (isSkinLike(r, g, b) && isSpecularLab(lab, medianL));
      if (!spec) continue;
      const newL = lab[0] + (medianL - lab[0]) * REDUCE_STRENGTH;
      const rgb = labToRgb(newL, lab[1], lab[2]);
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      changed++;
    }
  }
  return changed;
}

function shouldReduceShine(outStats, selfieLit) {
  if (!outStats) return false;
  if (outStats.shineRatio > SHINE_AREA_MAX) return false;
  const min = selfieLit ? OUTPUT_SHINE_MIN_IF_SELFIE : OUTPUT_SHINE_MIN;
  return outStats.shineRatio >= min;
}

/**
 * Çıktı yüzündeki speküler parlamayı alır.
 * selfieLit: hazırlıkta selfie yüzünde parlama ölçüldüyse true.
 */
async function reduceFaceSpecular(outputBuf, { selfieLit = false } = {}) {
  const skip = (reason, extra = {}) => ({ applied: false, reason, buf: null, ...extra });
  try {
    if (!outputBuf) return skip("insufficient-input");
    const { detectMainFace } = require("./faceQuality");
    const face = await detectMainFace(outputBuf);
    if (!face || !face.box) return skip("no-face");

    const meta = await sharp(outputBuf).metadata();
    if (!meta.width || !meta.height) return skip("insufficient-input");
    const { data, info } = await sharp(outputBuf)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = { data, width: info.width, height: info.height, scale: 1 };
    const stats = specularStatsFromPixels(px, face.box);
    if (!shouldReduceShine(stats, selfieLit)) {
      return skip(stats ? (stats.shineRatio > SHINE_AREA_MAX ? "area-too-large" : "no-shine") : "insufficient-sample", {
        shineRatio: stats ? stats.shineRatio : null,
      });
    }
    const changed = applySpecularReduction(
      data, info.width, info.height, face.box, 1, stats.medianL
    );
    if (changed < 8) return skip("shift-negligible", { shineRatio: stats.shineRatio });
    const buf = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 3 },
    }).jpeg({ quality: 95 }).toBuffer();
    return {
      applied: true,
      reason: null,
      buf,
      shineRatio: stats.shineRatio,
      changed,
    };
  } catch (e) {
    console.error("Yüz parlama düzeltmesi hata verdi (fail-safe atlandı):", e.message || e);
    return skip("error");
  }
}

module.exports = {
  specularStatsFromPixels,
  applySpecularReduction,
  shouldReduceShine,
  reduceFaceSpecular,
  isSpecularLab,
  inShineBand,
  SELFIE_SHINE_MIN,
  OUTPUT_SHINE_MIN,
  OUTPUT_SHINE_MIN_IF_SELFIE,
  SHINE_AREA_MAX,
};
