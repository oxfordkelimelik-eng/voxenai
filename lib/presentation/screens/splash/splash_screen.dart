import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/router/app_router.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );
    _controller.forward();
    _navigate();
  }

  Future<void> _navigate() async {
    await Future.delayed(const Duration(milliseconds: 2500));
    if (!mounted) return;

    final prefs = await SharedPreferences.getInstance();

    // 1. Anket yapılmadıysa → Anket
    final surveyDone = prefs.getBool(StorageKeys.surveyDone) ?? false;
    if (!mounted) return;
    if (!surveyDone) {
      context.go(AppRoutes.survey);
      return;
    }

    // 2. Pro üye → Direkt ana sayfa
    final isPro = prefs.getBool(StorageKeys.isPro) ?? false;
    if (isPro) {
      context.go(AppRoutes.home);
      return;
    }

    // 3. Deneme süresi kontrolü
    final trialStartStr = prefs.getString(StorageKeys.trialStartDate);
    if (trialStartStr == null) {
      // Deneme başlamamış (olmaması lazım, anket yaparken başlatılıyor)
      context.go(AppRoutes.trial);
      return;
    }
    final startDate = DateTime.parse(trialStartStr);
    final daysPassed = DateTime.now().difference(startDate).inDays;
    if (daysPassed >= 3) {
      // Deneme doldu → Abonelik ekranı
      context.go(AppRoutes.trial);
    } else {
      // Deneme aktif → Ana sayfa
      context.go(AppRoutes.home);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Logo simgesi
            Container(
                  width: 100,
                  height: 100,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: AppColors.goldGradient,
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.goldGlow,
                        blurRadius: 40,
                        spreadRadius: 10,
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.arrow_upward_rounded,
                    color: AppColors.textOnGold,
                    size: 52,
                  ),
                )
                .animate()
                .scale(
                  begin: const Offset(0.5, 0.5),
                  end: const Offset(1.0, 1.0),
                  curve: Curves.elasticOut,
                  duration: 1000.ms,
                )
                .fadeIn(duration: 600.ms),

            const SizedBox(height: 24),

            // RISE UP metni
            ShaderMask(
                  shaderCallback: (bounds) =>
                      AppColors.goldGradient.createShader(bounds),
                  child: const Text(
                    'RISE UP',
                    style: TextStyle(
                      fontSize: 48,
                      fontWeight: FontWeight.w900,
                      color: Colors.white,
                      letterSpacing: 8,
                    ),
                  ),
                )
                .animate(delay: 400.ms)
                .slideY(begin: 0.3, end: 0, curve: Curves.easeOut)
                .fadeIn(duration: 600.ms),

            const SizedBox(height: 8),

            Text(
              'POTANSİYELİNİ İNŞA ET',
              style: TextStyle(
                fontSize: 13,
                color: AppColors.textSecondary,
                letterSpacing: 4,
                fontWeight: FontWeight.w500,
              ),
            ).animate(delay: 700.ms).fadeIn(duration: 600.ms),

            const SizedBox(height: 80),

            // Yükleme noktaları
            SizedBox(
              width: 60,
              child: LinearProgressIndicator(
                backgroundColor: AppColors.borderSubtle,
                valueColor: const AlwaysStoppedAnimation(AppColors.gold),
                borderRadius: BorderRadius.circular(4),
                minHeight: 2,
              ),
            ).animate(delay: 1000.ms).fadeIn(duration: 400.ms),
          ],
        ),
      ),
    );
  }
}
