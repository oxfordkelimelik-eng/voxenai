// Referans selfie'leri ucuz bir görsel-dil modeline (Gemini Flash)
// tarif ettirip, çıkan metni üretim prompt'unun kimlik cümlesine enjekte
// eder. Aynı Gemini entegrasyon deseni functions/gemini.js'te kullanılıyor
// (GEMINI_KEY secret, model fallback zinciri) — burada tekrar kuruldu çünkü
// bu modül fal.ai akışının (falPhotos.js) bir parçası, gemini.js'in genel
// amaçlı callable'larından bağımsız çalışması gerekiyor.
//
// NEDEN İŞE YARIYOR: edit modelleri görsel + metin sinyali HİZALANDIĞINDA
// kimliği belirgin biçimde daha iyi koruyor. Ayrıca modellerin sistematik
// eğilimlerini (cildi açma, yaşı küçültme) yazılı olarak ten tonu/yaş
// belirtmek bastırıyor — yalnızca görselden bu bilgi tam geçmiyor.
//
// FAIL-SAFE: Gemini çağrısı başarısız olursa (kota, ağ, boş yanıt) caption
// null döner — çağıran taraf (falPhotos.prepareReferencePhotos) bu durumda
// kimlik cümlesini caption'sız kurar, üretim ASLA bu adım yüzünden bloklanmaz.

const { defineSecret } = require("firebase-functions/params");

const GEMINI_KEY = defineSecret("GEMINI_KEY");

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
const geminiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

// Nötr, tarafsız, tanımlayıcı bir fiziksel tarif ister — bir polis eskiz
// sanatçısının notu gibi. Yargılayıcı/güzellik odaklı dil YASAKLANIR (o dil
// zaten modelin varsayılan "güzelleştirme" eğilimini güçlendirir).
const CAPTION_PROMPT =
  "Look at these reference photos of the same person and write ONE dense, factual, neutral " +
  "physical description in a single paragraph (2-3 sentences, no markdown, no headings). Include: " +
  "approximate age range, skin tone, hair colour/length/texture, facial hair (if any), eyewear " +
  "(if any), and any distinctive permanent features (scars, moles, freckles, birthmarks). Be " +
  "precise and literal, like a description for an identification document — not flattering or " +
  "poetic language. Do not mention clothing, expression, or the photo's setting/background.";

async function callGeminiCaption(key, imagePartsBase64) {
  const body = {
    contents: [
      {
        parts: [
          { text: CAPTION_PROMPT },
          ...imagePartsBase64.map((data) => ({
            inline_data: { mime_type: "image/jpeg", data },
          })),
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
  };

  for (const model of GEMINI_MODELS) {
    try {
      const resp = await fetch(geminiUrl(model, key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        console.warn(`identityCaption: model ${model} -> ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => typeof p.text === "string");
      if (textPart && textPart.text.trim()) return textPart.text.trim();
    } catch (e) {
      console.warn(`identityCaption: model ${model} hata:`, e.message || e);
    }
  }
  return null;
}

/**
 * Referans selfie buffer'larından (JPEG) kısa bir kimlik tarifi üretir.
 * Başarısız olursa null döner (fail-safe — üretim asla bloklanmaz).
 */
async function describeIdentity(buffers) {
  try {
    const key = GEMINI_KEY.value();
    if (!key) return null;
    const base64s = buffers.slice(0, 3).map((b) => b.toString("base64"));
    return await callGeminiCaption(key, base64s);
  } catch (e) {
    console.error("identityCaption başarısız (caption olmadan devam ediliyor):", e);
    return null;
  }
}

module.exports = { describeIdentity, GEMINI_KEY };
