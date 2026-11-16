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

function describeBasePose(pose) {
  if (!pose || !Number.isFinite(pose.yaw)) return "";
  const deg = (v) => Math.round(Math.abs(v));
  const pct = (v) => Math.round(v * 100);
  const parts = [];
  parts.push(Math.abs(pose.yaw) < 4
    ? "the face is turned straight to the camera"
    : `the face is turned about ${deg(pose.yaw)}° toward the ${pose.yaw > 0 ? "right" : "left"} side of the picture (0° would be facing the camera)`);
  if (Number.isFinite(pose.pitch)) {
    parts.push(Math.abs(pose.pitch) < 4
      ? "the head is level, neither tilted up nor down"
      : pose.pitch <= -BOWED_PITCH_DEG
        ? `the head is bowed forward and down about ${deg(pose.pitch)}°, tipping forward at the top of the neck: ` +
          "the face is seen from slightly above, so the forehead and the top of the head take more of the face and the nose " +
          "points down past the mouth; the underside of the chin and the nostrils are hidden"
      : pose.pitch < 0
        ? `the head is tilted down about ${deg(pose.pitch)}°, chin lowered`
        : `the head is tilted up about ${deg(pose.pitch)}°, chin raised`);
  }
  if (Number.isFinite(pose.roll)) {
    parts.push(Math.abs(pose.roll) < 3
      ? "the head is upright"
      : `the head leans about ${deg(pose.roll)}°, the top of the head toward the ${pose.roll > 0 ? "left" : "right"} side of the picture`);
  }
  let s = ` Measured in the first photo: ${parts.join("; ")}.`;
  if ([pose.chinX, pose.chinY, pose.faceW].every(Number.isFinite)) {
    s += ` The tip of the chin is ${pct(pose.chinX)}% of the way from the left edge and ${pct(pose.chinY)}% of the way ` +
      `from the top, and the face spans about ${pct(pose.faceW)}% of the picture's width.`;
  }
  s += " The new head has exactly these angles, this chin position and this size, whatever angles the other photos show.";
  // YÖN DÜZELTMESİ (2026-11-14, kullanıcı kararı; 43c2e739 c3 iki üretimde de 13°/18° fazla döndü,
  // ikinci üretim aynı promptla kör tekrardı). Yalnız ilk kare 3B kapıdan ZATEN elenecekken yapılan
  // ikinci üretimde; ölçülen fazla dönüş ve yönü poz paragrafının içinde (prompt başında değil —
  // 10-18 şapka/gözlük kaybı). 10-19'daki prompt SONU cümlesi yatıklığı bozmuştu → "yalnız dönüş".
  if (pose.yawFix && Number.isFinite(pose.yawFix.over) && pose.yawFix.over > 0 && (pose.yawFix.side === "left" || pose.yawFix.side === "right")) {
    s += ` In an earlier attempt the face came out turned about ${deg(pose.yawFix.over)}° too far toward the ${pose.yawFix.side} ` +
      "side of the picture. Turn it back to exactly the angle measured above; only the turn changes, the lean, the tilt " +
      "and the position of the head stay as described.";
  }
  if (Number.isFinite(pose.pitch) && pose.pitch <= -BOWED_PITCH_DEG) {
    s += " The selfies were all taken with the head level; this head stays bowed exactly this much." +
      " Match the eye direction by moving the eyes only, never by raising, lifting or straightening the head." +
      " The head tips forward without sinking: the top of the head, the eyes and the ears stay at the same height" +
      " in the picture as the first person's, and the neck between the jaw and the collar stays as long and as" +
      " visible as it is in the first photo.";
  }
  return s;
}

// ŞABLONA KOŞULLU IŞIK YÖNÜ (2026-11-13, kullanıcı: "doğal, hatları belirgin, ortama uygun ışık").
// Yalnız şablon yüz derisinde ölçülen yatay ışık eğimi |gu| ≥ LIGHT_SIDE_MIN_GU (faceTone.skinStats,
// log parlaklık / yüz eni; faceTone.SIDE_LIGHT ile aynı eşik) olan karede "Light and skin"
// paragrafına tek cümle. Yön RESMİN kenarına göre (describeBasePose gibi). Eşik altında metin
// byte byte aynı. 10-28'deki GENEL ışık cümlesi dağınık sonuç vermişti; bu ölçülmüş ve kareye özel.
const LIGHT_SIDE_MIN_GU = 1.0;
function describeTemplateLight(light) {
  if (!light || !Number.isFinite(light.gu) || Math.abs(light.gu) < LIGHT_SIDE_MIN_GU) return "";
  const lit = light.gu < 0 ? "left" : "right", dark = light.gu < 0 ? "right" : "left";
  return ` In the first photo this light comes from the ${lit} of the picture: the side of the face toward ` +
    `the ${lit} edge of the picture is lit and the side toward the ${dark} edge falls into soft shadow, ` +
    "shaping the cheekbone, nose and jaw. The new face has the same light and shadow on the same sides.";
}

