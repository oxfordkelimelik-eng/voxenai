const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measureSilhouette, approxSilFromFaceBox, landmarkSizeRatio, eyeFreeLandmarkRatio, eyewearFaceRatio, planLandmarkScale, MIN_SCALE, MIN_SCALE_EXTREME, SOFT_MIN_SCALE, MAX_SCALE, BODY_ALIGNED_IOU, FACE_ALIGNED_SHIFT, perceivedHeadRatio, _scaleHeadPatch, _encodeInpaint, _finishInpaint } = require("../headScale");
const sharp = require("sharp");
const { dilate } = require("../sceneRestore");

// KAFA ÖLÇEĞİ (2026-10-07). Sentetik kişi maskesi: elips kafa + dikdörtgen
// gövde. Yüz kutusu kafanın alt 3/4'ü (ssd_mobilenetv1 kaş-çene arası verir).
function figure({ W = 400, H = 600, cx = 200, headTop = 100, headW = 80, headH = 100, shoulderW = 240 } = {}) {
  const m = new Float32Array(W * H);
  const hy = headTop + headH / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inHead = ((x - cx) / (headW / 2)) ** 2 + ((y - hy) / (headH / 2)) ** 2 <= 1;
      const neck = y >= headTop + headH - 5 && y < headTop + headH + 20 && Math.abs(x - cx) < headW * 0.3;
      const body = y >= headTop + headH + 20 && Math.abs(x - cx) < shoulderW / 2;
      if (inHead || neck || body) m[y * W + x] = 1;
    }
  }
  const box = { x: cx - headW * 0.4, y: headTop + headH * 0.3, width: headW * 0.8, height: headH * 0.7 };
  return { m, W, H, box };
}

test("siluet: kafa genişliği, yüksekliği ve omuz ölçülür", () => {
  const f = figure();
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.headW - 80) <= 3, `headW=${r.headW}`);
  assert.ok(Math.abs(r.top - 100) <= 2, `top=${r.top}`);
  assert.ok(Math.abs(r.shoulderW - 240) <= 3, `shoulderW=${r.shoulderW}`);
});

test("omuzlar kadraj dışındaysa ölçüm reddedilir", () => {
  const f = figure({ H: 230 });
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shoulders-out-of-frame");
});

test("kafa üstü kadraja değiyorsa ölçüm reddedilir", () => {
  const f = figure({ headTop: -10 });
  const r = measureSilhouette(f.m, f.W, f.H, f.box);
  assert.equal(r.ok, false);
});

test("approxSilFromFaceBox: çene, merkez ve kafa genişliği doğru hesaplanır", () => {
  const box = { x: 100, y: 120, width: 80, height: 100 };
  const s = approxSilFromFaceBox(box);
  assert.equal(s.ok, true);
  assert.equal(s.cx, 140);                            // x + width/2
  assert.equal(s.chin, 220);                          // y + height
  assert.ok(s.top < 120, `top=${s.top}`);             // saç dahil üst kafa tepesi
  assert.ok(s.headW > 80, `headW=${s.headW}`);        // yüzden geniş
  assert.ok(s.headH > 0);
});

test("dilate: tek piksel r yarıçaplı kareye büyür", () => {
  const W = 9, H = 9, b = new Uint8Array(W * H);
  b[4 * W + 4] = 1;
  const d = dilate(b, W, H, 2);
  let n = 0;
  for (const v of d) n += v;
  assert.equal(n, 25);
  assert.equal(d[2 * W + 2], 1);
  assert.equal(d[1 * W + 4], 0);
});

// 68 noktalı sentetik yüz: ölçek k ile büyütülmüş kopyanın oranı k olmalı.
function fakeFace(k = 1, cx = 200, cy = 200) {
  const P = [];
  for (let i = 0; i < 68; i++) P.push({ x: cx, y: cy });
  for (let i = 0; i <= 16; i++) P[i] = { x: cx + k * (-60 + 7.5 * i), y: cy + k * (Math.abs(8 - i) < 3 ? 70 : 40) };
  P[8] = { x: cx, y: cy + k * 80 };
  for (let i = 17; i <= 26; i++) P[i] = { x: cx + k * (-40 + 9 * (i - 17)), y: cy - k * 30 };
  P[27] = { x: cx, y: cy - k * 15 };
  P[33] = { x: cx, y: cy + k * 25 };
  for (let i = 36; i <= 47; i++) P[i] = { x: cx + k * (i < 42 ? -25 : 25), y: cy - k * 15 };
  return P;
}

