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

/// Çekilecek açılar (ön / sağ / sol) — sırayla istenir.
enum CaptureAngle { front, right, left }

extension on CaptureAngle {
  String get label => switch (this) {
        CaptureAngle.front => 'ÖN',
        CaptureAngle.right => 'SAĞ',
        CaptureAngle.left => 'SOL',
      };

  String faceHint() => switch (this) {
        CaptureAngle.front => 'Yüzünü ovalin içine ortala, dümdüz kameraya bak',
        CaptureAngle.right => 'Başını hafifçe SAĞA çevir (sağ profilin görünsün)',
        CaptureAngle.left => 'Başını hafifçe SOLA çevir (sol profilin görünsün)',
      };

  String bodyHint() => switch (this) {
        CaptureAngle.front => 'Tüm vücudun silüetin içinde, önden dur',
        CaptureAngle.right => 'Sağ yan profilini ver, tüm vücut görünsün',
        CaptureAngle.left => 'Sol yan profilini ver, tüm vücut görünsün',
      };
}

/// Sırayla açı fotoğraflarını canlı hizalama rehberiyle çeken ekran.
/// Her açı çizgiye "oturmadan" çekim kabul edilmez. Oturunca çerçeve yeşile
/// döner (uymuyorsa kırmızı) ve otomatik çeker.
/// Varsayılan: [ön, sağ, sol]. Tek tam boy için angles: [CaptureAngle.front].
class GuidedCaptureScreen extends StatefulWidget {
  final CaptureKind kind;
  /// null ise ön/sağ/sol. Tek elemanlı liste = tek kare (ör. tam boy).
  final List<CaptureAngle>? angles;
  const GuidedCaptureScreen({super.key, required this.kind, this.angles});

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
  // Otomatik çekim öncesi kaç ardışık "hizalı" kare beklenir (~0.8sn).
  static const _requiredStableFrames = 8;

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
  int _stableFrames = 0;
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
          enableClassification: false,
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
      ResolutionPreset.high,
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
        _stableFrames = 0;
        setState(() {
          _aligned = false;
          _hint = qualityHint;
        });
        return;
      }

      final input = _toInputImage(image);
      if (input == null) return;

      bool aligned;
      String hint;
      if (widget.kind == CaptureKind.face) {
        (aligned, hint) = await _evaluateFace(input);
      } else {
        (aligned, hint) = await _evaluateBody(input);
      }

      if (!mounted) return;
      if (aligned) {
        _stableFrames++;
      } else {
        _stableFrames = 0;
      }
      final nowAligned = _stableFrames >= _requiredStableFrames;
      setState(() {
        _aligned = _stableFrames > 0;
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
    final roll = f.headEulerAngleZ ?? 0;

    if (wRatio < 0.30) return (false, 'Biraz yaklaş');
    if (wRatio > 0.85) return (false, 'Biraz uzaklaş');
    if ((cx - 0.5).abs() > 0.16) return (false, 'Yüzü yatay ortala');
    if (cy < 0.22 || cy > 0.68) return (false, 'Yüzü dikey ortala');
    if (roll.abs() > 15) return (false, 'Başını dik tut');

    switch (_angle) {
      case CaptureAngle.front:
        if (yaw.abs() > 12) return (false, 'Dümdüz kameraya bak');
      case CaptureAngle.right:
        if (yaw < 15) return (false, 'Başını daha SAĞA çevir');
        if (yaw > 55) return (false, 'Biraz geri dön');
      case CaptureAngle.left:
        if (yaw > -15) return (false, 'Başını daha SOLA çevir');
        if (yaw < -55) return (false, 'Biraz geri dön');
    }
    return (true, 'Hizalandı');
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
        if (ratio < 0.16) return (false, 'Önden dur, omuzlar açık');
      case CaptureAngle.right:
      case CaptureAngle.left:
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
  Future<void> _capture() async {
    final c = _controller;
    if (c == null || _isCapturing) return;
    _isCapturing = true;
    try {
      await c.stopImageStream();
      HapticFeedback.mediumImpact();
      final shot = await c.takePicture();
      _captured[_angle] = File(shot.path);

      if (_angleIndex >= _angles.length - 1) {
        // Hepsi tamam → onay ekranına geç (akış zaten durdu)
        if (!mounted) return;
        setState(() => _reviewing = true);
        return;
      }

      setState(() {
        _angleIndex++;
        _aligned = false;
        _stableFrames = 0;
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

  /// Onay ekranında "Kullan" → istenen açı sırasıyla dosya listesi döndür.
  void _confirm() {
    Navigator.of(context).pop(<File>[
      for (final a in _angles) _captured[a]!,
    ]);
  }

  /// Onay ekranında "Baştan çek" → sıfırla ve akışı yeniden başlat.
  Future<void> _restart() async {
    setState(() {
      _captured.clear();
      _angleIndex = 0;
      _aligned = false;
      _stableFrames = 0;
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
  static const double _sharpnessThreshold = 45.0;

  /// Kaba ışık + netlik kalitesi kontrolü — kötü ışıkta veya bulanık karede
  /// çekimi engeller. Android (nv21) ilk düzlem Y (parlaklık) verisidir;
  /// iOS'ta atlanır.
  (bool, String) _checkQuality(CameraImage image) {
    if (!Platform.isAndroid || image.planes.isEmpty) return (true, '');
    final y = image.planes.first.bytes;
    final width = image.width;
    if (y.isEmpty || width < 2) return (true, '');

    // Parlaklık + netlik tek geçişte örneklenir (~her 37. bayt).
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
    if (avg < 55) return (false, 'Ortam çok karanlık — ışığa geç');
    if (avg > 225) return (false, 'Çok parlak — ışığı azalt');

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
                : '${_angles.length} açı hazır. Kullanmadan önce kontrol et.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white60, fontSize: 13),
          ),
          const SizedBox(height: 20),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                for (final a in order)
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(12),
                            child: AspectRatio(
                              aspectRatio: 3 / 4,
                              child: Image.file(_captured[a]!,
                                  fit: BoxFit.cover),
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(a.label,
                              style: const TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 12)),
                        ],
                      ),
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

  Widget _buildTopBar() {
    return Positioned(
      top: 8,
      left: 8,
      right: 8,
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.pop(context),
              ),
              const Spacer(),
              Text(
                '${widget.kind == CaptureKind.face ? "YÜZ" : "VÜCUT"} • ${_angle.label} AÇI',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 16,
                  letterSpacing: 1,
                ),
              ),
              const Spacer(),
              const SizedBox(width: 48),
            ],
          ),
          const SizedBox(height: 8),
          // Açı adım göstergesi
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(_angles.length, (i) {
              final done = _captured.containsKey(_angles[i]);
              final active = i == _angleIndex;
              return Container(
                margin: const EdgeInsets.symmetric(horizontal: 4),
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(
                  color: done
                      ? AppColors.success.withValues(alpha: 0.9)
                      : active
                          ? AppColors.gold.withValues(alpha: 0.85)
                          : Colors.white24,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Row(
                  children: [
                    if (done)
                      const Icon(Icons.check, size: 14, color: Colors.white),
                    if (done) const SizedBox(width: 4),
                    Text(
                      _angles[i].label,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              );
            }),
          ),
        ],
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
          const Text(
            'Çizgiye oturunca otomatik çekilir',
            style: TextStyle(color: Colors.white60, fontSize: 12),
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

    // Kadraj dışını karart
    final overlay = Paint()..color = Colors.black.withValues(alpha: 0.35);
    canvas.drawRect(Offset.zero & size, overlay);

    if (kind == CaptureKind.face) {
      final rect = Rect.fromCenter(
        center: Offset(size.width / 2, size.height * 0.42),
        width: size.width * 0.62,
        height: size.height * 0.42,
      );
      canvas.drawOval(rect, paint);
    } else {
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
