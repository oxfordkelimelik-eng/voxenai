// İŞ BAĞLAMI: süre bütçesi + MALİYET DEFTERİ (2026-10-11).
//
// Her chunk çalışması AsyncLocalStorage ile işin bitiş zamanını ve paylaşılan
// maliyet defterini taşır (bkz. falPhotos jobClock.run). Modüller (headGhost,
// limbBox...) ayrı dosyada olduğu için defter burada; harcama, OpenAI'nin
// cevapta döndürdüğü GERÇEK token sayılarından hesaplanır.
//
// MALİYET SINIRI (kullanıcı kararı, 2026-10-11: "5'li pakette reddedilenlerle
// birlikte toplam 10 foto, 10 fotonun maliyeti 1.5 doları geçmemeli"). Ana
// üretim ve kalite kapıları zorunlu: iş başında chunk başına pay ayrılır,
// chunk zorunlu adımlarını bitirince payın kalanı serbest kalır. İsteğe bağlı
// son AI adımları (kafa çevresi dolgusu, gözlük) yalnızca harcanan + ayrılan +
// tahmini maliyet sınırı aşmıyorsa çalışır; aşacaksa atlanır ve kare onlarsız
// teslim edilir.

const { AsyncLocalStorage } = require("node:async_hooks");

const jobClock = new AsyncLocalStorage();

// USD / 1M token. gpt-image-2 oranları faturadaki bakiye düşüşüyle
// kalibre edildi (bkz. scratchpad jobCost.js: metin 5, görsel girdi 8, çıktı
// 30); bilinmeyen model gpt-4o oranıyla sayılır.
const PRICES = {
  "gpt-image-2": { text: 5, image: 8, out: 30 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
};
const FALLBACK_CHAT = PRICES["gpt-4o"];

const COST_LIMIT_PER_FRAME_USD = 0.15; // 10 kare = 1.50 $
const COST_LIMIT_MIN_USD = 0.2; // tek karelik işlerde (ücretsiz deneme) gözlük+dolguya yer kalsın
// Chunk başına zorunlu pay: ana üretim (~0.100) + iki Vision çağrısı (~0.015)
// + kalıntı yargısı (~0.004), üstüne küçük güvenlik payı.
const MANDATORY_RESERVE_PER_CHUNK_USD = 0.13;

/** OpenAI usage nesnesinin USD maliyeti. SAF. */
function usageCostUsd(model, usage) {
  if (!usage) return 0;
  const p = PRICES[model];
  if (usage.input_tokens != null) {
    // images/* uçları: metin/görsel girdi ayrı.
    const q = p && p.text != null ? p : PRICES["gpt-image-2"];
    const d = usage.input_tokens_details || {};
    const text = d.text_tokens ?? usage.input_tokens;
    const image = d.image_tokens ?? 0;
    return (text * q.text + image * q.image + (usage.output_tokens || 0) * q.out) / 1e6;
  }
  const q = p && p.in != null ? p : FALLBACK_CHAT;
  return ((usage.prompt_tokens || 0) * q.in + (usage.completion_tokens || 0) * q.out) / 1e6;
}

/** İş başına sınır. */
function costLimitFor(chunkCount) {
  return Math.max(COST_LIMIT_MIN_USD, COST_LIMIT_PER_FRAME_USD * chunkCount);
}

/** Yeni defter: iş başında, tüm chunk'ların zorunlu payı ayrılmış hâlde. */
function createLedger(chunkCount, limitUsd = costLimitFor(chunkCount)) {
  return { limitUsd, spentUsd: 0, reservedUsd: MANDATORY_RESERVE_PER_CHUNK_USD * chunkCount, skipped: 0 };
}

/** Chunk'ın kendi bağlam nesnesi (defter paylaşılır). */
function chunkContext(deadline, ledger) {
  return { deadline, ledger, reserveLeft: ledger ? MANDATORY_RESERVE_PER_CHUNK_USD : 0, post: false };
}

/**
 * Gerçekleşen bir OpenAI çağrısını deftere yazar. Zorunlu evrede (ana üretim,
 * kapılar) maliyet önce chunk'ın payından düşülür. Bağlam yoksa (test, başka
 * fonksiyon) hiçbir şey yapmaz. Döner: USD.
 */
function recordUsage(model, usage) {
  const cost = usageCostUsd(model, usage);
  const st = jobClock.getStore();
  if (!st || !st.ledger) return cost;
  st.ledger.spentUsd += cost;
  if (!st.post && st.reserveLeft > 0) {
    const r = Math.min(st.reserveLeft, cost);
    st.reserveLeft -= r;
    st.ledger.reservedUsd -= r;
  }
  return cost;
}

/** Chunk zorunlu adımlarını bitirdi (son katmanlara geçti ya da bitti): payın kalanı serbest. */
function releaseMandatoryReserve() {
  const st = jobClock.getStore();
  if (!st || !st.ledger) return;
  st.post = true;
  st.ledger.reservedUsd -= st.reserveLeft;
  st.reserveLeft = 0;
}

/**
 * İsteğe bağlı bir adım için tahmini maliyeti ayırmayı dener. Sığmazsa null
 * (adım atlanmalı); sığarsa release() — çağrı bitince (başarılı/başarısız)
 * çağrılır, gerçek maliyet recordUsage ile ayrıca yazılır. Bağlam yoksa
 * sınırsız.
 */
function tryReserveOptional(estUsd) {
  const st = jobClock.getStore();
  if (!st || !st.ledger) return { release() {} };
  const L = st.ledger;
  if (L.spentUsd + L.reservedUsd + estUsd > L.limitUsd + 1e-9) {
    L.skipped++;
    return null;
  }
  L.reservedUsd += estUsd;
  let done = false;
  return { release() { if (!done) { done = true; L.reservedUsd -= estUsd; } } };
}

function ledgerSummary() {
  const st = jobClock.getStore();
  return st && st.ledger ? st.ledger : null;
}

module.exports = {
  jobClock,
  usageCostUsd,
  costLimitFor,
  createLedger,
  chunkContext,
  recordUsage,
  releaseMandatoryReserve,
  tryReserveOptional,
  ledgerSummary,
  PRICES,
  COST_LIMIT_PER_FRAME_USD,
  MANDATORY_RESERVE_PER_CHUNK_USD,
};
