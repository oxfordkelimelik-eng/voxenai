// HEAD_VS_BODY / profil yaw kuralları.
//
// Vision satırı (HEAD_VS_BODY: ALIGNED | PULLED_TO_CAMERA) 10/10 karede
// ALIGNED damgası vurduğu için bağlayıcı değil.
//
// isPulledToCameraNumeric — 2026-09-07 GERİ ALINDI (b1d6972b):
// Şablon yaw'ı yokken "çıktı önde ⇒ kameraya çekilmiş" kuralı kahve
// yürüyüşünü (0.47) yakalıyordu AMA aynı kural smokin (0.08) ve sahil
// (0.02) karelerini de kesti. Kullanıcı ikisini de gözle iyi gördü.
// Şablon pozunu bilmeden önden bakışın yanlış olduğunu söyleyemeyiz:
// taban da öndeyse çıktının önde olması DOĞRU. Fail-safe: şablon yoksa
// bu kural susar. Kahve yürüyüşü ancak şablon yaw'ı okunursa yaw-to-camera
// ile, ya da Vision bir kez PULLED derse vision-pulled-to-camera ile elenir.
//
// isUnderRotated — profil tabanı bitmemiş dönüş (b1d6972b c1 ve c7):
// şablon tam profil (≥0.95), çıktı en az 0.12 daha cephe. c1: 1.00→0.77,
// c7: 1.00→0.87. Teslim edilen c4 (0.88→0.71) şablon 0.95'in altında
// kaldığı için susar.

const YAW_UNDER_ROTATE_TEMPLATE_MIN = 0.95;
const YAW_UNDER_ROTATE_DROP_MIN = 0.12;
// İKİNCİ KADEME (2026-10-16, 6dd26e3e c4, kullanıcı: "base kafasını sola tam
// döndürmüş, çıktıda tam dönmemiş"): şablon 0.90, çıktı 0.63 (−0.27). Neredeyse
// profil şablonda daha büyük kayıp istenir — teslim c4 (0.88→0.71, −0.17)
// kabul edilmişti, geçmeye devam eder.
const YAW_UNDER_ROTATE_NEAR_TEMPLATE_MIN = 0.85;
const YAW_UNDER_ROTATE_NEAR_DROP_MIN = 0.2;

function isPulledToCameraNumeric(templateYaw, outYaw) {
  if (outYaw == null || templateYaw == null) return false;
  return false;
}

function isUnderRotated(templateYaw, outYaw) {
  if (templateYaw == null || outYaw == null) return false;
  const drop = templateYaw - outYaw;
  return (templateYaw >= YAW_UNDER_ROTATE_TEMPLATE_MIN && drop >= YAW_UNDER_ROTATE_DROP_MIN) ||
    (templateYaw >= YAW_UNDER_ROTATE_NEAR_TEMPLATE_MIN && drop >= YAW_UNDER_ROTATE_NEAR_DROP_MIN);
}

module.exports = {
  isPulledToCameraNumeric,
  isUnderRotated,
  YAW_UNDER_ROTATE_TEMPLATE_MIN,
  YAW_UNDER_ROTATE_DROP_MIN,
};
