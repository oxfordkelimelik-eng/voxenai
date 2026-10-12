// KAFA ÇEVRESİ (2026-10-11, iş d44b63e8, kullanıcı: "kafanın üst kısmındaki
// silüetlenme, renklenme, küçültmeden dolayı oynama gibi problemleri kesin
// olarak çözmeliyiz").
//
// SORUN: arka plan geri yüklemesi şablon kafasının çevresindeki elipsi
// (yüz kutusunun 2.6 x 3 katı) hiç şablondan almıyordu; o elipste modelin
// kendi çizdiği arka plan kalıyordu (ton farkı = kafa çevresinde hale, c3/c6;
// kayık derz = 3b16bf69 c7). Sonraki saçak temizliği bu 100-160 bin piksellik
// bölgeyi AI ile yeniden boyuyor, AI'nin kişi çizdiği yerlere doku yaması
// koyuyordu; kare dilatasyonlu koruma bantları ve "kaşın üstü AI, altı model"
// kuralı saçın arkasında basamaklı/tırtıklı kenarlar bıraktı (c2, c4, c5),
// karanlık siyah-beyaz karede saçı sildi (c4).
//
// ÇÖZÜM: şablondan GERÇEKTEN alınamayan yer yalnızca şablon kafasının kendi
// silüetidir (saç, yüz, aksesuar — biraz genişletilmiş). Geri yükleme elips
// yerine bu silüeti dışarıda bırakır (templateHeadMask); geriye kalan şerit =
// şablon kafası ∖ yeni kafa (+ hayalet saç, saçak telleri, kafa küçültmenin
// açtığı delik). Bu şerit tek bir dolguyla doldurulur; dışı şablonun gerçek
// arka planı olduğu için çizgiler doğru yerden sürer.
//
// DOLGU YEREL MODELLE (2026-10-12, e0eb8dd5): OpenAI maskeli düzenlemesi
// kırpımın tamamını yeniden çiziyordu — renk/doku kayması kareyi reddettirdi
// (c4, c8 küçültülemedi; c2/c5/c6 temizlenemedi), kabul edilen karelerde de
// eski kafanın sınırında açık yay (c1), saçın boyanması (c7), kişi çizilen
// yerde bulanık blok kaldı. LaMa (bkz. lamaFill.js) yalnız maskeyi doldurur,
// kişi çizmez, maliyeti yok; reddetme kapısı gerekmez.

const sharp = require("sharp");

// Şablon kafası silüeti: çok sınıflı modelde saç+yüz derisi+aksesuar ya da
// (kaşların üstünde) kişi maskesinin en soluk hâli. Soluk teller maskede
// görünmez — kaş üstünde genişletme daha büyük.
const TPL_HEAD_CLASS_MIN = 0.3;
const TPL_STRAND_MIN = 0.05;
const TPL_GROW_FACE = 0.06; // yüz genişliğine oranla
const TPL_GROW_TOP_FACE = 0.1;
// Yeni kafanın dolu gövdesi (açma yarıçapı), yüz genişliğine oranla.
const CORE_OPEN_FACE = 0.08;
const FRINGE_RING_FACE = 0.25;
const SOFT_EDGE_FACE = 0.012;
const SOFT_EDGE_OUT_FACE = 0.04;
// Delik yoksa hayalet+saçak bu kadardan (yüz alanına oranla) azsa AI'ye
// gidilmez: birkaç yüz piksel kafanın kendi yumuşak saç kenarıdır, dolgu
// yalnızca risk getirir (d44b63e8 c2/c3/c6: 300-1500 px, kenar temizdi).
const MIN_DEFECT_FACE2 = 0.05;
// İNCE HAYALET TELLER (2026-10-11, f3539078 c0): şablon kişisinin kabarık
// saçından kalan gri teller incedir, piksel sayısı eşiğin altında kaldı
// (hayalet=656) ve kare "clean" sayıldı. Kafanın kendi yumuşak saç kenarı
// dolu gövdeye yapışıktır; hayalet teller ondan uzağa uzanır. Dolu gövdeden
// bu kadar (yüz genişliğine oranla) uzaktaki hayalet pikseller sayıca az da
// olsa dolguyu tetikler.
const GHOST_FAR_FACE = 0.08;
const GHOST_FAR_MIN_FACE2 = 0.004;
// Küçültme deliğinde yeni kafanın korunan yumuşak kenarı, yüz genişliğine oranla.
const HEAD_SOFT_EDGE_FACE = 0.03;
// Yerel dolgu modeline kafa da maskeli verilir (saçı deliğe uzatmasın):
// kafa bileşeninin bu kadar (yüz genişliğine oranla) çevresindeki korunan
// pikseller.
const LAMA_HEAD_REACH_FACE = 0.1;