test("landmark: 1.12 büyük yüz 1.12 ölçülür", () => {
  const r = landmarkSizeRatio(fakeFace(1.12), fakeFace(1));
  assert.ok(Math.abs(r.ratio - 1.12) < 1e-9, `ratio=${r.ratio}`);
});

test("landmark: gür sakal çene noktasını kaydırsa da medyan oynamaz", () => {
  const o = fakeFace(1.0);
  const t = fakeFace(1.0);
  t[8] = { x: t[8].x, y: t[8].y - 25 }; // şablonda çene noktası sakalın içinde yukarıda
  const r = landmarkSizeRatio(o, t);
  assert.ok(Math.abs(r.ratio - 1) < 0.02, `ratio=${r.ratio}`);
});
test("plan: büyük kafa tam şablon oranına küçültülür (aşım çarpanı yok)", () => {
  const p = planLandmarkScale(1.06, { bodyIou: 0.95 });
  assert.equal(p.apply, true);
  assert.ok(Math.abs(p.s - 1 / 1.06) < 1e-9);
});

test("plan: küçük kafa büyütülür", () => {
  const p = planLandmarkScale(0.93, { bodyIou: 0.95 });
  assert.equal(p.apply, true);
  // Büyütme MAX_SCALE ile sınırlı (büyütme yönünde şikâyet nadir; ölçü el ya
  // da sakal örtüsünde yanılabiliyor).
  assert.ok(p.s > 1 && Math.abs(p.s - Math.min(MAX_SCALE, 1 / 0.93)) < 1e-9);
});

test("plan: küçük sapmaya dokunulmaz", () => {
  assert.equal(planLandmarkScale(1.02, { bodyIou: 0.95 }).apply, false);
  assert.equal(planLandmarkScale(0.98, { bodyIou: 0.95 }).reason, "within-tolerance");
});

test("plan: gövde örtüşmüyor ve yüz kaymışsa (yeniden kadraj) dokunulmaz", () => {
  const p = planLandmarkScale(1.2, { bodyIou: BODY_ALIGNED_IOU - 0.1, faceShift: 1.2 });
  assert.equal(p.apply, false);
  assert.equal(p.reason, "reframed");
});

test("plan: ölçek sınırları", () => {
  assert.equal(planLandmarkScale(1.25, { bodyIou: 0.95 }).s, MIN_SCALE);
  // 2× ölçü tespit hatasıdır; kademe uygulanmaz (bkz. RAMP_TRUST_MIN_RAW_S).
  assert.equal(planLandmarkScale(2, { bodyIou: 0.95 }).s, SOFT_MIN_SCALE);
  assert.equal(planLandmarkScale(0.5, { bodyIou: 0.95 }).s, MAX_SCALE);
});

// 2026-10-09 (f9f3b5c0 c6): kafa bükülmez, kesilip ölçeklenir; çevre sabit kalır.
function headScene(headRx, headRy) {
  const W = 160, H = 200;
  // cy: kafa merkezi; şablon kafası çenesi aynı boyunda olacak şekilde verilir.
  // tone: kişi rengi (şablon kişisi ayrı tonla çizilir ki hayaleti görünsün).
  const mk = (rx, ry, cy = 70, tone = 40) => {
    const buf = Buffer.alloc(W * H * 3, 255);
    const m = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const head = ((x - 80) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const body = y >= 130 && Math.abs(x - 80) < 60; // omuzlar
      const neck = y >= 100 && y < 130 && Math.abs(x - 80) < 10;
      if (head || body || neck) { const c = Array.isArray(tone) ? tone : [tone, tone, tone]; buf[(y * W + x) * 3] = c[0]; buf[(y * W + x) * 3 + 1] = c[1]; buf[(y * W + x) * 3 + 2] = c[2]; m[y * W + x] = 1; }
    }
    return { buf, m };
  };
  return { W, H, mk, o: mk(headRx, headRy) };
}

// Şablon kişisi kırmızı çizilir: çıktı gri, arka plan beyaz; kırmızılık = şablon.
const RED = [220, 40, 40];
const ghost = (B, W, H) => { let n = 0; for (let i = 0; i < W * H; i++) if (B[i * 3] - B[i * 3 + 1] > 25) n++; return n; };

