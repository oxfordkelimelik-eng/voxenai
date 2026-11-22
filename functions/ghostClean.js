"use strict";
/**
 * ŞABLON KAFASI KALINTISI TEMİZLİĞİ (2026-10-30, c2e8eff1, kullanıcı: "base
 * fotonun saç silüeti kalmış. bu eski fotodan saç silüeti kalma problemini
 * kesin olarak çözmemiz lazım ... silüet kalmamalı ... api maliyet oluşturmadan").
 *
 * GÖZLEM (c2e8eff1 c0/c5/c9): kalıntı TAM şablon kafasının durduğu yerde —
 * c0 kullanıcının koyu kısa saçının üstünde şablonun sarı saçı, c9 kahverengi
 * kabarık perçem, c5 baş aşağı çizilmiş, şablonun beresi eski yerinde havada.
 * Eski kafa çevresi temizliği (headSurround) üçünü de bırakıyordu.
 *
 * DENENİP BIRAKILANLAR (aynı gün, yerel, 10 kare):
 *  - Yalnız renk karışımı (çıktı ≈ zemin + α·(şablon − zemin)): c5 bereyi
 *    buldu, c0/c9'u bulamadı — sınıflandırıcı izi kullanıcının saçıyla tek
 *    parça "saç" sayıyor, altın tavan ile sarı saç rengi de birbirine yakın.
 *  - Kullanıcının saç rengine göre "saç içindeki iz": kulakları ve yan saçı
 *    iz sayıp kesti (c0, c2, c3, c4), c9'u yine bulamadı.
 *  - LaMa zemin plakası: kafa deliğine paltonun devamı gibi koyu leke çizdi.
 *
 * YÖNTEM (koordinat): kullanıcının kafa+saç sınırı SELFIE'den bilinir. Baş
 * açısı çıktıya en yakın selfie'nin kafa maskesi, göz ortası ve çene ucu iki
 * sabit nokta alınarak (benzerlik dönüşümü) çıktının yüzüne taşınır = beklenen
 * kafa. Şablonda şapka varsa şablonun şapkası da aynı yolla yeni yüze taşınıp
 * beklenen kafaya katılır. Şablon kafasının beklenen kafanın (pay ile) DIŞINDA
 * kalan kısmında kafa sınıfı (saç/yüz/aksesuar) ya da yarı saydam karışım
 * görülen her piksel iz sayılır ve yerel LaMa ile zemine çevrilir; beklenen
 * kafanın içine dokunulmaz. Selfie yoksa yalnız kafa dışındaki karışım testi.
 *
 * Şablon ve çıktı AYNI koordinat uzayında olmalı (sade akışta tplForEyewear;
 * kıyafet kayması 20 karede 0-1 px). Kafa bükmeden (headWarp) ÖNCE çalışır.
 * Yalnız kusur dolar (head-surround-defects-only).
 */
const sharp = require("sharp");

// Kafa kesiti (kare), iki yüz genişliğinin büyüğüne oranla; yukarı ve aşağı pay.
const CROP_FACE = 4.4;
const CROP_UP_FACE = 1.5;
const CROP_DOWN_FACE = 0.4;
// Ölçü çözünürlüğü (kare kenarı, px).
const WORK_MAX = 640;
const SEG_MIN = 0.5;
// Şablon kafası maskesinin genişlemesi (soluk teller sınıfta arka plan).
const TPL_GROW_FACE = 0.05;
// Kullanıcının kafası çevresinde zemin tahmini/dolgu bağlamından çıkarılan pay.
const HOLE_GROW_FACE = 0.03;
// SELFIE PROFİLİ: kesit (yüz genişliği), maske çözünürlüğü, beklenen kafa payı
// (+ açı farkı başına ek pay).
const PROFILE_CROP_FACE = 3.6;
const PROFILE_N = 256;
const EXP_MARGIN_FACE = 0.06;
const EXP_MARGIN_PER_YAW = 0.1;
// 3B POZ FARKI PAYI (2026-10-31, 21e56b20 c5/c7, kullanıcı: "kafanın belli
// yerlerini silmişsin"): selfie kafa çizgisi göz-çene iki noktasıyla taşınıyor;
// çıktı başı selfie'den farklı eğik/dönükse (c7: çıktı −17°/−21° pitch, en
// yakın selfie önden) çizgi kafanın arkasını ve kulağı dışarıda bırakıp
// sildirdi. Eski pay yalnız 68 noktalı yaw farkına bakıyordu (pitch'i görmez,
// gözlükte kayar). Pay artık 3B yaw+pitch farkıyla (derece) büyür.
// Bu kadar dereceye kadar selfie çizgisi güvenilir, pay büyümez (c2e8eff1 c0:
// 5° farkta 0.09 pay şablonun saç üstündeki sarı tutamını korudu).
const EXP_MARGIN_PER_DEG = 0.006;
const EXP_MARGIN_DEAD_DEG = 6;
const EXP_MARGIN_MAX = 0.3;
// KULLANICININ DERİSİ HİÇ SİLİNMEZ (aynı gün): şablon izi saç/şapka; yüze
// bağlı yüz/vücut derisi (kulak, burun, alın, çene, boyun) iz değildir.
// c2e8eff1 10 ham karenin 6'sında çene/boyun kenarı, 21e c5'te burun-alın
// önü siliniyordu. Kenarın yumuşak pikselleri de bu bantla korunur.
const USER_SKIN_MIN = 0.35;
const USER_SKIN_BAND_FACE = 0.015;
// Şablon şapkası: kaş üstünde aksesuar sınıfı bu kadar (yüz²) ise şapka.
const HAT_MIN_FACE2 = 0.1;
// MODELİN KORUDUĞU ŞAPKA (2026-11-06, şapkalı şablon promptu): şablonda şapka
// varsa (falPhotos şablon şapka tespiti, templateHat) ve çıktıda şablon şapka
// maskesinin (kaş üstü; gözlük hariç) en az bu payı opak 'others' ise model şapkayı
// tuttu: şablon şapka maskesi ∪ çıktının kaş üstü opak 'others'ı hiçbir yolda iz
// sayılmaz (iz detektörü sıcak eklemesi dahil). Ölçüldü (yerel teslim zinciri):
// korunmayınca 7e04933e c1 beresi tamamen silinip kafa tepesi düz kesildi
// (pay 0.82 → 0), 0eeb75c8 c3 kep tepesi basamaklı yırtıldı (0.71 → 0.38);
// açık renk şapka koyu saçlı kullanıcıda "kullanıcı saçından uzak ve açık" sıcak
// yama kuralına (d87c25b4 c0 kubbesi) birebir uyuyordu. Pay düşükse (model şapkayı
// düşürdü) bugünkü davranış: kalan kubbe temizlenir (80fc7ec4 c5).
const HAT_KEPT_SHARE = 0.4;
// Korunan şapkanın kenar bandı (yumuşak kenar pikselleri basamaklanmasın).
const HAT_KEEP_BAND_FACE = 0.015;
// Beklenen kafanın dışında "kafa gibi" sayılan sınıf skorları.
const OUT_HAIR_MIN = 0.25;
const OUT_SKIN_MIN = 0.35;
const OUT_HAT_MIN = 0.35;
// Kişi maskesi (selfie_segmenter) bu kadarsa da kafa gibi: soluk şablon saçı
// çok sınıflı modelde "zemin", kişi maskesinde dolu çıkıyor (c0 sarı saç;
// bkz. hafıza ghost-hair-is-background-class). Yalnız ana kişiye bağlı bileşen.
const OUT_PERSON_MIN = 0.35;
// Karışım testi: |şablon − zemin| alt sınırı, yarı saydamlık aralığı, artık.
const CONTRAST_MIN = 22;
const ALPHA_LO = 0.18;
const ALPHA_HI = 0.88;
const RESID_FRAC = 0.45;
const RESID_ABS = 6;
// Selfie yoksa: dolu kafaya yakın (EDGE_FACE) pikselde iz ancak şablon karışımı
// kullanıcının kafa rengi + zemin karışımından EDGE_RATIO kat iyi açıklıyorsa.
const EDGE_FACE = 0.07;
const EDGE_RATIO = 0.6;
const PROTECT_FACE = 0.02;
// Zemin tahmini: kafa/kişi dışı piksellerin artan pencerelerde ağırlıklı ortalaması.
const BG_RADII_FACE = [0.06, 0.15, 0.35, 0.8];
const BG_COVER_MIN = 0.12;
const SMOOTH_FACE = 0.025;
// Kullanıcının saç rengine bu kadar (RGB) yakın saç pikseli beklenen kafanın
// dışında da korunur; ortanca bu kadar dolu saç skorlu pikselden.
const USER_HAIR_MIN = 0.6;
const USER_HAIR_SAME = 30;
const USER_HAIR_REACH_FACE = 0.05;
// İz kırıntısı: izin bu kadar (yüz genişliği) yakınında, temiz zeminden bu
// kadar (kanal, 0-255) farklı piksel de silinir.
const CRUMB_REACH_FACE = 0.08;
const CRUMB_DIFF = 28;
// LaMa'ya giden deliğin en büyük açıklığı (px): tek 512 parçasına sığsın.
const LAMA_SPAN_MAX = 440;
// Bundan küçük iz bileşeni (yüz² payı) yok sayılır; genişleme ve kenar yumuşatma.
const MIN_AREA_FACE2 = 0.004;
const GROW_FACE = 0.03;
// ARTIK İZ (2026-11-05, 9c8f2cb5 c3 "belli belirsiz tutam"): açık zeminde (gökyüzü
// 204) soluk şablon telleri (165-185) ne karışım testine (kaba zemin ortalaması,
// α≥0.18) ne kırıntı eşiğine (28) giriyordu ve kafanın üstünde gri leke kalıyordu.
// Bileşimden sonra temiz LaMa dolgusu zemin kabul edilir; şablon kafası alanında,
// izin/kafanın RES_REACH yakınında, skinSeg'in arka plan dediği (≥RES_BG_MIN) ve
// "çıktı − zemin ≈ α·(şablon − zemin)" imzası tutan pikseller dolguyla değişir.
// Kullanıcının kafası (core), korunan saç, deri hiç sınanmaz.
const RES_REACH_FACE = 0.2;
const RES_BG_MIN = 0.5;
const RES_SMOOTH_FACE = 0.004;
const RES_OD_MIN = 8;
const RES_ALPHA_LO = 0.02;
const RES_ALPHA_RAMP = 0.04;
const RES_ALPHA_MAX = 1.1;
const FEATHER_FACE = 0.02;
// BİLEŞİM (2026-11-20, 64bff386 c5 "saç silinmiş"): iz silinirken bileşim ağırlığı (comp, FEATHER
// ile bulanıklaştırılmış) korunan kafanın (core: kullanıcının opak saçı/derisi) İÇİNE taşıyordu;
// gerçek saç kenarı LaMa zeminiyle karışıp pürüzsüz, bulanık bir kubbeye dönüyordu (bukle/tel
// dokusu kayboluyordu). CORE_PROTECT: ağırlık core içinde sıfıra iner (core çalışma ızgarasından
// doğrusal büyütüldüğü için kenarda birkaç piksellik rampa, ikili kapı değil). Yeniden oynatma
// (11-19 ham kareleri, izli 16 kare): değişen bantta Laplace ort. ghostsuz 13.9 / eski 8.9 / yeni
// 11.4, 15/16 karede keskinleşme; core dışına dokunmadığı için yeni iz ya da kafa kesiği olamaz.
// CRUMB: kırıntı kuralı; kapatmak 16 karenin yalnız birinde fark etti (248a0e72 c2) — açık kalır.
const COMPOSE = { CRUMB: true, CORE_PROTECT: true };

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

async function rawOf(buf, W = null, H = null) {
  let p = sharp(buf).rotate().removeAlpha();
  if (W && H) p = p.resize(W, H, { fit: "fill" });
  const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** Kare kesit (side), n×n'ye ölçeklenmiş raw RGB. */
async function cropSquare(data, W, H, left, top, side, n) {
  const p = sharp(data, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width: side, height: side });
  return (n === side ? p : p.resize(n, n, { kernel: "lanczos3" })).raw().toBuffer();
}

function dilate(mask, W, H, r, distanceTo) {
  if (r <= 0) return Uint8Array.from(mask);
  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
  if (!any) return new Uint8Array(W * H);
  const d = distanceTo(mask, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) if (d[i] <= r) out[i] = 1;
  return out;
}

/** cand içinde, seed'e 4-komşulukla bağlı pikseller. SAF. */
function connected(cand, seed, W, H) {
  const out = new Uint8Array(W * H);
  const st = [];
  for (let i = 0; i < seed.length; i++) if (seed[i] && cand[i]) { out[i] = 1; st.push(i); }
  while (st.length) {
    const i = st.pop(), x = i % W, y = (i - x) / W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && cand[j] && !out[j]) { out[j] = 1; st.push(j); }
  }
  return out;
}

/** minArea'dan küçük 4-komşu bileşenleri siler. SAF. */
function dropSmall(mask, W, H, minArea) {
  const seen = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % W, y = (i - x) / W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
    }
    if (comp.length >= minArea) for (const i of comp) out[i] = 1;
  }
  return out;
}

