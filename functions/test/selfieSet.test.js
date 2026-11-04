const test = require("node:test");
const assert = require("node:assert");
const { _testables: SL } = require("../selfieLight");
const { _testables: ST } = require("../sunglassTransfer");
const { buildNaturalSwapPrompt } = require("../naturalSwap");
const { _testables: FT } = require("../faceTone");

test("selfie ışığı: soldan sağa ışık eğimi deride düzleşir", () => {
  const W = 80, H = 80, N = W * H;
  const lin = new Float32Array(N * 3), ws = new Float32Array(N), head = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const v = 0.05 * Math.exp(2.5 * (x / W - 0.5)); // güçlü yan ışık
    for (let c = 0; c < 3; c++) lin[i * 3 + c] = v;
    const inFace = x > 15 && x < 65 && y > 10 && y < 70;
    ws[i] = inFace ? 1 : 0;
    head[i] = inFace ? 1 : 0;
  }
  const box = { x: 15, y: 10, width: 50, height: 60 };
  const p = SL.planFlatten(lin, ws, head, W, H, 6, FT, box);
  assert.ok(p, "plan çıkmalı");
  assert.ok(p.spread > 0.8, `yayılım ${p.spread}`);
  assert.ok(p.after < 0.35 * p.spread, `sonra ${p.after} / önce ${p.spread}`);
});

test("selfie ışığı: düz ışıklı yüzde yayılım küçük", () => {
  const W = 60, H = 60, N = W * H;
  const lin = new Float32Array(N * 3).fill(0.2), ws = new Float32Array(N).fill(1), head = new Float32Array(N).fill(1);
  const p = SL.planFlatten(lin, ws, head, W, H, 5, FT, { x: 5, y: 5, width: 50, height: 50 });
  assert.ok(p.spread < SL.MIN_SPREAD);
});

test("güneş gözlüğü: afin eşleme benzerliği de kapsar, tersi geri döner", () => {
  const src = [[10, 10], [50, 12], [30, 40], [20, 30]];
  const a = 1.2 * Math.cos(0.1), b = 1.2 * Math.sin(0.1);
  const dst = src.map(([x, y]) => [a * x - b * y + 5, b * x + a * y - 3]);
  const T = ST.affineFit(src, dst);
  assert.ok(Math.abs(T.a - a) < 1e-6 && Math.abs(T.d - b) < 1e-6);
  const [x, y] = ST.applyAffine(T, 7, 9);
  const back = ST.applyAffine(ST.invertAffine(T), x, y);
  assert.ok(Math.abs(back[0] - 7) < 1e-6 && Math.abs(back[1] - 9) < 1e-6);
});

test("talimat: tüm selfie setinde kimlik selfie'den, baş/bakış/ışık base'den", () => {
  const p = buildNaturalSwapPrompt(5, { prepared: false });
  assert.match(p, /the other 5 photos/);
  assert.match(p, /Take nothing else from them/);
  assert.match(p, /no smile, no frown/);
  assert.match(p, /light the face only with the light of the first photo/i);
  assert.doesNotMatch(p, /Copy the face as it appears there/);
  // Hazırlanmış referans yolu değişmedi.
  assert.match(buildNaturalSwapPrompt(1), /Copy the face as it appears there/);
});
