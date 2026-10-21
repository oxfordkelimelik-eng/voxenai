// YEREL DOLGU MODELİ — LaMa (2026-10-12, iş e0eb8dd5, kullanıcı: "kafa
// küçültünce yaşanan olaylara kesin bir çözüm bulalım").
//
// SORUN: kafa çevresi ve küçültme deliği OpenAI maskeli düzenlemesiyle
// dolduruluyordu. Model kırpımın TAMAMINI yeniden çiziyor: renk/doku kayması
// kayma/kenar kapısını aşınca dolgu reddedildi ve kafa küçültülmedi (c4, c8;
// aynı işte c2/c5/c6 temizliği de); kapıdan geçenlerde eski kafanın sınırında
// açık yay (c1), saçın boyanması (c7), modelin kişi çizdiği yerde bulanık blok
// kaldı. Eşik gevşetmek denendi: c8'in kabul edilen hâli koyu tırtıklı çizgi
// ve lekeler taşıyordu.
//
// ÇÖZÜM: LaMa (Apache-2.0, big-lama, ONNX) yalnızca maskeyi doldurmak için
// eğitilmiş bir model — maske dışını değiştirmez, kişi çizmez, düz/yapılı
// arka planı (tavan çizgisi, bokeh) sürdürür. Fonksiyonun içinde çalışır,
// fotoğraf dışarı çıkmaz, çağrı başına maliyeti yoktur. Kafa da maskeye
// eklenir (bağlam olarak verilmez): verilince saç dokusunu deliğe doğru gri
// pus olarak uzatıyordu (c4 ilk deneme).
//
// Model 512x512 sabit girişli. Kırpım doğal çözünürlükte 512'lik parçalarla
// işlenir (çok küçültülmüş kırpımda dolgu çevresinden yumuşak kalıp hale gibi
// görünüyordu; bkz. lamaCore.js).
//
// MODEL DOSYASI (208 MB) fonksiyon kaynağına sığmaz: Storage'da
// LAMA_GCS_PATH'te durur, örnek başına bir kez /tmp'ye iner ve SHA-256 ile
// doğrulanır. Çıkarım AYRI, TEK bir worker iş parçacığında (bellek ~0.85 GB,
// çağrılar sıraya girer) — ana iş parçacığında olay döngüsünü bloklar.

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");
const { S, MARGIN } = require("./lamaCore");

const LAMA_GCS_PATH = "ml_models/lama_fp32.onnx";
const LAMA_SHA256 = "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6";
// Tek parçaya sığdırmak için kabul edilen en çok küçültme.
const MIN_FIT_SCALE = 0.75;
// Kafa maskesinin genişletilmesi (px, kırpım çözünürlüğünde).
const HEAD_MASK_GROW = 4;
// GENİŞ BAĞLAM (2026-10-18, d87c25b4 c0): delik (kafa + çevresi) 512'lik
// pencerenin %73'ünü kaplıyordu; model çevrede yeterince arka plan görmeyince
// kafa biçimli boşluğu gri bir kubbeyle tamamladı — saydam hayalet maskeye
// girdiği hâlde teslimde aynen kaldı. Pencere kenarı deliğin açıklığının
// CONTEXT_RATIO katı alınır; bu WIDE_MIN_SCALE'den fazla küçültme
// gerektiriyorsa (büyük delik) eski yol (bkz. fillCrop). 32 karede eski/yeni:
// c0 ve 0eeb75c8 c12'de gri kubbe kalktı, diğerlerinde fark yok; 0.45-0.6
// küçültmede hale görülmedi. YALNIZ KÜÇÜLTMESİZ KAFA ÇEVRESİNDE (job.wide,
// headSurround): küçültme deliğinde 12 karede karışık — 0eeb75c8 c12/c13'te
// eski kafanın izi biraz belirginleşti.
const CONTEXT_RATIO = 2;
const WIDE_MIN_SCALE = 0.45;

