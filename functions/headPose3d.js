// BAŞ POZU 3B VE SELFIE'Yİ BASE POZUNA ÇEVİRME (2026-10-31, 21e56b20,
// kullanıcı: "yön problemini kesin çözelim; base ile tamamen aynı yere
// bakmalı; matematiksel hesapla ya da görüntü işleme modeli kullan").
//
// KANIT: model başı modele verilen selfie'nin pozuna çekiyor. 21e56b20'de
// üretimdeki selfie yön ölçümü EXIF döndürmesini uygulamadığı için yanlış
// selfie seçildi; giden selfie'lerin gerçek yönüyle çıktı 9 karenin 8'inde
// uyuştu: düz şablon (+4°, −1°, +7°) + sağa yarım dönük selfie → +26°, +19°,
// +16°; sola dönük şablon (−26°, −35°) + ön selfie → −15°, −21°. Pitch de
// aynı: aşağı bakan şablon (−19°, −13°) + düz selfie → 0°, −5°. c2e8eff1'de
// de düz şablonlar giden yarım selfie'nin açısına döndü. Prompt (4 sürüm),
// poz rehberi, base'e yüz yerleştirme ve sonradan 2B çevirme bunu çözmedi.
//
// ÇÖZÜM: modele giden her selfie base ile AYNI POZDA olur. 5 açılı setten
// yönce en yakın selfie seçilir (gerekirse aynalanır), kalan yaw/pitch farkı
// yüz ağıyla 3B döndürülerek kapatılır. Modelin selfie'ye çekilme eğilimi
// artık base'in pozuna çeker.
//
// ÖLÇÜM: MediaPipe FaceMesh 468 nokta (+derinlik, faceMesh.js) kanonik yüz
// modeline (MediaPipe canonical_face_model.obj, Apache-2.0) Horn kuaterniyon
// yöntemiyle en küçük kareler oturtulur; dönme matrisinden yaw/pitch/roll
// derece. Kutay seti: ön −2.6°, hafif sağ +36.8°, hafif sol −28.2°, tam sol
// −57.5°. Eski 68 noktalı oran ölçüsü pitch'i hiç görmüyordu (c7: şablon
// −30° aşağı bakıyor).
//
// ÇEVİRME: ağ noktaları kafa merkezi (yüzün ~1.1 göz arası arkası) etrafında
// döndürülür, ortografik izdüşüm; ağ üçgenlerinin içinde parça parça afin
// (burun yanaktan fazla kayar), dışında sınır kaymasının sönen yayılımı (saç,
// kulak kafayla gider; arka plan, boyun, omuz sabit). Bükülmüş kare yeniden
// ölçülür, eksen başına kazanç düzeltilip ikinci tur yapılır (tek tur hedefin
// %60-80'ine varıyordu).
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const CANON = fs.readFileSync(path.join(__dirname, "models", "face_mesh", "canonical_face_model.obj"), "utf8")
  .split("\n").filter((l) => l.startsWith("v ")).map((l) => l.trim().split(/\s+/).slice(1, 4).map(Number));
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Ağ bulunamazsa (güçlü profil) 68 noktalı işaretli yön → derece (kutay seti:
// +0.78 ↔ +36.8°, −0.52 ↔ −28.2°, −1.00 ↔ −57.5°).
const YAW68_DEG = 55;
// Poz ölçümünde ağ ile 68 nokta uyumu: güneş gözlüğü ve aşağı eğik başta
// 68 nokta kayıyor (21e c7: ağ güveni 0.99, uyum 0.226). Güveni yüksek ağ bu
// kadar uyumsuzluğa kadar kabul edilir; güçlü profilde ağ kulağa kayar, orada
// güven düşer.
const LOOSE_AGREE_MAX = 0.32;
const LOOSE_SCORE_MIN = 0.9;
// Çevirme sınırları (derece), Kutay seti × 21e şablonlarında gözle: yaw
// 10-12°'ye kadar temiz; 15-17°'de yüz kenarı ve kulakta sürünme; kameraya
// doğru 19°+ (gizli yanak açılıyor) yanak/kaş bozuluyor. Pitch: önden
// selfie 26° aşağı eğildiğinde doğal. Fazlası kısmi çevrilir (yine yaklaşır).
const REPOSE_MAX_YAW = 12;
// Kameraya doğru (|yaw| küçülüyor) çevirmede gizli yanak açılıyor; kaş/göz
// kenarında dikiş (21e c8: 02_hafif_sol −28° → −16°). Bu yönde sınır dar.
const REPOSE_MAX_YAW_TOWARD = 8;
const REPOSE_MAX_PITCH = 25;
// İkinci turda kazanç düzeltmesiyle izin verilen en büyük fiili çevirme.
const REPOSE_HARD_YAW = 16;
const REPOSE_HARD_YAW_TOWARD = 11;
const REPOSE_HARD_PITCH = 32;
// Bu kadar yakınsa çevrilmez.
const REPOSE_MIN_YAW = 3;
const REPOSE_MIN_PITCH = 4;
// Çalışma boyu (uzun kenar): modele giden selfie için yeterli, alan hesabı hızlı.
const WORK_MAX_SIDE = 1280;
// ÇENE ALTI BANDI + ALAN YUMUŞATMA (2026-11-01, kullanıcı: "base'e uydurulmuş
// selfieler sıkıntılı gözüküyor"): bant 0.5 göz arasıyken baş eğilince çene
// altındaki sakal/gölge ince çizgiye sıkışıyor, çene kesik ve yüz boyna
// yapıştırılmış görünüyordu (Kutay seti c1/c7, +11° → −3/−7° pitch); üçgen
// sınırlarında burun kenarı basamaklıydı. Bant 1.3 göz arası + alan σ 0.06
// göz arası: aynı poza varıyor (c1 −44.0/−3.2, c7 −38.2/−6.4), kesik yok.
const CHIN_BAND = 1.3;
const FIELD_SMOOTH = 0.06;

// 4x4 simetrik matrisin en büyük özdeğerli özvektörü (Jacobi). SAF.
function jacobiMaxEig(A) {
  const n = 4, a = A.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/** src → dst en iyi dönme matrisi (Horn 1987); noktalar merkezlenmiş. SAF. */
function hornRotation(src, dst) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const [a, b, c] = src[i], [x, y, z] = dst[i];
    Sxx += a * x; Sxy += a * y; Sxz += a * z;
    Syx += b * x; Syy += b * y; Syz += b * z;
    Szx += c * x; Szy += c * y; Szz += c * z;
  }
  const [q0, qx, qy, qz] = jacobiMaxEig([
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]);
  return [
    [q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy)],
    [2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx)],
    [2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz],
  ];
}

