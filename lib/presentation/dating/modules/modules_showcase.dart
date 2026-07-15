import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/voxen_visuals.dart';
import '../widgets/shared_widgets.dart';

/// Form sonrası tek ekranlı vitrin + paket seçimi.
/// Scroll yok: kompakt slider (otomatik kayar) + fiyat satırları + CTA.
class ModulesShowcaseScreen extends ConsumerStatefulWidget {
  const ModulesShowcaseScreen({super.key});
  @override
  ConsumerState<ModulesShowcaseScreen> createState() =>
      _ModulesShowcaseScreenState();
}

enum _PackKind { analysis1, analysis5, photo10, photo50 }

class _ModulesShowcaseScreenState extends ConsumerState<ModulesShowcaseScreen> {
  final _pageController = PageController();
  int _page = 0;
  Timer? _autoScroll;
  bool _busy = false;

  static const _slides = [
    (
      DatingAssetPaths.showcaseSlide1,
      Icons.auto_awesome,
      'Stüdyo kalitesinde dating fotoğrafları',
      'Stilini seç, AI yüzünü koruyarak yeni kareler üretsin.'
    ),
    (
      DatingAssetPaths.showcaseSlide2,
      Icons.insights,
      'En iyi kareleri sen değil AI seçsin',
      'Fotoğraflarını puanlar, hangisini kullanacağını söyler.'
    ),
    (
      DatingAssetPaths.showcaseSlide3,
      Icons.favorite_rounded,
      'Daha fazla eşleşme, daha fazla sohbet',
      'Doğru fotoğraf + doğru profil = fark edilir artış.'
    ),
  ];

  @override
  void initState() {
    super.initState();
    _autoScroll = Timer.periodic(const Duration(seconds: 4), (_) {
      if (!mounted || !_pageController.hasClients) return;
      final next = (_page + 1) % _slides.length;
      _pageController.animateToPage(
        next,
        duration: const Duration(milliseconds: 450),
        curve: Curves.easeInOutCubic,
      );
    });
  }

  @override
  void dispose() {
    _autoScroll?.cancel();
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _buy(_PackKind kind) async {
    final productId = switch (kind) {
      _PackKind.analysis1 => DatingConfig.analysisSingleProductId,
      _PackKind.analysis5 => DatingConfig.analysisStandardProductId,
      _PackKind.photo10 => DatingConfig.photoStandardProductId,
      _PackKind.photo50 => DatingConfig.photoPremiumProductId,
    };
    setState(() => _busy = true);
    final ok =
        await ref.read(datingPurchaseServiceProvider).purchaseAndWait(productId);
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma başarılı! Paketin hesabına eklendi.')));
      context.go(DatingRoutes.hub);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma tamamlanamadı. Lütfen tekrar dene.')));
    }
  }

