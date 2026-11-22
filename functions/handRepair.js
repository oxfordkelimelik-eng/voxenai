"use strict";
/**
 * EL / KOL / GÖĞÜS DERİSİ ONARIMI (2026-11-20, iş 64bff386 c1/c2/c4, kullanıcı:
 * "eller siyahi kişinin elleri kalmış … 1.50 sınırına yaklaşabilirsin, kesin çözümü yap").
 *
 * NEDEN: ana üretim şablonun ellerine dokunmuyor (bkz. [[hand-tone-mismatch]]); prompttaki
 * "skin tone … the same on the face, ears, neck, arms and hands" uygulanmıyor. Ton katmanı
 * (skinTone) yalnız açıklık/renk kaydırabiliyor: siyahi şablonun eli açık tenli kullanıcıda
 * eklem kontrastı, doku ve dövmesiyle "başkasının eli" olarak kalıyor (yerel yeniden oynatma
 * 185655bf_c3: L +5 açıldı, gözle hâlâ koyu el).
 *
 * YÖNTEM: şablon kişisi ile kullanıcının teni belirgin farklıysa (şablon ≥ MST_GAP koyu ya da
 * kullanıcı ≥ MST_GAP_LIGHTER_TPL koyu; 2026-11-22 iki yönlü) ve ham karede el yüzle uyumsuzsa
 * (açıklık iki yönlü ya da renk), görünen vücut derisi (el, kol, göğüs; yüz HARİÇ, yüz çevresi
 * geniş rampayla) maskelenip OpenAI'ye yeniden çizdirilir. İkinci görsel kullanıcının yüzü
 * (aynı karenin yüz kırpımı) — ten hedefi oradan. Model tüm kırpımı yeniden ürettiği için
 * sonuç YALNIZ maskenin içine, kaydırma hizalamasıyla geri yapıştırılır: yüz ve arka plan
 * piksel piksel korunur. Doğrulama tutmazsa ya da ölçülemezse kare olduğu gibi kalır.
 *
 * ÜÇ PARÇA (2026-11-20 inceleme): prepareHands (yerel, worker havuzunda) → editHands (ücretli,
 * ana iş parçacığında; bütçe/süre/görsel kuyruğu çağıranda) → finishHands (yerel, worker).
 * Ücretsiz eleme bütçe beklemesinden ÖNCE yapılır. repairHands üçünü tek süreçte birleştirir
 * (yerel test, editFn ile).
 *
 * MALİYET: kırpım + yüz referansı, medium kalite; ayırma tahmini EST_USD (kod tabanının medium
 * görsel çağrı tahmini), gerçek maliyet usage'dan deftere yazılır; mutlak tavan
 * jobContext.hardCapAllows.
 */
const sharp = require("sharp");

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const MODEL = "gpt-image-2";

