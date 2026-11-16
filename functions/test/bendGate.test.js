// Bükme denetimi (2026-11-08, kullanıcı: "kafayı yerleştirirken arkadaki yapıları eğip bükmemeliyiz").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { measureBend, repairBentLines, LINE_REPAIR_ON, BEND_GATE_ON, BEND_GATE_PX } = require("../headWarp")._testables;

// 400×400 gri kare, y=200'de yatay düz kenar (koyu üst, açık alt); kafa/kıyafet yok.
function scene() {
  const FW = 400, FH = 400;
  const rgb = Buffer.alloc(FW * FH * 3);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) rgb.fill(y < 200 ? 60 : 200, (y * FW + x) * 3, (y * FW + x) * 3 + 3);
  const N = FW * FH;
  return { rgb, F: { rx0: 0, ry0: 0, RW: FW, RH: FH, FW, FH, m: new Uint8Array(N), head: new Float32Array(N), prot: new Float32Array(N), faceH: 100 } };
}
const field = (FW, FH, fy) => {
  const Dx = new Float32Array(FW * FH), Dy = new Float32Array(FW * FH);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) Dy[y * FW + x] = fy(x, y);
  return { Dx, Dy };
};

test("measureBend: alan yoksa ve düz kaydırmada çizgi eğilmez, yerel tümsekte eğilir", async () => {
  const { rgb, F } = scene();
  const zero = await measureBend(rgb, { ...F, ...field(400, 400, () => 0) });
  assert.ok(zero.n >= 1, "yatay kenar bulunmalı");
  assert.ok(zero.max < 0.5, `sıfır alan: ${zero.max}`);
  const shift = await measureBend(rgb, { ...F, ...field(400, 400, () => 3) });
  assert.ok(shift.max < 0.5, `düz kaydırma: ${shift.max}`);
  const bump = await measureBend(rgb, { ...F, ...field(400, 400, (x) => 4 * Math.exp(-((x - 200) ** 2) / (2 * 40 * 40))) });
  assert.ok(bump.max > BEND_GATE_PX, `tümsek: ${bump.max}`);
  assert.ok(bump.over >= 1);
});

test("measureBend: kafa/kıyafet üstündeki kenar sayılmaz", async () => {
  const { rgb, F } = scene();
  F.head.fill(1);
  const r = await measureBend(rgb, { ...F, ...field(400, 400, (x) => 4 * Math.exp(-((x - 200) ** 2) / (2 * 40 * 40))) });
  assert.strictEqual(r.n, 0);
  assert.strictEqual(r.max, 0);
});

test("warpHead: denetim açık, eşiği aşan karede kafa ölçeklenmez; arka plan sabit yol kapalı", () => {
  assert.strictEqual(BEND_GATE_ON, true);
  assert.ok(BEND_GATE_PX > 0 && BEND_GATE_PX <= 2);
  const src = fs.readFileSync(path.join(__dirname, "..", "headWarp.js"), "utf8");
  assert.match(src, /if \(bendGate\.max > BEND_GATE_PX\) \{/);
  assert.match(src, /if \(rp && rp\.ok && rp\.after <= BEND_GATE_PX\) out = rp\.out;/);
  assert.match(src, /else if \(bendGate\.max <= bendLimit\) bendGate\.accepted = true;\n\s*else return \{ buf: null, applied: false, reason: "line-bend"/);
  // Varsayılan sınır tam güç eşiği; azaltılmış güç yalnız correctHeadByWarp'tan, 0.5 ve ≤ 3 px.
  assert.match(src, /strength = 1, bendLimit = BEND_GATE_PX, warpStrength = WARP_STRENGTH \} = \{\}\) \{/);
  const { LB_REDUCE_ON, LB_REDUCED_STRENGTH, LB_REDUCED_MAX_PX } = require("../headWarp")._testables;
  assert.strictEqual(LB_REDUCE_ON, true);
  assert.ok(LB_REDUCED_STRENGTH > 0 && LB_REDUCED_STRENGTH < 1);
  assert.ok(LB_REDUCED_MAX_PX > BEND_GATE_PX && LB_REDUCED_MAX_PX <= 3);
  assert.match(src, /strength: LB_REDUCED_STRENGTH, bendLimit: LB_REDUCED_MAX_PX/);
  // Azaltılmış deneme yalnız tam güçte gerçek küçültmede; onarım eğilmeyi azalttıysa onarılmış hal.
  assert.match(src, /r\.reason === "line-bend" && LB_REDUCE_ON && !keepBackground && r\.s != null && r\.s <= 1 - LR_MIN_SCALE_CHANGE/);
  assert.match(src, /else if \(rp && rp\.ok && rp\.after <= bendLimit && rp\.after < bendGate\.max\) \{ out = rp\.out; bendGate\.accepted = true; \}/);
  // 11-10: şerit onarımı kapalı (büyük küçültmede çift kenar/basamak); katmanlı yol varsayılan.
  assert.strictEqual(LINE_REPAIR_ON, false);
  assert.strictEqual(require("../headWarp")._testables.LAYER_ON, true);
  assert.match(src, /const KEEP_BG_ON = false;/);
  assert.doesNotMatch(src, /process\.env\.(KB_|BEND_)/);
});

test("repairBentLines: tümsekle eğilen çizgi şeritte düzelir, kafa yoksa dolgu yok", async () => {
  const { rgb, F } = scene();
  const fld = field(400, 400, (x) => 4 * Math.exp(-((x - 200) ** 2) / (2 * 40 * 40)));
  const bF = { ...F, ...fld };
  const before = await measureBend(rgb, bF);
  assert.ok(before.max > BEND_GATE_PX);
  const act = new Uint8Array(400 * 400).fill(1);
  const render = (X, Y, on) => {
    const out = Buffer.from(rgb);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const i = y * 400 + x;
      if (!on[i]) continue;
      const sx = Math.max(0, Math.min(399, Math.round(x + X[i]))), sy = Math.max(0, Math.min(399, Math.round(y + Y[i])));
      rgb.copy(out, i * 3, (sy * 400 + sx) * 3, (sy * 400 + sx) * 3 + 3);
    }
    return out;
  };
  const r = await repairBentLines(rgb, bF, render, act);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.fillPx, 0);
  assert.ok(r.after <= BEND_GATE_PX, `kalan: ${r.after}`);
  // Kenar ham yerinde: x=200 sütununda geçiş y=200'de.
  assert.strictEqual(r.out[(199 * 400 + 200) * 3], 60);
  assert.strictEqual(r.out[(200 * 400 + 200) * 3], 200);
});

