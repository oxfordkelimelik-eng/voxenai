const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../faceTone")._testables;
const G = require("../faceGlow")._testables;

test("yüz=boyun: dikey ışık eğimi kapalı (boyun yüzle aynı çarpanı alır), yatay eğim kalır", () => {
  const tpl = { Y: 0.05, a: 15, b: 20, slope: { gu: 0.5, gv: -1.5 } };
  const out = { Y: 0.06, a: 15, b: 20, slope: { gu: -0.2, gv: 0 } };
  const p = T.planTone(tpl, out, 1);
  assert.equal(p.gv, 0);
  assert.ok(Math.abs(p.gu) > 0.08);
  T.NECK_TONE.ON = false;
  try {
    assert.ok(T.planTone(tpl, out, 1).gv < 0, "kapalıyken eski dikey eğim");
  } finally {
    T.NECK_TONE.ON = true;
  }
});

test("boyun rengi yüzün üst derisine çekilir; sınır ve ölü bant (CHROMA.NECK açıkken)", () => {
  // f8c1718b c7 ham: boyun a/b yüzden +4.6/+8.3 → boyun −4.6/−7 (sınır 7).
  assert.deepEqual(T.planNeckChroma({ a: 11.5, b: 12.8 }, {}, { a: 16.1, b: 21.1 }), { na: 0, nb: 0 }, "11-20 varsayılan kapalı");
  T.CHROMA.NECK = true;
  try {
    const r = T.planNeckChroma({ a: 11.5, b: 12.8 }, {}, { a: 16.1, b: 21.1 });
    assert.ok(Math.abs(r.na - -4.6) < 1e-9);
    assert.equal(r.nb, -T.NECK_TONE.CHROMA_MAX);
    assert.deepEqual(T.planNeckChroma({ a: 10, b: 10 }, {}, { a: 10.4, b: 10.5 }), { na: 0, nb: 0 });
    assert.deepEqual(T.planNeckChroma(null, {}, { a: 1, b: 1 }), { na: 0, nb: 0 });
    assert.deepEqual(T.planNeckChroma({ a: 1, b: 1 }, {}, null), { na: 0, nb: 0 });
  } finally {
    T.CHROMA.NECK = false;
  }
});

test("ışıklı: yüz sınırı tüm deriye (boyun, göğüs, el) uygulanır", () => {
  assert.equal(G.FACE_CAP.SKIN_ALL, true);
});

test("yatay ışık eğimi çenede söner: yüzde tam, boyunda yok (156fa173 c1 boyun yüzden 15 L açık kaldı)", () => {
  const W = require("../faceTone")._testables.sideLightWeight;
  const chin = 100, band = 10;
  assert.equal(W(50, chin, band), 1, "yüz ortası tam eğim");
  assert.equal(W(chin - band, chin, band), 1, "bant başı tam");
  assert.ok(Math.abs(W(chin, chin, band) - 0.5) < 1e-9, "çene çizgisinde yarı");
  assert.equal(W(chin + band, chin, band), 0, "bant sonu sıfır");
  assert.equal(W(200, chin, band), 0, "boyun eğim almaz");
  assert.equal(W(200, chin, 0), 1, "bant 0 → eski davranış");
});
