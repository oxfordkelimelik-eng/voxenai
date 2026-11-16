const { test } = require("node:test");
const assert = require("node:assert/strict");
const { predictedOutYaw, selfieOrderForYaw, UNREACHABLE_SKIP_DEG } = require("../falPhotos")._testables;

// Onur seti (dosya sırası 0..4), 2026-11-12..16 işleri.
const ONUR = [-1.2, -24.5, 13.4, -44.0, 49.9];
// Şablonlar c0..c9 (3B yaw).
const TPL = { c0: 16.2, c1: -17.3, c2: -44.3, c3: -0.8, c4: 54.2, c5: -34.8, c6: -25.9, c7: -20.7, c8: 3.7, c9: 7.8 };

test("predictedOutYaw: orta açı ~%20 fazla dönük, uçta kazanç yok, işaret korunur", () => {
  assert.ok(Math.abs(predictedOutYaw(-24.5) - -29.4) < 0.05);
  assert.ok(Math.abs(predictedOutYaw(13.4) - 16.08) < 0.05);
  assert.equal(predictedOutYaw(-44), -44);
  assert.equal(predictedOutYaw(49.9), 49.9);
  assert.equal(predictedOutYaw(0), 0);
  assert.equal(predictedOutYaw(null), null);
  // Geçiş kesintisiz ve tekdüze artan.
  let prev = -Infinity;
  for (let d = 0; d <= 60; d += 0.5) {
    const p = predictedOutYaw(d);
    assert.ok(p >= prev, `tekdüze değil: ${d}`);
    prev = p;
  }
});

test("selfieOrderForYaw: c5'te öne −24.5 gelir (eski kural −44), diğer 9 şablonda ilk selfie aynı", () => {
  for (const [c, t] of Object.entries(TPL)) {
    const yeni = selfieOrderForYaw(ONUR, t, true).order;
    const eski = selfieOrderForYaw(ONUR, t, false).order;
    assert.equal(yeni.length, 5);
    assert.deepEqual(yeni.slice().sort(), [0, 1, 2, 3, 4], `${c}: selfie eksildi`);
    if (c === "c5") {
      assert.equal(ONUR[eski[0]], -44.0);
      assert.equal(ONUR[yeni[0]], -24.5);
    } else {
      assert.equal(yeni[0], eski[0], `${c}: ilk selfie değişti`);
    }
  }
});

test("selfieOrderForYaw: bestErr karşılığı olan/olmayan şablonu ayırır", () => {
  const e = Object.fromEntries(Object.entries(TPL).map(([c, t]) => [c, selfieOrderForYaw(ONUR, t).bestErr]));
  for (const c of ["c0", "c2", "c3", "c4", "c5", "c6", "c8"]) assert.ok(e[c] < UNREACHABLE_SKIP_DEG, `${c}: ${e[c]}`);
  for (const c of ["c1", "c7", "c9"]) assert.ok(e[c] >= UNREACHABLE_SKIP_DEG, `${c}: ${e[c]}`);
  // Sıralama kuralından bağımsız (eski sırada da aynı).
  assert.equal(selfieOrderForYaw(ONUR, TPL.c1, false).bestErr, e.c1);
});

// 10'lu çekim: ön, sağa 4 adım, sola 4 adım, çene aşağı (uygulama yükleme sırası:
// eski 5'e en yakınlar önce). [yaw, pitch]
const TEN = [
  [-1, 0], [18, 1], [-20, 0], [48, -2], [-48, 1], // ilk 5 (ön, R2, L2, R4, L4)
  [9, 0], [-10, 1], [30, -1], [-31, 0], [0, -20], // R1, L1, R3, L3, aşağı
];
const yaws = TEN.map((p) => p[0]);
const pit = (tpl) => ({ selfie: TEN.map((p) => p[1]), tpl });

test("10'lu set: düz şablona çene-aşağı kare gitmez, eğik şablona ilk o gider", () => {
  const duz = selfieOrderForYaw(yaws, 2, true, pit(2)).order.slice(0, 5);
  assert.ok(!duz.includes(9), `düz şablona aşağı kare gitti: ${duz}`);
  const egik = selfieOrderForYaw(yaws, 6, true, pit(-21)).order;
  assert.equal(egik[0], 9);
  // Çok dönük eğik şablonda (c2: −44/−30) önden aşağı kare öne GEÇMEZ (baş düzleşirdi).
  const c2 = selfieOrderForYaw(yaws, -44.3, true, pit(-29.7)).order;
  assert.equal(c2[0], 4);
});

test("10'lu set: arada kalan şablon (c1 −17, c7 −21, c5 −35, c9 +8) artık ≤5° çizimle karşılanır", () => {
  for (const t of [-17.3, -20.7, -34.8, 7.8, 16.2, -25.9]) {
    const r = selfieOrderForYaw(yaws, t, true, pit(0));
    assert.ok(r.bestErr < UNREACHABLE_SKIP_DEG, `${t}: ${r.bestErr}`);
  }
});

test("5'li sette eğim verilse de sıra eskisiyle aynı (eğim yalnız 5'ten fazla adayda)", () => {
  for (const t of Object.values(TPL)) {
    const a = selfieOrderForYaw(ONUR, t, true).order;
    const b = selfieOrderForYaw(ONUR, t, true, { selfie: [0, -15, 5, -3, 20], tpl: -25 }).order;
    assert.deepEqual(b, a);
  }
});

test("selfieOrderForYaw: ölçü yoksa sıra aynen, ölçülemeyen selfie sona", () => {
  assert.deepEqual(selfieOrderForYaw(ONUR, null), { order: [0, 1, 2, 3, 4], bestErr: null });
  assert.deepEqual(selfieOrderForYaw([null, null], 10), { order: [0, 1], bestErr: null });
  assert.deepEqual(selfieOrderForYaw([null, 12, null, -30], 10).order, [1, 3, 0, 2]);
});
