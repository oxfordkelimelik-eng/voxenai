// LaMa worker iş parçacığı (bkz. lamaFill.js). Tek oturum, mesajlar sırayla.
const { parentPort } = require("worker_threads");
const { fillNative, warm } = require("./lamaCore");

let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  chain = chain.then(async () => {
    const { id, modelPath, rgb, w, h, mask } = msg;
    try {
      if (msg.warm) {
        await warm(modelPath);
        parentPort.postMessage({ id, ok: true });
        return;
      }
      const runs = await fillNative(modelPath, rgb, w, h, mask);
      parentPort.postMessage({ id, ok: true, rgb, runs }, [rgb.buffer]);
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
  });
});
