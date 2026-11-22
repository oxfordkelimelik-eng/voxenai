/**
 * TEN TONU ALANI DÜZELTMESİ (2026-10-07) — ELEMEZ, DÜZELTİR.
 *
 * ŞİKÂYET (iş 9496348c): chunk 1'de kollar yüzden koyu-turuncu, eller açık;
 * chunk 9'da sağ üst kol koyu, el açık ("bir yer beyaz bir yer siyah").
 *
 * KÖK NEDEN, MEVCUT EL TONU KATMANININ KENDİSİ: correctHandToneInBoxes
 * yalnızca locateLimbRegions kutularının İÇİNİ ve kutu başına tek SABİT
 * kaymayla düzeltiyor. Kutu eli kapsayıp üst kolu kapsamayınca el yüz
 * tonuna çekiliyor, kutu dışındaki kol şablonun teninde kalıyor — iki tonlu
 * kol tam olarak budur. Loglarda iki kare de "UYGULANDI" (6.2 -> 0.7,
 * 15.6 -> 1.9) çünkü ölçüm de aynı kutunun içinde yapılıyor.
 *
 * BU KATMAN:
 *  1) NEYİN TEN OLDUĞUNU bir segmentasyon modeli söyler (skinSeg.js,
 *     MediaPipe selfie_multiclass: saç / yüz derisi / VÜCUT DERİSİ /
 *     kıyafet / aksesuar / arka plan). Kutuya ihtiyaç yok; kol nerede
 *     bitiyorsa düzeltme de orada biter.
 *  2) Vücut derisinden DÜŞÜK FREKANSLI bir ton alanı çıkarır (maske-normalize
 *     bulanıklık, yarıçap yüz boyuna bağlı). Kolun bir yerinin koyu, bir
 *     yerinin açık kalması bu alanda görünür.
 *  3) Her noktada alanı yüz tonuna çeken yumuşak bir düzeltme uygular.
 *     Alanın yarıçapından küçük doku (kas, damar, kıvrım gölgesi) korunur;
 *     kolun bir ucundan öbür ucuna uzanan ton farkı giderilir.
 *
 * RENKLE TEN TESPİTİ DENENDİ VE YETMEDİ (aynı gün, 6 iş / 59 kare): kişi
 * maskesi + renk korumaları (a*, renk açısı, kroma/açıklık) süet ceketi ve
 * kahve takımı ayıkladı ama elde tutulan DERİ ÇANTAYI, BİRA BARDAĞINI ve krem
 * gömleği boyadı. Deri çanta sayısal olarak tenle aynı (açı 49.5°,
 * kroma/açıklık 0.76) — renkle ayrılamaz. Segmentasyon modeli üçünü de doğru
 * sınıfladı.
 *
 * IŞIK İZİ: kolun kendi içindeki açıklık değişiminin bir kısmı (OWN_KEEP)
 * korunur; gölgedeki kol yapıştırılmış gibi yüzle birebir eşitlenmez.
 * ŞABLONDAN IŞIK PAYI ALMAK DENENDİ VE ÇIKARILDI: 9496348c c9'un şablon
 * kişisinin kolları DÖVMELİ ve teni yüzünden farklı — pay ışığı değil
 * şablon kişisinin kolunu taşıdı (sağ üst kol koyu kaldı: 17.0 -> 8.9,
 * şablonsuz 17.0 -> 1.7).
 *
 * İKİLİ KARAR YOK (bkz. hafıza binary-gate-after-feather): her ağırlık
 * sürekli — sınıf olasılığı, alan güveni, piksel kroma rampası.
 *
 * FAIL-SAFE: her hata/kararsızlıkta applied:false, buf null.
 */
const sharp = require("sharp");

