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

// Gerçek telefon kamerası JPEG'lerine yakın kalite. 86 -> 90 (2026-08-xx,
// "netlik düşük" şikayeti) -> 94 (2026-08-16, "fotoğraflar kalitesiz geliyor";
// dating profillerinde profesyonel çekim de yaygın, "amatör telefon fotosu"
// varsayımı zayıfladı) -> 96 (2026-09-08, "yüz piksel piksel / pürüzlü /
// cansız" bildirimi). Sıkıştırma kaybı yüzde en çok göze batan yer; gerçekçilik
// zaten grain + chroma tarafından değil, modelin kendi dokusundan geliyor.
const JPEG_QUALITY = 96;
// Renk alt-örneklemesi. "4:2:0" renk çözünürlüğünü yatay+dikey YARIYA indirir;
// cilt tonu gibi yumuşak geçişlerde bu, yüzde bant/blok ve "pürüzlü" bir görüntü
// bırakıyordu (2026-09-08 bildirimi). "4:4:4" renk kanalını tam çözünürlükte
// tutar — dosya birkaç yüz KB büyür, karşılığında cilt geçişleri temiz kalır.
const JPEG_CHROMA_SUBSAMPLING = "4:4:4";
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
  // KORUMA ALANI GENİŞLETİLDİ (2026-09-08, "yüz piksel piksel / pürüzlü
  // duruyor" bildirimi). Eski pad (0.25/0.30) + featherStart 0.7, grain'in
  // yüz kutusunun HEMEN kenarında yeniden yükselmesine izin veriyordu —
  // yanak/çene/alın sınırı, kullanıcının en çok baktığı bölge, ölçüsüz
  // gürültü alıyordu. Artık koruma yüz kutusunun belirgin dışına taşıyor
  // (saç, boyun, kulak hattı dahil) ve geçiş çok daha dışarıda başlıyor.
  const padX = box.width * 0.55;
  const padY = box.height * 0.65;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + padX;
  const ry = box.height / 2 + padY;
  if (rx <= 0 || ry <= 0) return 1;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d = Math.sqrt(nx * nx + ny * ny); // 0=merkez, 1=elips kenarı
  const featherStart = 0.92; // bu mesafeye kadar grain TAMAMEN kapalı
  const featherEnd = 1.35; // bu mesafeden sonra grain tam
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
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: JPEG_CHROMA_SUBSAMPLING, mozjpeg: true })
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

// Kişiyi kadraja sığdırmak için kırpma en fazla bu yüz oranına kadar
// genişletilir (TEMPLATE_MIN_FACE_RATIO 0.13'ün biraz altı).
const PERSON_FIT_MIN_FACE_RATIO = 0.10;

/**
 * KIRPMA KİŞİYİ KESMESİN (2026-10-08, 272e656a c1). Kırpma dikdörtgeni
 * kolun içinden geçiyordu: geri yerleştirmede kenarın içinde modelin çizdiği
 * (birkaç piksel kaymış) kol, dışında şablonun kolu kaldı; yumuşak kenar
 * ikisini üst üste bindirip kolu silikleştirdi. Kırpma, yüz oranı
 * PERSON_FIT_MIN_FACE_RATIO'nun altına düşmeyecek kadar genişletilip kişinin
 * kutusunu (personBox: {x0,y0,x1,y1}) içine alacak şekilde kaydırılır.
 * En-boy oranı korunur. Sığmıyorsa sığabildiği kadar. SAF fonksiyon.
 */
