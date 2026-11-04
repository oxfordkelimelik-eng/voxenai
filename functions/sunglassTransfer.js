// GÜNEŞ GÖZLÜĞÜNÜ BASE'DEN TAŞIMA — SADE SÜRÜM (2026-11-03 akşam, 80fc7ec4).
//
// Geçmiş: 11-03 öğlen koyu bölge büyütmesiyle kuruldu (8ee5afa0 c4: AI yolu yan
// dönük base'de tek küçük cam çizmişti). Akşama kadar üstüne cam içi kabuk,
// çerçeve kenarı, sap sezgisi, deri vetosu ve "cam geçirgenliği" eklendi; her
// yeni base başka bir yerden bozdu (kullanıcı: "güneş gözlüklü olan tüm
// fotoğraflar sıkıntılı"; c3 alın şeridi/yanak lekesi, c6/c8 pembe yanak, c9
// turuncu leke, c6 taşan ve yamuk gözlük). Hepsi kaldırıldı.
//
// ŞİMDİKİ KURAL (tek yol, iki kapı):
//  1) Maske = segmentasyonun GÖZLÜK sınıfı. selfie_multiclass YÜZ KIRPIMINDA
//     "others" sınıfıyla camı, çerçeveyi, sapı ayırıyor (tüm karede 256'ya
//     sıkışınca ayırmıyordu). Göz çizgisi şeridindeki, cama bağlı parçalar.
//     Bu sınıfın çerçevesi içine kapanan KOYU pikseller (cam yanlışlıkla deri
//     sayıldıysa, 80f c8) eklenir. Deri renkli piksel hiç alınmaz.
//  2) Kapı A — POZ: baş açısı farkı ≤ MAX_YAW_DIFF ve gözlüğün çıktıdaki
//     kısalma oranı (cos yawÇıktı / cos yawBase) 1 ± MAX_FORESHORTEN. c6: base
//     51°, çıktı 41°, oran 1.19 — 2B dönüşüm uzak camı yüzün dışına koyuyordu.
//  3) Kapı B — KAPSAMA: base'in koyu cam göz diskinin en az MIN_COVER'ı maskede.
//     Segmentasyon camın bir kısmını deri saydıysa (80f c3) taşıma yok.
//  Kapılardan biri tutmazsa taşıma yapılmaz; çağıran AI yoluna (eyewear.js) düşer.
//  4) Eşleme: gözlük düzlemi noktalarından (göz köşe/kapak, kaş, burun kökü) en
//     küçük kareler AFİN (zayıf perspektifte düzlem → düzlem eşlemesi).
//  5) Maske yumuşatılır; deri sınıfındaki base pikseli payı 0. Çıktı
//     siyah-beyazsa taşınan pikseller griye çevrilir. Cam bölgesi dışındaki
//     (sap) pikseller çıktının yüz çizgisinden OUT_EXT ötede kesilir.
const sharp = require("sharp");

