"use strict";
/**
 * ŞABLON KAFASI KALINTISI TEMİZLİĞİ (2026-10-30, c2e8eff1, kullanıcı: "base
 * fotonun saç silüeti kalmış. bu eski fotodan saç silüeti kalma problemini
 * kesin olarak çözmemiz lazım ... silüet kalmamalı ... api maliyet oluşturmadan").
 *
 * GÖZLEM (c2e8eff1 c0/c5/c9): kalıntı TAM şablon kafasının durduğu yerde —
 * c0 kullanıcının koyu kısa saçının üstünde şablonun sarı saçı, c9 kahverengi
 * kabarık perçem, c5 baş aşağı çizilmiş, şablonun beresi eski yerinde havada.
 * Eski kafa çevresi temizliği (headSurround) üçünü de bırakıyordu.
 *
 * DENENİP BIRAKILANLAR (aynı gün, yerel, 10 kare):
 *  - Yalnız renk karışımı (çıktı ≈ zemin + α·(şablon − zemin)): c5 bereyi
 *    buldu, c0/c9'u bulamadı — sınıflandırıcı izi kullanıcının saçıyla tek
 *    parça "saç" sayıyor, altın tavan ile sarı saç rengi de birbirine yakın.
 *  - Kullanıcının saç rengine göre "saç içindeki iz": kulakları ve yan saçı
 *    iz sayıp kesti (c0, c2, c3, c4), c9'u yine bulamadı.
 *  - LaMa zemin plakası: kafa deliğine paltonun devamı gibi koyu leke çizdi.
 *
 * YÖNTEM (koordinat): kullanıcının kafa+saç sınırı SELFIE'den bilinir. Baş
 * açısı çıktıya en yakın selfie'nin kafa maskesi, göz ortası ve çene ucu iki
 * sabit nokta alınarak (benzerlik dönüşümü) çıktının yüzüne taşınır = beklenen
 * kafa. Şablonda şapka varsa şablonun şapkası da aynı yolla yeni yüze taşınıp
 * beklenen kafaya katılır. Şablon kafasının beklenen kafanın (pay ile) DIŞINDA
 * kalan kısmında kafa sınıfı (saç/yüz/aksesuar) ya da yarı saydam karışım
 * görülen her piksel iz sayılır ve yerel LaMa ile zemine çevrilir; beklenen
 * kafanın içine dokunulmaz. Selfie yoksa yalnız kafa dışındaki karışım testi.
 *
 * Şablon ve çıktı AYNI koordinat uzayında olmalı (sade akışta tplForEyewear;
 * kıyafet kayması 20 karede 0-1 px). Kafa bükmeden (headWarp) ÖNCE çalışır.
 * Yalnız kusur dolar (head-surround-defects-only).
 */
const sharp = require("sharp");

