/**
 * Son işi (10 teslim + 7 eleme beklenen) indirir ve kapı loglarını döker.
 */
const fs = require("fs");
const path = require("path");

const UIDS = [
  "rkD6rZ95eSOACJCF0ZMpck90vG83",
  "Fn1vb6XRPxOXtv9wgObKA8uRhtg1",
  "j2CZLA8rxkdJCo2Z0WbP4UCUx642",
];

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

function shortName(n) {
  return String(n || "").split("/").pop();
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
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log("ok", path.basename(dest), fs.statSync(dest).size);
}

async function listLogs(access, filter, pages = 4) {
  const out = [];
  let pageToken;
  for (let i = 0; i < pages; i++) {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
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
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.code + " " + j.error.message);
    for (const e of j.entries || []) {
      out.push({
        t: e.timestamp,
        m: e.textPayload || e.jsonPayload?.message || "",
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out.reverse();
}

(async () => {
  const access = await getAccessToken();
  const jobs = [];
  for (const uid of UIDS) {
    const url =
      "https://firestore.googleapis.com/v1/projects/rise-up-9235f/databases/(default)/documents/users/" +
      uid +
      "/private/genData/genJobs?pageSize=8&orderBy=updatedAt%20desc";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + access } });
    const j = await r.json();
    if (j.error) {
      console.log("genJobs err", uid.slice(0, 8), j.error.message);
      continue;
    }
    for (const doc of j.documents || []) {
      const data = {};
      for (const [k, v] of Object.entries(doc.fields || {})) data[k] = decode(v);
      jobs.push({ uid, id: doc.name.split("/").pop(), data });
    }
  }
  jobs.sort((a, b) => String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || "")));

  console.log("=== son işler ===");
  for (const j of jobs.slice(0, 12)) {
    const d = j.data;
    let photos = Array.isArray(d.imageUrls) ? d.imageUrls.length : 0;
    if (!photos && d.results) {
      photos = Object.values(d.results).reduce(
        (n, r) => n + ((r && r.photoUrls && r.photoUrls.length) || 0),
        0
      );
    }
    const rej = Array.isArray(d.rejectedFrames) ? d.rejectedFrames.length : 0;
    console.log(
      j.id.slice(0, 8),
      d.status,
      "photos=" + photos,
      "rej=" + rej,
      "updated=" + d.updatedAt,
      "uid=" + j.uid
    );
    if (rej) {
      console.log(
        "  rej:",
        d.rejectedFrames
          .map((x) => `${x.gate || "?"}@c${x.chunkIdx}a${x.attempt}`)
          .join(" ; ")
      );
    }
  }

  const latest =
    jobs.find((j) => {
      const d = j.data;
      const photos = Object.values(d.results || {}).reduce(
        (n, r) => n + ((r && r.photoUrls && r.photoUrls.length) || 0),
        0
      );
      const rej = (d.rejectedFrames || []).length;
      return photos === 10 && rej === 7;
    }) || jobs[0];

  const outDir = path.join(process.env.TEMP, "job-latest-review");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "job.json"), JSON.stringify(latest, null, 2));
  console.log("\nSEÇİLEN", latest.id, "uid=" + latest.uid, "->", outDir);

  const d = latest.data;
  const styleId = (d.styles && d.styles[0]) || Object.keys(d.results || {})[0] || "elegance";
  const accepted = (d.results && d.results[styleId] && d.results[styleId].photoUrls) || [];
  console.log("stil", styleId, "teslim", accepted.length, "şablonlar:");
  for (const [i, n] of (d.templateNames || []).entries()) {
    console.log("  c" + i, shortName(n));
  }

  for (const i of [0, 1, 2, 7, 3, 4, 5, 6, 8, 9]) {
    if (!accepted[i]) continue;
    await downloadGs(access, accepted[i], path.join(outDir, `OK_chunk${i}.jpg`));
  }
  for (const x of d.rejectedFrames || []) {
    const gs = x.gsUrl || (x.path ? `gs://rise-up-9235f.firebasestorage.app/${x.path}` : null);
    if (!gs) continue;
    const name = `REJ_c${x.chunkIdx}a${x.attempt}_${x.gate || "x"}.jpg`;
    try {
      await downloadGs(access, gs, path.join(outDir, name));
    } catch (e) {
      console.log("indirilemedi", name, e.message);
    }
  }

  const entries = await listLogs(
    access,
    `timestamp>="2026-09-06T18:00:00Z" AND (` +
      [
        `textPayload:"${latest.id}"`,
        `textPayload:"${latest.id.slice(0, 8)}"`,
        'textPayload:"KALITE ÖLÇÜM"',
        'textPayload:"YAW ÖLÇÜM"',
        'textPayload:"VISION ÖLÇÜM"',
        'textPayload:"TEN ÖLÇÜM"',
        'textPayload:"GÖZ ÖLÇÜM"',
        'textPayload:"KONUM KAPISI"',
        'textPayload:"UZUV"',
        'textPayload:"REDDEDİLEN KARE"',
        'textPayload:"FACE_EXPOSURE"',
        'textPayload:"GAZE"',
        'textPayload:"HEAD_VS_BODY"',
        'textPayload:"ŞABLON HAVUZU"',
      ].join(" OR ") +
      ")"
  );
  const relevant = entries.filter(
    (e) =>
      e.m.includes(latest.id) ||
      e.m.includes(latest.id.slice(0, 8)) ||
      /chunk=\d/.test(e.m) ||
      e.m.startsWith("VISION ÖLÇÜM") ||
      e.m.startsWith("REDDEDİLEN")
  );
  console.log("\n=== KAPILAR ===");
  for (const e of relevant) {
    console.log(e.t.slice(11, 19), String(e.m).replace(/\n/g, " | ").slice(0, 340));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