function centered(P) {
  const c = [0, 0, 0];
  for (const p of P) for (let k = 0; k < 3; k++) c[k] += p[k] / P.length;
  return P.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

/**
 * mesh: 468 × [x, y (aşağı), z (kameraya negatif)] görüntü pikseli → derece
 * { yaw (>0 yüz görüntünün sağına), pitch (>0 yukarı), roll }. SAF.
 */
function poseFromMesh(mesh) {
  const M = centered(mesh.map((p) => [p[0], -p[1], -p[2]]));
  const C = centered(CANON);
  const R = hornRotation(C, M);
  const f = [R[0][2], R[1][2], R[2][2]];
  const u = [R[0][1], R[1][1], R[2][1]];
  return {
    yaw: Math.atan2(f[0], f[2]) / DEG,
    pitch: Math.atan2(f[1], Math.hypot(f[0], f[2])) / DEG,
    roll: Math.atan2(-u[0], u[1]) / DEG,
  };
}

/** Ağı kafa merkezi etrafında dYaw/dPitch (derece) döndürür, ortografik. SAF. */
function rotateMesh(mesh, dYaw, dPitch) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of mesh) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= mesh.length; cy /= mesh.length; cz /= mesh.length;
  const iod = Math.hypot(mesh[263][0] - mesh[33][0], mesh[263][1] - mesh[33][1]) || 1;
  const pz = cz + 1.1 * iod, py = cy + 0.15 * iod;
  const a = dYaw * DEG, b = dPitch * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  return mesh.map(([x, y, z]) => {
    const X = x - cx, Y = -(y - py), Z = -(z - pz);
    const Y1 = Y * cb + Z * sb, Z1 = -Y * sb + Z * cb;
    const X2 = X * ca + Z1 * sa, Z2 = -X * sa + Z1 * ca;
    return [X2 + cx, -Y1 + py, -Z2 + pz];
  });
}

