// ŞABLON ŞAPKA DETEKTÖRÜ (2026-11-06) — üretimden ÖNCE, şablon başına bir kez:
// "base'deki kişi şapka/kep/bere takıyor mu". Ücretsiz, yerel. Sonuç yalnız
// prompt seçer (naturalSwap.buildSelfieSetPrompt {hat}); hat=false iken prompt
// bugünküyle bayt bayt aynıdır, yani yanlış "yok" kararı bugünkü davranıştır.
//
// NEDEN: gpt-image-2 şablonun şapkasını düşürüyor (6 karede 1 kaldı; 11-03
// selfie seti promptunda 3/3 düştü; ikisinde yarı saydam şapka izi, 0eeb c10'da
// kep logosu alna basılıp teslim edildi). Prompt "ilk kişinin saç modelinden
// hiçbir şey kalmasın" ve "ilk kişinin saçının uzandığı yere arka planı sürdür"
// diyor; şapka çizgisi eski kafa çizgisi olduğu için model onu siliyor.
//
// KURAL = iki bağımsız yargının VE'si (152 base, gözle sayım 6 şapka / 4 ayrı
// şablon; fix7/hat incelemesi):
// 1) skinSeg 'others' sınıfı kaş üstünde, kafaya bağlı, ≥ HAT_MIN_FACE2 yüz².
//    Tek başına 9 aday, 3'ü yanlış (kulak üstü kulaklık ×2, çıplak kafa ×1).
// 2) OWLv2 sıfır-atış "hat/cap/beanie/beret/baseball cap" kutusu gözlerin
//    üstünde, kafa boyunda, skor ≥ OWL_MIN ve aynı kutunun "hair" skorundan
//    yüksek. Tek başına 7 aday, 1'i yanlış (ca61 c8 koyu saç).
// VE: 6/6 şapka, 146 şapkasız base'de 0 yanlış.
//
// GÖZLÜK HARİÇ (inceleme şartı): skinSeg'de gözlük sınıfı yok, gözlük de
// 'others'. Eski kural maskeyi kaş + 0.2·(çene−kaş)'a kadar alıyordu; gözlüklü
// şapkasız base'ler eşiğin hemen altındaydı (9c8f2cb5 c0 0.148, 3b4f51cb c2
// 0.146). Maske artık kaşların en üst noktasında kesilir: gözlük çerçevesi
// kaşın üstüne çıkmaz, şapka alanı ise kaş üstündedir.
//
// SIRA (maliyet): yüz noktaları + tek segmentasyon önce; alan eşiği geçilmezse
// OWLv2 hiç çalışmaz (base'lerin ~%94'ü burada çıkar). OWLv2 oturumu
// ghostDetect'inkidir (aynı model, aynı worker, ek bellek yok, arena kapalı).
//
// Yalnız worker iş parçacığında çağrılır (postTasks.templateHat): onnxruntime
// run() olay döngüsünü bloklar.

const sharp = require("sharp");

const SEG_MIN = 0.5;
const HAT_MIN_FACE2 = 0.15;
// Segmentasyon kesiti: yüz genişliğinin katı (kare), tepesi kutunun bu kadar üstü.
const CROP_SIDE_FACE = 4.4;
const CROP_UP_FACE = 1.9;
// Bileşen süzgeci (bkz. fix7/hat/hatRestore.js): en küçük parça, yüzden yana taşma,
// kaş üstüne uzanım (çene−kaş cinsinden).
const COMP_MIN_FACE2 = 0.02;
const COMP_SIDE_FACE = 0.3;
const COMP_UP_HF = 1.3;

