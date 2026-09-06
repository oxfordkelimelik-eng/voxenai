/**
 * DETERMİNİSTİK BAKIŞ ÖLÇÜMÜ — Vision'ın okumasına hiç güvenmeden, gözbebeği
 * konumundan "gözler nereye bakıyor" sorusunu sayısallaştırır.
 *
 * Yöntem: 68 nirengi noktasından göz çokgenleri alınır (sol 36-41, sağ 42-47),
 * göz açıklığının içindeki EN KOYU pikseller (gözbebeği + iris) ağırlıklı
 * merkezle bulunur ve bu merkezin göz genişliği içindeki YATAY konumu
 * 0..1 olarak ölçülür (0.5 = ortada/kameraya, 0'a yakın = sola, 1'e yakın =
 * sağa). Taban ile çıktının farkı, "bakış kaydı mı" sorusunun cevabıdır.
 *
 * Aynı zamanda kafa yaw'ı da ölçülür — bakış = kafa açısı + göz kayması.
 *
 * Kullanım: node scripts/measureGaze.js  (veri seti: %TEMP%/gaze-dataset)
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const WORK_WIDTH = 720;

let _faceapi = null;
async function models() {
  if (_faceapi) return _faceapi;
  const tf = require("@tensorflow/tfjs");
  require("@tensorflow/tfjs-backend-wasm");
  const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
  await tf.setBackend("wasm");
  await tf.ready();
  const modelPath = path.join(__dirname, "..", "models");
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
  _faceapi = faceapi;
  return faceapi;
}

/** Göz çokgeni içindeki koyu piksellerin ağırlıklı merkezi → 0..1 yatay konum. */
function irisOffset(gray, w, h, pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 6 || bh < 3) return null; // göz çok küçük — ölçüm güvenilmez

  // Göz kutusundaki parlaklık dağılımı: en koyu %25'lik dilim gözbebeği kabul
  // edilir. Sabit eşik yerine yüzdelik kullanılıyor ki koyu/açık ten ve farklı
  // pozlamalar aynı şekilde ölçülsün.
  const vals = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) vals.push(gray[y * w + x]);
  }
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(vals.length * 0.25)];

  let sx = 0;
  let sw = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = gray[y * w + x];
      if (v > cut) continue;
      const weight = cut - v + 1; // koyulaştıkça ağırlık artar
      sx += x * weight;
      sw += weight;
    }
  }
  if (sw === 0) return null;
  return { pos: (sx / sw - x0) / bw, width: bw };
}

async function measure(file) {
  const faceapi = await models();
  const img = sharp(file).rotate();
  const meta = await img.metadata();
  const scale = WORK_WIDTH / meta.width;
  const resized = img.resize({ width: WORK_WIDTH });
  const { data, info } = await resized.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (data[i * 3] * 299 + data[i * 3 + 1] * 587 + data[i * 3 + 2] * 114) / 1000;
  }

  const tensor = faceapi.tf.tensor3d(new Uint8Array(data), [h, w, 3]);
  try {
    const res = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
      .withFaceLandmarks();
    if (!res) return null;
    const p = res.landmarks.positions;
    const left = irisOffset(gray, w, h, p.slice(36, 42));
    const right = irisOffset(gray, w, h, p.slice(42, 48));
    const parts = [left, right].filter(Boolean);
    if (parts.length === 0) return null;
    // Yaw: profileDegreeFromLandmarks ile aynı fikir — burun ucunun göz
    // merkezleri arasındaki konumu.
    const eyeL = p.slice(36, 42).reduce((a, q) => a + q.x, 0) / 6;
    const eyeR = p.slice(42, 48).reduce((a, q) => a + q.x, 0) / 6;
    const nose = p[30];
    const span = Math.abs(eyeR - eyeL) || 1;
    const yawish = (nose.x - (eyeL + eyeR) / 2) / span;
    return {
      iris: parts.reduce((a, q) => a + q.pos, 0) / parts.length,
      eyes: parts.length,
      eyeWidth: parts.reduce((a, q) => a + q.width, 0) / parts.length,
      yawish,
      scale,
    };
  } finally {
    tensor.dispose();
  }
}

(async () => {
  const { headYawOf } = require("../faceQuality");
  const dir = path.join(process.env.TEMP, "gaze-dataset");
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  const rows = [];

  for (const it of index) {
    const b = path.join(dir, `${it.key}_base.jpg`);
    const o = path.join(dir, `${it.key}_out.jpg`);
    if (!fs.existsSync(b) || !fs.existsSync(o)) continue;
    let mb = null;
    let mo = null;
    try {
      mb = await measure(b);
      mo = await measure(o);
    } catch (e) {
      console.log(`${it.key}: ölçüm hatası ${e.message}`);
      continue;
    }
    const yb = await headYawOf(fs.readFileSync(b));
    const yo = await headYawOf(fs.readFileSync(o));
    rows.push({
      key: it.key,
      irisBase: mb ? mb.iris : null,
      irisOut: mo ? mo.iris : null,
      irisFark: mb && mo ? Math.abs(mo.iris - mb.iris) : null,
      gözGenişliği: mb && mo ? Math.min(mb.eyeWidth, mo.eyeWidth) : null,
      yawBase: yb,
      yawOut: yo,
      yawFark: yb != null && yo != null ? yo - yb : null,
    });
  }

  fs.writeFileSync(path.join(dir, "gaze-metrics.json"), JSON.stringify(rows, null, 1));

  const ok = rows.filter((r) => r.irisFark != null && r.gözGenişliği >= 10);
  const sorted = [...ok].sort((a, b) => b.irisFark - a.irisFark);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const vals = ok.map((r) => r.irisFark).sort((a, b) => a - b);

  console.log(`\nölçülen çift: ${rows.length}, iris ölçümü geçerli (göz >= 10px): ${ok.length}`);
  console.log(
    `iris farkı dağılımı: p50=${q(vals, 0.5).toFixed(3)} p75=${q(vals, 0.75).toFixed(3)} ` +
    `p90=${q(vals, 0.9).toFixed(3)} p95=${q(vals, 0.95).toFixed(3)} maks=${vals[vals.length - 1].toFixed(3)}`
  );
  console.log("\n--- iris farkı en yüksek 12 çift (gözle bakılacak adaylar) ---");
  for (const r of sorted.slice(0, 12)) {
    console.log(
      `${r.key.padEnd(30)} irisFark=${r.irisFark.toFixed(3)} ` +
      `(${r.irisBase.toFixed(2)} -> ${r.irisOut.toFixed(2)})  ` +
      `yawFark=${r.yawFark != null ? (r.yawFark >= 0 ? "+" : "") + r.yawFark.toFixed(2) : "—"}  ` +
      `göz=${Math.round(r.gözGenişliği)}px`
    );
  }
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
