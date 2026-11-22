"use strict";
// ŞABLON VİZYON ÖNBELLEĞİ + ŞABLON MST OYLAMASI (2026-11-22).
const test = require("node:test");
const assert = require("node:assert");
const TV = require("../templateVision");
const SP = require("../skinPigment")._testables;

function fakeDb(initial = {}) {
  const docs = { ...initial }, writes = [];
  return {
    docs, writes,
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: !!docs[id], get: (f) => (docs[id] ? docs[id][f] : undefined) }),
        set: async (v) => { writes.push({ id, v }); docs[id] = { ...(docs[id] || {}), ...v }; },
      }),
    }),
  };
}

test("voteMst: medyan, iki oyda yuvarlanmış ortalama, oy yoksa null", () => {
  assert.strictEqual(SP.voteMst([4, 5, 9]), 5);
  assert.strictEqual(SP.voteMst([8, null, 9]), 9);
  assert.strictEqual(SP.voteMst([3, 5]), 4);
  assert.strictEqual(SP.voteMst([7]), 7);
  assert.strictEqual(SP.voteMst([null, null]), null);
  assert.deepStrictEqual(SP.TEMPLATE_PADS, [0.5, 1.5, 4]);
});

test("önbellek: ilk sorulur ve yazılır, sonra bellekten; başarısız yargı yazılmaz", async () => {
  TV._testables.MEM.clear();
  const db = fakeDb();
  const buf = Buffer.from("şablon-a");
  let calls = 0;
  const compute = async () => { calls++; return { mst: 8, votes: [8, 8, 9] }; };
  const good = (v) => Number.isFinite(v.mst);
  const r1 = await TV.cachedJudgement(buf, "mst", compute, good, { db });
  assert.strictEqual(r1.cache, "yeni");
  assert.strictEqual(db.writes.length, 1);
  const r2 = await TV.cachedJudgement(buf, "mst", compute, good, { db });
  assert.strictEqual(r2.cache, "bellek");
  assert.strictEqual(calls, 1);

  const bad = Buffer.from("şablon-b");
  const r3 = await TV.cachedJudgement(bad, "eyewear", async () => ({ ok: false, reason: "http-500" }), (v) => v.ok === true, { db });
  assert.strictEqual(r3.value.ok, false);
  assert.strictEqual(db.writes.length, 1, "hata önbelleğe girmez");
});

test("önbellek: başka örnekte Firestore kaydı okunur; sürüm farklıysa yeniden sorulur", async () => {
  TV._testables.MEM.clear();
  const buf = Buffer.from("şablon-c");
  const id = TV._testables.keyOf(buf);
  const db = fakeDb({ [id]: { eyewear: { version: TV._testables.VERSION.eyewear, value: { ok: true, eyewear: true, eyesVisible: false } } } });
  let calls = 0;
  const r = await TV.cachedJudgement(buf, "eyewear", async () => { calls++; return { ok: true, eyewear: false }; }, (v) => v.ok === true, { db });
  assert.strictEqual(r.cache, "firestore");
  assert.strictEqual(r.value.eyewear, true);
  assert.strictEqual(calls, 0);

  TV._testables.MEM.clear();
  const old = fakeDb({ [id]: { eyewear: { version: 0, value: { ok: true, eyewear: true } } } });
  const r2 = await TV.cachedJudgement(buf, "eyewear", async () => { calls++; return { ok: true, eyewear: false }; }, (v) => v.ok === true, { db: old });
  assert.strictEqual(r2.cache, "yeni");
  assert.strictEqual(r2.value.eyewear, false);
});

test("önbellek: Firestore okuma hatası işi durdurmaz", async () => {
  TV._testables.MEM.clear();
  const db = { collection: () => ({ doc: () => ({ get: async () => { throw new Error("izin yok"); }, set: async () => { throw new Error("izin yok"); } }) }) };
  const r = await TV.cachedJudgement(Buffer.from("şablon-d"), "mst", async () => ({ mst: 3, votes: [3] }), (v) => Number.isFinite(v.mst), { db });
  assert.strictEqual(r.value.mst, 3);
});
