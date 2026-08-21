// Barrel dosyası — gerçek implementasyonlar konuya göre ayrılmış dosyalarda:
//   aiProxy.js      — OpenAI proxy (analyzeImage, chat) + consumeAnalysis
//   payments.js     — satın alma doğrulama + hesap silme
//   falPhotos.js    — AI foto üretimi (hazırlık + üretim + webhook)
//
// NOT (2026-08-20): eski gemini.js SİLİNDİ. Google Gemini projeden tamamen
// kaldırıldı; tek AI sağlayıcı OpenAI (bkz. aiProxy.js dosya başı notu).
const aiProxy = require("./aiProxy");
const payments = require("./payments");
const falPhotos = require("./falPhotos");

Object.assign(exports, aiProxy, payments);

// falPhotos'un yalnızca GERÇEK Cloud Function'larını dışa aç.
for (const name of [
  "prepareReferencePhotos",
  "startPhotoGeneration",
  "falInferenceWebhook",
  "cleanupStuckGenJobs",
]) {
  exports[name] = falPhotos[name];
}
