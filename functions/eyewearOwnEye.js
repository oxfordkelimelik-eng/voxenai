// GÖRÜNÜR CAMDA KENDİ GÖZÜ (2026-11-12, "V3"; araştırma: 16 karelik eyewear
// seti, kör test V3 - mevcut: gözler 6-2, temizlik 6-2, cam 4-4).
//
// SORUN: şablonun camı açık ve üstten alta renk geçişli (üstü koyu, altı
// açık) olduğunda model kullanıcının gözünü baştan çiziyor (açılmış, kameraya
// bakan göz; 11-12 c2, 11-08 kafa_kirpim c7: kullanıcının gözü aşağı bakıyor)
// ve camı neredeyse saydam çiziyor. eyewear.keepOwnEyes bu karelerde gözü
// bulamıyor (cam koyu sayılmıyor, göz yeri farklı).
//
// ÇÖZÜM (yalnız YAKIN cam, bileşimden SONRA, yerel, ücretsiz):
// 1. Kapı: şablon camı görünür (parlak uç ≥ 0.45), cam çerçevesi ışınlarla
//    bulundu, göz camın içinde, çıktıda göz görünür (saydamlık ≥ 0.9),
//    yeniden çizilmiş (yüksek geçiren NCC < 0.5) ve ayrıntılı (≥ 0.3).
// 2. Göz bölgesinde gözlük öncesi karenin (kendi gözü) parlaklık yapısı,
//    camın sınırdan Laplace zarıyla içeri taşınan zayıflatmasıyla konur
//    (dikişsiz, Poisson türü); renk yalnız camın rengi.
// 3. Şablonun üstten alta karartma eğrisi camın içine yumuşak çarpımsal
//    alanla uygulanır (yansımalar kalır, cam dışı değişmez).
// 4. EK KAPI (kör inceleme sonrası): yalnız 3. adımın üst karartma katsayısı
//    güçlüyse (≤ OWN_EYE_TINT_TOP_MAX) uygulanır; yoksa kare hiç değişmez.
//
// Uzak cam (dönük başta dar göz) DENENDİ, güvensiz: iç bölge burun yanına
// taşıyor, göz köprünün altında; çift kirpik ve renk lekesi verdi. Dokunulmaz.
//
// Ağ (faceMesh dense, headPose3d ile) gözlük öncesi kare, bileşim çıktısı ve
// şablon için ayrı hesaplanır; şablonun cam profili skinSeg gözlük sınıfından.
const sharp = require("sharp");

// Kör test (2026-11-12, V3 - mevcut, 4 değişen kare): gözler 6-2, temizlik
// 6-2, cam 4-4. c5 (renk geçişsiz açık nane cam, ton adımı atlandı) "yapıştırma
// oval" bulundu; c4 (üst karartma 0.63) gözü "değişmiş" bulundu. Beğenilen iki
// kare güçlü üst karartmalı: 11-12 c2 0.43, 11-08 kafa_kirpim c7 0.51. Yalnız
// ton adımı uygulanan ve üst kutu katsayısı bu sınırın altında kalan cam.
const OWN_EYE_TINT_TOP_MAX = 0.6;

// KAPI (2026-11-12, V3 stats.json; değişen camlarda en dar pay: 11-12 c2
// saydamlık 0.967, c4 NCC 0.36).
const GATE = {
  BRIGHT: 0.45, // şablon camı görünür: geçerli camların parlak ucunun en küçüğü
  TRANS: 0.9, // çıktı/öncesi ortalama parlaklık göz üstünde: ≥ → açık camdan göz görünüyor (koyu/geçişli cam 0.21-0.89)
  NCC: 0.5, // yüksek geçiren NCC çıktı-öncesi: < → göz yeniden çizilmiş (korunan göz 0.99)
  COVER: 0.6, // öncesi göz çokgeninin cam içinde (kenardan uzak) kalan oranı
  HITS: 0.8, // çerçeveye çarpan ışın oranı (kapalı, bulunmuş çerçeve)
  DETAIL: 0.3, // yüksek geçiren std oranı: < → çıktı gözü gizlemiş (bulanık "hide" camı ≤ 0.21)
  FAR_RATIO: 0.85, // göz eni oranı bunun altındaysa dar göz uzak camdır
};
// Çerçeve maskesi (2026-11-12): iki seviye. Tek eşik c4'te modelin koyu kapak
// kıvrımını çerçeve sayıp camın üstünü kesti.
const FRAME = {
  Y: 48, RATIO: 0.55, // zayıf sınıf: çekirdeğe FRAME.EDGE yakınlıkta sayılır
  CORE_Y: 22, CORE_RATIO: 0.45, // çok koyu çekirdek
  EDGE: 0.025, BLUR: 0.04, CLOSE: 0.02, OPEN: 0.01, // x iod
  ELL_RX: 0.62, ELL_RY: 0.45, ELL_DY: 0.04, ELL_MAX: 1.2, CORE_ELL: 0.8, // cam elipsi (göz merkezinde, x iod)
};
// Cam iç bölgesi, kendi göz bölgesi, ton (2026-11-12, V3 README).
const LENS = {
  RAYS: 360,
  OWN_UP: 0.11, OWN_DOWN: 0.08, OWN_SIDE: 0.07, // kendi göz bölgesi: öncesi göz konturunun yönlü genişletmesi (x iod)
  AI_DIL: 0.07, // model göz konturu genişletmesi (kirpikler)
  RIM_M: 0.03, // cam kenarına bu kadar yakın piksel bileşimde kalır (x iod)
  FEATH: 0.04, // alfa rampası (x iod)
  LR_SIG: 0.04, SUP_RIM: 0.02, // sınır log-oranı yumuşatması (x iod)
  NOSE_M: 0.03, // uzak camda burun sırtı payı (yalnız kapı ölçüsü)
  TB_KEEP: 0.55, TB_SEP: 0.08, TB_PROJ: 0.4, TB_RUN: 0.03, TB_EYE: 0.05, // renkli ince çerçeveli cam sınırı
  K_CH_MAX: 0, // öncesi renk değişiminin geçen payı (0 = yalnız cam rengi; pay verince c5/kafa c7'de sıcak oval)
  RES_SIG: 0.06, RES_REACH: 0.26, RES_DEV: 0.22, RES_DIL: 0.02, // modelin fazladan koyu kirpik/kıvrım artığı
  TINT_ON: true, TINT_SIG: 0.1, TINT_LO: 0.35, TINT_HI: 1.0, TINT_MIN_GAIN: 0.08, TINT_BINS: 10, TINT_HUE: 0.5, TINT_EDGE: 0.012, TINT_HITS: 0.9, TINT_MAX_TINTHITS: 0.1,
  HARMONIC_ITERS: 4000, HARMONIC_OMEGA: 1.9,
};
// Şablon cam profili (2026-11-12, V2 templateProfile).
const PROF_BINS = 10;
const PROF_ERODE_T = 0.07; // x iodT: gözlük sınıfının çerçeve/kenar bandı atılır
const PROF_EYE_EXCL = 0.05; // x iodT: şablon gözü ölçüme girmez

