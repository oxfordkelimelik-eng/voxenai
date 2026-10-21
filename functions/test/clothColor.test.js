const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _testables: { kmeansLab, planClothShift, DE_MIN } } = require("../clothColor");

// İki renkli kıyafet: koyu takım (L 14) + açık gömlek (L 56), şablonda
// takım L 23 / gömlek L 66 (7c17ea3f c3'e benzer).
function sample(outSuit, outShirt, tplSuit, tplShirt, nSuit = 3000, nShirt = 1000, overlap = 1) {
  const lo = [[], [], []], lt = [[], [], []], tc = [];
  const push = (o, t, n) => {
    for (let i = 0; i < n; i++) {
      const j = (i % 7) - 3; // küçük doku
      for (let c = 0; c < 3; c++) { lo[c].push(o[c] + (c === 0 ? j : 0)); lt[c].push(t[c] + (c === 0 ? j : 0)); }
      tc.push(i / n < overlap);
    }
  };
  push(outSuit, tplSuit, nSuit);
  push(outShirt, tplShirt, nShirt);
  return { lo, lt, tc };
}

test("k-ortalamalar: iki renk iki kümeye ayrılır", () => {
  const { lo } = sample([14, 9, 10], [56, 14, 2], [23, 9, 17], [66, 5, 7]);
  const { centers } = kmeansLab(lo[0], lo[1], lo[2], 2);
  const Ls = centers.map((c) => Math.round(c[0])).sort((a, b) => a - b);
  assert.ok(Math.abs(Ls[0] - 14) <= 1 && Math.abs(Ls[1] - 56) <= 1, `merkezler: ${Ls}`);
});

test("model kıyafeti değiştirdiyse kümeler şablon rengine kayar", () => {
  const { lo, lt, tc } = sample([14, 9, 10], [56, 14, 2], [23, 9, 17], [66, 5, 7]);
  const p = planClothShift(lo, lt, tc);
  const shifted = p.shifts.filter(Boolean);
  assert.ok(shifted.length >= 2, JSON.stringify(p.info));
  for (const s of shifted) assert.ok(s[0] > 5, `açıklık artmalı: ${s}`);
});

test("kıyafet korunmuşsa dokunulmaz", () => {
  const { lo, lt, tc } = sample([20, 2, 10], [74, 5, 20], [21, 2, 10], [75, 5, 21]);
  const p = planClothShift(lo, lt, tc);
  assert.ok(p.shifts.every((s) => s === null), JSON.stringify(p.info));
  assert.ok(p.info.every((x) => x.reason === "close" || x.reason === "small"));
  assert.ok(DE_MIN > 2);
});

test("şablonda o yer kıyafet değilse (poz farkı) hedef ölçülmez", () => {
  const { lo, lt, tc } = sample([14, 9, 10], [56, 14, 2], [23, 9, 17], [66, 5, 7], 3000, 1000, 0.3);
  const p = planClothShift(lo, lt, tc);
  assert.ok(p.shifts.every((s) => s === null), JSON.stringify(p.info));
});

test("kayma tavanı aşılmaz", () => {
  const { lo, lt, tc } = sample([10, 0, 0], [50, 0, 0], [60, 40, -40], [95, 40, -40]);
  const p = planClothShift(lo, lt, tc);
  for (const s of p.shifts.filter(Boolean)) assert.ok(Math.abs(s[0]) <= 14 && Math.abs(s[1]) <= 12 && Math.abs(s[2]) <= 12, `${s}`);
});
