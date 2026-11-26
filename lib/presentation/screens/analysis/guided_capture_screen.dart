import 'dart:async';
import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart';
import 'package:image/image.dart' as img;
import '../../../core/constants/app_colors.dart';

/// Rehberli çekim türü: yüz mü, vücut mu?
enum CaptureKind { face, body }

/// Çekilecek açılar — sırayla istenir. [right]/[left] analiz akışının
/// 3 açısı; turnR*/turnL*/chinDown AI foto üretiminin 10 açısı.
///
/// SIK AÇILI ÇEKİM (2026-11-16, kullanıcı kararı): model çıktıdaki baş açısını
/// şablondan değil kendisine giden selfie'lerden alıyor; 5 açılı sette
/// (ön / hafif / tam) arada kalan şablonlar (ör. 17-21° ve 35° dönük, 8° dönük
/// ama çenesi aşağı) her işte fazla dönüp eleniyordu. Artık her yöne 4 adım +
/// çene aşağı bir kare çekilir; sunucu her şablona açısı en uygun 5'ini
/// gönderir (functions/falPhotos.js MAX_FACE_PHOTOS / selfieOrderForYaw).
enum CaptureAngle {
  front,
  right,
  left,
  turnR1,
  turnR2,
  turnR3,
  turnR4,
  turnL1,
  turnL2,
  turnL3,
  turnL4,
  chinDown,
}

/// AI foto üretimi için 10 yüz açısının ÇEKİM sırası: önden, sonra başı adım
/// adım sağa, sonra adım adım sola, en son çene aşağı — kullanıcı başını bir
/// yöne yavaşça çevirirken kareler sırayla otomatik çekilir.
const kAiFaceAngles = [
  CaptureAngle.front,
  CaptureAngle.turnR1,
  CaptureAngle.turnR2,
  CaptureAngle.turnR3,
  CaptureAngle.turnR4,
  CaptureAngle.turnL1,
  CaptureAngle.turnL2,
  CaptureAngle.turnL3,
  CaptureAngle.turnL4,
  CaptureAngle.chinDown,
];

/// Sunucuya GİDEN sıra: ilk 5 eski 5 açıya (ön, hafif sağ/sol, tam sağ/sol)
/// en yakın kareler — sunucu ücretli kontrollerde (Vision, ten) yalnız ilk 5'i
/// kullanıyor. Ardından ara açılar ve çene aşağı.
const kAiFaceUploadOrder = [
  CaptureAngle.front,
  CaptureAngle.turnR2,
  CaptureAngle.turnL2,
  CaptureAngle.turnR4,
  CaptureAngle.turnL4,
  CaptureAngle.turnR1,
  CaptureAngle.turnL1,
  CaptureAngle.turnR3,
  CaptureAngle.turnL3,
  CaptureAngle.chinDown,
];

extension on CaptureAngle {
  String get label => switch (this) {
        CaptureAngle.front => 'ÖN',
        CaptureAngle.right => 'SAĞ',
        CaptureAngle.left => 'SOL',
        CaptureAngle.turnR1 => 'AZICIK SAĞ',
        CaptureAngle.turnR2 => 'HAFİF SAĞ',
        CaptureAngle.turnR3 => 'YARIM SAĞ',
        CaptureAngle.turnR4 => 'TAM SAĞ',
        CaptureAngle.turnL1 => 'AZICIK SOL',
        CaptureAngle.turnL2 => 'HAFİF SOL',
        CaptureAngle.turnL3 => 'YARIM SOL',
        CaptureAngle.turnL4 => 'TAM SOL',
        CaptureAngle.chinDown => 'ÇENE AŞAĞI',
      };

  /// Üst barda: "TAM SAĞ AÇI"; çene karesinde "AÇI" eki anlamsız.
  String get title => this == CaptureAngle.chinDown ? label : '$label AÇI';

  String faceHint() => switch (this) {
        CaptureAngle.front => 'Yüzünü ovalin içine ortala, dümdüz kameraya bak',
        CaptureAngle.right => 'Başını hafifçe SAĞA çevir (sağ profilin görünsün)',
        CaptureAngle.left => 'Başını hafifçe SOLA çevir (sol profilin görünsün)',
        CaptureAngle.turnR1 => 'Başını ÇOK AZ SAĞA çevir, gözlerin kameraya baksın',
        CaptureAngle.turnR2 => 'Başını biraz daha SAĞA çevir',
        CaptureAngle.turnR3 => 'Başını yarıya kadar SAĞA çevir',
        CaptureAngle.turnR4 => 'Başını iyice SAĞA çevir (sağ yanağın tam görünsün)',
        CaptureAngle.turnL1 => 'Önce kameraya dön, sonra başını ÇOK AZ SOLA çevir',
        CaptureAngle.turnL2 => 'Başını biraz daha SOLA çevir',
        CaptureAngle.turnL3 => 'Başını yarıya kadar SOLA çevir',
        CaptureAngle.turnL4 => 'Başını iyice SOLA çevir (sol yanağın tam görünsün)',
        CaptureAngle.chinDown =>
          'Kameraya dön, başını hafifçe ÖNE eğ (çene aşağı), gözlerin kameraya baksın',
      };

  String bodyHint() => switch (this) {
        CaptureAngle.front || CaptureAngle.chinDown =>
          'Tüm vücudun silüetin içinde, önden dur',
        CaptureAngle.right ||
        CaptureAngle.turnR1 ||
        CaptureAngle.turnR2 ||
        CaptureAngle.turnR3 ||
        CaptureAngle.turnR4 =>
          'Sağ yan profilini ver, tüm vücut görünsün',
        CaptureAngle.left ||
        CaptureAngle.turnL1 ||
        CaptureAngle.turnL2 ||
        CaptureAngle.turnL3 ||
        CaptureAngle.turnL4 =>
          'Sol yan profilini ver, tüm vücut görünsün',
      };
}

/// AI çekiminin yön bantları (ML Kit headEulerAngleY, sağ+/sol−). Bantlar
/// birbirine değmiyor ki iki kare aynı açıya düşmesin; aralıklar sunucudaki
/// 3B ölçümle ~5°'lik adımlara karşılık geliyor (eski bantlar: hafif 10-22,
/// tam 38-60).
const _turnBands = <CaptureAngle, (double, double)>{
  CaptureAngle.turnR1: (6, 12),
  CaptureAngle.turnR2: (15, 22),
  CaptureAngle.turnR3: (26, 34),
  CaptureAngle.turnR4: (40, 60),
  CaptureAngle.turnL1: (-12, -6),
  CaptureAngle.turnL2: (-22, -15),
  CaptureAngle.turnL3: (-34, -26),
  CaptureAngle.turnL4: (-60, -40),
};

/// AI çekiminde ön ve dönme karelerinde telefon göz hizasında olsun
/// (ML Kit headEulerAngleX, yukarı+/aşağı−). 2026-11-17: 10'lu setin 9
/// selfie'si hafif yukarı bakıyordu (sunucu 3B ölçüm +1..+6°) ve model başı
/// her karede şablondan ortalama +9° yukarı kaldırdı. Eskiden ±12.
const _levelPitchMin = -8.0;
const _levelPitchMax = 4.0;

String? _levelPitchMessage(double pitch) {
  if (pitch > _levelPitchMax) {
    return 'Telefonu göz hizana kaldır, çenen düz dursun';
  }
  if (pitch < _levelPitchMin) return 'Çeneni biraz kaldır, düz bak';
  return null;
}

// ============================================================
// YÖNLENDİRMELİ AI ÇEKİMİNDE PAY (2026-11-26, kullanıcı: "kullanıcıyı çok zorlamayalım,
// dönüş 3-4 derece aynı değilse yine fotoyu çektirsin")
// ============================================================
// Sunucu selfie'yi kendi ölçtüğü 3B açıyla seçiyor (falPhotos selfieOrderForYaw), bant kenarında
// çekilen kare de doğru yere gider. Bantlar her iki yana kGuidedYawTol genişler; bantlar artık
// üst üste bindiği için aynı yöndeki komşu karelerin en az kGuidedMinStep farklı olması istenir
// (iki kare aynı açıya düşüp bir açıyı boşa harcamasın).
// Yukarı eğim sınırı (_levelPitchMax) GEVŞEMEDİ: 11-17 yukarı bakan selfie'ler modelin başı
// kaldırmasına yol açıyordu. Aşağı eğim payı genişledi.

/// Dönüş bandının her iki yanına eklenen pay (derece).
const kGuidedYawTol = 4.0;
/// Aynı yöndeki komşu kareler arasında en az açı farkı (derece).
const kGuidedMinStep = 3.0;
/// Ön kare: |yaw| sınırı (eskiden 5).
const kGuidedFrontYaw = 8.0;
/// Düz bakış karelerinde aşağı eğim payı (_levelPitchMin'in altına).
const kGuidedPitchDownTol = 3.0;
/// Çene aşağı karesi: |yaw| sınırı (eskiden 8) ve eğim aralığı (eskiden -30..-12).
const kGuidedChinYaw = 12.0;
const kGuidedChinPitchHi = -10.0;
const kGuidedChinPitchLo = -34.0;

