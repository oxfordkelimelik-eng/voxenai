/**
 * YÜZ YAMASINI REDDETMEK YERİNE ONAR (2026-09-17).
 *
 * NEDEN YENİ BİR YÖNTEM GEREKTİ — üç teori ölçümle çürütüldü:
 *
 *  1) "Model selfie'deki flaşı sökerken boyuyor" (2026-09-16). Parlama
 *     kaynakta alındı; iş 1a1a2a6d'de kullanıcının selfie'lerinde parlama
 *     ZATEN YOKTU (loglarda 0.030 / 0.014, eşiğin altı, normalizasyon hiç
 *     uygulanmadı) ve 10 artefakt reddi yine geldi. Selfie değil.
 *
 *  2) "Yama modelin düzenlemeyi bitirdiği KENARDAKİ dikiş" (2026-09-17
 *     sabahı). Prompt'a FACE EDGE bölümü eklendi, deploy edildi. Aynı işte
 *     yamalar yüzün HER YERİNDE çıktı — alın, burun, yanak, göz altı
 *     (gözle doğrulandı, RET_c8_att1 ve RET_c5_att1). Kenar değil.
 *
 *  3) "Sayısal olarak yakalanabilir" — iki ayrı ölçüm denendi ve İKİSİ DE
 *     sınıfları ayıramadı:
 *       düz+renksiz alan oranı : RET %1.57  vs  KABUL %0.95  (örtüşüyor)
 *       yüze düşen piksel      : RET 182px  vs  KABUL 162px  (RET daha BÜYÜK)
 *     Yani kusur ne düzlükle ne çözünürlükle ayrılıyor.
 *
 * SONUÇ: kusur modelin kendi üretim gürültüsü. Prompt'la önlenemedi (üç
 * ayrı yasak + dikiş talimatı), sayısal olarak da ayrılamadı. Dolayısıyla
 * ÖNLEMEK yerine ONARMAK gerekiyor.
 *
 * YÖNTEM: kapı zaten yamayı GÖRÜYOR ve yerini söylüyor (judgeFaceArtifact ->
 * where). Kareyi atıp baştan üretmek yerine (bir tam üretim maliyeti + yeni
 * kusur riski), yalnızca YÜZ BÖLGESİNİ maskeleyip OpenAI'ye yeniden
 * çizdiriyoruz. Geri kalan her şey — poz, kıyafet, arka plan, kadraj —
 * piksel piksel korunuyor, çünkü maske dışına dokunulmuyor.
 *
 * MALİYET: onarım tam üretimden ucuz (tek görsel, kısa prompt) ve bir ret
 * + yeniden üretim döngüsünden çok daha ucuz. Başarısız olursa kare yine
 * kapıya düşer, yani en kötü ihtimalle bugünkü davranışa döneriz.
 */

const sharp = require("sharp");

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_MODEL_ID = "gpt-image-2";

// Maske yüz kutusunun biraz DIŞINI da kapsar: yama şakak/saç çizgisi
// hattında da çıkabiliyor (ilk ölçümde X=0.05/0.95 idi) ve maske tam
// kutuya oturursa o bant onarım dışında kalır.
const MASK_PAD = 0.18;
// Onarım YÜKSEK kalitede yapılır. Asıl üretim maliyet gerekçesiyle "medium"
// (bkz. generateWithOpenAI) — ama onarım tek ve küçük bir bölge, buradaki
// fark kuruşlar, kazanç ise kusurun tekrarlamaması.
const REPAIR_QUALITY = "high";

const REPAIR_PROMPT =
  "Repaint ONLY the masked facial skin so it becomes clean, continuous, " +
  "photographic skin. Remove any flat grey, white, brown or washed-out " +
  "patch, any rectangular or straight-edged block, any pixelated or " +
  "smeared region sitting on the forehead, brows, temples, nose, cheeks, " +
  "chin or under the eyes. Replace them with natural skin that has real " +
  "pores and fine texture, matching the surrounding skin's exact colour, " +
  "tone and lighting so the repair is invisible. " +
  "Keep the person's identity, facial features, expression, eyes, eyebrows, " +
  "beard, moles and hairline EXACTLY as they are — this is a blemish " +
  "cleanup, not a redesign. Do not smooth, airbrush or beautify the face, " +
  "do not change its shape, and do not alter anything outside the mask.";

