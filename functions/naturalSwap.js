// DOĞAL YER DEĞİŞTİRME — yeni çekirdek (2026-11-01, kullanıcı: "aylarca
// süren tüm commitlerimi incele, tekte en iyi çıktıları üreten yapıyı en
// baştan kur; tek istediğim base fotoyu selfie ile doğal bir şekilde yer
// değiştirmek").
//
// GEÇMİŞTEN ÇIKAN KARAR (362 commit, 07-10 → 10-21, + 10-21 sonrası commit'siz iş):
// - En iyi sonuç en sade kurulumdan geldi: 07-24 doğrudan OpenAI images/edits,
//   gerçek taban + gerçek kullanıcı fotoğrafı, kısa talimat → "koyu tenden açık
//   tona tutarlı dönüşüm, arka plan/poz/kıyafet neredeyse birebir" (38e16f6);
//   kullanıcının ChatGPT'ye 2 fotoğraf + tek cümleyle yaptığı test "çok iyi"
//   (8abb5ec: "Replace the person in the first photo with the person in the
//   second photo … keep everything else exactly the same … don't add a smile").
// - Sonraki 3 ayda prompt 2900 kelimeye kadar büyüdü; her yeni cümle bir
//   belirtiyle savaştı. Model bu kuralların çoğuna uymadı: "selfie'nin açısını,
//   bakışını, ifadesini alma" haftalarca yazdı ama model GİDEN SELFIE'NİN
//   pozunu, bakışını, kapağını ve gülüşünü kopyaladı (21e56b20, 831a00a4).
// - İşe yarayan tek yön kontrolü bu davranışı kullanmak oldu: selfie base
//   pozuna çevrilince 10/10 karede |Δyaw| ≤ 2° (831a00a4; önce 15-25°).
//
// BU YÜZDEN ÇEKİRDEK:
// 1) Modele giden referans, base'in baş açısı + yan yatıklığı + bakışı + göz
//    açıklığı + ağız köşesiyle hazırlanır (headPose3d.reposeFace +
//    refMatch.matchRefToBase). Kimlik dokusu selfie'nin kendisi; yalnız
//    geometri.
// 2) Talimat elle yapılan testin çerçevesi: "birinci fotoğraftaki kişiyi
//    ötekiyle değiştir, gerisi aynen". Modelle savaşmak yerine davranışına
//    uyar: referans zaten doğru açıda/bakışta olduğu için "yüzü referansta
//    göründüğü gibi kopyala" der. Kimlik ve saç listeleri eski metinden
//    (629b45de: bunları kısaltmak yüz yapısını ve saçı bozmuştu).
// 3) Referans hazırlanamadıysa (şablon/selfie ölçülemedi) eski P800 kullanılır —
//    o durumda referans base açısında değildir, "kopyala" demek yanlış olur.
//
// Değişmeyenler (ölçülmüş, tekrarlayan model sapmalarını düzeltir, her biri
// kullanıcı isteğiyle eklendi): küçük yüzlü şablonu yakınlaştırma, PNG→JPEG,
// kapılar, son adımlar (şablon izi, kafa bükme, yüz ışığı, ağız köşesi, göz
// açıklığı, yüz detayı, siyah-beyaz, gözlük, ışıklı, telefon dokusu).

