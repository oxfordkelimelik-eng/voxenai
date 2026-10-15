// YÜZ GÖLGELEME AKTARIMI (2026-10-15, kullanıcı: "base fotodaki ışık yapısının
// aynısı çıktıya yansımalı; tek bir düz eğim yerine detaylı çalışma").
//
// NEDEN: faceLight.transferFaceLight yüze tek bir doğrusal eğim taşıyor (ışık
// hangi yandan). Burnun yan gölgesi, göz çukuru, elmacık kemiği parlaması,
// alının üstten ışıkla parlaması gibi YAPI taşınamıyor; model yüzü selfie'deki
// gibi önden, düz çiziyor. 2026-10-08'de serbest gölgeleme haritası denendi:
// şablon kişisinin ayrıntılarını taşıdı (güneş gözlüğü camı alında turuncu
// leke, koyu tenin parlamaları yağlı yüz) — bu yüzden düzleme geçilmişti.
//
// YÖNTEM: 68 yüz noktasına genel bir 3B yüz şekli (kanonik derinlik) oturtulur
// ve her pikselde yüzeyin yönü (normal) çıkar. Işık, normallerin 2. dereceden
// küresel harmonikleriyle (9 katsayı) modellenir: Y ≈ Σ l_k·H_k(n). Şablon ve
// çıktı için l ayrı ayrı (kendi geometrileriyle, sağlam regresyonla)
// öğrenilir; çıktı, ÇIKTININ KENDİ normallerinde H·l_şablon / H·l_çıktı oranıyla
// çarpılır. Şablondan yalnızca 9 sayı geçtiği için onun kişisine ait hiçbir
// ayrıntı (gözlük camı, parlama, sakal) taşınamaz; burun gölgesi ise çıktının
// kendi burnunun yanına düşer. Ortalama korunur — yüz parlaklığı
// faceLight.matchFaceExposure'ın işi.

const sharp = require("sharp");

// Kanonik ön yüz: göz merkezleri arası = 1, gözlerin ortası (0,0), y aşağı.
// cbdbef13'teki 14 önden yüzün hizalanmış ortalaması, simetrikleştirilmiş.
const CANON_2D = [[-1.1675,-0.0023],[-1.1419,0.301],[-1.0851,0.593],[-1.0241,0.8513],[-0.9149,1.1402],[-0.7581,1.3671],[-0.5711,1.5147],[-0.3485,1.667],[0,1.756],[0.3485,1.667],[0.5711,1.5147],[0.7581,1.3671],[0.9149,1.1402],[1.0241,0.8513],[1.0851,0.593],[1.1419,0.301],[1.1675,-0.0023],[-0.9197,-0.2593],[-0.7824,-0.3497],[-0.6045,-0.3733],[-0.4384,-0.3509],[-0.2888,-0.3031],[0.2888,-0.3031],[0.4384,-0.3509],[0.6045,-0.3733],[0.7824,-0.3497],[0.9197,-0.2593],[0,0.0253],[0,0.2307],[0,0.4137],[0,0.591],[-0.1853,0.7098],[-0.1031,0.7331],[0,0.7611],[0.1031,0.7331],[0.1853,0.7098],[-0.6942,-0.011],[-0.5939,-0.0553],[-0.4411,-0.0605],[-0.3058,0.011],[-0.4242,0.0547],[-0.5851,0.059],[0.3058,0.011],[0.4411,-0.0605],[0.5939,-0.0553],[0.6942,-0.011],[0.5851,0.059],[0.4242,0.0547],[-0.3988,1.0818],[-0.2582,1.0112],[-0.0849,0.9582],[0,0.9719],[0.0849,0.9582],[0.2582,1.0112],[0.3988,1.0818],[0.2531,1.1816],[0.129,1.2338],[0,1.2503],[-0.129,1.2338],[-0.2531,1.1816],[-0.3653,1.0826],[-0.1216,1.059],[0,1.0595],[0.1216,1.059],[0.3653,1.0826],[0.116,1.1013],[0,1.112],[-0.116,1.1013]];
// Kameraya doğru çıkıntı (aynı birim), dış göz köşesi = 0. Ortalama yüz
// oranlarından yaklaşık: burun ucu ~3.5 cm, kulak hizası ~-6 cm (göz arası 6.3 cm).
const PROT = [
  -0.95, -0.85, -0.7, -0.5, -0.3, -0.1, 0.1, 0.25, 0.32, 0.25, 0.1, -0.1, -0.3, -0.5, -0.7, -0.85, -0.95,
  0.02, 0.12, 0.2, 0.25, 0.26, 0.26, 0.25, 0.2, 0.12, 0.02,
  0.3, 0.38, 0.46, 0.56,
  0.3, 0.38, 0.42, 0.38, 0.3,
  0, 0.12, 0.14, 0.18, 0.14, 0.12,
  0.18, 0.14, 0.12, 0, 0.12, 0.14,
  0.25, 0.36, 0.42, 0.45, 0.42, 0.36, 0.25,
  0.33, 0.38, 0.4, 0.38, 0.33,
  0.24, 0.38, 0.41, 0.38, 0.24,
  0.36, 0.39, 0.36,
];
// Yüz noktalarının kapsamadığı alın, şakak ve yanak için yardımcı noktalar.
const EXTRA = [
  ...Array.from({ length: 10 }, (_, k) => [CANON_2D[17 + k][0], CANON_2D[17 + k][1] - 0.38, PROT[17 + k] - 0.03]),
  [-0.85, -0.98, -0.5], [-0.45, -1.1, 0.02], [0, -1.13, 0.12], [0.45, -1.1, 0.02], [0.85, -0.98, -0.5],
  [-1.14, -0.42, -0.85], [1.14, -0.42, -0.85],
  [-0.64, 0.4, 0.08], [0.64, 0.4, 0.08], [-0.34, 0.64, 0.27], [0.34, 0.64, 0.27],
  [-0.84, 0.8, -0.28], [0.84, 0.8, -0.28], [-0.6, 1.02, 0.08], [0.6, 1.02, 0.08],
];

