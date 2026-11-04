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

test("en büyük süzgeci tek noktayı kare olarak genişletir", () => {
  const W = 9, H = 7;
  const src = new Float32Array(W * H);
  src[3 * W + 4] = 0.8;
  const out = T.maxField(src, W, H, 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = Math.abs(x - 4) <= 2 && Math.abs(y - 3) <= 2;
      assert.ok(Math.abs(out[y * W + x] - (inside ? 0.8 : 0)) < 1e-6, `(${x},${y})=${out[y * W + x]}`);
    }
  }
  assert.equal(src[0], 0);
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

// TAM UYUŞMA (2026-10-26, e25dc241, kullanıcı: "yüzün cilt tonu vücudun diğer
// tüm yerleri ile tam uyuşma içerisinde olmalı"): şablonun vücut/yüz ışık
// oranı payı kalktı, hedef yüzün kendisi.
test("şablonda gölgedeki vücut da yüz tonuna çekilir (oran payı yok)", () => {
  const N = 100;
  const field = fieldOf(N, () => [57, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  const p = T.planCorrection(field, limbW, [66, 20, 18], N, 0.85);
  assert.equal(p.needed, true);
  assert.ok(Math.abs(p.dL[0] - 9) < 0.01, `dL=${p.dL[0]}`);
  for (const r of [0.4, 0.85, 1, 1.3, null]) assert.equal(T.bodyTargetL(66, r), 66);
});

test("gölgedeki el yüzden en çok ışık izi tavanı kadar koyu kalır", () => {
  const N = 100;
  // Uzuv: yarısı boyun (L 56), yarısı gölgedeki el (L 30). Yüz 58.
  const field = fieldOf(N, (i) => [i < 50 ? 56 : 30, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  const p = T.planCorrection(field, limbW, [58, 20, 18], N);
  const handAfter = 30 + p.dL[99], neckAfter = 56 + p.dL[0];
  assert.ok(handAfter >= 58 - 6 - 0.01, `el ${handAfter}`);
  assert.ok(Math.abs(neckAfter - 58) <= 6, `boyun ${neckAfter}`);
});

// RENK SELFIE'DEN, IŞIK SAHNEDEN (2026-10-28, 546b514b c0: çene altı gölgedeki
// boyun yüz parlaklığına çekilip tişörte taştı).
test("şablon gölgeli plan: gölgedeki boyun yüz eksi şablon gölgesine gider, yüze eşitlenmez", () => {
  const N = 100;
  const field = fieldOf(N, () => [40, 14, 12]);
  const limbW = new Float32Array(N).fill(1);
  const local = { shade: new Float32Array(N).fill(-12), w: new Float32Array(N).fill(1) };
  const p = T.planShadeCorrection(field, limbW, [58, 20, 18], N, local, 0.5);
  // hedef 58 − 12 = 46 → +6 L (yüze, +18'e değil); kroma yüze
  assert.ok(Math.abs(p.dL[0] - 6) < 0.01, `dL=${p.dL[0]}`);
  assert.ok(Math.abs(p.dA[0] - 6) < 0.01 && Math.abs(p.dB[0] - 6) < 0.01);
  assert.equal(p.stats.shaded, true);
});

test("şablon gölgeli plan: şablonda ışık farkı güçlüyse vücut karartılmaz, ılımlıysa kararır", () => {
  const N = 100;
  const field = fieldOf(N, () => [55, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  // şablonda yüz çok parlak, vücut gölgede (ab c8): gölge −20 → karartma yok
  const strong = T.planShadeCorrection(field, limbW, [63, 20, 18], N, { shade: new Float32Array(N).fill(-20), w: new Float32Array(N).fill(1) }, 0.5);
  assert.ok(strong.dL[0] >= -0.01, `dL=${strong.dL[0]}`);
  // ılımlı gölge (−2): vücut yüzden açıksa tenine göre kararır
  const mild = T.planShadeCorrection(field, limbW, [45, 20, 18], N, { shade: new Float32Array(N).fill(-2), w: new Float32Array(N).fill(1) }, 0.5);
  assert.ok(mild.dL[0] < -10, `dL=${mild.dL[0]}`);
});

test("şablon gölgeli plan: şablonda karşılığı olmayan noktada ortanca ten farkı, kendi ışığı korunur", () => {
  const N = 100;
  // yarısı şablonda deri (w=1, gölge 0), yarısı karşılıksız (w=0); karşılıksız yarı 10 L daha koyu (gölge)
  const field = fieldOf(N, (i) => [i < 50 ? 50 : 40, 20, 18]);
  const limbW = new Float32Array(N).fill(1);
  const w = new Float32Array(N); for (let i = 0; i < 50; i++) w[i] = 1;
  const p = T.planShadeCorrection(field, limbW, [56, 20, 18], N, { shade: new Float32Array(N), w }, 0.5);
  assert.ok(Math.abs(p.dL[0] - 6) < 0.01, `karşılıklı dL=${p.dL[0]}`);
  // karşılıksız: kendi 40 + ortanca fark 6 = 46 (gölgesi korunur, yüze çekilmez)
  assert.ok(Math.abs(p.dL[99] - 6) < 0.01, `karşılıksız dL=${p.dL[99]}`);
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

test("planFaceMatch: yüz vücuttan koyuysa açılır, karartılmaz", () => {
  const N = 80;
  const field = fieldOf(N, () => [55, 18, 20]);
  const limbW = new Float32Array(N).fill(0.8);
  const p = T.planFaceMatch([42, 18, 20], limbW, field, N);
  assert.equal(p.needed, true);
  assert.ok(p.dL > 5 && p.dL <= 12, `dL=${p.dL}`);
  const bright = T.planFaceMatch([70, 18, 20], limbW, field, N);
  assert.equal(bright.needed, false);
});

test("planFaceMatch: yüz-kol kroma farkı varsa kaydırır", () => {
  const N = 80;
  const field = fieldOf(N, () => [50, 22, 24]);
  const limbW = new Float32Array(N).fill(0.8);
  const p = T.planFaceMatch([50, 10, 8], limbW, field, N);
  assert.equal(p.needed, true);
  assert.ok(p.dA > 0 && p.dB > 0);
});
