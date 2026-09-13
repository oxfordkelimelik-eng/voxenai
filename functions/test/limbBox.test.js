const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCellReply,
  cellsToCropBoxes,
  cropBoxToFrame,
  parseLimbCropReply,
  GRID_COLS,
  GRID_ROWS,
} = require("../limbBox");

// --- hücre cevabı ---

test("hücre listesi ayrıştırılır, sırasız ve tekrarlı gelse de", () => {
  const r = parseCellReply("CELLS: 32, 25, 25");
  assert.equal(r.ok, true);
  assert.deepEqual(r.cells, [25, 32]);
});

test("görünür çıplak uzuv yoksa boş liste geçerli cevaptır", () => {
  const r = parseCellReply("CELLS: NONE");
  assert.equal(r.ok, true);
  assert.deepEqual(r.cells, []);
});

test("ızgara dışındaki numaralar atılır", () => {
  const r = parseCellReply(`CELLS: 5, ${GRID_COLS * GRID_ROWS + 7}, 0`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cells, [5]);
});

// Çok fazla hücre = model gövdeyi işaretlemiş, konum bilgisi taşımıyor.
// Doğrudan-koordinat yolunda chunk 0'da görülen hatanın ta kendisi.
test("aşırı hücre seçimi konum bilgisi saymaz", () => {
  const r = parseCellReply("CELLS: 1,2,3,4,5,6,7,8,9,10,11,12,13");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too-many-cells");
});

test("ayrıştırılamayan cevap sessizce geçmez", () => {
  assert.equal(parseCellReply("I cannot help with that.").ok, false);
  assert.equal(parseCellReply("").ok, false);
});

// --- hücre → kutu ---

test("bitişik hücreler tek kutuda birleşir", () => {
  // 25 ve 31 aynı sütunda alt alta (6 sütunlu ızgara).
  const boxes = cellsToCropBoxes([25, 31]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].w, 1 / GRID_COLS);
  assert.equal(boxes[0].h, 2 / GRID_ROWS);
});

test("ayrık hücre grupları ayrı kutu verir — iki el ayrı ölçülsün", () => {
  // 25 (sütun 0, satır 4) ile 30 (sütun 5, satır 4) komşu değil.
  const boxes = cellsToCropBoxes([25, 30]);
  assert.equal(boxes.length, 2);
});

test("kırpma kutusu tam kare koordinatına doğru taşınır", () => {
  const crop = { x: 0.2, y: 0.5, w: 0.4, h: 0.5 };
  const box = cropBoxToFrame({ x: 0.5, y: 0, w: 0.5, h: 0.25 }, crop);
  assert.equal(box.x, 0.2 + 0.5 * 0.4);
  assert.equal(box.y, 0.5);
  assert.equal(box.w, 0.5 * 0.4);
  assert.equal(box.h, 0.25 * 0.5);
});

test("kırpma yapılmadıysa kutu değişmeden kalır", () => {
  const box = { x: 0.33, y: 0.75, w: 0.17, h: 0.125 };
  assert.deepEqual(cropBoxToFrame(box, { x: 0, y: 0, w: 1, h: 1 }), box);
});

// --- kırpma yargısı ---

test("hayalet el (chunk 0 ve chunk 1) reddedilir", () => {
  const r = parseLimbCropReply(
    "OPACITY: SEE_THROUGH\nSTRUCTURE: MALFORMED\nDEFINITION: SMEARED\n" +
    "BAD_LIMB: Hand is transparent, malformed, and smeared."
  );
  assert.equal(r.ok, true);
  assert.equal(r.bad, true);
  assert.deepEqual(r.flags, ["SEE_THROUGH", "MALFORMED", "SMEARED"]);
  assert.match(r.detail, /transparent/);
});

test("temiz uzuv geçer (chunk 3 / 7 / 8)", () => {
  const r = parseLimbCropReply(
    "OPACITY: SOLID\nSTRUCTURE: NORMAL\nDEFINITION: NORMAL\n" +
    "GOOD: Limb appears solid, coherent, and well-defined."
  );
  assert.equal(r.ok, true);
  assert.equal(r.bad, false);
  assert.deepEqual(r.flags, []);
});

