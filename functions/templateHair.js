"use strict";
/**
 * ŞABLON SAÇI ÖN TEMİZLİĞİ (2026-10-27, e25dc241 c1/c2/c9, kullanıcı: "saç
 * silüet problemleri... selfienin saçı neyse çıktının da o olacak").
 *
 * SORUN: kıvırcık, hacimli saçlı kullanıcıda model şablonun kısa saçının
 * kalıbını korudu: c1'de başın üstünde şablon saçı şeklinde düz koyu bir
 * "kep", içinden kullanıcının bukleleri yarı saydam; c2'de şablonun yüksek
 * alnı saç çizgisinde kullanıcının saçının altından sızıyor. Prompt bunu
 * açıkça yasaklıyor ("solid and opaque... never see-through to fit the BASE
 * hair's shape"), sonradan maskeli onarım da tutmamıştı (model mevcut saçı
 * korudu). Model şablonun saçını GÖRDÜĞÜ sürece kalıbını koruyor.
 *
 * ÇÖZÜM: modele giden taban kopyasında şablonun saçı (ve yüksek alnı) yerel
 * LaMa ile arka planla doldurulur. Model kopyalayacak saç görmez; saçı ve saç
 * çizgisini yalnız selfielerden çizer. Son katmanlar (arka plan geri
 * yükleme, kafa çevresi, ten...) ORİJİNAL şablonla çalışmaya devam eder.
 *
 * Maske: çene hizasının üstünde, yüze bağlı
 *  - saç sınıfı (aksesuar/şapka değil),
 *  - kaş üstünde soluk teller (kişi maskesinde var, sınıfı arka plan),
 *  - kaşların FOREHEAD_KEEP kadar üstünden yukarıdaki alın derisi (şablonun
 *    saç çizgisi kimliğe ait değil; kaş ve göz çevresi poz için kalır).
 * Şapkalı şablonda dokunulmaz (prompt şapkayı korur, saç onun altında).
 * skinSeg değerleri softmax değil, kırpılmış ham skor (bkz. skinTone).
 */
const sharp = require("sharp");

// Kafa kesiti, yüz genişliğine oranla.
const CROP_SIDE_FACE = 2.4;
const CROP_UP_FACE = 2.2;
const HAIR_MIN = 0.5;
// Kaş üstünde soluk tel: kişi maskesi bu kadar ve sınıf arka plan
// (headSurround.TPL_STRAND_MIN ile aynı; 0.1'de c0'ın tepe telleri kaldı).
const STRAND_MIN = 0.05;
// Tel adayının saç sınıfına en çok uzaklığı, yüz genişliğine oranla.
const STRAND_REACH_FACE = 0.12;
// Kaşların üstünde korunan alın şeridi, (çene − kaş) yüksekliğinin payı.
const FOREHEAD_KEEP = 0.15;
// Maskenin genişletilmesi (saç kenarındaki ince teller), yüz genişliğine oranla.
const GROW_FACE = 0.03;
// Kaş üstünde bu kadar (yüz²) aksesuar sınıfı = şapka/bere → dokunulmaz.
const HAT_MIN_FACE2 = 0.15;
// Bundan az saç (yüz²) → kel/çok kısa saç, dokunulmaz.
const MIN_HAIR_FACE2 = 0.02;
// Saç maskesinin tepesi karenin üst kenarına bundan (kaş–çene yüksekliği
// cinsinden) yakınsa silinmez: model kafa tepesine yer açmak için yeniden kadrajlıyor.
const TOP_HEADROOM_FACE = 0.3;
// Saçın yerine ne konur: "bg" yalnız zemin, "skull" kel kafatası (bkz. KAFATASI notu).
const ERASE_FILL = "skull";
// Dolgu bağlamından çıkarılan kafa: kişi maskesi eşiği ve çenenin altına uzanımı.
const HEAD_CTX_PERSON = 0.3;
const HEAD_CTX_BELOW_FACE = 0.3;

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Şablon saçı maskesi, tam kare Uint8Array(W*H). rgb: şablon raw RGB,
 * lo: faceLandmarks sonucu. Dönüş { mask, hairPx, foreheadPx, strandPx,
 * faceW, reason? }.
 */