/**
 * Geri yer değiştirme alanı (hedef px → kaynak px farkı) step ızgarasında.
 * Ağ içinde parça parça afin (önde olan üçgen kazanır), dışında sınır
 * kaymasının sönen yayılımı; çene altı ve uzak arka plan sabit. SAF.
 */
function backwardField(src, dst, tri, W, H, step) {
  const iod = Math.hypot(src[263][0] - src[33][0], src[263][1] - src[33][1]) || 1;
  const chinY = src[152][1];
  const gw = Math.ceil(W / step) + 2, gh = Math.ceil(H / step) + 2, N = gw * gh;
  const fx = new Float32Array(N), fy = new Float32Array(N), zb = new Float32Array(N).fill(Infinity);
  const inside = new Uint8Array(N);
  for (let t = 0; t < tri.length; t += 3) {
    const i = tri[t], j = tri[t + 1], k = tri[t + 2];
    const A = dst[i], B = dst[j], C = dst[k];
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]) / step)), x1 = Math.min(gw - 1, Math.ceil(Math.max(A[0], B[0], C[0]) / step));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]) / step)), y1 = Math.min(gh - 1, Math.ceil(Math.max(A[1], B[1], C[1]) / step));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const x = gx * step, y = gy * step;
      const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den;
      const l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const g = gy * gw + gx;
      const z = l1 * A[2] + l2 * B[2] + l3 * C[2];
      if (z >= zb[g]) continue;
      zb[g] = z;
      fx[g] = l1 * src[i][0] + l2 * src[j][0] + l3 * src[k][0] - x;
      fy[g] = l1 * src[i][1] + l2 * src[j][1] + l3 * src[k][1] - y;
      inside[g] = 1;
    }
  }
  // Sınır pikselleri (en çok ~400, eşit aralıklı).
  let bnd = [];
  for (let g = 0; g < N; g++) {
    if (!inside[g]) continue;
    const x = g % gw, y = (g - x) / gw;
    if ((x > 0 && !inside[g - 1]) || (x < gw - 1 && !inside[g + 1]) || (y > 0 && !inside[g - gw]) || (y < gh - 1 && !inside[g + gw])) bnd.push(g);
  }
  if (bnd.length > 400) { const k = bnd.length / 400; bnd = Array.from({ length: 400 }, (_, i) => bnd[Math.floor(i * k)]); }
  const bx = bnd.map((b) => b % gw), by = bnd.map((b, i) => (b - bx[i]) / gw);
  const bfx = bnd.map((b) => fx[b]), bfy = bnd.map((b) => fy[b]);
  const sig2 = (0.25 * iod / step) ** 2;
  const reach = 3.5 * iod;
  for (let g = 0; g < N; g++) {
    if (inside[g]) continue;
    const x = g % gw, y = (g - x) / gw;
    if (y * step - chinY > CHIN_BAND * iod) continue; // çene altı sabit
    let sw = 0, sx = 0, sy = 0, dmin = Infinity;
    for (let b = 0; b < bx.length; b++) {
      const d2 = (x - bx[b]) ** 2 + (y - by[b]) ** 2;
      if (d2 < dmin) dmin = d2;
      const w = 1 / (d2 + sig2) ** 2;
      sw += w; sx += w * bfx[b]; sy += w * bfy[b];
    }
    const d = Math.sqrt(dmin) * step;
    if (!sw || d > reach) continue;
    const fade = Math.exp(-Math.max(0, d - 0.3 * iod) / iod);
    const below = Math.max(0, y * step - chinY) / (CHIN_BAND * iod);
    const keep = fade * Math.max(0, 1 - below);
    fx[g] = (sx / sw) * keep; fy[g] = (sy / sw) * keep;
  }
  smoothField(fx, gw, gh, Math.max(1, (FIELD_SMOOTH * iod) / step));
  smoothField(fy, gw, gh, Math.max(1, (FIELD_SMOOTH * iod) / step));
  return { fx, fy, gw, step };
}

