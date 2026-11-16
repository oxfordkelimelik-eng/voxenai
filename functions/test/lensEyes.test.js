// Camdan göz yargısı (2026-11-06): renkli/açık camda base kişinin gözü
// kullanıcıya taşınmasın. Taşıma yalnız iki camda da açık NO'da; hata,
// zaman aşımı, okunamayan cevap ve MAYBE -> taşıma yok.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { parseLensEyesReply, lensJudgeAllowsTransfer, lensBandRect, judgeLensEyes, LENS_EYES_PROMPT } = require("../headGhost");

test("cam cevabı: iki cam da okunmalı, YES/MAYBE göz görünüyor sayılır", () => {
  assert.deepEqual(parseLensEyesReply("LEFT_LENS: NO\nRIGHT_LENS: NO"), { ok: true, eyesThrough: false, lenses: ["NO", "NO"] });
  assert.deepEqual(parseLensEyesReply("LEFT_LENS: YES\nRIGHT_LENS: NO"), { ok: true, eyesThrough: true, lenses: ["YES", "NO"] });
  assert.deepEqual(parseLensEyesReply("LEFT_LENS: no\nRIGHT_LENS: maybe"), { ok: true, eyesThrough: true, lenses: ["NO", "MAYBE"] });
  assert.equal(parseLensEyesReply("**LEFT_LENS:** NO\n**RIGHT_LENS:** NO").eyesThrough, false);
  // Tek satır, boş, saçma -> okunamadı (çağıran taşımaz).
  for (const raw of ["LEFT_LENS: NO", "", null, "I cannot help with that.", "LEFT_LENS: dark\nRIGHT_LENS: dark"]) {
    const r = parseLensEyesReply(raw);
    assert.equal(r.ok, false, String(raw));
    assert.equal(r.eyesThrough, null);
  }
});

test("taşıma izni yalnız okunmuş çift NO'da", () => {
  assert.equal(lensJudgeAllowsTransfer({ ok: true, eyesThrough: false }), true);
  assert.equal(lensJudgeAllowsTransfer({ ok: true, eyesThrough: true }), false);
  assert.equal(lensJudgeAllowsTransfer({ ok: false, reason: "http-500", eyesThrough: null }), false);
  assert.equal(lensJudgeAllowsTransfer({ ok: false, reason: "error", eyesThrough: null }), false);
  assert.equal(lensJudgeAllowsTransfer(parseLensEyesReply("LEFT_LENS: MAYBE\nRIGHT_LENS: NO")), false);
  assert.equal(lensJudgeAllowsTransfer(null), false);
  assert.equal(lensJudgeAllowsTransfer(undefined), false);
});

test("prompt her camı ayrı sorar, yansımayı göz saymaz", () => {
  assert.match(LENS_EYES_PROMPT, /LEFT_LENS: <YES \| MAYBE \| NO>/);
  assert.match(LENS_EYES_PROMPT, /RIGHT_LENS: <YES \| MAYBE \| NO>/);
  assert.match(LENS_EYES_PROMPT, /reflected scenery/);
});

test("bant iki gözü cömert payla kapsar ve görüntü dışına taşmaz", () => {
  const pts = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  for (let i = 36; i <= 41; i++) pts[i] = { x: 400 + (i - 36) * 4, y: 500 };
  for (let i = 42; i <= 47; i++) pts[i] = { x: 520 + (i - 42) * 4, y: 502 };
  const box = { x: 350, y: 380, width: 260, height: 300 };
  const r = lensBandRect(pts, box, 1000, 1400);
  const iod = 120;
  assert.ok(r.left <= 410 - 0.66 * iod && r.left + r.width >= 530 + 0.66 * iod, JSON.stringify(r));
  assert.ok(r.top <= 500 - 0.4 * iod && r.top + r.height >= 502 + 0.6 * iod, JSON.stringify(r));
  const edge = lensBandRect(pts, box, 560, 520);
  assert.ok(edge.left >= 0 && edge.top >= 0 && edge.left + edge.width <= 560 && edge.top + edge.height <= 520);
  // Nokta yoksa yüz kutusundan (göz hizası kutunun üst yarısında).
  const fb = lensBandRect(null, box, 1000, 1400);
  assert.ok(fb.top < box.y + 0.4 * box.height && fb.top + fb.height > box.y + 0.45 * box.height);
  assert.equal(lensBandRect(pts, null, 1000, 1400), null);
  assert.equal(lensBandRect(null, { x: 0, y: 0, width: 10, height: 10 }, 1000, 1400), null);
});

async function withFetch(fake, fn) {
  const real = global.fetch;
  global.fetch = fake;
  try { return await fn(); } finally { global.fetch = real; }
}
const img = () => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 100, b: 90 } } }).jpeg().toBuffer();
const band = { left: 50, top: 60, width: 300, height: 120 };

