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
const APPLY_MIN_DELTA = 0.04;
// Tek seferde en fazla. Daha büyük sapma ölçü hatası ya da yeniden kadraj.
// 0.8 → 0.9 (2026-10-09, f9f3b5c0 c6): 0.865 küçültme kafayı omuzlara
// gömdü, kafanın yanındaki tablonun kenarını büktü ("kafa, tablo, omuzlar
// öne eğilmiş").
// 0.9 → 0.93 (2026-10-09, iş 61079257): 0.9'a kırpılan c2 "çok küçülmüş",
// c3 "biraz küçük"; 0.9'da iyi bulunan c1/c6 ve 9d9507f0 c8'in "çok
// küçültmüşsün" dediği 0.886 bu sınırla tutarlı. Yüz oranı 1.15+ ölçülen
// karelerde ölçü algıdan fazlasını söylüyor (gözlüklü şablon, gür sakal).
const MIN_SCALE = 0.93;
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
  const seedX = Math.round(sil.seedX ?? sil.cx);
  let maxRun = 0;
  for (let y = Math.round(sil.top + 0.15 * (chin - sil.top)); y <= Math.round(chin - 0.1 * faceH); y++) {
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

  // Elips yüz merkezlidir; yana dönük kafada ense saçı elipsin dışına taşar
  // ve K=0'da eski saç olduğu gibi kalır (03d6c1f6 c2: küçük kafanın
  // arkasında eski saç telleri). Kafa ortası hizasının üstündeki kişi
  // pikselleri yalnızca kafa/saçtır (omuz orada olamaz): bölgeye yumuşak
  // kenarla katılır.
  {
    let hz = new Float32Array(w * h);
    for (let y = 0; y < h && y + by0 <= hy; y++) {
      for (let x = 0; x < w; x++) if (Mo[(y + by0) * W + (x + bx0)] >= 0.04) hz[y * w + x] = 1;
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pb[y * w + x] = Math.max(0, Math.min(1, (Mo[(y + by0) * W + (x + bx0)] - 0.15) / 0.45));
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
      if (K[y * w + x] > 0.01 && Mo[(y + by0) * W + (x + bx0)] >= 0.04) old[y * w + x] = 1;
    }
  }
  // Uçuşan saç telleri maske eşiğinin altında kalıp 8 px ötesine uzanır
  // (03d6c1f6 c2: küçülen kafanın üstünde eski telin ince çizgisi).
  old = boxBlur(old, w, h, Math.max(8, Math.round(0.07 * faceH)));
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

  let moved = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (K[i] <= 0) continue;
      const na = A[i];
      if (oldSoft[i] <= 0.003 && na < 0.003) continue;
      const gi = ((y + by0) * W + (x + bx0)) * 3;
      moved++;
      for (let c = 0; c < 3; c++) {
        const v = F[gi + c] * (1 - na) + bilinear(O, W, H, QX[i], QY[i], c) * na;
        out[gi + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  let inpaint = null;
  if (Fpre) {
    // AI dolgusunun pikseli bileşime doğrusal girer: delik pikselinde
    // out = (O(1-os) + P*os)(1-na) + kafa*na, P = dolgu. P değişince
    // out += os(1-na)(P' - P).
    const wgt = new Float32Array(W * H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (y + by0) * W + (x + bx0);
        if (hole[g]) wgt[g] = oldSoft[y * w + x] * (1 - A[y * w + x]);
      }
    }
    inpaint = prepareInpaint(out, Fpre, W, H, hole, banned, wgt);
  }
  return { buf: out, moved, neck, touch, sEff: s, anchorY: chin, exposed: holePx / Math.max(1, headArea), holePx, holeDepth, seam, seamHi, inpaint };
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
const INPAINT_SHIFT_MAX = 40;
// Halka pikseli "uyuyor": ortalama kanal farkı (global kayma düşülünce) bu
// değerin altında. Kenar halkasında uymayan pay INPAINT_EDGE_BAD_MAX'ı ya da
// halkanın yarısını aşarsa dolgu kullanılmaz.
const INPAINT_INLIER = 30;
const INPAINT_EDGE_BAD_MAX = 0.2;
// Delikte modelin çizdiği kişi payı (bileşim ağırlıklı kişi olasılığı).
// Model kırpımdaki kişiyi de yeniden çiziyor ve kafayı çoğu zaman eski,
// büyük boyunda çiziyor; delik kafanın hemen yanında olduğu için o kafanın
// kenarı (burun, dudak, saç) yeni kafanın yanında saydam bir profil olarak
// kalıyordu (61079257 c6, 2026-10-09). Ölçülen: izli kareler 0.069/0.070,
// temizler ≤ 0.043. Aşılırsa dolgu kullanılmaz, kafa küçültülmez.
const INPAINT_PERSON_MAX = 0.05;

function prepareInpaint(out, Fpre, W, H, hole, banned, wgt) {
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
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const g = (y + top) * W + (x + left);
      const i = y * side + x;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = out[g * 3 + c];
      if (hole[g]) {
        holeC[i] = 1;
        wC[i] = wgt[g];
        for (let c = 0; c < 3; c++) PC[i * 3 + c] = Fpre[g * 3 + c];
      } else if (!banned[g]) ringOk[i] = 1;
    }
  }
  return { out, W, H, left, top, side, rgb, holeC, ringOk, wC, PC };
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
  if (person > INPAINT_PERSON_MAX) return { buf: null, reason: "inpaint-person", shift, resid, person };
  const res = job.out ? Buffer.from(job.out) : await sharp(baseJpeg).removeAlpha().raw().toBuffer();
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      if (!job.holeC[i]) continue;
      const g = (y + top) * W + (x + left);
      for (let c = 0; c < 3; c++) {
        const v = res[g * 3 + c] + job.wC[i] * (ai[i * 3 + c] + corr[c][i] - job.PC[i * 3 + c]);
        res[g * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  const buf = await sharp(res, { raw: { width: W, height: job.H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return { buf, shift, resid, person };
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
async function correctHeadScale(outputBuf, templateBuf, { deferInpaint = false } = {}) {
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
  const sil = { ...base, cx, seedX: Math.round(P[30].x), jaw: P.slice(0, 17), chin: Math.max(base.chin, chin), headH: Math.max(base.chin, chin) - base.top };
  const faceH = Math.max(lo.box.height, chin - lo.box.y);
  const r = scaleHeadPatch(o.data, t.data, Mo, Mt, o.W, o.H, sil, faceH, plan.s, { deferInpaint });
  if (r.skipped) return { buf: null, applied: false, reason: r.reason || "head-touched", touch: r.touch, sEff: r.sEff ?? null, ...info };
  const buf = await sharp(r.buf, { raw: { width: o.W, height: o.H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const head = { cx: sil.cx, cy: (sil.top + sil.chin) / 2, rx: sil.headW / 2, ry: sil.headH / 2, chin: sil.chin, neck: r.neck };
  // deferInpaint: buf doku dolgulu hâl; çağıran inpaint.image/mask'ı modele
  // verip inpaint.finish(aiBuf) ile son hâli alır (ağ çağrısı ağır katman
  // kilidinin DIŞINDA yapılabilsin diye ayrık).
  let inpaint = null;
  if (r.inpaint) {
    const job = r.inpaint;
    // Tam çözünürlüklü ham kopya ağ çağrısı boyunca tutulmasın (bellek —
    // bkz. falPhotos POST_LAYER_LOCK); finish JPEG'i yeniden açar.
    job.out = null;
    const { image, mask } = await encodeInpaint(job);
    inpaint = { image, mask, rect: { left: job.left, top: job.top, side: job.side }, finish: (aiBuf) => finishInpaint(job, aiBuf, buf) };
  }
  return { buf, applied: true, reason: null, inpaint, ...info, s: r.sEff ?? plan.s, planS: plan.s, anchorY: r.anchorY, exposed: r.exposed, holePx: r.holePx, holeDepth: r.holeDepth, seam: r.seam, seamHi: r.seamHi, head, movedPx: r.moved, silReason: so.ok ? null : so.reason };
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
  VOLUME_CEIL,
  _scaleHeadPatch: scaleHeadPatch,
  _encodeInpaint: encodeInpaint,
  _finishInpaint: finishInpaint,
};
