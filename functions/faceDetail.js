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
const APPLY_MIN_GAIN = 1.08;
// Daha fazlası JPEG blok/gürültüsünü de büyütür. 1.8 → 1.45 (2026-10-30,
// 922f1371 c4: koyulaştırılan yüzde 1.72 kazanç sakal dokusunu sertleştirdi).
const MAX_GAIN = 1.45;
const MASK_THR = 0.6;

// YÜZ GRENİ (2026-10-16, kullanıcı: "base fotodaki netlik yok"). Ölçüldü
// (629b45de + 6dd26e3e, 19 kare): yüz derisinin İNCE dokusu (σ=0.7 yüksek
// geçiren, sağlam std) 10 karede şablonunkinin yarısı-üçte ikisi (c3 0.67'ye
// 1.86, 6dd c1 0.46'ya 1.83). Arka plan şablondan geri yüklendiği için
// şablonun grenini taşıyor, kişi pürüzsüz — yüz "yapıştırılmış/plastik"
// görünüyor. Kıyafet de pürüzsüz olduğu için yüz/kıyafet oranı (yukarıdaki
// keskinleştirme) bunu görmüyordu. Eksik pay (karelerin farkı) ışıklık
// gürültüsü olarak yüz, saç ve vücut derisine eklenir; keskinleştirmeden
// SONRA (gren büyütülmesin). Asla gren silinmez.
const GRAIN_SIGMA = 0.7;
const GRAIN_MASK_THR = 0.8;
// Şablon yüzü çıktınınkinden bu kat fazla grenli değilse dokunulmaz.
const GRAIN_MIN_RATIO = 1.15;
// Eksik pay (gri seviye, ölçü biriminde) bunun altındaysa fark edilmez.
const GRAIN_MIN_ADD = 0.5;
// Üstü "bozuk görüntü" gibi durur; 6dd c2 şablonu 5.7 (doku) ölçüyor.
const GRAIN_MAX_ADD = 2.5;
// Sensör greni tek piksellik beyaz gürültü değil (demozaik + JPEG).
const GRAIN_CORR_SIGMA = 0.5;

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

/**
 * Gren planı. SAF. tpl/out: ince doku ölçüsü (fineNoise). Döner eklenecek
 * payın ölçü birimindeki büyüklüğü.
 */
function planGrain(tpl, out) {
  if (!(tpl > 0) || !(out >= 0)) return { apply: false, reason: "no-measure" };
  if (tpl < out * GRAIN_MIN_RATIO) return { apply: false, reason: "grainy-enough" };
  const add = Math.sqrt(tpl * tpl - out * out);
  if (add < GRAIN_MIN_ADD) return { apply: false, reason: "small", add };
  return { apply: true, reason: null, add: Math.min(GRAIN_MAX_ADD, add), rawAdd: add };
}

// Ayrılabilir Gauss, kayan nokta (sharp'ın 8 bit blur'u σ<1'de ölçüyü
// basamaklı yapıyor: MAD 1.48'in katlarına düşüyordu).
function gaussBlurF(a, W, H, sig) {
  const r = Math.max(1, Math.ceil(3 * sig));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sig * sig));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const t = new Float32Array(W * H);
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * a[row + Math.min(W - 1, Math.max(0, x + i))];
      t[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * t[Math.min(H - 1, Math.max(0, y + i)) * W + x];
      o[y * W + x] = v;
    }
  }
  return o;
}

function lumaF(rgb, N) {
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return g;
}

/** İnce doku: ışıklık - Gauss(σ), maskeli sağlam std (1.4826·MAD). SAF. */
function fineNoise(gray, W, H, mask, thr = GRAIN_MASK_THR, stride = 1) {
  const bl = gaussBlurF(gray, W, H, GRAIN_SIGMA);
  const d = [];
  for (let i = 0; i < W * H; i += stride) if (!mask || mask[i] > thr) d.push(Math.abs(gray[i] - bl[i]));
  if (d.length < 500) return null;
  d.sort((a, b) => a - b);
  return 1.4826 * d[d.length >> 1];
}

