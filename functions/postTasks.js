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
async function layers({ buf, tpl, styleId, chunkIdx, faceLight = false, templateEyewear = false, skinLight = null, mstUser = null, mstTpl = null }) {
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
      const fl = await relightFace(deliverBuf, tpl, { templateEyewear, skinLight, mstUser, mstTpl });
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
    const ölçü = `açıklıkFarkı=${n(st.deltaLBefore)}->${n(st.deltaLAfter)} kroma=${n(st.chromaBefore)}->${n(st.chromaAfter)} yayılım=${n(st.spreadBefore)}->${n(st.spreadAfter)} tenPx=${st.skinPx ?? "null"} kıyafetVetosu=${st.clothVeto != null ? st.clothVeto.toFixed(2) : "null"} vücutIşığı=${st.bodyLightRatio != null ? st.bodyLightRatio.toFixed(2) : "null"}`;
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
 * SADE AKIŞIN SON ADIMLARI (2026-10-30, kullanıcı: "kafa orantılı, ışık doğru
 * yerden vursun, ten vücutla uyumlu, yüz net, yapıştırılmış gibi durmasın").
 * KAFA BÜKME (headWarp) → YÜZ SAHNE IŞIĞI (faceTone) → YÜZ DETAYI (faceDetail:
 * keskinlik + gren, yüzü yeniden çizmez) → SİYAH-BEYAZ. Eski ışık/ten
 * katmanları yüzü açıyordu (bkz. faceTone başlığı) — burada yoklar.
 */
// ŞABLON İZİ DETEKTÖRÜ (2026-11-06, bkz. ghostDetect.js): kare iz skoru eşiği
// geçerse ghostClean sıcak yamalarda beklenen kafanın içini de temizler.
// false = 11-05 v28 davranışı (yalnız yarı saydam karışım).
const GHOST_DETECT = true;

// Selfie kafa profilleri (bkz. ghostClean.headProfileOf), iş başına bir kez —
// worker aynı işin kareleri arasında önbellekte tutar. Selfie'ler iş bitince
// silinir; boş sonuç önbelleğe alınmaz.
// 2026-11-03 KAPATILDI (8ee5afa0, kullanıcı: "göz açma promptta veriliyor"):
// kapak selfie'de ve çıktıda iki kez kaldırılıyordu, gözler iri/kaymış göründü.
const EYE_OPEN_SIMPLE = false;
// AĞIZ KÖŞESİ KİLİDİ 2026-11-03 KAPATILDI (8ee5afa0, kullanıcı: "bu yapılmasın;
// selfie'deki gibi doğal olsun"): köşe base'in altına iniyor, 5 karede kişi
// somurtkan göründü. İfade artık yalnız promptla.
const MOUTH_LOCK_ON = false;
// BAKIŞ KİLİDİ (2026-11-06, c9, kullanıcı: "çıktı gözleri her zaman base ile
// aynı yere bakmalı"): çıktının kendi irisi base'in iris konumuna kayar
// (gazeLock.js). Geri dönüş: false.
const GAZE_LOCK_ON = true;
// VÜCUT TENİ YÜZE (2026-11-03, 7e04933e c5, kullanıcı: "yüz ten rengi ile el
// uyuşmamış, yüz ten rengi ile tüm vücut teni uyuşmalı"): model base'in elini
// değiştirmeden bırakıyor. skinTone yüz kilidiyle: yalnız el/kol yüzün rengine
// gelir (ışık/gölge sahneden), yüz ve boyun değişmez, kıyafet yüze göre deri
// kapısıyla korunur.
const SKIN_FIELD_SIMPLE = true;
// KAFA BÜKME / KATMANLI KAFA ÖLÇEĞİ KAPALI (2026-11-19, kullanıcı: "kafa küçük, yapışmış, boyun
// uzamış, sakal kesilmiş... fazlalıkları çıkar"). Kör A/B (30 kare, 2 hakem, scratchpad simp/): ham
// kare 32, teslim 21 kez daha doğal; teslimdeki "kafa küçük" 10 (hamda 0), "yapışık" 10 (2), bükülmüş
// arka plan 6 (0), sakal/saç kesik 4 (1). 185655bf c9 ×0.882 küçüldü, sakal kesildi. Hedef ölçüsü
// şablon tespit varyansını ölçüyordu (head-grew-measures-template). Model yüzü %6-11 büyük çizebilir;
// o durumda yeni küçültme katmanı EKLENMEZ, Vision oran kapısı eler. Geri dönüş: true.
// Katman katman kör A/B (2026-11-19, 30 ham kare yerelde yeniden oynatıldı, scratchpad simp/replay):
// - GHOST_CLEAN AÇIK: açık 12 (6 açık farkla) / kapalı 7 (1); kapalıyken şablon saç izi kalıyor.
// - FACE_TONE KAPALI: açık 14 / kapalı 15 (açık farkla 1 / 3), yani ortalamada etkisiz; açıkken
//   gökyüzünde dikdörtgen gri yama (248a0e72 c5), siyah-beyaz karede sepya yüz + boyunda çizgi
//   (cd3c9a1c c7), kül grisi yüz (6a02687c c5). Geri dönüş: true.
// Kalan katmanlar tek tek kapatıldı (aynı 30 kare, tek değişken; sayılar açık / kapalı / aynı):
// - SKIN 3 / 6 / 2, ama açık farkla 2 / 1: şablon kişinin koyu kollarını yüze getiriyor (185655bf c3,
//   kullanıcının şikâyeti), kırmızı eli düzeltiyor; bir karede yakaya soluk leke bırakıyor → AÇIK.
// - LIP 10 karenin 10'unda görünmez (bu karelerde ruj kırmızısı yok; 156fa173 kusurunu düzeltir) → AÇIK.
// - GAZE 1 / 7 / 5, açık farkla 0 / 2: irisi göz köşesine itiyor, bir karede bulanıklaştırıyor
//   (6a02687c c1, 248a0e72 c5) → KAPALI.
// - STRUCT 25 karenin 25'inde görünmez (ortalama 3-6 gri seviye) → KAPALI.
// - DETAIL 10 / 1 / 7: keskinlik + gren olmadan yüz pürüzsüz ve yapışık → AÇIK.
// 2026-11-20 YENİDEN AÇILANLAR (kullanıcı kararı, ücretsiz yeniden oynatma, aynı 30 kare):
// - GAZE: 11-19 kararı test hatasıydı — replay simpleFinish'e templateEyewear geçmiyordu, 30 karenin
//   11'i gözlüklü şablon; kilit camın arkasını iris sanıp gözü köşeye itti (6a02687c c1 kayma −0.25).
//   Canlıdaki gibi gözlüklü şablon atlanınca 8 karede uygulandı, bozulma yok; 248a0e72 c5,
//   cd3c9a1c c7, 6a02687c c6'da iris şablon yönüne.
// - FACE_TONE: yalnız parlaklık + ışık yönü (faceTone CHROMA kapalı). Koyu şablonda model yüzü
//   +8..+27 L açıyor (8ac66d45 c5: yüz parlak, göğüs gölgede). Tam katman kör 9/14 kaybetti (gri,
//   sepya); yalnız parlaklık 11/13 (açık fark 4/1), kullanıcı gözle beğendi. Gri yama (others
//   sınıfı gökyüzünde) headAlpha'da kişi maskesiyle düzeltildi.
// 2026-11-22 STRUCT AÇIK (kullanıcı: "yüz hatları daha belli olsun"): faceDetail.STRUCT.BASE 1.5 taban
// güç (şablondan bağımsız), MAX 1.7; 4 karede ×1.3/1.5/1.7 karşılaştırıldı, 1.5 seçildi.
// 2026-11-25 STRUCT GERİ KAPALI (kullanıcı: "detay/gren değişikliklerini geri alalım"; 947807a7 c9 yüz grileşmesi
// ve c4 sert sakal konturu bu adımdandı). faceDetail.structOf sakalı dışlayan, çarpımsal sürümde kaldı.
const FINISH = { HEAD_WARP: false, GHOST_CLEAN: true, FACE_TONE: true, SKIN: true, LIP: true, GAZE: true, STRUCT: false, DETAIL: true };
const PROFILE_CACHE = new Map();
const PROFILE_CACHE_MAX = 4;
const PROFILE_FETCH_MS = 15000;
function selfieProfiles(key, urls) {
  const k = key || urls.join("|");
  if (PROFILE_CACHE.has(k)) return PROFILE_CACHE.get(k);
  const p = (async () => {
    const { headProfileOf } = require("./ghostClean");
    const res = [];
    for (const u of urls) {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), PROFILE_FETCH_MS);
      try {
        const r = await fetch(u, { signal: ctl.signal });
        if (!r.ok) continue;
        const prof = await headProfileOf(Buffer.from(await r.arrayBuffer()));
        if (prof) res.push(prof);
      } catch (e) {
        console.error("Selfie kafa profili alınamadı (atlanıyor):", e.message || e);
      } finally {
        clearTimeout(tm);
      }
    }
    if (!res.length) PROFILE_CACHE.delete(k);
    return res;
  })();
  PROFILE_CACHE.set(k, p);
  if (PROFILE_CACHE.size > PROFILE_CACHE_MAX) PROFILE_CACHE.delete(PROFILE_CACHE.keys().next().value);
  return p;
}