/**
 * Chamfer (3-4) uzaklık dönüşümü: her piksel için en yakın mask=1 pikseline
 * yaklaşık Öklid uzaklığı (piksel). mask=1 olan yerde 0. SAF.
 */
function chamfer(mask, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

async function cropRgb(rgb, W, H, left, top, width, height) {
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left, top, width, height }).raw().toBuffer();
}

/**
 * Şablon kafasının (genişletilmiş) silüeti, tam kare Uint8Array(W*H).
 * t: şablon RGB raw (çıktı boyutunda), Mt: şablon kişi olasılığı, box: şablon
 * yüz kutusu. Sınıflandırma başarısızsa yalnız kişi maskesiyle.
 */
async function templateHeadMask(t, Mt, W, H, box) {
  const fw = box.width;
  const fh = box.height;
  const cx = box.x + fw / 2;
  const x0 = clampI(cx - 2.2 * fw, 0, W - 1);
  const x1 = clampI(cx + 2.2 * fw, 0, W - 1);
  const y0 = clampI(box.y - 2.0 * fh, 0, H - 1);
  const y1 = clampI(box.y + 1.25 * fh, 0, H - 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(W * H);
  if (w < 8 || h < 8) return out;
  const topY = box.y + 0.25 * fh; // kaş hizası civarı (şablonda nokta yok)
  let headP = null;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const P = await classProbs(await cropRgb(t, W, H, x0, y0, w, h), w, h);
    // Kafa sınıfı baskın olmalı: zayıf olasılık eşiği eli/saati de alıyordu
    // (d44b63e8 c6 şablonu gözlüğünü tutan el).
    headP = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const hp = P[CLASSES.hair][i] + P[CLASSES.faceSkin][i] + P[CLASSES.others][i];
      headP[i] = hp >= 0.5 || hp > P[CLASSES.bodySkin][i] + P[CLASSES.clothes][i] ? hp : 0;
    }
  } catch (e) {
    console.error("Şablon kafa silüeti: sınıflandırma başarısız (yalnız kişi maskesi):", e.message || e);
  }
  const base = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = Mt[(y + y0) * W + x + x0];
      const above = y + y0 < topY;
      if (headP ? headP[i] >= TPL_HEAD_CLASS_MIN || (above && m >= TPL_STRAND_MIN) : m >= TPL_STRAND_MIN) base[i] = 1;
    }
  }
  // Yalnız yüze bağlı bileşen (c4: tavan ışığı ve arkadaki nesne "aksesuar"
  // sınıfına girmişti).
  const conn = new Uint8Array(w * h);
  const stack = [];
  for (let y = Math.max(0, Math.round(box.y - y0)); y < Math.min(h, Math.round(box.y + fh - y0)); y++) {
    for (let x = Math.max(0, Math.round(box.x - x0)); x < Math.min(w, Math.round(box.x + fw - x0)); x++) {
      const i = y * w + x;
      if (base[i] && !conn[i]) { conn[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && base[j] && !conn[j]) { conn[j] = 1; stack.push(j); }
    }
  }
  const d = chamfer(conn, w, h);
  const r1 = Math.max(4, TPL_GROW_FACE * fw);
  const r2 = Math.max(6, TPL_GROW_TOP_FACE * fw);
  for (let y = 0; y < h; y++) {
    const r = y + y0 < topY ? r2 : r1;
    for (let x = 0; x < w; x++) if (d[y * w + x] <= r) out[(y + y0) * W + x + x0] = 1;
  }
  return out;
}

/**
 * SAYDAM HAYALET SAÇ (2026-10-11, f3539078 c0): şablon kişisinin kabarık
 * saçından kalan gri, yarı saydam teller çok sınıflı modelde "saç" çıktı;
 * kafanın parçası sayıldı, dolgu maskesine hiç girmedi. Ayırt edici olan
 * parlaklık: bu teller kullanıcının dolu saçıyla arka plan arasında, arka
 * plana daha yakın (opaklık < SHEER_ALPHA_MAX). Saçın içindeki ışık
 * yansıması da öyle olabilir — bu yüzden yalnızca dışarıdaki arka plana bu
 * tür piksellerden geçerek ulaşılabilenler alınır. Saç ile arka plan
 * arasında yeterli fark yoksa (sarı saç açık zeminde) hiçbir şey alınmaz.
 * Dönüş: kesit (w x hc) Uint8Array. SAF.
 */
