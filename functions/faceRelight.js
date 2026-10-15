// YÜZ IŞIĞI VE TENİ — TEK ADIM (2026-10-16, kullanıcı: "yüze base'deki gibi
// doğal bir ışık yansıyacak; kol, boyun ten rengi ile yüz rengi tam uyuşacak").
//
// NEDEN: c29a2b31'de (canlıda ilk iş) üç ayrı katman yüzü düzeltemedi:
// - faceShading (9 sayılık küresel harmonik) tek geçişte farkın ~%10'unu
//   kapattı (c7 mum ışığı 0.47 → 0.43); c5/c6'da yan ışık hiç görünmedi.
// - matchFaceExposure yüzün renk açısını BAŞKA bir kişinin (base manken)
//   yüzüne döndürüyordu; c4'te yüz soluk-sarı, boyun sıcak ten kaldı.
// - Kanonik alın saça taştığı için c7'de alında keskin sınırlı düz yama.
//
// YÖNTEM: 68 nokta + kanonik alın/yanak noktalarıyla iki yüz üçgen üçgen
// eşlenir (parça parça afin). Base yüzünün düşük frekanslı log-parlaklık
// DESENİ (ortalaması çıkarılmış) çıktının deseninin yerine konur — burun
// gölgesi, alttan mum ışığı, yan ışık kendi yerine düşer. Desen yalnız iki
// yüzde de deri olan piksellerden (göz, kaş, ağız, sakal bölgesi dışarıda,
// parlama kırpılmış) normalize evrişimle öğrenilir; kişinin ayrıntısı (ben,
// gözlük camı, parlama) geçmez, ince doku çıktının kendisi kalır.
// Yüzün ORTALAMA parlaklığı ve rengi ise kişinin KENDİ boynuna bağlanır:
// base'de yüz/boyun parlaklık oranı neyse çıktıda da o; renk boynun rengine
// (base'deki yüz-boyun renk farkının yarısı eklenerek) çekilir.
//
// 2026-10-08'deki serbest harita hatası (gözlük camı alında turuncu leke)
// burada üç yolla önlenir: gözlüklü şablon atlanır, desen iki yüzün ortak
// deri bölgesinden ve geniş alçak geçirgenle gelir, kazanç sınırlıdır.

const sharp = require("sharp");
const { _testables: SH } = require("./faceShading");

const { canonVerts, triangles, fitPose } = SH;

// Çalışma çözünürlüğü: yüz genişliği (≈2.3 göz arası) bu kadar piksel.
const WORK_FACE_PX = 256;
// Desen alçak geçirgeni (yüz genişliği cinsinden). Burun yanı gölgesi
// ~0.1 genişlik; daha geniş olursa yapı kaybolur, daha dar olursa kişinin
// ayrıntısı geçer.
const LP_SIGMA = 0.045;
// Kazanç sınırları (log). Desen ve ortalama ayrı sınırlanır.
const PATTERN_MIN = Math.log(0.5);
const PATTERN_MAX = Math.log(1.7);
// Ortalama kayması: 0.6'ya kadar karartma yüzü gri gösterdi (cbdbef13 13/20).
const LEVEL_MIN = Math.log(0.7);
const LEVEL_MAX = Math.log(1.3);
// Deri olasılığı eşiği, en az piksel, profil sınırı, kenar yumuşatması.
const SKIN_P = 0.5;
// Yanak/alın bölgesinin en az bu payı deri görünmüyorsa segmentasyon yok sayılır.
const SKIN_USABLE_SHARE = 0.15;
const MIN_PX = 400;
const MAX_YAW = 0.8;
const PROFILE_STRENGTH = 0.7;
const EDGE_SIGMA = 0.035;
const EYEWEAR_RATIO_MAX = 0.55;
// Boyun ölçümü: tam karede 512 ızgara, sınıf olasılığı, en az piksel.
const SEG = 512;
const CLASS_P = 0.6;
const NECK_MIN_PX = 250;
// Şablonda boyun görünmüyorsa yüz/boyun oranı (cbdbef13 + c29a2b31 base
// medyanı, bkz. scripts yerel ölçüm 2026-10-16).
const DEFAULT_TPL_FACE_NECK = 1.1;
// Base yüz/boyun oranı bu aralığın dışındaysa ölçü güvenilmez (ölçülen
// 0.25-2.4; uçlar beyaz gömlek ya da gölgede boyun).
const TPL_RATIO_MIN = 0.55;
const TPL_RATIO_MAX = 2.5;
// Renk: ton açısı en çok bu kadar döner; doygunluk bu aralıkta ölçeklenir;
// base'deki yüz/boyun renk ilişkisinin payı.
const HUE_MAX = 5;
const CHROMA_MIN = 0.8;
const CHROMA_MAX = 1.3;
const TPL_SHARE = 0.5;
// Boyun ölçüsü gürültülü (yaka, sakal, gölge): ton düzeltmesinin bu kadarı
// uygulanır — yanlış ölçümde zarar küçük, doğru ölçümde fark yine kapanır.
const TONE_SHARE = 0.7;
// Boyun penceresinin üstü: çenenin bu kadar (yüz boyu) altından başlar.
const NECK_TOP = 0.2;
// Boyun en az yüz derisi pikselinin bu payı kadar görünmeli; daha karanlık
// (Lab L) "boyun" pikseli sayılmaz.
const NECK_FACE_SHARE = 0.25;
const NECK_MIN_L = 12;
// Boyun base'inkiyle aynı, yüz çok farklıysa model vücudu hiç değiştirmemiştir
// (base mankenin teni kalmış) — yüz ona bağlanmaz.
const BODY_UNCHANGED_DE = 5;
const FACE_DIFFERENT_DE = 12;
// Base saç gölgesi: saç olasılığının bu yarıçapta (yüz genişliği) ortalaması
// eşiği aşan üst yüz pikseli öğrenilmez. Boşluklar bu yarıçapla doldurulur.
const HAIR_SHADOW_SIGMA = 0.05;
const HAIR_SHADOW_P = 0.2;
const FILL_SIGMA = 0.08;
// Bu kadar küçük değişiklik uygulanmaz.
const APPLY_MIN = 0.03;

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const linToSrgb8 = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
};
const lumLin = (r, g, b) => 0.2126 * SRGB2LIN[r] + 0.7152 * SRGB2LIN[g] + 0.0722 * SRGB2LIN[b];

