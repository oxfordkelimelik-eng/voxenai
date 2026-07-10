import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';

/// Paket satın alma ekranı (abonelik YOK). Ücretsiz hak bitince modül
/// kullanımında soft gate olarak açılır. Sol üstte X ile kapatılır (zorlama yok).
/// Her modülün belirli sayıda kullanım içeren tek seferlik paketi vardır.
class PaywallScreen extends ConsumerStatefulWidget {
  const PaywallScreen({super.key});
  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  bool _busy = false;
  String? _busyProductId;

  /// Bir ürünü satın alır; sunucu tarafı doğrulama (verifyPurchase Cloud
  /// Function) sonucunu bekler, başarılıysa [onDone] rotasına gider.
  Future<void> _buy(String productId, String moduleRoute) async {
    setState(() {
      _busy = true;
      _busyProductId = productId;
    });
    final service = ref.read(datingPurchaseServiceProvider);
    if (!service.isAvailable) {
      await service.init();
    }
    final product = service.productFor(productId);
    if (product == null) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _busyProductId = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Bu paket şu anda satın alınamıyor.')));
      return;
    }

    final completer = Completer<bool>();
    void onVerified(PurchaseDetails p) {
      if (p.productID == productId && !completer.isCompleted) {
        completer.complete(true);
      }
    }

    void onError(PurchaseDetails p) {
      if (p.productID == productId && !completer.isCompleted) {
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
      setState(() {
        _busy = false;
        _busyProductId = null;
      });
      if (ok) {
        context.go(moduleRoute);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Satın alma tamamlanamadı. Lütfen tekrar dene.')));
      }
    } finally {
      service.onPurchaseVerified = null;
      service.onPurchaseError = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: IconButton(
                icon: const Icon(Icons.close_rounded,
                    color: AppColors.textSecondary),
                onPressed: () => context.pop(),
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.workspace_premium_rounded,
                        color: AppColors.gold, size: 52),
                    const SizedBox(height: 16),
                    const Text('Devam etmek için paket al',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary,
                            height: 1.25)),
                    const SizedBox(height: 8),
                    const Text(
                        'Abonelik yok. Tek ödemeyle belirli sayıda kullanım al; '
                        'bitince istersen yeniden alırsın.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: 14, color: AppColors.textSecondary)),
                    const SizedBox(height: 28),

                    const _SectionLabel('FOTOĞRAF ANALİZİ'),
                    const SizedBox(height: 10),
                    _PackCard(
                      icon: Icons.insights,
                      title: 'Tekli Analiz',
                      sub: '${DatingConfig.analysisSingleRuns} fotoğraf analizi',
                      price: DatingConfig.analysisSinglePriceLabel,
                      busy: _busyProductId ==
                          DatingConfig.analysisSingleProductId,
                      onTap: _busy
                          ? null
                          : () => _buy(DatingConfig.analysisSingleProductId,
                              '${DatingRoutes.module}/photo_analysis'),
                    ),
                    const SizedBox(height: 10),
                    _PackCard(
                      icon: Icons.insights,
                      title: 'Standart Analiz',
                      sub: '${DatingConfig.analysisStandardRuns} fotoğraf analizi',
                      price: DatingConfig.analysisStandardPriceLabel,
                      badge: 'AVANTAJLI',
                      busy: _busyProductId ==
                          DatingConfig.analysisStandardProductId,
                      onTap: _busy
                          ? null
                          : () => _buy(DatingConfig.analysisStandardProductId,
                              '${DatingRoutes.module}/photo_analysis'),
                    ),
                    const SizedBox(height: 22),

                    const _SectionLabel('AI DATING FOTOĞRAFI'),
                    const SizedBox(height: 10),
                    _PackCard(
                      icon: Icons.auto_awesome,
                      title: 'Standart Paket',
                      sub:
                          '${DatingConfig.photoStandardPhotos} fotoğraf · 1 stil',
                      price: DatingConfig.photoStandardPriceLabel,
                      busy:
                          _busyProductId == DatingConfig.photoStandardProductId,
                      onTap: _busy
                          ? null
                          : () => _buy(DatingConfig.photoStandardProductId,
                              '${DatingRoutes.module}/ai_photo'),
                    ),
                    const SizedBox(height: 10),
                    _PackCard(
                      icon: Icons.auto_awesome,
                      title: 'Premium Paket',
                      sub:
                          '${DatingConfig.photoPremiumPhotos} fotoğraf · 5 farklı stil',
                      price: DatingConfig.photoPremiumPriceLabel,
                      badge: 'EN İYİ DEĞER',
                      busy:
                          _busyProductId == DatingConfig.photoPremiumProductId,
                      onTap: _busy
                          ? null
                          : () => _buy(DatingConfig.photoPremiumProductId,
                              '${DatingRoutes.module}/ai_photo'),
                    ),
                    const SizedBox(height: 24),
                    _review(),
                  ],
                ),
              ),
            ),
            TextButton(
              onPressed: _busy
                  ? null
                  : () async {
                      await ref.read(entitlementProvider.notifier).restore();
                      await ref.read(datingPurchaseServiceProvider).restore();
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                          content: Text('Satın alımlar kontrol edildi.')));
                    },
              child: const Text('Satın Alımları Geri Yükle',
                  style: TextStyle(
                      fontSize: 13, color: AppColors.textSecondary)),
            ),
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text(
                'Tek seferlik ödeme · otomatik yenileme yok.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10, color: AppColors.textMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _review() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(
                5,
                (_) => const Icon(Icons.star_rounded,
                    color: AppColors.gold, size: 20)),
          ),
          const SizedBox(height: 8),
          const Text('"Eşleşme sayım gerçekten arttı. Fotoğraflar çok iyi."',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 13,
                  fontStyle: FontStyle.italic,
                  color: AppColors.textSecondary)),
          const SizedBox(height: 6),
          const Text('— Emre, 24',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
        ],
      ),
    );
  }
}

/// Bölüm başlığı (paket gruplarını ayırır).
class _SectionLabel extends StatelessWidget {
  final String label;
  const _SectionLabel(this.label);

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(label,
          style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w900,
              letterSpacing: 1,
              color: AppColors.textMuted)),
    );
  }
}

/// Tek seferlik paket kartı.
class _PackCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  final String price;
  final String? badge;
  final bool busy;
  final VoidCallback? onTap;
  const _PackCard({
    required this.icon,
    required this.title,
    required this.sub,
    required this.price,
    required this.onTap,
    this.badge,
    this.busy = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.borderGold, width: 0.8),
        ),
        child: Row(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: AppColors.goldSurface,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: AppColors.gold, size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(title,
                          style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w800,
                              color: AppColors.textPrimary)),
                      if (badge != null) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.gold,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(badge!,
                              style: const TextStyle(
                                  fontSize: 9,
                                  fontWeight: FontWeight.w900,
                                  color: AppColors.textOnGold)),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(sub,
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textSecondary)),
                ],
              ),
            ),
            if (busy)
              const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                    strokeWidth: 2.2, color: AppColors.gold),
              )
            else ...[
              Text(price,
                  style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w900,
                      color: AppColors.gold)),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right_rounded,
                  color: AppColors.textMuted),
            ],
          ],
        ),
      ),
    );
  }
}
