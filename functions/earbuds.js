// KULAKLIK SİLME (2026-10-25, d0d4c001 c0/c4/c7, kullanıcı: "base foto
// kulaklıkla ya da selfieleri kulaklıkla çektiyse çıktılar kulaklıksız olacak").
//
// Prompt'un REMOVE kuralı kulaklığı ister (bkz. falPhotos P800); bu katman
// modelin kaçırdığı kulak içi kulaklığı teslimden önce siler. Açık kaynak,
// yerel, ücretsiz:
//  - TESPİT: OWLv2 (Apache-2.0, metinle sorgulanan nesne tespiti, bkz.
//    earbudCore.js). Yüz kırpımında "earbuds/earphones/..." sorguları.
//    9 karede ölçüldü: kulaklıklılar 0.70/0.71/0.30, kulaklıksızların en
//    yükseği 0.13 (yaka kartı ipi, kulakta değil).
//  - SİLME: LaMa (bkz. lamaFill.fillCrop) kutunun elipsini doldurur.
// Kabul: skor ≥ DETECT_MIN, kulaklık skoru "ear" skorundan yüksek, kutu küçük
// (kulak içi) ve kulak hizasında (çene noktalarının 0-3/13-16 yakınında).
// Kulak üstü büyük kulaklık burada silinmez (kafanın büyük kısmını yeniden
// çizmek gerekir) — onu prompt kaldırır.
//
// MODEL DOSYASI (155 MB) LaMa gibi Storage'da durur, örnek başına bir kez
// /tmp'ye iner ve SHA-256 ile doğrulanır; çıkarım ayrı tek worker'da.

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");

const EARBUD_GCS_PATH = "ml_models/owlv2_base_patch16_q.onnx";
const EARBUD_SHA256 = "af8d6a041e4114b06eafabb03047350c7b8f136670a3f8afc7e73c5a74c2b24b";
const DETECT_MIN = 0.2;
// Kutu kenarı yüz genişliğinin bu katından büyükse kulak içi kulaklık değil.
const MAX_BOX_FACE = 0.35;
// Kutu merkezi en yakın yan çene noktasına (0-3, 13-16) bu kadar (yüz
// genişliği) yakın olmalı.
const EAR_NEAR_FACE = 0.4;
// Yüz kırpımı: yüz kutusunun bu katı kare.
const CROP_FACE = 1.8;

let modelP = null;
function modelPath() {
  if (process.env.EARBUD_MODEL_PATH) return Promise.resolve(process.env.EARBUD_MODEL_PATH);
  if (!modelP) {
    modelP = (async () => {
      const dest = path.join(os.tmpdir(), "owlv2_base_patch16_q.onnx");
      if (fs.existsSync(dest)) return dest;
      const { bucket } = require("./_shared");
      // İş parçacığı kimliği de adda: ghostDetect.js aynı modeli son katman
      // worker'larından indirir (aynı pid, eşzamanlı indirme aynı dosyaya yazmasın).
      const part = `${dest}.${process.pid}.${require("worker_threads").threadId}.part`;
      await bucket().file(EARBUD_GCS_PATH).download({ destination: part });
      const hash = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        fs.createReadStream(part).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
      });
      const sum = hash.digest("hex");
      if (sum !== EARBUD_SHA256) {
        fs.rmSync(part, { force: true });
        throw new Error(`Kulaklık modeli doğrulanamadı (sha256 ${sum.slice(0, 12)})`);
      }
      fs.renameSync(part, dest);
      return dest;
    })();
    modelP.catch(() => { modelP = null; });
  }
  return modelP;
}

let worker = null;
const pending = new Map();
let nextId = 1;

