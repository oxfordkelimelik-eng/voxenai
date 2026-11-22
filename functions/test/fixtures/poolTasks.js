// postPool testi için sahte görevler (bkz. test/postPool.test.js).
module.exports = {
  echo: async ({ v }) => {
    console.log(`echo ${v}`);
    return { v };
  },
  sleep: async ({ ms, v }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { v };
  },
  // Senkron sonsuz döngü: worker olay döngüsü hiç dönmez (asılı katman benzetimi).
  spin: async () => {
    console.log("spin başladı");
    for (;;) { /* asılı */ }
  },
  simpleFinish: async ({ ms, v }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { v };
  },
};
