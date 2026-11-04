const test = require("node:test");
const assert = require("node:assert");
const st = require("../skinTone");
const { _testables: PT } = require("../postTasks");

// 7e04933e c5: koyu sahnede zeytin-gri balıkçı yaka boyun derisi sanılıp kızıla boyandı.
test("yüze göre deri kapısı: el geçer, koyu örgü geçmez", () => {
  const face = [38, 8.6, 12.4];
  assert.ok(st.skinLikeVsFace([64.8, 17.2, 19.4], face) > 0.9, "el");
  assert.strictEqual(st.skinLikeVsFace([8.5, -0.2, 3.7], face), 0, "yaka");
});

test("yüz kilidinde boyun hariç, el dahil", () => {
  const box = { x: 100, y: 100, width: 100, height: 120 };
  assert.strictEqual(st.neckExclusion(150, 260, box), 0, "çene altı boyun");
  assert.strictEqual(st.neckExclusion(40, 600, box), 1, "el");
});

test("sade akışta ten alanı açık", () => {
  assert.strictEqual(PT.SKIN_FIELD_SIMPLE, true);
});
