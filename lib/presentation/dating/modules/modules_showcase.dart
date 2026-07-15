import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/voxen_visuals.dart';
import '../widgets/shared_widgets.dart';

/// İlk ödeme / tanıtım ekranı (onboarding sonrası, formlardan sonraki son
/// aşama). Kapatma tuşu YOK — kullanıcı ya hemen ücretsiz başlar ya da bir
/// paketi seçip satın alır. Yalnızca AI Dating Fotoğrafı Oluştur modülü
/// gösterilir (Standart / Premium). Birincil eylem "Hemen Ücretsiz Başla"dır;
/// paketleri yalnızca özellikle satın almak isteyen kullanıcılar için detay
/// sayfası açar.
class ModulesShowcaseScreen extends ConsumerStatefulWidget {
  const ModulesShowcaseScreen({super.key});
  @override
  ConsumerState<ModulesShowcaseScreen> createState() =>
      _ModulesShowcaseScreenState();
}

enum _PlanChoice { standard, premium }

class _ModulesShowcaseScreenState
    extends ConsumerState<ModulesShowcaseScreen> {
  final _pageController = PageController();
  int _page = 0;

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// Bir paket kartına basılınca satın alma detay sayfasını (bottom sheet)
  /// açar; kullanıcı burada ne alacağını görüp satın alabilir.
  Future<void> _openPurchase(_PlanChoice choice) async {
    final purchased = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _PurchaseSheet(choice: choice),
    );
    if (purchased == true && mounted) {
      context.go(DatingRoutes.hub);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            // Üst bar: sadece ayarlar — kapatma (X) tuşu yok.
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  IconButton(
                    icon: const Icon(Icons.settings_outlined,
                        color: AppColors.textSecondary),
                    onPressed: () => context.push(DatingRoutes.settings),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(0, 4, 0, 12),
                children: [
                  const Center(child: VoxenWordmark(fontSize: 24)),
                  const SizedBox(height: 20),
                  // Sağa kaydırmalı uygulama tanıtım slider'ı
                  SizedBox(
                    height: 300,
                    child: PageView(
                      controller: _pageController,
                      onPageChanged: (i) => setState(() => _page = i),
                      children: const [
                        _IntroSlide(
                          imagePath: DatingAssetPaths.showcaseSlide1,
                          icon: Icons.auto_awesome,
                          title: 'Stüdyo kalitesinde\ndating fotoğrafları',
                          body:
                              'Kendi fotoğraflarını yükle; yapay zeka seçtiğin '
                              'stile uygun arka plan ve kompozisyonla yepyeni '
                              'kareler oluştursun.',
                        ),
                        _IntroSlide(
                          imagePath: DatingAssetPaths.showcaseSlide2,
                          icon: Icons.insights,
                          title: 'En iyi karelerini\nsen değil AI seçsin',
                          body:
                              'Fotoğraflarını saniyeler içinde puanlar, '
                              'çekicilik skorunu verir ve profiline hangisini '
                              'koyacağını söyler.',
                        ),
                        _IntroSlide(
                          imagePath: DatingAssetPaths.showcaseSlide3,
                          icon: Icons.favorite_rounded,
                          title: 'Daha fazla eşleşme,\ndaha fazla sohbet',
                          body:
                              'Doğru fotoğraf + doğru profil = fark edilir '
                              'şekilde artan eşleşme. Hemen ücretsiz dene, '
                              'sonucu kendin gör.',
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  // Slider nokta göstergesi
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(3, (i) {
                      final active = i == _page;
                      return AnimatedContainer(
                        duration: const Duration(milliseconds: 200),
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        width: active ? 22 : 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: active ? AppColors.gold : AppColors.borderGold,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      );
                    }),
                  ),
                  const SizedBox(height: 28),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 24),
                    child: Text('MODÜLLERİMİZ',
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1,
                            color: AppColors.textMuted)),
                  ),
                  const SizedBox(height: 12),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 24),
                    child: _ModuleFeatureCard(
                      imagePath: DatingAssetPaths.moduleAiPhotoHero,
                      icon: Icons.auto_awesome,
                      title: 'AI Dating Fotoğrafı',
                      body:
                          '5 selfie yükle, stil seç (elegance, athletic, beach…). '
                          'AI yüzünü koruyarak seçtiğin mekân ve tarzda profesyonel '
                          'dating fotoğrafları üretir.',
                      bullets: [
                        'Stile özel arka plan ve kompozisyon',
                        'İlk fotoğraf ücretsiz önizleme',
                        '10–50 fotoğraf tek seferlik paketler',
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 24),
                    child: _ModuleFeatureCard(
                      imagePath: DatingAssetPaths.moduleAnalysisHero,
                      icon: Icons.insights,
                      title: 'Fotoğraf Analizi & Seçimi',
                      body:
                          'Profil fotoğraflarını yükle; AI her kareyi puanlar, '
                          'güçlü ve zayıf yönlerini söyler, hangisini kullanman '
                          'gerektiğini önerir.',
                      bullets: [
                        'Çekicilik skoru ve detaylı geri bildirim',
                        'İlk analiz ücretsiz',
                        '₺99 tekli · ₺249 standart paket',
                      ],
                    ),
                  ),
                  const SizedBox(height: 28),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 24),
                    child: Text('DİLERSEN HEMEN AI FOTOĞRAF PAKETİ AL',
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1,
                            color: AppColors.textMuted)),
                  ),
                  const SizedBox(height: 12),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: _PlanCard(
                      icon: Icons.auto_awesome,
                      title: 'Standart',
                      subtitle:
                          '${DatingConfig.photoStandardPhotos} fotoğraf · 1 stil',
                      price: DatingConfig.photoStandardPriceLabel,
                      onTap: () => _openPurchase(_PlanChoice.standard),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: _PlanCard(
                      icon: Icons.workspace_premium_rounded,
                      title: 'Premium',
                      subtitle:
                          '${DatingConfig.photoPremiumPhotos} fotoğraf · 5 stil',
                      price: DatingConfig.photoPremiumPriceLabel,
                      onTap: () => _openPurchase(_PlanChoice.premium),
                    ),
                  ),
                ],
              ),
            ),
            // Birincil eylem: her zaman ücretsiz denemeye davet.
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 4),
              child: SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: () => context.go(DatingRoutes.hub),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16)),
                  ),
                  child: const Text('Hemen Ücretsiz Başla',
                      style: TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w900)),
                ),
              ),
            ),
            // Altta gizlilik & şartlar
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  TextButton(
                    onPressed: () => context.push(DatingRoutes.settings),
                    child: const Text('Gizlilik',
                        style: TextStyle(
                            fontSize: 12, color: AppColors.textMuted)),
                  ),
                  const Text('·',
                      style: TextStyle(color: AppColors.textMuted)),
                  TextButton(
                    onPressed: () => context.push(DatingRoutes.settings),
                    child: const Text('Şartlar',
                        style: TextStyle(
                            fontSize: 12, color: AppColors.textMuted)),
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

/// Tanıtım slider'ının tek bir sayfası (görsel + başlık + açıklama).
class _IntroSlide extends StatelessWidget {
  final String imagePath;
  final IconData icon;
  final String title;
  final String body;
  const _IntroSlide({
    required this.imagePath,
    required this.icon,
    required this.title,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          DatingModuleImage(
            assetPath: imagePath,
            height: 160,
            width: double.infinity,
            fallbackIcon: icon,
            borderRadius: BorderRadius.circular(20),
          ),
          const SizedBox(height: 20),
          Text(title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontSize: 23,
                  fontWeight: FontWeight.w900,
                  height: 1.2,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 12),
          Text(body,
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontSize: 14, height: 1.5, color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

/// Modül tanıtım kartı — hero görsel + açıklama maddeleri.
class _ModuleFeatureCard extends StatelessWidget {
  final String imagePath;
  final IconData icon;
  final String title;
  final String body;
  final List<String> bullets;
  const _ModuleFeatureCard({
    required this.imagePath,
    required this.icon,
    required this.title,
    required this.body,
    required this.bullets,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DatingModuleImage(
            assetPath: imagePath,
            height: 140,
            width: double.infinity,
            fallbackIcon: icon,
            borderRadius: BorderRadius.zero,
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, color: AppColors.gold, size: 22),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(title,
                          style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                              color: AppColors.textPrimary)),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(body,
                    style: const TextStyle(
                        fontSize: 13,
                        height: 1.45,
                        color: AppColors.textSecondary)),
                const SizedBox(height: 10),
                for (final b in bullets)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.check_rounded,
                            color: AppColors.gold, size: 16),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(b,
                              style: const TextStyle(
                                  fontSize: 12,
                                  color: AppColors.textPrimary,
                                  height: 1.35)),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Satın almak isteyen kullanıcı için paket kartı (fiyat + detay oku).
class _PlanCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String price;
  final VoidCallback onTap;
  const _PlanCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.price,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: [
            Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                color: AppColors.goldSurface,
                borderRadius: BorderRadius.circular(13),
              ),
              child: Icon(icon, color: AppColors.gold, size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(subtitle,
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textSecondary)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(price,
                    style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w900,
                        color: AppColors.gold)),
                const SizedBox(height: 2),
                const Icon(Icons.chevron_right_rounded,
                    color: AppColors.textMuted, size: 20),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Paket kartına basınca açılan satın alma detay sayfası. Ne alındığını
/// açıkça anlatır ve satın almayı tamamlar. Başarılıysa `true` döner.
class _PurchaseSheet extends ConsumerStatefulWidget {
  final _PlanChoice choice;
  const _PurchaseSheet({required this.choice});
  @override
  ConsumerState<_PurchaseSheet> createState() => _PurchaseSheetState();
}

class _PurchaseSheetState extends ConsumerState<_PurchaseSheet> {
  bool _busy = false;
  String? _error;

  bool get _isPremium => widget.choice == _PlanChoice.premium;

  String get _title => _isPremium ? 'Premium' : 'Standart';

  String get _price => _isPremium
      ? DatingConfig.photoPremiumPriceLabel
      : DatingConfig.photoStandardPriceLabel;

  String get _productId => _isPremium
      ? DatingConfig.photoPremiumProductId
      : DatingConfig.photoStandardProductId;

  List<String> get _bullets => _isPremium
      ? [
          '50 Adet Stüdyo Kalitesinde 50 Fotoğraf',
          '5 farklı stile özel fotoğraflar',
          'En Çok Eşleşme Alan Fotoğrafları Üret',
          'Tek seferlik ödeme — abonelik yok',
        ]
      : [
          '10 Adet Stüdyo Kalitesinde 10 Fotoğraf',
          'Stile Özel Fotoğraflar',
          'En Çok Eşleşme Alan Fotoğrafları Üret',
          'Tek seferlik ödeme — abonelik yok',
        ];

  Future<void> _buy() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final service = ref.read(datingPurchaseServiceProvider);
    if (!service.isAvailable) {
      await service.init();
    }
    final product = service.productFor(_productId);
    if (product == null) {
      setState(() {
        _busy = false;
        _error = 'Bu paket şu anda satın alınamıyor. Lütfen tekrar dene.';
      });
      return;
    }

    final completer = Completer<bool>();
    void onVerified(PurchaseDetails p) {
      if (p.productID == _productId && !completer.isCompleted) {
        completer.complete(true);
      }
    }

    void onError(PurchaseDetails p) {
      if (p.productID == _productId && !completer.isCompleted) {
        completer.complete(false);
      }
    }

    service.onPurchaseVerified = onVerified;
    service.onPurchaseError = onError;
    try {
      await service.buy(product);
      final ok = await completer.future.timeout(
        const Duration(minutes: 3),
        onTimeout: () => false,
      );
      if (!mounted) return;
      if (ok) {
        Navigator.pop(context, true);
      } else {
        setState(() {
          _busy = false;
          _error = 'Satın alma tamamlanamadı. Lütfen tekrar dene.';
        });
      }
    } finally {
      service.onPurchaseVerified = null;
      service.onPurchaseError = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.fromLTRB(
          24, 12, 24, 24 + MediaQuery.of(context).padding.bottom),
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
          const SizedBox(height: 20),
          Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  gradient: AppColors.goldGradient,
                  borderRadius: BorderRadius.circular(15),
                ),
                child: Icon(
                    _isPremium
                        ? Icons.workspace_premium_rounded
                        : Icons.auto_awesome,
                    color: AppColors.textOnGold, size: 26),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(_title,
                    style: const TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w900,
                        height: 1.2,
                        color: AppColors.textPrimary)),
              ),
            ],
          ),
          const SizedBox(height: 20),
          for (final b in _bullets)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.check_circle_rounded,
                      color: AppColors.gold, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(b,
                        style: const TextStyle(
                            fontSize: 14,
                            height: 1.4,
                            color: AppColors.textPrimary)),
                  ),
                ],
              ),
            ),
          if (_error != null) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.error)),
            ),
          ],
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: ElevatedButton(
              onPressed: _busy ? null : _buy,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.gold,
                foregroundColor: AppColors.textOnGold,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16)),
              ),
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.4, color: AppColors.textOnGold),
                    )
                  : Text('$_price · Satın Al',
                      style: const TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w900)),
            ),
          ),
          const SizedBox(height: 8),
          Center(
            child: TextButton(
              onPressed: _busy ? null : () => Navigator.pop(context),
              child: const Text('Vazgeç',
                  style: TextStyle(color: AppColors.textSecondary)),
            ),
          ),
        ],
      ),
    );
  }
}
