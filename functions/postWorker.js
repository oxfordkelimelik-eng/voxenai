// Ağır son katman worker'ı (bkz. postTasks.js, postPool.js). Her mesaj bir
// görev: { id, name, payload } → { id, ok, result | error }.
const { parentPort } = require("worker_threads");
const tasks = require("./postTasks");

parentPort.on("message", async ({ id, name, payload }) => {
  try {
    if (typeof tasks[name] !== "function" || name === "toBuf") throw new Error(`bilinmeyen görev: ${name}`);
    const result = await tasks[name](payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.stack) || String(e) });
  }
});
