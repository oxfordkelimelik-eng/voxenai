// YÜZ IŞIĞI AKTARIMI (2026-10-08, kullanıcı: "taban fotoğrafta yüzdeki ışık
// oranı ile çıktıdaki yüzdeki ışık aynı olmalı").
//
// SORUN (9d9507f0 c4 siyah-beyaz uçak, c9 gün batımı yat): şablonda yüz yandan
// sert ışıkla aydınlanıyor (bir yanak parlak, öbürü gölgede); model yüzü
// selfie'lerdeki gibi düz ve önden aydınlatılmış çiziyor.
//
// ÇÖZÜM — IŞIK EĞİMİ AKTARIMI: yüz noktalarıyla şablon yüzü çıktı yüzüne
// hizalanır. Her iki yüzde, kanal başına ortalamaya bölünmüş yerel parlaklık
// yüz koordinatlarında doğrusal bir düzleme (a + b·u + c·v) oturtulur: ışığın
// hangi yandan geldiği ve ne kadar kontrastlı olduğu. Çıktı yüzü şablon
// düzlemi / çıktı düzlemi oranıyla çarpılır. Ortalama korunur → kullanıcının
// ten rengi değişmez; doku ve kimlik (yüksek frekans) dokunulmaz.
//
// NEDEN DÜZLEM, NEDEN SERBEST HARİTA DEĞİL: serbest gölgeleme haritası
// şablon kişisinin ayrıntılarını taşıdı (272e656a c0 güneş gözlüğü camı
// alında turuncu leke, c5 koyu tenin parlamaları yağlı yüz). Düzlem ayrıntı
// taşıyamaz. Yalnızca burun ucunun üstünden öğrenilir (sakal dışarıda),
// aykırılar atılır; gözlüklü şablonda hiç uygulanmaz.
//
// Yüz maskesi yüz noktalarından çizilir (çene hattı + alın), gözler hariç:
// segmentasyon siyah-beyaz/karanlık şablonda deriyi bulamadı (9d9507f0 c4).
// Saça uygulanmaz (saç kenarında hale yaptı).

const sharp = require("sharp");

// Yerel ortalama yarıçapı, yüz genişliği cinsinden (ışık deseni ölçeği).
const SHADING_SIGMA = 0.06;
const GAIN_MIN = 0.7;
const GAIN_MAX = 1.4;
// Kafa yönleri bu kadar farklıysa yüzler birbirine oturmaz; dokunulmaz.
const MAX_YAW_DIFF = 0.5;
// Göreli gölgeleme farkı bundan küçükse (zaten benzer ışık) dokunulmaz.
const APPLY_MIN_DIFF = 0.03;
// Şablonda belirgin YÖNLÜ ışık eşiği (düzlem eğiminin büyüklüğü, yüz genişliği
// başına göreli parlaklık değişimi). 9d9507f0 c4 yan ışık: 1.5. Bunun altında
// ölçülen eğim gürültü olabilir; hedef eğim orantılı küçültülür (bkz. lightPlan).
const TEMPLATE_SLOPE_MIN = 0.5;
// Yumuşak ışıklı şablonda çıktı yüzü bundan güçlü yönlü ışık taşıyorsa bu ışık
// selfie'den gelmiştir (yüz ışığı yalnız şablondan gelmeli); düzleştirilir.
const OUTPUT_FLATTEN_SLOPE_MIN = 0.6;
// Uygulama maskesinin yumuşak kenarı, yüz genişliği cinsinden. Maske yüz
// sınırının İÇİNDE söner: eskiden kenar dışa doğru bulanıklaşıyor ve kafa
// çevresinde hale bırakıyordu (f9f3b5c0).
const EDGE_SIGMA = 0.05;
const WORK_FACE_PX = 160;
// Şablonda göz bölgesi / yüz parlaklığı bunun altındaysa gözlük var sayılır.
const EYEWEAR_RATIO_MAX = 0.55;

/**
 * Yüz noktalarından yüz maskesi (0/255), (W×H) ızgarada; mapPt ile
 * koordinat dönüştürülür. Gözler ve gözlük alanı çıkarılır. SAF.
 */
