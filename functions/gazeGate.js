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

  // ÇIKTININ MERCEĞE BAKMASI ARTIK KUSUR DEĞİL (2026-09-18, ölçümle).
  //
  // TABAN BİZİM ŞABLONUMUZ, KULLANICININ FOTOĞRAFI DEĞİL. Kullanıcı şablonu
  // hiç görmüyor; "çıktının bakışı şablonunkine eşit olsun" kuralının son
  // kullanıcıya dönen hiçbir karşılığı yok. Sahne metinlerimizin çoğu
  // bilerek "looking out at the horizon / away from the lens" diyor, model
  // ise yüzü kullanıcının selfie'lerinden kurarken gözü ısrarla merceğe
  // çeviriyor. Yani kuralın kendisi, kendi şablon havuzumuzla modelin
  // değişmez davranışı arasındaki bir çelişkiyi kareye fatura ediyordu.
  //
  // ÖLÇÜM (2026-09-16..18, 21 iş, 212 ret): vision-gaze 106 retle tek
  // başına tüm retlerin %50'si. Yön çiftleri ayrıştırıldığında:
  //   RIGHT -> CAMERA : 21 ret / 0 geçiş
  //   LEFT  -> CAMERA : 11 ret / 0 geçiş
  // Bu karelerin HİÇBİRİ geçemiyor, çünkü kusur karede değil kuralda.
  // Kullanıcı aynı kareleri gözle inceleyip "bazıları ret edilmemeliydi"
  // dedi — flört profili için merceğe bakan kare zaten İSTENEN karedir.
  //
  // TERS YÖN KORUNUYOR: taban merceğe bakarken çıktının yana kaçması
  // (CAMERA -> LEFT/RIGHT/...) hâlâ uyuşmazlık. Kapıyı doğuran şikâyetler
  // (420fd8c6 elegance_6, 7160f104 elegance_5, f0bc4d5c c1) bu yöndeydi ve
  // o koruma yerinde kalıyor. Ölçümde bu yöndeki ret sayısı 34'ün 2'siydi.
  if (out === "CAMERA") return false;

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

// ZIT İRİS (2026-10-25, d0d4c001 c7, kullanıcı: "gözler doğru yere
// bakmıyor"): şablon gözleri belirgin bir yana (irisX 0.82), çıktı öbür yana
// (0.36) bakıyordu; Vision geçirdi. Eski hassas kapı (yukarıdaki eşikler)
// 2026-09-07'de 36 redden 21'ini üretip kaldırılmıştı — bu kural yalnız
// KABA hatayı ister: şablon merkezden ≥0.15 bir yanda, çıktı merkezden
// ≥0.10 ÖBÜR yanda. 92 arşiv çiftinde yalnız c7'yi seçti (fark p95 0.22).
// İki gözü de görünür ve yeterince büyük olmayan ya da güneş gözlüklü
// (göz/yanak < 0.38) yüzde susar.
const IRIS_OPPOSITE_BASE_MIN = 0.15;
const IRIS_OPPOSITE_OUT_MIN = 0.10;
const IRIS_OPPOSITE_MIN_EYE_PX = 12;
const IRIS_EYEWEAR_RATIO = 0.38;

