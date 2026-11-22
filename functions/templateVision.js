// ŞABLON VİZYON ÖNBELLEĞİ (2026-11-22, akış incelemesi — "şablon ölçümlerinde iyileştirme").
//
// Şablon başına iki ücretli Vision yargısı her işte, her karede yeniden soruluyordu:
//  - gözlük (headGhost.judgeEyewear, gpt-4.1) — üretim öncesi, bakış cümlesi bununla seçilir;
//  - ten pigmenti (skinPigment, gpt-4.1-mini) — yüz sahne ışığı, ten alanı, el onarımı bununla.
// Para küçük (iş başına ~1 sent) ama aynı şablon işten işe farklı karar alıyordu (MST ±1, bkz.
// skinPigment TEMPLATE_PADS). Artık karar şablon tuvalinin baytlarına (sha1) bağlanıp Firestore'da
// tutulur: ilk işte bir kez sorulur, sonra her işte aynı değer. Yalnız BAŞARILI yargı yazılır;
// hata/zaman aşımı önbelleğe girmez (sonraki kare yeniden sorar).
//
// Tuval baytları prepareTemplate'in çıktısı (kırpım, ölçek): kırpım kuralı değişirse anahtar da
// değişir, eski kayıt kendiliğinden kullanılmaz. İstem/kırpım değişirse VERSION artırılır.
// Firestore okuma/yazma hatası işi durdurmaz: önbelleksiz eski yol.
const crypto = require("crypto");

const COLLECTION = "templateVisionCache";
const VERSION = { eyewear: 1, mst: 1 };
const READ_TIMEOUT_MS = 5000;
const MEM = new Map();
const MEM_MAX = 500;

function keyOf(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function dbOf(db) {
  if (db) return db;
  try { return require("firebase-admin").firestore(); } catch (e) { return null; }
}

/**
 * field ('eyewear' | 'mst') için önbellekli yargı. compute() → sonuç nesnesi; good(r) true ise
 * yazılır. Döner { value, cache: 'bellek' | 'firestore' | 'yeni' | 'yok' }.
 */
async function cachedJudgement(buf, field, compute, good, { db = null } = {}) {
  if (!Buffer.isBuffer(buf) || !VERSION[field]) return { value: await compute(), cache: "yok" };
  const id = keyOf(buf);
  const mk = `${id}:${field}`;
  if (MEM.has(mk)) return { value: MEM.get(mk), cache: "bellek" };
  const store = dbOf(db);
  if (store) {
    let timer;
    try {
      const snap = await Promise.race([
        store.collection(COLLECTION).doc(id).get(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("okuma zaman aşımı")), READ_TIMEOUT_MS); }),
      ]);
      const rec = snap && snap.exists ? snap.get(field) : null;
      if (rec && rec.version === VERSION[field] && rec.value && good(rec.value)) {
        if (MEM.size > MEM_MAX) MEM.clear();
        MEM.set(mk, rec.value);
        return { value: rec.value, cache: "firestore" };
      }
    } catch (e) {
      console.warn(`Şablon vizyon önbelleği okunamadı (${field}; sorulacak):`, e.message || e);
    } finally {
      clearTimeout(timer);
    }
  }
  const value = await compute();
  if (value && good(value)) {
    if (MEM.size > MEM_MAX) MEM.clear();
    MEM.set(mk, value);
    if (store) {
      const admin = require("firebase-admin");
      store.collection(COLLECTION).doc(id).set({
        [field]: { version: VERSION[field], value: JSON.parse(JSON.stringify(value)), at: admin.firestore.FieldValue.serverTimestamp() },
      }, { merge: true }).catch((e) => console.warn(`Şablon vizyon önbelleği yazılamadı (${field}):`, e.message || e));
    }
  }
  return { value, cache: "yeni" };
}

/** Önbellekli gözlük yargısı (headGhost.judgeEyewear sonucu + cache). */
async function templateEyewear(buf, faceBox, apiKey, opts = {}) {
  const { judgeEyewear } = require("./headGhost");
  const r = await cachedJudgement(buf, "eyewear", () => judgeEyewear(buf, faceBox, apiKey), (v) => v && v.ok === true, opts);
  return { ...(r.value || { ok: false, reason: "no-result" }), cache: r.cache };
}

/** Önbellekli şablon MST (skinPigment.estimateTemplateMst): { mst, votes, cache } ya da null. */
async function templateMst(buf, faceBox, apiKey, opts = {}) {
  const { estimateTemplateMst } = require("./skinPigment");
  const r = await cachedJudgement(buf, "mst", () => estimateTemplateMst(buf, faceBox, apiKey), (v) => v && Number.isFinite(v.mst), opts);
  return r.value && Number.isFinite(r.value.mst) ? { ...r.value, cache: r.cache } : null;
}

module.exports = { templateEyewear, templateMst, cachedJudgement, _testables: { keyOf, MEM, VERSION, COLLECTION } };
