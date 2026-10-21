const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { pngToDeliverJpeg } = require("../falPhotos")._testables;

test("üretim PNG'si 97 kalite, alt örneklemesiz JPEG'e çevrilir (99bacae0: OpenAI JPEG'i 75 kalitede bloklu)", async () => {
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 150, b: 120 } } }).png().toBuffer();
  const jpg = await pngToDeliverJpeg(png);
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
  const m = await sharp(jpg).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.width, 64);
  assert.equal(m.height, 48);
  assert.equal(m.chromaSubsampling, "4:4:4");
});
