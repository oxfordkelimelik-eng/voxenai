// REFERANSI BASE'E UYDURMA (2026-11-01, 831a00a4, kullanıcı: "gözler
// istenen yere bakmıyor, gözler kapalı kalmış, gereksiz gülümseme eklenmiş;
// tek istediğim base fotonun tamamen aynısını yeni bir yüz ile üretmek").
//
// Model, prompt ne derse desin yüzü modele giden selfie'den kopyalıyor:
// - Baş pozu: selfie base pozuna çevrildi (headPose3d.reposeFace) → 831a00a4'te
//   10/10 karede |Δyaw| ≤ 2° (önce 15-25°).
// - Bakış: aynı işte başı dönük 5 karenin hepsinde base gözü uzağa (iris
//   u 0.21-0.37), çıktı gözü kameraya (0.53-0.65) bakıyordu — profil
//   selfie'de göz telefona çevrilir; model o bakışı taşıdı. Kapak da
//   telefona bakarken iner (c1 "gözler kapalı").
// - Gülümseme: selfie'deki gülüş (c0).
// "BASE ifadesini koru, gülümseme ekleme, gözler BASE'in baktığı yere"
// cümleleri haftalardır prompt'ta; tutmadı. Çıktıyı sonradan düzeltmek
// (iris ~12 px) iz bırakıyor; selfie'de göz 80-100 px, düzeltme temiz.
//
// Bu yüzden base pozuna çevrilmiş selfie'ye dört şey daha uygulanır; hepsi
// base'den ölçülür, hepsi geometrik (yeni piksel çizilmez, kimlik dokusu
// aynı):
//   1) Yan yatıklık (roll): görüntü yüz merkezi etrafında döner.
//   2) Bakış: iris, göz açıklığının İÇİNDE base'in göz içi konumuna kayar
//      (köşeler ve kapaklar yerinde, iris katı, sklera esner).
//   3) Kapak: selfie gözü base'den kısıksa üst kapak kalkar (eyeOpen.liftEye).
//      Base'den açıksa kapatılmaz (kullanıcı 10-14: "gözler kapalı durmamalı").
//   4) Ağız: selfie ağız köşeleri base'den yukarıdaysa (gülüş) köşeler
//      base yüksekliğine iner. Base daha çok gülüyorsa dokunulmaz.
// Ölçülemeyen ya da güvenilmeyen her adım atlanır (fail-safe).

const sharp = require("sharp");
const { _testables: EO } = require("./eyeOpen");
const { EYES, interp, toFrame, liftEye, eyeAperture } = EO;

// İris çapı / göz eni (karanlık profil penceresi).
const IRIS_W = 0.42;
// Göz bu kadar dar ya da kontrastsızsa iris yeri güvenilmez.
const MIN_EYE_PX = 12;
const MIN_IRIS_CONTRAST = 30;
const MIN_OPEN_AP = 0.16;
// Profilde uzak göz: yakın gözün bu katından darsa ölçüsü kullanılmaz.
const FAR_EYE_RATIO = 0.55;
// ... ama bu katından genişse yakın gözün kaymasını İZLER (kendi hedefi
// yok): yalnız yakın göz kayınca göz şaşı görünür (selfie 45°te uzak göz
// yakının ~0.47 katı).
const FOLLOW_EYE_RATIO = 0.35;
// Bakış kaydırması sınırı (göz eni oranı) ve eşiği.
const MAX_GAZE_SHIFT = 0.32;
const MIN_GAZE_SHIFT = 0.04;
// İki göz birlikte bakar: iki gözün iris yeri bundan çok ayrışıyorsa ölçü
// gürültüdür (831a00a4 c8: kameraya bakan base 0.52/0.76 ölçüldü) — o
// görüntüde bakışa dokunulmaz.
const EYE_DISAGREE_MAX = 0.18;
// Kapak: base açıklığının bu katına kadar kaldırılır, en çok bu kadar.
const LID_TARGET = 0.95;
const MAX_LID_LIFT = 0.35;
const MIN_LID_LIFT = 0.06;
// Yan yatıklık: bu farkın altı dokunulmaz, üstü sınırlanır (derece).
const MIN_ROLL = 2.5;
const MAX_ROLL = 20;
// Ağız köşesi (göz arası oranı): fark eşiği ve en çok indirme.
// 831a00a4 c0: base'in hafif sırıtışı (−0.002) kullanıcının yüzünde gülümseme
// okundu, çıktı köşesi base'den yalnız 0.008 yukarıdaydı. Base gülmüyorsa
// (≤ SMILE_BASE_NEUTRAL) hedef nötrün biraz altı.
const SMILE_BASE_NEUTRAL = 0.015;
const SMILE_NEUTRAL_MARGIN = 0.01;
const MIN_SMILE_DROP = 0.008;
const MAX_SMILE_DROP = 0.06;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Göz çerçevesi: köşe→köşe u (0..1), dik v (aşağı +, px); kapak eğrileri. SAF. */
function eyeFrame(mesh, eye) {
  const a = mesh[eye.up[0]], b = mesh[eye.up[eye.up.length - 1]];
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(w > 0)) return null;
  const ex = (b[0] - a[0]) / w, ey = (b[1] - a[1]) / w;
  let nx = -ey, ny = ex;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const f = { ax: a[0], ay: a[1], ex, ey, nx, ny, w };
  f.U = toFrame(eye.up.map((i) => mesh[i]), f);
  f.L = toFrame(eye.lo.map((i) => mesh[i]), f);
  return f;
}

