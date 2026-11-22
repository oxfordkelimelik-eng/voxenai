"use strict";
// FOTO DÜZENLEYİCİ (2026-11-22): sunucu formülleri. AYNI altın değerler Dart'ta
// test/ops_photo_edits_test.dart içinde — önizleme ile kaydedilen kare birebir aynı kalmalı.
const test = require("node:test");
const assert = require("node:assert");
const P = require("../photoEdits");

const PX = [[200, 150, 120], [30, 60, 200], [128, 128, 128], [10, 10, 10], [250, 240, 230]];
const GOLDEN = [
  [{ preset: "sicak" }, [215, 150, 109, 26, 55, 216, 134, 127, 123, 9, 3, 0, 255, 246, 229]],
  [{ preset: "sb_kontrast" }, [165, 165, 165, 50, 50, 50, 128, 128, 128, 2, 2, 2, 252, 252, 252]],
  [{ preset: "sinematik", intensity: 60, adj: { exposure: 20 } }, [191, 146, 118, 27, 60, 206, 136, 138, 138, 2, 4, 4, 224, 226, 226]],
  [{ adj: { contrast: 40, saturation: -30, highlights: -50, shadows: 60, fade: 20, warmth: -40, tint: 30, brightness: -25 } }, [170, 135, 125, 35, 49, 160, 104, 106, 120, 29, 31, 45, 218, 220, 234]],
];

test("düzenleme: altın değerler (Dart önizlemesiyle aynı)", () => {
  for (const [edits, want] of GOLDEN) {
    const d = new Uint8Array(PX.flat());
    P.renderPixels(d, 5, 1, 3, P.combine(P.normalizeEdits(edits)));
    assert.deepStrictEqual(Array.from(d), want, JSON.stringify(edits));
  }
});

test("düzenleme: vinyet kenarı karartır, merkeze dokunmaz", () => {
  const d = new Uint8Array([200, 150, 120, 200, 150, 120, 200, 150, 120]);
  P.renderPixels(d, 3, 1, 3, P.combine(P.normalizeEdits({ adj: { vignette: 100 } })));
  assert.deepStrictEqual(Array.from(d), [80, 60, 48, 200, 150, 120, 80, 60, 48]);
});

test("düzenleme: etkisiz düzenleme null (asıl kareye dönülür), aralık dışı sınırlanır", () => {
  assert.strictEqual(P.normalizeEdits(null), null);
  assert.strictEqual(P.normalizeEdits({ adj: { contrast: 0 } }), null);
  assert.strictEqual(P.normalizeEdits({ preset: "yok-boyle-filtre" }), null);
  const e = P.normalizeEdits({ adj: { contrast: 500, fade: -20 }, glow: true });
  assert.deepStrictEqual(e, { preset: null, intensity: 100, adj: { contrast: 100 }, glow: true, flash: 0 });
  // flaş tek başına da düzenlemedir; aralık 0..100
  assert.deepStrictEqual(P.normalizeEdits({ flash: 250 }), { preset: null, intensity: 100, adj: {}, glow: false, flash: 100 });
  assert.strictEqual(P.normalizeEdits({ flash: 0 }), null);
});

test("düzenleme: sıfır parametre birim dönüşüm", () => {
  const d = new Uint8Array(PX.flat());
  P.renderPixels(d, 5, 1, 3, P.combine({ preset: null, adj: {} }));
  assert.deepStrictEqual(Array.from(d), PX.flat());
});
