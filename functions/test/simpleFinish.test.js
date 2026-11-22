// Sade akışın son adımları (2026-10-30, 922f1371): yüz sahne ışığı planı,
// kafa bükme yardımcıları, selfie yan profil şartı.
const test = require("node:test");
const assert = require("node:assert");
const { _testables: tone } = require("../faceTone");
const { _testables: warp } = require("../headWarp");
const { selfieSideCoverage, SELFIE_SIDE_MIN } = require("../gazeGate");
const { _testables: ghost } = require("../ghostClean");

const Lab2Y = (L) => ((L + 16) / 116) ** 3;

test("yüz şablondan parlaksa koyulaşır (922f1371 c2: çıktı L 50.7, şablon 35.4)", () => {
  const p = tone.planTone({ Y: Lab2Y(35.4), a: 10, b: 12 }, { Y: Lab2Y(50.7), a: 10, b: 15 }, 0.87);
  assert.ok(p.ok);
  assert.ok(p.logGain < 0, "koyulaşmalı");
  assert.ok(p.logGain >= tone.GAIN_MIN - 1e-12, "alt sınır");
});

test("koyu tenli kullanıcı açık tenli şablona eşitlenmez: pigment oranı hedefi düşürür", () => {
  const same = tone.planTone({ Y: 0.2, a: 10, b: 15 }, { Y: 0.2, a: 10, b: 15 }, 1);
  const darker = tone.planTone({ Y: 0.2, a: 10, b: 15 }, { Y: 0.2, a: 10, b: 15 }, 0.78);
  assert.strictEqual(same.logGain, 0);
  assert.ok(darker.logGain < 0);
});

test("küçük fark dokunulmaz, renk kayması yarım güç ve sınırlı (CHROMA.FACE açıkken)", () => {
  tone.CHROMA.FACE = true;
  try {
    const p = tone.planTone({ Y: 0.2, a: 10, b: 30 }, { Y: 0.203, a: 10, b: 10 }, 1);
    assert.strictEqual(p.logGain, 0);
    assert.strictEqual(p.db, tone.CHROMA_MAX);
    const q = tone.planTone({ Y: 0.2, a: 10.5, b: 15.5 }, { Y: 0.2, a: 10, b: 15 }, 1);
    assert.strictEqual(q.da, 0);
    assert.strictEqual(q.db, 0);
  } finally {
    tone.CHROMA.FACE = false;
  }
});

test("yalnız parlaklık (11-20): varsayılan renk kayması yok, parlaklık aynen", () => {
  assert.strictEqual(tone.CHROMA.FACE, false);
  assert.strictEqual(tone.CHROMA.NECK, false);
  const tpl = { Y: Lab2Y(35.4), a: 10, b: 30 }, out = { Y: Lab2Y(50.7), a: 10, b: 10 };
  const off = tone.planTone(tpl, out, 1);
  assert.strictEqual(off.da, 0);
  assert.strictEqual(off.db, 0);
  tone.CHROMA.FACE = true;
  try {
    const on = tone.planTone(tpl, out, 1);
    assert.strictEqual(on.logGain, off.logGain);
    assert.ok(on.db > 0);
  } finally {
    tone.CHROMA.FACE = false;
  }
});

