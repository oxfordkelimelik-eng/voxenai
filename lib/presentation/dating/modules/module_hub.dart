import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../../../data/sources/review_prompt_service.dart';
import '../providers/dating_providers.dart';
import '../widgets/shared_widgets.dart';
import 'module_flows.dart' show GeneratedPhotosScreen;

/// Giriş/abonelik sonrası ana merkez (Bölüm 6). Alt menü: Modüller / Bize
/// Ulaşın / Ayarlar. 2 aktif modül + kredi bakiyesi.
class ModuleHubScreen extends ConsumerStatefulWidget {
  /// Hangi sekmeyle açılacağı. Üretim bitip iş onaya düştüğünde kullanıcı
  /// doğrudan "Fotoğraflarım" (1) sekmesine bırakılıyor.
  final int initialTab;
  const ModuleHubScreen({super.key, this.initialTab = 0});
  @override
  ConsumerState<ModuleHubScreen> createState() => _ModuleHubScreenState();
}

class _ModuleHubScreenState extends ConsumerState<ModuleHubScreen> {
  late int _tab = widget.initialTab;

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
      body: SafeArea(
        child: switch (_tab) {
          0 => _modules(),
          1 => const GeneratedPhotosScreen(),
          2 => _contact(),
          _ => _modules(),
        },
      ),
      bottomNavigationBar: _bottomNav(),
    );
  }

  Widget _bottomNav() {
    return Container(
      decoration: const BoxDecoration(
        border: Border(
          top: BorderSide(color: AppColors.borderSubtle, width: 0.5),
        ),
      ),
      child: BottomNavigationBar(
        currentIndex: _tab,
        backgroundColor: AppColors.surface,
        selectedItemColor: AppColors.gold,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        onTap: (i) {
          // Ayarlar bir sekme değil, ayrı bir ekrana geçiştir (_tab
          // değişmez — geri dönünce en son gerçek sekmede kalınır).
          if (i == 3) {
            context.push(DatingRoutes.settings);
            return;
          }
          setState(() => _tab = i);
        },
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.grid_view_rounded),
            label: 'Modüller',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.photo_library_rounded),
            label: 'Fotoğraflarım',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.support_agent_rounded),
            label: 'Bize Ulaşın',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.settings_rounded),
            label: 'Ayarlar',
          ),
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
                    child: Text(
                      'Merhaba 👋',
                      style: TextStyle(
                        fontSize: 14,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                  Builder(
                    builder: (_) {
                      final pack = ref.watch(packBalanceProvider);
                      return _PlanBadge(
                        hasPack: pack.photo > 0 || pack.analysis > 0,
                      );
                    },
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'Profilini bir üst lige taşı',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                  height: 1.15,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'AI fotoğraf üret veya fotoğraflarını analiz et.',
                style: TextStyle(
                  fontSize: 13,
                  height: 1.35,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 14),
              // İki modül kartı tek ekrana sığar (scroll yok): kalan dikey
              // alanı eşit bölüşürler.
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (int i = 0; i < DatingModule.all.length; i++) ...[
                      if (i > 0) const SizedBox(height: 12),
                      Expanded(
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
        const Text(
          'Bize Ulaşın',
          style: TextStyle(
            fontSize: 26,
            fontWeight: FontWeight.w900,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Sorularını ve önerilerini bekliyoruz.',
          style: TextStyle(fontSize: 14, color: AppColors.textSecondary),
        ),
        const SizedBox(height: 20),
        _contactTile(Icons.email_outlined, 'E-posta', 'destek@voxenai.com.tr'),
        _contactTile(Icons.camera_alt_outlined, 'Instagram', '@voxenapp'),
        _contactTile(
          Icons.help_outline_rounded,
          'Sık Sorulan Sorular',
          'Yardım merkezini görüntüle',
          onTap: () => context.push(DatingRoutes.faq),
        ),
        _contactTile(
          Icons.star_outline_rounded,
          'Bizi Değerlendir',
          'App Store / Google Play',
          onTap: () => ReviewPromptService().promptNow(context),
        ),
        const SizedBox(height: 16),
        _contactTile(
          Icons.privacy_tip_outlined,
          'Gizlilik & Şartlar',
          'Ayarlar\'dan eriş',
          onTap: () => context.push(DatingRoutes.settings),
        ),
      ],
    );
  }

  Widget _contactTile(
    IconData icon,
    String title,
    String sub, {
    VoidCallback? onTap,
  }) {
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
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
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
      'Kendi selfie\'lerinden stüdyo kalitesinde dating fotoğrafları üret.',
      ['Her karede farklı mekân', 'Doğal ışık', 'Outdoor'],
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
  const _FeatureCard({
    required this.module,
    required this.hasPack,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final meta =
        _ModuleMeta.byId[module.id] ?? const _ModuleMeta('', '', <String>[]);
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
            // Üst: kapak görseli (2026-10-01): kenardan kenara, "gerçek
            // kamera" işleminden geçmiş doğal fotoğraflar.
            Expanded(
              child: switch (module.id) {
                'ai_photo' => const _AiPhotoHubVisual(),
                'photo_analysis' => const _AnalysisHubVisual(),
                _ => Container(
                  color: AppColors.surfaceElevated,
                  child: DatingModuleImage(
                    assetPath: _ModuleMeta.imageFor(module.id),
                    fallbackIcon: module.icon,
                    borderRadius: BorderRadius.zero,
                    fit: BoxFit.contain,
                    alignment: Alignment.center,
                  ),
                ),
              },
            ),
            // Alt: rozet + başlık + açıklama + CTA (sabit yükseklik).
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Başlık + rozet aynı satırda (dikey alan tasarrufu).
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          module.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary,
                          ),
                        ),
                      ),
                      if (meta.badge.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.goldSurface,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            meta.badge,
                            style: const TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 0.5,
                              color: AppColors.gold,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 4),
                  // Açıklama + CTA yan yana; açıklamaya kalan alanı ver.
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Text(
                          meta.pitch,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12.5,
                            height: 1.3,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 8,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.gold,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: const Text(
                          'Başla',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textOnGold,
                          ),
                        ),
                      ),
                    ],
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

Widget _hubPhoto(String asset, {double radius = 12}) => ClipRRect(
  borderRadius: BorderRadius.circular(radius),
  child: Image.asset(
    asset,
    fit: BoxFit.cover,
    alignment: Alignment.topCenter,
    errorBuilder: (_, _, _) => Container(color: AppColors.surface),
  ),
);

/// AI Foto kartı (2026-10-01): kenardan kenara 3 sütunlu editoryal foto
/// şeridi. Fotoğraflar "gerçek kamera" işleminden geçmiş (gren, yumuşak ton,
/// vinyet) — parlak AI görünümü yerine doğal kareler. Yavaş Ken Burns.
class _AiPhotoHubVisual extends StatefulWidget {
  const _AiPhotoHubVisual();
  @override
  State<_AiPhotoHubVisual> createState() => _AiPhotoHubVisualState();
}

class _AiPhotoHubVisualState extends State<_AiPhotoHubVisual>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 9),
  )..repeat(reverse: true);

  static const _photos = [
    ('assets/dating/modules/hub_ai_1.jpg', 'Elegance'),
    ('assets/dating/modules/hub_ai_2.jpg', 'Date Night'),
    ('assets/dating/modules/hub_ai_3.jpg', 'Old Money'),
  ];

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Container(color: Colors.black),
        AnimatedBuilder(
          animation: _c,
          builder: (_, _) {
            final t = Curves.easeInOut.transform(_c.value);
            return Row(
              children: [
                for (var i = 0; i < _photos.length; i++) ...[
                  if (i > 0) const SizedBox(width: 2),
                  Expanded(
                    child: ClipRect(
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          Transform.scale(
                            // Sütunlar sırayla zıt yönde yakınlaşır.
                            scale: 1.02 + 0.06 * (i.isEven ? t : 1 - t),
                            child: _hubPhoto(_photos[i].$1, radius: 0),
                          ),
                          const DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                stops: [0.55, 1],
                                colors: [Colors.transparent, Color(0xCC000000)],
                              ),
                            ),
                          ),
                          Positioned(
                            left: 8,
                            bottom: 8,
                            child: Text(
                              _photos[i].$2.toUpperCase(),
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 9.5,
                                letterSpacing: 1.2,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            );
          },
        ),
        Positioned(
          left: 10,
          top: 10,
          child: _glassChip(Icons.auto_awesome, '4 stil · gerçek yüzün'),
        ),
      ],
    );
  }
}

