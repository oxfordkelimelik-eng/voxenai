// SELFIE IŞIĞINI EŞİTLEME (2026-11-03, kullanıcı: "selfiede kişi ışıkta,
// gölgede vs çekildiyse bu gereksiz ışığın yüzünden alınması lazım, düz bir
// teni olması lazım"). 8ee5afa0: Onur'un 4 selfie'si pencere önünde, güneş
// yüzün bir yanına vuruyor; model bu ışığı kopyaladı. Çıktı yüzünde soldan
// sağa log parlaklık eğimi 2.0-3.4 (base -1.3…0.9); aynalanan selfie'lerde
// işaret ters döndü (ışık selfie'den). Çıktıdaki yüz ışığı düzeltmesi
// (faceTone) en fazla 0.9 azaltıyordu.
//
// YÖNTEM: modele gitmeden önce selfie'de, yüz derisinin DÜŞÜK FREKANSLI
// aydınlatma alanı (kanal başına log doğrusal ışık, deri ağırlıklı kutu
// bulanıklığı, yarıçap yüz boyunun FIELD_R'si) derinin ortalamasına çekilir.
// Düzeltme deriden saça, sakala, kulağa ve boyna aynı yumuşak alanla yayılır;
// kafa dışında sıfıra iner. Burun, göz çukuru gibi küçük ölçekli yüz hatları
// ve doku olduğu gibi kalır; yalnız tek yandan vuran ışık, geniş gölge ve
// renk kayması (güneşli yan turuncu, gölge yanı mavi) kalkar.
const sharp = require("sharp");

// Aydınlatma alanı yarıçapı (yüz kutusu boyu oranı). Küçüldükçe yüz hatları
// (burun gölgesi) da düzleşir; büyüdükçe sert gölge kenarı kalır.
const FIELD_R = 0.12;
// Sapmanın kaldırılan payı (log alanda).
const STRENGTH = 0.85;
const GAIN_LOG_MIN = Math.log(0.55);
const GAIN_LOG_MAX = Math.log(2.2);
// Aydınlatma yayılımı (deri üzerinde p90−p10, log parlaklık) bundan azsa
// selfie zaten düz ışıklı: dokunulmaz.
const MIN_SPREAD = 0.12;
const MIN_SKIN_PX = 200;
// Kalan düzlem eğiminin kaldırılan payı ve u,v sınırı (yüz kutusu birimi).
const PLANE_STRENGTH = 0.85;
const UV_MAX = 0.75;
// YALNIZ SAĞ-SOL IŞIK (2026-11-19). Yeni 10'lu çekim tavan lambası altında:
// alın parlak, sakallı alt yüz koyu. Dikey düzeltme koyu sakalı gölge sanıp
// ~×2 açıyordu → selfie'de gri/tebeşir sakal ve çene, model bunu çiziyordu.
// 11-16 akşamından (yeni selfie seti) beri yüz onarımı 15 işte 1'den 4 işte
// 7'ye çıktı; bölgelerin çoğu "chin and jawline". Eşitlemenin amacı tek
// yandan vuran ışıktı (8ee5afa0); dikey bileşen satır ortalaması çıkarılarak
// atılır, sağ-sol fark ve renk kayması aynen düzeltilir. Kullanıcı kararı
// (11-18): "dikey ışığa gerek yok".
let HORIZONTAL_ONLY = true;

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const linToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const EPS = 2e-3;

/** Ağırlıklı yüzdelik (değer dizisi, ağırlık dizisi). SAF. */
function weightedQuantile(vals, ws, q) {
  const idx = [];
  for (let i = 0; i < vals.length; i++) if (ws[i] > 0) idx.push(i);
  if (!idx.length) return null;
  idx.sort((a, b) => vals[a] - vals[b]);
  let tot = 0;
  for (const i of idx) tot += ws[i];
  let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= q * tot) return vals[i]; }
  return vals[idx[idx.length - 1]];
}

/**
 * D'nin (W*H*3 log düzeltme) dikey bileşenini atar: her satırda deri ağırlıklı
 * ortalama (derisi az satırda en yakın derili satırınki) çıkarılır, satır
 * profili dikeyde yumuşatılır. Kafa alfasıyla ölçeklenir. SAF, yerinde.
 */
function removeVerticalComponent(D, ws, head, W, H, r) {
  const MIN_ROW_W = 3;
  for (let c = 0; c < 3; c++) {
    const m = new Float32Array(H), ok = new Uint8Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (ws[i] > 0.5 && head[i] > 0) { s += ws[i] * D[i * 3 + c] / head[i]; n += ws[i]; }
      }
      if (n >= MIN_ROW_W) { m[y] = s / n; ok[y] = 1; }
    }
    let first = -1, last = -1;
    for (let y = 0; y < H; y++) if (ok[y]) { if (first < 0) first = y; last = y; }
    if (first < 0) return;
    for (let y = 0; y < first; y++) m[y] = m[first];
    for (let y = last + 1; y < H; y++) m[y] = m[last];
    for (let y = first + 1; y < last; y++) if (!ok[y]) m[y] = m[y - 1];
    const R = Math.max(1, Math.round(r / 2)), sm = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R); k++) { s += m[k]; n++; }
      sm[y] = s / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (head[i]) D[i * 3 + c] -= head[i] * sm[y];
    }
  }
}

