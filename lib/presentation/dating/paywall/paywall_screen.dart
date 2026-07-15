import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../providers/dating_providers.dart';

/// Hangi paket grubunun gösterileceği.
enum PaywallMode { all, analysis, aiPhoto }

PaywallMode paywallModeFromQuery(String? mode) => switch (mode) {
      'analysis' => PaywallMode.analysis,
      'ai_photo' => PaywallMode.aiPhoto,
      _ => PaywallMode.all,
    };

/// Paket satın alma ekranı (abonelik YOK). Modül bağlamına göre yalnızca
/// ilgili paketler gösterilebilir (analysis / ai_photo query param).
class PaywallScreen extends ConsumerStatefulWidget {
  final PaywallMode mode;
  const PaywallScreen({super.key, this.mode = PaywallMode.all});
  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  bool _busy = false;
  String? _busyProductId;

  String get _title => switch (widget.mode) {
        PaywallMode.analysis => 'Fotoğraf Analizi Paketi',
        PaywallMode.aiPhoto => 'AI Dating Fotoğraf Paketi',
        PaywallMode.all => 'Devam etmek için paket al',
      };

  String get _subtitle => switch (widget.mode) {
        PaywallMode.analysis =>
          'Fotoğraflarının detaylı analizini açmak için tek seferlik paket al.',
        PaywallMode.aiPhoto =>
          'Kalan AI fotoğraflarını açmak için tek seferlik paket al.',
        PaywallMode.all =>
          'Abonelik yok. Tek ödemeyle belirli sayıda kullanım al; bitince istersen yeniden alırsın.',
      };

  Future<void> _buy(String productId) async {
    setState(() {
      _busy = true;
      _busyProductId = productId;
    });
    final service = ref.read(datingPurchaseServiceProvider);
    final ok = await service.purchaseAndWait(productId);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _busyProductId = null;
    });
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma başarılı! Paketin hesabına eklendi.')));
      context.pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Satın alma tamamlanamadı. Lütfen tekrar dene.')));
    }
  }

  bool get _showAnalysis =>
      widget.mode == PaywallMode.all || widget.mode == PaywallMode.analysis;

  bool get _showAiPhoto =>
      widget.mode == PaywallMode.all || widget.mode == PaywallMode.aiPhoto;

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
                onPressed: () => context.pop(false),
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
                    Text(_title,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary,
                            height: 1.25)),
                    const SizedBox(height: 8),
                    Text(_subtitle,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            fontSize: 14, color: AppColors.textSecondary)),
                    const SizedBox(height: 28),
                    if (_showAnalysis) ...[
                      const _SectionLabel('FOTOĞRAF ANALİZİ'),
                      const SizedBox(height: 10),
                      _PackCard(
                        icon: Icons.insights,
                        title: 'Tekli Analiz',
                        sub:
                            '${DatingConfig.analysisSingleRuns} fotoğraf analizi',
                        price: DatingConfig.analysisSinglePriceLabel,
                        busy: _busyProductId ==
                            DatingConfig.analysisSingleProductId,
                        onTap: _busy
                            ? null
                            : () => _buy(DatingConfig.analysisSingleProductId),
                      ),
                      const SizedBox(height: 10),
                      _PackCard(
                        icon: Icons.insights,
                        title: 'Standart Analiz',
                        sub:
                            '${DatingConfig.analysisStandardRuns} fotoğraf analizi',
                        price: DatingConfig.analysisStandardPriceLabel,
                        badge: 'AVANTAJLI',
                        busy: _busyProductId ==
                            DatingConfig.analysisStandardProductId,
                        onTap: _busy
                            ? null
                            : () =>
                                _buy(DatingConfig.analysisStandardProductId),
                      ),
                      if (_showAiPhoto) const SizedBox(height: 22),
                    ],
                    if (_showAiPhoto) ...[
                      const _SectionLabel('AI DATING FOTOĞRAFI'),
                      const SizedBox(height: 10),
                      _PackCard(
                        icon: Icons.auto_awesome,
                        title: 'Standart Paket',
                        sub:
                            '${DatingConfig.photoStandardPhotos} fotoğraf · 1 stil',
                        price: DatingConfig.photoStandardPriceLabel,
                        busy: _busyProductId ==
                            DatingConfig.photoStandardProductId,
                        onTap: _busy
                            ? null
                            : () => _buy(DatingConfig.photoStandardProductId),
                      ),
                      const SizedBox(height: 10),
                      _PackCard(
                        icon: Icons.auto_awesome,
                        title: 'Premium Paket',
                        sub:
                            '${DatingConfig.photoPremiumPhotos} fotoğraf · 5 farklı stil',
                        price: DatingConfig.photoPremiumPriceLabel,
                        badge: 'EN İYİ DEĞER',
                        busy: _busyProductId ==
                            DatingConfig.photoPremiumProductId,
                        onTap: _busy
                            ? null
                            : () => _buy(DatingConfig.photoPremiumProductId),
                      ),
                    ],
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
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.borderGold, width: 0.8),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (badge != null)
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                color: AppColors.gold,
                child: Text(
                  badge!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 0.8,
                    color: AppColors.textOnGold,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.all(16),
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
                        Text(title,
                            style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                                color: AppColors.textPrimary)),
                        const SizedBox(height: 4),
                        Text(sub,
                            style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.textSecondary,
                                height: 1.3)),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  if (busy)
                    const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: AppColors.gold),
                    )
                  else
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(price,
                            style: const TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.w900,
                                color: AppColors.gold,
                                height: 1.1)),
                        const SizedBox(height: 2),
                        const Icon(Icons.chevron_right_rounded,
                            color: AppColors.textMuted, size: 22),
                      ],
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