const HAND_REPAIR = {
  ON: true,
  // Şablon MST − kullanıcı MST: ≥ 2 adım koyu şablon kişisi (faceRelight.albedoRatio ölü bölgesi 1).
  MST_GAP: 2,
  // TERS YÖN (2026-11-22, kullanıcı: "koyu tenli selfie, açık tenli base"): kullanıcı şablon
  // kişisinden ≥ 3 adım koyuysa da (açık el koyu yüzün altında). Eşik 3: MST tahmini ±1 oynuyor ve
  // MST 5 kullanıcı ↔ MST 3 manken farkı gözle küçük — 2'de açık şablonların çoğunda ücretli
  // onarım tetiklenirdi.
  MST_GAP_LIGHTER_TPL: 3,
  // Ham karede el yüze bu kadar yakınsa (|ΔL| < RAW_GAP_MIN VE renk farkı < RAW_CHROMA_MIN) el zaten
  // kullanıcının teninde çizilmiş. YÖN İKİ TARAFLI: 09-18 şikâyetlerinde "siyahi el" yüzden AÇIK
  // ve doygun kırmızı-kahve ölçülmüştü (el L 67.8 / yüz 60.9, bkz. [[hand-tone-mismatch]]).
  RAW_GAP_MIN: 4,
  RAW_CHROMA_MIN: 4,
  // Uzuv farkı ölçüsünde yüzün yakını (boyun) sayılmaz: skinTone.neckExclusion ≥ bu.
  GAP_FAR_MIN: 0.99,
  // Vücut derisi bölgesi eşiği (skinTone.analyzeSkin region, şablon kıyafet vetolu).
  REGION_MIN: 0.3,
  // Şablon kıyafet vetosu deri sanılan pikselin bu payından fazlasını attıysa (koyu deri ceket,
  // süet) maske güvenilmez → atla.
  CLOTH_VETO_MAX: 0.6,
  // Deri alanı yüz kutusu alanının bu katından küçükse (ör. yalnız parmak ucu) dokunulmaz.
  MIN_AREA_VS_FACE: 0.12,
  // Tek bileşen en az bu kadar (yüz kutusu alanına oran); küçükler yanlış deri.
  MIN_COMP_VS_FACE: 0.06,
  // Maske genişletme (parmak kenarı, tırnak, kol kılı) ve yumuşatma — yüz boyuna göre.
  DILATE_VS_FACE: 0.06,
  FEATHER_VS_FACE: 0.025,
  // Yüz koruması: yüz kutusu merkezli elips (yarı eksenler kutu/2 × FACE_GUARD, dikeyde ×1.25)
  // içinde 0, GUARD_RAMP_OUT katına kadar yumuşak rampa (boyun/çene altında keskin ton dikişi
  // olmasın — inceleme: neckExclusion eşiği el/göğüste elips dikiş bırakıyordu).
  FACE_GUARD: 1.15,
  GUARD_RAMP_OUT: 1.7,
  // Kırpım payı (maske kutusuna göre) — modelin el çevresini görmesi için.
  CROP_PAD: 0.15,
  QUALITY: "medium",
  // falPhotos IMAGE_CALL_EST_USD.medium ile aynı (ayırma; gerçek maliyet usage'dan).
  EST_USD: 0.11,
  TIMEOUT_MS: 150 * 1000,
  // Geri yapıştırmada aranan en büyük kayma (kırpım genişliğine oran).
  SHIFT_MAX: 0.03,
  // Kabul: onarım sonrası |yüz − el| L farkı ve maske içi yapı benzerliği (kenar NCC).
  // İkisi de ÖLÇÜLMÜŞ olmalı (ölçülemezse kabul yok).
  ACCEPT_GAP_MAX: 10,
  STRUCT_MIN: 0.25,
};

const PROMPT =
  "Repaint only the masked skin — the hands, arms and any bare chest or neck — so it is clearly the " +
  "same person as the face in the second image: the same natural skin tone, undertone and colour as " +
  "their face, under the light of this photo. Keep exactly the same hand and arm pose, finger " +
  "positions and lengths, size and proportions, nails, and everything worn on them: watch, " +
  "bracelets, rings, sleeve and cuff edges, collar and necklace. No tattoos. Natural skin texture " +
  "with fine pores and hair, as sharp and as grainy as the rest of the photo; no smoothing, no glow. " +
  "Change nothing outside the mask.";

const toBuf = (v) => (v == null || Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));
const median = (a) => {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
};
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Koşul (iki yönlü, Monk: büyük = koyu): şablon kişisi ≥ gap adım koyu YA DA kullanıcı ≥ gapLighter
 * adım koyu. SAF.
 */
function eligible(mstUser, mstTpl, gap = HAND_REPAIR.MST_GAP, gapLighter = HAND_REPAIR.MST_GAP_LIGHTER_TPL) {
  if (!Number.isFinite(mstUser) || !Number.isFinite(mstTpl)) return false;
  return mstTpl - mstUser >= gap || mstUser - mstTpl >= gapLighter;
}

/**
 * analyzeSkin sonucundan yüz − uzuv açıklık farkı (L); yüzün yakını (boyun) sayılmaz.
 * Uzuv yoksa null. farFn(x, y, box) → 0..1 (skinTone.neckExclusion). SAF.
 */
function limbGap(an, farFn = null, farMin = HAND_REPAIR.GAP_FAR_MIN) {
  if (!an || !an.ok) return null;
  for (const thr of [0.5, 0.15]) {
    const L = [];
    for (let i = 0; i < an.N; i++) {
      if (an.limbW[i] <= thr) continue;
      if (farFn && an.box && farFn(i % an.W, (i / an.W) | 0, an.box) < farMin) continue;
      L.push(an.field.fL[i]);
    }
    if (L.length >= 20) return an.faceTone[0] - median(L);
  }
  return null;
}

