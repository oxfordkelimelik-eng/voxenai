// BAKIŞ KİLİDİ (2026-11-06, kullanıcı: "çıktı gözleri her zaman base ile aynı
// yere bakmalı"): çıktının KENDİ irisi, göz açıklığının içinde base'in aynı
// gözündeki iris konumuna kaydırılır (refMatch.shiftIris yöntemi: iris katı,
// sklera esner, kapaklar yerinde). Yeni piksel çizilmez, kimlik dokusu aynı.
//
// Ölçüm (scratchpad gaze/ deneyleri, 79 arşiv çifti + 215 şablon kırpımı):
// - Eski karanlık-profil iris ölçüsü (refMatch.irisU) iki göz arasında p90
//   0.51 çelişiyordu (c9 beyaz leke). KULLANILMAZ.
// - MediaPipe Iris (models/iris, Apache-2.0; 64×64 göz kırpımı, görüntü-sağ
//   göz aynalanır) 16 px gözde de 60 px'teki ölçüsünü tekrarlıyor (ortanca 0,
//   p90 ±0.03); yana bakan gözde iris yerini doğru buluyor.
// - u, MODELİN kendi kapak konturunun köşelerine göre: yüz ağının dış köşesi
//   gözün görünen ucunun dışına düşüyor ve kişiye göre değişiyor (p54 mavi göz
//   ters yöne itildi). Kontur u'sunda iki göz arası sabit ofset (~0.12) var;
//   base ve çıktı AYNI göz üzerinden karşılaştırıldığı için farkta düşer
//   (kalan saçılma ortanca 0.023, p90 0.065; ağ köşesiyle 0.059 / 0.21).
// - Baş dönükken iki göz aynı dönüşte farklı miktarda kayar (p74: yakın -0.07,
//   uzak -0.19) → her göz kendi base gözüne eşitlenir.
// - Yapay kaydırılmış gözde model kaymanın yarısını görüyor (kapak şekli
//   değişmiyor); bu bir ölçüm hatası DEĞİL, kazanç çarpanı uygulanmaz (×1.4
//   denemesi gözü zorladı).
// Base kameraya bakıyorsa baş dönüşü telafisi yapılmaz (p65). Kaydırma
// sonrası yeniden ölçülür; base'e yaklaşmadıysa geri alınır.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const DIR = path.join(__dirname, "models", "iris");
const S = 64;
const SCALES = [2.0, 2.3, 2.7];
const SHIFTS = [[0, 0], [0.08, 0], [-0.08, 0], [0, 0.08], [0, -0.08]];
// [köşe a, köşe b, ayna]: görüntü-sol göz (33/133) aynasız, görüntü-sağ göz (362/263) aynalı.
const EYE_CORNERS = [[33, 133, false], [362, 263, true]];
// Kontur içinde alt kapak 0..8 (uçlar köşe), üst kapak 9..15.
const C0 = 0, C8 = 8;
// Bu farkın altında dokunulmaz; göz başı en çok bu kadar kaydırılır (göz eni oranı).
const MIN_SHIFT = 0.05;
const MAX_SHIFT = 0.25;
// Base kameraya bakıyorsa küçük farklar ölçüm gürültüsü (A/B'de kötüleşen karelerin çoğu: p28, p72).
const MIN_SHIFT_CAMERA = 0.07;
// Göz bu kadar dar / kapalıysa ölçü güvenilmez.
const MIN_EYE_PX = 10;
const MIN_AP = 0.14;
// Baş dönüşü telafisi (derece başına u) ve sınırı; |Δyaw| bunun altındaysa yok.
const KAPPA = 0.005;
const COMP_MAX = 0.06;
const COMP_MIN_YAW = 5;
// Base kameraya bakıyor sayılır: iki göz de konturda merkeze bu kadar yakın
// (ofset göz başı: kontur ortası ~0.5±0.06).
const CAMERA_U_TOL = 0.08;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let _model = null;
function diskHandler(dir) {
  return {
    load: async () => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
      const specs = [], bufs = [];
      for (const g of m.weightsManifest) { specs.push(...g.weights); for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p))); }
      const all = Buffer.concat(bufs);
      return { modelTopology: m.modelTopology, format: m.format, weightSpecs: specs, weightData: all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength), signature: m.signature };
    },
  };
}
async function ensureModel() {
  if (!_model) {
    _model = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      if (tf.getBackend() !== "wasm") { await tf.setBackend("wasm"); await tf.ready(); }
      return { tf, model: await tf.loadGraphModel(diskHandler(DIR)) };
    })().catch((e) => { _model = null; throw e; });
  }
  return _model;
}