function failAll(err) {
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  const { Worker } = require("worker_threads");
  const w = new Worker(path.join(__dirname, "earbudWorker.js"));
  w.unref();
  w.on("message", ({ id, ok, boxes, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(boxes || []);
    else p.reject(new Error(error));
  });
  const dead = (err) => {
    if (worker === w) worker = null;
    failAll(err instanceof Error ? err : new Error(`Kulaklık worker çıktı (${err})`));
  };
  w.on("error", dead);
  w.on("exit", (code) => dead(code));
  worker = w;
  return w;
}

async function detectRemote(rgb) {
  const mp = await modelPath();
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  getWorker().postMessage({ id, modelPath: mp, rgb });
  return p;
}

/**
 * Kulak hizasındaki kulaklık kutuları (görüntü pikselinde). SAF.
 * boxes: earbudCore çıktısı (kırpıma göre 0..1); crop: {left, top, side}.
 */
function pickEarbuds(boxes, crop, pts) {
  const { POS } = module.exports;
  const fw = Math.hypot(pts[16].x - pts[0].x, pts[16].y - pts[0].y);
  const sides = [0, 1, 2, 3, 13, 14, 15, 16].map((i) => pts[i]);
  const out = [];
  for (const b of boxes) {
    const pos = Math.max(...POS.map((q) => b.scores[q] || 0));
    if (pos < DETECT_MIN || pos <= (b.scores.ear || 0)) continue;
    const w = b.w * crop.side, h = b.h * crop.side;
    if (Math.max(w, h) > MAX_BOX_FACE * fw || Math.min(w, h) < 3) continue;
    const cx = crop.left + b.cx * crop.side, cy = crop.top + b.cy * crop.side;
    const near = Math.min(...sides.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    if (near > EAR_NEAR_FACE * fw) continue;
    // Aynı kulaklığın üst üste kutuları: en yüksek skorlu kalır.
    const dup = out.find((o) => Math.hypot(o.cx - cx, o.cy - cy) < 0.5 * Math.max(o.w, o.h, w, h));
    if (dup) { if (dup.score < pos) Object.assign(dup, { cx, cy, w, h, score: pos }); continue; }
    out.push({ cx, cy, w, h, score: pos });
  }
  return out;
}

/** Bulunan kulaklıkları LaMa ile siler. Döner { applied, buf, found, info }. */
async function removeEarbuds(buf) {
  const { faceLandmarks } = require("./faceQuality");
  const lm = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
  if (!lm) return { applied: false, buf: null, reason: "no-face", found: [] };
  const { width: W, height: H } = await sharp(buf).metadata();
  const b = lm.box;
  let side = Math.round(Math.max(b.width, b.height) * CROP_FACE);
  side = Math.min(side, W, H);
  const left = Math.max(0, Math.min(W - side, Math.round(b.x + b.width / 2 - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round(b.y + b.height / 2 - side / 2)));
  const { SIZE } = require("./earbudCore");
  const rgb = await sharp(buf).extract({ left, top, width: side, height: side }).removeAlpha()
    .resize(SIZE, SIZE, { fit: "fill", kernel: "cubic" }).raw().toBuffer();
  const boxes = await detectRemote(new Uint8Array(rgb));
  const found = pickEarbuds(boxes, { left, top, side }, lm.pts);
  if (!found.length) {
    const best = boxes.reduce((m, x) => Math.max(m, ...module.exports.POS.map((q) => x.scores[q] || 0)), 0);
    return { applied: false, buf: null, reason: "none", found, best };
  }
  const { fillCrop } = require("./lamaFill");
  const img = await sharp(buf).removeAlpha().raw().toBuffer();
  for (const e of found) {
    const rx = 0.75 * e.w + 2, ry = 0.75 * e.h + 2;
    let s = Math.max(64, Math.round(4 * Math.max(rx, ry)));
    s = Math.min(s, W, H);
    const x0 = Math.max(0, Math.min(W - s, Math.round(e.cx - s / 2)));
    const y0 = Math.max(0, Math.min(H - s, Math.round(e.cy - s / 2)));
    const crop = Buffer.alloc(s * s * 3);
    const mask = new Uint8Array(s * s);
    const alpha = new Float32Array(s * s);
    for (let y = 0; y < s; y++) {
      img.copy(crop, y * s * 3, ((y + y0) * W + x0) * 3, ((y + y0) * W + x0 + s) * 3);
      for (let x = 0; x < s; x++) {
        const r = Math.hypot((x + x0 - e.cx) / rx, (y + y0 - e.cy) / ry);
        if (r <= 1.15) mask[y * s + x] = 1;
        alpha[y * s + x] = r <= 0.85 ? 1 : r >= 1.15 ? 0 : (1.15 - r) / 0.3;
      }
    }
    const filled = await fillCrop(crop, s, mask);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const a = alpha[y * s + x];
        if (a <= 0) continue;
        const g = ((y + y0) * W + x0 + x) * 3, i = (y * s + x) * 3;
        for (let c = 0; c < 3; c++) img[g + c] = Math.round(img[g + c] + a * (filled.rgb[i + c] - img[g + c]));
      }
    }
  }
  const out = await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { applied: true, buf: out, reason: null, found };
}

module.exports = {
  removeEarbuds,
  pickEarbuds,
  modelPath, // ghostDetect.js aynı OWLv2 modelini kullanır
  POS: ["earbuds", "earphones", "headphones", "headset", "wireless earbuds"],
  EARBUD_GCS_PATH,
  EARBUD_SHA256,
};
