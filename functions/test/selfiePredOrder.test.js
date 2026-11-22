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

// 2026-11-17 (f8c1718b): aşağı bakan şablona eğimce en yakın selfie 2. sıraya (falPhotos.PITCH_ADD_*).
const F8 = [[0.2, -0.8], [-20.2, 3.7], [21.7, 4.1], [-35.8, 3.0], [40.8, 5.9], [-8.5, 0.8], [14.8, 2.3], [-26.7, 6.0], [34.9, 8.5], [0.3, -17.9]];
const f8 = (ty, tp) => selfieOrderForYaw(F8.map((s) => s[0]), ty, true, { selfie: F8.map((s) => s[1]), tpl: tp });
test("10'lu set: aşağı bakan dönük şablonda çene-aşağı kare 2. sıraya girer, ilk sıra değişmez", () => {
  const r = f8(34.5, -20.9); // c9
  assert.equal(r.order[0], 8);
  assert.equal(r.order[1], 9);
  assert.deepEqual(r.pitchAdd, { idx: 9, from: 4 });
  // Düz ya da az eğik şablonda dokunulmaz.
  for (const [ty, tp] of [[-17.6, 5.7], [26.8, -5.7], [-37.3, -7.9]]) assert.equal(f8(ty, tp).pitchAdd, undefined);
  // Zaten ilk sıradaysa (c1) değişmez.
  const c1 = f8(2.8, -9.8);
  assert.equal(c1.order[0], 9);
  assert.equal(c1.pitchAdd, undefined);
  // 5'li sette hiç çalışmaz.
  const five = selfieOrderForYaw([0.2, -20.2, 21.7, 0.3, 40.8], 34.5, true, { selfie: [-0.8, 3.7, 4.1, -17.9, 5.9], tpl: -20.9 });
  assert.equal(five.pitchAdd, undefined);
});

// 2026-11-19: 10'lu havuzda ilk sıra (kazanç 36°'de biter) + düz şablonda profil koruması.
const KU = { y: [19.2, 1.1, -22.8, -36.6, 39.9, -11.3, 16.6, -26.1, 28.1, -1.2], p: [-0.9, -1.5, -1.2, 0.3, -0.2, -2.5, 3.4, 0.6, 1.8, -16.9] };
const ON = { y: F8.map((s) => s[0]), p: F8.map((s) => s[1]) };
const pick = (P, T, Tp) => selfieOrderForYaw(P.y, T, true, Tp === null ? null : { selfie: P.p, tpl: Tp });
const top5 = (P, T, Tp) => pick(P, T, Tp).order.slice(0, 5);

test("10'lu havuz: 33-40° şablonda daha dönük selfie ilk sıraya terfi eder, 5'li aynı kalır", () => {
  assert.deepEqual(top5(KU, -34.6, -7.4), [3, 7, 2, 5, 9]);
  assert.deepEqual(pick(KU, -34.6, -7.4).promoted, { idx: 3, from: 1 });
  // Eğim eki (çene-aşağı) 2. sırada kalır.
  assert.deepEqual(top5(KU, -34.8, -13.6), [3, 9, 7, 2, 5]);
  assert.deepEqual(top5(KU, 38.4, 5.6), [4, 8, 0, 6, 1]);
  assert.deepEqual(top5(ON, 33.7, -2.4), [8, 2, 4, 6, 0]);
  assert.deepEqual(top5(KU, -35, null), [3, 7, 2, 5, 9]);
});

test("10'lu havuz: selfie eğimi tek başına ilk sırayı değiştirmez (yalnız yönce kesin daha yakınsa terfi)", () => {
  const { selfieOrderCore } = require("../falPhotos")._testables;
  const g36 = (d, T) => { const a = Math.abs(d); const t = Math.min(1, Math.max(0, (a - 30) / 6)); return Math.abs(d * (1.2 - 0.2 * t) - T); };
  let n = 0;
  for (const P of [KU, ON]) for (let T = -55; T <= 55; T += 0.1) for (const Tp of [-25, -12, -7, 0, 5]) {
    const r = pick(P, T, Tp);
    if (!r.promoted) continue;
    n++;
    const was = selfieOrderCore(P.y, T, true, { selfie: P.p, tpl: Tp }).order[0];
    assert.ok(g36(P.y[r.promoted.idx], T) < g36(P.y[was], T), `T=${T.toFixed(1)}/${Tp}: ${P.y[was]} → ${P.y[r.promoted.idx]}`);
    // Terfi hiçbir zaman 5'linin dışından gelmez (yalnız sıra değişir).
    assert.ok(r.promoted.from < 5);
  }
  assert.ok(n > 0);
  // Onur T +38.0/0: eğim yüzünden 34.9 → 40.8 terfisi yok.
  assert.equal(ON.y[pick(ON, 38.0, 0).order[0]], 34.9);
});

