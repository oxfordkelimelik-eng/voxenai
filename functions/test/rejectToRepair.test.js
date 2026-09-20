const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// falPhotos.js bir Cloud Functions modülü (firebase-admin/secrets yükler), bu
// yüzden require edilemiyor — kaynak okunuyor. Amaç DAVRANIŞI çalıştırmak
// değil, 2026-09-18'de geri alınan kusurların geri SIZMAMASINI kilitlemek.
const FAL = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
const FQ = fs.readFileSync(path.join(__dirname, "..", "faceQuality.js"), "utf8");

// "Geri gelmemiş" testleri YORUMLARA takılmamalı: bu dosyada geri alınan her
// kural, neden geri alındığıyla birlikte açıklama olarak SAKLANIYOR. Kuralın
// metni yorumda geçtiği için doesNotMatch yanlışlıkla patlıyordu — bu yüzden
// yalnızca ÇALIŞAN kodu içeren bir kopya tutuluyor.
const stripComments = (src) =>
  src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const FQ_CODE = stripComments(FQ);

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

// BOYUT ÖLÇÜSÜ GERİ ALINDI (2026-09-19) — GERÇEK ÜRETİMLE ÇÜRÜDÜ.
//
// "Bileşen yüz alanının 2.5 katını aşarsa kumaştır" kuralı, gerçek uzuv
// bileşenlerini eliyordu: ölçülen oranlar 15.5x / 17.0x / 24.9x / 19.3x —
// çünkü bu kutular eli değil KOLU kapsıyor ve face-api'nin yüz kutusu dar.
// 9 karenin 7'sinde düzeltme tamamen atlanırdı. Bu test, o kuralın kod
// olarak geri sızmamasını kilitler.
test("boyut tabanlı kumaş kuralı geri gelmemiş", () => {
  assert.doesNotMatch(FQ, /bestSize > faceArea \* HAND_FIX_MAX_COMPONENT_VS_FACE/);
  assert.doesNotMatch(FQ, /selectedCount > faceArea \* HAND_FIX_MAX_TOTAL_VS_FACE/);
  assert.doesNotMatch(FQ, /borders > HAND_FIX_MAX_BORDERS_TOUCHED/);
});

// AYIRAN ÖLÇÜ a*: aynı kişinin kolu yüzüyle aynı renk ailesindedir (kusur
// açıklıkta), ahşap/hasır/duvar ise belirgin daha az kırmızıdır.
// Ölçülen: gerçek uzuv da<=1.7, yüzey da>=3.6.
test("kumaş koruması a* (kırmızılık) ile yüzeye göre ölçüyor", () => {
  assert.match(FQ, /const HAND_FIX_MAX_A_BELOW_FACE = [\d.]+;/);
  assert.match(FQ, /faceTone\[1\] - compAMed > HAND_FIX_MAX_A_BELOW_FACE/);
});

test("a* eşiği ölçülen iki kümenin ARASINDA", () => {
  const v = Number(/const HAND_FIX_MAX_A_BELOW_FACE = ([\d.]+);/.exec(FQ)[1]);
  // Gerçek uzuvların en kötüsü 1.7, yüzeylerin en iyisi 3.6 — eşik bu ikisinin
  // arasında kalmalı, yoksa ya gerçek kolu eler ya kumaşı içeri alır.
  assert.ok(v > 1.7 && v < 3.6, `a* eşiği ${v} iki kümenin arasında değil`);
});

// ===========================================================================
// TAM ÇÖZÜNÜRLÜK AĞIRLIĞI — BENEK ÜRETEN İKİLİ KAPI GERİ GELMESİN
// ===========================================================================
//
// GERÇEK KUSUR (2026-09-20, teslim edilmiş kare 5fd3c3bc chunk7): yumruğun
// üstünde basamaklı, benekli bir yama. Sebep, maske YUMUŞATILDIKTAN SONRA tam
// çözünürlükte çalışan İKİLİ kapıydı; üstelik eşiği (lab[0] < compLab[0])
// bölgenin KENDİ MEDYANI olduğu için bölgenin her yerinde açılıp kapanıyordu.
//
// ÖLÇÜLDÜ (komşu piksele verilen ağırlığın >0.5 zıpladığı oran):
//   bölge              ESKİ     YENİ
//   c7 yumruk (bozuk)  6.09%    0.17%
//   c8 eller (temiz)   1.27%    0.00%
//   c4 sol kol         0.87%    0.06%
//   dün c0 sol kol     1.13%    0.01%
// Bozuk kare, temiz karelerden 5-7 kat daha fazla sert zıplama üretiyordu —
// yani ölçülen şey gerçekten kusurun kendisi.

