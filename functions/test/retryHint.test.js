const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retryCorrectionPrefix } = require("../falPhotos")._testables;

// BAKIŞ DÜZELTİCİ UYARISI (2026-09-14).
//
// Eski metin her bakış reddinde "gözü kameraya çektin" diyordu. Gerçek
// retlerin çoğunda kusur bu DEĞİL: taban sağa bakarken çıktı sola bakıyor,
// ikisi de kameraya bakmıyor. Yanlış teşhis modele yanlış düzeltmeyi
// yaptırıyordu ve aynı hata tekrarlanıyordu — son 40 işte 108 reddin 46'sı
// (%42.6) bakış kaynaklıydı ve altı ayrı işte aynı chunk üst üste iki kez
// aynı kapıdan elendi.

test("ölçülen yönler verildiğinde uyarı ONLARI söyler", () => {
  const hint = retryCorrectionPrefix("vision-gaze", { base: "AWAY_LEFT", out: "CAMERA" });
  assert.match(hint, /AWAY_LEFT/);
  assert.match(hint, /CAMERA/);
  // Sabit/yanlış teşhis artık yok.
  assert.doesNotMatch(hint, /drifted the eyes toward the camera/);
});

test("ölçüm yoksa genel metne düşer ve kameraya-çekme iddiası ETMEZ", () => {
  const hint = retryCorrectionPrefix("vision-gaze", null);
  assert.match(hint, /PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(hint, /somewhere other than where the base/);
  assert.doesNotMatch(hint, /drifted the eyes toward the camera/);
});

test("eksik ölçümde (yalnız base) genel metne düşer", () => {
  const hint = retryCorrectionPrefix("vision-gaze", { base: "LEFT" });
  assert.match(hint, /somewhere other than where the base/);
});

test("iris-gaze de aynı yolu kullanır", () => {
  const hint = retryCorrectionPrefix("iris-gaze", { base: "DOWN", out: "CAMERA" });
  assert.match(hint, /DOWN/);
});

test("bakış dışı kapılar bakış metnini ALMAZ", () => {
  const yaw = retryCorrectionPrefix("yaw-drift", { base: "LEFT", out: "RIGHT" });
  assert.match(yaw, /head angle/i);
  assert.doesNotMatch(yaw, /irises/);
});

test("artefakt uyarısı düz blok kusurunu adlandırır", () => {
  const hint = retryCorrectionPrefix("face-artifact");
  assert.match(hint, /grey\/white block|flat grey/i);
  assert.match(hint, /forehead/i);
});

test("bilinmeyen/boş kapı boş string döner", () => {
  assert.equal(retryCorrectionPrefix(null), "");
  assert.equal(retryCorrectionPrefix("bilinmeyen-kapi"), "");
});
