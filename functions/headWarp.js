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
// GÖRÜNTÜ KENARI (2026-11-06, d87c25b4 c3, 629b45de c8 canlı; düz çizgili
// karelerde zorla bükmede 6dd26e3e c1, 7c17ea3f c6, 3d1d2a71 c6, 0eeb75c8 c11):
// kafa üst kenara yakınken küçültmenin kaynağı karenin dışına düşüyor, kenara
// kırpılan örnek üst satırı 25-40 px dikey çizgi olarak çoğaltıyordu. Alan,
// taşan kenarda kenara uzaklıkla sıfıra iner (rampa = K × en büyük dışa yer
// değiştirme, Jakobyen ≥ ~0.5); yalnız kenara dik bileşen söner. Taşma yoksa
// alan aynen bugünkü.
const BORDER_TOL = 1; // px: karenin bu kadar dışından örnek kabul (kenara kırpma 1 px'te görünmez)
const BORDER_RAMP_K = 3;
const BORDER_MIN_PX = 8;
// ÇİZGİ KORUMA (2026-11-06, bkz. lineKeep.js): bugün bükülen karede alan düz
// kenarları eğmeyecek şekilde düzeltilir, kapı bugüne göre; tutmazsa bugünkü alan.
// KAPALI (11-06 doğrulama): 29/55 bükülen karenin arka planını değiştiriyor;
// kullanıcı ham|bugün|yeni tam çözünürlüklü sayfaları (zayıf kareler dahil:
// 7e04933e c1 alt neon, 9c8f c9, 0eeb c12, dd788 c3, c2e c9, 017dbe34 c7)
// onaylamadan açılmaz. Kenar koruması (borderGuard) bu bayraktan bağımsız, açık.
const LINE_KEEP_ON = false;
// AŞAMA 2: düz çizgili arka planda (bugün "structured-background" atlanan)
// sıfır toleranslı kapıyla küçültme. KAPALI: 11-03 b932fd71 kararı (kafa düz
// çizgili arka planda modelin boyunda kalır) kullanıcı sayfaları görmeden
// geri çevrilmez. Yerel ölçüm (11-06, 151+16 kare): küçültme istenen 29 düz
// çizgili karenin yalnız 3'ü sıfır toleranslı kapıdan geçti (0eeb c8, b932 c1,
// dd78 c9); b932 c8 süre sınırına takıldı, kare bugünkü gibi dokunulmadan kalır.
const LINE_KEEP_STRUCTURED = false;
// ARKA PLAN SABİT KAFA ÖLÇEĞİ (2026-11-08, bkz. scaleHeadKeepBackground): bükme alanı yalnız
// kişiye; arka plan hiç kaydırılmaz. Yerel ölçüm bitene kadar KAPALI.
// 2026-11-08 iki tur 43 kare: bükme 0 ama kusurlu kare 11 → 19 (sert kesik saç tepesi, omuz izi);
// şimdiki bükme 6. KAPALI; yerine BÜKME DENETİMİ (BEND_GATE_ON).
const KEEP_BG_ON = false;
// BÜKME DENETİMİ (2026-11-08, kullanıcı: "kafayı yerleştirirken arkadaki yapıları
// eğip bükmemeliyiz", f358a3e1 c4 cam korkuluk). Düz çizgi payı kapısı (LINE_OK/MAX)
// ince/soluk çizgiyi görmüyordu (c4 saydam cam: %0.1). Alan kurulduktan sonra kafa
// ve kıyafet dışındaki düz kenarlar tam çözünürlükte bulunur (lineKeep.independentLines)
// ve alanın onları ne kadar eğdiği ölçülür (bendOf: çıktıdaki görüntünün doğrudan en
// büyük sapması). Eşiği aşan çizgi varsa kafa ölçeklenmez (kafa modelin boyunda kalır).
// Arka plan sabit yol (KEEP_BG) iki turda kesip yapıştırma görüntüsü verdi, bu onun yerine.
// Ölçüm (11-08, 6 iş 60 kare): bükmenin uygulandığı 25 karenin 15'i eşiği aşıyor;
// ajanların gözle "çizgi eğilmiş" dediği 7 karenin 7'si + c4 cam (2.0 px, 189 px çizgi).
// Aşanlar düz kenar (tavan ışığı, korkuluk, tekne gövdesi): mutlak eşik, oran yok.
const BEND_GATE_ON = true;
const BEND_GATE_PX = 1.5; // en çok izin verilen sapma (px)
const BEND_GATE_MIN_LEN = 0.25; // dikkate alınan en kısa çizgi (yüz boyu)
const BEND_GATE_PAD = 0.03; // kafa/kıyafet dışlama payı (yüz boyu)
// ÇİZGİ ONARIMI (2026-11-08, kullanıcı: "küçültmeden sonra bükülen yerleri düzleştiremez
// miyiz"): denetimin bulduğu eğik çizginin çevresindeki şeritte bükme alanı sıfıra
// indirilir (ham yerinde, düz), kenarda yumuşak geçiş; kafa/kıyafet pikseline dokunulmaz.
// Şeridin eski kafanın arkasında kalan kısmı (hamda kafa) yerel LaMa ile dolar.
// Onarımdan sonra aynı ölçü; hâlâ eşiği aşıyorsa kare bugünkü gibi atlanır.
// KAPALI (2026-11-10): büyük küçültmede şeridin içi ham, dışı bükülmüş kalıyor → çift kenar,
// ufukta basamak, LaMa deliğinde beyaz şerit (7bbdad12 c4, canlı). Yerine katmanlı yol
// (LAYER_ON, headLayer.js); bu yol yalnız katmanlı yol süre/hata yüzünden çalışmazsa.
const LINE_REPAIR_ON = false;
const LR_MIN_DEV = 1.0; // bu sapmadan büyük çizgiler onarılır (px)
const LR_MAX_LINES = 14; // daha çok kayan çizgi (sık yapı: dönme dolap, panel tavan, sütun) onarımda çiftlenme/basamak yaptı (11-08/09: 15-21 çizgide bozuk, 7e04933e c1 dönme dolap 15); onarım yok, kare atlanır
const LR_CORE_PAD = 2; // şerit çekirdeği = çizgi yarı eni + kayma + bu (px)
const LR_FEATHER_MIN = 4; // geçiş en az (px); yoksa kaymanın 2 katı
const LR_END_EXT = 0.05; // çizgi uçlarından taşma (yüz boyu). Kayma sönene kadar uzatma denendi (11-09): dolap tellerini ve beton dokusunu bozdu, geri alındı
const LR_MAX_FILL = 0.5; // LaMa deliği en çok (yüz boyu²)
const LR_HOLE_HEAD = 0.05; // şeritte hamı bu olasılıktan büyük kafa/saç olan piksel delik (soluk saç ucu leke bırakıyordu)
const LR_HOLE_GROW = 0.03; // delik genişletme (yüz boyu)
// Saç tepesine yukarıdan inen (dikeye yakın, uzantısı kaş hizasının üstünde eski kafaya giren) çizgi
// onarılmaz: şerit saçın tepesini düz kesip blok bırakıyordu (f358a3e1 c9 poster çerçevesi). Kafa
// çevresine pay bırakmak da denendi (11-09): c4 camında payın sınırında kutu yaptı, geri alındı.
const LR_TOP_MIN_SIN = 0.85; // |sin açı| ≥ bu: dikeye yakın (~58°+)
const LR_TOP_REACH = 0.25; // uçtan aşağı arama (yüz boyu)
// Bu boydan kısa (yüz boyu) VE bu kontrasttan soluk çizgi onarılmaz.
const LR_SOFT_LEN = 0.5;
const LR_SOFT_MAG = 20;
const LR_MIN_LEFT_MS = 60 * 1000;
// AZALTILMIŞ KÜÇÜLTME (2026-11-09, kullanıcı: "bükülme olan yerlerde kafa küçültmeyi yine yapalım
// ama daha az yapalım belli bi oranda"): tam güçte eğilme onarılamıyorsa bükme bu oranda (ölçek ve
// eğim farkı) yeniden kurulur; yine onarım denenir, olmazsa LB_REDUCED_MAX_PX'e kadar eğilme kabul.
// Daha çoğunda kare bugünkü gibi atlanır (kafa modelin boyunda).
const LB_REDUCE_ON = true;
const LB_REDUCED_STRENGTH = 0.5;
const LB_REDUCED_MAX_PX = 3;
// Kafa ölçeği değişmiyorsa (yalnız eğim/hiza) onarım yok, kare atlanır: kazanç yok, iz riski var (173acc7f c2 ×1.00).
// KATMANLI KAFA ÖLÇEĞİ (2026-11-10, bkz. headLayer.js): kişi bükülür, arka plan hiç
// kaydırılmaz, açılan yer hizalı şablon/LaMa plakasıyla; tam güç, eleme yok.
const LAYER_ON = true;
// Yalnız eğim (ölçek değişmiyor) ama bükme çizgiyi eğiyor: bugün kafa hiç düzeltilmiyordu
// (7bbdad12 c5 8.0°, 173acc7f c2 7.6°). Bu eşikten büyük eğimde de katmanlı yol (11-10).
// KAPALI (11-10 v8 kör A/B: yalnız-eğim 4 karede yeni 1 / canlı 3 — saç kenarında şerit, omuzda
// tırtık; düz çizgili karelerdeki sürüm incelenemedi). Infinity = yalnız-eğim yolu yok.
const LAYER_ROLL_MIN_DEG = Infinity;
// Katmanlı yola geçiş kararı ölçülen plana (katmanlı gücüyle) göre, bükmenin çizgiyle kısılmış
// ölçeğine göre değil (bkz. correctHeadByWarp, 41589067 c5).
const LAYER_ROUTE = { DECIDE_ON_PLAN: true };
const STRUCT_SHRINK_ON = true;
const STRUCT_SHRINK_MIN_FACE_RATIO = 1.08;
const LR_MIN_SCALE_CHANGE = 0.02; // b932fd71 c5 ×0.973 (14.7 px duvar) içeride kalmalı
// Çizgi koruma iş süresinden en az bu kadar kalmışsa çalışır (900 sn bütçe).
const LK_MIN_LEFT_MS = 60 * 1000;

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
 * Görüntü kenarı koruması: ROI alanı (Dx, Dy: ters yer değiştirme, yerinde
 * değişir) karenin BORDER_TOL px'ten fazla dışından örnekliyorsa taşan kenarda
 * alan kenara uzaklıkla yumuşakça sıfıra indirilir. F: { rx0, ry0, RW, RH, FW,
 * FH }. Döner { ov (önce, px), after (px), ramp: [üst, alt, sol, sağ] }. SAF.
 */
