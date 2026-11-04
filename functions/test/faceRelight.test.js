const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const FR = require("../faceRelight");
const FS = require("../faceShading");
const { gauss, weightedLowpass, regionWeight, tonePlan, albedoRatio, MST_L } = FR._testables;

const lab = (L, C, hue) => [L, C * Math.cos((hue * Math.PI) / 180), C * Math.sin((hue * Math.PI) / 180)];
const st = (faceY, faceLab, neckY, neckLab) => ({ face: { n: 5000, Y: faceY, lab: faceLab }, neck: { n: 5000, Y: neckY, lab: neckLab } });

test("ton: renge dokunulmaz — yalnız parlaklık (6dd26e3e c9 dudaklar pembeleşti)", () => {
  const so = st(0.25, lab(55, 24, 54), 0.25, lab(57, 32, 53));
  const t = st(0.2, lab(50, 30, 52), 0.2, lab(50, 30, 52));
  const p = tonePlan(so, t);
  assert.equal(p.reason, null);
  assert.equal(p.hueShift, undefined);
  assert.equal(p.chromaGain, undefined);
});

test("ton: flaş gibi parlak yüz karartılır, %15'te durur", () => {
  // Base'de yüz boyunla aynı; çıktıda yüz kendi boynunun 2 katı parlak.
  const p = tonePlan(st(0.4, lab(60, 18, 52), 0.2, lab(52, 18, 52)), st(0.2, lab(45, 22, 58), 0.2, lab(45, 22, 58)));
  assert.ok(p.level < 0 && p.level >= Math.log(0.85) - 1e-9, `${p.level}`);
});

test("ton: koyu tenli manken, açık tenli kullanıcı — mankenin teni karartmaz (9c8f2cb5 c7)", () => {
  // Base: koyu ten, yüz = boyun. Çıktı: açık ten, yüz = boyun. Işık farkı yok.
  const p = tonePlan(st(0.3, lab(60, 20, 55), 0.3, lab(60, 20, 55)), st(0.05, lab(27, 22, 55), 0.05, lab(27, 22, 55)));
  assert.equal(p.reason, null);
  assert.ok(Math.abs(p.level) < 1e-9, `${p.level}`);
});

test("ton: açık tenli manken, esmer kullanıcı — mankenin teni ağartmaz", () => {
  const p = tonePlan(st(0.06, lab(30, 22, 55), 0.06, lab(30, 22, 55)), st(0.4, lab(70, 18, 55), 0.4, lab(70, 18, 55)));
  assert.equal(p.reason, null);
  assert.ok(Math.abs(p.level) < 1e-9, `${p.level}`);
});

test("ton: ten düzeyinden bağımsız — çıktının bütün derisi koyulaşsa da karar aynı", () => {
  const base = st(0.1, lab(40, 20, 55), 0.12, lab(42, 20, 55));
  const a = tonePlan(st(0.3, lab(60, 20, 55), 0.25, lab(56, 20, 55)), base);
  const b = tonePlan(st(0.06, lab(29, 24, 55), 0.05, lab(27, 24, 55)), base);
  assert.ok(Math.abs(a.level - b.level) < 1e-9, `${a.level} ${b.level}`);
});

test("ton: base'te yüz gölgede, boyun aydınlık — gölge yine aktarılır (9c8f2cb5 c6)", () => {
  // Base yüz/boyun 0.82, çıktı 1.75: yüz karartılır (sınırda).
  const p = tonePlan(st(0.129, lab(43, 21, 27), 0.074, lab(33, 25, 29)), st(0.044, lab(25, 15, 23), 0.054, lab(28, 21, 23)));
  assert.ok(p.level < 0 && p.level >= Math.log(0.85) - 1e-9, `${p.level}`);
});

test("ton: model mankenin boynunu bıraktıysa yüz ona bağlanmaz (ca61076a c9)", () => {
  // Çıktı boynu base boynuyla neredeyse aynı, çıktı yüzü base yüzünden çok farklı.
  const p = tonePlan(st(0.25, lab(56, 18, 50), 0.15, lab(46, 20, 50)), st(0.1, lab(46, 20, 50), 0.15, lab(45, 21, 50)));
  assert.equal(p.reason, "neck-kept");
  assert.equal(p.level, 0);
});

test("ton: base boynu güvenilmezse (beyaz gömlek) parlaklığa dokunulmaz", () => {
  // c29a2b31 c3: base yüz/boyun 0.25.
  const p = tonePlan(st(0.3, lab(55, 25, 55), 0.2, lab(50, 25, 55)), st(0.1, lab(40, 25, 55), 0.4, lab(80, 22, 63)));
  assert.equal(p.tplOk, false);
  assert.equal(p.level, 0);
});

