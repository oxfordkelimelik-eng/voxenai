// ORTAM IŞIK RENGİ — L2 (2026-10-16, kullanıcı: "ortamın rengine göre ışık
// vermek"; "L1 ve L2'yi birlikte çalıştıralım").
//
// SORUN: model yüzün rengini selfie'den alıyor; base sahnesi turuncu lamba,
// gün batımı ya da mavi saat ışığındayken yüz o ışığı taşımıyor. Işık yüzeyi
// (faceRelight) yalnızca yüzdeki renk DEĞİŞİMİNİ taşır, ortalama rengi
// bilerek taşımaz: base yüzünün ortalaması mankenin TENİ ile ışığın karışımı;
// onu taşımak 10-14'te yüzü mankenin tenine boyadı.
//
// YÖNTEM: renk = ten × ışık. Kişinin ışıksız teni selfie'lerden (yüz rengi /
// selfie sahnesinin ışığı, kareler arası ortanca); base'in ışığı sahnenin
// kendisinden (grey-edge: kenarların renk ortalaması — düz renkli duvarın
// kendi rengini büyük ölçüde atar), yüzün çevresindeki arka planda. Hedef yüz
// rengi = ten × base ışığı. Yalnız RENK değişir (parlaklık-nötr), hedefe kısmen
// ve sınırlı gidilir. Model yüzü zaten kısmen ısıttıysa fark küçülür — ışık
// iki kez eklenmez (selfie'siz "nötr ışık" varsayımı 34 karede bunu yaptı).
// Mankenin yüzü hiç kullanılmaz.

const sharp = require("sharp");

// Hedefe gidilen pay ve kanal başına log sınırı (±%16).
const STRENGTH = 0.6;
const MAX_SHIFT = 0.15;
// Grey-edge Minkowski üssü ve çalışma çözünürlüğü.
const P = 6;
const DIM = 512;
// Sahne: yüz merkezinden bu kadar yüz genişliği içindeki arka plan.
const RADIUS_FACES = 3;
const BG_P = 0.6;
const MIN_PX = 300;
// En/en küçük kanal oranı bunun altındaysa renksiz (siyah-beyaz) sayılır.
const GRAY_RATIO = 1.12;
// Selfie yüz derisi olasılığı ve en az piksel.
const SKIN_P = 0.7;
const MIN_SKIN_PX = 500;

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

const lumaOf = (e) => 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
/** Parlaklığı 1'e normalize. SAF. */
const normLum = (e) => { const l = lumaOf(e); return l > 0 ? e.map((v) => v / l) : null; };
const isGray = (e) => !e || Math.max(...e) / Math.max(1e-4, Math.min(...e)) < GRAY_RATIO;

function blur1(a, w, h) {
  const k = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]; // σ≈1
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += k[j + 2] * a[y * w + Math.min(w - 1, Math.max(0, x + j))];
    t[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += k[j + 2] * t[Math.min(h - 1, Math.max(0, y + j)) * w + x];
    o[y * w + x] = s;
  }
  return o;
}

/**
 * Sahnenin ışık rengi (grey-edge), doğrusal RGB, parlaklık 1. Yalnız arka
 * plan; box verilirse yüzün çevresi. Döner [r,g,b] | null.
 */
async function sceneIlluminant(rgb, W, H, box = null) {
  const sc = Math.min(1, DIM / Math.max(W, H));
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
  const small = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const { classProbs, CLASSES } = require("./skinSeg");
  const bg = (await classProbs(small, w, h))[CLASSES.background];
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = SRGB2LIN[small[i * 3 + c]];
    return blur1(a, w, h);
  });
  const cx = box ? (box.x + box.width / 2) * sc : 0, cy = box ? (box.y + box.height / 2) * sc : 0;
  const R = box ? RADIUS_FACES * box.width * sc : Infinity;
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (bg[i] < BG_P || Math.hypot(x - cx, y - cy) > R) continue;
      // Patlamış ve neredeyse siyah pikselin kenarı ışığı değil kırpmayı ölçer.
      if (ch[0][i] > 0.9 || ch[1][i] > 0.9 || ch[2][i] > 0.9 || ch[0][i] < 0.004 || ch[1][i] < 0.004 || ch[2][i] < 0.004) continue;
      for (let c = 0; c < 3; c++) acc[c] += Math.hypot(ch[c][i + 1] - ch[c][i - 1], ch[c][i + w] - ch[c][i - w]) ** P;
      n++;
    }
  }
  if (n < MIN_PX) return null;
  return normLum(acc.map((v) => (v / n) ** (1 / P)));
}

/** Kanal başına ortanca, parlaklık 1. SAF. */
function medianColor(vals) {
  if (!vals.length) return null;
  const m = [0, 1, 2].map((c) => { const a = vals.map((v) => v[c]).sort((p, q) => p - q); return a[a.length >> 1]; });
  return normLum(m);
}

