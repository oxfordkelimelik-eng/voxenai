const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { fitSimilarity, applySim, landmarkFaceMask, matchGrayscale, meanSaturation } = require("../faceLight");

test("benzerlik dönüşümü: dönme+ölçek+kayma geri bulunur", () => {
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 7, y: 3 }];
  const a = 1.2 * Math.cos(0.3), b = 1.2 * Math.sin(0.3);
  const dst = src.map((p) => ({ x: a * p.x - b * p.y + 5, y: b * p.x + a * p.y - 2 }));
  const T = fitSimilarity(src, dst);
  for (let i = 0; i < src.length; i++) {
    const q = applySim(T, src[i].x, src[i].y);
    assert.ok(Math.abs(q.x - dst[i].x) < 1e-6 && Math.abs(q.y - dst[i].y) < 1e-6);
  }
});

function fakeFace(cx = 100, cy = 100, k = 1) {
  const P = [];
  for (let i = 0; i < 68; i++) P.push({ x: cx, y: cy });
  for (let i = 0; i <= 16; i++) { const t = Math.PI * (i / 16); P[i] = { x: cx - 50 * k * Math.cos(t), y: cy + 60 * k * Math.sin(t) - 10 * k }; }
  for (let i = 17; i <= 26; i++) P[i] = { x: cx + k * (-40 + 9 * (i - 17)), y: cy - 30 * k };
  P[36] = { x: cx - 30 * k, y: cy - 15 * k }; P[39] = { x: cx - 12 * k, y: cy - 15 * k };
  P[42] = { x: cx + 12 * k, y: cy - 15 * k }; P[45] = { x: cx + 30 * k, y: cy - 15 * k };
  P[19] = { x: cx - 20 * k, y: cy - 32 * k }; P[24] = { x: cx + 20 * k, y: cy - 32 * k };
  return P;
}

test("yüz maskesi: yanak dolu, göz ve yüz dışı boş", () => {
  const m = landmarkFaceMask(fakeFace(), 200, 200);
  assert.equal(m[120 * 200 + 70], 255); // sol yanak
  assert.equal(m[85 * 200 + 79], 0); // sol göz
  assert.equal(m[10 * 200 + 10], 0); // yüz dışı
});

test("siyah-beyaz şablon: renkli çıktı gri tonlamaya çekilir, renkli şablonda dokunulmaz", async () => {
  const W = 64, H = 64;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
  const color = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 120, b: 90 } } }).png().toBuffer();
  const r = await matchGrayscale(color, gray);
  assert.equal(r.applied, true);
  assert.ok(await meanSaturation(r.buf) < 1);
  assert.equal((await matchGrayscale(color, color)).applied, false);
});