/**
 * Yüz ↔ uzuv farkı: { dL: yüz L − uzuv L, dC: a*b* düzleminde uzaklık }; yüzün yakını sayılmaz.
 * Uzuv yoksa null. SAF.
 */
function limbDiff(an, farFn = null, farMin = HAND_REPAIR.GAP_FAR_MIN) {
  if (!an || !an.ok) return null;
  for (const thr of [0.5, 0.15]) {
    const L = [], A = [], B = [];
    for (let i = 0; i < an.N; i++) {
      if (an.limbW[i] <= thr) continue;
      if (farFn && an.box && farFn(i % an.W, (i / an.W) | 0, an.box) < farMin) continue;
      L.push(an.field.fL[i]); A.push(an.field.fA[i]); B.push(an.field.fB[i]);
    }
    if (L.length >= 20) {
      return { dL: an.faceTone[0] - median(L), dC: Math.hypot(an.faceTone[1] - median(A), an.faceTone[2] - median(B)) };
    }
  }
  return null;
}

/** Ham karede el zaten yüzle uyumlu mu (iki yönlü açıklık + renk). SAF. */
function handsMatch(d, opts = HAND_REPAIR) {
  return !!d && Math.abs(d.dL) < opts.RAW_GAP_MIN && d.dC < opts.RAW_CHROMA_MIN;
}

/** 4-komşulu bileşenlerden alanı minArea'dan küçükleri sıfırlar (yerinde). Döner: kalan alan. SAF. */
function dropSmallComponents(m, W, H, minArea) {
  const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N);
  let kept = 0;
  for (let s = 0; s < N; s++) {
    if (!m[s] || seen[s]) continue;
    let top = 0;
    const members = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top];
      members.push(i);
      const x = i % W, y = (i / W) | 0;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && m[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (y < H - 1 && m[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    if (members.length < minArea) for (const i of members) m[i] = 0;
    else kept += members.length;
  }
  return kept;
}

/** Yüz koruması: 0 (elips içi) … 1 (GUARD_RAMP_OUT dışı). SAF. */
function faceGuard(x, y, box, opts = HAND_REPAIR) {
  const rx = (box.width / 2) * opts.FACE_GUARD, ry = (box.height / 2) * opts.FACE_GUARD * 1.25;
  const dx = (x + 0.5 - (box.x + box.width / 2)) / rx, dy = (y + 0.5 - (box.y + box.height / 2)) / ry;
  const d = Math.hypot(dx, dy);
  return smooth01((d - 1) / (opts.GUARD_RAMP_OUT - 1));
}

/**
 * Çalışma ölçeğinde onarım maskesi: soft (0..1, yüz rampası dahil) ve hard (gönderilecek alan).
 * region: vücut derisi (boyun dışlamasız). SAF. Döner { soft, hard, area, faceArea }.
 */
function buildLimbMask({ W, H, region, box }, opts = HAND_REPAIR, { maxField, blurField }) {
  const N = W * H;
  const base = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (region[i] >= opts.REGION_MIN && faceGuard(i % W, (i / W) | 0, box, opts) > 0) base[i] = 1;
  }
  const faceArea = box.width * box.height;
  // Küçük bileşenler (zemin, pantolon kıvrımı, ahşap — 64bff386 c4 alttaki iki leke) atılır.
  const area = dropSmallComponents(base, W, H, opts.MIN_COMP_VS_FACE * faceArea);
  if (area < opts.MIN_AREA_VS_FACE * faceArea) return { soft: null, hard: null, area, faceArea };
  const r = Math.max(1, Math.round(opts.DILATE_VS_FACE * box.height));
  const grown = maxField(base, W, H, r);
  const soft = blurField(grown, W, H, Math.max(1, opts.FEATHER_VS_FACE * box.height));
  const hard = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    soft[i] *= faceGuard(i % W, (i / W) | 0, box, opts);
    if (soft[i] > 0.02) hard[i] = 1;
  }
  return { soft, hard, area, faceArea };
}

