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

function short(n) {
  return String(n || "").split("/").pop();
}

(async () => {
  const access = await getAccessToken();
  const uid = "Fn1vb6XRPxOXtv9wgObKA8uRhtg1";
  const url =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs?pageSize=6&orderBy=updatedAt%20desc";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  const jobs = (j.documents || []).map((doc) => {
    const d = {};
    for (const [k, v] of Object.entries(doc.fields || {})) d[k] = decode(v);
    return { id: doc.name.split("/").pop(), data: d };
  });
  for (const job of jobs) {
    const d = job.data;
    const photos = d.results?.elegance?.photoUrls?.length || 0;
    const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
    console.log(
      job.id.slice(0, 8),
      d.status,
      "photos=" + photos,
      "rej=" + rej,
      "face=" + d.facePhotoCount,
      "refs=" + d.referencePhotoCount,
      "mode=" + d.photoMode,
      d.updatedAt
    );
    console.log("  tpls:", (d.templateNames || []).map(short).join(" | "));
    if (rej) {
      for (const x of d.rejectedFrames) {
        console.log(
          "  REJ",
          "c" + x.chunkIdx + "a" + x.attempt,
          x.gate,
          x.detail || "",
          x.gsUrl ? short(x.gsUrl) : ""
        );
      }
    }
  }
  const latest = jobs[0];
  fs.writeFileSync(path.join(process.env.TEMP, "latest-live-job.json"), JSON.stringify(latest, null, 2));

  const jobId = latest.id;
  const since = "2026-09-06T19:50:00Z";
  const filter =
    `timestamp>="${since}" AND (` +
    [
      `textPayload:"${jobId}"`,
      `textPayload:"${jobId.slice(0, 8)}"`,
      'textPayload:"HAZIRLIK REFERANS"',
      'textPayload:"ŞABLON HAVUZU"',
      'textPayload:"YAW ÖLÇÜM"',
      'textPayload:"KALITE ÖLÇÜM"',
      'textPayload:"TEN ÖLÇÜM"',
      'textPayload:"VISION ÖLÇÜM"',
      'textPayload:"REDDEDİLEN"',
      'textPayload:"GEÇERSİZ"',
      'textPayload:"HEAD_VS_BODY"',
      'textPayload:"BODY_INTEGRITY"',
      'textPayload:"çekildi="',
      'textPayload:"fazlaDönme="',
      'textPayload:"yüz kutusu"',
    ].join(" OR ") +
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
      pageSize: 500,
    }),
  });
  const lj = await logRes.json();
  if (lj.error) console.error("LOG", lj.error.code, lj.error.message);
  const entries = (lj.entries || []).map((e) => ({
    t: e.timestamp,
    m: e.textPayload || e.jsonPayload?.message || JSON.stringify(e.jsonPayload || {}).slice(0, 280),
  }));
  const mine = entries.filter((e) => String(e.m).includes(jobId) || String(e.m).includes(jobId.slice(0, 8)) || /chunk=\d/.test(e.m));
  console.log("\n=== log satır", entries.length, "job-ish", mine.length, "===");
  for (const e of mine.reverse()) {
    console.log(e.t.slice(11, 19), String(e.m).replace(/\n/g, " | ").slice(0, 340));
  }
  fs.writeFileSync(path.join(process.env.TEMP, "latest-live-logs.json"), JSON.stringify({ job: latest, entries }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