// Gözlük düzlemi noktaları: göz köşe/kapakları, kaşlar, burun kökü.
const PLANE_IDX = [33, 133, 159, 145, 362, 263, 386, 374, 70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 168, 6];
const EYE_R = [33, 133, 159, 145], EYE_L = [362, 263, 386, 374];
const BROW = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const SIDE_R = 127, SIDE_L = 356; // göz hizası yüz çizgisi
// Arama kırpımı (poza göre düzeltilmiş göz arası cinsinden).
const SEARCH_RX = 1.7, SEARCH_UP = 0.6, SEARCH_DOWN = 0.75;
// Cam elipsleri (göz merkezine göre).
const LENS_RX = 0.66, LENS_RY = 0.46, LENS_DY = 0.1;
const YAW_COS_MIN = 0.5;
// Koyu cam kanıtı: göz diskinde, deri parlaklığının GROW_L_FRAC'ı altındaki pay.
// 8ee5afa0: koyu cam 0.75-1.00, gözlüksüz base ≤ 0.49.
const DARK_DISC_R = 0.25, GROW_L_FRAC = 0.62, GROW_L_MAX = 42, MIN_DARK_FRAC = 0.7;
// Segmentasyon.
const SEG_PAD = 0.35, SEG_G = 0.5, SEG_S = 0.5;
// Gözlük sınıfı göz çizgisi şeridinde (uçlardan GL_EXT iod uzatılmış, GL_BAND yarı genişlik).
const GL_EXT = 1.7, GL_BAND = 0.55;
// Deri referansı: alın ve burun noktaları ("yüz derisi" sınıfı ortancası sakal/saç içeriyordu).
const SKIN_REF_IDX = [151, 9, 108, 337, 4, 5, 1];
const SKIN_REF_R = 0.06;
// Gözlük sınıfında deri renkli piksel (80f c1 burun köprüsü, c9 cam altı yanak).
const GL_SKIN_DAB = 16, GL_SKIN_LREL = 0.6;
// Kapılar.
const MAX_YAW_DIFF = 10;
const MAX_FORESHORTEN = 0.08;
const MIN_COVER = 0.8;
const MIN_AREA_IOD2 = 0.12;
// Kapı C — GENİŞLİK (2026-11-03 gece, 80f c9 −47°): "koyu ve nötr kalın parça
// tutulur" kuralı (c8 çerçevesi için) c9'da favoriyi, sakalı, kulaklık
// kabını ve cam altındaki gölgeli yanağı da maskeye aldı; başka kişinin
// favorisi kullanıcının yüzüne yapıştı. Cam bölgesi DIŞINDAKİ maske payı
// bundan fazlaysa segmentasyon gözlükten fazlasını almıştır → taşıma yok,
// AI yolu. Ölçüm (7 kare): c9 0.41; diğerleri en çok 0.19 (b932 c9, 80f c3).
const MAX_OUT_ZONE_FRAC = 0.3;
// Kenar ve sap.
const FEATHER_IOD = 0.03;
// Cam bölgesi dışında gözlük sınıfı yalnız İNCE yapı (sap): 80f c3/c8 sınıf sap
// boyunca şakakta kalın bir bant olarak deriye/saça taştı (pembe nokta). Bu
// yarıçaptan kalın (aşınmada kalan) parçalar atılır.
const ARM_THICK_R = 0.08, THICK_NEUTRAL_C = 4;
const OUT_EXT = 0.2, OUT_RAMP = 0.06;
// Çıktı siyah-beyazsa (yüz kroması medyanı bu altı) taşınan piksel gri (80f c9).
const GRAY_FACE_C = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** sRGB → L* (yalnız parlaklık). SAF. */
function lstar(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

/** En küçük kareler afin src → dst: x' = a x + b y + c, y' = d x + e y + f. SAF. */
function affineFit(src, dst) {
  const n = src.length;
  if (n < 3) return null;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    bx[0] += x * u; bx[1] += y * u; bx[2] += u;
    by[0] += x * v; by[1] += y * v; by[2] += v;
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return null;
  const solve = (b) => [0, 1, 2].map((k) => det3(M.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))) / D);
  const [a, b, c] = solve(bx), [d, e, f] = solve(by);
  return { a, b, c, d, e, f };
}
function invertAffine(T) {
  const det = T.a * T.e - T.b * T.d;
  const a = T.e / det, b = -T.b / det, d = -T.d / det, e = T.a / det;
  return { a, b, d, e, c: -(a * T.c + b * T.f), f: -(d * T.c + e * T.f) };
}
const applyAffine = (T, x, y) => [T.a * x + T.b * y + T.c, T.d * x + T.e * y + T.f];

/** Gözlüğün çıktıdaki kısalma oranının 1'den sapması (|cos yO / cos yT − 1|). SAF. */
function foreshortenDiff(yawT, yawO) {
  const c = (d) => Math.max(YAW_COS_MIN, Math.cos((Math.abs(d) * Math.PI) / 180));
  return Math.abs(c(yawO) / c(yawT) - 1);
}

