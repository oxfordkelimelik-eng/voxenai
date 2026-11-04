const { test } = require("node:test");
const assert = require("node:assert/strict");
const { shoulders, compareShoulders } = require("../poseNet");

const kp = (lx, ly, rx, ry, score = 0.8) => {
  const k = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 0 }));
  k[5] = { x: lx, y: ly, score };
  k[6] = { x: rx, y: ry, score };
  return k;
};

test("omuz: aynı yerdeki omuzlar hizalı sayılır", () => {
  const r = compareShoulders(shoulders(kp(103, 500, 303, 504)), shoulders(kp(100, 500, 300, 500)));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.dx - 0.015) < 1e-9);
});

test("omuz: yatay kayma, genişlik farkı ya da düşük skor hizalı sayılmaz", () => {
  const t = shoulders(kp(100, 500, 300, 500));
  assert.equal(compareShoulders(shoulders(kp(110, 500, 310, 500)), t).ok, false);
  assert.equal(compareShoulders(shoulders(kp(95, 500, 315, 500)), t).ok, false);
  assert.equal(compareShoulders(shoulders(kp(100, 500, 300, 500, 0.2)), t).reason, "low-score");
});

test("omuz: dikey sınır yataydan gevşek (yaka/ceket oynatır)", () => {
  const t = shoulders(kp(100, 500, 300, 500));
  assert.equal(compareShoulders(shoulders(kp(100, 512, 300, 512)), t).ok, true);
  assert.equal(compareShoulders(shoulders(kp(100, 520, 300, 520)), t).ok, false);
});