test("kafa alfası: kişi maskesi dışındaki 'others' (gökyüzü) kafa sayılmaz, içindeki (şapka) sayılır (248a0e72 c5)", () => {
  const W = 40, H = 60, N = W * H;
  const CLASSES = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
  const P = Array.from({ length: 6 }, () => new Float32Array(N));
  const box = { x: 15, y: 30, width: 10, height: 12 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (y >= 30 && y < 42 && x >= 15 && x < 25) P[CLASSES.faceSkin][i] = 1;
    if (y >= 12 && y < 30 && x >= 15 && x < 25) P[CLASSES.others][i] = 1; // kafanın üstü: others
  }
  const S = { P, CLASSES, W, H, box, work: new Uint8Array(N * 3).fill(128) };
  const sky = new Float32Array(N); // kişi maskesi yalnız yüz + y≥24 (şapkanın alt yarısı)
  for (let y = 24; y < 42; y++) for (let x = 15; x < 25; x++) sky[y * W + x] = 1;
  const A = tone.headAlpha(S, null, sky);
  assert.strictEqual(A.head[15 * W + 20], 0, "kişi dışı others (gökyüzü) kararmaz");
  assert.strictEqual(A.head[26 * W + 20], 1, "kişi içindeki others (şapka) kafaya dahil");
  assert.strictEqual(A.head[35 * W + 20], 1, "yüz");
  const noPm = tone.headAlpha(S, null, null);
  assert.strictEqual(noPm.head[15 * W + 20], 1, "kişi maskesi yoksa eski davranış");
});

test("ışık yönü: şablon yüzünün sol-sağ eğimi çıktıya aktarılır, dikey yarım", () => {
  const p = tone.planTone(
    { Y: 0.2, a: 10, b: 15, slope: { gu: -0.9, gv: 0 } },
    { Y: 0.2, a: 10, b: 15, slope: { gu: 0.6, gv: 0 } }, 1);
  assert.ok(p.gu < 0);
  assert.ok(Math.abs(p.gu) <= 0.9 + 1e-12);
  assert.strictEqual(p.gv, 0);
});

test("kırpılmış ortalama uç değerleri dışlar", () => {
  const v = tone.trimmedMean([1, 1, 1, 1, 1, 1, 1, 1, 1, 100]);
  assert.strictEqual(v, 1);
});

test("uzaklık dönüşümü: maskeye uzaklık doğru artar", () => {
  const W = 7, H = 1;
  const m = new Uint8Array([1, 0, 0, 0, 0, 0, 0]);
  const d = warp.distanceTo(m, W, H);
  assert.deepStrictEqual(Array.from(d), [0, 1, 2, 3, 4, 5, 6]);
});

test("düz çizgi payı: tek uzun kenar yüksek, düz zemin sıfır", () => {
  const W = 80, H = 80;
  const flat = new Uint8Array(W * H).fill(120);
  assert.strictEqual(warp.lineShare(flat, W, H, 40, 40, 5, 38, 80), 0);
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = x < 20 ? 30 : 200;
  assert.ok(warp.lineShare(edge, W, H, 40, 40, 5, 38, 80) > 0);
});

test("yan profil şartı: 922f1371 seti (hepsi cephe) reddedilir, doğru set geçer", () => {
  const bad = selfieSideCoverage([0.09, 0.02, 0.06, 0.0, 0.23]);
  assert.strictEqual(bad.ok, false);
  const good = selfieSideCoverage([-0.03, 0.81, -0.51, 1.0, -1.0]);
  assert.strictEqual(good.ok, true);
});

test("yan profil şartı: canlıdaki zayıf ama dönük setler durdurulmaz (46 set, 10-05..30)", () => {
  for (const s of [[0.21, 0.33, 0.0, 0.14, 0.43], [0.02, 0.36, 0.25, 0.42, null], [0.4, 0.53, 0.28, 0.04, 0.4], [0.25, 0.02, 0.27, 0.56, 0.27]]) {
    assert.strictEqual(selfieSideCoverage(s).ok, true, JSON.stringify(s));
  }
  assert.ok(SELFIE_SIDE_MIN > 0.23 && SELFIE_SIDE_MIN < 0.42);
});