async function meshOf(buf) {
  const T = require("./headPose3d")._testables;
  const m0 = await sharp(buf).metadata();
  const n = await T.normalized(buf, 1600);
  const r = await T.meshPose(n.data, n.W, n.H, { loose: true });
  if (!r || !r.mesh) return null;
  const k = m0.width / n.W;
  return { mesh: r.mesh.map((p) => [p[0] * k, p[1] * k]), yaw: r.pose ? r.pose.yaw : null };
}

const centre = (mesh, idx) => {
  let x = 0, y = 0;
  for (const i of idx) { x += mesh[i][0]; y += mesh[i][1]; }
  return [x / idx.length, y / idx.length];
};

function segDist(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = clamp(((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1), 0, 1);
  return Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy);
}

/** Kutu bulanıklığı (ayrılabilir, r yarıçap). SAF. */
function blur(a, W, H, r) {
  if (r < 1) return a;
  const t = new Float32Array(W * H), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0, n = 0;
    for (let x = -r; x < W; x++) {
      if (x + r < W) { acc += a[y * W + x + r]; n++; }
      if (x - r - 1 >= 0) { acc -= a[y * W + x - r - 1]; n--; }
      if (x >= 0) t[y * W + x] = acc / n;
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y < H; y++) {
      if (y + r < H) { acc += t[(y + r) * W + x]; n++; }
      if (y - r - 1 >= 0) { acc -= t[(y - r - 1) * W + x]; n--; }
      if (y >= 0) o[y * W + x] = acc / n;
    }
  }
  return o;
}

/** Yüz kırpımında skinSeg: G (others = gözlük), S (yüz derisi); base piksel koordinatı. */
async function glassesSeg(buf, W, H, mesh) {
  const { classProbs, CLASSES } = require("./skinSeg");
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of mesh) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const pw = (x1 - x0) * SEG_PAD, ph = (y1 - y0) * SEG_PAD;
  const l = clamp(Math.floor(x0 - pw), 0, W - 1), t = clamp(Math.floor(y0 - ph), 0, H - 1);
  const w = Math.min(W - l, Math.ceil(x1 - x0 + 2 * pw)), h = Math.min(H - t, Math.ceil(y1 - y0 + 2 * ph));
  if (w < 16 || h < 16) return null;
  const crop = await sharp(buf).removeAlpha().extract({ left: l, top: t, width: w, height: h }).raw().toBuffer();
  const P = await classProbs(crop, w, h);
  return { x0: l, y0: t, w, h, G: P[CLASSES.others], S: P[CLASSES.faceSkin] };
}

/**
 * Base gözlük maskesi (base kırpımında). SAF (seg verilir).
 * Döner: { mask, veto, zone, crop, iod, area, darkFrac, cover, skinRef } | { reject, ... } | null
 */