test("scaleHeadPatch: küçültmede kafa küçülür, halka şablon arka planıyla dolar, çevre ve gövde değişmez", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(22, 30, 110 - 30, RED);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
  const s = 25 / 30;
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, s);
  const dark = (B, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < sc.W; x++) if (B[(y * sc.W + x) * 3] < 128) n++; return n; };
  assert.ok(!r.skipped && dark(r.buf, 0, 95) < dark(sc.o.buf, 0, 95) * 0.95, "kafa küçülmedi: " + r.sEff);
  // omuzlar ve uzak sütunlar bire bir aynı: eğilme/bükülme yok
  const same = (y0, y1, x0, x1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) if (r.buf[(y * sc.W + x) * 3 + c] !== sc.o.buf[(y * sc.W + x) * 3 + c]) return false; return true; };
  assert.ok(same(135, sc.H, 0, sc.W), "omuzlar değişti");
  assert.ok(same(0, sc.H, 0, 30), "sol çevre değişti");
  assert.ok(same(0, sc.H, 130, sc.W), "sağ çevre değişti");
  // eski kafanın taşan kenarı (x=80+29,y=70) artık beyaz arka plan
  assert.ok(r.buf[(70 * sc.W + 109) * 3] > 200, "halka doldurulmadı");
  // şablon kişisi (kırmızı) hiçbir yerde görünmüyor; 2026-10-09'dan beri
  // ölçek daraltılmaz, şablon kişisinin açılacağı yer delik sayılıp doldurulur
  assert.equal(ghost(r.buf, sc.W, sc.H), 0, "şablon kişisi halkada göründü");
  assert.equal(r.sEff, s, "ölçek daraltıldı: " + r.sEff);
});

// b8ae3f8d c1/c2: şablon kafası çıktı kadar büyük. Eskiden küçültme hiç
// yapılmıyordu (şablon saçı/gözlüğü açılırdı); 2026-10-09'dan beri şablon
// kişisinin açılacağı yer delik sayılır ve doldurulur.
test("scaleHeadPatch: şablon kafası çıktı kadar büyükse de küçültür, şablon kişisi açılmaz", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(30, 40, 70, RED);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 0.9);
  assert.ok(!r.skipped);
  const dark = (B) => { let n = 0; for (let y = 0; y < 95; y++) for (let x = 0; x < sc.W; x++) if (B[(y * sc.W + x) * 3] < 128) n++; return n; };
  assert.ok(dark(r.buf) < dark(sc.o.buf) * 0.9, "kafa küçülmedi");
  assert.equal(ghost(r.buf, sc.W, sc.H), 0, "şablon kişisi göründü");
  assert.ok(r.holePx > 0);
});

// e0eb8dd5 c2/c8 (2026-10-12): kafanın yanındaki koyu nesne (şemsiye) ya da
// arkadaki kişi kişi maskesinde görünür; kafaya bağlı değilse küçültülmez,
// deliğe girmez, yerinde kalır.
test("scaleHeadPatch: kafaya bağlı olmayan nesne küçültülmez, silinmez", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(25, 34, 75, RED);
  // kafa ortasının üstünde, kafadan tel payından (8 px) uzak dikey direk
  for (let y = 20; y < 75; y++) for (let x = 122; x < 130; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(10, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30, { deferInpaint: true });
  assert.notEqual(r.skipped, true);
  for (let y = 20; y < 75; y++) {
    for (let x = 122; x < 130; x++) {
      assert.ok(r.buf[(y * sc.W + x) * 3] <= 12, `direk değişti (${x},${y})`);
      assert.equal(r.holeMask ? r.holeMask[y * sc.W + x] : 0, 0, `direk deliğe girdi (${x},${y})`);
    }
  }
  // yeni kafa yerel dolgu modeline bağlam olarak verilmez
  assert.ok(r.inpaint && r.inpaint.headC && r.inpaint.headC.some((v) => v));
});

