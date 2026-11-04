// IŞIKLI SON KATMAN (2026-10-21).
//
// postTasks.layers'ta arka plan geri yüklemeden SONRA, siyah-beyaz son
// geçişten ÖNCE çalışır. Önce ops panelinde önizleme olarak denendi.
//
// HEDEF: kullanıcının verdiği FaceApp öncesi/sonrası çifti ölçüldü
// (glow_compare/faceapp_once.png → faceapp_sonra.png). Etki yüze lokal bir
// ışık DEĞİL, tüm kareye uygulanan bir ton eğrisi:
//  • Aynı başlangıç parlaklığında arka plan ve yüz neredeyse aynı kalkıyor
//    (L 40-49: arka plan +10.3, yüz +10.7). Siyah/beyaz uçlar ~+2, orta
//    tonlar ~+10 → gece gökyüzü siyah kalır, yüz/duvar aydınlanır.
//  • Orta tonlarda hafif sıcaklık (b* +2..3, a* +1.5).
//  • Ciltte ek: gölgeler ~+3 fazla kalkıyor; koyu ten tonu daha sarıya,
//    açık ten tonu nötre kayıyor; kırmızılık azalıyor.
//  • Doku YUMUŞATILMIYOR, netleşiyor (yüz Laplasyen rms 15.5 → 22.1).
//  • Alına toplanan parlama ya da çene gölgesi YOK.
// Aşağıdaki eğriler bu ölçümden (başlangıç L kovalarına göre ortalama Δ)
// alındı; strength=1 örnekle aynı miktardır.
//
// VARSAYILAN (kullanıcı kararı, 2026-10-21): kişiye 0.6, arka plana 0.3 —
// yalnız kişiye uygulanınca gece/loş sahnede kişi sahneden kopuyordu; arka
// plan yarı güçte aydınlanınca uyum korunuyor, şablondan da az uzaklaşıyor.
// Geçiş kişi maskesinin yumuşak kenarı üzerinden.

const sharp = require("sharp");

const DEFAULT_STRENGTH = 0.6;
const DEFAULT_BG_STRENGTH = 0.3;

// YALNIZ KOYU/LOŞ ARKA PLANDA. Ölçü MEDYAN L: lunapark/restoran gibi sahnede
// birkaç parlak lamba ortalamayı 40+'a çekip katmanı atlıyordu (b2a9537d c3).
// Medyan gökyüzü/zemin koyuluğunu tutar. Eşikler 28/36 → 32/48: alacakaranlık
// ve loş iç mekân kısmi güç alır, plaj/bahçe (L 55+) hâlâ atlanır.
const BG_DARK_L = 32;
const BG_BRIGHT_L = 48;
// Arka plan karenin bundan azını kaplıyorsa (kişi kadrajı dolduruyor)
// ölçüm tüm kareden yapılır.
const MIN_BG_SHARE = 0.05;

// Düğüm noktaları: [L, Δ]. Ara değerler doğrusal.
const DL_CURVE = [[0, 0], [5, 2], [15, 5.4], [25, 7.3], [35, 8.9], [45, 10.3], [55, 10.9], [65, 10.3], [75, 9.0], [85, 6.2], [95, 2.1], [100, 0]];
const DA_CURVE = [[0, 0], [5, 0.6], [15, 1.1], [25, 1.6], [35, 1.8], [45, 1.3], [55, 0.8], [65, 0], [100, 0]];
const DB_CURVE = [[0, 0], [5, 0.3], [15, 1.2], [25, 2.3], [35, 3.2], [45, 2.7], [55, 1.9], [65, 1.0], [80, 0.8], [100, 0]];
// Cilde (yüz + vücut) genel eğrinin ÜSTÜNE eklenen fark.
const SKIN_DL_EXTRA = [[0, 0], [15, 2.8], [25, 3.4], [35, 1.9], [45, 0.3], [55, -0.5], [65, -1.0], [75, -0.5], [100, 0]];
const SKIN_DB_EXTRA = [[0, 3], [15, 3.0], [25, 1.9], [35, 0.2], [45, 0.3], [55, -0.2], [65, -1.2], [75, -2.9], [100, -2]];
const SKIN_DA_EXTRA = -1.5;

// Netlik: unsharp mask; m2 strength ile ölçeklenir (örnek çiftte doku
// artışını tutturan değer).
const SHARPEN_SIGMA = 1.0;
const SHARPEN_M2_PER_STRENGTH = 0.9;

// Ortalama kroma bunun altındaysa kare siyah-beyaz sayılır: renk kayması
// uygulanmaz, yalnız ton eğrisi + netlik.
const GRAYSCALE_CHROMA = 3;