/// Düz bakış karelerinde eğim uyarısı (yönlendirmeli AI çekimi). SAF.
@visibleForTesting
String? guidedLevelPitchMessage(double pitch) {
  if (pitch > _levelPitchMax) return 'Telefonu göz hizana kaldır, çenen düz dursun';
  if (pitch < _levelPitchMin - kGuidedPitchDownTol) return 'Çeneni biraz kaldır, düz bak';
  return null;
}

const _rightChain = [
  CaptureAngle.front,
  CaptureAngle.turnR1,
  CaptureAngle.turnR2,
  CaptureAngle.turnR3,
  CaptureAngle.turnR4,
];
const _leftChain = [
  CaptureAngle.front,
  CaptureAngle.turnL1,
  CaptureAngle.turnL2,
  CaptureAngle.turnL3,
  CaptureAngle.turnL4,
];

/// Yönlendirmeli çekimde dönüş karesi için sorun (yoksa null). [capturedYaw]: bu oturumda
/// çekilmiş karelerin çekim anındaki yaw'ı. SAF.
@visibleForTesting
String? guidedTurnProblem(CaptureAngle angle, double yaw, Map<CaptureAngle, double> capturedYaw) {
  final band = _turnBands[angle];
  if (band == null) return null;
  final toRight = band.$2 > 0;
  final lo = band.$1 - kGuidedYawTol;
  final hi = band.$2 + kGuidedYawTol;
  const more = 'Başını biraz daha ';
  const back = 'Biraz geri dön (fazla döndün)';
  if (yaw < lo) return toRight ? '${more}SAĞA çevir' : back;
  if (yaw > hi) return toRight ? back : '${more}SOLA çevir';

  // Bir önceki kareden (aynı yönde, içerideki) ayrışma: s ile iki yön "dışa doğru artan" tek
  // ölçeğe çevrilir. Yalnız ÖNCEKİ denetlenir: sırayla çekimde sonraki henüz yok; onaydan tek açı
  // yeniden çekilirken iki komşuya birden bakmak aralığı tek dereceye indirip kilitleyebilirdi.
  final chain = toRight ? _rightChain : _leftChain;
  final s = toRight ? 1.0 : -1.0;
  final prev = capturedYaw[chain[chain.indexOf(angle) - 1]];
  if (prev != null && s * yaw < s * prev + kGuidedMinStep) {
    return '$more${toRight ? "SAĞA" : "SOLA"} çevir';
  }
  return null;
}

// ============================================================
// TARAMALI ÇEKİM (2026-11-23, kullanıcı: "kafa yeri bi türlü tam oturtulamıyor")
// ============================================================
// 2026-11-26 KAPATILDI (kullanıcı: "yeni foto çekme akışını sevmedim, sürekli flaş patlatıyor;
// ilk versiyondaki gibi belirli direktiflerle yönlendirerek kareleri alalım"). AI çekimi yine
// açı açı yönlendirmeli. Kod duruyor; geri açmak için kSweepCapture = true.
const kSweepCapture = false;

// AI çekiminde 10 açı artık tek tek "tuttur → 1,1 sn bekle" ile değil, başı
// yavaşça çevirirken alınır: her kare işlenir, baş HANGİ boş açının bandına
// düşerse (sıradaki olmasa bile) kısa bir duraksamada o açı çekilir. Kareler
// yine takePicture ile çekilen TAM fotoğraftır (akış/video karesi DEĞİL) —
// kalite eski çekimle birebir aynı. Çekilen fotoğraf ayrıca yeniden ölçülür
// (göz kırpma / çekim anında kayan açı → kare atılır, aynı açı tekrar alınır).

/// Başın şu anki açısı hangi AI açısına karşılık geliyor (bant dışıysa null).
@visibleForTesting
CaptureAngle? sweepAngleFor(double yaw, double pitch) {
  if (yaw.abs() <= 8 && pitch >= -30 && pitch <= -12) return CaptureAngle.chinDown;
  if (pitch < _levelPitchMin || pitch > _levelPitchMax) return null;
  if (yaw.abs() <= 5) return CaptureAngle.front;
  for (final e in _turnBands.entries) {
    if (yaw >= e.value.$1 && yaw <= e.value.$2) return e.key;
  }
  return null;
}

/// Hedef açıya (sıradaki boş açı) yönlendiren tek cümle.
@visibleForTesting
String sweepHint(CaptureAngle target, double yaw, double pitch) {
  if (target == CaptureAngle.chinDown) {
    if (yaw.abs() > 8) return 'Kameraya dön, düz bak';
    if (pitch > -12) return 'Şimdi başını hafifçe ÖNE eğ (çene aşağı)';
    if (pitch < -30) return 'Biraz kaldır (fazla eğdin)';
    return 'Sabit dur…';
  }
  final level = _levelPitchMessage(pitch);
  if (level != null) return level;
  if (target == CaptureAngle.front) {
    return yaw.abs() > 5 ? 'Kameraya dön, dümdüz bak' : 'Sabit dur…';
  }
  final band = _turnBands[target];
  if (band == null) return 'Sabit dur…';
  final (lo, hi) = band;
  if (hi > 0) {
    if (yaw < lo) return 'Başını yavaşça SAĞA çevir';
    if (yaw > hi) return 'Biraz geri gel (fazla döndün)';
  } else {
    if (yaw > hi) {
      return yaw > 5 ? 'Önce kameraya dön, sonra yavaşça SOLA' : 'Başını yavaşça SOLA çevir';
    }
    if (yaw < lo) return 'Biraz geri gel (fazla döndün)';
  }
  return 'Sabit dur…';
}

/// Çekilen TAM fotoğrafın açısı istenen açıya uyuyor mu. Akış karesi ile
/// fotoğraf arasında birkaç yüz ms geçer; ölçüm modu da farklı (fast/accurate)
/// → bant ±4° payla denetlenir. Yön işareti (sağ/sol) akıştan gelir; ön kamera
/// fotoğrafı aynalanmış olabileceği için burada yalnız büyüklüğe bakılır.
@visibleForTesting
bool sweepStillMatches(CaptureAngle angle, double yaw, double pitch) {
  const tol = 4.0;
  final ay = yaw.abs();
  if (angle == CaptureAngle.chinDown) return ay <= 8 + tol && pitch <= -12 + tol;
  if (pitch < _levelPitchMin - tol || pitch > _levelPitchMax + tol) return false;
  if (angle == CaptureAngle.front) return ay <= 5 + tol;
  final band = _turnBands[angle];
  if (band == null) return true;
  final lo = band.$1.abs() < band.$2.abs() ? band.$1.abs() : band.$2.abs();
  final hi = band.$1.abs() < band.$2.abs() ? band.$2.abs() : band.$1.abs();
  return ay >= lo - tol && ay <= hi + tol;
}

// ============================================================
// HAREKET + NETLİK (2026-11-25, kullanıcı: "selfie'de hareket bulanıklığı olmasın")
// ============================================================
// Taramalı çekim baş ≤25°/sn dönerken 300 ms sonra çekiyordu; 1/34 sn pozlamada ~0.7° dönüş ≈
// 1080p'de 4 px bulanıklık (eski 1,1 sn tutma ≈ 0.7 px). Artık: (1) bant içinde son kSweepDwell
// boyunca yaw/pitch/roll'un HER BİRİNİN oynaması ≤ kSweepMaxRange (0.5 sn'de 4° = ort. 8°/sn),
// en az kSweepMinSamples ölçüyle. Anlık hız değil pencere aralığı: ML Kit hızlı modda açı kareden
// kareye ~1° titriyor, 10 fps'de anlık hız titremeden 10°/sn görünür ve kullanıcı takılırdı.
// Kareler arası ≥1 sn boşluk pencereyi sıfırlar (eskiden hız 0 = "durgun" sayılıyordu).
// (2) çekilen fotoğrafın yüz bölgesinde netlik ölçülür, oturumun kabul edilmiş karelerine göre
// belirgin bulanıksa yeniden çekilir.

/// Bant içinde bu kadar SAKİN kalınca çekilir.
const kSweepDwell = Duration(milliseconds: 500);
/// Pencere boyunca yaw/pitch/roll'un her birinin en çok oynaması (derece). 500 ms'de 4° ≈ 8°/sn.
const kSweepMaxRange = 4.0;
/// Pencerede en az bu kadar ölçü (yavaş cihazda tek kare yetmesin).
const kSweepMinSamples = 3;
/// Bu kadar boşluk (ölçü yok) pencereyi sıfırlar.
const kSweepMaxGap = Duration(seconds: 1);
/// Netlik: kabul edilmiş karelerin medyanının bu oranının altı bulanık.
const kStillSharpRatio = 0.6;
/// Netlik karşılaştırması için gereken en az kabul edilmiş kare.
const kStillSharpMinRef = 2;