// 2026-11-03 TÜM SELFIE SETİ (kullanıcı: "5'ini de gönderelim; baş açısı,
// yatıklık, bakış, göz açıklığı ve ifadeyi promptta veriyoruz; selfie'deki
// ışık/gölge çıktıya yansımasın, ten net olsun; somurtma ya da gülümseme
// olmasın, selfie'deki gibi doğal"). Referanslar artık base'e hazırlanmıyor
// (yalnız ışığı eşitleniyor, bkz. selfieLight.js): "yüzü referanstaki gibi
// kopyala" yanlış olur. Selfie'ler yalnız KİMLİK kaynağı; baş, bakış ve ışık
// base'den. Yön cümlesi başta DEĞİL (bkz. gaze-tell-direction-upfront: başa
// yazılan yön cümlesi şapka/gözlüğü sildirmişti).
//
// 2026-11-06 ŞAPKALI ŞABLON (hat=true, bkz. hatDetect.js): model şablonun
// şapkasını düşürüyordu (6 karede 1 kaldı, bu promptta 3/3 düştü; ikisinde
// yarı saydam şapka izi, birinde kep logosu alında). Sebep promptun kendisi:
// "ilk kişinin saç modelinden hiçbir şey kalmasın" + "ilk kişinin saçının
// uzandığı yere arka planı sürdür" — şapka çizgisi eski kafa çizgisi, şapka
// ise listenin son maddesiydi. Şapkalı şablonda saç cümlesine yerinde (başa
// DEĞİL) şapka cümlesi eklenir, arka plan cümlesi yalnız açık saça uygulanır.
// hat=false (şapkasız şablonların hepsi) → metin bugünküyle bayt bayt aynı.
/**
 * BASE POZU SAYIYLA (2026-11-08, kullanıcı: "base fotonun dönüş açısını, çene
 * yerini matematiksel olarak alıp prompta verelim"). pose: { yaw (>0 yüz
 * görüntünün sağına), pitch (>0 yukarı, null olabilir), roll (>0 başın tepesi
 * görüntünün soluna, null olabilir), chinX, chinY, faceW (görüntüye oran) }.
 * Yönler görüntüye göre yazılır (kişinin sağı/solu karışmasın). Başa DEĞİL baş
 * açısı paragrafına girer (hafıza gaze-tell-direction-upfront). Ölçü yoksa "". SAF.
 */
// EĞİK BAŞ (2026-11-12, kullanıcı onaylı ücretli test, 11-12 işinin girdileriyle birebir):
// model aşağı bakan şablonda başı selfie setinin düzlüğüne çekiyordu (424 çift: çıktı ≈
// +3.4 + 0.38·şablon; "tilted down about N°, chin lowered" hiçbir şey değiştirmedi). Bu
// eşiğin altında baş görünür biçimde tarif edilir + selfie düzlüğü ve "baş değil göz
// hareket eder" söylenir. c2 (−29.7): eski −14.3 → −22.2 (3 koşu); c9 (−20.7, gözü
// kameraya kaldırıyor): +1.3 → −6.8, bakış 2/3 doğru. "Eyelids … fall" kapak cümlesi
// (varyant B) c9'da gözü aşağı indirdi → alınmadı. Eşiğin üstünde metin bayt bayt aynı.
// EŞİK 12 → 24 (2026-11-13, canlı iş e67abb0e, kullanıcı: "c5 ve c9 durduk yere aşağı
// bakmış, eski onay güzeldi"): −12 eşiği c5'i (−13.6, pencereye yana bakıyor) ve c9'u
// (−20.7, çene hafif aşağı ama gözler KAMERADA) da eğik tarife soktu; ikisinde baş ve
// gözler aşağı indi, c9 kimlikten elendi. 32 farklı şablonda (pitch ≤ −12) baş kırpımı
// incelendi: ≤ −24'teki 10 şablonun 10'u da baş+göz aşağı; −21..−13 karışık (kameraya
// bakanlar −20.8/−19/−17.3/−15.4/−14.6). −24, kameraya bakan en eğik şablondan (c9) 3°
// pay bırakır; c2 (−29.7) içinde kalır. c5/c9 promptu yine 11-12 öncesiyle bayt bayt aynı.
// BOYUN (2026-11-13, kullanıcı: "c2'de kafa gövdeye gömülmüş, boyun gözükmüyor; uzun
// boylunun boynu uzun olur"): "chin is tucked in toward the neck and collar" başı döndürmek
// yerine AŞAĞI KAYDIRIYORDU — ham çıktıda göz hizası şablona göre eğiksiz işlerde
// −0.06/+0.01/+0.01, eğikli e67abb0e +0.19, 79956cb2 +0.29 yüz boyu (çene 0.497→0.521).
// Yaka cümlesi çıktı; baş boynun tepesinde öne döner, tepe/göz/kulak aynı yükseklikte,
// boyun şablondaki kadar görünür.
const BOWED_PITCH_DEG = 24;

