"use strict";
// FLAŞ FİLTRESİ (2026-11-22, kullanıcı: "prequelapp'in flash effect filtresini bizim filtreler kısmına
// ekleyebilir miyiz" → iki deneme reddedildi: "kişi hayalet gibi / yapıştırılmış gibi, çizgiler
// oluşmamalı hiçbir şekilde" → v3 kabul: "böyle iyi olmuş yeterli bunu ekleyelim").
//
// KENARSIZ TASARIM: kişi ayrı işlenmez. Kişiyi maskeyle kesip ayrı parlatmak/arka planı ayrı
// karartıp bulanıklaştırmak maske kenarında hale + çizgi + "yapıştırılmış" görünüm üretti (v1, v2).
// Burada tüm ayarlar YUMUŞAK ALANLARLA yapılır:
//   F  = ışık alanı: kişi maskesinin kişi boyunun ~%20'si kadar yumuşatılmışı (kenarı yok)
//   SH = flaş gölgesi: maskenin sağ-alta ötelenmişi, yumuşak yarı gölge; kişinin kendi üstüne düşmez
//        (sınır görüntünün gerçek kenarına guided filter ile oturtulur). Gölge YALNIZ arkadaki
//        yüzey kişiye yakınsa (derinlik farkı tek sayı olarak) görünür — uzak sokağa gölge sahte durur.
// Arka plan bulanıklaştırılmaz (referansta duvar dokusu keskin).
//
// Önizleme: düzenleyici F ve SH'yi küçük PNG olarak alır (opsPanel.opsFlashFields) ve flashPixels'in
// Dart kopyasını (lib/presentation/ops/photo_edits.dart applyFlash) uygular. İKİ TARAF EŞ TUTULMALI;
// altın değerler functions/test/flashEffect.test.js ve test/ops_photo_edits_test.dart.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const P = {
  FIELD_SIGMA: 0.2,   // ışık alanı yumuşaklığı (kişi boyu oranı)
  AMB: 0.3,           // ışık almayan yer bu kadar kalır (doğrusal)
  PEAK: 1.38,         // ışık merkezinde toplam
  FLAT: 0.14,         // ışık alanında gölgeleri doldurma
  SHADOW: 0.9, SH_DX: 0.035, SH_DY: 0.015, SH_SOFT: 0.012,
  TEAL: 0.035,        // koyu tonlarda camgöbeği-zeytin
  WARM: 0.02,         // ışık alanında sıcaklık
  CONTRAST: 1.12,
  VIGNETTE: 0.6,
  GRAIN: 0.03,
  DUST: 0.6,
};

const DEPTH_GCS_PATH = "ml_models/depth_anything_v2_small.onnx";
const DEPTH_SHA256 = "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c";

