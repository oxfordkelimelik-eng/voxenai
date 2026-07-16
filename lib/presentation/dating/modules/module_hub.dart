import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/shared_widgets.dart';

/// Giriş/abonelik sonrası ana merkez (Bölüm 6). Alt menü: Modüller / Bize
/// Ulaşın / Ayarlar. 2 aktif modül + kredi bakiyesi.
class ModuleHubScreen extends ConsumerStatefulWidget {
  const ModuleHubScreen({super.key});
  @override
  ConsumerState<ModuleHubScreen> createState() => _ModuleHubScreenState();
}

class _ModuleHubScreenState extends ConsumerState<ModuleHubScreen> {
  int _tab = 0;

  /// Modüle her zaman girilebilir: ilk çıktı ekranda ücretsiz gösterilir,
  /// devamı için paket gerekiyorsa akış (module_flows) içinde paywall'a
  /// yönlendirilir.
  void _openModule(DatingModule m) {
    context.push('${DatingRoutes.module}/${m.id}');
  }

  /// Kart alt barında yalnızca durum ikonu için: bu modülün paket bakiyesi
  /// var mı? (Kart üzerinde artık yazı gösterilmez.)
  bool _hasPack(DatingModule m) {
    final pack = ref.watch(packBalanceProvider);
    return m.id == 'ai_photo' ? pack.photo > 0 : pack.analysis > 0;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(child: _tab == 0 ? _modules() : _contact()),
      bottomNavigationBar: _bottomNav(),
    );
  }

  Widget _bottomNav() {
    return Container(
      decoration: const BoxDecoration(
        border: Border(
            top: BorderSide(color: AppColors.borderSubtle, width: 0.5)),
      ),
      child: BottomNavigationBar(
        currentIndex: _tab,
        backgroundColor: AppColors.surface,
        selectedItemColor: AppColors.gold,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        onTap: (i) {
          if (i == 2) {
            context.push(DatingRoutes.settings);
            return;
          }
          setState(() => _tab = i);
        },
        items: const [
          BottomNavigationBarItem(
              icon: Icon(Icons.grid_view_rounded), label: 'Modüller'),
          BottomNavigationBarItem(
              icon: Icon(Icons.support_agent_rounded), label: 'Bize Ulaşın'),
          BottomNavigationBarItem(
              icon: Icon(Icons.settings_rounded), label: 'Ayarlar'),
        ],
      ),
    );
  }

  // === MODÜLLER ===
  Widget _modules() {
    return LayoutBuilder(
      builder: (context, constraints) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text('Merhaba 👋',
                        style: TextStyle(
                            fontSize: 14, color: AppColors.textSecondary)),
                  ),
                  Builder(builder: (_) {
                    final pack = ref.watch(packBalanceProvider);
                    return _PlanBadge(
                        hasPack: pack.photo > 0 || pack.analysis > 0);
                  }),
                ],
              ),
              const SizedBox(height: 8),
              const Text('Profilini bir üst lige taşı',
                  style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                      height: 1.15,
                      color: AppColors.textPrimary)),
              const SizedBox(height: 4),
              const Text(
                  'AI fotoğraf üret veya fotoğraflarını analiz et.',
                  style: TextStyle(
                      fontSize: 13,
                      height: 1.35,
                      color: AppColors.textSecondary)),
              const SizedBox(height: 14),
              Expanded(
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    for (int i = 0; i < DatingModule.all.length; i++) ...[
                      if (i > 0) const SizedBox(height: 12),
                      SizedBox(
                        height: 190,
                        child: _FeatureCard(
                          module: DatingModule.all[i],
                          hasPack: _hasPack(DatingModule.all[i]),
                          onTap: () => _openModule(DatingModule.all[i]),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 10),
              const _HowItWorksStrip(),
            ],
          ),
        );
      },
    );
  }

  // === BİZE ULAŞIN ===
  Widget _contact() {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const SizedBox(height: 8),
        const Text('Bize Ulaşın',
            style: TextStyle(
                fontSize: 26,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary)),
        const SizedBox(height: 4),
        const Text('Sorularını ve önerilerini bekliyoruz.',
            style: TextStyle(fontSize: 14, color: AppColors.textSecondary)),
        const SizedBox(height: 20),
        _contactTile(Icons.email_outlined, 'E-posta', 'destek@voxenai.app'),
        _contactTile(Icons.camera_alt_outlined, 'Instagram', '@voxenai'),
        _contactTile(Icons.help_outline_rounded, 'Sık Sorulan Sorular',
            'Yardım merkezini görüntüle'),
        _contactTile(Icons.star_outline_rounded, 'Bizi Değerlendir',
            'App Store / Google Play'),
        const SizedBox(height: 16),
        _contactTile(Icons.privacy_tip_outlined, 'Gizlilik & Şartlar',
            'Ayarlar\'dan eriş', onTap: () => context.push(DatingRoutes.settings)),
      ],
    );
  }

  Widget _contactTile(IconData icon, String title, String sub,
      {VoidCallback? onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: [
            Icon(icon, color: AppColors.gold, size: 24),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(sub,
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textSecondary)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded,
                color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }
}

/// İki aktif modüle özel görsel meta (etiket, açıklama, örnek chip'ler).
class _ModuleMeta {
  final String badge;
  final String pitch;
  final List<String> highlights;
  const _ModuleMeta(this.badge, this.pitch, this.highlights);

  static const Map<String, _ModuleMeta> byId = {
    'ai_photo': _ModuleMeta(
      'EN POPÜLER',
      'Kendi selfie\'lerinden stile özel stüdyo kalitesinde dating fotoğrafları üret.',
      ['Studio ışık', 'Doğal stil', 'Outdoor'],
    ),
    'photo_analysis': _ModuleMeta(
      'HIZLI',
      'Fotoğraflarını puanla, en çok eşleşme getirecek kareyi seç.',
      ['Çekicilik skoru', 'En iyi kare', 'İpuçları'],
    ),
  };

  static String imageFor(String moduleId) => switch (moduleId) {
        'ai_photo' => DatingAssetPaths.hubAiPhoto,
        'photo_analysis' => DatingAssetPaths.hubAnalysis,
        _ => DatingAssetPaths.moduleAiPhotoHero,
      };
}

/// Ana ekrandaki iki modüle özel kart: üstte yatay görsel, altta açıklama.
class _FeatureCard extends StatelessWidget {
  final DatingModule module;
  final bool hasPack;
  final VoidCallback onTap;
  const _FeatureCard(
      {required this.module, required this.hasPack, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final meta = _ModuleMeta.byId[module.id] ??
        const _ModuleMeta('', '', <String>[]);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.borderGold, width: 0.8),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Üst: yatay kapak görseli
            SizedBox(
              height: 100,
              child: DatingModuleImage(
                assetPath: _ModuleMeta.imageFor(module.id),
                fallbackIcon: module.icon,
                borderRadius: BorderRadius.zero,
                alignment: Alignment.center,
              ),
            ),
            // Alt: başlık + kısa açıklama + CTA
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (meta.badge.isNotEmpty) ...[
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.goldSurface,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(meta.badge,
                                style: const TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 0.5,
                                    color: AppColors.gold)),
                          ),
                          const SizedBox(width: 8),
                        ],
                        Expanded(
                          child: Text(module.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w900,
                                  color: AppColors.textPrimary)),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: AppColors.gold,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Text('Başla',
                              style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w900,
                                  color: AppColors.textOnGold)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Expanded(
                      child: Text(
                        meta.pitch,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12.5,
                          height: 1.35,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Üst bardaki durum rozeti: paket bakiyesi varsa "Paket aktif", yoksa "Ücretsiz".
class _PlanBadge extends StatelessWidget {
  final bool hasPack;
  const _PlanBadge({required this.hasPack});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: hasPack ? AppColors.goldSurface : AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderGold, width: 0.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
              hasPack
                  ? Icons.workspace_premium_rounded
                  : Icons.lock_open_rounded,
              color: AppColors.gold,
              size: 15),
          const SizedBox(width: 5),
          Text(hasPack ? 'Paket aktif' : 'Ücretsiz',
              style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: AppColors.gold)),
        ],
      ),
    );
  }
}

/// Ana ekranın altında kompakt "nasıl çalışır" şeridi.
class _HowItWorksStrip extends StatelessWidget {
  const _HowItWorksStrip();

  @override
  Widget build(BuildContext context) {
    Widget step(IconData i, String t) => Expanded(
          child: Row(
            children: [
              Icon(i, color: AppColors.gold, size: 16),
              const SizedBox(width: 6),
              Expanded(
                child: Text(t,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: AppColors.textSecondary)),
              ),
            ],
          ),
        );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: [
          step(Icons.upload_rounded, 'Yükle'),
          step(Icons.auto_awesome, 'AI'),
          step(Icons.favorite_rounded, 'Eşleşme'),
        ],
      ),
    );
  }
}
