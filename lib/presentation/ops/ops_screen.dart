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
    const range = OpsDateRange();
    final overview = ref.watch(opsOverviewProvider(range));

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        title: const Text('Genel Bakış',
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
      body: overview.when(
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
        data: (data) => _OverviewContent(data: data),
      ),
    );
  }
}

class _OverviewContent extends StatelessWidget {
  final OpsOverview data;
  const _OverviewContent({required this.data});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _sectionTitle('SATIN ALMALAR (son 30 gün)'),
        Row(
          children: [
            Expanded(child: _statCard('Toplam', '${data.totalPurchases}')),
            const SizedBox(width: 12),
            Expanded(child: _statCard('Tekil Alıcı', '${data.uniqueBuyers}')),
          ],
        ),
        const SizedBox(height: 12),
        ..._mapRows(data.productCounts, label: 'Ürün'),
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
        _sectionTitle('İŞ LİSTESİ'),
        ...data.jobs.map((j) => _JobTile(job: j)),
      ],
    );
  }

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
          '${job.jobId.substring(0, job.jobId.length > 8 ? 8 : job.jobId.length)} · ${job.status ?? '?'}',
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
        ),
        subtitle: Text(
          'teslim=${job.deliveredCount} ret=${job.rejectedCount}'
          '${job.usedFreeTier ? ' · ücretsiz' : ''}'
          '${job.errorMessage != null ? ' · ${job.errorMessage}' : ''}',
          style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
        ),
        trailing: const Icon(Icons.chevron_right_rounded,
            color: AppColors.textMuted),
      ),
    );
  }
}
