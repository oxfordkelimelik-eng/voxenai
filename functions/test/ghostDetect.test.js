// Şablon izi detektörü (2026-11-06, bkz. ghostDetect.js) ve ghostClean sıcak
// yama maskesi: kare eşiği altında hiçbir yama dönmez; sıcak maske histerezis,
// delik doldurma ve yarım yama genişletmeyle düzgünleşir.
const test = require("node:test");
const assert = require("node:assert");
const { zoneCover, probeScore, decide, loadProbe, GRID, FRAME_TAU, PATCH_TAU } = require("../ghostDetect")._testables;
const { hotMaskOf } = require("../ghostClean")._testables;

const G2 = GRID * GRID;

test("zoneCover: tam dolu maske her yamada 1, boş maske 0", () => {
  const n = 120;
  const full = zoneCover(new Uint8Array(n * n).fill(1), n);
  const none = zoneCover(new Uint8Array(n * n), n);
  assert.strictEqual(full.length, G2);
  assert.ok(full.every((v) => v === 1));
  assert.ok(none.every((v) => v === 0));
});

test("decide: kare skoru eşiğin altındaysa sıcak yama yok, skor yine döner", () => {
  const covR = new Float32Array(G2).fill(1), covB = new Float32Array(G2);
  const r = decide(covR, covB, () => FRAME_TAU - 0.01);
  assert.strictEqual(r.hot, null);
  assert.ok(Math.abs(r.frameScore - (FRAME_TAU - 0.01)) < 1e-9);
});

test("decide: kare skoru yalnız R yamalarından; bant yamaları haritada", () => {
  const covR = new Float32Array(G2), covB = new Float32Array(G2);
  covR[10] = 1; covB[20] = 1;
  // Bant yaması çok yüksek ama R düşük: kare eşiği geçilmez.
  let r = decide(covR, covB, (p) => (p === 20 ? 9 : 1));
  assert.strictEqual(r.hot, null);
  assert.strictEqual(r.frameScore, 1);
  // R eşiği geçince bant skoru da haritada, bölge dışı yama null.
  r = decide(covR, covB, (p) => (p === 10 ? 5 : 3));
  assert.ok(r.hot);
  assert.strictEqual(r.hot.scores[10], 5);
  assert.strictEqual(r.hot.scores[20], 3);
  assert.strictEqual(r.hot.scores[30], null);
  assert.strictEqual(r.hot.tau, PATCH_TAU);
});

test("probeScore: sonda dosyası yüklenir, boyutlar tutarlı, skor sonlu", () => {
  const P = loadProbe();
  assert.strictEqual(P.comps.length, P.K);
  assert.strictEqual(P.w.length, P.K + 1);
  assert.strictEqual(P.mu.length, P.D);
  const e = new Float32Array(P.D).map((_, j) => Math.sin(j));
  assert.ok(Number.isFinite(probeScore(P, e)));
});

test("hotMaskOf: eşik altı ama sıcağa komşu yama histerezisle eklenir, uzak olan eklenmez", () => {
  const n = GRID * 4; // yama = 4 px
  const scores = new Array(G2).fill(null);
  const p = (x, y) => y * GRID + x;
  scores[p(10, 10)] = 3;           // çekirdek
  scores[p(11, 10)] = 1.0;         // komşu, ≥ tau − 1.5 → eklenir
  scores[p(30, 30)] = 1.0;         // uzak → eklenmez
  const m = hotMaskOf({ grid: GRID, scores, tau: 2.0 }, n);
  const at = (gx, gy) => m[(gy * 4 + 2) * n + gx * 4 + 2];
  assert.strictEqual(at(10, 10), 1);
  assert.strictEqual(at(11, 10), 1);
  assert.strictEqual(at(30, 30), 0);
});

test("hotMaskOf: çevresi sıcak tek boş yama doldurulur (bloklu kırıntı bırakmaz)", () => {
  const n = GRID * 4;
  const scores = new Array(G2).fill(null);
  for (let y = 19; y <= 21; y++) for (let x = 19; x <= 21; x++) scores[y * GRID + x] = 3;
  scores[20 * GRID + 20] = null; // ortadaki puanlanmamış
  const m = hotMaskOf({ grid: GRID, scores, tau: 2.0 }, n);
  assert.strictEqual(m[(20 * 4 + 2) * n + 20 * 4 + 2], 1);
});

test("hotMaskOf: hiç sıcak yama yoksa boş maske", () => {
  const n = GRID * 2;
  const m = hotMaskOf({ grid: GRID, scores: new Array(G2).fill(1.9), tau: 2.0 }, n);
  assert.ok(m.every((v) => v === 0));
});