const EYE_POLY_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const EYE_POLY_L = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382];

// ---------- yardımcılar (V3 ile bit düzeyinde aynı sayısal sıra) ----------
const chamfer = (...a) => require("./headSurround").chamfer(...a);
const Yl = (a, k) => 0.299 * a[k] + 0.587 * a[k + 1] + 0.114 * a[k + 2];
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const median = (a) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
const centre = (mesh, idx) => { let x = 0, y = 0; for (const i of idx) { x += mesh[i][0]; y += mesh[i][1]; } return [x / idx.length, y / idx.length]; };
const dilate = (mask, w, h, r) => { const d = chamfer(Uint8Array.from(mask, (v) => (v ? 1 : 0)), w, h); return Uint8Array.from(d, (v) => (v <= r ? 1 : 0)); };
const erode = (mask, w, h, r) => { const d = chamfer(Uint8Array.from(mask, (v) => (v ? 0 : 1)), w, h); return Uint8Array.from(d, (v) => (v > r ? 1 : 0)); };
const close = (mask, w, h, r) => erode(dilate(mask, w, h, r), w, h, r);
const open = (mask, w, h, r) => dilate(erode(mask, w, h, r), w, h, r);

/** Ayrılabilir Gauss (Float32, kenar tekrarı), kanal sayısı ch. */
function blurF(arr, w, h, sigma, ch = 1) {
  const out = new Float32Array(arr.length), tmp = new Float32Array(arr.length);
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let v = 0;
    for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); v += k[i + r] * arr[(y * w + xx) * ch + c]; }
    tmp[(y * w + x) * ch + c] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let v = 0;
    for (let i = -r; i <= r; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); v += k[i + r] * tmp[(yy * w + x) * ch + c]; }
    out[(y * w + x) * ch + c] = v;
  }
  return out;
}
/** Tek kanal Gauss, çekirdek sonda bölünür (renkli cam sınırı; V3 blurSync). */
function blurSync(arr, w, h, sigma) {
  const r = Math.ceil(3 * sigma), k = []; let s = 0;
  for (let i = -r; i <= r; i++) { k.push(Math.exp(-(i * i) / (2 * sigma * sigma))); s += k[k.length - 1]; }
  const tmp = new Float32Array(arr.length), out = new Float32Array(arr.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * arr[y * w + Math.min(w - 1, Math.max(0, x + i))]; tmp[y * w + x] = v / s; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]; out[y * w + x] = v / s; }
  return out;
}
/** Normalize evrişim: blur(değer·ağırlık)/blur(ağırlık); ağırlıksız yerde NaN. */
function normConv(val, wt, w, h, sigma, ch) {
  const vw = new Float32Array(val.length);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) vw[i * ch + c] = val[i * ch + c] * wt[i];
  const a = blurF(vw, w, h, sigma, ch), b = blurF(wt, w, h, sigma, 1);
  const out = new Float32Array(val.length);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = b[i] > 1e-4 ? a[i * ch + c] / b[i] : NaN;
  return out;
}
function comps4(mask, w, h) {
  const N = w * h, lab = new Int32Array(N).fill(-1), sizes = [], st = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = sizes.length; let n = 0; st.push(i); lab[i] = id;
    while (st.length) {
      const j = st.pop(); n++; const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j >= w ? j - w : -1, j < N - w ? j + w : -1]) if (k >= 0 && mask[k] && lab[k] < 0) { lab[k] = id; st.push(k); }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}
function polyMask(poly, w, h) {
  const m = new Uint8Array(w * h);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++)
      if (inPoly(x + 0.5, y + 0.5, poly)) m[y * w + x] = 1;
  return m;
}

/** Yoğun yüz ağı (headPose3d ile aynı yol: 1600 px, gevşek), görüntü koordinatı. */
async function meshOf(buf) {
  const T = require("./headPose3d")._testables;
  const m0 = await sharp(buf).metadata();
  const n = await T.normalized(buf, 1600);
  const r = await T.meshPose(n.data, n.W, n.H, { loose: true });
  if (!r || !r.mesh) return null;
  const k = m0.width / n.W;
  return { mesh: r.mesh.map((p) => [p[0] * k, p[1] * k]), yaw: r.pose ? r.pose.yaw : null };
}

// ---------- şablon cam profili ----------
/**
 * Şablon camının dikey geçirgenlik profili T(v) (v = 0 cam üstü .. 1 altı),
 * kanal başına = cam pikseli / şablon deri referansı. skinSeg gözlük sınıfı
 * (açık cam deri sayılır, yalnız çerçeve "gözlük": delikleri doldurulur).
 * meshIn: aynı görüntünün ağı zaten varsa (cam tonu, eyewearLensTint.js) yeniden
 * hesaplanmaz. _m: cam/dolu gözlük/deri maskeleri (cam altı geçirgenliği,
 * çerçeve rengi için).
 */
