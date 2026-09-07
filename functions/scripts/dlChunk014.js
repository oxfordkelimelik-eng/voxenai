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
  const out = path.join(process.env.TEMP, "job-2286-frames");
  const prefix =
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/2286ab05-4df1-4951-9bc1-2c240fb19f35/";
  for (const name of ["elegance_1_0.jpg", "elegance_4_0.jpg"]) {
    const url =
      "https://storage.googleapis.com/storage/v1/b/rise-up-9235f.firebasestorage.app/o/" +
      encodeURIComponent(prefix + name) +
      "?alt=media";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
    if (!r.ok) throw new Error(r.status + " " + name);
    const dest = path.join(out, "OK_" + name);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    console.log("ok", dest, fs.statSync(dest).size);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
