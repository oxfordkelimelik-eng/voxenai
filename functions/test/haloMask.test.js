// Yarı saydam kafa halesi (2026-11-07, 173acc7f c0; bkz. ghostClean HALO_*).
const test = require("node:test");
const assert = require("node:assert");
const { haloMask, HALO_MIN_AREA_FACE2 } = require("../ghostClean")._testables;
const { distanceTo } = require("../headWarp")._testables;

// 100×100 kesit, yüz eni 50; opak kafa: (50,55) merkezli r=22 disk. Zemin 120, saç 10.
function scene({ haloW = 0, haloA = 0.5, blob = false, side = "left" } = {}) {
  const n = 100, fwk = 50;
  const O = new Uint8Array(n * n), Th = new Uint8Array(n * n), userSkin = new Uint8Array(n * n);
  const oF = new Float32Array(n * n * 3).fill(120), tF = new Float32Array(n * n * 3).fill(120);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - 50, y - 55), i = y * n + x;
    if (d <= 22) { O[i] = 1; oF.fill(10, i * 3, i * 3 + 3); }
    const inHalo = haloW > 0 && d > 22 && d <= 22 + haloW && (side === "both" || x < 50) && y < 70;
    const inBlob = blob && x >= 73 && x < 76 && y >= 40 && y < 43;
    if (inHalo || inBlob) oF.fill(haloA * 10 + (1 - haloA) * 120, i * 3, i * 3 + 3);
  }
  const Po = [new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n)];
  const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
  const po = Array.from({ length: 68 }, () => ({ x: 50, y: 60 }));
  const Od = distanceTo(O, n, n);
  return { n, O, Od, Th, userSkin, Po, CLASSES, oF, tF, U: [10, 10, 10], po, fwk };
}
const count = (m) => m.reduce((s, v) => s + v, 0);

test("haloMask: opak saça bitişik yarı saydam bant bulunur", () => {
  const m = haloMask(scene({ haloW: 8, haloA: 0.5 }));
  assert.ok(count(m) >= HALO_MIN_AREA_FACE2 * 50 * 50, `px=${count(m)}`);
  assert.strictEqual(m[55 * 100 + 50], 0); // opak kafa dokunulmaz
});

test("haloMask: hale yoksa, küçük leke ya da göz hizasının altı → boş", () => {
  assert.strictEqual(count(haloMask(scene({}))), 0);
  assert.strictEqual(count(haloMask(scene({ blob: true }))), 0);
  const s = scene({ haloW: 8, haloA: 0.5 });
  for (const p of s.po) p.y = 20; // göz hizası çok yukarıda: bant hizanın altında kalır
  assert.strictEqual(count(haloMask(s)), 0);
});

test("haloMask: opak (α≈1) ya da zeminle aynı (α≈0) piksel hale değil; şablon kafası içi dokunulmaz", () => {
  assert.strictEqual(count(haloMask(scene({ haloW: 8, haloA: 0.97 }))), 0);
  assert.strictEqual(count(haloMask(scene({ haloW: 8, haloA: 0.02 }))), 0);
  const s = scene({ haloW: 8, haloA: 0.5 });
  s.Th.fill(1);
  assert.strictEqual(count(haloMask(s)), 0);
});

test("haloMask: kullanıcı saç rengi yoksa çalışmaz", () => {
  const s = scene({ haloW: 8 });
  s.U = null;
  assert.strictEqual(count(haloMask(s)), 0);
});

test("haloMask: segmentasyonun kesin saç dediği bileşen hale sayılmaz (2026-11-10, 7bbdad12 c8/c4)", () => {
  const sc = scene({ haloW: 8, haloA: 0.5 });
  assert.ok(count(haloMask(sc)) > 0);
  // Bandın yarısından fazlası skinSeg'de saç ≥ 0.8: gerçek kıvırcık saç kenarı, korunur.
  for (let i = 0; i < 100 * 100; i++) sc.Po[sc.CLASSES.hair][i] = 0.95;
  assert.strictEqual(count(haloMask(sc)), 0);
  // Yalnız küçük bir kısmı saç: hale yine silinir (c1 gibi gerçek hale).
  const sc2 = scene({ haloW: 8, haloA: 0.5 });
  for (let i = 0; i < 100 * 100; i += 10) sc2.Po[sc2.CLASSES.hair][i] = 0.95;
  assert.ok(count(haloMask(sc2)) > 0);
});
