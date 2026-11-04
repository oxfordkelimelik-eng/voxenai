// YÜZÜ SAHNENİN IŞIĞINA OTURTMA (2026-10-30, kullanıcı: "ışıklandırma yok, ten
// uyumu yok, kafa yapıştırılmış gibi duruyor, yüz teni doğal durmuyor").
//
// ÖLÇÜM (922f1371, 10 kare, yüz derisi segmentasyonu, Lab):
//  - Model yüzü sahneye göre fazla parlak çiziyor: çıktı yüzü şablon yüzünden
//    c2 +15.0, c6 +14.3, c4 +7.6, c0 +6.0, c5 +5.4 L daha açık; kullanıcının
//    teni şablon kişilerinden açık değil.
//  - Yüz aynı karedeki boyun/elden 6-12 L parlak; şablonlarda yüz vücuttan
//    ~3 L koyu. "Yapıştırılmış kafa" görüntüsünün ölçülebilir karşılığı bu.
//  - Yüz şablona göre daha sarı (b* +5…+9).
//
// ESKİ KATMANLAR TERS YÖNDEYDİ: faceRelight'ın ton adımı ve skinTone'un
// planFaceMatch'i ("yüzü KARARTMAZ — yalnız açar") yüzü açıyordu; yerel
// tekrarda c3/c6/c7/c8 solgunlaştı. İkisi sade akışta kapalı kalır.
//
// YÖNTEM: yüzün parlaklığı şablondaki yüzün parlaklığına, iki kişinin ten
// pigmenti farkı kadar (Monk ten skalası, skinPigment.js) getirilir. Kazanç
// DOĞRUSAL ışıkta tek çarpan: gölge, doku ve detay olduğu gibi kalır (boyama
// yok). Saç dahil tüm kafaya ve boyna uygulanır (aynı ışık); renk kayması
// yalnız deriye, yarı güçte (kişinin kendi ten rengi korunur, sahne ışığının
// rengi gelir).
//
// 2026-10-30 (c2e8eff1): hedef karedeki vücut tenine göre (bkz. bodySkinY);
// ışık eğimi tüm açık tene, kıyafete dokunulmaz.
const sharp = require("sharp");

// Ölçülen farkın uygulanan payı (log alanda). 1.0 DENENDİ, ALINMADI
// (2026-11-01, c2e8eff1'in 10 ham karesi): yüz vücuda göre base'den koyu
// kaldı (|yüz/vücut − base| ortanca 0.22 → 0.30 stop).
const GAIN_BETA = 0.85;
// ×0.55 karanlık sahnede yetmiyordu (c2e8eff1 c1: yüz L 31 → hedef 18, kazanç
// sınırda kaldı, yüz göğüsten açık kaldı).
const GAIN_MIN = Math.log(0.4);
const GAIN_MAX = Math.log(1.2);
// Bundan küçük fark dokunulmaz (|log| ≈ %4).
const GAIN_DEADBAND = 0.04;
// Renk (a*, b*) farkının uygulanan payı ve üst sınırı.
const CHROMA_BETA = 0.5;
const CHROMA_MAX = 6;
const CHROMA_DEADBAND = 1.5;
// Işık eğimi aktarımı (log parlaklık / yüz genişliği).
const SLOPE_BETA_U = 0.7;
const SLOPE_BETA_V = 0.4;
const SLOPE_MAX_U = 0.9;
const SLOPE_MAX_V = 0.4;
const SLOPE_DEADBAND = 0.08;
// Eğim kafanın bu yarıçapı dışında büyümez (yüz kutusu birimi).
const SLOPE_UV_MAX = 0.75;
const WORK_MAX = 640;

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const linToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** Kırpılmış ortalama (q0-q1 yüzdelikleri arası). SAF. */
function trimmedMean(arr, q0 = 0.15, q1 = 0.85) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  const a = Math.floor(q0 * s.length), b = Math.max(a + 1, Math.ceil(q1 * s.length));
  let t = 0;
  for (let i = a; i < b; i++) t += s[i];
  return t / (b - a);
}

/**
 * Kazanç ve renk planı. tpl/out: { Y (doğrusal), a, b } yüz derisi ölçüleri;
 * albedo: kullanıcı/şablon ten pigmenti oranı (doğrusal). SAF.
 */
