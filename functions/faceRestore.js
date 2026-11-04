// YÜZ NETLİĞİ (2026-10-26, kullanıcı: "yüzün ışığı doğru, canlı ve yüz
// hatları belirgin"; "yerel açık kaynaklı modelleri daha çok kullanalım").
//
// Üretilen yüz 110-170 px genişlikte; göz, kaş, dudak çizgileri yumuşak
// (son işleme tavanı, bkz. hafıza face-detail-resolution). GFPGAN (Apache-2.0,
// bkz. faceRestoreCore.js) yüzü 512 px'te yeniden kurar: iris, kirpik, kaş
// teli, dudak çizgisi belirginleşir.
//
// ÖLÇÜLDÜ (13 iş, 93 teslim karesi, yerel):
//  - Tüm yüze tam güç (facefusion kutu maskesi): netlik 0.44 -> 0.53 ama
//    kimlik 9 karenin 7'sinde uzaklaştı (+0.048 medyan), cilt rötuşlu,
//    yüzün çevresindeki çalı da yumuşadı.
//  - ÖZELLİK MASKESİ (bu dosya): göz+kaş, burun, ağız elipsleri tam güç, cilt
//    SKIN_WEIGHT, yüz dışı hiç. Netlik 0.463 -> 0.529; kimlik medyan +0.015.
//  - Bu yüzden KARE BAŞINA KİMLİK KAPISI: önce tam güç, kimlik selfie
//    vektörüne ID_TOL'dan fazla uzaklaşırsa düşük güç, o da tutmazsa hiç.
//    Tam güçte 37/93 kare geçti; geçenlerde netlik 0.464 -> 0.546, kimlik
//    0.371 -> 0.366 (iyileşti).
// Gren sonra gelir (yüz detayı katmanı şablon greni kadar ekler).
//
// MODEL DOSYASI (340 MB) LaMa gibi Storage'da durur, örnek başına bir kez
// /tmp'ye iner ve SHA-256 ile doğrulanır; çıkarım ayrı tek worker'da.

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");

const FACE_RESTORE_GCS_PATH = "ml_models/gfpgan_1.4.onnx";
const FACE_RESTORE_SHA256 = "accc4757b26bdb89b32b4d3500d4f79c9dff97c1dd7c7104bf9dcb95e3311385";
const N = 512;
// FFHQ 512 hizalama şablonu: sol göz, sağ göz, burun ucu, ağız köşeleri.
const TEMPLATE = [[0.37691676, 0.46864664], [0.62285697, 0.46912813], [0.50123859, 0.61331904], [0.39308822, 0.725411], [0.61150205, 0.72490465]]
  .map(([x, y]) => [x * N, y * N]);
// Denenen güçler sırayla; ilk kimliği tutan kullanılır.
const BLENDS = [1, 0.6];
// Kimlik uzaklığı (face-api, selfie vektörüne) en çok bu kadar artabilir.
const ID_TOL = 0.01;
// Cildin payı (özellik elipsleri 1): cilt dokusu çoğunlukla modelin kalır.
// 0.35 → 0 (2026-10-28, kullanıcı tarifi: "yapay boyama, pürüzsüzleştirme
// veya hava fırçası efekti kesinlikle uygulanmayacak"): GFPGAN'ın cildi
// pürüzsüz; yanak/alın tamamen modelin dokusunda kalır, yalnız göz+kaş,
// burun ve ağız netleşir.
const SKIN_WEIGHT = 0;
// Bundan dar yüzde (px) model çok fazla uydurur.
const MIN_FACE_PX = 48;

