const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  jobClock, usageCostUsd, costLimitFor, createLedger, chunkContext,
  recordUsage, releaseMandatoryReserve, tryReserveOptional, MANDATORY_RESERVE_PER_CHUNK_USD,
  hardCapAllows, runOptional: runOpt, waitReserveOptional: waitRes, PREP_COST_USD,
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

test("costLimitFor: 10 kare 1.50 $ sert tavan (2026-11-19), tek kare tabanı", () => {
  assert.ok(Math.abs(costLimitFor(10) - 1.5) < 1e-9);
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

test("waitReserveOptional: yer yoksa bekler, başka adım bitince ayırır (dd788c00)", async () => {
  const { waitReserveOptional } = require("../jobContext");
  const L = createLedger(1, 0.3); // pay 0.13
  await jobClock.run(chunkContext(0, L), async () => {
    const other = tryReserveOptional(0.12); // 0.25 dolu
    assert.ok(other);
    setTimeout(() => other.release(), 30);
    const r = await waitReserveOptional(0.1, { maxWaitMs: 1000, stepMs: 10 });
    assert.ok(r.slot, "yer açılınca ayrılmalı");
    assert.ok(r.waitedMs >= 20);
    assert.equal(L.skipped, 0);
  });
});

test("waitReserveOptional: süre dolar ya da keepWaiting false ise null, bir kez sayılır", async () => {
  const { waitReserveOptional } = require("../jobContext");
  const L = createLedger(1, 0.2);
  await jobClock.run(chunkContext(0, L), async () => {
    const r = await waitReserveOptional(0.1, { maxWaitMs: 50, stepMs: 10 });
    assert.equal(r.slot, null);
    assert.equal(L.skipped, 1);
    const q = await waitReserveOptional(0.1, { maxWaitMs: 1000, stepMs: 10, keepWaiting: () => false });
    assert.equal(q.slot, null);
    assert.ok(q.waitedMs < 100);
    assert.equal(L.skipped, 2);
  });
});

// 2026-11-13 (e67abb0e c9): yön ikinci üretimi zorunlu payı tüketip kendi slotunu da
// serbest bırakıyordu → chunk'ın sonraki Vision çağrılarına pay kalmıyordu.
test("defter: runOptional içindeki maliyet chunk'ın zorunlu payından düşülmez", async () => {
  const { runOptional } = require("../jobContext");
  const L = createLedger(1, 1.0);
  const gen = { input_tokens: 6849, input_tokens_details: { text_tokens: 797, image_tokens: 6052 }, output_tokens: 1544 };
  await jobClock.run(chunkContext(0, L), async () => {
    const slot = tryReserveOptional(0.11);
    assert.ok(slot);
    await runOptional(async () => { recordUsage("gpt-image-2", gen); });
    slot.release();
    // Zorunlu pay (0.13) yerinde; harcanan yalnız ~0.099.
    assert.ok(Math.abs(L.reservedUsd - MANDATORY_RESERVE_PER_CHUNK_USD) < 1e-9);
    assert.ok(Math.abs(L.spentUsd - 0.0987 - PREP_COST_USD) < 0.001);
    // runOptional dışında yine paydan düşer.
    recordUsage("gpt-image-2", gen);
    assert.ok(Math.abs(L.reservedUsd - (MANDATORY_RESERVE_PER_CHUNK_USD - 0.0987)) < 0.001);
  });
  // Bağlam yoksa fn aynen çalışır.
  assert.equal(await runOptional(async () => 7), 7);
});

// 2026-11-19 (kullanıcı: "ne olursa olsun maliyet 1.5$ geçmemeli"). 248a0e72 profili:
// 10 kare ana üretim + iki Vision + yüz yaması yargısı, 4 karede yüz onarımı
// (~$0.20) ve 4 karede yön ikinci üretimi (~$0.10) isteniyor. Eskiden onarım
// zorunlu sayılıp iş $2.36 tuttu; artık isteğe bağlı adımlar sığdığı kadar.
test("defter: 248a0e72 profili — onarım + ikinci üretim istense de toplam 1.50 $ geçmez", async () => {
  const L = createLedger(10);
  const gen = { input_tokens: 6831, input_tokens_details: { text_tokens: 726, image_tokens: 6105 }, output_tokens: 1650 };
  const rep = { input_tokens: 3000, input_tokens_details: { text_tokens: 300, image_tokens: 2700 }, output_tokens: 6000 };
  const vis = { prompt_tokens: 3886, completion_tokens: 145 };
  const vis2 = { prompt_tokens: 1590, completion_tokens: 13 };
  const art = { prompt_tokens: 874, completion_tokens: 20 };
  let repairs = 0, resamples = 0, blocked = 0;
  await Promise.all(Array.from({ length: 10 }, (_, i) => jobClock.run(chunkContext(0, L), async () => {
    recordUsage("gpt-image-2", gen);
    recordUsage("gpt-4o", vis);
    recordUsage("gpt-4o", vis2);
    recordUsage("gpt-4o", art);
    if (i < 4) { // yön ikinci üretimi
      const s = tryReserveOptional(0.11);
      if (s) { await runOpt(async () => { if (hardCapAllows(0.11)) { recordUsage("gpt-image-2", gen); resamples++; } else blocked++; }); s.release(); }
    }
    if (i >= 4 && i < 8) { // yüz onarımı
      const { slot } = await waitRes(0.23, { maxWaitMs: 30, stepMs: 5 });
      if (slot) { await runOpt(async () => { if (hardCapAllows(0.22)) { recordUsage("gpt-image-2", rep); recordUsage("gpt-4o", art); repairs++; } else blocked++; }); slot.release(); }
    }
    releaseMandatoryReserve();
  })));
  assert.ok(L.spentUsd <= 1.5 + 1e-9, `harcanan ${L.spentUsd.toFixed(3)}`);
  assert.ok(Math.abs(L.reservedUsd) < 1e-9);
  assert.ok(repairs + resamples >= 1, "tavanın altında yer varsa en az bir ek adım yapılır");
});

test("hardCapAllows: yalnız gerçekleşen harcamaya bakar, tavanı aşacak çağrıyı durdurur", async () => {
  const L = createLedger(1, 0.3);
  await jobClock.run(chunkContext(0, L), async () => {
    L.spentUsd = 0.2;
    assert.equal(hardCapAllows(0.1), true, "tam tavana kadar izin");
    assert.equal(hardCapAllows(0.11), false);
    assert.equal(L.capBlocked, 1);
  });
  assert.equal(hardCapAllows(1000), true, "bağlam yoksa sınırsız");
});
