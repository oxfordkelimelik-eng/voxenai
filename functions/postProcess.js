// Üretilen görsele hafif "gerçek telefon kamerası" dokusu ekler: film
// grain benzeri gürültü + gerçekçi JPEG sıkıştırma. AI üretim modelleri
// genelde çok temiz/yüksek kaliteli JPEG'ler döner (kalite ~95+, gürültüsüz)
// — bu, "yapay zeka ürettiği belli oluyor" hissinin bir parçası. Gerçek
// telefon fotoğrafları hem hafif sensör gürültüsü hem de daha düşük/tutarsız
// JPEG kalitesi taşır.
//
// FAIL-SAFE: bu adım tamamen kozmetik/ikincil. Hata olursa orijinal buffer
// olduğu gibi kaydedilir — kullanıcı asla bu adım yüzünden boş sonuç görmez.

const sharp = require("sharp");

// Gerçek telefon kamerası JPEG'lerine yakın kalite. AI çıktıları genelde
// bunun üzerinde (~95+) geliyor — düşürmek "temiz" hissi kırar. 86 -> 90
// (2026-08-xx, "netlik düşük" şikayeti) -> 94 (2026-08-16, kullanıcı geri
// bildirimi: fotoğraflar kalitesiz gelmeye başladı, artık dating profillerinde
// insanlar profesyonel kameralarla da çekim yapıyor — "amatör telefon fotosu"
// varsayımı eskisi kadar güçlü değil). 94 hâlâ AI'nin ~95+ nativesinin altında
// (tamamen "temiz" hissi kırılıyor) ama 90'a göre belirgin daha az sıkıştırma
// kaybı var. Yüz bölgesinde grain de artık AYRICA maskelendiği için (bkz.
// buildGrainLayer) bu ikisi birlikte netlik şikayetini hedefliyor.
const JPEG_QUALITY = 94;
// Referans selfie'ler fal'a gitmeden önce yeniden kodlanırken kullanılan
// kalite — yön düzeltmesi kimlik sinyalini bozmamalı (yüksek tut).
const REF_JPEG_QUALITY = 92;
// Referansın uzun kenarı bu değeri aşarsa küçültülür. Modern telefon
// fotoğrafları 3000-4000px+ gelir; edit modeli bunları zaten içeride
// örnekliyor, dolayısıyla 2048px kalite kaybı OLMADAN yükleme süresini
// (ve fal işlem yükünü) ciddi azaltır. Yüz-crop de bu boyuttan fazlasıyla
// yeterli çözünürlük alır (bkz. cropFaceRegion — yüz kareleri için yüz
// kadrajın büyük kısmı). Yalnızca KÜÇÜLTÜR (withoutEnlargement).
const REF_MAX_DIM = 2048;
// Grain katmanının opaklığı (0-255). Çok düşük tutulmalı — amaç fark
// edilmeyen bir doku, göze batan bir efekt değil. 22 -> 14 (2026-08-16,
// "kalitesiz görünüyor" geri bildirimi — bkz. JPEG_QUALITY'nin gerekçesi).
const GRAIN_ALPHA = 14;
// Gürültü genliği (gri ton ±). Yüksek olursa "bozuk görüntü" gibi durur.
// 14 -> 9, aynı gerekçeyle.
const GRAIN_AMPLITUDE = 9;

/**
 * Yüz bölgesinde grain'i YUMUŞAK KENARLI olarak söndürür (2026-08-16).
 * NEDEN: "yapay zeka belli oluyor" hissi asıl arka plan/genel doku gibi
 * yerlerden geliyor — kullanıcının en çok dikkat ettiği yüz bölgesine grain
 * uygulamak sadece netlik şikayetini büyütüyor, gerçekçilik katkısı azdır.
 * Kutu değil ELİPS + FEATHER (yumuşak geçiş) kullanılır — sert kenarlı bir
 * "temiz yama" kendisi bir yapay zeka izi gibi görünürdü. box yoksa (yüz
 * tespit edilemedi) etki YOK — tüm görsele eskisi gibi düz grain uygulanır
 * (fail-safe, hiçbir kareyi bu yüzden bozmaz).
 */
