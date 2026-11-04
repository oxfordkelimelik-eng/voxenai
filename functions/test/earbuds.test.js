const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pickEarbuds, POS } = require("../earbuds");

// 68 nokta: yüz genişliği 200 px (0 → 16), çene noktaları kenarda.
function face() {
  const pts = [];
  for (let i = 0; i < 68; i++) pts.push({ x: 300, y: 300 });
  for (let i = 0; i <= 16; i++) pts[i] = { x: 200 + (200 * i) / 16, y: 250 + 100 * Math.sin((Math.PI * i) / 16) };
  return pts;
}
const crop = { left: 100, top: 100, side: 400 };
const box = (cx, cy, size, s, ear = 0.05) => {
  const scores = { ear, hair: 0, face: 0 };
  for (const q of POS) scores[q] = 0;
  scores.earbuds = s;
  return { cx: (cx - crop.left) / crop.side, cy: (cy - crop.top) / crop.side, w: size / crop.side, h: size / crop.side, scores };
};

test("kulaklık: kulak hizasında küçük, yüksek skorlu kutu seçilir", () => {
  const f = pickEarbuds([box(190, 260, 20, 0.7)], crop, face());
  assert.equal(f.length, 1);
  assert.ok(Math.abs(f[0].cx - 190) < 1e-6);
});

test("kulaklık: düşük skor, kulaktan yüksek 'ear' skoru, büyük kutu, uzak kutu seçilmez", () => {
  const pts = face();
  assert.equal(pickEarbuds([box(190, 260, 20, 0.13)], crop, pts).length, 0);
  assert.equal(pickEarbuds([box(190, 260, 20, 0.3, 0.5)], crop, pts).length, 0);
  assert.equal(pickEarbuds([box(190, 260, 120, 0.7)], crop, pts).length, 0);
  assert.equal(pickEarbuds([box(300, 480, 20, 0.7)], crop, pts).length, 0);
});

test("kulaklık: aynı kulaklığın üst üste kutuları tek sayılır", () => {
  const f = pickEarbuds([box(190, 260, 20, 0.5), box(193, 262, 22, 0.7)], crop, face());
  assert.equal(f.length, 1);
  assert.ok(Math.abs(f[0].score - 0.7) < 1e-9);
});