test("FAIL-SAFE: girdi yok, http hatası, ağ hatası, okunamayan cevap -> göz görünüyor (taşıma yok), tek istek", async () => {
  const buf = await img();
  assert.equal((await judgeLensEyes(buf, band, null)).eyesThrough, null);
  assert.equal((await judgeLensEyes(null, band, "k")).eyesThrough, null);
  assert.equal((await judgeLensEyes(buf, null, "k")).eyesThrough, null);
  let calls = 0;
  const r500 = await withFetch(async () => { calls++; return { ok: false, status: 500 }; }, () => judgeLensEyes(buf, band, "k"));
  assert.equal(calls, 1);
  assert.deepEqual([r500.ok, r500.reason, r500.eyesThrough], [false, "http-500", null]);
  assert.equal(lensJudgeAllowsTransfer(r500), false);
  calls = 0;
  const r429 = await withFetch(async () => { calls++; return { ok: false, status: 429 }; }, () => judgeLensEyes(buf, band, "k"));
  assert.equal(calls, 1, "429'da tekrar yok");
  assert.equal(lensJudgeAllowsTransfer(r429), false);
  const rErr = await withFetch(async () => { throw new Error("ECONNRESET"); }, () => judgeLensEyes(buf, band, "k"));
  assert.deepEqual([rErr.ok, rErr.reason, rErr.eyesThrough], [false, "error", null]);
  const rBad = await withFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "Sorry." } }] }) }), () => judgeLensEyes(buf, band, "k"));
  assert.equal(rBad.ok, false);
  assert.equal(lensJudgeAllowsTransfer(rBad), false);
  // Bant görüntü dışında -> sharp hatası -> göz görünüyor.
  const rOut = await withFetch(async () => { throw new Error("fetch çağrılmamalı"); }, () => judgeLensEyes(buf, { left: 380, top: 280, width: 300, height: 300 }, "k"));
  assert.equal(rOut.eyesThrough, null);
});

test("istek: gpt-4.1, sıcaklık 0, tek görsel high, zaman aşımı sinyali; çift NO -> izin", async () => {
  const buf = await img();
  let body = null, signal = null;
  const r = await withFetch(async (url, opts) => {
    body = JSON.parse(opts.body); signal = opts.signal;
    return { ok: true, json: async () => ({ usage: { prompt_tokens: 499, completion_tokens: 11 }, choices: [{ message: { content: "LEFT_LENS: NO\nRIGHT_LENS: NO" } }] }) };
  }, () => judgeLensEyes(buf, band, "k"));
  assert.equal(body.model, "gpt-4.1");
  assert.equal(body.temperature, 0);
  const imgs = body.messages[1].content.filter((c) => c.type === "image_url");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image_url.detail, "high");
  assert.ok(signal, "zaman aşımı sinyali olmalı");
  // Gönderilen kırpım büyütülmüş (300 px bant -> 512 genişlik).
  const sent = Buffer.from(imgs[0].image_url.url.split(",")[1], "base64");
  assert.equal((await sharp(sent).metadata()).width, 512);
  assert.equal(r.ok, true);
  assert.equal(r.eyesThrough, false);
  assert.equal(lensJudgeAllowsTransfer(r), true);
});

test("zaman aşımı çağıranın verdiği süreye uyar; ham cevap tek satır döner", async () => {
  const buf = await img();
  // Hiç cevap vermeyen sunucu: sinyal kesince hata -> göz görünüyor, taşıma yok.
  const t0 = Date.now();
  const rTo = await withFetch((url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener("abort", () => rej(opts.signal.reason || new Error("aborted")));
  }), () => judgeLensEyes(buf, band, "k", { timeoutMs: 80 }));
  assert.ok(Date.now() - t0 < 3000, "kalan süreyle sınırlı zaman aşımı beklenenden uzun sürdü");
  assert.deepEqual([rTo.ok, rTo.eyesThrough], [false, null]);
  assert.equal(lensJudgeAllowsTransfer(rTo), false);
  // İzin verilen yolda da ham cevap loga gidebilsin (canlı sızıntı denetimi).
  const r = await withFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "LEFT_LENS: NO\n\nRIGHT_LENS: NO" } }] }) }), () => judgeLensEyes(buf, band, "k"));
  assert.equal(r.raw, "LEFT_LENS: NO RIGHT_LENS: NO");
  assert.equal(lensJudgeAllowsTransfer(r), true);
});

test("falPhotos entegrasyonu: taşıma iki yargıya bağlı, süre sınırlı, izinde de loglanır", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "falPhotos.js"), "utf8");
  assert.match(src, /const LENS_JUDGE_MIN_LEFT_MS = 5 \* 1000;/);
  assert.match(src, /lensJudgeAllowsTransfer\(lj\)/);
  assert.match(src, /judgeLensEyes\(tplForEyewear, band, OPENAI_KEY\.value\(\), \{ timeoutMs \}\)/);
  assert.match(src, /taşıma ATLANDI\[lens-judge\]/);
  assert.match(src, /süre yok, gözlüksüz/);
  assert.match(src, /BASE'DEN TAŞINDI[^\n]*camYargı=\$\{lj\.lenses\.join/);
  // keepEyes eşlemesi değişmedi: 'own' yalnız ana yargı YES'te.
  assert.match(src, /keepEyes: templateEyewear\.eyesVisible === true \? "own" : "hide"/);
});
