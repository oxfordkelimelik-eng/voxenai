const { test } = require("node:test");
const assert = require("node:assert/strict");
const { removeVerticalComponent } = require("../selfieLight")._testables;

// 2026-11-19: tavan lambasıyla çekilen selfie'de dikey düzeltme koyu sakalı
// açıyordu (çene parlaklığı 105→140). Yalnız sağ-sol bileşen kalmalı.
test("removeVerticalComponent: dikey eğim gider, sağ-sol fark aynen kalır", () => {
  const W = 40, H = 40, N = W * H;
  const D = new Float32Array(N * 3), ws = new Float32Array(N), head = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    head[i] = 1;
    ws[i] = y > 5 && y < 30 ? 1 : 0; // alt satırlar (sakal) deri sayılmıyor
    const v = 0.02 * Math.min(y, 29), h = 0.01 * (x - W / 2); // deri bitince alan sabit uzar (planFlatten "far")
    for (let c = 0; c < 3; c++) D[i * 3 + c] = v + h;
  }
  removeVerticalComponent(D, ws, head, W, H, 4);
  for (const y of [10, 20, 35]) {
    const L = D[(y * W + 5) * 3], R = D[(y * W + 34) * 3];
    assert.ok(Math.abs((R - L) - 0.29) < 1e-4, `satır ${y}: sağ-sol fark korunmalı (${R - L})`);
    assert.ok(Math.abs((L + R) / 2 - 0.01 * (19.5 - W / 2)) < 0.02, `satır ${y}: satır ortası ~0 (${(L + R) / 2})`);
  }
  // Derisiz alt satırda (çene/sakal) dikey artış taşınmaz: en yakın derili satırın ortalaması çıkar.
  const chinMid = D[(38 * W + 20) * 3];
  assert.ok(Math.abs(chinMid) < 0.02, `sakal satırı açılmamalı (${chinMid})`);
});

test("removeVerticalComponent: kafa alfası dışında dokunmaz", () => {
  const W = 10, H = 10, N = W * H;
  const D = new Float32Array(N * 3).fill(0.5), ws = new Float32Array(N).fill(1), head = new Float32Array(N);
  for (let i = 0; i < N; i++) head[i] = i % W < 5 ? 1 : 0;
  for (let i = 0; i < N; i++) if (!head[i]) for (let c = 0; c < 3; c++) D[i * 3 + c] = 0;
  removeVerticalComponent(D, ws, head, W, H, 2);
  for (let i = 0; i < N; i++) if (!head[i]) assert.equal(D[i * 3], 0);
});