/**
 * Yüz kutusundan maske üretir: onarılacak bölge ŞEFFAF (alpha=0), korunacak
 * her yer OPAK. OpenAI images/edits sözleşmesi bu yönde — şeffaf pikseller
 * yeniden çizilir.
 *
 * Kenar SERT değil yumuşak: keskin maske kenarı onarımın kendisini görünür
 * bir dikişe çevirir (tam da kaçınmaya çalıştığımız kusur). Blur ile
 * geçiş yumuşatılıyor.
 */
async function buildFaceMask(width, height, faceBox) {
  const padW = faceBox.width * MASK_PAD;
  const padH = faceBox.height * MASK_PAD;
  const x0 = Math.max(0, Math.round(faceBox.x - padW));
  const y0 = Math.max(0, Math.round(faceBox.y - padH));
  const x1 = Math.min(width, Math.round(faceBox.x + faceBox.width + padW));
  const y1 = Math.min(height, Math.round(faceBox.y + faceBox.height + padH));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;

  // Elips: dikdörtgen maske köşelerde saç/arka plan kapar ve model oraları
  // da yeniden çizip yeni kusur üretebilir. Yüz zaten eliptik.
  const rx = w / 2;
  const ry = h / 2;
  const cx = x0 + rx;
  const cy = y0 + ry;

  const alpha = Buffer.alloc(width * height, 255); // her yer opak
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) alpha[y * width + x] = 0; // onarılacak
    }
  }

  // Yumuşak geçiş için alpha kanalını blurla.
  //
  // DİKKAT (2026-09-17, testte yakalandı): sharp tek kanallı ham girdiyi
  // blur'dan SONRA 3 kanal olarak döndürebiliyor (gerçek ölçüm: 1122x1402
  // için 4.719.132 bayt = W*H*3, beklenen W*H değil). Tek kanal varsayıp
  // indekslemek maskeyi TAMAMEN KAYDIRIYORDU — yüz y=296..517'deyken maske
  // y=775..1399'a düşmüştü, yani onarım yüzü değil göğsü yeniden çizecekti.
  // Bu yüzden kanal sayısı DÖNEN BİLGİDEN okunuyor, varsayılmıyor.
  const blurRadius = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  const { data: blurred, info: bInfo } = await sharp(alpha, {
    raw: { width, height, channels: 1 },
  }).blur(blurRadius).raw().toBuffer({ resolveWithObject: true });
  const bc = bInfo.channels;

  // RGBA PNG: renk kanalları önemsiz, alpha belirleyici.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = blurred[i * bc];
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Yamayı onarır. Döner:
 *   { ok:true, buf }            — onarılmış kare
 *   { ok:false, reason }        — onarım yapılamadı (çağıran ESKİ kareyle
 *                                 devam eder, yani davranış bugünküyle aynı)
 * ASLA throw etmez: onarım bir iyileştirme katmanı, üretimi bloklamamalı.
 */
async function repairFaceArtifact(buf, faceBox, apiKey) {
  try {
    if (!buf || !faceBox || !apiKey) return { ok: false, reason: "insufficient-input" };
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "no-metadata" };

    const mask = await buildFaceMask(meta.width, meta.height, faceBox);
    if (!mask) return { ok: false, reason: "mask-too-small" };

    // Girdi PNG olmalı (maskeyle aynı boyut ve format beklenir).
    const pngBuf = await sharp(buf).png().toBuffer();

    const form = new FormData();
    form.append("model", OPENAI_MODEL_ID);
    form.append("prompt", REPAIR_PROMPT);
    form.append("quality", REPAIR_QUALITY);
    form.append("output_format", "jpeg");
    form.append("image", new Blob([pngBuf], { type: "image/png" }), "frame.png");
    form.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");

    const r = await fetch(OPENAI_IMAGE_EDIT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error(`YÜZ ONARIMI: OpenAI ${r.status} — ${t.slice(0, 160)}`);
      return { ok: false, reason: `http-${r.status}` };
    }
    const j = await r.json();
    const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) return { ok: false, reason: "empty-response" };
    return { ok: true, buf: Buffer.from(b64, "base64") };
  } catch (e) {
    console.error("Yüz onarımı hata verdi (kare olduğu gibi bırakıldı):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

module.exports = {
  repairFaceArtifact,
  buildFaceMask,
  MASK_PAD,
  REPAIR_QUALITY,
};
