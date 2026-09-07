/**
 * UZUV KONUMU — önkol/el bölgesini kare içinde bulur.
 *
 * NEDEN VAR (2026-09-06, üç yol ölçülerek seçildi): kullanıcı iki kusur
 * bildirdi — elin silik/hayalet çıkması ve kol tonunun yüze uymaması. İkisi de
 * mevcut katmanlardan kaçtı, sebebi aynı: ÖLÇÜMÜ DOĞRU YERDEN ALAMIYORUZ.
 *
 *   - measureLimbSharpness "en büyük ten bileşenini" uzuv sayıyor. Şikâyet
 *     edilen iki karede oran 0.85 ve 0.68 çıktı — 101 karelik gerçek dağılımın
 *     p75'inin ÜSTÜ. Ölçtüğü şey silik el değil, keskin boyun/göğüstü.
 *   - Ten-benzeri piksel kuralı (YCbCr) krem duvarı ve bej pantolonu da ten
 *     sayıyor: chunk 0'da tek bileşen karenin %80.8'ini kaplıyor. Bu maskeyle
 *     düzeltme yapmak arka planı boyamak olurdu.
 *
 * DENENEN VE ELENEN İKİ YOL:
 *   1) Vision'dan doğrudan yüzde koordinat istemek — altı karenin ALTISINDA da
 *      kutu yanlış yere düştü (kolun/ceketin üstü; chunk 7'de omuz-çene).
 *      chunk 1'de kutunun içinde sıfır ten pikseli vardı ve düz kumaş yüzünden
 *      netlik oranı 0.024 ölçüldü — kapı kursaydık yanlış sebeple elerdik.
 *   2) Google nesne konumlandırıcı (@google-cloud/vision) — "Human hand" ya da
 *      "Human arm" sınıfı DÖNMÜYOR; yalnızca Person / Top / Coat / Pants.
 *      Kıyafet kutuları dikdörtgen olduğu için elleri de içine alıyor.
 *
 * SEÇİLEN YOL: kareyi önce Google'ın DOĞRU verdiği Person kutusuna kırpmak,
 * sonra bu kırpmaya numaralı ızgara çizip "hangi hücrede çıplak el/önkol var"
 * diye sormak. Model koordinat ÜRETMİYOR, gördüğü etiketi OKUYOR; ölçümde bu
 * ikisi aynı zorlukta değil. Kırpma çözünürlük kazandırır: kişi karenin
 * yarısını kaplarken ızgara gövde üzerinde iki kat sıklaşır.
 */

const sharp = require("sharp");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const LIMB_CELL_MODEL = "gpt-4o";

const GRID_COLS = 6;
const GRID_ROWS = 8;
// Kırpmayı bu boya büyütüyoruz: detail:"high" görüntüyü 512'lik karolara
// bölüyor, küçük kırpmayı büyütmek ele düşen karo sayısını artırır.
const CROP_TARGET_LONG_EDGE = 1024;
// Person kutusuna pay: el bazen gövde kutusunun hemen dışında kalıyor.
const PERSON_BOX_PAD = 0.04;
// Seçilen hücre sayısı bunu aşarsa model "gövdeyi" işaretlemiştir, konum
// bilgisi taşımaz (chunk 0'da doğrudan-koordinat yolunda görülen hata).
const MAX_SELECTED_CELLS = 12;

const LIMB_CELL_SYSTEM_MSG =
  "You are an automated quality-assurance component inside an image-" +
  "generation pipeline. You report grid cell numbers only — you never " +
  "identify, name, or speculate about who anyone is.";

