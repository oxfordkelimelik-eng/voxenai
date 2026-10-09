// DOKU KOPYALAYAN DOLGU (2026-10-09, kullanıcı: "kafa küçültmede base foto
// kafası gözükmemeli; inpaint gerekiyorsa yapalım ama bulanıklık, bozma yok").
//
// Kafa küçülünce açılan halkanın şablonda kişi olan kısmı ne şablondan (şablon
// kişisinin saçı/gözlüğü) ne çıktıdan (eski büyük kafa) alınabilir. Difüzyon
// tabanlı inpaint (Telea/Navier-Stokes) birkaç pikselden kalın deliği
// bulanıklaştırır. Burada exemplar (Criminisi) yöntemi var: delik kenardan
// içe doğru, çevredeki GERÇEK piksellerden kopyalanan 9x9 parçalarla
// doldurulur — hiçbir piksel ortalanmaz, doku ve kenarlar (sütun, pencere,
// yaprak) olduğu gibi taşınır.

const PR = 4; // parça yarıçapı (9x9)

/**
 * img: RGB raw (W*H*3), YERİNDE değiştirilir.
 * hole: Uint8Array(W*H) — 1 = doldurulacak.
 * banned: Uint8Array(W*H) | null — ne kaynak ne bağlam olabilir (ör. eski kafa).
 * opts.searchR: aday parça arama yarıçapı (piksel).
 * opts.stats: verilirse dikiş ölçüsü yazılır (bkz. seam aşağıda).
 * Dönüş: doldurulan piksel sayısı.
 */