// İZ İÇİNDE KALAN KORUNAN TUTAM (2026-11-19, 6a02687c c6, kullanıcı: "2-3 karede hafif şablon saç
// izi kalıyor"): hayalet kubbe silinince kubbenin içinde kalan koyu tutamlar (saç korumasının ya da
// kullanıcı opak saç kuralının tuttuğu, kullanıcı renginde şablon telleri) kafanın üstünde boynuz
// gibi kalıyordu. Ölçü yalnız geometri: opak kafanın (O) ince kenar bandının (EDGE_KEEP_FACE, saç
// kenarı yumuşaması — hiç değişmez) DIŞINDA kalan korunan piksellerin bileşeni; sınırının en az
// GHOST_SHARE'i silinen ize bakıyor, küçük ve kafadan izin içine belirgin uzanıyorsa (DEPTH_FACE,
// sivri çıkıntı) izdir. Bileşen kenar bandı olmadan kurulur: tutam, kafa kenarı boyunca uzanan
// ince korunan şeride bağlıyken tek büyük bileşen sayılıp alan sınırına takılıyordu.
// Opak kafaya, yüze ve deriye dokunulmaz. Bukle/gerçek saç koruması (fringe, protectedHair) hariç
// tutulmadı: denendi (11-19), bileşenler bölünüp isabetler kaydı (185655bf c3 kazancı kayboldu, c7
// büyüdü). Kör testte (6 kare) 5/1, açık farkla 3/0; tek kayıp c7 bukle kenarı hafif incelme.
const TUFT = { ON: true, MAX_FACE2: 0.03, GHOST_SHARE: 0.45, DEPTH_FACE: 0.04, EDGE_KEEP_FACE: 0.012 };
function tuftIslands({ keep, O, Od, cand, userSkin, inOval, n, fwk }) {
  const out = new Uint8Array(n * n);
  const edge = TUFT.EDGE_KEEP_FACE * fwk;
  const isl = (i) => keep[i] && !O[i] && !userSkin[i] && !inOval[i] && Od[i] > edge;
  const seen = new Uint8Array(n * n);
  const maxA = TUFT.MAX_FACE2 * fwk * fwk;
  const found = [];
  for (let s0 = 0; s0 < n * n; s0++) {
    if (seen[s0] || !isl(s0)) continue;
    const comp = [s0];
    seen[s0] = 1;
    let nb = 0, nbG = 0, nbO = 0;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q], x = i % n, y = (i - x) / n;
      for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, y > 0 ? i - n : -1, y < n - 1 ? i + n : -1]) {
        if (j < 0) continue;
        if (isl(j)) { if (!seen[j]) { seen[j] = 1; comp.push(j); } continue; }
        nb++;
        if (cand[j]) nbG++;
        else if (O[j]) nbO++;
      }
    }
    if (!nb || comp.length > maxA) continue;
    let depth = 0;
    for (const i of comp) if (Od[i] > depth) depth = Od[i];
    const g = nbG / nb, op = nbO / nb;
    const hit = g >= TUFT.GHOST_SHARE && depth >= TUFT.DEPTH_FACE * fwk;
    found.push({ a: +(comp.length / (fwk * fwk)).toFixed(4), g: +g.toFixed(2), op: +op.toFixed(2), d: +(depth / fwk).toFixed(3), hit });
    if (hit) for (const i of comp) out[i] = 1;
  }
  return { mask: out, found };
}

/** 3 kanallı raw için kutu bulanıklığı (yarıçap r). SAF. */
// YARI SAYDAM KAFA HALESİ (2026-11-07, 173acc7f c0, kullanıcı: "arkada hafif
// bi silüet"): model, kullanıcının selfie saç çizgisine kadar YARI SAYDAM koyu
// bir saç bandı çiziyor (opak saçın 0.05-0.2 yüz eni dışında). Bant şablon
// kafasının DIŞINDA (şablon kişi daha küçük) ve beklenen kafanın İÇİNDE olduğu
// için iz testleri (hepsi Th içi) ona hiç bakmıyordu. Test: çıktı = α·kullanıcı
// saç rengi + (1-α)·şablonun o pikseldeki gerçek zemini (şablon kafası dışı =
// zemin), α 0.1-0.85; opak kafaya bitişik; göz hizasının üstünde; bileşen alanı
// büyük (küçük lekeler saç ucu / gözlük sapı olabilir — "saç kesilmez").
// 10 karede (bugünkü iş) yalnız c0'da tetiklenir (0.078 yüz²; diğerleri ≤0.022).
const HALO_ON = true;
const HALO_BAND_FACE = 0.22;
const HALO_ALPHA_LO = 0.1;
const HALO_ALPHA_HI = 0.85;
const HALO_OD_MIN = 8;
const HALO_EYE_BELOW_FACE = 0.1;
const HALO_MIN_AREA_FACE2 = 0.04;
// GERÇEK SAÇ HALE DEĞİL (2026-11-10, 7bbdad12 c8/c4, kullanıcı): koyu zeminde kıvırcık saç kenarı
// "kullanıcı saçı + zemin karışımı" testine uyup hale sayılıyor, siliniyordu (c8 sol saç → LaMa
// bulamacı "hayalet bukle"). Bileşenin bu payı skinSeg'e göre kesin saçsa (≥ HALO_HAIR_SURE)
// bileşen bütünüyle korunur. Son iş: c8 %55, c4 %47 (gerçek saç), c1 %6 (gerçek hale, silinir).
const HALO_HAIR_SURE = 0.8;
const HALO_HAIR_SHARE = 0.35;
// HALE ŞABLON KAFASINA TAŞIYORSA (2026-11-19, 6a02687c c8, kullanıcı: "saçın üstündeki
// silüet"): gri kubbenin alt kısmı şablon kafasının (Th) içinde kalıyordu; Th pikselleri
// hiç aday olmadığı için kubbe opak kafadan kopuk görünüp atlanıyordu (Th içi 1624 px).
// Th içinde zemin şablon pikseli değil (orada şablon saçı var), çevreden tahmin edilen
// gerçek zemin (bg) kullanılır; bg yoksa piksel aday olmaz. Diğer kapılar aynı.
let HALO_IN_TPL = true;
// OPAK SAYILAN PUS (2026-11-19, 6a02687c c8): kafa tepesinde gri yarı saydam kubbe
// segmentasyonda %100 saç → opak kafa (O) sayılıyor, hiçbir kural dokunmuyordu
// (dedektör eşiği 0'da bile). Renk mesafesi ayırmıyor (OPAQUE_FAR_FROM_U notu: güneş
// alan gerçek saç da uzak). Ayrım: güneş alan saç kendi renginin PARLATILMIŞI (k·U),
// pus ise kullanıcı saçı ile zeminin KARIŞIMI (α·U+(1−α)·bg; c8: 97/96/97, U 75/62/53,
// zemin 179/198/212). Kaş üstü, opak kafa içinde, zemin tahmini var ve saçtan belirgin
// farklı, karışım parlatmadan HAZE_RATIO kat iyi açıklıyor, bileşen kalın ve büyük,
// kafa dışına değiyor → opaklıktan çıkar, iz olur (bukle kenarı koruması da aşılır:
// o yalnız ince bant). Kapatmak için false.
let HAZE_ON = true;
let HAZE_DEBUG = null;
const HAZE_ALPHA_LO = 0.15;
const HAZE_ALPHA_HI = 0.85;
const HAZE_BG_OD_MIN = 40;
const HAZE_RATIO = 0.5;
const HAZE_MIN_AREA_FACE2 = 0.02;
// Kalınlık (bileşen içi en büyük uzaklık / yüz eni), 58 karelik yerel tarama: gerçek
// kubbe 6a02687c c8 0.082, 156fa173 c4 0.076, c5 0.055; saç kenarı şeridi 0.026-0.036
// (9 kare, bukleler korunuyordu ama gerçek kenara dokunuyordu); sınırda 0.043/0.049.
// 0.05: yalnız kalın kubbe.
let HAZE_THICK_FACE = 0.05;

/** k·U ile en iyi ölçeklenmiş saç rengine artık uzaklık. SAF. */
function scaleResid(o, U) {
  const uu = U[0] * U[0] + U[1] * U[1] + U[2] * U[2] || 1;
  const k = (o[0] * U[0] + o[1] * U[1] + o[2] * U[2]) / uu;
  return Math.hypot(o[0] - k * U[0], o[1] - k * U[1], o[2] - k * U[2]);
}

/**
 * Opak kafa içindeki pus maskesi (bkz. HAZE_*). SAF. Döner Uint8Array (n*n).
 */
function hazeMask({ n, O, Ho, userSkin, oF, U, bg, browO, fwk, distanceTo }) {
  const m = new Uint8Array(n * n);
  if (!U || !bg) return m;
  const lU = (U[0] + U[1] + U[2]) / 3;
  for (let i = 0; i < n * n; i++) {
    // Opak kafa YA DA çıktının kafa maskesi (kubbenin üstü O dışında ama saç sınıfında).
    if (!(O[i] || Ho.head[i]) || userSkin[i] || Ho.inOval[i] || !bg.ok[i] || Math.floor(i / n) >= browO) continue;
    const j = i * 3, o = [oF[j], oF[j + 1], oF[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]];
    if (Math.hypot(b[0] - U[0], b[1] - U[1], b[2] - U[2]) < HAZE_BG_OD_MIN) continue;
    if ((o[0] + o[1] + o[2]) / 3 < lU + RIM_LIGHTER) continue;
    const f = mixFit(o, U, b);
    if (f.a < HAZE_ALPHA_LO || f.a > HAZE_ALPHA_HI) continue;
    if (!(f.resid + RESID_ABS < HAZE_RATIO * (scaleResid(o, U) + RESID_ABS))) continue;
    m[i] = 1;
  }
  // Bileşenler: büyük, kalın, kafa dışına (O ve kullanıcı kafası dışı) değen.
  const inner = distanceTo(Uint8Array.from(m, (v) => (v ? 0 : 1)), n, n);
  const out = new Uint8Array(n * n), seen = new Uint8Array(n * n);
  const minA = HAZE_MIN_AREA_FACE2 * fwk * fwk, thick = HAZE_THICK_FACE * fwk;
  for (let s0 = 0; s0 < n * n; s0++) {
    if (!m[s0] || seen[s0]) continue;
    const comp = [s0];
    seen[s0] = 1;
    let maxIn = 0, touchesOut = false;
    for (let h = 0; h < comp.length; h++) {
      const k = comp[h], x = k % n, y = (k - x) / n;
      if (inner[k] > maxIn) maxIn = inner[k];
      for (const q of [x > 0 ? k - 1 : -1, x < n - 1 ? k + 1 : -1, y > 0 ? k - n : -1, y < n - 1 ? k + n : -1]) {
        if (q < 0) continue;
        if (!m[q] && !O[q] && !Ho.head[q]) touchesOut = true;
        if (m[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    if (HAZE_DEBUG) HAZE_DEBUG.push({ area: comp.length / (fwk * fwk), thick: maxIn / fwk, touchesOut });
    if (comp.length < minA || maxIn < thick || !touchesOut) continue;
    for (const k of comp) out[k] = 1;
  }
  return out;
}

/**
 * Hale maskesi. O: opak kafa, Th: şablon kafası, userSkin: korunan deri,
 * oF/tF: yumuşatılmış çıktı/şablon kesiti, U: kullanıcı saç rengi, po: çıktı
 * 68 noktası, Od: O'ya uzaklık. SAF.
 */
function haloMask({ n, O, Od, Th, userSkin, Po, CLASSES, oF, tF, U, po, fwk, bg = null }) {
  const out = new Uint8Array(n * n);
  if (!U) return out;
  const eyeY = po.slice(36, 48).reduce((a, p) => a + p.y, 0) / 12;
  const yMax = eyeY + HALO_EYE_BELOW_FACE * fwk;
  const m = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (O[i] || userSkin[i] || Math.floor(i / n) > yMax) continue;
    // Şablon kafası içinde zemin = çevreden tahmin (bkz. HALO_IN_TPL); değilse şablon pikseli.
    const inT = !!Th[i];
    if (inT && !(HALO_IN_TPL && bg && bg.ok[i])) continue;
    if (Od[i] < 1.5 || Od[i] > HALO_BAND_FACE * fwk) continue;
    if (Po[CLASSES.clothes][i] >= 0.5 || Po[CLASSES.bodySkin][i] >= 0.5) continue;
    const j = i * 3;
    const B = inT ? [bg.v[j], bg.v[j + 1], bg.v[j + 2]] : [tF[j], tF[j + 1], tF[j + 2]];
    const f = mixFit([oF[j], oF[j + 1], oF[j + 2]], U, B);
    if (f.od < HALO_OD_MIN || f.a < HALO_ALPHA_LO || f.a > HALO_ALPHA_HI || f.resid > 0.35 * f.od + RESID_ABS) continue;
    m[i] = 1;
  }
  // Opak kafaya bitişik bileşenler, alanı yeterli olanlar.
  const seed = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (m[i] && Od[i] <= 2.5) seed[i] = 1;
  const att = connected(m, seed, n, n);
  const seen = new Uint8Array(n * n), minA = HALO_MIN_AREA_FACE2 * fwk * fwk;
  for (let i = 0; i < n * n; i++) {
    if (!att[i] || seen[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let h = 0; h < comp.length; h++) {
      const k = comp[h], x = k % n, y = (k - x) / n;
      for (const q of [x > 0 ? k - 1 : -1, x < n - 1 ? k + 1 : -1, y > 0 ? k - n : -1, y < n - 1 ? k + n : -1]) {
        if (q >= 0 && att[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    if (comp.length < minA) continue;
    let sure = 0;
    for (const k of comp) if (Po[CLASSES.hair][k] >= HALO_HAIR_SURE) sure++;
    if (sure >= HALO_HAIR_SHARE * comp.length) continue;
    for (const k of comp) out[k] = 1;
  }
  return out;
}

function boxBlur3(src, W, H, r) {
  const tmp = new Float32Array(W * H * 3), out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[(y * W + xx) * 3 + c]; n++; } }
        tmp[(y * W + x) * 3 + c] = s / n;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[(yy * W + x) * 3 + c]; n++; } }
        out[(y * W + x) * 3 + c] = s / n;
      }
    }
  }
  return out;
}

/** Tek kanallı dizinin kutu toplamı (yarıçap r, kenarda kırpılır), integral görüntüyle. SAF. */
function boxSum(src, W, H, r) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
    }
  }
  return out;
}