function borderGuard(Dx, Dy, F) {
  const { rx0, ry0, RW, RH, FW, FH } = F;
  const scan = () => {
    const c = [0, 0, 0, 0];
    let ov = 0;
    for (let y = 0; y < RH; y++) {
      const gy = y + ry0;
      for (let x = 0; x < RW; x++) {
        const i = y * RW + x;
        if (!Dx[i] && !Dy[i]) continue;
        const sx = x + rx0 + Dx[i], sy = gy + Dy[i];
        if (sy < -BORDER_TOL) { c[0] = Math.max(c[0], -Dy[i]); ov = Math.max(ov, -sy); }
        if (sy > FH - 1 + BORDER_TOL) { c[1] = Math.max(c[1], Dy[i]); ov = Math.max(ov, sy - FH + 1); }
        if (sx < -BORDER_TOL) { c[2] = Math.max(c[2], -Dx[i]); ov = Math.max(ov, -sx); }
        if (sx > FW - 1 + BORDER_TOL) { c[3] = Math.max(c[3], Dx[i]); ov = Math.max(ov, sx - FW + 1); }
      }
    }
    return { c, ov };
  };
  let st = scan();
  const ov0 = st.ov;
  const ramp = [0, 0, 0, 0];
  for (let pass = 0; pass < 4 && st.ov > 0; pass++) {
    for (let e = 0; e < 4; e++) if (st.c[e] > 0) ramp[e] = Math.max(ramp[e], BORDER_MIN_PX, BORDER_RAMP_K * st.c[e] * 1.5 ** pass);
    for (let y = 0; y < RH; y++) {
      const gy = y + ry0;
      for (let x = 0; x < RW; x++) {
        const i = y * RW + x;
        if (!Dx[i] && !Dy[i]) continue;
        // Yalnız kenara dik bileşen söner: tüm vektör sönünce dikey kasa üst
        // kenarda S basamağı yaptı (9c8f2cb5 c9, yatay kayma ~20 px).
        const gx = x + rx0;
        let fx = 1, fy = 1;
        if (st.c[0] > 0 && Dy[i] < 0) fy *= smooth(gy / ramp[0]);
        if (st.c[1] > 0 && Dy[i] > 0) fy *= smooth((FH - 1 - gy) / ramp[1]);
        if (st.c[2] > 0 && Dx[i] < 0) fx *= smooth(gx / ramp[2]);
        if (st.c[3] > 0 && Dx[i] > 0) fx *= smooth((FW - 1 - gx) / ramp[3]);
        Dx[i] *= fx; Dy[i] *= fy;
      }
    }
    st = scan();
  }
  if (st.ov > 0) {
    // Son çare (ölçülen karelerde gerekmedi): kalan taşan pikselin alanı
    // kaynak kenara gelene kadar kısılır.
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      if (!Dx[i] && !Dy[i]) continue;
      const gx = x + rx0, gy = y + ry0;
      if (gx + Dx[i] < -BORDER_TOL) Dx[i] = -gx - BORDER_TOL;
      if (gx + Dx[i] > FW - 1 + BORDER_TOL) Dx[i] = FW - 1 + BORDER_TOL - gx;
      if (gy + Dy[i] < -BORDER_TOL) Dy[i] = -gy - BORDER_TOL;
      if (gy + Dy[i] > FH - 1 + BORDER_TOL) Dy[i] = FH - 1 + BORDER_TOL - gy;
    }
    st = scan();
  }
  return { ov: ov0, after: st.ov, ramp: ramp.map((r) => Math.round(r)) };
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
async function headMasks(rgb, FW, FH, box, chinY, { headCrop = false } = {}) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const { personCropProbs } = require("./skinTone");
  const sc = Math.min(1, SEG_MAX_DIM / Math.max(FW, FH));
  const W = Math.max(1, Math.round(FW * sc)), H = Math.max(1, Math.round(FH * sc));
  const work = await sharp(rgb, { raw: { width: FW, height: FH, channels: 3 } }).resize(W, H, { fit: "fill" }).raw().toBuffer();
  const b = { x: box.x * sc, y: box.y * sc, width: box.width * sc, height: box.height * sc };
  const P = await personCropProbs(work, W, H, b, classProbs, CLASSES);
  const head = new Float32Array(W * H), prot = new Float32Array(W * H), cloth = new Float32Array(W * H), person = new Float32Array(W * H);
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
      // Kişi (arka plan olmayan her şey: kafa, kulak, boyun, kıyafet, aksesuar) — bkz. scaleHeadKeepBackground.
      person[i] = Math.max(h, 1 - P[CLASSES.background][i]);
    }
  }
  const out = { head: upsample(head, W, H, FW, FH), prot: upsample(prot, W, H, FW, FH), cloth: upsample(cloth, W, H, FW, FH), person: upsample(person, W, H, FW, FH) };
  if (headCrop) await refineHeadCrop(out, rgb, FW, FH, box, chinY);
  return out;
}

/**
 * KAFA KIRPIMINDA KESKİN MASKE (2026-11-08, arka plan sabit yol). Kişi kırpımı
 * (7×9.8 yüz kutusu) modele 256×256 sıkışıyor: kafa kenarında bir segmentasyon
 * pikseli 4-6 tam piksel, maske saçın birkaç piksel dışına taşıyor ve kafa
 * kayınca arkasındaki pencere/çerçeve parçası kafayla taşınıyordu (80fc7ec4 c4,
 * f358a3e1 c9 düz kenarlı bloklar). Kafa çevresi (3 yüz eni × ~3.3 yüz boyu,
 * saç üstü dahil) tam çözünürlükten ayrı sınıflandırılır; kafa ve kişi maskesi
 * kırpım içinde bununla değişir, kırpım kenarına doğru eskisine karışır.
 */
