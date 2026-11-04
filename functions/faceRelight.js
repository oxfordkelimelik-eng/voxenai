// YÜZ IŞIĞI VE TENİ — TEK ADIM (2026-10-16, kullanıcı: "yüze base'deki gibi
// doğal bir ışık yansıyacak; kol, boyun ten rengi ile yüz rengi tam uyuşacak").
//
// NEDEN: c29a2b31'de (canlıda ilk iş) üç ayrı katman yüzü düzeltemedi:
// - faceShading (9 sayılık küresel harmonik) tek geçişte farkın ~%10'unu
//   kapattı (c7 mum ışığı 0.47 → 0.43); c5/c6'da yan ışık hiç görünmedi.
// - matchFaceExposure yüzün renk açısını BAŞKA bir kişinin (base manken)
//   yüzüne döndürüyordu; c4'te yüz soluk-sarı, boyun sıcak ten kaldı.
// - Kanonik alın saça taştığı için c7'de alında keskin sınırlı düz yama.
//
// YÖNTEM: 68 nokta + kanonik alın/yanak noktalarıyla iki yüz üçgen üçgen
// eşlenir (parça parça afin). Base yüzünün düşük frekanslı log-parlaklık
// DESENİ (ortalaması çıkarılmış) çıktının deseninin yerine konur — burun
// gölgesi, alttan mum ışığı, yan ışık kendi yerine düşer. Desen yalnız iki
// yüzde de deri olan piksellerden (göz, kaş, ağız, sakal bölgesi dışarıda,
// parlama kırpılmış) normalize evrişimle öğrenilir; kişinin ayrıntısı (ben,
// gözlük camı, parlama) geçmez, ince doku çıktının kendisi kalır.
// Yüzün ORTALAMA parlaklığı ve rengi ise kişinin KENDİ boynuna bağlanır:
// base'de yüz/boyun parlaklık oranı neyse çıktıda da o; renk boynun rengine
// (base'deki yüz-boyun renk farkının yarısı eklenerek) çekilir.
//
// 2026-10-08'deki serbest harita hatası (gözlük camı alında turuncu leke)
// burada üç yolla önlenir: gözlüklü şablon atlanır, desen iki yüzün ortak
// deri bölgesinden ve geniş alçak geçirgenle gelir, kazanç sınırlıdır.
//
// YALNIZ IŞIK (2026-10-16, iş 6dd26e3e, kullanıcı: "yüzü boyamayacağız,
// sadece base'deki gibi ışık vereceğiz"). İlk sürüm canlıda yüzü boyadı:
// - Desen (0.045 yüz genişliği alçak geçirgen) base mankenin kendi yüzünü de
//   taşıdı: c9'da kaş arasında/burunda parlak, şakakta koyu lekeler; c8'de
//   alın ve yanak lekeleri. Ham kare her üçünde de daha doğaldı.
// - Doygunluk 1.22 dudakları pembeye boyadı (segmentasyon dudağı yüz derisi
//   sayıyor); c5'te boyun (sakal gölgesi) yüzü 0.70'e karartıp çamurlaştırdı.
// Şimdi: desen yerine iki yüzün log-parlaklık farkına yüz koordinatlarında
// İKİNCİ DERECE YÜZEY oturtulur (yan ışık, üst/alt ışık, ortası parlak) —
// leke taşıyamaz. Renk ve doygunluğa dokunulmaz (RGB eşit kazanç = ışık).
// Boyuna göre parlaklık ±%15 ile sınırlı.
//
// L1 — YÜZÜN KENDİ ŞEKLİ (2026-10-16 akşam). Teşhis (33 kare, çapraz
// doğrulamalı): base-çıktı farkının 2. derece yüzey 0.27'sini, çıktının yoğun
// yüz ağı (faceMesh.js, 468 nokta) normalleriyle küresel harmonik 0.36'sını,
// ikisi birlikte 0.42'sini açıklıyor (esnek 4. derece yüzey 0.40). Eski
// faceShading'in "iki tarafı ayrı oturt, farkı taşı" yöntemi 0.125 — canlıdaki
// ~%10'un nedeni yöntem. Şimdi farka yüzey + ÇIKTININ normallerinden 8 SH
// terimi BİRLİKTE oturtulur: burun yanı/elmacık ışığı kişinin kendi yüzüne
// düşer, base mankenin ayrıntısı taşınamaz. 34 karede desen benzerliği
// 0.566 → 0.587 (12 iyi, 1 kötü), gözle boyama yok. Ağ yoksa/68 noktayla
// uyuşmazsa (güçlü profil) eski yüzey aynen.
//
// L2 — ORTAM IŞIK RENGİ (aynı gün, bkz. sceneLight.js): selfie'lerden kişinin
// ışıksız teni × base sahnesinin ışığı = hedef yüz rengi; yalnız renk, kısmen,
// sınırlı. Selfie ölçüsü yoksa (eski işler) uygulanmaz.

const sharp = require("sharp");
const { _testables: SH } = require("./faceShading");

const { canonVerts, triangles, fitPose } = SH;

