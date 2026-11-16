// CAM TONU + ÇERÇEVE RENGİ (2026-11-12, "V3b"; araştırma: 16 karelik eyewear
// seti, kör test V3b - mevcut, değişen karelerde: cam uyumu 4-4 → 4/4, temizlik
// 4/4).
//
// SORUN: şablonun camı açık ve renk geçişli olduğunda model camı neredeyse
// saydam ve şablondan açık çiziyor (11-12 c2, 11-08 kafa_kirpim c7: üstü koyu
// bordo geçişli cam → çıktıda açık, mor-pembe cam); çerçeveyi de siyah-lacivert
// çiziyor (şablon koyu bordo).
//
// ÇÖZÜM (kendi göz adımından SONRA, yerel, ücretsiz; mevcut çıktının üstüne):
// 1. Cam bulucu: koyu çerçeve halkasının kapattığı delik, dışbükey zarfla
//    (kirpik, cam içinden görünen kaş, koyu cam üstü içeri alınır). Uzak camda
//    burun sırtı ağ çizgisi engel. İKİ cam da bulunmazsa kare değişmez.
// 2. Ton: şablon camının geçirgenliği — düzey (cam altı / hemen altındaki yanak,
//    şablon ÷ mevcut; ışıktan bağımsız), sönümlü renk (±%8) ve şablonun
//    üstten alta eğrisi (kanal başına, alt kutulara sabitli). Çarpımsal alan:
//    yansımalar, kendi göz (V3) ve modelin çerçeve yapısı kalır.
// 3. Çerçeve: skinSeg gözlük sınıfında (çerçeve, köprü, sap) parlaklık
//    korunarak renk şablon çerçevesine çekilir; parlak yansıma/logo değişmez.
// Kapılar: şablon camı görünür (≥ 0.45), iki cam bulundu, en az bir camda
// kutu karartması ≥ 0.15; her cam kendi kazancı ≥ 0.06 ise tonlanır.
//
// Denenip bırakılanlar (araştırma README): V3 ışın bulucu camın kaş görünen
// köşesini kesti, burun üstüne taştı; deriye göre renk yakın camı gri-mor,
// sönümsüz mutlak renk yakını leylak, uzağı yeşil yaptı; Td 32 koyu cam
// üstünü kaçırdı (koyu üst "çerçeve" sayıldı).
const sharp = require("sharp");

