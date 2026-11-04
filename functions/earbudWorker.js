// Kulaklık tespit worker iş parçacığı (bkz. earbuds.js). Tek oturum, mesajlar sırayla.
const { parentPort } = require("worker_threads");
const { detectNative, warm } = require("./earbudCore");

let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  chain = chain.then(async () => {
    const { id, modelPath, rgb } = msg;
    try {
      if (msg.warm) {
        await warm(modelPath);
        parentPort.postMessage({ id, ok: true });
        return;
      }
      const boxes = await detectNative(modelPath, rgb);
      parentPort.postMessage({ id, ok: true, boxes });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
  });
});
