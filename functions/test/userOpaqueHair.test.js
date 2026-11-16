// Kullanıcının opak saçı korunur (2026-11-12, 41589067 c4; bkz. ghostClean USER_OPAQUE).
const test = require("node:test");
const assert = require("node:assert");
const { userOpaqueHair, USER_OPAQUE } = require("../ghostClean")._testables;
const { distanceTo } = require("../headWarp")._testables;

// 100×100 kesit, yüz eni 50. Opak kafa (keep): (50,55) merkezli r=20 disk, saç rengi U=20.
// Kafanın solunda r 20-26 arası koyu bukle bandı (opak, U rengi) ve dışında r 26-28 yarı
// saydam bukle ucu (α=0.5 kullanıcı saçı + zemin). Zemin açık (gök, 200) ya da koyu (30).
function scene({ bgL = 200, curl = 20, tip = true } = {}) {
  const n = 100, fwk = 50;
  const seed = new Uint8Array(n * n), Th = new Uint8Array(n * n).fill(1);
  const oC = new Float32Array(n * n * 3).fill(bgL);
  const bg = { ok: new Uint8Array(n * n).fill(1), v: new Float32Array(n * n * 3).fill(bgL) };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - 50, y - 55), i = y * n + x;
    if (d <= 20) { seed[i] = 1; oC.fill(20, i * 3, i * 3 + 3); }
    else if (x < 50 && d <= 26) oC.fill(curl, i * 3, i * 3 + 3);
    else if (tip && x < 50 && d <= 28) oC.fill(0.5 * 20 + 0.5 * bgL, i * 3, i * 3 + 3);
  }
  return { seed, O: null, Th, n, fwk, oC, oF: oC, bg, U: [20, 20, 20], distanceTo };
}
const at = (m, x, y) => m[y * 100 + x];

test("userOpaqueHair: açık zeminde kafaya bağlı koyu bukle ve yarı saydam ucu korunur", () => {
  const m = userOpaqueHair(scene());
  assert.strictEqual(at(m, 27, 55), 1); // opak bukle bandı (d≈23)
  assert.strictEqual(at(m, 23, 55), 1); // yarı saydam uç (d≈27)
  assert.strictEqual(at(m, 10, 55), 0); // uzak gök
  assert.strictEqual(at(m, 80, 55), 0); // sağda bukle yok
});

test("userOpaqueHair: koyu zeminde (saç ≈ zemin, opaklık ölçülemez) koruma yok", () => {
  const m = userOpaqueHair(scene({ bgL: 30 }));
  assert.strictEqual(m.reduce((s, v) => s + v, 0), 0);
});

test("userOpaqueHair: kullanıcı renginden uzak (açık, şablon rengi) bant korunmaz", () => {
  const m = userOpaqueHair(scene({ curl: 120, tip: false }));
  assert.strictEqual(at(m, 27, 55), 0);
});

test("userOpaqueHair: kafaya bağlı değilse (tohum yok) korunmaz", () => {
  const s = scene(); s.seed.fill(0);
  assert.strictEqual(userOpaqueHair(s).reduce((a, v) => a + v, 0), 0);
});

test("USER_OPAQUE varsayılanı açık", () => {
  assert.strictEqual(USER_OPAQUE.ON, true);
});
