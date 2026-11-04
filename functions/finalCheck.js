// SON ÇIKTI DOĞRULAMASI (2026-11-04).
//
// "BİTİRME KİMLİK" ölçümü simpleFinish'ten hemen sonra yapılır; gözlük
// (seg taşıma ya da AI yolu), ışıklı katman ve telefon dokusu ondan SONRA
// çalışır ve hiçbiri ölçülmüyordu. Teslim edilen kare ile ölçülen kare aynı
// değildi. Bu modül, doğrulanmış kare (gözlükten önceki hâl) ile teslim
// edilecek son kareyi YAPISAL olarak karşılaştırır — yerel, ücretsiz:
//   1. Dosya sağlam mı (sharp çözümleyebiliyor mu, boyutlar aynı mı)?
//   2. Yüz hâlâ bulunuyor mu?
//   3. Yüz kutusu kaydı mı, boyutu değişti mi?
//   4. Yüz noktaları (çene, burun, ağız) kaydı mı? Göz ve kaş noktaları
//      gözlük uygulandıysa hesaba katılmaz: gözlük o bölgeyi kapatır.
//   5. Yüz bölgesi netliği aşırı değişti mi (yalnız uç durumlarda bağlayıcı;
//      doku gren ekler, ışık yumuşatır — normal oynama loglanır)?
// Kimlik vektörü (face-api mesafesi) burada BİLEREK kullanılmıyor: gri
// tonlama, kontrast ve ışık mesafeyi kimlikten bağımsız oynatır; geometri
// bu etkilerden bağımsızdır.
//
// Başarısızlıkta çağıran doğrulanmış kareyi (gözlüksüz/ışıksız) teslim
// eder. Ölçüm hatası kareyi değiştirmez (fail-open).
const sharp = require("sharp");

// Yüz genişliğine oranla izinli kayma/boyut payları.
const BOX_SHIFT_MAX = 0.05; // kutu merkezi kayması (yüz genişliği oranı)
const BOX_SCALE_MIN = 0.93, BOX_SCALE_MAX = 1.07; // kutu genişliği oranı
const PTS_SHIFT_MAX = 0.04; // nokta ortalama kayması (yüz genişliği oranı)
const SHARP_RATIO_MIN = 0.35, SHARP_RATIO_MAX = 3.0; // yüz netliği son/önce

// face-api 68 nokta: 0-16 çene, 17-26 kaş, 27-35 burun, 36-47 gözler,
// 48-67 ağız. Gözlük uygulandıysa kaş ve göz noktaları dışlanır.
const EYE_REGION = new Set(Array.from({ length: 31 }, (_, i) => 17 + i)); // 17..47

/**
 * İki yüz ölçümünü karşılaştırır. before/after: { box:{x,y,width,height},
 * pts:[{x,y}] } ya da null. SAF. Döner { ok, reason, boxShift, boxScale,
 * ptsShift }.
 */
function compareFaces(before, after, { eyewear = false } = {}) {
  if (!before) return { ok: true, reason: "no-before" }; // önce yüz yoksa karar verilmez
  if (!after) return { ok: false, reason: "face-lost" };
  const fw = before.box.width;
  if (!(fw > 0)) return { ok: true, reason: "degenerate-before" };
  const cxB = before.box.x + before.box.width / 2, cyB = before.box.y + before.box.height / 2;
  const cxA = after.box.x + after.box.width / 2, cyA = after.box.y + after.box.height / 2;
  const boxShift = Math.hypot(cxA - cxB, cyA - cyB) / fw;
  const boxScale = after.box.width / fw;
  let ptsShift = null;
  if (Array.isArray(before.pts) && Array.isArray(after.pts) && before.pts.length === after.pts.length && before.pts.length > 0) {
    let s = 0, n = 0;
    for (let i = 0; i < before.pts.length; i++) {
      if (eyewear && EYE_REGION.has(i)) continue;
      s += Math.hypot(after.pts[i].x - before.pts[i].x, after.pts[i].y - before.pts[i].y);
      n++;
    }
    ptsShift = n ? s / n / fw : null;
  }
  const out = { boxShift, boxScale, ptsShift };
  if (boxShift > BOX_SHIFT_MAX) return { ok: false, reason: "box-shift", ...out };
  if (boxScale < BOX_SCALE_MIN || boxScale > BOX_SCALE_MAX) return { ok: false, reason: "box-scale", ...out };
  if (ptsShift != null && ptsShift > PTS_SHIFT_MAX) return { ok: false, reason: "landmark-shift", ...out };
  return { ok: true, reason: null, ...out };
}