const HEAD_CROP = { side: 1.0, up: 1.7, down: 0.5, ramp: 0.08 };
async function refineHeadCrop(m, rgb, FW, FH, box, chinY) {
  const { classProbs, CLASSES } = require("./skinSeg");
  const x0 = Math.max(0, Math.floor(box.x - HEAD_CROP.side * box.width));
  const x1 = Math.min(FW, Math.ceil(box.x + (1 + HEAD_CROP.side) * box.width));
  const y0 = Math.max(0, Math.floor(box.y - HEAD_CROP.up * box.height));
  const y1 = Math.min(FH, Math.ceil(chinY + HEAD_CROP.down * box.height));
  const w = x1 - x0, h = y1 - y0;
  if (w < 32 || h < 32) return;
  const crop = await sharp(rgb, { raw: { width: FW, height: FH, channels: 3 } }).extract({ left: x0, top: y0, width: w, height: h }).raw().toBuffer();
  const C = await classProbs(crop, w, h);
  const fx0 = box.x - 0.15 * box.width, fx1 = box.x + 1.15 * box.width, fy0 = box.y - 0.1 * box.height;
  const rp = Math.max(4, HEAD_CROP.ramp * Math.min(w, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x + x0, gy = y + y0, g = gy * FW + gx, i = y * w + x;
      // Görüntü kenarına denk gelen kırpım kenarında rampa yok.
      const dx = Math.min(x0 > 0 ? x : Infinity, x1 < FW ? w - 1 - x : Infinity);
      const dy = Math.min(y0 > 0 ? y : Infinity, y1 < FH ? h - 1 - y : Infinity);
      const k = Math.min(1, Math.min(dx, dy) / rp);
      if (k <= 0) continue;
      const hair = C[CLASSES.hair][i], face = C[CLASSES.faceSkin][i], oth = C[CLASSES.others][i];
      let hh = gy <= chinY + 0.02 * box.height ? Math.max(hair, face) : 0;
      if (gx >= fx0 && gx <= fx1 && gy >= fy0 && gy <= chinY) hh = Math.max(hh, oth);
      const pp = Math.max(hh, 1 - C[CLASSES.background][i]);
      m.head[g] = k * hh + (1 - k) * m.head[g];
      m.person[g] = k * pp + (1 - k) * m.person[g];
    }
  }
}

/**
 * Kafayı plana göre büker. plan: { s (≤1, ölçülen), rollRad }.
 * lm: çıktının 68 yüz noktası ({ pts, box }). Döner { buf, applied, reason, ... }.
 * deadline: işin bitiş zamanı (ms, Date.now() ölçeğinde; yoksa sınırsız) —
 * az kalmışsa çizgi koruma atlanır. debug: yerel ölçüm için ara çıktılar.
 * lineKeep: çizgi koruma (varsayılan LINE_KEEP_ON; yalnız yerel ölçüm/test açar).
 */
