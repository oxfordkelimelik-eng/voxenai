// ghostClean iz büyütme (2026-11-04, 80fc7ec4 c0 bej bant): iz beklenen kafanın
// içine yalnız "arka plan" sınıfı yüksek, deri olmayan, kaş üstü, ize bağlı
// piksellerden ve sınırlı derinlikte ilerler; gerçek saç (arka plan≈0) korunur.
const test = require("node:test");
const assert = require("node:assert");
const { growGhostIntoExpected, growGhostRim, growGhostSkinRemnant, protectRealHair, GROW_DEPTH_FACE, RIM_DEPTH_FACE, SKIN_REMNANT_ABOVE_BROW_FACE } = require("../ghostClean")._testables;

const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
const n = 40;

function scene() {
  const N = n * n;
  const Po = Array.from({ length: 6 }, () => new Float32Array(N));
  const Th = new Uint8Array(N).fill(1); // her yer şablon kafası alanı
  const Ex = new Uint8Array(N); // beklenen kafa: satır 10..39
  const cand = new Uint8Array(N); // dışarıdaki iz: satır 5..9
  const userSkin = new Uint8Array(N), inOval = new Uint8Array(N);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (y >= 10) Ex[i] = 1;
    if (y >= 5 && y < 10) cand[i] = 1;
    // satır 10..12: iz bandı (saç≈1, arka plan≈1); 13..: gerçek saç (arka plan 0)
    Po[CLASSES.hair][i] = 1;
    Po[CLASSES.background][i] = y < 13 ? 1 : 0;
    if (y >= 25) { Po[CLASSES.faceSkin][i] = 1; userSkin[i] = 1; inOval[i] = 1; }
  }
  return { Po, Th, Ex, cand, userSkin, inOval };
}

test("iz bandı büyütülür, gerçek saç (arka plan≈0) korunur", () => {
  const s = scene();
  const g = growGhostIntoExpected(s.cand, { ...s, CLASSES, n, browO: 30, fwk: 100 });
  for (let x = 0; x < n; x++) {
    for (const y of [10, 11, 12]) assert.strictEqual(g[y * n + x], 1, `bant y=${y}`);
    for (const y of [13, 18, 24]) assert.strictEqual(g[y * n + x], 0, `saç y=${y}`);
  }
});

test("ize bağlı olmayan arka plan sınıfı pikseli (saç içi) büyütülmez", () => {
  const s = scene();
  // saçın ortasında kopuk bir "arka plan" adası (ör. parlama yanlış sınıf)
  for (let y = 18; y < 21; y++) for (let x = 15; x < 20; x++) s.Po[CLASSES.background][y * n + x] = 1;
  const g = growGhostIntoExpected(s.cand, { ...s, CLASSES, n, browO: 30, fwk: 100 });
  for (let y = 18; y < 21; y++) for (let x = 15; x < 20; x++) assert.strictEqual(g[y * n + x], 0);
});

test("kaş altı, deri ve yüz ovali hiç büyütülmez", () => {
  const s = scene();
  for (let i = 0; i < n * n; i++) s.Po[CLASSES.background][i] = 1; // her yer "arka plan"
  const g = growGhostIntoExpected(s.cand, { ...s, CLASSES, n, browO: 20, fwk: 1000 });
  for (let x = 0; x < n; x++) {
    assert.strictEqual(g[22 * n + x], 0, "kaş altı");
    assert.strictEqual(g[30 * n + x], 0, "deri/oval");
  }
});

test("derinlik sınırı: iz en çok GROW_DEPTH_FACE·yüz kadar içeri ilerler", () => {
  const s = scene();
  for (let i = 0; i < n * n; i++) s.Po[CLASSES.background][i] = 1;
  const fwk = 20; // derinlik = 0.15·20 = 3 px
  const g = growGhostIntoExpected(s.cand, { ...s, CLASSES, n, browO: 40, fwk });
  const maxD = Math.floor(GROW_DEPTH_FACE * fwk);
  assert.strictEqual(g[(9 + maxD) * n + 5], 1, "sınır içinde");
  assert.strictEqual(g[(9 + maxD + 1) * n + 5], 0, "sınır dışında");
});

