// BUKLE KALINTISI (2026-10-26, iş 9987f742 c5, kullanıcı: "base fotonun
// saçından kalıntı kendi saçımla birleşmiş").
//
// SORUN: köprü şablonundaki kişinin ön üstteki halka buklesi (içinden gökyüzü
// görünüyor) modelin çizdiği saça eklenip teslim edildi; aynı şablonu
// kullanan arşiv işlerinde de var (3d1d2a71, a4433ad1, d0d4c001 c5). Bukle
// saç sınıfında, kişi maskesinde ve şablon kafasının içinde — kafa çevresi
// temizliği (headSurround) ona hiç dokunmuyor.
//
// ELENEN YOLLAR: şablonla yerel korelasyon (kaydırma aramalı, tekil tepe)
// bukleyi buluyor ama saçın üst katmanında da her işte tetikleniyor — model
// şablonun saç üstünü sık sık koruyor ve bu çoğu zaman kusur değil
// (29cf877a c3 kıvırcık kullanıcı); o bölgeyi doldurmak saçı düzleştirdi.
// Selfie saç yüksekliği bukleyi görmüyor (c5 0.50-0.54, selfie'lerle aynı).
// Bukle parçasını bütün olarak şablonda aramak tutmadı: model halkayı
// küçültüp yeniden çiziyor (NCC 0.69).
//
// ÇÖZÜM: kalıntıyı kusur yapan, saçın içinden arka planın görünmesi.
// (1) ŞABLON: kafa kenarına açılan, rengi yerel arka plana yakın büyük saç
//     deliği (halka) var mı — 103 arşiv karesinde yalnız bu şablonda ve bir
//     diğerinde (99bacae0 c1). Yoksa çıktıya hiç bakılmaz.
// (2) ÇIKTI: koyu saçla çevrili açık bölgeler (kapalı delik) ve halkanın ya
//     da seçilen deliklerin yakınındaki açık/yarı saydam saç pikselleri —
//     şablonda da bir deliğin yakınında olanlar.
// (3) DOLGU: yerel LaMa, TAM BAĞLAMLA (kafa maskelenmez): model halkayı
//     çevresindeki saçla kapatıyor. Kafa çevresindeki gibi arka planla
//     doldurmak saçta delik açtı. Yüz ovali, deri ve kaş altı dolmaz.
// Tetik şablona bağlı: kıvırcık kullanıcının kendi saç boşlukları
// (23579e24 c1/c9) ve saç parlamaları (3d1d2a71 c6, dd788c00 c3) halkasız
// şablonlarda olduğu için girmez — onlarda dolgu saçı düzleştiriyordu.

const sharp = require("sharp");
const { chamfer, faceOval, inPolygon, FACE_BOX_RX, FACE_BOX_RY } = require("./headSurround");

// Saç ile arka plan arasında bu kadar parlaklık farkı yoksa karar verilmez.
const MIN_CONTRAST = 50;
// Yarı saydam (açık) saç pikseli: L - Lsaç >= LIGHT_FRAC (Larka - Lsaç).
const LIGHT_FRAC = 0.35;
// Delik saç sınıfına bu kadar (yüz genişliğine oranla) yakın olmalı.
const HOLE_HAIR_REACH_FACE = 0.03;
// ŞABLON HALKASI: alan (yüz²), renk oranı (arka plana uzaklık / (arka plan +
// saç uzaklığı); 0 = arka plan rengi), dış arka plana uzaklık. Ölçülen:
// köprü şablonu 0.011-0.014 / 0.11-0.15 / 0; parlamalar oran 0.5-0.8,
// kıvırcık boşluklar içeride (0.08-0.13) ya da küçük.
const LOOP_MIN_FACE2 = 0.004;
const LOOP_MAX_RATIO = 0.3;
const LOOP_EDGE_FACE = 0.03;
// Delik renginin karşılaştırıldığı yerel arka plan/saç penceresi yarıçapı.
const COLOR_REACH_FACE = 0.15;
// Çıktı pikseli şablonun bir deliğine bu kadar yakın olmalı (kafa hizası
// kafayı 0.1 yüz genişliği kadar kaydırabiliyor; 9987f742 c5'te 12 px).
const TPL_NEAR_FACE = 0.12;
// Kapalı delik halkaya bu kadar yakın olmalı (bukle halkanın çevresinde).
const LOOP_REACH_FACE = 0.5;
// Açık/yarı saydam saç pikselleri: halkaya ya da seçilen kapalı deliğe bu
// kadar yakınsa (d0d4c001 c5: halkanın telleri gri, içi dışarıya açık —
// kapalı delik yalnız ortasını buldu, beyaz halka kaldı).
const LOOP_LIGHT_FACE = 0.15;
const HOLE_LIGHT_FACE = 0.1;
// Dolgu tohumdan bu kadar taşar (halkanın koyu telleri de kapansın) +
// yumuşak kenar.
const GROW_FACE = 0.05;
const FEATHER_PX = 2;
// Güvenlik: dolgu bundan büyükse yapılmaz (arşivde en çok 0.26).
const MAX_FILL_FACE2 = 0.4;

