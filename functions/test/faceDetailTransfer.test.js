const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { transferSelfieDetail, _delaunay } = require("../faceDetailTransfer");

test("delaunay: kare + merkez 4 üçgen, alanlar kareyi kaplar", () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }];
  const tris = _delaunay(pts);
  assert.equal(tris.length, 4);
  const area = tris.reduce((s, t) => {
    const [a, b, c] = t.map((i) => pts[i]);
    return s + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }, 0);
  assert.ok(Math.abs(area - 100) < 1e-9);
});

test("transferSelfieDetail: yüz yoksa dokunmaz", async () => {
  const blank = await sharp({ create: { width: 200, height: 260, channels: 3, background: "#888" } }).png().toBuffer();
  const r = await transferSelfieDetail(blank, [blank]);
  assert.equal(r.applied, false);
  assert.equal(r.buf, null);
  assert.equal(r.reason, "no-face-output");
});
