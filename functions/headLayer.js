// KATMANLI KAFA ÖLÇEĞİ (2026-11-10, kullanıcı: "kafayı yerleştirirken arkadaki
// yapıları eğip bükmemeliyiz", "bu iki problemin kesin çözümünü eleme yapmadan
// ve para harcamadan … çöz"; 7bbdad12 c4 cam korkuluk, c8 şarap rafı).
//
// SORUN: kafa küçülünce eski kafanın arkasında kalan arka plan açığa çıkar.
// Sürekli bükme (headWarp.warpHead) bu yeri komşu arka planı esneterek
// doldurur → kafa çevresindeki düz çizgi eğilir. Çizgi denetimi kareyi
// atlıyordu (kafa büyük kalır), şerit onarımı (repairBentLines) büyük
// küçültmede şeridin iki yanını farklı kaydırıp çift kenar/basamak bırakıyordu
// (c4: ufukta basamak, camda sahte dikme), çizgi koruyan bükme (lineKeep) kafa
// yanındaki örtüşme sınırını çözemiyordu (c4 6.6 → 6.0 px).
//
// ÇÖZÜM: kişi ile arka plan ayrı katman.
// - Kişi: bugünkü bükme alanı AYNEN (kafa ölçeği, boyun esnemesi, koruma),
//   tam güçte (WARP_STRENGTH indirimi yok — c8'de kafa %10-13 büyük kalıyordu).
// - Arka plan HİÇ kaydırılmaz. Eski kişinin silüeti (soluk tel dahil) temiz
//   plakayla değişir: hizalı + renk düzeltilmiş şablon (base'in o noktada
//   kişisi yoksa), yoksa yerel LaMa (iki geçiş: büyük delikte LaMa ortada saç
//   bulamacı bırakıyordu; görünen ince bant ikinci geçişte gerçek bağlamla).
// - Birleştirme: out(p) = bükülmüş(p) + (1 − α(p))·(B(p) − B(q)), q = p + D(p).
//   Saç içinde (α=1) bükülmüş aynen, arka planda B(p); yarı saydam telde yalnız
//   arkasındaki arka plan eski yerden yeni yere taşınır. Maske ile yeniden
//   yapıştırma yok (11-08 arka plan sabit yol saçı "kesip yapıştırma" gibi
//   keskin bırakmıştı), bölme yok (gürültü büyümez).
// Ölçüm: bkz. ciktilar/2026-11-10_katmanli_ab.
const sharp = require("sharp");
const HW = require("./headWarp");

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

