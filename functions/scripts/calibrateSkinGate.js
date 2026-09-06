/**
 * Ten kapısı doğrulaması — üretimdeki SIRAYI birebir taklit eder:
 *   1) correctLimbChroma(kare, şablon, refSkinTone)  → uzuvları yüz tonuna boya
 *   2) assessSkinToneConsistency(boyanmış, şablon, null) → "uzuvlar yüzle aynı mı"
 *
 * Karşılaştırma için selfie hedefli eski ölçüm de basılır (teşhis).
 *
 * Klasörde downloadJob118.js / downloadJobFrames.js çıktısı beklenir:
 * accepted_NN.jpg, rejected_NN__cX_aY__gate.jpg, meta.json, tpl_cX.jpg.
 *
 * Kullanım: node scripts/calibrateSkinGate.js <klasör> [<klasör> …]
 */
const fs = require("fs");
const path = require("path");

function chunkOf(file) {
  const m = /__c(\d+)_a\d+__/.exec(file);
  if (m) return Number(m[1]);
  const a = /^accepted_(\d+)\.jpg$/i.exec(file);
  if (a) return Number(a[1]);
  return null;
}

(async () => {
  const { assessSkinToneConsistency, correctLimbChroma } = require("../faceQuality");
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("kullanım: node scripts/calibrateSkinGate.js <klasör> …");
    process.exit(1);
  }

  for (const dir of dirs) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    const refSkinTone = Array.isArray(meta.refSkinTone) ? meta.refSkinTone : null;
    console.log(`\n=== ${path.basename(dir)} (refSkinTone=${refSkinTone ? "var" : "yok"}) ===`);
    console.log("kare".padEnd(46) + "kroma        yüzeGöre  selfieHedef  karar");

    const files = fs.readdirSync(dir)
      .filter((f) => /^(accepted|rejected)_.*\.jpg$/i.test(f))
      .sort();
    for (const f of files) {
      const c = chunkOf(f);
      const tplPath = path.join(dir, `tpl_c${c}.jpg`);
      if (c == null || !fs.existsSync(tplPath)) {
        console.log(`${f.padEnd(46)} (şablon yok)`);
        continue;
      }
      const tpl = fs.readFileSync(tplPath);
      let buf = fs.readFileSync(path.join(dir, f));

      const cc = await correctLimbChroma(buf, tpl, refSkinTone);
      if (cc.applied && cc.buf) buf = cc.buf;
      const kroma = cc.applied ? "uygulandı" : `atlandı[${cc.reason}]`;

      const vsFace = await assessSkinToneConsistency(buf, tpl, null);
      const vsSelfie = await assessSkinToneConsistency(buf, tpl, refSkinTone);
      const fmt = (r) => (r.ratio == null ? `—(${r.reason || "?"})` : r.ratio.toFixed(3)).padStart(11);

      console.log(
        `${f.padEnd(46)}${kroma.padEnd(22)}${fmt(vsFace)}${fmt(vsSelfie)}  ` +
        `${vsFace.ok ? "GEÇER" : "RED"}`
      );
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
