// AĞIR SON KATMAN GÖREVLERİ (2026-10-11, kullanıcı: "genel hızı nasıl
// hızlandırabiliriz" → worker threads). Katmanlar saf JS + tfjs-wasm, yani tek
// iş parçacığında sırayla koşuyordu (POST_LAYER_LOCK); 10 kare kilitte
// 150-180 sn bekledi (iş 3b16bf69). Buradaki görevler hem worker iş
// parçacığında (postWorker.js / postPool.js) hem de — havuz yoksa — ana iş
// parçacığında kilit altında AYNI kodla çalışır.
//
// Girdi/çıktı yalnızca yapılandırılmış kopyalanabilir veridir (Buffer,
// typed array, düz nesne): kapanış (finish) taşınamaz, yerine inpaint işinin
// verisi (job) ve tabanı (base) döner; finishInpaint görevi onu tamamlar.

const toBuf = (v) => (v == null || Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));

function plainInpaint(inp) {
  if (!inp) return null;
  return { image: inp.image, mask: inp.mask, rect: inp.rect, job: inp.job, base: inp.base };
}

/**
 * YÜZ IŞIĞI (bayrakla) → TEN ALANI → YÜZ DETAYI → ARKA PLAN → SİYAH-BEYAZ SON.
 * Açıklamalar falPhotos'taki eski kilit bloğundan.
 */
