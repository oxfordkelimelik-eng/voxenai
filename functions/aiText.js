// ORTAK METİN-AI ALTYAPISI (2026-11-22) — RizzGPT (rizz.js) ve Profil Doktoru (profileDoctor.js).
//
// - OpenAI katı JSON çağrısı: store:false, süre bütçeli yeniden deneme (yalnız 429/5xx ve zaman aşımı OLMAYAN
//   bağlantı hatası; zaman aşımı yeniden denenmez — OpenAI işleyip ücretlendirmiş olabilir), max_tokens kesilmesi
//   ve model reddi ayrı bildirilir.
// - Hak: modele gitmeden ÖNCE transaction ile AYRILIR (eşzamanlı istekler kotayı aşamaz), sonuç gösterilemezse
//   İADE. Günlük DENEME tavanı başarısız/ücretsiz sonuçların maliyetini sınırlar. Takip isteği (daha fazla vb.)
//   ana isteğin görüntülerine bağlıdır: istek başına rastgele tuzla HMAC (kalıcı parmak izi değil).
// - Firestore: users/{uid}/private/{feature}/usage/{gün} (expireAt 3 gün), .../requests/{id} (expireAt 1 gün).
//   TTL politikaları firestore.indexes.json'da collection group "usage" / "requests" için açık.

const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("./_shared");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
// USD / 1M token (jobContext PRICES ile aynı kaynak) — yalnız log için.
const PRICES = { "gpt-4.1": [2, 8], "gpt-4.1-mini": [0.4, 1.6], "gpt-4o": [2.5, 10] };
const DAY_MS = 24 * 60 * 60 * 1000;
// Süre bütçesi: fonksiyon 120 sn, istemci 120 sn. Model en çok ~95 sn, moderasyon 10 sn.
const MODEL_BUDGET_MS = 95_000;
const OPENAI_TIMEOUT_MS = 60_000;
const MIN_RETRY_MS = 30_000; // kalan bütçe bundan azsa yeniden deneme yok
const MAX_IMAGE_B64 = 3_000_000; // ~2.2 MB görüntü (istemci JPEG'e küçültür, ~300 KB)
const MAX_TOTAL_B64 = 7_000_000;
const FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;
const NEAR_DUP = 0.6;

// ---------------------------------------------------------------- saf yardımcılar