// Çalışma çözünürlüğü: yüz genişliği (≈2.3 göz arası) bu kadar piksel.
const WORK_FACE_PX = 256;
// Desen alçak geçirgeni (yüz genişliği cinsinden). Burun yanı gölgesi
// ~0.1 genişlik; daha geniş olursa yapı kaybolur, daha dar olursa kişinin
// ayrıntısı geçer.
// (Yalnız desen uyumu teşhisinde kullanılır.)
const LP_SIGMA = 0.045;
// Kazanç sınırları (log). Desen ve ortalama ayrı sınırlanır.
// 0.7/1.4 → 0.55/1.8 (2026-10-28, 546b514b, kullanıcı: "base'deki gölgeler ve
// ışık çıktıya tam yansıyamamış"): yan ışığı güçlü şablonda yüzey sınıra
// takılıyordu — c9'da şablonun 15 L yan ışığından çıktıya 3.7 kalıyordu,
// genişletince 5.1; c0/c2/c3'te gerileme yok. Yüzey ikinci derece (leke
// taşıyamaz), uyum kapısı aynı.
const PATTERN_MIN = Math.log(0.55);
const PATTERN_MAX = Math.log(1.8);
// Işık yüzeyi: aykırı piksellere (sakal, ben, parlama) Huber eşiği (log) ve
// yineleme sayısı.
const SURFACE_HUBER = 0.15;
const SURFACE_ITERS = 4;
// 3. derece daha güçlü desen verdi ama 6dd26e3e c9’da dudak/yanak yine kızardı.
const SURFACE_DEGREE = 2;
// Işık renginin yüz üzerindeki değişimi: kanal başına en fazla bu kadar (log);
// base'in kanallar arası farkı bundan küçükse siyah-beyaz sayılır.
// KAPALI (2026-10-19, 9c8f2cb5): base yüzünün renk değişimi ışık değil çoğu
// zaman mankenin kendi teni/sakal gölgesi — c1'de göz altı ve yanakta makyaj
// gibi lekeler, c7'de (koyu tenli manken) yüzü turuncu-kahveye boyadı. Aynı
// işte 8 karede kapalı hâl hiçbir yerde kötü değildi; ortalama ışık rengi
// L2'de (sceneLight) kalıyor.
const COLOR_ON = false;
const COLOR_MAX = 0.12;
const COLOR_BW_MIN = 0.03;
// Renk değişiminin ortalaması bundan küçükse uygulanmaz.
const COLOR_APPLY_MIN = 0.01;
// Ortalama kayması: 0.6'ya kadar karartma yüzü gri gösterdi (cbdbef13 13/20);
// 0.70 c5'i (6dd26e3e) çamurlaştırdı — boyun ölçüsü sakalla gürültülü.
const LEVEL_MIN = Math.log(0.85);
const LEVEL_MAX = Math.log(1.15);
// 0.80 → 0.92 (2026-10-25, d0d4c001 c3 "yüz canlı değil"): çıktı boynu açık
// yakanın gölgesinde ölçülünce güneşteki yüz 0.80'e kararıp donuklaştı.
const LEVEL_MIN_ENV = Math.log(0.92);
// Deri olasılığı eşiği, en az piksel, profil sınırı, kenar yumuşatması.
const SKIN_P = 0.5;
// Yanak/alın bölgesinin en az bu payı deri görünmüyorsa segmentasyon yok sayılır.
const SKIN_USABLE_SHARE = 0.15;
const MIN_PX = 400;
const MAX_YAW = 0.8;
const PROFILE_STRENGTH = 0.7;
// Profilde kulak, çenenin altı gibi yüz ağının (map.valid) kenarından cepheye
// göre daha uzağa düşer; ton halkası (bkz. relightCore "near") bu kadar
// genişletilir ki kulak de yüz tonuna çekilsin (2026-10-20, a4433ad1 c7).
const EAR_NEAR_PROFILE_SCALE = 2.2;
const EDGE_SIGMA = 0.035;
const EYEWEAR_RATIO_MAX = 0.55;
// Boyun ölçümü: tam karede 512 ızgara, sınıf olasılığı, en az piksel.
const SEG = 512;
const CLASS_P = 0.6;
const NECK_MIN_PX = 250;
// Şablonda boyun görünmüyorsa yüz/boyun oranı (cbdbef13 + c29a2b31 base
// medyanı, bkz. scripts yerel ölçüm 2026-10-16).
const DEFAULT_TPL_FACE_NECK = 1.1;
// Base yüz/boyun oranı bu aralığın dışındaysa ölçü güvenilmez (ölçülen
// 0.25-2.4; uçlar beyaz gömlek ya da gölgede boyun).
const TPL_RATIO_MIN = 0.55;
const TPL_RATIO_MAX = 2.5;
// Boyun ölçüsü gürültülü (yaka, sakal, gölge): ton düzeltmesinin bu kadarı
// uygulanır — yanlış ölçümde zarar küçük, doğru ölçümde fark yine kapanır.
const TONE_SHARE = 0.7;
// Boyun penceresinin üstü: çenenin bu kadar (yüz boyu) altından başlar.
const NECK_TOP = 0.2;
// Boyun en az yüz derisi pikselinin bu payı kadar görünmeli; daha karanlık
// (Lab L) "boyun" pikseli sayılmaz.
const NECK_FACE_SHARE = 0.25;
const NECK_MIN_L = 12;
// Boyun base'inkiyle aynı, yüz çok farklıysa model vücudu hiç değiştirmemiştir
// (base mankenin teni kalmış) — yüz ona bağlanmaz.
const BODY_UNCHANGED_DE = 5;
const FACE_DIFFERENT_DE = 12;
// Boyun base'inkine bu kadardan (Lab dE) yakın, yüz base yüzünden hem bu
// kadardan hem boyun farkının bu katından uzaksa boyun mankenindir.
const NECK_KEPT_DE = 4.5;
const FACE_CHANGED_DE = 8;
const NECK_KEPT_RATIO = 2.5;
// Base saç gölgesi: saç olasılığının bu yarıçapta (yüz genişliği) ortalaması
// eşiği aşan üst yüz pikseli öğrenilmez. Boşluklar bu yarıçapla doldurulur.
const HAIR_SHADOW_SIGMA = 0.05;
const HAIR_SHADOW_P = 0.2;
const FILL_SIGMA = 0.08;
// Bu kadar küçük değişiklik uygulanmaz.
const APPLY_MIN = 0.03;
// L1: SH terimlerinin sırt cezası (yüzey terimleri 1e-3). 0.02 ve 0.002
// denendi (34 kare 0.581 / 0.587), ikisinde de boyama yok.
const SH_RIDGE = 0.002;
// Ağ normalleri çalışma ızgarasında bu kadar (yüz genişliği) yumuşatılır.
const MESH_NORMAL_SIGMA = 0.012;
// L1 KAPALI (2026-10-20, 7c17ea3f c3/c8, kullanıcı: "yüzde lekeler",
// "yüz doğal olmalı"): ağ normalleri üzerinden öğrenilen SH terimleri
// burun yanı, göz çukuru, gülüş kıvrımı gibi YEREL şekillere bağlanıyor;
// base mankenin yüz yapısı/ifadesi (gülen şablonun yanak ve burun deseni)
// kullanıcının yüzüne leke olarak geçti. A/B'de (629b45de, 6dd26e3e,
// 7c17ea3f) ağsız yalnız yüzey her karede aynı ya da daha temiz, ışığın ana
// yönü kaldı.
// Yerel testte opts.mesh === true ile açılabilir.
const MESH_NORMALS_ON = false;
// DESEN UYUMU (2026-10-20, 3d1d2a71 c3/c8, ağ kapalıyken de lekeli): model
// base'in ışığını çoğunlukla zaten taklit ediyor — 50 karede uyum (iki
// yüzün alçak geçiren parlaklık korelasyonu) çoğunlukla 0.5-0.93. Uyumun
// düşük olduğu kareler (0.07, 0.16, 0.20, 0.21, 0.29) hep base'in IŞIK
// değil yüz yapısı/ifadesiydi (gülen şablon, şakak gölgesi): yüzey kenarları
// ağarttı, ortayı kararttı. Desen gücü uyumla ölçeklenir: FIT_ZERO altında
// yok, FIT_FULL üstünde tam. R² denendi, ayırmadı (lekeli 0.51, temiz 0.58).
const PATTERN_FIT_ZERO = 0.3;
const PATTERN_FIT_FULL = 0.6;
// L2: 2026-10-17 ilk canlı işte (0eeb75c8) kapatıldı — selfie'den çıkan
// ışıksız ten fazla gri-mavi, c12 gün batımı arka plandan "serin" ölçüldü.
// Yeniden tasarlandı (sceneLight.templateLight: selfie yok, ışık şablonun
// arka planı + kişisi + yüzünden); 31 karelik kör testte 26/31 seçildi.
const LIGHT_COLOR_ON = true;
// TABANDAN IŞIK YOK (2026-10-22, kullanıcı, b2a9537d c11: "gereksiz ışık
// vurmuş, ışıkları base fotolardan almayalım, ortama uygun ışığı kendimiz
// üretelim"). c11'de şablon mankeninin yüzü güneşte, boynu gölgede (oran
// 2.50) — yüz ×1.15 açıldı, desen alına parlama koydu; 25 teslim karesinin
// çoğunda yüz vücut derisinden 5-21 L açıktı. false: desen (mankenin yüz
// ışığı) kapalı, yüz kendi boynuna doğal oranla (DEFAULT_TPL_FACE_NECK)
// bağlanır; L2 sahne ışık rengi (arka plandan) kalır.
const BASE_LIGHT_ON = false;
// IŞIK YÖNÜ YİNE TABANDAN (2026-10-25, d0d4c001, kullanıcı: "yüzde tutarlı
// ışık yok, olduğu gibi koymuşsun, base'deki ışığı baz almalıyız"). Yalnız
// DESEN (ikinci derece yüzey, uyum kapılı) açılır; parlaklık kişinin kendi
// boynunda kalır (BASE_LIGHT_ON false) — şablon yüz/boyun oranı c6 çimen
// karesinde güneşteki yüzü 0.85'e kararttı. 15 eski ham karede leke yok;
// c2 pencere, c6 güneş, c7 stüdyo yan ışığı şablona yaklaştı.
const BASE_PATTERN_ON = true;