// Cam bulucu (2026-11-12, V3b lens.js; kare başına ilk geçen deneme kazanır).
const FIND = {
  DARK_TS: [20, 26], // koyu maske Y eşiği, küçükten büyüğe; 32 koyu geçişli cam üstünü çerçeve sandı
  DARK_RATIO: [0.5, 1.0], // ve çıktı Y < oran × bulanık öncesi Y (çerçeve arkasındaki deriden çok koyu)
  CLOSES: [0.015, 0.03, 0.045, 0.06], // koyu maskenin kapama yarıçapı (x iod), sırayla (iç döngü)
  MIN_AREA: 0.12, MAX_AREA: 1.5, // delik alanı / V3 cam elipsi alanı (π·rx·ry)
  MAX_HULL_GAIN: 1.35, // zarf alanı / delik alanı: fazlası halka dışına taşmış zarf
  LEAK_ELL: 1.25, LEAK_MAX: 0.03, // zarfın bu elips yarıçapı dışındaki payı en çok
  CEN_ELL: 0.9, // delik ağırlık merkezi elips yarıçapı sınırı
  NOSE_M: 0.03, // x iod: uzak camda burun sırtı çizgisi + pay engeldir
  RIM_CORE_Y: 24, RIM_NEAR: 0.04, RIM_COVER: 0.85, // zarf sınırının ≥ %85'i çok koyu çerçeveye (ya da burun çizgisine) RIM_NEAR yakın
  ELL_A_RX: 0.62, ELL_A_RY: 0.45, // V3 cam elipsi yarı eksenleri (x iod; rx ayrıca × cosY)
};
// Ton alanı (2026-11-12, V3b tint.js + v3b.js).
const TINT = {
  BRIGHT: 0.45, // şablon camı görünür (kendi göz kapısıyla aynı); koyu camda hiç çalışmaz
  BINS: 10, EYE_EXCL: 0.05, COL_MED: 0.08, EDGE_MIN: 2, // dikey profil: göz çokgenleri (x iod) ve cam kenarı (px) dışı
  BOT: [7, 8, 9], // düzey/renk sabitleme kutuları (cam altı)
  K_LO: 0.25, K_HI: 1.0, // parlaklık katsayısı sınırı: yalnız karartır
  HUE: 0.5, HUE_LO: 0.92, HUE_HI: 1.08, // renk sönümü: kök + ±%8 (sönümsüz renk leylak/yeşil cam yaptı)
  MIN_GAIN: 0.06, // cam başına: en büyük kutu karartması (1 − lum K) bundan küçükse o cam tonlanmaz
  FRAME_MIN_GAIN: 0.15, // kare başına: hiçbir cam bu kadar karartılmayacaksa kare değişmez (11-06 c4 0.08)
  SIG: 0.10, // x iod: log K alanı yumuşatması (cam içinde normalize evrişim)
  EXT: 0.03, EXT_MIN: 1.5, // x iod / px: ağırlık zarfın dışına, siyah çerçeveye taşar (iç kenarda tonsuz çizgi kalmaz)
  EDGE_BLUR: 0.6, // px
  NOSE_FALL: 0.05, // x iod: uzak camda burun çizgisinden ağırlık rampası
};
// Cam altı görünür geçirgenliği (2026-11-12, V3b tplcheek.bottomTrans): şablonda
// ve mevcut çıktıda aynı ölçü — cam altı (v ≥ 0.7) / gözlüğün hemen altındaki yanak.
const BOTTOM = { V: 0.7, CHEEK_D0: 0.04, CHEEK_D1: 0.18, EYE_EXCL: 0.05, MIN_N: 30 };
// Çerçeve rengi (2026-11-12, V3b frame.js): parlaklık korunur, renk şablon çerçevesine.
const FRAME_COL = {
  ON: true,
  S: 0.6, // en çok karışım payı
  G_LO: 0.35, G_HI: 0.65, // skinSeg gözlük ("others") olasılığı rampası
  Y_FULL: 40, Y_ZERO: 75, // parlak yansıma ve beyaz logo değişmez
  TPL_Y: 70, // şablon çerçeve rengi: dolu gözlük maskesi − cam, Y < 70 piksellerin medyanı
  BLUR: 0.6, // px
  MIN_N: 30, // (üretim eki) şablonda bu kadar koyu çerçeve pikseli yoksa çerçeve rengi atlanır
};

const OE = require("./eyewearOwnEye")._shared;
const { EYE_POLY_R, EYE_POLY_L, chamfer, blurF, normConv, comps4, polyMask, close, median, smoothstep } = OE;
const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

// Burun sırtı çizgisine (öncesi ağı 168,6,197,195,5,4) işaretli yatay uzaklık, cam e tarafı pozitif.
function noseDist(S, e) {
  const { w, N } = S;
  const pl = [168, 6, 197, 195, 5, 4].map((k) => S.mp[k]);
  const xd = (y) => {
    if (y <= pl[0][1]) return pl[0][0] + (pl[1][0] - pl[0][0]) * (y - pl[0][1]) / ((pl[1][1] - pl[0][1]) || 1);
    if (y >= pl[pl.length - 1][1]) return pl[pl.length - 1][0];
    for (let k = 0; k + 1 < pl.length; k++) if (y >= pl[k][1] && y <= pl[k + 1][1]) return pl[k][0] + (pl[k + 1][0] - pl[k][0]) * (y - pl[k][1]) / ((pl[k + 1][1] - pl[k][1]) || 1);
    return pl[pl.length - 1][0];
  };
  const sgn = Math.sign(S.eC[e][0] - xd(S.eC[e][1]));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) { const x = i % w, y = (i / w) | 0; out[i] = (x + 0.5 - xd(y + 0.5)) * sgn; }
  return out;
}

