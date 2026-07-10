import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/app_router.dart';
import '../../../domain/entities/addiction.dart';
import '../../providers/addiction_provider.dart';

/// Bağımlılıktan kurtulma takip ekranı — temiz gün sayaçları, kilometre
/// taşları ve sıfırlama. Kullanıcıyı motive eden "streak" mantığı.
class AddictionScreen extends ConsumerWidget {
  const AddictionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final addictions = ref.watch(addictionProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('BAĞIMLILIK TAKİBİ'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () =>
              context.canPop() ? context.pop() : context.go(AppRoutes.home),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_rounded),
            tooltip: 'Ekle',
            onPressed: () => _showAddSheet(context, ref),
          ),
        ],
      ),
      body: addictions.isEmpty
          ? _Empty(onAdd: () => _showAddSheet(context, ref))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _MotivationBanner(count: addictions.length),
                const SizedBox(height: 16),
                ...addictions.map((a) => Padding(
                      padding: const EdgeInsets.only(bottom: 14),
                      child: _AddictionCard(
                        addiction: a,
                        onRelapse: () => _confirmRelapse(context, ref, a),
                        onCheckIn: () => ref
                            .read(addictionProvider.notifier)
                            .checkInToday(a.typeId),
                        onRemove: () =>
                            ref.read(addictionProvider.notifier).remove(a.typeId),
                      ),
                    )),
              ],
            ),
    );
  }

  void _showAddSheet(BuildContext context, WidgetRef ref) {
    final existing =
        ref.read(addictionProvider).map((a) => a.typeId).toSet();
    final available =
        AddictionType.all.where((t) => !existing.contains(t.id)).toList();

    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Bağımlılık Ekle',
                style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 16),
            if (available.isEmpty)
              const Text('Tüm bağımlılıklar zaten ekli.',
                  style: TextStyle(color: AppColors.textMuted))
            else
              ...available.map((t) => ListTile(
                    leading: Text(t.emoji, style: const TextStyle(fontSize: 24)),
                    title: Text(t.label,
                        style: const TextStyle(color: AppColors.textPrimary)),
                    trailing: const Icon(Icons.add_circle_outline_rounded,
                        color: AppColors.gold),
                    onTap: () {
                      ref.read(addictionProvider.notifier).add(t.id);
                      Navigator.pop(ctx);
                    },
                  )),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  void _confirmRelapse(BuildContext context, WidgetRef ref, Addiction a) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        title: const Text('Sayacı Sıfırla',
            style: TextStyle(color: AppColors.textPrimary)),
        content: Text(
          'Düştün mü? Sorun değil — önemli olan tekrar başlamak. '
          'En iyi serin (${a.cleanDays > a.bestStreakDays ? a.cleanDays : a.bestStreakDays} gün) kayıtlı kalacak.',
          style: const TextStyle(color: AppColors.textSecondary, height: 1.4),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Vazgeç',
                style: TextStyle(color: AppColors.textMuted)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () {
              ref.read(addictionProvider.notifier).relapse(a.typeId);
              Navigator.pop(ctx);
            },
            child: const Text('Sıfırla & Yeniden Başla'),
          ),
        ],
      ),
    );
  }
}