const median = (a) => Float64Array.from(a).sort()[a.length >> 1];

/**
 * Saçla çevrili açık bölgeler. L: parlaklık; hairP/bgP/skinP: sınıf
 * olasılıkları (skinP = yüz+vücut derisi+giysi); M: kişi maskesi; blocked:
 * bakılmayan pikseller (kaş altı, yüz ovali). Kesitin kenarından açık
 * piksellerle ulaşılamayan, saça yakın açık pikseller deliktir.
 * Dönüş { hole, Lh, Lb, skip }. SAF.
 */
function enclosedLight({ L, hairP, bgP, skinP, M, blocked, w, h, fw }) {
  const N = w * h;
  const hl = [];
  const bl = [];
  for (let i = 0; i < N; i++) {
    if (blocked[i]) continue;
    if (hairP[i] >= 0.8 && M[i] >= 0.8) hl.push(L[i]);
    else if (bgP[i] >= 0.8 && M[i] < 0.05) bl.push(L[i]);
  }
  const hole = new Uint8Array(N);
  if (hl.length < 50 || bl.length < 50) return { hole, skip: "no-ref" };
  const Lh = median(hl);
  const Lb = median(bl);
  // Açık zeminde koyu saç (koyu zeminde açık saçta delik ayırt edilemez).
  if (!(Lb - Lh >= MIN_CONTRAST)) return { hole, Lh, Lb, skip: "contrast" };
  const thr = (Lh + Lb) / 2;
  const bar = new Uint8Array(N);
  for (let i = 0; i < N; i++) bar[i] = L[i] < thr || skinP[i] >= 0.5 || blocked[i] ? 1 : 0;
  const out = new Uint8Array(N);
  const stack = [];
  const seed = (i) => { if (!bar[i] && !out[i]) { out[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && !bar[j] && !out[j]) { out[j] = 1; stack.push(j); }
    }
  }
  const dH = chamfer(Uint8Array.from(hairP, (v) => (v >= 0.5 ? 1 : 0)), w, h);
  const reach = HOLE_HAIR_REACH_FACE * fw;
  for (let i = 0; i < N; i++) if (!bar[i] && !out[i] && dH[i] <= reach) hole[i] = 1;
  return { hole, Lh, Lb };
}

/**
 * Delik bileşenleri ve halka ölçüleri. lab: Float32Array(N*3). Dönüş
 * [{ px, area (yüz²), edge (dış arka plana uzaklık / fw), ratio }]. SAF.
 */
function holeComponents({ hole, lab, hairP, bgP, w, h, fw }) {
  const N = w * h;
  const bg = Uint8Array.from(bgP, (v) => (v >= 0.9 ? 1 : 0));
  const dBg = chamfer(bg, w, h);
  const seen = new Uint8Array(N);
  const comps = [];
  const R = COLOR_REACH_FACE * fw;
  for (let s = 0; s < N; s++) {
    if (!hole[s] || seen[s]) continue;
    const px = [s];
    seen[s] = 1;
    for (let q = 0; q < px.length; q++) {
      const i = px[q];
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && hole[j] && !seen[j]) { seen[j] = 1; px.push(j); }
      }
    }
    let xs = 0, ys = 0, edge = Infinity;
    const m = [0, 0, 0];
    for (const i of px) {
      xs += i % w;
      ys += Math.floor(i / w);
      edge = Math.min(edge, dBg[i]);
      for (let c = 0; c < 3; c++) m[c] += lab[i * 3 + c];
    }
    const n = px.length;
    xs /= n; ys /= n;
    for (let c = 0; c < 3; c++) m[c] /= n;
    const sb = [0, 0, 0, 0], sh = [0, 0, 0, 0];
    for (let y = Math.max(0, Math.round(ys - R)); y < Math.min(h, ys + R); y++) {
      for (let x = Math.max(0, Math.round(xs - R)); x < Math.min(w, xs + R); x++) {
        const i = y * w + x;
        const acc = bgP[i] >= 0.9 ? sb : hairP[i] >= 0.9 ? sh : null;
        if (!acc) continue;
        acc[0]++;
        for (let c = 0; c < 3; c++) acc[c + 1] += lab[i * 3 + c];
      }
    }
    const dist = (a) => (a[0] ? Math.hypot(m[0] - a[1] / a[0], m[1] - a[2] / a[0], m[2] - a[3] / a[0]) : NaN);
    const dB = dist(sb);
    const dHr = dist(sh);
    comps.push({ px, area: n / (fw * fw), edge: edge / fw, ratio: dB / (dB + dHr) });
  }
  return comps;
}

