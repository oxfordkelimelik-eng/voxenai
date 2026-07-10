import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/app_router.dart';
import '../../providers/progress_provider.dart';
import '../../../domain/entities/progress_entry.dart';

/// İlerleme ekranı: önce/sonra foto karşılaştırması + skor zaman çizelgesi.
/// Looksmaxxing'in en bağımlılık yapan kısmı — kullanıcı gelişimini gözle görür.
class ProgressScreen extends ConsumerWidget {
  const ProgressScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(
          title: const Text('GELİŞİMİM'),
          leading: IconButton(
            icon: const Icon(Icons.arrow_back_rounded),
            onPressed: () =>
                context.canPop() ? context.pop() : context.go(AppRoutes.home),
          ),
          bottom: const TabBar(
            indicatorColor: AppColors.gold,
            labelColor: AppColors.gold,
            unselectedLabelColor: AppColors.textMuted,
            tabs: [
              Tab(text: 'YÜZ'),
              Tab(text: 'VÜCUT'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _ProgressTab(
              entries: ref.watch(faceProgressProvider),
              accent: AppColors.gold,
              emptyHint:
                  'Henüz yüz analizin yok. Analiz yaptıkça gelişimin burada birikecek.',
            ),
            _ProgressTab(
              entries: ref.watch(bodyProgressProvider),
              accent: AppColors.physical,
              emptyHint:
                  'Henüz vücut analizin yok. Düzenli analiz yap, önce/sonra farkını gör.',
            ),
          ],
        ),
      ),
    );
  }
}

class _ProgressTab extends StatelessWidget {
  final List<ProgressEntry> entries;
  final Color accent;
  final String emptyHint;

  const _ProgressTab({
    required this.entries,
    required this.accent,
    required this.emptyHint,
  });

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return _Empty(hint: emptyHint);
    }

    final first = entries.first;
    final last = entries.last;
    final delta = last.score - first.score;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 100),
      children: [
        // Özet rozet
        _DeltaBadge(delta: delta, accent: accent, count: entries.length),
        const SizedBox(height: 20),

        // Önce / Sonra
        if (first.photoPath != null || last.photoPath != null) ...[
          const _SectionTitle('ÖNCE → SONRA'),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: _BeforeAfterCard(
                  label: 'ÖNCE',
                  entry: first,
                  accent: AppColors.textMuted,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _BeforeAfterCard(
                  label: 'SONRA',
                  entry: last,
                  accent: accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
        ],

        // Skor çizelgesi
        const _SectionTitle('SKOR GELİŞİMİ'),
        const SizedBox(height: 10),
        _ScoreChart(entries: entries, accent: accent),
      ],
    );
  }
}

class _DeltaBadge extends StatelessWidget {
  final int delta;
  final Color accent;
  final int count;
  const _DeltaBadge({
    required this.delta,
    required this.accent,
    required this.count,
  });

  @override
  Widget build(BuildContext context) {
    final positive = delta >= 0;
    final color = positive ? AppColors.success : AppColors.error;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: accent.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(
            positive
                ? Icons.trending_up_rounded
                : Icons.trending_down_rounded,
            color: color,
            size: 36,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${positive ? '+' : ''}$delta puan',
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w900,
                    color: color,
                  ),
                ),
                Text(
                  '$count analiz boyunca toplam değişim',
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _BeforeAfterCard extends StatelessWidget {
  final String label;
  final ProgressEntry entry;
  final Color accent;
  const _BeforeAfterCard({
    required this.label,
    required this.entry,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w800,
            color: accent,
            letterSpacing: 1.5,
          ),
        ),
        const SizedBox(height: 6),
        AspectRatio(
          aspectRatio: 0.8,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: entry.photoPath != null && File(entry.photoPath!).existsSync()
                ? Image.file(File(entry.photoPath!), fit: BoxFit.cover)
                : Container(
                    color: AppColors.surfaceHighest,
                    child: const Icon(Icons.image_not_supported_rounded,
                        color: AppColors.textMuted, size: 32),
                  ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          'Skor ${entry.score}',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w800,
            color: accent,
          ),
        ),
        Text(
          DateFormat('d MMM').format(entry.date),
          style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
        ),
      ],
    );
  }
}

class _ScoreChart extends StatelessWidget {
  final List<ProgressEntry> entries;
  final Color accent;
  const _ScoreChart({required this.entries, required this.accent});

  @override
  Widget build(BuildContext context) {
    final spots = <FlSpot>[
      for (var i = 0; i < entries.length; i++)
        FlSpot(i.toDouble(), entries[i].score.toDouble()),
    ];

    return Container(
      height: 220,
      padding: const EdgeInsets.fromLTRB(8, 20, 16, 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: LineChart(
        LineChartData(
          minY: 0,
          maxY: 100,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: 25,
            getDrawingHorizontalLine: (v) =>
                FlLine(color: AppColors.borderSubtle, strokeWidth: 0.5),
          ),
          titlesData: FlTitlesData(
            topTitles:
                const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles:
                const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                interval: 25,
                reservedSize: 32,
                getTitlesWidget: (v, _) => Text(
                  v.toInt().toString(),
                  style: const TextStyle(
                      color: AppColors.textMuted, fontSize: 10),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                interval: 1,
                getTitlesWidget: (v, _) {
                  final i = v.toInt();
                  if (i < 0 || i >= entries.length) {
                    return const SizedBox.shrink();
                  }
                  return Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      DateFormat('d/M').format(entries[i].date),
                      style: const TextStyle(
                          color: AppColors.textMuted, fontSize: 9),
                    ),
                  );
                },
              ),
            ),
          ),
          borderData: FlBorderData(show: false),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              color: accent,
              barWidth: 3,
              dotData: FlDotData(
                show: true,
                getDotPainter: (spot, percent, bar, index) =>
                    FlDotCirclePainter(
                  radius: 4,
                  color: accent,
                  strokeWidth: 0,
                ),
              ),
              belowBarData: BarAreaData(
                show: true,
                color: accent.withValues(alpha: 0.12),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);
  @override
  Widget build(BuildContext context) => Text(
        text,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w800,
          color: AppColors.textMuted,
          letterSpacing: 1.5,
        ),
      );
}

class _Empty extends StatelessWidget {
  final String hint;
  const _Empty({required this.hint});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.insights_rounded,
                color: AppColors.textMuted, size: 56),
            const SizedBox(height: 16),
            Text(
              hint,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.textSecondary, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}
