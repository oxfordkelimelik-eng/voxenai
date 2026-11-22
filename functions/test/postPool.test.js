const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Worker'lar sahte görev modülünü yükler; havuz tek worker'la çalışır.
process.env.POST_WORKER_TASKS = path.join(__dirname, "fixtures", "poolTasks.js");
process.env.POST_WORKERS = "1";
const pool = require("../postPool");
after(() => pool._shutdownForTests());

test("havuz: asılı görev süre sınırında düşer, worker yenilenir, sonraki görev çalışır (156fa173 c0)", async () => {
  assert.ok(pool.enabled());
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try {
    const t0 = Date.now();
    await assert.rejects(pool.run("spin", {}, { timeoutMs: 1500 }), /süre sınırı: spin/);
    assert.ok(Date.now() - t0 < 5000, "süre sınırında döndü");
    // Satır satır log: asılı görevin son satırı görev bitmeden yazıldı.
    assert.ok(lines.some((l) => l.includes("spin başladı")), "asılı görevin logu göründü");
    const r = await pool.run("echo", { v: 7 }, { timeoutMs: 20000 });
    assert.equal(r.v, 7, "yeni worker görevi aldı");
  } finally {
    console.log = orig;
  }
});

test("havuz: kuyrukta süresi dolan görev başlamadan düşer, süre kalmadıysa hiç başlamaz", async () => {
  const busy = pool.run("sleep", { ms: 1500, v: 1 });
  await assert.rejects(pool.run("simpleFinish", { ms: 10, v: 2 }, { timeoutMs: 300 }), /kuyrukta .* başlamadan/);
  await assert.rejects(pool.run("echo", { v: 3 }, { timeoutMs: 0 }), /süre kalmadı/);
  assert.equal((await busy).v, 1);
});

test("havuz: ağır olmayan görev ağır bitirme görevlerinin önüne girer", async () => {
  const order = [];
  const busy = pool.run("sleep", { ms: 400, v: "meşgul" }).then((r) => order.push(r.v));
  const h1 = pool.run("simpleFinish", { ms: 10, v: "ağır1" }).then((r) => order.push(r.v));
  const h2 = pool.run("simpleFinish", { ms: 10, v: "ağır2" }).then((r) => order.push(r.v));
  const l1 = pool.run("sleep", { ms: 10, v: "hafif1" }).then((r) => order.push(r.v));
  const l2 = pool.run("sleep", { ms: 10, v: "hafif2" }).then((r) => order.push(r.v));
  await Promise.all([busy, h1, h2, l1, l2]);
  assert.deepEqual(order, ["meşgul", "hafif1", "hafif2", "ağır1", "ağır2"]);
});