/** Çıktı-şablon yerel normalize çapraz korelasyonu (parlaklık) ve şablonun yerel sapması. SAF. */
function localNcc(oC, tC, n, r) {
  const N = n * n, lo = new Float32Array(N), lt = new Float32Array(N), oo = new Float32Array(N), tt = new Float32Array(N), ot = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (oC[i * 3] + oC[i * 3 + 1] + oC[i * 3 + 2]) / 3, b = (tC[i * 3] + tC[i * 3 + 1] + tC[i * 3 + 2]) / 3;
    lo[i] = a; lt[i] = b; oo[i] = a * a; tt[i] = b * b; ot[i] = a * b;
  }
  const [so, st, soo, stt, sot, c] = [lo, lt, oo, tt, ot, new Float32Array(N).fill(1)].map((m) => boxSum(m, n, n, r));
  const ncc = new Float32Array(N), tsd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = c[i], mo = so[i] / k, mt = st[i] / k;
    const vo = soo[i] / k - mo * mo, vt = stt[i] / k - mt * mt, cv = sot[i] / k - mo * mt;
    tsd[i] = Math.sqrt(Math.max(0, vt));
    ncc[i] = vo > 4 && vt > 4 ? cv / Math.sqrt(vo * vt) : 0;
  }
  return { ncc, tsd };
}

/**
 * Ağırlıklı ortalama (normalize evrişim), artan pencerelerde: her piksel için
 * pencerenin en az cover payı ağırlıklıysa o ölçünün ortalaması. rgb: 3 kanal,
 * w: ağırlık (0/1). Dönüş { v: Float32Array(3N), ok: Uint8Array(N) }. SAF.
 */
function maskedMean(rgb, w, W, H, radii, cover) {
  const N = W * H;
  const v = new Float32Array(N * 3), ok = new Uint8Array(N);
  const ch = [0, 1, 2].map((c) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = rgb[i * 3 + c] * w[i]; return a; });
  for (const r of radii) {
    const den = boxSum(w, W, H, r);
    const num = ch.map((a) => boxSum(a, W, H, r));
    const area = (2 * r + 1) * (2 * r + 1);
    for (let i = 0; i < N; i++) {
      if (ok[i] || den[i] < cover * area || den[i] <= 0) continue;
      for (let c = 0; c < 3; c++) v[i * 3 + c] = num[c][i] / den[i];
      ok[i] = 1;
    }
  }
  return { v, ok };
}

/** o'nun b ile ref karışımı olarak artığı ve oranı. SAF. */
function mixFit(o, ref, b) {
  const d0 = ref[0] - b[0], d1 = ref[1] - b[1], d2 = ref[2] - b[2];
  const c2 = d0 * d0 + d1 * d1 + d2 * d2;
  const e0 = o[0] - b[0], e1 = o[1] - b[1], e2 = o[2] - b[2];
  const a = c2 > 1e-6 ? (e0 * d0 + e1 * d1 + e2 * d2) / c2 : 0;
  const ac = Math.max(0, Math.min(1, a));
  const r0 = e0 - ac * d0, r1 = e1 - ac * d1, r2 = e2 - ac * d2;
  return { a, c2, resid: Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2), od: Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2) };
}

/**
 * Yarı saydam şablon izi, tek piksel. o/t/b: RGB üçlüleri (çıktı, şablon,
 * zemin); u: kullanıcının yakındaki kafa rengi (kenarda) ya da null.
 * Dönüş α ya da null (iz değil). SAF.
 */
function ghostAlpha(o, t, b, u = null) {
  const ft = mixFit(o, t, b);
  if (ft.c2 < CONTRAST_MIN * CONTRAST_MIN) return null;
  if (ft.a < ALPHA_LO || ft.a > ALPHA_HI) return null;
  if (ft.resid > RESID_FRAC * ft.od + RESID_ABS) return null;
  if (u) {
    const fu = mixFit(o, u, b);
    if (!(ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS))) return null;
  }
  return ft.a;
}

/** İşaretli baş dönüşü (68 nokta): burun ucunun dış göz köşeleri arasındaki yeri. SAF. */
function signedYaw(P) {
  const span = P[45].x - P[36].x;
  if (!(Math.abs(span) > 1e-6)) return 0;
  return Math.max(-1, Math.min(1, ((P[30].x - P[36].x) / span - 0.5) * 2));
}

/** Göz ortası (iki göz merkezinin ortası) ve çene ucu. SAF. */
function eyeChin(P) {
  const avg = (a, b) => { let x = 0, y = 0; for (let k = a; k <= b; k++) { x += P[k].x; y += P[k].y; } return { x: x / (b - a + 1), y: y / (b - a + 1) }; };
  const l = avg(36, 41), r = avg(42, 47);
  return { E: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }, C: { x: P[8].x, y: P[8].y } };
}

/**
 * src (srcN×srcN) maskesini, (Es,Cs) → (Ed,Cd) benzerlik dönüşümüyle dst
 * (n×n) uzayına taşır (ters eşleme, en yakın komşu). SAF.
 */
function mapMask(src, srcN, Es, Cs, Ed, Cd, n) {
  const vs = { x: Cs.x - Es.x, y: Cs.y - Es.y }, vd = { x: Cd.x - Ed.x, y: Cd.y - Ed.y };
  const ls = Math.hypot(vs.x, vs.y), ld = Math.hypot(vd.x, vd.y);
  const out = new Uint8Array(n * n);
  if (!(ls > 1e-6) || !(ld > 1e-6)) return out;
  const sc = ls / ld;
  const ang = Math.atan2(vs.y, vs.x) - Math.atan2(vd.y, vd.x);
  const ca = Math.cos(ang) * sc, sa = Math.sin(ang) * sc;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const qx = x - Ed.x, qy = y - Ed.y;
      const px = Math.round(Es.x + ca * qx - sa * qy), py = Math.round(Es.y + sa * qx + ca * qy);
      if (px >= 0 && py >= 0 && px < srcN && py < srcN && src[py * srcN + px]) out[y * n + x] = 1;
    }
  }
  return out;
}

/** Kafa maskesi (n×n uzayı): sınıflar ∪ yüz ovali, ovale bağlı, çene altı hariç. */
function headMask(P, pts, n, CLASSES, faceOval, inPolygon) {
  const oval = faceOval(pts);
  const inOval = new Uint8Array(n * n);
  const xs = oval.map((p) => p.x), ys = oval.map((p) => p.y);
  for (let y = clampI(Math.min(...ys), 0, n - 1); y <= clampI(Math.max(...ys), 0, n - 1); y++) {
    for (let x = clampI(Math.min(...xs), 0, n - 1); x <= clampI(Math.max(...xs), 0, n - 1); x++) {
      if (inPolygon(oval, x, y)) inOval[y * n + x] = 1;
    }
  }
  const chin = pts[8].y;
  const brow = Math.min(...pts.slice(17, 27).map((p) => p.y));
  const hf = Math.max(1, chin - brow);
  const cand = new Uint8Array(n * n);
  const hat = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const y = Math.floor(i / n);
    if (inOval[i]) { cand[i] = 1; continue; }
    if (y > chin + 0.05 * hf) continue;
    if (P[CLASSES.bodySkin][i] >= SEG_MIN || P[CLASSES.clothes][i] >= SEG_MIN) continue;
    const isHat = P[CLASSES.others][i] >= SEG_MIN && y < brow + 0.2 * hf;
    if (isHat) hat[i] = 1;
    if (P[CLASSES.hair][i] >= SEG_MIN || P[CLASSES.faceSkin][i] >= SEG_MIN || isHat) cand[i] = 1;
  }
  const head = connected(cand, inOval, n, n);
  for (let i = 0; i < n * n; i++) if (!head[i]) hat[i] = 0;
  return { head, inOval, hat };
}

/**
 * Modelin koruduğu şablon şapkası (bkz. HAT_KEPT_SHARE). Şablon şapka maskesi kaş
 * çizgisinde kesilir (gözlük de 'others'; bkz. hatDetect GÖZLÜK HARİÇ). SAF.
 * Döner { share, area (yüz²), kept, core, keep } — core: şablon şapkası ∪ çıktının
 * kaş üstü opak 'others'ı ve ona bağlı 'others' (yüz ovali dışında, çene üstü);
 * keep: core + kenar bandı.
 * Kaş altına iniş (2026-11-06, 7e04933e c1): berenin ense tarafındaki kenarı kaş
 * çizgisinin altında; yalnız kaş üstü korununca iz detektörü sıcak eklemesi kenarı
 * tam kaş satırında yatay bir çizgiyle kesti. Gözlük yüz ovalinin içinde kalır.
 */
function keptHatMask({ Ht, Ho, Po, CLASSES, pt, po, n, fwk, distanceTo }) {
  const browT = Math.min(...pt.slice(17, 27).map((p) => p.y));
  const browO = Math.min(...po.slice(17, 27).map((p) => p.y));
  let tp = 0, hit = 0;
  for (let i = 0; i < n * n; i++) {
    if (!Ht.hat[i] || Math.floor(i / n) >= browT) continue;
    tp++;
    if (Po[CLASSES.others][i] >= SEG_MIN) hit++;
  }
  const area = tp / (fwk * fwk);
  const share = tp ? hit / tp : 0;
  const kept = area >= HAT_MIN_FACE2 && share >= HAT_KEPT_SHARE;
  if (!kept) return { share, area, kept, core: null, keep: null };
  const core = new Uint8Array(n * n);
  const seedO = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const y = Math.floor(i / n);
    if (Ht.hat[i] && y < browT) core[i] = 1;
    if (Ho.hat[i] && y < browO) { core[i] = 1; seedO[i] = 1; }
  }
  const chinO = po[8].y;
  const down = growFrom(seedO, (i) => Po[CLASSES.others][i] >= OUT_HAT_MIN && !Ho.inOval[i] && Math.floor(i / n) <= chinO, 4 * n, n);
  for (let i = 0; i < n * n; i++) if (down[i]) core[i] = 1;
  return { share, area, kept, core, keep: dilate(core, n, n, HAT_KEEP_BAND_FACE * fwk, distanceTo) };
}

const faceWidth = (lm) => Math.max(lm.box.width, Math.hypot(lm.pts[0].x - lm.pts[16].x, lm.pts[0].y - lm.pts[16].y));

/**
 * ŞAPKA KORUNDU MU (2026-11-19, kapı için): cleanTemplateGhost'un keptHatMask
 * ölçüsünün aynısı, temizlik yapmadan. Şablonun kaş üstü şapka maskesinin çıktıda
 * opak 'others' olan payı. Aynı bereli şablonda 8 işte: korunanlar 0.85/0.90,
 * düşenler 0.00 (6a02687c c1: bere düştü, model kafayı bere hacmine uzattı).
 * Döner { share, area, kept } | null (yüz yok).
 */
async function measureHatKept(outputBuf, templateBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { faceOval, inPolygon } = require("./headSurround");
  const { distanceTo } = require("./headWarp")._testables;
  const o = await rawOf(outputBuf);
  const { W, H } = o;
  const t = await rawOf(templateBuf, W, H);
  const oJ = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const tJ = await sharp(t.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(oJ)) || (await faceLandmarks(oJ, 0.1));
  const lt = (await faceLandmarks(tJ)) || (await faceLandmarks(tJ, 0.1));
  if (!lo || !lt) return null;
  const fw = Math.max(faceWidth(lo), faceWidth(lt));
  const cxOf = (lm) => lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const yTop = Math.min(lo.box.y, lt.box.y) - CROP_UP_FACE * fw;
  const yBot = Math.max(lo.pts[8].y, lt.pts[8].y) + CROP_DOWN_FACE * fw;
  const side = Math.min(W, H, Math.max(Math.round(CROP_FACE * fw), Math.round(yBot - yTop)));
  if (side < 48) return null;
  const left = clampI((cxOf(lo) + cxOf(lt)) / 2 - side / 2, 0, W - side);
  const top = clampI((yTop + yBot) / 2 - side / 2, 0, H - side);
  const n = Math.min(side, WORK_MAX);
  const k = n / side;
  const [oC, tC] = await Promise.all([cropSquare(o.data, W, H, left, top, side, n), cropSquare(t.data, W, H, left, top, side, n)]);
  const toWork = (lm) => lm.pts.map((p) => ({ x: (p.x - left) * k, y: (p.y - top) * k }));
  const po = toWork(lo), pt = toWork(lt);
  const [Po, Pt] = await Promise.all([classProbs(oC, n, n), classProbs(tC, n, n)]);
  const Ht = headMask(Pt, pt, n, CLASSES, faceOval, inPolygon);
  const Ho = headMask(Po, po, n, CLASSES, faceOval, inPolygon);
  const hk = keptHatMask({ Ht, Ho, Po, CLASSES, pt, po, n, fwk: fw * k, distanceTo });
  return { share: hk.share, area: hk.area, kept: hk.kept };
}