function planTone(tpl, out, albedo = 1) {
  if (!tpl || !out || !(tpl.Y > 0) || !(out.Y > 0)) return { ok: false, reason: "no-measure" };
  const raw = Math.log(tpl.Y) - Math.log(out.Y) + Math.log(albedo || 1);
  let logGain = clamp(GAIN_BETA * raw, GAIN_MIN, GAIN_MAX);
  if (Math.abs(logGain) < GAIN_DEADBAND) logGain = 0;
  let da = clamp(CHROMA_BETA * (tpl.a - out.a), -CHROMA_MAX, CHROMA_MAX);
  let db = clamp(CHROMA_BETA * (tpl.b - out.b), -CHROMA_MAX, CHROMA_MAX);
  if (Math.hypot(da, db) < CHROMA_DEADBAND) { da = 0; db = 0; }
  // IŞIK YÖNÜ: şablon yüzündeki parlaklık eğimi (sol-sağ, üst-alt) çıktı
  // yüzüne; yatayda tam, dikeyde yarım (alın/yanak teni farkı da dikey eğim
  // verir). Ortalama değişmez (düzlem yüz merkezinde sıfır).
  let gu = 0, gv = 0;
  if (tpl.slope && out.slope) {
    gu = clamp(SLOPE_BETA_U * (tpl.slope.gu - out.slope.gu), -SLOPE_MAX_U, SLOPE_MAX_U);
    gv = clamp(SLOPE_BETA_V * (tpl.slope.gv - out.slope.gv), -SLOPE_MAX_V, SLOPE_MAX_V);
    if (Math.abs(gu) < SLOPE_DEADBAND) gu = 0;
    if (Math.abs(gv) < SLOPE_DEADBAND) gv = 0;
  }
  return { ok: true, logGain, da, db, gu, gv, raw };
}

