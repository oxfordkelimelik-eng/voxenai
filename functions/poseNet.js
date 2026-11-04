// OMUZ NOKTALARI (2026-10-26, kullanıcı: "omuzlar önde kafanın dik ve arkada
// olması"; "yerel açık kaynaklı modelleri daha çok kullanalım").
//
// Kafa hizası (headScale.planHeadAlign) ve çene kaldırması kafayı şablondaki
// yerine taşır; bu yalnız gövde şablondakiyle aynı yerdeyse doğrudur. Kişi
// maskesi IoU'su koyu kıyafet koyu zeminde düşüyor (d0d4c001 c2: 0.71, kapı
// 0.8) — aynı karede omuz noktaları 0.014 omuz genişliği kayma gösterdi.
// Arşivde (13 iş, 93 kare) omuz kayması medyan 0.001, p90 0.013; genişlik
// oranı 0.97-1.01.
//
// Model: MoveNet SinglePose Thunder (Apache-2.0, Google; ONNX dönüşümü
// Xenova/movenet-singlepose-thunder), 25 MB, functions/models/movenet altında
// pakette (indirme yok). int8 sürümü onnxruntime-node 1.22'de açılmıyor
// (ConvInteger). Çıkarım ~0.1 sn; çağıran zaten worker iş parçacığında.

const path = require("path");
const sharp = require("sharp");

const MODEL = path.join(__dirname, "models", "movenet", "movenet_thunder.onnx");
const SIZE = 256;
// COCO sırası: 3/4 kulak, 5/6 omuz.
const L_SHOULDER = 5;
const R_SHOULDER = 6;
const MIN_SCORE = 0.3;
// Omuz ortası kayması ve genişlik farkı (omuz genişliği cinsinden) sınırı.
// Dikey konum yaka/ceketle oynuyor (arşiv |dy| p90 0.027, IoU'su yüksek
// 3d1d2a71 c3'te 0.09): kafa hizası yatay olduğundan dikey sınır gevşek.
const ALIGNED_MAX_DX = 0.04;
const ALIGNED_MAX_DY = 0.07;
const ALIGNED_MAX_WIDTH = 0.05;

let sessionP = null;
function session() {
  if (!sessionP) {
    sessionP = (async () => {
      const ort = require("onnxruntime-node");
      // Arena kapalı (bkz. lamaCore.js): her son katman worker'ında bir oturum.
      const s = await ort.InferenceSession.create(MODEL, { intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false });
      return { ort, s };
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

/** 17 nokta {x, y, score}, görüntü pikselinde. */
async function keypoints(buf) {
  const { ort, s } = await session();
  const m = await sharp(buf).metadata();
  const side = Math.max(m.width, m.height);
  const sq = await sharp(buf).removeAlpha()
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0 }, position: "left top" })
    .raw().toBuffer();
  const out = await s.run({ input: new ort.Tensor("int32", Int32Array.from(sq), [1, SIZE, SIZE, 3]) });
  const d = out.output_0.data;
  const k = [];
  for (let i = 0; i < 17; i++) k.push({ y: d[i * 3] * side, x: d[i * 3 + 1] * side, score: d[i * 3 + 2] });
  return k;
}

/** İki omuz: orta nokta, genişlik, en düşük skor. SAF. */
function shoulders(k) {
  const a = k[L_SHOULDER], b = k[R_SHOULDER];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, width: Math.hypot(a.x - b.x, a.y - b.y), score: Math.min(a.score, b.score) };
}

/** Çıktının omuzları şablonunkiyle aynı yerde mi? SAF. */
function compareShoulders(so, st) {
  if (so.score < MIN_SCORE || st.score < MIN_SCORE || !(st.width > 0)) return { ok: false, reason: "low-score", score: Math.min(so.score, st.score) };
  const dx = (so.x - st.x) / st.width;
  const dy = (so.y - st.y) / st.width;
  const wRatio = so.width / st.width;
  const ok = Math.abs(dx) <= ALIGNED_MAX_DX && Math.abs(dy) <= ALIGNED_MAX_DY && Math.abs(wRatio - 1) <= ALIGNED_MAX_WIDTH;
  return { ok, reason: ok ? null : "moved", dx, dy, wRatio, score: Math.min(so.score, st.score) };
}

async function shoulderAlignment(outBuf, tplBuf) {
  const [ko, kt] = [await keypoints(outBuf), await keypoints(tplBuf)];
  return compareShoulders(shoulders(ko), shoulders(kt));
}

module.exports = { keypoints, shoulders, compareShoulders, shoulderAlignment };
