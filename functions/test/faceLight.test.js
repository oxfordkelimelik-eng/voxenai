const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { matchGrayscale, meanSaturation, exposurePlan, huePlan } = require("../faceLight");

test("pozlama kararı: yüz/vücut oranı şablona getirilir, sınırlar içinde", () => {
  const s = (face, body, n = 4000) => ({ face, body, nFace: n, nBody: n });
  // cbdbef13 c8: şablon 78/87, çıktı 100/81 → yüz ~%27 koyulaşır.
  const dark = exposurePlan(s(78, 87), s(100, 81));
  assert.equal(dark.apply, true);
  assert.ok(Math.abs(dark.ratio - 1.38) < 0.01);
  assert.ok(Math.abs(dark.gain - 1 / dark.ratio) < 1e-9);
  assert.equal(exposurePlan(s(50, 100), s(100, 100)).gain, 0.62);
  // c3: yüz koyu kalmış → aydınlatılır, üst sınırda durur.
  const light = exposurePlan(s(137, 149), s(121, 153));
  assert.equal(light.apply, true);
  assert.equal(light.gain, 1.12);
  assert.equal(exposurePlan(s(82, 76), s(125, 117)).reason, "within-tolerance");
  assert.equal(exposurePlan(s(82, 76, 500), s(125, 117)).reason, "no-body-skin");
});

test("ışığın rengi: yüzün renk açısı base'e doğru, payla ve sınırla döner", () => {
  const at = (deg, C = 30, L = 50) => [L, C * Math.cos((deg * Math.PI) / 180), C * Math.sin((deg * Math.PI) / 180)];
  // c3: base 35°, ham çıktı 45° → −10° fark, %60'ı döner.
  const p = huePlan(at(35), at(45));
  assert.equal(p.apply, true);
  assert.ok(Math.abs(p.diff + 10) < 1e-9 && Math.abs(p.shift + 6) < 1e-9, `${p.diff} ${p.shift}`);
  // Çok büyük fark ±10°'de durur.
  assert.equal(huePlan(at(80), at(40)).shift, 10);
  assert.equal(huePlan(at(50), at(52)).reason, "within-tolerance");
  // Siyah-beyaz/soluk base: açı güvenilmez.
  assert.equal(huePlan([46, 0, 0], at(50)).reason, "low-chroma");
  assert.equal(huePlan(null, at(50)).reason, "no-face-skin");
  // Açı sarması: 175° ile −175° arası fark 10°, 350° değil.
  assert.ok(Math.abs(huePlan(at(-175), at(175)).diff - 10) < 1e-9);
});

test("siyah-beyaz şablon: renkli çıktı gri tonlamaya çekilir, renkli şablonda dokunulmaz", async () => {
  const W = 64, H = 64;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
  const color = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 120, b: 90 } } }).png().toBuffer();
  const r = await matchGrayscale(color, gray);
  assert.equal(r.applied, true);
  assert.ok(await meanSaturation(r.buf) < 1);
  assert.equal((await matchGrayscale(color, color)).applied, false);
});

test("siyah-beyaz şablon: gri sahnede küçük renkli yüz de griye çekilir (f9f3b5c0 c4)", async () => {
  const W = 100, H = 100;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
  const face = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 210, g: 150, b: 120 } } }).png().toBuffer();
  const out = await sharp(gray).composite([{ input: face, left: 45, top: 30 }]).png().toBuffer();
  assert.ok(await meanSaturation(out) < 4);
  const r = await matchGrayscale(out, gray);
  assert.equal(r.applied, true);
  assert.ok(await meanSaturation(r.buf) < 0.05);
});
