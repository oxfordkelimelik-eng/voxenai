const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFaceArtifactReply,
  FACE_CROP_PROMPT,
} = require("../faceArtifactCrop");

test("temiz yüz geçer", () => {
  const r = parseFaceArtifactReply(
    "ARTIFACT: NONE\nWHERE: NONE\nGOOD: Skin renders evenly with natural texture."
  );
  assert.equal(r.ok, true);
  assert.equal(r.bad, false);
  assert.match(r.detail, /evenly/);
});

test("kaş üstü blok elenir (78e53593_3 vakası)", () => {
  const r = parseFaceArtifactReply(
    "ARTIFACT: PATCH\nWHERE: eyebrows\n" +
    "BAD_ARTIFACT: Grey rectangular block above the right eyebrow."
  );
  assert.equal(r.ok, true);
  assert.equal(r.bad, true);
  assert.match(r.where, /eyebrow/i);
  assert.match(r.detail, /block/i);
});

test("şakağa inen çizgi elenir (78e53593_8 vakası)", () => {
  const r = parseFaceArtifactReply(
    "ARTIFACT: PATCH\nWHERE: cheeks and temples\n" +
    "BAD_ARTIFACT: Thin white vertical streak down the temple."
  );
  assert.equal(r.bad, true);
  assert.match(r.where, /temple/i);
});

// Sınıf satırı bağlayıcı, serbest metin değil — dosyadaki diğer Vision
// kapılarıyla aynı usul (bkz. parseLimbCropReply'deki aynı test).
test("sınıf satırı ile verdict çelişirse SINIF satırı kazanır", () => {
  const r = parseFaceArtifactReply(
    "ARTIFACT: PATCH\nWHERE: nose\nGOOD: looks fine overall"
  );
  assert.equal(r.bad, true);
});

test("ARTIFACT: NONE iken verdict BAD yazsa bile satır kazanır", () => {
  const r = parseFaceArtifactReply(
    "ARTIFACT: NONE\nWHERE: NONE\nGOOD: clean"
  );
  assert.equal(r.bad, false);
});

test("sınıf satırı okunamazsa verdict'e düşer", () => {
  assert.equal(parseFaceArtifactReply("BAD_ARTIFACT: grey patch on chin").bad, true);
  assert.equal(parseFaceArtifactReply("GOOD: nothing wrong").bad, false);
});

test("ayrıştırılamayan cevapta fail-safe: kare ELENMEZ", () => {
  const r = parseFaceArtifactReply("I'm sorry, I can't help with that.");
  assert.equal(r.ok, false);
});

test("boş cevapta fail-safe", () => {
  assert.equal(parseFaceArtifactReply("").ok, false);
  assert.equal(parseFaceArtifactReply(null).ok, false);
});

test("WHERE satırı yoksa da ayrıştırma çalışır", () => {
  const r = parseFaceArtifactReply("ARTIFACT: PATCH\nBAD_ARTIFACT: smear on nose");
  assert.equal(r.bad, true);
  assert.equal(r.where, "");
});

// --- Prompt içeriği regresyon koruması ---------------------------------
// Kullanıcı "lekeler sadece kaş bölgesinde değil, burunda çenede de var"
// dedi; altı bölgenin tamamı prompt'ta adlandırılmış olmalı.

test("prompt altı yüz bölgesini de adlandırır", () => {
  for (const area of ["forehead", "eyebrow", "eye", "nose", "cheek", "chin"]) {
    assert.ok(
      FACE_CROP_PROMPT.toLowerCase().includes(area),
      `prompt "${area}" bölgesini adlandırmalı`
    );
  }
});

test("prompt doğal ten özelliklerini MUAF tutar (yanlış pozitif koruması)", () => {
  for (const ok of ["pore", "stubble", "mole", "freckle", "scar", "shadow"]) {
    assert.ok(
      FACE_CROP_PROMPT.toLowerCase().includes(ok),
      `prompt "${ok}" için muafiyet içermeli`
    );
  }
});

test("prompt gözlük çerçevesini MUAF tutar (0c609c0e_7 yanlış pozitifi)", () => {
  assert.match(FACE_CROP_PROMPT, /eyeglass/i);
});
