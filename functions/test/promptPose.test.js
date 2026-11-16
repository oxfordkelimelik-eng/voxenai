// Promptta base pozu sayıyla (2026-11-08, bkz. naturalSwap.describeBasePose, falPhotos PROMPT_POSE_ON).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildNaturalSwapPrompt, _testables: { describeBasePose } } = require("../naturalSwap");

test("describeBasePose: yönler görüntüye göre, eşik altı düz/dik", () => {
  const s = describeBasePose({ yaw: -21.4, pitch: -29.7, roll: null, chinX: 0.471, chinY: 0.41, faceW: 0.114 });
  assert.match(s, /turned about 21° toward the left side of the picture/);
  // −24°'nin altı: eğik baş tarifi (2026-11-12, bkz. naturalSwap.BOWED_PITCH_DEG).
  assert.match(s, /bowed forward and down about 30°, tipping forward at the top of the neck: the face is seen from slightly above/);
  // 2026-11-13 boyun: yaka cümlesi baş aşağı kaydırıyordu → yok; baş batmaz, boyun görünür kalır.
  assert.doesNotMatch(s, /tucked|collar, the face/);
  assert.match(s, /The head tips forward without sinking: the top of the head, the eyes and the ears stay at the same height/);
  assert.match(s, /the neck between the jaw and the collar stays as long and as visible as it is in the first photo.$/);
  assert.match(s, /this head stays bowed exactly this much. Match the eye direction by moving the eyes only/);
  assert.doesNotMatch(s, /chin lowered/);
  const mild = describeBasePose({ yaw: -21.4, pitch: -9.3, roll: null });
  assert.match(mild, /tilted down about 9°, chin lowered/);
  assert.doesNotMatch(mild, /bowed|stays bowed|moving the eyes only/);
  assert.doesNotMatch(s, /leans/);
  assert.match(s, /47% of the way from the left edge and 41% of the way from the top/);
  assert.match(s, /about 11% of the picture's width/);
  const f = describeBasePose({ yaw: 2, pitch: 6, roll: 5 });
  assert.match(f, /turned straight to the camera/);
  assert.match(f, /tilted up about 6°, chin raised/);
  assert.match(f, /top of the head toward the left side/);
  assert.doesNotMatch(f, /chin is/);
  assert.match(describeBasePose({ yaw: 30, pitch: 1, roll: -1 }), /right side of the picture.*level.*upright/);
  assert.strictEqual(describeBasePose(null), "");
  assert.strictEqual(describeBasePose({ yaw: NaN }), "");
});

test("selfie seti promptu: poz yoksa değişmez, varsa baş açısı paragrafında (başta değil)", () => {
  const base = buildNaturalSwapPrompt(5, { prepared: false });
  assert.strictEqual(buildNaturalSwapPrompt(5, { prepared: false, pose: null }), base);
  const pose = { yaw: 16.2, pitch: -9.3, roll: null, chinX: 0.37, chinY: 0.38, faceW: 0.14 };
  const p = buildNaturalSwapPrompt(5, { prepared: false, pose });
  assert.ok(p.startsWith("Replace the person in the first photo (the BASE)"));
  assert.ok(p.includes("exactly where the first person's eyes look. Measured in the first photo: "));
  assert.ok(p.includes("whatever angles the other photos show. A relaxed, neutral"));
  assert.strictEqual(p.replace(describeBasePose(pose), ""), base);
  // Hazırlanmış referans yolu pozdan etkilenmez.
  assert.strictEqual(buildNaturalSwapPrompt(2, { pose }), buildNaturalSwapPrompt(2));
});

test("falPhotos: poz şablon başına ölçülür, sıfırlanır ve prompta gider", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /const PROMPT_POSE_ON = (true|false);/);
  assert.match(src, /templatePromptPose = null;\r?\n        templateMeta = null;\r?\n        templateIris = undefined;/);
  assert.match(src, /const swapOpts = \{ hat: !!\(tplHat && tplHat\.hat\), pose: templatePromptPose \};/);
  assert.match(src, /pose: \(swapOpts && swapOpts\.pose\) \|\| null \}\)/);
});

// 2026-11-08 deploy öncesi inceleme: 68 nokta yedeği (yaw ±55°'de tıkanır) prompta sayı vermez;
// yüz eni/çene ağdan gelir, roll yalnız kameraya yakın ve az eğik başta.
test("basePromptPose: yalnız 3B ağ ölçüsü; 68 yedeği ve eksik değerler", async () => {
  const { basePromptPose } = require("../falPhotos")._testables;
  assert.strictEqual(await basePromptPose(null, { yaw: 55, pitch: null, roll: null, src: "68" }), null);
  assert.strictEqual(await basePromptPose(null, null), null);
  const p = await basePromptPose(null, { yaw: -21.4, pitch: -21.8, roll: -3.2, src: "mesh", faceW: 0.091, chinX: 0.47, chinY: 0.41 });
  assert.deepStrictEqual(p, { yaw: -21.4, pitch: -21.8, roll: null, chinX: 0.47, chinY: 0.41, faceW: 0.091 });
  const q = await basePromptPose(null, { yaw: 5, pitch: 3, roll: 6, src: "mesh" });
  assert.strictEqual(q.roll, 6);
  assert.strictEqual(q.faceW, null);
  assert.doesNotMatch(describeBasePose(q), /chin is/);
});