// POZLAMA (2026-10-29). Önceki denemeler (c3'te yüzü şablona göre karart)
// reddedildi çünkü ölçüm ışık ile pigmenti ayıramıyordu (bkz.
// [[face-exposure-hue]] 10-22/10-28). Çözüm: pigment artık piksel ölçümünden
// değil, VİZYON MODELİNDEN (skinPigment.js, gpt-4.1-mini — selfie ve şablon
// için ayrı ayrı, ışıktan bağımsız Monk Skin Tone tahmini) geliyor. Varsayılan
// KAPALI — mstUser/mstTpl her ikisi de verilmedikçe hiçbir şey hesaplanmaz,
// açık olsa bile. 64+5 tarihî karede ölçüldü (yerel, scratchpad/j546/lx);
// deploy onayı bekliyor.
const EXPOSURE_ON = false;
// Düzeltmenin gücü (1 = tam eşitleme); ölçüm gürültüsü ve "yarı gerçekçi"
// tercih için 1'in altında.
const EXPOSURE_BETA = 0.75;
// Üretimin yüzü şablondan en çok bu kadar koyu/açık kalabilir (log).
const EXPOSURE_MIN = Math.log(0.5);
const EXPOSURE_MAX = Math.log(1.25);
// Monk ölçeğinde (1-10) normal pozlamada tipik yüz açıklığı (L*); ardışık
// seviye farkı ~6 L. 64 kare üzerinde kalibre edildi.
const MST_L = [null, 75, 72, 69, 65, 60, 54, 47, 40, 33, 27];
/** Kullanıcı/şablon ten oranı (doğrusal ışık uzayında). ±1 seviye fark yok sayılır. */
function albedoRatio(mstUser, mstTpl, deadZone = 1) {
  if (!mstUser || !mstTpl) return 1;
  const toY = (L) => (L > 8 ? ((L + 16) / 116) ** 3 : L / 903.3);
  const d = mstUser - mstTpl;
  if (Math.abs(d) <= deadZone) return 1;
  const eff = Math.max(1, Math.min(10, mstTpl + Math.sign(d) * (Math.abs(d) - deadZone)));
  return toY(MST_L[Math.round(eff)]) / toY(MST_L[mstTpl]);
}

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const linToSrgb8 = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
};
const lumLin = (r, g, b) => 0.2126 * SRGB2LIN[r] + 0.7152 * SRGB2LIN[g] + 0.0722 * SRGB2LIN[b];

const rot = (R, v) => [0, 1, 2].map((r) => R[r][0] * v[0] + R[r][1] * v[1] + R[r][2] * v[2]);

/** 68 nokta + kanonik yardımcı noktaların görüntüdeki yeri ve derinliği. */
function projectVerts(pts) {
  const V = canonVerts();
  const pose = fitPose(pts, V.slice(0, 68));
  if (!pose) return null;
  const { s, R, t } = pose;
  return V.map((v, i) => {
    const r = rot(R, v);
    return i < 68 ? { x: pts[i].x, y: pts[i].y, z: s * r[2] } : { x: s * r[0] + t[0], y: s * r[1] + t[1], z: s * r[2] };
  });
}

/** Ayrılabilir Gauss bulanıklığı (Float32, kenar kıstırma). SAF. */
function gauss(src, w, h, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * src[y * w + Math.min(w - 1, Math.max(0, x + j))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

/** Ağırlıklı alçak geçirgen (normalize evrişim). SAF. */
function weightedLowpass(val, wt, w, h, sigma) {
  const num = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) num[i] = val[i] * wt[i];
  const a = gauss(num, w, h, sigma), b = gauss(wt, w, h, sigma);
  const out = new Float32Array(w * h), cov = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { out[i] = b[i] > 1e-4 ? a[i] / b[i] : 0; cov[i] = b[i]; }
  return { lp: out, cov };
}

/**
 * Işık yüzeyi: d = lt − lo (log parlaklık farkı) için kanonik koordinatta
 * ağırlıklı, Huber dayanıklı ikinci derece yüzey. at(cx, cy, i) ortalaması
 * çıkarılmış farkı verir (ortalama ton adımında). Koordinat öğrenilen
 * aralığa kıstırılır. extra(i) verilirse piksel başı ek terimler (L1: çıktı
 * normallerinin SH tabanı; extra(-1) uzunluğu verir), extraRidge cezasıyla.
 * Yeterli veri yoksa null. SAF.
 */
function fitLightSurface(lt, lo, wt, CX, CY, n, degree = SURFACE_DEGREE, extra = null, extraRidge = 0) {
  const poly = degree >= 3
    ? (x, y) => [1, x, y, x * x, x * y, y * y, x * x * x, x * x * y, x * y * y, y * y * y]
    : (x, y) => [1, x, y, x * x, x * y, y * y];
  const KB = poly(0, 0).length;
  const basis = (x, y, i) => (extra ? poly(x, y).concat(extra(i)) : poly(x, y));
  const K = KB + (extra ? extra(-1).length : 0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (!wt[i]) continue;
    cnt++;
    x0 = Math.min(x0, CX[i]); x1 = Math.max(x1, CX[i]); y0 = Math.min(y0, CY[i]); y1 = Math.max(y1, CY[i]);
  }
  if (cnt < MIN_PX) return null;
  let coef = null;
  for (let it = 0; it < SURFACE_ITERS; it++) {
    const A = Array.from({ length: K }, () => new Float64Array(K)), b = new Float64Array(K);
    for (let i = 0; i < n; i++) {
      if (!wt[i]) continue;
      const f = basis(CX[i], CY[i], i), d = lt[i] - lo[i];
      let w = wt[i];
      if (coef) {
        const r = Math.abs(d - f.reduce((s, v, k) => s + v * coef[k], 0));
        if (r > SURFACE_HUBER) w *= SURFACE_HUBER / r;
      }
      for (let p = 0; p < K; p++) { b[p] += w * f[p] * d; for (let q = 0; q < K; q++) A[p][q] += w * f[p] * f[q]; }
    }
    // Gauss eliminasyonu (küçük sırt terimi: tek yanlı yüzde x² belirsiz).
    for (let p = 1; p < K; p++) A[p][p] += (p >= KB ? extraRidge : 1e-3) * A[0][0];
    const M = A.map((row, p) => [...row, b[p]]);
    for (let c = 0; c < K; c++) {
      let piv = c;
      for (let r = c + 1; r < K; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < K; r++) {
        if (r === c) continue;
        const k = M[r][c] / M[c][c];
        for (let q = c; q <= K; q++) M[r][q] -= k * M[c][q];
      }
    }
    coef = M.map((row, p) => row[K] / row[p]);
  }
  // Yüzeyin ağırlıklı ortalaması (sabit terim tek başına değil — kanonik
  // koordinatlar sıfır merkezli değil).
  let m = 0, ws = 0;
  for (let i = 0; i < n; i++) if (wt[i]) { m += wt[i] * basis(CX[i], CY[i], i).reduce((s, v, k) => s + v * coef[k], 0); ws += wt[i]; }
  m /= ws;
  const at = (cx, cy, i = -1) => {
    const f = basis(Math.max(x0, Math.min(x1, cx)), Math.max(y0, Math.min(y1, cy)), i);
    return f.reduce((s, v, k) => s + v * coef[k], 0) - m;
  };
  return { coef, at };
}

function bilinear(arr, w, h, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, x - x0)), ay = Math.max(0, Math.min(1, y - y0));
  return (arr[y0 * w + x0] * (1 - ax) + arr[y0 * w + x1] * ax) * (1 - ay) + (arr[y1 * w + x0] * (1 - ax) + arr[y1 * w + x1] * ax) * ay;
}

/**
 * Desen öğrenme ağırlığı, kanonik koordinatta: göz, kaş ve ağız dışarıda;
 * sakal/bıyık bölgesi zayıf (base mankenin sakalı "gölge" diye taşınmasın,
 * çene ışığı çevresindeki yanaktan gelsin). SAF.
 */
// GÖZLÜK BÖLGESİ (2026-10-21, 017dbe34 c4, kullanıcı: "yüz düz, yapıştırma
// gibi"): gözlüklü şablonda desen tümüyle kapalıydı — yan ışıklı base'in
// yüzü düz kaldı. Kapatmak yerine cam, çerçeve ve camın yanağa düşürdüğü
// yansıma/gölge (cbdbef13 16: yanakta açık yama) öğrenmeden çıkarılır;
// orada desen alın/yanak altı/çeneden yayılır. Kanonik koordinat: göz
// merkezleri cx=±0.5, cy=0; kaş cy≈-0.4; ağız cy≈1.
function inGlasses(cx, cy) {
  return Math.abs(cx) < 1.15 && cy > -0.5 && cy < 0.62;
}