// Kafa kesiti (kare), iki yüz genişliğinin büyüğüne oranla; yukarı ve aşağı pay.
const CROP_FACE = 4.4;
const CROP_UP_FACE = 1.5;
const CROP_DOWN_FACE = 0.4;
// Ölçü çözünürlüğü (kare kenarı, px).
const WORK_MAX = 640;
const SEG_MIN = 0.5;
// Şablon kafası maskesinin genişlemesi (soluk teller sınıfta arka plan).
const TPL_GROW_FACE = 0.05;
// Kullanıcının kafası çevresinde zemin tahmini/dolgu bağlamından çıkarılan pay.
const HOLE_GROW_FACE = 0.03;
// SELFIE PROFİLİ: kesit (yüz genişliği), maske çözünürlüğü, beklenen kafa payı
// (+ açı farkı başına ek pay).
const PROFILE_CROP_FACE = 3.6;
const PROFILE_N = 256;
const EXP_MARGIN_FACE = 0.06;
const EXP_MARGIN_PER_YAW = 0.1;
// 3B POZ FARKI PAYI (2026-10-31, 21e56b20 c5/c7, kullanıcı: "kafanın belli
// yerlerini silmişsin"): selfie kafa çizgisi göz-çene iki noktasıyla taşınıyor;
// çıktı başı selfie'den farklı eğik/dönükse (c7: çıktı −17°/−21° pitch, en
// yakın selfie önden) çizgi kafanın arkasını ve kulağı dışarıda bırakıp
// sildirdi. Eski pay yalnız 68 noktalı yaw farkına bakıyordu (pitch'i görmez,
// gözlükte kayar). Pay artık 3B yaw+pitch farkıyla (derece) büyür.
// Bu kadar dereceye kadar selfie çizgisi güvenilir, pay büyümez (c2e8eff1 c0:
// 5° farkta 0.09 pay şablonun saç üstündeki sarı tutamını korudu).
const EXP_MARGIN_PER_DEG = 0.006;
const EXP_MARGIN_DEAD_DEG = 6;
const EXP_MARGIN_MAX = 0.3;
// KULLANICININ DERİSİ HİÇ SİLİNMEZ (aynı gün): şablon izi saç/şapka; yüze
// bağlı yüz/vücut derisi (kulak, burun, alın, çene, boyun) iz değildir.
// c2e8eff1 10 ham karenin 6'sında çene/boyun kenarı, 21e c5'te burun-alın
// önü siliniyordu. Kenarın yumuşak pikselleri de bu bantla korunur.
const USER_SKIN_MIN = 0.35;
const USER_SKIN_BAND_FACE = 0.015;
// Şablon şapkası: kaş üstünde aksesuar sınıfı bu kadar (yüz²) ise şapka.
const HAT_MIN_FACE2 = 0.1;
// Beklenen kafanın dışında "kafa gibi" sayılan sınıf skorları.
const OUT_HAIR_MIN = 0.25;
const OUT_SKIN_MIN = 0.35;
const OUT_HAT_MIN = 0.35;
// Kişi maskesi (selfie_segmenter) bu kadarsa da kafa gibi: soluk şablon saçı
// çok sınıflı modelde "zemin", kişi maskesinde dolu çıkıyor (c0 sarı saç;
// bkz. hafıza ghost-hair-is-background-class). Yalnız ana kişiye bağlı bileşen.
const OUT_PERSON_MIN = 0.35;
// Karışım testi: |şablon − zemin| alt sınırı, yarı saydamlık aralığı, artık.
const CONTRAST_MIN = 22;
const ALPHA_LO = 0.18;
const ALPHA_HI = 0.88;
const RESID_FRAC = 0.45;
const RESID_ABS = 6;
// Selfie yoksa: dolu kafaya yakın (EDGE_FACE) pikselde iz ancak şablon karışımı
// kullanıcının kafa rengi + zemin karışımından EDGE_RATIO kat iyi açıklıyorsa.
const EDGE_FACE = 0.07;
const EDGE_RATIO = 0.6;
const PROTECT_FACE = 0.02;
// Zemin tahmini: kafa/kişi dışı piksellerin artan pencerelerde ağırlıklı ortalaması.
const BG_RADII_FACE = [0.06, 0.15, 0.35, 0.8];
const BG_COVER_MIN = 0.12;
const SMOOTH_FACE = 0.025;
// Kullanıcının saç rengine bu kadar (RGB) yakın saç pikseli beklenen kafanın
// dışında da korunur; ortanca bu kadar dolu saç skorlu pikselden.
const USER_HAIR_MIN = 0.6;
const USER_HAIR_SAME = 30;
const USER_HAIR_REACH_FACE = 0.05;
// İz kırıntısı: izin bu kadar (yüz genişliği) yakınında, temiz zeminden bu
// kadar (kanal, 0-255) farklı piksel de silinir.
const CRUMB_REACH_FACE = 0.08;
const CRUMB_DIFF = 28;
// LaMa'ya giden deliğin en büyük açıklığı (px): tek 512 parçasına sığsın.
const LAMA_SPAN_MAX = 440;
// Bundan küçük iz bileşeni (yüz² payı) yok sayılır; genişleme ve kenar yumuşatma.
const MIN_AREA_FACE2 = 0.004;
const GROW_FACE = 0.03;
const FEATHER_FACE = 0.02;

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

async function rawOf(buf, W = null, H = null) {
  let p = sharp(buf).rotate().removeAlpha();
  if (W && H) p = p.resize(W, H, { fit: "fill" });
  const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** Kare kesit (side), n×n'ye ölçeklenmiş raw RGB. */
async function cropSquare(data, W, H, left, top, side, n) {
  const p = sharp(data, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width: side, height: side });
  return (n === side ? p : p.resize(n, n, { kernel: "lanczos3" })).raw().toBuffer();
}

function dilate(mask, W, H, r, distanceTo) {
  if (r <= 0) return Uint8Array.from(mask);
  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
  if (!any) return new Uint8Array(W * H);
  const d = distanceTo(mask, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) if (d[i] <= r) out[i] = 1;
  return out;
}

/** cand içinde, seed'e 4-komşulukla bağlı pikseller. SAF. */
function connected(cand, seed, W, H) {
  const out = new Uint8Array(W * H);
  const st = [];
  for (let i = 0; i < seed.length; i++) if (seed[i] && cand[i]) { out[i] = 1; st.push(i); }
  while (st.length) {
    const i = st.pop(), x = i % W, y = (i - x) / W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && cand[j] && !out[j]) { out[j] = 1; st.push(j); }
  }
  return out;
}

/** minArea'dan küçük 4-komşu bileşenleri siler. SAF. */
function dropSmall(mask, W, H, minArea) {
  const seen = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % W, y = (i - x) / W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
    }
    if (comp.length >= minArea) for (const i of comp) out[i] = 1;
  }
  return out;
}