/** Şablon halkası mı (bkz. LOOP_*). NaN oran (yakında arka plan yok) halka değil. SAF. */
const isLoop = (c) => c.area >= LOOP_MIN_FACE2 && c.ratio <= LOOP_MAX_RATIO && c.edge <= LOOP_EDGE_FACE;

/**
 * Dolgu tohumları. outHole/tplHole: kapalı delikler; loopMask: şablon halkası
 * pikselleri; light: açık saç pikseli; inHead: kişi ya da saç; allowed: kaş
 * üstü, deri/yüz ovali dışı. Dönüş { seed, holes, lights }. SAF.
 */
function selectSeeds({ outHole, tplHole, loopMask, light, inHead, allowed, w, h, fw }) {
  const N = w * h;
  const dT = chamfer(tplHole, w, h);
  const dL = chamfer(loopMask, w, h);
  const a = new Uint8Array(N);
  let holes = 0;
  for (let i = 0; i < N; i++) {
    if (outHole[i] && allowed[i] && dT[i] <= TPL_NEAR_FACE * fw && dL[i] <= LOOP_REACH_FACE * fw) { a[i] = 1; holes++; }
  }
  const dA = chamfer(a, w, h);
  const seed = Uint8Array.from(a);
  let lights = 0;
  for (let i = 0; i < N; i++) {
    if (a[i] || !allowed[i] || !inHead[i] || !light[i] || dT[i] > TPL_NEAR_FACE * fw) continue;
    if (dL[i] <= LOOP_LIGHT_FACE * fw || dA[i] <= HOLE_LIGHT_FACE * fw) { seed[i] = 1; lights++; }
  }
  return { seed, holes, lights };
}

/** Kesitin sınıf/maske/parlaklık/izin dizileri. */
async function analyzeCrop(rgb, w, h, fw, blocked) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { personMask } = require("./headScale");
  const { rgbToLab } = require("./skinTone");
  const P = await classProbs(rgb, w, h);
  const M = await personMask(rgb, w, h);
  const N = w * h;
  const L = new Float32Array(N);
  const lab = new Float32Array(N * 3);
  const skinP = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    const l = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2];
    skinP[i] = P[CLASSES.faceSkin][i] + P[CLASSES.bodySkin][i] + P[CLASSES.clothes][i];
  }
  const hairP = P[CLASSES.hair];
  const bgP = P[CLASSES.background];
  const lit = enclosedLight({ L, hairP, bgP, skinP, M, blocked, w, h, fw });
  return { P, CLASSES, M, L, lab, hairP, bgP, ...lit };
}

/** Kaş altı ve yüz ovali (68 nokta + kutu elipsi) kesit koordinatlarında. */
function blockedMask(lm, left, top, w, h) {
  const P = lm.pts;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y)) - top;
  const oval = faceOval(P);
  const b = lm.box;
  const ecx = b.x + b.width / 2, ecy = b.y + b.height / 2, erx = FACE_BOX_RX * b.width, ery = FACE_BOX_RY * b.height;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x + left, gy = y + top;
      if (y >= browY || ((gx - ecx) / erx) ** 2 + ((gy - ecy) / ery) ** 2 <= 1 || inPolygon(oval, gx, gy)) m[y * w + x] = 1;
    }
  }
  return m;
}

/**
 * Bukle kalıntısı dolgusunu hazırlar. buf: kafa çevresi bitmiş kare; tplBuf:
 * şablon (kareyle hizalı, bkz. templateHeadMaskFor). Dönüş { applied, reason,
 * loops, holes, lights, seedPx, holePx, fillFace2, outHolePx, tplHolePx,
 * inpaint{rect,job,base} }; dolgu lamaFill.finishInpaintLama(job, base) ile.
 */
