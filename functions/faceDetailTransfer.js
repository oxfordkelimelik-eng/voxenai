// SELFIE'DEN YÜZ DETAYI (2026-10-22, kullanıcı: "yüz netliği derken yüzdeki
// detayları göstermekten bahsediyorum"). Model yüzü pürüzsüz/ortalama çiziyor;
// netleştirme olmayan ayrıntıyı yaratamaz (Real-ESRGAN plastikleştirmişti).
// Kişinin açıca en yakın selfie'si çıktıdaki yüz boyuna küçültülür, 68 yüz
// noktasının üçgen ağıyla çıktı yüzüne bükülür ve YALNIZ ince parlaklık
// detayı (yüksek frekans) eklenir: sakal/kaş teli, cilt dokusu. Işık, renk ve
// yüz şekli çıktınınkidir.
//
// Denemeler (scratchpad det/dt.js, d44b63e8):
//  - Sınıf kapısı olmadan profilde selfie'nin arka planı yüz kenarına sızdı
//    (kontur hayaleti): pikseller iki tarafta da "yüz derisi" olmalı.
//  - Gözler hariç: bakış farkı hayalet göz yapar.
//  - Selfie'deki düz yama (bulanık kare, aşırı sıkıştırma) kenarıyla kare iz
//    bıraktı: ince detayı olmayan bölge kenarıyla dışlanır, değer ±2.5σ
//    kırpılır.
//  - Kazanç 1.0 hafif, 1.6 belirgin ve doğal.
// Çıktının bu ölçekteki detay enerjisi selfie'ninkinden düşük değil — etki
// hafiftir; asıl sınır çözünürlük (bkz. falPhotos hiResSize).

const sharp = require("sharp");

const GAIN = 1.6;
const SIGMA = 1.2;
// Selfie ile çıktının yön farkı (işaretli yaw) en çok bu kadar.
const MAX_YAW_DIFF = 0.35;
// Selfie'nin yüzü çıktınınkinden küçükse (büyütülmüş selfie detay taşımaz).
const MAX_UPSCALE = 1.1;
const MIN_FACE_H = 40;
const CLIP_SIGMA = 2.5;

const yawOf = (P) => {
  const span = P[45].x - P[36].x;
  return Math.abs(span) > 1e-6 ? ((P[30].x - P[36].x) / span - 0.5) * 2 : null;
};

// Alın noktaları: kaş noktaları yüzün dikey ekseni boyunca yukarı.
function withForehead(P) {
  const ux = P[27].x - P[8].x;
  const uy = P[27].y - P[8].y;
  const k = 0.22;
  return P.concat([17, 19, 21, 22, 24, 26].map((i) => ({ x: P[i].x + ux * k, y: P[i].y + uy * k })));
}

/** Bowyer-Watson Delaunay (az nokta). SAF. Döner: üçgen indeks üçlüleri. */
function delaunay(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const d = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) * 10;
  const P = pts.concat([{ x: minX - d, y: minY - d }, { x: minX + d * 2, y: minY - d }, { x: minX - d, y: minY + d * 2 }]);
  const n = pts.length;
  const circ = (t) => {
    const [a, b, c] = t.map((i) => P[i]);
    const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const A2 = a.x ** 2 + a.y ** 2;
    const B2 = b.x ** 2 + b.y ** 2;
    const C2 = c.x ** 2 + c.y ** 2;
    const ux = (A2 * (b.y - c.y) + B2 * (c.y - a.y) + C2 * (a.y - b.y)) / D;
    const uy = (A2 * (c.x - b.x) + B2 * (a.x - c.x) + C2 * (b.x - a.x)) / D;
    return { x: ux, y: uy, r2: (a.x - ux) ** 2 + (a.y - uy) ** 2 };
  };
  let tris = [[n, n + 1, n + 2]];
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad = [];
    const keep = [];
    for (const t of tris) {
      const c = circ(t);
      ((p.x - c.x) ** 2 + (p.y - c.y) ** 2 < c.r2 ? bad : keep).push(t);
    }
    const edges = new Map();
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, edges.has(key) ? null : [a, b]);
      }
    }
    tris = keep;
    for (const e of edges.values()) if (e) tris.push([e[0], e[1], i]);
  }
  return tris.filter((t) => t.every((i) => i < n));
}

async function lumOf(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const N = info.width * info.height;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  return { data, L, W: info.width, H: info.height };
}

