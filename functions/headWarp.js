// KAFA BOYU — BÜKMEYLE (2026-10-30, kullanıcı: "kafa büyük olmamalı, orantılı
// ve geriye doğru dik olmalı; kafa yapıştırılmış gibi durmamalı").
//
// ESKİ YOL (headScale.scaleHeadPatch + kafa çevresi dolgusu): kafa kesilip
// küçültülüyor, açılan delik şablondan/LaMa ile dolduruluyordu. 922f1371'in
// 10 karesinde yerel tekrar: ölçü doğru (c5 0.895, c7 0.873, c9 0.833) ama
// dolgu c1'de "Restaurant" yazısını bozdu, c4'te saçın yanına parça bıraktı,
// c9'da saçın üstünü kesti; 60d42504 c3/c5'teki "kafanın arkası silinmiş"
// şikâyeti de aynı dolgudan.
//
// YENİ YOL: ölçü aynı (headScale.correctHeadScale measureOnly), uygulama
// rötuşçuların "liquify" yöntemi. Kafa maskesinin içi tam dönüşümle (çene ucu
// çevresinde küçültme + dikleştirme) örneklenir; maskenin dışında, kafa
// boyuna göre geniş bir bantta dönüşüm yumuşakça sıfıra iner ve arka plan
// açılan yeri kendisi kapatır. Delik, dolgu, hayalet yok; boyun ve gövde
// çenenin altında yerinde kalır. Eller, kıyafet ve nesneler bükülmez.
//
// DENENİP BIRAKILANLAR (aynı gün, 922f1371 yerel):
// - Kaydırma/kaldırma: yaka yerinde kalırken çeneyi taşımak c1/c4'te
//   çene-yaka birleşimini yırttı, c7'de boynu gerip açık şerit bıraktı.
// - Açılan yere şablonun arka planı: model arka planı yer yer farklı çiziyor
//   (c5 çatı kısa, c7 korniş başka açıda); karışım kırık çizgi, yama ve yarı
//   saydam ikinci kişi verdi — yerel uyum kapısıyla bile.
// - Düz çizgili arka planda (bina, kapı kasası) bükme çizgiyi eğiyor (c7, c9):
//   güç kafa çevresindeki düz çizgi payıyla azalır, çoksa hiç uygulanmaz.
const sharp = require("sharp");

// Yalnız belirgin büyümede küçültülür; bu oranın üstü dokunulmaz (ölçü gürültüsü).
const WARP_MIN_SHRINK = 0.97;
// En fazla bu kadar küçültülür (ölçü aşırı çıkarsa kafa küçük kalmasın, c5 60d42504).
const WARP_MAX_SHRINK = 0.86;
// BÜYÜTME DE (2026-11-01, kullanıcı: "kafa baseden büyük veya küçük olmayacak,
// base gibi omuzlara orantılı"; 831a00a4 c4 ölçü 1.10 → uygulanan 1.00).
// Büyütmede delik yok: kafa arka planın üstüne taşar. Sınır küçük; ölçü
// gürültüsü ve kişiler arası doğal fark (bkz. WARP_STRENGTH).
const WARP_MIN_GROW = 1.03;
const WARP_MAX_GROW = 1.08;
// Düz çizgili arka planda katı ölçek + halka dolgusu (bkz. rigidScaleFill). false = eskisi gibi atla.
// 2026-11-03 KAPATILDI (b932fd71, kullanıcı: "c8 boyunda siliklik, kafa oturmamış; c7 boyun ve
// kafanın sağ üstü silik; c6 kulaklar yok"): ham karede üçü de temiz; halka dolgusu
// kulağı sildi (c6), saç kenarını ve boyun yanını bulanıklaştırdı (c7, c8). Kapalıyken
// aynı üç kare temiz, kafa düz çizgili arka planda modelin boyunda kalır.
const RIGID_ON = false;
// Ölçülen farkın bu payı uygulanır: ölçü iki farklı kişinin kafası arasındaki
// doğal farkı da içeriyor ve tam küçültme arka planı fazla esnetiyor.
const WARP_STRENGTH = 0.75;
// Kafa dışı geçiş bandı, kafa yüksekliğinin payı (çizgi eğriliği bandın
// karesiyle azalır).
const BAND_VS_HEAD = 1.4;
// Kafa çevresinde düz çizgi payı: altı tam güç, üstü hiç (922f1371: gökyüzü/
// bulanık arka plan %0.4-3.0; bina, kapı kasası, tabela %6.3-13.3).
const LINE_OK = 0.03;
const LINE_MAX = 0.06;
// Çenenin altında dönüşümün sönümlendiği aralık (yüz boyunun payı).
const NECK_FADE_TOP = 0.05;
const NECK_FADE_BOTTOM = 0.45;
// Kafa sınırının bu payından fazlası el/kıyafet/nesneye değiyorsa uygulanmaz.
const MAX_TOUCH = 0.22;
// Kafa dışındaki korunan piksel (boyun derisi, yaka, el) korumasının sınırdan
// tama çıktığı uzaklık (yüz boyunun payı) — bkz. warpHead.
const PROT_RAMP_FACE = 0.15;
// Segmentasyon çalışma boyu.
const SEG_MAX_DIM = 768;
// Eğim düzeltmesi üst sınırı (radyan, ~6°).
const MAX_ROLL_RAD = 0.105;
// ÇENE YERİ (2026-10-30, c2e8eff1, kullanıcı: "çenenin tam yerini matematiksel
// olarak belirleyelim... yüzün yerini kıyafete göre koordinatlarla belirle ve
// yeni yüz çenesini tam oraya yerleştir"). Hedef = şablonun çene ucu + kıyafet
// kayması (çene altı bantta gradyan NCC; 20 karede 0-1 px). Ölçülen (yüz boyu
// payı): çene yana 0.03-0.30 (çoğu baş dönüşüyle birlikte), aşağı 0.03-0.31
// ("kafa önde/gömülü"). Sınırlar yüz boyunun payı; altı ölü bant.
// UYGULAMA KAPALI (aynı gün, 20 kare yerel): bükmeyle öteleme 8/8 karede
// çene-yaka birleşiminde yırtık parça ve blok bıraktı (c0, c1, c2, c7, c9,
// 922 c2/c3/c5) — kafa kayarken yerinde kalan gövdeyle süreklilik kopuyor.
// Ölçü loglanır (KAFA BÜKME çene[hedef=x/y]); yer düzeltmesi üretim tarafında.
const CHIN_MOVE_ON = false;
const CHIN_DEADBAND = 0.03;
const CHIN_MAX_X = 0.15;
const CHIN_MAX_UP = 0.15;
const CHIN_MAX_DOWN = 0.08;
// Kıyafet eşleşmesi: arama yarıçapı, en az NCC ve en çok kayma (yüz boyu payı).
const CLOTH_SEARCH = 0.2;
const CLOTH_NCC_MIN = 0.6;
const CLOTH_SHIFT_MAX = 0.1;
// Boyun: çene ile yaka arasında dönüşüm çeneden yakaya söner (yaka yerinde
// kalır, boyun esner — eskiden boyun korunuyordu ve kaydırma çene-yaka
// birleşimini yırttı). Yaka aranan derinlik ve boyun en kısa/en uzun payı.
const COLLAR_SEARCH = 0.9;
const NECK_MIN = 0.12;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** İki geçişli yaklaşık öklid uzaklık (chamfer), maskeye uzaklık (px). SAF. */
function distanceTo(mask, W, H) {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Tek kanallı alanı çift doğrusal büyütür (sharp kanal tuzağı yok). SAF. */
function upsample(src, w, h, W, H) {
  const out = new Float32Array(W * H);
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      out[y * W + x] = (src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx) * (1 - ty) +
        (src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx) * ty;
    }
  }
  return out;
}