// OWLv2 (bkz. earbudCore.js, ghostDetect.js): CLIP BPE tek parça token'lar.
const OWL_SIZE = 960;
const OWL_SEQ = 16;
const OWL_MEAN = [0.48145466, 0.4578275, 0.40821073];
const OWL_STD = [0.26862954, 0.26130258, 0.27577711];
const OWL_QUERIES = {
  hat: [3801], cap: [3938], beanie: [21534], beret: [41658], "baseball cap": [3470, 3938],
  helmet: [11122], hood: [3222], headphones: [14906], hair: [2225], face: [1710],
};
const OWL_NAMES = Object.keys(OWL_QUERIES);
const OWL_HAT = ["hat", "cap", "beanie", "beret", "baseball cap"];
// Yüz kutusu × bu kat kırpım, merkezi kutu yüksekliğinin bu payında.
const OWL_CROP_FACE = 2.8;
const OWL_CROP_CY = 0.3;
const OWL_MIN = 0.15;

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const faceWidth = (lm) => Math.max(lm.box.width, Math.hypot(lm.pts[0].x - lm.pts[16].x, lm.pts[0].y - lm.pts[16].y));

/** Şablon yüz noktalarından segmentasyon kesiti {left, top, side, fw}. SAF. */
function segCrop(lm, W, H) {
  const fw = faceWidth(lm);
  const cx = lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const side = Math.min(W, H, Math.round(CROP_SIDE_FACE * fw));
  return { left: clampI(cx - side / 2, 0, W - side), top: clampI(lm.box.y - CROP_UP_FACE * fw, 0, H - side), side, fw };
}

/**
 * Kesitte şapka maskesi. P: classProbs (kesit çözünürlüğünde), CL: CLASSES,
 * pts: kesit koordinatında 68 nokta, fw: yüz genişliği (px). SAF.
 * Döner { mask (Uint8Array side²), px, area (yüz²) }.
 */
function hatMaskFromProbs(P, CL, pts, fw, side) {
  const n = side * side;
  // Kaş çizgisinde kes: gözlük maskeye girmesin (bkz. GÖZLÜK HARİÇ).
  const browT = Math.min(...pts.slice(17, 27).map((p) => p.y));
  const chinT = pts[8].y, hfT = Math.max(1, chinT - browT);
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const y = (i / side) | 0;
    if (y > browT) continue;
    if (P[CL.others][i] >= SEG_MIN && P[CL.bodySkin][i] < SEG_MIN && P[CL.clothes][i] < SEG_MIN) raw[i] = 1;
  }
  const fx0 = Math.min(pts[0].x, pts[16].x), fx1 = Math.max(pts[0].x, pts[16].x);
  // Bağlı bileşenler (4-komşu); kafaya yakın olanlar kalır.
  const lab = new Int32Array(n).fill(-1);
  const keep = [];
  const st = [];
  for (let i = 0; i < n; i++) {
    if (!raw[i] || lab[i] >= 0) continue;
    const id = keep.length;
    let c = 0, x0 = side, x1 = -1, y1 = -1;
    lab[i] = id; st.push(i);
    while (st.length) {
      const j = st.pop(); c++;
      const x = j % side, y = (j - x) / side;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > y1) y1 = y;
      if (x > 0 && raw[j - 1] && lab[j - 1] < 0) { lab[j - 1] = id; st.push(j - 1); }
      if (x < side - 1 && raw[j + 1] && lab[j + 1] < 0) { lab[j + 1] = id; st.push(j + 1); }
      if (y > 0 && raw[j - side] && lab[j - side] < 0) { lab[j - side] = id; st.push(j - side); }
      if (y < side - 1 && raw[j + side] && lab[j + side] < 0) { lab[j + side] = id; st.push(j + side); }
    }
    keep.push(c >= COMP_MIN_FACE2 * fw * fw && x1 >= fx0 - COMP_SIDE_FACE * fw && x0 <= fx1 + COMP_SIDE_FACE * fw && y1 >= browT - COMP_UP_HF * hfT);
  }
  const mask = new Uint8Array(n);
  let px = 0;
  for (let i = 0; i < n; i++) if (lab[i] >= 0 && keep[lab[i]]) { mask[i] = 1; px++; }
  return { mask, px, area: px / (fw * fw) };
}