/**
 * Deri ağırlıklı aydınlatma alanı ve düzeltme (çalışma çözünürlüğü). SAF.
 * lin: W*H*3 doğrusal ışık, ws: deri ağırlığı, head: uygulama alfası.
 * Döner: { D (W*H*3 log düzeltme), spread, after } | null
 */
function planFlatten(lin, ws, head, W, H, r, { boxBlur }, box = null) {
  const N = W * H;
  let nSkin = 0;
  for (let i = 0; i < N; i++) if (ws[i] > 0.5) nSkin++;
  if (nSkin < MIN_SKIN_PX) return null;
  const wb = boxBlur(ws, W, H, r);
  const F = [0, 1, 2].map((c) => {
    const zw = new Float32Array(N);
    for (let i = 0; i < N; i++) zw[i] = ws[i] * Math.log(lin[i * 3 + c] + EPS);
    const b = boxBlur(zw, W, H, r);
    for (let i = 0; i < N; i++) b[i] = wb[i] > 0.02 ? b[i] / wb[i] : NaN;
    return b;
  });
  // Parlaklık alanı (yayılım ölçüsü) ve kanal hedefleri: deri üzerinde ağırlıklı ortalama.
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.2126 * F[0][i] + 0.7152 * F[1][i] + 0.0722 * F[2][i];
  const skinW = new Float32Array(N);
  for (let i = 0; i < N; i++) skinW[i] = ws[i] > 0.5 && Number.isFinite(lum[i]) ? ws[i] : 0;
  const p10 = weightedQuantile(lum, skinW, 0.1), p90 = weightedQuantile(lum, skinW, 0.9);
  if (p10 == null || p90 == null) return null;
  const spread = p90 - p10;
  const T = [0, 1, 2].map((c) => {
    let s = 0, n = 0;
    for (let i = 0; i < N; i++) if (skinW[i] > 0) { s += skinW[i] * F[c][i]; n += skinW[i]; }
    return s / n;
  });
  // Deride düzeltme; deri dışına (saç, sakal, kulak, boyun) normalize
  // bulanıklıkla yayılır. Kafa alfası dışında sıfır.
  const R2 = Math.max(2, Math.round(r * 2));
  const D = new Float32Array(N * 3);
  const dw = new Float32Array(N);
  for (let i = 0; i < N; i++) dw[i] = Number.isFinite(lum[i]) ? clamp(wb[i] / 0.3, 0, 1) : 0;
  const dwb = boxBlur(dw, W, H, R2);
  for (let c = 0; c < 3; c++) {
    const dv = new Float32Array(N);
    for (let i = 0; i < N; i++) dv[i] = dw[i] ? dw[i] * clamp(STRENGTH * (T[c] - F[c][i]), GAIN_LOG_MIN, GAIN_LOG_MAX) : 0;
    const ext = boxBlur(dv, W, H, R2);
    for (let i = 0; i < N; i++) {
      const own = dw[i] ? dv[i] / dw[i] : 0;
      const far = dwb[i] > 1e-3 ? ext[i] / dwb[i] : 0;
      D[i * 3 + c] = head[i] * (dw[i] * own + (1 - dw[i]) * far);
    }
  }
  // KALAN EĞİM (ikinci aşama): bulanık alan kenara doğru sapmayı eksik
  // ölçüyor (8ee5afa0 selfie 1: eğim 3.85 → yalnız alanla 1.90). Düzeltilmiş
  // deride log parlaklığa yüz kutusu düzlemi oturtulur, PLANE_STRENGTH'i
  // kafa alfasıyla kaldırılır (faceTone ile aynı u,v sınırı).
  if (box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const uv = (i) => {
      const x = i % W, y = (i - x) / W;
      return [clamp((x - cx) / box.width, -UV_MAX, UV_MAX), clamp((y - cy) / box.height, -UV_MAX, UV_MAX)];
    };
    let s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, t1 = 0, t2 = 0, t3 = 0;
    for (let i = 0; i < N; i++) {
      if (!(ws[i] > 0.5)) continue;
      const y = 0.2126 * lin[i * 3] * Math.exp(D[i * 3]) + 0.7152 * lin[i * 3 + 1] * Math.exp(D[i * 3 + 1]) + 0.0722 * lin[i * 3 + 2] * Math.exp(D[i * 3 + 2]);
      const z = Math.log(y + EPS), [u, v] = uv(i), w = ws[i];
      s11 += w * u * u; s12 += w * u * v; s13 += w * u; s22 += w * v * v; s23 += w * v; s33 += w;
      t1 += w * u * z; t2 += w * v * z; t3 += w * z;
    }
    const det = s11 * (s22 * s33 - s23 * s23) - s12 * (s12 * s33 - s23 * s13) + s13 * (s12 * s23 - s22 * s13);
    if (s33 > MIN_SKIN_PX && Math.abs(det) > 1e-9) {
      const gu = (t1 * (s22 * s33 - s23 * s23) - s12 * (t2 * s33 - s23 * t3) + s13 * (t2 * s23 - s22 * t3)) / det;
      const gv = (s11 * (t2 * s33 - s23 * t3) - t1 * (s12 * s33 - s23 * s13) + s13 * (s12 * t3 - t2 * s13)) / det;
      for (let i = 0; i < N; i++) {
        if (!head[i]) continue;
        const [u, v] = uv(i);
        const d = clamp(-PLANE_STRENGTH * (gu * u + gv * v), GAIN_LOG_MIN, GAIN_LOG_MAX) * head[i];
        D[i * 3] += d; D[i * 3 + 1] += d; D[i * 3 + 2] += d;
      }
    }
  }
  if (HORIZONTAL_ONLY) removeVerticalComponent(D, ws, head, W, H, r);
  // Uygulama sonrası yayılım (aynı alan üzerinden): deride F + D.
  const lumA = new Float32Array(N);
  for (let i = 0; i < N; i++) lumA[i] = 0.2126 * (F[0][i] + D[i * 3]) + 0.7152 * (F[1][i] + D[i * 3 + 1]) + 0.0722 * (F[2][i] + D[i * 3 + 2]);
  const a10 = weightedQuantile(lumA, skinW, 0.1), a90 = weightedQuantile(lumA, skinW, 0.9);
  return { D, spread, after: a90 - a10 };
}

