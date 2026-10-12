// PAKET DEFTERİ (2026-10-12, kullanıcı: "elindeki 25 ve 5 ise 25 mi 5 mi diye
// sormalı, 10 devreye girmemeli... 3 tane 10'lu bir tane 5'li aldı: 10 ve 5
// soracak").
//
// Cüzdan eskiden yalnız toplam foto hakkını (photoBalance) tutuyordu; 25 + 5
// alan kullanıcının 30 hakkı vardı ve hangi paketleri aldığı bilinmiyordu.
// Artık her satın alınan paket wallet.photoPacks içinde sayılır
// ({"5": n, "10": n, "25": n}). photoBalance PARA AÇISINDAN TEK GERÇEK
// KAYNAK olarak kalır; paket defteri yalnızca "hangi paketler" sorusunu
// cevaplar ve her zaman sum(paket x boy) <= photoBalance tutulur.
//
// Deftere girmeyen haklar (eksik teslim iadesi, bu değişiklikten önce alınmış
// paketler) "serbest" haktır: büyükten küçüğe paket boylarına bölünerek
// gösterilir (eski 30'luk bakiye 25 + 5; iadeden kalan 3 hak hiçbir paket
// etmez). Aynı hesap lib/presentation/dating/providers/dating_providers.dart
// PackBalance.packCounts'ta — EL İLE senkron tutulmalı.
//
// SAF: Firestore'a dokunmaz.

const PACK_SIZES = [5, 10, 25];

/** wallet.photoPacks'i {5,10,25} sayılarına çevirir (eksik/bozuk -> 0). */
function normalizePacks(raw) {
  const out = {};
  for (const s of PACK_SIZES) {
    const v = raw && raw[String(s)];
    out[s] = Number.isInteger(v) && v > 0 ? v : 0;
  }
  return out;
}

function packsTotal(packs) {
  return PACK_SIZES.reduce((t, s) => t + s * (packs[s] || 0), 0);
}

/**
 * Defteri bakiyeyle tutarlı hâle getirir: toplam bakiyeyi aşıyorsa önce
 * küçük paketler düşülür. Yeni nesne döner.
 */
function clipPacks(packs, balance) {
  const out = normalizePacks(toStored(packs));
  for (const s of PACK_SIZES) {
    while (out[s] > 0 && packsTotal(out) > balance) out[s]--;
  }
  return out;
}

/**
 * Kullanıcının elindeki paketler: defter (bakiyeye kırpılmış) + serbest
 * hakların büyükten küçüğe paket boylarına bölünmesi.
 */
function effectivePacks(balance, rawPacks) {
  const packs = clipPacks(normalizePacks(rawPacks), Math.max(0, balance || 0));
  let loose = Math.max(0, (balance || 0) - packsTotal(packs));
  for (const s of [...PACK_SIZES].sort((a, b) => b - a)) {
    const n = Math.floor(loose / s);
    packs[s] += n;
    loose -= n * s;
  }
  return packs;
}

/** Seçilebilecek paket boyları (elinde en az bir tane olan), büyükten küçüğe. */
function packOptions(balance, rawPacks) {
  const p = effectivePacks(balance, rawPacks);
  return PACK_SIZES.filter((s) => p[s] > 0).sort((a, b) => b - a);
}

/**
 * photoCount'luk üretim için defteri günceller. Defterde o boyda paket varsa
 * biri düşülür (consumed = boy); yoksa (serbest hak ya da seçimi bilmeyen
 * eski istemci) yalnız bakiye azalır, defter yeni bakiyeye kırpılır.
 * Dönüş { packs (Firestore'a yazılacak biçim), consumed }.
 */
function chargePacks(balance, rawPacks, photoCount) {
  const packs = clipPacks(normalizePacks(rawPacks), Math.max(0, balance || 0));
  let consumed = null;
  if (packs[photoCount] > 0) {
    packs[photoCount]--;
    consumed = photoCount;
  }
  return { packs: toStored(clipPacks(packs, Math.max(0, (balance || 0) - photoCount))), consumed };
}

/** Satın alınan ürünün paket boyu (kredi tablosundaki photoBalance), yoksa null. */
function packSizeOfCredit(credit) {
  const n = credit && credit.photoBalance;
  return PACK_SIZES.includes(n) ? n : null;
}

/** Defteri tek boy kadar artırır (satın alma, tam iade). */
function addPack(rawPacks, size) {
  const packs = normalizePacks(rawPacks);
  if (PACK_SIZES.includes(size)) packs[size]++;
  return toStored(packs);
}

function toStored(packs) {
  const out = {};
  for (const s of PACK_SIZES) out[String(s)] = packs[s] || 0;
  return out;
}

module.exports = { PACK_SIZES, normalizePacks, effectivePacks, packOptions, chargePacks, packSizeOfCredit, addPack, clipPacks };
