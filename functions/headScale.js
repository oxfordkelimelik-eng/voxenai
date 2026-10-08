// KAFA ÖLÇEĞİ DÜZELTMESİ (2026-10-07, kullanıcı kararı: "elemek yerine çöz").
//
// SORUN: çıktılarda kafa, şablondaki gövdeye göre büyük kalıyordu. Mevcut iki
// ölçüm bunu göremiyordu:
//   - sayısal "büyüme" yalnızca YÜZ kutusunu ölçer; saç ve kafatası dahil
//     değil. Hedefin saçı şablondakinden hacimliyse yüz aynı boyda kalır ama
//     kafa silueti büyür (9496348c c9: yüz ölçeği 0.98, siluet ~%10 büyük).
//   - Vision'ın kafa/omuz sayıları ölçüm değil tahmin: 103 satırın neredeyse
//     hepsi "kafa 20 omuz 50 oran 2.5", taban ve çıktı için aynı.
//
// ÇÖZÜM: kişi segmentasyonu (MediaPipe selfie_segmentation, tfjs, yerel, ~50 ms)
// ile şablonda ve çıktıda saç dahil kafa siluetini ve omuz genişliğini ölç.
// Çıktının kafa/omuz oranı şablonunkinden belirgin büyükse kafayı (saçıyla)
// boyun tabanına sabitlenmiş bir dönüşümle küçült; açılan halkayı ŞABLONUN
// aynı noktasındaki arka planla doldur. Şablon zaten doğru cevabı taşıyor:
// çıktı onun düzenlenmiş hâli, arka plan aynı yerde.
//
// Yüz yeniden çizilmez, yalnızca ölçeklenir — kimlik korunur. Her adım
// emin olamadığında (omuz kadraj dışı, kafa başka bir şeye değiyor, maske
// belirsiz) HİÇBİR ŞEY yapmaz ve sebebini döner.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SEG_SIZE = 256;
// Uygulama eşiği: çıktı kafası şablona göre bu kadar küçültülmesi
// gerekiyorsa düzeltilir (0.95 = %5'ten fazla büyük). Altı modelin doğal
// sapması; dokunulmaz. Kalibrasyon: HEAD SCALE logları biriktikçe gözden geçir.
const APPLY_BELOW = 0.95;
// Tek seferde en fazla bu kadar küçült. Daha büyük sapma ölçüm hatası ya da
// kadraj değişimi (model tüm sahneyi yakınlaştırmış) olabilir.
const MIN_SCALE = 0.82;
// Silüet oranı eşleşmesinin ötesinde ek küçültme çarpanı. 0.94 → şablonun %6
// altını hedefle; profilden/perspektiften kaynaklanan görsel büyüklük algısını
// dengelemek için (kullanıcı doğrulaması: 0.924→0.87 doğal görünüyor).
const CORRECTION_OVERSHOOT = 0.94;

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

/**
 * Şablon ve çıktı ölçümlerinden küçültme oranı. SAF fonksiyon.
 * s = (şablon kafa/omuz) / (çıktı kafa/omuz); genişlik ve yükseklik
 * oranlarının ortalaması. s < 1 → çıktı kafası büyük.
 */