test("onarım kuralları: çizgi sınırı, ölçek değişmeyen kare, kısa/soluk çizgi, saç tepesine inen çizgi", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "headWarp.js"), "utf8");
  assert.match(src, /const LR_MAX_LINES = 14;/);
  assert.match(src, /else if \(Math\.abs\(1 - s\) < LR_MIN_SCALE_CHANGE \* clamp\(strength, 0, 1\)\) rp = \{ ok: false, reason: "ölçek-değişmiyor" \};/);
  assert.match(src, /if \(!isStructural\(l, faceH\)\) continue;/);
  assert.match(src, /const structural = lines\.filter\(\(l\) => isStructural\(l, faceH\)\);/);
  assert.match(src, /if \(m\[sy \* RW \+ sx\] \|\| head\[g\] >= LR_HOLE_HEAD \|\| prot\[g\] >= 0\.5\) personOut\[i\] = 1;/);
  assert.match(src, /return \{ ok: false, reason: "fill-crop" \}/);
  assert.match(src, /if \(entersHeadTop\(l, F\)\) \{ topSkip\+\+; continue; \}/);
});

test("entersHeadTop: kafa tepesine yukarıdan inen dikey çizgi yakalanır, yandan geçen yatay çizgi yakalanmaz", () => {
  const { entersHeadTop } = require("../headWarp")._testables;
  const RW = 200, RH = 200, m = new Uint8Array(RW * RH);
  for (let y = 100; y < 200; y++) for (let x = 80; x < 120; x++) m[y * RW + x] = 1; // kafa: y≥100
  const F = { rx0: 0, ry0: 0, RW, RH, m, faceH: 100, browY: 130 };
  // Dikey çizgi x=100, y 20..80 (merkez 50, aşağı yön +t): uç 80, 20 px aşağıda kafaya (y=100 < kaş 130) girer.
  assert.strictEqual(entersHeadTop({ cx: 100, cy: 50, ux: 0, uy: 1, t0: -30, t1: 30 }, F), true);
  // Ters yönlü parametre de aynı sonucu verir.
  assert.strictEqual(entersHeadTop({ cx: 100, cy: 50, ux: 0, uy: -1, t0: -30, t1: 30 }, F), true);
  // Yatay çizgi kafanın yanında: hiç yakalanmaz.
  assert.strictEqual(entersHeadTop({ cx: 40, cy: 110, ux: 1, uy: 0, t0: -30, t1: 30 }, F), false);
  // Dikey çizgi kafanın yanından iner: kafaya girmez.
  assert.strictEqual(entersHeadTop({ cx: 20, cy: 50, ux: 0, uy: 1, t0: -30, t1: 30 }, F), false);
});
