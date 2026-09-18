/**
 * CÜZDAN BİRİM MİGRASYONU — "stil/set" -> "foto" (2026-09-19)
 * ===========================================================================
 *
 * NEDEN: `photoBalance` eskiden STİL SAYIYORDU (1 birim = 10 foto, bkz.
 * falPhotos.styleUnitsFor + LEGACY_PHOTOS_PER_STYLE). Yeni pakette FOTO
 * sayıyor (photoUnitsFor). Deploy edilip hiçbir şey yapılmazsa 3 birimi olan
 * kullanıcının 30 fotoluk hakkı 3 fotoya düşer.
 *
 * ---------------------------------------------------------------------------
 * NEDEN "ÇARP" DEĞİL "FARKI EKLE" — YARIŞ DURUMU
 * ---------------------------------------------------------------------------
 * Akla gelen ilk yöntem "deploy'dan sonra her bakiyeyi 10 ile çarp". Bu,
 * deploy ile migrasyon ARASINDAKİ pencerede bozuluyor:
 *
 *   • O pencerede kullanıcı SATIN ALIRSA yeni kod zaten FOTO cinsinden
 *     yüklüyor (+10 gibi). Sonradan çarpmak o 10'u da 100 yapar.
 *   • O pencerede kullanıcı ÜRETİRSE yeni kod foto cinsinden düşüyor.
 *
 * Bu yüzden iki adım var ve ikisi birlikte yarıştan bağışık:
 *
 *   1) snapshot  (DEPLOY'DAN ÖNCE, salt okunur) — o andaki STİL bakiyelerini
 *      dosyaya yazar.
 *   2) apply     (DEPLOY'DAN SONRA, yazar) — her cüzdana snapshot'taki
 *      değerin 9 KATINI EKLER; çarpmaz.
 *
 * Neden 9: yeni bakiye = eski_stil * 10 = eski_stil + eski_stil * 9. Yani
 * "eksik kalan kısım" ekleniyor. Aradaki pencerede ne olursa olsun doğru
 * sonucu verir:
 *
 *   3 stil (=30 foto), pencerede 5 fotoluk paket aldı:
 *     bakiye 3 -> 8, sonra +27  = 35   DOĞRU (30 + 5)
 *   5 stil (=50 foto), pencerede 5 foto üretti:
 *     bakiye 5 -> 0, sonra +45  = 45   DOĞRU (50 - 5)
 *
 * ---------------------------------------------------------------------------
 * İKİ KEZ ÇALIŞTIRMAYA KARŞI KORUMA
 * ---------------------------------------------------------------------------
 * Her cüzdana `photoUnitVersion: 2` yazılır ve bu alanı taşıyan cüzdan
 * ATLANIR. Betiği yanlışlıkla ikinci kez çalıştırmak kimseye ikinci kez
 * kredi vermez.
 *
 * Ayrıca her yazma, okunan dokümanın `updateTime`'ına KİLİTLENİR
 * (currentDocument.updateTime). Siz yazarken kullanıcı üretim yapıp bakiyeyi
 * değiştirdiyse yazma SESSİZCE EZMEZ, hata verir ve o cüzdan atlanır —
 * sonra tekrar çalıştırırsınız.
 *
 * ---------------------------------------------------------------------------
 * KULLANIM
 * ---------------------------------------------------------------------------
 *   node functions/scripts/migratePhotoBalanceToPhotoUnits.js snapshot
 *       -> wallet-snapshot.json yazar (DEPLOY'DAN ÖNCE)
 *
 *   node functions/scripts/migratePhotoBalanceToPhotoUnits.js apply
 *       -> KURU ÇALIŞMA: ne yapacağını yazar, HİÇBİR ŞEY DEĞİŞTİRMEZ
 *
 *   node functions/scripts/migratePhotoBalanceToPhotoUnits.js apply --yaz
 *       -> gerçekten yazar (DEPLOY'DAN SONRA)
 *
 * Kimlik: firebase-tools'un oturumunu kullanır (`firebase login` yapılmış
 * olmalı). Admin SDK anahtarı gerekmez.
 */

