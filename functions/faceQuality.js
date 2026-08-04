// Referans selfie kalite kapısı VE üretim çıktısı kimlik denetimi.
//
// İKİ AYRI GÖREV:
//   1) analyzeReferences() — kullanıcı fotoğraf seçerken (prepareReferencePhotos):
//      net/tek yüz kontrolü + en iyi referansın öne alınması + kaynak kimlik
//      vektörünün (ortalama descriptor) hesaplanması.
//   2) matchesIdentity() — fal.ai'den dönen HER üretilmiş görsel için
//      (falInferenceWebhook): o görseldeki yüzün, kaynak selfie'lerin kimlik
//      vektörüne yeterince yakın olup olmadığını kontrol eder. Yeterince
//      yakın değilse çağıran taraf o chunk'ı otomatik yeniden üretir (bkz.
//      falPhotos.js maybeRetryChunk) — kullanıcı hiçbir zaman "yüzü bozuk"
//      bir fotoğraf görmez.
//
// GEÇMİŞ NOT: Bu ikinci adım (kimlik karşılaştırması) bir ara koddan tamamen
// kaldırılmıştı ("üretim modeli zaten kimlik koşullu, ek kontrol gereksiz"
// varsayımıyla). Pratikte edit modelleri (nano-banana-pro/edit dahil) zaman
// zaman yüz şeklini bozan çıktılar üretebiliyor ve bunu yakalayan hiçbir
// mekanizma yoktu. Artık her chunk TEK görsel ürettiği için (num_images:1),
// "bu görsel geçmedi" = "bu chunk'ı yeniden üret" doğrudan mevcut retry
// altyapısına oturuyor — vaat edilen foto sayısı yine bozulmuyor.
//
// @tensorflow/tfjs-node (native) yerine bilerek saf WASM backend — native
// derleme Windows'ta ve Cloud Functions'ta kırılgandı; WASM platform bağımsız.
//
// GENİŞLETİLMİŞ RED KRİTERLERİ (3. görev): "net/tek yüz" yeterli değil —
// bulanık (Laplacian varyansı) ve aşırı pozlanmış (histogram clipping)
// referanslar da elenir. Bunlar "çöp girdi = çöp çıktı"nın somut örnekleri:
// özellikle ağır beautify/filtre uygulanmış selfie'ler genelde hem aşırı
// yumuşak (düşük varyans) hem aşırı parlak gelir — bu iki kontrol dolaylı
// olarak bu selfie'leri de yakalar (özel bir "filtre tespiti" değil, ama
// pratikte örtüşüyor).

const path = require("path");
const sharp = require("sharp");

// Yüzün kadrajda kaplaması gereken asgari oran (kenar). Bunun altındaki
// yüzler "net değil/uzak" sayılır.
// GEVŞETİLDİ (2026-07-26, "çok zor kabul ediyor" geri bildirimi): 0.12 -> 0.06.
const MIN_FACE_RATIO = 0.06;
// ssd_mobilenetv1 tespit güveni eşiği. GEVŞETİLDİ: 0.5 -> 0.35.
const MIN_DETECTION_CONFIDENCE = 0.35;

// Laplacian varyansı bu değerin ALTINDAYSA bulanık say.
// GEVŞETİLDİ (2026-07-26 kullanıcı geri bildirimi: "iyi çektiğim halde
// bulanık diyor"): 60 hâlâ gerçek, net telefon selfie'lerini yanlışlıkla
// reddediyordu — telefon kameralarının doğal (hafif) yumuşatma/ISO gürültü
// azaltma işlemede varyansı düşürebiliyor. 60 -> 25.
const BLUR_VARIANCE_MIN = 25;
// Görselin bu ORANDAN FAZLASI (0-1) neredeyse beyazsa (>250/255) aşırı
// pozlanmış say. GEVŞETİLDİ (2026-07-26): 0.45 -> 0.65.
const OVEREXPOSURE_CLIP_MAX = 0.65;

