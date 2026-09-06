/**
 * Üretimdeki KAPI ÖLÇÜM loglarını Cloud Logging'den çeker ve dağılımı özetler.
 * Eşikler (yaw sapması, kafa büyümesi, dx, ten oranı) ancak gerçek dağılım
 * görülerek kalibre edilebilir — dosyadaki kapıların hepsi bu usulle ayarlandı.
 *
 * Kullanım: node scripts/fetchGateLogs.js [gün=14]
 */
const fs = require("fs");
const path = require("path");

async function getAccess() {
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
        client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
        client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
        refresh_token: cfg.tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    })
  ).json();
  if (!tok.access_token) throw new Error(JSON.stringify(tok).slice(0, 300));
  return tok.access_token;
}

(async () => {
  const days = Number(process.argv[2] || 14);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const access = await getAccess();

  const needles = ["YAW ÖLÇÜM", "KALITE ÖLÇÜM", "KONUM KAPISI", "TEN ÖLÇÜM", "VISION ÖLÇÜM"];
  const filter =
    needles.map((n) => `textPayload:"${n}"`).join(" OR ") +
    ` , timestamp>="${since}"`;

  const entries = [];
  let pageToken;
  do {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "content-type": "application/json",
        // Kota, CLI'nin OAuth istemci projesine değil BİZİM projemize yazılsın
        // (aksi hâlde paylaşılan istemci kotasında 429 alınıyor).
        "x-goog-user-project": "rise-up-9235f",
      },
      body: JSON.stringify({
        resourceNames: ["projects/rise-up-9235f"],
        filter: `(${needles.map((n) => `textPayload:"${n}"`).join(" OR ")}) AND timestamp>="${since}"`,
        orderBy: "timestamp desc",
        pageSize: 1000,
        pageToken,
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${j.error.code} ${j.error.message}`.slice(0, 300));
    for (const e of j.entries || []) {
      if (e.textPayload) entries.push({ t: e.timestamp, m: e.textPayload });
    }
    pageToken = j.nextPageToken;
  } while (pageToken && entries.length < 6000);

  const out = path.join(process.env.TEMP, "gate-logs.json");
  fs.writeFileSync(out, JSON.stringify(entries, null, 1));
  console.log(`toplam satır: ${entries.length} (filtre: son ${days} gün) -> ${out}`);
  console.log(`(kullanılmayan yardımcı filtre dizesi: ${filter.slice(0, 0)})`);

  const nums = (re) => entries
    .map((e) => { const m = re.exec(e.m); return m ? Number(m[1]) : null; })
    .filter((v) => v != null && Number.isFinite(v));

  const stat = (label, arr) => {
    if (arr.length === 0) { console.log(`${label}: veri yok`); return; }
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    console.log(
      `${label}: n=${s.length} min=${s[0].toFixed(2)} p50=${q(0.5).toFixed(2)} ` +
      `p90=${q(0.9).toFixed(2)} p95=${q(0.95).toFixed(2)} max=${s[s.length - 1].toFixed(2)}`
    );
  };

  console.log("\n--- DAĞILIMLAR ---");
  stat("yaw sapma (mutlak)", nums(/sapma=([+-]?[\d.]+)/).map(Math.abs));
  stat("kafa büyümesi", nums(/büyüme=([\d.]+)/));
  stat("kafa dx (mutlak)", nums(/dx=([+-]?[\d.]+)/).map(Math.abs));
  stat("ten yüzeGöreOran", nums(/yüzeGöreOran=([\d.]+)/));
  stat("ten eskiTonOranı", nums(/eskiTonOranı=([\d.]+)/));

  const count = (re) => entries.filter((e) => re.test(e.m)).length;
  console.log("\n--- VISION SINIFLARI ---");
  console.log(`HEAD_LARGE: ${count(/HEAD_LARGE/)}  HEAD_NORMAL: ${count(/HEAD_NORMAL/)}  NO_SHOULDERS: ${count(/NO_SHOULDERS/)}`);
  console.log(`WRONG_DIRECTION: ${count(/WRONG_DIRECTION/)}  GAZE NATURAL: ${count(/GAZE_DIRECTION: NATURAL/)}`);
  console.log(`HANDS_OR_ARMS_MISMATCH: ${count(/HANDS_OR_ARMS_MISMATCH/)}  SKIN CONSISTENT: ${count(/SKIN_TONE: CONSISTENT/)}`);
  console.log(`WRONG_FOR_SCENE: ${count(/WRONG_FOR_SCENE/)}`);
})().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