function planHeadScale(tpl, out) {
  if (!tpl || !tpl.ok) return { apply: false, reason: `template:${tpl ? tpl.reason : "none"}` };
  if (!out || !out.ok) return { apply: false, reason: `output:${out ? out.reason : "none"}` };
  const sW = (tpl.headW / tpl.shoulderW) / (out.headW / out.shoulderW);
  const sH = (tpl.headH / tpl.shoulderW) / (out.headH / out.shoulderW);
  const s = (sW + sH) / 2;
  // Omuzlar çıktıda şablona göre çok farklıysa model sahneyi yeniden
  // kadrajlamış (ör. 9496348c c2): oran karşılaştırması anlamını yitirir.
  const shoulderRatio = out.shoulderW / tpl.shoulderW;
  if (shoulderRatio < 0.8 || shoulderRatio > 1.25) {
    return { apply: false, reason: "reframed", s, sW, sH, shoulderRatio };
  }
  if (s >= APPLY_BELOW) return { apply: false, reason: "within-tolerance", s, sW, sH, shoulderRatio };
  return { apply: true, reason: null, s: Math.max(MIN_SCALE, s * CORRECTION_OVERSHOOT), rawS: s, sW, sH, shoulderRatio };
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
 * Kafayı yumuşak bir "liquify" sıkıştırmasıyla küçültür. O: RGB raw buffer.
 * sil: çıktının siluet ölçümü, faceH: yüz kutusu yüksekliği, s: ölçek (<1).
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
  // Kafa tepesinin 0.4 yarıçap üstünde etki tamamen sıfırlanır; arka plan bozulmaz.
  const TOP_FADE = 0.4;
  const topLimit = sil.top - TOP_FADE * rb;
  const effect = (x, y) => {
    if (y >= neck) return 0;
    if (y < topLimit) return 0;
    const r = Math.hypot((x - hx) / ra, (y - hy) / rb);
    const radial = 1 - smooth((r - 1) / (R - 1));
    const vert = y <= chin ? 1 : 1 - (y - chin) / (neck - chin);
    const topFade = y >= sil.top ? 1 : smooth((y - topLimit) / (TOP_FADE * rb));
    return radial * vert * topFade;
  };
  const kOf = (x, y) => 1 - (1 - s) * effect(x, y);

  const x0 = Math.max(0, Math.floor(hx - R * ra - 2));
  const x1 = Math.min(W - 1, Math.ceil(hx + R * ra + 2));
  // y0: kafa tepesinin TOP_FADE yarıçap üstünden başla; radyal sınır daha yüksekse onu al.
  const y0 = Math.max(0, Math.floor(Math.max(topLimit, hy - R * rb) - 2));
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
  const { detectMainFace } = require("./faceQuality");
  const o = await rawRgb(outputBuf);
  const t = await rawRgb(templateBuf, o.W, o.H);
  let [fo, ft] = await Promise.all([detectMainFace(outputBuf), detectMainFace(
    await sharp(t.data, { raw: { width: o.W, height: o.H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()
  )]);
  // Karanlık görüntülerde (düşük kontrast / profil açı) 0.35 eşiği yüzü ıskalayabilir.
  // Sadece kafa ölçümü için 0.1'e düşer; kalite kapılarında bu yol kullanılmaz.
  if (!fo) fo = await detectMainFace(outputBuf, 0.1);
  if (!ft) ft = await detectMainFace(
    await sharp(t.data, { raw: { width: o.W, height: o.H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer(), 0.1
  );
  if (!fo || !ft) return { buf: null, applied: false, reason: !fo ? "no-face-output" : "no-face-template" };
  const [Mo, Mt] = await Promise.all([personMask(o.data, o.W, o.H), personMask(t.data, o.W, o.H)]);
  const so = measureSilhouette(Mo, o.W, o.H, fo.box);
  const st = measureSilhouette(Mt, o.W, o.H, ft.box);
  const plan = planHeadScale(st, so);
  const info = {
    s: plan.s ?? null, sW: plan.sW ?? null, sH: plan.sH ?? null,
    shoulderRatio: plan.shoulderRatio ?? null,
  };
  if (!plan.apply) {
    // Yüz kutusu fallback: YALNIZCA silüet tamamen başarısız olduğunda (so.ok===false).
    // Silüet ölçüm yaptı ama "within-tolerance" dediyse ona güvenilir — face-box
    // onu ezmemeli. Farklı kadraj veya poz nedeniyle yüz kutusu oranı 1.05+ çıkabilir,
    // bu gerçek kafa büyümesi demek değildir.
    // "shoulders-touch-other" / "head-touches-other": kişi silüeti ölçüldü
    // ama sahne karmaşıklığı nedeniyle güvenilmez. Bu ölçüm başarısızlığı
    // değil, sahne yorumu — face-box onu ezmemeli.
    const silFailed = !so.ok && so.reason !== "shoulders-touch-other" && so.reason !== "head-touches-other";
    if (fo && ft && silFailed) {
      const faceRatio = fo.box.width / ft.box.width; // çıktı / şablon
      if (faceRatio > 1 / APPLY_BELOW) {            // %5+ büyük
        const faceScale = Math.max(MIN_SCALE, (1 / faceRatio) * CORRECTION_OVERSHOOT);
        const sil = so.ok ? so : approxSilFromFaceBox(fo.box);
        const r = pinchHead(o.data, o.W, o.H, sil, fo.box.height, faceScale);
        const buf = await sharp(r.buf, { raw: { width: o.W, height: o.H, channels: 3 } })
          .jpeg({ quality: 95 })
          .toBuffer();
        return {
          buf, applied: true, reason: null,
          s: faceScale, rawS: faceRatio, faceRatio, faceFallback: true,
          sW: null, sH: null, shoulderRatio: plan.shoulderRatio ?? null,
          movedPx: r.moved,
        };
      }
    }
    return { buf: null, applied: false, reason: plan.reason, ...info };
  }
  const r = pinchHead(o.data, o.W, o.H, so, fo.box.height, plan.s);
  const buf = await sharp(r.buf, { raw: { width: o.W, height: o.H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return {
    buf, applied: true, reason: null, ...info, s: plan.s, rawS: plan.rawS,
    movedPx: r.moved,
  };
}

module.exports = {
  correctHeadScale,
  personMask,
  measureSilhouette,
  planHeadScale,
  approxSilFromFaceBox,
  APPLY_BELOW,
  MIN_SCALE,
  _pinchHead: pinchHead,
};
