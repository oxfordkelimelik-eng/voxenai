const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const FS = require("../faceShading");
const { delaunay, fitPose, vertexNormals, shBasis, fitRegion, rasterizeFace, insideSoft, canonVerts, triangles, CANON_2D } = FS._testables;

// f9f3b5c0: dışa doğru bulanıklaşan maske kafa çevresinde hale bırakmıştı.
test("uygulama maskesi yüz sınırının dışına taşmaz (kafa çevresinde hale yok)", async () => {
  const W = 120, H = 120;
  const valid = new Uint8Array(W * H);
  for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) valid[y * W + x] = 1;
  const soft = await insideSoft(valid, W, H, 3);
  for (let i = 0; i < W * H; i++) if (!valid[i]) assert.equal(soft[i], 0);
  assert.ok(soft[60 * W + 60] > 240);
  assert.ok(soft[60 * W + 30] < 128);
});

test("Delaunay: kare + merkez 4 üçgen verir", () => {
  const T = delaunay([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
  assert.equal(T.length, 4);
  for (const t of T) assert.ok(t.includes(4));
});

test("kanonik yüz üçgenlemesi tüm köşeleri kullanır, normaller kameraya bakar", () => {
  const V = canonVerts();
  const T = triangles();
  const used = new Set(T.flat());
  assert.equal(used.size, V.length);
  const N = vertexNormals(V, T);
  for (const n of N) assert.ok(n[2] < 0, `normal ${n}`);
  // Burun ucu (30) öne bakar; çene kenarı (0) yana döner.
  assert.ok(N[30][2] < -0.8);
  assert.ok(Math.abs(N[0][0]) > 0.4);
});

test("poz: önden yüzde dönme ~birim, ölçek ve öteleme geri bulunur", () => {
  const V = canonVerts().slice(0, 68);
  const pts = V.map(([x, y]) => ({ x: 400 + 60 * x, y: 300 + 60 * y }));
  const p = fitPose(pts, V);
  assert.ok(Math.abs(p.s - 60) < 1);
  assert.ok(Math.abs(p.R[0][0] - 1) < 0.02 && Math.abs(p.R[1][1] - 1) < 0.02);
  assert.ok(Math.abs(p.t[0] - 400) < 2 && Math.abs(p.t[1] - 300) < 2);
});

test("öğrenme bölgesi göz, kaş, bıyık ve sakalı dışarıda bırakır, yanak/alın/burun içeride", () => {
  assert.equal(fitRegion(-0.5, 0), false); // göz
  assert.equal(fitRegion(0.6, -0.36), false); // kaş
  assert.equal(fitRegion(0, 0.85), false); // bıyık/dudak
  assert.equal(fitRegion(-0.8, 1.2), false); // sakal
  assert.equal(fitRegion(-0.7, 0.45), true); // yanak
  assert.equal(fitRegion(0, -0.8), true); // alın
  assert.equal(fitRegion(0, 0.4), true); // burun sırtı
});

test("SH tabanı 9 terim, sabit terim 1", () => {
  const b = shBasis([0, 0, -1]);
  assert.equal(b.length, 9);
  assert.equal(b[0], 1);
});

// Sentetik yüz: düz gri albedo, kanonik geometrinin normalleriyle verilen
// yönden aydınlatılmış. Şablon soldan, çıktı önden ışıklı; aktarımdan sonra
// çıktının öğrenilen ışığı soldan olmalı.
async function syntheticFace(lightDir, W = 400, H = 480) {
  const V = canonVerts().slice(0, 68);
  const pts = V.map(([x, y]) => ({ x: W / 2 + 70 * x, y: H * 0.4 + 70 * y }));
  const blank = Buffer.alloc(W * H * 3, 128);
  const ras = await rasterizeFace(blank, W, H, pts);
  const rgb = Buffer.alloc(W * H * 3, 60);
  const l = lightDir;
  for (let y = 0; y < ras.h; y++) {
    for (let x = 0; x < ras.w; x++) {
      const i = y * ras.w + x;
      if (!ras.valid[i]) continue;
      const n = [ras.N[i * 3], ras.N[i * 3 + 1], ras.N[i * 3 + 2]];
      const shade = 0.25 + 0.75 * Math.max(0, -(n[0] * l[0] + n[1] * l[1] + n[2] * l[2]));
      const X = Math.round(ras.L0 + (x + 0.5) / ras.k - 0.5), Y = Math.round(ras.T0 + (y + 0.5) / ras.k - 0.5);
      for (let dy = 0; dy < Math.ceil(1 / ras.k); dy++) {
        for (let dx = 0; dx < Math.ceil(1 / ras.k); dx++) {
          const j = ((Y + dy) * W + X + dx) * 3;
          const v = Math.round(255 * Math.pow(0.6 * shade, 1 / 2.2));
          rgb[j] = v; rgb[j + 1] = v; rgb[j + 2] = v;
        }
      }
    }
  }
  return { rgb, pts, W, H };
}

test("sentetik: soldan ışıklı şablonun ışığı önden ışıklı çıktıya taşınır", async () => {
  // l: ışığın GELDİĞİ yönün tersi (normal·l negatifken aydınlık): ışık soldan (−x).
  const tpl = await syntheticFace(unitV([0.8, 0.1, 0.6]));
  const out = await syntheticFace(unitV([0, 0, 1]));
  const r = await FS.relightWithLandmarks(out.rgb, tpl.rgb, out.W, out.H, out.pts, tpl.pts);
  assert.equal(r.applied, true, `atlandı: ${r.reason}`);
  // Çıktının sol yarısı (−x, ışığın geldiği taraf) sağ yarısından parlak olmalı.
  const raw = await sharp(r.buf).raw().toBuffer();
  // Yanak noktası: burun kanadı ile çene kenarının ortası (sol 31-2, sağ 35-14).
  const cheek = (buf, a, b) => {
    const P = out.pts, x = Math.round((P[a].x + P[b].x) / 2), y = Math.round((P[a].y + P[b].y) / 2);
    return buf[(y * out.W + x) * 3];
  };
  const diffBefore = cheek(out.rgb, 31, 2) - cheek(out.rgb, 35, 14);
  const diffAfter = cheek(raw, 31, 2) - cheek(raw, 35, 14);
  assert.ok(Math.abs(diffBefore) < 8, `önden ışıkta iki yan eşit olmalı: ${diffBefore}`);
  assert.ok(diffAfter > 10, `aktarımdan sonra sol taraf aydınlık olmalı: ${diffAfter}`);
});

test("sentetik: aynı ışıkta dokunulmaz", async () => {
  const a = await syntheticFace(unitV([0.3, 0.2, 0.9]));
  const r = await FS.relightWithLandmarks(a.rgb, a.rgb, a.W, a.H, a.pts, a.pts);
  assert.equal(r.applied, false);
  assert.equal(r.reason, "similar-light");
});

function unitV(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

test("kanonik yüz simetrik", () => {
  for (const [a, b] of [[0, 16], [36, 45], [48, 54], [31, 35]]) {
    assert.ok(Math.abs(CANON_2D[a][0] + CANON_2D[b][0]) < 1e-6);
    assert.ok(Math.abs(CANON_2D[a][1] - CANON_2D[b][1]) < 1e-6);
  }
});