const rot = (R, v) => [0, 1, 2].map((r) => R[r][0] * v[0] + R[r][1] * v[1] + R[r][2] * v[2]);

/** 68 nokta + kanonik yardımcı noktaların görüntüdeki yeri ve derinliği. */
function projectVerts(pts) {
  const V = canonVerts();
  const pose = fitPose(pts, V.slice(0, 68));
  if (!pose) return null;
  const { s, R, t } = pose;
  return V.map((v, i) => {
    const r = rot(R, v);
    return i < 68 ? { x: pts[i].x, y: pts[i].y, z: s * r[2] } : { x: s * r[0] + t[0], y: s * r[1] + t[1], z: s * r[2] };
  });
}

/** Ayrılabilir Gauss bulanıklığı (Float32, kenar kıstırma). SAF. */
function gauss(src, w, h, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * src[y * w + Math.min(w - 1, Math.max(0, x + j))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

/** Ağırlıklı alçak geçirgen (normalize evrişim). SAF. */
function weightedLowpass(val, wt, w, h, sigma) {
  const num = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) num[i] = val[i] * wt[i];
  const a = gauss(num, w, h, sigma), b = gauss(wt, w, h, sigma);
  const out = new Float32Array(w * h), cov = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { out[i] = b[i] > 1e-4 ? a[i] / b[i] : 0; cov[i] = b[i]; }
  return { lp: out, cov };
}

function bilinear(arr, w, h, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, x - x0)), ay = Math.max(0, Math.min(1, y - y0));
  return (arr[y0 * w + x0] * (1 - ax) + arr[y0 * w + x1] * ax) * (1 - ay) + (arr[y1 * w + x0] * (1 - ax) + arr[y1 * w + x1] * ax) * ay;
}

/**
 * Desen öğrenme ağırlığı, kanonik koordinatta: göz, kaş ve ağız dışarıda;
 * sakal/bıyık bölgesi zayıf (base mankenin sakalı "gölge" diye taşınmasın,
 * çene ışığı çevresindeki yanaktan gelsin). SAF.
 */
function regionWeight(cx, cy) {
  if (((Math.abs(cx) - 0.5) / 0.32) ** 2 + (cy / 0.19) ** 2 < 1) return 0; // göz
  if (cy > -0.55 && cy < -0.18 && Math.abs(cx) > 0.12 && Math.abs(cx) < 1.02) return 0; // kaş
  if (Math.abs(cx) < 0.42 && cy > 0.88 && cy < 1.2) return 0; // ağız
  if (Math.abs(cx) < 0.5 && cy > 0.7 && cy <= 0.88) return 0.15; // bıyık
  if (cy > 1.2 || (cy > 0.95 && Math.abs(cx) < 0.8)) return 0.15; // çene/sakal
  return 1;
}