/**
 * OWLv2 kutularından şapka kararı. boxes: kırpım uzayında {cx,cy,w,h (0..1), s}
 * (s: sorgu → sigmoid). crop: {left, top, side}; pts: tam kare noktaları. SAF.
 * Döner { score, hair, q, ok } — KABUL EDİLEN (skor ≥ OWL_MIN ve aynı kutunun saç
 * skorundan yüksek) en yüksek şapka kutusu; hiçbiri kabul edilmediyse ok=false ve
 * log için en yüksek kutu. (2026-11-06 inceleme: yalnız en yüksek kutunun saçına
 * bakmak, saçı yüksek bir kutunun arkasında kalan geçerli kutuyu kaçırıyordu.)
 */
function owlHatDecision(boxes, crop, pts) {
  const eyeY = (pts[36].y + pts[45].y) / 2;
  const fx0 = Math.min(pts[0].x, pts[16].x), fx1 = Math.max(pts[0].x, pts[16].x), fw = fx1 - fx0;
  let best = { score: 0, hair: null, q: null, ok: false };
  for (const b of boxes) {
    const hs = Math.max(...OWL_HAT.map((q) => b.s[q] || 0));
    const cx = crop.left + b.cx * crop.side, cy = crop.top + b.cy * crop.side;
    const bw = b.w * crop.side, bh = b.h * crop.side;
    if (cy > eyeY) continue; // kafa üstü
    if (cx < fx0 - 0.5 * fw || cx > fx1 + 0.5 * fw) continue;
    if (bw < 0.5 * fw || bw > 3 * fw) continue; // kafa boyu
    if (cy + bh / 2 < eyeY - 1.2 * fw) continue;
    const ok = hs >= OWL_MIN && !(b.s.hair != null && hs <= b.s.hair);
    if ((ok && !best.ok) || (ok === best.ok && hs > best.score)) best = { score: hs, hair: b.s.hair, q: OWL_HAT.find((q) => b.s[q] === hs), ok };
  }
  return best;
}

async function owlBoxes(rgb960) {
  const { owlSession } = require("./ghostDetect");
  const { ort, s } = await owlSession();
  const N = OWL_SIZE * OWL_SIZE;
  const pv = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) pv[c * N + i] = (rgb960[i * 3 + c] / 255 - OWL_MEAN[c]) / OWL_STD[c];
  const nq = OWL_NAMES.length;
  const ids = new BigInt64Array(nq * OWL_SEQ), mask = new BigInt64Array(nq * OWL_SEQ);
  OWL_NAMES.forEach((nm, q) => { [49406, ...OWL_QUERIES[nm], 49407].forEach((v, i) => { ids[q * OWL_SEQ + i] = BigInt(v); mask[q * OWL_SEQ + i] = 1n; }); });
  const out = await s.run({
    input_ids: new ort.Tensor("int64", ids, [nq, OWL_SEQ]),
    attention_mask: new ort.Tensor("int64", mask, [nq, OWL_SEQ]),
    pixel_values: new ort.Tensor("float32", pv, [1, 3, OWL_SIZE, OWL_SIZE]),
  });
  const L = out.logits.data, B = out.pred_boxes.data, np = out.logits.dims[1];
  const res = [];
  for (let p = 0; p < np; p++) {
    const s2 = {};
    for (let q = 0; q < nq; q++) s2[OWL_NAMES[q]] = 1 / (1 + Math.exp(-L[p * nq + q]));
    res.push({ cx: B[p * 4], cy: B[p * 4 + 1], w: B[p * 4 + 2], h: B[p * 4 + 3], s: s2 });
  }
  return res;
}

/** Şapka kutusu skoru (OWLv2). J: JPEG, lm: J'nin yüz noktaları. */
async function owlHatScore(J, lm, W, H) {
  const b = lm.box;
  const side = Math.min(W, H, Math.round(OWL_CROP_FACE * Math.max(b.width, b.height)));
  const left = clampI(b.x + b.width / 2 - side / 2, 0, W - side);
  const top = clampI(b.y + b.height * OWL_CROP_CY - side / 2, 0, H - side);
  const rgb = await sharp(J).extract({ left, top, width: side, height: side }).removeAlpha()
    .resize(OWL_SIZE, OWL_SIZE, { fit: "fill", kernel: "cubic" }).raw().toBuffer();
  return owlHatDecision(await owlBoxes(new Uint8Array(rgb)), { left, top, side }, lm.pts);
}

