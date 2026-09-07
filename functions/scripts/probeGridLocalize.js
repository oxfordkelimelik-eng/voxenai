/**
 * IZGARA (set-of-mark) ile uzuv konumlandırma probu.
 *
 * NEDEN: GPT-4o'dan doğrudan yüzde koordinat istemek işe yaramadı — altı
 * karenin altısında da kutu elin değil kolun/ceketin üstüne düştü (chunk7'de
 * omuz/çene bölgesine). Google'ın nesne konumlandırıcısında ise "Human hand"
 * sınıfı yok; yalnızca Person / Top / Pants dönüyor.
 *
 * Bu prob üçüncü yolu ölçer: kareye NUMARALI ızgara çizip "hangi hücrelerde
 * çıplak el/önkol var" diye sormak. Model koordinat ÜRETMİYOR, gördüğü etiketi
 * OKUYOR — bu iki iş modeller için aynı zorlukta değil.
 *
 * Kullanım: node scripts/probeGridLocalize.js
 * Ortam: OPENAI_API_KEY
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const COLS = 6, ROWS = 8;
const DIR = path.join(process.env.TEMP, "job-2286-frames");
const OUT = path.join(process.env.TEMP, "grid-probe");
const FRAMES = [
  ["chunk0  wellness / hayalet el", "OK_chunk0.jpg"],
  ["chunk1  kahverengi takim / silik el", "OK_elegance_1_0.jpg"],
  ["chunk4  eller cepte / kol kirmizi", "OK_elegance_4_0.jpg"],
  ["chunk3  teslim (kiyas)", "OK_chunk3.jpg"],
  ["chunk7  yat (kiyas)", "OK_chunk7.jpg"],
  ["chunk8  kask (kiyas)", "OK_chunk8.jpg"],
];

const PROMPT =
  "You are an automated component inside an image-editing pipeline. Report " +
  "grid cells only.\n\n" +
  `The image is overlaid with a ${COLS} by ${ROWS} grid. Every cell has its ` +
  "number printed in its top-left corner, counting left to right then top to " +
  `bottom, from 1 to ${COLS * ROWS}.\n\n` +
  "List the cells that contain the person's BARE SKIN of the hands, fingers, " +
  "wrists or forearms. Do not list cells that only contain the face, the neck, " +
  "hair, clothing, a sleeve, or background.\n" +
  "Read the printed numbers off the image; do not estimate positions.\n\n" +
  "Reply on exactly one line and write nothing else:\n" +
  "CELLS: 12,13,19\n" +
  "If no bare hand or forearm skin is visible anywhere, reply exactly:\n" +
  "CELLS: NONE";

async function gridded(buf) {
  const meta = await sharp(buf).metadata();
  const cw = meta.width / COLS, ch = meta.height / ROWS;
  let svg = `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">`;
  const fs2 = Math.max(18, Math.round(meta.width / 34));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const n = r * COLS + c + 1;
      const x = c * cw, y = r * ch;
      svg += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="none" stroke="#ffee00" stroke-width="2"/>`;
      svg += `<text x="${x + 6}" y="${y + fs2 + 4}" font-size="${fs2}" font-family="sans-serif" ` +
             `font-weight="bold" fill="#ffee00" stroke="#000000" stroke-width="1">${n}</text>`;
    }
  }
  svg += "</svg>";
  return sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

function cellsToBoxes(cells) {
  return cells.map((n) => {
    const i = n - 1;
    const c = i % COLS, r = Math.floor(i / COLS);
    return { x: c / COLS, y: r / ROWS, w: 1 / COLS, h: 1 / ROWS };
  });
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY yok");
  fs.mkdirSync(OUT, { recursive: true });

  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);
    const marked = await gridded(buf);
    fs.writeFileSync(path.join(OUT, file.replace(/\.jpg$/, "_grid.jpg")), marked);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 60,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${marked.toString("base64")}`, detail: "high" } },
          ],
        }],
      }),
    });
    const j = await r.json();
    const raw = (j?.choices?.[0]?.message?.content || "").trim();
    const nums = /NONE/i.test(raw)
      ? []
      : (raw.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= COLS * ROWS);

    console.log(`\n${label}\n  cevap="${raw.replace(/\n/g, " ")}"  hucreler=[${nums.join(",")}]`);

    // Seçilen hücreleri kareye boyayıp gözle doğrula.
    const meta = await sharp(buf).metadata();
    const boxes = cellsToBoxes(nums);
    const rects = boxes.map((b) =>
      `<rect x="${Math.round(b.x * meta.width)}" y="${Math.round(b.y * meta.height)}" ` +
      `width="${Math.round(b.w * meta.width)}" height="${Math.round(b.h * meta.height)}" ` +
      `fill="#00ff5f" fill-opacity="0.28" stroke="#00ff5f" stroke-width="4"/>`
    ).join("");
    const outFile = path.join(OUT, file.replace(/\.jpg$/, "_sel.jpg"));
    await sharp(buf)
      .composite([{ input: Buffer.from(`<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toFile(outFile);
    console.log(`  cizim: ${outFile}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