/** Yüzü çalışma penceresine kırpar: pencere, ölçek, RGB, doğrusal Y, deri olasılığı. */
async function workCrop(rgb, W, H, P) {
  const eyeD = Math.hypot((P[42].x + P[45].x - P[36].x - P[39].x) / 2, (P[42].y + P[45].y - P[36].y - P[39].y) / 2);
  const faceW = eyeD * 2.3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // Kulaklar da pencerede olsun (ton kayması onlara da uygulanır).
  const pad = faceW * 0.3;
  const L0 = Math.max(0, Math.floor(x0 - pad)), T0 = Math.max(0, Math.floor(y0 - pad));
  const R0 = Math.min(W, Math.ceil(x1 + pad)), B0 = Math.min(H, Math.ceil(y1 + pad));
  if (R0 - L0 < 8 || B0 - T0 < 8) return null;
  const k = WORK_FACE_PX / faceW;
  const w = Math.max(8, Math.round((R0 - L0) * k)), h = Math.max(8, Math.round((B0 - T0) * k));
  const crop = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: L0, top: T0, width: R0 - L0, height: B0 - T0 }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = lumLin(crop[i * 3], crop[i * 3 + 1], crop[i * 3 + 2]);
  let skin = null, hair = null, body = null;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const pr = await classProbs(crop, w, h);
    skin = pr[CLASSES.faceSkin];
    hair = pr[CLASSES.hair];
    body = pr[CLASSES.bodySkin];
  } catch (e) {
    skin = null;
  }
  // Pencere ölçeği sx/sy ayrı (yuvarlama), görüntü→pencere: (X-L0)*sx.
  return { L0, T0, R0, B0, w, h, sx: w / (R0 - L0), sy: h / (B0 - T0), crop, Y, skin, hair, body, faceW: faceW * k };
}

/**
 * Çıktı penceresinin her pikseli için: geçerli mi (iki yüzde de görünen bir
 * üçgende), şablon penceresindeki karşılığı ve kanonik koordinatı.
 */
function correspond(vo, vt, cO, cT) {
  const V = canonVerts();
  const T = triangles();
  const { w, h } = cO;
  const valid = new Uint8Array(w * h);
  const TX = new Float32Array(w * h), TY = new Float32Array(w * h), CX = new Float32Array(w * h), CY = new Float32Array(w * h);
  const Z = new Float32Array(w * h).fill(Infinity);
  const qo = vo.map((p) => ({ x: (p.x - cO.L0) * cO.sx - 0.5, y: (p.y - cO.T0) * cO.sy - 0.5, z: p.z }));
  const qt = vt.map((p) => ({ x: (p.x - cT.L0) * cT.sx - 0.5, y: (p.y - cT.T0) * cT.sy - 0.5 }));
  const facing = (q, a, b, c) => (q[b].x - q[a].x) * (q[c].y - q[a].y) - (q[b].y - q[a].y) * (q[c].x - q[a].x);
  for (const [a, b, c] of T) {
    const canon = (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) - (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
    const areaO = facing(qo, a, b, c), areaT = facing(qt, a, b, c);
    if (Math.abs(areaO) < 1e-6 || (canon > 0) !== (areaO > 0) || (canon > 0) !== (areaT > 0)) continue;
    const A = qo[a], B = qo[b], C = qo[c];
    const bx0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), bx1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
    const by0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), by1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const w0 = ((B.x - x) * (C.y - y) - (B.y - y) * (C.x - x)) / areaO;
        const w1 = ((C.x - x) * (A.y - y) - (C.y - y) * (A.x - x)) / areaO;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const i = y * w + x;
        const z = w0 * A.z + w1 * B.z + w2 * C.z;
        if (z >= Z[i]) continue;
        Z[i] = z;
        valid[i] = 1;
        TX[i] = w0 * qt[a].x + w1 * qt[b].x + w2 * qt[c].x;
        TY[i] = w0 * qt[a].y + w1 * qt[b].y + w2 * qt[c].y;
        CX[i] = w0 * V[a][0] + w1 * V[b][0] + w2 * V[c][0];
        CY[i] = w0 * V[a][1] + w1 * V[b][1] + w2 * V[c][1];
      }
    }
  }
  return { valid, TX, TY, CX, CY };
}

