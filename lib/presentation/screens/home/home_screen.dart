import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_strings.dart';
import '../../../core/router/app_router.dart';
import '../../providers/app_providers.dart';
// --- AI Dating Foto pivotu: görev / bağımlılık sağlayıcıları devre dışı ---
// import '../../providers/tasks_provider.dart';
// import '../../providers/addiction_provider.dart';
import '../../widgets/home/streak_widget.dart';
import '../../widgets/home/xp_bar_widget.dart';

/// Ana sayfa = kişisel pano (dashboard). Görev YOK, makro YOK.
/// Sadece kullanıcının kendi bilgileri: seviye, streak, skorlar, bağımlılık
/// sayaçları, günlük ilerleme özeti.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});
  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  // --- AI Dating Foto pivotu: alt menü (görevler/sosyal/bağımlılık) kaldırıldı;
  // tek sekme kaldığı için BottomNavigationBar tamamen devre dışı bırakıldı. ---
  // int _selectedTab = 0;
  // void _onTabTap(int i) {
  //   setState(() => _selectedTab = 0);
  // }

  @override
  Widget build(BuildContext context) {
    // Sert duvar: deneme dolduysa (ve Pro değilse) uygulama açıkken bile
    // ödeme ekranına zorla — geri kalan içerik gösterilmez.
    ref.listen(trialStatusProvider, (prev, next) {
      if (next == TrialStatus.expired && !ref.read(isProProvider)) {
        context.go(AppRoutes.trial);
      }
    });
    final trialExpired = ref.watch(trialStatusProvider) == TrialStatus.expired &&
        !ref.watch(isProProvider);
    if (trialExpired) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) context.go(AppRoutes.trial);
      });
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: Center(child: CircularProgressIndicator(color: AppColors.gold)),
      );
    }

    return Scaffold(
      backgroundColor: AppColors.background,
      body: const _DashboardTab(),
      // --- AI Dating Foto pivotu: alt menü kaldırıldı ---
      // bottomNavigationBar: _buildBottomNav(),
      floatingActionButton: _buildAnalysisFab(),
    );
  }

  /* --- AI Dating Foto pivotu: alt menü tamamen devre dışı ---
  Widget _buildBottomNav() {
    return Container(
      decoration: const BoxDecoration(
          border: Border(
              top: BorderSide(color: AppColors.borderSubtle, width: 0.5))),
      child: BottomNavigationBar(
        currentIndex: _selectedTab,
        onTap: _onTabTap,
        backgroundColor: AppColors.surface,
        selectedItemColor: AppColors.gold,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        selectedFontSize: 11,
        unselectedFontSize: 11,
        items: const [
          BottomNavigationBarItem(
              icon: Icon(Icons.home_rounded), label: 'Ana Sayfa'),
          BottomNavigationBarItem(
              icon: Icon(Icons.checklist_rounded), label: 'Görevler'),
          BottomNavigationBarItem(
              icon: Icon(Icons.psychology_rounded), label: 'Sosyal'),
          BottomNavigationBarItem(
              icon: Icon(Icons.shield_rounded), label: 'Bağımlılık'),
        ],
      ),
    );
  }
  --- AI Dating Foto pivotu sonu --- */

  Widget _buildAnalysisFab() {
    return FloatingActionButton.extended(
      onPressed: () => context.push(AppRoutes.analysis),
      backgroundColor: AppColors.gold,
      foregroundColor: AppColors.textOnGold,
      icon: const Icon(Icons.camera_alt_rounded),
      label: const Text('ANALİZ',
          style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.5)),
      elevation: 8,
    );
  }
}