/**
 * Selfie'nin yüzündeki tek yönlü ışığı/gölgeyi eşitler. EXIF döndürmesi
 * uygulanmış JPEG döner. Başarısızlıkta { buf: döndürülmüş orijinal, applied:false }.
 */
async function flattenSelfieLight(input) {
  const t0 = Date.now();
  const rot = await sharp(input).rotate().removeAlpha().jpeg({ quality: 95 }).toBuffer();
  try {
    const ft = require("./faceTone")._testables;
    const { data: rgb, info } = await sharp(rot).raw().toBuffer({ resolveWithObject: true });
    const FW = info.width, FH = info.height;
    const S = await ft.probsOf(rot, FW, FH);
    if (!S) return { buf: rot, applied: false, reason: "no-face", ms: Date.now() - t0 };
    const { P, CLASSES, W, H, box, work } = S;
    const N = W * H;
    const ws = new Float32Array(N), headS = new Float32Array(N);
    const chin = box.y + box.height * 1.1, neckEnd = box.y + box.height * 1.7;
    const x0 = box.x - box.width * 0.6, x1 = box.x + box.width * 1.6;
    for (let i = 0; i < N; i++) {
      const x = i % W, y = (i - x) / W;
      const fs = P[CLASSES.faceSkin][i], hr = P[CLASSES.hair][i], bs = P[CLASSES.bodySkin][i];
      if (y <= chin && P[CLASSES.others][i] < 0.3 && hr < 0.3) ws[i] = clamp((fs - 0.5) / 0.3, 0, 1);
      const nearHead = x >= x0 && x <= x1 && y <= neckEnd;
      headS[i] = nearHead ? clamp(Math.max(fs, hr, y <= neckEnd ? bs : 0) / 0.5, 0, 1) : 0;
    }
    const head = ft.soften(headS, W, H, 3);
    const lin = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) lin[i] = SRGB2LIN[work[i]];
    const r = Math.max(2, Math.round(FIELD_R * box.height));
    const plan = planFlatten(lin, ws, head, W, H, r, ft, box);
    if (!plan) return { buf: rot, applied: false, reason: "no-skin", ms: Date.now() - t0 };
    if (plan.spread < MIN_SPREAD) return { buf: rot, applied: false, reason: "already-even", spread: plan.spread, ms: Date.now() - t0 };
    const Dc = [0, 1, 2].map((c) => {
      const a = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = plan.D[i * 3 + c];
      return ft.upsample(a, W, H, FW, FH);
    });
    const out = Buffer.from(rgb);
    for (let i = 0; i < FW * FH; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Dc[c][i];
        if (d > -1e-3 && d < 1e-3) continue;
        out[i * 3 + c] = linToSrgb(SRGB2LIN[rgb[i * 3 + c]] * Math.exp(d));
      }
    }
    const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf, applied: true, reason: null, spread: plan.spread, after: plan.after, ms: Date.now() - t0 };
  } catch (e) {
    console.error("Selfie ışığı eşitlenemedi (orijinal gider):", e.message || e);
    return { buf: rot, applied: false, reason: "error", ms: Date.now() - t0 };
  }
}

module.exports = { flattenSelfieLight, _testables: { planFlatten, weightedQuantile, removeVerticalComponent, FIELD_R, STRENGTH, MIN_SPREAD, setHorizontalOnly: (v) => { HORIZONTAL_ONLY = v; } } };
