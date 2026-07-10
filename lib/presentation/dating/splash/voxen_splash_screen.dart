import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';

/// Uygulama açılış (splash) ekranı — ortada VOXEN AI logosu.
/// Kısa bir gösterimden sonra: onboarding tamamlandıysa hub'a, değilse
/// onboarding funnel'ına yönlendirir.
class VoxenSplashScreen extends ConsumerStatefulWidget {
  const VoxenSplashScreen({super.key});

  @override
  ConsumerState<VoxenSplashScreen> createState() => _VoxenSplashScreenState();
}

class _VoxenSplashScreenState extends ConsumerState<VoxenSplashScreen> {
  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    // Onboarding + giriş durumunu doğrudan storage'dan oku (provider'ların
    // async ilk yüklemesini beklemeye gerek kalmadan, tutarlı sonuç için)
    // + logoyu en az ~1.6 sn göster.
    final results = await Future.wait([
      SharedPreferences.getInstance(),
      Future.delayed(const Duration(milliseconds: 1600)),
    ]);
    if (!mounted) return;
    final prefs = results[0] as SharedPreferences;
    final done = prefs.getBool(DatingKeys.onboardingDone) ?? false;
    // Giriş yapılmadan hub'a geçilemez — onboarding bitmiş ama bir şekilde
    // giriş yoksa (ör. hesap silindiyse) yine onboarding'e (auth adımına)
    // yönlendirilir.
    final signedIn = prefs.getString(DatingKeys.signedInProvider) != null;
    context.go(
        (done && signedIn) ? DatingRoutes.hub : DatingRoutes.onboarding);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
              'assets/images/logo.png',
              width: MediaQuery.of(context).size.width * 0.62,
              fit: BoxFit.contain,
              filterQuality: FilterQuality.high,
              // Görsel yoksa çökme yok — metin logoya düş.
              errorBuilder: (_, _, _) => const _TextLogo(),
            )
                .animate()
                .fadeIn(duration: 600.ms)
                .scale(
                  begin: const Offset(0.86, 0.86),
                  end: const Offset(1, 1),
                  duration: 700.ms,
                  curve: Curves.easeOutBack,
                ),
            const SizedBox(height: 28),
            const SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(
                  strokeWidth: 2.5, color: AppColors.gold),
            ).animate().fadeIn(delay: 500.ms, duration: 500.ms),
          ],
        ),
      ),
    );
  }
}

/// Görsel yüklenemezse gösterilecek metin logosu.
class _TextLogo extends StatelessWidget {
  const _TextLogo();
  @override
  Widget build(BuildContext context) {
    return RichText(
      text: const TextSpan(
        style: TextStyle(
            fontSize: 40, fontWeight: FontWeight.w900, letterSpacing: 3),
        children: [
          TextSpan(
              text: 'VOXEN ',
              style: TextStyle(color: AppColors.textPrimary)),
          TextSpan(text: 'AI', style: TextStyle(color: AppColors.gold)),
        ],
      ),
    );
  }
}
