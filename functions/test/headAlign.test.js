const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planHeadAlign, _scaleHeadPatch } = require("../headScale");

// KAFA HİZASI (2026-10-26, d0d4c001 c2/c3): kafa şablondaki yerine ve eğimine.

// 68 noktalı sentetik yüz (headScale.test.js fakeFace ile aynı yerleşim):
// yüz genişliği 120, burun ortada (yaw 0).
function fakeFace(cx = 200, cy = 200) {
  const P = [];
  for (let i = 0; i < 68; i++) P.push({ x: cx, y: cy });
  for (let i = 0; i <= 16; i++) P[i] = { x: cx - 60 + 7.5 * i, y: cy + (Math.abs(8 - i) < 3 ? 70 : 40) };
  P[8] = { x: cx, y: cy + 80 };
  for (let i = 17; i <= 26; i++) P[i] = { x: cx - 40 + 9 * (i - 17), y: cy - 30 };
  for (let i = 36; i <= 47; i++) P[i] = { x: cx + (i < 42 ? -25 : 25), y: cy - 15 };
  return P;
}
// Yandan bakan yüz: burun sağ göz yönünde (yaw 0.6; kafanın arkası solda = nokta 0).
const sideFace = (cx = 200) => { const P = fakeFace(cx); P[30] = { x: cx + 15, y: 210 }; return P; };
const shiftPts = (P, dx) => P.map((p) => ({ x: p.x + dx, y: p.y }));
const rotPts = (P, deg, px, py) => {
  const a = (deg * Math.PI) / 180;
  return P.map((p) => ({ x: px + (p.x - px) * Math.cos(a) - (p.y - py) * Math.sin(a), y: py + (p.x - px) * Math.sin(a) + (p.y - py) * Math.cos(a) }));
};

test("hiza: önden bakışta yana kaymış kafa şablon yerine taşınır (iki yön)", () => {
  const t = fakeFace();
  const a = planHeadAlign(shiftPts(t, 20), t);
  // yüz genişliği 120; kayma 20/120, ALIGN_KEEP (0.02) bırakılır
  assert.ok(Math.abs(a.shiftPx - -(20 / 120 - 0.02) * 120) < 1e-6, `shift=${a.shiftPx}`);
  const b = planHeadAlign(shiftPts(t, -20), t);
  assert.ok(b.shiftPx > 17, `shift=${b.shiftPx}`);
});

test("hiza: küçük kaymaya dokunulmaz", () => {
  const t = fakeFace();
  const a = planHeadAlign(shiftPts(t, 5), t);
  assert.equal(a.shiftPx, 0);
  assert.equal(a.rollRad, 0);
});

test("hiza: yandan bakışta yalnız ÖNE kaymış kafa geri alınır", () => {
  const t = sideFace();
  const fwd = planHeadAlign(shiftPts(t, 15), t); // baktığı yön sağ: +x öne
  assert.ok(fwd.side && fwd.shiftPx < -10, `shift=${fwd.shiftPx}`);
  const back = planHeadAlign(shiftPts(t, -15), t);
  assert.equal(back.shiftPx, 0);
});

test("hiza: şablondan eğik kafa şablonun eğimine döner, dayanak yerinde kalır", () => {
  const t = fakeFace();
  const o = rotPts(t, 6, 200, 280);
  const a = planHeadAlign(o, t);
  assert.ok(Math.abs((a.rollRad * 180) / Math.PI + 5) < 1e-6, `roll=${(a.rollRad * 180) / Math.PI}`);
  // Planlanan dönüş (çene çizgisi ortası x, çene ucu y çevresinde) + kayma
  // dayanağı (çene çizgisi ortası) yatayda yerinde tutar.
  const px = o.slice(0, 17).reduce((q, p) => q + p.x, 0) / 17, py = o[8].y;
  const an = { x: (o[0].x + o[16].x) / 2, y: (o[0].y + o[16].y) / 2 };
  const moved = px + (an.x - px) * Math.cos(a.rollRad) - (an.y - py) * Math.sin(a.rollRad) + a.shiftPx;
  assert.ok(Math.abs(moved - an.x) < 1, `dayanak ${an.x} → ${moved}`);
});

// 2026-10-28 (546b514b c1, kullanıcı: "kafa base foto gibi çapraz bakmalı"):
// cepheden bakışta eğim iki yönde de şablonunkine gelir; profilde (göz çizgisi
// güvenilmez) eskisi gibi yalnız daha eğik kafa dikleştirilir.
test("hiza: cephede şablondan DAHA DİK kafa şablonun eğimine getirilir", () => {
  const t = rotPts(fakeFace(), 6, 200, 280);
  const a = planHeadAlign(fakeFace(), t);
  assert.ok(Math.abs((a.rollRad * 180) / Math.PI - 5) < 1e-6, `roll=${(a.rollRad * 180) / Math.PI}`);
  // 14° fark: en çok 12° döner
  const big = planHeadAlign(fakeFace(), rotPts(fakeFace(), -14, 200, 280));
  assert.ok(Math.abs((big.rollRad * 180) / Math.PI + 12) < 1e-6, `roll=${(big.rollRad * 180) / Math.PI}`);
});

