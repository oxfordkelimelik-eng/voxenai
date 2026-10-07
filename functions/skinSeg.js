/**
 * VÜCUT DERİSİ SEGMENTASYONU (2026-10-07) — MediaPipe selfie_multiclass_256x256.
 *
 * Sınıflar: 0 arka plan, 1 saç, 2 VÜCUT DERİSİ, 3 yüz derisi, 4 kıyafet,
 * 5 diğer (aksesuar). Ten düzeltmesi (skinTone.js) neyi boyayacağını renkten
 * değil bu modelden öğrenir.
 *
 * NEDEN: renk tabanlı ten testi + kişi maskesi, elde tutulan DERİ ÇANTAYI,
 * BİRA BARDAĞINI ve krem gömleği ten saydı (fark haritalarında görüldü).
 * Deri çanta sayısal olarak tenle aynı (açı 49.5°, kroma/açıklık 0.76) —
 * renk ölçüsüyle ayrılamaz, ama segmentasyon modeli onu "aksesuar" bilir.
 *
 * MODEL NASIL ÇALIŞIYOR: Google'ın resmi .tflite dosyası, Python `tflite`
 * paketiyle graph.json (175 işlem) + weights.bin'e aktarıldı (bkz.
 * scripts/exportTflite.py). Model yalnızca 11 temel işlem kullanıyor; hepsi
 * tfjs'te var, bu yüzden ayrı bir çalışma zamanı (onnxruntime vb.) eklenmedi.
 * Aşağıdaki küçük yorumlayıcı işlemleri sırayla tfjs'e çevirir.
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SIZE = 256;
const MODEL_DIR = path.join(__dirname, "models", "selfie_multiclass");
let _modelPromise = null;

async function ensureModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      if (tf.getBackend() !== "wasm") {
        await tf.setBackend("wasm");
        await tf.ready();
      }
      const graph = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "graph.json"), "utf8"));
      const bin = fs.readFileSync(path.join(MODEL_DIR, "weights.bin"));
      const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
      // Sabit tensörler bir kez yüklenir ve bellekte tutulur.
      const consts = new Map();
      graph.tensors.forEach((t, i) => {
        if (t.offset == null) return;
        const data = t.type === 0
          ? new Float32Array(ab, t.offset, t.length)
          : new Int32Array(ab, t.offset, t.length);
        consts.set(i, { data, shape: t.shape, dtype: t.type === 0 ? "float32" : "int32" });
      });
      // Ağırlıkları tfjs düzenine bir kez çevir (her çağrıda transpose yok).
      const prepared = new Map();
      const tensorOf = (i) => {
        if (!prepared.has(i)) {
          const c = consts.get(i);
          prepared.set(i, tf.keep(tf.tensor(c.data, c.shape, c.dtype)));
        }
        return prepared.get(i);
      };
      const weights = new Map();
      for (const op of graph.ops) {
        if (op.op === "CONV_2D") {
          // tflite [out, kh, kw, in] -> tfjs [kh, kw, in, out]
          weights.set(op.in[1], tf.keep(tf.transpose(tensorOf(op.in[1]), [1, 2, 3, 0])));
        } else if (op.op === "DEPTHWISE_CONV_2D") {
          // tflite [1, kh, kw, in*mult] -> tfjs [kh, kw, in, mult]
          const s = graph.tensors[op.in[1]].shape;
          const inC = graph.tensors[op.in[0]].shape[3];
          weights.set(op.in[1], tf.keep(tf.reshape(tensorOf(op.in[1]), [s[1], s[2], inC, s[3] / inC])));
        } else if (op.op === "TRANSPOSE_CONV") {
          // tflite [out, kh, kw, in] -> tfjs [kh, kw, out, in]
          weights.set(op.in[1], tf.keep(tf.transpose(tensorOf(op.in[1]), [1, 2, 0, 3])));
        }
      }
      return { tf, graph, consts, tensorOf, weights };
    })().catch((e) => {
      _modelPromise = null;
      throw e;
    });
  }
  return _modelPromise;
}

function activate(tf, x, act) {
  if (!act) return x;
  if (act === 1) return tf.relu(x);
  if (act === 2) return tf.clipByValue(x, -1, 1);
  if (act === 3) return tf.relu6(x);
  if (act === 4) return tf.tanh(x);
  throw new Error("desteklenmeyen aktivasyon " + act);
}

/** Grafiği çalıştırır: [1,256,256,3] float (0..1) -> [1,256,256,6] olasılık. */
function runGraph(M, input) {
  const { tf, graph, consts, tensorOf, weights } = M;
  const vals = new Map();
  vals.set(graph.inputs[0], input);
  const get = (i) => (vals.has(i) ? vals.get(i) : tensorOf(i));
  const intsOf = (i) => Array.from(consts.get(i).data);
  for (const op of graph.ops) {
    const x = get(op.in[0]);
    let y;
    switch (op.op) {
      case "CONV_2D": {
        y = tf.conv2d(x, weights.get(op.in[1]), op.s, op.pad, "NHWC", op.d);
        if (op.in.length > 2 && op.in[2] >= 0) y = tf.add(y, tensorOf(op.in[2]));
        y = activate(tf, y, op.act);
        break;
      }
      case "DEPTHWISE_CONV_2D": {
        y = tf.depthwiseConv2d(x, weights.get(op.in[1]), op.s, op.pad, "NHWC", op.d);
        if (op.in.length > 2 && op.in[2] >= 0) y = tf.add(y, tensorOf(op.in[2]));
        y = activate(tf, y, op.act);
        break;
      }
      case "ADD": y = activate(tf, tf.add(x, get(op.in[1])), op.act); break;
      case "MUL": y = activate(tf, tf.mul(x, get(op.in[1])), op.act); break;
      case "RESHAPE": {
        const shape = op.shape || intsOf(op.in[1]);
        y = tf.reshape(x, shape);
        break;
      }
      case "TRANSPOSE": y = tf.transpose(x, intsOf(op.in[1])); break;
      case "SOFTMAX": y = tf.softmax(op.beta && op.beta !== 1 ? tf.mul(x, op.beta) : x); break;
      case "SUM": y = tf.sum(x, intsOf(op.in[1]), op.keep); break;
      case "RESIZE_BILINEAR": {
        const [h, w] = intsOf(op.in[1]);
        y = tf.image.resizeBilinear(x, [h, w], op.ac, op.hp);
        break;
      }
      case "RESIZE_NEAREST_NEIGHBOR": {
        const [h, w] = intsOf(op.in[1]);
        y = tf.image.resizeNearestNeighbor(x, [h, w], op.ac, op.hp);
        break;
      }
      case "TRANSPOSE_CONV": {
        // girdiler: [output_shape, weights, input, (bias)]
        const outShape = intsOf(op.in[0]);
        y = tf.conv2dTranspose(get(op.in[2]), weights.get(op.in[1]), outShape, op.s, op.pad);
        if (op.in.length > 3 && op.in[3] >= 0) y = tf.add(y, tensorOf(op.in[3]));
        break;
      }
      default:
        throw new Error("desteklenmeyen işlem " + op.op);
    }
    vals.set(op.out[0], y);
  }
  return vals.get(graph.outputs[0]);
}