// Şablon kafası izi (2026-10-30, c2e8eff1 c0/c5/c9).
test("iz: yarı saydam şablon karışımı iz, zemin ve opak kopya değil", () => {
  const t = [200, 170, 120], b = [40, 30, 20];
  const half = [120, 100, 70];
  assert.ok(Math.abs(ghost.ghostAlpha(half, t, b) - 0.5) < 0.05);
  assert.strictEqual(ghost.ghostAlpha(b, t, b), null, "temiz zemin");
  assert.strictEqual(ghost.ghostAlpha(t, t, b), null, "opak: kullanıcının aynı renkte saçı olabilir");
  assert.strictEqual(ghost.ghostAlpha([45, 32, 22], [48, 34, 24], b), null, "kontrast yok, karar yok");
  assert.strictEqual(ghost.ghostAlpha([40, 160, 20], t, b), null, "karışım değil (artık büyük)");
});

test("iz: kenarda kullanıcının kafa rengi daha iyi açıklıyorsa iz değil", () => {
  const t = [60, 45, 35], b = [200, 200, 200], u = [55, 42, 33];
  assert.strictEqual(ghost.ghostAlpha([130, 122, 118], t, b, u), null);
});

test("iz: selfie maskesi göz ortası + çene ucuyla taşınır (ölçek ve yer)", () => {
  const N = 40, src = new Uint8Array(N * N);
  for (let y = 5; y < 15; y++) for (let x = 15; x < 25; x++) src[y * N + x] = 1;
  const E = { x: 20, y: 20 }, C = { x: 20, y: 30 };
  // Hedefte yüz iki kat büyük ve 10 px sağda.
  const out = ghost.mapMask(src, N, E, C, { x: 30, y: 40 }, { x: 30, y: 60 }, 80);
  assert.strictEqual(out[20 * 80 + 30], 1, "kare merkezi (src 20,10) → (30,20)");
  assert.strictEqual(out[20 * 80 + 50], 0);
  assert.strictEqual(out[50 * 80 + 30], 0);
});

test("iz: işaretli dönüş ve göz ortası", () => {
  const P = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  P[36] = { x: 0, y: 0 }; P[45] = { x: 10, y: 0 }; P[30] = { x: 5, y: 5 };
  assert.strictEqual(ghost.signedYaw(P), 0);
  P[30] = { x: 8, y: 5 };
  assert.ok(ghost.signedYaw(P) > 0.5);
  for (let k = 36; k <= 41; k++) P[k] = { x: 2, y: 4 };
  for (let k = 42; k <= 47; k++) P[k] = { x: 8, y: 4 };
  P[8] = { x: 5, y: 20 };
  const ec = ghost.eyeChin(P);
  assert.deepStrictEqual(ec.E, { x: 5, y: 4 });
  assert.deepStrictEqual(ec.C, { x: 5, y: 20 });
});

test("iz: zemin tahmini yalnız ağırlıklı (kafa dışı) piksellerden", () => {
  const W = 9, H = 1, rgb = new Uint8Array(W * 3), w = new Float32Array(W);
  for (let x = 0; x < W; x++) { const v = x < 4 ? 50 : 250; rgb[x * 3] = rgb[x * 3 + 1] = rgb[x * 3 + 2] = v; w[x] = x < 4 ? 1 : 0; }
  const r = ghost.maskedMean(rgb, w, W, H, [1, 4], 0.02);
  assert.strictEqual(r.ok[6], 1);
  assert.strictEqual(r.v[6 * 3], 50, "kafa pikselleri (250) karışmaz");
});

test("yan profil şartı: ölçülemeyen set reddedilmez (fail-open)", () => {
  assert.strictEqual(selfieSideCoverage([null, null, 0.1, null, null]).ok, true);
  assert.strictEqual(selfieSideCoverage([]).ok, true);
});

// Yön eşleşmeli selfie seti (2026-10-30, c2e8eff1; işaretli selfie yönleri).
const { poseMatchedRefSet, POSE_MATCH_MAX } = require("../gazeGate");
const C2E = [-0.01, -0.32, 0.39, -0.85, 0.87];

