const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  validateApprovalSelection,
  resultPathForStaging,
  stagedPhotoUrls,
  rejectedPhotoUrls,
  gateByUrl,
  checkRejectedSelection,
  SOFT_GATES,
  isBlockedGate,
  checkApprovableStatus,
  jobAuditFields,
  OVERRIDE_REASON_MIN,
} = require("../opsPanel")._testables;
const { pendingCancelRefund } = require("../falPhotos")._testables;

// KAPI BAZLI ONAY GÜVENLİĞİ (2026-11-04): kimlik/yüz kapısından elenen kare
// gerekçesiz teslim edilemez; diğer kapılar serbest ama kayıt tutulur.
const rejJob = {
  rejectedFrames: [
    { gsUrl: "gs://b/dating_rejected/u/j/a.jpg", gate: "math-identity" },
    { gsUrl: "gs://b/dating_rejected/u/j/b.jpg", gate: "yaw-drift" },
    { gsUrl: "gs://b/dating_rejected/u/j/c.jpg" },
  ],
};

test("gateByUrl: reddedilen adres → kapı, kapı yoksa '?'", () => {
  const m = gateByUrl(rejJob);
  assert.equal(m.get("gs://b/dating_rejected/u/j/a.jpg"), "math-identity");
  assert.equal(m.get("gs://b/dating_rejected/u/j/c.jpg"), "?");
  assert.equal(m.get("gs://b/dating_staging/u/j/x.jpg"), undefined);
});

test("checkRejectedSelection: yalnız üretilen kareler → boş", () => {
  const r = checkRejectedSelection(["gs://b/dating_staging/u/j/x.jpg"], gateByUrl(rejJob), null);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.blocked, []);
});

test("checkRejectedSelection: yaw kapısından elenen kare gerekçesiz teslim edilebilir, kayda girer", () => {
  const r = checkRejectedSelection(["gs://b/dating_rejected/u/j/b.jpg"], gateByUrl(rejJob), null);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].gate, "yaw-drift");
  assert.equal(r.blocked.length, 0);
});

test("checkRejectedSelection: kimlik kapısından elenen kare gerekçesiz → failed-precondition + details.blocked", () => {
  assert.throws(
    () => checkRejectedSelection(["gs://b/dating_rejected/u/j/a.jpg"], gateByUrl(rejJob), null),
    (e) => e.code === "failed-precondition" && Array.isArray(e.details.blocked) && e.details.blocked[0].gate === "math-identity",
  );
});

test("checkRejectedSelection: kısa gerekçe yetmez, yeterli gerekçe geçer ve kaydedilir", () => {
  const sel = ["gs://b/dating_rejected/u/j/a.jpg"];
  assert.throws(() => checkRejectedSelection(sel, gateByUrl(rejJob), "kısa"));
  const reason = "x".repeat(OVERRIDE_REASON_MIN);
  const r = checkRejectedSelection(sel, gateByUrl(rejJob), `  ${reason}  `);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.reason, reason);
});

// Engellenmesi gereken kapılar — GERÇEK adlarıyla (math kapısı
// `math-${faceQuality reason}` biçiminde yazılır; eski liste "head-ratio"
// diye arıyordu ve hiç eşleşmiyordu).
const EXPECTED_BLOCKED = [
  "math-identity", "math-head-ratio", "math-head-grew", "vision-identity",
  "vision-proportion", "vision-attachment", "vision-no-evidence",
  "math-no-face+vision-inconclusive",
  // 2026-11-19: şablon şapkası düştü, kafa şapka hacmine uzadı (deformasyon).
  "hat-lost",
];

test("isBlockedGate: kimlik, kafa oranı ve deformasyon kapıları engelli; poz/bakış kapıları serbest", () => {
  for (const g of EXPECTED_BLOCKED) assert.ok(isBlockedGate(g), g);
  for (const g of ["yaw-drift", "gaze-opposite", "face-artifact", "head-dx", "skin-tone", "math-blurry"]) {
    assert.ok(!isBlockedGate(g), g);
  }
});

test("isBlockedGate: tanınmayan kapı varsayılan engelli", () => {
  for (const g of ["?", "math-?", "vision-?", "head-ratio", "yepyeni-kapi"]) assert.ok(isBlockedGate(g), g);
});

