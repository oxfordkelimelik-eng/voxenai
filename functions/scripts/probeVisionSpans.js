/**
 * Vision'ın YENİ ölçüm sözleşmesini gerçek karelerle dener: taban ve çıktı
 * için kafa/omuz açıklığı ile bakış yönü AYRI AYRI soruluyor mu, ve iki ölçüm
 * gerçekten FARKLILAŞIYOR mu?
 *
 * Prompt metni falPhotos.js'ten CANLI olarak çıkarılır (kopya tutulmaz) —
 * böylece test, deploy edilecek prompt'un aynısını dener.
 *
 * Kullanım: node scripts/probeVisionSpans.js <klasör> [maxKare]
 * Ortam: OPENAI_API_KEY
 */
const fs = require("fs");
const path = require("path");

function extractBasePrompt() {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  const start = src.indexOf(': mode === "base"');
  if (start < 0) throw new Error("base prompt bloğu bulunamadı");
  const open = src.indexOf("? (", start) + 3; // "? (" sonrası: string ifadesinin başı
  // Blok, satır başında "      : (" ile biten yerde kapanıyor.
  const end = src.indexOf("\n      : (", open);
  if (end < 0) throw new Error("base prompt bloğunun sonu bulunamadı");
  const expr = src.slice(open, end).trim().replace(/\)$/, "");
  // İçerik saf string birleştirmesi — güvenle değerlendirilebilir.
  // eslint-disable-next-line no-eval
  return eval(expr);
}

async function ask(apiKey, prompt, outBuf, baseBuf) {
  const content = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${outBuf.toString("base64")}`, detail: "high" } },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${baseBuf.toString("base64")}`, detail: "high" } },
  ];
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
        { role: "user", content },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return (j?.choices?.[0]?.message?.content || "").trim();
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY yok");
  const dir = process.argv[2];
  const max = Number(process.argv[3] || 10);
  const prompt = extractBasePrompt();
  console.log(`prompt uzunluğu: ${prompt.length} karakter\n`);

  const pick = (line, key) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(line);
    return m ? m[1].trim() : "—";
  };

  // GÜVENİLİR EŞLEŞME ŞARTI: bir chunk'ta elenen kare varsa üretim YEDEK
  // ŞABLONA geçmiş olabilir (bkz. prepareNextUsable) ve templateNames yalnızca
  // İLK seçimi saklıyor — o chunk'ta "taban" görselimiz yanlış olur. Bu yüzden
  // yalnızca hiç elenmemiş chunk'lar karşılaştırılır.
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const dirty = new Set((meta.rejectedFrames || []).map((r) => r.chunkIdx));
  console.log(`atlanan (şablonu değişmiş olabilir) chunk'lar: ${[...dirty].sort().join(", ") || "yok"}\n`);

  for (let i = 0; i < max; i++) {
    if (dirty.has(i)) continue;
    const out = path.join(dir, `accepted_${String(i).padStart(2, "0")}.jpg`);
    const base = path.join(dir, `tpl_c${i}.jpg`);
    if (!fs.existsSync(out) || !fs.existsSync(base)) continue;
    let raw;
    try {
      raw = await ask(apiKey, prompt, fs.readFileSync(out), fs.readFileSync(base));
    } catch (e) {
      console.log(`accepted_${String(i).padStart(2, "0")}  HATA ${e.message}`);
      continue;
    }
    const bs = pick(raw, "BASE_HEAD_SPAN");
    const os = pick(raw, "OUTPUT_HEAD_SPAN");
    const bg = pick(raw, "BASE_GAZE");
    const og = pick(raw, "OUTPUT_GAZE");
    const verdict = raw.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    const spanDrop = (Number(bs) - Number(os));
    const flag = [];
    if (Number.isFinite(spanDrop) && spanDrop >= 0.5) flag.push("KAFA BÜYÜK");
    if (bg !== "—" && og !== "—" && bg !== og && bg !== "AWAY" && og !== "AWAY") flag.push("BAKIŞ FARKLI");
    console.log(
      `accepted_${String(i).padStart(2, "0")}  açıklık ${bs} -> ${os}   bakış ${bg} -> ${og}   ` +
      `${flag.length ? "*** " + flag.join(" + ") : "temiz"}   | ${verdict.slice(0, 60)}`
    );
  }
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
