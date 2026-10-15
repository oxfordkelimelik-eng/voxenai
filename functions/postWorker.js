// Ağır son katman worker'ı (bkz. postTasks.js, postPool.js). Her mesaj bir
// görev: { id, name, payload } → { id, ok, result | error, logs }.
const { parentPort } = require("worker_threads");
const util = require("util");
const tasks = require("./postTasks");

// LOGLAR ANA İŞ PARÇACIĞINDAN YAZILIR (2026-10-16, c29a2b31): worker'ın
// stdout'u Cloud Logging'e ikili çöple karışık ve 5-6 kez tekrarlı ulaştı;
// YÜZ IŞIĞI satırı 8 karenin yalnız 1'inde okunabildi. Satırlar görev
// boyunca toplanır, sonuçla birlikte gönderilir, havuz onları yazar.
const logs = [];
const capture = (level) => (...args) => { logs.push([level, util.format(...args)]); };
console.log = capture("log");
console.info = capture("log");
console.warn = capture("warn");
console.error = capture("error");

parentPort.on("message", async ({ id, name, payload }) => {
  logs.length = 0;
  try {
    if (typeof tasks[name] !== "function" || name === "toBuf") throw new Error(`bilinmeyen görev: ${name}`);
    const result = await tasks[name](payload);
    parentPort.postMessage({ id, ok: true, result, logs: logs.splice(0) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.stack) || String(e), logs: logs.splice(0) });
  }
});
