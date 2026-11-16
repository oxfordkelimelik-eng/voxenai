const test = require("node:test");
const assert = require("node:assert");
const { _testables: T } = require("../sunglassTransfer");
const FL = require("../faceLight");

// Yapay yüz: deri zemin; iki koyu cam (gözlük sınıfı); köprüde deri renkli
// "gözlük" pikselleri (80fc7ec4 c1: model köprü derisini gözlük saydı); sağ
// şakakta sap boyunca kalın gözlük sınıfı bandı (80f c3: şakak derisi/saç);
// sol camın yarısı deri sınıfında ama koyu (80f c8) ve gözlük çerçevesi içinde.
function scene({ halfLensAsSkin = false, wideDark = false } = {}) {
  const W = 200, H = 120;
  const rgb = Buffer.alloc(W * H * 3);
  const G = new Float32Array(W * H), S = new Float32Array(W * H);
  const skin = [200, 150, 120], dark = [22, 22, 24];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let c = skin; S[i] = 1;
    const inR = Math.abs(x - 70) <= 20 && Math.abs(y - 62) <= 13;
    const inL = Math.abs(x - 130) <= 20 && Math.abs(y - 62) <= 13;
    const rimR = inR && (Math.abs(x - 70) >= 18 || Math.abs(y - 62) >= 11);
    const rimL = inL && (Math.abs(x - 130) >= 18 || Math.abs(y - 62) >= 11);
    const bridge = x > 90 && x < 110 && Math.abs(y - 56) <= 2;
    const bridgeSkin = x > 92 && x < 108 && y > 59 && y < 70;
    const temple = x >= 152 && x <= 172 && y >= 44 && y <= 66;
    // 80f c9: sol cama bitişik, koyu ve nötr geniş alan (favori/sakal/kulaklık)
    // gözlük sınıfında.
    const beard = wideDark && x >= 150 && x <= 195 && y >= 40 && y <= 85;
    if (inR || inL || bridge || beard) {
      c = dark;
      const lensAsSkin = halfLensAsSkin && inR && !rimR && x < 70;
      if (!lensAsSkin) G[i] = 1;
    } else if (bridgeSkin) G[i] = 1;
    else if (temple) G[i] = 1;
    rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
  }
  const mesh = Array.from({ length: 468 }, () => [100, 60]);
  for (const k of [33, 133, 159, 145]) mesh[k] = [70, 60];
  for (const k of [362, 263, 386, 374]) mesh[k] = [130, 60];
  for (const k of [70, 63, 105, 66, 107, 336, 296, 334, 293, 300]) mesh[k] = [100, 40];
  for (const k of [4, 5, 1]) mesh[k] = [100, 95];
  for (const k of [151, 9, 108, 337]) mesh[k] = [100, 22];
  mesh[127] = [35, 62]; mesh[356] = [165, 62];
  return { rgb, W, H, mesh, seg: { x0: 0, y0: 0, w: W, h: H, G, S } };
}

test("sade maske: camlar var, köprü derisi ve şakak bandı yok", () => {
  const { rgb, W, H, mesh, seg } = scene();
  const sm = T.glassesMask(rgb, W, H, mesh, 0, seg);
  assert.ok(sm && !sm.reject, `maske var ${sm && sm.reject}`);
  const at = (x, y) => sm.mask[(y - sm.crop.y0) * sm.crop.cw + (x - sm.crop.x0)];
  assert.strictEqual(at(70, 62), 1, "sağ cam");
  assert.strictEqual(at(130, 62), 1, "sol cam");
  assert.strictEqual(at(100, 64), 0, "köprü derisi taşınmaz");
  assert.strictEqual(at(162, 55), 0, "şakaktaki kalın gözlük sınıfı bandı taşınmaz");
  assert.ok(sm.cover.every((c) => c == null || c >= T.MIN_COVER));
});

test("cam yarısı deri sayıldıysa ama çerçeve içindeyse koyu dolgu tamamlar", () => {
  const { rgb, W, H, mesh, seg } = scene({ halfLensAsSkin: true });
  const sm = T.glassesMask(rgb, W, H, mesh, 0, seg);
  assert.ok(sm && !sm.reject, `maske var ${sm && sm.reject}`);
  assert.ok(sm.holePx > 0);
  assert.strictEqual(sm.mask[(62 - sm.crop.y0) * sm.crop.cw + (60 - sm.crop.x0)], 1);
});

