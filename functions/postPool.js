// AĞIR SON KATMAN WORKER HAVUZU (2026-10-11). Kareler son katmanlara paralel
// girer; havuz boyu vCPU sayısının bir eksiği (ana iş parçacığı ağ, kalite
// kapıları ve kodlama için kalır), en çok POST_WORKERS_MAX. Her worker
// tfjs-wasm modellerini kendisi yükler (~0.5 GB) — startPhotoGeneration
// belleği bu yüzden 8GiB. Worker çökerse görevi hata döner, yerine yenisi
// açılır; çağıran katmanı atlar (fail-safe, eski kilit davranışıyla aynı).
//
// SÜRE SINIRI + ÖNCELİK (2026-11-18, iş 156fa173 c0 %97'de asılı kaldı):
// - Görevin zaman aşımı yoktu. c0'ın bitirme görevi kuyrukta bekledi, ağır
//   katmanlı kafa bükmesi sürerken istek 900 sn'de kapandı; Cloud Run CPU'yu
//   istek dışında kısıyor (cpuIdle) → görev fiilen dondu, iş hiç kapanmadı.
//   run(..., { timeoutMs }) süre dolunca kuyruktaki görevi düşürür, çalışan
//   görevin worker'ını sonlandırıp yenisini açar; çağıran katmanı atlar.
// - Kuyruk tek sıraydı: c0'ın küçük kapı görevi (eyeGlassShare) dakikalarca
//   ağır bitirme görevlerinin arkasında bekledi. Ağır olmayan görevler artık
//   kuyruğun önüne girer (HEAVY_TASKS dışındakiler).
// - Worker logları satır satır gelir (bkz. postWorker.js): görev asılırsa
//   hangi adımda kaldığı logda görünür.
const path = require("path");
const os = require("os");

// 3 → 7 (2026-11-18, 156fa173): son adımlar 13:49-13:57 arası CPU %99-100'de
// sıraya girdi (bellek 16 GiB'in en çok %64'ü). startPhotoGeneration 8 vCPU /
// 32 GiB'e çıktı; worker sayısı vCPU-1.
// 7 → 4 (2026-11-18 20:27, iş 7138d1a7): 7 worker son adımlara aynı anda girince
// bellek bir dakikada %22'den 32 GiB'i aştı ("Memory limit of 32768 MiB exceeded"),
// iş düştü. 3 worker 16 GiB'te tepe %64 (~10 GiB) idi; 4 worker × 2 ORT iş
// parçacığı 8 vCPU'yu doldurur, bellek payı geniş. Artırmadan önce tepe belleği ölç.
const POST_WORKERS_MAX = 4;
const HEAVY_TASKS = new Set(["simpleFinish", "layers", "headScale", "surroundPrep", "fringePrep", "curlRemnantPrep", "selfieDetail"]);

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

function writeLogs(logs) {
  for (const [level, line] of logs || []) (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

function settle(t, fn, v) {
  if (t.done) return;
  t.done = true;
  if (t.timer) clearTimeout(t.timer);
  fn(v);
}

// Worker'ı havuzdan çıkarır, yerine yenisini açar.
function replace(w) {
  const i = workers.indexOf(w);
  if (i >= 0) workers.splice(i, 1);
  const j = idle.indexOf(w);
  if (j >= 0) idle.splice(j, 1);
  try {
    workers.push(spawn());
  } catch (err) {
    console.error("Yeni worker açılamadı:", err.message || err);
  }
}

function spawn() {
  const { Worker } = require("worker_threads");
  const w = new Worker(path.join(__dirname, "postWorker.js"));
  w.unref();
  w.current = null;
  w.on("message", ({ id, ok, result, error, logs, partial }) => {
    // Worker'ın logları burada yazılır (bkz. postWorker.js).
    writeLogs(logs);
    if (partial) return;
    const t = w.current;
    if (!t || t.id !== id) return; // sonlandırılmış görevin geç cevabı
    w.current = null;
    if (ok) settle(t, t.resolve, revive(result));
    else settle(t, t.reject, new Error(error));
    idle.push(w);
    pump();
  });
  const fail = (e) => {
    if (w.killed) return; // süre sınırıyla bilerek sonlandırıldı (yerine yenisi açıldı)
    const t = w.current;
    w.current = null;
    if (t) settle(t, t.reject, e instanceof Error ? e : new Error(`worker çıktı: ${e}`));
    console.error("Son katman worker'ı düştü, yenisi açılıyor:", e && e.message ? e.message : e);
    replace(w);
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
    t.worker = w;
    t.startedAt = Date.now();
    w.postMessage({ id: t.id, name: t.name, payload: t.payload });
  }
}

function onTimeout(t) {
  if (t.done) return;
  const waited = Math.round((Date.now() - t.queuedAt) / 1000);
  const qi = queue.indexOf(t);
  if (qi >= 0) {
    queue.splice(qi, 1);
    settle(t, t.reject, new Error(`süre sınırı: ${t.name} kuyrukta ${waited} sn bekledi, başlamadan düşürüldü`));
    return;
  }
  const w = t.worker;
  const ran = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : null;
  settle(t, t.reject, new Error(`süre sınırı: ${t.name} ${ran} sn çalıştı (kuyruk dahil ${waited} sn), worker sonlandırıldı`));
  if (w && w.current === t) {
    w.current = null;
    w.killed = true;
    replace(w);
    w.terminate().catch(() => {});
    pump();
  }
}

/**
 * name: postTasks görevi. timeoutMs: kuyrukta bekleme DAHİL en uzun süre
 * (null = sınırsız). Ağır olmayan görevler kuyruğun önüne girer.
 */
function run(name, payload, { timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs <= 0) {
      reject(new Error(`süre sınırı: ${name} için süre kalmadı, başlatılmadı`));
      return;
    }
    const t = { id: nextId++, name, payload, resolve, reject, queuedAt: Date.now(), done: false };
    if (timeoutMs != null && Number.isFinite(timeoutMs)) {
      t.timer = setTimeout(() => onTimeout(t), timeoutMs);
      if (typeof t.timer.unref === "function") t.timer.unref();
    }
    if (HEAVY_TASKS.has(name)) queue.push(t);
    else {
      // Ağır olmayanlar, önceki ağır olmayanların arkasına (aralarında FIFO).
      let i = 0;
      while (i < queue.length && !HEAVY_TASKS.has(queue[i].name)) i++;
      queue.splice(i, 0, t);
    }
    pump();
  });
}

// Yalnız testler: worker'ları kapatır (test süreci açık MessagePort ile kalmasın).
async function _shutdownForTests() {
  const ws = workers || [];
  workers = [];
  idle.length = 0;
  for (const w of ws) w.killed = true;
  await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
  workers = null;
}

module.exports = { enabled, run, poolSize, POST_WORKERS_MAX, HEAVY_TASKS, _shutdownForTests };