test("ton: boyun yoksa hiçbir şey yapılmaz", () => {
  const p = tonePlan({ face: { n: 5000, Y: 0.3, lab: lab(55, 25, 55) }, neck: { n: 0 } }, st(0.2, lab(50, 25, 55), 0.2, lab(50, 25, 55)));
  assert.equal(p.reason, "no-neck");
  assert.equal(p.level, 0);
});

test("ışık yüzeyi: yan ışığı öğrenir, tek piksellik lekeyi taşımaz", () => {
  const { fitLightSurface } = FR._testables;
  const n = 4000, CX = new Float32Array(n), CY = new Float32Array(n), lt = new Float32Array(n), lo = new Float32Array(n), wt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    CX[i] = -1 + 2 * ((i * 7919) % n) / n; CY[i] = -0.8 + 2.2 * ((i * 104729) % n) / n; wt[i] = 1;
    lt[i] = 0.3 * CX[i]; lo[i] = 0;
  }
  // Base yüzünde bir leke (ben/sakal) — yüzey onu yaymamalı.
  for (let i = 0; i < 80; i++) lt[i] -= 1.5;
  const s = fitLightSurface(lt, lo, wt, CX, CY, n);
  assert.ok(Math.abs(s.at(0.8, 0) - s.at(-0.8, 0) - 0.48) < 0.06, `yan ışık ${s.at(0.8, 0) - s.at(-0.8, 0)}`);
  assert.ok(Math.abs(s.at(0, -0.5) - s.at(0, 1)) < 0.06, "dikey eğim olmamalı");
});

test("desen öğrenme bölgesi: göz, kaş, ağız yok; sakal zayıf; yanak/alın tam", () => {
  assert.equal(regionWeight(-0.5, 0), 0);
  assert.equal(regionWeight(0.6, -0.36), 0);
  assert.equal(regionWeight(0, 1.0), 0);
  assert.ok(regionWeight(0, 1.3) < 0.5);
  assert.equal(regionWeight(-0.7, 0.45), 1);
  assert.equal(regionWeight(0, -0.8), 1);
});

test("ağırlıklı alçak geçirgen: boşlukları komşudan doldurur, sabit alanı korur", () => {
  const w = 40, h = 40;
  const val = new Float32Array(w * h).fill(2), wt = new Float32Array(w * h).fill(1);
  for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) { val[y * w + x] = -9; wt[y * w + x] = 0; }
  const { lp } = weightedLowpass(val, wt, w, h, 3);
  for (let i = 0; i < w * h; i++) assert.ok(Math.abs(lp[i] - 2) < 1e-4);
  const g = gauss(Float32Array.from({ length: 100 }, () => 1), 10, 10, 2);
  for (const v of g) assert.ok(Math.abs(v - 1) < 1e-5);
});

// Sentetik yüz (faceShading testindeki gibi): kanonik geometri, düz albedo.
async function syntheticFace(lightDir, W = 400, H = 480) {
  const { canonVerts, rasterizeFace } = FS._testables;
  const V = canonVerts().slice(0, 68);
  const pts = V.map(([x, y]) => ({ x: W / 2 + 70 * x, y: H * 0.4 + 70 * y }));
  const ras = await rasterizeFace(Buffer.alloc(W * H * 3, 128), W, H, pts);
  const rgb = Buffer.alloc(W * H * 3, 60);
  for (let y = 0; y < ras.h; y++) {
    for (let x = 0; x < ras.w; x++) {
      const i = y * ras.w + x;
      if (!ras.valid[i]) continue;
      const n = [ras.N[i * 3], ras.N[i * 3 + 1], ras.N[i * 3 + 2]];
      const shade = 0.25 + 0.75 * Math.max(0, -(n[0] * lightDir[0] + n[1] * lightDir[1] + n[2] * lightDir[2]));
      const X = Math.round(ras.L0 + (x + 0.5) / ras.k - 0.5), Y = Math.round(ras.T0 + (y + 0.5) / ras.k - 0.5);
      for (let dy = 0; dy < Math.ceil(1 / ras.k); dy++) {
        for (let dx = 0; dx < Math.ceil(1 / ras.k); dx++) {
          const j = ((Y + dy) * W + X + dx) * 3;
          const v = Math.round(255 * Math.pow(0.6 * shade, 1 / 2.2));
          rgb[j] = v; rgb[j + 1] = Math.round(v * 0.8); rgb[j + 2] = Math.round(v * 0.65);
        }
      }
    }
  }
  return { rgb, pts, W, H };
}
const unitV = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// Model base'in ışık yönünü çoğunlukla zayıf da olsa taklit ediyor (desen
// uyumu gerçek karelerde 0.5-0.93); taşınan, o yönün GÜCÜ.
test("sentetik: soldan ışıklı base'in deseni zayıf yan ışıklı çıktıya tam taşınır", async () => {
  const tpl = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const out = await syntheticFace(unitV([0.2, 0.1, 0.97]));
  const r = await FR.relightCore(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts, { tone: false });
  assert.equal(r.applied, true, `atlandı: ${r.reason}`);
  const raw = await sharp(r.buf).raw().toBuffer();
  const cheek = (buf, a, b) => {
    const P = out.pts, x = Math.round((P[a].x + P[b].x) / 2), y = Math.round((P[a].y + P[b].y) / 2);
    return buf[(y * out.W + x) * 3];
  };
  const before = cheek(out.rgb, 31, 2) - cheek(out.rgb, 35, 14);
  const after = cheek(raw, 31, 2) - cheek(raw, 35, 14);
  const target = cheek(tpl.rgb, 31, 2) - cheek(tpl.rgb, 35, 14);
  assert.ok(after - before > 30, `yan ışık güçlenmeli: ${before} -> ${after}`);
  assert.ok(Math.abs(after - target) < 20, `base'e yaklaşmalı: ${after} / ${target}`);
});