/** Kişinin yüz çevresinde sınıf olasılıkları (çalışma çözünürlüğü). */
async function probsOf(buf, FW, FH) {
  const { detectMainFace } = require("./faceQuality");
  const { classProbs, CLASSES } = require("./skinSeg");
  const { personCropProbs } = require("./skinTone");
  const face = (await detectMainFace(buf)) || (await detectMainFace(buf, 0.1));
  if (!face) return null;
  const sc = Math.min(1, WORK_MAX / Math.max(FW, FH));
  const W = Math.max(1, Math.round(FW * sc)), H = Math.max(1, Math.round(FH * sc));
  const work = await sharp(buf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const box = { x: face.box.x * sc, y: face.box.y * sc, width: face.box.width * sc, height: face.box.height * sc };
  const P = await personCropProbs(work, W, H, box, classProbs, CLASSES);
  return { P, CLASSES, W, H, sc, box, work };
}

/**
 * Yüz derisi ölçüsü: kırpılmış doğrusal parlaklık + Lab a*, b*, ve IŞIK
 * EĞİMİ: alın-yanak derisinde (ağız hizasının üstü — sakal karışmasın)
 * log parlaklığa yüz kutusu koordinatında düzlem (c0 + gu·u + gv·v).
 */
function skinStats(S) {
  const { rgbToLab } = require("./skinTone");
  const { P, CLASSES, W, H, work, box } = S;
  const Ys = [], As = [], Bs = [];
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const mouthY = box.y + box.height * 0.72;
  // Normal denklemler (u, v, 1).
  let s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, t1 = 0, t2 = 0, t3 = 0;
  for (let i = 0; i < W * H; i++) {
    if (P[CLASSES.faceSkin][i] <= 0.6 || P[CLASSES.hair][i] >= 0.25 || P[CLASSES.others][i] >= 0.3) continue;
    const r = work[i * 3], g = work[i * 3 + 1], b = work[i * 3 + 2];
    const Y = 0.2126 * SRGB2LIN[r] + 0.7152 * SRGB2LIN[g] + 0.0722 * SRGB2LIN[b];
    Ys.push(Y);
    const [, A, B] = rgbToLab(r, g, b);
    As.push(A); Bs.push(B);
    const x = i % W, y = (i - x) / W;
    if (y > mouthY || Y <= 0) continue;
    const u = (x - cx) / box.width, v = (y - cy) / box.height, z = Math.log(Y);
    s11 += u * u; s12 += u * v; s13 += u; s22 += v * v; s23 += v; s33 += 1;
    t1 += u * z; t2 += v * z; t3 += z;
  }
  if (Ys.length < 60) return null;
  let slope = null;
  if (s33 >= 60) {
    // 3×3 çözüm (Cramer).
    const det = s11 * (s22 * s33 - s23 * s23) - s12 * (s12 * s33 - s23 * s13) + s13 * (s12 * s23 - s22 * s13);
    if (Math.abs(det) > 1e-9) {
      const gu = (t1 * (s22 * s33 - s23 * s23) - s12 * (t2 * s33 - s23 * t3) + s13 * (t2 * s23 - s22 * t3)) / det;
      const gv = (s11 * (t2 * s33 - s23 * t3) - t1 * (s12 * s33 - s23 * s13) + s13 * (s12 * t3 - t2 * s13)) / det;
      slope = { gu, gv };
    }
  }
  return { Y: trimmedMean(Ys), a: trimmedMean(As), b: trimmedMean(Bs), n: Ys.length, slope };
}

// YÜZ VÜCUT TENİYLE AYNI (2026-10-30, c2e8eff1, kullanıcı: "yüz açık, altı koyu;
// yüz rengi vücut teni ile tamamen aynı olmalı"). Ham çıktıda göğüs/kol/el
// derisi şablonla neredeyse aynı (c1 L 49.3/51.4, c4 32.3/33.0, c7 35.0/34.3)
// ama yüz 10-18 L parlak. Hedef artık "şablonun yüzü × bu karede vücudun
// şablona oranı": çıktıdaki yüz-vücut ilişkisi şablondakiyle aynı olur
// (c9'da model vücudu da açmış: 40.5/29.6 → yüz de o kadar açık kalır).
const BODY_BELOW_CHIN = 0.6; // boyundan aşağısı (boyun yüzle aynı çiziliyor)
const BODY_MIN_PX = 150;
const BODY_RATIO_MIN = 0.5, BODY_RATIO_MAX = 2;

/**
 * Çenenin altındaki vücut derisinin (göğüs, kol, el) çıktı/şablon parlaklık
 * oranı. İki karede de deri olan ORTAK pikseller (gövde aynı kadrajda, kayıt
 * 0-1 px); ayrı kümeler şablonun elini çıktının göğsüyle karşılaştırıyordu.
 */
function bodyRatioOf(So, St) {
  if (So.W !== St.W || So.H !== St.H) return null;
  const { CLASSES, W, H, box } = So;
  const y0 = box.y + box.height * (1.05 + BODY_BELOW_CHIN);
  const Yo = [], Yt = [];
  const lum = (w, i) => 0.2126 * SRGB2LIN[w[i * 3]] + 0.7152 * SRGB2LIN[w[i * 3 + 1]] + 0.0722 * SRGB2LIN[w[i * 3 + 2]];
  for (let y = Math.max(0, Math.ceil(y0)); y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (So.P[CLASSES.bodySkin][i] <= 0.7 || St.P[CLASSES.bodySkin][i] <= 0.7) continue;
    if (So.P[CLASSES.clothes][i] >= 0.3 || St.P[CLASSES.clothes][i] >= 0.3) continue;
    Yo.push(lum(So.work, i)); Yt.push(lum(St.work, i));
  }
  if (Yo.length < BODY_MIN_PX) return null;
  const o = trimmedMean(Yo), t = trimmedMean(Yt);
  return o > 0 && t > 0 ? { ratio: o / t, n: Yo.length } : null;
}

/**
 * Boyun–yüz parlaklık farkı (L*, boyun − yüz). Boyun = çenenin altında yarım
 * yüz boyu, yüz genişliğinde şeritteki vücut derisi; yüz = kutudaki yüz
 * derisi. Kazanç boyunda sönümlendiği için (bkz. headAlpha) yüz açılıp boyun
 * yerinde kalırsa fark büyür — "yapıştırılmış kafa" görüntüsünün ölçüsü.
 * Yalnız ÖLÇÜM (2026-11-04): karar vermez, önce/sonra loglanır. rgbAt(i)
 * çalışma çözünürlüğü indeksinden [r,g,b] döndürür. SAF.
 */
function neckFaceDelta(S, rgbAt) {
  const { P, CLASSES, W, H, box } = S;
  const chin = box.y + box.height * 1.05;
  const nx0 = box.x - 0.15 * box.width, nx1 = box.x + 1.15 * box.width, ny1 = chin + 0.5 * box.height;
  const Lf = [], Ln = [];
  const lum = (c) => {
    const Y = 0.2126 * SRGB2LIN[c[0]] + 0.7152 * SRGB2LIN[c[1]] + 0.0722 * SRGB2LIN[c[2]];
    return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  };
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(H, Math.ceil(ny1)); y++) {
    for (let x = Math.max(0, Math.floor(nx0)); x < Math.min(W, Math.ceil(nx1)); x++) {
      const i = y * W + x;
      if (P[CLASSES.clothes][i] >= 0.3) continue;
      if (y <= chin) { if (P[CLASSES.faceSkin][i] > 0.7) Lf.push(lum(rgbAt(i))); }
      else if (P[CLASSES.bodySkin][i] > 0.7) Ln.push(lum(rgbAt(i)));
    }
  }
  if (Lf.length < 50 || Ln.length < 50) return null;
  const face = trimmedMean(Lf), neck = trimmedMean(Ln);
  return { face, neck, delta: neck - face, nNeck: Ln.length };
}