// Kimlik eşleşme eşiği (öklid mesafesi, düşük = daha benzer). face-api.js'in
// standart eşiği ~0.6, ama bu modelin (2018, face-api.js recognition net)
// belgelenmiş bir zayıflığı var: yanlış-red oranı modern modellere (ör.
// ArcFace/buffalo_l) göre yüksek — yani GERÇEKTE aynı kişi olan üretimleri
// bile gereksiz yere "eşleşmedi" sayıp retry'ye gönderiyor. ArcFace'e geçmek
// Cloud Functions'ta ek risk (native/WASM ONNX, ~190MB model, soğuk başlangıç
// — bkz. proje notları) taşıdığı için önce BEDAVA olan bu ayarı deniyoruz:
// eşik 0.60 -> 0.63 gevşetildi. Stil/ışık değişince aynı kişi zaten
// 0.55-0.65 aralığına düşebiliyordu; bu değişiklik yalnızca daha önce
// sınırda reddedilen gerçek-eşleşmeleri kabul etmeyi hedefliyor.
// KALİBRASYON NOTU: bu değer gerçek kullanıcı verisiyle kalibre edilmedi.
// 2026-07-23 GERÇEK VERİ (edit mimarisi, elegance): sınırda iyi yüzler
// RED(0.648) ve RED(0.758) ile eleniyordu — 5 fotodan 2'si boşuna kaybolup
// kullanıcı 3 foto alıyordu (retry=0). Eşik 0.63 -> 0.70: 0.648 gibi sınırda-
// kabul edilebilir yüzler geçer, 0.758 gibi açıkça yanlış yüzler yine reddedilir.
// Asıl çözüm buildEditPrompt'taki güçlendirilmiş yüz-sadakati (mesafeler zaten
// düşmeli); bu eşik yalnızca sınır kayıplarını azaltıyor.
//
// 0.70 -> 0.55 SIKILAŞTIRILDI (2026-08-04, İLK KEZ GERÇEK DAĞILIMLA):
// 2026-07-28'den itibaren loglanan 60 ölçümün TAMAMI geçti — yani 0.70 eşiği
// hiçbir zaman devreye girmedi, fiilen kapalı bir kapıydı. Gerçek dağılım:
//   0.210 ... 0.498 (58 kare, ana kütle)  |  0.534  |  [boşluk]  |  0.646
// 0.646'lık kare kullanıcı tarafından "taban fotoğraf gibi, yüz benzememiş"
// diye işaretlendi (smokinli, loş sahne). 0.534 ile 0.646 arasındaki doğal
// boşluk eşik için doğru yer: onaylanmış-kötü kareyi eler, ana kütleye ve
// 0.534'e dokunmaz (60 karede yalnızca 1 ret = %1.7).
// Ret = kare atılmaz, ÖNCE yeniden denenir (OPENAI_DIRECT_MAX_ATTEMPTS=2);
// iki deneme de tutmazsa o kare eksik kalır. Foto kaybı görülürse 0.60'a
// çekilebilir; "yüz benzemiyor" şikayeti sürerse 0.50'ye.
const FACE_MATCH_THRESHOLD = 0.55;

let _initPromise = null;
let _faceapi = null;

async function ensureModelsLoaded() {
  if (_faceapi) return _faceapi;
  if (!_initPromise) {
    _initPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      await tf.setBackend("wasm");
      await tf.ready();
      const modelPath = path.join(__dirname, "models");
      // Tespit + tanıma birlikte yüklenir — kimlik karşılaştırması için
      // landmark68 (hizalama) ve recognition (128 boyutlu descriptor) şart.
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
      _faceapi = faceapi;
      return faceapi;
    })();
  }
  return _initPromise;
}

// Yüz tespiti/tanıma için maksimum kenar uzunluğu. Modern telefon fotoları
// tam çözünürlükte tensöre çevrilince OOM oluyordu; ~800px fazlasıyla
// yeterli ve tensör boyutunu ~25x küçültür.
const MAX_FACE_DIM = 800;

