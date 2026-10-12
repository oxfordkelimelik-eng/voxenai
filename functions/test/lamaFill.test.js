const test = require("node:test");
const assert = require("node:assert");
const { tileStarts, S, MARGIN } = require("../lamaCore");

test("lama parçaları: tek parçaya sığan maske ortalanır", () => {
  const xs = tileStarts(300, 500, 1200);
  assert.equal(xs.length, 1);
  assert.ok(xs[0] <= 300 - MARGIN && xs[0] + S >= 500 + MARGIN);
});

test("lama parçaları: geniş maske iç kısımlarla eksiksiz kaplanır", () => {
  const a0 = 100, a1 = 1000, n = 1300;
  const xs = tileStarts(a0, a1, n);
  assert.ok(xs.length > 1);
  for (let p = a0; p <= a1; p++) {
    const covered = xs.some((x) => p >= x + MARGIN && p < x + S - MARGIN);
    assert.ok(covered, `piksel ${p} hiçbir parçanın içinde değil`);
  }
});

test("lama parçaları: görüntü dışına taşmaz", () => {
  for (const [a0, a1, n] of [[0, 40, 600], [560, 599, 600], [0, 599, 600]]) {
    for (const x of tileStarts(a0, a1, n)) assert.ok(x >= 0 && x + S <= n);
  }
});
