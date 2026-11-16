// DÜZ ÇİZGİ KORUYAN KAFA BÜKME (2026-11-06, kullanıcı: "kafa büyük; düz
// çizgili arka planda bükme kabul edilemez", output-audit-1101).
//
// headWarp.warpHead'in bugünkü alanı D0 (ters yer değiştirme: çıktı pikseli
// p, kaynağı p + D0(p)) bırakılır ve üstüne ızgarada en küçük kareler
// düzeltmesi C çözülür: algılanan her düz kenar boyunca n·(D0+C) sabit →
// çizgi kendi doğrultusunda kayabilir/uzayabilir ama EĞİLEMEZ. Kafa (yeni
// kafa, saç ucu, kulak bandı) ve korunan piksel (el, kıyafet, nesne) bugünkü
// D0'da çivilenir: kafa bugünkü gibi ölçeklenir, kimlik/yüz pikselleri aynı.
//
// SORUN (11-06 inceleme, 151 + 16 kare yerel): bugünkü
// bükme 34 uygulanan karenin 12'sinde uzun çizgiyi >2 px eğiyor (0eeb c12
// 8.3 px, 7e0 c5 pencere kasası), 5'inde omuz/neon yırtığı (7e0 c1 neon
// çift, 7c17 c6 ceket kenarı) — koruma maskesinin piksel gürültüsünden.
//
// KAPI (her biri BUGÜNE GÖRE; biri tutmazsa bugünkü alan AYNEN kullanılır):
// - Katlanma/esneme yeni kafa dışında HER YERDE (kafa yanı 0.04·yüz bandı
//   dahil): det<0 sayısı ≤ bugün, en küçük det ≥ min(bugün, 0.2), esneme
//   (en küçük tekil değer < 0.4) ≤ bugün + LK_STRETCH_EPS. İlk prototipte
//   kapı kafa yanını görmüyordu: 0eeb c0'da saç kenarında beyaz şerit ve
//   basamak, 99ba c5'te duvar köşesi kıvrıldı (bugün ikisi de temiz).
// - BAĞIMSIZ bükülme: çözücünün kısıtladığı çizgilerden ayrı ikinci dedektör
//   (12° tolerans, kıyafet dahil, ≥40 px). Prototip bükülmeyi yalnız kendi
//   kısıtladığı çizgilerde ölçüyordu (kendini doğruluyordu).
// - Yer duyarlı katlanma (11-06 doğrulama): det<0 SAYISI bugünden az olsa da
//   katlanma yeni bir yere taşınabiliyordu (7e04933e c1: 261 → 210 ama 82 px
//   bugün katlanma olmayan omuz yanında, alt neon hâlâ sıvanık). Bugünkü
//   katlanmadan >3 px uzakta yeni det<0 ≤ LK_NEWFOLD_EPS.
// - Yeniden algılama: hamdaki belirgin uzun çizgilerin çıktıdaki beklenen
//   görüntüsü boyunca aynı doğrultuda algılanan kenar payı; çizgi kırılırsa
//   pay düşer (toplam boy kullanılamadı, bkz. coverageOf).
// - Sıvanma (kafa içinden arka plana örnek) ≤ bugün; görüntü dışından örnek yok.
//
// ÖLÇÜLEN (11-06, aynı kareler): bugün bükülen 55 karenin 28'inde yeni alan
// kapıyı geçti; bağımsız bükülmesi >2 px kare 19 → 15 (9c8f c9 kasa 4.9 → 1.9,
// 0eeb c12 çatı 9.3 → 3.0, 10ee c1 kayıt 3.6 → 1.4, c2e c9 tente 3.5 → 0.9);
// kalan 27 kare bayt bayt bugünkü çıktı (7e04933e c1 yer duyarlı katlanmayla
// bugüne döndü). Kafa boyu DEĞİŞMEZ (kafa pikselleri D0'da). Süre ort. 1.3 sn,
// en çok 6.1. headWarp.LINE_KEEP_ON kullanıcı onayına kadar KAPALI.
//
// AŞAMA 2 (düz çizgili arka planda kilit açma, LINE_KEEP_STRUCTURED, headWarp)
// bugün atlanan karelerde: sıfır tolerans (det<0 yok, bağımsız bükülme ≤1 px,
// kafa yanında esneme kümesi yok, büyütme hiç). 11-03 b932fd71 c6/c7/c8
// şikâyeti (RIGID_ON kapandı) ve 629b c3 / 21e c8 / 99ba c5 bozulmaları
// yüzünden KAPALI; kullanıcı tam çözünürlüklü sayfaları görmeden açılmaz.
const sharp = require("sharp");
const HW = require("./headWarp");

const { distanceTo, borderGuard } = HW._testables;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