async function templateProfile(tplBuf, meshIn = null) {
  const md = await sharp(tplBuf).metadata();
  const Wt = md.width, Ht = md.height;
  const tRgb = await sharp(tplBuf).removeAlpha().raw().toBuffer();
  const Mt = meshIn || (await meshOf(tplBuf));
  if (!Mt) return { reason: "no-template-mesh" };
  const seg = await require("./sunglassTransfer")._testables.glassesSeg(tplBuf, Wt, Ht, Mt.mesh);
  if (!seg) return { reason: "no-seg" };
  const tE = [centre(Mt.mesh, EYE_POLY_R), centre(Mt.mesh, EYE_POLY_L)];
  const cosT = Math.max(0.5, Math.cos((Math.abs(Mt.yaw || 0) * Math.PI) / 180));
  const iodT = Math.hypot(tE[0][0] - tE[1][0], tE[0][1] - tE[1][1]) / cosT;
  const { x0, y0, w: sw, h: sh } = seg;
  const N = sw * sh;
  const G = new Uint8Array(N), Sk = new Uint8Array(N);
  for (let j = 0; j < N; j++) { G[j] = seg.G[j] > 0.5 ? 1 : 0; Sk[j] = seg.S[j] > 0.6 && seg.G[j] < 0.2 ? 1 : 0; }
  const dToG = chamfer(G, sw, sh);
  const eyeP = [EYE_POLY_R, EYE_POLY_L].map((P) => P.map((i) => Mt.mesh[i]));
  const eyeM = new Uint8Array(N);
  for (let j = 0; j < N; j++) { const X = x0 + (j % sw), Y = y0 + Math.floor(j / sw); if (inPoly(X, Y, eyeP[0]) || inPoly(X, Y, eyeP[1])) eyeM[j] = 1; }
  const dEye = chamfer(eyeM, sw, sh);
  const notG = Uint8Array.from(G, (v) => (v ? 0 : 1));
  const hc = comps4(notG, sw, sh);
  const border = new Uint8Array(hc.sizes.length);
  for (let i = 0; i < N; i++) { const x = i % sw, y = Math.floor(i / sw); if (notG[i] && (x === 0 || y === 0 || x === sw - 1 || y === sh - 1)) border[hc.lab[i]] = 1; }
  const filled = Uint8Array.from(G);
  for (let i = 0; i < N; i++) if (notG[i] && !border[hc.lab[i]] && hc.sizes[hc.lab[i]] >= 0.08 * iodT * iodT) filled[i] = 1;
  const dInF = chamfer(Uint8Array.from(filled, (v) => (v ? 0 : 1)), sw, sh);
  const er = Uint8Array.from(dInF, (v) => (v > PROF_ERODE_T * iodT ? 1 : 0));
  const lensT = [new Uint8Array(N), new Uint8Array(N)];
  for (let j = 0; j < N; j++) {
    if (!er[j]) continue;
    const X = x0 + (j % sw), Y = y0 + Math.floor(j / sw);
    const e = Math.hypot(X - tE[0][0], Y - tE[0][1]) < Math.hypot(X - tE[1][0], Y - tE[1][1]) ? 0 : 1;
    const dx = (X - tE[e][0]) / (0.7 * iodT * cosT), dy = (Y - tE[e][1] - 0.06 * iodT) / (0.5 * iodT);
    if (dx * dx + dy * dy <= 1) lensT[e][j] = 1;
  }
  // Deri referansı: gözlüğe yakın (altında değil) yanak/şakak/burun yanı.
  const sk = [[], [], []];
  for (let j = 0; j < N; j++) {
    if (!Sk[j]) continue;
    const X = x0 + (j % sw), Y = y0 + Math.floor(j / sw);
    const dmin = Math.min(...tE.map((e) => Math.hypot(X - e[0], Y - e[1])));
    if (dmin > 1.0 * iodT || dToG[j] < 0.05 * iodT || dToG[j] > 0.35 * iodT) continue;
    const k = (Y * Wt + X) * 3;
    for (let c = 0; c < 3; c++) sk[c].push(tRgb[k + c]);
  }
  if (sk[0].length < 50) return { reason: "no-template-skin" };
  const skinRef = sk.map(median);
  const B = PROF_BINS, lumOf = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const lenses = [];
  for (let e = 0; e < 2; e++) {
    const reg = lensT[e];
    const top = new Int32Array(sw).fill(-1), bot = new Int32Array(sw).fill(-1);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (reg[y * sw + x]) { if (top[x] < 0) top[x] = y; bot[x] = y; }
    const bins = Array.from({ length: B }, () => [[], [], []]);
    let n = 0;
    for (let j = 0; j < N; j++) {
      if (!reg[j] || !(dEye[j] > PROF_EYE_EXCL * iodT)) continue;
      const x = j % sw, y = Math.floor(j / sw);
      if (!(bot[x] - top[x] >= 4)) continue;
      const v = (y - top[x]) / (bot[x] - top[x]);
      const b = Math.min(B - 1, Math.floor(v * B));
      const k = ((y0 + y) * Wt + x0 + x) * 3;
      for (let c = 0; c < 3; c++) bins[b][c].push(tRgb[k + c] / Math.max(1, skinRef[c]));
      n++;
    }
    // boşluk doldurma, [1 2 1] yumuşatma, uç kutular (çerçeveye değer) komşusuyla
    const prof = bins.map((bb) => bb.map((a) => (a.length >= 8 ? median(a) : null)));
    for (let pass = 0; pass < B; pass++) for (let b = 0; b < B; b++) for (let k = 0; k < 3; k++) if (prof[b][k] == null) {
      const nb = [prof[b - 1], prof[b + 1]].filter((p) => p && p[k] != null).map((p) => p[k]);
      if (nb.length) prof[b][k] = nb.reduce((s, x) => s + x, 0) / nb.length;
    }
    const ln = { e, n, cx: tE[e][0], valid: prof.every((p) => p.every((x) => x != null)) && n >= 200, prof: null };
    if (ln.valid) {
      prof[0] = prof[1].slice(); prof[B - 1] = prof[B - 2].slice();
      const sm = prof.map((p, b) => p.map((x, k) => (prof[Math.max(0, b - 1)][k] + 2 * x + prof[Math.min(B - 1, b + 1)][k]) / 4));
      ln.prof = sm.map((p) => p.map((x) => Math.min(1, Math.max(0.03, x))));
      ln.lum = ln.prof.map(lumOf);
      ln.bright = Math.max(...ln.lum.slice(1, B - 1));
    }
    lenses.push(ln);
  }
  const val = lenses.filter((l) => l.valid);
  // Kapı ölçüsü: geçerli camların parlak ucunun EN KÜÇÜĞÜ (iki cam da görünür olmalı).
  const bright = val.length ? Math.min(...val.map((l) => l.bright)) : null;
  return { bright, yaw: Mt.yaw, lenses, iodT, _m: { lensT, filled, Sk, dEye, x0, y0, sw, sh, tRgb, Wt } };
}

// ---------- kırpım yapısı ----------
function ellR(S, e, x, y) {
  const [cx, cy] = S.eC[e];
  const dx = (x - cx) / (FRAME.ELL_RX * S.iod * S.cosY), dy = (y - cy - FRAME.ELL_DY * S.iod) / (FRAME.ELL_RY * S.iod);
  return Math.sqrt(dx * dx + dy * dy);
}

