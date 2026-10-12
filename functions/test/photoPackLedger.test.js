const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("../photoPacks");

const stored = (o) => ({ 5: 0, 10: 0, 25: 0, ...o });

test("25 + 5 alan kullanıcıya yalnız 25 ve 5 sorulur, 10 sorulmaz", () => {
  let packs = P.addPack(null, 25);
  packs = P.addPack(packs, 5);
  assert.deepEqual(P.packOptions(30, packs), [25, 5]);
});

test("3 x 10 + 1 x 5 alan kullanıcıya 10 ve 5 sorulur", () => {
  let packs = null;
  for (const s of [10, 10, 10, 5]) packs = P.addPack(packs, s);
  assert.deepEqual(P.packOptions(35, packs), [10, 5]);
});

test("tek boy paket: tek seçenek (soru yok)", () => {
  assert.deepEqual(P.packOptions(25, P.addPack(null, 25)), [25]);
  assert.deepEqual(P.packOptions(20, stored({ 10: 2 })), [10]);
});

test("seçilen paket düşülür, diğerleri kalır", () => {
  const r = P.chargePacks(35, stored({ 10: 3, 5: 1 }), 5);
  assert.equal(r.consumed, 5);
  assert.deepEqual(P.packOptions(30, r.packs), [10]);
  const r2 = P.chargePacks(35, stored({ 10: 3, 5: 1 }), 10);
  assert.equal(r2.consumed, 10);
  assert.deepEqual(r2.packs, { 5: 1, 10: 2, 25: 0 });
});

test("defteri olmayan eski bakiye paket boylarına bölünür", () => {
  assert.deepEqual(P.packOptions(30, undefined), [25, 5]);
  assert.deepEqual(P.packOptions(35, {}), [25, 10]);
});

test("iadeden kalan birkaç hak paket sayılmaz", () => {
  // 25'lik pakette 22 teslim: 3 iade + yeni 10'luk paket
  assert.deepEqual(P.packOptions(13, stored({ 10: 1 })), [10]);
  assert.deepEqual(P.packOptions(3, stored({})), []);
});

test("seçimi bilmeyen eski istemci: bakiye düşer, defter tutarlı kalır", () => {
  // eski istemci 35 hakta en büyük boyu (25) gönderir
  const r = P.chargePacks(35, stored({ 10: 3, 5: 1 }), 25);
  assert.equal(r.consumed, null);
  const total = 5 * r.packs["5"] + 10 * r.packs["10"] + 25 * r.packs["25"];
  assert.ok(total <= 10, "defter kalan bakiyeyi aşıyor: " + total);
});

test("satın alma kredisinden paket boyu", () => {
  assert.equal(P.packSizeOfCredit({ photoBalance: 25, analysisBalance: 5 }), 25);
  assert.equal(P.packSizeOfCredit({ analysisBalance: 1 }), null);
});
