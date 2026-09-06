/**
 * Güneş gözlüğü tespitini gerçek fotoğraflarla dener.
 *
 * Referans fotoğraf kapısına "güneş gözlüğü olmasın" şartı eklenmeden önce,
 * kullanılacak sorunun gerçekten ayırt edip etmediğini ölçer. Sonuçlar
 * kontak sayfası olarak da yazılır ki gözle doğrulanabilsin.
 *
 * Kullanım: node scripts/probeSunglasses.js [adet=40]
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const PROMPT =
  "Look at the person in this photo and answer two questions about their eyes.\n" +
  "Reply on exactly two lines, nothing else:\n" +
  "EYEWEAR: <NONE | CLEAR_GLASSES | SUNGLASSES>\n" +
  "EYES_VISIBLE: <YES | NO>\n\n" +
  "SUNGLASSES means tinted, dark or mirrored lenses that hide or darken the eyes, " +
  "including lenses pushed onto the face but still covering the eyes. " +
  "CLEAR_GLASSES means transparent prescription lenses through which the eyes are plainly visible. " +
  "NONE means no eyewear on the eyes at all; glasses resting on the head or hanging from " +
  "a collar count as NONE. Answer EYES_VISIBLE: NO whenever the pupils cannot be seen.";

async function ask(apiKey, buf) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}`, detail: "low" } },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  return (j?.choices?.[0]?.message?.content || "").trim();
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY yok");
  const count = Number(process.argv[2] || 40);
  const dir = path.join(process.env.TEMP, "gaze-dataset");
  const out = path.join(process.env.TEMP, "gaze-check");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith("_base.jpg")).slice(0, count);

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const f = files[cursor++];
      try {
        // Yüz bölgesi yeterli: üst yarıyı gönderiyoruz (token tasarrufu).
        const p = path.join(dir, f);
        const m = await sharp(p).metadata();
        const buf = await sharp(p)
          .extract({ left: 0, top: 0, width: m.width, height: Math.round(m.height * 0.55) })
          .resize({ width: 512 })
          .jpeg({ quality: 85 })
          .toBuffer();
        const raw = await ask(apiKey, buf);
        const eyewear = (/EYEWEAR:\s*(\w+)/i.exec(raw) || [])[1] || "?";
        const visible = (/EYES_VISIBLE:\s*(\w+)/i.exec(raw) || [])[1] || "?";
        results.push({ file: f, eyewear, visible });
      } catch (e) {
        results.push({ file: f, hata: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  const grup = {};
  for (const r of results) grup[r.eyewear || "HATA"] = (grup[r.eyewear || "HATA"] || 0) + 1;
  console.log("dağılım:", JSON.stringify(grup));

  // Gözle doğrulama için grup grup kontak sayfası
  for (const label of ["SUNGLASSES", "CLEAR_GLASSES", "NONE"]) {
    const grp = results.filter((r) => r.eyewear === label).slice(0, 8);
    if (grp.length === 0) continue;
    const comps = [];
    for (let i = 0; i < grp.length; i++) {
      const p = path.join(dir, grp[i].file);
      const m = await sharp(p).metadata();
      const buf = await sharp(p)
        .extract({ left: 0, top: 0, width: m.width, height: Math.round(m.height * 0.5) })
        .resize(240, 240, { fit: "cover" })
        .toBuffer();
      comps.push({ input: buf, left: (i % 4) * 250, top: Math.floor(i / 4) * 250 });
    }
    const rows = Math.ceil(grp.length / 4);
    await sharp({ create: { width: 1000, height: rows * 250, channels: 3, background: "#222" } })
      .composite(comps).jpeg({ quality: 90 }).toFile(path.join(out, `sg_${label}.jpg`));
    console.log(`${label}: ${grp.length} kare -> sg_${label}.jpg`);
  }
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