function structure(S) {
  const { w, h, N, iod } = S;
  const bP = blurF(S.PY, w, h, Math.max(1, FRAME.BLUR * iod));
  const eyeOwnM = S.eyesOwn.map((p) => polyMask(p, w, h));
  const eyeAIM = S.eyesAI ? S.eyesAI.map((p) => polyMask(p, w, h)) : [new Uint8Array(N), new Uint8Array(N)];
  const anyEye = new Uint8Array(N);
  for (let i = 0; i < N; i++) anyEye[i] = eyeOwnM[0][i] | eyeOwnM[1][i] | eyeAIM[0][i] | eyeAIM[1][i];
  const dAnyEye = chamfer(anyEye, w, h);
  const er = [new Float32Array(N), new Float32Array(N)];
  for (let i = 0; i < N; i++) { const x = i % w, y = (i / w) | 0; er[0][i] = ellR(S, 0, x, y); er[1][i] = ellR(S, 1, x, y); }
  // İki seviyeli çerçeve: çok koyu çekirdek + ona yakın kenar (zayıf sınıf).
  const core = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (S.XY[i] < FRAME.CORE_Y && S.XY[i] < FRAME.CORE_RATIO * bP[i]) core[i] = 1;
  const dCore = chamfer(core, w, h);
  let fm = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (core[i] || (S.XY[i] < FRAME.Y && S.XY[i] < FRAME.RATIO * bP[i] && dCore[i] <= Math.max(1.5, FRAME.EDGE * iod))) fm[i] = 1;
  fm = close(fm, w, h, Math.max(1, FRAME.CLOSE * iod));
  fm = open(fm, w, h, Math.max(1, FRAME.OPEN * iod));
  // yalnız iki cam elipsinin dışına uzanan bileşenler çerçevedir
  const c = comps4(fm, w, h), keep = new Uint8Array(c.sizes.length);
  for (let i = 0; i < N; i++) if (fm[i] && Math.min(er[0][i], er[1][i]) > 1.0) keep[c.lab[i]] = 1;
  const Fm = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (fm[i] && keep[c.lab[i]]) Fm[i] = 1;
  for (let i = 0; i < N; i++) if (Fm[i] && dAnyEye[i] <= 0.02 * iod && Math.min(er[0][i], er[1][i]) <= FRAME.CORE_ELL) Fm[i] = 0;
  const interior = [0, 1].map((e) => {
    const free = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!Fm[i] && er[e][i] <= FRAME.ELL_MAX && er[e][i] <= er[1 - e][i]) free[i] = 1;
    const cc = comps4(free, w, h);
    const [cx, cy] = S.eC[e];
    const cnt = new Map();
    for (let i = 0; i < N; i++) if (free[i] && eyeOwnM[e][i]) cnt.set(cc.lab[i], (cnt.get(cc.lab[i]) || 0) + 1);
    let best = -1, bn = 0; for (const [k, v] of cnt) if (v > bn) { bn = v; best = k; }
    if (best < 0) { const i0 = Math.round(cy) * w + Math.round(cx); best = free[i0] ? cc.lab[i0] : -1; }
    const m = new Uint8Array(N);
    if (best >= 0) for (let i = 0; i < N; i++) if (cc.lab[i] === best) m[i] = 1;
    return { m };
  });
  return { eyeOwnM, eyeAIM, er, Fm, interior, dAnyEye };
}

// Uzak cam = baş dönükken dar olan kendi göz konturu (en oranı < GATE.FAR_RATIO).
function farLens(S) {
  const wd = S.eyesOwn.map((p) => Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0])));
  if (Math.min(...wd) / Math.max(...wd) >= GATE.FAR_RATIO) return -1;
  return wd[0] < wd[1] ? 0 : 1;
}
// Uzak camda burun sırtı engeli: ağ çizgisi [168,6,197,195,5,4], öbür yanı ya da NOSE_M payı.
function noseSide(S, e) {
  const { w, N, iod } = S;
  const pl = [168, 6, 197, 195, 5, 4].map((k) => S.mp[k]);
  const out = new Uint8Array(N);
  const sideOf = (x, y) => {
    let xd;
    if (y <= pl[0][1]) xd = pl[0][0] + (pl[1][0] - pl[0][0]) * (y - pl[0][1]) / ((pl[1][1] - pl[0][1]) || 1);
    else if (y >= pl[pl.length - 1][1]) xd = pl[pl.length - 1][0];
    else for (let k = 0; k + 1 < pl.length; k++) if (y >= pl[k][1] && y <= pl[k + 1][1]) { xd = pl[k][0] + (pl[k + 1][0] - pl[k][0]) * (y - pl[k][1]) / ((pl[k + 1][1] - pl[k][1]) || 1); break; }
    return xd;
  };
  const sgn = Math.sign(S.eC[e][0] - sideOf(S.eC[e][0], S.eC[e][1]));
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i / w) | 0;
    if ((x - sideOf(x, y)) * sgn < LENS.NOSE_M * iod) out[i] = 1;
  }
  return out;
}

// Renkli, ince çerçeveli cam sınırı: çıktı-öncesi renk kayması (koyu çerçeve yok).
function tintBoundary(S, T, e) {
  const { w, h, N, iod } = S;
  const dR = new Float32Array(N), dB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const yx = S.XY[i] + 4, yp = S.PY[i] + 4;
    dR[i] = Math.log((S.fix[i * 3] + 4) / yx) - Math.log((S.pre[i * 3] + 4) / yp);
    dB[i] = Math.log((S.fix[i * 3 + 2] + 4) / yx) - Math.log((S.pre[i * 3 + 2] + 4) / yp);
  }
  const med = (sel) => { const a = [], b = []; for (let i = 0; i < N; i++) if (sel(i)) { a.push(dR[i]); b.push(dB[i]); } return a.length > 50 ? [median(a), median(b), a.length] : null; };
  const inRef = med((i) => T.er[e][i] <= 0.6 && T.dAnyEye[i] > 0.06 * iod && !T.Fm[i]);
  const outRef = med((i) => T.er[e][i] >= 1.35 && T.er[e][i] <= 1.7 && T.er[1 - e][i] > 1.2 && !T.Fm[i]);
  if (!inRef || !outRef) return { Bt: null, info: { reason: "no-ref" } };
  const vx = inRef[0] - outRef[0], vy = inRef[1] - outRef[1], sep = Math.hypot(vx, vy);
  const info = { sep: +sep.toFixed(3) };
  if (sep < LENS.TB_SEP) return { Bt: null, info };
  const Bt = new Uint8Array(N), pm0 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = ((dR[i] - outRef[0]) * vx + (dB[i] - outRef[1]) * vy) / (sep * sep);
    pm0[i] = p;
    if (p < LENS.TB_PROJ) Bt[i] = 1;
  }
  return { Bt: open(Bt, w, h, 1), pm: blurSync(pm0, w, h, 1), info };
}

