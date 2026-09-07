/**
 * KUTU İÇİ MASKE probu — yarıçap taraması.
 *
 * Konum çözüldü (kırpma + ızgara, altı karenin altısı doğru), ama kutu İÇİNDE
 * "hangi piksel ten" kararı hâlâ YCbCr kuralında ve o kural krem duvarı da ten
 * sayıyor: chunk 0'ın bölgesinde 54.991 "ten" pikseli çıktı, çoğu duvar.
 *
 * Bu prob alternatifi ölçer: pikseli, ÇIKTININ KENDİ YÜZ TONUNA Lab
 * yakınlığına göre seçmek. Vision çağrısı yapılmaz — kutular önceki koşudan
 * sabitlendi, böylece yarıçap ucuzca taranabilir.
 *
 * Kullanım: node scripts/probeMaskRadius.js
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { detectMainFace } = require("../faceQuality");
const { cellsToCropBoxes, cropBoxToFrame } = require("../limbBox");

const LAB_L_WEIGHT = 0.6;
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function isSkinLike(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}
function labDistance(p, q) {
  const dl = (p[0] - q[0]) * LAB_L_WEIGHT;
  return Math.sqrt(dl * dl + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
}
function medianLab(samples) {
  if (!samples.length) return null;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const col = samples.map((s) => s[c]).sort((a, b) => a - b);
    out.push(col[Math.floor(col.length / 2)]);
  }
  return out;
}

const RADII = [10, 14, 18, 24];
const DIR = path.join(process.env.TEMP, "job-2286-frames");

// Önceki koşudan sabitlenen konumlar (Vision çağrısını tekrarlamamak için).
const CASES = [
  ["chunk0  hayalet el   (SIKAYETLI)", "OK_chunk0.jpg", [25, 31, 32], { x: 0.20, y: 0.16, w: 0.51, h: 0.84 }],
  ["chunk1  silik el     (SIKAYETLI)", "OK_elegance_1_0.jpg", [25, 32], { x: 0.34, y: 0.25, w: 0.42, h: 0.75 }],
  ["chunk4  kol tonu     (SIKAYETLI)", "OK_elegance_4_0.jpg", [38, 44, 48], { x: 0.28, y: 0.32, w: 0.55, h: 0.68 }],
  ["chunk3  teslim       (temiz)", "OK_chunk3.jpg", [41, 42, 47], { x: 0, y: 0, w: 1, h: 1 }],
  ["chunk7  yat          (temiz)", "OK_chunk7.jpg", [21, 27, 28, 40], { x: 0.25, y: 0.29, w: 0.69, h: 0.71 }],
  ["chunk8  kask         (temiz)", "OK_chunk8.jpg", [29, 30, 34], { x: 0.21, y: 0.21, w: 0.47, h: 0.63 }],
];

async function regionStats(buf, boxPx, faceTone, radius) {
  const rect = {
    left: Math.max(0, Math.round(boxPx.x)),
    top: Math.max(0, Math.round(boxPx.y)),
    width: Math.max(1, Math.round(boxPx.width)),
    height: Math.max(1, Math.round(boxPx.height)),
  };
  const [rgb, lap] = await Promise.all([
    sharp(buf).extract(rect).removeAlpha().raw().toBuffer(),
    sharp(buf).extract(rect).grayscale()
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
      .raw().toBuffer(),
  ]);
  const idx = [];
  const labs = [];
  for (let i = 0; i < lap.length; i++) {
    const o = i * 3;
    const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
    if (!isSkinLike(r, g, b)) continue;
    const lab = rgbToLab(r, g, b);
    if (radius != null && labDistance(lab, faceTone) > radius) continue;
    idx.push(i);
    labs.push(lab);
  }
  if (idx.length < 200) return { count: idx.length, variance: null, tone: null };
  let mean = 0;
  for (const i of idx) mean += lap[i];
  mean /= idx.length;
  let v = 0;
  for (const i of idx) v += (lap[i] - mean) ** 2;
  return { count: idx.length, variance: v / idx.length, tone: medianLab(labs) };
}

(async () => {
  for (const [label, file, cells, crop] of CASES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);
    const meta = await sharp(buf).metadata();
    const face = await detectMainFace(buf);
    if (!face) { console.log(`\n${label}: yuz yok`); continue; }

    const band = {
      x: (face.box.x + face.box.width * 0.20),
      y: (face.box.y + face.box.height * 0.45),
      width: face.box.width * 0.60,
      height: face.box.height * 0.35,
    };
    // Yüz tonu, yarıçap filtresi OLMADAN aynı yanak bandından.
    const faceStats0 = await regionStats(buf, band, [0, 0, 0], null);
    const faceTone = faceStats0.tone;
    if (!faceTone) { console.log(`\n${label}: yuz tonu olculemedi`); continue; }

    const boxes = cellsToCropBoxes(cells)
      .map((b) => cropBoxToFrame(b, crop))
      .map((b) => ({ x: b.x * meta.width, y: b.y * meta.height, width: b.w * meta.width, height: b.h * meta.height }));

    console.log(`\n${label}   yuzTonu L=${faceTone[0].toFixed(1)} a=${faceTone[1].toFixed(1)} b=${faceTone[2].toFixed(1)}`);
    for (const radius of RADII) {
      const faceStats = await regionStats(buf, band, faceTone, radius);
      const parts = [];
      for (const bp of boxes) {
        const s = await regionStats(buf, bp, faceTone, radius);
        if (s.variance == null || !faceStats.variance) { parts.push(`px=${s.count} oran=null`); continue; }
        const dl = Math.abs(s.tone[0] - faceTone[0]);
        const dc = Math.hypot(s.tone[1] - faceTone[1], s.tone[2] - faceTone[2]);
        parts.push(
          `px=${String(s.count).padStart(6)} oran=${(s.variance / faceStats.variance).toFixed(2).padStart(6)} ` +
          `dL=${dl.toFixed(1)} dKroma=${dc.toFixed(1)}`
        );
      }
      console.log(`  yaricap=${String(radius).padStart(2)}  yuzPx=${String(faceStats.count).padStart(5)}  ` + parts.join("  |  "));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
