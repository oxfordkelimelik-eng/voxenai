"use strict";
// SATIN ALMA DOĞRULAMA — SAF KONTROLLER (2026-11-23): ürün uyuşmazlığı, iade, sandbox sınırı, ortak defter.
const test = require("node:test");
const assert = require("node:assert");
const PC = require("../purchaseCheck");

const jws = (payload) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256" })}.${b64(payload)}.imza`;
};
const apple = (over = {}) => ({
  transactionId: "2000000123456789", bundleId: "com.voxenai.app", productId: "dating_pack_photos5_solo",
  environment: "Production", ...over,
});
const opts = { productId: "dating_pack_photos5_solo", bundleId: "com.voxenai.app" };

test("JWS gövdesi açılır (base64url, dolgusuz); bozuk girdi null", () => {
  assert.deepStrictEqual(PC.decodeJwsPayload(jws({ a: 1, t: "ğüş" })), { a: 1, t: "ğüş" });
  assert.strictEqual(PC.decodeJwsPayload("abc"), null);
  assert.strictEqual(PC.decodeJwsPayload("a.!!!.c"), null);
  assert.strictEqual(PC.decodeJwsPayload(undefined), null);
});

test("Apple: geçerli canlı işlem; işlem no Apple'dan", () => {
  const r = PC.evaluateAppleTransaction(PC.decodeJwsPayload(jws(apple())), opts);
  assert.deepStrictEqual(r, { valid: true, orderId: "2000000123456789", sandbox: false });
});

test("Apple: ucuz paketin işlemi pahalı paket diye gönderilirse REDDEDİLİR (açık 1)", () => {
  const r = PC.evaluateAppleTransaction(apple(), { ...opts, productId: "dating_pack_photos25_analysis5" });
  assert.deepStrictEqual(r, { valid: false, reason: "product-mismatch" });
});

test("Apple: başka uygulamanın işlemi, iade edilmiş işlem ve okunamayan cevap reddedilir", () => {
  assert.strictEqual(PC.evaluateAppleTransaction(apple({ bundleId: "com.baska.app" }), opts).reason, "bundle-mismatch");
  assert.strictEqual(PC.evaluateAppleTransaction(apple({ revocationDate: 1732300000000 }), opts).reason, "revoked");
  assert.strictEqual(PC.evaluateAppleTransaction(null, opts).reason, "unreadable");
  assert.strictEqual(PC.evaluateAppleTransaction(apple({ transactionId: "" }), opts).reason, "unreadable");
});

test("Apple: Sandbox ve Xcode ortamı sandbox sayılır", () => {
  assert.strictEqual(PC.evaluateAppleTransaction(apple({ environment: "Sandbox" }), opts).sandbox, true);
  assert.strictEqual(PC.evaluateAppleTransaction(apple({ environment: "Xcode" }), opts).sandbox, true);
});

test("Android: satın alındı / beklemede / iptal / test hesabı / ürün uyuşmazlığı", () => {
  const o = { productId: "dating_pack_photos5_solo", purchaseToken: "tok" };
  assert.deepStrictEqual(PC.evaluateAndroidPurchase({ purchaseState: 0, orderId: "GPA.1" }, o), { valid: true, orderId: "GPA.1", sandbox: false });
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 0 }, o).orderId, "tok", "test satın almasında orderId yok");
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 0, purchaseType: 0 }, o).sandbox, true);
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 0, purchaseType: 1 }, o).sandbox, false, "promosyon kodu gerçek");
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 2 }, o).reason, "pending");
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 1 }, o).reason, "cancelled");
  assert.strictEqual(PC.evaluateAndroidPurchase({ purchaseState: 0, productId: "baska" }, o).reason, "product-mismatch");
});

test("ortak defter anahtarı: platform + işlem no'ya bağlı, sabit, '/' içermez", () => {
  const a = PC.ledgerId("ios", "2000000123456789");
  assert.strictEqual(a, PC.ledgerId("ios", "2000000123456789"));
  assert.notStrictEqual(a, PC.ledgerId("android", "2000000123456789"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(PC.ledgerId("android", "a/b/c".repeat(200)), /^[0-9a-f]{64}$/);
});

test("sandbox ayarı: varsayılanlar, reviewDemo e-postaları birleşir, küçük harf", () => {
  assert.deepStrictEqual(PC.paymentConfig(null, null), { allowSandbox: true, sandboxMaxPerUser: 5, sandboxEmails: [] });
  const c = PC.paymentConfig({ allowSandbox: false, sandboxMaxPerUser: 2, sandboxEmails: [" Test@X.com "] }, { emails: ["review@y.com", 3] });
  assert.deepStrictEqual(c, { allowSandbox: false, sandboxMaxPerUser: 2, sandboxEmails: ["test@x.com", "review@y.com"] });
  assert.strictEqual(PC.paymentConfig({ sandboxMaxPerUser: -1 }).sandboxMaxPerUser, 5);
});

test("sandbox kararı: izinli e-posta sınırsız; diğerleri hesap başına sınır; kapalıysa ret (açık 2)", () => {
  const cfg = PC.paymentConfig({ sandboxMaxPerUser: 2, sandboxEmails: ["review@y.com"] });
  assert.deepStrictEqual(PC.sandboxDecision({ email: "x@y.com", cfg, priorCount: 1 }), { ok: true });
  assert.deepStrictEqual(PC.sandboxDecision({ email: "x@y.com", cfg, priorCount: 2 }), { ok: false, reason: "sandbox-limit" });
  assert.deepStrictEqual(PC.sandboxDecision({ email: "REVIEW@y.com", cfg, priorCount: 99 }), { ok: true });
  const off = PC.paymentConfig({ allowSandbox: false, sandboxEmails: ["review@y.com"] });
  assert.strictEqual(PC.sandboxDecision({ email: "x@y.com", cfg: off, priorCount: 0 }).reason, "sandbox-off");
  assert.deepStrictEqual(PC.sandboxDecision({ email: "review@y.com", cfg: off, priorCount: 0 }), { ok: true });
});

test("kalıcı ret listesi: bekleyen ödeme ve okunamayan cevap kalıcı DEĞİL (istemci kapatmamalı)", () => {
  assert.ok(PC.PERMANENT_REJECTS.includes("owned-by-other"));
  assert.ok(!PC.PERMANENT_REJECTS.includes("pending"));
  assert.ok(!PC.PERMANENT_REJECTS.includes("unreadable"));
  for (const r of PC.PERMANENT_REJECTS) assert.ok(PC.REJECT_MESSAGES[r], `${r} için mesaj`);
});