/** Netlik oranı kararı. SAF. */
function sharpnessVerdict(before, after) {
  if (!(before > 0) || !(after >= 0)) return { ok: true, ratio: null };
  const ratio = after / before;
  return { ok: ratio >= SHARP_RATIO_MIN && ratio <= SHARP_RATIO_MAX, ratio };
}

/** Yüz kutusundaki Laplacian varyansı (gri). Kutu dışına taşmaz. */
async function faceSharpness(buf, box, W, H) {
  const left = Math.max(0, Math.round(box.x)), top = Math.max(0, Math.round(box.y));
  const width = Math.max(8, Math.min(W - left, Math.round(box.width)));
  const height = Math.max(8, Math.min(H - top, Math.round(box.height)));
  const { data, info } = await sharp(buf).extract({ left, top, width, height })
    .resize({ width: 256, withoutEnlargement: true }).grayscale()
    .raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
    sum += v; sum2 += v * v; n++;
  }
  if (!n) return 0;
  const m = sum / n;
  return sum2 / n - m * m;
}

/**
 * Doğrulanmış kare (verifiedBuf) ile teslim adayı (finalBuf) karşılaştırması.
 * Döner { ok, reason, ...ölçüler, ms }. Ölçüm hatası → ok:true, reason:"error".
 */
async function validateFinalOutput(verifiedBuf, finalBuf, { eyewear = false } = {}) {
  const t0 = Date.now();
  try {
    const [mv, mf] = await Promise.all([sharp(verifiedBuf).metadata(), sharp(finalBuf).metadata()]);
    if (!mf.width || !mf.height) return { ok: false, reason: "corrupt-file", ms: Date.now() - t0 };
    if (mv.width !== mf.width || mv.height !== mf.height) {
      return { ok: false, reason: "size-changed", before: `${mv.width}x${mv.height}`, after: `${mf.width}x${mf.height}`, ms: Date.now() - t0 };
    }
    const { faceLandmarks } = require("./faceQuality");
    const [fb, fa] = await Promise.all([faceLandmarks(verifiedBuf), faceLandmarks(finalBuf)]);
    const geo = compareFaces(fb, fa, { eyewear });
    let sharpB = null, sharpA = null, sharpRatio = null, sharpOk = true;
    if (fb && fa) {
      [sharpB, sharpA] = await Promise.all([
        faceSharpness(verifiedBuf, fb.box, mv.width, mv.height),
        faceSharpness(finalBuf, fb.box, mf.width, mf.height),
      ]);
      const sv = sharpnessVerdict(sharpB, sharpA);
      sharpRatio = sv.ratio; sharpOk = sv.ok;
    }
    const ok = geo.ok && sharpOk;
    return {
      ok, reason: ok ? null : (geo.ok ? "sharpness" : geo.reason),
      boxShift: geo.boxShift ?? null, boxScale: geo.boxScale ?? null, ptsShift: geo.ptsShift ?? null,
      sharpBefore: sharpB, sharpAfter: sharpA, sharpRatio,
      faceBefore: !!fb, faceAfter: !!fa, ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: true, reason: "error", error: e.message || String(e), ms: Date.now() - t0 };
  }
}

module.exports = {
  validateFinalOutput,
  _testables: { compareFaces, sharpnessVerdict, BOX_SHIFT_MAX, BOX_SCALE_MIN, BOX_SCALE_MAX, PTS_SHIFT_MAX, SHARP_RATIO_MIN, SHARP_RATIO_MAX },
};
