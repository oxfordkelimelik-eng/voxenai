const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { templateMetaIndex, templateMetaFor } = require("../falPhotos")._testables;

// 2026-11-15: şablon bilgi tablosu — elegance/tall 45 şablon, tam değerlerle.
test("şablon tablosu: elegance/tall kayıtları yüklenir, her kayıtta poz ve kırpım var", () => {
  const idx = templateMetaIndex();
  assert.ok(idx.size >= 45, String(idx.size));
  for (const m of idx.values()) {
    assert.ok(m.name.startsWith("dating_templates/"));
    assert.equal(typeof m.raw.cropped, "boolean");
    assert.ok("pose3d" in m.raw && "promptPose" in m.raw && "pose2d" in m.raw);
    if (m.raw.hat) assert.equal(m.raw.hat.hat, false, "tabloda yalnız 'şapka yok' kararı tutulur");
  }
});

test("şablon tablosu: eşleşme md5 + kırpım + yüz oranıyla; tutmazsa ölçüme düşülür", () => {
  const idx = templateMetaIndex();
  const buf = Buffer.from("deneme-şablon-baytları");
  assert.equal(templateMetaFor(buf, false, 0.1), null, "tabloda olmayan şablon");
  assert.equal(templateMetaFor(null, false, 0.1), null);
  const md5 = crypto.createHash("md5").update(buf).digest("base64");
  idx.set(md5, { name: "test/x.jpg", raw: { cropped: true, faceRatio: 0.125, pose2d: null, pose3d: null, promptPose: null, hat: null } });
  try {
    assert.equal(templateMetaFor(buf, true, 0.125).name, "test/x.jpg");
    assert.equal(templateMetaFor(buf, false, 0.125).miss, "kırpım-farklı");
    assert.equal(templateMetaFor(buf, true, 0.13).miss, "yüzOranı-farklı");
    assert.equal(templateMetaFor(buf, true, undefined).miss, "yüzOranı-farklı");
  } finally { idx.delete(md5); }
});
