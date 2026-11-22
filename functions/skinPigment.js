// TEN PİGMENTİ (2026-10-29, 546b514b devamı — bkz. faceRelight.js POZLAMA).
//
// Piksel ölçümüyle ışık ile pigmenti ayıramıyorduk (bkz. [[face-exposure-hue]]
// 10-22/10-28): gölgedeki açık ten ile koyu ten aynı sayıyı veriyor. Bunun
// yerine bir VİZYON MODELİNE sahnenin ışığını yok sayıp yalnız derinin
// pigmentini (Monk Skin Tone, 1-10) tahmin etmesi söyleniyor — model kıyafet,
// arka plan ve yüz ifadesinden "bu sahne nasıl aydınlatılmış" çıkarımı
// yapabiliyor, piksel istatistiği yapamıyor.
//
// Ucuz model (gpt-4.1-mini) yeterli: düşük çözünürlük (512px, detail=low),
// yalnız bir sayı + bir etiket. Çağıran taraf (falPhotos.js/postTasks.js)
// başarısızlıkta null alır ve POZLAMA hiç hesaplanmaz (faceRelight.js
// EXPOSURE_ON + mstUser/mstTpl ikisi de gerekli).

const sharp = require("sharp");
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4.1-mini";

const PROMPT = `Estimate this person's NATURAL skin pigmentation — how their skin would look under neutral, well-exposed daylight — NOT how bright or dark it appears in this photo.
The photo may be underexposed, in shade, backlit, at sunset, under warm lamps, or overexposed. Discount the lighting: judge the skin itself using undertone, how the rest of the scene is lit, and the person's features.
Use the Monk Skin Tone scale: 1 = very light (porcelain), 2-3 = light, 4-5 = light-medium/olive, 6-7 = medium-brown, 8-10 = dark brown to deepest.
Reply with JSON only: {"mst": <integer 1-10>}`;

async function cropFace(buf, box, pad = 0.5) {
  const meta = await sharp(buf).rotate().metadata();
  let region = { left: 0, top: 0, width: meta.width, height: meta.height };
  if (box) {
    const left = Math.max(0, Math.round(box.x - pad * box.width));
    const top = Math.max(0, Math.round(box.y - pad * box.height));
    const width = Math.min(meta.width - left, Math.round(box.width * (1 + 2 * pad)));
    const height = Math.min(meta.height - top, Math.round(box.height * (1 + 2 * pad)));
    if (width >= 16 && height >= 16) region = { left, top, width, height };
  }
  return sharp(buf).rotate().extract(region).resize(448, 448, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer();
}

// Kare başına bitirme yolunda koşar; takılırsa yüz ışığı pigmentsiz sürer (null).
const ASK_TIMEOUT_MS = 20000;
async function askMst(apiKey, img) {
  const resp = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}`, detail: "low" } }] }],
    }),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  if (json.usage) { try { require("./jobContext").recordUsage(MODEL, json.usage); } catch (e) { /* jobContext yoksa (yerel test) sessiz geç */ } }
  const text = json?.choices?.[0]?.message?.content || "";
  try {
    const v = Math.round(JSON.parse(text).mst);
    return v >= 1 && v <= 10 ? v : null;
  } catch (e) { return null; }
}

/**
 * Birden çok kırpımın (selfie'ler ya da tek şablon) MEDYAN MST'si.
 * FAIL-SAFE: apiKey yoksa ya da tüm sorular başarısız olursa null — çağıran
 * taraf POZLAMA'yı atlar (faceRelight.js EXPOSURE_ON mstUser/mstTpl gerektirir).
 */
async function estimateMst(buffers, apiKey, boxes = null) {
  if (!apiKey || !buffers || !buffers.length) return null;
  try {
    const vals = [];
    // Her görsel kendi try/catch'inde (2026-11-20 inceleme): tek zaman aşımı selfie setinin
    // tamamını düşürüp pigmenti (yüz ışığı + el onarımı) kapatmasın; medyan başarılı olanlardan.
    for (let i = 0; i < buffers.length; i++) {
      try {
        const img = await cropFace(buffers[i], boxes ? boxes[i] : null);
        const v = await askMst(apiKey, img);
        if (v != null) vals.push(v);
      } catch (e) {
        console.warn(`Ten pigmenti: görsel ${i} atlandı (${e.name || ""} ${e.message || e})`);
      }
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  } catch (e) {
    console.error("Ten pigmenti tahmin edilemedi (pozlama atlanacak):", e.message || e);
    return null;
  }
}

// ŞABLON MST: ÜÇ KIRPIM MEDYANI (2026-11-22, akış incelemesi). Tek kırpım (yüz ±0.5) aynı şablonda
// işten işe ±1 oynuyordu (Onur işleri 11-12..11-16, aynı 10 şablon × 6 iş: 4 şablonda 4↔5, 2↔3, 5↔6).
// İstem "ışığı sahneden çıkar" diyor ama sıkı kırpım sahneyi kesiyordu. Yüz (0.5), baş-omuz (1.5) ve
// geniş sahne (4) ayrı sorulur; medyan. İki oy kalırsa yuvarlanmış ortalama. Şablon başına 3 küçük
// çağrı (gpt-4.1-mini, detail=low) — sonuç şablon başına önbellekte (templateVision.js).
const TEMPLATE_PADS = [0.5, 1.5, 4];
function voteMst(votes) {
  const v = votes.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 2) return Math.round((v[0] + v[1]) / 2);
  return v[Math.floor(v.length / 2)];
}
/** Şablon kişisinin MST değeri: { mst, votes } ya da null (hiç oy yoksa). */
async function estimateTemplateMst(buf, box, apiKey) {
  if (!apiKey || !Buffer.isBuffer(buf) || !box) return null;
  const votes = await Promise.all(TEMPLATE_PADS.map(async (pad) => {
    try {
      return await askMst(apiKey, await cropFace(buf, box, pad));
    } catch (e) {
      console.warn(`Şablon ten pigmenti: kırpım ${pad} atlandı (${e.name || ""} ${e.message || e})`);
      return null;
    }
  }));
  const mst = voteMst(votes);
  return mst == null ? null : { mst, votes };
}

module.exports = { estimateMst, estimateTemplateMst, _testables: { cropFace, askMst, voteMst, PROMPT, MODEL, TEMPLATE_PADS } };
