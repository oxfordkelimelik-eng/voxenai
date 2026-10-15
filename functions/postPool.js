// AĞIR SON KATMAN WORKER HAVUZU (2026-10-11). Kareler son katmanlara paralel
// girer; havuz boyu vCPU sayısının bir eksiği (ana iş parçacığı ağ, kalite
// kapıları ve kodlama için kalır), en çok POST_WORKERS_MAX. Her worker
// tfjs-wasm modellerini kendisi yükler (~0.5 GB) — startPhotoGeneration
// belleği bu yüzden 8GiB. Worker çökerse görevi hata döner, yerine yenisi
// açılır; çağıran katmanı atlar (fail-safe, eski kilit davranışıyla aynı).
const path = require("path");
const os = require("os");

const POST_WORKERS_MAX = 3;

let workers = null;
const idle = [];
const queue = [];
let nextId = 1;

function poolSize() {
  const env = process.env.POST_WORKERS;
  if (env != null && env !== "") return Math.max(0, Math.min(POST_WORKERS_MAX, Number(env) || 0));
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(0, Math.min(POST_WORKERS_MAX, cpus - 1));
}

const toBuf = (v) => (v == null || Buffer.isBuffer(v) || !(v instanceof Uint8Array) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));

// Yapılandırılmış kopya Buffer'ı Uint8Array'e çevirir; görüntü alanları geri sarılır.
function revive(r) {
  if (!r || typeof r !== "object") return r;
  for (const k of ["buf", "image", "mask", "base"]) if (r[k]) r[k] = toBuf(r[k]);
  if (r.inpaint) revive(r.inpaint);
  return r;
}

function spawn() {
  const { Worker } = require("worker_threads");
  const w = new Worker(path.join(__dirname, "postWorker.js"));
  w.unref();
  w.current = null;
  w.on("message", ({ id, ok, result, error, logs }) => {
    // Worker'ın logları burada yazılır (bkz. postWorker.js).
    for (const [level, line] of logs || []) (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    const t = w.current;
    w.current = null;
    if (t && t.id === id) {
      if (ok) t.resolve(revive(result));
      else t.reject(new Error(error));
    }
    idle.push(w);
    pump();
  });
  const fail = (e) => {
    const t = w.current;
    w.current = null;
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
    const j = idle.indexOf(w);
    if (j >= 0) idle.splice(j, 1);
    if (t) t.reject(e instanceof Error ? e : new Error(`worker çıktı: ${e}`));
    console.error("Son katman worker'ı düştü, yenisi açılıyor:", e && e.message ? e.message : e);
    try {
      workers.push(spawn());
    } catch (err) {
      console.error("Yeni worker açılamadı:", err.message || err);
    }
    pump();
  };
  w.on("error", fail);
  w.on("exit", (code) => { if (workers.includes(w)) fail(code); });
  idle.push(w);
  return w;
}

function enabled() {
  if (workers === null) {
    workers = [];
    const n = poolSize();
    try {
      for (let i = 0; i < n; i++) workers.push(spawn());
    } catch (e) {
      console.error("Son katman worker havuzu açılamadı (kilitli sıraya dönülüyor):", e.message || e);
    }
  }
  return workers.length > 0;
}

function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop();
    const t = queue.shift();
    w.current = t;
    w.postMessage({ id: t.id, name: t.name, payload: t.payload });
  }
}

function run(name, payload) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, name, payload, resolve, reject });
    pump();
  });
}

module.exports = { enabled, run, poolSize, POST_WORKERS_MAX };