// Izgara adımı: yüz boyu / LK_GRID_FACE.
const LK_GRID_FACE = 22;
// Çizgi kısıtı ağırlığı ve tüpü (çizginin iki yanında ±px).
const LK_BETA = 2000;
const LK_TUBE = 3;
// Önsel (C → 0) ağırlıkları: serbest arka plan, korunan/kafa düğümü, sıfır ağırlıklı düğüm.
const LK_ALPHA = 0.02;
const LK_PROT_ALPHA = 50;
const LK_ZERO_ALPHA = 5;
const LK_ITERS = 3000;
const LK_TOL = 1e-6;
// Dönmeye direnç (çizgi boyunca n·D birinci farkı; eğilmeye karşı LK_BETA ikinci fark).
const LK_BETA_TILT = 200;
// Çivi (kafa/saç ucu/kulak) çevresinde D0'a geçiş bandı (yüz boyu payı, en az
// bir ızgara hücresi) ve kulak bandı.
const LK_HEAD_BAND = 0.05;
// Korunan pikselin (prot ≥ 0.5) çevresinde D0'a geçiş (yüz boyu payı): keskin
// çivi sınırı katlanma yapıyordu (3d1d c0, d87 c3, 7e0 c5 koruma kenarı).
const LK_PIN_RAMP = 0.05;
const LK_EAR_BAND = 0.04;
// Toplam süre üst sınırı (ms): aşılırsa bugünkü alan (900 sn iş bütçesi).
const LK_MAX_MS = 8000;
// KAPI (aşama 1, bugüne göre).
const LK_STRETCH_EPS = 10;
const LK_MINDET_FLOOR = 0.2;
const LK_BEND_TOL = 0.25; // bağımsız en büyük bükülme bugünden en çok bu kadar fazla (px, ölçüm gürültüsü)
const LK_BEND_COUNT_PX = 1.5; // bu kadar bükülen çizgi sayısı bugünden fazla olamaz
const LK_CONSTRAINED_MIN = 1.0; // kısıtlı çizgilerde bükülme ≤ max(bugün, bu)
const LK_REDETECT_TOL = 0.02; // yeniden algılanan çizgi örtüşmesi bugünden en çok bu kadar düşük
const LK_INDEP_MIN_LEN = 40;
const LK_COVER_MAG = 24; // yeniden algılamada ham çizginin en az ortalama gradyanı
const LK_COVER_OUT_MAG = 7; // çıktıda algılama eşiği
// KAPI (aşama 2, sıfır tolerans; bugün kare hiç bükülmüyor).
const LK_S_MAX_BEND = 1.0;
// Yer duyarlı katlanma: bugünkü det<0 pikselinden bu kadar uzak (px) yeni
// det<0 "yeni yerde katlanma" sayılır; en çok LK_NEWFOLD_EPS piksel.
const LK_NEWFOLD_DIST = 3;
const LK_NEWFOLD_EPS = 8;
// Aynı ölçü esneme (smin < 0.4) için: yeni yerde esneme kümesi sıvanma demek
// (7e04933e c1: 298 px). Kullanılan 33 karede en çok 9 (dd788 c3, 3x temiz).
const LK_NEWSTR_EPS = 20;
const LK_S_NEAR_FACE = 0.1;
const LK_S_NEAR_STRETCH = 20;

/** Basit LSD benzeri düz kenar bulucu. g: gri (W×H), excl: 1 = kenar sayılmaz. SAF. */
function detectLines(g, W, H, excl, { magT = 16, tolDeg = 22.5, minLen = 20, minPts = 15 } = {}) {
  const mag = new Float32Array(W * H), c2 = new Float32Array(W * H), s2 = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = (g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1]) / 4;
    const gy = (g[i + W - 1] + 2 * g[i + W] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - W] - g[i - W + 1]) / 4;
    const mg = Math.hypot(gx, gy);
    mag[i] = excl && excl[i] ? 0 : mg;
    const th = Math.atan2(gy, gx) + Math.PI / 2; // kenar doğrultusu
    c2[i] = Math.cos(2 * th); s2[i] = Math.sin(2 * th);
  }
  const idx = [];
  for (let i = 0; i < W * H; i++) if (mag[i] > magT) idx.push(i);
  idx.sort((a, b) => mag[b] - mag[a]);
  const used = new Uint8Array(W * H);
  const cosTol = Math.cos((2 * tolDeg * Math.PI) / 180);
  const lines = [];
  const stack = [];
  for (const seed of idx) {
    if (used[seed]) continue;
    used[seed] = 1;
    const reg = [seed];
    let sc = c2[seed], ss = s2[seed];
    stack.length = 0; stack.push(seed);
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i - x) / W;
      const nrm = Math.hypot(sc, ss) || 1;
      const rc = sc / nrm, rs = ss / nrm;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue;
        const j = yy * W + xx;
        if (used[j] || mag[j] <= magT) continue;
        if (c2[j] * rc + s2[j] * rs < cosTol) continue;
        used[j] = 1; reg.push(j); stack.push(j); sc += c2[j]; ss += s2[j];
      }
    }
    if (reg.length < minPts) continue;
    let mx = 0, my = 0;
    for (const i of reg) { mx += i % W; my += (i - (i % W)) / W; }
    mx /= reg.length; my /= reg.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const i of reg) { const x = (i % W) - mx, y = (i - (i % W)) / W - my; sxx += x * x; sxy += x * y; syy += y * y; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let t0 = Infinity, t1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const i of reg) {
      const x = (i % W) - mx, y = (i - (i % W)) / W - my;
      const t = x * ux + y * uy, w = -x * uy + y * ux;
      if (t < t0) t0 = t; if (t > t1) t1 = t; if (w < w0) w0 = w; if (w > w1) w1 = w;
    }
    const L = t1 - t0, wid = w1 - w0;
    if (L < minLen || wid > Math.max(4, 0.12 * L)) continue;
    if (reg.length < 0.6 * L) continue;
    let ms = 0;
    for (const i of reg) ms += mag[i];
    lines.push({ cx: mx, cy: my, ux, uy, t0, t1, L, wid, n: reg.length, mag: ms / reg.length });
  }
  return lines;
}

/** ROI gri görüntüsü (çalışma boyunda) ve tam çözünürlüğe ölçek. */
async function roiGrey(rgb, FW, FH, F, work, blur) {
  const { rx0, ry0, RW, RH } = F;
  const q = Math.min(1, work / Math.max(RW, RH));
  const W = Math.max(8, Math.round(RW * q)), H = Math.max(8, Math.round(RH * q));
  const gbuf = await sharp(rgb, { raw: { width: FW, height: FH, channels: 3 } }).extract({ left: rx0, top: ry0, width: RW, height: RH }).greyscale().resize(W, H, { fit: "fill" }).blur(blur).raw().toBuffer();
  return { g: Float32Array.from(gbuf), W, H, q };
}

const toFull = (F, q) => (l) => ({ cx: F.rx0 + l.cx / q, cy: F.ry0 + l.cy / q, ux: l.ux, uy: l.uy, t0: l.t0 / q, t1: l.t1 / q, L: l.L / q, wid: l.wid / q, mag: l.mag });

