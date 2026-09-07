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

(async () => {
  const access = await getAccessToken();
  const job = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "job-b64a.json"), "utf8"));
  const name = job.templateNames[3];
  const gs = "gs://rise-up-9235f.firebasestorage.app/" + name;
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gs);
  const url =
    "https://storage.googleapis.com/storage/v1/b/" +
    m[1] +
    "/o/" +
    encodeURIComponent(m[2]) +
    "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) {
    console.log("fail", r.status, name);
    const listUrl =
      "https://storage.googleapis.com/storage/v1/b/rise-up-9235f.firebasestorage.app/o?prefix=" +
      encodeURIComponent("dating_templates/short/Coffee");
    const l = await fetch(listUrl, { headers: { Authorization: "Bearer " + access } });
    const j = await l.json();
    console.log((j.items || []).map((i) => i.name).join("\n"));
    return;
  }
  const dest = path.join(process.env.TEMP, "job-b64a-frames", "TPL_chunk3_coffee.jpg");
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log("ok", dest, "bytes", fs.statSync(dest).size);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
