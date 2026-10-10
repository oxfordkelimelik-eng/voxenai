/**
 * KAFA ÇEVRESİ KALINTI KAPISI — şablon kişisinin izi (2026-10-10).
 *
 * SORUN (kullanıcı, teslim edilen ve reddedilen kareler): yeni kafanın
 * çevresinde şablondaki kişiden soluk bir iz kalıyor — kıvırcık saçın beyaz
 * silüeti (b602b4b0 c0 1. deneme), kafanın üstünde gri saç halesi (ec81364e
 * c9), gözün yanında güneş gözlüğü camı (b8ae3f8d c5), yüzün yanında saydam
 * profil (61079257 c6). Ortak nokta: şablon kişisi yeni kişiden daha geniş
 * bir alan kaplıyor (kabarık saç, gözlük, profil burnu) ve model o fazlalığı
 * arka plana çevirirken izini bırakıyor. Kafa küçültmesi de aynı izi
 * üretebiliyor (dolgu modeli kafayı eski boyunda çizerse).
 *
 * NEDEN VISION: dört piksel ölçüsü denendi, hiçbiri ayırmadı — şablon
 * kenarının çıktıdaki yankısı (yeni kişinin konturu şablonunkiyle zaten
 * çakışıyor), kafa kırpımında kişi maskesi (iz kişinin parçası sayılıyor),
 * aksesuar sınıfı (saat/kulaklık daha büyük alan), şablon karışım oranı
 * (maske saç tepesini kaçırınca yanlış alarm; ec81 c9 halesi karışım değil
 * açık renk leke). İz gözle bariz; faceArtifactCrop.js'te kanıtlanan
 * yakınlaştırılmış kırpma yöntemi kullanılır.
 *
 * ŞABLON KIRPIMI DA VERİLİR: iz şablon kişisinin şeklini taşır (onun saçı,
 * onun gözlüğü, onun profili). Model iki kırpımı karşılaştırınca yeni
 * kişinin kendi saç telini ya da arka plandaki nesneyi iz sanmaz.
 *
 * FAIL-SAFE: yüz yok / cevap okunamadı / ağ hatası -> ELEMEZ.
 */
const sharp = require("sharp");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// gpt-4.1: 91 etiketli karede v3 prompt ile 0/75 yanlış alarm, belirgin
// kalıntının 10/11'i (gpt-4o v1 promptta 31/83 yanlış alarm verdi; gpt-5
// aynı sette daha çok yanlış alarm).
const HEAD_GHOST_MODEL = "gpt-4.1";
// Kırpım yüz kutusu cinsinden: kalıntı kafanın üstünde (saç halesi) ve
// yanlarında (profil, gözlük) — yüz kutusunun çok dışına taşıyor.
const CROP_W = 3.0;
const CROP_UP = 1.4;
const CROP_DOWN = 1.3;
const CROP_LONG_EDGE = 768;
const FACE_MIN_BOX_PX = 32;

const SYSTEM_MSG =
  "You are an automated quality-assurance component inside an image-" +
  "generation pipeline. You report rendering defects only — you never " +
  "identify, name, or speculate about who anyone is.";

// Örnek ifade VERİLMEZ (2026-10-10 ilk ölçüm): "grey hair halo above the
// head" örneği varken model 83 temiz karenin 31'ine aynı cümleyle GHOST
// dedi. Önce her bölgede gerçekte ne gördüğü yazdırılır, karar sonra.
const PROMPT =
  "Two crops of the same scene. IMAGE 1 is the ORIGINAL photo. IMAGE 2 is an edited " +
  "version in which the man's head was replaced by a different man's head.\n\n" +
  "Step 1. Describe, in 3 to 8 plain words each, exactly what is visible in IMAGE 2 in " +
  "these three places, just outside the new man's head and hair:\n" +
  "ABOVE: the area right above his hair\n" +
  "LEFT: the area right beside the left side of his head\n" +
  "RIGHT: the area right beside the right side of his head\n" +
  "Describe only what you actually see (for example a wall, sky, a curtain, leaves, a " +
  "window, a lamp, a person in the background).\n\n" +
  "Step 2. Decide. Answer GHOST only if in one of those places you can clearly see a " +
  "faint or see-through copy of part of the ORIGINAL man from IMAGE 1 — his hair, " +
  "head outline, face profile or glasses — that is not attached to the new man and " +
  "should have been replaced by background. This includes thin loose strands or loops " +
  "of hair floating over the background beyond the new man's hairline, where the " +
  "ORIGINAL man's bigger or curlier hair used to be. Background that also appears in IMAGE 1, " +
  "the new man's own hair and glasses on his face are NOT a ghost. When unsure, answer NONE.\n\n" +
  "Reply on exactly five lines:\n" +
  "ABOVE: <words>\n" +
  "LEFT: <words>\n" +
  "RIGHT: <words>\n" +
  "LEFTOVER: <NONE | GHOST>\n" +
  "WHERE: <ABOVE | LEFT | RIGHT | NONE>";

const REGIONS = ["ABOVE", "LEFT", "RIGHT"];

/**
 * Cevabı ayrıştırır. SAF — testten çağrılır.
 * Döner: { ok:true, bad, where, detail } | { ok:false, reason }
 * LEFTOVER satırı bağlayıcıdır; yoksa okunamadı sayılır (ELEMEZ).
 */
function parseHeadGhostReply(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  const line = /LEFTOVER\s*:\s*(NONE|GHOST)/i.exec(raw);
  if (!line) return { ok: false, reason: "unparsable" };
  const bad = line[1].toUpperCase() === "GHOST";
  const lines = raw.split("\n").map((l) => l.trim());
  const field = (k) => {
    const l = lines.find((x) => x.toUpperCase().startsWith(k + ":"));
    return l ? l.slice(k.length + 1).trim() : "";
  };
  const where = field("WHERE").toUpperCase().slice(0, 20);
  const detail = (REGIONS.includes(where) ? field(where) : REGIONS.map(field).join(" / ")).slice(0, 120);
  return { ok: true, bad, where, detail };
}

