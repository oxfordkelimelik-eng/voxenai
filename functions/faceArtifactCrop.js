/**
 * YÜZ ARTEFAKT KAPISI — yakınlaştırılmış yüz kırpmasına sorar.
 *
 * SORUN (kullanıcı bildirimi, TESLİM EDİLMİŞ kareler): yüzde "boya/leke"
 * kalıyor — düz gri-beyaz yamalar, keskin kenarlı bloklar, ince dikey
 * çizgiler. Kullanıcı: "yüz içerisinde bu tarz lekeler kabul edilemez".
 * Doğrulanmış vakalar: 78e53593_3 (kaş üstü blok), 78e53593_8 (şakağa inen
 * çizgi), 944d30fe_8 (kaşta beyaz yama), 0c609c0e_7 (gözlük çerçevesi
 * artefaktı). Lekeler yalnızca alında değil — burun, çene, yanak, şakak.
 *
 * ================== NEDEN AYRI VE KIRPILMIŞ ÇAĞRI ==================
 *
 * 1) TAM KAREDE SORMAK YETMEDİ. assessOutputWithVision'a 2026-09-13'te
 *    FACE_ARTIFACT satırı eklendi ve bir kareyi yakaladı ("Grey patch on
 *    forehead") ama AYNI GÜN 944d30fe_8'i kaçırdı — o karede kaşın üstünde
 *    gözle bariz bir beyaz yama vardı ve kare teslim edildi. Sebep ölçek:
 *    1170x1462'lik bir karede leke 5x5 piksel; model o ayrıntıyı görmüyor.
 *
 * 2) SAYISAL ÖLÇÜM KALİBRE EDİLEMEDİ. faceArtifact.js aynı kusuru ölçüyor
 *    ama 41 gerçek kare üzerinde sınıflar AYRILMADI — gözle doğrulanmış
 *    lekeli bir kare %0.193, temiz bir kare %0.365 ölçüldü (iç içe geçmiş).
 *    Doluluk (fill) da ayırmadı: lekeli 0.27/0.27/0.60/0.61, temiz
 *    0.40/0.49/0.52/0.79. Hiçbir eşik hem lekeyi yakalayıp hem temizi
 *    geçirmiyor. O ölçüm ELEMİYOR, yalnızca loglamaya devam ediyor.
 *
 * 3) KIRPMA YÖNTEMİ BU DOSYADA KANITLANDI. limbBox.js'in başlığındaki aynı
 *    gözlem: tam karede model her kareye "SOLID" damgası vuruyordu,
 *    yakınlaştırılmış kırpmada altı karenin altısında doğru cevap verdi.
 *    Yüz kutusunu kırpıp 768px'e büyütmek lekeyi 5x5'ten ~25x25'e çıkarır.
 *
 * BÖLGE BÖLGE SORULUYOR: tek bir genel "yüzde leke var mı" sorusunda model
 * ilk gördüğüne takılıp kalanı taramıyor. Alın, kaşlar, burun, yanaklar,
 * çene ve şakaklar ayrı ayrı adlandırılıyor ki her biri gerçekten kontrol
 * edilsin — bu, dosyada 2026-08-04 ve 2026-09-06'da iki kez belgelenen
 * "tek adımlı yargı sorusuna model rutin olarak temiz der" örüntüsüne karşı
 * alınan aynı önlem.
 */

const sharp = require("sharp");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const FACE_CROP_MODEL = "gpt-4o";

// Yüz kutusunun etrafına bırakılan pay: leke bazen saç çizgisinde ya da
// çenenin hemen altında ve dedektör kutusu yüzü sıkı sarıyor.
const FACE_CROP_PAD = 0.25;
// Kırpma bu boya büyütülüyor — detail:"high" görüntüyü 512'lik karolara
// böler; küçük kırpmayı büyütmek lekeye düşen karo sayısını artırır.
const FACE_CROP_LONG_EDGE = 768;
// Bu genişliğin altındaki yüz kutusunda kırpma anlamlı ayrıntı taşımaz
// (büyütme olmayan ayrıntıyı yaratamaz) — kapı sessizce atlanır.
const FACE_MIN_BOX_PX = 40;

const FACE_CROP_SYSTEM_MSG =
  "You are an automated quality-assurance component inside an image-" +
  "generation pipeline. You report rendering defects only — you never " +
  "identify, name, or speculate about who anyone is.";

const FACE_CROP_PROMPT =
  "You are an automated quality checker inside an image-generation pipeline. " +
  "This is a ZOOMED CROP of a generated photograph, showing a person's face.\n\n" +
  "Look for RENDERING ARTIFACTS on the facial skin — marks left behind by the " +
  "image generator that do not belong to a real photograph.\n\n" +
  "An ARTIFACT looks like: a flat patch of grey, white or washed-out colour " +
  "sitting on the skin; a rectangular or straight-edged block; a thin straight " +
  "line or streak crossing the skin; a small area that looks pasted on, " +
  "painted over, smeared, or pixelated differently from its surroundings.\n\n" +
  "THE GIVEAWAY IS THE EDGE: real light, shadow and skin tone fade smoothly " +
  "into the surrounding skin. An artifact has a hard, straight or geometric " +
  "border and loses the skin's natural colour and texture.\n\n" +
  "Check EACH of these areas separately and do not stop at the first one you " +
  "clear — artifacts appear anywhere on the face:\n" +
  "  1. forehead and hairline\n" +
  "  2. eyebrows and the skin just above them\n" +
  "  3. eyes, eyelids and under-eye area\n" +
  "  4. nose (bridge, tip and sides)\n" +
  "  5. cheeks and temples\n" +
  "  6. mouth, chin and jawline\n\n" +
  "NORMAL and PASSES — never report these: ordinary highlights and shine, " +
  "skin pores and texture, stubble and beard edges, moles, freckles, scars, " +
  "soft shadows, blush, and the natural blur of a shallow depth of field. " +
  "Eyeglass frames, their reflections and the shadow they cast are part of " +
  "the scene and PASS.\n\n" +
  "Reply on exactly three lines:\n" +
  "ARTIFACT: <NONE | PATCH>\n" +
  "WHERE: <which of the six areas, or NONE>\n" +
  "<verdict>: <SHORT reason, max 12 words>\n\n" +
  "PATCH forces BAD_ARTIFACT. Verdict is one of:\n" +
  "GOOD: <why the skin looks cleanly rendered>\n" +
  "BAD_ARTIFACT: <what and where, e.g. grey block above the left eyebrow>";

