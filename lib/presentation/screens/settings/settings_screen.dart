import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/router/app_router.dart';
import '../../providers/app_providers.dart';
import '../../providers/tasks_provider.dart';
import '../../providers/addiction_provider.dart';
import '../../providers/progress_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProfileProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('AYARLAR')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Profil kartı
          _ProfileCard(user: user),
          const SizedBox(height: 20),

          // Yapay zeka (anahtar gerektirmez — sunucu tarafında yönetilir)
          _SettingsSection(
            title: 'YAPAY ZEKA',
            children: [
              _SettingsTile(
                icon: Icons.auto_awesome_rounded,
                title: 'AI Analizi',
                subtitle: 'Hazır — kurulum gerekmez',
                trailingIcon: null,
              ),
              _SettingsTile(
                icon: Icons.model_training_rounded,
                title: 'AI Modeli',
                subtitle: ApiConfig.geminiModel,
                trailingIcon: null,
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Profil Düzenleme
          _SettingsSection(
            title: 'PROFİL',
            children: [
              _SettingsTile(
                icon: Icons.person_rounded,
                title: 'İsim',
                subtitle: user?.name ?? 'Kullanıcı',
                trailingIcon: Icons.edit_rounded,
                onTap: () {},
              ),
              _SettingsTile(
                icon: Icons.straighten_rounded,
                title: 'Boy / Kilo',
                subtitle:
                    '${user?.heightCm.toInt()}cm / ${user?.weightKg.toInt()}kg',
                trailingIcon: Icons.edit_rounded,
                onTap: () {},
              ),
              _SettingsTile(
                icon: Icons.shield_rounded,
                title: 'Bağımlılık Takibi',
                subtitle: 'Temiz gün sayaçlarını yönet',
                trailingIcon: Icons.chevron_right_rounded,
                onTap: () => context.push('/addiction'),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Abonelik
          _SettingsSection(
            title: 'ABONELİK',
            children: [
              _SettingsTile(
                icon: user?.isPro == true
                    ? Icons.workspace_premium_rounded
                    : Icons.lock_outline_rounded,
                title: user?.isPro == true ? 'Rise Up PRO' : 'Ücretsiz Plan',
                subtitle: user?.isPro == true
                    ? 'Tüm özelliklere erişiyorsunuz'
                    : 'Pro\'ya geç ve tüm özellikleri aç',
                trailingIcon: Icons.chevron_right_rounded,
                iconColor: user?.isPro == true ? AppColors.gold : null,
                onTap: () => context.push('/paywall'),
              ),
              if (user?.isPro == true)
                _SettingsTile(
                  icon: Icons.cancel_outlined,
                  title: 'Pro\'yu İptal Et (Test)',
                  subtitle: 'Sadece test için',
                  trailingIcon: null,
                  iconColor: AppColors.error,
                  onTap: () {
                    ref.read(userProfileProvider.notifier).setPro(false);
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),

          // Uygulama
          _SettingsSection(
            title: 'UYGULAMA',
            children: [
              _SettingsTile(
                icon: Icons.info_outline_rounded,
                title: 'Versiyon',
                subtitle: 'Rise Up v1.0.0',
                trailingIcon: null,
              ),
              _SettingsTile(
                icon: Icons.privacy_tip_outlined,
                title: 'Gizlilik Politikası',
                trailingIcon: Icons.open_in_new_rounded,
                onTap: () {},
              ),
              _SettingsTile(
                icon: Icons.delete_outline_rounded,
                title: 'Tüm Verileri Sıfırla',
                subtitle: 'XP, streak ve analizler silinir',
                trailingIcon: Icons.chevron_right_rounded,
                iconColor: AppColors.error,
                onTap: () => _showResetDialog(context, ref),
              ),
            ],
          ),

          const SizedBox(height: 80),
        ],
      ),
    );
  }

  void _showResetDialog(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        title: const Text(
          'Verileri Sıfırla',
          style: TextStyle(color: AppColors.error),
        ),
        content: const Text(
          'Tüm XP, streak, analiz geçmişin ve doldurduğun form silinecek. '
          'Uygulama en baştan (anket ekranından) başlayacak. Bu geri alınamaz.',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text(
              'İptal',
              style: TextStyle(color: AppColors.textMuted),
            ),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () async {
              Navigator.pop(ctx);
              await _resetAllProgress(context, ref);
            },
            child: const Text('Sıfırla'),
          ),
        ],
      ),
    );
  }

  Future<void> _resetAllProgress(BuildContext context, WidgetRef ref) async {
    await ref.read(taskHistoryProvider.notifier).clear();
    await ref.read(addictionProvider.notifier).clear();
    await ref.read(progressProvider.notifier).clear();
    await ref.read(intakeProvider.notifier).clear();
    await ref.read(trialProvider.notifier).clear();
    await ref.read(userProfileProvider.notifier).resetProgress();
    ref.invalidate(faceAnalysisProvider);
    ref.invalidate(bodyAnalysisProvider);
    ref.invalidate(tasksProvider);

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.surveyDone);
    await prefs.remove(StorageKeys.onboardingDone);
    await prefs.remove(StorageKeys.surveyAnswers);
    await prefs.remove(StorageKeys.facePhotoPath);
    await prefs.remove(StorageKeys.bodyPhotoPath);
    await prefs.remove(StorageKeys.macroGoals);
    ref.invalidate(onboardingDoneProvider);

    await pushSyncW(ref);

    if (context.mounted) context.go(AppRoutes.survey);
  }
}

class _ProfileCard extends StatelessWidget {
  final dynamic user;
  const _ProfileCard({required this.user});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: AppColors.goldGradient,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: [
          Container(
            width: 60,
            height: 60,
            decoration: BoxDecoration(
              color: AppColors.textOnGold.withValues(alpha: 0.2),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.person_rounded,
              color: AppColors.textOnGold,
              size: 32,
            ),
          ),
          const SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                user?.name ?? 'Kullanıcı',
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textOnGold,
                ),
              ),
              Text(
                'Seviye ${user?.level ?? 1}  •  ${user?.totalXp ?? 0} XP',
                style: TextStyle(
                  fontSize: 13,
                  color: AppColors.textOnGold.withValues(alpha: 0.8),
                ),
              ),
              Text(
                user?.isPro == true ? '👑 PRO ÜYE' : '🔒 ÜCRETSİZ',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textOnGold.withValues(alpha: 0.9),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SettingsSection extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _SettingsSection({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: AppColors.textMuted,
            letterSpacing: 1.5,
          ),
        ),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.borderSubtle, width: 0.5),
          ),
          child: Column(children: children),
        ),
      ],
    );
  }
}

class _SettingsTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final IconData? trailingIcon;
  final Color? iconColor;
  final VoidCallback? onTap;

  const _SettingsTile({
    required this.icon,
    required this.title,
    this.subtitle,
    required this.trailingIcon,
    this.iconColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(
        icon,
        color: iconColor ?? AppColors.textSecondary,
        size: 22,
      ),
      title: Text(
        title,
        style: const TextStyle(
          color: AppColors.textPrimary,
          fontSize: 14,
          fontWeight: FontWeight.w500,
        ),
      ),
      subtitle: subtitle != null
          ? Text(
              subtitle!,
              style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
            )
          : null,
      trailing: trailingIcon != null
          ? Icon(trailingIcon, color: AppColors.textMuted, size: 18)
          : null,
      onTap: onTap,
    );
  }
}
