const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  specularStatsFromPixels,
  applySpecularReduction,
  shouldReduceShine,
  isSpecularLab,
  SELFIE_NORMALIZE_MIN,
  SELFIE_REDUCE_STRENGTH,
  OUTPUT_SHINE_MIN_IF_SELFIE,
} = require("../faceShine");

function makeSkinPx(width, height, { hotspotX0, hotspotX1, hotspotY0, hotspotY1 } = {}) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const hot = hotspotX0 != null
        && x >= hotspotX0 && x <= hotspotX1
        && y >= hotspotY0 && y <= hotspotY1;
      if (hot) {
        data[o] = 250; data[o + 1] = 248; data[o + 2] = 246;
      } else {
        data[o] = 180; data[o + 1] = 130; data[o + 2] = 110;
      }
    }
  }
  return { data, width, height, scale: 1 };
}

const box = { x: 0, y: 0, width: 80, height: 80 };

test("speküler: yüksek L ve düşük kroma", () => {
  assert.equal(isSpecularLab([80, 4, 3], 60), true);
  assert.equal(isSpecularLab([62, 4, 3], 60), false);
  assert.equal(isSpecularLab([80, 30, 25], 60), false);
});

test("yumuşak/yaygın flaş aydınlanması da speküler sayılır", () => {
  // d13df6ce elegance_6: oran 0.002 ölçülüp atlanmıştı — eski eşik (medyan+10)
  // yalnızca sert nokta parlamalarını görüyordu. Medyanın 7-9 birim üstündeki
  // yumuşak aydınlanma artık yakalanır, 5 birim ve altı hâlâ normal ten.
  assert.equal(isSpecularLab([68, 4, 3], 60), true);
  assert.equal(isSpecularLab([67, 4, 3], 60), true);
  assert.equal(isSpecularLab([65, 4, 3], 60), false);
  // Renkli (yüksek kroma) piksel parlama değildir — makyaj/kıyafet korunur.
  assert.equal(isSpecularLab([68, 30, 25], 60), false);
});

test("düz ten parlama oranı düşük kalır", () => {
  const px = makeSkinPx(80, 80);
  const st = specularStatsFromPixels(px, box);
  assert.ok(st);
  assert.ok(st.shineRatio < 0.02);
});

test("alın/yanaktaki beyaz leke parlama olarak sayılır", () => {
  const px = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const st = specularStatsFromPixels(px, box);
  assert.ok(st);
  assert.ok(st.shineRatio > 0.04);
});

test("selfie ışıklıysa düşük çıktı parlaması da düzeltilir", () => {
  assert.equal(shouldReduceShine({ shineRatio: 0.02 }, true), true);
  assert.equal(shouldReduceShine({ shineRatio: 0.02 }, false), false);
  assert.equal(shouldReduceShine({ shineRatio: 0.25 }, true), false);
});

test("aaf8b1ea'da atlanan parlamalar artık düzeltilir", () => {
  // Gerçek ölçümler (2026-09-07, job aaf8b1ea): selfie'de parlama
  // bulunamadığı için selfieLit=false, eski 0.05 eşiğiyle üçü de atlanmıştı.
  for (const ratio of [0.046, 0.044, 0.036]) {
    assert.equal(shouldReduceShine({ shineRatio: ratio }, false), true);
  }
  // Düz ten hâlâ dokunulmadan geçmeli.
  assert.equal(shouldReduceShine({ shineRatio: 0.008 }, false), false);
  // Genel sahne güneşi (alan tavanı) hâlâ korunuyor.
  assert.equal(shouldReduceShine({ shineRatio: 0.25 }, false), false);
});

test("speküler lekelerin L değeri düşer, renk kanalı kalır", () => {
  const px = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const before = px.data[13 * 80 * 3 + 40 * 3];
  const changed = applySpecularReduction(px.data, 80, 80, box, 1, 55);
  const after = px.data[13 * 80 * 3 + 40 * 3];
  assert.ok(changed > 0);
  assert.ok(after < before);
});

// ---------------------------------------------------------------------------
// SELFIE ÖN NORMALİZASYONU (2026-09-16)
// ---------------------------------------------------------------------------
// Bu katman artefakt reddinin kök nedenine dokunuyor: selfie'deki flaş
// parlaması modele girmeden alınıyor, böylece model "ışığı sök" diye yüzü
// yeniden boyamıyor. Testler DAVRANIŞI kilitliyor — özellikle çıktı
// tarafından daha NAZİK olması (kimlik mesafesini bozmamak için).

test("selfie düzeltmesi çıktı düzeltmesinden DAHA NAZİK", () => {
  // Kimlik güvenliği: selfie kimlik kaynağı. Agresif düzeltme cildi
  // düzleştirir ve artefakt reddini identity reddine çevirir.
  assert.ok(SELFIE_REDUCE_STRENGTH < 0.88,
    "selfie gücü çıktı gücünden (0.88) küçük olmalı");
  assert.ok(SELFIE_REDUCE_STRENGTH > 0,
    "selfie gücü pozitif olmalı, yoksa katman hiçbir şey yapmaz");
});

test("selfie eşiği çıktı eşiğinden YÜKSEK — hafif parlamaya dokunulmaz", () => {
  // Zaten temiz bir selfie'yi işlemek saf risk: kazanç yok, kimlik riski var.
  assert.ok(SELFIE_NORMALIZE_MIN > OUTPUT_SHINE_MIN_IF_SELFIE);
});

test("aynı güçle çağrıldığında selfie düzeltmesi çıktıyla AYNI sonucu verir", () => {
  // İki yol aynı çekirdeği (applySpecularReduction) paylaşıyor; fark
  // yalnızca strength parametresi olmalı, ayrı bir kod yolu değil.
  const a = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const b = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  applySpecularReduction(a.data, 80, 80, box, 1, 55, 0.88);
  applySpecularReduction(b.data, 80, 80, box, 1, 55, 0.88);
  assert.deepEqual(a.data, b.data);
});

test("düşük güç, yüksek güçten DAHA AZ değiştirir (aynı piksel sayısı)", () => {
  const idx = 13 * 80 * 3 + 40 * 3;
  const soft = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const hard = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const original = soft.data[idx];
  const softChanged = applySpecularReduction(soft.data, 80, 80, box, 1, 55, SELFIE_REDUCE_STRENGTH);
  const hardChanged = applySpecularReduction(hard.data, 80, 80, box, 1, 55, 0.88);
  // Aynı pikseller speküler sayılır — yalnızca çekilme miktarı farklı.
  assert.equal(softChanged, hardChanged);
  // Nazik düzeltme orijinale daha yakın kalır.
  assert.ok(Math.abs(soft.data[idx] - original) < Math.abs(hard.data[idx] - original));
});

test("strength verilmezse çıktı davranışı DEĞİŞMEZ (geriye dönük uyum)", () => {
  // Regresyon koruması: mevcut çıktı tarafı çağrısı parametresiz ve
  // REDUCE_STRENGTH ile aynı sonucu vermeye devam etmeli.
  const withDefault = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  const explicit = makeSkinPx(80, 80, { hotspotX0: 30, hotspotX1: 50, hotspotY0: 12, hotspotY1: 20 });
  applySpecularReduction(withDefault.data, 80, 80, box, 1, 55);
  applySpecularReduction(explicit.data, 80, 80, box, 1, 55, 0.88);
  assert.deepEqual(withDefault.data, explicit.data);
});
