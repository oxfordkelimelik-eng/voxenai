// Katmanlı kafa ölçeği (2026-11-10, kullanıcı: c4 cam korkuluk / c8 şarap rafı "kesin çözüm, eleme yapmadan").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { normConv, LAYER } = require("../headLayer")._testables;

test("normConv: tek ağırlıklı bölgedeki sabit değer ağırlıksız bölgeye yayılır", () => {
  const W = 64, H = 64, val = new Float32Array(W * H * 3), wgt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < 16; x++) { const i = y * W + x; wgt[i] = 1; val[i * 3] = 10; val[i * 3 + 1] = -5; val[i * 3 + 2] = 3; }
  const { res, conf } = normConv(val, wgt, W, H, 12, 3);
  const i = 32 * W + 24;
  assert.ok(conf[i] > 1e-3);
  assert.ok(Math.abs(res[i * 3] - 10) < 0.5 && Math.abs(res[i * 3 + 1] + 5) < 0.5 && Math.abs(res[i * 3 + 2] - 3) < 0.5);
});

test("katmanlı yol: yalnız bükme çizgiyi eğecekken ve gerçek küçültmede; güç 0.9; kıyafet plakada değil", () => {
  const hw = fs.readFileSync(path.join(__dirname, "..", "headWarp.js"), "utf8");
  const hl = fs.readFileSync(path.join(__dirname, "..", "headLayer.js"), "utf8");
  assert.match(hw, /const LAYER_ON = true;/);
  assert.match(hw, /layered = LAYER_ON, layerRollMinDeg = LAYER_ROLL_MIN_DEG, layerDebug = null \} = \{\}\) \{/);
  // Yönlendirme: önce bugünkü bükme; line-bend + (gerçek küçültme ya da belirgin eğim) katmanlı;
  // olmazsa yarım güç. Yalnız eğim karesi bugün hiç düzeltilmiyordu (7bbdad12 c5 8°).
  assert.match(hw, /if \(layered && r\.reason === "line-bend" && !keepBackground && !lineKeep && r\.s != null && \(layerShrinks \|\| rollOnly\)\) \{/);
  // Düz çizgili arka planda yalnız eğim (ölçek 1): bugün hiç dokunulmuyordu.
  assert.match(hw, /if \(layered && r\.reason === "structured-background" && !keepBackground && !lineKeep && \(rollOnly \|\| structShrink\)\) \{/);
  assert.match(hw, /scaleHeadLayered\(outputBuf, \{ \.\.\.plan, s: structShrink \? plan\.s : 1 \}, lm, templateBuf,/);
  const { LAYER_ROLL_MIN_DEG } = require("../headWarp")._testables;
  assert.strictEqual(LAYER_ROLL_MIN_DEG, Infinity); // 11-10 v8: yalnız-eğim kapalı
  // 11-12 41589067 c5: katmanlı yola geçiş ölçülen plana göre (bükmenin çizgiyle kısılmış ölçeğine göre değil).
  assert.strictEqual(require("../headWarp")._testables.LAYER_ROUTE.DECIDE_ON_PLAN, true);
  assert.match(hw, /const layerShrinks = LAYER_ROUTE\.DECIDE_ON_PLAN \? layerS <= 1 - LR_MIN_SCALE_CHANGE/);
  // Birleştirme: kaynağın arka planı (kişisiz q) ve kafa maskesi arka plana taşınca α düşer.
  assert.strictEqual(LAYER.RESID_BG_ON, true);
  assert.strictEqual(LAYER.MATTE_ON, true);
  assert.match(hw, /r = rl\.applied \? \{ \.\.\.rl, bendGate: r\.bendGate \} : \{ \.\.\.r, layerReason: rl\.reason \};/);
  // Güç 0.9 (kör A/B: tam güç ölçümün abarttığı karede kafayı base'den küçük yaptı).
  assert.strictEqual(LAYER.STRENGTH, 0.9);
  assert.match(hl, /field: true, bendGateOn: false, lineKeep: false, warpStrength \}\);/);
  // Birleştirme: bükülmüş + (1 − α)(B(p) − B(q)).
  assert.match(hl, /warped\[g \+ c\] \+ \(1 - a\) \* \(B\[g \+ c\] - bq\)/);
  // Kıyafet/nesne plakaya girmez (boyun derisi girer); soluk tel yalnız düz yüzeyde.
  assert.match(hl, /if \(cloth\[g\] >= 0\.5 && head\[g\] < 0\.5\) continue;/);
  assert.match(hl, /if \(flat > LAYER\.STRAND_FLAT\) continue;/);
  assert.ok(LAYER.MIN_LEFT_MS >= 60 * 1000);
  // Hizalama güvensizse şablon plaka/tel için kullanılmaz (f358a3e1 c9 duvarda çerçeve çizgisi).
  assert.ok(LAYER.TPL_NCC_MIN >= 0.6 && LAYER.TPL_NCC_MIN <= 0.7);
  assert.match(hl, /const tValid = \(x, y\) => \{ if \(!tplOk\) return false;/);
  // İkinci LaMa geçişinde yeni kişinin örttüğü yer bağlam dışı (c8 saç üstü koyu uzantı).
  assert.match(hl, /lama2Px = await lamaInto\(B, FW, FH, roi, nG, extra2,/);
  // Düz yüzeyde LaMa yerine yumuşak dolgu.
  assert.strictEqual(LAYER.FLAT_ON, false); // 11-10 v8: eski kafa dış hattı hale bıraktı
  assert.strictEqual(LAYER.CLOTH_SKIN_ON, true); // 11-12 41589067 c4: yaka ucunda kıyafet sanılan boyun teni/gölge plakaya
});

test("flatFill: düz bağlamda delik çevre rengiyle dolar, dokulu bağlamda LaMa kalır", () => {
  const { flatFill } = require("../headLayer")._testables;
  const W = 120, H = 120, N = W * H, faceH = 100;
  const mk = (tex) => {
    const B = Buffer.alloc(N * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = tex ? ((x >> 2) + (y >> 2)) % 2 ? 40 : 200 : 100; B.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3); }
    const take = new Uint8Array(N), zero = new Uint8Array(N), o = new Float32Array(N), cloth = new Float32Array(N);
    for (let y = 50; y < 70; y++) for (let x = 50; x < 70; x++) { take[y * W + x] = 1; B.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3); }
    return { B, take, zero, o, cloth };
  };
  const f = mk(false);
  const n = flatFill(f.B, W, { rx0: 0, ry0: 0, RW: W, RH: H }, f.take, f.zero, f.zero, f.o, f.cloth, faceH);
  assert.ok(n > 300);
  assert.ok(Math.abs(f.B[(60 * W + 60) * 3] - 100) < 8, `düz: ${f.B[(60 * W + 60) * 3]}`);
  const t = mk(true);
  flatFill(t.B, W, { rx0: 0, ry0: 0, RW: W, RH: H }, t.take, t.zero, t.zero, t.o, t.cloth, faceH);
  assert.strictEqual(t.B[(60 * W + 60) * 3], 255);
});

// 2026-11-13 (c7): düz çizgili arka planda da, yüz base'den ≥1.08 büyükse katmanlı küçültme.
test("düz çizgili arka plan: yüz belirgin büyükse katmanlı küçültme açık (eşik 1.08)", () => {
  const w = require("../headWarp")._testables;
  assert.strictEqual(w.STRUCT_SHRINK_ON, true);
  assert.strictEqual(w.STRUCT_SHRINK_MIN_FACE_RATIO, 1.08);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "headWarp.js"), "utf8");
  assert.match(src, /const structShrink = STRUCT_SHRINK_ON && layerShrinks && hs\.faceRatio >= STRUCT_SHRINK_MIN_FACE_RATIO;/);
  assert.match(src, /\{ \.\.\.plan, s: structShrink \? plan\.s : 1 \}/);
});