test("10'lu havuz: düz şablonda 2-5. sıradaki ≥35° selfie yerine seviyeli kare gider", () => {
  assert.deepEqual(top5(KU, 14.2, 1.1), [6, 0, 1, 8, 5]);
  assert.deepEqual(pick(KU, 14.2, 1.1).profileGuard, [4]);
  assert.deepEqual(top5(KU, -17.3, 2.3), [5, 2, 7, 1, 6]);
  assert.deepEqual(pick(KU, -17.3, 2.3).profileGuard, [3]);
  assert.deepEqual(top5(ON, 20, 0), [6, 2, 0, 8, 5]); // 40.8 çıkar, 34.9 kalır
  assert.deepEqual(top5(ON, -17.6, 5.7), [1, 5, 7, 0, 6]);
  // Seviyeli şablona yedek olarak çene-aşağı kare konmaz.
  assert.ok(!top5(KU, 18, -3).includes(9), `${top5(KU, 18, -3)}`);
  assert.ok(!top5(ON, -20, -5).includes(9), `${top5(ON, -20, -5)}`);
  // Yedek yoksa profil geri girer.
  assert.deepEqual(selfieOrderForYaw([0, 40, -40, 45, -45, 38], 0, true, { selfie: [0, 0, 0, 0, 0, 0], tpl: 0 }).order.slice(0, 5), [0, 5, 1, 2, 3]);
  // Hiçbir düz şablonda (|T| ≤ 20) gerçek havuzlardan 2-5. sıraya ≥35° girmez.
  for (const P of [KU, ON]) for (let T = -20; T <= 20; T += 0.5) for (const Tp of [-25, -12, -7, 0, 5]) {
    assert.ok(!top5(P, T, Tp).some((i) => Math.abs(P.y[i]) >= 35), `T=${T}/${Tp}: ${top5(P, T, Tp)}`);
  }
});

test("10'lu havuz: değişmemesi gereken şablonlar", () => {
  assert.deepEqual(top5(KU, 31.4, 2.8), [8, 0, 6, 4, 1]);
  assert.deepEqual(top5(KU, -25.9, -1.2), [2, 7, 5, 3, 1]);
  assert.deepEqual(top5(KU, 0, 0), [1, 5, 6, 0, 2]);
  assert.deepEqual(top5(KU, 0, -20.7), [9, 1, 5, 6, 0]);
  assert.deepEqual(top5(KU, -44, 0), [3, 7, 2, 5, 1]);
  assert.deepEqual(top5(KU, 55, 0), [4, 8, 0, 6, 1]);
  assert.deepEqual(top5(ON, 16.2, -9.3), [6, 2, 9, 0, 5]); // +34.9 girmemeli
  assert.deepEqual(top5(ON, 7.4, -0.9), [0, 6, 5, 2, 1]);
  // bestErr eski eğride kalır (ikinci üretim atlama kuralı değişmez).
  assert.ok(Math.abs(pick(KU, -45, 0).bestErr - 4.53) < 0.05);
});

test("3/5'li setler ve predict=false: sonuç eski kuralla bayt bayt aynı", () => {
  const { selfieOrderCore } = require("../falPhotos")._testables;
  const sets = [ONUR, [-1.2, -24.5, 13.4], [0.2, -20.2, 21.7, -35.8, 40.8]];
  for (const s of sets) for (let T = -60; T <= 60; T += 2.5) for (const pr of [true, false]) {
    for (const pt of [null, { selfie: s.map(() => 0), tpl: -10 }]) {
      assert.deepEqual(selfieOrderForYaw(s, T, pr, pt), selfieOrderCore(s, T, pr, pt));
    }
  }
  for (let T = -60; T <= 60; T += 2.5) assert.deepEqual(selfieOrderForYaw(KU.y, T, false, { selfie: KU.p, tpl: 0 }), selfieOrderCore(KU.y, T, false, { selfie: KU.p, tpl: 0 }));
  // Ölçüsüz: null yaw sona, hiç terfi etmez; şablon yaw'ı null → sıra aynen.
  assert.deepEqual(selfieOrderForYaw([null, -26, -37, -10, 5, 20], -36, true, { selfie: [0, 0, 0, 0, 0, 0], tpl: 0 }).order, [2, 1, 3, 4, 5, 0]);
  assert.deepEqual(selfieOrderForYaw(KU.y, null).order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
