import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:gal/gal.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../../../data/sources/claude_api_service.dart' show PhotoScore;
import '../../providers/app_providers.dart'
    show authServiceProvider, claudeApiServiceProvider;
import '../../screens/analysis/guided_capture_screen.dart';
import '../providers/dating_providers.dart';
import '../widgets/dating_widgets.dart';
import '../widgets/shared_widgets.dart';

// ============================================================
// Ortak: modül ekran iskeleti (appbar + kredi rozeti + geri)
// ============================================================
class ModuleScaffold extends StatelessWidget {
  final String title;
  final Widget body;
  const ModuleScaffold({super.key, required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded,
              size: 18, color: AppColors.textSecondary),
          onPressed: () => context.pop(),
        ),
        title: Text(title,
            style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: SafeArea(child: body),
    );
  }
}

/// Paket hakkını düşer; yetmezse nazik "paket hakkın bitti" diyaloğuna yönlendirir.
Future<bool> _charge(BuildContext context, WidgetRef ref, int cost) async {
  final ok = await ref.read(creditsProvider.notifier).spend(cost);
  if (!ok && context.mounted) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.hourglass_empty_rounded,
                color: AppColors.gold, size: 48),
            const SizedBox(height: 12),
            const Text('Paket hakkın bitti',
                style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 8),
            const Text(
                'Abonelik yok. Devam etmek için tek seferlik paket alabilirsin.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textSecondary)),
            const SizedBox(height: 16),
            SizedBox(
              width: 200,
              child: PrimaryButton(
                label: 'Paketleri Gör',
                onPressed: () {
                  Navigator.pop(context);
                  context.push(DatingRoutes.paywall);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
  return ok;
}

Future<List<File>> _pickImages({bool multi = false, int limit = 3}) async {
  final picker = ImagePicker();
  if (multi) {
    final xs = await picker.pickMultiImage(limit: limit);
    return xs.take(limit).map((x) => File(x.path)).toList();
  }
  final x = await picker.pickImage(source: ImageSource.gallery);
  return x == null ? [] : [File(x.path)];
}

/// Tam boy referansta tek yüz olmalı (küçük olabilir). Yaw serbest —
/// canlı yüz açıları GuidedCaptureScreen'de zaten doğrulanır.
Future<bool> _isValidBodyReferencePhoto(File file) async {
  // GEVŞETİLDİ (2026-07-26): uzaktan çekilmiş gerçek tam boy karelerde yüz çok
  // küçük kalıp minFaceSize:0.03 ile tespit edilemiyor, foto boşuna
  // reddediliyordu. Eşik 0.03 -> 0.01. Ayrıca "tam olarak 1 yüz" katı şartı
  // yerine "en az 1 yüz" (arkada geçen kişiler yüzünden ret olmasın) — asıl
  // tek-yüz/+18 kontrolü sunucudaki prepareReferencePhotos'ta zaten var.
  final detector = FaceDetector(
    options: FaceDetectorOptions(
      performanceMode: FaceDetectorMode.accurate,
      minFaceSize: 0.01,
    ),
  );
  try {
    final faces =
        await detector.processImage(InputImage.fromFilePath(file.path));
    return faces.isNotEmpty;
  } catch (_) {
    return false;
  } finally {
    await detector.close();
  }
}

// ============================================================
// 1) AI DATING FOTOĞRAFI — önce stil/mekan seç → paket → üret
// ============================================================
class AiPhotoFlow extends ConsumerStatefulWidget {
  const AiPhotoFlow({super.key});
  @override
  ConsumerState<AiPhotoFlow> createState() => _AiPhotoFlowState();
}

enum _AiStage { style, package, loading, result, error, teaser }

class _AiPhotoFlowState extends ConsumerState<AiPhotoFlow> {
  // STİL KATEGORİLERİ KALDIRILDI (2026-08-02): taban görseller artık tek düz
  // havuzda (Storage: dating_templates/) ve her üretimde oradan rastgele —
  // önceki işlerde kullanılmayanlara öncelikle — 5 tane seçiliyor (bkz.
  // falPhotos.js pickTemplatesFromPool). Bu yüzden stil seçim adımı atlanır
  // ve akış doğrudan selfie/paket adımıyla başlar.
  //
  // Sunucu API'si hâlâ "styles" dizisi bekliyor (cüzdan/chunk/iade mantığı
  // stil birimi üzerinden çalışıyor) — tek sabit birim gönderiliyor. _AiStage
  // .style ve _styleStep() kodu SİLİNMEDİ; kategoriler geri gelirse
  // _stage'i tekrar .style yapmak yeterli.
  static const String _defaultStyleId = 'elegance';
  _AiStage _stage = _AiStage.package;
  final Set<String> _styles = {_defaultStyleId};
  /// Canlı ön / sağ / sol (sıra sabit).
  final List<File> _facePhotos = [];
  /// Zorunlu tam boy (kamera veya galeri).
  File? _bodyPhoto;
  String? _errorMessage;
  bool _validatingPhotos = false; // tam boy yüz kontrolü
  bool _preparing = false; // "Oluştur"a basıldı → sunucu doğrulaması sürüyor
  String? _prepareError; // doğrulama başarısızsa paket adımında gösterilir
  // Kullanıcının bastığı üretim butonunun modu — bakiye yetmeyip paywall'a
  // gidildiğinde, dönüşteki otomatik üretimin AYNI modu kullanması için
  // saklanır (bkz. _openPaywallThenMaybeGenerate).
  String _lastMode = 'full';

  bool get _refsReady =>
      _facePhotos.length == DatingConfig.faceCaptureCount && _bodyPhoto != null;

  List<File> get _allReferencePhotos => [
        ..._facePhotos,
        ?_bodyPhoto,
      ];

  // fal.ai üretim işi takibi
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _jobSub;
  Map<String, dynamic>? _jobData;
  // startPhotoGeneration çağrısı network hatasıyla düşerse (bkz. _generate)
  // sunucunun gerçekte işi başlatıp başlatmadığı belirsizdir; bu süre
  // dolmadan Firestore'dan 'generating'/'done'/'failed' gelmezse asıl hata
  // gösterilir (aksi halde kullanıcı sonsuza kadar loading'de kalır).
  Timer? _jobTimeoutTimer;
  // Sonuç ekranındaki "Fotoğraflar" / "Elenen Kareler" geçişi — yalnızca
  // _rejectedFrames doluyken görünür (bkz. _resultStep).
  bool _showRejected = false;

  // Adım adım yükleme mesajları. Üretim (chunk başına kalite kapıları +
  // gerekirse farklı şablonla yeniden deneme, bkz. falPhotos.js
  // OPENAI_DIRECT_MAX_ATTEMPTS) genelde 5-6 dakika sürer — mesajlar bunu
  // bilerek kullanıcıya bekleme süresini önceden söylüyor ve döngü (bkz.
  // AiLoadingView.stepInterval) birkaç kez tekrar edecek kadar yavaş.
  static const _uploadingSteps = ['Üretim başlatılıyor…'];
  static const _generatingSteps = [
    'Yüzün referans alınıyor…',
    'Bu üretim genelde 5-6 dakika sürer…',
    'Sahneler uygulanıyor…',
    'Kalite kontrolleri yapılıyor, düşük kaliteli kareler otomatik eleniyor…',
    'Bazı kareler daha iyi hâle getiriliyor…',
    'Hâlâ çalışıyoruz, son adımlar biraz uzun sürebilir…',
    'Son kontroller…',
  ];

  // Her seçilen stil DatingConfig.photosPerSet foto üretir (ör. 1 stil → 10,
  // 5 stil → 50). Paket bakiyesi de "stil" cinsinden tutulur.
  int get _photoCount => _styles.length * DatingConfig.photosPerSet;

  /// Erişim etiketi: paket bakiyesi varsa kalan hak, yoksa nazik bir davet.
  String get _accessLabel {
    final left = ref.read(packBalanceProvider).photo; // üretim hakkı cinsinden
    if (left > 0) return 'Paketinde $left üretim hakkın var';
    return 'Fotoğraflarını oluşturmaya hazırsın';
  }

  @override
  void dispose() {
    _jobSub?.cancel();
    _jobTimeoutTimer?.cancel();
    super.dispose();
  }

  /// İKİ AŞAMALI ÜRETİM.
  ///
  /// AŞAMA 1 — DOĞRULAMA (loader YOK, kredi harcanmaz): referans fotoğraflar Storage'a
  /// yüklenir ve `prepareReferencePhotos` çağrılır; bu adım fotoğraflarla ilgili
  /// TÜM kapıları (+18/uygunsuz içerik, net/tek yüz) çalıştırır. Başarısız
  /// olursa kullanıcı paket adımında kalır ve hatayı görür — fotoğrafını
  /// değiştirebilir. Loader HİÇ başlamaz.
  ///
  /// AŞAMA 2 — ÜRETİM (loader burada başlar): doğrulama geçtiyse loader gösterilir
  /// ve `startPhotoGeneration` çağrılır (bakiye burada düşülür). Yani loader
  /// başladıysa, fotoğraflar zaten sorunsuz demektir.
  /// modelId: 'gpt-image-2' -> sunucuda doğrudan OpenAI yolu kullanılır.
  /// mode: prompt stratejisi (A/B karşılaştırması için 3 buton):
  ///   'full'   -> tek atım, kapsamlı prompt (mevcut/varsayılan sürüm)
  ///   'staged' -> 3 ardışık üretim (kimlik -> geometri/bakış -> ışık), 3x maliyet
  ///   'short'  -> tek atım, kısaltılmış prompt
  Future<void> _generate({String? modelId, String? mode}) async {
    if (!_refsReady || _styles.isEmpty) return;
    if (mode != null) _lastMode = mode;

    var answers = ref.read(datingAnswersProvider);
    if (answers.bodyType == null || answers.heightRange == null) {
      final filled = await _ensureBodyProfile();
      if (!filled || !mounted) return;
      answers = ref.read(datingAnswersProvider);
    }

    // Bakiye/ücretsiz hak yetmiyorsa SUNUCUYA HİÇ GİTME: ne fal.ai kredisi ne
    // de paket hakkı harcanır. Bunun yerine blurlu "teaser" gösterilir; blura
    // dokununca paket ekranına yönlendirilir.
    final pack = ref.read(packBalanceProvider);
    if (!pack.canAffordStyles(_styles.length)) {
      setState(() {
        _stage = _AiStage.teaser;
        _errorMessage = null;
      });
      return;
    }

    final uid = ref.read(authServiceProvider).uid;
    if (uid == null) {
      setState(() {
        _stage = _AiStage.error;
        _errorMessage = 'Giriş yapılmamış. Lütfen tekrar dene.';
      });
      return;
    }

    final jobId = const Uuid().v4();
    final functions = FirebaseFunctions.instanceFor(region: 'europe-west1');
    final refs = _allReferencePhotos;

    // ---- AŞAMA 1: DOĞRULAMA (loader yok) ----
    setState(() {
      _preparing = true;
      _prepareError = null;
    });
    try {
      for (var i = 0; i < refs.length; i++) {
        await FirebaseStorage.instance
            .ref('dating_training/$uid/$jobId/photo_$i.jpg')
            .putFile(refs[i]);
      }
      await functions
          .httpsCallable(
            'prepareReferencePhotos',
            options: HttpsCallableOptions(
              // Sunucu tarafı timeoutSeconds:180 (bkz. falPhotos.js) — kimlik/
              // beden/wardrobe caption'ları için birden çok Gemini modeli
              // sırayla denenebiliyor. İstemci varsayılanı (70sn) bundan kısa
              // olduğu için sunucu işi BAŞARIYLA bitirse bile istemci erkenden
              // "deadline-exceeded" fırlatıyordu (gerçek örnek: 2026-08-02,
              // sunucu 120.7sn'de 200 döndü ama istemci çoktan vazgeçmişti).
              timeout: const Duration(seconds: 180),
            ),
          )
          .call({
        'jobId': jobId,
        'styles': _styles.toList(),
        'bodyProfile': {
          'heightRange': answers.heightRange,
          'bodyType': answers.bodyType,
          'gender': answers.gender,
        },
      });
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      // Fotoğraf kaynaklı hata: paket adımında kal, kullanıcı fotoğrafını
      // değiştirsin. Loader hiç başlamadı, kredi harcanmadı.
      final detail = e.message?.trim();
      setState(() {
        _preparing = false;
        _prepareError = (detail != null && detail.isNotEmpty)
            ? detail
            : 'Fotoğraflar doğrulanamadı. Lütfen tekrar dene.';
      });
      return;
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _preparing = false;
        _prepareError = 'Fotoğraflar doğrulanamadı. Lütfen tekrar dene.';
      });
      return;
    }

    if (!mounted) return;

    // ---- AŞAMA 2: ÜRETİM (loader burada başlar) ----
    setState(() {
      _preparing = false;
      _prepareError = null;
      _stage = _AiStage.loading;
      _errorMessage = null;
    });

    try {
      await functions
          .httpsCallable(
            'startPhotoGeneration',
            options: HttpsCallableOptions(
              // GPT2 (OpenAI direct) yolu senkron çalışıyor ve tüm fotoğraflar
              // bitene kadar dönmüyor (bkz. falPhotos.js runOpenAiDirectChunk) —
              // istemci timeout'u sunucudaki timeoutSeconds (900s, 2026-08-16'da
              // OPENAI_DIRECT_MAX_ATTEMPTS 2->6 olunca 540'tan yükseltildi) ile
              // eşleşmeli, yoksa sunucu hâlâ üretirken istemci "deadline-exceeded"
              // fırlatıyor (bkz. 2026-08-15 gerçek olay, aynı kökten uyumsuzluk).
              timeout: const Duration(seconds: 900),
            ),
          )
          .call({
        'styles': _styles.toList(),
        'jobId': jobId,
        'model': ?modelId,
        'mode': ?mode,
      });

      if (!mounted) return;
      _listenToJob(uid, jobId);
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      // 'deadline-exceeded'/'unavailable' istemcinin bağlantıyı/isteği
      // kaybettiği anlamına gelir — SUNUCUYA ulaşmış olabilir (bkz.
      // startPhotoGeneration: bakiye düşümü + job='generating' yazımı TEK
      // transaction, istemcinin ardından bağlantıyı kaybetmesinden bağımsız
      // sürer, bkz. 2026-08-15 "network connection lost" olayı — job arka
      // planda 10/10 tamamlandı ama istemci hiç görmedi). Doğrudan hata
      // göstermek yerine aynı jobId ile gerçek durumu bekleyelim.
      if (e.code == 'deadline-exceeded' || e.code == 'unavailable') {
        _listenToJob(uid, jobId, fallbackErrorMessage: e.message?.trim());
        return;
      }
      setState(() {
        _stage = _AiStage.error;
        final detail = e.message?.trim();
        _errorMessage = (detail != null && detail.isNotEmpty)
            ? detail
            : switch (e.code) {
                'unauthenticated' => 'Giriş yapman gerekiyor.',
                'failed-precondition' =>
                  'Paket bakiyen yetersiz veya ücretsiz deneme hakkın bitti. '
                      'Devam etmek için AI Foto paketi al.',
                _ => 'Üretim başlatılamadı (${e.code}). Lütfen tekrar dene.',
              };
      });
    } catch (e) {
      if (!mounted) return;
      // FirebaseFunctionsException DIŞINDA (soket kopması, DNS hatası vb.)
      // de aynı belirsizlik geçerli — yukarıdaki gerekçeyle aynı fallback.
      _listenToJob(uid, jobId, fallbackErrorMessage: 'Üretim başlatılamadı. Lütfen tekrar dene.');
    }
  }

  void _listenToJob(String uid, String jobId, {String? fallbackErrorMessage}) {
    _jobSub?.cancel();
    _jobTimeoutTimer?.cancel();
    // İstek sunucuya hiç ulaşmadıysa (gerçek network kopması) Firestore'da
    // hiçbir zaman bu jobId için doküman oluşmaz — sonsuza kadar loading'de
    // kalınmasın diye bir süre sonra asıl hatayı göster.
    if (fallbackErrorMessage != null) {
      _jobTimeoutTimer = Timer(const Duration(seconds: 90), () {
        if (!mounted) return;
        if (_stage == _AiStage.loading) {
          setState(() {
            _stage = _AiStage.error;
            _errorMessage = fallbackErrorMessage;
          });
        }
      });
    }
    _jobSub = FirebaseFirestore.instance
        .doc('users/$uid/private/genData/genJobs/$jobId')
        .snapshots()
        .listen((snap) {
      final data = snap.data();
      if (data == null || !mounted) return;
      setState(() {
        _jobData = data;
        final status = data['status'] as String?;
        if (status == 'failed') {
          _jobTimeoutTimer?.cancel();
          _stage = _AiStage.error;
          _errorMessage =
              data['errorMessage'] as String? ?? 'Üretim başarısız oldu.';
        } else if (status == 'done' || _resultUrls.isNotEmpty) {
          _jobTimeoutTimer?.cancel();
          // Üretim yalnızca ödenen (veya ücretsiz hakla açılan) stiller için
          // çalıştı; dolayısıyla dönen TÜM fotolar zaten ödenmiştir — hepsi
          // açık gösterilir, ekstra kilit/blur yok.
          _stage = _AiStage.result;
        } else if (status == 'generating') {
          // Sunucuya gerçekten ulaşmıştı — job canlı, fallback'e gerek yok.
          _jobTimeoutTimer?.cancel();
        }
      });
    });
  }

  /// Şu anki üretim aşamasına göre yükleme adımlarını döner.
  List<String> get _loadingSteps {
    final status = _jobData?['status'] as String?;
    switch (status) {
      case 'generating':
        return _generatingSteps;
      default:
        return _uploadingSteps;
    }
  }

  /// Firestore job dokümanındaki sonuç fotoğraflarını (gs:// URL'leri) tek
  /// düz liste hâlinde döner.
  List<String> get _resultUrls {
    final results = _jobData?['results'] as Map<String, dynamic>?;
    if (results == null) return [];
    final urls = <String>[];
    for (final entry in results.values) {
      final map = entry as Map<String, dynamic>;
      urls.addAll((map['photoUrls'] as List?)?.cast<String>() ?? []);
    }
    return urls;
  }

  /// Kalite kapılarından geçemeyip elenen kareler (bkz. functions/falPhotos.js
  /// saveRejectedFrame'in Firestore yazımı) — "gerçek çıktı" sayısına dahil
  /// DEĞİL, yalnızca "Elenen Kareler" panelinde gösterilir.
  List<Map<String, dynamic>> get _rejectedFrames =>
      (_jobData?['rejectedFrames'] as List?)?.cast<Map<String, dynamic>>() ??
      const [];

  void _reset() {
    _jobSub?.cancel();
    _jobTimeoutTimer?.cancel();
    setState(() {
      // Stil seçimi kalktı — başlangıç adımı doğrudan selfie/paket adımı
      // ve sabit tek birim (bkz. _defaultStyleId).
      _stage = _AiStage.package;
      _facePhotos.clear();
      _bodyPhoto = null;
      _styles
        ..clear()
        ..add(_defaultStyleId);
      _jobData = null;
      _showRejected = false;
      _errorMessage = null;
      _preparing = false;
      _prepareError = null;
    });
  }

  /// Eski hesaplarda onboarding'de boy/tip yoksa üretim öncesi bir kez sor.
  Future<bool> _ensureBodyProfile() async {
    String? bodyType = ref.read(datingAnswersProvider).bodyType;
    String? heightRange = ref.read(datingAnswersProvider).heightRange;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(builder: (ctx, setModal) {
          return Padding(
            padding: EdgeInsets.fromLTRB(
                20, 16, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Son bir adım',
                    style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary)),
                const SizedBox(height: 6),
                const Text(
                    'Boy ve vücut tipin tam boy fotoğraflarda oran için kullanılır.',
                    style: TextStyle(
                        fontSize: 13, color: AppColors.textSecondary)),
                const SizedBox(height: 14),
                const Text('Vücut tipi',
                    style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: AppColors.textPrimary)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final o in const [
                      ['slim', 'İnce'],
                      ['athletic', 'Atletik'],
                      ['average', 'Ortalama'],
                      ['solid', 'Dolgun'],
                    ])
                      ChoiceChip(
                        label: Text(o[1]),
                        selected: bodyType == o[0],
                        onSelected: (_) => setModal(() => bodyType = o[0]),
                      ),
                  ],
                ),
                const SizedBox(height: 14),
                const Text('Boy',
                    style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: AppColors.textPrimary)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final r in const [
                      ['under160', '<160'],
                      ['160-165', '160–165'],
                      ['165-170', '165–170'],
                      ['170-175', '170–175'],
                      ['175-180', '175–180'],
                      ['180-185', '180–185'],
                      ['185-190', '185–190'],
                      ['190+', '190+'],
                    ])
                      ChoiceChip(
                        label: Text(r[1]),
                        selected: heightRange == r[0],
                        onSelected: (_) => setModal(() => heightRange = r[0]),
                      ),
                  ],
                ),
                const SizedBox(height: 18),
                PrimaryButton(
                  label: 'Kaydet ve devam et',
                  onPressed: (bodyType != null && heightRange != null)
                      ? () {
                          ref
                              .read(datingAnswersProvider.notifier)
                              .setBodyType(bodyType!);
                          ref
                              .read(datingAnswersProvider.notifier)
                              .setHeightRange(heightRange!);
                          Navigator.pop(ctx, true);
                        }
                      : null,
                ),
              ],
            ),
          );
        });
      },
    );
    return ok == true;
  }

  Future<void> _captureFaceAngles() async {
    // KREDİ KAPISI: selfie çekmeye (kamera izni, zaman, çaba) BAŞLAMADAN önce
    // bakiye/ücretsiz hak kontrol edilir — yoksa doğrudan pakete yönlendirilir.
    // Kullanıcı boşuna selfie çekip en sonda paywall'a çarpmaz.
    if (!await _ensureCanAfford()) return;
    if (!mounted) return;

    // Kamera (rehberli canlı açı çekimi) VEYA galeriden seçim — test kolaylığı
    // için galeri de destekleniyor.
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Yüz fotoğrafları',
                  style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
              const SizedBox(height: 6),
              Text(
                  'Önden ve iki yandan ${DatingConfig.faceCaptureCount} kare. '
                  'Rehberli çekim en iyi sonucu verir; galeriden de seçebilirsin.',
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.textSecondary)),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: () => Navigator.pop(ctx, 'camera'),
                icon: const Icon(Icons.photo_camera_outlined,
                    color: AppColors.gold),
                label: const Text('Rehberli çekim (kamera)',
                    style: TextStyle(color: AppColors.gold)),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => Navigator.pop(ctx, 'gallery'),
                icon: const Icon(Icons.photo_library_outlined,
                    color: AppColors.gold),
                label: Text('Galeriden ${DatingConfig.faceCaptureCount} foto seç',
                    style: const TextStyle(color: AppColors.gold)),
              ),
            ],
          ),
        ),
      ),
    );
    if (choice == null || !mounted) return;

    if (choice == 'camera') {
      final files = await Navigator.of(context).push<List<File>>(
        MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => const GuidedCaptureScreen(kind: CaptureKind.face),
        ),
      );
      if (files == null || files.length != DatingConfig.faceCaptureCount) return;
      if (!mounted) return;
      setState(() {
        _facePhotos
          ..clear()
          ..addAll(files);
        _prepareError = null;
      });
      return;
    }

    // Galeri: tam olarak faceCaptureCount adet foto seçilmeli. Canlı açı
    // doğrulaması yapılamaz (kayıtlı fotoğraf), ama her karede tek net yüz
    // olduğu hafifçe kontrol edilir — kalan +18/tek-yüz kapıları sunucudaki
    // prepareReferencePhotos'ta zaten çalışıyor.
    final picked =
        await _pickImages(multi: true, limit: DatingConfig.faceCaptureCount);
    if (!mounted) return;
    if (picked.length != DatingConfig.faceCaptureCount) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
            'Tam olarak ${DatingConfig.faceCaptureCount} fotoğraf seçmelisin '
            '(önden ve iki yandan).'),
      ));
      return;
    }
    setState(() => _validatingPhotos = true);
    for (final f in picked) {
      final ok = await _isValidBodyReferencePhoto(f);
      if (!mounted) return;
      if (!ok) {
        setState(() => _validatingPhotos = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'Seçtiğin fotoğraflardan birinde net, tek bir yüz görünmüyor. '
              'Lütfen yüzün belirgin göründüğü kareler seç.'),
        ));
        return;
      }
    }
    setState(() {
      _validatingPhotos = false;
      _facePhotos
        ..clear()
        ..addAll(picked);
      _prepareError = null;
    });
  }

  Future<void> _pickFullBody() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Tam boy fotoğraf',
                  style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
              const SizedBox(height: 6),
              const Text(
                  'Başın ve ayakların kadrajda olsun. Tek kişi, dikey çekim.',
                  style: TextStyle(
                      fontSize: 13, color: AppColors.textSecondary)),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: () => Navigator.pop(ctx, 'camera'),
                icon: const Icon(Icons.photo_camera_outlined,
                    color: AppColors.gold),
                label: const Text('Kamerayla çek',
                    style: TextStyle(color: AppColors.gold)),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => Navigator.pop(ctx, 'gallery'),
                icon: const Icon(Icons.photo_library_outlined,
                    color: AppColors.gold),
                label: const Text('Galeriden seç',
                    style: TextStyle(color: AppColors.gold)),
              ),
            ],
          ),
        ),
      ),
    );
    if (choice == null || !mounted) return;

    File? file;
    if (choice == 'camera') {
      final files = await Navigator.of(context).push<List<File>>(
        MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => const GuidedCaptureScreen(
            kind: CaptureKind.body,
            angles: [CaptureAngle.front],
          ),
        ),
      );
      if (files != null && files.isNotEmpty) file = files.first;
    } else {
      final picked =
          await ImagePicker().pickImage(source: ImageSource.gallery);
      if (picked != null) file = File(picked.path);
    }
    if (file == null || !mounted) return;

    setState(() => _validatingPhotos = true);
    final ok = await _isValidBodyReferencePhoto(file);
    if (!mounted) return;
    setState(() => _validatingPhotos = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text(
            'Tam boy fotoğrafta net, tek bir yüz görünmeli. Lütfen başka bir '
            'kare dene (baş ve ayaklar kadrajda olsun).'),
      ));
      return;
    }
    setState(() {
      _bodyPhoto = file;
      _prepareError = null;
    });
  }

  void _openStyleSheet(PhotoStyle style) {
    final selected = _styles.contains(style.id);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (ctx) {
        return Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            12,
            20,
            20 + MediaQuery.of(ctx).padding.bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.borderSubtle,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Icon(style.icon, color: AppColors.gold, size: 24),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      style.label,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                        color: AppColors.textPrimary,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                style.description,
                style: const TextStyle(
                  fontSize: 13,
                  color: AppColors.textSecondary,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Bu stilde üretilecek örnek kareler',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.5,
                  color: AppColors.textMuted,
                ),
              ),
              const SizedBox(height: 10),
              SizedBox(
                height: 140,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: 3,
                  separatorBuilder: (_, _) => const SizedBox(width: 10),
                  itemBuilder: (_, i) => DatingModuleImage(
                    assetPath: DatingAssetPaths.styleSample(style.id, i + 1),
                    width: 105,
                    height: 140,
                    fallbackIcon: style.icon,
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
              ),
              const SizedBox(height: 18),
              PrimaryButton(
                label: selected ? 'Seçimi Kaldır' : 'Bu Stili Seç',
                onPressed: () {
                  setState(() {
                    if (selected) {
                      _styles.remove(style.id);
                    } else {
                      _styles.add(style.id);
                    }
                  });
                  Navigator.pop(ctx);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'AI Dating Fotoğrafı',
      body: switch (_stage) {
        _AiStage.style => _styleStep(),
        _AiStage.package => _packageStep(),
        _AiStage.loading => AiLoadingView(
            steps: _loadingSteps,
            hint: 'Bu işlem genelde 5-6 dakika sürer',
            // Sabit süreli değil, geçen gerçek süreye dayalı ilerleme —
            // 5-6 dakikalık gerçek üretim süresince asla %-sinde donmaz
            // (bkz. AiLoadingView.continuousProgress dokümantasyonu).
            continuousProgress: true,
            progressDuration: const Duration(minutes: 5),
            progressCeiling: 0.97,
            stepInterval: const Duration(seconds: 14),
          ),
        _AiStage.result => _resultStep(),
        _AiStage.error => _errorStep(),
        _AiStage.teaser => _teaserStep(),
      },
    );
  }

  Widget _errorStep() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline_rounded,
                color: AppColors.error, size: 48),
            const SizedBox(height: 12),
            Text(_errorMessage ?? 'Bir şeyler ters gitti.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 15, color: AppColors.textSecondary)),
            const SizedBox(height: 20),
            PrimaryButton(label: 'Tekrar Dene', onPressed: _reset),
          ],
        ),
      ),
    );
  }

  /// Bakiye yetmeyince gösterilen "teaser": seçilen stillerin örnek
  /// fotoğrafları BLURLU gösterilir (gerçek üretim YAPILMAZ — ne fal.ai
  /// kredisi ne paket hakkı harcanır). Blura dokununca paket ekranına gidilir;
  /// paket alınırsa üretim otomatik başlar.
  Future<void> _openPaywallThenMaybeGenerate() async {
    await context.push('${DatingRoutes.paywall}?mode=ai_photo');
    if (!mounted) return;
    // Paketten dönüldü: artık karşılanabiliyorsa gerçek üretimi başlat.
    // Kullanıcının bastığı butonun modu korunur (bkz. _lastMode).
    if (ref.read(packBalanceProvider).canAffordStyles(_styles.length)) {
      _generate(modelId: 'gpt-image-2', mode: _lastMode);
    }
  }

  Widget _teaserStep() {
    // Seçilen stillerin örnek görsellerinden blurlu bir vitrin oluştur.
    final previews = <String>[];
    for (final id in _styles) {
      for (int i = 1; i <= 3; i++) {
        previews.add(DatingAssetPaths.styleSample(id, i));
      }
    }
    // Grid'i doldurmak için en az 6 kare (tek stilde 3 örnek → döngüyle tekrar).
    final base = List<String>.from(previews);
    for (int k = 0; previews.length < 6 && base.isNotEmpty; k++) {
      previews.add(base[k % base.length]);
    }

    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Fotoğrafların hazır! 🎉',
                    style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                        color: AppColors.textPrimary)),
                const SizedBox(height: 6),
                const Text(
                    'Fotoğraflarının kilidini açmak için AI Foto paketi al. '
                    'Herhangi bir fotoğrafa dokun.',
                    style: TextStyle(
                        fontSize: 13, color: AppColors.textSecondary)),
                const SizedBox(height: 14),
                GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  crossAxisCount: 2,
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  childAspectRatio: 3 / 4,
                  children: [
                    for (final p in previews) _teaserTile(p),
                  ],
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
          child: Column(
            children: [
              PrimaryButton(
                label: 'Paketi Aç ve Fotoğrafları Gör',
                onPressed: _openPaywallThenMaybeGenerate,
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _reset,
                child: const Text('Vazgeç',
                    style: TextStyle(color: AppColors.textSecondary)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _teaserTile(String assetPath) {
    return GestureDetector(
      onTap: _openPaywallThenMaybeGenerate,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(
          fit: StackFit.expand,
          children: [
            DatingModuleImage(
              assetPath: assetPath,
              fallbackIcon: Icons.auto_awesome,
              borderRadius: BorderRadius.zero,
              alignment: Alignment.center,
            ),
            BackdropFilter(
              filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
              child: Container(color: Colors.black.withValues(alpha: 0.45)),
            ),
            const Center(
              child: Icon(Icons.lock_rounded, color: Colors.white, size: 28),
            ),
          ],
        ),
      ),
    );
  }

  // Adım 1: mekan/stil seç
  Widget _styleStep() {
    return Column(
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 8, 20, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('Önce mekân / stil seç',
                style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary)),
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('Fotoğraflarının hangi tarzda olacağını seç.',
                style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
          ),
        ),
        // Bakiye/seçim bilgisi: kullanıcı kaç stil üretebileceğini üretimden
        // ÖNCE net görsün (her stil 1 paket hakkı = photosPerSet foto). Bakiye 0 ise
        // ilk stil ücretsiz denenebilir.
        Builder(builder: (_) {
          final bal = ref.watch(packBalanceProvider).photo;
          final selected = _styles.length;
          final tooMany = bal > 0 && selected > bal;
          final text = bal > 0
              ? 'Paketinde $bal stil hakkın var · $selected stil seçtin'
              : 'İlk stilin ücretsiz · $selected stil seçtin';
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: tooMany ? AppColors.error.withValues(alpha: 0.12)
                    : AppColors.goldSurface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: tooMany ? AppColors.error : AppColors.borderGold,
                    width: 0.8),
              ),
              child: Row(
                children: [
                  Icon(tooMany ? Icons.warning_amber_rounded
                      : Icons.info_outline_rounded,
                      size: 16,
                      color: tooMany ? AppColors.error : AppColors.gold),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      tooMany
                          ? '$bal stil hakkın var, $selected seçtin. $bal stil '
                              'seç ya da paket al.'
                          : text,
                      style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: tooMany
                              ? AppColors.error
                              : AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
          );
        }),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 1.5,
                children: [
                  for (final s in PhotoStyle.coreStyles)
                    GestureDetector(
                      onTap: () => _openStyleSheet(s),
                      child: Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: _styles.contains(s.id)
                              ? AppColors.goldSurface
                              : AppColors.surface,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(
                              color: _styles.contains(s.id)
                                  ? AppColors.gold
                                  : AppColors.borderSubtle,
                              width: _styles.contains(s.id) ? 1.5 : 1),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(s.icon,
                                color: _styles.contains(s.id)
                                    ? AppColors.gold
                                    : AppColors.textSecondary,
                                size: 26),
                            const Spacer(),
                            Text(s.label,
                                style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w800,
                                    color: _styles.contains(s.id)
                                        ? AppColors.gold
                                        : AppColors.textPrimary)),
                            Text(s.description,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    fontSize: 11,
                                    color: AppColors.textSecondary)),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
              // Stil seçilir seçilmez o stile ait örnek fotoğraflar önizlemesi.
              _stylePreview(),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          child: PrimaryButton(
            label: 'Devam Et',
            onPressed: _styles.isEmpty
                ? null
                : () async {
                    if (await _ensureCanAfford() && mounted) {
                      setState(() => _stage = _AiStage.package);
                    }
                  },
          ),
        ),
      ],
    );
  }

  /// Bakiye/ücretsiz hak var mı? Yoksa pakete yönlendirir ve dönüşte tekrar
  /// bakar. `true` dönerse üretim yolunda ilerlenebilir.
  ///
  /// Selfie çekimi BAŞLAMADAN önce çağrılır (bkz. _captureFaceAngles) —
  /// kullanıcı boşuna selfie çekip en sonda paywall'a çarpmasın diye
  /// (bkz. kullanıcı talebi: "kredi almadan selfie çekmeye izin verme").
  Future<bool> _ensureCanAfford() async {
    if (ref.read(packBalanceProvider).canAffordStyles(_styles.length)) {
      return true;
    }
    await context.push('${DatingRoutes.paywall}?mode=ai_photo');
    if (!mounted) return false;
    return ref.read(packBalanceProvider).canAffordStyles(_styles.length);
  }

  /// Seçilen her stil için örnek fotoğraf önizlemesi. Görseller henüz
  /// oluşturulmadığı için arkada ikon gösterilir (kullanıcı sonradan
  /// gerçek örnek fotoğrafları ekleyecek). Stil seçilir seçilmez belirir.
  Widget _stylePreview() {
    if (_styles.isEmpty) return const SizedBox.shrink();
    final selected = PhotoStyle.coreStyles
        .where((s) => _styles.contains(s.id))
        .toList();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(bottom: 2),
            child: Text('Örnek fotoğraflar',
                style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textPrimary)),
          ),
          const Text('Seçtiğin stilde üretilecek karelerden örnekler.',
              style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          const SizedBox(height: 12),
          for (final s in selected) ...[
            Row(
              children: [
                Icon(s.icon, color: AppColors.gold, size: 18),
                const SizedBox(width: 6),
                Text(s.label,
                    style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        color: AppColors.gold)),
              ],
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 96,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: 3,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (_, i) => DatingModuleImage(
                  assetPath: DatingAssetPaths.styleSample(s.id, i + 1),
                  width: 76,
                  height: 96,
                  fallbackIcon: s.icon,
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
            const SizedBox(height: 14),
          ],
        ],
      ),
    );
  }


  // Adım 2: paket + foto yükle + üret
  Widget _packageStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Paket kartı (seçime göre)
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              gradient: AppColors.goldGradient,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('SENİN PAKETİN',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1)),
                const SizedBox(height: 6),
                // Stil kategorileri kaldırıldı — "N stil" ve stil rozetleri
                // artık kullanıcı için anlamsız (hiç stil seçmiyor), sadece
                // üretilecek foto sayısı gösteriliyor.
                Text('$_photoCount fotoğraf',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 22,
                        fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                Text(_accessLabel,
                    style: const TextStyle(color: Colors.white70)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          const Text(
              '1) Yüz — canlı çekim (ön / sağ / sol)',
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 4),
          const Text(
              'Tek oturumda kamera açık kalır. Yeşil = hazır, kırmızı = '
              'talimatı uygula (daha çok çevir / ortala / ışık).',
              style: TextStyle(
                  fontSize: 12, color: AppColors.textSecondary)),
          const SizedBox(height: 6),
          // Gözler kısık/kapalı olan bir referans, üretilen fotoğraflara
          // "uykulu bakış" olarak yansıyor: model gözün gerçek şeklini KİMLİK
          // sayıp birebir kopyalıyor. Sunucu tarafında gözü apaçık kapalı
          // kareler zaten eleniyor (faceQuality.CLOSED_EYE_MAX) — bu not,
          // kullanıcı o elemeye hiç takılmasın diye önden uyarır.
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: const [
              Icon(Icons.visibility_outlined,
                  size: 14, color: AppColors.gold),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                    'Gözlerin tamamen açık olsun — kısık ya da kapalı gözle '
                    'çekilen kareler, üretilen fotoğraflarda da uykulu görünür.',
                    style: TextStyle(
                        fontSize: 12, color: AppColors.textSecondary)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (_facePhotos.isEmpty)
            Container(
              height: 90,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.borderSubtle),
              ),
              child: const Text('Henüz yüz çekimi yok',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (int i = 0; i < _facePhotos.length; i++)
                  _RemovableThumb(
                    file: _facePhotos[i],
                    onRemove: () => setState(() {
                      _facePhotos.clear();
                      _prepareError = null;
                    }),
                  ),
              ],
            ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed:
                (_preparing || _validatingPhotos) ? null : _captureFaceAngles,
            icon: _validatingPhotos
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppColors.gold),
                  )
                : const Icon(Icons.face_retouching_natural,
                    color: AppColors.gold),
            label: Text(
                _validatingPhotos
                    ? 'Fotoğraflar kontrol ediliyor…'
                    : _facePhotos.isEmpty
                        ? 'Yüz çekimini başlat'
                        : 'Yüz çekimini tekrarla',
                style: const TextStyle(color: AppColors.gold)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderGold),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
          ),
          const SizedBox(height: 22),
          const Text(
              '2) Tam boy — zorunlu',
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 4),
          const Text(
              'Baştan ayağa görünsün. Kamerayla çekebilir veya galeriden seçebilirsin.',
              style: TextStyle(
                  fontSize: 12, color: AppColors.textSecondary)),
          const SizedBox(height: 10),
          if (_bodyPhoto == null)
            Container(
              height: 90,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.borderSubtle),
              ),
              child: const Text('Henüz tam boy foto yok',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            )
          else
            Align(
              alignment: Alignment.centerLeft,
              child: _RemovableThumb(
                file: _bodyPhoto!,
                onRemove: () => setState(() {
                  _bodyPhoto = null;
                  _prepareError = null;
                }),
              ),
            ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: (_preparing || _validatingPhotos) ? null : _pickFullBody,
            icon: _validatingPhotos
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppColors.gold),
                  )
                : const Icon(Icons.accessibility_new_rounded,
                    color: AppColors.gold),
            label: Text(
                _validatingPhotos
                    ? 'Kontrol ediliyor…'
                    : (_bodyPhoto == null
                        ? 'Tam boy ekle'
                        : 'Tam boyu değiştir'),
                style: const TextStyle(color: AppColors.gold)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderGold),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
          ),
          const SizedBox(height: 20),
          if (_prepareError != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.error.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.error.withValues(alpha: 0.4)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.info_outline_rounded,
                      color: AppColors.error, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(_prepareError!,
                        style: const TextStyle(
                            fontSize: 13, color: AppColors.textSecondary)),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],
          // A/B karşılaştırması sonucu Buton-5 (p800, ~740 kelime) en tutarlı
          // sonucu verdi — bkz. proje notları. Tek buton olarak o kalıyor;
          // diğer 5 modun kodu (falPhotos.js PHOTO_MODES) ve butonları
          // silinmedi, karşılaştırmaya dönmek istersek yorumdan çıkarılabilir.
          PrimaryButton(
            label: _preparing
                ? 'Fotoğraflar kontrol ediliyor…'
                : 'Fotoğraflarımı Oluştur',
            onPressed: (_refsReady && !_preparing)
                ? () => _generate(modelId: 'gpt-image-2', mode: 'p800')
                : null,
          ),
          // const SizedBox(height: 10),
          // PrimaryButton(
          //   label:
          //       _preparing ? 'Fotoğraflar kontrol ediliyor…' : 'Fotoğraflarımı Oluştur-1',
          //   onPressed: (_refsReady && !_preparing)
          //       ? () => _generate(modelId: 'gpt-image-2', mode: 'full')
          //       : null,
          // ),
          // const SizedBox(height: 10),
          // _AltGenerateButton(
          //   label: 'Fotoğraflarımı Oluştur-2',
          //   hint: '3 aşamalı üretim — daha yavaş, 3x maliyet',
          //   enabled: _refsReady && !_preparing,
          //   onPressed: () => _generate(modelId: 'gpt-image-2', mode: 'staged'),
          // ),
          // const SizedBox(height: 10),
          // _AltGenerateButton(
          //   label: 'Fotoğraflarımı Oluştur-3',
          //   hint: 'Kısa komut (~465 kelime)',
          //   enabled: _refsReady && !_preparing,
          //   onPressed: () => _generate(modelId: 'gpt-image-2', mode: 'short'),
          // ),
          // const SizedBox(height: 10),
          // _AltGenerateButton(
          //   label: 'Fotoğraflarımı Oluştur-4',
          //   hint: 'En yalın komut (~310 kelime)',
          //   enabled: _refsReady && !_preparing,
          //   onPressed: () => _generate(modelId: 'gpt-image-2', mode: 'p300'),
          // ),
          // const SizedBox(height: 10),
          // _AltGenerateButton(
          //   label: 'Fotoğraflarımı Oluştur-5',
          //   hint: 'Orta uzunluk (~740 kelime)',
          //   enabled: _refsReady && !_preparing,
          //   onPressed: () => _generate(modelId: 'gpt-image-2', mode: 'p800'),
          // ),
          // const SizedBox(height: 10),
          // _AltGenerateButton(
          //   label: 'Fotoğraflarımı Oluştur-6',
          //   hint: 'Uzunca komut (~1190 kelime)',
          //   enabled: _refsReady && !_preparing,
          //   onPressed: () => _generate(modelId: 'gpt-image-2', mode: 'p1400'),
          // ),
          const SizedBox(height: 8),
          // Stil kategorileri kaldırıldığı için "← Stili değiştir" bağlantısı
          // da kaldırıldı — artık gidilecek bir stil adımı yok (bkz.
          // _defaultStyleId). Kategoriler geri gelirse yorumdan çıkarılır.
          // Center(
          //   child: TextButton(
          //     onPressed: _preparing
          //         ? null
          //         : () => setState(() => _stage = _AiStage.style),
          //     child: const Text('← Stili değiştir',
          //         style: TextStyle(color: AppColors.textSecondary)),
          //   ),
          // ),
        ],
      ),
    );
  }

  /// Tamamlanan stil sayısı (Firestore'daki `results.{styleId}.status`
  /// alanı 'done' veya 'failed' olanlar — hâlâ 'pending' olanlar hariç).
  ///
  /// Stil kategorileri kaldırıldıktan sonra artık tek birim üretiliyor, bu
  /// yüzden "N/M stil hazır" göstergesi kalktı ve bu getter kullanılmıyor —
  /// kategoriler geri gelirse hazır dursun diye SİLİNMEDİ.
  // ignore: unused_element
  int get _completedStyleCount {
    final results = _jobData?['results'] as Map<String, dynamic>?;
    if (results == null) return 0;
    return results.values
        .cast<Map<String, dynamic>>()
        .where((r) => r['status'] == 'done' || r['status'] == 'failed')
        .length;
  }

  /// Ücretsiz denemede sunucunun HİÇ ÜRETMEDİĞİ (bkz. falPhotos.js
  /// FREE_TIER_CHUNK_COUNT) kalan foto sayısı — stiller toplamı.
  int get _lockedCount {
    final results = _jobData?['results'] as Map<String, dynamic>?;
    if (results == null) return 0;
    var total = 0;
    for (final entry in results.values) {
      final map = entry as Map<String, dynamic>;
      total += (map['lockedCount'] as num?)?.toInt() ?? 0;
    }
    return total;
  }

  Widget _resultStep() {
    final urls = _resultUrls;
    final locked = _lockedCount;
    final rejected = _rejectedFrames;
    final showingRejected = _showRejected && rejected.isNotEmpty;
    final stillGenerating = (_jobData?['status'] as String?) == 'generating';
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Fotoğrafların hazır! 🎉',
              style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 6),
          Text(
            locked > 0
                ? 'İlk fotoğrafın ücretsiz. Kalan $locked fotoğrafın kilidini '
                    'açmak için AI Foto paketi al.'
                : 'Tüm fotoğrafların açık — indirebilir veya paylaşabilirsin.',
            style: const TextStyle(
                fontSize: 13, color: AppColors.textSecondary),
          ),
          if (stillGenerating) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: AppColors.gold),
                ),
                const SizedBox(width: 8),
                const Text(
                    'Fotoğraflar üretiliyor…',
                    style: TextStyle(
                        fontSize: 12, color: AppColors.textSecondary)),
              ],
            ),
          ],
          // EKSİK TESLİM: sunucu, beklenenden az foto üretilen işlerde hakkı
          // iade ediyor (bkz. falPhotos.js "EKSİK TESLİM"). 2026-08-16'dan
          // itibaren bu artık NADİR olmalı — chunk başarısız olursa sunucu
          // 6 denemeye kadar farklı şablonlarla tekrar deniyor (bkz.
          // OPENAI_DIRECT_MAX_ATTEMPTS). Kullanıcı bunu bilmezse iade edilen
          // hakkı kullanmaz — bu yüzden açıkça söyleniyor.
          if (!stillGenerating && _jobData?['incompleteDelivery'] == true) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.gold.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.gold.withValues(alpha: 0.35)),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.card_giftcard, size: 18, color: AppColors.gold),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Bu üretimde beklenenden az fotoğraf çıktı, bu yüzden '
                      'hakkını geri yükledik. Dilediğin zaman '
                      '${DatingConfig.photosPerSet} fotoğrafı yeniden '
                      'oluşturabilirsin.',
                      style: TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          // Elenen kareler (bkz. _rejectedFrames) YALNIZCA varsa gösterilir —
          // çoğu üretimde hiç yok, o zaman geçiş de hiç görünmez.
          if (rejected.isNotEmpty) ...[
            _resultTabToggle(acceptedCount: urls.length, rejectedCount: rejected.length),
            const SizedBox(height: 12),
          ],
          if (showingRejected) ...[
            const Text(
                'Bu kareler kalite kontrolünden geçemedi, bu yüzden çıktı '
                'sayısına dahil edilmedi. Yine de dilersen indirip '
                'kullanabilirsin.',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
            const SizedBox(height: 10),
          ],
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: 2,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            // Hücrelerle içerik aynı orana (3:4) sahip olmalı — aksi halde
            // GridView.count'un varsayılanı (1:1, kare) her hücreyi kare
            // ayırır, içerik 3:4 diye ortalanıp küçülür ve hücrenin kenar
            // boşluklarında görünmez/tıklanamaz bir alan kalır.
            childAspectRatio: 3 / 4,
            children: showingRejected
                ? [
                    for (int i = 0; i < rejected.length; i++)
                      _rejectedTile(rejected, i),
                  ]
                : [
                    for (int i = 0; i < urls.length; i++)
                      _resultTile(urls[i], index: i),
                    for (int i = 0; i < locked; i++) _lockedTile(),
                  ],
          ),
          const SizedBox(height: 16),
          Center(
            child: TextButton(
              onPressed: _reset,
              child: const Text('Yeni Paket Oluştur',
                  style: TextStyle(color: AppColors.textSecondary)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _resultTile(String gsUrl, {required int index}) =>
      GeneratedPhotoTile(gsUrl: gsUrl, allGsUrls: _resultUrls, index: index);

  /// Elenen kare hücresi — kabul edilen fotoğraflarla AYNI görüntüleme/indirme
  /// akışını kullanır (GeneratedPhotoTile), yalnızca gerekçe rozeti eklenir.
  /// `allGsUrls` kasıtlı olarak yalnızca elenen kareler — tam ekranda kaydırma
  /// kabul edilenlerle karışmaz.
  Widget _rejectedTile(List<Map<String, dynamic>> frames, int index) {
    final frame = frames[index];
    return GeneratedPhotoTile(
      gsUrl: frame['gsUrl'] as String,
      allGsUrls: [for (final f in frames) f['gsUrl'] as String],
      index: index,
      badgeLabel: (frame['reason'] as String?) ?? 'Kalite kontrolünden geçemedi',
    );
  }

  /// Sonuç ekranındaki "Fotoğraflar" / "Elenen Kareler" pil geçişi. Bu
  /// modülde gerçek bir TabBar/SegmentedButton yok (bkz. keşif) — mevcut
  /// pill-buton estetiğiyle tutarlı hafif bir Row/InkWell çifti.
  Widget _resultTabToggle({required int acceptedCount, required int rejectedCount}) {
    Widget segment(String label, bool selected, VoidCallback onTap) {
      return Expanded(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: selected ? AppColors.gold : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: selected ? Colors.white : AppColors.textSecondary,
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderGold.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          segment('Fotoğraflar ($acceptedCount)', !_showRejected,
              () => setState(() => _showRejected = false)),
          segment('Elenen Kareler ($rejectedCount)', _showRejected,
              () => setState(() => _showRejected = true)),
        ],
      ),
    );
  }

  /// Ücretsiz denemede üretilmeyen (bkz. lockedCount) foto için kilit kartı.
  /// Bu iş zaten TAMAMLANDI (1 ücretsiz foto teslim edildi) — aynı işe kalan
  /// diğerleri "eklenemez". Bunun yerine: pakete git, satın alınca AYNI
  /// selfie'lerle (yeniden çekmeye gerek yok — _facePhotos/_bodyPhoto hâlâ
  /// bellekte) YENİ bir iş açılır ve artık ücretsiz kota değil gerçek paket
  /// hakkı kullanılıp tam DatingConfig.photosPerSet foto üretilir (bkz.
  /// falPhotos.js FREE_TIER_CHUNK_COUNT).
  Widget _lockedTile() {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () async {
          await context.push('${DatingRoutes.paywall}?mode=ai_photo');
          if (!mounted) return;
          if (ref.read(packBalanceProvider).canAffordStyles(_styles.length)) {
            _generate(modelId: 'gpt-image-2', mode: _lastMode);
          }
        },
        child: const Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.lock_outline_rounded,
                  color: AppColors.textSecondary, size: 28),
              SizedBox(height: 6),
              Text('Paket Al',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textSecondary)),
            ],
          ),
        ),
      ),
    );
  }
}

