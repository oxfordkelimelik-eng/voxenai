import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart' as fb_auth;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../data/sources/dating_purchase_service.dart';
import '../../providers/app_providers.dart' show authServiceProvider;

/// Dating paketleri için tüketilebilir IAP servisi (App Store/Play Store +
/// sunucu tarafı doğrulama). Rise Up'ın abonelik `BillingService`'inden
/// ayrı — bkz. dating_purchase_service.dart.
final datingPurchaseServiceProvider = Provider<DatingPurchaseService>((ref) {
  final service = DatingPurchaseService();
  ref.onDispose(service.dispose);
  return service;
});

// ============================================================
// ONBOARDING QUIZ CEVAPLARI (Bölüm 2)
// ============================================================

class DatingAnswers {
  final String? gender; // 'male' | 'female' | 'na'
  final String? ageRange; // 'under18' | '18-24' | ...
  final List<String> apps; // çoklu seçim
  final String? matchesPerDay;
  final String? satisfaction;

  const DatingAnswers({
    this.gender,
    this.ageRange,
    this.apps = const [],
    this.matchesPerDay,
    this.satisfaction,
  });

  DatingAnswers copyWith({
    String? gender,
    String? ageRange,
    List<String>? apps,
    String? matchesPerDay,
    String? satisfaction,
  }) =>
      DatingAnswers(
        gender: gender ?? this.gender,
        ageRange: ageRange ?? this.ageRange,
        apps: apps ?? this.apps,
        matchesPerDay: matchesPerDay ?? this.matchesPerDay,
        satisfaction: satisfaction ?? this.satisfaction,
      );

  Map<String, dynamic> toJson() => {
        'gender': gender,
        'ageRange': ageRange,
        'apps': apps,
        'matchesPerDay': matchesPerDay,
        'satisfaction': satisfaction,
      };

  factory DatingAnswers.fromJson(Map<String, dynamic> j) => DatingAnswers(
        gender: j['gender'] as String?,
        ageRange: j['ageRange'] as String?,
        apps: (j['apps'] as List?)?.cast<String>() ?? const [],
        matchesPerDay: j['matchesPerDay'] as String?,
        satisfaction: j['satisfaction'] as String?,
      );
}

final datingAnswersProvider =
    StateNotifierProvider<DatingAnswersNotifier, DatingAnswers>(
        (ref) => DatingAnswersNotifier());

class DatingAnswersNotifier extends StateNotifier<DatingAnswers> {
  DatingAnswersNotifier() : super(const DatingAnswers()) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(DatingKeys.answers);
    if (raw == null) return;
    try {
      state = DatingAnswers.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {}
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(DatingKeys.answers, jsonEncode(state.toJson()));
  }

  void setGender(String v) {
    state = state.copyWith(gender: v);
    _persist();
  }

  void setAgeRange(String v) {
    state = state.copyWith(ageRange: v);
    _persist();
  }

  void toggleApp(String app) {
    final list = List<String>.from(state.apps);
    list.contains(app) ? list.remove(app) : list.add(app);
    state = state.copyWith(apps: list);
    _persist();
  }

  void setMatches(String v) {
    state = state.copyWith(matchesPerDay: v);
    _persist();
  }

  void setSatisfaction(String v) {
    state = state.copyWith(satisfaction: v);
    _persist();
  }
}

// ============================================================
// HESAP (ZORUNLU giriş — sisteme girebilmek için gereklidir)
// ============================================================
// NOT: Abonelik kaldırıldı. Erişim artık tek seferlik paket bakiyesi ile
// yönetilir. Ancak modüllere/hub'a girebilmek için önce Google/Apple ile
// giriş yapılmış olması ZORUNLUDUR (bkz. onboarding _AuthOnboardingScreen).
// `signInProvider` artık gerçek Firebase Auth durumundan türetilir —
// SharedPreferences yalnızca soğuk başlangıçta anlık gösterim için bir
// önbellektir, kimliğin kendisi değildir.

class Entitlement {
  final String? signInProvider; // 'apple' | 'google' | null
  final bool consentGiven; // KVKK/GDPR açık rıza onayı

  const Entitlement({this.signInProvider, this.consentGiven = false});

  bool get isSignedIn => signInProvider != null;

  Entitlement copyWith({String? signInProvider, bool? consentGiven}) =>
      Entitlement(
        signInProvider: signInProvider ?? this.signInProvider,
        consentGiven: consentGiven ?? this.consentGiven,
      );
}

/// Firebase Auth `providerId` değerini ('google.com'/'apple.com') UI'ın
/// kullandığı kısa forma ('google'/'apple') çevirir.
String? _shortProviderFrom(fb_auth.User? user) {
  if (user == null || user.isAnonymous) return null;
  for (final p in user.providerData) {
    if (p.providerId == 'google.com') return 'google';
    if (p.providerId == 'apple.com') return 'apple';
  }
  return null;
}