const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = c01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Saf piksel işlemi (Dart'ta birebir kopyası var). data RGB(A) yerinde; F ışık alanı (0..1),
 * SH gölge (0..1, gücü içinde); k yoğunluk 0..1; gray=true ise renk kaydırılmaz.
 */
function flashPixels(data, W, H, ch, F, SH, k, gray) {
  const colorK = gray ? 0 : k;
  const cx = (W - 1) / 2, cy = (H - 1) * 0.45, rd = Math.hypot(W / 2, H / 2);
  const rnd = mulberry32(12345);
  const KN = 0.72;
  // beyaz tavanı yoğunlukla ölçeklenir (k=0 → kare aynen kalır)
  const soft = (v) => (v <= KN ? v : v + k * (KN + (1 - KN) * (1 - Math.exp(-(v - KN) / (1 - KN))) - v));
  const amb = 1 - (1 - P.AMB) * k, fl = (P.PEAK - P.AMB) * k;
  const ck = 1 + (P.CONTRAST - 1) * k;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * ch;
    const f = F[i] * (1 - SH[i]);
    let r = s2l(data[o] / 255), g = s2l(data[o + 1] / 255), b = s2l(data[o + 2] / 255);
    const gm = 1 - P.FLAT * k * F[i];
    if (gm !== 1) { r = Math.pow(r, gm); g = Math.pow(g, gm); b = Math.pow(b, gm); }
    const gain = amb + fl * f - 0.35 * k * SH[i] * amb;
    r = l2s(soft(r * gain)); g = l2s(soft(g * gain)); b = l2s(soft(b * gain));
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const tl = P.TEAL * colorK * (1 - smoothstep(0.15, 0.75, l)) * (1 - 0.6 * f);
    const wm = P.WARM * colorK * f * smoothstep(0.2, 0.7, l);
    r += -tl + wm; g += tl * 0.45; b += tl * 0.15 - wm;
    r = (r - 0.5) * ck + 0.5; g = (g - 0.5) * ck + 0.5; b = (b - 0.5) * ck + 0.5;
    const vf = 1 - P.VIGNETTE * k * smoothstep(0.25, 1.05, Math.hypot(x - cx, y - cy) / rd);
    r *= vf; g *= vf; b *= vf;
    const lc = c01(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const nz = (rnd() + rnd() + rnd() - 1.5) * P.GRAIN * k * 1.4 * (4 * lc * (1 - lc) + 0.25);
    data[o] = Math.round(c01(r + nz) * 255);
    data[o + 1] = Math.round(c01(g + nz) * 255);
    data[o + 2] = Math.round(c01(b + nz) * 255);
  }
  if (P.DUST > 0 && k > 0) {
    const rr = mulberry32(0x9e3779b9), sc = Math.max(W, H) / 1536;
    const put = (px, py, a) => {
      px = Math.round(px); py = Math.round(py);
      if (px < 0 || py < 0 || px >= W || py >= H) return;
      const o = (py * W + px) * ch;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(data[o + c] + (225 - data[o + c]) * a);
    };
    const nd = Math.round(25 * P.DUST * k);
    for (let d = 0; d < nd; d++) {
      const x0 = rr() * W, y0 = rr() * H, rad = (0.6 + rr() * 1.4) * sc, a = 0.2 + rr() * 0.35;
      for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) {
        const dd = Math.hypot(xx, yy) / rad;
        if (dd <= 1) put(x0 + xx, y0 + yy, a * (1 - dd * dd));
      }
    }
    const nh = Math.round(4 * P.DUST * k);
    for (let h = 0; h < nh; h++) {
      let x0 = rr() * W, y0 = rr() * H, ang = rr() * 6.283;
      const len = (15 + rr() * 40) * sc, a = 0.15 + rr() * 0.2;
      for (let s = 0; s < len; s++) { ang += (rr() - 0.5) * 0.25; x0 += Math.cos(ang); y0 += Math.sin(ang); put(x0, y0, a); }
    }
  }
  return data;
}

// ---- alanlar (kişi maskesi + derinlik) ----

