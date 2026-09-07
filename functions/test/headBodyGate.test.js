const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isPulledToCameraNumeric, isUnderRotated } = require("../headBodyGate");

test("şablon yaw yoksa pulled kuralı susar — smokin 0.08 ve sahil 0.02 kalsın", () => {
  assert.equal(isPulledToCameraNumeric(null, 0.08), false);
  assert.equal(isPulledToCameraNumeric(null, 0.02), false);
  assert.equal(isPulledToCameraNumeric(null, 0.47), false);
});

test("şablon yaw varsa pulled kuralı yine susar — diğer yaw kapıları karar verir", () => {
  assert.equal(isPulledToCameraNumeric(0.76, 0.51), false);
  assert.equal(isPulledToCameraNumeric(0.27, 0.28), false);
});

test("ölçü yoksa fail-safe geçsin", () => {
  assert.equal(isPulledToCameraNumeric(null, null), false);
  assert.equal(isPulledToCameraNumeric(0.27, null), false);
});

test("b1d697 c1: tam profil taban 1.00, çıktı 0.77 → eksik dönüş", () => {
  assert.equal(isUnderRotated(1.00, 0.77), true);
});

test("b1d697 c7: tam profil taban 1.00, çıktı 0.87 → eksik dönüş", () => {
  assert.equal(isUnderRotated(1.00, 0.87), true);
});

test("teslim c4: şablon 0.88 < 0.95 olduğu için susar", () => {
  assert.equal(isUnderRotated(0.88, 0.71), false);
});

test("şablon profil değilse eksik dönüş yok", () => {
  assert.equal(isUnderRotated(0.12, 0.37), false);
  assert.equal(isUnderRotated(null, 0.87), false);
});
