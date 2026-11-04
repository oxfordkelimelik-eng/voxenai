// KAFA ÇEVRESİ (2026-10-11, iş d44b63e8, kullanıcı: "kafanın üst kısmındaki
// silüetlenme, renklenme, küçültmeden dolayı oynama gibi problemleri kesin
// olarak çözmeliyiz").
//
// SORUN: arka plan geri yüklemesi şablon kafasının çevresindeki elipsi
// (yüz kutusunun 2.6 x 3 katı) hiç şablondan almıyordu; o elipste modelin
// kendi çizdiği arka plan kalıyordu (ton farkı = kafa çevresinde hale, c3/c6;
// kayık derz = 3b16bf69 c7). Sonraki saçak temizliği bu 100-160 bin piksellik
// bölgeyi AI ile yeniden boyuyor, AI'nin kişi çizdiği yerlere doku yaması
// koyuyordu; kare dilatasyonlu koruma bantları ve "kaşın üstü AI, altı model"
// kuralı saçın arkasında basamaklı/tırtıklı kenarlar bıraktı (c2, c4, c5),
// karanlık siyah-beyaz karede saçı sildi (c4).
//
// ÇÖZÜM: şablondan GERÇEKTEN alınamayan yer yalnızca şablon kafasının kendi
// silüetidir (saç, yüz, aksesuar — biraz genişletilmiş). Geri yükleme elips
// yerine bu silüeti dışarıda bırakır (templateHeadMask); geriye kalan şerit =
// şablon kafası ∖ yeni kafa (+ hayalet saç, saçak telleri, kafa küçültmenin
// açtığı delik). Bu şerit tek bir dolguyla doldurulur; dışı şablonun gerçek
// arka planı olduğu için çizgiler doğru yerden sürer.
//
// DOLGU YEREL MODELLE (2026-10-12, e0eb8dd5): OpenAI maskeli düzenlemesi
// kırpımın tamamını yeniden çiziyordu — renk/doku kayması kareyi reddettirdi
// (c4, c8 küçültülemedi; c2/c5/c6 temizlenemedi), kabul edilen karelerde de
// eski kafanın sınırında açık yay (c1), saçın boyanması (c7), kişi çizilen
// yerde bulanık blok kaldı. LaMa (bkz. lamaFill.js) yalnız maskeyi doldurur,
// kişi çizmez, maliyeti yok; reddetme kapısı gerekmez.

const sharp = require("sharp");

// Şablon kafası silüeti: çok sınıflı modelde saç+yüz derisi+aksesuar ya da
// (kaşların üstünde) kişi maskesinin en soluk hâli. Soluk teller maskede
// görünmez — kaş üstünde genişletme daha büyük.
const TPL_HEAD_CLASS_MIN = 0.3;
const TPL_STRAND_MIN = 0.05;
const TPL_GROW_FACE = 0.06; // yüz genişliğine oranla
const TPL_GROW_TOP_FACE = 0.1;
// Yeni kafanın dolu gövdesi (açma yarıçapı), yüz genişliğine oranla.
const CORE_OPEN_FACE = 0.08;
const FRINGE_RING_FACE = 0.25;
const SOFT_EDGE_FACE = 0.012;
const SOFT_EDGE_OUT_FACE = 0.04;
// Delik yoksa hayalet+saçak bu kadardan (yüz alanına oranla) azsa AI'ye
// gidilmez: birkaç yüz piksel kafanın kendi yumuşak saç kenarıdır, dolgu
// yalnızca risk getirir (d44b63e8 c2/c3/c6: 300-1500 px, kenar temizdi).
const MIN_DEFECT_FACE2 = 0.05;
// İNCE HAYALET TELLER (2026-10-11, f3539078 c0): şablon kişisinin kabarık
// saçından kalan gri teller incedir, piksel sayısı eşiğin altında kaldı
// (hayalet=656) ve kare "clean" sayıldı. Kafanın kendi yumuşak saç kenarı
// dolu gövdeye yapışıktır; hayalet teller ondan uzağa uzanır. Dolu gövdeden
// bu kadar (yüz genişliğine oranla) uzaktaki hayalet pikseller sayıca az da
// olsa dolguyu tetikler.
const GHOST_FAR_FACE = 0.08;
const GHOST_FAR_MIN_FACE2 = 0.004;
// SAYDAM HAYALETTEKİ ADACIKLAR (2026-10-18, d87c25b4 c0): hayaletin içindeki
// birkaç piksellik koyu benekler "kafaya bağlı olmayan nesne" (şemsiye
// kuralı) ya da saçın üstüne yapışık "kullanıcının dolu saçı" sayılıp
// korundu; dolgudan sonra saçın üstünde leke ve benek olarak kaldı. Saydam
// hayalet varsa, kaş üstünde hayalete değen ve bu kadardan (yüz alanına
// oranla) küçük korunan parçalar korunmaz (c3: 0.009 yüz²lük koyu tel tek
// başına kaldı; c1/c2 parçaları <= 0.0025). Perçem/tutam bundan büyüktür.
const SPECK_MAX_FACE2 = 0.012;
// Şablonda kafa sınıfı olmayan pikselde çıktı şablondan kanal başına en çok
// bu kadar farklıysa sahnenin kendisidir, hayalet değil (bkz. ŞABLONUN SAHNESİ).
const SCENE_MATCH_MAX = 24;
// Bundan (yüz genişliğine oranla) ince sahne parçası saç telidir, hayalet kalır.
const SCENE_OPEN_FACE = 0.03;
// Kaş altında kişi maskesinde dolu ve rengi kullanıcının yüz derisine yakın
// piksel (a*b* uzaklığı, açıklık aralığı) kullanıcının derisidir, hayalet
// değil — sınıf olasılığı boyunda kararsız (3d1d2a71 c4: aynı boyun ham
// karede deri 0.03, katman sonrası 0.86). Silinen gerçek hayaletler
// grimsi/koyu (Lab 19/−1/0, 24/1/4, 57/−1/1); boyun 58/8/13, yüz 52/14/16.
const SKIN_LIKE_AB = 9;
const SKIN_LIKE_L_BELOW = 25;
const SKIN_LIKE_L_ABOVE = 12;
// Küçültme deliğinde yeni kafanın korunan yumuşak kenarı, yüz genişliğine oranla.
const HEAD_SOFT_EDGE_FACE = 0.03;
// YÜZ OVALİ DOLMAZ (2026-10-26, 9987f742 c1, kullanıcı: "alında leke var"):
// siyah-beyaz karede parlak kemerin önündeki açık alın çok sınıflı modelde
// arka plan, kişi maskesinde dolu çıktı; kaş üstü olduğu için deri koruması
// (SKIN_LIKE_*) devreye girmedi, alın "hayalet" sayılıp duvar dokusuyla
// boyandı (canlıda hayalet 18-27 bin px, teslimde keskin kenarlı açık yama).
// Yüz ovalinin içi kafanın kendisidir; oraya arka plan hiçbir durumda
// girmez. Oval: çene çizgisi (0-16) + kaşlar, (çene - kaş) yüksekliğinin
// FACE_OVAL_FOREHEAD katı yukarı, yüz merkezine FACE_OVAL_INSET kadar
// çekilmiş (yan bakışta alın geriye eğik; saç çizgisinin altında kalsın).
const FACE_OVAL_FOREHEAD = 0.4;
const FACE_OVAL_INSET = 0.15;
// Tam profilde 68 nokta yüze oturmuyor (c1: oval göz-yanak çevresinde küçük
// bir şekil kaldı, alındaki yamayı kaplamadı). Yüz tespit kutusu profilde de
// alından çeneye sarıyor: kutuya çizilen elips da korunur. Yatay yarıçap
// dar: profilde kutu yüzün önündeki zemine taşıyor.
const FACE_BOX_RX = 0.35;
const FACE_BOX_RY = 0.45;

