const { test } = require("node:test");
const assert = require("node:assert/strict");
const { eyewearGeometry, compositeEyewear, EYEWEAR_ADD_PROMPT } = require("../eyewear");

// 68 noktalı sentetik yüz: gözler y=200, kaşlar y=170, burun ucu y=250.
function fakePts() {
  const p = Array.from({ length: 68 }, () => ({ x: 200, y: 320 }));
  p[0] = { x: 100, y: 205 };
  p[16] = { x: 300, y: 205 };
  for (let i = 17; i <= 26; i++) p[i] = { x: 130 + (i - 17) * 15, y: 170 };
  for (let i = 36; i <= 41; i++) p[i] = { x: 150 + ((i - 36) % 3) * 5 - 5, y: 200 };
  for (let i = 42; i <= 47; i++) p[i] = { x: 250 + ((i - 42) % 3) * 5 - 5, y: 200 };
  p[30] = { x: 200, y: 250 };
  return p;
}

test("gözlük maskesi gözleri, köprüyü ve sapları kapsar; alnı ve ağzı kapsamaz", () => {
  const g = eyewearGeometry(fakePts());
  assert.ok(g.iod > 95 && g.iod < 105);
  assert.ok(g.inMask(g.eR.x, g.eR.y) && g.inMask(g.eL.x, g.eL.y));
  assert.ok(g.inMask(200, 200), "köprü");
  assert.ok(g.inMask(105, 200) && g.inMask(295, 200), "saplar kulağa uzanır");
  assert.ok(!g.inMask(200, 120), "alın dışarıda");
  assert.ok(!g.inMask(200, 300), "ağız dışarıda");
});

function solid(W, H, v) {
  const b = Buffer.alloc(W * H * 3);
  for (let i = 0; i < b.length; i += 3) { b[i] = v[0]; b[i + 1] = v[1]; b[i + 2] = v[2]; }
  return b;
}

test("AI hiçbir şey değiştirmediyse kare aynı kalır", async () => {
  const W = 400, H = 400;
  const base = solid(W, H, [180, 140, 120]);
  const g = eyewearGeometry(fakePts());
  const rect = { left: 50, top: 50, side: 300 };
  const ai = solid(rect.side, rect.side, [180, 140, 120]);
  const { rgb, grown } = await compositeEyewear(base, W, H, rect, g, ai);
  assert.equal(grown, 0);
  assert.ok(rgb.equals(base));
});

test("maskenin dışına taşan çerçeve kesilmez, uzaktaki değişiklik alınmaz", async () => {
  const W = 400, H = 400;
  const base = solid(W, H, [180, 140, 120]);
  const g = eyewearGeometry(fakePts());
  const rect = { left: 50, top: 50, side: 300 };
  const ai = solid(rect.side, rect.side, [180, 140, 120]);
  // Kalın siyah çerçeve: sağ camın elipsinden ~8 px dışarı taşıyor.
  const rimX = Math.round(g.eL.x + 0.6 * g.iod + 8);
  for (let y = 185; y <= 215; y++) for (let x = rimX - 14; x <= rimX; x++) {
    const i = ((y - rect.top) * rect.side + (x - rect.left)) * 3;
    ai[i] = 15; ai[i + 1] = 15; ai[i + 2] = 15;
  }
  // Uzakta (alında) bağımsız bir değişiklik — alınmamalı.
  for (let y = 100; y <= 110; y++) for (let x = 190; x <= 210; x++) {
    const i = ((y - rect.top) * rect.side + (x - rect.left)) * 3;
    ai[i] = 15; ai[i + 1] = 15; ai[i + 2] = 15;
  }
  const { rgb, grown } = await compositeEyewear(base, W, H, rect, g, ai);
  assert.ok(grown > 0);
  const px = (x, y) => rgb[(y * W + x) * 3];
  assert.ok(px(rimX - 2, 200) < 60, "taşan çerçeve ucu alınmış");
  assert.equal(px(200, 105), 180, "alındaki değişiklik alınmamış");
});

