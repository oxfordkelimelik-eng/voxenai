import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../../core/constants/app_colors.dart';

class StreakWidget extends StatelessWidget {
  final int streak;

  const StreakWidget({super.key, required this.streak});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // Streak Kartı
        Expanded(
          child: _StatCard(
            icon: Icons.local_fire_department_rounded,
            iconColor: AppColors.warning,
            title: '$streak',
            subtitle: 'Günlük Seri',
            glowColor: AppColors.warningGlow,
          ),
        ),
        const SizedBox(width: 12),
        // Haftalık tamamlama
        Expanded(
          child: _StatCard(
            icon: Icons.emoji_events_rounded,
            iconColor: AppColors.gold,
            title: _getStreakMessage(streak),
            subtitle: 'Seviye',
            glowColor: AppColors.goldGlow,
          ),
        ),
        const SizedBox(width: 12),
        // Hedef çizelgesi
        Expanded(
          child: _StatCard(
            icon: Icons.show_chart_rounded,
            iconColor: AppColors.info,
            title: '${(streak * 1.2).toStringAsFixed(0)}%',
            subtitle: 'Tutarlılık',
            glowColor: AppColors.mentalGlow,
          ),
        ),
      ],
    ).animate().fadeIn(duration: 400.ms).slideY(begin: 0.1, end: 0);
  }

  String _getStreakMessage(int streak) {
    if (streak >= 30) return 'APEX';
    if (streak >= 14) return 'ELİT';
    if (streak >= 7) return 'PRO';
    if (streak >= 3) return 'İYİ';
    return 'YENİ';
  }
}

class _StatCard extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final Color glowColor;

  const _StatCard({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.glowColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle, width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: iconColor, size: 20),
          const SizedBox(height: 8),
          Text(
            title,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w900,
              color: AppColors.textPrimary,
            ),
          ),
          Text(
            subtitle,
            style: const TextStyle(
              fontSize: 11,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