function hull(pts) { // monotone zincir
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up);
}

// Cam = koyu çerçeve halkasının kendi göz çevresinde kapattığı deliğin dışbükey zarfı.
function findLens(S, T, e) {
  const { w, h, N, iod } = S;
  const bP = blurF(S.PY, w, h, Math.max(1, 0.03 * iod));
  const ellA = Math.PI * (FIND.ELL_A_RX * iod * S.cosY) * (FIND.ELL_A_RY * iod);
  const far = OE.farLens(S) === e;
  const nd = far ? noseDist(S, e) : null;
  for (const Td of FIND.DARK_TS) for (const ratio of FIND.DARK_RATIO) for (const cl of FIND.CLOSES) {
    let D = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (S.XY[i] < Td && S.XY[i] < ratio * bP[i]) D[i] = 1;
    if (nd) for (let i = 0; i < N; i++) if (nd[i] < FIND.NOSE_M * iod) D[i] = 1;
    D = close(D, w, h, Math.max(1, cl * iod));
    const free = Uint8Array.from(D, (v) => (v ? 0 : 1));
    const cc = comps4(free, w, h);
    const border = new Uint8Array(cc.sizes.length);
    for (let i = 0; i < N; i++) { const x = i % w, y = (i / w) | 0; if (free[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) border[cc.lab[i]] = 1; }
    const sx = new Float64Array(cc.sizes.length), sy = new Float64Array(cc.sizes.length);
    for (let i = 0; i < N; i++) if (free[i]) { const k = cc.lab[i]; sx[k] += i % w; sy[k] += (i / w) | 0; }
    const picks = [];
    for (let k = 0; k < cc.sizes.length; k++) {
      if (border[k] || cc.sizes[k] < 0.01 * ellA) continue;
      const j = Math.round(sy[k] / cc.sizes[k]) * w + Math.round(sx[k] / cc.sizes[k]);
      if (T.er[e][j] <= FIND.CEN_ELL && T.er[e][j] <= T.er[1 - e][j]) picks.push(k);
    }
    let area = 0; for (const k of picks) area += cc.sizes[k];
    if (!picks.length || area < FIND.MIN_AREA * ellA || area > FIND.MAX_AREA * ellA) continue;
    const pk = new Set(picks), pts = [];
    for (let i = 0; i < N; i++) if (free[i] && pk.has(cc.lab[i])) { const x = i % w, y = (i / w) | 0; pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]); }
    const R = polyMask(hull(pts), w, h);
    let hA = 0; for (let i = 0; i < N; i++) hA += R[i];
    let out = 0; for (let i = 0; i < N; i++) if (R[i] && T.er[e][i] > FIND.LEAK_ELL) out++;
    if (hA > FIND.MAX_HULL_GAIN * area || out > FIND.LEAK_MAX * hA) continue;
    // zarf sınırı çerçevenin üstünde: dışarıda yakında çok koyu (çekirdek) piksel ya da burun çizgisi
    const core = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!R[i] && (S.XY[i] < FIND.RIM_CORE_Y || (nd && nd[i] < FIND.NOSE_M * iod))) core[i] = 1;
    const dCore = chamfer(core, w, h);
    let nb = 0, nOn = 0;
    for (let i = 0; i < N; i++) {
      if (!R[i]) continue; const x = i % w;
      if ((x > 0 && !R[i - 1]) || (x < w - 1 && !R[i + 1]) || (i >= w && !R[i - w]) || (i < N - w && !R[i + w])) { nb++; if (dCore[i] <= Math.max(2, FIND.RIM_NEAR * iod)) nOn++; }
    }
    if (nOn < FIND.RIM_COVER * nb) continue;
    return { ok: true, far, nd, Td, ratio, cl, R, area, hullArea: hA, rimCover: +(nOn / Math.max(1, nb)).toFixed(2) };
  }
  return { ok: false, far };
}