async function templateHairMask(rgb, W, H, lo) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { personMask } = require("./headScale");
  const P = lo.pts;
  const faceW = Math.max(lo.box.width, Math.hypot(P[0].x - P[16].x, P[0].y - P[16].y));
  const chin = P[8].y;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const yF = browY - FOREHEAD_KEEP * Math.max(0, chin - browY);
  const fx0 = Math.min(P[0].x, P[16].x), fx1 = Math.max(P[0].x, P[16].x);
  const bx0 = clampI(cx - CROP_SIDE_FACE * faceW, 0, W - 1);
  const bx1 = clampI(cx + CROP_SIDE_FACE * faceW, 0, W - 1);
  const by0 = clampI(lo.box.y - CROP_UP_FACE * faceW, 0, H - 1);
  const by1 = clampI(chin + HEAD_CTX_BELOW_FACE * faceW, 0, H - 1);
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  const mask = new Uint8Array(W * H);
  // Dolguya bağlam olarak verilmeyen kafa (yüz, kulak, boyun): verilince LaMa
  // alnı yukarı sürdürüp kel bir kafa tepesi çizdi; kel taban modelin deriyi
  // saçın altından göstermesine yol açar (c2 kusuru). Saç yerine ZEMİN dolar.
  const head = new Uint8Array(W * H);
  const res = { mask, head, hairPx: 0, foreheadPx: 0, strandPx: 0, faceW };
  if (w < 16 || h < 16) return { ...res, reason: "tiny" };
  // KARE KESİT: sınıflandırıcı girdiyi 256×256'ya oranı bozarak sıkıştırıyor;
  // baş karenin tepesindeyken kesit 485×198 kaldı ve saç hiç görülmedi (kırpılmış
  // c1 tuvali, en yüksek saç skoru 0.00). Kesit gri dolguyla kareye tamamlanır;
  // kesilen kenar (genelde üst) dolgu tarafına konur.
  const S = Math.max(w, h);
  const ox = bx0 === 0 && w < S ? S - w : w < S ? Math.floor((S - w) / 2) : 0;
  const oy = by0 === 0 && h < S ? S - h : h < S ? Math.floor((S - h) / 2) : 0;
  const sq = Buffer.alloc(S * S * 3, 128);
  for (let y = 0; y < h; y++) rgb.copy(sq, ((y + oy) * S + ox) * 3, ((y + by0) * W + bx0) * 3, ((y + by0) * W + bx1 + 1) * 3);
  const [Psq, Mt] = await Promise.all([classProbs(sq, S, S), personMask(rgb, W, H)]);
  const Po = Psq.map((p) => {
    const a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = p[(y + oy) * S + x + ox];
    return a;
  });
  const fa2 = faceW * faceW;
  let hatPx = 0;
  const cand = new Uint8Array(w * h);
  const kind = new Uint8Array(w * h); // 1 saç, 2 tel, 3 alın
  for (let y = 0; y < h; y++) {
    const Y = y + by0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, X = x + bx0;
      const hair = Po[CLASSES.hair][i], face = Po[CLASSES.faceSkin][i], oth = Po[CLASSES.others][i];
      if (Mt[Y * W + X] >= HEAD_CTX_PERSON || face >= HAIR_MIN || Po[CLASSES.bodySkin][i] >= HAIR_MIN) head[Y * W + X] = 1;
      if (Y >= chin) continue;
      if (Y < browY && oth >= HAIR_MIN && oth >= hair) { hatPx++; continue; }
      if (hair >= HAIR_MIN && hair >= face && oth < HAIR_MIN) { cand[i] = 1; kind[i] = 1; continue; }
      if (Y < browY && Mt[Y * W + X] >= STRAND_MIN && Po[CLASSES.background][i] >= HAIR_MIN &&
          face < HAIR_MIN && oth < HAIR_MIN && Po[CLASSES.bodySkin][i] < HAIR_MIN) { cand[i] = 1; kind[i] = 2; continue; }
      if (Y < yF && X >= fx0 && X <= fx1 && face >= HAIR_MIN) { cand[i] = 1; kind[i] = 3; }
    }
  }
  if (hatPx >= HAT_MIN_FACE2 * fa2) return { ...res, reason: "hat", hatPx };
  // Teller yalnız saç sınıfının yakınında: kırpılmış tuvalde kişi maskesi dağ
  // ve gökyüzünde de 0.05'i aştı, teller saça bağlanıp bütün üst şeridi aldı (c1).
  {
    const { _testables: { maxField } } = require("./skinTone");
    const hairOnly = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (kind[i] === 1) hairOnly[i] = 1;
    const nearHair = maxField(hairOnly, w, h, Math.max(2, Math.round(STRAND_REACH_FACE * faceW)));
    for (let i = 0; i < w * h; i++) if (kind[i] === 2 && !nearHair[i]) { cand[i] = 0; kind[i] = 0; }
  }
  // Yüze bağlı bileşen: tohum yüz kutusunun üst yarısı çevresindeki adaylar.
  const conn = new Uint8Array(w * h);
  const stack = [];
  const sx0 = clampI(lo.box.x - 0.2 * faceW - bx0, 0, w - 1), sx1 = clampI(lo.box.x + lo.box.width + 0.2 * faceW - bx0, 0, w - 1);
  const sy0 = clampI(lo.box.y - 0.3 * faceW - by0, 0, h - 1), sy1 = clampI(browY - by0, 0, h - 1);
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
    const i = y * w + x;
    if (cand[i] && !conn[i]) { conn[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && cand[j] && !conn[j]) { conn[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (!conn[i]) continue;
    if (kind[i] === 1) res.hairPx++;
    else if (kind[i] === 2) res.strandPx++;
    else res.foreheadPx++;
  }
  if (res.hairPx + res.strandPx < MIN_HAIR_FACE2 * fa2) return { ...res, reason: "no-hair" };
  // Genişletme (chamfer yerine kare yarıçap yeterli: dolgu maskesi), çene ve
  // korunan alın şeridinin altına inmez (yanlardaki saç hariç: kaş altında
  // yalnız saç sınıfı pikselleri alınmıştı, genişleme yüze girmesin).
  const r = Math.max(2, Math.round(GROW_FACE * faceW));
  const { _testables: { maxField } } = require("./skinTone");
  const g = maxField(Float32Array.from(conn), w, h, r);
  for (let y = 0; y < h; y++) {
    const Y = y + by0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, X = x + bx0;
      if (!g[i] || Y >= chin) continue;
      // Yüz şeridinde (kaş üstü korunan alın dahil) yalnız asıl maske.
      if (Y >= yF && X >= fx0 && X <= fx1 && !conn[i]) continue;
      if (Po[CLASSES.faceSkin][i] >= HAIR_MIN && Y >= yF) continue;
      mask[Y * W + X] = 1;
    }
  }
  return res;
}

