/**
 * ŞABLONSUZ (yüz-göreli) kroma düzeltmesi için KALİBRASYON PROBU.
 *
 * Soru: "uzuv ↔ çıktının kendi yüzü" farkına göre seçim yaparsak, gerçek
 * kol/el bileşenleriyle ten-benzeri ARKA PLAN (kum, ahşap, bej duvar)
 * birbirinden ayrılıyor mu? Ayrılmazsa düzeltme arka planı boyar — bu
 * kareyi elemekten daha kötüdür, o yüzden eşik veriyle seçilmeli.
 *
 * Kullanım: node scripts/probeFaceRelativeChroma.js
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { detectMainFace } = require("../faceQuality");

// --- faceQuality.js'teki yardımcıların birebir kopyaları (private olduklarından) ---
const SKIN_WORK_MAX_DIM = 384;
const LAB_L_WEIGHT = 0.6;
const CLOSE_RADIUS = 3;
const MIN_COMPONENT_PX = 60;

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
function medianLab(samples) {
  if (samples.length === 0) return null;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const col = samples.map((s) => s[c]).sort((a, b) => a - b);
    out.push(col[Math.floor(col.length / 2)]);
  }
  return out;
}
function labDistance(p, q) {
  const dl = (p[0] - q[0]) * LAB_L_WEIGHT;
  const da = p[1] - q[1];
  const db = p[2] - q[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}
function chromaDistance(p, q) {
  const da = p[1] - q[1], db = p[2] - q[2];
  return Math.sqrt(da * da + db * db);
}
function medianOf(values) {
  if (values.length === 0) return null;
  const a = Float64Array.from(values).sort();
  return a[Math.floor(a.length / 2)];
}
function boxMorph(src, W, H, r, dilate) {
  const hit = dilate ? 1 : 0;
  const tmp = new Uint8Array(W * H), dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= W) continue;
        if (src[y * W + xx] === hit) { v = hit; break; }
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= H) continue;
        if (tmp[yy * W + x] === hit) { v = hit; break; }
      }
      dst[y * W + x] = v;
    }
  }
  return dst;
}
async function rawPixels(buf) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, SKIN_WORK_MAX_DIM / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  const { data } = await sharp(buf)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width, height, scale };
}
function sampleFaceTone(px, box) {
  const s = px.scale;
  const x0 = Math.max(0, Math.floor((box.x + box.width * 0.20) * s));
  const x1 = Math.min(px.width, Math.ceil((box.x + box.width * 0.80) * s));
  const y0 = Math.max(0, Math.floor((box.y + box.height * 0.45) * s));
  const y1 = Math.min(px.height, Math.ceil((box.y + box.height * 0.80) * s));
  const samples = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * px.width + x) * 3;
      const r = px.data[o], g = px.data[o + 1], b = px.data[o + 2];
      if (isSkinLike(r, g, b)) samples.push(rgbToLab(r, g, b));
    }
  }
  return medianLab(samples);
}
// --- kopya sonu ---

const DIR = path.join(process.env.TEMP, "job-2286-frames");
const FRAMES = [
  ["chunk0  wellness / hayalet el", "OK_chunk0.jpg"],
  ["chunk1  kahverengi takım / silik el", "OK_elegance_1_0.jpg"],
  ["chunk4  eller cepte / kol kırmızı", "OK_elegance_4_0.jpg"],
  ["chunk3  teslim (kıyas)", "OK_chunk3.jpg"],
  ["chunk7  yat (kıyas)", "OK_chunk7.jpg"],
  ["chunk8  kask (kıyas)", "OK_chunk8.jpg"],
];

(async () => {
  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);
    const face = await detectMainFace(buf);
    const px = await rawPixels(buf);
    if (!face || !px) { console.log(`\n${label}: yüz/piksel yok`); continue; }
    const faceTone = sampleFaceTone(px, face.box);
    if (!faceTone) { console.log(`\n${label}: yüz tonu yok`); continue; }

    const W = px.width, H = px.height, N = W * H;
    const s = px.scale;
    const fx0 = face.box.x * s, fx1 = (face.box.x + face.box.width) * s;
    const fy0 = face.box.y * s, fy1 = (face.box.y + face.box.height) * s;

    const skin = new Uint8Array(N);
    const labA = new Float32Array(N), labB = new Float32Array(N), labL = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue;
        const i = y * W + x, o = i * 3;
        const r = px.data[o], g = px.data[o + 1], b = px.data[o + 2];
        if (!isSkinLike(r, g, b)) continue;
        skin[i] = 1;
        const lab = rgbToLab(r, g, b);
        labL[i] = lab[0]; labA[i] = lab[1]; labB[i] = lab[2];
      }
    }
    const closed = boxMorph(boxMorph(skin, W, H, CLOSE_RADIUS, true), W, H, CLOSE_RADIUS, false);

    const label2 = new Int32Array(N).fill(-1);
    const comps = [];
    const stack = [];
    for (let start = 0; start < N; start++) {
      if (!closed[start] || label2[start] !== -1) continue;
      label2[start] = start;
      stack.length = 0; stack.push(start);
      const members = [];
      let minX = W, maxX = 0, minY = H, maxY = 0;
      while (stack.length) {
        const i = stack.pop();
        members.push(i);
        const x = i % W, y = (i / W) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
            const j = yy * W + xx;
            if (closed[j] && label2[j] === -1) { label2[j] = start; stack.push(j); }
          }
        }
      }
      if (members.length < MIN_COMPONENT_PX) continue;
      const onlySkin = members.filter((i) => skin[i]);
      if (onlySkin.length < 20) continue;
      const compTone = [
        medianOf(onlySkin.map((i) => labL[i])),
        medianOf(onlySkin.map((i) => labA[i])),
        medianOf(onlySkin.map((i) => labB[i])),
      ];
      comps.push({
        px: members.length,
        areaRatio: members.length / N,
        chroma: chromaDistance(compTone, faceTone),
        lab: labDistance(compTone, faceTone),
        cx: ((minX + maxX) / 2 / W).toFixed(2),
        cy: ((minY + maxY) / 2 / H).toFixed(2),
      });
    }
    comps.sort((a, b) => b.px - a.px);
    console.log(`\n${label}   yüzTonu L=${faceTone[0].toFixed(1)} a=${faceTone[1].toFixed(1)} b=${faceTone[2].toFixed(1)}`);
    console.log("   px     alan%   krom↔yüz  lab↔yüz  merkez(x,y)");
    for (const c of comps.slice(0, 8)) {
      console.log(
        `  ${String(c.px).padStart(6)}  ${(c.areaRatio * 100).toFixed(1).padStart(5)}  ` +
        `${c.chroma.toFixed(1).padStart(8)}  ${c.lab.toFixed(1).padStart(7)}   (${c.cx}, ${c.cy})`
      );
    }
    if (!comps.length) console.log("  (uzuv bileşeni yok)");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
