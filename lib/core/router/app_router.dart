import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../presentation/dating/splash/voxen_splash_screen.dart';
import '../../presentation/dating/onboarding/onboarding_flow.dart';
import '../../presentation/dating/modules/modules_showcase.dart';
import '../../presentation/dating/modules/module_hub.dart';
import '../../presentation/dating/modules/module_screen.dart';
import '../../presentation/dating/modules/model_bakeoff_screen.dart';
import '../../presentation/dating/paywall/paywall_screen.dart';
import '../../presentation/dating/paywall/login_screen.dart';
import '../../presentation/dating/settings/dating_settings_screen.dart';
import 'dating_routes.dart';

// ============================================================
// DATING ASİSTANI ROUTER (README Build Spesifikasyonu)
//
// Akış (Bölüm 7): onboarding funnel (girişsiz) → modül vitrini (girişsiz)
// → paywall → giriş (Apple/Google) → ödeme → hub (6 modül) → modül ekranları.
//
// NOT: Eski Rise Up looksmaxxing ekranları (survey, tasks, social, addiction,
// analysis, home, trial...) pivot nedeniyle router'dan çıkarıldı. Dosyalar
// projede duruyor ama artık yönlendirilmiyor.
// ============================================================

/// Geriye dönük uyumluluk için eski sabitler (bazı eski ekranlar hâlâ
/// referans ediyor olabilir). Aktif akışta DatingRoutes kullanılır.
class AppRoutes {
  AppRoutes._();
  static const String splash = '/';
  static const String survey = '/survey';
  static const String onboarding = '/onboarding';
  static const String trial = '/trial';
  static const String home = '/home';
  static const String analysis = '/analysis';
  static const String faceResult = '/analysis/face';
  static const String bodyResult = '/analysis/body';
  static const String tasks = '/tasks';
  static const String addiction = '/addiction';
  static const String social = '/social';
  static const String paywall = '/paywall';
  static const String settings = '/settings';
  static const String progress = '/progress';
}

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: DatingRoutes.splash,
    debugLogDiagnostics: false,
    routes: [
      // Açılış ekranı (logo) — onboarding durumuna göre yönlendirir
      GoRoute(
        path: DatingRoutes.splash,
        builder: (c, s) => const VoxenSplashScreen(),
      ),
      // Onboarding funnel (girişsiz)
      GoRoute(
        path: DatingRoutes.onboarding,
        builder: (c, s) => const OnboardingFlow(),
      ),
      // Modül vitrini (girişsiz gezilir)
      GoRoute(
        path: DatingRoutes.modules,
        builder: (c, s) => const ModulesShowcaseScreen(),
      ),
      // Paywall
      GoRoute(
        path: DatingRoutes.paywall,
        builder: (c, s) => PaywallScreen(
          mode: paywallModeFromQuery(s.uri.queryParameters['mode']),
        ),
      ),
      // Giriş (abonelik anında) — ?plan=... veya ?restore=1
      GoRoute(
        path: DatingRoutes.login,
        builder: (c, s) => LoginScreen(
          plan: s.uri.queryParameters['plan'] ?? 'monthly',
          restore: s.uri.queryParameters['restore'] == '1',
          // trial=0 → denemeyi atla, doğrudan abone ol. Varsayılan: deneme.
          trial: s.uri.queryParameters['trial'] != '0',
        ),
      ),
      // Giriş sonrası modül merkezi
      GoRoute(
        path: DatingRoutes.hub,
        builder: (c, s) => const ModuleHubScreen(),
      ),
      // Modül ekranı — /module/:id
      GoRoute(
        path: '${DatingRoutes.module}/:id',
        builder: (c, s) =>
            ModuleScreen(moduleId: s.pathParameters['id'] ?? 'ai_photo'),
      ),
      // Ayarlar & gizlilik
      GoRoute(
        path: DatingRoutes.settings,
        builder: (c, s) => const DatingSettingsScreen(),
      ),
      // GEÇİCİ geliştirici aracı — model A/B karşılaştırması (test bitince sil)
      GoRoute(
        path: DatingRoutes.modelBakeoff,
        builder: (c, s) => const ModelBakeoffScreen(),
      ),
    ],
  );
});
