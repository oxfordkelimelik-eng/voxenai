const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isPulledToCameraNumeric } = require("../headBodyGate");

test("kahve yürüyüşü (f94c c3): şablon yaw yok, çıktı 0.47 → red", () => {
  assert.equal(isPulledToCameraNumeric(null, 0.47), true);
});

test("aynı sahne daha profil kaldıysa (tarihi 0.62) geçsin", () => {
  assert.equal(isPulledToCameraNumeric(null, 0.62), false);
});

test("şablon yaw varsa bu kural susar — ceket / kask / Citi / telefon", () => {
  assert.equal(isPulledToCameraNumeric(0.76, 0.51), false);
  assert.equal(isPulledToCameraNumeric(0.88, 0.68), false);
  assert.equal(isPulledToCameraNumeric(0.27, 0.28), false);
  assert.equal(isPulledToCameraNumeric(0.40, 0.35), false);
});

test("ölçü yoksa fail-safe geçsin", () => {
  assert.equal(isPulledToCameraNumeric(null, null), false);
  assert.equal(isPulledToCameraNumeric(0.27, null), false);
});
