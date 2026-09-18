const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// falPhotos.js bir Cloud Functions modülü (firebase-admin/secrets yükler), bu
// yüzden require edilemiyor — kaynak okunuyor. Amaç DAVRANIŞI çalıştırmak
// değil, 2026-09-18'de geri alınan kusurların geri SIZMAMASINI kilitlemek.
const FAL = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
const FQ = fs.readFileSync(path.join(__dirname, "..", "faceQuality.js"), "utf8");

// ===========================================================================
// GAZE — GAZE_POINT ARKA KAPISI
// ===========================================================================
//
// GERÇEK KUSUR (2026-09-16 -> 2026-09-18): GAZE_POINT kapısının ELEME yetkisi
// 2026-09-16'da ölçümle alındı, ama prompt'taki "GAZE_POINT DIFFERENT ->
// BAD_GAZE" bağlayıcı kuralı ve verdict satırındaki "BAD_GAZE -> reason:gaze"
// güvencesi yerinde kaldı. Model kararını verdict'e yazmaya devam etti, kod da
// o verdict'i reddetti — kapı kaldırıldı sanılırken arka kapıdan eliyordu.
//
// ÖLÇÜLEN BEDEL (21 iş, 212 ret): 106 vision-gaze reddi = tüm retlerin %50'si.
// 106'nın 97'sinin gerekçe metni harfiyen GAZE_POINT'in cümlesiydi
// ("eyes look at a different point than the base").

test("prompt GAZE_POINT'i artık BAD_GAZE'e bağlamıyor", () => {
  assert.doesNotMatch(FAL, /GAZE_POINT DIFFERENT -> BAD_GAZE/);
});

test("GAZE_POINT satırı ÖLÇÜM olarak duruyor (kapı kalktı, ölçüm kalmadı değil)", () => {
  // Satırın kendisi hâlâ isteniyor ve loglanıyor; yalnızca eleme yetkisi yok.
  assert.match(FAL, /GAZE_POINT: <SAME \| DIFFERENT>/);
  assert.match(FAL, /gazePointLine/);
});

test("BAD_GAZE verdict'i artık 'gaze' reddine dönüşmüyor", () => {
  assert.doesNotMatch(FAL, /startsWith\("BAD_GAZE"\)\)\s*return\s*\{\s*ok:\s*false/);
});