/// Baş durgunluk penceresi (KAYAN). [add] ölçüyü ekler; ≥kSweepMaxGap boşlukta pencere sıfırlanır,
/// sonra en eski ölçüler (a) herhangi bir açının aralığı kSweepMaxRange'in altına inene kadar ve
/// (b) pencere kSweepDwell'i kapsamaya yetecek en kısa hâline gelene kadar atılır.
/// [steady]: pencere ≥kSweepDwell sürüyor ve ≥kSweepMinSamples ölçü içeriyor. SAF.
@visibleForTesting
class SweepMotion {
  final _t = <DateTime>[];
  final _a = <List<double>>[];

  int get samples => _t.length;

  void reset() {
    _t.clear();
    _a.clear();
  }

  bool _inRange() {
    for (int k = 0; k < 3; k++) {
      double lo = double.infinity, hi = -double.infinity;
      for (final v in _a) {
        if (v[k] < lo) lo = v[k];
        if (v[k] > hi) hi = v[k];
      }
      if (hi - lo > kSweepMaxRange) return false;
    }
    return true;
  }

  void _dropFirst() {
    _t.removeAt(0);
    _a.removeAt(0);
  }

  void add(double yaw, double pitch, double roll, DateTime now) {
    if (_t.isNotEmpty && now.difference(_t.last) >= kSweepMaxGap) reset();
    _t.add(now);
    _a.add([yaw, pitch, roll]);
    while (_t.length > 1 && !_inRange()) {
      _dropFirst();
    }
    while (_t.length > kSweepMinSamples && now.difference(_t[1]) >= kSweepDwell) {
      _dropFirst();
    }
  }

  bool steady(DateTime now) =>
      _t.length >= kSweepMinSamples && now.difference(_t.first) >= kSweepDwell;
}

/// Gri tonlu (0-255) yüz kırpımının netliği: Laplace yanıtının ortalama karesi / (ışıklık varyansı + 25).
/// Kontrasta göre normalize (denetim 11-25: ham Laplace enerjisi kontrastla k² ölçekleniyordu; 0.77
/// kontrast tek başına 0.6 eşiğine düşürüyordu → gölgeli/profil açı hep "bulanık" sayılabilirdi). SAF.
@visibleForTesting
double laplacianEnergy(List<int> gray, int w, int h) {
  if (w < 3 || h < 3) return 0;
  double s = 0, m = 0, m2 = 0;
  int n = 0;
  for (int y = 1; y < h - 1; y++) {
    for (int x = 1; x < w - 1; x++) {
      final i = y * w + x;
      final l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      s += l * l;
      m += gray[i];
      m2 += gray[i] * gray[i];
      n++;
    }
  }
  if (n == 0) return 0;
  final mean = m / n;
  final variance = m2 / n - mean * mean;
  return (s / n) / (variance + 25);
}

/// Bu kare, oturumda kabul edilmiş karelere göre yeterince net mi. SAF.
@visibleForTesting
bool stillSharpEnough(double sharp, List<double> accepted) {
  if (accepted.length < kStillSharpMinRef) return true;
  final s = [...accepted]..sort();
  final med = s.length.isOdd ? s[s.length ~/ 2] : (s[s.length ~/ 2 - 1] + s[s.length ~/ 2]) / 2;
  return sharp >= kStillSharpRatio * med;
}

/// Fotoğraf dosyasında (EXIF yönü uygulanmış) yüz kutusu bölgesinin netliği; kutu yoksa orta
/// bölge. Ayrı isolate'te koşar (compute). Hata → null.
Future<double?> stillSharpness(String path, Rect? box) =>
    compute(_stillSharpnessJob, <Object?>[path, box?.left, box?.top, box?.width, box?.height]);

double? _stillSharpnessJob(List<Object?> a) {
  try {
    final bytes = File(a[0] as String).readAsBytesSync();
    final dec = img.decodeImage(bytes);
    if (dec == null) return null;
    final im = img.bakeOrientation(dec);
    int x, y, w, h;
    if (a[1] != null) {
      // Yüz kutusu %10 içeri: saç/arka plan kenarı netliği karıştırmasın.
      final bw = (a[3] as double), bh = (a[4] as double);
      x = ((a[1] as double) + 0.1 * bw).round();
      y = ((a[2] as double) + 0.1 * bh).round();
      w = (0.8 * bw).round();
      h = (0.8 * bh).round();
    } else {
      x = (im.width * 0.3).round();
      y = (im.height * 0.25).round();
      w = (im.width * 0.4).round();
      h = (im.height * 0.4).round();
    }
    // Kenara yakın kutu: kırpım görüntü içinde kalsın (clamp üst sınırı alt sınırdan küçük olamaz).
    x = x.clamp(0, im.width - 8);
    y = y.clamp(0, im.height - 8);
    w = w.clamp(8, im.width - x);
    h = h.clamp(8, im.height - y);
    // Ortak ölçek: yüz eni 256 px (cihaz çözünürlüğünden bağımsız karşılaştırma).
    final crop = img.copyResize(img.copyCrop(im, x: x, y: y, width: w, height: h),
        width: 256, interpolation: img.Interpolation.average);
    final g = List<int>.filled(crop.width * crop.height, 0);
    for (final p in crop) {
      g[p.y * crop.width + p.x] = (0.299 * p.r + 0.587 * p.g + 0.114 * p.b).round();
    }
    return laplacianEnergy(g, crop.width, crop.height);
  } catch (_) {
    return null;
  }
}

/// Yüz kutusunun DİK görüntüdeki yeri (kenarlar 0..1, x genişliğe, y yüksekliğe
/// bölünmüş) — kadraj denetimi için. [aspect] = dik görüntünün yükseklik/genişliği.
@visibleForTesting
String? sweepFramingProblem({
  required double left,
  required double top,
  required double right,
  required double bottom,
  required double aspect,
}) {
  final w = right - left;
  final hInWidths = (bottom - top) * aspect;
  // Yana dönünce kutu daralır ama boyu değişmez: uzaklığı ikisinin büyüğü ölçer
  // (eski çekimde dönük karelerde sürekli "yaklaş" çıkıyordu). İkisi de görüntü
  // GENİŞLİĞİ biriminde — eski wRatio eşikleriyle (0.40) aynı ölçek.
  final size = w > hInWidths ? w : hInWidths;
  if (size < 0.40) return 'Biraz yaklaş, yüzün ovali doldursun';
  if (size > 0.80) return 'Biraz uzaklaş';
  if (left < 0.02 || right > 0.98 || top < 0.02 || bottom > 0.98) {
    return 'Yüzün tamamı ovalin içinde olsun';
  }
  final cx = (left + right) / 2;
  final cy = (top + bottom) / 2;
  // Baş dönerken kutu yana kayar: ortalama payı eskisinin (±0.09) iki katı.
  if ((cx - 0.5).abs() > 0.18 || cy < 0.24 || cy > 0.62) {
    return 'Yüzünü ovalin içine al';
  }
  return null;
}

/// Sırayla açı fotoğraflarını canlı hizalama rehberiyle çeken ekran.
/// Her açı çizgiye "oturmadan" çekim kabul edilmez. Oturunca çerçeve yeşile
/// döner (uymuyorsa kırmızı) ve otomatik çeker.
/// Varsayılan: [ön, sağ, sol]. Tek tam boy için angles: [CaptureAngle.front].
class GuidedCaptureScreen extends StatefulWidget {
  final CaptureKind kind;
  /// null ise ön/sağ/sol. Tek elemanlı liste = tek kare (ör. tam boy).
  final List<CaptureAngle>? angles;
  /// Dönen dosya listesinin sırası; null ise [angles] (çekim) sırası.
  final List<CaptureAngle>? resultOrder;
  const GuidedCaptureScreen(
      {super.key, required this.kind, this.angles, this.resultOrder});

  @override
  State<GuidedCaptureScreen> createState() => _GuidedCaptureScreenState();
}

