const { test } = require("node:test");
const assert = require("node:assert/strict");
const { eyewearGeometry, compositeEyewear } = require("../eyewear");

// YAN DÖNÜK BAŞ, CAMIN İÇİ (2026-11-06, 80fc7ec4 c9 / d87c25b4 c2 / 10ee6a46 c0):
// keepOwnEyes çekirdeği yaw ile büyütülmüş iod'la çiziliyordu; kısalmış camın
// çerçevesi çekirdeğe düşüp tabanla (own) ya da bulanık camla (hide) değişiyordu.
function fakePts() {
  const p = Array.from({ length: 68 }, () => ({ x: 200, y: 320 }));
  p[0] = { x: 100, y: 205 };
  p[16] = { x: 300, y: 205 };
  for (let i = 17; i <= 26; i++) p[i] = { x: 130 + (i - 17) * 15, y: 170 };
  for (let i = 36; i <= 41; i++) p[i] = { x: 150 + ((i - 36) % 3) * 5 - 5, y: 200 };
  for (let i = 42; i <= 47; i++) p[i] = { x: 250 + ((i - 42) % 3) * 5 - 5, y: 200 };
  p[30] = { x: 200, y: 250 };
  return p;
}
function solid(W, H, v) {
  const b = Buffer.alloc(W * H * 3);
  for (let i = 0; i < b.length; i += 3) { b[i] = v[0]; b[i + 1] = v[1]; b[i + 2] = v[2]; }
  return b;
}
const SKIN = [180, 140, 120];
// Kısalmış (görüntüde dar) cam: yatay yarıçap 40 px (göz arası görüntüde 100 px,
// 45°de gerçek göz arası ~141 px), dikey 38 px (~0.27 gerçek göz arası, 10ee6a46
// c0 yuvarlak cam), 7 px kalın siyah çerçeve; içi tabanın `tint` katı; ortada
// modelin çizdiği koyu göz (r=8).
function drawTurnedGlasses(rect, g, { tint, eye = true } = {}) {
  const ai = solid(rect.side, rect.side, SKIN);
  const ring = [];
  for (let y = 0; y < rect.side; y++) for (let x = 0; x < rect.side; x++) {
    const X = rect.left + x, Y = rect.top + y, i = (y * rect.side + x) * 3;
    for (const e of [g.eR, g.eL]) {
      const r = Math.hypot((X - e.x) / 40, (Y - e.y - 4) / 38);
      if (r <= 1) {
        const onRim = r > 1 - 7 / 39;
        const v = onRim ? [15, 15, 15] : (tint == null ? [60, 55, 55] : SKIN.map((c) => Math.round(c * tint)));
        for (let c = 0; c < 3; c++) ai[i + c] = v[c];
        if (onRim) ring.push([X, Y]);
      }
      if (eye && Math.hypot(X - e.x, Y - e.y) <= 8) for (let c = 0; c < 3; c++) ai[i + c] = 30;
    }
  }
  return { ai, ring };
}

test("yan dönük baş, görünür cam (own): modelin çerçevesi kalır, camın içinde kendi gözü", async () => {
  const W = 400, H = 400, base = solid(W, H, SKIN);
  const g = eyewearGeometry(fakePts(), { yawDeg: 45 });
  const rect = { left: 50, top: 50, side: 300 };
  const { ai, ring } = drawTurnedGlasses(rect, g, { tint: 0.7 });
  const { rgb } = await compositeEyewear(base, W, H, rect, g, ai, { keepEyes: "own" });
  const px = (x, y) => rgb[(y * W + x) * 3];
  let kept = 0;
  for (const [x, y] of ring) if (px(x, y) < 60) kept++;
  assert.ok(kept / ring.length > 0.97, `çerçeve korunmalı (${(kept / ring.length).toFixed(3)})`);
  // Göz ortası: modelin koyu gözü (30) değil, tabanın tonlanmış hâli.
  assert.ok(px(Math.round(g.eL.x), Math.round(g.eL.y)) > 80, "camın içinde modelin gözü kalmamalı");
});

test("yan dönük baş, koyu cam (hide): çerçeve bulanık camla karışmaz", async () => {
  const W = 400, H = 400, base = solid(W, H, SKIN);
  const g = eyewearGeometry(fakePts(), { yawDeg: 45 });
  const rect = { left: 50, top: 50, side: 300 };
  const { ai, ring } = drawTurnedGlasses(rect, g, { tint: null });
  const { rgb } = await compositeEyewear(base, W, H, rect, g, ai, { keepEyes: "hide" });
  const px = (x, y) => rgb[(y * W + x) * 3];
  let sharp = 0;
  for (const [x, y] of ring) if (px(x, y) < 25) sharp++;
  assert.ok(sharp / ring.length > 0.95, `çerçeve keskin kalmalı (${(sharp / ring.length).toFixed(3)})`);
  // Göz bölgesi yine gizlenir: modelin gözü (30) cam tonuyla (≈60) örtülür.
  assert.ok(px(Math.round(g.eR.x), Math.round(g.eR.y)) > 40, "koyu camda modelin gözü gizlenmeli");
});

test("düz baş: yaw yoksa yeni dal devreye girmez (cosY'siz geometriyle aynı sonuç)", async () => {
  const W = 400, H = 400, base = solid(W, H, SKIN);
  const g = eyewearGeometry(fakePts());
  const { cosY, ...gNo } = g;
  assert.equal(cosY, 1);
  const rect = { left: 50, top: 50, side: 300 };
  const { ai } = drawTurnedGlasses(rect, g, { tint: 0.7 });
  for (const mode of ["own", "hide"]) {
    const a = await compositeEyewear(base, W, H, rect, g, ai, { keepEyes: mode });
    const b = await compositeEyewear(base, W, H, rect, gNo, ai, { keepEyes: mode });
    assert.ok(a.rgb.equals(b.rgb), mode);
    assert.equal(a.lensPx, b.lensPx);
  }
});