function sampleBilinear(F, W, H, x, y) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const a = F[y0 * W + x0] * (1 - fx) + F[y0 * W + x1] * fx;
  const b = F[y1 * W + x0] * (1 - fx) + F[y1 * W + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Kayma: maskenin hemen dışındaki halkada (dokunulmayan komşuluk) ortalama mutlak fark en
 * küçük (dx, dy): b[y+dy][x+dx] ≈ a[y][x]. SAF.
 */
function bestShift(a, b, ring, w, h, S) {
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -S; dy <= S; dy++) {
    for (let dx = -S; dx <= S; dx++) {
      let s = 0, n = 0;
      for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
        for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
          const i = y * w + x;
          if (!ring[i]) continue;
          s += Math.abs(a[i] - b[(y + dy) * w + (x + dx)]);
          n++;
        }
      }
      if (n < 50) continue;
      const e = s / n + 0.02 * (Math.abs(dx) + Math.abs(dy)); // eşitlikte sıfıra yakın
      if (e < best.err) best = { dx, dy, err: e };
    }
  }
  return best;
}

/** Maske içinde kenar (gradyan büyüklüğü) korelasyonu: poz/parmak korunmuş mu. SAF. */
function edgeNcc(a, b, w, h, m) {
  const g = (A, i) => Math.abs(A[i + 1] - A[i - 1]) + Math.abs(A[i + w] - A[i - w]);
  const xs = [], ys = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      xs.push(g(a, i)); ys.push(g(b, i));
    }
  }
  const n = xs.length;
  if (n < 50) return null;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += xs[k]; my += ys[k]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    const p = xs[k] - mx, q = ys[k] - my;
    sxy += p * q; sxx += p * p; syy += q * q;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

const skip = (reason, info = {}) => ({ ok: false, applied: false, buf: null, reason, ...info });

/**
 * YEREL HAZIRLIK (worker): ücretsiz eleme + maske + kırpım. Döner
 * { ok:true, cropPng, maskPng (RGBA, alpha 0 = çiz), faceJpg, alpha8, geo, rawGap, gapBefore, areaVsFace, clothVeto }
 * ya da { ok:false, reason, ... }. ASLA throw etmez.
 */
