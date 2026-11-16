const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ownEyeThroughLens, OWN_EYE_TINT_TOP_MAX } = require("../eyewearOwnEye");

const SRC_EW = fs.readFileSync(path.join(__dirname, "..", "eyewear.js"), "utf8");
const SRC_OE = fs.readFileSync(path.join(__dirname, "..", "eyewearOwnEye.js"), "utf8");
const SRC_FP = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");

test("üst karartma kapısı 0.60 (kör test: c4 0.63 ve tonsuz c5 kapalı)", () => {
  assert.equal(OWN_EYE_TINT_TOP_MAX, 0.6);
  assert.match(SRC_OE, /const OWN_EYE_TINT_TOP_MAX = 0\.6;/);
  // ton adımı atlanırsa (c5) ya da üst katsayı sınırı aşarsa cam düşer
  assert.match(SRC_OE, /if \(t\.skipped\) fail\.push/);
  assert.match(SRC_OE, /!\(kTop <= OWN_EYE_TINT_TOP_MAX\)/);
});

test("eyewear.finish: açma anahtarı, try/catch ile hata güvenli, ownEye sonucu döner", () => {
  assert.match(SRC_EW, /const OWN_EYE_ON = true;/);
  const fin = SRC_EW.slice(SRC_EW.indexOf("const finish = async"));
  // 2026-11-12: kendi göz + cam tonu tek işlevde (eyewearLensTint.ownEyeThenTint)
  const iCall = fin.indexOf("ownEyeThenTint(");
  assert.ok(iCall > 0, "finish kendi göz adımını çağırmıyor");
  assert.ok(fin.indexOf("compositeEyewear(") < iCall, "kendi göz bileşimden sonra çalışmalı");
  assert.ok(fin.lastIndexOf("if (OWN_EYE_ON || LENS_TINT_ON)", iCall) > 0, "ON anahtarı yok");
  const tryAt = fin.lastIndexOf("try {", iCall), catchAt = fin.indexOf("} catch (e)", iCall);
  assert.ok(tryAt > 0 && catchAt > iCall, "çağrı try/catch içinde değil");
  // hata yolunda buf değişmez, yalnız neden yazılır
  assert.doesNotMatch(fin.slice(catchAt, fin.indexOf("}", catchAt + 12)), /buf =/);
  assert.match(fin, /return \{ buf, grown, grownRejected, lensPx, ownEye, lensTint \};/);
  assert.match(SRC_FP, /kendiGözCam=\$\{fin\.ownEye/);
});

test("geçersiz kırpım: uygulanmaz, ağ/şablon hiç çalışmaz", async () => {
  const r = await ownEyeThroughLens({ W: 100, H: 100, rect: { left: 90, top: 0, side: 50 }, geom: { iod: 30, cosY: 1 } });
  assert.equal(r.applied, false);
  assert.equal(r.rgb, null);
  assert.equal(r.reason, "bad-rect");
});

// Gerçek kareler (11-12 elegance_tall): c2 geçişli açık cam, model gözü kameraya
// bakan açık gözle çizdi → uygulanır; c7 koyu cam → uygulanmaz (template-dark).
const ROOT = path.join(__dirname, "..", "..", "ciktilar");
const HAM = path.join(ROOT, "2026-11-12_onur_elegance_tall", "ham_eyewear");
const TPL = path.join(ROOT, "2026-11-09_onur_elegance_tall", "sablon");
for (const [c, want] of [["c2", true], ["c7", false]]) {
  const files = [path.join(HAM, `${c}_teslim_oncesi.png`), path.join(HAM, `${c}_ai.png`), path.join(TPL, `${c}.jpg`)];
  test(`gerçek kare 11-12 ${c}: kendi göz ${want ? "uygulanır" : "uygulanmaz"}`, { skip: !files.every((f) => fs.existsSync(f)) && "yerel veri yok", timeout: 120000 }, async () => {
    const { prepareEyewear } = require("../eyewear");
    const [pre, ai, tpl] = files.map((f) => fs.readFileSync(f));
    const job = await prepareEyewear(pre, tpl);
    assert.ok(job.finish, job.reason);
    const fin = await job.finish(ai, { keepEyes: "hide" });
    assert.ok(fin.ownEye, "ownEye sonucu yok");
    assert.equal(fin.ownEye.applied, want, fin.ownEye.reason);
    if (!want) assert.equal(fin.ownEye.reason, "template-dark");
  });
}

test("kendi göz adımı üretimde işçi havuzunda (segmentasyon ana iş parçacığına yüklenmez)", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /ownEyeRunner: \(p\) => runPostTask\("eyewearOwnEye", p\)/);
  assert.strictEqual(typeof require("../postTasks").eyewearOwnEye, "function");
});