test("iz yoksa hiçbir şey büyütülmez", () => {
  const s = scene();
  s.cand.fill(0);
  const g = growGhostIntoExpected(s.cand, { ...s, CLASSES, n, browO: 30, fwk: 100 });
  assert.strictEqual(g.reduce((a, b) => a + b, 0), 0);
});

// --- Kenar (rim) ve şablon alnı izi kuralları (80fc7ec4 c0 açık kenar / sol üst bej kama) ---
const U = [71, 58, 48]; // kullanıcının saç rengi
function rimScene({ lightRows = [10, 11], ovalRows = [], bg = 0.1, skinRows = [], userSkinRows = [] } = {}) {
  const s = scene();
  s.oF = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const c = lightRows.includes(y) ? [132, 118, 105] : [72, 58, 48];
    s.oF.set(c, i * 3);
    s.Po[CLASSES.background][i] = y < 10 ? 1 : (lightRows.includes(y) ? bg : 0);
    s.Po[CLASSES.faceSkin][i] = skinRows.includes(y) ? 1 : 0;
    s.userSkin[i] = userSkinRows.includes(y) ? 1 : 0;
    s.inOval[i] = ovalRows.includes(y) ? 1 : 0;
  }
  return s;
}

test("kenar: ize bitişik açık şerit iz sayılır, koyu gerçek saç korunur", () => {
  const s = rimScene();
  const g = growGhostRim(s.cand, { ...s, CLASSES, n, browO: 35, fwk: 100, U });
  for (let x = 0; x < n; x++) {
    assert.strictEqual(g[10 * n + x], 1); assert.strictEqual(g[11 * n + x], 1);
    assert.strictEqual(g[12 * n + x], 0, "koyu saç");
  }
});

test("kenar: kullanıcının saçından KOYU piksel (gölgedeki siyah saç) kenar sayılmaz", () => {
  // 80fc7ec4 c0 v9: (35,26,21) saç, U=(71,58,48) → uzaklık > RIM_DIFF ama koyu.
  const s = rimScene();
  for (let x = 0; x < n; x++) s.oF.set([30, 24, 20], (10 * n + x) * 3);
  const g = growGhostRim(s.cand, { ...s, CLASSES, n, browO: 35, fwk: 100, U });
  for (let x = 0; x < n; x++) assert.strictEqual(g[10 * n + x], 0, `koyu saç x=${x}`);
});

test("kenar: yüz ovali içinde arka plan sınıfı düşükse dokunulmaz, yüksekse iz", () => {
  const low = rimScene({ ovalRows: [10, 11], bg: 0.1 });
  const gl = growGhostRim(low.cand, { ...low, CLASSES, n, browO: 35, fwk: 100, U });
  assert.strictEqual(gl[10 * n + 3], 0);
  const high = rimScene({ ovalRows: [10, 11], bg: 0.5 });
  const gh = growGhostRim(high.cand, { ...high, CLASSES, n, browO: 35, fwk: 100, U });
  assert.strictEqual(gh[10 * n + 3], 1);
});

test("kenar: derinlik sınırı ve kullanıcı saç rengi yoksa hiçbir şey", () => {
  const rows = Array.from({ length: 20 }, (_, k) => 10 + k);
  const s = rimScene({ lightRows: rows });
  const fwk = 50; // 0.06·50 = 3 px
  const g = growGhostRim(s.cand, { ...s, CLASSES, n, browO: 40, fwk, U });
  const maxD = Math.floor(RIM_DEPTH_FACE * fwk);
  assert.strictEqual(g[(9 + maxD) * n + 2], 1);
  assert.strictEqual(g[(9 + maxD + 1) * n + 2], 0);
  const none = growGhostRim(s.cand, { ...s, CLASSES, n, browO: 40, fwk, U: null });
  assert.strictEqual(none.reduce((a, b) => a + b, 0), 0);
});