async function prepareHands({ buf, rawBuf = null, tpl = null } = {}) {
  try {
    buf = toBuf(buf); rawBuf = toBuf(rawBuf); tpl = toBuf(tpl);
    if (!buf) return skip("no-input");
    const st = require("./skinTone");
    const { analyzeSkin, maxField, blurField } = st._testables;
    const far = st.neckExclusion;

    // Ham karede el yüzle uyumluysa (iki yönlü açıklık + renk) model eli zaten kullanıcının teninde çizmiş.
    let rawGap = null, rawChroma = null;
    if (rawBuf) {
      let d = null;
      try { d = limbDiff(await analyzeSkin(rawBuf, { templateBuf: tpl }), far); } catch { d = null; }
      if (d) { rawGap = d.dL; rawChroma = d.dC; }
      if (handsMatch(d)) return skip("hands-match", { rawGap, rawChroma });
    }

    // Boyun dışlamasız bölge (faceGate yok): maske sınırı deri/deri-dışı sınırında kalsın.
    const an = await analyzeSkin(buf, { templateBuf: tpl });
    if (!an.ok) return skip(`skin:${an.reason}`, { rawGap });
    const gapBefore = limbGap(an, far);
    if (an.clothVeto != null && an.clothVeto > HAND_REPAIR.CLOTH_VETO_MAX) {
      return skip("cloth-veto", { rawGap, gapBefore, clothVeto: an.clothVeto });
    }
    const mk = buildLimbMask(an, HAND_REPAIR, { maxField, blurField });
    if (!mk.soft) return skip("small-area", { rawGap, gapBefore, areaVsFace: mk.area / mk.faceArea });

    const meta = await sharp(buf).rotate().metadata();
    const swap = (meta.orientation || 1) >= 5;
    const FW = swap ? meta.height : meta.width, FH = swap ? meta.width : meta.height;
    const kx = an.W / FW, ky = an.H / FH;
    let bx0 = an.W, by0 = an.H, bx1 = -1, by1 = -1;
    for (let i = 0; i < an.N; i++) {
      if (!mk.hard[i]) continue;
      const x = i % an.W, y = (i / an.W) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    if (bx1 < 0) return skip("empty-mask", { rawGap, gapBefore });
    const pw = (bx1 - bx0 + 1) * HAND_REPAIR.CROP_PAD, ph = (by1 - by0 + 1) * HAND_REPAIR.CROP_PAD;
    const cx0 = Math.max(0, Math.floor((bx0 - pw) / kx)), cy0 = Math.max(0, Math.floor((by0 - ph) / ky));
    const cx1 = Math.min(FW, Math.ceil((bx1 + 1 + pw) / kx)), cy1 = Math.min(FH, Math.ceil((by1 + 1 + ph) / ky));
    const cw = cx1 - cx0, chh = cy1 - cy0;
    if (cw < 64 || chh < 64) return skip("crop-small", { rawGap, gapBefore });

    // Kırpım içi tam çözünürlük yumuşak alfa (0..255) ve gönderilecek ikili maske.
    const alpha8 = Buffer.alloc(cw * chh);
    const mrgba = Buffer.alloc(cw * chh * 4);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const a = sampleBilinear(mk.soft, an.W, an.H, (cx0 + x + 0.5) * kx - 0.5, (cy0 + y + 0.5) * ky - 0.5);
        const i = y * cw + x;
        alpha8[i] = Math.max(0, Math.min(255, Math.round(a * 255)));
        mrgba[i * 4 + 3] = a > 0.02 ? 0 : 255;
      }
    }
    const cropPng = await sharp(buf).rotate().removeAlpha().extract({ left: cx0, top: cy0, width: cw, height: chh }).png().toBuffer();
    const maskPng = await sharp(mrgba, { raw: { width: cw, height: chh, channels: 4 } }).png().toBuffer();
    // Yüz referansı: aynı karenin yüzü (ten hedefi), kutu ×1.6.
    const fb = { x: an.box.x / kx, y: an.box.y / ky, w: an.box.width / kx, h: an.box.height / ky };
    const fx0 = Math.max(0, Math.round(fb.x - 0.3 * fb.w)), fy0 = Math.max(0, Math.round(fb.y - 0.3 * fb.h));
    const fw = Math.max(16, Math.min(FW - fx0, Math.round(fb.w * 1.6))), fh = Math.max(16, Math.min(FH - fy0, Math.round(fb.h * 1.6)));
    const faceJpg = await sharp(buf).rotate().removeAlpha().extract({ left: fx0, top: fy0, width: fw, height: fh })
      .resize(640, 640, { fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
    return {
      ok: true, cropPng, maskPng, faceJpg, alpha8,
      geo: { cx0, cy0, cw, chh, FW, FH },
      rawGap, gapBefore, areaVsFace: mk.area / mk.faceArea, clothVeto: an.clothVeto,
    };
  } catch (e) {
    console.error("El onarımı hazırlığı hata verdi (atlanıyor):", e.message || e);
    return skip("error");
  }
}

/**
 * ÜCRETLİ ÇAĞRI (ana iş parçacığı): kırpım + maske size boyutuna, yüz ikinci görsel. Bütçe
 * ayırması, süre ve görsel kuyruğu ÇAĞIRANDA; mutlak tavan burada. Döner Buffer ya da
 * { error }. ASLA throw etmez.
 */
async function editHands({ cropPng, maskPng, faceJpg, geo }, { apiKey, size = null, timeoutMs = HAND_REPAIR.TIMEOUT_MS } = {}) {
  try {
    if (!apiKey) return { error: "no-key" };
    try {
      if (!require("./jobContext").hardCapAllows(HAND_REPAIR.EST_USD)) return { error: "cost-cap" };
    } catch { /* bağlam yoksa sınırsız */ }
    const [sw, sh] = size ? size.split("x").map(Number) : [geo.cw, geo.chh];
    const img = await sharp(toBuf(cropPng)).resize(sw, sh, { fit: "fill" }).png().toBuffer();
    const msk = await sharp(toBuf(maskPng)).ensureAlpha().resize(sw, sh, { fit: "fill", kernel: "nearest" }).png().toBuffer();
    const form = new FormData();
    form.append("model", MODEL);
    form.append("prompt", PROMPT);
    form.append("quality", HAND_REPAIR.QUALITY);
    form.append("output_format", "png");
    if (size) form.append("size", size);
    form.append("image[]", new Blob([img], { type: "image/png" }), "crop.png");
    form.append("image[]", new Blob([toBuf(faceJpg)], { type: "image/jpeg" }), "face.jpg");
    form.append("mask", new Blob([msk], { type: "image/png" }), "mask.png");
    const r = await fetch(OPENAI_IMAGE_EDIT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error(`EL ONARIMI: OpenAI ${r.status} — ${t.slice(0, 160)}`);
      return { error: `http-${r.status}` };
    }
    const j = await r.json();
    if (j && j.usage) {
      try {
        const usd = require("./jobContext").recordUsage(MODEL, j.usage);
        console.log(`MALİYET EL ONARIMI: $${Number(usd || 0).toFixed(4)}`);
      } catch { /* yerel test */ }
    }
    const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) return { error: "empty-response" };
    return Buffer.from(b64, "base64");
  } catch (e) {
    console.error("El onarımı çağrısı hata verdi (kare olduğu gibi):", e.message || e);
    return { error: e && e.name === "TimeoutError" ? "timeout" : "error" };
  }
}

