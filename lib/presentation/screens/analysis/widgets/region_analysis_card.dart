import 'package:flutter/material.dart';
import '../../../../core/constants/app_colors.dart';
import '../../../../domain/entities/region_analysis.dart';

/// Tek bir yüz/vücut bölgesinin (çene, kaş, göz; omuz, sırt vb.) detaylı
/// analiz kartı: skor rozeti + gözlem + o bölgeye özel egzersizler.
class RegionAnalysisCard extends StatelessWidget {
  final RegionAnalysis region;
  final Color accent;

  const RegionAnalysisCard({
    super.key,
    required this.region,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    final scoreColor = AppColors.scoreColor(region.score);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  region.name,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              // Skor rozeti + mini bar
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: scoreColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  '${region.score}',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                    color: scoreColor,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: region.score / 100,
              minHeight: 5,
              backgroundColor: AppColors.borderSubtle,
              valueColor: AlwaysStoppedAnimation(scoreColor),
            ),
          ),
          if (region.observation.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              region.observation,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ],
          if (region.exercises.isNotEmpty) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(Icons.fitness_center_rounded, color: accent, size: 14),
                const SizedBox(width: 6),
                Text(
                  'Egzersizler',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: accent,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            ...region.exercises.map(
              (e) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('•  ', style: TextStyle(color: accent)),
                    Expanded(
                      child: Text(
                        e,
                        style: const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 13,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