/** Nokta çokgenin içinde mi (çift-tek kuralı). SAF. */
function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 68 noktadan alın dahil yüz ovali çokgeni (bkz. FACE_OVAL_FOREHEAD). SAF. */
function faceOval(P) {
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const lift = FACE_OVAL_FOREHEAD * Math.max(0, P[8].y - browY);
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const brows = [];
  for (let k = 26; k >= 17; k--) brows.push({ x: P[k].x + (cx - P[k].x) * FACE_OVAL_INSET, y: P[k].y - lift });
  return [...P.slice(0, 17).map((p) => ({ x: p.x, y: p.y })), ...brows];
}
// Yerel dolgu modeline kafa da maskeli verilir (saçı deliğe uzatmasın):
// kafa bileşeninin bu kadar (yüz genişliğine oranla) çevresindeki korunan
// pikseller.
const LAMA_HEAD_REACH_FACE = 0.1;
// Şablon kafası halkası (bkz. prepareHeadSurroundFill): hayalete bu kadar (yüz
// genişliğine oranla) yakın kısmı dolar; şablon kafasının bu kadar dışındaki
// arka planın ortalama parlaklık gradyanı TPL_TEX_MAX'ı aşarsa hiç dolmaz
// (ölçülen: düz duvar/çizgili panel 0.3-4.7 temiz; 3b4f51cb c3 lambalı duvar
// 5.7 lambayı lekeye uzattı; ca61076a c8 demir kapı 7.0 kapıyı taşla boyadı).
const TPL_GHOST_REACH_FACE = 0.2;
const TPL_TEX_REACH_FACE = 0.3;
const TPL_TEX_MAX = 5;
// KULLANICININ SAÇI ŞABLON KAFASININ DIŞINDA (2026-10-27, e25dc241 c1/c2/c9,
// kullanıcı: "selfienin saçı neyse çıktının da o olacak"): kıvırcık, hacimli
// saçın şablonun kısa saç silüetinden taşan dış bukleleri kaş üstünde arka
// plan sınıfı / soluk kişi pikseliydi; hayalet ve saçak sayılıp LaMa ile
// silindi (c1 ilk geçişte hayalet 12.308 px). Hayalet tanım gereği şablon
// kişisinin kalıntısıdır: şablon kafasının (zaten genişletilmiş) silüetinden
// bu kadar (yüz genişliğine oranla) uzaktaki piksel hayalet, saydam hayalet
// ya da saçak sayılmaz. Küçültme deliği (extraHole) bundan bağımsız dolar.
const USER_HAIR_TPL_REACH_FACE = 0.05;
// Kural kaşların bu kadar (kaş–çene yüksekliğinin payı) altına kadar geçerli.
const USER_HAIR_BELOW_BROW = 0.5;

/**
 * Chamfer (3-4) uzaklık dönüşümü: her piksel için en yakın mask=1 pikseline
 * yaklaşık Öklid uzaklığı (piksel). mask=1 olan yerde 0. SAF.
 */
function chamfer(mask, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

async function cropRgb(rgb, W, H, left, top, width, height) {
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left, top, width, height }).raw().toBuffer();
}

/**
 * Şablon kafasının (genişletilmiş) silüeti, tam kare Uint8Array(W*H).
 * t: şablon RGB raw (çıktı boyutunda), Mt: şablon kişi olasılığı, box: şablon
 * yüz kutusu. Sınıflandırma başarısızsa yalnız kişi maskesiyle.
 */
async function templateHeadMask(t, Mt, W, H, box) {
  const fw = box.width;
  const fh = box.height;
  const cx = box.x + fw / 2;
  const x0 = clampI(cx - 2.2 * fw, 0, W - 1);
  const x1 = clampI(cx + 2.2 * fw, 0, W - 1);
  const y0 = clampI(box.y - 2.0 * fh, 0, H - 1);
  const y1 = clampI(box.y + 1.25 * fh, 0, H - 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(W * H);
  if (w < 8 || h < 8) return out;
  const topY = box.y + 0.25 * fh; // kaş hizası civarı (şablonda nokta yok)
  let headP = null;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const P = await classProbs(await cropRgb(t, W, H, x0, y0, w, h), w, h);
    // Kafa sınıfı baskın olmalı: zayıf olasılık eşiği eli/saati de alıyordu
    // (d44b63e8 c6 şablonu gözlüğünü tutan el).
    headP = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const hp = P[CLASSES.hair][i] + P[CLASSES.faceSkin][i] + P[CLASSES.others][i];
      headP[i] = hp >= 0.5 || hp > P[CLASSES.bodySkin][i] + P[CLASSES.clothes][i] ? hp : 0;
    }
    // Şablonda kişi maskesinin gördüğü ama kafa olmayan nesne pikselleri +
    // şablonun rengi (bkz. ŞABLONUN SAHNESİ). Gökyüzü/duvar dahil değil:
    // hayaletin soluk kenarı oranın rengine yakın kalıyor.
    const notHead = new Uint8Array(W * H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (y + y0) * W + x + x0;
        if (headP[y * w + x] < TPL_HEAD_CLASS_MIN && Mt[g] >= TPL_STRAND_MIN) notHead[g] = 1;
      }
    }
    out.notHead = notHead;
    out.rgb = t;
  } catch (e) {
    console.error("Şablon kafa silüeti: sınıflandırma başarısız (yalnız kişi maskesi):", e.message || e);
  }
  const base = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = Mt[(y + y0) * W + x + x0];
      const above = y + y0 < topY;
      if (headP ? headP[i] >= TPL_HEAD_CLASS_MIN || (above && m >= TPL_STRAND_MIN) : m >= TPL_STRAND_MIN) base[i] = 1;
    }
  }
  // Yalnız yüze bağlı bileşen (c4: tavan ışığı ve arkadaki nesne "aksesuar"
  // sınıfına girmişti).
  const conn = new Uint8Array(w * h);
  const stack = [];
  for (let y = Math.max(0, Math.round(box.y - y0)); y < Math.min(h, Math.round(box.y + fh - y0)); y++) {
    for (let x = Math.max(0, Math.round(box.x - x0)); x < Math.min(w, Math.round(box.x + fw - x0)); x++) {
      const i = y * w + x;
      if (base[i] && !conn[i]) { conn[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && base[j] && !conn[j]) { conn[j] = 1; stack.push(j); }
    }
  }
  const d = chamfer(conn, w, h);
  const r1 = Math.max(4, TPL_GROW_FACE * fw);
  const r2 = Math.max(6, TPL_GROW_TOP_FACE * fw);
  for (let y = 0; y < h; y++) {
    const r = y + y0 < topY ? r2 : r1;
    for (let x = 0; x < w; x++) if (d[y * w + x] <= r) out[(y + y0) * W + x + x0] = 1;
  }
  return out;
}

