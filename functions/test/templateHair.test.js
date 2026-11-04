const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { eraseTemplateHair, trimTemplateHair, _testables: T } = require("../templateHair");

// ŞABLON SAÇI ÖN TEMİZLİĞİ (2026-10-27): yüz bulunamayan ya da bozuk tabanda
// üretim orijinal tabanla sürmeli (buf null, sebep yazılı).

test("yüzsüz tabanda silme yapılmaz, orijinale düşülür", async () => {
  const buf = await sharp({ create: { width: 320, height: 400, channels: 3, background: "#6a7a8a" } }).jpeg().toBuffer();
  const r = await eraseTemplateHair(buf);
  assert.equal(r.buf, null);
  assert.equal(r.reason, "no-face");
});

test("çözülemeyen görselde hata yutulur", async () => {
  const r = await eraseTemplateHair(Buffer.from("görsel değil"));
  assert.equal(r.buf, null);
  assert.equal(r.reason, "error");
});

// ŞABLON SAÇI KIRPMA (2026-11-03): yalnız beklenen kafanın dışına taşan saç
// silinir; kafanın içi ve yüz çevresi hiçbir koşulda silinmez.

const rect = (w, h, x0, y0, x1, y1) => {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
};
const count = (m) => m.reduce((s, v) => s + (v ? 1 : 0), 0);

test("projectHead: birebir dönüşümde maske aynen taşınır, ölçek yarıya inince alan dörtte bire düşer", () => {
  const N = 40;
  const src = rect(N, N, 10, 10, 30, 30); // 400 px
  const Es = { x: 20, y: 15 }, Cs = { x: 20, y: 35 };
  const same = T.projectHead(src, N, Es, Cs, Es, Cs, N, N, 0, 0);
  assert.equal(count(same), 400);
  // Hedefte göz-çene mesafesi yarı: kafa yarı boyda görünür.
  const half = T.projectHead(src, N, Es, Cs, { x: 20, y: 15 }, { x: 20, y: 25 }, N, N, 0, 0);
  assert.ok(Math.abs(count(half) - 100) <= 12, `alan ${count(half)}`);
  // Pencere kaydırması (ox,oy) ile aynı tam kare noktası okunur.
  const shifted = T.projectHead(src, N, Es, Cs, Es, Cs, 20, 20, 10, 10);
  assert.equal(count(shifted), 400);
  // Bozuk nokta (göz=çene) → boş maske, hata yok.
  assert.equal(count(T.projectHead(src, N, Es, Es, Es, Cs, N, N, 0, 0)), 0);
});

test("dropSmallParts: küçük kopuk parçalar atılır, büyük parça kalır", () => {
  const w = 20, h = 20;
  const m = rect(w, h, 2, 2, 10, 10); // 64 px
  m[15 * w + 15] = 1; m[15 * w + 16] = 1; // 2 px parça
  T.dropSmallParts(m, w, h, 5);
  assert.equal(count(m), 64);
  assert.equal(m[15 * w + 15], 0);
});

test("trimMask: kafanın dışına taşan saç kırpılır, kafa içi ve yüz çevresi korunur", () => {
  const w = 100, h = 100, faceW = 50; // rM=4, rP=2
  const hair = rect(w, h, 20, 10, 90, 40);   // saç: x 20..90
  const head = rect(w, h, 20, 10, 60, 70);   // beklenen kafa: x 20..60
  const oval = rect(w, h, 30, 40, 50, 70);   // yüz ovali alt kısımda
  const r = T.trimMask({ hair, head, oval, w, h, faceW });
  assert.equal(r.hairPx, 70 * 30);
  // Kırpılan = saçın x ≥ 64 (60 + pay 4) kısmı: 26 sütun × 30 satır.
  assert.equal(r.trimPx, 26 * 30);
  for (let y = 10; y < 40; y++) for (let x = 20; x < 64; x++) assert.equal(r.trim[y * w + x], 0, `kafa içi silindi (${x},${y})`);
  assert.equal(r.trim[25 * w + 70], 1);
  // Kafa yoksa yüz ovali (+2 px koruma: y 38..39, x 28..51 → 48 px) dışındaki
  // tüm saç dış sayılır (gate'i trimTemplateHair verir).
  const r0 = T.trimMask({ hair, head: new Uint8Array(w * h), oval, w, h, faceW });
  assert.equal(r0.trimPx, 70 * 30 - 48);
  // Kullanıcının kafası şablon saçını kapsıyorsa hiçbir şey kırpılmaz.
  const rBig = T.trimMask({ hair, head: rect(w, h, 10, 5, 95, 80), oval, w, h, faceW });
  assert.equal(rBig.trimPx, 0);
});

test("trimTemplateHair: selfie yoksa veya yüz yoksa orijinale düşülür", async () => {
  const buf = await sharp({ create: { width: 320, height: 400, channels: 3, background: "#6a7a8a" } }).jpeg().toBuffer();
  const r1 = await trimTemplateHair(buf, null);
  assert.equal(r1.buf, null);
  assert.equal(r1.reason, "no-selfie");
  const r2 = await trimTemplateHair(buf, buf);
  assert.equal(r2.buf, null);
  assert.ok(["no-face", "no-selfie-head"].includes(r2.reason), r2.reason);
  const r3 = await trimTemplateHair(Buffer.from("görsel değil"), buf);
  assert.equal(r3.buf, null);
  assert.equal(r3.reason, "error");
});