// Çalışma çözünürlüğü: yüz genişliği (≈2.3 göz arası) bu kadar piksel.
const WORK_FACE_PX = 180;
// Kazanç sınırları ve kenar yumuşatması (yüz genişliği cinsinden).
const GAIN_MIN = 0.6;
const GAIN_MAX = 1.6;
const EDGE_SIGMA = 0.04;
const GAIN_SMOOTH = 0.03;
// 2. derece katsayıların sırt cezası (örnek sayısı × bu); kaba geometride
// aşırı uyumu önler.
const RIDGE_ORDER2 = 0.02;
// Uygulama eşikleri.
const MAX_YAW = 0.75;
const MIN_FIT_PX = 300;
const APPLY_MIN_DIFF = 0.03;
const EYEWEAR_RATIO_MAX = 0.55;
// Işık öğrenmeye girecek pikselin yüz derisi olasılığı.
const SKIN_P_MIN = 0.5;
// Şablon ışığını model bu kadar açıklayamıyorsa (koyu tende güçlü parlama,
// karışık ışık) aktarılmaz: cbdbef13'te R² 0.04-0.33 olan 4 karede benzerlik
// hafifçe düştü (03, 15, 20, 22), 0.39+ olanların hiçbirinde düşmedi.
const MIN_TEMPLATE_R2 = 0.35;

let _tris = null;
function canonVerts() {
  const v = CANON_2D.map(([x, y], i) => [x, y, -PROT[i]]);
  for (const [x, y, p] of EXTRA) v.push([x, y, -p]);
  return v;
}