/**
 * Selfie'nin kafa profili: yüz çevresi kare kesitte kafa maskesi (saç + yüz +
 * şapka, yüze bağlı), göz ortası, çene ucu, işaretli baş dönüşü. null: yüz yok.
 */
async function headProfileOf(buf) {
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { faceOval, inPolygon } = require("./headSurround");
  const s = await rawOf(buf);
  const J = await sharp(s.data, { raw: { width: s.W, height: s.H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const lm = (await faceLandmarks(J)) || (await faceLandmarks(J, 0.1));
  if (!lm) return null;
  const fw = faceWidth(lm);
  const cx = lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const side = Math.min(s.W, s.H, Math.round(PROFILE_CROP_FACE * fw));
  const left = clampI(cx - side / 2, 0, s.W - side);
  const top = clampI(lm.box.y + lm.box.height / 2 - 0.62 * side, 0, s.H - side);
  const n = PROFILE_N, k = n / side;
  const crop = await cropSquare(s.data, s.W, s.H, left, top, side, n);
  const P = await classProbs(crop, n, n);
  const pts = lm.pts.map((p) => ({ x: (p.x - left) * k, y: (p.y - top) * k }));
  const { head } = headMask(P, pts, n, CLASSES, faceOval, inPolygon);
  // 3B baş pozu (derece, yalnız yüz ağı bulunduysa): selfie seçimi ve pay.
  let pose3d = null;
  try {
    const p3 = await require("./headPose3d").headPose3dOf(J, { loose: false });
    if (p3 && p3.src === "mesh") pose3d = { yaw: p3.yaw, pitch: p3.pitch };
  } catch (e) {
    console.error("Selfie 3B pozu ölçülemedi (68 noktalı yön kullanılır):", e.message || e);
  }
  return { yaw: signedYaw(lm.pts), n, mask: head, ...eyeChin(pts), pose3d };
}

/**
 * Çıktıya en uygun selfie profili ve beklenen kafa payı (yüz genişliği). 3B
 * poz (ağ) iki tarafta da varsa yaw+pitch farkı (derece), yoksa eski 68
 * noktalı yaw farkı. SAF.
 */
function pickProfile(profiles, yawO, pose3dO) {
  const d3 = (p) => (p && p.pose3d && pose3dO ? Math.hypot(p.pose3d.yaw - pose3dO.yaw, p.pose3d.pitch - pose3dO.pitch) : null);
  let prof = null, dBest = null;
  if (pose3dO) {
    for (const p of profiles || []) {
      const d = d3(p);
      if (d != null && (dBest == null || d < dBest)) { prof = p; dBest = d; }
    }
  }
  if (prof) return { prof, deg: dBest, margin: Math.min(EXP_MARGIN_MAX, EXP_MARGIN_FACE + EXP_MARGIN_PER_DEG * Math.max(0, dBest - EXP_MARGIN_DEAD_DEG)) };
  for (const p of profiles || []) if (p && (!prof || Math.abs(p.yaw - yawO) < Math.abs(prof.yaw - yawO))) prof = p;
  return prof ? { prof, deg: null, margin: EXP_MARGIN_FACE + EXP_MARGIN_PER_YAW * Math.abs(prof.yaw - yawO) } : null;
}

// İZ BÜYÜTME (2026-11-04): selfie kafa çizgisi + pay, kullanıcının gerçek saç
// sınırından geniş kalabiliyor; o şeritte kalan şablon izi (80fc7ec4 c0: koyu
// saçın hemen üstünde bej bant + kubbenin alt kenarı) "beklenen kafa" sayılıp
// korunuyordu. Çok etiketli skinSeg'de gerçek saç arka plan≈0, iz saç≈1 VE
// arka plan≈1 (bkz. ghost-hair-is-background-class; 80f c0 sütun ölçümü: koyu
// saç bg 0.00, kubbe/bant bg 1.00). İz, beklenen kafanın içine yalnız arka
// plan sınıfı yüksek, deri olmayan, kaş üstü ve yüz ovali dışındaki
// piksellerden, dışarıdaki ize BAĞLI olarak ve sınırlı derinlikte ilerler.
const GROW_BG_MIN = 0.8;
const GROW_SKIN_MAX = 0.35;
const GROW_DEPTH_FACE = 0.15;
// İZ KENARI (2026-11-04, 80fc7ec4 c0 "saçın üstünde açık kenar kalmamalı"):
// büyütmeden sonra kullanıcının koyu saçının üst kenarında 5-8 px'lik açık
// şerit kalıyordu (113,90,76; kullanıcı saçı 74,56,45; zemin 95,94,89) — bej
// bandın saç sınıfında kalan ucu (arka plan 0.13). İze BİTİŞİK, kullanıcının
// saç renginden belirgin farklı saç pikselleri de iz sayılır; yalnız ince
// bir şerit (derinlik sınırı) — saçın içine ilerlemez.
const RIM_DIFF = 35;
const RIM_DEPTH_FACE = 0.06;
// Kenar şeridi kullanıcının saçından AÇIK olmalı (2026-11-04 v9, 80f c0 "sağ üst
// silinmiş"): renk uzaklığı iki yönlü olunca gölgedeki neredeyse siyah gerçek
// saç (35,26,21; arka plan sınıfı 0.00; kullanıcı ortancası 71,58,48) da kenar
// sayılıp siliniyordu. İz kenarı her zaman zeminle/şablon saçıyla karışım =
// açık; koyu piksel asla kenar değildir.
const RIM_LIGHTER = 12;
// Yüz ovali (yer işaretinden: kaş + 0.4·(çene−kaş)) alçak saç çizgisinde saçın
// alt kısmını da kapsıyor; 80f c0'da şablon alnı izi (132,118,105; saç=1, yüz
// derisi=0, arka plan 0.3-0.9) oval içinde kaldığı için korunuyordu. Oval
// içinde kenar kuralı yalnız arka plan sınıfı bu eşikten yüksek saç pikseline
// uygulanır: kullanıcının gerçek alnı yüz derisi=1, gerçek saçı arka plan≈0.
const RIM_OVAL_BG_MIN = 0.2;
function growFrom(seed, ok, maxD, n) {
  const out = new Uint8Array(n * n);
  const depth = new Float32Array(n * n).fill(Infinity);
  const q = [];
  for (let i = 0; i < n * n; i++) if (seed[i]) { depth[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % n, y = (i - x) / n, d = depth[i] + 1;
    if (d > maxD) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
      const j = Y * n + X;
      if (depth[j] <= d || seed[j] || !ok(j)) continue;
      depth[j] = d; out[j] = 1; q.push(j);
    }
  }
  return out;
}
function growGhostIntoExpected(cand, { Th, Ex, userSkin, inOval, Po, CLASSES, n, browO, fwk }) {
  // Renk şartı YOK (denendi 2026-11-04): kubbenin koyu kısmı kullanıcı saç
  // rengine yakın (80f c0 61,51,44) — renkle durdurunca tepede tutam kaldı.
  // Gerçek saç arka plan≈0 olduğu için bu kurala zaten girmez (a4433 c6 ense).
  const ok = (i) => Th[i] && Ex[i] && !userSkin[i] && !inOval[i] && Math.floor(i / n) < browO &&
    Po[CLASSES.background][i] >= GROW_BG_MIN && Po[CLASSES.faceSkin][i] < GROW_SKIN_MAX && Po[CLASSES.bodySkin][i] < GROW_SKIN_MAX;
  return growFrom(cand, ok, GROW_DEPTH_FACE * fwk, n);
}
function growGhostRim(seed, { Th, Ex, userSkin, inOval, Po, CLASSES, n, browO, fwk, oF, U }) {
  if (!U) return new Uint8Array(n * n);
  const ok = (i) => {
    if (!(Th[i] && Ex[i] && !userSkin[i] && Math.floor(i / n) < browO)) return false;
    if (inOval[i] && Po[CLASSES.background][i] < RIM_OVAL_BG_MIN) return false;
    if (Po[CLASSES.faceSkin][i] >= GROW_SKIN_MAX || Po[CLASSES.bodySkin][i] >= GROW_SKIN_MAX) return false;
    const j = i * 3;
    if ((oF[j] + oF[j + 1] + oF[j + 2]) / 3 < lU + RIM_LIGHTER) return false;
    return Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]) > RIM_DIFF;
  };
  const lU = (U[0] + U[1] + U[2]) / 3;
  return growFrom(seed, ok, RIM_DEPTH_FACE * fwk, n);
}
// GERÇEK SAÇ KORUMASI (2026-11-04 toplu deneme, a4433ad1 c6 / 017dbe34 c6 aynı
// şablon, "kafanın arkası kesildi" — eski sürümde de): beklenen kafa (selfie
// çizgisi) çıktıdaki gerçek kafadan küçük kalınca (model kafayı medyan %8.5
// büyük çiziyor; dönük başta selfie çizgisi enseyi kapsamıyor) kafanın
// arkasındaki OPAK gerçek saç "kafa sınıfı, beklenen kafanın dışında" diye iz
// sayılıp siliniyordu. Ölçüm (a4433 c6 delik pikselleri): saç=1.0, arka
// plan=0.0, renk 20-29 (gölgedeki ense; kullanıcı saç ortancası 52 — renk
// uzaklığı ve karışım testi bu koyu saçta yanılıyor). 80f c0 kubbesi ise
// saç=1 VE arka plan=1; kenar şeridi kullanıcı saçından açık. Kural: çıktının
// kafasına bağlı, skinSeg'in EMİN olduğu saç (saç yüksek, arka plan düşük) ve
// kullanıcının saçından belirgin AÇIK olmayan piksel korunur. Şablonun açık
// renkli saçı (c2e8eff1 c0 sarı perçem), kubbe ve açık kenar korunmaz.
const PROTECT_HAIR_MIN = 0.5;
const PROTECT_HAIR_BG_MAX = 0.3;
const PROTECT_HAIR_LIGHTER = 15;
// Derinlik pratikte sınırsız (şablon kafası alanı içinde; 2026-11-04 v11 toplu
// deneme a4433ad1 c1): dönük başta selfie çizgisi enseyi hiç kapsamıyor, 0.4·yüz
// sınırı kafanın arkasındaki opak saçı (saç=1, arka plan=0, 30-42 gri) yarıda
// bırakıp kesiyordu. Kural "kafanın arkası/tepesi asla kesilmez" önceliklidir.
const PROTECT_HAIR_DEPTH_FACE = 3;

// KULLANICININ OPAK SAÇI (2026-11-12, 41589067 c4, kullanıcı: "saçın arka kısmında
// siliklik, saç eksilmesi ve leke"): gökyüzüne karşı kıvırcık arka saçın dış
// bukleleri skinSeg'de saç ≈ 0-0.3 / arka plan ≈ 1 (selfie çizgisi dışında, opak
// kafa O'ya girmiyor). İz şeridi (bukle uçları + gök karışımı) silinince dolgu
// deliği (Gd) ve "kırıntı" bileşimi izin 0.08·yüz yakınındaki GERÇEK koyu bukleleri
// de zeminle değiştirdi; kesik kenar sonra kafa küçültmede gökte koyu lekeye döndü.
// Segmentasyon payı ayırmıyor (42 bileşen kör etiket: gerçek iz 1108a c2 kesin
// saç 0.78, c4 gerçek saç 0.15). Ayıran: piksel kullanıcının saç RENGİNDE (opak)
// ve zemin o renkten belirgin farklı (opaklık ölçülebilir) — yarı saydam iz zeminle
// karışır, açık kalır. Koyu zeminde (1109 c7, 1106 c5: iz de saç renginde) zemin
// karşıtlığı yok → koruma devreye girmez. Kafaya (keep/O) bağlı olmalı.
const USER_OPAQUE = {
  ON: true,
  NEAR_U: 35, // piksel ↔ kullanıcı saç rengi (blursuz ya da yumuşatılmış, küçüğü)
  BG_CONTRAST: 60, // yerel zemin ↔ kullanıcı saç rengi en az
  DEPTH_FACE: 0.15, // kafadan en çok bu kadar uzağa yayılır
  EDGE_FACE: 0.008, // korunan bukle kenarına ince pay (kenar yumuşaması)
  // Bukle ucu: opak bukleye (ya da opak kafaya) en çok bu kadar uzaklıkta, "kullanıcı
  // saçı + zemin" karışımına sıkı uyan yarı saydam piksel kullanıcınındır — şablon
  // saçı da koyuysa (c4) şablon karışımı da uyar; bitişik bantta belirsizlik
  // kullanıcı lehine. Gerçek iz kubbe/tutamı 0.07·yüzden kalın (STRONG_FACE).
  FRINGE_FACE: 0.03,
  FRINGE_A_LO: 0.15,
  FRINGE_RESID_FRAC: 0.2,
  FRINGE_RESID_ABS: 4,
};
function userOpaqueHair({ seed, O, Th, n, fwk, oC, oF, bg, U, distanceTo }) {
  const s = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if ((seed && seed[i]) || (O && O[i])) s[i] = 1;
  const d3 = (a, j) => Math.hypot(a[j] - U[0], a[j + 1] - U[1], a[j + 2] - U[2]);
  const contrast = (j) => Math.hypot(bg.v[j] - U[0], bg.v[j + 1] - U[1], bg.v[j + 2] - U[2]) >= USER_OPAQUE.BG_CONTRAST;
  const ok = (i) => {
    if (!Th[i] || !bg.ok[i]) return false;
    const j = i * 3;
    if (!contrast(j)) return false;
    return Math.min(d3(oC, j), d3(oF, j)) <= USER_OPAQUE.NEAR_U;
  };
  const g = growFrom(s, ok, USER_OPAQUE.DEPTH_FACE * fwk, n);
  for (let i = 0; i < n * n; i++) if (s[i]) g[i] = 0; // yalnız yeni eklenen bukleler
  const r = USER_OPAQUE.EDGE_FACE * fwk;
  const out = r >= 1 ? dilate(g, n, n, r, distanceTo) : g;
  if (USER_OPAQUE.FRINGE_FACE > 0) {
    // Uçlar yalnız YENİ korunan bukleden büyür (opak kafa O'nun kenarı zaten
    // protectUserFringe ile sınanıyor; O'dan da büyütmek izsiz karede bile iz
    // kenarını kullanıcıya verirdi).
    const fs = new Uint8Array(n * n);
    let any = false;
    for (let i = 0; i < n * n; i++) if (g[i]) { fs[i] = 1; any = true; }
    if (any) {
      const okF = (i) => {
        if (!Th[i] || !bg.ok[i]) return false;
        const j = i * 3;
        if (!contrast(j)) return false;
        const o = [oC[j], oC[j + 1], oC[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]];
        const fu = mixFit(o, U, b);
        if (fu.a < USER_OPAQUE.FRINGE_A_LO || fu.a > 1.1) return false;
        return fu.resid <= USER_OPAQUE.FRINGE_RESID_FRAC * fu.od + USER_OPAQUE.FRINGE_RESID_ABS;
      };
      const f = growFrom(fs, okF, USER_OPAQUE.FRINGE_FACE * fwk, n);
      for (let i = 0; i < n * n; i++) if (f[i]) out[i] = 1;
    }
  }
  return out;
}
function protectRealHair({ Th, Ex, Ho, keep, Po, CLASSES, n, fwk, oF, U }) {
  if (!U) return new Uint8Array(n * n);
  const lU = (U[0] + U[1] + U[2]) / 3;
  const seed = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if ((Ex[i] && Ho[i]) || keep[i]) seed[i] = 1;
  const ok = (i) => {
    if (!Th[i] || Ex[i]) return false;
    if (Po[CLASSES.hair][i] < PROTECT_HAIR_MIN || Po[CLASSES.background][i] >= PROTECT_HAIR_BG_MAX) return false;
    const j = i * 3;
    return (oF[j] + oF[j + 1] + oF[j + 2]) / 3 <= lU + PROTECT_HAIR_LIGHTER;
  };
  return growFrom(seed, ok, PROTECT_HAIR_DEPTH_FACE * fwk, n);
}

// KULLANICININ BUKLE KENARI (2026-11-05 v12 toplu deneme, b932fd71 c0 / 7e04933e c7
// "kıvırcık saç kırpıldı"): gökyüzüne karşı yarı saydam gerçek bukleler skinSeg'de
// saç=1 VE arka plan=1 — hayaletle aynı imza; selfie çizgisi dışında kaldıkları
// için siliniyordu. Ayıran renk: bukle = α·(kullanıcı saçı) + (1−α)·zemin (ölçüm
// 105,91,78; U 20,19,16; zemin ≈220,195,155 → artık 4, uzaklık 154), şablon izi
// şablonun saç rengiyle karışır. Kafaya bağlı, ince bantta, kullanıcı rengiyle
// SIKI uyan (artık ≤ 0.2·uzaklık + 3) ve şablon renginden belirgin iyi açıklanan
// yarı saydam piksel korunur. 80f c0 açık uçları (94,73,61: artık/uzaklık 0.39)
// ve opak koyu kubbe (α≈1) bu kurala girmez.
const FRINGE_DEPTH_FACE = 0.12;
const FRINGE_A_LO = 0.08;
const FRINGE_A_HI = 0.9;
const FRINGE_RESID_FRAC = 0.2;
const FRINGE_RESID_ABS = 3;
const FRINGE_UB_MIN = 40;
const FRINGE_BETTER = 1.5;
function protectUserFringe({ seed, Th, n, fwk, oF, tF, bg, U }) {
  if (!U) return new Uint8Array(n * n);
  const ok = (i) => {
    if (!Th[i] || !bg.ok[i]) return false;
    const j = i * 3;
    const o = [oF[j], oF[j + 1], oF[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]];
    const fu = mixFit(o, U, b);
    if (fu.c2 < FRINGE_UB_MIN * FRINGE_UB_MIN || fu.a < FRINGE_A_LO || fu.a > FRINGE_A_HI) return false;
    if (fu.resid > FRINGE_RESID_FRAC * fu.od + FRINGE_RESID_ABS) return false;
    const ft = mixFit(o, [tF[j], tF[j + 1], tF[j + 2]], b);
    const ftRes = ft.a < 0 || ft.a > 1.2 ? Infinity : ft.resid;
    return ftRes + RESID_ABS > FRINGE_BETTER * (fu.resid + RESID_ABS);
  };
  return growFrom(seed, ok, FRINGE_DEPTH_FACE * fwk, n);
}

// OPAK KAFA (2026-11-05 v18 görsel inceleme: 134 karenin 35'inde yeni sürüm
// canlıdan kötü — izsiz karelerde bile saç kenarı/tepe/ense/kulaklık siliniyordu;
// dd788c00 c7, d87c25b4 c2, b932fd71 c0). Selfie çizgisi ±%10 hatalı ve "arka
// plan sınıfı yüksek" imzası gerçek saç kenarında da tutuyor. Yüze bağlı, arka
// plan sınıfı düşük saç / aksesuar (şapka, kulaklık) kullanıcının kafasıdır ve
// hiçbir aday kuralı ona dokunmaz (yalnız güçlü ize bitişik açık kenar kuralı).
// Şablon renginde opak saç (c2e8eff1 c0 sarı perçem: kullanıcı saçından çok
// uzak, şablona yakın) opak kafa sayılmaz.
const OPAQUE_BG_MAX = 0.5;
const OPAQUE_TPL_MARGIN = 20;
const OPAQUE_FAR_FROM_U = 90; // 40 denendi: ışık alan gerçek saç (dd788c00 c7 120,91,74; U 75,56,46) dışlanıp kesildi
// Opak kafaya bitişik bu bantta aday yalnız şablon rengi kullanıcı saçından
// belirgin daha iyi açıklıyorsa (EDGE_RATIO) iz kalır.
const EDGE_BAND_FACE = 0.04;
// Güçlü iz: aday bileşeni opak kafadan en az bu kadar uzağa taşmalı (hayalet
// kubbe/tutam 0.1-0.4·yüz; gerçek saç kenarı bandı ≤0.04·yüz).
const STRONG_FACE = 0.07;
// RENKÇE BELİRSİZ yarı saydam piksel (kullanıcı ve şablon saçı benzer renk):
// tek başına iz sayılmaz — opak nesne ile yarı saydam katman tek piksel renginden
// ayrılamıyor (d87c25b4 c2 duvara karşı gri kulaklık bandı "karışım" göründü,
// uzaklık kuralıyla silindi, büyütmeler enseyi yedi). Yalnız renkçe KESİN ize
// bağlıysa (histerezis) aynı hayaletin parçası sayılır (80fc7ec4 c0 kubbenin
// koyu kısmı; tek başına silinmeyince lekeler kaldı). Bedeli: kesin pikseli hiç
// olmayan, kullanıcı saçıyla aynı renkte iz kalabilir. İstisna: opak kafadan
// AMBIG_FAR uzakta ve şablonun dokusunu taşıyan (yerel korelasyon ≥ AMBIG_NCC_MIN)
// belirsiz piksel kesin iz sayılır (9c8f2cb5 c3).
const AMBIG_FAR_FACE = 0.05;
const AMBIG_NCC_MIN = 0.5;
const AMBIG_TSD_MIN = 8;
const AMBIG_NCC_R_FACE = 0.035;
function opaqueHead({ Ho, userSkin, Th, Po, CLASSES, n, oF, tF, U, personHead, bg }) {
  const seed = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (Ho.inOval[i] || userSkin[i]) seed[i] = 1;
  const ok = (i) => {
    if (!Th[i]) return false;
    // Renkle opaklık (kullanıcı rengine yakın = opak) DENENDİ, geri alındı (2026-11-05):
    // 80fc7ec4 c0 kubbesinin koyu kısmı (63,58,53) kullanıcı rengine yakın, tüm kubbe korundu.
    if (Po[CLASSES.background][i] >= OPAQUE_BG_MAX) return false;
    if (Po[CLASSES.hair][i] < PROTECT_HAIR_MIN && Po[CLASSES.others][i] < OUT_HAT_MIN) return false;
    if (U) {
      const j = i * 3;
      const dU = Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]);
      const dT = Math.hypot(oF[j] - tF[j], oF[j + 1] - tF[j + 1], oF[j + 2] - tF[j + 2]);
      if (dU > OPAQUE_FAR_FROM_U && dT + OPAQUE_TPL_MARGIN < dU) return false;
      // Kesin şablon karışımı + kullanıcı saçından açık = iz, opak kafa değil
      // (2026-11-05 v27, 80fc7ec4 c0 sol şakak üstü bej tutam 120-132,100-113,86-99;
      // arka plan sınıfı 0.25 olduğu için opak sayılıp korunuyordu).
      if (bg && bg.ok[i] && (oF[j] + oF[j + 1] + oF[j + 2]) / 3 >= (U[0] + U[1] + U[2]) / 3 + RIM_LIGHTER) {
        const o = [oF[j], oF[j + 1], oF[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]], t = [tF[j], tF[j + 1], tF[j + 2]];
        if (ghostAlpha(o, t, b) != null) {
          const fu = mixFit(o, U, b), ft = mixFit(o, t, b);
          if (ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS)) return false;
        }
      }
    }
    return true;
  };
  const g = growFrom(seed, ok, 4 * n, n);
  for (let i = 0; i < n * n; i++) if (seed[i]) g[i] = 1;
  return g;
}
// BÜYÜTME TOHUMU (2026-11-05 v26, 125 kare + ham etiketleri): büyütme/kenar
// kuralları küçük tohumdan (iz 0.001-0.02·yüz²) izsiz karelerde 0.2·yüz²'ye kadar
// yayılıp saç kenarını yiyordu (canlıdan kötü 24 karenin çoğu). En büyük iz
// bileşeni ≥0.09·yüz² yalnız belirgin izli karelerde görüldü (80fc7ec4 c0 0.25,
// c5 0.11, 3b4f51cb c1 0.10, 017dbe34 c5 0.10; izsizlerde en çok 0.08).
const GROW_SEED_FACE2 = 0.09;
/** Alanı minArea'dan büyük aday bileşenlerinin maskesi. SAF. */
function bigComponents(cand, minArea, n) {
  const out = new Uint8Array(n * n), seen = new Uint8Array(n * n);
  for (let s0 = 0; s0 < n * n; s0++) {
    if (!cand[s0] || seen[s0]) continue;
    const comp = [s0];
    seen[s0] = 1;
    for (let h = 0; h < comp.length; h++) {
      const i = comp[h], x = i % n, y = (i - x) / n;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
        const j = Y * n + X;
        if (cand[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length >= minArea) for (const i of comp) out[i] = 1;
  }
  return out;
}
/** Opak kafadan STRONG uzaklığa uzanmayan aday bileşenlerini siler (yerinde). Döner silinen piksel. */
function keepStrongGhost(cand, Od, minD, n) {
  const lab = new Int32Array(n * n).fill(-1);
  let dropped = 0;
  for (let s = 0; s < n * n; s++) {
    if (!cand[s] || lab[s] >= 0) continue;
    const comp = [s];
    lab[s] = s;
    let far = 0;
    for (let h = 0; h < comp.length; h++) {
      const i = comp[h], x = i % n, y = (i - x) / n;
      if (Od[i] > far) far = Od[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
        const j = Y * n + X;
        if (cand[j] && lab[j] < 0) { lab[j] = s; comp.push(j); }
      }
    }
    if (far < minD) { for (const i of comp) cand[i] = 0; dropped += comp.length; }
  }
  return dropped;
}

// ŞABLON ALNI İZİ (2026-11-04, 80fc7ec4 c0 sol üst): yüksek alınlı şablonun
// alın derisi kullanıcının saç çizgisinin ÜSTÜNDE yarı saydam bej leke olarak
// kalıyordu; skinSeg onu "yüz derisi" görüyor, iki büyütme de deriyi dışarıda
// bırakıyordu. Kullanıcının yüz derisine bağlı olmayan (userSkin dışı), kaşların
// belirgin üstündeki (kulak üstleri kaş hizasını aşmaz) ve rengi kullanıcının
// saçından farklı deri pikseli, ize bağlıysa iz sayılır.
const SKIN_REMNANT_ABOVE_BROW_FACE = 0.15;
function growGhostSkinRemnant(seed, { Th, Ex, userSkin, inOval, Po, CLASSES, n, browO, fwk, oF, U }) {
  if (!U) return new Uint8Array(n * n);
  const yMax = browO - SKIN_REMNANT_ABOVE_BROW_FACE * fwk;
  const ok = (i) => {
    if (!(Th[i] && Ex[i] && !userSkin[i] && !inOval[i] && Math.floor(i / n) < yMax)) return false;
    if (Math.max(Po[CLASSES.faceSkin][i], Po[CLASSES.bodySkin][i]) < GROW_SKIN_MAX) return false;
    const j = i * 3;
    return Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]) > RIM_DIFF;
  };
  return growFrom(seed, ok, GROW_DEPTH_FACE * fwk, n);
}