/**
 * Kafa çevresindeki halkada (çene üstü) UZUN DÜZ KENAR payı: güçlü gradyan ve
 * kenar boyunca ±3 pikselde aynı yönde süren gradyan. g: gri, W×H. SAF.
 */
function lineShare(g, W, H, cx, cy, r0, r1, chinY) {
  let n = 0, line = 0;
  for (let y = 2; y < H - 2; y++) {
    if (y > chinY) break;
    for (let x = 2; x < W - 2; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      n++;
      const gx = g[y * W + x + 1] - g[y * W + x - 1], gy = g[(y + 1) * W + x] - g[(y - 1) * W + x];
      const mag = Math.hypot(gx, gy);
      if (mag <= 25) continue;
      const tx = -gy / mag, ty = gx / mag;
      let ok = 0;
      for (const k of [-3, 3]) {
        const xx = Math.round(x + k * tx), yy = Math.round(y + k * ty);
        if (xx < 1 || xx >= W - 1 || yy < 1 || yy >= H - 1) continue;
        const hx = g[yy * W + xx + 1] - g[yy * W + xx - 1], hy = g[(yy + 1) * W + xx] - g[(yy - 1) * W + xx];
        const mm = Math.hypot(hx, hy);
        if (mm > 20 && Math.abs((hx * gx + hy * gy) / (mm * mag)) > 0.9) ok++;
      }
      if (ok === 2) line++;
    }
  }
  return n ? line / n : 0;
}

async function backgroundLineShare(rgb, FW, FH, box, chinY) {
  const sc = Math.min(1, 512 / Math.max(FW, FH));
  const W = Math.max(8, Math.round(FW * sc)), H = Math.max(8, Math.round(FH * sc));
  const g = await sharp(rgb, { raw: { width: FW, height: FH, channels: 3 } }).greyscale().resize(W, H, { fit: "fill" }).blur(1.2).raw().toBuffer();
  const cx = (box.x + box.width / 2) * sc, cy = (box.y + box.height * 0.3) * sc;
  const r0 = box.height * 0.9 * sc, r1 = r0 + box.height * 1.6 * sc;
  return lineShare(g, W, H, cx, cy, r0, r1, chinY * sc);
}

/**
 * Kafa ve korunan bölge maskeleri (tam çözünürlük). Kafa = saç ∪ yüz derisi
 * ∪ (yüz kutusundaki aksesuar: gözlük), çenenin altı hariç. Korunan = el/kol
 * derisi, kıyafet, aksesuar — kafa dışında.
 */
async function headMasks(rgb, FW, FH, box, chinY) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { personCropProbs } = require("./skinTone");
  const sc = Math.min(1, SEG_MAX_DIM / Math.max(FW, FH));
  const W = Math.max(1, Math.round(FW * sc)), H = Math.max(1, Math.round(FH * sc));
  const work = await sharp(rgb, { raw: { width: FW, height: FH, channels: 3 } }).resize(W, H, { fit: "fill" }).raw().toBuffer();
  const b = { x: box.x * sc, y: box.y * sc, width: box.width * sc, height: box.height * sc };
  const P = await personCropProbs(work, W, H, b, classProbs, CLASSES);
  const head = new Float32Array(W * H), prot = new Float32Array(W * H), cloth = new Float32Array(W * H);
  const chin = chinY * sc;
  const fx0 = b.x - 0.15 * b.width, fx1 = b.x + 1.15 * b.width;
  const fy0 = b.y - 0.1 * b.height, fy1 = chin;
  // Kafa yalnız yüzün çevresinde aranır (arka plandaki başka kişiler hariç).
  const hx0 = b.x - 1.4 * b.width, hx1 = b.x + 2.4 * b.width, hy0 = b.y - 1.6 * b.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hair = P[CLASSES.hair][i], face = P[CLASSES.faceSkin][i], oth = P[CLASSES.others][i];
      const inHeadZone = x >= hx0 && x <= hx1 && y >= hy0 && y <= chin + 0.02 * b.height;
      const inFaceBox = x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
      let h = inHeadZone ? Math.max(hair, face) : 0;
      if (inFaceBox) h = Math.max(h, oth);
      head[i] = h;
      prot[i] = h >= 0.5 ? 0 : Math.max(P[CLASSES.bodySkin][i], P[CLASSES.clothes][i], oth);
      cloth[i] = h >= 0.5 ? 0 : Math.max(P[CLASSES.clothes][i], oth);
    }
  }
  return { head: upsample(head, W, H, FW, FH), prot: upsample(prot, W, H, FW, FH), cloth: upsample(cloth, W, H, FW, FH) };
}