async function layers({ buf, tpl, styleId, chunkIdx, faceLight = false, templateEyewear = false }) {
  let deliverBuf = toBuf(buf);
  tpl = toBuf(tpl);
  let bgRestored = false;
  let bodyLightRatio = null;
  // YÜZ IŞIĞI VE TENİ (2026-10-16, bkz. faceRelight.js) — base'in ışık deseni
  // yüze, yüzün parlaklığı/rengi kişinin kendi boynuna. Ten alanından ÖNCE:
  // o adım kolu/eli yüze çeker, yüz önce doğru yerde olmalı. 2026-10-14/15'teki
  // pozlama (faceLight.matchFaceExposure) ve küresel harmonik gölgeleme
  // (faceShading.transferFaceShading) bunun yerine geçti.
  try {
    if (faceLight && tpl) {
      const { relightFace } = require("./faceRelight");
      const fl = await relightFace(deliverBuf, tpl, { templateEyewear });
      const n = (v, d = 2) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
      const tp = fl.tone || {};
      // Ten alanının hedefi: base'de boyun/yüz parlaklık oranı.
      if (tp.tplOk && tp.rT > 0) bodyLightRatio = 1 / tp.rT;
      const ölçü = `desen=${fl.pattern ? n(fl.patternMean, 3) : "kapalı"} desenUyumu=${n(fl.corrBefore)} ` +
        `ton[${tp.reason || "boyun"}] parlaklık=${n(tp.level != null ? Math.exp(tp.level) : null)} renkAçısı=${n(tp.hueShift, 1)}° doygunluk=${n(tp.chromaGain)} ` +
        `şablonYüz/Boyun=${n(tp.rT)} çıktıYüz/Boyun=${n(tp.rO)} profil=${fl.profile ? 1 : 0}`;
      if (fl.applied && fl.buf) {
        deliverBuf = fl.buf;
        console.log(`YÜZ IŞIĞI (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${ölçü}`);
      } else {
        console.log(`YÜZ IŞIĞI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fl.reason}] ${ölçü}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: yüz ışığı hata verdi (atlanıyor):", e);
  }
  // TEN TONU ALANI (2026-10-07): vücut derisini segmentasyonla bulup kolu/eli/
  // boynu yüz tonuna çeker (bkz. skinTone.js). Kıyafet/aksesuar boyanmaz.
  // Açıklık hedefi şablonun boyun/yüz ışık oranıyla (yüz ışığı adımı ölçer).
  try {
    const { correctSkinToneField } = require("./skinTone");
    const st = await correctSkinToneField(deliverBuf, { bodyLightRatio });
    const n = (v) => (v != null ? v.toFixed(1) : "null");
    const ölçü = `açıklıkFarkı=${n(st.deltaLBefore)}->${n(st.deltaLAfter)} kroma=${n(st.chromaBefore)}->${n(st.chromaAfter)} yayılım=${n(st.spreadBefore)}->${n(st.spreadAfter)} tenPx=${st.skinPx ?? "null"} vücutIşığı=${bodyLightRatio != null ? bodyLightRatio.toFixed(2) : "null"}`;
    if (st.applied && st.buf) {
      deliverBuf = st.buf;
      console.log(`TEN ALANI (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${ölçü} değişenPx=${st.changedPx}`);
    } else {
      console.log(`TEN ALANI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${st.reason}] ${ölçü}`);
    }
  } catch (e) {
    console.error("OpenAI yolu: ten tonu alan düzeltmesi hata verdi (atlanıyor):", e);
  }

  // YÜZ DETAYI EŞİTLEME (2026-10-08, "kıyafet kaliteli, yüz kalitesiz"):
  // yüz ince detayı şablondaki yüz/kıyafet oranına kadar keskinleşir.
  try {
    if (tpl) {
      const { matchFaceDetail } = require("./faceDetail");
      const fd = await matchFaceDetail(deliverBuf, tpl);
      const n = (v) => (v != null ? v.toFixed(2) : "null");
      const ölçü = `kazanç=${n(fd.gain)} yüz=${n(fd.outFace)}->${n(fd.after)} hedef=${n(fd.target)} kıyafet=${n(fd.outCloth)} şablonYüz/Kıyafet=${n(fd.tplFace)}/${n(fd.tplCloth)}`;
      if (fd.applied && fd.buf) {
        deliverBuf = fd.buf;
        console.log(`YÜZ DETAYI (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${ölçü}`);
      } else {
        console.log(`YÜZ DETAYI (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${fd.reason}] ${ölçü}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: yüz detayı eşitleme hata verdi (atlanıyor):", e);
  }

  // ARKA PLAN GERİ YÜKLEME (2026-10-08, "sadece yüz değişecek"): kişi ve
  // şablon kafası silüeti dışındaki her piksel şablondan (bkz. sceneRestore.js).
  try {
    if (!tpl) {
      console.log(`ARKA PLAN (style=${styleId}, chunk=${chunkIdx}): ATLANDI[no-template]`);
    } else {
      const { restoreTemplateBackground } = require("./sceneRestore");
      const bg = await restoreTemplateBackground(deliverBuf, tpl);
      const n = (v) => (v != null ? v.toFixed(2) : "null");
      if (bg.applied && bg.buf) {
        deliverBuf = bg.buf;
        bgRestored = true;
        console.log(`ARKA PLAN (style=${styleId}, chunk=${chunkIdx}): UYGULANDI kişiIoU=${n(bg.iou)} arkaPlanFarkı=${n(bg.bgDiff)} geriKonanPx=${bg.restoredPx} tonEşitlenenPx=${bg.harmonizedPx}`);
      } else {
        console.log(`ARKA PLAN (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${bg.reason}] kişiIoU=${n(bg.iou)}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: arka plan geri yükleme hata verdi (atlanıyor):", e);
  }

  // SİYAH-BEYAZ — SON GEÇİŞ (2026-10-09, f9f3b5c0 c4): ten/detay gri kareye
  // renk katabiliyor; şablon griyse teslim edilen kare de tamamen gri.
  try {
    if (tpl) {
      const { matchGrayscale } = require("./faceLight");
      const g = await matchGrayscale(deliverBuf, tpl);
      if (g.applied && g.buf) {
        deliverBuf = g.buf;
        console.log(`SİYAH-BEYAZ SON (style=${styleId}, chunk=${chunkIdx}): UYGULANDI şablonDoygunluk=${g.satT.toFixed(1)} çıktıDoygunluk=${g.satO.toFixed(1)}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: siyah-beyaz son geçiş hata verdi (atlanıyor):", e);
  }
  return { buf: deliverBuf, bgRestored };
}

/**
 * KAFA ÖLÇEĞİ (bkz. headScale.correctHeadScale). Log metinleri burada
 * kurulur, yazdırma çağıranda (sonuç AI dolgusuna bağlı).
 */
async function headScale({ buf, tpl, templateEyewear = false }) {
  const { correctHeadScale } = require("./headScale");
  const hs = await correctHeadScale(toBuf(buf), toBuf(tpl), { deferInpaint: true, templateEyewear });
  const n = (v) => (v != null ? v.toFixed(3) : "null");
  const hp = hs.parts || {};
  const parçalar = hs.eyewear
    ? `gözlüklüŞablon gözsüzNokta=${n(hp.landmark)} yüzAlanı=${n(hp.faceArea)} kutuEn=${n(hp.boxW)} kutuBoy=${n(hp.boxH)}`
    : `gözÇene=${n(hp.eyeChin)} kaşBurun=${n(hp.browNose)} gözBurun=${n(hp.eyeNose)} burunBoyu=${n(hp.noseLen)} kafaHacmi=${n(hs.volRatio)}${hs.volUsed ? "" : "[kullanılmadı]"}`;
  const ölçü = `s=${n(hs.s)} ham=${n(hs.rawS)} yüzOranı=${n(hs.faceRatio)} ${parçalar} gövdeIoU=${n(hs.bodyIou)} yüzKayması=${n(hs.faceShift)}${hs.silReason ? ` silüetYok=${hs.silReason}` : ""}${hs.planS != null ? ` plan=${n(hs.planS)} açıkŞablon=${n(hs.exposed)}` : ""}${hs.sEff != null ? ` izinliS=${n(hs.sEff)}` : ""}`;
  const applied = !!(hs.applied && hs.buf);
  const delik = applied ? `taşınanPx=${hs.movedPx} delikPx=${hs.holePx ?? "null"} delikDerinlik=${hs.holeDepth != null ? Math.round(hs.holeDepth) : "null"}` : "";
  return { applied, reason: hs.reason, buf: applied ? hs.buf : null, holeMask: applied ? hs.holeMask || null : null, headMask: applied ? hs.headMask || null : null, inpaint: applied ? plainInpaint(hs.inpaint) : null, ölçü, delik };
}

async function surroundPrep({ buf, extraHole = null, newHead = null }) {
  const { prepareHeadSurroundFill } = require("./headSurround");
  const sf = await prepareHeadSurroundFill(toBuf(buf), { extraHole, newHead });
  const { inpaint, ...rest } = sf;
  return { ...rest, inpaint: plainInpaint(inpaint) };
}

async function fringePrep({ buf, tpl }) {
  const { prepareHeadFringeRepaint } = require("./headScale");
  const fr = await prepareHeadFringeRepaint(toBuf(buf), toBuf(tpl));
  const { inpaint, ...rest } = fr;
  return { ...rest, inpaint: plainInpaint(inpaint) };
}

/** AI çıktısını inpaint işine yerleştirir (bkz. headScale.finishInpaint). */
async function finishInpaint({ job, ai, base }) {
  const { _finishInpaint } = require("./headScale");
  if (job.rgb) job.rgb = toBuf(job.rgb);
  return _finishInpaint(job, toBuf(ai), toBuf(base));
}

module.exports = { layers, headScale, surroundPrep, fringePrep, finishInpaint, toBuf };
