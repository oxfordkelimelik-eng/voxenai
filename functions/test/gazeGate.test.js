const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseGazeToken,
  gazeDirection,
  isGazeMismatch,
  irisOffsetFromGray,
  isIrisGazeMismatch,
} = require("../gazeGate");

test("b1d697 c0 teslim: taban CAMERA, çıktı RIGHT → uyuşmazlık", () => {
  assert.equal(
    isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: RIGHT"),
    true
  );
});

test("aynı yöne bakıyorsa geçsin", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: RIGHT", "OUTPUT_GAZE: RIGHT"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: DOWN", "OUTPUT_GAZE: DOWN"), false);
});

test("satır yoksa fail-safe geçsin", () => {
  assert.equal(isGazeMismatch(null, "OUTPUT_GAZE: RIGHT"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", ""), false);
});

// AWAY KURALI DARALTILDI (2026-09-14). Eskiden tek tarafta AWAY görmek
// elemeyi tamamen kapatıyordu; kullanıcının şikâyet ettiği iki teslim
// edilmiş kare (420fd8c6 elegance_6, 7160f104 elegance_5) tam da bu
// boşluktan geçmişti. Artık AWAY yalnızca KARŞI TARAF DA yönsüzse
// (AWAY/CAMERA) belirsizlik sayılır.
test("AWAY ile CAMERA — ikisi de yönsüz, eleme yok", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: AWAY"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY", "OUTPUT_GAZE: AWAY"), false);
});

test("AWAY karşısında NET YÖN varsa uyuşmazlık sayılır (kaçış kapısı kapandı)", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY", "OUTPUT_GAZE: RIGHT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: LEFT", "OUTPUT_GAZE: AWAY"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY", "OUTPUT_GAZE: AWAY_LEFT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_DOWN", "OUTPUT_GAZE: AWAY"), true);
});

test("token ayrıştırması satır önekini yutar", () => {
  assert.equal(parseGazeToken("BASE_GAZE: LEFT"), "LEFT");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY"), "AWAY");
  assert.equal(parseGazeToken("nonsense"), null);
});

// --- AWAY PARÇALANMASI (2026-09-13, job f0bc4d5c elegance c1) -------------
// Kullanıcı teslim edilmiş bir kareyi işaret etti: "taban fotomuz ile tamamen
// farklı yere bakıyor, kesin ret sebebi olmalıydı". Eski ölçekte taban AWAY /
// çıktı AWAY eşit sayılıp geçiyordu.

test("AWAY_LEFT vs AWAY_RIGHT — zıt yönler artık uyuşmazlık (f0bc4d5c c1)", () => {
  assert.equal(
    isGazeMismatch("BASE_GAZE: AWAY_LEFT", "OUTPUT_GAZE: AWAY_RIGHT"),
    true
  );
  assert.equal(
    isGazeMismatch("BASE_GAZE: AWAY_UP", "OUTPUT_GAZE: AWAY_DOWN"),
    true
  );
});

test("aynı yöne uzağa bakış geçer", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_LEFT", "OUTPUT_GAZE: AWAY_LEFT"), false);
});

test("AWAY_LEFT ile LEFT aynı tarafı gösterir — uyuşmazlık DEĞİL", () => {
  // "uzağa" ile "yana" arasındaki sınır modelin yorumuna bağlı; o ayrımla
  // kare elemek yeni yanlış pozitifler doğurur.
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_LEFT", "OUTPUT_GAZE: LEFT"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: RIGHT", "OUTPUT_GAZE: AWAY_RIGHT"), false);
});

// NOT: "çıplak AWAY her şeyi affeder" testi 2026-09-14'te KALDIRILDI —
// yerini yukarıdaki iki test aldı (AWAY yalnızca karşı taraf da yönsüzse
// belirsizlik sayılır). Eski kural teslim edilen kötü karelerin kaçış
// yoluydu; bkz. gazeGate.js'teki "ÇIPLAK AWAY ARTIK HER ŞEYİ AFFETMİYOR".

