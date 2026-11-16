// Şapkalı şablonun teslimi (2026-11-06 inceleme): geri yerleştirmenin yumuşak kenarı
// şablonun asıl şapkasını kubbe gibi karıştırmasın (postProcess keepMask) ve model
// şapkayı tuttuysa ghostClean onu iz saymasın (keptHatMask). Şapkasız şablonda
// hiçbir şey değişmemeli.
const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { recompositeIntoOriginal } = require("../postProcess");
const { keepMaskOpaque } = require("../postProcess")._testables;
const { keptHatMask, HAT_KEPT_SHARE } = require("../ghostClean")._testables;
const { distanceTo } = require("../headWarp")._testables;

const solid = (w, h, rgb) => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
const maskPng = async (w, h, rect) => {
  const b = Buffer.alloc(w * h);
  if (rect) for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) b[y * w + x] = 255;
  return sharp(b, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
};
const geo = { left: 50, top: 40, cropW: 200, cropH: 240, imgW: 300, imgH: 320 };

test("recompositeIntoOriginal: keepMask yok / boş maske → bugünküyle bayt bayt aynı", async () => {
  const orig = await solid(300, 320, [200, 30, 30]);
  const out = await solid(400, 480, [30, 30, 200]);
  const a = await recompositeIntoOriginal(out, orig, geo);
  const b = await recompositeIntoOriginal(out, orig, geo, { scale: 1, keepMask: null });
  assert.ok(a && a.equals(b));
  const c = await recompositeIntoOriginal(out, orig, geo, { keepMask: { png: await maskPng(400, 480, null), fwFrac: 0.2 } });
  const [ra, rc] = await Promise.all([a, c].map((x) => sharp(x).raw().toBuffer()));
  assert.ok(ra.equals(rc));
});

test("recompositeIntoOriginal: şapka maskesinde yama tam opak (şablon karışmaz), maske dışı kenar aynı", async () => {
  const orig = await solid(300, 320, [200, 30, 30]);
  const out = await solid(400, 480, [30, 30, 200]);
  // Şapka kırpma kenarının 4-24 px içinde (yumuşak bant ~12 px): tam kubbe senaryosu.
  const keepMask = { png: await maskPng(400, 480, { x0: 150, y0: 10, x1: 250, y1: 60 }), fwFrac: 0.2 };
  const [a, k] = await Promise.all([
    recompositeIntoOriginal(out, orig, geo).then((x) => sharp(x).removeAlpha().raw().toBuffer()),
    recompositeIntoOriginal(out, orig, geo, { keepMask }).then((x) => sharp(x).removeAlpha().raw().toBuffer()),
  ]);
  const px = (r, x, y) => r[(y * 300 + x) * 3];
  // Maske içi (kırpma kenarına 6 px): eskiden şablon kırmızısı karışıyordu, şimdi saf yama.
  const x = 50 + 100, y = 40 + 6;
  assert.ok(px(a, x, y) > 60, `eski kırmızı=${px(a, x, y)}`);
  assert.ok(px(k, x, y) <= 32, `yeni kırmızı=${px(k, x, y)}`);
  // Maskeden uzak kenar bandı ve iç kısım değişmez.
  assert.strictEqual(px(k, 55, 200), px(a, 55, 200));
  assert.strictEqual(px(k, 150, 200), px(a, 150, 200));
});

test("keepMaskOpaque: çıktı alfası = max(yumuşak kenar, şapka); tek kanal tuzağı yok", async () => {
  const W = 120, H = 100;
  const svg = `<svg width="${W}" height="${H}"><rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="white"/></svg>`;
  const feather = await sharp(Buffer.from(svg)).blur(6).png().toBuffer();
  const km = { png: await maskPng(60, 50, { x0: 20, y0: 2, x1: 40, y1: 20 }), fwFrac: 0.3 };
  const m = await keepMaskOpaque(feather, km, W, H);
  const meta = await sharp(m).metadata();
  assert.strictEqual(meta.channels, 4);
  const fa = await sharp(feather).ensureAlpha().extractChannel(3).raw().toBuffer();
  const ma = await sharp(m).extractChannel(3).raw().toBuffer();
  for (let i = 0; i < W * H; i++) assert.ok(ma[i] >= fa[i]);
  assert.strictEqual(ma[10 * W + 60], 255); // şapka içi (ölçeklenmiş), kenar bandında
  assert.strictEqual(ma[90 * W + 5], fa[90 * W + 5]); // uzak köşe değişmez
});