/**
 * Kafayı plana göre büker. plan: { s (≤1, ölçülen), rollRad }.
 * lm: çıktının 68 yüz noktası ({ pts, box }). Döner { buf, applied, reason, ... }.
 */
async function warpHead(outputBuf, plan, lm) {
  const t0 = Date.now();
  const { data: rgb, info } = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FW = info.width, FH = info.height;
  const P = lm.pts;
  const chinY = P[8].y;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const faceH = Math.max(1, chinY - browY);
  const A = { x: P[8].x, y: P[8].y }; // çapa: çene ucu (kafa boyna bağlı kalır)
  const s0 = plan.s || 1;
  const th0 = clamp(plan.rollRad || 0, -MAX_ROLL_RAD, MAX_ROLL_RAD);
  const wantShrink = s0 <= WARP_MIN_SHRINK;
  const wantGrow = s0 >= WARP_MIN_GROW;
  const T0 = { x: plan.tx || 0, y: plan.ty || 0 };
  const wantMove = CHIN_MOVE_ON && Math.hypot(T0.x, T0.y) >= 1;
  if (!wantShrink && !wantGrow && Math.abs(th0) < 0.01 && !wantMove) return { buf: null, applied: false, reason: "no-change", s: 1 };
  const lines = await backgroundLineShare(rgb, FW, FH, lm.box, chinY);
  const k = 1 - smooth((lines - LINE_OK) / (LINE_MAX - LINE_OK));
  const s = wantShrink ? clamp(1 - k * WARP_STRENGTH * (1 - s0), WARP_MAX_SHRINK, 1)
    : wantGrow ? clamp(1 + k * WARP_STRENGTH * (s0 - 1), 1, WARP_MAX_GROW) : 1;
  const th = k * th0;
  let T = CHIN_MOVE_ON ? { x: k * T0.x, y: k * T0.y } : { x: 0, y: 0 };
  const moveOn = Math.hypot(T.x, T.y) >= 1;
  if (Math.abs(s - 1) < 0.005 && Math.abs(th) < 0.01 && Math.hypot(T.x, T.y) < 1) return { buf: null, applied: false, reason: "structured-background", s, lines };
  const { head, prot, cloth } = await headMasks(rgb, FW, FH, lm.box, chinY);
  let x0 = FW, x1 = -1, y0 = FH, n = 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (head[y * FW + x] < 0.5) continue;
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y;
  }
  if (n < 400) return { buf: null, applied: false, reason: "no-head-mask", s, lines };
  const headH = Math.max(faceH, chinY - y0);
  const band = Math.max(12, BAND_VS_HEAD * headH);
  // Boyun boyu (sütun başına): çene ucunun altında ilk kıyafet pikseli. Yaka
  // çeneye yapışıksa kaldırma boyunu yırtar: yukarı kayma boyunun yarısıyla sınırlı.
  const neckDefault = NECK_FADE_BOTTOM * faceH;
  const collarAt = (x) => {
    const xi = clamp(Math.round(x), 0, FW - 1);
    const yEnd = Math.min(FH - 1, Math.round(chinY + COLLAR_SEARCH * faceH));
    for (let y = Math.max(0, Math.round(chinY)); y <= yEnd; y++) if (cloth[y * FW + xi] >= 0.5) return y - chinY;
    return null;
  };
  const neckC = collarAt(A.x);
  const neckLenAtChin = neckC == null ? neckDefault : Math.max(NECK_MIN * faceH, neckC);
  if (T.y < 0) T.y = Math.max(T.y, -0.5 * neckLenAtChin);
  const neckLen = new Float32Array(FW);
  for (let x = 0; x < FW; x++) {
    if (!moveOn || Math.abs(x - A.x) > 1.5 * faceH) { neckLen[x] = neckDefault; continue; }
    const c = collarAt(x);
    neckLen[x] = c == null ? neckDefault : Math.max(NECK_MIN * faceH, Math.min(neckDefault * 1.5, c));
  }
  const mv = Math.max(Math.abs(1 / s - 1), Math.abs(s - 1)) * headH + Math.abs(Math.sin(th)) * headH + Math.hypot(T.x, T.y);
  const rx0 = Math.max(0, Math.floor(x0 - band - mv - 4)), rx1 = Math.min(FW - 1, Math.ceil(x1 + band + mv + 4));
  const ry0 = Math.max(0, Math.floor(y0 - band - mv - 4)), ry1 = Math.min(FH - 1, Math.ceil(chinY + 1.5 * neckDefault + mv + 4));
  const RW = rx1 - rx0 + 1, RH = ry1 - ry0 + 1;
  const m = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) m[y * RW + x] = head[(y + ry0) * FW + x + rx0] >= 0.5 ? 1 : 0;
  const dist = distanceTo(m, RW, RH);
  // Dokunma: kafa sınırının (çene üstü) el/kıyafet/nesneye değen payı.
  let edge = 0, touch = 0;
  for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) {
    const i = y * RW + x;
    if (!m[i] || (m[i - 1] && m[i + 1] && m[i - RW] && m[i + RW])) continue;
    const gy = y + ry0;
    if (gy > chinY - 0.15 * faceH) continue;
    edge++;
    const gx = x + rx0;
    let p = 0;
    for (let d = 1; d <= 3; d++) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, -d], [0, d]]) {
        const xx = gx + dx, yy = gy + dy;
        if (xx >= 0 && xx < FW && yy >= 0 && yy < FH && head[yy * FW + xx] < 0.5) p = Math.max(p, prot[yy * FW + xx]);
      }
    }
    if (p >= 0.5) touch++;
  }
  const touchFrac = edge ? touch / edge : 0;
  if (touchFrac > MAX_TOUCH) return { buf: null, applied: false, reason: "head-touched", s, lines, touch: touchFrac };
  const cos = Math.cos(-th), sin = Math.sin(-th);
  const out = Buffer.from(rgb);
  const sample = (fx, fy, c) => {
    const xx = clamp(fx, 0, FW - 1.001), yy = clamp(fy, 0, FH - 1.001);
    const xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya;
    const i00 = (ya * FW + xa) * 3 + c, i10 = i00 + 3, i01 = i00 + FW * 3, i11 = i01 + 3;
    return (rgb[i00] * (1 - ax) + rgb[i10] * ax) * (1 - ay) + (rgb[i01] * (1 - ax) + rgb[i11] * ax) * ay;
  };
  let moved = 0;
  const protRamp = Math.max(4, PROT_RAMP_FACE * faceH);
  const top = chinY - NECK_FADE_TOP * faceH;
  for (let y = 0; y < RH; y++) {
    const gy = y + ry0;
    for (let x = 0; x < RW; x++) {
      const i = y * RW + x, gx = x + rx0, g = gy * FW + gx;
      // Çenenin altında sütunun boyun boyunca söner: yaka yerinde, boyun esner.
      const vfall = !moveOn
        ? 1 - smooth((gy - top) / ((NECK_FADE_BOTTOM + NECK_FADE_TOP) * faceH))
        : gy <= top ? 1 : 1 - smooth((gy - top) / (neckLen[gx] + NECK_FADE_TOP * faceH));
      if (vfall <= 0) continue;
      let w = m[i] ? 1 : 1 - smooth(dist[i] / band);
      if (w <= 0) continue;
      w *= vfall;
      // Koruma: çene üstünde el/kıyafet/nesne; altında yalnız kıyafet/nesne
      // (boyun derisi esnemeli — korununca kaydırma çene-yaka birleşimini yırttı).
      // Koruma kafa sınırından PROT_RAMP içinde tama çıkar: sınıra yapışık
      // boyun/yaka kafayla birlikte esner (anında tam koruma 21e c5/c6'da
      // kulak altı-çene hattında basamaklı yırtık bıraktı).
      if (!m[i]) w *= 1 - clamp(!moveOn || gy <= chinY ? prot[g] : cloth[g], 0, 1) * smooth(dist[i] / protRamp);
      if (w <= 0.002) continue;
      // Ters dönüşüm: hedef → kaynak (çene ucu çevresinde dönme + ölçek, sonra öteleme).
      const qx = gx - A.x - T.x, qy = gy - A.y - T.y;
      const sx = A.x + (cos * qx - sin * qy) / s, sy = A.y + (sin * qx + cos * qy) / s;
      const fx = gx + w * (sx - gx), fy = gy + w * (sy - gy);
      for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.round(sample(fx, fy, c));
      moved++;
    }
  }
  const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, s, rollDeg: (th * 180) / Math.PI, tx: T.x / faceH, ty: T.y / faceH, neck: neckLenAtChin / faceH, lines, band: Math.round(band), touch: touchFrac, moved, ms: Date.now() - t0 };
}

