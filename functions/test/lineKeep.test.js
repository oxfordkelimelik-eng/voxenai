const test = require("node:test");
const assert = require("node:assert");
const { _testables: HT } = require("../headWarp");
const { keepLines, _testables: LT } = require("../lineKeep");

const smooth = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/**
 * Sentetik kare: gri arka plan, kafanın soluna uzanan koyu yatay çubuk (y 60-67),
 * daire kafa; alan warpHead formülüyle (çene ucu çevresinde küçültme, kafa
 * dışında 1.4·kafa boyu bantta sönme). Döner { rgb, F, render }.
 */
function synth({ k = 1, s = 0.85, guard = false } = {}) {
  const W = 260 * k, H = 240 * k, barY = 50 * k;
  const rgb = Buffer.alloc(W * H * 3, 150);
  const cx = 150 * k, cy = 110 * k, R = 42 * k;
  const m = new Uint8Array(W * H), head = new Float32Array(W * H), prot = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (Math.hypot(x - cx, y - cy) <= R) { m[i] = 1; head[i] = 1; rgb[i * 3] = 90; rgb[i * 3 + 1] = 70; rgb[i * 3 + 2] = 60; }
    else if (y >= barY && y < barY + 8 * k && x < cx) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 30; }
  }
  const dist = HT.distanceTo(m, W, H);
  const chinY = cy + R, faceH = 60 * k, headH = 2 * R, A = { x: cx, y: chinY };
  const band = 1.4 * headH, top = chinY - 0.05 * faceH;
  const Dx = new Float64Array(W * H), Dy = new Float64Array(W * H), act = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const vfall = 1 - smooth((y - top) / (0.5 * faceH));
    if (vfall <= 0) continue;
    const w = (m[i] ? 1 : 1 - smooth(dist[i] / band)) * vfall;
    if (w <= 0.002) continue;
    const sx = A.x + (x - A.x) / s, sy = A.y + (y - A.y) / s;
    Dx[i] = w * (sx - x); Dy[i] = w * (sy - y); act[i] = 1;
  }
  const F = { rx0: 0, ry0: 0, RW: W, RH: H, FW: W, FH: H, m, dist, head, prot, Dx, Dy, act, faceH, headH, s, chinY, browY: chinY - faceH };
  if (guard) HT.borderGuard(Dx, Dy, F); // warpHead'de olduğu gibi: bugünkü alan kenar korumalı
  const sample = (fx, fy, c) => {
    const xx = Math.max(0, Math.min(W - 1.001, fx)), yy = Math.max(0, Math.min(H - 1.001, fy));
    const xa = Math.floor(xx), ya = Math.floor(yy), ax = xx - xa, ay = yy - ya, i00 = (ya * W + xa) * 3 + c;
    return (rgb[i00] * (1 - ax) + rgb[i00 + 3] * ax) * (1 - ay) + (rgb[i00 + W * 3] * (1 - ax) + rgb[i00 + W * 3 + 3] * ax) * ay;
  };
  const render = (X, Y, on) => {
    const out = Buffer.from(rgb);
    for (let i = 0; i < W * H; i++) if (on[i]) { const x = i % W, y = (i - x) / W; for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(sample(x + X[i], y + Y[i], c)); }
    return out;
  };
  return { rgb, F, render };
}

test("kenar koruması: taşma yoksa alan bayt bayt aynı (11-06 öncesi çıktı)", () => {
  const { F } = synth();
  const X = Float64Array.from(F.Dx), Y = Float64Array.from(F.Dy);
  // ROI karenin ortasında (her yanda 100 px pay): kaynak hep karenin içinde.
  const r = HT.borderGuard(X, Y, { rx0: 100, ry0: 100, RW: F.RW, RH: F.RH, FW: F.FW + 200, FH: F.FH + 200 });
  assert.ok(r.ov <= HT.BORDER_TOL, `taşma ${r.ov}`);
  for (let i = 0; i < X.length; i++) { assert.strictEqual(X[i], F.Dx[i]); assert.strictEqual(Y[i], F.Dy[i]); }
});

test("kenar koruması: sentetik kafa sağ kenara yakınken taşma ≤ 1 px'e iner", () => {
  const { F } = synth();
  const X = Float64Array.from(F.Dx), Y = Float64Array.from(F.Dy);
  const r = HT.borderGuard(X, Y, F);
  assert.ok(r.ov > 3, `sentetik alan sağdan taşıyor (${r.ov})`);
  assert.ok(r.after <= HT.BORDER_TOL);
  assert.ok(r.ramp[3] > 0 && r.ramp[2] === 0, "taşan kenar rampalı, taşmayan (sol) değil");
  // Kafa içi (kenardan uzak) değişmez.
  const i = 110 * F.RW + 150; // k=1: kafa merkezi
  assert.strictEqual(X[i], F.Dx[i]);
});