/**
 * Kişinin IŞIKSIZ teni selfie'lerden: her karede yüz derisi rengi / o
 * sahnenin ışığı, kareler arası ortanca. Döner { skin: [r,g,b], n } | null.
 */
async function selfieSkinLight(buffers) {
  const { detectMainFace } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const per = [];
  for (const buf of buffers) {
    try {
      const im = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const W = im.info.width, H = im.info.height;
      const f = await detectMainFace(buf);
      if (!f) continue;
      const e = await sceneIlluminant(im.data, W, H, null);
      if (!e) continue;
      const b = f.box;
      const L = Math.max(0, Math.floor(b.x)), T = Math.max(0, Math.floor(b.y));
      const Wd = Math.min(W - L, Math.ceil(b.width)), Hd = Math.min(H - T, Math.ceil(b.height));
      if (Wd < 16 || Hd < 16) continue;
      const crop = await sharp(im.data, { raw: { width: W, height: H, channels: 3 } })
        .extract({ left: L, top: T, width: Wd, height: Hd }).resize(256, 256, { fit: "fill" }).raw().toBuffer();
      const sk = (await classProbs(crop, 256, 256))[CLASSES.faceSkin];
      const vals = [];
      for (let i = 0; i < 256 * 256; i++) if (sk[i] > SKIN_P) vals.push([SRGB2LIN[crop[i * 3]], SRGB2LIN[crop[i * 3 + 1]], SRGB2LIN[crop[i * 3 + 2]]]);
      if (vals.length < MIN_SKIN_PX) continue;
      const fc = medianColor(vals);
      if (fc) per.push(normLum(fc.map((v, c) => v / e[c])));
    } catch (e) {
      console.error("Selfie ten ışığı ölçülemedi (kare atlandı):", e.message || e);
    }
  }
  const skin = medianColor(per.filter(Boolean));
  return skin && !isGray(skin) ? { skin, n: per.length } : null;
}

/**
 * Renk kayması planı. SAF. skin: ışıksız ten; eT: base sahne ışığı; face: çıktı
 * yüzünün şu anki rengi (hepsi parlaklık 1). Döner { lc: [log kazanç × 3] }
 * (parlaklık-nötr) ya da { lc: null, reason }.
 */
function planLightColor(skin, eT, face) {
  if (!skin || !eT || !face) return { lc: null, reason: "no-measure" };
  // Siyah-beyaz base ya da gri yüz: renk yok (gri yüzü selfie tenine boyamasın).
  if (isGray(face)) return { lc: null, reason: "grayscale" };
  const raw = [0, 1, 2].map((c) => Math.log((skin[c] * eT[c]) / face[c]));
  const mu = lumaOf(raw);
  const lc = raw.map((v) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, STRENGTH * (v - mu))));
  return { lc, reason: null };
}

// ── L2 YENİ TASARIM (2026-10-17, kör test 31 kare: renkli 26, bugünkü 5;
// A ve B 13-13 berabere, B seçildi: üç bağımsız tahmin tek birinin yanılgısını
// üçte bire indirir). Selfie artık kullanılmıyor: ışıksız ten selfie'den
// yanlış ölçüldü (0eeb75c8). Işık = şablonun kendisinden üç tahminin log
// ortalaması: (1) yüz çevresindeki arka plan, (2) kişinin kıyafeti + vücut
// derisi (c12 gün batımı: arka plan deniz/gökyüzü serin, kişi turuncu
// aydınlık), (3) şablon yüzü / tipik ten (2026-10-19'dan beri yalnız (1) ve (2)
// yoksa — mankenin teni ışık sanılıyordu, bkz. templateLight). Hedef = çıktı yüzü × ışık^0.6;
// sonuç ten aralığından çıkacaksa kayma küçültülür.

// Tipik ışıksız ten (doğrusal, parlaklık 1'e normalize edilir).
const SKIN_PRIOR = [1.8, 0.8, 0.55];
// Işıklı yüzün akla yatkın aralığı (doğrusal r/g, b/g).
const SKIN_RG = [1.5, 2.9], SKIN_BG = [0.42, 0.85];
const PERSON_P = 0.6;
const MIN_FACE_SKIN_PX = 80;
const MIN_EDGE_PX = 150;

/** Kanal başına log ortalama, parlaklık 1. SAF. */
function logMean(list) {
  const ok = list.filter(Boolean);
  if (!ok.length) return null;
  return normLum([0, 1, 2].map((c) => Math.exp(ok.reduce((s, e) => s + Math.log(e[c]), 0) / ok.length)));
}