// DÜZ ÇİZGİLİ ARKA PLANDA KATI ÖLÇEK + İNCE HALKA DOLGUSU (2026-11-01,
// kullanıcı: "ek maliyet olmadan, eleme yapmadan çözmeliyiz"). Bükme bu
// karelerde tabela/sütun/ufku eğiyordu (c2e8eff1 c3/c4/c6/c8 zorla bükme),
// atlanınca kafa %12-24 büyük kalıyordu. Burada arka plana DOKUNULMAZ: kafa
// çene ucu çevresinde katı ölçeklenir (yüz şekli aynı), küçültmede açılan
// halka (kafa boyunun ~%10'u) yerel LaMa ile doldurulur. Dolguda kullanıcının
// kafası da delikte (ghostClean ile aynı: bağlam olarak verilince LaMa saçı
// halkaya uzatıyordu), sonuçtan yalnız halka alınır. Büyütmede delik yok.
// Eski geniş dolgu (headScale, 10-29'a kadar) yazıyı bozuyor, saç parçası
// bırakıyordu; halka ince olduğu için LaMa yalnız çevreyi sürdürür.
const RIGID_HEAD_DILATE = 0.03; // ölçeklenen kafa maskesi genişletme (yüz boyu payı)
// Halka eski kafanın bu kadar dışına uzanır: 0.03te eski saç kenarı ince açık
// kontur ve koyu kırıntı olarak kaldı (c2e8eff1 c3/c4/c8).
const RIGID_RING_OUT = 0.07;
// Saç ucu (düşük olasılıklı tel) da eski kafa sayılır.
const RIGID_RING_PROB = 0.2;
const RIGID_RING_GROW = 0.015; // halka dolgu maskesi genişletme (yüz boyu payı)
const RIGID_CROP = 1.35; // LaMa kırpımı, kafa kutusunun katı

