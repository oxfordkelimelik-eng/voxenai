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

(async () => {
  const access = await getAccessToken();
  const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString();

  // 1) Cloud Logging: son 8 saatteki jobId / hazırlık / red satırları
  const filter =
    `timestamp>="${since}" AND (` +
    `textPayload:"HAZIRLIK REFERANS" OR ` +
    `textPayload:"KALITE ÖLÇÜM" OR ` +
    `textPayload:"TEN ÖLÇÜM" OR ` +
    `textPayload:"YAW ÖLÇÜM" OR ` +
    `textPayload:"VISION ÖLÇÜM" OR ` +
    `textPayload:"GÖZLÜK KONTROLÜ" OR ` +
    `textPayload:"rejected" OR ` +
    `jsonPayload.message:"HAZIRLIK REFERANS"` +
    `)`;
  const logRes = await fetch("https://logging.googleapis.com/v2/entries:list", {
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
    }),
  });
  const logs = await logRes.json();
  if (logs.error) throw new Error("logs " + logs.error.code + " " + logs.error.message);
  const entries = logs.entries || [];
  console.log("log satırı:", entries.length, "since", since);
  const sample = entries.slice(0, 8).map((e) => ({
    t: e.timestamp,
    fn: e.resource?.labels?.function_name || e.resource?.labels?.service_name,
    m: (e.textPayload || e.jsonPayload?.message || "").slice(0, 220),
  }));
  console.log(JSON.stringify(sample, null, 2));

  // 2) collection group — indeks yoksa hata bas
  const qRes = await fetch(
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
          limit: 12,
        },
      }),
    }
  );
  const rows = await qRes.json();
  if (!Array.isArray(rows)) {
    console.log("collectionGroup hata:", JSON.stringify(rows).slice(0, 400));
  } else {
    console.log("\n--- son genJobs ---");
    for (const row of rows) {
      if (!row.document) continue;
      const d = {};
      for (const [k, v] of Object.entries(row.document.fields || {})) d[k] = decode(v);
      const id = row.document.name.split("/").pop();
      const uid = (row.document.name.split("/users/")[1] || "").split("/")[0];
      const imgs = Array.isArray(d.imageUrls)
        ? d.imageUrls.length
        : Array.isArray(d.photos)
          ? d.photos.length
          : 0;
      const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
      console.log(
        id.slice(0, 8),
        "uid=" + uid.slice(0, 8),
        d.status,
        "photos=" + imgs,
        "rej=" + rej,
        "refs=" + d.referencePhotoCount,
        d.updatedAt
      );
    }
  }

  fs.writeFileSync(
    path.join(process.env.TEMP, "recent-gate-logs.json"),
    JSON.stringify(
      entries.map((e) => ({
        t: e.timestamp,
        fn: e.resource?.labels?.function_name || e.resource?.labels?.service_name,
        labels: e.labels,
        m: e.textPayload || e.jsonPayload?.message || "",
      })),
      null,
      1
    )
  );
  console.log("yazıldı", path.join(process.env.TEMP, "recent-gate-logs.json"));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