// Cam iç bölgesi: iç dolgunun ağırlık merkezinden çerçeveye ışınlar, boşluklar aradeğerli.
function lensRays(S, T, e) {
  const { w, h, N, iod } = S;
  const flood = T.interior[e].m;
  const far = farLens(S) === e;
  const nb = far ? noseSide(S, e) : null;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < N; i++) if (flood[i] && T.er[e][i] <= 0.8) { sx += i % w; sy += (i / w) | 0; n++; }
  const o = n > 30 ? [sx / n, sy / n] : [S.eC[e][0], S.eC[e][1] + 0.08 * iod];
  const tb = tintBoundary(S, T, e);
  const Bt = tb.Bt;
  const runN = Math.max(4, Math.round((2 * LENS.TB_RUN * iod)));
  const R = LENS.RAYS, r = new Float32Array(R), hit = new Uint8Array(R), hitT = new Uint8Array(R);
  for (let a = 0; a < R; a++) {
    const th = (2 * Math.PI * a) / R, cx = Math.cos(th), cy = Math.sin(th);
    let t = 0, got = false, run = 0, runStart = 0, byTint = false;
    for (t = 0.5; t < 2 * iod; t += 0.5) {
      const x = Math.round(o[0] + cx * t), y = Math.round(o[1] + cy * t);
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      const i = y * w + x;
      if (T.Fm[i]) { got = t > 2; break; }
      if (Bt && Bt[i] && T.dAnyEye[i] > LENS.TB_EYE * iod) { if (!run) runStart = t; run++; if (run >= runN) { got = true; byTint = true; t = runStart; break; } } else run = 0;
      if (nb && nb[i]) { got = t > 2; break; }
      if (T.er[e][i] > 1.25 || T.er[1 - e][i] < T.er[e][i]) break;
    }
    r[a] = t; hit[a] = got ? 1 : 0; hitT[a] = byTint ? 1 : 0;
  }
  const hitFrac = hit.reduce((s, v) => s + v, 0) / R;
  const rf = Float32Array.from(r);
  if (hitFrac > 0) for (let a = 0; a < R; a++) {
    if (hit[a]) continue;
    let p = a, q = a, dp = 0, dq = 0;
    while (!hit[p]) { p = (p - 1 + R) % R; dp++; }
    while (!hit[q]) { q = (q + 1) % R; dq++; }
    rf[a] = (r[p] * dq + r[q] * dp) / (dp + dq);
  }
  const rm = new Float32Array(R);
  for (let a = 0; a < R; a++) { const v = []; for (let k = -2; k <= 2; k++) v.push(rf[(a + k + R) % R]); v.sort((x, y) => x - y); rm[a] = v[2]; }
  const I = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (T.Fm[i] || (nb && nb[i]) || (Bt && Bt[i] && T.dAnyEye[i] > LENS.TB_EYE * iod && T.er[e][i] > 0.7)) continue;
    const x = i % w, y = (i / w) | 0, dx = x - o[0], dy = y - o[1];
    const rho = Math.hypot(dx, dy);
    let th = Math.atan2(dy, dx); if (th < 0) th += 2 * Math.PI;
    const f = (th * R) / (2 * Math.PI), a0 = Math.floor(f) % R, a1 = (a0 + 1) % R, u = f - Math.floor(f);
    const rr = rm[a0] * (1 - u) + rm[a1] * u;
    if (rho < rr - 0.5) I[i] = 1;
  }
  const cc = comps4(I, w, h);
  let best = -1, bn = 0; cc.sizes.forEach((s, k) => { if (s > bn) { bn = s; best = k; } });
  for (let i = 0; i < N; i++) I[i] = I[i] && cc.lab[i] === best ? 1 : 0;
  if (tb.pm) {
    // renkli cam: yalnız cam renkli pikseller (+ göz bölgeleri), kapalı delikler dolu, en büyük bileşen
    const LM = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (I[i] && (tb.pm[i] >= LENS.TB_KEEP || T.dAnyEye[i] <= LENS.TB_EYE * iod)) LM[i] = 1;
    const nc = comps4(Uint8Array.from(LM, (v) => (v ? 0 : 1)), w, h), outside = new Uint8Array(nc.sizes.length);
    for (let i = 0; i < N; i++) if (!LM[i] && !I[i]) outside[nc.lab[i]] = 1;
    for (let i = 0; i < N; i++) if (!LM[i] && !outside[nc.lab[i]]) LM[i] = 1;
    const LO = open(LM, w, h, Math.max(1, 0.015 * iod));
    const c2 = comps4(LO, w, h);
    let b2 = -1, n2 = 0; c2.sizes.forEach((s2, k) => { if (s2 > n2) { n2 = s2; b2 = k; } });
    let kept = 0;
    for (let i = 0; i < N; i++) { const v = LO[i] && c2.lab[i] === b2 ? 1 : 0; if (v) kept++; I[i] = v; }
    bn = kept;
  }
  const dI = chamfer(Uint8Array.from(I, (v) => (v ? 0 : 1)), w, h); // içeriden uzaklık
  return { far, hitFrac, tintHitFrac: hitT.reduce((s, v) => s + v, 0) / R, tint: tb.info, I, dI, area: bn };
}

function gate(S, T, lens) {
  const { w, h, N, iod } = S;
  const sg = Math.max(1, 0.06 * iod);
  const bP = blurF(S.PY, w, h, sg), bX = blurF(S.XY, w, h, sg);
  const res = [];
  for (const e of [0, 1]) {
    const Ln = lens[e];
    const d = chamfer(T.eyeOwnM[e], w, h);
    let nPoly = 0, nPolyIn = 0, n = 0, sp = 0, sx = 0, spp = 0, sxx = 0, spx = 0, mX = 0, mP = 0;
    for (let i = 0; i < N; i++) {
      if (T.eyeOwnM[e][i]) { nPoly++; if (Ln.I[i] && Ln.dI[i] >= 0.03 * iod) nPolyIn++; }
      if (!(d[i] <= 0.04 * iod) || !Ln.I[i] || Ln.dI[i] < 0.04 * iod) continue;
      const a = S.PY[i] - bP[i], b = S.XY[i] - bX[i];
      n++; sp += a; sx += b; spp += a * a; sxx += b * b; spx += a * b; mX += S.XY[i]; mP += S.PY[i];
    }
    const r = { e, hitFrac: +Ln.hitFrac.toFixed(2), cover: nPoly ? +(nPolyIn / nPoly).toFixed(2) : 0, n };
    if (n >= 30) {
      const vp = spp / n - (sp / n) ** 2, vx = sxx / n - (sx / n) ** 2, cv = spx / n - (sp / n) * (sx / n);
      r.ncc = +(cv / Math.sqrt(vp * vx + 1e-9)).toFixed(3);
      r.trans = +(mX / Math.max(1, mP)).toFixed(3);
      r.detail = +Math.sqrt(vx / (vp + 1e-9)).toFixed(3);
    }
    const why = [];
    if (!(S.tpl.bright >= GATE.BRIGHT)) why.push("template-dark");
    if (r.trans == null) why.push("no-eye-in-lens");
    else {
      if (r.trans < GATE.TRANS) why.push("eye-hidden-by-tint");
      if (r.ncc >= GATE.NCC) why.push("own-eye-already");
      if (r.detail < GATE.DETAIL) why.push("eye-smoothed-hidden");
    }
    r.far = Ln.far;
    if (Ln.far) why.push("far-lens-of-turned-head");
    if (r.cover < GATE.COVER) why.push("eye-under-frame");
    if (r.hitFrac < GATE.HITS) why.push("rim-not-found");
    r.apply = why.length === 0; r.why = why;
    res.push(r);
  }
  return res;
}

