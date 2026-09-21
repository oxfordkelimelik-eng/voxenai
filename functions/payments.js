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
// Bir ürün BİRDEN ÇOK alana kredi verebilir (2026-09-18): yeni foto
// paketlerinde HEDİYE ANALİZ var, yani tek satın alma hem photoBalance hem
// analysisBalance yüklüyor. Eski yapı ürünü tek bir alana eşliyordu ve
// hediye sessizce yüklenmezdi.
//
// photoBalance ARTIK FOTO SAYAR (eskiden "stil/set" sayardı, 1 birim = 10
// foto). Bkz. falPhotos.photoUnitsFor.
const PRODUCT_CREDITS = {
  // TEK BAŞINA SATIŞ KALDIRILACAK (2026-09-21, henüz kaldırılmadı): yeni
  // modelde analiz paketleri yalnızca bir AI Foto paketinin yanında opsiyonel
  // ek olarak satılacak (bkz. aşağıdaki "OPSİYONEL ANALİZ EKLENTİLİ
  // PAKETLER"). Ama bu iki ID mağazada (ASC/Play) HÂLÂ satışta ve mevcut
  // paywall'da hâlâ tek başına satın alınabilir kartlar olarak duruyor —
  // yeni paywall build'i yayına girip yeterince yayılana KADAR buradan
  // kaldırılmayacaklar (aksi halde eski build'deki kullanıcı butona basar,
  // ürün mağazadan kaldırılmışsa hata alır). Satıştan kaldırma sırası:
  // (1) yeni paywall UI'si yayına girsin, (2) ASC/Play'de Remove From Sale
  // yapılsın, (3) ancak O ZAMAN bu iki satır "ESKİ ÜRÜNLER" bloğuna taşınır.
  dating_pack_analysis1: { analysisBalance: 1 },
  dating_pack_analysis5: { analysisBalance: 5 },

  // --- YENİ FOTO PAKETLERİ (2026-09-18) ---
  // Fiyatlar App Store Connect / Play Console'da tanımlı; kod fiyat bilmez.
  //
  // DOKUNULMUYOR (2026-09-21): photos10/photos25'in hediye analizi mevcut
  // paywall'da kullanıcıya AÇIKÇA vaat ediliyor ("+1/+3 analiz hediye" —
  // bkz. paywall_screen.dart _PackCard sub metinleri). Bu ID'lerin kredi
  // tablosunu değiştirmek, henüz güncellemeyen kullanıcılara (eski build
  // hâlâ App Store'da/cihazlarda) o vaadi kesip parasının karşılığını
  // eksik vermek demektir. Onun yerine opsiyonel-analiz modeli TAMAMEN
  // YENİ ID'lerle ekleniyor (bkz. aşağıdaki blok) — tıpkı Ağustos'taki
  // photo10->photos5 geçişinde yapıldığı gibi (bkz. dating_constants.dart
  // "YENİ ÜRÜN ID'LERİ" notu).
  dating_pack_photos5: { photoBalance: 5 },                        // ₺349
  dating_pack_photos10: { photoBalance: 10, analysisBalance: 1 },  // ₺499 (+1 hediye)
  dating_pack_photos25: { photoBalance: 25, analysisBalance: 3 },  // ₺999 (+3 hediye)

  // --- OPSİYONEL ANALİZ EKLENTİLİ PAKETLER (2026-09-21) ---
  //
  // YENİ MODEL: analiz paketleri artık TEK BAŞINA satılmıyor (bkz.
  // dating_pack_analysis1/5'in "ESKİ ÜRÜNLER" bloğuna taşınma gerekçesi
  // altında); yalnızca bir AI Foto paketinin yanına OPSİYONEL, ödemeli bir
  // ek olarak eklenebiliyor. Bu, checkbox'ın işaretli/işaretsiz haline göre
  // İKİ FARKLI SKU satın alınması demek — Apple/Google IAP'de tek ödemede
  // dinamik fiyat yok, her fiyat noktası ayrı bir üründür.
  //
  // Başlangıç (5 foto) zaten hediyesizdi, sade hâli hâlâ dating_pack_photos5
  // — ona yeni bir "solo" ID gerekmedi. Standart/Premium'un sade hâli ise
  // YENİ "_solo" ID'lerle geldi çünkü eski ID'ler hediyeli kalmaya devam
  // ediyor (yukarıdaki not).
  dating_pack_photos5_analysis1: { photoBalance: 5, analysisBalance: 1 },   // ₺448
  dating_pack_photos10_solo: { photoBalance: 10 },                          // ₺499 (analizsiz)
  dating_pack_photos10_analysis3: { photoBalance: 10, analysisBalance: 3 }, // ₺748
  dating_pack_photos25_solo: { photoBalance: 25 },                          // ₺999 (analizsiz)
  dating_pack_photos25_analysis5: { photoBalance: 25, analysisBalance: 5 }, // ₺1.348

  // --- ESKİ ÜRÜNLER — SİLİNMEZ ---
  // Mağazadan kaldırılsalar bile iki yol bu ID'leri hâlâ gönderebilir:
  //  1) "Satın Alımları Geri Yükle" eski bir makbuzu tekrar sunabilir,
  //  2) kaldırma anında ödemesi YOLDA olan bir satın alma tamamlanabilir.
  // Haritadan silinirlerse o kullanıcı "Bilinmeyen ürün" hatası alır ve
  // parasının karşılığını alamaz. Foto birimine çevrilmiş hâlleriyle
  // duruyorlar: eskiden 1 birim = 10 foto, 5 birim = 50 foto idi.
  dating_pack_photo10: { photoBalance: 10 },
  dating_pack_photo50: { photoBalance: 50 },
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

  // Production'ı dene; 5xx'te bir kez retry et (anlık aksaklık). Production
  // OK değilse (401/404 dahil) SANDBOX'ı da dene: TestFlight/Sandbox satın
  // almaları production host'ta 404 YERİNE 401 de dönebiliyor — bu yüzden
  // yalnızca 404'te değil, her başarısız production yanıtında sandbox'a düşülür.
  let resp = await fetchAppleTransaction(token, transactionId, false);
  if (resp.status >= 500) {
    await sleep(500);
    resp = await fetchAppleTransaction(token, transactionId, false);
  }
  if (!resp.ok) {
    const prodStatus = resp.status;
    const prodBody = await resp.text().catch(() => "");
    const sandboxResp = await fetchAppleTransaction(token, transactionId, true);
    if (sandboxResp.ok) {
      resp = sandboxResp;
    } else {
      const sbBody = await sandboxResp.text().catch(() => "");
      const authErr = sandboxResp.headers.get("www-authenticate") ||
        resp.headers.get("www-authenticate") || "";
      // Teşhis: 401 genelde JWT yetki reddidir (yanlış issuer/anahtar türü).
      console.error(
        `Apple doğrulama başarısız: prod=${prodStatus} sandbox=${sandboxResp.status} ` +
        `prodBody="${prodBody.slice(0, 200)}" sbBody="${sbBody.slice(0, 200)}" ` +
        `www-authenticate="${authErr}" kid=${APPLE_KEY_ID.value()} ` +
        `issPrefix=${String(APPLE_ISSUER_ID.value()).slice(0, 8)}`,
      );
      return { valid: false, orderId: transactionId };
    }
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
    // NOT: 'users/{uid}/private/processedPurchases/{orderId}' 5 parça (tek sayı)
    // = geçersiz Firestore doküman yolu. Araya sabit 'payments' dokümanı
    // eklenerek 6 parçaya (geçerli) çıkarılır — genJobs ile aynı düzeltme.
    const processedRef = db.doc(
      `users/${uid}/private/payments/processedPurchases/${verification.orderId}`);

    const result = await db.runTransaction(async (tx) => {
      const processedSnap = await tx.get(processedRef);
      const walletSnap = await tx.get(walletRef);
      const current = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };

      if (processedSnap.exists) {
        // Idempotency: zaten işlenmiş — tekrar kredi verme, mevcut bakiyeyi döndür.
        return current;
      }

      // Ürünün TÜM alanları yüklenir (foto + varsa hediye analiz).
      const updated = {
        ...current,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      for (const [field, amount] of Object.entries(credit)) {
        updated[field] = (current[field] || 0) + amount;
      }
      tx.set(walletRef, updated, { merge: true });
      tx.set(processedRef, {
        productId,
        platform,
        // Yüklenen alanların TAMAMI kaydedilir. Eski tekil alanlar
        // (creditedField/creditedAmount) ops paneli ve geçmiş raporlar için
        // korunuyor — çok alanlı üründe BİRİNCİ alanı gösterirler.
        credited: credit,
        creditedField: Object.keys(credit)[0],
        creditedAmount: Object.values(credit)[0],
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
        bucket().deleteFiles({ prefix: `dating_rejected/${uid}/` }),
      ]);
    } catch (e) {
      console.error("deleteAccount storage silme hatası:", e);
    }
    return { success: true };
  }
);
