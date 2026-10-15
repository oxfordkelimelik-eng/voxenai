// YÜZ POZLAMASI, IŞIK RENGİ VE SİYAH-BEYAZ ŞABLON — yüzün sahneye göre
// parlaklığı ve rengi şablondan. Işığın YÖNÜ ve yapısı (gölgeler, parlamalar)
// faceShading.js'te; 2026-10-15'e kadar buradaki transferFaceLight yüze tek bir
// düz eğim taşıyordu (benzerlik ölçüsünde neredeyse etkisizdi, cbdbef13 c11
// yanağında yama bıraktı) ve kaldırıldı.

const sharp = require("sharp");

// YÜZ POZLAMASI (2026-10-14, cbdbef13 c8/c29/c10/c2: loş sahnede yüz flaşlı
// gibi parlak). Düzlem aktarımı ortalamayı korur, yüzün sahneye göre
// parlaklığını düzeltmez. Şablon kişisinin teni farklı olduğu için yüz
// parlaklığı doğrudan kıyaslanamaz; kişinin KENDİ vücut derisi (boyun, el,
// kol) kıyaslanır: şablonda yüz/vücut oranı neyse çıktıda da o olmalı.
// Ölçülen fark: c8 1.38, c29 1.30, c10 1.23, c2 1.19, c3 0.86; diğerleri ±0.05.
// Yerel testte (aynı şablon, başka kullanıcı) ham c8 1.54-1.56 → alt sınır 0.62.
const EXPOSURE_SEG = 512;
// Sınıf olasılığı bu eşiğin üstündeki pikseller ölçüme girer.
const EXPOSURE_CLASS_P = 0.6;
// İki sınıftan da en az bu kadar piksel (EXPOSURE_SEG² ızgarada).
const EXPOSURE_MIN_PX = 1500;
const EXPOSURE_MIN_DIFF = 0.06;
const EXPOSURE_GAIN_MIN = 0.62;
const EXPOSURE_GAIN_MAX = 1.12;

/** Yüz/vücut derisi oranından parlaklık kazancı kararı. SAF. */
function exposurePlan(tpl, out) {
  const ok = (s) => s && s.nFace >= EXPOSURE_MIN_PX && s.nBody >= EXPOSURE_MIN_PX && s.body > 1;
  if (!ok(tpl) || !ok(out)) return { apply: false, reason: "no-body-skin" };
  const ratio = (out.face / out.body) / (tpl.face / tpl.body);
  if (Math.abs(ratio - 1) < EXPOSURE_MIN_DIFF) return { apply: false, reason: "within-tolerance", ratio, gain: 1 };
  return { apply: true, reason: null, ratio, gain: Math.min(EXPOSURE_GAIN_MAX, Math.max(EXPOSURE_GAIN_MIN, 1 / ratio)) };
}

// IŞIĞIN RENGİ (2026-10-15, kullanıcı: "yüzün rengi sahnenin ışığına
// uymuyor"): model yüz rengini selfie'lerden alıyor — base yüzlerin Lab renk
// açısı sahneye göre 35-57°, ham çıktılar hep 45-53° (selfie'ler 48-62°).
// Ten rengi açısı kişiden kişiye az değişir, ışığın rengiyle kayar; açı
// base'e doğru döndürülür, kroma ve açıklık kullanıcınınki kalır (base
// mankenin teni taşınmaz). Kanal başına RGB kazancı denendi ve çıkarıldı:
// "sıcak" ışıkta kırmızıyı artırıp yüzü pembeleştirdi (c8 46° → 41°) ve
// doygunluğu artırdı (c0 kroma 23.6 → 31.0).
const HUE_SHARE = 0.6;
const HUE_MAX_SHIFT = 10;
const HUE_MIN_DIFF = 3;
// Kroma bunun altındaysa (gri/siyah-beyaz, çok soluk) açı güvenilmez.
const HUE_MIN_CHROMA = 8;

const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Yüz derisi ortalama Lab'inden renk açısı kayması kararı (derece). SAF. */
function huePlan(tplLab, outLab) {
  if (!tplLab || !outLab) return { apply: false, reason: "no-face-skin", shift: 0 };
  const cT = Math.hypot(tplLab[1], tplLab[2]), cO = Math.hypot(outLab[1], outLab[2]);
  if (cT < HUE_MIN_CHROMA || cO < HUE_MIN_CHROMA) return { apply: false, reason: "low-chroma", shift: 0 };
  const hT = (Math.atan2(tplLab[2], tplLab[1]) * 180) / Math.PI;
  const hO = (Math.atan2(outLab[2], outLab[1]) * 180) / Math.PI;
  const diff = wrapDeg(hT - hO);
  if (Math.abs(diff) < HUE_MIN_DIFF) return { apply: false, reason: "within-tolerance", shift: 0, diff };
  const shift = Math.max(-HUE_MAX_SHIFT, Math.min(HUE_MAX_SHIFT, diff * HUE_SHARE));
  return { apply: true, reason: null, shift, diff };
}