// Desen uyumu çok düşükse (çıktıda base'in deseninden iz yok) base'in deseni
// ışık değil başka yüz/ifade sayılır: gülen şablon nötr yüzü lekeledi
// (7c17ea3f c8 0.20, 3d1d2a71 c3 0.07).
test("sentetik: desen uyumu çok düşükse desen uygulanmaz", async () => {
  const tpl = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const out = await syntheticFace(unitV([0, 0, 1]));
  const r = await FR.relightCore(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts, { tone: false });
  assert.ok(r.corrBefore < 0.3, `uyum: ${r.corrBefore}`);
  assert.ok(!r.pattern, "desen kapalı olmalı");
});

test("sentetik: aynı ışıkta dokunulmaz", async () => {
  const a = await syntheticFace(unitV([0.3, 0.2, 0.9]));
  // Ortam rengi (L2) yüze bakmadan şablonun ışığını uygular; burada yalnız yüzey sınanıyor.
  const r = await FR.relightCore(a.rgb, a.rgb, a.W, a.H, a.pts, a.pts, { tone: false, sceneColor: false });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "similar-light");
});

// POZLAMA — TEN ORANI (2026-10-29, 546b514b devamı). skinPigment.js'ten gelen
// Monk Skin Tone (MST) tahminiyle "bu fark ışık mı pigment mi" ayrımı.
test("ten oranı: aynı MST'de (ya da ölçülemezse) oran 1", () => {
  assert.equal(albedoRatio(5, 5), 1);
  assert.equal(albedoRatio(null, 5), 1);
  assert.equal(albedoRatio(5, null), 1);
});

test("ten oranı: ±1 seviye fark yok sayılır (ölçüm gürültüsü)", () => {
  assert.equal(albedoRatio(6, 5), 1);
  assert.equal(albedoRatio(4, 5), 1);
});

test("ten oranı: kullanıcı şablondan koyuysa oran 1'in altında (karartma değil, ten farkı payı)", () => {
  const r = albedoRatio(8, 3);
  assert.ok(r > 0 && r < 1, `${r}`);
  // Eşik gerisindeki (deadZone sonrası) MST farkıyla tutarlı
  const expect = ((MST_L[3 + (8 - 3 - 1)] + 16) / 116) ** 3 / ((MST_L[3] + 16) / 116) ** 3;
  assert.ok(Math.abs(r - expect) < 1e-9, `${r} vs ${expect}`);
});

test("ten oranı: kullanıcı şablondan açıksa oran 1'in üstünde", () => {
  const r = albedoRatio(2, 7);
  assert.ok(r > 1, `${r}`);
});

test("ten oranı: tek yönlü monotondur (MST tablosu azalan L*)", () => {
  for (let i = 1; i < MST_L.length - 1; i++) assert.ok(MST_L[i] > MST_L[i + 1], `MST_L[${i}]=${MST_L[i]} MST_L[${i + 1}]=${MST_L[i + 1]}`);
});

// POZLAMA varsayılan KAPALI: mstUser/mstTpl verilse bile EXPOSURE_ON false
// iken sonuç değişmemeli (deploy onayı bekleyen özellik, canlıda inert).
test("pozlama: varsayılan kapalı — mstUser/mstTpl verilse de çıktı aynı", async () => {
  const tpl = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const out = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const r1 = await FR.relightCore(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts, { tone: false, sceneColor: false });
  const r2 = await FR.relightCore(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts, { tone: false, sceneColor: false, mstUser: 9, mstTpl: 2 });
  assert.equal(r1.applied, false);
  assert.equal(r2.applied, false);
  assert.equal(r1.expOn, false);
});