function boxMean(a, W, H, r) {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += a[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      o[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return o;
}
/** Guided filter (He 2010): maske kenarını görüntü kenarına oturtur. */
function guided(I, p, W, H, r, eps) {
  const n = W * H, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, W, H, r), mp = boxMean(p, W, H, r), mIp = boxMean(Ip, W, H, r), mII = boxMean(II, W, H, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], c = mIp[i] - mI[i] * mp[i]; a[i] = c / (v + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxMean(a, W, H, r), mb = boxMean(b, W, H, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}
/** Tek kanallı 0..1 alanı bulanıklaştırır (8 bit; sharp tek kanal tuzağına karşı extractChannel). */
async function blurF(a, W, H, sigma) {
  const u = Buffer.alloc(W * H);
  for (let i = 0; i < a.length; i++) u[i] = Math.round(c01(a[i]) * 255);
  const b = await sharp(u, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(0.3, sigma)).extractChannel(0).raw().toBuffer();
  if (b.length !== W * H) throw new Error("flash blurF: kanal sayısı beklenmedik");
  const o = new Float32Array(W * H);
  for (let i = 0; i < o.length; i++) o[i] = b[i] / 255;
  return o;
}

/** Kişi kutusunda maskeyi yeniden hesaplar (256 px model → kırpımda daha yüksek etkin çözünürlük). */
async function cropRefine(personMask, data, W, H, ch, M) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (M[y * W + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return M;
  const pw = (x1 - x0) * 0.12, ph = (y1 - y0) * 0.08;
  x0 = Math.max(0, Math.floor(x0 - pw)); x1 = Math.min(W - 1, Math.ceil(x1 + pw));
  y0 = Math.max(0, Math.floor(y0 - ph)); y1 = Math.min(H - 1, Math.ceil(y1 + ph));
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  if (cw * chh > 0.8 * W * H) return M;
  const crop = await sharp(data, { raw: { width: W, height: H, channels: ch } })
    .extract({ left: x0, top: y0, width: cw, height: chh }).removeAlpha().raw().toBuffer();
  const Mc = await personMask(crop, cw, chh);
  const out = Float32Array.from(M);
  const ramp = Math.max(4, Math.min(cw, chh) * 0.04);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    const t = c01(Math.min(x, y, cw - 1 - x, chh - 1 - y) / ramp);
    const j = (y + y0) * W + x + x0;
    out[j] = Mc[y * cw + x] * t + M[j] * (1 - t);
  }
  return out;
}

let _depthSess = null;
function depthModelPath() {
  if (process.env.DEPTH_MODEL_PATH) return Promise.resolve(process.env.DEPTH_MODEL_PATH);
  const dest = path.join(os.tmpdir(), "depth_anything_v2_small.onnx");
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  return (async () => {
    const { bucket } = require("./_shared");
    const part = `${dest}.${process.pid}.part`;
    await bucket().file(DEPTH_GCS_PATH).download({ destination: part });
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      fs.createReadStream(part).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
    });
    const sum = hash.digest("hex");
    if (sum !== DEPTH_SHA256) { fs.rmSync(part, { force: true }); throw new Error(`derinlik modeli doğrulanamadı (sha256 ${sum.slice(0, 12)})`); }
    fs.renameSync(part, dest);
    return dest;
  })();
}
function depthSession() {
  if (!_depthSess) {
    _depthSess = (async () => {
      const ort = require("onnxruntime-node");
      // ONNX bellek arenası kapalı (hafıza notu onnx-arena-memory).
      return { ort, sess: await ort.InferenceSession.create(await depthModelPath(), { enableCpuMemArena: false }) };
    })();
    _depthSess.catch(() => { _depthSess = null; });
  }
  return _depthSess;
}
/** Ters derinlik (büyük = yakın), 2..98 yüzdelikle 0..1, görüntü çözünürlüğünde. */
async function depthMap(rgb, W, H) {
  const { ort, sess } = await depthSession();
  const h = 518, w = Math.max(14, Math.round((518 * W) / H / 14) * 14);
  const small = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill", kernel: "cubic" }).raw().toBuffer();
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const t = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) t[c * w * h + i] = (small[i * 3 + c] / 255 - mean[c]) / std[c];
  const out = await sess.run({ pixel_values: new ort.Tensor("float32", t, [1, 3, h, w]) });
  const d = out.predicted_depth.data, dims = out.predicted_depth.dims;
  const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
  const sorted = Float32Array.from(d).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
  const u = Buffer.alloc(d.length);
  for (let i = 0; i < d.length; i++) u[i] = Math.round(c01((d[i] - lo) / (hi - lo || 1)) * 255);
  const big = await sharp(u, { raw: { width: ow, height: oh, channels: 1 } }).resize(W, H, { fit: "fill", kernel: "linear" }).extractChannel(0).raw().toBuffer();
  const D = new Float32Array(W * H);
  for (let i = 0; i < D.length; i++) D[i] = big[i] / 255;
  return D;
}

/**
 * Işık alanı F, gölge SH (gücü içinde), gri bayrağı. rgb 3 kanal ham.
 * Derinlik modeli yüklenemezse gölge kapanır, filtre yine çalışır.
 */
