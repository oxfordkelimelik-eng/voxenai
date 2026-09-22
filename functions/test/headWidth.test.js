const { test } = require("node:test");
const assert = require("node:assert/strict");
const { headWidthMeasurement } = require("../falPhotos")._testables;

// İNCE KAFA/OMUZ ÖLÇÜMÜ (2026-09-22).
//
// Mevcut HEAD_SPAN satırları kafa/omuz oranını zaten soruyordu ama ölçeği
// kaba (0.5 kademe) ve pratikte tek kovaya doyuyor: 22 Eylül'de 84 karenin
// 77'si "2.5 / 2.5" geldi. Kullanıcının gözle "kafa çok büyük" dediği İKİ
// kare de 2.5/2.5 ölçülmüştü — biri o günün en yüksek sayısal büyümesine
// (1.20) sahipti. Bu yüzden ham genişlikler ayrı ayrı isteniyor ve oran
// KODDA hesaplanıyor.
//
// BU ÖLÇÜM HİÇBİR KAREYİ ELEMEZ. Testler yalnızca matematiği ve "kanıt
// yoksa sayı üretme" kuralını kilitler.

const lines = (bh, bs, oh, os) => ({
  baseHeadWLine: bh == null ? undefined : `BASE_HEAD_W: ${bh}`,
  baseShoulderWLine: bs == null ? undefined : `BASE_SHOULDER_W: ${bs}`,
  outHeadWLine: oh == null ? undefined : `OUTPUT_HEAD_W: ${oh}`,
  outShoulderWLine: os == null ? undefined : `OUTPUT_SHOULDER_W: ${os}`,
});

test("oran = omuz / kafa ve fark = çıktı - taban", () => {
  // Taban: omuza 3 kafa sığıyor. Çıktı: 2.5 — yani kafa büyümüş.
  const m = headWidthMeasurement(lines(10, 30, 12, 30));
  assert.equal(m.baseRatio, 3);
  assert.equal(m.outRatio, 2.5);
  assert.equal(m.diff, -0.5);
});

test("kafa küçüldüyse fark POZİTİF olur (yön karışmasın)", () => {
  const m = headWidthMeasurement(lines(12, 30, 10, 30));
  assert.ok(m.diff > 0, `fark pozitif olmalıydı, ${m.diff} geldi`);
});

test("omuz 0 (kadraj dışı) ise o tarafın oranı null — sayı uydurulmaz", () => {
  const m = headWidthMeasurement(lines(10, 0, 12, 30));
  assert.equal(m.baseRatio, null);
  assert.equal(m.outRatio, 2.5);
  assert.equal(m.diff, null, "tek taraf ölçülemiyorsa fark hesaplanmamalı");
});

test("satır hiç yoksa her şey null döner, patlamaz", () => {
  const m = headWidthMeasurement({});
  assert.equal(m.baseHead, null);
  assert.equal(m.outHead, null);
  assert.equal(m.baseRatio, null);
  assert.equal(m.diff, null);
});

test("argümansız çağrı patlamaz (fail-safe)", () => {
  const m = headWidthMeasurement();
  assert.equal(m.diff, null);
});

test("sayı olmayan/NO_SHOULDERS cevabı null sayılır", () => {
  const m = headWidthMeasurement({
    baseHeadWLine: "BASE_HEAD_W: NO_SHOULDERS",
    baseShoulderWLine: "BASE_SHOULDER_W: unknown",
    outHeadWLine: "OUTPUT_HEAD_W: 12",
    outShoulderWLine: "OUTPUT_SHOULDER_W: 30",
  });
  assert.equal(m.baseHead, null);
  assert.equal(m.baseRatio, null);
  assert.equal(m.outRatio, 2.5);
});

test("ondalık cevap da okunur (model tamsayı istenmesine rağmen yazabilir)", () => {
  const m = headWidthMeasurement(lines("10.5", "31.5", "10.5", "31.5"));
  assert.equal(m.baseRatio, 3);
  assert.equal(m.diff, 0);
});

// ÖLÇÜM SATIRLARININ VERDICT SANILMAMASI (regresyon koruması).
//
// assessOutputWithVisionOnce, "bilinen satır olmayan ilk satırı" verdict
// kabul ediyor. Yeni dört ölçüm satırı o elemeye eklenmezse biri verdict
// sanılır ve TÜM Vision ayrıştırması bozulur. Kaynak metin üzerinden
// doğrulanıyor çünkü ayrıştırma büyük bir async fonksiyonun içinde ve
// oradan saf fonksiyon olarak çıkarmak, kritik akışı gereksiz riske atardı.
test("dört yeni ölçüm satırı verdict elemesine dahil (sessiz ayrıştırma kırılması imkânsız)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "falPhotos.js"), "utf8");
  const block = /const verdictLine = lines\.find\(([\s\S]*?)\) \|\| "";/.exec(src);
  assert.ok(block, "verdictLine bloğu bulunamadı — test güncellenmeli");
  for (const pred of [
    "isBaseHeadWLine", "isBaseShoulderWLine", "isOutHeadWLine", "isOutShoulderWLine",
  ]) {
    assert.ok(
      block[1].includes(pred),
      `${pred} verdictLine elemesinde yok — ölçüm satırı verdict sanılabilir`
    );
  }
});

test("prompt satır sayısı ile listelenen satır sayısı tutarlı", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.ok(
    src.includes("Reply on exactly nineteen lines:"),
    "satır sayısı talimatı güncellenmemiş"
  );
  assert.ok(
    src.includes("Decide the first eighteen lines before the verdict."),
    "verdict öncesi satır sayısı güncellenmemiş"
  );
  // 19 = 18 sınıf/ölçüm satırı + 1 verdict. Dördü bu değişiklikle eklendi.
  for (const line of [
    "BASE_HEAD_W:", "BASE_SHOULDER_W:", "OUTPUT_HEAD_W:", "OUTPUT_SHOULDER_W:",
  ]) {
    assert.ok(src.includes(`"${line}`), `${line} prompt'ta listelenmemiş`);
  }
});