test("gözlük promptu yüzü değiştirmemeyi ve tam çerçeveyi ister", () => {
  assert.ok(/Keep his eyes, eyelids, eyebrows/.test(EYEWEAR_ADD_PROMPT));
  assert.ok(/both lenses with their full rims/.test(EYEWEAR_ADD_PROMPT));
  assert.ok(/THIS man's face/.test(EYEWEAR_ADD_PROMPT));
});

// 790bd56b c2: model yüz kenarını yeniden çizdi, taşma onu aldı — yüzün
// yanında ikinci yüz. Açık (ten gibi) değişiklik taşma sayılmaz.
test("maskenin yanındaki açık renkli değişiklik (yüz kenarı) alınmaz", async () => {
  const W = 400, H = 400;
  const base = solid(W, H, [60, 50, 45]);
  const g = eyewearGeometry(fakePts());
  const rect = { left: 50, top: 50, side: 300 };
  const ai = solid(rect.side, rect.side, [60, 50, 45]);
  const x0 = Math.round(g.eL.x + 0.6 * g.iod - 2);
  for (let y = 190; y <= 290; y++) for (let x = x0; x <= x0 + 10; x++) {
    const i = ((y - rect.top) * rect.side + (x - rect.left)) * 3;
    ai[i] = 200; ai[i + 1] = 160; ai[i + 2] = 140;
  }
  const { rgb, grown } = await compositeEyewear(base, W, H, rect, g, ai);
  assert.equal(grown, 0);
  const px = (x, y) => rgb[(y * W + x) * 3];
  assert.equal(px(x0 + 6, 260), 60, "maske altındaki ten şeridi alınmamış");
});

test("taşma çok büyükse hiç alınmaz", async () => {
  const W = 400, H = 400;
  const base = solid(W, H, [180, 140, 120]);
  const g = eyewearGeometry(fakePts());
  const rect = { left: 50, top: 50, side: 300 };
  const ai = solid(rect.side, rect.side, [180, 140, 120]);
  // Camların hemen altında, yanakta geniş koyu şerit: model yüzü yeniden çizmiş.
  for (let y = 240; y <= 275; y++) for (let x = 90; x <= 310; x++) {
    const i = ((y - rect.top) * rect.side + (x - rect.left)) * 3;
    ai[i] = 30; ai[i + 1] = 25; ai[i + 2] = 20;
  }
  const { grown, grownRejected } = await compositeEyewear(base, W, H, rect, g, ai);
  assert.equal(grown, 0);
  assert.ok(grownRejected > 0.15);
});

// Çerçeve gölgesi (2026-10-30, c2e8eff1 "gözlük yapay"): modelin çizdiği yumuşak
// gölge atılıyordu; artık oran olarak tabana uygulanır.
test("gölge: maskenin yanında modelin koyulaştırdığı aynı renkli ten gölge sayılır, başka renk sayılmaz", async () => {
  const { castShadow } = require("../eyewear");
  const side = 60, W = 60, N = side * side;
  const base = Buffer.alloc(N * 3), ai = Buffer.alloc(N * 3), m = new Uint8Array(N);
  for (let i = 0; i < N; i++) { base[i * 3] = 180; base[i * 3 + 1] = 140; base[i * 3 + 2] = 120; }
  for (let y = 20; y < 26; y++) for (let x = 10; x < 50; x++) m[y * side + x] = 1;
  for (let i = 0; i < N; i++) {
    const y = Math.floor(i / side), x = i % side;
    let k = 1, green = false;
    if (y >= 26 && y < 30 && x < 30) k = 0.8; // gölge
    if (y >= 26 && y < 30 && x >= 30) green = true; // başka şey çizilmiş
    ai[i * 3] = green ? 90 : Math.round(180 * k); ai[i * 3 + 1] = green ? 160 : Math.round(140 * k); ai[i * 3 + 2] = green ? 90 : Math.round(120 * k);
  }
  const geom = { iod: 100 };
  const s = await castShadow(base, W, { left: 0, top: 0, side }, geom, ai, [0, 0, 0], m);
  assert.ok(s, "gölge bulunmalı");
  assert.ok(s[27 * side + 15] > 0.05, "gölge pikseli koyulaşır");
  assert.ok(s[27 * side + 45] < 0.02, "yeşil (gölge değil) alınmaz");
  assert.strictEqual(s[22 * side + 20], 0, "maskenin içi bileştirmede");
  assert.ok(s[55 * side + 15] < 0.01, "uzakta gölge yok");
});