class _MotivationBanner extends StatelessWidget {
  final int count;
  const _MotivationBanner({required this.count});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: AppColors.goldGradient,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          const Icon(Icons.shield_rounded, color: AppColors.textOnGold, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              '$count bağımlılıkla savaşıyorsun. Her temiz gün beynini yeniden inşa ediyor. Pes etme.',
              style: const TextStyle(
                  color: AppColors.textOnGold,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _AddictionCard extends StatelessWidget {
  final Addiction addiction;
  final VoidCallback onRelapse;
  final VoidCallback onCheckIn;
  final VoidCallback onRemove;

  const _AddictionCard({
    required this.addiction,
    required this.onRelapse,
    required this.onCheckIn,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final a = addiction;
    final t = a.type;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(t.emoji, style: const TextStyle(fontSize: 26)),
              const SizedBox(width: 10),
              Expanded(
                child: Text(t.label,
                    style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary)),
              ),
              PopupMenuButton<String>(
                color: AppColors.surfaceHighest,
                icon: const Icon(Icons.more_vert_rounded,
                    color: AppColors.textMuted),
                onSelected: (v) {
                  if (v == 'remove') onRemove();
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'remove',
                    child: Text('Kaldır',
                        style: TextStyle(color: AppColors.textPrimary)),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Temiz gün sayacı
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('${a.cleanDays}',
                  style: const TextStyle(
                      fontSize: 44,
                      fontWeight: FontWeight.w900,
                      color: AppColors.gold,
                      height: 1)),
              const SizedBox(width: 6),
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: Text('temiz gün',
                    style: TextStyle(
                        fontSize: 14, color: AppColors.textSecondary)),
              ),
              const Spacer(),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('En iyi: ${a.bestStreakDays}g',
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textMuted)),
                  Text('Düşüş: ${a.relapseCount}',
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textMuted)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Kilometre taşı ilerlemesi
          Row(
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: a.milestoneProgress,
                    minHeight: 6,
                    backgroundColor: AppColors.borderSubtle,
                    valueColor:
                        const AlwaysStoppedAnimation(AppColors.gold),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text('Hedef: ${a.nextMilestone}g',
                  style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.gold,
                      fontWeight: FontWeight.w700)),
            ],
          ),
          const SizedBox(height: 12),

          // Son 14 günün gün-gün takibi
          const Text('SON 14 GÜN',
              style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textMuted,
                  letterSpacing: 1)),
          const SizedBox(height: 8),
          _CheckInGrid(days: a.recentCheckIns(14)),
          const SizedBox(height: 12),

          // Motivasyon
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.goldSurface,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(t.motivationLine,
                style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textSecondary,
                    height: 1.4)),
          ),
          const SizedBox(height: 12),

          // Günlük check-in — bugünü temiz işaretle (kullanıcıyı her gün çeker)
          SizedBox(
            width: double.infinity,
            child: a.checkedInToday
                ? Container(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: AppColors.success.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                          color: AppColors.success.withValues(alpha: 0.4)),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.verified_rounded,
                            color: AppColors.success, size: 18),
                        SizedBox(width: 8),
                        Text('Bugün temiz işaretlendi 💪',
                            style: TextStyle(
                                color: AppColors.success,
                                fontWeight: FontWeight.w700,
                                fontSize: 13)),
                      ],
                    ),
                  )
                : ElevatedButton.icon(
                    onPressed: onCheckIn,
                    icon: const Icon(Icons.check_circle_outline_rounded,
                        size: 18),
                    label: const Text('Bugünü Temiz İşaretle'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.gold,
                      foregroundColor: AppColors.textOnGold,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                    ),
                  ),
          ),
          const SizedBox(height: 8),

          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: onRelapse,
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: const Text('Düştüm, sıfırla'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.error,
                side: BorderSide(color: AppColors.error.withValues(alpha: 0.4)),
              ),
            ),
          ),
        ],
      ),
    ).animate().fadeIn(duration: 300.ms);
  }
}

class _CheckInGrid extends StatelessWidget {
  final List<bool> days; // en eskiden bugüne
  const _CheckInGrid({required this.days});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (int i = 0; i < days.length; i++) ...[
          Expanded(
            child: AspectRatio(
              aspectRatio: 1,
              child: Container(
                decoration: BoxDecoration(
                  color: days[i]
                      ? AppColors.gold
                      : AppColors.borderSubtle.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(4),
                  border: i == days.length - 1
                      ? Border.all(color: AppColors.gold, width: 1.5)
                      : null,
                ),
                child: days[i]
                    ? const Icon(Icons.check,
                        size: 10, color: AppColors.textOnGold)
                    : null,
              ),
            ),
          ),
          if (i != days.length - 1) const SizedBox(width: 4),
        ],
      ],
    );
  }
}

class _Empty extends StatelessWidget {
  final VoidCallback onAdd;
  const _Empty({required this.onAdd});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.shield_outlined,
                size: 64, color: AppColors.textMuted),
            const SizedBox(height: 16),
            const Text('Takip edilen bağımlılık yok',
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 8),
            const Text(
              'Seni geri tutan bir alışkanlığı ekle ve temiz gün sayacını başlat.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textSecondary, height: 1.4),
            ),
            const SizedBox(height: 20),
            ElevatedButton.icon(
              onPressed: onAdd,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Bağımlılık Ekle'),
              style:
                  ElevatedButton.styleFrom(backgroundColor: AppColors.gold),
            ),
          ],
        ),
      ),
    );
  }
}