async function rigidScaleFill(outputBuf, plan, lm, tplBuf = null) {
  const t0 = Date.now();
  const { data: rgb, info } = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FW = info.width, FH = info.height;
  const P = lm.pts;
  const chinY = P[8].y;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const faceH = Math.max(1, chinY - browY);
  const A = { x: P[8].x, y: P[8].y };
  const s0 = plan.s || 1;
  const s = s0 <= WARP_MIN_SHRINK ? clamp(1 - WARP_STRENGTH * (1 - s0), WARP_MAX_SHRINK, 1)
    : s0 >= WARP_MIN_GROW ? clamp(1 + WARP_STRENGTH * (s0 - 1), 1, WARP_MAX_GROW) : 1;
  if (Math.abs(s - 1) < 0.01) return { buf: null, applied: false, reason: "no-change", s };
  const { head, prot } = await headMasks(rgb, FW, FH, lm.box, chinY);
  const hb = new Uint8Array(FW * FH);
  let x0 = FW, x1 = -1, y0 = FH, n = 0;
  for (let i = 0; i < FW * FH; i++) {
    if (head[i] < 0.45) continue;
    hb[i] = 1; n++;
    const x = i % FW, y = (i - x) / FW;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y;
  }
  if (n < 400) return { buf: null, applied: false, reason: "no-head-mask", s };
  // Dokunma: el/nesne kafaya değiyorsa katı ölçek onu da keser — uygulanmaz.
  const pad = Math.ceil(Math.max(2, RIGID_HEAD_DILATE * faceH)) + 2;
  const rx0 = Math.max(0, x0 - pad - 4), rx1 = Math.min(FW - 1, x1 + pad + 4);
  const ry0 = Math.max(0, y0 - pad - 4), ry1 = Math.min(FH - 1, Math.ceil(chinY + (NECK_FADE_BOTTOM + NECK_FADE_TOP) * faceH) + 2);
  const RW = rx1 - rx0 + 1, RH = ry1 - ry0 + 1;
  const m = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) m[y * RW + x] = hb[(y + ry0) * FW + x + rx0];
  const dOut = distanceTo(m.map((v) => 1 - v), RW, RH); // kafa içinde kenara uzaklık
  const dIn = distanceTo(m, RW, RH); // kafa dışında kafaya uzaklık
  let edge = 0, touch = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (m[i] || dIn[i] > 2) continue;
    const gy = y + ry0;
    if (gy > chinY - 0.15 * faceH) continue;
    edge++;
    if (prot[gy * FW + x + rx0] >= 0.5) touch++;
  }
  const touchFrac = edge ? touch / edge : 0;
  if (touchFrac > MAX_TOUCH) return { buf: null, applied: false, reason: "head-touched", s, touch: touchFrac };
  const grow = Math.max(2, RIGID_HEAD_DILATE * faceH);
  const md = new Uint8Array(RW * RH); // genişletilmiş kafa (kaynak tarafı)
  for (let i = 0; i < RW * RH; i++) md[i] = m[i] || dIn[i] <= grow ? 1 : 0;
  const sample = (fx, fy, c) => {
    const xx = clamp(fx, 0, FW - 1.001), yy = clamp(fy, 0, FH - 1.001);
    const xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya;
    const i00 = (ya * FW + xa) * 3 + c, i10 = i00 + 3, i01 = i00 + FW * 3, i11 = i01 + 3;
    return (rgb[i00] * (1 - ax) + rgb[i10] * ax) * (1 - ay) + (rgb[i01] * (1 - ax) + rgb[i11] * ax) * ay;
  };
  const out = Buffer.from(rgb);
  const newHead = new Uint8Array(RW * RH);
  // Çekirdek: kaynağı gerçek kafa olan piksel. Genişletme payından gelen (eski
  // kenarın ışık halesi) küçülen kafanın çevresinde ince açık kontur yapıyordu;
  // o pay halkaya katılıp doldurulur.
  const newCore = new Uint8Array(RW * RH);
  const top = chinY - NECK_FADE_TOP * faceH;
  // Ölçeklenen bölge yalnız kaynakta kafa olan yerler; büyütmede kafa dışa taşar.
  const ex = s > 1 ? Math.ceil((s - 1) * (ry1 - ry0)) + 2 : 0;
  for (let y = Math.max(0, ry0 - ex); y <= Math.min(FH - 1, ry1); y++) {
    for (let x = Math.max(0, rx0 - ex); x <= Math.min(FW - 1, rx1 + ex); x++) {
      const vfall = y <= top ? 1 : 1 - smooth((y - top) / ((NECK_FADE_BOTTOM + NECK_FADE_TOP) * faceH));
      if (vfall <= 0) continue;
      const sx = A.x + (x - A.x) / s, sy = A.y + (y - A.y) / s;
      const mx = Math.round(sx) - rx0, my = Math.round(sy) - ry0;
      if (mx < 0 || my < 0 || mx >= RW || my >= RH || !md[my * RW + mx]) continue;
      const g = y * FW + x;
      // Kafa kenarında 1-2 px yumuşak geçiş (kaynak kenara uzaklığıyla).
      const edgeW = m[my * RW + mx] ? Math.min(1, 0.5 + dOut[my * RW + mx] / 2) : Math.max(0, 1 - dIn[my * RW + mx] / grow) * 0.5;
      const w = vfall * edgeW;
      if (w <= 0.01) continue;
      for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.round(rgb[g * 3 + c] * (1 - w) + sample(sx, sy, c) * w);
      const lx = x - rx0, ly = y - ry0;
      if (w >= 0.5 && lx >= 0 && ly >= 0 && lx < RW && ly < RH) { newHead[ly * RW + lx] = 1; if (m[my * RW + mx] && dOut[my * RW + mx] >= 1.5) newCore[ly * RW + lx] = 1; }
    }
  }
  let ringPx = 0, tplPx = 0;
  if (s < 1) {
    // Halka: eski kafa (saç uçları dahil, dışa genişletilmiş) − yeni kafa, çene hizasının üstünde.
    const old = new Uint8Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) old[y * RW + x] = head[(y + ry0) * FW + x + rx0] >= RIGID_RING_PROB ? 1 : 0;
    const oldG = dilateBin(old, RW, RH, Math.max(3, RIGID_RING_OUT * faceH));
    const ring = new Uint8Array(RW * RH);
    for (let y = 0; y < RH; y++) {
      if (y + ry0 > chinY - 0.02 * faceH) break;
      for (let x = 0; x < RW; x++) { const i = y * RW + x; if ((oldG[i] || md[i]) && !newCore[i]) { ring[i] = 1; ringPx++; } }
    }
    if (ringPx) {
      const ringG = dilateBin(ring, RW, RH, Math.max(1, RIGID_RING_GROW * faceH));
      // LaMa kırpımı (kare) — kafa kutusu çevresi.
      const bw = x1 - x0, bh = chinY - y0;
      const side = Math.min(FW, FH, Math.round(RIGID_CROP * Math.max(bw, bh) + 2 * pad));
      const cx = (x0 + x1) / 2, cy = (y0 + chinY) / 2;
      const left = clampI(cx - side / 2, 0, FW - side), topc = clampI(cy - side / 2, 0, FH - side);
      const crop = Buffer.alloc(side * side * 3);
      const hole = new Uint8Array(side * side);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const gx = x + left, gy = y + topc, g = gy * FW + gx, o = (y * side + x) * 3;
        crop[o] = out[g * 3]; crop[o + 1] = out[g * 3 + 1]; crop[o + 2] = out[g * 3 + 2];
        const lx = gx - rx0, ly = gy - ry0;
        if (lx >= 0 && ly >= 0 && lx < RW && ly < RH && (ringG[ly * RW + lx] || newHead[ly * RW + lx])) hole[y * side + x] = 1;
      }
      const { fillCrop } = require("./lamaFill");
      const filled = (await fillCrop(crop, side, hole)).rgb;
      // Yalnız halka geri yazılır (yumuşak kenar); yeni kafa olduğu gibi.
      const r8 = Buffer.alloc(side * side);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const lx = x + left - rx0, ly = y + topc - ry0;
        if (lx >= 0 && ly >= 0 && lx < RW && ly < RH && ringG[ly * RW + lx] && !newCore[ly * RW + lx]) r8[y * side + x] = 255;
      }
      const wgt = await sharp(r8, { raw: { width: side, height: side, channels: 1 } }).blur(0.8).extractChannel(0).raw().toBuffer();
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const w = wgt[y * side + x] / 255;
        if (w <= 0) continue;
        const g = ((y + topc) * FW + x + left) * 3, o = (y * side + x) * 3;
        for (let c = 0; c < 3; c++) out[g + c] = Math.round(out[g + c] + w * (filled[o + c] - out[g + c]));
      }
      // BASE'İN GERÇEK ARKA PLANI (2026-11-01, c2e8eff1 c6): kafanın arkasında
      // kalabalık varken LaMa bulanık hayalet figür çizdi. Base'de orası arka
      // plansa (eski kişinin kafası değil) ve hemen dışında çıktı base'i
      // tutuyorsa (model arka planı kopyalamış) base pikseli, yerel ton farkı
      // düzeltilerek konur; kalan yerde LaMa dolgusu.
      if (tplBuf) {
        try {
          tplPx = await baseRingFill(out, rgb, tplBuf, FW, FH, { rx0, ry0, RW, RH, ring: ringG, keep: newCore, oldG, newHead, faceH, box: lm.box, chinY });
        } catch (e) {
          console.error("Halkaya base arka planı konamadı (yalnız LaMa):", e.message || e);
        }
      }
    }
  }
  const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, s, rigid: true, ringPx, tplPx, touch: touchFrac, ms: Date.now() - t0 };
}

