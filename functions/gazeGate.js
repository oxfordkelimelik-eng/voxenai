/**
 * Taban vs çıktı bakış karşılaştırması.
 *
 * Vision BASE_GAZE / OUTPUT_GAZE satırlarını üretir; 2026-09-06'da eleme
 * yapılmadı çünkü 4 uyuşmazlığın 3'ü tabanın yanlış okunmasıydı. 2026-09-07
 * işi b1d6972b bunu boşa çıkardı: teslim edilen chunk 0'da satırlar
 * CAMERA / RIGHT idi, kullanıcı "tabanla aynı yere bakmıyor" dedi ve kare
 * geçti. Artık iki satır da okunabiliyorsa ve farklıysa kare elenir.
 *
 * Satır yoksa / AWAY belirsizse fail-safe: eleme YOK. AWAY, yönün
 * okunamadığı kaçış kapısıdır; belirsiz ölçümle kare elenmez.
 *
 * AWAY PARÇALANDI (2026-09-13, gerçek vaka job f0bc4d5c elegance c1).
 *
 * SORUN: kullanıcı teslim edilen bir kareyi işaret etti — "taban fotomuz ile
 * tamamen farklı yere bakıyor, kesin ret sebebi olmalıydı". Aynı işte kapı
 * ÜÇ kareyi bakış yüzünden elemişti, yani kapı çalışıyordu; bu kareyi
 * kaçırmasının sebebi ÖLÇEĞİN KABALIĞIydı.
 *
 * AWAY tek bir kova olarak hem "sağa uzağa" hem "sola uzağa" bakışı içine
 * alıyordu. Taban AWAY, çıktı AWAY -> eşit sayılıp geçiyordu; oysa biri
 * sağa, diğeri sola bakıyorsa insan gözü bunu anında görüyor. Üstelik
 * ikisi de AWAY olduğunda yukarıdaki "belirsiz" kuralı da devreye girip
 * elemeyi ayrıca engelliyordu — çift koruma, yanlış yönde.
 *
 * ÇÖZÜM: AWAY dört yöne ayrıldı (AWAY_LEFT/RIGHT/UP/DOWN). Artık iki taraf
 * da okunabildiğinde yön karşılaştırılabiliyor. Çıplak AWAY hâlâ geçerli
 * bir cevap ve hâlâ ELEMİYOR: model yönü gerçekten seçemediğinde kullanacağı
 * kaçış kapısı olarak bilerek korundu (bkz. isGazeMismatch'teki kontrol).
 *
 * ZITLIK KURALI: yalnızca AÇIKÇA ZIT yönler elenir (sol↔sağ, yukarı↔aşağı).
 * AWAY_LEFT ile LEFT aynı tarafı gösterir, uyuşmazlık sayılmaz — "uzağa"
 * ile "yana" arasındaki sınır modelin yorumuna bağlı ve o ayrımla kare
 * elemek yeni yanlış pozitifler doğurur. Bu, dosyanın genel usulü: kaba
 * ölçümle yalnızca kaba hatayı ele.
 */

// Sıralama ÖNEMLİ: parseGazeToken ilk eşleşeni döndürür, bu yüzden bileşik
// isimler (AWAY_LEFT) çıplak olanlardan (AWAY, LEFT) ÖNCE gelmeli.
const GAZE_TOKENS = [
  "AWAY_LEFT", "AWAY_RIGHT", "AWAY_UP", "AWAY_DOWN",
  "CAMERA", "LEFT", "RIGHT", "UP", "DOWN", "AWAY",
];

function parseGazeToken(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const up = line.toUpperCase();
  for (const tok of GAZE_TOKENS) {
    if (new RegExp(`(?:^|:)\\s*${tok}\\b`).test(up)) return tok;
  }
  return null;
}

/** Token'ın gösterdiği yön ekseni ve yönü. Bilinmiyorsa null. */
function gazeDirection(token) {
  switch (token) {
    case "LEFT": case "AWAY_LEFT": return { axis: "x", sign: -1 };
    case "RIGHT": case "AWAY_RIGHT": return { axis: "x", sign: 1 };
    case "UP": case "AWAY_UP": return { axis: "y", sign: -1 };
    case "DOWN": case "AWAY_DOWN": return { axis: "y", sign: 1 };
    default: return null; // CAMERA ve çıplak AWAY'in yönü yok
  }
}