/** Döndürülmüş kare kırpım → 64×64, 0..1. SAF. */
function cropEye(rgb, W, H, box, flip) {
  const out = new Float32Array(S * S * 3);
  const k = box.size / S, c = Math.cos(box.ang), s = Math.sin(box.ang);
  for (let v = 0; v < S; v++) for (let u = 0; u < S; u++) {
    const uu = flip ? S - 1 - u : u;
    const du = (uu + 0.5 - S / 2) * k, dv = (v + 0.5 - S / 2) * k;
    const x = box.cx + du * c - dv * s - 0.5, y = box.cy + du * s + dv * c - 0.5;
    const x0 = Math.floor(x), fx = x - x0, y0 = Math.floor(y), fy = y - y0;
    for (let ch = 0; ch < 3; ch++) {
      let sm = 0;
      for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const xx = clamp(x0 + dx, 0, W - 1), yy = clamp(y0 + dy, 0, H - 1);
        sm += w * rgb[(yy * W + xx) * 3 + ch];
      }
      out[(v * S + u) * 3 + ch] = sm / 255;
    }
  }
  return out;
}
function toImg(box, u, v, flip) {
  const k = box.size / S, c = Math.cos(box.ang), s = Math.sin(box.ang);
  const uu = flip ? S - u : u;
  const du = (uu - S / 2) * k, dv = (v - S / 2) * k;
  return [box.cx + du * c - dv * s, box.cy + du * s + dv * c];
}
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * Bir göz: iris merkezi, yarıçapı ve kapak konturu (ölçek × kayma çoğaltmalı
 * ortanca; ayna yönü göze göre sabit — ters ayna konturu bozar).
 */
async function irisOfEye(rgb, W, H, mesh, [i0, i1, flip]) {
  const { tf, model } = await ensureModel();
  const a = mesh[i0], b = mesh[i1];
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(w > 0)) return null;
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (Math.abs(ang) > Math.PI / 2) ang += ang > 0 ? -Math.PI : Math.PI;
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const boxes = [];
  for (const sc of SCALES) for (const [sx, sy] of SHIFTS) boxes.push({ cx: cx + sx * w, cy: cy + sy * w, size: w * sc, ang });
  const arr = new Float32Array(boxes.length * S * S * 3);
  boxes.forEach((bx, i) => arr.set(cropEye(rgb, W, H, bx, flip), i * S * S * 3));
  const t = tf.tensor4d(arr, [boxes.length, S, S, 3]);
  const o = model.execute(t);
  t.dispose();
  const raw = await o.data();
  o.dispose();
  const cs = [], rs = [], k0 = [], k8 = [];
  boxes.forEach((bx, i) => {
    const off = i * 228;
    const P = (k) => toImg(bx, raw[off + k * 3], raw[off + k * 3 + 1], flip);
    const c = P(71);
    cs.push(c);
    let r = 0; for (let k = 72; k < 76; k++) { const p = P(k); r += Math.hypot(p[0] - c[0], p[1] - c[1]); }
    rs.push(r / 4);
    k0.push(P(C0)); k8.push(P(C8));
  });
  const med2 = (ps) => [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))];
  return { c: med2(cs), r: median(rs), A: med2(k0), B: med2(k8) };
}

/** Kontur köşelerine göre iris u'su (görüntüde soldan sağa) ve kontur eni. SAF. */
function contourU(c, A, B) {
  if (B[0] < A[0]) [A, B] = [B, A];
  const wc = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (!(wc > 0)) return null;
  return { u: ((c[0] - A[0]) * (B[0] - A[0]) + (c[1] - A[1]) * (B[1] - A[1])) / (wc * wc), wc };
}

/** Yüz ağı + iki göz ölçüsü. Ölçülemezse null. */
async function eyesOf(rgb, W, H) {
  const { faceLandmarks } = require("./faceQuality");
  const { denseMesh } = require("./faceMesh");
  const { poseFromMesh } = require("./headPose3d");
  const { eyeFrame } = require("./refMatch")._testables;
  const { EYES, eyeAperture } = require("./eyeOpen")._testables;
  const jpg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(jpg)) || (await faceLandmarks(jpg, 0.1));
  if (!lo) return null;
  const m = (await denseMesh(rgb, W, H, lo.pts)) || (await denseMesh(rgb, W, H, lo.pts, { agreeMax: 0.32, minScoreLoose: 0.9 }));
  if (!m) return null;
  const mesh = m.mesh;
  const eyes = [];
  for (let e = 0; e < 2; e++) {
    const f = eyeFrame(mesh, EYES[e]);
    const ir = f ? await irisOfEye(rgb, W, H, mesh, EYE_CORNERS[e]) : null;
    const cu = ir ? contourU(ir.c, ir.A, ir.B) : null;
    if (!f || !ir || !cu) { eyes.push({ ok: false }); continue; }
    // Kaydırma çerçevesi (refMatch.eyeFrame, köşe up[0]→up[son]) içinde iris merkezi.
    const uf = ((ir.c[0] - f.ax) * f.ex + (ir.c[1] - f.ay) * f.ey) / f.w;
    const ap = eyeAperture(mesh, EYES[e]).ap;
    eyes.push({ ok: f.w >= MIN_EYE_PX && ap >= MIN_AP, f, w: f.w, ap, u: cu.u, wc: cu.wc, uf, r: ir.r });
  }
  return { mesh, pose: poseFromMesh(mesh), eyes };
}

