const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseGazeToken,
  isGazeMismatch,
  irisOffsetFromGray,
  isIrisGazeMismatch,
} = require("../gazeGate");

test("b1d697 c0 teslim: taban CAMERA, çıktı RIGHT → uyuşmazlık", () => {
  assert.equal(
    isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: RIGHT"),
    true
  );
});

test("aynı yöne bakıyorsa geçsin", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: RIGHT", "OUTPUT_GAZE: RIGHT"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: DOWN", "OUTPUT_GAZE: DOWN"), false);
});

test("satır yoksa fail-safe geçsin", () => {
  assert.equal(isGazeMismatch(null, "OUTPUT_GAZE: RIGHT"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", ""), false);
});

test("AWAY belirsizdir — tek tarafta olsa bile eleme yok", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: AWAY"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY", "OUTPUT_GAZE: RIGHT"), false);
});

test("token ayrıştırması satır önekini yutar", () => {
  assert.equal(parseGazeToken("BASE_GAZE: LEFT"), "LEFT");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY"), "AWAY");
  assert.equal(parseGazeToken("nonsense"), null);
});

test("koyu leke gözün sağındaysa iris x > 0.5", () => {
  const w = 20, h = 10;
  const gray = new Uint8Array(w * h).fill(200);
  for (let y = 2; y <= 7; y++) {
    for (let x = 12; x <= 16; x++) gray[y * w + x] = 20;
  }
  const r = irisOffsetFromGray(gray, w, h, [
    { x: 2, y: 2 }, { x: 17, y: 2 }, { x: 17, y: 7 }, { x: 2, y: 7 },
  ]);
  assert.ok(r);
  assert.ok(r.x > 0.55);
});

test("iris kayması 0.07 ve üstü uyuşmazlıktır", () => {
  assert.equal(
    isIrisGazeMismatch({ irisX: 0.50, irisY: 0.50, eyeWidth: 14 }, { irisX: 0.58, irisY: 0.50, eyeWidth: 14 }),
    true
  );
  assert.equal(
    isIrisGazeMismatch({ irisX: 0.50, irisY: 0.50, eyeWidth: 14 }, { irisX: 0.52, irisY: 0.50, eyeWidth: 14 }),
    false
  );
});

test("göz çok dar veya ölçü yoksa iris kapısı susar", () => {
  assert.equal(isIrisGazeMismatch({ irisX: 0.2, eyeWidth: 6 }, { irisX: 0.8, eyeWidth: 6 }), false);
  assert.equal(isIrisGazeMismatch(null, { irisX: 0.8, eyeWidth: 14 }), false);
});
