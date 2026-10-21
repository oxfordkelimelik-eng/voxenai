"use strict";
/**
 * KIYAFET RENGİ ŞABLONDAN (2026-10-20, 7c17ea3f c3, kullanıcı: "kıyafet rengi
 * değişmiş"). Model kıyafeti şablondakinden farklı renkte çizebiliyor: c3'te
 * açık kahve takım (Lab 23/9/17) koyu kızıl kahveye (14/9/10), beyaz gömlek
 * pembeye (66/5/7 → 56/14/2) döndü. Kıyafet şablondaki gibi kalmalı.
 *
 * Yöntem: çıktının kıyafet pikselleri KENDİ renklerine göre kümelenir (takım,
 * gömlek, ...) — atama çıktının rengiyle olduğu için kenar ve doku bozulmaz,
 * şablonla piksel hizası yalnız kümenin hedef rengini ölçmekte kullanılır.
 * Her kümenin hedefi: aynı yerlerde şablonun kıyafet piksellerinin ortanca
 * Lab'ı. Fark eşiği aşan kümeye Lab'da toplamsal kayma uygulanır (dokuyu
 * korur), yumuşak üyelikle (renk uzaklığı) ve kıyafet olasılığıyla.
 * Şablon siyah-beyazsa dokunulmaz (siyah-beyaz son geçişi zaten griler).
 */
const sharp = require("sharp");
const { rgbToLab, labToRgb } = require("./skinTone");

// Segmentasyon ve kümeleme bu genişlikte.
const WORK = 1024;
const CLOTH_P = 0.6;
const K = 3;
const KMEANS_ITERS = 10;
// Küme kıyafet pikselinin bu payından küçükse kayma almaz.
const MIN_SHARE = 0.04;
// Kümenin bu payı şablonda da kıyafet değilse (poz farkı) hedef ölçülmez.
const OVERLAP_MIN = 0.6;
const MIN_PX = 2000;
// Bu kadardan (Lab dE) küçük fark dokunulmaz — model kıyafeti korumuş.
const DE_MIN = 6;
// Kayma tavanları (Lab birimi).
const L_MAX = 14;
const AB_MAX = 12;
// Yumuşak üyelik: renk uzaklığı (Lab) ölçeği.
const SOFT = 10;
// Uygulama maskesinin yumuşatılması (çalışma genişliğinin payı).
const MASK_BLUR = 0.006;
// Şablonun kıyafet kroması bundan azsa siyah-beyaz sayılır.
const BW_CHROMA = 3;

function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
}

/** Lab noktaları üzerinde k-ortalamalar; L çeyreklikleriyle belirli başlangıç. SAF. */
function kmeansLab(L, A, B, k = K, iters = KMEANS_ITERS) {
  const n = L.length;
  const order = Array.from(L.keys()).sort((i, j) => L[i] - L[j]);
  const C = [];
  for (let j = 0; j < k; j++) { const i = order[Math.floor(((j + 0.5) / k) * n)]; C.push([L[i], A[i], B[i]]); }
  const lab = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const S = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const d = (L[i] - C[j][0]) ** 2 + (A[i] - C[j][1]) ** 2 + (B[i] - C[j][2]) ** 2; if (d < bd) { bd = d; best = j; } }
      lab[i] = best; S[best][0] += L[i]; S[best][1] += A[i]; S[best][2] += B[i]; S[best][3]++;
    }
    for (let j = 0; j < k; j++) if (S[j][3]) C[j] = [S[j][0] / S[j][3], S[j][1] / S[j][3], S[j][2] / S[j][3]];
  }
  return { centers: C, labels: lab };
}

/**
 * Kümelerin kaymasını planlar. lo/lt: örnek piksellerin çıktı/şablon Lab'ı
 * ([L[], A[], B[]]), tplCloth: o pikselde şablon kıyafet mi. SAF.
 * Döner { centers, shifts: [[dL,da,db]|null], info: [...] }.
 */
function planClothShift(lo, lt, tplCloth) {
  const n = lo[0].length;
  const { centers, labels } = kmeansLab(lo[0], lo[1], lo[2]);
  const shifts = [], info = [];
  for (let j = 0; j < centers.length; j++) {
    const oL = [], oA = [], oB = [], tL = [], tA = [], tB = [];
    let nj = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== j) continue;
      nj++;
      if (!tplCloth[i]) continue;
      oL.push(lo[0][i]); oA.push(lo[1][i]); oB.push(lo[2][i]);
      tL.push(lt[0][i]); tA.push(lt[1][i]); tB.push(lt[2][i]);
    }
    const share = nj / n, overlap = nj ? oL.length / nj : 0;
    if (share < MIN_SHARE || overlap < OVERLAP_MIN) { shifts.push(null); info.push({ share, overlap, reason: share < MIN_SHARE ? "small" : "no-overlap" }); continue; }
    const d = [median(tL) - median(oL), median(tA) - median(oA), median(tB) - median(oB)];
    const dE = Math.hypot(...d);
    if (dE < DE_MIN) { shifts.push(null); info.push({ share, overlap, dE, reason: "close" }); continue; }
    const s = [Math.max(-L_MAX, Math.min(L_MAX, d[0])), Math.max(-AB_MAX, Math.min(AB_MAX, d[1])), Math.max(-AB_MAX, Math.min(AB_MAX, d[2]))];
    shifts.push(s); info.push({ share, overlap, dE, shift: s });
  }
  return { centers, shifts, info };
}