const clampI = (v, a, b) => Math.round(Math.max(a, Math.min(b, v)));

// Base arka planı uyumu: pencere yarıçapı (yüz boyu payı), en az geçerli piksel
// payı, ortalama gri fark üst sınırı (0-255).
const BASE_FILL_WIN = 0.08;
const BASE_FILL_MIN_SHARE = 0.15;
const BASE_FILL_MAX_DIFF = 12;

/**
 * Halkanın base'de arka plan olan ve çevresinde çıktıyla uyuşan kısmını base
 * pikseliyle (yerel ortalama renk farkı eklenerek) doldurur. out yerinde
 * değişir; orig: küçültme öncesi çıktı. Döner: konan piksel sayısı.
 */
async function baseRingFill(out, orig, tplBuf, FW, FH, R) {
  const { rx0, ry0, RW, RH, ring, keep, oldG, newHead, faceH } = R;
  const t = await sharp(tplBuf).rotate().removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer();
  const { faceLandmarks } = require("./faceQuality");
  const tj = await sharp(t, { raw: { width: FW, height: FH, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const lt = (await faceLandmarks(tj)) || (await faceLandmarks(tj, 0.1));
  const tm = await headMasks(t, FW, FH, lt ? lt.box : R.box, lt ? lt.pts[8].y : R.chinY);
  // Base'in kafası (saç ucu dahil) biraz genişletilir: parlak tel uçları gökyüzüne
  // çizgi olarak taşınıyordu (c2e8eff1 c4).
  const N = RW * RH;
  const tb = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) tb[y * RW + x] = tm.head[(y + ry0) * FW + x + rx0] >= 0.1 ? 1 : 0;
  const tHead = dilateBin(tb, RW, RH, Math.max(2, 0.04 * faceH));
  const V = new Float64Array((RW + 1) * (RH + 1)), SD = new Float64Array((RW + 1) * (RH + 1));
  const SC = [0, 1, 2].map(() => new Float64Array((RW + 1) * (RH + 1)));
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = (y + ry0) * FW + x + rx0;
    const ok = !oldG[i] && !newHead[i] && !tHead[i] ? 1 : 0;
    const d = ok ? Math.abs((orig[g * 3] + orig[g * 3 + 1] + orig[g * 3 + 2]) - (t[g * 3] + t[g * 3 + 1] + t[g * 3 + 2])) / 3 : 0;
    const I = (y + 1) * (RW + 1) + x + 1;
    V[I] = ok + V[I - 1] + V[I - RW - 1] - V[I - RW - 2];
    SD[I] = d + SD[I - 1] + SD[I - RW - 1] - SD[I - RW - 2];
    for (let c = 0; c < 3; c++) SC[c][I] = (ok ? orig[g * 3 + c] - t[g * 3 + c] : 0) + SC[c][I - 1] + SC[c][I - RW - 1] - SC[c][I - RW - 2];
  }
  const box = (A, x0, y0, x1, y1) => A[(y1 + 1) * (RW + 1) + x1 + 1] - A[y0 * (RW + 1) + x1 + 1] - A[(y1 + 1) * (RW + 1) + x0] + A[y0 * (RW + 1) + x0];
  const r = Math.max(4, Math.round(BASE_FILL_WIN * faceH));
  const minN = BASE_FILL_MIN_SHARE * (2 * r + 1) * (2 * r + 1);
  const val = new Float32Array(N * 3);
  const m8 = Buffer.alloc(N);
  let n = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = (y + ry0) * FW + x + rx0;
    if (!ring[i] || keep[i] || tHead[i]) continue;
    const x0 = Math.max(0, x - r), x1 = Math.min(RW - 1, x + r), y0 = Math.max(0, y - r), y1 = Math.min(RH - 1, y + r);
    const cnt = box(V, x0, y0, x1, y1);
    if (cnt < minN || box(SD, x0, y0, x1, y1) / cnt > BASE_FILL_MAX_DIFF) continue;
    for (let c = 0; c < 3; c++) val[i * 3 + c] = t[g * 3 + c] + box(SC[c], x0, y0, x1, y1) / cnt;
    m8[i] = 255; n++;
  }
  if (!n) return 0;
  const wgt = await sharp(m8, { raw: { width: RW, height: RH, channels: 1 } }).blur(1.0).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < N; i++) {
    const w = (wgt[i] / 255) * (m8[i] ? 1 : 0.0);
    if (w <= 0) continue;
    const x = i % RW, y = (i - x) / RW, g = ((y + ry0) * FW + x + rx0) * 3;
    for (let c = 0; c < 3; c++) out[g + c] = Math.round(clamp(out[g + c] + w * (val[i * 3 + c] - out[g + c]), 0, 255));
  }
  return n;
}