async function warpHead(outputBuf, plan, lm, { deadline = null, debug = false, lineKeep = LINE_KEEP_ON, ignoreLines = false, field = false, bendGateOn = BEND_GATE_ON, strength = 1, bendLimit = BEND_GATE_PX, warpStrength = WARP_STRENGTH } = {}) {
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
  // ignoreLines: arka plan kaydırılmayacaksa (scaleHeadKeepBackground) düz çizgi kapısı gereksiz.
  let k = (ignoreLines ? 1 : 1 - smooth((lines - LINE_OK) / (LINE_MAX - LINE_OK))) * clamp(strength, 0, 1);
  const planOf = (kk) => ({
    s: wantShrink ? clamp(1 - kk * warpStrength * (1 - s0), WARP_MAX_SHRINK, 1)
      : wantGrow ? clamp(1 + kk * warpStrength * (s0 - 1), 1, WARP_MAX_GROW) : 1,
    th: kk * th0,
  });
  let { s, th } = planOf(k);
  let T = CHIN_MOVE_ON ? { x: k * T0.x, y: k * T0.y } : { x: 0, y: 0 };
  const moveOn = Math.hypot(T.x, T.y) >= 1;
  // Aşama 2 (LINE_KEEP_STRUCTURED): düz çizgili arka planda tam güçle alan
  // kurulur, yalnız çizgi korumalı alan sıfır toleranslı kapıyı geçerse
  // uygulanır; geçmezse bugünkü gibi atlanır. Büyütme hiç (kafa zaten büyük
  // ölçülen 0eeb c10 / 629b c3'te büyütme kırık kasa verdi).
  let structured = false;
  if (Math.abs(s - 1) < 0.005 && Math.abs(th) < 0.01 && Math.hypot(T.x, T.y) < 1) {
    if (!(lineKeep && LINE_KEEP_STRUCTURED && wantShrink)) return { buf: null, applied: false, reason: "structured-background", s, lines };
    structured = true;
    k = 1;
    ({ s, th } = planOf(1));
  }
  // Arka plan sabit yolda (field) kafa çevresi ayrıca keskin sınıflandırılır (refineHeadCrop).
  const { head, prot, cloth, person } = await headMasks(rgb, FW, FH, lm.box, chinY, { headCrop: field });
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
  const sample = (fx, fy, c) => {
    const xx = clamp(fx, 0, FW - 1.001), yy = clamp(fy, 0, FH - 1.001);
    const xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya;
    const i00 = (ya * FW + xa) * 3 + c, i10 = i00 + 3, i01 = i00 + FW * 3, i11 = i01 + 3;
    return (rgb[i00] * (1 - ax) + rgb[i10] * ax) * (1 - ay) + (rgb[i01] * (1 - ax) + rgb[i11] * ax) * ay;
  };
  // Alan önce kurulur (Dx, Dy: ters yer değiştirme; act: bükülen piksel),
  // kenar koruması ve çizgi koruma alanı değiştirebilir, en son örneklenir.
  // Taşma yoksa çıktı 11-06 öncesiyle bayt bayt aynı.
  const Dx = new Float64Array(RW * RH), Dy = new Float64Array(RW * RH), act = new Uint8Array(RW * RH);
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
      // Katmanlı yolda (field) arka plan kaydırılmaz: boyun derisi de korunmaz, yalnız dikeyde
      // söner (11-10, 7bbdad12 c4 profil: korunan boyun kulak altında çentik/düz kesik yapıyordu).
      if (!m[i]) w *= 1 - clamp(field ? cloth[g] : !moveOn || gy <= chinY ? prot[g] : cloth[g], 0, 1) * smooth(dist[i] / protRamp);
      if (w <= 0.002) continue;
      // Ters dönüşüm: hedef → kaynak (çene ucu çevresinde dönme + ölçek, sonra öteleme).
      const qx = gx - A.x - T.x, qy = gy - A.y - T.y;
      const sx = A.x + (cos * qx - sin * qy) / s, sy = A.y + (sin * qx + cos * qy) / s;
      Dx[i] = w * (sx - gx); Dy[i] = w * (sy - gy); act[i] = 1;
    }
  }
  const render = (X, Y, on) => {
    const out = Buffer.from(rgb);
    for (let y = 0; y < RH; y++) {
      const gy = y + ry0;
      for (let x = 0; x < RW; x++) {
        const i = y * RW + x;
        if (!on[i]) continue;
        const gx = x + rx0, g = gy * FW + gx;
        const fx = gx + X[i], fy = gy + Y[i];
        for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.round(sample(fx, fy, c));
      }
    }
    return out;
  };
  const prod = debug ? { Dx: Float64Array.from(Dx), Dy: Float64Array.from(Dy) } : null;
  const border = borderGuard(Dx, Dy, { rx0, ry0, RW, RH, FW, FH });
  let out = structured ? null : render(Dx, Dy, act);
  // field: alan ve bükülmüş ham görüntü dışarı verilir (scaleHeadKeepBackground kişiyi buradan alır).
  if (field && out) {
    return {
      buf: null, applied: true, reason: null, s, rollDeg: (th * 180) / Math.PI, lines, band: Math.round(band), touch: touchFrac, border, ms: Date.now() - t0,
      field: { rgb, warped: out, Dx, Dy, act, rx0, ry0, RW, RH, FW, FH, faceH, chinY, head, person, prot, cloth },
    };
  }
  let bendGate = null;
  if (bendGateOn && !structured && !lineKeep) {
    try {
      const bF = { rx0, ry0, RW, RH, FW, FH, m, head, prot, Dx, Dy, faceH, browY };
      bendGate = await measureBend(rgb, bF);
      bendGate.F = bF;
    } catch (e) {
      console.error("Bükme denetimi hata verdi (bükme uygulanmaz):", e.message || e);
      bendGate = { error: true, max: Infinity, n: 0, over: 0 };
    }
    if (bendGate.max > BEND_GATE_PX) {
      let rp = null;
      if (!LINE_REPAIR_ON) rp = { ok: false, reason: "kapalı" };
      else if (bendGate.error) rp = { ok: false, reason: "ölçü-hatası" };
      // Eşik güçle ölçeklenir: azaltılmış güçte ölçek farkı da o oranda küçük (11-09 inceleme).
      else if (Math.abs(1 - s) < LR_MIN_SCALE_CHANGE * clamp(strength, 0, 1)) rp = { ok: false, reason: "ölçek-değişmiyor" };
      else if (deadline && deadline - Date.now() < LR_MIN_LEFT_MS) rp = { ok: false, reason: "süre-bütçesi" };
      else {
        try {
          rp = await repairBentLines(rgb, bendGate.F, render, act);
        } catch (e) {
          console.error("Çizgi onarımı hata verdi (bükme uygulanmaz):", e.message || e);
          rp = { ok: false, reason: "error" };
        }
      }
      bendGate.repair = rp ? { ok: rp.ok, reason: rp.reason || null, n: rp.n ?? null, fillPx: rp.fillPx ?? null, after: rp.after ?? null, topSkip: rp.topSkip ?? null, info: rp.info || null } : null;
      bendGate.F = undefined;
      if (rp && rp.ok && rp.after <= BEND_GATE_PX) out = rp.out;
      // Azaltılmış güçte (bendLimit > BEND_GATE_PX) hafif eğilme kabul edilir; onarım eğilmeyi
      // azalttıysa onarılmış hali (varsayılan sınırda bu dal hiç çalışmaz: ilk dal yakalar).
      else if (rp && rp.ok && rp.after <= bendLimit && rp.after < bendGate.max) { out = rp.out; bendGate.accepted = true; }
      else if (bendGate.max <= bendLimit) bendGate.accepted = true;
      else return { buf: null, applied: false, reason: "line-bend", s, lines, bendGate, ms: Date.now() - t0 };
    }
    if (bendGate) bendGate.F = undefined;
  }
  let lk = null;
  if (lineKeep) {
    if (deadline && deadline - Date.now() < LK_MIN_LEFT_MS) lk = { used: false, reason: "süre-bütçesi", stats: {} };
    else {
      try {
        const F = { rx0, ry0, RW, RH, FW, FH, m, dist, head, prot, Dx, Dy, act, faceH, headH, s, chinY, browY };
        lk = await require("./lineKeep").keepLines(rgb, FW, FH, F, { mode: structured ? "structured" : "applied", render, todayOut: structured ? rgb : out, deadline: deadline || Infinity, debug });
        if (debug) lk.F = F;
      } catch (e) {
        console.error("Çizgi koruma hata verdi (bugünkü bükme):", e.message || e);
        lk = { used: false, reason: "error", stats: {} };
      }
    }
  }
  const lkLog = lk ? { used: lk.used, reason: lk.reason, ...lk.stats } : null;
  if (structured && !(lk && lk.used)) return { buf: null, applied: false, reason: "structured-background", s: 1, lines, lk: lkLog };
  let moved = 0;
  if (lk && lk.used) { out = lk.out; for (let i = 0; i < RW * RH; i++) moved += lk.act[i]; } else for (let i = 0; i < RW * RH; i++) moved += act[i];
  const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  const res = { buf, applied: true, reason: null, bendGate, s, rollDeg: (th * 180) / Math.PI, tx: T.x / faceH, ty: T.y / faceH, neck: neckLenAtChin / faceH, lines, band: Math.round(band), touch: touchFrac, moved, border, lk: lkLog, structured, ms: Date.now() - t0 };
  if (debug) {
    res.debug = {
      roi: [rx0, ry0, RW, RH], faceH, lk: lk && lk.dbg ? { ...lk.dbg, F: lk.F } : null,
      prodBuf: border.ov > BORDER_TOL ? await sharp(render(prod.Dx, prod.Dy, act), { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer() : null,
      todayBuf: structured ? null : await sharp(render(Dx, Dy, act), { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer(),
    };
  }
  return res;
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

// ARKA PLAN SABİT KAFA ÖLÇEĞİ (2026-11-08, kullanıcı: "kafayı yerleştirirken
// arkadaki yapıları eğip bükmemeliyiz"; f358a3e1 c4 cam korkuluk).
// Bükme (warpHead) kafa çevresindeki 1.4 kafa boyu bandı da kaydırıyordu: düz
// çizgi algılanırsa hiç uygulanmıyor (43 karenin 19'u, kafa büyük kalıyor),
// algılanmazsa (saydam cam %0.1) eğiyor. Katı ölçek + halka (rigidScaleFill)
// arka planı korudu ama 43 karenin 12'sinde boyun/çene kalıntısı bıraktı
// (çene içeri, boyun yerinde; ajan incelemesi 11-08).
// BURADA: bükme alanı AYNEN kurulur (kafa ölçeği, boyun esnemesi, koruma), ama
// yalnız KİŞİYE uygulanır: kişi olmayan piksel hiç kaydırılmaz. Kişinin eski
// silüetinden açılan yer önce base'in hizalı arka planıyla (baseRingFill,
// yerel uyum kapılı), kalanı yerel LaMa ile dolar. Saç ucu (düşük olasılıklı
// tel) da kişi sayılır: kafayla gider, eski yeri dolar.
const KB_HEAD_PROB = 0.2; // bu olasılıktan büyük saç/yüz kişi sayılır (tel uçları)
const KB_OLD_GROW = 0.05; // eski silüet genişletme, çene üstü (yüz boyu payı): hale/tel
// Soluk saç teli (olasılık 0.2 altı) eski silüete katılır: kalırsa kafa küçülünce
// arka planda diken/nokta olarak kalıyor ve LaMa onu bağlam alıp dolguya saç
// uzatıyordu (43 karelik inceleme 11-08: 80fc7ec4 c4/c8, f358a3e1 c4/c9).
const KB_SOFT_PROB = 0.03;
const KB_FILL_GROW = 0.015; // LaMa deliği genişletme (yüz boyu payı)
const KB_ALPHA_LO = 0.3; // yeni kişi maskesi yumuşak geçiş aralığı
const KB_ALPHA_HI = 0.7;
const KB_CROP_PAD = 0.35; // LaMa kırpımı payı (yüz boyu)
// SAÇ KENARI AYRIŞTIRMA (matting): yarı saydam saç arka plana biniyor (f358a3e1 c9
// poster çerçevesi, 80fc7ec4 c4 pencere); maske "kişi" dediği için o arka plan
// parçası kafayla taşınıyordu. LaMa'nın eski kafa altına çizdiği temiz plaka (Bp)
// ve yakın saç rengi (Hc) ile kenar bandında α = (I-Bp)·(Hc-Bp)/|Hc-Bp|², saç rengi
// fg = Bp + (I-Bp)/α; taşınan yalnız fg·α. Renk ayrımı zayıfsa (|Hc-Bp| küçük) maske.
const KB_MATTE_ON = true;
const KB_MATTE_BAND = 0.06; // dış kenardan içe bant (yüz boyu)
const KB_MATTE_HC_R = 0.1; // saç rengi ortalama yarıçapı (yüz boyu)
const KB_MATTE_SEP_LO = 15; // |Hc-Bp| bunun altında renkle ayrım yok
const KB_MATTE_SEP_HI = 45; // bunun üstünde tam güven
const KB_MATTE_QMIN = 0.6; // fg çıkarımında α tabanı (gürültü büyütmesi ≤ 1/QMIN)
const KB_MATTE_SMOOTH = 4; // α 3×3 yumuşatma geçişi

/** Saç kenarı ayrıştırma (bkz. KB_MATTE_*). Döner { band, alpha, fg } (ROI). */
function hairMatte({ rgb, plate, plateOk, o, person, head, rx0, ry0, RW, RH, FW, faceH, chinY, hairY }) {
  const N = RW * RH;
  const outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) outside[i] = o[i] < 0.5 ? 1 : 0;
  const near = dilateBin(outside, RW, RH, Math.max(3, KB_MATTE_BAND * faceH));
  // Yakın saç/kişi rengi: güvenli iç piksellerin maskeli kutu ortalaması (integral).
  const r = Math.max(4, Math.round(KB_MATTE_HC_R * faceH));
  const I = new Float64Array((RW + 1) * (RH + 1) * 4);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = ((y + ry0) * FW + x + rx0) * 3, k = ((y + 1) * (RW + 1) + x + 1) * 4;
    const kU = (y * (RW + 1) + x + 1) * 4, kL = ((y + 1) * (RW + 1) + x) * 4, kUL = (y * (RW + 1) + x) * 4;
    const m = o[i] >= 0.98 ? 1 : 0;
    const v = [rgb[g] * m, rgb[g + 1] * m, rgb[g + 2] * m, m];
    for (let c = 0; c < 4; c++) I[k + c] = v[c] + I[kU + c] + I[kL + c] - I[kUL + c];
  }
  const boxSum = (x0, y0, x1, y1, c) => I[(y1 * (RW + 1) + x1) * 4 + c] - I[(y0 * (RW + 1) + x1) * 4 + c] - I[(y1 * (RW + 1) + x0) * 4 + c] + I[(y0 * (RW + 1) + x0) * 4 + c];
  const band = new Uint8Array(N), alpha = new Float32Array(N), fg = Buffer.alloc(N * 3);
  let nBand = 0, nSep = 0;
  // Yalnız saç: kaş hizasının üstü (şakak/kulak derisinde renk ayrımı koyu leke yaptı).
  for (let y = 0; y < RH; y++) {
    if (y + ry0 > hairY) break;
    for (let x = 0; x < RW; x++) {
      const i = y * RW + x, g = ((y + ry0) * FW + x + rx0);
      const sp = Math.max(person[g], head[g]);
      if (!near[i] || sp < 0.02 || !plateOk[i]) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(RW, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(RH, y + r + 1);
      const cnt = boxSum(x0, y0, x1, y1, 3);
      if (cnt < 8) continue;
      const a0 = clamp((o[i] - KB_ALPHA_LO) / (KB_ALPHA_HI - KB_ALPHA_LO), 0, 1);
      const Hc = [boxSum(x0, y0, x1, y1, 0) / cnt, boxSum(x0, y0, x1, y1, 1) / cnt, boxSum(x0, y0, x1, y1, 2) / cnt];
      const Bp = [plate[i * 3], plate[i * 3 + 1], plate[i * 3 + 2]];
      const Ip = [rgb[g * 3], rgb[g * 3 + 1], rgb[g * 3 + 2]];
      const d = [Hc[0] - Bp[0], Hc[1] - Bp[1], Hc[2] - Bp[2]];
      const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const sep = Math.sqrt(L2);
      const wgt = clamp((sep - KB_MATTE_SEP_LO) / (KB_MATTE_SEP_HI - KB_MATTE_SEP_LO), 0, 1);
      const ac = L2 > 1 ? clamp(((Ip[0] - Bp[0]) * d[0] + (Ip[1] - Bp[1]) * d[1] + (Ip[2] - Bp[2]) * d[2]) / L2, 0, 1) : a0;
      const a = wgt * Math.min(ac, Math.max(a0, sp)) + (1 - wgt) * a0;
      band[i] = 1; alpha[i] = a; nBand++; if (wgt > 0.5) nSep++;
      const q = Math.max(a, KB_MATTE_QMIN);
      for (let c = 0; c < 3; c++) fg[i * 3 + c] = clampI(Math.round(wgt * (Bp[c] + (Ip[c] - Bp[c]) / q) + (1 - wgt) * Ip[c]), 0, 255);
    }
  }
  // α 3×3 yumuşatma (bant içinde): renk gürültüsü kenarı tırtıklı yapıyordu.
  let cur = alpha;
  for (let pass = 0; pass < KB_MATTE_SMOOTH; pass++) {
    const sm = new Float32Array(cur);
    for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) {
      const i = y * RW + x;
      if (!band[i]) continue;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + dy * RW + dx; if (band[j]) { s += cur[j]; n++; } }
      sm[i] = s / n;
    }
    cur = sm;
  }
  return { band, alpha: cur, fg, nBand, nSep };
}

async function scaleHeadKeepBackground(outputBuf, plan, lm, tplBuf = null, { deadline = null } = {}) {
  const t0 = Date.now();
  const w = await warpHead(outputBuf, plan, lm, { deadline, lineKeep: false, ignoreLines: true, field: true });
  if (!w.applied || !w.field) return w;
  const { rgb, warped, Dx, Dy, act, rx0, ry0, RW, RH, FW, FH, faceH, chinY, head, person } = w.field;
  const N = RW * RH;
  const pAt = (g) => { const h = head[g]; return Math.max(person[g], h >= KB_HEAD_PROB ? Math.min(1, h / 0.5) : 0); };
  // Eski (o) ve yeni (nS: bükülmüş) kişi maskesi, ROI.
  const o = new Float32Array(N), nS = new Float32Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = (y + ry0) * FW + x + rx0;
    o[i] = pAt(g);
    if (!act[i]) { nS[i] = o[i]; continue; }
    const sx = clampI(x + rx0 + Dx[i], 0, FW - 1), sy = clampI(y + ry0 + Dy[i], 0, FH - 1);
    nS[i] = pAt(sy * FW + sx);
  }
  // Eski silüet (ikili): çene üstünde genişletilmiş (hale, tel); altında olduğu gibi.
  const ob = new Uint8Array(N), obSoft = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x, g = (y + ry0) * FW + x + rx0;
    ob[i] = o[i] >= KB_HEAD_PROB ? 1 : 0;
    obSoft[i] = ob[i] || Math.max(person[g], head[g]) >= KB_SOFT_PROB ? 1 : 0;
  }
  const obG = dilateBin(obSoft, RW, RH, Math.max(2, KB_OLD_GROW * faceH));
  const oldG = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    oldG[i] = y + ry0 <= chinY ? obG[i] : ob[i];
  }
  const newB = new Uint8Array(N);
  for (let i = 0; i < N; i++) newB[i] = nS[i] >= 0.5 ? 1 : 0;
  // Dolgu gereken: bükmenin dokunduğu, eski silüette olup yeni kişide tam olmayan.
  const need = new Uint8Array(N);
  let needPx = 0, bx0 = RW, bx1 = -1, by0 = RH, by1 = -1;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (!act[i] || !oldG[i] || nS[i] >= 0.98) continue;
    need[i] = 1; needPx++;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const F = Buffer.from(rgb); // arka plan tahmini (yalnız need içinde kullanılır)
  let lamaPx = 0, basePx = 0, plate = null, plateOk = null;
  if (needPx) {
    const holeB = new Uint8Array(N);
    for (let i = 0; i < N; i++) holeB[i] = need[i] && nS[i] < 0.5 ? 1 : 0;
    const holeG = dilateBin(holeB, RW, RH, Math.max(1, KB_FILL_GROW * faceH));
    const padC = Math.round(KB_CROP_PAD * faceH);
    const gx0 = bx0 + rx0 - padC, gx1 = bx1 + rx0 + padC, gy0 = by0 + ry0 - padC, gy1 = by1 + ry0 + padC;
    const side = Math.min(FW, FH, Math.max(gx1 - gx0, gy1 - gy0) + 1);
    const left = clampI((gx0 + gx1) / 2 - side / 2, 0, FW - side), topc = clampI((gy0 + gy1) / 2 - side / 2, 0, FH - side);
    const crop = Buffer.alloc(side * side * 3);
    const hole = new Uint8Array(side * side);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const gx = x + left, gy = y + topc, g = gy * FW + gx, c3 = (y * side + x) * 3;
      crop[c3] = rgb[g * 3]; crop[c3 + 1] = rgb[g * 3 + 1]; crop[c3 + 2] = rgb[g * 3 + 2];
      const lx = gx - rx0, ly = gy - ry0;
      // Kişi bağlam olarak verilmez (LaMa saçı halkaya uzatıyordu, bkz. rigidScaleFill).
      if (lx >= 0 && ly >= 0 && lx < RW && ly < RH && (holeG[ly * RW + lx] || newB[ly * RW + lx] || ob[ly * RW + lx] || oldG[ly * RW + lx])) hole[y * side + x] = 1;
    }
    const filled = (await require("./lamaFill").fillCrop(crop, side, hole)).rgb;
    if (KB_MATTE_ON) {
      plate = Buffer.alloc(N * 3); plateOk = new Uint8Array(N);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const lx = x + left - rx0, ly = y + topc - ry0;
        if (lx < 0 || ly < 0 || lx >= RW || ly >= RH || !hole[y * side + x]) continue;
        const li = ly * RW + lx, c3 = (y * side + x) * 3;
        plate[li * 3] = filled[c3]; plate[li * 3 + 1] = filled[c3 + 1]; plate[li * 3 + 2] = filled[c3 + 2]; plateOk[li] = 1;
      }
    }
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const lx = x + left - rx0, ly = y + topc - ry0;
      if (lx < 0 || ly < 0 || lx >= RW || ly >= RH || !need[ly * RW + lx]) continue;
      const g = ((y + topc) * FW + x + left) * 3, c3 = (y * side + x) * 3;
      F[g] = filled[c3]; F[g + 1] = filled[c3 + 1]; F[g + 2] = filled[c3 + 2];
      lamaPx++;
    }
    if (tplBuf) {
      try {
        basePx = await baseRingFill(F, rgb, tplBuf, FW, FH, { rx0, ry0, RW, RH, ring: need, keep: newB, oldG, newHead: newB, faceH, box: lm.box, chinY });
      } catch (e) {
        console.error("Kafa ölçeği: base arka planı konamadı (yalnız LaMa):", e.message || e);
      }
    }
  }
  // Birleştirme: kişi bükülmüş görüntüden, arka plan yerinde (açılan yer dolgudan).
  const out = Buffer.from(rgb);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (!act[i]) continue;
    const g = ((y + ry0) * FW + x + rx0) * 3;
    const B = need[i] ? F : rgb;
    let a = clamp((nS[i] - KB_ALPHA_LO) / (KB_ALPHA_HI - KB_ALPHA_LO), 0, 1), src = warped, sg = g;
    if (mt) {
      const lx = clampI(x + Dx[i], 0, RW - 1), ly = clampI(y + Dy[i], 0, RH - 1), li = ly * RW + lx;
      if (mt.band[li]) { a = mt.alpha[li]; src = mt.fg; sg = li * 3; }
    }
    for (let c = 0; c < 3; c++) out[g + c] = Math.round(a * src[sg + c] + (1 - a) * B[g + c]);
  }
  const buf = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { buf, applied: true, reason: null, s: w.s, keepBg: true, fillPx: needPx, lamaPx, basePx, lines: w.lines, band: w.band, touch: w.touch, border: w.border, ms: Date.now() - t0 };
}

