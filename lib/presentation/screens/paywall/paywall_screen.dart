import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_strings.dart';
import '../../../data/sources/billing_service.dart';
import '../../providers/app_providers.dart';

class PaywallScreen extends ConsumerWidget {
  const PaywallScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Kapat butonu
              Align(
                alignment: Alignment.topRight,
                child: GestureDetector(
                  onTap: () => context.pop(),
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceElevated,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.close_rounded,
                      color: AppColors.textSecondary,
                      size: 20,
                    ),
                  ),
                ),
              ),

              const SizedBox(height: 8),

              // Başlık
              Center(
                child: Column(
                  children: [
                    ShaderMask(
                      shaderCallback: (b) =>
                          AppColors.goldGradient.createShader(b),
                      child: const Text(
                        '👑 VOXEN AI PRO',
                        style: TextStyle(
                          fontSize: 32,
                          fontWeight: FontWeight.w900,
                          color: Colors.white,
                          letterSpacing: 2,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Tüm yapay zeka özelliklerine\nsınırsız erişim',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 15,
                        color: AppColors.textSecondary,
                        height: 1.4,
                      ),
                    ),
                  ],
                ),
              ).animate().fadeIn(duration: 400.ms),

              const SizedBox(height: 24),

              // Özellik listesi
              _FeaturesList(),

              const SizedBox(height: 28),

              // Fiyatlandırma planları
              _PlanCard(
                title: AppStrings.weeklyPlan,
                price: AppStrings.weeklyPrice,
                subtitle: 'İstediğin zaman iptal et',
                badge: null,
                isSelected: true,
                onTap: () => _purchasePlan(context, ref, 'weekly'),
              ),

              const SizedBox(height: 10),

              _PlanCard(
                title: AppStrings.monthlyPlan,
                price: AppStrings.monthlyPrice,
                subtitle: '~₺11/gün — Günlük kahvenden ucuz',
                badge: AppStrings.mostPopular,
                isSelected: false,
                onTap: () => _purchasePlan(context, ref, 'monthly'),
              ),

              const SizedBox(height: 24),

              // CTA butonu
              ElevatedButton(
                onPressed: () => _purchasePlan(context, ref, 'weekly'),
                child: const Text(AppStrings.unlockNow),
              ).animate(delay: 300.ms).fadeIn().slideY(begin: 0.2, end: 0),

              const SizedBox(height: 12),

              // Alt bilgi
              const Center(
                child: Text(
                  '🔒 Güvenli ödeme · İstediğin zaman iptal',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
              ),

              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }

  void _purchasePlan(BuildContext context, WidgetRef ref, String plan) async {
    final billing = ref.read(billingServiceProvider);

    // Plan adını Play Console ürün ID'sine eşle
    final productId =
        plan == 'weekly' ? BillingService.weeklyId : BillingService.monthlyId;

    // Mağaza hazır değilse (emülatör / yapılandırılmamış) bilgilendir
    if (!billing.isAvailable || billing.products.isEmpty) {
      showDialog(
        context: context,
        builder: (_) => AlertDialog(
          backgroundColor: AppColors.surfaceElevated,
          title: const Text(
            'Ödeme Hazır Değil',
            style: TextStyle(color: AppColors.textPrimary),
          ),
          content: const Text(
            'Google Play ödeme sistemi bu cihazda/ortamda kullanılamıyor. '
            'Gerçek satın alma için uygulamanın Play Store üzerinden (internal test dahil) '
            'kurulmuş olması ve aboneliklerin Play Console\'da tanımlı olması gerekir.',
            style: TextStyle(color: AppColors.textSecondary),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Tamam',
                  style: TextStyle(color: AppColors.gold)),
            ),
          ],
        ),
      );
      return;
    }

    // Gerçek satın alma akışını başlat
    final product = billing.products.firstWhere(
      (p) => p.id == productId,
      orElse: () => billing.products.first,
    );
    await billing.buy(product);
    // Sonuç purchaseStream üzerinden gelir; başarıda billingServiceProvider
    // otomatik setPro(true) çağırır. Kullanıcıya kısa bilgi ver.
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Satın alma başlatıldı...')),
      );
    }
  }
}

class _FeaturesList extends StatelessWidget {
  final features = const [
    (Icons.face_retouching_natural, 'Sınırsız AI Yüz & Postür Analizi'),
    (Icons.psychology_rounded, 'Sosyal Simülatör — Sınırsız Senaryo'),
    (Icons.compare_rounded, 'Önce/Sonra Gelişim Karşılaştırma'),
    (Icons.fitness_center_rounded, 'Kişiselleştirilmiş Antrenman Planı'),
    (Icons.auto_awesome_rounded, 'AI Üretilen Günlük Görevler'),
    (Icons.bar_chart_rounded, 'Gelişim Takip Grafikleri'),
  ];

  const _FeaturesList();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderGold),
      ),
      child: Column(
        children: features
            .map(
              (f) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: AppColors.goldSurface,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(f.$1, color: AppColors.gold, size: 18),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      f.$2,
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),
            )
            .toList(),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final String title;
  final String price;
  final String subtitle;
  final String? badge;
  final bool isSelected;
  final VoidCallback onTap;

  const _PlanCard({
    required this.title,
    required this.price,
    required this.subtitle,
    required this.isSelected,
    required this.onTap,
    this.badge,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: isSelected ? AppColors.goldSurface : AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? AppColors.gold : AppColors.borderSubtle,
            width: isSelected ? 1.5 : 0.5,
          ),
        ),
        child: Row(
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: isSelected
                            ? AppColors.gold
                            : AppColors.textPrimary,
                      ),
                    ),
                    if (badge != null) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.gold.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          badge!,
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: AppColors.gold,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                Text(
                  subtitle,
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
            const Spacer(),
            Text(
              price,
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w900,
                color: isSelected ? AppColors.gold : AppColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
