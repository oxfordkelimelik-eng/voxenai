import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/app_router.dart';
import '../../../domain/entities/face_analysis.dart';
import '../../providers/app_providers.dart';
import 'widgets/region_analysis_card.dart';

class FaceResultScreen extends ConsumerWidget {
  const FaceResultScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(faceAnalysisProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('YÜZ ANALİZİ'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () =>
              context.canPop() ? context.pop() : context.go(AppRoutes.home),
        ),
      ),
      body: result == null
          ? const Center(
              child: Text('Henüz yüz analizi yok.',
                  style: TextStyle(color: AppColors.textMuted)))
          : _Body(r: result),
    );
  }
}

class _Body extends StatelessWidget {
  final FaceAnalysisResult r;
  const _Body({required this.r});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!r.fromAi)
            _banner('Bu, formuna göre tahmini skorun. Yüz fotoğrafı çekip gerçek AI analizi yaparsan çok daha kesin sonuç ve kişisel öneriler alırsın.'),
          // Skor halkaları
          Row(
            children: [
              Expanded(child: _scoreRing('Genel', r.overallScore, AppColors.gold)),
              Expanded(child: _scoreRing('Çene', r.jawlineScore, AppColors.physical)),
              Expanded(child: _scoreRing('Cilt', r.skinScore, AppColors.social)),
            ],
          ).animate().fadeIn(duration: 400.ms),
          const SizedBox(height: 24),

          _infoRow('Yüz Şekli', r.faceShape),
          _infoRow('Gonial Açı', '${r.gonialAngleDeg.round()}°'),
          _infoRow('Submental Yağ', '${r.submentalFatScore.toStringAsFixed(1)}/10'),
          _infoRow('Asimetri', r.asymmetryDetected ? 'Tespit edildi' : 'Belirgin değil'),
          const SizedBox(height: 20),

          // --- DETAYLI ÇENE (JAWLINE) ANALİZİ ---
          _jawlineBlock(),

          // --- BÖLGESEL ANALİZ (kaş, göz, burun, dudak, elmacık, alın, cilt, saç) ---
          if (r.regions.isNotEmpty) ...[
            const SizedBox(height: 8),
            _regionHeader('BÖLGE BÖLGE ANALİZ', Icons.grid_view_rounded),
            const SizedBox(height: 12),
            ...r.regions.map((reg) =>
                RegionAnalysisCard(region: reg, accent: AppColors.gold)),
          ],

          const SizedBox(height: 8),
          _section('Genel Öneriler', Icons.lightbulb_outline_rounded, AppColors.gold,
              r.recommendations),
          _section('☀️ Sabah Cilt Rutini', Icons.wb_sunny_outlined,
              AppColors.warning, r.skinMorningRoutine),
          _section('🌙 Akşam Cilt Rutini', Icons.nightlight_round,
              AppColors.mental, r.skinEveningRoutine),
          _section('Saç Modeli', Icons.content_cut_rounded, AppColors.social,
              r.hairStyles),
          if (r.beardGuide.isNotEmpty)
            _textBlock('Sakal Kılavuzu', Icons.face_rounded, r.beardGuide),

          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () => context.go(AppRoutes.trial),
              icon: const Icon(Icons.arrow_forward_rounded),
              label: const Text('PLANIMI AÇ',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.gold,
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

  Widget _scoreRing(String label, int score, Color color) {
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

  /// Çene (jawline) için özel, vurgulu detay bloğu.
  Widget _jawlineBlock() {
    final hasDetail =
        r.jawlineObservation.isNotEmpty || r.jawlineExercises.isNotEmpty;
    if (!hasDetail) return const SizedBox.shrink();
    final scoreColor = AppColors.scoreColor(r.jawlineScore);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.physical.withValues(alpha: 0.12),
            AppColors.surfaceElevated,
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.physical.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.architecture_rounded,
                  color: AppColors.physical, size: 20),
              const SizedBox(width: 8),
              const Expanded(
                child: Text('ÇENE HATTI (JAWLINE) ANALİZİ',
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w900,
                        color: AppColors.textPrimary,
                        letterSpacing: 0.5)),
              ),
              Text('${r.jawlineScore}',
                  style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                      color: scoreColor)),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: r.jawlineScore / 100,
              minHeight: 6,
              backgroundColor: AppColors.borderSubtle,
              valueColor: AlwaysStoppedAnimation(scoreColor),
            ),
          ),
          if (r.jawlineObservation.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(r.jawlineObservation,
                style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 13,
                    height: 1.5)),
          ],
          if (r.mewingGuide.isNotEmpty) ...[
            const SizedBox(height: 12),
            Row(children: const [
              Icon(Icons.straighten_rounded,
                  color: AppColors.physical, size: 15),
              SizedBox(width: 6),
              Text('Mewing Rehberi',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: AppColors.physical)),
            ]),
            const SizedBox(height: 4),
            Text(r.mewingGuide,
                style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 13,
                    height: 1.45)),
          ],
          if (r.jawlineExercises.isNotEmpty) ...[
            const SizedBox(height: 12),
            Row(children: const [
              Icon(Icons.fitness_center_rounded,
                  color: AppColors.physical, size: 15),
              SizedBox(width: 6),
              Text('Çene Egzersizleri',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: AppColors.physical)),
            ]),
            const SizedBox(height: 6),
            ...r.jawlineExercises.map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('•  ',
                            style: TextStyle(color: AppColors.physical)),
                        Expanded(
                          child: Text(e,
                              style: const TextStyle(
                                  color: AppColors.textPrimary,
                                  fontSize: 13,
                                  height: 1.4)),
                        ),
                      ]),
                )),
          ],
        ],
      ),
    );
  }

  Widget _regionHeader(String title, IconData icon) => Row(
        children: [
          Icon(icon, color: AppColors.gold, size: 18),
          const SizedBox(width: 8),
          Text(title,
              style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary,
                  letterSpacing: 0.5)),
        ],
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
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color: color)),
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

  Widget _textBlock(String title, IconData icon, String text) => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Container(
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
                Icon(icon, color: AppColors.gold, size: 16),
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
        ),
      );
}