// Laplace (harmonik) dolgu: D içinde, komşu D dışı değerlerden Dirichlet sınırı (SOR).
// Komşu listesi bir kez kurulur; toplama sırası (sol, sağ, üst, alt) V3 ile aynı.
function harmonic(H, D, w, h, ch, iters) {
  const N = w * h, out = Float32Array.from(H);
  const idx = []; for (let i = 0; i < N; i++) if (D[i]) idx.push(i);
  for (let c = 0; c < ch; c++) {
    let s = 0, n = 0;
    for (const i of idx) for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < N && !D[j]) { s += H[j * ch + c]; n++; }
    const m = n ? s / n : 0;
    for (const i of idx) out[i * ch + c] = m;
  }
  const nbStart = new Int32Array(idx.length + 1), nbList = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], x = i % w;
    nbStart[k] = nbList.length;
    if (x > 0) nbList.push(i - 1); if (x < w - 1) nbList.push(i + 1); if (i >= w) nbList.push(i - w); if (i < N - w) nbList.push(i + w);
  }
  nbStart[idx.length] = nbList.length;
  const nbA = Int32Array.from(nbList);
  const om = LENS.HARMONIC_OMEGA;
  for (let it = 0; it < iters; it++) {
    let md = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], j0 = nbStart[k], j1 = nbStart[k + 1], cnt = j1 - j0;
      for (let c = 0; c < ch; c++) {
        let s = 0; for (let q = j0; q < j1; q++) s += out[nbA[q] * ch + c];
        const v = s / cnt, d = v - out[i * ch + c];
        out[i * ch + c] += om * d; if (Math.abs(d) > md) md = Math.abs(d);
      }
    }
    if (md < 1e-5) break;
  }
  return out;
}

function segDistA(px, py, a, b, up, down, side) {
  // yönlü uzaklık: dikey kayma ölçeklenir, yukarı OWN_UP'a, aşağı OWN_DOWN'a ulaşır
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy + 1e-9)));
  const dx = px - (a[0] + t * vx), dy = py - (a[1] + t * vy);
  const sy = dy < 0 ? side / up : side / down;
  return Math.hypot(dx, dy * sy);
}
function polyDistA(poly, w, h, up, down, side, reach) {
  const out = new Float32Array(w * h).fill(1e9);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - reach * 2)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + reach * 2));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - reach * 2)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + reach * 2));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    if (inPoly(px, py, poly)) { out[y * w + x] = 0; continue; }
    let d = 1e9;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDistA(px, py, poly[j], poly[i], up, down, side));
    out[y * w + x] = d;
  }
  return out;
}

// Dikişsiz kendi göz: f_Y = (P_Y + 4)·exp(hL) − 4, renk = camın rengi (hX).
function ownEye(S, Ln, e, cur) {
  const { w, h, N, iod } = S;
  const Yc = (b, i) => 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2];
  const dOwn = polyDistA(S.eyesOwn[e], w, h, LENS.OWN_UP * iod, LENS.OWN_DOWN * iod, LENS.OWN_SIDE * iod, LENS.OWN_UP * iod);
  const dAI = S.eyesAI ? polyDistA(S.eyesAI[e], w, h, LENS.AI_DIL * iod, LENS.AI_DIL * iod, LENS.AI_DIL * iod, LENS.AI_DIL * iod) : new Float32Array(N).fill(1e9);
  const E0 = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (dOwn[i] <= LENS.OWN_SIDE * iod || dAI[i] <= LENS.AI_DIL * iod) E0[i] = 1;
  const LRl = new Float32Array(N);
  for (let i = 0; i < N; i++) LRl[i] = Math.log((Yc(cur, i) + 4) / (Yc(S.pre, i) + 4));
  // Model artığı: çıktının öncesinden beklenenden KOYU olduğu yer (yalnız koyu → öncesi kaşı çekilmez).
  const sup0 = new Float32Array(N);
  for (let i = 0; i < N; i++) if (Ln.I[i] && !E0[i]) sup0[i] = 1;
  const M0 = normConv(LRl, sup0, w, h, Math.max(1, LENS.RES_SIG * iod), 1);
  let res = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!Ln.I[i] || E0[i] || !Number.isFinite(M0[i])) continue;
    if (dAI[i] <= LENS.RES_REACH * iod && LRl[i] - M0[i] < -LENS.RES_DEV) res[i] = 1;
  }
  res = open(res, w, h, 1);
  const resD = dilate(res, w, h, Math.max(1, LENS.RES_DIL * iod));
  const om = new Uint8Array(N);
  let nAdd = 0;
  for (let i = 0; i < N; i++) if ((E0[i] || resD[i]) && Ln.I[i] && Ln.dI[i] >= LENS.RIM_M * iod) { om[i] = 1; if (!E0[i]) nAdd++; }
  const dIn = chamfer(Uint8Array.from(om, (v) => (v ? 0 : 1)), w, h);
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) if (om[i]) alpha[i] = smoothstep(0, LENS.FEATH * iod, dIn[i] - 0.5);
  // Sınır değerleri: değişen bölge dışındaki cam pikselleri (çerçeve/metal hariç; c5'te gri leke yapıyordu).
  const sup = new Float32Array(N);
  for (let i = 0; i < N; i++) if (Ln.I[i] && !om[i] && Ln.dI[i] >= Math.max(2, LENS.SUP_RIM * iod)) sup[i] = 1;
  const sg = Math.max(0.8, LENS.LR_SIG * iod);
  const chX = new Float32Array(N * 3), chP = LENS.K_CH_MAX > 0 ? new Float32Array(N * 3) : null;
  for (let i = 0; i < N; i++) {
    const yx = Yc(cur, i) + 1, yp = Yc(S.pre, i) + 1;
    for (let c = 0; c < 3; c++) { chX[i * 3 + c] = (cur[i * 3 + c] + 1) / yx; if (chP) chP[i * 3 + c] = (S.pre[i * 3 + c] + 1) / yp; }
  }
  const LRs = normConv(LRl, sup, w, h, sg, 1), cXs = normConv(chX, sup, w, h, sg, 3);
  const cPs = chP ? normConv(chP, sup, w, h, sg, 3) : null;
  for (const A of [LRs, cXs, cPs]) if (A) for (let k = 0; k < A.length; k++) if (!Number.isFinite(A[k])) A[k] = A === LRs ? 0 : 1;
  // Öncesi renk payı (K_CH_MAX = 0: yalnız cam rengi; hesaplanmaz).
  let kCh = 0;
  if (chP) {
    let num = 0, den = 0;
    for (let i = 0; i < N; i++) {
      if (!(sup[i] && dIn[i] <= 0 && Ln.I[i]) || Math.min(dOwn[i], dAI[i]) > LENS.RES_REACH * iod) continue;
      for (const c of [0, 2]) { const a = chP[i * 3 + c] - cPs[i * 3 + c], b = chX[i * 3 + c] - cXs[i * 3 + c]; num += a * b; den += a * a; }
    }
    kCh = Math.max(0, Math.min(LENS.K_CH_MAX, den > 1e-6 ? num / den : 0));
  }
  const D = Uint8Array.from(alpha, (v) => (v > 0 ? 1 : 0));
  const hL = harmonic(LRs, D, w, h, 1, LENS.HARMONIC_ITERS);
  const hX = harmonic(cXs, D, w, h, 3, LENS.HARMONIC_ITERS);
  const hP = chP ? harmonic(cPs, D, w, h, 3, LENS.HARMONIC_ITERS) : null;
  const out = Buffer.from(cur);
  let px = 0;
  for (let i = 0; i < N; i++) {
    const a = alpha[i]; if (a <= 0) continue; px++;
    const fl = (Yc(S.pre, i) + 4) * Math.exp(hL[i]) - 4;
    const ch = [0, 1, 2].map((c) => (hP ? hX[i * 3 + c] + kCh * (chP[i * 3 + c] - hP[i * 3 + c]) : hX[i * 3 + c]));
    const n = 0.299 * ch[0] + 0.587 * ch[1] + 0.114 * ch[2];
    for (let c = 0; c < 3; c++) {
      const f = ((fl + 1) * ch[c]) / Math.max(0.2, n) - 1;
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(cur[i * 3 + c] * (1 - a) + f * a)));
    }
  }
  return { res: out, px, resAdded: nAdd };
}

