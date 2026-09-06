/**
 * Vision'ın ölçüm sözleşmesini GEÇMİŞ veri setinin tamamında dener
 * (buildGazeDataset.js çıktısı). Amaç: kafa açıklığı kapısının gerçek
 * karelerde ne sıklıkta tetiklendiğini üretimi beklemeden görmek.
 *
 * Prompt, falPhotos.js'ten canlı okunur (kopya tutulmaz).
 * Kullanım: node scripts/probeVisionDataset.js [eşzamanlılık=6]
 */
const fs = require("fs");
const path = require("path");

function extractBasePrompt() {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  const start = src.indexOf(': mode === "base"');
  const open = src.indexOf("? (", start) + 3;
  const end = src.indexOf("\n      : (", open);
  const expr = src.slice(open, end).trim().replace(/\)$/, "");
  // eslint-disable-next-line no-eval
  return eval(expr);
}

async function ask(apiKey, prompt, outBuf, baseBuf) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are an automated quality-assurance component inside an image-generation pipeline. " +
            "You evaluate the pipeline's own rendered output against source material the user supplied " +
            "for their own generation job. You report rendering defects only — you never identify, " +
            "name, or speculate about who anyone is.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${outBuf.toString("base64")}`, detail: "high" } },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${baseBuf.toString("base64")}`, detail: "high" } },
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
  const conc = Number(process.argv[2] || 6);
  const dir = path.join(process.env.TEMP, "gaze-dataset");
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  const prompt = extractBasePrompt();

  const pick = (t, k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "im").exec(t);
    return m ? m[1].trim() : "—";
  };

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < index.length) {
      const it = index[cursor++];
      const b = path.join(dir, `${it.key}_base.jpg`);
      const o = path.join(dir, `${it.key}_out.jpg`);
      if (!fs.existsSync(b) || !fs.existsSync(o)) continue;
      try {
        const raw = await ask(apiKey, prompt, fs.readFileSync(o), fs.readFileSync(b));
        results.push({
          key: it.key,
          baseSpan: pick(raw, "BASE_HEAD_SPAN"),
          outSpan: pick(raw, "OUTPUT_HEAD_SPAN"),
          baseGaze: pick(raw, "BASE_GAZE"),
          outGaze: pick(raw, "OUTPUT_GAZE"),
          verdict: raw.split("\n").map((l) => l.trim()).filter(Boolean).pop(),
        });
      } catch (e) {
        results.push({ key: it.key, hata: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  fs.writeFileSync(path.join(dir, "vision-spans.json"), JSON.stringify(results, null, 1));

  const ok = results.filter((r) => !r.hata);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const drops = ok
    .map((r) => ({ ...r, drop: num(r.baseSpan) != null && num(r.outSpan) != null ? num(r.baseSpan) - num(r.outSpan) : null }))
    .filter((r) => r.drop != null);
  const fired = drops.filter((r) => r.drop >= 0.5);
  const gazeDiff = ok.filter((r) => r.baseGaze !== "—" && r.outGaze !== "—" &&
    r.baseGaze !== r.outGaze && r.baseGaze !== "AWAY" && r.outGaze !== "AWAY");

  console.log(`\nölçülen: ${ok.length}/${index.length} (hata: ${results.length - ok.length})`);
  console.log(`kafa açıklığı ölçülebilen: ${drops.length}`);
  console.log(`KAFA KAPISI TETİKLENEN (düşüş >= 0.5): ${fired.length} (%${((fired.length / drops.length) * 100).toFixed(1)})`);
  fired.forEach((r) => console.log(`  ${r.key.padEnd(30)} ${r.baseSpan} -> ${r.outSpan}   | ${r.verdict.slice(0, 55)}`));
  console.log(`\nBAKIŞ farkı bildirilen: ${gazeDiff.length} (%${((gazeDiff.length / ok.length) * 100).toFixed(1)})`);
  gazeDiff.slice(0, 12).forEach((r) => console.log(`  ${r.key.padEnd(30)} ${r.baseGaze} -> ${r.outGaze}`));
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