const SHEER_ALPHA_MAX = 0.5;
const SHEER_MIN_CONTRAST = 50;
// Kafanın kendi saç kenarı da yarı saydamdır ama dolu saça yapışıktır
// (f3539078 c1/c3/c5/c7: 500-700 px ince şerit, kenar temizdi). TESPİT:
// dolu saçtan bu kadar (yüz genişliğine oranla) uzakta en az SHEER_MIN_FACE2
// kadar yarı saydam saç varsa hayalet var demektir; o zaman MASKE dışarıya
// bağlı yarı saydam saçın tamamıdır (dolu saça yapışık gri pus dahil — yoksa
// saçın üstünde gri çizgi kalır). Tespit yoksa hiçbir şey alınmaz.
const SHEER_EDGE_FACE = 0.04;
const SHEER_MIN_FACE2 = 0.003;
const SHEER_GROW_FACE = 0.1;
function sheerHairMask(rgb, W, Mo, Po, CLASSES, { w, hc, bx0, by0, browY, faceW }) {
  const out = new Uint8Array(w * hc);
  const yb = Math.min(hc, Math.round(browY) - by0);
  if (yb < 4) return out;
  const L = new Float32Array(w * yb);
  const hairL = [];
  const bgL = [];
  for (let y = 0; y < yb; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = ((y + by0) * W + x + bx0) * 3;
      L[i] = 0.299 * rgb[g] + 0.587 * rgb[g + 1] + 0.114 * rgb[g + 2];
      const m = Mo[(y + by0) * W + x + bx0];
      if (Po[CLASSES.hair][i] >= 0.8 && m >= 0.8) hairL.push(L[i]);
      else if (Po[CLASSES.background][i] >= 0.8 && m < 0.05) bgL.push(L[i]);
    }
  }
  if (hairL.length < 50 || bgL.length < 50) return out;
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const Lh = med(hairL);
  const Lb = med(bgL);
  if (Math.abs(Lb - Lh) < SHEER_MIN_CONTRAST) return out;
  const cand = new Uint8Array(w * yb);
  const open = new Uint8Array(w * yb);
  const dense = new Uint8Array(w * yb);
  for (let i = 0; i < w * yb; i++) {
    const hair = Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i];
    const alpha = (L[i] - Lb) / (Lh - Lb);
    if (hair && alpha < SHEER_ALPHA_MAX) cand[i] = 1;
    else if (hair) dense[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    const head = Po[CLASSES.hair][i] + Po[CLASSES.faceSkin][i] + Po[CLASSES.others][i] >= 0.5;
    if (!head && Mo[(y + by0) * W + x + bx0] < 0.5) open[i] = 1;
  }
  const dDense = chamfer(dense, w, yb);
  const edgeR = Math.max(2, SHEER_EDGE_FACE * faceW);
  // Dışarıdan (arka plan) aday piksellere doğru taşma.
  const stack = [];
  for (let i = 0; i < w * yb; i++) if (open[i]) stack.push(i);
  const seen = new Uint8Array(w * yb);
  for (const i of stack) seen[i] = 1;
  let farPx = 0;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yb - 1 ? i + w : -1]) {
      if (j >= 0 && !seen[j] && cand[j]) { seen[j] = 1; out[j] = 1; if (dDense[j] > edgeR) farPx++; stack.push(j); }
    }
  }
  if (farPx < SHEER_MIN_FACE2 * faceW * faceW) out.fill(0);
  return out;
}

/**
 * Kafa çevresi şeridinin dolgusunu hazırlar. buf: arka planı geri
 * yüklenmiş (ve varsa kafası ölçeklenmiş) kare; extraHole: kafa küçültmenin
 * açtığı delik (Uint8Array W*H); newHead: küçültülmüş kafanın kendisi
 * (Uint8Array W*H, headScale headMask) — delikte yalnız o korunur.
 * Dönüş { applied, reason, bandPx, ghostPx, fringePx, inpaint{rect,job,base} };
 * dolgu lamaFill.finishInpaintLama(job, base) ile tamamlanır.
 */
