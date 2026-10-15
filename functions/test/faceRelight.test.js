const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const FR = require("../faceRelight");
const FS = require("../faceShading");
const { gauss, weightedLowpass, regionWeight, tonePlan } = FR._testables;

const lab = (L, C, hue) => [L, C * Math.cos((hue * Math.PI) / 180), C * Math.sin((hue * Math.PI) / 180)];
const st = (faceY, faceLab, neckY, neckLab) => ({ face: { n: 5000, Y: faceY, lab: faceLab }, neck: { n: 5000, Y: neckY, lab: neckLab } });

test("ton: soluk yüz boynun doygunluğuna çekilir, açı korunur (c29a2b31 c4)", () => {
  // c4: yüz ile boyun aynı açıda (54°/53°), yüz doygunluğu 24, boyun 32.
  const so = st(0.25, lab(55, 24, 54), 0.25, lab(57, 32, 53));
  const t = st(0.2, lab(50, 30, 52), 0.2, lab(50, 30, 52));
  const p = tonePlan(so, t);
  assert.equal(p.reason, null);
  assert.ok(p.chromaGain > 1.15, `doygunluk ${p.chromaGain}`);
  assert.ok(Math.abs(p.hueShift) < 1.5, `açı ${p.hueShift}`);
});

test("ton: flaş gibi parlak yüz base'deki yüz/boyun oranına iner, sınırda durur", () => {
  // Base'de yüz boyunla aynı; çıktıda 2 kat parlak → payla karartılır, 0.7'nin altına inmez.
  const p = tonePlan(st(0.4, lab(60, 20, 55), 0.2, lab(50, 20, 55)), st(0.2, lab(50, 20, 55), 0.2, lab(50, 20, 55)));
  assert.ok(p.level < 0 && p.level >= Math.log(0.7) - 1e-9, `${p.level}`);
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
  assert.equal(p.chromaGain, 1);
});

test("ton: siyah-beyaz base'de renge dokunulmaz", () => {
  const p = tonePlan(st(0.25, lab(55, 24, 54), 0.25, lab(57, 32, 40)), st(0.2, lab(50, 0, 0), 0.2, lab(50, 0, 0)), { grayscale: true });
  assert.equal(p.hueShift, 0);
  assert.equal(p.chromaGain, 1);
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

test("sentetik: soldan ışıklı base'in deseni önden ışıklı çıktıya taşınır", async () => {
  const tpl = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const out = await syntheticFace(unitV([0, 0, 1]));
  const r = await FR.relightCore(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts, { tone: false });
  assert.equal(r.applied, true, `atlandı: ${r.reason}`);
  const raw = await sharp(r.buf).raw().toBuffer();
  const cheek = (buf, a, b) => {
    const P = out.pts, x = Math.round((P[a].x + P[b].x) / 2), y = Math.round((P[a].y + P[b].y) / 2);
    return buf[(y * out.W + x) * 3];
  };
  const before = cheek(out.rgb, 31, 2) - cheek(out.rgb, 35, 14);
  const after = cheek(raw, 31, 2) - cheek(raw, 35, 14);
  assert.ok(Math.abs(before) < 8, `önce iki yan eşit olmalı: ${before}`);
  assert.ok(after > 15, `sonra sol yan aydınlık olmalı: ${after}`);
});

test("sentetik: aynı ışıkta dokunulmaz", async () => {
  const a = await syntheticFace(unitV([0.3, 0.2, 0.9]));
  const r = await FR.relightCore(a.rgb, a.rgb, a.W, a.H, a.pts, a.pts, { tone: false });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "similar-light");
});