/** Bowyer–Watson Delaunay üçgenlemesi (2B). SAF. */
function delaunay(P) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of P) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const pts = P.concat([[mx - d, my - d], [mx + d, my - d], [mx, my + d]]);
  const n = P.length;
  const circ = (a, b, c) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx, cy] = pts[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [{ v: [n, n + 1, n + 2], ...circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const bad = [], keep = [];
    for (const t of tris) ((px - t.ux) ** 2 + (py - t.uy) ** 2 < t.r2 ? bad : keep).push(t);
    const edges = new Map();
    for (const t of bad) {
      for (const [a, b] of [[t.v[0], t.v[1]], [t.v[1], t.v[2]], [t.v[2], t.v[0]]]) {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(k, edges.has(k) ? null : [a, b]);
      }
    }
    tris = keep;
    for (const e of edges.values()) if (e) tris.push({ v: [e[0], e[1], i], ...circ(e[0], e[1], i) });
  }
  return tris.filter((t) => t.v.every((k) => k < n)).map((t) => t.v);
}

function triangles() {
  if (!_tris) _tris = delaunay(canonVerts().map(([x, y]) => [x, y]));
  return _tris;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Kanonik köşe normalleri (kameraya bakan, z<0). SAF. */
function vertexNormals(V, T) {
  const N = V.map(() => [0, 0, 0]);
  for (const [a, b, c] of T) {
    const e1 = [V[b][0] - V[a][0], V[b][1] - V[a][1], V[b][2] - V[a][2]];
    const e2 = [V[c][0] - V[a][0], V[c][1] - V[a][1], V[c][2] - V[a][2]];
    let n = cross(e1, e2);
    if (n[2] > 0) n = [-n[0], -n[1], -n[2]];
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) N[k][j] += n[j];
  }
  return N.map(unit);
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Zayıf perspektif poz: görüntü noktası = s·(R·X)[x,y] + t. Afin en küçük
 * kareler + satırların dik birimlenmesi. SAF.
 */
function fitPose(img, X) {
  const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const bx = [0, 0, 0, 0], by = [0, 0, 0, 0];
  for (let i = 0; i < img.length; i++) {
    const r = [X[i][0], X[i][1], X[i][2], 1];
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) A[a][b] += r[a] * r[b];
      bx[a] += r[a] * img[i].x; by[a] += r[a] * img[i].y;
    }
  }
  const mx = solve(A, bx), my = solve(A, by);
  if (!mx || !my) return null;
  const m1 = mx.slice(0, 3), m2 = my.slice(0, 3);
  const s1 = Math.hypot(...m1), s2 = Math.hypot(...m2);
  const r1 = m1.map((v) => v / s1);
  const d = m2[0] * r1[0] + m2[1] * r1[1] + m2[2] * r1[2];
  const r2 = unit([m2[0] - d * r1[0], m2[1] - d * r1[1], m2[2] - d * r1[2]]);
  const r3 = cross(r1, r2);
  return { s: (s1 + s2) / 2, R: [r1, r2, r3], t: [mx[3], my[3]] };
}
const rot = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];

/** 2. derece küresel harmonik tabanı. */
const shBasis = (n) => [1, n[0], n[1], n[2], n[0] * n[1], n[0] * n[2], n[1] * n[2], n[0] * n[0] - n[1] * n[1], 3 * n[2] * n[2] - 1];

/** Işık öğrenme bölgesi, kanonik koordinatta: göz, kaş, burun deliği/bıyık, sakal ve dudak dışarıda. SAF. */
function fitRegion(cx, cy) {
  if (((Math.abs(cx) - 0.5) / 0.3) ** 2 + (cy / 0.17) ** 2 < 1) return false;
  if (cy > -0.52 && cy < -0.2 && Math.abs(cx) > 0.15 && Math.abs(cx) < 1.0) return false;
  if (Math.abs(cx) < 0.45 && cy > 0.62) return false;
  if (cy > 0.8) return false;
  return true;
}

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const linToSrgb8 = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
};

/**
 * Yüzü çalışma penceresinde rasterleştirir: her pikselde görüntü uzayı normali,
 * kanonik koordinat ve geçerlilik. rgb: tam kare W×H×3.
 */
