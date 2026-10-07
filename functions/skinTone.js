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
// Düzeltme gücü: 1.0 alanı birebir hedefe eşitler. Biraz pay bırakılır.
const STRENGTH = 0.9;
// Uzuv içi açıklık sapmasının (ışık izi) korunan payı.
const OWN_KEEP = 0.35;
// Işık payının mutlak tavanı (L birimi).
const MAX_LIGHT_ALLOW = 15;
// Kayma tavanları (Lab birimi).
const MAX_SHIFT_L = 28;
const MAX_SHIFT_AB = 10;
// Uzuvların yüzden farkı (açıklık, kroma, iç yayılım/2) bundan küçükse dokunulmaz.
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
// Bu kadar az vücut derisi pikseli varsa (kişi giyinik) iş yok.
const MIN_SKIN_PX = 400;

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

/** Ten renk ailesi (YCbCr), LUMA TABANI YOK — gölgedeki koyu ten de girer. */
function skinHue(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 20 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

const hueOf = (a, b) => Math.atan2(b, a) * 180 / Math.PI;
const ramp = (v, full, zero) =>
  (v <= full ? 1 : v >= zero ? 0 : (zero - v) / (zero - full));
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

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
function buildSkinField(rgb, W, H, region, R, faceHue) {
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
function planCorrection(field, limbW, faceTone, N) {
  const clamp = (v, lim) => (v > lim ? lim : v < -lim ? -lim : v);
  const limbL = [];
  for (let i = 0; i < N; i++) if (limbW[i] > 0.5) limbL.push(field.fL[i]);
  if (limbL.length < 20) return null;
  const limbMedL = median(limbL);

  // HEDEF AÇIKLIK = yüz + IŞIK İZİ (noktanın uzuv medyanından sapmasının
  // OWN_KEEP kadarı). Kolun bir ucunun koyu, öbür ucunun açık kalması (iki
  // tonlu kol) bu sapmadır; çoğu giderilir, ışık izi kalır.
  const dL = new Float32Array(N), dA = new Float32Array(N), dB = new Float32Array(N);
  const beforeL = [], afterL = [], beforeC = [], afterC = [];
  for (let i = 0; i < N; i++) {
    if (limbW[i] <= 0) continue;
    const allowL = clamp((field.fL[i] - limbMedL) * OWN_KEEP, MAX_LIGHT_ALLOW);
    dL[i] = clamp((faceTone[0] + allowL - field.fL[i]) * STRENGTH, MAX_SHIFT_L);
    dA[i] = clamp((faceTone[1] - field.fA[i]) * STRENGTH, MAX_SHIFT_AB);
    dB[i] = clamp((faceTone[2] - field.fB[i]) * STRENGTH, MAX_SHIFT_AB);
    if (limbW[i] > 0.5) {
      beforeL.push(field.fL[i]); afterL.push(field.fL[i] + dL[i]);
      beforeC.push(Math.hypot(faceTone[1] - field.fA[i], faceTone[2] - field.fB[i]));
      afterC.push(Math.hypot(faceTone[1] - field.fA[i] - dA[i], faceTone[2] - field.fB[i] - dB[i]));
    }
  }
  const stats = {
    // Yüz − uzuv açıklık farkı (medyan) ve kroma farkı.
    deltaLBefore: faceTone[0] - median(beforeL), deltaLAfter: faceTone[0] - median(afterL),
    chromaBefore: median(beforeC), chromaAfter: median(afterC),
    // İKİ TONLU KOL ÖLÇÜSÜ: uzuv alanındaki açıklık yayılımı (p90 − p10).
    spreadBefore: pct(beforeL, 0.9) - pct(beforeL, 0.1),
    spreadAfter: pct(afterL, 0.9) - pct(afterL, 0.1),
  };
  const worst = Math.max(Math.abs(stats.deltaLBefore), stats.chromaBefore, stats.spreadBefore / 2);
  return { dL, dA, dB, stats, needed: worst >= MIN_DELTA };
}

/**
 * @param {Buffer} outputBuf  teslim edilecek kare (tam kadraj)
 * @returns {{buf, applied, reason, deltaLBefore, deltaLAfter, chromaBefore, chromaAfter, spreadBefore, spreadAfter, skinPx, changedPx}}
 */
async function correctSkinToneField(outputBuf) {
  const skip = (reason, extra = {}) => ({ applied: false, reason, buf: null, ...extra });
  try {
    const { detectMainFace } = require("./faceQuality");
    const { classProbs, CLASSES } = require("./skinSeg");

    const meta = await sharp(outputBuf).metadata();
    const FW = meta.width, FH = meta.height;
    if (!FW || !FH) return skip("insufficient-input");
    const sc = Math.min(1, WORK_MAX_DIM / Math.max(FW, FH));
    const W = Math.max(1, Math.round(FW * sc)), H = Math.max(1, Math.round(FH * sc));
    const N = W * H;

    const face = await detectMainFace(outputBuf);
    if (!face) return skip("no-face");
    const box = { x: face.box.x * sc, y: face.box.y * sc, width: face.box.width * sc, height: face.box.height * sc };

    const work = await sharp(outputBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
    const P = await classProbs(work, W, H);
    const bodySkin = P[CLASSES.bodySkin], faceSkin = P[CLASSES.faceSkin];
    const person = new Float32Array(N);
    for (let i = 0; i < N; i++) person[i] = 1 - P[CLASSES.background][i];

    const faceTone = faceToneOf(work, W, H, box, faceSkin) || faceToneOf(work, W, H, box);
    if (!faceTone) return skip("no-face-tone");

    const pc = mainPersonComponent(person, W, H, box);
    if (!pc) return skip("no-person");

    // Bölge = ana kişinin VÜCUT DERİSİ olasılığı (yüz derisi, saç, kıyafet,
    // aksesuar zaten bu sınıfta değil).
    const othersNear = blurField(P[CLASSES.others], W, H, OTHERS_RADIUS);
    const region = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (!pc.comp[i]) continue;
      region[i] = smooth01((bodySkin[i] - BODY_SKIN_ZERO) / (BODY_SKIN_FULL - BODY_SKIN_ZERO)) *
        ramp(othersNear[i], OTHERS_FULL, OTHERS_ZERO);
    }
    const R = Math.max(4, box.height * FIELD_RADIUS_VS_FACE);
    const faceHue = hueOf(faceTone[1], faceTone[2]);
    const field = buildSkinField(work, W, H, region, R, faceHue);
    if (field.count < MIN_SKIN_PX) return skip("insufficient-skin", { skinPx: field.count });

    // Uzuv ağırlığı: bölge × alan güveni (çevrede yeterli ten yoksa alan
    // güvenilmez). İkisi de sürekli.
    const limbW = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (region[i] <= 0.02) continue;
      limbW[i] = region[i] * smooth01((field.conf[i] - 0.08) / 0.22);
    }
    const plan = planCorrection(field, limbW, faceTone, N);
    if (!plan) return skip("no-limb-skin", { skinPx: field.count });
    const stats = { ...plan.stats, skinPx: field.count };
    if (!plan.needed) return skip("tone-already-matches", stats);

    // Bölge ağırlığını hafifçe yumuşat (sınıf sınırı basamak bırakmasın).
    const wS = blurField(limbW, W, H, 2);

    // Tam çözünürlükte uygula. Kroma rampası PİKSEL başına ama sürekli.
    const { data, info } = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const kx = W / info.width, ky = H / info.height;
    let changed = 0;
    for (let Y = 0; Y < info.height; Y++) {
      const y = (Y + 0.5) * ky - 0.5;
      for (let X = 0; X < info.width; X++) {
        const x = (X + 0.5) * kx - 0.5;
        const w0 = sampleBilinear(wS, W, H, x, y);
        if (w0 <= 0.004) continue;
        const o = (Y * info.width + X) * 3;
        const lab = rgbToLab(data[o], data[o + 1], data[o + 2]);
        const fa = sampleBilinear(field.fA, W, H, x, y), fb = sampleBilinear(field.fB, W, H, x, y);
        const w = w0 * ramp(Math.hypot(lab[1] - fa, lab[2] - fb), CHROMA_FULL, CHROMA_ZERO);
        if (w <= 0.004) continue;
        let L = lab[0] + sampleBilinear(plan.dL, W, H, x, y) * w;
        L = L < 0 ? 0 : L > 100 ? 100 : L;
        const rgb = labToRgb(L, lab[1] + sampleBilinear(plan.dA, W, H, x, y) * w, lab[2] + sampleBilinear(plan.dB, W, H, x, y) * w);
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
        changed++;
      }
    }
    const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
      .jpeg({ quality: 95 }).toBuffer();
    return { buf, applied: true, reason: null, ...stats, changedPx: changed };
  } catch (e) {
    console.error("Ten tonu alan düzeltmesi hata verdi (fail-safe atlandı):", e.message || e);
    return skip("error");
  }
}

module.exports = {
  correctSkinToneField,
  _testables: { blurField, mainPersonComponent, buildSkinField, planCorrection, faceToneOf, skinHue },
};
