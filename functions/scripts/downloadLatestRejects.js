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

async function downloadGs(access, objectName, dest) {
  const url =
    "https://storage.googleapis.com/storage/v1/b/rise-up-9235f.firebasestorage.app/o/" +
    encodeURIComponent(objectName) +
    "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) throw new Error(r.status + " " + objectName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log("ok", path.basename(dest), fs.statSync(dest).size);
}

(async () => {
  const access = await getAccessToken();
  const job = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "latest-live-job.json"), "utf8"));
  const out = path.join(process.env.TEMP, "job-2286-frames");
  for (const x of job.data.rejectedFrames || []) {
    const name = (x.gsUrl || "").replace(/^gs:\/\/[^/]+\//, "");
    await downloadGs(access, name, path.join(out, "REJ_" + path.basename(name)));
  }
  const urls = job.data.results.elegance.photoUrls;
  for (const idx of [0, 3, 7, 8]) {
    const u = urls[idx];
    const name = u.replace(/^gs:\/\/[^/]+\//, "");
    await downloadGs(access, name, path.join(out, "OK_chunk" + idx + ".jpg"));
  }

  const logRes = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + access,
      "content-type": "application/json",
      "x-goog-user-project": "rise-up-9235f",
    },
    body: JSON.stringify({
      resourceNames: ["projects/rise-up-9235f"],
      filter:
        'timestamp>="2026-09-06T19:54:00Z" AND timestamp<="2026-09-06T20:01:00Z" AND (' +
        'textPayload:"HAZIRLIK REFERANS" OR textPayload:"ŞABLON HAVUZU" OR textPayload:"HEAD_VS_BODY" OR textPayload:"BODY_INTEGRITY" OR textPayload:"yüz kutusu" OR textPayload:"VISION TEN" OR textPayload:"VISION KAFA"' +
        ")",
      orderBy: "timestamp desc",
      pageSize: 200,
    }),
  });
  const lj = await logRes.json();
  if (lj.error) console.error(lj.error);
  for (const e of (lj.entries || []).reverse()) {
    const m = e.textPayload || e.jsonPayload?.message || "";
    console.log(e.timestamp.slice(11, 19), String(m).replace(/\n/g, " | ").slice(0, 280));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
