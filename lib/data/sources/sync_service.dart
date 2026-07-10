import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:logger/logger.dart';
import '../../core/constants/app_constants.dart';

/// Yerel SharedPreferences durumunu kullanıcının Firestore dokümanıyla aynalar.
/// Yerel-öncelikli mimariyi korur: uygulama offline çalışır, online olunca senkronlanır.
/// Çakışmada "en son güncelleyen kazanır" (updatedAt damgası) kuralı uygulanır.
class SyncService {
  final FirebaseFirestore _db;
  final Logger _logger = Logger();

  SyncService({FirebaseFirestore? db})
    : _db = db ?? FirebaseFirestore.instance;

  /// Buluta aynalanacak yerel anahtarlar (foto YOLLARI hariç — onlar cihaza özel).
  static const List<String> _syncedKeys = [
    StorageKeys.userProfile,
    StorageKeys.currentStreak,
    StorageKeys.totalXp,
    StorageKeys.userLevel,
    StorageKeys.dailyTasks,
    StorageKeys.lastTaskDate,
    StorageKeys.isPro,
    StorageKeys.proExpiry,
    StorageKeys.waterToday,
    StorageKeys.taskHistory,
    StorageKeys.socialLevel,
    StorageKeys.dailyStepGoal,
    StorageKeys.surveyDone,
    StorageKeys.trialStartDate,
    StorageKeys.surveyAnswers,
    StorageKeys.intakeData,
    StorageKeys.faceAnalysisData,
    StorageKeys.bodyAnalysisData,
    StorageKeys.addictions,
  ];

  DocumentReference<Map<String, dynamic>> _userDoc(String uid) =>
      _db.collection('users').doc(uid);

  /// Açılışta çağrılır: bulut daha yeniyse buluttan yerel'e indirir.
  /// İlk kez ise (bulutta veri yoksa) yerel'i buluta yükler.
  Future<void> pullIfNewer(String uid) async {
    try {
      final snap = await _userDoc(uid).get();
      final prefs = await SharedPreferences.getInstance();
      final localUpdatedAt = prefs.getInt('sync_updated_at') ?? 0;

      if (!snap.exists) {
        // Bulutta hiç veri yok — mevcut yerel veriyi yükle
        await pushToCloud(uid);
        return;
      }

      final data = snap.data()!;
      final cloudUpdatedAt = (data['updatedAt'] as int?) ?? 0;

      if (cloudUpdatedAt > localUpdatedAt) {
        final payload = data['data'] as Map<String, dynamic>? ?? {};
        await _applyToPrefs(prefs, payload);
        await prefs.setInt('sync_updated_at', cloudUpdatedAt);
        _logger.i('Bulut verisi yerel\'e indirildi (uid=$uid)');
      }
    } catch (e) {
      _logger.w('pullIfNewer atlandı (offline olabilir): $e');
    }
  }

  /// Yerel durumu buluta yazar (her önemli değişiklik sonrası çağrılır).
  Future<void> pushToCloud(String uid) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final Map<String, dynamic> payload = {};
      for (final key in _syncedKeys) {
        final v = prefs.get(key);
        if (v != null) payload[key] = v;
      }
      final now = DateTime.now().millisecondsSinceEpoch;
      await _userDoc(uid).set({
        'updatedAt': now,
        'data': payload,
      }, SetOptions(merge: true));
      await prefs.setInt('sync_updated_at', now);
      _logger.i('Yerel veri buluta yüklendi (uid=$uid, ${payload.length} anahtar)');
    } catch (e) {
      _logger.w('pushToCloud atlandı (offline olabilir): $e');
    }
  }

  Future<void> _applyToPrefs(
    SharedPreferences prefs,
    Map<String, dynamic> payload,
  ) async {
    for (final entry in payload.entries) {
      final k = entry.key;
      final v = entry.value;
      if (v is bool) {
        await prefs.setBool(k, v);
      } else if (v is int) {
        await prefs.setInt(k, v);
      } else if (v is double) {
        await prefs.setDouble(k, v);
      } else if (v is String) {
        await prefs.setString(k, v);
      } else if (v is List) {
        await prefs.setStringList(k, v.map((e) => e.toString()).toList());
      }
    }
  }
}
