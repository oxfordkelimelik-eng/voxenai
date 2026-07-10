import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../data/sources/claude_api_service.dart';
import '../../data/sources/auth_service.dart';
import '../../data/sources/sync_service.dart';
import '../../data/sources/billing_service.dart';
import '../../core/constants/app_constants.dart';
import '../../domain/entities/user_profile.dart';
import '../../domain/entities/intake_profile.dart';
import '../../domain/entities/face_analysis.dart';
import '../../domain/entities/body_analysis.dart';

// ============================================================
// ALTYAPI PROVİDERLARI
// ============================================================

final secureStorageProvider = Provider<FlutterSecureStorage>((ref) {
  return const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
});

final sharedPrefsProvider = FutureProvider<SharedPreferences>((ref) async {
  return await SharedPreferences.getInstance();
});

final claudeApiServiceProvider = Provider<ClaudeApiService>((ref) {
  final storage = ref.watch(secureStorageProvider);
  return ClaudeApiService(secureStorage: storage);
});

// ============================================================
// FIREBASE: KİMLİK & BULUT SENKRONU
// ============================================================

final authServiceProvider = Provider<AuthService>((ref) => AuthService());

final syncServiceProvider = Provider<SyncService>((ref) => SyncService());

/// Açılışta: anonim giriş yap, sonra bulut verisi yereldekinden yeniyse indir.
/// Hata olursa (offline) sessizce yerel veriyle devam eder.
final appBootstrapProvider = FutureProvider<void>((ref) async {
  final auth = ref.read(authServiceProvider);
  final sync = ref.read(syncServiceProvider);
  final user = await auth.ensureSignedIn();
  if (user != null) {
    await sync.pullIfNewer(user.uid);
  }
});

/// Yerel veride değişiklik olduğunda buluta yazmak için çağrılır.
/// Hem provider içi (Ref) hem widget (WidgetRef) tarafından kullanılabilir.
Future<void> _pushWith(AuthService auth, SyncService sync) async {
  final uid = auth.uid;
  if (uid != null) await sync.pushToCloud(uid);
}

Future<void> pushSync(Ref ref) =>
    _pushWith(ref.read(authServiceProvider), ref.read(syncServiceProvider));

Future<void> pushSyncW(WidgetRef ref) =>
    _pushWith(ref.read(authServiceProvider), ref.read(syncServiceProvider));

// ============================================================
// API ANAHTARI
// ============================================================
// Not: Kullanıcıdan API anahtarı İSTENMEZ. Gerçek Gemini anahtarı yalnızca
// Cloud Function (Firebase Secret: GEMINI_KEY) içinde tutulur ve istemciye
// hiç inmez. Bu yüzden istemci tarafı bir anahtar provider'ı yoktur.

// ============================================================
// INTAKE (DETAYLI GİRİŞ FORMU) PROVİDERİ
// ============================================================

final intakeProvider =
    StateNotifierProvider<IntakeNotifier, IntakeProfile?>((ref) {
  return IntakeNotifier();
});

class IntakeNotifier extends StateNotifier<IntakeProfile?> {
  IntakeNotifier() : super(null) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.intakeData);
    if (raw == null) return;
    try {
      state = IntakeProfile.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {}
  }

  Future<void> save(IntakeProfile profile) async {
    state = profile;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(StorageKeys.intakeData, jsonEncode(profile.toJson()));
    // Profil temel alanlarını da yaz (geriye dönük uyum)
    await prefs.setString('user_name', profile.name);
    await prefs.setInt('user_age', profile.age);
    await prefs.setDouble('user_height', profile.heightCm);
    await prefs.setDouble('user_weight', profile.weightKg);
  }

  Future<void> clear() async {
    state = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.intakeData);
    await prefs.remove('user_name');
    await prefs.remove('user_age');
    await prefs.remove('user_height');
    await prefs.remove('user_weight');
  }
}

// ============================================================
// AYRI ANALİZ PROVİDERLARI (YÜZ / VÜCUT)
// ============================================================

final faceAnalysisProvider =
    StateNotifierProvider<FaceAnalysisNotifier, FaceAnalysisResult?>((ref) {
  return FaceAnalysisNotifier();
});

class FaceAnalysisNotifier extends StateNotifier<FaceAnalysisResult?> {
  FaceAnalysisNotifier() : super(null) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.faceAnalysisData);
    if (raw == null) return;
    try {
      state =
          FaceAnalysisResult.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {}
  }

  Future<void> save(FaceAnalysisResult result) async {
    state = result;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
        StorageKeys.faceAnalysisData, jsonEncode(result.toJson()));
  }
}

final bodyAnalysisProvider =
    StateNotifierProvider<BodyAnalysisNotifier, BodyAnalysisResult?>((ref) {
  return BodyAnalysisNotifier();
});

