const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signedYawFromLandmarks } = require("../faceQuality");

// 68 noktalı dizi: yalnız 36 (sol göz dış köşesi), 45 (sağ göz dış köşesi), 30 (burun ucu) kullanılır.
function lm(a, c, n) {
  const positions = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  positions[36] = a;
  positions[45] = c;
  positions[30] = n;
  return { positions };
}
function rotate(p, deg) {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

test("signedYawFromLandmarks: burun ortada → 0, sağa kayık → artı, sola → eksi", () => {
  assert.equal(signedYawFromLandmarks(lm({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 40 })), 0);
  assert.ok(signedYawFromLandmarks(lm({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 70, y: 40 })) > 0.3);
  assert.ok(signedYawFromLandmarks(lm({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 })) < -0.3);
});

test("signedYawFromLandmarks: yana yatık ama düz bakan baş dönük sayılmaz (ca61076a)", () => {
  // Düz bakan yüz 12° yatırılır: yatay ölçüde burun gözlerin altında kayar.
  const [a, c, n] = [{ x: -50, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 40 }].map((p) => rotate(p, 12));
  const v = signedYawFromLandmarks(lm(a, c, n));
  assert.ok(Math.abs(v) < 1e-9, `yatık düz baş ${v}`);
  const horizontal = Math.abs((n.x - a.x) / (c.x - a.x) - 0.5) * 2;
  assert.ok(horizontal > 0.15, "eski yatay ölçü bu başı dönük görüyordu");
});

test("signedYawFromLandmarks: ölçülemeyen nokta dizisinde null", () => {
  assert.equal(signedYawFromLandmarks(null), null);
  assert.equal(signedYawFromLandmarks({ positions: [] }), null);
  assert.equal(signedYawFromLandmarks(lm({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 9 })), null);
});
