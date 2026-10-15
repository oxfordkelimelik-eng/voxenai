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
const { patchFill } = require("./patchFill");

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
// 0.04 → 0.03 (2026-10-10, iş b602b4b0 c5): s=0.966 "tolerans içi" kaldı,
// kullanıcı "bi tık küçültmeliydin".
const APPLY_MIN_DELTA = 0.03;
// Tek seferde en fazla. Daha büyük sapma ölçü hatası ya da yeniden kadraj.
// 0.8 → 0.9 (2026-10-09, f9f3b5c0 c6): 0.865 küçültme kafayı omuzlara
// gömdü, kafanın yanındaki tablonun kenarını büktü ("kafa, tablo, omuzlar
// öne eğilmiş").
// 0.9 → 0.93 (2026-10-09, iş 61079257): 0.9'a kırpılan c2 "çok küçülmüş",
// c3 "biraz küçük"; 0.9'da iyi bulunan c1/c6 ve 9d9507f0 c8'in "çok
// küçültmüşsün" dediği 0.886 bu sınırla tutarlı. Yüz oranı 1.15+ ölçülen
// karelerde ölçü algıdan fazlasını söylüyor (gözlüklü şablon, gür sakal).
// KADEMELİ GENİŞLETME (2026-10-14, kullanıcı: "kafa büyüme"): cbdbef13'te 9
// karenin 6'sı 1.12-1.89 ölçüldü, 0.93 sınırı hepsini büyük bıraktı. Yerel
// testte (aynı şablonlar) 0.88 c8 (1.18) ve c17 (1.22) için doğal göründü.
// 0.93'e kadar eskisi gibi; ötesinde istenen ek küçültmenin RAMP kadarı
// uygulanır — ölçünün algıdan fazla dediği sakallı şablonlar çok küçülmesin.
const SOFT_MIN_SCALE = 0.93;
const MIN_SCALE = 0.88;
const SCALE_RAMP = 0.5;
// Kademe yalnız inanılır ölçüye: cbdbef13 c17/c24 ham 0.546/0.529 (yüz oranı
// 1.83-1.89) tespit hatasıydı ama kademe onları en dibe (0.88) itiyordu.
// Gerçek büyümeler 1.12-1.23 ölçüldü; bu sınırın altı eski 0.93'te kalır.
const RAMP_TRUST_MIN_RAW_S = 0.77;
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
// KÜÇÜLTMEDE HACİM YOK (2026-10-09, iş 61079257 c5): şablonun kabarık saçı
// hacmi şişirdi (yüz 1.103, hacim 1.010), ortalama + hacim tabanı s'yi
// 0.96'ya çekip kareyi "tolerans içi" yaptı; kullanıcı "kafa çok büyük".
// Küçültme kararı yalnızca yüzle verilir; aşırı küçültmeyi artık
// MIN_SCALE sınırlar (taban bu yüzden kaldırıldı). Hacim yalnızca büyütmede.
const VOLUME_TRUST_MAX_DIFF = 0.2;
// Büyütme toplam kafa hacmini şablonun bu oranının üstüne çıkaramaz.
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
 * scaleHeadPatch'in ihtiyaç duyduğu top/chin/cx/headW/headH alanlarını verir.
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

// GÖZLÜKLÜ ŞABLON ÖLÇÜSÜ (2026-10-10, iş 3cd612ba). Şablonda gözlük varken
// kafa ölçeği tamamen atlanıyordu (790bd56b c1: göz noktaları camın altında
// kaydı, kafa yanlış küçüldü); bu kez c1/c2/c9 "kafa küçülmeliydi" dendi.
// Koyu camda face-api 68 noktayı birlikte oturttuğu için çene hattı da kayıyor;
// tek başına hiçbir ölçü etiketli 13 kareyi doğru sıralamadı (gözsüz noktalar
// c6'yı 1.31, yüz derisi alanı c1'i 1.00 — sakal saç sayılıyor —, kutu c5'i
// 1.21 ölçtü). Dört bağımsız ölçünün MEDYANI hepsini doğru tarafa koydu:
// c1 1.16, c2 1.05, c9 1.10 küçülür; 790bd56b c1 (küçültme öncesi) ~1.03
// tolerans içinde kalır. Büyütme yönü doğrulanmadı → yalnız küçültme.
//   gözsüz noktalar: burun ucu-çene, burun-ağız, ağız eni, alt çene eni
//   yüz alanı: yüz derisi + aksesuar (gözlük "others" sınıfı; çıktıda gözlük
//     henüz yok, orası yüz derisi — iki tarafta da aynı alan sayılır)
//   kutu: SSD yüz kutusunun eni ve boyu
function eyeFreeLandmarkRatio(ptsO, ptsT) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mean = (ps) => ({ x: ps.reduce((q, p) => q + p.x, 0) / ps.length, y: ps.reduce((q, p) => q + p.y, 0) / ps.length });
  const m = (P) => ({
    noseChin: d(P[33], P[8]),
    noseMouth: d(P[33], mean(P.slice(48, 60))),
    mouthW: d(P[48], P[54]),
    jawLow: d(P[4], P[12]),
  });
  const o = m(ptsO);
  const t = m(ptsT);
  const parts = {};
  for (const k of Object.keys(o)) parts[k] = t[k] > 0 ? o[k] / t[k] : NaN;
  return { ratio: median(Object.values(parts)), parts };
}

/** Gözlüklü şablonda yüz oranı: dört ölçünün medyanı. SAF. */
function eyewearFaceRatio({ landmark = null, faceArea = null, boxW = null, boxH = null } = {}) {
  const parts = { landmark, faceArea, boxW, boxH };
  return { ratio: median(Object.values(parts).filter((v) => v > 0)), parts };
}

/**
 * Yüz derisi + aksesuar alanı oranı (çıktı / şablon), çıktının yüz kutusunun
 * 3 katı kesitte (iki görüntü aynı kadraj uzayında). Hata/ölçüsüzlükte null.
 */
async function faceAreaRatio(oRgb, tRgb, W, H, box) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const side = Math.min(W, H, Math.round(Math.max(box.width, box.height) * 3));
  const left = Math.max(0, Math.min(W - side, Math.round(box.x + box.width / 2 - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round(box.y + box.height / 2 - side / 2)));
  const S = 512;
  const area = async (rgb) => {
    const raw = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
      .extract({ left, top, width: side, height: side }).resize(S, S).raw().toBuffer();
    const P = await classProbs(raw, S, S);
    let n = 0;
    for (let i = 0; i < S * S; i++) if (P[CLASSES.faceSkin][i] + P[CLASSES.others][i] > 0.5) n++;
    return n;
  };
  const ao = await area(oRgb);
  const at = await area(tRgb);
  return ao > 0 && at > 0 ? Math.sqrt(ao / at) : null;
}

/**
 * Algılanan kafa oranı: yüz ile toplam kafa hacminin geometrik ortalaması.
 * Hacim yoksa ya da yüzden çok sapıyorsa (karanlık sahne) yalnızca yüz. SAF.
 */