class BodyAnalysisNotifier extends StateNotifier<BodyAnalysisResult?> {
  BodyAnalysisNotifier() : super(null) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.bodyAnalysisData);
    if (raw == null) return;
    try {
      state =
          BodyAnalysisResult.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {}
  }

  Future<void> save(BodyAnalysisResult result) async {
    state = result;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
        StorageKeys.bodyAnalysisData, jsonEncode(result.toJson()));
  }
}

// ============================================================
// KULLANICI PROFİLİ PROVİDERİ
// ============================================================

final userProfileProvider =
    StateNotifierProvider<UserProfileNotifier, UserProfile?>((ref) {
  final notifier = UserProfileNotifier();
  // Analiz skorlarını profile yansıt
  ref.listen<FaceAnalysisResult?>(faceAnalysisProvider, (_, next) {
    if (next != null) notifier.setFaceScore(next.overallScore);
  });
  ref.listen<BodyAnalysisResult?>(bodyAnalysisProvider, (_, next) {
    if (next != null) notifier.setBodyScore(next.overallScore);
  });
  return notifier;
});

class UserProfileNotifier extends StateNotifier<UserProfile?> {
  UserProfileNotifier() : super(null) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final isPro = prefs.getBool(StorageKeys.isPro) ?? false;
    final xp = prefs.getInt(StorageKeys.totalXp) ?? 0;
    final streak = prefs.getInt(StorageKeys.currentStreak) ?? 0;

    int faceScore = -1;
    int bodyScore = -1;
    final faceRaw = prefs.getString(StorageKeys.faceAnalysisData);
    if (faceRaw != null) {
      try {
        faceScore = (jsonDecode(faceRaw)['overallScore'] as num).toInt();
      } catch (_) {}
    }
    final bodyRaw = prefs.getString(StorageKeys.bodyAnalysisData);
    if (bodyRaw != null) {
      try {
        bodyScore = (jsonDecode(bodyRaw)['overallScore'] as num).toInt();
      } catch (_) {}
    }

    state = UserProfile(
      id: 'user_001',
      name: prefs.getString('user_name') ?? 'Savaşçı',
      age: prefs.getInt('user_age') ?? 20,
      heightCm: prefs.getDouble('user_height') ?? 175.0,
      weightKg: prefs.getDouble('user_weight') ?? 75.0,
      totalXp: xp,
      currentStreak: streak,
      longestStreak: prefs.getInt('longest_streak') ?? streak,
      isPro: isPro,
      createdAt: DateTime.now(),
      lastActiveAt: DateTime.now(),
      faceScore: faceScore,
      bodyScore: bodyScore,
    );
  }

  void setFaceScore(int score) {
    state = state?.copyWith(faceScore: score);
  }

  void setBodyScore(int score) {
    state = state?.copyWith(bodyScore: score);
  }

  Future<void> addXp(int xp) async {
    final prefs = await SharedPreferences.getInstance();
    final current = prefs.getInt(StorageKeys.totalXp) ?? 0;
    final newXp = current + xp;
    await prefs.setInt(StorageKeys.totalXp, newXp);
    state = state?.copyWith(totalXp: newXp);
  }

  Future<void> updateStreak() async {
    final prefs = await SharedPreferences.getInstance();
    final lastDate = prefs.getString(StorageKeys.lastTaskDate);
    final today = DateTime.now();
    // Saat farklarının gün hesabını bozmaması için günün başına sabitle.
    final todayMidnight = DateTime(today.year, today.month, today.day);
    final todayStr = _dateKey(todayMidnight);

    int newStreak = state?.currentStreak ?? 0;
    final last = _parseDateKey(lastDate);
    if (last == null) {
      // İlk kez tamamlama
      newStreak = 1;
    } else {
      final diff = todayMidnight.difference(last).inDays;
      if (diff == 0) {
        // Aynı gün tekrar tamamlandı — streak değişmez (zaten sayıldı).
        return;
      } else if (diff == 1) {
        newStreak = newStreak + 1; // Ardışık gün
      } else {
        newStreak = 1; // diff > 1 → seri kırıldı, sıfırdan başla
      }
    }

    final longest = state?.longestStreak ?? 0;
    final newLongest = newStreak > longest ? newStreak : longest;
    await prefs.setInt(StorageKeys.currentStreak, newStreak);
    await prefs.setString(StorageKeys.lastTaskDate, todayStr);
    if (newLongest > longest) {
      await prefs.setInt('longest_streak', newLongest);
    }

    state = state?.copyWith(
      currentStreak: newStreak,
      longestStreak: newLongest,
    );
  }

  /// Tarihi sıfır dolgulu, ayrıştırılabilir bir anahtara çevirir (YYYY-MM-DD).
  String _dateKey(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  /// Kayıtlı tarih anahtarını güvenle ayrıştırır. Eski/bozuk formatlar
  /// (ör. "2026-6-30") da çalışsın diye elle parçalanır.
  DateTime? _parseDateKey(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final parts = raw.split(RegExp(r'[-T ]'));
    if (parts.length < 3) return null;
    final y = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    final d = int.tryParse(parts[2]);
    if (y == null || m == null || d == null) return null;
    return DateTime(y, m, d);
  }

  Future<void> setPro(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(StorageKeys.isPro, value);
    state = state?.copyWith(isPro: value);
  }

  Future<void> updateProfile({
    required String name,
    required int age,
    required double height,
    required double weight,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_name', name);
    await prefs.setInt('user_age', age);
    await prefs.setDouble('user_height', height);
    await prefs.setDouble('user_weight', weight);
    await _load();
  }

  void reload() => _load();

  /// XP, streak ve analiz skorlarını sıfırlar (profil bilgileri korunur).
  Future<void> resetProgress() async {
    final prefs = await SharedPreferences.getInstance();
    const keys = [
      StorageKeys.totalXp,
      StorageKeys.currentStreak,
      StorageKeys.userLevel,
      StorageKeys.lastTaskDate,
      StorageKeys.dailyTasks,
      StorageKeys.taskHistory,
      StorageKeys.socialLevel,
      StorageKeys.faceAnalysisData,
      StorageKeys.bodyAnalysisData,
      StorageKeys.progressHistory,
      StorageKeys.addictions,
      StorageKeys.analysisHistory,
      StorageKeys.waterToday,
      StorageKeys.workoutHistory,
      StorageKeys.fastingStartTime,
      StorageKeys.dailySteps,
      StorageKeys.dailyStepsDate,
      'longest_streak',
      'tasks_date',
    ];
    for (final key in keys) {
      await prefs.remove(key);
    }
    await _load();
  }
}

// ============================================================
// ONBOARDING PROVİDERİ
// ============================================================

final onboardingDoneProvider = FutureProvider<bool>((ref) async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getBool(StorageKeys.onboardingDone) ?? false;
});