function landmarkFaceMask(P, W, H, mapPt = (p) => p) {
  const m = (p) => mapPt(p);
  const eyeL = { x: (P[36].x + P[39].x) / 2, y: (P[36].y + P[39].y) / 2 };
  const eyeR = { x: (P[42].x + P[45].x) / 2, y: (P[42].y + P[45].y) / 2 };
  const eyeW = (Math.hypot(P[36].x - P[39].x, P[36].y - P[39].y) + Math.hypot(P[42].x - P[45].x, P[42].y - P[45].y)) / 2;
  const browEye = Math.hypot((P[19].x + P[24].x) / 2 - (eyeL.x + eyeR.x) / 2, (P[19].y + P[24].y) / 2 - (eyeL.y + eyeR.y) / 2);
  const poly = [];
  for (let i = 0; i <= 16; i++) poly.push(m(P[i]));
  for (let i = 26; i >= 17; i--) {
    const dx = P[i].x - (eyeL.x + eyeR.x) / 2, dy = P[i].y - (eyeL.y + eyeR.y) / 2;
    const len = Math.hypot(dx, dy) || 1;
    poly.push(m({ x: P[i].x + (dx / len) * browEye * 0.9, y: P[i].y + (dy / len) * browEye * 0.9 }));
  }
  const eyes = [eyeL, eyeR].map((e) => ({ c: m(e), r: m({ x: e.x + eyeW, y: e.y }) }));
  const mask = Buffer.alloc(W * H);
  let minY = H, maxY = 0;
  for (const p of poly) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) mask[y * W + x] = 255;
    }
  }
  for (const e of eyes) {
    const rr = Math.hypot(e.r.x - e.c.x, e.r.y - e.c.y);
    const rx = 1.15 * rr, ry = 0.8 * rr;
    for (let y = Math.max(0, Math.floor(e.c.y - ry)); y <= Math.min(H - 1, Math.ceil(e.c.y + ry)); y++) {
      for (let x = Math.max(0, Math.floor(e.c.x - rx)); x <= Math.min(W - 1, Math.ceil(e.c.x + rx)); x++) {
        if (((x - e.c.x) / rx) ** 2 + ((y - e.c.y) / ry) ** 2 <= 1) mask[y * W + x] = 0;
      }
    }
  }
  return mask;
}

/**
 * Şablon ve çıktı ışık eğimine göre karar. SAF.
 * match   : şablonda yönlü ışık var → çıktı aynı eğime getirilir.
 * flatten : şablon yumuşak, çıktıda selfie'den gelmiş yönlü ışık var → çıktı
 *           şablonun (küçültülmüş) eğimine indirilir.
 * slopeScale: şablon eğimine uygulanacak çarpan.
 */
function lightPlan(tplSlope, outSlope) {
  if (tplSlope >= TEMPLATE_SLOPE_MIN) return { apply: true, mode: "match", slopeScale: 1 };
  if (outSlope >= OUTPUT_FLATTEN_SLOPE_MIN) {
    return { apply: true, mode: "flatten", slopeScale: Math.max(0, tplSlope) / TEMPLATE_SLOPE_MIN };
  }
  return { apply: false, mode: null, reason: "soft-light-both", slopeScale: 0 };
}

/**
 * Sert maskenin (0/255) İÇİNDE sönen yumuşak maske: önce aşındırılır, sonra
 * bulanıklaştırılır; sert maskenin dışı her zaman 0 kalır.
 */
async function insideSoftMask(hard, W, H, sigma) {
  const blur = (m) => sharp(m, { raw: { width: W, height: H, channels: 1 } })
    .blur(Math.max(0.3, sigma)).extractChannel(0).raw().toBuffer();
  const b1 = await blur(hard);
  const eroded = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) eroded[i] = b1[i] >= 250 ? 255 : 0;
  const soft = await blur(eroded);
  for (let i = 0; i < W * H; i++) if (!hard[i]) soft[i] = 0;
  return soft;
}

/** Benzerlik dönüşümü (Procrustes): src noktalarını dst'ye eşler. SAF. */
function fitSimilarity(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - sx, py = src[i].y - sy;
    const qx = dst[i].x - dx, qy = dst[i].y - dy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    den += px * px + py * py;
  }
  a /= den; b /= den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}