async function simpleFinish({ buf, tpl, styleId, chunkIdx, templateEyewear = false, mstUser = null, mstTpl = null, refUrls = null, jobKey = null, refDescriptor = null, hairErased = false, templateHat = false, deadline = null }) {
  let out = toBuf(buf);
  tpl = toBuf(tpl);
  const tag = `style=${styleId}, chunk=${chunkIdx}`;
  if (!tpl) {
    console.log(`SADE SON ADIMLAR (${tag}): ATLANDI[no-template]`);
    return { buf: out };
  }
  // ŞABLON KAFASI İZİ (2026-10-30, bkz. ghostClean.js) — kafa bükmeden ÖNCE:
  // iz şablonla piksel hizasındayken bulunur. Modele saçı silinmiş base gittiyse
  // (falPhotos.TEMPLATE_HAIR_ERASE) iz kaynağı yok; büyük dolgu yalnız zarar
  // veriyordu (80fc7ec4 c0: bulanık leke, kesik kafa tepesi) — atlanır.
  if (!FINISH.GHOST_CLEAN) console.log(`ŞABLON İZİ (${tag}): KAPALI`);
  else if (hairErased) console.log(`ŞABLON İZİ (${tag}): ATLANDI[hair-erased]`);
  else try {
    const { cleanTemplateGhost } = require("./ghostClean");
    const profiles = Array.isArray(refUrls) && refUrls.length ? await selfieProfiles(jobKey, refUrls) : [];
    // İz detektörü (bkz. ghostDetect.js): yerel OWLv2, ücretsiz; hata verirse v28 davranışı.
    const { scoreGhost } = require("./ghostDetect");
    // ŞABLONDA ŞAPKA (2026-11-06, falPhotos şablon şapka tespiti): model şapkayı
    // tuttuysa şapka iz sayılmaz (bkz. ghostClean HAT_KEPT_SHARE).
    const gc = await cleanTemplateGhost(out, tpl, { profiles, ghostScorer: GHOST_DETECT ? scoreGhost : null, templateHat: !!templateHat });
    if (gc.applied && gc.buf) out = gc.buf;
    const n = (v, d = 3) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
    console.log(`ŞABLON İZİ (${tag}): ${gc.applied ? "TEMİZLENDİ" : `ATLANDI[${gc.reason}]`} izPx=${gc.ghostPx ?? "null"} iz/yüz²=${n(gc.ghostFace2)} kırıntı=${gc.crumbPx ?? 0} tutam=${gc.tuftN ?? 0} gözÜstü=${n(gc.ghostUp, 2)} kafayaBitişik=${n(gc.ghostAttached, 2)} yöntem=${gc.mode || "null"} selfieProfil=${profiles.length} dedektör=${n(gc.detScore, 2)}${gc.detHot ? `[İZ +${n(gc.hotAdded)}]` : ""}${gc.hatShare != null ? ` şapka=${gc.hatKept ? "KORUNDU" : "yok"}(pay=${n(gc.hatShare, 2)} alan=${n(gc.hatArea, 2)})` : ""}${gc.ms != null ? ` ${gc.ms}ms` : ""}`);
  } catch (e) {
    console.error("Sade akış: şablon izi temizliği hata verdi (atlanıyor):", e);
  }
  if (!FINISH.HEAD_WARP) console.log(`KAFA BÜKME (${tag}): KAPALI`);
  else try {
    const { correctHeadByWarp } = require("./headWarp");
    // Çizgi koruma (headWarp/lineKeep) iş süresi azsa atlanır (900 sn bütçe).
    const hw = await correctHeadByWarp(out, tpl, { templateEyewear, deadline });
    if (hw.applied && hw.buf) out = hw.buf;
    console.log(`KAFA BÜKME (${tag}): ${hw.applied ? "UYGULANDI" : `ATLANDI[${hw.reason}]`} ${hw.ölçü || ""}`);
  } catch (e) {
    console.error("Sade akış: kafa bükme hata verdi (atlanıyor):", e);
  }
  if (!FINISH.FACE_TONE) console.log(`YÜZ SAHNE IŞIĞI (${tag}): KAPALI`);
  else try {
    const { matchFaceToScene } = require("./faceTone");
    const ft = await matchFaceToScene(out, tpl, { mstUser, mstTpl });
    const n = (v, d = 1) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
    const ölçü = `yüzL çıktı=${n(ft.outL)} şablon=${n(ft.tplL)} hedef=${n(ft.targetL)} vücutOranı=${n(ft.bodyRatio, 2)} pigment[MST ${mstUser ?? "?"}/${mstTpl ?? "?"}]=${n(ft.albedo, 2)}/${n(ft.albedoLight, 2)} kazanç=×${n(Math.exp(ft.logGain || 0), 2)}${ft.lightCap ? ` açıkŞablonSınırı=×${n(Math.exp(ft.lightCap.from), 2)}→×${n(Math.exp(ft.lightCap.to), 2)}` : ""}${ft.darkCap ? ` koyuŞablonSınırı=×${n(Math.exp(ft.darkCap.from), 2)}→×${n(Math.exp(ft.darkCap.to), 2)}` : ""} renk=${n(ft.da)}/${n(ft.db)} ışıkEğimi=${n(ft.gu, 2)}/${n(ft.gv, 2)} şablonEğim=${ft.tplSlope || "null"} çıktıEğim=${ft.outSlope || "null"} boyunYüzFarkıL=${n(ft.neckDeltaBefore)}→${n(ft.neckDeltaAfter)} boyunRenk=${ft.neckAB ? `${n(ft.neckAB[0])}/${n(ft.neckAB[1])}` : "-"}→yüz${ft.faceUpperAB ? `${n(ft.faceUpperAB[0])}/${n(ft.faceUpperAB[1])}` : "-"} kayma=${ft.neckShift ? `${n(ft.neckShift[0])}/${n(ft.neckShift[1])}` : "-"} şablonBoyunYüz=${n(ft.neckDeltaTpl)} şablonÇevreL=${n(ft.tplRingL)} karanlıkSahne=${ft.darkScene ? (ft.deep ? "derin" : "evet") : "hayır"} arkadanIşık=${ft.backlit ? "evet" : "hayır"} boyunİşareti=${ft.pigmentApart ? "kapalı[ten farkı]" : ft.neckLog != null ? "×" + n(Math.exp(ft.neckLog), 2) + (ft.neckUsed ? " uygulandı" : " yok") : "—"}`;
    if (ft.applied && ft.buf) out = ft.buf;
    console.log(`YÜZ SAHNE IŞIĞI (${tag}): ${ft.applied ? "UYGULANDI" : `ATLANDI[${ft.reason}]`} ${ölçü}${ft.ms != null ? ` ${ft.ms}ms` : ""}`);
  } catch (e) {
    console.error("Sade akış: yüz sahne ışığı hata verdi (atlanıyor):", e);
  }
  if (SKIN_FIELD_SIMPLE && FINISH.SKIN) try {
    const t0 = Date.now();
    const { correctSkinToneField } = require("./skinTone");
    const pigmentGap = Number.isFinite(mstTpl) && Number.isFinite(mstUser) ? mstTpl - mstUser : null;
    const st = await correctSkinToneField(out, { templateBuf: tpl, faceLocked: true, pigmentGap });
    if (st.applied && st.buf) out = st.buf;
    // KOYU ŞABLONDA İKİNCİ GEÇİŞ (2026-11-22, 185655bf c3): tek geçişte yumuşak ağırlıklar uzuv
    // medyanını yüzden ~5 L koyu bırakıyordu (55.8 / 51.0); ikinci geçiş kalanı kapatır (54.6, en koyu %10
    // 43.5 → 51.8). Yalnız şablon gölgesi düşürülmüş (pigment farkı ≥ SHADE_PIGMENT_GAP) karede.
    let pass2 = null;
    if (st.applied && st.shadeDropped) {
      pass2 = await correctSkinToneField(out, { templateBuf: tpl, faceLocked: true, pigmentGap });
      if (pass2.applied && pass2.buf) out = pass2.buf;
    }
    const n = (v, d = 1) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
    console.log(`TEN ALANI (${tag}): ${st.applied ? "UYGULANDI" : `ATLANDI[${st.reason}]`} yüzKilidi=evet açıklıkFarkı=${n(st.deltaLBefore)}→${n(st.deltaLAfter)} kroma=${n(st.chromaBefore)}→${n(st.chromaAfter)} tenPx=${st.skinPx ?? "null"} kıyafetVeto=${n(st.clothVeto, 2)} şablonGölgesi=${st.shadeDropped ? `yok[MST farkı ${pigmentGap}]` : "var"}${pass2 ? ` ikinciGeçiş=${pass2.applied ? `${n(pass2.deltaLBefore)}→${n(pass2.deltaLAfter)}` : `ATLANDI[${pass2.reason}]`}` : ""} değişenPx=${st.changedPx ?? 0} ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("Sade akış: ten alanı hata verdi (atlanıyor):", e);
  }
  // DUDAK KIRMIZILIĞI (2026-11-18, 156fa173 c7, bkz. lipTone.js): ten adımları
  // dudağa dokunmuyor; model bazı kişilerde ruj sürülmüş gibi kırmızı çiziyor.
  if (FINISH.LIP) try {
    const { limitLipRedness } = require("./lipTone");
    const lp = await limitLipRedness(out);
    if (lp.applied && lp.buf) out = lp.buf;
    const n = (v) => (v != null && Number.isFinite(v) ? v.toFixed(1) : "null");
    console.log(`DUDAK RENGİ (${tag}): ${lp.applied ? "UYGULANDI" : `ATLANDI[${lp.reason}]`} dudak−yanak a*=${n(lp.diff)} dudak=${n(lp.lipA)} yanak=${n(lp.cheekA)} kaydırma=${n(lp.shift)} px=${lp.px ?? "null"} ${lp.ms ?? "-"}ms`);
  } catch (e) {
    console.error("Sade akış: dudak rengi hata verdi (atlanıyor):", e);
  }
  // AĞIZ KÖŞESİ (2026-11-01, 831a00a4 c0, kullanıcı: "gereksiz bir
  // gülümseme eklenmiş … kişiye gereksiz gülümseme katma"): base gülmüyorsa
  // çıktının ağız köşeleri nötrün biraz altına iner (bkz. refMatch).
  if (MOUTH_LOCK_ON) try {
    const t0 = Date.now();
    const mo = await require("./refMatch").lockMouthToBase(out, tpl);
    if (mo.applied && mo.buf) out = mo.buf;
    const n = (v) => (v != null ? v.toFixed(3) : "null");
    console.log(`AĞIZ KÖŞESİ (${tag}): ${mo.applied ? "UYGULANDI" : `ATLANDI[${mo.reason}]`} çıktı=${n(mo.smile)}${mo.applied ? `→${n(mo.after)}` : ""} base=${n(mo.base)} ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("Sade akış: ağız köşesi hata verdi (atlanıyor):", e);
  }
  if (GAZE_LOCK_ON && FINISH.GAZE) try {
    const { lockGazeToBase } = require("./gazeLock");
    const gl = await lockGazeToBase(out, tpl, { templateEyewear });
    if (gl.applied && gl.buf) out = gl.buf;
    const f = (a) => (Array.isArray(a) ? a.map((x) => (x == null ? "-" : x.toFixed(2))).join("/") : "-");
    console.log(`BAKIŞ KİLİDİ (${tag}): ${gl.applied ? "UYGULANDI" : `ATLANDI[${gl.reason}]`} base=${f(gl.base)} çıktı=${f(gl.before)}→${f(gl.after)} kayma=${f(gl.du)} telafi=${gl.comp != null ? gl.comp.toFixed(2) : "-"}${gl.camera ? " kamera" : ""}${gl.center ? " hedef=ortala[gözlüklü şablon]" : ""} ${gl.ms}ms`);
  } catch (e) {
    console.error("Sade akış: bakış kilidi hata verdi (atlanıyor):", e);
  }
  // GÖZ AÇIKLIĞI (2026-10-30, kullanıcı: "uykulu gibi duruyorsa gözleri
  // açmalı, base ile aynı yere bakmalı"): eyeOpen.js yalnız üst kapağı en çok
  // açıklığın %25'i kadar kaldırır (iris ve bakış yönü yerinde), kimlik
  // kapılı; 10-27'de 18 karede kimlik değişmedi. Yüz detayından ÖNCE (bükme
  // irisi hafif yumuşatıyor, keskinlik geri getirir).
  if (EYE_OPEN_SIMPLE) {
    try {
      const t0 = Date.now();
      const eo = await require("./eyeOpen").openEyes(out, refDescriptor);
      if (eo.applied && eo.buf) out = eo.buf;
      const n = (v) => (v != null ? v.toFixed(3) : "null");
      console.log(`GÖZ AÇIKLIĞI (${tag}): ${eo.applied ? "UYGULANDI" : `ATLANDI[${eo.reason}]`} açıklık=${n(eo.ap)} kaldırma=${n(eo.lift)} kimlik=${n(eo.id0)}→${n(eo.id1)} ${Date.now() - t0}ms`);
    } catch (e) {
      console.error("Sade akış: göz açıklığı hata verdi (atlanıyor):", e);
    }
  }
  if (FINISH.STRUCT) try {
    const { matchFaceStructure } = require("./faceDetail");
    const fs2 = await matchFaceStructure(out, tpl);
    const n = (v) => (v != null ? v.toFixed(3) : "null");
    if (fs2.applied && fs2.buf) out = fs2.buf;
    console.log(`YÜZ YAPISI (${tag}): ${fs2.applied ? "UYGULANDI" : `ATLANDI[${fs2.reason}]`} şablon=${n(fs2.tpl)} yüz=${n(fs2.before)}->${n(fs2.after)} kazanç=${n(fs2.gain)}`);
  } catch (e) {
    console.error("Sade akış: yüz yapısı hata verdi (atlanıyor):", e);
  }
  if (FINISH.DETAIL) try {
    const { matchFaceDetail } = require("./faceDetail");
    const fd = await matchFaceDetail(out, tpl);
    const n = (v) => (v != null ? v.toFixed(2) : "null");
    const gr = fd.grain || {};
    if (fd.applied && fd.buf) out = fd.buf;
    console.log(`YÜZ DETAYI (${tag}): ${fd.applied ? "UYGULANDI" : "ATLANDI"} keskinlik=${fd.sharpened ? "UYGULANDI" : `ATLANDI[${fd.reason}]`} kazanç=${n(fd.gain)} yüz=${n(fd.outFace)}->${n(fd.after)} hedef=${n(fd.target)} gren=${gr.reason ? `ATLANDI[${gr.reason}]` : "UYGULANDI"} şablonGren=${n(gr.tpl)} yüzGren=${n(gr.before)}->${n(gr.after)}`);
  } catch (e) {
    console.error("Sade akış: yüz detayı hata verdi (atlanıyor):", e);
  }
  try {
    const { matchGrayscale } = require("./faceLight");
    const g = await matchGrayscale(out, tpl);
    if (g.applied && g.buf) out = g.buf;
  } catch (e) {
    console.error("Sade akış: siyah-beyaz hata verdi (atlanıyor):", e);
  }
  return { buf: out };
}

/**
 * KAFA ÖLÇEĞİ (bkz. headScale.correctHeadScale). Log metinleri burada
 * kurulur, yazdırma çağıranda (sonuç AI dolgusuna bağlı).
 */
async function headScale({ buf, tpl, templateEyewear = false, noShrink = false }) {
  const { correctHeadScale } = require("./headScale");
  const hs = await correctHeadScale(toBuf(buf), toBuf(tpl), { deferInpaint: true, templateEyewear, noShrink });
  const n = (v) => (v != null ? v.toFixed(3) : "null");
  const hp = hs.parts || {};
  const parçalar = hs.eyewear
    ? `gözlüklüŞablon gözsüzNokta=${n(hp.landmark)} yüzAlanı=${n(hp.faceArea)} kutuEn=${n(hp.boxW)} kutuBoy=${n(hp.boxH)}`
    : `gözÇene=${n(hp.eyeChin)} kaşBurun=${n(hp.browNose)} gözBurun=${n(hp.eyeNose)} burunBoyu=${n(hp.noseLen)}`;
  // KAFA HİZASI (bkz. headScale.planHeadAlign): yatay kayma ve eğim.
  const al = hs.align || {};
  const sh = hs.shoulders;
  const hiza = ` hiza[${al.side ? "yan" : "ön"} önde=${n(al.fwd)} dx=${n(al.dx)} eğim=${al.rollO != null ? al.rollO.toFixed(1) : "null"}/${al.rollT != null ? al.rollT.toFixed(1) : "null"}°]` +
    ` kaydırPx=${hs.shiftPx != null ? Math.round(hs.shiftPx) : "null"} döndür=${hs.rollDeg != null ? hs.rollDeg.toFixed(1) : "null"}°` +
    (sh ? ` omuz=${sh.ok ? "yerinde" : `kaymış[${sh.reason}]`}${sh.dx != null ? `/${n(sh.dx)},${n(sh.dy)}x${n(sh.wRatio)}` : ""}` : "");
  const hacim = ` kafaHacmi=${n(hs.volRatio)}${hs.volUsed ? "" : "[kullanılmadı]"} genişlik=${n(hs.widthRatio)}${hs.widthUsed ? "[kullanıldı]" : ""}`;
  const ölçü = `s=${n(hs.s)} ham=${n(hs.rawS)} yüzOranı=${n(hs.faceRatio)} ${parçalar}${hacim} gövdeIoU=${n(hs.bodyIou)} yüzKayması=${n(hs.faceShift)} çeneDy=${n(hs.chinDy)} kaldırmaPx=${hs.liftPx != null ? Math.round(hs.liftPx) : "null"}${hiza}${hs.limbProtected ? " uzuvKoruması=evet" : ""}${hs.ghostLayerPx != null ? ` taşınmayanHayalet=${hs.ghostLayerPx}` : ""}${hs.touch != null ? ` dokunma=${n(hs.touch)}` : ""}${hs.silReason ? ` silüetYok=${hs.silReason}` : ""}${hs.planS != null ? ` plan=${n(hs.planS)} açıkŞablon=${n(hs.exposed)}` : ""}${hs.sEff != null ? ` izinliS=${n(hs.sEff)}` : ""}`;
  const applied = !!(hs.applied && hs.buf);
  const delik = applied ? `taşınanPx=${hs.movedPx} delikPx=${hs.holePx ?? "null"} delikDerinlik=${hs.holeDepth != null ? Math.round(hs.holeDepth) : "null"}` : "";
  return { applied, reason: hs.reason, buf: applied ? hs.buf : null, holeMask: applied ? hs.holeMask || null : null, headMask: applied ? hs.headMask || null : null, inpaint: applied ? plainInpaint(hs.inpaint) : null, ölçü, delik, s: hs.s ?? null, moves: !!(hs.liftPx || hs.shiftPx || hs.rollDeg) };
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

/** BUKLE KALINTISI (bkz. curlRemnant.js). Dolgu çağıranda (fillHeadJobLocally). */
async function curlRemnantPrep({ buf, tpl }) {
  const { prepareCurlRemnantFill } = require("./curlRemnant");
  const cr = await prepareCurlRemnantFill(toBuf(buf), toBuf(tpl));
  const { inpaint, ...rest } = cr;
  return { ...rest, inpaint: plainInpaint(inpaint) };
}

async function fringePrep({ buf, tpl }) {
  const { prepareHeadFringeRepaint } = require("./headScale");
  const fr = await prepareHeadFringeRepaint(toBuf(buf), toBuf(tpl));
  const { inpaint, ...rest } = fr;
  return { ...rest, inpaint: plainInpaint(inpaint) };
}

/**
 * IŞIKLI (2026-10-21, FaceApp örneğinden ölçülen ton eğrisi, bkz.
 * faceGlow.js): yalnız koyu arka planlı karelerde. Log metni burada kurulur,
 * yazdırma çağıranda.
 * KİŞİ = SAHNE (2026-11-01, kullanıcı: "ışıklandırma arka plana göre tam
 * yerinde"): 0.6/0.3 kişiyi sahneden ~+3 L fazla açıyordu (831a00a4'te yüz
 * base'den +0.41 stop). Eşit güçte tüm kareye aynı eğri: FaceApp ışığı kalır,
 * yüz-arka plan ilişkisi base'deki gibi. Eski hâl: GLOW_PERSON 0.6, GLOW_SCENE 0.3.
 */
const GLOW_PERSON = 0.45;
const GLOW_SCENE = 0.45;
async function glow({ buf, tpl = null }) {
  const { applyGlowFilter, _testables: GT } = require("./faceGlow");
  const sharp = require("sharp");
  // Şablon yüzü tavanı: iki yüzün L'si faceTone'un ölçüsüyle (yüz kutusu yakını, kırpılmış ortalama).
  let headroom = null, tplL = null, curL = null;
  if (tpl && GT.TPL_FACE_CAP.ON) try {
    const T = require("./faceTone")._testables;
    const Lab = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
    const lOf = async (b) => { const m = await sharp(b).metadata(); const S = await T.probsOf(await sharp(b).png().toBuffer(), m.width, m.height); const st = S && T.skinStats(S); return st ? Lab(st.Y) : null; };
    tplL = await lOf(toBuf(tpl)); curL = await lOf(toBuf(buf));
    if (tplL != null && curL != null) headroom = tplL + GT.TPL_FACE_CAP.MARGIN - curL;
  } catch { /* ölçülemezse eski sınır */ }
  const gl = await applyGlowFilter(toBuf(buf), { strength: GLOW_PERSON, bgStrength: GLOW_SCENE, faceHeadroom: headroom });
  const n = (v) => (v != null ? v.toFixed(1) : "null");
  const applied = !!(gl.applied && gl.buf);
  const ölçü = applied
    ? `arkaPlanL=${n(gl.bgL)} güç=${gl.gate.toFixed(2)} gri=${gl.grayscale ? 1 : 0} yüzSınırı=${gl.faceCap ? `halka+${n(gl.faceCap.ringLift)}→en çok ${n(gl.faceCap.limit)}${gl.faceCap.tplCapped ? " (şablon yüzü tavanı)" : ""}` : "yok"} yüzL=${n(curL)} şablonYüzL=${n(tplL)}`
    : `ATLANDI[${gl.reason}] arkaPlanL=${n(gl.bgL)}`;
  return { applied, buf: applied ? gl.buf : null, ölçü };
}

/**
 * SELFIE'DEN YÜZ DETAYI (2026-10-22, bkz. faceDetailTransfer.js). Log metni
 * burada kurulur, yazdırma çağıranda.
 */
async function selfieDetail({ buf, selfies }) {
  const { transferSelfieDetail } = require("./faceDetailTransfer");
  const r = await transferSelfieDetail(toBuf(buf), (selfies || []).map(toBuf));
  const n = (v) => (v != null && Number.isFinite(v) ? v.toFixed(2) : "null");
  const ölçü = `selfie=${r.selfieIdx ?? "-"} yön=${n(r.yawOut)}/${n(r.yawSelfie)} ölçek=${n(r.k)} yüzBoyu=${r.faceH != null ? Math.round(r.faceH) : "null"} detay=${n(r.hfOut)}/${n(r.hfSelfie)} deriPx=${r.skinPx ?? "null"} ölüPx=${r.deadPx ?? "null"} ters=${r.flipped ?? "null"}`;
  return { applied: !!(r.applied && r.buf), buf: r.applied ? r.buf : null, reason: r.reason, ölçü };
}

/** AI çıktısını inpaint işine yerleştirir (bkz. headScale.finishInpaint). */
async function finishInpaint({ job, ai, base }) {
  const { _finishInpaint } = require("./headScale");
  if (job.rgb) job.rgb = toBuf(job.rgb);
  return _finishInpaint(job, toBuf(ai), toBuf(base));
}

/**
 * SELFIE'Yİ BASE POZUNA ÇEVİRME (2026-10-31, bkz. headPose3d.reposeFace) —
 * ağ + bükme + iki ölçüm ~1 sn; ana iş parçacığını bloklamasın diye havuzda.
 * base verilirse (refMatch.baseFeatures) bakış/kapak/yatıklık/ağız da base'e
 * uydurulur (+~0.5 sn), poz çevrilmese bile.
 */
async function reposeSelfie({ buf, yaw, pitch = null, mirror = false, base = null, only = null }) {
  const { reposeFace } = require("./headPose3d");
  const rp = await reposeFace(toBuf(buf), { yaw, pitch }, { mirror });
  if (base && rp && rp.buf) {
    const m = await require("./refMatch").matchRefToBase(rp.buf, base, { only });
    rp.match = { applied: m.applied, steps: m.steps, log: m.log, ms: m.ms };
    if (m.applied && m.buf) rp.buf = m.buf;
  }
  return rp;
}

/** SELFIE IŞIĞINI EŞİTLEME (2026-11-03, bkz. selfieLight.js) — segmentasyon havuzda. */
async function flattenSelfie({ buf }) {
  return require("./selfieLight").flattenSelfieLight(toBuf(buf));
}

/** SELFIE KAFA KIRPIMI (2026-11-08, bkz. selfieCrop.js) — segmentasyon havuzda. */
async function cropSelfieHead({ buf }) {
  return require("./selfieCrop").cropSelfieHead(toBuf(buf));
}

/** GÜNEŞ GÖZLÜĞÜNÜ BASE'DEN TAŞIMA (2026-11-03, bkz. sunglassTransfer.js). */
async function sunglassTransfer({ buf, tpl }) {
  return require("./sunglassTransfer").transferSunglasses(toBuf(buf), toBuf(tpl));
}

/**
 * GÖZLÜKTE KENDİ GÖZ + CAM TONU (2026-11-12, bkz. eyewearOwnEye.js,
 * eyewearLensTint.js) — gözlük bileşiminden sonra, havuzda, tek gidiş-dönüş:
 * önce kendi göz, sonra cam tonu/çerçeve rengi. png: son görüntü (hiçbiri
 * uygulanmadıysa null).
 */
async function eyewearOwnEye({ preBuf, fixBuf, W, H, rect, geom, tplBuf, ownEyeOn = true, lensTintOn = true }) {
  const sharp = require("sharp");
  preBuf = toBuf(preBuf); fixBuf = toBuf(fixBuf); tplBuf = toBuf(tplBuf);
  const [preRgb, fixRgb] = await Promise.all([preBuf, fixBuf].map((b) => sharp(b).removeAlpha().raw().toBuffer()));
  const r = await require("./eyewearLensTint").ownEyeThenTint({ preBuf, preRgb, fixBuf, fixRgb, W, H, rect, geom, tplBuf, ownEyeOn, lensTintOn });
  return { png: r.png, ownEye: r.ownEye, lensTint: r.lensTint };
}

/** ŞABLON GÖZÜNDE GÖZLÜK PAYI (2026-11-12, ZIT BAKIŞ kapısı; bkz. gazeGate.IRIS_TPL_GLASS_SKIP). */
/** ŞAPKA KAPISI (2026-11-19): şablon şapkası çıktıda duruyor mu (ghostClean.measureHatKept). */
async function hatKept({ out, tpl }) {
  return require("./ghostClean").measureHatKept(toBuf(out), toBuf(tpl));
}

async function eyeGlassShare({ tpl }) {
  return { share: await require("./sunglassTransfer").eyeGlassShare(toBuf(tpl)) };
}

/**
 * ŞABLON ŞAPKA (2026-11-06, bkz. hatDetect.js) — üretimden önce, şablon başına
 * bir kez: prompt seçer; şapka maskesi geri yerleştirmede, sonuç bitirmede
 * (ghostClean) kullanılır. Segmentasyon + (alan geçerse) OWLv2 havuzda.
 */
async function templateHat({ tpl }) {
  return require("./hatDetect").detectTemplateHat(toBuf(tpl));
}

// EL ONARIMI yerel parçaları (bkz. handRepair.js): ücretli çağrı ana iş parçacığında, analiz ve
// yapıştırma worker havuzunda.
async function handRepairPrep(p) { return require("./handRepair").prepareHands(p); }
async function handRepairFinish(p) { return require("./handRepair").finishHands(p); }

module.exports = { _testables: { SKIN_FIELD_SIMPLE, FINISH }, layers, simpleFinish, handRepairPrep, handRepairFinish, reposeSelfie, flattenSelfie, cropSelfieHead, sunglassTransfer, eyeGlassShare, hatKept, eyewearOwnEye, templateHat, headScale, surroundPrep, curlRemnantPrep, fringePrep, glow, selfieDetail, finishInpaint, toBuf };
