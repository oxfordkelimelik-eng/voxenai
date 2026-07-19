// Barrel dosyası — gerçek implementasyonlar konuya göre ayrılmış dosyalarda:
//   gemini.js       — Gemini proxy (analyzeImage, chat)
//   payments.js     — satın alma doğrulama + hesap silme
//   falPhotos.js    — fal.ai AI foto üretimi (hazırlık + üretim + webhook)
//   modelBakeoff.js — GEÇİCİ model karşılaştırma aracı (test bitince sil)
const gemini = require("./gemini");
const payments = require("./payments");
const falPhotos = require("./falPhotos");
const modelBakeoff = require("./modelBakeoff");

Object.assign(exports, gemini, payments, modelBakeoff);

// falPhotos'un yalnızca GERÇEK Cloud Function'larını dışa aç. Dosya ayrıca
// modelBakeoff'un kullandığı yardımcıları (buildPromptForBakeoff vb.) da
// export ediyor; bunlar onCall/onRequest sarmalayıcısı olmadığı için zaten
// deploy edilmezdi, ama barrel'a hiç girmemeleri daha temiz.
for (const name of [
  "prepareReferencePhotos",
  "startPhotoGeneration",
  "falInferenceWebhook",
  "cleanupStuckGenJobs",
]) {
  exports[name] = falPhotos[name];
}