const WORK_MAX_DIM = 512;
// Alan yarıçapı = yüz kutusu yüksekliği × bu oran (çalışma pikselinde).
const FIELD_RADIUS_VS_FACE = 0.35;
// Düzeltme gücü: 1.0 alanı birebir hedefe eşitler. 0.9 → 1.0 (2026-10-26,
// kullanıcı: "tam uyuşma"): pay, düzeltmeden sonra da ölçülebilir fark bırakıyordu.
const STRENGTH = 1.0;
// Uzuv içi açıklık sapmasının (ışık izi) korunan payı.
// 0.35/15 → 0.15/6 (2026-10-26, kullanıcı: "tam uyuşma"): uzuv medyanını
// boyun belirliyor; gölgedeki el "ışık izi" sayılıp yüzden 14-15 L koyu
// kaldı (ab c3), ışıktaki boyun yüzü 5 L aştı. Alan yarıçapından küçük
// gölge/doku zaten korunuyor.
const OWN_KEEP = 0.15;
// Işık payının mutlak tavanı (L birimi).
const MAX_LIGHT_ALLOW = 6;
// Kayma tavanları (Lab birimi).
const MAX_SHIFT_L = 28;
const MAX_SHIFT_AB = 10;
// ŞABLONUN VÜCUT/YÜZ IŞIK ORANI (2026-10-14): uzuv hedefi yüzün kendisi
// olunca şablonda gölgedeki boyun/el yüz kadar parladı (yerel test c17:
// şablon vücut/yüz 0.77, çıktıda 1.00). Hedef = yüz × şablon oranı. Piksel
// başına değil tek oran — dövmeli kolda piksel payı kolu taşımıştı (bkz.
// IŞIK İZİ); oran bu aralıkla sınırlı.
// 0.75 → 0.85 (2026-10-22, kullanıcı: "yüz ve vücut rengi tüm fotolarda tam
// uyuşmalı"): 25 teslim karesinde vücut yüzden 5-21 L koyuydu (b2a9537d c11
// 0.58 oranlı şablon).
// 1.0 / 1.0 (2026-10-26, e25dc241, kullanıcı ikinci kez: "yüzün cilt tonu
// vücudun diğer tüm yerleri ile tam uyuşma içerisinde olmalı"): şablon
// oranı payı c5/c7'de boynu yüzden 0.86-0.87 oranında koyu bırakıyordu.
// Vücut hedefi yüzün kendisi; şablon oranı ölçülmez (bkz. correctSkinToneField).
const BODY_LIGHT_MIN = 1.0;
const BODY_LIGHT_MAX = 1.0;
// Uzuvların hedeften farkı (açıklık, kroma, iç yayılım/2) bundan küçükse dokunulmaz.
const MIN_DELTA = 2.5;
// Vücut derisi olasılığı: ZERO altı hiç, FULL üstü tam ağırlık (arası yumuşak).
// Taban sıfır değil: model kıyafete de 0.05-0.15 arası olasılık veriyor ve
// tabansız rampa kıyafeti düşük ağırlıkla boyuyordu (ten 3.790 piksel iken
// 297.000 piksel değişmişti — 9496348c c4).
const BODY_SKIN_ZERO = 0.25;
const BODY_SKIN_FULL = 0.6;
// Kroma rampası: piksel kroması yerel ten alanından bu kadar uzaklaşınca
// ağırlık sönümlenir (HAND_FIX_CHROMA_FULL/ZERO ile aynı ölçülmüş değerler).
// Saat, bileklik, dövme mürekkebi gibi maske içi ayrıntıları korur.
const CHROMA_FULL = 18;
const CHROMA_ZERO = 26;
// ÖRNEKLEME KORUMASI (alanı kuran piksellerde, boyamada değil): maskenin
// kenarında ten sayılmış kumaş pikselleri alanı kirletmesin. Ölçülmüş:
//   renk açısı — ten 33-48° | süet 62°, kahve pantolon 64°, koyu takım 55°
//   kroma/açıklık — ten 0.40-0.85 | kumaş 1.18-1.30
// Açı yüzün kendi açısına göre alınır (kişiden kişiye değişir).
const HUE_PIX_FULL = 12;
const HUE_PIX_ZERO = 20;
const HUE_MIN_CHROMA = 8;
const CL_PIX_FULL = 1.0;
const CL_PIX_ZERO = 1.25;
// AKSESUAR KOMŞULUĞU (d0c75bde c8, elde tutulan deri çanta): model çantayı
// "aksesuar" sınıfladı ama içinde yer yer küçük "vücut derisi" lekeleri
// bıraktı ve lekeler boyandı. Çevresi yoğun aksesuar olan deri ağırlığı
// yumuşakça söndürülür (yarıçap çalışma pikselinde).
const OTHERS_RADIUS = 3;
const OTHERS_FULL = 0.4;
const OTHERS_ZERO = 0.7;
// Uzuv ağırlığı için alan güveni rampası (bkz. analyzeSkin). 0.08/0.22 →
// 0.03/0.12 (2026-10-18, 3b4f51cb c7, kullanıcı: "kollar siyahi base fotonun
// kolları kalmış"): cebe giden koyu ön kolda vücut derisi olasılığı düşük,
// çevre ten yoğunluğu 0.15 çıktı; ağırlık 0.25 kaldı, kol 24→24.2 (yüz 55).
// Yeni rampayla 24→31, sol ön kol 42→47. 61 karede değişen pikseller boyun/
// el/kolda; 11 karede önce "no-limb-skin" atlanan katman artık uygulanıyor.
// 0.03/0.12 → 0.01/0.06 (2026-10-26): tam boy karede el küçük, alan
// yarıçapı içinde yoğunluk düşük — el neredeyse hiç düzeltilmiyordu, karanlık
// karede katman "no-limb-skin" ile tümden atlanıyordu (629b45de c3). Alan
// maske-normalize: az pikselle de elin kendi ortalaması.
// 0.01/0.06 → 0.005/0.03 (2026-10-27, 62107c2d ab c3): gölgedeki elde
// kroma/açıklık 1.15 — örnekleme koruması (CL_PIX_*) çoğunu kumaş sayıyor,
// yoğunluk 0.035, ağırlık 0.38 kaldı; plan +18 L iken el +5 L açıldı.
// Boyanacak yeri segmentasyon + şablon kıyafet vetosu belirliyor.
const LIMB_CONF_ZERO = 0.005;
const LIMB_CONF_SPAN = 0.03;
// Bu kadar az vücut derisi pikseli varsa (kişi giyinik) iş yok.
const MIN_SKIN_PX = 400;
// RENK SELFIE'DEN, IŞIK SAHNEDEN (2026-10-28, 546b514b c0/c3, kullanıcı:
// "boyun boyaması tişörte gelmiş", "pantolonu boyamışsın, boynunu yok
// etmişsin"; tarif: "selfie'deki doğal ten rengi korunacak, yalnızca sahnenin
// yönlü ışığı ve gölgeleri yüz ve boyun kıvrımlarına eklenecek, boyundaki
// renk tişörte veya yakaya asla taşmayacak"). 10-27'den beri hedef açıklık
// yüzün kendisiydi: c0'da çene altı gölgedeki boyun +20.7 L açıldı, alan
// sınırı 20-30 piksel yumuşak olduğu için açma siyah tişörte taştı; c3'te
// boyun +22.9 L açılıp yüze karıştı. Şimdi hedef = yüz + şablonda AYNI
// noktadaki derinin kendi yüzüne göre farkı (kişinin teni yüzden, gölgesi
// şablondan). Fark payı ve sınırı: şablonda yüz güneşte, boyun gölgedeyse
// (b2a9537d c11, oran 0.58) model yüzü o kadar parlak çizmeyince boyun
// fazla kararmasın.
const TPL_SHADE_KEEP = 0.8;
const TPL_SHADE_MIN = -20;
const TPL_SHADE_MAX = 8;
// KARARTMA YALNIZ ILIMLI ŞABLONDA. Şablonda yüz çok parlak, vücut gölgedeyse
// (ab c8: yüz 74, vücut 48, fark 27) bu ışık farkıdır; model yüzü o kadar
// parlak çizmediğinde vücudu o farka göre karartmak boynu çamurlaştırdı
// (−11 L, turuncu). Fark ılımlıysa (açık tenli şablon, koyu tenli kişi) vücut
// tenine göre kararabilir. |gölge| FULL altında tam, ZERO üstünde hiç.
const TPL_DARKEN_MAX = 16;
const TPL_DARKEN_SHADE_FULL = 6;
const TPL_DARKEN_SHADE_ZERO = 14;
// Şablonda yakınında deri olmayan çıktı pikseli boyanmaz (c3: bej pantolon
// çıktıda "vücut derisi" sınıflandı, şablonda kıyafetti). Yarıçap yüz boyu
// cinsinden (poz kayması payı).
const TPL_PRESENCE_RADIUS = 0.12;
const TPL_PRESENCE_ZERO = 0.1;
const TPL_PRESENCE_FULL = 0.35;
// Piksel düzeyi deri kapısı (uygulamada): yerel ten alanından renkçe uzak
// (siyah tişört Δab ~20) ya da çok koyu (gölgedeki kumaş) piksel boyanmaz.
const PIX_AB_FULL = 10;
const PIX_AB_ZERO = 16;
const PIX_DARK_FULL = 14;
const PIX_DARK_ZERO = 24;
// Bölge ağırlığının yumuşatılması (çalışma pikseli). 2 → 1: tam karede 20-30
// piksellik yumuşak kenar tişörte taşıyordu; kenarı artık piksel kapısı çizer.
const REGION_BLUR = 1;
// YÜZE GÖRE DERİ KAPISI (2026-11-03, 7e04933e c5): koyu sahnede segmentasyon
// zeytin-gri balıkçı yakayı (L 8, kroma 3.7, açı 94°) boyun derisi saydı; alan
// örgünün kendi renginden kurulduğu için piksel kapıları da geçti ve yaka
// kızıla boyandı. Deri, yüze göre: kroma oranı (el 1.7, yaka 0.25), renk açısı
// farkı ve açıklık oranı. Hem alan örneklemesinde hem boyamada.
const REL_C_FULL = 0.5, REL_C_ZERO = 0.3;
const REL_H_FULL = 22, REL_H_ZERO = 35;
const REL_L_FULL = 0.45, REL_L_ZERO = 0.28;
// BOYUN HARİÇ (yüz kilidinde): boynu model yeni yüzden çiziyor; base'den kalan
// el/kol. c5'te çene altı gölgedeki boyun (L 14) yüz açıklığına çekilince
// turuncu leke oldu. Yüz kutusu merkezinden (en/2, boy) ölçekli elips mesafesi:
// NECK_ZERO içinde hiç, NECK_FULL dışında tam.
const NECK_ZERO = 1.6, NECK_FULL = 2.1;
const PIX_SOFT = 0.025;
function neckExclusion(x, y, box) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const dx = (x - cx) / Math.max(1, box.width * 0.75), dy = (y - cy) / Math.max(1, box.height);
  const d = Math.hypot(dx, dy);
  return d <= NECK_ZERO ? 0 : d >= NECK_FULL ? 1 : smooth01((d - NECK_ZERO) / (NECK_FULL - NECK_ZERO));
}
function skinLikeVsFace(lab, faceTone) {
  const fc = Math.max(4, Math.hypot(faceTone[1], faceTone[2]));
  const c = Math.hypot(lab[1], lab[2]);
  let w = 1 - ramp(c / fc, REL_C_ZERO, REL_C_FULL);
  if (w <= 0) return 0;
  if (c >= HUE_MIN_CHROMA) w *= ramp(Math.abs(hueOf(lab[1], lab[2]) - hueOf(faceTone[1], faceTone[2])), REL_H_FULL, REL_H_ZERO);
  w *= 1 - ramp(lab[0] / Math.max(1, faceTone[0]), REL_L_ZERO, REL_L_FULL);
  return w;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  const G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  const B = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  const enc = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [enc(R), enc(G), enc(B)];
}