// ============================================================
// Ortak üretilen-fotoğraf hücresi — hem güncel üretim sonucunda (AiPhotoFlow)
// hem kalıcı "Fotoğraflarım" galerisinde (GeneratedPhotosScreen) kullanılır.
// `gs://bucket/path` biçimindeki bir Firebase Storage URL'ini gerçek bir
// indirme URL'ine çözüp gösterir (Firebase Auth token'ı ile — storage.rules
// yalnızca sahibine izin verir). Dokununca tam ekran görüntüleyici açılır.
// ============================================================
class GeneratedPhotoTile extends StatelessWidget {
  final String gsUrl;
  final List<String> allGsUrls;
  final int index;
  // "Elenen Kareler" panelinde reddedilme gerekçesini gösterir (bkz.
  // functions/falPhotos.js REJECTION_REASON_LABELS) — kabul edilen
  // fotoğraflarda null, tile normal davranır.
  final String? badgeLabel;
  const GeneratedPhotoTile({
    super.key,
    required this.gsUrl,
    required this.allGsUrls,
    required this.index,
    this.badgeLabel,
  });

  @override
  Widget build(BuildContext context) {
    // Material + InkWell KASITLI olarak GestureDetector yerine kullanıldı:
    // InkWell dokunulan alanı görsel olarak (ripple ile) doğrular ve
    // Flutter'ın en test edilmiş tıklanabilir-görsel deseni — GestureDetector
    // + iç içe Stack/ClipRRect/AspectRatio kombinasyonunda dokunma alanının
    // gerçek hücreden küçük kalması ("tıklanmıyor" hissi) riskini ortadan
    // kaldırır.
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => PhotoViewerPage(
              gsUrls: allGsUrls,
              initialIndex: index,
            ),
          ),
        ),
        child: Stack(
          fit: StackFit.expand,
          children: [
            FutureBuilder<String>(
              future:
                  FirebaseStorage.instance.refFromURL(gsUrl).getDownloadURL(),
              builder: (context, snap) {
                if (!snap.hasData) {
                  return Container(
                    color: AppColors.surface,
                    child: const Center(
                      child: SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2.2, color: AppColors.gold),
                      ),
                    ),
                  );
                }
                return CachedNetworkImage(
                  imageUrl: snap.data!,
                  fit: BoxFit.cover,
                  errorWidget: (_, _, _) => Container(
                    color: AppColors.surface,
                    child: const Icon(Icons.broken_image_outlined,
                        color: AppColors.textMuted),
                  ),
                );
              },
            ),
            if (badgeLabel != null)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: IgnorePointer(
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(8, 16, 8, 6),
                    decoration: BoxDecoration(
                      borderRadius: const BorderRadius.vertical(
                          bottom: Radius.circular(14)),
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Colors.black.withValues(alpha: 0),
                          Colors.black.withValues(alpha: 0.72),
                        ],
                      ),
                    ),
                    child: Text(
                      badgeLabel!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          height: 1.2),
                    ),
                  ),
                ),
              ),
            // Büyütme ipucu — fotoğrafın tıklanabilir olduğunu belli eder.
            Positioned(
              right: 6,
              bottom: 6,
              child: IgnorePointer(
                child: Container(
                  padding: const EdgeInsets.all(5),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.45),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.fullscreen_rounded,
                      color: Colors.white, size: 16),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ============================================================
// Kalıcı "Fotoğraflarım" galerisi — TÜM geçmiş üretim işlerindeki fotoğraflar
// tek yerde. Hub'da ayrı bir sekme olarak açılır.
// ============================================================
class GeneratedPhotosScreen extends ConsumerWidget {
  const GeneratedPhotosScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final uid = ref.watch(authServiceProvider).uid;
    if (uid == null) {
      return const Center(
        child: Text('Giriş yapman gerekiyor.',
            style: TextStyle(color: AppColors.textSecondary)),
      );
    }
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance
          .collection('users/$uid/private/genData/genJobs')
          .where('status', isEqualTo: 'done')
          .orderBy('createdAt', descending: true)
          .snapshots(),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Center(
            child: CircularProgressIndicator(color: AppColors.gold),
          );
        }
        // Her işten YALNIZCA 'done' durumundaki stillerin fotoğrafları — iş
        // kısmi başarıyla bittiyse başarısız stillerin boş sonucu atlanır.
        final urls = <String>[];
        for (final doc in snap.data?.docs ?? const []) {
          final results = doc.data()['results'] as Map<String, dynamic>?;
          if (results == null) continue;
          for (final entry in results.values) {
            final map = entry as Map<String, dynamic>;
            if (map['status'] != 'done') continue;
            urls.addAll((map['photoUrls'] as List?)?.cast<String>() ?? []);
          }
        }
        if (urls.isEmpty) {
          return _emptyState(context);
        }
        return GridView.count(
          padding: const EdgeInsets.all(16),
          crossAxisCount: 2,
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 3 / 4,
          children: [
            for (int i = 0; i < urls.length; i++)
              GeneratedPhotoTile(gsUrl: urls[i], allGsUrls: urls, index: i),
          ],
        );
      },
    );
  }

  Widget _emptyState(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.photo_library_outlined,
                color: AppColors.textMuted, size: 48),
            const SizedBox(height: 12),
            const Text('Henüz üretilmiş fotoğrafın yok',
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 6),
            const Text(
                'AI Dating Fotoğrafı modülünden bir set oluşturduğunda '
                'ürettiğin tüm fotoğraflar burada birikir.',
                textAlign: TextAlign.center,
                style:
                    TextStyle(fontSize: 13, color: AppColors.textSecondary)),
            const SizedBox(height: 16),
            PrimaryButton(
              label: 'Fotoğraf Üret',
              onPressed: () =>
                  context.push('${DatingRoutes.module}/ai_photo'),
            ),
          ],
        ),
      ),
    );
  }
}

