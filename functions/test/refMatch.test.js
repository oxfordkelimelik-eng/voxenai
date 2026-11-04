const test = require("node:test");
const assert = require("node:assert");
const { _testables: T } = require("../refMatch");
const { _testables: EO } = require("../eyeOpen");

// Sentetik göz: köşeler (20, 50)-(120, 50), kapaklar ±18 px elips, beyaz
// sklera, merkezi iu'da koyu iris (yarıçap 16).
function syntheticEye(iu) {
  const W = 140, H = 100;
  const rgb = Buffer.alloc(W * H * 3, 150); // ten
  const mesh = Array.from({ length: 468 }, () => [0, 0, 0]);
  const eye = EO.EYES[0];
  const n = eye.up.length;
  eye.up.forEach((idx, k) => { const u = k / (n - 1); mesh[idx] = [20 + 100 * u, 50 - 18 * Math.sin(Math.PI * u), 0]; });
  eye.lo.forEach((idx, k) => { const u = k / (n - 1); mesh[idx] = [20 + 100 * u, 50 + 18 * Math.sin(Math.PI * u), 0]; });
  const cx = 20 + 100 * iu;
  for (let y = 0; y < H; y++) for (let x = 20; x <= 120; x++) {
    const u = (x - 20) / 100, h = 18 * Math.sin(Math.PI * u);
    if (Math.abs(y - 50) >= h) continue;
    const v = Math.hypot(x - cx, y - 50) <= 16 ? 30 : 235;
    const o = (y * W + x) * 3;
    rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
  }
  return { rgb, W, H, mesh, eye };
}

test("gülüş hedefi: base gülüyorsa aynısı, gülmüyorsa nötrün altı", () => {
  assert.strictEqual(T.smileTarget(0.03), 0.03);
  assert.ok(Math.abs(T.smileTarget(-0.002) - -0.012) < 1e-9);
  assert.ok(Math.abs(T.smileTarget(0.01) - -0.01) < 1e-9);
});

test("gülüş inişi: 831a00a4 c0 (çıktı 0.006, base -0.002) iner, gülen base'e dokunulmaz", () => {
  assert.ok(Math.abs(T.smileDrop(0.006, -0.002) - 0.018) < 1e-9);
  assert.strictEqual(T.smileDrop(0.032, 0.026), 0); // c8: base gülüyor, fark eşik altı
  assert.strictEqual(T.smileDrop(-0.03, -0.017), 0);
  assert.strictEqual(T.smileDrop(0.5, 0), T.MAX_SMILE_DROP);
  assert.strictEqual(T.smileDrop(null, 0), 0);
});

test("iki göz çelişirse bakış ölçüsü güvenilmez", () => {
  assert.strictEqual(T.eyesAgree([{ ok: true, u: 0.52 }, { ok: true, u: 0.76 }]), false); // c8
  assert.strictEqual(T.eyesAgree([{ ok: true, u: 0.35 }, { ok: true, u: 0.3 }]), true);
  assert.strictEqual(T.eyesAgree([{ ok: false, u: null }, { ok: true, u: 0.2 }]), true);
});

test("iris yeri sentetik gözde bulunur", () => {
  for (const iu of [0.3, 0.5, 0.7]) {
    const s = syntheticEye(iu);
    const f = T.eyeFrame(s.mesh, s.eye);
    const ir = T.irisU(s.rgb, s.W, s.H, f);
    assert.ok(Math.abs(ir.u - iu) < 0.05, `iu=${iu} ölçülen=${ir.u}`);
    assert.ok(ir.contrast > 100);
  }
});

test("iris kaydırma: iris açıklık içinde hedefe gider, kapak dışı değişmez", () => {
  const s = syntheticEye(0.6);
  const f = T.eyeFrame(s.mesh, s.eye);
  const dst = Buffer.from(s.rgb);
  const moved = T.shiftIris(s.rgb, dst, s.W, s.H, f, 0.6, 0.35);
  assert.ok(moved > 0);
  const ir = T.irisU(dst, s.W, s.H, T.eyeFrame(s.mesh, s.eye));
  assert.ok(Math.abs(ir.u - 0.35) < 0.06, `ölçülen=${ir.u}`);
  // Göz dışı (ten) aynen kalır.
  for (const [x, y] of [[5, 5], [70, 20], [70, 80], [130, 50]]) {
    const o = (y * s.W + x) * 3;
    assert.strictEqual(dst[o], s.rgb[o]);
  }
});

test("0° döndürme görüntüyü değiştirmez, 180° noktayı merkeze göre aynalar", () => {
  const W = 21, H = 11, rgb = Buffer.alloc(W * H * 3);
  rgb[(2 * W + 3) * 3] = 255;
  assert.deepStrictEqual(T.rotateAbout(rgb, W, H, 10, 5, 0), rgb);
  const r = T.rotateAbout(rgb, W, H, 10, 5, 180);
  assert.ok(r[(8 * W + 17) * 3] > 200);
});

test("ağız köşesi indirme köşedeki çizgiyi aşağı taşır, uzağı bozmaz", () => {
  const W = 120, H = 120, rgb = Buffer.alloc(W * H * 3, 200);
  for (let x = 30; x <= 90; x++) for (let c = 0; c < 3; c++) rgb[(60 * W + x) * 3 + c] = 20; // ağız çizgisi
  const mesh = Array.from({ length: 468 }, () => [0, 0, 0]);
  mesh[61] = [30, 60, 0]; mesh[291] = [90, 60, 0];
  const mouth = { nx: 0, ny: 1, iod: 60 };
  const dst = Buffer.from(rgb);
  assert.ok(T.dropCorners(Buffer.from(rgb), dst, W, H, mesh, mouth, 4) > 0);
  // Köşede çizgi ~4 px aşağıda, eski yerinde açık.
  assert.ok(dst[(64 * W + 30) * 3] < 100, "köşe aşağı inmeli");
  assert.ok(dst[(60 * W + 30) * 3] > 100, "eski yer açılmalı");
  // Uzak köşe (sol üst) aynı.
  assert.strictEqual(dst[(5 * W + 5) * 3], rgb[(5 * W + 5) * 3]);
});