const toXY = (f, u, v) => [f.ax + u * f.w * f.ex + v * f.nx, f.ay + u * f.w * f.ey + v * f.ny];

/** Çift doğrusal örnek (kanal c). SAF. */
function sample(rgb, W, H, x, y, c) {
  const X = clamp(x, 0, W - 1.001), Y = clamp(y, 0, H - 1.001);
  const ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy;
  const i = (iy * W + ix) * 3 + c;
  return (rgb[i] * (1 - fx) + rgb[i + 3] * fx) * (1 - fy) + (rgb[i + W * 3] * (1 - fx) + rgb[i + W * 3 + 3] * fx) * fy;
}
const lumAt = (rgb, W, H, x, y) => 0.299 * sample(rgb, W, H, x, y, 0) + 0.587 * sample(rgb, W, H, x, y, 1) + 0.114 * sample(rgb, W, H, x, y, 2);

/**
 * İris merkezi (u, 0..1): açıklık içinde sklera parlaklığına göre karanlık
 * profilin IRIS_W pencereli tepe noktası, pencere içi ağırlık merkezi. SAF.
 */
function irisU(rgb, W, H, f) {
  const N = 40;
  const vals = [];
  const col = [];
  for (let k = 0; k <= N; k++) {
    const u = k / N, Uu = interp(f.U, u), ap = interp(f.L, u) - Uu;
    const c = [];
    if (ap > 1) for (let t = 0.2; t <= 0.81; t += 0.1) { const [x, y] = toXY(f, u, Uu + t * ap); const l = lumAt(rgb, W, H, x, y); c.push(l); vals.push(l); }
    col.push(c);
  }
  if (vals.length < 20) return null;
  vals.sort((a, b) => a - b);
  const ref = vals[Math.floor(vals.length * 0.85)];
  const contrast = ref - vals[Math.floor(vals.length * 0.1)];
  const prof = col.map((c) => (c.length ? c.reduce((s, l) => s + Math.max(0, ref - l), 0) / c.length : 0));
  const half = Math.round((IRIS_W * N) / 2);
  let best = -1, bk = -1;
  for (let k = half; k <= N - half; k++) {
    let s = 0;
    for (let j = -half; j <= half; j++) s += prof[k + j];
    if (s > best) { best = s; bk = k; }
  }
  if (bk < 0) return null;
  let sw = 0, su = 0;
  for (let j = -half; j <= half; j++) { sw += prof[bk + j]; su += prof[bk + j] * (bk + j); }
  return { u: sw > 0 ? su / sw / N : bk / N, contrast };
}

/** Base gülüşünden ağız köşesi hedefi: base gülüyorsa aynısı, gülmüyorsa nötrün biraz altı. SAF. */
function smileTarget(baseSmile) {
  return baseSmile > SMILE_BASE_NEUTRAL ? baseSmile : Math.min(baseSmile, 0) - SMILE_NEUTRAL_MARGIN;
}