test("yön seti: düz şablona yarım dönük selfie gitmez (c2e8eff1 düz şablonlar -0.4'e döndü)", () => {
  for (const t of [-0.05, 0.02, -0.06, -0.03, -0.04]) {
    const r = poseMatchedRefSet(C2E, t);
    assert.deepStrictEqual(r.keep.map((k) => k.i), [0], `şablon ${t}`);
    assert.strictEqual(r.keep[0].mirror, false);
  }
});

test("yön seti: dönük şablona aynı yöne bakanlar + en çok bir ayna, ön selfie gitmez", () => {
  const r = poseMatchedRefSet(C2E, 0.97); // c4: 0.97→0.63 eksik döndü
  assert.ok(r.keep.every((k) => Math.abs(k.yaw - 0.97) <= POSE_MATCH_MAX));
  assert.ok(!r.keep.some((k) => k.i === 0), "ön selfie çekmesin");
  assert.deepStrictEqual(r.keep.map((k) => `${k.i}${k.mirror ? "m" : ""}`), ["4", "3m"]);
  const q = poseMatchedRefSet(C2E, -0.62); // c5
  assert.ok(q.keep.every((k) => Math.abs(k.yaw + 0.62) <= POSE_MATCH_MAX));
  assert.ok(q.keep.filter((k) => k.mirror).length <= 1);
});

test("yön seti: hepsi tek yana dönükse karşı yandaki şablon için ayna; hiçbiri yakın değilse en yakını", () => {
  const r = poseMatchedRefSet([0.9, 0.95, 0.5], -0.9);
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].mirror, true);
  const q = poseMatchedRefSet([0.9, 0.95], 0.0);
  assert.strictEqual(q.reason, "closest-only");
  assert.strictEqual(q.keep.length, 1);
});

test("yön seti: kimlik çapası (0.) yöne uyuyorsa başta; ölçü yoksa null", () => {
  const r = poseMatchedRefSet([0.1, 0.0, 0.05], 0.0);
  assert.strictEqual(r.keep[0].i, 0);
  assert.strictEqual(poseMatchedRefSet(C2E, null), null);
  assert.strictEqual(poseMatchedRefSet([null, null], 0.1), null);
});

// Yüz = vücut teni (2026-10-30, c2e8eff1 c1: yüz göğüsten açık, boyunda kesik).
test("ton: hedef şablon yüzü × karedeki vücudun şablona oranı (sınırlı)", () => {
  const tpl = { Y: 0.1, a: 10, b: 12 };
  assert.strictEqual(tone.bodyAdjustedTarget(tpl, null).tpl.Y, 0.1, "vücut yoksa eski hedef");
  assert.ok(Math.abs(tone.bodyAdjustedTarget(tpl, { ratio: 0.9 }).tpl.Y - 0.09) < 1e-12);
  assert.strictEqual(tone.bodyAdjustedTarget(tpl, { ratio: 5 }).bodyRatio, 2);
  // 2026-11-08 (27deeec2 c5, kullanıcı: "ten çok koyu"): karartma en çok ×0.8, payı 0.4.
  assert.ok(Math.abs(tone.GAIN_MIN - Math.log(0.8)) < 1e-12, "karartma en çok ×0.8");
  assert.ok(tone.GAIN_BETA <= 0.4 + 1e-12, "farkın en çok 0.4'ü uygulanır");
});

test("ton: kararsız pikseller komşu değerle dolar, kıyafet tohumu sıfırda tutar", () => {
  const W = 9, H = 1, g = new Float32Array(W), w = new Float32Array(W);
  g[0] = 1; w[0] = 1; // kesin yüz
  w[8] = 1; // kesin kıyafet (0)
  const out = tone.propagate(g, w, W, H, 3);
  assert.ok(out[2] > 0.6 && out[2] > out[6], "yüzün yanındaki kararsız piksel kazancı alır (boyun yanı)");
  assert.ok(out[8] < 0.01, "kıyafet değişmez");
});

