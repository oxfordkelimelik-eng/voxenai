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
async function layers({ buf, tpl, styleId, chunkIdx, faceLight = false, templateEyewear = false, skinLight = null }) {
  let deliverBuf = toBuf(buf);
  tpl = toBuf(tpl);
  let bgRestored = false;
  // YÜZ IŞIĞI VE TENİ (2026-10-16, bkz. faceRelight.js) — base'in ışık deseni
  // yüze, yüzün parlaklığı/rengi kişinin kendi boynuna. Ten alanından ÖNCE:
  // o adım kolu/eli yüze çeker, yüz önce doğru yerde olmalı. 2026-10-14/15'teki
  // pozlama (faceLight.matchFaceExposure) ve küresel harmonik gölgeleme
  // (faceShading.transferFaceShading) bunun yerine geçti.
  try {
    if (faceLight && tpl) {
      const { relightFace } = require("./faceRelight");
      const fl = await relightFace(deliverBuf, tpl, { templateEyewear, skinLight });
      const n = (v, d = 2) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
      const tp = fl.tone || {};
      const v3 = (e) => (e ? `[${e.map((v) => n(v)).join("/")}]` : "-");
      const ölçü = `desen=${fl.pattern ? n(fl.patternMean, 3) : "kapalı"} desenUyumu=${n(fl.corrBefore)} ` +
        `ışıkRengi=${fl.color ? "var" : "yok"} ton[${tp.reason || "boyun"}] parlaklık=${n(tp.level != null ? Math.exp(tp.level) : null)} ` +
        `şablonYüz/Boyun=${n(tp.rT)} çıktıYüz/Boyun=${n(tp.rO)} profil=${fl.profile ? 1 : 0} ağ=${fl.mesh ? "var" : "yok"} ` +
        `ortamRengi=${fl.light && fl.light.lc ? `[${fl.light.lc.map((v) => n(v)).join("/")}]` : `ATLANDI[${(fl.light && fl.light.reason) || "?"}]`}` +
        (fl.light && fl.light.light ? ` ışık=${v3(fl.light.light)} arka=${v3(fl.light.eBg)} kişi=${v3(fl.light.ePerson)} yüz=${v3(fl.light.eFace)} kırp=${n(fl.light.k)}` : "");
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
  // Açıklık hedefi şablonun KOL/yüz ışık oranıyla (skinTone ölçer; boyun
  // oranı çene gölgesinden güneşteki kolu karartıyordu — 629b45de c8).
  try {
    const { correctSkinToneField } = require("./skinTone");
    const st = await correctSkinToneField(deliverBuf, { templateBuf: tpl });
    const n = (v) => (v != null ? v.toFixed(1) : "null");
    const ölçü = `açıklıkFarkı=${n(st.deltaLBefore)}->${n(st.deltaLAfter)} kroma=${n(st.chromaBefore)}->${n(st.chromaAfter)} yayılım=${n(st.spreadBefore)}->${n(st.spreadAfter)} tenPx=${st.skinPx ?? "null"} vücutIşığı=${st.bodyLightRatio != null ? st.bodyLightRatio.toFixed(2) : "null"}`;
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
  // yüz ince detayı şablondaki yüz/kıyafet oranına kadar keskinleşir;
  // ardından şablon yüzünün greni kadar gren (2026-10-16, bkz. faceDetail).
  try {
    if (tpl) {
      const { matchFaceDetail } = require("./faceDetail");
      const fd = await matchFaceDetail(deliverBuf, tpl);
      const n = (v) => (v != null ? v.toFixed(2) : "null");
      const gr = fd.grain || {};
      const ölçü = `keskinlik=${fd.sharpened ? "UYGULANDI" : `ATLANDI[${fd.reason}]`} kazanç=${n(fd.gain)} yüz=${n(fd.outFace)}->${n(fd.after)} hedef=${n(fd.target)} kıyafet=${n(fd.outCloth)} şablonYüz/Kıyafet=${n(fd.tplFace)}/${n(fd.tplCloth)} ` +
        `gren=${gr.reason ? `ATLANDI[${gr.reason}]` : "UYGULANDI"} şablonGren=${n(gr.tpl)} yüzGren=${n(gr.before)}->${n(gr.after)} eklenen=${n(gr.amp ?? gr.add)}`;
      if (fd.applied && fd.buf) {
        deliverBuf = fd.buf;
        console.log(`YÜZ DETAYI (style=${styleId}, chunk=${chunkIdx}): UYGULANDI ${ölçü}`);
      } else {
        console.log(`YÜZ DETAYI (style=${styleId}, chunk=${chunkIdx}): ATLANDI ${ölçü}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: yüz detayı eşitleme hata verdi (atlanıyor):", e);
  }

  // KIYAFET RENGİ (2026-10-20, 7c17ea3f c3, kullanıcı: "kıyafet rengi
  // değişmiş"): model kıyafeti farklı renkte çizdiyse küme küme şablonun
  // rengine döner (bkz. clothColor.js). Arka plan geri yüklemeden önce:
  // kişi silüetinden taşan kayma orada şablondan gelir.
  try {
    if (tpl) {
      const { restoreClothColor } = require("./clothColor");
      const cc = await restoreClothColor(deliverBuf, tpl);
      const kümeler = (cc.info || []).map((x) => (x.shift ? `[${x.shift.map((v) => v.toFixed(1)).join("/")}]` : x.reason)).join(" ");
      if (cc.applied && cc.buf) {
        deliverBuf = cc.buf;
        console.log(`KIYAFET RENGİ (style=${styleId}, chunk=${chunkIdx}): UYGULANDI kümeler=${kümeler} değişenPx=${cc.changedPx}`);
      } else {
        console.log(`KIYAFET RENGİ (style=${styleId}, chunk=${chunkIdx}): ATLANDI[${cc.reason}] kümeler=${kümeler || "-"}`);
      }
    }
  } catch (e) {
    console.error("OpenAI yolu: kıyafet rengi hata verdi (atlanıyor):", e);
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
        console.log(`ARKA PLAN (style=${styleId}, chunk=${chunkIdx}): UYGULANDI kişiIoU=${n(bg.iou)} arkaPlanFarkı=${n(bg.bgDiff)} geriKonanPx=${bg.restoredPx} tonEşitlenenPx=${bg.harmonizedPx} hizalama=${bg.align ? `${bg.align.moved}px/en${n(bg.align.maxShift)}px/${bg.align.blocks}blok` : "yok"}`);
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
    : `gözÇene=${n(hp.eyeChin)} kaşBurun=${n(hp.browNose)} gözBurun=${n(hp.eyeNose)} burunBoyu=${n(hp.noseLen)}`;
  const hacim = ` kafaHacmi=${n(hs.volRatio)}${hs.volUsed ? "" : "[kullanılmadı]"} genişlik=${n(hs.widthRatio)}${hs.widthUsed ? "[kullanıldı]" : ""}`;
  const ölçü = `s=${n(hs.s)} ham=${n(hs.rawS)} yüzOranı=${n(hs.faceRatio)} ${parçalar}${hacim} gövdeIoU=${n(hs.bodyIou)} yüzKayması=${n(hs.faceShift)}${hs.silReason ? ` silüetYok=${hs.silReason}` : ""}${hs.planS != null ? ` plan=${n(hs.planS)} açıkŞablon=${n(hs.exposed)}` : ""}${hs.sEff != null ? ` izinliS=${n(hs.sEff)}` : ""}`;
  const applied = !!(hs.applied && hs.buf);
  const delik = applied ? `taşınanPx=${hs.movedPx} delikPx=${hs.holePx ?? "null"} delikDerinlik=${hs.holeDepth != null ? Math.round(hs.holeDepth) : "null"}` : "";
  return { applied, reason: hs.reason, buf: applied ? hs.buf : null, holeMask: applied ? hs.holeMask || null : null, headMask: applied ? hs.headMask || null : null, inpaint: applied ? plainInpaint(hs.inpaint) : null, ölçü, delik };
}

async function surroundPrep({ buf, tpl = null, extraHole = null, newHead = null }) {
  const { prepareHeadSurroundFill, templateHeadMaskFor } = require("./headSurround");
  // Şablon kafasının yeni kafanın örtmediği kısmı da dolar (bkz. headSurround tplHead).
  let tplHead = null;
  if (tpl) {
    try {
      tplHead = await templateHeadMaskFor(toBuf(buf), toBuf(tpl));
    } catch (e) {
      console.error("Kafa çevresi: şablon kafa silüeti çıkarılamadı (atlanıyor):", e.message || e);
    }
  }
  const sf = await prepareHeadSurroundFill(toBuf(buf), { extraHole, newHead, tplHead });
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