/**
 * KAFATASI (fill "skull"): saç yerine yalnız zemin kalınca model alnın üstündeki
 * kesiği kafanın tepesi sandı — kafayı aşağı indirdi (kısa saç c9: çene 0.32
 * yüz boyu aşağı) ya da sahneyi yeniden kadrajladı (c1, iki testte de). Kafa
 * dolgunun bağlamında bırakılır: LaMa alnı yukarı sürdürüp kel bir kafatası
 * çizer, kafanın gerçek tepesi korunur. Elle boyanmış kubbe denendi: düz renkli
 * ve alında yatay kenarlı, kask gibi duruyordu.
 */

/**
 * Taban görselinin saçı silinmiş kopyası (JPEG). Dönüş { buf|null, reason,
 * hairPx, foreheadPx, strandPx, maskPx, ms }. FAIL-SAFE: hata → buf null.
 */
async function eraseTemplateHair(buf, { debug = null, fill = ERASE_FILL } = {}) {
  const t0 = Date.now();
  try {
    const { faceLandmarks } = require("./faceQuality");
    const { data: rgb, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const jpeg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const lo = (await faceLandmarks(jpeg)) || (await faceLandmarks(jpeg, 0.1));
    if (!lo) return { buf: null, reason: "no-face", ms: Date.now() - t0 };
    const m = await templateHairMask(rgb, W, H, lo);
    let maskPx = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!m.mask[y * W + x]) continue;
      maskPx++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const stats = { hairPx: m.hairPx, foreheadPx: m.foreheadPx, strandPx: m.strandPx, maskPx };
    if (debug) Object.assign(debug, { mask: m.mask, W, H });
    if (m.reason || !maskPx) return { buf: null, reason: m.reason || "empty", ...stats, ms: Date.now() - t0 };
    // ÜST KENARA DAYALI SAÇ (2026-10-27, e25 c1 kırpılmış tuval): saç karenin
    // tepesine dayalıyken silinince kafanın üstünü çizecek yer kalmadı; model
    // bütün sahneyi aşağı kaydırıp yeniden kadrajladı (yüz kayması 0.64).
    const faceH = lo.pts[8].y - Math.min(...lo.pts.slice(17, 27).map((p) => p.y));
    if (y0 < TOP_HEADROOM_FACE * faceH) return { buf: null, reason: "top-edge", ...stats, ms: Date.now() - t0 };
    // Kare kırpım: maskenin çevresinde bağlam payı (dolgu dışarıdaki zemini sürdürür).
    const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const side = Math.min(W, H, Math.round(span * 1.6));
    const left = clampI((x0 + x1) / 2 - side / 2, 0, W - side);
    const top = clampI((y0 + y1) / 2 - side / 2, 0, H - side);
    const crop = Buffer.alloc(side * side * 3);
    const cm = new Uint8Array(side * side);
    const lm = new Uint8Array(side * side);
    for (let y = 0; y < side; y++) {
      rgb.copy(crop, y * side * 3, ((y + top) * W + left) * 3, ((y + top) * W + left + side) * 3);
      for (let x = 0; x < side; x++) {
        const g = (y + top) * W + x + left;
        cm[y * side + x] = m.mask[g];
        // "skull": kafa bağlamda kalır, LaMa alnı yukarı sürdürüp kel kafa çizer.
        lm[y * side + x] = m.mask[g] || (fill !== "skull" && m.head[g]) ? 1 : 0;
      }
    }
    const { fillCrop } = require("./lamaFill");
    const filled = await fillCrop(crop, side, lm);
    const out = Buffer.from(rgb);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      if (!cm[y * side + x]) continue;
      const g = (y + top) * W + x + left, i = y * side + x;
      for (let c = 0; c < 3; c++) out[g * 3 + c] = filled.rgb[i * 3 + c];
    }
    const res = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf: res, reason: null, ...stats, runs: filled.runs, ms: Date.now() - t0 };
  } catch (e) {
    console.error("Şablon saçı ön temizliği hata verdi (orijinal taban):", e.message || e);
    return { buf: null, reason: "error", ms: Date.now() - t0 };
  }
}

