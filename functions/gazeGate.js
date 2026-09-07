/**
 * Taban vs çıktı bakış karşılaştırması.
 *
 * Vision BASE_GAZE / OUTPUT_GAZE satırlarını üretir; 2026-09-06'da eleme
 * yapılmadı çünkü 4 uyuşmazlığın 3'ü tabanın yanlış okunmasıydı. 2026-09-07
 * işi b1d6972b bunu boşa çıkardı: teslim edilen chunk 0'da satırlar
 * CAMERA / RIGHT idi, kullanıcı "tabanla aynı yere bakmıyor" dedi ve kare
 * geçti. Artık iki satır da okunabiliyorsa ve farklıysa kare elenir.
 *
 * Satır yoksa / AWAY belirsizse fail-safe: eleme YOK. AWAY, yönün
 * okunamadığı kaçış kapısıdır; belirsiz ölçümle kare elenmez.
 */

const GAZE_TOKENS = ["CAMERA", "LEFT", "RIGHT", "UP", "DOWN", "AWAY"];

function parseGazeToken(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const up = line.toUpperCase();
  for (const tok of GAZE_TOKENS) {
    if (new RegExp(`(?:^|:)\\s*${tok}\\b`).test(up)) return tok;
  }
  return null;
}

function isGazeMismatch(baseLine, outputLine) {
  const base = parseGazeToken(baseLine);
  const out = parseGazeToken(outputLine);
  if (!base || !out) return false;
  // AWAY = yön okunamadı. Belirsiz ölçümle eleme yok.
  if (base === "AWAY" || out === "AWAY") return false;
  return base !== out;
}

// İris kayması — kaba CAMERA/LEFT sınıfı aynı kalsa bile gözbebeği
// yer değiştirmişse bakış aynı yerde değildir (b1d6972b c1/c2/c3).
const IRIS_MISMATCH_X = 0.07;
const IRIS_MISMATCH_Y = 0.10;
const IRIS_MIN_EYE_PX = 10;

/** Göz çokgeni içindeki koyu piksellerin ağırlıklı merkezi → 0..1 x/y. */
function irisOffsetFromGray(gray, w, h, pts) {
  if (!gray || !pts || pts.length < 4) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 6 || bh < 3) return null;
  const vals = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) vals.push(gray[y * w + x]);
  }
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(vals.length * 0.25)];
  let sx = 0, sy = 0, sw = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = gray[y * w + x];
      if (v > cut) continue;
      const weight = cut - v + 1;
      sx += x * weight;
      sy += y * weight;
      sw += weight;
    }
  }
  if (sw === 0) return null;
  return { x: (sx / sw - x0) / bw, y: (sy / sw - y0) / bh, width: bw, height: bh };
}

function isIrisGazeMismatch(base, out) {
  if (!base || !out) return false;
  if (base.irisX == null || out.irisX == null) return false;
  const minW = Math.min(base.eyeWidth || 0, out.eyeWidth || 0);
  if (minW < IRIS_MIN_EYE_PX) return false;
  const dx = Math.abs(out.irisX - base.irisX);
  const dy = (base.irisY != null && out.irisY != null)
    ? Math.abs(out.irisY - base.irisY)
    : 0;
  return dx >= IRIS_MISMATCH_X || dy >= IRIS_MISMATCH_Y;
}

module.exports = {
  parseGazeToken,
  isGazeMismatch,
  irisOffsetFromGray,
  isIrisGazeMismatch,
  GAZE_TOKENS,
  IRIS_MISMATCH_X,
  IRIS_MISMATCH_Y,
  IRIS_MIN_EYE_PX,
};