class _GuidedCaptureScreenState extends State<GuidedCaptureScreen>
    with WidgetsBindingObserver {
  static const _defaultAngles = [
    CaptureAngle.front,
    CaptureAngle.right,
    CaptureAngle.left,
  ];
  // Otomatik çekim öncesi hizalı kalınması gereken GERÇEK süre (kare sayısı
  // DEĞİL — kare işleme hızı cihaza göre değiştiği için "N kare" ölçüsü bazı
  // cihazlarda saniyenin çok altında dolup "hemen çekiyor" hissi veriyordu).
  // Süre bazlı şart cihazdan bağımsız olarak kullanıcının gerçekten ~1 sn
  // sabit + doğru açıda kalmasını garanti eder.
  static const _requiredStableDuration = Duration(milliseconds: 1100);
  // Göz açıklık eşiği — bu değerin altı "kapalı/kısık göz" sayılır.
  static const _eyeOpenThreshold = 0.4;

  List<CaptureAngle> get _angles => widget.angles ?? _defaultAngles;

  CameraController? _controller;
  List<CameraDescription> _cameras = const [];
  int _cameraIndex = 0;

  FaceDetector? _faceDetector;
  PoseDetector? _poseDetector;

  final _captured = <CaptureAngle, File>{};
  int _angleIndex = 0;

  bool _isDetecting = false; // kare işleniyor mu
  bool _isCapturing = false; // fotoğraf alınıyor mu (akış durur)
  bool _reviewing = false; // 3 açı bitti, onay ekranı gösteriliyor
  bool _aligned = false;
  DateTime? _stableSince; // hizalanmanın başladığı an (süre bazlı bekleme için)

  // AI'nin 10 açılı yüz çekimi (1080p çözünürlük bu çekime özel).
  bool get _aiFace =>
      widget.kind == CaptureKind.face && identical(widget.angles, kAiFaceAngles);
  // TARAMALI ÇEKİM (bkz. sweepAngleFor) — kSweepCapture kapalıyken AI çekimi de eski
  // yönlendirmeli yoldan gider (açı açı yönerge → çizgiye otur → 1,1 sn sabit → çek).
  bool get _sweep => kSweepCapture && _aiFace;
  // Yönlendirmeli çekimde son ölçülen yaw ve çekilen karelerin çekim anındaki yaw'ı
  // (komşu açılar aynı dereceye düşmesin; bkz. guidedTurnProblem).
  double? _lastYaw;
  final _capturedYaw = <CaptureAngle, double>{};
  // Bant içinde sakinlik süresi / hız sınırı: bkz. kSweepDwell, kSweepMaxSpeed (üst düzey).
  CaptureAngle? _candAngle;
  final _motion = SweepMotion();
  final _sharpByAngle = <CaptureAngle, double>{}; // kabul edilmiş karelerin netliği
  int _noFaceRejects = 0; // fotoğrafta art arda yüz bulunamadı
  // Netlikten reddedilen en iyi deneme (tek dosya): netlik denetimi aynı açıyı 2 kez reddedince
  // 3. denemede bununla şimdiki denemenin NET olanı kabul edilir (takılma emniyeti).
  CaptureAngle? _blurAngle;
  int _blurRejects = 0;
  String? _blurBestPath;
  double _blurBestSharp = -1;
  FaceDetector? _stillDetector; // çekilen fotoğrafı yeniden ölçer
  CaptureAngle? _rejectAngle; // fotoğraf denetimi art arda reddettiyse sonsuz döngüye girmesin
  int _rejectCount = 0;
  // Onay ekranından "sadece bu açıyı yeniden çek" ile girildiyse true — çekim
  // bitince akışın geri kalanına geçmeden direkt onay ekranına döner.
  bool _retakeSingle = false;
  String _hint = 'Kamera hazırlanıyor…';
  String? _error;

  CaptureAngle get _angle => _angles[_angleIndex];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.kind == CaptureKind.face) {
      _faceDetector = FaceDetector(
        options: FaceDetectorOptions(
          performanceMode: FaceDetectorMode.fast,
          // Göz açıklık olasılığı (leftEyeOpenProbability/rightEyeOpenProbability)
          // için gerekli — "gözlerini aç" kontrolü bunu kullanıyor.
          enableClassification: true,
          enableLandmarks: false,
          minFaceSize: 0.15,
        ),
      );
    } else {
      _poseDetector = PoseDetector(
        options: PoseDetectorOptions(mode: PoseDetectionMode.stream),
      );
    }
    _init();
  }

  Future<void> _init() async {
    try {
      _cameras = await availableCameras();
      if (_cameras.isEmpty) {
        setState(() => _error = 'Cihazda kamera bulunamadı.');
        return;
      }
      // Yüz için ön kamera, vücut için arka kamera tercih edilir.
      final wantFront = widget.kind == CaptureKind.face;
      _cameraIndex = _cameras.indexWhere((c) =>
          c.lensDirection ==
          (wantFront
              ? CameraLensDirection.front
              : CameraLensDirection.back));
      if (_cameraIndex < 0) _cameraIndex = 0;
      await _startController();
    } catch (e) {
      setState(() => _error = 'Kamera başlatılamadı: $e');
    }
  }

  Future<void> _startController() async {
    final controller = CameraController(
      _cameras[_cameraIndex],
      // AI selfie'leri 1080p (2026-11-24, kullanıcı kararı; eskiden 720p — 07-10'da
      // analiz ekranı için konmuştu, gerekçesi yoktu). Paket tek ayarla hem canlı
      // takip karesini hem fotoğrafı belirler: 4K canlı takibi ağırlaştırdığı için
      // seçilmedi. Desteklemeyen telefonda paket en yakın düşük çözünürlüğe iner.
      _aiFace ? ResolutionPreset.veryHigh : ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: Platform.isAndroid
          ? ImageFormatGroup.nv21
          : ImageFormatGroup.bgra8888,
    );
    _controller = controller;
    await controller.initialize();
    if (!mounted) return;
    // Flaş KAPALI (2026-11-26, kullanıcı: "sürekli flaş patlatıyor"). Paketin varsayılanı
    // FlashMode.auto: loş ortamda her deklanşörde flaş / ön kamerada ekran flaşı patlıyordu.
    // Yüz çekiminde ışığı ekrandaki beyaz ring-light veriyor. Flaşı olmayan kamerada hata → geç.
    try {
      await controller.setFlashMode(FlashMode.off);
    } catch (_) {}
    if (!mounted) return;
    await controller.startImageStream(_onFrame);
    setState(() {
      _hint = widget.kind == CaptureKind.face
          ? _angle.faceHint()
          : _angle.bodyHint();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return;
    if (state == AppLifecycleState.inactive) {
      c.dispose();
    } else if (state == AppLifecycleState.resumed) {
      _startController();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    _faceDetector?.close();
    _stillDetector?.close();
    _poseDetector?.close();
    super.dispose();
  }

  // ============================================================
  // KARE İŞLEME
  // ============================================================
  Future<void> _onFrame(CameraImage image) async {
    if (_isDetecting || _isCapturing || !mounted) return;
    _isDetecting = true;
    try {
      // Basit kalite eşiği: çok karanlık/çok parlak karede hizalama sayma.
      final (qualityOk, qualityHint) = _checkQuality(image);
      if (!qualityOk) {
        if (!mounted) return;
        _stableSince = null;
        _motion.reset();
        setState(() {
          _aligned = false;
          _hint = qualityHint;
        });
        return;
      }

      final input = _toInputImage(image);
      if (input == null) return;

      if (_sweep) {
        await _onSweepFrame(input);
        return;
      }

      bool aligned;
      String hint;
      if (widget.kind == CaptureKind.face) {
        (aligned, hint) = await _evaluateFace(input);
      } else {
        (aligned, hint) = await _evaluateBody(input);
      }

      if (!mounted) return;
      final now = DateTime.now();
      if (aligned) {
        _stableSince ??= now;
      } else {
        _stableSince = null;
      }
      final stableFor =
          _stableSince == null ? Duration.zero : now.difference(_stableSince!);
      final nowAligned = stableFor >= _requiredStableDuration;
      setState(() {
        _aligned = aligned;
        _hint = nowAligned ? 'Sabit dur…' : hint;
      });
      if (nowAligned) {
        await _capture();
      }
    } catch (_) {
      // sessizce geç — bir sonraki kare denenir
    } finally {
      _isDetecting = false;
    }
  }

  Future<(bool, String)> _evaluateFace(InputImage input) async {
    final faces = await _faceDetector!.processImage(input);
    if (faces.isEmpty) return (false, 'Yüz görünmüyor');
    if (faces.length > 1) return (false, 'Karede tek kişi olmalı');

    final size = input.metadata!.size;
    final f = faces.first;
    final box = f.boundingBox;
    final yaw = f.headEulerAngleY ?? 0; // sağ+/sol- (yaklaşık)
    final pitch = f.headEulerAngleX ?? 0; // yukarı+/aşağı-
    final roll = f.headEulerAngleZ ?? 0;
    _lastYaw = yaw;

    if (_aiFace) {
      // AI çekimi (2026-11-26 gevşetme): kutu DİK görüntü boyutuna bölünür, uzaklık en/boyun
      // büyüğüyle ölçülür (yana dönünce kutu daralır), ortalama payı ±0.18.
      final s = _uprightSize(input);
      final framing = sweepFramingProblem(
        left: box.left / s.width,
        right: box.right / s.width,
        top: box.top / s.height,
        bottom: box.bottom / s.height,
        aspect: s.height / s.width,
      );
      if (framing != null) return (false, framing);
    } else {
      final cx = box.center.dx / size.width;
      final cy = box.center.dy / size.height;
      final wRatio = box.width / size.width;
      // Yüz TAM ovalin içine otursun: mesafe + ortalama toleransları önceki
      // sürümden DAHA SIKI tutuldu (kullanıcı geri bildirimi: yüz tam
      // ortalanmadan/oval'e girmeden çekiyordu).
      if (wRatio < 0.40) return (false, 'Biraz yaklaş, yüzün ovali doldursun');
      if (wRatio > 0.75) return (false, 'Biraz uzaklaş');
      if ((cx - 0.5).abs() > 0.09) return (false, 'Yüzü tam ovalin içine ortala');
      if (cy < 0.30 || cy > 0.56) return (false, 'Yüzü tam ovalin içine ortala');
    }
    if (roll.abs() > 9) return (false, 'Başını dik tut');

    // AI çekimindeki yana dönük karelerde baş dik (çene aşağı/yukarı değil);
    // eğim yalnız çene karesinden gelsin. Paylar: bkz. kGuidedYawTol vb.
    final isTurn = _turnBands.containsKey(_angle);
    if (isTurn || _angle == CaptureAngle.chinDown) {
      if (_angle == CaptureAngle.chinDown) {
        if (yaw.abs() > kGuidedChinYaw) return (false, 'Kameraya dön, yüzün düz baksın');
        if (pitch > kGuidedChinPitchHi) return (false, 'Başını biraz daha ÖNE eğ (çene aşağı)');
        if (pitch < kGuidedChinPitchLo) return (false, 'Biraz kaldır (fazla eğdin)');
      } else {
        final levelMsg = guidedLevelPitchMessage(pitch);
        if (levelMsg != null) return (false, levelMsg);
        final turnMsg = guidedTurnProblem(_angle, yaw, _capturedYaw);
        if (turnMsg != null) return (false, turnMsg);
      }
    }

    switch (_angle) {
      case CaptureAngle.turnR1:
      case CaptureAngle.turnR2:
      case CaptureAngle.turnR3:
      case CaptureAngle.turnR4:
      case CaptureAngle.turnL1:
      case CaptureAngle.turnL2:
      case CaptureAngle.turnL3:
      case CaptureAngle.turnL4:
      case CaptureAngle.chinDown:
        break; // yukarıda bantla denetlendi
      case CaptureAngle.front:
        // AI çekiminde ön kare daha dar (ilk azıcık-dönük kare 6°'den başlıyor).
        if (yaw.abs() > (_aiFace ? kGuidedFrontYaw : 8)) {
          return (false, 'Dümdüz kameraya bak');
        }
        if (_aiFace) {
          final levelMsg = guidedLevelPitchMessage(pitch);
          if (levelMsg != null) return (false, levelMsg);
        }
      case CaptureAngle.right:
        // Net bir sağ profil için BELİRGİN dönüş şart — dönerken anlık geçen
        // küçük açıda (15°) çekmesin, kullanıcı tam dönene kadar beklesin.
        if (yaw < 25) return (false, 'Başını daha SAĞA çevir');
        if (yaw > 55) return (false, 'Biraz geri dön (fazla döndün)');
      case CaptureAngle.left:
        if (yaw > -25) return (false, 'Başını daha SOLA çevir');
        if (yaw < -55) return (false, 'Biraz geri dön (fazla döndün)');
    }

    // Canlı/uyanık bir kare için gözler açık olmalı — kapalı/kısık gözle
    // (blink anı) çekim yapılmasın.
    final leftEye = f.leftEyeOpenProbability;
    final rightEye = f.rightEyeOpenProbability;
    if ((leftEye != null && leftEye < _eyeOpenThreshold) ||
        (rightEye != null && rightEye < _eyeOpenThreshold)) {
      return (false, 'Gözlerini aç');
    }
    return (true, 'Hizalandı');
  }

  /// ML Kit yüz kutusunu DİK (döndürülmüş) görüntüde verir. Android'de akış
  /// karesi sensör yönünde (yatay) geldiği için 90/270° dönüşte en/boy yer
  /// değiştirir; iOS'ta boyut zaten bu düzlemde (ML Kit örneğiyle aynı kural).
  Size _uprightSize(InputImage input) {
    final m = input.metadata!;
    final quarter = m.rotation == InputImageRotation.rotation90deg ||
        m.rotation == InputImageRotation.rotation270deg;
    return (Platform.isAndroid && quarter) ? Size(m.size.height, m.size.width) : m.size;
  }

  /// Taramalı çekimde bir kare: baş hangi boş açının bandındaysa kısa bir
  /// duraksamada o açıyı çeker; değilse sıradaki boş açıya yönlendirir.
  Future<void> _onSweepFrame(InputImage input) async {
    final faces = await _faceDetector!.processImage(input);
    if (!mounted) return;
    final now = DateTime.now();

    String? problem;
    Face? f;
    if (faces.isEmpty) {
      problem = 'Yüz görünmüyor';
    } else if (faces.length > 1) {
      problem = 'Karede tek kişi olmalı';
    } else {
      f = faces.first;
      final s = _uprightSize(input);
      final b = f.boundingBox;
      problem = sweepFramingProblem(
        left: b.left / s.width,
        right: b.right / s.width,
        top: b.top / s.height,
        bottom: b.bottom / s.height,
        aspect: s.height / s.width,
      );
      if (problem == null && (f.headEulerAngleZ ?? 0).abs() > 9) problem = 'Başını dik tut';
      final le = f.leftEyeOpenProbability;
      final re = f.rightEyeOpenProbability;
      if (problem == null &&
          ((le != null && le < _eyeOpenThreshold) || (re != null && re < _eyeOpenThreshold))) {
        problem = 'Gözlerini aç';
      }
    }

    // Baş durgunluk penceresi (yaw/pitch/roll oynaması). Yüz yoksa pencere sıfırlanır.
    final yaw = f?.headEulerAngleY;
    if (f != null && yaw != null) {
      _motion.add(yaw, f.headEulerAngleX ?? 0, f.headEulerAngleZ ?? 0, now);
    } else {
      _motion.reset();
    }

    if (problem != null || f == null) {
      _candAngle = null;
      setState(() {
        _aligned = false;
        _hint = problem ?? 'Yüz görünmüyor';
      });
      return;
    }

    final pitch = f.headEulerAngleX ?? 0;
    final cand = sweepAngleFor(yaw!, pitch);
    if (cand == null || _captured.containsKey(cand)) {
      _candAngle = null;
      setState(() {
        _aligned = false;
        _hint = sweepHint(_angle, yaw, pitch);
      });
      return;
    }

    if (_candAngle != cand) {
      // Yeni banda girildi: durgunluk penceresi bu banttaki ilk ölçüden başlar.
      _candAngle = cand;
      _motion.reset();
      _motion.add(yaw, pitch, f.headEulerAngleZ ?? 0, now);
    }
    final calm = _motion.samples >= 2;
    setState(() {
      _aligned = true;
      _hint = calm ? 'Dur… sabit kal' : 'Dur — başını sabit tut';
    });
    if (_motion.steady(now)) {
      await _capture(cand);
    }
  }

  /// Çekilen fotoğrafı yeniden ölçer. Döner (kabul edilen dosya yolu | null, ret nedeni | null).
  /// Ret nedenleri: ikinci yüz, göz kapalı, çekim anında kayan açı, fotoğrafta yüz yok, BULANIK.
  /// 2026-11-25: yüz bulunamayan kare reddedilir (eskiden kabul edilirdi). Takılma emniyetleri:
  /// - aynı açı 2 kez reddedildiyse 3. denemede göz/açı denetimi gevşer, ikinci yüz varsa en büyük
  ///   yüz kullanılır;
  /// - yüz art arda 3 kez bulunamazsa (cihazın dosya yönü okuması hatalı olabilir) kare kabul edilir,
  ///   netlik ölçülmez (yüz kırpımı olmadan referansla kıyaslanamaz);
  /// - ML Kit hata verirse akışın kararı geçerli, netlik ölçülmez;
  /// - netlik aynı açıyı 2 kez reddettiyse 3. denemede o ana kadarki en net deneme kabul edilir.
  Future<(String?, String?)> _stillOk(String path, CaptureAngle angle) async {
    final lenient = _rejectAngle == angle && _rejectCount >= 2;
    Face f;
    try {
      final det = _stillDetector ??= FaceDetector(
        options: FaceDetectorOptions(
          performanceMode: FaceDetectorMode.accurate,
          enableClassification: true,
          minFaceSize: 0.15,
        ),
      );
      final faces = await det.processImage(InputImage.fromFilePath(path));
      if (faces.length > 1 && !lenient) return _rejected(angle, 'ikinci');
      if (faces.isEmpty) {
        _noFaceRejects++;
        if (_noFaceRejects < 3) return _rejected(angle, 'yüz');
        _noFaceRejects = 0;
        return (path, null);
      }
      _noFaceRejects = 0;
      f = faces.reduce((p, q) =>
          p.boundingBox.width * p.boundingBox.height >= q.boundingBox.width * q.boundingBox.height ? p : q);
      if (!lenient) {
        final le = f.leftEyeOpenProbability;
        final re = f.rightEyeOpenProbability;
        if ((le != null && le < 0.3) || (re != null && re < 0.3)) return _rejected(angle, 'göz');
        if (!sweepStillMatches(angle, f.headEulerAngleY ?? 0, f.headEulerAngleX ?? 0)) {
          return _rejected(angle, 'açı');
        }
      }
    } catch (_) {
      return (path, null); // ölçülemedi: akışın kararı geçerli
    }
    final sharp = await stillSharpness(path, f.boundingBox);
    if (sharp == null) return (path, null); // dosya çözülemedi: akışın kararı geçerli
    final others = [for (final e in _sharpByAngle.entries) if (e.key != angle) e.value];
    if (_blurAngle != angle) _clearBlurBest();
    if (!stillSharpEnough(sharp, others)) {
      if (_blurRejects < 2) {
        // En net reddedilen denemeyi sakla (emniyet için), gerisini sil.
        if (sharp > _blurBestSharp) {
          _deleteQuiet(_blurBestPath);
          _blurBestPath = path;
          _blurBestSharp = sharp;
        } else {
          _deleteQuiet(path);
        }
        _blurAngle = angle;
        _blurRejects++;
        return _rejected(angle, 'bulanık', fileHandled: true);
      }
      // Emniyet: 3. netlik denemesi — şimdiki ile saklananın net olanı kabul edilir.
      final best = _blurBestPath;
      if (best != null && _blurBestSharp > sharp) {
        _deleteQuiet(path);
        _sharpByAngle[angle] = _blurBestSharp;
        _blurBestPath = null; // kabul edildi: silinmesin
        _clearBlurBest();
        return (best, null);
      }
    }
    _sharpByAngle[angle] = sharp;
    _clearBlurBest();
    return (path, null);
  }

  void _deleteQuiet(String? p) {
    if (p == null) return;
    try {
      File(p).deleteSync();
    } catch (_) {}
  }

  void _clearBlurBest() {
    _deleteQuiet(_blurBestPath);
    _blurAngle = null;
    _blurRejects = 0;
    _blurBestPath = null;
    _blurBestSharp = -1;
  }

  /// Ret kaydı. fileHandled: dosya _stillOk içinde zaten saklandı/silindi (çağıran silmesin).
  (String?, String?) _rejected(CaptureAngle angle, String reason, {bool fileHandled = false}) {
    _rejectCount = _rejectAngle == angle ? _rejectCount + 1 : 1;
    _rejectAngle = angle;
    return (null, fileHandled ? '$reason:handled' : reason);
  }

  /// Ret nedenine göre kullanıcıya yapabileceği şeyi söyleyen ipucu.
  static String _rejectHint(String? reason) {
    switch (reason?.split(':').first) {
      case 'ikinci':
        return 'Karede başka biri var — yalnız sen görün';
      case 'göz':
        return 'Gözlerin kapalı çıktı — açık tut, bir an dur';
      case 'açı':
        return 'Açı kaydı — aynı açıda bir an sabit dur';
      case 'yüz':
        return 'Yüzün görünmedi — yüzünü kameraya göster';
      case 'bulanık':
        return 'Kare net çıkmadı — aynı açıda bir an tamamen dur';
      default:
        return 'Aynı açıda bir an sabit dur';
    }
  }

  Future<(bool, String)> _evaluateBody(InputImage input) async {
    final poses = await _poseDetector!.processImage(input);
    if (poses.isEmpty) return (false, 'Vücut görünmüyor');
    final size = input.metadata!.size;
    final lm = poses.first.landmarks;

    PoseLandmark? at(PoseLandmarkType t) => lm[t];
    final needed = [
      PoseLandmarkType.leftShoulder,
      PoseLandmarkType.rightShoulder,
      PoseLandmarkType.leftHip,
      PoseLandmarkType.rightHip,
      PoseLandmarkType.leftAnkle,
      PoseLandmarkType.rightAnkle,
    ];
    for (final t in needed) {
      final p = at(t);
      if (p == null || p.likelihood < 0.3) {
        return (false, 'Tüm vücut kadraja girsin');
      }
    }

    final ls = at(PoseLandmarkType.leftShoulder)!;
    final rs = at(PoseLandmarkType.rightShoulder)!;
    final la = at(PoseLandmarkType.leftAnkle)!;
    final ra = at(PoseLandmarkType.rightAnkle)!;
    final nose = at(PoseLandmarkType.nose);

    final topY = (ls.y < rs.y ? ls.y : rs.y) / size.height;
    final botY = (la.y > ra.y ? la.y : ra.y) / size.height;
    // Baştan ayağa dikey kapsama yeterli mi (tüm vücut)?
    if (topY > 0.28) return (false, 'Biraz uzaklaş / geri çekil');
    if (botY < 0.80) return (false, 'Ayaklar kadraja girsin');

    // Yatay ortalama
    final midX = ((ls.x + rs.x) / 2) / size.width;
    if ((midX - 0.5).abs() > 0.20) return (false, 'Vücudu ortala');

    // Omuz genişliği (önden geniş, yandan dar)
    final shoulderW = (ls.x - rs.x).abs() / size.width;
    final torsoH = (botY - topY).clamp(0.01, 1.0);
    final ratio = shoulderW / torsoH;

    switch (_angle) {
      case CaptureAngle.front:
      case CaptureAngle.chinDown:
        if (ratio < 0.16) return (false, 'Önden dur, omuzlar açık');
      case CaptureAngle.right:
      case CaptureAngle.left:
      case CaptureAngle.turnR1:
      case CaptureAngle.turnR2:
      case CaptureAngle.turnR3:
      case CaptureAngle.turnR4:
      case CaptureAngle.turnL1:
      case CaptureAngle.turnL2:
      case CaptureAngle.turnL3:
      case CaptureAngle.turnL4:
        if (ratio > 0.16) return (false, 'Yana dön (yan profil)');
        // Yön ayrımı: burun hangi tarafa bakıyor
        if (nose != null) {
          final noseX = nose.x / size.width;
          if (_angle == CaptureAngle.right && noseX > midX + 0.05) {
            return (false, 'SAĞ yanını ver');
          }
          if (_angle == CaptureAngle.left && noseX < midX - 0.05) {
            return (false, 'SOL yanını ver');
          }
        }
    }
    return (true, 'Hizalandı');
  }

  // ============================================================
  // ÇEKİM
  // ============================================================
  /// [which]: taramalı çekimde bandına girilen açı (sıradaki olmayabilir).
  Future<void> _capture([CaptureAngle? which]) async {
    final c = _controller;
    if (c == null || _isCapturing) return;
    _isCapturing = true;
    final angle = which ?? _angle;
    try {
      await c.stopImageStream();
      // Titreşim deklanşörden SONRA (2026-11-25): önce titretmek pozlama sırasında telefonu sarsıyordu.
      final shot = await c.takePicture();
      HapticFeedback.mediumImpact();

      if (_sweep) {
        _candAngle = null;
        _motion.reset();
        final (okPath, reason) = await _stillOk(shot.path, angle);
        if (okPath == null) {
          if (!(reason?.endsWith(':handled') ?? false)) _deleteQuiet(shot.path);
          if (!mounted) return;
          setState(() {
            _aligned = false;
            _hint = _rejectHint(reason);
          });
          await _restartStream(c);
          return;
        }
        if (_rejectAngle == angle) {
          _rejectAngle = null;
          _rejectCount = 0;
        }
        _captured[angle] = File(okPath);
        final next = _angles.indexWhere((a) => !_captured.containsKey(a));
        if (next < 0 || _retakeSingle) {
          _retakeSingle = false;
          if (!mounted) return;
          setState(() => _reviewing = true);
          return;
        }
        if (!mounted) return;
        setState(() {
          _angleIndex = next;
          _aligned = false;
          _hint = _angle.faceHint();
        });
        // Kısa ara: kullanıcı titreşimi hissetsin, sonra sıradaki açıya dönsün.
        await Future<void>.delayed(const Duration(milliseconds: 150));
        if (!mounted) return;
        await _restartStream(c);
        return;
      }

      _captured[angle] = File(shot.path);
      final y = _lastYaw;
      if (y != null) _capturedYaw[angle] = y;

      if (_retakeSingle) {
        // Sadece bu açı yeniden çekiliyordu (onay ekranından) — diğer
        // açılara dokunmadan direkt onay ekranına geri dön.
        _retakeSingle = false;
        if (!mounted) return;
        setState(() => _reviewing = true);
        return;
      }

      if (_angleIndex >= _angles.length - 1) {
        // Hepsi tamam → onay ekranına geç (akış zaten durdu)
        if (!mounted) return;
        setState(() => _reviewing = true);
        return;
      }

      setState(() {
        _angleIndex++;
        _aligned = false;
        _stableSince = null;
        _hint = widget.kind == CaptureKind.face
            ? _angle.faceHint()
            : _angle.bodyHint();
      });
      await Future<void>.delayed(const Duration(milliseconds: 500));
      if (!mounted) return;
      await _restartStream(c);
    } catch (e) {
      if (mounted) setState(() => _error = 'Çekim hatası: $e');
    } finally {
      _isCapturing = false;
    }
  }

  /// Akışı yeniden başlatır. Uygulama arka plana geçip controller atıldıysa (resume yenisini kurar)
  /// sessizce çıkar — eskiden CameraException "Çekim hatası" ekranına düşüp tüm kareleri kaybettiriyordu.
  Future<void> _restartStream(CameraController c) async {
    if (!identical(_controller, c) || !c.value.isInitialized || c.value.isStreamingImages) return;
    try {
      await c.startImageStream(_onFrame);
    } on CameraException {
      if (!identical(_controller, c)) return;
      rethrow;
    }
  }

  void _resetSweep() {
    _candAngle = null;
    _motion.reset();
    _noFaceRejects = 0;
    _clearBlurBest();
    _rejectAngle = null;
    _rejectCount = 0;
  }

  /// Onay ekranında "Kullan" → istenen açı sırasıyla dosya listesi döndür.
  void _confirm() {
    Navigator.of(context).pop(<File>[
      for (final a in widget.resultOrder ?? _angles) _captured[a]!,
    ]);
  }

  /// Onay ekranında tek bir açıya dokunulunca: SADECE o açı silinip yeniden
  /// çekilir, diğer açılar (zaten kabul edilmiş) korunur — kullanıcı "1'i
  /// beğenmedim" derse üçünü baştan çekmek zorunda kalmasın.
  Future<void> _retakeAngle(CaptureAngle a) async {
    setState(() {
      _retakeSingle = true;
      _angleIndex = _angles.indexOf(a);
      _captured.remove(a);
      _sharpByAngle.remove(a);
      _capturedYaw.remove(a);
      _reviewing = false;
      _aligned = false;
      _stableSince = null;
      _resetSweep();
      _hint = widget.kind == CaptureKind.face
          ? _angle.faceHint()
          : _angle.bodyHint();
    });
    final c = _controller;
    if (c != null && c.value.isInitialized && !c.value.isStreamingImages) {
      await c.startImageStream(_onFrame);
    }
  }

  /// Onay ekranında "Baştan çek" → sıfırla ve akışı yeniden başlat.
  Future<void> _restart() async {
    setState(() {
      _captured.clear();
      _sharpByAngle.clear();
      _capturedYaw.clear();
      _angleIndex = 0;
      _aligned = false;
      _stableSince = null;
      _resetSweep();
      _reviewing = false;
      _hint = widget.kind == CaptureKind.face
          ? _angle.faceHint()
          : _angle.bodyHint();
    });
    final c = _controller;
    if (c != null && c.value.isInitialized && !c.value.isStreamingImages) {
      await c.startImageStream(_onFrame);
    }
  }

  // ============================================================
  // CAMERA IMAGE -> ML KIT INPUT IMAGE
  // ============================================================
  // Netlik eşiği: yatay komşu piksel farklarının ortalama karesi bu değerin
  // altındaysa kare bulanık sayılır. Cihaza göre ince ayar gerekebilir.
  // GEVŞETİLDİ (2026-07-26, "çok zor kabul ediyor" geri bildirimi): 45 -> 18.
  static const double _sharpnessThreshold = 18.0;

  /// Kaba ışık + netlik kalitesi kontrolü — kötü ışıkta veya bulanık karede
  /// çekimi engeller. HER İKİ PLATFORMDA da parlaklık kontrol edilir
  /// (önceki sürümde iOS tamamen atlanıyordu → iPhone'da kötü ışıkta bile
  /// çekiyordu). Netlik yalnızca Android'de (Y düzleminden ucuz hesaplanır).
  (bool, String) _checkQuality(CameraImage image) {
    if (image.planes.isEmpty) return (true, '');

    // Parlaklık alt/üst sınırları. GEVŞETİLDİ (2026-07-26): darkMin 62->45,
    // brightMax 225->240 — "çok zor kabul ediyor" geri bildirimi.
    const darkMin = 45; // altı = çok karanlık
    const brightMax = 240; // üstü = aşırı parlak/patlamış

    if (Platform.isIOS) {
      // bgra8888: her piksel 4 bayt (B, G, R, A). Kaba luma örneklemesi
      // (~her 160. bayt = her 40 pikselde bir). Netlik iOS'ta atlanır.
      final b = image.planes.first.bytes;
      if (b.length < 4) return (true, '');
      int sum = 0, count = 0;
      for (int i = 0; i + 2 < b.length; i += 160) {
        sum += (b[i] * 11 + b[i + 1] * 59 + b[i + 2] * 30) ~/ 100;
        count++;
      }
      if (count == 0) return (true, '');
      final avg = sum / count;
      if (avg < darkMin) return (false, 'Ortam çok karanlık — ışığa geç');
      if (avg > brightMax) return (false, 'Çok parlak — ışığı azalt');
      return (true, '');
    }

    if (!Platform.isAndroid) return (true, '');
    // Android nv21: ilk düzlem Y (parlaklık). Parlaklık + netlik tek geçişte.
    final y = image.planes.first.bytes;
    final width = image.width;
    if (y.isEmpty || width < 2) return (true, '');

    int sum = 0;
    int count = 0;
    double gradSq = 0;
    int gradCount = 0;
    for (int i = 0; i < y.length - 1; i += 37) {
      sum += y[i];
      count++;
      // Satır sonunu geçmeyen yatay komşu farkı (yüksek frekans = netlik)
      if ((i % width) < width - 1) {
        final d = y[i + 1] - y[i];
        gradSq += d * d;
        gradCount++;
      }
    }
    if (count == 0) return (true, '');

    final avg = sum / count;
    if (avg < darkMin) return (false, 'Ortam çok karanlık — ışığa geç');
    if (avg > brightMax) return (false, 'Çok parlak — ışığı azalt');

    if (gradCount > 0) {
      final sharpness = gradSq / gradCount;
      if (sharpness < _sharpnessThreshold) {
        return (false, 'Görüntü bulanık — sabit tut / odakla');
      }
    }
    return (true, '');
  }

  InputImage? _toInputImage(CameraImage image) {
    final camera = _cameras[_cameraIndex];
    final rotation = _rotation(camera);
    if (rotation == null) return null;

    final format = InputImageFormatValue.fromRawValue(image.format.raw);
    // Android'de nv21, iOS'ta bgra8888 bekliyoruz (controller ayarıyla).
    if (format == null) return null;
    if (image.planes.isEmpty) return null;

    return InputImage.fromBytes(
      bytes: image.planes.first.bytes,
      metadata: InputImageMetadata(
        size: Size(image.width.toDouble(), image.height.toDouble()),
        rotation: rotation,
        format: format,
        bytesPerRow: image.planes.first.bytesPerRow,
      ),
    );
  }

  InputImageRotation? _rotation(CameraDescription camera) {
    if (Platform.isIOS) {
      return InputImageRotationValue.fromRawValue(camera.sensorOrientation);
    }
    // Android: sensör yönünü portre kilidine göre eşle.
    int rotationCompensation = camera.sensorOrientation;
    if (camera.lensDirection == CameraLensDirection.front) {
      rotationCompensation = (360 - rotationCompensation) % 360;
    }
    return InputImageRotationValue.fromRawValue(rotationCompensation);
  }

  // ============================================================
  // UI
  // ============================================================
  @override
  Widget build(BuildContext context) {
    final c = _controller;
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (_error != null)
              _ErrorView(message: _error!, onBack: () => Navigator.pop(context))
            else if (c == null || !c.value.isInitialized)
              const Center(
                  child: CircularProgressIndicator(color: AppColors.gold))
            else if (_reviewing)
              _buildReview()
            else ...[
              Center(child: CameraPreview(c)),
              // Hizalama rehberi (çizgiler)
              CustomPaint(
                painter: _GuidePainter(
                  kind: widget.kind,
                  aligned: _aligned,
                ),
                child: const SizedBox.expand(),
              ),
              _buildTopBar(),
              _buildBottomHint(),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildReview() {
    final order = _angles;
    return Container(
      color: Colors.black,
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          Text(
            '${widget.kind == CaptureKind.face ? "YÜZ" : "VÜCUT"} • ÇEKİMİ ONAYLA',
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w900,
              fontSize: 18,
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _angles.length == 1
                ? 'Fotoğraf hazır. Kullanmadan önce kontrol et.'
                : '${_angles.length} açı hazır. Beğenmediğine dokun, sadece '
                    'onu yeniden çek.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white60, fontSize: 13),
          ),
          const SizedBox(height: 20),
          // 10 açılı AI çekiminde tek satır küçük resimleri okunmaz kılıyordu →
          // 5'erli satırlar.
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var r = 0; r < order.length; r += 5)
                  Flexible(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: _reviewRow(
                          order.sublist(r, r + 5 > order.length ? order.length : r + 5)),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _confirm,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.success,
              padding: const EdgeInsets.symmetric(vertical: 15),
            ),
            icon: const Icon(Icons.check_rounded, color: Colors.white),
            label: Text(
                order.length == 1
                    ? 'BU FOTOĞRAFI KULLAN'
                    : 'BU ${order.length} FOTOĞRAFI KULLAN',
                style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5)),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _restart,
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: Colors.white30),
              padding: const EdgeInsets.symmetric(vertical: 15),
            ),
            icon: const Icon(Icons.refresh_rounded, color: Colors.white),
            label: const Text('BAŞTAN ÇEK',
                style: TextStyle(
                    color: Colors.white, fontWeight: FontWeight.w700)),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _reviewRow(List<CaptureAngle> row) {
    return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                for (final a in row)
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          GestureDetector(
                            onTap: () => _retakeAngle(a),
                            child: Stack(
                              children: [
                                ClipRRect(
                                  borderRadius: BorderRadius.circular(12),
                                  child: AspectRatio(
                                    aspectRatio: 3 / 4,
                                    child: Image.file(_captured[a]!,
                                        fit: BoxFit.cover),
                                  ),
                                ),
                                Positioned(
                                  right: 4,
                                  bottom: 4,
                                  child: Container(
                                    padding: const EdgeInsets.all(5),
                                    decoration: BoxDecoration(
                                      color: Colors.black.withValues(alpha: 0.65),
                                      shape: BoxShape.circle,
                                    ),
                                    child: const Icon(Icons.refresh_rounded,
                                        color: Colors.white, size: 16),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 6),
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text(a.label,
                                maxLines: 1,
                                style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 12)),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            );
  }

  Widget _buildTopBar() {
    // Yüz çekiminde arka plan artık BEYAZ (ring-light) — beyaz metin/ikon
    // görünmez olmasın diye tüm üst bar koyu, yarı saydam bir kapsül içine
    // alındı. Vücut çekiminde de (siyah karartma üstünde) zarar vermez.
    return Positioned(
      top: 8,
      left: 8,
      right: 8,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.pop(context),
              ),
              // Başlık iki satır: üstte tür + adım sayacı, altta açının adı.
              // Dar ekranda tek satırlık "YÜZ • HAFİF SAĞ AÇI" taşıyordu.
              Expanded(
                child: Column(
                  children: [
                    Text(
                      _angles.length > 1
                          ? (_sweep
                              ? 'YÜZ • ${_captured.length}/${_angles.length} ÇEKİLDİ'
                              : '${widget.kind == CaptureKind.face ? "YÜZ" : "VÜCUT"} • ${_angleIndex + 1}/${_angles.length}')
                          : (widget.kind == CaptureKind.face ? 'YÜZ' : 'VÜCUT'),
                      style: const TextStyle(
                        color: Colors.white70,
                        fontWeight: FontWeight.w700,
                        fontSize: 11,
                        letterSpacing: 1,
                      ),
                    ),
                    const SizedBox(height: 2),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        _angle.title,
                        maxLines: 1,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                          fontSize: 17,
                          letterSpacing: 1,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 48),
            ],
          ),
          if (_angles.length > 1) ...[
            const SizedBox(height: 8),
            // Açı adım göstergesi: her açı eşit genişlikte bir bölüm. Eski
            // kapsül dizisi 5 açıda ("HAFİF SAĞ" x2) ekrandan taşıyordu.
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: List.generate(_angles.length, (i) {
                  final done = _captured.containsKey(_angles[i]);
                  final active = i == _angleIndex;
                  final color = done
                      ? AppColors.success
                      : active
                          ? AppColors.gold
                          : Colors.white24;
                  return Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: Column(
                        children: [
                          AnimatedContainer(
                            duration: const Duration(milliseconds: 200),
                            height: 4,
                            decoration: BoxDecoration(
                              color: color,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                          // 10 açıda etiketler okunamayacak kadar küçülüyor;
                          // açının adı zaten üstte büyük yazıyor.
                          if (_angles.length <= 5) ...[
                          const SizedBox(height: 5),
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (done) ...[
                                  const Icon(Icons.check,
                                      size: 12, color: AppColors.success),
                                  const SizedBox(width: 2),
                                ],
                                Text(
                                  _angles[i].label,
                                  maxLines: 1,
                                  style: TextStyle(
                                    color: active || done
                                        ? Colors.white
                                        : Colors.white60,
                                    fontWeight: active
                                        ? FontWeight.w800
                                        : FontWeight.w600,
                                    fontSize: 11,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          ],
                        ],
                      ),
                    ),
                  );
                }),
              ),
            ),
            const SizedBox(height: 4),
          ],
        ],
        ),
      ),
    );
  }

  Widget _buildBottomHint() {
    return Positioned(
      bottom: 32,
      left: 20,
      right: 20,
      child: Column(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
            decoration: BoxDecoration(
              color: _aligned
                  ? AppColors.success.withValues(alpha: 0.92)
                  : const Color(0xFFB71C1C).withValues(alpha: 0.88),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _aligned
                      ? Icons.check_circle_rounded
                      : Icons.warning_amber_rounded,
                  color: Colors.white,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    _hint,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          // Yüz modunda arka plan BEYAZ (ring-light) olduğu için düz beyaz
          // metin görünmez olur — koyu kapsül içine alındı.
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              _sweep
                  ? 'Başını yavaşça çevir, her açıda bir an dur — kareler kendiliğinden çekilir'
                  : 'Çizgiye oturunca otomatik çekilir',
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

/// Yüz için oval, vücut için tam boy silüet çizgileri. Hizalıysa yeşil.
class _GuidePainter extends CustomPainter {
  final CaptureKind kind;
  final bool aligned;
  _GuidePainter({required this.kind, required this.aligned});

  @override
  void paint(Canvas canvas, Size size) {
    // Yeşil = hizalı / kabul; kırmızı = henüz uymuyor (talimatı takip et).
    final color = aligned
        ? AppColors.success
        : const Color(0xFFFF5252).withValues(alpha: 0.95);
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.5;

    if (kind == CaptureKind.face) {
      final rect = Rect.fromCenter(
        center: Offset(size.width / 2, size.height * 0.42),
        width: size.width * 0.62,
        height: size.height * 0.42,
      );
      // Oval DIŞINDAKİ tüm alan TAM BEYAZ dolduruluyor (siyah karartma
      // DEĞİL) — telefon ekranının kendisi gece çekimde yüze ışık veren bir
      // "ring light" gibi çalışsın.
      final outer = Path()..addRect(Offset.zero & size);
      final ovalHole = Path()..addOval(rect);
      final ring = Path.combine(PathOperation.difference, outer, ovalHole);
      canvas.drawPath(ring, Paint()..color = Colors.white);
      canvas.drawOval(rect, paint);
    } else {
      // Vücut çekiminde ışık halkası gerekmiyor — kadraj dışını klasik
      // şekilde karart.
      final overlay = Paint()..color = Colors.black.withValues(alpha: 0.35);
      canvas.drawRect(Offset.zero & size, overlay);
      _drawBodySilhouette(canvas, size, paint);
    }
  }

  void _drawBodySilhouette(Canvas canvas, Size size, Paint paint) {
    final cx = size.width / 2;
    final topY = size.height * 0.10;
    final botY = size.height * 0.92;
    final headR = size.width * 0.09;

    // Baş
    canvas.drawCircle(Offset(cx, topY + headR), headR, paint);
    // Gövde + bacaklar (basit çizgi silüeti)
    final shoulderY = topY + headR * 2 + 6;
    final shoulderHalf = size.width * 0.17;
    final hipY = size.height * 0.55;
    final hipHalf = size.width * 0.12;

    final path = Path()
      // Sol omuz -> sol kalça -> sol ayak
      ..moveTo(cx - shoulderHalf, shoulderY)
      ..lineTo(cx - hipHalf, hipY)
      ..lineTo(cx - hipHalf, botY)
      // Sağ ayak -> sağ kalça -> sağ omuz
      ..moveTo(cx + shoulderHalf, shoulderY)
      ..lineTo(cx + hipHalf, hipY)
      ..lineTo(cx + hipHalf, botY)
      // Omuz çizgisi
      ..moveTo(cx - shoulderHalf, shoulderY)
      ..lineTo(cx + shoulderHalf, shoulderY)
      // Kollar
      ..moveTo(cx - shoulderHalf, shoulderY)
      ..lineTo(cx - shoulderHalf - size.width * 0.04, hipY)
      ..moveTo(cx + shoulderHalf, shoulderY)
      ..lineTo(cx + shoulderHalf + size.width * 0.04, hipY);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_GuidePainter old) =>
      old.aligned != aligned || old.kind != kind;
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onBack;
  const _ErrorView({required this.message, required this.onBack});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.no_photography_rounded,
                color: Colors.white70, size: 48),
            const SizedBox(height: 16),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 15)),
            const SizedBox(height: 20),
            ElevatedButton(onPressed: onBack, child: const Text('Geri dön')),
          ],
        ),
      ),
    );
  }
}
