const { test } = require("node:test");
const assert = require("node:assert/strict");
const { jobClock, jobTimeLeftMs, JOB_TIME_LIMIT_MS, JOB_FINALIZE_RESERVE_MS } = require("../falPhotos")._testables;

// 2026-10-11 (iş d44b63e8): iş 900 sn sınırını aştı, 7/10 kare bitmişken düştü.
test("süre bütçesi chunk çalışmasının içinde görünür, dışında sınırsız", async () => {
  assert.equal(jobTimeLeftMs(), Infinity);
  const deadline = Date.now() + 60000;
  await jobClock.run({ deadline }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    const left = jobTimeLeftMs();
    assert.ok(left > 50000 && left <= 60000, `left=${left}`);
  });
  assert.equal(jobTimeLeftMs(), Infinity);
});

test("bütçe fonksiyon sınırından kayıt payı kadar kısa", () => {
  assert.equal(JOB_TIME_LIMIT_MS, 900 * 1000);
  assert.ok(JOB_FINALIZE_RESERVE_MS >= 30000);
});
