// HEAD_VS_BODY sayısal kapı.
//
// Vision satırı (HEAD_VS_BODY: ALIGNED | PULLED_TO_CAMERA) 10/10 karede
// ALIGNED damgası vurduğu için bağlayıcı değil. Karar burada: şablon yaw'ı
// okunamıyorsa (kahve yürüyüşü — yüz küçük / gözlük, f94c3cec c3) ve çıktı
// yüzü merceğe dönükse kafa gövdeden koparılıp kameraya çekilmiş sayılır.
//
// 0 = tam önden, 1 = tam profil. Kahve çıktısı 0.47 reddedilir; aynı sahnede
// tarihi 0.62 (daha profil) geçer. Şablon yaw'ı varsa bu kural susar —
// ceket / kask / Citi / telefon mevcut yaw kurallarına kalır.

const PULLED_NO_TEMPLATE_OUTPUT_MAX = 0.52;

function isPulledToCameraNumeric(templateYaw, outYaw) {
  if (outYaw == null) return false;
  if (templateYaw == null) return outYaw < PULLED_NO_TEMPLATE_OUTPUT_MAX;
  return false;
}

module.exports = {
  isPulledToCameraNumeric,
  PULLED_NO_TEMPLATE_OUTPUT_MAX,
};
