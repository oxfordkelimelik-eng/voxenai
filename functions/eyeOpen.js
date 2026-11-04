// GÖZ AÇIKLIĞI (2026-10-27, kullanıcı: "selfiedeki gözleri kapalı gibiyse
// çıktıda da gözler çok cansız kapalı gibi duruyor; çok az daha açık ve canlı
// durmalı, kişi farklı birine benzememeli").
//
// Model selfie'deki ağır/düşük göz kapağını kimlik sayıp kopyalıyor (e25dc241
// c4/c5/c7: üst kapak irisin üst üçte birini örtüyor, şablonlarda göz açık).
// Prompt yolu kapalı: "Eyes are open and clear, never half-closed" zaten
// yazıyor; göze dair selfie'ye bağlanan cümle bakışı bozdu (bkz. bakış
// notları), göz onarımı (yeniden çizim) kimliği bozdu.
//
// Yöntem: yoğun yüz ağına (faceMesh) göre yalnız ÜST KAPAK yukarı bükülür.
// Göz çerçevesi köşe→köşe ekseni (u 0..1) ve ona dik v (aşağı +). Kapak
// ortada açıklığın LIFT katı kadar kalkar, köşelerde 0; kapak üstündeki deri
// kaşa doğru R yüksekliğinde sıkışır, kapakla alt kapak arası (iris) aynı
// miktarda uzar — irisin kapak altındaki kesik kirişi yukarı çıkar, göz
// "daha açık" görünür. Alt kapak, kaş, göz köşeleri ve göz şekli yerinde.
//
// Ölçüm (18 kare, iki kişi; kimlik = selfie vektörüne uzaklık): kaldırma
// 0.25'te Δkimlik ort +0.001, en çok +0.016 — JPEG yeniden kaydetmenin
// gürültüsü ±0.011. 0.35'te ort +0.005, en çok +0.025. Yine de kare başına
// kimlik kapısı var (IDENTITY_SLACK).

const sharp = require("sharp");

// Açıklık = üç dikey kapak aralığının ortalaması / göz eni (ağ noktaları).
// Ölçülen: e25 çıktıları 0.27-0.34 (gözle bakınca ağır kapaklı), açık bakan
// kareler 0.41-0.46. Bu aralıkta kaldırma doğrusal azalır.
const FULL_LIFT_AP = 0.34;
const NO_LIFT_AP = 0.42;
// "Çok az daha açık": ortada açıklığın en çok %25'i.
const MAX_LIFT = 0.25;
// Bunun altı bilerek kapalı/kırpılmış göz (gülme, kırpma) — açılmaz.
const CLOSED_AP = 0.15;
// Daha küçük gözde ağ kapak çizgisi güvenilmez.
const MIN_EYE_PX = 10;
// Profilde uzak göz kısalır; diğerinin bu katından darsa dokunulmaz.
const FAR_EYE_RATIO = 0.5;
// Kapak üstünde sıkışan yükseklik / en büyük açıklık.
const REACH = 1.3;
// Selfie vektörüne uzaklık bu kadardan fazla artarsa uygulanmaz.
const IDENTITY_SLACK = 0.02;

// MediaPipe 468: köşeden köşeye üst ve alt kapak; açıklık için üç dikey çift.
const EYES = [
  {
    up: [33, 246, 161, 160, 159, 158, 157, 173, 133], lo: [33, 7, 163, 144, 145, 153, 154, 155, 133],
    pairs: [[160, 144], [159, 145], [158, 153]],
  },
  {
    up: [362, 398, 384, 385, 386, 387, 388, 466, 263], lo: [362, 382, 381, 380, 374, 373, 390, 249, 263],
    pairs: [[385, 380], [386, 374], [387, 373]],
  },
];

/** Gözün eni ve açıklık oranı. SAF. */
function eyeAperture(mesh, eye) {
  const a = mesh[eye.up[0]], b = mesh[eye.up[eye.up.length - 1]];
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let h = 0;
  for (const [i, j] of eye.pairs) h += Math.hypot(mesh[i][0] - mesh[j][0], mesh[i][1] - mesh[j][1]);
  return { w, ap: w > 0 ? h / eye.pairs.length / w : 0 };
}

/** Ortalama açıklıktan kaldırma katı (0..MAX_LIFT). SAF. */
function liftFor(ap) {
  if (!(ap >= CLOSED_AP)) return 0;
  const t = (NO_LIFT_AP - ap) / (NO_LIFT_AP - FULL_LIFT_AP);
  return MAX_LIFT * Math.min(1, Math.max(0, t));
}

/** Noktaları göz çerçevesine ([u, v], u'ya göre sıralı) çevirir. SAF. */
function toFrame(points, f) {
  return points
    .map((p) => [((p[0] - f.ax) * f.ex + (p[1] - f.ay) * f.ey) / f.w, (p[0] - f.ax) * f.nx + (p[1] - f.ay) * f.ny])
    .sort((x, y) => x[0] - y[0]);
}

