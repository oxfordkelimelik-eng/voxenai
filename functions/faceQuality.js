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
    return {
      descriptor: result.descriptor,
      faceRatio,
      profileDegree: profileDegreeFromLandmarks(result.landmarks),
    };
  } finally {
    tensor.dispose();
  }
}

/**
 * Yüzün ne kadar yandan göründüğünü kabaca ölçer: 0 = tam önden,
 * 1'e yakın = tam profil. Burun ucunun İKİ GÖZ KÖŞESİ arasındaki yatay
 * konumundan hesaplanır — kafa yana döndükçe burun bir kenara kayar.
 * Ölçülemezse null.
 *
 * NEDEN GEREKLİ (2026-08-04): face-api'nin kimlik vektörü çoğunlukla önden
 * yüzlerle eğitilmiştir; kafa yana döndüğünde mesafe KİMLİKTEN BAĞIMSIZ
 * olarak şişer. Gerçek ölçüm (aynı kullanıcı, aynı iş):
 *   profil<=0.45 -> mesafe 0.259, 0.292, 0.307, 0.329  (dar küme)
 *   profil >0.45 -> mesafe 0.373, 0.606, 0.802         (dağınık)
 * 0.802'lik kare GÖZLE GAYET İYİYDİ (telefonuna bakan, profilden bir kare)
 * ama kimlik kapısı onu eledi ve kullanıcı 5 yerine 4 foto aldı. Yani o
 * kapı profil karelerde kimliği değil, POZU ölçüyordu.
 */