/**
 * Ten renk ailesi (YCbCr), LUMA TABANI YOK — gölgedeki koyu ten de girer.
 * Cr ÜST SINIRI 180 (2026-10-18, d87c25b4 c1): model eli turuncu çizdi
 * (kroma yüz 22 / el 42); el piksellerinin yarısı Cr 173'ü aşıp örneklenmedi,
 * küçük elde alan güveni düştü ve katman "no-limb-skin" ile atlandı — en
 * turuncu el hiç düzeltilmedi. Kumaş/çanta koruması açı ve kroma/açıklık
 * rampalarında (HUE_PIX_*, CL_PIX_*); 47 karede 180 yalnız ten ekledi.
 */
const SKIN_CR_MAX = 180;
function skinHue(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 20 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= SKIN_CR_MAX;
}

const hueOf = (a, b) => Math.atan2(b, a) * 180 / Math.PI;
const ramp = (v, full, zero) =>
  (v <= full ? 1 : v >= zero ? 0 : (zero - v) / (zero - full));
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp = (v, lim) => (v > lim ? lim : v < -lim ? -lim : v);

/** Ayrılabilir kutu bulanıklığı, 3 geçiş ≈ Gauss. Kaynağı değiştirmez. */
function blurField(src, W, H, r) {
  r = Math.max(1, Math.round(r));
  const a = Float32Array.from(src);
  const b = new Float32Array(W * H);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      let acc = 0;
      const row = y * W;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / (2 * r + 1);
        acc += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
      }
    }
  }
  return a;
}

function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}
function pct(arr, q) {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * Yüz derisi tonu — SAKAL BANDI HARİÇ (2026-10-07, ölçümle).
 *
 * faceQuality.sampleFaceTone yanak bandını (kutunun %45-80'i) kullanıyor; o
 * bant sakallı yüzde SAKALIN üstüne düşüyor. iş 9496348c c1'de ölçüldü:
 *   eski bant L=58.2 | alın 66.7, elmacık 68.6/50.1 (yan ışık), burun 70.0
 * Hedef 10 L koyu kalıyor ve düzeltme kolu yüze değil sakala çekiyordu.
 * Bu yüzden sakal tutmayan bölgeler kullanılır: alın, iki elmacık, burun
 * sırtı. Yan ışıktaki asimetri iki elmacığı birlikte alarak dengelenir.
 * faceSkin verilirse pikseller yüz derisi olasılığıyla ağırlanır (saç
 * tutamı, gözlük çerçevesi dışarıda kalır).
 */
const FACE_BANDS = [
  [0.30, 0.70, 0.02, 0.15], // alın (kaş üstü)
  [0.12, 0.35, 0.40, 0.58], // sol elmacık
  [0.65, 0.88, 0.40, 0.58], // sağ elmacık
  [0.42, 0.58, 0.35, 0.60], // burun sırtı
];
/**
 * YÜZÜN GENEL TONU (2026-10-26, e25dc241, kullanıcı: "yüzdeki cilt tonu ile
 * boyun, el, kol... tam uyuşma içerisinde olmalı, kalıcı olarak çözmeliyiz").
 * faceToneOf'un bantları (alın, elmacıklar, burun sırtı) yüzün en çok ışık
 * alan yerleri: 629b45de'nin ham karelerinde tüm yüz derisi medyanından
 * 1-11 L açık, a ve b +2-3 doygun çıktı. Vücut o parlak noktalara eşitlenince
 * yüzün geneline göre açık ve kırmızı kaldı — ten alanı adımı farkı
 * kapatmak yerine büyütüyordu (c7 boyun ΔE 4.5 → 12.2). Göz yüzün GENEL
 * tonunu görür: ağız hizasının üstündeki (sakal/bıyık dışarıda) bütün yüz
 * derisinin medyanı.
 */
const FACE_WHOLE_TOP = -0.1; // yüz kutusu yüksekliği cinsinden (alın kutunun üstüne taşar)
const FACE_WHOLE_BOTTOM = 0.62; // burun altı: bıyık/sakal başlamadan
const FACE_WHOLE_MIN_PX = 40;
function faceToneWhole(rgb, W, H, box, P, CLASSES) {
  const x0 = Math.max(0, Math.floor(box.x - 0.05 * box.width)), x1 = Math.min(W, Math.ceil(box.x + 1.05 * box.width));
  const y0 = Math.max(0, Math.floor(box.y + FACE_WHOLE_TOP * box.height)), y1 = Math.min(H, Math.ceil(box.y + FACE_WHOLE_BOTTOM * box.height));
  const L = [], A = [], B = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x, o = i * 3;
      if (P[CLASSES.faceSkin][i] < 0.6 || P[CLASSES.hair][i] >= 0.25) continue;
      if (!skinHue(rgb[o], rgb[o + 1], rgb[o + 2])) continue;
      const lab = rgbToLab(rgb[o], rgb[o + 1], rgb[o + 2]);
      L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
    }
  }
  if (L.length < FACE_WHOLE_MIN_PX) return null;
  return [median(L), median(A), median(B)];
}

function faceToneOf(rgb, W, H, box, faceSkin = null) {
  const L = [], A = [], B = [];
  for (const [fx0, fx1, fy0, fy1] of FACE_BANDS) {
    const x0 = Math.max(0, Math.floor(box.x + box.width * fx0));
    const x1 = Math.min(W, Math.ceil(box.x + box.width * fx1));
    const y0 = Math.max(0, Math.floor(box.y + box.height * fy0));
    const y1 = Math.min(H, Math.ceil(box.y + box.height * fy1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x, o = i * 3;
        if (faceSkin && faceSkin[i] < 0.5) continue;
        const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
        if (!skinHue(r, g, b)) continue;
        const lab = rgbToLab(r, g, b);
        L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
      }
    }
  }
  if (L.length < 30) return null;
  return [median(L), median(A), median(B)];
}

/**
 * Ana kişinin bileşeni: kişi olasılığı (1 − arka plan) eşiklenir ve yüz
 * merkezinden BFS yapılır. Arka plandaki insanların derisi dışarıda kalır.
 */
