import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
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

  // Kod tarafındaki model kimliği -> ekranda gösterilecek ad + birim fiyat.
  static const _labels = {
    'nano-banana-pro': ('Nano Banana Pro (ŞU ANKİ)', 0.15),
    'nano-banana': ('Nano Banana', 0.039),
    'seedream-v45': ('Seedream v4.5', 0.04),
    'gpt-image-2': ('GPT Image 2 (orta kalite)', 0.061),
  };

  Future<void> _run() async {
    setState(() {
      _running = true;
      _error = null;
      _results = null;
    });
    try {
      final res = await FirebaseFunctions.instanceFor(region: 'europe-west1')
          .httpsCallable('runModelBakeoff')
          .call({'style': _style});
      final data = Map<String, dynamic>.from(res.data as Map);
      if (!mounted) return;
      setState(() {
        _results = Map<String, dynamic>.from(data['results'] as Map);
        _cost = (data['estimatedCostUsd'] as num?)?.toDouble();
      });
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message ?? 'Test başarısız (${e.code}).');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Test başarısız. Lütfen tekrar dene.');
    } finally {
      if (mounted) setState(() => _running = false);
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
            'Aynı referans fotoğrafların ve aynı prompt sistemiyle 4 modelden '
            'birer set (5 foto) üretilir. Hangi fotoğrafın hangi modelden '
            'geldiği etiketle gösterilir. Çıktı canlının TAM KOPYASI: kimlik '
            'kapısı + otomatik retry + telefon kamerası dokusu uygulanır.',
            style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 6),
          const Text(
            'Kırmızı "kimlik ✗" rozetli kareler kimlik eşiğini geçemedi — '
            'canlıda bu kareler kullanıcıya gösterilmeden atılırdı.',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
          const SizedBox(height: 6),
          const Text(
            'Not: Bu test paket bakiyeni HARCAMAZ; ücret doğrudan fal.ai '
            'hesabından düşer (taban ~1.45 USD; retry ile artabilir).',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
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
            label: _running ? 'Üretiliyor… (2-3 dk sürebilir)' : 'Testi Başlat',
            onPressed: _running ? null : _run,
          ),
          if (_running) ...[
            const SizedBox(height: 16),
            const Center(
                child: CircularProgressIndicator(color: AppColors.gold)),
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
      return Container(
        color: AppColors.surface,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(6),
        child: Text('#$chunk\nhata',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 10, color: AppColors.error)),
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
