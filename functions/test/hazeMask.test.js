const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hazeMask, scaleResid } = require("../ghostClean")._testables;
const { distanceTo } = require("../headWarp")._testables;

// 2026-11-19 (6a02687c c8): kafa tepesinde saç + zemin karışımı gri kubbe opak kafa
// sayılıyordu. Güneş alan gerçek saç (k·U) korunmalı.
const U = [75, 62, 53], BG = [179, 198, 212];
function scene(topColor, band = 12) {
  const n = 80, N = n * n;
  const O = new Uint8Array(N), head = new Uint8Array(N), inOval = new Uint8Array(N), userSkin = new Uint8Array(N);
  const oF = new Float32Array(N * 3), bgv = new Float32Array(N * 3), ok = new Uint8Array(N);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    let c = BG;
    if (x >= 20 && x < 60 && y >= 40) { O[i] = 1; head[i] = 1; c = U; } // opak saç
    else if (x >= 20 && x < 60 && y >= 40 - band && y < 40) { head[i] = 1; c = topColor; } // tepe bandı
    for (let k = 0; k < 3; k++) { oF[i * 3 + k] = c[k]; bgv[i * 3 + k] = BG[k]; }
    ok[i] = 1;
  }
  return { n, O, Ho: { head, inOval }, userSkin, oF, U, bg: { ok, v: bgv }, browO: 75, fwk: 100, distanceTo };
}
const count = (m) => m.reduce((a, v) => a + v, 0);

test("hazeMask: saç + zemin karışımı kalın tepe bandı pus sayılır", () => {
  const mix = U.map((u, k) => 0.7 * u + 0.3 * BG[k]);
  const m = hazeMask(scene(mix));
  assert.ok(count(m) >= 0.9 * 40 * 12, `pus pikseli ${count(m)}`);
});

test("hazeMask: güneş alan gerçek saç (parlatılmış U) korunur", () => {
  const lit = U.map((u) => u * 1.6);
  const m = hazeMask(scene(lit));
  assert.equal(count(m), 0);
});

test("scaleResid: k·U sıfır, karışım sıfırdan büyük", () => {
  assert.ok(scaleResid(U.map((u) => u * 1.6), U) < 1e-6);
  assert.ok(scaleResid([97, 96, 97], U) > 20);
});

test("hazeMask: ince saç kenarı şeridi (kalınlık < 0.05 yüz eni) pus sayılmaz", () => {
  const mix = U.map((u, k) => 0.7 * u + 0.3 * BG[k]);
  const m = hazeMask(scene(mix, 6));
  assert.equal(count(m), 0);
});