/** Kırpım dikdörtgeni (görüntü sınırlarına kırpılmış). SAF. */
function headCropRect(faceBox, W, H) {
  const cx = faceBox.x + faceBox.width / 2;
  const half = (CROP_W * faceBox.width) / 2;
  const left = Math.max(0, Math.round(cx - half));
  const right = Math.min(W, Math.round(cx + half));
  const top = Math.max(0, Math.round(faceBox.y - CROP_UP * faceBox.height));
  const bottom = Math.min(H, Math.round(faceBox.y + faceBox.height + CROP_DOWN * faceBox.height));
  return { left, top, width: Math.max(16, right - left), height: Math.max(16, bottom - top) };
}

/**
 * @param {Buffer} buf çıktı karesi
 * @param {Buffer} templateBuf şablon (herhangi boyut; çıktı boyutuna gerilir)
 * @param {{x,y,width,height}} faceBox çıktıdaki yüz kutusu
 * @param {string} apiKey
 */
async function judgeHeadGhost(buf, templateBuf, faceBox, apiKey, { model = HEAD_GHOST_MODEL } = {}) {
  try {
    if (!Buffer.isBuffer(buf) || !Buffer.isBuffer(templateBuf) || !faceBox || !apiKey) {
      return { ok: false, reason: "insufficient-input" };
    }
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "insufficient-input" };
    if (faceBox.width < FACE_MIN_BOX_PX || faceBox.height < FACE_MIN_BOX_PX) {
      return { ok: false, reason: "face-too-small" };
    }
    const r = headCropRect(faceBox, meta.width, meta.height);
    const scale = CROP_LONG_EDGE / Math.max(r.width, r.height);
    const size = [Math.max(1, Math.round(r.width * scale)), Math.max(1, Math.round(r.height * scale))];
    const tFull = await sharp(templateBuf).rotate().resize(meta.width, meta.height, { fit: "fill" }).toBuffer();
    const crop = async (b) => sharp(b).extract(r).resize(size[0], size[1], { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
    const [tCrop, oCrop] = await Promise.all([crop(tFull), crop(buf)]);
    const img = (b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}`, detail: "high" } });
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        // gpt-5 ailesi temperature/max_tokens almıyor.
        ...(/^gpt-5|^o\d/.test(model) ? { max_completion_tokens: 4000 } : { temperature: 0, max_tokens: 120 }),
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: [{ type: "text", text: PROMPT }, img(tCrop), img(oCrop)] },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    const json = await resp.json();
    if (json.usage) {
      const u = json.usage;
      console.log(`MALIYET KAFA KALINTI: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} model=${model}`);
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    return { ...parseHeadGhostReply(raw), raw };
  } catch (e) {
    console.error("Kafa kalıntı yargısı hata verdi (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

// ŞABLONDA GÖZLÜK (2026-10-10, kullanıcı kararı: "base'de gözlük varsa
// çıktıda da gözlük olsun"). Gözlüklü çıktıda gözler görünmez ve sayısal
// kimlik mesafesi eşiği aşar; bu soru o mesafenin güvenilir olup olmadığını
// söyler (bkz. falPhotos kimlik kapısı, profil istisnasıyla aynı usul).
const EYEWEAR_PROMPT =
  "Is the person in this photo wearing glasses or sunglasses ON THEIR EYES right now " +
  "(not pushed up on the head, not held in the hand)?\n" +
  "Reply on one line: EYEWEAR: <YES | NO>";

/** SAF. Döner { ok, eyewear } | { ok:false, reason }. */
function parseEyewearReply(raw) {
  const m = /EYEWEAR\s*:\s*(YES|NO)/i.exec(raw || "");
  return m ? { ok: true, eyewear: m[1].toUpperCase() === "YES" } : { ok: false, reason: "unparsable" };
}

/**
 * Şablon kişisinin gözlüğü var mı? Yüz kutusu çevresi kırpılıp sorulur.
 * FAIL-SAFE: okunamazsa { ok:false } — çağıran gözlük YOK sayar (eski davranış).
 */
async function judgeEyewear(templateBuf, faceBox, apiKey) {
  try {
    if (!Buffer.isBuffer(templateBuf) || !faceBox || !apiKey) return { ok: false, reason: "insufficient-input" };
    const meta = await sharp(templateBuf).metadata();
    const pad = 0.4;
    const left = Math.max(0, Math.round(faceBox.x - pad * faceBox.width));
    const top = Math.max(0, Math.round(faceBox.y - pad * faceBox.height));
    const width = Math.min(meta.width - left, Math.round(faceBox.width * (1 + 2 * pad)));
    const height = Math.min(meta.height - top, Math.round(faceBox.height * (1 + 2 * pad)));
    if (width < 16 || height < 16) return { ok: false, reason: "face-too-small" };
    const crop = await sharp(templateBuf).extract({ left, top, width, height })
      .resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: HEAD_GHOST_MODEL,
        temperature: 0,
        max_tokens: 10,
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: [{ type: "text", text: EYEWEAR_PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${crop.toString("base64")}`, detail: "low" } }] },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    const json = await resp.json();
    return parseEyewearReply((json?.choices?.[0]?.message?.content || "").trim());
  } catch (e) {
    console.error("Gözlük yargısı hata verdi (gözlük yok sayılıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

module.exports = { judgeHeadGhost, parseHeadGhostReply, headCropRect, judgeEyewear, parseEyewearReply, PROMPT };