/* ----------------------------------------------------------------------------
 * ŞABLON SAÇI KIRPMA (2026-11-03, 80fc7ec4 c0/c2, 60d42504 c3; kullanıcı:
 * "saç üstü silüet olmaması lazım … direkt aynı şey yapılıyorsa bu riskin
 * alınmaması lazım").
 *
 * SORUN: model, kullanıcının kafasının DIŞINDA kalan şablon saçını yarı saydam
 * bırakıyor (silüet). Tam silme (eraseTemplateHair) kafatasını LaMa'ya tahmin
 * ettiriyor ve 60d42504 c3'te enseyi gökyüzüne çevirdi (kafanın arkası silindi).
 *
 * ÇÖZÜM: şablon saçının yalnız beklenen kullanıcı kafasının dışına TAŞAN kısmı
 * silinir. Beklenen kafa = base pozuna çevrilmiş ilk selfie'nin kafa maskesi
 * (ghostClean.headProfileOf), göz ortası + çene ucu benzerlik dönüşümüyle
 * base'e taşınır, TRIM_MARGIN_FACE kadar genişletilir. Kafanın içine, yüz
 * ovaline ve çevresine hiçbir koşulda dokunulmaz: kafatası tahmini yok, LaMa
 * yalnız arka planı sürdürür. Kullanıcının saçı şablonunkinden büyükse dış
 * saç kalmaz ve adım kendiliğinden atlanır. Şapkalı şablon ve kel/çok kısa saç
 * eraseTemplateHair'daki gibi atlanır.
 * -------------------------------------------------------------------------- */
