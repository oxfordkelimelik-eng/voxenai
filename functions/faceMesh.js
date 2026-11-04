// YOĞUN YÜZ AĞI (2026-10-16, L1 — kullanıcı: "L1 ve L2'yi birlikte
// çalıştıralım"). MediaPipe FaceMesh (468 nokta + derinlik), tfjs-wasm,
// model functions/models/face_mesh (Apache-2.0 MediaPipe ağırlıkları,
// @vladmandic/human dönüşümü). Yüz ışığı (faceRelight) çıktının KENDİ yüz
// şeklinin normallerini buradan alır: kişinin burnu/elmacığı üzerinde
// ışık-gölge — base mankenin yüzünden hiçbir ayrıntı taşınmaz.
//
// Kırpım 68 noktadan (face-api) kurulur, ikinci geçiş ilk ağın kendi
// kutusuyla (kütüphanenin dedektör + önbellek akışının karşılığı). Kırpım göz
// çizgisine göre döndürülür (eğik başta döndürmesiz kırpım 12-14 px saptı).
// Derinlik x/y ile aynı ölçekte (kütüphane z'yi ölçeklemiyordu; normaller yüz
// boyutuna göre düzleşiyordu).

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "models", "face_mesh");
const SIZE = 192;
// İlk kırpım: 68 noktanın kutusu (alın eklenerek) bu katla büyütülüp kare.
const FIRST_SCALE = 1.4;
// İkinci kırpım: ilk ağın 468 noktasının kutusu (alın dahil) bu katla.
const SECOND_SCALE = 1.25;
const MIN_SCORE = 0.3;
// GÜVEN (2026-10-16, shade t_05/t_17/t_22): güçlü profilde ağ yüzü değil
// kulak-şakak çevresini kaplıyor (kütüphanenin kendi akışı da). Ağın 6 noktası
// 68 noktanın karşılıklarıyla karşılaştırılır; ortanca sapma göz arası
// mesafenin bu katından büyükse ağ kullanılmaz.
const AGREE_MAX = 0.15;
// [ağ, 68 nokta]: dış göz köşeleri, burun ucu, ağız köşeleri, çene.
const PAIRS = [[33, 36], [263, 45], [1, 30], [61, 48], [291, 54], [152, 8]];

/** 68 noktayla uyum: ortanca sapma / göz arası. SAF. */
function agreement(mesh, pts) {
  const iod = Math.hypot(pts[45].x - pts[36].x, pts[45].y - pts[36].y) || 1;
  const d = PAIRS.map(([m, p]) => Math.hypot(mesh[m][0] - pts[p].x, mesh[m][1] - pts[p].y) / iod).sort((a, b) => a - b);
  return (d[2] + d[3]) / 2;
}

let _model = null;
let _tri = null;

function diskHandler(dir) {
  return {
    load: async () => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
      const specs = [];
      const bufs = [];
      for (const g of m.weightsManifest) {
        specs.push(...g.weights);
        for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p)));
      }
      const all = Buffer.concat(bufs);
      return {
        modelTopology: m.modelTopology, format: m.format, generatedBy: m.generatedBy, convertedBy: m.convertedBy,
        weightSpecs: specs, weightData: all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength), signature: m.signature,
      };
    },
  };
}

async function ensureModel() {
  if (!_model) {
    _model = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      if (tf.getBackend() !== "wasm") {
        await tf.setBackend("wasm");
        await tf.ready();
      }
      return { tf, model: await tf.loadGraphModel(diskHandler(DIR)) };
    })().catch((e) => {
      _model = null;
      throw e;
    });
  }
  return _model;
}

/** Ağın üçgenleri (düz dizi, 3'erli). */
function triangles() {
  if (!_tri) _tri = JSON.parse(fs.readFileSync(path.join(DIR, "tri468.json"), "utf8"));
  return _tri;
}

/** Kırpım koordinatı (u, v; 0..SIZE) → görüntü. box: merkez cx/cy, kenar size, açı ang. SAF. */
function toImage(box, u, v) {
  const k = box.size / SIZE, c = Math.cos(box.ang), s = Math.sin(box.ang);
  const du = (u - SIZE / 2) * k, dv = (v - SIZE / 2) * k;
  return [box.cx + du * c - dv * s, box.cy + du * s + dv * c];
}

