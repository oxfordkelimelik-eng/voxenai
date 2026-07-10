import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_strings.dart';
import '../../../core/router/app_router.dart';
import '../../../core/constants/app_constants.dart';

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentPage = 0;

  final List<_OnboardingPage> _pages = [
    _OnboardingPage(
      icon: Icons.face_retouching_natural,
      title: AppStrings.onboarding1Title,
      description: AppStrings.onboarding1Desc,
      gradient: const LinearGradient(
        colors: [Color(0xFF1A0A2E), Color(0xFF0A0A0A)],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ),
      accentColor: AppColors.gold,
    ),
    _OnboardingPage(
      icon: Icons.local_fire_department_rounded,
      title: AppStrings.onboarding2Title,
      description: AppStrings.onboarding2Desc,
      gradient: const LinearGradient(
        colors: [Color(0xFF1A0A0A), Color(0xFF0A0A0A)],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ),
      accentColor: AppColors.physical,
    ),
    _OnboardingPage(
      icon: Icons.psychology_rounded,
      title: AppStrings.onboarding3Title,
      description: AppStrings.onboarding3Desc,
      gradient: const LinearGradient(
        colors: [Color(0xFF0A1A0A), Color(0xFF0A0A0A)],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ),
      accentColor: AppColors.social,
    ),
  ];

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _nextPage() {
    if (_currentPage < _pages.length - 1) {
      _pageController.nextPage(
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeInOut,
      );
    } else {
      _finish();
    }
  }

  Future<void> _finish() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(StorageKeys.onboardingDone, true);
    if (!mounted) return;
    context.go(AppRoutes.home);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: [
          // Sayfa içerikleri
          PageView.builder(
            controller: _pageController,
            onPageChanged: (i) => setState(() => _currentPage = i),
            itemCount: _pages.length,
            itemBuilder: (context, index) {
              return _OnboardingPageView(page: _pages[index]);
            },
          ),

          // Alt navigasyon
          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    AppColors.background.withValues(alpha: 0),
                    AppColors.background,
                  ],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
              ),
              child: Column(
                children: [
                  // Nokta indikatörler
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(
                      _pages.length,
                      (i) => AnimatedContainer(
                        duration: const Duration(milliseconds: 300),
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        width: i == _currentPage ? 24 : 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: i == _currentPage
                              ? AppColors.gold
                              : AppColors.borderSubtle,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                  ),

                  const SizedBox(height: 24),

                  // İleri / Başla butonu
                  ElevatedButton(
                    onPressed: _nextPage,
                    child: Text(
                      _currentPage == _pages.length - 1
                          ? AppStrings.getStarted
                          : AppStrings.continueText,
                    ),
                  ),

                  const SizedBox(height: 12),

                  // Atla linki
                  if (_currentPage < _pages.length - 1)
                    TextButton(
                      onPressed: _finish,
                      child: Text(
                        AppStrings.skip,
                        style: TextStyle(
                          color: AppColors.textMuted,
                          fontSize: 14,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OnboardingPageView extends StatelessWidget {
  final _OnboardingPage page;

  const _OnboardingPageView({required this.page});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(gradient: page.gradient),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox(height: 60),
              // İkon
              Container(
                    width: 120,
                    height: 120,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: page.accentColor.withValues(alpha: 0.15),
                      border: Border.all(
                        color: page.accentColor.withValues(alpha: 0.3),
                        width: 1.5,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: page.accentColor.withValues(alpha: 0.2),
                          blurRadius: 40,
                          spreadRadius: 10,
                        ),
                      ],
                    ),
                    child: Icon(page.icon, size: 56, color: page.accentColor),
                  )
                  .animate()
                  .scale(
                    begin: const Offset(0.8, 0.8),
                    curve: Curves.elasticOut,
                    duration: 800.ms,
                  )
                  .fadeIn(),

              const SizedBox(height: 48),

              Text(
                    page.title,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w900,
                      color: AppColors.textPrimary,
                      letterSpacing: 0.5,
                      height: 1.2,
                    ),
                  )
                  .animate(delay: 200.ms)
                  .slideY(begin: 0.2, end: 0)
                  .fadeIn(duration: 500.ms),

              const SizedBox(height: 20),

              Text(
                    page.description,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 16,
                      color: AppColors.textSecondary,
                      height: 1.6,
                    ),
                  )
                  .animate(delay: 400.ms)
                  .slideY(begin: 0.2, end: 0)
                  .fadeIn(duration: 500.ms),

              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }
}

class _OnboardingPage {
  final IconData icon;
  final String title;
  final String description;
  final LinearGradient gradient;
  final Color accentColor;

  const _OnboardingPage({
    required this.icon,
    required this.title,
    required this.description,
    required this.gradient,
    required this.accentColor,
  });
}

