// Geri yerleştirme dikiş kapısı (2026-11-15, bkz. postProcess.SEAM_GATE_ON).
const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { recompositeIntoOriginal, _testables: { seamMismatch, SEAM_LOST_MAX, SEAM_MIN_BLOCKS } } = require("../postProcess");

// Dokulu, tekrarsız sahne: 4×4 hücrelik tamsayı karma gürültüsü (periyodik değil, blok
// kaydırınca kendine benzemez; 3 px kayma arama penceresinde bulunur).
function scene(W, H, seed = 7) {
  const g = new Uint8Array(W * H);
  const h = (a, b) => { let v = (a * 374761393 + b * 668265263 + seed * 2147483647) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) % 200; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = 28 + h(x >> 2, y >> 2);
  return g;
}
const sub = (g, W, L, T, w, h, dx = 0, dy = 0) => {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = g[(T + y + dy) * W + L + x + dx];
  return o;
};

test("seamMismatch: aynı sahne tutar, küçük kayma tutar, büyük kayma tutmaz", () => {
  const BW = 600, BH = 700, L = 110, T = 120, PW = 380, PH = 460, fp = 0.06 * PW;
  const base = scene(BW, BH);
  const same = seamMismatch(sub(base, BW, L, T, PW, PH), PW, PH, base, BW, BH, L, T, fp);
  assert.ok(same.n >= SEAM_MIN_BLOCKS, `blok ${same.n}`);
  assert.strictEqual(same.lost, 0);
  // 3 px kayma (dalga/doku gibi): arama penceresinde bulunur → sayılmaz.
  const small = seamMismatch(sub(base, BW, L, T, PW, PH, 3, -2), PW, PH, base, BW, BH, L, T, fp);
  assert.ok(small.frac <= 0.02, `küçük kayma ${small.frac}`);
  // 40 px kayma (c9: ayakkabı/koltuk): kaybolur → kapı tutmaz.
  const big = seamMismatch(sub(base, BW, L, T, PW, PH, 40, 30), PW, PH, base, BW, BH, L, T, fp);
  assert.ok(big.frac > SEAM_LOST_MAX, `büyük kayma ${big.frac}`);
});

test("recompositeIntoOriginal: dikiş tutmazsa null (kırpılmış teslim), tutarsa geri yerleştirir; kapı kapatılabilir", async () => {
  const BW = 600, BH = 700, geo = { left: 110, top: 120, cropW: 380, cropH: 460, imgW: BW, imgH: BH };
  const base = scene(BW, BH, 11);
  const png = (g, w, h) => sharp(Buffer.from(g), { raw: { width: w, height: h, channels: 1 } }).toColourspace("srgb").png().toBuffer();
  const orig = await png(base, BW, BH);
  const good = await png(sub(base, BW, geo.left, geo.top, geo.cropW, geo.cropH), geo.cropW, geo.cropH);
  const bad = await png(sub(base, BW, geo.left, geo.top, geo.cropW, geo.cropH, 40, 30), geo.cropW, geo.cropH);
  const ok = await recompositeIntoOriginal(good, orig, geo);
  assert.ok(Buffer.isBuffer(ok));
  assert.strictEqual(await recompositeIntoOriginal(bad, orig, geo), null);
  assert.ok(Buffer.isBuffer(await recompositeIntoOriginal(bad, orig, geo, { seamGate: false })));
});
