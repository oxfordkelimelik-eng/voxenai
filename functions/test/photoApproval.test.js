const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateApprovalSelection,
  resultPathForStaging,
  stagedPhotoUrls,
} = require("../opsPanel")._testables;

// FOTO ONAYI (2026-09-22).
//
// Üretim artık kullanıcıya doğrudan teslim edilmiyor: kareler staging'e
// yazılıyor ve yalnızca ops panelinden onaylananlar kullanıcının klasörüne
// kopyalanıyor. Buradaki testler, kopyalama kararını veren SAF mantığı
// kilitliyor — asıl risk bu: seçim İSTEMCİDEN geliyor ve doğrulanmadan
// kopyalanırsa bucket'taki herhangi bir dosya kullanıcının klasörüne
// taşınabilirdi.

const UID = "user123";
const JOB = "job456";
const staged = [
  `gs://b/dating_staging/${UID}/${JOB}/elegance_0_0.jpg`,
  `gs://b/dating_staging/${UID}/${JOB}/elegance_1_0.jpg`,
  `gs://b/dating_staging/${UID}/${JOB}/elegance_2_0.jpg`,
];

test("geçerli seçim, staging yollarına çözülür", () => {
  const paths = validateApprovalSelection({
    selected: [staged[0], staged[2]],
    staged, uid: UID, jobId: JOB, maxCount: 5,
  });
  assert.deepEqual(paths, [
    `dating_staging/${UID}/${JOB}/elegance_0_0.jpg`,
    `dating_staging/${UID}/${JOB}/elegance_2_0.jpg`,
  ]);
});

test("vaat edilenden FAZLA seçim reddedilir", () => {
  assert.throws(
    () => validateApprovalSelection({
      selected: staged, staged, uid: UID, jobId: JOB, maxCount: 2,
    }),
    /En fazla 2/
  );
});

test("işe ait olmayan bir kare onaylanamaz", () => {
  assert.throws(
    () => validateApprovalSelection({
      selected: [`gs://b/dating_staging/${UID}/BASKA_IS/elegance_0_0.jpg`],
      staged, uid: UID, jobId: JOB, maxCount: 5,
    }),
    /Bu işe ait olmayan/
  );
});

test("BAŞKA kullanıcının karesi onaylanamaz (yol enjeksiyonu)", () => {
  const foreign = `gs://b/dating_staging/BASKA_UID/${JOB}/elegance_0_0.jpg`;
  assert.throws(
    () => validateApprovalSelection({
      selected: [foreign],
      staged: [...staged, foreign], // staged'de olsa BİLE uid eşleşmeli
      uid: UID, jobId: JOB, maxCount: 5,
    }),
    /Geçersiz fotoğraf yolu/
  );
});

test("staging DIŞINDAKİ bir yol onaylanamaz", () => {
  const outside = "gs://b/dating_training/user123/selfie.jpg";
  assert.throws(
    () => validateApprovalSelection({
      selected: [outside],
      staged: [...staged, outside],
      uid: UID, jobId: JOB, maxCount: 5,
    }),
    /Geçersiz fotoğraf yolu/
  );
});

test("aynı kare iki kez seçilemez (çift kopya/çift sayım olmasın)", () => {
  assert.throws(
    () => validateApprovalSelection({
      selected: [staged[0], staged[0]],
      staged, uid: UID, jobId: JOB, maxCount: 5,
    }),
    /iki kez/
  );
});

test("dizi olmayan seçim reddedilir", () => {
  assert.throws(
    () => validateApprovalSelection({
      selected: "hepsi", staged, uid: UID, jobId: JOB, maxCount: 5,
    }),
    /dizi olmalı/
  );
});

test("boş seçim serbest (hiçbirini onaylamamak geçerli bir karar)", () => {
  const paths = validateApprovalSelection({
    selected: [], staged, uid: UID, jobId: JOB, maxCount: 5,
  });
  assert.deepEqual(paths, []);
});

test("staging yolu yalnızca ÖN EKİ değişerek sonuç yoluna çevrilir", () => {
  assert.equal(
    resultPathForStaging(`dating_staging/${UID}/${JOB}/elegance_3_0.jpg`),
    `dating_results/${UID}/${JOB}/elegance_3_0.jpg`
  );
});

test("dosya adı korunur — aynı kare tekrar onaylanınca kopya çoğalmaz", () => {
  const a = resultPathForStaging(`dating_staging/${UID}/${JOB}/x_1_0.jpg`);
  const b = resultPathForStaging(`dating_staging/${UID}/${JOB}/x_1_0.jpg`);
  assert.equal(a, b);
});

test("stagedPhotoUrls tüm kovaların karelerini toplar", () => {
  const job = {
    results: {
      elegance: { photoUrls: ["gs://b/a.jpg", "gs://b/b.jpg"] },
      other: { photoUrls: ["gs://b/c.jpg"] },
    },
  };
  assert.deepEqual(stagedPhotoUrls(job), ["gs://b/a.jpg", "gs://b/b.jpg", "gs://b/c.jpg"]);
});

test("results yoksa boş liste döner, patlamaz", () => {
  assert.deepEqual(stagedPhotoUrls({}), []);
  assert.deepEqual(stagedPhotoUrls({ results: { x: {} } }), []);
});

// FAZLA ÜRETİM — üretim sayısı ile ücretlendirilen sayı ayrı olmalı.
test("fazla üretim tablosu: her pakette +5 kare", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "falPhotos.js"), "utf8");
  const m = /const PHOTO_PACK_OVERPRODUCTION = \{([^}]*)\}/.exec(src);
  assert.ok(m, "PHOTO_PACK_OVERPRODUCTION bulunamadı");
  const table = Object.fromEntries(
    [...m[1].matchAll(/(\d+):\s*(\d+)/g)].map((x) => [Number(x[1]), Number(x[2])])
  );
  assert.deepEqual(table, { 5: 10, 10: 15, 25: 30 });
  for (const [promised, generated] of Object.entries(table)) {
    assert.equal(generated - Number(promised), 5, `${promised} paketinde fark 5 olmalı`);
  }
});

test("üretim staging'e yazılır — dating_results'a doğrudan yazan kod kalmadı", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "falPhotos.js"), "utf8");
  // Şablon literali içinde dating_results/${uid} yazan bir yol kalmamalı;
  // teslim yoluna yalnızca onay akışı (opsPanel) kopyalar.
  assert.doesNotMatch(
    src,
    /`dating_results\/\$\{uid\}/,
    "falPhotos hâlâ doğrudan dating_results'a yazıyor — elenen kareler kullanıcıya görünür olurdu"
  );
});