// Kapı C (80f c9): cama bitişik geniş koyu alan (favori, sakal, kulaklık)
// gözlük sınıfındaysa taşıma reddedilir; başka kişinin favorisi taşınmaz.
test("cam dışı maske payı büyükse taşıma reddedilir (seg-wide)", () => {
  const { rgb, W, H, mesh, seg } = scene({ wideDark: true });
  const sm = T.glassesMask(rgb, W, H, mesh, 0, seg);
  assert.ok(sm, "maske hesaplanır");
  assert.strictEqual(sm.reject, "seg-wide");
  assert.ok(sm.outFrac > T.MAX_OUT_ZONE_FRAC, `dış pay ${sm.outFrac}`);
  // Aynı sahne geniş alan olmadan geçer ve dış payı küçüktür.
  const ok = T.glassesMask(...(() => { const s = scene(); return [s.rgb, s.W, s.H, s.mesh, 0, s.seg]; })());
  assert.ok(ok && !ok.reject);
  assert.ok(ok.outFrac <= T.MAX_OUT_ZONE_FRAC, `dış pay ${ok.outFrac}`);
});

test("siyah-beyaz için yüz eşiği tanımlı", () => {
  assert.ok(FL._testables.GRAY_FACE_SAT_MAX >= 6 && FL._testables.GRAY_FACE_SAT_MAX <= 15);
  assert.strictEqual(typeof FL.faceSaturation, "function");
});

// Kapı D (2026-11-06): göz açıklığında L* yayılımı. Yüz ağı göz çizgisi
// noktaları elips üzerine dağıtılır; içerik düz koyu (opak cam) ya da sklera +
// iris (camdan görünen göz).
function eyeScene(kind) {
  const W = 200, H = 120;
  const rgb = Buffer.alloc(W * H * 3, 0);
  const { rgb: base, mesh } = scene();
  base.copy(rgb);
  const contR = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const contL = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
  const put = (cont, cx) => cont.forEach((k, j) => {
    const a = (2 * Math.PI * j) / cont.length;
    mesh[k] = [cx + 10 * Math.cos(a), 63 + 5 * Math.sin(a)];
  });
  put(contR, 70); put(contL, 130);
  for (const k of [33, 133]) mesh[k] = [k === 33 ? 60 : 80, 63];
  for (const k of [362, 263]) mesh[k] = [k === 362 ? 120 : 140, 63];
  for (const k of [159, 386]) mesh[k] = [k === 159 ? 70 : 130, 58];
  for (const k of [145, 374]) mesh[k] = [k === 145 ? 70 : 130, 68];
  if (kind === "eye") {
    for (let y = 58; y <= 68; y++) for (let x = 0; x < W; x++) {
      for (const cx of [70, 130]) {
        if (Math.abs(x - cx) > 10) continue;
        const i = (y * W + x) * 3;
        const iris = Math.hypot(x - cx, y - 63) <= 4;
        const v = iris ? 15 : 110; // renkli camın ardında sklera / iris
        rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v;
      }
    }
  }
  return { rgb, W, H, mesh };
}

test("Kapı D: düz koyu cam (opak) yayılımı eşik altı, veto yok", () => {
  const { rgb, W, H, mesh } = eyeScene("dark");
  const sp = T.eyeSpread(rgb, W, H, mesh, 0);
  assert.ok(sp.every((v) => v != null && v < T.EYE_SPREAD_MAX), `yayılım ${sp}`);
  assert.strictEqual(T.eyesVisibleVeto(sp, 0), false);
});

test("Kapı D: camdan görünen sklera/iris veto eder (düz baş, yaw bilinmiyorsa da)", () => {
  const { rgb, W, H, mesh } = eyeScene("eye");
  const sp = T.eyeSpread(rgb, W, H, mesh, 5);
  assert.ok(sp.some((v) => v != null && v >= T.EYE_SPREAD_MAX), `yayılım ${sp}`);
  assert.strictEqual(T.eyesVisibleVeto(sp, 5), true);
  assert.strictEqual(T.eyesVisibleVeto(sp, null), true);
});

test("Kapı D: dönük başta (|yaw| > 20) ve ölçülemeyen gözde yerel veto yok", () => {
  assert.strictEqual(T.eyesVisibleVeto([40, 35], 30), false, "aynalı cam dönük başta (b932 c9) taşınır; cam yargısı karar verir");
  assert.strictEqual(T.eyesVisibleVeto([40, 35], -21), false);
  assert.strictEqual(T.eyesVisibleVeto([null, null], 0), false);
  assert.strictEqual(T.eyesVisibleVeto([null, 12.5], 0), true);
  assert.strictEqual(T.eyesVisibleVeto([11.9, 3], 20), false);
});