// 3B baş pozu ve selfie'yi base pozuna çevirme (2026-10-31, 21e56b20).
const pose3d = require("../headPose3d");
const { poseRefPlanDeg } = require("../gazeGate");
const canonImg = () => pose3d._testables.CANON.map(([x, y, z]) => [200 + 20 * x, 200 - 20 * y, -20 * z]);

test("3B poz: kanonik yüz önden 0/0/0, döndürülmüş ağ dönüş açısını verir", () => {
  const m = canonImg();
  const p = pose3d.poseFromMesh(m);
  assert.ok(Math.abs(p.yaw) < 0.5 && Math.abs(p.pitch) < 0.5 && Math.abs(p.roll) < 0.5, JSON.stringify(p));
  for (const [dy, dp] of [[20, 0], [-15, 0], [0, -20], [10, 12]]) {
    const q = pose3d.poseFromMesh(pose3d._testables.rotateMesh(m, dy, dp));
    assert.ok(Math.abs(q.yaw - dy) < 1.5, `yaw ${dy}: ${q.yaw}`);
    assert.ok(Math.abs(q.pitch - dp) < 1.5, `pitch ${dp}: ${q.pitch}`);
  }
});

test("3B poz: yaw > 0 burnu görüntünün sağına götürür, pitch < 0 aşağı", () => {
  const m = canonImg();
  const r = pose3d._testables.rotateMesh(m, 20, 0);
  assert.ok(r[1][0] > m[1][0] + 5, "burun ucu sağa");
  const d = pose3d._testables.rotateMesh(m, 0, -20);
  assert.ok(d[1][1] > m[1][1] + 3, "burun ucu aşağı");
});

test("3B poz: aynı ağ → sıfır geri yer değiştirme", () => {
  const m = canonImg();
  const F = pose3d._testables.backwardField(m, m, require("../faceMesh").triangles(), 400, 400, 4);
  let mx = 0;
  for (let i = 0; i < F.fx.length; i++) mx = Math.max(mx, Math.abs(F.fx[i]), Math.abs(F.fy[i]));
  assert.ok(mx < 1e-3, `en büyük kayma ${mx}`);
});

test("poz planı (derece): Kutay seti, en az çevrilecek selfie; kameraya doğru çevirme pahalı", () => {
  const s = [-2.6, 36.8, -28.2, 55, -57.6];
  const ids = (t) => poseRefPlanDeg(s, t).keep.map((k) => `${k.i}${k.mirror ? "m" : ""}`);
  assert.deepStrictEqual(ids(3.7), ["0"], "düz şablon: yalnız ön");
  assert.deepStrictEqual(ids(-17.5), ["0"], "önü 15° dışa çevirmek, yarımı 11° içe çevirmekten iyi");
  assert.deepStrictEqual(ids(-34.8), ["1m", "2"], "ikincisi 8° içinde");
  assert.deepStrictEqual(ids(16.2), ["2m"]);
  assert.strictEqual(poseRefPlanDeg(s, null), null);
  assert.strictEqual(poseRefPlanDeg([null, null], 5), null);
});