// ============================================================
// Üretilen fotoğraf görüntüleyici — tam ekran, kaydırmalı, indirilebilir
// ============================================================
class PhotoViewerPage extends StatefulWidget {
  /// `gs://` biçimindeki Storage yolları (sonuç listesinin tamamı).
  final List<String> gsUrls;
  final int initialIndex;
  const PhotoViewerPage({
    super.key,
    required this.gsUrls,
    required this.initialIndex,
  });

  @override
  State<PhotoViewerPage> createState() => _PhotoViewerPageState();
}

class _PhotoViewerPageState extends State<PhotoViewerPage> {
  late final PageController _controller;
  late int _index;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    _controller = PageController(initialPage: _index);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? AppColors.error : null,
      duration: const Duration(seconds: 3),
    ));
  }

  /// Görüntülenen fotoğrafı telefonun galerisine kaydeder.
  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      // Galeri izni (Android 13+ ve iOS için Gal kendi izin akışını yürütür).
      if (!await Gal.hasAccess()) {
        final granted = await Gal.requestAccess();
        if (!granted) {
          _snack('Galeriye kaydetmek için izin gerekiyor.', error: true);
          return;
        }
      }
      final url = await FirebaseStorage.instance
          .refFromURL(widget.gsUrls[_index])
          .getDownloadURL();
      final resp = await Dio().get<List<int>>(
        url,
        options: Options(responseType: ResponseType.bytes),
      );
      final data = resp.data;
      if (data == null || data.isEmpty) {
        _snack('Fotoğraf indirilemedi. Lütfen tekrar dene.', error: true);
        return;
      }
      await Gal.putImageBytes(Uint8List.fromList(data), album: 'Voxen AI');
      _snack('Fotoğraf galerine kaydedildi ✓');
      _logDownload(widget.gsUrls[_index]);
    } on GalException catch (e) {
      _snack('Kaydedilemedi: ${e.type.message}', error: true);
    } catch (_) {
      _snack('Fotoğraf kaydedilemedi. Lütfen tekrar dene.', error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // gs://bucket/dating_results/{uid}/{jobId}/{styleId}_{chunkIdx}_{i}.jpg
  static final RegExp _resultPathPattern =
      RegExp(r'dating_results/[^/]+/([^/]+)/([a-z]+)_(\d+)_(\d+)\.jpg$');

  /// Hangi stilin/sahne varyantının (chunk index) gerçekten indirildiğini
  /// kaydeder — "kullanıcı bunu profiline koyar" kararı, prompt/kompozisyon
  /// iyileştirmeleri için similarity skorundan çok daha anlamlı bir sinyal.
  /// Fail-safe: bu SADECE telemetri, hata olursa sessizce yutulur — indirme
  /// işleminin kendisi zaten tamamlanmış oldu, kullanıcıyı etkilemez.
  Future<void> _logDownload(String gsUrl) async {
    try {
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid == null) return;
      final m = _resultPathPattern.firstMatch(gsUrl);
      if (m == null) return;
      await FirebaseFirestore.instance
          .collection('users/$uid/private/genData/downloads')
          .add({
        'jobId': m.group(1),
        'styleId': m.group(2),
        'chunkIdx': int.tryParse(m.group(3) ?? ''),
        'imageIdx': int.tryParse(m.group(4) ?? ''),
        'createdAt': FieldValue.serverTimestamp(),
      });
    } catch (_) {
      // Sadece telemetri — hata olursa sessizce yut.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            // Üst bar: kapat + sayaç
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.close_rounded, color: Colors.white),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  const Spacer(),
                  Text(
                    '${_index + 1} / ${widget.gsUrls.length}',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w600),
                  ),
                  const Spacer(),
                  const SizedBox(width: 48), // sayacı ortalamak için denge
                ],
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: widget.gsUrls.length,
                onPageChanged: (i) => setState(() => _index = i),
                itemBuilder: (_, i) => _page(widget.gsUrls[i]),
              ),
            ),
            // Alt bar: indir
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white),
                        )
                      : const Icon(Icons.download_rounded),
                  label: Text(_saving ? 'Kaydediliyor…' : 'Telefona İndir'),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _page(String gsUrl) {
    return FutureBuilder<String>(
      future: FirebaseStorage.instance.refFromURL(gsUrl).getDownloadURL(),
      builder: (context, snap) {
        if (!snap.hasData) {
          return const Center(
            child: CircularProgressIndicator(color: AppColors.gold),
          );
        }
        // Çift dokunuş/parmakla yakınlaştırma.
        return InteractiveViewer(
          minScale: 1,
          maxScale: 4,
          child: CachedNetworkImage(
            imageUrl: snap.data!,
            fit: BoxFit.contain,
            errorWidget: (_, _, _) => const Center(
              child: Icon(Icons.broken_image_outlined, color: Colors.white54),
            ),
          ),
        );
      },
    );
  }
}