/**
 * Sınıf olasılıkları, görüntünün kendi çözünürlüğünde.
 * @param {Buffer} rgb  ham RGB (3 kanal), W*H*3
 * @returns {Promise<Float32Array[]>} 6 sınıf için W*H olasılık dizileri
 */
async function classProbs(rgb, W, H) {
  const M = await ensureModel();
  const { tf } = M;
  const small = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(SIZE, SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  const out = tf.tidy(() => {
    const x = tf.tensor4d(new Uint8Array(small), [1, SIZE, SIZE, 3], "int32").toFloat().div(255);
    return runGraph(M, x).squeeze();
  });
  const data = await out.data();
  out.dispose();
  const C = data.length / (SIZE * SIZE);
  const res = [];
  for (let c = 0; c < C; c++) {
    const m8 = Buffer.alloc(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) m8[i] = Math.round(Math.max(0, Math.min(1, data[i * C + c])) * 255);
    // Tek kanal tuzağı (hafıza: sharp-mask-channel-trap) — extractChannel(0).
    const big = await sharp(m8, { raw: { width: SIZE, height: SIZE, channels: 1 } })
      .resize(W, H, { fit: "fill", kernel: "linear" })
      .extractChannel(0)
      .raw()
      .toBuffer();
    const f = new Float32Array(W * H);
    for (let i = 0; i < f.length; i++) f[i] = big[i] / 255;
    res.push(f);
  }
  return res;
}

const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };

module.exports = { classProbs, CLASSES, _runGraph: runGraph, _ensureModel: ensureModel };
