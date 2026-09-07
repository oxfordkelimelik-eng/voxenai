const fs = require("fs");
const path = require("path");

const entries = JSON.parse(
  fs.readFileSync(path.join(process.env.TEMP, "recent-gate-logs.json"), "utf8")
);

const since = "2026-09-06T17:20:00Z"; // deploy sonrası
const recent = entries.filter((e) => e.t >= since);
console.log("deploy sonrası satır:", recent.length, "/", entries.length);

const groups = {};
for (const e of recent) {
  const m = e.m || "";
  let key = "DIGER";
  if (m.startsWith("HAZIRLIK")) key = "HAZIRLIK";
  else if (m.startsWith("GÖZLÜK") || m.startsWith("GOZLUK")) key = "GOZLUK";
  else if (m.startsWith("YAW")) key = "YAW";
  else if (m.startsWith("TEN")) key = "TEN";
  else if (m.startsWith("KALITE")) key = "KALITE";
  else if (m.startsWith("KONUM")) key = "KONUM";
  else if (m.startsWith("GÖZ ÖLÇÜM") || m.startsWith("GOZ")) key = "GOZ";
  else if (m.startsWith("EL NETLİK") || m.startsWith("EL NETLIK")) key = "EL";
  else if (m.includes("VISION ÖLÇÜM (style=")) key = "VISION_KARAR";
  else if (m.includes("VISION ÖLÇÜM (kafa açıklığı)")) key = "VISION_SPAN";
  else if (m.includes("VISION ÖLÇÜM (bakış)")) key = "VISION_GAZE";
  else if (m.includes("VISION ÖLÇÜM (ten")) key = "VISION_SKIN";
  else if (m.includes("VISION ÖLÇÜM (gövde")) key = "VISION_GHOST";
  else if (m.includes("VISION ÖLÇÜM (boyun")) key = "VISION_NECK";
  else if (m.includes("VISION ÖLÇÜM")) key = "VISION_DIGER";
  else if (m.includes("RED[") || m.includes("redded")) key = "RED_DIGER";
  (groups[key] ||= []).push(e);
}

console.log("\n--- grup sayıları ---");
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
  console.log(k, v.length);
}

function dump(key, n = 40) {
  console.log("\n========", key, "========");
  for (const e of (groups[key] || []).slice(0, n)) {
    console.log(e.t.slice(11, 19), (e.m || "").replace(/\n/g, " | ").slice(0, 260));
  }
}

for (const k of [
  "HAZIRLIK",
  "GOZLUK",
  "KALITE",
  "YAW",
  "TEN",
  "KONUM",
  "GOZ",
  "VISION_KARAR",
  "VISION_SPAN",
  "VISION_GAZE",
  "VISION_SKIN",
  "VISION_GHOST",
  "RED_DIGER",
]) {
  dump(k, 50);
}