/**
 * SAYDAM HAYALET SAÇ (2026-10-11, f3539078 c0): şablon kişisinin kabarık
 * saçından kalan gri, yarı saydam teller çok sınıflı modelde "saç" çıktı;
 * kafanın parçası sayıldı, dolgu maskesine hiç girmedi. Ayırt edici olan
 * parlaklık: bu teller kullanıcının dolu saçıyla arka plan arasında, arka
 * plana daha yakın (opaklık < SHEER_ALPHA_MAX). Saçın içindeki ışık
 * yansıması da öyle olabilir — bu yüzden yalnızca dışarıdaki arka plana bu
 * tür piksellerden geçerek ulaşılabilenler alınır. Saç ile arka plan
 * arasında yeterli fark yoksa (sarı saç açık zeminde) hiçbir şey alınmaz.
 * Dönüş: kesit (w x hc) Uint8Array. SAF.
 */
const SHEER_ALPHA_MAX = 0.5;
const SHEER_MIN_CONTRAST = 50;
// Kafanın kendi saç kenarı da yarı saydamdır ama dolu saça yapışıktır
// (f3539078 c1/c3/c5/c7: 500-700 px ince şerit, kenar temizdi). TESPİT:
// dolu saçtan bu kadar (yüz genişliğine oranla) uzakta en az SHEER_MIN_FACE2
// kadar yarı saydam saç varsa hayalet var demektir; o zaman MASKE dışarıya
// bağlı yarı saydam saçın tamamıdır (dolu saça yapışık gri pus dahil — yoksa
// saçın üstünde gri çizgi kalır). Tespit yoksa hiçbir şey alınmaz.
const SHEER_EDGE_FACE = 0.04;
const SHEER_MIN_FACE2 = 0.003;
const SHEER_GROW_FACE = 0.1;
// KOYU HAYALET GÖVDESİ (2026-10-18, d87c25b4 c0): hayaletin yalnız açık
// kısmı (opaklık < 0.5) alındı; daha yoğun gövdesi (0.5-0.8) "kullanıcının
// dolu saçı" sayılıp korundu ve teslim edildi. Hayalet tespit edildiyse,
// alınan kümeye bağlı ve gerçekten dolu saçtan (opaklık >= 0.8) en az
// SHEER_EXT_EDGE_FACE uzaktaki 0.8'in altındaki saç pikselleri de hayalettir.
// Kullanıcının kendi saç kenarı dolu saça yapışık olduğu için girmez.
// Dolu saça yapışık hayalet gövdesi (c0 sol üst tümsek) mesafeyle ayrılmaz;
// kalınlıkla ayrılır: kullanıcının saç kenarındaki geçiş 1-3 px, hayalet
// gövdesi kalın bir orta-ton blok. Orta opaklık bölgesinin SHEER_THICK_FACE
// yarıçaplı açmasından geçen kısmı da hayalettir.
const SHEER_ALPHA_EXT = 0.8;
const SHEER_EXT_EDGE_FACE = 0.06;
const SHEER_THICK_FACE = 0.02;
// Genişletme yalnız tespit edilen hayaletin bu kadar (yüz genişliğine oranla)
// yakınında: sınırsızken saç kenarı boyunca yayılıp c3'te kullanıcının açık
// renkli saç uçlarını sildi.
const SHEER_EXT_REACH_FACE = 0.12;
// YEREL ARKA PLAN (2026-10-20, 3d1d2a71 c3/c8, kullanıcı: "saçı silmişsin
// sağ üst kısmından"): opaklık tek bir arka plan ortancasına göre ölçülünce
// güneş alan açık kahve saç uçları (çalı/bej duvar önünde, saç-zemin farkı
// 53-75) "yarı saydam" sayıldı ve kullanıcının kendi saçının üstü dolguyla
// silindi; 34 karelik sette saydam sayılan kümelerin çoğu da kullanıcının
// saç kenarıydı (ca61076a c1, 10ee6a46 c8). Yarı saydam koyu saç, ARKASINDAKİ
// zeminden daha koyu ve saçtan daha açık olmalıdır: opaklık o pikselin yerel
// arka planına (kafa dışı arka plan pikselleri, SHEER_LOCAL_BG_FACE
// yarıçapında) göre ölçülür; yerel zeminden açık ya da ona çok yakın
// (opaklık < SHEER_ALPHA_MIN) piksel saydam değildir, yerel zemin saçtan
// SHEER_MIN_LOCAL_CONTRAST kadar açık değilse o yerde karar verilmez.
// Gerçek hayaletler (d87c25b4 c0, 3b4f51cb c1, d87c25b4 c3) açık zeminde
// (fark 114-128).
const SHEER_LOCAL_BG_FACE = 0.25;
const SHEER_ALPHA_MIN = 0.1;
const SHEER_MIN_LOCAL_CONTRAST = 90;

