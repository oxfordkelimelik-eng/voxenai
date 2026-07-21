// Barrel dosyası — gerçek implementasyonlar konuya göre ayrılmış dosyalarda:
//   gemini.js       — Gemini proxy (analyzeImage, chat)
//   payments.js     — satın alma doğrulama + hesap silme
//   falPhotos.js    — fal.ai AI foto üretimi (hazırlık + üretim + webhook)
const gemini = require("./gemini");
const payments = require("./payments");
const falPhotos = require("./falPhotos");

Object.assign(exports, gemini, payments);

// falPhotos'un yalnızca GERÇEK Cloud Function'larını dışa aç.
for (const name of [
  "prepareReferencePhotos",
  "startPhotoGeneration",
  "falInferenceWebhook",
  "cleanupStuckGenJobs",
]) {
  exports[name] = falPhotos[name];
}