const fs = require("fs");
const path = require("path");

const PROJECT = "rise-up-9235f";
// Eski birimde 1 stil = 10 foto idi.
const PHOTOS_PER_LEGACY_UNIT = 10;
// Eklenecek kat: mevcut bakiye zaten 1 katını içeriyor (bkz. başlıktaki
// gerekçe), eksik olan 9 katı.
const TOP_UP_FACTOR = PHOTOS_PER_LEGACY_UNIT - 1;
// Bu sürümü taşıyan cüzdan migre edilmiş sayılır.
const MIGRATED_VERSION = 2;

const SNAPSHOT_FILE = path.join(__dirname, "wallet-snapshot.json");

async function accessToken() {
  const cfgPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".config", "configstore", "firebase-tools.json"
  );
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
  if (!tok.access_token) throw new Error("Oturum alınamadı — `firebase login` gerekli. " + JSON.stringify(tok));
  return tok.access_token;
}

const numOf = (f) => Number(f?.integerValue ?? f?.doubleValue ?? 0);

/** Tüm users/{uid}/private/wallet dokümanlarını okur. */
async function readWallets(token) {
  const out = [];
  let pageToken = null;
  do {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "private", allDescendants: true }],
            limit: 1000,
          },
        }),
      }
    );
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("Sorgu başarısız: " + JSON.stringify(rows).slice(0, 300));
    for (const r of rows) {
      if (!r.document || !r.document.name.endsWith("/wallet")) continue;
      const f = r.document.fields || {};
      out.push({
        name: r.document.name,
        uid: r.document.name.split("/users/")[1].split("/")[0],
        updateTime: r.document.updateTime,
        photoBalance: numOf(f.photoBalance),
        analysisBalance: numOf(f.analysisBalance),
        photoUnitVersion: numOf(f.photoUnitVersion),
      });
    }
    pageToken = null; // runQuery sayfalamıyor; 1000 limiti mevcut hacmin çok üstünde
  } while (pageToken);
  return out;
}

