// ZIT BAKIŞ kapısı gözlüklü şablonda susar (2026-11-12, 41589067 c2: renkli camın
// arkasındaki göz ölçülüp aşağı bakan doğru çıktı "zıt bakış" diye elendi).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("zıt bakış: şablon gözünde gözlük payı ≥0.5 ise iris ölçülmeden atlanır", () => {
  const { IRIS_TPL_GLASS_SKIP } = require("../gazeGate");
  assert.strictEqual(IRIS_TPL_GLASS_SKIP, 0.5);
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  const i = src.indexOf('runPostTask("eyeGlassShare", { tpl: tplBufForGaze })');
  const j = src.indexOf("ATLANDI[şablon-gözlük] gözlükPayı=");
  const k = src.indexOf("(await measureIrisGaze(tplBufForGaze)) || (await measureIrisGaze(tplBufForGaze, LOW_CONF_FACE))");
  assert.ok(i > 0 && j > i && k > j, "gözlük payı şablon irisinden önce ölçülmeli");
  assert.match(src, /if \(templateEyeGlass != null && templateEyeGlass >= IRIS_TPL_GLASS_SKIP\) \{/);
  // Ağır segmentasyon ana iş parçacığında değil, işçi havuzunda.
  assert.strictEqual(typeof require("../postTasks").eyeGlassShare, "function");
  assert.strictEqual(typeof require("../sunglassTransfer").eyeGlassShare, "function");
});

const TPL = path.join(__dirname, "..", "..", "ciktilar", "2026-11-09_onur_elegance_tall", "sablon");
test("eyeGlassShare: renkli camlı şablon yüksek, gözlüksüz şablon düşük", { skip: !fs.existsSync(path.join(TPL, "c2.jpg")) }, async () => {
  const { eyeGlassShare } = require("../sunglassTransfer");
  const g = await eyeGlassShare(fs.readFileSync(path.join(TPL, "c2.jpg")));
  const n = await eyeGlassShare(fs.readFileSync(path.join(TPL, "c0.jpg")));
  assert.ok(g >= 0.9, `gözlüklü: ${g}`);
  assert.ok(n != null && n < 0.1, `gözlüksüz: ${n}`);
});