function fitCropToPerson(geo, personBox, currentRatio) {
  if (!geo || !personBox) return geo;
  const { imgW, imgH } = geo;
  const m = Math.round(0.03 * Math.max(imgW, imgH));
  const px0 = Math.max(0, personBox.x0 - m);
  const px1 = Math.min(imgW, personBox.x1 + m);
  const py0 = Math.max(0, personBox.y0 - m);
  const py1 = Math.min(imgH, personBox.y1 + m);
  const inside = px0 >= geo.left && px1 <= geo.left + geo.cropW && py0 >= geo.top && py1 <= geo.top + geo.cropH;
  if (inside) return geo;
  const aspect = geo.cropW / geo.cropH;
  const maxW = Math.min(imgW, Math.floor((currentRatio / PERSON_FIT_MIN_FACE_RATIO) * imgW), Math.floor(imgH * aspect));
  const cropW = Math.min(Math.max(px1 - px0, Math.ceil((py1 - py0) * aspect)), maxW);
  if (cropW <= geo.cropW) return geo;
  const cropH = Math.round(cropW / aspect);
  // Kişi kutusu sığıyorsa onu ortala, sığmıyorsa eski kırpmanın merkezinde
  // kal (yüz kadrajda kalsın).
  const place = (lo, hi, size, oldLo, oldSize, max) => {
    const c = hi - lo <= size ? (lo + hi) / 2 : oldLo + oldSize / 2;
    return Math.max(0, Math.min(Math.round(c - size / 2), max - size));
  };
  const left = place(px0, px1, cropW, geo.left, geo.cropW, imgW);
  const top = place(py0, py1, cropH, geo.top, geo.cropH, imgH);
  return { left, top, cropW, cropH, imgW, imgH, fitted: true };
}