// Şablon camı: görüntü x sırası; kullanıcı ve şablon zıt yöne dönükse (|yaw| > 15) yakın/uzak değişir.
function tplLensFor(S, e) {
  const tl = S.tpl.lenses.filter((l) => l.valid && l.prof);
  if (tl.length === 0) return null;
  if (tl.length === 1) return tl[0];
  const yawU = S.yawPre || 0, yawT = S.tpl.yaw || 0;
  const sorted = tl.slice().sort((a, b) => a.cx - b.cx);
  const eSorted = S.eC[0][0] < S.eC[1][0] ? [0, 1] : [1, 0];
  let k = eSorted.indexOf(e);
  if (Math.abs(yawU) > 15 && Math.abs(yawT) > 15 && Math.sign(yawU) !== Math.sign(yawT)) k = 1 - k;
  return sorted[k];
}

// Şablonun geçiş eğrisi: K_c(v) = Ttpl_c(v) / Tfix_c(v), yalnız ŞEKİL (en açık kutu çıktı düzeyinde kalır).
function tintLens(S, Ln, e, cur) {
  const { w, h, N, iod } = S;
  const tl = tplLensFor(S, e);
  if (!tl) return { skipped: "no-template-lens" };
  if (Ln.tintHitFrac > LENS.TINT_MAX_TINTHITS || Ln.hitFrac < LENS.TINT_HITS) return { skipped: "lens-boundary-not-a-frame" };
  const B = LENS.TINT_BINS;
  const top = new Float32Array(w).fill(NaN), bot = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) if (Ln.I[y * w + x]) { if (isNaN(top[x])) top[x] = y; bot[x] = y; } }
  const rC = Math.max(2, Math.round(0.08 * iod));
  const smT = new Float32Array(w).fill(NaN), smB = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) {
    if (isNaN(top[x])) continue;
    const a = [], b = [];
    for (let k = -rC; k <= rC; k++) { const xx = x + k; if (xx >= 0 && xx < w && !isNaN(top[xx])) { a.push(top[xx]); b.push(bot[xx]); } }
    smT[x] = median(a); smB[x] = median(b);
  }
  const vOf = (i) => { const x = i % w, y = (i / w) | 0; const t = smT[x], b = smB[x]; if (!(b - t >= 4)) return NaN; return Math.min(1, Math.max(0, (y - t) / (b - t))); };
  const bins = Array.from({ length: B }, () => [[], [], []]);
  for (let i = 0; i < N; i++) {
    if (!Ln.I[i] || Ln.dI[i] < 2) continue;
    const v = vOf(i); if (isNaN(v)) continue;
    const b = Math.min(B - 1, Math.floor(v * B));
    for (let c = 0; c < 3; c++) if (S.pre[i * 3 + c] > 12) bins[b][c].push((cur[i * 3 + c] + 2) / (S.pre[i * 3 + c] + 2));
  }
  const Tfix = bins.map((bb) => bb.map((a) => (a.length >= 12 ? median(a) : null)));
  for (let pass = 0; pass < B; pass++) for (let b = 0; b < B; b++) for (let c = 0; c < 3; c++) if (Tfix[b][c] == null) {
    const nb = [Tfix[b - 1], Tfix[b + 1]].filter((p) => p && p[c] != null).map((p) => p[c]);
    if (nb.length) Tfix[b][c] = nb.reduce((s, x) => s + x, 0) / nb.length;
  }
  if (Tfix.some((p) => p.some((x) => x == null))) return { skipped: "fix-profile-incomplete" };
  const TB = tl.prof.length;
  const Ttpl = Array.from({ length: B }, (_, b) => { const u = ((b + 0.5) / B) * TB - 0.5, b0 = Math.max(0, Math.min(TB - 1, Math.floor(u))), b1 = Math.min(TB - 1, b0 + 1), f = Math.max(0, Math.min(1, u - b0)); return [0, 1, 2].map((c) => tl.prof[b0][c] * (1 - f) + tl.prof[b1][c] * f); });
  const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const mT = Math.max(...Ttpl.map(lum)), mF = Math.max(...Tfix.map(lum));
  let Kb = Ttpl.map((pt, b) => {
    const kl = Math.max(LENS.TINT_LO, Math.min(LENS.TINT_HI, (lum(pt) / mT) / (lum(Tfix[b]) / mF)));
    return [0, 1, 2].map((c) => { const hc = (pt[c] / lum(pt)) / (Tfix[b][c] / lum(Tfix[b])); return kl * Math.pow(Math.max(0.7, Math.min(1.4, hc)), LENS.TINT_HUE); });
  });
  for (let it = 0; it < 2; it++) Kb = Kb.map((p, b) => p.map((x, c) => (Kb[Math.max(0, b - 1)][c] + 2 * x + Kb[Math.min(B - 1, b + 1)][c]) / 4));
  const gain = Math.max(...Kb.map((p) => 1 - lum(p)));
  const info = { K: Kb.map((p) => +lum(p).toFixed(2)), kTop: lum(Kb[0]), gain: +gain.toFixed(2) };
  if (gain < LENS.TINT_MIN_GAIN) return { skipped: "template-not-darker", info };
  const Kf = new Float32Array(N * 3), wt = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!Ln.I[i]) continue;
    const v = vOf(i); if (isNaN(v)) continue;
    const u = v * B - 0.5, b0 = Math.max(0, Math.min(B - 1, Math.floor(u))), b1 = Math.min(B - 1, b0 + 1), f = Math.max(0, Math.min(1, u - b0));
    for (let c = 0; c < 3; c++) Kf[i * 3 + c] = Math.log(Kb[b0][c] * (1 - f) + Kb[b1][c] * f);
    wt[i] = 1;
  }
  const Ks = normConv(Kf, wt, w, h, Math.max(1, LENS.TINT_SIG * iod), 3);
  // yumuşak cam kenarı (sınır koyu çerçeve; görünür geçiş bandı yok), iç bölge dışı hiç değişmez
  const wE = blurF(Float32Array.from(Ln.I), w, h, Math.max(1, LENS.TINT_EDGE * iod));
  const out = Buffer.from(cur);
  let px = 0;
  for (let i = 0; i < N; i++) {
    const a = Ln.I[i] ? wE[i] : 0;
    if (!(a > 0) || !Number.isFinite(Ks[i * 3])) continue;
    px++;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(cur[i * 3 + c] * (1 - a + a * Math.exp(Ks[i * 3 + c])))));
  }
  return { res: out, px, info };
}