/** Döndürülmüş kare kırpımı 192×192'ye çift doğrusal örnekler (dışı siyah), 0..1. SAF. */
function sampleCrop(rgb, W, H, box) {
  const out = new Float32Array(SIZE * SIZE * 3);
  for (let v = 0; v < SIZE; v++) {
    for (let u = 0; u < SIZE; u++) {
      const [px, py] = toImage(box, u + 0.5, v + 0.5);
      const x = px - 0.5, y = py - 0.5;
      const x0 = Math.floor(x), fx = x - x0, y0 = Math.floor(y), fy = y - y0;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const [dx, dy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
          const xx = x0 + dx, yy = y0 + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) s += wgt * rgb[(yy * W + xx) * 3 + c];
        }
        out[(v * SIZE + u) * 3 + c] = s / 255;
      }
    }
  }
  return out;
}

/** Noktaların döndürülmüş çerçevedeki kutusu → kare kırpım. SAF. */
function squareBox(points, ang, scale) {
  const c = Math.cos(ang), s = Math.sin(ang);
  let a = Infinity, b = Infinity, e = -Infinity, f = -Infinity;
  for (const [x, y] of points) {
    const u = x * c + y * s, v = -x * s + y * c;
    a = Math.min(a, u); b = Math.min(b, v); e = Math.max(e, u); f = Math.max(f, v);
  }
  const mu = (a + e) / 2, mv = (b + f) / 2;
  return { cx: mu * c - mv * s, cy: mu * s + mv * c, size: Math.max(e - a, f - b) * scale, ang };
}

async function runOnce(rgb, W, H, box) {
  const { tf, model } = await ensureModel();
  const input = tf.tensor4d(sampleCrop(rgb, W, H, box), [1, SIZE, SIZE, 3]);
  const outs = model.execute(input);
  input.dispose();
  const list = Array.isArray(outs) ? outs : [outs];
  try {
    const meshT = list.find((t) => t.shape[t.shape.length - 1] === 1404);
    const flagT = list.find((t) => t.shape[t.shape.length - 1] === 1);
    if (!meshT || !flagT) return null;
    const score = (await flagT.data())[0];
    const raw = await meshT.data();
    const k = box.size / SIZE;
    const mesh = [];
    for (let i = 0; i < 468; i++) mesh.push([...toImage(box, raw[i * 3], raw[i * 3 + 1]), raw[i * 3 + 2] * k]);
    return { mesh, score };
  } finally {
    tf.dispose(list);
  }
}

/**
 * rgb: W×H×3 tam kare; pts: 68 yüz noktası ({x,y}). Döner
 * { mesh: [[x, y, z]] × 468 (görüntü pikseli, z kameraya doğru negatif), score, agree } | null
 * (ağ bulunamadı ya da 68 noktayla uyuşmuyor).
 */
async function denseMesh(rgb, W, H, pts, { agreeMax = AGREE_MAX, minScoreLoose = 1.01 } = {}) {
  const mean = (i0, i1) => { let x = 0, y = 0; for (let i = i0; i <= i1; i++) { x += pts[i].x; y += pts[i].y; } return [x / (i1 - i0 + 1), y / (i1 - i0 + 1)]; };
  const [lx, ly] = mean(36, 41), [rx, ry] = mean(42, 47);
  const ang = Math.atan2(ry - ly, rx - lx);
  // Alın: kaşların üstüne, kaş-çene mesafesinin 0.3'ü (döndürülmüş çerçevede
  // yukarı = -v yönü).
  const P = pts.map((p) => [p.x, p.y]);
  const [bx, by] = mean(17, 26), [cx, cy] = [pts[8].x, pts[8].y];
  P.push([bx - 0.3 * (cx - bx), by - 0.3 * (cy - by)]);
  const first = await runOnce(rgb, W, H, squareBox(P, ang, FIRST_SCALE));
  if (!first || first.score < MIN_SCORE) return null;
  const second = await runOnce(rgb, W, H, squareBox(first.mesh, ang, SECOND_SCALE));
  const best = second && second.score >= MIN_SCORE ? second : first;
  const agree = agreement(best.mesh, pts);
  if (agree <= AGREE_MAX) return { ...best, agree };
  // POZ ÖLÇÜMÜ İÇİN GEVŞEK (2026-10-31, bkz. headPose3d): güneş gözlüğü ve
  // aşağı eğik başta 68 nokta kayıyor, ağ doğru; güveni yüksekse kabul.
  return agree <= agreeMax && best.score >= minScoreLoose ? { ...best, agree } : null;
}

module.exports = { denseMesh, triangles, _testables: { sampleCrop, squareBox, toImage, agreement, AGREE_MAX } };
