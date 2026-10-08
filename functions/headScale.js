// KAFA ÖLÇEĞİ DÜZELTMESİ (2026-10-07, kullanıcı kararı: "elemek yerine çöz";
// 2026-10-08: "kafa büyümesi/küçülmesi tamamen omuz oranına göre").
//
// Çıktının kafası şablondaki kafayla aynı büyüklüğe getirilir. Gövde
// şablonla aynı kadrajdaysa (kişi maskeleri örtüşüyor) omuzlar da aynıdır,
// yani "kafa/omuz oranı şablonla aynı" = "kafa şablon kafasıyla aynı boyda".
//
// ÖLÇÜ GEÇMİŞİ: Vision'ın kafa/omuz sayıları tahmindi; yüz kutusu çeneyi ve
// sakalı kaçırdı; saç dahil silüet şablonun hacimli saçıyla kör oldu. Şimdiki
// ölçü yüz noktaları (bkz. landmarkSizeRatio). Silüet yalnızca dönüşümün
// geometrisi (kafa tepesi/genişliği) için kullanılır.
//
// Yüz yeniden çizilmez, yalnızca ölçeklenir — kimlik korunur. Emin
// olunamayan her durumda (yüz yok, gövde örtüşmüyor) HİÇBİR ŞEY yapmaz ve
// sebebini döner.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SEG_SIZE = 256;
// ÖLÇÜ (2026-10-08, iş bb2cc441): kafa boyu artık YÜZ NOKTALARIYLA ölçülür
// (göz-çene, kaş-çene, burun-çene, elmacık genişliği; dördünün medyanı).
// Yüz kutusu ve silüet gözle görülen büyüklüğü yakalayamadı: c4'te çıktının
// çenesi belirgin aşağıdaydı, kutu %1 fark dedi; noktalar %12-14 dedi.
// Saç (afro/hacimli şablon saçı) ve gözlük bu ölçüye girmez.
//
// HEDEF = ŞABLON (kullanıcı kararı: "tamamen omuz oranına göre"). Fazladan
// küçültme çarpanı YOK — 0.94 aşımı c1'i şablondan küçük bıraktı. Düzeltme
// iki yönlüdür: büyük kafa küçülür, küçük kafa büyür.
//
// Bu kadar sapma ölçü gürültüsü; dokunulmaz (|1-s| < APPLY_MIN_DELTA).
const APPLY_MIN_DELTA = 0.04;
// Tek seferde en fazla. Daha büyük sapma ölçü hatası ya da yeniden kadraj.
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.05;
// Gövdeler bu kadar örtüşüyorsa çıktı şablonla aynı kadrajda ve aynı
// omuzlara sahiptir; gövde ölçeği 1 alınır. Silüet omuz ölçümü tek başına
// gürültülüydü (bb2cc441 c3 1.12, c9 2.36 — ikisi de aynı gövde).
const BODY_ALIGNED_IOU = 0.8;
// İkinci kanıt: yüz merkezi şablondakinden en fazla bu kadar (şablon yüz
// genişliği cinsinden) kaymışsa sahne yeniden kadrajlanmamıştır. Karanlık
// kıyafette kişi maskesi gövdeyi göremiyor (bb2cc441 c9: IoU 0.28, poz aynı).
const FACE_ALIGNED_SHIFT = 0.35;
// ALGILANAN KAFA = YÜZ × TOPLAM KAFA HACMİ (2026-10-08, iş 9d9507f0 c8).
// Kullanıcı geri bildirimi iki yöne de geldi: afro şablonda yüz büyükken
// "kafa büyük" (272e656a c2/c5: yüz 1.13, hacim 1.04), gür saç+sakal+
// kulaklıklı şablonda yüz eşitken "kafa çok küçük" (9d9507f0 c8: yüz 1.01,
// hacim 0.95). İkisinin geometrik ortalaması bütün şikâyetlerle örtüştü.
// Hacim (saç ∪ yüz derisi, selfie_multiclass) karanlık sahnede çöküyor
// (bb2cc441 c9 siyah-beyaz: yüz 1.14, hacim 0.86) — yüzden bu kadar
// saparsa hacim yok sayılır.
const VOLUME_TRUST_MAX_DIFF = 0.2;
// Küçültme toplam kafa hacmini şablonun bu oranının altına indiremez
// (c8: 0.886 küçültme hacmi 0.95'e indirdi, "çok küçültmüşsün").
const VOLUME_FLOOR = 0.97;
const VOLUME_CEIL = 1.03;

