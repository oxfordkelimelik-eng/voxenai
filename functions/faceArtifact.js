/**
 * YÜZ ARTEFAKT ÖLÇÜMÜ — yüzdeki lokal "yama/leke" kusurunu ölçer.
 *
 * ŞU AN ELEMİYOR. YALNIZCA LOGLUYOR. (2026-09-13)
 *
 * SORUN (kullanıcı bildirimi, gerçek TESLİM EDİLMİŞ kareler): "yüzde boyalar
 * çıkmış, yüz içerisinde bu tarz lekeler kabul edilemez". İncelenen kareler:
 *   • 23eb1a78 elegance_2 — sağ kaşın üstünde dikdörtgen gri-beyaz yama
 *   • f0bc4d5c elegance_5 — sol kaşın üstünde beyaz dikey çizgi
 *   • f0bc4d5c elegance_3 — alında leke + pantolonda büyük beyaz yama
 *
 * BU KUSURU HİÇBİR MEVCUT KAPI GÖRMÜYOR, ve bu bir yanlış-RED değil
 * yanlış-KABUL: kusurlu kare kullanıcıya teslim ediliyor. Diğer üç şikâyetin
 * (limb-ghost, vision-hair, gaze) aksine burada kullanıcı kusuru doğrudan
 * görüyor — iş etkisi açısından en pahalısı bu.
 *
 * MEVCUT KAPILAR NEDEN GÖRMÜYOR:
 *   • vision-exposure yalnızca TÜM YÜZÜN patlamasını arıyor ("face blown out,
 *     detail lost to white"); birkaç yüz pikselllik lokal yamayı görmüyor.
 *   • faceShine parlama/yağlılık için — o kusur yumuşak ve geniş, bu ise
 *     küçük ve keskin kenarlı. Farklı imza, farklı ölçüm.
 *
 * ÖLÇÜLEN İMZA: yama, yüz tenine göre HEM BELİRGİN AÇIK HEM DOYGUNLUĞU
 * DÜŞÜK bir bölge. Gerçek piksel verisi (23eb1a78_2, alın):
 *     normal ten : 180,124,99   (sıcak — R >> B)
 *     yama       : 226,225,230  (nötr gri — R ≈ G ≈ B)
 * Doğal ışık/gölge teni AÇIKLAŞTIRIR ama KROMAYI KORUR; bu yamalarda kroma
 * çöküyor. Ayrım bu yüzden krom-tabanlı.
 *
 * ================== NEDEN HENÜZ ELEMİYOR (ÖNEMLİ) ==================
 *
 * Bu kapı yazılırken 20 gerçek kare üzerinde ölçüldü (3 kullanıcı-şikâyetli,
 * 17 temiz). SONUÇ: iki sınıf AYRILMADI —
 *     şikâyetli kareler : %0.062  %0.153  %0.172
 *     temiz kareler     : %0.000 ... %0.312  %0.356
 * Yani en kötü temiz kare, en kötü şikâyetli kareden DAHA YÜKSEK ölçüldü.
 * Bu eşikle eleseydik üç kusurlu kareyi yakalarken en az iki temiz kareyi de
 * atardık — düzeltmeye çalıştığımız yanlış-red sorununun aynısını üretirdik.
 *
 * Bu yüzden dosyadaki yerleşik usul izleniyor (KONUM KAPISI/dx ve UZUV TEN
 * ÖLÇÜMÜ ile birebir aynı yol): ÖNCE ÖLÇ VE LOGLA, gerçek dağılım birikince
 * eşiği veriden kalibre et, ANCAK O ZAMAN bağlayıcı yap. Geçen kareler de
 * loglanıyor — eşik ancak iki sınıfın gerçek dağılımı görülerek seçilebilir.
 *
 * Bağlayıcı yapmadan önce cevaplanması gereken soru: bu ölçüm mü zayıf, yoksa
 * imza mı farklı? Toplanan logda şikâyetli kareler tutarlı biçimde yüksek
 * çıkmıyorsa ölçüm değiştirilmeli (örn. kenar keskinliği eklenmeli — doğal
 * gölgenin kenarı yumuşak, yamanınki dikdörtgen ve keskin).
 */

const sharp = require("sharp");

// Yamanın tenden ne kadar AÇIK olması gerektiği (L*, 0-100 ölçeğinde).
// Gerçek veriden: yama L*~89, komşu ten L*~57 — fark ~32. Eşik düşük
// tutuluyor çünkü bu ölçüm henüz elemiyor; amaç dağılımı görmek.
const PATCH_MIN_L_ABOVE_SKIN = 12;

// Yamanın kroması, ten kromasının bu oranından DÜŞÜK olmalı. Doğal ışık
// kromayı korur, yama çökertir — ayrımın taşıyıcı sinyali bu.
const PATCH_MAX_CHROMA_RATIO = 0.6;

// Yüz kutusunun dış kenarındaki bu oran YOK SAYILIR. Dedektör dikdörtgen
// döndürüyor ve köşelerde saç/yaka/arka plan kalıyor; bu pay olmadan
// ölçülen "en büyük leke" her karede kutunun kenarındaki arka plan çıkıyor
// (ölçüldü: 20 karenin hepsinde konum x=0.00 ya da x>0.83).
const FACE_BORDER_MARGIN = 0.12;

