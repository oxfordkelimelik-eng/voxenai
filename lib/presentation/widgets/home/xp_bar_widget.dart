import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:percent_indicator/percent_indicator.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_constants.dart';

class XpBarWidget extends StatelessWidget {
  final int xp;
  final int level;
  final double progress;

  const XpBarWidget({
    super.key,
    required this.xp,
    required this.level,
    required this.progress,
  });

  @override
  Widget build(BuildContext context) {
    final levelTitle = XpConfig
        .levelTitles[(level - 1).clamp(0, XpConfig.levelTitles.length - 1)];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderSubtle, width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // Seviye rozeti
              Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: AppColors.goldGradient,
                      boxShadow: [
                        BoxShadow(
                          color: AppColors.goldGlow,
                          blurRadius: 12,
                          spreadRadius: 2,
                        ),
                      ],
                    ),
                    child: Center(
                      child: Text(
                        '$level',
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: AppColors.textOnGold,
                        ),
                      ),
                    ),
                  )
                  .animate(onPlay: (c) => c.repeat(reverse: true))
                  .shimmer(duration: 2000.ms, color: AppColors.goldLight),

              const SizedBox(width: 12),

              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'SEVİYE $level — $levelTitle',
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: AppColors.gold,
                      letterSpacing: 1,
                    ),
                  ),
                  Text(
                    '${_formatXp(xp)} XP',
                    style: const TextStyle(
                      fontSize: 11,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),

              const Spacer(),

              Text(
                level < 10
                    ? '+${_formatXp(XpConfig.getXpForNextLevel(xp))} XP'
                    : 'MAX',
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),

          const SizedBox(height: 12),

          // XP ilerleme çubuğu
          LinearPercentIndicator(
            percent: progress.clamp(0.0, 1.0),
            lineHeight: 8,
            backgroundColor: AppColors.borderSubtle,
            linearGradient: AppColors.xpGradient,
            barRadius: const Radius.circular(4),
            padding: EdgeInsets.zero,
            animation: true,
            animationDuration: 1000,
          ),
        ],
      ),
    ).animate().fadeIn(duration: 400.ms).slideY(begin: -0.1, end: 0);
  }

  String _formatXp(int xp) {
    if (xp >= 1000) return '${(xp / 1000).toStringAsFixed(1)}K';
    return '$xp';
  }
}