/** Şablon yüz hedefini karedeki vücudun şablona oranıyla düzeltir. SAF. */
function bodyAdjustedTarget(tpl, body) {
  if (!tpl || !body || !(body.ratio > 0)) return { tpl, bodyRatio: null };
  const bodyRatio = clamp(body.ratio, BODY_RATIO_MIN, BODY_RATIO_MAX);
  return { tpl: { ...tpl, Y: tpl.Y * bodyRatio }, bodyRatio };
}

/**
 * Kafa (saç + yüz + kulak + gözlük) ve boyun derisi için yumuşak alfa; deri
 * alfası ayrıca (renk kayması yalnız deriye).
 */
function headAlpha(S, ref = null, pm = null) {
  const { rgbToLab } = require("./skinTone");
  const { P, CLASSES, W, H, box, work } = S;
  const head = new Float32Array(W * H), skin = new Float32Array(W * H), body = new Float32Array(W * H);
  const chin = box.y + box.height * 1.05;
  const hx0 = box.x - 1.2 * box.width, hx1 = box.x + 2.2 * box.width, hy0 = box.y - 1.5 * box.height;
  // Boyun: çenenin altında yüz genişliği kadar şerit. Model boynu yüzle aynı
  // ışıkta çiziyor: ilk yarım yüz boyu tam, sonra yarım yüz boyunda sönümlenir
  // (kısa sönüm 922f1371 c8'de çene altında bir geçiş bıraktı).
  const nx0 = box.x - 0.15 * box.width, nx1 = box.x + 1.15 * box.width;
  const nFull = chin + 0.5 * box.height, ny1 = chin + 1.0 * box.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inHead = x >= hx0 && x <= hx1 && y >= hy0 && y <= chin;
      const inNeck = x >= nx0 && x <= nx1 && y > chin - 0.1 * box.height && y <= ny1;
      const face = P[CLASSES.faceSkin][i], hair = P[CLASSES.hair][i], body = P[CLASSES.bodySkin][i];
      const oth = P[CLASSES.others][i];
      // Kıyafet (yaka) kafa kutusuna girse de dokunulmaz (c2e8eff1 c1: gömlek
      // yakasında çene hizasında dikdörtgen koyu bant).
      const notCloth = 1 - clamp((P[CLASSES.clothes][i] - 0.4) / 0.3, 0, 1);
      let h = 0, s = 0;
      if (inHead) { h = Math.max(face, hair, oth * (y < chin ? 1 : 0)) * notCloth; s = face; }
      // Işık eğimi tüm açık tene (boyun, göğüs, kol, el): yalnız yüze yapılan
      // gölgelendirme boyunda kesiliyordu.
      if (y > chin - 0.1 * box.height) body[i] = clamp((Math.max(body_(P, CLASSES, i), face) - 0.5) / 0.25, 0, 1) * notCloth;
      if (inNeck) {
        // Boyun derisi yalnız kesin olduğunda (922f1371 c4: koyu yaka kısmen
        // "vücut derisi" çıktı).
        const f = 1 - clamp((y - nFull) / (ny1 - nFull), 0, 1);
        let bs = clamp((body - 0.5) / 0.25, 0, 1);
        // Segmentasyonun kaçırdığı boyun (c4: yakaların arası açık kaldı):
        // yüzün kendi ten rengine yakın, ten parlaklığında, kumaş olmayan piksel.
        // Yalnız kişi maskesinde (2026-10-31, 21e c6): gün batımı gökyüzü ten
        // rengine yakın; boyun sayılıp ×0.56 koyulaştı, boyun yanında koyu
        // basamaklı leke kaldı.
        if (ref && bs < 1) {
          const [Lv, av, bv] = rgbToLab(work[i * 3], work[i * 3 + 1], work[i * 3 + 2]);
          const sim = (1 - smoothstep((Math.hypot(av - ref.a, bv - ref.b) - 6) / 8)) *
            (1 - smoothstep((Math.abs(Lv - ref.L) - 18) / 12)) * clamp((Lv - 18) / 10, 0, 1) *
            (1 - clamp((P[CLASSES.clothes][i] - 0.5) / 0.3, 0, 1)) * (1 - clamp(hair, 0, 1)) *
            (pm ? clamp((pm[i] - 0.3) / 0.4, 0, 1) : 1);
          bs = Math.max(bs, 0.9 * sim);
        }
        h = Math.max(h, bs * f, face);
        s = Math.max(s, bs * f);
      }
      // KENAR SIKI (922f1371 c5): yumuşak olasılık kenarı gökyüzüne taşıyor,
      // ×0.56 koyulaştırmada saçın çevresinde koyu hale kalıyordu. Belirsiz
      // pikseller (olasılık <~0.45) dokunulmaz.
      head[i] = clamp((h - 0.4) / 0.3, 0, 1);
      skin[i] = clamp((s - 0.4) / 0.3, 0, 1);
      body[i] = Math.max(body[i], head[i]);
    }
  }
  return { head, skin, body };
}