/**
 * YEREL BİTİŞ (worker): düzenlemeyi kırpım boyutuna getir, maskenin dışındaki halkada kaymayı
 * bul, YALNIZ maske içine yapıştır, doğrula. Döner { applied, buf, reason, gapAfter, struct, shift }.
 */
async function finishHands({ buf, edited, alpha8, geo, tpl = null } = {}) {
  try {
    buf = toBuf(buf); edited = toBuf(edited); alpha8 = toBuf(alpha8); tpl = toBuf(tpl);
    const { cx0, cy0, cw, chh } = geo;
    const st = require("./skinTone");
    const { analyzeSkin, maxField } = st._testables;
    const { data: rgb, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const FW = info.width, FH = info.height, ch = info.channels;
    if (FW !== geo.FW || FH !== geo.FH) return skip("size-changed");
    const edR = await sharp(edited).removeAlpha().toColourspace("srgb").resize(cw, chh, { fit: "fill" }).raw()
      .toBuffer({ resolveWithObject: true });
    // Kanal sayısı dönen bilgiden (bkz. [[sharp-mask-channel-trap]]).
    if (edR.info.channels !== 3) return skip(`channels-${edR.info.channels}`);
    const ed = edR.data;
    const alpha = new Float32Array(cw * chh);
    for (let i = 0; i < alpha.length; i++) alpha[i] = alpha8[i] / 255;

    // Kayma: küçültülmüş gri, maskenin dışındaki halka.
    const sc = Math.min(1, 384 / Math.max(cw, chh));
    const gw = Math.max(8, Math.round(cw * sc)), gh = Math.max(8, Math.round(chh * sc));
    const origCrop = Buffer.alloc(cw * chh * 3);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const s = ((cy0 + y) * FW + (cx0 + x)) * ch, d = (y * cw + x) * 3;
        origCrop[d] = rgb[s]; origCrop[d + 1] = rgb[s + 1]; origCrop[d + 2] = rgb[s + 2];
      }
    }
    const grayOf = (b) => sharp(b, { raw: { width: cw, height: chh, channels: 3 } }).resize(gw, gh, { fit: "fill" })
      .greyscale().raw().toBuffer({ resolveWithObject: true })
      .then((r) => {
        if (r.info.channels === 1) return r.data;
        const g = Buffer.alloc(gw * gh);
        for (let i = 0; i < gw * gh; i++) g[i] = r.data[i * r.info.channels];
        return g;
      });
    const [ga, gb] = await Promise.all([grayOf(origCrop), grayOf(ed)]);
    const ringIn = new Uint8Array(gw * gh), inner = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const a = sampleBilinear(alpha, cw, chh, (x + 0.5) / sc - 0.5, (y + 0.5) / sc - 0.5);
        inner[y * gw + x] = a > 0.5 ? 1 : 0;
        ringIn[y * gw + x] = a > 0.001 ? 1 : 0;
      }
    }
    const ringGrown = maxField(Float32Array.from(ringIn), gw, gh, Math.max(2, Math.round(0.04 * Math.max(gw, gh))));
    const ring = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) ring[i] = ringGrown[i] > 0 && !ringIn[i] ? 1 : 0;
    const S = Math.max(1, Math.round(HAND_REPAIR.SHIFT_MAX * gw));
    const sh0 = bestShift(ga, gb, ring, gw, gh, S);
    const sx = Math.round(sh0.dx / sc), sy = Math.round(sh0.dy / sc);

    // Yalnız maske içine yapıştır (kaydırılmış düzenleme).
    const outRgb = Buffer.from(rgb);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const a = alpha[y * cw + x];
        if (a <= 0.001) continue;
        const ex = Math.max(0, Math.min(cw - 1, x + sx)), ey = Math.max(0, Math.min(chh - 1, y + sy));
        const e = (ey * cw + ex) * 3, d = ((cy0 + y) * FW + (cx0 + x)) * ch;
        for (let k = 0; k < 3; k++) outRgb[d + k] = Math.round(rgb[d + k] * (1 - a) + ed[e + k] * a);
      }
    }
    const result = await sharp(outRgb, { raw: { width: FW, height: FH, channels: ch } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();

    // Doğrulama (ikisi de ölçülmüş olmalı): yapı (kaydırılmış düzenleme ↔ orijinal, maske
    // çekirdeğinde) ve ten farkı (yüzün yakını hariç).
    const gbShift = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const xx = Math.max(0, Math.min(gw - 1, x + sh0.dx)), yy = Math.max(0, Math.min(gh - 1, y + sh0.dy));
        gbShift[y * gw + x] = gb[yy * gw + xx];
      }
    }
    const struct = edgeNcc(ga, gbShift, gw, gh, inner);
    let gapAfter = null;
    try { gapAfter = limbGap(await analyzeSkin(result, { templateBuf: tpl }), st.neckExclusion); } catch { gapAfter = null; }
    const info2 = { gapAfter, struct, shift: [sx, sy] };
    if (struct == null) return skip("structure-unmeasured", info2);
    if (struct < HAND_REPAIR.STRUCT_MIN) return skip("structure", info2);
    if (gapAfter == null) return skip("tone-unmeasured", info2);
    if (Math.abs(gapAfter) > HAND_REPAIR.ACCEPT_GAP_MAX) return skip("tone", info2);
    return { ok: true, applied: true, buf: result, reason: null, ...info2 };
  } catch (e) {
    console.error("El onarımı bitişi hata verdi (kare olduğu gibi):", e.message || e);
    return skip("error");
  }
}