function isGazeMismatch(baseLine, outputLine) {
  const base = parseGazeToken(baseLine);
  const out = parseGazeToken(outputLine);
  if (!base || !out) return false;
  if (base === out) return false;

  // ÇIPLAK AWAY ARTIK HER ŞEYİ AFFETMİYOR (2026-09-14).
  //
  // Eskiden tek tarafta AWAY görmek elemeyi TAMAMEN kapatıyordu ve bu,
  // kullanıcının şikâyet ettiği teslim edilmiş karelerin kaçış yoluydu
  // (420fd8c6 elegance_6, 7160f104 elegance_5: "taban ile tamamen farklı
  // yere bakıyor, ret olması lazımdı"). Model bir tarafı net okuyup
  // diğerine belirsizlik hissettiğinde AWAY yazıyor ve kötü kare geçiyordu.
  //
  // YENİ KURAL: AWAY yalnızca DİĞER TARAF DA yönsüzse (AWAY/CAMERA)
  // belirsizlik sayılır. Karşı taraf net bir YÖN bildiriyorsa (LEFT,
  // AWAY_RIGHT, DOWN ...) bu artık ölçülebilir bir uyuşmazlıktır: biri
  // "uzağa, yönü seçemedim" derken diğeri "sola" diyorsa iki bakış aynı
  // noktada değildir. CAMERA ile AWAY hâlâ affediliyor — ikisi de tek
  // başına yön taşımaz ve aralarındaki fark güvenilir okunamaz.
  if (base === "AWAY" || out === "AWAY") {
    const otherTok = base === "AWAY" ? out : base;
    // Karşı taraf da yönsüzse (AWAY/CAMERA) -> belirsiz, eleme yok.
    return gazeDirection(otherTok) !== null;
  }

  const b = gazeDirection(base);
  const o = gazeDirection(out);
  // CAMERA <-> herhangi bir yön: eski davranış korunuyor. Kameraya bakmakla
  // yana bakmak arasındaki fark kabadır ve güvenilir şekilde okunur.
  if (!b || !o) return true;
  // Aynı eksende ZIT yön -> uyuşmazlık (sola karşı sağa).
  if (b.axis === o.axis) return b.sign !== o.sign;
  // FARKLI EKSEN (ör. taban DOWN, çıktı RIGHT) da uyuşmazlık: biri aşağı
  // biri yana bakıyorsa bakış noktası aynı olamaz.
  return true;
}

// İris kayması — kaba CAMERA/LEFT sınıfı aynı kalsa bile gözbebeği
// yer değiştirmişse bakış aynı yerde değildir (b1d6972b c1/c2/c3).
const IRIS_MISMATCH_X = 0.07;
const IRIS_MISMATCH_Y = 0.10;
const IRIS_MIN_EYE_PX = 10;

/** Göz çokgeni içindeki koyu piksellerin ağırlıklı merkezi → 0..1 x/y. */
function irisOffsetFromGray(gray, w, h, pts) {
  if (!gray || !pts || pts.length < 4) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 6 || bh < 3) return null;
  const vals = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) vals.push(gray[y * w + x]);
  }
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(vals.length * 0.25)];
  let sx = 0, sy = 0, sw = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = gray[y * w + x];
      if (v > cut) continue;
      const weight = cut - v + 1;
      sx += x * weight;
      sy += y * weight;
      sw += weight;
    }
  }
  if (sw === 0) return null;
  return { x: (sx / sw - x0) / bw, y: (sy / sw - y0) / bh, width: bw, height: bh };
}

function isIrisGazeMismatch(base, out) {
  if (!base || !out) return false;
  if (base.irisX == null || out.irisX == null) return false;
  const minW = Math.min(base.eyeWidth || 0, out.eyeWidth || 0);
  if (minW < IRIS_MIN_EYE_PX) return false;
  const dx = Math.abs(out.irisX - base.irisX);
  const dy = (base.irisY != null && out.irisY != null)
    ? Math.abs(out.irisY - base.irisY)
    : 0;
  return dx >= IRIS_MISMATCH_X || dy >= IRIS_MISMATCH_Y;
}

module.exports = {
  parseGazeToken,
  gazeDirection,
  isGazeMismatch,
  irisOffsetFromGray,
  isIrisGazeMismatch,
  GAZE_TOKENS,
  IRIS_MISMATCH_X,
  IRIS_MISMATCH_Y,
  IRIS_MIN_EYE_PX,
};
