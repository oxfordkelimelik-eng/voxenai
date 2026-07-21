import 'dart:io';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../providers/app_providers.dart' show authServiceProvider;
import '../../screens/analysis/guided_capture_screen.dart';
import '../providers/dating_providers.dart';
import '../widgets/dating_widgets.dart';
import 'module_flows.dart' show PhotoViewerPage;

/// GEÇİCİ GELİŞTİRİCİ ARACI — model karşılaştırma (A/B).
///
/// Aynı referans fotoğraflar + aynı prompt sistemiyle 3 modelden birer set
/// üretir ve sonuçları MODEL ETİKETİYLE yan yana gösterir. Amaç: "hangi model
/// daha doğal?" sorusunu göz kararıyla değil, aynı koşullarda karşılaştırarak
/// cevaplamak — ve ucuz modellerin (4-5 kat) yeterli olup olmadığını görmek.
///
/// Karşılaştırma bittiğinde bu ekran, functions/modelBakeoff.js ve
/// falPhotos.js'teki *_FOR_BAKEOFF export'ları SİLİNMELİ.
class ModelBakeoffScreen extends ConsumerStatefulWidget {
  const ModelBakeoffScreen({super.key});

  @override
  ConsumerState<ModelBakeoffScreen> createState() => _ModelBakeoffScreenState();
}

class _ModelBakeoffScreenState extends ConsumerState<ModelBakeoffScreen> {
  bool _running = false;
  String? _error;
  Map<String, dynamic>? _results;
  double? _cost;
  String _style = PhotoStyle.coreStyles.first.id;

  // Kendi referanslarını çek — böylece testten önce nano-banana ile ÜCRETLİ
  // üretim yapmak zorunda kalmazsın. Boş bırakırsan en son hazırladığın iş
  // kullanılır (eski davranış).
  final List<File> _facePhotos = [];
  File? _bodyPhoto;
  String? _progress; // "yükleniyor / üretiliyor" gibi anlık durum

  bool get _hasOwnRefs =>
      _facePhotos.length == DatingConfig.faceCaptureCount && _bodyPhoto != null;

  // Kod tarafındaki model kimliği -> ekranda gösterilecek ad + birim fiyat.
  // İlk turda 4 model denendi; nano-banana ve seedream zayıf çıktığı için
  // kapsam bu ikisine indirildi.
  static const _labels = {
    'nano-banana-pro': ('Nano Banana Pro (ŞU ANKİ)', 0.15),
    'gpt-image-2': ('GPT Image 2 (orta kalite)', 0.061),
  };