test("iz: selfie 3B poz farkıyla seçilir, pay dereceyle büyür (21e c7: −17/−21 çıktı, ön selfie kafayı sildirdi)", () => {
  const P = (yaw, pitch, y68) => ({ yaw: y68, pose3d: pitch == null ? null : { yaw, pitch } });
  const profs = [P(8, -6, 0.06), P(-15, -9, -0.26), P(40, 1, 0.76)];
  const r = ghost.pickProfile(profs, 0.0, { yaw: -17, pitch: -21 });
  assert.strictEqual(r.prof, profs[1], "en yakın 3B poz");
  assert.ok(Math.abs(r.deg - Math.hypot(2, 12)) < 1e-9);
  assert.ok(r.margin > ghost.EXP_MARGIN_FACE + 0.03, `pay ${r.margin}`);
  const same = ghost.pickProfile(profs, 0.76, { yaw: 40, pitch: 1 });
  assert.strictEqual(same.margin, ghost.EXP_MARGIN_FACE, "aynı poz: taban pay");
  const near = ghost.pickProfile(profs, 0, { yaw: 13, pitch: -3 });
  assert.strictEqual(near.margin, ghost.EXP_MARGIN_FACE, "küçük farkta (≤6°) pay büyümez — c2e c0 sarı tutam");
  const far = ghost.pickProfile([P(0, 0, 0)], 0, { yaw: 80, pitch: 40 });
  assert.strictEqual(far.margin, ghost.EXP_MARGIN_MAX, "üst sınır");
  // Ağ yoksa eski 68 noktalı yaw seçimi.
  const old = ghost.pickProfile([P(0, null, 0.1), P(0, null, 0.8)], 0.7, null);
  assert.strictEqual(old.prof.yaw, 0.8);
  assert.strictEqual(old.deg, null);
  assert.strictEqual(ghost.pickProfile([], 0, null), null);
});

test("ton kenarı: zemin pikseli değişmez, kenar pikseli yalnız kafa payı kadar koyulaşır", () => {
  const F = [0.05, 0.04, 0.03], B = [0.6, 0.55, 0.5];
  assert.strictEqual(tone.matteAlpha(B, F, B), 0, "saf zemin");
  assert.strictEqual(tone.matteAlpha(F, F, B), 1, "saf kafa");
  const mix = F.map((f, c) => 0.3 * f + 0.7 * B[c]);
  assert.ok(Math.abs(tone.matteAlpha(mix, F, B) - 0.3) < 1e-9);
  // I' = k·I + (1−k)(1−α)·B: α=0.3, k=0.5 → zemin payı aynı, kafa payı yarı.
  const k = 0.5, a = 0.3;
  const out = mix.map((v, c) => k * v + (1 - k) * (1 - a) * B[c]);
  out.forEach((v, c) => assert.ok(Math.abs(v - (a * k * F[c] + (1 - a) * B[c])) < 1e-12));
  assert.strictEqual(tone.matteAlpha([0.1, 0.1, 0.1], [0.1, 0.1, 0.1], [0.11, 0.1, 0.1]), null, "karşıtlık yok");
});

test("ton kenarı: yerel kafa/zemin rengi ağırlıklı ortalama, kapsama yoksa geçersiz", () => {
  const W = 20, H = 1, lin = new Float32Array(W * 3), fg = new Float32Array(W), bg = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const v = x < 10 ? 0.05 : 0.6;
    lin[x * 3] = lin[x * 3 + 1] = lin[x * 3 + 2] = v;
    if (x < 8) fg[x] = 1;
    if (x > 11) bg[x] = 1;
  }
  const m = tone.edgeMatteFields(lin, fg, bg, W, H, 3);
  assert.ok(Math.abs(m.F[10 * 3] - 0.05) < 1e-6 && Math.abs(m.B[10 * 3] - 0.6) < 1e-6);
  assert.strictEqual(m.ok[10], 1);
  assert.strictEqual(m.ok[0], 0, "zemin uzakta");
});

// VÜCUT IŞIĞI TEK ORAN (2026-11-06, kullanıcı: "tüm vücut aynı oranda almalı").
test("vücut ışığı: kopuk el ve boyna bağlı göğüs aynı oranı alır, yatay terim vücuda gitmez", () => {
  const plan = { gu: 0.8, gv: 0.3 };
  const fcy = 100, fh = 100;
  // Vücut pikselleri (ah=0, ab=1): sağ uçta el, ortada göğüs — x hesaba girmez.
  const handFar = tone.bodyLightLog(plan, 0.8 * 0.75 + 0.3 * 0.75, 400, fcy, fh, 0, 1);
  const chest = tone.bodyLightLog(plan, 0.3 * 0.75, 400, fcy, fh, 0, 1);
  assert.ok(Math.abs(handFar - chest) < 1e-12, `el ${handFar} göğüs ${chest}`);
  assert.ok(Math.abs(chest - 0.3 * tone.SLOPE_UV_MAX) < 1e-12);
});

