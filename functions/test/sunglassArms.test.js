const test = require("node:test");
const assert = require("node:assert");
const { _testables: T } = require("../sunglassTransfer");

// 80fc7ec4 c6: base 51°, çıktı 41° — gözlük %18 farklı kısalıyor, 2B eşleme uzak camı yüzün dışına koyuyordu.
test("kısalma kapısı: c6 reddedilir, küçük farklar geçer", () => {
  assert.ok(T.foreshortenDiff(50.8, 41.5) > T.MAX_FORESHORTEN, "c6");
  for (const [t, o] of [[7.6, 11.1], [-34.9, -31.8], [27.5, 32.4], [-2.4, -8.5], [-43.7, -41.4]]) {
    assert.ok(T.foreshortenDiff(t, o) <= T.MAX_FORESHORTEN, `${t}/${o}`);
  }
});

test("afin eşleme yatay kısalmayı taşır, tersi geri getirir", () => {
  const src = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 3]];
  const dst = src.map(([x, y]) => [0.8 * x + 0.1 * y + 3, 1.0 * y - 0.05 * x + 2]);
  const A = T.affineFit(src, dst);
  const [u, v] = T.applyAffine(A, 7, 4);
  assert.ok(Math.abs(u - (0.8 * 7 + 0.4 + 3)) < 1e-6 && Math.abs(v - (4 - 0.35 + 2)) < 1e-6);
  const [x, y] = T.applyAffine(T.invertAffine(A), u, v);
  assert.ok(Math.abs(x - 7) < 1e-6 && Math.abs(y - 4) < 1e-6);
});