// Ayrılabilir kutu bulanıklığı (Float32Array, aynı boyut). SAF.
function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function sheerHairMask(rgb, W, Mo, Po, CLASSES, { w, hc, bx0, by0, browY, faceW }) {
  const out = new Uint8Array(w * hc);
  const yb = Math.min(hc, Math.round(browY) - by0);
  if (yb < 4) return out;
  const L = new Float32Array(w * yb);
  const hairL = [];
  const bgL = [];
  for (let y = 0; y < yb; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = ((y + by0) * W + x + bx0) * 3;
      L[i] = 0.299 * rgb[g] + 0.587 * rgb[g + 1] + 0.114 * rgb[g + 2];
      const m = Mo[(y + by0) * W + x + bx0];
      if (Po[CLASSES.hair][i] >= 0.8 && m >= 0.8) hairL.push(L[i]);
      else if (Po[CLASSES.background][i] >= 0.8 && m < 0.05) bgL.push(L[i]);
    }
  }
  if (hairL.length < 50 || bgL.length < 50) return out;
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const Lh = med(hairL);
  const Lb = med(bgL);
  out.Lh = Lh; out.Lb = Lb;
  if (Math.abs(Lb - Lh) < SHEER_MIN_CONTRAST) return out;
  // Yerel arka plan parlaklığı (bkz. SHEER_LOCAL_BG_FACE): kafa dışı arka
  // plan piksellerinin normalize kutu bulanıklığı (3 geçiş ≈ Gauss).
  const bgW = new Float32Array(w * yb);
  const bgV = new Float32Array(w * yb);
  for (let y = 0; y < yb; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Po[CLASSES.background][i] >= 0.8 && Mo[(y + by0) * W + x + bx0] < 0.05) { bgW[i] = 1; bgV[i] = L[i]; }
    }
  }
  // Kalın hayaletin ortası zeminden uzak: yakın ölçekte zemin pikseli yoksa
  // iki kat geniş ölçeğe düşülür (ağırlık oranı, yalnız zemin piksellerinin
  // ortalaması — ağırlık küçük olsa da değer doğru).
  const scales = [];
  for (let k = 0, r = Math.max(1, Math.round((SHEER_LOCAL_BG_FACE * faceW) / 3)); k < 3; k++, r *= 2) {
    let sW = bgW, sV = bgV;
    for (let p = 0; p < 3; p++) { sW = boxBlur(sW, w, yb, r); sV = boxBlur(sV, w, yb, r); }
    scales.push([sW, sV]);
  }
  // Opaklık: 1 = dolu saç, 0 = yerel zemin. Yerel zemin yoksa ya da saçtan
  // yeterince açık değilse NaN (karar yok — saydam sayılmaz).
  const alphaAt = new Float32Array(w * yb);
  for (let i = 0; i < w * yb; i++) {
    let lb = NaN;
    for (const [sW, sV] of scales) if (sW[i] > 1e-3) { lb = sV[i] / sW[i]; break; }
    alphaAt[i] = lb - Lh >= SHEER_MIN_LOCAL_CONTRAST ? (L[i] - lb) / (Lh - lb) : NaN;
    // Yerel zeminden AÇIK saç pikseli: kullanıcının koyu saçı olamaz, şablonun
    // gri/gümüş telidir (d87c25b4 c3 ahşap önünde, 10ee6a46 c7) — opaklık
    // genel zemine göre ölçülür.
    if (alphaAt[i] < SHEER_ALPHA_MIN) alphaAt[i] = (L[i] - Lb) / (Lh - Lb);
  }
  const cand = new Uint8Array(w * yb);
  const open = new Uint8Array(w * yb);
  const dense = new Uint8Array(w * yb);
  for (let i = 0; i < w * yb; i++) {
    const hair = Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i];
    const alpha = alphaAt[i];
    if (hair && alpha >= SHEER_ALPHA_MIN && alpha < SHEER_ALPHA_MAX) cand[i] = 1;
    else if (hair) dense[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    const head = Po[CLASSES.hair][i] + Po[CLASSES.faceSkin][i] + Po[CLASSES.others][i] >= 0.5;
    if (!head && Mo[(y + by0) * W + x + bx0] < 0.5) open[i] = 1;
  }
  // TESPİT MESAFESİ KALIN DOLU SAÇTAN (2026-10-18, 3b4f51cb c1): hayalet
  // kubbenin içindeki ince koyu teller (opaklık >= 0.5) "dolu saç" sayılınca
  // kubbenin açık kısmı onlara yakın kaldı; uzak piksel 46 < 106, hayalet hiç
  // tespit edilmedi ve teslim edildi (ham karede 172 idi — yüz detayı
  // keskinleştirmesi telleri koyulaştırdı). Mesafe dolu saçın açmasından
  // ölçülür; maske kuralları değişmez.
  const rDense = Math.max(2, SHEER_THICK_FACE * faceW);
  const edgeR = Math.max(2, SHEER_EDGE_FACE * faceW);
  // Dışarıdan (arka plan) aday piksellere doğru taşma; dolu saçtan uzak
  // alınan piksel sayısı hayaletin tespitidir.
  const floodFar = (cnd, dns, into) => {
    const dNotDense = chamfer(Uint8Array.from(dns, (v) => (v ? 0 : 1)), w, yb);
    const denseEr = Uint8Array.from(dNotDense, (v) => (v > rDense ? 1 : 0));
    const dDenseEr = chamfer(denseEr, w, yb);
    const dD = chamfer(Uint8Array.from(dDenseEr, (v, i) => (dns[i] && v <= rDense + 1 ? 1 : 0)), w, yb);
    const stack = [];
    for (let i = 0; i < w * yb; i++) if (open[i]) stack.push(i);
    const seen = new Uint8Array(w * yb);
    for (const i of stack) seen[i] = 1;
    let far = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yb - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && cnd[j]) { seen[j] = 1; if (into) into[j] = 1; if (dD[j] > edgeR) far++; stack.push(j); }
      }
    }
    return far;
  };
  const farPx = floodFar(cand, dense, out);
  // ESKİ (GENEL ZEMİN) TESPİTİ YALNIZ İŞARET (2026-10-20): genel zemine göre
  // hayalet görünen ama yerel kuralın almadığı kare (ca61076a c6: beyaz
  // duvar önünde şablon kafasının gri kubbesi) — piksel silinmez, yalnız
  // şablon kafası halkasının dolgusu açılır (halka kullanıcının korunan
  // saçına girmez, bkz. prepareHeadSurroundFill).
  {
    const candG = new Uint8Array(w * yb);
    const denseG = new Uint8Array(w * yb);
    for (let i = 0; i < w * yb; i++) {
      if (!(Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i])) continue;
      if ((L[i] - Lb) / (Lh - Lb) < SHEER_ALPHA_MAX) candG[i] = 1;
      else denseG[i] = 1;
    }
    out.globalGhost = floodFar(candG, denseG, null) >= SHEER_MIN_FACE2 * faceW * faceW;
  }
  // Genel zemine göre tespit edilen hayalette yerel kuralın aldığı pikseller
  // de alınır (d87c25b4 c3: gri teller dolu saça yakın, yerel uzak piksel
  // eşiğin altında kaldı).
  if (farPx < SHEER_MIN_FACE2 * faceW * faceW && !out.globalGhost) {
    out.fill(0);
    out.farRel = farPx / (faceW * faceW);
    return out;
  }
  out.farRel = farPx / (faceW * faceW);
  // Koyu hayalet gövdesi: alınan kümeden, dolu saçtan uzak orta yoğunluktaki
  // saç piksellerine doğru büyüt.
  const core = new Uint8Array(w * yb);
  for (let i = 0; i < w * yb; i++) {
    const hair = Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i];
    if (hair && !(alphaAt[i] < SHEER_ALPHA_EXT)) core[i] = 1;
  }
  const dCore = chamfer(core, w, yb);
  const extR = Math.max(edgeR, SHEER_EXT_EDGE_FACE * faceW);
  // Kalın orta-ton: orta opaklık bölgesinin açması.
  const notMid = new Uint8Array(w * yb);
  for (let i = 0; i < w * yb; i++) {
    const hair = Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i];
    notMid[i] = hair && !core[i] && alphaAt[i] >= SHEER_ALPHA_MAX ? 0 : 1;
  }
  const rT = Math.max(2, SHEER_THICK_FACE * faceW);
  const dMid = chamfer(notMid, w, yb);
  const midEr = new Uint8Array(w * yb);
  for (let i = 0; i < w * yb; i++) midEr[i] = dMid[i] > rT ? 1 : 0;
  const dEr = chamfer(midEr, w, yb);
  const dSeed = chamfer(out, w, yb);
  const reach = SHEER_EXT_REACH_FACE * faceW;
  const grow = [];
  for (let i = 0; i < w * yb; i++) if (out[i]) grow.push(i);
  while (grow.length) {
    const i = grow.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yb - 1 ? i + w : -1]) {
      if (j < 0 || out[j] || core[j] || dSeed[j] > reach) continue;
      // Açık (opaklık < SHEER_ALPHA_MAX) piksel hayalete bağlıysa her zaman
      // hayalettir (c0 sol üst tümsek: L≈94, dolu saça yapışık; 1492 px
      // korunmuştu). Saçın içindeki parlama dolu saçla çevrili, erişilmez.
      // DOLU SAÇI AÇMA denendi (hayaletteki koyu çizgiler düşsün diye):
      // d87c25b4 c1/c2'de kıvırcık saçın tellerini silip topak bıraktı.
      // Karar verilemeyen (NaN) ya da yerel zeminden açık piksel büyümeye girmez.
      if (!(alphaAt[j] >= SHEER_ALPHA_MIN)) continue;
      const light = alphaAt[j] < SHEER_ALPHA_MAX;
      if (!light && dCore[j] <= extR && !(dEr[j] <= rT + 1)) continue;
      if (!(Po[CLASSES.hair][j] >= 0.5 && Po[CLASSES.hair][j] > Po[CLASSES.faceSkin][j])) continue;
      out[j] = 1;
      grow.push(j);
    }
  }
  return out;
}