test("hiza: yandan bakışta şablondan DAHA DİK kafa eğilmez", () => {
  const side = () => { const P = fakeFace(); P[30] = { x: 200 + 22, y: 210 }; return P; };
  const t = rotPts(side(), 6, 200, 280);
  assert.equal(planHeadAlign(side(), t).rollRad, 0);
});

// Kafa + boyun + omuz sahnesi (headScale.test.js headScene ile aynı).
function headScene() {
  const W = 160, H = 200;
  const mk = (rx, ry, cy, tone) => {
    const buf = Buffer.alloc(W * H * 3, 255);
    const m = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const head = ((x - 80) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const body = y >= 130 && Math.abs(x - 80) < 60;
      const neck = y >= 100 && y < 130 && Math.abs(x - 80) < 10;
      if (head || body || neck) { for (let c = 0; c < 3; c++) buf[(y * W + x) * 3 + c] = tone[c]; m[y * W + x] = 1; }
    }
    return { buf, m };
  };
  return { W, H, o: mk(30, 40, 70, [40, 40, 40]), t: mk(30, 40, 70, [220, 40, 40]) };
}
const sil = { cx: 80, top: 30, chin: 110, headW: 60, headH: 80 };
const ghost = (B, W, H) => { let n = 0; for (let i = 0; i < W * H; i++) if (B[i * 3] - B[i * 3 + 1] > 25) n++; return n; };
const darkStats = (B, W, y0, y1) => {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) if (B[(y * W + x) * 3] < 128) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const mx = sx / n, my = sy / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  // uzun eksenin dikeyle açısı (derece)
  return { mx, tilt: (0.5 * Math.atan2(2 * cxy, cyy - cxx) * 180) / Math.PI };
};

test("scaleHeadPatch: hiza kaydırması kafayı taşır, gövde yerinde, şablon kişisi açılmaz", () => {
  const sc = headScene();
  const r = _scaleHeadPatch(sc.o.buf, sc.t.buf, sc.o.m, sc.t.m, sc.W, sc.H, sil, 70, 1, { shiftPx: 12 });
  assert.ok(!r.skipped);
  const b = darkStats(sc.o.buf, sc.W, 30, 100), a = darkStats(r.buf, sc.W, 30, 100);
  assert.ok(Math.abs(a.mx - b.mx - 12) < 2, `merkez ${b.mx} → ${a.mx}`);
  for (let y = 145; y < sc.H; y++) for (let x = 0; x < sc.W; x++) assert.equal(r.buf[(y * sc.W + x) * 3], sc.o.buf[(y * sc.W + x) * 3], "omuzlar değişti");
  assert.equal(ghost(r.buf, sc.W, sc.H), 0, "şablon kişisi göründü");
  assert.equal(r.shiftEff, 12);
});

test("scaleHeadPatch: hiza dönüşü kafayı çevirir; kayma ve dönüş 0 iken eşleme eskisiyle aynı", () => {
  const sc = headScene();
  const phi = (10 * Math.PI) / 180;
  const r = _scaleHeadPatch(sc.o.buf, sc.t.buf, sc.o.m, sc.t.m, sc.W, sc.H, sil, 70, 1, { rollRad: phi });
  // Beklenen: kafa elipsi çene ucu (80, 110) çevresinde phi kadar dönmüş; aynı
  // satır penceresiyle ölçülür (pencere dönen elipsi kestiği için 10° değil).
  const ideal = Buffer.alloc(sc.W * sc.H * 3, 255);
  for (let y = 0; y < sc.H; y++) for (let x = 0; x < sc.W; x++) {
    const ux = x - 80, uy = y - 110;
    const sx = 80 + ux * Math.cos(-phi) - uy * Math.sin(-phi), sy = 110 + ux * Math.sin(-phi) + uy * Math.cos(-phi);
    if (((sx - 80) / 30) ** 2 + ((sy - 70) / 40) ** 2 <= 1) ideal.fill(0, (y * sc.W + x) * 3, (y * sc.W + x) * 3 + 3);
  }
  const want = darkStats(ideal, sc.W, 25, 100).tilt, got = darkStats(r.buf, sc.W, 25, 100).tilt;
  assert.ok(Math.abs(got - want) < 1.5, `eğim ${got}, beklenen ${want}`);
  const s0 = _scaleHeadPatch(sc.o.buf, sc.t.buf, sc.o.m, sc.t.m, sc.W, sc.H, sil, 70, 25 / 30);
  const s1 = _scaleHeadPatch(sc.o.buf, sc.t.buf, sc.o.m, sc.t.m, sc.W, sc.H, sil, 70, 25 / 30, { shiftPx: 0, rollRad: 0 });
  assert.ok(s0.buf.equals(s1.buf));
});
