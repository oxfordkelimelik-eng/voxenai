const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");

// falPhotos.js bir Cloud Functions modülü (firebase-admin/secrets yükler), bu
// yüzden require edilemiyor. Sabitler kaynaktan okunuyor — testin amacı
// DEĞERLERİN senkron kalmasını kilitlemek, davranışı çalıştırmak değil.
function readArrayConst(name) {
  const m = SRC.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s.replace(/^["']|["']$/g, "")));
}

function countScenes() {
  const m = SRC.match(/const STYLE_SCENES = \{[\s\S]*?\n\};/);
  assert.ok(m, "STYLE_SCENES bulunamadı");
  // Sahneler çift tırnaklı tek satırlık metinler; tırnak çiftini say.
  return (m[0].match(/"/g) || []).length / 2;
}

test("paket boyları 5 / 10 / 25", () => {
  assert.deepEqual(readArrayConst("PHOTO_PACK_SIZES"), [5, 10, 25]);
});

// GERÇEK BİR KUSURU ÖNLER (2026-09-18): pickScene sahneyi
// `variantIdx % havuzBoyu` ile seçiyor. Stil başına havuz 20 sahneydi; 25
// fotoluk pakette 21-25. fotoğraflar İLK 5 SAHNEYİ TEKRAR EDERDİ, yani
// kullanıcı aynı mekânda iki kare görürdü. Beş stilin sahneleri tek havuzda
// birleştirildi (ALL_SCENES). Bu test havuzun en büyük pakete yetmeye devam
// ettiğini kilitler — sahne silinirse burada patlar.
test("sahne havuzu en büyük paketi TEKRARSIZ karşılar", () => {
  const sizes = readArrayConst("PHOTO_PACK_SIZES");
  const biggest = Math.max(...sizes);
  const scenes = countScenes();
  assert.ok(
    scenes >= biggest,
    `sahne havuzu ${scenes}, en büyük paket ${biggest} — sahne tekrarı olur`
  );
});

test("ALL_SCENES tüm stilleri düzleştirerek tek havuz yapar", () => {
  assert.match(SRC, /const ALL_SCENES = Object\.values\(STYLE_SCENES\)\.flat\(\);/);
});

test("tek kova anahtarı tanımlı ve eski istemci çevrimi duruyor", () => {
  assert.match(SRC, /const PHOTO_BUCKET_ID = "photos";/);
  assert.match(SRC, /const LEGACY_PHOTOS_PER_STYLE = 10;/);
});

// Bakiye birimi "stil"den "foto"ya geçti; eski yardımcı adının geri
// sızmadığını kilitler (styleUnitsFor stil sayardı, photoUnitsFor foto sayar).
test("bakiye birimi foto — styleUnitsFor geri gelmemiş", () => {
  assert.match(SRC, /function photoUnitsFor\(photoCount\)/);
  assert.doesNotMatch(SRC, /function styleUnitsFor/);
});

// Eksik teslimde İADE FOTO BAŞINA olmalı. Eski mantık "başarısız kova sayısı"
// kadar iade ediyordu; foto birimine geçince bu 25 fotoluk pakette 22 teslim
// edildiğinde yalnızca 1 foto iade eder, kullanıcı 2 fotoyu kaybederdi.
test("iade eksik FOTO sayısına göre hesaplanır", () => {
  assert.match(SRC, /const missingPhotos = /);
  assert.match(SRC, /Math\.min\(missingPhotos, j\.packUnitsCharged \|\| 0\)/);
});

test("ürün haritası çok alanlı kredi veriyor (hediye analiz)", () => {
  const pay = fs.readFileSync(path.join(__dirname, "..", "payments.js"), "utf8");
  assert.match(pay, /dating_pack_photos5: \{ photoBalance: 5 \}/);
  assert.match(pay, /dating_pack_photos10: \{ photoBalance: 10, analysisBalance: 1 \}/);
  assert.match(pay, /dating_pack_photos25: \{ photoBalance: 25, analysisBalance: 3 \}/);
  // Eski ürünler SİLİNMEMELİ: geri yükleme ve yolda olan ödeme onları
  // hâlâ gönderebilir; silinirse kullanıcı "Bilinmeyen ürün" hatası alır.
  assert.match(pay, /dating_pack_photo10: \{ photoBalance: 10 \}/);
  assert.match(pay, /dating_pack_photo50: \{ photoBalance: 50 \}/);
});