let _segPromise = null;

function diskHandler(dir) {
  return {
    load: async () => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
      const specs = [];
      const bufs = [];
      for (const g of m.weightsManifest) {
        specs.push(...g.weights);
        for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p)));
      }
      const all = Buffer.concat(bufs);
      return {
        modelTopology: m.modelTopology,
        format: m.format,
        generatedBy: m.generatedBy,
        convertedBy: m.convertedBy,
        weightSpecs: specs,
        weightData: all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength),
        signature: m.signature,
      };
    },
  };
}

async function ensureSegModel() {
  if (!_segPromise) {
    _segPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      if (tf.getBackend() !== "wasm") {
        await tf.setBackend("wasm");
        await tf.ready();
      }
      const model = await tf.loadGraphModel(
        diskHandler(path.join(__dirname, "models", "selfie_segmentation"))
      );
      return { tf, model };
    })().catch((e) => {
      _segPromise = null;
      throw e;
    });
  }
  return _segPromise;
}

/** Kişi maskesi, görüntünün kendi çözünürlüğünde, 0..1 (Float32Array, W*H). */
async function personMask(rgb, W, H) {
  const { tf, model } = await ensureSegModel();
  const small = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(SEG_SIZE, SEG_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  const probs = tf.tidy(() => {
    const x = tf.tensor3d(new Uint8Array(small), [SEG_SIZE, SEG_SIZE, 3], "int32")
      .toFloat().div(255).expandDims(0);
    return model.predict(x).squeeze().slice([0, 0, 1], [SEG_SIZE, SEG_SIZE, 1]).squeeze();
  });
  const data = await probs.data();
  probs.dispose();
  const m8 = Buffer.alloc(SEG_SIZE * SEG_SIZE);
  for (let i = 0; i < data.length; i++) m8[i] = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
  // TEK KANAL TUZAĞI (hafıza notu sharp-mask-channel-trap): resize sonrası
  // kanal sayısı korunmayabilir; extractChannel(0) ile tek kanala zorla.
  const big = await sharp(m8, { raw: { width: SEG_SIZE, height: SEG_SIZE, channels: 1 } })
    .resize(W, H, { fit: "fill", kernel: "linear" })
    .extractChannel(0)
    .raw()
    .toBuffer();
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = big[i] / 255;
  return out;
}

/**
 * Saç dahil kafa siluetini ve omuz genişliğini ölçer. SAF fonksiyon.
 *
 * box: yüz kutusu (ssd_mobilenetv1, kaş-çene arası). Kafa satırları alnın
 * hemen üstünden yanak seviyesine kadar; omuz satırları çenenin 0.6-1.3 yüz
 * genişliği altı. Her ölçüm, yüz merkezinden geçen kesintisiz maske koşusu
 * (run) üzerinden yapılır — yandaki başka kişi/kol koşuya dahil olursa koşu
 * pencere kenarına dayanır ve ölçüm reddedilir.
 *
 * @returns {{ok:true, top:number, chin:number, cx:number, headW:number,
 *   headH:number, shoulderW:number} | {ok:false, reason:string}}
 */
function measureSilhouette(mask, W, H, box, thr = 0.5) {
  const fw = box.width;
  const cx = Math.round(box.x + fw / 2);
  const chin = Math.round(box.y + box.height);
  if (!(fw > 8) || cx < 0 || cx >= W) return { ok: false, reason: "bad-face" };
  // Kafa penceresi ±1.8 yüz genişliği; omuz penceresi ±3.5 (omuzlar
  // yaklaşık 3-4 yüz genişliği). Koşu pencereye dayanırsa ölçüm belirsiz.
  const headWin = [Math.max(0, Math.round(cx - 1.8 * fw)), Math.min(W - 1, Math.round(cx + 1.8 * fw))];
  const shWin = [Math.max(0, Math.round(cx - 3.5 * fw)), Math.min(W - 1, Math.round(cx + 3.5 * fw))];
  const at = (x, y) => mask[y * W + x];

  // Kafa tepesi: yüz merkezi sütunlarında (±%15 fw) yukarıdan ilk kişi pikseli.
  const searchTop = Math.max(0, Math.round(box.y - 2.0 * fw));
  let top = -1;
  for (let y = searchTop; y < box.y; y++) {
    let hits = 0;
    let n = 0;
    for (let x = Math.round(cx - 0.15 * fw); x <= Math.round(cx + 0.15 * fw); x++) {
      if (x < 0 || x >= W) continue;
      n++;
      if (at(x, y) >= thr) hits++;
    }
    if (n && hits / n > 0.5) { top = y; break; }
  }
  if (top < 0) return { ok: false, reason: "no-head-top" };
  // Arama penceresinin başında zaten kişi varsa tepe görülmüyor: kadraj
  // dışı ya da kafanın üstünde bir şey (el, şapka, başka kişi) var.
  if (top <= searchTop + 1) return { ok: false, reason: "head-top-cut" };

  const run = (y, [winL, winR]) => {
    if (at(cx, y) < thr) return null;
    let l = cx;
    let r = cx;
    while (l > winL && at(l - 1, y) >= thr) l--;
    while (r < winR && at(r + 1, y) >= thr) r++;
    if (l <= winL || r >= winR) return -1; // pencereye dayandı: belirsiz
    return r - l + 1;
  };

  const headY0 = Math.round(top + 0.15 * (chin - top));
  const headY1 = Math.round(box.y + box.height * 0.6);
  let headW = 0;
  for (let y = headY0; y <= headY1; y++) {
    const w = run(y, headWin);
    if (w === -1) return { ok: false, reason: "head-touches-other" };
    if (w != null && w > headW) headW = w;
  }
  if (!(headW > 0)) return { ok: false, reason: "no-head-width" };

  const shY0 = Math.round(chin + 0.6 * fw);
  const shY1 = Math.round(chin + 1.3 * fw);
  if (shY1 >= H) return { ok: false, reason: "shoulders-out-of-frame" };
  const widths = [];
  for (let y = shY0; y <= shY1; y++) {
    const w = run(y, shWin);
    if (w === -1) return { ok: false, reason: "shoulders-touch-other" };
    if (w != null) widths.push(w);
  }
  if (widths.length < (shY1 - shY0) / 2) return { ok: false, reason: "no-shoulders" };
  widths.sort((a, b) => a - b);
  const shoulderW = widths[Math.floor(widths.length / 2)];

  return { ok: true, top, chin, cx, headW, headH: chin - top, shoulderW };
}

/**
 * Yüz kutusu tabanlı yaklaşık siluet (karanlık görüntü fallback).
 * Segmentasyon başarısız olduğunda veya omuzu yanlış ölçtüğünde kullanılır.
 * pinchHead'in ihtiyaç duyduğu top/chin/cx/headW/headH alanlarını verir.
 */
function approxSilFromFaceBox(box) {
  const cx = Math.round(box.x + box.width / 2);
  const chin = Math.round(box.y + box.height);
  const top = Math.max(0, Math.round(box.y - 0.65 * box.height)); // saç dahil kafa tepesi
  const headW = Math.round(box.width * 1.35);
  return { ok: true, top, chin, cx, headW, headH: chin - top, shoulderW: Math.round(box.width * 2.5) };
}

const median = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Yüz noktalarından yüz büyüklüğü oranı (çıktı / şablon). SAF fonksiyon.
 * pts: face-api 68 nokta, iki görüntü AYNI tuvalde. Dört ölçünün medyanı;
 * üçü sakaldan ve saçtan bağımsız (kaş-burun ucu, göz-burun ucu, burun
 * boyu). Elmacık genişliği yaw'dan, göz-çene sakaldan etkilendiği için
 * tek başına belirleyici değil (9d9507f0 c8: gür sakallı şablonda göz-çene
 * yüzü %13 büyük gösterdi, burun ölçüleri ~%0).
 */
function landmarkSizeRatio(ptsO, ptsT) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mean = (ps) => ({ x: ps.reduce((q, p) => q + p.x, 0) / ps.length, y: ps.reduce((q, p) => q + p.y, 0) / ps.length });
  const m = (P) => {
    const eyes = mean(P.slice(36, 48));
    const brows = mean(P.slice(17, 27));
    return {
      eyeChin: d(eyes, P[8]),
      browNose: d(brows, P[33]),
      eyeNose: d(eyes, P[33]),
      noseLen: d(P[27], P[33]),
    };
  };
  const o = m(ptsO);
  const t = m(ptsT);
  const parts = {};
  for (const k of Object.keys(o)) parts[k] = t[k] > 0 ? o[k] / t[k] : NaN;
  return { ratio: median(Object.values(parts)), parts };
}

