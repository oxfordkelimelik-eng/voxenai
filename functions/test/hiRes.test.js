const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { _testables } = require("../falPhotos");
const { recompositeScale, recompositeIntoOriginal, RECOMPOSITE_LONG_MAX } = require("../postProcess");

const dims = (s) => s.split("x").map(Number);

test("hiResSize: 3:4 şablon 1632x2176, kenarlar 16'nın katı, oran korunur", () => {
  assert.equal(_testables.hiResSize(1170, 1560), "1632x2176");
  for (const [w, h] of [[977, 1303], [1440, 1806], [3072, 4096], [1080, 1350], [1600, 900]]) {
    const [W, H] = dims(_testables.hiResSize(w, h));
    assert.equal(W % 16, 0);
    assert.equal(H % 16, 0);
    assert.ok(Math.abs(W / H - w / h) < 0.02, `${w}x${h} -> ${W}x${H}`);
    assert.ok(Math.abs(W * H - 1632 * 2176) / (1632 * 2176) < 0.03);
  }
});

test("hiResSize: aşırı oran 3'e, kenar 3840'a sınırlanır", () => {
  const [W, H] = dims(_testables.hiResSize(5000, 500));
  assert.ok(W <= 3840 && W / H <= 3.05);
  assert.equal(_testables.hiResSize(0, 10), null);
});

test("recompositeScale: yama küçülecekse tuval büyür, büyük şablonda 1", () => {
  // 1170x1560 şablon, kırpım 977x1303, yama 1632 → ×1.67 (uzun kenar 2600 sınırında)
  const small = { left: 100, top: 50, cropW: 977, cropH: 1303, imgW: 1170, imgH: 1560 };
  assert.ok(Math.abs(recompositeScale(1632, small) - Math.min(1632 / 977, RECOMPOSITE_LONG_MAX / 1560)) < 1e-9);
  // 3072x4096 şablon, kırpım 1998 → yama zaten büyütülüyor
  assert.equal(recompositeScale(1632, { left: 0, top: 0, cropW: 1998, cropH: 2664, imgW: 3072, imgH: 4096 }), 1);
  // uzun kenar sınırı
  const tiny = { left: 0, top: 0, cropW: 500, cropH: 667, imgW: 1500, imgH: 2000 };
  assert.ok(Math.abs(recompositeScale(1632, tiny) * 2000 - RECOMPOSITE_LONG_MAX) < 1e-6);
  assert.equal(recompositeScale(0, small), 1);
});

test("recompositeIntoOriginal: scale ile tuval büyür, yama doğru konumda", async () => {
  const geo = { left: 40, top: 20, cropW: 100, cropH: 120, imgW: 200, imgH: 240 };
  const orig = await sharp({ create: { width: 200, height: 240, channels: 3, background: "#000" } }).png().toBuffer();
  const out = await sharp({ create: { width: 160, height: 192, channels: 3, background: "#fff" } }).png().toBuffer();
  const r = await recompositeIntoOriginal(out, orig, geo, { scale: 1.6 });
  const m = await sharp(r).metadata();
  assert.equal(m.width, 320);
  assert.equal(m.height, 384);
  const { data, info } = await sharp(r).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[(y * info.width + x) * info.channels];
  assert.ok(at(64 + 80, 32 + 96) > 240, "yama ortası beyaz");
  assert.ok(at(10, 10) < 15, "yama dışı orijinal");
  // scale verilmezse eski davranış
  const r1 = await recompositeIntoOriginal(out, orig, geo);
  assert.equal((await sharp(r1).metadata()).width, 200);
});
