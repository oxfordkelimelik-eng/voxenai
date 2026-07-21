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
// bunun üzerinde (~95+) geliyor — düşürmek "temiz" hissi kırar. 86 -> 90:
// GPT Image 2 "medium" kalite katmanı zaten nano-banana-pro'dan daha az
// detaylı/keskin çıkıyor olabilir; üstüne 86 gibi belirgin bir sıkıştırma
// eklemek "netlik düşük" şikayetini büyütüyor olabilir — 90 hâlâ "temiz AI"
// hissini kırıyor ama gereksiz ek netlik kaybı eklemiyor.
const JPEG_QUALITY = 90;
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
// edilmeyen bir doku, göze batan bir efekt değil.
const GRAIN_ALPHA = 22;
// Gürültü genliği (gri ton ±). Yüksek olursa "bozuk görüntü" gibi durur.
const GRAIN_AMPLITUDE = 14;

/**
 * Rastgele luminance gürültüsünden düşük-opaklıklı bir RGBA PNG üretir.
 * sharp'ın composite() ile "overlay" harmanlamasında kullanılır.
 */
async function buildGrainLayer(width, height) {
  const buf = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = 128 + Math.round((Math.random() - 0.5) * 2 * GRAIN_AMPLITUDE);
    const gray = Math.max(0, Math.min(255, v));
    const off = p * 4;
    buf[off] = gray;
    buf[off + 1] = gray;
    buf[off + 2] = gray;
    buf[off + 3] = GRAIN_ALPHA;
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Görsele hafif grain + gerçekçi JPEG sıkıştırma uygular. Herhangi bir
 * adımda hata olursa ORİJİNAL buffer'ı döner (üretimi asla bloklamaz).
 */
async function addPhoneCameraTexture(buf) {
  try {
    const image = sharp(buf);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return buf;

    const grain = await buildGrainLayer(meta.width, meta.height);
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

module.exports = { addPhoneCameraTexture, cropFaceRegion, normalizeExifOrientation };