/** Çözücünün kısıtladığı çizgiler: kafa (saç ucu dahil) + korunan bölge dışında. */
async function linesAround(rgb, FW, FH, F) {
  const { rx0, ry0, head, prot, faceH } = F;
  const { g, W, H, q } = await roiGrey(rgb, FW, FH, F, 900, 0.8);
  const ex = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gi = Math.min(FH - 1, ry0 + Math.round(y / q)) * FW + Math.min(FW - 1, rx0 + Math.round(x / q));
    if (head[gi] >= 0.25 || prot[gi] >= 0.5) ex[y * W + x] = 1;
  }
  const d = distanceTo(ex, W, H);
  const pad = Math.max(2, 0.02 * faceH * q);
  for (let i = 0; i < W * H; i++) if (d[i] <= pad) ex[i] = 1;
  return detectLines(g, W, H, ex, { minLen: Math.max(14, 0.18 * faceH * q), minPts: 12 }).map(toFull(F, q));
}

/** BAĞIMSIZ çizgi seti: farklı dedektör ayarı, kıyafet/el DAHİL, yalnız kafa dışlanır. */
async function independentLines(rgb, FW, FH, F, exclRoi = null, magT = 10) {
  const { rx0, ry0, RW, head, faceH } = F;
  const { g, W, H, q } = await roiGrey(rgb, FW, FH, F, 1600, 0.6);
  const ex = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ly = Math.min(F.RH - 1, Math.round(y / q)), lx = Math.min(RW - 1, Math.round(x / q));
    if (exclRoi) { if (exclRoi[ly * RW + lx]) ex[y * W + x] = 1; continue; }
    if (head[(ly + ry0) * FW + lx + rx0] >= 0.25) ex[y * W + x] = 1;
  }
  return detectLines(g, W, H, ex, { magT, tolDeg: 12, minLen: Math.max(14, 0.12 * faceH * q), minPts: 12 }).map(toFull(F, q));
}

/** Alanın çift doğrusal örneği (ROI yerel koordinatı). */
function fieldAt(Dx, Dy, RW, RH, x, y) {
  const xx = clamp(x, 0, RW - 1.001), yy = clamp(y, 0, RH - 1.001);
  const xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya;
  const i = ya * RW + xa;
  const b = (A) => (A[i] * (1 - ax) + A[i + 1] * ax) * (1 - ay) + (A[i + RW] * (1 - ax) + A[i + RW + 1] * ax) * ay;
  return [b(Dx), b(Dy)];
}

/**
 * Çizgi kısıtlı düzeltme. F: ROI + bugünkü alan; keep: D0'da çivilenen piksel
 * (yeni kafa, saç ucu, kulak bandı); protB: korunan piksel (prot ≥ 0.5).
 * Döner { Cx, Cy (piksel alanı, D = D0 + C), iters, terms, nodes, h, timeout }.
 */