function curveAt(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let k = 1; k < curve.length; k++) {
    if (x <= curve[k][0]) {
      const [x0, y0] = curve[k - 1], [x1, y1] = curve[k];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

/** L (0..100, 0.25 adım) → Δ tablosu; piksel döngüsünde interpolasyon yerine. */
function tabulate(curve) {
  const t = new Float32Array(401);
  for (let i = 0; i <= 400; i++) t[i] = curveAt(curve, i / 4);
  return t;
}

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
}
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fLabInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
const linToSrgb8 = (c) => {
  const v = c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c;
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
};

function rgbToLab(r, g, b) {
  const R = SRGB_TO_LIN[r], G = SRGB_TO_LIN[g], B = SRGB_TO_LIN[b];
  const x = fLab((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = fLab(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = fLab((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fLabInv(fx) * 0.95047, Y = fLabInv(fy), Z = fLabInv(fz) * 1.08883;
  return [
    linToSrgb8(X * 3.2406 + Y * -1.5372 + Z * -0.4986),
    linToSrgb8(X * -0.9689 + Y * 1.8758 + Z * 0.0415),
    linToSrgb8(X * 0.0557 + Y * -0.204 + Z * 1.057),
  ];
}

/**
 * @param {Buffer} buf  JPEG/PNG
 * @param {{strength?: number, bgStrength?: number}} [opts]
 *   strength: kişideki güç; 1 = FaceApp örneğiyle aynı miktar.
 *   bgStrength: arka plandaki güç. strength'e eşitse tüm kare (örnekteki
 *   gibi), 0 ise arka plan şablondaki hâliyle kalır.
 * @returns {Promise<{buf: Buffer|null, applied: boolean, reason?: string, bgL?: number, gate?: number, grayscale?: boolean, skinShare?: number}>}
 *   applied=false iken buf null — çağıran kendi karesini korur.
 */
async function applyGlowFilter(buf, { strength = DEFAULT_STRENGTH, bgStrength = DEFAULT_BG_STRENGTH } = {}) {
  const { data: rgb, info } = await sharp(buf).rotate().removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;

  // Maske olmadan arka plan parlaklığı ölçülemez ve kişi ayrılamaz → atla.
  const { classProbs, CLASSES } = require("./skinSeg");
  const P = await classProbs(rgb, W, H);

  let bgSum = 0, bgW = 0, allSum = 0, allN = 0;
  const bgSamples = [];
  for (let i = 0; i < N; i += 3) {
    const L = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])[0];
    const b = P[CLASSES.background][i];
    bgSum += b * L; bgW += b;
    allSum += L; allN++;
    if (b > 0.55) bgSamples.push(L);
  }
  bgSamples.sort((a, b) => a - b);
  const meanL = bgW / allN >= MIN_BG_SHARE ? bgSum / bgW : allSum / allN;
  const bgL = bgSamples.length >= 80 ? bgSamples[bgSamples.length >> 1] : meanL;
  const gate = bgGate(bgL);
  if (gate <= 0) return { buf: null, applied: false, reason: "bright-bg", bgL, gate };
  strength *= gate;
  bgStrength *= gate;
  // Çok koyu sahnede (lunapark/restoran) yüz hâlâ sönük kalıyordu.
  if (bgL <= 22 && gate >= 1) {
    strength = Math.max(strength, 0.75);
    bgStrength = Math.max(bgStrength, 0.38);
  }

  // Piksel başına güç: arka planda bgStrength, kişide strength.
  const skinW = new Float32Array(N);
  const wMap = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    skinW[i] = P[CLASSES.faceSkin][i] + P[CLASSES.bodySkin][i];
    const person = 1 - P[CLASSES.background][i];
    wMap[i] = bgStrength + person * (strength - bgStrength);
  }

  // Cilt varsa yalnız ciltten ölçülür — koyu/gri arka planlı renkli kare
  // (ör. siyah duvar önünde portre) aksi hâlde siyah-beyaz sanılıyordu.
  let chroma = 0, chromaN = 0, skinChroma = 0, skinN = 0;
  for (let i = 0; i < N; i += 7) {
    const [, a, b] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const c = Math.hypot(a, b);
    chroma += c; chromaN++;
    if (skinW[i] > 0.5) { skinChroma += c; skinN++; }
  }
  const grayscale = skinN >= 200
    ? skinChroma / skinN < GRAYSCALE_CHROMA
    : chroma / chromaN < GRAYSCALE_CHROMA;
  const colorK = grayscale ? 0 : 1;

  const tDL = tabulate(DL_CURVE), tDA = tabulate(DA_CURVE), tDB = tabulate(DB_CURVE);
  const tSL = tabulate(SKIN_DL_EXTRA), tSB = tabulate(SKIN_DB_EXTRA);
  const out = Buffer.alloc(N * 3);
  let skinSum = 0;
  for (let i = 0; i < N; i++) {
    const [L, a, b] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const k = Math.max(0, Math.min(400, Math.round(L * 4)));
    const s = Math.min(1, skinW[i]);
    skinSum += s;
    const w = wMap[i];
    const dL = tDL[k] + s * tSL[k];
    const da = colorK * (tDA[k] + s * SKIN_DA_EXTRA);
    const db = colorK * (tDB[k] + s * tSB[k]);
    const o = labToRgb(Math.min(100, L + w * dL), a + w * da, b + w * db);
    out[i * 3] = o[0]; out[i * 3 + 1] = o[1]; out[i * 3 + 2] = o[2];
  }

  // Keskinleştirme kapalı: faceDetail zaten yüzü netleştiriyor; ikinci unsharp
  // yüz kenarında çizgi bırakıyordu (b2a9537d c7).
  const res = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf: res, applied: true, bgL, gate, grayscale, skinShare: skinSum / N };
}

/** Arka plan L'sine göre güç çarpanı (0..1). */
function bgGate(bgL) {
  return Math.max(0, Math.min(1, (BG_BRIGHT_L - bgL) / (BG_BRIGHT_L - BG_DARK_L)));
}

module.exports = {
  applyGlowFilter,
  _testables: { curveAt, rgbToLab, labToRgb, bgGate, DL_CURVE, DEFAULT_STRENGTH, DEFAULT_BG_STRENGTH, BG_DARK_L, BG_BRIGHT_L },
};
