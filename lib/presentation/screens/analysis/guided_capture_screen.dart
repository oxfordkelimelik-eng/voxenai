import 'dart:async';
import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart';
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
// TARAMALI ÇEKİM (2026-11-23, kullanıcı: "kafa yeri bi türlü tam oturtulamıyor")
// ============================================================
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

  // TARAMALI ÇEKİM (yalnız AI'nin 10 açılı yüz çekimi; bkz. sweepAngleFor).
  bool get _sweep =>
      widget.kind == CaptureKind.face && identical(widget.angles, kAiFaceAngles);
  // Bant içinde bu kadar SAKİN kalınca çekilir (eski 1,1 sn tutma şartı yerine).
  static const _sweepDwell = Duration(milliseconds: 300);
  // Baş bundan hızlı dönüyorsa çekilmez (fotoğrafta hareket bulanıklığı olmasın).
  static const _sweepMaxSpeed = 25.0; // derece/sn
  CaptureAngle? _candAngle;
  DateTime? _candSince;
  double? _lastYaw;
  DateTime? _lastYawAt;
  double _yawSpeed = 0;
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
      _sweep ? ResolutionPreset.veryHigh : ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: Platform.isAndroid
          ? ImageFormatGroup.nv21
          : ImageFormatGroup.bgra8888,
    );
    _controller = controller;
    await controller.initialize();
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
        _candSince = null;
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
    final cx = box.center.dx / size.width;
    final cy = box.center.dy / size.height;
    final wRatio = box.width / size.width;
    final yaw = f.headEulerAngleY ?? 0; // sağ+/sol- (yaklaşık)
    final pitch = f.headEulerAngleX ?? 0; // yukarı+/aşağı-
    final roll = f.headEulerAngleZ ?? 0;

    // Yüz TAM ovalin içine otursun: mesafe + ortalama toleransları önceki
    // sürümden DAHA SIKI tutuldu (kullanıcı geri bildirimi: yüz tam
    // ortalanmadan/oval'e girmeden çekiyordu).
    if (wRatio < 0.40) return (false, 'Biraz yaklaş, yüzün ovali doldursun');
    if (wRatio > 0.75) return (false, 'Biraz uzaklaş');
    if ((cx - 0.5).abs() > 0.09) return (false, 'Yüzü tam ovalin içine ortala');
    if (cy < 0.30 || cy > 0.56) return (false, 'Yüzü tam ovalin içine ortala');
    if (roll.abs() > 9) return (false, 'Başını dik tut');

    // AI çekimindeki yana dönük karelerde baş dik (çene aşağı/yukarı değil);
    // eğim yalnız çene karesinden gelsin.
    final isTurn = _turnBands.containsKey(_angle);
    if (isTurn || _angle == CaptureAngle.chinDown) {
      if (_angle == CaptureAngle.chinDown) {
        if (yaw.abs() > 8) return (false, 'Kameraya dön, yüzün düz baksın');
        if (pitch > -12) return (false, 'Başını biraz daha ÖNE eğ (çene aşağı)');
        if (pitch < -30) return (false, 'Biraz kaldır (fazla eğdin)');
      } else {
        final levelMsg = _levelPitchMessage(pitch);
        if (levelMsg != null) return (false, levelMsg);
        final (lo, hi) = _turnBands[_angle]!;
        final toRight = hi > 0;
        if (yaw < lo) {
          return (false, toRight ? 'Başını biraz daha SAĞA çevir' : 'Biraz geri dön (fazla döndün)');
        }
        if (yaw > hi) {
          return (false, toRight ? 'Biraz geri dön (fazla döndün)' : 'Başını biraz daha SOLA çevir');
        }
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
        if (yaw.abs() > (widget.angles == kAiFaceAngles ? 5 : 8)) {
          return (false, 'Dümdüz kameraya bak');
        }
        if (widget.angles == kAiFaceAngles) {
          final levelMsg = _levelPitchMessage(pitch);
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

    // Dönüş hızı (derece/sn, yumuşatılmış): hızlı dönüşte çekilmez.
    final yaw = f?.headEulerAngleY;
    if (yaw != null && _lastYaw != null && _lastYawAt != null) {
      final dt = now.difference(_lastYawAt!).inMicroseconds / 1e6;
      _yawSpeed = (dt > 0 && dt < 1) ? 0.5 * _yawSpeed + 0.5 * ((yaw - _lastYaw!).abs() / dt) : 0;
    }
    _lastYaw = yaw;
    _lastYawAt = yaw == null ? null : now;

    if (problem != null || f == null) {
      _candAngle = null;
      _candSince = null;
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
      _candSince = null;
      setState(() {
        _aligned = false;
        _hint = sweepHint(_angle, yaw, pitch);
      });
      return;
    }

    if (_candAngle != cand) {
      _candAngle = cand;
      _candSince = now;
    }
    final steady = _yawSpeed <= _sweepMaxSpeed;
    if (!steady) _candSince = now;
    setState(() {
      _aligned = true;
      _hint = steady ? 'Sabit dur…' : 'Biraz daha yavaş';
    });
    if (steady && now.difference(_candSince!) >= _sweepDwell) {
      await _capture(cand);
    }
  }

  /// Çekilen fotoğrafı yeniden ölçer: göz kırpma, ikinci yüz ya da çekim anında
  /// kayan açı → false (kare atılır, aynı açı tekrar çekilir). Fotoğrafta yüz
  /// bulunamazsa (yön/EXIF farkı olabilir) akışın ölçümüne güvenilir. Aynı açı
  /// art arda 2 kez reddedilirse 3.'de denetim yapılmaz — kullanıcı takılmasın.
  Future<bool> _stillOk(String path, CaptureAngle angle) async {
    if (_rejectAngle == angle && _rejectCount >= 2) return true;
    try {
      final det = _stillDetector ??= FaceDetector(
        options: FaceDetectorOptions(
          performanceMode: FaceDetectorMode.accurate,
          enableClassification: true,
          minFaceSize: 0.15,
        ),
      );
      final faces = await det.processImage(InputImage.fromFilePath(path));
      if (faces.length > 1) return _rejected(angle);
      if (faces.isEmpty) return true;
      final f = faces.first;
      final le = f.leftEyeOpenProbability;
      final re = f.rightEyeOpenProbability;
      if ((le != null && le < 0.3) || (re != null && re < 0.3)) return _rejected(angle);
      if (!sweepStillMatches(angle, f.headEulerAngleY ?? 0, f.headEulerAngleX ?? 0)) {
        return _rejected(angle);
      }
      return true;
    } catch (_) {
      return true; // ölçülemedi: akışın kararı geçerli
    }
  }

  bool _rejected(CaptureAngle angle) {
    _rejectCount = _rejectAngle == angle ? _rejectCount + 1 : 1;
    _rejectAngle = angle;
    return false;
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
      HapticFeedback.mediumImpact();
      final shot = await c.takePicture();

      if (_sweep) {
        _candAngle = null;
        _candSince = null;
        _lastYaw = null;
        if (!await _stillOk(shot.path, angle)) {
          try {
            File(shot.path).deleteSync();
          } catch (_) {}
          if (!mounted) return;
          setState(() {
            _aligned = false;
            _hint = 'Kare kaçtı — aynı açıda bir an sabit dur';
          });
          await c.startImageStream(_onFrame);
          return;
        }
        if (_rejectAngle == angle) {
          _rejectAngle = null;
          _rejectCount = 0;
        }
        _captured[angle] = File(shot.path);
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
        // Kısa ara: kullanıcı titreşimi hissetsin, dönmeye devam etsin.
        await Future<void>.delayed(const Duration(milliseconds: 150));
        if (!mounted) return;
        await c.startImageStream(_onFrame);
        return;
      }

      _captured[angle] = File(shot.path);

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
      await c.startImageStream(_onFrame);
    } catch (e) {
      if (mounted) setState(() => _error = 'Çekim hatası: $e');
    } finally {
      _isCapturing = false;
    }
  }

  void _resetSweep() {
    _candAngle = null;
    _candSince = null;
    _lastYaw = null;
    _lastYawAt = null;
    _yawSpeed = 0;
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
                  ? 'Başını yavaşça çevir, kareler kendiliğinden çekilir'
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