/** Köşe ne kadar inmeli (göz arası oranı, 0 = dokunma). SAF. */
function smileDrop(smile, baseSmile) {
  if (smile == null || baseSmile == null) return 0;
  const d = clamp(smile - smileTarget(baseSmile), 0, MAX_SMILE_DROP);
  return d >= MIN_SMILE_DROP ? d : 0;
}

/** Ağız köşelerinin dudak ortasına göre yüksekliği / göz arası (+ = gülüş). SAF. */
function smileOf(mesh) {
  const iod = Math.hypot(mesh[263][0] - mesh[33][0], mesh[263][1] - mesh[33][1]);
  if (!(iod > 0)) return null;
  const ex = (mesh[263][0] - mesh[33][0]) / iod, ey = (mesh[263][1] - mesh[33][1]) / iod;
  let nx = -ey, ny = ex;
  if (ny < 0) { nx = -nx; ny = -ny; } // aşağı
  const mx = (mesh[13][0] + mesh[14][0]) / 2, my = (mesh[13][1] + mesh[14][1]) / 2;
  const down = (p) => ((p[0] - mx) * nx + (p[1] - my) * ny) / iod;
  return { smile: -(down(mesh[61]) + down(mesh[291])) / 2, iod, nx, ny };
}

/** İki gözün iris ölçüsü birbirini tutuyor mu (ikisi de ölçülmüşse). SAF. */
function eyesAgree(eyes) {
  return !(eyes[0].ok && eyes[1].ok && Math.abs(eyes[0].u - eyes[1].u) > EYE_DISAGREE_MAX);
}

/** Yüz ağı + poz + göz/ağız ölçüleri. loose: aşağı eğik/gözlüklü başta gevşek ağ (headPose3d gibi). */
async function featuresOf(rgb, W, H, { loose = false } = {}) {
  const { faceLandmarks } = require("./faceQuality");
  const { denseMesh } = require("./faceMesh");
  const { poseFromMesh } = require("./headPose3d");
  const jpg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(jpg)) || (await faceLandmarks(jpg, 0.1));
  if (!lo) return null;
  const m = (await denseMesh(rgb, W, H, lo.pts)) ||
    (loose ? await denseMesh(rgb, W, H, lo.pts, { agreeMax: 0.32, minScoreLoose: 0.9 }) : null);
  if (!m) return null;
  const mesh = m.mesh;
  const frames = EYES.map((e) => eyeFrame(mesh, e));
  const wMax = Math.max(...frames.map((f) => (f ? f.w : 0)));
  const eyes = EYES.map((e, i) => {
    const f = frames[i];
    if (!f) return { ok: false };
    const ap = eyeAperture(mesh, e).ap;
    const ir = irisU(rgb, W, H, f);
    const seen = f.w >= MIN_EYE_PX && ap >= MIN_OPEN_AP && !!ir && ir.contrast >= MIN_IRIS_CONTRAST;
    const ok = seen && f.w >= FAR_EYE_RATIO * wMax;
    const follow = seen && f.w >= FOLLOW_EYE_RATIO * wMax;
    return { ok, follow, w: f.w, ap, u: ir ? ir.u : null, contrast: ir ? ir.contrast : null, f };
  });
  const near = eyes[0].w >= eyes[1].w ? 0 : 1;
  return { mesh, pose: poseFromMesh(mesh), eyes, near, mouth: smileOf(mesh) };
}

/** Base (şablon) ölçüleri — chunk başına bir kez. Ölçülemezse null. */
async function baseFeatures(buf) {
  try {
    const { data, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ft = await featuresOf(data, info.width, info.height, { loose: true });
    if (!ft) return null;
    return {
      roll: ft.pose.roll,
      eyes: ft.eyes.map((e) => ({ ok: e.ok, u: e.u, ap: e.ap, w: e.w })),
      near: ft.near,
      gazeOk: eyesAgree(ft.eyes),
      smile: ft.mouth ? ft.mouth.smile : null,
    };
  } catch (e) {
    console.error("Base yüz ölçüsü alınamadı:", e.message || e);
    return null;
  }
}

/** Tuval dışına düşen koordinatı kenardan aynalar (kenar pikseli uzamasın). SAF. */
function reflect(v, n) {
  const m = n - 1;
  if (m <= 0) return 0;
  let r = Math.abs(v) % (2 * m);
  if (r > m) r = 2 * m - r;
  return r;
}

/**
 * Görüntüyü (cx, cy) etrafında deg derece döndürür (saat yönü +), tuval aynı.
 * Köşelerde açılan yer aynalı doldurulur — kenar pikseli uzatılınca
 * referansın kenarında çizgi çizgi şerit kalıyordu. SAF.
 */
function rotateAbout(rgb, W, H, cx, cy, deg) {
  const out = Buffer.alloc(W * H * 3);
  const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const sx = reflect(cx + ca * dx + sa * dy, W), sy = reflect(cy - sa * dx + ca * dy, H);
    const o = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(sample(rgb, W, H, sx, sy, c));
  }
  return out;
}