function mainPersonComponent(person, W, H, box) {
  const thr = 0.3;
  const comp = new Uint8Array(W * H);
  const sx = Math.round(box.x + box.width / 2), sy = Math.round(box.y + box.height * 0.6);
  let seed = -1;
  for (let d = 0; d <= Math.round(box.width) && seed < 0; d++) {
    for (let dy = -d; dy <= d && seed < 0; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (person[y * W + x] >= thr) { seed = y * W + x; break; }
      }
    }
  }
  if (seed < 0) return null;
  const stack = [seed];
  comp[seed] = 1;
  let n = 0;
  while (stack.length) {
    const i = stack.pop();
    n++;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && !comp[i - 1] && person[i - 1] >= thr) { comp[i - 1] = 1; stack.push(i - 1); }
    if (x < W - 1 && !comp[i + 1] && person[i + 1] >= thr) { comp[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !comp[i - W] && person[i - W] >= thr) { comp[i - W] = 1; stack.push(i - W); }
    if (y < H - 1 && !comp[i + W] && person[i + W] >= thr) { comp[i + W] = 1; stack.push(i + W); }
  }
  return { comp, n };
}

/**
 * Ten alanını kurar (çalışma çözünürlüğünde).
 * Döner: { fL, fA, fB, conf, count } — conf: çevredeki ten yoğunluğu.
 */
function buildSkinField(rgb, W, H, region, R, faceHue, faceTone = null) {
  const N = W * H;
  const m = new Float32Array(N), sL = new Float32Array(N), sA = new Float32Array(N), sB = new Float32Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) {
    let w = region[i];
    if (w <= 0.05) continue;
    const o = i * 3;
    if (!skinHue(rgb[o], rgb[o + 1], rgb[o + 2])) continue;
    const lab = rgbToLab(rgb[o], rgb[o + 1], rgb[o + 2]);
    // Örnekleme koruması — bkz. HUE_PIX_FULL başlığı.
    const c = Math.hypot(lab[1], lab[2]);
    if (c >= HUE_MIN_CHROMA) w *= ramp(Math.abs(hueOf(lab[1], lab[2]) - faceHue), HUE_PIX_FULL, HUE_PIX_ZERO);
    w *= ramp(c / Math.max(1, lab[0]), CL_PIX_FULL, CL_PIX_ZERO);
    if (faceTone) w *= skinLikeVsFace(lab, faceTone);
    if (w <= 0.05) continue;
    m[i] = w; sL[i] = lab[0] * w; sA[i] = lab[1] * w; sB[i] = lab[2] * w;
    count++;
  }
  const bm = blurField(m, W, H, R);
  const bL = blurField(sL, W, H, R), bA = blurField(sA, W, H, R), bB = blurField(sB, W, H, R);
  for (let i = 0; i < N; i++) {
    const d = bm[i] > 1e-4 ? bm[i] : 1;
    bL[i] /= d; bA[i] /= d; bB[i] /= d;
  }
  return { fL: bL, fA: bA, fB: bB, conf: bm, count };
}