/**
 * Bükme denetimi: alanın kafa/kıyafet dışındaki düz kenarları eğmesi (px).
 * Döner { n, max, over, ms } (over: BEND_GATE_PX'i aşan çizgi sayısı).
 */
/** Yapı çizgisi: kısa (< LR_SOFT_LEN yüz boyu) VE soluk (mag < LR_SOFT_MAG) değil. */
const isStructural = (l, faceH) => !(l.L < LR_SOFT_LEN * faceH && !((l.mag || 0) >= LR_SOFT_MAG));

async function measureBend(rgb, F) {
  const t0 = Date.now();
  const { RW, RH, FW, rx0, ry0, m, head, prot, Dx, Dy, faceH } = F;
  const LK = require("./lineKeep")._testables;
  const N = RW * RH;
  const ex = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const g = (y + ry0) * FW + x + rx0;
    if (head[g] >= 0.25 || prot[g] >= 0.5) ex[y * RW + x] = 1;
  }
  const exG = dilateBin(ex, RW, RH, Math.max(2, BEND_GATE_PAD * faceH));
  const lines = await LK.independentLines(rgb, FW, F.FH, { ...F, faceH }, exG);
  // Gizli: yeni kafanın altında kalan (kaynağı eski kafa) ya da çıktıda kafa/kıyafet olan piksel.
  const hide = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    const sx = clampI(x + Dx[i], 0, RW - 1), sy = clampI(y + Dy[i], 0, RH - 1);
    if (m[sy * RW + sx] || exG[i]) hide[i] = 1;
  }
  // Denetim, onarım ve son ölçü aynı yapı çizgileriyle (kısa VE soluk doku kenarı hiçbirinde
  // sayılmaz; 11-09 inceleme: denetim sayıp son ölçü saymayınca aynı soluk eğilme bir karede
  // kareyi eliyor, başkasında gözden kaçıyordu).
  const structural = lines.filter((l) => isStructural(l, faceH));
  const b = LK.bendOf(F, Dx, Dy, structural, hide, BEND_GATE_MIN_LEN * faceH);
  const max = b.reduce((a, r) => Math.max(a, r.dev), 0);
  F._lines = structural; F._hide = hide;
  const top = b.filter((r) => r.dev > BEND_GATE_PX).sort((p, q) => q.dev - p.dev).slice(0, 5).map((r) => ({ cx: Math.round(r.cx), cy: Math.round(r.cy), L: Math.round(r.L), dev: +r.dev.toFixed(2) }));
  return { n: b.length, max, over: b.filter((r) => r.dev > BEND_GATE_PX).length, top, ms: Date.now() - t0 };
}