async function prepareHeadSurroundFill(buf, { extraHole = null, newHead = null } = {}) {
  const { personMask, _rawRgb: rawRgb, _prepareInpaint: prepareInpaint } = require("./headScale");
  const { faceLandmarks } = require("./faceQuality");
  const o = await rawRgb(buf);
  const { W, H } = o;
  const lo = (await faceLandmarks(buf)) || (await faceLandmarks(buf, 0.1));
  if (!lo) return { applied: false, reason: "no-face-output" };
  const Mo = await personMask(o.data, W, H);
  const P = lo.pts;
  const faceW = Math.max(lo.box.width, Math.hypot(P[0].x - P[16].x, P[0].y - P[16].y));
  const chin = P[8].y;
  const browY = Math.min(...P.slice(17, 27).map((p) => p.y));
  const cx = P.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17;
  const bx0 = clampI(cx - 2.2 * faceW, 0, W - 1);
  const bx1 = clampI(cx + 2.2 * faceW, 0, W - 1);
  const by0 = clampI(lo.box.y - 2.2 * faceW, 0, H - 1);
  const by1 = clampI(chin + 0.6 * faceW, 0, H - 1);
  const w = bx1 - bx0 + 1;
  const h = by1 - by0 + 1;
  if (w < 16 || h < 16) return { applied: false, reason: "tiny" };
  const G = (x, y) => (y + by0) * W + x + bx0;

  // Yeni kafa: kişi maskesi YA DA çok sınıflı modelde kafa sınıfı (karanlık
  // siyah-beyaz karede koyu saç kişi maskesinden düşüyordu — d44b63e8 c4).
  // Hayalet saç (kaş üstü, kişi maskesinde var, çok sınıflı modelde arka
  // plan) kafaya katılmaz (bkz. hafıza ghost-hair-is-background-class).
  // Sınıflandırma çeneye kadar olan kesitte (kesit uzayınca hayalet "arka
  // plan" sayılmıyordu).
  const hc = Math.max(16, Math.min(h, Math.round(chin) - by0 + 1));
  const core = new Uint8Array(w * h);
  const ghost = new Uint8Array(w * h);
  // Kullanıcının kendi dolu saçı (saç sınıfı, saydam hayalet değil).
  const hairDense = new Uint8Array(w * h);
  let classified = false;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    const Po = await classProbs(await cropRgb(o.data, W, H, bx0, by0, w, hc), w, hc);
    const sheer = sheerHairMask(o.data, W, Mo, Po, CLASSES, { w, hc, bx0, by0, browY, faceW });
    for (let y = 0; y < hc; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = Mo[G(x, y)];
        const head = Po[CLASSES.hair][i] + Po[CLASSES.faceSkin][i] + Po[CLASSES.others][i] >= 0.5;
        if ((!head && y + by0 < browY && m >= 0.15 && Po[CLASSES.background][i] >= 0.5) || sheer[i]) {
          ghost[i] = sheer[i] ? 2 : 1;
          continue;
        }
        if (head || m >= 0.5) core[i] = 1;
        if (Po[CLASSES.hair][i] >= 0.5 && Po[CLASSES.hair][i] > Po[CLASSES.faceSkin][i]) hairDense[i] = 1;
      }
    }
    classified = true;
  } catch (e) {
    console.error("Kafa çevresi: sınıflandırma başarısız (yalnız kişi maskesi):", e.message || e);
  }
  for (let y = classified ? hc : 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (Mo[G(x, y)] >= 0.5) core[y * w + x] = 1;
  }

  // YALNIZ KAFA (2026-10-12, e0eb8dd5 c2/c8): kişi maskesi kafanın yanındaki
  // koyu nesneyi (şemsiye) ve arkadaki insanları da "kişi" görüyor; onlar
  // dolu gövdeye, çevrelerindeki soluk pikseller saçak/hayalete girip
  // siliniyordu. Çene hizasının üstünde kafa = yüzden başlayan bileşen;
  // ona bağlı olmayan dolu pikseller korunur ama kafa sayılmaz.
  const yChin = Math.min(h - 1, Math.floor(chin - by0));
  const headComp = new Uint8Array(w * h);
  {
    const sx = clampI(cx - bx0, 0, w - 1);
    const sy = clampI((browY + chin) / 2 - by0, 0, yChin);
    if (core[sy * w + sx]) {
      headComp[sy * w + sx] = 1;
      const stack = [sy * w + sx];
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        const y = (i - x) / w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < yChin ? i + w : -1]) {
          if (j >= 0 && core[j] && !headComp[j]) { headComp[j] = 1; stack.push(j); }
        }
      }
    } else {
      for (let y = 0; y <= yChin; y++) for (let x = 0; x < w; x++) headComp[y * w + x] = core[y * w + x];
    }
  }
  const otherCore = new Uint8Array(w * h);
  for (let y = 0; y <= yChin; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (core[i] && !headComp[i]) { otherCore[i] = 1; core[i] = 0; }
    }
  }
  // Hayalet yalnızca kafaya bağlıysa (2 px boşluk payıyla): kafadan kopuk
  // "arka plan sınıfı kişi" pikselleri başka bir nesnedir.
  const dHead = chamfer(headComp, w, h);
  {
    const dG = chamfer(ghost, w, h);
    const reach = new Uint8Array(w * h);
    const stack = [];
    for (let i = 0; i < w * h; i++) if (ghost[i] && dHead[i] <= 2) { reach[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !reach[j] && dG[j] <= 2) { reach[j] = 1; stack.push(j); }
      }
    }
    for (let i = 0; i < w * h; i++) if (ghost[i] && !reach[i]) ghost[i] = 0;
  }
  let ghostPx = 0;
  let sheerPx = 0;
  for (let i = 0; i < w * h; i++) {
    if (!ghost[i]) continue;
    ghostPx++;
    if (ghost[i] === 2) sheerPx++;
  }
  // Dolu gövde: açma (ince teller ayrılır). Chamfer ile yuvarlak — kare
  // genişletme basamaklı kenar bırakıyordu.
  const rOpen = Math.max(2, CORE_OPEN_FACE * faceW);
  const notCore = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) notCore[i] = core[i] ? 0 : 1;
  const dIn = chamfer(notCore, w, h);
  const eroded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) eroded[i] = dIn[i] > rOpen ? 1 : 0;
  const dEr = chamfer(eroded, w, h);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = core[i] && dEr[i] <= rOpen + 1 ? 1 : 0;
  // Korunan: dolu gövde + kaşların altında kişinin yumuşak kenarı (3b16bf69
  // c7: AI başın arkasına saç şeridi ekledi, kazak kenarını tırtıklı boyadı)
  // + kafaya bağlı olmayan dolu pikseller (şemsiye, arkadaki insanlar).
  // KULLANICININ SAÇI KORUNUR (2026-10-12, e0eb8dd5 c7, kullanıcı: "saçı
  // boyamışsın"): açma, dolu gövdeden 2x0.08 yüz genişliğinden ince her
  // saç tutamını (perçem, kabarık uçlar) gövdeden ayırıyordu; onlar "saçak"
  // sayılıp yeniden boyanınca saçın üst kenarı düz, boyanmış göründü. Kafaya
  // bağlı dolu saç pikselleri (saç sınıfı, saydam hayalet değil) korunur;
  // saçak yalnızca saç olmayan soluk kişi pikselleridir.
  // Küçültme deliğinin içi (doku dolgusu, eski kafanın kalıntısı) yalnız
  // yeni kafa (küçültmenin katman alfası, newHead) ve kaş altında onun
  // yumuşak kenarı kadar korunur; geri kalanı baştan dolar. Delikteki doku
  // dolgusunu sınıflandırıcı saç/kişi sanabiliyor (c4 denemesi: saçın
  // üstünde açık leke korunup kaldı).
  const softR = Math.max(2, HEAD_SOFT_EDGE_FACE * faceW);
  const prot = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = G(x, y);
      const inHole = !!(extraHole && extraHole[g]);
      const soft = y + by0 >= browY && Mo[g] >= 0.25 && (!inHole || dHead[i] <= softR);
      const headPx = inHole && newHead ? newHead[g] === 1 : solid[i] || (headComp[i] && hairDense[i]);
      if (headPx || (otherCore[i] && !inHole) || soft) prot[i] = 1;
    }
  }
  const dProt = chamfer(prot, w, h);
  const dSolid = chamfer(solid, w, h);
  const ringR = Math.max(4, FRINGE_RING_FACE * faceW);

  const band = new Uint8Array(w * h);
  let bandPx = 0;
  let fringePx = 0;
  let holePx = 0;
  let farGhostPx = 0;
  const farR = GHOST_FAR_FACE * faceW;
  // Saydam hayalet varsa en dıştaki ince teller (kişi maskesi bile görmüyor)
  // kümenin hemen dışında kalır: kaş üstünde hayaletin çevresi de şeride girer.
  const dGhost = sheerPx ? chamfer(ghost, w, h) : null;
  const growR = SHEER_GROW_FACE * faceW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dProt[i] <= 1.5) continue;
      const g = G(x, y);
      const fringe = y + by0 < chin && Mo[g] >= 0.15 && dSolid[i] <= ringR;
      // YALNIZ KUSUR (2026-10-11, d44b63e8 yerel deneme): şablon kafasının
      // bütün silüeti AI'ye verilince model maskeyi farklı tonda/bulanıklıkta
      // doldurdu, şablon saçı şeklinde koyu yay kaldı (c6) — oysa geri
      // yüklemeden sonra modelin orada çizdiği arka plan temizdi. AI yalnız
      // hayalet saça, saçak tellerine ve küçültmenin açtığı deliğe girer.
      const nearSheer = dGhost && y + by0 < browY && dGhost[i] <= growR;
      if (ghost[i] || fringe || nearSheer || (extraHole && extraHole[g])) {
        band[i] = 1;
        bandPx++;
        if (fringe) fringePx++;
        if (extraHole && extraHole[g]) holePx++;
        if (ghost[i] && dSolid[i] > farR) farGhostPx++;
      }
    }
  }
  const farGhost = sheerPx > 0 || farGhostPx >= GHOST_FAR_MIN_FACE2 * faceW * faceW;
  if (!holePx && !farGhost && bandPx < MIN_DEFECT_FACE2 * faceW * faceW) return { applied: false, reason: "clean", bandPx, ghostPx, fringePx, farGhostPx, sheerPx, faceW };

  // Yumuşak kenar: dolgu şeridin dışına (şablon arka planına) azalarak
  // taşar; korunan kafaya hiç girmez. DIŞ GEÇİŞ GENİŞ (2026-10-12, e0eb8dd5
  // c1/c7): şeridin dış sınırı eski kafanın silüetini izliyor; dolgu tonu
  // dışarıdan azıcık farklıysa 2-3 px'lik geçişte eski kafanın şekli çizgi
  // olarak görünüyordu (c1 açık yay, c7 çenenin yanında koyu tel). Yerel
  // model maske dışıyla tutarlı olduğu için geniş geçiş güvenli.
  const rs = Math.max(2, SOFT_EDGE_FACE * faceW);
  const rsOut = Math.max(rs, SOFT_EDGE_OUT_FACE * faceW);
  const dBand = chamfer(band, w, h);
  const hole = new Uint8Array(W * H);
  const banned = new Uint8Array(W * H);
  const wgt = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = G(x, y);
      if (dProt[i] <= 1.5) { banned[g] = 1; continue; }
      if (dBand[i] > rsOut) continue;
      hole[g] = 1;
      const edgeIn = Math.min(1, (dProt[i] - 1.5) / rs); // kafaya doğru dar ve yumuşak
      const t = dBand[i] / (rsOut + 1);
      wgt[g] = (1 - t * t * (3 - 2 * t)) * edgeIn;
    }
  }
  // YEREL DOLGU (2026-10-12, e0eb8dd5, kullanıcı: "kesin çözüm"): şerit
  // OpenAI yerine LaMa ile dolar (bkz. lamaFill.js). Kafa (çene hizasına
  // kadar, yumuşak kenarıyla) modele bağlam olarak verilmez — verilince
  // saçı deliğe doğru gri pus olarak uzatıyordu (c4 denemesi).
  const reachR = LAMA_HEAD_REACH_FACE * faceW;
  const head = new Uint8Array(W * H);
  for (let y = 0; y <= yChin; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (prot[i] && !otherCore[i] && dHead[i] <= reachR) head[G(x, y)] = 1;
    }
  }
  const job = prepareInpaint(o.data, o.data, W, H, hole, banned, wgt, head);
  job.out = null;
  return {
    applied: true, bandPx, holePx, ghostPx, fringePx, farGhostPx, sheerPx, faceW,
    inpaint: { rect: { left: job.left, top: job.top, side: job.side }, job, base: buf },
  };
}

module.exports = { templateHeadMask, prepareHeadSurroundFill, chamfer, sheerHairMask };