/** Izgara alanını ayrık Gauss ile yumuşatır (yerinde). SAF. */
function smoothField(arr, gw, gh, sigma) {
  const R = Math.ceil(2.5 * sigma), k = [];
  let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const tmp = new Float32Array(arr.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let i = -R; i <= R; i++) s += k[i + R] * arr[y * gw + Math.min(gw - 1, Math.max(0, x + i))];
    tmp[y * gw + x] = s / ks;
  }
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let i = -R; i <= R; i++) s += k[i + R] * tmp[Math.min(gh - 1, Math.max(0, y + i)) * gw + x];
    arr[y * gw + x] = s / ks;
  }
}

/** Alanla geri örnekleme (çift doğrusal). SAF. */
function warpRgb(rgb, W, H, F) {
  const out = Buffer.alloc(W * H * 3);
  const { fx, fy, gw, step } = F;
  const field = (arr, x, y) => {
    const gx = x / step, gy = y / step, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
    const i = y0 * gw + x0;
    return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - ty) + (arr[i + gw] * (1 - tx) + arr[i + gw + 1] * tx) * ty;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = clamp(x + field(fx, x, y), 0, W - 1.001), sy = clamp(y + field(fy, x, y), 0, H - 1.001);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
    const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3;
    const o = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.round((rgb[i00 + c] * (1 - tx) + rgb[i10 + c] * tx) * (1 - ty) + (rgb[i01 + c] * (1 - tx) + rgb[i11 + c] * tx) * ty);
    }
  }
  return out;
}