/**
 * Algılanan kafa oranı: yüz ile toplam kafa hacminin geometrik ortalaması.
 * Hacim yoksa ya da yüzden çok sapıyorsa (karanlık sahne) yalnızca yüz. SAF.
 */
function perceivedHeadRatio(faceRatio, volRatio) {
  if (!(faceRatio > 0)) return { ratio: null, volUsed: false };
  if (!(volRatio > 0) || Math.abs(volRatio - faceRatio) > VOLUME_TRUST_MAX_DIFF) return { ratio: faceRatio, volUsed: false };
  return { ratio: Math.sqrt(faceRatio * volRatio), volUsed: true };
}

/**
 * Ölçekleme kararı. SAF. s = gövdeÖlçeği / kafaOranı; s<1 küçült, s>1 büyüt.
 */
function planLandmarkScale(faceRatio, { bodyIou = 0, faceShift = Infinity, volRatio = null } = {}) {
  if (!(faceRatio > 0)) return { apply: false, reason: "no-measure" };
  const aligned = bodyIou >= BODY_ALIGNED_IOU || faceShift <= FACE_ALIGNED_SHIFT;
  const ph = perceivedHeadRatio(faceRatio, volRatio);
  if (!aligned) return { apply: false, reason: "reframed", rawS: 1 / ph.ratio, volUsed: ph.volUsed };
  let rawS = 1 / ph.ratio;
  // Hacim tabanı/tavanı: düzeltme toplam kafa hacmini şablondan belirgin
  // küçük/büyük bırakmasın.
  if (ph.volUsed) {
    if (rawS < 1) rawS = Math.max(rawS, VOLUME_FLOOR / volRatio);
    else rawS = Math.min(rawS, VOLUME_CEIL / volRatio);
  }
  if (Math.abs(1 - rawS) < APPLY_MIN_DELTA) return { apply: false, reason: "within-tolerance", rawS, s: rawS, volUsed: ph.volUsed };
  return { apply: true, reason: null, rawS, s: Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawS)), volUsed: ph.volUsed };
}

