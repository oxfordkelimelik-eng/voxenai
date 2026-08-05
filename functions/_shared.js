const admin = require("firebase-admin");

// Bir process içinde yalnızca bir kez başlatılmalı — tüm modüller bu
// dosyayı import ederek aynı admin/db örneğini paylaşır.
if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Bucket erişimi lazy (getter) — modül yüklenirken değil, ilk gerçek
// kullanımda çözülür. Bu, storageBucket config'i henüz hazır olmayan
// yerel/test ortamlarında import zincirinin kırılmasını önler.
let _bucket = null;
function bucket() {
  if (!_bucket) _bucket = admin.storage().bucket();
  return _bucket;
}

// ============================================================
// GÜVENLİK YARDIMCILARI
// ============================================================

const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Kullanıcıdan gelen kimlik dizgelerini (jobId gibi) doğrular.
 *
 * NEDEN: jobId doğrudan Firestore doküman yoluna ve Storage nesne adına
 * gömülüyor (`users/{uid}/private/genData/genJobs/{jobId}`,
 * `dating_results/{uid}/{jobId}/...`). Doğrulanmazsa içine "/" koyan bir
 * istemci, beklenmedik derinlikte doküman/nesne yolları oluşturabilir.
 * Firestore ".." desteklemediği ve tüm yollar users/{uid} altında kaldığı
 * için üst dizine çıkış mümkün değil; yine de yol biçimini istemcinin
 * belirlemesine izin vermek gereksiz bir serbestlik — burada kapatılıyor.
 *
 * İstemci uuid v4 üretiyor; kural onu kapsayacak kadar geniş, yol
 * ayracı/kontrol karakteri kabul etmeyecek kadar dar.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeId(value, fieldName) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} geçersiz (yalnızca harf, rakam, - ve _; en fazla 64 karakter).`
    );
  }
  return value;
}

/**
 * Kullanıcı başına kayan pencere hız sınırı (Firestore sayaçlı, atomik).
 *
 * NEDEN GEREKLİ: prepareReferencePhotos ve startPhotoGeneration her çağrıda
 * GERÇEK PARA harcıyor (OpenAI görsel üretimi + Vision kontrolü + Gemini
 * caption). Bu fonksiyonlarda daha önce HİÇBİR hız sınırı yoktu: geçerli bir
 * kimlik belirteci olan biri döngüye alıp faturayı sınırsız şişirebilirdi.
 * Bakiye kontrolü bunu tek başına engellemiyor, çünkü prepareReferencePhotos
 * bakiyeye hiç bakmıyor ve ücretsiz hak da maliyet doğuruyor.
 *
 * Sayaç users/{uid}/private/rateLimits/{bucket} altında tutulur; istemci bu
 * yola YAZAMAZ (firestore.rules: private/** için write: false), dolayısıyla
 * sıfırlanamaz.
 *
 * Pencere dolduğunda "resource-exhausted" atar — istemci bunu kullanıcıya
 * anlaşılır bir mesajla gösterir.
 */
async function enforceRateLimit(uid, bucketName, { max, windowMs, message }) {
  const ref = db.doc(`users/${uid}/private/rateLimits/buckets/${bucketName}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const windowStart = data?.windowStart || 0;
    const count = data?.count || 0;

    // Pencere kapandıysa sıfırdan başla.
    if (now - windowStart >= windowMs) {
      tx.set(ref, { windowStart: now, count: 1, updatedAt: now }, { merge: true });
      return;
    }
    if (count >= max) {
      const retryInSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      console.warn(
        `HIZ SINIRI: uid=${uid} bucket=${bucketName} count=${count}/${max} ` +
        `— ${retryInSec}sn sonra tekrar denenebilir`
      );
      throw new HttpsError("resource-exhausted", message ||
        `Çok fazla istek gönderildi. ${Math.ceil(retryInSec / 60)} dakika sonra tekrar dene.`);
    }
    tx.set(ref, { count: count + 1, updatedAt: now }, { merge: true });
  });
}

/**
 * App Check denetimi.
 *
 * DURUM: şu an YALNIZCA İZLEME modunda (APP_CHECK_ENFORCED=false). Sebep:
 * zorlama açılmadan önce Firebase Console'da App Check'in etkinleştirilmesi
 * ve istemcinin (App Attest / Play Integrity) token üretmeye başlaması
 * gerekir. Sıra bozulursa CANLI uygulamadaki tüm çağrılar reddedilir.
 *
 * Doğru sıra:
 *   1) Bu kod + istemci App Check başlatması yayınlanır (şu anki adım),
 *   2) Firebase Console > App Check'te iOS App Attest / Android Play
 *      Integrity kaydedilir, "Metrikler" bölümünde doğrulanmış istek oranı
 *      izlenir,
 *   3) Oran ~%100 olduğunda APP_CHECK_ENFORCED true yapılıp yeniden yayınlanır.
 *
 * NEDEN ÖNEMLİ: App Check olmadan, uygulamanın içinden çıkarılabilen Firebase
 * Web API anahtarıyla anonim hesap açıp fonksiyonları doğrudan çağırmak
 * mümkün. Kullanıcı başına hız sınırı bunu tek başına durdurmaz, çünkü
 * saldırgan her seferinde YENİ bir anonim kimlik alabilir. App Check,
 * çağrının gerçekten sizin uygulamanızdan geldiğini garanti eden tek kontrol.
 */
const APP_CHECK_ENFORCED = false;
function checkAppAttestation(request, fnName) {
  if (request.app) return; // doğrulanmış istemci
  if (APP_CHECK_ENFORCED) {
    throw new HttpsError("failed-precondition", "Doğrulanmamış istemci.");
  }
  console.warn(`APP CHECK YOK: ${fnName} çağrısında doğrulanmış istemci belirteci gelmedi (izleme modu).`);
}

module.exports = {
  admin, db, bucket,
  assertSafeId, enforceRateLimit, checkAppAttestation, APP_CHECK_ENFORCED,
};
