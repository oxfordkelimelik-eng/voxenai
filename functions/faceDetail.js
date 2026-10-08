// YÜZ DETAYI EŞİTLEME (2026-10-08, kullanıcı: "kıyafet kaliteli gözükürken
// yüz kalitesiz gözükebiliyor").
//
// ÖLÇÜLDÜ (bb2cc441, 10 kare): yüzün ince detayı (σ=1.2 yüksek geçiren
// enerjisi) kıyafetinkine oranla şablondakinden 6 karede %22-43 DÜŞÜK.
// Model yüzü kıyafetten daha yumuşak çiziyor; kıyafet şablondan neredeyse
// aynen geldiği için keskin kalıyor.
//
// ÇÖZÜM: hedef, şablonun kendi yüz/kıyafet detay oranı. Çıktının yüzü
// (yüz derisi + saç, selfie_multiclass) bu orana ulaşana kadar aynı ölçüyle
// keskinleştirilir (unsharp mask, aynı σ). Ölçü ve düzeltme aynı bant
// olduğu için kazanç tek adımda hesaplanır. Yüz zaten yeterince detaylıysa
// dokunulmaz; asla yumuşatılmaz.

const sharp = require("sharp");

const SIGMA = 1.2;
// Bu kazancın altı gözle fark edilmez.
const APPLY_MIN_GAIN = 1.1;
// Daha fazlası JPEG blok/gürültüsünü de büyütür.
const MAX_GAIN = 1.8;
const MASK_THR = 0.6;

/** Yüksek geçiren RMS, maskeli. SAF. */
function hfRms(gray, blurred, mask, thr = MASK_THR) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask[i] <= thr) continue;
    const v = gray[i] - blurred[i];
    s += v * v;
    n++;
  }
  return n > 500 ? Math.sqrt(s / n) : null;
}

/**
 * Kazanç planı. SAF. Şablonun yüz/kıyafet detay oranına ulaşmak için
 * çıktının yüz detayının kaç katına çıkması gerekiyor.
 */
function planDetailGain({ outFace, outCloth, tplFace, tplCloth }) {
  if (![outFace, outCloth, tplFace, tplCloth].every((v) => v > 0)) return { apply: false, reason: "no-measure" };
  const target = (tplFace / tplCloth) * outCloth;
  const gain = target / outFace;
  if (gain < APPLY_MIN_GAIN) return { apply: false, reason: "detailed-enough", gain };
  return { apply: true, reason: null, gain: Math.min(MAX_GAIN, gain), rawGain: gain };
}

async function grayAndBlur(rgb, W, H) {
  const gray = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).greyscale().raw().toBuffer();
  const blur = await sharp(gray, { raw: { width: W, height: H, channels: 1 } }).blur(SIGMA).extractChannel(0).raw().toBuffer();
  return { gray, blur };
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında. Döner:
 * { buf|null, applied, reason, gain, before, after, target }
 */
async function matchFaceDetail(outputBuf, templateBuf) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width;
  const H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const Po = await classProbs(o.data, W, H);
  const Pt = await classProbs(t, W, H);
  const go = await grayAndBlur(o.data, W, H);
  const gt = await grayAndBlur(t, W, H);
  const m = {
    outFace: hfRms(go.gray, go.blur, Po[CLASSES.faceSkin]),
    outCloth: hfRms(go.gray, go.blur, Po[CLASSES.clothes]),
    tplFace: hfRms(gt.gray, gt.blur, Pt[CLASSES.faceSkin]),
    tplCloth: hfRms(gt.gray, gt.blur, Pt[CLASSES.clothes]),
  };
  const plan = planDetailGain(m);
  const info = { ...m, gain: plan.gain ?? null };
  if (!plan.apply) return { buf: null, applied: false, reason: plan.reason, ...info };

  // Uygulama alanı: yüz derisi + saç (sakal çoğunlukla saç sınıfında),
  // yumuşak kenarlı — boyun ve arka plana taşmaz.
  const m8 = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    m8[i] = Math.round(255 * Math.min(1, Math.max(Po[CLASSES.faceSkin][i], Po[CLASSES.hair][i])));
  }
  const soft = await sharp(m8, { raw: { width: W, height: H, channels: 1 } }).blur(2).extractChannel(0).raw().toBuffer();
  const rgbBlur = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).blur(SIGMA).raw().toBuffer();
  const sharpen = (k) => {
    const res = Buffer.from(o.data);
    for (let i = 0; i < W * H; i++) {
      const a = soft[i] / 255;
      if (a <= 0.01) continue;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const v = o.data[j] + a * k * (o.data[j] - rgbBlur[j]);
        res[j] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
    return res;
  };
  const target = Math.min((m.tplFace / m.tplCloth) * m.outCloth, m.outFace * MAX_GAIN);
  const measure = async (img) => {
    const g = await grayAndBlur(img, W, H);
    return hfRms(g.gray, g.blur, Po[CLASSES.faceSkin]);
  };
  // Unsharp'ın ölçülen etkisi k ile doğrusal değil (iç içe bulanıklık,
  // yumuşak maske); bir kez ölçüp k'yı hedefe göre yeniden ölçekle.
  let k = plan.gain - 1;
  let out = sharpen(k);
  let after = await measure(out);
  if (after > m.outFace && after < target * 0.97) {
    k = Math.min(k * (target - m.outFace) / (after - m.outFace), 2 * (MAX_GAIN - 1));
    out = sharpen(k);
    after = await measure(out);
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return {
    buf, applied: true, reason: null, ...info, rawGain: plan.rawGain,
    before: m.outFace, after, target, k,
  };
}

module.exports = { matchFaceDetail, planDetailGain, hfRms, APPLY_MIN_GAIN, MAX_GAIN };
