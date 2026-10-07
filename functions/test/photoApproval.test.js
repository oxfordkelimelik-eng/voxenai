const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateApprovalSelection,
  resultPathForStaging,
  stagedPhotoUrls,
  rejectedPhotoUrls,
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

// REDDEDİLEN KARELER DE ONAYLANABİLİR (2026-10-07). Örnek: 10 üretildi,
// 2 reddedildi -> 12 kareden photoCount kadarı seçilebilir.
const rejected = [
  `gs://b/dating_rejected/${UID}/${JOB}/photos_c6_att1__mode-p800__gate-vision-gaze.jpg`,
];

test("reddedilen kare, üretilenlerle birlikte seçilebilir", () => {
  const paths = validateApprovalSelection({
    selected: [staged[0], rejected[0]],
    staged: [...staged, ...rejected], uid: UID, jobId: JOB, maxCount: 5,
  });
  assert.deepEqual(paths, [
    `dating_staging/${UID}/${JOB}/elegance_0_0.jpg`,
    `dating_rejected/${UID}/${JOB}/photos_c6_att1__mode-p800__gate-vision-gaze.jpg`,
  ]);
});

test("BAŞKA kullanıcının reddedilen karesi onaylanamaz", () => {
  const foreign = `gs://b/dating_rejected/BASKA_UID/${JOB}/x.jpg`;
  assert.throws(
    () => validateApprovalSelection({
      selected: [foreign], staged: [...staged, foreign], uid: UID, jobId: JOB, maxCount: 5,
    }),
    /Geçersiz fotoğraf yolu/
  );
});

test("reddedilen kare teslim yoluna rejected_ ön ekiyle kopyalanır", () => {
  assert.equal(
    resultPathForStaging(`dating_rejected/${UID}/${JOB}/photos_c6_att1.jpg`),
    `dating_results/${UID}/${JOB}/rejected_photos_c6_att1.jpg`
  );
});

test("rejectedPhotoUrls elenen karelerin gs:// adreslerini toplar", () => {
  assert.deepEqual(
    rejectedPhotoUrls({ rejectedFrames: [{ gsUrl: rejected[0] }, { gsUrl: null }, {}] }),
    [rejected[0]]
  );
  assert.deepEqual(rejectedPhotoUrls({}), []);
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

const {
  generateCountFor,
  deliverPhotoPath,
} = require("../falPhotos")._testables;

test("sürüm kapısı: bayrak yoksa fazla üretim yok", () => {
  assert.equal(generateCountFor(5, false), 5);
  assert.equal(generateCountFor(10, false), 10);
  assert.equal(generateCountFor(25, false), 25);
  assert.equal(generateCountFor(5), 5); // varsayılan false
});

test("sürüm kapısı: bayrak varsa +5 fazla üretim", () => {
  assert.equal(generateCountFor(5, true), 10);
  assert.equal(generateCountFor(10, true), 15);
  assert.equal(generateCountFor(25, true), 30);
});

test("sürüm kapısı: bayrak yoksa dating_results, varsa staging", () => {
  assert.equal(
    deliverPhotoPath("u", "j", "photos", 0, 0, false),
    "dating_results/u/j/photos_0_0.jpg"
  );
  assert.equal(
    deliverPhotoPath("u", "j", "photos", 0, 0, true),
    "dating_staging/u/j/photos_0_0.jpg"
  );
});

// KULLANILAN ŞABLON (2026-10-07): panel her karenin yanında şablonunu gösterir.
test("şablon: onay havuzundaki kare chunkTemplates'ten (kesin) gelir", () => {
  const { templateNameForRef } = require("../opsPanel")._testables;
  const job = { templateNames: ["t/a.jpg", "t/b.jpg"], chunkTemplates: { 1: "t/yedek.jpg" } };
  assert.deepEqual(templateNameForRef("gs://x/dating_staging/u/j/photos_1_0.jpg", job), { name: "t/yedek.jpg", exact: true });
});

test("şablon: eski işte templateNames'e düşer ve tahmini işaretlenir", () => {
  const { templateNameForRef } = require("../opsPanel")._testables;
  const job = { templateNames: ["t/a.jpg", "t/b.jpg"] };
  assert.deepEqual(templateNameForRef("gs://x/dating_staging/u/j/photos_0_0.jpg", job), { name: "t/a.jpg", exact: false });
});

test("şablon: reddedilen kare ve onu teslim eden sonuç kendi deneme şablonunu kullanır", () => {
  const { templateNameForRef } = require("../opsPanel")._testables;
  const name = "photos_c2_att3__mode-p800__gate-gaze.jpg";
  const job = {
    templateNames: ["t/a.jpg", "t/b.jpg", "t/c.jpg"],
    chunkTemplates: { 2: "t/teslim.jpg" },
    rejectedFrames: [{ gsUrl: `gs://x/dating_rejected/u/j/${name}`, template: "t/deneme3.jpg" }],
  };
  const want = { name: "t/deneme3.jpg", exact: true };
  assert.deepEqual(templateNameForRef(`gs://x/dating_rejected/u/j/${name}`, job), want);
  assert.deepEqual(templateNameForRef(`gs://x/dating_results/u/j/rejected_${name}`, job), want);
});

test("şablon: manuel yüklemenin şablonu yoktur", () => {
  const { templateNameForRef } = require("../opsPanel")._testables;
  assert.equal(templateNameForRef("gs://x/dating_staging/u/j/manual_1.jpg", { templateNames: ["t/a.jpg"] }), null);
});
