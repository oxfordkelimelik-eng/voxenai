import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_strings.dart';
import '../../../core/router/app_router.dart';
import '../../../data/sources/billing_service.dart';
import '../../providers/app_providers.dart';

class TrialScreen extends ConsumerStatefulWidget {
  const TrialScreen({super.key});

  @override
  ConsumerState<TrialScreen> createState() => _TrialScreenState();
}

class _TrialScreenState extends ConsumerState<TrialScreen> {
  String _selectedPlan = 'monthly';

  @override
  Widget build(BuildContext context) {
    final trialStatus = ref.watch(trialStatusProvider);
    final daysRemaining = ref.watch(trialDaysRemainingProvider);
    final isExpired = trialStatus == TrialStatus.expired;

    return PopScope(
      // Deneme dolduysa geri tuşuyla uygulamaya kaçış engellenir (sert duvar)
      canPop: !isExpired,
      child: Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
          child: Column(
            children: [
              // Header
              _buildHeader(isExpired, daysRemaining),
              const SizedBox(height: 28),

              // Features
              _FeaturesList(),
              const SizedBox(height: 24),

              // Plan kartları
              _buildPlanCard(
                title: 'Haftalık Pro',
                price: AppStrings.weeklyPrice,
                subtitle: 'İstediğin zaman iptal et',
                badge: null,
                isSelected: _selectedPlan == 'weekly',
                onTap: () => setState(() => _selectedPlan = 'weekly'),
              ),
              const SizedBox(height: 10),
              _buildPlanCard(
                title: 'Aylık Pro',
                price: AppStrings.monthlyPrice,
                subtitle: '~₺5/gün — Günlük kahveden ucuz',
                badge: 'EN POPÜLER',
                isSelected: _selectedPlan == 'monthly',
                onTap: () => setState(() => _selectedPlan = 'monthly'),
              ),
              const SizedBox(height: 24),

              // CTA
              if (!isExpired) ...[
                ElevatedButton(
                  onPressed: () => context.go(AppRoutes.home),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                  ),
                  child: const Text('UYGULAMAYA BAŞLA'),
                ).animate(delay: 400.ms).fadeIn().slideY(begin: 0.2, end: 0),
                const SizedBox(height: 12),
                Text(
                  '3 günlük denemen başladı. Deneme biterken\nistediğin zaman iptal edebilirsin.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppColors.textMuted,
                    height: 1.5,
                  ),
                ),
              ] else ...[
                ElevatedButton(
                  onPressed: _showPurchaseDialog,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                  ),
                  child: Text(
                    'HEMEN BAŞLA — ${_selectedPlan == 'weekly' ? AppStrings.weeklyPrice : AppStrings.monthlyPrice}',
                  ),
                ).animate(delay: 400.ms).fadeIn().slideY(begin: 0.2, end: 0),
                const SizedBox(height: 14),
                TextButton(
                  onPressed: () => ref.read(billingServiceProvider).restore(),
                  child: const Text(
                    'Satın alımları geri yükle',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                  ),
                ),
              ],
              const SizedBox(height: 8),
              const Text(
                '🔒 Güvenli ödeme · İstediğin zaman iptal',
                style: TextStyle(fontSize: 11, color: AppColors.textMuted),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
      ),
    );
  }

  Widget _buildHeader(bool isExpired, int daysRemaining) {
    return Column(
      children: [
        // Logo
        Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: isExpired ? null : AppColors.goldGradient,
                color: isExpired ? AppColors.surfaceElevated : null,
                border: isExpired
                    ? Border.all(color: AppColors.borderGold, width: 1.5)
                    : null,
                boxShadow: isExpired
                    ? null
                    : [
                        BoxShadow(
                          color: AppColors.goldGlow,
                          blurRadius: 24,
                          spreadRadius: 4,
                        ),
                      ],
              ),
              child: Icon(
                isExpired ? Icons.lock_rounded : Icons.arrow_upward_rounded,
                color: isExpired ? AppColors.gold : AppColors.textOnGold,
                size: 36,
              ),
            )
            .animate()
            .scale(
              begin: const Offset(0.5, 0.5),
              curve: Curves.elasticOut,
              duration: 700.ms,
            )
            .fadeIn(),

        const SizedBox(height: 20),

        if (isExpired) ...[
          const Text(
            'DENEMENİZ DOLDU',
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w900,
              color: AppColors.textPrimary,
              letterSpacing: 1.5,
            ),
            textAlign: TextAlign.center,
          ).animate(delay: 200.ms).fadeIn().slideY(begin: 0.15, end: 0),
          const SizedBox(height: 10),
          const Text(
            '3 günlük ücretsiz deneme sona erdi.\nRise Up Pro ile gelişmeye devam et.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              color: AppColors.textSecondary,
              height: 1.5,
            ),
          ).animate(delay: 300.ms).fadeIn(),
        ] else ...[
          ShaderMask(
            shaderCallback: (b) => AppColors.goldGradient.createShader(b),
            child: const Text(
              '3 GÜN ÜCRETSİZ',
              style: TextStyle(
                fontSize: 30,
                fontWeight: FontWeight.w900,
                color: Colors.white,
                letterSpacing: 2,
              ),
              textAlign: TextAlign.center,
            ),
          ).animate(delay: 200.ms).fadeIn().slideY(begin: 0.15, end: 0),
          const SizedBox(height: 10),
          Text(
            'Rise Up Pro denemen başladı!\nTüm özelliklere $daysRemaining gün daha ücretsiz eriş.',
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 14,
              color: AppColors.textSecondary,
              height: 1.5,
            ),
          ).animate(delay: 300.ms).fadeIn(),
          const SizedBox(height: 14),
          // Countdown badge
          Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: AppColors.goldSurface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.borderGold),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.timer_rounded,
                      color: AppColors.gold,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '$daysRemaining gün kaldı',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: AppColors.gold,
                      ),
                    ),
                  ],
                ),
              )
              .animate(delay: 400.ms)
              .fadeIn()
              .scale(begin: const Offset(0.9, 0.9), end: const Offset(1, 1)),
        ],
      ],
    );
  }

  Widget _buildPlanCard({
    required String title,
    required String price,
    required String subtitle,
    required String? badge,
    required bool isSelected,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
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
            Expanded(
              child: Column(
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
                            horizontal: 7,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.goldSurface,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            badge,
                            style: const TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w800,
                              color: AppColors.gold,
                              letterSpacing: 0.5,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
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

  Future<void> _showPurchaseDialog() async {
    final billing = ref.read(billingServiceProvider);
    final priceLabel =
        _selectedPlan == 'weekly' ? AppStrings.weeklyPrice : AppStrings.monthlyPrice;

    // Mağaza hazırsa gerçek Google Play satın alma akışını başlat
    if (billing.isAvailable && billing.products.isNotEmpty) {
      final productId = _selectedPlan == 'weekly'
          ? BillingService.weeklyId
          : BillingService.monthlyId;
      final product = billing.products.firstWhere(
        (p) => p.id == productId,
        orElse: () => billing.products.first,
      );
      await billing.buy(product);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Satın alma başlatıldı...')),
        );
      }
      return;
    }

    // Mağaza yoksa (emülatör / yapılandırılmamış) bilgilendir
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text(
          'Pro Üyelik',
          style: TextStyle(
            color: AppColors.textPrimary,
            fontWeight: FontWeight.w800,
          ),
        ),
        content: Text(
          '$priceLabel plan seçildi.\n\nGerçek satın alma için uygulamanın Google Play üzerinden kurulu olması ve aboneliklerin Play Console\'da tanımlı olması gerekir.',
          style: const TextStyle(color: AppColors.textSecondary, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Kapat',
              style: TextStyle(color: AppColors.textMuted),
            ),
          ),
          ElevatedButton(
            onPressed: () {
              ref.read(userProfileProvider.notifier).setPro(true);
              ref.read(trialProvider.notifier).reload();
              Navigator.pop(context);
              context.go(AppRoutes.home);
            },
            child: const Text('Test: Pro Aktifleştir'),
          ),
        ],
      ),
    );
  }
}

// ─── Features List ───────────────────────────────────────────
class _FeaturesList extends StatelessWidget {
  const _FeaturesList();

  static const _features = [
    (Icons.face_retouching_natural, 'Sınırsız AI Yüz & Postür Analizi'),
    (Icons.psychology_rounded, 'Sosyal Simülatör — Tüm Senaryolar'),
    (Icons.local_fire_department_rounded, 'Streak & XP Gamification'),
    (Icons.fitness_center_rounded, 'Kişisel Antrenman Planı'),
    (Icons.auto_awesome_rounded, 'AI Üretilen Günlük Görevler'),
    (Icons.bar_chart_rounded, 'Gelişim Takip Grafikleri'),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderGold, width: 0.5),
      ),
      child: Column(
        children: _features
            .map(
              (f) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 7),
                child: Row(
                  children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: AppColors.goldSurface,
                        borderRadius: BorderRadius.circular(10),
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
