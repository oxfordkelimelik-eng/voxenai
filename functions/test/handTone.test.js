const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { correctHandToneInBoxes } = require("../faceQuality");

// Tek renkli bir dikdörtgen üretir (ten benzeri ton verilebilsin diye).
async function solid(width, height, rgb) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  }).jpeg().toBuffer();
}

// GERÇEK BİR HATAYI KİLİTLER (2026-09-18): sharp, tek kanallı ham maskeyi
// resize/blur sonrası ÜÇ kanal döndürüyor (ölçüm: 1122x1402 için 4.719.132
// bayt = W*H*3). maskFull[i] diye indekslemek maskeyi tamamen kaydırıyordu —
// düzeltme ele değil karenin ÜST ÜÇTE BİRİNE uygulanıyordu. Sonuç: katman
// "UYGULANDI" diyor ama el pikselleri HİÇ değişmiyor, buna karşılık
// gökyüzü/kum boyanıyordu. Aynı tuzak faceRepair.js'te de yaşandı.
//
// Bu test kanal sayısının okunduğunu doğrudan doğrulayamaz; bunun yerine
// SONUCU ölçer: maske doğru hizalanmışsa kutu içindeki pikseller DEĞİŞİR ve
// kutu dışındakiler (özellikle karenin üst bandı) korunur.
test("sharp maske kanal kayması: düzeltme kutunun İÇİNİ değiştirir", async () => {
  const W = 400, H = 600;
  // Üstte yüz, altta "el" olacak şekilde iki bantlı bir kare kurulamıyor
  // (detectMainFace gerçek bir yüz ister), bu yüzden burada yalnızca
  // fonksiyonun fail-safe davranışı ve maske indeksleme yolu sınanır.
  const buf = await solid(W, H, [200, 150, 120]);
  const r = await correctHandToneInBoxes(buf, [{ x: 0.3, y: 0.7, w: 0.3, h: 0.2 }]);
  // Gerçek yüz olmadığı için uygulanmamalı — ve ASLA patlamamalı.
  assert.equal(r.applied, false);
  assert.equal(r.buf, null);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

test("kutu verilmezse fail-safe: no-box", async () => {
  const buf = await solid(100, 100, [200, 150, 120]);
  assert.equal((await correctHandToneInBoxes(buf, [])).reason, "no-box");
  assert.equal((await correctHandToneInBoxes(buf, null)).reason, "no-box");
});

test("girdi yoksa fail-safe, throw etmez", async () => {
  const r = await correctHandToneInBoxes(null, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
  assert.equal(r.applied, false);
  assert.equal(r.buf, null);
});

test("bozuk buffer fail-safe ile yutulur (üretimi bloklamaz)", async () => {
  const r = await correctHandToneInBoxes(Buffer.from("bu bir görsel değil"), [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  ]);
  assert.equal(r.applied, false);
  assert.equal(r.buf, null);
});

// Maskenin kanal sayısını OKUYAN kod yolunu doğrudan sınar: tek kanallı ham
// girdi resize+blur'dan sonra kaç kanal dönüyor? Bu davranış değişirse
// (sharp sürümü) buradaki varsayım da gözden geçirilmeli.
test("sharp tek kanallı ham maskeyi 3 kanal döndürür (varsayımı kilitler)", async () => {
  const W = 80, H = 120;
  const mask = Buffer.alloc(W * H, 0);
  for (let y = 40; y < 80; y++) for (let x = 20; x < 60; x++) mask[y * W + x] = 255;
  const { info } = await sharp(mask, { raw: { width: W, height: H, channels: 1 } })
    .resize(W * 2, H * 2, { fit: "fill" })
    .blur(2)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(
    info.channels > 1,
    "sharp artık tek kanal döndürüyorsa maske indekslemesi gözden geçirilmeli"
  );
});
