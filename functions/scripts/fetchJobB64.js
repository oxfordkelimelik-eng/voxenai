const fs = require("fs");
const path = require("path");

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

(async () => {
  const access = await getAccessToken();
  const uid = "Fn1vb6XRPxOXtv9wgObKA8uRhtg1";
  const jobId = "b64a0a65-4d64-464f-81b6-cdac908b94be";
  const url =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs/" +
    jobId;
  const res = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  const d = {};
  for (const [k, v] of Object.entries(j.fields || {})) d[k] = decode(v);
  const slim = {
    status: d.status,
    mode: d.mode || d.photoMode,
    model: d.model,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    facePhotoCount: d.facePhotoCount,
    chestUpPhotoCount: d.chestUpPhotoCount,
    referencePhotoCount: d.referencePhotoCount,
    imageCount: Array.isArray(d.imageUrls) ? d.imageUrls.length : null,
    photosCount: Array.isArray(d.photos) ? d.photos.length : null,
    rejected: (d.rejectedFrames || []).map((x) => ({
      gate: x.gate,
      reason: x.reason,
      detail: x.detail,
      chunkIdx: x.chunkIdx,
      attempt: x.attempt,
      gsUrl: x.gsUrl,
    })),
    keys: Object.keys(d).sort(),
  };
  console.log(JSON.stringify(slim, null, 2));
  fs.writeFileSync(path.join(process.env.TEMP, "job-b64a.json"), JSON.stringify(d, null, 2));

  const entries = JSON.parse(
    fs.readFileSync(path.join(process.env.TEMP, "recent-gate-logs.json"), "utf8")
  );
  const recent = entries.filter((e) => e.t >= "2026-09-06T17:20:00Z");
  const extra = recent.filter((e) =>
    /BODY|ORIENTATION|gövde|yönelim|HEAD_VS|HEAD_LARGE/i.test(e.m || "")
  );
  console.log("\nbody/orientation satır:", extra.length);
  for (const e of extra) console.log(e.t.slice(11, 19), (e.m || "").replace(/\n/g, " | ").slice(0, 200));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
