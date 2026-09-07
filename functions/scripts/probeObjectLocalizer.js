/**
 * Google Cloud Vision NESNE KONUMLANDIRICI probu.
 *
 * GPT-4o'nun verdiği kutular gerçekte ele denk gelmedi (hepsi kolun/ceketin
 * üstüne düştü, chunk7'de omuz/çene bölgesine). Bu prob, zaten bağımlılıkta
 * olan @google-cloud/vision'ın objectLocalization'ının "Human hand" / "Human
 * arm" gibi Open Images sınıflarını GERÇEKTEN doğru yerde verip vermediğini
 * ölçer. Kutular kareye çizilir, gözle doğrulanır.
 *
 * Kullanım: node scripts/probeObjectLocalizer.js
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// Yerel makinede ADC yok; firebase-tools'un refresh token'ıyla REST'e gidiyoruz.
// Üretimde @google-cloud/vision istemcisi ADC'yi kendisi bulur (contentModeration.js).
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

async function localize(token, buf) {
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
  if (j.error) throw new Error(j.error.code + " " + j.error.message);
  const resp = j.responses?.[0];
  if (resp?.error) throw new Error(resp.error.message);
  return resp?.localizedObjectAnnotations || [];
}

const DIR = path.join(process.env.TEMP, "job-2286-frames");
const OUT = path.join(process.env.TEMP, "objloc-probe");
const FRAMES = [
  ["chunk0  wellness / hayalet el", "OK_chunk0.jpg"],
  ["chunk1  kahverengi takim / silik el", "OK_elegance_1_0.jpg"],
  ["chunk4  eller cepte / kol kirmizi", "OK_elegance_4_0.jpg"],
  ["chunk3  teslim (kiyas)", "OK_chunk3.jpg"],
  ["chunk7  yat (kiyas)", "OK_chunk7.jpg"],
  ["chunk8  kask (kiyas)", "OK_chunk8.jpg"],
];

async function draw(buf, objs, outPath) {
  const meta = await sharp(buf).metadata();
  const rects = objs.map((o, i) => {
    const xs = o.vertices.map((v) => v.x), ys = o.vertices.map((v) => v.y);
    const x = Math.round(Math.min(...xs) * meta.width);
    const y = Math.round(Math.min(...ys) * meta.height);
    const w = Math.round((Math.max(...xs) - Math.min(...xs)) * meta.width);
    const h = Math.round((Math.max(...ys) - Math.min(...ys)) * meta.height);
    const color = /hand|arm/i.test(o.name) ? "#00ff5f" : "#ff3860";
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="5"/>` +
           `<text x="${x + 6}" y="${y + 30}" font-size="28" fill="${color}">${o.name}</text>`;
  }).join("");
  const svg = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
  );
  await sharp(buf).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 90 }).toFile(outPath);
}

(async () => {
  const token = await accessToken();
  fs.mkdirSync(OUT, { recursive: true });

  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) { console.log(`\n${label}: DOSYA YOK`); continue; }
    const buf = fs.readFileSync(p);
    const annotations = await localize(token, buf);
    const objs = annotations.map((a) => ({
      name: a.name,
      score: a.score,
      vertices: a.boundingPoly.normalizedVertices.map((v) => ({ x: v.x || 0, y: v.y || 0 })),
    }));
    console.log(`\n${label}`);
    for (const o of objs) {
      const xs = o.vertices.map((v) => v.x), ys = o.vertices.map((v) => v.y);
      console.log(
        `  ${o.name.padEnd(16)} skor=${o.score.toFixed(2)} ` +
        `kutu=[${Math.min(...xs).toFixed(2)},${Math.min(...ys).toFixed(2)} ` +
        `${Math.max(...xs).toFixed(2)},${Math.max(...ys).toFixed(2)}]`
      );
    }
    if (!objs.length) console.log("  (nesne yok)");
    const png = path.join(OUT, file.replace(/\.jpg$/, "_obj.jpg"));
    await draw(buf, objs, png);
    console.log(`  cizim: ${png}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