/**
 * JPEG buffer'ı tensöre çevirir VE uygulanan küçültme ölçeğini döner
 * (scale=1 → küçültülmedi). Çağıran taraf, tensör-uzayındaki bir kutuyu
 * (ör. yüz bounding box) ORİJİNAL görsel piksel koordinatına
 * `box / scale` ile geri çevirebilir — bkz. detectSingleFace.
 */
function bufferToTensorScaled(buf) {
  const tf = require("@tensorflow/tfjs");
  const jpeg = require("jpeg-js");
  const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width, height, data } = decoded;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const longEdge = Math.max(width, height);
  const scale = longEdge <= MAX_FACE_DIM ? 1 : MAX_FACE_DIM / longEdge;
  const tensor = tf.tidy(() => {
    const full = tf.tensor3d(rgb, [height, width, 3]);
    if (scale === 1) return full;
    return tf.image
      .resizeBilinear(full, [Math.round(height * scale), Math.round(width * scale)])
      .toInt();
  });
  return { tensor, scale };
}

/**
 * Bir JPEG buffer'ında yüz TESPİTİ yapar (tanıma yok). Döner:
 *   { ok: true, area, box } → kadrajda yeterince büyük TAM OLARAK bir yüz
 *     var. box, ORİJİNAL görsel piksel koordinatlarında {x,y,width,height}
 *     (kırpma için — bkz. postProcess.cropFaceRegion).
 *   { ok: false }      → yüz yok, çok küçük, ya da birden fazla yüz.
 */
async function detectSingleFace(buf, { minFaceRatio = MIN_FACE_RATIO } = {}) {
  const faceapi = await ensureModelsLoaded();
  const { tensor, scale } = bufferToTensorScaled(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    const [h, w] = tensor.shape;
    const big = faces.filter((f) => {
      const ratio = Math.max(f.box.width / w, f.box.height / h);
      return ratio >= minFaceRatio;
    });
    if (big.length !== 1) return { ok: false };
    const b = big[0].box;
    const box = {
      x: b.x / scale, y: b.y / scale,
      width: b.width / scale, height: b.height / scale,
    };
    // ratio = yüzün kadrajı kaplama oranı (uzun kenar). Tam boy referansın
    // GERÇEKTEN tam boy olup olmadığını ayırt etmek için kullanılır
    // (yüz büyükse = yakın selfie, gövde görünmüyor — bkz. analyzeReferences).
    const ratio = Math.max(b.width / w, b.height / h);
    return { ok: true, area: (b.width * b.height) / (w * h), ratio, box };
  } finally {
    tensor.dispose();
  }
}

// Tam boy referansta yüz kadrajın küçük bir kısmıdır — yüz selfie eşiği
// (MIN_FACE_RATIO) ile reddedilmemeli.
// GEVŞETİLDİ (2026-07-26 kullanıcı geri bildirimi: "boydan seçtiğimiz
// fotoğrafı sürekli reddediyor"): uzaktan çekilmiş gerçek tam boy karelerde
// yüz çok küçük kalıp 0.04 altında tespit edilemiyordu → 0.015'e düşürüldü.
const MIN_FACE_RATIO_BODY = 0.015;
// ...ama yüz kadrajın ÜST sınırından da BÜYÜKSE bu tam boy değil, yakın bir
// selfie/portredir — gövde görünmüyordur, reddet. Kaba oran tahmini:
// tam boy yüz ~0.13, bel üstü ~0.28, baş-omuz selfie ~0.5. Eşik 0.35 -> 0.45:
// bel/kalça üstü kadrajları da (yüz biraz daha büyük görünse de) kabul eder,
// yalnızca gerçekten baş-omuz yakın çekimini eler. Client tarafı
// (GuidedCaptureScreen pose kontrolü) asıl "ayaklar kadrajda mı"yı tutuyor;
// bu sunucu kapısı yalnızca "sadece yüz gönderilmiş" durumunu yakalar.
const MAX_FACE_RATIO_BODY = 0.45;
// Açı çeşitliliği kapısı: iki YÜZ karesinin kimlik vektörü birbirine bu
// mesafeden yakınsa neredeyse aynı kare/açı sayılır (kullanıcı ör. 3 kez
// cepheden çekmiş) — farklı açı kimlik sadakatini artırır. MUHAFAZAKÂR:
// vektör mesafesi kimliği ölçer, açıyı değil (aynı kişinin farklı açıları da
// yakın çıkabilir) → yalnızca neredeyse-aynı kareleri yakalamak için düşük
// tutuldu (yanlış-red riski). Gerçek veriyle KALİBRE EDİLMEDİ; canlı çekim
// zaten yaw ile açı çeşitliliğini dayattığı için bu bir güvenlik ağıdır.
const DEDUP_MIN_DISTANCE = 0.25;

