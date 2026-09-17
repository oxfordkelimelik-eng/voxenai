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

test("CAMERA ile herhangi bir yön — eski davranış korunur", () => {
  assert.equal(isGazeMismatch("BASE_GAZE: CAMERA", "OUTPUT_GAZE: AWAY_LEFT"), true);
  assert.equal(isGazeMismatch("BASE_GAZE: AWAY_RIGHT", "OUTPUT_GAZE: CAMERA"), true);
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