const LAYER = {
  OLD_SOFT: 0.03, // eski kişi (çene üstü): bu olasılıktan büyük — soluk tel dahil
  OLD_GROW: 0.06, // eski silüet genişletme (yüz boyu): hale/tel. 11-10: 0.03 eski profil kenarı şeridi ve saç ucu beneği bırakıyordu (7bbdad12 c4)
  PR_BELOW: 0.5, // plaka bölgesi çene altına en çok (yüz boyu)
  SOFT_BELOW: 0.3, // soluk tel + genişletme çene altında da bu kadar (11-10: 7bbdad12 c4 boyun arkasında eski bukle, çene önünde eski çene hattı kalıyordu)
  A_LO: 0.04, A_HI: 0.6, // α = smooth((yeni kişi olasılığı − LO)/(HI − LO))
  TPL_PERSON: 0.03, TPL_PERSON_GROW: 0.08, // şablonda kişi: plaka geçersiz (+ genişletme, yüz boyu). 11-10: 0.04 base saçının uçuşan tellerini plakaya yapıştırıyordu (7bbdad12 c4 gökte "kuş")
  CTX_IN: 0.06, CTX_OUT: 0.6, // hizalama/renk bağlam halkası (eski silüetten uzaklık, yüz boyu)
  SHIFT_MAX: 0.12, // şablon hizalama arama yarıçapı (yüz boyu)
  TPL_NCC_MIN: 0.65, // hizalama NCC'si bunun altındaysa şablon plaka/tel için kullanılmaz
  COLOR_SIGMA: 0.18, // renk farkı yayma (yüz boyu)
  STRAND_REACH: 0.25, STRAND_T: 18, STRAND_FLAT: 10, // şablon farkıyla soluk tel (yalnız düz yüzeyde)
  LAMA_GROW: 0.015, LAMA_PAD: 0.35, LAMA2_PAD: 0.25,
  MIN_LEFT_MS: 90 * 1000, // iş süresi bundan azsa katmanlı yol atlanır (bugünkü bükme)
  // Ölçülen küçültmenin bu kadarı (11-10 kör A/B, 55 kare: tam güç ölçümün abarttığı karelerde
  // kafayı base'den %10-12 küçük yaptı; 80fc7ec4 c4/c6/c7). warpHead'in 0.75'i c8'de az kalıyordu.
  STRENGTH: 0.9,
  // Çene hattı altındaki eski boyun derisi plakaya girmez (11-10, 7bbdad12 c4 profil: boynun arka
  // kenarı kulak hizasında, küçültme onu öne çekiyor, altı yerinde → plaka boynu basamaklı kesiyordu).
  NECK_KEEP: false, NECK_KEEP_PAD: 0.04, // KAPALI: boyun arkasında soluk dalgalı şerit bıraktı
  // Düz yüzey dolgusu (11-10 v7 kör A/B: LaMa düz duvarda beyaz/gri çizgi, gökte leke uydurdu —
  // f358a3e1 c9, 27deeec2 c7). Delik çevresi düzse (bulanık görüntüde gradyan düşük) gerçek
  // arka plandan çok ölçekli normalize konvolüsyon + çevrenin kendi greni; dokuluysa LaMa.
  // KAPALI (11-10 v8 kör A/B, 10 kare: yeni 2 / canlı 6 — 4 karede eski kafa dış hattı soluk hale
  // olarak kaldı: dış bağlamdaki soluk eski saç izi içeri taşınıyor).
  // KIYAFET SANILAN TEN/GÖLGE (2026-11-12, 41589067 c4): segmentasyonun kıyafet maskesi yaka
  // ucunda boyun derisine ve yaka gölge çizgisine taşıyor; kıyafet plakaya girmediği için
  // (yukarıda) bu pikseller ham kalıyor, boyun incelip kayınca denizin önünde kahverengi kama
  // + koyu sivri çizgi olarak açıkta kalıyordu. Açıkta kalan (yeni kişi < NN_MAX) eski kişi
  // pikseli, yerel KESİN kıyafet renginden T'den uzak ve yerel boyun tenine daha yakınsa
  // plakaya girer. Yerel (σ) ortalama: çok renkli kıyafette (ceket + gömlek) tek renk yanılır.
  // BİRLEŞTİRMEDE KAYNAĞIN ARKA PLANI (2026-11-12, 41589067 c5 kafa sağ üstü gri kama):
  // out = bükülmüş(p) + (1−α)(B(p) − B(q)) — q'da kişi yokken (nn(p) ≈ 0) B(q) plakası hamdan
  // farklıysa (şablon plakası koltuk kenarını kaydırmış) ham(q) − B(q) farkı kafayla birlikte
  // dönüp p'ye taşınıyordu. nn < RESID_BG_NN'de q'nun arka planı ham(q) (yumuşak geçiş).
  RESID_BG_ON: true, RESID_BG_NN: 0.04,
  // KAFA MASKESİ ARKA PLANA TAŞINCA (aynı kare: asıl kama buydu): karanlık sahnede segmentasyon
  // saçın üstündeki panel parçasını kişi (α=1) sayıyor; bükülünce panel koltuğun koyu kısmına
  // taşınıyordu. Yeni kişinin dış bandında (içten kenara ≤ MATTE_BAND·yüz) kaynak ham(q) plakanın
  // arka plan tahmini B(q)'ya MATTE_T'den yakınsa α azalır (piksel zaten arka plan). Saç içinde
  // plaka rengi tesadüfen saça benzeyebileceği için yalnız bantta; kaynak plakalı olmalı.
  // Kaynak piksel yerel kesin kafa renginden de MATTE_FG_T'den uzak olmalı (koyu saç koyu zemin
  // önünde: ikisi de aynı renk → dokunulmaz; 11-12 kör A/B 7e04933e c5, f358a3e1 c8 saç soluyordu).
  MATTE_ON: true, MATTE_BAND: 0.12, MATTE_T: 10, MATTE_FG_T: 8, MATTE_FG_SIGMA: 0.06,
  // Arka plan yalnız hizalı ŞABLONDAN bilinen plakada güvenilir; LaMa tahmini koyu saçla tesadüfen
  // eşleşip saçı saydamlaştırıyordu (7e04933e c5 kulak üstü bambu).
  MATTE_TPL_ONLY: true,
  // AÇIK HALE (2026-11-17, f8c1718b c5 saç üstü kubbe): ham karede saçın çevresindeki açık hale
  // segmentasyonda saç (≥0.9); küçültmede kafayla aşağı iniyor, tente bandının kenarı kubbe
  // gibi kayıyordu. Plaka LaMa'dan olduğu için MATTE (yalnız şablon) çalışmıyordu. Bantta
  // kaynak plakaya MATTE_T'den yakın ve dokusu (5×5 komşu farkı) HALO_TEX altındaysa α azalır.
  // Kafa rengi koşulu yerine doku: saç teli dokulu (c5 ölçü 8-12), bulanık zemin değil (0.4-0.8).
  HALO_ON: true, HALO_BAND: 0.3, HALO_TEX: 4,
  CLOTH_SKIN_ON: true,
  CLOTH_SKIN_NN_MAX: 0.5, CLOTH_SKIN_SURE: 0.8, CLOTH_SKIN_SIGMA: 0.06, CLOTH_SKIN_CONF: 0.05, CLOTH_SKIN_T: 40,
  FLAT_ON: false,
  FLAT_T0: 3, FLAT_T1: 7, // bulanık parlaklık gradyanı (|dx|+|dy|, 2 px): altı düz, üstü doku
  FLAT_TEX_SIGMA: 0.1, FLAT_SIGMAS: [0.03, 0.06, 0.12, 0.24], FLAT_CONF: 0.2,
};