// İki 128-boyut descriptor arasındaki öklid mesafesi (faceapi'ye async
// erişim gerekmeden — dedup senkron çalışsın).
function euclideanDistanceLocal(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Laplacian varyansı (bulanıklık ölçütü — düşük = bulanık) ve aşırı pozlama
 * (neredeyse-beyaz piksel oranı) hesaplar. Yalnızca referans SEÇİMİNDE
 * kullanılır (üretim çıktısında değil — çıktının netliği zaten prompt'un
 * "CRAFT" bölümünde bilinçli olarak kusurlu isteniyor, orayı bulanıklık
 * kontrolüyle elemek amaca aykırı olurdu).
 */
async function assessImageQuality(buf) {
  const gray = sharp(buf).resize({ width: 600, withoutEnlargement: true }).grayscale();

  const [lap, exposure] = await Promise.all([
    gray.clone()
      // Laplacian kenar kernel'i; offset:128 negatif değerlerin 0'a
      // kırpılıp varyansı yapay düşürmesini önler (varyans sabit ekleme
      // altında değişmez, yalnızca kırpılmayı engelliyoruz).
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
      .raw()
      .toBuffer(),
    gray.clone().threshold(250).raw().toBuffer(),
  ]);

  let mean = 0;
  for (let i = 0; i < lap.length; i++) mean += lap[i];
  mean /= lap.length;
  let variance = 0;
  for (let i = 0; i < lap.length; i++) {
    const d = lap[i] - mean;
    variance += d * d;
  }
  variance /= lap.length;

  let clipped = 0;
  for (let i = 0; i < exposure.length; i++) if (exposure[i] > 0) clipped++;
  const clippedFraction = clipped / exposure.length;

  return {
    blurScore: variance,
    isBlurry: variance < BLUR_VARIANCE_MIN,
    clippedFraction,
    isOverexposed: clippedFraction > OVEREXPOSURE_CLIP_MAX,
  };
}

/**
 * Bir JPEG buffer'ından yüz descriptor'ı (128 boyutlu kimlik vektörü)
 * çıkarır. Yüz bulunamazsa null döner.
 */
async function descriptorFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = bufferToTensorScaled(buf);
  try {
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: MIN_DETECTION_CONFIDENCE,
      }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? result.descriptor : null;
  } finally {
    tensor.dispose();
  }
}

/**
 * descriptorFromBuffer'ın genişletilmiş hali: kimlik vektörünün YANINDA yüz
 * kutusunun görsele oranını da döndürür (kafa oransallığı kontrolü için).
 * Döner: { descriptor, faceRatio } — yüz yoksa null. faceRatio = yüz
 * kutusunun uzun kenarının görsel uzun kenarına oranı (küçük yüz -> düşük,
 * bobble-head/oransız büyük kafa -> yüksek).
 */