// ============================================================
// 2) FOTOĞRAF ANALİZİ & SEÇİMİ — yükle → puanla → en iyisi
// ============================================================
class PhotoAnalysisFlow extends ConsumerStatefulWidget {
  const PhotoAnalysisFlow({super.key});
  @override
  ConsumerState<PhotoAnalysisFlow> createState() => _PhotoAnalysisFlowState();
}

class _PhotoAnalysisFlowState extends ConsumerState<PhotoAnalysisFlow> {
  final List<File> _photos = [];
  int _stage = 0; // 0 giriş, 1 loading, 2 sonuç, 3 hata
  int _unlocked = 0; // kaç sonucun kilidi açık (ilk seçilen her zaman ücretsiz)
  bool _validating = false; // seçilen fotolarda yüz kontrolü sürüyor
  // AI'den dönen gerçek puanlama sonuçları — KULLANICININ SEÇTİĞİ sırada.
  List<PhotoScore> _scores = [];
  String? _errorMessage;

  Future<void> _pickAndValidate() async {
    final files = await _pickImages(multi: true, limit: 6);
    if (files.isEmpty) return;
    setState(() => _validating = true);
    // Analiz için her fotoğrafta EN AZ bir yüz olmalı (saçma/yüzsüz foto reddi).
    final invalid = await _findFacelessPhotos(files);
    if (!mounted) return;
    setState(() => _validating = false);
    if (invalid.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(invalid.length == files.length
            ? 'Seçtiğin fotoğraflarda yüz bulunamadı. Analiz için yüzün '
                'net göründüğü fotoğraflar seç.'
            : '${invalid.length} fotoğrafta yüz bulunamadı; bunlar '
                'analiz edilemez. Lütfen yüz içeren fotoğraflar seç.'),
      ));
      if (invalid.length == files.length) return;
    }
    setState(() {
      _photos
        ..clear()
        ..addAll(files.where((f) => !invalid.contains(f.path)));
    });
  }

  Future<void> _run() async {
    if (_photos.isEmpty) return;
    setState(() {
      _stage = 1;
      _errorMessage = null;
      _unlocked = 0; // yeni analiz: önceki oturumdan devretme, alreadyUnlocked=0
    });
    try {
      final scores =
          await ref.read(claudeApiServiceProvider).scoreDatingPhotos(_photos);
      if (!mounted) return;
      // Kaç sonucun açılacağını SUNUCU belirler ve tüketir: hesap başına ömür
      // boyu 1 ücretsiz foto + analysisBalance'tan foto başına 1 hak. Bakiye
      // yetmezse gerisi kilitli (blur) kalır.
      final unlocked = await _consumeAnalysis(scores.length);
      if (!mounted) return;
      setState(() {
        _scores = scores;
        _unlocked = unlocked;
        _stage = 2;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = 3;
        _errorMessage =
            'Analiz şu an yapılamadı. Lütfen biraz sonra tekrar dene.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'Fotoğraf Analizi & Seçimi',
      body: switch (_stage) {
        1 => const AiLoadingView(steps: [
            'Fotoğraflar değerlendiriliyor…',
            'Çekicilik skoru hesaplanıyor…',
            'Güçlü ve zayıf yönler çıkarılıyor…',
          ]),
        2 => _result(),
        3 => _errorView(),
        _ => _intro(),
      },
    );
  }

  Widget _errorView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline_rounded,
                color: AppColors.error, size: 48),
            const SizedBox(height: 12),
            Text(_errorMessage ?? 'Bir şeyler ters gitti.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 15, color: AppColors.textSecondary)),
            const SizedBox(height: 20),
            PrimaryButton(
                label: 'Tekrar Dene',
                onPressed: () => setState(() => _stage = 0)),
          ],
        ),
      ),
    );
  }

  Widget _intro() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Fotoğraflarını yükle, en iyisini seçelim',
              style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 6),
          const Text(
              'Her fotoğrafı puanlar; güçlü/zayıf yönlerini ve nasıl daha iyi '
              'olacağını söyleriz. İlk fotoğrafın analizi ücretsiz.',
              style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
          const SizedBox(height: 16),
          const PhotoQualityGuide(),
          const SizedBox(height: 16),
          if (_photos.isNotEmpty)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (int i = 0; i < _photos.length; i++)
                  _RemovableThumb(
                    file: _photos[i],
                    onRemove: () => setState(() => _photos.removeAt(i)),
                  ),
              ],
            ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _validating ? null : _pickAndValidate,
            icon: _validating
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppColors.gold))
                : const Icon(Icons.add_photo_alternate_outlined,
                    color: AppColors.gold),
            label: Text(
                _validating
                    ? 'Yüzler kontrol ediliyor…'
                    : (_photos.isEmpty ? 'Galeriden Seç' : 'Değiştir'),
                style: const TextStyle(color: AppColors.gold)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderGold),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
          ),
          const SizedBox(height: 20),
          PrimaryButton(
            label: 'Analiz Et',
            onPressed: (_photos.isEmpty || _validating) ? null : _run,
          ),
        ],
      ),
    );
  }

  Widget _result() {
    final lockedCount = _scores.length - _unlocked;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Sonuçlar',
            style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary)),
        const SizedBox(height: 4),
        Text(
            lockedCount > 0
                ? 'İlk fotoğrafın analizi ücretsiz. Kalan $lockedCount fotoğraf '
                    'için paket al.'
                : 'Her fotoğrafa dokunarak detaylı analizini gör.',
            style: const TextStyle(
                fontSize: 13, color: AppColors.textSecondary)),
        const SizedBox(height: 14),
        for (int i = 0; i < _scores.length; i++) _resultCard(i),
        const SizedBox(height: 8),
        if (lockedCount > 0)
          PrimaryButton(
            label: 'Kalan $lockedCount Analizi Aç',
            onPressed: () => _unlockMore(),
          ),
      ],
    );
  }

  Widget _resultCard(int i) {
    final unlocked = i < _unlocked;
    final s = _scores[i];
    return GestureDetector(
      onTap: () => unlocked ? _openDetail(s) : _unlockMore(),
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: SizedBox(
                width: 72,
                height: 72,
                child: unlocked
                    ? Image.file(s.file, fit: BoxFit.cover)
                    : Stack(
                        fit: StackFit.expand,
                        children: [
                          Image.file(s.file, fit: BoxFit.cover),
                          BackdropFilter(
                            filter:
                                ui.ImageFilter.blur(sigmaX: 12, sigmaY: 12),
                            child: Container(
                                color: Colors.black.withValues(alpha: 0.4)),
                          ),
                          const Center(
                              child: Icon(Icons.lock_rounded,
                                  color: Colors.white, size: 22)),
                        ],
                      ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: unlocked
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Fotoğraf ${i + 1}',
                            style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w700,
                                color: AppColors.textSecondary)),
                        const SizedBox(height: 4),
                        Text(
                            s.summary.isNotEmpty
                                ? s.summary
                                : 'Detaylı analizi görmek için dokun.',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.textSecondary,
                                height: 1.3)),
                      ],
                    )
                  : const Text(
                      'Bu fotoğrafın analizi kilitli. Açmak için dokun.',
                      style: TextStyle(
                          fontSize: 13, color: AppColors.textSecondary)),
            ),
            const SizedBox(width: 8),
            if (unlocked)
              _ScoreRing(score: s.score, size: 52)
            else
              const Icon(Icons.chevron_right_rounded,
                  color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }

  void _openDetail(PhotoScore s) {
    final idx = _scores.indexOf(s);
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _PhotoDetailScreen(score: s, label: 'Fotoğraf ${idx + 1}'),
    ));
  }

  /// Paket satın alma akışını (paywall) açar; dönünce mevcut paket
  /// bakiyesiyle kilitli sonuçları yeniden hesaplar.
  Future<void> _unlockMore() async {
    // Kilitli sonuç yoksa (hepsi açık) bir şey yapma.
    if (_unlocked >= _scores.length) return;
    // Paket almadan da bakiye varsa sunucu zaten düşer; yoksa paywall'a git.
    if (ref.read(packBalanceProvider).analysis <= 0) {
      await context.push('${DatingRoutes.paywall}?mode=analysis');
      if (!mounted) return;
    }
    final unlocked = await _consumeAnalysis(_scores.length);
    if (!mounted) return;
    setState(() => _unlocked = unlocked);
  }

  /// Sunucudan kaç sonucun açılacağını atomik olarak ister ve TÜKETİR
  /// (ücretsiz hak + analysisBalance düşümü sunucuda; bkz. consumeAnalysis).
  /// [alreadyUnlocked] bu set için önceden açılmış sayıdır; yalnızca kalanı
  /// için hak/bakiye tüketilir (çift-düşüm önlenir). Ağ/sunucu hatasında
  /// güvenli tarafta kalır: mevcut açık sayıyı korur.
  Future<int> _consumeAnalysis(int requested) async {
    try {
      final res = await FirebaseFunctions.instanceFor(region: 'europe-west1')
          .httpsCallable('consumeAnalysis')
          .call({'requested': requested, 'alreadyUnlocked': _unlocked});
      final data = res.data as Map?;
      return (data?['unlocked'] as num?)?.toInt() ?? _unlocked;
    } catch (e) {
      return _unlocked; // mevcut açık sayıyı koru
    }
  }
}