async function rasterizeFace(rgb, W, H, pts) {
  const V = canonVerts();
  const T = triangles();
  const pose = fitPose(pts, V.slice(0, 68));
  if (!pose) return null;
  const { s, R, t } = pose;
  const proj = (v) => { const r = rot(R, v); return { x: s * r[0] + t[0], y: s * r[1] + t[1], z: s * r[2] }; };
  const img = V.map((v, i) => (i < 68 ? { x: pts[i].x, y: pts[i].y, z: proj(v).z } : proj(v)));
  const VN = vertexNormals(V, T).map((n) => rot(R, n));
  const eyeD = Math.hypot((pts[42].x + pts[45].x - pts[36].x - pts[39].x) / 2, (pts[42].y + pts[45].y - pts[36].y - pts[39].y) / 2);
  const faceW = eyeD * 2.3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of img) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = faceW * 0.1;
  const L0 = Math.max(0, Math.floor(x0 - pad)), T0 = Math.max(0, Math.floor(y0 - pad));
  const R0 = Math.min(W, Math.ceil(x1 + pad)), B0 = Math.min(H, Math.ceil(y1 + pad));
  if (R0 - L0 < 8 || B0 - T0 < 8) return null;
  const k = Math.min(1, WORK_FACE_PX / faceW);
  const w = Math.max(8, Math.round((R0 - L0) * k)), h = Math.max(8, Math.round((B0 - T0) * k));
  const crop = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: L0, top: T0, width: R0 - L0, height: B0 - T0 }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const N = new Float32Array(w * h * 3), CX = new Float32Array(w * h), CY = new Float32Array(w * h);
  const Z = new Float32Array(w * h).fill(Infinity);
  const valid = new Uint8Array(w * h);
  const q = img.map((p) => ({ x: (p.x - L0) * k - 0.5, y: (p.y - T0) * k - 0.5, z: p.z }));
  for (const [a, b, c] of T) {
    const A = q[a], B = q[b], C = q[c];
    const area = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    if (Math.abs(area) < 1e-6) continue;
    // Görüntüde yönü kanonikteki yönün tersine dönen üçgen arkadan görünüyordur.
    const canonFacing = (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) - (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
    if ((canonFacing > 0) !== (area > 0)) continue;
    const bx0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), bx1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
    const by0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), by1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const w0 = ((B.x - x) * (C.y - y) - (B.y - y) * (C.x - x)) / area;
        const w1 = ((C.x - x) * (A.y - y) - (C.y - y) * (A.x - x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const i = y * w + x;
        const z = w0 * A.z + w1 * B.z + w2 * C.z;
        if (z >= Z[i]) continue;
        Z[i] = z;
        const n = unit([0, 1, 2].map((j) => w0 * VN[a][j] + w1 * VN[b][j] + w2 * VN[c][j]));
        N[i * 3] = n[0]; N[i * 3 + 1] = n[1]; N[i * 3 + 2] = n[2];
        CX[i] = w0 * V[a][0] + w1 * V[b][0] + w2 * V[c][0];
        CY[i] = w0 * V[a][1] + w1 * V[b][1] + w2 * V[c][1];
        valid[i] = 1;
      }
    }
  }
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    Y[i] = 0.2126 * SRGB2LIN[crop[i * 3]] + 0.7152 * SRGB2LIN[crop[i * 3 + 1]] + 0.0722 * SRGB2LIN[crop[i * 3 + 2]];
  }
  // YÜZ DERİSİ OLASILIĞI (cbdbef13 c8): kanonik alının üstü saça taşıyor; koyu
  // saç "karanlık alın" sayılıp ışık aşağıdan öğrenildi. Segmentasyon yoksa
  // ya da deriyi bulamazsa (siyah-beyaz, çok karanlık) null — bölge kuralı kalır.
  let SK = null;
  try {
    const { classProbs, CLASSES } = require("./skinSeg");
    SK = (await classProbs(crop, w, h))[CLASSES.faceSkin];
  } catch (e) {
    SK = null;
  }
  return { w, h, k, L0, T0, R0, B0, N, CX, CY, valid, Y, SK, faceW, pose };
}

/** Sağlam (Huber) sırt regresyonuyla küresel harmonik ışık katsayıları. */
function fitPixels(ras) {
  const { w, h, N, CX, CY, valid, SK } = ras;
  const all = [];
  for (let i = 0; i < w * h; i++) {
    if (!valid[i] || N[i * 3 + 2] > -0.2) continue;
    if (!fitRegion(CX[i], CY[i])) continue;
    all.push(i);
  }
  if (!SK) return all;
  const skin = all.filter((i) => SK[i] > SKIN_P_MIN);
  return skin.length >= MIN_FIT_PX ? skin : all;
}