// 2026-10-26 (9987f742 c6, ca61076a c6): kafanın tepesine yapışık hayalet
// (kişi maskesinde, sınıfı arka plan) kafayla birlikte aşağı taşınıp yeni
// saçın üstünde şekil olarak kalıyordu. notHead pikselleri taşınmaz.
test("scaleHeadPatch: kafaya yapışık hayalet (notHead) kafayla taşınmaz", () => {
  const BLUE = [40, 40, 210];
  const run = (useNotHead) => {
    const sc = headScene(30, 40);
    const t = sc.mk(30, 40, 70, RED);
    const notHead = new Float32Array(sc.W * sc.H);
    for (let y = 18; y < 31; y++) {
      for (let x = 70; x < 90; x++) {
        const g = y * sc.W + x;
        sc.o.m[g] = 1;
        sc.o.buf[g * 3] = BLUE[0]; sc.o.buf[g * 3 + 1] = BLUE[1]; sc.o.buf[g * 3 + 2] = BLUE[2];
        notHead[g] = 1;
      }
    }
    const sil = { cx: 80, top: 18, chin: 110, headW: 60, headH: 92, seedX: 80 };
    const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 0.9, useNotHead ? { notHead } : {});
    assert.notEqual(r.skipped, true);
    let blue = 0;
    for (let i = 0; i < sc.W * sc.H; i++) if (r.buf[i * 3 + 2] - r.buf[i * 3] > 100) blue++;
    return { blue, r };
  };
  const before = run(false);
  assert.ok(before.blue > 50, `hayalet taşınmadı (eski davranış): ${before.blue}`);
  const after = run(true);
  assert.equal(after.blue, 0, "hayalet kafayla taşındı");
  // kafa yine küçüldü
  assert.ok(after.r.holePx > 0);
});

// AI dolgusu (2026-10-09): yalnızca delik pikselleri değişir; model arka
// planı değiştirdiyse sonuç kullanılmaz.
async function inpaintJob() {
  const sc = headScene(30, 40);
  const t = sc.mk(30, 40, 70, RED);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 0.9, { deferInpaint: true });
  const base = await sharp(r.buf, { raw: { width: sc.W, height: sc.H, channels: 3 } }).png().toBuffer();
  return { sc, r, job: r.inpaint, base };
}
const rawOf = async (b) => (await sharp(b).removeAlpha().raw().toBuffer());
const cropPng = (job, rgb) => sharp(rgb, { raw: { width: job.side, height: job.side, channels: 3 } }).resize(1024, 1024).png().toBuffer();

test("inpaint: maske deliği şeffaf, kalanı opak", async () => {
  const { job } = await inpaintJob();
  assert.ok(job);
  const { image, mask } = await _encodeInpaint(job);
  const mi = await sharp(mask).metadata();
  assert.equal(mi.width, 1024);
  assert.equal(mi.channels, 4);
  const ii = await sharp(image).metadata();
  assert.equal(ii.width, 1024);
  const a = await sharp(mask).extractChannel(3).raw().toBuffer();
  let clear = 0;
  for (const v of a) if (v === 0) clear++;
  assert.ok(clear > 0 && clear < a.length / 2);
});

test("inpaint: arka planı sürdüren dolgu yalnızca deliğe yazılır", async () => {
  const { sc, job, base } = await inpaintJob();
  const white = Buffer.alloc(job.side * job.side * 3, 255);
  // model kırpımı baştan çizer: deliği beyaz, kalanı aynen
  for (let i = 0; i < job.side * job.side; i++) if (!job.holeC[i]) for (let c = 0; c < 3; c++) white[i * 3 + c] = job.rgb[i * 3 + c];
  const fin = await _finishInpaint(job, await cropPng(job, white), base);
  assert.ok(fin.buf, "reddedildi: " + fin.reason);
  // Düz arka plan dolgusunda delikte kişi yok (bkz. INPAINT_PERSON_MAX).
  assert.ok(fin.person >= 0 && fin.person < 0.05, `person=${fin.person}`);
  const out = await rawOf(fin.buf);
  // Çıktı kayıpsız (2026-10-16, ara adımlar PNG): taban birebir korunur.
  // Deliğe değen 16 px'lik bloklar hariç tutulmaya devam ediyor.
  const before = await rawOf(base);
  const holeAt = (x, y) => {
    const lx = x - job.left;
    const ly = y - job.top;
    return lx >= 0 && ly >= 0 && lx < job.side && ly < job.side && job.holeC[ly * job.side + lx] === 1;
  };
  const nearHole = new Uint8Array(sc.W * sc.H);
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) {
    if (!holeAt(x, y)) continue;
    const bx = x & ~15;
    const by = y & ~15;
    for (let yy = by; yy < Math.min(sc.H, by + 16); yy++) for (let xx = bx; xx < Math.min(sc.W, bx + 16); xx++) nearHole[yy * sc.W + xx] = 1;
  }
  let changedOutside = 0;
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) {
    if (nearHole[y * sc.W + x]) continue;
    for (let c = 0; c < 3; c++) if (Math.abs(out[(y * sc.W + x) * 3 + c] - before[(y * sc.W + x) * 3 + c]) > 3) changedOutside++;
  }
  assert.equal(changedOutside, 0, "delik dışı değişti");
  assert.equal(ghost(out, sc.W, sc.H), 0);
});