/**
 * Şablon görüntüsünün şapka maskesi (tam kare koordinatında kesit).
 * Döner { J, W, H, lm, crop, mask, px, area } ya da { reason }.
 */
async function templateHatMask(buf) {
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { data, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Döndürme gerekmeyen JPEG'in kendi baytları (yeniden kodlama ana yüzün skorunu
  // eşiğin altına itebiliyor: kırpılmış 7e04933e c1 şablonunda 0.355 → 0.347).
  const meta = await sharp(buf).metadata();
  const J = meta.format === "jpeg" && !(meta.orientation > 1) ? buf
    : await sharp(data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  // DÜŞÜK GÜVEN, EN BÜYÜK YÜZ: dönük şablonda ana yüz 0.35 eşiğinin hemen
  // üstünde/altında kalıyor; varsayılan eşikte arka plandaki küçük yüz seçildi
  // (7e04933e c1 kırpımı: 47 px'lik yüz, şapka 0). 0.1'de en büyük yüz ana özne.
  const lm = await faceLandmarks(J, 0.1);
  if (!lm) return { reason: "no-face" };
  const crop = segCrop(lm, W, H);
  const { left, top, side, fw } = crop;
  if (side < 32) return { reason: "tiny" };
  const c = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) data.copy(c, y * side * 3, ((top + y) * W + left) * 3, ((top + y) * W + left + side) * 3);
  const P = await classProbs(c, side, side);
  const pts = lm.pts.map((p) => ({ x: p.x - left, y: p.y - top }));
  const m = hatMaskFromProbs(P, CLASSES, pts, fw, side);
  return { J, W, H, lm, crop, ...m };
}

/**
 * Şablonda şapka var mı. Döner { hat, score (OWL, çalışmadıysa null), area
 * (yüz²), reason, ms }; hat=true iken ayrıca maskPng (tuval boyunda, 255 = şapka),
 * maskW/maskH ve fwFrac (yüz genişliği / tuval eni) — geri yerleştirme bunu kullanır.
 * Hata fırlatabilir; çağıran hat=false sayar (bugünkü prompt).
 */
async function detectTemplateHat(buf) {
  const t0 = Date.now();
  const m = await templateHatMask(buf);
  const area = m.area != null ? +m.area.toFixed(3) : null;
  if (m.reason) return { hat: false, score: null, area, reason: m.reason, ms: Date.now() - t0 };
  if (!(m.area >= HAT_MIN_FACE2)) return { hat: false, score: null, area, reason: "seg-alan", ms: Date.now() - t0 };
  const o = await owlHatScore(m.J, m.lm, m.W, m.H);
  const score = +o.score.toFixed(3);
  const hair = o.hair != null ? +o.hair.toFixed(3) : null;
  const hat = o.ok;
  const r = { hat, score, hair, q: o.q, area, reason: hat ? null : "owl", ms: Date.now() - t0 };
  // ŞAPKA MASKESİ (2026-11-06 inceleme): geri yerleştirmenin yumuşak kenarı şablonun
  // ASIL şapkasını modelin şapkasının üstüne yarı saydam kubbe olarak karıştırıyordu
  // (0eeb75c8 c3: şapka tepesi kırpma kenarının 0.06'lık bandında). Maske tam
  // tuval boyunda tek kanallı PNG (birkaç KB; önbellekte ve worker sınırında ucuz).
  if (hat) {
    const full = Buffer.alloc(m.W * m.H);
    const { left, top, side } = m.crop;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (m.mask[y * side + x]) full[(top + y) * m.W + left + x] = 255;
    r.maskPng = await sharp(full, { raw: { width: m.W, height: m.H, channels: 1 } }).png().toBuffer();
    r.maskW = m.W;
    r.maskH = m.H;
    r.fwFrac = m.crop.fw / m.W;
  }
  return r;
}

module.exports = {
  detectTemplateHat,
  templateHatMask,
  _testables: { hatMaskFromProbs, owlHatDecision, segCrop, HAT_MIN_FACE2, OWL_MIN, SEG_MIN },
};