const LIMB_CELL_PROMPT =
  "You are an automated component inside an image-editing pipeline. Report " +
  "grid cells only.\n\n" +
  `The image is overlaid with a ${GRID_COLS} by ${GRID_ROWS} grid. Every cell ` +
  "has its number printed in its top-left corner, counting left to right then " +
  `top to bottom, from 1 to ${GRID_COLS * GRID_ROWS}.\n\n` +
  "List the cells that contain the person's BARE SKIN of the hands, fingers, " +
  "wrists or forearms. Do not list cells that only contain the face, the neck, " +
  "hair, clothing, a sleeve, or background.\n" +
  "Read the printed numbers off the image; do not estimate positions.\n\n" +
  "Reply on exactly one line and write nothing else:\n" +
  "CELLS: 12,13,19\n" +
  "If no bare hand or forearm skin is visible anywhere, reply exactly:\n" +
  "CELLS: NONE";

/** Vision cevabındaki hücre numaralarını çıkarır. SAF fonksiyon — testten çağrılır. */
function parseCellReply(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  const line = raw.split("\n").map((l) => l.trim()).find((l) => /^CELLS\s*:/i.test(l));
  if (!line) return { ok: false, reason: "unparsable" };
  const body = line.replace(/^CELLS\s*:/i, "").trim();
  if (/^NONE$/i.test(body)) return { ok: true, cells: [] };
  const cells = [...new Set((body.match(/\d+/g) || []).map(Number))]
    .filter((n) => n >= 1 && n <= GRID_COLS * GRID_ROWS)
    .sort((a, b) => a - b);
  if (!cells.length) return { ok: false, reason: "no-valid-cell" };
  if (cells.length > MAX_SELECTED_CELLS) return { ok: false, reason: "too-many-cells" };
  return { ok: true, cells };
}

/**
 * Bitişik hücreleri (4-komşuluk) gruplayıp her grup için sınırlayıcı kutu üretir.
 * Kutular KIRPMA içinde 0-1 normalize döner. SAF fonksiyon.
 *
 * Tek tek hücre yerine grup: Laplacian varyansı çok küçük bölgede gürültüye
 * boğulur, bitişik hücreleri birleştirmek ölçülebilir bir alan bırakır.
 */
function cellsToCropBoxes(cells) {
  const set = new Set(cells);
  const seen = new Set();
  const boxes = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    let minC = GRID_COLS, maxC = -1, minR = GRID_ROWS, maxR = -1;
    while (stack.length) {
      const n = stack.pop();
      const i = n - 1;
      const c = i % GRID_COLS, r = Math.floor(i / GRID_COLS);
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      const neighbours = [];
      if (c > 0) neighbours.push(n - 1);
      if (c < GRID_COLS - 1) neighbours.push(n + 1);
      if (r > 0) neighbours.push(n - GRID_COLS);
      if (r < GRID_ROWS - 1) neighbours.push(n + GRID_COLS);
      for (const m of neighbours) {
        if (set.has(m) && !seen.has(m)) { seen.add(m); stack.push(m); }
      }
    }
    boxes.push({
      x: minC / GRID_COLS,
      y: minR / GRID_ROWS,
      w: (maxC - minC + 1) / GRID_COLS,
      h: (maxR - minR + 1) / GRID_ROWS,
    });
  }
  return boxes;
}

/** Kırpma içindeki kutuyu TAM KARE koordinatına çevirir. SAF fonksiyon. */
function cropBoxToFrame(box, crop) {
  return {
    x: crop.x + box.x * crop.w,
    y: crop.y + box.y * crop.h,
    w: box.w * crop.w,
    h: box.h * crop.h,
  };
}

/** Google nesne konumlandırıcısından en güvenilir Person kutusu. */
async function personBoxViaGoogle(buf, annotate) {
  try {
    const objs = await annotate(buf);
    const people = (objs || [])
      .filter((o) => /^person$/i.test(o.name || ""))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!people.length) return null;
    const v = people[0].vertices;
    if (!Array.isArray(v) || v.length < 2) return null;
    const xs = v.map((p) => p.x || 0), ys = v.map((p) => p.y || 0);
    const x0 = Math.max(0, Math.min(...xs) - PERSON_BOX_PAD);
    const y0 = Math.max(0, Math.min(...ys) - PERSON_BOX_PAD);
    const x1 = Math.min(1, Math.max(...xs) + PERSON_BOX_PAD);
    const y1 = Math.min(1, Math.max(...ys) + PERSON_BOX_PAD);
    if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  } catch (e) {
    console.error("Person kutusu alınamadı (tam kareye düşülüyor):", e.message || e);
    return null;
  }
}