// 0..255 aralığındaki alanın Gauss bulanığı (8 bit yuvarlama payı geri eklenir).
async function blurF(F, W, H, sigma) {
  const b = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) b[i] = Math.max(0, Math.min(255, Math.round(F[i])));
  // Tek kanal tuzağı (hafıza: sharp-mask-channel-trap) — extractChannel(0).
  const o = await sharp(b, { raw: { width: W, height: H, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
  const r = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) r[i] = o[i] + (F[i] - b[i]);
  return r;
}

// Yüz derisi olasılığı, yüz kutusunun çevresinde (tam kare, kesit dışı 0).
async function faceSkinMap(data, W, H, box) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const x0 = Math.max(0, Math.floor(box.x - 0.4 * box.width));
  const x1 = Math.min(W, Math.ceil(box.x + 1.4 * box.width));
  const y0 = Math.max(0, Math.floor(box.y - 0.5 * box.height));
  const y1 = Math.min(H, Math.ceil(box.y + 1.3 * box.height));
  const w = x1 - x0;
  const h = y1 - y0;
  const F = new Float32Array(W * H);
  if (w < 16 || h < 16) return F;
  const crop = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) data.copy(crop, y * w * 3, ((y + y0) * W + x0) * 3, ((y + y0) * W + x1) * 3);
  const P = await classProbs(crop, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) F[(y + y0) * W + x + x0] = P[CLASSES.faceSkin][y * w + x];
  return F;
}

const bilinear = (A, w, sx, sy) => {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  return (A[iy * w + ix] * (1 - fx) + A[iy * w + ix + 1] * fx) * (1 - fy) + (A[(iy + 1) * w + ix] * (1 - fx) + A[(iy + 1) * w + ix + 1] * fx) * fy;
};

/**
 * Selfie'lerin ince yüz detayını çıktı yüzüne ekler.
 * @returns {{applied: boolean, buf: Buffer|null, reason: string|null, ...}}
 */
