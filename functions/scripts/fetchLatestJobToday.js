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
  const uid = process.argv[2] || "j2CZLA8rxkdJCo2Z0WbP4UCUx642";
  const url =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs?pageSize=20&orderBy=updatedAt%20desc";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  const jobs = (j.documents || []).map((doc) => {
    const d = {};
    for (const [k, v] of Object.entries(doc.fields || {})) d[k] = decode(v);
    return { id: doc.name.split("/").pop(), path: doc.name, data: d };
  });
  for (const job of jobs) {
    const d = job.data;
    const imgs = Array.isArray(d.imageUrls) ? d.imageUrls.length : 0;
    const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
    console.log(
      job.id.slice(0, 8),
      d.status,
      "photos=" + imgs,
      "rej=" + rej,
      "refs=" + d.referencePhotoCount,
      "face=" + d.facePhotoCount,
      "chest=" + d.chestUpPhotoCount,
      d.updatedAt
    );
  }
  const pick =
    jobs.find((x) => {
      const d = x.data;
      const imgs = Array.isArray(d.imageUrls) ? d.imageUrls.length : 0;
      const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
      return imgs === 10 && rej === 4;
    }) || jobs[0];
  const out = path.join(process.env.TEMP, "latest-job-today.json");
  fs.writeFileSync(out, JSON.stringify(pick, null, 2));
  console.log("\nPICK", pick.id, "->", out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