// KRİTİK: BAD_GAZE yalnızca loglanıp DÜŞSEYDİ, aşağıdaki "BAD ile başlayan her
// şey -> quality" yakalayıcısına takılır ve aynı kare bu kez "vision-quality"
// olarak yine reddedilirdi. Yani sadece reddi kaldırmak YETMEZ, açıkça kabul
// dönmek gerekir. Bu test o inceliği kilitler.
test("BAD_GAZE açıkça KABUL dönüyor (generic BAD yakalayıcısına düşmüyor)", () => {
  const i = FAL.indexOf('answer.startsWith("BAD_GAZE")');
  assert.ok(i > 0, "BAD_GAZE dalı bulunamadı");
  const j = FAL.indexOf('answer.startsWith("BAD_HANDS")');
  assert.ok(j > i, "BAD_HANDS dalı BAD_GAZE'den sonra gelmeli");
  const block = FAL.slice(i, j);
  assert.match(block, /return\s*\{\s*ok:\s*true/);
});

// Referanssız ("self") modda GAZE_DIRECTION: WRONG_DIRECTION hâlâ GERÇEK bir
// kapı — o prompt'taki eşlemesi SİLİNMEMELİ.
test("WRONG_DIRECTION -> BAD_GAZE eşlemesi duruyor (o kapı gerçek)", () => {
  assert.match(FAL, /WRONG_DIRECTION -> BAD_GAZE/);
});

// ===========================================================================
// ARTEFAKT — ONARIM BÜTÇESİ VE İKİNCİ YOL
// ===========================================================================
//
// ÖLÇÜM (21 iş): 74 artefakt reddine karşılık onarım yalnızca 30 kez denendi
// ve 24'ü başarılı oldu (%80). Onarım çalışıyordu; çoğu artefakta ULAŞAMIYORDU.

test("onarım chunk başına BÜTÇELİ (tek seferlik bayrak geri gelmemiş)", () => {
  assert.match(FAL, /const ARTIFACT_REPAIR_MAX_PER_CHUNK = \d+;/);
  assert.match(FAL, /artifactRepairsUsed < ARTIFACT_REPAIR_MAX_PER_CHUNK/);
  // Eski tek-seferlik bayrak KOD olarak geri gelmemeli. (Adı yorumlarda
  // geçiyor — gerekçeyi anlatan tarih notu orada bilerek duruyor.)
  assert.doesNotMatch(FAL, /let artifactRepairTried/);
  assert.doesNotMatch(FAL, /artifactRepairTried\s*=\s*true/);
});

test("bütçe deneme sayısından AYRI ve ondan küçük (kredi koruması)", () => {
  const budget = Number(/const ARTIFACT_REPAIR_MAX_PER_CHUNK = (\d+);/.exec(FAL)[1]);
  const attempts = Number(/const OPENAI_DIRECT_MAX_ATTEMPTS = (\d+);/.exec(FAL)[1]);
  assert.ok(budget >= 1 && budget < attempts, `bütçe=${budget} deneme=${attempts}`);
});

// TAM KARE Vision artefakt reddi (27 ret) onarım yoluna HİÇ uğramıyordu:
// o dal `continue` ile bir sonraki denemeye geçiyor, onarımı yapan kırpma
// kapısına hiç gelinmiyordu.
test("tam kare artefakt reddi de onarım deniyor", () => {
  const k = FAL.indexOf('!visionOk && visionReason === "artifact"');
  assert.ok(k > 0, "tam kare onarım dalı yok");
  const block = FAL.slice(k, k + 2000);
  assert.match(block, /tryArtifactRepair/);
  // Onarım, reddin KENDİSİNDEN önce gelmeli — sonra gelirse `continue` ile
  // bir sonraki denemeye geçilir ve onarıma hiç ulaşılmaz (düzeltilen kusur).
  const reject = FAL.indexOf("const visionGate = `vision-${visionReason", k);
  assert.ok(reject > k, "onarım dalı red dalından SONRA kalmış");
});

test("iki yol da AYNI onarım yardımcısını kullanıyor (mantık çatallanmasın)", () => {
  const calls = FAL.match(/await tryArtifactRepair\(/g) || [];
  assert.equal(calls.length, 2, `tryArtifactRepair çağrısı ${calls.length}, beklenen 2`);
});

// KİMLİK: mutlak eşik yerine SÜRÜKLENME. 30 onarımın 6'sı yalnızca kimlik
// kontrolünden düşmüştü (ölçülen 0.512 gibi eşiğin hemen üstü değerler) —
// oysa kare onarımdan ÖNCE kimlik kapısından geçmişti ve onarım göz/ağız
// bantlarına hiç dokunmuyor.
test("onarım kimliği SÜRÜKLENMEYLE ölçüyor ama sert tavanı da var", () => {
  assert.match(FAL, /const REPAIR_IDENTITY_MAX_DRIFT = [\d.]+;/);
  assert.match(FAL, /const REPAIR_IDENTITY_HARD_MAX = [\d.]+;/);
  assert.match(FAL, /dist <= preDist \+ REPAIR_IDENTITY_MAX_DRIFT/);
  assert.match(FAL, /dist <= REPAIR_IDENTITY_HARD_MAX/);
});

test("sürüklenme toleransı sert tavanı geçersiz kılamaz (değer kontrolü)", () => {
  const drift = Number(/const REPAIR_IDENTITY_MAX_DRIFT = ([\d.]+);/.exec(FAL)[1]);
  const hard = Number(/const REPAIR_IDENTITY_HARD_MAX = ([\d.]+);/.exec(FAL)[1]);
  assert.ok(drift > 0 && drift <= 0.15, `sürüklenme ${drift} fazla gevşek`);
  assert.ok(hard > 0.5 && hard <= 0.65, `sert tavan ${hard} makul aralıkta değil`);
});

// ===========================================================================
// EL TONU — KUMAŞ KORUMASI
// ===========================================================================
//
// KULLANICI ŞİKÂYETİ (teslim edilmiş kareler): "gömlek kısmı seçilmiş
// blurlanmış", "eller siyah kalmış ve o kısım tamamen blurlanmış". Sebep:
// limbBox kutuları 6x8'lik ızgaradan geliyor, gömleği de içine alıyor;
// isSkinLike bej kumaşı ten sayıyor; en büyük bileşen olarak GÖMLEK
// seçiliyor ve tüm alan tek bir L* kaymasıyla (ölçülen uç: -14.0) düz bir
// lekeye dönüyor.

test("kumaş koruması yüze göre ölçüyor (piksel eşiği değil)", () => {
  assert.match(FQ, /const HAND_FIX_MAX_COMPONENT_VS_FACE = [\d.]+;/);
  assert.match(FQ, /const HAND_FIX_MAX_TOTAL_VS_FACE = [\d.]+;/);
  assert.match(FQ, /bestSize > faceArea \* HAND_FIX_MAX_COMPONENT_VS_FACE/);
  assert.match(FQ, /selectedCount > faceArea \* HAND_FIX_MAX_TOTAL_VS_FACE/);
});

test("kenar-dolduran bileşen (yüzey) atlanıyor", () => {
  assert.match(FQ, /const HAND_FIX_MAX_BORDERS_TOUCHED = \d+;/);
  assert.match(FQ, /borders > HAND_FIX_MAX_BORDERS_TOUCHED/);
});

// El kabaca yüz büyüklüğündedir; gövde yüzün 6-12 katıdır. Eşik bu aralığın
// ORTASINDA olmalı: 1'in altına inerse gerçek eller elenir, 5'i geçerse
// gömlek yine içeri girer.
test("yüze göre eşikler el ile gövdeyi ayırabilecek aralıkta", () => {
  const perBox = Number(/const HAND_FIX_MAX_COMPONENT_VS_FACE = ([\d.]+);/.exec(FQ)[1]);
  const total = Number(/const HAND_FIX_MAX_TOTAL_VS_FACE = ([\d.]+);/.exec(FQ)[1]);
  assert.ok(perBox >= 1.5 && perBox <= 4, `kutu başı eşik ${perBox} aralık dışı`);
  assert.ok(total >= perBox && total <= 8, `toplam eşik ${total} aralık dışı`);
});

test("atlama sebebi loglanabilir olarak dönüyor (kalibrasyon verisi)", () => {
  assert.match(FQ, /skippedFabric/);
  assert.match(FQ, /areaVsFace/);
  assert.match(FAL, /kumaşAtlanan=/);
  assert.match(FAL, /alanYüzeGöre=/);
});