/**
 * Çıktıdaki şablon kafası izini siler. profiles: headProfileOf sonuçları
 * (kullanıcının selfie'leri; boşsa yalnız karışım testi). Dönüş { buf (PNG) |
 * null, applied, reason, ghostPx, ghostFace2, mode, ms }.
 */
/**
 * Yama skorlarından (grid×grid, kırpımın üstünde) iz bölgesi maskesi. SAF.
 * hp = { grid, scores (grid², null = puanlanmadı), tau }. Yama bazında:
 * skor ≥ tau çekirdek; çekirdeğe komşu ve skor ≥ tau − HOT_HYST yamalar
 * (histerezis); 8 komşusunun en az 5'i sıcak olan yama (delik). Sonra yarım
 * yama genişletme — bloklu maske izin parçasını temiz zeminde kırıntı olarak
 * bırakıyordu (2026-11-06, 9c8f2cb5 c3 tepede "haç", dd788c00 c8 gri blok).
 */
const HOT_HYST = 1.5;
function hotMaskOf(hp, n) {
  const G = hp.grid, cell = n / G, S = hp.scores;
  const hotP = new Uint8Array(G * G);
  const q = [];
  for (let p = 0; p < G * G; p++) if (S[p] != null && S[p] >= hp.tau) { hotP[p] = 1; q.push(p); }
  const nb8 = (p) => {
    const x = p % G, y = (p - x) / G, r = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < G && Y < G) r.push(Y * G + X);
    }
    return r;
  };
  for (let h = 0; h < q.length; h++) for (const r of nb8(q[h])) if (!hotP[r] && S[r] != null && S[r] >= hp.tau - HOT_HYST) { hotP[r] = 1; q.push(r); }
  const fill = [];
  for (let p = 0; p < G * G; p++) if (!hotP[p] && nb8(p).filter((r) => hotP[r]).length >= 5) fill.push(p);
  for (const p of fill) hotP[p] = 1;
  const out = new Uint8Array(n * n), pad = Math.round(cell / 2);
  for (let p = 0; p < G * G; p++) {
    if (!hotP[p]) continue;
    const gx = p % G, gy = (p - gx) / G;
    const y0 = Math.max(0, Math.round(gy * cell) - pad), y1 = Math.min(n, Math.round((gy + 1) * cell) + pad);
    const x0 = Math.max(0, Math.round(gx * cell) - pad), x1 = Math.min(n, Math.round((gx + 1) * cell) + pad);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * n + x] = 1;
  }
  return out;
}

