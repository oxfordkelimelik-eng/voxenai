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
// 2.5 → 1.2 ve eksik payın yarısı (2026-11-08, 27deeec2 c7, kullanıcı: "piksellerde
// sıkıntı"): yüz greni 0.91 → 1.91 ikiye katlanınca cilt kumlu göründü.
const GRAIN_MAX_ADD = 1.2;
const GRAIN_SHARE = 0.5;
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
  const rawAdd = Math.sqrt(tpl * tpl - out * out);
  const add = GRAIN_SHARE * rawAdd;
  if (add < GRAIN_MIN_ADD) return { apply: false, reason: "small", add, rawAdd };
  return { apply: true, reason: null, add: Math.min(GRAIN_MAX_ADD, add), rawAdd };
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

// YÜZ YAPISI / HAT BELİRGİNLİĞİ (2026-11-13, kullanıcı: "doğal, yüz hatları belirgin, ışıklı").
// Ölçüm 79956cb2: dramatik ışıklı şablonlarda yüzün orta ölçek gölgesi (burun, elmacık, göz
// çukuru, çene; σ ≈ 0.02-0.08 yüz boyu) şablondan zayıf: c2 .32→.26, c5 .33→.20, c7 .34→.19,
// c9 .18→.11. faceDetail'in keskinliği ince doku (σ 1.2 px) — bunu yapamaz. Burada modelin
// KENDİ çizdiği bant güçlendirilir (şablondan desen kopyalanmaz — 10-16 faceRelight lekeleri);
// yalnız yüz derisinde (sakal/saç sınıfı dışarıda), yalnız artırma, şablon kadar ve en çok
// STRUCT.MAX. Işığı olmayan/düz şablonda oran ≤ 1 → dokunulmaz.
const STRUCT = { ON: true, S1: 0.02, S2: 0.08, MAX: 1.3, MIN_APPLY: 1.05, MASK_THR: 0.6 };

function faceBoxOf(P, CLASSES, W, H) {
  const xs = [], ys = [];
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (P[CLASSES.faceSkin][y * W + x] > STRUCT.MASK_THR) { xs.push(x); ys.push(y); }
  if (xs.length < 60) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { x0: q(xs, 0.02), x1: q(xs, 0.98), y0: q(ys, 0.02), y1: q(ys, 0.98) };
}

/** Kırpımda yüz derisi bant gücü: rms(G(σ1)−G(σ2)) / ortalama ışıklık. */
function structOf(rgb, W, H, P, CLASSES, box) {
  const fh = Math.max(16, box.y1 - box.y0);
  const pad = Math.round(0.6 * fh);
  const cx0 = Math.max(0, box.x0 - pad), cy0 = Math.max(0, box.y0 - pad);
  const cw = Math.min(W, box.x1 + pad) - cx0, ch = Math.min(H, box.y1 + pad) - cy0;
  const g = new Float32Array(cw * ch), m = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = (y + cy0) * W + (x + cx0);
    g[y * cw + x] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    m[y * cw + x] = P[CLASSES.faceSkin][i];
  }
  const b1 = gaussBlurF(g, cw, ch, Math.max(0.8, STRUCT.S1 * fh));
  const b2 = gaussBlurF(g, cw, ch, Math.max(2, STRUCT.S2 * fh));
  let ss = 0, sm = 0, n = 0;
  const D = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    D[i] = b1[i] - b2[i];
    if (m[i] > STRUCT.MASK_THR) { ss += D[i] * D[i]; sm += g[i]; n++; }
  }
  if (n < 200 || sm <= 0) return null;
  return { rel: Math.sqrt(ss / n) / (sm / n), D, cx0, cy0, cw, ch, fh };
}

/**
 * Yüz yapısını şablon yüzünün yapısına doğru güçlendirir (outputBuf/templateBuf aynı kadraj).
 * Döner { buf|null, applied, reason, tpl, before, gain, after }.
 */
async function matchFaceStructure(outputBuf, templateBuf) {
  if (!STRUCT.ON) return { buf: null, applied: false, reason: "off" };
  const { classProbs, CLASSES } = require("./skinSeg");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const Po = await classProbs(o.data, W, H);
  const Pt = await classProbs(t, W, H);
  const bo = faceBoxOf(Po, CLASSES, W, H), bt = faceBoxOf(Pt, CLASSES, W, H);
  if (!bo || !bt) return { buf: null, applied: false, reason: "no-face" };
  const so = structOf(o.data, W, H, Po, CLASSES, bo), st = structOf(t, W, H, Pt, CLASSES, bt);
  if (!so || !st) return { buf: null, applied: false, reason: "no-skin" };
  const gain = Math.min(STRUCT.MAX, st.rel / so.rel);
  if (!(gain >= STRUCT.MIN_APPLY)) return { buf: null, applied: false, reason: "structured-enough", tpl: st.rel, before: so.rel, gain };
  const { cx0, cy0, cw, ch, D } = so;
  const m8 = Buffer.alloc(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m8[y * cw + x] = Math.round(255 * Math.min(1, Po[CLASSES.faceSkin][(y + cy0) * W + x + cx0]));
  const soft = await sharp(m8, { raw: { width: cw, height: ch, channels: 1 } }).blur(Math.max(1.5, 0.02 * so.fh)).extractChannel(0).raw().toBuffer();
  const res = Buffer.from(o.data);
  const k = gain - 1;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const a = soft[y * cw + x] / 255;
    if (a <= 0.01) continue;
    const d = a * k * D[y * cw + x];
    const i = ((y + cy0) * W + x + cx0) * 3;
    for (let c = 0; c < 3; c++) { const v = o.data[i + c] + d; res[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
  }
  const after = structOf(res, W, H, Po, CLASSES, bo);
  const buf = await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, tpl: st.rel, before: so.rel, gain, after: after ? after.rel : null };
}

module.exports = {
  matchFaceStructure, STRUCT,
  matchFaceDetail, planDetailGain, hfRms, APPLY_MIN_GAIN, MAX_GAIN,
  planGrain, fineNoise, grainField, GRAIN_MIN_RATIO, GRAIN_MAX_ADD, GRAIN_SHARE,
};
