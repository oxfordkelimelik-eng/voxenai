/**
 * Kullanıcının gözle "silik el / ten uyuşmuyor" dediği kareleri ölçer.
 * Eşik ancak bu kareler dağılımın neresine düştüğü bilinerek konabilir.
 *
 * Kullanım: node scripts/measureComplainedFrames.js
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(process.env.TEMP, "job-2286-frames");
const FRAMES = [
  ["chunk0 (wellness, el cepte, hayalet el)", "OK_chunk0.jpg"],
  ["chunk1 (kahverengi takım, sağ el silik)", "OK_elegance_1_0.jpg"],
  ["chunk4 (eller cepte, kol tonu kırmızı)", "OK_elegance_4_0.jpg"],
  ["chunk3 (teslim, karşılaştırma)", "OK_chunk3.jpg"],
  ["chunk7 (yat, karşılaştırma)", "OK_chunk7.jpg"],
  ["chunk8 (kask, karşılaştırma)", "OK_chunk8.jpg"],
];

(async () => {
  const {
    measureLimbSharpness,
    assessSkinToneConsistency,
    measureFaceToneVsRef,
  } = require("../faceQuality");

  const job = JSON.parse(
    fs.readFileSync(path.join(process.env.TEMP, "latest-live-job.json"), "utf8")
  );
  const refSkinTone = job.data.refSkinTone;
  console.log("refSkinTone (selfie):", refSkinTone.map((v) => v.toFixed(1)).join(", "));

  for (const [label, file] of FRAMES) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) {
      console.log(`\n${label}: DOSYA YOK (${file})`);
      continue;
    }
    const buf = fs.readFileSync(p);
    const ls = await measureLimbSharpness(buf);
    // Şablonu elimizde tutmadığımız için ten kapısını çıktının KENDİSİYLE
    // çalıştırıyoruz: taban=çıktı demek, "eski ton kalmış mı" testini
    // ayırt edicilik şartında düşürür — tam da üretimde olan şey.
    const skinSelf = await assessSkinToneConsistency(buf, buf, null);
    const faceVsSelfie = await measureFaceToneVsRef(buf, refSkinTone);
    console.log(
      `\n${label}\n` +
      `  EL NETLİK : ${ls.ok
        ? `yerel=${ls.localVar.toFixed(1)} kareGeneli=${ls.frameVar.toFixed(1)} oran=${ls.ratio.toFixed(3)}`
        : `ATLANDI[${ls.reason}]`}\n` +
      `  TEN (kendi tabanıyla): ok=${skinSelf.ok} sebep=${skinSelf.reason || "-"} ` +
      `oran=${skinSelf.ratio != null ? skinSelf.ratio.toFixed(3) : "null"} ` +
      `yüzFarkı=${skinSelf.faceDelta != null ? skinSelf.faceDelta.toFixed(1) : "null"}\n` +
      `  YÜZ↔SELFIE renklilik: ${faceVsSelfie ? faceVsSelfie.chroma.toFixed(1) : "null"}`
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