/**
 * Düz yüzey dolgusu (bkz. LAYER.FLAT_*): B'de take (LaMa'nın doldurduğu) piksellerin
 * düz çevrelisi, arka plan bağlamından yumuşak dolgu + gren ile değişir. Döner değişen piksel.
 */
function flatFill(B, FW, roi, take, ring, oldR, o, cloth, faceH) {
  const { rx0, ry0, RW, RH } = roi, N = RW * RH;
  const G = (i) => { const x = i % RW, y = (i - x) / RW; return ((y + ry0) * FW + x + rx0) * 3; };
  // Bağlam: şablon plakası (halka, LaMa değil) ya da eski silüet dışındaki gerçek arka plan.
  const ctx = new Float32Array(N), val = new Float32Array(N * 3), lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const g = G(i); lum[i] = 0.299 * B[g] + 0.587 * B[g + 1] + 0.114 * B[g + 2];
    if (take[i]) continue;
    const gq = g / 3;
    if ((ring[i]) || (!oldR[i] && o[i] < LAYER.OLD_SOFT && cloth[gq] < 0.5)) { ctx[i] = 1; for (let c = 0; c < 3; c++) val[i * 3 + c] = B[g + c]; }
  }
  // Doku: 3×3 bulanık parlaklıkta gradyan (gren sayılmasın); gren: ham − 3×3 ortalama.
  const blur = new Float32Array(N);
  for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lum[(y + dy) * RW + x + dx]; blur[y * RW + x] = s / 9; }
  const gm = new Float32Array(N), r2 = new Float32Array(N), gw = new Float32Array(N);
  for (let y = 2; y < RH - 2; y++) for (let x = 2; x < RW - 2; x++) {
    const i = y * RW + x; if (!ctx[i] || !ctx[i - 2] || !ctx[i + 2] || !ctx[i - 2 * RW] || !ctx[i + 2 * RW]) continue;
    gm[i] = Math.abs(blur[i + 1] - blur[i - 1]) + Math.abs(blur[i + RW] - blur[i - RW]); r2[i] = (lum[i] - blur[i]) ** 2; gw[i] = 1;
  }
  const tex = normConv(gm, gw, RW, RH, LAYER.FLAT_TEX_SIGMA * faceH, 1).res;
  const grain = normConv(r2, gw, RW, RH, LAYER.FLAT_TEX_SIGMA * faceH, 1).res;
  const scales = LAYER.FLAT_SIGMAS.map((s) => normConv(val, ctx, RW, RH, s * faceH, 3));
  let n = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < N; i++) {
    if (!take[i]) continue;
    const f = 1 - smooth((tex[i] - LAYER.FLAT_T0) / (LAYER.FLAT_T1 - LAYER.FLAT_T0));
    if (f <= 0.01) continue;
    let k = 0; while (k < scales.length - 1 && scales[k].conf[i] < LAYER.FLAT_CONF) k++;
    const S = scales[k].res;
    const u1 = Math.max(1e-6, rnd()), u2 = rnd(), nz = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * Math.sqrt(Math.max(0, grain[i]) * 9 / 8);
    const g = G(i);
    for (let c = 0; c < 3; c++) B[g + c] = clamp(Math.round(f * (S[i * 3 + c] + nz) + (1 - f) * B[g + c]), 0, 255);
    n++;
  }
  return n;
}

/** Normalize Gauss konvolüsyonu: blur(val·w)/blur(w), küçük ızgarada. SAF. */
function normConv(val, wgt, W, H, sigma, ch) {
  const q = Math.min(1, 256 / Math.max(W, H));
  const w = Math.max(4, Math.round(W * q)), h = Math.max(4, Math.round(H * q));
  const sw = Math.max(1, sigma * q);
  const down = (arr, c) => {
    const out = new Float64Array(w * h * c), cnt = new Float64Array(w * h);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = Math.min(h - 1, Math.floor(y * q)) * w + Math.min(w - 1, Math.floor(x * q));
      cnt[k]++;
      for (let cc = 0; cc < c; cc++) out[k * c + cc] += arr[(y * W + x) * c + cc];
    }
    for (let k = 0; k < w * h; k++) if (cnt[k]) for (let cc = 0; cc < c; cc++) out[k * c + cc] /= cnt[k];
    return out;
  };
  const R = Math.ceil(3 * sw), ker = []; let ks = 0;
  for (let d = -R; d <= R; d++) { const v = Math.exp(-(d * d) / (2 * sw * sw)); ker.push(v); ks += v; }
  const blur = (arr, c) => {
    const tmp = new Float64Array(w * h * c), out = new Float64Array(w * h * c);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let cc = 0; cc < c; cc++) {
      let s = 0; for (let d = -R; d <= R; d++) s += ker[d + R] * arr[(y * w + clamp(x + d, 0, w - 1)) * c + cc];
      tmp[(y * w + x) * c + cc] = s / ks;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let cc = 0; cc < c; cc++) {
      let s = 0; for (let d = -R; d <= R; d++) s += ker[d + R] * tmp[(clamp(y + d, 0, h - 1) * w + x) * c + cc];
      out[(y * w + x) * c + cc] = s / ks;
    }
    return out;
  };
  const vw = new Float32Array(W * H * ch);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < ch; c++) vw[i * ch + c] = val[i * ch + c] * wgt[i];
  const A = blur(down(vw, ch), ch), Bw = blur(down(wgt, 1), 1);
  const res = new Float32Array(W * H * ch), conf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = clamp(x * q - 0.5, 0, w - 1.001), fy = clamp(y * q - 0.5, 0, h - 1.001);
    const a = Math.floor(fx), b = Math.floor(fy), tx = fx - a, ty = fy - b;
    const bil = (arr, c, cc) => (arr[(b * w + a) * c + cc] * (1 - tx) + arr[(b * w + a + 1) * c + cc] * tx) * (1 - ty) + (arr[((b + 1) * w + a) * c + cc] * (1 - tx) + arr[((b + 1) * w + a + 1) * c + cc] * tx) * ty;
    const den = bil(Bw, 1, 0); conf[y * W + x] = den;
    for (let c = 0; c < ch; c++) res[(y * W + x) * ch + c] = den > 1e-4 ? bil(A, ch, c) / den : 0;
  }
  return { res, conf };
}