test("şablon alnı izi: kaşın belirgin üstündeki, kullanıcı derisine bağlı olmayan deri iz sayılır", () => {
  const s = rimScene({ lightRows: [10, 11, 12], skinRows: [10, 11, 12] });
  const fwk = 40, browO = 20; // yMax = 20 − 0.15·40 = 14
  const g = growGhostSkinRemnant(s.cand, { ...s, CLASSES, n, browO, fwk, U });
  for (const y of [10, 11, 12]) assert.strictEqual(g[y * n + 4], 1, `y=${y}`);
  assert.ok(browO - SKIN_REMNANT_ABOVE_BROW_FACE * fwk > 12);
});

test("şablon alnı izi: kullanıcının yüz derisi ve kaş hizasına yakın deri (kulak) korunur", () => {
  const s = rimScene({ lightRows: [10, 11, 12, 13, 14, 15], skinRows: [10, 11, 12, 13, 14, 15], userSkinRows: [10, 11] });
  const fwk = 40, browO = 20; // yMax = 14
  const g = growGhostSkinRemnant(s.cand, { ...s, CLASSES, n, browO, fwk, U });
  assert.strictEqual(g[10 * n + 4], 0, "kullanıcı derisi");
  assert.strictEqual(g[11 * n + 4], 0, "kullanıcı derisi");
  assert.strictEqual(g[15 * n + 4], 0, "kaş hizasına yakın");
});

// --- Gerçek saç koruması (a4433ad1 c6: selfie çizgisi enseyi kapsamıyordu, koyu ense saçı siliniyordu) ---
function protectScene() {
  const N = n * n;
  const Po = Array.from({ length: 6 }, () => new Float32Array(N));
  const Th = new Uint8Array(N).fill(1);
  const Ex = new Uint8Array(N), Ho = new Uint8Array(N), keep = new Uint8Array(N);
  const oF = new Float32Array(N * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (x < 20) { Ex[i] = 1; Ho[i] = 1; } // beklenen kafa: sol yarı
    Po[CLASSES.hair][i] = 1;
    // x 20..29: koyu gerçek ense saçı (arka plan 0); x 30..34: kubbe (arka plan 1); x 35..: açık şablon saçı
    Po[CLASSES.background][i] = x >= 30 && x < 35 ? 1 : 0;
    const c = x < 30 ? [22, 22, 20] : x < 35 ? [60, 52, 45] : [180, 150, 90];
    oF.set(c, i * 3);
  }
  return { Po, Th, Ex, Ho, keep, oF };
}

test("koruma: kafaya bağlı koyu gerçek saç (arka plan≈0) beklenen kafanın dışında da korunur", () => {
  const s = protectScene();
  const p = protectRealHair({ ...s, CLASSES, n, fwk: 100, U: [52, 46, 39] });
  for (const x of [20, 25, 29]) assert.strictEqual(p[10 * n + x], 1, `ense x=${x}`);
});

test("koruma: kubbe (saç≈1 ve arka plan≈1) ve açık renkli şablon saçı korunmaz", () => {
  const s = protectScene();
  const p = protectRealHair({ ...s, CLASSES, n, fwk: 100, U: [52, 46, 39] });
  for (const x of [30, 33]) assert.strictEqual(p[10 * n + x], 0, `kubbe x=${x}`);
  for (const x of [36, 39]) assert.strictEqual(p[10 * n + x], 0, `açık saç x=${x}`);
});

test("koruma: kullanıcı saç rengi yoksa hiçbir şey korunmaz (eski davranış)", () => {
  const s = protectScene();
  const p = protectRealHair({ ...s, CLASSES, n, fwk: 100, U: null });
  assert.strictEqual(p.reduce((a, b) => a + b, 0), 0);
});