function glassesMask(rgb, W, H, mesh, yawDeg, seg) {
  const { rgbToLab } = require("./skinTone");
  const eR = centre(mesh, EYE_R), eL = centre(mesh, EYE_L);
  const iodImg = Math.hypot(eL[0] - eR[0], eL[1] - eR[1]);
  const cosY = yawDeg != null && Number.isFinite(yawDeg) ? Math.max(YAW_COS_MIN, Math.cos((Math.abs(yawDeg) * Math.PI) / 180)) : 1;
  const iod = iodImg / cosY;
  if (!(iod > 8)) return null;
  const browY = Math.min(...BROW.map((i) => mesh[i][1]));
  const x0 = Math.max(0, Math.floor(Math.min(eR[0], eL[0]) - SEARCH_RX * iod));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(eR[0], eL[0]) + SEARCH_RX * iod));
  const y0 = Math.max(0, Math.floor(Math.min(browY, Math.min(eR[1], eL[1]) - SEARCH_UP * iod)));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(eR[1], eL[1]) + SEARCH_DOWN * iod));
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, N = cw * ch;
  if (cw < 4 || ch < 4) return null;
  const at = (arr, X, Y) => {
    const xx = X - seg.x0, yy = Y - seg.y0;
    return xx < 0 || yy < 0 || xx >= seg.w || yy >= seg.h ? 0 : arr[yy * seg.w + xx];
  };
  // Deri referansı (alın, burun).
  const Ls = [], As = [], Bs = [];
  const rr = Math.max(2, Math.round(SKIN_REF_R * iod));
  for (const idx of SKIN_REF_IDX) {
    const p = mesh[idx];
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy > rr * rr) continue;
      const X = Math.round(p[0]) + dx, Y = Math.round(p[1]) + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      if (at(seg.S, X, Y) <= SEG_S || at(seg.G, X, Y) >= 0.3) continue;
      const i = (Y * W + X) * 3;
      const lab = rgbToLab(rgb[i], rgb[i + 1], rgb[i + 2]);
      Ls.push(lab[0]); As.push(lab[1]); Bs.push(lab[2]);
    }
  }
  if (Ls.length < 20) return { reject: "no-skin-ref" };
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const skinRef = { L: med(Ls), a: med(As), b: med(Bs) };
  const growT = Math.min(GROW_L_MAX, GROW_L_FRAC * skinRef.L);
  // Piksel sınıfları.
  const L = new Float32Array(N), Cr = new Float32Array(N), gl = new Uint8Array(N), veto = new Uint8Array(N), zone = new Float32Array(N);
  const ux = eL[0] - eR[0], uy = eL[1] - eR[1], un = Math.hypot(ux, uy) || 1, dir = [ux / un, uy / un];
  const inLens = (X, Y, e) => {
    const dx = X - e[0], dy = Y - e[1] - LENS_DY * iod;
    const u = dx * dir[0] + dy * dir[1], v = -dx * dir[1] + dy * dir[0];
    return (u / (LENS_RX * iod)) ** 2 + (v / (LENS_RY * iod)) ** 2 <= 1;
  };
  const extR = [eR[0] - dir[0] * GL_EXT * iod, eR[1] - dir[1] * GL_EXT * iod], extL = [eL[0] + dir[0] * GL_EXT * iod, eL[1] + dir[1] * GL_EXT * iod];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const j = y * cw + x, X = x + x0, Y = y + y0, i = (Y * W + X) * 3;
    const lab = rgbToLab(rgb[i], rgb[i + 1], rgb[i + 2]);
    L[j] = lab[0]; Cr[j] = Math.hypot(lab[1], lab[2]);
    if (inLens(X, Y, eR) || inLens(X, Y, eL)) zone[j] = 1;
    const skinCol = Math.hypot(lab[1] - skinRef.a, lab[2] - skinRef.b) <= GL_SKIN_DAB && lab[0] >= GL_SKIN_LREL * skinRef.L;
    if (skinCol || at(seg.S, X, Y) > SEG_S && at(seg.G, X, Y) <= SEG_G) veto[j] = skinCol || L[j] >= growT ? 1 : 0;
    if (at(seg.G, X, Y) > SEG_G && !skinCol && segDist(X, Y, extR, extL) <= GL_BAND * iod) gl[j] = 1;
  }
  // Cam bölgesi dışında kalın gözlük sınıfı parçalarını at (bkz. ARM_THICK_R).
  {
    const r = Math.max(1, Math.round(ARM_THICK_R * iod));
    const out = new Float32Array(N);
    for (let j = 0; j < N; j++) out[j] = gl[j] ? 1 : 0;
    const eroded = blur(out, cw, ch, r).map((v) => (v > 0.999 ? 1 : 0));
    const thick = blur(eroded, cw, ch, r);
    // Koyu ve NÖTR (siyah çerçeve) parça kalın olsa da tutulur: 80f c8 wayfarer
    // asetat sapı yan açıdan geniş (L 2, kroma 1.3) ve atılınca çerçeve kayboldu.
    // 80f c3 şakak lekesi de koyu ama renkli (L 8.5, kroma 6.9: saç/gölge).
    for (let j = 0; j < N; j++) if (gl[j] && !zone[j] && thick[j] > 0.001 && (L[j] >= growT || Cr[j] > THICK_NEUTRAL_C)) gl[j] = 0;
  }
  // Koyu cam kanıtı (göz diskleri).
  const discR = DARK_DISC_R * iod;
  const discs = [eR, eL].map((e) => {
    const px = [];
    for (let Y = Math.floor(e[1] + LENS_DY * iod - discR); Y <= e[1] + LENS_DY * iod + discR; Y++) for (let X = Math.floor(e[0] - discR); X <= e[0] + discR; X++) {
      if (X < x0 || Y < y0 || X > x1 || Y > y1) continue;
      if ((X - e[0]) ** 2 + (Y - e[1] - LENS_DY * iod) ** 2 > discR * discR) continue;
      px.push((Y - y0) * cw + (X - x0));
    }
    const dark = px.filter((j) => L[j] < growT);
    return { px, dark, frac: px.length ? dark.length / px.length : 0 };
  });
  const darkFrac = discs.map((d) => d.frac);
  if (Math.max(...darkFrac) < MIN_DARK_FRAC) return { reject: "not-dark-lens", darkFrac };
  // Maske: cam elipslerindeki gözlük pikselinden, şerit içindeki gözlük pikseline yayılım.
  const mask = new Uint8Array(N);
  const st = [];
  for (let j = 0; j < N; j++) if (gl[j] && zone[j]) { mask[j] = 1; st.push(j); }
  while (st.length) {
    const j = st.pop();
    const x = j % cw, y = (j - x) / cw;
    for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
      const xx = x + ddx, yy = y + ddy;
      if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
      const k = yy * cw + xx;
      if (mask[k] || !gl[k]) continue;
      mask[k] = 1; st.push(k);
    }
  }
  // Çerçeve içine kapanan KOYU pikseller (cam yanlışlıkla deri sayıldıysa).
  const outside = new Uint8Array(N);
  const q = [];
  const seedOut = (j) => { if (!mask[j] && !outside[j]) { outside[j] = 1; q.push(j); } };
  for (let x = 0; x < cw; x++) { seedOut(x); seedOut((ch - 1) * cw + x); }
  for (let y = 0; y < ch; y++) { seedOut(y * cw); seedOut(y * cw + cw - 1); }
  while (q.length) {
    const j = q.pop();
    const x = j % cw, y = (j - x) / cw;
    for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + ddx, yy = y + ddy;
      if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
      const k = yy * cw + xx;
      if (mask[k] || outside[k]) continue;
      outside[k] = 1; q.push(k);
    }
  }
  let holePx = 0;
  for (let j = 0; j < N; j++) if (!mask[j] && !outside[j] && zone[j] && L[j] < growT && !veto[j]) { mask[j] = 1; holePx++; }
  // Kapsama: koyu cam diskinin maskede olan payı.
  const cover = discs.map((d) => (d.frac >= MIN_DARK_FRAC && d.dark.length ? d.dark.filter((j) => mask[j]).length / d.dark.length : null));
  let area = 0, outZone = 0;
  const m = new Float32Array(N);
  for (let j = 0; j < N; j++) if (mask[j]) { m[j] = 1; area++; if (!zone[j]) outZone++; }
  if (area < MIN_AREA_IOD2 * iod * iod) return { reject: "small-mask", darkFrac, cover };
  if (cover.some((c) => c != null && c < MIN_COVER)) return { reject: "seg-partial", darkFrac, cover };
  const outFrac = outZone / area;
  if (outFrac > MAX_OUT_ZONE_FRAC) return { reject: "seg-wide", darkFrac, cover, outFrac };
  return { mask: m, veto, zone, crop: { x0, y0, cw, ch }, iod, area, outFrac, holePx, darkFrac, cover, skinRef };
}