// Ten medyanının okunduğu merkezi yanak şeridi (kutuya göre oran).
// Alın DIŞARIDA bırakıldı: yamaların çoğu orada ve referansı kirletirdi.
const SKIN_STRIP = { x0: 0.25, x1: 0.75, y0: 0.45, y1: 0.75 };

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB -> CIELAB. faceQuality.js'teki eşiyle aynı dönüşüm. */
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function medianOf(values) {
  if (!values.length) return null;
  const v = [...values].sort((p, q) => p - q);
  return v[Math.floor(v.length / 2)];
}

/**
 * Maskedeki en büyük bağlı bileşeni (4-komşuluk) bulur. SAF fonksiyon.
 * Döner: { size, box:{x0,y0,w,h}, fill } | null
 *
 * fill = bileşenin kendi sınırlayıcı kutusunu doldurma oranı. Dikdörtgen bir
 * yamada 1'e yakın, dağınık gürültüde düşük — ileride eşik kalibre edilirken
 * "şekil" ayrımı için gerekecek.
 */
function largestComponent(mask, w, h) {
  const seen = new Uint8Array(w * h);
  let best = null;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    while (stack.length) {
      const c = stack.pop();
      n++;
      const cx = c % w, cy = (c - cx) / w;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
      if (cx > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (cx < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cy > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
      if (cy < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
    }
    if (!best || n > best.size) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      best = { size: n, box: { x0, y0, w: bw, h: bh }, fill: n / (bw * bh) };
    }
  }
  return best;
}

/**
 * Yüz kutusu içindeki en büyük "yama" lekesini ölçer.
 *
 * ÇAĞIRAN TARAF BU SONUCA GÖRE ELEMEZ (henüz) — yalnızca loglar.
 *
 * @param {Buffer} buf çıktı karesi
 * @param {{x:number,y:number,width:number,height:number}} faceBox detectMainFace'ten
 * @returns {Promise<{ok:true, fraction:number, px:number, fill:number|null,
 *                     at:{x:number,y:number}|null, skinL:number, skinChroma:number}
 *                  | {ok:false, reason:string}>}
 */
async function measureFacePatch(buf, faceBox) {
  try {
    if (!Buffer.isBuffer(buf) || !faceBox) return { ok: false, reason: "insufficient-input" };
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, C = info.channels;
    if (!W || !H) return { ok: false, reason: "no-pixels" };

    const bx = Math.max(0, Math.round(faceBox.x));
    const by = Math.max(0, Math.round(faceBox.y));
    const bw = Math.min(W - bx, Math.round(faceBox.width));
    const bh = Math.min(H - by, Math.round(faceBox.height));
    // Ölçüm için anlamlı en küçük yüz: altında bağlı bileşen analizi gürültü.
    if (bw < 40 || bh < 40) return { ok: false, reason: "face-too-small" };

    const lab = new Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((by + y) * W + (bx + x)) * C;
        lab[y * bw + x] = rgbToLab(data[i], data[i + 1], data[i + 2]);
      }
    }

    // TEN REFERANSI — merkezi yanak şeridinin medyanı.
    const skinL = [], skinA = [], skinB = [];
    for (let y = Math.round(bh * SKIN_STRIP.y0); y < Math.round(bh * SKIN_STRIP.y1); y++) {
      for (let x = Math.round(bw * SKIN_STRIP.x0); x < Math.round(bw * SKIN_STRIP.x1); x++) {
        const p = lab[y * bw + x];
        skinL.push(p.L); skinA.push(p.a); skinB.push(p.b);
      }
    }
    const mL = medianOf(skinL), ma = medianOf(skinA), mb = medianOf(skinB);
    if (mL == null) return { ok: false, reason: "no-skin-sample" };
    const skinChroma = Math.hypot(ma, mb);
    // Ten kroması sıfıra yakınsa (gri-tonlamalı/aşırı soluk kare) oran
    // kuralı anlamını yitirir — ölçüm yapılamaz, fail-safe çıkış.
    if (skinChroma < 1) return { ok: false, reason: "achromatic-skin" };

    const mx = Math.round(bw * FACE_BORDER_MARGIN);
    const my = Math.round(bh * FACE_BORDER_MARGIN);
    const mask = new Uint8Array(bw * bh);
    for (let y = my; y < bh - my; y++) {
      for (let x = mx; x < bw - mx; x++) {
        const p = lab[y * bw + x];
        const chroma = Math.hypot(p.a, p.b);
        if (p.L - mL > PATCH_MIN_L_ABOVE_SKIN && chroma < skinChroma * PATCH_MAX_CHROMA_RATIO) {
          mask[y * bw + x] = 1;
        }
      }
    }

    const comp = largestComponent(mask, bw, bh);
    const faceArea = bw * bh;
    return {
      ok: true,
      fraction: comp ? comp.size / faceArea : 0,
      px: comp ? comp.size : 0,
      fill: comp ? comp.fill : null,
      at: comp ? { x: comp.box.x0 / bw, y: comp.box.y0 / bh } : null,
      skinL: mL,
      skinChroma,
    };
  } catch (e) {
    return { ok: false, reason: `error:${e.message || e}` };
  }
}

module.exports = {
  measureFacePatch,
  largestComponent,
  rgbToLab,
  medianOf,
  PATCH_MIN_L_ABOVE_SKIN,
  PATCH_MAX_CHROMA_RATIO,
  FACE_BORDER_MARGIN,
};
