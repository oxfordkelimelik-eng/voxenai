const fs = require("fs");
const path = require("path");

function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickTemplatesFromPool(files, jobId, count, recentNames = []) {
  const recent = new Set(recentNames);
  const rand = mulberry32(seedFromString(`${jobId}:tpl`));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const fresh = shuffle(files.filter((f) => !recent.has(f.name)));
  if (fresh.length >= count) return { picked: fresh.slice(0, count), fresh: fresh.length, stale: 0 };
  const staleOrder = new Map(recentNames.map((n, i) => [n, i]));
  const stale = files
    .filter((f) => recent.has(f.name))
    .sort((a, b) => (staleOrder.get(b.name) ?? 0) - (staleOrder.get(a.name) ?? 0));
  const picked = [...fresh, ...stale].slice(0, count);
  if (picked.length === 0) return { picked: [], fresh: fresh.length, stale: stale.length };
  return {
    picked: Array.from({ length: count }, (_, i) => picked[i % picked.length]),
    fresh: fresh.length,
    stale: stale.length,
  };
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

async function downloadGs(access, objectName, dest) {
  const url =
    "https://storage.googleapis.com/storage/v1/b/rise-up-9235f.firebasestorage.app/o/" +
    encodeURIComponent(objectName) +
    "?alt=media";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  if (!r.ok) throw new Error(r.status + " " + objectName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log("dl", path.basename(dest), fs.statSync(dest).size);
}

(async () => {
  const access = await getAccessToken();
  const uid = "Fn1vb6XRPxOXtv9wgObKA8uRhtg1";
  const jobsUrl =
    "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
    uid +
    "/private/genData/genJobs?pageSize=20&orderBy=createdAt%20desc";
  const jr = await fetch(jobsUrl, { headers: { Authorization: "Bearer " + access } });
  const jj = await jr.json();
  if (jj.error) throw new Error(JSON.stringify(jj.error));
  const jobs = (jj.documents || []).map((doc) => {
    const d = {};
    for (const [k, v] of Object.entries(doc.fields || {})) d[k] = decode(v);
    return { id: doc.name.split("/").pop(), data: d };
  });
  console.log("jobs by createdAt desc:");
  for (const j of jobs) {
    const tpls = (j.data.templateNames || []).map((n) => String(n).split("/").pop().slice(0, 40));
    console.log(j.id.slice(0, 8), j.data.status, j.data.createdAt, "tpls", tpls.length, tpls.join(" || "));
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
  const files = items
    .filter((i) => /\.(jpe?g|png|webp)$/i.test(i.name))
    .map((i) => ({ name: i.name }));
  console.log("\npool short", files.length);

  const latest = jobs[0];
  const prev = jobs.slice(1);
  const recentAll = [];
  for (const j of prev) {
    if (Array.isArray(j.data.templateNames)) recentAll.push(...j.data.templateNames);
  }
  const recentInclCurrent = [];
  for (const j of jobs) {
    if (Array.isArray(j.data.templateNames)) recentInclCurrent.push(...j.data.templateNames);
  }

  const count = 60;
  const simEmpty = pickTemplatesFromPool(files, latest.id, count, []);
  const simPrev = pickTemplatesFromPool(files, latest.id, count, recentAll);
  const simIncl = pickTemplatesFromPool(files, latest.id, count, recentInclCurrent);
  const actual = latest.data.templateNames || [];

  function head(arr) {
    return arr.slice(0, 10).map((x) => (x.name || x).split("/").pop().slice(0, 50));
  }
  console.log("\nactual first10:");
  console.log(actual.map((n) => n.split("/").pop().slice(0, 50)).join("\n"));
  console.log("\nsim empty recent, overlap with actual", simEmpty.picked.slice(0, 10).filter((f) => actual.includes(f.name)).length, "fresh", simEmpty.fresh);
  console.log(head(simEmpty.picked).join("\n"));
  console.log("\nsim exclude current, overlap", simPrev.picked.slice(0, 10).filter((f) => actual.includes(f.name)).length, "fresh", simPrev.fresh, "stale", simPrev.stale);
  console.log(head(simPrev.picked).join("\n"));
  console.log("\nsim include current, overlap", simIncl.picked.slice(0, 10).filter((f) => actual.includes(f.name)).length, "fresh", simIncl.fresh, "stale", simIncl.stale);
  console.log(head(simIncl.picked).join("\n"));

  const sameAsPrev =
    JSON.stringify(actual) === JSON.stringify(jobs[1]?.data.templateNames || []);
  console.log("\nactual === previous job templates?", sameAsPrev);
  console.log("recentAll unique", new Set(recentAll).size, "len", recentAll.length);

  const out = path.join(process.env.TEMP, "job-f94c-frames");
  fs.mkdirSync(out, { recursive: true });
  await downloadGs(
    access,
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/f94c3cec-3db7-4bad-8f7f-ebe1a8c08bc4/elegance_3_0.jpg",
    path.join(out, "OK_chunk3.jpg")
  );
  await downloadGs(
    access,
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/b64a0a65-4d64-464f-81b6-cdac908b94be/elegance_3_0.jpg",
    path.join(out, "PREV_chunk3.jpg")
  );
  await downloadGs(access, actual[3], path.join(out, "TPL_chunk3.jpg"));
  await downloadGs(
    access,
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/f94c3cec-3db7-4bad-8f7f-ebe1a8c08bc4/elegance_0_0.jpg",
    path.join(out, "OK_chunk0.jpg")
  );
  await downloadGs(
    access,
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/f94c3cec-3db7-4bad-8f7f-ebe1a8c08bc4/elegance_7_0.jpg",
    path.join(out, "OK_chunk7.jpg")
  );
  await downloadGs(
    access,
    "dating_results/Fn1vb6XRPxOXtv9wgObKA8uRhtg1/f94c3cec-3db7-4bad-8f7f-ebe1a8c08bc4/elegance_8_0.jpg",
    path.join(out, "OK_chunk8.jpg")
  );
  console.log("frames", out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