/** Dikeye yakın çizginin alt ucu aşağı uzatılınca kaş hizasının üstünde eski kafaya giriyor mu. */
function entersHeadTop(l, F) {
  const { rx0, ry0, RW, RH, m, faceH, browY } = F;
  if (!m || !Number.isFinite(browY) || Math.abs(l.uy) < LR_TOP_MIN_SIN) return false;
  const dir = l.uy > 0 ? 1 : -1; // +t yönü aşağı mı
  const tEnd = dir > 0 ? l.t1 : l.t0;
  const lim = LR_TOP_REACH * faceH;
  for (let k = 0; k <= lim; k += 1) {
    const t = tEnd + dir * k;
    const x = Math.round(l.cx - rx0 + t * l.ux), y = Math.round(l.cy - ry0 + t * l.uy);
    if (x < 0 || y < 0 || x >= RW || y >= RH) return false;
    if (m[y * RW + x]) return y + ry0 < browY;
  }
  return false;
}

/**
 * Çizgi onarımı (bkz. LINE_REPAIR_*). F: measureBend girdisi (+ _lines, _hide).
 * render(Dx, Dy, act): warpHead'in çizicisi. Döner { ok, reason, out, n, fillPx, after }.
 */
async function repairBentLines(rgb, F, render, act) {
  const LK = require("./lineKeep")._testables;
  const { RW, RH, FW, rx0, ry0, m, head, prot, Dx, Dy, faceH } = F;
  const N = RW * RH;
  const lines = F._lines || [], hide = F._hide;
  const minLen = BEND_GATE_MIN_LEN * faceH;
  const bent = [];
  let topSkip = 0;
  // Eğilen ya da bütünüyle kayan çizgi: düz ama kaymış parça, kafanın öbür yanındaki
  // onarılmış parçayla hizasız kalıyordu (f358a3e1 c4 cam, sol parça 9 px aşağıda).
  for (const l of lines) {
    if (l.L < minLen) continue;
    const b = LK.bendOf(F, Dx, Dy, [l], hide, minLen);
    if (!b.length) continue;
    const lcx = l.cx - rx0, lcy = l.cy - ry0, nx = -l.uy, ny = l.ux;
    let off = 0;
    for (const [ox, oy] of LK.imageOf(F, Dx, Dy, l, hide)) off = Math.max(off, Math.abs((ox - lcx) * nx + (oy - lcy) * ny));
    // Kısa ve soluk kenar (bulut şeridi, doku) yapı çizgisi değil: onarımı kıvrım bıraktı (27deeec2 c7).
    if (!isStructural(l, faceH)) continue;
    if (entersHeadTop(l, F)) { topSkip++; continue; }
    if (b[0].dev > LR_MIN_DEV || off > LR_MIN_DEV) bent.push({ l, dev: b[0].dev, off });
  }
  if (!bent.length) return { ok: false, reason: "no-bent-line" };
  if (bent.length > LR_MAX_LINES) return { ok: false, reason: "many-lines:" + bent.length };
  // Çıktıda kişi (yeni kafa, kaynağı kafa/kıyafet): alan aynen kalır.
  const personOut = new Uint8Array(N);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    const sx = clampI(x + Dx[i], 0, RW - 1), sy = clampI(y + Dy[i], 0, RH - 1);
    const g = (sy + ry0) * FW + sx + rx0;
    // Delikle aynı eşik (LR_HOLE_HEAD): yeni kafanın yumuşak saç kenarı onarılmaz (11-09 inceleme).
    if (m[sy * RW + sx] || head[g] >= LR_HOLE_HEAD || prot[g] >= 0.5) personOut[i] = 1;
  }
  const keepOut = dilateBin(personOut, RW, RH, 1);
  // Şerit ağırlığı: çekirdekte 1, geçişte 0'a; uçlarda da rampa.
  const w = new Float32Array(N);
  const ext = Math.max(6, LR_END_EXT * faceH);
  const sm = (t) => t * t * (3 - 2 * t);
  for (const bl of bent) {
    const { l } = bl;
    bl.holePx = 0; bl.hT0 = Infinity; bl.hT1 = -Infinity;
    const lcx = l.cx - rx0, lcy = l.cy - ry0, nx = -l.uy, ny = l.ux;
    // Bükülmüş görüntünün ham çizgiden en büyük uzaklığı (kaydırma dahil).
    let off = 0;
    for (const [ox, oy] of LK.imageOf(F, Dx, Dy, l, hide)) off = Math.max(off, Math.abs((ox - lcx) * nx + (oy - lcy) * ny));
    const core = (l.wid || 2) / 2 + LR_CORE_PAD + off;
    const fe = Math.max(LR_FEATHER_MIN, 2 * off);
    const tA = l.t0 - ext, tB = l.t1 + ext;
    const R = core + fe, ta = tA - fe, tb = tB + fe;
    const pts = [[ta, -R], [ta, R], [tb, -R], [tb, R]].map(([t, d]) => [lcx + t * l.ux + d * nx, lcy + t * l.uy + d * ny]);
    const bx0 = clampI(Math.min(...pts.map((p) => p[0])), 0, RW - 1), bx1 = clampI(Math.max(...pts.map((p) => p[0])), 0, RW - 1);
    const by0 = clampI(Math.min(...pts.map((p) => p[1])), 0, RH - 1), by1 = clampI(Math.max(...pts.map((p) => p[1])), 0, RH - 1);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const dx = x - lcx, dy = y - lcy;
      const t = dx * l.ux + dy * l.uy, d = Math.abs(dx * nx + dy * ny);
      if (d >= R || t <= ta || t >= tb) continue;
      const wd = d <= core ? 1 : 1 - (d - core) / fe;
      const te = t < tA ? (t - ta) / fe : t > tB ? (tb - t) / fe : 1;
      const v = sm(clamp(wd, 0, 1)) * sm(clamp(te, 0, 1));
      const i = y * RW + x;
      if (v > 0.5 && !keepOut[i] && (m[i] || head[(y + ry0) * FW + x + rx0] >= LR_HOLE_HEAD)) { bl.holePx++; if (d <= core) { bl.hT0 = Math.min(bl.hT0, t); bl.hT1 = Math.max(bl.hT1, t); } }
      if (v > w[i]) w[i] = v;
    }
  }
  const D2x = new Float32Array(N), D2y = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = keepOut[i] ? 0 : w[i];
    D2x[i] = Dx[i] * (1 - k); D2y[i] = Dy[i] * (1 - k);
  }
  // Delik: şeritte, çıktıda kişi değil ama yeni kaynağı (ham) eski kafa olan piksel.
  const hole = new Uint8Array(N);
  let holeN = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    if (w[i] <= 0.02 || keepOut[i]) continue;
    const sx = clampI(x + D2x[i], 0, RW - 1), sy = clampI(y + D2y[i], 0, RH - 1);
    const g2 = (sy + ry0) * FW + sx + rx0;
    // Kişi (boyun, yaka, el) da delik: şerit omuz/çene hizasına inince ham boyun/yaka dışarıda kalıyordu.
    if (m[sy * RW + sx] || head[g2] >= LR_HOLE_HEAD || prot[g2] >= 0.5) { hole[i] = 1; holeN++; }
  }
  const holeG = holeN ? dilateBin(hole, RW, RH, Math.max(2, LR_HOLE_GROW * faceH)) : hole;
  let fillPx = 0;
  for (let i = 0; i < N; i++) if (holeG[i] && !keepOut[i]) fillPx++;
  if (fillPx > LR_MAX_FILL * faceH * faceH) return { ok: false, reason: "fill-big:" + fillPx };
  const out = render(D2x, D2y, act);
  if (fillPx) {
    let bx0 = RW, bx1 = -1, by0 = RH, by1 = -1;
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      if (!holeG[i] || keepOut[i]) continue;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    const FH = F.FH, pad = Math.round(0.3 * faceH);
    const gx0 = bx0 + rx0 - pad, gx1 = bx1 + rx0 + pad, gy0 = by0 + ry0 - pad, gy1 = by1 + ry0 + pad;
    const side = Math.min(FW, FH, Math.max(gx1 - gx0, gy1 - gy0) + 1);
    const left = clampI((gx0 + gx1) / 2 - side / 2, 0, FW - side), topc = clampI((gy0 + gy1) / 2 - side / 2, 0, FH - side);
    // Delik kırpıma sığmıyorsa dışarıda kalan delik ham eski kafa gösterirdi: onarım yok.
    if (bx0 + rx0 < left || by0 + ry0 < topc || bx1 + rx0 >= left + side || by1 + ry0 >= topc + side) return { ok: false, reason: "fill-crop" };
    const crop = Buffer.alloc(side * side * 3), cm = new Uint8Array(side * side);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const gx = x + left, gy = y + topc, g = (gy * FW + gx) * 3, c3 = (y * side + x) * 3;
      crop[c3] = out[g]; crop[c3 + 1] = out[g + 1]; crop[c3 + 2] = out[g + 2];
      const lx = gx - rx0, ly = gy - ry0;
      // Kişi bağlam verilmez (LaMa saçı deliğe uzatıyordu, bkz. rigidScaleFill).
      if (lx >= 0 && ly >= 0 && lx < RW && ly < RH && (holeG[ly * RW + lx] || personOut[ly * RW + lx])) cm[y * side + x] = 1;
    }
    const filled = (await require("./lamaFill").fillCrop(crop, side, cm)).rgb;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const lx = x + left - rx0, ly = y + topc - ry0;
      if (lx < 0 || ly < 0 || lx >= RW || ly >= RH) continue;
      const li = ly * RW + lx;
      if (!holeG[li] || keepOut[li]) continue;
      const g = ((y + topc) * FW + x + left) * 3, c3 = (y * side + x) * 3;
      out[g] = filled[c3]; out[g + 1] = filled[c3 + 1]; out[g + 2] = filled[c3 + 2];
    }
  }
  // Son ölçü denetimle aynı çizgilerle (lines = measureBend'in yapı çizgileri).
  const after = LK.bendOf(F, D2x, D2y, lines, hide, minLen).reduce((a, r) => Math.max(a, r.dev), 0);
  const info = bent.map((b) => ({ cx: Math.round(b.l.cx), cy: Math.round(b.l.cy), L: Math.round(b.l.L), ang: Math.round((Math.atan2(b.l.uy, b.l.ux) * 180) / Math.PI), mag: +(b.l.mag || 0).toFixed(1), dev: +b.dev.toFixed(2), off: +b.off.toFixed(2), holePx: b.holePx, holeSpan: b.hT1 > b.hT0 ? Math.round(b.hT1 - b.hT0) : 0, faceH: Math.round(faceH) }));
  return { ok: true, out, n: bent.length, fillPx, after, info, topSkip };
}

