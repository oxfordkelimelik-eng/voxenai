// ŞABLON İZİ DETEKTÖRÜ (2026-11-06) — ghostClean'in kare düzeyi "iz var mı,
// nerede" kararı. Ücretsiz, yerel: kulaklık detektörüyle aynı OWLv2 ONNX
// modelinin (bkz. earbuds.js, Storage ml_models/) yama gömmeleri + doğrusal
// sonda (models/ghostdet/probe_v1.json: PCA 48 + lojistik).
//
// NEDEN: piksel ipuçları izli/izsiz kareyi ayırmıyordu (125 etiketli kare,
// en iyi AUC 0.84, sıfır yanlış alarmda 5/20); canlıdaki gpt-4.1 kafa kalıntı
// kapısı aynı veri setinde belirgin izli 15 karenin 15'ini GEÇİRMİŞTİ (log).
// Sonda, iş bazında dışarıda bırakmalı doğrulamada belirgin izde AUC 0.91,
// 2/91 yanlış alarmda 11/20. Eğitim: çoklu örnek (izli karede hangi yamanın iz
// olduğu bilinmiyor) — 2 tur, her izli karede en yüksek %10 yama pozitif.
// Detektörlü temizlik 13 tetiklenen karede iki bağımsız kör incelemede 10'unda
// canlıdan iyi, hiçbirinde kalıntı yok (ciktilar/2026-11-04_siluet/blind).
//
// Bölgeler (ghostClean hesaplar, bkz. cleanTemplateGhost): R = şablon kafası,
// beklenen kafa dışı, opak kafa/deri dışı (eğitim + kare skoru); bant = beklenen
// kafa içi aynı koşullar (yalnız harita). Yama payı ≥ ZONE_MIN.
//
// Yalnız worker iş parçacığında çağrılır (postWorker: onnxruntime run()
// olay döngüsünü bloklar).

const sharp = require("sharp");

const SIZE = 960;
const GRID = 60;
const SEQ = 16;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const ZONE_MIN = 0.25;
// Kare skoru (R yamalarının en yükseği) eşiği: iş bazında dışarıda bırakmalı
// skorlarda izsiz 91 karenin 2'si üstünde (a4433ad1 c5 4.39, 3d1d2a71 c6 4.20).
// 3.5 → 2.0 (2026-11-18, 156fa173 c4): yukarı bakan şablonda bukle izi kafa
// tepesinde kaldı, skor 2.31. Son 4 işin 39 karesinde (teslim + reddedilen)
// kör karşılaştırma: 2 net iyileşme (c4 bukleler, c5 tepede soluk iz), 2
// görünmez fark (bukle içinde ~200 px), 2 aynı, 33 dokunulmadı; kafa kesiği yok.
// 2.0 → 3.5 GERİ ALINDI (2026-11-19, 248a0e72 c8, kullanıcı: "yüzün sağ üstü
// bulanmış"): skor 2.24'te sıcak yol kafa yanındaki köprü kafesi/ağaç dokusunu
// yüz alanının %44'ü kadar iz sayıp LaMa ile doldurdu → bulanık leke. Test
// kümesindeki kazanımlar düz zeminde (gök, taş duvar); dokulu zeminde LaMa
// yeniden çizemiyor. Düşük eşik ancak zemin dokusu kapısıyla birlikte dönmeli.
const FRAME_TAU = 3.5;
// Yama eşiği (ghostClean.hotMaskOf histerezisi bunun HOT_HYST altına iner).
const PATCH_TAU = 2.0;

let probe = null;
function loadProbe() {
  if (!probe) {
    const m = require("./models/ghostdet/probe_v1.json");
    probe = { ...m, mu: Float64Array.from(m.mu), comps: m.comps.map((c) => Float64Array.from(c)), m2: Float64Array.from(m.m2), sd: Float64Array.from(m.sd), w: Float64Array.from(m.w) };
  }
  return probe;
}