test("farklı eksen (DOWN vs RIGHT) uyuşmazlıktır", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: DOWN", "OUTPUT_GAZE: RIGHT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_DOWN", "OUTPUT_GAZE: AWAY_LEFT"), true);
});

// ÇIKTI MERCEĞE BAKIYORSA KUSUR YOK (2026-09-18) — bkz. gazeGate.js'teki
// "ÇIKTININ MERCEĞE BAKMASI ARTIK KUSUR DEĞİL" ölçümü. Taban bizim
// şablonumuz; kullanıcı onu hiç görmüyor ve flört profilinde merceğe bakan
// kare zaten istenen karedir. Ölçümde RIGHT->CAMERA 21, LEFT->CAMERA 11 ret
// üretmişti ve bu karelerin hiçbiri geçemiyordu.
test("çıktı CAMERA ise taban ne olursa olsun uyuşmazlık DEĞİL", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_RIGHT", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: RIGHT", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: LEFT", "OUTPUT_GAZE: CAMERA"), false);
  assert.equal(isGazeMismatch("BASE_GAZE: DOWN", "OUTPUT_GAZE: CAMERA"), false);
});

// TERS YÖN KORUNUYOR: kapıyı doğuran şikâyetler (420fd8c6 elegance_6,
// 7160f104 elegance_5, f0bc4d5c c1) "taban merceğe bakıyor, çıktı kaçıyor"
// yönündeydi. Bu muafiyet o korumayı GEVŞETMEMELİ.
test("taban CAMERA iken çıktının kaçması HÂLÂ uyuşmazlık", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: AWAY_LEFT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: RIGHT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: DOWN"), true);
});

test("bileşik token çıplak olandan ÖNCE eşleşir (sıralama regresyonu)", () => {
  // GAZE_TOKENS sırası bozulursa "AWAY_LEFT" satırı "AWAY" diye okunur ve
  // kapı sessizce ölür — bu test o sırayı kilitler.
  assert.equal(parseGazeToken("BASE_GAZE: AWAY_LEFT"), "AWAY_LEFT");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY_RIGHT"), "AWAY_RIGHT");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY_UP"), "AWAY_UP");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY_DOWN"), "AWAY_DOWN");
  assert.equal(parseGazeToken("OUTPUT_GAZE: AWAY"), "AWAY");
});

test("gazeDirection: eksen ve yön eşlemesi", () => {
  assert.deepEqual(gazeDirection("LEFT"), { axis: "x", sign: -1 });
  assert.deepEqual(gazeDirection("AWAY_LEFT"), { axis: "x", sign: -1 });
  assert.deepEqual(gazeDirection("AWAY_DOWN"), { axis: "y", sign: 1 });
  assert.equal(gazeDirection("CAMERA"), null);
  assert.equal(gazeDirection("AWAY"), null);
});

test("koyu leke gözün sağındaysa iris x > 0.5", () => {
  const w = 20, h = 10;
  const gray = new Uint8Array(w * h).fill(200);
  for (let y = 2; y <= 7; y++) {
    for (let x = 12; x <= 16; x++) gray[y * w + x] = 20;
  }
  const r = irisOffsetFromGray(gray, w, h, [
    { x: 2, y: 2 }, { x: 17, y: 2 }, { x: 17, y: 7 }, { x: 2, y: 7 },
  ]);
  assert.ok(r);
  assert.ok(r.x > 0.55);
});

test("iris kayması 0.07 ve üstü uyuşmazlıktır", () => {
  assert.equal(
    isIrisGazeMismatch({ irisX: 0.50, irisY: 0.50, eyeWidth: 14 }, { irisX: 0.58, irisY: 0.50, eyeWidth: 14 }),
    true
  );
  assert.equal(
    isIrisGazeMismatch({ irisX: 0.50, irisY: 0.50, eyeWidth: 14 }, { irisX: 0.52, irisY: 0.50, eyeWidth: 14 }),
    false
  );
});