/**
 * Kırpma cevabını ayrıştırır. SAF fonksiyon — testten çağrılır.
 *
 * Döner: { ok:true, bad, where, detail } | { ok:false, reason }
 * Ayrıştırılamayan cevapta fail-safe: ok:false -> çağıran taraf ELEMEZ.
 */
function parseFaceArtifactReply(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  const up = raw.toUpperCase();

  const artifactLine = /ARTIFACT\s*:\s*(NONE|PATCH)/.exec(up);
  const hasBadVerdict = /BAD_ARTIFACT/.test(up);
  const hasGoodVerdict = /\bGOOD\s*:/.test(up);

  // Sınıf satırı bağlayıcı, serbest metin değil — dosyadaki diğer Vision
  // kapılarıyla aynı usul. Satır okunamadıysa verdict'e düşülür.
  let bad;
  if (artifactLine) bad = artifactLine[1] === "PATCH";
  else if (hasBadVerdict) bad = true;
  else if (hasGoodVerdict) bad = false;
  else return { ok: false, reason: "unparsable" };

  const whereLine = raw.split("\n").map((l) => l.trim())
    .find((l) => /^WHERE\s*:/i.test(l)) || "";
  const where = whereLine.replace(/^WHERE\s*:\s*/i, "").slice(0, 60);

  const detail = (raw.split("\n").map((l) => l.trim())
    .find((l) => /^(GOOD|BAD_ARTIFACT)\s*:/i.test(l)) || "")
    .replace(/^(GOOD|BAD_ARTIFACT)\s*:\s*/i, "")
    .slice(0, 120);

  return { ok: true, bad, where, detail };
}

/**
 * Yüz kutusunu kırpıp büyütür ve Vision'a artefakt sorar.
 *
 * @param {Buffer} buf çıktı karesi
 * @param {{x:number,y:number,width:number,height:number}} faceBox detectMainFace'ten
 * @param {string} apiKey OpenAI anahtarı
 */
async function judgeFaceArtifact(buf, faceBox, apiKey) {
  try {
    if (!Buffer.isBuffer(buf) || !faceBox || !apiKey) {
      return { ok: false, reason: "insufficient-input" };
    }
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "insufficient-input" };
    if (faceBox.width < FACE_MIN_BOX_PX || faceBox.height < FACE_MIN_BOX_PX) {
      return { ok: false, reason: "face-too-small" };
    }

    // Yüz kutusuna pay ekleyip kare sınırlarına kırp.
    const padX = faceBox.width * FACE_CROP_PAD;
    const padY = faceBox.height * FACE_CROP_PAD;
    const left = Math.max(0, Math.round(faceBox.x - padX));
    const top = Math.max(0, Math.round(faceBox.y - padY));
    const right = Math.min(meta.width, Math.round(faceBox.x + faceBox.width + padX));
    const bottom = Math.min(meta.height, Math.round(faceBox.y + faceBox.height + padY));
    const width = Math.max(16, right - left);
    const height = Math.max(16, bottom - top);

    const scale = FACE_CROP_LONG_EDGE / Math.max(width, height);
    const cropBuf = await sharp(buf)
      .extract({ left, top, width, height })
      // Büyütmede kernel ÖNEMLİ: varsayılan yumuşatma lekenin ayırt edici
      // özelliğini — keskin kenarını — silebilir. nearest, kenarı olduğu
      // gibi korur ve blok artefaktı görünür kılar.
      .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)),
        { fit: "fill", kernel: "nearest" })
      .jpeg({ quality: 95 })
      .toBuffer();

    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: FACE_CROP_MODEL,
        temperature: 0,
        max_tokens: 90,
        messages: [
          { role: "system", content: FACE_CROP_SYSTEM_MSG },
          {
            role: "user",
            content: [
              { type: "text", text: FACE_CROP_PROMPT },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${cropBuf.toString("base64")}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    const json = await resp.json();
    if (json.usage) {
      const u = json.usage;
      console.log(
        `MALIYET YÜZ ARTEFAKT: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} ` +
        `toplam=${u.total_tokens ?? "?"} model=${FACE_CROP_MODEL}`
      );
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    return { ...parseFaceArtifactReply(raw), raw };
  } catch (e) {
    console.error("Yüz artefakt yargısı hata verdi (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

module.exports = {
  judgeFaceArtifact,
  parseFaceArtifactReply,
  FACE_CROP_PROMPT,
  FACE_CROP_PAD,
  FACE_CROP_LONG_EDGE,
  FACE_MIN_BOX_PX,
};
