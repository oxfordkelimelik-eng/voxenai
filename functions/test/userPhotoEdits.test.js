"use strict";
// KULLANICI FOTO DÜZENLEYİCİSİ (2026-11-22): yol doğrulaması ve kayıt listesi.
const test = require("node:test");
const assert = require("node:assert");
const T = require("../opsPanel")._testables;

const B = "gs://rise-up-9235f.firebasestorage.app";
const job = {
  approvedPhotoUrls: [`${B}/dating_results/u1/j1/photos_0_0.jpg`, `${B}/dating_results/u1/j1/manual_x.jpg`],
};

test("teslim karesi kabul; jobId yoldan", () => {
  const r = T.parseUserResultRef(`${B}/dating_results/u1/j1/photos_0_0.jpg`, "u1", job);
  assert.deepStrictEqual(r, { jobId: "j1", path: "dating_results/u1/j1/photos_0_0.jpg" });
  assert.strictEqual(T.parseUserResultRef(`${B}/dating_results/u1/j1/manual_x.jpg`, "u1", job).jobId, "j1");
});

test("başkasının karesi, onay havuzu, yedek ve alt klasör reddedilir", () => {
  const bad = [
    `${B}/dating_results/u2/j1/photos_0_0.jpg`, // başka kullanıcı
    `${B}/dating_staging/u1/j1/photos_0_0.jpg`, // onay havuzu
    `${B}/dating_results/u1/j1/photos_0_0.jpg.orijinal.jpg`, // yedek
    `${B}/dating_results/u1/j1/photos_0_0.jpg.flas_alan.png`,
    `${B}/dating_results/u1/j1/sub/photos_0_0.jpg`,
    `${B}/dating_results/u1/../u2/photos_0_0.jpg`,
    "https://example.com/x.jpg",
    null,
  ];
  for (const ref of bad) assert.throws(() => T.parseUserResultRef(ref, "u1"), (e) => /permission-denied|invalid-argument/.test(e.code), String(ref));
});

test("biçimi doğru ama teslim edilmemiş kare reddedilir", () => {
  assert.throws(() => T.parseUserResultRef(`${B}/dating_results/u1/j1/photos_0_5.jpg`, "u1", job), (e) => e.code === "permission-denied");
});

test("eski işler: approvedPhotoUrls yoksa bitmiş sonuçlar teslim sayılır", () => {
  const old = { results: { a: { status: "done", photoUrls: ["x", "y"] }, b: { status: "failed", photoUrls: ["z"] } } };
  assert.deepStrictEqual(T.deliveredUrlsOf(old), ["x", "y"]);
  assert.deepStrictEqual(T.deliveredUrlsOf({ approvedPhotoUrls: [], results: { a: { status: "done", photoUrls: ["x"] } } }), [], "alan varsa boşluğu belirleyici");
});

test("kayıt listesi: ekler, değiştirir, null siler", () => {
  let l = T.upsertEditRecord(undefined, "r1", { glow: true }, "user", 1);
  assert.deepStrictEqual(l, [{ ref: "r1", edits: { glow: true }, by: "user", at: 1 }]);
  l = T.upsertEditRecord(l, "r2", { flash: 50 }, null, 2);
  l = T.upsertEditRecord(l, "r1", { flash: 10 }, "user", 3);
  assert.deepStrictEqual(l.map((r) => [r.ref, r.edits]), [["r2", { flash: 50 }], ["r1", { flash: 10 }]]);
  l = T.upsertEditRecord(l, "r2", null, "user", 4);
  assert.deepStrictEqual(l.map((r) => r.ref), ["r1"]);
  assert.strictEqual(T.RESULT_EDITS_FIELD, "resultPhotoEdits");
});
