// Kulaklık tespit çekirdeği: OWLv2 oturumu ve tek kırpım çıkarımı. Yalnız
// kulaklık worker iş parçacığında çalışır (bkz. earbudWorker.js, earbuds.js) —
// onnxruntime-node'un run() çağrısı olay döngüsünü bloklar (bkz. lamaCore.js).
//
// Model: Xenova/owlv2-base-patch16-ensemble, quantize ONNX (Apache-2.0,
// google/owlv2-base-patch16-ensemble'dan). Metinle sorgulanan nesne tespiti;
// sorgu token'ları CLIP BPE sözlüğünde tek parça kelimeler olduğu için
// tokenizer gerekmez (aşağıdaki QUERIES, 49406/49407 = başlangıç/bitiş).

const SIZE = 960;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SEQ = 16;
const QUERIES = {
  earbuds: [47807],
  earphones: [44905],
  headphones: [14906],
  headset: [23883],
  "wireless earbuds": [9103, 47807],
  // Karşıt sorgular: kulaklık kutusu kulağın kendisinden yüksek skorlu olmalı.
  ear: [8373],
  hair: [2225],
  face: [1710],
};
const NAMES = Object.keys(QUERIES);

let sessionP = null;

function session(modelPath) {
  if (!sessionP) {
    sessionP = (async () => {
      const ort = require("onnxruntime-node");
      // ARENA KAPALI (2026-10-26): 960 px'te dikkat matrisleri arenada örnek
      // ömrünce kalıyordu (+3.1 GB; kapalı +0.24 GB, ikinci çalıştırmadan
      // sonra aynı hız). Üretim fonksiyonu 8 GiB'in %81-91'ini kullanıyor.
      const s = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all",
        enableCpuMemArena: false,
      });
      return { ort, s };
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

/**
 * rgb: SIZE x SIZE x 3 (Uint8). Döner: kutu başına {cx, cy, w, h (0..1), scores}.
 */
async function detectNative(modelPath, rgb) {
  const { ort, s } = await session(modelPath);
  const n = SIZE * SIZE;
  const pv = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pv[c * n + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const ids = new BigInt64Array(NAMES.length * SEQ);
  const mask = new BigInt64Array(NAMES.length * SEQ);
  NAMES.forEach((name, q) => {
    [49406, ...QUERIES[name], 49407].forEach((v, i) => { ids[q * SEQ + i] = BigInt(v); mask[q * SEQ + i] = 1n; });
  });
  const out = await s.run({
    input_ids: new ort.Tensor("int64", ids, [NAMES.length, SEQ]),
    attention_mask: new ort.Tensor("int64", mask, [NAMES.length, SEQ]),
    pixel_values: new ort.Tensor("float32", pv, [1, 3, SIZE, SIZE]),
  });
  const L = out.logits.data, B = out.pred_boxes.data;
  const nq = NAMES.length, np = out.logits.dims[1];
  const res = [];
  for (let p = 0; p < np; p++) {
    const scores = {};
    for (let q = 0; q < nq; q++) scores[NAMES[q]] = 1 / (1 + Math.exp(-L[p * nq + q]));
    res.push({ cx: B[p * 4], cy: B[p * 4 + 1], w: B[p * 4 + 2], h: B[p * 4 + 3], scores });
  }
  return res;
}

async function warm(modelPath) {
  await session(modelPath);
}

module.exports = { detectNative, warm, SIZE, NAMES };