test("inpaint: model arka planı değiştirdiyse kullanılmaz", async () => {
  const { job, base } = await inpaintJob();
  const black = Buffer.alloc(job.side * job.side * 3, 0);
  const fin = await _finishInpaint(job, await cropPng(job, black), base);
  assert.equal(fin.buf, null);
  assert.equal(fin.reason, "inpaint-mismatch");
});

test("scaleHeadPatch: büyütmede kafa büyür", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(33, 44);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 1.05);
  const dark = (B) => { let n = 0; for (let y = 0; y < 95; y++) for (let x = 0; x < sc.W; x++) if (B[(y * sc.W + x) * 3] < 128) n++; return n; };
  assert.ok(dark(r.buf) > dark(sc.o.buf) * 1.05);
});

// 2026-10-22: çene şablonunkinden aşağıdaysa kafa ölçeksiz de kaldırılır.
test("scaleHeadPatch: kaldırma (liftPx) kafayı yukarı alır, omuzlar değişmez", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(30, 40, 60);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 1, { liftPx: 10 });
  const top = (B) => { for (let y = 0; y < sc.H; y++) if (B[(y * sc.W + 80) * 3] < 128) return y; return -1; };
  assert.ok(!r.skipped && top(r.buf) <= top(sc.o.buf) - 8, `tepe ${top(sc.o.buf)} -> ${top(r.buf)}`);
  for (let y = 135; y < sc.H; y++) for (let x = 0; x < sc.W; x++) assert.equal(r.buf[(y * sc.W + x) * 3], sc.o.buf[(y * sc.W + x) * 3]);
});

// 23579e24 c0: küçültmede de dokunan nesne (ön cam direği) kafayla çekildi.
test("scaleHeadPatch: küçültmede kafaya el/nesne bitişikse hiç dokunmaz (c6 eğilmesi)", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(25, 34);
  // kulak hizasında kafadan yana uzanan kol/el
  for (let y = 60; y < 80; y++) for (let x = 110; x < 150; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30);
  assert.equal(r.skipped, true);
  assert.equal(r.moved, 0);
});

// 29cf877a c2 (2026-10-22): kıyafet/kol derisi sınıfındaki uzuv korunur,
// kafa küçülür; sınıflanmamış nesne (ön cam direği) yine atlatır.
const limbMaps = (sc, isLimb, isHead) => {
  const n = sc.W * sc.H;
  const L = { cloth: new Float32Array(n), skin: new Float32Array(n), head: new Float32Array(n) };
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) {
    const g = y * sc.W + x;
    if (isLimb(x, y)) L.cloth[g] = 1;
    else if (isHead(x, y)) L.head[g] = 1;
  }
  return L;
};
const armScene = () => {
  const sc = headScene(30, 40);
  for (let y = 60; y < 80; y++) for (let x = 110; x < 150; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  return sc;
};
const inHead = (x, y) => ((x - 80) / 30) ** 2 + ((y - 70) / 40) ** 2 <= 1;

test("scaleHeadPatch: uzuv koruması — kafaya değen kol yerinde kalır, kafa küçülür", () => {
  const sc = armScene();
  const t = sc.mk(25, 34);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const limbs = limbMaps(sc, (x, y) => y >= 60 && y < 80 && x >= 110 && !inHead(x, y), inHead);
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30, { limbs });
  assert.notEqual(r.skipped, true);
  assert.equal(r.limbProtected, true);
  const dark = (B) => { let n = 0; for (let y = 0; y < 95; y++) for (let x = 0; x < 110; x++) if (B[(y * sc.W + x) * 3] < 128) n++; return n; };
  assert.ok(dark(r.buf) < dark(sc.o.buf) * 0.95, "kafa küçülmedi");
  for (let y = 62; y < 78; y++) for (let x = 116; x < 150; x++) assert.ok(r.buf[(y * sc.W + x) * 3] <= 45, `kol değişti (${x},${y})`);
});

