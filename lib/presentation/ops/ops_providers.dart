import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'ops_models.dart';

/// Tarih aralığı — varsayılan yoksa Cloud Function kendi varsayılanını
/// (son 30 gün) kullanır.
class OpsDateRange {
  final DateTime? since;
  final DateTime? until;
  const OpsDateRange({this.since, this.until});

  @override
  bool operator ==(Object other) =>
      other is OpsDateRange && other.since == since && other.until == until;
  @override
  int get hashCode => Object.hash(since, until);
}

/// Panelin üstündeki hızlı aralık seçici — "Bugün / Bu Hafta / Bu Ay / 90 Gün".
enum OpsQuickRange { today, week, month, quarter }

extension OpsQuickRangeX on OpsQuickRange {
  String get label => switch (this) {
        OpsQuickRange.today => 'Bugün',
        OpsQuickRange.week => 'Bu Hafta',
        OpsQuickRange.month => 'Bu Ay',
        OpsQuickRange.quarter => 'Son 90 Gün',
      };

  OpsDateRange toRange() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    switch (this) {
      case OpsQuickRange.today:
        return OpsDateRange(since: today, until: now);
      case OpsQuickRange.week:
        return OpsDateRange(
            since: today.subtract(const Duration(days: 7)), until: now);
      case OpsQuickRange.month:
        return OpsDateRange(
            since: today.subtract(const Duration(days: 30)), until: now);
      case OpsQuickRange.quarter:
        return OpsDateRange(
            since: today.subtract(const Duration(days: 90)), until: now);
    }
  }
}

final opsQuickRangeProvider = StateProvider<OpsQuickRange>(
  (ref) => OpsQuickRange.month,
);

/// Seçilen hızlı aralığın SOMUT tarih değeri — YALNIZCA opsQuickRangeProvider
/// değiştiğinde yeniden hesaplanır. quickRange.toRange() çağrısını doğrudan
/// widget build()'inde yapmak YANLIŞ: DateTime.now() her build'te farklı bir
/// 'until' üretir, bu da FutureProvider.family'nin key'ini (OpsDateRange
/// eşitliği since/until'a bakar) her build'te değiştirip yeni bir
/// opsGetOverview çağrısı tetikler — hızlıca hız sınırına (60/10dk) çarpıp
/// ekranda sonsuz "loading" görünmesine yol açar (gerçek olay, 2026-09-11).
final opsResolvedRangeProvider = Provider<OpsDateRange>((ref) {
  final quickRange = ref.watch(opsQuickRangeProvider);
  return quickRange.toRange();
});

const _opsRegion = 'europe-west1';

final opsOverviewProvider =
    FutureProvider.family<OpsOverview, OpsDateRange>((ref, range) async {
  final callable = FirebaseFunctions.instanceFor(region: _opsRegion)
      .httpsCallable('opsGetOverview');
  final result = await callable.call(<String, dynamic>{
    if (range.since != null)
      'sinceMillis': range.since!.millisecondsSinceEpoch,
    if (range.until != null)
      'untilMillis': range.until!.millisecondsSinceEpoch,
  });
  return OpsOverview.fromJson(Map<String, dynamic>.from(result.data as Map));
});

typedef OpsJobKey = ({String uid, String jobId});

final opsJobDetailProvider =
    FutureProvider.family<OpsJobDetail, OpsJobKey>((ref, key) async {
  final callable = FirebaseFunctions.instanceFor(region: _opsRegion)
      .httpsCallable('opsGetJobDetail');
  final result = await callable.call(<String, dynamic>{
    'uid': key.uid,
    'jobId': key.jobId,
  });
  return OpsJobDetail.fromJson(Map<String, dynamic>.from(result.data as Map));
});