async function descriptorAndBoxFromBuffer(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = bufferToTensorScaled(buf);
  try {
    const [h, w] = tensor.shape; // [height, width, 3]
    // EŞİK AÇIKÇA VERİLİYOR: seçeneksiz çağrıldığında face-api kendi
    // varsayılanını (minConfidence 0.5) kullanıyordu, oysa projenin kalibre
    // edilmiş eşiği 0.35. Tutarlılık için açıkça geçiliyor.
    // NOT: bu tek başına "no-face" sorununu ÇÖZMEZ — 2026-08-03 çıktıları
    // üzerinde ölçüldüğünde tespit skorları zaten 0.93-0.99 aralığındaydı,
    // yani eşik hiç bağlayıcı değildi.
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: MIN_DETECTION_CONFIDENCE,
      }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!result) return null;
    const box = result.detection.box;
    const faceRatio = Math.max(box.width / w, box.height / h);
    return { descriptor: result.descriptor, faceRatio };
  } finally {
    tensor.dispose();
  }
}

/**
 * Referans fotoğrafları analiz eder.
 * Yeni akış: [ön, sağ, sol, tamBoy] — son kare beden referansı (küçük yüz OK).
 * facePhotoCount (varsayılan 3): ilk N kare yüz; kimlik vektörü tercihen
 * bunlardan ortalanır. bestIndex/bestBox yüz karelerinden seçilir.
 */
async function analyzeReferences(buffers, { facePhotoCount = 3 } = {}) {
  const unclearIndices = [];
  const notFullBodyIndices = [];
  let bestIndex = null;
  let bestArea = -1;
  let bestBox = null;
  const descriptors = [];
  // Sadece YÜZ karelerinin descriptor'ları (index'iyle) — açı dedup için.
  const faceDescriptors = [];

  for (let idx = 0; idx < buffers.length; idx++) {
    const isBodyRef = idx >= facePhotoCount;
    let detection;
    try {
      detection = await detectSingleFace(buffers[idx], {
        minFaceRatio: isBodyRef ? MIN_FACE_RATIO_BODY : MIN_FACE_RATIO,
      });
    } catch {
      unclearIndices.push(idx);
      continue;
    }
    if (!detection.ok) {
      unclearIndices.push(idx);
      continue;
    }
    // Tam boy referansı GERÇEKTEN tam boy mu: yüz kadrajın küçük bir kısmı
    // olmalı. Yüz üst orandan büyükse bu yakın bir selfie'dir, gövde
    // görünmüyordur — ayrı bir hata olarak işaretle (mesajı "net değil"den
    // farklı: kullanıcıya "tam boy ver" demeliyiz).
    if (isBodyRef && detection.ratio > MAX_FACE_RATIO_BODY) {
      notFullBodyIndices.push(idx);
      continue;
    }
    // Yüz var ama fotoğrafın genel kalitesi düşükse (bulanık/aşırı pozlanmış)
    // yine reddedilir — referans, üretimin kalite tavanını belirliyor.
    // Fail-safe: kalite kontrolünün KENDİSİ hata verirse yalnızca yüz
    // tespiti şartı uygulanır (bu ikincil kontrol üretimi bloklamaz).
    try {
      const quality = await assessImageQuality(buffers[idx]);
      if (quality.isBlurry || quality.isOverexposed) {
        unclearIndices.push(idx);
        continue;
      }
    } catch (e) {
      console.error("Görsel kalite kontrolü başarısız (yalnızca yüz tespiti uygulanıyor):", e);
    }
    // Yüz crop / bestIndex: yalnızca yüz karelerinden (tam boy hariç).
    if (!isBodyRef && detection.area > bestArea) {
      bestArea = detection.area;
      bestIndex = idx;
      bestBox = detection.box;
    }
    try {
      const d = await descriptorFromBuffer(buffers[idx]);
      // Kimlik ortalamasına yüz karelerini önceliklendir; beden karesi
      // düşük çözünürlüklü yüzle ortalamayı bozmasın.
      if (d && !isBodyRef) {
        descriptors.push(d);
        faceDescriptors.push({ idx, d });
      } else if (d && isBodyRef && descriptors.length === 0) {
        descriptors.push(d);
      }
    } catch {
      // Descriptor çıkarılamaması bu referansı net-değil saymaz (tespit zaten
      // geçti) — yalnızca ortalamaya katkısı olmaz.
    }
  }

  // Açı çeşitliliği: iki yüz karesi neredeyse aynı açıdaysa ikincisini
  // işaretle (kullanıcı onu farklı bir açıyla değiştirsin). Muhafazakâr eşik
  // — bkz. DEDUP_MIN_DISTANCE.
  const duplicateIndices = [];
  for (let a = 0; a < faceDescriptors.length; a++) {
    for (let b = a + 1; b < faceDescriptors.length; b++) {
      const dist = euclideanDistanceLocal(faceDescriptors[a].d, faceDescriptors[b].d);
      if (dist < DEDUP_MIN_DISTANCE && !duplicateIndices.includes(faceDescriptors[b].idx)) {
        duplicateIndices.push(faceDescriptors[b].idx);
      }
    }
  }

  let refDescriptor = null;
  if (descriptors.length > 0) {
    const len = descriptors[0].length;
    const avg = new Float32Array(len);
    for (const d of descriptors) {
      for (let i = 0; i < len; i++) avg[i] += d[i] / descriptors.length;
    }
    refDescriptor = avg;
  }

  return {
    unclearIndices,
    notFullBodyIndices,
    duplicateIndices,
    bestIndex,
    bestBox,
    refDescriptor,
    totalCount: buffers.length,
  };
}

