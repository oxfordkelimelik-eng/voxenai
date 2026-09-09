// Gizli işletim paneli veri modelleri — opsGetOverview/opsGetJobDetail
// Cloud Function yanıtlarını temsil eder. Elle yazılmış (code-gen yok,
// admin-only, küçük şema).

class OpsPurchase {
  final String? uid;
  final String orderId;
  final String? productId;
  final String? platform;
  final String? creditedField;
  final int creditedAmount;
  final int? createdAtMillis;

  OpsPurchase({
    required this.uid,
    required this.orderId,
    required this.productId,
    required this.platform,
    required this.creditedField,
    required this.creditedAmount,
    required this.createdAtMillis,
  });

  factory OpsPurchase.fromJson(Map<String, dynamic> j) => OpsPurchase(
        uid: j['uid'] as String?,
        orderId: j['orderId'] as String? ?? '',
        productId: j['productId'] as String?,
        platform: j['platform'] as String?,
        creditedField: j['creditedField'] as String?,
        creditedAmount: (j['creditedAmount'] as num?)?.toInt() ?? 0,
        createdAtMillis: (j['createdAt'] as num?)?.toInt(),
      );
}

class OpsJobSummary {
  final String? uid;
  final String jobId;
  final String? status;
  final List<String>? styles;
  final String? photoMode;
  final String? model;
  final bool usedFreeTier;
  final int packUnitsCharged;
  final String? errorMessage;
  final int deliveredCount;
  final int rejectedCount;
  final Map<String, int> gateCounts;
  final int? createdAtMillis;
  final int? updatedAtMillis;

  OpsJobSummary({
    required this.uid,
    required this.jobId,
    required this.status,
    required this.styles,
    required this.photoMode,
    required this.model,
    required this.usedFreeTier,
    required this.packUnitsCharged,
    required this.errorMessage,
    required this.deliveredCount,
    required this.rejectedCount,
    required this.gateCounts,
    required this.createdAtMillis,
    required this.updatedAtMillis,
  });

  factory OpsJobSummary.fromJson(Map<String, dynamic> j) => OpsJobSummary(
        uid: j['uid'] as String?,
        jobId: j['jobId'] as String? ?? '',
        status: j['status'] as String?,
        styles: (j['styles'] as List?)?.map((e) => e.toString()).toList(),
        photoMode: j['photoMode'] as String?,
        model: j['model'] as String?,
        usedFreeTier: j['usedFreeTier'] as bool? ?? false,
        packUnitsCharged: (j['packUnitsCharged'] as num?)?.toInt() ?? 0,
        errorMessage: j['errorMessage'] as String?,
        deliveredCount: (j['deliveredCount'] as num?)?.toInt() ?? 0,
        rejectedCount: (j['rejectedCount'] as num?)?.toInt() ?? 0,
        gateCounts: Map<String, int>.from(
          (j['gateCounts'] as Map?)?.map(
                (k, v) => MapEntry(k.toString(), (v as num).toInt()),
              ) ??
              {},
        ),
        createdAtMillis: (j['createdAt'] as num?)?.toInt(),
        updatedAtMillis: (j['updatedAt'] as num?)?.toInt(),
      );
}

class OpsOverview {
  final int totalPurchases;
  final int uniqueBuyers;
  final Map<String, int> productCounts;
  final int totalJobs;
  final int uniqueProducers;
  final Map<String, int> statusCounts;
  final int totalDelivered;
  final int totalRejected;
  final Map<String, int> gateCounts;
  final int freeTierJobs;
  final int paidJobs;
  final int failedJobs;
  final List<OpsPurchase> purchases;
  final List<OpsJobSummary> jobs;

  OpsOverview({
    required this.totalPurchases,
    required this.uniqueBuyers,
    required this.productCounts,
    required this.totalJobs,
    required this.uniqueProducers,
    required this.statusCounts,
    required this.totalDelivered,
    required this.totalRejected,
    required this.gateCounts,
    required this.freeTierJobs,
    required this.paidJobs,
    required this.failedJobs,
    required this.purchases,
    required this.jobs,
  });

