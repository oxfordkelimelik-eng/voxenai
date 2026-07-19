// Referans selfie'leri ucuz bir görsel-dil modeline (Gemini Flash)
// tarif ettirip, çıkan metni üretim prompt'una enjekte eder.
//
// Üretilen sinyaller:
//   1) identityCaption — yüz/kimlik (ten, saç, yaş bandı…)
//   2) bodyCaption     — tam boydan beden oranı (omuz, gövde…)
//   3) styleWardrobes  — stil başına kısa kıyafet/duruş notu
//
// FAIL-SAFE: herhangi biri başarısız olursa null/{} döner; üretim bloklanmaz.

const { defineSecret } = require("firebase-functions/params");

const GEMINI_KEY = defineSecret("GEMINI_KEY");

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
const geminiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const STYLE_LABELS = {
  elegance: "elegant / charismatic / well-groomed dating photos",
  athletic: "athletic / sporty / gym or outdoors dating photos",
  traveller: "world traveller / adventure dating photos",
  oldmoney: "classic old-money / refined dating photos",
  nightout: "night-out / social evening dating photos",
  beach: "beach / summer body dating photos",
  car: "prestige / car lifestyle dating photos",
};

async function callGemini({ key, prompt, imagePartsBase64, maxOutputTokens = 220, temperature = 0.2 }) {
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          ...imagePartsBase64.map((data) => ({
            inline_data: { mime_type: "image/jpeg", data },
          })),
        ],
      },
    ],
    generationConfig: { maxOutputTokens, temperature },
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

const IDENTITY_PROMPT =
  "Look at these reference photos of the same person and write ONE dense, factual, neutral " +
  "physical description in a single paragraph (2-3 sentences, no markdown, no headings). Include: " +
  "approximate age range, skin tone (be precise — do not lighten), hair colour/length/texture, " +
  "facial hair (if any), eyewear (if any), and any distinctive permanent features (scars, moles, " +
  "freckles, birthmarks). Be precise and literal, like a description for an identification document — " +
  "not flattering or poetic. Do NOT suggest making them younger, fitter, or more attractive. " +
  "Do not mention clothing, expression, or the photo's setting/background.";

const BODY_PROMPT =
  "Look at this full-body (or waist-up) reference photo and write ONE short factual paragraph " +
  "(1-2 sentences, no markdown) describing ONLY body build and proportions: approximate height " +
  "impression, shoulder width, torso length, overall build (slim/athletic/average/solid), and " +
  "anything distinctive about posture or silhouette. Be neutral and literal — do NOT idealise, " +
  "do NOT say athletic/fit unless clearly true in the photo, do NOT invent abs or a different " +
  "body type. Ignore face details and clothing brand names; clothing silhouette is OK only if " +
  "it reveals body shape.";

/**
 * Referans selfie buffer'larından (JPEG) kısa bir kimlik tarifi üretir.
 * Başarısız olursa null döner (fail-safe — üretim asla bloklanmaz).
 */
async function describeIdentity(buffers) {
  try {
    const key = GEMINI_KEY.value();
    if (!key || !buffers?.length) return null;
    const base64s = buffers.slice(0, 3).map((b) => b.toString("base64"));
    return await callGemini({
      key,
      prompt: IDENTITY_PROMPT,
      imagePartsBase64: base64s,
      maxOutputTokens: 200,
    });
  } catch (e) {
    console.error("identityCaption başarısız (caption olmadan devam ediliyor):", e);
    return null;
  }
}

/**
 * Tam boy (veya bel üstü) referanstan beden oranı tarifi.
 * bodyBuffer yoksa null. Fail-safe.
 */
async function describeBodyBuild(bodyBuffer) {
  try {
    const key = GEMINI_KEY.value();
    if (!key || !bodyBuffer) return null;
    return await callGemini({
      key,
      prompt: BODY_PROMPT,
      imagePartsBase64: [bodyBuffer.toString("base64")],
      maxOutputTokens: 160,
    });
  } catch (e) {
    console.error("bodyCaption başarısız (atlanıyor):", e);
    return null;
  }
}

/**
 * Seçilen stiller için kısa wardrobe/duruş notları.
 * Döner: { [styleId]: string } — başarısız veya boşsa {}.
 *
 * Tek Gemini çağrısı (maliyet/latency). Yanıt JSON beklenir; parse
 * edilemezse {}.
 */
async function describeStyleWardrobes(buffers, styleIds) {
  try {
    const key = GEMINI_KEY.value();
    if (!key || !buffers?.length || !Array.isArray(styleIds) || styleIds.length === 0) {
      return {};
    }
    const valid = styleIds.filter((id) => STYLE_LABELS[id]);
    if (valid.length === 0) return {};

    const styleList = valid
      .map((id) => `- ${id}: ${STYLE_LABELS[id]}`)
      .join("\n");

    const prompt =
      "You are styling dating-app photos for the SAME person shown in the reference images. " +
      "For EACH style id below, write ONE short wardrobe + vibe note (max 25 words) that fits " +
      "THIS person's apparent age, gender presentation, and body — realistic clothes someone " +
      "like them would actually wear on a phone camera, NOT a fashion editorial or costume.\n\n" +
      "Styles:\n" + styleList + "\n\n" +
      "Rules: no beauty fluff; no 'make them hotter'; keep it natural and wearable; if unsure, " +
      "prefer simple casual clothes. Return ONLY valid JSON object mapping style id to string, " +
      "no markdown fences, no extra keys. Example: {\"elegance\":\"navy blazer over white shirt, relaxed\"}";

    // Yüz + tam boy sinyali için en fazla 2 yüz + 1 beden (varsa son kare).
    const picks = [];
    if (buffers[0]) picks.push(buffers[0]);
    if (buffers[1] && buffers.length > 2) picks.push(buffers[1]);
    if (buffers.length > 3) picks.push(buffers[buffers.length - 1]);
    else if (buffers.length === 1) { /* already have [0] */ }
    else if (buffers.length >= 3) picks.push(buffers[2]);

    const text = await callGemini({
      key,
      prompt,
      imagePartsBase64: picks.map((b) => b.toString("base64")),
      maxOutputTokens: 400,
      temperature: 0.3,
    });
    if (!text) return {};

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Bazen model metin sarıyor — ilk {...} bloğunu dene.
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return {};
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return {};
      }
    }
    if (!parsed || typeof parsed !== "object") return {};

    const out = {};
    for (const id of valid) {
      const v = parsed[id];
      if (typeof v === "string" && v.trim()) {
        out[id] = v.trim().slice(0, 180);
      }
    }
    return out;
  } catch (e) {
    console.error("styleWardrobes başarısız (atlanıyor):", e);
    return {};
  }
}

module.exports = {
  describeIdentity,
  describeBodyBuild,
  describeStyleWardrobes,
  GEMINI_KEY,
};
