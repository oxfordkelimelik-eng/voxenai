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