// Dikey cam koordinatı v (0 üst .. 1 alt): sütun başına zarf üstü/altı, ±COL_MED medyan.
function vField(S, R) {
  const { w, h, N, iod } = S;
  const top = new Float32Array(w).fill(NaN), bot = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (R[y * w + x]) { if (isNaN(top[x])) top[x] = y; bot[x] = y; }
  const rC = Math.max(2, Math.round(TINT.COL_MED * iod));
  const smT = new Float32Array(w).fill(NaN), smB = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) {
    if (isNaN(top[x])) continue;
    const a = [], b = [];
    for (let k = -rC; k <= rC; k++) { const xx = x + k; if (xx >= 0 && xx < w && !isNaN(top[xx])) { a.push(top[xx]); b.push(bot[xx]); } }
    smT[x] = median(a); smB[x] = median(b);
  }
  const v = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) { if (!R[i]) continue; const x = i % w, y = (i / w) | 0, t = smT[x], b = smB[x]; if (b - t >= 4) v[i] = Math.min(1, Math.max(0, (y - t) / (b - t))); }
  return v;
}

// Mevcut camın kanal başına dikey profili (şablon profiliyle aynı sonlandırma).
function measure(S, T, R, v) {
  const { w, h, N, iod } = S;
  const eyes = new Uint8Array(N);
  for (let i = 0; i < N; i++) eyes[i] = T.eyeOwnM[0][i] | T.eyeOwnM[1][i] | T.eyeAIM[0][i] | T.eyeAIM[1][i];
  const dEye = chamfer(eyes, w, h);
  const dIn = chamfer(Uint8Array.from(R, (x) => (x ? 0 : 1)), w, h);
  const B = TINT.BINS;
  const bins = Array.from({ length: B }, () => [[], [], []]);
  for (let i = 0; i < N; i++) {
    if (!R[i] || dIn[i] < TINT.EDGE_MIN || !(dEye[i] > TINT.EYE_EXCL * iod) || isNaN(v[i])) continue;
    const b = Math.min(B - 1, Math.floor(v[i] * B));
    for (let c = 0; c < 3; c++) bins[b][c].push(S.cur[i * 3 + c]);
  }
  let prof = bins.map((bb) => bb.map((a) => (a.length >= 8 ? median(a) : null)));
  for (let pass = 0; pass < B; pass++) for (let b = 0; b < B; b++) for (let c = 0; c < 3; c++) if (prof[b][c] == null) {
    const nb = [prof[b - 1], prof[b + 1]].filter((p) => p && p[c] != null).map((p) => p[c]);
    if (nb.length) prof[b][c] = nb.reduce((s, x) => s + x, 0) / nb.length;
  }
  if (prof.some((p) => p.some((x) => x == null))) return null;
  prof[0] = prof[1].slice(); prof[B - 1] = prof[B - 2].slice();
  prof = prof.map((p, b) => p.map((x, c) => (prof[Math.max(0, b - 1)][c] + 2 * x + prof[Math.min(B - 1, b + 1)][c]) / 4));
  return prof;
}

// Cam altı görünür geçirgenliği (cam e başına): cam altı medyanı ve gözlüğün hemen altındaki yanak medyanı.
function bottomTrans(tp) {
  const { lensT, filled, Sk, dEye, x0, y0, sw, sh, tRgb, Wt } = tp._m, iodT = tp.iodT;
  const res = [];
  for (let e = 0; e < lensT.length; e++) {
    const reg = lensT[e];
    const top = new Int32Array(sw).fill(-1), bot = new Int32Array(sw).fill(-1);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { if (reg[y * sw + x]) { if (top[x] < 0) top[x] = y; bot[x] = y; } }
    const A = [[], [], []], Cc = [[], [], []];
    for (let x = 0; x < sw; x++) {
      if (!(bot[x] - top[x] >= 4)) continue;
      let yb = bot[x]; while (yb + 1 < sh && filled[(yb + 1) * sw + x]) yb++;
      for (let y = top[x]; y <= bot[x]; y++) { const j = y * sw + x; if (!reg[j] || !(dEye[j] > BOTTOM.EYE_EXCL * iodT)) continue; if ((y - top[x]) / (bot[x] - top[x]) < BOTTOM.V) continue; const k = ((y0 + y) * Wt + x0 + x) * 3; for (let c = 0; c < 3; c++) A[c].push(tRgb[k + c]); }
      for (let y = yb + Math.round(BOTTOM.CHEEK_D0 * iodT); y <= Math.min(sh - 1, yb + Math.round(BOTTOM.CHEEK_D1 * iodT)); y++) { const j = y * sw + x; if (!Sk[j] || filled[j]) continue; const k = ((y0 + y) * Wt + x0 + x) * 3; for (let c = 0; c < 3; c++) Cc[c].push(tRgb[k + c]); }
    }
    if (A[0].length < BOTTOM.MIN_N || Cc[0].length < BOTTOM.MIN_N) { res.push(null); continue; }
    res.push({ lens: A.map(median), cheek: Cc.map(median) });
  }
  return res;
}

