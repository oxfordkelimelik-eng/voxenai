const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _testables: FT } = require("../faceTone");

// BOYUN–YÜZ FARKI ÖLÇÜMÜ (2026-11-04, bkz. faceTone.neckFaceDelta): yüz
// kutusu + sınıf olasılıklarından yapay sahne. Yüz derisi L≈50 (gri 119),
// boyun derisi aşağıda; fark boyun − yüz.
const CLASSES = { faceSkin: 0, bodySkin: 1, clothes: 2, hair: 3, others: 4 };

function scene({ W = 60, H = 100, faceGray = 119, neckGray = 119, clothesAtNeck = false } = {}) {
  const N = W * H;
  const P = [0, 1, 2, 3, 4].map(() => new Float32Array(N));
  const box = { x: 15, y: 10, width: 30, height: 40 };
  const chin = box.y + box.height * 1.05;
  const rgb = new Uint8Array(N * 3).fill(30);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const inX = x >= box.x && x < box.x + box.width;
    if (inX && y >= box.y && y <= chin) { P[0][i] = 1; rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = faceGray; }
    else if (inX && y > chin && y <= chin + 0.5 * box.height) {
      if (clothesAtNeck) P[2][i] = 1; else P[1][i] = 1;
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = neckGray;
    }
  }
  const S = { P, CLASSES, W, H, box, work: rgb };
  return { S, rgbAt: (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] };
}

test("neckFaceDelta: aynı tonda yüz ve boyun → fark ≈ 0", () => {
  const { S, rgbAt } = scene();
  const r = FT.neckFaceDelta(S, rgbAt);
  assert.ok(r, "ölçüm olmalı");
  assert.ok(Math.abs(r.delta) < 0.01, `fark ${r.delta}`);
  assert.ok(r.nNeck >= 50);
});

test("neckFaceDelta: yüz açık, boyun koyu → fark negatif ve büyüklüğü anlamlı", () => {
  const { S, rgbAt } = scene({ faceGray: 170, neckGray: 100 });
  const r = FT.neckFaceDelta(S, rgbAt);
  assert.ok(r.delta < -20, `fark ${r.delta}`);
  assert.ok(r.face > r.neck);
});

test("neckFaceDelta: boyunda kıyafet varsa (deri yok) ölçüm null", () => {
  const { S, rgbAt } = scene({ clothesAtNeck: true });
  assert.equal(FT.neckFaceDelta(S, rgbAt), null);
});

test("neckFaceDelta: rgbAt ile farklı kaynaktan (sonrası) okunabilir", () => {
  const { S } = scene({ faceGray: 170, neckGray: 100 });
  // "Sonrası": yüz koyulaştırılmış hâli ayrı bir tampondan okunuyor.
  const after = (i) => (S.P[0][i] > 0.5 ? [100, 100, 100] : [100, 100, 100]);
  const r = FT.neckFaceDelta(S, after);
  assert.ok(Math.abs(r.delta) < 0.01, `fark ${r.delta}`);
});
