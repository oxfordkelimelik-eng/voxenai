const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collectTokens, DEAD_TOKEN_CODES } = require("../notifications")._testables;

// ---------------------------------------------------------------------------
// ÇOK CİHAZ TOKEN TOPLAMA (2026-09-17)
// ---------------------------------------------------------------------------
// "Bildirim bazen geliyor bazen gelmiyor" şikayetinin kök nedeni: tek bir
// fcmToken alanı vardı, her kayıt öncekini eziyordu ve gönderim hata alınca
// alan null'lanıyordu. Gerçek kanıt: admin token'ı 2026-09-17 18:46'da
// kaydedildi, o günün üç satışı (07:15/09:59/17:39) bildirimsiz geçti.

test("yeni dizi alanından token'ları okur", () => {
  assert.deepEqual(collectTokens({ fcmTokens: ["a", "b"] }), ["a", "b"]);
});

test("ESKİ tekil alanı da okur (geriye uyumluluk)", () => {
  // Bu sürümü almamış istemciler ve eski dokümanlar hâlâ tekil alanı yazıyor.
  // Burayı bozmak, güncellememiş herkesin bildirimini kapatır.
  assert.deepEqual(collectTokens({ fcmToken: "eski" }), ["eski"]);
});

test("ikisi birlikteyken birleştirir ve TEKRARI ayıklar", () => {
  const got = collectTokens({ fcmTokens: ["a", "b"], fcmToken: "a" });
  assert.deepEqual(got.sort(), ["a", "b"]);
});

test("boş/eksik/bozuk veride boş dizi döner (patlamaz)", () => {
  assert.deepEqual(collectTokens(null), []);
  assert.deepEqual(collectTokens({}), []);
  assert.deepEqual(collectTokens({ fcmToken: null }), []);
  assert.deepEqual(collectTokens({ fcmToken: "" }), []);
  assert.deepEqual(collectTokens({ fcmTokens: [] }), []);
});

test("dizideki bozuk girdileri atlar", () => {
  assert.deepEqual(collectTokens({ fcmTokens: ["ok", "", null, 42, "ok2"] }), ["ok", "ok2"]);
});

// ---------------------------------------------------------------------------
// ÖLÜ TOKEN AYRIMI
// ---------------------------------------------------------------------------
// Kritik: yalnızca GERÇEKTEN ölü token silinmeli. Geçici bir hatada (ağ,
// kota, sunucu) token silinirse kullanıcının bildirimleri kalıcı olarak
// kapanır — eski kod bu ayrımı yapmadan tüm alanı null'lıyordu.

test("yalnızca kalıcı hata kodları ölü sayılır", () => {
  assert.ok(DEAD_TOKEN_CODES.has("messaging/registration-token-not-registered"));
  assert.ok(DEAD_TOKEN_CODES.has("messaging/invalid-registration-token"));
});

test("GEÇİCİ hatalar ölü SAYILMAZ (token korunur)", () => {
  for (const code of [
    "messaging/server-unavailable",
    "messaging/internal-error",
    "messaging/quota-exceeded",
    "messaging/unknown-error",
    undefined,
  ]) {
    assert.equal(DEAD_TOKEN_CODES.has(code), false, `${code} ölü sayılmamalı`);
  }
});