/** Şablon gözlüğü: göz bölgesi yanak derisinden belirgin koyuysa. */
function eyewearRatio(map, cT) {
  let es = 0, en = 0, fs = 0, fn = 0;
  for (let i = 0; i < map.valid.length; i++) {
    if (!map.valid[i]) continue;
    const ex = Math.abs(map.CX[i]) - 0.5, ey = map.CY[i];
    const v = bilinear(cT.Y, cT.w, cT.h, map.TX[i], map.TY[i]);
    if ((ex / 0.32) ** 2 + (ey / 0.2) ** 2 < 1) { es += v; en++; } else if (regionWeight(map.CX[i], map.CY[i]) === 1) { fs += v; fn++; }
  }
  return en && fn ? Math.cbrt((es / en) / Math.max(1e-4, fs / fn)) : 1;
}

/**
 * Yüz derisi ve boyun derisi ortancaları (Lab + doğrusal Y). Segmentasyon
 * yüz+boyun kesitinde çalışır: tam karede küçük yüzü "vücut derisi" sayıyordu
 * (c29a2b31 c2/c5, cbdbef13 03/08/20). Boyun: çenenin altında, yüz genişliğinin
 * biraz dışına kadar. El/kol kullanılmaz — model şablonun ellerine çoğu zaman
 * dokunmuyor (bkz. hand-tone). Ten rengi olmayan "deri" (beyaz gömlek, koyu
 * kumaş: c3, 27) renk süzgeciyle elenir.
 */
async function faceNeckStats(rgb, W, H, P) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { rgbToLab } = require("./skinTone");
  const jaw = P.slice(0, 17);
  const jx0 = Math.min(...jaw.map((p) => p.x)), jx1 = Math.max(...jaw.map((p) => p.x));
  const chin = P[8].y, brow = Math.min(...P.slice(17, 27).map((p) => p.y));
  const fh = Math.max(1, chin - brow), fw = Math.max(1, jx1 - jx0);
  const L0 = Math.max(0, Math.floor(jx0 - 0.8 * fw)), R0 = Math.min(W, Math.ceil(jx1 + 0.8 * fw));
  const T0 = Math.max(0, Math.floor(brow - 0.7 * fh)), B0 = Math.min(H, Math.ceil(chin + 1.6 * fh));
  if (R0 - L0 < 8 || B0 - T0 < 8) return { face: { n: 0 }, neck: { n: 0 } };
  const k = Math.min(1, SEG / Math.max(R0 - L0, B0 - T0));
  const w = Math.max(8, Math.round((R0 - L0) * k)), h = Math.max(8, Math.round((B0 - T0) * k));
  const raw = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: L0, top: T0, width: R0 - L0, height: B0 - T0 }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const pr = await classProbs(raw, w, h);
  const face = [], neck = [];
  let gray = 0, tot = 0;
  // Yüz: yanak/alın/burun bandı (kaş altı → burun altı). Sakal yüzün
  // ortancasını düşürüyordu (cbdbef13 13: sakallı base, yüz %40 karardı).
  const fy0 = brow + 0.15 * fh, fy1 = P[33].y, fx0 = P[2].x, fx1 = P[14].x;
  // Boyun: çenenin altı, çene genişliğinde (el ve bardak yan tarafta
  // kalıyordu — cbdbef13 14). Çenenin hemen altı atlanır: sakal boyna iniyor
  // ve çene gölgesi var, boyun koyu ölçülüp yüz karartılıyordu (cbdbef13 20).
  const nx0 = Math.min(P[5].x, P[11].x) - 0.1 * fw, nx1 = Math.max(P[5].x, P[11].x) + 0.1 * fw;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const X = L0 + (x + 0.5) / k, Yp = T0 + (y + 0.5) / k;
      const isFace = pr[CLASSES.faceSkin][i] > CLASS_P && X >= Math.min(fx0, fx1) && X <= Math.max(fx0, fx1) && Yp >= fy0 && Yp <= fy1;
      const isNeck = !isFace && pr[CLASSES.bodySkin][i] > CLASS_P && X >= nx0 && X <= nx1 && Yp >= chin + NECK_TOP * fh && Yp <= chin + 1.2 * fh;
      if (!isFace && !isNeck) continue;
      const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
      const lab = rgbToLab(r, g, b);
      const c = Math.hypot(lab[1], lab[2]);
      tot++;
      if (c < 3) gray++;
      const s = { Y: lumLin(r, g, b), lab, c, hue: (Math.atan2(lab[2], lab[1]) * 180) / Math.PI };
      (isFace ? face : neck).push(s);
    }
  }
  // Siyah-beyaz karede renk süzgeci uygulanmaz.
  const bw = tot > 0 && gray / tot > 0.8;
  const skinLike = (s) => bw || (s.c >= 6 && s.hue >= 15 && s.hue <= 95 && s.lab[0] > 4 && s.lab[0] < 92);
  const med = (arr, f) => { const v = arr.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const fin = (arr, minPx) => {
    const a = arr.filter(skinLike);
    if (a.length < minPx) return { n: a.length };
    return { n: a.length, Y: med(a, (s) => s.Y), lab: [0, 1, 2].map((c) => med(a, (s) => s.lab[c])) };
  };
  const minPx = Math.max(30, Math.round(NECK_MIN_PX * (w * h) / (SEG * SEG)));
  const fc = fin(face, minPx);
  // Boyun yüzün en az NECK_FACE_SHARE'i kadar görünmeli ve karanlıkta
  // kaybolmamalı: yaka arasındaki ince şerit ya da gölgedeki kazak "boyun"
  // ölçülüp yüzü karartıyor/griliyordu (cbdbef13 13/20/27, c29a2b31 c7/c8:
  // boyun 250-850 px, yüz 4000-9000 px; iyi ölçülen c4/c5: 5500-9400 px).
  const nk = fin(neck.filter((s) => s.lab[0] >= NECK_MIN_L), Math.max(minPx, Math.round(NECK_FACE_SHARE * (fc.n || 0))));
  return { face: fc.Y != null ? fc : { n: 0 }, neck: nk.Y != null ? nk : { n: 0, seen: nk.n }, bw };
}

