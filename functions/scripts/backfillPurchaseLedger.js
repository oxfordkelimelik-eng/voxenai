/**
 * ORTAK SATIN ALMA DEFTERİ DOLDURMA (2026-11-23)
 * ===========================================================================
 * verifyPurchase artık "bu satın alma işlendi mi?" sorusunu tüm hesaplar için tek defterden
 * (purchaseLedger/{ledgerId}) cevaplıyor. Eski satın almalar yalnız kullanıcının kendi klasöründe
 * (users/{uid}/private/payments/processedPurchases/{orderId}) kayıtlı; deftere aktarılmazlarsa eski bir
 * satın alma BİR KEZ daha başka bir hesapta kullanılabilir. Bu betik onları deftere yazar.
 *
 * - Var olan defter kaydının ÜSTÜNE YAZMAZ (createDocument; varsa 409 → atlanır). İki kez çalıştırmak güvenli.
 * - Aynı satın alma birden çok hesapta işlenmişse (açık kapanmadan önce kötüye kullanım) RAPORLAR;
 *   defter sahibi en erken kayıt olur.
 * - Deploy'dan ÖNCE de SONRA da çalıştırılabilir (eski kod defteri okumaz).
 *
 * KULLANIM
 *   node functions/scripts/backfillPurchaseLedger.js         -> KURU ÇALIŞMA (hiçbir şey yazmaz)
 *   node functions/scripts/backfillPurchaseLedger.js --yaz   -> deftere yazar
 *
 * Kimlik: firebase-tools oturumu (`firebase login`), bkz. migratePhotoBalanceToPhotoUnits.js.
 */

const fs = require("fs");
const path = require("path");
const { ledgerId } = require("../purchaseCheck");

const PROJECT = "rise-up-9235f";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const LIMIT = 5000;

async function accessToken() {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME, ".config", "configstore", "firebase-tools.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: cfg.tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Oturum alınamadı — `firebase login` gerekli.");
  return tok.access_token;
}

async function readProcessed(token) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "processedPurchases", allDescendants: true }], limit: LIMIT } }),
  });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("Sorgu başarısız: " + JSON.stringify(rows).slice(0, 300));
  const out = [];
  for (const r of rows) {
    if (!r.document) continue;
    const name = r.document.name;
    const f = r.document.fields || {};
    out.push({
      uid: name.split("/users/")[1].split("/")[0],
      orderId: decodeURIComponent(name.split("/processedPurchases/")[1]),
      platform: f.platform && f.platform.stringValue,
      productId: (f.productId && f.productId.stringValue) || null,
      createdAt: (f.createdAt && f.createdAt.timestampValue) || r.document.createTime,
    });
  }
  if (out.length >= LIMIT) throw new Error(`${LIMIT} kayda ulaşıldı — sayfalama ekle.`);
  return out;
}

async function main() {
  const write = process.argv.includes("--yaz");
  const token = await accessToken();
  const rows = await readProcessed(token);
  console.log(`işlenmiş satın alma: ${rows.length}`);

  const groups = new Map();
  const noPlatform = [];
  for (const r of rows) {
    if (r.platform !== "ios" && r.platform !== "android") { noPlatform.push(r); continue; }
    const id = ledgerId(r.platform, r.orderId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const dups = [...groups.values()].filter((g) => new Set(g.map((r) => r.uid)).size > 1);
  if (noPlatform.length) console.log(`platformu olmayan (atlandı): ${noPlatform.length}`, noPlatform.map((r) => `${r.uid}/${r.orderId}`));
  console.log(`BİRDEN ÇOK HESAPTA İŞLENMİŞ satın alma: ${dups.length}`);
  for (const g of dups) {
    console.log(`  ${g[0].platform} işlem=${g[0].orderId} ürün=${g[0].productId} hesaplar=${g.map((r) => `${r.uid}@${r.createdAt}`).join(", ")}`);
  }

  let created = 0, existed = 0, failed = 0;
  for (const [id, g] of groups) {
    const first = [...g].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!write) continue;
    const res = await fetch(`${BASE}/purchaseLedger?documentId=${id}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: first.uid },
          platform: { stringValue: first.platform },
          orderId: { stringValue: first.orderId },
          productId: first.productId ? { stringValue: first.productId } : { nullValue: null },
          sandbox: { booleanValue: false },
          backfilled: { booleanValue: true },
          createdAt: { timestampValue: first.createdAt },
        },
      }),
    });
    if (res.ok) created++;
    else if (res.status === 409) existed++;
    else { failed++; console.error(`yazılamadı ${id}: ${res.status} ${(await res.text()).slice(0, 200)}`); }
  }
  console.log(write
    ? `defter: yeni=${created} zaten vardı=${existed} hata=${failed}`
    : `KURU ÇALIŞMA: ${groups.size} defter kaydı yazılacaktı. Yazmak için --yaz.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