// SADE PROMPT (2026-11-19, kullanıcı: "komple sistemi incele, fazlalıkları çıkar, promptta gereksiz
// yerleri kaldır"). Denetim (scratchpad simp/): sayısal poz (yaw/pitch/roll, çene %, yüz eni,
// "exactly these angles... this size") 11-12 (424 çift) ve 11-16'da etkisiz ölçüldü, çıktı açısı
// selfie setinden geliyor; uzun boy boyun paragrafı kısa boyda boynu uzattı (11-17); YAW_FIX ve
// şapka ikinci üretim metinleri ikinci üretimlerle birlikte kaldırıldı; "(the BASE)" etiketi yalnız
// ölü yeniden deneme öneklerine hizmet ediyordu; uzun "bunları selfie'den alma" listesine model
// uymuyordu (natural-swap-core). Kalan tek koşullu metinler: şapka cümlesi ve EĞİK BAŞ bloğu —
// eğik baş, ücretli A/B'si olan tek prompt parçası (c2 −14 → −22..−28), sözcükleri aynen korunur.
function describeBowed(pose) {
  if (!pose || !Number.isFinite(pose.pitch) || pose.pitch > -BOWED_PITCH_DEG) return "";
  return ` Measured in the first photo: the head is bowed forward and down about ${Math.round(Math.abs(pose.pitch))}°, ` +
    "tipping forward at the top of the neck: the face is seen from slightly above, so the forehead and the top of the " +
    "head take more of the face and the nose points down past the mouth; the underside of the chin and the nostrils are hidden." +
    " The selfies were all taken with the head level; this head stays bowed exactly this much." +
    " Match the eye direction by moving the eyes only, never by raising, lifting or straightening the head." +
    " The head tips forward without sinking: the top of the head, the eyes and the ears stay at the same height" +
    " in the picture as the first person's, and the neck between the jaw and the collar stays as long and as" +
    " visible as it is in the first photo.";
}

const NECK_SENTENCE_DEFAULT = " The new head sits exactly where the old head was, on the same neck and no larger against the shoulders.";

// GÖZLÜKLÜ ŞABLON BAKIŞI (2026-11-20, kullanıcı: "gözlüklü fotolarda base'de gözün nereye baktığını
// göremediğimiz için gözler saçma yere bakıyor; iris tam ortada kalsın"). 8ac66d45 c0/c2/c9: koyu camın
// arkasındaki bakışı model tahmin ediyor, yüzle ilgisiz yana bakış çiziyor. Şablonda göz çevresi gözlük
// payı ≥ gazeGate.IRIS_TPL_GLASS_SKIP (bakış kapısının da sustuğu eşik) ise "baktığı yere bak" yerine
// yüzün yönünde, iris göz açıklığının ortasında. Başa DEĞİL bakış cümlesinin yerine (gaze-tell-direction-upfront).
const GAZE_SENTENCE_DEFAULT = "The new head keeps the first person's head angle and tilt, and the eyes look exactly where the " +
  "first person's eyes look.";
const GAZE_SENTENCE_EYEWEAR = "The new head keeps the first person's head angle and tilt. The first person's eyes are " +
  "hidden behind their glasses, so do not guess where they look: the new eyes look straight ahead in the direction " +
  "the face points, each iris centred in the eye opening.";

