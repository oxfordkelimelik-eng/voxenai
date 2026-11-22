const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bgGate, curveAt, rgbToLab, labToRgb, BG_DARK_L, BG_BRIGHT_L } = require("../faceGlow")._testables;

test("bgGate: koyu arka planda tam güç, açıkta sıfır, arası doğrusal", () => {
  assert.equal(bgGate(5), 1);
  assert.equal(bgGate(BG_DARK_L), 1);
  assert.equal(bgGate(BG_BRIGHT_L), 0);
  assert.equal(bgGate(70), 0);
  assert.equal(bgGate((BG_DARK_L + BG_BRIGHT_L) / 2), 0.5);
});

test("curveAt: düğümler arasında doğrusal, uçlarda sabit", () => {
  const c = [[0, 0], [10, 4], [20, 0]];
  assert.equal(curveAt(c, -5), 0);
  assert.equal(curveAt(c, 5), 2);
  assert.equal(curveAt(c, 10), 4);
  assert.equal(curveAt(c, 30), 0);
});

test("rgbToLab/labToRgb: gidiş-dönüş 1 birimden fazla kaymaz", () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [200, 150, 120], [30, 60, 200], [128, 128, 128]]) {
    const [L, a, bb] = rgbToLab(r, g, b);
    const o = labToRgb(L, a, bb);
    assert.ok(Math.abs(o[0] - r) <= 1 && Math.abs(o[1] - g) <= 1 && Math.abs(o[2] - b) <= 1, `${[r, g, b]} -> ${o}`);
  }
});

// ELLE IŞIKLI FİLTRE (2026-11-22): açık arka planlı karede otomatik mod atlar, elle mod 0.6 ile uygular.
test("applyManualGlow: açık arka planda da uygular, otomatik mod atlar", async () => {
  const sharp = require("sharp");
  const { applyGlowFilter, applyManualGlow, MANUAL_STRENGTH } = require("../faceGlow");
  assert.equal(MANUAL_STRENGTH, 0.6);
  const W = 96, H = 128, px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { px[i * 3] = 150; px[i * 3 + 1] = 140; px[i * 3 + 2] = 130; } // L ~58
  const img = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const auto = await applyGlowFilter(img);
  assert.equal(auto.applied, false);
  assert.equal(auto.reason, "bright-bg");
  const man = await applyManualGlow(img);
  assert.equal(man.applied, true);
  const out = await sharp(man.buf).raw().toBuffer();
  assert.ok(out[0] > 150, `orta ton açılmalı (${out[0]})`);
});