final entitlementProvider =
    StateNotifierProvider<EntitlementNotifier, Entitlement>(
        (ref) => EntitlementNotifier(ref));

class EntitlementNotifier extends StateNotifier<Entitlement> {
  final Ref ref;
  StreamSubscription<fb_auth.User?>? _authSub;

  EntitlementNotifier(this.ref) : super(const Entitlement()) {
    _load();
    _authSub = ref
        .read(authServiceProvider)
        .authStateChanges()
        .listen(_onAuthChanged);
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    // Soğuk başlangıç: prefs'teki önbellek + varsa anlık gerçek Auth durumu.
    final cached = prefs.getString(DatingKeys.signedInProvider);
    final real = _shortProviderFrom(ref.read(authServiceProvider).currentUser);
    state = Entitlement(
      signInProvider: real ?? cached,
      consentGiven: prefs.getBool(DatingKeys.consentGiven) ?? false,
    );
  }

  Future<void> _onAuthChanged(fb_auth.User? user) async {
    final provider = _shortProviderFrom(user);
    state = state.copyWith(signInProvider: provider);
    final prefs = await SharedPreferences.getInstance();
    if (provider != null) {
      await prefs.setString(DatingKeys.signedInProvider, provider);
    } else {
      await prefs.remove(DatingKeys.signedInProvider);
    }
  }

  /// KVKK/GDPR açık rıza onayı — girişten önce alınır ve kalıcı saklanır.
  Future<void> giveConsent() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(DatingKeys.consentGiven, true);
    state = state.copyWith(consentGiven: true);
  }

  /// Hesapla giriş (Apple/Google) — sisteme girebilmek için ZORUNLU.
  /// Gerçek Firebase Auth SDK çağrısını yapar; başarısız/iptal olursa
  /// `state.signInProvider` değişmeden kalır (çağıran taraf bunu kontrol
  /// ederek hata göstermelidir).
  Future<void> signIn(String provider) async {
    final auth = ref.read(authServiceProvider);
    final user = provider == 'apple'
        ? await auth.linkWithApple()
        : await auth.linkWithGoogle();
    if (user != null) {
      // authStateChanges zaten tetiklenecek, ama anında yansıması için
      // burada da state'i güncelliyoruz.
      await _onAuthChanged(user);
    }
  }

  /// Önceki satın alımları/oturumu geri yükler: gerçek Auth durumunu ve
  /// mağaza satın alımlarını (DatingPurchaseService.restore) tazeler.
  Future<void> restore() async {
    await _onAuthChanged(ref.read(authServiceProvider).currentUser);
  }

  /// Hesabı ve verileri sil (KVKK/GDPR — Bölüm 9). Gerçek silme işlemi
  /// Cloud Function üzerinden Admin SDK ile yapılır (client tarafı
  /// `user.delete()` "requires-recent-login" ile başarısız olabileceği
  /// için silme her zaman güvenilir çalışsın diye sunucuya taşındı).
  Future<void> deleteAccount() async {
    final uid = ref.read(authServiceProvider).uid;
    if (uid != null) {
      try {
        await FirebaseFunctions.instanceFor(region: 'europe-west1')
            .httpsCallable('deleteAccount')
            .call();
      } catch (_) {
        // Sunucu silme başarısız olsa bile yerelde çıkış yapılır; kullanıcı
        // tekrar denediğinde aynı hesaba (varsa) düşer.
      }
    }
    await ref.read(authServiceProvider).signOut();

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(DatingKeys.signedInProvider);
    await prefs.remove(DatingKeys.credits);
    await prefs.remove(DatingKeys.answers);
    await prefs.remove(DatingKeys.consentGiven);
    await prefs.remove(DatingKeys.packPhotoBalance);
    await prefs.remove(DatingKeys.packAnalysisBalance);
    state = const Entitlement();
    ref.read(creditsProvider.notifier).reset();
    ref.read(packBalanceProvider.notifier).reset();
  }

  @override
  void dispose() {
    _authSub?.cancel();
    super.dispose();
  }
}

// ============================================================
// KREDİ HAVUZU (Bölüm 6.9)
// ============================================================

final creditsProvider =
    StateNotifierProvider<CreditsNotifier, int>((ref) => CreditsNotifier());

class CreditsNotifier extends StateNotifier<int> {
  CreditsNotifier() : super(0) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    state = prefs.getInt(DatingKeys.credits) ?? 0;
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(DatingKeys.credits, state);
  }

  Future<void> refill(int amount) async {
    state = amount; // devretmez — her dönem sıfırlanıp yüklenir
    await _persist();
  }

  bool canAfford(int cost) => state >= cost;

  /// Krediyi düşer; yetersizse false döner (işlem yapılmaz).
  Future<bool> spend(int cost) async {
    if (state < cost) return false;
    state = state - cost;
    await _persist();
    return true;
  }

  Future<void> reset() async {
    state = 0;
    await _persist();
  }
}

