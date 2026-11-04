const { test } = require("node:test");
const assert = require("node:assert/strict");
const { similarity, fivePoints, featureMask, pasteBack, TEMPLATE } = require("../faceRestore");

// Şablon noktalarını bilinen dönüşümle görüntüye taşı; benzerlik geri bulmalı.
test("yüz netliği: benzerlik dönüşümü bilinen dönüşümü geri bulur", () => {
  const s = 0.4, th = 0.2, tx = 37, ty = -12;
  const src = TEMPLATE.map(([x, y]) => [s * (Math.cos(th) * x - Math.sin(th) * y) + tx, s * (Math.sin(th) * x + Math.cos(th) * y) + ty]);
  const T = similarity(src, TEMPLATE);
  for (let i = 0; i < 5; i++) {
    const [x, y] = src[i];
    assert.ok(Math.abs(T.a * x - T.b * y + T.tx - TEMPLATE[i][0]) < 1e-6);
    assert.ok(Math.abs(T.b * x + T.a * y + T.ty - TEMPLATE[i][1]) < 1e-6);
  }
});

// 68 nokta: kırpım uzayında yaklaşık FFHQ yerleşimi (birim dönüşüm).
function face512() {
  const P = Array.from({ length: 68 }, () => ({ x: 256, y: 300 }));
  for (let i = 0; i <= 16; i++) P[i] = { x: 130 + (252 * i) / 16, y: 240 + 150 * Math.sin((Math.PI * i) / 16) };
  for (let i = 17; i <= 26; i++) P[i] = { x: 170 + (172 * (i - 17)) / 9, y: 205 };
  for (let i = 27; i <= 35; i++) P[i] = { x: 256 + (i > 30 ? (i - 33) * 10 : 0), y: 230 + (i - 27) * 10 };
  for (let i = 36; i <= 41; i++) P[i] = { x: 175 + (i - 36) * 7, y: 240 + (i % 2) * 3 };
  for (let i = 42; i <= 47; i++) P[i] = { x: 300 + (i - 42) * 7, y: 240 + (i % 2) * 3 };
  for (let i = 48; i <= 59; i++) P[i] = { x: 205 + ((i - 48) % 7) * 17, y: 370 + (i > 54 ? 8 : 0) };
  return P;
}

test("yüz netliği: özellik maskesi gözde tam, yanakta cilt payı yok, yüz dışında 0", () => {
  const P = face512();
  const M = featureMask({ a: 1, b: 0, tx: 0, ty: 0 }, P);
  const at = (x, y) => M[y * 512 + x];
  assert.equal(at(193, 241), 1); // sol göz
  // 2026-10-28: cilt payı 0 (pürüzsüzleştirme yok), yanak modelin dokusunda
  assert.ok(Math.abs(at(170, 320)) < 1e-6, `yanak=${at(170, 320)}`);
  assert.equal(at(10, 10), 0);
  assert.equal(fivePoints(P).length, 5);
});

test("yüz netliği: güç 0'da görüntü değişmez, 1'de onarılmış piksel gelir", () => {
  const W = 64, H = 64;
  const img = Buffer.alloc(W * H * 3, 120);
  const rest = new Float32Array(512 * 512 * 3).fill(250);
  const M = new Float32Array(512 * 512).fill(1);
  const T = { a: 8, b: 0, tx: 0, ty: 0 };
  assert.ok(pasteBack(img, W, H, rest, M, T, 0).equals(img));
  assert.equal(pasteBack(img, W, H, rest, M, T, 1)[(10 * W + 10) * 3], 250);
});