/// Analiz için yüz kontrolü: her fotoğrafta EN AZ bir yüz olmalı. Yüz
/// bulunamayan (saçma/yüzsüz/bulanık) fotoğrafların yollarını döner.
Future<List<String>> _findFacelessPhotos(List<File> files) async {
  final detector = FaceDetector(
    options: FaceDetectorOptions(
      performanceMode: FaceDetectorMode.accurate,
      minFaceSize: 0.15,
    ),
  );
  final faceless = <String>[];
  try {
    for (final f in files) {
      try {
        final faces =
            await detector.processImage(InputImage.fromFilePath(f.path));
        if (faces.isEmpty) faceless.add(f.path);
      } catch (_) {
        faceless.add(f.path); // okunamadı → analiz edilemez
      }
    }
  } finally {
    await detector.close();
  }
  return faceless;
}

/// Alternatif üretim butonu (A/B karşılaştırması için ikincil stil).
/// Ana "Fotoğraflarımı Oluştur-1" butonundan görsel olarak ayrışsın diye
/// outlined; altında ne yaptığını anlatan kısa bir ipucu satırı var.
class _AltGenerateButton extends StatelessWidget {
  final String label;
  final String hint;
  final bool enabled;
  final VoidCallback onPressed;
  const _AltGenerateButton({
    required this.label,
    required this.hint,
    required this.enabled,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 52,
          child: OutlinedButton(
            onPressed: enabled ? onPressed : null,
            style: OutlinedButton.styleFrom(
              side: BorderSide(
                color: enabled ? AppColors.borderGold : AppColors.borderSubtle,
              ),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16)),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color: enabled ? AppColors.gold : AppColors.textMuted,
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Center(
          child: Text(
            hint,
            style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
          ),
        ),
      ],
    );
  }
}

