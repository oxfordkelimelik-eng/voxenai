// ŞABLONA HİZALAMA (2026-10-08, iş 9d9507f0 c0).
//
// SORUN: model bazen tuvalin TAMAMINI hafifçe kaydırıp büyütüyor (c0: kırpılmış
// tuvalde dx 0.45 yüz genişliği, ölçek 1.04). Geri yerleştirme ve arka plan
// geri yüklemesi çıktının şablonla aynı yerde olduğunu varsayıyordu; kaymış
// içerik şablonun üstüne konunca İKİ SANDALYE, perdede şablonun saç hayaleti,
// bacaklarda silik ikinci kontur oluştu.
//
// ÇÖZÜM: çıktı ile şablon arasındaki benzerlik dönüşümü (ölçek + kayma)
// gradyan görüntüleri üzerinde kabadan inceye aranır; çıktı şablon
// koordinatlarına geri çekilir. Ton farkından etkilenmesin diye parlaklık
// değil kenar (gradyan) karşılaştırılır. Kişi kendi başına oynamışsa arka plan
// baskın gelir ve dönüşüm ~birim çıkar — o durumda dokunulmaz.

const sharp = require("sharp");

// Bundan küçük dönüşümler uygulanmaz (yeniden örnekleme bulanıklığına değmez).
const MIN_SHIFT_PX = 2;
const MIN_SCALE_DELTA = 0.004;
// Hizalama, birim dönüşüme göre en az bu kadar iyileştirmeli.
const MIN_GAIN = 0.03;

async function gradAt(rgb, W, H, w, h) {
  const g = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer();
  const G = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1];
      const gy = g[i + w] - g[i - w];
      G[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return G;
}

/**
 * SAF. Çıktı pikseli p ↔ şablon pikseli q = c + s·(p − c) + t (c: merkez).
 * Maliyet: |Go(p) − Gt(q)| ortalaması (kenar payı dışında).
 */
function cost(Go, Gt, w, h, s, tx, ty, step = 1) {
  const cx = w / 2;
  const cy = h / 2;
  const m = Math.round(0.04 * Math.max(w, h));
  let sum = 0;
  let n = 0;
  for (let y = m; y < h - m; y += step) {
    for (let x = m; x < w - m; x += step) {
      const qx = Math.round(cx + s * (x - cx) + tx);
      const qy = Math.round(cy + s * (y - cy) + ty);
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      sum += Math.abs(Go[y * w + x] - Gt[qy * w + qx]);
      n++;
    }
  }
  return n ? sum / n : Infinity;
}

/** Kabadan inceye arama. Döner: { s, tx, ty } TAM çözünürlük pikselinde. */
async function estimateAlignment(oRgb, tRgb, W, H) {
  const levels = [64, 128, 256];
  let best = { s: 1, tx: 0, ty: 0 };
  let prevW = null;
  for (let li = 0; li < levels.length; li++) {
    const w = W >= H ? levels[li] : Math.max(8, Math.round(levels[li] * W / H));
    const h = Math.max(8, Math.round(w * H / W));
    const [Go, Gt] = await Promise.all([gradAt(oRgb, W, H, w, h), gradAt(tRgb, W, H, w, h)]);
    if (prevW) {
      const k = w / prevW;
      best = { s: best.s, tx: best.tx * k, ty: best.ty * k };
    }
    const sR = li === 0 ? 0.1 : 0.01;
    const sStep = li === 0 ? 0.01 : 0.005;
    const tR = li === 0 ? Math.round(0.12 * w) : 2;
    let cand = best;
    let cBest = Infinity;
    for (let s = best.s - sR; s <= best.s + sR + 1e-9; s += sStep) {
      for (let ty = Math.round(best.ty) - tR; ty <= Math.round(best.ty) + tR; ty++) {
        for (let tx = Math.round(best.tx) - tR; tx <= Math.round(best.tx) + tR; tx++) {
          const c = cost(Go, Gt, w, h, s, tx, ty, li === 0 ? 1 : 2);
          if (c < cBest) { cBest = c; cand = { s, tx, ty }; }
        }
      }
    }
    best = cand;
    prevW = w;
    if (li === levels.length - 1) {
      const id = cost(Go, Gt, w, h, 1, 0, 0, 1);
      const fin = cost(Go, Gt, w, h, best.s, best.tx, best.ty, 1);
      const k = W / w;
      return { s: best.s, tx: best.tx * k, ty: best.ty * k, gain: id > 0 ? (id - fin) / id : 0, idCost: id, cost: fin };
    }
  }
  return null;
}

/** Çıktıyı şablon koordinatlarına çeker (bilineer). Kaynak dışı → şablon pikseli. */
function warpToTemplate(O, T, W, H, { s, tx, ty }) {
  const out = Buffer.alloc(W * H * 3);
  const cx = W / 2;
  const cy = H / 2;
  for (let qy = 0; qy < H; qy++) {
    for (let qx = 0; qx < W; qx++) {
      const px = cx + (qx - cx - tx) / s;
      const py = cy + (qy - cy - ty) / s;
      const j = (qy * W + qx) * 3;
      if (px < 0 || py < 0 || px > W - 1 || py > H - 1) {
        out[j] = T[j]; out[j + 1] = T[j + 1]; out[j + 2] = T[j + 2];
        continue;
      }
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx = px - x0, fy = py - y0;
      for (let c = 0; c < 3; c++) {
        const v = (O[(y0 * W + x0) * 3 + c] * (1 - fx) + O[(y0 * W + x1) * 3 + c] * fx) * (1 - fy) +
          (O[(y1 * W + x0) * 3 + c] * (1 - fx) + O[(y1 * W + x1) * 3 + c] * fx) * fy;
        out[j + c] = Math.round(v);
      }
    }
  }
  return out;
}

/**
 * outputBuf'u templateBuf'a hizalar. Şablon çıktı boyutuna ölçeklenir.
 * Döner: { buf|null, applied, reason, s, tx, ty, gain }
 */
async function alignToTemplate(outputBuf, templateBuf) {
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width;
  const H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const a = await estimateAlignment(o.data, t, W, H);
  if (!a) return { buf: null, applied: false, reason: "no-estimate" };
  const info = { s: a.s, tx: a.tx, ty: a.ty, gain: a.gain };
  const small = Math.abs(a.s - 1) < MIN_SCALE_DELTA && Math.hypot(a.tx, a.ty) < MIN_SHIFT_PX;
  if (small) return { buf: null, applied: false, reason: "aligned", ...info };
  if (a.gain < MIN_GAIN) return { buf: null, applied: false, reason: "no-gain", ...info };
  const w = warpToTemplate(o.data, t, W, H, a);
  const buf = await sharp(w, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, ...info };
}

module.exports = { alignToTemplate, estimateAlignment, warpToTemplate, cost };