// Beklenen kafanın genişletme payı (yüz genişliği): selfie maskesinin
// eksik bıraktığı tel ve poz farkı payı.
const TRIM_MARGIN_FACE = 0.08;
// Base yüz ovali çevresinde korunan şerit (yüz genişliği).
const TRIM_PROTECT_FACE = 0.04;
// Bundan az dış saç (yüz²) → silüet riski yok, dokunulmaz.
const TRIM_MIN_FACE2 = 0.01;
// Bundan küçük kopuk parçalar (yüz²) atılır (tek tel, gürültü).
const TRIM_MIN_PART_FACE2 = 0.002;
// Dış saç şablon saçının bundan fazlası ise selfie kafası güvenilmez sayılır
// (ör. maske yüzden ibaret kalmış): kafanın tamamı silinebilirdi, atlanır.
const TRIM_MAX_FRACTION = 0.85;

/**
 * Selfie kafa maskesini (srcN×srcN, göz ortası Es, çene Cs) benzerlik
 * dönüşümüyle hedef pencereye (w×h, sol üst köşesi (ox,oy) tam kare
 * koordinatında; hedef göz ortası Ed, çene Cd tam kare koordinatında) taşır.
 * Ters eşleme, en yakın komşu. SAF.
 */
function projectHead(src, srcN, Es, Cs, Ed, Cd, w, h, ox, oy) {
  const out = new Uint8Array(w * h);
  const vs = { x: Cs.x - Es.x, y: Cs.y - Es.y }, vd = { x: Cd.x - Ed.x, y: Cd.y - Ed.y };
  const ls = Math.hypot(vs.x, vs.y), ld = Math.hypot(vd.x, vd.y);
  if (!(ls > 1e-6) || !(ld > 1e-6)) return out;
  const sc = ls / ld;
  const ang = Math.atan2(vs.y, vs.x) - Math.atan2(vd.y, vd.x);
  const ca = Math.cos(ang) * sc, sa = Math.sin(ang) * sc;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = x + ox - Ed.x, qy = y + oy - Ed.y;
      const px = Math.round(Es.x + ca * qx - sa * qy), py = Math.round(Es.y + sa * qx + ca * qy);
      if (px >= 0 && py >= 0 && px < srcN && py < srcN && src[py * srcN + px]) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Alandan küçük bağlı bileşenleri siler (4 komşuluk). SAF, yerinde. */
function dropSmallParts(mask, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [];
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length < minArea) for (const i of comp) mask[i] = 0;
  }
  return mask;
}

/**
 * Kırpma maskesi (pencere w×h): şablon saçı ∖ (beklenen kafa ⊕ pay) ∖ (yüz
 * ovali ⊕ koruma), küçük parçalar atılmış. SAF. Dönüş { trim, headDil,
 * trimPx, hairPx }.
 */