// Tekrarlanabilir gürültü (aynı kare aynı greni alır).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Birim ince-doku ölçülü, hafif ilintili Gauss gürültü alanı. SAF. */
function grainField(W, H, seed) {
  const rnd = mulberry32(seed);
  const n = new Float32Array(W * H);
  for (let i = 0; i < n.length; i += 2) {
    const u = Math.max(1e-12, rnd());
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rnd();
    n[i] = r * Math.cos(th);
    if (i + 1 < n.length) n[i + 1] = r * Math.sin(th);
  }
  const c = gaussBlurF(n, W, H, GRAIN_CORR_SIGMA);
  const unit = fineNoise(c, W, H, null, 0, 7);
  if (unit > 0) for (let i = 0; i < c.length; i++) c[i] /= unit;
  return c;
}

async function grayAndBlur(rgb, W, H) {
  const gray = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).greyscale().raw().toBuffer();
  const blur = await sharp(gray, { raw: { width: W, height: H, channels: 1 } }).blur(SIGMA).extractChannel(0).raw().toBuffer();
  return { gray, blur };
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında. Önce keskinleştirme, sonra
 * gren. Döner: { buf|null, applied, sharpened, reason (keskinlik), gain,
 * before, after, target, grain: { reason, tpl, before, add, amp, after } }
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
  const sh = plan.apply ? await sharpenFace(o.data, W, H, Po, CLASSES, m, plan) : null;
  const cur = sh ? sh.out : o.data;
  const grain = addFaceGrain(cur, t, W, H, Po, Pt, CLASSES);
  const res = grain.out || cur;
  const applied = !!(sh || grain.out);
  const buf = applied ? await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() : null;
  const { out: _g, ...grainInfo } = grain;
  return {
    buf, applied, sharpened: !!sh, reason: plan.reason, ...info,
    ...(sh ? { rawGain: plan.rawGain, before: m.outFace, after: sh.after, target: sh.target, k: sh.k } : {}),
    grain: grainInfo,
  };
}

/** Keskinleştirme (σ=SIGMA unsharp) — yüz/kıyafet oranı şablonunkine. */
async function sharpenFace(rgb, W, H, Po, CLASSES, m, plan) {
  const o = { data: rgb };
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
  return { out, after, target, k };
}

/**
 * Yüz, saç ve vücut derisine şablonun yüz greni kadar ışıklık greni (eksik
 * pay). Döner { out|null, reason, tpl, before, add, after }.
 */
function addFaceGrain(rgb, tRgb, W, H, Po, Pt, CLASSES) {
  const N = W * H;
  const tpl = fineNoise(lumaF(tRgb, N), W, H, Pt[CLASSES.faceSkin]);
  const before = fineNoise(lumaF(rgb, N), W, H, Po[CLASSES.faceSkin]);
  const plan = planGrain(tpl, before);
  const info = { tpl, before, add: plan.add ?? null };
  if (!plan.apply) return { out: null, reason: plan.reason, ...info };
  const mask = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    mask[i] = Math.min(1, Math.max(Po[CLASSES.faceSkin][i], Po[CLASSES.hair][i], Po[CLASSES.bodySkin][i]));
  }
  const soft = gaussBlurF(mask, W, H, 2);
  const field = grainField(W, H, (Math.imul(W, 73856093) ^ Math.imul(H, 19349663)) >>> 0);
  const apply = (amp) => {
    const out = Buffer.from(rgb);
    for (let i = 0; i < N; i++) {
      const a = soft[i];
      if (a <= 0.01) continue;
      const d = a * amp * field[i];
      for (let c = 0; c < 3; c++) {
        const v = rgb[i * 3 + c] + d;
        out[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
    return out;
  };
  // Sağlam std'ler tam karesel toplanmıyor (yuvarlama, kırpma); bir kez
  // ölçüp genliği hedefe göre yeniden ölçekle.
  const target = Math.sqrt(before * before + plan.add * plan.add);
  let amp = plan.add;
  let out = apply(amp);
  let after = fineNoise(lumaF(out, N), W, H, Po[CLASSES.faceSkin]);
  if (after > before && Math.abs(after - target) > 0.03 * target) {
    amp *= Math.sqrt((target * target - before * before) / (after * after - before * before));
    amp = Math.min(amp, 2 * GRAIN_MAX_ADD);
    out = apply(amp);
    after = fineNoise(lumaF(out, N), W, H, Po[CLASSES.faceSkin]);
  }
  return { out, reason: null, ...info, amp, after };
}

module.exports = {
  matchFaceDetail, planDetailGain, hfRms, APPLY_MIN_GAIN, MAX_GAIN,
  planGrain, fineNoise, grainField, GRAIN_MIN_RATIO, GRAIN_MAX_ADD,
};