/**
 * Kafa çevresi şeridinin dolgusunu hazırlar. buf: arka planı geri
 * yüklenmiş (ve varsa kafası ölçeklenmiş) kare; extraHole: kafa küçültmenin
 * açtığı delik (Uint8Array W*H); newHead: küçültülmüş kafanın kendisi
 * (Uint8Array W*H, headScale headMask) — delikte yalnız o korunur;
 * tplHead: şablon kafasının silüeti (Uint8Array W*H, templateHeadMaskFor).
 * Dönüş { applied, reason, bandPx, ghostPx, fringePx, inpaint{rect,job,base} };
 * dolgu lamaFill.finishInpaintLama(job, base) ile tamamlanır.
 */
async function prepareHeadSurroundFill(buf, { extraHole = null, newHead = null, tplHead = null, debug = null } = {}) {
  const { personMask, _rawRgb: rawRgb, _prepareInpaint: prepareInpaint } = require("./headScale");
  const { faceLandmarks } = require("./faceQuality");
  const o = await rawRgb(buf);
  const { W, H } = o;
  const lo = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
  if (!lo) return { applied: false, reason: "no-face-output" };
  const Mo = await personMask(o.data, W, H);
  const P = lo.pts;
  const faceW = Math.max(lo.box.width, Math.hypot(P[0].x - P[16].x, P[0].y - P[16].y));
  const chin = P[8].y;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const bx0 = clampI(cx - 2.2 * faceW, 0, W - 1);
  const bx1 = clampI(cx + 2.2 * faceW, 0, W - 1);
  const by0 = clampI(lo.box.y - 2.2 * faceW, 0, H - 1);
  const by1 = clampI(chin + 0.6 * faceW, 0, H - 1);
  const w = bx1 - bx0 + 1;
  const h = by1 - by0 + 1;
  if (w < 16 || h < 16) return { applied: false, reason: "tiny" };
  const G = (x, y) => (y + by0) * W + x + bx0;
  // Yüz ovali (bkz. FACE_OVAL_FOREHEAD): içi kafadır, hayalet sayılmaz, dolmaz.
  const inOval = new Uint8Array(w * h);
  {
    const oval = faceOval(P);
    const y0 = clampI(Math.min(...oval.map((p) => p.y)) - by0, 0, h - 1), y1 = clampI(Math.max(...oval.map((p) => p.y)) - by0, 0, h - 1);
    const x0 = clampI(Math.min(...oval.map((p) => p.x)) - bx0, 0, w - 1), x1 = clampI(Math.max(...oval.map((p) => p.x)) - bx0, 0, w - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inPolygon(oval, x + bx0, y + by0)) inOval[y * w + x] = 1;
    const b = lo.box;
    const ecx = b.x + b.width / 2, ecy = b.y + b.height / 2, erx = FACE_BOX_RX * b.width, ery = FACE_BOX_RY * b.height;
    for (let y = clampI(ecy - ery - by0, 0, h - 1); y <= clampI(ecy + ery - by0, 0, h - 1); y++) {
      for (let x = clampI(ecx - erx - bx0, 0, w - 1); x <= clampI(ecx + erx - bx0, 0, w - 1); x++) {
        if (((x + bx0 - ecx) / erx) ** 2 + ((y + by0 - ecy) / ery) ** 2 <= 1) inOval[y * w + x] = 1;
      }
    }
  }
  let ovalPx = 0;
  // Şablon kafasına yakınlık (bkz. USER_HAIR_TPL_REACH_FACE); şablon yoksa kısıt yok.
  let nearTpl = null;
  let userHairPx = 0;
  if (tplHead) {
    const tC = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tC[y * w + x] = tplHead[G(x, y)] ? 1 : 0;
    const dT = chamfer(tC, w, h);
    const reachT = Math.max(2, USER_HAIR_TPL_REACH_FACE * faceW);
    // Yalnız saç bölgesinde: daha aşağıdaki boyun/omuz kenarı çizgileri
    // (3b4f51cb c1/c3) eskisi gibi saçak sayılır.
    const yHair = browY + USER_HAIR_BELOW_BROW * Math.max(0, chin - browY) - by0;
    nearTpl = Uint8Array.from(dT, (v, i) => (v <= reachT || Math.floor(i / w) >= yHair ? 1 : 0));
  }

  // Yeni kafa: kişi maskesi YA DA çok sınıflı modelde kafa sınıfı (karanlık
  // siyah-beyaz karede koyu saç kişi maskesinden düşüyordu — d44b63e8 c4).
  // Hayalet saç (kaş üstü, kişi maskesinde var, çok sınıflı modelde arka
  // plan) kafaya katılmaz (bkz. hafıza ghost-hair-is-background-class).
  // Sınıflandırma çeneye kadar olan kesitte (kesit uzayınca hayalet "arka
  // plan" sayılmıyordu).
  const hc = Math.max(16, Math.min(h, Math.round(chin) - by0 + 1));
  const core = new Uint8Array(w * h);
  const ghost = new Uint8Array(w * h);
  const scene = new Uint8Array(w * h);
  const sceneOf = (g) => {
    if (!tplHead || !tplHead.notHead || !tplHead.notHead[g]) return false;
    for (let c = 0; c < 3; c++) if (Math.abs(o.data[g * 3 + c] - tplHead.rgb[g * 3 + c]) > SCENE_MATCH_MAX) return false;
    return true;
  };
  // Kullanıcının kendi dolu saçı (saç sınıfı, saydam hayalet değil).
  const hairDense = new Uint8Array(w * h);
  let classified = false;
  let sheerGlobal = false;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const Po = await classProbs(await cropRgb(o.data, W, H, bx0, by0, w, hc), w, hc);
    const sheer = sheerHairMask(o.data, W, Mo, Po, CLASSES, { w, hc, bx0, by0, browY, faceW });
    sheerGlobal = !!sheer.globalGhost;
    if (debug) { debug.Lh = sheer.Lh; debug.Lb = sheer.Lb; debug.farRel = sheer.farRel; debug.sheerGlobal = sheerGlobal; }
    // Kullanıcının yüz derisi rengi (ortanca Lab), deri benzeri piksel için.
    const { rgbToLab } = require("./skinTone");
    const fL = [], fA = [], fB = [];
    for (let y = 0; y < hc; y++) {
      for (let x = 0; x < w; x++) {
        if (Po[CLASSES.faceSkin][y * w + x] < 0.7) continue;
        const g = G(x, y), l = rgbToLab(o.data[g * 3], o.data[g * 3 + 1], o.data[g * 3 + 2]);
        fL.push(l[0]); fA.push(l[1]); fB.push(l[2]);
      }
    }
    const medOf = (a) => Float64Array.from(a).sort()[Math.floor(a.length / 2)];
    const faceLab = fL.length >= 50 ? [medOf(fL), medOf(fA), medOf(fB)] : null;
    const skinLike = (g) => {
      if (!faceLab) return false;
      const l = rgbToLab(o.data[g * 3], o.data[g * 3 + 1], o.data[g * 3 + 2]);
      return l[0] >= faceLab[0] - SKIN_LIKE_L_BELOW && l[0] <= faceLab[0] + SKIN_LIKE_L_ABOVE &&
        Math.hypot(l[1] - faceLab[1], l[2] - faceLab[2]) <= SKIN_LIKE_AB;
    };
    for (let y = 0; y < hc; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = Mo[G(x, y)];
        const head = Po[CLASSES.hair][i] + Po[CLASSES.faceSkin][i] + Po[CLASSES.others][i] >= 0.5;
        // ŞABLON KAFASININ İÇİ (2026-10-19, ca61076a c0): kaş altında, kulağın
        // yanında kalan hayalet kişi maskesinde "yumuşak kenar" sayılıp
        // korunuyordu. Şablon kafasının durduğu yerde arka plan sınıfı kişi
        // pikseli kaş altında da hayalettir.
        const inTplHead = !!(tplHead && tplHead[G(x, y)]);
        // ŞABLONUN SAHNESİ (2026-10-19, 9c8f2cb5 c1, kullanıcı: "kafanın hemen
        // yanındaki şablonda eğilme"): kafaya bitişik şemsiyenin tepesi kaş
        // üstünde, arka plan sınıfında ve kişi maskesinde soluktu; hayalet
        // sayılıp silindi, tepesi kesildi. Şablonda orası kafa değilse ve çıktı
        // şablonla aynı renkteyse sahnenin kendisidir: hayalet değil, korunur.
        // Hayalet saç şablonda saç sınıfındadır; şablon kafasının dışındaki
        // gri pus şablonun gökyüzünden farklı renktedir — ikisi de etkilenmez.
        // KULLANICININ BOYNU HAYALET DEĞİL (2026-10-20, 3d1d2a71 c4): sınıflar
        // çok etiketli; kulak altındaki boyun hem arka plan (0.97) hem vücut
        // derisi (0.86) çıktı, şablonun sakalının durduğu yerde olduğu için
        // hayalet sayılıp silindi — kulakla sakal arasında koyu boşluk kaldı.
        // Şablon kafasının hayaleti saç/arka plan sınıfındadır, deri değil;
        // sınıf kararsızsa renk (bkz. SKIN_LIKE_AB).
        const skin = Po[CLASSES.bodySkin][i] >= 0.5 || (y + by0 >= browY && m >= 0.5 && skinLike(G(x, y)));
        let ghostLike = !head && !skin && (y + by0 < browY || inTplHead) && m >= 0.15 && Po[CLASSES.background][i] >= 0.5;
        if (nearTpl && !nearTpl[i] && (ghostLike || sheer[i])) {
          ghostLike = false;
          sheer[i] = 0;
          userHairPx++;
        }
        if (inOval[i]) {
          if (ghostLike || sheer[i]) ovalPx++;
          core[i] = 1;
          continue;
        }
        if (ghostLike && !sheer[i] && sceneOf(G(x, y))) scene[i] = 1;
        if (ghostLike || sheer[i]) {
          ghost[i] = sheer[i] ? 2 : 1;
          continue;
        }
        if (head || m >= 0.5) core[i] = 1;
        if (Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i]) hairDense[i] = 1;
      }
    }
    // Yalnız kalın parçalar sahnedir (açma): şablonun ince saç telleri de
    // şablonda kafa sınıfı dışında ve çıktıda aynı renkte — onlar hayalettir.
    const rS = Math.max(2, SCENE_OPEN_FACE * faceW);
    const notS = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) notS[i] = scene[i] ? 0 : 1;
    const dS = chamfer(notS, w, h);
    const er = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) er[i] = dS[i] > rS ? 1 : 0;
    const dEr = chamfer(er, w, h);
    for (let i = 0; i < w * h; i++) {
      if (!scene[i]) continue;
      if (dEr[i] <= rS + 1) ghost[i] = 0;
      else scene[i] = 0;
    }
    classified = true;
  } catch (e) {
    console.error("Kafa çevresi: sınıflandırma başarısız (yalnız kişi maskesi):", e.message || e);
  }
  for (let y = classified ? hc : 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (Mo[G(x, y)] >= 0.5) core[y * w + x] = 1;
  }

  // YALNIZ KAFA (2026-10-12, e0eb8dd5 c2/c8): kişi maskesi kafanın yanındaki
  // koyu nesneyi (şemsiye) ve arkadaki insanları da "kişi" görüyor; onlar
  // dolu gövdeye, çevrelerindeki soluk pikseller saçak/hayalete girip
  // siliniyordu. Çene hizasının üstünde kafa = yüzden başlayan bileşen;
  // ona bağlı olmayan dolu pikseller korunur ama kafa sayılmaz.
  const yChin = Math.min(h - 1, Math.floor(chin - by0));
  const headComp = new Uint8Array(w * h);
  {
    const sx = clampI(cx - bx0, 0, w - 1);
    const sy = clampI((browY + chin) / 2 - by0, 0, yChin);
    if (core[sy * w + sx]) {
      headComp[sy * w + sx] = 1;
      const stack = [sy * w + sx];
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        const y = (i - x) / w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yChin ? i + w : -1]) {
          if (j >= 0 && core[j] && !headComp[j]) { headComp[j] = 1; stack.push(j); }
        }
      }
    } else {
      for (let y = 0; y <= yChin; y++) for (let x = 0; x < w; x++) headComp[y * w + x] = core[y * w + x];
    }
  }
  const otherCore = new Uint8Array(w * h);
  for (let y = 0; y <= yChin; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (core[i] && !headComp[i]) { otherCore[i] = 1; core[i] = 0; }
    }
  }
  // Hayalet yalnızca kafaya bağlıysa (2 px boşluk payıyla): kafadan kopuk
  // "arka plan sınıfı kişi" pikselleri başka bir nesnedir.
  const dHead = chamfer(headComp, w, h);
  {
    const dG = chamfer(ghost, w, h);
    const reach = new Uint8Array(w * h);
    const stack = [];
    for (let i = 0; i < w * h; i++) if (ghost[i] && dHead[i] <= 2) { reach[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !reach[j] && dG[j] <= 2) { reach[j] = 1; stack.push(j); }
      }
    }
    for (let i = 0; i < w * h; i++) if (ghost[i] && !reach[i]) ghost[i] = 0;
  }
  let ghostPx = 0;
  let sheerPx = 0;
  for (let i = 0; i < w * h; i++) {
    if (!ghost[i]) continue;
    ghostPx++;
    if (ghost[i] === 2) sheerPx++;
  }
  // Dolu gövde: açma (ince teller ayrılır). Chamfer ile yuvarlak — kare
  // genişletme basamaklı kenar bırakıyordu.
  const rOpen = Math.max(2, CORE_OPEN_FACE * faceW);
  const notCore = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) notCore[i] = core[i] ? 0 : 1;
  const dIn = chamfer(notCore, w, h);
  const eroded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) eroded[i] = dIn[i] > rOpen ? 1 : 0;
  const dEr = chamfer(eroded, w, h);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = core[i] && dEr[i] <= rOpen + 1 ? 1 : 0;
  // Korunan: dolu gövde + kaşların altında kişinin yumuşak kenarı (3b16bf69
  // c7: AI başın arkasına saç şeridi ekledi, kazak kenarını tırtıklı boyadı)
  // + kafaya bağlı olmayan dolu pikseller (şemsiye, arkadaki insanlar).
  // KULLANICININ SAÇI KORUNUR (2026-10-12, e0eb8dd5 c7, kullanıcı: "saçı
  // boyamışsın"): açma, dolu gövdeden 2x0.08 yüz genişliğinden ince her
  // saç tutamını (perçem, kabarık uçlar) gövdeden ayırıyordu; onlar "saçak"
  // sayılıp yeniden boyanınca saçın üst kenarı düz, boyanmış göründü. Kafaya
  // bağlı dolu saç pikselleri (saç sınıfı, saydam hayalet değil) korunur;
  // saçak yalnızca saç olmayan soluk kişi pikselleridir.
  // Küçültme deliğinin içi (doku dolgusu, eski kafanın kalıntısı) yalnız
  // yeni kafa (küçültmenin katman alfası, newHead) ve kaş altında onun
  // yumuşak kenarı kadar korunur; geri kalanı baştan dolar. Delikteki doku
  // dolgusunu sınıflandırıcı saç/kişi sanabiliyor (c4 denemesi: saçın
  // üstünde açık leke korunup kaldı).
  const softR = Math.max(2, HEAD_SOFT_EDGE_FACE * faceW);
  const speck = new Uint8Array(w * h);
  if (sheerPx) {
    const dG = chamfer(ghost, w, h);
    const yBrow = Math.min(h, Math.max(0, Math.round(browY - by0)));
    const isCand = (i) => otherCore[i] || (headComp[i] && hairDense[i] && !solid[i]);
    const seen = new Uint8Array(w * h);
    const maxA = SPECK_MAX_FACE2 * faceW * faceW;
    for (let s0 = 0; s0 < yBrow * w; s0++) {
      if (seen[s0] || !isCand(s0)) continue;
      const comp = [s0];
      seen[s0] = 1;
      let touches = false;
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k];
        if (dG[i] <= 2) touches = true;
        const x = i % w;
        const y = (i - x) / w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yBrow - 1 ? i + w : -1]) {
          if (j >= 0 && !seen[j] && isCand(j)) { seen[j] = 1; comp.push(j); }
        }
      }
      if (touches && comp.length <= maxA) for (const i of comp) speck[i] = 1;
    }
  }
  const prot = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = G(x, y);
      if (inOval[i]) { prot[i] = 1; continue; }
      const inHole = !!(extraHole && extraHole[g]);
      const soft = y + by0 >= browY && Mo[g] >= 0.25 && !ghost[i] && (!inHole || dHead[i] <= softR);
      const headPx = inHole && newHead ? newHead[g] === 1 : solid[i] || (headComp[i] && hairDense[i]);
      // KÜÇÜLTÜLEN KAFA DOKUNULMAZ (2026-10-19, ca61076a c1, kullanıcı: "saçın
      // eksilmesi"): saçın gri parlak telleri saydam hayalet, onlara değen
      // koyu tutam "benek" sayıldı; dolgu saçın sol üstünü silip arkadaki
      // beyaz pervazı çizgi olarak içine koydu. Küçültme katmanı kafayı
      // kesin biliyor: onun pikselleri (alfa >= 0.5) her yerde korunur.
      if (newHead && newHead[g] === 1) { prot[i] = 1; continue; }
      if (scene[i]) { prot[i] = 1; continue; }
      if (speck[i]) continue;
      if (headPx || (otherCore[i] && !inHole) || soft) prot[i] = 1;
    }
  }
  const dProt = chamfer(prot, w, h);
  const dSolid = chamfer(solid, w, h);
  const ringR = Math.max(4, FRINGE_RING_FACE * faceW);

  const band = new Uint8Array(w * h);
  let bandPx = 0;
  let fringePx = 0;
  let holePx = 0;
  let farGhostPx = 0;
  let tplPx = 0;
  const farR = GHOST_FAR_FACE * faceW;
  // Saydam hayalet varsa en dıştaki ince teller (kişi maskesi bile görmüyor)
  // kümenin hemen dışında kalır: kaş üstünde hayaletin çevresi de şeride girer.
  const dGhost = sheerPx ? chamfer(ghost, w, h) : null;
  const growR = SHEER_GROW_FACE * faceW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dProt[i] <= 1.5) continue;
      const g = G(x, y);
      const fringe = y + by0 < chin && Mo[g] >= 0.15 && dSolid[i] <= ringR && (!nearTpl || nearTpl[i]);
      // YALNIZ KUSUR (2026-10-11, d44b63e8 yerel deneme): şablon kafasının
      // bütün silüeti AI'ye verilince model maskeyi farklı tonda/bulanıklıkta
      // doldurdu, şablon saçı şeklinde koyu yay kaldı (c6) — oysa geri
      // yüklemeden sonra modelin orada çizdiği arka plan temizdi. AI yalnız
      // hayalet saça, saçak tellerine ve küçültmenin açtığı deliğe girer.
      const nearSheer = dGhost && y + by0 < browY && dGhost[i] <= growR && (!nearTpl || nearTpl[i]);
      if (ghost[i] || fringe || nearSheer || (extraHole && extraHole[g])) {
        band[i] = 1;
        bandPx++;
        if (fringe) fringePx++;
        if (extraHole && extraHole[g]) holePx++;
        if (ghost[i] && dSolid[i] > farR) farGhostPx++;
      }
    }
  }
  const farGhost = sheerPx > 0 || sheerGlobal || farGhostPx >= GHOST_FAR_MIN_FACE2 * faceW * faceW;
  // ŞABLON KAFASI ∖ YENİ KAFA (2026-10-19, ca61076a c6, kullanıcı: "silüet
  // problemi"): hayaletin tespit edilen kısmı doldu, dışında kalan soluk kubbe
  // açık gri leke olarak kaldı. Hayalet tanım gereği şablon kafasının durduğu
  // yerdedir. Hayalet bulunduysa, şablon kafasının yeni kafanın örtmediği ve
  // hayalete bağlı kısmı da dolar. Hayalet yoksa dokunulmaz: c8'de şablon
  // kafası koyu demir kapının önündeydi, modelin oraya çizdiği kemer temizdi;
  // bütün alan dolunca kemer silindi (bkz. aşağıdaki YALNIZ KUSUR notu).
  // DESENLİ ZEMİNDE DOKUNULMAZ: yerel dolgu düz duvarı iyi kuruyor, desenli
  // zemini (c8 demir kapı, kemer) taş dokusuyla boyadı. Halka yalnız tespit
  // edilen hayaletin yakınında (d87c25b4 c3: bütün halka dolunca kapı köşesi
  // yuvarlaklaştı) ve şablon kafasının çevresindeki gerçek arka plan düzse dolar.
  let tplTex = null;
  if (tplHead && farGhost) {
    let gs = 0;
    let gn = 0;
    const dT = chamfer(Uint8Array.from({ length: w * h }, (_, i) => tplHead[G(i % w, (i - (i % w)) / w)]), w, h);
    const lum = (g) => 0.299 * o.data[g * 3] + 0.587 * o.data[g * 3 + 1] + 0.114 * o.data[g * 3 + 2];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!(dT[i] > 0 && dT[i] <= TPL_TEX_REACH_FACE * faceW) || dProt[i] <= 1.5) continue;
        const g = G(x, y);
        gs += Math.hypot(lum(g + 1) - lum(g - 1), lum(g + W) - lum(g - W)) / 2;
        gn++;
      }
    }
    tplTex = gn ? gs / gn : null;
  }
  const ringDbg = debug ? new Uint8Array(w * h) : null;
  if (tplHead && farGhost && tplTex != null && tplTex <= TPL_TEX_MAX) {
    const stack = [];
    const seen = new Uint8Array(w * h);
    const dG = chamfer(ghost, w, h);
    const reachG = TPL_GHOST_REACH_FACE * faceW;
    const inRing = (i) => tplHead[G(i % w, (i - (i % w)) / w)] === 1 && dProt[i] > 1.5 && dG[i] <= reachG;
    for (let i = 0; i < w * h; i++) if (ghost[i] && band[i] && inRing(i)) { seen[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop();
      if (!band[i]) { band[i] = 1; bandPx++; tplPx++; if (ringDbg) ringDbg[i] = 1; }
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && inRing(j)) { seen[j] = 1; stack.push(j); }
      }
    }
  }
  if (!holePx && !farGhost && bandPx < MIN_DEFECT_FACE2 * faceW * faceW) return { applied: false, reason: "clean", bandPx, ghostPx, fringePx, farGhostPx, sheerPx, tplPx, tplTex, faceW, ovalPx, userHairPx };

  // Yumuşak kenar: dolgu şeridin dışına (şablon arka planına) azalarak
  // taşar; korunan kafaya hiç girmez. DIŞ GEÇİŞ GENİŞ (2026-10-12, e0eb8dd5
  // c1/c7): şeridin dış sınırı eski kafanın silüetini izliyor; dolgu tonu
  // dışarıdan azıcık farklıysa 2-3 px'lik geçişte eski kafanın şekli çizgi
  // olarak görünüyordu (c1 açık yay, c7 çenenin yanında koyu tel). Yerel
  // model maske dışıyla tutarlı olduğu için geniş geçiş güvenli.
  const rs = Math.max(2, SOFT_EDGE_FACE * faceW);
  const rsOut = Math.max(rs, SOFT_EDGE_OUT_FACE * faceW);
  const dBand = chamfer(band, w, h);
  const hole = new Uint8Array(W * H);
  const banned = new Uint8Array(W * H);
  const wgt = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = G(x, y);
      if (dProt[i] <= 1.5) { banned[g] = 1; continue; }
      if (dBand[i] > rsOut) continue;
      hole[g] = 1;
      const edgeIn = Math.min(1, (dProt[i] - 1.5) / rs); // kafaya doğru dar ve yumuşak
      const t = dBand[i] / (rsOut + 1);
      wgt[g] = (1 - t * t * (3 - 2 * t)) * edgeIn;
    }
  }
  // YEREL DOLGU (2026-10-12, e0eb8dd5, kullanıcı: "kesin çözüm"): şerit
  // OpenAI yerine LaMa ile dolar (bkz. lamaFill.js). Kafa (çene hizasına
  // kadar, yumuşak kenarıyla) modele bağlam olarak verilmez — verilince
  // saçı deliğe doğru gri pus olarak uzatıyordu (c4 denemesi).
  const reachR = LAMA_HEAD_REACH_FACE * faceW;
  const head = new Uint8Array(W * H);
  for (let y = 0; y <= yChin; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (prot[i] && !otherCore[i] && dHead[i] <= reachR) head[G(x, y)] = 1;
    }
  }
  if (debug) Object.assign(debug, { W, H, bx0, by0, w, h, ghost, speck, band, prot, solid, hairDense, browY, ringDbg, Mo, G });
  const job = prepareInpaint(o.data, o.data, W, H, hole, banned, wgt, head);
  job.out = null;
  // Küçültme deliği yoksa yerel dolgu geniş bağlamla (bkz. lamaFill CONTEXT_RATIO).
  job.wide = !holePx;
  return {
    applied: true, bandPx, holePx, ghostPx, fringePx, farGhostPx, sheerPx, tplPx, tplTex, faceW, ovalPx, userHairPx,
    inpaint: { rect: { left: job.left, top: job.top, side: job.side }, job, base: buf },
  };
}

