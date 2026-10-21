const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chamfer, sheerHairMask } = require("../headSurround");
const { _finishInpaint: finishInpaint } = require("../headScale");

test("chamfer: uzaklık yaklaşık Öklid, kare değil (köşegen basamak bırakmaz)", () => {
  const w = 41, h = 41;
  const m = new Uint8Array(w * h);
  m[20 * w + 20] = 1;
  const d = chamfer(m, w, h);
  assert.equal(d[20 * w + 20], 0);
  assert.equal(d[20 * w + 30], 10);
  // Köşegen 10 adım: Öklid 14.1; Chebyshev (kare genişletme) 10 verirdi.
  assert.ok(d[30 * w + 30] > 12.5 && d[30 * w + 30] < 14.5, `köşegen=${d[30 * w + 30]}`);
});

test("finishInpaint smoothFallback: delikteki yer tutucu AI pikseliyle tamamen değişir, çevre aynen kalır", async () => {
  const side = 64, N = side * side;
  const rgb = Buffer.alloc(N * 3, 100); // gerçek arka plan: düz 100
  const holeC = new Uint8Array(N);
  const wC = new Float32Array(N);
  const ringOk = new Uint8Array(N);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = y * side + x;
    if (x >= 16 && x < 48 && y >= 16 && y < 48) { holeC[i] = 1; wC[i] = 1; } else ringOk[i] = 1;
  }
  // Delikte yer tutucu 50 (kafa küçültmenin geçici dolgusu gibi).
  const out = Buffer.from(rgb);
  const PC = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) { if (holeC[i]) out[i * 3 + c] = 50; PC[i * 3 + c] = out[i * 3 + c]; }
  const job = { side, W: side, H: side, left: 0, top: 0, rgb: Buffer.from(out), holeC, ringOk, wC, PC, out, smoothFallback: true, personMax: 1 };
  const ai = Buffer.alloc(N * 3, 100);
  const sharp = require("sharp");
  const aiPng = await sharp(ai, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
  const r = await finishInpaint(job, aiPng, null);
  assert.ok(r.buf, r.reason);
  const { data } = await sharp(r.buf).raw().toBuffer({ resolveWithObject: true });
  for (const [x, y] of [[32, 32], [17, 17], [5, 5]]) {
    const c = (y * side + x) * 3;
    assert.ok(Math.abs(data[c] - 100) <= 3, `(${x},${y})=${data[c]}`);
  }
});

// Sentetik kafa üstü: açık zemin (220), koyu dolu saç (40). Saydam hayalet
// = saç sınıfında ama arka plana yakın gri (170).
function sheerScene({ wisp = 0, edge = false, highlight = false, body = 0, thinEdge = false } = {}) {
  const { CLASSES } = { CLASSES: { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 } };
  const w = 100, hc = 100, W = w, faceW = 50;
  const rgb = Buffer.alloc(W * hc * 3, 220);
  const Mo = new Float32Array(W * hc);
  const Po = Array.from({ length: 6 }, () => new Float32Array(w * hc));
  for (let i = 0; i < w * hc; i++) Po[CLASSES.background][i] = 1;
  const set = (x, y, L, hair) => {
    const i = y * w + x;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = L;
    if (hair) { Po[CLASSES.hair][i] = 0.95; Po[CLASSES.background][i] = 0.05; Mo[i] = 0.9; }
  };
  for (let y = 40; y < 100; y++) for (let x = 25; x < 75; x++) set(x, y, highlight && y > 55 && y < 60 && x > 45 && x < 55 ? 190 : 40, true);
  if (edge) for (let x = 25; x < 75; x++) set(x, 39, 170, true); // 1 px yumuşak kenar
  // body: dolu saçın üstünde daha yoğun hayalet gövdesi (120 ≈ opaklık 0.56), wisp onun da üstünde.
  for (let y = 40 - body; y < 40; y++) for (let x = 30; x < 70; x++) set(x, y, 120, true);
  for (let y = 40 - body - wisp; y < 40 - body; y++) for (let x = 30; x < 70; x++) set(x, y, 170, true);
  if (thinEdge) for (let y = 38; y < 40; y++) for (let x = 25; x < 75; x++) set(x, y, 120, true); // 2 px orta-ton saç kenarı
  return sheerHairMask(rgb, W, Mo, Po, CLASSES, { w, hc, bx0: 0, by0: 0, browY: 80, faceW });
}
const count = (m) => m.reduce((a, b) => a + b, 0);

