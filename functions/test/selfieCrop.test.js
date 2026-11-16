// Selfie kafa kırpımı (2026-11-08, bkz. selfieCrop.js, falPhotos SELFIE_HEAD_CROP).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { headComponent, planHeadCrop, HEAD_CROP } = require("../selfieCrop")._testables;

const face = { x0: 400, x1: 600, y0: 400, y1: 650, browY: 420, chinY: 650 }; // yüz eni 200

test("planHeadCrop: kafa + saç içeride kalır, gövde kırpılır", () => {
  const head = { x0: 380, x1: 620, y0: 250, y1: 660 };
  const r = planHeadCrop({ W: 1000, H: 1600, face, head });
  assert.ok(r.box, r.reason);
  const b = r.box;
  assert.ok(b.left <= head.x0 && b.left + b.width >= head.x1, "yanlarda saç kesildi");
  assert.ok(b.top <= head.y0 && b.top <= face.browY - HEAD_CROP.ABOVE_BROW * 200, "tepe kesildi");
  assert.ok(b.top + b.height >= face.chinY, "çene kesildi");
  assert.ok(b.top + b.height < 1000, "gövde kırpılmadı");
});

test("planHeadCrop: uzun saç omza iniyorsa kırpım da iner (saç kesilmez)", () => {
  const head = { x0: 330, x1: 670, y0: 250, y1: 1100 };
  const r = planHeadCrop({ W: 1000, H: 1600, face, head });
  assert.ok(r.box.top + r.box.height >= 1100);
});

test("planHeadCrop: bölütleme saçı kaçırsa da kaşın üstünde pay kalır; kazanç yoksa dokunulmaz; küçük yüz atlanır", () => {
  const r = planHeadCrop({ W: 1000, H: 1600, face, head: null });
  assert.ok(r.box.top <= face.browY - HEAD_CROP.ABOVE_BROW * 200);
  const tight = { x0: 100, x1: 300, y0: 150, y1: 400, browY: 170, chinY: 400 };
  assert.strictEqual(planHeadCrop({ W: 380, H: 480, face: tight, head: null }).reason, "zaten-sıkı");
  assert.strictEqual(planHeadCrop({ W: 1000, H: 1600, face: { ...face, x1: 440 }, head: null }).reason, "yüz-küçük");
});

test("headComponent: yalnız yüz kutusuna bağlı bileşen alınır", () => {
  const w = 50, h = 50, m = new Uint8Array(w * h);
  for (let y = 10; y < 30; y++) for (let x = 15; x < 35; x++) m[y * w + x] = 1; // kafa
  for (let y = 40; y < 45; y++) for (let x = 0; x < 5; x++) m[y * w + x] = 1; // kopuk leke
  const c = headComponent(m, w, h, { x0: 20, y0: 15, x1: 30, y1: 25 });
  assert.deepStrictEqual([c.x0, c.y0, c.x1, c.y1], [15, 10, 35, 30]);
  assert.strictEqual(headComponent(new Uint8Array(w * h), w, h, { x0: 20, y0: 15, x1: 30, y1: 25 }), null);
});

test("falPhotos: kafa kırpımı ilk selfie çevrildikten sonra, log satırından önce", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /const SELFIE_HEAD_CROP = (true|false);/);
  const rep = src.indexOf('runPostTask("reposeSelfie", { buf: out[0]');
  const crop = src.indexOf("headCropOf(b)");
  const log = src.indexOf("kafaKırpım=${cropDesc}");
  assert.ok(rep > 0 && crop > rep && log > crop);
  assert.strictEqual(typeof require("../postTasks").cropSelfieHead, "function");
});