  factory OpsOverview.fromJson(Map<String, dynamic> j) {
    final summary = Map<String, dynamic>.from(j['summary'] as Map);
    return OpsOverview(
      totalPurchases: (summary['totalPurchases'] as num?)?.toInt() ?? 0,
      uniqueBuyers: (summary['uniqueBuyers'] as num?)?.toInt() ?? 0,
      productCounts: Map<String, int>.from(
        (summary['productCounts'] as Map?)?.map(
              (k, v) => MapEntry(k.toString(), (v as num).toInt()),
            ) ??
            {},
      ),
      totalJobs: (summary['totalJobs'] as num?)?.toInt() ?? 0,
      uniqueProducers: (summary['uniqueProducers'] as num?)?.toInt() ?? 0,
      statusCounts: Map<String, int>.from(
        (summary['statusCounts'] as Map?)?.map(
              (k, v) => MapEntry(k.toString(), (v as num).toInt()),
            ) ??
            {},
      ),
      totalDelivered: (summary['totalDelivered'] as num?)?.toInt() ?? 0,
      totalRejected: (summary['totalRejected'] as num?)?.toInt() ?? 0,
      gateCounts: Map<String, int>.from(
        (summary['gateCounts'] as Map?)?.map(
              (k, v) => MapEntry(k.toString(), (v as num).toInt()),
            ) ??
            {},
      ),
      freeTierJobs: (summary['freeTierJobs'] as num?)?.toInt() ?? 0,
      paidJobs: (summary['paidJobs'] as num?)?.toInt() ?? 0,
      failedJobs: (summary['failedJobs'] as num?)?.toInt() ?? 0,
      purchases: ((j['purchases'] as List?) ?? [])
          .map((e) => OpsPurchase.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(),
      jobs: ((j['jobs'] as List?) ?? [])
          .map((e) => OpsJobSummary.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(),
    );
  }
}

class OpsRejectedFrame {
  final String? gate;
  final int? chunkIdx;
  final int? attempt;
  final String? reason;
  final String? detail;
  final String? rejectedAt;
  final String? url;

  OpsRejectedFrame({
    required this.gate,
    required this.chunkIdx,
    required this.attempt,
    required this.reason,
    required this.detail,
    required this.rejectedAt,
    required this.url,
  });

  factory OpsRejectedFrame.fromJson(Map<String, dynamic> j) => OpsRejectedFrame(
        gate: j['gate'] as String?,
        chunkIdx: (j['chunkIdx'] as num?)?.toInt(),
        attempt: (j['attempt'] as num?)?.toInt(),
        reason: j['reason'] as String?,
        detail: j['detail'] as String?,
        rejectedAt: j['rejectedAt'] as String?,
        url: j['url'] as String?,
      );
}

class OpsStyleResult {
  final String? status;
  final List<String> photoUrls;

  OpsStyleResult({required this.status, required this.photoUrls});

  factory OpsStyleResult.fromJson(Map<String, dynamic> j) => OpsStyleResult(
        status: j['status'] as String?,
        photoUrls: ((j['photoUrls'] as List?) ?? [])
            .where((e) => e != null)
            .map((e) => e.toString())
            .toList(),
      );
}

class OpsJobDetail {
  final String uid;
  final String jobId;
  final String? status;
  final List<String>? styles;
  final String? photoMode;
  final String? model;
  final bool usedFreeTier;
  final int packUnitsCharged;
  final String? errorMessage;
  final int? createdAtMillis;
  final int? updatedAtMillis;
  final Map<String, OpsStyleResult> results;
  final List<OpsRejectedFrame> rejectedFrames;

  OpsJobDetail({
    required this.uid,
    required this.jobId,
    required this.status,
    required this.styles,
    required this.photoMode,
    required this.model,
    required this.usedFreeTier,
    required this.packUnitsCharged,
    required this.errorMessage,
    required this.createdAtMillis,
    required this.updatedAtMillis,
    required this.results,
    required this.rejectedFrames,
  });

  factory OpsJobDetail.fromJson(Map<String, dynamic> j) => OpsJobDetail(
        uid: j['uid'] as String? ?? '',
        jobId: j['jobId'] as String? ?? '',
        status: j['status'] as String?,
        styles: (j['styles'] as List?)?.map((e) => e.toString()).toList(),
        photoMode: j['photoMode'] as String?,
        model: j['model'] as String?,
        usedFreeTier: j['usedFreeTier'] as bool? ?? false,
        packUnitsCharged: (j['packUnitsCharged'] as num?)?.toInt() ?? 0,
        errorMessage: j['errorMessage'] as String?,
        createdAtMillis: (j['createdAt'] as num?)?.toInt(),
        updatedAtMillis: (j['updatedAt'] as num?)?.toInt(),
        results: Map<String, OpsStyleResult>.from(
          (j['results'] as Map?)?.map(
                (k, v) => MapEntry(
                  k.toString(),
                  OpsStyleResult.fromJson(Map<String, dynamic>.from(v as Map)),
                ),
              ) ??
              {},
        ),
        rejectedFrames: ((j['rejectedFrames'] as List?) ?? [])
            .map((e) => OpsRejectedFrame.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
      );
}
