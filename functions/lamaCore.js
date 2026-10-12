// LaMa çekirdeği: oturum ve 512'lik parça döngüsü. Yalnızca LaMa worker iş
// parçacığında çalışır (bkz. lamaWorker.js) — onnxruntime-node'un run()
// çağrısı olay döngüsünü bloklar (ölçüldü: 7.6 sn boyunca tek tik yok),
// ana iş parçacığında diğer karelerin ağ çağrılarını dondururdu.

const S = 512;
// Parça kenarından bu kadar içerisi kabul edilir (kenarda bağlam eksik).
const MARGIN = 64;

let sessionP = null;

function session(modelPath) {
  if (!sessionP) {
    sessionP = (async () => {
      const ort = require("onnxruntime-node");
      const s = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all",
      });
      return { ort, s };
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

async function runTile(modelPath, rgb, w, x0, y0, need) {
  const { ort, s } = await session(modelPath);
  const I = new Float32Array(3 * S * S);
  const M = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const g = (y + y0) * w + x + x0;
      if (need[g]) { M[i] = 1; continue; }
      for (let c = 0; c < 3; c++) I[c * S * S + i] = rgb[g * 3 + c] / 255;
    }
  }
  const out = await s.run({ image: new ort.Tensor("float32", I, [1, 3, S, S]), mask: new ort.Tensor("float32", M, [1, 1, S, S]) });
  return out[Object.keys(out)[0]].data;
}

/** Bir eksende maskenin [a0, a1] aralığını kaplayan parça başlangıçları. SAF. */
function tileStarts(a0, a1, n) {
  const out = [];
  if (a1 - a0 + 1 + 2 * MARGIN <= S) out.push(Math.round((a0 + a1) / 2 - S / 2));
  else for (let p = a0 - MARGIN; ; p += S - 2 * MARGIN) { out.push(p); if (p + S - MARGIN > a1) break; }
  return [...new Set(out.map((p) => Math.max(0, Math.min(n - S, p))))];
}

/**
 * rgb (Uint8Array w*h*3) içinde mask=1 piksellerini doldurur, yerinde.
 * w, h >= 512. Dönüş: çalıştırılan parça sayısı.
 */
async function fillNative(modelPath, rgb, w, h, mask) {
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) return 0;
  const need = Uint8Array.from(mask);
  const xs = tileStarts(bx0, bx1, w);
  const ys = tileStarts(by0, by1, h);
  let runs = 0;
  // İlk turda yalnız parçanın iç kısmı (ya da görüntü kenarı) kabul edilir;
  // kalan pikseller ikinci turda, önceki dolgular bağlamken dolar.
  for (let pass = 0; pass < 2; pass++) {
    for (const y0 of ys) {
      for (const x0 of xs) {
        let any = false;
        for (let y = 0; y < S && !any; y++) for (let x = 0; x < S; x++) if (need[(y + y0) * w + x + x0]) { any = true; break; }
        if (!any) continue;
        const o = await runTile(modelPath, rgb, w, x0, y0, need);
        runs++;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const g = (y + y0) * w + x + x0;
            if (!need[g]) continue;
            const inner = pass === 1 ||
              ((x >= MARGIN || x0 === 0) && (x < S - MARGIN || x0 + S === w) &&
               (y >= MARGIN || y0 === 0) && (y < S - MARGIN || y0 + S === h));
            if (!inner) continue;
            for (let c = 0; c < 3; c++) {
              const v = o[c * S * S + y * S + x];
              rgb[g * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
            }
            need[g] = 0;
          }
        }
      }
    }
    if (!need.some((v) => v)) break;
  }
  return runs;
}

/** Oturumu açar (ısınma). */
async function warm(modelPath) {
  await session(modelPath);
}

module.exports = { fillNative, warm, tileStarts, S, MARGIN };
