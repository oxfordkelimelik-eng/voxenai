/**
 * Geçmişte KAÇ tane güvenilir "taban -> çıktı" çifti olduğunu sayar.
 *
 * GÜVENİLİR ÇİFT ŞARTI: bir chunk'ta hiç elenen kare yoksa o chunk ilk
 * şablonuyla üretilmiştir, yani templateNames[chunk] gerçekten o karenin
 * tabanıdır. Elenen karesi olan chunk'ta üretim yedek şablona geçmiş olabilir
 * (bkz. prepareNextUsable) ve eşleşme güvenilmez olur.
 *
 * Kullanım: node scripts/surveyGenJobs.js
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

(async () => {
  const access = await getAccessToken();
  const res = await fetch(
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents:runQuery",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "genJobs", allDescendants: true }],
          limit: 300,
        },
      }),
    }
  );
  const rows = await res.json();
  if (rows.error) throw new Error(`${rows.error.code} ${rows.error.message}`.slice(0, 200));

  const jobs = [];
  for (const r of rows) {
    if (!r.document) continue;
    const f = r.document.fields || {};
    const job = {
      id: r.document.name.split("/").pop(),
      uid: r.document.name.split("/users/")[1]?.split("/")[0],
      createdAt: dec(f.createdAt),
      status: dec(f.status),
      photoMode: dec(f.photoMode),
      templateNames: dec(f.templateNames) || [],
      rejectedFrames: dec(f.rejectedFrames) || [],
      results: dec(f.results) || {},
    };
    jobs.push(job);
  }

  let totalAccepted = 0;
  let totalReliable = 0;
  const perJob = [];
  for (const j of jobs) {
    const dirty = new Set(j.rejectedFrames.map((r) => r.chunkIdx));
    let accepted = 0;
    let reliable = 0;
    for (const [, styleRes] of Object.entries(j.results)) {
      for (const [cIdx, chunk] of Object.entries(styleRes.chunks || {})) {
        const n = (chunk.photoUrls || []).length;
        accepted += n;
        if (n > 0 && !dirty.has(Number(cIdx)) && j.templateNames[Number(cIdx)]) reliable += n;
      }
    }
    totalAccepted += accepted;
    totalReliable += reliable;
    if (accepted > 0) {
      perJob.push({
        id: j.id.slice(0, 8), tarih: (j.createdAt || "").slice(0, 10), mod: j.photoMode,
        kabul: accepted, güvenilir: reliable, elenen: j.rejectedFrames.length,
      });
    }
  }

  perJob.sort((a, b) => (a.tarih < b.tarih ? 1 : -1));
  console.log(`genJobs belgesi: ${jobs.length}, kare üretmiş iş: ${perJob.length}`);
  console.log(`TOPLAM kabul edilen kare: ${totalAccepted}`);
  console.log(`TOPLAM güvenilir eşleşen (şablonu kesin bilinen) kare: ${totalReliable}\n`);
  console.table(perJob.slice(0, 40));
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