const str = (v) => (typeof v === "string" ? v : "");
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const nullable = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** İstanbul takvim günü (günlük hak sayacının anahtarı). SAF. */
function dayKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Benzerlik için metni sadeleştirir: Türkçe küçük harf, emoji/noktalama yok, tek boşluk. SAF. */
function normText(s) {
  return str(s).toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** İki metnin kelime kümesi Jaccard benzerliği (0..1). SAF. */
function similarity(a, b) {
  const A = new Set(normText(a).split(" ").filter(Boolean));
  const B = new Set(normText(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return A.size === B.size ? 1 : 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** İstek gövdesindeki base64 görüntüleri doğrular; hata HttpsError. SAF. */
function parseImages(d, maxImages) {
  const images = Array.isArray(d.images) ? d.images : [];
  if (!images.length) throw new HttpsError("invalid-argument", "En az bir ekran görüntüsü gerekli.");
  if (images.length > maxImages) throw new HttpsError("invalid-argument", `En fazla ${maxImages} ekran görüntüsü gönderebilirsin.`);
  let total = 0;
  const imgs = images.map((im) => {
    const data64 = str(im && im.data);
    const mime = str(im && im.mimeType) || "image/jpeg";
    if (!data64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(data64.slice(0, 200))) throw new HttpsError("invalid-argument", "Görsel okunamadı.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new HttpsError("invalid-argument", "Desteklenmeyen görsel türü.");
    if (data64.length > MAX_IMAGE_B64) throw new HttpsError("invalid-argument", "Görsel çok büyük.");
    total += data64.length;
    return { data: data64, mimeType: mime };
  });
  if (total > MAX_TOTAL_B64) throw new HttpsError("invalid-argument", "Görseller çok büyük.");
  return imgs;
}

/** Takip isteğini ana isteğin görüntülerine bağlayan özet (istek başına rastgele tuzla HMAC). SAF. */
function imagesDigest(salt, tag, images) {
  const h = crypto.createHmac("sha256", salt);
  h.update(tag);
  for (const im of images) { h.update("\n"); h.update(im.data); }
  return h.digest("base64");
}

/** Yeni istek için hak kararı (transaction içi değerlerle). SAF. */
function quotaDecision({ usedToday, dailyFree, balance }) {
  if (usedToday < dailyFree) return { source: "free" };
  if (balance > 0) return { source: "balance" };
  return { source: null };
}

/**
 * Takip isteği bu ana isteğe bağlanabilir mi: pencere, sayı ve AYNI görüntüler (başka içerikle ücretsiz istek
 * yapılamasın). digestOf(salt) verilmezse görüntü denetimi atlanır. SAF.
 */
function followupAllowed(parent, nowMs, max, digestOf) {
  if (!parent) return { ok: false, reason: "parent-missing" };
  const created = parent.createdAtMs || 0;
  if (nowMs - created > FOLLOWUP_WINDOW_MS) return { ok: false, reason: "parent-expired" };
  if ((parent.followups || 0) >= max) return { ok: false, reason: "followup-limit" };
  if (digestOf && (!parent.salt || digestOf(parent.salt) !== parent.digest)) return { ok: false, reason: "parent-mismatch" };
  return { ok: true };
}

const FOLLOWUP_MESSAGES = {
  "followup-limit": "Bu ekran görüntüsü için ek öneri hakkın doldu. Yeni bir istek başlat.",
  "parent-mismatch": "Ek öneriler yalnız aynı ekran görüntüsü için. Yeni bir istek başlat.",
};
const followupError = (reason) => new HttpsError("failed-precondition",
  FOLLOWUP_MESSAGES[reason] || "Bu istek zaman aşımına uğradı. Yeni bir istek başlat.", { reason });

function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.prompt_tokens || 0) * p[0] + (usage.completion_tokens || 0) * p[1]) / 1e6;
}

// ---------------------------------------------------------------- yapılandırma

/** config/{doc} okuyucu (60 sn önbellek). Alanlar: enabled, dailyFree, dailyAttempts, model. */
function makeConfigReader(docPath, defaults) {
  let cache = null;
  return async function readConfig() {
    if (cache && Date.now() - cache.at < 60_000) return cache.v;
    let v = { ...defaults };
    try {
      const snap = await db.doc(docPath).get();
      if (snap.exists) {
        const c = snap.data() || {};
        v = {
          enabled: c.enabled !== false,
          dailyFree: Number.isFinite(c.dailyFree) && c.dailyFree >= 0 ? Math.floor(c.dailyFree) : defaults.dailyFree,
          dailyAttempts: Number.isFinite(c.dailyAttempts) && c.dailyAttempts >= 1 ? Math.floor(c.dailyAttempts) : defaults.dailyAttempts,
          model: typeof c.model === "string" && PRICES[c.model] ? c.model : defaults.model,
        };
      }
    } catch (e) {
      console.warn(`AI METİN: ${docPath} okunamadı (varsayılanlar):`, e.message || e);
    }
    cache = { at: Date.now(), v };
    return v;
  };
}

// ---------------------------------------------------------------- OpenAI

/**
 * Katı JSON şemalı sohbet çağrısı. Dönüş: { parsed, truncated, refused, usage }.
 * parsed null + truncated=false → çıktı çözülemedi.
 */
async function callJsonModel(key, { model, system, schema, schemaName, images, text, temperature, maxTokens }) {
  const content = [
    ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimeType};base64,${im.data}`, detail: "high" } })),
    { type: "text", text },
  ];
  const body = {
    model,
    store: false,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
    messages: [{ role: "system", content: system }, { role: "user", content }],
  };
  const started = Date.now();
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const left = MODEL_BUDGET_MS - (Date.now() - started);
    if (attempt > 1 && left < MIN_RETRY_MS) break;
    let resp;
    try {
      resp = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(Math.min(OPENAI_TIMEOUT_MS, left)),
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastStatus = -1;
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      console.warn(`AI METİN: OpenAI ${timedOut ? "zaman aşımı" : "bağlantı hatası"} (deneme ${attempt}):`, e.name || "", e.message || e);
      if (timedOut) break;
      await new Promise((r) => setTimeout(r, attempt * 1500));
      continue;
    }
    if (resp.ok) {
      const json = await resp.json();
      const choice = json?.choices?.[0] || {};
      const usage = json.usage || null;
      if (choice.message?.refusal) return { parsed: null, refused: true, truncated: false, usage };
      if (choice.finish_reason === "length") return { parsed: null, refused: false, truncated: true, usage };
      let parsed = null;
      try { parsed = JSON.parse(choice.message?.content || ""); } catch (e) { parsed = null; }
      return { parsed, refused: false, truncated: false, usage };
    }
    lastStatus = resp.status;
    const errText = (await resp.text().catch(() => "")).slice(0, 300);
    if (resp.status !== 429 && resp.status < 500) {
      console.error(`AI METİN: OpenAI ${resp.status}: ${errText}`);
      throw new HttpsError("internal", "Cevap şu an üretilemedi. Lütfen tekrar dene.");
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  console.error(`AI METİN: OpenAI başarısız (son durum ${lastStatus}, ${Date.now() - started}ms).`);
  throw new HttpsError("unavailable", "AI servisi şu an meşgul. Biraz sonra tekrar dene.");
}

/** Metinleri OpenAI moderasyonundan geçirir. Dönüş: { flagged: bool[], err }. Hata = geçir (ücretsiz ek katman). */
async function moderateTexts(key, texts) {
  if (!texts.length) return { flagged: [] };
  try {
    const resp = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: texts }),
    });
    if (!resp.ok) return { flagged: texts.map(() => false), err: `http-${resp.status}` };
    const json = await resp.json();
    const res = Array.isArray(json.results) ? json.results : [];
    return { flagged: texts.map((_, i) => !!(res[i] && res[i].flagged)) };
  } catch (e) {
    return { flagged: texts.map(() => false), err: e.name || "error" };
  }
}

// ---------------------------------------------------------------- hak ayırma / iade

/**
 * Modele gitmeden önce hak (yeni istek) ya da takip yeri ayırır + günlük deneme sayacı. Hak yoksa HttpsError.
 * opts: { uid, feature, balanceField, cfg, parentId, digestOf, followupMax, quotaMessage, now }
 */
async function reserveUse(opts) {
  const { uid, feature, balanceField, cfg, parentId, digestOf, followupMax, quotaMessage, now } = opts;
  const FV = admin.firestore.FieldValue;
  const base = db.doc(`users/${uid}/private/${feature}`);
  const usageRef = base.collection("usage").doc(dayKey(now));
  const walletRef = db.doc(`users/${uid}/private/wallet`);
  const parentRef = parentId ? base.collection("requests").doc(parentId) : null;
  const resv = await db.runTransaction(async (tx) => {
    const [us, second] = await Promise.all([tx.get(usageRef), tx.get(parentRef || walletRef)]);
    const attempts = us.exists ? Number(us.get("attempts")) || 0 : 0;
    const usedToday = us.exists ? Number(us.get("count")) || 0 : 0;
    if (attempts >= cfg.dailyAttempts) {
      throw new HttpsError("resource-exhausted", "Bugün çok fazla deneme yaptın. Yarın tekrar dene.", { reason: "attempts" });
    }
    const usageExpire = admin.firestore.Timestamp.fromMillis(now + 3 * DAY_MS);
    if (parentRef) {
      const p = second.exists ? second.data() : null;
      const fa = followupAllowed(p, now, followupMax, digestOf);
      if (!fa.ok) throw followupError(fa.reason);
      const followups = (Number(p.followups) || 0) + 1;
      tx.set(parentRef, { followups }, { merge: true });
      tx.set(usageRef, { attempts: attempts + 1, expireAt: usageExpire }, { merge: true });
      return { kind: "followup", followupsLeft: followupMax - followups };
    }
    const balance = second.exists ? Number(second.get(balanceField)) || 0 : 0;
    const source = quotaDecision({ usedToday, dailyFree: cfg.dailyFree, balance }).source;
    if (!source) throw new HttpsError("failed-precondition", quotaMessage, { reason: "quota", dailyFree: cfg.dailyFree });
    const usage = { attempts: attempts + 1, expireAt: usageExpire, updatedAt: FV.serverTimestamp() };
    if (source === "free") usage.count = usedToday + 1;
    else tx.set(walletRef, { [balanceField]: balance - 1, updatedAt: FV.serverTimestamp() }, { merge: true });
    tx.set(usageRef, usage, { merge: true });
    return {
      kind: "new", source, followupsLeft: followupMax,
      quota: {
        dailyFree: cfg.dailyFree,
        freeLeft: Math.max(0, cfg.dailyFree - (usedToday + (source === "free" ? 1 : 0))),
        balance: source === "balance" ? balance - 1 : balance,
      },
    };
  });
  return { ...resv, uid, feature, balanceField, usageRef, walletRef, parentRef, base };
}

/** Ayrılan hak/takip yerini geri verir (deneme sayacı kalır). Hata yutulur, loglanır. */
async function refundUse(resv) {
  const FV = admin.firestore.FieldValue;
  try {
    if (resv.kind === "followup") await resv.parentRef.update({ followups: FV.increment(-1) });
    else if (resv.source === "free") await resv.usageRef.update({ count: FV.increment(-1) });
    else await resv.walletRef.update({ [resv.balanceField]: FV.increment(1) });
  } catch (e) {
    console.error(`AI METİN: iade yazılamadı (${resv.feature}, uid=${resv.uid}):`, e.message || e);
  }
}

/**
 * Hak düşmeden İÇERİK veren sonuç (RizzGPT declined/sensitive: 1 cevap) için günlük tavan (2026-11-23).
 * Sayaç günlük kullanım dokümanında (freebies). true = bu sonuç içeriğiyle gösterilebilir. Yazılamazsa false
 * (güvenli taraf: içerik gizlenir, durum mesajı yine gösterilir).
 */
async function takeFreebie(resv, max) {
  try {
    return await db.runTransaction(async (tx) => {
      const s = await tx.get(resv.usageRef);
      const n = s.exists ? Number(s.get("freebies")) || 0 : 0;
      if (n >= max) return false;
      tx.set(resv.usageRef, { freebies: n + 1 }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error(`AI METİN: ücretsiz sonuç sayacı yazılamadı (${resv.feature}, uid=${resv.uid}):`, e.message || e);
    return false;
  }
}

/**
 * Başarılı yeni istek için takip kaydı: zaman, sayaç, tür ve görüntülerin tuzlu özeti — İÇERİK YOK, 1 günde
 * silinir. Dönüş requestId (yazılamazsa null → takip kapalı).
 */
async function recordParent(resv, { mode, tag, images, now }) {
  const ref = resv.base.collection("requests").doc();
  const salt = crypto.randomBytes(16).toString("base64");
  try {
    await ref.set({
      createdAtMs: now, followups: 0, mode, day: dayKey(now), salt,
      digest: imagesDigest(salt, tag, images),
      expireAt: admin.firestore.Timestamp.fromMillis(now + DAY_MS),
    });
    return ref.id;
  } catch (e) {
    console.error(`AI METİN: istek kaydı yazılamadı (takip kapalı, ${resv.feature}, uid=${resv.uid}):`, e.message || e);
    return null;
  }
}

module.exports = {
  PRICES, DAY_MS, MODEL_BUDGET_MS, OPENAI_TIMEOUT_MS, MIN_RETRY_MS, FOLLOWUP_WINDOW_MS, NEAR_DUP,
  str, oneOf, nullable, dayKey, normText, similarity, parseImages, imagesDigest, quotaDecision, followupAllowed,
  costUsd, makeConfigReader, callJsonModel, moderateTexts, reserveUse, refundUse, recordParent, takeFreebie,
};
