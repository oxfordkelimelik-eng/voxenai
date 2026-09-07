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

async function listLogs(access, filter) {
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
      pageSize: 400,
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.code + " " + j.error.message);
  return (j.entries || []).map((e) => ({
    t: e.timestamp,
    fn: e.resource?.labels?.function_name || e.resource?.labels?.service_name,
    m: e.textPayload || e.jsonPayload?.message || JSON.stringify(e.jsonPayload || {}).slice(0, 200),
  }));
}

(async () => {
  const access = await getAccessToken();
  const since = "2026-09-06T17:20:00Z";
  const needles = [
    "GEÇERSİZ",
    "REDDEDİLEN KARE",
    "KONUM KAPISI",
    "GÖZ ÖLÇÜM",
    "BODY_INTEGRITY",
    "HEAD_ORIENTATION",
    "HAZIRLIK REFERANS",
    "jobId",
    "chunk=2",
    "chunk=3",
    "chunk=4",
    "chunk=8",
  ];
  const filter =
    `timestamp>="${since}" AND (` +
    [
      'textPayload:"GEÇERSİZ"',
      'textPayload:"REDDEDİLEN KARE"',
      'textPayload:"KONUM KAPISI"',
      'textPayload:"GÖZ ÖLÇÜM"',
      'textPayload:"BODY_INTEGRITY"',
      'textPayload:"HEAD_ORIENTATION"',
      'textPayload:"gövde bütünlüğü"',
      'textPayload:"kafa yönelimi"',
      'textPayload:"TAMAMLANDI"',
      'textPayload:"teslim"',
      'textPayload:"TESLİM"',
      'textPayload:"finalize"',
      'textPayload:"done"',
    ].join(" OR ") +
    `)`;
  const entries = await listLogs(access, filter);
  console.log("detay satır:", entries.length);
  for (const e of entries) {
    console.log(e.t.slice(11, 19), (e.m || "").replace(/\n/g, " | ").slice(0, 280));
  }

  // Firestore: users list -> recent genJobs
  const usersUrl =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users?pageSize=50";
  const ures = await fetch(usersUrl, { headers: { Authorization: "Bearer " + access } });
  const uj = await ures.json();
  const userIds = (uj.documents || []).map((d) => d.name.split("/").pop());
  console.log("\nusers:", userIds.length);
  const hits = [];
  for (const uid of userIds) {
    const url =
      "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
      uid +
      "/private/genData/genJobs?pageSize=8";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
    const j = await r.json();
    for (const doc of j.documents || []) {
      const d = {};
      for (const [k, v] of Object.entries(doc.fields || {})) d[k] = decode(v);
      const updated = d.updatedAt || d.createdAt || "";
      if (String(updated) >= "2026-09-06T16:00") {
        hits.push({
          uid,
          id: doc.name.split("/").pop(),
          status: d.status,
          photos: Array.isArray(d.imageUrls) ? d.imageUrls.length : Array.isArray(d.photos) ? d.photos.length : 0,
          rej: Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0,
          refs: d.referencePhotoCount,
          face: d.facePhotoCount,
          chest: d.chestUpPhotoCount,
          updated,
          rejectedFrames: d.rejectedFrames || [],
          imageUrls: d.imageUrls,
          photosArr: d.photos,
          keys: Object.keys(d).sort(),
        });
      }
    }
  }
  console.log("\n--- bugünün işleri ---");
  console.log(JSON.stringify(hits.map((h) => ({
    id: h.id,
    uid: h.uid,
    status: h.status,
    photos: h.photos,
    rej: h.rej,
    refs: h.refs,
    face: h.face,
    chest: h.chest,
    updated: h.updated,
    gates: (h.rejectedFrames || []).map((x) => x.gate + "@c" + x.chunkIdx + "a" + x.attempt + (x.detail ? " " + x.detail : "")),
    keys: h.keys,
  })), null, 2));
  fs.writeFileSync(path.join(process.env.TEMP, "today-jobs.json"), JSON.stringify(hits, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
