const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { lensTint, ownEyeThenTint, _testables: LT } = require("../eyewearLensTint");

const SRC_EW = fs.readFileSync(path.join(__dirname, "..", "eyewear.js"), "utf8");
const SRC_LT = fs.readFileSync(path.join(__dirname, "..", "eyewearLensTint.js"), "utf8");
const SRC_PT = fs.readFileSync(path.join(__dirname, "..", "postTasks.js"), "utf8");
const SRC_FP = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");

test("cam tonu: açma anahtarı eyewear.js'te, işçi yüküyle geçer", () => {
  assert.match(SRC_EW, /const LENS_TINT_ON = true;/);
  const fin = SRC_EW.slice(SRC_EW.indexOf("const finish = async"));
  assert.match(fin, /if \(OWN_EYE_ON \|\| LENS_TINT_ON\)/);
  assert.match(fin, /lensTintOn: LENS_TINT_ON/);
  assert.match(fin, /return \{ buf, grown, grownRejected, lensPx, ownEye, lensTint \};/);
});

test("cam tonu kendi gözden SONRA, hata güvenli (hata → önceki görüntü)", () => {
  const f = SRC_LT.slice(SRC_LT.indexOf("async function ownEyeThenTint"));
  const iOwn = f.indexOf("ownEyeThroughLens("), iTint = f.indexOf("await lensTint(");
  assert.ok(iOwn > 0 && iTint > iOwn, "sıra: kendi göz → cam tonu");
  const tryAt = f.lastIndexOf("try {", iTint), catchAt = f.indexOf("} catch (e)", iTint);
  assert.ok(tryAt > iOwn && catchAt > iTint, "cam tonu çağrısı kendi try/catch'inde değil");
  // hata yolunda görüntü değişmez, yalnız neden yazılır
  const catchBody = f.slice(catchAt, f.indexOf("}", catchAt + 12));
  assert.doesNotMatch(catchBody, /rgb =|png =/);
  // finish: işçi çağrısı da try/catch içinde, hata iki adıma da yazılır
  const fin = SRC_EW.slice(SRC_EW.indexOf("const finish = async"));
  const iRun = fin.indexOf("ownEyeRunner(p)");
  assert.ok(fin.lastIndexOf("try {", iRun) > 0 && fin.indexOf("} catch (e)", iRun) > iRun);
  assert.match(fin, /lensTint = \{ applied: false, reason \};/);
});

test("işçi havuzu: tek görevde kendi göz + cam tonu, havuzsuz yol aynı işlev", () => {
  const pt = SRC_PT.slice(SRC_PT.indexOf("async function eyewearOwnEye"));
  assert.match(pt.slice(0, 900), /require\("\.\/eyewearLensTint"\)\.ownEyeThenTint\(\{[^}]*lensTintOn/);
  assert.strictEqual(typeof require("../postTasks").eyewearOwnEye, "function");
  assert.match(SRC_FP, /ownEyeRunner: \(p\) => runPostTask\("eyewearOwnEye", p\)/);
  const fin = SRC_EW.slice(SRC_EW.indexOf("const finish = async"));
  assert.match(fin, /require\("\.\/eyewearLensTint"\)\.ownEyeThenTint\(\{ \.\.\.p, preRgb: baseRgb, fixRgb: rgb \}\)/);
});

test("GÖZLÜK EKLENDİ satırında camTonu", () => {
  assert.match(SRC_FP, /kendiGözCam=\$\{fin\.ownEye[^`]*camTonu=\$\{fin\.lensTint \? \(fin\.lensTint\.applied \? "UYGULANDI" : fin\.lensTint\.reason\) : "-"\}/);
});

test("V3b parametreleri", () => {
  assert.deepEqual(LT.FIND.DARK_TS, [20, 26]);
  assert.deepEqual(LT.FIND.CLOSES, [0.015, 0.03, 0.045, 0.06]);
  assert.equal(LT.FIND.RIM_COVER, 0.85);
  assert.equal(LT.TINT.BRIGHT, 0.45);
  assert.equal(LT.TINT.MIN_GAIN, 0.06);
  assert.equal(LT.TINT.FRAME_MIN_GAIN, 0.15);
  assert.equal(LT.TINT.HUE_LO, 0.92);
  assert.equal(LT.TINT.HUE_HI, 1.08);
  assert.equal(LT.FRAME_COL.S, 0.6);
});

test("geçersiz kırpım / koyu şablon: hiçbir ağ çalışmadan çıkar", async () => {
  const bad = await lensTint({ W: 100, H: 100, rect: { left: 90, top: 0, side: 50 }, geom: { iod: 30, cosY: 1 } });
  assert.deepEqual([bad.applied, bad.rgb, bad.reason], [false, null, "bad-rect"]);
  // preBuf yok: ağ hesaplanmaya kalkılsa hata atardı
  const dark = await lensTint({ W: 100, H: 100, rect: { left: 0, top: 0, side: 50 }, geom: { iod: 30, cosY: 1 }, ctx: { tpl: { bright: 0.2, lenses: [] } } });
  assert.deepEqual([dark.applied, dark.rgb, dark.reason], [false, null, "template-dark"]);
});

test("ownEyeThenTint: cam tonu hatası → görüntü değişmez, neden error:", async () => {
  const W = 64, H = 64, rgb = Buffer.alloc(W * H * 3, 128);
  const r = await ownEyeThenTint({ preBuf: Buffer.from("x"), preRgb: rgb, fixBuf: Buffer.from("x"), fixRgb: rgb, W, H, rect: { left: 0, top: 0, side: 40 }, geom: { iod: 20, cosY: 1 }, tplBuf: Buffer.from("bozuk"), ownEyeOn: false });
  assert.equal(r.png, null);
  assert.equal(r.rgb, null);
  assert.equal(r.ownEye.reason, "off");
  assert.equal(r.lensTint.applied, false);
  assert.match(r.lensTint.reason, /^error:/);
});

// Gerçek kareler (11-12 elegance_tall): c2 geçişli açık cam → iki cam tonlanır,
// çerçeve rengi; c7 koyu cam → hiç çalışmaz (template-dark).
const ROOT = path.join(__dirname, "..", "..", "ciktilar");
const HAM = path.join(ROOT, "2026-11-12_onur_elegance_tall", "ham_eyewear");
const TPL = path.join(ROOT, "2026-11-09_onur_elegance_tall", "sablon");
for (const [c, want] of [["c2", true], ["c7", false]]) {
  const files = [path.join(HAM, `${c}_teslim_oncesi.png`), path.join(HAM, `${c}_ai.png`), path.join(TPL, `${c}.jpg`)];
  test(`gerçek kare 11-12 ${c}: cam tonu ${want ? "uygulanır" : "uygulanmaz"}`, { skip: !files.every((f) => fs.existsSync(f)) && "yerel veri yok", timeout: 180000 }, async () => {
    const { prepareEyewear } = require("../eyewear");
    const [pre, ai, tpl] = files.map((f) => fs.readFileSync(f));
    const job = await prepareEyewear(pre, tpl);
    assert.ok(job.finish, job.reason);
    const fin = await job.finish(ai, { keepEyes: "hide" });
    assert.ok(fin.lensTint, "lensTint sonucu yok");
    assert.equal(fin.lensTint.applied, want, fin.lensTint.reason);
    if (want) assert.equal(fin.lensTint.reason, "applied:e0,1+frame");
    else assert.equal(fin.lensTint.reason, "template-dark");
  });
}
