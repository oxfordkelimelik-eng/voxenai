const fs = require("fs");
const path = require("path");
const entries = JSON.parse(
  fs.readFileSync(path.join(process.env.TEMP, "recent-gate-logs.json"), "utf8")
);
const recent = entries.filter((e) => e.t >= "2026-09-06T17:20:00Z");
const keep = recent.filter((e) => {
  const m = e.m || "";
  return (
    m.includes("hakem") ||
    m.includes("HAKEM") ||
    m.includes("override") ||
    m.includes("BODY") ||
    m.includes("gövde") ||
    m.includes("KONUM") ||
    m.includes("GÖZ") ||
    m.includes("EL NET") ||
    m.includes("RED[") ||
    m.includes("chunk") && (m.includes("başar") || m.includes("yeniden") || m.includes("retry") || m.includes("KABUL") || m.includes("TESLIM") || m.includes("teslim")) ||
    !m.startsWith("VISION") && !m.startsWith("YAW") && !m.startsWith("TEN") && !m.startsWith("KALITE")
  );
});
for (const e of recent) {
  const m = e.m || "";
  if (
    m.includes("BODY") ||
    m.includes("gövde") ||
    m.includes("INTEGRITY") ||
    m.includes("hakem") ||
    m.includes("HAKEM") ||
    m.includes("sayısal") ||
    m.includes("yüzeGöre") && m.includes("RED") ||
    m.startsWith("DIGER")
  ) {
    console.log(e.t.slice(11, 19), m.replace(/\n/g, " | ").slice(0, 300));
  }
}
console.log("\n--- tum unique prefix ---");
const pref = {};
for (const e of recent) {
  const line = (e.m || "").split("\n")[0];
  const p = line.slice(0, 40);
  pref[p] = (pref[p] || 0) + 1;
}
console.log(Object.entries(pref).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + "  " + k).join("\n"));
