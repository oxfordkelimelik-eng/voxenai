// Gizli işletim paneli veri modelleri — opsGetOverview/opsGetJobDetail
// Cloud Function yanıtlarını temsil eder. Elle yazılmış (code-gen yok,
// admin-only, küçük şema).

/// json içindeki her hangi bir değeri güvenle String'e çevirir — sunucudan
/// yanlışlıkla obje (Map) gelen bir alan `as String?` cast'iyle uygulamayı
/// çökertmesin diye. Sunucu tarafında `safeString` zaten JSON'a çeviriyor,
/// bu sadece ek bir savunma katmanı (eski/cache'lenmiş yanıtlar için).
String? _asString(dynamic v) {
  if (v == null) return null;
  if (v is String) return v;
  return v.toString();
}

class OpsPurchase {
  final String? uid;
  final String? email;
  final String orderId;
  final String? productId;
  final String? platform;
  final String? creditedField;
  final int creditedAmount;
  final int priceTry;
  final int? createdAtMillis;

  OpsPurchase({
    required this.uid,
    required this.email,
    required this.orderId,
    required this.productId,
    required this.platform,
    required this.creditedField,
    required this.creditedAmount,
    required this.priceTry,
    required this.createdAtMillis,
  });

  factory OpsPurchase.fromJson(Map<String, dynamic> j) => OpsPurchase(
        uid: _asString(j['uid']),
        email: _asString(j['email']),
        orderId: _asString(j['orderId']) ?? '',
        productId: _asString(j['productId']),
        platform: _asString(j['platform']),
        creditedField: _asString(j['creditedField']),
        creditedAmount: (j['creditedAmount'] as num?)?.toInt() ?? 0,
        priceTry: (j['priceTry'] as num?)?.toInt() ?? 0,
        createdAtMillis: (j['createdAt'] as num?)?.toInt(),
      );
}

class OpsDailyStat {
  final String day;
  final int count;
  final int revenueTry;
  final Map<String, int> productCounts;

  OpsDailyStat({
    required this.day,
    required this.count,
    required this.revenueTry,
    required this.productCounts,
  });

  factory OpsDailyStat.fromJson(Map<String, dynamic> j) => OpsDailyStat(
        day: _asString(j['day']) ?? '?',
        count: (j['count'] as num?)?.toInt() ?? 0,
        revenueTry: (j['revenueTry'] as num?)?.toInt() ?? 0,
        productCounts: Map<String, int>.from(
          (j['productCounts'] as Map?)?.map(
                (k, v) => MapEntry(k.toString(), (v as num).toInt()),
              ) ??
              {},
        ),
      );
}

class OpsJobSummary {
  final String? uid;
  final String? email;
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
    required this.email,
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
        uid: _asString(j['uid']),
        email: _asString(j['email']),
        jobId: _asString(j['jobId']) ?? '',
        status: _asString(j['status']),
        styles: (j['styles'] as List?)?.map((e) => e.toString()).toList(),
        photoMode: _asString(j['photoMode']),
        model: _asString(j['model']),
        usedFreeTier: j['usedFreeTier'] as bool? ?? false,
        packUnitsCharged: (j['packUnitsCharged'] as num?)?.toInt() ?? 0,
        errorMessage: _asString(j['errorMessage']),
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
  final int totalRevenueTry;
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
  final List<OpsDailyStat> dailyBreakdown;

  OpsOverview({
    required this.totalPurchases,
    required this.uniqueBuyers,
    required this.productCounts,
    required this.totalRevenueTry,
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
    required this.dailyBreakdown,
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
      totalRevenueTry: (summary['totalRevenueTry'] as num?)?.toInt() ?? 0,
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
      dailyBreakdown: ((j['dailyBreakdown'] as List?) ?? [])
          .map((e) => OpsDailyStat.fromJson(Map<String, dynamic>.from(e as Map)))
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
        gate: _asString(j['gate']),
        chunkIdx: (j['chunkIdx'] as num?)?.toInt(),
        attempt: (j['attempt'] as num?)?.toInt(),
        reason: _asString(j['reason']),
        detail: _asString(j['detail']),
        rejectedAt: _asString(j['rejectedAt']),
        url: _asString(j['url']),
      );
}

class OpsStyleResult {
  final String? status;
  final List<String> photoUrls;

  OpsStyleResult({required this.status, required this.photoUrls});

  factory OpsStyleResult.fromJson(Map<String, dynamic> j) => OpsStyleResult(
        status: _asString(j['status']),
        photoUrls: ((j['photoUrls'] as List?) ?? [])
            .where((e) => e != null)
            .map((e) => e.toString())
            .toList(),
      );
}

class OpsJobDetail {
  final String uid;
  final String? email;
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
    required this.email,
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
        uid: _asString(j['uid']) ?? '',
        email: _asString(j['email']),
        jobId: _asString(j['jobId']) ?? '',
        status: _asString(j['status']),
        styles: (j['styles'] as List?)?.map((e) => e.toString()).toList(),
        photoMode: _asString(j['photoMode']),
        model: _asString(j['model']),
        usedFreeTier: j['usedFreeTier'] as bool? ?? false,
        packUnitsCharged: (j['packUnitsCharged'] as num?)?.toInt() ?? 0,
        errorMessage: _asString(j['errorMessage']),
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
