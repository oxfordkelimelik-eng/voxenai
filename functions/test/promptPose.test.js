// SADE PROMPT (2026-11-19, bkz. naturalSwap.buildSelfieSetPrompt): sayısal poz, uzun boy boyun
// paragrafı, ışık yönü, YAW_FIX ve şapka ikinci üretim metni kaldırıldı. Pozdan yalnız EĞİK BAŞ
// (pitch ≤ −24°) bloğu kalır; sözcükleri ücretli testteki metinle aynı.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildNaturalSwapPrompt, _testables: { describeBowed, BOWED_PITCH_DEG } } = require("../naturalSwap");

const base = () => buildNaturalSwapPrompt(5, { prepared: false });

test("sade prompt: sayı, yüzde, BASE etiketi, boyun paragrafı ve ışık yönü yok", () => {
  const p = base();
  assert.ok(p.startsWith("Replace the person in the first photo with the person shown in the other 5 photos"));
  assert.doesNotMatch(p, /BASE|°|%|Measured|Head and neck|comes from the left|earlier attempt|previous attempt/);
  assert.ok(p.includes("Use the other 5 photos only to see who this person is: their face, features, skin tone and hair."));
  assert.ok(p.includes(" The new head sits exactly where the old head was, on the same neck and no larger against the shoulders."));
  assert.ok(p.includes("Light the face with the same light that falls on the body in the first photo."));
  assert.ok(p.split(/\s+/).length < 330, `kelime=${p.split(/\s+/).length}`);
});

test("poz: eğik olmayan şablonda prompt pozsuz metinle aynı", () => {
  for (const pose of [null, { yaw: 16.2, pitch: -9.3 }, { yaw: -34.8, pitch: -13.6 }, { yaw: 7.8, pitch: -20.7 }, { yaw: 5, pitch: -23.9 }, { yaw: 30, pitch: 6 }]) {
    assert.strictEqual(buildNaturalSwapPrompt(5, { prepared: false, pose }), base(), JSON.stringify(pose));
  }
  // Eski seçenekler yok sayılır (eski çağrılar düşmez).
  assert.strictEqual(buildNaturalSwapPrompt(5, { prepared: false, tallNeck: true, light: { gu: 2 }, hatFix: "cap" }), base());
});

test("eğik baş (≤ −24°): ücretli testteki metin baş açısı cümlesinden hemen sonra", () => {
  assert.strictEqual(BOWED_PITCH_DEG, 24);
  const s = describeBowed({ yaw: -44.3, pitch: -29.7 });
  assert.match(s, /^ Measured in the first photo: the head is bowed forward and down about 30°, tipping forward at the top of the neck: the face is seen from slightly above/);
  assert.match(s, /this head stays bowed exactly this much. Match the eye direction by moving the eyes only/);
  assert.match(s, /The head tips forward without sinking: the top of the head, the eyes and the ears stay at the same height/);
  assert.match(s, /the neck between the jaw and the collar stays as long and as visible as it is in the first photo.$/);
  assert.doesNotMatch(s, /turned|%|chin is/);
  assert.match(describeBowed({ pitch: -24 }), /about 24°/);
  assert.strictEqual(describeBowed({ pitch: -23.9 }), "");
  assert.strictEqual(describeBowed(null), "");
  const p = buildNaturalSwapPrompt(5, { prepared: false, pose: { yaw: -44.3, pitch: -29.7 } });
  assert.ok(p.includes("exactly where the first person's eyes look." + s + " A relaxed, neutral"));
  assert.strictEqual(p.replace(s, ""), base());
});

test("falPhotos: poz şablon başına ölçülür, sıfırlanır ve prompta gider; eski seçenekler gönderilmez", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /const PROMPT_POSE_ON = (true|false);/);
  assert.match(src, /templatePromptPose = null;\r?\n        templateMeta = null;\r?\n        templateIris = undefined;/);
  assert.match(src, /const swapOpts = \{ hat: !!\(tplHat && tplHat\.hat\), pose: templatePromptPose, eyewear: eyewearGaze \};/);
  // Şablon değişince gözlük payı da yeniden ölçülür (11-20).
  assert.match(src, /templateIris = undefined;\r?\n        templateEyeGlass = undefined;\r?\n        templateEyeGlassP = null;/);
  assert.match(src, /buildNaturalSwapPrompt\(Math\.min\(swapRefs, faceUrls\.length\), \{ prepared: !SELFIE_SET_ALL, hat: !!\(swapOpts && swapOpts\.hat\), pose: \(swapOpts && swapOpts\.pose\) \|\| null, eyewear: !!\(swapOpts && swapOpts\.eyewear\) \}\)/);
});

test("sade akış anahtarları: ikinci üretim, yüz onarımı, kafa bükme kapalı; mod hep p800", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /const SECOND_GEN_ON = false;/);
  assert.match(src, /const ARTIFACT_REPAIR_MAX_PER_CHUNK = 0;/);
  assert.match(src, /const photoMode = PHOTO_MODE_P800;/);
  assert.match(src, /if \(SECOND_GEN_ON && buf && mode !== PHOTO_MODE_STAGED && templateYawSigned != null\)/);
  assert.match(src, /if \(SECOND_GEN_ON && h && !h\.kept\)/);
  const { FINISH } = require("../postTasks")._testables;
  assert.deepStrictEqual(FINISH, { HEAD_WARP: false, GHOST_CLEAN: true, FACE_TONE: true, SKIN: true, LIP: true, GAZE: true, STRUCT: true, DETAIL: true });
});

// 2026-11-08 deploy öncesi inceleme: 68 nokta yedeği (yaw ±55°'de tıkanır) prompta sayı vermez.
test("basePromptPose: yalnız 3B ağ ölçüsü; 68 yedeği ve eksik değerler", async () => {
  const { basePromptPose } = require("../falPhotos")._testables;
  assert.strictEqual(await basePromptPose(null, { yaw: 55, pitch: null, roll: null, src: "68" }), null);
  assert.strictEqual(await basePromptPose(null, null), null);
  const p = await basePromptPose(null, { yaw: -21.4, pitch: -21.8, roll: -3.2, src: "mesh", faceW: 0.091, chinX: 0.47, chinY: 0.41 });
  assert.deepStrictEqual(p, { yaw: -21.4, pitch: -21.8, roll: null, chinX: 0.47, chinY: 0.41, faceW: 0.091 });
  const q = await basePromptPose(null, { yaw: 5, pitch: 3, roll: 6, src: "mesh" });
  assert.strictEqual(q.roll, 6);
  assert.strictEqual(q.faceW, null);
});