function buildSelfieSetPrompt(refCount, { hat = false, pose = null, eyewear = false } = {}) {
  const other = refCount > 1 ? `the other ${refCount} photos` : "the second photo";
  const hatLine = hat
    ? " If the first person wears a hat, cap or beanie, the new person wears that same one, exactly where " +
      "and as large as it is; only the hair that shows below it comes from them."
    : "";
  const bare = hat ? "bare " : "";
  return (
    `Replace the person in the first photo with the person shown in ${other}, so that the ` +
    "first photo looks as if it had simply been taken of them: an ordinary, unedited phone photo, not a " +
    `face swap or composite. Use ${other} only to see who this person is: their face, features, skin tone and hair.` +
    "\n\n" + (eyewear ? GAZE_SENTENCE_EYEWEAR : GAZE_SENTENCE_DEFAULT) + describeBowed(pose) + " A relaxed, neutral, natural expression: lips " +
    "relaxed, no smile, no frown, no pout. Eyes naturally open, neither wide nor sleepy." +
    "\n\nIdentity: copy the person feature by feature: eyes, eyebrows, nose, lips, jaw, chin, " +
    "cheekbones, face outline and length-to-width ratio. Do not beautify, symmetrise, average, round, " +
    "puff, widen or stretch. Keep moles, freckles, scars and facial hair. Their hairline, hair length, " +
    "density, texture and colour come from them, never from the first person and never invented; keep " +
    "nothing of the first person's hairstyle. Bald or balding stays so." + hatLine +
    "\n\nLight the face with the same light that falls on the body in the first photo. Their skin tone is " +
    "even and the same on the face, ears, neck, arms and hands." +
    "\n\nKeep everything else in the first photo exactly as it is: background, framing, camera angle, " +
    "body pose and build, hand positions, clothing, accessories and any hat or cap." + NECK_SENTENCE_DEFAULT +
    "\n\nRemove glasses or sunglasses worn on the face, earphones and tattoos. Where the first person's " +
    `${bare}hair reached further than the new hair, continue the background there, solid, with no outline or ` +
    "ghost. Natural skin texture, as sharp as the rest of the photo; no retouching, smoothing or glow."
  );
}

/**
 * Doğal yer değiştirme talimatı. refCount: modele giden referans sayısı.
 * prepared=true: referans base'e hazırlanmış (11-01 yolu, "referanstaki gibi
 * kopyala"); false: ham selfie seti (buildSelfieSetPrompt). hat: şablonda
 * şapka var (hatDetect.detectTemplateHat; yalnız selfie seti yolunda). SAF.
 */
// Eski seçenekler (light, tallNeck, hatFix) kabul edilir ve yok sayılır: eski çağrılar düşmesin.
function buildNaturalSwapPrompt(refCount = 1, { prepared = true, hat = false, pose = null, eyewear = false } = {}) {
  if (!prepared) return buildSelfieSetPrompt(refCount, { hat, pose, eyewear });
  const other = refCount > 1 ? "the other photos" : "the second photo";
  const them = refCount > 1 ? "They show" : "It shows";
  return (
    `Replace the person in the first photo (the BASE) with the person in ${other}, so that the first photo ` +
    "looks as if it had simply been taken of them: an ordinary, unedited phone photo, not a face swap " +
    "or composite." +
    `\n\n${them} this person already turned, tilted and looking exactly as the first photo needs, with ` +
    "the right eyelids and mouth. Copy the face as it appears there: the same head angle, tilt, eye " +
    "direction, eyelids and expression. Do not add a smile, do not open or close the eyes more, and do " +
    "not turn the head toward the camera." +
    "\n\nIdentity: copy the person feature by feature: eyes, eyebrows, nose, lips, jaw, chin, " +
    "cheekbones, face outline and length-to-width ratio. Do not beautify, symmetrise, average, round, " +
    "puff, widen or stretch. Keep moles, freckles, scars and facial hair. Their hairline, hair length, " +
    "density, texture and colour come from them, never from the first person and never invented; keep " +
    "nothing of the first person's hairstyle. Bald or balding stays so. Their skin tone goes on the " +
    "face, ears, neck, arms and hands alike." +
    "\n\nKeep everything else in the first photo exactly as it is: background, framing, camera angle, " +
    "body pose and build, hand positions, clothing, accessories and any hat or cap. The new head sits " +
    "exactly where the old head was, on the same neck and no larger against the shoulders. Light the " +
    "face with the same light that falls on the body in the first photo." +
    "\n\nRemove glasses or sunglasses worn on the face, earphones and tattoos. Where the first person's " +
    "hair reached further than the new hair, continue the background there, solid, with no outline or " +
    "ghost. Natural skin texture, as sharp as the rest of the photo; no retouching, smoothing or glow."
  );
}

module.exports = { buildNaturalSwapPrompt, _testables: { NECK_SENTENCE_DEFAULT, BOWED_PITCH_DEG, describeBowed, GAZE_SENTENCE_DEFAULT, GAZE_SENTENCE_EYEWEAR } };