/**
 * Toplam kafa hacmi oranı (çıktı / şablon): saç ∪ yüz derisi alanının
 * karekökü, yüz kutusunun çevresinde (gövde ve arka plandaki insanlar
 * hariç). Hata/ölçüsüzlükte null.
 */
async function headVolumeRatio(oRgb, tRgb, W, H, boxO, boxT) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const area = async (rgb, box) => {
    const P = await classProbs(rgb, W, H);
    const x0 = Math.max(0, Math.round(box.x - 1.2 * box.width)), x1 = Math.min(W, Math.round(box.x + 2.2 * box.width));
    const y0 = Math.max(0, Math.round(box.y - 1.4 * box.height)), y1 = Math.min(H, Math.round(box.y + 1.6 * box.height));
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (P[CLASSES.hair][i] + P[CLASSES.faceSkin][i] > 0.5) n++;
      }
    }
    return n;
  };
  const ao = await area(oRgb, boxO);
  const at = await area(tRgb, boxT);
  return ao > 0 && at > 0 ? Math.sqrt(ao / at) : null;
}

function bilinear(src, W, H, x, y, c) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i00 = (y0 * W + x0) * 3 + c;
  const i10 = (y0 * W + x1) * 3 + c;
  const i01 = (y1 * W + x0) * 3 + c;
  const i11 = (y1 * W + x1) * 3 + c;
  return (src[i00] * (1 - fx) + src[i10] * fx) * (1 - fy) + (src[i01] * (1 - fx) + src[i11] * fx) * fy;
}