function sampleBilinear(F, W, H, x, y) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const a = F[y0 * W + x0] * (1 - fx) + F[y0 * W + x1] * fx;
  const b = F[y1 * W + x0] * (1 - fx) + F[y1 * W + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Saf düzeltme planı (test edilebilir): ten alanı + yüz tonu -> düzeltme alanları.
 * limbW: noktanın uzuv ağırlığı (0..1).
 */
function bodyTargetL(faceL, bodyLightRatio) {
  if (!(bodyLightRatio > 0)) return faceL;
  const r = Math.min(BODY_LIGHT_MAX, Math.max(BODY_LIGHT_MIN, bodyLightRatio));
  return (faceL + 16) * Math.pow(r, 2.2 / 3) - 16;
}

function planCorrection(field, limbW, faceTone, N, bodyLightRatio = null, local = null) {
  // Medyan/istatistik noktaları: güvenli uzuv (ağırlık > 0.5); azsa (küçük el,
  // karanlık kare) zayıf ağırlıklı noktalar da sayılır.
  let thr = 0.5;
  let limbL = [];
  for (let i = 0; i < N; i++) if (limbW[i] > thr) limbL.push(field.fL[i]);
  if (limbL.length < 20) {
    thr = 0.15;
    limbL = [];
    for (let i = 0; i < N; i++) if (limbW[i] > thr) limbL.push(field.fL[i]);
  }
  if (limbL.length < 20) return null;
  const limbMedL = median(limbL);
  const targetL = bodyTargetL(faceTone[0], bodyLightRatio);
  if (local && local.shade) return planShadeCorrection(field, limbW, faceTone, N, local, thr);

  // HEDEF AÇIKLIK = yüz (şablonun vücut/yüz ışık oranıyla) + IŞIK İZİ
  // (noktanın uzuv medyanından sapmasının OWN_KEEP kadarı). Kolun bir ucunun
  // koyu, öbür ucunun açık kalması (iki tonlu kol) bu sapmadır; çoğu
  // giderilir, ışık izi kalır.
  // YEREL ŞABLON IŞIĞI (local, bkz. LOCAL_LIGHT): şablonda bu noktadaki
  // deri yüze göre daha aydınlıksa hedef oraya YÜKSELİR, asla inmez.
  const dL = new Float32Array(N), dA = new Float32Array(N), dB = new Float32Array(N);
  const beforeL = [], afterL = [], beforeC = [], afterC = [], baseT = [];
  for (let i = 0; i < N; i++) {
    if (limbW[i] <= 0) continue;
    const allowL = clamp((field.fL[i] - limbMedL) * OWN_KEEP, MAX_LIGHT_ALLOW);
    let t = targetL + allowL, tb = targetL;
    if (local && local.w[i] > 0) {
      const lt = bodyTargetL(faceTone[0], local.ratio[i]);
      t = Math.max(t, t + (lt - t) * local.w[i]);
      tb = Math.max(tb, tb + (lt - tb) * local.w[i]);
    }
    if (limbW[i] > thr) baseT.push(tb);
    dL[i] = clamp((t - field.fL[i]) * STRENGTH, MAX_SHIFT_L);
    dA[i] = clamp((faceTone[1] - field.fA[i]) * STRENGTH, MAX_SHIFT_AB);
    dB[i] = clamp((faceTone[2] - field.fB[i]) * STRENGTH, MAX_SHIFT_AB);
    if (limbW[i] > thr) {
      beforeL.push(field.fL[i]); afterL.push(field.fL[i] + dL[i]);
      beforeC.push(Math.hypot(faceTone[1] - field.fA[i], faceTone[2] - field.fB[i]));
      afterC.push(Math.hypot(faceTone[1] - field.fA[i] - dA[i], faceTone[2] - field.fB[i] - dB[i]));
    }
  }
  const stats = {
    // Yüz − uzuv açıklık farkı (medyan) ve kroma farkı.
    deltaLBefore: median(baseT) - median(beforeL), deltaLAfter: median(baseT) - median(afterL),
    chromaBefore: median(beforeC), chromaAfter: median(afterC),
    // İKİ TONLU KOL ÖLÇÜSÜ: uzuv alanındaki açıklık yayılımı (p90 − p10).
    spreadBefore: pct(beforeL, 0.9) - pct(beforeL, 0.1),
    spreadAfter: pct(afterL, 0.9) - pct(afterL, 0.1),
  };
  const worst = Math.max(Math.abs(stats.deltaLBefore), stats.chromaBefore, stats.spreadBefore / 2);
  return { dL, dA, dB, stats, needed: worst >= MIN_DELTA };
}

/**
 * ŞABLON GÖLGELİ PLAN (bkz. TPL_SHADE_KEEP). local: { shade, w } — şablonda
 * bu noktadaki derinin yüzüne göre L farkı (paylı, sınırlı) ve güveni.
 * Hedef açıklık = yüz + shade; şablonda deri bulunmayan yerde kendi ışığı
 * korunur, yalnız ortanca ten (yüz−vücut) farkı eklenir. Kroma yüze. SAF.
 */
function planShadeCorrection(field, limbW, faceTone, N, local, thr) {
  const offs = [];
  for (let i = 0; i < N; i++) {
    if (limbW[i] > thr && local.w[i] > 0.5) offs.push(faceTone[0] + local.shade[i] - field.fL[i]);
  }
  // Şablonda karşılığı olmayan uzuvlar için ortanca ten farkı; hiç karşılık
  // yoksa uzuv yüzle aynı tene (eski davranış, ışık izi korunur).
  const off = offs.length >= 20 ? median(offs) : null;
  const dL = new Float32Array(N), dA = new Float32Array(N), dB = new Float32Array(N);
  const gapBefore = [], gapAfter = [], beforeL = [], afterL = [], beforeC = [], afterC = [];
  for (let i = 0; i < N; i++) {
    if (limbW[i] <= 0) continue;
    const fl = field.fL[i];
    const own = off != null ? fl + off : faceTone[0];
    const w = local.w[i];
    const t = w * (faceTone[0] + local.shade[i]) + (1 - w) * own;
    dL[i] = clamp((t - fl) * STRENGTH, MAX_SHIFT_L);
    if (dL[i] < 0) {
      const sh = Math.abs(local.shade[i]) * w;
      const allow = TPL_DARKEN_MAX * ramp(sh, TPL_DARKEN_SHADE_FULL, TPL_DARKEN_SHADE_ZERO);
      if (dL[i] < -allow) dL[i] = -allow;
    }
    dA[i] = clamp((faceTone[1] - field.fA[i]) * STRENGTH, MAX_SHIFT_AB);
    dB[i] = clamp((faceTone[2] - field.fB[i]) * STRENGTH, MAX_SHIFT_AB);
    if (limbW[i] > thr) {
      gapBefore.push(t - fl); gapAfter.push(t - fl - dL[i]);
      beforeL.push(fl); afterL.push(fl + dL[i]);
      beforeC.push(Math.hypot(faceTone[1] - field.fA[i], faceTone[2] - field.fB[i]));
      afterC.push(Math.hypot(faceTone[1] - field.fA[i] - dA[i], faceTone[2] - field.fB[i] - dB[i]));
    }
  }
  const stats = {
    // Hedefe (yüz + şablon gölgesi) uzaklık, kroma farkı ve iç yayılım.
    deltaLBefore: median(gapBefore), deltaLAfter: median(gapAfter),
    chromaBefore: median(beforeC), chromaAfter: median(afterC),
    spreadBefore: pct(beforeL, 0.9) - pct(beforeL, 0.1),
    spreadAfter: pct(afterL, 0.9) - pct(afterL, 0.1),
    shaded: true,
  };
  const worst = Math.max(Math.abs(stats.deltaLBefore), stats.chromaBefore);
  return { dL, dA, dB, stats, needed: worst >= MIN_DELTA };
}

/**
 * @param {Buffer} outputBuf  teslim edilecek kare (tam kadraj)
 * @param {{bodyLightRatio?: number|null}} [opts]  şablonda vücut/yüz derisi parlaklık oranı
 * @returns {{buf, applied, reason, deltaLBefore, deltaLAfter, chromaBefore, chromaAfter, spreadBefore, spreadAfter, skinPx, changedPx}}
 */
/**
 * Yüz tonu, vücut derisi alanı ve uzuv ağırlığı (çalışma ölçeğinde). Hem
 * çıktıda hem şablonda (vücut/yüz oranı için) kullanılır.
 * @returns {{ok:true, W, H, N, sc, faceTone, field, limbW} | {ok:false, reason, skinPx?}}
 */
/**
 * KİŞİ KIRPIMINDA SINIFLANDIRMA (2026-10-26, kullanıcı: "tam uyuşma"):
 * model girişi sabit 256×256; bütün kare sıkıştırılınca tam boy karede el
 * 3-4 piksele iniyor, "vücut derisi" bulunamıyor ve gölgedeki el yüzden
 * 15 L koyu kalıyordu (62107c2d ab c3). Sınıflandırma yüzden kestirilen
 * kişi kırpımında yapılır (eller dahil: 3 yüz eni sola, 4 sağa, 9 yüz boyu
 * aşağı); kırpım dışı arka plan sayılır.
 */
const PERSON_CROP = { left: 3, right: 4, up: 0.8, down: 9 };
async function personCropProbs(work, W, H, box, classProbs, CLASSES) {
  const x0 = Math.max(0, Math.floor(box.x - PERSON_CROP.left * box.width));
  const x1 = Math.min(W, Math.ceil(box.x + PERSON_CROP.right * box.width));
  const y0 = Math.max(0, Math.floor(box.y - PERSON_CROP.up * box.height));
  const y1 = Math.min(H, Math.ceil(box.y + PERSON_CROP.down * box.height));
  const w = x1 - x0, h = y1 - y0;
  if (w < 16 || h < 16 || (w === W && h === H)) return classProbs(work, W, H);
  const crop = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) work.copy(crop, y * w * 3, ((y + y0) * W + x0) * 3, ((y + y0) * W + x1) * 3);
  const C = await classProbs(crop, w, h);
  const P = C.map(() => new Float32Array(W * H));
  P[CLASSES.background].fill(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, g = (y + y0) * W + x + x0;
      for (let c = 0; c < C.length; c++) P[c][g] = C[c][i];
    }
  }
  return P;
}

/**
 * ŞABLON KIYAFET VETOSU (2026-10-27, 62107c2d ab c3): kişi kırpımında model
 * koyu kahve süet ceketin panelini "vücut derisi" sandı (softmax 0.65-0.87)
 * ve ten alanı paneli açık beje boyadı. Çıktının kendi kıyafet skoruyla veto
 * olmadı: kumaşın önündeki gerçek eller de kıyafet skoru alıyor (20 karenin
 * 5'inde elin yarısı gidiyordu). Çıktı şablonla aynı kadrajda, kıyafet
 * şablondan geri yükleniyor ve model ellere dokunmuyor: şablonda o nokta
 * açıkça kıyafetse ve yakınında (el kayması payı) ten yoksa çıktıdaki "ten"
 * kumaştır. 20 karede: ab c3 tenin %59'u (ceket paneli), diğerleri %0-1.8.
 * Not: skinSeg değerleri softmax değil, [0,1]'e kırpılmış ham skorlar.
 */
const TPL_CLOTH_ZERO = 0.4;
const TPL_CLOTH_FULL = 0.8;
const TPL_SKIN_NEAR_ZERO = 0.25;
const TPL_SKIN_NEAR_FULL = 0.6;
// Şablon teninin aranacağı yarıçap, çıktı yüz boyunun payı.
const TPL_SKIN_NEAR_RADIUS = 0.25;

/** Ayrılabilir kare en büyük süzgeci (genişletme). Kaynağı değiştirmez. */
function maxField(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (src[y * W + k] > m) m = src[y * W + k];
      tmp[y * W + x] = m;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) if (tmp[k * W + x] > m) m = tmp[k * W + x];
      out[y * W + x] = m;
    }
  }
  return out;
}

