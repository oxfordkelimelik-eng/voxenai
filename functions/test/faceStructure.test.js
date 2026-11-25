"use strict";
// YÜZ YAPISI (faceDetail.structOf) — 2026-11-25, 947807a7 c9: koyu sakal–açık deri kenarı banda
// girip yüzü griye açıyordu. Bant yalnız açık deride, normalize ve sıfır ortalamalı olmalı.
const test = require("node:test");
const assert = require("node:assert");
const { structOf } = require("../faceDetail");

const CLASSES = { faceSkin: 0 };
function scene({ beard }) {
  const W = 200, H = 200, N = W * H;
  const rgb = Buffer.alloc(N * 3), P = [new Float32Array(N)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const inFace = x >= 50 && x < 150 && y >= 40 && y < 170;
    let v = 15; // karanlık arka plan
    if (inFace) {
      P[0][i] = 1; // skinSeg sakalı da yüz derisi sayıyor
      v = 70 + 12 * Math.sin(x / 9) * Math.sin(y / 11); // orta ölçek gölge
      if (beard && y >= 120) v = 20; // koyu sakal
    }
    rgb[i * 3] = v * 1.25; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v * 0.8;
  }
  return { rgb, W, H, P, box: { x0: 50, x1: 150, y0: 40, y1: 170 } };
}

test("structOf: sakal kenarı yapı ölçüsünü şişirmez", () => {
  const a = scene({ beard: false }), b = scene({ beard: true });
  const sa = structOf(a.rgb, a.W, a.H, a.P, CLASSES, a.box);
  const sb = structOf(b.rgb, b.W, b.H, b.P, CLASSES, b.box);
  assert.ok(sa && sb);
  // Eski bantta sakal kenarı ölçüyü katlıyordu; artık sakal ağırlık dışı.
  assert.ok(sb.rel < sa.rel * 1.3, `sakallı ${sb.rel} sakalsız ${sa.rel}`);
});

test("structOf: bant açık deride sıfır ortalamalı, sakal ağırlık dışı", () => {
  const s = scene({ beard: true });
  const r = structOf(s.rgb, s.W, s.H, s.P, CLASSES, s.box);
  let sum = 0, n = 0, beardW = 0;
  for (let y = 0; y < r.ch; y++) for (let x = 0; x < r.cw; x++) {
    const j = y * r.cw + x, gy = y + r.cy0;
    if (r.w[j] > 0.6) { sum += r.D[j]; n++; }
    if (gy >= 125 && gy < 165 && x + r.cx0 >= 60 && x + r.cx0 < 140) beardW = Math.max(beardW, r.w[j]);
  }
  assert.ok(Math.abs(sum / n) < 1e-3, `ortalama ${sum / n}`);
  assert.strictEqual(beardW, 0);
});

// KOYU ŞABLON AÇMA SINIRI (faceTone.capDarkerTemplate) — 2026-11-25, 947807a7 c8: MST 4/6 farkı yüzü
// ×1.20 açıyordu. Pigment karartmayı engeller, kendi başına açmaz.
const { _testables: FT } = require("../faceTone");
test("capDarkerTemplate: yalnız pigmentten gelen açma kesilir", () => {
  const Y = (l) => ((l + 16) / 116) ** 3;
  const tpl = { Y: Y(45), a: 15, b: 18 }, out = { Y: Y(44), a: 15, b: 18 };
  const plan = FT.planTone(tpl, out, 1.2);
  assert.ok(plan.logGain > 0.04);
  const cap = FT.capDarkerTemplate(plan, tpl, out, 1.2);
  assert.ok(cap && plan.logGain === 0, `kazanç ${plan.logGain}`);
});
test("capDarkerTemplate: karartmaya ve ışıktan gelen açmaya dokunmaz", () => {
  const Y = (l) => ((l + 16) / 116) ** 3;
  const dark = FT.planTone({ Y: Y(30) }, { Y: Y(42) }, 1.2);
  assert.ok(dark.logGain < 0);
  assert.strictEqual(FT.capDarkerTemplate(dark, { Y: Y(30) }, { Y: Y(42) }, 1.2), null);
  const lit = FT.planTone({ Y: Y(55) }, { Y: Y(40) }, 1.2);
  const before = lit.logGain;
  FT.capDarkerTemplate(lit, { Y: Y(55) }, { Y: Y(40) }, 1.2);
  const p0 = FT.planTone({ Y: Y(55) }, { Y: Y(40) }, 1);
  assert.ok(lit.logGain <= before && Math.abs(lit.logGain - Math.max(0, p0.logGain)) < 1e-9 || lit.logGain === before);
});