// Zoom A/B b2 c8, 23579e24 c0: maskeye taşan arka plan (ağaç, kemer) sabit kalır.
test("scaleHeadPatch: uzuv koruması — kafadan uzak arka plan sınıfı yerinde kalır", () => {
  const sc = armScene();
  const t = sc.mk(25, 34);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const limbs = limbMaps(sc, () => false, inHead);
  limbs.bg = new Float32Array(sc.W * sc.H);
  for (let y = 60; y < 80; y++) for (let x = 110; x < 150; x++) if (!inHead(x, y)) limbs.bg[y * sc.W + x] = 1;
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30, { limbs });
  assert.notEqual(r.skipped, true);
  assert.equal(r.limbProtected, true);
  // Saç teli payı (8 px) + yumuşak geçiş (8 px) ötesi tam korunur.
  for (let y = 62; y < 78; y++) for (let x = 130; x < 150; x++) assert.ok(r.buf[(y * sc.W + x) * 3] <= 45, `nesne değişti (${x},${y})`);
});

// e25dc241 c0 (2026-10-27): çeneye kaldırılmış el boyun sütununun içinde
// kafayla taşınıyordu; kafadan ayrık deri bileşeni korunur, hiza da yapılır.
test("scaleHeadPatch: uzuv koruması — sütundaki kopuk deri (el) yerinde kalır, kafa hizalanır", () => {
  const sc = armScene();
  const t = sc.mk(25, 34);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const hand = (x, y) => y >= 114 && y < 126 && x >= 84 && x < 100;
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) if (hand(x, y)) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const limbs = limbMaps(sc, (x, y) => y >= 60 && y < 80 && x >= 110 && !inHead(x, y), inHead);
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) if (hand(x, y)) limbs.skin[y * sc.W + x] = 1;
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30, { limbs, shiftPx: 6 });
  assert.notEqual(r.skipped, true);
  assert.equal(r.limbProtected, true);
  assert.equal(r.shiftEff, 6);
  for (let y = 116; y < 124; y++) for (let x = 86; x < 98; x++) assert.ok(r.buf[(y * sc.W + x) * 3] <= 45, `el değişti (${x},${y})`);
});

test("scaleHeadPatch: uzuv koruması — sınıflanmamış nesne yine atlatır", () => {
  const sc = armScene();
  const t = sc.mk(25, 34);
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const limbs = limbMaps(sc, () => false, inHead);
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30, { limbs });
  assert.equal(r.skipped, true);
  assert.equal(r.moved, 0);
});

test("scaleHeadPatch: büyütmede kafaya el/nesne bitişikse hiç dokunmaz", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(33, 44);
  for (let y = 60; y < 80; y++) for (let x = 110; x < 150; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 1.05);
  assert.equal(r.skipped, true);
  assert.equal(r.moved, 0);
});

// 3cd612ba c1/c3: ağızdaki sigara ve kalkık yaka el sayılıp küçültmeyi durdurdu.
test("scaleHeadPatch: burun ucunun altındaki nesne (sigara, yaka) dokunma sayılmaz", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(25, 34);
  for (let y = 92; y < 100; y++) for (let x = 110; x < 150; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80, noseY: 88 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30);
  assert.notEqual(r.skipped, true);
  assert.ok(r.moved > 0);
});

// Gözlüklü şablon (3cd612ba): göz noktaları camın altında kayar, ölçü onları kullanmaz.
function fakeFaceMouth(k = 1, cx = 200, cy = 200) {
  const P = fakeFace(k, cx, cy);
  for (let i = 48; i <= 59; i++) P[i] = { x: cx + k * (-20 + ((i - 48) % 7) * (40 / 6)), y: cy + k * (i < 55 ? 48 : 52) };
  return P;
}
test("gözlüklü şablon: gözsüz noktalar şablonun kaymış gözlerinden etkilenmez", () => {
  const t = fakeFaceMouth(1);
  for (let i = 17; i <= 27; i++) t[i] = { x: t[i].x, y: t[i].y + 12 };
  for (let i = 36; i <= 47; i++) t[i] = { x: t[i].x, y: t[i].y + 12 };
  const r = eyeFreeLandmarkRatio(fakeFaceMouth(1.1), t);
  assert.ok(Math.abs(r.ratio - 1.1) < 1e-6, `ratio=${r.ratio}`);
  assert.ok(Math.abs(landmarkSizeRatio(fakeFaceMouth(1.1), t).ratio - 1.1) > 0.05, "eski ölçü kayardı");
});

