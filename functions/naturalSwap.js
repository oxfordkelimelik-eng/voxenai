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
function buildSelfieSetPrompt(refCount) {
  const other = refCount > 1 ? `the other ${refCount} photos` : "the second photo";
  const them = refCount > 1 ? "These photos" : "That photo";
  return (
    `Replace the person in the first photo (the BASE) with the person shown in ${other}, so that the ` +
    "first photo looks as if it had simply been taken of them: an ordinary, unedited phone photo, not a " +
    "face swap or composite." +
    `\n\n${them} only show who this person is: their face, features, skin tone and hair, from several ` +
    "angles. Take nothing else from them: not the head angle, tilt or eye direction, not the expression, " +
    "and not the light, shadows or colour cast on the face; those belong to the moment those photos were " +
    "taken, not to the person." +
    "\n\nThe new head keeps the first person's head angle and tilt, and the eyes look exactly where the " +
    "first person's eyes look. A relaxed, neutral, natural expression, as in a casual photo of them: lips " +
    "relaxed, no smile, no frown, no pout. Eyes naturally open, neither wide nor sleepy." +
    "\n\nIdentity: copy the person feature by feature: eyes, eyebrows, nose, lips, jaw, chin, " +
    "cheekbones, face outline and length-to-width ratio. Do not beautify, symmetrise, average, round, " +
    "puff, widen or stretch. Keep moles, freckles, scars and facial hair. Their hairline, hair length, " +
    "density, texture and colour come from them, never from the first person and never invented; keep " +
    "nothing of the first person's hairstyle. Bald or balding stays so." +
    "\n\nLight and skin: light the face only with the light of the first photo, the same light that " +
    "falls on the body there. Their skin tone is even and clean, the same on the face, ears, neck, arms " +
    "and hands, with no patch of sunlight or shadow carried over from the other photos." +
    "\n\nKeep everything else in the first photo exactly as it is: background, framing, camera angle, " +
    "body pose and build, hand positions, clothing, accessories and any hat or cap. The new head sits " +
    "exactly where the old head was, on the same neck and no larger against the shoulders." +
    "\n\nRemove glasses or sunglasses worn on the face, earphones and tattoos. Where the first person's " +
    "hair reached further than the new hair, continue the background there, solid, with no outline or " +
    "ghost. Natural skin texture, as sharp as the rest of the photo; no retouching, smoothing or glow."
  );
}

/**
 * Doğal yer değiştirme talimatı. refCount: modele giden referans sayısı.
 * prepared=true: referans base'e hazırlanmış (11-01 yolu, "referanstaki gibi
 * kopyala"); false: ham selfie seti (buildSelfieSetPrompt). SAF.
 */
function buildNaturalSwapPrompt(refCount = 1, { prepared = true } = {}) {
  if (!prepared) return buildSelfieSetPrompt(refCount);
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

module.exports = { buildNaturalSwapPrompt };
