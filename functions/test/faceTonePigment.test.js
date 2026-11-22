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
