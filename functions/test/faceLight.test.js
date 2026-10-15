const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { matchGrayscale, meanSaturation } = require("../faceLight");

test("siyah-beyaz şablon: renkli çıktı gri tonlamaya çekilir, renkli şablonda dokunulmaz", async () => {
  const W = 64, H = 64;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
  const color = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 120, b: 90 } } }).png().toBuffer();
  const r = await matchGrayscale(color, gray);
  assert.equal(r.applied, true);
  assert.ok(await meanSaturation(r.buf) < 1);
  assert.equal((await matchGrayscale(color, color)).applied, false);
});

test("siyah-beyaz şablon: gri sahnede küçük renkli yüz de griye çekilir (f9f3b5c0 c4)", async () => {
  const W = 100, H = 100;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
  const face = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 210, g: 150, b: 120 } } }).png().toBuffer();
  const out = await sharp(gray).composite([{ input: face, left: 45, top: 30 }]).png().toBuffer();
  assert.ok(await meanSaturation(out) < 4);
  const r = await matchGrayscale(out, gray);
  assert.equal(r.applied, true);
  assert.ok(await meanSaturation(r.buf) < 0.05);
});
