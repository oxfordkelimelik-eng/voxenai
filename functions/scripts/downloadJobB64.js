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

async function downloadGs(access, gsUrl, dest) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUrl);
  const url =
    "https://storage.googleapis.com/storage/v1/b/" +
    m[1] +
    "/o/" +
    encodeURIComponent(m[2]) +
    "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) throw new Error(r.status + " " + gsUrl);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log("ok", path.basename(dest));
}

(async () => {
  const access = await getAccessToken();
  const job = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "job-b64a.json"), "utf8"));
  const out = path.join(process.env.TEMP, "job-b64a-frames");
  fs.mkdirSync(out, { recursive: true });
  for (const x of job.rejectedFrames || []) {
    const name = (x.gsUrl || "").split("/").pop();
    await downloadGs(access, x.gsUrl, path.join(out, "REJ_" + name));
  }
  for (const u of job.results.elegance.photoUrls) {
    const name = u.split("/").pop();
    await downloadGs(access, u, path.join(out, "OK_" + name));
  }
  console.log("dir", out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