const applySim = (T, x, y) => ({ x: T.a * x - T.b * y + T.tx, y: T.b * x + T.a * y + T.ty });

/** Ağırlıklı yerel ortalama (normalize konvolüsyon), 3 kanal. */
async function weightedLowpass(rgb, w8, W, H, sigma) {
  const prod = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const m = w8[i] / 255;
    for (let c = 0; c < 3; c++) prod[i * 3 + c] = Math.round(rgb[i * 3 + c] * m);
  }
  const [num, den] = await Promise.all([
    sharp(prod, { raw: { width: W, height: H, channels: 3 } }).blur(sigma).raw().toBuffer(),
    sharp(w8, { raw: { width: W, height: H, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer(),
  ]);
  const L = new Float32Array(W * H * 3);
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    D[i] = den[i] / 255;
    for (let c = 0; c < 3; c++) L[i * 3 + c] = D[i] > 0.02 ? num[i * 3 + c] / D[i] : 0;
  }
  return { L, D };
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında. Döner:
 * { buf|null, applied, reason, diffBefore, diffAfter }
 *   diff = çıktı ile şablon göreli gölgelemesi arasındaki ortalama mutlak fark.
 */
async function transferFaceLight(outputBuf, templateBuf) {
  const { faceLandmarks, headYawOf } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width;
  const H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  const lt = (await faceLandmarks(tJpeg)) || (await faceLandmarks(tJpeg, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template" };
  const yo = await headYawOf(outputBuf, 0.1);
  const yt = await headYawOf(tJpeg, 0.1);
  if (yo != null && yt != null && Math.abs(yo - yt) > MAX_YAW_DIFF) {
    return { buf: null, applied: false, reason: "pose-differs", yawDiff: Math.abs(yo - yt) };
  }

  // Çalışma penceresi: çıktı yüzü çevresi, yüz genişliği WORK_FACE_PX olacak ölçekte.
  const fb = lo.box;
  const pad = 0.9 * fb.width;
  const L0 = Math.max(0, Math.floor(fb.x - pad)), T0 = Math.max(0, Math.floor(fb.y - pad));
  const R0 = Math.min(W, Math.ceil(fb.x + fb.width + pad)), B0 = Math.min(H, Math.ceil(fb.y + fb.height + pad));
  const cw = R0 - L0, ch = B0 - T0;
  const k = Math.min(1, WORK_FACE_PX / fb.width);
  const w = Math.max(16, Math.round(cw * k)), h = Math.max(16, Math.round(ch * k));

  const crop = async (rgb, ch3) => sharp(rgb, { raw: { width: W, height: H, channels: ch3 } })
    .extract({ left: L0, top: T0, width: cw, height: ch }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const oc = await crop(o.data, 3);
  // Çıktı yüz maskesi pencere ızgarasında.
  const toWin = (p) => ({ x: (p.x - L0) * k - 0.5, y: (p.y - T0) * k - 0.5 });
  const skinO = landmarkFaceMask(lo.pts, w, h, toWin);
  // Şablon maskesi tam karede, aşağıda pencereye örneklenir.
  const skinTfull = landmarkFaceMask(lt.pts, W, H);
  // GÖZLÜKLÜ ŞABLON (272e656a c0): koyu camlar ışık modelini bozuyor —
  // göz bölgesi yüzün geri kalanından belirgin koyuysa aktarım yapılmaz.
  {
    const tg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).greyscale().raw().toBuffer();
    const P = lt.pts;
    const eyeW = (Math.hypot(P[36].x - P[39].x, P[36].y - P[39].y) + Math.hypot(P[42].x - P[45].x, P[42].y - P[45].y)) / 2;
    let es = 0, en = 0, fs2 = 0, fn = 0;
    for (const [a, b] of [[36, 39], [42, 45]]) {
      const cx2 = (P[a].x + P[b].x) / 2, cy2 = (P[a].y + P[b].y) / 2;
      for (let y = Math.round(cy2 - eyeW * 0.5); y <= cy2 + eyeW * 0.5; y++) {
        for (let x = Math.round(cx2 - eyeW * 0.8); x <= cx2 + eyeW * 0.8; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          es += tg[y * W + x]; en++;
        }
      }
    }
    for (let i = 0; i < W * H; i++) if (skinTfull[i]) { fs2 += tg[i]; fn++; }
    const eyeRatio = en && fn ? (es / en) / Math.max(1, fs2 / fn) : 1;
    if (eyeRatio < EYEWEAR_RATIO_MAX) return { buf: null, applied: false, reason: "template-eyewear", eyeRatio };
  }

  // Şablon: çıktı penceresinin her pikseli için şablondaki karşılığı
  // (çıktı noktaları → şablon noktaları benzerlik dönüşümü).
  const idx = [...Array(17).keys(), ...Array.from({ length: 31 }, (_, i) => 17 + i)];
  const Tm = fitSimilarity(idx.map((i) => lo.pts[i]), idx.map((i) => lt.pts[i]));
  const tc = Buffer.alloc(w * h * 3);
  const skinT = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = L0 + (x + 0.5) / k, Y = T0 + (y + 0.5) / k;
      const q = applySim(Tm, X, Y);
      const qx = Math.round(q.x), qy = Math.round(q.y);
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
      const j = qy * W + qx;
      for (let c = 0; c < 3; c++) tc[(y * w + x) * 3 + c] = t[j * 3 + c];
      skinT[y * w + x] = skinTfull[j];
    }
  }

  const sigma = Math.max(1, SHADING_SIGMA * fb.width * k);
  const [lpO, lpT] = await Promise.all([weightedLowpass(oc, skinO, w, h, sigma), weightedLowpass(tc, skinT, w, h, sigma)]);

  // DOĞRUSAL IŞIK MODELİ (2026-10-08, 272e656a c0/c5): serbest biçimli
  // gölgeleme haritası şablon kişisine ait ayrıntıları da taşıdı — güneş
  // gözlüğünün camı ve yansıması alında turuncu leke, koyu tenli şablonun
  // elmacık parlamaları yağlı bir yüz yaptı. Işık artık yüz koordinatlarında
  // doğrusal bir eğim (r = a + b·u + c·v): yalnızca hangi yandan ve ne kadar
  // kontrastla geldiği. Yalnızca burun ucunun ÜSTÜNDEN (alın, yanaklar, burun)
  // öğrenilir — sakal/bıyık dışarıda; aykırılar (gözlük camı, parlama)
  // iki geçişte atılır.
  const toU = (x) => ((x + 0.5) / k + L0 - (fb.x + fb.width / 2)) / fb.width;
  const toV = (y) => ((y + 0.5) / k + T0 - (fb.y + fb.height / 2)) / fb.height;
  const noseV = (lo.pts[33].y - (fb.y + fb.height / 2)) / fb.height;
  // Öğrenme bandı: göz hattı ile burun ucu arası (yanaklar + burun). Alın
  // şablonda saçla örtülebiliyor (272e656a c6), çene sakallı.
  const eyeV = ((lo.pts[36].y + lo.pts[45].y) / 2 - (fb.y + fb.height / 2)) / fb.height;
  const samples = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = y * w + x;
      if (skinO[i] < 200 || skinT[i] < 200 || lpO.D[i] < 0.3 || lpT.D[i] < 0.3) continue;
      const v = toV(y);
      if (v > noseV || v < eyeV) continue;
      samples.push({ i, u: toU(x), v });
    }
  }
  if (samples.length < 80) return { buf: null, applied: false, reason: "no-common-skin", n: samples.length };
  const fitPlane = (L) => {
    // Kanal başına ortalamaya bölünmüş değer; iki geçişli kırpmalı en küçük kareler.
    const res = [];
    for (let c = 0; c < 3; c++) {
      let mean = 0;
      for (const sm of samples) mean += L[sm.i * 3 + c];
      mean /= samples.length;
      let use = samples;
      let coef = [1, 0, 0];
      for (let pass = 0; pass < 2; pass++) {
        let n = 0, su = 0, sv = 0, suu = 0, svv = 0, suv = 0, sr = 0, sur = 0, svr = 0;
        for (const sm of use) {
          const r = L[sm.i * 3 + c] / Math.max(1, mean);
          n++; su += sm.u; sv += sm.v; suu += sm.u * sm.u; svv += sm.v * sm.v; suv += sm.u * sm.v;
          sr += r; sur += sm.u * r; svr += sm.v * r;
        }
        // 3x3 normal denklemler (Cramer).
        const A = [[n, su, sv], [su, suu, suv], [sv, suv, svv]], B = [sr, sur, svr];
        const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        const D = det(A);
        if (Math.abs(D) < 1e-9) break;
        coef = [0, 1, 2].map((col) => det(A.map((row, ri) => row.map((val, ci) => (ci === col ? B[ri] : val)))) / D);
        if (pass === 0) {
          const resid = use.map((sm) => L[sm.i * 3 + c] / Math.max(1, mean) - (coef[0] + coef[1] * sm.u + coef[2] * sm.v));
          const sd = Math.sqrt(resid.reduce((q, r) => q + r * r, 0) / resid.length) || 1;
          use = use.filter((_, k2) => Math.abs(resid[k2]) <= 2 * sd);
          if (use.length < 40) break;
        }
      }
      res.push(coef);
    }
    return res;
  };
  // YALNIZCA PARLAKLIK: kanal başına ayrı düzlem yanakta renk kayması yaptı
  // (272e656a c6, mavimsi sol yanak). Üç kanalın ortalamasına tek düzlem
  // oturtulur, aynı kazanç üç kanala uygulanır. Işığın rengi prompt'ta.
  const lum = (L) => {
    const Y = new Float32Array(L.length);
    for (let i = 0; i < L.length / 3; i++) {
      const v = (L[i * 3] + L[i * 3 + 1] + L[i * 3 + 2]) / 3;
      Y[i * 3] = v; Y[i * 3 + 1] = v; Y[i * 3 + 2] = v;
    }
    return Y;
  };
  const mo = fitPlane(lum(lpO.L));
  const mtRaw = fitPlane(lum(lpT.L));
  const tplSlope = Math.hypot(mtRaw[1][1], mtRaw[1][2]);
  const outSlope = Math.hypot(mo[1][1], mo[1][2]);
  const plan = lightPlan(tplSlope, outSlope);
  if (!plan.apply) return { buf: null, applied: false, reason: plan.reason, tplSlope, outSlope };
  const mt = mtRaw.map(([a, b, c]) => [a, b * plan.slopeScale, c * plan.slopeScale]);
  // Fark ölçüsü: iki düzlemin örnek noktalarındaki ortalama mutlak farkı (yeşil).
  let diffB = 0;
  for (const sm of samples) {
    const ro = mo[1][0] + mo[1][1] * sm.u + mo[1][2] * sm.v;
    const rt = mt[1][0] + mt[1][1] * sm.u + mt[1][2] * sm.v;
    diffB += Math.abs(rt - ro);
  }
  const diffBefore = diffB / samples.length;
  if (diffBefore < APPLY_MIN_DIFF) return { buf: null, applied: false, reason: "similar-light", diffBefore, tplSlope, outSlope, mode: plan.mode };
  const rawGain = (u, v, c) => {
    const ro = mo[c][0] + mo[c][1] * u + mo[c][2] * v;
    const rt = mt[c][0] + mt[c][1] * u + mt[c][2] * v;
    return rt / Math.max(0.2, ro);
  };
  // Oran ortalamada 1'in üstüne kayar (karanlık taraf bölünürken büyür): yüz
  // genel olarak parlayıp düzleşiyordu (cbdbef13 c0/c10). Kazanç yüz bandında
  // ortalama 1'e sabitlenir — yalnız ışığın yönü/kontrastı taşınır.
  let gSum = 0;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const sm of samples) {
    gSum += rawGain(sm.u, sm.v, 1);
    uMin = Math.min(uMin, sm.u); uMax = Math.max(uMax, sm.u);
    vMin = Math.min(vMin, sm.v); vMax = Math.max(vMax, sm.v);
  }
  const gMean = gSum / samples.length || 1;
  // Düzlem yalnız öğrenildiği bantta geçerli; dışına doğrusal uzatmak dudak/
  // çenede parlak leke yaptı (cbdbef13 c2). Bant kenarındaki değer sürdürülür.
  const clamp = (val, lo, hi) => (val < lo ? lo : val > hi ? hi : val);
  const gainAt = (x, y, c) => {
    const u = clamp((x - (fb.x + fb.width / 2)) / fb.width, uMin, uMax);
    const v = clamp((y - (fb.y + fb.height / 2)) / fb.height, vMin, vMax);
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, rawGain(u, v, c) / gMean));
  };

  // Uygulama alanı: yüz derisi + saç/sakal, yüz çevresindeki elipsle sınırlı, yumuşak.
  const faceFull = landmarkFaceMask(lo.pts, W, H);
  const faceSoft = await insideSoftMask(faceFull, W, H, fb.width * EDGE_SIGMA);
  const cx = fb.x + fb.width / 2, cy = fb.y + fb.height * 0.55;
  const rx = fb.width * 0.95, ry = fb.height * 1.05;
  const out = Buffer.from(o.data);
  for (let y = T0; y < B0; y++) {
    for (let x = L0; x < R0; x++) {
      const i = y * W + x;
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const ellipse = e <= 1 ? 1 : e >= 1.6 ? 0 : 1 - (e - 1) / 0.6;
      // Yalnızca yüz: saça uygulamak saçın kenarında parlak hale yaptı
      // (272e656a c0/c5) — model yüzün dışına taşınınca kazanç büyüyor.
      const a = ellipse * faceSoft[i] / 255;
      if (a <= 0.01) continue;
      for (let c = 0; c < 3; c++) {
        const g = gainAt(x, y, c);
        const v = o.data[i * 3 + c] * (1 + a * (g - 1));
        out[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, mode: plan.mode, diffBefore, tplSlope, outSlope, n: samples.length, planeO: mo, planeT: mt };
}

// YÜZ POZLAMASI (2026-10-14, cbdbef13 c8/c29/c10/c2: loş sahnede yüz flaşlı
// gibi parlak). Düzlem aktarımı ortalamayı korur, yüzün sahneye göre
// parlaklığını düzeltmez. Şablon kişisinin teni farklı olduğu için yüz
// parlaklığı doğrudan kıyaslanamaz; kişinin KENDİ vücut derisi (boyun, el,
// kol) kıyaslanır: şablonda yüz/vücut oranı neyse çıktıda da o olmalı.
// Ölçülen fark: c8 1.38, c29 1.30, c10 1.23, c2 1.19, c3 0.86; diğerleri ±0.05.
// Yerel testte (aynı şablon, başka kullanıcı) ham c8 1.54-1.56 → alt sınır 0.62.
const EXPOSURE_SEG = 512;
// Sınıf olasılığı bu eşiğin üstündeki pikseller ölçüme girer.
const EXPOSURE_CLASS_P = 0.6;
// İki sınıftan da en az bu kadar piksel (EXPOSURE_SEG² ızgarada).
const EXPOSURE_MIN_PX = 1500;
const EXPOSURE_MIN_DIFF = 0.06;
const EXPOSURE_GAIN_MIN = 0.62;
const EXPOSURE_GAIN_MAX = 1.12;

/** Yüz/vücut derisi oranından parlaklık kazancı kararı. SAF. */
function exposurePlan(tpl, out) {
  const ok = (s) => s && s.nFace >= EXPOSURE_MIN_PX && s.nBody >= EXPOSURE_MIN_PX && s.body > 1;
  if (!ok(tpl) || !ok(out)) return { apply: false, reason: "no-body-skin" };
  const ratio = (out.face / out.body) / (tpl.face / tpl.body);
  if (Math.abs(ratio - 1) < EXPOSURE_MIN_DIFF) return { apply: false, reason: "within-tolerance", ratio, gain: 1 };
  return { apply: true, reason: null, ratio, gain: Math.min(EXPOSURE_GAIN_MAX, Math.max(EXPOSURE_GAIN_MIN, 1 / ratio)) };
}

// IŞIĞIN RENGİ (2026-10-15, kullanıcı: "yüzün rengi sahnenin ışığına
// uymuyor"): model yüz rengini selfie'lerden alıyor — base yüzlerin Lab renk
// açısı sahneye göre 35-57°, ham çıktılar hep 45-53° (selfie'ler 48-62°).
// Ten rengi açısı kişiden kişiye az değişir, ışığın rengiyle kayar; açı
// base'e doğru döndürülür, kroma ve açıklık kullanıcınınki kalır (base
// mankenin teni taşınmaz). Kanal başına RGB kazancı denendi ve çıkarıldı:
// "sıcak" ışıkta kırmızıyı artırıp yüzü pembeleştirdi (c8 46° → 41°) ve
// doygunluğu artırdı (c0 kroma 23.6 → 31.0).
const HUE_SHARE = 0.6;
const HUE_MAX_SHIFT = 10;
const HUE_MIN_DIFF = 3;
// Kroma bunun altındaysa (gri/siyah-beyaz, çok soluk) açı güvenilmez.
const HUE_MIN_CHROMA = 8;

const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Yüz derisi ortalama Lab'inden renk açısı kayması kararı (derece). SAF. */
function huePlan(tplLab, outLab) {
  if (!tplLab || !outLab) return { apply: false, reason: "no-face-skin", shift: 0 };
  const cT = Math.hypot(tplLab[1], tplLab[2]), cO = Math.hypot(outLab[1], outLab[2]);
  if (cT < HUE_MIN_CHROMA || cO < HUE_MIN_CHROMA) return { apply: false, reason: "low-chroma", shift: 0 };
  const hT = (Math.atan2(tplLab[2], tplLab[1]) * 180) / Math.PI;
  const hO = (Math.atan2(outLab[2], outLab[1]) * 180) / Math.PI;
  const diff = wrapDeg(hT - hO);
  if (Math.abs(diff) < HUE_MIN_DIFF) return { apply: false, reason: "within-tolerance", shift: 0, diff };
  const shift = Math.max(-HUE_MAX_SHIFT, Math.min(HUE_MAX_SHIFT, diff * HUE_SHARE));
  return { apply: true, reason: null, shift, diff };
}

async function skinLuminance(rgb, W, H) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const S = EXPOSURE_SEG;
  const raw = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(S, S, { fit: "fill" }).raw().toBuffer();
  const P = await classProbs(raw, S, S);
  const { rgbToLab } = require("./skinTone");
  let fs = 0, nFace = 0, bs = 0, nBody = 0;
  const fLab = [0, 0, 0];
  for (let i = 0; i < S * S; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    if (P[CLASSES.faceSkin][i] > EXPOSURE_CLASS_P) {
      fs += L; nFace++;
      const lab = rgbToLab(r, g, b);
      for (let c = 0; c < 3; c++) fLab[c] += lab[c];
    } else if (P[CLASSES.bodySkin][i] > EXPOSURE_CLASS_P) {
      bs += L; nBody++;
    }
  }
  return {
    face: nFace ? fs / nFace : 0, body: nBody ? bs / nBody : 0, nFace, nBody,
    faceLab: nFace >= EXPOSURE_MIN_PX ? fLab.map((v) => v / nFace) : null,
    P, CLASSES,
  };
}

/**
 * Çıktı yüzünün (yüz derisi + saç, gözler dahil) parlaklığını şablonun
 * yüz/vücut oranına, renk açısını şablon yüzünün açısına doğru getirir.
 * Döner: { buf|null, applied, reason, ratio, gain, hueShift, hueDiff }.
 */
async function matchFaceExposure(outputBuf, templateBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const [so, st] = await Promise.all([skinLuminance(o.data, W, H), skinLuminance(t, W, H)]);
  const plan = exposurePlan(st, so);
  const hue = huePlan(st.faceLab, so.faceLab);
  const tplOk = st.nFace >= EXPOSURE_MIN_PX && st.nBody >= EXPOSURE_MIN_PX && st.face > 1;
  const info = {
    ratio: plan.ratio, gain: plan.apply ? plan.gain : 1, hueShift: hue.shift, hueDiff: hue.diff ?? null,
    hueReason: hue.reason,
    tpl: st.body ? st.face / st.body : null, out: so.body ? so.face / so.body : null,
    bodyLightRatio: tplOk ? st.body / st.face : null,
  };
  if (!plan.apply && !hue.apply) return { buf: null, applied: false, reason: plan.reason, ...info };
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  if (!lo) return { buf: null, applied: false, reason: "no-face-output", ...info };

  // Maske: yüz derisi + saç olasılığı, yüz çevresindeki elipsle sınırlı. Boyun
  // (vücut derisi) dışarıda — ölçünün referansı o.
  const S = EXPOSURE_SEG;
  const m8 = Buffer.alloc(S * S);
  for (let i = 0; i < S * S; i++) {
    const p = so.P[so.CLASSES.faceSkin][i] + so.P[so.CLASSES.hair][i];
    m8[i] = Math.max(0, Math.min(255, Math.round(p * 255)));
  }
  const fb = lo.box;
  const mask = await sharp(m8, { raw: { width: S, height: S, channels: 1 } })
    .resize(W, H, { fit: "fill" }).blur(Math.max(0.5, fb.width * 0.03)).extractChannel(0).raw().toBuffer();
  const cx = fb.x + fb.width / 2, cy = fb.y + fb.height * 0.4;
  const rx = fb.width * 1.3, ry = fb.height * 1.5;
  const { rgbToLab, labToRgb } = require("./skinTone");
  const out = Buffer.from(o.data);
  const x0 = Math.max(0, Math.floor(cx - rx * 1.3)), x1 = Math.min(W, Math.ceil(cx + rx * 1.3));
  const y0 = Math.max(0, Math.floor(cy - ry * 1.3)), y1 = Math.min(H, Math.ceil(cy + ry * 1.3));
  const rad = (hue.shift * Math.PI) / 180;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const ellipse = e <= 1 ? 1 : e >= 1.6 ? 0 : 1 - (e - 1) / 0.6;
      const a = ellipse * mask[i] / 255;
      if (a <= 0.01) continue;
      const r0 = o.data[i * 3], g0 = o.data[i * 3 + 1], b0 = o.data[i * 3 + 2];
      const lab = rgbToLab(r0, g0, b0);
      // Kazanç yalnız açıklığa: RGB çarpımı kromayı da düşürüp loş sahnede
      // yüzü grileştirdi (c29 kroma 26.4 → 20.3).
      const k = 1 + a * (info.gain - 1);
      const L = k === 1 ? lab[0] : rgbToLab(Math.min(255, r0 * k), Math.min(255, g0 * k), Math.min(255, b0 * k))[0];
      const cs = Math.cos(rad * a), sn = Math.sin(rad * a);
      const rgb = labToRgb(L, lab[1] * cs - lab[2] * sn, lab[1] * sn + lab[2] * cs);
      out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, ...info };
}

