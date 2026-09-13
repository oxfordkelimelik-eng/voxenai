const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  largestComponent,
  rgbToLab,
  medianOf,
  PATCH_MIN_L_ABOVE_SKIN,
  PATCH_MAX_CHROMA_RATIO,
} = require("../faceArtifact");

// --- rgbToLab ------------------------------------------------------------
// Ölçümün taşıyıcı sinyali KROMA: yamalar nötr gri (R≈G≈B), ten sıcak.
// Bu ayrımın doğru hesaplandığını kilitle.

test("nötr gri düşük kroma verir (yamanın imzası)", () => {
  // Gerçek piksel: 226,225,230 — şikâyet edilen alın yaması (23eb1a78_2)
  const p = rgbToLab(226, 225, 230);
  const chroma = Math.hypot(p.a, p.b);
  assert.ok(chroma < 4, `nötr gri kroması ${chroma.toFixed(2)} < 4 olmalı`);
  assert.ok(p.L > 85, `yama parlak olmalı, L=${p.L.toFixed(1)}`);
});

test("ten rengi yüksek kroma verir", () => {
  // Gerçek piksel: 180,124,99 — aynı karedeki normal alın teni
  const p = rgbToLab(180, 124, 99);
  const chroma = Math.hypot(p.a, p.b);
  assert.ok(chroma > 20, `ten kroması ${chroma.toFixed(2)} > 20 olmalı`);
});

test("yama ile ten arasındaki fark iki eşiği de aşar", () => {
  const patch = rgbToLab(226, 225, 230);
  const skin = rgbToLab(180, 124, 99);
  const patchChroma = Math.hypot(patch.a, patch.b);
  const skinChroma = Math.hypot(skin.a, skin.b);
  assert.ok(patch.L - skin.L > PATCH_MIN_L_ABOVE_SKIN);
  assert.ok(patchChroma < skinChroma * PATCH_MAX_CHROMA_RATIO);
});

test("doğal parlak ten kromayı KORUR — yama sayılmaz", () => {
  // Işık alan ten: açıldı ama sıcaklığını kaybetmedi.
  const lit = rgbToLab(235, 190, 165);
  const skin = rgbToLab(180, 124, 99);
  const litChroma = Math.hypot(lit.a, lit.b);
  const skinChroma = Math.hypot(skin.a, skin.b);
  assert.ok(lit.L - skin.L > PATCH_MIN_L_ABOVE_SKIN, "parlak ten daha açık");
  // Kroma kuralı bunu ELEMEZ — kapının yanlış pozitif vermemesinin sebebi.
  assert.ok(
    litChroma >= skinChroma * PATCH_MAX_CHROMA_RATIO,
    `parlak ten kroması (${litChroma.toFixed(1)}) eşiğin altına düşmemeli`
  );
});

// --- largestComponent ----------------------------------------------------

test("tek dikdörtgen blok: boyut, kutu ve doluluk", () => {
  const w = 10, h = 10;
  const mask = new Uint8Array(w * h);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 7; x++) mask[y * w + x] = 1;
  const r = largestComponent(mask, w, h);
  assert.equal(r.size, 12);          // 3 satır x 4 sütun
  assert.deepEqual(r.box, { x0: 3, y0: 2, w: 4, h: 3 });
  assert.equal(r.fill, 1);           // tam dolu dikdörtgen — yamanın şekli
});

test("iki ayrı blok varsa BÜYÜK olan döner", () => {
  const w = 12, h = 6;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;                                     // 1 px'lik gürültü
  for (let y = 2; y < 5; y++) for (let x = 5; x < 9; x++) mask[y * w + x] = 1;
  const r = largestComponent(mask, w, h);
  assert.equal(r.size, 12);
});

test("çapraz komşuluk BİRLEŞTİRMEZ (4-komşuluk)", () => {
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;           // (0,0)
  mask[1 * w + 1] = 1;   // (1,1) — yalnızca çapraz komşu
  const r = largestComponent(mask, w, h);
  assert.equal(r.size, 1);
});

test("dağınık gürültünün dolulukları düşük olur", () => {
  // L şeklinde bileşen: sınırlayıcı kutuyu doldurmaz.
  const w = 6, h = 6;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < 4; y++) mask[y * w + 1] = 1;
  for (let x = 1; x < 5; x++) mask[3 * w + x] = 1;
  const r = largestComponent(mask, w, h);
  assert.ok(r.fill < 0.6, `L şekli doluluk ${r.fill.toFixed(2)} < 0.6`);
});

test("boş maskede null döner", () => {
  assert.equal(largestComponent(new Uint8Array(16), 4, 4), null);
});

// --- medianOf ------------------------------------------------------------

test("medianOf: tek ve çift uzunluk, girdiyi bozmaz", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  const input = [4, 1, 3, 2];
  assert.equal(medianOf(input), 3);
  assert.deepEqual(input, [4, 1, 3, 2], "girdi dizisi değişmemeli");
  assert.equal(medianOf([]), null);
});
