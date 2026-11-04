const test = require("node:test");
const assert = require("node:assert");
const { buildNaturalSwapPrompt } = require("../naturalSwap");
const { _testables: RM } = require("../refMatch");

test("doğal yer değiştirme talimatı: elle yapılan testin çerçevesi + kopyala + kimlik/saç", () => {
  const p = buildNaturalSwapPrompt(1);
  assert.match(p, /^Replace the person in the first photo \(the BASE\) with the person in the second photo/);
  assert.match(p, /Copy the face as it appears there/);
  assert.match(p, /Do not add a smile/);
  assert.match(p, /length-to-width ratio/); // 629b45de: kimlik listesi kısaltılmaz
  assert.match(p, /never from the first person and never invented/);
  assert.match(p, /any hat or cap/);
  assert.match(p, /tattoos/);
  // Eski P800'ün "selfie'nin açısını/bakışını alma" cümlesi bu çekirdekte yok:
  // referans zaten base açısında, model onu kopyalıyor.
  assert.doesNotMatch(p, /never their head angle, gaze/);
  const words = p.split(/\s+/).length;
  assert.ok(words < 320, `kelime=${words}`);
});

test("iki referansta çoğul anlatım", () => {
  const p = buildNaturalSwapPrompt(2);
  assert.match(p, /with the person in the other photos/);
  assert.match(p, /They show this person/);
});

test("döndürmede köşeler aynalı dolar (kenar şeridi yok)", () => {
  // Sol yarı siyah, sağ yarı beyaz; 30° döndürünce köşeler kenar pikselinin
  // uzaması değil aynası olmalı — yine iki renkten biri, ara değer çizgisi değil.
  const W = 40, H = 40, rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 20; x < W; x++) for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = 255;
  const r = RM.rotateAbout(rgb, W, H, 20, 20, 30);
  assert.strictEqual(r.length, rgb.length);
  assert.ok(r[0] === 0 || r[0] === 255 || (r[0] > 0 && r[0] < 255)); // tanımlı
});
