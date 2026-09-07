const fs = require("fs");
const path = require("path");

function decode(v) {
  if (v == null) return null;
  if (v.stringValue != null) return v.stringValue;
  if (v.booleanValue != null) return v.booleanValue;
  if (v.integerValue != null) return Number(v.integerValue);
  if (v.doubleValue != null) return v.doubleValue;
  if (v.timestampValue != null) return v.timestampValue;
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
  const jobsUrl =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs?pageSize=40&orderBy=createdAt%20desc";
  const jr = await fetch(jobsUrl, { headers: { Authorization: "Bearer " + access } });
  const jj = await jr.json();
  const jobs = (jj.documents || []).map((doc) => {
    const d = {};
    for (const [k, v] of Object.entries(doc.fields || {})) d[k] = decode(v);
    return { id: doc.name.split("/").pop(), data: d };
  });
  const recentNames = [];
  for (const j of jobs.slice(1)) {
    if (Array.isArray(j.data.templateNames)) recentNames.push(...j.data.templateNames);
  }
  let items = [];
  let pageToken = "";
  do {
    const listUrl =
      "https://storage.googleapis.com/storage/v1/b/rise-up-9235f.firebasestorage.app/o?prefix=" +
      encodeURIComponent("dating_templates/short/") +
      "&maxResults=200" +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const lr = await fetch(listUrl, { headers: { Authorization: "Bearer " + access } });
    const lj = await lr.json();
    items = items.concat(lj.items || []);
    pageToken = lj.nextPageToken || "";
  } while (pageToken);
  const files = items.filter((i) => /\.(jpe?g|png|webp)$/i.test(i.name)).map((i) => i.name);

  const recent = new Set(recentNames);
  const staleOrder = new Map(recentNames.map((n, i) => [n, i]));
  const unmatchedRecent = [...new Set(recentNames)].filter((n) => !files.includes(n));
  console.log("pool", files.length, "recent unique", new Set(recentNames).size, "unmatchedRecent", unmatchedRecent.length);
  console.log("unmatched sample:\n", unmatchedRecent.slice(0, 8).join("\n"));
  const notInRecent = files.filter((n) => !recent.has(n));
  console.log("pool files not in recent", notInRecent.length);

  const firstIdx = new Map();
  recentNames.forEach((n, i) => {
    if (!firstIdx.has(n)) firstIdx.set(n, i);
  });

  const stale = files
    .filter((n) => recent.has(n))
    .sort((a, b) => (staleOrder.get(b) ?? 0) - (staleOrder.get(a) ?? 0));

  console.log("\n--- stale first 15 (current sort = last/oldest index desc) ---");
  for (const n of stale.slice(0, 15)) {
    console.log(
      "last=" + String(staleOrder.get(n)).padStart(3),
      "first=" + String(firstIdx.get(n)).padStart(3),
      n.split("/").pop().slice(0, 70)
    );
  }

  const lru = files
    .filter((n) => recent.has(n))
    .sort((a, b) => (firstIdx.get(b) ?? 0) - (firstIdx.get(a) ?? 0));
  console.log("\n--- correct LRU first 15 (most-recent-use index desc = least recently used first) ---");
  for (const n of lru.slice(0, 15)) {
    console.log(
      "first=" + String(firstIdx.get(n)).padStart(3),
      n.split("/").pop().slice(0, 70)
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