/**
 * Ölç + uygula. Ölçü headScale'den (küçültme ve 2026-11-01'den beri sınırlı büyütme).
 * Döner { buf, applied, reason, ölçü }.
 */
async function correctHeadByWarp(outputBuf, templateBuf, { templateEyewear = false, deadline = null, debug = false, lineKeep = LINE_KEEP_ON, keepBackground = KEEP_BG_ON, bendGateOn = BEND_GATE_ON, layered = LAYER_ON, layerRollMinDeg = LAYER_ROLL_MIN_DEG, layerDebug = null } = {}) {
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
  const plan = { s: hs.s || 1, rollRad: hs.rollRad || 0, tx: cm.tx, ty: cm.ty };
  let r = keepBackground
    ? await scaleHeadKeepBackground(outputBuf, plan, lm, templateBuf, { deadline })
    : await warpHead(outputBuf, plan, lm, { deadline, debug, lineKeep, bendGateOn });
  // KATMANLI YOL (bkz. headLayer.js): bükme kafa çevresindeki düz çizgiyi eğecekse ve gerçek
  // küçültme varsa, kişi bükülür ama arka plan hiç kaydırılmaz (şerit onarımı ve yarım güç
  // yerine). Çizgi yoksa bugünkü bükme (11-10 kör A/B: çizgisiz karede bükme temiz ve
  // katmanlı yol yalnız iz ekliyordu); yalnız eğim/büyütme ve düz çizgili arka plan bugünkü gibi.
  const rollOnly = (Math.abs(plan.rollRad || 0) * 180) / Math.PI >= layerRollMinDeg;
  // Karar katmanlı yolun KENDİ küçültmesine göre (2026-11-12, 41589067 c5): r.s bükmenin düz
  // çizgi payıyla kısılmış ölçeği (c5: ölçü 0.929 → %4.8 çizgi → 0.982); katmanlı yol arka
  // planı bükmediği için tam güçle (LAYER.STRENGTH) uygular. r.s'ye bakınca c5 ne küçüldü ne
  // eğimi düzeldi (model kafayı 8° yatık çizmişti).
  const layerS = plan.s < 1 ? 1 - require("./headLayer")._testables.LAYER.STRENGTH * (1 - plan.s) : 1;
  const layerShrinks = LAYER_ROUTE.DECIDE_ON_PLAN ? layerS <= 1 - LR_MIN_SCALE_CHANGE : r.s != null && r.s <= 1 - LR_MIN_SCALE_CHANGE;
  if (layered && r.reason === "line-bend" && !keepBackground && !lineKeep && r.s != null && (layerShrinks || rollOnly)) {
    let rl;
    try {
      rl = await require("./headLayer").scaleHeadLayered(outputBuf, plan, lm, templateBuf, { deadline, debugMasks: layerDebug });
    } catch (e) {
      console.error("Katmanlı kafa ölçeği hata verdi (yarım güç denenecek):", e.message || e);
      rl = { applied: false, reason: "layer-error" };
    }
    r = rl.applied ? { ...rl, bendGate: r.bendGate } : { ...r, layerReason: rl.reason };
  }
  // Düz çizgili arka plan: bugün kafaya hiç dokunulmuyordu. Belirgin eğimde katmanlı yolla
  // YALNIZ eğim (ölçek 1): arka plan kaydırılmaz; ölçek bu karelerde tartışmalı (11-10: sakallı
  // base çeneyi kısa ölçüyor, kör A/B'de küçültme kafayı base'den küçük yaptı) → değişmez.
  // KÜÇÜLTME DE (2026-11-13, kullanıcı: "c7'de kafa küçültme uygulanmamış"): yüz base'den belirgin
  // büyükse (hs.faceRatio >= STRUCT_SHRINK_MIN_FACE_RATIO) ve katmanlı yol gerçekten küçültecekse
  // arka plan kaydırılmadan küçültülür. Yüz oranı şartı: sakallı base'de çene kısa ölçülüp kafa
  // base'den küçük çıkmasın (11-10 kör A/B) — ölçü saç/sakal hacmi, yüz oranı yüz noktalarından.
  const structShrink = STRUCT_SHRINK_ON && layerShrinks && hs.faceRatio >= STRUCT_SHRINK_MIN_FACE_RATIO;
  if (layered && r.reason === "structured-background" && !keepBackground && !lineKeep && (rollOnly || structShrink)) {
    let rl;
    try {
      rl = await require("./headLayer").scaleHeadLayered(outputBuf, { ...plan, s: structShrink ? plan.s : 1 }, lm, templateBuf, { deadline, debugMasks: layerDebug });
    } catch (e) {
      console.error("Katmanlı eğim hata verdi (atlanıyor):", e.message || e);
      rl = { applied: false, reason: "layer-error" };
    }
    r = rl.applied ? { ...rl, rollOnlyStructured: !structShrink, structShrink } : { ...r, layerReason: rl.reason };
  }
  // Tam güçte eğilme onarılamadı: aynı plan azaltılmış güçle (bkz. LB_REDUCE_*).
  // Yalnız gerçek KÜÇÜLTMEDE (tam güçte ölçek ≥ LR_MIN_SCALE_CHANGE küçülüyor): yalnız eğim
  // ya da büyütme planı ve ölçeği zaten değişmeyen kare bugünkü gibi atlanır (11-09 inceleme).
  if (r.reason === "line-bend" && LB_REDUCE_ON && !keepBackground && r.s != null && r.s <= 1 - LR_MIN_SCALE_CHANGE && !(deadline && deadline - Date.now() < LR_MIN_LEFT_MS)) {
    const full = r;
    try {
      const rr = await warpHead(outputBuf, plan, lm, { deadline, debug, lineKeep, bendGateOn, strength: LB_REDUCED_STRENGTH, bendLimit: LB_REDUCED_MAX_PX });
      r = rr.applied ? { ...rr, reduced: { strength: LB_REDUCED_STRENGTH, fullBend: full.bendGate ? full.bendGate.max : null } } : { ...full, reducedReason: rr.reason, reducedBend: rr.bendGate ? rr.bendGate.max : null };
    } catch (e) {
      console.error("Azaltılmış kafa bükme hata verdi (atlanıyor):", e.message || e);
      r = full;
    }
  }
  // Düz çizgili arka plan: bükme yerine katı ölçek + ince halka dolgusu.
  if (r.reason === "structured-background" && RIGID_ON && (hs.s <= WARP_MIN_SHRINK || hs.s >= WARP_MIN_GROW)) {
    try {
      const rr = await rigidScaleFill(outputBuf, { s: hs.s }, lm, templateBuf);
      r = { ...rr, lines: r.lines, reason: rr.applied ? null : `structured-background/${rr.reason}` };
    } catch (e) {
      console.error("Katı kafa ölçeği hata verdi (atlanıyor):", e.message || e);
    }
  }
  return { ...r, ölçü: `${ölçü} ${çene} uygulanan=${n(r.s)}${r.rollDeg != null ? ` dönüş=${n(r.rollDeg, 1)}°` : ""}${r.tx != null ? ` kayma=${n(r.tx, 2)}/${n(r.ty, 2)} boyun=${n(r.neck, 2)}` : ""}${r.rigid ? ` katı halka=${r.ringPx}px base=${r.tplPx}px` : ""}${r.keepBg ? ` arkaPlanSabit dolgu=${r.fillPx}px base=${r.basePx}px` : ""}${r.layered ? ` KATMANLI[halka=${r.layered.ringPx}px şablon=${r.layered.tplPx}px lama=${r.layered.lamaPx}/${r.layered.lama2Px}px tel=${r.layered.strandPx}px düz=${r.layered.flatPx}px hiza=${r.layered.shift}]` : ""}${r.rollOnlyStructured ? " yalnızEğim" : ""}${r.structShrink ? " düzÇizgiliKüçültme" : ""}${r.layerReason ? ` katmanlıYok=${r.layerReason}` : ""}${r.reduced ? ` AZALTILMIŞ[güç=${r.reduced.strength} tamGüçEğilme=${n(r.reduced.fullBend, 1)}px]` : ""}${r.reducedReason ? ` azaltılmış=${r.reducedReason}${r.reducedBend != null ? `/${n(r.reducedBend, 1)}px` : ""}` : ""}${r.bendGate && r.bendGate.accepted ? " eğilmeKabul" : ""}${r.bendGate ? ` ${r.layered ? "bükmeOlsaydı" : "bükmeDenetimi"}=${r.bendGate.error ? "HATA" : n(r.bendGate.max, 1) + "px"}/${r.bendGate.n}çizgi${r.bendGate.repair ? ` onarım[${r.bendGate.repair.ok ? `${r.bendGate.repair.n}çizgi dolgu=${r.bendGate.repair.fillPx}px kalan=${n(r.bendGate.repair.after, 1)}px` : r.bendGate.repair.reason}]` : ""}` : ""}${r.lines != null ? ` düzÇizgi=${n(100 * r.lines, 1)}%` : ""}${r.touch != null ? ` dokunma=${n(r.touch, 2)}` : ""}${r.band != null ? ` bant=${r.band}px` : ""}${r.border && r.border.ov > BORDER_TOL ? ` kenar[taşma=${n(r.border.ov, 1)}→${n(r.border.after, 1)}px rampa=${r.border.ramp.join("/")}]` : ""}${lkLog(r.lk)}${r.ms != null ? ` ${r.ms}ms` : ""}` };
}