// ============================================================
// ERİŞİM: her modüle her zaman girilebilir. Üretim/analiz çalışır; sonuç
// ekranında yalnızca İLK ÇIKTI (DatingConfig.freePreviewCount) açık gösterilir,
// kalanı paket bakiyesi düşülerek açılır (bkz. module_flows sonuç ekranları).
//
// Bakiyenin GERÇEK kaynağı artık Firestore'daki `users/{uid}/private/wallet`
// dokümanıdır (yalnızca Cloud Functions tarafından, satın alma doğrulaması
// veya AI üretim işi sonrası yazılır — bkz. firestore.rules). SharedPreferences
// yalnızca çevrimdışı/soğuk-başlangıç önbelleği olarak kalır.
// ============================================================

/// Tek seferlik paketlerle satın alınan bakiye.
class PackBalance {
  final int photo;
  final int analysis;
  const PackBalance({this.photo = 0, this.analysis = 0});
  PackBalance copyWith({int? photo, int? analysis}) =>
      PackBalance(photo: photo ?? this.photo, analysis: analysis ?? this.analysis);
}

final packBalanceProvider =
    StateNotifierProvider<PackBalanceNotifier, PackBalance>(
        (ref) => PackBalanceNotifier(ref));

class PackBalanceNotifier extends StateNotifier<PackBalance> {
  final Ref ref;
  StreamSubscription<fb_auth.User?>? _authSub;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _walletSub;

  PackBalanceNotifier(this.ref) : super(const PackBalance()) {
    _load();
    // Kullanıcı değiştikçe (anonim → Google/Apple) doğru cüzdana yeniden bağlan.
    _authSub = ref
        .read(authServiceProvider)
        .authStateChanges()
        .listen((user) => _subscribeWallet(user?.uid));
    _subscribeWallet(ref.read(authServiceProvider).uid);
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    state = PackBalance(
      photo: prefs.getInt(DatingKeys.packPhotoBalance) ?? 0,
      analysis: prefs.getInt(DatingKeys.packAnalysisBalance) ?? 0,
    );
  }

  void _subscribeWallet(String? uid) {
    _walletSub?.cancel();
    if (uid == null) return;
    _walletSub = FirebaseFirestore.instance
        .doc('users/$uid/private/wallet')
        .snapshots()
        .listen((snap) {
      final data = snap.data();
      if (data == null) return;
      state = PackBalance(
        photo: (data['photoBalance'] as num?)?.toInt() ?? 0,
        analysis: (data['analysisBalance'] as num?)?.toInt() ?? 0,
      );
      _persist();
    });
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(DatingKeys.packPhotoBalance, state.photo);
    await prefs.setInt(DatingKeys.packAnalysisBalance, state.analysis);
  }

  /// Foto üretim bakiyesinden en fazla [want] "set/stil" düşer (iyimser,
  /// yalnızca YEREL önbellek/UI için — gerçek harcama yetkisi ve düşüm
  /// `startPhotoGeneration` Cloud Function'ında sunucu tarafında yapılır;
  /// Firestore wallet dinleyicisi bu değeri kısa süre sonra gerçek değerle
  /// ezer). Bakiye yetersizse olabildiğince düşüp gerçekte düşülen miktarı
  /// döner.
  Future<int> spendPhoto(int want) async {
    final spend = want < state.photo ? want : state.photo;
    if (spend <= 0) return 0;
    state = state.copyWith(photo: state.photo - spend);
    await _persist();
    return spend;
  }

  /// Analiz bakiyesinden en fazla [want] hak düşer (iyimser yerel önbellek —
  /// bkz. [spendPhoto] açıklaması).
  Future<int> spendAnalysis(int want) async {
    final spend = want < state.analysis ? want : state.analysis;
    if (spend <= 0) return 0;
    state = state.copyWith(analysis: state.analysis - spend);
    await _persist();
    return spend;
  }

  Future<void> reset() async {
    state = const PackBalance();
    await _persist();
  }

  @override
  void dispose() {
    _authSub?.cancel();
    _walletSub?.cancel();
    super.dispose();
  }
}

// ============================================================
// ONBOARDING TAMAMLANDI DURUMU
// ============================================================

final datingOnboardingDoneProvider =
    FutureProvider<bool>((ref) async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getBool(DatingKeys.onboardingDone) ?? false;
});

Future<void> markDatingOnboardingDone() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setBool(DatingKeys.onboardingDone, true);
}