function solveCorrection(F, lines, keep, protB, { deadline = Infinity } = {}) {
  const { RW, RH, m, Dx, Dy, act, faceH } = F;
  const h = Math.max(4, Math.round(faceH / LK_GRID_FACE));
  const band = Math.max(h, LK_HEAD_BAND * faceH);
  const dK = distanceTo(keep, RW, RH);
  const GX = Math.ceil((RW - 1) / h) + 1, GY = Math.ceil((RH - 1) / h) + 1, N = GX * GY;
  const fixed = new Uint8Array(N), al = new Float64Array(N);
  // DÜĞÜM HEDEFİ T: serbest düğümde D0'ın hücre ortalaması (koruma maskesinin
  // piksel gürültüsünden doğan omuz/neon yırtığı düzelir); çivili düğümde D0'ın
  // kendisi; korunan düğümde hücredeki korunan piksellerin D0 ortalaması —
  // çivilenen piksellerle çözüm arasında atlama (katlanma) kalmasın.
  const Tx = new Float64Array(N), Ty = new Float64Array(N);
  const r = Math.max(1, Math.floor(h / 2));
  for (let b = 0; b < GY; b++) for (let a = 0; a < GX; a++) {
    const k = b * GX + a, cx0 = Math.min(RW - 1, a * h), cy0 = Math.min(RH - 1, b * h), pi = cy0 * RW + cx0;
    if (keep[pi]) { Tx[k] = Dx[pi]; Ty[k] = Dy[pi]; continue; }
    let sx = 0, sy = 0, n = 0, px = 0, py = 0, pn = 0;
    for (let y = Math.max(0, cy0 - r); y <= Math.min(RH - 1, cy0 + r); y++) for (let x = Math.max(0, cx0 - r); x <= Math.min(RW - 1, cx0 + r); x++) {
      const i = y * RW + x;
      sx += Dx[i]; sy += Dy[i]; n++;
      if (protB[i]) { px += Dx[i]; py += Dy[i]; pn++; }
    }
    if (protB[pi] && pn) { Tx[k] = px / pn; Ty[k] = py / pn; } else { Tx[k] = sx / n; Ty[k] = sy / n; }
  }
  const bil = (A, x, y) => { const fx = clamp(x / h, 0, GX - 1.0001), fy = clamp(y / h, 0, GY - 1.0001); const a = Math.floor(fx), b = Math.floor(fy), tx = fx - a, ty = fy - b, k = b * GX + a; return (A[k] * (1 - tx) + A[k + 1] * tx) * (1 - ty) + (A[k + GX] * (1 - tx) + A[k + GX + 1] * tx) * ty; };
  for (let b = 0; b < GY; b++) for (let a = 0; a < GX; a++) {
    const k = b * GX + a;
    const x = Math.min(RW - 1, a * h), y = Math.min(RH - 1, b * h);
    if (a === 0 || b === 0 || a === GX - 1 || b === GY - 1) { fixed[k] = 1; continue; }
    let all = true;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = clamp(x + dx * h, 0, RW - 1) | 0, yy = clamp(y + dy * h, 0, RH - 1) | 0;
      if (!keep[yy * RW + xx]) { all = false; break; }
    }
    if (all) { fixed[k] = 1; continue; }
    const pi = y * RW + x;
    if (keep[pi] || protB[pi]) { al[k] = LK_PROT_ALPHA; continue; }
    al[k] = m[pi] ? LK_ALPHA : !act[pi] ? LK_ZERO_ALPHA : LK_ALPHA; // aralık (eski − yeni kafa) serbest
  }
  const nodeW = (x, y) => {
    const fx = clamp(x / h, 0, GX - 1.0001), fy = clamp(y / h, 0, GY - 1.0001);
    const a = Math.floor(fx), b = Math.floor(fy), tx = fx - a, ty = fy - b, k = b * GX + a;
    return [[k, k + 1, k + GX, k + GX + 1], [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]];
  };
  // TERİMLER: çizgi boyunca n·D (i) ikinci farkı sıfır → çizgi EĞİLEMEZ (LK_BETA),
  // (ii) birinci farkı sıfır → çizgi dönmeye direnir (LK_BETA_TILT, zayıf).
  // Çizgi çiviye (kafa, saç ucu, kulak) kadar kısıtlı: ilk prototip kafa
  // bandında kısıtı bırakıp düzeltmeyi bantta söndürüyordu → bant başında
  // kıvrım ve katlanma (0eeb c0 saç kenarı, 99ba c5 duvar köşesi).
  const terms = [];
  const addTerm = (samples, coefs, nx, ny, beta) => {
    const idx = [], w = [];
    let r0 = 0;
    samples.forEach((sm, j) => {
      for (let u = 0; u < 4; u++) { idx.push(sm.w[0][u]); w.push(coefs[j] * sm.w[1][u]); }
      r0 += coefs[j] * sm.d;
    });
    terms.push({ idx: Int32Array.from(idx), w: Float64Array.from(w), nx, ny, r0, beta });
  };
  const step = Math.max(2, h / 2);
  const maxExt = F.headH * Math.max(Math.abs(1 / F.s - 1), Math.abs(F.s - 1)) + 2 * h + 0.03 * faceH;
  const extReach = 0.06 * faceH + 10;
  for (const l of lines) {
    const nx = -l.uy, ny = l.ux;
    const cx = l.cx - F.rx0, cy = l.cy - F.ry0;
    const ts = [];
    for (let t = l.t0; t <= l.t1 + 1e-6; t += step) ts.push(t);
    // Kafanın arkasına giren çizgi açılan aralığa uzar (çiviye kadar).
    for (const dir of [-1, 1]) {
      const tEnd = dir > 0 ? l.t1 : l.t0;
      let hits = false;
      for (let e = 1; e <= extReach; e += 1) {
        const x = cx + (tEnd + dir * e) * l.ux, y = cy + (tEnd + dir * e) * l.uy;
        if (x < 0 || y < 0 || x > RW - 1 || y > RH - 1) break;
        if (F.head[(Math.round(y) + F.ry0) * F.FW + Math.round(x) + F.rx0] >= 0.25) { hits = true; break; }
      }
      if (!hits) continue;
      for (let e = step; e <= maxExt; e += step) {
        const t = tEnd + dir * e;
        const x = cx + t * l.ux, y = cy + t * l.uy;
        if (x < 0 || y < 0 || x > RW - 1 || y > RH - 1) break;
        if (keep[Math.round(y) * RW + Math.round(x)]) break;
        ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    for (const off of [-LK_TUBE, 0, LK_TUBE]) {
      let run = [];
      const flush = () => {
        for (let j = 0; j + 1 < run.length; j++) addTerm([run[j], run[j + 1]], [1, -1], nx, ny, LK_BETA_TILT);
        for (let j = 0; j + 2 < run.length; j++) addTerm([run[j], run[j + 1], run[j + 2]], [1, -2, 1], nx, ny, LK_BETA);
        run = [];
      };
      let prevT = null;
      for (const t of ts) {
        const x = cx + t * l.ux + off * nx, y = cy + t * l.uy + off * ny;
        if (x < 0 || y < 0 || x > RW - 1 || y > RH - 1 || keep[Math.round(y) * RW + Math.round(x)]) { flush(); prevT = null; continue; }
        if (prevT != null && t - prevT > step * 1.5) flush();
        run.push({ w: nodeW(x, y), d: nx * bil(Tx, x, y) + ny * bil(Ty, x, y) });
        prevT = t;
      }
      flush();
    }
  }
  // E = Σ al|C|² + Σ|∇(T + C)|² + Σ β (Σ c·n·(T + C))²
  const apply = (v, out) => {
    out.fill(0);
    for (let k = 0; k < N; k++) { out[k] += al[k] * v[k]; out[N + k] += al[k] * v[N + k]; }
    for (let b = 0; b < GY; b++) for (let a = 0; a < GX; a++) {
      const k = b * GX + a;
      if (a < GX - 1) { const j = k + 1; for (const o of [0, N]) { const d = v[o + k] - v[o + j]; out[o + k] += d; out[o + j] -= d; } }
      if (b < GY - 1) { const j = k + GX; for (const o of [0, N]) { const d = v[o + k] - v[o + j]; out[o + k] += d; out[o + j] -= d; } }
    }
    for (const tm of terms) {
      const { idx, w, nx, ny } = tm;
      let rr = 0;
      for (let u = 0; u < idx.length; u++) rr += w[u] * (nx * v[idx[u]] + ny * v[N + idx[u]]);
      rr *= tm.beta;
      for (let u = 0; u < idx.length; u++) { out[idx[u]] += rr * w[u] * nx; out[N + idx[u]] += rr * w[u] * ny; }
    }
  };
  const bvec = new Float64Array(2 * N);
  for (const tm of terms) {
    const rr = -tm.beta * tm.r0;
    for (let u = 0; u < tm.idx.length; u++) { bvec[tm.idx[u]] += rr * tm.w[u] * tm.nx; bvec[N + tm.idx[u]] += rr * tm.w[u] * tm.ny; }
  }
  for (let b = 0; b < GY; b++) for (let a = 0; a < GX; a++) {
    const k = b * GX + a;
    for (const j of [a < GX - 1 ? k + 1 : -1, b < GY - 1 ? k + GX : -1]) {
      if (j < 0) continue;
      const dx = Tx[k] - Tx[j], dy = Ty[k] - Ty[j];
      bvec[k] -= dx; bvec[j] += dx; bvec[N + k] -= dy; bvec[N + j] += dy;
    }
  }
  const diag = new Float64Array(2 * N);
  for (let b = 0; b < GY; b++) for (let a = 0; a < GX; a++) {
    const k = b * GX + a, deg = (a > 0) + (a < GX - 1) + (b > 0) + (b < GY - 1);
    diag[k] = diag[N + k] = al[k] + deg;
  }
  for (const tm of terms) for (let u = 0; u < tm.idx.length; u++) { diag[tm.idx[u]] += tm.beta * (tm.w[u] * tm.nx) ** 2; diag[N + tm.idx[u]] += tm.beta * (tm.w[u] * tm.ny) ** 2; }
  const isFixed = (i) => fixed[i < N ? i : i - N];
  const x = new Float64Array(2 * N), rv = new Float64Array(2 * N), z = new Float64Array(2 * N), p = new Float64Array(2 * N), Ap = new Float64Array(2 * N);
  apply(x, Ap);
  for (let i = 0; i < 2 * N; i++) rv[i] = isFixed(i) ? 0 : bvec[i] - Ap[i];
  for (let i = 0; i < 2 * N; i++) { z[i] = rv[i] / (diag[i] || 1); p[i] = z[i]; }
  let rz = 0, b2 = 0;
  for (let i = 0; i < 2 * N; i++) { rz += rv[i] * z[i]; b2 += bvec[i] * bvec[i]; }
  const bn = Math.sqrt(b2) || 1;
  let it = 0, timeout = false;
  for (; it < LK_ITERS; it++) {
    if ((it & 31) === 0 && Date.now() > deadline) { timeout = true; break; }
    apply(p, Ap);
    for (let i = 0; i < 2 * N; i++) if (isFixed(i)) Ap[i] = 0;
    let pAp = 0;
    for (let i = 0; i < 2 * N; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const a = rz / pAp;
    let rn = 0;
    for (let i = 0; i < 2 * N; i++) { x[i] += a * p[i]; rv[i] -= a * Ap[i]; rn += rv[i] * rv[i]; }
    if (Math.sqrt(rn) / bn < LK_TOL) { it++; break; }
    let rz2 = 0;
    for (let i = 0; i < 2 * N; i++) { z[i] = rv[i] / (diag[i] || 1); rz2 += rv[i] * z[i]; }
    const bb = rz2 / rz; rz = rz2;
    for (let i = 0; i < 2 * N; i++) p[i] = z[i] + bb * p[i];
  }
  // Piksel alanı: C = (T + Cgrid) − D0; çivinin çevresinde en az bir hücre
  // boyunca D0'a yumuşak geçiş (çivili düğüm zaten D0'a bağlı, fark küçük).
  const Cx = new Float64Array(RW * RH), Cy = new Float64Array(RW * RH);
  for (let y = 0; y < RH; y++) {
    const fy = Math.min(GY - 1.0001, y / h), b = Math.floor(fy), ty = fy - b;
    for (let xx = 0; xx < RW; xx++) {
      const i = y * RW + xx;
      const wh = keep[i] ? 1 : 1 - smooth(dK[i] / band);
      if (wh >= 1) continue;
      const fx = Math.min(GX - 1.0001, xx / h), a = Math.floor(fx), tx = fx - a, k = b * GX + a;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const cx = (x[k] + Tx[k]) * w00 + (x[k + 1] + Tx[k + 1]) * w10 + (x[k + GX] + Tx[k + GX]) * w01 + (x[k + GX + 1] + Tx[k + GX + 1]) * w11 - Dx[i];
      const cy = (x[N + k] + Ty[k]) * w00 + (x[N + k + 1] + Ty[k + 1]) * w10 + (x[N + k + GX] + Ty[k + GX]) * w01 + (x[N + k + GX + 1] + Ty[k + GX + 1]) * w11 - Dy[i];
      Cx[i] = cx * (1 - wh); Cy[i] = cy * (1 - wh);
    }
  }
  return { Cx, Cy, iters: it, terms: terms.length, nodes: N, h, timeout };
}

/** Kaynaktaki düz çizginin çıktıdaki görüntüsü: o + D(o) = p sabit noktaları (ROI px), gizli olan hariç. */
function imageOf(F, Dx, Dy, l, hide) {
  const { rx0, ry0, RW, RH } = F;
  const pts = [];
  for (let t = l.t0; t <= l.t1; t += 2) {
    const px = l.cx - rx0 + t * l.ux, py = l.cy - ry0 + t * l.uy;
    if (px < 0 || py < 0 || px > RW - 1 || py > RH - 1) continue;
    // Çıktıda bu kaynak noktayı gösteren piksel o: o + D(o) = p (sabit nokta).
    let ox = px, oy = py, conv = false;
    for (let k = 0; k < 300; k++) {
      const d = fieldAt(Dx, Dy, RW, RH, ox, oy);
      const nx2 = 0.5 * ox + 0.5 * (px - d[0]), ny2 = 0.5 * oy + 0.5 * (py - d[1]);
      if (Math.abs(nx2 - ox) + Math.abs(ny2 - oy) < 1e-3) { ox = nx2; oy = ny2; conv = true; break; }
      ox = nx2; oy = ny2;
    }
    if (!conv) continue;
    const xi = clamp(Math.round(ox), 0, RW - 1), yi = clamp(Math.round(oy), 0, RH - 1);
    if (hide[yi * RW + xi]) continue; // kafanın altına giren kısım görünmez
    pts.push([ox, oy]);
  }
  return pts;
}

/** Bükülme: kaynaktaki düz çizginin çıktıdaki görüntüsünün doğrudan en büyük sapması (px). */
function bendOf(F, Dx, Dy, lines, hide, minLen = 0) {
  const res = [];
  for (const l of lines) {
    if (l.L < minLen) continue;
    const pts = imageOf(F, Dx, Dy, l, hide);
    if (pts.length < 4) continue;
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let dev = 0;
    for (const [x, y] of pts) dev = Math.max(dev, Math.abs(-(x - mx) * uy + (y - my) * ux));
    res.push({ L: l.L, dev, cx: l.cx, cy: l.cy });
  }
  return res;
}

const bendSumm = (b) => ({ n: b.length, max: b.reduce((a, r) => Math.max(a, r.dev), 0), over: b.filter((r) => r.dev > LK_BEND_COUNT_PX).length });

/** Yeni kafa dışında, kaynağı eski kafanın içinde (kenardan >2 px) olan piksel: saç/kafa sıvanması. */
function smearOf(F, Dx, Dy, newHead, inner) {
  const { RW, RH } = F;
  let n = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (newHead[i]) continue;
    const sx = Math.round(x + Dx[i]), sy = Math.round(y + Dy[i]);
    if (sx >= 0 && sy >= 0 && sx < RW && sy < RH && inner[sy * RW + sx]) n++;
  }
  return n;
}

/**
 * Katlanma/esneme: yeni kafa dışında HER pikselde ters eşlemenin Jakobyeni.
 * neg: det<0 (katlanma), stretch: en küçük tekil değer < 0.4, near*: kafaya
 * LK_S_NEAR_FACE·yüz boyu içinde.
 */
function jacobianOf(F, Dx, Dy, newHead, dNew) {
  const { RW, RH, faceH } = F;
  const near = LK_S_NEAR_FACE * faceH;
  const negMask = new Uint8Array(RW * RH), strMask = new Uint8Array(RW * RH);
  let neg = 0, stretch = 0, nearStretch = 0, minDet = 9;
  for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) {
    const i = y * RW + x;
    if (newHead[i]) continue;
    const a = 1 + (Dx[i + 1] - Dx[i - 1]) / 2, b = (Dx[i + RW] - Dx[i - RW]) / 2, c = (Dy[i + 1] - Dy[i - 1]) / 2, d = 1 + (Dy[i + RW] - Dy[i - RW]) / 2;
    const det = a * d - b * c;
    if (det < minDet) minDet = det;
    if (det < 0) { neg++; negMask[i] = 1; }
    const t = a * a + b * b + c * c + d * d, smin = Math.sqrt(Math.max(0, (t - Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2));
    if (smin < 0.4) { stretch++; strMask[i] = 1; if (dNew[i] <= near) nearStretch++; }
  }
  return { neg, stretch, nearStretch, minDet, negMask, strMask };
}

/** a maskesinde olup b maskesine > dist px uzak piksel sayısı (yeni yerde katlanma/esneme). */
function newAt(a, b, RW, RH, dist) {
  let any = false;
  for (let i = 0; i < a.length; i++) if (b[i]) { any = true; break; }
  const d = any ? distanceTo(b, RW, RH) : null;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] && (!d || d[i] > dist)) n++;
  return n;
}

