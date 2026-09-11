import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants/app_colors.dart';
import '../../core/router/dating_routes.dart';
import 'ops_gate.dart';
import 'ops_models.dart';
import 'ops_providers.dart';

class OpsScreen extends StatelessWidget {
  const OpsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return OpsGate(builder: (context) => const _OpsOverviewBody());
  }
}

class _OpsOverviewBody extends ConsumerWidget {
  const _OpsOverviewBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final quickRange = ref.watch(opsQuickRangeProvider);
    final range = ref.watch(opsResolvedRangeProvider);
    final overview = ref.watch(opsOverviewProvider(range));

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        title: const Text('Voxen AI — Panel',
            style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.textSecondary),
            onPressed: () => ref.invalidate(opsOverviewProvider(range)),
          ),
        ],
      ),
      body: Column(
        children: [
          _RangeSelector(
            selected: quickRange,
            onSelect: (r) => ref.read(opsQuickRangeProvider.notifier).state = r,
          ),
          Expanded(
            child: overview.when(
              loading: () => const Center(
                child: CircularProgressIndicator(color: AppColors.gold),
              ),
              error: (e, _) => Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text('Yüklenemedi: $e',
                      style: const TextStyle(color: AppColors.textSecondary)),
                ),
              ),
              data: (data) => _OverviewContent(data: data, rangeLabel: quickRange.label),
            ),
          ),
        ],
      ),
    );
  }
}

class _RangeSelector extends StatelessWidget {
  final OpsQuickRange selected;
  final ValueChanged<OpsQuickRange> onSelect;
  const _RangeSelector({required this.selected, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Row(
        children: OpsQuickRange.values.map((r) {
          final isSelected = r == selected;
          return Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: GestureDetector(
                onTap: () => onSelect(r),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  padding: const EdgeInsets.symmetric(vertical: 11),
                  decoration: BoxDecoration(
                    gradient: isSelected
                        ? const LinearGradient(
                            colors: [AppColors.goldDark, AppColors.gold],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          )
                        : null,
                    color: isSelected ? null : AppColors.surface,
                    borderRadius: BorderRadius.circular(11),
                    border: Border.all(
                      color: isSelected ? AppColors.gold : AppColors.borderSubtle,
                    ),
                    boxShadow: isSelected
                        ? [
                            BoxShadow(
                              color: AppColors.gold.withValues(alpha: 0.35),
                              blurRadius: 12,
                              offset: const Offset(0, 3),
                            ),
                          ]
                        : null,
                  ),
                  child: Text(
                    r.label,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: isSelected ? AppColors.textOnGold : AppColors.textSecondary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _OverviewContent extends StatelessWidget {
  final OpsOverview data;
  final String rangeLabel;
  const _OverviewContent({required this.data, required this.rangeLabel});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 32),
      children: [
        _RevenueHeroCard(data: data, rangeLabel: rangeLabel),
        const SizedBox(height: 14),
        ..._mapRows(data.productCounts, label: 'Ürün', formatKey: opsProductLabel),
        const SizedBox(height: 26),
        _sectionTitle('GÜNLÜK SATIŞ DETAYI'),
        if (data.dailyBreakdown.isEmpty)
          _emptyHint('Bu aralıkta satış yok')
        else
          ...data.dailyBreakdown.map((d) => _DailyCard(stat: d)),
        const SizedBox(height: 26),
        _sectionTitle('ÜRETİM İŞLERİ'),
        Row(
          children: [
            Expanded(child: _statCard('Toplam İş', '${data.totalJobs}')),
            const SizedBox(width: 12),
            Expanded(child: _statCard('Kullanıcı', '${data.uniqueProducers}')),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
                child: _statCard('Teslim', '${data.totalDelivered}',
                    color: AppColors.success)),
            const SizedBox(width: 12),
            Expanded(
                child: _statCard('Ret', '${data.totalRejected}',
                    color: AppColors.error)),
          ],
        ),
        const SizedBox(height: 12),
        ..._mapRows(data.statusCounts, label: 'Durum', formatKey: opsStatusLabel),
        const SizedBox(height: 26),
        _sectionTitle('İŞ TÜRÜ'),
        Row(
          children: [
            Expanded(
                child: _statCard('Ücretsiz', '${data.freeTierJobs}',
                    color: AppColors.info)),
            const SizedBox(width: 12),
            Expanded(
                child: _statCard('Paralı', '${data.paidJobs}',
                    color: AppColors.success)),
            const SizedBox(width: 12),
            Expanded(
                child: _statCard('Başarısız', '${data.failedJobs}',
                    color: AppColors.error)),
          ],
        ),
        const SizedBox(height: 26),
        _sectionTitle('RET KAPISI DAĞILIMI'),
        ..._mapRows(data.gateCounts, label: 'Kapı'),
        const SizedBox(height: 26),
        _sectionTitle('İŞ LİSTESİ (${data.jobs.length})'),
        ...data.jobs.map((j) => _JobTile(job: j)),
      ],
    );
  }
}

Widget _sectionTitle(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 10, top: 4),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 13,
            decoration: BoxDecoration(
              color: AppColors.gold,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 8),
          Text(text,
              style: const TextStyle(
                  color: AppColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.7)),
        ],
      ),
    );

Widget _emptyHint(String text) => Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 20),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Center(
        child: Text(text,
            style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
      ),
    );

