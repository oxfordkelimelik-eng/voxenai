// ARKA PLAN GERİ YÜKLEME (2026-10-08, kullanıcı kararı: "sadece yüz değişecek").
//
// SORUN: model kareyi baştan çizer; arka planı şablondan birebir değil,
// yerel olarak bulanıklaştırıp kaydırarak yeniden üretir (272e656a c1: direk
// kenarı sıvanmış, kaya yanındaki lamba hayaletlenmiş). Kırpılan şablonlarda
// geri yerleştirme dikdörtgeninin yumuşak kenarı bu kaymayı ayrıca
// görünür bir dikişe çevirir. Kafa ölçeği düzeltmesinin liquify'ı da kafanın
// çevresindeki arka planı büker.
//
// ÇÖZÜM: kişi segmentasyonu ile şablondaki ve çıktıdaki kişiyi bul; ikisinin
// BİRLEŞİMİ (biraz genişletilmiş) dışında kalan her piksel şablondan aynen
// alınır. Kişinin kendisi ve eski/yeni silüeti arasındaki bant çıktıdan
// gelir — orada şablonun başka bir kafası/saçı vardı, geri koyulamaz.
//
// NEDEN GÜVENLİ: ölçüldü (272e656a, 10 kare) — arka plan hiçbir karede bütün
// olarak kaymamış (en iyi eşleşen kayma 0,0); kişi silüetleri IoU 0.66-0.98.
// Yani şablon arka planı çıktıdaki kişiyle aynı yere oturuyor.
//
// BİLİNMEYEN BANT: şablonda kişi (ör. afro saç) olan ama küçültülmüş
// çıktıda olmayan yerin gerçek arka planı yoktur. Orada liquify'ın esnettiği
// çıktı pikselleri kalır; bandın çevresinde geçiş yumuşak yapılır (bkz.
// HEAD_BAND_FEATHER). Ölçekleme ÖNCESİ çıktıyı o bantta kullanmak denendi ve
// VAZGEÇİLDİ (bb2cc441 c4): eski kafanın sınırında kafa şeklinde hale bıraktı. Push-pull dolgu denendi ve VAZGEÇİLDİ (272e656a
// c5/c6): dokulu zeminde düz, kenarı belli bir leke bıraktı — esnetilmiş
// arka plandan daha göze batıyordu.
//
// Emin olamadığında (boyut/en-boy uyuşmazlığı, silüetler çok farklı = model
// sahneyi yeniden kadrajlamış) HİÇBİR ŞEY yapmaz ve sebebini döner.

const sharp = require("sharp");

const MASK_THRESHOLD = 0.25;
// ŞABLON KİŞİSİNİN KALINTILARI (2026-10-08, 9d9507f0 c0 saç hayaleti, c8
// kulaklık silüeti): kişi maskesi saç tellerini, kulaklığı, gözlüğü düşük
// olasılıkla görür; 0.25 eşiğinde bunlar "arka plan" sayılıp şablondan geri
// konuyor ve şablondaki kişinin parçaları yarı saydam sızıyordu. Şablon
// tarafı çok daha kapsayıcı eşikle alınır, ayrıca şablonun kafası
// çevresindeki elips (saç, kulaklık, şapka) hiçbir zaman şablondan gelmez.
const TEMPLATE_MASK_THRESHOLD = 0.08;
const TEMPLATE_HEAD_RX = 1.3; // yüz kutusu genişliği cinsinden yarı eksen
const TEMPLATE_HEAD_RY = 1.5; // yüz kutusu yüksekliği cinsinden yarı eksen
// Silüetlerin bu kadar örtüşmemesi sahnenin yeniden kadrajlandığı demek;
// şablon arka planı yeni kadraja oturmaz.
const MIN_PERSON_IOU = 0.5;
// Genişletme ve yumuşatma, uzun kenarın oranı olarak. Segmentasyon 256px'te
// çalışıyor; büyütülmüş maske kenarı ~1 hücre (~%0.5) belirsiz.
const DILATE_FRAC = 0.012;
// Kafa ölçeklendiyse şablon-kafa bandının arandığı bölge ve bandın
// çevresindeki yumuşak geçiş genişliği (kafa yarıçapı cinsinden).
const HEAD_BLEND_R = 1.8;
const HEAD_BAND_FEATHER = 0.35;