/** Kırpar, büyütür ve numaralı ızgarayı çizer. */
async function buildGridImage(buf, crop) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;
  const left = Math.max(0, Math.round(crop.x * meta.width));
  const top = Math.max(0, Math.round(crop.y * meta.height));
  const width = Math.min(meta.width - left, Math.max(16, Math.round(crop.w * meta.width)));
  const height = Math.min(meta.height - top, Math.max(16, Math.round(crop.h * meta.height)));

  const scale = CROP_TARGET_LONG_EDGE / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const base = await sharp(buf)
    .extract({ left, top, width, height })
    .resize(outW, outH, { fit: "fill" })
    .toBuffer();

  const cw = outW / GRID_COLS, chh = outH / GRID_ROWS;
  const fontSize = Math.max(16, Math.round(outW / 30));
  let svg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">`;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const n = r * GRID_COLS + c + 1;
      const x = c * cw, y = r * chh;
      svg += `<rect x="${x}" y="${y}" width="${cw}" height="${chh}" fill="none" ` +
             `stroke="#ffee00" stroke-width="2"/>`;
      svg += `<text x="${x + 6}" y="${y + fontSize + 4}" font-size="${fontSize}" ` +
             `font-family="sans-serif" font-weight="bold" fill="#ffee00" ` +
             `stroke="#000000" stroke-width="1">${n}</text>`;
    }
  }
  svg += "</svg>";
  return sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function askCells(markedBuf, apiKey) {
  const resp = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: LIMB_CELL_MODEL,
      temperature: 0,
      // Tek satır hücre listesi; 60 fazlasıyla yetiyor.
      max_tokens: 60,
      messages: [
        { role: "system", content: LIMB_CELL_SYSTEM_MSG },
        {
          role: "user",
          content: [
            { type: "text", text: LIMB_CELL_PROMPT },
            {
              type: "image_url",
              // detail "high": ızgara numaraları "low" (512px) altında okunmuyor.
              image_url: { url: `data:image/jpeg;base64,${markedBuf.toString("base64")}`, detail: "high" },
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
      `MALIYET UZUV KONUMU: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} ` +
      `toplam=${u.total_tokens ?? "?"} model=${LIMB_CELL_MODEL}`
    );
  }
  const raw = (json?.choices?.[0]?.message?.content || "").trim();
  return { ...parseCellReply(raw), raw };
}

/**
 * Uzuv bölgelerini bulur.
 *
 * buf      : üretilen kare
 * apiKey   : OpenAI anahtarı (üretimde OPENAI_KEY.value(); bu modül bilerek
 *            firebase-functions'a bağlanmıyor ki testten/scriptten çalışsın)
 * annotate : (buf) => [{name, score, vertices}] — Google nesne konumlandırıcı.
 *            Verilmezse kırpma yapılmaz, ızgara tam kareye çizilir.
 *
 * Döner: { ok:true, boxes:[{x,y,w,h}], crop, cells } | { ok:false, reason }.
 * boxes TAM KARE koordinatında 0-1 normalize. Boş dizi geçerli bir cevaptır:
 * "görünür çıplak uzuv yok" (uzun kol, cepteki el, kadraj dışı).
 */
async function locateLimbRegions(buf, apiKey, annotate) {
  try {
    if (!Buffer.isBuffer(buf) || !apiKey) return { ok: false, reason: "insufficient-input" };
    const crop = (typeof annotate === "function" ? await personBoxViaGoogle(buf, annotate) : null)
      || { x: 0, y: 0, w: 1, h: 1 };
    const marked = await buildGridImage(buf, crop);
    if (!marked) return { ok: false, reason: "crop-failed" };
    const cells = await askCells(marked, apiKey);
    if (!cells.ok) return { ok: false, reason: cells.reason, raw: cells.raw };
    if (!cells.cells.length) return { ok: true, boxes: [], crop, cells: [], raw: cells.raw };
    const boxes = cellsToCropBoxes(cells.cells).map((b) => cropBoxToFrame(b, crop));
    return { ok: true, boxes, crop, cells: cells.cells, raw: cells.raw };
  } catch (e) {
    console.error("Uzuv konumu bulunamadı (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

// UZUV KIRPMASI YARGISI — hayalet/saydam el kapısı.
//
// NEDEN VISION, NEDEN SAYISAL DEĞİL: hayalet el bir BULANIKLIK kusuru değil,
// SAYDAMLIK kusuru. Laplacian onu göremiyor — şikâyet edilen chunk 1'in
// hayalet eli, yüz cildinden 2.53 KAT daha "keskin" ölçüldü, çünkü elin
// içinden görünen zemin yüksek frekans ekliyor. Netlik eşiği bu kusuru
// tanımı gereği yakalayamaz.
//
// NEDEN KIRPMA: aynı soru TAM KAREDE zaten soruluyor (base prompt'unda
// K) BODY_INTEGRITY) ve orada her kareye "SOLID" damgası vuruluyor — el
// karenin küçük bir parçası. Yakınlaştırılmış kırpmada aynı model altı
// karenin ALTISINDA da doğru cevap verdi: şikâyet edilen iki hayalet el
// BAD_LIMB, ten şikâyetli chunk 4 dâhil diğer dördü GOOD.
const LIMB_CROP_LONG_EDGE = 768;
const LIMB_CROP_PAD = 0.02;

const LIMB_CROP_PROMPT =
  "You are an automated quality checker inside an image-generation pipeline. " +
  "This is a ZOOMED CROP of one region of a generated photograph, showing a " +
  "person's arm and hand.\n\n" +
  "Judge the rendering of the arm, hand and fingers in this crop:\n" +
  "P) OPACITY — is the limb fully solid? It FAILS if the background (ground, " +
  "wall, furniture, railing) is visible THROUGH the arm or hand, if the limb " +
  "looks semi-transparent or washed into the background, or if it appears as a " +
  "faint double image.\n" +
  "Q) STRUCTURE — is the hand anatomically coherent? It FAILS if fingers are " +
  "melted, fused, missing, duplicated, the wrong count, or dissolve into a " +
  "smudge.\n" +
  "R) DEFINITION — does the limb have the same rendering detail as a normal " +
  "photograph? It FAILS if the limb is markedly softer, smeared or less " +
  "defined than the rest of the crop. Ordinary depth-of-field is fine.\n\n" +
  "Reply on exactly four lines:\n" +
  "OPACITY: <SOLID | SEE_THROUGH>\n" +
  "STRUCTURE: <NORMAL | MALFORMED>\n" +
  "DEFINITION: <NORMAL | SMEARED>\n" +
  "<verdict>: <SHORT reason, max 10 words>\n\n" +
  "Any SEE_THROUGH, MALFORMED or SMEARED forces BAD_LIMB. Verdict is one of:\n" +
  "GOOD: <why it passes>\n" +
  "BAD_LIMB: <what is wrong>";

/** Kırpma cevabını ayrıştırır. SAF fonksiyon — testten çağrılır. */
function parseLimbCropReply(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  const up = raw.toUpperCase();
  const pick = (key, bad) => (new RegExp(`${key}\\s*:\\s*${bad}`).test(up) ? bad : null);
  const opacity = pick("OPACITY", "SEE_THROUGH");
  const structure = pick("STRUCTURE", "MALFORMED");
  const definition = pick("DEFINITION", "SMEARED");
  const hasBad = /BAD_LIMB/.test(up);
  const hasGood = /\bGOOD\s*:/.test(up);
  // Kararı SATIRLAR belirliyor, serbest metin değil: dosyadaki diğer Vision
  // kapılarında da sınıf satırı bağlayıcı, gerekçe yalnızca teşhis içindir.
  const bad = Boolean(opacity || structure || definition || hasBad);
  if (!bad && !hasGood) return { ok: false, reason: "unparsable" };
  const flags = [opacity, structure, definition].filter(Boolean);
  const detail = (raw.split("\n").map((l) => l.trim()).find((l) => /^(GOOD|BAD_LIMB)\s*:/i.test(l)) || "")
    .replace(/^(GOOD|BAD_LIMB)\s*:\s*/i, "")
    .slice(0, 120);
  return { ok: true, bad, flags, detail };
}

/**
 * Uzuv bölgelerini tek kutuda toplayıp yakınlaştırılmış kırpmayı Vision'a sorar.
 * Döner: { ok:true, bad, flags, detail } | { ok:false, reason }.
 */
async function judgeLimbCrop(buf, boxes, apiKey) {
  try {
    if (!Buffer.isBuffer(buf) || !Array.isArray(boxes) || !boxes.length || !apiKey) {
      return { ok: false, reason: "insufficient-input" };
    }
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "insufficient-input" };
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - LIMB_CROP_PAD);
    const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - LIMB_CROP_PAD);
    const x1 = Math.min(1, Math.max(...boxes.map((b) => b.x + b.w)) + LIMB_CROP_PAD);
    const y1 = Math.min(1, Math.max(...boxes.map((b) => b.y + b.h)) + LIMB_CROP_PAD);

    const left = Math.round(x0 * meta.width), top = Math.round(y0 * meta.height);
    const width = Math.min(meta.width - left, Math.max(16, Math.round((x1 - x0) * meta.width)));
    const height = Math.min(meta.height - top, Math.max(16, Math.round((y1 - y0) * meta.height)));
    const scale = LIMB_CROP_LONG_EDGE / Math.max(width, height);
    const cropBuf = await sharp(buf)
      .extract({ left, top, width, height })
      .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { fit: "fill" })
      .jpeg({ quality: 92 })
      .toBuffer();

    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: LIMB_CELL_MODEL,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: LIMB_CELL_SYSTEM_MSG },
          {
            role: "user",
            content: [
              { type: "text", text: LIMB_CROP_PROMPT },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${cropBuf.toString("base64")}`, detail: "high" } },
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
        `MALIYET UZUV KIRPMA: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} ` +
        `toplam=${u.total_tokens ?? "?"} model=${LIMB_CELL_MODEL}`
      );
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    return { ...parseLimbCropReply(raw), raw };
  } catch (e) {
    console.error("Uzuv kırpma yargısı hata verdi (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

/**
 * Üretimde kullanılan Google nesne konumlandırıcı sarmalayıcısı.
 * İstemci tembel kuruluyor (contentModeration.js ile aynı usul) ve kimlik
 * doğrulaması Cloud Functions'ın kendi ADC'sinden geliyor.
 */
let _visionClient = null;
function googleObjectAnnotator() {
  return async (buf) => {
    if (!_visionClient) {
      const vision = require("@google-cloud/vision");
      _visionClient = new vision.ImageAnnotatorClient();
    }
    const [res] = await _visionClient.objectLocalization({ image: { content: buf } });
    return (res.localizedObjectAnnotations || []).map((a) => ({
      name: a.name,
      score: a.score,
      vertices: (a.boundingPoly?.normalizedVertices || []).map((v) => ({ x: v.x || 0, y: v.y || 0 })),
    }));
  };
}

module.exports = {
  locateLimbRegions,
  judgeLimbCrop,
  parseLimbCropReply,
  googleObjectAnnotator,
  parseCellReply,
  cellsToCropBoxes,
  cropBoxToFrame,
  personBoxViaGoogle,
  buildGridImage,
  GRID_COLS,
  GRID_ROWS,
  MAX_SELECTED_CELLS,
};
