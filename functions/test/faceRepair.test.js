const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  buildFaceMask, MASK_PAD,
  EYE_BAND_TOP, EYE_BAND_BOTTOM, MOUTH_BAND_TOP, MOUTH_BAND_BOTTOM,
} = require("../faceRepair");

// Verilen satır aralığında kaç ŞEFFAF (onarılacak) piksel var.
async function transparentInRows(png, yFrom, yTo) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, C = info.channels;
  let n = 0;
  for (let y = Math.max(0, yFrom); y < Math.min(info.height, yTo); y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * C + (C - 1)] < 250) n++;
    }
  }
  return n;
}

// Maskenin ŞEFFAF (onarılacak) bölgesinin sınır kutusunu döner.
async function maskBox(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  let minX = W, maxX = -1, minY = H, maxY = -1, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * C + (C - 1)] < 128) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count, W, H };
}

// GERÇEK BİR HATAYI KİLİTLER (2026-09-17): sharp, tek kanallı ham girdiyi
// blur'dan sonra 3 KANAL olarak döndürebiliyor. Kod tek kanal varsaydığı
// için maske tamamen kaymıştı — yüz y=296..517'deyken maske y=775..1399'a
// düşmüştü, yani onarım yüzü değil GÖĞSÜ yeniden çizecekti. Bu test o
// kaymayı yakalar.
test("maske yüz kutusunu yatayda KAPSAR (kanal kayması regresyonu)", async () => {
  const W = 1122, H = 1402;
  const box = { x: 563, y: 296, width: 153, height: 221 };
  const png = await buildFaceMask(W, H, box);
  assert.ok(png, "maske üretilmeli");
  const m = await maskBox(png);
  assert.ok(m.count > 0, "şeffaf bölge boş olmamalı");
  assert.ok(m.minX <= box.x, `sol kenar yüzü kapsamalı (maske ${m.minX} > yüz ${box.x})`);
  assert.ok(m.maxX >= box.x + box.width, "sağ kenar yüzü kapsamalı");
  // Dikeyde de yüzün üstünü/altını görmeli — kanal kayması olsaydı maske
  // yüzün ÇOK altına düşerdi (gerçek hata: yüz 296..517 iken maske 775..1399).
  assert.ok(m.minY <= box.y, `üst kenar yüzü kapsamalı (maske ${m.minY} > yüz ${box.y})`);
  assert.ok(m.maxY >= box.y + box.height, "alt kenar yüzü kapsamalı");
});

// GERÇEK BİR MALİYETİ KİLİTLER (2026-09-18): ilk sürüm TÜM yüzü maskeliyordu
// ve 6 canlı onarımın 5'i kimlik kontrolünden düştü (mesafeler 0.617 / 0.642 /
// 0.677 / 0.698 / 0.755; eşik 0.55). Gözler, kaşlar ve ağız yeniden çizilince
// kişi değişiyor. Bu iki test o bantların maske DIŞINDA kaldığını garanti eder.
test("göz/kaş bandı maskeye HİÇ girmez (kimlik korunur)", async () => {
  const W = 1024, H = 1536;
  const box = { x: 380, y: 300, width: 260, height: 330 };
  const png = await buildFaceMask(W, H, box);
  const from = Math.round(box.y + box.height * EYE_BAND_TOP);
  const to = Math.round(box.y + box.height * EYE_BAND_BOTTOM);
  const n = await transparentInRows(png, from, to);
  assert.equal(n, 0, `göz bandında ${n} şeffaf piksel var — kimlik hattı yeniden çizilir`);
});

test("ağız bandı maskeye HİÇ girmez (kimlik korunur)", async () => {
  const W = 1024, H = 1536;
  const box = { x: 380, y: 300, width: 260, height: 330 };
  const png = await buildFaceMask(W, H, box);
  const from = Math.round(box.y + box.height * MOUTH_BAND_TOP);
  const to = Math.round(box.y + box.height * MOUTH_BAND_BOTTOM);
  const n = await transparentInRows(png, from, to);
  assert.equal(n, 0, `ağız bandında ${n} şeffaf piksel var — kimlik hattı yeniden çizilir`);
});

test("alın, yanak ve çene onarılabilir kalır (maske işe yaramalı)", async () => {
  const W = 1024, H = 1536;
  const box = { x: 380, y: 300, width: 260, height: 330 };
  const png = await buildFaceMask(W, H, box);
  const alin = await transparentInRows(png, box.y, Math.round(box.y + box.height * EYE_BAND_TOP));
  const yanak = await transparentInRows(
    png,
    Math.round(box.y + box.height * EYE_BAND_BOTTOM),
    Math.round(box.y + box.height * MOUTH_BAND_TOP)
  );
  const cene = await transparentInRows(
    png,
    Math.round(box.y + box.height * MOUTH_BAND_BOTTOM),
    box.y + box.height
  );
  assert.ok(alin > 0, "alın onarılabilmeli — yama en çok orada çıkıyor");
  assert.ok(yanak > 0, "yanak/burun sırtı onarılabilmeli");
  assert.ok(cene > 0, "çene onarılabilmeli");
});

test("maske yüzün ETRAFINDA kalır, tüm kareyi kaplamaz", async () => {
  const W = 1122, H = 1402;
  const box = { x: 563, y: 296, width: 153, height: 221 };
  const m = await maskBox(await buildFaceMask(W, H, box));
  // Yüz karenin küçük bir kısmı; maske de öyle olmalı. %25'i aşarsa
  // onarım arka planı/kıyafeti de yeniden çizer — kabul edilemez.
  const ratio = m.count / (W * H);
  assert.ok(ratio < 0.25, `maske çok geniş: %${(ratio * 100).toFixed(1)}`);
  assert.ok(ratio > 0.005, `maske çok dar: %${(ratio * 100).toFixed(1)}`);
});

test("maske dolgusu MASK_PAD kadar dışarı taşar", async () => {
  const W = 800, H = 1000;
  const box = { x: 300, y: 200, width: 200, height: 260 };
  const m = await maskBox(await buildFaceMask(W, H, box));
  // Yama şakak/saç çizgisinde de çıkabildiği için maske kutudan taşmalı.
  assert.ok(m.minX < box.x, "sol tarafta dolgu olmalı");
  assert.ok(m.maxX > box.x + box.width, "sağ tarafta dolgu olmalı");
  assert.ok(MASK_PAD > 0);
});

test("kare sınırına taşan yüzde maske kırpılır, patlamaz", async () => {
  const W = 400, H = 400;
  // Yüz sol üst köşeden dışarı taşıyor.
  const box = { x: -30, y: -20, width: 150, height: 180 };
  const png = await buildFaceMask(W, H, box);
  assert.ok(png, "sınıra taşan kutuda da maske üretilmeli");
  const m = await maskBox(png);
  assert.ok(m.minX >= 0 && m.minY >= 0, "maske kare dışına çıkmamalı");
  assert.ok(m.maxX < W && m.maxY < H, "maske kare içinde kalmalı");
});

test("çok küçük yüz kutusunda null döner (onarım denenmez)", async () => {
  assert.equal(await buildFaceMask(400, 400, { x: 10, y: 10, width: 2, height: 2 }), null);
});
