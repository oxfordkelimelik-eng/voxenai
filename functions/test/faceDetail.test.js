const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planDetailGain, hfRms, APPLY_MIN_GAIN, MAX_GAIN, planGrain, fineNoise, grainField, GRAIN_MAX_ADD } = require("../faceDetail");
const { pushPullField } = require("../sceneRestore");

// bb2cc441 c7: şablon yüz/kıyafet 6.89/4.80, çıktı 3.97/4.60 → yüz %40 eksik.
test("detay: yüz kıyafete göre şablondan yumuşaksa kazanç hesaplanır", () => {
  const p = planDetailGain({ outFace: 3.97, outCloth: 4.60, tplFace: 6.89, tplCloth: 4.80 });
  assert.equal(p.apply, true);
  assert.ok(Math.abs(p.rawGain - (6.89 / 4.80) * 4.60 / 3.97) < 1e-9);
  assert.ok(p.gain <= MAX_GAIN);
});

test("detay: yüz zaten yeterince detaylıysa dokunulmaz (asla yumuşatılmaz)", () => {
  const p = planDetailGain({ outFace: 6.08, outCloth: 3.03, tplFace: 6.58, tplCloth: 3.77 });
  assert.equal(p.apply, false);
  assert.equal(p.reason, "detailed-enough");
});

test("detay: küçük fark eşiğin altında kalır", () => {
  const p = planDetailGain({ outFace: 5, outCloth: 5, tplFace: 5.2, tplCloth: 5 });
  assert.ok(p.gain < APPLY_MIN_GAIN);
  assert.equal(p.apply, false);
});

test("detay: ölçü eksikse uygulanmaz", () => {
  assert.equal(planDetailGain({ outFace: null, outCloth: 4, tplFace: 5, tplCloth: 4 }).reason, "no-measure");
});

test("hfRms: yalnızca maske içi, az örnekte null", () => {
  const n = 1000;
  const g = new Uint8Array(n).fill(100), b = new Uint8Array(n).fill(97), m = new Float32Array(n).fill(1);
  assert.equal(hfRms(g, b, m), 3);
  assert.equal(hfRms(g, b, new Float32Array(n)), null);
});

test("pushPullField: bilinen değerleri korur, boşluğu komşulardan doldurur", () => {
  const W = 8, H = 1, F = new Float32Array(W), k = new Uint8Array(W);
  F[0] = 10; k[0] = 1; F[7] = 10; k[7] = 1;
  pushPullField(F, W, H, 1, k);
  assert.equal(F[0], 10);
  for (let i = 1; i < 7; i++) assert.ok(Math.abs(F[i] - 10) < 1e-6, `F[${i}]=${F[i]}`);
});

// 629b45de c3: şablon yüz greni 1.86, çıktı 0.61 → eksik pay eklenir.
test("gren: şablon yüzü belirgin grenliyse eksik pay eklenir", () => {
  const p = planGrain(1.86, 0.61);
  assert.equal(p.apply, true);
  // 2026-11-08 (27deeec2 c7): eksik payın yarısı, en çok GRAIN_MAX_ADD.
  assert.ok(Math.abs(p.rawAdd - Math.sqrt(1.86 ** 2 - 0.61 ** 2)) < 1e-9);
  assert.ok(Math.abs(p.add - Math.min(GRAIN_MAX_ADD, 0.5 * p.rawAdd)) < 1e-9);
  const c7 = planGrain(1.85, 0.91); // 27deeec2 c7: 0.91 → 1.91 kumlu göründü
  assert.ok(c7.add <= 0.85, `add=${c7.add}`);
});

test("gren: çıktı zaten grenliyse dokunulmaz (asla gren silinmez)", () => {
  assert.equal(planGrain(1.68, 2.55).reason, "grainy-enough"); // 629b45de c8
  assert.equal(planGrain(1.47, 1.42).reason, "grainy-enough"); // 629b45de c6
});

test("gren: eksik pay sınırlanır, ölçü yoksa uygulanmaz", () => {
  assert.equal(planGrain(5.71, 0.5).add, GRAIN_MAX_ADD);
  assert.equal(planGrain(null, 1).reason, "no-measure");
});

test("gren alanı: birim ölçülü ve tekrarlanabilir", () => {
  const W = 96, H = 96;
  const a = grainField(W, H, 7), b = grainField(W, H, 7);
  assert.deepEqual(a, b);
  const u = fineNoise(a, W, H, null, 0);
  assert.ok(Math.abs(u - 1) < 0.05, `birim=${u}`);
});
