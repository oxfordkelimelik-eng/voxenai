const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chooseCandidate } = require("../falPhotos")._testables;

test("chooseCandidate: ikisi de kapıları geçiyorsa yönü şablona en yakın aday seçilir", () => {
  assert.equal(chooseCandidate([{ drift: 0.21, dist: 0.40 }, { drift: 0.04, dist: 0.45 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.03, dist: 0.40 }, { drift: 0.30, dist: 0.30 }]), 0);
});

test("chooseCandidate: ikisi de geçemiyorsa eski kural (yön)", () => {
  assert.equal(chooseCandidate([{ drift: 0.21, dist: 0.55 }, { drift: 0.04, dist: 0.60 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.40, dist: 0.30 }, { drift: 0.50, dist: 0.30 }]), 0);
});

test("chooseCandidate: sapmalar neredeyse eşitse kimliği yakın olan seçilir", () => {
  assert.equal(chooseCandidate([{ drift: 0.06, dist: 0.58 }, { drift: 0.08, dist: 0.49 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.06, dist: 0.42 }, { drift: 0.08, dist: 0.40 }]), 1);
});

test("chooseCandidate: ölçülemeyen aday (Infinity) seçilmez; kimlik yoksa yön karar verir", () => {
  assert.equal(chooseCandidate([{ drift: Infinity, dist: 0.3 }, { drift: 0.25, dist: 0.6 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.07, dist: null }, { drift: 0.05, dist: 0.4 }]), 1);
});

// 2026-11-13, iş e67abb0e c9: yön=[0.35,0.43] → sapma [0.17,0.26], kimlik [0.53,0.45].
// Eski kural 1.'yi (kimlikten elenen) seçiyordu; kapıyı geçen 2. seçilmeli.
test("chooseCandidate: yalnız biri kimlik+yön kapısını geçiyorsa o seçilir (e67abb0e c9)", () => {
  assert.equal(chooseCandidate([{ drift: 0.17, dist: 0.53 }, { drift: 0.26, dist: 0.45 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.03, dist: 0.60 }, { drift: 0.30, dist: 0.40 }]), 1);
  // Yön kapısını (0.35) geçemeyen, kimliği iyi olsa da seçilmez.
  assert.equal(chooseCandidate([{ drift: 0.40, dist: 0.30 }, { drift: 0.10, dist: 0.45 }]), 1);
  assert.equal(chooseCandidate([{ drift: 0.10, dist: 0.45 }, { drift: 0.40, dist: 0.30 }]), 0);
});

// 2026-11-13 (e67abb0e c5/c7): seçim YAW KAPISI'nın 3B kararını da bilir.
test("chooseCandidate: 3B kapıdan elenecek aday (over3d) seçilmez", () => {
  assert.equal(chooseCandidate([{ drift: 0.10, dist: 0.40, over3d: true }, { drift: 0.30, dist: 0.45, over3d: false }]), 1);
  // İkisi de 3B'den elenecekse eski kural.
  assert.equal(chooseCandidate([{ drift: 0.10, dist: 0.40, over3d: true }, { drift: 0.30, dist: 0.45, over3d: true }]), 0);
  // over3d ölçülemediyse (undefined) etkisiz.
  assert.equal(chooseCandidate([{ drift: 0.10, dist: 0.40 }, { drift: 0.30, dist: 0.45 }]), 0);
});

test("yawOver3d: YAW KAPISI kuralı (≥10° fazla dönük, aynı yön, ±50° içinde, iki ağ)", () => {
  const { yawOver3d } = require("../falPhotos")._testables;
  const m = (yaw) => ({ yaw, src: "mesh" });
  assert.deepEqual(yawOver3d(m(-20.7), m(-34.1)).over, true); // e67abb0e c7
  assert.deepEqual(yawOver3d(m(-34.8), m(-47.5)).over, true); // e67abb0e c5
  assert.equal(yawOver3d(m(-17.3), m(-25.0)).over, false); // e67abb0e c1 (−7.7°)
  assert.equal(yawOver3d(m(-20), m(25)).over, false); // ters yön: bu kural değil
  assert.equal(yawOver3d(m(2), m(-13)).over, true); // cephe şablon: yön şartı yok
  assert.equal(yawOver3d(m(-45), m(-56)).use3d, false); // ağ profilde güvenilmez
  assert.equal(yawOver3d(m(-20), { yaw: -40, src: "68" }).use3d, false);
  assert.equal(yawOver3d(null, m(-40)).over, false);
  assert.ok(Math.abs(yawOver3d(m(-20.7), m(-34.1)).d - 13.4) < 1e-9);
});