/// Sağ üstünde kaldırma (çarpı) butonu olan seçilmiş fotoğraf küçük görseli.
class _RemovableThumb extends StatelessWidget {
  final File file;
  final VoidCallback onRemove;
  const _RemovableThumb({required this.file, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Image.file(file, width: 84, height: 84, fit: BoxFit.cover),
        ),
        Positioned(
          top: -6,
          right: -6,
          child: GestureDetector(
            onTap: onRemove,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.7),
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 1.5),
              ),
              child: const Icon(Icons.close_rounded,
                  size: 15, color: Colors.white),
            ),
          ),
        ),
      ],
    );
  }
}

/// Dairesel, animasyonlu skor göstergesi (0-100). Skora göre renk değişir.
class _ScoreRing extends StatelessWidget {
  final int score;
  final double size;
  const _ScoreRing({required this.score, this.size = 60});

  Color get _color {
    if (score >= 80) return AppColors.success;
    if (score >= 60) return AppColors.gold;
    if (score >= 40) return Colors.orangeAccent;
    return AppColors.error;
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: score / 100),
        duration: const Duration(milliseconds: 900),
        curve: Curves.easeOutCubic,
        builder: (context, value, _) => Stack(
          alignment: Alignment.center,
          children: [
            SizedBox(
              width: size,
              height: size,
              child: CircularProgressIndicator(
                value: value,
                strokeWidth: size * 0.09,
                backgroundColor: AppColors.borderSubtle,
                valueColor: AlwaysStoppedAnimation(_color),
                strokeCap: StrokeCap.round,
              ),
            ),
            Text('${(value * 100).round()}',
                style: TextStyle(
                    fontSize: size * 0.3,
                    fontWeight: FontWeight.w900,
                    color: _color)),
          ],
        ),
      ),
    );
  }
}