/**
 * Kafayı yumuşak bir "liquify" dönüşümüyle ölçekler. O: RGB raw buffer.
 * sil: çıktının siluet ölçümü, faceH: yüz yüksekliği, s: ölçek (<1 küçült, >1 büyüt).
 *
 * NEDEN DELİK AÇIP DOLDURMUYOR: ilk sürüm kafayı küçültüp açılan halkayı
 * şablonun arka planıyla dolduruyordu. Model arka planı şablondan birebir
 * değil, hafif kaydırarak yeniden çiziyor; yapıştırılan parça taş duvar gibi
 * dokulu zeminlerde görünür bir hilal/sıvanma bıraktı (5faa77dc c1). Şimdi
 * hiç delik açılmıyor: kafa elipsinin içi s ile küçülür, dışında etki
 * mesafeyle sıfıra iner, arka plan kafanın etrafında hafifçe içeri akar.
 *
 * Dönüşüm boyun tabanına (ax, neck) sabit: kafa boynun üstünde kalır;
 * çene ile boyun tabanı arasında etki sıfıra iner, boyun ve altı aynen kalır.
 */
function pinchHead(O, W, H, sil, faceH, s) {
  const out = Buffer.from(O);
  const ax = sil.cx;
  const chin = sil.chin;
  const neck = Math.min(H - 1, Math.round(chin + 0.45 * faceH));
  const hx = sil.cx;
  const hy = (sil.top + chin) / 2;
  const ra = sil.headW / 2;
  const rb = sil.headH / 2;
  const R = 2.2; // etkinin sıfıra indiği elips yarıçapı (kafa yarıçapı cinsinden)
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  // ÜST SÖNDÜRME YOK (2026-10-08): kafa tepesinin üstünde etkiyi kesmek
  // eşlemeyi katladı — saçın tepesi yerinde kalıp kafadan kopuk bir halka
  // oldu (272e656a c1/c5). Kafanın çevresinde bükülen arka plan artık
  // sceneRestore ile şablondan geri konuyor (şablondaki kişinin kapladığı
  // alan hariç — orada esnetilmiş çıktı kalır).
  const effect = (x, y) => {
    if (y >= neck) return 0;
    const r = Math.hypot((x - hx) / ra, (y - hy) / rb);
    const radial = 1 - smooth((r - 1) / (R - 1));
    const vert = y <= chin ? 1 : 1 - (y - chin) / (neck - chin);
    return radial * vert;
  };
  const kOf = (x, y) => 1 - (1 - s) * effect(x, y);

  const x0 = Math.max(0, Math.floor(hx - R * ra - 2));
  const x1 = Math.min(W - 1, Math.ceil(hx + R * ra + 2));
  const y0 = Math.max(0, Math.floor(hy - R * rb - 2));
  let moved = 0;
  for (let y = y0; y < neck; y++) {
    for (let x = x0; x <= x1; x++) {
      // Ters eşleme: forward(q) = A + (q - A)·k(q) = p. Sabit nokta yinelemesi.
      let qx = x;
      let qy = y;
      for (let it = 0; it < 12; it++) {
        const k = kOf(qx, qy);
        qx = ax + (x - ax) / k;
        qy = neck + (y - neck) / k;
      }
      if (Math.abs(qx - x) < 0.05 && Math.abs(qy - y) < 0.05) continue;
      moved++;
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.max(0, Math.min(255, Math.round(bilinear(O, W, H, qx, qy, c))));
      }
    }
  }
  return { buf: out, moved, neck };
}

