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
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Row(
        children: OpsQuickRange.values.map((r) {
          final isSelected = r == selected;
          return Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: GestureDetector(
                onTap: () => onSelect(r),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: isSelected ? AppColors.gold : AppColors.surface,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: isSelected ? AppColors.gold : AppColors.borderSubtle,
                    ),
                  ),
                  child: Text(
                    r.label,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: isSelected ? AppColors.textOnGold : AppColors.textSecondary,
                      fontSize: 12,
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
    final currency = _formatTry(data.totalRevenueTry);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        _sectionTitle('CİRO VE SATIŞLAR ($rangeLabel)'),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [AppColors.goldDark, AppColors.gold],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(currency,
                  style: const TextStyle(
                      color: AppColors.textOnGold,
                      fontSize: 30,
                      fontWeight: FontWeight.w900)),
              const SizedBox(height: 2),
              const Text('Toplam Ciro',
                  style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
              const SizedBox(height: 14),
              Row(
                children: [
                  _miniStat('${data.totalPurchases}', 'Satış'),
                  const SizedBox(width: 20),
                  _miniStat('${data.uniqueBuyers}', 'Tekil Alıcı'),
                  const SizedBox(width: 20),
                  _miniStat(
                    data.totalPurchases > 0
                        ? _formatTry((data.totalRevenueTry / data.totalPurchases).round())
                        : '₺0',
                    'Ort. Sepet',
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        ..._mapRows(data.productCounts, label: 'Ürün'),
        const SizedBox(height: 24),
        _sectionTitle('GÜNLÜK DETAY'),
        if (data.dailyBreakdown.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Bu aralıkta satış yok',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
          )
        else
          ...data.dailyBreakdown.map((d) => _DailyCard(stat: d)),
        const SizedBox(height: 24),
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
        ..._mapRows(data.statusCounts, label: 'Durum'),
        const SizedBox(height: 24),
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
        const SizedBox(height: 24),
        _sectionTitle('RET KAPISI DAĞILIMI'),
        ..._mapRows(data.gateCounts, label: 'Kapı'),
        const SizedBox(height: 24),
        _sectionTitle('İŞ LİSTESİ (${data.jobs.length})'),
        ...data.jobs.map((j) => _JobTile(job: j)),
      ],
    );
  }

  Widget _miniStat(String value, String label) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  color: AppColors.textOnGold, fontSize: 16, fontWeight: FontWeight.w800)),
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 11)),
        ],
      );

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(text,
            style: const TextStyle(
                color: AppColors.textMuted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6)),
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
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 12)),
          ],
        ),
      );

  List<Widget> _mapRows(Map<String, int> map, {required String label}) {
    final entries = map.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    if (entries.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text('$label yok',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
        ),
      ];
    }
    return entries
        .map((e) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(e.key,
                      style: const TextStyle(
                          color: AppColors.textPrimary, fontSize: 13)),
                  Text('${e.value}',
                      style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 13,
                          fontWeight: FontWeight.w700)),
                ],
              ),
            ))
        .toList();
  }
}

class _DailyCard extends StatelessWidget {
  final OpsDailyStat stat;
  const _DailyCard({required this.stat});

  @override
  Widget build(BuildContext context) {
    final products = stat.productCounts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
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
          const SizedBox(height: 8),
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
                      child: Text('${_productLabel(e.key)} × ${e.value}',
                          style: const TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 11,
                              fontWeight: FontWeight.w600)),
                    ))
                .toList(),
          ),
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
              '${job.jobId.substring(0, job.jobId.length > 8 ? 8 : job.jobId.length)} · ${job.status ?? '?'}',
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${job.status ?? '?'} · teslim=${job.deliveredCount} ret=${job.rejectedCount}'
          '${job.usedFreeTier ? ' · ücretsiz' : ''}'
          '${job.errorMessage != null ? ' · ${job.errorMessage}' : ''}',
          style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
          overflow: TextOverflow.ellipsis,
        ),
        trailing: const Icon(Icons.chevron_right_rounded,
            color: AppColors.textMuted),
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

String _productLabel(String productId) => switch (productId) {
      'dating_pack_photo10' => 'Foto 10',
      'dating_pack_photo50' => 'Foto 50',
      'dating_pack_analysis1' => 'Analiz 1',
      'dating_pack_analysis5' => 'Analiz 5',
      _ => productId,
    };
