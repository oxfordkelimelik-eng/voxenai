const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measureSilhouette, approxSilFromFaceBox, landmarkSizeRatio, planLandmarkScale, MIN_SCALE, MAX_SCALE, BODY_ALIGNED_IOU, FACE_ALIGNED_SHIFT, VOLUME_FLOOR, perceivedHeadRatio, _pinchHead } = require("../headScale");
const { dilate } = require("../sceneRestore");

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

test("dilate: tek piksel r yarıçaplı kareye büyür", () => {
  const W = 9, H = 9, b = new Uint8Array(W * H);
  b[4 * W + 4] = 1;
  const d = dilate(b, W, H, 2);
  let n = 0;
  for (const v of d) n += v;
  assert.equal(n, 25);
  assert.equal(d[2 * W + 2], 1);
  assert.equal(d[1 * W + 4], 0);
});

// 68 noktalı sentetik yüz: ölçek k ile büyütülmüş kopyanın oranı k olmalı.
function fakeFace(k = 1, cx = 200, cy = 200) {
  const P = [];
  for (let i = 0; i < 68; i++) P.push({ x: cx, y: cy });
  for (let i = 0; i <= 16; i++) P[i] = { x: cx + k * (-60 + 7.5 * i), y: cy + k * (Math.abs(8 - i) < 3 ? 70 : 40) };
  P[8] = { x: cx, y: cy + k * 80 };
  for (let i = 17; i <= 26; i++) P[i] = { x: cx + k * (-40 + 9 * (i - 17)), y: cy - k * 30 };
  P[27] = { x: cx, y: cy - k * 15 };
  P[33] = { x: cx, y: cy + k * 25 };
  for (let i = 36; i <= 47; i++) P[i] = { x: cx + k * (i < 42 ? -25 : 25), y: cy - k * 15 };
  return P;
}

test("landmark: 1.12 büyük yüz 1.12 ölçülür", () => {
  const r = landmarkSizeRatio(fakeFace(1.12), fakeFace(1));
  assert.ok(Math.abs(r.ratio - 1.12) < 1e-9, `ratio=${r.ratio}`);
});

test("landmark: gür sakal çene noktasını kaydırsa da medyan oynamaz", () => {
  const o = fakeFace(1.0);
  const t = fakeFace(1.0);
  t[8] = { x: t[8].x, y: t[8].y - 25 }; // şablonda çene noktası sakalın içinde yukarıda
  const r = landmarkSizeRatio(o, t);
  assert.ok(Math.abs(r.ratio - 1) < 0.02, `ratio=${r.ratio}`);
});
test("plan: büyük kafa tam şablon oranına küçültülür (aşım çarpanı yok)", () => {
  const p = planLandmarkScale(1.12, { bodyIou: 0.95 });
  assert.equal(p.apply, true);
  assert.ok(Math.abs(p.s - 1 / 1.12) < 1e-9);
});

test("plan: küçük kafa büyütülür", () => {
  const p = planLandmarkScale(0.93, { bodyIou: 0.95 });
  assert.equal(p.apply, true);
  // Büyütme MAX_SCALE ile sınırlı (büyütme yönünde şikâyet nadir; ölçü el ya
  // da sakal örtüsünde yanılabiliyor).
  assert.ok(p.s > 1 && Math.abs(p.s - Math.min(MAX_SCALE, 1 / 0.93)) < 1e-9);
});

test("plan: küçük sapmaya dokunulmaz", () => {
  assert.equal(planLandmarkScale(1.02, { bodyIou: 0.95 }).apply, false);
  assert.equal(planLandmarkScale(0.98, { bodyIou: 0.95 }).reason, "within-tolerance");
});

test("plan: gövde örtüşmüyor ve yüz kaymışsa (yeniden kadraj) dokunulmaz", () => {
  const p = planLandmarkScale(1.2, { bodyIou: BODY_ALIGNED_IOU - 0.1, faceShift: 1.2 });
  assert.equal(p.apply, false);
  assert.equal(p.reason, "reframed");
});

test("plan: ölçek sınırları", () => {
  assert.equal(planLandmarkScale(2, { bodyIou: 0.95 }).s, MIN_SCALE);
  assert.equal(planLandmarkScale(0.5, { bodyIou: 0.95 }).s, MAX_SCALE);
});

test("pinchHead: s>1 kafayı büyütür, boyun altına dokunmaz", () => {
  const W = 120, H = 160, O = Buffer.alloc(W * H * 3, 255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x - 60) / 20) ** 2 + ((y - 60) / 25) ** 2 <= 1) O.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const sil = { cx: 60, top: 35, chin: 85, headW: 40, headH: 50 };
  const r = _pinchHead(O, W, H, sil, 40, 1.15);
  const dark = (B) => { let n = 0; for (let i = 0; i < W * H; i++) if (B[i * 3] < 128) n++; return n; };
  assert.ok(dark(r.buf) > dark(O) * 1.15, `${dark(r.buf)} vs ${dark(O)}`);
  const row = (B, y) => B.subarray(y * W * 3, (y + 1) * W * 3);
  assert.ok(row(r.buf, H - 5).equals(row(O, H - 5)));
});

test("plan: maske gövdeyi göremese de yüz yerindeyse düzeltilir (karanlık sahne)", () => {
  const p = planLandmarkScale(1.12, { bodyIou: 0.28, faceShift: FACE_ALIGNED_SHIFT / 2 });
  assert.equal(p.apply, true);
});

test("algılanan kafa: yüz ve hacmin geometrik ortalaması", () => {
  const r = perceivedHeadRatio(1.13, 1.04);
  assert.equal(r.volUsed, true);
  assert.ok(Math.abs(r.ratio - Math.sqrt(1.13 * 1.04)) < 1e-9);
});

test("algılanan kafa: hacim yüzden çok saparsa (karanlık sahne) yalnızca yüz", () => {
  const r = perceivedHeadRatio(1.14, 0.86);
  assert.equal(r.volUsed, false);
  assert.equal(r.ratio, 1.14);
});

test("plan: küçültme kafa hacmini tabanın altına indirmez (c8)", () => {
  const p = planLandmarkScale(1.14, { bodyIou: 0.98, volRatio: 1.07 });
  assert.equal(p.apply, true);
  assert.ok(p.s * 1.07 >= VOLUME_FLOOR - 1e-9, `s=${p.s}`);
});