/// Tek bir fotoğrafın tam ekran detaylı analizi: üstte büyük foto, altında
/// skor + genel değerlendirme + güçlü/zayıf/geliştirilecek bölümleri.
class _PhotoDetailScreen extends StatelessWidget {
  final PhotoScore score;
  final String label;
  const _PhotoDetailScreen({required this.score, required this.label});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded,
              size: 18, color: AppColors.textSecondary),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(label,
            style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          // Üstte büyük fotoğraf
          ClipRRect(
            borderRadius: BorderRadius.circular(20),
            child: AspectRatio(
              aspectRatio: 3 / 4,
              child: Image.file(score.file, fit: BoxFit.cover),
            ),
          ),
          const SizedBox(height: 20),
          // Skor + genel değerlendirme
          Row(
            children: [
              _ScoreRing(score: score.score, size: 72),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Genel Değerlendirme',
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            color: AppColors.textSecondary)),
                    const SizedBox(height: 4),
                    Text(
                        score.summary.isNotEmpty
                            ? score.summary
                            : 'Bu fotoğraf dating profili için değerlendirildi.',
                        style: const TextStyle(
                            fontSize: 14,
                            color: AppColors.textPrimary,
                            height: 1.35)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _detailSection('Güçlü Yönler', Icons.check_circle_rounded,
              AppColors.success, score.strengths),
          _detailSection('Zayıf Yönler', Icons.warning_amber_rounded,
              Colors.orangeAccent, score.weaknesses),
          _detailSection('Geliştirilebilecekler', Icons.lightbulb_outline_rounded,
              AppColors.gold, score.improvements),
        ],
      ),
    );
  }

  Widget _detailSection(
      String title, IconData icon, Color color, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(width: 8),
              Text(title,
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w900,
                      color: color)),
            ],
          ),
          const SizedBox(height: 12),
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Container(
                      width: 6,
                      height: 6,
                      decoration:
                          BoxDecoration(color: color, shape: BoxShape.circle),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(item,
                        style: const TextStyle(
                            fontSize: 13.5,
                            color: AppColors.textPrimary,
                            height: 1.4)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ============================================================
// 3) DATING COACH — direkt chat
// ============================================================
class CoachChatFlow extends ConsumerStatefulWidget {
  const CoachChatFlow({super.key});
  @override
  ConsumerState<CoachChatFlow> createState() => _CoachChatFlowState();
}

class _ChatMsg {
  final String text;
  final bool mine;
  _ChatMsg(this.text, this.mine);
}

class _CoachChatFlowState extends ConsumerState<CoachChatFlow> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  final List<_ChatMsg> _msgs = [
    _ChatMsg('Selam! Ben senin dating koçunum. Durumu anlat ya da eşleşmenin '
        'son mesajını yaz — sana ne yazacağını söyleyeyim. 💬', false),
  ];

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    if (!await _charge(context, ref, DatingConfig.creditsText)) return;
    setState(() {
      _msgs.add(_ChatMsg(text, true));
      _controller.clear();
    });
    _scrollDown();
    await Future.delayed(const Duration(milliseconds: 700));
    // TODO: Gemini chat cloud function ile gerçek koç yanıtı.
    setState(() => _msgs.add(_ChatMsg(
        'Şunu deneyebilirsin: "$text" yerine biraz merak uyandır — açık uçlu '
        'bir soru sor ve hafif esprili ol. Örn: "Bunu tahmin edemezdim 😄 '
        'peki ya sen hafta sonu kaçış mı macera mı?"',
        false)));
    _scrollDown();
  }

  void _scrollDown() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'Dating Coach',
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(16),
              itemCount: _msgs.length,
              itemBuilder: (_, i) => _bubble(_msgs[i]),
            ),
          ),
          _inputBar(),
        ],
      ),
    );
  }

  Widget _bubble(_ChatMsg m) {
    return Align(
      alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        constraints: const BoxConstraints(maxWidth: 280),
        decoration: BoxDecoration(
          color: m.mine ? AppColors.goldSurface : AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: m.mine ? AppColors.borderGold : AppColors.borderSubtle),
        ),
        child: Text(m.text,
            style: TextStyle(
                fontSize: 14,
                height: 1.4,
                color: m.mine
                    ? AppColors.textPrimary
                    : AppColors.textSecondary)),
      ),
    );
  }

  Widget _inputBar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              style: const TextStyle(color: AppColors.textPrimary),
              minLines: 1,
              maxLines: 4,
              decoration: InputDecoration(
                hintText: 'Durumu yaz…',
                hintStyle: const TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.surfaceElevated,
                contentPadding: const EdgeInsets.symmetric(
                    horizontal: 14, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: _send,
            child: Container(
              width: 46,
              height: 46,
              decoration: const BoxDecoration(
                  color: AppColors.gold, shape: BoxShape.circle),
              child: const Icon(Icons.send_rounded, color: Colors.white),
            ),
          ),
        ],
      ),
    );
  }
}

// ============================================================
// 4) RIZZGPT — konuşma ekran görüntüsü → esprili cevap
// ============================================================
class RizzFlow extends ConsumerStatefulWidget {
  const RizzFlow({super.key});
  @override
  ConsumerState<RizzFlow> createState() => _RizzFlowState();
}

