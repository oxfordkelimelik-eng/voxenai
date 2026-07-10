import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/app_router.dart';
import '../../../domain/entities/body_analysis.dart';
import '../../providers/app_providers.dart';
import 'widgets/region_analysis_card.dart';

class BodyResultScreen extends ConsumerWidget {
  const BodyResultScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(bodyAnalysisProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('VÜCUT ANALİZİ'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () =>
              context.canPop() ? context.pop() : context.go(AppRoutes.home),
        ),
      ),
      body: result == null
          ? const Center(
              child: Text('Henüz vücut analizi yok.',
                  style: TextStyle(color: AppColors.textMuted)))
          : _Body(r: result),
    );
  }
}

class _Body extends StatelessWidget {
  final BodyAnalysisResult r;
  const _Body({required this.r});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!r.fromAi)
            _banner('Bu, formuna göre tahmini skorun. Vücut fotoğrafı çekip gerçek AI analizi yaparsan çok daha kesin sonuç ve kişisel öneriler alırsın.'),
          Row(
            children: [
              Expanded(child: _scoreRing('Genel', r.overallScore)),
              Expanded(child: _scoreRing('Postür', r.postureScore)),
              Expanded(child: _scoreRing('Kas', r.muscleScore)),
            ],
          ).animate().fadeIn(duration: 400.ms),
          const SizedBox(height: 24),

          // Kompozisyon kartları
          Row(
            children: [
              Expanded(
                  child: _statCard('Yağ Oranı',
                      '%${r.estimatedBodyFatPercent.round()}', AppColors.physical)),
              const SizedBox(width: 10),
              Expanded(
                  child: _statCard('Kategori', r.weightCategory, AppColors.gold)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _statCard('Vücut Tipi', r.bodyType, AppColors.mental)),
              const SizedBox(width: 10),
              Expanded(
                  child: _statCard('Protein/gün', '${r.proteinTargetG} g',
                      AppColors.social)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                  child: _statCard('Kalori Hedefi',
                      '${r.dailyCalorieTarget} kcal', AppColors.warning)),
              const SizedBox(width: 10),
              Expanded(
                  child: _statCard('Adım Hedefi', '${r.cardioStepGoal}',
                      AppColors.info)),
            ],
          ),
          const SizedBox(height: 20),

          // Simetri & oran
          if (r.symmetryScore > 0 || r.proportionScore > 0) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                    child: _statCard('Simetri (Sağ/Sol)', '${r.symmetryScore}',
                        AppColors.mental)),
                const SizedBox(width: 10),
                Expanded(
                    child: _statCard('Oran (V-Taper)', '${r.proportionScore}',
                        AppColors.gold)),
              ],
            ),
          ],
          if (r.symmetryObservation.isNotEmpty) ...[
            const SizedBox(height: 12),
            _textBlock('Simetri & Oran', Icons.balance_rounded,
                r.symmetryObservation),
          ],
          const SizedBox(height: 12),

          _infoRow('Kamburluk (Kifoz)',
              r.kyphosisDetected ? 'Tespit edildi' : 'Belirgin değil'),
          _infoRow('Baş Öne Eğim', '${r.forwardHeadAngleDeg.round()}°'),
          _infoRow('Omuz Asimetrisi', r.shoulderAsymmetry),

          // --- BÖLGESEL VÜCUT ANALİZİ (omuz, göğüs, kol, sırt, core, bacak) ---
          if (r.regions.isNotEmpty) ...[
            const SizedBox(height: 16),
            Row(children: const [
              Icon(Icons.grid_view_rounded, color: AppColors.physical, size: 18),
              SizedBox(width: 8),
              Text('BÖLGE BÖLGE ANALİZ',
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w900,
                      color: AppColors.textPrimary,
                      letterSpacing: 0.5)),
            ]),
            const SizedBox(height: 12),
            ...r.regions.map((reg) =>
                RegionAnalysisCard(region: reg, accent: AppColors.physical)),
          ],

          _section('Öncelikli Egzersizler', Icons.fitness_center_rounded,
              AppColors.physical, r.priorityExercises),
          _section('Postür Egzersizleri', Icons.accessibility_new_rounded,
              AppColors.social, r.postureExercises),
          _section('Öneriler', Icons.lightbulb_outline_rounded, AppColors.gold,
              r.recommendations),

          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () => context.go(AppRoutes.trial),
              icon: const Icon(Icons.arrow_forward_rounded),
              label: const Text('PLANIMI AÇ',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.physical,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Widget _banner(String text) => Container(
        margin: const EdgeInsets.only(bottom: 20),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.info.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.info.withValues(alpha: 0.4)),
        ),
        child: Row(children: [
          const Icon(Icons.auto_awesome, color: AppColors.info, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text,
                style: const TextStyle(color: AppColors.info, fontSize: 12, height: 1.4)),
          ),
        ]),
      );

  Widget _scoreRing(String label, int score) {
    final c = AppColors.scoreColor(score);
    return Column(
      children: [
        SizedBox(
          width: 80,
          height: 80,
          child: Stack(
            alignment: Alignment.center,
            children: [
              SizedBox(
                width: 80,
                height: 80,
                child: CircularProgressIndicator(
                  value: score / 100,
                  strokeWidth: 6,
                  backgroundColor: AppColors.borderSubtle,
                  valueColor: AlwaysStoppedAnimation(c),
                ),
              ),
              Text('$score',
                  style: TextStyle(
                      fontSize: 22, fontWeight: FontWeight.w900, color: c)),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Text(label,
            style: const TextStyle(
                fontSize: 12,
                color: AppColors.textSecondary,
                fontWeight: FontWeight.w600)),
      ],
    );
  }

  Widget _statCard(String label, String value, Color color) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary)),
            const SizedBox(height: 4),
            Text(value,
                style: TextStyle(
                    fontSize: 18, fontWeight: FontWeight.w900, color: color)),
          ],
        ),
      );

  Widget _textBlock(String title, IconData icon, String text) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon, color: AppColors.physical, size: 16),
              const SizedBox(width: 6),
              Text(title,
                  style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
            ]),
            const SizedBox(height: 8),
            Text(text,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 13, height: 1.5)),
          ],
        ),
      );

  Widget _infoRow(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label,
                style: const TextStyle(color: AppColors.textSecondary, fontSize: 14)),
            Text(value,
                style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w700)),
          ],
        ),
      );

  Widget _section(String title, IconData icon, Color color, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(icon, color: color, size: 18),
            const SizedBox(width: 8),
            Text(title,
                style: TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w800, color: color)),
          ]),
          const SizedBox(height: 8),
          ...items.map((s) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('•  ', style: TextStyle(color: color)),
                  Expanded(
                    child: Text(s,
                        style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 13,
                            height: 1.4)),
                  ),
                ]),
              )),
        ],
      ),
    );
  }
}