function fitLight(ras) {
  const { N, Y } = ras;
  const idx = fitPixels(ras);
  if (idx.length < MIN_FIT_PX) return null;
  // Parlama (üst %2) ve neredeyse siyah pikseller (gözlük, saç) dışarıda.
  const ys = idx.map((i) => Y[i]).sort((a, b) => a - b);
  const hi = ys[Math.floor(ys.length * 0.98)], lo = Math.max(ys[Math.floor(ys.length * 0.02)], 1e-4);
  const med = ys[Math.floor(ys.length / 2)] || 1e-3;
  const S = idx.filter((i) => Y[i] <= hi && Y[i] >= lo);
  if (S.length < MIN_FIT_PX) return null;
  const B = S.map((i) => shBasis([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]));
  const yv = S.map((i) => Y[i] / med);
  let wts = new Float64Array(S.length).fill(1);
  let l = null;
  for (let it = 0; it < 4; it++) {
    const A = Array.from({ length: 9 }, () => new Array(9).fill(0)), b = new Array(9).fill(0);
    let wsum = 0;
    for (let j = 0; j < S.length; j++) {
      const r = B[j], wj = wts[j];
      wsum += wj;
      for (let a = 0; a < 9; a++) {
        b[a] += wj * r[a] * yv[j];
        for (let c = a; c < 9; c++) A[a][c] += wj * r[a] * r[c];
      }
    }
    for (let a = 0; a < 9; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    for (let a = 4; a < 9; a++) A[a][a] += RIDGE_ORDER2 * wsum;
    l = solve(A, b);
    if (!l) return null;
    const res = S.map((_, j) => yv[j] - B[j].reduce((s2, v, a) => s2 + v * l[a], 0));
    const mad = res.map(Math.abs).sort((a, c) => a - c)[Math.floor(res.length / 2)] || 1e-3;
    const cHub = 1.5 * mad / 0.6745;
    wts = Float64Array.from(res, (r) => (Math.abs(r) <= cHub ? 1 : cHub / Math.abs(r)));
  }
  let ss = 0, st = 0;
  const mean = yv.reduce((a, c) => a + c, 0) / yv.length;
  for (let j = 0; j < S.length; j++) {
    const p = B[j].reduce((s2, v, a) => s2 + v * l[a], 0);
    ss += (yv[j] - p) ** 2; st += (yv[j] - mean) ** 2;
  }
  return { l, med, n: S.length, r2: st > 0 ? 1 - ss / st : 0, idx };
}

async function insideSoft(valid, w, h, sigma) {
  const m = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) m[i] = valid[i] ? 255 : 0;
  const blur = (b) => sharp(b, { raw: { width: w, height: h, channels: 1 } }).blur(Math.max(0.3, sigma)).extractChannel(0).raw().toBuffer();
  const b1 = await blur(m);
  const er = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) er[i] = b1[i] >= 250 ? 255 : 0;
  const soft = await blur(er);
  for (let i = 0; i < w * h; i++) if (!valid[i]) soft[i] = 0;
  return soft;
}

/** Şablon gözlüğü: göz bölgesi yüz derisinden belirgin koyuysa ışık modeli bozulur. */
function eyewearRatio(ras) {
  const { w, h, CX, CY, valid, Y } = ras;
  let es = 0, en = 0, fs = 0, fn = 0;
  for (let i = 0; i < w * h; i++) {
    if (!valid[i]) continue;
    const ex = Math.abs(CX[i]) - 0.5, ey = CY[i];
    if ((ex / 0.32) ** 2 + (ey / 0.2) ** 2 < 1) { es += Y[i]; en++; } else if (fitRegion(CX[i], CY[i])) { fs += Y[i]; fn++; }
  }
  return en && fn ? Math.cbrt((es / en) / Math.max(1e-4, fs / fn)) : 1;
}

/**
 * outputBuf ve templateBuf aynı kadraj uzayında (şablon çıktı boyutuna
 * getirilir). Döner: { buf|null, applied, reason, diff, r2T, r2O, ... }
 */
