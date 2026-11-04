const { test } = require("node:test");
const assert = require("node:assert/strict");
const { liftFor, liftEye, interp, eyeAperture, EYES, FULL_LIFT_AP, NO_LIFT_AP, MAX_LIFT, CLOSED_AP } = require("../eyeOpen")._testables;

test("liftFor: ağır kapakta tam, açık gözde sıfır, kapalı gözde sıfır, arası doğrusal", () => {
  assert.equal(liftFor(FULL_LIFT_AP), MAX_LIFT);
  assert.equal(liftFor(0.2), MAX_LIFT);
  assert.equal(liftFor(NO_LIFT_AP), 0);
  assert.equal(liftFor(0.5), 0);
  assert.equal(liftFor(CLOSED_AP - 0.01), 0);
  assert.equal(liftFor(null), 0);
  assert.ok(Math.abs(liftFor((FULL_LIFT_AP + NO_LIFT_AP) / 2) - MAX_LIFT / 2) < 1e-9);
});

test("interp: düğümler arasında doğrusal, uçlarda sabit", () => {
  const c = [[0, 0], [0.5, -4], [1, 0]];
  assert.equal(interp(c, -1), 0);
  assert.equal(interp(c, 0.25), -2);
  assert.equal(interp(c, 0.5), -4);
  assert.equal(interp(c, 2), 0);
});

// Yatay göz: köşeler (20,50)-(60,50), üst kapak y=46, alt kapak y=54 (orta).
function syntheticMesh() {
  const mesh = Array.from({ length: 468 }, () => [0, 0]);
  const e = EYES[0];
  e.up.forEach((i, k) => { const u = k / (e.up.length - 1); mesh[i] = [20 + 40 * u, 50 - 8 * Math.sin(Math.PI * u)]; });
  e.lo.forEach((i, k) => { const u = k / (e.lo.length - 1); mesh[i] = [20 + 40 * u, 50 + 4 * Math.sin(Math.PI * u)]; });
  return mesh;
}

test("eyeAperture: dikey aralık / en", () => {
  const { w, ap } = eyeAperture(syntheticMesh(), EYES[0]);
  assert.equal(w, 40);
  assert.ok(ap > 0.2 && ap < 0.32, String(ap));
});

test("liftEye: üst kapak çizgisi yukarı çıkar, alt kapak ve göz dışı yerinde", () => {
  const W = 80, H = 100;
  const src = Buffer.alloc(W * H * 3, 200);
  // Koyu kapak çizgisi y=42 (göz ortasında), açık zemin.
  for (let x = 0; x < W; x++) for (let y = 41; y <= 42; y++) for (let c = 0; c < 3; c++) src[(y * W + x) * 3 + c] = 20;
  // Alt kapak çizgisi y=54.
  for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) src[(54 * W + x) * 3 + c] = 60;
  const dst = Buffer.from(src);
  const moved = liftEye(src, dst, W, H, syntheticMesh(), EYES[0], 0.25);
  assert.ok(moved > 0);
  const at = (x, y) => dst[(y * W + x) * 3];
  // Ortada kapak çizgisi ~3 px yukarı: y=38-39 artık koyu, y=42 açık.
  assert.ok(at(40, 39) < 100, `y39=${at(40, 39)}`);
  assert.ok(at(40, 42) > 150, `y42=${at(40, 42)}`);
  // Alt kapak yerinde, göz köşelerinin dışı dokunulmamış.
  assert.equal(at(40, 54), 60);
  assert.equal(at(10, 42), 20);
  assert.equal(at(70, 42), 20);
});

test("liftEye: kaldırma 0 iken hiçbir piksel değişmez", () => {
  const W = 80, H = 100;
  const src = Buffer.alloc(W * H * 3, 123);
  const dst = Buffer.from(src);
  assert.equal(liftEye(src, dst, W, H, syntheticMesh(), EYES[0], 0), 0);
  assert.deepEqual(dst, src);
});
