// Barrel dosyası — gerçek implementasyonlar konuya göre ayrılmış dosyalarda:
//   aiProxy.js      — OpenAI proxy (analyzeImage, chat) + consumeAnalysis
//   payments.js     — satın alma doğrulama + hesap silme
//   falPhotos.js    — AI foto üretimi (hazırlık + üretim + webhook)
//   opsPanel.js     — uygulama-içi gizli işletim paneli (satın alma +
//                     üretim istatistikleri, tek email'e kilitli)
//   notifications.js — satın alma hatırlatma push kampanyası (ücretsiz
//                     deneme kullanıp satın almayan kullanıcılara)
//
// NOT (2026-08-20): eski gemini.js SİLİNDİ. Google Gemini projeden tamamen
// kaldırıldı; tek AI sağlayıcı OpenAI (bkz. aiProxy.js dosya başı notu).
const aiProxy = require("./aiProxy");
const payments = require("./payments");
const falPhotos = require("./falPhotos");
const opsPanel = require("./opsPanel");
const notifications = require("./notifications");

Object.assign(exports, aiProxy, payments);

// falPhotos'un yalnızca GERÇEK Cloud Function'larını dışa aç.
for (const name of [
  "prepareReferencePhotos",
  "startPhotoGeneration",
  "falInferenceWebhook",
  "cleanupStuckGenJobs",
  "cleanupExpiredReadyJobs",
]) {
  exports[name] = falPhotos[name];
}

for (const name of ["opsGetOverview", "opsGetJobDetail", "opsFindJobByJobId"]) {
  exports[name] = opsPanel[name];
}

for (const name of [
  "registerFcmToken",
  "onWalletWrite",
  "onPurchaseWrite",
  "sendEngagementReminders",
]) {
  exports[name] = notifications[name];
}
