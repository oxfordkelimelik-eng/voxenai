const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  jobClock, usageCostUsd, costLimitFor, createLedger, chunkContext,
  recordUsage, releaseMandatoryReserve, tryReserveOptional, MANDATORY_RESERVE_PER_CHUNK_USD,
} = require("../jobContext");

test("usageCostUsd: gpt-image-2 ana üretim ve low dolgu ölçülen değerlerle", () => {
  // fa9303f0'daki gerçek ana üretim usage'ı
  const gen = { input_tokens: 6849, input_tokens_details: { text_tokens: 797, image_tokens: 6052 }, output_tokens: 1544 };
  assert.ok(Math.abs(usageCostUsd("gpt-image-2", gen) - 0.0987) < 0.0005);
  const lowFill = { input_tokens: 1222, input_tokens_details: { text_tokens: 198, image_tokens: 1024 }, output_tokens: 196 };
  assert.ok(Math.abs(usageCostUsd("gpt-image-2", lowFill) - 0.0151) < 0.0005);
  // chat
  assert.ok(Math.abs(usageCostUsd("gpt-4o", { prompt_tokens: 1000, completion_tokens: 100 }) - 0.0035) < 1e-9);
  assert.ok(Math.abs(usageCostUsd("bilinmeyen", { prompt_tokens: 1000, completion_tokens: 100 }) - 0.0035) < 1e-9);
});

test("costLimitFor: 10 kare 1.50 $, tek kare tabanı", () => {
  assert.equal(costLimitFor(10), 1.5);
  assert.equal(costLimitFor(1), 0.2);
});

test("defter: zorunlu adımlar paydan düşer, isteğe bağlı adım sınırı aşamaz", async () => {
  const L = createLedger(2, 0.4); // 2 chunk, pay 0.26
  const gen = { input_tokens: 6849, input_tokens_details: { text_tokens: 797, image_tokens: 6052 }, output_tokens: 1544 };
  await jobClock.run(chunkContext(0, L), async () => {
    recordUsage("gpt-image-2", gen); // ~0.099, paydan
    assert.ok(Math.abs(L.reservedUsd - (2 * MANDATORY_RESERVE_PER_CHUNK_USD - 0.0987)) < 0.001);
    releaseMandatoryReserve(); // kalan pay serbest
    assert.ok(Math.abs(L.reservedUsd - MANDATORY_RESERVE_PER_CHUNK_USD) < 1e-9);
    // 0.4 - (0.099 harcanan + 0.13 diğer chunk payı) = ~0.171 yer
    const a = tryReserveOptional(0.1);
    assert.ok(a);
    const b = tryReserveOptional(0.1); // 0.099+0.13+0.1+0.1 > 0.4
    assert.equal(b, null);
    assert.equal(L.skipped, 1);
    a.release();
    a.release(); // iki kez bırakmak payı bozmaz
    assert.ok(Math.abs(L.reservedUsd - MANDATORY_RESERVE_PER_CHUNK_USD) < 1e-9);
  });
});

test("defter: bağlam yoksa sınırsız (test/başka fonksiyon)", () => {
  const slot = tryReserveOptional(100);
  assert.ok(slot);
  slot.release();
  assert.ok(recordUsage("gpt-4o", { prompt_tokens: 10, completion_tokens: 1 }) > 0);
});

test("defter: 10 karelik tipik iş 1.50 $ altında kalır, en kötü durumda isteğe bağlı adımlar kesilir", async () => {
  const L = createLedger(10);
  const gen = { input_tokens: 6900, input_tokens_details: { text_tokens: 800, image_tokens: 6100 }, output_tokens: 1630 };
  const vis = { prompt_tokens: 3900, completion_tokens: 150 };
  const vis2 = { prompt_tokens: 2400, completion_tokens: 15 };
  const fill = { input_tokens: 1222, input_tokens_details: { text_tokens: 198, image_tokens: 1024 }, output_tokens: 196 };
  const ew = { input_tokens: 1791, input_tokens_details: { text_tokens: 223, image_tokens: 1568 }, output_tokens: 196 };
  await Promise.all(Array.from({ length: 10 }, () => jobClock.run(chunkContext(0, L), async () => {
    recordUsage("gpt-image-2", gen);
    recordUsage("gpt-4o", vis);
    recordUsage("gpt-4o", vis2);
    recordUsage("gpt-4.1", { prompt_tokens: 1204, completion_tokens: 35 });
    releaseMandatoryReserve();
    for (const [est, u] of [[0.018, fill], [0.022, ew]]) {
      const s = tryReserveOptional(est);
      if (!s) continue;
      recordUsage("gpt-image-2", u);
      s.release();
    }
  })));
  assert.ok(L.spentUsd <= L.limitUsd + 1e-9, `harcanan ${L.spentUsd}`);
  assert.ok(Math.abs(L.reservedUsd) < 1e-9);
});