function regionWeight(cx, cy) {
  if (((Math.abs(cx) - 0.5) / 0.32) ** 2 + (cy / 0.19) ** 2 < 1) return 0; // göz
  if (cy > -0.55 && cy < -0.18 && Math.abs(cx) > 0.12 && Math.abs(cx) < 1.02) return 0; // kaş
  if (Math.abs(cx) < 0.42 && cy > 0.88 && cy < 1.2) return 0; // ağız
  if (Math.abs(cx) < 0.5 && cy > 0.7 && cy <= 0.88) return 0.15; // bıyık
  if (cy > 1.2 || (cy > 0.95 && Math.abs(cx) < 0.8)) return 0.15; // çene/sakal
  return 1;
}

/** Yüzü çalışma penceresine kırpar: pencere, ölçek, RGB, doğrusal Y, deri olasılığı. */
async function workCrop(rgb, W, H, P) {
  const eyeD = Math.hypot((P[42].x + P[45].x - P[36].x - P[39].x) / 2, (P[42].y + P[45].y - P[36].y - P[39].y) / 2);
  const faceW = eyeD * 2.3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // Kulaklar da pencerede olsun (ton kayması onlara da uygulanır).
  const pad = faceW * 0.3;
  const L0 = Math.max(0, Math.floor(x0 - pad)), T0 = Math.max(0, Math.floor(y0 - pad));
  const R0 = Math.min(W, Math.ceil(x1 + pad)), B0 = Math.min(H, Math.ceil(y1 + pad));
  if (R0 - L0 < 8 || B0 - T0 < 8) return null;
  const k = WORK_FACE_PX / faceW;
  const w = Math.max(8, Math.round((R0 - L0) * k)), h = Math.max(8, Math.round((B0 - T0) * k));
  const crop = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: L0, top: T0, width: R0 - L0, height: B0 - T0 }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = lumLin(crop[i * 3], crop[i * 3 + 1], crop[i * 3 + 2]);
  let skin = null, hair = null, body = null;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const pr = await classProbs(crop, w, h);
    skin = pr[CLASSES.faceSkin];
    hair = pr[CLASSES.hair];
    body = pr[CLASSES.bodySkin];
  } catch (e) {
    skin = null;
  }
  // Pencere ölçeği sx/sy ayrı (yuvarlama), görüntü→pencere: (X-L0)*sx.
  return { L0, T0, R0, B0, w, h, sx: w / (R0 - L0), sy: h / (B0 - T0), crop, Y, skin, hair, body, faceW: faceW * k };
}

/**
 * Çıktı penceresinin her pikseli için: geçerli mi (iki yüzde de görünen bir
 * üçgende), şablon penceresindeki karşılığı ve kanonik koordinatı.
 */
function correspond(vo, vt, cO, cT) {
  const V = canonVerts();
  const T = triangles();
  const { w, h } = cO;
  const valid = new Uint8Array(w * h);
  const TX = new Float32Array(w * h), TY = new Float32Array(w * h), CX = new Float32Array(w * h), CY = new Float32Array(w * h);
  const Z = new Float32Array(w * h).fill(Infinity);
  const qo = vo.map((p) => ({ x: (p.x - cO.L0) * cO.sx - 0.5, y: (p.y - cO.T0) * cO.sy - 0.5, z: p.z }));
  const qt = vt.map((p) => ({ x: (p.x - cT.L0) * cT.sx - 0.5, y: (p.y - cT.T0) * cT.sy - 0.5 }));
  const facing = (q, a, b, c) => (q[b].x - q[a].x) * (q[c].y - q[a].y) - (q[b].y - q[a].y) * (q[c].x - q[a].x);
  for (const [a, b, c] of T) {
    const canon = (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) - (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
    const areaO = facing(qo, a, b, c), areaT = facing(qt, a, b, c);
    if (Math.abs(areaO) < 1e-6 || (canon > 0) !== (areaO > 0) || (canon > 0) !== (areaT > 0)) continue;
    const A = qo[a], B = qo[b], C = qo[c];
    const bx0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), bx1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
    const by0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), by1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const w0 = ((B.x - x) * (C.y - y) - (B.y - y) * (C.x - x)) / areaO;
        const w1 = ((C.x - x) * (A.y - y) - (C.y - y) * (A.x - x)) / areaO;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const i = y * w + x;
        const z = w0 * A.z + w1 * B.z + w2 * C.z;
        if (z >= Z[i]) continue;
        Z[i] = z;
        valid[i] = 1;
        TX[i] = w0 * qt[a].x + w1 * qt[b].x + w2 * qt[c].x;
        TY[i] = w0 * qt[a].y + w1 * qt[b].y + w2 * qt[c].y;
        CX[i] = w0 * V[a][0] + w1 * V[b][0] + w2 * V[c][0];
        CY[i] = w0 * V[a][1] + w1 * V[b][1] + w2 * V[c][1];
      }
    }
  }
  return { valid, TX, TY, CX, CY };
}

/**
 * Yoğun ağın (faceMesh.denseMesh) normalleri çalışma ızgarasında: köşe
 * normalleri üçgen içinde ara değerlenir, z-tampon, yumuşatılır. Kameraya
 * bakan normal z<0 (faceShading ile aynı kural). Döner { N, ok }.
 */
function meshNormals(mesh, tri, cO) {
  const { w, h } = cO;
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const VN = mesh.map(() => [0, 0, 0]);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    let n = cross([mesh[b][0] - mesh[a][0], mesh[b][1] - mesh[a][1], mesh[b][2] - mesh[a][2]], [mesh[c][0] - mesh[a][0], mesh[c][1] - mesh[a][1], mesh[c][2] - mesh[a][2]]);
    if (n[2] > 0) n = [-n[0], -n[1], -n[2]];
    for (const q of [a, b, c]) for (let j = 0; j < 3; j++) VN[q][j] += n[j];
  }
  const NV = VN.map(unit);
  const q = mesh.map((p) => ({ x: (p[0] - cO.L0) * cO.sx - 0.5, y: (p[1] - cO.T0) * cO.sy - 0.5, z: p[2] }));
  const C = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const Z = new Float32Array(w * h).fill(Infinity);
  const ok = new Uint8Array(w * h);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const A = q[a], B = q[b], Cc = q[c];
    const area = (B.x - A.x) * (Cc.y - A.y) - (B.y - A.y) * (Cc.x - A.x);
    if (Math.abs(area) < 1e-6) continue;
    const bx0 = Math.max(0, Math.floor(Math.min(A.x, B.x, Cc.x))), bx1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, Cc.x)));
    const by0 = Math.max(0, Math.floor(Math.min(A.y, B.y, Cc.y))), by1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, Cc.y)));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const w0 = ((B.x - x) * (Cc.y - y) - (B.y - y) * (Cc.x - x)) / area;
        const w1 = ((Cc.x - x) * (A.y - y) - (Cc.y - y) * (A.x - x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const i = y * w + x, z = w0 * A.z + w1 * B.z + w2 * Cc.z;
        if (z >= Z[i]) continue;
        Z[i] = z;
        ok[i] = 1;
        for (let j = 0; j < 3; j++) C[j][i] = w0 * NV[a][j] + w1 * NV[b][j] + w2 * NV[c][j];
      }
    }
  }
  const okF = Float32Array.from(ok);
  const sm = C.map((ch) => weightedLowpass(ch, okF, w, h, MESH_NORMAL_SIGMA * cO.faceW).lp);
  const N = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const n = unit([sm[0][i], sm[1][i], sm[2][i]]);
    N[i * 3] = n[0]; N[i * 3 + 1] = n[1]; N[i * 3 + 2] = n[2];
  }
  return { N, ok };
}