test("sheerHairMask: dolu saçtan uzağa uzanan gri saydam saç hayalettir (f3539078 c0)", () => {
  const m = sheerScene({ wisp: 12 });
  assert.ok(count(m) >= 12 * 40 * 0.9, `alınan=${count(m)}`);
});

test("sheerHairMask: hayaletin dolu saça yapışık kalın gövdesi de alınır (d87c25b4 c0)", () => {
  // gövde açık hayaletten SHEER_EXT_REACH_FACE (yüz eni 50 → 6 px) içinde
  const m = sheerScene({ wisp: 12, body: 5 });
  let bodyIn = 0;
  for (let y = 35; y < 40; y++) for (let x = 30; x < 70; x++) bodyIn += m[y * 100 + x];
  assert.ok(bodyIn >= 5 * 40 * 0.9, `gövde=${bodyIn}`);
});

test("sheerHairMask: hayalet varken kullanıcının ince orta-ton saç kenarı alınmaz", () => {
  const m = sheerScene({ wisp: 10, thinEdge: true });
  let edgeIn = 0;
  for (let y = 38; y < 40; y++) for (let x = 25; x < 75; x++) edgeIn += m[y * 100 + x];
  assert.equal(edgeIn, 0);
  assert.ok(count(m) >= 8 * 40 * 0.9, `hayalet=${count(m)}`); // 30-37 satırları (38-39 kenar)
});

test("sheerHairMask: açık hayalet yoksa orta yoğunlukta saç (kullanıcının kendi saçı) alınmaz", () => {
  assert.equal(count(sheerScene({ body: 14 })), 0);
});

test("sheerHairMask: saçın kendi ince yumuşak kenarı ve içteki parlama alınmaz", () => {
  assert.equal(count(sheerScene({ edge: true })), 0);
  assert.equal(count(sheerScene({ highlight: true })), 0);
});

// Güneş alan açık saç üstü (kullanıcının kendi saçı) yerel zemine göre ölçülür.
function sunlitScene({ far = 220, near = 100, hair = 40, top = 120 } = {}) {
  const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
  const w = 100, hc = 100, W = w, faceW = 50;
  const rgb = Buffer.alloc(W * hc * 3, far);
  const Mo = new Float32Array(W * hc);
  const Po = Array.from({ length: 6 }, () => new Float32Array(w * hc));
  for (let i = 0; i < w * hc; i++) Po[CLASSES.background][i] = 1;
  // Kafanın çevresindeki zemin (çalı) koyu, uzaktaki gökyüzü açık.
  for (let y = 15; y < 100; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = near;
  const set = (x, y, L) => {
    const i = y * w + x;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = L;
    Po[CLASSES.hair][i] = 0.95; Po[CLASSES.background][i] = 0.05; Mo[i] = 0.9;
  };
  for (let y = 40; y < 100; y++) for (let x = 25; x < 75; x++) set(x, y, hair);
  for (let y = 28; y < 40; y++) for (let x = 28; x < 72; x++) set(x, y, top); // 12 px kalın açık saç üstü
  return sheerHairMask(rgb, W, Mo, Po, CLASSES, { w, hc, bx0: 0, by0: 0, browY: 80, faceW });
}

test("sheerHairMask: koyu zemin önünde güneş alan saç üstü hayalet değil (3d1d2a71 c3)", () => {
  // Genel zemin ortancası açık (gökyüzü) olsa da saçın arkası koyu çalı:
  // saç üstü yerel zeminden açık, yarı saydam olamaz.
  assert.equal(count(sunlitScene({ near: 100, top: 120 })), 0);
});

test("sheerHairMask: saç-zemin farkı düşükse (bej duvar) karar verilmez (3d1d2a71 c8)", () => {
  assert.equal(count(sunlitScene({ far: 145, near: 145, hair: 92, top: 120 })), 0);
});

test("sheerHairMask: aynı kalın açık katman açık zemin önündeyse hayalettir", () => {
  assert.ok(count(sunlitScene({ near: 220, top: 170 })) >= 12 * 44 * 0.9);
});

test("templateHeadMaskFor: şablonun oranı çıktıdan farklıysa maske verilmez (yanlış yere dolgu olmasın)", async () => {
  const sharp = require("sharp");
  const { templateHeadMaskFor } = require("../headSurround");
  const out = await sharp({ create: { width: 100, height: 200, channels: 3, background: "#888" } }).jpeg().toBuffer();
  const tpl = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#888" } }).jpeg().toBuffer();
  assert.equal(await templateHeadMaskFor(out, tpl), null);
});