/** Görüntü dışından örnek (px, en büyük). */
function overflowOf(F, Dx, Dy) {
  const { rx0, ry0, RW, RH, FW, FH } = F;
  let ov = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (!Dx[i] && !Dy[i]) continue;
    const sx = x + rx0 + Dx[i], sy = y + ry0 + Dy[i];
    ov = Math.max(ov, -sx, -sy, sx - (FW - 1), sy - (FH - 1));
  }
  return ov;
}

/**
 * Yeniden algılama: ham karedeki bağımsız uzun çizgilerin (≥40 px) çıktıdaki
 * beklenen görüntüsü boyunca, ÇIKTIDA aynı dedektörle aynı doğrultuda (±12°)
 * algılanan kenarın örttüğü pay. Kırılan/katlanan çizgi parçalanır, pay düşer.
 * (Toplam çizgi boyu ölçülemez: 7e0 c1'de bugünkü çift neon kavsi boyu artırıyordu.)
 */
async function coverageOf(img, FW, FH, F, Dx, Dy, rawLines, excl) {
  const { RW, RH, rx0, ry0 } = F;
  // Çıktıda eşik düşük, hamda yalnız belirgin çizgi (LK_COVER_MAG): örnekleme
  // bulanıklığı soluk dokuyu (99ba c5 duvar çizgileri) kaybettiriyordu, kırık değil.
  const L = await independentLines(img, FW, FH, F, excl, LK_COVER_OUT_MAG);
  const mk = new Uint8Array(RW * RH), mux = new Float32Array(RW * RH), muy = new Float32Array(RW * RH);
  for (const l of L) {
    for (let t = l.t0; t <= l.t1; t += 0.5) {
      const x = Math.round(l.cx - rx0 + t * l.ux), y = Math.round(l.cy - ry0 + t * l.uy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= RW || yy >= RH) continue;
        const j = yy * RW + xx;
        mk[j] = 1; mux[j] = l.ux; muy[j] = l.uy;
      }
    }
  }
  const cosT = Math.cos((12 * Math.PI) / 180);
  let hit = 0, all = 0;
  for (const l of rawLines) {
    if (l.L < LK_INDEP_MIN_LEN || !(l.mag >= LK_COVER_MAG)) continue;
    const pts = imageOf(F, Dx, Dy, l, excl);
    for (let k = 1; k + 1 < pts.length; k++) {
      const tx = pts[k + 1][0] - pts[k - 1][0], ty = pts[k + 1][1] - pts[k - 1][1], tn = Math.hypot(tx, ty) || 1;
      const j = Math.round(pts[k][1]) * RW + Math.round(pts[k][0]);
      all++;
      if (mk[j] && Math.abs((tx * mux[j] + ty * muy[j]) / tn) >= cosT) hit++;
    }
  }
  return all ? hit / all : 1;
}