test("gözlüklü şablon: dört ölçünün medyanı tek sapan ölçüyü yok sayar, eksik ölçü atlanır", () => {
  // 3cd612ba c6: noktalar 1.29 dedi, diğerleri ~1.17
  assert.ok(Math.abs(eyewearFaceRatio({ landmark: 1.29, faceArea: 1.0, boxW: 1.14, boxH: 1.17 }).ratio - 1.155) < 1e-9);
  assert.equal(eyewearFaceRatio({ landmark: 1.1, faceArea: null, boxW: 1.0, boxH: 1.2 }).ratio, 1.1);
  assert.equal(eyewearFaceRatio({}).ratio, null);
});

test("plan: maske gövdeyi göremese de yüz yerindeyse düzeltilir (karanlık sahne)", () => {
  const p = planLandmarkScale(1.12, { bodyIou: 0.28, faceShift: FACE_ALIGNED_SHIFT / 2 });
  assert.equal(p.apply, true);
});

test("algılanan kafa: büyütmede yüz ve hacmin geometrik ortalaması", () => {
  const r = perceivedHeadRatio(0.93, 0.97);
  assert.equal(r.volUsed, true);
  assert.ok(Math.abs(r.ratio - Math.sqrt(0.93 * 0.97)) < 1e-9);
});

test("algılanan kafa: hacim yüzden çok saparsa (karanlık sahne) yalnızca yüz", () => {
  const r = perceivedHeadRatio(1.14, 0.86);
  assert.equal(r.volUsed, false);
  assert.equal(r.ratio, 1.14);
});

// 2026-10-09, 61079257 c5: kullanıcı "kafa çok büyük" (yüz 1.103, hacim 1.01).
// Ortalama 1.055 eşiği (0.03) aşar → küçültülür.
test("plan: küçültmede de yüz ve hacmin ortalaması (61079257 c5 küçülür)", () => {
  const p = planLandmarkScale(1.103, { bodyIou: 0.86, volRatio: 1.01 });
  assert.equal(p.apply, true);
  assert.equal(p.volUsed, true);
  assert.ok(Math.abs(p.rawS - 1 / Math.sqrt(1.103 * 1.01)) < 1e-9, `rawS=${p.rawS}`);
});

// 2026-10-16, 6dd26e3e (kesitte hacim): c9 yüz 1.039 / hacim 0.978 ve c3
// (gözlüklü) 1.075 / 0.946 gereksiz küçültülmüştü; c8 0.992 / 1.055 büyük kaldı.
test("plan: 6dd26e3e — c9 ve c3 dokunulmaz, c8 küçülür", () => {
  assert.equal(planLandmarkScale(1.039, { bodyIou: 0.96, volRatio: 0.978 }).apply, false);
  assert.equal(planLandmarkScale(1.075, { bodyIou: 0.98, volRatio: 0.946 }).apply, false);
  const c8 = planLandmarkScale(1.022, { bodyIou: 0.93, volRatio: 1.055 });
  assert.equal(c8.apply, true);
  assert.ok(c8.s < 1, `s=${c8.s}`);
});

// 9d9507f0 c8: 0.886 "çok küçültmüşsün"; 61079257 c2: 0.9 "çok küçülmüş".
// cbdbef13: 1.12-1.89 ölçülen kareler 0.93'te büyük kaldı → kademeli genişleme.
test("plan: %36 büyük kafa aşırı tabana iner (29cf877a c2)", () => {
  const p = planLandmarkScale(1.36, { bodyIou: 0.95 });
  assert.equal(p.apply, true);
  assert.ok(p.s <= 0.81 && p.s >= MIN_SCALE_EXTREME, `s=${p.s}`);
});

test("plan: 0.93 ötesi küçültme kademeli, 1.14 ölçüde 0.9'un altına inmez", () => {
  const p = planLandmarkScale(1.14, { bodyIou: 0.98, volRatio: 1.07 });
  assert.ok(p.s > 0.9 && p.s < 0.93, `s=${p.s}`);
  const q = planLandmarkScale(1.05, { bodyIou: 0.98 });
  assert.ok(Math.abs(q.s - 1 / 1.05) < 1e-9);
  const big = planLandmarkScale(1.18, { bodyIou: 0.98 });
  assert.ok(big.s < 0.9 && big.s >= MIN_SCALE, `s=${big.s}`);
});

