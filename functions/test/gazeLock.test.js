// Bakış kilidi plan kuralları (2026-11-06, bkz. gazeLock.js).
const test = require("node:test");
const assert = require("node:assert");
const { planShift, contourU, MIN_SHIFT_CAMERA } = require("../gazeLock")._testables;

const eye = (u, ok = true) => ({ ok, u, w: 24, f: {} });
const fx = (u0, u1, yaw = 0) => ({ pose: { yaw }, eyes: [eye(u0), eye(u1)] });

test("contourU: köşe sırası fark etmez, merkez 0.5", () => {
  assert.strictEqual(contourU([5, 0], [0, 0], [10, 0]).u, 0.5);
  assert.strictEqual(contourU([2, 0], [10, 0], [0, 0]).u, 0.2);
});

test("planShift: her göz kendi base gözüne eşitlenir", () => {
  const p = planShift(fx(0.30, 0.40, -34), fx(0.36, 0.49, -34));
  assert.ok(Math.abs(p.du[0] + 0.06) < 1e-9 && Math.abs(p.du[1] + 0.09) < 1e-9);
  assert.strictEqual(p.comp, 0);
});

test("planShift: base kameraya bakıyorsa baş dönüşü telafisi yok, küçük fark dokunulmaz", () => {
  const p = planShift(fx(0.47, 0.53, 0), fx(0.42, 0.50, 12));
  assert.strictEqual(p.camera, true);
  assert.strictEqual(p.comp, 0);
  assert.strictEqual(p.du, null);
  assert.ok(MIN_SHIFT_CAMERA > 0.05);
});

test("planShift: base yana bakarken baş farkı telafi edilir (sınırlı)", () => {
  const p = planShift(fx(0.30, 0.38, -40), fx(0.30, 0.38, -25));
  assert.ok(p.comp < 0 && p.comp >= -0.06);
});

test("planShift: iki göz zıt yöne itilecekse dokunulmaz; kaydırma 0.25 ile sınırlı", () => {
  assert.strictEqual(planShift(fx(0.30, 0.70), fx(0.45, 0.55)).du, null);
  const p = planShift(fx(0.20, 0.25, -30), fx(0.60, 0.62, -30));
  assert.deepStrictEqual(p.du.map((x) => +x.toFixed(2)), [-0.25, -0.25]);
});

test("planShift: tek göz ölçülürse öbürü onu izler (şaşılık yok)", () => {
  const b = fx(0.30, 0.40, -40); b.eyes[0].ok = false;
  const o = fx(0.50, 0.55, -40); o.eyes[0].ok = false; o.eyes[0].w = 12;
  const p = planShift(b, o);
  assert.ok(Math.abs(p.du[0] - p.du[1]) < 1e-9 && p.du[1] < 0);
});

test("simpleFinish bakış kilidini çağırır (kaynak kontrolü)", () => {
  const src = require("fs").readFileSync(require.resolve("../postTasks"), "utf8");
  assert.ok(src.includes("lockGazeToBase(out, tpl, { templateEyewear })"));
});