test("vücut ışığı: yüzde tam düzlem, boyun bandında sürekli geçiş", () => {
  const plan = { gu: 0.8, gv: 0.3 };
  const fcy = 100, fh = 100, full = 0.5;
  assert.strictEqual(tone.bodyLightLog(plan, full, 120, fcy, fh, 1, 1), full, "yüz bugünküyle aynı");
  // ah 1 → 0 boyunca katkı sıçramadan değişir.
  let prev = null;
  for (let k = 0; k <= 20; k++) {
    const ah = 1 - k / 20;
    const v = tone.bodyLightLog(plan, full, 160, fcy, fh, ah, 1);
    if (prev != null) assert.ok(Math.abs(v - prev) <= Math.abs(full - 0.3 * 0.6) / 20 + 1e-9);
    prev = v;
  }
  assert.strictEqual(tone.bodyLightLog({ gu: 0, gv: 0 }, 0, 300, fcy, fh, 0, 1), 0);
});

// 2026-11-13: güçlü yan ışıklı şablonda (|gu| ≥ 1.0) pay 0.85, sınır ±1.3 (79956cb2 c1: −1.82).
test("ışık yönü: güçlü yan ışık daha çok aktarılır, düz şablonda değişmez", () => {
  const p = tone.planTone({ Y: 0.2, a: 10, b: 15, slope: { gu: -1.82, gv: 0 } }, { Y: 0.2, a: 10, b: 15, slope: { gu: -0.07, gv: 0 } }, 1);
  assert.ok(Math.abs(p.gu - -1.3) < 1e-9, String(p.gu));
  const q = tone.planTone({ Y: 0.2, a: 10, b: 15, slope: { gu: -0.5, gv: 0 } }, { Y: 0.2, a: 10, b: 15, slope: { gu: 0, gv: 0 } }, 1);
  assert.ok(Math.abs(q.gu - -0.35) < 1e-9, String(q.gu));
});

// 2026-11-13: karanlık sahne (şablonda yüz çevresi koyu, ten aynı) → ×0.50'ye kadar.
test("karartma: yalnız karanlık sahnede ×0.50'ye iner", () => {
  const t = { Y: 0.03, a: 10, b: 15 }, o = { Y: 0.2, a: 10, b: 15 };
  assert.ok(Math.abs(Math.exp(tone.planTone(t, o, 1).logGain) - 0.8) < 1e-9);
  const d = tone.planTone(t, o, 1, { darkScene: true });
  assert.ok(Math.abs(Math.exp(d.logGain) - 0.5) < 1e-9 && d.deep === true);
  assert.strictEqual(tone.planTone({ Y: 0.4, a: 10, b: 15 }, o, 1, { darkScene: true }).deep, false);
});

// 2026-11-13 (79956cb2 c5 siyah-beyaz): yüz kutusundan uzak "yüz derisi" pikselleri ölçüye girmez.
test("yüz derisi ölçüsü: yüz kutusu dışındaki yanlış deri sayılmaz", () => {
  const { skinStats, SKIN_BOX } = tone;
  const W = 100, H = 100, CLASSES = { faceSkin: 0, hair: 1, others: 2 };
  const P = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  const work = new Uint8Array(W * H * 3);
  const box = { x: 40, y: 40, width: 20, height: 20 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, inFace = x >= 40 && x < 60 && y >= 40 && y < 60;
    if (inFace || y > 80) { P[0][i] = 0.9; const v = inFace ? 180 : 10; work[i * 3] = work[i * 3 + 1] = work[i * 3 + 2] = v; }
  }
  const st = skinStats({ P, CLASSES, W, H, work, box });
  assert.strictEqual(st.n, 400);
  SKIN_BOX.ON = false;
  try { assert.ok(skinStats({ P, CLASSES, W, H, work, box }).n > 400); } finally { SKIN_BOX.ON = true; }
});

