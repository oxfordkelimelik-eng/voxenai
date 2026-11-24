const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { google } = require("googleapis");
const { admin, db, bucket } = require("./_shared");
const { packSizeOfCredit, addPack } = require("./photoPacks");
const PC = require("./purchaseCheck");

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
//
// RIZZGPT + PROFİL DOKTORU HEDİYESİ (2026-11-24, kullanıcı kararı): iki modülün
// günlük ücretsiz hakkı kaldırıldı; hak YALNIZ foto paketiyle, adetli gelir
// (5'li: 3 + 2, 10'lu: 7 + 5, 25'li ve üstü: 10 + 10). Fiyatlar aynı, ürün
// ID'leri aynı — yalnız yüklenen alanlar arttı. Her foto ürününe foto
// sayısına göre eklenir (eski ID'lerle alınan da aynı hediyeyi alır).
// lib/core/constants/dating_constants.dart PhotoPackTier.rizzRuns/doctorRuns
// ile EL İLE senkron.
const TOOLS_5 = { rizzBalance: 3, profileDoctorBalance: 2 };
const TOOLS_10 = { rizzBalance: 7, profileDoctorBalance: 5 };
const TOOLS_25 = { rizzBalance: 10, profileDoctorBalance: 10 };
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
  dating_pack_photos5: { photoBalance: 5, ...TOOLS_5 },            // ₺349
  dating_pack_photos10: { photoBalance: 10, analysisBalance: 1, ...TOOLS_10 },  // ₺499 (+1 hediye)
  dating_pack_photos25: { photoBalance: 25, analysisBalance: 3, ...TOOLS_25 },  // ₺999 (+3 hediye)

  // --- OPSİYONEL ANALİZ EKLENTİLİ PAKETLER (2026-09-21) ---
  //
  // YENİ MODEL: analiz paketleri artık TEK BAŞINA satılmıyor (bkz.
  // dating_pack_analysis1/5'in "ESKİ ÜRÜNLER" bloğuna taşınma gerekçesi
  // altında); yalnızca bir AI Foto paketinin yanına OPSİYONEL, ödemeli bir
  // ek olarak eklenebiliyor. Bu, checkbox'ın işaretli/işaretsiz haline göre
  // İKİ FARKLI SKU satın alınması demek — Apple/Google IAP'de tek ödemede
  // dinamik fiyat yok, her fiyat noktası ayrı bir üründür.
  //
  // ÜÇ TIER'IN DE "_solo" ID'Sİ VAR (2026-09-21, kullanıcı kararı).
  // Başlangıç'ın sade hâli içerik olarak eski dating_pack_photos5 ile
  // aynı (5 foto, analizsiz, ₺349) ama YİNE DE ayrı bir ID: yeni paywall
  // eski nesil ID'lerin HİÇBİRİNE bağlanmazsa, eski üçlü (photos5/10/25)
  // ileride tek seferde Remove From Sale edilebilir. Yeni paywall eski
  // ID'ye bağlı kalsaydı o ürün sonsuza kadar satışta tutulmak zorundaydı.
  dating_pack_photos5_solo: { photoBalance: 5, ...TOOLS_5 },                            // ₺349 (analizsiz)
  dating_pack_photos5_analysis1: { photoBalance: 5, analysisBalance: 1, ...TOOLS_5 },   // ₺799 (2026-09-28, analiz hediye)
  dating_pack_photos10_solo: { photoBalance: 10, ...TOOLS_10 },                          // ₺499 (analizsiz)
  dating_pack_photos10_analysis3: { photoBalance: 10, analysisBalance: 3, ...TOOLS_10 }, // ₺999 (2026-09-28, analiz hediye)
  dating_pack_photos25_solo: { photoBalance: 25, ...TOOLS_25 },                          // ₺999 (analizsiz)
  dating_pack_photos25_analysis5: { photoBalance: 25, analysisBalance: 5, ...TOOLS_25 }, // ₺1.799 (2026-09-28, analiz hediye)

  // --- ESKİ ÜRÜNLER — SİLİNMEZ ---
  // Mağazadan kaldırılsalar bile iki yol bu ID'leri hâlâ gönderebilir:
  //  1) "Satın Alımları Geri Yükle" eski bir makbuzu tekrar sunabilir,
  //  2) kaldırma anında ödemesi YOLDA olan bir satın alma tamamlanabilir.
  // Haritadan silinirlerse o kullanıcı "Bilinmeyen ürün" hatası alır ve
  // parasının karşılığını alamaz. Foto birimine çevrilmiş hâlleriyle
  // duruyorlar: eskiden 1 birim = 10 foto, 5 birim = 50 foto idi.
  dating_pack_photo10: { photoBalance: 10, ...TOOLS_10 },
  dating_pack_photo50: { photoBalance: 50, ...TOOLS_25 },
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
  // purchaseState: 0 = satın alındı, 1 = iptal, 2 = beklemede; purchaseType 0 = lisanslı test (sandbox kuralı).
  return PC.evaluateAndroidPurchase(resp.data, { productId, purchaseToken });
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
      // Ürün denetimi burada DEĞİL: istemcinin JWS'i doğrulanmamış veridir. Apple'ın döndürdüğü
      // signedTransactionInfo aşağıda denetlenir (purchaseCheck.evaluateAppleTransaction).
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
      return { valid: false, reason: "unreadable" };
    }
  }
  const json = await resp.json();
  // ÜRÜN / UYGULAMA / İADE / ORTAM denetimi (2026-11-23): eskiden yalnız "işlem var mı"ya bakılıyordu; ucuz
  // paketin işlem no'su pahalı paket diye gönderilince pahalı paketin kredisi yükleniyordu. İşlem no da
  // istemciden değil Apple'dan alınır.
  const info = PC.decodeJwsPayload(json.signedTransactionInfo);
  return PC.evaluateAppleTransaction(info, { productId, bundleId: IOS_BUNDLE_ID });
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

    if (platform !== "ios" && platform !== "android") {
      throw new HttpsError("invalid-argument", "Geçersiz platform.");
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
      console.warn(`SATIN ALMA REDDİ: sebep=${verification.reason} platform=${platform} ürün=${productId} uid=${uid}`);
      throw new HttpsError("failed-precondition",
        PC.REJECT_MESSAGES[verification.reason] || "Satın alma geçersiz.", { reason: verification.reason || "invalid" });
    }
    const orderId = verification.orderId;
    const sandbox = !!verification.sandbox;
    // Sandbox (TestFlight/test hesabı, ücretsiz) için ayar: hesap başına sınır + izinli e-postalar.
    let payCfg = null;
    if (sandbox) {
      const [pc, rd] = await Promise.all([db.doc("config/payments").get(), db.doc("config/reviewDemo").get()]);
      payCfg = PC.paymentConfig(pc.exists ? pc.data() : null, rd.exists ? rd.data() : null);
    }
    const email = request.auth.token && typeof request.auth.token.email === "string" ? request.auth.token.email : "";

    const walletRef = db.doc(`users/${uid}/private/wallet`);
    // NOT: 'users/{uid}/private/processedPurchases/{orderId}' 5 parça (tek sayı)
    // = geçersiz Firestore doküman yolu. Araya sabit 'payments' dokümanı
    // eklenerek 6 parçaya (geçerli) çıkarılır — genJobs ile aynı düzeltme.
    const paymentsRef = db.doc(`users/${uid}/private/payments`);
    const processedRef = paymentsRef.collection("processedPurchases").doc(orderId);
    // TÜM HESAPLAR İÇİN TEK DEFTER (2026-11-23): "işlendi" kaydı eskiden yalnız kullanıcının kendi klasöründeydi;
    // aynı satın alma ikinci, üçüncü... hesapta tekrar gönderilince her hesaba kredi yükleniyordu. İstemciye
    // kapalı (firestore.rules: üst düzey her şey kapalı); hesap silmede SİLİNMEZ (silinip yeniden açılan hesap
    // aynı satın almayı tekrar kullanamasın). İçerik: uid, platform, işlem no, ürün, zaman — e-posta yok.
    const ledgerRef = db.doc(`purchaseLedger/${PC.ledgerId(platform, orderId)}`);

    const result = await db.runTransaction(async (tx) => {
      const [processedSnap, walletSnap, ledgerSnap, paymentsSnap] = await Promise.all([
        tx.get(processedRef), tx.get(walletRef), tx.get(ledgerRef), tx.get(paymentsRef),
      ]);
      const current = walletSnap.data() || { photoBalance: 0, analysisBalance: 0 };

      if (ledgerSnap.exists && ledgerSnap.get("uid") !== uid) {
        console.warn(`SATIN ALMA REDDİ: sebep=owned-by-other platform=${platform} ürün=${productId} ` +
          `işlem=${orderId} uid=${uid} sahip=${ledgerSnap.get("uid")}`);
        throw new HttpsError("failed-precondition", PC.REJECT_MESSAGES["owned-by-other"], { reason: "owned-by-other" });
      }
      if (processedSnap.exists || ledgerSnap.exists) {
        // Idempotency: zaten işlenmiş — tekrar kredi verme, mevcut bakiyeyi döndür.
        return current;
      }
      if (sandbox) {
        const prior = paymentsSnap.exists ? Number(paymentsSnap.get("sandboxPurchases")) || 0 : 0;
        const d = PC.sandboxDecision({ email, cfg: payCfg, priorCount: prior });
        if (!d.ok) {
          console.warn(`SATIN ALMA REDDİ: sebep=${d.reason} platform=${platform} ürün=${productId} uid=${uid} önceki=${prior}`);
          throw new HttpsError("failed-precondition", PC.REJECT_MESSAGES[d.reason], { reason: d.reason });
        }
        tx.set(paymentsRef, { sandboxPurchases: prior + 1 }, { merge: true });
      }
      tx.set(ledgerRef, {
        uid, platform, orderId, productId, sandbox,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Ürünün TÜM alanları yüklenir (foto + varsa hediye analiz).
      const updated = {
        ...current,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      for (const [field, amount] of Object.entries(credit)) {
        updated[field] = (current[field] || 0) + amount;
      }
      // PAKET DEFTERİ (2026-10-12): hangi paketin alındığı ayrıca sayılır —
      // birden fazla paketi olan kullanıcıya üretimde hangisini kullanacağı
      // sorulur (bkz. photoPacks.js).
      const packSize = packSizeOfCredit(credit);
      if (packSize) updated.photoPacks = addPack(current.photoPacks, packSize);
      tx.set(walletRef, updated, { merge: true });
      tx.set(processedRef, {
        productId,
        platform,
        // Sandbox (test, ücretsiz) satın alması: ops paneli ciroya katmaz.
        sandbox,
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
    // 2026-11-22: RizzGPT / Profil Doktoru bildirimleri üst düzey rizzReports'ta (uid alanıyla) duruyor;
    // users/{uid} altında olmadığı için recursiveDelete onları silmiyordu.
    try {
      const reports = await db.collection("rizzReports").where("uid", "==", uid).get();
      for (let i = 0; i < reports.docs.length; i += 400) {
        const batch = db.batch();
        reports.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.error("deleteAccount rizzReports silme hatası:", e);
    }
    // KVKK/GDPR: Storage'daki tüm fotoğrafları da kalıcı sil (eğitim
    // selfie'leri + üretilen sonuçlar). recursiveDelete yalnızca Firestore'u
    // sildiği icin bu adim olmadan fotograflar geride kaliyordu.
    try {
      // 2026-11-04: onay havuzu (staging) ve teşhis kopyaları
      // (dating_debug/<alt>/<uid>/) eklendi — bunlar da kullanıcının yüzünü
      // taşıyor ve TTL'leri dolmadan hesap silinirse geride kalıyordu.
      const debugSubdirs = ["selfies", "layers", "headscale", "surround", "resample", "eyewear"];
      await Promise.all([
        bucket().deleteFiles({ prefix: `dating_training/${uid}/` }),
        bucket().deleteFiles({ prefix: `dating_results/${uid}/` }),
        bucket().deleteFiles({ prefix: `dating_rejected/${uid}/` }),
        bucket().deleteFiles({ prefix: `dating_staging/${uid}/` }),
        ...debugSubdirs.map((d) => bucket().deleteFiles({ prefix: `dating_debug/${d}/${uid}/` })),
      ]);
    } catch (e) {
      console.error("deleteAccount storage silme hatası:", e);
    }
    return { success: true };
  }
);