const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Yüzün ortalama parlaklık (log) ve renk (Lab a*b*) kayması — kişinin kendi
 * boynuna göre. SAF (ölçülerden karar).
 */
function tonePlan(so, st, { grayscale = false } = {}) {
  const none = { level: 0, hueShift: 0, chromaGain: 1 };
  if (!so.face.n || !so.neck.n) return { ...none, reason: "no-neck" };
  // Boyun base'inkiyle aynı VE yüzün açıklığı base yüzünden çok farklıysa
  // (başka ten) boyun base mankenin derisidir. Yalnız renk farkı yetmez:
  // selfie ışığı yüzü zaten farklı renkte çiziyor (c29a2b31 c5).
  if (st.neck.n && st.face.n && dE(so.neck.lab, st.neck.lab) < BODY_UNCHANGED_DE &&
      Math.abs(so.face.lab[0] - st.face.lab[0]) > FACE_DIFFERENT_DE && Math.abs(so.neck.lab[0] - so.face.lab[0]) > FACE_DIFFERENT_DE) {
    return { ...none, reason: "body-unchanged" };
  }
  // Base'in boyun ölçüsü: boyun yüzden çok AÇIKSA (oran < 0.55) ölçülen şey
  // çoğu zaman beyaz gömlek (c29a2b31 c3 0.25) — tipik oran alınır. Boyun
  // gölgedeyse oran büyük çıkar ve bu gerçek ışıktır (c7 mum: 2.18), yalnız
  // kıstırılır.
  // Base ölçüsü yoksa parlaklığa dokunulmaz: tipik oran sert üst ışıkta
  // (boyun gölgede) yüzü yanlışlıkla karartıyordu (c29a2b31 c3).
  const rTraw = st.neck.n && st.face.n ? st.face.Y / st.neck.Y : null;
  const tplOk = rTraw != null && rTraw >= TPL_RATIO_MIN;
  const rT = tplOk ? Math.min(TPL_RATIO_MAX, rTraw) : DEFAULT_TPL_FACE_NECK;
  const rO = so.face.Y / so.neck.Y;
  const level = tplOk ? Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, TONE_SHARE * (Math.log(rT) - Math.log(rO)))) : 0;
  // Renk: TON AÇISI boyuna doğru döner (sınırlı), DOYGUNLUK boyunla ölçeklenir.
  // Toplamalı a*b* kayması yüzü griye/pembeye itiyordu (cbdbef13 27/13).
  // c29a2b31 c4'te yüz ile boyun aynı açıdaydı (54°/53°), fark doygunluktu
  // (24/32). Doğrusal kazanç g kromayı g^(1/3) ölçekler; hedef ona göre.
  let hueShift = 0, chromaGain = 1;
  if (!grayscale) {
    const hue = (l) => (Math.atan2(l[2], l[1]) * 180) / Math.PI;
    const chroma = (l) => Math.hypot(l[1], l[2]);
    const share = tplOk ? TPL_SHARE : 0;
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    const hT = hue(so.neck.lab) + (tplOk ? share * wrap(hue(st.face.lab) - hue(st.neck.lab)) : 0);
    hueShift = Math.max(-HUE_MAX, Math.min(HUE_MAX, TONE_SHARE * wrap(hT - hue(so.face.lab))));
    const cRelT = tplOk ? (chroma(st.face.lab) / Math.max(1, chroma(st.neck.lab))) ** share : 1;
    const cTarget = chroma(so.neck.lab) * Math.cbrt(tplOk ? rT : rO) * cRelT;
    const cAfterLevel = chroma(so.face.lab) * Math.cbrt(Math.exp(level));
    chromaGain = Math.max(CHROMA_MIN, Math.min(CHROMA_MAX, (cTarget / Math.max(1, cAfterLevel)) ** TONE_SHARE));
  }
  return { level, hueShift, chromaGain, reason: null, rT, rO, tplOk };
}