/** 3 kanallı raw için kutu bulanıklığı (yarıçap r). SAF. */
function boxBlur3(src, W, H, r) {
  const tmp = new Float32Array(W * H * 3), out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[(y * W + xx) * 3 + c]; n++; } }
        tmp[(y * W + x) * 3 + c] = s / n;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[(yy * W + x) * 3 + c]; n++; } }
        out[(y * W + x) * 3 + c] = s / n;
      }
    }
  }
  return out;
}

/** Tek kanallı dizinin kutu toplamı (yarıçap r, kenarda kırpılır), integral görüntüyle. SAF. */
function boxSum(src, W, H, r) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
    }
  }
  return out;
}

/**
 * Ağırlıklı ortalama (normalize evrişim), artan pencerelerde: her piksel için
 * pencerenin en az cover payı ağırlıklıysa o ölçünün ortalaması. rgb: 3 kanal,
 * w: ağırlık (0/1). Dönüş { v: Float32Array(3N), ok: Uint8Array(N) }. SAF.
 */
function maskedMean(rgb, w, W, H, radii, cover) {
  const N = W * H;
  const v = new Float32Array(N * 3), ok = new Uint8Array(N);
  const ch = [0, 1, 2].map((c) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = rgb[i * 3 + c] * w[i]; return a; });
  for (const r of radii) {
    const den = boxSum(w, W, H, r);
    const num = ch.map((a) => boxSum(a, W, H, r));
    const area = (2 * r + 1) * (2 * r + 1);
    for (let i = 0; i < N; i++) {
      if (ok[i] || den[i] < cover * area || den[i] <= 0) continue;
      for (let c = 0; c < 3; c++) v[i * 3 + c] = num[c][i] / den[i];
      ok[i] = 1;
    }
  }
  return { v, ok };
}

/** o'nun b ile ref karışımı olarak artığı ve oranı. SAF. */
function mixFit(o, ref, b) {
  const d0 = ref[0] - b[0], d1 = ref[1] - b[1], d2 = ref[2] - b[2];
  const c2 = d0 * d0 + d1 * d1 + d2 * d2;
  const e0 = o[0] - b[0], e1 = o[1] - b[1], e2 = o[2] - b[2];
  const a = c2 > 1e-6 ? (e0 * d0 + e1 * d1 + e2 * d2) / c2 : 0;
  const ac = Math.max(0, Math.min(1, a));
  const r0 = e0 - ac * d0, r1 = e1 - ac * d1, r2 = e2 - ac * d2;
  return { a, c2, resid: Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2), od: Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2) };
}

/**
 * Yarı saydam şablon izi, tek piksel. o/t/b: RGB üçlüleri (çıktı, şablon,
 * zemin); u: kullanıcının yakındaki kafa rengi (kenarda) ya da null.
 * Dönüş α ya da null (iz değil). SAF.
 */
function ghostAlpha(o, t, b, u = null) {
  const ft = mixFit(o, t, b);
  if (ft.c2 < CONTRAST_MIN * CONTRAST_MIN) return null;
  if (ft.a < ALPHA_LO || ft.a > ALPHA_HI) return null;
  if (ft.resid > RESID_FRAC * ft.od + RESID_ABS) return null;
  if (u) {
    const fu = mixFit(o, u, b);
    if (!(ft.resid + RESID_ABS < EDGE_RATIO * (fu.resid + RESID_ABS))) return null;
  }
  return ft.a;
}

/** İşaretli baş dönüşü (68 nokta): burun ucunun dış göz köşeleri arasındaki yeri. SAF. */
function signedYaw(P) {
  const span = P[45].x - P[36].x;
  if (!(Math.abs(span) > 1e-6)) return 0;
  return Math.max(-1, Math.min(1, ((P[30].x - P[36].x) / span - 0.5) * 2));
}

/** Göz ortası (iki göz merkezinin ortası) ve çene ucu. SAF. */
function eyeChin(P) {
  const avg = (a, b) => { let x = 0, y = 0; for (let k = a; k <= b; k++) { x += P[k].x; y += P[k].y; } return { x: x / (b - a + 1), y: y / (b - a + 1) }; };
  const l = avg(36, 41), r = avg(42, 47);
  return { E: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }, C: { x: P[8].x, y: P[8].y } };
}

/**
 * src (srcN×srcN) maskesini, (Es,Cs) → (Ed,Cd) benzerlik dönüşümüyle dst
 * (n×n) uzayına taşır (ters eşleme, en yakın komşu). SAF.
 */