Widget _statCard(String label, String value, {Color? color}) => Container(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: TextStyle(
                  color: color ?? AppColors.textPrimary,
                  fontSize: 22,
                  fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text(label,
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
        ],
      ),
    );

List<Widget> _mapRows(
  Map<String, int> map, {
  required String label,
  String Function(String)? formatKey,
}) {
  final entries = map.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
  if (entries.isEmpty) {
    return [_emptyHint('$label yok')];
  }
  return [
    Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        children: entries
            .map((e) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(formatKey?.call(e.key) ?? e.key,
                            style: const TextStyle(
                                color: AppColors.textPrimary, fontSize: 13)),
                      ),
                      Text('${e.value}',
                          style: const TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700)),
                    ],
                  ),
                ))
            .toList(),
      ),
    ),
  ];
}

/// Cironun ana kartı — hero card. Marka kırmızısında, dokulu bir gradyan +
/// hafif parlama efektiyle diğer kartlardan öne çıkması için tasarlandı.
class _RevenueHeroCard extends StatelessWidget {
  final OpsOverview data;
  final String rangeLabel;
  const _RevenueHeroCard({required this.data, required this.rangeLabel});

  @override
  Widget build(BuildContext context) {
    final currency = _formatTry(data.totalRevenueTry);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppColors.goldDark, AppColors.gold, AppColors.goldLight],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          stops: [0.0, 0.55, 1.0],
        ),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: AppColors.gold.withValues(alpha: 0.4),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Stack(
        children: [
          Positioned(
            right: -20,
            top: -20,
            child: Icon(Icons.paid_rounded,
                size: 100, color: Colors.white.withValues(alpha: 0.10)),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(rangeLabel.toUpperCase(),
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5)),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(currency,
                  style: const TextStyle(
                      color: AppColors.textOnGold,
                      fontSize: 34,
                      fontWeight: FontWeight.w900,
                      letterSpacing: -0.5)),
              const SizedBox(height: 2),
              const Text('Toplam Ciro',
                  style: TextStyle(
                      color: Colors.white70, fontSize: 12.5, fontWeight: FontWeight.w600)),
              const SizedBox(height: 18),
              Container(height: 1, color: Colors.white.withValues(alpha: 0.2)),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(child: _heroStat(Icons.receipt_long_rounded, '${data.totalPurchases}', 'Satış')),
                  Expanded(child: _heroStat(Icons.people_alt_rounded, '${data.uniqueBuyers}', 'Tekil Alıcı')),
                  Expanded(
                    child: _heroStat(
                      Icons.trending_up_rounded,
                      data.totalPurchases > 0
                          ? _formatTry((data.totalRevenueTry / data.totalPurchases).round())
                          : '₺0',
                      'Ort. Sepet',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _heroStat(IconData icon, String value, String label) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: Colors.white.withValues(alpha: 0.85)),
          const SizedBox(height: 4),
          Text(value,
              style: const TextStyle(
                  color: AppColors.textOnGold, fontSize: 15, fontWeight: FontWeight.w800)),
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 10.5)),
        ],
      );
}