/**
 * İrisi göz açıklığının içinde u0 → u1'e taşır: u ekseninde [0, u0±h, 1] →
 * [0, u1±h, 1] parça parça doğrusal (iris katı, sklera esner), v kapak
 * eğrilerine göre oranlı (kapaklar yerinde). src'den okur, dst'ye yazar. SAF.
 */
function shiftIris(src, dst, W, H, f, u0, u1) {
  const h = IRIS_W / 2;
  u1 = clamp(u1, h + 0.03, 1 - h - 0.03);
  u0 = clamp(u0, h + 0.03, 1 - h - 0.03);
  if (Math.abs(u1 - u0) < 1e-3) return 0;
  const ko = [0, u1 - h, u1 + h, 1], ks = [0, u0 - h, u0 + h, 1];
  const inv = (u) => {
    for (let i = 1; i < 4; i++) if (u <= ko[i]) return ks[i - 1] + ((u - ko[i - 1]) / Math.max(1e-6, ko[i] - ko[i - 1])) * (ks[i] - ks[i - 1]);
    return 1;
  };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of [...f.U, ...f.L]) {
    const [x, y] = toXY(f, p[0], p[1]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  let moved = 0;
  for (let y = Math.max(0, Math.floor(y0 - 1)); y <= Math.min(H - 1, Math.ceil(y1 + 1)); y++) {
    for (let x = Math.max(0, Math.floor(x0 - 1)); x <= Math.min(W - 1, Math.ceil(x1 + 1)); x++) {
      const u = ((x - f.ax) * f.ex + (y - f.ay) * f.ey) / f.w;
      if (u <= 0 || u >= 1) continue;
      const v = (x - f.ax) * f.nx + (y - f.ay) * f.ny;
      const Uu = interp(f.U, u), ap = interp(f.L, u) - Uu;
      if (ap <= 1) continue;
      const t = (v - Uu) / ap;
      const edge = Math.min(t, 1 - t) * ap;
      if (edge <= 0) continue;
      const wgt = Math.min(1, edge / Math.max(1.5, 0.08 * ap));
      const us = inv(u), Us = interp(f.U, us), Ls = interp(f.L, us);
      const [sx, sy] = toXY(f, us, Us + t * (Ls - Us));
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) dst[o + c] = Math.round(src[o + c] * (1 - wgt) + sample(src, W, H, sx, sy, c) * wgt);
      moved++;
    }
  }
  return moved;
}

/** Ağız köşelerini n yönünde d px aşağı çeker (Gauss sönümlü geri eşleme). SAF. */
function dropCorners(src, dst, W, H, mesh, mouth, d) {
  const mw = Math.hypot(mesh[291][0] - mesh[61][0], mesh[291][1] - mesh[61][1]);
  const r = Math.max(4, 0.45 * mw);
  let moved = 0;
  for (const ci of [61, 291]) {
    const [cx, cy] = mesh[ci];
    for (let y = Math.max(0, Math.floor(cy - 2.5 * r)); y <= Math.min(H - 1, Math.ceil(cy + 2.5 * r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - 2.5 * r)); x <= Math.min(W - 1, Math.ceil(cx + 2.5 * r)); x++) {
        const g = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
        if (g < 0.02) continue;
        const sx = x - d * g * mouth.nx, sy = y - d * g * mouth.ny;
        const o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) dst[o + c] = Math.round(sample(src, W, H, sx, sy, c));
        moved++;
      }
    }
    src = Buffer.from(dst); // ikinci köşe birincinin sonucundan okur
  }
  return moved;
}