class _RizzFlowState extends ConsumerState<RizzFlow> {
  File? _shot;
  int _stage = 0; // 0 giriş, 1 loading, 2 sonuç

  Future<void> _run() async {
    if (_shot == null) return;
    if (!await _charge(context, ref, DatingConfig.creditsText)) return;
    setState(() => _stage = 1);
    await Future.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _stage = 2);
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'RizzGPT',
      body: _stage == 1
          ? const AiLoadingView(steps: [
              'Ekran görüntüsü okunuyor…',
              'Konuşma tonu analiz ediliyor…',
              'Esprili cevaplar hazırlanıyor…',
            ])
          : _stage == 2
              ? _result()
              : _intro(),
    );
  }

  Widget _intro() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Konuşmanın ekran görüntüsünü yükle',
              style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 6),
          const Text('Sana esprili ve çekici cevap önerileri hazırlayalım.',
              style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
          const SizedBox(height: 16),
          GestureDetector(
            onTap: () async {
              final files = await _pickImages();
              if (files.isNotEmpty) setState(() => _shot = files.first);
            },
            child: Container(
              height: _shot == null ? 160 : 280,
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.borderGold),
              ),
              child: _shot == null
                  ? const Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.add_a_photo_outlined,
                            color: AppColors.gold, size: 34),
                        SizedBox(height: 8),
                        Text('Ekran görüntüsü ekle',
                            style: TextStyle(color: AppColors.textSecondary)),
                      ],
                    )
                  : ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: Image.file(_shot!, fit: BoxFit.contain),
                    ),
            ),
          ),
          const SizedBox(height: 20),
          PrimaryButton(
            label: 'Cevap Üret (${DatingConfig.creditsText} kredi)',
            onPressed: _shot == null ? null : _run,
          ),
        ],
      ),
    );
  }

  Widget _result() {
    const replies = [
      'Bunu itiraf etmen cesaret ister 😏 ben de mesajını iki kez okudum.',
      'Tehlikeli sular… çünkü şimdi seninle nereye kadar gideceğimizi merak '
          ' diyorum. Kahve mi, macera mı?',
      'Tamam kabul, bu kadar iyi yazınca sıradaki hamleyi sana bırakamam. '
          'Cumartesi müsait misin?',
    ];
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Önerilen cevaplar',
            style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary)),
        const SizedBox(height: 12),
        for (final r in replies)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.borderSubtle),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(r,
                      style: const TextStyle(
                          fontSize: 14,
                          color: AppColors.textPrimary,
                          height: 1.4)),
                ),
                const SizedBox(width: 8),
                const Icon(Icons.copy_rounded,
                    color: AppColors.textMuted, size: 18),
              ],
            ),
          ),
        const SizedBox(height: 4),
        _backendNote(),
        const SizedBox(height: 12),
        PrimaryButton(
            label: 'Başka Görüntü', onPressed: () => setState(() {
              _stage = 0;
              _shot = null;
            })),
      ],
    );
  }
}

// ============================================================
// 5) BIO & PROMPT — "profilimi analiz et" → ekran görüntüleri → geri dönüş
// ============================================================
class BioFlow extends ConsumerStatefulWidget {
  const BioFlow({super.key});
  @override
  ConsumerState<BioFlow> createState() => _BioFlowState();
}

class _BioFlowState extends ConsumerState<BioFlow> {
  final List<File> _shots = [];
  int _stage = 0;

  Future<void> _run() async {
    if (_shots.isEmpty) return;
    if (!await _charge(context, ref, DatingConfig.creditsText)) return;
    setState(() => _stage = 1);
    await Future.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _stage = 2);
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'Bio & Prompt Yardımcısı',
      body: _stage == 1
          ? const AiLoadingView(steps: [
              'Profilin okunuyor…',
              'Bio ve promptlar değerlendiriliyor…',
              'Geri bildirim hazırlanıyor…',
            ])
          : _stage == 2
              ? _result()
              : _intro(),
    );
  }

  Widget _intro() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: AppColors.goldSurface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.borderGold),
            ),
            child: const Row(
              children: [
                Icon(Icons.edit_note, color: AppColors.gold, size: 32),
                SizedBox(width: 14),
                Expanded(
                  child: Text(
                      'Profilinin ekran görüntülerini yükle; bio ve '
                      'promptlarını analiz edip daha çekici hale getirelim.',
                      style: TextStyle(
                          fontSize: 14,
                          color: AppColors.textPrimary,
                          height: 1.4)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (_shots.isNotEmpty)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final f in _shots)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(f,
                        width: 84, height: 84, fit: BoxFit.cover),
                  ),
              ],
            ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () async {
              final files = await _pickImages(multi: true, limit: 4);
              if (files.isNotEmpty) {
                setState(() => _shots
                  ..clear()
                  ..addAll(files));
              }
            },
            icon: const Icon(Icons.add_photo_alternate_outlined,
                color: AppColors.gold),
            label: const Text('Profil Ekran Görüntüsü Ekle',
                style: TextStyle(color: AppColors.gold)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderGold),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
          ),
          const SizedBox(height: 20),
          PrimaryButton(
            label: 'Profilimi Analiz Et (${DatingConfig.creditsText} kredi)',
            onPressed: _shots.isEmpty ? null : _run,
          ),
        ],
      ),
    );
  }

  Widget _result() {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Profil Geri Bildirimi',
            style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary)),
        const SizedBox(height: 12),
        _card('Genel izlenim',
            'Fotoğraflar iyi ama bio çok genel. Kişiliğini yansıtan somut '
                'detaylar ekle.'),
        _card('Bio — Önce',
            '"Seyahat etmeyi ve müzik dinlemeyi severim."'),
        _card('Bio — Sonra',
            '"Pasaportumda 12 ülke, çalma listemde 3 tür. Bir sonrakini '
                'birlikte ekleyelim mi?"'),
        _card('Prompt önerisi',
            '"Beni en çok güldüren şey…" promptunu ekle; mizah eşleşmeyi '
                'artırır.'),
        const SizedBox(height: 4),
        _backendNote(),
        const SizedBox(height: 12),
        PrimaryButton(
            label: 'Yeni Analiz', onPressed: () => setState(() {
              _stage = 0;
              _shots.clear();
            })),
      ],
    );
  }

  Widget _card(String t, String b) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t,
                style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: AppColors.gold)),
            const SizedBox(height: 4),
            Text(b,
                style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
                    height: 1.4)),
          ],
        ),
      );
}

// ============================================================
// 6) LOOKSMAXXING — eski tasarım: Yüz & Vücut analiz kartları
// ============================================================
class LooksmaxxingFlow extends ConsumerStatefulWidget {
  const LooksmaxxingFlow({super.key});
  @override
  ConsumerState<LooksmaxxingFlow> createState() => _LooksmaxxingFlowState();
}

class _LooksmaxxingFlowState extends ConsumerState<LooksmaxxingFlow> {
  final List<File> _face = [];
  final List<File> _body = [];
  bool _faceDone = false;
  bool _bodyDone = false;

  Future<void> _analyze(bool face) async {
    final list = face ? _face : _body;
    if (list.isEmpty) return;
    if (!await _charge(context, ref, DatingConfig.creditsAnalysis)) return;
    // basit bekleme
    await Future.delayed(const Duration(seconds: 1));
    if (mounted) {
      setState(() => face ? _faceDone = true : _bodyDone = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'Looksmaxxing',
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('YÜZ & VÜCUT\nANALİZİ',
                style: TextStyle(
                    fontSize: 30,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary,
                    height: 1.1,
                    letterSpacing: 1)),
            const SizedBox(height: 8),
            const Text(
                'Yüz ve vücut fotoğraflarını yükle; sana özel, yapıcı '
                'iyileştirme önerileri sunalım.',
                style: TextStyle(
                    fontSize: 14,
                    color: AppColors.textSecondary,
                    height: 1.5)),
            const SizedBox(height: 20),
            _analysisCard(
              title: 'Yüz Analizi',
              subtitle: 'Çene hattı, cilt, saç & sakal',
              icon: Icons.face_retouching_natural,
              color: AppColors.gold,
              photos: _face,
              done: _faceDone,
              onPick: () async {
                final f = await _pickImages(multi: true, limit: 3);
                if (f.isNotEmpty) {
                  setState(() => _face
                    ..clear()
                    ..addAll(f));
                }
              },
              onAnalyze: () => _analyze(true),
              recs: const [
                'Kaş düzeni ve cilt nemlendirme rutini görünümü belirginleştirir.',
                'Yüz şekline uygun kısa-kenar kesim çene hattını öne çıkarır.',
                'Sakal çizgisini keskinleştir; simetriyi güçlendirir.',
              ],
            ),
            const SizedBox(height: 16),
            _analysisCard(
              title: 'Vücut Analizi',
              subtitle: 'Kompozisyon, postür, kas',
              icon: Icons.accessibility_new_rounded,
              color: AppColors.physical,
              photos: _body,
              done: _bodyDone,
              onPick: () async {
                final f = await _pickImages(multi: true, limit: 3);
                if (f.isNotEmpty) {
                  setState(() => _body
                    ..clear()
                    ..addAll(f));
                }
              },
              onAnalyze: () => _analyze(false),
              recs: const [
                'Omuzları geri al, göğsü aç — duruş anında daha güçlü görünüm.',
                'Sırt ve omuz hacmini artır; V-şeklini belirginleştirir.',
                'Bel çevresini toparlayan bir program görünümü keskinleştirir.',
              ],
            ),
            const SizedBox(height: 16),
            const Text(
              'Bu öneriler yapıcı rehberliktir; tıbbi değerlendirme değildir.',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _analysisCard({
    required String title,
    required String subtitle,
    required IconData icon,
    required Color color,
    required List<File> photos,
    required bool done,
    required VoidCallback onPick,
    required VoidCallback onAnalyze,
    required List<String> recs,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                            color: AppColors.textPrimary)),
                    Text(subtitle,
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textSecondary)),
                  ],
                ),
              ),
              if (done)
                const Icon(Icons.check_circle_rounded,
                    color: AppColors.success, size: 22),
            ],
          ),
          const SizedBox(height: 14),
          if (photos.isNotEmpty)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final f in photos)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.file(f,
                        width: 72, height: 72, fit: BoxFit.cover),
                  ),
              ],
            )
          else
            GestureDetector(
              onTap: onPick,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 20),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: color.withValues(alpha: 0.3)),
                ),
                child: Column(
                  children: [
                    Icon(Icons.add_photo_alternate_outlined,
                        color: color, size: 26),
                    const SizedBox(height: 6),
                    Text('FOTOĞRAF EKLE',
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            color: color)),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 12),
          if (photos.isNotEmpty && !done)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: onAnalyze,
                style: ElevatedButton.styleFrom(
                  backgroundColor: color,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                child: Text('ANALİZ ET (${DatingConfig.creditsAnalysis} kredi)',
                    style: const TextStyle(
                        fontWeight: FontWeight.w800, color: Colors.white)),
              ),
            ),
          if (done) ...[
            const Divider(color: AppColors.borderSubtle, height: 20),
            const Text('İYİLEŞTİRME ÖNERİLERİ',
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1,
                    color: AppColors.textSecondary)),
            const SizedBox(height: 8),
            for (final r in recs)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.check_circle_outline,
                        color: color, size: 16),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(r,
                          style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.textPrimary,
                              height: 1.4)),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

// Ortak backend notu
Widget _backendNote() => const Padding(
      padding: EdgeInsets.only(top: 8),
      child: Text(
        'Not: Gerçek AI çıktısı, üretim backend\'i bağlandığında burada görünecek.',
        style: TextStyle(fontSize: 11, color: AppColors.textMuted),
      ),
    );