function mapMask(src, srcN, Es, Cs, Ed, Cd, n) {
  const vs = { x: Cs.x - Es.x, y: Cs.y - Es.y }, vd = { x: Cd.x - Ed.x, y: Cd.y - Ed.y };
  const ls = Math.hypot(vs.x, vs.y), ld = Math.hypot(vd.x, vd.y);
  const out = new Uint8Array(n * n);
  if (!(ls > 1e-6) || !(ld > 1e-6)) return out;
  const sc = ls / ld;
  const ang = Math.atan2(vs.y, vs.x) - Math.atan2(vd.y, vd.x);
  const ca = Math.cos(ang) * sc, sa = Math.sin(ang) * sc;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const qx = x - Ed.x, qy = y - Ed.y;
      const px = Math.round(Es.x + ca * qx - sa * qy), py = Math.round(Es.y + sa * qx + ca * qy);
      if (px >= 0 && py >= 0 && px < srcN && py < srcN && src[py * srcN + px]) out[y * n + x] = 1;
    }
  }
  return out;
}

/** Kafa maskesi (n×n uzayı): sınıflar ∪ yüz ovali, ovale bağlı, çene altı hariç. */
function headMask(P, pts, n, CLASSES, faceOval, inPolygon) {
  const oval = faceOval(pts);
  const inOval = new Uint8Array(n * n);
  const xs = oval.map((p) => p.x), ys = oval.map((p) => p.y);
  for (let y = clampI(Math.min(...ys), 0, n - 1); y <= clampI(Math.max(...ys), 0, n - 1); y++) {
    for (let x = clampI(Math.min(...xs), 0, n - 1); x <= clampI(Math.max(...xs), 0, n - 1); x++) {
      if (inPolygon(oval, x, y)) inOval[y * n + x] = 1;
    }
  }
  const chin = pts[8].y;
  const brow = Math.min(...pts.slice(17, 27).map((p) => p.y));
  const hf = Math.max(1, chin - brow);
  const cand = new Uint8Array(n * n);
  const hat = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const y = Math.floor(i / n);
    if (inOval[i]) { cand[i] = 1; continue; }
    if (y > chin + 0.05 * hf) continue;
    if (P[CLASSES.bodySkin][i] >= SEG_MIN || P[CLASSES.clothes][i] >= SEG_MIN) continue;
    const isHat = P[CLASSES.others][i] >= SEG_MIN && y < brow + 0.2 * hf;
    if (isHat) hat[i] = 1;
    if (P[CLASSES.hair][i] >= SEG_MIN || P[CLASSES.faceSkin][i] >= SEG_MIN || isHat) cand[i] = 1;
  }
  const head = connected(cand, inOval, n, n);
  for (let i = 0; i < n * n; i++) if (!head[i]) hat[i] = 0;
  return { head, inOval, hat };
}

const faceWidth = (lm) => Math.max(lm.box.width, Math.hypot(lm.pts[0].x - lm.pts[16].x, lm.pts[0].y - lm.pts[16].y));

/**
 * Selfie'nin kafa profili: yüz çevresi kare kesitte kafa maskesi (saç + yüz +
 * şapka, yüze bağlı), göz ortası, çene ucu, işaretli baş dönüşü. null: yüz yok.
 */
