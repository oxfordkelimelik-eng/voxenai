const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _testables: T } = require("../skinTone");

// TEN TONU ALANI (2026-10-07). Sentetik alanlar: düzeltme planının iki tonlu
// kolu gidermesi, uyumlu karede hiçbir şey yapmaması, sakal bandının yüz
// ölçümüne girmemesi ve arka plandaki kişinin dışlanması.

function fieldOf(N, fn) {
  const fL = new Float32Array(N), fA = new Float32Array(N), fB = new Float32Array(N);
  for (let i = 0; i < N; i++) [fL[i], fA[i], fB[i]] = fn(i);
  return { fL, fA, fB };
}

test("bulanıklık sabit alanı korur", () => {
  const W = 20, H = 10;
  const src = new Float32Array(W * H).fill(3);
  const out = T.blurField(src, W, H, 4);
  for (const v of out) assert.ok(Math.abs(v - 3) < 1e-4);
});

test("iki tonlu kol: yayılım ve yüz farkı birlikte küçülür", () => {
  const N = 100;
  // Kolun yarısı şablon teni (koyu, L 40), yarısı açık (L 62). Yüz L 66.
  const field = fieldOf(N, (i) => [i < 50 ? 40 : 62, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  const p = T.planCorrection(field, limbW, [66, 20, 18], N);
  assert.equal(p.needed, true);
  assert.ok(p.stats.spreadBefore > 20, `önce=${p.stats.spreadBefore}`);
  assert.ok(p.stats.spreadAfter < p.stats.spreadBefore * 0.5, `sonra=${p.stats.spreadAfter}`);
  // Koyu yarı açık yarıdan daha çok açılır.
  assert.ok(p.dL[0] > p.dL[99] + 10, `koyu=${p.dL[0]} açık=${p.dL[99]}`);
});

test("uzuv zaten yüz tonundaysa düzeltme gerekmez", () => {
  const N = 100;
  const field = fieldOf(N, () => [65, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  const p = T.planCorrection(field, limbW, [66, 20.5, 18.2], N);
  assert.equal(p.needed, false);
});

test("uzuv yoksa plan kurulmaz", () => {
  const N = 100;
  const field = fieldOf(N, () => [40, 20, 18]);
  const p = T.planCorrection(field, new Float32Array(N), [66, 20, 18], N);
  assert.equal(p, null);
});

test("yüz tonu sakal bandını almaz", () => {
  // 100x100 yüz kutusu: üst yarı açık ten (alın/elmacık/burun), alt %60'tan
  // sonrası koyu sakal. Ölçülen ton açık tene yakın olmalı.
  const W = 100, H = 100;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const [r, g, b] = y < 61 ? [215, 165, 140] : [95, 70, 55];
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  }
  const tone = T.faceToneOf(rgb, W, H, { x: 0, y: 0, width: 100, height: 100 });
  assert.ok(tone[0] > 65, `L=${tone[0]}`);
});

test("ana kişi bileşeni arka plandaki kişiyi dışlar", () => {
  const W = 60, H = 40;
  const person = new Float32Array(W * H);
  for (let y = 5; y < 35; y++) {
    for (let x = 5; x < 20; x++) person[y * W + x] = 0.9;   // ana kişi
    for (let x = 40; x < 50; x++) person[y * W + x] = 0.9;  // arka plandaki kişi
  }
  const pc = T.mainPersonComponent(person, W, H, { x: 8, y: 6, width: 8, height: 8 });
  assert.equal(pc.comp[10 * W + 10], 1);
  assert.equal(pc.comp[10 * W + 45], 0);
});

test("segmentasyon modeli 6 sınıf döndürür ve olasılıklar toplanır", async () => {
  const { classProbs } = require("../skinSeg");
  const W = 64, H = 64;
  const rgb = Buffer.alloc(W * H * 3, 128);
  const P = await classProbs(rgb, W, H);
  assert.equal(P.length, 6);
  const i = 32 * W + 32;
  const sum = P.reduce((a, p) => a + p[i], 0);
  // 8 bitlik nicemleme yüzünden tam 1 değil.
  assert.ok(Math.abs(sum - 1) < 0.05, `toplam=${sum}`);
});
