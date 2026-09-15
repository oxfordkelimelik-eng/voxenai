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

// ARTEFAKT BÖLGESİ (2026-09-14). İş 3db3ba68'de chunk 2 ve 8 ikişer kez
// üst üste AYNI bölgeden elendi; uyarı bölgeyi söylemediği için model
// düzeltmeyi nereye uygulayacağını bilmiyordu.
test("ölçülen bölge verildiğinde uyarı ONU adreslar", () => {
  const hint = retryCorrectionPrefix("face-artifact", null, "forehead and nose");
  assert.match(hint, /on the forehead and nose/i);
  assert.match(hint, /look there first/i);
});

test("bölge yoksa veya NONE ise bölge cümlesi EKLENMEZ", () => {
  const noWhere = retryCorrectionPrefix("face-artifact", null, null);
  assert.doesNotMatch(noWhere, /look there first/i);
  const none = retryCorrectionPrefix("face-artifact", null, "NONE");
  assert.doesNotMatch(none, /look there first/i);
  // Genel metin yine de duruyor.
  assert.match(none, /flat grey/i);
});

test("vision-artifact da bölge cümlesini alır", () => {
  const hint = retryCorrectionPrefix("vision-artifact", null, "Grey patch on forehead");
  assert.match(hint, /Grey patch on forehead/);
});

test("bilinmeyen/boş kapı boş string döner", () => {
  assert.equal(retryCorrectionPrefix(null), "");
  assert.equal(retryCorrectionPrefix("bilinmeyen-kapi"), "");
});

// DÜZELTİRKEN BAŞKA ŞEYİ BOZMA (2026-09-15). Ölçüm: leke yasağı sonrası
// 11 artefakt reddinin 9'u RETRY'da çıktı ve gaze reddi sonrası yapılan
// 9 retry'ın 5'inde (%56) yeni leke belirdi — düzeltici uyarı modeli yüze
// odaklayıp o bölgeyi yeniden boyatıyordu.
test("her düzeltici uyarı 'başka şeyi bozma' ekiyle biter", () => {
  for (const gate of ["vision-gaze", "face-artifact", "yaw-drift",
                      "skin-tone", "vision-identity"]) {
    const hint = retryCorrectionPrefix(gate);
    assert.match(hint, /change NOTHING else/i, `${gate} eki almalı`);
    assert.match(hint, /do not repaint the facial skin/i, `${gate} leke koruması almalı`);
  }
});

test("boş uyarıya ek EKLENMEZ", () => {
  // Uyarı yoksa düzeltilecek bir şey de yok; boş string boş kalmalı.
  assert.equal(retryCorrectionPrefix(null), "");
  assert.equal(retryCorrectionPrefix("tanimsiz-kapi"), "");
});

test("ek, asıl düzeltme metninden SONRA gelir", () => {
  const hint = retryCorrectionPrefix("vision-gaze", { base: "RIGHT", out: "CAMERA" });
  assert.ok(
    hint.indexOf("RIGHT") < hint.indexOf("change NOTHING else"),
    "önce kusur anlatılmalı, sonra koruma eki gelmeli"
  );
});
