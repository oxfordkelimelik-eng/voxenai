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
// YÜZE DUYARLI (2026-11-13, ölçüm 79956cb2): kişi gücü arka plandan büyük olduğu için yüz
// çevresinden fazla açılıyordu — yüz − çevre L: c5 +18→+37, c7 +16→+38, c8 +3→+14, c9
// +18→+28 ("flaşla çekilmiş, yapıştırılmış yüz"). Kafa (yüz derisi + saç) ve boyuna verilen
// açma, yüz çevresindeki arka plan halkasının aldığı ortalama açmayı FACE_CAP.MARGIN'den
// fazla geçemez; sahne ve vücut eğriyi aynen alır, ışıklı görünüm sürer.
const FACE_CAP = { ON: true, MARGIN: 2, RING_IN: 0.85, RING_OUT: 1.6, NECK_FH: 1.0 };
// ŞABLON YÜZÜ TAVANI (2026-11-14, 43c2e739 c9: ton adımı yüzü şablona eşitledi 56.1/55.5, ışıklı
// +4.9 ekledi → teslim +8.9 L; arka plan medyanı koyu koltuk/ceketten 17, yüzün arkası gri duvar).
// Çağıran şablon yüz L'si + TPL_MARGIN − şimdiki yüz L'sini (faceTone ölçüsü) verirse yüz bundan fazla
// açılmaz; arka plan ve vücut aynı kalır. Yüz şablondan koyuysa (c6 −8) eski sınır geçerli.
const TPL_FACE_CAP = { ON: true, MARGIN: 3 };

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
async function applyGlowFilter(buf, { strength = DEFAULT_STRENGTH, bgStrength = DEFAULT_BG_STRENGTH, faceHeadroom = null } = {}) {
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
  const cap = FACE_CAP.ON ? faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL, faceHeadroom) : null;
  const out = Buffer.alloc(N * 3);
  let skinSum = 0;
  for (let i = 0; i < N; i++) {
    const [L, a, b] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const k = Math.max(0, Math.min(400, Math.round(L * 4)));
    const s = Math.min(1, skinW[i]);
    skinSum += s;
    const w = wMap[i];
    let dL = tDL[k] + s * tSL[k];
    if (cap && cap.c[i] > 0) {
      const lim = cap.limit / Math.max(w, 1e-3);
      if (dL > lim) dL = dL - cap.c[i] * (dL - lim);
    }
    const da = colorK * (tDA[k] + s * SKIN_DA_EXTRA);
    const db = colorK * (tDB[k] + s * tSB[k]);
    const o = labToRgb(Math.min(100, L + w * dL), a + w * da, b + w * db);
    out[i * 3] = o[0]; out[i * 3 + 1] = o[1]; out[i * 3 + 2] = o[2];
  }

  // Keskinleştirme kapalı: faceDetail zaten yüzü netleştiriyor; ikinci unsharp
  // yüz kenarında çizgi bırakıyordu (b2a9537d c7).
  const res = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf: res, applied: true, bgL, gate, grayscale, skinShare: skinSum / N, faceCap: cap ? { ringLift: cap.ringLift, limit: cap.limit, n: cap.n, tplCapped: !!cap.tplCapped, headroom: faceHeadroom } : null };
}

/**
 * Yüze duyarlı sınır: kafa+boyun ağırlığı c (0..1) ve yüze verilebilecek en çok açma (L).
 * Yüz kutusu yüz derisi olasılığının yüzdeliklerinden; halka arka plan pikselleri. Yüz ya da
 * halka yoksa null (eski davranış).
 */
function faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL, faceHeadroom = null) {
  const xs = [], ys = [];
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (P[CLASSES.faceSkin][y * W + x] > 0.6) { xs.push(x); ys.push(y); }
  if (xs.length < 60) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const x0 = q(xs, 0.03), x1 = q(xs, 0.97), y0 = q(ys, 0.03), y1 = q(ys, 0.97);
  const fw = Math.max(8, x1 - x0), fh = Math.max(8, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let lift = 0, n = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const d = Math.hypot((x - cx) / fw, (y - cy) / fh);
      if (d < FACE_CAP.RING_IN || d > FACE_CAP.RING_OUT) continue;
      const i = y * W + x;
      if (P[CLASSES.background][i] <= 0.55) continue;
      const L = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])[0];
      lift += wMap[i] * tDL[Math.max(0, Math.min(400, Math.round(L * 4)))]; n++;
    }
  }
  if (n < 40) return null;
  const ringLift = lift / n;
  const c = new Float32Array(W * H);
  const neckY1 = y1 + FACE_CAP.NECK_FH * fh;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Kafa: yüz derisi + saç, yüz kutusunun 1.4 katı içinde (vücuttaki saç benzeri pikseller hariç).
      const inHead = Math.abs(x - cx) <= 0.7 * fw * 1.4 && y >= y0 - 0.9 * fh && y <= y1 + 0.15 * fh;
      let v = inHead ? Math.min(1, P[CLASSES.faceSkin][i] + P[CLASSES.hair][i]) : 0;
      // Boyun: yüzün altında vücut derisi, aşağı doğru sönerek (yüz/boyun basamağı olmasın).
      if (y > y1 && y < neckY1 && Math.abs(x - cx) <= fw) v = Math.max(v, P[CLASSES.bodySkin][i] * (1 - (y - y1) / (neckY1 - y1)));
      c[i] = v;
    }
  }
  let limit = ringLift + FACE_CAP.MARGIN;
  const tplCapped = TPL_FACE_CAP.ON && Number.isFinite(faceHeadroom) && Math.max(0, faceHeadroom) < limit;
  if (tplCapped) limit = Math.max(0, faceHeadroom);
  return { c, ringLift, limit, n, tplCapped };
}

/** Arka plan L'sine göre güç çarpanı (0..1). */
function bgGate(bgL) {
  return Math.max(0, Math.min(1, (BG_BRIGHT_L - bgL) / (BG_BRIGHT_L - BG_DARK_L)));
}

module.exports = {
  applyGlowFilter,
  _testables: { FACE_CAP, TPL_FACE_CAP, faceCapOf, curveAt, rgbToLab, labToRgb, bgGate, DL_CURVE, DEFAULT_STRENGTH, DEFAULT_BG_STRENGTH, BG_DARK_L, BG_BRIGHT_L },
};
