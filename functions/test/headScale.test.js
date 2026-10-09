const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measureSilhouette, approxSilFromFaceBox, landmarkSizeRatio, planLandmarkScale, MIN_SCALE, MAX_SCALE, BODY_ALIGNED_IOU, FACE_ALIGNED_SHIFT, perceivedHeadRatio, _scaleHeadPatch, _encodeInpaint, _finishInpaint } = require("../headScale");
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
  assert.equal(planLandmarkScale(2, { bodyIou: 0.95 }).s, MIN_SCALE);
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
  // Çıktı JPEG: karşılaştırma aynı kodlamayla, deliğe değen 16 px'lik
  // bloklar (renk alt örneklemesi) hariç.
  const before = await rawOf(await sharp(base).jpeg({ quality: 95 }).toBuffer());
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

test("scaleHeadPatch: kafaya el/nesne bitişikse hiç dokunmaz (c6 eğilmesi)", () => {
  const sc = headScene(30, 40);
  const t = sc.mk(25, 34);
  // kulak hizasında kafadan yana uzanan kol/el
  for (let y = 60; y < 80; y++) for (let x = 110; x < 150; x++) { sc.o.m[y * sc.W + x] = 1; sc.o.buf.fill(40, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3); }
  const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80, seedX: 80 };
  const r = _scaleHeadPatch(sc.o.buf, t.buf, sc.o.m, t.m, sc.W, sc.H, sil, 70, 25 / 30);
  assert.equal(r.skipped, true);
  assert.equal(r.moved, 0);
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

// 2026-10-09, 61079257 c5: şablonun kabarık saçı hacmi şişirdi, ortalama +
// taban kareyi "tolerans içi" yapmıştı; kullanıcı "kafa çok büyük".
test("plan: küçültmede hacim kullanılmaz (c5 atlanmıştı)", () => {
  const p = planLandmarkScale(1.103, { bodyIou: 0.86, volRatio: 1.01 });
  assert.equal(p.apply, true);
  assert.equal(p.volUsed, false);
  assert.ok(Math.abs(p.rawS - 1 / 1.103) < 1e-9, `rawS=${p.rawS}`);
});

// 9d9507f0 c8: 0.886 "çok küçültmüşsün"; 61079257 c2: 0.9 "çok küçülmüş".
test("plan: küçültme MIN_SCALE'de durur, 0.9 kadar küçültmez", () => {
  const p = planLandmarkScale(1.14, { bodyIou: 0.98, volRatio: 1.07 });
  assert.equal(p.s, MIN_SCALE);
  assert.ok(MIN_SCALE > 0.9);
});

// 2026-10-09, f9f3b5c0 c1/c4: hacim yüzle ters yönü gösterince karar çevrilmez.
test("algılanan kafa: hacim yüzün tersini söylüyorsa yalnızca yüz (c4 büyütmüştü)", () => {
  const r = perceivedHeadRatio(1.056, 0.863);
  assert.equal(r.volUsed, false);
  assert.equal(r.ratio, 1.056);
  const p = planLandmarkScale(1.056, { bodyIou: 0.274, faceShift: 0.147, volRatio: 0.863 });
  assert.equal(p.apply, true);
  assert.ok(p.s < 1, `s=${p.s}`);
});

test("plan: c1 — yüz büyük, hacim biraz küçük → küçültülür (taban engellemez)", () => {
  const p = planLandmarkScale(1.099, { bodyIou: 0.98, volRatio: 0.96 });
  assert.equal(p.apply, true);
  assert.ok(Math.abs(p.rawS - 1 / 1.099) < 1e-9, `rawS=${p.rawS}`);
});
