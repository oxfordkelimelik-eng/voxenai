const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measureSilhouette, planHeadScale, approxSilFromFaceBox, APPLY_BELOW, MIN_SCALE } = require("../headScale");

// KAFA ÖLÇEĞİ (2026-10-07). Sentetik kişi maskesi: elips kafa + dikdörtgen
// gövde. Yüz kutusu kafanın alt 3/4'ü (ssd_mobilenetv1 kaş-çene arası verir).
function figure({ W = 400, H = 600, cx = 200, headTop = 100, headW = 80, headH = 100, shoulderW = 240 } = {}) {
  const m = new Float32Array(W * H);
  const hy = headTop + headH / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inHead = ((x - cx) / (headW / 2)) ** 2 + ((y - hy) / (headH / 2)) ** 2 <= 1;
      const neck = y >= headTop + headH - 5 && y < headTop + headH + 20 && Math.abs(x - cx) < headW * 0.3;
      const body = y >= headTop + headH + 20 && Math.abs(x - cx) < shoulderW / 2;
      if (inHead || neck || body) m[y * W + x] = 1;
    }
  }
  const box = { x: cx - headW * 0.4, y: headTop + headH * 0.3, width: headW * 0.8, height: headH * 0.7 };
  return { m, W, H, box };
}

test("siluet: kafa genişliği, yüksekliği ve omuz ölçülür", () => {
  const f = figure();
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.headW - 80) <= 3, `headW=${r.headW}`);
  assert.ok(Math.abs(r.top - 100) <= 2, `top=${r.top}`);
  assert.ok(Math.abs(r.shoulderW - 240) <= 3, `shoulderW=${r.shoulderW}`);
});

test("kafa %15 büyükse düzeltme planlanır", () => {
  const base = figure();
  const t = measureSilhouette(base.m, base.W, base.H, base.box);
  const big = figure({ headW: 92, headH: 115, headTop: 85 });
  const o = measureSilhouette(big.m, big.W, big.H, big.box);
  const p = planHeadScale(t, o);
  assert.equal(p.apply, true);
  assert.ok(p.s > 0.82 && p.s < 0.9, `s=${p.s}`);
});

test("aynı oranlarda düzeltme yapılmaz", () => {
  const a = figure();
  const t = measureSilhouette(a.m, a.W, a.H, a.box);
  const p = planHeadScale(t, t);
  assert.equal(p.apply, false);
  assert.equal(p.reason, "within-tolerance");
  assert.ok(APPLY_BELOW < 1);
});

test("model sahneyi yakınlaştırdıysa (omuzlar çok farklı) dokunulmaz", () => {
  const a = figure();
  const zoomed = figure({ headW: 120, headH: 150, headTop: 40, shoulderW: 380, W: 600 });
  const p = planHeadScale(
    measureSilhouette(a.m, a.W, a.H, a.box),
    measureSilhouette(zoomed.m, zoomed.W, zoomed.H, zoomed.box)
  );
  assert.equal(p.apply, false);
  assert.equal(p.reason, "reframed");
});

test("aşırı sapmada ölçek MIN_SCALE ile sınırlanır", () => {
  const t = { ok: true, headW: 50, headH: 60, shoulderW: 200 };
  const o = { ok: true, headW: 90, headH: 110, shoulderW: 200 };
  const p = planHeadScale(t, o);
  assert.equal(p.apply, true);
  assert.equal(p.s, MIN_SCALE);
});

test("omuzlar kadraj dışındaysa ölçüm reddedilir", () => {
  const f = figure({ H: 230 });
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shoulders-out-of-frame");
});

test("kafa üstü kadraja değiyorsa ölçüm reddedilir", () => {
  const f = figure({ headTop: -10 });
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, false);
});

test("ölçüm yoksa plan uygulanmaz ve sebep taşır", () => {
  const p = planHeadScale({ ok: false, reason: "no-head-top" }, { ok: true });
  assert.equal(p.apply, false);
  assert.match(p.reason, /template:no-head-top/);
});

test("approxSilFromFaceBox: çene, merkez ve kafa genişliği doğru hesaplanır", () => {
  const box = { x: 100, y: 120, width: 80, height: 100 };
  const s = approxSilFromFaceBox(box);
  assert.equal(s.ok, true);
  assert.equal(s.cx, 140);                            // x + width/2
  assert.equal(s.chin, 220);                          // y + height
  assert.ok(s.top < 120, `top=${s.top}`);             // saç dahil üst kafa tepesi
  assert.ok(s.headW > 80, `headW=${s.headW}`);        // yüzden geniş
  assert.ok(s.headH > 0);
});