function trimMask({ hair, head, oval, w, h, faceW }) {
  const { _testables: { maxField } } = require("./skinTone");
  const rM = Math.max(2, Math.round(TRIM_MARGIN_FACE * faceW));
  const rP = Math.max(1, Math.round(TRIM_PROTECT_FACE * faceW));
  const headDil = maxField(Float32Array.from(head), w, h, rM);
  const ovalDil = maxField(Float32Array.from(oval), w, h, rP);
  const trim = new Uint8Array(w * h);
  let hairPx = 0;
  for (let i = 0; i < w * h; i++) {
    if (!hair[i]) continue;
    hairPx++;
    if (headDil[i] || ovalDil[i]) continue;
    trim[i] = 1;
  }
  dropSmallParts(trim, w, h, Math.round(TRIM_MIN_PART_FACE2 * faceW * faceW));
  let trimPx = 0;
  for (let i = 0; i < w * h; i++) if (trim[i]) trimPx++;
  return { trim, headDil, trimPx, hairPx };
}

/**
 * Taban görselinin, kullanıcı kafasının dışına taşan şablon saçı silinmiş
 * kopyası (JPEG). selfieBuf: base pozuna çevrilmiş ilk selfie. Dönüş
 * { buf|null, reason, hairPx, trimPx, trimFrac, headPx, ms }. FAIL-SAFE:
 * hata → buf null (orijinal taban gider).
 */