// ============================================================
// PRO DURUM PROVİDERİ
// ============================================================

final isProProvider = Provider<bool>((ref) {
  final user = ref.watch(userProfileProvider);
  return user?.isPro ?? false;
});

// ============================================================
// GOOGLE PLAY BILLING (PRO ABONELİĞİ)
// ============================================================

/// Billing servisini başlatır ve satın alma başarısında PRO'yu açar.
final billingServiceProvider = Provider<BillingService>((ref) {
  final service = BillingService();
  service.onPurchaseSuccess = (_) {
    // Satın alma/restore başarılı → PRO'yu aç ve buluta senkronla
    ref.read(userProfileProvider.notifier).setPro(true);
    pushSync(ref);
  };
  service.init();
  ref.onDispose(service.dispose);
  return service;
});

// ============================================================
// DENEME (TRIAL) PROVİDERİ
// ============================================================

enum TrialStatus { notStarted, active, expired }

class TrialState {
  final TrialStatus status;
  final int daysRemaining;
  const TrialState({
    this.status = TrialStatus.notStarted,
    this.daysRemaining = 3,
  });
}

final trialProvider = StateNotifierProvider<TrialNotifier, TrialState>(
  (ref) => TrialNotifier(),
);

class TrialNotifier extends StateNotifier<TrialState> {
  TrialNotifier() : super(const TrialState()) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final isPro = prefs.getBool(StorageKeys.isPro) ?? false;
    if (isPro) {
      state = const TrialState(status: TrialStatus.active, daysRemaining: 999);
      return;
    }
    final startStr = prefs.getString(StorageKeys.trialStartDate);
    if (startStr == null) {
      state = const TrialState(
        status: TrialStatus.notStarted,
        daysRemaining: 3,
      );
      return;
    }
    final start = DateTime.parse(startStr);
    final daysPassed = DateTime.now().difference(start).inDays;
    final remaining = (3 - daysPassed).clamp(0, 3);
    state = TrialState(
      status: remaining > 0 ? TrialStatus.active : TrialStatus.expired,
      daysRemaining: remaining,
    );
  }

  Future<void> startTrial() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      StorageKeys.trialStartDate,
      DateTime.now().toIso8601String(),
    );
    state = const TrialState(status: TrialStatus.active, daysRemaining: 3);
  }

  void reload() => _load();

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.trialStartDate);
    state = const TrialState();
  }
}

final trialStatusProvider = Provider<TrialStatus>((ref) {
  return ref.watch(trialProvider).status;
});

final trialDaysRemainingProvider = Provider<int>((ref) {
  return ref.watch(trialProvider).daysRemaining;
});