/**
 * Göz başı kaydırma (kontur u'su). b, o: eyesOf() çıktısı. SAF.
 * Döner { du: [göz0, göz1] | null, comp, camera, reason }.
 */
function planShift(b, o) {
  const okBoth = [0, 1].map((i) => b.eyes[i].ok && o.eyes[i].ok);
  if (!okBoth[0] && !okBoth[1]) return { du: null, reason: "göz-yok" };
  // Base kameraya bakıyor mu: iki gözün kontur u'larının ortası merkezde.
  const bu = b.eyes.filter((e) => e.ok).map((e) => e.u);
  const camera = bu.length === 2 && Math.abs((bu[0] + bu[1]) / 2 - 0.5) <= CAMERA_U_TOL;
  const dy = (o.pose.yaw || 0) - (b.pose.yaw || 0);
  const comp = !camera && Math.abs(dy) >= COMP_MIN_YAW ? clamp(-KAPPA * dy, -COMP_MAX, COMP_MAX) : 0;
  let du = [0, 1].map((i) => (okBoth[i] ? clamp(b.eyes[i].u - o.eyes[i].u + comp, -MAX_SHIFT, MAX_SHIFT) : null));
  // Tek göz ölçüldüyse öbürü onu izler (şaşılık olmasın); izleyen göz çıktıda görünür olmalı.
  if (du[0] == null || du[1] == null) {
    const ref = du[0] != null ? du[0] : du[1];
    du = du.map((x, i) => (x != null ? x : (o.eyes[i].f && o.eyes[i].w >= 6 ? ref : 0)));
  }
  // İki göz zıt yöne itilecekse ölçü güvenilmez (bakış iki gözde aynı yöne döner).
  if (Math.abs(du[0]) >= MIN_SHIFT && Math.abs(du[1]) >= MIN_SHIFT && Math.sign(du[0]) !== Math.sign(du[1])) {
    return { du: null, comp, camera, reason: "gözler-çelişiyor" };
  }
  const minS = camera ? MIN_SHIFT_CAMERA : MIN_SHIFT;
  if (du.every((x) => Math.abs(x) < minS)) return { du: null, comp, camera, reason: "uyumlu" };
  return { du, comp, camera, reason: null };
}

/** refMatch.shiftIris, yarı iris eni h ölçülen yarıçaptan. src → dst. SAF. */
function shiftIrisH(src, dst, W, H, f, u0, u1, h) {
  const { interp } = require("./eyeOpen")._testables;
  u1 = clamp(u1, h + 0.02, 1 - h - 0.02);
  u0 = clamp(u0, h + 0.02, 1 - h - 0.02);
  if (Math.abs(u1 - u0) < 1e-3) return 0;
  const ko = [0, u1 - h, u1 + h, 1], ks = [0, u0 - h, u0 + h, 1];
  const inv = (u) => {
    for (let i = 1; i < 4; i++) if (u <= ko[i]) return ks[i - 1] + ((u - ko[i - 1]) / Math.max(1e-6, ko[i] - ko[i - 1])) * (ks[i] - ks[i - 1]);
    return 1;
  };
  const toXY = (u, v) => [f.ax + u * f.w * f.ex + v * f.nx, f.ay + u * f.w * f.ey + v * f.ny];
  const sample = (x, y, c) => {
    const X = clamp(x, 0, W - 1.001), Y = clamp(y, 0, H - 1.001);
    const ix = X | 0, iy = Y | 0, fx = X - ix, fy = Y - iy, i = (iy * W + ix) * 3 + c;
    return (src[i] * (1 - fx) + src[i + 3] * fx) * (1 - fy) + (src[i + W * 3] * (1 - fx) + src[i + W * 3 + 3] * fx) * fy;
  };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of [...f.U, ...f.L]) { const [x, y] = toXY(p[0], p[1]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let moved = 0;
  for (let y = Math.max(0, Math.floor(y0 - 1)); y <= Math.min(H - 1, Math.ceil(y1 + 1)); y++) {
    for (let x = Math.max(0, Math.floor(x0 - 1)); x <= Math.min(W - 1, Math.ceil(x1 + 1)); x++) {
      const u = ((x - f.ax) * f.ex + (y - f.ay) * f.ey) / f.w;
      if (u <= 0 || u >= 1) continue;
      const v = (x - f.ax) * f.nx + (y - f.ay) * f.ny;
      const Uu = interp(f.U, u), ap = interp(f.L, u) - Uu;
      if (ap <= 1) continue;
      const t = (v - Uu) / ap, edge = Math.min(t, 1 - t) * ap;
      if (edge <= 0) continue;
      const wgt = Math.min(1, edge / Math.max(1.5, 0.08 * ap));
      const us = inv(u), Us = interp(f.U, us), Ls = interp(f.L, us);
      const [sx, sy] = toXY(us, Us + t * (Ls - Us));
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) dst[o + c] = Math.round(src[o + c] * (1 - wgt) + sample(sx, sy, c) * wgt);
      moved++;
    }
  }
  return moved;
}