/** Kare (Chebyshev) genişletme, ayrık kaydırmalı toplamlarla O(W·H). SAF. */
function dilate(bin, W, H, r) {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let cnt = 0;
    const row = y * W;
    for (let x = 0; x < Math.min(W, r); x++) cnt += bin[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) cnt += bin[row + x + r];
      if (x - r - 1 >= 0) cnt -= bin[row + x - r - 1];
      tmp[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(H, r); y++) cnt += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) cnt += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) cnt -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Birleşik kişi maskesinden alfa üretir: kişinin kendisi 1, genişletilmiş
 * bant yumuşakça 0'a iner. SAF değil (sharp blur).
 */
async function personAlpha(Mo, Mt, W, H, tplHead = null) {
  let inter = 0;
  let uni = 0;
  const union = new Uint8Array(W * H);
  for (let i = 0; i < union.length; i++) {
    const a = Mo[i] >= MASK_THRESHOLD;
    const b = Mt[i] >= MASK_THRESHOLD;
    if (a && b) inter++;
    if (a || b) uni++;
    if (a || Mt[i] >= TEMPLATE_MASK_THRESHOLD) union[i] = 1;
  }
  if (tplHead) {
    const { cx, cy, rx, ry } = tplHead;
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) union[y * W + x] = 1;
      }
    }
  }
  // IoU kişilerin örtüşmesini ölçer (yeniden kadraj testi) — eski eşikle.
  const iou = uni ? inter / uni : 0;
  const r = Math.max(4, Math.round(DILATE_FRAC * Math.max(W, H)));
  const dil = dilate(union, W, H, r);
  const m8 = Buffer.alloc(W * H);
  for (let i = 0; i < m8.length; i++) m8[i] = dil[i] ? 255 : 0;
  // TEK KANAL TUZAĞI (hafıza: sharp-mask-channel-trap): blur sonrası
  // extractChannel(0) şart.
  const soft = await sharp(m8, { raw: { width: W, height: H, channels: 1 } })
    .blur(Math.max(1, r / 2))
    .extractChannel(0)
    .raw()
    .toBuffer();
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = union[i] ? 1 : soft[i] / 255;
  return { alpha, iou, unionFrac: uni / (W * H) };
}

/**
 * Push-pull ile seyrek bir alanı doldurur: known[i]=1 olan değerlerden
 * çok ölçekli ortalama, bilineer büyütme. YALNIZCA düşük frekanslı alanlar
 * (renk/ton farkı) için — doku doldurmak için kullanılmaz (düz leke
 * bırakır, 2026-10-08 denendi). F: Float32Array W*H*C, yerinde doldurulur.
 */
function pushPullField(F, W, H, C, known) {
  const levels = [];
  let w = W, h = H;
  let V = new Float32Array(W * H * C);
  let Wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!known[i]) continue;
    Wt[i] = 1;
    for (let c = 0; c < C; c++) V[i * C + c] = F[i * C + c];
  }
  levels.push({ V, Wt, w, h });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2)), nh = Math.max(1, Math.ceil(h / 2));
    const nV = new Float32Array(nw * nh * C), nWt = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const li = y * w + x, ni = (y >> 1) * nw + (x >> 1);
      nWt[ni] += Wt[li];
      for (let c = 0; c < C; c++) nV[ni * C + c] += V[li * C + c];
    }
    for (let i = 0; i < nw * nh; i++) {
      if (nWt[i] > 1) { for (let c = 0; c < C; c++) nV[i * C + c] /= nWt[i]; nWt[i] = 1; }
    }
    V = nV; Wt = nWt; w = nw; h = nh;
    levels.push({ V, Wt, w, h });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], g = levels[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      const a = Math.min(1, f.Wt[i]);
      if (a >= 1) continue;
      const gx = Math.max(0, Math.min(g.w - 1, (x + 0.5) / 2 - 0.5));
      const gy = Math.max(0, Math.min(g.h - 1, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
      const fx = gx - x0, fy = gy - y0;
      for (let c = 0; c < C; c++) {
        const fc = f.Wt[i] > 0 ? f.V[i * C + c] / f.Wt[i] : 0;
        const up = (g.V[(y0 * g.w + x0) * C + c] * (1 - fx) + g.V[(y0 * g.w + x1) * C + c] * fx) * (1 - fy) +
          (g.V[(y1 * g.w + x0) * C + c] * (1 - fx) + g.V[(y1 * g.w + x1) * C + c] * fx) * fy;
        f.V[i * C + c] = a * fc + (1 - a) * up;
      }
      f.Wt[i] = 1;
    }
  }
  const top = levels[0];
  for (let i = 0; i < W * H; i++) {
    if (known[i]) continue;
    for (let c = 0; c < C; c++) F[i * C + c] = top.V[i * C + c];
  }
}