const body_ = (P, CLASSES, i) => P[CLASSES.bodySkin][i];

/** 3×3 kutu bulanıklığı r kez (yumuşak kenar). SAF. */
function soften(src, W, H, passes = 2) {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let t = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        t += a[yy * W + xx]; n++;
      }
      b[y * W + x] = t / n;
    }
    a = b;
  }
  return a;
}

/** Ayrılabilir kutu bulanıklığı, yarıçap r, k geçiş. SAF. */
function boxBlur(src, W, H, r, k = 2) {
  let a = src;
  for (let p = 0; p < k; p++) {
    const t = new Float32Array(W * H), b = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < W; x++) {
        if (x + r < W) { acc += a[y * W + x + r]; n++; }
        if (x - r - 1 >= 0) { acc -= a[y * W + x - r - 1]; n--; }
        if (x >= 0) t[y * W + x] = acc / n;
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < H; y++) {
        if (y + r < H) { acc += t[(y + r) * W + x]; n++; }
        if (y - r - 1 >= 0) { acc -= t[(y - r - 1) * W + x]; n--; }
        if (y >= 0) b[y * W + x] = acc / n;
      }
    }
    a = b;
  }
  return a;
}

/**
 * KESİNTİSİZ ALAN (2026-10-30, c2e8eff1 c1, kullanıcı: "boynun altında ışık
 * kesilmiş"): sınıf eşikli alfa, kararsız pikselleri (boyun yanı, kulak
 * kenarı, çene altı) dokunmadan bırakıyordu; çevresi ×0.45 koyulaşınca bunlar
 * parlak kama/leke olarak kaldı. Değer yalnız kesin piksellerde verilir
 * (seedW=1), kararsızlar komşularından normalize evrişimle dolar; sonuç kişi
 * maskesiyle sınırlanır (arka plana hale gitmez), kıyafette sıfır. SAF.
 */
function propagate(seedG, seedW, W, H, r) {
  const gw = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gw[i] = seedG[i] * seedW[i];
  const A = boxBlur(gw, W, H, r), B = boxBlur(seedW, W, H, r);
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = B[i] > 1e-3 ? A[i] / B[i] : 0;
  return out;
}

// KENAR KARIŞIMI (2026-10-31, 21e56b20 c6, kullanıcı: "kafada silüet tarzı bir
// şey var"): kazanç alfası (yumuşatma + büyütme) kafanın 0-8 px dışına
// taşıyor; ×0.45-0.56 koyulaştırmada gökyüzü orada 5-7 L koyulaştı (c2e8eff1
// c4 ham → son 59→53, 67→62 L) = kafanın çevresinde koyu çerçeve. Sert eşik
// (922f1371 c5) yetmedi. Kenar pikseli kafa rengi F ile zemin rengi B'nin
// karışımı sayılır (I = αF + (1−α)B, doğrusal RGB); kazanç yalnız kafa payına
// uygulanır: I' = k·I + (1−k)(1−α)·B. Zemin pikseli (α≈0) değişmez, saç ucu
// payı kadar koyulaşır. F/B yerel ortalama (normalize evrişim); karşıtlık
// azsa (koyu saç koyu zeminde) eski alfa kalır.
const MATTE_RADIUS = 0.06; // yüz kutusu boyunun payı (çalışma çözünürlüğü)
const MATTE_COVER = 0.08;
const MATTE_MIN_C2 = 0.004; // |F − B|² (doğrusal RGB) alt sınırı

/**
 * Kenar karışımı için yerel kafa (F) ve zemin (B) rengi, doğrusal RGB, ve
 * geçerlilik ağırlığı (çalışma çözünürlüğü). lin: Float32Array(3N). SAF.
 */