// Sınıf satırı bağlayıcı, serbest metin değil: model GOOD yazsa bile
// SEE_THROUGH işaretlediyse kare elenir.
test("sınıf satırı ile karar çelişirse sınıf satırı kazanır", () => {
  const r = parseLimbCropReply(
    "OPACITY: SEE_THROUGH\nSTRUCTURE: NORMAL\nDEFINITION: NORMAL\nGOOD: looks fine"
  );
  assert.equal(r.bad, true);
});

test("tek bir kusur da yeter", () => {
  assert.equal(
    parseLimbCropReply("OPACITY: SOLID\nSTRUCTURE: NORMAL\nDEFINITION: SMEARED\nBAD_LIMB: smeared").bad,
    true
  );
});

test("ayrıştırılamayan cevapta fail-safe: kare elenmez", () => {
  const r = parseLimbCropReply("I'm sorry, I can't help with that.");
  assert.equal(r.ok, false);
});

// --- KIRPMA DOĞRULAMASI + "GÖREMEDİM" AYRIMI (2026-09-13) ----------------
// Kullanıcı üç reddi de yanlış buldu (0c609c0e c3/c8, f483d510 c7). İki
// ayrı kusur vardı: (1) belirsizlik red'e çevriliyordu, (2) kırpma elin
// olmadığı yere düşüyordu. Aşağıdaki testler ikisini de kilitler.

test("kırpmada el yok (eller cepte) — kapı ELEMEZ, f483d510 c7", () => {
  const r = parseLimbCropReply(
    "VISIBILITY: NONE\nOPACITY: NOT_VISIBLE\nSTRUCTURE: NOT_VISIBLE\n" +
    "DEFINITION: NOT_VISIBLE\nNO_LIMB: Crop shows only trouser fabric and a pocket."
  );
  assert.equal(r.ok, true);
  assert.equal(r.visible, false);
  assert.equal(r.bad, false);
  assert.equal(r.visibility, "NONE");
});

test("el yarı gizli/kesik (PARTIAL) — yargı yapılmaz, ELEMEZ", () => {
  const r = parseLimbCropReply(
    "VISIBILITY: PARTIAL\nOPACITY: NOT_VISIBLE\nSTRUCTURE: NOT_VISIBLE\n" +
    "DEFINITION: NOT_VISIBLE\nNO_LIMB: Only a wrist edge is visible."
  );
  assert.equal(r.visible, false);
  assert.equal(r.bad, false);
});

test("STRUCTURE: NOT_VISIBLE bir kusur DEĞİL — 'unclear' red'e çevrilmez", () => {
  // Gerçek cevap: "MALFORMED — Hand structure is unclear or malformed."
  // Model "göremedim" diyordu, eski parser bunu "bozuk" sayıyordu.
  const r = parseLimbCropReply(
    "VISIBILITY: FULL\nOPACITY: SOLID\nSTRUCTURE: NOT_VISIBLE\n" +
    "DEFINITION: NORMAL\nGOOD: Hand too small to judge, nothing visibly wrong."
  );
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.equal(r.bad, false);
  assert.deepEqual(r.flags, []);
});

test("VISIBILITY: FULL iken gerçek kusur hâlâ eler", () => {
  const r = parseLimbCropReply(
    "VISIBILITY: FULL\nOPACITY: SOLID\nSTRUCTURE: MALFORMED\n" +
    "DEFINITION: NORMAL\nBAD_LIMB: Six fingers on the left hand."
  );
  assert.equal(r.visible, true);
  assert.equal(r.bad, true);
  assert.deepEqual(r.flags, ["MALFORMED"]);
});

test("NO_LIMB verdict'i tek başına da görünürlüğü kapatır", () => {
  // Model biçimi tam tutturamazsa bile niyeti okunabilmeli.
  const r = parseLimbCropReply("NO_LIMB: hands are in pockets");
  assert.equal(r.ok, true);
  assert.equal(r.visible, false);
  assert.equal(r.bad, false);
});

test("VISIBILITY satırı yoksa eski 4 satırlık biçim çalışmaya devam eder", () => {
  // Geriye uyum: model eski biçimde cevap verirse kapı ölmemeli.
  const r = parseLimbCropReply(
    "OPACITY: SEE_THROUGH\nSTRUCTURE: NORMAL\nDEFINITION: NORMAL\nBAD_LIMB: see-through"
  );
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.equal(r.bad, true);
});
