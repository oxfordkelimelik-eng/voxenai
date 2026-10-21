const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chooseCandidate } = require("../falPhotos")._testables;

test("chooseCandidate: yönü şablona en yakın aday seçilir", () => {
  assert.equal(chooseCandidate([{ drift: 0.21, dist: 0.40 }, { drift: 0.04, dist: 0.55 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.03, dist: 0.60 }, { drift: 0.30, dist: 0.40 }]), 0);
});

test("chooseCandidate: sapmalar neredeyse eşitse kimliği yakın olan seçilir", () => {
  assert.equal(chooseCandidate([{ drift: 0.06, dist: 0.58 }, { drift: 0.08, dist: 0.49 }]), 1);
});

test("chooseCandidate: ölçülemeyen aday (Infinity) seçilmez; kimlik yoksa yön karar verir", () => {
  assert.equal(chooseCandidate([{ drift: Infinity, dist: 0.3 }, { drift: 0.25, dist: 0.6 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.07, dist: null }, { drift: 0.05, dist: 0.4 }]), 1);
});