function edgeMatteFields(lin, fgW, bgW, W, H, r) {
  const N = W * H;
  const fDen = boxBlur(fgW, W, H, r), bDen = boxBlur(bgW, W, H, r);
  const F = new Float32Array(N * 3), B = new Float32Array(N * 3), ok = new Float32Array(N);
  for (let c = 0; c < 3; c++) {
    const a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) { a[i] = lin[i * 3 + c] * fgW[i]; b[i] = lin[i * 3 + c] * bgW[i]; }
    const fa = boxBlur(a, W, H, r), fb = boxBlur(b, W, H, r);
    for (let i = 0; i < N; i++) {
      F[i * 3 + c] = fDen[i] > 1e-4 ? fa[i] / fDen[i] : 0;
      B[i * 3 + c] = bDen[i] > 1e-4 ? fb[i] / bDen[i] : 0;
    }
  }
  for (let i = 0; i < N; i++) ok[i] = fDen[i] >= MATTE_COVER && bDen[i] >= MATTE_COVER ? 1 : 0;
  return { F, B, ok };
}

/** Kenar pikselinin kafa payı α (I = αF + (1−α)B, doğrusal). Karşıtlık azsa null. SAF. */
function matteAlpha(I, F, B) {
  const d0 = F[0] - B[0], d1 = F[1] - B[1], d2 = F[2] - B[2];
  const c2 = d0 * d0 + d1 * d1 + d2 * d2;
  if (c2 < MATTE_MIN_C2) return null;
  return clamp(((I[0] - B[0]) * d0 + (I[1] - B[1]) * d1 + (I[2] - B[2]) * d2) / c2, 0, 1);
}

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
 * Çıktının yüzünü şablonun sahne ışığına oturtur. Kareler aynı kadrajda
 * (geri yerleştirme + hizalama sonrası). mstUser/mstTpl: Monk ten skalası
 * (1-10); yoksa pigment farkı 1 sayılır. Döner { buf, applied, reason, ... }.
 */