/// Analiz kartı (2026-10-01): kenardan kenara gerçekçi tek fotoğraf; solda
/// koyu geçiş üstünde animasyonla dolan puan ve kriter çubukları.
class _AnalysisHubVisual extends StatelessWidget {
  const _AnalysisHubVisual();

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Image.asset(
          'assets/dating/modules/hub_analysis_photo.jpg',
          fit: BoxFit.cover,
          alignment: const Alignment(0.35, -0.2),
          errorBuilder: (_, _, _) => Container(color: AppColors.surface),
        ),
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.centerLeft,
              end: Alignment.centerRight,
              stops: [0, 0.42, 0.75],
              colors: [
                Color(0xF2000000),
                Color(0x99000000),
                Colors.transparent,
              ],
            ),
          ),
        ),
        Positioned(
          right: 10,
          top: 10,
          child: _glassChip(Icons.center_focus_strong_rounded, 'Yüz analizi'),
        ),
        LayoutBuilder(
          builder: (context, c) {
            final panelW = (c.maxWidth * 0.46).clamp(120.0, 190.0);
            return TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: 1),
              duration: const Duration(milliseconds: 1400),
              curve: Curves.easeOutCubic,
              builder: (_, v, _) => Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 0, 10),
                child: SizedBox(
                  width: panelW,
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: SizedBox(
                      width: 150,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'ÇEKİCİLİK SKORU',
                            style: TextStyle(
                              color: Colors.white70,
                              fontSize: 9,
                              letterSpacing: 1.2,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.baseline,
                            textBaseline: TextBaseline.alphabetic,
                            children: [
                              Text(
                                '${(87 * v).round()}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 40,
                                  fontWeight: FontWeight.w900,
                                  height: 1.05,
                                ),
                              ),
                              const Text(
                                ' /100',
                                style: TextStyle(
                                  color: Colors.white60,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          _metric('Işık', 0.9 * v),
                          _metric('Kadraj', 0.78 * v),
                          _metric('İfade', 0.84 * v),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _metric(String label, double value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2.5),
      child: Row(
        children: [
          SizedBox(
            width: 44,
            child: Text(
              label,
              style: const TextStyle(
                color: Colors.white70,
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: value,
                minHeight: 5,
                backgroundColor: Colors.white12,
                valueColor: const AlwaysStoppedAnimation(AppColors.gold),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Fotoğraf üstü yarı saydam etiket.
Widget _glassChip(IconData icon, String text) => Container(
  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
  decoration: BoxDecoration(
    color: Colors.black.withValues(alpha: 0.5),
    borderRadius: BorderRadius.circular(20),
    border: Border.all(color: Colors.white24, width: 0.6),
  ),
  child: Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, color: AppColors.gold, size: 12),
      const SizedBox(width: 4),
      Text(
        text,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 10,
          fontWeight: FontWeight.w800,
        ),
      ),
    ],
  ),
);

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
            hasPack ? Icons.workspace_premium_rounded : Icons.lock_open_rounded,
            color: AppColors.gold,
            size: 15,
          ),
          const SizedBox(width: 5),
          // "Ücretsiz" -> "Paket yok" (2026-09-15): ücretsiz hak kapatıldı,
          // paketi olmayan kullanıcıya ücretsiz kullanım vaat edilmemeli.
          Text(
            hasPack ? 'Paket aktif' : 'Paket yok',
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w800,
              color: AppColors.gold,
            ),
          ),
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
            child: Text(
              t,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: AppColors.textSecondary,
              ),
            ),
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