/**
 * Tek süreçte üç parça (yerel test; canlı akış falPhotos.handRepairStep). editFn verilirse
 * OpenAI yerine o çağrılır ({cropPng, maskPng, faceJpg, size, prompt} → Buffer).
 */
async function repairHands(buf, { apiKey, mstUser, mstTpl, rawBuf = null, tpl = null, sizeFor = null, editFn = null } = {}) {
  const t0 = Date.now();
  if (!HAND_REPAIR.ON) return skip("off");
  if (!eligible(mstUser, mstTpl)) return skip("pigment", { mstUser, mstTpl });
  const prep = await prepareHands({ buf, rawBuf, tpl });
  if (!prep.ok) return { ...prep, ms: Date.now() - t0 };
  const size = (sizeFor && sizeFor(prep.geo.cw, prep.geo.chh)) || null;
  let edited;
  if (editFn) {
    const [sw, sh] = size ? size.split("x").map(Number) : [prep.geo.cw, prep.geo.chh];
    const cropPng = await sharp(prep.cropPng).resize(sw, sh, { fit: "fill" }).png().toBuffer();
    const maskPng = await sharp(prep.maskPng).ensureAlpha().resize(sw, sh, { fit: "fill", kernel: "nearest" }).png().toBuffer();
    edited = await editFn({ cropPng, maskPng, faceJpg: prep.faceJpg, size: `${sw}x${sh}`, prompt: PROMPT });
  } else {
    edited = await editHands(prep, { apiKey, size });
  }
  if (!Buffer.isBuffer(edited)) return skip((edited && edited.error) || "no-output", { rawGap: prep.rawGap, gapBefore: prep.gapBefore });
  const fin = await finishHands({ buf, edited, alpha8: prep.alpha8, geo: prep.geo, tpl });
  return { ...fin, rawGap: prep.rawGap, gapBefore: prep.gapBefore, areaVsFace: prep.areaVsFace, size, ms: Date.now() - t0 };
}

module.exports = {
  repairHands, prepareHands, editHands, finishHands, HAND_REPAIR, PROMPT,
  _testables: { eligible, limbGap, limbDiff, handsMatch, buildLimbMask, bestShift, edgeNcc, dropSmallComponents, faceGuard },
};