async function trimTemplateHair(buf, selfieBuf, { debug = null } = {}) {
  const t0 = Date.now();
  try {
    if (!Buffer.isBuffer(selfieBuf)) return { buf: null, reason: "no-selfie", ms: Date.now() - t0 };
    const { faceLandmarks } = require("./faceQuality");
    const { headProfileOf } = require("./ghostClean");
    const { faceOval, inPolygon } = require("./headSurround");
    const { data: rgb, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const jpeg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const [lo, prof] = await Promise.all([
      (async () => (await faceLandmarks(jpeg)) || (await faceLandmarks(jpeg, 0.1)))(),
      headProfileOf(selfieBuf),
    ]);
    if (!lo) return { buf: null, reason: "no-face", ms: Date.now() - t0 };
    if (!prof || !prof.mask) return { buf: null, reason: "no-selfie-head", ms: Date.now() - t0 };
    const m = await templateHairMask(rgb, W, H, lo);
    if (m.reason) return { buf: null, reason: m.reason, hairPx: m.hairPx, ms: Date.now() - t0 };
    // Yalnız saç ve tel: korunan alın şeridi kullanıcı kafasının içinde kalır.
    let x0 = W, x1 = -1, y0 = H, y1 = -1, maskPx = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!m.mask[y * W + x]) continue;
      maskPx++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!maskPx) return { buf: null, reason: "empty", ms: Date.now() - t0 };
    const faceW = m.faceW;
    const pad = Math.round(0.15 * faceW);
    const bx0 = clampI(x0 - pad, 0, W - 1), bx1 = clampI(x1 + pad, 0, W - 1);
    const by0 = clampI(y0 - pad, 0, H - 1), by1 = clampI(y1 + pad, 0, H - 1);
    const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
    const hair = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hair[y * w + x] = m.mask[(y + by0) * W + x + bx0];
    // Beklenen kafa: selfie kafa maskesi base'in göz ortası ve çenesine oturtulur.
    const P = lo.pts;
    const avg = (a, b) => { let sx = 0, sy = 0; for (let k = a; k <= b; k++) { sx += P[k].x; sy += P[k].y; } return { x: sx / (b - a + 1), y: sy / (b - a + 1) }; };
    const el = avg(36, 41), er = avg(42, 47);
    const Ed = { x: (el.x + er.x) / 2, y: (el.y + er.y) / 2 }, Cd = { x: P[8].x, y: P[8].y };
    const head = projectHead(prof.mask, prof.n, prof.E, prof.C, Ed, Cd, w, h, bx0, by0);
    let headPx = 0;
    for (let i = 0; i < w * h; i++) if (head[i]) headPx++;
    if (headPx < 0.3 * faceW * faceW) return { buf: null, reason: "selfie-head-small", headPx, ms: Date.now() - t0 };
    // Base yüz ovali (koruma).
    const ov = faceOval(P);
    const oval = new Uint8Array(w * h);
    const oxs = ov.map((p) => p.x), oys = ov.map((p) => p.y);
    for (let Y = clampI(Math.min(...oys), by0, by1); Y <= clampI(Math.max(...oys), by0, by1); Y++) {
      for (let X = clampI(Math.min(...oxs), bx0, bx1); X <= clampI(Math.max(...oxs), bx0, bx1); X++) {
        if (inPolygon(ov, X, Y)) oval[(Y - by0) * w + X - bx0] = 1;
      }
    }
    const tm = trimMask({ hair, head, oval, w, h, faceW });
    const fa2 = faceW * faceW;
    const stats = { hairPx: tm.hairPx, trimPx: tm.trimPx, trimFrac: tm.hairPx ? tm.trimPx / tm.hairPx : 0, headPx };
    if (debug) Object.assign(debug, { trim: tm.trim, head, headDil: tm.headDil, hair, w, h, bx0, by0, W, H });
    if (tm.trimPx < TRIM_MIN_FACE2 * fa2) return { buf: null, reason: "inside-head", ...stats, ms: Date.now() - t0 };
    if (stats.trimFrac > TRIM_MAX_FRACTION) return { buf: null, reason: "head-unreliable", ...stats, ms: Date.now() - t0 };
    // LaMa deliği: dış saç ∪ beklenen kafa ∪ şablon saçının tamamı (saç bağlam
    // olursa LaMa onu dışarı sürdürür; bkz. ghostClean). Bileşime yalnız dış saç.
    let tx0 = w, tx1 = -1, ty0 = h, ty1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!tm.trim[y * w + x]) continue;
      if (x < tx0) tx0 = x; if (x > tx1) tx1 = x; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y;
    }
    const span = Math.max(tx1 - tx0 + 1, ty1 - ty0 + 1, Math.round(1.2 * faceW));
    const side = Math.min(W, H, Math.round(span * 1.8));
    const left = clampI(bx0 + (tx0 + tx1) / 2 - side / 2, 0, W - side);
    const top = clampI(by0 + (ty0 + ty1) / 2 - side / 2, 0, H - side);
    const crop = Buffer.alloc(side * side * 3);
    const cm = new Uint8Array(side * side);
    const lm = new Uint8Array(side * side);
    for (let y = 0; y < side; y++) {
      rgb.copy(crop, y * side * 3, ((y + top) * W + left) * 3, ((y + top) * W + left + side) * 3);
      for (let x = 0; x < side; x++) {
        const X = x + left - bx0, Y = y + top - by0;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const i = Y * w + X;
        cm[y * side + x] = tm.trim[i];
        lm[y * side + x] = tm.trim[i] || tm.headDil[i] || hair[i] ? 1 : 0;
      }
    }
    const { fillCrop } = require("./lamaFill");
    const filled = await fillCrop(crop, side, lm);
    const out = Buffer.from(rgb);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      if (!cm[y * side + x]) continue;
      const g = (y + top) * W + x + left, i = y * side + x;
      for (let c = 0; c < 3; c++) out[g * 3 + c] = filled.rgb[i * 3 + c];
    }
    const res = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    return { buf: res, reason: null, ...stats, runs: filled.runs, ms: Date.now() - t0 };
  } catch (e) {
    console.error("Şablon saçı kırpma hata verdi (orijinal taban):", e.message || e);
    return { buf: null, reason: "error", ms: Date.now() - t0 };
  }
}

module.exports = { eraseTemplateHair, trimTemplateHair, _testables: { templateHairMask, projectHead, trimMask, dropSmallParts, TRIM_MARGIN_FACE, TRIM_PROTECT_FACE, TRIM_MIN_FACE2 } };