/** EXIF döndürmesi uygulanmış, en çok maxSide ham RGB (+ JPEG). */
async function normalized(buf, maxSide = WORK_MAX_SIDE, mirror = false) {
  let p = sharp(buf).rotate();
  if (mirror) p = p.flop();
  const m = await sharp(buf).rotate().metadata();
  const W0 = m.width, H0 = m.height;
  const k = Math.min(1, maxSide / Math.max(W0 || maxSide, H0 || maxSide));
  if (k < 1) p = p.resize(Math.round(W0 * k), Math.round(H0 * k));
  const { data, info } = await p.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** Ağ + poz; loose: güveni yüksek ağda 68 nokta uyumu gevşek. */
async function meshPose(data, W, H, { loose = false } = {}) {
  const { faceLandmarks } = require("./faceQuality");
  const { denseMesh } = require("./faceMesh");
  const jpg = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const lo = (await faceLandmarks(jpg)) || (await faceLandmarks(jpg, 0.1));
  if (!lo) return { reason: "no-face" };
  const m = await denseMesh(data, W, H, lo.pts, loose ? { agreeMax: LOOSE_AGREE_MAX, minScoreLoose: LOOSE_SCORE_MIN } : {});
  if (!m) return { reason: "no-mesh", lo };
  return { mesh: m.mesh, pose: poseFromMesh(m.mesh), agree: m.agree, score: m.score, lo };
}

/**
 * Bir görselin baş pozu (derece). Ağ yoksa 68 noktalı işaretli yönden
 * yalnız yaw (pitch null, src "68"). Ölçülemezse null.
 */
async function headPose3dOf(buf, { loose = true } = {}) {
  try {
    const { data, W, H } = await normalized(buf, 1600);
    const r = await meshPose(data, W, H, { loose });
    if (r.pose) return { ...r.pose, src: "mesh", agree: r.agree };
    if (r.lo) {
      const { signedYawFromLandmarks } = require("./faceQuality");
      const s = signedYawFromLandmarks({ positions: r.lo.pts });
      if (s != null && Number.isFinite(s)) return { yaw: clamp(YAW68_DEG * s, -80, 80), pitch: null, roll: null, src: "68" };
    }
    return null;
  } catch (e) {
    console.error("3B baş pozu ölçülemedi:", e.message || e);
    return null;
  }
}

/**
 * Selfie'yi hedef baş pozuna çevirir (aynalama dahil). target: { yaw, pitch }
 * derece (pitch null → yalnız yaw). Döner { buf (JPEG), applied, before,
 * after, reason }. buf her zaman EXIF düzeltilmiş (çevrilmese bile).
 */
async function reposeFace(buf, target, { mirror = false } = {}) {
  const t0 = Date.now();
  const { data, W, H } = await normalized(buf, WORK_MAX_SIDE, mirror);
  const toJpg = (rgb) => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const base = await meshPose(data, W, H);
  if (!base.pose) return { buf: await toJpg(data), applied: false, reason: base.reason, ms: Date.now() - t0 };
  const p0 = base.pose;
  const toward = Math.abs(target.yaw) < Math.abs(p0.yaw) && Math.sign(target.yaw - p0.yaw) === -Math.sign(p0.yaw);
  const lim = toward ? REPOSE_MAX_YAW_TOWARD : REPOSE_MAX_YAW, hard = toward ? REPOSE_HARD_YAW_TOWARD : REPOSE_HARD_YAW;
  const wantY = clamp(target.yaw - p0.yaw, -lim, lim);
  const wantP = target.pitch == null ? 0 : clamp(target.pitch - p0.pitch, -REPOSE_MAX_PITCH, REPOSE_MAX_PITCH);
  if (Math.abs(wantY) < REPOSE_MIN_YAW && Math.abs(wantP) < REPOSE_MIN_PITCH) {
    return { buf: await toJpg(data), applied: false, reason: "close", before: p0, ms: Date.now() - t0 };
  }
  const tri = require("./faceMesh").triangles();
  const step = W * H > 1.3e6 ? 3 : 2;
  const goalY = p0.yaw + wantY, goalP = p0.pitch + wantP;
  const run = async (dy, dp) => {
    const F = backwardField(base.mesh, rotateMesh(base.mesh, dy, dp), tri, W, H, step);
    const rgb = warpRgb(data, W, H, F);
    const m = await meshPose(rgb, W, H);
    const err = m.pose ? Math.abs(m.pose.yaw - goalY) + (target.pitch == null ? 0 : Math.abs(m.pose.pitch - goalP)) : Infinity;
    return { rgb, after: m.pose || null, err, dy, dp };
  };
  const first = await run(wantY, wantP);
  let best = first;
  if (first.after) {
    // Eksen başına kazanç: tek tur hedefin %60-80'ine varıyor.
    const gain = (got, asked) => (Math.abs(asked) >= 2 ? clamp(got / asked, 0.35, 1.3) : 1);
    const gy = gain(first.after.yaw - p0.yaw, wantY), gp = gain(first.after.pitch - p0.pitch, wantP);
    const dy2 = clamp(wantY / gy, -hard, hard);
    const dp2 = target.pitch == null ? 0 : clamp(wantP / gp, -REPOSE_HARD_PITCH, REPOSE_HARD_PITCH);
    if (Math.abs(dy2 - wantY) > 1 || Math.abs(dp2 - wantP) > 1) {
      const second = await run(dy2, dp2);
      if (second.err < first.err) best = second;
    }
  }
  return {
    buf: await toJpg(best.rgb), applied: true, reason: null, before: p0, after: best.after,
    rotYaw: best.dy, rotPitch: best.dp, ms: Date.now() - t0,
  };
}

module.exports = {
  headPose3dOf,
  reposeFace,
  poseFromMesh,
  _testables: { meshPose, normalized, hornRotation, rotateMesh, backwardField, warpRgb, CANON, YAW68_DEG, REPOSE_MAX_YAW, REPOSE_MAX_YAW_TOWARD, REPOSE_MAX_PITCH },
};
