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
    return CustomScrollView(
      slivers: [
        // Üst bar: karşılama + abonelik durumu
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 16, 4),
            child: Row(
              children: [
                const Expanded(
                  child: Text('Merhaba 👋',
                      style: TextStyle(
                          fontSize: 15, color: AppColors.textSecondary)),
                ),
                Builder(builder: (_) {
                  final pack = ref.watch(packBalanceProvider);
                  return _PlanBadge(hasPack: pack.photo > 0 || pack.analysis > 0);
                }),
                const SizedBox(width: 8),
              ],
            ),
          ),
        ),
        // Hero başlık + alt açıklama
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(20, 8, 20, 4),
            child: Text('Profilini bir üst lige taşı',
                style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w900,
                    height: 1.15,
                    color: AppColors.textPrimary)),
          ),
        ),
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(20, 0, 20, 18),
            child: Text(
                'AI ile çekici fotoğraflar üret, en iyi karelerini seç. '
                'İki adımda daha fazla eşleşme.',
                style: TextStyle(
                    fontSize: 14,
                    height: 1.4,
                    color: AppColors.textSecondary)),
          ),
        ),
        // İki modüle özel büyük kartlar
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate(
              (_, i) {
                final m = DatingModule.all[i];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: _FeatureCard(
                    module: m,
                    hasPack: _hasPack(m),
                    onTap: () => _openModule(m),
                  ),
                );
              },
              childCount: DatingModule.all.length,
            ),
          ),
        ),
        // Alt: güven / nasıl çalışır şeridi
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 28),
            child: _HowItWorksStrip(),
          ),
        ),
      ],
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
      'Kendi fotoğrafından, farklı stillerde stüdyo kalitesinde dating '
          'kareleri üret.',
      ['Studio ışık', 'Doğal stil', 'Outdoor'],
    ),
    'photo_analysis': _ModuleMeta(
      'HIZLI',
      'Fotoğraflarını saniyeler içinde puanlar, en çok eşleşme getirecek '
          'kareyi seçer.',
      ['Çekicilik skoru', 'En iyi kare', 'İpuçları'],
    ),
  };

  static String imageFor(String moduleId) => switch (moduleId) {
        'ai_photo' => DatingAssetPaths.hubAiPhoto,
        'photo_analysis' => DatingAssetPaths.hubAnalysis,
        _ => DatingAssetPaths.moduleAiPhotoHero,
      };
}

/// Ana ekrandaki iki modüle özel büyük, dolu özellik kartı.
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
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              AppColors.surfaceElevated,
              AppColors.surface,
            ],
          ),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: AppColors.borderGold, width: 0.8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DatingModuleImage(
              assetPath: _ModuleMeta.imageFor(module.id),
              height: 120,
              width: double.infinity,
              fallbackIcon: module.icon,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(22),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // İkon rozeti
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      gradient: AppColors.goldGradient,
                      borderRadius: BorderRadius.circular(16),
                      boxShadow: const [
                        BoxShadow(
                            color: AppColors.goldGlow,
                            blurRadius: 18,
                            spreadRadius: 1),
                      ],
                    ),
                    child: Icon(module.icon,
                        color: AppColors.textOnGold, size: 28),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (meta.badge.isNotEmpty)
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: AppColors.goldSurface,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(meta.badge,
                                style: const TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 0.8,
                                    color: AppColors.gold)),
                          ),
                        const SizedBox(height: 6),
                        Text(module.title,
                            style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w900,
                                height: 1.2,
                                color: AppColors.textPrimary)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            // Açıklama
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 14),
              child: Text(meta.pitch,
                  style: const TextStyle(
                      fontSize: 13.5,
                      height: 1.45,
                      color: AppColors.textSecondary)),
            ),
            // Highlight chip'leri
            if (meta.highlights.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 16),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final h in meta.highlights)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: AppColors.surfaceHighest,
                          borderRadius: BorderRadius.circular(20),
                          border:
                              Border.all(color: AppColors.borderSubtle),
                        ),
                        child: Text(h,
                            style: const TextStyle(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w600,
                                color: AppColors.textSecondary)),
                      ),
                  ],
                ),
              ),
            // Alt bar: durum ikonu + CTA (yazı yok — sadece ikon)
            Container(
              padding: const EdgeInsets.fromLTRB(18, 12, 14, 12),
              decoration: const BoxDecoration(
                border: Border(
                    top: BorderSide(color: AppColors.borderSubtle)),
              ),
              child: Row(
                children: [
                  Icon(
                      hasPack
                          ? Icons.check_circle_rounded
                          : Icons.auto_awesome_rounded,
                      color: AppColors.gold,
                      size: 18),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 8),
                    decoration: BoxDecoration(
                      color: AppColors.gold,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('Başla',
                            style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w900,
                                color: AppColors.textOnGold)),
                        SizedBox(width: 4),
                        Icon(Icons.arrow_forward_rounded,
                            color: AppColors.textOnGold, size: 16),
                      ],
                    ),
                  ),
                ],
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

/// Ana ekranın altında güven veren "nasıl çalışır" şeridi.
class _HowItWorksStrip extends StatelessWidget {
  const _HowItWorksStrip();

  @override
  Widget build(BuildContext context) {
    Widget step(IconData icon, String label) => Expanded(
          child: Column(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: AppColors.goldSurface,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: AppColors.gold, size: 20),
              ),
              const SizedBox(height: 8),
              Text(label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textSecondary)),
            ],
          ),
        );
    Widget dash() => const Padding(
          padding: EdgeInsets.only(bottom: 22),
          child: Icon(Icons.arrow_forward_rounded,
              color: AppColors.textMuted, size: 16),
        );
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        children: [
          const Text('Nasıl çalışır?',
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary)),
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              step(Icons.upload_rounded, 'Fotoğrafını\nyükle'),
              dash(),
              step(Icons.auto_awesome, 'AI\nçalışsın'),
              dash(),
              step(Icons.favorite_rounded, 'Daha çok\neşleşme'),
            ],
          ),
        ],
      ),
    );
  }
}