/** İkili maskeyi r px genişletir (uzaklık dönüşümüyle). SAF. */
function dilateBin(mask, W, H, r) {
  const d = distanceTo(mask, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || d[i] <= r ? 1 : 0;
  return out;
}

/** Gri gradyan büyüklüğü (merkezi fark). SAF. */
function gradMag(g, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    out[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + W] - g[i - W]);
  }
  return out;
}

/**
 * Kıyafet kayması: şablon → çıktı, çene altı bantta (yüz boyunun 0.3-1.6'sı,
 * ±1.6 yanda) gradyan NCC tam arama. Dönüş { dx, dy (px), ncc } | null. SAF.
 */
function clothRegister(gt, go, W, H, chin, hf, R) {
  const x0 = Math.max(R + 1, Math.round(chin.x - 1.6 * hf)), x1 = Math.min(W - R - 1, Math.round(chin.x + 1.6 * hf));
  const y0 = Math.min(H - R - 2, Math.round(chin.y + 0.3 * hf)), y1 = Math.min(H - R - 1, Math.round(chin.y + 1.6 * hf));
  if (y1 - y0 < 8 || x1 - x0 < 8) return null;
  let best = null;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    let st = 0, so = 0, stt = 0, soo = 0, sto = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const a = gt[y * W + x], b = go[(y + dy) * W + x + dx];
      st += a; so += b; stt += a * a; soo += b * b; sto += a * b; n++;
    }
    const cov = sto / n - (st / n) * (so / n), va = stt / n - (st / n) ** 2, vb = soo / n - (so / n) ** 2;
    const ncc = cov / Math.sqrt(va * vb + 1e-9);
    if (!best || ncc > best.ncc) best = { dx, dy, ncc };
  }
  return best;
}

/**
 * ÇENE HEDEFİ: şablonun çene ucu + kıyafet kayması − çıktının çene ucu (px,
 * çıktı uzayı). Sınırlı ve ölü bantlı. Dönüş { tx, ty, raw: {x,y}, ncc, reason }.
 */