/**
 * Üretilen bir görselin, kaynak kimlik vektörüne (refDescriptor) yeterince
 * benzeyip benzemediğini kontrol eder. Döner: { match: boolean, distance }.
 * Yüz bulunamazsa (nadir — model bazen kadraj dışına taşırabilir) match:false.
 */
async function matchesIdentity(buf, refDescriptor) {
  const faceapi = await ensureModelsLoaded();
  const d = await descriptorFromBuffer(buf);
  if (!d) return { match: false, distance: null };
  const ref = refDescriptor instanceof Float32Array
    ? refDescriptor
    : Float32Array.from(refDescriptor);
  const distance = faceapi.euclideanDistance(ref, d);
  return { match: distance < FACE_MATCH_THRESHOLD, distance };
}

// Üretilen çıktı karesinin yüzünün, taban SAHNEDEKİ kadrajın makul bir
// kısmını kaplaması beklenir. Bunun ALTI = yüz ya kadraj dışı ya da
// tespit güvenilmez; ÜSTÜ = oransız büyük kafa (bobble-head artefaktı).
//
// 0.75 -> 0.45 (2026-08-04): 62 gerçek ölçümde aralık 0.076-0.241 çıktı,
// yani 0.75 hiçbir zaman devreye girmedi (ölü eşik). 0.45 hâlâ gözlenen
// tavanın çok üstünde — yalnızca gerçekten grotesk bobble-head'i yakalar,
// meşru yakın plan kadrajlara dokunmaz.
const OUTPUT_FACE_RATIO_MIN = 0.05;
const OUTPUT_FACE_RATIO_MAX = 0.45;

// ŞABLONA GÖRE BÜYÜME SINIRI (2026-08-04). Sabit eşiğin zayıflığı şu:
// çıktının yüz oranı KADRAJA bağlı — uzak sahnede 0.08, yakın planda 0.24
// normaldir, dolayısıyla tek bir sayı ikisini birden yakalayamaz. Kadrajdan
// bağımsız soru şudur: model, ŞABLONDAKİ kafayı büyüttü mü?
// Gerçek eşleştirilmiş veri (şablon oranı -> çıktı oranı, 13 kare):
//   1.03, 1.15, 0.92, 0.80, 0.98, 0.78, 1.22, 0.74, 1.23, 1.03, 0.86, 1.02
// yani gözlenen bant ~0.74-1.23. 1.45 bunun belirgin üstünde: normal
// varyasyona dokunmaz, yalnızca bariz büyütmeyi eler.
// DÜRÜST SINIR: bu kontrol KABA büyümeyi yakalar; "dar omuzda kafa büyük
// duruyor" gibi ince oransızlığı YAKALAMAZ, çünkü yüz kutusu omuz genişliği
// hakkında bilgi taşımaz. O iş Vision'ın HEAD_VS_SHOULDERS sınıfına ait.
const OUTPUT_FACE_GROWTH_MAX = 1.45;