// cbdbef13 c17/c24: yüz oranı 1.83-1.89 tespit hatası — kademe uygulanmaz.
test("plan: inanılmaz büyük ölçü kademeyle en dibe itilmez, SOFT_MIN'de kalır", () => {
  for (const r of [1.83, 1.89, 1.4]) {
    const p = planLandmarkScale(r, { bodyIou: 0.98 });
    assert.ok(Math.abs(p.s - SOFT_MIN_SCALE) < 1e-9, `oran=${r} s=${p.s}`);
  }
  const real = planLandmarkScale(1.22, { bodyIou: 0.98 });
  assert.ok(real.s < 0.9, `gerçek büyüme 1.22 hâlâ kademeyle küçülür: s=${real.s}`);
});

// 2026-10-09, f9f3b5c0 c4: tam kare hacmi 0.863 (yanlış ölçü) — yüzden 0.2'den
// fazla saptığı için kullanılmaz, kafa büyütülmez.
test("algılanan kafa: yüzden çok sapan hacim kullanılmaz (f9f3b5c0 c4)", () => {
  const p = planLandmarkScale(1.056, { bodyIou: 0.274, faceShift: 0.147, volRatio: 0.83 });
  assert.equal(p.apply, true);
  assert.ok(p.s < 1, `s=${p.s}`);
});

test("plan: f9f3b5c0 c1 — yüz 1.22, hacim 0.955 → yine küçültülür", () => {
  const p = planLandmarkScale(1.22, { bodyIou: 0.98, volRatio: 0.955 });
  assert.equal(p.apply, true);
  assert.ok(p.s < 0.97, `s=${p.s}`);
});

test("planLandmarkScale: yükseklik tutuyor ama kafa geniş — genişliğe göre küçülür (017dbe34 c0)", () => {
  const { planLandmarkScale } = require("../headScale");
  const p = planLandmarkScale(0.994, { bodyIou: 0.97, faceShift: 0.1, volRatio: 1.011, widthRatio: 1.076 });
  assert.equal(p.apply, true);
  assert.equal(p.widthUsed, true);
  assert.ok(p.s > 0.92 && p.s < 0.94, `s=${p.s}`);
});

test("planLandmarkScale: genişlik algılanan orandan az farklıysa karar değişmez", () => {
  const { planLandmarkScale } = require("../headScale");
  const a = planLandmarkScale(1.067, { bodyIou: 0.97, faceShift: 0.1, volRatio: 1.05, widthRatio: 1.095 });
  const b = planLandmarkScale(1.067, { bodyIou: 0.97, faceShift: 0.1, volRatio: 1.05 });
  assert.equal(a.widthUsed, false);
  assert.equal(a.s, b.s);
});

test("widthUsable: profil ve önden dönmüş çıktıda genişlik kullanılmaz", () => {
  const { widthUsable } = require("../headScale");
  assert.equal(widthUsable(0.62, 0.55), true);
  assert.equal(widthUsable(0.59, 0.68), false);
  assert.equal(widthUsable(0.85, 0.80), false);
  assert.equal(widthUsable(null, 0.2), false);
});

// 2026-11-13 c4 (profil şablon, yaw 54°): 68 nokta yüz 1.39 diyordu, 3B ağ 1.15; hacim 1.02.
test("plan: profilde (volFloor) küçültme kafa hacmini şablonun %97'sinin altına indirmez", () => {
  const { planLandmarkScale, VOLUME_FLOOR } = require("../headScale");
  const p = planLandmarkScale(1.189, { bodyIou: 0.94, volRatio: 1.058, volFloor: true });
  assert.ok(Math.abs(p.rawS - VOLUME_FLOOR / 1.058) < 1e-9, `rawS=${p.rawS}`);
  const q = planLandmarkScale(1.189, { bodyIou: 0.94, volRatio: 1.058 });
  assert.ok(Math.abs(q.rawS - 1 / Math.sqrt(1.189 * 1.058)) < 1e-9);
  const big = planLandmarkScale(1.39, { bodyIou: 0.94, volRatio: 1.02, volFloor: true });
  assert.equal(big.volUsed, false); // hacim yüzden çok sapıyorsa taban da yok (eski davranış)
});