// BAŞ VE BOYUN (2026-11-15, kullanıcı: "boyun içe kaçmayacak, kafa önde durmayacak, boyun ortada,
// kafa geride ve dik duracak"). 7 iş × 10 ham karede çene 24/70 karede ≥0.10 yüz boyu aşağıda
// (yarısı kafa büyümesi, yarısı aşağı kayma; c2 0.29, c6 0.23 boyun yok). Eski tek cümle ("on the
// same neck and no larger") yerine ayrı paragraf. "collar" BİLEREK yok: 11-13'te yaka cümlesi başı
// aşağı kaydırdı. Eğik başlı şablonda (BOWED_PITCH_DEG) dik başı istemek eğimle çelişir: orada
// boyun dik, baş yalnız boynun tepesinde öne eğik.
function describeHeadAndNeck(pose) {
  const bowed = pose && Number.isFinite(pose.pitch) && pose.pitch <= -BOWED_PITCH_DEG;
  return "\n\nHead and neck: the neck stands upright and shows clearly between the jaw and the shoulders, " +
    "just as long and as visible as the first person's neck. The head is not sunk into the shoulders, not " +
    "pushed forward and not dropped lower in the picture; " +
    (bowed
      ? "it sits back on top of the upright neck, exactly where the old head was, and bows only at the top of the neck as described above."
      : "it sits back and upright on top of the neck, exactly where the old head was.") +
    " The chin stays as high as the first person's chin, and the head is no larger against the shoulders.";
}

function buildSelfieSetPrompt(refCount, { hat = false, pose = null, light = null } = {}) {
  const other = refCount > 1 ? `the other ${refCount} photos` : "the second photo";
  const them = refCount > 1 ? "These photos" : "That photo";
  const hatLine = hat
    ? " If the first person wears a hat, cap or beanie, the new person wears that same one, exactly where " +
      "and as large as it is; only the hair that shows below it comes from them."
    : "";
  const bare = hat ? "bare " : "";
  return (
    `Replace the person in the first photo (the BASE) with the person shown in ${other}, so that the ` +
    "first photo looks as if it had simply been taken of them: an ordinary, unedited phone photo, not a " +
    "face swap or composite." +
    `\n\n${them} only show who this person is: their face, features, skin tone and hair, from several ` +
    "angles. Take nothing else from them: not the head angle, tilt or eye direction, not the expression, " +
    "and not the light, shadows or colour cast on the face; those belong to the moment those photos were " +
    "taken, not to the person." +
    "\n\nThe new head keeps the first person's head angle and tilt, and the eyes look exactly where the " +
    "first person's eyes look." + describeBasePose(pose) + " A relaxed, neutral, natural expression, as in a casual photo of them: lips " +
    "relaxed, no smile, no frown, no pout. Eyes naturally open, neither wide nor sleepy." +
    "\n\nIdentity: copy the person feature by feature: eyes, eyebrows, nose, lips, jaw, chin, " +
    "cheekbones, face outline and length-to-width ratio. Do not beautify, symmetrise, average, round, " +
    "puff, widen or stretch. Keep moles, freckles, scars and facial hair. Their hairline, hair length, " +
    "density, texture and colour come from them, never from the first person and never invented; keep " +
    "nothing of the first person's hairstyle. Bald or balding stays so." + hatLine +
    "\n\nLight and skin: light the face only with the light of the first photo, the same light that " +
    "falls on the body there." + describeTemplateLight(light) + " Their skin tone is even and clean, the same on the face, ears, neck, arms " +
    "and hands, with no patch of sunlight or shadow carried over from the other photos." +
    "\n\nKeep everything else in the first photo exactly as it is: background, framing, camera angle, " +
    "body pose and build, hand positions, clothing, accessories and any hat or cap." +
    describeHeadAndNeck(pose) +
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
function buildNaturalSwapPrompt(refCount = 1, { prepared = true, hat = false, pose = null, light = null } = {}) {
  if (!prepared) return buildSelfieSetPrompt(refCount, { hat, pose, light });
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

module.exports = { buildNaturalSwapPrompt, _testables: { BOWED_PITCH_DEG, describeBasePose, LIGHT_SIDE_MIN_GU, describeTemplateLight, describeHeadAndNeck } };