// KURTARMA EŞİĞİ (2026-08-03): profil/yan bakış karelerinde SSD skoru normal
// eşiğin altına düşüp yüz "yok" sayılıyordu. Gerçek ölçüm: 2026-08-03
// üretiminde 5 karenin 3'ü "no-face" verdi; bunlardan biri (Madrid terası,
// kişi yana bakıyor, elinde gözlük) 0.35'te hiç bulunamazken 0.20'de
// skor=0.251 ile bulundu ve yüz oranı 0.163 çıktı — yani yüz ORADAYDI.
// Bu bir sorun, çünkü yüz bulunamayınca KAFA ORANI ölçümü de kayboluyor ve
// oransız kafayı yakalayacak tek sayısal kapı devre dışı kalıyor.
//
// Ayrım şu: düşük skorlu tespit KİMLİK karşılaştırması için güvenilmez
// (descriptor gürültülü olur), ama kutunun BOYUTU için yeterlidir. Bu yüzden
// kurtarma tespiti yalnızca faceRatio ölçmek için kullanılır; kimlik kararı
// hâlâ "yüz yok" olarak Vision'a devredilir.
const RESCUE_DETECTION_CONFIDENCE = 0.2;

/**
 * Normal eşikte yüz bulunamadığında SADECE kafa oranını ölçmek için düşük
 * eşikli ikinci deneme. Döner: faceRatio | null. Kimlik için KULLANILMAZ.
 */
async function rescueFaceRatio(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor } = bufferToTensorScaled(buf);
  try {
    const [h, w] = tensor.shape;
    const faces = await faceapi.detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({
      minConfidence: RESCUE_DETECTION_CONFIDENCE,
    }));
    if (faces.length === 0) return null;
    let best = faces[0];
    for (const f of faces) {
      if (f.box.width * f.box.height > best.box.width * best.box.height) best = f;
    }
    return Math.max(best.box.width / w, best.box.height / h);
  } catch (e) {
    return null; // fail-safe: kurtarma başarısız olursa eskisi gibi davran
  } finally {
    tensor.dispose();
  }
}

/**
 * Üretilen çıktı karesi için BİRLEŞİK kalite kapısı (best-of-N seçimi ve
 * "bozuk kareyi yeniden üret" için): kimlik + netlik + kafa oranı.
 * Döner: { ok, distance, faceRatio, blurScore, reason }.
 *  - ok:false + reason: hangi kontrolün elediği (log/teşhis için).
 *  - distance: kimlik mesafesi (best-of-N sıralaması için de kullanılır;
 *    yüz yoksa null).
 * NOT: bu, referans SEÇİMİ değil, ÜRETİM ÇIKTISI kalitesi içindir — bu yüzden
 * assessImageQuality'nin bulanıklık eşiği (BLUR_VARIANCE_MIN) burada da
 * yeniden kullanılır (aynı kalibrasyon).
 */
