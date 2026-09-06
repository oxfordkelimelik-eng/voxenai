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
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) {
      o[k] = decode(fv);
    }
    return o;
  }
  return v;
}

async function getAccessToken() {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(
        process.env.USERPROFILE,
        ".config",
        "configstore",
        "firebase-tools.json"
      ),
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
  if (!m) throw new Error("bad gs url " + gsUrl);
  const url =
    "https://storage.googleapis.com/storage/v1/b/" +
    m[1] +
    "/o/" +
    encodeURIComponent(m[2]) +
    "?alt=media";
  const r = await fetch(url, {
    headers: { Authorization: "Bearer " + access },
  });
  if (!r.ok) throw new Error(r.status + " " + gsUrl);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  const access = await getAccessToken();
  const uid = "j2CZLA8rxkdJCo2Z0WbP4UCUx642";
  const jobId = process.argv[2] || "26df8451-c5c5-474e-93da-f68414ae340d";
  const outDir = path.join(process.env.TEMP, "frame-analysis-" + jobId.slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });

  const docUrl =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs/" +
    jobId;
  const j = await (
    await fetch(docUrl, { headers: { Authorization: "Bearer " + access } })
  ).json();
  const d = {};
  for (const [k, v] of Object.entries(j.fields || {})) d[k] = decode(v);
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(d, null, 2));

  const styleId = (d.styles && d.styles[0]) || "elegance";
  const accepted = (d.results && d.results[styleId] && d.results[styleId].photoUrls) || [];
  for (let i = 0; i < accepted.length; i++) {
    const dest = path.join(
      outDir,
      "accepted_" + String(i).padStart(2, "0") + ".jpg"
    );
    const n = await downloadGs(access, accepted[i], dest);
    console.log("ok", path.basename(dest), n);
  }

  const rej = d.rejectedFrames || [];
  for (let i = 0; i < rej.length; i++) {
    const dest = path.join(
      outDir,
      "rejected_" +
        String(i).padStart(2, "0") +
        "__c" +
        rej[i].chunkIdx +
        "_a" +
        rej[i].attempt +
        "__" +
        rej[i].gate +
        ".jpg"
    );
    const n = await downloadGs(access, rej[i].gsUrl, dest);
    console.log("rej", path.basename(dest), n, rej[i].detail);
  }

  for (let i = 0; i < (d.falRefUrls || []).length; i++) {
    const dest = path.join(outDir, "ref_" + String(i).padStart(2, "0") + ".jpg");
    try {
      const n = await downloadGs(access, d.falRefUrls[i], dest);
      console.log("ref", i, n);
    } catch (e) {
      console.log("ref fail", i, e.message);
    }
  }

  if (d.primaryFaceUrl) {
    try {
      await downloadGs(
        access,
        d.primaryFaceUrl,
        path.join(outDir, "primary_face.jpg")
      );
      console.log("primary ok");
    } catch (e) {
      console.log("primary", e.message);
    }
  }

  console.log("DIR", outDir);
  console.log(
    "SUMMARY",
    JSON.stringify({
      accepted: accepted.length,
      rejected: rej.length,
      gates: rej.map((r) => ({
        chunk: r.chunkIdx,
        attempt: r.attempt,
        gate: r.gate,
        detail: r.detail,
        reason: r.reason,
      })),
      refSkinTone: d.refSkinTone,
      templateNames: d.templateNames,
      photoMode: d.photoMode,
      model: d.model,
      falRefCount: (d.falRefUrls || []).length,
    })
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