/**
 * Kıyafet rengini şablona döndürür. Döner { buf|null, applied, reason, info }.
 */
async function restoreClothColor(outBuf, tplBuf) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const o = await sharp(outBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const w = Math.min(WORK, W), h = Math.max(1, Math.round((H * w) / W));
  const os = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const ts = await sharp(tplBuf).rotate().removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const Po = await classProbs(os, w, h);
  const co = Po[CLASSES.clothes];
  const ct = (await classProbs(ts, w, h))[CLASSES.clothes];
  // Uygulama maskesi: KİŞİ maskesinin (headScale.personMask) deri ve saç
  // olmayan kısmı, uzamsal yumuşatılmış. Kıyafet sınıfı gölgedeki paçayı
  // arka plan sandı ve eşik kenarı keskin basamak bıraktı (7c17ea3f c3).
  // Hangi rengin kayacağına renk üyeliği karar verir; arka plana taşan kısım
  // arka plan geri yüklemede şablondan gelir.
  const { personMask } = require("./headScale");
  const Mp = await personMask(os, w, h);
  const wear = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const body = Po[CLASSES.hair][i] + Po[CLASSES.bodySkin][i] + Po[CLASSES.faceSkin][i];
    wear[i] = Math.max(0, Math.min(1, Mp[i] * (1 - body)));
  }

  const lo = [[], [], []], lt = [[], [], []], tplCloth = [];
  let chroma = 0, cn = 0;
  for (let i = 0; i < w * h; i++) {
    if (co[i] < CLOTH_P) continue;
    const a = rgbToLab(os[i * 3], os[i * 3 + 1], os[i * 3 + 2]);
    const b = rgbToLab(ts[i * 3], ts[i * 3 + 1], ts[i * 3 + 2]);
    for (let c = 0; c < 3; c++) { lo[c].push(a[c]); lt[c].push(b[c]); }
    const isT = ct[i] >= CLOTH_P;
    tplCloth.push(isT);
    if (isT) { chroma += Math.hypot(b[1], b[2]); cn++; }
  }
  if (lo[0].length < MIN_PX) return { buf: null, applied: false, reason: "no-clothes", info: null };
  if (cn && chroma / cn < BW_CHROMA) return { buf: null, applied: false, reason: "grayscale", info: null };
  const plan = planClothShift(lo, lt, tplCloth);
  if (!plan.shifts.some(Boolean)) return { buf: null, applied: false, reason: "close", info: plan.info };

  // Tam çözünürlükte uygula. Kıyafet olasılığı tek kanal büyütülür
  // (sharp-mask-channel-trap: extractChannel(0)).
  const m8 = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) m8[i] = Math.round(wear[i] * 255);
  const big = await sharp(m8, { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.5, MASK_BLUR * w))
    .resize(W, H, { fit: "fill", kernel: "linear" }).extractChannel(0).raw().toBuffer();
  const out = Buffer.from(o.data);
  const ramp = (v) => (v <= 0.2 ? 0 : v >= 0.6 ? 1 : (v - 0.2) / 0.4);
  let changed = 0;
  for (let i = 0; i < W * H; i++) {
    const m = ramp(big[i] / 255);
    if (m <= 0) continue;
    const p = i * 3;
    const lab = rgbToLab(out[p], out[p + 1], out[p + 2]);
    let ws = 0, sL = 0, sA = 0, sB = 0, dmin = Infinity;
    for (let j = 0; j < plan.centers.length; j++) {
      const c = plan.centers[j];
      const d2 = (lab[0] - c[0]) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2;
      dmin = Math.min(dmin, d2);
      const wj = Math.exp(-d2 / (2 * SOFT * SOFT));
      ws += wj;
      const s = plan.shifts[j];
      if (s) { sL += wj * s[0]; sA += wj * s[1]; sB += wj * s[2]; }
    }
    if (ws < 1e-6) continue;
    // Hiçbir kümeye benzemeyen renk (aksesuar, desen) az kayar.
    const far = Math.exp(-dmin / (2 * (3 * SOFT) ** 2));
    const k = (m * far) / ws;
    if (k * Math.hypot(sL, sA, sB) < 0.5) continue;
    const rgb = labToRgb(lab[0] + k * sL, lab[1] + k * sA, lab[2] + k * sB);
    out[p] = rgb[0]; out[p + 1] = rgb[1]; out[p + 2] = rgb[2];
    changed++;
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, info: plan.info, changedPx: changed };
}

module.exports = { restoreClothColor, _testables: { kmeansLab, planClothShift, DE_MIN } };
