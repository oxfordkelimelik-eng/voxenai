import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
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

/// Krediyi düşer; yetmezse nazik "kredin bitti" sayfasına yönlendiren yardımcı.
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
            const Text('Kredin bitti',
                style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 8),
            const Text('Kredilerin bir sonraki dönemde yenilenir.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textSecondary)),
            const SizedBox(height: 16),
            SizedBox(
              width: 200,
              child: PrimaryButton(
                label: 'Planları Gör',
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

Future<List<File>> _pickImages({bool multi = false, int limit = 5}) async {
  final picker = ImagePicker();
  if (multi) {
    final xs = await picker.pickMultiImage(limit: limit);
    return xs.take(limit).map((x) => File(x.path)).toList();
  }
  final x = await picker.pickImage(source: ImageSource.gallery);
  return x == null ? [] : [File(x.path)];
}

/// AI foto üretimi için seçilen referans selfie'lerini doğrular: her
/// fotoğrafta TAM OLARAK bir yüz, yeterince büyük/net görünür olmalı.
/// "Çöp girdi = çöp çıktı" — bulanık, yüzsüz veya çoklu-kişili bir referans
/// fal.ai'ye gönderilmeden önce burada elenir. Geçemeyen dosyaların
/// yollarını döner (boşsa hepsi geçti demektir).
Future<List<String>> _findInvalidReferencePhotos(List<File> files) async {
  final detector = FaceDetector(
    options: FaceDetectorOptions(
      performanceMode: FaceDetectorMode.accurate,
      // Yüz, kadrajın en az %20'sini kaplamalı — uzaktan/gruplu fotoğrafları
      // ve arka plandaki tesadüfi yüzleri eler.
      minFaceSize: 0.2,
    ),
  );
  final invalid = <String>[];
  try {
    for (final f in files) {
      try {
        final faces =
            await detector.processImage(InputImage.fromFilePath(f.path));
        if (faces.length != 1) invalid.add(f.path);
      } catch (_) {
        // Dosya okunamadı/işlenemedi — güvenli tarafta kal, geçersiz say.
        invalid.add(f.path);
      }
    }
  } finally {
    await detector.close();
  }
  return invalid;
}

// ============================================================
// 1) AI DATING FOTOĞRAFI — önce stil/mekan seç → paket → üret
// ============================================================
class AiPhotoFlow extends ConsumerStatefulWidget {
  const AiPhotoFlow({super.key});
  @override
  ConsumerState<AiPhotoFlow> createState() => _AiPhotoFlowState();
}

enum _AiStage { style, package, loading, result, error }

class _AiPhotoFlowState extends ConsumerState<AiPhotoFlow> {
  _AiStage _stage = _AiStage.style;
  final Set<String> _styles = {};
  final List<File> _photos = [];
  String? _errorMessage;
  bool _validatingPhotos = false; // seçilen fotoğraflarda yüz kontrolü sürüyor

  // fal.ai üretim işi takibi
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _jobSub;
  Map<String, dynamic>? _jobData;

  // Adım adım yükleme mesajları — zero-shot üretim saniyeler içinde
  // sonuçlanır (eğitim aşaması yok).
  static const _uploadingSteps = ['Fotoğrafların yükleniyor…'];
  static const _generatingSteps = [
    'Yüzün referans alınıyor…',
    'Seçtiğin stiller uygulanıyor…',
    'Son kontroller…',
  ];

  // Her seçilen stil DatingConfig.photosPerSet foto üretir (ör. 1 stil → 10,
  // 5 stil → 50). Paket bakiyesi de "stil" cinsinden tutulur.
  int get _photoCount => _styles.length * DatingConfig.photosPerSet;

  /// Erişim etiketi: paket bakiyesi varsa kalan hak, yoksa nazik bir davet.
  String get _accessLabel {
    final left = ref.read(packBalanceProvider).photo; // stil cinsinden
    if (left > 0) return 'Paketinde $left stil hakkın var';
    return 'Fotoğraflarını oluşturmaya hazırsın';
  }

  @override
  void dispose() {
    _jobSub?.cancel();
    super.dispose();
  }

  /// 5 fotoğrafı Firebase Storage'a yükler, sunucu tarafında bakiye
  /// kontrolü + fal.ai zero-shot üretimini başlatan `startPhotoGeneration`
  /// Cloud Function'ını çağırır, sonra iş dokümanını (genJobs/{jobId})
  /// gerçek zamanlı dinlemeye başlar.
  Future<void> _generate() async {
    if (_photos.length != 5 || _styles.isEmpty) return;
    setState(() {
      _stage = _AiStage.loading;
      _errorMessage = null;
    });

    final uid = ref.read(authServiceProvider).uid;
    if (uid == null) {
      setState(() {
        _stage = _AiStage.error;
        _errorMessage = 'Giriş yapılmamış. Lütfen tekrar dene.';
      });
      return;
    }

    final jobId = const Uuid().v4();
    try {
      for (var i = 0; i < _photos.length; i++) {
        final ref = FirebaseStorage.instance
            .ref('dating_training/$uid/$jobId/photo_$i.jpg');
        await ref.putFile(_photos[i]);
      }

      await FirebaseFunctions.instanceFor(region: 'europe-west1')
          .httpsCallable('startPhotoGeneration')
          .call({'styles': _styles.toList(), 'jobId': jobId});

      if (!mounted) return;
      _listenToJob(uid, jobId);
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _AiStage.error;
        final detail = e.message?.trim();
        _errorMessage = (detail != null && detail.isNotEmpty)
            ? detail
            : switch (e.code) {
                'unauthenticated' => 'Giriş yapman gerekiyor.',
                'failed-precondition' =>
                  'Paket bakiyen yetersiz veya ücretsiz deneme hakkın bitti. '
                      'Tek stil ücretsiz denenebilir.',
                _ => 'Üretim başlatılamadı (${e.code}). Lütfen tekrar dene.',
              };
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _AiStage.error;
        _errorMessage = 'Üretim başlatılamadı. Lütfen tekrar dene.';
      });
    }
  }

  void _listenToJob(String uid, String jobId) {
    _jobSub?.cancel();
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
          _stage = _AiStage.error;
          _errorMessage =
              data['errorMessage'] as String? ?? 'Üretim başarısız oldu.';
        } else if (status == 'done' || _resultUrls.isNotEmpty) {
          // Üretim yalnızca ödenen (veya ücretsiz hakla açılan) stiller için
          // çalıştı; dolayısıyla dönen TÜM fotolar zaten ödenmiştir — hepsi
          // açık gösterilir, ekstra kilit/blur yok.
          _stage = _AiStage.result;
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

  void _reset() {
    _jobSub?.cancel();
    setState(() {
      _stage = _AiStage.style;
      _photos.clear();
      _styles.clear();
      _jobData = null;
      _errorMessage = null;
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
        _AiStage.loading => AiLoadingView(steps: _loadingSteps),
        _AiStage.result => _resultStep(),
        _AiStage.error => _errorStep(),
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
        // ÖNCE net görsün (her stil 1 paket hakkı = 10 foto). Bakiye 0 ise
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
                : () => setState(() => _stage = _AiStage.package),
          ),
        ),
      ],
    );
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
                Text('$_photoCount fotoğraf · ${_styles.length} stil',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 22,
                        fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                Text(_accessLabel,
                    style: const TextStyle(color: Colors.white70)),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final id in _styles)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.white24,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                            PhotoStyle.coreStyles
                                .firstWhere((s) => s.id == id)
                                .label,
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 11,
                                fontWeight: FontWeight.w700)),
                      ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          const PhotoQualityGuide(),
          const SizedBox(height: 16),
          const Text('Fotoğraflarını yükle (5 net fotoğraf)',
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 4),
          const Text(
              'Yapay zekanın yüzünü doğru öğrenmesi için tam 5 net, farklı '
              'açılardan fotoğraf gerekir.',
              style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          const SizedBox(height: 10),
          if (_photos.isEmpty)
            Container(
              height: 90,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.borderSubtle),
              ),
              child: const Text('Henüz fotoğraf seçilmedi',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            )
          else
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
            onPressed: _validatingPhotos
                ? null
                : () async {
                    // Kalan boş slot kadar yeni foto seçilebilir (toplam 5).
                    final remaining = 5 - _photos.length;
                    if (remaining <= 0) return;
                    final files =
                        await _pickImages(multi: true, limit: remaining);
                    if (files.isEmpty) return;
                    setState(() => _validatingPhotos = true);
                    final invalid = await _findInvalidReferencePhotos(files);
                    if (!mounted) return;
                    setState(() => _validatingPhotos = false);
                    // Uygunsuzları KULLANICIYA GOSTER (kacinci foto, neden),
                    // geçerlileri yine de ekle — hepsini birden atma.
                    final valid =
                        files.where((f) => !invalid.contains(f.path)).toList();
                    if (invalid.isNotEmpty) {
                      final badIndexes = <int>[];
                      for (int i = 0; i < files.length; i++) {
                        if (invalid.contains(files[i].path)) {
                          badIndexes.add(i + 1);
                        }
                      }
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                        duration: const Duration(seconds: 5),
                        content: Text(
                            'Seçtiğin ${badIndexes.length} fotoğraf uygun değil '
                            '(${badIndexes.join(', ')}. sıradaki): net, tek bir '
                            'yüz görünmüyor (bulanık, yüzsüz ya da birden fazla '
                            'kişi). ${valid.isEmpty ? "" : "Uygun olanlar eklendi."}'),
                      ));
                    }
                    if (valid.isEmpty) return;
                    setState(() {
                      for (final f in valid) {
                        if (_photos.length < 5) _photos.add(f);
                      }
                    });
                  },
            icon: _validatingPhotos
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppColors.gold),
                  )
                : const Icon(Icons.add_photo_alternate_outlined,
                    color: AppColors.gold),
            label: Text(
                _validatingPhotos
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
            label: 'Fotoğraflarımı Oluştur',
            onPressed: _photos.length == 5 ? _generate : null,
          ),
          const SizedBox(height: 8),
          Center(
            child: TextButton(
              onPressed: () => setState(() => _stage = _AiStage.style),
              child: const Text('← Stili değiştir',
                  style: TextStyle(color: AppColors.textSecondary)),
            ),
          ),
        ],
      ),
    );
  }

  /// Tamamlanan stil sayısı (Firestore'daki `results.{styleId}.status`
  /// alanı 'done' veya 'failed' olanlar — hâlâ 'pending' olanlar hariç).
  int get _completedStyleCount {
    final results = _jobData?['results'] as Map<String, dynamic>?;
    if (results == null) return 0;
    return results.values
        .cast<Map<String, dynamic>>()
        .where((r) => r['status'] == 'done' || r['status'] == 'failed')
        .length;
  }

  Widget _resultStep() {
    final urls = _resultUrls;
    final stillGenerating = (_jobData?['status'] as String?) == 'generating';
    final total = _styles.length;
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
          const Text(
            'Tüm fotoğrafların açık — indirebilir veya paylaşabilirsin.',
            style: TextStyle(
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
                Text(
                    '$_completedStyleCount/$total stil hazır — kalanlar üretiliyor…',
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.textSecondary)),
              ],
            ),
          ],
          const SizedBox(height: 12),
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: 2,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            children: [
              for (int i = 0; i < urls.length; i++)
                _resultTile(urls[i], index: i),
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

  /// `gs://bucket/path` biçimindeki bir Firebase Storage URL'ini gerçek
  /// bir indirme URL'ine çözüp gösterir (Firebase Auth token'ı ile —
  /// storage.rules yalnızca sahibine izin verir).
  Widget _resultTile(String gsUrl, {required int index}) {
    // Foto üretiminde dönen tüm fotolar ödenmiştir; kilit/blur yok.
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: AspectRatio(
        aspectRatio: 3 / 4,
        child: FutureBuilder<String>(
          future: FirebaseStorage.instance.refFromURL(gsUrl).getDownloadURL(),
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
      ),
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