async function transferSelfieDetail(outBuf, selfieBufs, { gain = GAIN, sigma = SIGMA } = {}) {
  const { faceLandmarks } = require("./faceQuality");
  const lo = (await faceLandmarks(outBuf)) || (await faceLandmarks(outBuf, 0.1));
  if (!lo) return { applied: false, buf: null, reason: "no-face-output" };
  const yo = yawOf(lo.pts);
  const fhO = Math.hypot(lo.pts[8].x - lo.pts[27].x, lo.pts[8].y - lo.pts[27].y);
  if (yo == null) return { applied: false, buf: null, reason: "no-yaw" };
  if (fhO < MIN_FACE_H) return { applied: false, buf: null, reason: "face-too-small", faceH: fhO };

  let best = null;
  for (let i = 0; i < (selfieBufs || []).length; i++) {
    try {
      const b = await sharp(selfieBufs[i]).rotate().jpeg({ quality: 97 }).toBuffer();
      const l = await faceLandmarks(b);
      const y = l ? yawOf(l.pts) : null;
      if (y == null) continue;
      if (!best || Math.abs(y - yo) < Math.abs(best.yaw - yo)) best = { i, b, l, yaw: y };
    } catch (e) {
      console.error(`Yüz detayı: selfie ${i} okunamadı (atlanıyor):`, e.message || e);
    }
  }
  if (!best) return { applied: false, buf: null, reason: "no-selfie-face", yawOut: yo };
  const info = { yawOut: yo, yawSelfie: best.yaw, selfieIdx: best.i, faceH: fhO };
  if (Math.abs(best.yaw - yo) > MAX_YAW_DIFF) return { applied: false, buf: null, reason: "no-matching-angle", ...info };
  const fhS = Math.hypot(best.l.pts[8].x - best.l.pts[27].x, best.l.pts[8].y - best.l.pts[27].y);
  const k = fhO / fhS;
  info.k = k;
  if (k > MAX_UPSCALE) return { applied: false, buf: null, reason: "selfie-too-small", ...info };

  // Selfie çıktının yüz ölçeğine.
  const sm = await sharp(best.b).metadata();
  const sw = Math.max(16, Math.round(sm.width * k));
  const sh = Math.max(16, Math.round(sm.height * k));
  const small = await sharp(best.b).resize(sw, sh, { fit: "fill", kernel: "lanczos3" }).toBuffer();
  const so = await lumOf(small);
  const sb = await blurF(so.L, sw, sh, sigma);
  const HPs = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) HPs[i] = so.L[i] - sb[i];
  const sbox = { x: best.l.box.x * k, y: best.l.box.y * k, width: best.l.box.width * k, height: best.l.box.height * k };
  const FSs = await faceSkinMap(so.data, sw, sh, sbox);
  // Ölü bölge: selfie'de ince detayı olmayan düz yama, kenarıyla.
  {
    const absHP = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) absHP[i] = Math.abs(HPs[i]) * 20;
    const en = await blurF(absHP, sw, sh, 2.5);
    const vals = [];
    for (let i = 0; i < sw * sh; i++) if (FSs[i] > 0.5) vals.push(en[i]);
    vals.sort((a, b) => a - b);
    const med = vals.length ? vals[vals.length >> 1] : 0;
    const dead = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) if (FSs[i] > 0.5 && en[i] < 0.3 * med) dead[i] = 255;
    const deadB = await blurF(dead, sw, sh, 3);
    let nd = 0;
    for (let i = 0; i < sw * sh; i++) if (deadB[i] > 8) { FSs[i] = 0; nd++; }
    info.deadPx = nd;
  }

  const o = await lumOf(outBuf);
  const { W, H } = o;
  const FSo = await faceSkinMap(o.data, W, H, lo.box);
  const Ps = withForehead(best.l.pts.map((p) => ({ x: p.x * k, y: p.y * k })));
  const Po = withForehead(lo.pts);
  const eyes = [[36, 41], [42, 47]].map(([a, b]) => {
    const q = lo.pts.slice(a, b + 1);
    const cx = q.reduce((t, p) => t + p.x, 0) / q.length;
    const cy = q.reduce((t, p) => t + p.y, 0) / q.length;
    const rx = Math.max(2, (Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x))) * 0.75);
    return { cx, cy, rx, ry: rx * 0.6 };
  });

  const D = new Float32Array(W * H);
  const M = new Float32Array(W * H);
  let flipped = 0;
  const tris = delaunay(Po);
  for (const t of tris) {
    const [a, b, c] = t.map((i) => Po[i]);
    const [A, B, C] = t.map((i) => Ps[i]);
    const areaO = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    const areaS = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    // Ters dönen ya da çok ezilen üçgen: o kısım selfie'de görünmüyor.
    if (Math.sign(areaO) !== Math.sign(areaS) || Math.abs(areaS) < 0.25 * Math.abs(areaO)) { flipped++; continue; }
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / den;
        const w2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / den;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        const sx = w1 * A.x + w2 * B.x + w3 * C.x;
        const sy = w1 * A.y + w2 * B.y + w3 * C.y;
        if (sx < 0 || sy < 0 || sx + 1 >= sw || sy + 1 >= sh) continue;
        const g = y * W + x;
        D[g] = bilinear(HPs, sw, sx, sy);
        let m = Math.max(0, Math.min(1, (Math.min(bilinear(FSs, sw, sx, sy), FSo[g]) - 0.3) / 0.4));
        for (const e of eyes) m = Math.min(m, Math.max(0, Math.min(1, (Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry) - 1) / 0.6)));
        M[g] = m;
      }
    }
  }
  info.flipped = flipped;
  const Mb = await blurF(M.map((v) => v * 255), W, H, Math.max(1.5, fhO * 0.04));
  // Selfie detayının ölçeği (kırpma için) ve iki tarafın enerjisi (log).
  const ob = await blurF(o.L, W, H, sigma);
  let es = 0;
  let eo = 0;
  let nn = 0;
  for (let g = 0; g < W * H; g++) {
    if (M[g] <= 0.9) continue;
    const hO = o.L[g] - ob[g];
    eo += hO * hO;
    es += D[g] * D[g];
    nn++;
  }
  if (nn < 200) return { applied: false, buf: null, reason: "too-few-skin-px", ...info, skinPx: nn };
  const sdS = Math.sqrt(es / nn);
  info.hfOut = Math.sqrt(eo / nn);
  info.hfSelfie = sdS;
  info.skinPx = nn;
  const out = Buffer.from(o.data);
  const lim = CLIP_SIGMA * sdS;
  for (let g = 0; g < W * H; g++) {
    if (!(M[g] > 0 || Mb[g] > 0)) continue;
    const m = Math.min(1, Mb[g] / 255);
    if (m <= 0.001) continue;
    const add = gain * m * Math.max(-lim, Math.min(lim, D[g]));
    for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.max(0, Math.min(255, Math.round(o.data[g * 3 + c] + add)));
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { applied: true, buf, reason: null, ...info };
}

module.exports = { transferSelfieDetail, _delaunay: delaunay, _withForehead: withForehead, MAX_YAW_DIFF };
