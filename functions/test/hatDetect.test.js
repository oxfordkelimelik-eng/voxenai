// Şablon şapka detektörü + şapkalı şablon promptu (2026-11-06, bkz. hatDetect.js,
// naturalSwap.buildSelfieSetPrompt). Şapkasız şablonun promptu bayt bayt aynı
// kalmalı; gözlük şapka maskesine girmemeli (kaş kesimi).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const crypto = require("crypto");
const { buildNaturalSwapPrompt } = require("../naturalSwap");
const { hatMaskFromProbs, owlHatDecision, HAT_MIN_FACE2 } = require("../hatDetect")._testables;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// 2026-11-06 öncesi buildSelfieSetPrompt(n) çıktısının sha256'sı (repo naturalSwap.js db409f1f…).
const BEFORE = {
  1: "46317599e4a58473a1256c82bcff390c11cbc10674324540878b4692217d11c7",
  2: "d28400f4dce8e80da1f523fdab5af4f7008a60177610807609b84c6a23ff49be",
  3: "0195054cf558fbe671d1cf6b96568e74b8abcf96fd3f7ab1844cf895a39dd2ae",
  4: "1a4c4e5da2f884b1f78fb45b569876bb6cf8e1d6b077ba2609b02b103c715623",
  5: "f9c47f61ebc52429a2a734dc3b8004419dd67b935823e6b903c799d37f7e9240",
  6: "cdb128e9ce35779f7e78f586c15d49cdd87d7e86ecf6f76e8c5c527d0e154d3b",
};
const HAT_LINE = " If the first person wears a hat, cap or beanie, the new person wears that same one, exactly where and as large as it is; only the hair that shows below it comes from them.";

test("şapkasız şablon: selfie seti promptu bugünküyle bayt bayt aynı (hat yok / hat:false)", () => {
  // 2026-11-15: baş-boyun paragrafı (naturalSwap.describeHeadAndNeck) eski tek cümlenin yerini
  // aldı; o paragraf eski cümleye geri çevrilince metin 11-06 öncesiyle bayt bayt aynı.
  const { describeHeadAndNeck } = require("../naturalSwap")._testables;
  const OLD_NECK = " The new head sits exactly where the old head was, on the same neck and no larger against the shoulders.";
  const old = (q) => q.replace(describeHeadAndNeck(null), OLD_NECK);
  for (let n = 1; n <= 6; n++) {
    assert.ok(buildNaturalSwapPrompt(n, { prepared: false }).includes(describeHeadAndNeck(null)));
    assert.strictEqual(sha(old(buildNaturalSwapPrompt(n, { prepared: false }))), BEFORE[n], `n=${n}`);
    assert.strictEqual(sha(old(buildNaturalSwapPrompt(n, { prepared: false, hat: false }))), BEFORE[n], `n=${n} hat:false`);
  }
  // Hazırlanmış referans yolu (11-01) şapkadan etkilenmez.
  assert.strictEqual(sha(buildNaturalSwapPrompt(1)), "255da465c1a88b57ad4d7bb823150538ebb82c1b987520f191247e9d0ced2407");
  assert.strictEqual(buildNaturalSwapPrompt(2, { hat: true }), buildNaturalSwapPrompt(2));
});

test("şapkalı şablon: şapka cümlesi saç paragrafında yerinde, arka plan cümlesi yalnız açık saça", () => {
  const p = buildNaturalSwapPrompt(5, { prepared: false, hat: true });
  const base = buildNaturalSwapPrompt(5, { prepared: false });
  // Başa yazılmaz (hafıza gaze-tell-direction-upfront: baştaki cümle şapka/gözlüğü sildirmişti).
  assert.ok(p.startsWith("Replace the person in the first photo (the BASE)"));
  assert.ok(p.includes("Bald or balding stays so." + HAT_LINE + "\n\nLight and skin:"));
  assert.ok(p.includes("Where the first person's bare hair reached further than the new hair"));
  // Tek fark bu iki ekleme.
  assert.strictEqual(p.replace(HAT_LINE, "").replace("person's bare hair", "person's hair"), base);
});

// Sentetik kesit: 200×200, yüz genişliği 60 px, kaş üstü y=80, çene y=150.
function synth() {
  const side = 200, n = side * side, fw = 60;
  const P = Array.from({ length: 6 }, () => new Float32Array(n));
  const pts = Array.from({ length: 68 }, () => ({ x: 100, y: 120 }));
  pts[0] = { x: 70, y: 100 }; pts[16] = { x: 130, y: 100 };
  for (let k = 17; k < 27; k++) pts[k] = { x: 75 + (k - 17) * 5, y: 80 };
  pts[8] = { x: 100, y: 150 };
  pts[36] = { x: 82, y: 95 }; pts[45] = { x: 118, y: 95 };
  const CL = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };
  const box = (x0, y0, x1, y1, c = CL.others, v = 0.9) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) P[c][y * side + x] = v;
  };
  return { side, fw, P, pts, CL, box };
}

test("hatMaskFromProbs: kaş üstü kafaya bağlı 'others' = şapka alanı", () => {
  const s = synth();
  s.box(65, 40, 135, 80); // 70×40 = 2800 px = 0.78 yüz²
  const r = hatMaskFromProbs(s.P, s.CL, s.pts, s.fw, s.side);
  assert.ok(r.area >= HAT_MIN_FACE2, `alan=${r.area}`);
  assert.ok(Math.abs(r.area - 2800 / 3600) < 0.03);
});

