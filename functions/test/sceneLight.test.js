const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planSceneColor, medianColor, _testables } = require("../sceneLight");
const { _testables: FM } = require("../faceMesh");
const { _testables: FR } = require("../faceRelight");

const luma = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

test("ortam rengi: sıcak şablon ışığı yüzü kırmızıya, maviden uzağa kaydırır; parlaklık-nötr", () => {
  const p = planSceneColor([1.3, 0.95, 0.6], [2.0, 0.8, 0.55]);
  assert.ok(p.lc[0] > 0 && p.lc[2] < 0, JSON.stringify(p.lc));
  assert.ok(Math.abs(luma(p.lc)) < 0.03);
});

test("ortam rengi: kayma sınırlı", () => {
  const p = planSceneColor([3, 0.6, 0.2], [2.0, 0.8, 0.55]);
  for (const v of p.lc) assert.ok(Math.abs(v) <= _testables.MAX_SHIFT + 1e-12);
});

test("ortam rengi: yüzü ten aralığından dışarı itecek kayma küçültülür", () => {
  // r/g zaten üst sınırda: daha kırmızıya itme kesilir.
  const face = [2.85, 0.8, 0.5];
  const p = planSceneColor([1.6, 0.9, 0.5], face);
  const f = face.map((v, c) => v * Math.exp(p.lc[c]));
  assert.ok(f[0] / f[1] <= Math.max(_testables.SKIN_RG[1], face[0] / face[1]) + 1e-9, JSON.stringify(p));
  assert.ok(p.k < 1);
});

test("ortam rengi: gri yüz (siyah-beyaz) boyanmaz; ölçü yoksa atlanır", () => {
  assert.equal(planSceneColor([1.3, 0.95, 0.6], [1, 1, 1]).reason, "grayscale");
  assert.equal(planSceneColor(null, [1.8, 0.8, 0.5]).reason, "no-measure");
});

test("ışık tahmini: üç tahminin log ortalaması, eksik tahmin atlanır", () => {
  const m = _testables.logMean([[1.4, 0.9, 0.6], null, [1.0, 1.0, 1.0]]);
  assert.ok(Math.abs(luma(m) - 1) < 1e-9);
  assert.ok(m[0] > m[1] && m[2] < m[1]);
  assert.equal(_testables.logMean([null, null]), null);
});

test("medianColor: parlaklık 1'e normalize ortanca", () => {
  const m = medianColor([[0.2, 0.1, 0.05], [0.4, 0.2, 0.1], [0.3, 0.15, 0.075]]);
  assert.ok(Math.abs(luma(m) - 1) < 1e-9);
  assert.ok(Math.abs(m[0] / m[1] - 2) < 1e-9);
});

test("yüz ağı uyumu: 68 noktayla örtüşen ağ 0, kaymış ağ eşiği aşar", () => {
  const pts = Array.from({ length: 68 }, (_, i) => ({ x: 100 + (i % 10) * 7, y: 100 + Math.floor(i / 10) * 9 }));
  pts[36] = { x: 100, y: 120 }; pts[45] = { x: 160, y: 120 };
  const mesh = Array.from({ length: 468 }, () => [0, 0, 0]);
  for (const [m, p] of [[33, 36], [263, 45], [1, 30], [61, 48], [291, 54], [152, 8]]) mesh[m] = [pts[p].x, pts[p].y, 0];
  assert.equal(FM.agreement(mesh, pts), 0);
  const moved = mesh.map((q) => [q[0] + 30, q[1], q[2]]);
  assert.ok(FM.agreement(moved, pts) > FM.AGREE_MAX);
});

test("ışık yüzeyi: ek terim (L1 normal tabanı) yüzeyin anlatamadığı deseni yakalar", () => {
  const n = 2000, CX = new Float32Array(n), CY = new Float32Array(n), lt = new Float32Array(n), lo = new Float32Array(n), wt = new Float32Array(n).fill(1);
  const feat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    CX[i] = ((i * 37) % 100) / 50 - 1; CY[i] = ((i * 53) % 100) / 50 - 1;
    feat[i] = Math.sin(i * 0.7); // konumdan bağımsız "normal" özniteliği
    lt[i] = 0.2 * feat[i];
  }
  const extra = (i) => (i < 0 ? [0] : [feat[i]]);
  const plain = FR.fitLightSurface(lt, lo, wt, CX, CY, n);
  const withN = FR.fitLightSurface(lt, lo, wt, CX, CY, n, 2, extra, 0.002);
  let ep = 0, en = 0;
  for (let i = 0; i < n; i++) { ep += (lt[i] - plain.at(CX[i], CY[i], i)) ** 2; en += (lt[i] - withN.at(CX[i], CY[i], i)) ** 2; }
  assert.ok(en < ep * 0.1, `yüzey=${ep} ekli=${en}`);
});