module.exports = { transferFaceLight, fitSimilarity, applySim, landmarkFaceMask, lightPlan, insideSoftMask, exposurePlan, huePlan, matchFaceExposure };

// SİYAH-BEYAZ ŞABLON (2026-10-08, 9d9507f0 c4): şablon renksizken model yüzü
// renkli çizdi — gri bir sahnede pembe bir yüz. Şablonun ortalama renk
// doygunluğu bu eşiğin altındaysa çıktı da gri tonlamaya çekilir.
const GRAY_SAT_MAX = 4;

/** Ortalama doygunluk (max−min kanal), 0-255. */
async function meanSaturation(buf) {
  const { data } = await sharp(buf).removeAlpha().resize(256, 256, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  let s = 0;
  for (let i = 0; i < data.length; i += 3) s += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
  return s / (data.length / 3);
}

async function matchGrayscale(outputBuf, templateBuf) {
  const satT = await meanSaturation(templateBuf);
  if (satT >= GRAY_SAT_MAX) return { buf: null, applied: false, reason: "color-template", satT };
  // Çıktının ortalamasına bakılmaz (2026-10-09, f9f3b5c0 c4): gri sahnede
  // küçük renkli bir yüz ortalamayı 0.5'te bırakıp "zaten gri" sayıldı.
  const satO = await meanSaturation(outputBuf);
  if (satO < 0.05) return { buf: null, applied: false, reason: "already-gray", satT, satO };
  const buf = await sharp(outputBuf).greyscale().toColourspace("srgb").png().toBuffer();
  return { buf, applied: true, reason: null, satT, satO };
}

module.exports.matchGrayscale = matchGrayscale;
module.exports.meanSaturation = meanSaturation;
