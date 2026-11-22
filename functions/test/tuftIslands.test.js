// İZ İÇİNDE KALAN TUTAM (2026-11-19, ghostClean.tuftIslands): opak kafadan iz kubbesine uzanan
// korunan sivri çıkıntı iz sayılır; kafa kenarı şeridi ve ize bakmayan çıkıntı korunur.
const test = require("node:test");
const assert = require("node:assert");
const { tuftIslands, TUFT } = require("../ghostClean")._testables;

const n = 100, fwk = 100;
function scene({ tuft = true, ghost = true, strip = true } = {}) {
  const O = new Uint8Array(n * n), keep = new Uint8Array(n * n), cand = new Uint8Array(n * n), Od = new Float32Array(n * n);
  const zero = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (y >= 60) { O[i] = 1; keep[i] = 1; }
    Od[i] = Math.max(0, 60 - y);
    if (ghost && y >= 30 && y < 60) cand[i] = 1;
    if (strip && y >= 59 - 1 && y < 60) { keep[i] = 1; cand[i] = 0; } // ince kenar şeridi (Od ≤ kenar bandı)
    if (tuft && x >= 40 && x < 46 && y >= 50 && y < 60) { keep[i] = 1; cand[i] = 0; } // 10 px yukarı sivri tutam
  }
  return { keep, O, Od, cand, userSkin: zero, inOval: zero, n, fwk };
}

test("tutam: iz kubbesine uzanan korunan çıkıntı iz olur, kenar bandı kalır", () => {
  const s = scene();
  const r = tuftIslands(s);
  const edge = TUFT.EDGE_KEEP_FACE * fwk;
  let hit = 0, edgeHit = 0;
  for (let i = 0; i < n * n; i++) if (r.mask[i]) { hit++; if (s.Od[i] <= edge) edgeHit++; }
  assert.ok(hit > 0, "tutam bulunmalı");
  assert.strictEqual(edgeHit, 0, "kenar bandına dokunulmaz");
  for (let i = 0; i < n * n; i++) if (r.mask[i]) assert.ok(!s.O[i]);
});

test("tutam: iz yoksa ya da çıkıntı yoksa hiçbir şey değişmez", () => {
  for (const opt of [{ ghost: false }, { tuft: false }]) {
    const r = tuftIslands(scene(opt));
    assert.strictEqual(r.mask.reduce((a, b) => a + b, 0), 0, JSON.stringify(opt));
  }
});

test("tutam: alan sınırını aşan büyük korunan bölge (gerçek saç) dokunulmaz", () => {
  const s = scene({ tuft: false });
  for (let y = 30; y < 60; y++) for (let x = 0; x < 80; x++) { s.keep[y * n + x] = 1; s.cand[y * n + x] = 0; }
  assert.ok(30 * 80 > TUFT.MAX_FACE2 * fwk * fwk);
  const r = tuftIslands(s);
  assert.strictEqual(r.mask.reduce((a, b) => a + b, 0), 0);
});
