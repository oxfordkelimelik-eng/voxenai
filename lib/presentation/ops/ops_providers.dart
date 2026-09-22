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

/// Panelin üstündeki hızlı aralık seçici — "Bugün / Dün / Bu Hafta / Bu Ay".
enum OpsQuickRange { today, yesterday, week, month }

extension OpsQuickRangeX on OpsQuickRange {
  String get label => switch (this) {
        OpsQuickRange.today => 'Bugün',
        OpsQuickRange.yesterday => 'Dün',
        OpsQuickRange.week => 'Bu Hafta',
        OpsQuickRange.month => 'Bu Ay',
      };

  /// SAAT/DAKİKA İÇERMEZ — yalnızca GÜN sınırları döner.
  ///
  /// 'until' ARTIK ŞİMDİ (DateTime.now()) DEĞİL (2026-09-13). Eski hâlinde
  /// "bugün/bu hafta/bu ay" için until=now yazılıyordu ve bu, sonucu
  /// değiştirmediği hâlde HER HESAPLAMADA FARKLI bir değer üretiyordu.
  /// OpsDateRange eşitliği since/until'a baktığı için her yeni değer
  /// FutureProvider.family'de YENİ BİR ÖNBELLEK GİRDİSİ açıyordu: sekmeye
  /// her dönüşte ve her yenilemede taze bir ağ çağrısı: 60/10dk sınırı
  /// böyle doldu (gerçek olay 2026-09-13, sayaç 5 dakikada 60/60).
  ///
  /// 2026-09-11'deki opsResolvedRangeProvider düzeltmesi build DÖNGÜSÜNÜ
  /// kesmişti ama anahtarın kendisi hâlâ oynaktı; asıl kök sebep buydu.
  ///
  /// Gelecek bir zamanı 'until' yapmak güvenli: sunucu aralığı kapalı
  /// kabul ediyor ve bugünün sonuna kadar olan her satış zaten dahil.
  OpsDateRange toRange() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    // Günün SONU — gün boyunca sabit kalır, bu yüzden önbellek anahtarı da
    // sabit kalır (aynı gün içinde tekrar tekrar aynı girdi kullanılır).
    final endOfToday = today
        .add(const Duration(days: 1))
        .subtract(const Duration(milliseconds: 1));
    switch (this) {
      case OpsQuickRange.today:
        return OpsDateRange(since: today, until: endOfToday);
      case OpsQuickRange.yesterday:
        final yesterday = today.subtract(const Duration(days: 1));
        // 'until' dünün son anı — bugüne sarkarsa bugünün satışları da dahil olur.
        return OpsDateRange(
            since: yesterday,
            until: today.subtract(const Duration(milliseconds: 1)));
      case OpsQuickRange.week:
        return OpsDateRange(
            since: today.subtract(const Duration(days: 7)), until: endOfToday);
      case OpsQuickRange.month:
        return OpsDateRange(
            since: today.subtract(const Duration(days: 30)), until: endOfToday);
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

// ============================================================
// FOTO ONAYI (2026-09-22)
// ------------------------------------------------------------
// Üretilen kareler kullanıcıya doğrudan gitmiyor; buradan onaylananlar
// onun klasörüne kopyalanıyor ve kendisine bildirim gidiyor.
// ============================================================

/// Seçilen kareleri teslim eder. [selectedRefs] HAM gs:// adresleridir —
/// imzalı URL süreli olduğu için kare kimliği olarak kullanılamaz.
/// Döner: kaç kare teslim edildi.
Future<int> opsApprovePhotos({
  required String uid,
  required String jobId,
  required List<String> selectedRefs,
}) async {
  final callable = FirebaseFunctions.instanceFor(region: _opsRegion)
      .httpsCallable('opsApprovePhotos');
  final result = await callable.call(<String, dynamic>{
    'uid': uid,
    'jobId': jobId,
    'selectedUrls': selectedRefs,
  });
  final data = Map<String, dynamic>.from(result.data as Map);
  return (data['approved'] as num?)?.toInt() ?? 0;
}

/// Panelden ELLE yüklenen fotoğrafı kullanıcının teslim listesine ekler.
///
/// Dosya doğrudan Storage'a yüklenir (storage.rules yalnızca ops hesabına
/// ve yalnızca "manual_" ön ekli dosyalara izin verir); burada yalnızca
/// sunucuya "bu yolu listeye ekle" deniyor. Büyük dosyayı callable
/// payload'ından geçirmemek için bu ikili yapı bilinçli.
Future<void> opsAttachUploadedPhoto({
  required String uid,
  required String jobId,
  required String path,
}) async {
  final callable = FirebaseFunctions.instanceFor(region: _opsRegion)
      .httpsCallable('opsAttachUploadedPhoto');
  await callable.call(<String, dynamic>{
    'uid': uid,
    'jobId': jobId,
    'path': path,
  });
}
