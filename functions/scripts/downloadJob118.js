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

async function getAccess() {
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

async function downloadGs(access, gsUrl, dest) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUrl);
  if (!m) throw new Error("bad " + gsUrl);
  const url =
    "https://storage.googleapis.com/storage/v1/b/" +
    m[1] +
    "/o/" +
    encodeURIComponent(m[2]) +
    "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) throw new Error(r.status + " " + gsUrl);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

(async () => {
  const access = await getAccess();
  const uid = "Fn1vb6XRPxOXtv9wgObKA8uRhtg1";
  const jobId = "1181577f-b22b-49d2-b86c-efe587c87af1";
  const outDir = path.join(process.env.TEMP, "frame-analysis-1181577f");
  fs.mkdirSync(outDir, { recursive: true });

  const docUrl =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs/" +
    jobId;
  const j = await (await fetch(docUrl, { headers: { Authorization: "Bearer " + access } })).json();
  const d = {};
  for (const [k, v] of Object.entries(j.fields || {})) d[k] = decode(v);
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(d, null, 2));

  const styleId = (d.styles && d.styles[0]) || "elegance";
  const accepted = (d.results && d.results[styleId] && d.results[styleId].photoUrls) || [];
  for (let i = 0; i < accepted.length; i++) {
    await downloadGs(access, accepted[i], path.join(outDir, "accepted_" + String(i).padStart(2, "0") + ".jpg"));
    console.log("ok", i);
  }
  const rej = d.rejectedFrames || [];
  for (let i = 0; i < rej.length; i++) {
    const name =
      "rejected_" +
      String(i).padStart(2, "0") +
      "__c" +
      rej[i].chunkIdx +
      "_a" +
      rej[i].attempt +
      "__" +
      rej[i].gate +
      ".jpg";
    await downloadGs(access, rej[i].gsUrl, path.join(outDir, name));
    console.log("rej", name, rej[i].detail || rej[i].reason);
  }

  console.log(
    JSON.stringify(
      {
        accepted: accepted.length,
        rejected: rej.length,
        refs: (d.falRefUrls || []).length,
        templates: d.templateNames,
        gates: rej.map((r) => ({
          c: r.chunkIdx,
          a: r.attempt,
          gate: r.gate,
          detail: r.detail,
          reason: r.reason,
        })),
        chunks: d.results && d.results[styleId] && d.results[styleId].chunks,
        updatedAt: d.updatedAt,
        photoMode: d.photoMode,
        model: d.model,
      },
      null,
      2
    )
  );
  console.log("DIR", outDir);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
