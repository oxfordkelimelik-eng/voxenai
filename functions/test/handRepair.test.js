"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { HAND_REPAIR, _testables: T } = require("../handRepair");
const { maxField, blurField } = require("../skinTone")._testables;

test("el onarımı: iki yönlü — şablon ≥3 koyu ya da kullanıcı ≥3 koyu", () => {
  assert.strictEqual(T.eligible(5, 8), true);
  assert.strictEqual(T.eligible(5, 7), false); // 11-26: 2 adım artık yetmez (MST_GAP 3)
  assert.strictEqual(T.eligible(5, 6), false); // ölü bölge
  assert.strictEqual(T.eligible(4, 6), false); // 11-26: bronz MST 6 manken, ücretsiz ten katmanı yetiyor
  assert.strictEqual(T.eligible(4, 7), true);
  assert.strictEqual(T.eligible(5, 3), false); // şablon 2 adım açık: tetiklenmez (MST 5 kullanıcının çoğu açık şablonu)
  assert.strictEqual(T.eligible(5, 2), true); // şablon 3 adım açık
  assert.strictEqual(T.eligible(8, 3), true); // koyu tenli kullanıcı, açık şablon
  assert.strictEqual(T.eligible(9, 7), false); // kullanıcı yalnız 2 adım koyu (< 3)
  assert.strictEqual(T.eligible(9, 6), true);
  assert.strictEqual(T.eligible(5, null), false); // pigment ölçülemedi
  assert.strictEqual(T.eligible(null, 8), false);
});

test("el onarımı: yüzden AÇIK ve doygun el de uyumsuz sayılır (09-18 şikâyeti, iki yönlü)", () => {
  assert.strictEqual(T.handsMatch({ dL: -6.9, dC: 6.5 }), false); // el yüzden 6.9 açık
  assert.strictEqual(T.handsMatch({ dL: 10, dC: 1 }), false); // el koyu
  assert.strictEqual(T.handsMatch({ dL: 1.0, dC: 6 }), false); // yalnız renk farkı
  assert.strictEqual(T.handsMatch({ dL: 1.3, dC: 1.8 }), true); // temiz kare
  assert.strictEqual(T.handsMatch(null), false); // ölçülemedi → onarım kararını engellemez
});

test("el onarımı: küçük bileşenler atılır, büyükler kalır", () => {
  const W = 20, H = 10, m = new Float32Array(W * H);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) m[y * W + x] = 1; // 25 px
  m[9 * W + 19] = 1; // 1 px
  const kept = T.dropSmallComponents(m, W, H, 5);
  assert.strictEqual(kept, 25);
  assert.strictEqual(m[9 * W + 19], 0);
  assert.strictEqual(m[0], 1);
});

test("el onarımı: maske yüz elipsine asla girmez", () => {
  const W = 100, H = 100, N = W * H;
  const region = new Float32Array(N).fill(1); // her yer deri
  const box = { x: 40, y: 10, width: 20, height: 24 };
  const mk = T.buildLimbMask({ W, H, region, box }, HAND_REPAIR, { maxField, blurField });
  assert.ok(mk.soft);
  const cx = 50, cy = 22;
  assert.strictEqual(mk.soft[cy * W + cx], 0);
  assert.strictEqual(mk.hard[cy * W + cx], 0);
  assert.ok(mk.soft[90 * W + 50] > 0.5); // aşağıdaki gövde/el bölgesi açık
});

test("el onarımı: yüz koruması elips içinde 0, dışına doğru yumuşak rampa (keskin dikiş yok)", () => {
  const box = { x: 40, y: 10, width: 20, height: 24 };
  assert.strictEqual(T.faceGuard(50, 22, box), 0);
  const ry = (box.height / 2) * HAND_REPAIR.FACE_GUARD * 1.25;
  const at = (k) => T.faceGuard(49.5, 22 - 0.5 + ry * k, box);
  assert.strictEqual(at(0.99), 0);
  assert.ok(at(1.2) > 0 && at(1.2) < 0.5);
  assert.ok(at(1.5) > 0.5 && at(1.5) < 1);
  assert.strictEqual(at(HAND_REPAIR.GUARD_RAMP_OUT + 0.05), 1);
});

test("el onarımı: ölçülemeyen doğrulama kabul edilmez, bütçe tahmini medium çağrı kadar", () => {
  assert.ok(HAND_REPAIR.EST_USD >= 0.11);
  assert.ok(HAND_REPAIR.STRUCT_MIN > 0 && HAND_REPAIR.ACCEPT_GAP_MAX > 0);
});

test("el onarımı: deri alanı yüzün küçük bir kesriyse maske yok", () => {
  const W = 100, H = 100, region = new Float32Array(W * H);
  region[90 * W + 90] = 1;
  const mk = T.buildLimbMask({ W, H, region, box: { x: 40, y: 10, width: 20, height: 24 } }, HAND_REPAIR, { maxField, blurField });
  assert.strictEqual(mk.soft, null);
});

test("el onarımı: halka üzerinden kayma bulunur", () => {
  const w = 64, h = 64, a = new Float32Array(w * h), b = new Float32Array(w * h), ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = ((x * 7 + y * 13) % 31) * 8 + (x % 5) * 3;
  // b = a, (dx=+3, dy=-2) kaymış: b[y+dy][x+dx] = a[y][x]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xs = x - 3, ys = y + 2;
    b[y * w + x] = xs >= 0 && xs < w && ys >= 0 && ys < h ? a[ys * w + xs] : 0;
  }
  for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) if (x < 16 || x > 48 || y < 16 || y > 48) ring[y * w + x] = 1;
  const s = T.bestShift(a, b, ring, w, h, 5);
  assert.deepStrictEqual([s.dx, s.dy], [3, -2]);
});

test("el onarımı: aynı yapı yüksek, rastgele düşük kenar korelasyonu", () => {
  const w = 40, h = 40, a = new Float32Array(w * h), c = new Float32Array(w * h), m = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { a[y * w + x] = x > 20 ? 200 : 50; c[y * w + x] = (x * 37 + y * 91) % 97; }
  const lighter = a.map((v) => v * 1.2 + 10);
  assert.ok(T.edgeNcc(a, lighter, w, h, m) > 0.99);
  assert.ok(T.edgeNcc(a, c, w, h, m) < HAND_REPAIR.STRUCT_MIN);
});
