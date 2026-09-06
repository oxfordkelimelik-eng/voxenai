/**
 * Birim test: göğüs-üstü oran bandı + ref split sözleşmesi.
 * Çalıştır: node functions/scripts/testChestUpRefs.js
 */
const assert = require("assert");
const path = require("path");

const {
  isValidChestUpFaceRatio,
  MIN_FACE_RATIO_CHEST,
  MAX_FACE_RATIO_CHEST,
} = require(path.join(__dirname, "..", "faceQuality.js"));

const FACE = 3;
const CHEST = 2;

function splitRefUrls(refUrls) {
  if (!Array.isArray(refUrls) || refUrls.length === 0) {
    return { faceUrls: [], chestUrls: [], bodyUrl: null };
  }
  return {
    faceUrls: refUrls.slice(0, FACE),
    chestUrls: refUrls.slice(FACE),
    bodyUrl: null,
  };
}

function reorderFacesKeepChest(refUrls, bestIndex) {
  const faceUrls = refUrls.slice(0, FACE);
  const chestUrls = refUrls.slice(FACE);
  if (bestIndex == null || bestIndex >= FACE || !faceUrls[bestIndex]) {
    return [...faceUrls, ...chestUrls];
  }
  const best = faceUrls[bestIndex];
  return [best, ...faceUrls.filter((u) => u !== best), ...chestUrls];
}

// --- chest ratio ---
assert.strictEqual(isValidChestUpFaceRatio(0.04), false, "çok uzak");
assert.strictEqual(isValidChestUpFaceRatio(0.05), true, "alt sınır");
assert.strictEqual(isValidChestUpFaceRatio(0.20), true, "tipik göğüs-üstü");
assert.strictEqual(isValidChestUpFaceRatio(0.40), true, "üst sınır");
assert.strictEqual(isValidChestUpFaceRatio(0.41), false, "yakın yüz");
assert.strictEqual(isValidChestUpFaceRatio(null), false);
assert.ok(MIN_FACE_RATIO_CHEST < MAX_FACE_RATIO_CHEST);

// --- split ---
const urls = ["f0", "f1", "f2", "c0", "c1"];
const split = splitRefUrls(urls);
assert.deepStrictEqual(split.faceUrls, ["f0", "f1", "f2"]);
assert.deepStrictEqual(split.chestUrls, ["c0", "c1"]);
assert.strictEqual(split.bodyUrl, null);
assert.strictEqual(split.faceUrls.length + split.chestUrls.length, FACE + CHEST);

// --- best face reorder must not move chest ---
const reordered = reorderFacesKeepChest(urls, 2);
assert.deepStrictEqual(reordered, ["f2", "f0", "f1", "c0", "c1"]);
assert.deepStrictEqual(reordered.slice(FACE), ["c0", "c1"]);

const empty = splitRefUrls([]);
assert.deepStrictEqual(empty.faceUrls, []);
assert.deepStrictEqual(empty.chestUrls, []);

console.log("OK: chest-up oran + split + reorder testleri geçti");