let modelP = null;
function modelPath() {
  if (process.env.FACE_RESTORE_MODEL_PATH) return Promise.resolve(process.env.FACE_RESTORE_MODEL_PATH);
  if (!modelP) {
    modelP = (async () => {
      const dest = path.join(os.tmpdir(), "gfpgan_1.4.onnx");
      if (fs.existsSync(dest)) return dest;
      const { bucket } = require("./_shared");
      const part = `${dest}.${process.pid}.part`;
      await bucket().file(FACE_RESTORE_GCS_PATH).download({ destination: part });
      const hash = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        fs.createReadStream(part).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
      });
      const sum = hash.digest("hex");
      if (sum !== FACE_RESTORE_SHA256) {
        fs.rmSync(part, { force: true });
        throw new Error(`Yüz netliği modeli doğrulanamadı (sha256 ${sum.slice(0, 12)})`);
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
  const w = new Worker(path.join(__dirname, "faceRestoreWorker.js"));
  w.unref();
  w.on("message", ({ id, ok, output, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(output);
    else p.reject(new Error(error));
  });
  const dead = (err) => {
    if (worker === w) worker = null;
    failAll(err instanceof Error ? err : new Error(`Yüz netliği worker çıktı (${err})`));
  };
  w.on("error", dead);
  w.on("exit", (code) => dead(code));
  worker = w;
  return w;
}

async function post(msg, transfer) {
  const mp = await modelPath();
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  getWorker().postMessage({ ...msg, id, modelPath: mp }, transfer);
  return p;
}

/** Modeli indirir ve worker'da oturumu açar (iş başında, beklemeden). */
function warmup() {
  return post({ warm: true });
}

const avg = (pts, a, b) => {
  let x = 0, y = 0;
  for (let i = a; i <= b; i++) { x += pts[i].x; y += pts[i].y; }
  return [x / (b - a + 1), y / (b - a + 1)];
};

/** 68 noktadan 5 hizalama noktası. SAF. */
function fivePoints(pts) {
  return [avg(pts, 36, 41), avg(pts, 42, 47), [pts[30].x, pts[30].y], [pts[48].x, pts[48].y], [pts[54].x, pts[54].y]];
}

/** En küçük kareler benzerlik dönüşümü: dst = [a -b; b a] src + t. SAF. */
function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let sxx = 0, sab = 0, sba = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - ux, v = dst[i][1] - uy;
    sxx += x * x + y * y;
    sab += x * u + y * v;
    sba += x * v - y * u;
  }
  const a = sab / sxx, b = sba / sxx;
  return { a, b, tx: ux - (a * mx - b * my), ty: uy - (b * mx + a * my) };
}

const fwd = (T, x, y) => [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty];
function inv(T, u, v) {
  const d = T.a * T.a + T.b * T.b;
  const du = u - T.tx, dv = v - T.ty;
  return [(T.a * du + T.b * dv) / d, (-T.b * du + T.a * dv) / d];
}

function bilinear(img, W, H, x, y, out) {
  x = Math.max(0, Math.min(W - 1.001, x));
  y = Math.max(0, Math.min(H - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = (y0 * W + x0) * 3;
  for (let c = 0; c < 3; c++) {
    out[c] = img[i + c] * (1 - fx) * (1 - fy) + img[i + 3 + c] * fx * (1 - fy) +
      img[i + W * 3 + c] * (1 - fx) * fy + img[i + W * 3 + 3 + c] * fx * fy;
  }
}

/**
 * Kırpım uzayında karışım ağırlığı: yüz elipsinde SKIN_WEIGHT, göz+kaş,
 * burun ve ağız elipslerinde 1, kenarlar yumuşak. SAF.
 */
function featureMask(T, pts) {
  const P = pts.map((p) => fwd(T, p.x, p.y));
  const ell = (ids, grow) => {
    const xs = ids.map((i) => P[i][0]), ys = ids.map((i) => P[i][1]);
    return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, rx: (Math.max(...xs) - Math.min(...xs)) / 2 + grow, ry: (Math.max(...ys) - Math.min(...ys)) / 2 + grow };
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const g = N * 0.035;
  const E = [
    ell([...range(17, 21), ...range(36, 41)], g),
    ell([...range(22, 26), ...range(42, 47)], g),
    ell(range(48, 59), g),
    ell(range(27, 35), g * 0.6),
  ];
  const fcx = (P[0][0] + P[16][0]) / 2, fcy = (P[19][1] + P[8][1]) / 2;
  const frx = (P[16][0] - P[0][0]) / 2, fry = ((P[8][1] - P[19][1]) / 2) * 1.15;
  const M = new Float32Array(N * N);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const rf = Math.hypot((u - fcx) / frx, (v - fcy) / fry);
      let w = (rf < 0.85 ? 1 : rf > 1.05 ? 0 : (1.05 - rf) / 0.2) * SKIN_WEIGHT;
      for (const e of E) {
        const r = Math.hypot((u - e.cx) / e.rx, (v - e.cy) / e.ry);
        const we = r < 0.8 ? 1 : r > 1.2 ? 0 : (1.2 - r) / 0.4;
        if (we > w) w = we;
      }
      M[v * N + u] = w;
    }
  }
  return M;
}

/** Görüntüden hizalı 512 kırpım, model girdisi (CHW, [-1, 1]). */
function warpToCrop(img, W, H, T) {
  const x = new Float32Array(3 * N * N);
  const px = new Float32Array(3);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const [sx, sy] = inv(T, u, v);
      bilinear(img, W, H, sx, sy, px);
      const i = v * N + u;
      for (let c = 0; c < 3; c++) x[c * N * N + i] = (px[c] / 255 - 0.5) / 0.5;
    }
  }
  return x;
}