/** Çıktının çalışma ölçeğinde (W×H) 0..1 veto; şablonda yüz yoksa null. */
async function templateClothVeto(templateBuf, W, H, faceH, classProbs, CLASSES) {
  const { detectMainFace } = require("./faceQuality");
  const meta = await sharp(templateBuf).metadata();
  if (!meta.width || !meta.height) return null;
  const face = (await detectMainFace(templateBuf)) || (await detectMainFace(templateBuf, 0.1));
  if (!face) return null;
  const sx = W / meta.width, sy = H / meta.height;
  const box = { x: face.box.x * sx, y: face.box.y * sy, width: face.box.width * sx, height: face.box.height * sy };
  const work = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const P = await personCropProbs(work, W, H, box, classProbs, CLASSES);
  const N = W * H;
  const tSkin = new Float32Array(N);
  for (let i = 0; i < N; i++) tSkin[i] = Math.max(P[CLASSES.bodySkin][i], P[CLASSES.faceSkin][i]);
  const near = maxField(tSkin, W, H, Math.max(2, Math.round(faceH * TPL_SKIN_NEAR_RADIUS)));
  const veto = new Float32Array(N);
  const cloth = P[CLASSES.clothes];
  for (let i = 0; i < N; i++) {
    if (cloth[i] <= TPL_CLOTH_ZERO) continue;
    veto[i] = (1 - ramp(cloth[i], TPL_CLOTH_ZERO, TPL_CLOTH_FULL)) * ramp(near[i], TPL_SKIN_NEAR_ZERO, TPL_SKIN_NEAR_FULL);
  }
  return veto;
}

async function analyzeSkin(buf, { lowConf = false, templateBuf = null, faceGate = false } = {}) {
  const { detectMainFace } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const meta = await sharp(buf).metadata();
  const FW = meta.width, FH = meta.height;
  if (!FW || !FH) return { ok: false, reason: "insufficient-input" };
  const sc = Math.min(1, WORK_MAX_DIM / Math.max(FW, FH));
  const W = Math.max(1, Math.round(FW * sc)), H = Math.max(1, Math.round(FH * sc));
  const N = W * H;
  const face = (await detectMainFace(buf)) || (lowConf ? await detectMainFace(buf, 0.1) : null);
  if (!face) return { ok: false, reason: "no-face" };
  const box = { x: face.box.x * sc, y: face.box.y * sc, width: face.box.width * sc, height: face.box.height * sc };
  const work = await sharp(buf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const P = await personCropProbs(work, W, H, box, classProbs, CLASSES);
  const bodySkin = P[CLASSES.bodySkin], faceSkin = P[CLASSES.faceSkin];
  const person = new Float32Array(N);
  for (let i = 0; i < N; i++) person[i] = 1 - P[CLASSES.background][i];
  const faceTone = faceToneWhole(work, W, H, box, P, CLASSES) || faceToneOf(work, W, H, box, faceSkin) || faceToneOf(work, W, H, box);
  if (!faceTone) return { ok: false, reason: "no-face-tone" };
  const pc = mainPersonComponent(person, W, H, box);
  if (!pc) return { ok: false, reason: "no-person" };
  let veto = null;
  if (templateBuf) {
    try {
      veto = await templateClothVeto(templateBuf, W, H, box.height, classProbs, CLASSES);
    } catch (e) {
      console.error("Ten alanı: şablon kıyafet vetosu hesaplanamadı (vetosuz):", e.message || e);
    }
  }
  // Bölge = ana kişinin VÜCUT DERİSİ olasılığı (yüz derisi, saç, kıyafet,
  // aksesuar zaten bu sınıfta değil).
  const othersNear = blurField(P[CLASSES.others], W, H, OTHERS_RADIUS);
  const region = new Float32Array(N);
  let vetoed = 0, skinRaw = 0;
  for (let i = 0; i < N; i++) {
    if (!pc.comp[i]) continue;
    region[i] = smooth01((bodySkin[i] - BODY_SKIN_ZERO) / (BODY_SKIN_FULL - BODY_SKIN_ZERO)) *
      ramp(othersNear[i], OTHERS_FULL, OTHERS_ZERO);
    if (faceGate && region[i] > 0) region[i] *= neckExclusion(i % W, (i / W) | 0, box);
    if (veto && region[i] > 0) {
      skinRaw += region[i];
      vetoed += region[i] * veto[i];
      region[i] *= 1 - veto[i];
    }
  }
  const clothVeto = veto ? (skinRaw > 0 ? vetoed / skinRaw : 0) : null;
  const R = Math.max(4, box.height * FIELD_RADIUS_VS_FACE);
  const faceHue = hueOf(faceTone[1], faceTone[2]);
  const field = buildSkinField(work, W, H, region, R, faceHue, faceGate ? faceTone : null);
  if (field.count < MIN_SKIN_PX) return { ok: false, reason: "insufficient-skin", skinPx: field.count, clothVeto };
  // Uzuv ağırlığı: bölge × alan güveni (çevrede yeterli ten yoksa alan
  // güvenilmez). İkisi de sürekli.
  const limbW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (region[i] <= 0.02) continue;
    limbW[i] = region[i] * smooth01((field.conf[i] - LIMB_CONF_ZERO) / LIMB_CONF_SPAN);
  }
  // region/box: el onarımı maskesi için (handRepair.js) — vücut derisi bölgesi çalışma ölçeğinde.
  return { ok: true, W, H, N, sc, faceTone, field, limbW, faceSkin, clothVeto, faceH: box.height, region, box };
}

/**
 * Yüz, vücut derisinden koyu veya farklı kromadaysa yüzü vücuda çeker
 * (b2a9537d c1 yüz boyundan soluk; 29cf877a c9 yüz kollarla uyuşmuyor).
 * Yüzü KARARTMAZ — yalnız açar ve kroma kaydırır.
 */
const FACE_LIFT_MIN = 3.5;
const FACE_CHROMA_MIN = 4;
function planFaceMatch(faceTone, limbW, field, N, local = null) {
  const Ls = [], As = [], Bs = [];
  for (let i = 0; i < N; i++) {
    if (limbW[i] > 0.5) {
      // Şablon gölgesi varsa vücudun açıklığı ondan arındırılır: güneşteki
      // kol yüzü "soluk" gösterip açtırmasın.
      Ls.push(field.fL[i] - (local && local.shade ? local.shade[i] * local.w[i] : 0));
      As.push(field.fA[i]); Bs.push(field.fB[i]);
    }
  }
  if (Ls.length < 20) return { needed: false };
  const bL = median(Ls), bA = median(As), bB = median(Bs);
  const dL = Math.max(0, bL - faceTone[0]);
  const dA = bA - faceTone[1];
  const dB = bB - faceTone[2];
  const chroma = Math.hypot(dA, dB);
  return {
    needed: dL >= FACE_LIFT_MIN || chroma >= FACE_CHROMA_MIN,
    dL: Math.min(12, dL * 0.75),
    dA: clamp(dA * 0.45, 6),
    dB: clamp(dB * 0.45, 6),
  };
}

/**
 * ŞABLONUN KOL/YÜZ IŞIK ORANI (2026-10-16, iş 629b45de c8, kullanıcı: "kolları
 * gereksiz yere koyulaştırmış, base'deki ten ile çıktıdaki ten benzer").
 * 2026-10-16 sabahı oran base'in BOYNUNDAN alınıyordu (faceRelight): boyun
 * çenenin gölgesinde (yüz/boyun 1.75), güneşteki kollar 0.75'e karartıldı.
 * Oran artık şablonun kendi KOLLARINDAN — aynı segmentasyon ve aynı uzuv
 * ağırlığıyla. bodyTargetL'nin ölçeğinde döner; ölçülemezse null.
 */