function perceivedHeadRatio(faceRatio, volRatio) {
  if (!(faceRatio > 0)) return { ratio: null, volUsed: false };
  if (!(volRatio > 0) || Math.abs(volRatio - faceRatio) > VOLUME_TRUST_MAX_DIFF) return { ratio: faceRatio, volUsed: false };
  // TERS YÖN (2026-10-09, iş f9f3b5c0 c1/c4): yüz büyük derken hacim küçük
  // diyorsa (şablonun gür/kıvırcık saçı ya da karanlık sahne) hacim kararı
  // çeviriyordu — c4 yüz 1.056 / hacim 0.863 kafayı BÜYÜTTÜ, c1 yüz 1.099 /
  // hacim 0.960 hiç küçültmedi; kullanıcı ikisinde de "küçülmeliydi" dedi.
  // Hacim yalnızca yüzle aynı yönü gösterdiğinde kullanılır.
  if ((faceRatio - 1) * (volRatio - 1) < 0) return { ratio: faceRatio, volUsed: false };
  // Küçültme yönünde yalnızca yüz (bkz. VOLUME_CEIL üstündeki not).
  if (faceRatio > 1) return { ratio: faceRatio, volUsed: false };
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
  // Hacim tavanı: büyütme toplam kafa hacmini şablondan belirgin büyük
  // bırakmasın.
  if (ph.volUsed && rawS > 1) rawS = Math.min(rawS, VOLUME_CEIL / volRatio);
  if (Math.abs(1 - rawS) < APPLY_MIN_DELTA) return { apply: false, reason: "within-tolerance", rawS, s: rawS, volUsed: ph.volUsed };
  const soft = rawS >= SOFT_MIN_SCALE ? rawS
    : rawS < RAMP_TRUST_MIN_RAW_S ? SOFT_MIN_SCALE
    : SOFT_MIN_SCALE - SCALE_RAMP * (SOFT_MIN_SCALE - rawS);
  return { apply: true, reason: null, rawS, s: Math.min(MAX_SCALE, Math.max(MIN_SCALE, soft)), volUsed: ph.volUsed };
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

// Ayrılabilir kutu bulanıklığı (yalnızca küçük bir pencere için): kenar
// yumuşatma. Tek kanallı Float32Array alır, aynı boyutta döner.
function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Kafayı ölçekler. Kişi katmanı (çıktının kafası + boynu) çene ortasında
 * sabit olarak s ile ölçeklenir; çene altında ölçek boyun boyunca yumuşakça
 * 1'e döner (boyun kafaya kesintisiz bağlanır, yaka/omuz kıpırdamaz). Arka
 * plan HİÇ bükülmez (f9f3b5c0 c6: eski liquify tabloyu/omuzları eğiyordu;
 * kullanıcı kuralı: "fotoğraftaki her şey sabit, sadece yüz değişir").
 *
 * Eski kişinin yeni kişiden taşan kısmının ARKASI yeniden kurulur:
 * şablonun arka plan olduğu yerde şablondan; şablonda kişi olan yerde
 * (saç, gözlük, yüz, boyun) çevredeki gerçek piksellerden doku kopyalanarak
 * (patchFill). Şablondan asla kişi pikseli gelmez (b8ae3f8d: şablonun
 * saçı/gözlüğü yeni kafanın arkasında ikinci kafa olarak kaldı); eski büyük
 * kafa da bırakılmaz. 2026-10-09 (03d6c1f6): ilk sürüm kafayı çene
 * hattından kesip yapıştırıyordu — eski çenenin yeri dolguyla kapanınca
 * boyunda gömlek/gökyüzü parçaları ve "yapıştırılmış kafa" görünümü çıktı.
 *
 * Kafaya el/nesne değiyorsa HİÇ dokunulmaz (kafayla birlikte ölçeklenirdi).
 * Doldurulacak delik çok kalınsa (doku kopyalama inandırıcı olmaz) yine
 * dokunulmaz.
 *
 * O/T: çıktı ve şablon RGB raw (aynı boyut). Mo/Mt: kişi olasılıkları.
 */
const TOUCH_MAX = 1.05;
// Şablon kişisi eşiği (sceneRestore ile aynı: saç teli/gözlük düşük
// olasılıkla görünür).
const T_PERSON_MIN = 0.08;
// En derin delik pikselinin kenara uzaklığı / yüz yüksekliği. AI dolgusu
// için de aynı sınır: derin delik çoğu zaman zayıf kişi maskesinden gelir ve
// yeni yüzün kendisini kapsar (03d6c1f6 c4: siyah-beyaz karanlık kare, AI
// yüzü sildi).
const FILL_DEPTH_MAX = 0.35;

const BG_FIELD_CELL = 4;
/**
 * Pencerenin (w x h, sol üst bx0, by0) alçak frekanslı arka plan alanı:
 * isKnown(x, y) piksellerinin hücre ortalamaları (BG_FIELD_CELL px), boş
 * hücreler çok ölçekli ortalamayla dolar. Dönüş: tam kare koordinatında
 * bilineer örnekleyici (gx, gy, c) ya da bilinen piksel yoksa null.
 */
function backgroundField(O, W, bx0, by0, w, h, isKnown) {
  const { pushPullField } = require("./sceneRestore");
  const C = BG_FIELD_CELL;
  const gw = Math.ceil(w / C);
  const gh = Math.ceil(h / C);
  const F = new Float32Array(gw * gh * 3);
  const n = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isKnown(x, y)) continue;
      const j = Math.floor(y / C) * gw + Math.floor(x / C);
      const g = ((y + by0) * W + x + bx0) * 3;
      n[j]++;
      for (let c = 0; c < 3; c++) F[j * 3 + c] += O[g + c];
    }
  }
  const known = new Uint8Array(gw * gh);
  let any = 0;
  for (let j = 0; j < gw * gh; j++) {
    if (n[j] < (C * C) / 4) continue;
    known[j] = 1;
    any++;
    for (let c = 0; c < 3; c++) F[j * 3 + c] /= n[j];
  }
  if (!any) return null;
  pushPullField(F, gw, gh, 3, known);
  return (gx, gy, c) => {
    const fx = Math.max(0, Math.min(gw - 1, (gx - bx0) / C - 0.5));
    const fy = Math.max(0, Math.min(gh - 1, (gy - by0) / C - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(gw - 1, x0 + 1);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    return (F[(y0 * gw + x0) * 3 + c] * (1 - ax) + F[(y0 * gw + x1) * 3 + c] * ax) * (1 - ay) +
      (F[(y1 * gw + x0) * 3 + c] * (1 - ax) + F[(y1 * gw + x1) * 3 + c] * ax) * ay;
  };
}

/**
 * Kafa bölgesi, pencere kesitinde (w x h) Uint8Array: çene hizasının
 * üstünde (sx, sy) tohumundan başlayan dolu kişi bileşeni (Mo >= 0.5), r
 * kadar genişletilmiş. Tohum kişi değilse null (çağıran eski davranışa
 * döner). SAF.
 */
function headZone(Mo, W, bx0, by0, w, h, sx, sy, chin, r) {
  const lx = sx - bx0;
  const ly = sy - by0;
  const yMax = Math.min(h - 1, Math.floor(chin - by0));
  if (lx < 0 || ly < 0 || lx >= w || ly > yMax || Mo[sy * W + sx] < 0.5) return null;
  const comp = new Uint8Array(w * h);
  comp[ly * w + lx] = 1;
  const stack = [ly * w + lx];
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yMax ? i + w : -1]) {
      if (j < 0 || comp[j]) continue;
      const jx = j % w;
      if (Mo[((j - jx) / w + by0) * W + jx + bx0] < 0.5) continue;
      comp[j] = 1;
      stack.push(j);
    }
  }
  const { chamfer } = require("./headSurround");
  const d = chamfer(comp, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

function scaleHeadPatch(O, T, Mo, Mt, W, H, sil, faceH, s, { deferInpaint = false } = {}) {
  const out = Buffer.from(O);
  const cx = sil.cx;
  const chin = sil.chin;
  const neck = Math.min(H - 1, Math.round(chin + 0.45 * faceH));
  const hy = (sil.top + chin) / 2;
  const ra = sil.headW / 2;
  const rb = sil.headH / 2;
  const EL = 1.3; // kafa bölgesi elips yarıçapı (saç dahil olsun)

  // Pencere: ölçekli ve ölçeksiz kafayı, boynu ve geçiş bandını kapsar.
  const reach = Math.max(s, 1 / s);
  const bx0 = Math.max(0, Math.floor(cx - (EL + 0.4) * ra * reach - 8));
  const bx1 = Math.min(W - 1, Math.ceil(cx + (EL + 0.4) * ra * reach + 8));
  const by0 = Math.max(0, Math.floor(chin - (chin - hy + EL * rb) * reach - 8));
  const by1 = Math.min(H - 1, neck + 2);
  const w = bx1 - bx0 + 1;
  const h = by1 - by0 + 1;
  if (w < 8 || h < 8) return { buf: out, moved: 0, neck };

  // Kafaya değen el/nesne kontrolü: burun hizasından geçen kesintisiz kişi
  // koşusu (saç dahil) tek başına bir kafada yüz yüksekliğini aşmaz; el,
  // kulaklık, başka biri bitişikse aşar (c6 0.143, c8: el + kulaklık).
  // BURUN UCUNDA BİTER (2026-10-10, 3cd612ba): ağız hizasındaki sigara (c1,
  // dokunma 1.55) ve kalkık palto yakası (c3, 1.15) kafaya değen el sayıldı,
  // ikisi de büyük kalan kafayı küçültmedi. Kulağa/şakağa değen el (c8)
  // burun hizasının üstünde de görünür.
  const seedX = Math.round(sil.seedX ?? sil.cx);
  const touchY1 = Math.round(Math.min(chin - 0.1 * faceH, sil.noseY ?? Infinity));
  let maxRun = 0;
  for (let y = Math.round(sil.top + 0.15 * (chin - sil.top)); y <= touchY1; y++) {
    if (y < 0 || y >= H || Mo[y * W + seedX] < 0.5) continue;
    let l = seedX;
    let r = seedX;
    while (l > 0 && Mo[y * W + l - 1] >= 0.5) l--;
    while (r < W - 1 && Mo[y * W + r + 1] >= 0.5) r++;
    if (r - l + 1 > maxRun) maxRun = r - l + 1;
  }
  const touch = maxRun / faceH;
  if (touch > TOUCH_MAX) return { buf: out, moved: 0, neck, touch, skipped: true };

  // Ölçek ağırlığı k(x, y): kafa bölgesinde 1, çene altında boyun boyunca
  // 1 -> 0; yanlarda geçiş bandında 1 -> 0. Ölçek = 1 - k(1 - s).
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const band = 0.4 * ra;
  const inX = (y) => {
    // Kafa elipsinin yarı genişliği; elipsin alt yarısında en az çene
    // hizasındaki genişlik (0.83 ra) — boyun sütunu buna bağlanır.
    const t = (y - hy) / rb;
    const e = Math.abs(t) < EL ? ra * Math.sqrt(EL * EL - t * t) : 0;
    return y >= hy ? Math.max(0.83 * ra, e) : e;
  };
  const K = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = y + by0;
    const kv = gy <= chin ? 1 : 1 - smooth((gy - chin) / Math.max(1, neck - chin));
    if (kv <= 0) continue;
    const xi = inX(Math.min(gy, chin));
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x + bx0 - cx);
      const kh = dx <= xi ? 1 : 1 - smooth((dx - xi) / band);
      K[y * w + x] = kv * kh;
    }
  }

  // YALNIZ KAFA (2026-10-12, e0eb8dd5 c8, kullanıcı: "kesin çözüm"): kişi
  // maskesi arkadaki insanları ve kafanın yanındaki koyu nesneleri (c2
  // şemsiye) düşük olasılıkla "kişi" görüyor; kafa ortasının üstündeki her
  // kişi pikseli kafa sayılınca onlar da küçültülüp deliğe giriyor, dolgu
  // onları siliyordu (c8 kafanın yanında lekeler, c2 kesik şemsiye). Çene
  // hizasının üstünde kafa = yüzden başlayan dolu kişi bileşeni, uçuşan tel
  // payı (eski izin genişletmesiyle aynı) kadar genişletilmiş.
  const strandR = Math.max(8, Math.round(0.07 * faceH));
  const zone = headZone(Mo, W, bx0, by0, w, h, seedX, Math.round(hy), chin, strandR);
  const inZone = (x, y) => !zone || y + by0 > chin || zone[y * w + x] === 1;

  // Elips yüz merkezlidir; yana dönük kafada ense saçı elipsin dışına taşar
  // ve K=0'da eski saç olduğu gibi kalır (03d6c1f6 c2: küçük kafanın
  // arkasında eski saç telleri). Kafa ortası hizasının üstündeki kişi
  // pikselleri yalnızca kafa/saçtır (omuz orada olamaz): bölgeye yumuşak
  // kenarla katılır.
  {
    let hz = new Float32Array(w * h);
    for (let y = 0; y < h && y + by0 <= hy; y++) {
      for (let x = 0; x < w; x++) if (Mo[(y + by0) * W + (x + bx0)] >= 0.04 && inZone(x, y)) hz[y * w + x] = 1;
    }
    const r = Math.max(3, Math.round(band / 4));
    hz = boxBlur(hz, w, h, r);
    for (let i = 0; i < w * h; i++) hz[i] = hz[i] > 0.02 ? 1 : 0;
    hz = boxBlur(hz, w, h, r);
    for (let y = 0; y < h; y++) {
      // Göz hizasının altına taşan bulanık kenar boyun bölgesine sızmasın.
      const kv = y + by0 <= chin ? 1 : 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = smooth(hz[i]) * kv;
        if (v > K[i]) K[i] = v;
      }
    }
  }

  // Kişi katmanı alfası (kaynak uzayı): kişi maskesinden doğrusal rampa.
  const pb = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inZone(x, y)) pb[y * w + x] = Math.max(0, Math.min(1, (Mo[(y + by0) * W + (x + bx0)] - 0.15) / 0.45));
  const soft = pb;
  const sampleA = (qx, qy) => {
    const x = qx - bx0;
    const y = qy - by0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return 0;
    const fx = x - x0;
    const fy = y - y0;
    return (soft[y0 * w + x0] * (1 - fx) + soft[y0 * w + x0 + 1] * fx) * (1 - fy) +
      (soft[(y0 + 1) * w + x0] * (1 - fx) + soft[(y0 + 1) * w + x0 + 1] * fx) * fy;
  };
  // Ters eşleme (hedef p -> kaynak q): ölçek çene ortasında sabit; çene
  // altında yalnızca yatay. Yeni kişi alfası hedef uzayında.
  const A = new Float32Array(w * h);
  const QX = new Float32Array(w * h);
  const QY = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (K[i] <= 0) continue;
      const sc = 1 - K[i] * (1 - s);
      const gx = x + bx0;
      const gy = y + by0;
      QX[i] = cx + (gx - cx) / sc;
      QY[i] = gy <= chin ? chin + (gy - chin) / sc : gy;
      A[i] = sampleA(QX[i], QY[i]);
    }
  }

  // Eski kişi izi (değişen bölgede, saç teli dahil biraz genişletilmiş).
  let old = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (K[y * w + x] > 0.01 && Mo[(y + by0) * W + (x + bx0)] >= 0.04 && inZone(x, y)) old[y * w + x] = 1;
    }
  }
  // Uçuşan saç telleri maske eşiğinin altında kalıp 8 px ötesine uzanır
  // (03d6c1f6 c2: küçülen kafanın üstünde eski telin ince çizgisi).
  old = boxBlur(old, w, h, strandR);
  for (let i = 0; i < w * h; i++) old[i] = old[i] > 0.02 && K[i] > 0.01 ? 1 : 0;
  const oldSoft = boxBlur(old, w, h, 2);
  for (let i = 0; i < w * h; i++) if (K[i] <= 0.01) oldSoft[i] = 0;

  // Şablon kişisi (genişletilmiş): oradan şablon pikseli ALINMAZ. Koyu
  // saç koyu zeminde maskeden ~10 px taşar (03d6c1f6 c2: sütun önündeki
  // şablon saçı arka plan sanılıp kopyalandı) — genişletme yüzle ölçeklenir.
  let tPer = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Mt[(y + by0) * W + (x + bx0)] >= T_PERSON_MIN) tPer[y * w + x] = 1;
    }
  }
  tPer = boxBlur(tPer, w, h, Math.max(4, Math.round(0.07 * faceH)));
  for (let i = 0; i < w * h; i++) tPer[i] = tPer[i] > 0.02 ? 1 : 0;

  // Arka plan katmanı F: eski izin altında şablon arka planı ya da doku
  // dolgusu; izin dışında çıktının kendisi.
  const F = Buffer.from(O);
  const hole = new Uint8Array(W * H);
  // Açılan yer daima kişinin ARKASI: kaynak parça yalnızca arka plandan
  // gelir (03d6c1f6 c2: gövdedeki siyah ceket dokusu kafanın arkasına
  // kopyalandı).
  const banned = new Uint8Array(W * H);
  for (let g = 0; g < W * H; g++) if (Mo[g] >= 0.04) banned[g] = 1;
  let holePx = 0;
  let headArea = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (old[i]) headArea++;
      const os = oldSoft[i];
      if (os <= 0.003) continue;
      const g = (y + by0) * W + (x + bx0);
      if (tPer[i]) {
        // Yeni kişinin tamamen örttüğü yer doldurulmaz; bağlam da olamaz
        // (orada şablon kişisi ya da eski kafa durur).
        if (A[i] < 0.98) { hole[g] = 1; holePx++; } else banned[g] = 1;
        continue;
      }
      for (let c = 0; c < 3; c++) F[g * 3 + c] = Math.round(O[g * 3 + c] * (1 - os) + T[g * 3 + c] * os);
    }
  }
  // Saç kenarı halkası: kişi maskesi eşiğinin altında kalan yumuşak saç
  // kenarı (şablonun da çıktının da) birkaç piksel koyu kalır. Bilinen
  // bağlam sayılırsa dolgu bu koyu tohumu içeri doğru büyütür (03d6c1f6 c2:
  // kafanın arkasında siyah, karo desenli blok). Delik eski iz içinde bu
  // halka kadar dışa genişletilir; eski kafaya bu mesafedeki pikseller de
  // kaynak olamaz.
  const RIM = Math.max(4, Math.round(0.03 * faceH));
  if (holePx) {
    let ring = hole;
    for (let k = 0; k < RIM; k++) {
      const next = Uint8Array.from(ring);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const g = (y + by0) * W + (x + bx0);
          if (ring[g] || banned[g] || oldSoft[y * w + x] <= 0.003) continue;
          if ((x > 0 && ring[g - 1]) || (x < w - 1 && ring[g + 1]) || (y > 0 && ring[g - W]) || (y < h - 1 && ring[g + W])) next[g] = 1;
        }
      }
      ring = next;
    }
    for (let g = 0; g < W * H; g++) if (ring[g] && !hole[g]) { hole[g] = 1; holePx++; }
  }
  {
    let near = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Mo[(y + by0) * W + (x + bx0)] >= 0.04) near[y * w + x] = 1;
    near = boxBlur(near, w, h, RIM);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (y + by0) * W + (x + bx0);
        if (near[y * w + x] > 0.001 && !hole[g]) banned[g] = 1;
      }
    }
  }
  // Delik derinliği (kenara en uzak delik pikseli, şehir-blok uzaklığı).
  let holeDepth = 0;
  let seam = 0;
  let seamHi = 0;
  let Fpre = null; // doku dolgusunun kenar geçişi öncesi hâli (AI dolgusu için)
  if (holePx) {
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[(y + by0) * W + x + bx0]) d[y * w + x] = 1e9;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
        if (y > 0) d[i] = Math.min(d[i], d[i - w] + 1);
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
        if (y < h - 1) d[i] = Math.min(d[i], d[i + w] + 1);
        if (d[i] > holeDepth && d[i] < 1e8) holeDepth = d[i];
      }
    }
    if (holeDepth > FILL_DEPTH_MAX * faceH) {
      return { buf: out, moved: 0, neck, touch, skipped: true, reason: "fill-too-deep", holePx, holeDepth };
    }
    const fillStats = {};
    patchFill(F, W, H, hole, banned, { searchR: Math.max(40, Math.round(0.5 * faceH)), stats: fillStats });
    seam = fillStats.seam;
    seamHi = fillStats.seamHi;
    if (deferInpaint) Fpre = Buffer.from(F);
    // İz kenarındaki yumuşak geçiş: dışı çıktının kendi arka planı.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (y + by0) * W + (x + bx0);
        const os = oldSoft[y * w + x];
        if (!hole[g] || os >= 1) continue;
        for (let c = 0; c < 3; c++) F[g * 3 + c] = Math.round(O[g * 3 + c] * (1 - os) + F[g * 3 + c] * os);
      }
    }
  }

  // SAÇ KENARINDAKİ ESKİ ARKA PLAN (2026-10-12, e0eb8dd5 c4 denemesi):
  // kafanın yumuşak kenar pikseli saç ile ESKİ konumdaki arka planın
  // karışımı. Kafa küçülünce piksel içeri taşınır, altına başka zemin gelir;
  // eski zeminin payı kenarda açık/koyu pus olarak kalıyordu (açık duvarın
  // önündeki saç tavana taşındı). Bölmesiz düzeltme: kenar pikseline
  // (1 - alfa) x (yeni konumdaki zemin - eski konumdaki zemin) eklenir; zemin
  // eski izin dışındaki gerçek arka plandan alçak frekansla kestirilir.
  const bgAt = backgroundField(O, W, bx0, by0, w, h, (x, y) => old[y * w + x] === 0 && Mo[(y + by0) * W + x + bx0] < 0.04);
  let moved = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (K[i] <= 0) continue;
      const na = A[i];
      if (oldSoft[i] <= 0.003 && na < 0.003) continue;
      const gi = ((y + by0) * W + (x + bx0)) * 3;
      moved++;
      const edge = na > 0.003 && na < 0.997 && bgAt ? 1 - na : 0;
      for (let c = 0; c < 3; c++) {
        let hv = bilinear(O, W, H, QX[i], QY[i], c);
        if (edge) hv += edge * (bgAt(x + bx0, y + by0, c) - bgAt(QX[i], QY[i], c));
        const v = F[gi + c] * (1 - na) + hv * na;
        out[gi + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  let inpaint = null;
  // Yeni kafa (çene hizasına kadar, katman alfası >= 0.5). Yerel dolgu
  // modeline bağlam olarak verilmez (saçı deliğe doğru uzatır, bkz.
  // lamaFill.js); kafa çevresi şeridi de deliğin içinde YALNIZ bunu korur —
  // delikteki doku dolgusu artığını sınıflandırıcı "saç" sanabiliyor
  // (e0eb8dd5 c4 denemesi: saçın üstünde açık leke).
  let head = null;
  if (holePx) {
    head = new Uint8Array(W * H);
    for (let y = 0; y < h && y + by0 <= chin; y++) {
      for (let x = 0; x < w; x++) if (A[y * w + x] >= 0.5) head[(y + by0) * W + (x + bx0)] = 1;
    }
  }
  if (Fpre) {
    // Dolgunun pikseli bileşime doğrusal girer: delik pikselinde
    // out = (O(1-os) + P*os)(1-na) + kafa*na, P = dolgu. P değişince
    // out += os(1-na)(P' - P).
    const wgt = new Float32Array(W * H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (y + by0) * W + (x + bx0);
        if (hole[g]) wgt[g] = oldSoft[y * w + x] * (1 - A[y * w + x]);
      }
    }
    inpaint = prepareInpaint(out, Fpre, W, H, hole, banned, wgt, head);
  }
  return { buf: out, moved, neck, touch, sEff: s, anchorY: chin, exposed: holePx / Math.max(1, headArea), holePx, holeDepth, seam, seamHi, inpaint, holeMask: holePx ? hole : null, headMask: head };
}

