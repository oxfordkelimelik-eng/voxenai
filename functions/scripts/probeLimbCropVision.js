/**
 * UZUV KIRPMASINI VISION'A SORMA probu.
 *
 * NEDEN: hayalet/yarı saydam el bir BULANIKLIK kusuru değil, SAYDAMLIK kusuru.
 * Laplacian bunu göremiyor — chunk 1'in hayalet eli yüz cildinden 2.53 kat
 * "keskin" ölçülüyor, çünkü elin içinden görünen zemin yüksek frekans ekliyor.
 * Sayısal netlik yolu bu kusur için kapalı.
 *
 * Geriye Vision kalıyor, ama tam karede sorulduğunda her seferinde
 * "BODY_INTEGRITY: SOLID" damgası vuruyor — el karenin küçük bir parçası.
 * Bu prob aynı soruyu, artık doğru bulabildiğimiz UZUV KIRPMASINDA sorar.
 *
 * Kullanım: node scripts/probeLimbCropVision.js
 * Ortam: OPENAI_API_KEY
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { cellsToCropBoxes, cropBoxToFrame } = require("../limbBox");

const DIR = path.join(process.env.TEMP, "job-2286-frames");
const OUT = path.join(process.env.TEMP, "limb-crop-probe");
// Konumlar kırpma+ızgara koşusundan sabit (Vision konum çağrısını tekrarlamamak için).
const CASES = [
  ["chunk0  hayalet el   (SIKAYETLI)", "OK_chunk0.jpg", [25, 31, 32], { x: 0.20, y: 0.16, w: 0.51, h: 0.84 }],
  ["chunk1  silik el     (SIKAYETLI)", "OK_elegance_1_0.jpg", [25, 32], { x: 0.34, y: 0.25, w: 0.42, h: 0.75 }],
  ["chunk4  kol tonu     (SIKAYETLI)", "OK_elegance_4_0.jpg", [38, 44, 48], { x: 0.28, y: 0.32, w: 0.55, h: 0.68 }],
  ["chunk3  teslim       (temiz)", "OK_chunk3.jpg", [41, 42, 47], { x: 0, y: 0, w: 1, h: 1 }],
  ["chunk7  yat          (temiz)", "OK_chunk7.jpg", [21, 27, 28, 40], { x: 0.25, y: 0.29, w: 0.69, h: 0.71 }],
  ["chunk8  kask         (temiz)", "OK_chunk8.jpg", [29, 30, 34], { x: 0.21, y: 0.21, w: 0.47, h: 0.63 }],
];

const PROMPT =
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

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY yok");
  fs.mkdirSync(OUT, { recursive: true });

  for (const [label, file, cells, crop] of CASES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);
    const meta = await sharp(buf).metadata();

    // Tüm uzuv bölgelerini kapsayan tek kutu + pay; sonra 768'e büyütülür.
    const boxes = cellsToCropBoxes(cells).map((b) => cropBoxToFrame(b, crop));
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 0.02);
    const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 0.02);
    const x1 = Math.min(1, Math.max(...boxes.map((b) => b.x + b.w)) + 0.02);
    const y1 = Math.min(1, Math.max(...boxes.map((b) => b.y + b.h)) + 0.02);

    const left = Math.round(x0 * meta.width), top = Math.round(y0 * meta.height);
    const width = Math.max(16, Math.round((x1 - x0) * meta.width));
    const height = Math.max(16, Math.round((y1 - y0) * meta.height));
    const scale = 768 / Math.max(width, height);
    const cropBuf = await sharp(buf)
      .extract({ left, top, width: Math.min(width, meta.width - left), height: Math.min(height, meta.height - top) })
      .resize(Math.round(width * scale), Math.round(height * scale), { fit: "fill" })
      .jpeg({ quality: 92 })
      .toBuffer();
    const cropFile = path.join(OUT, file.replace(/\.jpg$/, "_crop.jpg"));
    fs.writeFileSync(cropFile, cropBuf);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 80,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${cropBuf.toString("base64")}`, detail: "high" } },
          ],
        }],
      }),
    });
    const j = await r.json();
    const raw = (j?.choices?.[0]?.message?.content || "").trim();
    console.log(`\n${label}`);
    for (const line of raw.split("\n")) console.log("   " + line.trim());
    console.log(`   kirpma: ${cropFile}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
