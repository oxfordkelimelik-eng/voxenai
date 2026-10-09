const { test } = require("node:test");
const assert = require("node:assert/strict");
const { patchFill } = require("../patchFill");

// Dikey şeritli arka plan: dolgu şeritleri sürdürmeli, ortalama/bulanık
// ara ton üretmemeli.
function stripes(W, H) {
  const img = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.floor(x / 6) % 2 ? 200 : 60;
    for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = v;
  }
  return img;
}

test("patchFill: deliği gerçek piksellerle doldurur, ara ton (bulanıklık) üretmez", () => {
  const W = 80, H = 80;
  const img = stripes(W, H);
  const hole = new Uint8Array(W * H);
  for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) { hole[y * W + x] = 1; for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = 0; }
  const n = patchFill(img, W, H, hole, null, { searchR: 40 });
  assert.equal(n, 400);
  for (let i = 0; i < W * H; i++) {
    if (!hole[i]) continue;
    const v = img[i * 3];
    assert.ok(v === 60 || v === 200, "ara ton: " + v);
  }
});

test("patchFill: yasaklı bölge kaynak olarak kullanılmaz", () => {
  const W = 80, H = 80;
  const img = Buffer.alloc(W * H * 3, 120);
  const hole = new Uint8Array(W * H);
  const banned = new Uint8Array(W * H);
  for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) {
    const i = y * W + x;
    if (x < 40) { banned[i] = 1; img[i * 3] = 255; img[i * 3 + 1] = 0; img[i * 3 + 2] = 0; } else hole[i] = 1;
  }
  patchFill(img, W, H, hole, banned, { searchR: 40 });
  for (let i = 0; i < W * H; i++) if (hole[i]) assert.equal(img[i * 3 + 1], 120, "yasaklı renk taşındı");
});

test("patchFill: delik dışına dokunmaz ve dikiş ölçüsünü yazar", () => {
  const W = 60, H = 60;
  const img = stripes(W, H);
  const before = Buffer.from(img);
  const hole = new Uint8Array(W * H);
  for (let y = 25; y < 35; y++) for (let x = 25; x < 35; x++) hole[y * W + x] = 1;
  const stats = {};
  patchFill(img, W, H, hole, null, { searchR: 30, stats });
  for (let i = 0; i < W * H; i++) if (!hole[i]) for (let c = 0; c < 3; c++) assert.equal(img[i * 3 + c], before[i * 3 + c]);
  assert.equal(typeof stats.seam, "number");
});