/** Yüz noktaları hazırken çekirdek (yerel testler de bunu çağırır). */
async function relightCore(oRgb, tRgb, W, H, ptsO, ptsT, { strength = 1, tone = true, pattern: patternOpt = true } = {}) {
  let pattern = patternOpt;
  const vo = projectVerts(ptsO), vt = projectVerts(ptsT);
  if (!vo || !vt) return { buf: null, applied: false, reason: "no-geometry" };
  const [cO, cT] = await Promise.all([workCrop(oRgb, W, H, vo), workCrop(tRgb, W, H, vt)]);
  if (!cO || !cT) return { buf: null, applied: false, reason: "no-geometry" };
  const map = correspond(vo, vt, cO, cT);
  const { w, h } = cO;
  const ew = eyewearRatio(map, cT);
  if (ew < EYEWEAR_RATIO_MAX) pattern = false;

  // Base'de saçın gölgesi (c29a2b31 c7: kakül alına düşüyor) ışık değil,
  // o kişinin saçı — saçın yakınındaki üst yüz derisi öğrenmeye girmez.
  let hairNear = null;
  if (cT.hair) {
    const ht = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (map.valid[i]) ht[i] = bilinear(cT.hair, cT.w, cT.h, map.TX[i], map.TY[i]);
    hairNear = gauss(ht, w, h, HAIR_SHADOW_SIGMA * cO.faceW);
  }
  // Segmentasyon yüz bölgesinde deri bulamıyorsa (siyah-beyaz, çok karanlık)
  // o harita kullanılmaz, bölge kuralı kalır (faceShading'deki gibi).
  const skinUsable = (getP) => {
    let n = 0, s = 0;
    for (let i = 0; i < w * h; i++) if (map.valid[i] && regionWeight(map.CX[i], map.CY[i]) === 1) { n++; if (getP(i) > SKIN_P) s++; }
    return n > 0 && s / n >= SKIN_USABLE_SHARE;
  };
  const skinO = cO.skin && skinUsable((i) => cO.skin[i]) ? cO.skin : null;
  const skinT = cT.skin && skinUsable((i) => bilinear(cT.skin, cT.w, cT.h, map.TX[i], map.TY[i])) ? cT.skin : null;
  // Desen: iki yüzde de deri olan piksellerin log-parlaklığı.
  const lt = new Float32Array(w * h), lo = new Float32Array(w * h), wt = new Float32Array(w * h);
  const tVals = [];
  for (let i = 0; i < w * h; i++) {
    if (!map.valid[i]) continue;
    const rw = regionWeight(map.CX[i], map.CY[i]);
    if (!rw) continue;
    if (hairNear && skinT && map.CY[i] < 0 && hairNear[i] > HAIR_SHADOW_P) continue;
    const po = skinO ? skinO[i] : 1, pt = skinT ? bilinear(skinT, cT.w, cT.h, map.TX[i], map.TY[i]) : 1;
    if (po < SKIN_P || pt < SKIN_P) continue;
    const yt = bilinear(cT.Y, cT.w, cT.h, map.TX[i], map.TY[i]);
    wt[i] = rw * Math.min(po, pt);
    lt[i] = Math.log(Math.max(1e-4, yt));
    lo[i] = Math.log(Math.max(1e-4, cO.Y[i]));
    tVals.push(lt[i]);
  }
  if (tVals.length < MIN_PX) return { buf: null, applied: false, reason: "no-common-skin", n: tVals.length };
  // Parlama (base'in üst %3'ü) ve neredeyse siyah (gölgede gözlük, saç tutamı) dışarıda.
  tVals.sort((a, b) => a - b);
  const hi = tVals[Math.floor(tVals.length * 0.97)], loCut = tVals[Math.floor(tVals.length * 0.01)];
  for (let i = 0; i < w * h; i++) if (wt[i] && (lt[i] > hi || lt[i] < loCut)) wt[i] = 0;

  const sig = LP_SIGMA * cO.faceW;
  const LT = weightedLowpass(lt, wt, w, h, sig), LO = weightedLowpass(lo, wt, w, h, sig);
  let mt = 0, mo = 0, ws = 0;
  for (let i = 0; i < w * h; i++) if (wt[i]) { mt += wt[i] * LT.lp[i]; mo += wt[i] * LO.lp[i]; ws += wt[i]; }
  mt /= ws; mo /= ws;
  // Desen korelasyonu (teşhis): önce.
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < w * h; i++) {
    if (!wt[i]) continue;
    const a = LT.lp[i] - mt, b = LO.lp[i] - mo;
    sab += wt[i] * a * b; saa += wt[i] * a * a; sbb += wt[i] * b * b;
  }
  const corrBefore = sab / Math.sqrt(saa * sbb || 1);

  // Ton: yüz ↔ kendi boynu.
  let tp = { level: 0, hueShift: 0, chromaGain: 1, reason: "off" };
  let stats = null;
  if (tone) {
    const [so, st] = await Promise.all([faceNeckStats(oRgb, W, H, ptsO), faceNeckStats(tRgb, W, H, ptsT)]);
    tp = tonePlan(so, st, { grayscale: !!st.bw });
    stats = { so, st };
  }

  // Log kazanç alanı: desen farkı (geçerli bölgede) + ortalama kayması.
  const Dp = new Float32Array(w * h), have = new Float32Array(w * h);
  let patAbs = 0, patN = 0;
  for (let i = 0; i < w * h; i++) {
    if (!map.valid[i] || LT.cov[i] < 0.02 || LO.cov[i] < 0.02) continue;
    let d = pattern ? strength * ((LT.lp[i] - mt) - (LO.lp[i] - mo)) : 0;
    d = Math.max(PATTERN_MIN, Math.min(PATTERN_MAX, d));
    Dp[i] = d; have[i] = 1;
    if (wt[i]) { patAbs += Math.abs(d); patN++; }
  }
  const patternMean = patN ? patAbs / patN : 0;
  const levelAbs = Math.abs(tp.level);
  const useColor = Math.abs(tp.hueShift) >= 1 || Math.abs(tp.chromaGain - 1) >= 0.03;
  if (patternMean < APPLY_MIN && levelAbs < APPLY_MIN && !useColor) {
    return { buf: null, applied: false, reason: "similar-light", patternMean, corrBefore, tone: tp };
  }
  // Öğrenilmeyen yerlerde (yüz kenarı, saç gölgeli alın) desen komşulardan.
  const ext = weightedLowpass(Dp, have, w, h, FILL_SIGMA * cO.faceW);
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = have[i] ? Dp[i] : ext.lp[i];
  const Ds = gauss(D, w, h, 0.012 * cO.faceW);

  // Desen maskesi: geçerli yüz bölgesi, içeriden yumuşatılmış (kafa çevresinde
  // hale yok — f9f3b5c0).
  const { insideSoft } = SH;
  const alpha = await insideSoft(map.valid, w, h, EDGE_SIGMA * cO.faceW);
  // Ton maskesi: yüz + kulaklar. Yalnız yüze uygulanınca kulak eski tonda
  // kalıp yüz maske gibi duruyordu (cbdbef13 13/20/27). Yüz bölgesinin biraz
  // dışına taşar ama orada yalnız deriye; çenenin altında söner (boyun ölçünün
  // referansı, dokunulmaz).
  const vf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) vf[i] = map.valid[i];
  const near = gauss(vf, w, h, 0.08 * cO.faceW);
  const skinAll = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) skinAll[i] = Math.min(1, (cO.skin ? cO.skin[i] : 1) + (cO.body ? cO.body[i] : 0));
  const skinSoft = gauss(skinAll, w, h, 0.01 * cO.faceW);
  const chinY = (vo[8].y - cO.T0) * cO.sy, fadeLen = 0.12 * cO.faceW;
  const toneMask = (fx, fy, a) => {
    const fade = fy <= chinY ? 1 : Math.max(0, 1 - (fy - chinY) / fadeLen);
    if (!fade) return { lv: 0, ch: 0 };
    const reg = Math.max(0, Math.min(1, (bilinear(near, w, h, fx, fy) - 0.1) / 0.3));
    const sk = Math.max(0, Math.min(1, (bilinear(skinSoft, w, h, fx, fy) - 0.3) / 0.4));
    // Açıklık: yüzün içinde her şeye (göz, kaş, sakal da aynı ışıkta), dışında
    // yalnız deriye. Renk: yalnız deriye.
    return { lv: fade * Math.max(a, reg * sk), ch: fade * reg * sk };
  };
  const out = Buffer.from(oRgb);
  const { rgbToLab, labToRgb } = require("./skinTone");
  const rad = (tp.hueShift * Math.PI) / 180;
  for (let y = cO.T0; y < cO.B0; y++) {
    for (let x = cO.L0; x < cO.R0; x++) {
      const fx = (x - cO.L0 + 0.5) * cO.sx - 0.5, fy = (y - cO.T0 + 0.5) * cO.sy - 0.5;
      const a = bilinear(alpha, w, h, fx, fy) / 255;
      const tm = toneMask(fx, fy, a);
      if (a <= 0.01 && tm.lv <= 0.01) continue;
      const g = Math.exp(a * bilinear(Ds, w, h, fx, fy) + tm.lv * tp.level);
      const i = y * W + x;
      let r = linToSrgb8(SRGB2LIN[oRgb[i * 3]] * g), gg = linToSrgb8(SRGB2LIN[oRgb[i * 3 + 1]] * g), b = linToSrgb8(SRGB2LIN[oRgb[i * 3 + 2]] * g);
      if (useColor && tm.ch > 0.01) {
        const cx = bilinear(map.CX, w, h, fx, fy), cy = bilinear(map.CY, w, h, fx, fy);
        const eye = a > 0.5 && ((Math.abs(cx) - 0.5) / 0.3) ** 2 + (cy / 0.14) ** 2 < 1;
        if (!eye) {
          const lab = rgbToLab(r, gg, b);
          const k = 1 + tm.ch * (tp.chromaGain - 1), cs = Math.cos(rad * tm.ch), sn = Math.sin(rad * tm.ch);
          [r, gg, b] = labToRgb(lab[0], k * (lab[1] * cs - lab[2] * sn), k * (lab[1] * sn + lab[2] * cs));
        }
      }
      out[i * 3] = r; out[i * 3 + 1] = gg; out[i * 3 + 2] = b;
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return {
    buf, applied: true, reason: null, pattern, eyeRatio: ew, patternMean, corrBefore, n: tVals.length,
    tone: tp, neckO: stats?.so.neck.n ?? null, neckT: stats?.st.neck.n ?? null,
  };
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında (şablon çıktı boyutuna
 * getirilir). Döner: { buf|null, applied, reason, patternMean, tone, ... }
 */
async function relightFace(outputBuf, templateBuf, opts = {}) {
  const { faceLandmarks, headYawOf } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  const lt = (await faceLandmarks(tJpeg)) || (await faceLandmarks(tJpeg, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template" };
  const yo = await headYawOf(outputBuf, 0.1), yt = await headYawOf(tJpeg, 0.1);
  // Profilde eşleme yalnız görünen yarıda — desen azaltılmış güçle (c29a2b31
  // c6: kapalıyken base'in yan ışığı hiç gelmedi, 0.7 güçle bozulma yok).
  // Gözlüklü base'de cam ve gölgesi ışık sanılır (cbdbef13 16: yanakta açık
  // yama) — desen kapalı, ton yine boyuna bağlanır.
  const prof = (yo != null && yo > MAX_YAW) || (yt != null && yt > MAX_YAW);
  const pattern = !opts.templateEyewear && opts.pattern !== false;
  const strength = (opts.strength ?? 1) * (prof ? PROFILE_STRENGTH : 1);
  const r = await relightCore(o.data, t, W, H, lo.pts, lt.pts, { ...opts, pattern, strength });
  return { ...r, profile: prof, yawO: yo, yawT: yt };
}

module.exports = {
  relightFace,
  relightCore,
  _testables: { gauss, weightedLowpass, regionWeight, tonePlan, projectVerts, correspond, faceNeckStats, DEFAULT_TPL_FACE_NECK },
};