// AI DOLGUSU (2026-10-09, kullanıcı kararı: "OpenAI maskeli düzenleme").
// Doku dolgusu sade arka planda (gökyüzü, düz duvar, yaprak) temiz, ama
// yapılı arka planda (perde çizgisi, tabela yazısı, tavan şeridi) yamalı
// görünüyor ve bunu ölçüyle ayırmak mümkün olmadı. Delik çevresi kare
// kırpılıp maskeyle görsel modele verilir; dönen görselden YALNIZCA delik
// pikselleri alınır — fotoğrafın geri kalanı bit bit aynı kalır.
const INPAINT_SIZE = 1024;
// Modelin renk/parlaklık kayması: delik çevresindeki bilinen arka plan
// halkasında ölçülür, yumuşak bir düzeltme alanıyla deliğe taşınır. Kayma
// ya da düzeltme sonrası kalan fark bu sınırları aşarsa model arka planı
// değiştirmiş demektir: sonuç kullanılmaz.
const INPAINT_SHIFT_MAX = 12;
// Halka pikseli "uyuyor": ortalama kanal farkı (global kayma düşülünce) bu
// değerin altında. Kenar halkasında uymayan pay INPAINT_EDGE_BAD_MAX'ı ya da
// halkanın yarısını aşarsa dolgu kullanılmaz.
const INPAINT_INLIER = 30;
const INPAINT_EDGE_BAD_MAX = 0.08;
// Delikte modelin çizdiği kişi payı (bileşim ağırlıklı kişi olasılığı).
// Model kırpımdaki kişiyi de yeniden çiziyor ve kafayı çoğu zaman eski,
// büyük boyunda çiziyor; delik kafanın hemen yanında olduğu için o kafanın
// kenarı (burun, dudak, saç) yeni kafanın yanında saydam bir profil olarak
// kalıyordu (61079257 c6, 2026-10-09). Ölçülen: izli kareler 0.069/0.070,
// temizler ≤ 0.043.
// KADEMELİ (2026-10-10, b602b4b0 c0: pay 0.126, kare hiç küçültülmedi,
// kullanıcı "küçültmeliydin"): modelin kişi çizdiği delik piksellerinde AI
// pikseli alınmaz, doku dolgusu kalır; yalnızca deliğin bu kadarından
// fazlası kişiyse dolgu bütünüyle reddedilir.
const INPAINT_PERSON_PX = 0.15; // piksel kişi sayılır (AI çıktısında olasılık)
const INPAINT_PERSON_MAX = 0.5; // bundan fazlası kişiyse dolgu kullanılmaz

