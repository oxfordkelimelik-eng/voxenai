const fs = require("fs");
const path = require("path");

async function getAccessToken() {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(process.env.USERPROFILE, ".config", "configstore", "firebase-tools.json"),
      "utf8"
    )
  );
  const refresh = cfg.tokens.refresh_token;
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:
        "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(JSON.stringify(tok));
  return tok.access_token;
}

function decodeField(v) {
  if (v == null) return null;
  if (v.stringValue != null) return v.stringValue;
  if (v.booleanValue != null) return v.booleanValue;
  if (v.integerValue != null) return Number(v.integerValue);
  if (v.doubleValue != null) return v.doubleValue;
  if (v.timestampValue != null) return v.timestampValue;
  if (v.arrayValue) {
    return (v.arrayValue.values || []).map(decodeField);
  }
  if (v.mapValue) {
    const out = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) {
      out[k] = decodeField(fv);
    }
    return out;
  }
  return v;
}

(async () => {
  const access = await getAccessToken();
  const url =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents:runQuery";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + access,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "genJobs", allDescendants: true }],
        orderBy: [
          { field: { fieldPath: "updatedAt" }, direction: "DESCENDING" },
        ],
        limit: 6,
      },
    }),
  });
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    console.error(JSON.stringify(rows).slice(0, 800));
    process.exit(1);
  }

  const jobs = [];
  for (const row of rows) {
    if (!row.document) continue;
    const name = row.document.name;
    const f = row.document.fields || {};
    const data = {};
    for (const [k, v] of Object.entries(f)) data[k] = decodeField(v);
    const short = name.split("/documents/")[1];
    jobs.push({ path: short, data });
  }

  // Prefer job with ~10 outputs and ~8 rejects, else newest done
  function score(j) {
    const d = j.data;
    const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
    const imgs = Array.isArray(d.imageUrls)
      ? d.imageUrls.length
      : Array.isArray(d.photos)
        ? d.photos.length
        : 0;
    return (imgs === 10 && rej === 8 ? 1000 : 0) + rej * 10 + imgs;
  }
  jobs.sort((a, b) => score(b) - score(a));

  for (const j of jobs.slice(0, 3)) {
    const d = j.data;
    console.log(
      "\n===",
      j.path,
      "===\n",
      JSON.stringify(
        {
          status: d.status,
          mode: d.mode,
          model: d.model,
          incompleteDelivery: d.incompleteDelivery,
          facePhotoCount: d.facePhotoCount,
          chestUpPhotoCount: d.chestUpPhotoCount,
          referencePhotoCount: d.referencePhotoCount,
          imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls.length : d.imageUrls,
          photos: Array.isArray(d.photos) ? d.photos.length : undefined,
          rejectedFrames: Array.isArray(d.rejectedFrames)
            ? d.rejectedFrames.length
            : d.rejectedFrames,
          updatedAt: d.updatedAt,
          errorMessage: d.errorMessage,
          keys: Object.keys(d).sort(),
        },
        null,
        2
      )
    );
  }

  const best = jobs[0];
  fs.writeFileSync(
    path.join(process.env.TEMP, "latest-genjob.json"),
    JSON.stringify(best, null, 2)
  );
  console.log("\nWrote", path.join(process.env.TEMP, "latest-genjob.json"));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
