// DUDAK KIRMIZILIĞI SINIRI (2026-11-18, 156fa173 c7, kullanıcı: "dudaklar fazla
// kırmızı, ruj sürülmüş gibi"). Model bazı kişilerde dudağı yanaktan çok daha
// kırmızı çiziyor. Ölçü dudak a* − yanak a* (Lab, medyan): 39 şablonda medyan
// 0.8, en çok 8.1; çıktılarda 156fa173 c7 17.4, c6 13.6, c2 12.9, c8 12.2.
// Fark DA_MAX'ı aşarsa dudak a*'sı yalnız aşan kadar yanağa çekilir; parlaklık
// (L*), sarılık (b*) ve dudak şekli değişmez. Ten adımları (faceTone, skinTone)
// dudağa dokunmuyor — bu yüzden ayrı adım.
const sharp = require("sharp");

// DA_MAX 8 = 39 şablonun en yükseği (8.1): dudak gerçek fotoğraftakinden kırmızı olmaz.
// 39 karede (son 4 iş) 10'da 9 kare, 7'de c7/c8 hâlâ dudak renginde, iz yok.
const LIP = { ON: true, DA_MAX: 8, FEATHER_FACE: 0.025, MIN_LIP_PX: 40 };

const inPoly = (x, y, P) => {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i].y > y) !== (P[j].y > y) && x < ((P[j].x - P[i].x) * (y - P[i].y)) / (P[j].y - P[i].y) + P[i].x) c = !c;
  }
  return c;
};

/** Medyan. SAF. */
function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
}

/** Dudak a* kaydırması: fark sınırı aşarsa aşan kadar (negatif), yoksa 0. SAF. */
function planLipShift(lipA, cheekA, max = LIP.DA_MAX) {
  if (!Number.isFinite(lipA) || !Number.isFinite(cheekA)) return 0;
  const d = lipA - cheekA;
  return d > max ? -(d - max) : 0;
}

/** w×h kutu bulanıklığı (ayrılabilir, kenarda kırpılmış pencere), iki geçiş. SAF. */
function featherMask(m, w, h, r) {
  if (!(r >= 1)) return Float32Array.from(m);
  let cur = Float32Array.from(m);
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { s += cur[y * w + x + r]; n++; }
        if (x - r - 1 >= 0) { s -= cur[y * w + x - r - 1]; n--; }
        if (x >= 0) tmp[y * w + x] = s / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) { s += tmp[(y + r) * w + x]; n++; }
        if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; n--; }
        if (y >= 0) out[y * w + x] = s / n;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * buf → { buf (PNG) | null, applied, reason, lipA, cheekA, diff, shift, px, ms }.
 * lm: faceQuality.faceLandmarks sonucu (yoksa ölçülür).
 */
async function limitLipRedness(buf, { lm = null } = {}) {
  const t0 = Date.now();
  if (!LIP.ON) return { buf: null, applied: false, reason: "off" };
  const { rgbToLab, labToRgb } = require("./skinTone");
  if (!lm) lm = await require("./faceQuality").faceLandmarks(buf);
  if (!lm || !lm.pts || lm.pts.length < 68) return { buf: null, applied: false, reason: "no-face", ms: Date.now() - t0 };
  const pts = lm.pts.map((q) => ({ x: q.x ?? q._x, y: q.y ?? q._y }));
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const fw = Math.hypot(pts[16].x - pts[0].x, pts[16].y - pts[0].y);
  const outer = pts.slice(48, 60), inner = pts.slice(60, 68);
  const r = Math.max(1, Math.round(LIP.FEATHER_FACE * fw));
  const pad = 2 * r + 2;
  const x0 = Math.max(0, Math.floor(Math.min(...outer.map((p) => p.x))) - pad), x1 = Math.min(W - 1, Math.ceil(Math.max(...outer.map((p) => p.x))) + pad);
  const y0 = Math.max(0, Math.floor(Math.min(...outer.map((p) => p.y))) - pad), y1 = Math.min(H - 1, Math.ceil(Math.max(...outer.map((p) => p.y))) + pad);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4) return { buf: null, applied: false, reason: "tiny-mouth", ms: Date.now() - t0 };
  const lab = (x, y) => { const i = (y * W + x) * C; return rgbToLab(data[i], data[i + 1], data[i + 2]); };
  const hard = new Float32Array(bw * bh);
  const lipA = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (inPoly(x + 0.5, y + 0.5, outer) && !inPoly(x + 0.5, y + 0.5, inner)) {
      hard[(y - y0) * bw + (x - x0)] = 1;
      lipA.push(lab(x, y)[1]);
    }
  }
  if (lipA.length < LIP.MIN_LIP_PX) return { buf: null, applied: false, reason: "small-lips", px: lipA.length, ms: Date.now() - t0 };
  // Yanak: iki yanda çene hattı (1/15) ile burun kanadı (31/35) arası, sakal üstü.
  const cheekA = [];
  const cr = Math.max(2, Math.round(fw * 0.04));
  for (const [a, b] of [[pts[1], pts[31]], [pts[15], pts[35]]]) {
    const cx = Math.round(a.x * 0.4 + b.x * 0.6), cy = Math.round(a.y * 0.4 + b.y * 0.6);
    for (let y = cy - cr; y <= cy + cr; y++) for (let x = cx - cr; x <= cx + cr; x++) {
      if (x >= 0 && y >= 0 && x < W && y < H) cheekA.push(lab(x, y)[1]);
    }
  }
  const mL = median(lipA), mC = median(cheekA);
  const shift = planLipShift(mL, mC);
  const base = { lipA: mL, cheekA: mC, diff: mL != null && mC != null ? mL - mC : null, shift, px: lipA.length };
  if (!shift) return { buf: null, applied: false, reason: "within-limit", ...base, ms: Date.now() - t0 };
  // İçeride tam, yalnız dışa yumuşak: ince dudakta bulanıklık içi de söndürüyordu
  // (c7 17→13, hedef 10).
  const m = featherMask(hard, bw, bh, r);
  for (let i = 0; i < m.length; i++) if (hard[i]) m[i] = 1;
  const out = Buffer.from(data);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const w = m[(y - y0) * bw + (x - x0)];
    if (w < 0.01) continue;
    const i = (y * W + x) * C;
    const [L, A, B] = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const [rr, gg, bb] = labToRgb(L, A + shift * w, B);
    out[i] = rr; out[i + 1] = gg; out[i + 2] = bb;
  }
  const png = await sharp(out, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
  return { buf: png, applied: true, reason: null, ...base, ms: Date.now() - t0 };
}

module.exports = { limitLipRedness, _testables: { LIP, planLipShift, featherMask, median } };
