const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { alignToTemplate, warpToTemplate } = require("../align");

// Dokulu sentetik sahne: rastgele dikdörtgenler (gradyan araması için kenar gerekli).
async function scene(W = 240, H = 320, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const buf = Buffer.alloc(W * H * 3, 120);
  for (let k = 0; k < 60; k++) {
    const x0 = Math.floor(rnd() * W), y0 = Math.floor(rnd() * H), w = 5 + Math.floor(rnd() * 40), h = 5 + Math.floor(rnd() * 40);
    const col = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let y = y0; y < Math.min(H, y0 + h); y++) for (let x = x0; x < Math.min(W, x0 + w); x++) for (let c = 0; c < 3; c++) buf[(y * W + x) * 3 + c] = col[c];
  }
  return { buf, W, H };
}
const png = (b, W, H) => sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();

test("hizalama: bilinen kayma+ölçek geri bulunur (model tuvali kaydırdıysa)", async () => {
  const { buf, W, H } = await scene();
  const T = { s: 1.04, tx: 8, ty: -6 };
  // çıktı = şablonun dönüştürülmüş hâli: şablon(q) = çıktı(p), q = c + s(p−c) + t
  const shifted = warpToTemplate(buf, buf, W, H, { s: 1 / T.s, tx: -T.tx / T.s, ty: -T.ty / T.s });
  const a = await alignToTemplate(await png(shifted, W, H), await png(buf, W, H));
  assert.equal(a.applied, true);
  assert.ok(Math.abs(a.s - T.s) < 0.015, `s=${a.s}`);
  assert.ok(Math.abs(a.tx - T.tx) < 3 && Math.abs(a.ty - T.ty) < 3, `t=${a.tx},${a.ty}`);
});

test("hizalama: zaten hizalı kareye dokunulmaz", async () => {
  const { buf, W, H } = await scene();
  const a = await alignToTemplate(await png(buf, W, H), await png(buf, W, H));
  assert.equal(a.applied, false);
  assert.equal(a.reason, "aligned");
});
