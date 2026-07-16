const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { admin, db } = require("./_shared");

// Gemini anahtarı Firebase Secret olarak saklanır (kodda/APK'da görünmez)
const GEMINI_KEY = defineSecret("GEMINI_KEY");

// Foto analizinde ömür boyu ücretsiz gösterilen foto sayısı (hesap başına 1).
// dating_constants.dart DatingConfig.freePreviewCount ile senkron tutulmalı.
const FREE_ANALYSIS_PHOTOS = 1;

// Sıralı denenecek modeller — biri meşgulse (503) sıradakine geçilir.
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
];
const geminiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/**
 * Gemini'yi çağırır; 503/429 durumunda hem yeniden dener hem de model değiştirir.
 * Böylece bir model aşırı yüklüyse başka bir modelle yanıt üretilir.
 */
async function callGeminiWithRetry(key, body) {
  let lastStatus = 0;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch(geminiUrl(model, key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        console.log(`Gemini yanıt: ${model}`);
        return await resp.json();
      }
      lastStatus = resp.status;
      const txt = await resp.text();
      console.warn(`Model ${model} -> ${resp.status} (deneme ${attempt + 1})`);
      // Kalıcı hata (400/401/403) ise model değiştirmenin anlamı yok
      if ([400, 401, 403].includes(resp.status)) {
        throw new HttpsError("internal", `Gemini hatası: ${resp.status} ${txt.slice(0, 80)}`);
      }
      // Geçici hata: kısa bekle, sonra aynı modelde 1 kez daha, olmazsa sıradaki model
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw new HttpsError(
    "unavailable",
    `Tüm modeller meşgul (son durum ${lastStatus}). Lütfen biraz sonra tekrar deneyin.`
  );
}

/**
 * Foto analizi proxy'si: istemci görseli + prompt gönderir, anahtar burada eklenir.
 * Sadece giriş yapmış (anonim dahil) kullanıcılar çağırabilir.
 *
 * data: { prompt: string, imageBase64: string, mimeType: string }
 * dönüş: { text: string }  (Gemini'nin ham metin yanıtı)
 */
exports.analyzeImage = onCall(
  { secrets: [GEMINI_KEY], region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const { prompt, imageBase64, mimeType, images } = request.data || {};
    // Çok açılı (ön/sağ/sol) destek: images = [{data, mimeType}]. Tek görsel için
    // geriye dönük olarak imageBase64/mimeType da kabul edilir.
    const imgList = Array.isArray(images) && images.length > 0
      ? images
      : imageBase64
        ? [{ data: imageBase64, mimeType }]
        : [];
    if (!prompt || imgList.length === 0) {
      throw new HttpsError("invalid-argument", "prompt ve en az bir görsel zorunlu.");
    }

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            ...imgList.map((img) => ({
              inline_data: { mime_type: img.mimeType || "image/jpeg", data: img.data },
            })),
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.4 },
    };

    try {
      const json = await callGeminiWithRetry(GEMINI_KEY.value(), body);
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => typeof p.text === "string");
      if (!textPart) {
        throw new HttpsError("internal", "Gemini yanıtı boş.");
      }
      return { text: textPart.text };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("analyzeImage hata:", e);
      throw new HttpsError("internal", "Analiz başarısız.");
    }
  }
);

/**
 * Sohbet (sosyal antrenman) proxy'si.
 * data: { contents: [...], systemPrompt?: string }
 * dönüş: { text: string }
 */
exports.chat = onCall(
  { secrets: [GEMINI_KEY], region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const { contents } = request.data || {};
    if (!Array.isArray(contents) || contents.length === 0) {
      throw new HttpsError("invalid-argument", "contents zorunlu.");
    }

    const body = {
      contents,
      generationConfig: { maxOutputTokens: 2048, temperature: 0.8 },
    };

    try {
      const json = await callGeminiWithRetry(GEMINI_KEY.value(), body);
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => typeof p.text === "string");
      return { text: textPart ? textPart.text : "" };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("chat hata:", e);
      throw new HttpsError("internal", "Sohbet başarısız.");
    }
  }
);

/**
 * Foto analizi sonuçlarının kaç tanesinin AÇIK gösterileceğini SUNUCU
 * TARAFINDA atomik olarak belirler ve tüketir. İstemcinin yerel bakiyeyle
 * oynamasını engeller (analiz "kredi/hak" taşıyan bir kaynaktır).
 *
 * Kural:
 *  - Hesap başına ömür boyu ilk [FREE_ANALYSIS_PHOTOS] foto ücretsiz açılır
 *    (freeAnalysisUsed bir kez true olur, bir daha ücretsiz verilmez).
 *  - Kalan fotolar analysisBalance'tan foto başına 1 hak düşülerek açılır.
 *  - Bakiye yetmezse yetebildiği kadar açılır; gerisi kilitli (blur) kalır.
 *
 * data: { requested: number, alreadyUnlocked?: number }
 *   requested       = sonuç setindeki toplam foto sayısı
 *   alreadyUnlocked = bu set için DAHA ÖNCE (bu istekten önce) açılmış sayı;
 *                     yalnızca (requested - alreadyUnlocked) kadarı için yeni
 *                     hak/bakiye tüketilir (çift-sayım/çift-düşüm önlenir).
 * dönüş: { unlocked: number, usedFree: boolean, analysisBalance: number }
 *   unlocked = bu istekten sonra TOPLAM açık sayı (alreadyUnlocked dahil).
 */
exports.consumeAnalysis = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const requested = Number(request.data?.requested);
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new HttpsError("invalid-argument", "requested pozitif tam sayı olmalı.");
    }
    let alreadyUnlocked = Number(request.data?.alreadyUnlocked || 0);
    if (!Number.isInteger(alreadyUnlocked) || alreadyUnlocked < 0) {
      alreadyUnlocked = 0;
    }
    alreadyUnlocked = Math.min(alreadyUnlocked, requested);
    // Yeni açılması gereken (henüz açılmamış) foto sayısı.
    const toUnlock = requested - alreadyUnlocked;
    if (toUnlock <= 0) {
      return { success: true, unlocked: requested, usedFree: false };
    }

    const walletRef = db.doc(`users/${uid}/private/wallet`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(walletRef);
      const wallet = snap.data() || {};
      const analysisBalance = (wallet.analysisBalance || 0);
      const freeUsed = wallet.freeAnalysisUsed === true;

      // 1) Ücretsiz hak (hesap başına ömür boyu bir kez) — yalnızca bu set
      //    için henüz hiç açılmamışsa (alreadyUnlocked === 0) uygulanır.
      let newlyUnlocked = 0;
      let usedFree = false;
      if (!freeUsed && alreadyUnlocked === 0) {
        newlyUnlocked = Math.min(FREE_ANALYSIS_PHOTOS, toUnlock);
        usedFree = newlyUnlocked > 0;
      }

      // 2) Kalanları paket bakiyesinden karşıla (foto başına 1 hak).
      const stillLocked = toUnlock - newlyUnlocked;
      const fromPack = Math.min(stillLocked, analysisBalance);
      newlyUnlocked += fromPack;

      const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (usedFree) update.freeAnalysisUsed = true;
      if (fromPack > 0) update.analysisBalance = analysisBalance - fromPack;
      // Yazılacak bir şey yoksa (hepsi kilitli) transaction'ı boşuna yazma.
      if (usedFree || fromPack > 0) {
        tx.set(walletRef, update, { merge: true });
      }

      return {
        unlocked: alreadyUnlocked + newlyUnlocked,
        usedFree,
        analysisBalance: analysisBalance - fromPack,
      };
    });

    return { success: true, ...result };
  }
);