async function planChinMove(outputBuf, templateBuf, lo) {
  const { faceLandmarks } = require("./faceQuality");
  const meta = await sharp(outputBuf).metadata();
  const FW = meta.width, FH = meta.height;
  const tJ = await sharp(templateBuf).rotate().resize(FW, FH, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
  const lt = (await faceLandmarks(tJ)) || (await faceLandmarks(tJ, 0.1));
  if (!lt) return { tx: 0, ty: 0, reason: "no-face-template" };
  const Pt = lt.pts, Po = lo.pts;
  const hf = Math.max(1, Pt[8].y - Math.min(...Pt.slice(17, 27).map((p) => p.y)));
  const sc = Math.min(1, 900 / Math.max(FW, FH));
  const W = Math.round(FW * sc), H = Math.round(FH * sc);
  const grey = (b) => sharp(b).rotate().removeAlpha().resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const [gt, go] = await Promise.all([grey(tJ), grey(outputBuf)]);
  const reg = clothRegister(gradMag(gt, W, H), gradMag(go, W, H), W, H, { x: Pt[8].x * sc, y: Pt[8].y * sc }, hf * sc, Math.max(2, Math.round(CLOTH_SEARCH * hf * sc)));
  if (!reg || reg.ncc < CLOTH_NCC_MIN) return { tx: 0, ty: 0, ncc: reg ? reg.ncc : null, reason: "cloth-unmatched" };
  const off = { x: reg.dx / sc, y: reg.dy / sc };
  if (Math.hypot(off.x, off.y) > CLOTH_SHIFT_MAX * hf) return { tx: 0, ty: 0, ncc: reg.ncc, reason: "cloth-moved" };
  const raw = { x: (Pt[8].x + off.x - Po[8].x) / hf, y: (Pt[8].y + off.y - Po[8].y) / hf };
  const fx = Math.abs(raw.x) < CHIN_DEADBAND ? 0 : clamp(raw.x, -CHIN_MAX_X, CHIN_MAX_X);
  const fy = Math.abs(raw.y) < CHIN_DEADBAND ? 0 : clamp(raw.y, -CHIN_MAX_UP, CHIN_MAX_DOWN);
  // Çıktının yüz boyuyla px'e (dönüşüm çıktı uzayında).
  const hfo = Math.max(1, Po[8].y - Math.min(...Po.slice(17, 27).map((p) => p.y)));
  return { tx: fx * hfo, ty: fy * hfo, raw, ncc: reg.ncc, reason: null };
}

/**
 * Ölç + uygula. Ölçü headScale'den (küçültme ve 2026-11-01'den beri sınırlı büyütme).
 * Döner { buf, applied, reason, ölçü }.
 */
async function correctHeadByWarp(outputBuf, templateBuf, { templateEyewear = false } = {}) {
  const { correctHeadScale } = require("./headScale");
  const { faceLandmarks } = require("./faceQuality");
  const hs = await correctHeadScale(outputBuf, templateBuf, { templateEyewear, measureOnly: true });
  const n = (v, d = 3) => (v != null && Number.isFinite(v) ? v.toFixed(d) : "null");
  const ölçü = `ölçü=${n(hs.s)} yüzOranı=${n(hs.faceRatio)} eğim=${n(hs.rollDeg, 1)}° gövdeIoU=${n(hs.bodyIou)}`;
  // Ölçek tolerans içindeyse (ya da gözlüklü şablonda büyütme istenirse) ölçek
  // uygulanmaz ama çene yeri yine düzeltilir.
  const scaleOnlyStop = ["within-tolerance", "eyewear-no-enlarge", "no-move"].includes(hs.reason);
  if (hs.reason !== "measure-only" && !scaleOnlyStop) return { buf: null, applied: false, reason: hs.reason, ölçü };
  if (scaleOnlyStop) { hs.s = 1; hs.rollRad = 0; }
  const lm = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  if (!lm) return { buf: null, applied: false, reason: "no-face-output", ölçü };
  let cm = { tx: 0, ty: 0, reason: "error" };
  try {
    cm = await planChinMove(outputBuf, templateBuf, lm);
  } catch (e) {
    console.error("Çene hedefi ölçülemedi (yalnız ölçek/eğim):", e.message || e);
  }
  const çene = `çene[${cm.reason ? cm.reason : `hedef=${n(cm.raw.x, 2)}/${n(cm.raw.y, 2)}`} kıyafetNcc=${n(cm.ncc, 2)}]`;
  // BÜYÜTME YÜZÜ BASE YÜZÜNDEN BÜYÜTMESİN (2026-11-01): ölçü saç hacmini de
  // sayıyor; kısa/düz saçlı kullanıcıda "küçük" der (c2e8eff1 c0: ölçü 1.04,
  // yüz zaten base'in 1.05 katı → büyütme yüzü 1.08 yaptı). Saç kişinin kendi
  // saçı; ölçek yüzü base yüzü boyuna kadar büyütür, daha fazla değil.
  if (hs.s > 1 && hs.faceRatio > 0) hs.s = Math.min(hs.s, Math.max(1, 1 / hs.faceRatio));
  let r = await warpHead(outputBuf, { s: hs.s || 1, rollRad: hs.rollRad || 0, tx: cm.tx, ty: cm.ty }, lm);
  // Düz çizgili arka plan: bükme yerine katı ölçek + ince halka dolgusu.
  if (r.reason === "structured-background" && RIGID_ON && (hs.s <= WARP_MIN_SHRINK || hs.s >= WARP_MIN_GROW)) {
    try {
      const rr = await rigidScaleFill(outputBuf, { s: hs.s }, lm, templateBuf);
      r = { ...rr, lines: r.lines, reason: rr.applied ? null : `structured-background/${rr.reason}` };
    } catch (e) {
      console.error("Katı kafa ölçeği hata verdi (atlanıyor):", e.message || e);
    }
  }
  return { ...r, ölçü: `${ölçü} ${çene} uygulanan=${n(r.s)}${r.rollDeg != null ? ` dönüş=${n(r.rollDeg, 1)}°` : ""}${r.tx != null ? ` kayma=${n(r.tx, 2)}/${n(r.ty, 2)} boyun=${n(r.neck, 2)}` : ""}${r.rigid ? ` katı halka=${r.ringPx}px base=${r.tplPx}px` : ""}${r.lines != null ? ` düzÇizgi=${n(100 * r.lines, 1)}%` : ""}${r.touch != null ? ` dokunma=${n(r.touch, 2)}` : ""}${r.band != null ? ` bant=${r.band}px` : ""}${r.ms != null ? ` ${r.ms}ms` : ""}` };
}

module.exports = { correctHeadByWarp, warpHead, rigidScaleFill, _testables: { dilateBin, RIGID_ON, distanceTo, upsample, lineShare, clothRegister, gradMag, WARP_MIN_SHRINK, WARP_MAX_SHRINK, WARP_MIN_GROW, WARP_MAX_GROW, LINE_OK, LINE_MAX, CHIN_MAX_X, CHIN_MAX_UP } };