// keptHatMask: 100×100 kesit, yüz eni 40, kaş y=50 (şablon ve çıktı aynı).
function hatCase({ tplHat, outOthers, eyewear = false, rim = false }) {
  const n = 100, fwk = 40;
  const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
  const Po = Array.from({ length: 6 }, () => new Float32Array(n * n));
  const pts = Array.from({ length: 68 }, () => ({ x: 50, y: 70 }));
  for (let k = 17; k < 27; k++) pts[k] = { x: 30 + (k - 17) * 4, y: 50 };
  const Ht = { hat: new Uint8Array(n * n) }, Ho = { hat: new Uint8Array(n * n), inOval: new Uint8Array(n * n) };
  // Yüz ovali: kaş altı, x 25-75 (gözlük burada).
  for (let y = 50; y < 75; y++) for (let x = 25; x < 75; x++) Ho.inOval[y * n + x] = 1;
  for (let y = tplHat[1]; y < tplHat[3]; y++) for (let x = tplHat[0]; x < tplHat[2]; x++) Ht.hat[y * n + x] = 1;
  if (outOthers) for (let y = outOthers[1]; y < outOthers[3]; y++) for (let x = outOthers[0]; x < outOthers[2]; x++) { Po[CLASSES.others][y * n + x] = 0.9; Ho.hat[y * n + x] = 1; }
  if (eyewear) for (let y = 51; y < 62; y++) for (let x = 25; x < 75; x++) { Ht.hat[y * n + x] = 1; Po[CLASSES.others][y * n + x] = 0.9; Ho.hat[y * n + x] = 1; }
  // Berenin ense kenarı: kaş altına iner, oval dışında, kaş üstü şapkaya bağlı.
  if (rim) for (let y = 40; y < 66; y++) for (let x = 76; x < 84; x++) Po[CLASSES.others][y * n + x] = 0.9;
  return keptHatMask({ Ht, Ho, Po, CLASSES, pt: pts, po: pts, n, fwk, distanceTo });
}

test("keptHatMask: model şapkayı tuttu → korunur; düşürdü → bugünkü temizlik", () => {
  const kept = hatCase({ tplHat: [25, 20, 75, 50], outOthers: [25, 28, 75, 50] }); // 22/30 satır
  assert.ok(kept.share >= HAT_KEPT_SHARE && kept.kept, `pay=${kept.share}`);
  assert.ok(kept.area >= 0.1);
  // Korunan çekirdek: şablon şapkası ∪ çıktının kaş üstü opak 'others'ı; kenar bandı dışarıda.
  assert.strictEqual(kept.core[30 * 100 + 50], 1);
  for (let i = 0; i < 100 * 100; i++) if (kept.core[i]) assert.strictEqual(kept.keep[i], 1);
  assert.strictEqual(kept.keep[5 * 100 + 50], 0);
  const dropped = hatCase({ tplHat: [25, 20, 75, 50], outOthers: [25, 45, 75, 50] });
  assert.ok(dropped.share < HAT_KEPT_SHARE && !dropped.kept && dropped.keep === null);
  const none = hatCase({ tplHat: [25, 20, 75, 50], outOthers: null });
  assert.strictEqual(none.kept, false);
});

test("keptHatMask: şapkanın kaş altına inen ense kenarı da korunur (yatay kesik yok)", () => {
  const k = hatCase({ tplHat: [25, 20, 75, 50], outOthers: [25, 28, 84, 50], rim: true });
  assert.ok(k.kept);
  for (let y = 50; y < 66; y++) assert.strictEqual(k.core[y * 100 + 80], 1, `y=${y}`);
  assert.strictEqual(k.core[70 * 100 + 80], 0);
});

test("keptHatMask: gözlük (kaş altı 'others') ne paya ne korumaya girer; küçük alan şapka değil", () => {
  const g = hatCase({ tplHat: [0, 0, 0, 0], outOthers: null, eyewear: true });
  assert.strictEqual(g.area, 0);
  assert.strictEqual(g.kept, false);
  const k = hatCase({ tplHat: [25, 20, 75, 50], outOthers: [25, 28, 75, 50], eyewear: true });
  assert.ok(k.kept);
  for (let y = 51; y < 62; y++) assert.strictEqual(k.core[y * 100 + 50], 0);
  const small = hatCase({ tplHat: [40, 44, 60, 50], outOthers: [40, 44, 60, 50] }); // 120 px = 0.075 yüz²
  assert.strictEqual(small.kept, false);
});

test("simpleFinish templateHat parametresi ghostClean'e gider (kaynak kontrolü)", () => {
  const src = require("fs").readFileSync(require.resolve("../postTasks"), "utf8");
  assert.ok(/async function simpleFinish\(\{[^}]*templateHat = false[^}]*\}\) \{/.test(src));
  assert.ok(src.includes("templateHat: !!templateHat"));
});
