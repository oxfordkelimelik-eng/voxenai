const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { google } = require("googleapis");
const { admin, db, bucket } = require("./_shared");

const GOOGLE_SERVICE_ACCOUNT_JSON = defineSecret("GOOGLE_SERVICE_ACCOUNT_JSON");
const APPLE_ISSUER_ID = defineSecret("APPLE_ISSUER_ID");
const APPLE_KEY_ID = defineSecret("APPLE_KEY_ID");
const APPLE_PRIVATE_KEY = defineSecret("APPLE_PRIVATE_KEY");

// Android bundle id — Play Developer API çağrısı için gerekli.
const ANDROID_PACKAGE_NAME = "com.voxenai.app";
// iOS bundle id — App Store Server API JWT'sinde 'bid' alanı için gerekli.
const IOS_BUNDLE_ID = "com.voxenai.app";

// productId -> kredilenecek miktar. dating_constants.dart'taki sabitlerle
// EL İLE senkron tutulmalı (Dart/Node arasında paylaşılan kaynak yok).
// Bkz. lib/core/constants/dating_constants.dart
const PRODUCT_CREDITS = {
  dating_pack_analysis1: { field: "analysisBalance", amount: 1 },
  dating_pack_analysis5: { field: "analysisBalance", amount: 5 },
  dating_pack_photo10: { field: "photoBalance", amount: 1 }, // 1 "set/stil"
  dating_pack_photo50: { field: "photoBalance", amount: 5 }, // 5 "set/stil"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Geçici hataları (ağ, 401/5xx gibi mağaza tarafı anlık aksaklıklar) kısa
 * gecikmeyle 1 kez yeniden dener. Mağazanın kesin "geçersiz" cevabı (ör.
 * Android purchaseState !== 0, Apple 404/400) burada retry'lanmaz —
 * yalnızca doğrulama çağrısının kendisi (network/exception) hedeflenir.
 */
async function withRetry(fn, { retries = 1, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Android: Play Developer API ile satın alma tokenını doğrular.
 * Döner: { valid: boolean, orderId: string }
 */
async function verifyAndroidPurchase(productId, purchaseToken) {
  const keyJson = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON.value());
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const androidpublisher = google.androidpublisher({ version: "v3", auth });
  const resp = await withRetry(() => androidpublisher.purchases.products.get({
    packageName: ANDROID_PACKAGE_NAME,
    productId,
    token: purchaseToken,
  }));
  // purchaseState: 0 = satın alındı, 1 = iptal, 2 = beklemede
  const valid = resp.data.purchaseState === 0;
  return { valid, orderId: resp.data.orderId || purchaseToken };
}

// App Store Server API host'lari (verifyReceipt DEGIL — dogru host'lar bunlar).
const APPLE_HOST_PROD = "api.storekit.itunes.apple.com";
const APPLE_HOST_SANDBOX = "api.storekit-sandbox.itunes.apple.com";

async function fetchAppleTransaction(token, transactionId, sandbox) {
  const host = sandbox ? APPLE_HOST_SANDBOX : APPLE_HOST_PROD;
  return fetch(`https://${host}/inApps/v1/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * iOS: App Store Server API ile işlemi doğrular.
 * Once production'i dener; islem orada bulunamazsa (404) sandbox'i dener —
 * boylece TestFlight/Sandbox satin almalari da production yayini da APPLE_ENV
 * gibi bir ayar cevirmeye gerek kalmadan calisir.
 */
async function verifyApplePurchase(productId, purchaseToken) {
  // StoreKit 2: istemci çoğu zaman JWS (3 parçalı JWT) gönderir.
  // App Store Server API ise transactionId ister — JWS payload'dan çıkar.
  let transactionId = purchaseToken;
  if (typeof purchaseToken === "string" && purchaseToken.split(".").length === 3) {
    try {
      const payloadB64 = purchaseToken.split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      transactionId = payload.transactionId || payload.originalTransactionId || purchaseToken;
      // Ürün kimliği uyuşmuyorsa yine de transactionId ile doğrula (Apple kaynağı).
      if (payload.productId && payload.productId !== productId) {
        console.warn(`productId uyuşmazlığı: beklenen=${productId} jws=${payload.productId}`);
      }
    } catch (e) {
      console.warn("Apple JWS decode başarısız, ham token kullanılacak:", e.message);
    }
  }

  const jwt = require("jsonwebtoken");
  const token = jwt.sign(
    {
      iss: APPLE_ISSUER_ID.value(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1200,
      aud: "appstoreconnect-v1",
      bid: IOS_BUNDLE_ID,
    },
    APPLE_PRIVATE_KEY.value(),
    { algorithm: "ES256", header: { alg: "ES256", kid: APPLE_KEY_ID.value() } }
  );

  // 401/5xx: Apple tarafı anlık bir kimlik doğrulama/altyapı aksaklığı
  // olabilir (ör. cold-start sonrası ilk çağrı) — kesin geçersiz sonuç
  // (400/404) değildir, bu yüzden bir kez kısa gecikmeyle yeniden denenir.
  let resp = await fetchAppleTransaction(token, transactionId, false);
  if (resp.status === 401 || resp.status >= 500) {
    await sleep(500);
    resp = await fetchAppleTransaction(token, transactionId, false);
  }
  if (resp.status === 404) {
    resp = await fetchAppleTransaction(token, transactionId, true);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`Apple doğrulama başarısız: ${resp.status} ${body.slice(0, 200)}`);
    return { valid: false, orderId: transactionId };
  }
  const json = await resp.json();
  const valid = !!json.signedTransactionInfo;
  return { valid, orderId: transactionId };
}

/**
 * İstemciden satın alma bilgisini alır, ilgili mağazada doğrular, ve
 * başarılıysa Firestore wallet'ı (Admin SDK — client asla doğrudan
 * yazamaz, bkz. firestore.rules) günceller.
 *
 * data: { platform: 'ios'|'android', productId: string, purchaseToken: string }
 * dönüş: { success: boolean, photoBalance?: number, analysisBalance?: number }
 */
exports.verifyPurchase = onCall(
  {
    secrets: [GOOGLE_SERVICE_ACCOUNT_JSON, APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY],
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const { platform, productId, purchaseToken } = request.data || {};
    if (!platform || !productId || !purchaseToken) {
      throw new HttpsError("invalid-argument", "platform, productId ve purchaseToken zorunlu.");
    }
    const credit = PRODUCT_CREDITS[productId];
    if (!credit) {
      throw new HttpsError("invalid-argument", `Bilinmeyen ürün: ${productId}`);
    }

    let verification;
    try {
      verification = platform === "android"
        ? await verifyAndroidPurchase(productId, purchaseToken)
        : await verifyApplePurchase(productId, purchaseToken);
    } catch (e) {
      console.error("Satın alma doğrulama hatası:", e);
      throw new HttpsError("internal", "Satın alma doğrulanamadı.");
    }
    if (!verification.valid) {
      throw new HttpsError("failed-precondition", "Satın alma geçersiz.");
    }

    const walletRef = db.doc(`users/${uid}/private/wallet`);
    const processedRef = db.doc(`users/${uid}/private/processedPurchases/${verification.orderId}`);

    const result = await db.runTransaction(async (tx) => {
      const processedSnap = await tx.get(processedRef);
      const walletSnap = await tx.get(walletRef);
      const current = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };

      if (processedSnap.exists) {
        // Idempotency: zaten işlenmiş — tekrar kredi verme, mevcut bakiyeyi döndür.
        return current;
      }

      const updated = {
        ...current,
        [credit.field]: (current[credit.field] || 0) + credit.amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(walletRef, updated, { merge: true });
      tx.set(processedRef, {
        productId,
        platform,
        creditedField: credit.field,
        creditedAmount: credit.amount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return updated;
    });

    return {
      success: true,
      photoBalance: result.photoBalance || 0,
      analysisBalance: result.analysisBalance || 0,
    };
  }
);

/**
 * Hesap silme (KVKK/GDPR). Client'ın `user.delete()` çağrısı "requires
 * recent login" ile başarısız olabileceğinden, silme her zaman güvenilir
 * çalışsın diye Admin SDK üzerinden burada yapılır.
 */
exports.deleteAccount = onCall(
  // Storage SDK (bucket) yuklendigi icin 128MiB yetmiyor (OOM). 256MiB.
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      console.error("deleteAccount auth hatası:", e);
    }
    // Firestore'daki tüm alt koleksiyonları da temizle.
    await db.recursiveDelete(db.doc(`users/${uid}`));
    // KVKK/GDPR: Storage'daki tüm fotoğrafları da kalıcı sil (eğitim
    // selfie'leri + üretilen sonuçlar). recursiveDelete yalnızca Firestore'u
    // sildiği icin bu adim olmadan fotograflar geride kaliyordu.
    try {
      await Promise.all([
        bucket().deleteFiles({ prefix: `dating_training/${uid}/` }),
        bucket().deleteFiles({ prefix: `dating_results/${uid}/` }),
      ]);
    } catch (e) {
      console.error("deleteAccount storage silme hatası:", e);
    }
    return { success: true };
  }
);