/** Yerel LaMa: hole (ROI) bölgesini kırpımla doldurur, B (tam kare RGB) yerinde değişir. */
async function lamaInto(B, FW, FH, roi, hole, maskExtra, pad, take) {
  const { rx0, ry0, RW, RH } = roi;
  let x0 = RW, x1 = -1, y0 = RH, y1 = -1;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) if (hole[y * RW + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return 0;
  const gx0 = x0 + rx0 - pad, gx1 = x1 + rx0 + pad, gy0 = y0 + ry0 - pad, gy1 = y1 + ry0 + pad;
  const side = Math.min(FW, FH, Math.max(gx1 - gx0, gy1 - gy0) + 1);
  const left = clamp(Math.round((gx0 + gx1) / 2 - side / 2), 0, FW - side), top = clamp(Math.round((gy0 + gy1) / 2 - side / 2), 0, FH - side);
  const crop = Buffer.alloc(side * side * 3), cm = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const gx = x + left, gy = y + top, g = (gy * FW + gx) * 3, c3 = (y * side + x) * 3;
    crop[c3] = B[g]; crop[c3 + 1] = B[g + 1]; crop[c3 + 2] = B[g + 2];
    const lx = gx - rx0, ly = gy - ry0;
    if (lx >= 0 && ly >= 0 && lx < RW && ly < RH && (hole[ly * RW + lx] || (maskExtra && maskExtra[ly * RW + lx]))) cm[y * side + x] = 1;
  }
  const filled = (await require("./lamaFill").fillCrop(crop, side, cm)).rgb;
  let n = 0;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const lx = x + left - rx0, ly = y + top - ry0;
    if (lx < 0 || ly < 0 || lx >= RW || ly >= RH || !take[ly * RW + lx]) continue;
    const g = ((y + top) * FW + x + left) * 3, c3 = (y * side + x) * 3;
    B[g] = filled[c3]; B[g + 1] = filled[c3 + 1]; B[g + 2] = filled[c3 + 2]; n++;
  }
  return n;
}

/**
 * Kafa ölçeği/eğimi, arka plan kaydırılmadan. plan: warpHead planı (s, rollRad);
 * lm: çıktının yüz noktaları. Döner warpHead biçiminde { buf, applied, reason, s, ... }.
 */
