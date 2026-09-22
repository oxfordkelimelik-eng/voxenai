import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../paywall/purchase_auth_gate.dart';
import '../providers/dating_providers.dart';
import '../widgets/analysis_addon_tile.dart';
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

// ANALİZ PAKETLERİ TEK BAŞINA SATILMIYOR (2026-09-21 kuralı) — analysis1/5
// buradan kaldırıldı; analiz artık her foto paketinin ALTINDA opsiyonel
// eklenti olarak seçiliyor (bkz. AnalysisAddOnTile). Paket listesi paywall
// ile ORTAK (DatingConfig.photoPackTiers), iki ekran ayrışmasın.

class _ModulesShowcaseScreenState extends ConsumerState<ModulesShowcaseScreen> {
  final _pageController = PageController();
  int _page = 0;
  Timer? _autoScroll;
  bool _busy = false;
  String? _busyProductId;

  // Eklenti kutucukları VARSAYILAN İŞARETLİ (paywall ile aynı kural).
  final Map<String, bool> _analysisAddOn = {
    for (final t in DatingConfig.photoPackTiers) t.soloProductId: true,
  };

  static const _slides = [
    (
      DatingAssetPaths.showcaseSlide1,
      Icons.auto_awesome,
      'Stüdyo kalitesinde dating fotoğrafları',
      'Birkaç selfie yükle, AI yüzünü koruyarak yeni kareler üretsin.'
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
    _loadStorePrices();
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

  Future<void> _loadStorePrices() async {
    await ref.read(datingPurchaseServiceProvider).init();
    if (mounted) setState(() {});
  }

  String _price(String productId) => datingStorePrice(
        ref.read(datingPurchaseServiceProvider),
        productId,
      );

  @override
  void dispose() {
    _autoScroll?.cancel();
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _openUrl(String url) async {
    final uri = Uri.parse(url);
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (!mounted) return;
      context.push(DatingRoutes.settings);
    }
  }

  /// Seçili eklenti durumuna göre gerçekte satın alınacak ürün.
  String _productIdFor(PhotoPackTier tier) =>
      tier.productId(withAnalysis: _analysisAddOn[tier.soloProductId] ?? true);

  Future<void> _buy(PhotoPackTier tier) async {
    // Spinner artık YALNIZCA satın alınan paketin satırında dönüyor (eskiden
    // hepsi birden "meşgul" görünürdü). Bu yüzden diğer satırların dokunuşu
    // açık kalıyor — ikinci bir mağaza akışının üstüne binmesini burada
    // engelliyoruz.
    if (_busy) return;
    final productId = _productIdFor(tier);
    // Bu ekran GİRİŞSİZ gezilebiliyor; mağaza akışı başlamadan önce giriş şart
    // (bkz. purchase_auth_gate.dart — 2026-08-19 App Store 2.1(b) reddi).
    if (!await ensureSignedInForPurchase(context, ref)) return;
    if (!mounted) return;
    setState(() {
      _busy = true;
      _busyProductId = productId;
    });
    final ok =
        await ref.read(datingPurchaseServiceProvider).purchaseAndWait(productId);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _busyProductId = null;
    });
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma başarılı! Paketin hesabına eklendi.')));
      context.go(DatingRoutes.hub);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma tamamlanamadı. Lütfen tekrar dene.')));
    }
  }

  /// Bir paket + ona BAĞLI analiz eklentisi, tek kart gövdesinde.
  ///
  /// Paket satırına dokunmak doğrudan satın alma başlatır (bu ekranın kuralı);
  /// eklenti kutucuğu AYRI bir dokunma alanıdır ve yalnızca seçimi değiştirir
  /// — kutucuğa basan kullanıcı yanlışlıkla ödeme ekranı açmaz.
  Widget _packBlock(PhotoPackTier tier) {
    final addOnOn = _analysisAddOn[tier.soloProductId] ?? true;
    final effectiveId = _productIdFor(tier);
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: addOnOn ? AppColors.borderGold : AppColors.borderSubtle,
          width: 0.8,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (tier.badge != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              color: AppColors.gold,
              child: Text(
                tier.badge!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.8,
                  color: AppColors.textOnGold,
                ),
              ),
            ),
          _PriceRow(
            icon: Icons.auto_awesome,
            title: tier.title,
            sub: '${tier.photos} fotoğraf',
            // Fiyat, eklenti işaretliyken PAKET+EKLENTİ toplamıdır; altta
            // kırmızı duran rakam yalnızca eklentinin farkı.
            price: _price(effectiveId),
            busy: _busy && _busyProductId == effectiveId,
            onTap: () => _buy(tier),
          ),
          AnalysisAddOnTile(
            compact: true,
            checked: addOnOn,
            runs: tier.addOnRuns,
            priceLabel: datingAddOnPriceLabel(
              ref.read(datingPurchaseServiceProvider),
              tier.soloProductId,
              tier.addOnProductId,
            ),
            onChanged: _busy
                ? null
                : (v) => setState(() => _analysisAddOn[tier.soloProductId] = v),
          ),
        ],
      ),
    );
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
                              // Yüz görselin dikey ortasında; 'center' ile
                              // geniş kapaktan yüz tam ortalanır (üstten
                              // kırpınca yüz aşağıda kesiliyordu).
                              alignment: Alignment.center,
                            ),
                          ),
                          // Yazı okunurluğu için alttan yukarı koyulaşan
                          // gradient — üst kısım neredeyse şeffaf, böylece yüz
                          // kararmaz; yalnızca alttaki metin bloğu koyulaşır.
                          DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [
                                  Colors.transparent,
                                  Colors.black.withValues(alpha: 0.30),
                                  Colors.black.withValues(alpha: 0.78),
                                ],
                                stops: const [0.0, 0.55, 1.0],
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
                            'Canlı yüz çekimi yeter. AI yüzünü koruyarak '
                            'seçtiğin mekân ve tarzda profesyonel fotoğraflar üretir.',
                        bullets: [
                          'Her fotoğrafta farklı mekân ve kadraj',
                          'Yüzünü koruyan gerçekçi sonuç',
                          '${DatingConfig.photoStarterPhotos}, '
                              '${DatingConfig.photoStandardPhotos} veya '
                              '${DatingConfig.photoPremiumPhotos} fotoğraf paketleri',
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
                        bullets: [
                          'Çekicilik skoru',
                          'Somut iyileştirme önerileri',
                          // Analiz artık tek başına satılmıyor (2026-09-21
                          // kuralı) — AI foto paketi alırken opsiyonel
                          // eklenti olarak ekleniyor.
                          'AI foto paketi alırken opsiyonel eklenti olarak eklenir',
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
                    // Üstü çizili "eski fiyat" GÖSTERİLMİYOR: paket
                    // içerikleri değişti, eski rakamı indirim gibi göstermek
                    // yanıltıcı olur (App Store "yanıltıcı fiyat").
                    //
                    // KAYDIRILABİLİR (2026-09-22): her paketin altına bağlı
                    // bir eklenti satırı geldi, blok yüksekliği iki katına
                    // çıktı. Eskiden satırlar Expanded ile mevcut yüksekliği
                    // paylaşıyordu; küçük ekranda bu, sabit puntolu metinleri
                    // taşırırdı. Artık doğal yükseklikte çizilip kaydırılıyor.
                    Expanded(
                      child: SingleChildScrollView(
                        child: Column(
                          children: [
                            for (final tier in DatingConfig.photoPackTiers) ...[
                              _packBlock(tier),
                              const SizedBox(height: 10),
                            ],
                          ],
                        ),
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
                  // "Ücretsiz" ibaresi kaldırıldı (2026-09-15): foto üretimi
                  // ve analizde ücretsiz hak kapatıldı, vaat artık doğru değil.
                  child: const Text('Hemen Başla',
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
                    onPressed: () => _openUrl(DatingConfig.privacyPolicyUrl),
                    child: const Text('Gizlilik',
                        style: TextStyle(
                            fontSize: 11, color: AppColors.textMuted)),
                  ),
                  const Text('·',
                      style: TextStyle(color: AppColors.textMuted)),
                  TextButton(
                    onPressed: () => _openUrl(DatingConfig.termsOfUseUrl),
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

/// Paketin ÜST satırı. Çerçeveyi/zemini artık _packBlock çiziyor (paket ve
/// eklentisi tek kart gövdesinde görünmeli), bu yüzden burada kendi
/// dekorasyonu YOK — iki çerçeve iç içe geçerdi.
class _PriceRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  final String price;
  final bool busy;
  final VoidCallback onTap;
  const _PriceRow({
    required this.icon,
    required this.title,
    required this.sub,
    required this.price,
    required this.busy,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: busy ? null : onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
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
            if (busy)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                    strokeWidth: 2, color: AppColors.gold),
              )
            else
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
