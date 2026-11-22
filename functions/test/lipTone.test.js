const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LIP, planLipShift, featherMask, median } = require("../lipTone")._testables;

test("dudak: fark sınırı aşarsa yalnız aşan kadar çekilir (156fa173 c7 16.6 → 8)", () => {
  assert.equal(LIP.DA_MAX, 8);
  assert.ok(Math.abs(planLipShift(30.4, 13.8) - -8.6) < 1e-9);
  assert.equal(planLipShift(20, 13), 0, "sınır içinde dokunulmaz");
  assert.equal(planLipShift(21, 13), 0, "tam sınırda dokunulmaz");
  assert.equal(planLipShift(10, 16), 0, "dudak yanaktan solgunsa dokunulmaz");
  assert.equal(planLipShift(NaN, 10), 0);
});

test("dudak maskesi: yumuşatma alanı korur, kenara taşar", () => {
  const w = 21, h = 21, m = new Float32Array(w * h);
  for (let y = 8; y <= 12; y++) for (let x = 5; x <= 15; x++) m[y * w + x] = 1;
  const f = featherMask(m, w, h, 2);
  let s0 = 0, s1 = 0;
  for (let i = 0; i < m.length; i++) { s0 += m[i]; s1 += f[i]; }
  assert.ok(Math.abs(s0 - s1) / s0 < 0.2, "toplam ağırlık yaklaşık korunur");
  assert.ok(f[6 * w + 10] > 0 && f[6 * w + 10] < 1, "kenar dışı yumuşak");
  assert.equal(f[0], 0, "uzak köşe sıfır");
  assert.equal(median([3, 1, 2]), 2);
});
