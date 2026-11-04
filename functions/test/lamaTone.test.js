const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harmonizeFill } = require("../lamaFill");
const { faceOval, inPolygon } = require("../headSurround");

// KENAR TON UYUMU (2026-10-26, 9987f742 c0): koyu dolgu çevresine eşitlenir.
test("ton uyumu: çevreden koyu dolgu çevrenin tonuna çekilir, dokusu kalır", () => {
  const side = 64, N = side * side;
  const ref = Buffer.alloc(N * 3, 200);
  const filled = Buffer.alloc(N * 3);
  const hole = new Uint8Array(N), refOk = new Uint8Array(N);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = y * side + x;
    const inHole = x >= 20 && x < 30 && y >= 10 && y < 54;
    hole[i] = inHole ? 1 : 0;
    refOk[i] = inHole ? 0 : 1;
    // dolgu: 150 tabanı + dikey çizgili doku (±6)
    const v = inHole ? 150 + (x % 2 ? 6 : -6) : 200;
    for (let c = 0; c < 3; c++) filled[i * 3 + c] = v;
  }
  const out = harmonizeFill(filled, ref, hole, refOk, side);
  let sum = 0, n = 0;
  for (let i = 0; i < N; i++) if (hole[i]) { sum += out[i * 3]; n++; }
  assert.ok(Math.abs(sum / n - 200) < 3, `ortalama=${sum / n}`);
  // doku korunur: komşu sütun farkı ~12
  const a = out[(30 * side + 24) * 3], b = out[(30 * side + 25) * 3];
  assert.ok(Math.abs(Math.abs(a - b) - 12) <= 2, `doku ${a}/${b}`);
  // delik dışı değişmez
  assert.equal(out[(5 * side + 5) * 3], 200);
});

test("ton uyumu: bilinen kenar yoksa dolgu değişmez", () => {
  const side = 16, N = side * side;
  const filled = Buffer.alloc(N * 3, 90);
  const out = harmonizeFill(filled, Buffer.alloc(N * 3, 200), new Uint8Array(N).fill(1), new Uint8Array(N), side);
  assert.ok(out.equals(filled));
});

// YÜZ OVALİ (2026-10-26, 9987f742 c1): alın dahil yüzün içi dolmaz.
test("yüz ovali: alın içeride, kafanın üstü ve yanı dışarıda", () => {
  const P = Array.from({ length: 68 }, () => ({ x: 200, y: 200 }));
  for (let i = 0; i <= 16; i++) P[i] = { x: 140 + 7.5 * i, y: 200 + (Math.abs(8 - i) < 3 ? 70 : 40) };
  P[8] = { x: 200, y: 280 };
  for (let i = 17; i <= 26; i++) P[i] = { x: 160 + 9 * (i - 17), y: 170 };
  const oval = faceOval(P);
  // kaş 170, çene 280 → alın 0.4 x 110 = 44 px yukarı (126'ya kadar)
  assert.equal(inPolygon(oval, 200, 140), true);
  assert.equal(inPolygon(oval, 200, 110), false);
  assert.equal(inPolygon(oval, 100, 220), false);
  assert.equal(inPolygon(oval, 200, 250), true);
});

// KABA-İNCE (2026-10-26, 9987f742 c6): yalnız doğal çözünürlükte parçalanacak maske.
test("kaba-ince: tek parçaya sığmayan maske parçalanır, sığan ve küçük kırpım parçalanmaz", () => {
  const { needsTiles } = require("../lamaFill");
  const box = (side, x0, y0, x1, y1) => {
    const m = new Uint8Array(side * side);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * side + x] = 1;
    return m;
  };
  // 512 - 2*64 - 8 = 376; 376 / 0.75 ≈ 501 px'e kadar küçültmeyle tek parça
  assert.equal(needsTiles(box(1300, 100, 100, 1000, 900), 1300), true);
  assert.equal(needsTiles(box(1300, 100, 100, 560, 560), 1300), false);
  assert.equal(needsTiles(box(400, 0, 0, 400, 400), 400), false); // 512'den küçük kırpım büyütülür
  assert.equal(needsTiles(new Uint8Array(1300 * 1300), 1300), false);
});
