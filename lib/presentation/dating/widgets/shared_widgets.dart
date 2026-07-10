import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../providers/dating_providers.dart';
import 'dating_widgets.dart';

// ============================================================
// AI YÜKLEME DENEYİMİ (Bölüm 6.8 — zorunlu)
// İlerleme yüzdesi + akan durum metinleri + hata/tekrar dene.
// Onboarding "Senin için hazırlıyoruz" ile aynı görsel dil.
// ============================================================

class AiLoadingView extends StatefulWidget {
  final List<String> steps; // akan durum metinleri
  final String hint; // "genelde ~10 saniye sürer"
  const AiLoadingView({
    super.key,
    required this.steps,
    this.hint = 'Bu işlem genelde ~10 saniye sürer',
  });

  @override
  State<AiLoadingView> createState() => _AiLoadingViewState();
}

class _AiLoadingViewState extends State<AiLoadingView>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  int _stepIndex = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(seconds: 12))
      ..forward();
    _timer = Timer.periodic(const Duration(milliseconds: 2200), (t) {
      if (!mounted) return;
      setState(() => _stepIndex = (_stepIndex + 1) % widget.steps.length);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 96,
              height: 96,
              child: AnimatedBuilder(
                animation: _c,
                builder: (_, _) => Stack(
                  alignment: Alignment.center,
                  children: [
                    CircularProgressIndicator(
                      value: _c.value,
                      strokeWidth: 6,
                      backgroundColor: AppColors.surfaceElevated,
                      valueColor:
                          const AlwaysStoppedAnimation(AppColors.gold),
                    ),
                    Text('${(_c.value * 100).toInt()}%',
                        style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 28),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 400),
              child: Text(
                widget.steps[_stepIndex],
                key: ValueKey(_stepIndex),
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary),
              ),
            ),
            const SizedBox(height: 12),
            Text(widget.hint,
                style: const TextStyle(
                    fontSize: 13, color: AppColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

/// Hata durumu + Tekrar Dene (Bölüm 6.8 — kullanıcı asla donuk ekranda kalmaz).
class AiErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const AiErrorView({super.key, required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline_rounded,
                color: AppColors.error, size: 56),
            const SizedBox(height: 16),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 15, color: AppColors.textSecondary)),
            const SizedBox(height: 24),
            SizedBox(
              width: 200,
              child: PrimaryButton(label: 'Tekrar Dene', onPressed: onRetry),
            ),
          ],
        ),
      ),
    );
  }
}

// ============================================================
// FOTOĞRAF KALİTE REHBERİ (Bölüm 6.8b — zorunlu)
// ============================================================

class PhotoQualityGuide extends StatelessWidget {
  const PhotoQualityGuide({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.tips_and_updates_outlined,
                  color: AppColors.gold, size: 20),
              SizedBox(width: 8),
              Text('En iyi sonuç için',
                  style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
            ],
          ),
          const SizedBox(height: 12),
          const Text(
            'Net, iyi ışıklı, yüzün açıkça göründüğü bir fotoğraf seç. '
            'Filtreli, bulanık veya çok karanlık fotoğraflardan kaçın.',
            style: TextStyle(
                fontSize: 13, color: AppColors.textSecondary, height: 1.4),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _tag('✅ Net', AppColors.success),
              _tag('✅ İyi ışık', AppColors.success),
              _tag('✅ Yüz görünür', AppColors.success),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _tag('❌ Bulanık', AppColors.error),
              _tag('❌ Karanlık', AppColors.error),
              _tag('❌ Filtreli', AppColors.error),
            ],
          ),
        ],
      ),
    );
  }

  Widget _tag(String text, Color color) => Container(
        margin: const EdgeInsets.only(right: 8),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(text,
            style: TextStyle(
                fontSize: 11, fontWeight: FontWeight.w700, color: color)),
      );
}

// ============================================================
// BOŞ DURUM (Bölüm 6.7 — her modül için zorunlu)
// ============================================================

class ModuleEmptyState extends StatelessWidget {
  final IconData icon;
  final String howItWorks; // 1-2 cümle
  final Widget beforeAfter; // örnek önce/sonra
  final String ctaLabel;
  final VoidCallback onStart;
  const ModuleEmptyState({
    super.key,
    required this.icon,
    required this.howItWorks,
    required this.beforeAfter,
    required this.ctaLabel,
    required this.onStart,
  });

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          // Nasıl çalışır: yükle → analiz → sonuç
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: AppColors.goldSurface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.borderGold),
            ),
            child: Row(
              children: [
                Icon(icon, color: AppColors.gold, size: 32),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(howItWorks,
                      style: const TextStyle(
                          fontSize: 14,
                          color: AppColors.textPrimary,
                          height: 1.4)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const _StepsRow(),
          const SizedBox(height: 20),
          const Text('ÖRNEK SONUÇ',
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1,
                  color: AppColors.textSecondary)),
          const SizedBox(height: 12),
          beforeAfter,
          const SizedBox(height: 28),
          PrimaryButton(label: ctaLabel, onPressed: onStart),
        ],
      ),
    );
  }
}

class _StepsRow extends StatelessWidget {
  const _StepsRow();
  @override
  Widget build(BuildContext context) {
    Widget step(IconData i, String t) => Column(
          children: [
            Icon(i, color: AppColors.textSecondary, size: 22),
            const SizedBox(height: 4),
            Text(t,
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary)),
          ],
        );
    Widget arrow() => const Icon(Icons.arrow_forward_rounded,
        color: AppColors.textMuted, size: 18);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        step(Icons.upload_rounded, 'Yükle'),
        arrow(),
        step(Icons.auto_awesome, 'Analiz'),
        arrow(),
        step(Icons.check_circle_outline, 'Sonuç'),
      ],
    );
  }
}

// ============================================================
// KREDİ ROZETİ (Bölüm 6.9 — bakiye her zaman görünür)
// ============================================================

class CreditBadge extends ConsumerWidget {
  const CreditBadge({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final credits = ref.watch(creditsProvider);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderGold, width: 0.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.stars_rounded, color: AppColors.gold, size: 16),
          const SizedBox(width: 5),
          Text('$credits',
              style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: AppColors.gold)),
          const SizedBox(width: 3),
          const Text('kredi',
              style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

/// Basit önce/sonra kutusu (empty state örneği için).
class BeforeAfterSample extends StatelessWidget {
  final String beforeLabel;
  final String afterLabel;
  final IconData beforeIcon;
  final IconData afterIcon;
  const BeforeAfterSample({
    super.key,
    this.beforeLabel = 'ÖNCE',
    this.afterLabel = 'SONRA',
    this.beforeIcon = Icons.person_outline,
    this.afterIcon = Icons.auto_awesome,
  });

  @override
  Widget build(BuildContext context) {
    Widget cell(String label, IconData icon, bool after) => Expanded(
          child: AspectRatio(
            aspectRatio: 0.8,
            child: Container(
              decoration: BoxDecoration(
                color: after ? AppColors.goldSurface : AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                    color: after ? AppColors.gold : AppColors.borderSubtle),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon,
                      size: 40,
                      color:
                          after ? AppColors.gold : AppColors.textMuted),
                  const SizedBox(height: 8),
                  Text(label,
                      style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: after
                              ? AppColors.gold
                              : AppColors.textSecondary)),
                ],
              ),
            ),
          ),
        );
    return Row(
      children: [
        cell(beforeLabel, beforeIcon, false),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 10),
          child: Icon(Icons.arrow_forward_rounded, color: AppColors.gold),
        ),
        cell(afterLabel, afterIcon, true),
      ],
    );
  }
}