function profileDegreeFromLandmarks(landmarks) {
  try {
    const lm = landmarks && landmarks.positions;
    if (!lm || lm.length < 46) return null;
    const leftEyeOuter = lm[36];
    const rightEyeOuter = lm[45];
    const noseTip = lm[30];
    const span = rightEyeOuter.x - leftEyeOuter.x;
    if (!isFinite(span) || Math.abs(span) < 1e-6) return null;
    const rel = (noseTip.x - leftEyeOuter.x) / span; // 0.5 = tam ortada
    return Math.min(1, Math.abs(rel - 0.5) * 2);
  } catch (e) {
    return null; // fail-safe: ölçemezsek eskisi gibi davran
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

// Bu derecenin üstünde kafa yana dönüktür ve kimlik mesafesi güvenilmez
// sayılır (bkz. profileDegreeFromLandmarks). 0.45, gerçek ölçümde önden
// karelerin oluşturduğu dar kümenin (maks 0.32) üstünde, profil karelerin
// (0.69+) altındadır.
const PROFILE_UNRELIABLE_MIN = 0.45;

// ...ama profil istisnasının da bir TAVANI var. Profil pozu mesafeyi şişirir,
// evet, ama sınırsız değil: bu değerin üstündeki bir mesafe artık "poz
// yüzünden" diye açıklanamaz, kare gerçekten bozuktur.
// GERÇEK OLAY (2026-08-04): mesafe 0.802'lik profil kare, şablonun ANA
// ÖZNESİ tespit edilemediği için ARKA PLANDAKİ bir yolcuya kırpılmıştı;
// model o kişiyi kullanıcıya çevirmeye çalışmıştı. Tavan olmasaydı bu kare
// Vision'a devredilir ve muhtemelen teslim edilirdi.
// Gözlenen profil mesafeleri: 0.373 / 0.606 (ikisi de sağlam, 0.606 zaten
// kullanıcıya teslim edilmişti) ve 0.802 (bozuk). 0.70 ikisini ayırır.
const PROFILE_DEFER_MAX_DISTANCE = 0.70;

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
    // PROFİL İSTİSNASI: kafa belirgin şekilde yana dönükse bu mesafe
    // GÜVENİLMEZ (bkz. profileDegreeFromLandmarks'taki ölçüm). Kareyi sert
    // reddetmek yerine, "no-face"te olduğu gibi kararı GÖRÜNTÜYÜ GERÇEKTEN
    // GÖREBİLEN Vision'a devrediyoruz — Vision referans selfie'lerle
    // karşılaştırma yapabildiği için profilde bizden daha yetkin.
    const pd = db.profileDegree;
    if (pd != null && pd > PROFILE_UNRELIABLE_MIN && distance < PROFILE_DEFER_MAX_DISTANCE) {
      return {
        ok: false, distance, faceRatio, blurScore,
        reason: "profile", profileDegree: pd,
      };
    }
    return { ok: false, distance, faceRatio, blurScore, reason: "identity", profileDegree: pd };
  }
  // 2) Kafa oranı: oransız büyük/küçük kafa (bobble-head) artefaktı?
  if (faceRatio < OUTPUT_FACE_RATIO_MIN || faceRatio > OUTPUT_FACE_RATIO_MAX) {
    return { ok: false, distance, faceRatio, blurScore, reason: "head-ratio", profileDegree: db.profileDegree };
  }
  // 2b) Şablona göre büyüme: model kafayı büyüttü mü? Sabit eşikten farkı,
  // kadrajdan bağımsız olması (bkz. OUTPUT_FACE_GROWTH_MAX).
  if (templateFaceRatio && templateFaceRatio > 0) {
    const growth = faceRatio / templateFaceRatio;
    if (growth > OUTPUT_FACE_GROWTH_MAX) {
      return { ok: false, distance, faceRatio, blurScore, reason: "head-grew", growth, profileDegree: db.profileDegree };
    }
  }
  // 3) Netlik: bariz bulanık/eritilmiş yüz? (fail-safe: kontrol hata verirse geç)
  try {
    const q = await assessImageQuality(buf);
    blurScore = q.blurScore;
    if (q.isBlurry) {
      return { ok: false, distance, faceRatio, blurScore, reason: "blurry", profileDegree: db.profileDegree };
    }
  } catch (e) {
    console.error("assessOutputFace netlik kontrolü başarısız (netlik atlanıyor):", e);
  }
  return { ok: true, distance, faceRatio, blurScore, reason: null, profileDegree: db.profileDegree };
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

// ---------------------------------------------------------------------------
// TEN RENGİ TUTARLILIĞI KAPISI (assessSkinToneConsistency)
//
// SORUN (2026-08-07, gerçek çıktı): elleriyle hindistan cevizi tutan bir karede
// yüz hedef kişinin ten renginde, ELLER ise taban fotoğraftaki kişinin
// (belirgin daha koyu) ten renginde kalmıştı. Ana prompt bunu zaten açıkça
// yasaklıyor ("SKIN COLOUR — WHOLE BODY, NO EXCEPTIONS") ve Vision kapısına da
// bu AYNI kare için "yüz ile eller aynı tonda mı?" diye soruluyordu — Vision
// "consistent skin tone" deyip GEÇİRDİ. Yani tek başına LLM yargısı bu hatayı
// yakalamıyor; ölçülebilir/deterministik bir ikinci kanıt gerekiyor.
//
// NEDEN "BU PİKSEL TEN Mİ?" DİYE SORMUYORUZ: ten rengi aralığı (YCbCr) kum,
// ahşap, hindistan cevizi kabuğu gibi arka plan nesneleriyle fena hâlde
// örtüşür — tam da bu karede. Böyle bir kural tek başına arka planı "bozuk
// ten" sanardı.
//
// BUNUN YERİNE — ÜÇ NOKTALI KARŞILAŞTIRMA: elimizde TABAN fotoğraf da var ve
// hata modu tam olarak "modelin taban kişinin tenini vücutta bırakması". Yani
// asıl soru şu: bu piksel YENİ kişinin yüz tonuna mı, yoksa ESKİ (taban)
// kişinin yüz tonuna mı daha yakın? Arka plan nesneleri ikisine de rastgele
// uzaklıktadır; "eski tona belirgin yakın" olmak ayırt edici bir kanıttır.
//
// AYIRT EDİCİLİK ŞARTI: taban kişi ile hedef kişinin ten tonu zaten birbirine
// yakınsa bu testin hiçbir ayırt etme gücü yoktur (her piksel ikisine de eşit
// uzaklıkta olur) — o durumda ölçüm yapılmaz, kare GEÇER. Yani kapı yalnızca
// kanıtın gerçekten var olabileceği durumda konuşur.
// ---------------------------------------------------------------------------

// Ölçüm bu uzun kenarda yapılır. Ten tonu düşük frekanslı bir sinyal —
// küçültmek hem gürültüyü azaltır hem CPU'yu (kare başına ~10ms) düşürür.
const SKIN_WORK_MAX_DIM = 384;
// Taban ve hedef yüz tonu arasında EN AZ bu kadar Lab farkı olmalı ki test
// ayırt edici sayılsın. Altındaysa ölçüm yapılmaz (bkz. yukarıdaki gerekçe).
const SKIN_MIN_DISCRIMINATION = 10;
// Bir piksel "eski tona ait" sayılmak için eski tona, yeni tondan bu kadar
// DAHA yakın olmalı. Sıfır olsaydı gölge/ışık gürültüsü kararı savurur.
const SKIN_LEFTOVER_MARGIN = 6;
// Yüz DIŞINDAKİ ten benzeri piksellerin bu oranı "eski tona ait" çıkarsa
// kare reddedilir. Muhafazakâr seçildi: yanlış pozitif, İYİ bir karenin
// ücretli olarak yeniden üretilmesi demek (bkz. 2026-07-22 kredi olayı).
const SKIN_MISMATCH_RATIO_MAX = 0.30;
// Bu sayıdan az ten benzeri piksel varsa (ör. sadece yüz görünüyor, vücut
// kadraj dışı/giyinik) kanıt yetersizdir — ölçüm yapılmaz, kare GEÇER.
const SKIN_MIN_SAMPLE_PIXELS = 300;

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * sRGB -> CIELAB (D65). Lab tercih edildi çünkü ten tonu farkı burada
 * ALGISAL mesafeye karşılık gelir; ham RGB mesafesi aynı işi görmez.
 */
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Klasik YCbCr ten-aralığı kuralı. Tek başına ten TESPİTİ için güvenilmez
 * (bkz. yukarıdaki not) — burada yalnızca ÖN ELEME olarak kullanılıyor:
 * gökyüzü/asfalt/yeşillik gibi apaçık ten olmayan pikselleri ucuza atar,
 * asıl kararı üç-noktalı karşılaştırma verir.
 */
function isSkinLike(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

// Ortalama DEĞİL medyan: tek bir parlak yansıma ya da koyu gölge ortalamayı
// kaydırır, medyanı kaydırmaz.
function medianLab(samples) {
  if (samples.length === 0) return null;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const col = samples.map((s) => s[c]).sort((a, b) => a - b);
    out.push(col[Math.floor(col.length / 2)]);
  }
  return out;
}

// L (açıklık) ağırlığı bilinçli olarak 1'den küçük: farklı kişilerin ten
// farkı hem L hem a/b'de görünür, ama GÖLGE neredeyse yalnızca L'yi
// oynatır. L'yi tam ağırlıkla saysaydık gölgede kalan bir el "başka kişi"
// gibi ölçülürdü.
const LAB_L_WEIGHT = 0.6;
function labDistance(p, q) {
  const dl = (p[0] - q[0]) * LAB_L_WEIGHT;
  const da = p[1] - q[1];
  const db = p[2] - q[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Görseli ölçüm boyutuna indirip ham RGB piksellerini döner. */
async function rawPixels(buf) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, SKIN_WORK_MAX_DIM / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  const { data } = await sharp(buf)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width, height, scale };
}

/**
 * Yüz kutusunun YANAK BANDINDAN (yatay orta %60, dikey %45-%80) ten tonunu
 * örnekler. Bu bant bilinçli: gözler, kaşlar, saç çizgisi ve ağız dışarıda
 * kalır — bunlar ten değil ve tonu kaydırırlar.
 */
function sampleFaceTone(px, box) {
  const s = px.scale;
  const x0 = Math.max(0, Math.floor((box.x + box.width * 0.20) * s));
  const x1 = Math.min(px.width, Math.ceil((box.x + box.width * 0.80) * s));
  const y0 = Math.max(0, Math.floor((box.y + box.height * 0.45) * s));
  const y1 = Math.min(px.height, Math.ceil((box.y + box.height * 0.80) * s));
  const samples = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * px.width + x) * 3;
      const r = px.data[o], g = px.data[o + 1], b = px.data[o + 2];
      if (isSkinLike(r, g, b)) samples.push(rgbToLab(r, g, b));
    }
  }
  return medianLab(samples);
}