async function assessOutputFace(buf, refDescriptor, templateFaceRatio = null) {
  const faceapi = await ensureModelsLoaded();
  let distance = null;
  let faceRatio = null;
  let blurScore = null;

  const db = await descriptorAndBoxFromBuffer(buf);
  if (!db) {
    // Yüz normal eşikte bulunamadı → kimlik ölçülemez, karar Vision'a gider.
    // Ama KAFA ORANI'nı yine de ölçmeyi dene (bkz. rescueFaceRatio): oransız
    // büyük kafa, kimlikten bağımsız ve tek başına eleme sebebidir.
    const rescued = await rescueFaceRatio(buf);
    if (rescued !== null && rescued > OUTPUT_FACE_RATIO_MAX) {
      return { ok: false, distance: null, faceRatio: rescued, blurScore: null, reason: "head-ratio" };
    }
    return { ok: false, distance: null, faceRatio: rescued, blurScore: null, reason: "no-face" };
  }
  faceRatio = db.faceRatio;

  const ref = refDescriptor instanceof Float32Array
    ? refDescriptor
    : Float32Array.from(refDescriptor);
  distance = faceapi.euclideanDistance(ref, db.descriptor);

  // 1) Kimlik: yüz kullanıcıya benziyor mu?
  if (distance >= FACE_MATCH_THRESHOLD) {
    return { ok: false, distance, faceRatio, blurScore, reason: "identity" };
  }
  // 2) Kafa oranı: oransız büyük/küçük kafa (bobble-head) artefaktı?
  if (faceRatio < OUTPUT_FACE_RATIO_MIN || faceRatio > OUTPUT_FACE_RATIO_MAX) {
    return { ok: false, distance, faceRatio, blurScore, reason: "head-ratio" };
  }
  // 2b) Şablona göre büyüme: model kafayı büyüttü mü? Sabit eşikten farkı,
  // kadrajdan bağımsız olması (bkz. OUTPUT_FACE_GROWTH_MAX).
  if (templateFaceRatio && templateFaceRatio > 0) {
    const growth = faceRatio / templateFaceRatio;
    if (growth > OUTPUT_FACE_GROWTH_MAX) {
      return { ok: false, distance, faceRatio, blurScore, reason: "head-grew", growth };
    }
  }
  // 3) Netlik: bariz bulanık/eritilmiş yüz? (fail-safe: kontrol hata verirse geç)
  try {
    const q = await assessImageQuality(buf);
    blurScore = q.blurScore;
    if (q.isBlurry) {
      return { ok: false, distance, faceRatio, blurScore, reason: "blurry" };
    }
  } catch (e) {
    console.error("assessOutputFace netlik kontrolü başarısız (netlik atlanıyor):", e);
  }
  return { ok: true, distance, faceRatio, blurScore, reason: null };
}

/**
 * TABAN ŞABLONUNDAKİ ANA kişinin yüzünü bulur (kadrajdaki EN BÜYÜK yüz —
 * arka planda duran kişiler değil). detectSingleFace'ten farkı: "tam olarak
 * 1 yüz" şartı YOK (şablonlarda arkada insanlar olabilir) ve asgari oran
 * filtresi YOK (amacı zaten KÜÇÜK yüzleri bulmak).
 *
 * Döner: { ratio, box } | null.
 *  - ratio: yüzün kadrajı kaplama oranı (assessOutputFace'teki ile aynı tanım)
 *  - box:   ORİJİNAL görsel koordinatlarında yüz kutusu (kırpma için)
 */
async function detectMainFace(buf) {
  const faceapi = await ensureModelsLoaded();
  const { tensor, scale } = bufferToTensorScaled(buf);
  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_CONFIDENCE,
    });
    const faces = await faceapi.detectAllFaces(tensor, options);
    if (faces.length === 0) return null;
    const [h, w] = tensor.shape;
    let best = faces[0];
    for (const f of faces) {
      if (f.box.width * f.box.height > best.box.width * best.box.height) best = f;
    }
    const b = best.box;
    return {
      ratio: Math.max(b.width / w, b.height / h),
      box: {
        x: b.x / scale, y: b.y / scale,
        width: b.width / scale, height: b.height / scale,
      },
    };
  } finally {
    tensor.dispose();
  }
}

module.exports = {
  analyzeReferences,
  matchesIdentity,
  assessOutputFace,
  detectMainFace,
  FACE_MATCH_THRESHOLD,
};