async function doSnapshot() {
  const token = await accessToken();
  const wallets = await readWallets(token);
  const withBalance = wallets.filter((w) => w.photoBalance > 0);
  const payload = {
    takenAt: new Date().toISOString(),
    note: "photoBalance DEĞERLERİ ESKİ BİRİMDE (stil/set). apply adımı bunların 9 katını EKLER.",
    photosPerLegacyUnit: PHOTOS_PER_LEGACY_UNIT,
    wallets: withBalance.map((w) => ({
      uid: w.uid, name: w.name, legacyPhotoBalance: w.photoBalance,
    })),
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Toplam cüzdan: ${wallets.length}`);
  console.log(`Bakiyesi olan : ${withBalance.length}`);
  console.log("");
  for (const w of withBalance) {
    console.log(
      `  ${w.uid.slice(0, 12).padEnd(12)} ${String(w.photoBalance).padStart(3)} stil` +
      ` = ${String(w.photoBalance * PHOTOS_PER_LEGACY_UNIT).padStart(4)} foto olmalı` +
      ` (analiz ${w.analysisBalance}, dokunulmuyor)`
    );
  }
  const totalUnits = withBalance.reduce((s, w) => s + w.photoBalance, 0);
  console.log("");
  console.log(`TOPLAM: ${totalUnits} stil = ${totalUnits * PHOTOS_PER_LEGACY_UNIT} foto hakkı korunacak.`);
  console.log(`Yazıldı: ${SNAPSHOT_FILE}`);
  console.log("");
  console.log("SIRADAKİ: deploy'u yap, sonra `apply` ile kuru çalıştır.");
}

async function doApply(write) {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    throw new Error(`Snapshot yok (${SNAPSHOT_FILE}). Önce DEPLOY'DAN ÖNCE \`snapshot\` çalıştırılmalıydı.`);
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  const token = await accessToken();
  const live = await readWallets(token);
  const byName = new Map(live.map((w) => [w.name, w]));

  console.log(`Snapshot zamanı: ${snap.takenAt}`);
  console.log(`Mod            : ${write ? "YAZIYOR" : "KURU ÇALIŞMA (hiçbir şey değişmiyor)"}`);
  console.log("");

  let changed = 0, skipped = 0, failed = 0, totalAdded = 0;

  for (const s of snap.wallets) {
    const cur = byName.get(s.name);
    if (!cur) {
      console.log(`  ATLANDI ${s.uid.slice(0, 12)} — cüzdan bulunamadı`);
      skipped++;
      continue;
    }
    if (cur.photoUnitVersion >= MIGRATED_VERSION) {
      console.log(`  ATLANDI ${s.uid.slice(0, 12)} — zaten migre edilmiş (photoUnitVersion=${cur.photoUnitVersion})`);
      skipped++;
      continue;
    }
    const topUp = s.legacyPhotoBalance * TOP_UP_FACTOR;
    const next = cur.photoBalance + topUp;
    // SNAPSHOT İLE DEPLOY ARASINDAKİ PENCERE.
    //
    // "Farkı ekle" yöntemi DEPLOY SONRASI her hareketten bağışık, ama
    // snapshot ile deploy ARASINDA eski kodla yapılmış bir hareket varsa
    // (o an bakiye hâlâ STİL cinsindeydi) hesap tutmaz: o pencerede alınan
    // 1 stil, 10 foto yerine 1 foto olarak kalır.
    //
    // Sessizce geçmesin diye burada yakalanıyor. Sapma varsa o cüzdanı elle
    // düzelt: doğru bakiye = (pencere sonundaki stil sayısı) * 10.
    if (cur.photoBalance !== s.legacyPhotoBalance) {
      console.log(
        `  !! DİKKAT ${s.uid.slice(0, 12)} — bakiye snapshot'tan beri değişmiş ` +
        `(${s.legacyPhotoBalance} -> ${cur.photoBalance}). Snapshot ile deploy ARASINDA ` +
        `hareket olduysa bu cüzdanı elle doğrula.`
      );
    }
    console.log(
      `  ${s.uid.slice(0, 12).padEnd(12)} snapshot=${String(s.legacyPhotoBalance).padStart(3)} stil` +
      ` | şu an ${String(cur.photoBalance).padStart(4)} -> ${String(next).padStart(4)} foto (+${topUp})`
    );
    totalAdded += topUp;
    if (!write) { changed++; continue; }

    // updateTime KİLİDİ: okuduğumuzdan beri cüzdan değiştiyse yazma reddedilir.
    const url = `https://firestore.googleapis.com/v1/${cur.name}` +
      `?updateMask.fieldPaths=photoBalance&updateMask.fieldPaths=photoUnitVersion` +
      `&currentDocument.updateTime=${encodeURIComponent(cur.updateTime)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        fields: {
          photoBalance: { integerValue: String(next) },
          photoUnitVersion: { integerValue: String(MIGRATED_VERSION) },
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.log(`     !! YAZILAMADI (${res.status}) — ${t.slice(0, 140)}`);
      console.log("        Cüzdan bu arada değişmiş olabilir; betiği tekrar çalıştır.");
      failed++;
      continue;
    }
    changed++;
  }

  console.log("");
  console.log(`Değişen: ${changed}  Atlanan: ${skipped}  Başarısız: ${failed}  Eklenen toplam foto: ${totalAdded}`);
  if (!write) console.log("\nKURU ÇALIŞMAYDI. Gerçekten yazmak için: ... apply --yaz");
}

(async () => {
  const mode = process.argv[2];
  const write = process.argv.includes("--yaz");
  if (mode === "snapshot") await doSnapshot();
  else if (mode === "apply") await doApply(write);
  else {
    console.log("Kullanım:");
    console.log("  node migratePhotoBalanceToPhotoUnits.js snapshot      # DEPLOY'DAN ÖNCE");
    console.log("  node migratePhotoBalanceToPhotoUnits.js apply         # kuru çalışma");
    console.log("  node migratePhotoBalanceToPhotoUnits.js apply --yaz   # DEPLOY'DAN SONRA, yazar");
    process.exit(1);
  }
})().catch((e) => { console.error("HATA:", e.message); process.exit(1); });