// K kutu başına: düzey + mutlak renk cam altından (şablon ÷ mevcut), eğri şablon profilinden (alt kutulara sabitli).
function kBins(Ttpl, Tcur, bT, bU) {
  const mb = (P, c) => TINT.BOT.reduce((s, b) => s + P[b][c], 0) / TINT.BOT.length;
  const level = (lum(bT.lens) / lum(bT.cheek)) / (lum(bU.lens) / lum(bU.cheek));
  const chroma = [0, 1, 2].map((c) => (bT.lens[c] / lum(bT.lens)) / (bU.lens[c] / lum(bU.lens)));
  let K = Ttpl.map((pt, b) => {
    const raw = [0, 1, 2].map((c) => level * chroma[c] * (pt[c] / mb(Ttpl, c)) / (Tcur[b][c] / mb(Tcur, c)));
    const kl = Math.max(TINT.K_LO, Math.min(TINT.K_HI, lum(raw)));
    return raw.map((x) => kl * Math.max(TINT.HUE_LO, Math.min(TINT.HUE_HI, Math.pow(x / lum(raw), TINT.HUE))));
  });
  for (let it = 0; it < 2; it++) K = K.map((p, b) => p.map((x, c) => (K[Math.max(0, b - 1)][c] + 2 * x + K[Math.min(K.length - 1, b + 1)][c]) / 4));
  return { K, level, chroma };
}

// Çarpımsal ton alanı: log K v'de doğrusal, cam içinde yumuşatılır; ağırlık zarf + çerçeveye taşma.
function tintLens(S, f, K, cur) {
  const { w, h, N, iod } = S;
  const v = vField(S, f.R);
  const B = K.length;
  const Kf = new Float32Array(N * 3), wt = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!f.R[i] || isNaN(v[i])) continue;
    const u = v[i] * B - 0.5, b0 = Math.max(0, Math.min(B - 1, Math.floor(u))), b1 = Math.min(B - 1, b0 + 1), fr = Math.max(0, Math.min(1, u - b0));
    for (let c = 0; c < 3; c++) Kf[i * 3 + c] = Math.log(K[b0][c] * (1 - fr) + K[b1][c] * fr);
    wt[i] = 1;
  }
  const Ks = normConv(Kf, wt, w, h, Math.max(1, TINT.SIG * iod), 3);
  const dR = chamfer(f.R, w, h); // zarfa uzaklık (içeride 0)
  const ext = Math.max(TINT.EXT_MIN, TINT.EXT * iod);
  const W0 = new Float32Array(N);
  for (let i = 0; i < N; i++) W0[i] = f.R[i] ? 1 : dR[i] <= ext ? 1 : 0;
  const Wb = blurF(W0, w, h, TINT.EDGE_BLUR);
  const out = Buffer.from(cur);
  let px = 0;
  for (let i = 0; i < N; i++) {
    let a = Wb[i];
    if (f.nd) a *= smoothstep(0, TINT.NOSE_FALL * iod, f.nd[i]);
    if (!(a > 0.002) || !Number.isFinite(Ks[i * 3])) continue;
    px++;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(cur[i * 3 + c] * (1 - a + a * Math.exp(Ks[i * 3 + c])))));
  }
  return { res: out, px };
}

