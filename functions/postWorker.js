// Ağır son katman worker'ı (bkz. postTasks.js, postPool.js). Her mesaj bir
// görev: { id, name, payload } → { id, ok, result | error }.
const { parentPort } = require("worker_threads");
const util = require("util");
// POST_WORKER_TASKS yalnız testler için (bkz. test/postPool.test.js).
const tasks = require(process.env.POST_WORKER_TASKS || "./postTasks");

// LOGLAR ANA İŞ PARÇACIĞINDAN YAZILIR (2026-10-16, c29a2b31): worker'ın
// stdout'u Cloud Logging'e ikili çöple karışık ve 5-6 kez tekrarlı ulaştı;
// YÜZ IŞIĞI satırı 8 karenin yalnız 1'inde okunabildi. Satırlar havuza
// gönderilir, havuz onları ana iş parçacığında yazar.
// SATIR SATIR (2026-11-18, 156fa173 c0): eskiden satırlar görev bitince
// topluca gidiyordu; asılan görevin hangi adımda kaldığı hiç görünmedi.
// Artık her satır anında { partial: true } mesajıyla gider.
let currentId = null;
const capture = (level) => (...args) => {
  const line = util.format(...args);
  try {
    parentPort.postMessage({ id: currentId, partial: true, logs: [[level, line]] });
  } catch { /* log kaybı görevi durdurmaz */ }
};
console.log = capture("log");
console.info = capture("log");
console.warn = capture("warn");
console.error = capture("error");

parentPort.on("message", async ({ id, name, payload }) => {
  currentId = id;
  try {
    if (typeof tasks[name] !== "function" || name === "toBuf") throw new Error(`bilinmeyen görev: ${name}`);
    const result = await tasks[name](payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.stack) || String(e) });
  }
});
