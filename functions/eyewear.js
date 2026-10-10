// GÖZLÜK EN SON (2026-10-10, kullanıcı kararı: "önce yüz şekli tamamen
// bitsin, gözlüğü en son ekle"). Gözlüğü ana üretimde çizdirmek iki kusur
// verdi (b602b4b0): c2'de uzak camın çerçevesi yarıda kaldı ve model başka bir
// gözlük çizdi; gözlük gözleri kapattığı için kimlik kapısı da yüzü ölçemedi.
// Artık ana üretim gözlüğü her zaman kaldırır; kimlik, kafa ölçeği ve diğer
// yüz katmanları gözlüksüz yüzde çalışır. Şablonda gözlük varsa teslimden
// hemen önce şablonun gözlüğü maskeli düzenlemeyle (gpt-image-2, ikinci görsel
// = şablonun göz bölgesi) yeni yüze eklenir.
//
// Maske dar tutulur: iki cam elipsi + köprü + kulağa giden sap şeridi. İlk
// denemede alından burna kadar dikdörtgen maske kullanıldı; model o alanı
// baştan çizdi, şakak saçı geriledi, kaşlar ve gözler değişti. Model gözlüğü
// maskenin biraz dışına da çizer (ölçüm: maske kenarının %15-40'ı); maskeye
// bağlı, belirgin değişmiş pikseller de alınır ki çerçeve maske kenarında
// kesilmesin. b602b4b0 c2/c3/c5 x4 deneme: 12/12 çerçeve tam, şablonla aynı
// model, kaş/saç/yüz dokunulmadan kaldı.
const sharp = require("sharp");

// "Yalnızca maskenin içine çiz" cümlesi yok, bilinçli: model gözlüğü zaten
// maskenin dışına da çiziyor ve o taşma alınıyor; cümle modeli camı maske
// kenarında bitirmeye itebilir (yarım çerçeve). Maskenin dışını bileştirme korur.
const EYEWEAR_ADD_PROMPT =
  "IMAGE 1 is a photo of a man. IMAGE 2 is a close-up of a pair of glasses worn by a different person. " +
  "Put that exact pair of glasses on the man in IMAGE 1. " +
  "Same frame model as IMAGE 2: same frame shape, thickness, material, colour, hinges, lens shape and lens tint. " +
  "Size and place them for THIS man's face and head angle, not for the other person's: each lens is centred over one of his eyes, " +
  "the bridge sits on his nose, the temple arms run back along the sides of his head to his ears. " +
  "Draw the complete frame: both lenses with their full rims; the far lens may be partly hidden only where his nose or face naturally covers it at this head angle. " +
  "Keep his eyes, eyelids, eyebrows, skin, beard, hair and expression exactly as they are; behind light lenses they are the same eyes seen through the tint. " +
  "Add the small shadow the frame casts on his skin in the photo's light. Nothing of the other person in IMAGE 2 may appear. Change nothing else.";

const INPAINT_SIZE = 1024;
const LOW_CONF_FACE = 0.1;
const CROP_FACE_MULT = 2.6; // kırpım kenarı = yüz genişliği x bu
const LENS_RX = 0.6; // cam elipsi, göz arası mesafeye oranla
const LENS_RY = 0.42;
const ARM_HALF = 0.16; // sap şeridi yarı kalınlığı
const GROW_IOD = 0.2; // maske dışına taşan gözlük en fazla bu kadar (adım) alınır
const GROW_DIFF = 40; // taşma sayılan renk farkı (RGB uzaklığı)
const GROW_DARKER = 15; // taşma pikseli tabandan en az bu kadar koyu (çerçeve)
const GROW_MAX_FRAC = 0.15; // taşma maskenin bu oranını aşarsa hiç alınmaz

function segDist(px, py, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - a.x - t * vx, py - a.y - t * vy);
}

/**
 * Gözlük maskesi (68 nokta, görüntü koordinatı): iki cam elipsi, köprü ve
 * kulağa giden saplar. Kaşların üstü, alın ve saç dışarıda kalır.
 */
