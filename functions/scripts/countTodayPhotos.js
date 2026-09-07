/**
 * Bugün (Türkiye saati) üretilen kareleri sayar: teslim + elenen.
 */
const fs = require("fs");
const path = require("path");

const SINCE = "2026-09-05T21:00:00Z"; // 6 Eylül 00:00 +03

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
        client_id:
          "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
        client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
        refresh_token: cfg.tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    })
  ).json();
  if (!tok.access_token) throw new Error(JSON.stringify(tok));
  return tok.access_token;
}

function decode(v) {
  if (v == null) return null;
  if (v.stringValue != null) return v.stringValue;
  if (v.booleanValue != null) return v.booleanValue;
  if (v.integerValue != null) return Number(v.integerValue);
  if (v.doubleValue != null) return v.doubleValue;
  if (v.timestampValue != null) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(decode);
  if (v.mapValue) {
    const o = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) o[k] = decode(fv);
    return o;
  }
  return v;
}

async function listLogs(access, filter, pages = 10) {
  const out = [];
  let pageToken;
  for (let i = 0; i < pages; i++) {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "content-type": "application/json",
        "x-goog-user-project": "rise-up-9235f",
      },
      body: JSON.stringify({
        resourceNames: ["projects/rise-up-9235f"],
        filter,
        orderBy: "timestamp desc",
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.code + " " + j.error.message);
    for (const e of j.entries || []) {
      out.push({
        t: e.timestamp,
        m: e.textPayload || e.jsonPayload?.message || "",
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

(async () => {
  const access = await getAccessToken();
  const filter =
    `timestamp>="${SINCE}" AND resource.type="cloud_run_revision" AND (` +
    [
      'textPayload:"KALITE ÖLÇÜM"',
      'textPayload:"REDDEDİLEN KARE"',
      'textPayload:"ÜRETİM BAŞARISIZ"',
      'textPayload:"KONUM ÖLÇÜM"',
      'textPayload:"TAMAMLANDI"',
    ].join(" OR ") +
    ")";

  const entries = await listLogs(access, filter, 12);
  console.log("log satırı:", entries.length);
  if (entries.length) {
    console.log("en eski:", entries[entries.length - 1].t);
    console.log("en yeni:", entries[0].t);
  }

  const quality = [];
  const rejects = [];
  const failedGen = [];
  const konum = [];
  const done = [];
  for (const e of entries) {
    if (e.m.startsWith("KALITE ÖLÇÜM")) quality.push(e);
    else if (e.m.startsWith("REDDEDİLEN KARE")) rejects.push(e);
    else if (e.m.startsWith("ÜRETİM BAŞARISIZ")) failedGen.push(e);
    else if (e.m.startsWith("KONUM ÖLÇÜM")) konum.push(e);
    else if (/TAMAMLANDI/.test(e.m)) done.push(e);
  }

  const gates = {};
  const rejectJobs = {};
  for (const e of rejects) {
    const g = /gate-([A-Za-z0-9-]+)/.exec(e.m);
    const key = g ? g[1] : "?";
    gates[key] = (gates[key] || 0) + 1;
    const job = /\/([A-Za-z0-9_-]{8,})\/[A-Za-z]+_c\d+_att/.exec(e.m);
    if (job) rejectJobs[job[1]] = (rejectJobs[job[1]] || 0) + 1;
  }

  console.log("\nLOG ÖZET");
  console.log("modelden gelen kare (KALITE ÖLÇÜM):", quality.length);
  console.log("elenen kare (REDDEDİLEN KARE):", rejects.length);
  console.log("teslim aşamasına gelen (KONUM ÖLÇÜM):", konum.length);
  console.log("üretim başarısız (buffer yok):", failedGen.length);
  console.log("TAMAMLANDI satırı:", done.length);
  console.log("eleme kapıları:", JSON.stringify(gates));
  console.log("elenen iş başına:", JSON.stringify(rejectJobs));

  const q = await fetch(
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents:runQuery",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "genJobs", allDescendants: true }],
          orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }],
          limit: 80,
        },
      }),
    }
  );
  const rows = await q.json();
  if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 400));

  console.log("\nFIRESTORE son 8 iş (ham tarih):");
  let shown = 0;
  const todayJobs = [];
  for (const row of rows) {
    if (!row.document) continue;
    const data = {};
    for (const [k, v] of Object.entries(row.document.fields || {})) data[k] = decode(v);
    const created = data.createdAt || data.updatedAt || "";
    if (shown < 8) {
      console.log(
        " ",
        row.document.name.split("/").pop().slice(0, 8),
        "status=" + data.status,
        "created=", data.createdAt,
        "updated=", data.updatedAt
      );
      shown++;
    }
    if (String(created) < SINCE) continue;
    const uid = (row.document.name.match(/documents\/users\/([^/]+)/) || [])[1] || "?";
    let photos = Array.isArray(data.imageUrls) ? data.imageUrls.length : 0;
    if (!photos && data.results && typeof data.results === "object") {
      photos = Object.values(data.results).reduce(
        (n, r) => n + ((r && r.photoUrls && r.photoUrls.length) || 0),
        0
      );
    }
    const rej = Array.isArray(data.rejectedFrames) ? data.rejectedFrames.length : 0;
    todayJobs.push({
      id: row.document.name.split("/").pop(),
      uid,
      status: data.status,
      photos,
      rej,
      created: data.createdAt,
    });
  }

  console.log("\nFIRESTORE bugün iş:", todayJobs.length);
  let p = 0;
  let r = 0;
  for (const j of todayJobs) {
    p += j.photos;
    r += j.rej;
    console.log(
      j.id.slice(0, 8),
      j.status,
      "teslim=" + j.photos,
      "elenen=" + j.rej,
      "uid=" + j.uid,
      j.created
    );
  }
  console.log("FIRESTORE TOPLAM teslim=", p, "elenen=", r, "üretilen=", p + r);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