test("göz çok dar veya ölçü yoksa iris kapısı susar", () => {
  assert.equal(isIrisGazeMismatch({ irisX: 0.2, eyeWidth: 6 }, { irisX: 0.8, eyeWidth: 6 }), false);
  assert.equal(isIrisGazeMismatch(null, { irisX: 0.8, eyeWidth: 14 }), false);
});

// ---------------------------------------------------------------------------
// ŞABLON BAKIŞ YÖNÜ EŞLEMESİ (2026-09-17)
// ---------------------------------------------------------------------------
// falPhotos içindeki gazeDirectHint, measureIrisGaze'in irisX'ini yöne çevirir
// ve bunu modele SÖYLER. Yön TERS olursa modele yanlış talimat gider ve durum
// KÖTÜLEŞİR — bu yüzden eşleme burada kilitleniyor.
//
// Eşleme GERÇEK karelerle gözle doğrulandı (2026-09-17):
//   irisX=0.232 -> kişi kendi SAĞINA bakıyordu  (their RIGHT)  ✓
//   irisX=0.721 -> kişi kendi SOLUNA bakıyordu  (their LEFT)   ✓
//   irisX=0.542 -> kişi kameraya bakıyordu      (CAMERA)       ✓

function dirFromIrisX(irisX) {
  const d = irisX - 0.5;
  return Math.abs(d) < 0.12 ? "CAMERA" : (d < 0 ? "their RIGHT" : "their LEFT");
}

test("irisX yön eşlemesi: düşük=sağ, yüksek=sol, orta=kamera", () => {
  // Gerçek ölçülmüş ve GÖZLE doğrulanmış üç vaka.
  assert.equal(dirFromIrisX(0.232), "their RIGHT");
  assert.equal(dirFromIrisX(0.721), "their LEFT");
  assert.equal(dirFromIrisX(0.542), "CAMERA");
});

test("kamera bandı simetrik ve 0.12 eşiğinde", () => {
  assert.equal(dirFromIrisX(0.50), "CAMERA");
  assert.equal(dirFromIrisX(0.61), "CAMERA");   // sınırın hemen içi
  assert.equal(dirFromIrisX(0.39), "CAMERA");
  assert.equal(dirFromIrisX(0.63), "their LEFT");  // sınırın hemen dışı
  assert.equal(dirFromIrisX(0.37), "their RIGHT");
});

test("uç değerler makul yön verir (ölçüm bozulursa yakalanır)", () => {
  assert.equal(dirFromIrisX(0.0), "their RIGHT");
  assert.equal(dirFromIrisX(1.0), "their LEFT");
});

// POZA GÖRE REFERANS SIRASI (2026-10-08).
const { poseMatchedOrder } = require("../gazeGate");

test("poz: şablona belirgin yakın selfie öne alınır, çapa ikinci sıraya iner", () => {
  const p = poseMatchedOrder([0.45, 0.08, 0.30], 0.07);
  assert.equal(p.swapped, true);
  assert.deepEqual(p.order, [1, 0, 2]);
});

test("poz: kazanç küçükse kimlik çapası yerinde kalır", () => {
  const p = poseMatchedOrder([0.15, 0.06, 0.40], 0.07);
  assert.equal(p.swapped, false);
  assert.deepEqual(p.order, [0, 1, 2]);
});

test("poz: şablon ya da çapa ölçülemediyse sıra değişmez", () => {
  assert.equal(poseMatchedOrder([0.5, 0.1], null).swapped, false);
  assert.equal(poseMatchedOrder([null, 0.1], 0.1).swapped, false);
});

test("poz: ölçülemeyen selfie atlanır", () => {
  const p = poseMatchedOrder([0.6, null, 0.1], 0.05);
  assert.deepEqual(p.order, [2, 0, 1]);
});

