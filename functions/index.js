// Barrel dosyası — gerçek implementasyonlar konuya göre ayrılmış dosyalarda:
//   gemini.js     — Gemini proxy (analyzeImage, chat)
//   payments.js   — satın alma doğrulama + hesap silme
//   falPhotos.js  — fal.ai AI foto üretimi (training + inference + webhook'lar)
// NOT: gemini modulu su an pasif (analiz modulu devre disi) — GEMINI_KEY
// secret'i gerektirmemek icin deploy'dan cikarildi. Yeniden aktiflesince
// asagidaki iki satiri geri ac.
// const gemini = require("./gemini");
const payments = require("./payments");
const falPhotos = require("./falPhotos");

Object.assign(exports, payments, falPhotos);
