// Yüz netliği worker iş parçacığı (bkz. faceRestore.js). Tek oturum, mesajlar sırayla.
const { parentPort } = require("worker_threads");
const { restoreNative, warm } = require("./faceRestoreCore");

let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  chain = chain.then(async () => {
    const { id, modelPath, input } = msg;
    try {
      if (msg.warm) {
        await warm(modelPath);
        parentPort.postMessage({ id, ok: true });
        return;
      }
      const output = await restoreNative(modelPath, input);
      parentPort.postMessage({ id, ok: true, output }, [output.buffer]);
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
  });
});