function lightRatioOf(L, faceL) {
  return Math.pow((L + 16) / (faceL + 16), 3 / 2.2);
}

async function templateSkin(templateBuf) {
  const a = await analyzeSkin(templateBuf, { lowConf: true });
  if (!a.ok) return null;
  const limbL = [];
  for (let i = 0; i < a.N; i++) if (a.limbW[i] > 0.5) limbL.push(a.field.fL[i]);
  if (limbL.length < 20) return null;
  return { a, ratio: lightRatioOf(median(limbL), a.faceTone[0]) };
}

async function templateBodyLightRatio(templateBuf) {
  const t = await templateSkin(templateBuf);
  return t ? t.ratio : null;
}

/**
 * YEREL ŞABLON IŞIĞI (2026-10-18, iş 10ee6a46 c3, kullanıcı: "kollar siyah
 * kalmış, siyahi biri taban fotoğrafta olunca"). Şablonda sağ ön kol yüzle
 * aynı aydınlıktaydı (56.6 / yüz 57.3), çıktıda yüzden 7 L koyu kaldı. Tek
 * oran (0.91) boyun/el gölgesini ve dövmeli kolu da içerdiğinden kolun
 * kendisi "hedefte" sayıldı (fark 1.8) ve katman kolu neredeyse hiç açmadı.
 * Çıktı şablonla aynı kadrajda (arka plan geri yüklemesi buna dayanır):
 * şablonun düşük frekanslı ten alanı aynı noktada okunur.
 * YALNIZ YUKARI: yerel oran yalnız hedefi yükseltir. Dövme ve gölge şablonu
 * koyulaştırır, aydınlatmaz — 9496348c c9'da piksel payını çıkartan kusur
 * (dövmeli kol taşındı) bu yönde oluşamaz. Oran BODY_LIGHT_* ile sınırlı.
 */
const LOCAL_LIGHT = true;
function localTemplateLight(t, W, H) {
  const { a } = t;
  const N = W * H;
  const ratio = new Float32Array(N), w = new Float32Array(N);
  const kx = a.W / W, ky = a.H / H;
  for (let y = 0; y < H; y++) {
    const ty = (y + 0.5) * ky - 0.5;
    for (let x = 0; x < W; x++) {
      const tx = (x + 0.5) * kx - 0.5;
      const conf = sampleBilinear(a.field.conf, a.W, a.H, tx, ty);
      const i = y * W + x;
      w[i] = smooth01((conf - 0.08) / 0.22);
      if (w[i] > 0) ratio[i] = lightRatioOf(sampleBilinear(a.field.fL, a.W, a.H, tx, ty), a.faceTone[0]);
    }
  }
  return { ratio, w };
}

/**
 * ŞABLON GÖLGESİ VE DERİ VARLIĞI (bkz. TPL_SHADE_KEEP, TPL_PRESENCE_*).
 * a: şablonun analyzeSkin sonucu. Çıktının W×H ızgarasında döner:
 * shade (şablon derisi − şablon yüzü, L; paylı ve sınırlı), w (güven),
 * presence (şablonda yakında vücut ya da yüz derisi, 0..1). SAF.
 */
function templateShade(a, W, H) {
  const N = W * H;
  const shade = new Float32Array(N), w = new Float32Array(N), presence = new Float32Array(N);
  // Şablon ızgarasında deri varlığı, poz kayması payı kadar genişletilmiş.
  const raw = new Float32Array(a.N);
  for (let i = 0; i < a.N; i++) {
    const f = a.faceSkin ? smooth01((a.faceSkin[i] - 0.3) / 0.4) : 0;
    raw[i] = Math.max(a.limbW[i], f);
  }
  const r = Math.max(2, Math.round(TPL_PRESENCE_RADIUS * a.faceH));
  const grown = maxField(raw, a.W, a.H, r);
  const kx = a.W / W, ky = a.H / H;
  for (let y = 0; y < H; y++) {
    const ty = (y + 0.5) * ky - 0.5;
    for (let x = 0; x < W; x++) {
      const tx = (x + 0.5) * kx - 0.5;
      const i = y * W + x;
      presence[i] = smooth01((sampleBilinear(grown, a.W, a.H, tx, ty) - TPL_PRESENCE_ZERO) / (TPL_PRESENCE_FULL - TPL_PRESENCE_ZERO));
      const conf = sampleBilinear(a.field.conf, a.W, a.H, tx, ty);
      w[i] = smooth01((conf - 0.08) / 0.22);
      if (w[i] > 0) {
        const d = (sampleBilinear(a.field.fL, a.W, a.H, tx, ty) - a.faceTone[0]) * TPL_SHADE_KEEP;
        shade[i] = d < TPL_SHADE_MIN ? TPL_SHADE_MIN : d > TPL_SHADE_MAX ? TPL_SHADE_MAX : d;
      }
    }
  }
  return { shade, w, presence };
}

