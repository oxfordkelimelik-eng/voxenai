const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isAuthorizedOpsEmail,
  uidFromDocPath,
  gsPathFromUrl,
  extractGateCounts,
  aggregateGateCounts,
  buildPurchaseSummary,
  buildJobSummary,
  safeString,
  buildDailyBreakdown,
} = require("../opsPanel")._testables;

test("isAuthorizedOpsEmail: doğru email + doğrulanmış -> true", () => {
  assert.equal(isAuthorizedOpsEmail("destek@voxenai.com.tr", true), true);
});

test("isAuthorizedOpsEmail: case/boşluk normalize edilir", () => {
  assert.equal(isAuthorizedOpsEmail("  Destek@VoxenAI.Com.Tr  ", true), true);
});

test("isAuthorizedOpsEmail: yanlış email -> false", () => {
  assert.equal(isAuthorizedOpsEmail("baska@gmail.com", true), false);
});

test("isAuthorizedOpsEmail: boş/eksik email -> false", () => {
  assert.equal(isAuthorizedOpsEmail(null, true), false);
  assert.equal(isAuthorizedOpsEmail("", true), false);
});

test("isAuthorizedOpsEmail: email_verified açıkça false -> false", () => {
  assert.equal(isAuthorizedOpsEmail("destek@voxenai.com.tr", false), false);
});

test("isAuthorizedOpsEmail: email_verified undefined -> true kalır (mevcut davranış)", () => {
  assert.equal(isAuthorizedOpsEmail("destek@voxenai.com.tr", undefined), true);
});

// --- uidFromDocPath ---
// Gerçek Firestore DocumentReference gerektirmez — fonksiyon sadece
// .parent/.id property'lerine bakar, düz JS objeleriyle taklit edilebilir.
function mockDoc(id, parent) {
  return { id, parent };
}

test("uidFromDocPath: private/wallet (doküman, 4 segment)", () => {
  const usersCol = mockDoc("users", null);
  const uidDoc = mockDoc("UID123", usersCol);
  const privateCol = mockDoc("private", uidDoc);
  const walletDoc = mockDoc("wallet", privateCol);
  assert.equal(uidFromDocPath(walletDoc), "UID123");
});

test("uidFromDocPath: private/genData/genJobs/{jobId} (6 segment)", () => {
  const usersCol = mockDoc("users", null);
  const uidDoc = mockDoc("UID123", usersCol);
  const privateCol = mockDoc("private", uidDoc);
  const genDataDoc = mockDoc("genData", privateCol);
  const genJobsCol = mockDoc("genJobs", genDataDoc);
  const jobDoc = mockDoc("JOB456", genJobsCol);
  assert.equal(uidFromDocPath(jobDoc), "UID123");
});

test("uidFromDocPath: private/payments/processedPurchases/{orderId} (7 segment)", () => {
  const usersCol = mockDoc("users", null);
  const uidDoc = mockDoc("UID123", usersCol);
  const privateCol = mockDoc("private", uidDoc);
  const paymentsDoc = mockDoc("payments", privateCol);
  const purchasesCol = mockDoc("processedPurchases", paymentsDoc);
  const orderDoc = mockDoc("ORDER789", purchasesCol);
  assert.equal(uidFromDocPath(orderDoc), "UID123");
});

test("uidFromDocPath: 'users' bulunamayan bozuk zincirde null döner", () => {
  const orphanCol = mockDoc("someCollection", null);
  const orphanDoc = mockDoc("someDoc", orphanCol);
  assert.equal(uidFromDocPath(orphanDoc), null);
});

// --- gsPathFromUrl ---
test("gsPathFromUrl: gs:// URL'den bucket'sız path çıkarır", () => {
  assert.equal(
    gsPathFromUrl("gs://rise-up-9235f.firebasestorage.app/dating_results/uid/job/elegance_0_0.jpg"),
    "dating_results/uid/job/elegance_0_0.jpg"
  );
});

test("gsPathFromUrl: https:// URL için null döner (çağıran orijinali kullanır)", () => {
  assert.equal(gsPathFromUrl("https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media"), null);
});

test("gsPathFromUrl: null/undefined için null döner", () => {
  assert.equal(gsPathFromUrl(null), null);
  assert.equal(gsPathFromUrl(undefined), null);
});

// --- extractGateCounts / aggregateGateCounts ---
test("extractGateCounts: gate'e göre sayar, eksik gate '?' olur", () => {
  const frames = [{ gate: "vision-gaze" }, { gate: "vision-gaze" }, { gate: "limb-ghost" }, {}];
  assert.deepEqual(extractGateCounts(frames), { "vision-gaze": 2, "limb-ghost": 1, "?": 1 });
});

test("extractGateCounts: boş/undefined dizi için boş obje", () => {
  assert.deepEqual(extractGateCounts([]), {});
  assert.deepEqual(extractGateCounts(undefined), {});
});

test("aggregateGateCounts: birden fazla işin gateCounts'unu toplar", () => {
  const jobs = [
    { gateCounts: { "vision-gaze": 3, "limb-ghost": 1 } },
    { gateCounts: { "vision-gaze": 2, "skin-tone": 1 } },
    { gateCounts: {} },
  ];
  assert.deepEqual(aggregateGateCounts(jobs), { "vision-gaze": 5, "limb-ghost": 1, "skin-tone": 1 });
});

test("aggregateGateCounts: boş iş listesi için boş obje", () => {
  assert.deepEqual(aggregateGateCounts([]), {});
});