test("eğik baş eşiği -24°: eşiğin üstünde metin eskisiyle aynı, altında yeni tarif", () => {
  const { BOWED_PITCH_DEG } = require("../naturalSwap")._testables;
  assert.strictEqual(BOWED_PITCH_DEG, 24);
  assert.match(describeBasePose({ yaw: 5, pitch: -23.9 }), /tilted down about 24°, chin lowered. The new head has exactly these angles[^.]*.$/);
  assert.match(describeBasePose({ yaw: 5, pitch: -24 }), /bowed forward and down about 24°/);
  // 2026-11-13: c5 (−13.6, yana bakıyor) ve c9 (−20.7, gözler kamerada) eğik tarif ALMAZ.
  assert.doesNotMatch(describeBasePose({ yaw: -34.8, pitch: -13.6 }), /bowed|moving the eyes only/);
  assert.doesNotMatch(describeBasePose({ yaw: 7.8, pitch: -20.7 }), /bowed|moving the eyes only/);
  assert.match(describeBasePose({ yaw: 7.8, pitch: -20.7 }), /tilted down about 21°, chin lowered/);
  // Kapak cümlesi değişmez (varyant B c9'da gözü aşağı indirdi).
  const p = buildNaturalSwapPrompt(5, { prepared: false, pose: { yaw: 7.8, pitch: -20.7, roll: null, chinX: 0.49, chinY: 0.19, faceW: 0.1 } });
  assert.ok(p.includes("Eyes naturally open, neither wide nor sleepy."));
  assert.ok(!p.includes("Eyelids as they naturally fall"));
});

// 2026-11-13: ışık yönü cümlesi yalnız |gu| ≥ 1.0'da; altında ve light verilmezse prompt byte byte aynı.
test("ışık yönü cümlesi: eşik altında prompt değişmez, üstünde resim kenarına göre yön", () => {
  const n = require("../naturalSwap");
  const base = n.buildNaturalSwapPrompt(5, { prepared: false });
  assert.strictEqual(n.buildNaturalSwapPrompt(5, { prepared: false, light: { gu: 0.9 } }), base);
  assert.strictEqual(n.buildNaturalSwapPrompt(5, { prepared: false, light: null }), base);
  const l = n.buildNaturalSwapPrompt(5, { prepared: false, light: { gu: -1.7 } });
  assert.ok(l.includes("comes from the left of the picture") && l.indexOf("Light and skin") < l.indexOf("comes from the left"));
  assert.ok(n.buildNaturalSwapPrompt(5, { prepared: false, light: { gu: 2.4 } }).includes("comes from the right of the picture"));
});

// 2026-11-15: baş ve boyun ayrı paragraf; eski tek cümle yok, "collar" yok (11-13 dersi);
// eğik başta dik baş istenmez, eğim boynun tepesinde.
test("baş ve boyun paragrafı: her selfie seti promptunda, eğik başta eğimle çelişmez", () => {
  const n = require("../naturalSwap");
  const p = n.buildNaturalSwapPrompt(5, { prepared: false });
  assert.ok(!p.includes("on the same neck and no larger"));
  const i = p.indexOf("\n\nHead and neck: the neck stands upright");
  assert.ok(i > p.indexOf("Keep everything else") && i < p.indexOf("Remove glasses"));
  assert.ok(p.includes("it sits back and upright on top of the neck, exactly where the old head was."));
  assert.ok(p.includes("The chin stays as high as the first person's chin, and the head is no larger against the shoulders."));
  const neck = p.slice(i, p.indexOf("Remove glasses"));
  assert.doesNotMatch(neck, /collar/);
  const b = n.buildNaturalSwapPrompt(5, { prepared: false, pose: { yaw: -44.3, pitch: -29.7, roll: null } });
  assert.ok(b.includes("bows only at the top of the neck as described above."));
  assert.ok(!b.includes("sits back and upright on top"));
  const f = n.buildNaturalSwapPrompt(5, { prepared: false, pose: { yaw: 7.8, pitch: -20.7, roll: null } });
  assert.ok(f.includes("sits back and upright on top of the neck"));
  // Hazırlanmış referans yolu (kullanılmıyor) değişmedi.
  assert.ok(n.buildNaturalSwapPrompt(2).includes("on the same neck and no larger against the shoulders"));
});

// 2026-11-14: yön düzeltmesi yalnız ikinci üretimde (yawFix), poz paragrafının içinde; yoksa metin aynı.
test("yön düzeltmesi: yawFix varsa poz paragrafında fazla dönüş yazılır, yoksa prompt değişmez", () => {
  const n = require("../naturalSwap");
  const p = { yaw: -0.8, pitch: 5, roll: 1.7, chinX: 0.51, chinY: 0.41, faceW: 0.16 };
  const base = n.buildNaturalSwapPrompt(5, { prepared: false, pose: p });
  assert.strictEqual(n.buildNaturalSwapPrompt(5, { prepared: false, pose: { ...p, yawFix: null } }), base);
  assert.strictEqual(n.buildNaturalSwapPrompt(5, { prepared: false, pose: { ...p, yawFix: { over: 0, side: "left" } } }), base);
  const f = n.buildNaturalSwapPrompt(5, { prepared: false, pose: { ...p, yawFix: { over: 13.2, side: "left" } } });
  assert.ok(f.includes("about 13° too far toward the left side of the picture"));
  assert.ok(f.indexOf("Measured in the first photo") < f.indexOf("too far toward") && f.indexOf("too far toward") < f.indexOf("Identity:"));
  assert.ok(f.startsWith(base.slice(0, 200)), "prompt başı değişmez");
});