// Şablon çerçeve rengi: dolu gözlük maskesi − cam bölgeleri, koyu (Y < TPL_Y) piksellerin kanal medyanı.
function tplFrameColour(tp) {
  const { lensT, filled, x0, y0, sw, sh, tRgb, Wt } = tp._m;
  const c = [[], [], []];
  for (let j = 0; j < sw * sh; j++) {
    if (!filled[j] || lensT[0][j] || lensT[1][j]) continue;
    const k = ((y0 + Math.floor(j / sw)) * Wt + x0 + (j % sw)) * 3;
    if (lum([tRgb[k], tRgb[k + 1], tRgb[k + 2]]) < FRAME_COL.TPL_Y) for (let q = 0; q < 3; q++) c[q].push(tRgb[k + q]);
  }
  return { med: c.map(median), n: c[0].length };
}

// Çerçeve rengini şablona çek (parlaklık korunur). seg: tonlamadan ÖNCEKİ mevcut çıktının gözlük sınıfı.
function frameShift(S, cur, lensMasks, seg, tf) {
  const { w, h, N } = S;
  const { left, top } = S.rect;
  const chT = tf.med.map((x) => x / Math.max(1, lum(tf.med)));
  const W0 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (lensMasks.some((m) => m[i])) continue;
    const xx = left + (i % w) - seg.x0, yy = top + ((i / w) | 0) - seg.y0;
    if (xx < 0 || yy < 0 || xx >= seg.w || yy >= seg.h) continue;
    W0[i] = smoothstep(FRAME_COL.G_LO, FRAME_COL.G_HI, seg.G[yy * seg.w + xx]);
  }
  const Wb = blurF(W0, w, h, FRAME_COL.BLUR);
  const out = Buffer.from(cur);
  let px = 0;
  for (let i = 0; i < N; i++) {
    const p = [cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]], Yv = lum(p);
    const a = FRAME_COL.S * Wb[i] * (1 - smoothstep(FRAME_COL.Y_FULL, FRAME_COL.Y_ZERO, Yv));
    if (!(a > 0.003)) continue;
    px++;
    const Ys = Math.max(1, Yv);
    for (let c = 0; c < 3; c++) { const chC = (p[c] + 0.5) / (Ys + 0.5); const ch = (1 - a) * chC + a * chT[c]; out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(Ys * ch))); }
  }
  return { res: out, px };
}

/**
 * Cam tonu + çerçeve rengi (V3b). curRgb/curBuf: mevcut çıktı (kendi göz
 * adımından sonra; ham RGB W×H + kodlu), preBuf/preRgb: gözlük öncesi kare,
 * fixBuf: bileşim çıktısı (modelin göz ağı bundan), tplBuf: şablon, rect:
 * gözlük kırpımı, geom: { iod, cosY }. ctx: kendi göz adımının hesapladıkları
 * ({ tpl, mPre, mFix }; yoksa burada hesaplanır), curIsFix: mevcut = bileşim
 * (ağı yeniden hesaplanmaz). Döner { rgb (tam kare, değişmediyse null), applied, reason, stats }.
 */
