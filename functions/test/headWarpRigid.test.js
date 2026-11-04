const test = require("node:test");
const assert = require("node:assert");
const { _testables: T, rigidScaleFill } = require("../headWarp");

test("katı ölçek kapalı (2026-11-03: kulak sildi, kenar bulanık), büyütme sınırlı", () => {
  assert.strictEqual(T.RIGID_ON, false);
  assert.strictEqual(typeof rigidScaleFill, "function");
  assert.ok(T.WARP_MIN_GROW > 1 && T.WARP_MAX_GROW <= 1.1);
  assert.ok(T.WARP_MAX_SHRINK >= 0.85);
});

test("ikili maske genişletme halka için yarıçap kadar büyür", () => {
  const W = 21, H = 21, m = new Uint8Array(W * H);
  m[10 * W + 10] = 1;
  const d = T.dilateBin(m, W, H, 3);
  assert.strictEqual(d[10 * W + 13], 1);
  assert.strictEqual(d[10 * W + 15], 0);
  assert.strictEqual(d[10 * W + 10], 1);
});