test("kenar koruması: üst kenardan taşan alan kenarda sıfır, en çok 1 px dışarı, katlanma yok", () => {
  const W = 50, H = 200, Dx = new Float64Array(W * H), Dy = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) { Dy[i] = -20; Dx[i] = 5; } // kafa üst kenarda: kaynak 20 px yukarıda, 5 px sağda
  const r = HT.borderGuard(Dx, Dy, { rx0: 0, ry0: 0, RW: W, RH: H, FW: W + 20, FH: H }); // sağda pay: yalnız üst taşar
  assert.ok(r.ov >= 19, `ilk taşma ${r.ov}`);
  assert.ok(r.after <= HT.BORDER_TOL, `kalan taşma ${r.after}`);
  for (let y = 0; y < H; y++) {
    assert.ok(y + Dy[y * W + 7] >= -HT.BORDER_TOL - 1e-9, `satır ${y} dışarıdan örnekliyor`);
    if (y > 0) assert.ok(1 + Dy[y * W + 7] - Dy[(y - 1) * W + 7] > 0.3, `satır ${y} katlanma/aşırı esneme`);
  }
  assert.strictEqual(Math.abs(Dy[7]), 0);
  // Yalnız kenara dik bileşen söner: yatay kayma her satırda aynı (dikey kasada S basamağı yok, 9c8f2cb5 c9).
  for (let i = 0; i < W * H; i++) assert.strictEqual(Dx[i], 5);
  assert.strictEqual(Dy[(H - 1) * W + 7], -20); // rampanın dışı değişmez
});

test("düz kenar bulucu sentetik çubuğu tek uzun çizgi olarak bulur", () => {
  const W = 120, H = 60, g = new Float32Array(W * H).fill(150);
  for (let y = 28; y < 36; y++) for (let x = 10; x < 110; x++) g[y * W + x] = 30;
  const L = LT.detectLines(g, W, H, null, { minLen: 40, minPts: 12 });
  assert.ok(L.length >= 2, "çubuğun iki kenarı");
  for (const l of L.filter((q) => q.L >= 60)) assert.ok(Math.abs(l.uy) < 0.02, "yatay");
});

test("küçülen kafanın yanındaki çubuk çizgi korumayla düz kalır (bugün eğiliyor)", async () => {
  // Gerçek karelerdeki ölçek (yüz boyu ~120+ px; ızgara hücresi yüz/22).
  const { rgb, F, render } = synth({ k: 2, guard: true });
  const lines = await LT.linesAround(rgb, F.FW, F.FH, F);
  assert.ok(lines.some((l) => l.L >= 60), "çubuk kenarı bulundu");
  const today = render(F.Dx, F.Dy, F.act);
  const r = await keepLines(rgb, F.FW, F.FH, F, { mode: "applied", render, todayOut: today, debug: true });
  const hide = r.dbg.newHead;
  const bT = LT.bendSumm(LT.bendOf(F, F.Dx, F.Dy, lines, hide, 60));
  const bN = LT.bendSumm(LT.bendOf(F, r.dbg.NDx, r.dbg.NDy, lines, hide, 60));
  assert.ok(bT.max > 2, `bugünkü bükme çubuğu eğmeli (${bT.max.toFixed(2)} px)`);
  // Ölçülen 11-06: bugün 6.0 px, yeni 1.5 px (daha sert kısıt kafa yanında katlanma yapıyor).
  assert.ok(bN.max < 2 && bN.max < bT.max / 3, `yeni alan çubuğu düz tutmalı (${bN.max.toFixed(2)} / bugün ${bT.max.toFixed(2)} px)`);
  assert.strictEqual(r.used, true, `kapı: ${r.reason}`);
  assert.strictEqual(r.stats.negN, 0);
  // Kafa (yeni kafa) pikselleri bugünkü alanla aynı: kafa aynı ölçeklenir, kimlik değişmez.
  for (let i = 0; i < hide.length; i++) if (hide[i]) { assert.strictEqual(r.Dx[i], F.Dx[i]); assert.strictEqual(r.Dy[i], F.Dy[i]); }
});

