/**
 * Geçmiş işlerin KULLANICI REFERANS fotoğraflarını indirir (varsa) ve
 * gövde (göğüs-üstü) karelerinin yüz açısını ölçer.
 *
 * Amaç: "önden çekilmiş olmalı" şartının eşiğini tahminle değil, gerçek
 * kullanıcı fotoğraflarının dağılımına bakarak koymak.
 *
 * Kullanım: node scripts/fetchRefPhotos.js
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

const BUCKET = "rise-up-9235f.firebasestorage.app";

async function tryDownload(access, objectPath, dest) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/` +
    encodeURIComponent(objectPath) + "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) return false;
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return true;
}

(async () => {
  const access = await getAccessToken();
  const outDir = path.join(process.env.TEMP, "ref-photos");
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

  const jobs = [];
  for (const r of rows) {
    if (!r.document) continue;
    const name = r.document.name;
    jobs.push({
      id: name.split("/").pop(),
      uid: name.split("/users/")[1]?.split("/")[0],
      createdAt: r.document.fields?.createdAt?.timestampValue || "",
    });
  }

  let found = 0;
  const manifest = [];
  for (const j of jobs) {
    for (let i = 0; i < 5; i++) {
      const objectPath = `dating_training/${j.uid}/${j.id}/photo_${i}.jpg`;
      const dest = path.join(outDir, `${j.id.slice(0, 8)}_p${i}.jpg`);
      if (fs.existsSync(dest)) { manifest.push({ job: j.id.slice(0, 8), idx: i }); found++; continue; }
      if (await tryDownload(access, objectPath, dest)) {
        manifest.push({ job: j.id.slice(0, 8), idx: i, tarih: j.createdAt.slice(0, 10) });
        found++;
      }
    }
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`iş sayısı: ${jobs.length}, indirilen referans fotoğraf: ${found}`);
  const byIdx = {};
  for (const m of manifest) byIdx[m.idx] = (byIdx[m.idx] || 0) + 1;
  console.log("index başına:", JSON.stringify(byIdx));
  console.log("klasör:", outDir);
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