/** Şablon gözlüğü: göz bölgesi yanak derisinden belirgin koyuysa. */
function eyewearRatio(map, cT) {
  let es = 0, en = 0, fs = 0, fn = 0;
  for (let i = 0; i < map.valid.length; i++) {
    if (!map.valid[i]) continue;
    const ex = Math.abs(map.CX[i]) - 0.5, ey = map.CY[i];
    const v = bilinear(cT.Y, cT.w, cT.h, map.TX[i], map.TY[i]);
    if ((ex / 0.32) ** 2 + (ey / 0.2) ** 2 < 1) { es += v; en++; } else if (regionWeight(map.CX[i], map.CY[i]) === 1) { fs += v; fn++; }
  }
  return en && fn ? Math.cbrt((es / en) / Math.max(1e-4, fs / fn)) : 1;
}

/**
 * Yüz derisi ve boyun derisi ortancaları (Lab + doğrusal Y). Segmentasyon
 * yüz+boyun kesitinde çalışır: tam karede küçük yüzü "vücut derisi" sayıyordu
 * (c29a2b31 c2/c5, cbdbef13 03/08/20). Boyun: çenenin altında, yüz genişliğinin
 * biraz dışına kadar. El/kol kullanılmaz — model şablonun ellerine çoğu zaman
 * dokunmuyor (bkz. hand-tone). Ten rengi olmayan "deri" (beyaz gömlek, koyu
 * kumaş: c3, 27) renk süzgeciyle elenir.
 */
async function faceNeckStats(rgb, W, H, P) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { rgbToLab } = require("./skinTone");
  const jaw = P.slice(0, 17);
  const jx0 = Math.min(...jaw.map((p) => p.x)), jx1 = Math.max(...jaw.map((p) => p.x));
  const chin = P[8].y, brow = Math.min(...P.slice(17, 27).map((p) => p.y));
  const fh = Math.max(1, chin - brow), fw = Math.max(1, jx1 - jx0);
  const L0 = Math.max(0, Math.floor(jx0 - 0.8 * fw)), R0 = Math.min(W, Math.ceil(jx1 + 0.8 * fw));
  const T0 = Math.max(0, Math.floor(brow - 0.7 * fh)), B0 = Math.min(H, Math.ceil(chin + 1.6 * fh));
  if (R0 - L0 < 8 || B0 - T0 < 8) return { face: { n: 0 }, neck: { n: 0 } };
  const k = Math.min(1, SEG / Math.max(R0 - L0, B0 - T0));
  const w = Math.max(8, Math.round((R0 - L0) * k)), h = Math.max(8, Math.round((B0 - T0) * k));
  const raw = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: L0, top: T0, width: R0 - L0, height: B0 - T0 }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const pr = await classProbs(raw, w, h);
  const face = [], neck = [];
  let gray = 0, tot = 0;
  // Yüz: yanak/alın/burun bandı (kaş altı → burun altı). Sakal yüzün
  // ortancasını düşürüyordu (cbdbef13 13: sakallı base, yüz %40 karardı).
  const fy0 = brow + 0.15 * fh, fy1 = P[33].y, fx0 = P[2].x, fx1 = P[14].x;
  // Boyun: çenenin altı, çene genişliğinde (el ve bardak yan tarafta
  // kalıyordu — cbdbef13 14). Çenenin hemen altı atlanır: sakal boyna iniyor
  // ve çene gölgesi var, boyun koyu ölçülüp yüz karartılıyordu (cbdbef13 20).
  const nx0 = Math.min(P[5].x, P[11].x) - 0.1 * fw, nx1 = Math.max(P[5].x, P[11].x) + 0.1 * fw;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const X = L0 + (x + 0.5) / k, Yp = T0 + (y + 0.5) / k;
      const isFace = pr[CLASSES.faceSkin][i] > CLASS_P && X >= Math.min(fx0, fx1) && X <= Math.max(fx0, fx1) && Yp >= fy0 && Yp <= fy1;
      const isNeck = !isFace && pr[CLASSES.bodySkin][i] > CLASS_P && X >= nx0 && X <= nx1 && Yp >= chin + NECK_TOP * fh && Yp <= chin + 1.2 * fh;
      if (!isFace && !isNeck) continue;
      const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
      const lab = rgbToLab(r, g, b);
      const c = Math.hypot(lab[1], lab[2]);
      tot++;
      if (c < 3) gray++;
      const s = { Y: lumLin(r, g, b), lab, c, hue: (Math.atan2(lab[2], lab[1]) * 180) / Math.PI };
      (isFace ? face : neck).push(s);
    }
  }
  // Siyah-beyaz karede renk süzgeci uygulanmaz.
  const bw = tot > 0 && gray / tot > 0.8;
  const skinLike = (s) => bw || (s.c >= 6 && s.hue >= 15 && s.hue <= 95 && s.lab[0] > 4 && s.lab[0] < 92);
  const med = (arr, f) => { const v = arr.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const fin = (arr, minPx) => {
    const a = arr.filter(skinLike);
    if (a.length < minPx) return { n: a.length };
    return { n: a.length, Y: med(a, (s) => s.Y), lab: [0, 1, 2].map((c) => med(a, (s) => s.lab[c])) };
  };
  const minPx = Math.max(30, Math.round(NECK_MIN_PX * (w * h) / (SEG * SEG)));
  const fc = fin(face, minPx);
  // Boyun yüzün en az NECK_FACE_SHARE'i kadar görünmeli ve karanlıkta
  // kaybolmamalı: yaka arasındaki ince şerit ya da gölgedeki kazak "boyun"
  // ölçülüp yüzü karartıyor/griliyordu (cbdbef13 13/20/27, c29a2b31 c7/c8:
  // boyun 250-850 px, yüz 4000-9000 px; iyi ölçülen c4/c5: 5500-9400 px).
  const nk = fin(neck.filter((s) => s.lab[0] >= NECK_MIN_L), Math.max(minPx, Math.round(NECK_FACE_SHARE * (fc.n || 0))));
  return { face: fc.Y != null ? fc : { n: 0 }, neck: nk.Y != null ? nk : { n: 0, seen: nk.n }, bw };
}