async function flashFields(rgb, W, H) {
  const { personMask } = require("./headScale");
  const N = W * H;
  const M0 = await personMask(rgb, W, H);
  const M = await cropRefine(personMask, rgb, W, H, 3, M0);
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (M[y * W + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const has = x1 > x0 && y1 > y0;
  const subjH = has ? y1 - y0 : H * 0.6;

  // IŞIK ALANI: maske × (üst gövde ağırlığı), küçük çözünürlükte büyük bulanıklık, kübik büyütme
  const F = new Float32Array(N);
  if (has) {
    const sc = Math.min(1, 512 / Math.max(W, H)), sw = Math.max(1, Math.round(W * sc)), sh = Math.max(1, Math.round(H * sc));
    const u = Buffer.alloc(N);
    for (let y = 0; y < H; y++) {
      const vw = 1 - 0.4 * smoothstep(y0 + 0.3 * subjH, y1 + 0.1 * subjH, y);
      for (let x = 0; x < W; x++) u[y * W + x] = Math.round(c01(M[y * W + x] * vw) * 255);
    }
    const small = await sharp(u, { raw: { width: W, height: H, channels: 1 } }).resize(sw, sh, { kernel: "linear" }).extractChannel(0).raw().toBuffer();
    const sf = new Float32Array(sw * sh);
    for (let i = 0; i < sf.length; i++) sf[i] = small[i] / 255;
    const bl = await blurF(sf, sw, sh, P.FIELD_SIGMA * subjH * sc);
    let mx = 0;
    for (let i = 0; i < bl.length; i++) if (bl[i] > mx) mx = bl[i];
    const nb = Buffer.alloc(sw * sh);
    for (let i = 0; i < nb.length; i++) nb[i] = Math.round(c01(bl[i] / (mx * 0.85 || 1)) * 255);
    const big = await sharp(nb, { raw: { width: sw, height: sh, channels: 1 } }).resize(W, H, { kernel: "cubic" }).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < N; i++) { const v = big[i] / 255; F[i] = v * v * (3 - 2 * v); }
  } else {
    const cx = W / 2, cy = H * 0.42, r = Math.min(W, H) * 0.45;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) F[y * W + x] = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }

  // GÖLGE: yalnız arka yüzey kişiye yakınsa
  const SH = new Float32Array(N);
  let shK = 0, depthErr = null;
  if (has) {
    let D = null;
    try { D = await depthMap(rgb, W, H); } catch (e) { depthErr = e.message || String(e); }
    if (D) {
      const ring = await blurF(M, W, H, subjH * 0.03);
      const vs = [], vr = [];
      for (let i = 0; i < N; i += 5) { if (M[i] > 0.85) vs.push(D[i]); else if (M[i] < 0.1 && ring[i] > 0.08) vr.push(D[i]); }
      const med = (a) => { a.sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
      const gap = vs.length && vr.length ? med(vs) - med(vr) : 1;
      shK = P.SHADOW * Math.exp(-Math.max(0, gap - 0.03) / 0.12);
    }
    if (shK > 0.03) {
      const dx = Math.round(subjH * P.SH_DX), dy = Math.round(subjH * P.SH_DY);
      const s0 = new Float32Array(N);
      for (let y = dy; y < H; y++) for (let x = dx; x < W; x++) s0[y * W + x] = M[(y - dy) * W + x - dx];
      const sb = await blurF(s0, W, H, subjH * P.SH_SOFT);
      const I = new Float32Array(N);
      for (let i = 0; i < N; i++) I[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
      const Mg = guided(I, M, W, H, Math.max(2, Math.round(W * 0.003)), 1e-4);
      for (let i = 0; i < N; i++) SH[i] = sb[i] * (1 - smoothstep(0.3, 0.8, Mg[i])) * shK;
    }
  }
  // siyah-beyaz kare: renk kaydırma yok
  let s = 0, n = 0;
  for (let i = 0; i < N; i += 7) {
    const o = i * 3, mx = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]), mn = Math.min(rgb[o], rgb[o + 1], rgb[o + 2]);
    s += mx > 0 ? (mx - mn) / mx : 0; n++;
  }
  return { F, SH, gray: s / n < 0.04, shK, hasPerson: has, depthErr };
}

/** Asıl kareye flaşı uygular (k 0..1). Kayıpsız PNG döner (sonraki adımlar JPEG'e çevirir). */
async function applyFlash(buf, k) {
  const { data, info } = await sharp(buf).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("flash: 3 kanal bekleniyordu");
  const W = info.width, H = info.height;
  const f = await flashFields(data, W, H);
  flashPixels(data, W, H, 3, f.F, f.SH, c01(k), f.gray);
  const png = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf: png, shK: f.shK, hasPerson: f.hasPerson, depthErr: f.depthErr };
}

/** Önizleme alanları: uzun kenarı maxSide olan PNG (R = ışık alanı, G = gölge) + gri bayrağı. */
async function flashPreviewFields(buf, maxSide = 512) {
  // alanlar ölçekten bağımsız (kişi boyuna göre) → hız için ≤1024'te hesapla
  const img = sharp(buf).rotate().removeAlpha().toColourspace("srgb").resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const f = await flashFields(data, W, H);
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = Math.round(c01(f.F[i]) * 255); rgb[i * 3 + 1] = Math.round(c01(f.SH[i]) * 255); }
  const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize({ width: maxSide, height: maxSide, fit: "inside", kernel: "linear" }).png().toBuffer({ resolveWithObject: true });
  return { png: png.data, width: png.info.width, height: png.info.height, gray: f.gray, shK: f.shK, depthErr: f.depthErr };
}

module.exports = {
  P, flashPixels, flashFields, applyFlash, flashPreviewFields, DEPTH_GCS_PATH, DEPTH_SHA256,
  _testables: { mulberry32, guided, smoothstep },
};