function prepareInpaint(out, Fpre, W, H, hole, banned, wgt, head = null) {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!hole[y * W + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const side = Math.min(W, H, Math.max(256, Math.round(span * 1.6) + 96));
  const left = Math.max(0, Math.min(W - side, Math.round((x0 + x1) / 2 - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round((y0 + y1) / 2 - side / 2)));
  const N = side * side;
  const rgb = Buffer.alloc(N * 3);
  const holeC = new Uint8Array(N);
  const ringOk = new Uint8Array(N);
  const wC = new Float32Array(N);
  const PC = new Float32Array(N * 3);
  const headC = head ? new Uint8Array(N) : null;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const g = (y + top) * W + (x + left);
      const i = y * side + x;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = out[g * 3 + c];
      if (headC && head[g]) headC[i] = 1;
      if (hole[g]) {
        holeC[i] = 1;
        wC[i] = wgt[g];
        for (let c = 0; c < 3; c++) PC[i * 3 + c] = Fpre[g * 3 + c];
      } else if (!banned[g]) ringOk[i] = 1;
    }
  }
  return { out, W, H, left, top, side, rgb, holeC, ringOk, wC, PC, headC };
}

/** Modele gidecek kırpım (PNG) ve maske (PNG, şeffaf = doldur). */
async function encodeInpaint(job) {
  const S = INPAINT_SIZE;
  const { side } = job;
  const image = await sharp(job.rgb, { raw: { width: side, height: side, channels: 3 } })
    .resize(S, S, { kernel: "lanczos3" }).png().toBuffer();
  // Maske 3 px genişletilir: model kenarı da yeniden çizsin, biz yalnızca
  // deliği alırız.
  let m = new Float32Array(side * side);
  for (let i = 0; i < m.length; i++) m[i] = job.holeC[i];
  m = boxBlur(m, side, side, Math.max(3, Math.round(side / 60)));
  const a = Buffer.alloc(side * side * 4);
  for (let i = 0; i < side * side; i++) {
    a[i * 4 + 3] = m[i] > 0.001 ? 0 : 255;
  }
  const mask = await sharp(a, { raw: { width: side, height: side, channels: 4 } })
    .resize(S, S, { kernel: "nearest" }).png().toBuffer();
  return { image, mask };
}