/**
 * Base pozuna çevrilmiş selfie'yi (JPEG) base'in bakışı, kapağı, yatıklığı ve
 * ağız köşesine uydurur. base: baseFeatures() çıktısı. Döner { buf, applied,
 * steps, log } — her hata ya da ölçülemeyen durumda buf girişin aynısı.
 */
// only: yalnız bu adımlar ("roll", "gaze", "lid", "mouth"); null = hepsi.
// 2026-11-03 tüm selfie setinde yalnız "gaze" (kullanıcı: kapak/ağız yok).
async function matchRefToBase(buf, base, { only = null } = {}) {
  const want = (k) => !only || only.includes(k);
  const t0 = Date.now();
  if (!base) return { buf, applied: false, steps: [], log: "base-yok" };
  try {
    const { data, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    let rgb = data;
    let ft = await featuresOf(rgb, W, H);
    if (!ft) return { buf, applied: false, steps: [], log: "selfie-ağ-yok" };
    const steps = [], log = [];
    // 1) Yan yatıklık.
    if (want("roll") && base.roll != null && ft.pose.roll != null) {
      const dRoll = base.roll - ft.pose.roll;
      if (Math.abs(dRoll) >= MIN_ROLL) {
        const r = clamp(dRoll, -MAX_ROLL, MAX_ROLL);
        const cx = (ft.mesh[33][0] + ft.mesh[263][0]) / 2, cy = (ft.mesh[33][1] + ft.mesh[263][1]) / 2;
        const rot = rotateAbout(rgb, W, H, cx, cy, -r);
        const ft2 = await featuresOf(rot, W, H);
        if (ft2) {
          log.push(`yatıklık ${ft.pose.roll.toFixed(1)}→${ft2.pose.roll.toFixed(1)} (base ${base.roll.toFixed(1)})`);
          rgb = rot; ft = ft2; steps.push("roll");
        }
      }
    }
    const dst = Buffer.from(rgb);
    // 2) Bakış — iki göz birlikte hareket eder; base'de güvenilir göz yoksa atlanır.
    const bn = base.near;
    const refEye = base.eyes[bn] && base.eyes[bn].ok ? bn : base.eyes[1 - bn] && base.eyes[1 - bn].ok ? 1 - bn : -1;
    if (!want("gaze")) {
      // atlandı
    } else if (base.gazeOk === false || !eyesAgree(ft.eyes)) {
      log.push(`bakış atlandı (iki göz çelişiyor: base ${base.eyes.map((e) => (e.ok ? e.u.toFixed(2) : "-")).join("/")} selfie ${ft.eyes.map((e) => (e.ok ? e.u.toFixed(2) : "-")).join("/")})`);
    } else if (refEye >= 0 && ft.eyes[refEye].ok) {
      const duRef = base.eyes[refEye].u - ft.eyes[refEye].u;
      const parts = [];
      for (let e = 0; e < 2; e++) {
        const se = ft.eyes[e];
        if (!se.ok && !se.follow) continue;
        const be = se.ok ? base.eyes[e] : { ok: false };
        // Güvenilir base gözü kendi hedefini verir; yön diğer gözle çelişirse yakın göz esas.
        let du = be.ok ? be.u - se.u : duRef;
        if (be.ok && Math.sign(du) !== Math.sign(duRef) && Math.abs(duRef) >= MIN_GAZE_SHIFT) du = duRef;
        du = clamp(du, -MAX_GAZE_SHIFT, MAX_GAZE_SHIFT);
        if (Math.abs(du) < MIN_GAZE_SHIFT) continue;
        if (shiftIris(rgb, dst, W, H, se.f, se.u, se.u + du)) parts.push(`göz${e} ${se.u.toFixed(2)}→${(se.u + du).toFixed(2)}`);
      }
      if (parts.length) { steps.push("gaze"); log.push(`bakış ${parts.join(" ")} (base ${base.eyes.map((e) => (e.ok ? e.u.toFixed(2) : "-")).join("/")})`); }
    }
    // 3) Kapak — yalnız base'den kısıksa açılır.
    if (want("lid")) {
      const src = Buffer.from(dst);
      const parts = [];
      for (let e = 0; e < 2; e++) {
        const se = ft.eyes[e], be = base.eyes[e].ok ? base.eyes[e] : base.eyes[bn];
        if (!se.f || se.w < MIN_EYE_PX || !(se.ap > 0) || !be || !(be.ap > 0)) continue;
        if (se.w < FAR_EYE_RATIO * Math.max(ft.eyes[0].w, ft.eyes[1].w)) continue;
        const lift = clamp((LID_TARGET * be.ap) / se.ap - 1, 0, MAX_LID_LIFT);
        if (lift < MIN_LID_LIFT) continue;
        if (liftEye(src, dst, W, H, ft.mesh, EYES[e], lift)) parts.push(`göz${e} ${se.ap.toFixed(2)}×${(1 + lift).toFixed(2)}`);
      }
      if (parts.length) { steps.push("lid"); log.push(`kapak ${parts.join(" ")} (base ${base.eyes.map((e) => e.ap.toFixed(2)).join("/")})`); }
    }
    // 4) Ağız köşesi — yalnız selfie base'den çok gülüyorsa iner.
    if (want("mouth") && base.smile != null && ft.mouth && ft.mouth.smile != null) {
      const drop = smileDrop(ft.mouth.smile, base.smile);
      if (drop > 0) {
        const src = Buffer.from(dst);
        if (dropCorners(src, dst, W, H, ft.mesh, ft.mouth, drop * ft.mouth.iod)) {
          steps.push("mouth");
          log.push(`ağız köşesi ${ft.mouth.smile.toFixed(3)}→${(ft.mouth.smile - drop).toFixed(3)} (base ${base.smile.toFixed(3)})`);
        }
      }
    }
    if (!steps.length) return { buf, applied: false, steps, log: log.length ? log.join("; ") : "uyumlu", ms: Date.now() - t0 };
    const out = await sharp(dst, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf: out, applied: true, steps, log: log.join("; "), ms: Date.now() - t0 };
  } catch (e) {
    console.error("Referans base'e uydurulamadı (olduğu gibi gidiyor):", e.message || e);
    return { buf, applied: false, steps: [], log: "hata" };
  }
}

/**
 * ÇIKTIDA AĞIZ KÖŞESİ (2026-11-01, kullanıcı: "kişiye gereksiz gülümseme
 * katma"): referans düzeltilse de model gülüş ekleyebilir. Köşe inişi düşük
 * çözünürlükte de temiz (yumuşak, geniş bükme; iris kaydırmasının aksine).
 * tpl: hizalı şablon. Döner { buf|null, applied, reason, smile, base, after }.
 */
async function lockMouthToBase(buf, tpl) {
  try {
    const ob = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tb = await sharp(tpl).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const [fo, fb] = await Promise.all([
      featuresOf(ob.data, ob.info.width, ob.info.height, { loose: true }),
      featuresOf(tb.data, tb.info.width, tb.info.height, { loose: true }),
    ]);
    if (!fo || !fb || !fo.mouth || !fb.mouth) return { buf: null, applied: false, reason: "no-mesh" };
    const drop = smileDrop(fo.mouth.smile, fb.mouth.smile);
    if (!(drop > 0)) return { buf: null, applied: false, reason: "no-smile", smile: fo.mouth.smile, base: fb.mouth.smile };
    const W = ob.info.width, H = ob.info.height;
    const dst = Buffer.from(ob.data);
    if (!dropCorners(Buffer.from(ob.data), dst, W, H, fo.mesh, fo.mouth, drop * fo.mouth.iod)) {
      return { buf: null, applied: false, reason: "no-pixels", smile: fo.mouth.smile, base: fb.mouth.smile };
    }
    const out = await sharp(dst, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf: out, applied: true, reason: null, smile: fo.mouth.smile, base: fb.mouth.smile, after: fo.mouth.smile - drop };
  } catch (e) {
    console.error("Ağız köşesi kilidi hata verdi (atlanıyor):", e.message || e);
    return { buf: null, applied: false, reason: "error" };
  }
}

module.exports = {
  baseFeatures,
  matchRefToBase,
  lockMouthToBase,
  _testables: { eyeFrame, irisU, smileOf, smileTarget, smileDrop, eyesAgree, EYE_DISAGREE_MAX, shiftIris, dropCorners, rotateAbout, reflect, IRIS_W, MAX_GAZE_SHIFT, MIN_GAZE_SHIFT, MAX_LID_LIFT, MAX_SMILE_DROP },
};