async function cropForFaceRatio(buf, box, currentRatio, targetRatio, personBox = null) {
  try {
    if (!box || !(currentRatio > 0) || !(targetRatio > 0)) return null;
    const meta = await sharp(buf).metadata();
    const geo = fitCropToPerson(computeFaceCrop(buf, box, currentRatio, targetRatio, meta.width, meta.height), personBox, currentRatio);
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
async function computeFaceCropGeometry(buf, box, currentRatio, targetRatio, personBox = null) {
  try {
    if (!box || !(currentRatio > 0) || !(targetRatio > 0)) return null;
    const meta = await sharp(buf).metadata();
    return fitCropToPerson(computeFaceCrop(buf, box, currentRatio, targetRatio, meta.width, meta.height), personBox, currentRatio);
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
 * keepMask    : (isteğe bağlı) { png, fwFrac } — kırpılmış tuval boyunda tek kanallı
 *               maske (bkz. hatDetect.detectTemplateHat maskPng); içinde yama TAM
 *               opak kalır (aşağıda ŞAPKA BÖLGESİ). Yoksa davranış bugünküyle aynı.
 *
 * Döner: orijinal boyutta, yüzü değişmiş JPEG Buffer | null (başarısızsa —
 * çağıran taraf bu durumda kırpılmış (dar kadrajlı) sonucu kullanmaya devam
 * edebilir, üretim asla bloklanmaz).
 */
// DİKİŞ KAPISI (2026-11-15, 1cc3e022 c9, kullanıcı: "görselde kayma olmuş"): model kırpım
// içinde sahneyi de yeniden diziyor (ayakkabı yukarı, koltuk sola, poster yazısı yukarı);
// geri yapıştırınca kenarda iki sahne üst üste biniyor (çift koltuk kolu/ayakkabı, kesik
// yazı). Yamanın tam opak iç bandında (yumuşatma payının 1.6-3.2 katı içeride) dokulu
// bloklar şablonun aynı yerinde ±5 px (çalışma boyu; kırpım eni 380 px) içinde aranır;
// bulunamayan blok "kaybolmuş" sayılır. 7 iş × 6 kırpılan şablon (42 kare): kusurlu
// 11-15 c9 %42, 11-08 c9 %50; temizlerin en kötüsü %3. Küçük kayma (2-5 px, dalga/doku)
// gözle görünmüyor (11-15 c3 %50 kaymış, 0 kaybolmuş, temiz) — kapı onu saymaz.
// Tutmazsa null döner: çağıran kırpılmış (dar kadraj) sonucu kullanır.
const SEAM_GATE_ON = true;
const SEAM_WORK_W = 380;
const SEAM_BLOCK = 12;
const SEAM_SEARCH = 5;
const SEAM_BAND = [1.6, 3.2];
const SEAM_MIN_VAR = 30;
const SEAM_MATCH_NCC = 0.5;
const SEAM_MIN_BLOCKS = 40;
const SEAM_LOST_MAX = 0.15;

/**
 * Yama ile şablonun kırpım kenarında örtüşmesi (bkz. SEAM_GATE_ON). patchGray: kırpım boyunda
 * (PW×PH) gri yama; baseGray: tuval boyunda (BW×BH) gri şablon; L/T yamanın tuvaldeki yeri;
 * fp yumuşatma payı (hepsi aynı çalışma ölçeğinde). SAF. Döner { n, lost, frac }.
 */
function seamMismatch(patchGray, PW, PH, baseGray, BW, BH, L, T, fp) {
  const blk = SEAM_BLOCK, S = SEAM_SEARCH;
  let n = 0, lost = 0;
  const stats = (bx, by, dx, dy) => {
    let a = 0, b = 0, aa = 0, bb = 0, ab = 0, q = 0;
    for (let y = by; y < by + blk; y++) for (let x = bx; x < bx + blk; x++) {
      const u = patchGray[y * PW + x], v = baseGray[(T + y + dy) * BW + L + x + dx];
      a += u; b += v; aa += u * u; bb += v * v; ab += u * v; q++;
    }
    const va = aa / q - (a / q) ** 2, vb = bb / q - (b / q) ** 2;
    return { r: (ab / q - (a / q) * (b / q)) / Math.sqrt(va * vb + 1e-9), va, vb };
  };
  for (let by = 0; by + blk <= PH; by += blk) for (let bx = 0; bx + blk <= PW; bx += blk) {
    const cx = bx + blk / 2, cy = by + blk / 2;
    const d = Math.min(cx, PW - cx, cy, PH - cy);
    if (d < fp * SEAM_BAND[0] || d > fp * SEAM_BAND[1]) continue;
    if (L + bx - S < 0 || T + by - S < 0 || L + bx + blk + S > BW || T + by + blk + S > BH) continue;
    const z = stats(bx, by, 0, 0);
    if (z.va < SEAM_MIN_VAR || z.vb < SEAM_MIN_VAR) continue; // dokusuz blok bilgi taşımaz
    n++;
    let best = z.r;
    for (let dy = -S; dy <= S && best < SEAM_MATCH_NCC; dy++) for (let dx = -S; dx <= S; dx++) {
      const r = stats(bx, by, dx, dy).r;
      if (r > best) best = r;
      if (best >= SEAM_MATCH_NCC) break;
    }
    if (best < SEAM_MATCH_NCC) lost++;
  }
  return { n, lost, frac: n ? lost / n : 0 };
}

async function seamCheck(patch, base, { left, top, cropW, cropH, imgW, imgH, featherPx }) {
  const k = Math.min(1, SEAM_WORK_W / cropW);
  const PW = Math.max(1, Math.round(cropW * k)), PH = Math.max(1, Math.round(cropH * k));
  const BW = Math.max(1, Math.round(imgW * k)), BH = Math.max(1, Math.round(imgH * k));
  const [pg, bg] = await Promise.all([
    sharp(patch).removeAlpha().resize(PW, PH, { fit: "fill" }).greyscale().raw().toBuffer(),
    // Döndürme YOK: yapıştırma (composite) da tabanı ham yönüyle kullanıyor.
    sharp(base).removeAlpha().resize(BW, BH, { fit: "fill" }).greyscale().raw().toBuffer(),
  ]);
  const L = Math.min(BW - PW, Math.round(left * k)), T = Math.min(BH - PH, Math.round(top * k));
  return seamMismatch(pg, PW, PH, bg, BW, BH, Math.max(0, L), Math.max(0, T), featherPx * k);
}

async function recompositeIntoOriginal(outputBuf, originalBuf, geo, { scale = 1, keepMask = null, seamGate = SEAM_GATE_ON, logTag = "" } = {}) {
  try {
    if (!geo) return null;
    // scale > 1 (bkz. recompositeScale): orijinal tuval büyütülür, yama kendi
    // çözünürlüğüne yakın kalır.
    const imgW = Math.round(geo.imgW * scale);
    const imgH = Math.round(geo.imgH * scale);
    const cropW = Math.min(imgW, Math.round(geo.cropW * scale));
    const cropH = Math.min(imgH, Math.round(geo.cropH * scale));
    const left = Math.min(imgW - cropW, Math.round(geo.left * scale));
    const top = Math.min(imgH - cropH, Math.round(geo.top * scale));
    const base = scale === 1 ? originalBuf : await sharp(originalBuf).resize(imgW, imgH, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();

    // 1) TEK RESAMPLE: OpenAI çıktısını (büyütülmüş tuval) doğrudan orijinal
    // kırpma boyutuna küçült — ara adım yok.
    const patch = await sharp(outputBuf)
      .resize(cropW, cropH, { fit: "fill", kernel: "lanczos3" })
      .toBuffer();

    // 2) YUMUŞAK MASKE: beyaz dikdörtgen + kuvvetli Gaussian blur = kenarları
    // saydamlaşan bir alfa maskesi. Blur yarıçapı kırpma boyutuna göre
    // ölçekli (küçük kırpmada aşırı blur her şeyi saydamlaştırır).
    const featherPx = Math.max(8, Math.round(Math.min(cropW, cropH) * 0.06));
    if (seamGate) {
      try {
        const sm = await seamCheck(patch, base, { left, top, cropW, cropH, imgW, imgH, featherPx });
        const fail = sm.n >= SEAM_MIN_BLOCKS && sm.frac > SEAM_LOST_MAX;
        console.log(`GERİ YERLEŞTİRME DİKİŞİ${logTag}: ${fail ? "TUTMADI (kırpılmış kadraj teslim)" : "TUTTU"} kayıpBlok=${sm.lost}/${sm.n} (%${Math.round(sm.frac * 100)}) eşik=%${Math.round(SEAM_LOST_MAX * 100)}`);
        if (fail) return null;
      } catch (e) {
        console.error("Geri yerleştirme dikiş ölçümü hata verdi (geri yerleştiriliyor):", e.message || e);
      }
    }
    const insetSvg =
      `<svg width="${cropW}" height="${cropH}">` +
      `<rect x="${featherPx}" y="${featherPx}" ` +
      `width="${Math.max(1, cropW - featherPx * 2)}" height="${Math.max(1, cropH - featherPx * 2)}" ` +
      `fill="white"/></svg>`;
    let mask = await sharp(Buffer.from(insetSvg))
      .blur(featherPx / 1.5)
      .png()
      .toBuffer();
    if (keepMask && keepMask.png) mask = await keepMaskOpaque(mask, keepMask, cropW, cropH);

    // Yamayı maskeyle birleştir: maskenin saydam (siyah) bölgeleri yamayı
    // saydamlaştırır, composite ile orijinalin üstüne bindirildiğinde altta
    // kalan orijinal piksel yumuşakça görünür.
    const patchWithAlpha = await sharp(patch)
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();

    // 3) Orijinal tuvalin üstüne, kırpmanın alındığı TAM konuma bindir.
    // ÇİFT SIKIŞTIRMA (2026-09-08): buradaki çıktı doğrudan kullanıcıya
    // gitmiyor — addPhoneCameraTexture onu tekrar JPEG'e kodluyor. Ara adımda
    // 92 kalite + varsayılan 4:2:0 kullanmak, yüzde iki kez sıkıştırma kaybı
    // demekti ("piksel piksel / pürüzlü yüz" bildirimi). Ara ürün artık
    // kayıpsız PNG; tek gerçek sıkıştırma son adımda yapılıyor.
    const result = await sharp(base)
      .composite([{ input: patchWithAlpha, left, top }])
      .png()
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

// ŞAPKA BÖLGESİ YAMADAN (2026-11-06, şapkalı şablon promptu incelemesi): kırpma
// kenarının yumuşak bandı (kırpma kenarının 0.06'sı) şapka tepesine denk gelince
// şablonun ASIL şapkası, modelin (biraz aşağı/küçük çizdiği) şapkasının üstüne yarı
// saydam kubbe olarak karışıyordu (0eeb75c8 c3: şapka tepesi kenardan ~120 px,
// bant 125 px; 7e04933e c1: 45 px / 52 px). Ham çıktıda kubbe yok. Bitirmede
// ghostClean/iz detektörü bu kubbeyi şablon izi sayıp opak şapkayı da kesti.
// Şablon şapka maskesinde (biraz genişletilmiş, yumuşak kenarlı) yama tam opak:
// orada yalnız modelin çizdiği görünür. Maske yoksa (şapkasız şablon) hiçbir şey
// değişmez.
// Maskenin yumuşatma yarıçapı (yüz genişliği) ve kazancı: kazanç 3 ile alfa maske
// kenarının ~0.05 yüz dışına kadar 1, ~0.3 yüzde 0'a iner. Şablon şapkasının kenarı
// bulanık (segmentasyon maskesinin dışına taşar): 0.05'te maske dışındaki 0-0.08 yüz
// halkasında şablon hâlâ karışıyordu (yama farkı 0eeb75c8 c10 4.4-8.7, normal kenar
// bandı 2.3-4.5); 0.12'de 0.2-2.5.
const KEEP_SOFT_FACE = 0.12;
const KEEP_GAIN = 3;
async function keepMaskOpaque(featherMask, keepMask, cropW, cropH) {
  const n = cropW * cropH;
  // TEK KANAL TUZAĞI (hafıza sharp-mask-channel-trap): her adımda extractChannel.
  const fa = await sharp(featherMask).ensureAlpha().extractChannel(3).raw().toBuffer();
  const fwPx = Math.max(1, (keepMask.fwFrac || 0.1) * cropW);
  const km = await sharp(Buffer.isBuffer(keepMask.png) ? keepMask.png : Buffer.from(keepMask.png))
    .extractChannel(0)
    .resize(cropW, cropH, { fit: "fill", kernel: "linear" })
    .blur(Math.max(0.3, KEEP_SOFT_FACE * fwPx))
    .extractChannel(0)
    .raw()
    .toBuffer();
  if (fa.length !== n || km.length !== n) throw new Error("şapka maskesi boyutu tutmuyor");
  for (let i = 0; i < n; i++) {
    const k = Math.min(255, km[i] * KEEP_GAIN);
    if (k > fa[i]) fa[i] = k;
  }
  return sharp(Buffer.alloc(n * 3, 255), { raw: { width: cropW, height: cropH, channels: 3 } })
    .joinChannel(fa, { raw: { width: cropW, height: cropH, channels: 1 } })
    .png()
    .toBuffer();
}

// YÜZ DETAYI KÜÇÜLMESİN (2026-10-22, kullanıcı: "yüzdeki detayları
// göstermek"): üretim 1.5 kat çözünürlükte (bkz. falPhotos hiResSize), ama
// küçük şablonda (1170x1560) yama kırpma boyutuna küçültülünce yüz yine
// ~100 px'e iniyordu. Yama küçülecekse orijinal tuval büyütülür; uzun kenar
// RECOMPOSITE_LONG_MAX ile sınırlı (son katmanların süresi/belleği). Büyük
// şablonda (3072) yama zaten büyütülüyor — tuvale dokunulmaz.
const RECOMPOSITE_LONG_MAX = 2600;

/** Geri yerleştirmede orijinal tuvalin ölçeği (≥ 1). SAF. */
function recompositeScale(patchW, geo) {
  if (!geo || !(patchW > 0) || !(geo.cropW > 0)) return 1;
  const f = Math.min(patchW / geo.cropW, RECOMPOSITE_LONG_MAX / Math.max(geo.imgW, geo.imgH));
  return f > 1.02 ? f : 1;
}

module.exports = {
  _testables: { keepMaskOpaque, KEEP_SOFT_FACE, KEEP_GAIN, seamMismatch, seamCheck, SEAM_GATE_ON, SEAM_LOST_MAX, SEAM_MIN_BLOCKS },
  recompositeScale,
  RECOMPOSITE_LONG_MAX,
  addPhoneCameraTexture,
  cropFaceRegion,
  normalizeExifOrientation,
  cropForFaceRatio,
  computeFaceCropGeometry,
  recompositeIntoOriginal,
  fitCropToPerson,
};