const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Yüzün ortalama parlaklık (log) kayması — kişinin kendi boynuna göre.
 * SAF (ölçülerden karar).
 *
 * TEN DEĞİL IŞIK (2026-10-19, 9c8f2cb5 c7, kullanıcı: "base foto esmer selfie
 * bembeyaz tenli veya tersi olabilir, bu tür sorunları çözmeli ve ışık ve
 * gölgeleri atlamamalıyız"): base'ten yalnız AYNI KİŞİNİN derisi içindeki
 * oran alınır (base yüz/boyun ↔ çıktı yüz/boyun) — ten rengi oranda
 * sadeleşir, gölge kalır. Genel ten düzeyi ham çıktıdan (model kullanıcının
 * boynunu kullanıcının teniyle çiziyor). Önceki "ikinci kanıt" (base yüzünün
 * mutlak parlaklığı ↔ çıktı yüzü) mankenin tenini ölçüyordu: 79 karede
 * neredeyse hep "karart" dedi; koyu tenli mankende beyaz kullanıcıyı
 * karartıyor (c7 0.85), açık tenli mankende esmer kullanıcıyı ağartırdı.
 * Kaldırıldı; yalnız log için döner. Sakallı boyun (6dd26e3e c5, ilk
 * kanıtın sebebi) artık LEVEL_MIN sınırında kalıyor — o kare eski kuralla da
 * 0.85'ti.
 */
function tonePlan(so, st, { env = false } = {}) {
  const none = { level: 0 };
  if (!so.face.n || !so.neck.n) return { ...none, reason: "no-neck" };
  // Boyun base'inkiyle aynı VE yüzün açıklığı base yüzünden çok farklıysa
  // (başka ten) boyun base mankenin derisidir. Yalnız renk farkı yetmez:
  // selfie ışığı yüzü zaten farklı renkte çiziyor (c29a2b31 c5).
  if (st.neck.n && st.face.n && dE(so.neck.lab, st.neck.lab) < BODY_UNCHANGED_DE &&
      Math.abs(so.face.lab[0] - st.face.lab[0]) > FACE_DIFFERENT_DE && Math.abs(so.neck.lab[0] - so.face.lab[0]) > FACE_DIFFERENT_DE) {
    return { ...none, reason: "body-unchanged" };
  }
  // MANKENİN BOYNU KALMIŞ (genel hâli): çıktı boynu base boynuna çok yakın,
  // çıktı yüzü base yüzünden çok uzak — model boynu değiştirmemiş; oran
  // kullanıcının yüzünü mankenin derisine bağlar (79 karede 3b4 c3/c7,
  // ca6 c9, 0ee c7). Ton atlanır, desen yine uygulanır.
  if (st.neck.n && st.face.n) {
    const nn = dE(so.neck.lab, st.neck.lab), ff = dE(so.face.lab, st.face.lab);
    if (nn < NECK_KEPT_DE && ff > FACE_CHANGED_DE && ff > NECK_KEPT_RATIO * nn) return { ...none, reason: "neck-kept" };
  }
  // Base'in boyun ölçüsü: boyun yüzden çok AÇIKSA (oran < 0.55) ölçülen şey
  // çoğu zaman beyaz gömlek (c29a2b31 c3 0.25) — tipik oran alınır. Boyun
  // gölgedeyse oran büyük çıkar ve bu gerçek ışıktır (c7 mum: 2.18), yalnız
  // kıstırılır.
  // Base ölçüsü yoksa parlaklığa dokunulmaz: tipik oran sert üst ışıkta
  // (boyun gölgede) yüzü yanlışlıkla karartıyordu (c29a2b31 c3).
  const rTraw = st.neck.n && st.face.n ? st.face.Y / st.neck.Y : null;
  // ORTAM (env): hedef oran şablon mankeninin yüz/boyun oranı DEĞİL, doğal
  // tipik oran — yüz kişinin kendi boynuyla aynı sahne ışığında kalır.
  const tplOk = env || (rTraw != null && rTraw >= TPL_RATIO_MIN);
  const rT = env ? DEFAULT_TPL_FACE_NECK : tplOk ? Math.min(TPL_RATIO_MAX, rTraw) : DEFAULT_TPL_FACE_NECK;
  const rO = so.face.Y / so.neck.Y;
  const byNeck = TONE_SHARE * (Math.log(rT) - Math.log(rO));
  const byFace = st.face.n ? TONE_SHARE * (Math.log(st.face.Y) - Math.log(so.face.Y)) : 0;
  // Ortam modunda kişinin kendi boynu referans; karartma 0.80'e kadar (yüz
  // vücuttan çok açık kalıyordu — b2a9537d c2/c11, 29cf877a c2).
  const level = tplOk ? Math.max(env ? LEVEL_MIN_ENV : LEVEL_MIN, Math.min(LEVEL_MAX, byNeck)) : 0;
  // Renge (ton açısı, doygunluk) dokunulmaz: 6dd26e3e c9'da doygunluk 1.22
  // dudakları boyadı. Yüz-vücut ten uyumu TEN ALANI'nda vücut yüze çekilerek.
  return { level, reason: null, rT, rO, tplOk, byNeck, byFace };
}

/** Yüz noktaları hazırken çekirdek (yerel testler de bunu çağırır). */
async function relightCore(oRgb, tRgb, W, H, ptsO, ptsT, { strength = 1, tone = true, pattern: patternOpt = true, mesh = null, tplBox = null, sceneColor = true, lightPlan = null, color: colorOpt = true, prof = false, eyewear = false, mstUser = null, mstTpl = null } = {}) {
  let pattern = patternOpt;
  const vo = projectVerts(ptsO), vt = projectVerts(ptsT);
  if (!vo || !vt) return { buf: null, applied: false, reason: "no-geometry" };
  const [cO, cT] = await Promise.all([workCrop(oRgb, W, H, vo), workCrop(tRgb, W, H, vt)]);
  if (!cO || !cT) return { buf: null, applied: false, reason: "no-geometry" };
  const map = correspond(vo, vt, cO, cT);
  const { w, h } = cO;
  const ew = eyewearRatio(map, cT);
  const glasses = eyewear || ew < EYEWEAR_RATIO_MAX;

  // Base'de saçın gölgesi (c29a2b31 c7: kakül alına düşüyor) ışık değil,
  // o kişinin saçı — saçın yakınındaki üst yüz derisi öğrenmeye girmez.
  let hairNear = null;
  if (cT.hair) {
    const ht = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (map.valid[i]) ht[i] = bilinear(cT.hair, cT.w, cT.h, map.TX[i], map.TY[i]);
    hairNear = gauss(ht, w, h, HAIR_SHADOW_SIGMA * cO.faceW);
  }
  // Segmentasyon yüz bölgesinde deri bulamıyorsa (siyah-beyaz, çok karanlık)
  // o harita kullanılmaz, bölge kuralı kalır (faceShading'deki gibi).
  const skinUsable = (getP) => {
    let n = 0, s = 0;
    for (let i = 0; i < w * h; i++) if (map.valid[i] && regionWeight(map.CX[i], map.CY[i]) === 1) { n++; if (getP(i) > SKIN_P) s++; }
    return n > 0 && s / n >= SKIN_USABLE_SHARE;
  };
  const skinO = cO.skin && skinUsable((i) => cO.skin[i]) ? cO.skin : null;
  const skinT = cT.skin && skinUsable((i) => bilinear(cT.skin, cT.w, cT.h, map.TX[i], map.TY[i])) ? cT.skin : null;
  // Desen: iki yüzde de deri olan piksellerin log-parlaklığı.
  const lt = new Float32Array(w * h), lo = new Float32Array(w * h), wt = new Float32Array(w * h);
  const tVals = [];
  for (let i = 0; i < w * h; i++) {
    if (!map.valid[i]) continue;
    const rw = regionWeight(map.CX[i], map.CY[i]);
    if (!rw) continue;
    if (glasses && inGlasses(map.CX[i], map.CY[i])) continue;
    if (hairNear && skinT && map.CY[i] < 0 && hairNear[i] > HAIR_SHADOW_P) continue;
    const po = skinO ? skinO[i] : 1, pt = skinT ? bilinear(skinT, cT.w, cT.h, map.TX[i], map.TY[i]) : 1;
    if (po < SKIN_P || pt < SKIN_P) continue;
    const yt = bilinear(cT.Y, cT.w, cT.h, map.TX[i], map.TY[i]);
    wt[i] = rw * Math.min(po, pt);
    lt[i] = Math.log(Math.max(1e-4, yt));
    lo[i] = Math.log(Math.max(1e-4, cO.Y[i]));
    tVals.push(lt[i]);
  }
  if (tVals.length < MIN_PX) return { buf: null, applied: false, reason: "no-common-skin", n: tVals.length };
  // Parlama (base'in üst %3'ü) ve neredeyse siyah (gölgede gözlük, saç tutamı) dışarıda.
  tVals.sort((a, b) => a - b);
  const hi = tVals[Math.floor(tVals.length * 0.97)], loCut = tVals[Math.floor(tVals.length * 0.01)];
  for (let i = 0; i < w * h; i++) if (wt[i] && (lt[i] > hi || lt[i] < loCut)) wt[i] = 0;

  const sig = LP_SIGMA * cO.faceW;
  const LT = weightedLowpass(lt, wt, w, h, sig), LO = weightedLowpass(lo, wt, w, h, sig);
  let mt = 0, mo = 0, ws = 0;
  for (let i = 0; i < w * h; i++) if (wt[i]) { mt += wt[i] * LT.lp[i]; mo += wt[i] * LO.lp[i]; ws += wt[i]; }
  mt /= ws; mo /= ws;
  // Desen korelasyonu (teşhis): önce.
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < w * h; i++) {
    if (!wt[i]) continue;
    const a = LT.lp[i] - mt, b = LO.lp[i] - mo;
    sab += wt[i] * a * b; saa += wt[i] * a * a; sbb += wt[i] * b * b;
  }
  const corrBefore = sab / Math.sqrt(saa * sbb || 1);
  const fitGain = Math.max(0, Math.min(1, (corrBefore - PATTERN_FIT_ZERO) / (PATTERN_FIT_FULL - PATTERN_FIT_ZERO)));
  if (fitGain <= 0) pattern = false;

  // POZLAMA (2026-10-29, 546b514b devamı, kullanıcı: "detaylı çalışalım").
  // mt-mo yukarıda zaten hesaplı: öğrenme bölgesindeki (göz/kaş/ağız dışı yüz
  // derisi) ortalama log-parlaklık FARKI — ışık + pigment karışık. Pattern
  // yüzeyi (surf) bu ortalamayı kendi içinde ÇIKARIYOR (bkz. fitLightSurface
  // `m`), yani şu ana kadar hiçbir yerde kullanılmıyordu. Pigmenti ayırmak
  // için VİZYON MODELİNDEN (gpt-4.1-mini, skinPigment.js) alınan Monk Skin
  // Tone (MST) tahminiyle "ten oranı" (albedoRatio) hesaplanır; yalnız geri
  // kalan kısım (ışık farkı) uygulanır. Kapalı: şablon MST'siz çalışır
  // (mstUser/mstTpl opsiyonel), EXPOSURE_ON false iken hiç hesaplanmaz.
  let expLevel = 0;
  if (EXPOSURE_ON && mstUser && mstTpl) {
    const ratio = albedoRatio(mstUser, mstTpl);
    expLevel = Math.max(EXPOSURE_MIN, Math.min(EXPOSURE_MAX, EXPOSURE_BETA * (Math.log(ratio) + (mt - mo))));
  }

  // Ton: yüz ↔ kendi boynu (yalnız parlaklık).
  let tp = { level: 0, reason: "off" };
  let stats = null;
  if (tone) {
    const [so, st] = await Promise.all([faceNeckStats(oRgb, W, H, ptsO), faceNeckStats(tRgb, W, H, ptsT)]);
    tp = tonePlan(so, st, { env: !BASE_LIGHT_ON });
    stats = { so, st };
  }

  // Işık yüzeyi: iki yüzün log-parlaklık farkına kanonik koordinatta ikinci
  // derece yüzey (bkz. dosya başı YALNIZ IŞIK). Kanonik aralığın dışına
  // taşmasın diye koordinat öğrenilen aralığa kıstırılır.
  // L1: çıktının yoğun ağ normalleri (yoksa yalnız yüzey). Ağın kapsamadığı
  // piksel öğrenilmez, desen orada komşudan yayılır.
  const dn = mesh && pattern ? meshNormals(mesh.mesh, mesh.tri, cO) : null;
  if (dn) for (let i = 0; i < w * h; i++) if (!dn.ok[i]) wt[i] = 0;
  const shAt = dn ? (i) => (i < 0 ? new Array(8).fill(0) : SH.shBasis([dn.N[i * 3], dn.N[i * 3 + 1], dn.N[i * 3 + 2]]).slice(1)) : null;
  const surf = pattern ? fitLightSurface(lt, lo, wt, map.CX, map.CY, w * h, SURFACE_DEGREE, shAt, SH_RIDGE) : null;

  // L2: ortam ışık rengi (bkz. sceneLight.templateLight). Yüzün şu anki rengi
  // öğrenme piksellerinden; ışık şablonun arka planı + kişisi + yüzünden.
  let light = { lc: null, reason: "off" };
  if (LIGHT_COLOR_ON && sceneColor && !lightPlan) {
    try {
      const { templateLight, planSceneColor, medianColor } = require("./sceneLight");
      let box = tplBox;
      if (!box) {
        let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
        for (const p of ptsT) { fx0 = Math.min(fx0, p.x); fy0 = Math.min(fy0, p.y); fx1 = Math.max(fx1, p.x); fy1 = Math.max(fy1, p.y); }
        box = { x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0 };
      }
      const tl = await templateLight(tRgb, W, H, box);
      const vals = [];
      for (let i = 0; i < w * h; i++) if (wt[i] > 0.5) vals.push([SRGB2LIN[cO.crop[i * 3]], SRGB2LIN[cO.crop[i * 3 + 1]], SRGB2LIN[cO.crop[i * 3 + 2]]]);
      const face = vals.length >= MIN_PX ? medianColor(vals) : null;
      light = { ...planSceneColor(tl.light, face), ...tl, face };
    } catch (e) {
      console.error("Yüz ışığı: ortam ışık rengi ölçülemedi (atlanıyor):", e.message || e);
      light = { lc: null, reason: "error" };
    }
  }
  // Yerel deneme kancası: lightPlan(yüzRengi) → log kazanç × 3 (canlıda yok).
  if (lightPlan) {
    const { medianColor } = require("./sceneLight");
    const vals = [];
    for (let i = 0; i < w * h; i++) if (wt[i] > 0.5) vals.push([SRGB2LIN[cO.crop[i * 3]], SRGB2LIN[cO.crop[i * 3 + 1]], SRGB2LIN[cO.crop[i * 3 + 2]]]);
    const face = vals.length >= MIN_PX ? medianColor(vals) : null;
    light = { lc: face ? lightPlan(face) : null, face, reason: face ? "test" : "no-measure" };
  }
  const lightOn = !!(light.lc && Math.max(...light.lc.map(Math.abs)) > 0.01);
  const Dp = new Float32Array(w * h), have = new Float32Array(w * h);
  let patAbs = 0, patN = 0;
  for (let i = 0; i < w * h; i++) {
    if (!map.valid[i]) continue;
    if (dn && !dn.ok[i]) continue;
    let d = surf ? strength * fitGain * surf.at(map.CX[i], map.CY[i], i) : 0;
    d = Math.max(PATTERN_MIN, Math.min(PATTERN_MAX, d));
    Dp[i] = d; have[i] = 1;
    if (wt[i]) { patAbs += Math.abs(d); patN++; }
  }
  const patternMean = patN ? patAbs / patN : 0;
  // IŞIK RENGİNİN YÜZDEKİ DEĞİŞİMİ (2026-10-16, c29a2b31 c5/c7 yeniden: yalnız
  // parlaklıkla sıcak lamba/mum ışığı neredeyse hiç görünmedi). Her kanalın
  // parlaklığa göre log oranı için aynı yüzey; ORTALAMASI ATILIR — yalnız
  // aydınlık yanın sıcak, gölge yanın serin olması gibi değişim taşınır,
  // kişinin ortalama teni base mankeninkine boyanmaz (matchFaceExposure hatası).
  let colorSurf = null;
  if (pattern && surf && COLOR_ON && colorOpt) {
    const chan = (crop, n) => [0, 1, 2].map((c) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = SRGB2LIN[crop[i * 3 + c]]; return a; });
    const tC = chan(cT.crop, cT.w * cT.h), oC = chan(cO.crop, w * h);
    let chroma = 0, cn = 0;
    const lct = [0, 1, 2].map(() => new Float32Array(w * h)), lco = [0, 1, 2].map(() => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) {
      if (!wt[i]) continue;
      const v = [0, 1, 2].map((c) => Math.max(1e-4, bilinear(tC[c], cT.w, cT.h, map.TX[i], map.TY[i])));
      for (let c = 0; c < 3; c++) { lct[c][i] = Math.log(v[c]) - lt[i]; lco[c][i] = Math.log(Math.max(1e-4, oC[c][i])) - lo[i]; }
      chroma += Math.abs(lct[0][i] - lct[2][i]); cn++;
    }
    // Siyah-beyaz base: renk değişimi yok.
    if (cn && chroma / cn > COLOR_BW_MIN) colorSurf = [0, 1, 2].map((c) => fitLightSurface(lct[c], lco[c], wt, map.CX, map.CY, w * h));
    if (colorSurf && colorSurf.some((s) => !s)) colorSurf = null;
    if (colorSurf) {
      let cm = 0, ck = 0;
      for (let i = 0; i < w * h; i++) if (wt[i]) { for (const s of colorSurf) cm += Math.abs(s.at(map.CX[i], map.CY[i])); ck += 3; }
      if (cm / ck < COLOR_APPLY_MIN) colorSurf = null;
    }
  }
  const levelAbs = Math.abs(tp.level);
  if (patternMean < APPLY_MIN && levelAbs < APPLY_MIN && !colorSurf && !lightOn && Math.abs(expLevel) < APPLY_MIN) {
    return { buf: null, applied: false, reason: "similar-light", patternMean, corrBefore, tone: tp, toneStats: stats, mesh: !!dn, light, expLevel, expOn: EXPOSURE_ON };
  }
  // Öğrenilmeyen yerlerde (yüz kenarı, saç gölgeli alın) desen komşulardan.
  const ext = weightedLowpass(Dp, have, w, h, FILL_SIGMA * cO.faceW);
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = have[i] ? Dp[i] : ext.lp[i];
  const Ds = gauss(D, w, h, 0.012 * cO.faceW);

  // Desen maskesi: geçerli yüz bölgesi, içeriden yumuşatılmış (kafa çevresinde
  // hale yok — f9f3b5c0).
  const { insideSoft } = SH;
  const alpha = await insideSoft(map.valid, w, h, EDGE_SIGMA * cO.faceW);
  // Parlaklık maskesi: yüz + kulaklar. Yalnız yüze uygulanınca kulak eski
  // tonda kalıp yüz maske gibi duruyordu (cbdbef13 13/20/27). Yüz bölgesinin
  // biraz dışına taşar ama orada yalnız deriye; çenenin altında söner (boyun
  // ölçünün referansı, dokunulmaz).
  const vf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) vf[i] = map.valid[i];
  // Profilde kulak yüz ağından çok daha uzakta kalır (a4433ad1 c7: yaw 0.78
  // kaydında kulak bu halkanın dışında kalıp eski tonda görünmüştü) — halka
  // profilde genişletilir, cepheden dokunulmaz.
  const near = gauss(vf, w, h, (prof ? EAR_NEAR_PROFILE_SCALE : 1) * 0.08 * cO.faceW);
  const skinAll = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) skinAll[i] = Math.min(1, (cO.skin ? cO.skin[i] : 1) + (cO.body ? cO.body[i] : 0));
  const skinSoft = gauss(skinAll, w, h, 0.01 * cO.faceW);
  const chinY = (vo[8].y - cO.T0) * cO.sy, fadeLen = 0.12 * cO.faceW;
  const toneMask = (fx, fy, a) => {
    const fade = fy <= chinY ? 1 : Math.max(0, 1 - (fy - chinY) / fadeLen);
    if (!fade) return 0;
    const reg = Math.max(0, Math.min(1, (bilinear(near, w, h, fx, fy) - 0.1) / 0.3));
    const sk = Math.max(0, Math.min(1, (bilinear(skinSoft, w, h, fx, fy) - 0.3) / 0.4));
    // Yüzün içinde her şeye (göz, kaş, sakal da aynı ışıkta), dışında yalnız deriye.
    return fade * Math.max(a, reg * sk);
  };
  // Renk değişimi alanı (çalışma ızgarasında, yüz dışına komşudan yayılmış).
  let Cs = null;
  if (colorSurf) {
    Cs = colorSurf.map((s) => {
      const Dc = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) if (map.valid[i]) Dc[i] = Math.max(-COLOR_MAX, Math.min(COLOR_MAX, strength * s.at(map.CX[i], map.CY[i])));
      const e = weightedLowpass(Dc, have, w, h, FILL_SIGMA * cO.faceW);
      for (let i = 0; i < w * h; i++) if (!have[i]) Dc[i] = e.lp[i];
      return gauss(Dc, w, h, 0.012 * cO.faceW);
    });
  }
  // Kazanç doğrusal RGB'de: parlaklık üç kanala eşit; ışık renginin değişimi
  // kanal başına (ortalaması sıfır).
  const out = Buffer.from(oRgb);
  for (let y = cO.T0; y < cO.B0; y++) {
    for (let x = cO.L0; x < cO.R0; x++) {
      const fx = (x - cO.L0 + 0.5) * cO.sx - 0.5, fy = (y - cO.T0 + 0.5) * cO.sy - 0.5;
      const a = bilinear(alpha, w, h, fx, fy) / 255;
      const lv = toneMask(fx, fy, a);
      if (a <= 0.01 && lv <= 0.01) continue;
      const lg = a * (bilinear(Ds, w, h, fx, fy) + expLevel) + lv * tp.level;
      const i = y * W + x;
      for (let c = 0; c < 3; c++) {
        // L2 rengi yüz + kulaklara (parlaklık maskesiyle aynı yer).
        const g = Math.exp(lg + (Cs ? a * bilinear(Cs[c], w, h, fx, fy) : 0) + (lightOn ? Math.max(a, lv) * light.lc[c] : 0));
        out[i * 3 + c] = linToSrgb8(SRGB2LIN[oRgb[i * 3 + c]] * g);
      }
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return {
    buf, applied: true, reason: null, mesh: !!dn, light, pattern, eyeRatio: ew, patternMean, corrBefore, n: tVals.length, surface: surf ? surf.coef : null, color: !!colorSurf,
    tone: tp, toneStats: stats, neckO: stats?.so.neck.n ?? null, neckT: stats?.st.neck.n ?? null, expLevel, expOn: EXPOSURE_ON,
  };
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında (şablon çıktı boyutuna
 * getirilir). Döner: { buf|null, applied, reason, patternMean, tone, ... }
 */
async function relightFace(outputBuf, templateBuf, opts = {}) {
  const { faceLandmarks, headYawOf } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  const lt = (await faceLandmarks(tJpeg)) || (await faceLandmarks(tJpeg, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template" };
  const yo = await headYawOf(outputBuf, 0.1), yt = await headYawOf(tJpeg, 0.1);
  // Profilde eşleme yalnız görünen yarıda — desen azaltılmış güçle (c29a2b31
  // c6: kapalıyken base'in yan ışığı hiç gelmedi, 0.7 güçle bozulma yok).
  // Gözlüklü base'de cam bölgesi öğrenmeden çıkarılır (bkz. inGlasses).
  const prof = (yo != null && yo > MAX_YAW) || (yt != null && yt > MAX_YAW);
  const pattern = opts.pattern === true || ((BASE_LIGHT_ON || BASE_PATTERN_ON) && opts.pattern !== false);
  const strength = (opts.strength ?? 1) * (prof ? PROFILE_STRENGTH : 1);
  // L1: çıktının yoğun yüz ağı. Hata/uyuşmazlıkta null — eski yüzey aynen.
  let mesh = null;
  if (pattern && (opts.mesh === true || (MESH_NORMALS_ON && opts.mesh !== false))) {
    try {
      const FM = require("./faceMesh");
      const m = await FM.denseMesh(o.data, W, H, lo.pts);
      if (m) mesh = { mesh: m.mesh, tri: FM.triangles() };
    } catch (e) {
      console.error("Yüz ışığı: yoğun yüz ağı hata verdi (yalnız yüzey):", e.message || e);
    }
  }
  const r = await relightCore(o.data, t, W, H, lo.pts, lt.pts, { ...opts, pattern, strength, mesh, tplBox: lt.box || null, lightPlan: opts.lightPlan || null, prof, eyewear: !!opts.templateEyewear });
  return { ...r, profile: prof, yawO: yo, yawT: yt };
}

module.exports = {
  relightFace,
  relightCore,
  albedoRatio,
  EXPOSURE_ON,
  _testables: { meshNormals, gauss, weightedLowpass, fitLightSurface, regionWeight, tonePlan, projectVerts, correspond, faceNeckStats, DEFAULT_TPL_FACE_NECK, albedoRatio, MST_L, EXPOSURE_MIN, EXPOSURE_MAX },
};