async function matchFaceToScene(outputBuf, templateBuf, { mstUser = null, mstTpl = null } = {}) {
  const t0 = Date.now();
  const { albedoRatio } = require("./faceRelight");
  const { rgbToLab, labToRgb } = require("./skinTone");
  const { data: rgb, info } = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FW = info.width, FH = info.height;
  const tplFit = await sharp(templateBuf).rotate().removeAlpha().resize(FW, FH, { fit: "fill" }).png().toBuffer();
  const [So, St] = await Promise.all([probsOf(outputBuf, FW, FH), probsOf(tplFit, FW, FH)]);
  if (!So) return { buf: null, applied: false, reason: "no-face-output" };
  if (!St) return { buf: null, applied: false, reason: "no-face-template" };
  const out = skinStats(So), tpl = skinStats(St);
  if (!out || !tpl) return { buf: null, applied: false, reason: "no-skin" };
  const albedo = albedoRatio(mstUser, mstTpl);
  const adj = bodyAdjustedTarget(tpl, bodyRatioOf(So, St));
  const plan = planTone(adj.tpl, out, albedo);
  const L = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
  const sl = (q) => (q.slope ? `${q.slope.gu.toFixed(2)}/${q.slope.gv.toFixed(2)}` : "null");
  const neckBefore = neckFaceDelta(So, (i) => [So.work[i * 3], So.work[i * 3 + 1], So.work[i * 3 + 2]]);
  const neckTpl = neckFaceDelta(St, (i) => [St.work[i * 3], St.work[i * 3 + 1], St.work[i * 3 + 2]]);
  const info2 = { outL: L(out.Y), tplL: L(tpl.Y), targetL: L(adj.tpl.Y), bodyRatio: adj.bodyRatio, outAB: [out.a, out.b], tplAB: [tpl.a, tpl.b], albedo, tplSlope: sl(tpl), outSlope: sl(out), neckDeltaBefore: neckBefore ? neckBefore.delta : null, neckDeltaTpl: neckTpl ? neckTpl.delta : null, neckDeltaAfter: null, ...plan };
  if (!plan.ok) return { buf: null, applied: false, reason: plan.reason, ...info2 };
  if (!plan.logGain && !plan.da && !plan.db && !plan.gu && !plan.gv) return { buf: null, applied: false, reason: "already-matched", ...info2 };
  // Kesin pikseller tohum: kafa/boyun (değer = alfa), vücut derisi (eğim için
  // 1, kazanç için boyun sönümü), kıyafet 0. Gerisi komşudan dolar.
  const { W: w0, H: h0, P, CLASSES } = So;
  const pm = await require("./headScale").personMask(So.work, w0, h0);
  const A = headAlpha(So, { L: L(out.Y), a: out.a, b: out.b }, pm);
  const chinW = So.box.y + So.box.height * 1.05;
  const nFull = chinW + 0.5 * So.box.height, ny1 = chinW + 1.0 * So.box.height;
  const gS = new Float32Array(w0 * h0), bS = new Float32Array(w0 * h0), sW = new Float32Array(w0 * h0), keep = new Float32Array(w0 * h0);
  for (let i = 0; i < w0 * h0; i++) {
    const y = Math.floor(i / w0);
    const cl = P[CLASSES.clothes][i], bodySk = P[CLASSES.bodySkin][i];
    const notCloth = 1 - clamp((cl - 0.4) / 0.3, 0, 1);
    keep[i] = clamp((pm[i] - 0.3) / 0.4, 0, 1) * notCloth;
    if (cl > 0.6) { sW[i] = 1; continue; }
    if (A.head[i] >= 0.5) { gS[i] = A.head[i]; bS[i] = 1; sW[i] = 1; continue; }
    if (bodySk > 0.6) { gS[i] = 1 - clamp((y - nFull) / (ny1 - nFull), 0, 1); bS[i] = 1; sW[i] = 1; continue; }
    if (pm[i] < 0.2) sW[i] = 1; // arka plan: 0
  }
  const rad = Math.max(2, Math.round(0.05 * So.box.height));
  const gP = propagate(gS, sW, w0, h0, rad), bP = propagate(bS, sW, w0, h0, rad);
  const hw = new Float32Array(w0 * h0), bw = new Float32Array(w0 * h0);
  for (let i = 0; i < w0 * h0; i++) {
    // Kesin kafa/deri pikseli kendi değerini korur; kararsız olan dolar.
    hw[i] = Math.max(A.head[i] >= 0.5 ? A.head[i] : 0, gP[i] * keep[i]);
    bw[i] = Math.max(A.body[i], bP[i] * keep[i]);
  }
  const head = upsample(soften(hw, w0, h0, 1), w0, h0, FW, FH);
  const skin = upsample(soften(A.skin, So.W, So.H, 1), So.W, So.H, FW, FH);
  const bodyA = (plan.gu || plan.gv) ? upsample(soften(bw, w0, h0, 1), w0, h0, FW, FH) : null;
  const fb = { x: So.box.x / So.sc, y: So.box.y / So.sc, w: So.box.width / So.sc, h: So.box.height / So.sc };
  const fcx = fb.x + fb.w / 2, fcy = fb.y + fb.h / 2;
  // KENAR KARIŞIMI alanları (bkz. edgeMatteFields): kesin kafa (F) ve kesin
  // zemin (B; kişi dışı, deri/saç/kıyafet değil). Yalnız kafa-zemin kenarında;
  // boyun/yaka/gövde sınırında eski alfa kalır.
  const N0 = w0 * h0;
  const lin0 = new Float32Array(N0 * 3);
  for (let i = 0; i < N0 * 3; i++) lin0[i] = SRGB2LIN[So.work[i]];
  const fgW = new Float32Array(N0), bgW = new Float32Array(N0), edgeW = new Float32Array(N0);
  for (let i = 0; i < N0; i++) {
    const cl = P[CLASSES.clothes][i], bsk = P[CLASSES.bodySkin][i];
    if (A.head[i] >= 0.95 && cl < 0.3) fgW[i] = 1;
    else if (pm[i] < 0.15 && Math.max(P[CLASSES.hair][i], P[CLASSES.faceSkin][i], bsk) < 0.2 && cl < 0.3) bgW[i] = 1;
  }
  const mf = edgeMatteFields(lin0, fgW, bgW, w0, h0, Math.max(2, Math.round(MATTE_RADIUS * So.box.height)));
  for (let i = 0; i < N0; i++) edgeW[i] = mf.ok[i] && P[CLASSES.clothes][i] < 0.5 && P[CLASSES.bodySkin][i] < 0.6 ? 1 : 0;
  const edgeS = soften(edgeW, w0, h0, 1);
  // Çalışma çözünürlüğünden çift doğrusal örnek (upsample ile aynı eşleme).
  const sx0 = w0 / FW, sy0 = h0 / FH;
  const at = (x, y) => {
    const fx = clamp((x + 0.5) * sx0 - 0.5, 0, w0 - 1), fy = clamp((y + 0.5) * sy0 - 0.5, 0, h0 - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w0 - 1, x0 + 1), y1 = Math.min(h0 - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    return [y0 * w0 + x0, y0 * w0 + x1, y1 * w0 + x0, y1 * w0 + x1, (1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  };
  const bil = (arr, q, c, s) => arr[q[0] * s + c] * q[4] + arr[q[1] * s + c] * q[5] + arr[q[2] * s + c] * q[6] + arr[q[3] * s + c] * q[7];
  let matted = 0;
  const res = Buffer.from(rgb);
  let changed = 0;
  for (let i = 0; i < FW * FH; i++) {
    const ah = head[i], ab = bodyA ? bodyA[i] : 0;
    if (ah < 0.01 && ab < 0.01) continue;
    let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const x = i % FW, y = (i - x) / FW;
    let lg = plan.logGain * ah;
    // Eğim düzlemi yüz merkezinde sıfır; vücutta aynı düzlem sürer (yatay
    // uçta sınırlı), dikey bileşen boyun altında sabit kalır.
    const slope = (plan.gu || plan.gv)
      ? plan.gu * clamp((x - fcx) / fb.w, -SLOPE_UV_MAX, SLOPE_UV_MAX) + plan.gv * clamp((y - fcy) / fb.h, -SLOPE_UV_MAX, SLOPE_UV_MAX)
      : 0;
    if (bodyA) lg += slope * Math.max(ah, ab);
    if (lg) {
      const k = Math.exp(lg);
      r = linToSrgb(SRGB2LIN[r] * k); g = linToSrgb(SRGB2LIN[g] * k); b = linToSrgb(SRGB2LIN[b] * k);
    }
    // Kafa kenarı: kazanç yalnız kafa payına (bkz. KENAR KARIŞIMI).
    if (ah < 0.98 && (plan.logGain || slope)) {
      const q = at(x, y);
      const e = bil(edgeS, q, 0, 1);
      if (e > 0.01) {
        const I = [SRGB2LIN[rgb[i * 3]], SRGB2LIN[rgb[i * 3 + 1]], SRGB2LIN[rgb[i * 3 + 2]]];
        const Fv = [bil(mf.F, q, 0, 3), bil(mf.F, q, 1, 3), bil(mf.F, q, 2, 3)];
        const Bv = [bil(mf.B, q, 0, 3), bil(mf.B, q, 1, 3), bil(mf.B, q, 2, 3)];
        const al = matteAlpha(I, Fv, Bv);
        if (al != null) {
          const kF = Math.exp(plan.logGain + slope);
          const m = (c) => linToSrgb(kF * I[c] + (1 - kF) * (1 - al) * Bv[c]);
          r = Math.round(e * m(0) + (1 - e) * r); g = Math.round(e * m(1) + (1 - e) * g); b = Math.round(e * m(2) + (1 - e) * b);
          matted++;
        }
      }
    }
    const as = skin[i] * ah;
    if ((plan.da || plan.db) && as > 0.01) {
      const [Lv, av, bv] = rgbToLab(r, g, b);
      // Renk kayması yalnız ten parlaklığında: koyu kumaşa/gölgeye gitmez
      // (922f1371 c4: b* −6 siyah yakayı laciverte çevirdi).
      const k = as * clamp((Lv - 18) / 17, 0, 1);
      if (k > 0.01) [r, g, b] = labToRgb(Lv, av + plan.da * k, bv + plan.db * k);
    }
    res[i * 3] = r; res[i * 3 + 1] = g; res[i * 3 + 2] = b;
    changed++;
  }
  // Sonrası: aynı maskeler (deri yer değiştirmedi), renk tam çözünürlükten.
  const neckAfter = neckFaceDelta(So, (i) => {
    const x = i % w0, y = (i - x) / w0;
    const X = Math.min(FW - 1, Math.floor((x + 0.5) / sx0)), Y = Math.min(FH - 1, Math.floor((y + 0.5) / sy0));
    const j = (Y * FW + X) * 3;
    return [res[j], res[j + 1], res[j + 2]];
  });
  const buf = await sharp(res, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, changed, matted, ms: Date.now() - t0, ...info2, neckDeltaAfter: neckAfter ? neckAfter.delta : null };
}

module.exports = { matchFaceToScene, _testables: { probsOf, skinStats, soften, upsample, planTone, trimmedMean, bodyAdjustedTarget, neckFaceDelta, propagate, boxBlur, edgeMatteFields, matteAlpha, GAIN_BETA, GAIN_MIN, GAIN_MAX, CHROMA_BETA, CHROMA_MAX } };