// 2026-11-13 (79956cb2 c4/c2): çıktıda yüz kendi boynundan şablondakinden ≥3 L parlaksa iki ölçünün yumuşağına kadar.
test("boyun işareti: yüz boynundan fazla parlaksa karartma açılır, küçük farkta değişmez", () => {
  const t = { Y: 0.06, a: 10, b: 15 }, o = { Y: 0.13, a: 10, b: 15 };
  const base = tone.planTone(t, o, 1);
  assert.ok(Math.abs(Math.exp(base.logGain) - 0.8) < 1e-9);
  const n = tone.planTone(t, o, 1, { neck: { excess: 7.4, outL: 43 } });
  assert.ok(n.neckUsed && n.logGain < base.logGain && n.logGain >= tone.NECK_MATCH.MIN - 1e-12, String(n.logGain));
  assert.ok(n.logGain >= n.raw - 1e-12, "şablon ölçüsünden derine inmez");
  assert.strictEqual(tone.planTone(t, o, 1, { neck: { excess: 2, outL: 43 } }).logGain, base.logGain);
  // Ters yön (boyun yüzü parlatmak istiyor, şablon karartmak istiyor) → dokunmaz.
  assert.strictEqual(tone.planTone(t, o, 1, { neck: { excess: -6, outL: 43 } }).logGain, base.logGain);
});

// 2026-11-14 (43c2e739 c4): arkadan ışıklı gündüz şablonunda karartma ×0.70'e kadar; işaret yoksa değişmez.
test("arkadan ışık: yalnız işaretli karede ×0.80 sınırı ×0.70'e açılır", () => {
  const t = { Y: 0.05, a: 10, b: 15 }, o = { Y: 0.14, a: 10, b: 15 };
  const base = tone.planTone(t, o, 1);
  assert.ok(Math.abs(Math.exp(base.logGain) - 0.8) < 1e-9 && base.backlit === false);
  const b = tone.planTone(t, o, 1, { backlit: true });
  assert.ok(b.backlit && Math.abs(Math.exp(b.logGain) - 0.7) < 1e-9, String(Math.exp(b.logGain)));
  // Açma yönünde (raw > 0) arkadan ışık işareti hiçbir şey yapmaz.
  assert.strictEqual(tone.planTone(o, t, 1, { backlit: true }).logGain, tone.planTone(o, t, 1).logGain);
});

// 2026-11-14 (43c2e739 c9): ışıklı, yüzü şablon yüzü + pay üstüne açmaz; pay büyükse eski sınır.
test("ışıklı yüz sınırı: şablon yüzü tavanı yalnız daha sıkıysa uygulanır", () => {
  const { faceCapOf, FACE_CAP } = require("../faceGlow")._testables;
  const W = 120, H = 120, N = W * H, CLASSES = { background: 0, faceSkin: 1, hair: 2, bodySkin: 3 };
  const P = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (x >= 45 && x < 75 && y >= 45 && y < 75) P[1][i] = 1; else P[0][i] = 1; }
  const rgb = Buffer.alloc(N * 3, 80), wMap = new Float32Array(N).fill(1), tDL = new Float32Array(401).fill(5);
  const free = faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL);
  assert.ok(Math.abs(free.limit - (5 + FACE_CAP.MARGIN)) < 1e-6 && !free.tplCapped);
  const tight = faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL, 1);
  assert.ok(tight.tplCapped && Math.abs(tight.limit - 1) < 1e-9);
  assert.strictEqual(faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL, -4).limit, 0);
  assert.ok(!faceCapOf(rgb, W, H, P, CLASSES, wMap, tDL, 20).tplCapped);
});