// --- buildPurchaseSummary ---
test("buildPurchaseSummary: toplam, tekil alıcı, ürün dağılımı, ciro (TL)", () => {
  const purchases = [
    { uid: "A", productId: "dating_pack_photo10" },
    { uid: "B", productId: "dating_pack_photo10" },
    { uid: "A", productId: "dating_pack_analysis5" },
  ];
  const s = buildPurchaseSummary(purchases);
  assert.equal(s.totalPurchases, 3);
  assert.equal(s.uniqueBuyers, 2);
  assert.deepEqual(s.productCounts, { dating_pack_photo10: 2, dating_pack_analysis5: 1 });
  assert.equal(s.totalRevenueTry, 349 + 349 + 249);
});

test("buildPurchaseSummary: bilinmeyen productId ciroya 0 katkı yapar", () => {
  const s = buildPurchaseSummary([{ uid: "A", productId: "unknown_product" }]);
  assert.equal(s.totalRevenueTry, 0);
});

// --- safeString ---
test("safeString: string olduğu gibi döner", () => {
  assert.equal(safeString("BAD_QUALITY"), "BAD_QUALITY");
});

test("safeString: null/undefined -> null", () => {
  assert.equal(safeString(null), null);
  assert.equal(safeString(undefined), null);
});

test("safeString: obje -> JSON string (Flutter cast hatasını önler)", () => {
  assert.equal(safeString({ code: "X", msg: "y" }), '{"code":"X","msg":"y"}');
});

test("safeString: sayı -> string", () => {
  assert.equal(safeString(42), "42");
});

// --- buildDailyBreakdown ---
test("buildDailyBreakdown: TR gününe göre gruplar, ciro ve adet toplar", () => {
  // 2026-09-10 12:00 Europe/Istanbul (UTC+3) = 2026-09-10T09:00:00Z
  const day1a = new Date("2026-09-10T09:00:00Z").getTime();
  const day1b = new Date("2026-09-10T20:00:00Z").getTime();
  const day2 = new Date("2026-09-09T09:00:00Z").getTime();
  const purchases = [
    { productId: "dating_pack_photo10", createdAt: day1a, email: "a@x.com" },
    { productId: "dating_pack_analysis1", createdAt: day1b, email: "b@x.com" },
    { productId: "dating_pack_photo50", createdAt: day2, email: "c@x.com" },
  ];
  const breakdown = buildDailyBreakdown(purchases);
  assert.equal(breakdown.length, 2);
  // En yeni gün önce.
  assert.equal(breakdown[0].day, "2026-09-10");
  assert.equal(breakdown[0].count, 2);
  assert.equal(breakdown[0].revenueTry, 349 + 99);
  assert.deepEqual(breakdown[0].productCounts, {
    dating_pack_photo10: 1, dating_pack_analysis1: 1,
  });
  // items en yeniden en eskiye sıralı, email taşınmış.
  assert.equal(breakdown[0].items.length, 2);
  assert.equal(breakdown[0].items[0].email, "b@x.com");
  assert.equal(breakdown[0].items[1].email, "a@x.com");
  assert.equal(breakdown[1].day, "2026-09-09");
  assert.equal(breakdown[1].count, 1);
  assert.equal(breakdown[1].revenueTry, 999);
  assert.equal(breakdown[1].items[0].email, "c@x.com");
});

test("buildDailyBreakdown: boş liste için boş dizi", () => {
  assert.deepEqual(buildDailyBreakdown([]), []);
});

// --- buildJobSummary ---
test("buildJobSummary: durum/kapı/iş türü kırılımı doğru hesaplanır", () => {
  const jobs = [
    { uid: "A", status: "done", usedFreeTier: true, packUnitsCharged: 0, deliveredCount: 1, rejectedCount: 1, gateCounts: { "vision-gaze": 1 } },
    { uid: "B", status: "done", usedFreeTier: false, packUnitsCharged: 1, deliveredCount: 10, rejectedCount: 3, gateCounts: { "limb-ghost": 2, "vision-gaze": 1 } },
    { uid: "C", status: "failed", usedFreeTier: false, packUnitsCharged: 0, deliveredCount: 0, rejectedCount: 0, gateCounts: {} },
  ];
  const s = buildJobSummary(jobs);
  assert.equal(s.totalJobs, 3);
  assert.equal(s.uniqueProducers, 3);
  assert.deepEqual(s.statusCounts, { done: 2, failed: 1 });
  assert.equal(s.totalDelivered, 11);
  assert.equal(s.totalRejected, 4);
  assert.deepEqual(s.gateCounts, { "vision-gaze": 2, "limb-ghost": 2 });
  assert.equal(s.freeTierJobs, 1);
  assert.equal(s.paidJobs, 1);
  assert.equal(s.failedJobs, 1);
});

test("buildJobSummary: boş iş listesi için sıfırlanmış özet", () => {
  const s = buildJobSummary([]);
  assert.equal(s.totalJobs, 0);
  assert.equal(s.uniqueProducers, 0);
  assert.deepEqual(s.statusCounts, {});
  assert.equal(s.totalDelivered, 0);
  assert.equal(s.totalRejected, 0);
  assert.deepEqual(s.gateCounts, {});
  assert.equal(s.freeTierJobs, 0);
  assert.equal(s.paidJobs, 0);
  assert.equal(s.failedJobs, 0);
});