class _DailyCard extends StatelessWidget {
  final OpsDailyStat stat;
  const _DailyCard({required this.stat});

  @override
  Widget build(BuildContext context) {
    final products = stat.productCounts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(_formatDay(stat.day),
                  style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w800)),
              Text(_formatTry(stat.revenueTry),
                  style: const TextStyle(
                      color: AppColors.gold,
                      fontSize: 15,
                      fontWeight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 4),
          Text('${stat.count} satış',
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: products
                .map((e) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text('${opsProductLabel(e.key)} × ${e.value}',
                          style: const TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 11,
                              fontWeight: FontWeight.w600)),
                    ))
                .toList(),
          ),
          if (stat.items.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(height: 1, color: AppColors.borderSubtle),
            const SizedBox(height: 8),
            ...stat.items.map((item) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.email ?? 'bilinmiyor',
                          style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontSize: 12,
                              fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _formatTime(item.createdAtMillis),
                        style: const TextStyle(
                            color: AppColors.textMuted, fontSize: 11),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _formatTry(item.priceTry),
                        style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                            fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                )),
          ],
        ],
      ),
    );
  }
}

class _JobTile extends StatelessWidget {
  final OpsJobSummary job;
  const _JobTile({required this.job});

  @override
  Widget build(BuildContext context) {
    final statusColor = switch (job.status) {
      'done' => AppColors.success,
      'failed' => AppColors.error,
      _ => AppColors.warning,
    };
    return Card(
      color: AppColors.surface,
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: () {
          final uid = job.uid;
          if (uid == null) return;
          context.push('${DatingRoutes.opsJob}/$uid/${job.jobId}');
        },
        leading: CircleAvatar(
          backgroundColor: statusColor.withValues(alpha: 0.2),
          child: Icon(Icons.image_outlined, color: statusColor, size: 18),
        ),
        title: Text(
          job.email ??
              job.jobId.substring(0, job.jobId.length > 8 ? 8 : job.jobId.length),
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${opsStatusLabel(job.status)} · teslim=${job.deliveredCount} ret=${job.rejectedCount}'
          '${job.usedFreeTier ? ' · ücretsiz' : ''}'
          '${job.errorMessage != null ? ' · ${job.errorMessage}' : ''}',
          style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
          overflow: TextOverflow.ellipsis,
        ),
        trailing: const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
      ),
    );
  }
}

String _formatTry(int amount) {
  final s = amount.toString();
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) buf.write('.');
    buf.write(s[i]);
  }
  return '₺$buf';
}

String _formatDay(String isoDay) {
  // isoDay: "YYYY-MM-DD"
  final parts = isoDay.split('-');
  if (parts.length != 3) return isoDay;
  const months = [
    'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz',
    'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
  ];
  final month = int.tryParse(parts[1]);
  if (month == null || month < 1 || month > 12) return isoDay;
  return '${parts[2]} ${months[month - 1]} ${parts[0]}';
}

String _formatTime(int? millis) {
  if (millis == null) return '--:--';
  final d = DateTime.fromMillisecondsSinceEpoch(millis);
  final hh = d.hour.toString().padLeft(2, '0');
  final mm = d.minute.toString().padLeft(2, '0');
  return '$hh:$mm';
}