/**
 * Şablonun ışık rengi, üç tahminden (bkz. üstte). box: şablon yüz kutusu.
 * Döner { light, eBg, ePerson, eFace } (hepsi parlaklık 1, tahmin yoksa null).
 */
async function templateLight(rgb, W, H, box) {
  const sc = Math.min(1, DIM / Math.max(W, H));
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
  const small = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const { classProbs, CLASSES } = require("./skinSeg");
  const Pr = await classProbs(small, w, h);
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = SRGB2LIN[small[i * 3 + c]];
    return blur1(a, w, h);
  });
  const cx = (box.x + box.width / 2) * sc, cy = (box.y + box.height / 2) * sc, R = RADIUS_FACES * box.width * sc;
  const edge = (sel) => {
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!sel(i) || Math.hypot(x - cx, y - cy) > R) continue;
        if (ch[0][i] > 0.9 || ch[1][i] > 0.9 || ch[2][i] > 0.9 || ch[0][i] < 0.004 || ch[1][i] < 0.004 || ch[2][i] < 0.004) continue;
        for (let c = 0; c < 3; c++) acc[c] += Math.hypot(ch[c][i + 1] - ch[c][i - 1], ch[c][i + w] - ch[c][i - w]) ** P;
        n++;
      }
    }
    return n >= MIN_EDGE_PX ? normLum(acc.map((v) => (v / n) ** (1 / P))) : null;
  };
  const eBg = edge((i) => Pr[CLASSES.background][i] > BG_P);
  const ePerson = edge((i) => Pr[CLASSES.clothes][i] + Pr[CLASSES.bodySkin][i] > PERSON_P);
  const vals = [];
  const x0 = Math.max(0, Math.floor(box.x * sc)), x1 = Math.min(w, (box.x + box.width) * sc);
  const y0 = Math.max(0, Math.floor(box.y * sc)), y1 = Math.min(h, (box.y + box.height) * sc);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (Pr[CLASSES.faceSkin][i] > SKIN_P) vals.push([SRGB2LIN[small[i * 3]], SRGB2LIN[small[i * 3 + 1]], SRGB2LIN[small[i * 3 + 2]]]);
  }
  const prior = normLum(SKIN_PRIOR);
  const fm = vals.length >= MIN_FACE_SKIN_PX ? medianColor(vals) : null;
  const eFace = fm ? normLum(fm.map((v, c) => v / prior[c])) : null;
  // MANKENİN TENİ IŞIK DEĞİL (2026-10-19, 9c8f2cb5 c7): yüz tahmini = şablon
  // yüzü / TİPİK ten; mankenin teni tipikten koyuysa "sıcak ışık", açıksa
  // "soğuk ışık" okunuyor. 79 karede koyu tenli mankenlerde diğer iki tahmine
  // göre G/B +0.33…+0.69 (9c8 c7, 3b4 c7, 10e c1/c3/c6) — beyaz kullanıcının
  // yüzü turuncuya çekiliyordu, tersi esmer kullanıcıyı soğuturdu. Yalnız
  // arka plan ve kişi (kıyafet) tahmini; ikisi de yoksa yüz tahmini.
  const light = logMean([eBg, ePerson]) || eFace;
  return { light, eBg, ePerson, eFace };
}

/**
 * Renk kayması planı. SAF. light: şablon ışığı; face: çıktı yüzünün şu anki
 * rengi (ikisi de parlaklık 1). Döner { lc: [log kazanç × 3] } (parlaklık-nötr)
 * ya da { lc: null, reason }.
 */
function planSceneColor(light, face) {
  if (!light || !face) return { lc: null, reason: "no-measure" };
  if (isGray(face)) return { lc: null, reason: "grayscale" };
  const raw = light.map(Math.log);
  const mu = lumaOf(raw);
  const lc = raw.map((v) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, STRENGTH * (v - mu))));
  // Ten aralığı: kayma yüzü iki orandan birinde aralıktan dışarı (ya da daha
  // dışarı) itiyorsa küçült.
  const out = (f) => {
    const rg = f[0] / f[1], bg = f[2] / f[1];
    return [Math.max(0, SKIN_RG[0] - rg, rg - SKIN_RG[1]), Math.max(0, SKIN_BG[0] - bg, bg - SKIN_BG[1])];
  };
  const out0 = out(face);
  const worse = (k) => out(face.map((v, c) => v * Math.exp(k * lc[c]))).some((v, j) => v > out0[j] + 1e-9);
  let k = 1;
  while (k > 0 && worse(k)) k -= 0.05;
  k = Math.max(0, k);
  return { lc: lc.map((v) => v * k), reason: null, k };
}

module.exports = { sceneIlluminant, selfieSkinLight, planLightColor, medianColor, templateLight, planSceneColor, _testables: { normLum, isGray, logMean, STRENGTH, MAX_SHIFT, SKIN_RG, SKIN_BG } };
