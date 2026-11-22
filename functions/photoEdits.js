"use strict";
// FOTO DÜZENLEYİCİ (2026-11-22, kullanıcı: "çıktıları onayladığımız ekranda instagramdaki gibi farklı
// filtreler ekle ... ışık açma kapama, sürükleme tarzında ton değiştiriciler ... onay ekranında
// fotoğrafların üstüne tıklayıp bunları değiştirebilelim").
//
// Onay ekranındaki düzenleyici (lib/presentation/ops/photo_edits.dart) önizlemeyi AYNI matematikle
// cihazda yapar; kaydedince opsPanel.opsApplyEdits bu dosyayla asıl kareyi tam çözünürlükte üretir.
// İKİ TARAF EŞ TUTULMALI: PRESETS, ADJ ve renderPixels'teki formüller Dart'ta birebir var.
//
// Sıra: [ışıklı (faceGlow elle, 0.6)] → [flaş (flashEffect, kişi ışık alanı + gölge)] → ton eğrisi (kanal başına LUT: pozlama, parlaklık, kontrast,
// vurgular, gölgeler, soldurma) → renk (doygunluk, sıcaklık, ton) → vinyet → keskinlik → JPEG.

const sharp = require("sharp");

// Ayar aralıkları. [min, max]; varsayılan 0.
const ADJ = {
  exposure: [-100, 100],
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  warmth: [-100, 100],
  tint: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  fade: [0, 100],
  vignette: [0, 100],
  sharpen: [0, 100],
};

