/**
 * SELFIE KAFA KIRPIMI (2026-11-08, kullanıcı kararı).
 *
 * SORUN: 5 selfie olduğu gibi gidince model başı selfie'lerin açısına çekiyor
 * (173acc7f c6 +6.7° base → +19.7°, c7 −39.8° → −25.6°). Aynı girdiyle iki
 * üretim aynı yöne sapıyor: sapma girdiden geliyor. Selfie'de omuz, gövde ve
 * boyun da görünüyor; bunlar "baş bu yöne dönük" ipucu.
 *
 * ÇÖZÜM: selfie'ler yalnız KAFA + SAÇ kalacak şekilde kırpılır. Kimlik yine 5
 * açıdan görülür, gövde yönü gitmez. Yüz döndürme/bükme YOK, pikseller aynen.
 * (Çıktıda 3B ağla baş çevirme denendi, kullanıcı reddetti: burun büyüyor,
 * yüz dikleşiyor.)
 *
 * SAÇ ASLA KESİLMEZ: kafa bileşeni segmentasyondan (saç + yüz derisi + kafadaki
 * aksesuar, yüz kutusuna bağlı) bulunur; uzun saç omza iniyorsa kırpım da
 * oraya kadar iner. Bölütleme saçı kaçırırsa diye kaşın 1 yüz eni üstü ve yanlarda
 * pay her zaman kalır. Yüz bulunamazsa / kırpım kazancı yoksa selfie aynen gider.
 */
const sharp = require("sharp");

const HEAD_CROP = {
  SEG_MAX: 640, // bölütleme bu boyutta (model zaten 256'da çalışıyor)
  P_HEAD: 0.5, // saç + yüz derisi + aksesuar olasılığı
  SIDE: 0.35, // kafa bileşeninin yanlarına pay (yüz eni)
  TOP: 0.3, // tepeye pay
  ABOVE_BROW: 1.0, // bölütleme ne derse desin kaşın en az bu kadar üstü
  BELOW_CHIN: 0.35, // çenenin altı (boyun başı; omuz değil)
  BELOW_HAIR: 0.1, // uzun saçın ucunun altına pay
  MAX_KEEP_FRAC: 0.85, // kırpım alanı görüntünün bundan büyükse dokunma
  MIN_FACE_PX: 60, // yüz eni bundan küçükse dokunma
};

/**
 * Yüz kutusuna bağlı kafa bileşeninin sınırları (4-komşu taşma).
 * @param {Uint8Array} mask w*h, 1 = kafa sınıfı
 * @param {{x0,y0,x1,y1}} seed yüz kutusu (maske koordinatında)
 * @returns {{x0,y0,x1,y1,px}|null}
 */
function headComponent(mask, w, h, seed) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  const sx0 = Math.max(0, Math.floor(seed.x0)), sx1 = Math.min(w - 1, Math.ceil(seed.x1));
  const sy0 = Math.max(0, Math.floor(seed.y0)), sy1 = Math.min(h - 1, Math.ceil(seed.y1));
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
    const i = y * w + x;
    if (mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); }
  }
  if (!stack.length) return null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, px = 0;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    px++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1, px };
}

/**
 * Kırpım kutusu. face: landmark kutusu + kaş/çene; head: kafa bileşeni (tam
 * çözünürlükte) ya da null (yalnız yüz paylarıyla).
 * @returns {{box?:{left,top,width,height}, frac?:number, reason?:string}}
 */
function planHeadCrop({ W, H, face, head }) {
  const fw = face.x1 - face.x0;
  if (!(fw >= HEAD_CROP.MIN_FACE_PX)) return { reason: "yüz-küçük" };
  const hx0 = head ? Math.min(head.x0, face.x0) : face.x0;
  const hx1 = head ? Math.max(head.x1, face.x1) : face.x1;
  const hy0 = head ? head.y0 : face.y0;
  const hy1 = head ? head.y1 : face.chinY;
  let x0 = hx0 - HEAD_CROP.SIDE * fw;
  let x1 = hx1 + HEAD_CROP.SIDE * fw;
  let y0 = Math.min(hy0 - HEAD_CROP.TOP * fw, face.browY - HEAD_CROP.ABOVE_BROW * fw);
  let y1 = Math.max(face.chinY + HEAD_CROP.BELOW_CHIN * fw, hy1 + HEAD_CROP.BELOW_HAIR * fw);
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const box = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  if (box.width <= 0 || box.height <= 0) return { reason: "kutu-boş" };
  const frac = (box.width * box.height) / (W * H);
  if (frac > HEAD_CROP.MAX_KEEP_FRAC) return { reason: "zaten-sıkı", frac };
  return { box, frac };
}

/**
 * @param {Buffer} buf EXIF'i uygulanmış selfie
 * @returns {Promise<{buf:Buffer, applied:boolean, reason?:string, box?:object, frac?:number, ms:number}>}
 */
async function cropSelfieHead(buf) {
  const t0 = Date.now();
  const done = (o) => ({ buf, applied: false, ...o, ms: Date.now() - t0 });
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    if (!W || !H) return done({ reason: "boyut-yok" });
    const { faceLandmarks } = require("./faceQuality");
    const lm = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
    if (!lm || !lm.pts || lm.pts.length < 68) return done({ reason: "yüz-yok" });
    const xs = lm.pts.map((p) => p.x), ys = lm.pts.map((p) => p.y);
    const face = {
      x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
      browY: Math.min(...lm.pts.slice(17, 27).map((p) => p.y)), chinY: lm.pts[8].y,
    };
    // Kafa bileşeni (küçük ölçekte bölütleme).
    let head = null;
    try {
      const k = Math.min(1, HEAD_CROP.SEG_MAX / Math.max(W, H));
      const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      const rgb = await sharp(buf).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
      const { classProbs, CLASSES } = require("./skinSeg");
      const P = await classProbs(rgb, w, h);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) {
        const p = P[CLASSES.hair][i] + P[CLASSES.faceSkin][i] + P[CLASSES.others][i];
        if (p >= HEAD_CROP.P_HEAD) mask[i] = 1;
      }
      const c = headComponent(mask, w, h, { x0: face.x0 * k, y0: face.y0 * k, x1: face.x1 * k, y1: face.y1 * k });
      if (c) head = { x0: c.x0 / k, y0: c.y0 / k, x1: c.x1 / k, y1: c.y1 / k };
    } catch (e) {
      console.error("Selfie kafa bölütlemesi başarısız (yalnız yüz paylarıyla):", e.message || e);
    }
    const plan = planHeadCrop({ W, H, face, head });
    if (!plan.box) return done({ reason: plan.reason, frac: plan.frac });
    const out = await sharp(buf).extract(plan.box).jpeg({ quality: 95 }).toBuffer();
    return { buf: out, applied: true, box: plan.box, frac: plan.frac, seg: !!head, ms: Date.now() - t0 };
  } catch (e) {
    return done({ reason: `hata:${e.message || e}` });
  }
}

module.exports = { cropSelfieHead, _testables: { headComponent, planHeadCrop, HEAD_CROP } };