function isIrisGazeOpposite(base, out) {
  const ok = (g) => g && g.irisX != null && g.eyes === 2 && (g.eyeWidth || 0) >= IRIS_OPPOSITE_MIN_EYE_PX &&
    !(g.eyeCheek != null && g.eyeCheek < IRIS_EYEWEAR_RATIO);
  if (!ok(base) || !ok(out)) return false;
  const b = base.irisX - 0.5, o = out.irisX - 0.5;
  return Math.abs(b) >= IRIS_OPPOSITE_BASE_MIN && Math.abs(o) >= IRIS_OPPOSITE_OUT_MIN && b * o < 0;
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

// POZA GÖRE REFERANS SIRASI (2026-10-08, kullanıcı kararı: "elemeden doğru
// yere baksın"). Model kafa yönünü büyük ölçüde selfie'lerden alıyor ve
// kafayı onlara doğru çekiyor (bkz. falPhotos.js OUTPUT_YAW_DRIFT_MAX:
// "regression to the mean"). Kafa yönü şablona en yakın selfie öne alınırsa
// model doğru açıyı kendiliğinden kurar — eleme ve ek üretim gerekmez.
//
// KİMLİK ÇAPASI KORUNUR: ilk sıradaki selfie en net yüz (analyzeReferences
// bestIndex) ve kimlik sadakatinde en ağır basan kare. Yer değiştirmek
// ancak yön kazancı belirginse (POSE_SWAP_MIN_GAIN) yapılır; çapa ikinci
// sıraya iner, atılmaz.
const POSE_SWAP_MIN_GAIN = 0.15;

/**
 * SAF. refYaws[i]: i. selfie'nin yaw'ı (0 önden, 1 profil; null = ölçülemedi).
 * Döner: yeni sıra (indeks dizisi) ve gerekçe.
 */
function poseMatchedOrder(refYaws, templateYaw, minGain = POSE_SWAP_MIN_GAIN) {
  const n = Array.isArray(refYaws) ? refYaws.length : 0;
  const keep = { order: [...Array(n).keys()], swapped: false };
  if (n < 2 || templateYaw == null || refYaws[0] == null) return { ...keep, reason: "unmeasured" };
  let best = 0;
  for (let i = 1; i < n; i++) {
    if (refYaws[i] == null) continue;
    if (Math.abs(refYaws[i] - templateYaw) < Math.abs(refYaws[best] - templateYaw)) best = i;
  }
  const gain = Math.abs(refYaws[0] - templateYaw) - Math.abs(refYaws[best] - templateYaw);
  if (best === 0 || gain < minGain) return { ...keep, reason: "anchor-closest", gain };
  return { order: [best, ...keep.order.filter((i) => i !== best)], swapped: true, reason: null, gain };
}

// PROFİL SELFIE'LER DÜZ ŞABLONA GİTMEZ (2026-10-26, e25dc241, kullanıcı: "base
// foto ile aynı yöne bakmıyor... elemeden reddetmeden aynı olacak"). Selfie
// setinde tam profil çoğunluktayken (1.00,1.00,0.17,1.00,0.17) model düz
// şablonda başı profile doğru çekti: 6 düz karenin 6'sı ≥0.20, 5'i ≥0.35
// döndü; ikinci üretim de aynı yöne gitti. 18 günlük canlı log: profil selfie
// 0-1 iken düz şablonda ort |sapma| 0.09-0.11, 2+ iken 0.29. Sıralama (yukarı)
// yetmiyor — profil kareler listede kaldıkça poz onlardan geliyor. Şablon
// düz/yarı dönükken (yaw < POSE_FILTER_TPL_MAX) tam profil selfie'ler
// (≥ POSE_FILTER_PROFILE_MIN) modele verilmez; en az POSE_FILTER_MIN_KEEP
// selfie kalır (kimlik: 2 selfie ile 5 selfie arasında fark ölçülmedi,
// 2026-10-19 tekab A/B 0.548/0.544). Dönük şablonda dokunulmaz: orada dönük
// selfie'ler doğru pozu kurmaya yardım ediyor.
const POSE_FILTER_TPL_MAX = 0.5;
const POSE_FILTER_PROFILE_MIN = 0.8;
const POSE_FILTER_MIN_KEEP = 2;
// DÖNÜK ŞABLONDA DA FAZLA DÖNÜK SELFIE GİTMEZ (2026-10-28, 546b514b, kullanıcı:
// "kafa base foto gibi dönmeli, x ve y koordinatlarıyla birebir"). Selfie seti
// 0.86/0.03/0.41/1.00/1.00 iken üç çeyrek şablonların üçü de profile kaydı:
// c0 0.57→0.78, c9 0.78→0.97, c4 0.76→1.00 (ret). Şablondan bu kadar daha
// dönük selfie modele verilmez; aynı yöndeki/az dönük olanlar kalır.
const POSE_FILTER_OVER_MARGIN = 0.2;

/**
 * SAF. Modele verilecek selfie indeksleri (giriş sırasıyla) ve çıkarılanlar.
 * Ölçülemeyen (null) selfie tutulur.
 */
function poseFilteredRefs(refYaws, templateYaw) {
  const n = Array.isArray(refYaws) ? refYaws.length : 0;
  const all = [...Array(n).keys()];
  if (n <= POSE_FILTER_MIN_KEEP || templateYaw == null) return { keep: all, dropped: [], reason: "unmeasured" };
  const turned = templateYaw >= POSE_FILTER_TPL_MAX;
  const isProfile = turned
    ? (i) => refYaws[i] != null && refYaws[i] >= templateYaw + POSE_FILTER_OVER_MARGIN
    : (i) => refYaws[i] != null && refYaws[i] >= POSE_FILTER_PROFILE_MIN;
  const keep = all.filter((i) => !isProfile(i));
  if (keep.length === n) return { keep: all, dropped: [], reason: "no-profile" };
  // En az POSE_FILTER_MIN_KEEP: şablona en yakın profiller geri alınır.
  const back = all.filter(isProfile).sort((a, b) => Math.abs(refYaws[a] - templateYaw) - Math.abs(refYaws[b] - templateYaw));
  while (keep.length < POSE_FILTER_MIN_KEEP && back.length) keep.push(back.shift());
  keep.sort((a, b) => a - b);
  return { keep, dropped: all.filter((i) => !keep.includes(i)), reason: null };
}

// YALNIZ ŞABLONLA AYNI YÖNE BAKAN SELFIE GİDER (2026-10-30, c2e8eff1,
// kullanıcı: "yüz base ile tamamen aynı yere baksın; koordinatlarını al,
// selfieleri ona göre yerleştir"). İşaretli selfie yönleri [-0.01,-0.32,+0.39,
// -0.85,+0.87]; düz şablonlara ön + iki yarım selfie gitti ve beş düz şablonun
// beşinde de iki adayın ikisi de başı -0.30..-0.47'ye çevirdi; ön selfie de
// giden dönük şablonlar eksik döndü (0.97→0.63, -0.62→-0.40). Canlı 10-20..30,
// düz şablon: giden dönük (≥0.25) selfie 0 → ort |sapma| 0.05 (n=3), 1 → 0.12
// (n=2), 2 → 0.20 (n=11). Model başı modele verilen selfie'lerin açısına
// çekiyor; profil süzgeci (yukarıda) yarım dönükleri bırakıyordu. Artık işaretli
// yönü şablona POSE_MATCH_MAX'tan yakın selfie'ler gider. Ayna: selfie yatay
// çevrilince işaretli yön tersine döner (kutay seti: +0.78 → -0.83); karşı yana
// dönük selfie aynalanınca şablonla aynı yöne bakar (en çok
// POSE_MATCH_MIRROR_MAX tane; ayrılık çizgisi/ben yer değiştirir, kimlik
// için yön eşleşmesi az olanlara ek). Ön selfie aynalanmaz (bilgi katmaz).
const POSE_MATCH_MAX = 0.25;
const POSE_MATCH_KEEP_MAX = 3;
const POSE_MATCH_MIRROR_MAX = 1;
const POSE_MATCH_MIRROR_MIN_TURN = 0.15;

/**
 * SAF. signedYaws[i]: i. selfie'nin işaretli yönü (null = ölçülemedi);
 * tplSigned: şablonun işaretli yönü. Döner { keep: [{ i, mirror, yaw }],
 * reason } — keep sıralı (0. indeks kimlik çapası yakınsa başta, sonra
 * yöne yakınlık). Ölçü yoksa null (eski sıralama kullanılır).
 */
function poseMatchedRefSet(signedYaws, tplSigned) {
  if (tplSigned == null || !Number.isFinite(tplSigned) || !Array.isArray(signedYaws)) return null;
  const c = [];
  signedYaws.forEach((y, i) => {
    if (y == null || !Number.isFinite(y)) return;
    c.push({ i, mirror: false, yaw: y, d: Math.abs(y - tplSigned) });
    if (Math.abs(y) >= POSE_MATCH_MIRROR_MIN_TURN) c.push({ i, mirror: true, yaw: -y, d: Math.abs(-y - tplSigned) });
  });
  if (!c.length) return null;
  // Eşit uzaklıkta aynasız önce.
  c.sort((a, b) => a.d - b.d || a.mirror - b.mirror);
  const keep = [];
  let mirrors = 0;
  for (const x of c) {
    if (x.d > POSE_MATCH_MAX || keep.length >= POSE_MATCH_KEEP_MAX) break;
    if (keep.some((k) => k.i === x.i)) continue; // aynı selfie iki kez gitmez
    if (x.mirror && mirrors >= POSE_MATCH_MIRROR_MAX) continue;
    if (x.mirror) mirrors++;
    keep.push(x);
  }
  let reason = null;
  if (!keep.length) { keep.push(c[0]); reason = "closest-only"; }
  const a = keep.findIndex((k) => k.i === 0 && !k.mirror);
  if (a > 0) keep.unshift(keep.splice(a, 1)[0]);
  return { keep: keep.map(({ i, mirror, yaw }) => ({ i, mirror, yaw })), reason };
}

// 3B POZ PLANI (2026-10-31, 21e56b20, bkz. headPose3d.js): yukarıdaki kuralın
// derece karşılığı. Seçilen selfie'ler ayrıca base pozuna çevrilir; çevirme
// 12°'ye kadar temiz (bkz. headPose3d REPOSE_MAX_YAW). İlk selfie her zaman
// yöne en yakını (gerekirse kısmi çevrilir); ikincisi yalnız çok az
// çevrilecekse (POSE_PLAN_REACH_DEG). Aynalı en çok bir tane.
const POSE_PLAN_REACH_DEG = 8;
const POSE_PLAN_KEEP_MAX = 2;
const POSE_PLAN_MIRROR_MAX = 1;
const POSE_PLAN_MIRROR_MIN_DEG = 8;
// Kameraya doğru çevirme (gizli yanak açılır) bozulmaya daha açık: seçimde
// bu yöndeki fark bu katla sayılır (önden selfie'yi 15° dışa çevirmek, yarım
// selfie'yi 11° içe çevirmekten temiz).
const POSE_PLAN_TOWARD_COST = 1.5;
// Pitch: çevirme 25°'ye kadar (bkz. headPose3d REPOSE_MAX_PITCH); fazlası
// kapanamayan fark olarak maliyete eklenir (21e c7: şablon −30° aşağı bakıyor,
// +11° yukarı bakan selfie −12°'de kalıyordu; −5°'lik tam profil −30°'ye iner).
const POSE_PLAN_PITCH_REACH = 25;
// Yüz ağı tutmayan selfie (güçlü profil; yaw 68 noktadan) çevrilemez: pitch'i
// bilinmez (0 sayılır) ve bu kadar ek maliyet alır.
const POSE_PLAN_NO_MESH_COST = 10;

/**
 * SAF. yawsDeg[i]: i. selfie'nin yaw'ı (derece, null = ölçülemedi); tplDeg:
 * şablonun yaw'ı. Döner { keep: [{ i, mirror, yaw }], reason } ya da null.
 * Sıra: kimlik çapası (0.) seçildiyse başta, sonra yöne yakınlık.
 */
function poseRefPlanDeg(yawsDeg, tplDeg, { pitches = null, tplPitch = null, noMesh = null } = {}) {
  if (tplDeg == null || !Number.isFinite(tplDeg) || !Array.isArray(yawsDeg)) return null;
  const c = [];
  yawsDeg.forEach((y, i) => {
    if (y == null || !Number.isFinite(y)) return;
    const sp = pitches && pitches[i] != null && Number.isFinite(pitches[i]) ? pitches[i] : 0;
    const pitchExcess = (tplPitch != null && Number.isFinite(tplPitch) ? Math.max(0, Math.abs(tplPitch - sp) - POSE_PLAN_PITCH_REACH) : 0) +
      (noMesh && noMesh[i] ? POSE_PLAN_NO_MESH_COST : 0);
    const cost = (s) => {
      const d = Math.abs(s - tplDeg);
      const toward = Math.abs(tplDeg) < Math.abs(s) && Math.sign(tplDeg - s) === -Math.sign(s);
      return (toward ? d * POSE_PLAN_TOWARD_COST : d) + pitchExcess;
    };
    c.push({ i, mirror: false, yaw: y, d: cost(y) });
    if (Math.abs(y) >= POSE_PLAN_MIRROR_MIN_DEG) c.push({ i, mirror: true, yaw: -y, d: cost(-y) });
  });
  if (!c.length) return null;
  c.sort((a, b) => a.d - b.d || a.mirror - b.mirror);
  const keep = [c[0]];
  let mirrors = c[0].mirror ? 1 : 0;
  for (const x of c.slice(1)) {
    if (x.d > POSE_PLAN_REACH_DEG || keep.length >= POSE_PLAN_KEEP_MAX) break;
    if (keep.some((k) => k.i === x.i)) continue;
    if (x.mirror && mirrors >= POSE_PLAN_MIRROR_MAX) continue;
    if (x.mirror) mirrors++;
    keep.push(x);
  }
  const reason = keep.length === 1 ? "single" : null;
  const a = keep.findIndex((k) => k.i === 0 && !k.mirror);
  if (a > 0) keep.unshift(keep.splice(a, 1)[0]);
  return { keep: keep.map(({ i, mirror, yaw }) => ({ i, mirror, yaw })), reason };
}

/**
 * 5 AÇILI SETTE YAN PROFİL VAR MI (2026-10-30, 922f1371): selfie'lerin
 * işaretli yönü [0.09,0.02,0.06,0.00,0.23] (hepsi cepheye yakın) geldi; yana
 * dönük şablonlarda model profil referansı görmeden kafayı yanlış çevirdi —
 * 5 retten 4'ü yön kapısından. Doğru çekilmiş sette tam sağ/sol +1.00/−1.00.
 * YALNIZ HİÇ DÖNÜK KARE YOKSA ret: 2026-10-05..30 arası 46 setin selfie
 * yönleri ölçüldü; "iki yanda da ≥0.6" şartı setlerin yaklaşık yarısını
 * durdururdu (ör. 0.21/0.33/0.00/0.14/0.43), en çok dönmüş karesi 0.35'in
 * altında kalan tek set 922f1371 (0.23; sonrakiler 0.42, 0.43).
 * Ölçülemeyen kare (null) değerlendirmeye girmez; üçten az ölçü varsa ret
 * yok (FAIL-OPEN). signedYaws: kare başına işaretli yön ya da null.
 * Döner { ok, maxTurn, missing: ["sides"] }. SAF.
 */
const SELFIE_SIDE_MIN = 0.35;
function selfieSideCoverage(signedYaws) {
  const vals = (signedYaws || []).filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 3) return { ok: true, maxTurn: null, missing: [], reason: "unmeasured" };
  const maxTurn = Math.max(...vals.map((v) => Math.abs(v)));
  const ok = maxTurn >= SELFIE_SIDE_MIN;
  return { ok, maxTurn, missing: ok ? [] : ["sides"], reason: null };
}

module.exports = {
  selfieSideCoverage,
  SELFIE_SIDE_MIN,
  poseMatchedOrder,
  POSE_SWAP_MIN_GAIN,
  poseFilteredRefs,
  poseMatchedRefSet,
  POSE_MATCH_MAX,
  poseRefPlanDeg,
  POSE_PLAN_REACH_DEG,
  POSE_FILTER_TPL_MAX,
  POSE_FILTER_PROFILE_MIN,
  parseGazeToken,
  gazeDirection,
  isGazeMismatch,
  irisOffsetFromGray,
  isIrisGazeMismatch,
  isIrisGazeOpposite,
  GAZE_TOKENS,
  IRIS_MISMATCH_X,
  IRIS_MISMATCH_Y,
  IRIS_MIN_EYE_PX,
};