function eyewearGeometry(pts) {
  const ctr = (i0, i1) => {
    let x = 0, y = 0;
    for (let i = i0; i <= i1; i++) { x += pts[i].x; y += pts[i].y; }
    const n = i1 - i0 + 1;
    return { x: x / n, y: y / n };
  };
  const eR = ctr(36, 41), eL = ctr(42, 47);
  const iod = Math.hypot(eL.x - eR.x, eL.y - eR.y);
  const RX = LENS_RX * iod, RY = LENS_RY * iod, ARM = ARM_HALF * iod;
  const segs = [
    [{ x: eR.x - 0.45 * iod, y: eR.y - 0.12 * iod }, { x: pts[0].x, y: pts[0].y - 0.05 * iod }],
    [{ x: eL.x + 0.45 * iod, y: eL.y - 0.12 * iod }, { x: pts[16].x, y: pts[16].y - 0.05 * iod }],
    [eR, eL],
  ];
  const inMask = (x, y) => {
    for (const e of [eR, eL]) {
      const dx = (x - e.x) / RX, dy = (y - e.y - 0.04 * iod) / RY;
      if (dx * dx + dy * dy <= 1) return true;
    }
    for (const [a, b] of segs) if (segDist(x, y, a, b) <= ARM) return true;
    return false;
  };
  return { eR, eL, iod, inMask };
}

async function blur1(arr, W, H, r) {
  const u8 = Uint8Array.from(arr, (v) => (v ? 255 : 0));
  // sharp tek kanallı ham girdiyi blur sonrası 3 kanal döndürebilir — kanal 0 alınır.
  return sharp(Buffer.from(u8), { raw: { width: W, height: H, channels: 1 } })
    .blur(Math.max(0.3, r)).extractChannel(0).raw().toBuffer();
}

/**
 * AI çıktısını yerine koyar: maske (+ maskeye bağlı taşma) yumuşak kenarla,
 * dışı aynen. Renk kayması maskenin hemen dışındaki halkadan düzeltilir.
 * Saf fonksiyon (ağ yok) — test edilebilir.
 */
async function compositeEyewear(baseRgb, W, H, rect, geom, aiRgb) {
  const { left, top, side } = rect;
  const N = side * side;
  const m = new Uint8Array(N);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) m[y * side + x] = geom.inMask(left + x, top + y) ? 1 : 0;
  const feather = Math.max(2, Math.round(geom.iod / 25));
  const ring = await blur1(m, side, side, feather * 4);
  const off = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (m[i] || ring[i] <= 20) continue;
    const gi = ((top + Math.floor(i / side)) * W + left + (i % side)) * 3;
    for (let c = 0; c < 3; c++) off[c] += baseRgb[gi + c] - aiRgb[i * 3 + c];
    n++;
  }
  for (let c = 0; c < 3; c++) off[c] = n ? off[c] / n : 0;
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const gi = ((top + Math.floor(i / side)) * W + left + (i % side)) * 3;
    let s = 0;
    for (let c = 0; c < 3; c++) { const d = aiRgb[i * 3 + c] + off[c] - baseRgb[gi + c]; s += d * d; }
    D[i] = Math.sqrt(s);
  }
  // Taşma: maskeden başlayıp belirgin değişmiş VE koyulaşmış (çerçeve gibi)
  // komşu piksellere, en fazla GROW_IOD adım yayıl. 790bd56b c2: ilk sürüm
  // açıklık şartı ve gerçek mesafe sınırı olmadan yayıldı (bulanık bölge
  // tasarlanandan çok genişti), modelin yeniden çizdiği yüz kenarını aldı —
  // yüzün yanında ikinci yüz (taşma 0.369). Taşma GROW_MAX_FRAC'ı aşarsa
  // model gözlük değil yüz çiziyor demektir: hiç alınmaz.
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const darker = (i) => {
    const gi = ((top + Math.floor(i / side)) * W + left + (i % side)) * 3;
    return lum(aiRgb[i * 3] + off[0], aiRgb[i * 3 + 1] + off[1], aiRgb[i * 3 + 2] + off[2]) <
      lum(baseRgb[gi], baseRgb[gi + 1], baseRgb[gi + 2]) - GROW_DARKER;
  };
  const maxSteps = Math.max(2, Math.round(GROW_IOD * geom.iod));
  const steps = new Uint16Array(N);
  const grown = new Uint8Array(N);
  const nb = (i) => {
    const x = i % side, out = [];
    if (x > 0) out.push(i - 1);
    if (x < side - 1) out.push(i + 1);
    if (i >= side) out.push(i - side);
    if (i < N - side) out.push(i + side);
    return out;
  };
  let q = [];
  for (let i = 0; i < N; i++) {
    if (!m[i]) continue;
    for (const j of nb(i)) {
      if (!m[j] && !grown[j] && D[j] > GROW_DIFF && darker(j)) { grown[j] = 1; steps[j] = 1; q.push(j); }
    }
  }
  while (q.length) {
    const next = [];
    for (const i of q) {
      if (steps[i] >= maxSteps) continue;
      for (const j of nb(i)) {
        if (m[j] || grown[j] || D[j] <= GROW_DIFF || !darker(j)) continue;
        grown[j] = 1;
        steps[j] = steps[i] + 1;
        next.push(j);
      }
    }
    q = next;
  }
  let maskPx = 0, grownPx = 0;
  for (let i = 0; i < N; i++) {
    if (m[i]) maskPx++;
    if (grown[i]) grownPx++;
  }
  const grownFrac = maskPx ? grownPx / maskPx : 0;
  const useGrowth = grownFrac <= GROW_MAX_FRAC;
  if (useGrowth) for (let i = 0; i < N; i++) if (grown[i]) m[i] = 1;
  const wgt = await blur1(m, side, side, feather);
  const out = Buffer.from(baseRgb);
  for (let i = 0; i < N; i++) {
    const w = wgt[i] / 255;
    if (w <= 0) continue;
    const gi = ((top + Math.floor(i / side)) * W + left + (i % side)) * 3;
    for (let c = 0; c < 3; c++) {
      out[gi + c] = Math.max(0, Math.min(255, Math.round(baseRgb[gi + c] * (1 - w) + (aiRgb[i * 3 + c] + off[c]) * w)));
    }
  }
  return { rgb: out, grown: useGrowth ? grownFrac : 0, grownRejected: useGrowth ? 0 : grownFrac };
}