function patchFill(img, W, H, hole, banned = null, { searchR = 60, stats = null } = {}) {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let left = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!hole[y * W + x]) continue;
      left++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!left) return 0;
  // Çalışma penceresi: delik + arama yarıçapı + parça.
  const m = searchR + PR + 1;
  const wx0 = Math.max(0, x0 - m);
  const wy0 = Math.max(0, y0 - m);
  const wx1 = Math.min(W - 1, x1 + m);
  const wy1 = Math.min(H - 1, y1 + m);
  const w = wx1 - wx0 + 1;
  const h = wy1 - wy0 + 1;
  const N = w * h;
  // 0 = bilinmiyor (doldurulacak), 1 = bilinen, 2 = yasak (kullanılmaz).
  const st = new Uint8Array(N);
  const I = new Float32Array(N * 3);
  const conf = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gi = (y + wy0) * W + (x + wx0);
      const i = y * w + x;
      st[i] = hole[gi] ? 0 : banned && banned[gi] ? 2 : 1;
      conf[i] = st[i] === 1 ? 1 : 0;
      for (let c = 0; c < 3; c++) I[i * 3 + c] = img[gi * 3 + c];
    }
  }
  // Kaynak parça merkezleri: parçanın tamamı bilinen piksel. Delik dolarken
  // kaynak kümesi BÜYÜTÜLMEZ — doldurulmuş piksel tekrar kopyalanmaz (aynı
  // parçanın çoğalıp desen tekrarı üretmesini önler).
  const srcOk = new Uint8Array(N);
  {
    const bad = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += st[y * w + x] !== 1 ? 1 : 0;
        bad[(y + 1) * (w + 1) + x + 1] = bad[y * (w + 1) + x + 1] + row;
      }
    }
    const K = 2 * PR + 1;
    for (let y = PR; y < h - PR; y++) {
      for (let x = PR; x < w - PR; x++) {
        const a = (y - PR) * (w + 1) + (x - PR);
        const b = (y + PR + 1) * (w + 1) + (x - PR);
        if (bad[b + K] - bad[b] - bad[a + K] + bad[a] === 0) srcOk[y * w + x] = 1;
      }
    }
  }
  let srcCount = 0;
  for (let i = 0; i < N; i++) srcCount += srcOk[i];
  if (!srcCount) return 0;

  const lum = (i) => 0.299 * I[i * 3] + 0.587 * I[i * 3 + 1] + 0.114 * I[i * 3 + 2];
  const known = (x, y) => x >= 0 && y >= 0 && x < w && y < h && st[y * w + x] === 1;

  // Kenar (front) kümesi: bilinen komşusu olan bilinmeyen pikseller. Her
  // adımda yalnızca kopyalanan parçanın çevresi güncellenir.
  const inFront = new Uint8Array(N);
  let front = [];
  const checkFront = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    const f = st[i] === 0 && (known(x - 1, y) || known(x + 1, y) || known(x, y - 1) || known(x, y + 1));
    if (f && !inFront[i]) { inFront[i] = 1; front.push(i); }
    if (!f) inFront[i] = 0;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) checkFront(x, y);

  const priority = (i) => {
    const x = i % w;
    const y = (i - x) / w;
    let cs = 0;
    for (let dy = -PR; dy <= PR; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w) cs += conf[yy * w + xx];
      }
    }
    const C = cs / ((2 * PR + 1) * (2 * PR + 1));
    // Veri terimi: kenara dik gelen eşparlaklık çizgisi (sütun kenarı gibi
    // düz yapılar önce uzatılır).
    let nx = 0;
    let ny = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (st[yy * w + xx] === 0) { nx -= dx; ny -= dy; }
      }
    }
    let gx = 0;
    let gy = 0;
    if (known(x - 1, y) && known(x + 1, y)) gx = (lum(i + 1) - lum(i - 1)) / 2;
    else if (known(x - 2, y) && known(x - 1, y)) gx = lum(i - 1) - lum(i - 2);
    else if (known(x + 1, y) && known(x + 2, y)) gx = lum(i + 2) - lum(i + 1);
    if (known(x, y - 1) && known(x, y + 1)) gy = (lum(i + w) - lum(i - w)) / 2;
    else if (known(x, y - 2) && known(x, y - 1)) gy = lum(i - w) - lum(i - 2 * w);
    else if (known(x, y + 1) && known(x, y + 2)) gy = lum(i + 2 * w) - lum(i + w);
    const nl = Math.hypot(nx, ny) || 1;
    const D = Math.abs(-gy * (nx / nl) + gx * (ny / nl)) / 255;
    return { P: C * (0.2 + D), C };
  };

  // Her doldurulan pikselin kopyalandığı kaynağa kayması (tutarlı kopya
  // adayı) ve kaynak merkezlerinin kullanım sayısı (tekrar cezası).
  // 03d6c1f6 c2: tek bir koyu parça onlarca kez kopyalanıp karo desenli
  // koyu leke üretti.
  const srcOf = new Int32Array(N).fill(-1); // doldurulan pikselin kaynak pikseli
  const offX = new Int16Array(N);
  const offY = new Int16Array(N);
  const hasOff = new Uint8Array(N);
  const uses = new Uint16Array(N);
  const REUSE = 40; // bilinen piksel başına, kullanım başına ek kare fark
  const COHERE = 0.85; // komşunun kaymasını sürdüren adayın maliyet çarpanı

  let filled = 0;
  let guard = left + 100;
  while (left > 0 && guard-- > 0) {
    front = front.filter((i) => inFront[i] && st[i] === 0);
    if (!front.length) break;
    let best = -1;
    let bestP = -1;
    let bestC = 0;
    for (const i of front) {
      const { P, C } = priority(i);
      if (P > bestP) { bestP = P; best = i; bestC = C; }
    }
    const tx = best % w;
    const ty = (best - tx) / w;

    // En iyi kaynak parça: bilinen piksellerde kare fark toplamı. Önce 2'lik
    // adımla, sonra en iyinin çevresinde tek piksel.
    let nKnown = 0;
    for (let dy = -PR; dy <= PR; dy++) {
      for (let dx = -PR; dx <= PR; dx++) if (known(tx + dx, ty + dy)) nKnown++;
    }
    const ssd = (sx, sy, cap) => {
      let s = uses[sy * w + sx] * REUSE * nKnown;
      if (s >= cap) return s;
      for (let dy = -PR; dy <= PR; dy++) {
        const ty2 = ty + dy;
        if (ty2 < 0 || ty2 >= h) continue;
        for (let dx = -PR; dx <= PR; dx++) {
          const tx2 = tx + dx;
          if (tx2 < 0 || tx2 >= w) continue;
          const ti = ty2 * w + tx2;
          if (st[ti] !== 1) continue;
          const si = ((sy + dy) * w + (sx + dx)) * 3;
          const a = I[ti * 3] - I[si];
          const b = I[ti * 3 + 1] - I[si + 1];
          const c = I[ti * 3 + 2] - I[si + 2];
          s += a * a + b * b + c * c;
          if (s >= cap) return s;
        }
      }
      // Hafif uzaklık cezası: eşit eşleşmede yakın parça tercih edilir.
      return s + 0.5 * ((sx - tx) * (sx - tx) + (sy - ty) * (sy - ty));
    };
    let bs = Infinity;
    let bx = -1;
    let by = -1;
    const scan = (r, step) => {
      const sx0 = Math.max(PR, tx - r);
      const sx1 = Math.min(w - 1 - PR, tx + r);
      const sy0 = Math.max(PR, ty - r);
      const sy1 = Math.min(h - 1 - PR, ty + r);
      for (let sy = sy0; sy <= sy1; sy += step) {
        for (let sx = sx0; sx <= sx1; sx += step) {
          if (!srcOk[sy * w + sx]) continue;
          const v = ssd(sx, sy, bs);
          if (v < bs) { bs = v; bx = sx; by = sy; }
        }
      }
    };
    scan(searchR, 2);
    if (bx < 0) scan(Math.max(w, h), 2); // yarıçapta kaynak yok: tüm pencere
    if (bx < 0) break;
    // Tutarlı kopya: parçadaki doldurulmuş komşuların kaymaları da aday.
    // Kazanırsa çevresiyle aynı kaynak bölgeden bitişik kopyalanır (karo
    // tekrarı yerine kaynak dokunun kendi sürekliliği taşınır).
    {
      const seen = new Set();
      for (let dy = -PR; dy <= PR; dy += 2) {
        for (let dx = -PR; dx <= PR; dx += 2) {
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const j = y * w + x;
          if (!hasOff[j]) continue;
          const key = offX[j] * 4096 + offY[j];
          if (seen.has(key)) continue;
          seen.add(key);
          const sx = tx + offX[j];
          const sy = ty + offY[j];
          if (sx < PR || sy < PR || sx >= w - PR || sy >= h - PR || !srcOk[sy * w + sx]) continue;
          const v = ssd(sx, sy, bs / COHERE) * COHERE;
          if (v < bs) { bs = v; bx = sx; by = sy; }
        }
      }
    }
    {
      const cx = bx;
      const cy = by;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = cx + dx;
          const sy = cy + dy;
          if (sx < PR || sy < PR || sx >= w - PR || sy >= h - PR || !srcOk[sy * w + sx]) continue;
          const v = ssd(sx, sy, bs);
          if (v < bs) { bs = v; bx = sx; by = sy; }
        }
      }
    }
    // Parçanın bilinmeyen piksellerini kopyala.
    for (let dy = -PR; dy <= PR; dy++) {
      for (let dx = -PR; dx <= PR; dx++) {
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const ti = y * w + x;
        if (st[ti] !== 0) continue;
        const si = (by + dy) * w + (bx + dx);
        for (let c = 0; c < 3; c++) I[ti * 3 + c] = I[si * 3 + c];
        st[ti] = 1;
        conf[ti] = bestC;
        srcOf[ti] = si;
        offX[ti] = bx - tx;
        offY[ti] = by - ty;
        hasOff[ti] = 1;
        left--;
        filled++;
      }
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = (by + dy) * w + (bx + dx);
        if (uses[j] < 65535) uses[j]++;
      }
    }
    for (let dy = -PR - 1; dy <= PR + 1; dy++) {
      for (let dx = -PR - 1; dx <= PR + 1; dx++) checkFront(tx + dx, ty + dy);
    }
  }
  if (stats) {
    // Dikiş: komşu iki piksel farklı yerlerden kopyalandıysa, birinin
    // kaynağının doğal komşusu ile ötekinin kaynağı arasındaki renk farkı.
    // Aynı kaymadan gelen ya da doğal olarak bitişik pikselde 0. Yamalı
    // görünen dolgu (perde çizgisi kırılması, tabela parçaları) yüksek çıkar.
    const sv = (j) => (st[j] !== 1 ? -1 : srcOf[j] >= 0 ? srcOf[j] : j);
    let sum = 0;
    let pairs = 0;
    let hi = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = y * w + x;
        if (srcOf[a] < 0) continue;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const b = yy * w + xx;
          const sb = sv(b);
          if (sb < 0) continue;
          const sa = srcOf[a];
          const sax = sa % w;
          const say = (sa - sax) / w;
          const nx = sax + dx;
          const ny = say + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (n === sb) { pairs++; continue; }
          if (st[n] !== 1 || srcOf[n] >= 0) continue; // kaynağın komşusu gerçek piksel değil
          const r = I[n * 3] - I[sb * 3];
          const g = I[n * 3 + 1] - I[sb * 3 + 1];
          const bl = I[n * 3 + 2] - I[sb * 3 + 2];
          const d = Math.sqrt(r * r + g * g + bl * bl);
          sum += d;
          pairs++;
          if (d > 40) hi++;
        }
      }
    }
    stats.seam = pairs ? sum / pairs : 0;
    stats.seamHi = pairs ? hi / pairs : 0;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gi = (y + wy0) * W + (x + wx0);
      if (!hole[gi]) continue;
      const i = y * w + x;
      for (let c = 0; c < 3; c++) img[gi * 3 + c] = Math.max(0, Math.min(255, Math.round(I[i * 3 + c])));
    }
  }
  return filled;
}

module.exports = { patchFill, PATCH_R: PR };