async function cleanTemplateGhost(outputBuf, templateBuf, { profiles = [], debug = null, ghostScorer = null, templateHat = false } = {}) {
  const t0 = Date.now();
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { faceOval, inPolygon } = require("./headSurround");
  const { fillCrop } = require("./lamaFill");
  const { distanceTo } = require("./headWarp")._testables;

  const o = await rawOf(outputBuf);
  const { W, H } = o;
  const t = await rawOf(templateBuf, W, H);
  const oJ = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const tJ = await sharp(t.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(oJ)) || (await faceLandmarks(oJ, 0.1));
  const lt = (await faceLandmarks(tJ)) || (await faceLandmarks(tJ, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template", ms: Date.now() - t0 };

  // Kare kesit: iki kafayı da kapsar.
  const fw = Math.max(faceWidth(lo), faceWidth(lt));
  const cxOf = (lm) => lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const yTop = Math.min(lo.box.y, lt.box.y) - CROP_UP_FACE * fw;
  const yBot = Math.max(lo.pts[8].y, lt.pts[8].y) + CROP_DOWN_FACE * fw;
  const side = Math.min(W, H, Math.max(Math.round(CROP_FACE * fw), Math.round(yBot - yTop)));
  if (side < 48) return { buf: null, applied: false, reason: "tiny", ms: Date.now() - t0 };
  const left = clampI((cxOf(lo) + cxOf(lt)) / 2 - side / 2, 0, W - side);
  const top = clampI((yTop + yBot) / 2 - side / 2, 0, H - side);
  const n = Math.min(side, WORK_MAX);
  const k = n / side;
  const [oC, tC] = await Promise.all([cropSquare(o.data, W, H, left, top, side, n), cropSquare(t.data, W, H, left, top, side, n)]);
  const toWork = (lm) => lm.pts.map((p) => ({ x: (p.x - left) * k, y: (p.y - top) * k }));
  const po = toWork(lo), pt = toWork(lt);
  const fwk = fw * k;

  const [Po, Pt] = await Promise.all([classProbs(oC, n, n), classProbs(tC, n, n)]);
  const Ht = headMask(Pt, pt, n, CLASSES, faceOval, inPolygon);
  const Ho = headMask(Po, po, n, CLASSES, faceOval, inPolygon);
  const Th = dilate(Ht.head, n, n, TPL_GROW_FACE * fwk, distanceTo);
  const HoD = dilate(Ho.head, n, n, HOLE_GROW_FACE * fwk, distanceTo);
  // MODELİN KORUDUĞU ŞAPKA (bkz. HAT_KEPT_SHARE). Yalnız şablonda şapka tespit
  // edildiyse; değilse hiçbir şey değişmez.
  const hk = templateHat ? keptHatMask({ Ht, Ho, Po, CLASSES, pt, po, n, fwk, distanceTo }) : null;
  const hatKeep = hk && hk.kept ? hk.keep : null;

  // BEKLENEN KAFA: poza en yakın selfie'nin maskesi çıktının yüzüne taşınır.
  const ecO = eyeChin(po);
  const yawO = signedYaw(lo.pts);
  let pose3dO = null;
  if ((profiles || []).some((p) => p && p.pose3d)) {
    const p3 = await require("./headPose3d").headPose3dOf(oJ);
    if (p3 && p3.src === "mesh") pose3dO = { yaw: p3.yaw, pitch: p3.pitch };
  }
  const pick = pickProfile(profiles, yawO, pose3dO);
  let Ex = null;
  const prof = pick ? pick.prof : null;
  if (prof) {
    Ex = mapMask(prof.mask, prof.n, prof.E, prof.C, ecO.E, ecO.C, n);
    let hatPx = 0;
    for (let i = 0; i < n * n; i++) if (Ht.hat[i]) hatPx++;
    if (hatPx >= HAT_MIN_FACE2 * fwk * fwk) {
      const ecT = eyeChin(pt);
      const hatO = mapMask(Ht.hat, n, ecT.E, ecT.C, ecO.E, ecO.C, n);
      // Şablon şapkası yalnız çıktıda OPAK şapka varsa korunur (2026-11-04,
      // 80fc7ec4 c5): model şapkayı çoğu karede düşürüyor (4/4) ve geride
      // yarı saydam kubbe kalıyor; şapka bölgesinin tamamı korununca kubbe
      // hiç aranmıyordu. Opak şapka: aksesuar sınıfı, arka plan sınıfı düşük.
      for (let i = 0; i < n * n; i++) {
        if (hatO[i] && Po[CLASSES.others][i] >= OUT_HAT_MIN && Po[CLASSES.background][i] < GROW_BG_MIN) Ex[i] = 1;
      }
    }
    for (let i = 0; i < n * n; i++) if (Ho.inOval[i]) Ex[i] = 1;
    Ex = dilate(Ex, n, n, pick.margin * fwk, distanceTo);
  }
  // Yüze bağlı deri (+ yumuşak kenar bandı): hiçbir yolda iz sayılmaz.
  const chinO = po[8].y;
  const skinC = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (Math.floor(i / n) > chinO + 0.6 * fwk) continue;
    if (Math.max(Po[CLASSES.faceSkin][i], Po[CLASSES.bodySkin][i]) >= USER_SKIN_MIN) skinC[i] = 1;
  }
  const userSkin = dilate(connected(skinC, Ho.inOval, n, n), n, n, USER_SKIN_BAND_FACE * fwk, distanceTo);

  // Zemin tahmini (karışım testi için): iki kafa, kıyafet ve vücut derisi dışı.
  const bgW = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (Th[i] || HoD[i]) continue;
    if (Po[CLASSES.clothes][i] >= SEG_MIN || Po[CLASSES.bodySkin][i] >= SEG_MIN) continue;
    bgW[i] = 1;
  }
  const bg = maskedMean(oC, bgW, n, n, BG_RADII_FACE.map((f) => Math.max(2, Math.round(f * fwk))), BG_COVER_MIN);
  const sr = Math.max(1, Math.round(SMOOTH_FACE * fwk));
  const oF = boxBlur3(oC, n, n, sr), tF = boxBlur3(tC, n, n, sr);

  const cand = new Uint8Array(n * n);
  let core;
  let keep = null;
  let weakPx = null, Uout = null, hotAdded = 0, hotPatches = null, detScore = null, haloFace2 = 0, hazeFace2 = 0, userOpaquePx = 0, tuftPx = 0, tuftN = 0;
  if (Ex) {
    // Beklenen kafanın dışı: kafa sınıfı, kafaya bağlı kişi maskesi ya da yarı
    // saydam karışım = iz.
    const Mo = await require("./headScale").personMask(Buffer.from(oC), n, n);
    const pc = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (Mo[i] >= OUT_PERSON_MIN || Ho.head[i]) pc[i] = 1;
    const personHead = connected(pc, Ho.inOval, n, n);
    // Kişi maskesi yalnız kaş hizasının üstünde: altında kullanıcının boynu da
    // kişi (kafa şablondan yukarıda çizilince şablon çenesi boyna düşer).
    const browO = Math.min(...po.slice(17, 27).map((p) => p.y));
    // Kullanıcının kendi saç rengi: beklenen kafanın içindeki dolu saç.
    const hc = [[], [], []];
    for (let i = 0; i < n * n; i++) {
      // Kubbe (saç≈1 VE arka plan≈1) kullanıcının saçı değil: ortancayı kaydırmasın (2026-11-05 inceleme).
      if (!Ex[i] || !Ho.head[i] || Ho.inOval[i] || Po[CLASSES.hair][i] < USER_HAIR_MIN || Po[CLASSES.background][i] >= GROW_BG_MIN) continue;
      for (let c = 0; c < 3; c++) hc[c].push(oF[i * 3 + c]);
    }
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const U = hc[0].length >= Math.max(20, 0.002 * fwk * fwk) ? hc.map(med) : null;
    Uout = U;
    keep = new Uint8Array(n * n);
    const exDist = distanceTo(Ex, n, n);
    // OPAK KAFA (bkz. OPAQUE_*) adaylardan önce: belirsiz renkli yarı saydam piksel
    // için uzaklık ölçütü ona göre.
    const O = opaqueHead({ Ho, userSkin, Th, Po, CLASSES, n, oF, tF, U, personHead, bg });
    // OPAK SAYILAN PUS (bkz. HAZE_*): opaklıktan çıkar, aşağıda iz olarak eklenir.
    const haze = HAZE_ON ? hazeMask({ n, O, Ho, userSkin, oF, U, bg, browO, fwk, distanceTo }) : new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (haze[i]) O[i] = 0;
    const Od = distanceTo(O, n, n);
    const mixA = new Uint8Array(n * n);
    const ambig = new Uint8Array(n * n);
    const tex = localNcc(oC, tC, n, Math.max(2, Math.round(AMBIG_NCC_R_FACE * fwk)));
    for (let i = 0; i < n * n; i++) {
      if (!Th[i] || Ex[i] || userSkin[i]) continue;
      const j = i * 3;
      const hairCls = Po[CLASSES.hair][i] >= OUT_HAIR_MIN;
      const mix = bg.ok[i] && ghostAlpha([oF[j], oF[j + 1], oF[j + 2]], [tF[j], tF[j + 1], tF[j + 2]], [bg.v[j], bg.v[j + 1], bg.v[j + 2]]) != null;
      if (mix) mixA[i] = 1;
      // YALNIZ YARI SAYDAM İZ ADAYDIR (2026-11-05 v18 görsel inceleme, 134 kare):
      // eskiden "beklenen kafanın dışında saç/deri/şapka sınıfı" da adaydı; selfie
      // çizgisi ±%10 hatalı olduğundan izsiz karelerde modelin opak çizdiği gerçek
      // saç (şablonun şeklinde olsa bile: dd788c00 c7 kıvırcık tepe, d87c25b4 c2
      // kulaklık/ense, b932fd71 c0 bukleler) kırpılıyordu — kural "kafa kesilmez".
      // Hayalet = arkasından zemin görünen şablon katmanı (ghostAlpha α 0.18-0.88).
      if (!mix) {
        // KULLANICININ SAÇI selfie çizgisini biraz aşmış olabilir (c8): korunur.
        if (U && hairCls && exDist[i] <= USER_HAIR_REACH_FACE * fwk &&
            Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]) <= USER_HAIR_SAME) keep[i] = 1;
        continue;
      }
      // Kullanıcının saçı + zemin olarak da en az o kadar iyi açıklanıyorsa
      // (saç kenarı, bukle ucu) iz değildir: şablon belirgin daha iyi açıklamalı.
      if (U) {
        const o = [oF[j], oF[j + 1], oF[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]];
        const fu = mixFit(o, U, b), ft = mixFit(o, [tF[j], tF[j + 1], tF[j + 2]], b);
        if (!(ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS))) {
          // Belirsiz: opak kafadan uzakta ve şablonun DOKUSUNU taşıyorsa kesin iz
          // (9c8f2cb5 c3: şablon ve kullanıcı saçı aynı koyu renk, gökyüzünde soluk
          // şablon kıvrımları); düz opak nesne (kulaklık bandı) dokuyu taşımaz.
          // Değilse yalnız kesin ize bağlıysa (aşağıda histerezis) iz olur.
          if (Od[i] > AMBIG_FAR_FACE * fwk && tex.ncc[i] >= AMBIG_NCC_MIN && tex.tsd[i] >= AMBIG_TSD_MIN) { cand[i] = 1; continue; }
          if (Od[i] > EDGE_BAND_FACE * fwk) ambig[i] = 1;
          continue;
        }
      }
      cand[i] = 1;
    }
    // HİSTEREZİS (bkz. RENKÇE BELİRSİZ): belirsiz yarı saydam piksel kesin ize bağlıysa
    // aynı hayalet katmanının parçasıdır (80fc7ec4 c0 kubbenin koyu kısmı).
    const reach = growFrom(cand, (i) => ambig[i] === 1, 4 * n, n);
    for (let i = 0; i < n * n; i++) if (reach[i]) cand[i] = 1;
    // GERÇEK SAÇ KORUMASI (bkz. PROTECT_HAIR_*): çıktının kafasına bağlı, opak,
    // kullanıcı renginde saç beklenen kafanın dışında da iz sayılmaz.
    const protectedHair = protectRealHair({ Th, Ex, Ho: Ho.head, keep, Po, CLASSES, n, fwk, oF, U });
    for (let i = 0; i < n * n; i++) if (protectedHair[i]) { cand[i] = 0; keep[i] = 1; }
    // Kullanıcının yarı saydam bukle kenarı (bkz. FRINGE_*): opak kafadan büyür.
    const fSeed = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      if (keep[i] || userSkin[i] || (Ex[i] && Ho.head[i] && Po[CLASSES.background][i] < PROTECT_HAIR_BG_MAX)) fSeed[i] = 1;
    }
    const fringe = protectUserFringe({ seed: fSeed, Th, n, fwk, oF, tF, bg, U });
    for (let i = 0; i < n * n; i++) if (fringe[i]) { cand[i] = 0; keep[i] = 1; }
    // OPAK KAFA (bkz. OPAQUE_*): hiçbir aday kuralı ona dokunmaz; ince kenar
    // bandında yalnız şablonun açıkça daha iyi açıkladığı piksel iz kalır; iz
    // bileşeni opak kafadan belirgin uzağa taşmıyorsa (gerçek saç kenarı) bırakılır.
    for (let i = 0; i < n * n; i++) if (O[i]) { cand[i] = 0; keep[i] = 1; }
    if (U) {
      for (let i = 0; i < n * n; i++) {
        if (!cand[i] || Od[i] > EDGE_BAND_FACE * fwk || !bg.ok[i]) continue;
        const j = i * 3, o = [oF[j], oF[j + 1], oF[j + 2]], b = [bg.v[j], bg.v[j + 1], bg.v[j + 2]];
        const fu = mixFit(o, U, b), ft = mixFit(o, [tF[j], tF[j + 1], tF[j + 2]], b);
        if (!(ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS))) cand[i] = 0;
      }
    }
    const weak = keepStrongGhost(cand, Od, STRONG_FACE * fwk, n);
    weakPx = weak;
    if (debug) Object.assign(debug, { protectedHair, mixA, Th, keep, fringe, O, personHead });
    // Büyütme/kenar/alın kuralları yalnız BÜYÜK iz bileşeninden başlar (bkz.
    // GROW_SEED_FACE2): küçük tohumdan yayılınca izsiz karelerde saç kenarını yiyordu.
    const seed = bigComponents(cand, GROW_SEED_FACE2 * fwk * fwk, n);
    // İZİ BEKLENEN KAFANIN İÇİNE BÜYÜT (2026-11-04, 80fc7ec4 c0 bej bant).
    const grown = growGhostIntoExpected(seed, { Th, Ex, userSkin, inOval: Ho.inOval, Po, CLASSES, n, browO, fwk });
    const grownBg = debug ? Uint8Array.from(grown) : null;
    for (let i = 0; i < n * n; i++) if (grown[i]) { cand[i] = 1; seed[i] = 1; }
    // Şablon alnı izi (bkz. SKIN_REMNANT_ABOVE_BROW_FACE): ize bağlı.
    const skinRem = growGhostSkinRemnant(seed, { Th, Ex, userSkin, inOval: Ho.inOval, Po, CLASSES, n, browO, fwk, oF, U });
    for (let i = 0; i < n * n; i++) if (skinRem[i]) { cand[i] = 1; grown[i] = 1; seed[i] = 1; }
    // İzin kenarındaki açık şerit (bkz. RIM_DIFF): büyütülmüş ize bitişik.
    const rim = growGhostRim(seed, { Th, Ex, userSkin, inOval: Ho.inOval, Po, CLASSES, n, browO, fwk, oF, U });
    for (let i = 0; i < n * n; i++) if (rim[i]) { cand[i] = 1; grown[i] = 1; }
    // Büyütmeler bukle kenarından geçmiş olabilir: korunan kenar iz sayılmaz.
    for (let i = 0; i < n * n; i++) if (fringe[i]) { cand[i] = 0; grown[i] = 0; }
    // DETEKTÖR ONAYLI İZ (2026-11-06, bkz. ghostDetect.js): kare düzeyi iz skoru
    // eşiği geçtiyse, skoru yüksek yamalarda şablon kafasının içindeki piksel
    // karışım testine bakmadan iz sayılır — BEKLENEN KAFANIN İÇİNDE DE (kalıntının
    // çoğu opak kafa ile selfie çizgisi arasındaki ±%10 payda: dd788c00 c8,
    // 6dd26e3e c2; dokulu zeminde karışım testi de izi kaçırıyor: 9c8f2cb5 c3).
    // Opak kafa, yüz ovali, deri, gerçek saç/bukle koruması yine dokunulmaz;
    // opak kafanın kenar bandında yalnız kullanıcı saç renginden çok uzak piksel.
    // İstisna: sıcak yamada kullanıcı saçından çok uzak ve AÇIK "opak" piksel
    // opak sayılmaz (d87c25b4 c0 siyah saç üstünde bej kubbe).
    if (ghostScorer && U) {
      // Detektör bölgeleri (bkz. ghostDetect.js): R = beklenen kafa dışı, bant = içi.
      const zoneR = new Uint8Array(n * n), zoneB = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) {
        if (!Th[i] || userSkin[i] || O[i]) continue;
        if (Ex[i]) zoneB[i] = 1; else zoneR[i] = 1;
      }
      try {
        const r = await ghostScorer({ oC, n, zoneR, zoneB });
        hotPatches = (r && r.hot) || null;
        detScore = r ? r.frameScore : null;
      } catch (e) { console.warn("ghostClean: iz detektörü atlandı:", e.message); }
    }
    if (hotPatches && U) {
      const hot = hotMaskOf(hotPatches, n);
      const lU = (U[0] + U[1] + U[2]) / 3;
      const farLight = (i) => {
        const j = i * 3;
        return Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]) > OPAQUE_FAR_FROM_U &&
          (oF[j] + oF[j + 1] + oF[j + 2]) / 3 >= lU + RIM_LIGHTER;
      };
      const O2 = Uint8Array.from(O), relaxed = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) {
        if (O[i] && hot[i] && Th[i] && !userSkin[i] && !protectedHair[i] && !Ho.inOval[i] && farLight(i)) { O2[i] = 0; relaxed[i] = 1; }
      }
      const Od2 = distanceTo(O2, n, n);
      const hc = Uint8Array.from(cand);
      for (let i = 0; i < n * n; i++) {
        if (cand[i] || !hot[i] || !Th[i] || userSkin[i] || O2[i] || protectedHair[i] || fringe[i] || Ho.inOval[i]) continue;
        if (keep[i] && !relaxed[i]) continue;
        if (Od2[i] <= EDGE_BAND_FACE * fwk && !farLight(i)) continue;
        hc[i] = 1;
      }
      keepStrongGhost(hc, Od2, STRONG_FACE * fwk, n);
      for (let i = 0; i < n * n; i++) if (hc[i] && !cand[i]) { cand[i] = 1; grown[i] = 1; hotAdded++; }
    }
    // YARI SAYDAM HALE (bkz. HALO_*): şablon kafası dışında, opak kafaya bitişik.
    let haloPx = 0;
    if (HALO_ON && U) {
      const halo = haloMask({ n, O, Od, Th, userSkin, Po, CLASSES, oF, tF, U, po, fwk, bg });
      if (debug) Object.assign(debug, { haloM: halo, Po, CLASSES });
      for (let i = 0; i < n * n; i++) {
        if (!halo[i] || protectedHair[i] || fringe[i]) continue;
        cand[i] = 1; grown[i] = 1; haloPx++;
      }
    }
    haloFace2 = haloPx / (fwk * fwk);
    let hazePx = 0;
    for (let i = 0; i < n * n; i++) if (haze[i]) { cand[i] = 1; grown[i] = 1; keep[i] = 0; hazePx++; }
    hazeFace2 = hazePx / (fwk * fwk);
    if (debug) Object.assign(debug, { haze });
    // KULLANICININ OPAK SAÇI (bkz. USER_OPAQUE): hiçbir kural (iz, büyütme, dolgu
    // genişlemesi, kırıntı, artık iz) ona dokunmaz.
    if (USER_OPAQUE.ON && U) {
      const uo = userOpaqueHair({ seed: keep, O, Th, n, fwk, oC, oF, bg, U, distanceTo });
      for (let i = 0; i < n * n; i++) if (uo[i]) { if (cand[i]) userOpaquePx++; cand[i] = 0; grown[i] = 0; keep[i] = 1; }
      if (debug) Object.assign(debug, { userOpaque: uo });
    }
    if (TUFT.ON) {
      const tf = tuftIslands({ keep, O, Od, cand, userSkin, inOval: Ho.inOval, n, fwk });
      for (let i = 0; i < n * n; i++) if (tf.mask[i]) { cand[i] = 1; grown[i] = 1; keep[i] = 0; tuftPx++; }
      tuftN = tf.found.filter((q) => q.hit).length;
      if (debug) Object.assign(debug, { tuft: tf.mask, tuftFound: tf.found, inOval: Ho.inOval, Od });
    }
    if (debug) Object.assign(debug, { grown, U, browO, oF, rim, skinRem, grownBg });
    core = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (((Ex[i] && Ho.head[i]) || keep[i] || userSkin[i]) && !grown[i]) core[i] = 1;
  } else {
    // Selfie yok: yalnız kafa dışındaki karışım, kenarda kullanıcı rengi testiyle.
    const headW = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) if (Ho.head[i]) headW[i] = 1;
    const userCol = maskedMean(oC, headW, n, n, [Math.max(2, Math.round(0.05 * fwk)), Math.max(3, Math.round(0.12 * fwk))], 0.05);
    const headDist = distanceTo(Ho.head, n, n);
    for (let i = 0; i < n * n; i++) {
      if (!Th[i] || Ho.inOval[i] || !bg.ok[i]) continue;
      const j = i * 3;
      const u = headDist[i] <= EDGE_FACE * fwk && userCol.ok[i] ? [userCol.v[j], userCol.v[j + 1], userCol.v[j + 2]] : null;
      if (ghostAlpha([oF[j], oF[j + 1], oF[j + 2]], [tF[j], tF[j + 1], tF[j + 2]], [bg.v[j], bg.v[j + 1], bg.v[j + 2]], u) != null) cand[i] = 1;
    }
    core = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (Ho.inOval[i] || (Ho.head[i] && !cand[i]) || userSkin[i]) core[i] = 1;
    const band = dilate(core, n, n, PROTECT_FACE * fwk, distanceTo);
    for (let i = 0; i < n * n; i++) if (band[i]) cand[i] = 0;
  }
  if (hatKeep) {
    for (let i = 0; i < n * n; i++) if (hatKeep[i]) { cand[i] = 0; core[i] = 1; }
  }
  const G = dropSmall(cand, n, n, Math.max(4, MIN_AREA_FACE2 * fwk * fwk));
  let gPx = 0;
  for (let i = 0; i < n * n; i++) if (G[i]) gPx++;
  const f0 = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
  const mode = !Ex ? "karışım" : pick.deg != null
    ? `selfie(3B ${f0(prof.pose3d.yaw)}/${f0(prof.pose3d.pitch)}→${f0(pose3dO.yaw)}/${f0(pose3dO.pitch)}° Δ=${pick.deg.toFixed(0)}° pay=${pick.margin.toFixed(2)})`
    : `selfie(yaw ${prof.yaw.toFixed(2)}→${yawO.toFixed(2)} pay=${pick.margin.toFixed(2)})`;
  const stats = { ghostPx: Math.round(gPx / (k * k)), ghostFace2: gPx / (fwk * fwk), mode, weakPx, hotAdded: hotAdded / (fwk * fwk), detScore, detHot: !!hotPatches, halo: haloFace2, haze: hazeFace2, userOpaque: userOpaquePx / (fwk * fwk), tuft: tuftPx / (fwk * fwk), tuftN };
  if (hk) Object.assign(stats, { hatShare: hk.share, hatArea: hk.area, hatKept: hk.kept });
  // NEREDEN SİLİNDİ (2026-11-01, 831a00a4 c3 "kafa basık", c7 "kafa küçük"):
  // ham kare saklanmadığı için izin kafanın saçı mı, şablon izi mi olduğu
  // ayrılamadı. Göz çizgisinin üstü ve kullanıcının kafasına bitişik pay
  // (ikisi birden yüksekse kesilen büyük olasılıkla kullanıcının saçı).
  if (gPx && core) {
    const eyeY = (po[36].y + po[45].y) / 2;
    const dCore = distanceTo(core, n, n);
    let up = 0, att = 0;
    for (let i = 0; i < n * n; i++) {
      if (!G[i]) continue;
      if (Math.floor(i / n) < eyeY) up++;
      if (dCore[i] <= Math.max(2, 0.03 * fwk)) att++;
    }
    stats.ghostUp = up / gPx;
    stats.ghostAttached = att / gPx;
  }
  if (debug) {
    const Bdbg = Buffer.alloc(n * n * 3);
    for (let i = 0; i < n * n * 3; i++) Bdbg[i] = bg.ok[(i / 3) | 0] ? Math.round(bg.v[i]) : 0;
    Object.assign(debug, { n, side, left, top, oC, tC, B: Bdbg, Th, Ho: Ho.head, HoD, Ex, cand, G, Po, CLASSES, userSkin, po, fwk });
  }
  if (!gPx) return { buf: null, applied: false, reason: "clean", ...stats, ms: Date.now() - t0 };

  // Dolgu: iz ∪ kullanıcının kafası TEK delik (kafa bağlam olarak verilmez —
  // verilince LaMa saçı deliğe uzatıyordu; kaba zemin plakasıyla gizlemek de
  // c0'da plakanın kahve lekesini izin yerine taşıdı). İzin dış kenarı gerçek
  // zemine bakar; sonuçtan yalnız iz alınır, kafa olduğu gibi kalır.
  const Gd = dilate(G, n, n, GROW_FACE * fwk, distanceTo);
  for (let i = 0; i < n * n; i++) if (core[i]) Gd[i] = 0;
  const chinMax = Math.max(po[8].y, pt[8].y);
  // ARTIK İZ BÖLGESİ (bkz. RES_*): şablon kafası alanında, izin ya da kafanın
  // yakınında, kullanıcının kafası/korunan saçı/derisi dışında, skinSeg'in
  // "arka plan" dediği pikseller (hayalet saç arka plan sınıfında).
  const nearHead = new Uint8Array(n * n);
  // Yalnız gerçek izin yakını (kafa kenarının her yeri değil: izsiz karede
  // gerçek bukle uçları da bu imzaya uyuyordu, b932fd71 c0 v18).
  for (let i = 0; i < n * n; i++) if (G[i]) nearHead[i] = 1;
  const nearD = dilate(nearHead, n, n, RES_REACH_FACE * fwk, distanceTo);
  const resZone = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (!Th[i] || !nearD[i] || core[i] || userSkin[i] || Math.floor(i / n) > chinMax) continue;
    if (Po[CLASSES.background][i] >= RES_BG_MIN) resZone[i] = 1;
  }
  const hole = new Uint8Array(n * n);
  let hx0 = n, hx1 = -1, hy0 = n, hy1 = -1;
  for (let i = 0; i < n * n; i++) {
    // Aranan bölgenin tamamı da delikte: dışarıda kalan soluk teller bağlam
    // olunca LaMa onları izin yerine yeniden çiziyordu (c0).
    const searched = Ex ? Th[i] && !Ex[i] : 0;
    if (!((Gd[i] || HoD[i] || searched || resZone[i]) && Math.floor(i / n) <= chinMax + 0.1 * fwk)) continue;
    hole[i] = 1;
    const x = i % n, y = (i - x) / n;
    if (x < hx0) hx0 = x;
    if (x > hx1) hx1 = x;
    if (y < hy0) hy0 = y;
    if (y > hy1) hy1 = y;
  }
  // Delik tek LaMa parçasına sığsın (parçalanınca büyük delikte pus): gerekirse küçültülür.
  const spanNative = (Math.max(hx1 - hx0, hy1 - hy0) + 1) / k;
  const f = Math.min(1, LAMA_SPAN_MAX / spanNative);
  const sideL = Math.max(16, Math.round(side * f));
  const resizeMask = async (m, from, to) => {
    const b8 = Buffer.alloc(from * from);
    for (let i = 0; i < from * from; i++) b8[i] = m[i] ? 255 : 0;
    // TEK KANAL TUZAĞI (hafıza sharp-mask-channel-trap): extractChannel(0) şart.
    return sharp(b8, { raw: { width: from, height: from, channels: 1 } }).resize(to, to, { kernel: "linear" }).extractChannel(0).raw().toBuffer();
  };
  const crop = await cropSquare(o.data, W, H, left, top, side, side);
  const cropL = sideL === side ? Buffer.from(crop) : await sharp(crop, { raw: { width: side, height: side, channels: 3 } }).resize(sideL, sideL, { kernel: "lanczos3" }).raw().toBuffer();
  const holeL8 = await resizeMask(hole, n, sideL);
  const holeL = new Uint8Array(sideL * sideL);
  for (let i = 0; i < holeL.length; i++) holeL[i] = holeL8[i] > 32 ? 1 : 0;
  const filledL = (await fillCrop(cropL, sideL, holeL)).rgb;
  const filled = sideL === side ? Buffer.from(filledL) : await sharp(Buffer.from(filledL), { raw: { width: sideL, height: sideL, channels: 3 } }).resize(side, side, { kernel: "lanczos3" }).raw().toBuffer();
  const fine = { rgb: filled };
  if (debug) Object.assign(debug, { filled, holeL, sideL, Gd, keep });
  // Bileşim maskesi: iz ∪ izin yakınında (aranan bölgede) temiz zeminden belirgin
  // farklı kalan kırıntılar (c0'da tavanda koyu benekler) — korunan kafa/saç hariç.
  const near = Ex ? dilate(G, n, n, CRUMB_REACH_FACE * fwk, distanceTo) : null;
  const crumbZone = new Uint8Array(n * n);
  if (Ex) for (let i = 0; i < n * n; i++) if (near[i] && Th[i] && !Ex[i] && !core[i]) crumbZone[i] = 1;
  const [GdU, zoneU] = await Promise.all([resizeMask(Gd, n, side), resizeMask(crumbZone, n, side)]);
  const comp = Buffer.alloc(side * side);
  let crumbPx = 0;
  for (let i = 0; i < side * side; i++) {
    if (GdU[i] > 64) { comp[i] = 255; continue; }
    if (!COMPOSE.CRUMB || zoneU[i] <= 128) continue;
    const d = Math.max(Math.abs(crop[i * 3] - filled[i * 3]), Math.abs(crop[i * 3 + 1] - filled[i * 3 + 1]), Math.abs(crop[i * 3 + 2] - filled[i * 3 + 2]));
    if (d > CRUMB_DIFF) { comp[i] = 255; crumbPx++; }
  }
  stats.crumbPx = crumbPx;
  const feather = Math.max(1, Math.round(FEATHER_FACE * fw));
  const wgt = await sharp(comp, { raw: { width: side, height: side, channels: 1 } })
    .blur(Math.max(0.3, feather / 2)).extractChannel(0).raw().toBuffer();
  // ARTIK İZ: temiz LaMa dolgusu zemin kabul edilip her piksel "çıktı − zemin ≈
  // α·(şablon − zemin)" imzasıyla sınanır (yumuşatılmış kopyalarda; tek piksel
  // greni α'yı bozar). İmza tutan soluk teller dolguyla değiştirilir.
  const resU = await resizeMask(resZone, n, side);
  const tcrop = await cropSquare(t.data, W, H, left, top, side, side);
  const sb = Math.max(0.3, RES_SMOOTH_FACE * fw);
  const blur3 = async (b) => {
    const r = await sharp(b, { raw: { width: side, height: side, channels: 3 } }).blur(sb).raw().toBuffer();
    if (r.length !== side * side * 3) throw new Error("ghostClean: artık iz bulanıklaştırma kanal sayısı");
    return r;
  };
  const [cS, fS, tS] = await Promise.all([blur3(crop), blur3(Buffer.from(filled)), blur3(tcrop)]);
  const rw = Buffer.alloc(side * side);
  let residPx = 0;
  for (let i = 0; i < side * side; i++) {
    if (resU[i] <= 200 || comp[i]) continue;
    const j = i * 3;
    const ft = mixFit([cS[j], cS[j + 1], cS[j + 2]], [tS[j], tS[j + 1], tS[j + 2]], [fS[j], fS[j + 1], fS[j + 2]]);
    if (ft.c2 < CONTRAST_MIN * CONTRAST_MIN || ft.od < RES_OD_MIN) continue;
    if (ft.a < RES_ALPHA_LO || ft.a > RES_ALPHA_MAX) continue;
    if (ft.resid > RESID_FRAC * ft.od + RESID_ABS) continue;
    // Kullanıcının saçıyla zemin karışımı olarak da açıklanıyorsa (bukle ucu) dokunma.
    if (Uout) {
      const fu = mixFit([cS[j], cS[j + 1], cS[j + 2]], Uout, [fS[j], fS[j + 1], fS[j + 2]]);
      if (!(ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS))) continue;
    }
    rw[i] = Math.round(255 * Math.min(1, (ft.a - RES_ALPHA_LO) / RES_ALPHA_RAMP));
    residPx++;
  }
  stats.residPx = residPx;
  const rwB = residPx ? await sharp(rw, { raw: { width: side, height: side, channels: 1 } })
    .blur(Math.max(0.3, feather / 2)).extractChannel(0).raw().toBuffer() : null;
  // Tepe ağırlık korunmaz (denendi 2026-11-05 v17): saç ucunda sert zemin beneği bıraktı.
  if (rwB) for (let i = 0; i < side * side; i++) if (rwB[i] > wgt[i]) wgt[i] = rwB[i];
  if (COMPOSE.CORE_PROTECT) {
    // Korunan kafa (core) çalışma ızgarasından doğrusal büyütülür: kenarda birkaç piksellik
    // doğal rampa (ikili kapı değil — bkz. binary-gate-after-feather).
    const coreU = await resizeMask(core, n, side);
    for (let i = 0; i < side * side; i++) if (coreU[i]) wgt[i] = Math.round(wgt[i] * (1 - coreU[i] / 255));
  }
  // Korunan şapkaya kenar yumuşatması da sızmasın (bkz. HAT_KEPT_SHARE).
  if (hatKeep) {
    const hkU = await resizeMask(hk.core, n, side);
    for (let i = 0; i < side * side; i++) if (hkU[i] > 128) wgt[i] = 0;
  }
  const res = Buffer.from(o.data);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      const w = wgt[i] / 255;
      if (w <= 0) continue;
      const g = ((y + top) * W + x + left) * 3;
      for (let c = 0; c < 3; c++) res[g + c] = Math.round(res[g + c] + w * (fine.rgb[i * 3 + c] - res[g + c]));
    }
  }
  const buf = await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, ...stats, ms: Date.now() - t0 };
}