async function skinLuminance(rgb, W, H) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const S = EXPOSURE_SEG;
  const raw = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(S, S, { fit: "fill" }).raw().toBuffer();
  const P = await classProbs(raw, S, S);
  const { rgbToLab } = require("./skinTone");
  let fs = 0, nFace = 0, bs = 0, nBody = 0;
  const fLab = [0, 0, 0];
  for (let i = 0; i < S * S; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    if (P[CLASSES.faceSkin][i] > EXPOSURE_CLASS_P) {
      fs += L; nFace++;
      const lab = rgbToLab(r, g, b);
      for (let c = 0; c < 3; c++) fLab[c] += lab[c];
    } else if (P[CLASSES.bodySkin][i] > EXPOSURE_CLASS_P) {
      bs += L; nBody++;
    }
  }
  return {
    face: nFace ? fs / nFace : 0, body: nBody ? bs / nBody : 0, nFace, nBody,
    faceLab: nFace >= EXPOSURE_MIN_PX ? fLab.map((v) => v / nFace) : null,
    P, CLASSES,
  };
}

/**
 * Çıktı yüzünün (yüz derisi + saç, gözler dahil) parlaklığını şablonun
 * yüz/vücut oranına, renk açısını şablon yüzünün açısına doğru getirir.
 * Döner: { buf|null, applied, reason, ratio, gain, hueShift, hueDiff }.
 */
async function matchFaceExposure(outputBuf, templateBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const [so, st] = await Promise.all([skinLuminance(o.data, W, H), skinLuminance(t, W, H)]);
  const plan = exposurePlan(st, so);
  const hue = huePlan(st.faceLab, so.faceLab);
  const tplOk = st.nFace >= EXPOSURE_MIN_PX && st.nBody >= EXPOSURE_MIN_PX && st.face > 1;
  const info = {
    ratio: plan.ratio, gain: plan.apply ? plan.gain : 1, hueShift: hue.shift, hueDiff: hue.diff ?? null,
    hueReason: hue.reason,
    tpl: st.body ? st.face / st.body : null, out: so.body ? so.face / so.body : null,
    bodyLightRatio: tplOk ? st.body / st.face : null,
  };
  if (!plan.apply && !hue.apply) return { buf: null, applied: false, reason: plan.reason, ...info };
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  if (!lo) return { buf: null, applied: false, reason: "no-face-output", ...info };

  // Maske: yüz derisi + saç olasılığı, yüz çevresindeki elipsle sınırlı. Boyun
  // (vücut derisi) dışarıda — ölçünün referansı o.
  const S = EXPOSURE_SEG;
  const m8 = Buffer.alloc(S * S);
  for (let i = 0; i < S * S; i++) {
    const p = so.P[so.CLASSES.faceSkin][i] + so.P[so.CLASSES.hair][i];
    m8[i] = Math.max(0, Math.min(255, Math.round(p * 255)));
  }
  const fb = lo.box;
  const mask = await sharp(m8, { raw: { width: S, height: S, channels: 1 } })
    .resize(W, H, { fit: "fill" }).blur(Math.max(0.5, fb.width * 0.03)).extractChannel(0).raw().toBuffer();
  const cx = fb.x + fb.width / 2, cy = fb.y + fb.height * 0.4;
  const rx = fb.width * 1.3, ry = fb.height * 1.5;
  const { rgbToLab, labToRgb } = require("./skinTone");
  const out = Buffer.from(o.data);
  const x0 = Math.max(0, Math.floor(cx - rx * 1.3)), x1 = Math.min(W, Math.ceil(cx + rx * 1.3));
  const y0 = Math.max(0, Math.floor(cy - ry * 1.3)), y1 = Math.min(H, Math.ceil(cy + ry * 1.3));
  const rad = (hue.shift * Math.PI) / 180;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const ellipse = e <= 1 ? 1 : e >= 1.6 ? 0 : 1 - (e - 1) / 0.6;
      const a = ellipse * mask[i] / 255;
      if (a <= 0.01) continue;
      const r0 = o.data[i * 3], g0 = o.data[i * 3 + 1], b0 = o.data[i * 3 + 2];
      const lab = rgbToLab(r0, g0, b0);
      // Kazanç yalnız açıklığa: RGB çarpımı kromayı da düşürüp loş sahnede
      // yüzü grileştirdi (c29 kroma 26.4 → 20.3).
      const k = 1 + a * (info.gain - 1);
      const L = k === 1 ? lab[0] : rgbToLab(Math.min(255, r0 * k), Math.min(255, g0 * k), Math.min(255, b0 * k))[0];
      const cs = Math.cos(rad * a), sn = Math.sin(rad * a);
      const rgb = labToRgb(L, lab[1] * cs - lab[2] * sn, lab[1] * sn + lab[2] * cs);
      out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, ...info };
}

module.exports = { exposurePlan, huePlan, matchFaceExposure };

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

module.exports.matchGrayscale = matchGrayscale;
module.exports.meanSaturation = meanSaturation;
