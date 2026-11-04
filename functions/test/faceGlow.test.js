const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bgGate, curveAt, rgbToLab, labToRgb, BG_DARK_L, BG_BRIGHT_L } = require("../faceGlow")._testables;

test("bgGate: koyu arka planda tam güç, açıkta sıfır, arası doğrusal", () => {
  assert.equal(bgGate(5), 1);
  assert.equal(bgGate(BG_DARK_L), 1);
  assert.equal(bgGate(BG_BRIGHT_L), 0);
  assert.equal(bgGate(70), 0);
  assert.equal(bgGate((BG_DARK_L + BG_BRIGHT_L) / 2), 0.5);
});

test("curveAt: düğümler arasında doğrusal, uçlarda sabit", () => {
  const c = [[0, 0], [10, 4], [20, 0]];
  assert.equal(curveAt(c, -5), 0);
  assert.equal(curveAt(c, 5), 2);
  assert.equal(curveAt(c, 10), 4);
  assert.equal(curveAt(c, 30), 0);
});

test("rgbToLab/labToRgb: gidiş-dönüş 1 birimden fazla kaymaz", () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [200, 150, 120], [30, 60, 200], [128, 128, 128]]) {
    const [L, a, bb] = rgbToLab(r, g, b);
    const o = labToRgb(L, a, bb);
    assert.ok(Math.abs(o[0] - r) <= 1 && Math.abs(o[1] - g) <= 1 && Math.abs(o[2] - b) <= 1, `${[r, g, b]} -> ${o}`);
  }
});