module.exports = {
  cleanTemplateGhost, headProfileOf, measureHatKept,
  _testables: { COMPOSE, TUFT, tuftIslands, setHaloInTpl: (v) => { HALO_IN_TPL = v; }, setHazeOn: (v) => { HAZE_ON = v; }, setHazeThick: (v) => { HAZE_THICK_FACE = v; }, hazeDebug: (a) => { HAZE_DEBUG = a; }, hazeMask, scaleResid, userOpaqueHair, USER_OPAQUE, haloMask, HALO_MIN_AREA_FACE2, keptHatMask, HAT_KEPT_SHARE, hotMaskOf, growGhostIntoExpected, growGhostRim, growGhostSkinRemnant, protectRealHair, protectUserFringe, keepStrongGhost, localNcc, SKIN_REMNANT_ABOVE_BROW_FACE, GROW_BG_MIN, GROW_DEPTH_FACE, RIM_DIFF, RIM_DEPTH_FACE, ghostAlpha, mixFit, maskedMean, mapMask, signedYaw, eyeChin, connected, dropSmall, pickProfile, ALPHA_LO, ALPHA_HI, CONTRAST_MIN, EXP_MARGIN_FACE, EXP_MARGIN_PER_DEG, EXP_MARGIN_DEAD_DEG, EXP_MARGIN_MAX },
};