/**
 * Gözlük ekleme işini hazırlar. Dönüş: { image, ref, mask, finish(aiBuf) }
 * ya da { reason } (yüz noktası bulunamadı vb. — çağıran gözlüksüz teslim eder).
 */
async function prepareEyewear(outBuf, tplBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const lo = (await faceLandmarks(outBuf)) || (await faceLandmarks(outBuf, LOW_CONF_FACE));
  if (!lo) return { reason: "no-face-output" };
  const lt = (await faceLandmarks(tplBuf)) || (await faceLandmarks(tplBuf, LOW_CONF_FACE));
  if (!lt) return { reason: "no-face-template" };
  const mo = await sharp(outBuf).metadata(), mt = await sharp(tplBuf).metadata();
  const W = mo.width, H = mo.height;
  const geom = eyewearGeometry(lo.pts);
  const xs = lo.pts.map((p) => p.x);
  const fw = Math.max(...xs) - Math.min(...xs);
  const side = Math.round(Math.min(W, H, fw * CROP_FACE_MULT));
  const cx = (geom.eR.x + geom.eL.x) / 2, cy = (geom.eR.y + geom.eL.y) / 2;
  const left = Math.round(Math.min(Math.max(0, cx - side / 2), W - side));
  const top = Math.round(Math.min(Math.max(0, cy - side / 2), H - side));
  const rect = { left, top, side };
  const S = INPAINT_SIZE, k = S / side;
  const image = await sharp(outBuf).extract({ left, top, width: side, height: side })
    .resize(S, S, { kernel: "lanczos3" }).png().toBuffer();
  const a = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    a[(y * S + x) * 4 + 3] = geom.inMask(left + x / k, top + y / k) ? 0 : 255;
  }
  const mask = await sharp(a, { raw: { width: S, height: S, channels: 4 } }).png().toBuffer();
  // Şablonun gözlüğü: kaşların üstünden burun ucuna, yüzün iki yanı geniş.
  const P = lt.pts, txs = P.map((p) => p.x);
  const tfw = Math.max(...txs) - Math.min(...txs);
  const tl = Math.max(0, Math.round(Math.min(...txs) - 0.25 * tfw));
  const tr = Math.min(mt.width, Math.round(Math.max(...txs) + 0.25 * tfw));
  const tt = Math.max(0, Math.round(Math.min(...P.slice(17, 27).map((p) => p.y)) - 0.15 * tfw));
  const tb = Math.min(mt.height, Math.round(P[30].y + 0.15 * tfw));
  const refRaw = await sharp(tplBuf).extract({ left: tl, top: tt, width: tr - tl, height: tb - tt }).png().toBuffer();
  const ref = await sharp(refRaw).resize({ width: 768, kernel: "lanczos3" }).png().toBuffer();
  const finish = async (aiBuf) => {
    const baseRgb = await sharp(outBuf).removeAlpha().raw().toBuffer();
    const aiRgb = await sharp(aiBuf).resize(side, side, { kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
    const { rgb, grown, grownRejected } = await compositeEyewear(baseRgb, W, H, rect, geom, aiRgb);
    const buf = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf, grown, grownRejected };
  };
  return { image, ref, mask, finish, rect, iod: geom.iod };
}

module.exports = { prepareEyewear, compositeEyewear, eyewearGeometry, EYEWEAR_ADD_PROMPT };