/**
 * Bugünkü alanı (F.Dx/F.Dy, F.act) çizgi korumalı alanla değiştirmeyi dener.
 * mode: "applied" (bugün bükülen kare, kapı bugüne göre) | "structured"
 * (bugün atlanan kare, sıfır tolerans). render(Dx, Dy, act) → tam kare RGB.
 * todayOut: bugünkü çıktı RGB (structured'da ham kare).
 * Döner { used, reason, Dx, Dy, act, out, stats } — used=false ise Dx/Dy/act
 * F'nin kendi dizileri (bugünkü alan, aynen).
 */
async function keepLines(rgb, FW, FH, F, { mode = "applied", render, todayOut, deadline = Infinity, debug = false } = {}) {
  const t0 = Date.now();
  const end = Math.min(deadline, t0 + LK_MAX_MS);
  const { RW, RH, m, Dx, Dy, act, faceH, rx0, ry0 } = F;
  const fallback = (reason, stats = {}) => ({ used: false, reason, Dx, Dy, act, out: null, stats: { ...stats, ms: Date.now() - t0 } });
  const N = RW * RH;
  // YENİ KAFA: kaynağı (D0 ile) eski kafanın içinde kalan çıktı pikseli.
  // ÇİVİ (keep): yeni kafa + kaynağı saç ucu (head ≥ 0.25) olan + bugün saç
  // ucu duran (0.25 ≤ head < 0.5) + kaynağı kulak bandında olan piksel. İlk
  // prototip bunları arka plan sayıp kaydırdı: ca61 c9'da katlanma kulak
  // üstünden geçti, kulak-saç arası koyu şerit genişledi.
  const newHead = new Uint8Array(N), keep = new Uint8Array(N);
  const earBand = Math.max(2, LK_EAR_BAND * faceH);
  const earY0 = F.browY - 0.1 * faceH, earY1 = F.chinY + 0.02 * faceH;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    const sx = clamp(Math.round(x + Dx[i]), 0, RW - 1), sy = clamp(Math.round(y + Dy[i]), 0, RH - 1), si = sy * RW + sx;
    if (m[si]) { newHead[i] = 1; keep[i] = 1; continue; }
    const hs = F.head[(sy + ry0) * FW + sx + rx0], ho = F.head[(y + ry0) * FW + x + rx0];
    if (hs >= 0.25 || (ho >= 0.25 && ho < 0.5)) { keep[i] = 1; continue; }
    const gsy = sy + ry0;
    if (F.dist[si] <= earBand && gsy >= earY0 && gsy <= earY1) keep[i] = 1;
  }
  let lines;
  try {
    lines = await linesAround(rgb, FW, FH, F);
  } catch (e) {
    return fallback(`lines-error:${e.message || e}`);
  }
  if (!lines.length) return fallback("no-lines", { lines: 0 });
  const protB = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const g = (y + ry0) * FW + x + rx0;
    if (!keep[y * RW + x] && F.head[g] < 0.5 && F.prot[g] >= 0.5) protB[y * RW + x] = 1;
  }
  const sol = solveCorrection(F, lines, keep, protB, { deadline: end });
  if (sol.timeout) return fallback("time", { lines: lines.length, it: sol.iters });
  // Korunan piksel (el, kıyafet, nesne; prot ≥ 0.5) bugünkü D0'da ÇİVİLİ,
  // çevresinde LK_PIN_RAMP boyunca D0'a geçiş. İlk prototip korunanı hücre
  // ortalamasına çekiyordu: >1 px kayan korunan piksel 0eeb c0'da 8279 → 10143,
  // 629b c3'te 9408 → 13141 (10-22 uzuv koruması).
  const { Cx, Cy } = sol;
  const pin = new Float32Array(N);
  const dP = distanceTo(protB, RW, RH), pinRamp = Math.max(3, LK_PIN_RAMP * faceH);
  for (let i = 0; i < N; i++) {
    pin[i] = keep[i] || protB[i] ? 1 : 1 - smooth(dP[i] / pinRamp);
    Cx[i] *= 1 - pin[i]; Cy[i] *= 1 - pin[i];
  }
  // Sıvanma koruması: çivisiz piksel, bugün örneklemediği eski kafanın içinden
  // örneklemesin — C kaynak dışarıda kalana kadar kısılır. (Aynı kırpma korunan
  // nesneye de denendi: 7e0 c1'de piksel başına kırpma yeni katlanma yaptı, 99ba
  // c5'te etkisizdi; korunan nesne yalnız çivi + rampa ile.)
  const blocked = (sx, sy) => { const xi = Math.round(sx), yi = Math.round(sy); return xi >= 0 && yi >= 0 && xi < RW && yi < RH && m[yi * RW + xi] === 1; };
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (pin[i] >= 1 || (!Cx[i] && !Cy[i])) continue;
    if (blocked(x + Dx[i], y + Dy[i]) || !blocked(x + Dx[i] + Cx[i], y + Dy[i] + Cy[i])) continue;
    let lo = 0, hi = 1;
    for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2; if (blocked(x + Dx[i] + mid * Cx[i], y + Dy[i] + mid * Cy[i])) hi = mid; else lo = mid; }
    Cx[i] *= lo; Cy[i] *= lo;
  }
  const NDx = new Float64Array(N), NDy = new Float64Array(N), NAct = new Uint8Array(N);
  for (let i = 0; i < N; i++) { NDx[i] = Dx[i] + Cx[i]; NDy[i] = Dy[i] + Cy[i]; }
  // Görüntü kenarı: alan kenarda sıfıra iner (kenar satırı çoğaltılıp çizgi
  // olmasın), çivili piksel sonra yine D0 (D0 zaten kenar korumalı).
  borderGuard(NDx, NDy, F);
  for (let i = 0; i < N; i++) {
    if (pin[i] >= 1) { NDx[i] = Dx[i]; NDy[i] = Dy[i]; NAct[i] = act[i]; continue; }
    NAct[i] = act[i] || Math.abs(NDx[i]) >= 0.01 || Math.abs(NDy[i]) >= 0.01 ? 1 : 0;
  }
  // Doğrulama: korunan pikselin (prot ≥ 0.5, kafa dışı) alanı bugünküyle aynı mı.
  let pinDiff = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = (y + ry0) * FW + x + rx0;
    if (F.head[g] < 0.5 && F.prot[g] >= 0.5 && (NDx[i] !== Dx[i] || NDy[i] !== Dy[i])) pinDiff++;
  }
  if (Date.now() > end) return fallback("time", { lines: lines.length, it: sol.iters });
  // ---- KAPI ----
  const dNew = distanceTo(newHead, RW, RH);
  const inner = new Uint8Array(N);
  const dIn = distanceTo(m.map((v) => 1 - v), RW, RH);
  for (let i = 0; i < N; i++) inner[i] = m[i] && dIn[i] > 2 ? 1 : 0;
  const structured = mode === "structured";
  const Z = structured ? new Float64Array(N) : null; // bugün: kimlik (bükme yok)
  const TDx = structured ? Z : Dx, TDy = structured ? Z : Dy;
  const jN = jacobianOf(F, NDx, NDy, newHead, dNew), jT = jacobianOf(F, TDx, TDy, newHead, dNew);
  const smN = smearOf(F, NDx, NDy, newHead, inner), smT = structured ? 0 : smearOf(F, TDx, TDy, newHead, inner);
  const ovN = overflowOf(F, NDx, NDy);
  const cN = bendSumm(bendOf(F, NDx, NDy, lines, newHead, 60)), cT = bendSumm(bendOf(F, TDx, TDy, lines, newHead, 60));
  let L2;
  try {
    L2 = await independentLines(rgb, FW, FH, F);
  } catch (e) {
    return fallback(`indep-error:${e.message || e}`);
  }
  const iN = bendSumm(bendOf(F, NDx, NDy, L2, newHead, LK_INDEP_MIN_LEN)), iT = bendSumm(bendOf(F, TDx, TDy, L2, newHead, LK_INDEP_MIN_LEN));
  if (Date.now() > end) return fallback("time", { lines: lines.length, it: sol.iters });
  const newFold = structured ? jN.neg : newAt(jN.negMask, jT.negMask, RW, RH, LK_NEWFOLD_DIST);
  const newStr = structured ? jN.stretch : newAt(jN.strMask, jT.strMask, RW, RH, LK_NEWFOLD_DIST);
  const out = render(NDx, NDy, NAct);
  // Sonradan gelen iş (iki yeniden algılama) da süre sınırına bağlı (900 sn bütçe).
  if (Date.now() > end) return fallback("time", { lines: lines.length, it: sol.iters });
  // Yeniden algılama: kafa + bandı (iki çıktıda aynı) dışlanır.
  const ex = new Uint8Array(N);
  const exBand = 2 * Math.max(2, LK_HEAD_BAND * faceH) + 3;
  const dKeep = distanceTo(keep, RW, RH);
  for (let i = 0; i < N; i++) ex[i] = dKeep[i] <= exBand ? 1 : 0;
  const covN = await coverageOf(out, FW, FH, F, NDx, NDy, L2, ex);
  if (Date.now() > end) return fallback("time", { lines: lines.length, it: sol.iters });
  const covT = await coverageOf(todayOut, FW, FH, F, TDx, TDy, L2, ex);
  if (Date.now() > end) return fallback("time", { lines: lines.length, it: sol.iters });
  const stats = {
    lines: lines.length, indep: L2.length, it: sol.iters, terms: sol.terms, nodes: sol.nodes,
    negN: jN.neg, negT: jT.neg, newFold, newStr, minDetN: +jN.minDet.toFixed(3), minDetT: +jT.minDet.toFixed(3),
    strN: jN.stretch, strT: jT.stretch, nearStrN: jN.nearStretch, nearStrT: jT.nearStretch,
    smearN: smN, smearT: smT, ovN: +ovN.toFixed(2), pinDiff,
    bendN: +cN.max.toFixed(2), bendT: +cT.max.toFixed(2), indN: +iN.max.toFixed(2), indT: +iT.max.toFixed(2), indOverN: iN.over, indOverT: iT.over,
    covN: +covN.toFixed(3), covT: +covT.toFixed(3),
  };
  const fails = [];
  if (structured) {
    if (jN.neg > 0) fails.push("katlanma");
    if (jN.nearStretch > LK_S_NEAR_STRETCH) fails.push("kafaYanıEsneme");
    if (smN > 0) fails.push("sıvanma");
    if (cN.max > LK_S_MAX_BEND || iN.max > LK_S_MAX_BEND) fails.push("bükülme");
    if (covN < covT - LK_REDETECT_TOL) fails.push("çizgiKırık");
  } else {
    if (jN.neg > jT.neg) fails.push("katlanma");
    if (newFold > LK_NEWFOLD_EPS) fails.push("yeniKatlanma");
    if (newStr > LK_NEWSTR_EPS) fails.push("yeniEsneme");
    if (jN.minDet < Math.min(jT.minDet, LK_MINDET_FLOOR)) fails.push("minDet");
    if (jN.stretch > jT.stretch + LK_STRETCH_EPS) fails.push("esneme");
    if (smN > smT) fails.push("sıvanma");
    if (cN.max > Math.max(cT.max, LK_CONSTRAINED_MIN)) fails.push("kısıtlıBükülme");
    if (iN.max > iT.max + LK_BEND_TOL || iN.over > iT.over) fails.push("bağımsızBükülme");
    if (covN < covT - LK_REDETECT_TOL) fails.push("çizgiKırık");
  }
  if (ovN > 1) fails.push("kenarDışı");
  if (pinDiff) fails.push("çivi");
  stats.ms = Date.now() - t0;
  const dbg = debug ? { NDx, NDy, keep, newHead, pin, out } : undefined;
  if (fails.length) return { ...fallback(fails.join("+"), stats), stats: { ...stats, ms: Date.now() - t0 }, dbg };
  return { used: true, reason: null, Dx: NDx, Dy: NDy, act: NAct, out, stats, dbg };
}

module.exports = {
  keepLines,
  _testables: { coverageOf, imageOf, detectLines, linesAround, independentLines, solveCorrection, bendOf, bendSumm, jacobianOf, smearOf, overflowOf, fieldAt, newAt, LK_MAX_MS, LK_S_MAX_BEND, LK_NEWFOLD_EPS },
};