test("kapı tutmazsa (süre) bugünkü alan AYNEN döner", async () => {
  const { rgb, F, render } = synth();
  const today = render(F.Dx, F.Dy, F.act);
  const r = await keepLines(rgb, F.FW, F.FH, F, { mode: "applied", render, todayOut: today, deadline: Date.now() - 1 });
  assert.strictEqual(r.used, false);
  assert.strictEqual(r.Dx, F.Dx);
  assert.strictEqual(r.Dy, F.Dy);
  assert.strictEqual(r.act, F.act);
  assert.strictEqual(r.out, null);
});

test("aşama 1 gerçek kapı (yeniden algılama) tutmazsa bugünkü alan ve çıktı AYNEN döner", async () => {
  const { rgb, F, render } = synth({ k: 2, guard: true });
  const today = render(F.Dx, F.Dy, F.act);
  const Dx0 = Float64Array.from(F.Dx), Dy0 = Float64Array.from(F.Dy), act0 = Uint8Array.from(F.act);
  // Aday çıktıda çubuk kaybolur (düz gri): yeniden algılama payı düşmeli → çizgiKırık.
  const badRender = (X, Y, on) => (X === F.Dx ? render(X, Y, on) : Buffer.alloc(rgb.length, 150));
  const r = await keepLines(rgb, F.FW, F.FH, F, { mode: "applied", render: badRender, todayOut: today });
  assert.strictEqual(r.used, false);
  assert.match(r.reason, /çizgiKırık/);
  assert.strictEqual(r.Dx, F.Dx);
  assert.strictEqual(r.Dy, F.Dy);
  assert.strictEqual(r.act, F.act);
  assert.strictEqual(r.out, null);
  for (let i = 0; i < Dx0.length; i++) { assert.strictEqual(F.Dx[i], Dx0[i]); assert.strictEqual(F.Dy[i], Dy0[i]); assert.strictEqual(F.act[i], act0[i]); }
  assert.ok(render(F.Dx, F.Dy, F.act).equals(today), "bugünkü çıktı bayt bayt aynı");
});

test("yer duyarlı katlanma: bugünkü katlanmanın yanındaki sayılmaz, yeni yerdeki sayılır", () => {
  const W = 40, H = 40, T = new Uint8Array(W * H), N = new Uint8Array(W * H);
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) T[y * W + x] = 1;
  for (let y = 11; y < 16; y++) for (let x = 11; x < 16; x++) N[y * W + x] = 1; // bugünküne ≤ 3 px: aynı yer
  assert.strictEqual(LT.newAt(N, T, W, H, 3), 0);
  for (let y = 30; y < 33; y++) for (let x = 30; x < 33; x++) N[y * W + x] = 1; // uzakta yeni katlanma
  assert.strictEqual(LT.newAt(N, T, W, H, 3), 9);
  assert.strictEqual(LT.newAt(N, new Uint8Array(W * H), W, H, 3), 25 + 9); // bugün katlanma yok: hepsi yeni
  assert.ok(LT.LK_NEWFOLD_EPS < 82, "7e04933e c1'deki 82 px yeni yerde katlanma reddedilir");
});

test("aşama 2 sıfır tolerans: katlayan alanda kapı reddeder, bugünkü (dokunulmamış) alan döner", async () => {
  const { rgb, F, render } = synth();
  // Bilerek katlanan alan: kafanın solunda dar şeritte ters yönlü sıçrama.
  for (let y = 0; y < F.RH; y++) for (let x = 60; x < 64; x++) { const i = y * F.RW + x; F.Dx[i] += 12; F.act[i] = 1; }
  const r = await keepLines(rgb, F.FW, F.FH, F, { mode: "structured", render, todayOut: rgb });
  assert.strictEqual(r.used, false);
  assert.strictEqual(r.Dx, F.Dx);
  assert.ok(/katlanma|bükülme|esneme|çizgi/.test(r.reason), r.reason);
});

test("bayraklar: çizgi koruma ve düz çizgili arka plan kilidi KAPALI (kullanıcı onayı bekliyor); log biçimi", () => {
  assert.strictEqual(HT.LINE_KEEP_ON, false);
  assert.strictEqual(HT.LINE_KEEP_STRUCTURED, false);
  assert.match(HT.lkLog({ used: false, reason: "süre-bütçesi" }), /çizgiKoru\[ATLANDI\[süre-bütçesi\]\]/);
  assert.match(HT.lkLog({ used: true, lines: 3, bendN: 0.4, bendT: 2.1, indN: 0.5, indT: 2, negN: 0, negT: 0, strN: 0, strT: 0, it: 50, ms: 300 }), /çizgiKoru\[UYGULANDI çizgi=3 bükülme=0.4\/2.1/);
});
