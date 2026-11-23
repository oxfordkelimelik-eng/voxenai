// SATIN ALMA DOĞRULAMA — SAF KONTROLLER (2026-11-23, kullanıcı: "kullanıcılar sınırsız krediye sahip olamasın").
//
// Kapatılan açıklar (payments.js verifyPurchase):
//  1) iOS'ta işlemin ÜRÜNÜ denetlenmiyordu: ucuz paketin işlem no'su pahalı paket diye gönderilince pahalı
//     paketin kredisi yükleniyordu. Artık Apple'ın döndürdüğü signedTransactionInfo açılır; ürün, uygulama
//     kimliği ve iade (revocationDate) denetlenir; işlem no istemciden değil Apple'dan alınır.
//  2) Sandbox (TestFlight / test hesabı, ücretsiz) satın almaları canlıda sınırsız kredi yüklüyordu. Apple
//     incelemesi sandbox'ta satın aldığı için tamamen kapatılamaz: hesap başına ömür boyu sınır
//     (config/payments.sandboxMaxPerUser) + izinli e-postalar (config/payments.sandboxEmails, config/reviewDemo).
//  3) "İşlendi" kaydı kullanıcı başınaydı: aynı satın alma başka hesaplarda tekrar kredi yüklüyordu. Artık
//     tüm hesaplar için tek defter purchaseLedger/{ledgerId}: satın alma yalnız İLK hesaba kredi verir.
// Bu dosyada Firebase yok (test edilebilir); yan etkiler payments.js'de.

const crypto = require("crypto");

/** JWS (3 parçalı) gövdesini açar; imza DOĞRULANMAZ (veri doğrudan Apple API'sinden TLS ile gelir). SAF. */
function decodeJwsPayload(jws) {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const o = JSON.parse(json);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/**
 * Apple işlem bilgisini (signedTransactionInfo gövdesi) değerlendirir. Dönüş:
 * { valid, reason?, orderId?, sandbox? } — orderId Apple'ın transactionId'si. SAF.
 */
function evaluateAppleTransaction(info, { productId, bundleId }) {
  if (!info || typeof info !== "object") return { valid: false, reason: "unreadable" };
  if (info.bundleId !== bundleId) return { valid: false, reason: "bundle-mismatch" };
  if (info.productId !== productId) return { valid: false, reason: "product-mismatch" };
  if (info.revocationDate) return { valid: false, reason: "revoked" };
  const orderId = info.transactionId != null ? String(info.transactionId) : "";
  if (!orderId) return { valid: false, reason: "unreadable" };
  return { valid: true, orderId, sandbox: info.environment !== "Production" };
}

/**
 * Google Play purchases.products.get cevabını değerlendirir. purchaseType 0 = lisanslı test hesabı (ücretsiz),
 * sandbox kuralına tabi. SAF.
 */
function evaluateAndroidPurchase(data, { productId, purchaseToken }) {
  if (!data || typeof data !== "object") return { valid: false, reason: "unreadable" };
  if (data.productId && data.productId !== productId) return { valid: false, reason: "product-mismatch" };
  if (data.purchaseState === 2) return { valid: false, reason: "pending" };
  if (data.purchaseState !== 0) return { valid: false, reason: "cancelled" };
  return { valid: true, orderId: String(data.orderId || purchaseToken), sandbox: data.purchaseType === 0 };
}

/** Tüm hesaplar için ortak defter anahtarı (platform + işlem no; '/' ve uzunluk sorunu olmasın diye özet). SAF. */
function ledgerId(platform, orderId) {
  return crypto.createHash("sha256").update(`${platform}:${orderId}`).digest("hex");
}

const PAYMENT_DEFAULTS = { allowSandbox: true, sandboxMaxPerUser: 5, sandboxEmails: [] };

/** config/payments + config/reviewDemo e-postalarından sandbox ayarı. SAF. */
function paymentConfig(raw, reviewDemo) {
  const c = raw && typeof raw === "object" ? raw : {};
  const list = (v) => (Array.isArray(v) ? v : []).filter((e) => typeof e === "string").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return {
    allowSandbox: c.allowSandbox !== false,
    sandboxMaxPerUser: Number.isFinite(c.sandboxMaxPerUser) && c.sandboxMaxPerUser >= 0
      ? Math.floor(c.sandboxMaxPerUser) : PAYMENT_DEFAULTS.sandboxMaxPerUser,
    sandboxEmails: [...new Set([...list(c.sandboxEmails), ...list(reviewDemo && reviewDemo.emails)])],
  };
}

/** Sandbox satın alması kredi yükleyebilir mi. priorCount: bu hesabın daha önceki sandbox satın alma sayısı. SAF. */
function sandboxDecision({ email, cfg, priorCount }) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (e && cfg.sandboxEmails.includes(e)) return { ok: true };
  if (!cfg.allowSandbox) return { ok: false, reason: "sandbox-off" };
  if ((priorCount || 0) >= cfg.sandboxMaxPerUser) return { ok: false, reason: "sandbox-limit" };
  return { ok: true };
}

/**
 * Kalıcı ret sebepleri: tekrar denemek sonucu değiştirmez. İstemci bunlarda mağaza işlemini KAPATIR (yoksa her
 * açılışta yeniden teslim edilir). "pending" ve geçici hatalar burada YOK — onlar kapatılmamalı.
 */
const PERMANENT_REJECTS = ["owned-by-other", "product-mismatch", "bundle-mismatch", "revoked", "cancelled", "sandbox-off", "sandbox-limit"];

const REJECT_MESSAGES = {
  "owned-by-other": "Bu satın alma başka bir hesaba tanımlı. Satın aldığın hesapla giriş yap.",
  "product-mismatch": "Satın alma doğrulanamadı.",
  "bundle-mismatch": "Satın alma doğrulanamadı.",
  unreadable: "Satın alma doğrulanamadı. Lütfen tekrar dene.",
  revoked: "Bu satın alma iade edilmiş.",
  cancelled: "Satın alma iptal edilmiş.",
  pending: "Ödeme henüz tamamlanmadı. Onaylanınca paketin yüklenecek.",
  "sandbox-off": "Test satın almaları şu an kapalı.",
  "sandbox-limit": "Bu hesap için test satın alma sınırına ulaşıldı.",
};

module.exports = {
  decodeJwsPayload, evaluateAppleTransaction, evaluateAndroidPurchase, ledgerId, paymentConfig, sandboxDecision,
  PAYMENT_DEFAULTS, PERMANENT_REJECTS, REJECT_MESSAGES,
};