async function rawRgb(buf, W = null, H = null) {
  let img = sharp(buf).rotate().removeAlpha();
  if (W && H) img = img.resize(W, H, { fit: "fill" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/**
 * Ana giriş. outputBuf ve templateBuf AYNI kadraj uzayında olmalı
 * (bkz. falPhotos.js — KONUM ÖLÇÜM ile aynı eşleme kuralı).
 *
 * @returns {{buf: Buffer|null, applied: boolean, reason: string|null, ...}}
 */
async function correctHeadScale(outputBuf, templateBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const o = await rawRgb(outputBuf);
  const t = await rawRgb(templateBuf, o.W, o.H);
  const tJpeg = await sharp(t.data, { raw: { width: o.W, height: o.H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  // Karanlık/profil karelerde 0.35 eşiği yüzü ıskalayabilir; yalnızca ölçü
  // için 0.1'e düşülür (kalite kapılarında bu yol kullanılmaz).
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  const lt = (await faceLandmarks(tJpeg)) || (await faceLandmarks(tJpeg, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template" };

  const [Mo, Mt] = await Promise.all([personMask(o.data, o.W, o.H), personMask(t.data, o.W, o.H)]);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < Mo.length; i++) {
    const a = Mo[i] >= 0.5;
    const b = Mt[i] >= 0.5;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  const bodyIou = uni ? inter / uni : 0;
  const lr = landmarkSizeRatio(lo.pts, lt.pts);
  const centre = (P) => ({ x: P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17, y: P.slice(0, 17).reduce((q, p) => q + p.y, 0) / 17 });
  const co = centre(lo.pts);
  const ct = centre(lt.pts);
  const tplFaceW = Math.hypot(lt.pts[0].x - lt.pts[16].x, lt.pts[0].y - lt.pts[16].y);
  const faceShift = tplFaceW > 0 ? Math.hypot(co.x - ct.x, co.y - ct.y) / tplFaceW : Infinity;
  let volRatio = null;
  try {
    volRatio = await headVolumeRatio(o.data, t.data, o.W, o.H, lo.box, lt.box);
  } catch (e) {
    console.error("Kafa hacmi ölçülemedi (yalnızca yüz ölçüsü):", e.message || e);
  }
  const plan = planLandmarkScale(lr.ratio, { bodyIou, faceShift, volRatio });
  const info = { s: plan.s ?? null, rawS: plan.rawS ?? null, faceRatio: lr.ratio, parts: lr.parts, volRatio, volUsed: plan.volUsed ?? false, bodyIou, faceShift };
  if (!plan.apply) return { buf: null, applied: false, reason: plan.reason, ...info };

  // Dönüşüm geometrisi: silüetten kafa tepesi/genişliği; çene ve merkez
  // yüz noktalarından (kutu çeneyi sakalın üstünde bitiriyordu).
  const so = measureSilhouette(Mo, o.W, o.H, lo.box);
  const base = so.ok ? so : approxSilFromFaceBox(lo.box);
  const P = lo.pts;
  const chin = Math.round(P[8].y);
  const cx = Math.round(P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17);
  const sil = { ...base, cx, chin: Math.max(base.chin, chin), headH: Math.max(base.chin, chin) - base.top };
  const faceH = Math.max(lo.box.height, chin - lo.box.y);
  const r = pinchHead(o.data, o.W, o.H, sil, faceH, plan.s);
  const buf = await sharp(r.buf, { raw: { width: o.W, height: o.H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const head = { cx: sil.cx, cy: (sil.top + sil.chin) / 2, rx: sil.headW / 2, ry: sil.headH / 2, chin: sil.chin, neck: r.neck };
  return { buf, applied: true, reason: null, ...info, head, movedPx: r.moved, silReason: so.ok ? null : so.reason };
}

module.exports = {
  correctHeadScale,
  personMask,
  measureSilhouette,
  approxSilFromFaceBox,
  landmarkSizeRatio,
  perceivedHeadRatio,
  planLandmarkScale,
  APPLY_MIN_DELTA,
  MIN_SCALE,
  MAX_SCALE,
  BODY_ALIGNED_IOU,
  FACE_ALIGNED_SHIFT,
  VOLUME_FLOOR,
  VOLUME_CEIL,
  _pinchHead: pinchHead,
};