test("kapı adları falPhotos ile senkron: her etiket bilerek sınıflandırılmış, serbest liste yazım hatası içermiyor", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  const start = src.indexOf("const REJECTION_REASON_LABELS = {");
  assert.ok(start > 0, "REJECTION_REASON_LABELS bulunamadı");
  const block = src.slice(start, src.indexOf("};", start));
  const labelKeys = [...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
  assert.ok(labelKeys.length > 20, `etiket sayısı beklenenden az: ${labelKeys.length}`);
  // Serbest listedeki her ad gerçekten var olan bir kapı olmalı.
  for (const g of SOFT_GATES) assert.ok(labelKeys.includes(g), `SOFT_GATES'te bilinmeyen ad: ${g}`);
  // Yeni eklenen her kapı ya serbest listeye ya da beklenen engelli listeye
  // bilerek eklenmeli.
  for (const g of labelKeys) {
    assert.ok(SOFT_GATES.has(g) || EXPECTED_BLOCKED.includes(g), `sınıflandırılmamış kapı: ${g}`);
  }
});

// ONAYDA İŞ DURUMU (2026-11-04): iade almış iş gerekçesiz teslim edilemez.
test("checkApprovableStatus: pendingApproval ve done serbest", () => {
  assert.deepEqual(checkApprovableStatus({ status: "pendingApproval" }, null), { statusOverride: false });
  assert.deepEqual(checkApprovableStatus({ status: "done" }, null), { statusOverride: false });
});

test("checkApprovableStatus: failed iş gerekçesiz → needsReason, gerekçeyle → statusOverride", () => {
  const job = { status: "failed", cancelledReason: "pending-approval-timeout", refundedUnits: 5 };
  assert.throws(
    () => checkApprovableStatus(job, "kısa"),
    (e) => e.code === "failed-precondition" && e.details.needsReason === true && /onay süresi/.test(e.message),
  );
  assert.deepEqual(checkApprovableStatus(job, "x".repeat(OVERRIDE_REASON_MIN)), { statusOverride: true });
});

test("checkApprovableStatus: generating/ready/expired gerekçeyle bile reddedilir", () => {
  for (const status of ["generating", "ready", "expired", undefined]) {
    assert.throws(
      () => checkApprovableStatus({ status }, "x".repeat(OVERRIDE_REASON_MIN)),
      (e) => e.code === "failed-precondition" && e.details.needsReason !== true,
      String(status),
    );
  }
});

// ONAY İPTALİ İADESİ (2026-11-04): kısmi iade yapılmış işte yalnız kalan iade edilir.
test("pendingCancelRefund: hiç iade yoksa tam iade + paket geri", () => {
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 5, packConsumed: 5 }), { units: 5, totalRefunded: 5, returnPack: true });
});

test("pendingCancelRefund: kısmi iade yapılmışsa yalnız kalan, paket geri verilmez (c2e8eff1: 5 düşüldü, 4 iade)", () => {
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 5, refundedUnits: 4, packConsumed: 5 }), { units: 1, totalRefunded: 5, returnPack: false });
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 5, refundedUnits: 1, packConsumed: 5 }), { units: 4, totalRefunded: 5, returnPack: false });
});

test("pendingCancelRefund: ücretsiz/bozuk alanlar güvenli", () => {
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 0 }), { units: 0, totalRefunded: 0, returnPack: false });
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 5, refundedUnits: 9 }), { units: 0, totalRefunded: 5, returnPack: false });
  assert.deepEqual(pendingCancelRefund({ packUnitsCharged: 10, packConsumed: null }), { units: 10, totalRefunded: 10, returnPack: false });
});

// PANEL DENETİM ALANLARI (2026-11-04).
test("jobAuditFields: onay bekleyen işte otomatik iptal tarihi pendingApprovalAt + 30 gün", () => {
  const at = { toMillis: () => 1_000_000 };
  const f = jobAuditFields({ status: "pendingApproval", pendingApprovalAt: at, pendingApprovalOverdue: true, costUsd: 1.25, chunkFinalFallback: { 0: "box-shift", 3: "face-lost" } });
  assert.equal(f.pendingApprovalAt, 1_000_000);
  assert.equal(f.autoCancelAt, 1_000_000 + 30 * 24 * 60 * 60 * 1000);
  assert.equal(f.pendingApprovalOverdue, true);
  assert.equal(f.costUsd, 1.25);
  assert.equal(f.finalFallbackCount, 2);
});

test("jobAuditFields: teslim edilmiş işte iptal tarihi ve gecikme yok", () => {
  const f = jobAuditFields({ status: "done", pendingApprovalAt: { toMillis: () => 5 }, pendingApprovalOverdue: true, approvalOverrides: [{}, {}], statusOverride: { from: "failed" } });
  assert.equal(f.autoCancelAt, null);
  assert.equal(f.pendingApprovalOverdue, false);
  assert.equal(f.costUsd, null);
  assert.equal(f.approvalOverrideCount, 2);
  assert.equal(f.statusOverride, true);
});

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