test("zıt iris: d0d4c001 c7 — şablon 0.82, çıktı 0.36 → red", () => {
  const { isIrisGazeOpposite } = require("../gazeGate");
  const g = (x, extra = {}) => ({ irisX: x, eyes: 2, eyeWidth: 15, eyeCheek: 0.7, ...extra });
  assert.equal(isIrisGazeOpposite(g(0.82), g(0.36)), true);
  // Aynı yana daha az bakış (017dbe34 c7: 0.82 → 0.62) kaba hata değil.
  assert.equal(isIrisGazeOpposite(g(0.82), g(0.62)), false);
  // Şablon merkeze yakınsa (yön belirsiz) susar.
  assert.equal(isIrisGazeOpposite(g(0.58), g(0.30)), false);
});

test("zıt iris: güneş gözlüğü, tek göz, küçük göz → susar", () => {
  const { isIrisGazeOpposite } = require("../gazeGate");
  const g = (x, extra = {}) => ({ irisX: x, eyes: 2, eyeWidth: 15, eyeCheek: 0.7, ...extra });
  assert.equal(isIrisGazeOpposite(g(0.82, { eyeCheek: 0.2 }), g(0.3)), false);
  assert.equal(isIrisGazeOpposite(g(0.82, { eyes: 1 }), g(0.3)), false);
  assert.equal(isIrisGazeOpposite(g(0.82), g(0.3, { eyeWidth: 9 })), false);
  assert.equal(isIrisGazeOpposite(null, g(0.3)), false);
});

// PROFİL SELFIE FİLTRESİ (2026-10-26, e25dc241): düz şablona tam profil selfie gitmez.
test("poseFilteredRefs: düz şablonda tam profiller çıkar, en az 2 selfie kalır, dönük şablonda dokunulmaz", () => {
  const { poseFilteredRefs } = require("../gazeGate");
  // e25dc241'in seti
  const e25 = [1.0, 1.0, 0.17, 1.0, 0.17];
  assert.deepEqual(poseFilteredRefs(e25, 0.06).keep, [2, 4]);
  assert.deepEqual(poseFilteredRefs(e25, 0.06).dropped, [0, 1, 3]);
  // dönük şablon: hepsi kalır
  assert.deepEqual(poseFilteredRefs(e25, 0.82).keep, [0, 1, 2, 3, 4]);
  // profil yoksa değişmez
  assert.equal(poseFilteredRefs([0.1, 0.3, 0.6, 0.2, 0.05], 0.1).dropped.length, 0);
  // tek düz selfie: şablona en yakın profil geri alınır (en az 2)
  const one = poseFilteredRefs([0.95, 0.85, 0.1, 1.0, 0.9], 0.2);
  assert.deepEqual(one.keep, [1, 2]);
  // ölçülemeyen selfie tutulur; yön yoksa dokunulmaz
  assert.deepEqual(poseFilteredRefs([1.0, null, 0.2, 1.0, 0.1], 0.1).keep, [1, 2, 4]);
  assert.deepEqual(poseFilteredRefs(e25, null).keep, [0, 1, 2, 3, 4]);
});

// 546b514b (2026-10-28): üç çeyrek şablona şablondan ≥0.2 daha dönük selfie gitmez.
test("poseFilteredRefs: dönük şablonda şablondan çok daha dönük selfie çıkar", () => {
  const { poseFilteredRefs } = require("../gazeGate");
  const s546 = [0.86, 0.03, 0.41, 1.0, 1.0];
  assert.deepEqual(poseFilteredRefs(s546, 0.78).keep, [0, 1, 2]);
  assert.deepEqual(poseFilteredRefs(s546, 0.57).keep, [1, 2]);
  // tam profil şablonda profiller kalır
  assert.deepEqual(poseFilteredRefs(s546, 0.94).keep, [0, 1, 2, 3, 4]);
  // en az 2: şablona en yakın dönük selfie geri alınır
  assert.deepEqual(poseFilteredRefs([1.0, 0.95, 0.1, 1.0, 1.0], 0.6).keep, [1, 2]);
});