let sessionP = null;
function session() {
  if (!sessionP) {
    sessionP = (async () => {
      const ort = require("onnxruntime-node");
      const modelPath = await require("./earbuds").modelPath();
      // ARENA KAPALI (bkz. earbudCore.js, hafıza onnx-arena-memory).
      const s = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all",
        enableCpuMemArena: false,
      });
      return { ort, s };
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

/** n×n kırpımın OWLv2 yama gömmeleri: Float32Array (GRID²·D) ve D. */
async function patchEmbeds(rgb, n) {
  const { ort, s } = await session();
  const img = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width: n, height: n, channels: 3 } })
    .resize(SIZE, SIZE).raw().toBuffer();
  const S = SIZE * SIZE, pv = new Float32Array(3 * S);
  for (let i = 0; i < S; i++) for (let c = 0; c < 3; c++) pv[c * S + i] = (img[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  // Görüntü gömmesi metin sorgusundan bağımsız; model girdisi için tek sorgu ("hair").
  const ids = new BigInt64Array(SEQ), mask = new BigInt64Array(SEQ);
  [49406, 2225, 49407].forEach((v, i) => { ids[i] = BigInt(v); mask[i] = 1n; });
  const out = await s.run({
    input_ids: new ort.Tensor("int64", ids, [1, SEQ]),
    attention_mask: new ort.Tensor("int64", mask, [1, SEQ]),
    pixel_values: new ort.Tensor("float32", pv, [1, 3, SIZE, SIZE]),
  });
  const e = out.image_embeds;
  return { E: e.data, D: e.dims[e.dims.length - 1] };
}

/** Yama başına bölge payları (n×n maske → GRID² dizisi). SAF. */
function zoneCover(mask, n) {
  const cov = new Float32Array(GRID * GRID), cell = n / GRID;
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    let c = 0, t = 0;
    for (let y = Math.floor(gy * cell); y < Math.floor((gy + 1) * cell); y++) for (let x = Math.floor(gx * cell); x < Math.floor((gx + 1) * cell); x++) { if (mask[y * n + x]) c++; t++; }
    cov[gy * GRID + gx] = c / Math.max(1, t);
  }
  return cov;
}

/** Tek yama gömmesinin sonda skoru (lojit). SAF. */
function probeScore(P, e) {
  let nn = 0;
  for (let j = 0; j < P.D; j++) nn += e[j] * e[j];
  nn = Math.sqrt(nn) || 1;
  let z = P.w[P.K];
  for (let c = 0; c < P.K; c++) {
    const comp = P.comps[c];
    let s = 0;
    for (let j = 0; j < P.D; j++) s += (e[j] / nn - P.mu[j]) * comp[j];
    z += P.w[c] * ((s - P.m2[c]) / P.sd[c]);
  }
  return z;
}

/**
 * Skorlar → ghostClean hotPatches biçimi ya da null (kare eşiği geçilmedi). SAF.
 * covR/covB: GRID² bölge payları, score(p): yama skoru.
 */
function decide(covR, covB, score, { frameTau = FRAME_TAU, patchTau = PATCH_TAU } = {}) {
  const scores = new Array(GRID * GRID).fill(null);
  let frameScore = -Infinity;
  for (let p = 0; p < GRID * GRID; p++) {
    const inR = covR[p] >= ZONE_MIN, inB = covR[p] + covB[p] >= ZONE_MIN;
    if (!inB) continue;
    const s = score(p);
    scores[p] = s;
    if (inR && s > frameScore) frameScore = s;
  }
  if (!(frameScore >= frameTau)) return { hot: null, frameScore };
  return { hot: { grid: GRID, scores, tau: patchTau, frameScore }, frameScore };
}

/**
 * ghostClean.ghostScorer: ({ oC, n, zoneR, zoneB }) → hotPatches | null.
 * Hata fırlatırsa ghostClean detektörsüz (v28) devam eder.
 */
async function scoreGhost({ oC, n, zoneR, zoneB }) {
  const P = loadProbe();
  const covR = zoneCover(zoneR, n), covB = zoneCover(zoneB, n);
  let any = false;
  for (let p = 0; p < GRID * GRID; p++) if (covR[p] >= ZONE_MIN) { any = true; break; }
  if (!any) return { hot: null, frameScore: null };
  const { E, D } = await patchEmbeds(oC, n);
  if (D !== P.D) throw new Error(`ghostDetect: gömme boyu ${D} ≠ ${P.D}`);
  return decide(covR, covB, (p) => probeScore(P, E.subarray(p * D, (p + 1) * D)));
}

// owlSession: şablon şapka detektörü (hatDetect.js, 2026-11-06) aynı oturumu
// kullanır — aynı worker'da ikinci bir OWLv2 kopyası açılmasın.
module.exports = { scoreGhost, owlSession: session, _testables: { zoneCover, probeScore, decide, loadProbe, GRID, ZONE_MIN, FRAME_TAU, PATCH_TAU } };
