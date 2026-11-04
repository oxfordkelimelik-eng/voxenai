const { test } = require("node:test");
const assert = require("node:assert/strict");
const { enclosedLight, holeComponents, selectSeeds, isLoop } = require("../curlRemnant");

// Açık zemin (200) önünde koyu saç bloğu (40), y >= 20. Saçın içinde kapalı
// açık delik (28-31, 28-31) ve üst kenarda dışarıya açık çentik (10-13, 20-25).
function scene({ hairL = 40, bgL = 200 } = {}) {
  const w = 60, h = 60, N = w * h;
  const L = new Float32Array(N), hairP = new Float32Array(N), bgP = new Float32Array(N);
  const skinP = new Float32Array(N), M = new Float32Array(N), blocked = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hair = y >= 20;
      const hole = x >= 28 && x < 32 && y >= 28 && y < 32;
      const notch = x >= 10 && x < 14 && y >= 20 && y < 26;
      L[i] = hair && !hole && !notch ? hairL : bgL;
      hairP[i] = hair ? 1 : 0;
      bgP[i] = hair ? 0 : 1;
      M[i] = hair ? 1 : 0;
      if (y >= 50) blocked[i] = 1;
    }
  }
  return { L, hairP, bgP, skinP, M, blocked, w, h, fw: 40 };
}

test("bukle: saçla çevrili açık bölge delik, dışarıya açık çentik değil", () => {
  const s = scene();
  const { hole, Lh, Lb, skip } = enclosedLight(s);
  assert.equal(skip, undefined);
  assert.equal(Lh, 40);
  assert.equal(Lb, 200);
  assert.equal(hole[30 * s.w + 30], 1);
  assert.equal(hole[22 * s.w + 11], 0); // çentik
  assert.equal(hole[5 * s.w + 5], 0); // zemin
  assert.equal(hole[40 * s.w + 40], 0); // dolu saç
  assert.equal(hole.reduce((a, v) => a + v, 0), 16);
});

test("bukle: saç-zemin farkı azsa karar verilmez", () => {
  const { hole, skip } = enclosedLight(scene({ hairL: 160, bgL: 190 }));
  assert.equal(skip, "contrast");
  assert.equal(hole.reduce((a, v) => a + v, 0), 0);
});

test("bukle: şablon halkası arka plan rengindedir; saç parlaması halka değil", () => {
  const w = 60, h = 60, N = w * h, fw = 40;
  const lab = new Float32Array(N * 3), hairP = new Float32Array(N), bgP = new Float32Array(N), hole = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hair = y >= 20;
      const ring = x >= 18 && x < 24 && y >= 22 && y < 26; // gökyüzü rengi, arka plan sınıfı
      const shine = x >= 38 && x < 44 && y >= 22 && y < 26; // saç tonunun açığı
      hole[i] = ring || shine ? 1 : 0;
      hairP[i] = hair && !ring ? 1 : 0;
      bgP[i] = !hair || ring ? 1 : 0;
      const c = !hair || ring ? [80, -5, -10] : shine ? [60, 8, 14] : [20, 6, 10];
      lab.set(c, i * 3);
    }
  }
  const comps = holeComponents({ hole, lab, hairP, bgP, w, h, fw });
  assert.equal(comps.length, 2);
  const ring = comps.find((c) => c.px.includes(23 * w + 20));
  const shine = comps.find((c) => c.px.includes(23 * w + 40));
  assert.ok(ring.ratio < 0.1, `halka oranı ${ring.ratio}`);
  assert.equal(ring.edge, 0);
  assert.ok(isLoop(ring));
  assert.ok(shine.ratio > 0.5, `parlama oranı ${shine.ratio}`);
  assert.equal(isLoop(shine), false);
  // küçük delik halka değil
  assert.equal(isLoop({ area: 0.002, ratio: 0.05, edge: 0 }), false);
});

test("bukle: tohum yalnız şablon deliğinin yakınında, kafa içinde ve izinli yerde", () => {
  const w = 80, h = 40, N = w * h, fw = 40;
  const mk = () => new Uint8Array(N);
  const outHole = mk(), tplHole = mk(), loopMask = mk(), light = mk(), inHead = mk(), allowed = mk().fill(1);
  const at = (x, y) => y * w + x;
  tplHole[at(10, 10)] = 1; loopMask[at(10, 10)] = 1;
  outHole[at(13, 10)] = 1; // şablon deliğine 3 px: seçilir
  outHole[at(60, 10)] = 1; // şablonda karşılığı yok: seçilmez
  light[at(12, 14)] = 1; inHead[at(12, 14)] = 1; // halkaya yakın açık saç: seçilir
  light[at(11, 8)] = 1; // kafa dışında (gökyüzü): seçilmez
  light[at(14, 12)] = 1; inHead[at(14, 12)] = 1; allowed[at(14, 12)] = 0; // yüz ovali: seçilmez
  const { seed, holes, lights } = selectSeeds({ outHole, tplHole, loopMask, light, inHead, allowed, w, h, fw });
  assert.equal(holes, 1);
  assert.equal(lights, 1);
  assert.equal(seed[at(13, 10)], 1);
  assert.equal(seed[at(60, 10)], 0);
  assert.equal(seed[at(12, 14)], 1);
  assert.equal(seed[at(11, 8)], 0);
  assert.equal(seed[at(14, 12)], 0);
});