/**
 * Çıktının bakışını base'e kilitler. out, tpl: görüntü tamponları (aynı kadraj
 * gerekmez). templateEyewear: şablonda gözlük varsa atlanır (göz camın
 * arkasında; gözlük teslimden önce ayrıca eklenir).
 * Döner { buf|null, applied, reason, base, before, after, du, comp, ms }.
 */
async function lockGazeToBase(out, tpl, { templateEyewear = false } = {}) {
  const t0 = Date.now();
  const res = (o) => ({ buf: null, applied: false, ms: Date.now() - t0, ...o });
  if (templateEyewear) return res({ reason: "şablon-gözlük" });
  try {
    const [O, B] = await Promise.all([out, tpl].map((x) => sharp(x).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    const W = O.info.width, H = O.info.height;
    const b = await eyesOf(B.data, B.info.width, B.info.height);
    if (!b) return res({ reason: "base-ölçülemedi" });
    const o = await eyesOf(O.data, W, H);
    if (!o) return res({ reason: "çıktı-ölçülemedi" });
    const us = (x) => x.eyes.map((e) => (e.ok ? e.u : null));
    const plan = planShift(b, o);
    const info = { base: us(b), before: us(o), comp: plan.comp, camera: plan.camera };
    if (!plan.du) return res({ reason: plan.reason, ...info });
    const dst = Buffer.from(O.data);
    let moved = 0;
    for (let e = 0; e < 2; e++) {
      const oe = o.eyes[e];
      if (!oe.f || Math.abs(plan.du[e]) < MIN_SHIFT * 0.6) continue;
      // Kontur birimi → kaydırma çerçevesi birimi; çerçeve yönü görüntü yönünün tersi olabilir.
      const dM = (plan.du[e] * (oe.wc || oe.w)) / oe.w;
      const h = clamp((oe.r / oe.w) * 1.1, 0.14, 0.24);
      moved += shiftIrisH(O.data, dst, W, H, oe.f, oe.uf, oe.uf + (oe.f.ex >= 0 ? dM : -dM), h);
    }
    if (!moved) return res({ reason: "piksel-yok", du: plan.du, ...info });
    // Doğrulama: yeniden ölç; fark küçülmediyse ya da artık büyükse geri al.
    const a = await eyesOf(dst, W, H);
    const after = a ? us(a) : [null, null];
    for (let e = 0; e < 2; e++) {
      if (info.base[e] == null || info.before[e] == null || after[e] == null) continue;
      const d0 = Math.abs(info.base[e] + plan.comp - info.before[e]), d1 = Math.abs(info.base[e] + plan.comp - after[e]);
      // Yalnız yön/bozulma kontrolü: model kaydırılmış gözde kaymanın ~yarısını
      // görüyor (sentetik ölçüm), artık eşiği konmaz.
      if (d1 > d0 + 0.01) return res({ reason: "doğrulama", du: plan.du, after, ...info });
    }
    const buf = await sharp(dst, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    return { buf, applied: true, reason: null, du: plan.du, after, ...info, ms: Date.now() - t0 };
  } catch (e) {
    console.error("Bakış kilidi hata verdi (atlanıyor):", e.message || e);
    return res({ reason: "hata" });
  }
}

module.exports = {
  lockGazeToBase,
  _testables: { planShift, contourU, shiftIrisH, MIN_SHIFT, MIN_SHIFT_CAMERA, MAX_SHIFT, KAPPA, CAMERA_U_TOL },
};
