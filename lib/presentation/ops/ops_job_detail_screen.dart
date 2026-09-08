import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants/app_colors.dart';
import 'ops_gate.dart';
import 'ops_models.dart';
import 'ops_providers.dart';

class OpsJobDetailScreen extends StatelessWidget {
  final String uid;
  final String jobId;
  const OpsJobDetailScreen({required this.uid, required this.jobId, super.key});

  @override
  Widget build(BuildContext context) {
    return OpsGate(
      builder: (context) => _JobDetailBody(uid: uid, jobId: jobId),
    );
  }
}

class _JobDetailBody extends ConsumerWidget {
  final String uid;
  final String jobId;
  const _JobDetailBody({required this.uid, required this.jobId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = (uid: uid, jobId: jobId);
    final detail = ref.watch(opsJobDetailProvider(key));

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded,
              size: 18, color: AppColors.textSecondary),
          onPressed: () => context.pop(),
        ),
        title: Text(jobId.substring(0, jobId.length > 8 ? 8 : jobId.length),
            style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: detail.when(
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
        data: (data) => _DetailContent(data: data),
      ),
    );
  }
}

class _DetailContent extends StatelessWidget {
  final OpsJobDetail data;
  const _DetailContent({required this.data});

  @override
  Widget build(BuildContext context) {
    final delivered = data.results.values
        .expand((r) => r.photoUrls)
        .whereType<String>()
        .toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _infoCard(),
        const SizedBox(height: 20),
        _sectionTitle('TESLİM EDİLEN FOTOĞRAFLAR (${delivered.length})'),
        if (delivered.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Yok', style: TextStyle(color: AppColors.textMuted)),
          )
        else
          _photoGrid(delivered),
        const SizedBox(height: 24),
        _sectionTitle('REDDEDİLEN KARELER (${data.rejectedFrames.length})'),
        if (data.rejectedFrames.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Yok', style: TextStyle(color: AppColors.textMuted)),
          )
        else
          _rejectedGrid(data.rejectedFrames),
      ],
    );
  }

  Widget _infoCard() => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _row('Durum', data.status ?? '?'),
            _row('Model', data.model ?? '?'),
            _row('Mod', data.photoMode ?? '?'),
            _row('Ücretsiz Deneme', data.usedFreeTier ? 'Evet' : 'Hayır'),
            _row('Ücret (birim)', '${data.packUnitsCharged}'),
            if (data.errorMessage != null)
              _row('Hata', data.errorMessage!, valueColor: AppColors.error),
          ],
        ),
      );

  Widget _row(String label, String value, {Color? valueColor}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 13)),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                      color: valueColor ?? AppColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      );

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text,
            style: const TextStyle(
                color: AppColors.textMuted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6)),
      );

  Widget _photoGrid(List<String> urls) => GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 6,
          mainAxisSpacing: 6,
        ),
        itemCount: urls.length,
        itemBuilder: (context, i) => ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: CachedNetworkImage(
            imageUrl: urls[i],
            fit: BoxFit.cover,
            placeholder: (c, u) =>
                const ColoredBox(color: AppColors.surfaceElevated),
            errorWidget: (c, u, e) => const ColoredBox(
              color: AppColors.surfaceElevated,
              child: Icon(Icons.broken_image_outlined,
                  color: AppColors.textMuted),
            ),
          ),
        ),
      );

  Widget _rejectedGrid(List<OpsRejectedFrame> frames) => GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 6,
          mainAxisSpacing: 6,
          childAspectRatio: 0.78,
        ),
        itemCount: frames.length,
        itemBuilder: (context, i) {
          final f = frames[i];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: f.url != null
                      ? CachedNetworkImage(
                          imageUrl: f.url!,
                          fit: BoxFit.cover,
                          placeholder: (c, u) => const ColoredBox(
                              color: AppColors.surfaceElevated),
                          errorWidget: (c, u, e) => const ColoredBox(
                            color: AppColors.surfaceElevated,
                            child: Icon(Icons.broken_image_outlined,
                                color: AppColors.textMuted),
                          ),
                        )
                      : const ColoredBox(color: AppColors.surfaceElevated),
                ),
              ),
              const SizedBox(height: 3),
              Text(
                f.gate ?? '?',
                style: const TextStyle(
                    color: AppColors.error,
                    fontSize: 10,
                    fontWeight: FontWeight.w700),
                overflow: TextOverflow.ellipsis,
              ),
            ],
          );
        },
      );
}