async function scaleHeadLayered(outputBuf, plan, lm, tplBuf, { deadline = null, warpStrength = LAYER.STRENGTH, debugMasks = null } = {}) {
  const t0 = Date.now();
  if (deadline && deadline - Date.now() < LAYER.MIN_LEFT_MS) return { buf: null, applied: false, reason: "layer-time" };
  const { distanceTo, dilateBin, headMasks } = HW._testables;
  const w = await HW.warpHead(outputBuf, plan, lm, { deadline, ignoreLines: true, field: true, bendGateOn: false, lineKeep: false, warpStrength });
  if (!w.applied || !w.field) return w;
  const { rgb, warped, Dx, Dy, act, rx0, ry0, RW, RH, FW, FH, faceH, chinY, head, person, prot, cloth } = w.field;
  // Eski çene hattı (68 nokta 0..16) — altındaki boyun derisi plakaya girmez (bkz. LAYER.NECK_KEEP).
  const jaw = lm.pts.slice(0, 17).map((p) => [p.x, p.y]).sort((a, b) => a[0] - b[0]);
  const jawY = (x) => { if (x <= jaw[0][0]) return jaw[0][1]; if (x >= jaw[16][0]) return jaw[16][1]; for (let k = 1; k < 17; k++) if (x <= jaw[k][0]) { const [x0, y0] = jaw[k - 1], [x1, y1] = jaw[k]; return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0); } return jaw[16][1]; };
  const N = RW * RH, roi = { rx0, ry0, RW, RH };
  const G = (x, y) => (y + ry0) * FW + x + rx0;
  const oAt = (g) => Math.max(person[g], head[g]);
  // Eski kişi (o) ve yeni kişi (nn: bükmenin kaynağından), ROI.
  const o = new Float32Array(N), nn = new Float32Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x; o[i] = oAt(G(x, y));
    if (!act[i]) { nn[i] = o[i]; continue; }
    const fx = clamp(x + rx0 + Dx[i], 0, FW - 1.001), fy = clamp(y + ry0 + Dy[i], 0, FH - 1.001);
    const a = Math.floor(fx), b = Math.floor(fy), tx = fx - a, ty = fy - b;
    nn[i] = (oAt(b * FW + a) * (1 - tx) + oAt(b * FW + a + 1) * tx) * (1 - ty) + (oAt((b + 1) * FW + a) * (1 - tx) + oAt((b + 1) * FW + a + 1) * tx) * ty;
  }
  // Eski silüet: çene üstünde soluk tel dahil + genişletme; altında ≥ 0.5.
  const obS = new Uint8Array(N), ob5 = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x; ob5[i] = o[i] >= 0.5 ? 1 : 0;
    obS[i] = y + ry0 <= chinY + LAYER.SOFT_BELOW * faceH ? (o[i] >= LAYER.OLD_SOFT ? 1 : 0) : ob5[i];
  }
  const obG = dilateBin(obS, RW, RH, Math.max(2, LAYER.OLD_GROW * faceH));
  const oldR = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const i = y * RW + x; oldR[i] = y + ry0 <= chinY + LAYER.SOFT_BELOW * faceH ? obG[i] : ob5[i]; }
  const alpha = new Float32Array(N), nB = new Uint8Array(N);
  for (let i = 0; i < N; i++) { alpha[i] = smooth((nn[i] - LAYER.A_LO) / (LAYER.A_HI - LAYER.A_LO)); nB[i] = nn[i] >= 0.5 ? 1 : 0; }
  // Plaka bölgesi: eski silüet (çene altında sınırlı); kıyafet/nesne kafayla kaymaz →
  // plaka yok (c8 yakada tırtık yapıyordu). Boyun DERİSİ plakada: eski geniş boyun/çene
  // kenarı kalıyordu (11-10 kör A/B: 8 karede deri şeridi/çentik).
  const ring = new Uint8Array(N);
  let ringN = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = G(x, y);
    if (!oldR[i] || y + ry0 > chinY + LAYER.PR_BELOW * faceH) continue;
    if (cloth[g] >= 0.5 && head[g] < 0.5) continue;
    ring[i] = 1; ringN++;
  }
  // KIYAFET SANILAN TEN/GÖLGE (bkz. LAYER.CLOTH_SKIN_*): açıkta kalan eski kişi pikseli
  // kıyafet sınıfında ama yerel kıyafet renginden uzak, boyun teni rengine yakınsa plakaya.
  let clothSkinPx = 0;
  if (LAYER.CLOTH_SKIN_ON) {
    const cand = [];
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x, g = G(x, y);
      if (ring[i] || o[i] < 0.5 || nn[i] >= LAYER.CLOTH_SKIN_NN_MAX || y + ry0 > chinY + LAYER.PR_BELOW * faceH) continue;
      if (cloth[g] >= 0.5 && head[g] < 0.5) cand.push(i);
    }
    if (cand.length) {
      const cv = new Float32Array(N * 3), cw = new Float32Array(N), sv = new Float32Array(N * 3), sw = new Float32Array(N);
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const i = y * RW + x, g = G(x, y);
        if (cloth[g] >= LAYER.CLOTH_SKIN_SURE && head[g] < 0.2) { cw[i] = 1; for (let c = 0; c < 3; c++) cv[i * 3 + c] = rgb[g * 3 + c]; }
        else if (person[g] >= 0.5 && cloth[g] < 0.2 && head[g] < 0.5) { sw[i] = 1; for (let c = 0; c < 3; c++) sv[i * 3 + c] = rgb[g * 3 + c]; }
      }
      const C = normConv(cv, cw, RW, RH, LAYER.CLOTH_SKIN_SIGMA * faceH, 3), Sk = normConv(sv, sw, RW, RH, LAYER.CLOTH_SKIN_SIGMA * faceH, 3);
      for (const i of cand) {
        if (C.conf[i] < LAYER.CLOTH_SKIN_CONF || Sk.conf[i] < LAYER.CLOTH_SKIN_CONF) continue;
        const x = i % RW, y = (i - x) / RW, g = G(x, y) * 3;
        const dC = Math.hypot(rgb[g] - C.res[i * 3], rgb[g + 1] - C.res[i * 3 + 1], rgb[g + 2] - C.res[i * 3 + 2]);
        const dS = Math.hypot(rgb[g] - Sk.res[i * 3], rgb[g + 1] - Sk.res[i * 3 + 1], rgb[g + 2] - Sk.res[i * 3 + 2]);
        if (dC > LAYER.CLOTH_SKIN_T && dS < dC) { ring[i] = 1; ringN++; clothSkinPx++; }
      }
    }
  }
  const B = Buffer.from(rgb);
  const fromTpl = new Uint8Array(N); // plaka pikseli hizalı şablondan (gerçek arka plan), LaMa tahmini değil
  let tplPx = 0, lamaPx = 0, lama2Px = 0, strandPx = 0, flatPx = 0, shift = null;
  if (ringN) {
    const { faceLandmarks } = require("./faceQuality");
    const tFull = await sharp(tplBuf).rotate().removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer();
    const tj = await sharp(tFull, { raw: { width: FW, height: FH, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    const lt = (await faceLandmarks(tj)) || (await faceLandmarks(tj, 0.1));
    const tm = await headMasks(tFull, FW, FH, lt ? lt.box : lm.box, lt ? lt.pts[8].y : chinY);
    const tpB = new Uint8Array(N);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const g = G(x, y); tpB[y * RW + x] = Math.max(tm.person[g], tm.head[g]) >= LAYER.TPL_PERSON ? 1 : 0; }
    const tpG = dilateBin(tpB, RW, RH, Math.max(2, LAYER.TPL_PERSON_GROW * faceH));
    // Bağlam halkası: eski silüetin dışında, iki görüntüde de kişi yok.
    const dOld = distanceTo(oldR, RW, RH);
    const ctx = new Uint8Array(N);
    for (let i = 0; i < N; i++) ctx[i] = !oldR[i] && !tpG[i] && o[i] < LAYER.OLD_SOFT && dOld[i] >= LAYER.CTX_IN * faceH && dOld[i] <= LAYER.CTX_OUT * faceH ? 1 : 0;
    // Hizalama: gradyan büyüklüğü NCC, tam öteleme araması (model arka planı birkaç px kaydırıyor).
    const grey = (src) => { const g = new Float32Array(FW * FH); for (let i = 0; i < FW * FH; i++) g[i] = 0.299 * src[i * 3] + 0.587 * src[i * 3 + 1] + 0.114 * src[i * 3 + 2]; return g; };
    const gr = grey(rgb), gt = grey(tFull);
    const gm = (g, x, y) => Math.abs(g[y * FW + x + 1] - g[y * FW + x - 1]) + Math.abs(g[(y + 1) * FW + x] - g[(y - 1) * FW + x]);
    const R = Math.max(2, Math.round(LAYER.SHIFT_MAX * faceH));
    const pts = [];
    for (let y = 1; y < RH - 1; y += 2) for (let x = 1; x < RW - 1; x += 2) if (ctx[y * RW + x]) { const gx = x + rx0, gy = y + ry0; if (gx >= 1 && gy >= 1 && gx < FW - 1 && gy < FH - 1) pts.push([gx, gy]); }
    let best = { dx: 0, dy: 0, ncc: -2 };
    if (pts.length > 200) {
      const a0 = pts.map(([x, y]) => gm(gr, x, y));
      const ma = a0.reduce((s, v) => s + v, 0) / a0.length, va = a0.reduce((s, v) => s + (v - ma) ** 2, 0);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        let sb = 0, sbb = 0, sab = 0, n = 0;
        for (let k = 0; k < pts.length; k++) {
          const x = pts[k][0] + dx, y = pts[k][1] + dy; if (x < 1 || y < 1 || x >= FW - 1 || y >= FH - 1) continue;
          const b = gm(gt, x, y); sb += b; sbb += b * b; sab += (a0[k] - ma) * b; n++;
        }
        if (!n) continue;
        const mb = sb / n, vb = sbb - n * mb * mb, ncc = sab / Math.sqrt(va * vb + 1e-9);
        if (ncc > best.ncc) best = { dx, dy, ncc };
      }
    }
    shift = best;
    const tAt = (x, y, c) => tFull[(clamp(y + best.dy, 0, FH - 1) * FW + clamp(x + best.dx, 0, FW - 1)) * 3 + c];
    // Hizalama güvensizse şablon hiç kullanılmaz (plaka ve tel): model sahneyi başka yerde
    // çizmiş, fark "tel" sanılıp şablon parçası yapıştırılıyordu (f358a3e1 c9 duvarda beyaz
    // çerçeve çizgisi NCC 0.52, b932fd71 c5 kirişte leke 0.51).
    const tplOk = best.ncc >= LAYER.TPL_NCC_MIN;
    const tValid = (x, y) => { if (!tplOk) return false; const lx = x + best.dx - rx0, ly = y + best.dy - ry0; return !(lx >= 0 && ly >= 0 && lx < RW && ly < RH && tpG[ly * RW + lx]); };
    // Renk farkı (ham − hizalı şablon) bağlamda ölçülür, halkaya yayılır.
    const diff = new Float32Array(N * 3), wgt = new Float32Array(N);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x; if (!ctx[i]) continue;
      const gx = x + rx0, gy = y + ry0, g = gy * FW + gx;
      if (!tValid(gx, gy)) continue;
      const d = [0, 1, 2].map((c) => rgb[g * 3 + c] - tAt(gx, gy, c));
      if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 120) continue; // nesne farkı (aykırı)
      wgt[i] = 1; for (let c = 0; c < 3; c++) diff[i * 3 + c] = d[c];
    }
    const { res: cd, conf } = normConv(diff, wgt, RW, RH, LAYER.COLOR_SIGMA * faceH, 3);
    // Segmentasyonun görmediği soluk eski tel: eski silüet yakınında, YALNIZ düz
    // yüzeyde (gök, duvar) ham hizalı şablondan belirgin farklı. Dokulu sahnede
    // model içeriği şablondan farklı çizdiği için fark "tel" sanılıp şablon
    // parçası yapıştırılıyordu (c8 şişe, c4 korkuluk).
    {
      const st = new Uint8Array(N);
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const i = y * RW + x;
        if (ring[i] || y + ry0 > chinY || dOld[i] > LAYER.STRAND_REACH * faceH || conf[i] <= 1e-3) continue;
        const gx = x + rx0, gy = y + ry0, g = (gy * FW + gx) * 3;
        if (!tValid(gx, gy)) continue;
        let flat = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) flat = Math.max(flat, gm(gt, clamp(gx + best.dx + dx, 1, FW - 2), clamp(gy + best.dy + dy, 1, FH - 2)));
        if (flat > LAYER.STRAND_FLAT) continue;
        let e = 0; for (let c = 0; c < 3; c++) e += Math.abs(rgb[g + c] - (tAt(gx, gy, c) + cd[i * 3 + c]));
        if (e / 3 > LAYER.STRAND_T) st[i] = 1;
      }
      const stG = dilateBin(st, RW, RH, 2);
      for (let i = 0; i < N; i++) if (stG[i] && !ring[i]) { ring[i] = 1; ringN++; strandPx++; }
    }
    // Plaka: şablon geçerliyse renk düzeltilmiş şablon, değilse LaMa.
    const hole = new Uint8Array(N);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x; if (!ring[i]) continue;
      const gx = x + rx0, gy = y + ry0, g = (gy * FW + gx) * 3;
      if (tValid(gx, gy) && conf[i] > 1e-3) { for (let c = 0; c < 3; c++) B[g + c] = clamp(Math.round(tAt(gx, gy, c) + cd[i * 3 + c]), 0, 255); tplPx++; fromTpl[i] = 1; } else hole[i] = 1;
    }
    if (hole.some((v) => v)) {
      const hG = dilateBin(hole, RW, RH, Math.max(1, LAYER.LAMA_GROW * faceH));
      // Birinci geçiş: delik + tüm eski kişi bağlam dışı (LaMa saçı halkaya uzatmasın).
      const extra = new Uint8Array(N);
      for (let i = 0; i < N; i++) extra[i] = (oldR[i] && !ring[i]) || nB[i] || ob5[i] ? 1 : 0;
      const take1 = new Uint8Array(N); for (let i = 0; i < N; i++) take1[i] = hG[i] && ring[i] ? 1 : 0;
      lamaPx = await lamaInto(B, FW, FH, roi, hG, extra, Math.round(LAYER.LAMA_PAD * faceH), take1);
      // İkinci geçiş: görünen ince bant (α < 1 olan yeni yer + saç kenarının kaynağı q).
      if (!(deadline && deadline - Date.now() < LAYER.MIN_LEFT_MS / 2)) {
        const need = new Uint8Array(N);
        for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
          const i = y * RW + x; if (alpha[i] >= 0.995) continue;
          if (take1[i]) need[i] = 1;
          if (act[i] && alpha[i] > 0.005) {
            const qx = Math.round(x + Dx[i]), qy = Math.round(y + Dy[i]);
            if (qx >= 0 && qy >= 0 && qx < RW && qy < RH && take1[qy * RW + qx]) need[qy * RW + qx] = 1;
          }
        }
        const nG = dilateBin(need, RW, RH, 3);
        for (let i = 0; i < N; i++) if (!take1[i]) nG[i] = 0;
        // Yeni kişinin örttüğü yer bağlam dışı: orada birinci geçişin saç bulamacı duruyor,
        // LaMa onu görünce koyuluğu bandın içine uzatıyordu (7bbdad12 c8 saç üstü "boynuz").
        const extra2 = new Uint8Array(N);
        for (let i = 0; i < N; i++) extra2[i] = !nG[i] && (nn[i] >= LAYER.A_LO || (take1[i] && alpha[i] >= 0.995) || (ob5[i] && !take1[i])) ? 1 : 0; // plakasız eski kişi (yaka, boyun) de dışarıda: c4 boyun arkasında ten rengi uzatıyordu
        lama2Px = await lamaInto(B, FW, FH, roi, nG, extra2, Math.round(LAYER.LAMA2_PAD * faceH), nG);
      }
      if (LAYER.FLAT_ON) flatPx = flatFill(B, FW, roi, take1, ring, oldR, o, cloth, faceH);
    }
  }
  // Birleştirme: out(p) = bükülmüş(p) + (1 − α)·(B(p) − B(q)).
  const out = Buffer.from(rgb);
  const bil = (S) => (fx, fy, c) => {
    const xx = clamp(fx, 0, FW - 1.001), yy = clamp(fy, 0, FH - 1.001), xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya;
    const i00 = (ya * FW + xa) * 3 + c;
    return (S[i00] * (1 - ax) + S[i00 + 3] * ax) * (1 - ay) + (S[i00 + FW * 3] * (1 - ax) + S[i00 + FW * 3 + 3] * ax) * ay;
  };
  const Bq = bil(B), Rq = bil(rgb);
  // Yeni kişinin dış bandı (bkz. LAYER.MATTE_*): içten kenara uzaklık.
  let dEdge = null;
  let fgL = null;
  if (LAYER.MATTE_ON) {
    const outN = new Uint8Array(N); for (let i = 0; i < N; i++) outN[i] = nB[i] ? 0 : 1; dEdge = distanceTo(outN, RW, RH);
    // Yerel kesin kafa rengi (saç/yüz, eski kişinin iç kısmı): kaynak piksel buna yakınsa kişidir.
    const fv = new Float32Array(N * 3), fw = new Float32Array(N);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const i = y * RW + x, g = G(x, y); if (head[g] >= 0.9 && o[i] >= 0.9) { fw[i] = 1; for (let c = 0; c < 3; c++) fv[i * 3 + c] = rgb[g * 3 + c]; } }
    fgL = normConv(fv, fw, RW, RH, LAYER.MATTE_FG_SIGMA * faceH, 3);
  }
  // Ham parlaklıkta yerel doku: 5×5 içinde komşu farkı ortalaması (saç teli yüksek, bulanık zemin düşük).
  const lumAt = (x, y) => { const k = (clamp(y, 0, FH - 1) * FW + clamp(x, 0, FW - 1)) * 3; return 0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2]; };
  const texAt = (x, y) => { let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += Math.abs(lumAt(x + dx + 1, y + dy) - lumAt(x + dx, y + dy)) + Math.abs(lumAt(x + dx, y + dy + 1) - lumAt(x + dx, y + dy)); return s / 25; };
  let mattePx = 0, haloPx = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x; if (!act[i] && !ring[i]) continue;
    const gx = x + rx0, gy = y + ry0, g = (gy * FW + gx) * 3;
    const qx = gx + (act[i] ? Dx[i] : 0), qy = gy + (act[i] ? Dy[i] : 0);
    let a = alpha[i];
    // Kaynak piksel plakanın arka plan tahminiyle aynıysa (segmentasyon kafayı arka plana
    // taşırmış) kişi katmanı onu taşımaz.
    const qlx = Math.round(qx - rx0), qly = Math.round(qy - ry0);
    if (dEdge && act[i] && a > 0 && qlx >= 0 && qly >= 0 && qlx < RW && qly < RH && ring[qly * RW + qlx] && dEdge[i] <= Math.max(LAYER.MATTE_BAND, LAYER.HALO_ON ? LAYER.HALO_BAND : 0) * faceH) {
      let d = 0, df = 0; const jq = qly * RW + qlx;
      for (let c = 0; c < 3; c++) { const r = Rq(qx, qy, c); d = Math.max(d, Math.abs(r - Bq(qx, qy, c))); df = Math.max(df, Math.abs(r - fgL.res[jq * 3 + c])); }
      // Kafa rengine de benziyorsa (koyu saç koyu zemin önünde) ayırt edilemez → kişi kalır
      // (11-12 kör A/B: 7e04933e c5 bambu çıtaları saçın içinden görünüyordu).
      if (dEdge[i] <= LAYER.MATTE_BAND * faceH && d < LAYER.MATTE_T && fgL.conf[jq] > 0.02 && df > LAYER.MATTE_FG_T && (!LAYER.MATTE_TPL_ONLY || fromTpl[jq])) { a *= smooth(d / LAYER.MATTE_T); mattePx++; }
      // HALE (bkz. LAYER.HALO_*): kaynak plakaya yakın VE pürüzsüzse (saç teli dokusu yok) arka
      // plandır — LaMa plakasında da. Kafa rengi (fgL) burada kullanılamaz: segmentasyon haleyi
      // saç ≥0.9 saydığı için kafa rengi halenin kendisi.
      else if (LAYER.HALO_ON && d < LAYER.MATTE_T && texAt(Math.round(qx), Math.round(qy)) < LAYER.HALO_TEX) { a *= smooth(d / LAYER.MATTE_T); haloPx++; }
    }
    // Kaynakta kişi yoksa (nn = q'daki kişi olasılığı ≈ 0) q'nun arkası ham görüntünün kendisi:
    // plaka orada sahneyi hamdan farklı çizdiyse (şablon plakası, genişletme payı) fark kafayla
    // taşınıp lekeye dönüyordu (bkz. LAYER.RESID_BG_*).
    const wq = LAYER.RESID_BG_ON && act[i] ? smooth(nn[i] / LAYER.RESID_BG_NN) : 1;
    for (let c = 0; c < 3; c++) {
      const bq = wq >= 1 ? Bq(qx, qy, c) : wq * Bq(qx, qy, c) + (1 - wq) * Rq(qx, qy, c);
      out[g + c] = clamp(Math.round(warped[g + c] + (1 - a) * (B[g + c] - bq)), 0, 255);
    }
  }
  const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  if (debugMasks) debugMasks.push({ roi, o, nn, ring, oldR, alpha, act, plate: B, head, person, cloth, warped, Dx, Dy, rgb, out });
  return {
    buf, applied: true, reason: null, s: w.s, layered: { ringPx: ringN, tplPx, lamaPx, lama2Px, strandPx, flatPx, clothSkinPx, mattePx, haloPx, shift: shift ? `${shift.dx}/${shift.dy}@${shift.ncc.toFixed(2)}` : null },
    rollDeg: w.rollDeg, lines: w.lines, band: w.band, touch: w.touch, border: w.border, ms: Date.now() - t0,
  };
}

module.exports = { scaleHeadLayered, _testables: { normConv, flatFill, LAYER } };