/**
 * Bant tonu eşitleme: geri konan şablon arka planı ile kişinin çevresinde
 * kalan çıktı arka planı arasındaki DÜŞÜK FREKANSLI renk farkını banda
 * yayar (bb2cc441 c4: model arka planı biraz farklı tonda çizmişti,
 * şablon kafasının şekli açık bir hale olarak görünüyordu). Fark 1/4
 * ölçekte, bulanıklaştırılarak hesaplanır — doku taşımaz.
 * band[i]=1: çıktı arka planı olan ama şablondan alınmayan piksel.
 */
async function harmonizeBand(O, T, W, H, band, known) {
  const S = 4;
  const w = Math.max(1, Math.round(W / S)), h = Math.max(1, Math.round(H / S));
  const small = async (buf) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill" }).blur(1.5).raw().toBuffer();
  const smallMask = async (m) => sharp(m, { raw: { width: W, height: H, channels: 1 } }).resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const [os, ts, ks] = await Promise.all([small(O), small(T), smallMask(known)]);
  const D = new Float32Array(w * h * 3);
  const k = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (ks[i] < 250) continue;
    k[i] = 1;
    for (let c = 0; c < 3; c++) D[i * 3 + c] = ts[i * 3 + c] - os[i * 3 + c];
  }
  pushPullField(D, w, h, 3, k);
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!band[i]) continue;
    n++;
    const gx = Math.min(w - 1, Math.max(0, (x + 0.5) / S - 0.5));
    const gy = Math.min(h - 1, Math.max(0, (y + 0.5) / S - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const a = band[i] / 255;
    for (let c = 0; c < 3; c++) {
      const d = (D[(y0 * w + x0) * 3 + c] * (1 - fx) + D[(y0 * w + x1) * 3 + c] * fx) * (1 - fy) +
        (D[(y1 * w + x0) * 3 + c] * (1 - fx) + D[(y1 * w + x1) * 3 + c] * fx) * fy;
      const v = O[i * 3 + c] + a * d;
      O[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return n;
}

/**
 * outputBuf ve templateBuf AYNI kadraj uzayında olmalı (bkz. falPhotos.js
 * KAFA ÖLÇEK ile aynı eşleme kuralı). Şablon çıktı boyutuna ölçeklenir.
 *
 * @returns {{buf: Buffer|null, applied: boolean, reason: string|null,
 *   iou?: number, bgDiff?: number, restoredPx?: number}}
 */
async function restoreTemplateBackground(outputBuf, templateBuf, { head = null } = {}) {
  const { personMask } = require("./headScale");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width;
  const H = o.info.height;
  const tm = await sharp(templateBuf).metadata();
  const swap = (tm.orientation || 1) >= 5;
  const tw = swap ? tm.height : tm.width;
  const th = swap ? tm.width : tm.height;
  if (Math.abs(W / H - tw / th) > 0.01 * (W / H)) {
    return { buf: null, applied: false, reason: "aspect-mismatch" };
  }
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const [Mo, Mt] = await Promise.all([personMask(o.data, W, H), personMask(t, W, H)]);
  let tplHead = null;
  try {
    const { detectMainFace } = require("./faceQuality");
    const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    const f = (await detectMainFace(tJpeg)) || (await detectMainFace(tJpeg, 0.1));
    if (f) {
      tplHead = {
        cx: f.box.x + f.box.width / 2, cy: f.box.y + f.box.height * 0.35,
        rx: TEMPLATE_HEAD_RX * f.box.width, ry: TEMPLATE_HEAD_RY * f.box.height,
      };
    }
  } catch (e) {
    console.error("Arka plan: şablon yüzü bulunamadı (kafa elipsi atlanıyor):", e.message || e);
  }
  const { alpha, iou, unionFrac } = await personAlpha(Mo, Mt, W, H, tplHead);
  if (iou < MIN_PERSON_IOU) return { buf: null, applied: false, reason: "reframed", iou };

  // KAFA BANDINDA YUMUŞAK GEÇİŞ (2026-10-08, bb2cc441 c4/c2/c5): kafa
  // ölçeklendiyse, şablonun kafasının olup çıktının kafasının olmadığı bantta
  // (gerçek arka plan bilinmiyor) liquify'ın esnettiği pikseller kalır.
  // Şablon arka planı o bandın sınırından KESKİN geri konunca bant kafa
  // şeklinde bir haleye/basamağa dönüştü (c4, c2). Geçiş bandın çevresine
  // (HEAD_BAND_FEATHER kafa yarıçapı) yayılır; kafanın tüm çevresine
  // yaymak bükülmüş yapıları geri getirdi (c5 perde) — yalnızca bant.
  if (head) {
    const x0 = Math.max(0, Math.floor(head.cx - HEAD_BLEND_R * head.rx));
    const x1 = Math.min(W - 1, Math.ceil(head.cx + HEAD_BLEND_R * head.rx));
    const y0 = Math.max(0, Math.floor(head.cy - HEAD_BLEND_R * head.ry));
    const y1 = Math.min(H - 1, Math.ceil(head.neck));
    const bandM = new Uint8Array(W * H);
    let any = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (Mt[i] >= TEMPLATE_MASK_THRESHOLD && Mo[i] < MASK_THRESHOLD) { bandM[i] = 1; any++; }
    }
    if (any) {
      const r = Math.max(4, Math.round(HEAD_BAND_FEATHER * head.rx));
      const dil = dilate(bandM, W, H, r);
      const m8 = Buffer.alloc(W * H);
      for (let i = 0; i < m8.length; i++) m8[i] = dil[i] ? 255 : 0;
      const soft = await sharp(m8, { raw: { width: W, height: H, channels: 1 } })
        .blur(Math.max(1, r / 2))
        .extractChannel(0)
        .raw()
        .toBuffer();
      for (let i = 0; i < W * H; i++) {
        const z = bandM[i] ? 1 : soft[i] / 255;
        if (z > alpha[i]) alpha[i] = z;
      }
    }
  }

  // Kişinin çevresindeki çıktı arka planını şablon tonuna eşitle (bkz.
  // harmonizeBand). Bant ağırlığı: çıktıda kişi olmama olasılığı × alfa.
  const known = Buffer.alloc(W * H);
  const band = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    if (alpha[i] === 0) { known[i] = 255; continue; }
    const notPerson = 1 - Math.min(1, Mo[i] / MASK_THRESHOLD);
    band[i] = Math.round(255 * notPerson * alpha[i]);
  }
  const harmonizedPx = await harmonizeBand(o.data, t, W, H, band, known);

  const out = Buffer.alloc(W * H * 3);
  let diffSum = 0;
  let diffN = 0;
  let restored = 0;
  for (let i = 0; i < W * H; i++) {
    const a = alpha[i];
    if (a < 1) restored++;
    if (a === 0) {
      diffSum += Math.abs(o.data[i * 3] - t[i * 3]) + Math.abs(o.data[i * 3 + 1] - t[i * 3 + 1]) + Math.abs(o.data[i * 3 + 2] - t[i * 3 + 2]);
      diffN += 3;
    }
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(a * o.data[i * 3 + c] + (1 - a) * t[i * 3 + c]);
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return {
    buf, applied: true, reason: null, iou, unionFrac,
    bgDiff: diffN ? diffSum / diffN : 0, restoredPx: restored, harmonizedPx,
  };
}

/**
 * Ana kişinin kutusu: yüz merkezinden başlayan bağlı kişi bileşeni (arka
 * plandaki yayalar dahil edilmez). Izgara 4px adımla taranır.
 * @returns {Promise<{x0,y0,x1,y1}|null>}
 */
async function mainPersonBox(buf, faceBox) {
  const { personMask } = require("./headScale");
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const M = await personMask(data, W, H);
  const S = 4;
  const gw = Math.ceil(W / S);
  const gh = Math.ceil(H / S);
  const on = (gx, gy) => M[Math.min(H - 1, gy * S) * W + Math.min(W - 1, gx * S)] >= 0.5;
  const sx = Math.floor((faceBox.x + faceBox.width / 2) / S);
  const sy = Math.floor((faceBox.y + faceBox.height / 2) / S);
  if (!on(sx, sy)) return null;
  const seen = new Uint8Array(gw * gh);
  const stack = [sy * gw + sx];
  seen[sy * gw + sx] = 1;
  let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
  while (stack.length) {
    const i = stack.pop();
    const gx = i % gw;
    const gy = (i - gx) / gw;
    if (gx < x0) x0 = gx;
    if (gx > x1) x1 = gx;
    if (gy < y0) y0 = gy;
    if (gy > y1) y1 = gy;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (seen[j] || !on(nx, ny)) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return { x0: x0 * S, y0: y0 * S, x1: Math.min(W, (x1 + 1) * S), y1: Math.min(H, (y1 + 1) * S) };
}

module.exports = { restoreTemplateBackground, mainPersonBox, pushPullField, dilate, MIN_PERSON_IOU };