/**
 * Model çıktısını deliğe yerleştirir. Dönüş: { buf, shift, resid } ya da
 * kayma/fark sınırı aşılırsa { buf: null, reason, shift, resid }.
 */
async function finishInpaint(job, aiBuf, baseJpeg) {
  const { side, W, left, top } = job;
  const N = side * side;
  const { data: ai } = await sharp(aiBuf).removeAlpha()
    .resize(side, side, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  // Halka: deliğe yakın bilinen arka plan. Model maskeye sıkı uymuyor —
  // kırpımın tamamını yeniden çiziyor, arka plandaki kişileri/nesneleri
  // silebiliyor (bb2cc441 c3). Bu yüzden halkanın tamamı değil, yalnızca
  // modelin aslına UYDUĞU pikselleri renk düzeltmesine girer; uymayan
  // pikseller düzeltme alanını deliğe leke olarak taşıyordu.
  const R = Math.max(6, Math.round(side / 40));
  let near = new Float32Array(N);
  for (let i = 0; i < N; i++) near[i] = job.holeC[i];
  const near1 = boxBlur(near, side, side, R);
  near = boxBlur(near, side, side, 2 * R);
  const ring = new Uint8Array(N);
  let rn = 0;
  let shift = 0;
  const gm = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (!job.ringOk[i] || near[i] <= 0.001) continue;
    ring[i] = 1;
    rn++;
    for (let c = 0; c < 3; c++) {
      const d = job.rgb[i * 3 + c] - ai[i * 3 + c];
      shift += Math.abs(d);
      gm[c] += d;
    }
  }
  if (rn < 50) return { buf: null, reason: "inpaint-no-ring", shift: null, resid: null };
  shift /= rn * 3;
  for (let c = 0; c < 3; c++) gm[c] /= rn;
  const rw = new Float32Array(N);
  let inl = 0;
  for (let i = 0; i < N; i++) {
    if (!ring[i]) continue;
    let e = 0;
    for (let c = 0; c < 3; c++) e += Math.abs(job.rgb[i * 3 + c] - ai[i * 3 + c] - gm[c]);
    if (e / 3 < INPAINT_INLIER) { rw[i] = 1; inl++; }
  }
  // Düzeltme alanı: uyan halka pikselindeki farkın normalize evrişimi (dar
  // ölçek yerel kaymayı, geniş ölçek boşlukları kapatır).
  const corr = [];
  const den1 = boxBlur(rw, side, side, 2 * R);
  const den2 = boxBlur(rw, side, side, 8 * R);
  for (let c = 0; c < 3; c++) {
    const d = new Float32Array(N);
    for (let i = 0; i < N; i++) if (rw[i]) d[i] = job.rgb[i * 3 + c] - ai[i * 3 + c];
    const n1 = boxBlur(d, side, side, 2 * R);
    const n2 = boxBlur(d, side, side, 8 * R);
    const k = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      k[i] = den1[i] > 0.02 ? n1[i] / den1[i] : den2[i] > 0.002 ? n2[i] / den2[i] : gm[c];
    }
    corr.push(k);
  }
  // Deliğin hemen kenarında (R içinde) düzeltme sonrası aslına uymayan
  // piksel payı: model orada yapıyı değiştirdiyse (silinen nesne, kaymış
  // çizgi) dolgu kenarda kopuk görünür.
  let en = 0;
  let bad = 0;
  for (let i = 0; i < N; i++) {
    if (!ring[i] || near1[i] <= 0.001) continue;
    en++;
    let e = 0;
    for (let c = 0; c < 3; c++) e += Math.abs(job.rgb[i * 3 + c] - (ai[i * 3 + c] + corr[c][i]));
    if (e / 3 > INPAINT_INLIER) bad++;
  }
  const resid = en ? bad / en : 1;
  // Delikte modelin çizdiği KİŞİ payı (bileşim ağırlığıyla).
  const Pai = await personMask(ai, side, side);
  let pw = 0;
  let pp = 0;
  for (let i = 0; i < N; i++) {
    if (!job.holeC[i]) continue;
    pw += job.wC[i];
    pp += job.wC[i] * Pai[i];
  }
  const person = pw > 0 ? pp / pw : 0;
  if (shift > INPAINT_SHIFT_MAX || resid > INPAINT_EDGE_BAD_MAX || inl < rn * 0.5) {
    return { buf: null, reason: "inpaint-mismatch", shift, resid, person };
  }
  // Kişi çizilen pikseller (genişletilip yumuşatılmış): orada doku dolgusu
  // kalır. Saç teli ve kenar yumuşaması maske eşiğinin altında kaldığı için
  // genişletme kenar halkası kadar.
  // Yumuşak yedekte genişletme dar: geniş halka kafanın çevresini baştan
  // sona enterpolasyona çevirip bulanık hale bırakıyordu (d44b63e8 c5 denemesi).
  const pr = job.smoothFallback ? Math.max(2, R >> 2) : R;
  let pm = new Float32Array(N);
  for (let i = 0; i < N; i++) pm[i] = Pai[i] >= INPAINT_PERSON_PX ? 1 : 0;
  pm = boxBlur(pm, side, side, pr);
  for (let i = 0; i < N; i++) pm[i] = pm[i] > 0.01 ? 1 : 0;
  pm = boxBlur(pm, side, side, Math.max(2, pr >> 1));
  // allowAi (saçak temizliği): yeni kafanın hemen dibinde modelin çizdiği saç
  // yeni kafanın kendi kenarıdır, AI pikseli kabul edilir.
  if (job.allowAi) for (let i = 0; i < N; i++) pm[i] *= 1 - job.allowAi[i];
  let kept = 0;
  for (let i = 0; i < N; i++) if (job.holeC[i]) kept += job.wC[i] * pm[i];
  const fallback = pw > 0 ? kept / pw : 0;
  if (fallback > (job.personMax ?? INPAINT_PERSON_MAX)) return { buf: null, reason: "inpaint-person", shift, resid, person, fallback };
  // smoothFallback (kafa çevresi, bkz. headSurround.js): AI'nin kişi çizdiği
  // piksel doku yaması yerine çevresindeki kabul edilen AI ve gerçek
  // piksellerden yumuşak enterpolasyonla kapanır — yama sınırı basamak
  // bırakıyordu (d44b63e8 c2/c4/c5).
  let FB = job.PC;
  if (job.smoothFallback) {
    const { pushPullField } = require("./sceneRestore");
    FB = new Float32Array(N * 3);
    const known = new Uint8Array(N);
    // Bilinen: kişi olmayan AI pikselleri ve delik dışındaki kişi olmayan
    // gerçek pikseller (kafanın rengi enterpolasyona girmesin).
    for (let i = 0; i < N; i++) {
      if (job.holeC[i]) {
        if (pm[i] > 0.01 || Pai[i] >= INPAINT_PERSON_PX) continue;
        for (let c = 0; c < 3; c++) FB[i * 3 + c] = ai[i * 3 + c] + corr[c][i];
      } else {
        if (!job.ringOk[i]) continue;
        for (let c = 0; c < 3; c++) FB[i * 3 + c] = job.rgb[i * 3 + c];
      }
      known[i] = 1;
    }
    pushPullField(FB, side, side, 3, known);
  }
  const res = job.out ? Buffer.from(job.out) : await sharp(baseJpeg).removeAlpha().raw().toBuffer();
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      if (!job.holeC[i]) continue;
      const g = (y + top) * W + (x + left);
      const wAi = job.wC[i] * (1 - pm[i]);
      const wFb = job.wC[i] * pm[i];
      for (let c = 0; c < 3; c++) {
        const v = res[g * 3 + c] + wAi * (ai[i * 3 + c] + corr[c][i] - job.PC[i * 3 + c]) + wFb * (FB[i * 3 + c] - job.PC[i * 3 + c]);
        res[g * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  const buf = await sharp(res, { raw: { width: W, height: job.H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return { buf, shift, resid, person, fallback };
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
async function correctHeadScale(outputBuf, templateBuf, { deferInpaint = false, templateEyewear = false } = {}) {
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
  let lr = landmarkSizeRatio(lo.pts, lt.pts);
  const centre = (P) => ({ x: P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17, y: P.slice(0, 17).reduce((q, p) => q + p.y, 0) / 17 });
  const co = centre(lo.pts);
  const ct = centre(lt.pts);
  const tplFaceW = Math.hypot(lt.pts[0].x - lt.pts[16].x, lt.pts[0].y - lt.pts[16].y);
  const faceShift = tplFaceW > 0 ? Math.hypot(co.x - ct.x, co.y - ct.y) / tplFaceW : Infinity;
  let volRatio = null;
  if (templateEyewear) {
    // Gözlüklü şablon: göz/kaş noktaları yok, hacim yok (bkz. eyewearFaceRatio).
    let faceArea = null;
    try {
      faceArea = await faceAreaRatio(o.data, t.data, o.W, o.H, lo.box);
    } catch (e) {
      console.error("Yüz alanı ölçülemedi (gözlüklü şablon):", e.message || e);
    }
    lr = eyewearFaceRatio({
      landmark: eyeFreeLandmarkRatio(lo.pts, lt.pts).ratio,
      faceArea,
      boxW: lt.box.width > 0 ? lo.box.width / lt.box.width : null,
      boxH: lt.box.height > 0 ? lo.box.height / lt.box.height : null,
    });
  } else {
    try {
      volRatio = await headVolumeRatio(o.data, t.data, o.W, o.H, lo.box, lt.box);
    } catch (e) {
      console.error("Kafa hacmi ölçülemedi (yalnızca yüz ölçüsü):", e.message || e);
    }
  }
  const plan = planLandmarkScale(lr.ratio, { bodyIou, faceShift, volRatio });
  const info = { s: plan.s ?? null, rawS: plan.rawS ?? null, faceRatio: lr.ratio, parts: lr.parts, volRatio, volUsed: plan.volUsed ?? false, bodyIou, faceShift, eyewear: templateEyewear };
  if (!plan.apply) return { buf: null, applied: false, reason: plan.reason, ...info };
  if (templateEyewear && plan.s > 1) return { buf: null, applied: false, reason: "eyewear-no-enlarge", ...info };

  // Dönüşüm geometrisi: silüetten kafa tepesi/genişliği; çene ve merkez
  // yüz noktalarından (kutu çeneyi sakalın üstünde bitiriyordu).
  const so = measureSilhouette(Mo, o.W, o.H, lo.box);
  const base = so.ok ? so : approxSilFromFaceBox(lo.box);
  const P = lo.pts;
  const chin = Math.round(P[8].y);
  const cx = Math.round(P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17);
  const sil = { ...base, cx, seedX: Math.round(P[30].x), noseY: P[33].y, jaw: P.slice(0, 17), chin: Math.max(base.chin, chin), headH: Math.max(base.chin, chin) - base.top };
  const faceH = Math.max(lo.box.height, chin - lo.box.y);
  const r = scaleHeadPatch(o.data, t.data, Mo, Mt, o.W, o.H, sil, faceH, plan.s, { deferInpaint });
  if (r.skipped) return { buf: null, applied: false, reason: r.reason || "head-touched", touch: r.touch, sEff: r.sEff ?? null, ...info };
  const buf = await sharp(r.buf, { raw: { width: o.W, height: o.H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const head = { cx: sil.cx, cy: (sil.top + sil.chin) / 2, rx: sil.headW / 2, ry: sil.headH / 2, chin: sil.chin, neck: r.neck };
  // deferInpaint: buf doku dolgulu hâl; çağıran deliği yerel modelle doldurur
  // (lamaFill.finishInpaintLama(job, base); 2026-10-12'ye kadar OpenAI).
  let inpaint = null;
  if (r.inpaint) {
    const job = r.inpaint;
    // Tam çözünürlüklü ham kopya dolgu boyunca tutulmasın (bellek); dolgu
    // JPEG'i yeniden açar.
    job.out = null;
    // job/base: worker iş parçacığına taşınabilir hâl (bkz. postTasks.js).
    inpaint = { rect: { left: job.left, top: job.top, side: job.side }, job, base: buf };
  }
  return { buf, applied: true, reason: null, inpaint, holeMask: r.holeMask, headMask: r.headMask, ...info, s: r.sEff ?? plan.s, planS: plan.s, anchorY: r.anchorY, exposed: r.exposed, holePx: r.holePx, holeDepth: r.holeDepth, seam: r.seam, seamHi: r.seamHi, head, movedPx: r.moved, silReason: so.ok ? null : so.reason };
}

// KAFA SAÇAĞI TEMİZLİĞİ (2026-10-10, 790bd56b c0, kullanıcı: "base fotodan
// herhangi bir silüet kalmamalı"). Model, şablon kişisinin kabarık/kıvırcık
// saçının ince tellerini yeni kafanın üstünde perde önünde bırakıyor; kalıntı
// kapısı (Vision) hafif telleri çoğunlukla görmüyor (1/6). Segmentasyon bu
// telleri kafanın "saçağı" olarak işaretliyor: maskenin dolu gövdesi (morfolojik
// açma — ince yapılar silinir) dışında kalan saçak + şablon kafasının kapladığı
// ama yeni kafanın kapsamadığı alan, çene hizasının üstünde, arka planla
// yeniden boyanır (kafa küçültmedeki AI dolgusunun aynısı; model orada kişi
// çizerse doku dolgusu kalır).
const FRINGE_OPEN_FACE = 0.08; // açma yarıçapı, yüz genişliğine oranla
const FRINGE_PERSON_MIN = 0.15; // saçak sayılan en düşük kişi olasılığı
const FRINGE_RING_FACE = 0.25; // dolu kafanın çevresindeki halka, yüz genişliğine oranla
const FRINGE_ALLOW_FACE = 0.06; // kafanın dibinde AI saçının kabul edildiği bant
const FRINGE_FADE_FACE = 0.2; // çene hizasına yaklaşırken karışım bandı
const FRINGE_MIN_HOLE_FACE2 = 0.02; // bundan küçük delik (yüz alanına oranla) boyanmaz
// Arka plan geri yüklendiyse bu katman çalışmaz; kafanın çevresini
// headSurround.js temizler (2026-10-11). Burası geri yükleme yapılamayan
// kareler için.
async function prepareHeadFringeRepaint(outputBuf, templateBuf) {
  const { faceLandmarks } = require("./faceQuality");
  const o = await rawRgb(outputBuf);
  const t = await rawRgb(templateBuf, o.W, o.H);
  const { W, H } = o;
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  if (!lo) return { applied: false, reason: "no-face-output" };
  const [Mo, Mt] = await Promise.all([personMask(o.data, W, H), personMask(t.data, W, H)]);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < Mo.length; i++) {
    const a = Mo[i] >= 0.5;
    const b = Mt[i] >= 0.5;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  const bodyIou = uni ? inter / uni : 0;
  // Şablon aynı kadrajda değilse "şablon kafasının alanı" anlamsız.
  if (bodyIou < BODY_ALIGNED_IOU) return { applied: false, reason: "not-aligned", bodyIou };
  const P = lo.pts;
  const faceW = Math.max(lo.box.width, Math.hypot(P[0].x - P[16].x, P[0].y - P[16].y));
  const chin = P[8].y;
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const bx0 = Math.max(0, Math.round(cx - 2 * faceW));
  const bx1 = Math.min(W - 1, Math.round(cx + 2 * faceW));
  const by0 = Math.max(0, Math.round(lo.box.y - 2.2 * faceW));
  const by1 = Math.min(H - 1, Math.round(chin));
  const w = bx1 - bx0 + 1;
  const h = by1 - by0 + 1;
  if (w < 16 || h < 16) return { applied: false, reason: "tiny" };
  const ringR = Math.max(4, Math.round(FRINGE_RING_FACE * faceW));
  // YALNIZ KAFA (2026-10-10, 3cd612ba c8): kişi maskesi kafayı elden/koldan
  // ayırmıyor — delik şablonun kolunu, elini ve omzunu da kapsadı (c8 elin
  // yanında hayalet, tavandaki ışık şeridi kafaya uzatıldı; c6 d2 omuz
  // hizasında yatay bant). Şablon tarafından yalnız kafa sınıfları (saç, yüz
  // derisi, aksesuar: gözlük/kulaklık) alınır; saçak ve halka yeni kafanın
  // yakınıyla sınırlanır.
  // YARI SAYDAM HAYALET (aynı iş, c9 d2): şablon saçının gri silüeti kişi
  // maskesinde 0.4-0.95 (dolu gövde sayılıp korunuyordu, üstü düz kesik blok
  // kaldı) ama çok sınıflı model 8136 pikselin hepsine "arka plan" dedi;
  // gerçek saçta saç 1.0. Kaşların üstünde kişi maskesinde olup çok sınıflı
  // modelde arka plan olan piksel dolu gövdeye katılmaz (kalkık koldaki
  // kıyafet "clothes" — dokunulmaz). Sınıflandırma başarısızsa eski davranış.
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  let headT = null;
  let nearHead = null;
  let ghost = null;
  let ghostPx = 0;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const hc = Math.max(16, Math.min(h, Math.round(chin) - by0 + 1));
    const crop = async (rgb) => sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
      .extract({ left: bx0, top: by0, width: w, height: hc }).raw().toBuffer();
    const headOf = (P) => {
      const m = new Float32Array(w * h);
      for (let i = 0; i < w * hc; i++) m[i] = P[CLASSES.hair][i] + P[CLASSES.faceSkin][i] + P[CLASSES.others][i] >= 0.5 ? 1 : 0;
      return m;
    };
    const Po = await classProbs(await crop(o.data), w, hc);
    const headO = headOf(Po);
    ghost = new Uint8Array(w * h);
    for (let y = 0; y < hc && y + by0 < browY; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Mo[(y + by0) * W + x + bx0] < FRINGE_PERSON_MIN) continue;
        if (headO[i] || Po[CLASSES.background][i] < 0.5) continue;
        ghost[i] = 1;
        ghostPx++;
      }
    }
    const Pt = await classProbs(await crop(t.data), w, hc);
    headT = headOf(Pt);
    nearHead = boxBlur(headO, w, h, ringR);
  } catch (e) {
    console.error("Kafa saçağı: sınıflandırma başarısız (tüm kişi maskesi kullanılıyor):", e.message || e);
  }
  // Yerel kesitte dolu gövde: açma (aşındır + genişlet).
  const r = Math.max(2, Math.round(FRINGE_OPEN_FACE * faceW));
  const A = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) A[y * w + x] = Mo[(y + by0) * W + x + bx0] >= 0.5 && !(ghost && ghost[y * w + x]) ? 1 : 0;
  let solid = boxBlur(A, w, h, r);
  for (let i = 0; i < solid.length; i++) solid[i] = solid[i] >= 0.999 ? 1 : 0;
  solid = boxBlur(solid, w, h, r);
  for (let i = 0; i < solid.length; i++) solid[i] = solid[i] > 0.001 ? 1 : 0;
  // Yeni kafanın gerçek kenarı korunur: dolu gövdenin 2 px çevresine dokunulmaz.
  let guard = boxBlur(solid, w, h, 2);
  // En soluk teller segmentasyonda kişi bile sayılmıyor (790bd56b c0 ilk
  // deneme: dıştaki teller delik dışında kaldı) — dolu kafanın çevresindeki
  // sabit halka da deliğe girer.
  let ring = boxBlur(solid, w, h, ringR);
  const hole = new Uint8Array(W * H);
  const banned = new Uint8Array(W * H);
  let holePx = 0;
  let fringePx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = (y + by0) * W + x + bx0;
      if (guard[i] > 0.001) { banned[g] = 1; continue; }
      const near = !nearHead || nearHead[i] > 0.001;
      const fringe = near && Mo[g] >= FRINGE_PERSON_MIN;
      const tplOnly = headT ? headT[i] > 0 : Mt[g] >= 0.5;
      if (fringe || tplOnly || (near && ring[i] > 0.001)) {
        hole[g] = 1;
        holePx++;
        if (fringe) fringePx++;
      }
    }
  }
  // Doku dolgusu kişi gibi görünen hiçbir pikseli kaynak almasın (tel kopyalıyordu).
  for (let g = 0; g < W * H; g++) if (!hole[g] && (Mo[g] >= FRINGE_PERSON_MIN || Mt[g] >= 0.5)) banned[g] = 1;
  guard = null;
  ring = null;
  nearHead = null;
  ghost = null;
  headT = null;
  if (holePx < FRINGE_MIN_HOLE_FACE2 * faceW * faceW) return { applied: false, reason: "no-fringe", holePx, fringePx, ghostPx, bodyIou };
  // Doku dolgusu: AI'nin kişi çizdiği piksellerde yedek, başarısızlıkta kullanılmaz.
  const F = Buffer.from(o.data);
  patchFill(F, W, H, hole, banned, { searchR: Math.max(40, Math.round(0.6 * faceW)) });
  // Delik çene hizasında kesiliyor; alt kenarda dolgu orijinale yumuşakça
  // karışır (790bd56b c1: kesik çizgide beyaz parça kalıyordu).
  const fadeH = Math.max(4, FRINGE_FADE_FACE * faceW);
  const wgt = new Float32Array(W * H);
  const out = Buffer.from(o.data);
  for (let g = 0; g < W * H; g++) {
    if (!hole[g]) continue;
    const y = Math.floor(g / W);
    const wv = Math.max(0, Math.min(1, (by1 - y) / fadeH));
    wgt[g] = wv;
    for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.round(o.data[g * 3 + c] * (1 - wv) + F[g * 3 + c] * wv);
  }
  const job = prepareInpaint(out, F, W, H, hole, banned, wgt);
  // Kafanın dibindeki bantta modelin çizdiği saç yeni kafanın kenarıdır;
  // orada doku dolgusuna düşmek saçın üstünde açık yama bırakıyordu
  // (790bd56b c0). Daha dıştaki "kişi" pikselleri (teller) yine reddedilir.
  const near = boxBlur(solid, w, h, Math.max(2, Math.round(FRINGE_ALLOW_FACE * faceW)));
  job.allowAi = new Float32Array(job.side * job.side);
  for (let y = 0; y < job.side; y++) {
    for (let x = 0; x < job.side; x++) {
      const lx = x + job.left - bx0;
      const ly = y + job.top - by0;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
      job.allowAi[y * job.side + x] = near[ly * w + lx] > 0.001 ? 1 : 0;
    }
  }
  const filledJpeg = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  job.out = null;
  const { image, mask } = await encodeInpaint(job);
  return {
    applied: true, holePx, fringePx, ghostPx, bodyIou, faceW,
    inpaint: { image, mask, rect: { left: job.left, top: job.top, side: job.side }, job, base: filledJpeg, finish: (aiBuf) => finishInpaint(job, aiBuf, filledJpeg) },
  };
}

module.exports = {
  correctHeadScale,
  prepareHeadFringeRepaint,
  personMask,
  measureSilhouette,
  approxSilFromFaceBox,
  landmarkSizeRatio,
  eyeFreeLandmarkRatio,
  eyewearFaceRatio,
  perceivedHeadRatio,
  planLandmarkScale,
  APPLY_MIN_DELTA,
  MIN_SCALE,
  MAX_SCALE,
  BODY_ALIGNED_IOU,
  FACE_ALIGNED_SHIFT,
  VOLUME_CEIL,
  _scaleHeadPatch: scaleHeadPatch,
  _encodeInpaint: encodeInpaint,
  _finishInpaint: finishInpaint,
  _prepareInpaint: prepareInpaint,
  _rawRgb: rawRgb,
  _boxBlur: boxBlur,
};
