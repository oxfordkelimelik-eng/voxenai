// Yüklenen referans selfie'lerde +18/uygunsuz içerik kontrolü — Google Cloud
// Vision SafeSearch. fal.ai'ye hiçbir görsel gönderilmeden ÖNCE, üretim
// başlamadan çalışır (bakiye düşülmüşse bile fal işi hiç gönderilmez, çağıran
// taraf refundAndFail ile iade eder — bkz. falPhotos.js).
//
// Vision API çağrısının kendisi başarısız olursa (API kapalı/kota/ağ hatası)
// FAIL-OPEN davranılır: kullanıcı engellenmez, sadece loglanır. Bu, tek bir
// bulut servisi kesintisinin tüm AI foto özelliğini kilitlememesi içindir —
// aynı fail-safe felsefesi faceQuality.js'te de kullanılıyor. Gerçek içerik
// tespiti (adult/racy LIKELY+) ise her zaman engeller.

const vision = require("@google-cloud/vision");

let _client = null;
function client() {
  if (!_client) _client = new vision.ImageAnnotatorClient();
  return _client;
}

// LIKELY ve VERY_LIKELY reddedilir; POSSIBLE geçirilir (yanlış-pozitif çok
// sık — bikini/plaj gibi meşru dating fotoğraflarını gereksiz elememek için).
const REJECT_LEVELS = new Set(["LIKELY", "VERY_LIKELY"]);

/**
 * Bir JPEG buffer'ının müstehcen/rahatsız edici içerik taşıyıp taşımadığını
 * kontrol eder. true = reddedilmeli.
 */
async function isExplicit(buf) {
  const [result] = await client().safeSearchDetection({ image: { content: buf } });
  const s = result.safeSearchAnnotation;
  if (!s) return false;
  return REJECT_LEVELS.has(s.adult) || REJECT_LEVELS.has(s.racy);
}

module.exports = { isExplicit };