async function headProfileOf(buf) {
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { faceOval, inPolygon } = require("./headSurround");
  const s = await rawOf(buf);
  const J = await sharp(s.data, { raw: { width: s.W, height: s.H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const lm = (await faceLandmarks(J)) || (await faceLandmarks(J, 0.1));
  if (!lm) return null;
  const fw = faceWidth(lm);
  const cx = lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const side = Math.min(s.W, s.H, Math.round(PROFILE_CROP_FACE * fw));
  const left = clampI(cx - side / 2, 0, s.W - side);
  const top = clampI(lm.box.y + lm.box.height / 2 - 0.62 * side, 0, s.H - side);
  const n = PROFILE_N, k = n / side;
  const crop = await cropSquare(s.data, s.W, s.H, left, top, side, n);
  const P = await classProbs(crop, n, n);
  const pts = lm.pts.map((p) => ({ x: (p.x - left) * k, y: (p.y - top) * k }));
  const { head } = headMask(P, pts, n, CLASSES, faceOval, inPolygon);
  // 3B baş pozu (derece, yalnız yüz ağı bulunduysa): selfie seçimi ve pay.
  let pose3d = null;
  try {
    const p3 = await require("./headPose3d").headPose3dOf(J, { loose: false });
    if (p3 && p3.src === "mesh") pose3d = { yaw: p3.yaw, pitch: p3.pitch };
  } catch (e) {
    console.error("Selfie 3B pozu ölçülemedi (68 noktalı yön kullanılır):", e.message || e);
  }
  return { yaw: signedYaw(lm.pts), n, mask: head, ...eyeChin(pts), pose3d };
}

/**
 * Çıktıya en uygun selfie profili ve beklenen kafa payı (yüz genişliği). 3B
 * poz (ağ) iki tarafta da varsa yaw+pitch farkı (derece), yoksa eski 68
 * noktalı yaw farkı. SAF.
 */
function pickProfile(profiles, yawO, pose3dO) {
  const d3 = (p) => (p && p.pose3d && pose3dO ? Math.hypot(p.pose3d.yaw - pose3dO.yaw, p.pose3d.pitch - pose3dO.pitch) : null);
  let prof = null, dBest = null;
  if (pose3dO) {
    for (const p of profiles || []) {
      const d = d3(p);
      if (d != null && (dBest == null || d < dBest)) { prof = p; dBest = d; }
    }
  }
  if (prof) return { prof, deg: dBest, margin: Math.min(EXP_MARGIN_MAX, EXP_MARGIN_FACE + EXP_MARGIN_PER_DEG * Math.max(0, dBest - EXP_MARGIN_DEAD_DEG)) };
  for (const p of profiles || []) if (p && (!prof || Math.abs(p.yaw - yawO) < Math.abs(prof.yaw - yawO))) prof = p;
  return prof ? { prof, deg: null, margin: EXP_MARGIN_FACE + EXP_MARGIN_PER_YAW * Math.abs(prof.yaw - yawO) } : null;
}

/**
 * Çıktıdaki şablon kafası izini siler. profiles: headProfileOf sonuçları
 * (kullanıcının selfie'leri; boşsa yalnız karışım testi). Dönüş { buf (PNG) |
 * null, applied, reason, ghostPx, ghostFace2, mode, ms }.
 */
async function cleanTemplateGhost(outputBuf, templateBuf, { profiles = [], debug = null } = {}) {
  const t0 = Date.now();
  const { faceLandmarks } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { faceOval, inPolygon } = require("./headSurround");
  const { fillCrop } = require("./lamaFill");
  const { distanceTo } = require("./headWarp")._testables;

  const o = await rawOf(outputBuf);
  const { W, H } = o;
  const t = await rawOf(templateBuf, W, H);
  const oJ = await sharp(o.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const tJ = await sharp(t.data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(oJ)) || (await faceLandmarks(oJ, 0.1));
  const lt = (await faceLandmarks(tJ)) || (await faceLandmarks(tJ, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template", ms: Date.now() - t0 };

  // Kare kesit: iki kafayı da kapsar.
  const fw = Math.max(faceWidth(lo), faceWidth(lt));
  const cxOf = (lm) => lm.pts.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const yTop = Math.min(lo.box.y, lt.box.y) - CROP_UP_FACE * fw;
  const yBot = Math.max(lo.pts[8].y, lt.pts[8].y) + CROP_DOWN_FACE * fw;
  const side = Math.min(W, H, Math.max(Math.round(CROP_FACE * fw), Math.round(yBot - yTop)));
  if (side < 48) return { buf: null, applied: false, reason: "tiny", ms: Date.now() - t0 };
  const left = clampI((cxOf(lo) + cxOf(lt)) / 2 - side / 2, 0, W - side);
  const top = clampI((yTop + yBot) / 2 - side / 2, 0, H - side);
  const n = Math.min(side, WORK_MAX);
  const k = n / side;
  const [oC, tC] = await Promise.all([cropSquare(o.data, W, H, left, top, side, n), cropSquare(t.data, W, H, left, top, side, n)]);
  const toWork = (lm) => lm.pts.map((p) => ({ x: (p.x - left) * k, y: (p.y - top) * k }));
  const po = toWork(lo), pt = toWork(lt);
  const fwk = fw * k;

  const [Po, Pt] = await Promise.all([classProbs(oC, n, n), classProbs(tC, n, n)]);
  const Ht = headMask(Pt, pt, n, CLASSES, faceOval, inPolygon);
  const Ho = headMask(Po, po, n, CLASSES, faceOval, inPolygon);
  const Th = dilate(Ht.head, n, n, TPL_GROW_FACE * fwk, distanceTo);
  const HoD = dilate(Ho.head, n, n, HOLE_GROW_FACE * fwk, distanceTo);

  // BEKLENEN KAFA: poza en yakın selfie'nin maskesi çıktının yüzüne taşınır.
  const ecO = eyeChin(po);
  const yawO = signedYaw(lo.pts);
  let pose3dO = null;
  if ((profiles || []).some((p) => p && p.pose3d)) {
    const p3 = await require("./headPose3d").headPose3dOf(oJ);
    if (p3 && p3.src === "mesh") pose3dO = { yaw: p3.yaw, pitch: p3.pitch };
  }
  const pick = pickProfile(profiles, yawO, pose3dO);
  let Ex = null;
  const prof = pick ? pick.prof : null;
  if (prof) {
    Ex = mapMask(prof.mask, prof.n, prof.E, prof.C, ecO.E, ecO.C, n);
    let hatPx = 0;
    for (let i = 0; i < n * n; i++) if (Ht.hat[i]) hatPx++;
    if (hatPx >= HAT_MIN_FACE2 * fwk * fwk) {
      const ecT = eyeChin(pt);
      const hatO = mapMask(Ht.hat, n, ecT.E, ecT.C, ecO.E, ecO.C, n);
      for (let i = 0; i < n * n; i++) if (hatO[i]) Ex[i] = 1;
    }
    for (let i = 0; i < n * n; i++) if (Ho.inOval[i]) Ex[i] = 1;
    Ex = dilate(Ex, n, n, pick.margin * fwk, distanceTo);
  }
  // Yüze bağlı deri (+ yumuşak kenar bandı): hiçbir yolda iz sayılmaz.
  const chinO = po[8].y;
  const skinC = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (Math.floor(i / n) > chinO + 0.6 * fwk) continue;
    if (Math.max(Po[CLASSES.faceSkin][i], Po[CLASSES.bodySkin][i]) >= USER_SKIN_MIN) skinC[i] = 1;
  }
  const userSkin = dilate(connected(skinC, Ho.inOval, n, n), n, n, USER_SKIN_BAND_FACE * fwk, distanceTo);

  // Zemin tahmini (karışım testi için): iki kafa, kıyafet ve vücut derisi dışı.
  const bgW = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (Th[i] || HoD[i]) continue;
    if (Po[CLASSES.clothes][i] >= SEG_MIN || Po[CLASSES.bodySkin][i] >= SEG_MIN) continue;
    bgW[i] = 1;
  }
  const bg = maskedMean(oC, bgW, n, n, BG_RADII_FACE.map((f) => Math.max(2, Math.round(f * fwk))), BG_COVER_MIN);
  const sr = Math.max(1, Math.round(SMOOTH_FACE * fwk));
  const oF = boxBlur3(oC, n, n, sr), tF = boxBlur3(tC, n, n, sr);

  const cand = new Uint8Array(n * n);
  let core;
  let keep = null;
  if (Ex) {
    // Beklenen kafanın dışı: kafa sınıfı, kafaya bağlı kişi maskesi ya da yarı
    // saydam karışım = iz.
    const Mo = await require("./headScale").personMask(Buffer.from(oC), n, n);
    const pc = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (Mo[i] >= OUT_PERSON_MIN || Ho.head[i]) pc[i] = 1;
    const personHead = connected(pc, Ho.inOval, n, n);
    // Kişi maskesi yalnız kaş hizasının üstünde: altında kullanıcının boynu da
    // kişi (kafa şablondan yukarıda çizilince şablon çenesi boyna düşer).
    const browO = Math.min(...po.slice(17, 27).map((p) => p.y));
    // Kullanıcının kendi saç rengi: beklenen kafanın içindeki dolu saç.
    const hc = [[], [], []];
    for (let i = 0; i < n * n; i++) {
      if (!Ex[i] || !Ho.head[i] || Ho.inOval[i] || Po[CLASSES.hair][i] < USER_HAIR_MIN) continue;
      for (let c = 0; c < 3; c++) hc[c].push(oF[i * 3 + c]);
    }
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const U = hc[0].length >= Math.max(20, 0.002 * fwk * fwk) ? hc.map(med) : null;
    keep = new Uint8Array(n * n);
    const exDist = distanceTo(Ex, n, n);
    for (let i = 0; i < n * n; i++) {
      if (!Th[i] || Ex[i] || userSkin[i]) continue;
      const j = i * 3;
      const hairCls = Po[CLASSES.hair][i] >= OUT_HAIR_MIN;
      const mix = bg.ok[i] && ghostAlpha([oF[j], oF[j + 1], oF[j + 2]], [tF[j], tF[j + 1], tF[j + 2]], [bg.v[j], bg.v[j + 1], bg.v[j + 2]]) != null;
      const headLike = hairCls || Po[CLASSES.faceSkin][i] >= OUT_SKIN_MIN || Po[CLASSES.others][i] >= OUT_HAT_MIN ||
        (personHead[i] && Math.floor(i / n) < browO);
      if (!headLike && !mix) continue;
      // KULLANICININ SAÇI selfie çizgisini biraz aşmış olabilir (c8: saç kenarı
      // kesilip basamak kaldı): çizgiye yakın bantta, rengi kendi saçına yakın,
      // karışım olmayan saç pikseli korunur (uzağa uzanan iz korunmaz — c9
      // perçemi). Bu kural yalnız korur, silme kararı vermez.
      if (U && hairCls && !mix && exDist[i] <= USER_HAIR_REACH_FACE * fwk &&
          Math.hypot(oF[j] - U[0], oF[j + 1] - U[1], oF[j + 2] - U[2]) <= USER_HAIR_SAME) { keep[i] = 1; continue; }
      cand[i] = 1;
    }
    core = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if ((Ex[i] && Ho.head[i]) || keep[i] || userSkin[i]) core[i] = 1;
  } else {
    // Selfie yok: yalnız kafa dışındaki karışım, kenarda kullanıcı rengi testiyle.
    const headW = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) if (Ho.head[i]) headW[i] = 1;
    const userCol = maskedMean(oC, headW, n, n, [Math.max(2, Math.round(0.05 * fwk)), Math.max(3, Math.round(0.12 * fwk))], 0.05);
    const headDist = distanceTo(Ho.head, n, n);
    for (let i = 0; i < n * n; i++) {
      if (!Th[i] || Ho.inOval[i] || !bg.ok[i]) continue;
      const j = i * 3;
      const u = headDist[i] <= EDGE_FACE * fwk && userCol.ok[i] ? [userCol.v[j], userCol.v[j + 1], userCol.v[j + 2]] : null;
      if (ghostAlpha([oF[j], oF[j + 1], oF[j + 2]], [tF[j], tF[j + 1], tF[j + 2]], [bg.v[j], bg.v[j + 1], bg.v[j + 2]], u) != null) cand[i] = 1;
    }
    core = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (Ho.inOval[i] || (Ho.head[i] && !cand[i]) || userSkin[i]) core[i] = 1;
    const band = dilate(core, n, n, PROTECT_FACE * fwk, distanceTo);
    for (let i = 0; i < n * n; i++) if (band[i]) cand[i] = 0;
  }
  const G = dropSmall(cand, n, n, Math.max(4, MIN_AREA_FACE2 * fwk * fwk));
  let gPx = 0;
  for (let i = 0; i < n * n; i++) if (G[i]) gPx++;
  const f0 = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
  const mode = !Ex ? "karışım" : pick.deg != null
    ? `selfie(3B ${f0(prof.pose3d.yaw)}/${f0(prof.pose3d.pitch)}→${f0(pose3dO.yaw)}/${f0(pose3dO.pitch)}° Δ=${pick.deg.toFixed(0)}° pay=${pick.margin.toFixed(2)})`
    : `selfie(yaw ${prof.yaw.toFixed(2)}→${yawO.toFixed(2)} pay=${pick.margin.toFixed(2)})`;
  const stats = { ghostPx: Math.round(gPx / (k * k)), ghostFace2: gPx / (fwk * fwk), mode };
  // NEREDEN SİLİNDİ (2026-11-01, 831a00a4 c3 "kafa basık", c7 "kafa küçük"):
  // ham kare saklanmadığı için izin kafanın saçı mı, şablon izi mi olduğu
  // ayrılamadı. Göz çizgisinin üstü ve kullanıcının kafasına bitişik pay
  // (ikisi birden yüksekse kesilen büyük olasılıkla kullanıcının saçı).
  if (gPx && core) {
    const eyeY = (po[36].y + po[45].y) / 2;
    const dCore = distanceTo(core, n, n);
    let up = 0, att = 0;
    for (let i = 0; i < n * n; i++) {
      if (!G[i]) continue;
      if (Math.floor(i / n) < eyeY) up++;
      if (dCore[i] <= Math.max(2, 0.03 * fwk)) att++;
    }
    stats.ghostUp = up / gPx;
    stats.ghostAttached = att / gPx;
  }
  if (debug) {
    const Bdbg = Buffer.alloc(n * n * 3);
    for (let i = 0; i < n * n * 3; i++) Bdbg[i] = bg.ok[(i / 3) | 0] ? Math.round(bg.v[i]) : 0;
    Object.assign(debug, { n, side, left, top, oC, tC, B: Bdbg, Th, Ho: Ho.head, HoD, Ex, cand, G, Po, CLASSES, userSkin });
  }
  if (!gPx) return { buf: null, applied: false, reason: "clean", ...stats, ms: Date.now() - t0 };

  // Dolgu: iz ∪ kullanıcının kafası TEK delik (kafa bağlam olarak verilmez —
  // verilince LaMa saçı deliğe uzatıyordu; kaba zemin plakasıyla gizlemek de
  // c0'da plakanın kahve lekesini izin yerine taşıdı). İzin dış kenarı gerçek
  // zemine bakar; sonuçtan yalnız iz alınır, kafa olduğu gibi kalır.
  const Gd = dilate(G, n, n, GROW_FACE * fwk, distanceTo);
  for (let i = 0; i < n * n; i++) if (core[i]) Gd[i] = 0;
  const chinMax = Math.max(po[8].y, pt[8].y);
  const hole = new Uint8Array(n * n);
  let hx0 = n, hx1 = -1, hy0 = n, hy1 = -1;
  for (let i = 0; i < n * n; i++) {
    // Aranan bölgenin tamamı da delikte: dışarıda kalan soluk teller bağlam
    // olunca LaMa onları izin yerine yeniden çiziyordu (c0).
    const searched = Ex ? Th[i] && !Ex[i] : 0;
    if (!((Gd[i] || HoD[i] || searched) && Math.floor(i / n) <= chinMax + 0.1 * fwk)) continue;
    hole[i] = 1;
    const x = i % n, y = (i - x) / n;
    if (x < hx0) hx0 = x;
    if (x > hx1) hx1 = x;
    if (y < hy0) hy0 = y;
    if (y > hy1) hy1 = y;
  }
  // Delik tek LaMa parçasına sığsın (parçalanınca büyük delikte pus): gerekirse küçültülür.
  const spanNative = (Math.max(hx1 - hx0, hy1 - hy0) + 1) / k;
  const f = Math.min(1, LAMA_SPAN_MAX / spanNative);
  const sideL = Math.max(16, Math.round(side * f));
  const resizeMask = async (m, from, to) => {
    const b8 = Buffer.alloc(from * from);
    for (let i = 0; i < from * from; i++) b8[i] = m[i] ? 255 : 0;
    // TEK KANAL TUZAĞI (hafıza sharp-mask-channel-trap): extractChannel(0) şart.
    return sharp(b8, { raw: { width: from, height: from, channels: 1 } }).resize(to, to, { kernel: "linear" }).extractChannel(0).raw().toBuffer();
  };
  const crop = await cropSquare(o.data, W, H, left, top, side, side);
  const cropL = sideL === side ? Buffer.from(crop) : await sharp(crop, { raw: { width: side, height: side, channels: 3 } }).resize(sideL, sideL, { kernel: "lanczos3" }).raw().toBuffer();
  const holeL8 = await resizeMask(hole, n, sideL);
  const holeL = new Uint8Array(sideL * sideL);
  for (let i = 0; i < holeL.length; i++) holeL[i] = holeL8[i] > 32 ? 1 : 0;
  const filledL = (await fillCrop(cropL, sideL, holeL)).rgb;
  const filled = sideL === side ? Buffer.from(filledL) : await sharp(Buffer.from(filledL), { raw: { width: sideL, height: sideL, channels: 3 } }).resize(side, side, { kernel: "lanczos3" }).raw().toBuffer();
  const fine = { rgb: filled };
  if (debug) Object.assign(debug, { filled, holeL, sideL, Gd, keep });
  // Bileşim maskesi: iz ∪ izin yakınında (aranan bölgede) temiz zeminden belirgin
  // farklı kalan kırıntılar (c0'da tavanda koyu benekler) — korunan kafa/saç hariç.
  const near = Ex ? dilate(G, n, n, CRUMB_REACH_FACE * fwk, distanceTo) : null;
  const crumbZone = new Uint8Array(n * n);
  if (Ex) for (let i = 0; i < n * n; i++) if (near[i] && Th[i] && !Ex[i] && !core[i]) crumbZone[i] = 1;
  const [GdU, zoneU] = await Promise.all([resizeMask(Gd, n, side), resizeMask(crumbZone, n, side)]);
  const comp = Buffer.alloc(side * side);
  let crumbPx = 0;
  for (let i = 0; i < side * side; i++) {
    if (GdU[i] > 64) { comp[i] = 255; continue; }
    if (zoneU[i] <= 128) continue;
    const d = Math.max(Math.abs(crop[i * 3] - filled[i * 3]), Math.abs(crop[i * 3 + 1] - filled[i * 3 + 1]), Math.abs(crop[i * 3 + 2] - filled[i * 3 + 2]));
    if (d > CRUMB_DIFF) { comp[i] = 255; crumbPx++; }
  }
  stats.crumbPx = crumbPx;
  const feather = Math.max(1, Math.round(FEATHER_FACE * fw));
  const wgt = await sharp(comp, { raw: { width: side, height: side, channels: 1 } })
    .blur(Math.max(0.3, feather / 2)).extractChannel(0).raw().toBuffer();
  const res = Buffer.from(o.data);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      const w = wgt[i] / 255;
      if (w <= 0) continue;
      const g = ((y + top) * W + x + left) * 3;
      for (let c = 0; c < 3; c++) res[g + c] = Math.round(res[g + c] + w * (fine.rgb[i * 3 + c] - res[g + c]));
    }
  }
  const buf = await sharp(res, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, ...stats, ms: Date.now() - t0 };
}

module.exports = {
  cleanTemplateGhost, headProfileOf,
  _testables: { ghostAlpha, mixFit, maskedMean, mapMask, signedYaw, eyeChin, connected, dropSmall, pickProfile, ALPHA_LO, ALPHA_HI, CONTRAST_MIN, EXP_MARGIN_FACE, EXP_MARGIN_PER_DEG, EXP_MARGIN_DEAD_DEG, EXP_MARGIN_MAX },
};