test("tam çözünürlük kararı SÜREKLİ, ikili değil", () => {
  // Ağırlık bir rampadan gelmeli ve boyama o ağırlıkla çarpılmalı.
  assert.match(FQ, /const chromaW\s*=/);
  assert.match(FQ, /const w = alpha \* chromaW/);
  assert.match(FQ, /lab\[0\] \+ shiftL \* w/);
});

test("benek üreten ikili kapı geri gelmemiş", () => {
  // Medyanın kendisini eşik yapan koşul bir daha yazılmamalı.
  assert.doesNotMatch(FQ_CODE, /lab\[0\] < compLab\[0\]/);
  // Luma tabanlı ikili ten testi boyama döngüsünde eleme yapmamalı.
  assert.doesNotMatch(FQ_CODE, /if \(!isSkinLike\(data\[o\]/);
});

// Gölgedeki tenin düzeltilmesi 2026-09-19 kazanımıydı; yeni kural LUMA'ya
// hiç bakmadığı için bu kazanım korunuyor — kroma rampasında L* geçmemeli.
test("kroma rampası luma kullanmıyor (gölgedeki ten tam ağırlıkta)", () => {
  const m = /const dChroma = ([^;]+);/.exec(FQ);
  assert.ok(m, "dChroma hesabı bulunamadı");
  assert.match(m[1], /lab\[1\][\s\S]*lab\[2\]/);
  assert.doesNotMatch(m[1], /lab\[0\]/);
});

// Eşikler ölçülen iki kümenin ARASINDA olmalı: gerçek tenin en kötü p95'i
// 20.3, ayrışan yüzeylerin en iyi p10'u 22.1.
test("kroma eşikleri ölçülen iki kümenin arasında", () => {
  const full = Number(/const HAND_FIX_CHROMA_FULL = ([\d.]+);/.exec(FQ)[1]);
  const zero = Number(/const HAND_FIX_CHROMA_ZERO = ([\d.]+);/.exec(FQ)[1]);
  assert.ok(full < zero, "tam güç eşiği sıfır eşiğinin altında olmalı");
  // Gerçek tenin çoğunluğu tam güçte kalsın (ölçülen p50'ler 3.6-10.4).
  assert.ok(full >= 12, `tam güç eşiği ${full} çok düşük — gerçek teni sönümler`);
  // Ayrışan yüzeyler (p10 >= 22.1) sıfıra yakın ağırlık almalı.
  assert.ok(zero <= 30, `sıfır eşiği ${zero} çok yüksek — yabancı yüzeyi boyar`);
});

// Tam ton-yakınlığı (labDistance) denendi ve fazla genişti — hue kayması
// olan komşu yüzeyleri de alıyordu. Geri sızmasın.
test("labDistance tabanlı geniş gevşetme geri gelmemiş", () => {
  assert.doesNotMatch(FQ, /labDistance\(lab, compLab\)/);
});

// Düzeltme gücü/tavanı: tavan gerçek üretimde sürekli dayanıyordu
// (19.2->5.2, 20.1->6.1, 21.5->7.5 hepsi kayma=14.0 ile tavanda).
test("düzeltme gücü ve tavanı artırıldı ama tam eşitleme yapılmıyor", () => {
  const s = Number(/const HAND_FIX_STRENGTH = ([\d.]+);/.exec(FQ)[1]);
  const cap = Number(/const HAND_FIX_MAX_SHIFT_L = (\d+);/.exec(FQ)[1]);
  assert.ok(s > 0.8 && s < 1.0, `güç ${s} — 1.0 elin hacmini düzleştirir`);
  assert.ok(cap >= 20, `tavan ${cap} ölçülen 21.5'lik farkı karşılamıyor`);
});

// ===========================================================================
// KAFA BÜYÜMESİ — MUTLAK TABAN
// ===========================================================================
//
// 4 günlük üretim: head-grew ile reddedilen 11 karenin 10'u, YÜZLERCE kabul
// edilmiş karenin yüzOranı bandındaydı (geçenler p95=0.232 maks=0.315;
// reddedilenler 0.172-0.26). Aynı işte yüzOranı=0.210 KABUL, 0.195 RED.
test("head-grew artık mutlak yüz oranını da arıyor", () => {
  assert.match(FQ, /const OUTPUT_FACE_GROWTH_MIN_RATIO = [\d.]+;/);
  assert.match(FQ, /growth > OUTPUT_FACE_GROWTH_MAX && faceRatio > OUTPUT_FACE_GROWTH_MIN_RATIO/);
});

test("mutlak taban geçen dağılımın üstünde, gerçek aykırının altında", () => {
  const v = Number(/const OUTPUT_FACE_GROWTH_MIN_RATIO = ([\d.]+);/.exec(FQ)[1]);
  // Geçen karelerin p95'i 0.232; tek gerçek aykırı 0.322.
  assert.ok(v > 0.232 && v < 0.322, `mutlak taban ${v} ölçülen aralıkta değil`);
});

test("atlama sebebi loglanabilir olarak dönüyor (kalibrasyon verisi)", () => {
  assert.match(FQ, /skippedFabric/);
  assert.match(FQ, /areaVsFace/);
  assert.match(FAL, /kumaşAtlanan=/);
  assert.match(FAL, /alanYüzeGöre=/);
});

// ===========================================================================
// KAFA DÖNÜŞÜ — YASAK DEĞİL PROSEDÜR
// ===========================================================================
//
// KULLANICI ŞİKÂYETİ (2026-09-20): "kafanın dönüş açısı taban fotoğraf ile
// tamamen aynı olmalı, birkaç fotoda bunu kaçırıyoruz."
//
// ÖLÇÜLDÜ (362 teslim edilmiş kare, KONUM ÖLÇÜM loglarından):
//   |yaw farkı| p50=0.120 p90=0.370 maks=0.810; fark>0.20 olan %31.5.
//   En kötü 12 vakanın 11'inde çıktı şablondan DAHA ÇOK dönmüş.
// Gözle doğrulandı (9f0d9406 chunk2, fark 0.570): şablon cepheye yakın,
// çıktı üç-çeyrek dönmüş — metrik gerçek kusuru ölçüyor.

test("kafa dönüşü ölçülebilir bir PROSEDÜR olarak anlatılıyor", () => {
  assert.match(FAL, /P2b HEAD TURN/);
  // Modelin İKİ GÖRSELİ DE kendisi ölçüp karşılaştırdığı üç adım.
  assert.match(FAL, /\(a\) In the FIRST image, find the two outer eye corners/);
  assert.match(FAL, /\(b\) Answer the same question about your own output/);
  assert.match(FAL, /\(c\) If the two answers differ, you rotated the head/);
});

test("kafa dönüşü ikinci bir yoldan da çapraz kontrol ediliyor", () => {
  // Tek ölçü yanılabilir; uzak yanak/kulak görünürlüğü bağımsız bir kontrol.
  assert.match(FAL, /how much of the FAR cheek and the FAR ear is visible/);
});

test("eski salt-yasak metni yerinde kalmamış (iki kural çakışmasın)", () => {
  assert.doesNotMatch(FAL, /HEAD ANGLE — keep the BASE person's turn to the same degree/);
});

// EN ÖNEMLİSİ: kendi ölçümümüzü prompt'a YAZMIYORUZ. Bu 2026-09-17'de
// denendi ve reddi kendisi üretti (ölçüm yanlışsa model itaat ediyor).
// Model iki görseli de KENDİSİ ölçmeli.
test("ölçülen yaw değeri prompt'a enjekte EDİLMİYOR", () => {
  const m = /function buildEditPromptP800[\s\S]*?\n}\r?\n/.exec(FAL);
  assert.ok(m, "buildEditPromptP800 bulunamadı");
  assert.doesNotMatch(m[0], /\$\{[^}]*(yaw|Yaw|profileDegree)[^}]*\}/);
});
