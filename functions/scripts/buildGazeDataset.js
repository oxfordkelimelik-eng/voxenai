/**
 * GEÇMİŞTEN VERİ SETİ KURAR — bakış/kafa kapılarının eşiğini üretimi
 * beklemeden kalibre edebilmek için.
 *
 * Yalnızca GÜVENİLİR çiftleri alır: bir chunk'ta hiç elenen kare yoksa o kare
 * ilk şablonuyla üretilmiştir, yani templateNames[chunk] gerçekten tabanıdır.
 * Elenen karesi olan chunk'larda üretim yedek şablona geçmiş olabilir
 * (prepareNextUsable) ve taban görselimiz yanlış olur — o çiftler atlanır.
 *
 * Çıktı: %TEMP%/gaze-dataset/<job>_c<chunk>_{base,out}.jpg + index.json
 * Kullanım: node scripts/buildGazeDataset.js
 */
const fs = require("fs");
const path = require("path");

async function getAccessToken() {
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
  if (!tok.access_token) throw new Error(JSON.stringify(tok).slice(0, 200));
  return tok.access_token;
}

function dec(v) {
  if (v == null) return null;
  if (v.stringValue != null) return v.stringValue;
  if (v.booleanValue != null) return v.booleanValue;
  if (v.integerValue != null) return Number(v.integerValue);
  if (v.doubleValue != null) return v.doubleValue;
  if (v.timestampValue != null) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(dec);
  if (v.mapValue) {
    const o = {};
    for (const [k, f] of Object.entries(v.mapValue.fields || {})) o[k] = dec(f);
    return o;
  }
  return null;
}

const BUCKET = "rise-up-9235f.firebasestorage.app";

async function download(access, objectPath, dest) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/` +
    encodeURIComponent(objectPath) + "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) throw new Error(`${r.status} ${objectPath.slice(0, 60)}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

(async () => {
  const access = await getAccessToken();
  const outDir = path.join(process.env.TEMP, "gaze-dataset");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = await (
    await fetch(
      "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents:runQuery",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + access, "content-type": "application/json" },
        body: JSON.stringify({
          structuredQuery: { from: [{ collectionId: "genJobs", allDescendants: true }], limit: 300 },
        }),
      }
    )
  ).json();

  const index = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.document) continue;
    const f = r.document.fields || {};
    const jobId = r.document.name.split("/").pop();
    const short = jobId.slice(0, 8);
    const templateNames = dec(f.templateNames) || [];
    const rejected = dec(f.rejectedFrames) || [];
    const results = dec(f.results) || {};
    const createdAt = dec(f.createdAt);
    const dirty = new Set(rejected.map((x) => x.chunkIdx));

    for (const [styleId, styleRes] of Object.entries(results)) {
      for (const [cIdxStr, chunk] of Object.entries(styleRes.chunks || {})) {
        const cIdx = Number(cIdxStr);
        const urls = chunk.photoUrls || [];
        const tpl = templateNames[cIdx];
        if (urls.length === 0 || dirty.has(cIdx) || !tpl) continue;

        const key = `${short}_${styleId}_c${cIdx}`;
        const basePath = path.join(outDir, `${key}_base.jpg`);
        const outPath = path.join(outDir, `${key}_out.jpg`);
        try {
          if (!fs.existsSync(basePath)) await download(access, tpl, basePath);
          if (!fs.existsSync(outPath)) {
            const objectPath = urls[0].replace(`gs://${BUCKET}/`, "");
            await download(access, objectPath, outPath);
          }
          index.push({ key, jobId: short, styleId, chunk: cIdx, tarih: (createdAt || "").slice(0, 10) });
        } catch (e) {
          skipped++;
          console.log(`atlandı ${key}: ${e.message}`);
        }
      }
    }
  }

  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 1));
  console.log(`\nindirilen güvenilir çift: ${index.length}  (atlanan: ${skipped})`);
  console.log(`klasör: ${outDir}`);
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