  // ---- Referans çekimi (ana akışla aynı bileşenler) ----
  Future<void> _captureFaces() async {
    final files = await Navigator.of(context).push<List<File>>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => const GuidedCaptureScreen(kind: CaptureKind.face),
      ),
    );
    if (files == null || files.length != DatingConfig.faceCaptureCount) return;
    setState(() {
      _facePhotos
        ..clear()
        ..addAll(files);
      _error = null;
    });
  }

  Future<void> _pickBody() async {
    final source = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.surface,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined,
                  color: AppColors.textPrimary),
              title: const Text('Kamerayla çek (rehberli)',
                  style: TextStyle(color: AppColors.textPrimary)),
              onTap: () => Navigator.pop(context, 'camera'),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined,
                  color: AppColors.textPrimary),
              title: const Text('Galeriden seç',
                  style: TextStyle(color: AppColors.textPrimary)),
              onTap: () => Navigator.pop(context, 'gallery'),
            ),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;

    File? file;
    if (source == 'camera') {
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
      final x = await ImagePicker().pickImage(source: ImageSource.gallery);
      if (x != null) file = File(x.path);
    }
    if (file == null || !mounted) return;
    setState(() {
      _bodyPhoto = file;
      _error = null;
    });
  }

  /// Firestore'daki sonuç dokümanını bekler (callable koparsa kurtarma yolu).
  Future<Map<String, dynamic>?> _waitForResultDoc(
    DocumentReference<Map<String, dynamic>> docRef, {
    Duration timeout = const Duration(minutes: 4),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      final snap = await docRef.get();
      if (snap.exists && snap.data() != null) return snap.data();
      await Future<void>.delayed(const Duration(seconds: 5));
    }
    return null;
  }

  void _applyResults(Map<String, dynamic> data) {
    if (!mounted) return;
    setState(() {
      _results = Map<String, dynamic>.from(data['results'] as Map);
      _cost = (data['estimatedCostUsd'] as num?)?.toDouble();
    });
  }

  Future<void> _run() async {
    setState(() {
      _running = true;
      _error = null;
      _results = null;
      _progress = null;
    });
    try {
      final uid = ref.read(authServiceProvider).uid;
      if (uid == null) {
        setState(() => _error = 'Giriş yapılmamış. Lütfen tekrar dene.');
        return;
      }
      final functions = FirebaseFunctions.instanceFor(region: 'europe-west1');

      // 1) Kendi referansların varsa: ÜCRETSİZ prepare ile taze bir iş hazırla
      //    (nano-banana ile ücretli üretim YOK). Yoksa jobId'yi boş bırak →
      //    sunucu en son hazırlanmış işi bulur.
      String? jobId;
      if (_hasOwnRefs) {
        setState(() => _progress = 'Fotoğraflar yükleniyor…');
        jobId = const Uuid().v4();
        final refs = <File>[..._facePhotos, _bodyPhoto!];
        for (var i = 0; i < refs.length; i++) {
          await FirebaseStorage.instance
              .ref('dating_training/$uid/$jobId/photo_$i.jpg')
              .putFile(refs[i]);
        }
        setState(() => _progress = 'Doğrulanıyor (ücretsiz)…');
        final answers = ref.read(datingAnswersProvider);
        await functions.httpsCallable('prepareReferencePhotos').call({
          'jobId': jobId,
          'styles': [_style],
          'bodyProfile': {
            'heightRange': answers.heightRange,
            'bodyType': answers.bodyType,
            'gender': answers.gender,
          },
        });
      }

      // 2) Model karşılaştırmasını çalıştır. Client timeout SUNUCUYLA aynı
      //    (9 dk) — varsayılan 70 sn "deadline exceeded" veriyordu ama sunucu
      //    çalışmaya devam edip fal kredisi harcıyordu (asıl bug buydu).
      setState(() => _progress = 'Modeller üretiliyor… (birkaç dk sürebilir)');
      final runId = const Uuid().v4();
      final docRef = FirebaseFirestore.instance
          .doc('users/$uid/private/genData/bakeoffs/$runId');

      try {
        final res = await functions
            .httpsCallable(
              'runModelBakeoff',
              options: HttpsCallableOptions(timeout: const Duration(minutes: 9)),
            )
            .call({
          'style': _style,
          'runId': runId,
          'jobId': ?jobId,
        });
        _applyResults(Map<String, dynamic>.from(res.data as Map));
      } on FirebaseFunctionsException catch (e) {
        // SADECE bağlantı/timeout hatalarında sunucu hâlâ çalışıyor olabilir →
        // sonucu Firestore'dan bekle ki HARCANAN KREDİ boşa gitmesin. Sunucunun
        // fırlattığı gerçek hatalar (not-found, failed-precondition, invalid-
        // argument, unauthenticated) doküman YAZILMADAN döner — hemen göster,
        // boşuna bekletme.
        const transient = {'deadline-exceeded', 'unavailable', 'cancelled'};
        if (transient.contains(e.code)) {
          setState(() => _progress = 'Bağlantı koptu — sonuç bekleniyor…');
          final doc = await _waitForResultDoc(docRef);
          if (doc != null) {
            _applyResults(doc);
            return;
          }
        }
        if (!mounted) return;
        setState(() => _error = e.message ?? 'Test başarısız (${e.code}).');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Test başarısız: $e');
    } finally {
      if (mounted) {
        setState(() {
          _running = false;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        title: const Text('Model Karşılaştırma',
            style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Aynı referans fotoğrafların ve aynı prompt sistemiyle 2 modelden '
            '(Nano Banana Pro + GPT Image 2) birer set (5 foto) üretilir. '
            'Hangi fotoğrafın hangi modelden geldiği etiketle gösterilir. '
            'Çıktı canlının TAM KOPYASI: kimlik kapısı + otomatik retry + '
            'telefon kamerası dokusu uygulanır.',
            style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 6),
          const Text(
            'Kırmızı "kimlik ✗" rozetli kareler kimlik eşiğini geçemedi — '
            'canlıda bu kareler kullanıcıya gösterilmeden atılırdı. Hata alan '
            'bir kareye dokunursan gerçek hata mesajını görürsün.',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
          const SizedBox(height: 6),
          const Text(
            'Not: Bu test paket bakiyeni HARCAMAZ; ücret doğrudan fal.ai '
            'hesabından düşer (taban ~1.05 USD; retry ile artabilir).',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
          const SizedBox(height: 20),
          // ---- Kendi referansların (opsiyonel) ----
          _buildRefSection(),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            initialValue: _style,
            dropdownColor: AppColors.surface,
            decoration: const InputDecoration(
              labelText: 'Test edilecek stil',
              labelStyle: TextStyle(color: AppColors.textSecondary),
              enabledBorder: OutlineInputBorder(
                borderSide: BorderSide(color: AppColors.borderSubtle),
              ),
            ),
            style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
            items: [
              for (final s in PhotoStyle.coreStyles)
                DropdownMenuItem(value: s.id, child: Text(s.label)),
            ],
            onChanged: _running ? null : (v) => setState(() => _style = v!),
          ),
          const SizedBox(height: 16),
          PrimaryButton(
            label: _running
                ? 'Çalışıyor…'
                : (_hasOwnRefs
                    ? 'Testi Başlat (kendi fotoğraflarınla)'
                    : 'Testi Başlat (en son işle)'),
            onPressed: _running ? null : _run,
          ),
          if (_running) ...[
            const SizedBox(height: 16),
            const Center(
                child: CircularProgressIndicator(color: AppColors.gold)),
            if (_progress != null) ...[
              const SizedBox(height: 10),
              Center(
                child: Text(_progress!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.textSecondary)),
              ),
            ],
          ],
          if (_error != null) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.error.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                border:
                    Border.all(color: AppColors.error.withValues(alpha: 0.4)),
              ),
              child: Text(_error!,
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.textSecondary)),
            ),
          ],
          if (_cost != null) ...[
            const SizedBox(height: 16),
            Text('Bu testin maliyeti: \$${_cost!.toStringAsFixed(2)}',
                style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: AppColors.gold)),
          ],
          if (_results != null) ..._buildResults(),
        ],
      ),
    );
  }

  Widget _buildRefSection() {
    final faceCount = _facePhotos.length;
    final faceTarget = DatingConfig.faceCaptureCount;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Referans fotoğrafları (opsiyonel)',
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 4),
          const Text(
            'Foto çekersen bu testte onlar kullanılır — önce nano-banana ile '
            'ücretli üretim yapmana GEREK KALMAZ (doğrulama ücretsizdir). Boş '
            'bırakırsan en son hazırladığın iş kullanılır.',
            style: TextStyle(fontSize: 11.5, color: AppColors.textMuted),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _running ? null : _captureFaces,
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderSubtle),
            ),
            icon: Icon(
                faceCount == faceTarget
                    ? Icons.check_circle
                    : Icons.face_retouching_natural,
                color: faceCount == faceTarget
                    ? AppColors.success
                    : AppColors.textSecondary,
                size: 18),
            label: Text(
              faceCount == faceTarget
                  ? 'Yüz açıları çekildi ($faceTarget/$faceTarget)'
                  : 'Yüz açıları çek (ön/sağ/sol)',
              style: const TextStyle(color: AppColors.textPrimary),
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _running ? null : _pickBody,
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.borderSubtle),
            ),
            icon: Icon(
                _bodyPhoto != null
                    ? Icons.check_circle
                    : Icons.accessibility_new,
                color: _bodyPhoto != null
                    ? AppColors.success
                    : AppColors.textSecondary,
                size: 18),
            label: Text(
              _bodyPhoto != null ? 'Tam boy foto seçildi' : 'Tam boy foto ekle',
              style: const TextStyle(color: AppColors.textPrimary),
            ),
          ),
          if (_hasOwnRefs) ...[
            const SizedBox(height: 8),
            const Text('✓ Kendi fotoğraflarınla test edilecek',
                style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: AppColors.success)),
          ],
        ],
      ),
    );
  }

  List<Widget> _buildResults() {
    final widgets = <Widget>[];
    // Tüm modellerin fotoğrafları — tam ekran görüntüleyicide gezinmek için.
    final allUrls = <String>[];
    for (final entry in _results!.entries) {
      final imgs = (entry.value as Map)['images'] as List? ?? [];
      for (final img in imgs) {
        final gs = (img as Map)['gsUrl'] as String?;
        if (gs != null) allUrls.add(gs);
      }
    }

    for (final entry in _results!.entries) {
      final modelId = entry.key;
      final data = Map<String, dynamic>.from(entry.value as Map);
      final imgs = (data['images'] as List? ?? []);
      final label = _labels[modelId]?.$1 ?? modelId;
      final price = _labels[modelId]?.$2 ?? (data['pricePerImage'] as num?)?.toDouble() ?? 0;
      final setCost = price * DatingConfig.photosPerSet;

      widgets.addAll([
        const SizedBox(height: 24),
        Row(
          children: [
            Expanded(
              child: Text(label,
                  style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w900,
                      color: AppColors.textPrimary)),
            ),
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: AppColors.goldSurface,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text('\$${setCost.toStringAsFixed(2)} / 5 foto',
                  style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      color: AppColors.gold)),
            ),
          ],
        ),
        const SizedBox(height: 8),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 3,
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 3 / 4,
          children: [
            for (final img in imgs) _tile(img as Map, allUrls),
          ],
        ),
      ]);
    }
    return widgets;
  }

  Widget _tile(Map img, List<String> allUrls) {
    final gs = img['gsUrl'] as String?;
    final chunk = img['chunk'];
    final retries = (img['retries'] as num?)?.toInt() ?? 0;
    final identityPassed = img['identityPassed'] as bool?;
    final dist = (img['identityDistance'] as num?)?.toDouble();
    if (gs == null) {
      // Gerçek fal hatasını göster (ör. "422 ..." şema hatası) — önceden
      // sadece "hata" yazıyordu, teşhis için asıl mesaj lazım.
      final errorText = (img['error'] as String?) ?? 'bilinmeyen hata';
      return GestureDetector(
        onTap: () => showDialog<void>(
          context: context,
          builder: (_) => AlertDialog(
            backgroundColor: AppColors.surface,
            title: Text('#$chunk hata detayı',
                style: const TextStyle(color: AppColors.textPrimary)),
            content: SingleChildScrollView(
              child: SelectableText(errorText,
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.textSecondary)),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Kapat'),
              ),
            ],
          ),
        ),
        child: Container(
          color: AppColors.surface,
          alignment: Alignment.center,
          padding: const EdgeInsets.all(6),
          child: Text('#$chunk\n$errorText',
              textAlign: TextAlign.center,
              maxLines: 5,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 9, color: AppColors.error)),
        ),
      );
    }
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => PhotoViewerPage(
              gsUrls: allUrls,
              initialIndex: allUrls.indexOf(gs),
            ),
          ),
        ),
        child: Stack(
          fit: StackFit.expand,
          children: [
            FutureBuilder<String>(
              future: FirebaseStorage.instance.refFromURL(gs).getDownloadURL(),
              builder: (context, snap) {
                if (!snap.hasData) {
                  return Container(color: AppColors.surface);
                }
                return CachedNetworkImage(
                    imageUrl: snap.data!, fit: BoxFit.cover);
              },
            ),
            // Kompozisyon numarası (+ retry sayısı) — hangi kadraj/blur
            // reçetesi (0=yakın/güçlü blur ... 2=geniş/net) ve kaç kez yeniden
            // üretildiği.
            Positioned(
              left: 4,
              top: 4,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(5),
                ),
                child: Text(retries > 0 ? '#$chunk · ${retries}x retry' : '#$chunk',
                    style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: Colors.white)),
              ),
            ),
            // Kimlik kapısı rozeti: ✗ = tüm retry'lere rağmen eşiği geçemedi
            // (canlıda ATILIRDI), ✓ = geçti. null ise kapı yoktu (rozet yok).
            if (identityPassed != null)
              Positioned(
                right: 4,
                top: 4,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                  decoration: BoxDecoration(
                    color: (identityPassed ? Colors.green : AppColors.error)
                        .withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text(
                    identityPassed
                        ? 'kimlik ✓${dist != null ? ' ${dist.toStringAsFixed(2)}' : ''}'
                        : 'kimlik ✗${dist != null ? ' ${dist.toStringAsFixed(2)}' : ''}',
                    style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w800,
                        color: Colors.white),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