/** Log: çizgiKoru[UYGULANDI|ATLANDI[neden] çizgi=N bükülme=yeni/bugün bağımsız=yeni/bugün katlanma=yeni/bugün yeniKatlanma=N esneme=yeni/bugün it ms]. SAF. */
function lkLog(lk) {
  if (!lk) return "";
  if (lk.lines == null) return ` çizgiKoru[ATLANDI[${lk.reason}]]`;
  const v = (a, b) => `${a ?? "null"}/${b ?? "null"}`;
  return ` çizgiKoru[${lk.used ? "UYGULANDI" : `ATLANDI[${lk.reason}]`} çizgi=${lk.lines} bükülme=${v(lk.bendN, lk.bendT)} bağımsız=${v(lk.indN, lk.indT)}px katlanma=${v(lk.negN, lk.negT)} yeniKatlanma=${lk.newFold ?? "null"} esneme=${v(lk.strN, lk.strT)} it=${lk.it ?? "null"} ${lk.ms ?? "null"}ms]`;
}

module.exports = { correctHeadByWarp, warpHead, rigidScaleFill, scaleHeadKeepBackground, _testables: { STRUCT_SHRINK_ON, STRUCT_SHRINK_MIN_FACE_RATIO, headMasks, LAYER_ON, LAYER_ROUTE, LAYER_ROLL_MIN_DEG, measureBend, repairBentLines, entersHeadTop, LINE_REPAIR_ON, LB_REDUCE_ON, LB_REDUCED_STRENGTH, LB_REDUCED_MAX_PX, BEND_GATE_ON, BEND_GATE_PX, dilateBin, RIGID_ON, distanceTo, borderGuard, lkLog, LINE_KEEP_ON, LINE_KEEP_STRUCTURED, BORDER_TOL, upsample, lineShare, clothRegister, gradMag, WARP_MIN_SHRINK, WARP_MAX_SHRINK, WARP_MIN_GROW, WARP_MAX_GROW, LINE_OK, LINE_MAX, CHIN_MAX_X, CHIN_MAX_UP } };
