// Yüz netliği çekirdeği: GFPGAN oturumu ve tek kırpım çıkarımı. Yalnız yüz
// netliği worker iş parçacığında çalışır (bkz. faceRestoreWorker.js,
// faceRestore.js) — onnxruntime-node'un run() çağrısı olay döngüsünü bloklar
// (bkz. lamaCore.js).
//
// Model: GFPGAN v1.4 (Apache-2.0, TencentARC; "clean" mimari, NVIDIA kodu
// yok), ONNX dönüşümü facefusion/models-3.0.0. Girdi/çıktı 1x3x512x512 RGB,
// [-1, 1].

const SIZE = 512;

let sessionP = null;

function session(modelPath) {
  if (!sessionP) {
    sessionP = (async () => {
      const ort = require("onnxruntime-node");
      // Arena kapalı (bkz. lamaCore.js): +1.22 GB yerine +0.39 GB, aynı hız.
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

/** input: Float32Array 3*SIZE*SIZE (CHW, [-1, 1]). Döner aynı biçimde. */
async function restoreNative(modelPath, input) {
  const { ort, s } = await session(modelPath);
  const out = await s.run({ input: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  return Float32Array.from(out.output.data);
}

async function warm(modelPath) {
  await session(modelPath);
}

module.exports = { restoreNative, warm, SIZE };
