"use strict";
// GÖZLÜKLÜ ŞABLONDA DÜZ BAKIŞ (2026-11-25, 947807a7): base gözü camın arkasında; hedef göz açıklığının
// ortası (gazeLock.CENTER_U). Ayrıca bitirmeye gözlük bilgisini taşıyan değişken gölgelenmemeli.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { planCenter, CENTER_U, MAX_SHIFT } = require("../gazeLock")._testables;

const eye = (u) => ({ ok: true, u, w: 30, f: {} });
test("planCenter: kameraya bakan göz (c7) kafa yönüne, iki göz aynı yöne", () => {
  const p = planCenter({ pose: { yaw: -19 }, eyes: [eye(0.517), eye(0.642)] });
  assert.strictEqual(p.reason, null);
  assert.ok(p.du[0] < -0.05 && p.du[1] < -0.05);
  assert.ok(Math.abs(0.517 + p.du[0] - CENTER_U[0]) < 1e-9);
  assert.strictEqual(p.comp, 0);
});
test("planCenter: zaten ortadaysa dokunmaz, sınır MAX_SHIFT", () => {
  assert.strictEqual(planCenter({ pose: { yaw: 30 }, eyes: [eye(0.421), eye(0.594)] }).reason, "ortada");
  const far = planCenter({ pose: { yaw: 0 }, eyes: [eye(0.85), eye(0.95)] });
  assert.ok(far.du.every((d) => Math.abs(d) <= MAX_SHIFT));
});
test("planCenter: gözler zıt yöne itilecekse atlar", () => {
  assert.strictEqual(planCenter({ pose: { yaw: 0 }, eyes: [eye(0.33), eye(0.66)] }).reason, "gözler-çelişiyor");
});
test("falPhotos: şablon gözlük yargısı dış değişkeni gölgelemez", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.ok(!/const \{ templateEyewear \} = require\("\.\/templateVision"\)/.test(src));
  assert.match(src, /const \{ templateEyewear: judgeTemplateEyewear \} = require\("\.\/templateVision"\)/);
});
