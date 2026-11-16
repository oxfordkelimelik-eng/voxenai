// 2026-11-04 inceleme düzeltmeleri: son doğrulamada gözlüklü kare korunur,
// şablon saçı kırpma kapıları, sade akışta Vision ten reddi elemez, selfie
// kimlik kapısı yalnız log, altyapı hatasında yeni üretim yok.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { shouldRevert } = require("../finalCheck");
const { trimPoseSkip, trimShareSkip } = require("../templateHair");

test("shouldRevert: gözlüksüz karede her başarısızlık geri alınır", () => {
  assert.strictEqual(shouldRevert({ ok: true }), false);
  assert.strictEqual(shouldRevert({ ok: true, reason: "no-before" }), false);
  for (const reason of ["box-shift", "box-scale", "landmark-shift", "sharpness", "face-lost", "size-changed", "corrupt-file"]) {
    assert.strictEqual(shouldRevert({ ok: false, reason }, { eyewear: false }), true, reason);
  }
});

test("shouldRevert: gözlüklü karede yalnız bozuk dosya / boyut değişikliği geri alınır (80fc7ec4 c8 kutu kayması 0.074)", () => {
  for (const reason of ["box-shift", "box-scale", "landmark-shift", "sharpness", "face-lost"]) {
    assert.strictEqual(shouldRevert({ ok: false, reason, boxShift: 0.074 }, { eyewear: true }), false, reason);
  }
  assert.strictEqual(shouldRevert({ ok: false, reason: "size-changed" }, { eyewear: true }), true);
  assert.strictEqual(shouldRevert({ ok: false, reason: "corrupt-file" }, { eyewear: true }), true);
});

test("trimPoseSkip: inceleme ve deploy öncesi doğrulamada kafa kesen şablonlar kırpılmaz", () => {
  // 7e0 c3: yaw +49.8, ense dik çizgiyle kesildi.
  assert.strictEqual(trimPoseSkip(49.8, 7.2, 48), "turned");
  // b932 c0: yaw −59.7, arkada basamak.
  assert.strictEqual(trimPoseSkip(-59.7, -4.0, -49), "turned");
  // 7e0 c0: yaw 17.3 ve aşağı bakıyor (pitch −20.4), tepe düz kesildi.
  assert.strictEqual(trimPoseSkip(17.3, -20.4, 17), "turned");
  // 80f c0 (Kutay seti): yaw −11, ense basamak — yaw 25 kapısını geçiyordu.
  assert.strictEqual(trimPoseSkip(-10.95, 0.14, -10.2), "turned");
  // b932 c3: pitch −12.3, saç hacminin %72'si silinecekti.
  assert.strictEqual(trimPoseSkip(-1.0, -12.3, -1), "looking-down");
  // b93 c7 (Kutay seti): pitch −9.84, tepe düz — pitch −10 kapısını geçiyordu.
  assert.strictEqual(trimPoseSkip(4.34, -9.84, 4.5), "looking-down");
  // İlk selfie base açısından 8° uzak / ölçülemedi.
  assert.strictEqual(trimPoseSkip(5, 0, -3), "selfie-pose-gap");
  assert.strictEqual(trimPoseSkip(5, 0, null), "selfie-pose-gap");
  // Ölçülemeyen poz kırpılmaz.
  assert.strictEqual(trimPoseSkip(null, 0, 0), "pose-unknown");
  assert.strictEqual(trimPoseSkip(5, null, 4), "pitch-unknown");
});

test("trimPoseSkip: önden, düz bakan, selfie'si yakın şablon kırpılabilir (b93 c2)", () => {
  assert.strictEqual(trimPoseSkip(0.36, -0.43, 0.5), null);
});

test("trimShareSkip: büyük ve çok küçük paylar atılır", () => {
  assert.strictEqual(trimShareSkip(0.35), "share-too-large"); // 80f c4
  assert.strictEqual(trimShareSkip(0.72), "share-too-large"); // b932 c3
  assert.strictEqual(trimShareSkip(0.232), "share-too-large"); // b932 c6: oymalı pervazda LaMa lekesi
  assert.strictEqual(trimShareSkip(0.018), "share-tiny"); // 7e0 c7: ghostClean çalışsın
  assert.strictEqual(trimShareSkip(0.12), null); // b93 c2
  assert.strictEqual(trimShareSkip(undefined), null);
});

test("falPhotos kaynağı: inceleme düzeltmeleri yerinde", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  // Şablon saçı kırpma kapalı (kafa kesme riski), tam silme de kapalı.
  assert.match(src, /const TEMPLATE_HAIR_TRIM = false;/);
  assert.match(src, /const TEMPLATE_HAIR_ERASE = false;/);
  // Sade akışta Vision ten reddi elemez; ama saç/hat çağrısı (çağrı 2) atlanmaz.
  assert.match(src, /!visionOk && visionReason === "skin" && SIMPLE_PIPELINE/);
  assert.match(src, /const skinOnly = !self\.ok && self\.reason === "skin" && SIMPLE_PIPELINE;/);
  assert.match(src, /if \(!ref\.ok\) return ref;\s*if \(skinOnly\) return self;/);
  // Selfie kimlik kapısı yalnız log.
  assert.match(src, /const SELFIE_IDENTITY_REJECT = false;/);
  assert.match(src, /out\.length > 0 && SELFIE_IDENTITY_REJECT/);
  // Son doğrulama kararı shouldRevert'ten.
  assert.match(src, /const revert = shouldRevert\(fv, \{ eyewear: eyewearApplied \}\);/);
  // Ten pigmenti ücretsiz kontrollerden sonra: estimateMst, analyzeReferences'tan sonra gelir.
  const iAnalyze = src.indexOf("await analyzeReferences(refBuffers");
  const iMst = src.indexOf("estimateMst(refBuffers");
  assert.ok(iAnalyze > 0 && iMst > iAnalyze, "estimateMst analyzeReferences'tan sonra olmalı");
  // generateForMode null → yeni üretim yok.
  const iNull = src.indexOf("generateForMode null döndü");
  const block = src.slice(iNull, iNull + 1200);
  assert.ok(!/if \(attempt < maxAttempts\) continue;/.test(block), "altyapı hatasında continue olmamalı");
});