class _DashboardTab extends ConsumerWidget {
  const _DashboardTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProfileProvider);
    // --- AI Dating Foto pivotu: görev / bağımlılık verileri devre dışı ---
    // final tasks = ref.watch(tasksProvider).value ?? [];
    // final addictions = ref.watch(addictionProvider);
    // final completed = tasks.where((t) => t.isCompleted).length;
    // final total = tasks.length;

    return CustomScrollView(
      slivers: [
        SliverAppBar(
          expandedHeight: 120,
          floating: true,
          pinned: false,
          backgroundColor: AppColors.background,
          flexibleSpace:
              FlexibleSpaceBar(background: _buildHeader(context, user)),
          actions: [
            IconButton(
              icon: const Icon(Icons.insights_rounded,
                  color: AppColors.textSecondary),
              onPressed: () => context.push(AppRoutes.progress),
              tooltip: 'Gelişimim',
            ),
            IconButton(
              icon: const Icon(Icons.settings_rounded,
                  color: AppColors.textSecondary),
              onPressed: () => context.push(AppRoutes.settings),
            ),
          ],
        ),

        // Deneme geri sayımı (Pro değilse ve deneme aktifse)
        if (!(user?.isPro ?? false) &&
            ref.watch(trialStatusProvider) == TrialStatus.active)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: _TrialCountdownBanner(
                daysRemaining: ref.watch(trialDaysRemainingProvider),
                onTap: () => context.push(AppRoutes.trial),
              ),
            ),
          ),

        // XP + Streak
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: XpBarWidget(
                xp: user?.totalXp ?? 0,
                level: user?.level ?? 1,
                progress: user?.levelProgress ?? 0.0),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: StreakWidget(streak: user?.currentStreak ?? 0),
          ),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 16)),

        // --- AI Dating Foto pivotu: günlük görev özeti kartı devre dışı ---
        // SliverToBoxAdapter(
        //   child: Padding(
        //     padding: const EdgeInsets.symmetric(horizontal: 16),
        //     child: _DailySummaryCard(
        //       completed: completed,
        //       total: total,
        //       onTap: () => context.push(AppRoutes.tasks),
        //     ),
        //   ),
        // ),
        // const SliverToBoxAdapter(child: SizedBox(height: 16)),

        // Görünüş skorları
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: _sectionTitle('GÖRÜNÜŞ SKORLARI'),
          ),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 10)),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(
                  child: _ScoreCard(
                    label: 'Yüz',
                    score: user?.faceScore ?? -1,
                    icon: Icons.face_retouching_natural,
                    color: AppColors.gold,
                    onTap: () => context.push(
                        (user?.faceScore ?? -1) >= 0
                            ? AppRoutes.faceResult
                            : AppRoutes.analysis),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _ScoreCard(
                    label: 'Vücut',
                    score: user?.bodyScore ?? -1,
                    icon: Icons.accessibility_new_rounded,
                    color: AppColors.physical,
                    onTap: () => context.push(
                        (user?.bodyScore ?? -1) >= 0
                            ? AppRoutes.bodyResult
                            : AppRoutes.analysis),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 20)),

        // --- AI Dating Foto pivotu: bağımlılık sayaçları bölümü devre dışı ---
        // if (addictions.isNotEmpty) ...[
        //   SliverToBoxAdapter(
        //     child: Padding(
        //       padding: const EdgeInsets.symmetric(horizontal: 16),
        //       child: Row(
        //         children: [
        //           _sectionTitle('TEMİZ GÜN SAYAÇLARI'),
        //           const Spacer(),
        //           GestureDetector(
        //             onTap: () => context.push(AppRoutes.addiction),
        //             child: const Text('Tümü →',
        //                 style: TextStyle(
        //                     color: AppColors.gold,
        //                     fontSize: 12,
        //                     fontWeight: FontWeight.w700)),
        //           ),
        //         ],
        //       ),
        //     ),
        //   ),
        //   const SliverToBoxAdapter(child: SizedBox(height: 10)),
        //   SliverToBoxAdapter(
        //     child: SizedBox(
        //       height: 116,
        //       child: ListView.separated(
        //         scrollDirection: Axis.horizontal,
        //         padding: const EdgeInsets.symmetric(horizontal: 16),
        //         itemCount: addictions.length,
        //         separatorBuilder: (_, _) => const SizedBox(width: 10),
        //         itemBuilder: (_, i) {
        //           final a = addictions[i];
        //           return GestureDetector(
        //             onTap: () => context.push(AppRoutes.addiction),
        //             child: Container(
        //               width: 120,
        //               padding: const EdgeInsets.all(12),
        //               decoration: BoxDecoration(
        //                 color: AppColors.surfaceElevated,
        //                 borderRadius: BorderRadius.circular(16),
        //                 border:
        //                     Border.all(color: AppColors.borderGold, width: 0.5),
        //               ),
        //               child: Column(
        //                 crossAxisAlignment: CrossAxisAlignment.start,
        //                 mainAxisAlignment: MainAxisAlignment.spaceBetween,
        //                 children: [
        //                   Text(a.type.emoji,
        //                       style: const TextStyle(fontSize: 22)),
        //                   Text('${a.cleanDays} gün',
        //                       style: const TextStyle(
        //                           fontSize: 20,
        //                           fontWeight: FontWeight.w900,
        //                           color: AppColors.gold)),
        //                   Text(a.type.label,
        //                       maxLines: 1,
        //                       overflow: TextOverflow.ellipsis,
        //                       style: const TextStyle(
        //                           fontSize: 10,
        //                           color: AppColors.textSecondary)),
        //                 ],
        //               ),
        //             ),
        //           );
        //         },
        //       ),
        //     ),
        //   ),
        //   const SliverToBoxAdapter(child: SizedBox(height: 20)),
        // ],

        // --- AI Dating Foto pivotu: hızlı erişim (görev/sosyal/bağımlılık) devre dışı ---
        // SliverToBoxAdapter(
        //   child: Padding(
        //     padding: const EdgeInsets.symmetric(horizontal: 16),
        //     child: _sectionTitle('HIZLI ERİŞİM'),
        //   ),
        // ),
        // const SliverToBoxAdapter(child: SizedBox(height: 10)),
        // SliverToBoxAdapter(
        //   child: Padding(
        //     padding: const EdgeInsets.symmetric(horizontal: 16),
        //     child: Column(
        //       children: [
        //         _QuickRow(
        //             icon: Icons.checklist_rounded,
        //             label: 'Görevlerim',
        //             color: AppColors.physical,
        //             onTap: () => context.push(AppRoutes.tasks)),
        //         _QuickRow(
        //             icon: Icons.psychology_rounded,
        //             label: 'Sosyal Antrenman',
        //             color: AppColors.social,
        //             onTap: () => context.push(AppRoutes.social)),
        //         _QuickRow(
        //             icon: Icons.shield_rounded,
        //             label: 'Bağımlılık Takibi',
        //             color: AppColors.gold,
        //             onTap: () => context.push(AppRoutes.addiction)),
        //       ],
        //     ),
        //   ),
        // ),
        const SliverToBoxAdapter(child: SizedBox(height: 100)),
      ],
    );
  }

  Widget _sectionTitle(String text) => Text(
        text,
        style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w800,
            color: AppColors.textSecondary,
            letterSpacing: 1),
      );

  Widget _buildHeader(BuildContext context, dynamic user) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 56, 16, 12),
      child: Row(children: [
        Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Text('Merhaba, ${user?.name ?? 'Savaşçı'} 👋',
                  style: const TextStyle(
                      fontSize: 14, color: AppColors.textSecondary)),
              ShaderMask(
                shaderCallback: (b) => AppColors.goldGradient.createShader(b),
                child: const Text('VOXEN AI',
                    style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w900,
                        color: Colors.white,
                        letterSpacing: 4)),
              ),
            ]),
        const Spacer(),
        GestureDetector(
          onTap: () => context.push(AppRoutes.trial),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: user?.isPro == true
                  ? AppColors.goldSurface
                  : AppColors.surfaceElevated,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(
                  color: user?.isPro == true
                      ? AppColors.borderGold
                      : AppColors.borderSubtle),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(
                  user?.isPro == true
                      ? Icons.workspace_premium
                      : Icons.lock_outline,
                  size: 14,
                  color: user?.isPro == true
                      ? AppColors.gold
                      : AppColors.textMuted),
              const SizedBox(width: 4),
              Text(user?.isPro == true ? AppStrings.proMember : AppStrings.freeMember,
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: user?.isPro == true
                          ? AppColors.gold
                          : AppColors.textMuted,
                      letterSpacing: 1)),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _TrialCountdownBanner extends StatelessWidget {
  final int daysRemaining;
  final VoidCallback onTap;

  const _TrialCountdownBanner({
    required this.daysRemaining,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Son gün (1 veya 0) daha baskın kırmızı uyarı
    final urgent = daysRemaining <= 1;
    final accent = urgent ? AppColors.error : AppColors.gold;
    final message = urgent
        ? 'Deneme bugün bitiyor! Pro\'ya geçmezsen erişimin kapanacak.'
        : 'Ücretsiz denemende $daysRemaining gün kaldı. Sonra Pro gerekir.';

    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: accent.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: accent.withValues(alpha: 0.45)),
        ),
        child: Row(
          children: [
            Icon(urgent ? Icons.warning_amber_rounded : Icons.timer_rounded,
                color: accent, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                message,
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.35,
                  fontWeight: FontWeight.w700,
                  color: accent,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                urgent ? 'YÜKSELT' : '$daysRemaining GÜN',
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textOnGold,
                  letterSpacing: 0.5,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// --- AI Dating Foto pivotu: günlük görev özeti kartı kullanılmıyor ---
/*
class _DailySummaryCard extends StatelessWidget {
  final int completed;
  final int total;
  final VoidCallback onTap;

  const _DailySummaryCard({
    required this.completed,
    required this.total,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final progress = total == 0 ? 0.0 : completed / total;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
              colors: [AppColors.surfaceElevated, AppColors.surface]),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppColors.borderGold, width: 0.5),
        ),
        child: Row(
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('BUGÜNÜN İLERLEMESİ',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        color: AppColors.gold,
                        letterSpacing: 1)),
                const SizedBox(height: 4),
                Text('$completed / $total görev',
                    style: const TextStyle(
                        fontSize: 26,
                        fontWeight: FontWeight.w900,
                        color: AppColors.textPrimary,
                        height: 1.1)),
                const SizedBox(height: 2),
                const Text('Görevlerine git →',
                    style: TextStyle(
                        fontSize: 12, color: AppColors.textSecondary)),
              ],
            ),
            const Spacer(),
            SizedBox(
              width: 64,
              height: 64,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  CircularProgressIndicator(
                    value: progress,
                    strokeWidth: 6,
                    backgroundColor: AppColors.borderSubtle,
                    valueColor:
                        const AlwaysStoppedAnimation(AppColors.gold),
                  ),
                  Text('${(progress * 100).toInt()}%',
                      style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w900,
                          color: AppColors.textPrimary)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
*/

class _ScoreCard extends StatelessWidget {
  final String label;
  final int score;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  const _ScoreCard({
    required this.label,
    required this.score,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final analyzed = score >= 0;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: color, size: 20),
                const SizedBox(width: 6),
                Text(label,
                    style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textPrimary)),
              ],
            ),
            const SizedBox(height: 12),
            if (analyzed)
              Text('$score',
                  style: TextStyle(
                      fontSize: 36,
                      fontWeight: FontWeight.w900,
                      color: AppColors.scoreColor(score),
                      height: 1))
            else
              const Text('—',
                  style: TextStyle(
                      fontSize: 36,
                      fontWeight: FontWeight.w900,
                      color: AppColors.textMuted,
                      height: 1)),
            const SizedBox(height: 2),
            Text(analyzed ? 'puan · detay →' : 'Analiz et →',
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary)),
          ],
        ),
      ),
    );
  }
}

// --- AI Dating Foto pivotu: hızlı erişim satırı kullanılmıyor ---
/*
class _QuickRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _QuickRow({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.borderSubtle, width: 0.5),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 14),
            Text(label,
                style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary)),
            const Spacer(),
            const Icon(Icons.chevron_right_rounded,
                color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }
}
*/