  void _showModuleInfo({
    required String title,
    required String body,
    required List<String> bullets,
  }) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(
            20, 12, 20, 20 + MediaQuery.of(ctx).padding.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
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
            Text(title,
                style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 8),
            Text(body,
                style: const TextStyle(
                    fontSize: 13,
                    height: 1.45,
                    color: AppColors.textSecondary)),
            const SizedBox(height: 12),
            for (final b in bullets)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    const Icon(Icons.check_rounded,
                        color: AppColors.gold, size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(b,
                          style: const TextStyle(
                              fontSize: 13, color: AppColors.textPrimary)),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Kapat',
                    style: TextStyle(color: AppColors.textSecondary)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: Row(
                children: [
                  const SizedBox(width: 40),
                  const Expanded(child: Center(child: VoxenWordmark(fontSize: 20))),
                  IconButton(
                    icon: const Icon(Icons.settings_outlined,
                        color: AppColors.textSecondary, size: 22),
                    onPressed: () => context.push(DatingRoutes.settings),
                  ),
                ],
              ),
            ),
            // Kompakt otomatik slider
            SizedBox(
              height: 168,
              child: PageView.builder(
                controller: _pageController,
                onPageChanged: (i) => setState(() => _page = i),
                itemCount: _slides.length,
                itemBuilder: (_, i) {
                  final s = _slides[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          Positioned.fill(
                            child: DatingModuleImage(
                              assetPath: s.$1,
                              fallbackIcon: s.$2,
                              borderRadius: BorderRadius.zero,
                              alignment: Alignment.topCenter,
                            ),
                          ),
                          DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [
                                  Colors.black.withValues(alpha: 0.15),
                                  Colors.black.withValues(alpha: 0.72),
                                ],
                              ),
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.end,
                              children: [
                                Text(s.$3,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        fontSize: 16,
                                        fontWeight: FontWeight.w900,
                                        height: 1.15,
                                        color: Colors.white)),
                                const SizedBox(height: 4),
                                Text(s.$4,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                        fontSize: 11,
                                        height: 1.3,
                                        color: Colors.white
                                            .withValues(alpha: 0.85))),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(_slides.length, (i) {
                final active = i == _page;
                return AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  width: active ? 16 : 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: active ? AppColors.gold : AppColors.borderGold,
                    borderRadius: BorderRadius.circular(3),
                  ),
                );
              }),
            ),
            const SizedBox(height: 10),
            // Modül özet satırları (detay popup)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Expanded(
                    child: _ModuleChip(
                      icon: Icons.auto_awesome,
                      title: 'AI Foto',
                      onTap: () => _showModuleInfo(
                        title: 'AI Dating Fotoğrafı',
                        body:
                            '5 selfie yükle, stil seç. AI yüzünü koruyarak '
                            'seçtiğin mekân ve tarzda profesyonel fotoğraflar üretir.',
                        bullets: const [
                          'Stile özel arka plan',
                          'İlk fotoğraf ücretsiz önizleme',
                          '10 veya 50 fotoğraf paketleri',
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _ModuleChip(
                      icon: Icons.insights,
                      title: 'Analiz',
                      onTap: () => _showModuleInfo(
                        title: 'Fotoğraf Analizi',
                        body:
                            'Profil fotoğraflarını puanlar, güçlü/zayıf yönlerini '
                            'söyler ve hangisini kullanmanı önerir.',
                        bullets: const [
                          'Çekicilik skoru',
                          'İlk analiz ücretsiz',
                          '₺99 tekli · ₺249 standart',
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text('PAKETLER',
                        style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1,
                            color: AppColors.textMuted)),
                    const SizedBox(height: 8),
                    Expanded(
                      child: Column(
                        children: [
                          Expanded(
                            child: _PriceRow(
                              icon: Icons.insights,
                              title: 'Tekli Analiz',
                              sub: '1 analiz',
                              price: DatingConfig.analysisSinglePriceLabel,
                              busy: _busy,
                              onTap: () => _buy(_PackKind.analysis1),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Expanded(
                            child: _PriceRow(
                              icon: Icons.insights,
                              title: 'Standart Analiz',
                              sub: '5 analiz · Avantajlı',
                              price: DatingConfig.analysisStandardPriceLabel,
                              busy: _busy,
                              highlighted: true,
                              onTap: () => _buy(_PackKind.analysis5),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Expanded(
                            child: _PriceRow(
                              icon: Icons.auto_awesome,
                              title: 'AI Foto Standart',
                              sub: '10 foto · 1 stil',
                              price: DatingConfig.photoStandardPriceLabel,
                              busy: _busy,
                              onTap: () => _buy(_PackKind.photo10),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Expanded(
                            child: _PriceRow(
                              icon: Icons.workspace_premium_rounded,
                              title: 'AI Foto Premium',
                              sub: '50 foto · 5 stil',
                              price: DatingConfig.photoPremiumPriceLabel,
                              busy: _busy,
                              highlighted: true,
                              onTap: () => _buy(_PackKind.photo50),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: SizedBox(
                width: double.infinity,
                height: 50,
                child: ElevatedButton(
                  onPressed: _busy ? null : () => context.go(DatingRoutes.hub),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                  child: const Text('Hemen Ücretsiz Başla',
                      style: TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w900)),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  TextButton(
                    onPressed: () => context.push(DatingRoutes.settings),
                    child: const Text('Gizlilik',
                        style: TextStyle(
                            fontSize: 11, color: AppColors.textMuted)),
                  ),
                  const Text('·',
                      style: TextStyle(color: AppColors.textMuted)),
                  TextButton(
                    onPressed: () => context.push(DatingRoutes.settings),
                    child: const Text('Şartlar',
                        style: TextStyle(
                            fontSize: 11, color: AppColors.textMuted)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ModuleChip extends StatelessWidget {
  final IconData icon;
  final String title;
  final VoidCallback onTap;
  const _ModuleChip(
      {required this.icon, required this.title, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: [
            Icon(icon, color: AppColors.gold, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text(title,
                  style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
            ),
            const Icon(Icons.info_outline_rounded,
                size: 16, color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }
}

class _PriceRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  final String price;
  final bool busy;
  final bool highlighted;
  final VoidCallback onTap;
  const _PriceRow({
    required this.icon,
    required this.title,
    required this.sub,
    required this.price,
    required this.busy,
    required this.onTap,
    this.highlighted = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: busy ? null : onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: highlighted ? AppColors.goldSurface : AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: highlighted ? AppColors.gold : AppColors.borderSubtle,
            width: highlighted ? 1.2 : 0.8,
          ),
        ),
        child: Row(
          children: [
            Icon(icon, color: AppColors.gold, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary)),
                  Text(sub,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.textSecondary)),
                ],
              ),
            ),
            Text(price,
                style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                    color: AppColors.gold)),
            const SizedBox(width: 4),
            const Icon(Icons.chevron_right_rounded,
                size: 18, color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }
}