async function prepareCurlRemnantFill(buf, tplBuf) {
  const { _rawRgb: rawRgb, _prepareInpaint: prepareInpaint } = require("./headScale");
  const { faceLandmarks } = require("./faceQuality");
  const o = await rawRgb(buf);
  const { W, H } = o;
  const tm = await sharp(tplBuf).metadata();
  const swapT = (tm.orientation || 1) >= 5;
  const tw = swapT ? tm.height : tm.width;
  const th = swapT ? tm.width : tm.height;
  if (Math.abs(W / H - tw / th) > 0.01 * (W / H)) return { applied: false, reason: "tpl-geometry" };
  const lo = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
  if (!lo) return { applied: false, reason: "no-face-output" };
  const P = lo.pts;
  const fw = Math.max(lo.box.width, Math.hypot(P[0].x - P[16].x, P[0].y - P[16].y));
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const left = Math.max(0, Math.round(cx - 1.5 * fw));
  const top = Math.max(0, Math.round(lo.box.y - 1.3 * fw));
  const w = Math.min(Math.round(3 * fw), W - left);
  const h = Math.min(Math.round(browY + 0.15 * fw) - top, H - top);
  if (w < 32 || h < 32) return { applied: false, reason: "tiny" };
  const N = w * h;
  const outBlocked = blockedMask(lo, left, top, w, h);

  // (1) ŞABLON: halka yoksa çıktıya bakılmaz.
  const tFull = await sharp(tplBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const trgb = await sharp(tFull, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width: w, height: h }).raw().toBuffer();
  let tplBlocked = outBlocked;
  const tl = await faceLandmarks(await sharp(trgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  if (tl) tplBlocked = blockedMask(tl, 0, 0, w, h);
  const T = await analyzeCrop(trgb, w, h, fw, tplBlocked);
  if (T.skip) return { applied: false, reason: `tpl-${T.skip}` };
  const tplHolePx = T.hole.reduce((s, v) => s + v, 0);
  const loops = holeComponents({ hole: T.hole, lab: T.lab, hairP: T.hairP, bgP: T.bgP, w, h, fw }).filter(isLoop);
  if (!loops.length) return { applied: false, reason: "no-loop", loops: 0, tplHolePx };
  const loopMask = new Uint8Array(N);
  for (const c of loops) for (const i of c.px) loopMask[i] = 1;

  // (2) ÇIKTI
  const orgb = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width: w, height: h }).raw().toBuffer();
  const O = await analyzeCrop(orgb, w, h, fw, outBlocked);
  if (O.skip) return { applied: false, reason: O.skip, loops: loops.length, tplHolePx };
  const outHolePx = O.hole.reduce((s, v) => s + v, 0);
  const light = new Uint8Array(N);
  const inHead = new Uint8Array(N);
  const allowed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    light[i] = O.L[i] - O.Lh >= LIGHT_FRAC * (O.Lb - O.Lh) ? 1 : 0;
    inHead[i] = O.M[i] >= 0.5 || O.hairP[i] >= 0.5 ? 1 : 0;
    allowed[i] = !outBlocked[i] && O.P[O.CLASSES.faceSkin][i] + O.P[O.CLASSES.bodySkin][i] < 0.5 ? 1 : 0;
  }
  const { seed, holes, lights } = selectSeeds({ outHole: O.hole, tplHole: T.hole, loopMask, light, inHead, allowed, w, h, fw });
  const seedPx = holes + lights;
  const base = { loops: loops.length, holes, lights, seedPx, outHolePx, tplHolePx };
  if (!seedPx) return { applied: false, reason: "clean", ...base };

  // (3) DOLGU MASKESİ: tohum + GROW_FACE, FEATHER_PX yumuşak kenar.
  const dS = chamfer(seed, w, h);
  const g = GROW_FACE * fw;
  const hole = new Uint8Array(W * H);
  const wgt = new Float32Array(W * H);
  let holePx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = dS[y * w + x];
      if (d > g + FEATHER_PX) continue;
      const gi = (y + top) * W + x + left;
      hole[gi] = 1;
      wgt[gi] = Math.min(1, (g + FEATHER_PX - d) / FEATHER_PX);
      holePx++;
    }
  }
  const fillFace2 = holePx / (fw * fw);
  if (fillFace2 > MAX_FILL_FACE2) return { applied: false, reason: "too-wide", ...base, holePx, fillFace2 };
  // Tam bağlam: kafa maskelenmez (job.headC yok), ton eşitleme ve geniş
  // bağlam kapalı — dolgu saç, çevresi de saç.
  const job = prepareInpaint(o.data, o.data, W, H, hole, new Uint8Array(W * H), wgt, null);
  job.out = null;
  job.ringOk = null;
  job.wide = false;
  return {
    applied: true, ...base, holePx, fillFace2,
    inpaint: { rect: { left: job.left, top: job.top, side: job.side }, job, base: buf },
  };
}

module.exports = { prepareCurlRemnantFill, enclosedLight, holeComponents, selectSeeds, isLoop };