// Hazır filtreler: ayar demetleri, yoğunlukla (0-100) ölçeklenir, kullanıcı ayarları üstüne eklenir.
const PRESETS = {
  canli: { contrast: 22, saturation: 25, highlights: 8, warmth: -6 },
  sicak: { warmth: 28, saturation: 12, contrast: 8, tint: 4 },
  aydinlik: { brightness: 18, shadows: 22, saturation: -8, warmth: -4 },
  soluk: { fade: 35, contrast: -15, saturation: -12, warmth: 6 },
  vintage: { warmth: 24, fade: 18, contrast: 6, brightness: 6, tint: 6 },
  mat: { fade: 22, contrast: -10, saturation: -15, highlights: -10 },
  serin: { warmth: -25, tint: -4, contrast: 10, saturation: -5 },
  altin: { warmth: 35, exposure: 10, saturation: 10, shadows: 15 },
  sinematik: { contrast: 20, saturation: -12, tint: -6, warmth: -10, vignette: 30, fade: 10 },
  dramatik: { contrast: 35, shadows: -15, highlights: -10, saturation: -8, vignette: 35 },
  sb: { saturation: -100 },
  sb_kontrast: { saturation: -100, contrast: 30, fade: 8 },
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clampTo = (v, [lo, hi]) => (v < lo ? lo : v > hi ? hi : v);

/** İstemciden gelen düzenlemeyi doğrular. Etkisizse null (asıl kareye dönülür). */
function normalizeEdits(e) {
  if (!e || typeof e !== "object") return null;
  const preset = typeof e.preset === "string" && PRESETS[e.preset] ? e.preset : null;
  const intensity = preset ? clampTo(e.intensity == null ? 100 : num(e.intensity), [0, 100]) : 100;
  const adj = {};
  const src = e.adj && typeof e.adj === "object" ? e.adj : {};
  for (const k of Object.keys(ADJ)) {
    const v = Math.round(clampTo(num(src[k]), ADJ[k]));
    if (v !== 0) adj[k] = v;
  }
  const glow = e.glow === true;
  // FLAŞ (flashEffect.js): 0 kapalı, 1..100 yoğunluk. Renk filtresiyle birlikte kullanılabilir.
  const flash = Math.round(clampTo(num(e.flash), [0, 100]));
  if (!preset && !glow && !flash && Object.keys(adj).length === 0) return null;
  return { preset, intensity, adj, glow, flash };
}

/** Hazır filtre × yoğunluk + kullanıcı ayarları → son parametreler (sınırlı). */
function combine(e) {
  const p = {};
  const pr = e && e.preset ? PRESETS[e.preset] : null;
  const k = e && e.preset ? (e.intensity == null ? 100 : e.intensity) / 100 : 0;
  for (const key of Object.keys(ADJ)) {
    const v = (pr ? num(pr[key]) * k : 0) + num(e && e.adj ? e.adj[key] : 0);
    p[key] = clampTo(v, ADJ[key]);
  }
  return p;
}

const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = c01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Kanal başına ton eğrisi (256 giriş → 0..1). */
function toneLut(p) {
  const lut = new Float32Array(256);
  const ev = Math.pow(2, p.exposure / 100);
  const gamma = Math.pow(2, -p.brightness / 100);
  const ck = Math.pow(2, p.contrast / 100);
  for (let i = 0; i < 256; i++) {
    let x = i / 255;
    if (p.exposure !== 0) x = c01(l2s(Math.min(1, s2l(x) * ev)));
    if (p.brightness !== 0) x = Math.pow(x, gamma);
    if (p.contrast !== 0) x = c01((x - 0.5) * ck + 0.5);
    if (p.highlights !== 0) x = c01(x + (p.highlights / 100) * 0.2 * smoothstep(0.5, 1, x));
    if (p.shadows !== 0) x = c01(x + (p.shadows / 100) * 0.2 * (1 - smoothstep(0, 0.5, x)));
    if (p.fade !== 0) x = c01(x * (1 - (p.fade / 100) * 0.25) + (p.fade / 100) * 0.12);
    lut[i] = x;
  }
  return lut;
}

/** RGB(A) ham piksellere ton + renk + vinyet uygular (yerinde). channels 3 ya da 4. SAF. */
function renderPixels(data, W, H, channels, p) {
  const lut = toneLut(p);
  const sat = 1 + p.saturation / 100;
  const warm = (p.warmth / 100) * 0.08;
  const tint = p.tint / 100;
  const vig = p.vignette / 100;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, rd = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * channels;
      let r = lut[data[o]], g = lut[data[o + 1]], b = lut[data[o + 2]];
      if (sat !== 1) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      if (warm !== 0) { r += warm; b -= warm; }
      if (tint !== 0) { g -= tint * 0.06; r += tint * 0.02; b += tint * 0.02; }
      if (vig > 0) {
        const f = 1 - vig * 0.6 * smoothstep(0.35, 1, Math.hypot(x - cx, y - cy) / rd);
        r *= f; g *= f; b *= f;
      }
      data[o] = Math.round(c01(r) * 255);
      data[o + 1] = Math.round(c01(g) * 255);
      data[o + 2] = Math.round(c01(b) * 255);
    }
  }
  return data;
}

/** Asıl kareye düzenlemeyi uygular; JPEG döner. e normalizeEdits çıktısı olmalı. */
async function renderEdits(buf, e) {
  let src = buf;
  if (e.glow) {
    const gl = await require("./faceGlow").applyManualGlow(src);
    if (gl.applied && gl.buf) src = Buffer.from(gl.buf);
  }
  if (e.flash > 0) {
    const fx = await require("./flashEffect").applyFlash(src, e.flash / 100);
    if (fx.depthErr) console.warn(`FLAŞ: derinlik yok, gölgesiz uygulandı (${fx.depthErr})`);
    src = fx.buf;
  }
  const p = combine(e);
  const { data, info } = await sharp(src).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  renderPixels(data, info.width, info.height, info.channels, p);
  let img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  if (p.sharpen > 0) img = img.sharpen({ sigma: 1, m1: 0.5, m2: (p.sharpen / 100) * 2.5 });
  const png = await img.png().toBuffer();
  return require("./postProcess").addPhoneCameraTexture(png);
}

module.exports = { ADJ, PRESETS, normalizeEdits, combine, toneLut, renderPixels, renderEdits };