function cropRgb(rgb, W, rect) {
  const { left, top, side } = rect;
  const out = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) rgb.copy(out, y * side * 3, ((top + y) * W + left) * 3, ((top + y) * W + left + side) * 3);
  return out;
}

/**
 * Yakın camda kendi gözü + şablon geçişi (V3 + üst karartma kapısı).
 * preBuf/preRgb: gözlük öncesi kare (kodlu + ham RGB, W×H), fixBuf/fixRgb:
 * compositeEyewear çıktısı, rect: gözlük kırpımı, geom: eyewearGeometry
 * (iod, cosY). Döner { rgb (tam kare, değişmediyse null), applied, reason, stats }.
 */
async function ownEyeThroughLens({ preBuf, preRgb, fixBuf, fixRgb, W, H, rect, geom, tplBuf, ctx = null }) {
  const { left, top, side } = rect;
  if (!(side > 16) || left < 0 || top < 0 || left + side > W || top + side > H) return { rgb: null, applied: false, reason: "bad-rect", stats: null };
  if (!(geom && geom.iod > 8)) return { rgb: null, applied: false, reason: "bad-geom", stats: null };
  // Şablon koyu camlıysa (çoğu kare) iki ağ hiç hesaplanmaz; sonuç V3 ile aynı (her cam "template-dark").
  const tpl = await templateProfile(tplBuf);
  if (ctx) ctx.tpl = tpl; // cam tonu adımı (eyewearLensTint.js) şablon profilini ve ağları yeniden hesaplamaz
  const stats = { templateBright: tpl.bright != null ? +tpl.bright.toFixed(3) : null };
  if (tpl.reason) return { rgb: null, applied: false, reason: "template-" + tpl.reason, stats };
  if (!(tpl.bright >= GATE.BRIGHT)) return { rgb: null, applied: false, reason: "template-dark", stats };
  const [mPre, mFix] = await Promise.all([meshOf(preBuf), meshOf(fixBuf)]);
  if (ctx) Object.assign(ctx, { mPre, mFix });
  if (!mPre) return { rgb: null, applied: false, reason: "no-pre-mesh", stats };
  const w = side, h = side, N = w * h;
  const pre = cropRgb(preRgb, W, rect), fix = cropRgb(fixRgb, W, rect);
  const sh = (mesh) => mesh.map((p) => [p[0] - left, p[1] - top]);
  const mp = sh(mPre.mesh), mf = mFix ? sh(mFix.mesh) : null;
  const eyesOwn = [EYE_POLY_R, EYE_POLY_L].map((I) => I.map((i) => mp[i]));
  const eyesAI = mf ? [EYE_POLY_R, EYE_POLY_L].map((I) => I.map((i) => mf[i])) : null;
  const cen = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  const PY = new Float32Array(N), XY = new Float32Array(N);
  for (let i = 0; i < N; i++) { PY[i] = Yl(pre, i * 3); XY[i] = Yl(fix, i * 3); }
  const cosY = Number.isFinite(geom.cosY) && geom.cosY > 0 ? geom.cosY : 1;
  const S = { w, h, N, iod: geom.iod, cosY, pre, fix, PY, XY, mp, eyesOwn, eyesAI, eC: eyesOwn.map(cen), tpl, yawPre: mPre.yaw };
  const T = structure(S);
  const lens = [0, 1].map((e) => lensRays(S, T, e));
  const g = gate(S, T, lens);
  stats.lenses = g.map((r) => ({ e: r.e, hitFrac: r.hitFrac, cover: r.cover, ncc: r.ncc, trans: r.trans, detail: r.detail, far: r.far, apply: r.apply, why: r.why.join("+") }));
  let applyE = g.filter((r) => r.apply).map((r) => r.e);
  if (!applyE.length) return { rgb: null, applied: false, reason: "gate:" + g.map((r) => r.why.join("+")).join("|"), stats };
  // V3 sırası: önce kendi gözler, sonra ton. Ek kapı: üst karartma güçlü olmayan cam
  // düşer; düşen olursa kalanlarla baştan (tek camda V3 ile aynı çıktı).
  for (;;) {
    let cur = Buffer.from(fix);
    const tintSt = {};
    for (const e of applyE) { const o = ownEye(S, lens[e], e, cur); cur = o.res; tintSt[e] = { ownPx: o.px, resAdded: o.resAdded }; }
    const fail = [];
    if (LENS.TINT_ON) for (const e of applyE) {
      const t = tintLens(S, lens[e], e, cur);
      const kTop = t.info ? t.info.kTop : null;
      Object.assign(tintSt[e], { tint: t.skipped || "applied", kTop: kTop != null ? +kTop.toFixed(3) : null, K: t.info ? t.info.K : null });
      if (t.skipped) fail.push(`e${e}:tint-${t.skipped}`);
      else if (!(kTop <= OWN_EYE_TINT_TOP_MAX)) fail.push(`e${e}:tint-top-${kTop.toFixed(2)}`);
      else cur = t.res;
    } else for (const e of applyE) fail.push(`e${e}:tint-off`);
    stats.ownEye = tintSt;
    if (fail.length) {
      const keep = applyE.filter((e) => !fail.some((f) => f.startsWith(`e${e}:`)));
      if (!keep.length) return { rgb: null, applied: false, reason: fail.join("|"), stats };
      applyE = keep;
      continue;
    }
    const outRgb = Buffer.from(fixRgb);
    for (let y = 0; y < side; y++) cur.copy(outRgb, ((top + y) * W + left) * 3, y * side * 3, (y + 1) * side * 3);
    stats.applied = applyE;
    return { rgb: outRgb, applied: true, reason: "applied:e" + applyE.join(","), stats };
  }
}

module.exports = {
  ownEyeThroughLens,
  OWN_EYE_TINT_TOP_MAX,
  _testables: { GATE, FRAME, LENS, templateProfile, harmonic, blurF, normConv, tplLensFor },
  // cam tonu adımı (eyewearLensTint.js) aynı sayısal yardımcıları kullanır
  _shared: { EYE_POLY_R, EYE_POLY_L, chamfer, blurF, normConv, comps4, polyMask, close, median, smoothstep, inPoly, meshOf, templateProfile, ellR, farLens, tplLensFor, cropRgb },
};
