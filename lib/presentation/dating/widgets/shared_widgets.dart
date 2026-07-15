import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../providers/dating_providers.dart';
import 'dating_widgets.dart';

// ============================================================
// AI YÜKLEME DENEYİMİ — profesyonel tam ekran loader
// ============================================================

class AiLoadingView extends StatefulWidget {
  final List<String> steps;
  final String hint;
  const AiLoadingView({
    super.key,
    required this.steps,
    this.hint = 'Bu işlem genelde ~10 saniye sürer',
  });

  @override
  State<AiLoadingView> createState() => _AiLoadingViewState();
}

class _AiLoadingViewState extends State<AiLoadingView>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _rotate;
  late final AnimationController _progress;
  int _stepIndex = 0;
  Timer? _stepTimer;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat(reverse: true);
    _rotate = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 14),
    )..repeat();
    // Asimptotik ilerleme: ~%92'ye yaklaşır, %100'e tam dolmaz (bitiş ekranı
    // parent'ta değişince loader kapanır — %100'de bozuk görünüm olmaz).
    _progress = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 28),
    )..forward();
    _stepTimer = Timer.periodic(const Duration(milliseconds: 2800), (_) {
      if (!mounted) return;
      setState(() => _stepIndex = (_stepIndex + 1) % widget.steps.length);
    });
  }

  @override
  void dispose() {
    _stepTimer?.cancel();
    _pulse.dispose();
    _rotate.dispose();
    _progress.dispose();
    super.dispose();
  }

  double get _displayProgress {
    final t = _progress.value;
    // easeOutCubic benzeri — sona doğru yavaşlar, tavan ~0.91
    final eased = 1 - math.pow(1 - t, 3).toDouble();
    return (eased * 0.91).clamp(0.0, 0.91);
  }

  @override
  Widget build(BuildContext context) {
    final pct = (_displayProgress * 100).round();

    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedBuilder(
              animation: Listenable.merge([_pulse, _rotate, _progress]),
              builder: (_, _) {
                final glow = 0.35 + _pulse.value * 0.25;
                return SizedBox(
                  width: 148,
                  height: 148,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      // Dış parıltı halkası
                      Container(
                        width: 148,
                        height: 148,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.gold.withValues(alpha: glow),
                              blurRadius: 32 + _pulse.value * 12,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                      ),
                      // Dönen kesik çizgi halka
                      Transform.rotate(
                        angle: _rotate.value * 2 * math.pi,
                        child: CustomPaint(
                          size: const Size(132, 132),
                          painter: _DashedRingPainter(
                            color: AppColors.gold.withValues(alpha: 0.35),
                          ),
                        ),
                      ),
                      // Ana ilerleme halkası
                      SizedBox(
                        width: 120,
                        height: 120,
                        child: CircularProgressIndicator(
                          value: _displayProgress,
                          strokeWidth: 5,
                          backgroundColor:
                              AppColors.surfaceElevated.withValues(alpha: 0.9),
                          valueColor: const AlwaysStoppedAnimation(
                            AppColors.gold,
                          ),
                          strokeCap: StrokeCap.round,
                        ),
                      ),
                      // Merkez: ikon + yüzde
                      Container(
                        width: 88,
                        height: 88,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: RadialGradient(
                            colors: [
                              AppColors.surfaceElevated,
                              AppColors.background,
                            ],
                          ),
                          border: Border.all(
                            color: AppColors.borderGold.withValues(alpha: 0.5),
                          ),
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              Icons.auto_awesome_rounded,
                              color: AppColors.gold
                                  .withValues(alpha: 0.85 + _pulse.value * 0.15),
                              size: 22,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '$pct%',
                              style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w900,
                                color: AppColors.textPrimary,
                                height: 1,
                                letterSpacing: -0.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
            const SizedBox(height: 32),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 450),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              child: Text(
                widget.steps[_stepIndex],
                key: ValueKey(_stepIndex),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                  height: 1.35,
                ),
              ),
            ),
            const SizedBox(height: 18),
            // Adım göstergeleri
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(widget.steps.length, (i) {
                final active = i == _stepIndex;
                final done = i < _stepIndex;
                return AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  width: active ? 22 : 7,
                  height: 7,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(4),
                    color: done
                        ? AppColors.gold.withValues(alpha: 0.55)
                        : active
                            ? AppColors.gold
                            : AppColors.borderSubtle,
                  ),
                );
              }),
            ),
            const SizedBox(height: 16),
            Text(
              widget.hint,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}

class _DashedRingPainter extends CustomPainter {
  final Color color;
  const _DashedRingPainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final r = size.width / 2 - 2;
    final center = Offset(size.width / 2, size.height / 2);
    const dash = 8.0;
    const gap = 10.0;
    final circumference = 2 * math.pi * r;
    final count = (circumference / (dash + gap)).floor();
    for (var i = 0; i < count; i++) {
      final start = (i * (dash + gap)) / circumference * 2 * math.pi;
      final sweep = dash / circumference * 2 * math.pi;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: r),
        start,
        sweep,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _DashedRingPainter old) => old.color != color;
}

/// Modül / stil görselleri — asset yoksa şık placeholder.
class DatingModuleImage extends StatelessWidget {
  final String assetPath;
  final double? width;
  final double? height;
  final BoxFit fit;
  final Alignment alignment;
  final IconData fallbackIcon;
  final BorderRadius borderRadius;

  const DatingModuleImage({
    super.key,
    required this.assetPath,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.alignment = Alignment.topCenter,
    this.fallbackIcon = Icons.image_outlined,
    this.borderRadius = const BorderRadius.all(Radius.circular(14)),
  });

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: borderRadius,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final w = (width != null && width!.isFinite)
              ? width
              : (constraints.maxWidth.isFinite ? constraints.maxWidth : null);
          final h = (height != null && height!.isFinite)
              ? height
              : (constraints.maxHeight.isFinite
                  ? constraints.maxHeight
                  : null);
          return Image.asset(
            assetPath,
            width: w,
            height: h,
            fit: fit,
            alignment: alignment,
            errorBuilder: (_, _, _) => Container(
              width: w,
              height: h,
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    AppColors.goldSurface,
                    AppColors.surfaceElevated,
                  ],
                ),
              ),
              child: Center(
                child: Icon(fallbackIcon, color: AppColors.gold, size: 36),
              ),
            ),
          );
        },
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
  final String howItWorks;
  final Widget beforeAfter;
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
