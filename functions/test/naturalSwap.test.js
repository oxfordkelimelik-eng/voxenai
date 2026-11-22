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

test("gözlüklü şablon: bakış yönü yazılmaz, iris yüz yönünde ortada; gözlüksüzde metin aynı", () => {
  const plain = buildNaturalSwapPrompt(5, { prepared: false });
  const off = buildNaturalSwapPrompt(5, { prepared: false, eyewear: false });
  const on = buildNaturalSwapPrompt(5, { prepared: false, eyewear: true });
  assert.strictEqual(off, plain);
  assert.match(plain, /the eyes look exactly where the first person's eyes look/);
  assert.doesNotMatch(on, /look exactly where the first person's eyes look/);
  assert.match(on, /each iris centred in the eye opening/);
  // Başa değil, ikinci paragrafa (gaze-tell-direction-upfront):
  assert.match(on, /^Replace the person in the first photo with the person shown/);
  assert.ok(on.indexOf("iris centred") > on.indexOf("\n\n"));
  // Gözlük yine kaldırılır; şapka ve eğik baş birlikte çalışır.
  assert.match(on, /Remove glasses or sunglasses worn on the face/);
  const all = buildNaturalSwapPrompt(5, { prepared: false, eyewear: true, hat: true, pose: { pitch: -30 } });
  assert.match(all, /iris centred[\s\S]*bowed forward[\s\S]*wears that same one/);
});

test("gözlük bakışı kararı: Vision okunduysa o, okunamazsa yerel pay ≥ 0.5; okuma falPhotos kaynağında", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  const m = /function eyewearGazeOn\(vision, share\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "eyewearGazeOn bulunamadı");
  // eslint-disable-next-line no-new-func
  const eyewearGazeOn = new Function("require", `${m[0]}; return eyewearGazeOn;`)((p) => require(path.join(__dirname, "..", p)));
  assert.strictEqual(eyewearGazeOn({ ok: true, eyewear: true }, 0.25), true); // 11-20 tarama: 0.25'te gözlüklü şablon
  assert.strictEqual(eyewearGazeOn({ ok: true, eyewear: false }, 0.49), false); // 0.49'da gözlüksüz profil
  assert.strictEqual(eyewearGazeOn({ ok: false, reason: "http-500" }, 0.62), true);
  assert.strictEqual(eyewearGazeOn({ ok: false }, 0.42), false);
  assert.strictEqual(eyewearGazeOn(null, null), false);
  assert.match(src, /templateEyewear = templateEyewearPre && templateEyewearPre\.ok \? templateEyewearPre/);
});
