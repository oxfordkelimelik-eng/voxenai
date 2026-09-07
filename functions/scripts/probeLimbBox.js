/**
 * UZUV KONUMU kalibrasyon probu (Person kutusuna kırpma + numaralı ızgara).
 *
 * Vision'dan hücreleri ister, hücreleri tam kare koordinatına çevirir, kareye
 * çizer (gözle doğrulanacak) ve o bölgede netlik + ten farkını ölçer.
 *
 * Kullanım: node scripts/probeLimbBox.js
 * Ortam: OPENAI_API_KEY
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { locateLimbRegions, judgeLimbCrop } = require("../limbBox");
const { measureLimbRegion } = require("../faceQuality");

const DIR = path.join(process.env.TEMP, "job-2286-frames");
const OUT = path.join(process.env.TEMP, "limb-box-probe");
const FRAMES = [
  ["chunk0  wellness / hayalet el", "OK_chunk0.jpg"],
  ["chunk1  kahverengi takim / silik el", "OK_elegance_1_0.jpg"],
  ["chunk4  eller cepte / kol kirmizi", "OK_elegance_4_0.jpg"],
  ["chunk3  teslim (kiyas)", "OK_chunk3.jpg"],
  ["chunk7  yat (kiyas)", "OK_chunk7.jpg"],
  ["chunk8  kask (kiyas)", "OK_chunk8.jpg"],
];

// Yerel makinede ADC yok; üretimde @google-cloud/vision istemcisi kullanılacak.
async function accessToken() {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(process.env.USERPROFILE, ".config", "configstore", "firebase-tools.json"),
      "utf8"
    )
  );
  const tok = await (
    await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
        client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
        refresh_token: cfg.tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    })
  ).json();
  if (!tok.access_token) throw new Error(JSON.stringify(tok));
  return tok.access_token;
}

function makeAnnotator(token) {
  return async (buf) => {
    const r = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-goog-user-project": "rise-up-9235f",
      },
      body: JSON.stringify({
        requests: [{
          image: { content: buf.toString("base64") },
          features: [{ type: "OBJECT_LOCALIZATION", maxResults: 20 }],
        }],
      }),
    });
    const j = await r.json();
    const anns = j.responses?.[0]?.localizedObjectAnnotations || [];
    return anns.map((a) => ({
      name: a.name,
      score: a.score,
      vertices: (a.boundingPoly.normalizedVertices || []).map((v) => ({ x: v.x || 0, y: v.y || 0 })),
    }));
  };
}

async function draw(buf, boxes, crop, outPath) {
  const meta = await sharp(buf).metadata();
  const rect = (b, color, opacity) =>
    `<rect x="${Math.round(b.x * meta.width)}" y="${Math.round(b.y * meta.height)}" ` +
    `width="${Math.round(b.w * meta.width)}" height="${Math.round(b.h * meta.height)}" ` +
    `fill="${color}" fill-opacity="${opacity}" stroke="${color}" stroke-width="4"/>`;
  const svg =
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">` +
    rect(crop, "#3d8bfd", 0) +
    boxes.map((b) => rect(b, "#00ff5f", 0.3)).join("") +
    "</svg>";
  await sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY yok");
  const annotate = makeAnnotator(await accessToken());
  fs.mkdirSync(OUT, { recursive: true });

  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);

    const loc = await locateLimbRegions(buf, apiKey, annotate);
    console.log(`\n${label}`);
    if (!loc.ok) { console.log(`  KONUM: BASARISIZ[${loc.reason}] ham="${(loc.raw || "").replace(/\n/g, " ")}"`); continue; }
    console.log(
      `  KONUM hucreler=[${loc.cells.join(",")}] bolgeSayisi=${loc.boxes.length} ` +
      `kirpma=[${loc.crop.x.toFixed(2)},${loc.crop.y.toFixed(2)} ` +
      `${(loc.crop.x + loc.crop.w).toFixed(2)},${(loc.crop.y + loc.crop.h).toFixed(2)}]`
    );
    if (!loc.boxes.length) { console.log("  (gorunur ciplak uzuv YOK)"); continue; }

    const m = await measureLimbRegion(buf, loc.boxes);
    if (!m.ok) {
      console.log(`  OLCUM: ATLANDI[${m.reason}]`);
    } else {
      for (const r of m.regions) {
        console.log(
          `   bolge tenPx=${String(r.skinPx).padStart(6)} ` +
          `uzuvVaryans=${r.localVar != null ? r.localVar.toFixed(1).padStart(7) : "   null"} ` +
          `yuzeGoreNetlik=${r.ratio != null ? r.ratio.toFixed(3) : "null"} ` +
          `kroma=${r.chroma != null ? r.chroma.toFixed(1) : "null"} ` +
          `aciklikFarki=${r.deltaL != null ? r.deltaL.toFixed(1) : "null"}`
        );
      }
      console.log(
        `  OZET enKotuNetlik=${m.worstRatio != null ? m.worstRatio.toFixed(3) : "null"} ` +
        `enBuyukKroma=${m.maxChroma != null ? m.maxChroma.toFixed(1) : "null"} ` +
        `enBuyukAciklik=${m.maxDeltaL != null ? m.maxDeltaL.toFixed(1) : "null"} ` +
        `yuzCildiVaryans=${m.faceVar.toFixed(1)} (${m.faceSkinPx} px)`
      );
    }
    const jd = await judgeLimbCrop(buf, loc.boxes, apiKey);
    console.log(
      jd.ok
        ? `  KIRPMA YARGISI: ${jd.bad ? "RED[limb-ghost]" : "GECTI"} ` +
          `isaretler=${jd.flags.join(",") || "-"} gerekce="${jd.detail}"`
        : `  KIRPMA YARGISI: ATLANDI[${jd.reason}]`
    );

    const outFile = path.join(OUT, file.replace(/\.jpg$/, "_sel.jpg"));
    await draw(buf, loc.boxes, loc.crop, outFile);
    console.log(`  cizim: ${outFile}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