/** Parça parça doğrusal v(u). SAF. */
function interp(c, u) {
  if (u <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (u <= c[i][0]) {
      const t = (u - c[i - 1][0]) / Math.max(1e-6, c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + t * (c[i][1] - c[i - 1][1]);
    }
  }
  return c[c.length - 1][1];
}

/**
 * Tek gözün üst kapağını kaldırır: src'den okur, dst'ye yazar (W×H×3).
 * Geri eşleme: çıktı (u, v) kaynağı v + s'den okur. SAF.
 */
function liftEye(src, dst, W, H, mesh, eye, lift) {
  const a = mesh[eye.up[0]], b = mesh[eye.up[eye.up.length - 1]];
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(w > 0) || !(lift > 0)) return 0;
  const ex = (b[0] - a[0]) / w, ey = (b[1] - a[1]) / w;
  let nx = -ey, ny = ex;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const f = { ax: a[0], ay: a[1], ex, ey, nx, ny, w };
  const U = toFrame(eye.up.map((i) => mesh[i]), f);
  const L = toFrame(eye.lo.map((i) => mesh[i]), f);
  let apMax = 0;
  for (let k = 0; k <= 20; k++) apMax = Math.max(apMax, interp(L, k / 20) - interp(U, k / 20));
  if (!(apMax > 0)) return 0;
  const R = REACH * apMax;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const i of [...eye.up, ...eye.lo]) {
    xMin = Math.min(xMin, mesh[i][0]); xMax = Math.max(xMax, mesh[i][0]);
    yMin = Math.min(yMin, mesh[i][1]); yMax = Math.max(yMax, mesh[i][1]);
  }
  const x0 = Math.max(0, Math.floor(xMin - 3)), x1 = Math.min(W - 2, Math.ceil(xMax + 3));
  const y0 = Math.max(0, Math.floor(yMin - R - apMax - 3)), y1 = Math.min(H - 2, Math.ceil(yMax + 3));
  let moved = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const u = ((x - a[0]) * ex + (y - a[1]) * ey) / w;
      if (u <= 0 || u >= 1) continue;
      const v = (x - a[0]) * nx + (y - a[1]) * ny;
      const Uu = interp(U, u), Lu = interp(L, u), ap = Lu - Uu;
      if (ap <= 0) continue;
      const d = lift * ap * Math.sqrt(Math.sin(Math.PI * u));
      const top = Uu - d;
      let s = 0;
      if (v >= top && v <= Lu) s = d * (Lu - v) / (Lu - top);
      else if (v < top && v > top - R) s = d * (v - (top - R)) / R;
      if (s <= 0.01) continue;
      const sx = x + s * nx, sy = y + s * ny;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      if (ix < 0 || iy < 0 || ix + 1 >= W || iy + 1 >= H) continue;
      for (let c = 0; c < 3; c++) {
        const p00 = src[(iy * W + ix) * 3 + c], p10 = src[(iy * W + ix + 1) * 3 + c];
        const p01 = src[((iy + 1) * W + ix) * 3 + c], p11 = src[((iy + 1) * W + ix + 1) * 3 + c];
        dst[(y * W + x) * 3 + c] = Math.round((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy);
      }
      moved++;
    }
  }
  return moved;
}

/**
 * Ağır kapaklı gözü biraz açar. Döner { buf, applied, reason, ap, lift, id0, id1 }.
 * Her hata ya da emin olunamayan durumda buf null ve applied false (fail-safe).
 */
async function openEyes(buf, refDescriptor) {
  const FQ = require("./faceQuality");
  const lo = await FQ.faceLandmarks(buf);
  if (!lo) return { buf: null, applied: false, reason: "no-face" };
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const m = await require("./faceMesh").denseMesh(data, W, H, lo.pts);
  if (!m) return { buf: null, applied: false, reason: "no-mesh" };
  const st = EYES.map((e) => eyeAperture(m.mesh, e));
  const wMax = Math.max(st[0].w, st[1].w);
  const use = st.map((s) => s.w >= MIN_EYE_PX && s.w >= FAR_EYE_RATIO * wMax);
  if (!use[0] && !use[1]) return { buf: null, applied: false, reason: "small-eyes" };
  const aps = st.filter((s, i) => use[i]).map((s) => s.ap);
  const ap = aps.reduce((x, y) => x + y, 0) / aps.length;
  if (ap < CLOSED_AP) return { buf: null, applied: false, reason: "closed", ap };
  const lift = liftFor(ap);
  if (lift <= 0) return { buf: null, applied: false, reason: "open", ap };
  const dst = Buffer.from(data);
  let moved = 0;
  EYES.forEach((e, i) => { if (use[i]) moved += liftEye(data, dst, W, H, m.mesh, e, lift); });
  if (!moved) return { buf: null, applied: false, reason: "no-pixels", ap, lift };
  const out = await sharp(dst, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  let id0 = null, id1 = null;
  if (refDescriptor) {
    id0 = (await FQ.matchesIdentity(buf, refDescriptor)).distance;
    id1 = (await FQ.matchesIdentity(out, refDescriptor)).distance;
    if (id0 != null && (id1 == null || id1 > id0 + IDENTITY_SLACK)) {
      return { buf: null, applied: false, reason: "identity", ap, lift, id0, id1 };
    }
  }
  return { buf: out, applied: true, reason: null, ap, lift, id0, id1 };
}

module.exports = {
  openEyes,
  _testables: { eyeAperture, liftFor, liftEye, interp, toFrame, EYES, FULL_LIFT_AP, NO_LIFT_AP, MAX_LIFT, CLOSED_AP },
};