// KOYU ŞABLONDA ŞABLON GÖLGESİ TAŞINMAZ (2026-11-22, 185655bf c3, kullanıcı: "kol doğrudan yüzün
// tenine çekilmeli"). templateShade şablondaki kol−yüz farkını ışık sayıyor; şablon kişisi kullanıcıdan
// en az bu kadar MST koyuysa o fark kısmen tendir (siyahi şablonun kolu yüzünden koyu) ve %80'i
// kullanıcının koluna taşınıyordu (kol 12.9 L "düzeldi" ama yüzden koyu kaldı). Bu durumda gölge
// 0: hedef doğrudan yüz tonu; şablon deri varlığı kapısı (bej pantolon) aynen kalır.
const SHADE_PIGMENT_GAP = 2;
async function correctSkinToneField(outputBuf, { bodyLightRatio = null, templateBuf = null, localLight = LOCAL_LIGHT, faceLocked = false, pigmentGap = null } = {}) {
  const skip = (reason, extra = {}) => ({ applied: false, reason, buf: null, bodyLightRatio, ...extra });
  try {
    // Şablonun ten analizi: gölge (vücut − yüz) ve deri varlığı. 10-27'den beri
    // oran sabit 1.0 olduğu için hiç ölçülmüyordu (bkz. TPL_SHADE_KEEP).
    let tA = null;
    if (templateBuf && localLight) {
      try {
        const a = await analyzeSkin(templateBuf, { lowConf: true });
        if (a.ok) tA = a;
      } catch (e) {
        console.error("Ten alanı: şablon teni ölçülemedi (yüz hedefi, şablon kapısı yok):", e.message || e);
      }
    }
    if (BODY_LIGHT_MIN >= BODY_LIGHT_MAX) bodyLightRatio = BODY_LIGHT_MIN;
    const an = await analyzeSkin(outputBuf, { templateBuf, faceGate: faceLocked });
    if (!an.ok) return skip(an.reason, an.skinPx != null ? { skinPx: an.skinPx, clothVeto: an.clothVeto } : {});
    const { W, H, N, faceTone, field, faceSkin, clothVeto } = an;
    let limbW = an.limbW;
    const local = tA ? templateShade(tA, W, H) : null;
    const shadeDropped = !!(local && Number.isFinite(pigmentGap) && pigmentGap >= SHADE_PIGMENT_GAP);
    if (shadeDropped) local.shade.fill(0);
    let tplAbsent = null;
    if (local) {
      // Şablonda yakınında deri olmayan nokta boyanmaz (c3 bej pantolon).
      limbW = new Float32Array(N);
      let all = 0, kept = 0;
      for (let i = 0; i < N; i++) {
        if (an.limbW[i] <= 0) continue;
        limbW[i] = an.limbW[i] * local.presence[i];
        all += an.limbW[i]; kept += limbW[i];
      }
      tplAbsent = all > 0 ? 1 - kept / all : 0;
    }
    // ORTAK HEDEF (2026-10-26): yüz vücuda doğru çekiliyorsa (planFaceMatch)
    // vücut yüzün ESKİ tonuna değil, çekilmiş tonuna gider. Eskiden ikisi
    // birbirinin eski yerine geçip farkı ters yönde bırakabiliyordu.
    // YÜZ KİLİDİ (2026-11-03, 7e04933e c5, kullanıcı: "yüz ten rengi ile tüm
    // vücut teni uyuşmalı"): model base'in elini değiştirmeden bırakınca
    // "vücut" base kişisinin tenidir; yüzü ona çekmek yüzü base tenine boyadı.
    // Ölçü yüzün kendisi; yalnız vücut yüze gelir.
    const faceMatch = faceLocked ? { needed: false } : planFaceMatch(faceTone, limbW, field, N, local);
    const bodyTone = faceMatch.needed
      ? [faceTone[0] + faceMatch.dL, faceTone[1] + faceMatch.dA, faceTone[2] + faceMatch.dB]
      : faceTone;
    const plan = planCorrection(field, limbW, bodyTone, N, bodyLightRatio, local);
    if (!plan) return skip("no-limb-skin", { skinPx: field.count, clothVeto, tplAbsent, shadeDropped });
    const stats = { ...plan.stats, skinPx: field.count, clothVeto, tplAbsent, shadeDropped };
    if (!plan.needed && !faceMatch.needed) return skip("tone-already-matches", stats);

    // Bölge ağırlığını hafifçe yumuşat (sınıf sınırı basamak bırakmasın).
    const wS = blurField(limbW, W, H, REGION_BLUR);

    // Tam çözünürlükte uygula. Kroma rampası PİKSEL başına ama sürekli.
    const { data, info } = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const kx = W / info.width, ky = H / info.height;
    // YUMUŞAK PİKSEL AĞIRLIĞI (yüz kilidinde, 7e04933e c4): piksel kapıları koyu
    // kol kıllarını dışarıda bırakınca deri açılıp kıllar koyu kaldı — kol
    // lekeli göründü. Ağırlık önce tam çözünürlükte hesaplanır, PIX_SOFT × yüz
    // boyu yarıçapla yumuşatılır; kıl çevresiyle birlikte kayar.
    let soft = null;
    if (faceLocked && plan.needed) {
      const FW = info.width, FH = info.height;
      soft = new Float32Array(FW * FH);
      for (let Y = 0; Y < FH; Y++) {
        const y = (Y + 0.5) * ky - 0.5;
        for (let X = 0; X < FW; X++) {
          const x = (X + 0.5) * kx - 0.5;
          const w0 = sampleBilinear(wS, W, H, x, y);
          if (w0 <= 0.004) continue;
          const o = (Y * FW + X) * 3;
          const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
          const fa = sampleBilinear(field.fA, W, H, x, y), fb = sampleBilinear(field.fB, W, H, x, y);
          let w = w0 * ramp(Math.hypot(lab[1] - fa, lab[2] - fb), CHROMA_FULL, CHROMA_ZERO);
          if (local && w > 0.004) {
            const fl = sampleBilinear(field.fL, W, H, x, y);
            w *= ramp(Math.hypot(lab[1] - fa, lab[2] - fb), PIX_AB_FULL, PIX_AB_ZERO) *
              ramp(Math.max(0, fl - lab[0]), PIX_DARK_FULL, PIX_DARK_ZERO);
          }
          if (w > 0.004) w *= skinLikeVsFace(lab, faceTone);
          soft[Y * FW + X] = w;
        }
      }
      const faceHFull = an.faceH / an.sc;
      soft = blurField(soft, FW, FH, Math.max(2, PIX_SOFT * faceHFull));
    }
    let changed = 0;
    for (let Y = 0; Y < info.height; Y++) {
      const y = (Y + 0.5) * ky - 0.5;
      for (let X = 0; X < info.width; X++) {
        const x = (X + 0.5) * kx - 0.5;
        const w0 = sampleBilinear(wS, W, H, x, y);
        const fw = faceMatch.needed ? sampleBilinear(faceSkin, W, H, x, y) : 0;
        if (w0 <= 0.004 && fw <= 0.15 && !(soft && soft[Y * info.width + X] > 0.004)) continue;
        const o = (Y * info.width + X) * 3;
        const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
        let dL = 0, dA = 0, dB = 0;
        if (soft) {
          const w = soft[Y * info.width + X];
          if (w > 0.004) {
            dL += sampleBilinear(plan.dL, W, H, x, y) * w;
            dA += sampleBilinear(plan.dA, W, H, x, y) * w;
            dB += sampleBilinear(plan.dB, W, H, x, y) * w;
          }
        } else if (plan.needed && w0 > 0.004) {
          const fa = sampleBilinear(field.fA, W, H, x, y), fb = sampleBilinear(field.fB, W, H, x, y);
          let w = w0 * ramp(Math.hypot(lab[1] - fa, lab[2] - fb), CHROMA_FULL, CHROMA_ZERO);
          if (faceLocked && w > 0.004) w *= skinLikeVsFace(lab, faceTone);
          // Piksel deri kapısı (bkz. PIX_*): şablon kapısı varken sıkı.
          if (local && w > 0.004) {
            const fl = sampleBilinear(field.fL, W, H, x, y);
            w *= ramp(Math.hypot(lab[1] - fa, lab[2] - fb), PIX_AB_FULL, PIX_AB_ZERO) *
              ramp(Math.max(0, fl - lab[0]), PIX_DARK_FULL, PIX_DARK_ZERO);
          }
          if (w > 0.004) {
            dL += sampleBilinear(plan.dL, W, H, x, y) * w;
            dA += sampleBilinear(plan.dA, W, H, x, y) * w;
            dB += sampleBilinear(plan.dB, W, H, x, y) * w;
          }
        }
        if (faceMatch.needed && fw > 0.15) {
          const f = smooth01((fw - 0.15) / 0.55);
          dL += faceMatch.dL * f;
          dA += faceMatch.dA * f;
          dB += faceMatch.dB * f;
        }
        if (dL === 0 && dA === 0 && dB === 0) continue;
        let L = lab[0] + dL;
        L = L < 0 ? 0 : L > 100 ? 100 : L;
        const rgb = labToRgb(L, lab[1] + dA, lab[2] + dB);
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
        changed++;
      }
    }
    const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
      // Ara adım: kayıpsız (teslimde tek JPEG kodlaması, bkz. postProcess).
      .png().toBuffer();
    return { buf, applied: true, reason: null, ...stats, changedPx: changed, bodyLightRatio };
  } catch (e) {
    console.error("Ten tonu alan düzeltmesi hata verdi (fail-safe atlandı):", e.message || e);
    return skip("error");
  }
}

module.exports = {
  correctSkinToneField,
  neckExclusion,
  skinLikeVsFace,
  personCropProbs,
  rgbToLab,
  labToRgb,
  _testables: { analyzeSkin, templateBodyLightRatio, blurField, maxField, mainPersonComponent, buildSkinField, planCorrection, planShadeCorrection, planFaceMatch, templateShade, bodyTargetL, faceToneOf, skinHue, TPL_SHADE_KEEP, TPL_SHADE_MIN },
};