/**
 * Şablon kafası silüeti çıktı karesinin boyutunda (arka plan geri yüklemesinin
 * dışarıda bıraktığı alanın aynısı, bkz. sceneRestore). Bulunamazsa null.
 */
async function templateHeadMaskFor(outBuf, tplBuf) {
  const { personMask } = require("./headScale");
  const { detectMainFace } = require("./faceQuality");
  const m = await sharp(outBuf).rotate().metadata();
  const swapO = (m.orientation || 1) >= 5;
  const W = swapO ? m.height : m.width;
  const H = swapO ? m.width : m.height;
  const tm = await sharp(tplBuf).metadata();
  const swapT = (tm.orientation || 1) >= 5;
  const tw = swapT ? tm.height : tm.width;
  const th = swapT ? tm.width : tm.height;
  if (Math.abs(W / H - tw / th) > 0.01 * (W / H)) return null;
  const t = await sharp(tplBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const f = (await detectMainFace(tJpeg)) || (await detectMainFace(tJpeg, 0.1));
  if (!f) return null;
  const Mt = await personMask(t, W, H);
  return templateHeadMask(t, Mt, W, H, f.box);
}

module.exports = { templateHeadMask, templateHeadMaskFor, prepareHeadSurroundFill, chamfer, sheerHairMask, faceOval, inPolygon, FACE_BOX_RX, FACE_BOX_RY };