async function lensTint({ curRgb, curBuf, preBuf, preRgb, fixBuf = null, tplBuf, W, H, rect, geom, ctx = {}, curIsFix = false }) {
  const no = (reason, stats = null) => ({ rgb: null, applied: false, reason, stats });
  const { left, top, side } = rect || {};
  if (!(side > 16) || left < 0 || top < 0 || left + side > W || top + side > H) return no("bad-rect");
  if (!(geom && geom.iod > 8)) return no("bad-geom");
  // Koyu şablon camında (çoğu kare) hiçbir ağ/segmentasyon çalışmaz.
  const tpl = ctx.tpl || (await OE.templateProfile(tplBuf));
  if (tpl.reason) return no("template-" + tpl.reason);
  if (!(tpl.bright >= TINT.BRIGHT)) return no("template-dark");
  const mPre = "mPre" in ctx ? ctx.mPre : await OE.meshOf(preBuf);
  if (!mPre) return no("no-pre-mesh");
  const mFix = "mFix" in ctx ? ctx.mFix : await OE.meshOf(fixBuf || curBuf);
  const w = side, h = side, N = w * h, iod = geom.iod;
  const cosY = Number.isFinite(geom.cosY) && geom.cosY > 0 ? geom.cosY : 1;
  const pre = OE.cropRgb(preRgb, W, rect), cur = OE.cropRgb(curRgb, W, rect);
  const sh = (mesh) => mesh.map((p) => [p[0] - left, p[1] - top]);
  const mp = sh(mPre.mesh), mf = mFix ? sh(mFix.mesh) : null;
  const eyesOwn = [EYE_POLY_R, EYE_POLY_L].map((I) => I.map((i) => mp[i]));
  const eyesAI = mf ? [EYE_POLY_R, EYE_POLY_L].map((I) => I.map((i) => mf[i])) : null;
  const cen = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  const PY = new Float32Array(N), XY = new Float32Array(N);
  for (let i = 0; i < N; i++) { PY[i] = lum([pre[i * 3], pre[i * 3 + 1], pre[i * 3 + 2]]); XY[i] = lum([cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]]); }
  const S = { w, h, N, iod, cosY, rect, cur, PY, XY, mp, eyesOwn, eyesAI, eC: eyesOwn.map(cen), tpl, yawPre: mPre.yaw };
  const er = [new Float32Array(N), new Float32Array(N)];
  for (let i = 0; i < N; i++) { const x = i % w, y = (i / w) | 0; er[0][i] = OE.ellR(S, 0, x, y); er[1][i] = OE.ellR(S, 1, x, y); }
  const T = {
    er,
    eyeOwnM: eyesOwn.map((p) => polyMask(p, w, h)),
    eyeAIM: eyesAI ? eyesAI.map((p) => polyMask(p, w, h)) : [new Uint8Array(N), new Uint8Array(N)],
  };
  const lens = [0, 1].map((e) => findLens(S, T, e));
  const stats = { lenses: lens.map((f, e) => ({ e, far: f.far, found: f.ok, ...(f.ok ? { Td: f.Td, ratio: f.ratio, close: f.cl, hullArea: f.hullArea } : {}) })) };
  // İki cam da bulunmalı (yoksa iki cam farklı görünür).
  if (!lens.every((f) => f.ok)) return no("lens-not-found:" + lens.map((f, e) => (f.ok ? "" : "e" + e)).filter(Boolean).join(","), stats);
  // Mevcut çıktının cam altı geçirgenliği (şablonla aynı ölçü; bileşimse ağ yeniden hesaplanmaz).
  const curTp = await OE.templateProfile(curBuf, curIsFix && mFix ? mFix : null);
  if (curTp.reason) return no("current-" + curTp.reason, stats);
  const btT = bottomTrans(tpl), btU = bottomTrans(curTp);
  const plan = [];
  for (const e of [0, 1]) {
    const r = stats.lenses[e], f = lens[e];
    const tl = OE.tplLensFor(S, e);
    if (!tl) { r.why = "no-template-lens"; continue; }
    const Tcur = measure(S, T, f.R, vField(S, f.R));
    if (!Tcur) { r.why = "cur-profile-incomplete"; continue; }
    const bT = btT[tl.e], bU = btU[e];
    if (!bT || !bU) { r.why = "no-bottom-transmission"; continue; }
    const { K, level } = kBins(tl.prof, Tcur, bT, bU);
    const gain = Math.max(...K.map((p) => 1 - lum(p)));
    // V3b ile aynı: kare kapısı (FRAME_MIN_GAIN) iki haneye yuvarlanmış kazançla, cam kapısı ham kazançla
    r.gain = +gain.toFixed(2);
    r.level = +level.toFixed(3);
    r.K = K.map((p) => +lum(p).toFixed(2));
    if (gain < TINT.MIN_GAIN) { r.why = "template-not-darker"; continue; }
    plan.push({ e, f, K });
  }
  const maxGain = Math.max(0, ...stats.lenses.map((r) => r.gain || 0));
  if (!plan.length || maxGain < TINT.FRAME_MIN_GAIN) return no("template-not-darker:" + maxGain.toFixed(2), stats);
  let out = cur;
  for (const p of plan) { const t = tintLens(S, p.f, p.K, out); out = t.res; stats.lenses[p.e].px = t.px; }
  let frame = "off";
  if (FRAME_COL.ON) {
    const tf = tplFrameColour(tpl);
    const seg = mFix && tf.n >= FRAME_COL.MIN_N ? await require("./sunglassTransfer")._testables.glassesSeg(curBuf, W, H, mFix.mesh) : null;
    if (!mFix) frame = "no-ai-mesh";
    else if (tf.n < FRAME_COL.MIN_N) frame = "no-template-frame";
    else if (!seg) frame = "no-seg";
    else { const fr = frameShift(S, out, plan.map((p) => p.f.R), seg, tf); out = fr.res; frame = "ok"; stats.framePx = fr.px; stats.tplFrame = tf.med; }
  }
  stats.frame = frame;
  const outRgb = Buffer.from(curRgb);
  for (let y = 0; y < side; y++) out.copy(outRgb, ((top + y) * W + left) * 3, y * side * 3, (y + 1) * side * 3);
  return { rgb: outRgb, applied: true, reason: "applied:e" + plan.map((p) => p.e).join(",") + (frame === "ok" ? "+frame" : "+frame-" + frame), stats };
}