let modelP = null;
function modelPath() {
  if (process.env.LAMA_MODEL_PATH) return Promise.resolve(process.env.LAMA_MODEL_PATH);
  if (!modelP) {
    modelP = (async () => {
      const dest = path.join(os.tmpdir(), "lama_fp32.onnx");
      if (fs.existsSync(dest)) return dest;
      const { bucket } = require("./_shared");
      const part = `${dest}.${process.pid}.part`;
      await bucket().file(LAMA_GCS_PATH).download({ destination: part });
      const hash = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        fs.createReadStream(part).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
      });
      const sum = hash.digest("hex");
      if (sum !== LAMA_SHA256) {
        fs.rmSync(part, { force: true });
        throw new Error(`LaMa modeli doğrulanamadı (sha256 ${sum.slice(0, 12)})`);
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
  const w = new Worker(path.join(__dirname, "lamaWorker.js"));
  w.unref();
  w.on("message", ({ id, ok, rgb, runs, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(rgb ? { rgb: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), runs } : {});
    else p.reject(new Error(error));
  });
  const dead = (err) => {
    if (worker === w) worker = null;
    failAll(err instanceof Error ? err : new Error(`LaMa worker çıktı (${err})`));
  };
  w.on("error", dead);
  w.on("exit", (code) => dead(code));
  worker = w;
  return w;
}

/** rgb (w*h*3) içinde mask=1 piksellerini worker'da doldurur; dolu kopyayı döner. */
async function fillRemote(rgb, w, h, mask) {
  const mp = await modelPath();
  const copy = new Uint8Array(rgb.length);
  copy.set(rgb);
  const m = Uint8Array.from(mask);
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  getWorker().postMessage({ id, modelPath: mp, rgb: copy, w, h, mask: m }, [copy.buffer, m.buffer]);
  return p;
}

/**
 * Kare kırpımı (side x side) doldurur; dolu kopyayı ve parça sayısını döner.
 * 512'den küçük kırpım büyütülür; maske tek parçaya hafif küçültmeyle
 * sığıyorsa küçültülür, sığmıyorsa doğal çözünürlükte parçalanır.
 */
async function fillCrop(rgb, side, mask) {
  let x0 = side, x1 = -1, y0 = side, y1 = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (!mask[y * side + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { rgb: Buffer.from(rgb), runs: 0, scale: 1 };
  // Parça kenar payı ölçeklenmez: maske küçültülünce payla birlikte 512'ye sığmalı.
  const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const fit = (S - 2 * MARGIN - 8) / span; // 8: yuvarlama ve maske genişlemesi payı
  let f = 1;
  if (side < S) f = S / side;
  else if (fit < 1 && fit >= MIN_FIT_SCALE) f = fit;
  if (f === 1) {
    const r = await fillRemote(rgb, side, side, mask);
    return { rgb: r.rgb, runs: r.runs, scale: 1 };
  }
  const n = Math.max(S, Math.round(side * f));
  const small = await sharp(Buffer.from(rgb), { raw: { width: side, height: side, channels: 3 } })
    .resize(n, n, { kernel: "lanczos3" }).raw().toBuffer();
  const m8 = Buffer.alloc(side * side);
  for (let i = 0; i < m8.length; i++) m8[i] = mask[i] ? 255 : 0;
  // Ölçeklenen maske geniş alınır: delik kenarı bağlama sızmasın. TEK KANAL
  // TUZAĞI (hafıza sharp-mask-channel-trap): extractChannel(0) şart.
  const ms = await sharp(m8, { raw: { width: side, height: side, channels: 1 } })
    .resize(n, n, { kernel: "linear" }).extractChannel(0).raw().toBuffer();
  const sm = new Uint8Array(n * n);
  for (let i = 0; i < sm.length; i++) sm[i] = ms[i] > 8 ? 1 : 0;
  const r = await fillRemote(small, n, n, sm);
  const back = await sharp(r.rgb, { raw: { width: n, height: n, channels: 3 } })
    .resize(side, side, { kernel: "lanczos3" }).raw().toBuffer();
  return { rgb: back, runs: r.runs, scale: f };
}

/**
 * Geniş bağlamla dolgu: maskenin açıklığının CONTEXT_RATIO katı kenarlı kare
 * tam kareden (baseRgb, job kırpımı job.rgb ile) alınır, 512'ye indirilir.
 * Dönüş { rgb (job kırpımı side*side*3), runs, scale } | null (sığmıyor).
 */
async function fillWide(job, baseRgb, mask) {
  const { side, W, H, left, top } = job;
  let x0 = side, x1 = -1, y0 = side, y1 = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (!mask[y * side + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const span = Math.max(x1 - x0, y1 - y0) + 1;
  const ws = Math.min(W, H, Math.round(span * CONTEXT_RATIO));
  const f = S / ws;
  if (f < WIDE_MIN_SCALE) return null;
  const L = Math.max(0, Math.min(W - ws, Math.round(left + (x0 + x1) / 2 - ws / 2)));
  const T = Math.max(0, Math.min(H - ws, Math.round(top + (y0 + y1) / 2 - ws / 2)));
  const big = Buffer.alloc(ws * ws * 3);
  const m8 = Buffer.alloc(ws * ws);
  for (let y = 0; y < ws; y++) {
    for (let x = 0; x < ws; x++) {
      const X = x + L, Y = y + T, b = y * ws + x;
      const cx = X - left, cy = Y - top;
      const inJob = cx >= 0 && cy >= 0 && cx < side && cy < side;
      const src = inJob ? job.rgb : baseRgb, si = inJob ? cy * side + cx : Y * W + X;
      for (let c = 0; c < 3; c++) big[b * 3 + c] = src[si * 3 + c];
      if (inJob && mask[cy * side + cx]) m8[b] = 255;
    }
  }
  const small = f < 1
    ? await sharp(big, { raw: { width: ws, height: ws, channels: 3 } }).resize(S, S, { kernel: "lanczos3" }).raw().toBuffer()
    : big;
  const n = f < 1 ? S : ws;
  // TEK KANAL TUZAĞI (hafıza sharp-mask-channel-trap): extractChannel(0) şart.
  const ms = f < 1
    ? await sharp(m8, { raw: { width: ws, height: ws, channels: 1 } }).resize(S, S, { kernel: "linear" }).extractChannel(0).raw().toBuffer()
    : m8;
  const sm = new Uint8Array(n * n);
  for (let i = 0; i < sm.length; i++) sm[i] = ms[i] > 8 ? 1 : 0;
  const r = await fillCrop(small, n, sm);
  const back = f < 1
    ? await sharp(r.rgb, { raw: { width: S, height: S, channels: 3 } }).resize(ws, ws, { kernel: "lanczos3" }).raw().toBuffer()
    : r.rgb;
  const out = Buffer.from(job.rgb);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const bx = x + left - L, by = y + top - T;
      if (bx < 0 || by < 0 || bx >= ws || by >= ws) continue;
      const b = by * ws + bx, i = y * side + x;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = back[b * 3 + c];
    }
  }
  return { rgb: out, runs: r.runs, scale: f * r.scale };
}

/**
 * Kafa ölçeği/çevresi işini (headScale.prepareInpaint biçimi) yerel modelle
 * tamamlar. Maske = delik ∪ kafa (job.headC; bağlam olarak verilmez). Delik
 * pikseline bileşim ağırlığıyla yazılır: res = base + wC (L - PC) — OpenAI
 * yolundaki finishInpaint ile aynı bileşim; model maske dışını değiştirmediği
 * için renk düzeltmesi ve kayma kapısı gerekmez.
 * Dönüş { buf, runs, scale, ms }.
 */
async function finishInpaintLama(job, baseBuf, opts = {}) {
  const t0 = Date.now();
  const { side, W, H, left, top } = job;
  const N = side * side;
  // Kafa maskesi HEAD_MASK_GROW px genişletilir: delik kafanın korunan
  // kenarının 1-2 px dışında başlıyor; aradaki ince kontur bağlam kalınca
  // model plakaya soluk bir kafa silüeti ve kenar boyunca açık bant çizdi
  // (e0eb8dd5 c4 denemesi).
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (job.headC && job.headC[i]) mask[i] = 1;
  for (let k = 0; k < HEAD_MASK_GROW; k++) {
    const prev = Uint8Array.from(mask);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = y * side + x;
        if (prev[i]) continue;
        if ((x > 0 && prev[i - 1]) || (x < side - 1 && prev[i + 1]) || (y > 0 && prev[i - side]) || (y < side - 1 && prev[i + side])) mask[i] = 1;
      }
    }
  }
  for (let i = 0; i < N; i++) if (job.holeC[i]) mask[i] = 1;
  const res = await sharp(baseBuf).removeAlpha().raw().toBuffer();
  const wide = opts.wide ?? !!job.wide;
  const filled = (wide && (await fillWide(job, res, mask))) || (await fillCrop(job.rgb, side, mask));
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      if (!job.holeC[i]) continue;
      const g = (y + top) * W + (x + left);
      const wv = job.wC[i];
      for (let c = 0; c < 3; c++) {
        const v = res[g * 3 + c] + wv * (filled.rgb[i * 3 + c] - job.PC[i * 3 + c]);
        res[g * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  const buf = await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, runs: filled.runs, scale: filled.scale, ms: Date.now() - t0 };
}

/** Modeli indirir ve worker'da oturumu açar (iş başında, beklemeden). */
async function warmup() {
  const mp = await modelPath();
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  getWorker().postMessage({ id, warm: true, modelPath: mp });
  return p;
}

/** Testler/kapanış: worker'ı durdurur. */
async function shutdown() {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

module.exports = { finishInpaintLama, fillCrop, warmup, shutdown, LAMA_GCS_PATH, LAMA_SHA256 };