async function transferFaceShading(outputBuf, templateBuf, { strength = 1 } = {}) {
  const { faceLandmarks, headYawOf } = require("./faceQuality");
  const o = await sharp(outputBuf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = o.info.width, H = o.info.height;
  const t = await sharp(templateBuf).rotate().removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const tJpeg = await sharp(t, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(outputBuf)) || (await faceLandmarks(outputBuf, 0.1));
  const lt = (await faceLandmarks(tJpeg)) || (await faceLandmarks(tJpeg, 0.1));
  if (!lo || !lt) return { buf: null, applied: false, reason: !lo ? "no-face-output" : "no-face-template" };
  const yo = await headYawOf(outputBuf, 0.1), yt = await headYawOf(tJpeg, 0.1);
  if ((yo != null && yo > MAX_YAW) || (yt != null && yt > MAX_YAW)) return { buf: null, applied: false, reason: "profile", yawO: yo, yawT: yt };
  return relightWithLandmarks(o.data, t, W, H, lo.pts, lt.pts, { strength });
}

/** Yüz noktaları hazırken çekirdek (yerel testler de bunu çağırır). */
async function relightWithLandmarks(oRgb, tRgb, W, H, ptsO, ptsT, { strength = 1 } = {}) {
  const [rO, rT] = await Promise.all([rasterizeFace(oRgb, W, H, ptsO), rasterizeFace(tRgb, W, H, ptsT)]);
  if (!rO || !rT) return { buf: null, applied: false, reason: "no-geometry" };
  const ew = eyewearRatio(rT);
  if (ew < EYEWEAR_RATIO_MAX) return { buf: null, applied: false, reason: "template-eyewear", eyeRatio: ew };
  const fO = fitLight(rO), fT = fitLight(rT);
  if (!fO || !fT) return { buf: null, applied: false, reason: !fO ? "no-skin-output" : "no-skin-template" };
  if (fT.r2 < MIN_TEMPLATE_R2) return { buf: null, applied: false, reason: "template-light-unclear", r2T: fT.r2, r2O: fO.r2 };
  const { w, h, N, valid, k, L0, T0, R0, B0 } = rO;
  const So = new Float32Array(w * h), St = new Float32Array(w * h);
  let mo = 0, mt = 0;
  for (let i = 0; i < w * h; i++) {
    if (!valid[i]) continue;
    const bs = shBasis([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]);
    So[i] = bs.reduce((s2, v, a) => s2 + v * fO.l[a], 0);
    St[i] = bs.reduce((s2, v, a) => s2 + v * fT.l[a], 0);
  }
  for (const i of fO.idx) { mo += So[i]; mt += St[i]; }
  mo /= fO.idx.length; mt /= fO.idx.length;
  if (!(mo > 0) || !(mt > 0)) return { buf: null, applied: false, reason: "bad-light-fit" };
  const G8 = Buffer.alloc(w * h);
  const G = new Float32Array(w * h).fill(1);
  let diff = 0;
  for (let i = 0; i < w * h; i++) {
    if (!valid[i]) continue;
    const so = Math.max(0.15, So[i] / mo), st = Math.max(0.05, St[i] / mt);
    let g = Math.min(GAIN_MAX, Math.max(GAIN_MIN, st / so));
    g = 1 + strength * (g - 1);
    G[i] = g;
  }
  for (const i of fO.idx) diff += Math.abs(G[i] - 1);
  diff /= fO.idx.length;
  if (diff < APPLY_MIN_DIFF) return { buf: null, applied: false, reason: "similar-light", diff, r2O: fO.r2, r2T: fT.r2 };
  // Üçgen sınırlarındaki kırıkları yumuşatmak için kazanç haritası bulanıklaştırılır
  // (log kazanç 0..255'e kodlanır).
  const enc = (g) => Math.max(0, Math.min(255, Math.round(128 + 160 * Math.log(g))));
  for (let i = 0; i < w * h; i++) G8[i] = enc(G[i]);
  const Gb = await sharp(G8, { raw: { width: w, height: h, channels: 1 } }).blur(Math.max(0.5, GAIN_SMOOTH * rO.faceW * k)).extractChannel(0).raw().toBuffer();
  const alpha = await insideSoft(valid, w, h, EDGE_SIGMA * rO.faceW * k);
  const out = Buffer.from(oRgb);
  const sample = (buf, fx, fy) => {
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    return (buf[y0 * w + x0] * (1 - ax) + buf[y0 * w + x1] * ax) * (1 - ay) + (buf[y1 * w + x0] * (1 - ax) + buf[y1 * w + x1] * ax) * ay;
  };
  for (let y = T0; y < B0; y++) {
    for (let x = L0; x < R0; x++) {
      const fx = (x - L0) * k - 0.5 + 0.5 * k, fy = (y - T0) * k - 0.5 + 0.5 * k;
      const a = sample(alpha, fx, fy) / 255;
      if (a <= 0.01) continue;
      const g = Math.exp((sample(Gb, fx, fy) - 128) / 160);
      const m = 1 + a * (g - 1);
      const i = y * W + x;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = linToSrgb8(SRGB2LIN[oRgb[i * 3 + c]] * m);
    }
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const dir = (l) => { const v = unit([l[1], l[2], l[3]]); return v.map((x) => +x.toFixed(2)); };
  return { buf, applied: true, reason: null, diff, r2O: fO.r2, r2T: fT.r2, lightO: dir(fO.l), lightT: dir(fT.l), nO: fO.n, nT: fT.n };
}

module.exports = {
  transferFaceShading,
  relightWithLandmarks,
  _testables: { delaunay, fitPose, vertexNormals, shBasis, fitRegion, fitPixels, rasterizeFace, fitLight, insideSoft, canonVerts, triangles, CANON_2D, PROT },
};