const pngOf = (rgb, W, H) => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
const errMsg = (e) => "error:" + ((e && e.message) || e);

/**
 * Gözlük bileşiminden sonraki iki yerel adım, tek çağrıda (işçi havuzunda
 * postTasks.eyewearOwnEye, havuzsuz eyewear.finish aynı işlevi çağırır):
 * kendi göz (eyewearOwnEye.js) → cam tonu (V3b). Her adım hata güvenli: hata
 * ya da kapı dışı → önceki görüntü aynen kalır. Döner { png (değiştiyse son
 * görüntü, yoksa null), rgb, ownEye: {applied, reason}, lensTint: {applied, reason} }.
 */
async function ownEyeThenTint({ preBuf, preRgb, fixBuf, fixRgb, W, H, rect, geom, tplBuf, ownEyeOn = true, lensTintOn = true }) {
  const ctx = {};
  let rgb = fixRgb, png = null;
  let ownEye = { applied: false, reason: "off" }, tint = { applied: false, reason: "off" };
  if (ownEyeOn) {
    try {
      const r = await require("./eyewearOwnEye").ownEyeThroughLens({ preBuf, preRgb, fixBuf, fixRgb, W, H, rect, geom, tplBuf, ctx });
      ownEye = { applied: !!(r.applied && r.rgb), reason: r.reason };
      if (ownEye.applied) { rgb = r.rgb; png = await pngOf(rgb, W, H); }
    } catch (e) {
      ownEye = { applied: false, reason: errMsg(e) };
    }
  }
  if (lensTintOn) {
    try {
      const t = await lensTint({ curRgb: rgb, curBuf: png || fixBuf, curIsFix: !png, preBuf, preRgb, fixBuf, tplBuf, W, H, rect, geom, ctx });
      tint = { applied: !!(t.applied && t.rgb), reason: t.reason };
      if (tint.applied) { rgb = t.rgb; png = await pngOf(rgb, W, H); }
    } catch (e) {
      tint = { applied: false, reason: errMsg(e) };
    }
  }
  return { png, rgb: png ? rgb : null, ownEye, lensTint: tint };
}

module.exports = {
  lensTint,
  ownEyeThenTint,
  _testables: { FIND, TINT, BOTTOM, FRAME_COL, findLens, vField, measure, bottomTrans, kBins, tintLens, tplFrameColour, frameShift, hull, noseDist },
};