/**
 * Base'in koyu camlı gözlüğünü çıktıya taşır. Döner: { buf, applied, reason, ... }.
 * applied:false ise çağıran AI yoluna (eyewear.js) düşer.
 */
async function transferSunglasses(outBuf, tplBuf) {
  const t0 = Date.now();
  const mo = await sharp(outBuf).metadata();
  const W = mo.width, H = mo.height;
  const tplFit = await sharp(tplBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer();
  const [Mo, Mt] = await Promise.all([meshOf(outBuf), meshOf(tplFit)]);
  if (!Mo) return { buf: null, applied: false, reason: "no-mesh-output" };
  if (!Mt) return { buf: null, applied: false, reason: "no-mesh-template" };
  const yawT = Mt.yaw, yawO = Mo.yaw;
  if (yawT != null && yawO != null) {
    if (Math.abs(yawO - yawT) > MAX_YAW_DIFF) return { buf: null, applied: false, reason: "pose-mismatch", yawT, yawO };
    const fd = foreshortenDiff(yawT, yawO);
    if (fd > MAX_FORESHORTEN) return { buf: null, applied: false, reason: "pose-foreshorten", yawT, yawO, foreshorten: fd };
  }
  let seg = null;
  try {
    seg = await glassesSeg(tplFit, W, H, Mt.mesh);
  } catch (e) {
    console.error("Gözlük taşıma: segmentasyon hata verdi (AI yolu):", e.message || e);
  }
  if (!seg) return { buf: null, applied: false, reason: "no-seg", yawT, yawO };
  const tRgb = await sharp(tplFit).removeAlpha().raw().toBuffer();
  const sm = glassesMask(tRgb, W, H, Mt.mesh, yawT, seg);
  if (!sm) return { buf: null, applied: false, reason: "no-lens", yawT, yawO };
  if (sm.reject) return { buf: null, applied: false, reason: sm.reject, darkFrac: sm.darkFrac, cover: sm.cover, outFrac: sm.outFrac, yawT, yawO };
  const T = affineFit(PLANE_IDX.map((i) => Mt.mesh[i]), PLANE_IDX.map((i) => Mo.mesh[i]));
  if (!T) return { buf: null, applied: false, reason: "no-align", yawT, yawO };
  const scale = Math.sqrt(Math.abs(T.a * T.e - T.b * T.d));
  const { x0, y0, cw, ch } = sm.crop;
  // Yumuşatma; deri sınıfındaki base pikselinin payı 0 (kenarda base derisi taşınmasın).
  const mk = blur(sm.mask, cw, ch, Math.max(1, Math.round(FEATHER_IOD * sm.iod)));
  for (let j = 0; j < mk.length; j++) if (sm.veto[j] && !sm.mask[j]) mk[j] = 0;
  const Ti = invertAffine(T);
  const corners = [[x0, y0], [x0 + cw, y0], [x0, y0 + ch], [x0 + cw, y0 + ch]].map(([x, y]) => applyAffine(T, x, y));
  const ox0 = clamp(Math.floor(Math.min(...corners.map((c) => c[0]))), 0, W - 1), ox1 = clamp(Math.ceil(Math.max(...corners.map((c) => c[0]))), 0, W - 1);
  const oy0 = clamp(Math.floor(Math.min(...corners.map((c) => c[1]))), 0, H - 1), oy1 = clamp(Math.ceil(Math.max(...corners.map((c) => c[1]))), 0, H - 1);
  const oRgb = await sharp(outBuf).removeAlpha().raw().toBuffer();
  const res = Buffer.from(oRgb);
  // Siyah-beyaz çıktı: yüz noktalarında kroma medyanı.
  const { rgbToLab } = require("./skinTone");
  const cs = [];
  for (const idx of [151, 9, 50, 280, 4, 205, 425]) {
    const p = Mo.mesh[idx];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = clamp(Math.round(p[0]) + dx, 0, W - 1), yy = clamp(Math.round(p[1]) + dy, 0, H - 1), i = (yy * W + xx) * 3;
      const lab = rgbToLab(oRgb[i], oRgb[i + 1], oRgb[i + 2]);
      cs.push(Math.hypot(lab[1], lab[2]));
    }
  }
  cs.sort((p, q) => p - q);
  const grayOut = cs[cs.length >> 1] < GRAY_FACE_C;
  const bil = (arr, w, h, fx, fy, c, ch3) => {
    const xa = clamp(Math.floor(fx), 0, w - 1), ya = clamp(Math.floor(fy), 0, h - 1);
    const xb = Math.min(w - 1, xa + 1), yb = Math.min(h - 1, ya + 1), tx = clamp(fx - xa, 0, 1), ty = clamp(fy - ya, 0, 1);
    const g = (x, y) => (ch3 ? arr[(y * w + x) * 3 + c] : arr[y * w + x]);
    return (g(xa, ya) * (1 - tx) + g(xb, ya) * tx) * (1 - ty) + (g(xa, yb) * (1 - tx) + g(xb, yb) * tx) * ty;
  };
  // Sap uçları çıktının yüz çizgisinden OUT_EXT ötede kesilir (cam bölgesi hariç).
  const oR = centre(Mo.mesh, EYE_R), oL = centre(Mo.mesh, EYE_L);
  const oIod = Math.hypot(oL[0] - oR[0], oL[1] - oR[1]) || 1;
  const oDir = [(oL[0] - oR[0]) / oIod, (oL[1] - oR[1]) / oIod];
  const oMid = [(oR[0] + oL[0]) / 2, (oR[1] + oL[1]) / 2];
  const proj = (p) => (p[0] - oMid[0]) * oDir[0] + (p[1] - oMid[1]) * oDir[1];
  const ext = OUT_EXT * sm.iod * scale, ramp = Math.max(1, OUT_RAMP * sm.iod * scale);
  const uMin = proj(Mo.mesh[SIDE_R]) - ext, uMax = proj(Mo.mesh[SIDE_L]) + ext;
  let px = 0;
  for (let y = oy0; y <= oy1; y++) for (let x = ox0; x <= ox1; x++) {
    const [bx, by] = applyAffine(Ti, x, y);
    const mx = bx - x0, my = by - y0;
    if (mx < 0 || my < 0 || mx > cw - 1 || my > ch - 1) continue;
    const zv = bil(sm.zone, cw, ch, mx, my, 0, false);
    const u = proj([x, y]);
    const side = Math.max(zv, clamp(Math.min(u - uMin, uMax - u) / ramp, 0, 1));
    const a = bil(mk, cw, ch, mx, my, 0, false) * side;
    if (a < 0.01) continue;
    const i = (y * W + x) * 3;
    const bR = bil(tRgb, W, H, bx, by, 0, true), bG = bil(tRgb, W, H, bx, by, 1, true), bB = bil(tRgb, W, H, bx, by, 2, true);
    let p = [bR, bG, bB];
    if (grayOut) { const yv = 0.299 * bR + 0.587 * bG + 0.114 * bB; p = [yv, yv, yv]; }
    for (let c = 0; c < 3; c++) res[i + c] = Math.round(a * p[c] + (1 - a) * oRgb[i + c]);
    px++;
  }
  const buf = await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, lensPx: px, lensArea: sm.area, outFrac: sm.outFrac, holePx: sm.holePx, cover: sm.cover, iod: sm.iod, scale, yawT, yawO, foreshorten: yawT != null && yawO != null ? foreshortenDiff(yawT, yawO) : null, grayOut, ms: Date.now() - t0 };
}

module.exports = { transferSunglasses, _testables: { ARM_THICK_R, glassesMask, glassesSeg, affineFit, invertAffine, applyAffine, foreshortenDiff, lstar, MIN_COVER, MAX_FORESHORTEN, MAX_OUT_ZONE_FRAC } };