/**
 * ÇIKTIDAKİ ten renginin vücut genelinde tutarlı olup olmadığını ÖLÇER.
 *
 * outputBuf   : üretilen kare
 * templateBuf : üretimde kullanılan TABAN fotoğraf (aynı kadraj/kırpma)
 *
 * Döner: { ok, reason, ratio, sampled, faceDelta }
 *   ok:false + reason:"skin" → vücutta taban kişinin teni kalmış.
 *   ok:true  + reason:"indistinguishable" | "insufficient-sample" | null
 *     → ölçüm yapılamadı ya da sorun yok (ikisi de KABUL — fail-safe).
 *
 * FAIL-SAFE: her hata durumunda ok:true. Bu kapı ASLA teknik bir aksaklık
 * yüzünden iyi bir kareyi elemez (dosyadaki diğer ikincil katmanlarla aynı
 * felsefe).
 */
async function assessSkinToneConsistency(outputBuf, templateBuf) {
  try {
    if (!outputBuf || !templateBuf) return { ok: true, reason: "insufficient-sample" };

    const [outFace, tplFace] = await Promise.all([
      detectMainFace(outputBuf),
      detectMainFace(templateBuf),
    ]);
    if (!outFace || !tplFace) return { ok: true, reason: "insufficient-sample" };

    const [outPx, tplPx] = await Promise.all([rawPixels(outputBuf), rawPixels(templateBuf)]);
    if (!outPx || !tplPx) return { ok: true, reason: "insufficient-sample" };

    const targetTone = sampleFaceTone(outPx, outFace.box); // yeni (hedef) kişi
    const baseTone = sampleFaceTone(tplPx, tplFace.box);   // eski (taban) kişi
    if (!targetTone || !baseTone) return { ok: true, reason: "insufficient-sample" };

    // Ayırt edicilik şartı — bkz. başlıktaki gerekçe.
    const faceDelta = labDistance(targetTone, baseTone);
    if (faceDelta < SKIN_MIN_DISCRIMINATION) {
      return { ok: true, reason: "indistinguishable", faceDelta };
    }

    // Yüz kutusunun DIŞINDA kalan ten benzeri pikseller: boyun, kollar,
    // eller, bacaklar. Yüz bölgesi hariç tutulur çünkü referans tonun
    // kendisi oradan alındı (kendisiyle karşılaştırmak anlamsız).
    const s = outPx.scale;
    const fx0 = (outFace.box.x) * s, fx1 = (outFace.box.x + outFace.box.width) * s;
    const fy0 = (outFace.box.y) * s, fy1 = (outFace.box.y + outFace.box.height) * s;

    let sampled = 0;
    let leftover = 0;
    for (let y = 0; y < outPx.height; y++) {
      for (let x = 0; x < outPx.width; x++) {
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue; // yüz bölgesi
        const o = (y * outPx.width + x) * 3;
        const r = outPx.data[o], g = outPx.data[o + 1], b = outPx.data[o + 2];
        if (!isSkinLike(r, g, b)) continue;
        sampled++;
        const lab = rgbToLab(r, g, b);
        const dTarget = labDistance(lab, targetTone);
        const dBase = labDistance(lab, baseTone);
        if (dBase + SKIN_LEFTOVER_MARGIN < dTarget) leftover++;
      }
    }

    if (sampled < SKIN_MIN_SAMPLE_PIXELS) {
      return { ok: true, reason: "insufficient-sample", sampled, faceDelta };
    }
    const ratio = leftover / sampled;
    if (ratio > SKIN_MISMATCH_RATIO_MAX) {
      return { ok: false, reason: "skin", ratio, sampled, faceDelta };
    }
    return { ok: true, reason: null, ratio, sampled, faceDelta };
  } catch (e) {
    console.error("Ten rengi kontrolü hata verdi (fail-safe kabul):", e.message || e);
    return { ok: true, reason: "insufficient-sample" };
  }
}

module.exports = {
  analyzeReferences,
  assessSkinToneConsistency,
  matchesIdentity,
  assessOutputFace,
  detectMainFace,
  FACE_MATCH_THRESHOLD,
};
