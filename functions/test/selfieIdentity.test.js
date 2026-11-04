const { test } = require("node:test");
const assert = require("node:assert/strict");

// SELFIE'LER ARASI KİMLİK TUTARLILIĞI (2026-11-04, bkz.
// faceQuality.identityOutliers): beş selfie'nin aynı kişiye ait olduğu
// kontrolü. Vektörler yapay: aynı kişi = küçük sapmalar (gürültü 0.09 →
// mesafe ≈0.4, face-api'de aynı kişinin tipik aralığı), yabancı = uzak (≈1.6).
const { _testables: T, SELFIE_IDENTITY_MAX } = require("../faceQuality");

function vec(base, noise = 0, seed = 1) {
  const v = new Float32Array(128);
  let s = seed;
  for (let i = 0; i < 128; i++) {
    s = (s * 9301 + 49297) % 233280;
    v[i] = base[i] + noise * ((s / 233280) - 0.5);
  }
  return v;
}
const A = new Float32Array(128).fill(0.1);
const B = new Float32Array(128); for (let i = 0; i < 128; i++) B[i] = i % 2 ? 0.1 : -0.1; // A'dan uzak

test("identityOutliers: aynı kişinin beş açısı → aykırı yok", () => {
  const faces = [0, 1, 2, 3, 4].map((i) => ({ idx: i, d: vec(A, 0.09, i + 1) }));
  const r = T.identityOutliers(faces);
  assert.deepEqual(r.outliers, []);
  assert.equal(r.unreliable, undefined);
  assert.equal(r.minDist.length, 5);
  for (const m of r.minDist) assert.ok(m < SELFIE_IDENTITY_MAX, `enYakın ${m} eşiğin altında olmalı`);
});

test("identityOutliers: dört kare aynı kişi, biri yabancı → yalnız o aykırı", () => {
  const faces = [0, 1, 2, 3].map((i) => ({ idx: i, d: vec(A, 0.09, i + 1) }));
  faces.push({ idx: 4, d: vec(B, 0.1, 9) });
  const r = T.identityOutliers(faces);
  assert.deepEqual(r.outliers, [4]);
  assert.ok(r.minDist[4] > SELFIE_IDENTITY_MAX);
  // Yabancı kare dışarıda bırakılırsa ortalama vektör etkilenmez; bunu
  // analyzeReferences yapıyor (cleanDescriptors) — burada eşik kontrolü.
  const ab = T.euclideanDistanceLocal(A, B);
  assert.ok(ab > SELFIE_IDENTITY_MAX, `A-B mesafesi ${ab}`);
});

test("identityOutliers: eksik yüz vektörü (idx atlamalı) aykırı indeksini doğru verir", () => {
  // 1. selfie'de yüz bulunamadı → faceDescriptors'ta idx 1 yok.
  const faces = [0, 2, 3].map((i) => ({ idx: i, d: vec(A, 0.09, i + 1) }));
  faces.push({ idx: 4, d: vec(B, 0.1, 9) });
  const r = T.identityOutliers(faces);
  assert.deepEqual(r.outliers, [4]);
});

test("identityOutliers: ikiden az vektörde karar yok", () => {
  const r = T.identityOutliers([{ idx: 0, d: A }, { idx: 1, d: B }]);
  assert.deepEqual(r.outliers, []);
  assert.deepEqual(r.minDist, [null, null]);
});

test("identityOutliers: çoğunluk birbirinden uzaksa ölçüm güvenilmez, ret yok", () => {
  const C = new Float32Array(128).fill(-0.3);
  const faces = [
    { idx: 0, d: vec(A, 0.1, 1) },
    { idx: 1, d: vec(B, 0.1, 2) },
    { idx: 2, d: vec(C, 0.1, 3) },
  ];
  const r = T.identityOutliers(faces);
  assert.deepEqual(r.outliers, []);
  assert.equal(r.unreliable, true);
});

test("identityOutliers: eşik parametreyle değiştirilebilir", () => {
  const faces = [0, 1, 2].map((i) => ({ idx: i, d: vec(A, 0.09, i + 1) }));
  const strict = T.identityOutliers(faces, 0.01);
  // Hepsi birbirinden 0.01'den uzak → hepsi aykırı → çoğunluk → güvenilmez.
  assert.equal(strict.unreliable, true);
});