test("hatMaskFromProbs: gözlük (kaş altı 'others') şapka sayılmaz — eski kaş+0.2·yüz kesimi sayardı", () => {
  const s = synth();
  // Çerçeve + camlar: kaşın hemen altından göz hizasına, 70×24 = 0.47 yüz².
  s.box(65, 81, 135, 105);
  const r = hatMaskFromProbs(s.P, s.CL, s.pts, s.fw, s.side);
  assert.strictEqual(r.px, 0);
  // Eski kural (kesim kaş + 0.2·(çene−kaş) = 94): kaş noktalarını o kadar aşağı
  // kaydırınca aynı maske eşiği geçerdi — gözlüklü base'lerin 0.146-0.148'i buydu.
  const old = s.pts.map((p, k) => (k >= 17 && k < 27 ? { x: p.x, y: p.y + 0.2 * 70 } : p));
  const r2 = hatMaskFromProbs(s.P, s.CL, old, s.fw, s.side);
  assert.ok(r2.area >= HAT_MIN_FACE2, `eski alan=${r2.area}`);
});

test("hatMaskFromProbs: yüzden uzak parça, ten/kıyafet ve küçük kırıntı elenir", () => {
  const s = synth();
  s.box(0, 10, 30, 60); // yüzün 40 px solunda (>0.3·fw): arka plan nesnesi
  s.box(150, 10, 200, 60); // sağda da uzak
  s.box(90, 60, 96, 66); // 36 px < 0.02·fw² = 72 px
  s.box(65, 40, 135, 80); // kaş üstü ama...
  s.box(65, 40, 135, 80, s.CL.bodySkin, 0.8); // ...ten baskın: şapka değil
  const r = hatMaskFromProbs(s.P, s.CL, s.pts, s.fw, s.side);
  assert.strictEqual(r.px, 0);
});

test("owlHatDecision: göz üstü, kafa boyunda kutu kabul; göz altı / dev / yandaki kutu reddedilir", () => {
  const pts = Array.from({ length: 68 }, () => ({ x: 500, y: 500 }));
  pts[0] = { x: 450, y: 520 }; pts[16] = { x: 550, y: 520 }; // fw = 100
  pts[36] = { x: 470, y: 500 }; pts[45] = { x: 530, y: 500 };
  const crop = { left: 300, top: 300, side: 400 };
  const s = (hat, hair = 0.02) => ({ hat, cap: 0, beanie: 0, beret: 0, "baseball cap": 0, hair });
  const at = (x, y, w, h, sc) => ({ cx: (x - 300) / 400, cy: (y - 300) / 400, w: w / 400, h: h / 400, s: sc });
  assert.strictEqual(owlHatDecision([at(500, 420, 140, 80, s(0.6))], crop, pts).score, 0.6);
  assert.strictEqual(owlHatDecision([at(500, 560, 140, 80, s(0.6))], crop, pts).score, 0); // göz altı
  assert.strictEqual(owlHatDecision([at(500, 420, 350, 80, s(0.6))], crop, pts).score, 0); // 3.5 yüz eni
  assert.strictEqual(owlHatDecision([at(640, 420, 140, 80, s(0.6))], crop, pts).score, 0); // yüzden 0.9 en yanda
  // Saçı yüksek kutu (0.3/0.5) arkasındaki geçerli kutuyu (0.2/0.02) gizlemez (2026-11-06 inceleme).
  const two = owlHatDecision([at(500, 420, 140, 80, s(0.3, 0.5)), at(500, 430, 120, 70, s(0.2))], crop, pts);
  assert.strictEqual(two.ok, true);
  assert.strictEqual(two.score, 0.2);
  // Hiçbiri kabul edilmezse ok=false, log için en yüksek kutu.
  const none = owlHatDecision([at(500, 420, 140, 80, s(0.3, 0.5)), at(500, 430, 120, 70, s(0.1))], crop, pts);
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.score, 0.3);
  assert.strictEqual(owlHatDecision([at(500, 420, 140, 80, s(0.6))], crop, pts).ok, true);
});

test("postTasks: templateHat görevi worker tablosunda", () => {
  const T = require("../postTasks");
  assert.strictEqual(typeof T.templateHat, "function");
});

// Gerçek gözlüklü şapkasız base'ler (yerel veri varsa): eski kuralda 0.146-0.148, şimdi 0.
const DS = "C:/xampp/htdocs/rise-up/ciktilar/2026-11-04_siluet/dataset/";
for (const id of ["9c8f2cb5_c0", "3b4f51cb_c2"]) {
  const f = `${DS}${id}_base.jpg`;
  test(`gerçek gözlüklü base ${id}: şapka yok, OWLv2 çalışmaz`, { skip: !fs.existsSync(f) && "yerel veri yok" }, async () => {
    const r = await require("../hatDetect").detectTemplateHat(fs.readFileSync(f));
    assert.strictEqual(r.hat, false);
    assert.ok(r.area < 0.05, `alan=${r.area}`);
    assert.strictEqual(r.score, null);
  });
}
