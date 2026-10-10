const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseHeadGhostReply, parseEyewearReply, headCropRect, PROMPT } = require("../headGhost");

test("kalıntı cevabı: GHOST bağlayıcı, gerekçe işaretlenen bölgenin betimlemesi", () => {
  const r = parseHeadGhostReply("ABOVE: sky, faint hair outline\nLEFT: wall\nRIGHT: wall\nLEFTOVER: GHOST\nWHERE: ABOVE");
  assert.deepEqual(r, { ok: true, bad: true, where: "ABOVE", detail: "sky, faint hair outline" });
});

test("kalıntı cevabı: NONE geçer, gerekçe üç betimleme", () => {
  const r = parseHeadGhostReply("ABOVE: curtain\nLEFT: wall\nRIGHT: window\nLEFTOVER: NONE\nWHERE: NONE");
  assert.equal(r.ok, true);
  assert.equal(r.bad, false);
  assert.equal(r.detail, "curtain / wall / window");
});

test("kalıntı cevabı: LEFTOVER satırı yoksa okunamadı (ELEMEZ)", () => {
  assert.equal(parseHeadGhostReply("ABOVE: sky\nfaint halo").ok, false);
  assert.equal(parseHeadGhostReply("").ok, false);
});

// 2026-10-10 ilk ölçüm: örnek cümle ("grey hair halo above the head") verilince
// model 83 temiz karenin 31'ine aynı cümleyle GHOST dedi.
test("kalıntı promptu: örnek gerekçe cümlesi içermez, önce betimletir", () => {
  assert.ok(!/halo above the head/i.test(PROMPT));
  assert.ok(/Step 1/.test(PROMPT) && /Step 2/.test(PROMPT));
});

test("gözlük cevabı", () => {
  assert.deepEqual(parseEyewearReply("EYEWEAR: YES"), { ok: true, eyewear: true });
  assert.deepEqual(parseEyewearReply("eyewear: no"), { ok: true, eyewear: false });
  assert.equal(parseEyewearReply("maybe").ok, false);
});

test("kırpım kafanın üstünü ve yanlarını kapsar, görüntü dışına taşmaz", () => {
  const box = { x: 400, y: 300, width: 100, height: 120 };
  const r = headCropRect(box, 1000, 1400);
  assert.ok(r.left <= 400 - 90 && r.left + r.width >= 500 + 90);
  assert.ok(r.top <= 300 - 150);
  const edge = headCropRect({ x: 10, y: 5, width: 100, height: 120 }, 300, 400);
  assert.ok(edge.left >= 0 && edge.top >= 0 && edge.left + edge.width <= 300 && edge.top + edge.height <= 400);
});
