/**
 * Yüz L* ile gövde/kol ten L* farkı — teslim edilen parlak yüzler vs
 * kullanıcının "elenmemeli" dediği kareler ayrışıyor mu?
 */
const fs = require("fs");
const path = require("path");
const { detectMainFace } = require("../faceQuality");
const sharp = require("sharp");

const SKIN_WORK_MAX_DIM = 384;
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
function median(vals) {
  if (!vals.length) return null;
  const a = vals.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

const DIR = path.join(process.env.TEMP, "job-latest-review");
const FRAMES = [
  ["OK c0 golf (elenmeli)", "OK_chunk0.jpg"],
  ["OK c1 cafe (elenmeli)", "OK_chunk1.jpg"],
  ["OK c2 roma (elenmeli)", "OK_chunk2.jpg"],
  ["OK c7 iskele (elenmeli-bakış)", "OK_chunk7.jpg"],
  ["OK c3 (şikayet yok)", "OK_chunk3.jpg"],
  ["OK c4 (şikayet yok)", "OK_chunk4.jpg"],
  ["OK c6 (şikayet yok)", "OK_chunk6.jpg"],
  ["REJ c0a1 identity (kalmalı)", "REJ_c0a1_math-identity.jpg"],
  ["REJ c0a2 pulled (kalmalı)", "REJ_c0a2_yaw-pulled-to-camera.jpg"],
  ["REJ c5a1 pulled (kalmalı)", "REJ_c5a1_yaw-pulled-to-camera.jpg"],
  ["REJ c4a3 skin (kalmalı)", "REJ_c4a3_vision-skin.jpg"],
];

(async () => {
  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(label, "YOK"); continue; }
    const buf = fs.readFileSync(p);
    const face = await detectMainFace(buf);
    if (!face) { console.log(label, "yüz yok"); continue; }
    const meta = await sharp(buf).metadata();
    const scale = Math.min(1, SKIN_WORK_MAX_DIM / Math.max(meta.width, meta.height));
    const w = Math.round(meta.width * scale), h = Math.round(meta.height * scale);
    const { data } = await sharp(buf).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const s = scale;
    const fx0 = (face.box.x + face.box.width * 0.2) * s;
    const fx1 = (face.box.x + face.box.width * 0.8) * s;
    const fy0 = (face.box.y + face.box.height * 0.45) * s;
    const fy1 = (face.box.y + face.box.height * 0.80) * s;
    const faceLabs = [];
    const limbCands = [];
    const faceBottom = (face.box.y + face.box.height) * s;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        if (!isSkinLike(r, g, b)) continue;
        const lab = rgbToLab(r, g, b);
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) faceLabs.push(lab);
        else if (y > faceBottom + 8) limbCands.push(lab);
      }
    }
    const fa = median(faceLabs.map((v) => v[1]));
    const fb = median(faceLabs.map((v) => v[2]));
    const faceL = faceLabs.map((v) => v[0]);
    const limbL = limbCands
      .filter((v) => fa != null && Math.hypot(v[1] - fa, v[2] - fb) <= 8)
      .map((v) => v[0]);
    const f = median(faceL), l = median(limbL);
    const d = f != null && l != null ? f - l : null;
    console.log(
      label.padEnd(32),
      "yüzL=" + (f != null ? f.toFixed(1) : "null"),
      "kolL=" + (l != null ? l.toFixed(1) : "null"),
      "yüz-kol=" + (d != null ? (d >= 0 ? "+" : "") + d.toFixed(1) : "null"),
      "nYüz=" + faceL.length,
      "nKol=" + limbL.length
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
