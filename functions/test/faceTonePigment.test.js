"use strict";
// YÜZ IŞIĞI PİGMENTİ İKİ YÖN (2026-11-22, kullanıcı: "koyu tenli selfie, açık tenli base'de de doğru
// çalışıyor mu"): açık şablon kişisinde yalnız haksız açma kesilir, karartma değişmez.
const test = require("node:test");
const assert = require("node:assert");
const T = require("../faceTone")._testables;
const { albedoRatio } = require("../faceRelight");

const Yof = (L) => ((L + 16) / 116) ** 3;
const face = (L) => ({ Y: Yof(L), a: 12, b: 16 });

test("açık şablon + koyu tenli kullanıcı: ten farkı kadar açma kesilir", () => {
  // albedoRatio 1 adım ölü bölge uygular (MST tahmin hatasına karşı): 8↔3 farkı 7↔3 sayılır
  // (MST_L 47 ↔ 69). Aynı ışıkta bu iki ten: açma tamamen kalkar.
  const tpl = face(69), out = face(47);
  const plan = T.planTone(tpl, out, 1);
  assert.ok(plan.logGain > 0, "pigmentsiz plan açıyordu (eski davranış)");
  const cap = T.capLighterTemplate(plan, tpl, out, albedoRatio(8, 3));
  assert.ok(cap && cap.from > 0);
  assert.strictEqual(plan.logGain, 0, "pigmentten arındırılmış fark açmaya izin vermiyor");
});

test("açık şablon + koyu tenli kullanıcı (≥3 adım, ölü bölgesiz): aynı ışıkta hiç açmaz", () => {
  const tpl = face(69), out = face(40); // MST 3 ↔ MST 8 tam L değerleri
  const plan = T.planTone(tpl, out, 1);
  assert.ok(plan.logGain > 0);
  T.capLighterTemplate(plan, tpl, out, albedoRatio(8, 3, 0));
  assert.strictEqual(plan.logGain, 0);
});

test("açık şablon: gerçek ışık farkı (şablon sahnesi daha aydınlık) kadar açma kalır", () => {
  const out = face(40);
  const tpl = face(78); // ten farkının ötesinde de parlak
  const plan = T.planTone(tpl, out, 1);
  const before = plan.logGain;
  const albedo = albedoRatio(6, 4); // 2 adım: ölü bölge sonrası küçük oran
  T.capLighterTemplate(plan, tpl, out, albedo);
  assert.ok(plan.logGain > 0 && plan.logGain <= before);
});

test("karartma ve koyu şablon yönü değişmez", () => {
  const darken = T.planTone(face(40), face(60), 1);
  assert.ok(darken.logGain < 0);
  const g = darken.logGain;
  assert.strictEqual(T.capLighterTemplate(darken, face(40), face(60), 0.4), null);
  assert.strictEqual(darken.logGain, g);
  const brighten = T.planTone(face(70), face(50), 1);
  const b = brighten.logGain;
  assert.strictEqual(T.capLighterTemplate(brighten, face(70), face(50), 1), null, "albedo 1: dokunulmaz");
  assert.strictEqual(T.capLighterTemplate(brighten, face(70), face(50), 1.9), null, "koyu şablon yönü ayrı yolda");
  assert.strictEqual(brighten.logGain, b);
});

// İKİ YÖN SİMETRİK (2026-11-22, kullanıcı: "base siyahi, selfie beyazsa yüz siyaha yaklaşmamalı; ya da
// tersi"): ≥3 adımda ölü bölge iki yönde de yok, boyun işareti kapalı.
const MST_L = [null, 75, 72, 69, 65, 60, 54, 47, 40, 33, 27];
test("pigmentAlbedos: koyu şablon ≥3 adım tam oran, açık şablon ≥3 adım tam oran", () => {
  const a = T.pigmentAlbedos(2, 9);
  assert.ok(Math.abs(a.albedo - Yof(MST_L[2]) / Yof(MST_L[9])) < 1e-9, "beyaz kullanıcı / siyahi şablon: tam oran");
  assert.strictEqual(a.albedoLight, 1);
  assert.strictEqual(a.pigmentApart, true);
  const b = T.pigmentAlbedos(9, 2);
  assert.ok(Math.abs(b.albedoLight - Yof(MST_L[9]) / Yof(MST_L[2])) < 1e-9, "siyahi kullanıcı / beyaz şablon: tam oran");
  assert.strictEqual(b.albedo, 1);
  assert.strictEqual(b.pigmentApart, true);
});

test("pigmentAlbedos: 2 adımda ölü bölge sürer, boyun açık; ölçü yoksa nötr", () => {
  const a = T.pigmentAlbedos(5, 7);
  assert.ok(Math.abs(a.albedo - Yof(MST_L[6]) / Yof(MST_L[7])) < 1e-9);
  assert.strictEqual(a.pigmentApart, false);
  assert.deepStrictEqual(T.pigmentAlbedos(null, 7), { albedo: 1, albedoLight: 1, pigmentApart: false });
  assert.deepStrictEqual(T.pigmentAlbedos(5, 5), { albedo: 1, albedoLight: 1, pigmentApart: false });
});

test("beyaz kullanıcı + siyahi şablon, aynı ışık, karanlık sahne: yüz karartılmaz", () => {
  const tpl = face(MST_L[9]), out = face(MST_L[2]);
  const { albedo } = T.pigmentAlbedos(2, 9);
  const plan = T.planTone(tpl, out, albedo, { darkScene: true });
  assert.strictEqual(plan.logGain, 0);
  // Eski ölü bölgeli oran bir adım karartıyordu.
  const old = T.planTone(tpl, out, albedoRatio(2, 9), { darkScene: true });
  assert.ok(old.logGain < -0.05, `eski davranış karartıyordu (${old.logGain})`);
});

test("siyahi kullanıcı + beyaz şablon, aynı ışık: yüz açılmaz", () => {
  const tpl = face(MST_L[2]), out = face(MST_L[9]);
  const { albedo, albedoLight } = T.pigmentAlbedos(9, 2);
  const plan = T.planTone(tpl, out, albedo);
  assert.ok(plan.logGain > 0);
  T.capLighterTemplate(plan, tpl, out, albedoLight);
  assert.strictEqual(plan.logGain, 0);
});

test("ten farkı aynı ama sahne gerçekten karanlık: karartma kalır (ışık yine taşınır)", () => {
  // Şablon sahnesi kullanıcının teninin 0.6 katı ışık veriyor.
  const tpl = { Y: Yof(MST_L[9]) * 0.6, a: 12, b: 16 }, out = face(MST_L[2]);
  const { albedo } = T.pigmentAlbedos(2, 9);
  const plan = T.planTone(tpl, out, albedo, { darkScene: true });
  assert.ok(plan.logGain < -0.3, `ışık farkı karartılmalı (${plan.logGain})`);
});