function faceGrainScale(x, y, box) {
  if (!box) return 1;
  const padX = box.width * 0.25;
  const padY = box.height * 0.30; // çene/saç çizgisini de kapsasın diye biraz fazla
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + padX;
  const ry = box.height / 2 + padY;
  if (rx <= 0 || ry <= 0) return 1;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d = Math.sqrt(nx * nx + ny * ny); // 0=merkez, 1=elips kenarı
  const featherStart = 0.7; // buraya kadar grain neredeyse yok
  const featherEnd = 1.15; // bu mesafeden sonra grain tam
  if (d <= featherStart) return 0;
  if (d >= featherEnd) return 1;
  return (d - featherStart) / (featherEnd - featherStart);
}

/**
 * Rastgele luminance gürültüsünden düşük-opaklıklı bir RGBA PNG üretir.
 * sharp'ın composite() ile "overlay" harmanlamasında kullanılır. faceBox
 * verilirse o bölgede (yumuşak geçişle) grain azaltılır — bkz. faceGrainScale.
 */
async function buildGrainLayer(width, height, faceBox = null) {
  const buf = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = 128 + Math.round((Math.random() - 0.5) * 2 * GRAIN_AMPLITUDE);
    const gray = Math.max(0, Math.min(255, v));
    const x = p % width;
    const y = (p - x) / width;
    const alpha = Math.round(GRAIN_ALPHA * faceGrainScale(x, y, faceBox));
    const off = p * 4;
    buf[off] = gray;
    buf[off + 1] = gray;
    buf[off + 2] = gray;
    buf[off + 3] = alpha;
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Görsele hafif grain (yüz bölgesi hariç/azaltılmış) + gerçekçi JPEG
 * sıkıştırma uygular. Herhangi bir adımda hata olursa ORİJİNAL buffer'ı
 * döner (üretimi asla bloklamaz) — yüz tespiti başarısız olursa da aynı
 * fail-safe: grain tüm görsele düz uygulanır, adım hiç iptal edilmez.
 */
async function addPhoneCameraTexture(buf) {
  try {
    const image = sharp(buf);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return buf;

    let faceBox = null;
    try {
      const { detectMainFace } = require("./faceQuality");
      const face = await detectMainFace(buf);
      if (face) faceBox = face.box;
    } catch (e) {
      console.error("Doku için yüz tespiti başarısız (grain düz uygulanacak):", e.message || e);
    }

    const grain = await buildGrainLayer(meta.width, meta.height, faceBox);
    return await image
      .composite([{ input: grain, blend: "overlay" }])
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.error("Post-processing başarısız (orijinal görsel kullanılıyor):", e);
    return buf;
  }
}

// Kırpma karesi = yüzün en büyük kenarının bu katı. ~2.2, yüzü kadrajın
// baskın öğesi yapar (saç/çene/boyun bağlamı da korunur — tamamen yüze
// yapışık bir kırpma modele doğal bir referans gibi görünmüyor).
const FACE_CROP_MULTIPLIER = 2.2;
// Kırpma bundan küçükse büyüt (yüksek efektif yüz çözünürlüğü, kimlik
// sadakatini doğrudan artırıyor — edit modelleri düşük çözünürlüklü yüz
// referanslarında detayı "uyduruyor").
const FACE_CROP_TARGET_SIZE = 1024;

/**
 * Bir görselden, verilen yüz kutusunun (orijinal piksel koordinatlarında
 * {x,y,width,height}) etrafında kare bir kırpma üretir ve gerekirse büyütür.
 * Amaç: edit modeline kimlik için YÜKSEK efektif çözünürlüklü, yüzün baskın
 * olduğu ek bir referans görsel vermek (bkz. falPhotos.prepareReferencePhotos
 * — bu, üretime gönderilen referans listesinin BAŞINA eklenir).
 *
 * Kutu geçersizse veya bir hata olursa null döner — çağıran taraf bu ek
 * referansı atlar, üretim asla bloklanmaz (fail-safe, diğer tüm ikincil
 * kalite adımlarıyla aynı felsefe).
 */
async function cropFaceRegion(buf, box) {
  try {
    const image = sharp(buf);
    const meta = await image.metadata();
    const imgW = meta.width, imgH = meta.height;
    if (!imgW || !imgH) return null;

    const faceSize = Math.max(box.width, box.height);
    const cropSize = Math.round(faceSize * FACE_CROP_MULTIPLIER);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    let left = Math.round(cx - cropSize / 2);
    let top = Math.round(cy - cropSize / 2);
    let size = cropSize;

    // Görsel sınırlarına kenetle.
    left = Math.max(0, Math.min(left, imgW - 1));
    top = Math.max(0, Math.min(top, imgH - 1));
    size = Math.min(size, imgW - left, imgH - top);
    if (size <= 0) return null;

    let cropped = image.extract({ left, top, width: size, height: size });
    if (size < FACE_CROP_TARGET_SIZE) {
      cropped = cropped.resize(FACE_CROP_TARGET_SIZE, FACE_CROP_TARGET_SIZE, {
        kernel: "lanczos3",
      });
    }
    return await cropped.jpeg({ quality: 92 }).toBuffer();
  } catch (e) {
    console.error("Yüz kırpma başarısız (ek referans atlanıyor):", e);
    return null;
  }
}

/**
 * Telefon fotoğraflarının EXIF Orientation bilgisini piksellere uygular
 * (sharp.rotate() argsız = auto-orient) ve etiketi temizler. Bazı edit
 * modelleri EXIF'i yok sayıp yan/ters referans görür; bu sessiz bir
 * yüz-bozulma kaynağıdır. Hata olursa orijinal buffer döner (fail-safe).
 */
async function normalizeExifOrientation(buf) {
  try {
    return await sharp(buf)
      .rotate()
      // Aşırı büyük referansları küçült (bedava yükleme/işlem hızı; kalite
      // kaybı yok — bkz. REF_MAX_DIM). rotate()'ten SONRA: piksel yönü zaten
      // düzeltildiği için fit "inside" doğru kenarı ölçer.
      .resize(REF_MAX_DIM, REF_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: REF_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.error("EXIF yön normalizasyonu başarısız (orijinal kullanılıyor):", e);
    return buf;
  }
}

// Kırpılan şablonun uzun kenarı bu değerin altındaysa modele makul bir tuval
// vermek için büyütülür. 1024, üretim çıktı boyutuyla uyumlu.
const TEMPLATE_CROP_LONG_EDGE = 1024;
// Yüz merkezinin kırpılmış karede dikey konumu (üstten oran). 0.30 = yüz
// üst üçte bire yakın durur, gövde altta kalır — portre kompozisyonu.
const TEMPLATE_CROP_FACE_TOP = 0.30;

/**
 * TABAN ŞABLONUNU, içindeki kişi kadrajda çok küçük kaldığında YAKINLAŞTIRIR.
 *
 * NEDEN (2026-07-29, gerçek veri): geniş/uzak planlı şablonlarda üretilen
 * yüz, 1024px'lik çıktının ~%9-10'unu kaplıyordu (≈100x100 piksel). Bu kadar
 * az pikselde model kimliği (burun/kaş/göz aralığı) taşıyamıyor ve kullanıcıya
 * "başka biri" gibi görünen kareler çıkıyordu. Ölçümler bunu doğruladı:
 * yüz oranı en küçük olan şablon (0.091-0.101) en kötü kimlik mesafesini
 * (0.524-0.550) veriyordu.
 *
 * Kırpma, EN-BOY ORANINI KORUR (kompozisyon bozulmaz), yüzü yatayda ortalar
 * ve dikeyde üst üçte bire yerleştirir. Görsel sınırlarını aşarsa kenetlenir.
 *
 * Döner: kırpılmış JPEG Buffer | null (kırpma gerekmiyorsa/yapılamıyorsa —
 * çağıran taraf orijinali kullanır, fail-safe).
 */
/**
 * cropForFaceRatio ile AYNI mantık, ama kırpılmış Buffer yerine kırpma
 * GEOMETRİSİNİ (left/top/cropW/cropH + orijinal boyut) döner — çağıran
 * taraf hem kırpılmış görseli üretebilsin hem de üretim bittikten sonra
 * sonucu orijinal tuvale GERİ YERLEŞTİREBİLSİN (bkz. recompositeIntoOriginal).
 * Döner: { left, top, cropW, cropH, imgW, imgH } | null.
 */
function computeFaceCrop(buf, box, currentRatio, targetRatio, imgW, imgH) {
  const scaleDown = targetRatio / currentRatio; // >1 => kadraj daraltılacak
  if (scaleDown <= 1.05) return null; // zaten yeterince yakın
  if (!imgW || !imgH) return null;

  let cropW = Math.round(imgW / scaleDown);
  let cropH = Math.round(imgH / scaleDown);
  if (cropW < 2 || cropH < 2) return null;

  const faceCx = box.x + box.width / 2;
  const faceCy = box.y + box.height / 2;
  let left = Math.round(faceCx - cropW / 2);
  let top = Math.round(faceCy - cropH * TEMPLATE_CROP_FACE_TOP);

  left = Math.max(0, Math.min(left, imgW - cropW));
  top = Math.max(0, Math.min(top, imgH - cropH));

  return { left, top, cropW, cropH, imgW, imgH };
}

async function cropForFaceRatio(buf, box, currentRatio, targetRatio) {
  try {
    if (!box || !(currentRatio > 0) || !(targetRatio > 0)) return null;
    const meta = await sharp(buf).metadata();
    const geo = computeFaceCrop(buf, box, currentRatio, targetRatio, meta.width, meta.height);
    if (!geo) return null;

    // NOT (2026-07-29): boyutları 16'nın katına hizalamayı denedim, sonra geri
    // aldım. gpt-image-2'nin "genişlik/yükseklik 16'ya bölünebilir olmalı"
    // şartı İSTENEN ÇIKTI boyutu (size parametresi) için geçerli — biz o
    // parametreyi göndermiyoruz, dolayısıyla GİRDİ görseli için bir zorunluluk
    // yok. Hizalama karşılığında en-boy oranında ~%2 sapma oluşuyordu; kanıtsız
    // bir fayda için gerçek bir bozulma kabul edilmedi.
    let out = sharp(buf).extract({ left: geo.left, top: geo.top, width: geo.cropW, height: geo.cropH });
    // Kırpma sonrası piksel sayısı düştü; modele küçük bir tuval vermemek için
    // uzun kenarı TEMPLATE_CROP_LONG_EDGE'e büyüt (zaten büyükse dokunma).
    // fit:"inside" en-boy oranını AYNEN korur (bkz. yukarıdaki 16-hizalama notu).
    if (Math.max(geo.cropW, geo.cropH) < TEMPLATE_CROP_LONG_EDGE) {
      out = out.resize(TEMPLATE_CROP_LONG_EDGE, TEMPLATE_CROP_LONG_EDGE, {
        fit: "inside",
        kernel: "lanczos3",
      });
    }
    return await out.jpeg({ quality: 92 }).toBuffer();
  } catch (e) {
    console.error("Şablon kırpma başarısız (orijinal kullanılıyor):", e);
    return null;
  }
}

/**
 * cropForFaceRatio ile AYNI geometriyi hesaplar ama Buffer yerine geometri
 * nesnesi döner — recompositeIntoOriginal bunu ihtiyaç duyar (bkz. orada).
 * Döner: { left, top, cropW, cropH, imgW, imgH } | null.
 */
async function computeFaceCropGeometry(buf, box, currentRatio, targetRatio) {
  try {
    if (!box || !(currentRatio > 0) || !(targetRatio > 0)) return null;
    const meta = await sharp(buf).metadata();
    return computeFaceCrop(buf, box, currentRatio, targetRatio, meta.width, meta.height);
  } catch (e) {
    console.error("Kırpma geometrisi hesaplanamadı:", e);
    return null;
  }
}

/**
 * ŞABLON YAKINLAŞTIRMASININ TERSİ: OpenAI'nin (kırpılmış tuval üzerinde)
 * ürettiği sonucu, ORİJİNAL taban fotoğrafın İÇİNE, aynı konum ve boyutta
 * geri yerleştirir. Amaç: taban fotoğrafın arka planı/kompozisyonu kırpma
 * ARTEFAKTI OLMADAN korunsun — model hiçbir zaman "geniş tuvali" görmediği
 * için arka planı yanlışlıkla değiştirme riski de yok.
 *
 * İKİ KAYIP KAYNAĞINI SINIRLAR:
 *  1) ÇİFTE RESAMPLE: kırpma sırasında görsel TEMPLATE_CROP_LONG_EDGE'e
 *     BÜYÜTÜLMÜŞTÜ (modele küçük tuval vermemek için). OpenAI o büyütülmüş
 *     boyutta üretim yapıp döndürür. Burada TEK bir adımda — doğrudan
 *     orijinal kırpma boyutuna (geo.cropW × geo.cropH) — küçültülür; büyüt-
 *     sonra-küçült yerine tek resample.
 *  2) SERT KENAR: kırpma dikdörtgeninin sınırında OpenAI'nin ürettiği ton/
 *     doku ile orijinalin geri kalanı arasında görünür bir çizgi olabilir.
 *     Bunu YUMUŞAK (feathered) bir maskeyle önlüyoruz: maskenin kenarları
 *     bulanıklaştırılmış, ortası tam opak — composite ile üst üste
 *     bindirildiğinde geçiş kademeli olur, sert bir dikdörtgen görünmez.
 *
 * outputBuf   : OpenAI'den dönen üretim sonucu (kırpılmış tuval üzerinde)
 * originalBuf : prepareTemplate'e giren, HİÇ kırpılmamış orijinal şablon
 * geo         : computeFaceCropGeometry'nin döndürdüğü { left, top, cropW, cropH, imgW, imgH }
 *
 * Döner: orijinal boyutta, yüzü değişmiş JPEG Buffer | null (başarısızsa —
 * çağıran taraf bu durumda kırpılmış (dar kadrajlı) sonucu kullanmaya devam
 * edebilir, üretim asla bloklanmaz).
 */
async function recompositeIntoOriginal(outputBuf, originalBuf, geo) {
  try {
    if (!geo) return null;
    const { left, top, cropW, cropH, imgW, imgH } = geo;

    // 1) TEK RESAMPLE: OpenAI çıktısını (büyütülmüş tuval) doğrudan orijinal
    // kırpma boyutuna küçült — ara adım yok.
    const patch = await sharp(outputBuf)
      .resize(cropW, cropH, { fit: "fill", kernel: "lanczos3" })
      .toBuffer();

    // 2) YUMUŞAK MASKE: beyaz dikdörtgen + kuvvetli Gaussian blur = kenarları
    // saydamlaşan bir alfa maskesi. Blur yarıçapı kırpma boyutuna göre
    // ölçekli (küçük kırpmada aşırı blur her şeyi saydamlaştırır).
    const featherPx = Math.max(8, Math.round(Math.min(cropW, cropH) * 0.06));
    const insetSvg =
      `<svg width="${cropW}" height="${cropH}">` +
      `<rect x="${featherPx}" y="${featherPx}" ` +
      `width="${Math.max(1, cropW - featherPx * 2)}" height="${Math.max(1, cropH - featherPx * 2)}" ` +
      `fill="white"/></svg>`;
    const mask = await sharp(Buffer.from(insetSvg))
      .blur(featherPx / 1.5)
      .png()
      .toBuffer();

    // Yamayı maskeyle birleştir: maskenin saydam (siyah) bölgeleri yamayı
    // saydamlaştırır, composite ile orijinalin üstüne bindirildiğinde altta
    // kalan orijinal piksel yumuşakça görünür.
    const patchWithAlpha = await sharp(patch)
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();

    // 3) Orijinal tuvalin üstüne, kırpmanın alındığı TAM konuma bindir.
    const result = await sharp(originalBuf)
      .composite([{ input: patchWithAlpha, left, top }])
      .jpeg({ quality: 92 })
      .toBuffer();

    // Boyut kontrolü — beklenmedik bir sapma olursa fail-safe null.
    const outMeta = await sharp(result).metadata();
    if (outMeta.width !== imgW || outMeta.height !== imgH) return null;

    return result;
  } catch (e) {
    console.error("Orijinale geri yerleştirme başarısız (kırpılmış sonuç kullanılacak):", e);
    return null;
  }
}

module.exports = {
  addPhoneCameraTexture,
  cropFaceRegion,
  normalizeExifOrientation,
  cropForFaceRatio,
  computeFaceCropGeometry,
  recompositeIntoOriginal,
};
