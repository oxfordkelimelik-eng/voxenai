/**
 * EL NETLİK / TEN / KROMA ölçümlerinin GERÇEK dağılımını çıkarır.
 * Amaç: bağlayıcı eşik koymadan önce "kaç kare hangi bantta" sorusunu
 * veriyle cevaplamak (dosyadaki diğer kapılarla aynı usul).
 */
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

async function listLogs(access, filter, pages = 6) {
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
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function summarize(name, values) {
  const s = values.slice().sort((a, b) => a - b);
  console.log(
    `\n${name}: n=${s.length}` +
    (s.length
      ? ` min=${s[0].toFixed(2)} p10=${pct(s, 10).toFixed(2)} p25=${pct(s, 25).toFixed(2)} ` +
        `p50=${pct(s, 50).toFixed(2)} p75=${pct(s, 75).toFixed(2)} p90=${pct(s, 90).toFixed(2)} max=${s[s.length - 1].toFixed(2)}`
      : "")
  );
  return s;
}

(async () => {
  const access = await getAccessToken();
  const since = "2026-08-25T00:00:00Z";
  const entries = await listLogs(
    access,
    `timestamp>="${since}" AND (` +
      [
        'textPayload:"EL NETLİK ÖLÇÜM"',
        'textPayload:"TEN ÖLÇÜM"',
        'textPayload:"KROMA DÜZELTME"',
      ].join(" OR ") +
      ")"
  );
  console.log("toplam satır:", entries.length);

  const limbRatios = [];
  const limbSkips = {};
  for (const e of entries) {
    if (!e.m.startsWith("EL NETLİK")) continue;
    const skip = /ATLANDI\[([^\]]+)\]/.exec(e.m);
    if (skip) {
      limbSkips[skip[1]] = (limbSkips[skip[1]] || 0) + 1;
      continue;
    }
    const r = /oran=([0-9.]+)/.exec(e.m);
    if (r) limbRatios.push(Number(r[1]));
  }
  const sortedLimb = summarize("EL NETLİK oran (yerel/kareGeneli)", limbRatios);
  console.log("EL NETLİK atlama sebepleri:", JSON.stringify(limbSkips));
  for (const th of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
    const n = sortedLimb.filter((v) => v < th).length;
    console.log(
      `  eşik oran<${th} -> ${n}/${sortedLimb.length} kare (%${((100 * n) / (sortedLimb.length || 1)).toFixed(1)})`
    );
  }

  const skinReasons = {};
  const faceVsSelfie = [];
  const skinRatios = [];
  for (const e of entries) {
    if (!e.m.startsWith("TEN ÖLÇÜM")) continue;
    const skip = /ÖLÇÜLEMEDİ\[([^\]]+)\]/.exec(e.m);
    if (skip) skinReasons[skip[1]] = (skinReasons[skip[1]] || 0) + 1;
    else if (/GEÇTİ/.test(e.m)) skinReasons.ölçüldü = (skinReasons.ölçüldü || 0) + 1;
    else if (/RED/.test(e.m)) skinReasons.red = (skinReasons.red || 0) + 1;
    const fv = /yüzSelfieFarkı=([0-9.]+)/.exec(e.m);
    if (fv) faceVsSelfie.push(Number(fv[1]));
    const rr = /yüzeGöreOran=([0-9.]+)/.exec(e.m);
    if (rr) skinRatios.push(Number(rr[1]));
  }
  console.log("\nTEN ÖLÇÜM sonuç dağılımı:", JSON.stringify(skinReasons));
  summarize("TEN yüzeGöreOran (ölçülebilenler)", skinRatios);
  summarize("TEN yüzSelfieFarkı (teşhis, Lab)", faceVsSelfie);

  const chromaReasons = {};
  const deltaBefore = [];
  for (const e of entries) {
    if (!e.m.startsWith("KROMA DÜZELTME")) continue;
    const skip = /ATLANDI\[([^\]]+)\]/.exec(e.m);
    if (skip) chromaReasons[skip[1]] = (chromaReasons[skip[1]] || 0) + 1;
    else if (/UYGULANDI/.test(e.m)) chromaReasons.uygulandı = (chromaReasons.uygulandı || 0) + 1;
    const db = /yüzUzuvFarkıÖnce=([0-9.]+)/.exec(e.m);
    if (db) deltaBefore.push(Number(db[1]));
  }
  console.log("\nKROMA DÜZELTME dağılımı:", JSON.stringify(chromaReasons));
  const sortedDelta = summarize("KROMA yüzUzuvFarkıÖnce (uzuv↔yüz renklilik)", deltaBefore);
  for (const th of [4, 5, 6, 7, 8, 10]) {
    const n = sortedDelta.filter((v) => v > th).length;
    console.log(
      `  eşik fark>${th} -> ${n}/${sortedDelta.length} kare (%${((100 * n) / (sortedDelta.length || 1)).toFixed(1)})`
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
