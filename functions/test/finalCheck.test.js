const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _testables: T } = require("../finalCheck");

// SON ÇIKTI DOĞRULAMASI (2026-11-04): doğrulanmış kare ile teslim karesi
// arasında yüz kutusu / nokta kayması. Yüz genişliği 100 px.
function face({ dx = 0, dy = 0, scale = 1, ptsDx = 0, eyeDx = 0 } = {}) {
  const box = { x: 200 + dx, y: 150 + dy, width: 100 * scale, height: 120 * scale };
  const pts = [];
  for (let i = 0; i < 68; i++) {
    const eye = i >= 17 && i <= 47;
    pts.push({ x: 200 + (i % 10) * 10 + ptsDx + (eye ? eyeDx : 0), y: 150 + Math.floor(i / 10) * 12 });
  }
  return { box, pts };
}

test("compareFaces: aynı yüz → geçer, ölçüler sıfır/1", () => {
  const r = T.compareFaces(face(), face());
  assert.equal(r.ok, true);
  assert.ok(r.boxShift < 1e-9);
  assert.equal(r.boxScale, 1);
  assert.ok(r.ptsShift < 1e-9);
});

test("compareFaces: küçük kayma (%2) ve küçük ölçek (%3) tolerans içinde", () => {
  const r = T.compareFaces(face(), face({ dx: 2, scale: 1.03, ptsDx: 2 }));
  assert.equal(r.ok, true);
});

test("compareFaces: kutu merkezi %8 kaydı → box-shift", () => {
  const r = T.compareFaces(face(), face({ dx: 8 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "box-shift");
});

test("compareFaces: kutu %10 büyüdü → box-scale", () => {
  // Kutu merkezi de kayar; ölçek sorusu için merkezi sabit tut.
  const b = face(), a = face({ scale: 1.1 });
  a.box.x = b.box.x - 5; a.box.y = b.box.y - 6;
  const r = T.compareFaces(b, a);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "box-scale");
});

test("compareFaces: noktalar kaydı ama kutu yerinde → landmark-shift", () => {
  const r = T.compareFaces(face(), face({ ptsDx: 6 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "landmark-shift");
  assert.ok(r.ptsShift > T.PTS_SHIFT_MAX);
});

test("compareFaces: gözlük uygulandıysa göz/kaş noktalarındaki kayma sayılmaz", () => {
  const noEyewear = T.compareFaces(face(), face({ eyeDx: 12 }));
  const withEyewear = T.compareFaces(face(), face({ eyeDx: 12 }), { eyewear: true });
  assert.equal(noEyewear.ok, false, "gözlüksüz: göz noktaları 12 px kaydı → ret");
  assert.equal(withEyewear.ok, true, "gözlüklü: göz bölgesi dışlanır → geçer");
  assert.ok(withEyewear.ptsShift < 1e-9);
});

test("compareFaces: sonrası yüz yok → face-lost; öncesi yok → karar yok", () => {
  assert.equal(T.compareFaces(face(), null).reason, "face-lost");
  assert.equal(T.compareFaces(face(), null).ok, false);
  assert.equal(T.compareFaces(null, face()).ok, true);
});

test("sharpnessVerdict: doku/ışık oynaması tolerans içinde, aşırı bulanıklaşma dışında", () => {
  assert.equal(T.sharpnessVerdict(100, 180).ok, true); // gren ekledi
  assert.equal(T.sharpnessVerdict(100, 70).ok, true); // hafif yumuşadı
  assert.equal(T.sharpnessVerdict(100, 20).ok, false); // aşırı bulanık
  assert.equal(T.sharpnessVerdict(100, 400).ok, false); // aşırı keskin/gürültülü
  assert.equal(T.sharpnessVerdict(0, 50).ok, true); // ölçüm yok → karar yok
  assert.equal(T.sharpnessVerdict(0, 50).ratio, null);
});