// --- Kullanıcının yarı saydam bukle kenarı (b932fd71 c0: gökyüzüne karşı kıvırcık saç) ---
const { protectUserFringe } = require("../ghostClean")._testables;
function fringeScene(edgeColor, tplColor) {
  const N = n * n;
  const Th = new Uint8Array(N).fill(1), seed = new Uint8Array(N);
  const oF = new Float32Array(N * 3), tF = new Float32Array(N * 3);
  const bg = { ok: new Uint8Array(N).fill(1), v: new Float32Array(N * 3) };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    bg.v.set([220, 195, 155], i * 3);
    tF.set(tplColor, i * 3);
    if (y >= 20) { seed[i] = 1; oF.set([20, 19, 16], i * 3); } // opak kullanıcı saçı
    else if (y >= 16) oF.set(edgeColor, i * 3); // kenar bandı
    else oF.set([220, 195, 155], i * 3);
  }
  return { seed, Th, oF, tF, bg };
}
const UB = [20, 19, 16];
test("bukle: kullanıcı saçı + zemin karışımı, şablon rengiyle açıklanamıyorsa korunur", () => {
  const s = fringeScene([105, 91, 78], [150, 120, 90]);
  const p = protectUserFringe({ ...s, n, fwk: 100, U: UB });
  for (const y of [16, 18, 19]) assert.strictEqual(p[y * n + 5], 1, `y=${y}`);
});
test("bukle: renk şablonla daha iyi açıklanıyorsa (hayalet) korunmaz", () => {
  // kenar = 0.5·şablon(150,120,90) + 0.5·zemin
  const s = fringeScene([185, 157, 122], [150, 120, 90]);
  const p = protectUserFringe({ ...s, n, fwk: 100, U: UB });
  assert.strictEqual(p[18 * n + 5], 0);
});
test("bukle: kullanıcı saç rengi yoksa hiçbir şey korunmaz", () => {
  const s = fringeScene([105, 91, 78], [150, 120, 90]);
  const p = protectUserFringe({ ...s, n, fwk: 100, U: null });
  assert.strictEqual(p.reduce((a, b) => a + b, 0), 0);
});

// --- Güçlü iz süzgeci ve doku korelasyonu (2026-11-05 v18 görsel inceleme) ---
const { keepStrongGhost, localNcc } = require("../ghostClean")._testables;
test("güçlü iz: opak kafaya bitişik ince bileşen bırakılır, uzağa taşan kalır", () => {
  const N = n * n, cand = new Uint8Array(N), Od = new Float32Array(N);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) Od[y * n + x] = Math.max(0, 20 - y); // kafa y≥20
  for (let x = 2; x < 8; x++) for (let y = 17; y < 20; y++) cand[y * n + x] = 1; // ince bant (uzaklık ≤3)
  for (let x = 20; x < 26; x++) for (let y = 5; y < 20; y++) cand[y * n + x] = 1; // uzağa taşan (≤15)
  const dropped = keepStrongGhost(cand, Od, 7, n);
  assert.strictEqual(cand[18 * n + 4], 0, "ince bant");
  assert.strictEqual(cand[10 * n + 22], 1, "kubbe");
  assert.strictEqual(dropped, 18);
});
test("doku korelasyonu: şablon dokusunu taşıyan çıktı yüksek, düz çıktı 0", () => {
  const N = n * n, t = new Uint8Array(N * 3), o = new Uint8Array(N * 3), flat = new Uint8Array(N * 3).fill(120);
  for (let i = 0; i < N; i++) { const v = ((i * 7919) % 97) + 60; t.fill(v, i * 3, i * 3 + 3); o.fill(Math.round(0.3 * v + 0.7 * 200), i * 3, i * 3 + 3); }
  const a = localNcc(o, t, n, 3), b = localNcc(flat, t, n, 3);
  assert.ok(a.ncc[20 * n + 20] > 0.9);
  assert.strictEqual(b.ncc[20 * n + 20], 0);
});