/** Model çıktısı (CHW, [-1, 1]) → RGB 0-255 (HWC, kayan). */
function toRgb(out) {
  const rgb = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.max(-1, Math.min(1, out[c * N * N + i]));
      rgb[i * 3 + c] = ((v + 1) / 2) * 255;
    }
  }
  return rgb;
}

/** Onarılmış kırpımı ağırlıkla görüntüye geri koyar. SAF. */
function pasteBack(img, W, H, rest, M, T, blend) {
  const out = Buffer.from(img);
  const corners = [[0, 0], [N, 0], [0, N], [N, N]].map(([u, v]) => inv(T, u, v));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
  const q = new Float32Array(3);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [u, v] = fwd(T, x, y);
      if (u < 0 || v < 0 || u > N - 1.001 || v > N - 1.001) continue;
      const m = M[(v | 0) * N + (u | 0)] * blend;
      if (m <= 0) continue;
      bilinear(rest, N, N, u, v, q);
      const g = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) out[g + c] = Math.round(img[g + c] + m * (q[c] - img[g + c]));
    }
  }
  return out;
}

/**
 * Yüzü onarır; kimlik selfie vektörüne ID_TOL'dan fazla uzaklaşmayan ilk
 * güçle döner. Döner { applied, buf, reason, blend, id0, id, tried, ms }.
 */
async function restoreFace(buf, refDescriptor) {
  if (!refDescriptor) return { applied: false, buf: null, reason: "no-ref" };
  const { faceLandmarks, matchesIdentity } = require("./faceQuality");
  const lm = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
  if (!lm) return { applied: false, buf: null, reason: "no-face" };
  if (lm.box.width < MIN_FACE_PX) return { applied: false, buf: null, reason: "small-face", faceW: lm.box.width };
  const t0 = Date.now();
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const T = similarity(fivePoints(lm.pts), TEMPLATE);
  const input = warpToCrop(data, W, H, T);
  const rest = toRgb(await post({ input }, [input.buffer]));
  const M = featureMask(T, lm.pts);
  const id0 = (await matchesIdentity(buf, refDescriptor)).distance;
  if (id0 == null) return { applied: false, buf: null, reason: "no-identity", ms: Date.now() - t0 };
  const tried = [];
  for (const blend of BLENDS) {
    const raw = pasteBack(data, W, H, rest, M, T, blend);
    const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const id = (await matchesIdentity(png, refDescriptor)).distance;
    tried.push({ blend, id });
    if (id != null && id <= id0 + ID_TOL) return { applied: true, buf: png, reason: null, blend, id0, id, tried, ms: Date.now() - t0 };
  }
  return { applied: false, buf: null, reason: "identity", id0, tried, ms: Date.now() - t0 };
}

/** Testler/kapanış: worker'ı durdurur. */
async function shutdown() {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

module.exports = {
  restoreFace,
  warmup,
  shutdown,
  fivePoints,
  similarity,
  featureMask,
  pasteBack,
  TEMPLATE,
  FACE_RESTORE_GCS_PATH,
  FACE_RESTORE_SHA256,
};
