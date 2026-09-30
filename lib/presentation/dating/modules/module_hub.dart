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
              icon: Icon(Icons.grid_view_rounded), label: 'Modüller'),
          BottomNavigationBarItem(
              icon: Icon(Icons.photo_library_rounded),
              label: 'Fotoğraflarım'),
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
        const Text('Bize Ulaşın',
            style: TextStyle(
                fontSize: 26,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary)),
        const SizedBox(height: 4),
        const Text('Sorularını ve önerilerini bekliyoruz.',
            style: TextStyle(fontSize: 14, color: AppColors.textSecondary)),
        const SizedBox(height: 20),
        _contactTile(Icons.email_outlined, 'E-posta', 'destek@voxenai.com.tr'),
        _contactTile(Icons.camera_alt_outlined, 'Instagram', '@voxenapp'),
        _contactTile(Icons.help_outline_rounded, 'Sık Sorulan Sorular',
            'Yardım merkezini görüntüle',
            onTap: () => context.push(DatingRoutes.faq)),
        _contactTile(Icons.star_outline_rounded, 'Bizi Değerlendir',
            'App Store / Google Play',
            onTap: () => ReviewPromptService().promptNow(context)),
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
            // Üst: kapak görseli (2026-09-28): eski kırmızı/pembe zeminli
            // infografikler koyu temayla çakışıyordu; yerine gerçek stil
            // fotoğraflarından kurulan, temaya uyumlu yerel görseller.
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
                        child: Text(module.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w900,
                                color: AppColors.textPrimary)),
                      ),
                      if (meta.badge.isNotEmpty) ...[
                        const SizedBox(width: 8),
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
                            horizontal: 14, vertical: 8),
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
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Kart kapaklarının ortak zemini: koyu yüzey + sağ üstte hafif kırmızı ışıma.
BoxDecoration _hubVisualBackground() => const BoxDecoration(
      gradient: RadialGradient(
        center: Alignment(0.7, -0.6),
        radius: 1.2,
        colors: [Color(0x33FF2D55), AppColors.surfaceElevated],
      ),
    );

Widget _hubPhoto(String asset, {double radius = 12}) => ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Image.asset(
        asset,
        fit: BoxFit.cover,
        alignment: Alignment.topCenter,
        errorBuilder: (_, _, _) => Container(color: AppColors.surface),
      ),
    );

/// AI Foto kartı: solda "selfie" kartı → sağda yelpaze gibi açılmış, hafifçe
/// süzülen 3 stil çıktısı.
class _AiPhotoHubVisual extends StatefulWidget {
  const _AiPhotoHubVisual();
  @override
  State<_AiPhotoHubVisual> createState() => _AiPhotoHubVisualState();
}

class _AiPhotoHubVisualState extends State<_AiPhotoHubVisual>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 2800))
    ..repeat(reverse: true);

  static const _outputs = [
    'assets/dating/styles/oldmoney_1.jpg',
    'assets/dating/styles/traveller_2.jpg',
    'assets/dating/styles/elegance_1.jpg',
  ];

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: _hubVisualBackground(),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: LayoutBuilder(builder: (context, c) {
        // Birim hem yükseklikle hem genişlikle sınırlı: uzun ekranlarda
        // kart yüksek olunca yatayda taşmasın.
        final unit = c.maxHeight < c.maxWidth / 1.8
            ? c.maxHeight
            : c.maxWidth / 1.8;
        final cardH = unit * 0.92;
        final cardW = cardH * 0.72;
        final selfieW = cardW * 0.78;
        return Row(
          children: [
            // Selfie kartı
            SizedBox(
              width: selfieW,
              height: cardH * 0.82,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Container(
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.borderSubtle),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(11),
                      child: ColorFiltered(
                        colorFilter: const ColorFilter.matrix([
                          0.33, 0.33, 0.33, 0, -10, //
                          0.33, 0.33, 0.33, 0, -10, //
                          0.33, 0.33, 0.33, 0, -10, //
                          0, 0, 0, 1, 0,
                        ]),
                        child: _hubPhoto(
                            'assets/dating/styles/nightout_1.jpg',
                            radius: 0),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 6,
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.6),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Text('Selfie',
                            style: TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                                fontWeight: FontWeight.w800)),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.auto_awesome, color: AppColors.gold, size: 18),
                  SizedBox(height: 2),
                  Icon(Icons.arrow_forward_rounded,
                      color: AppColors.gold, size: 22),
                ],
              ),
            ),
            // Yelpaze çıktılar
            SizedBox(
              width: cardW * 1.55,
              height: cardH,
              child: AnimatedBuilder(
                animation: _c,
                builder: (_, _) {
                  final t = Curves.easeInOut.transform(_c.value);
                  return Stack(
                    clipBehavior: Clip.none,
                    alignment: Alignment.center,
                    children: [
                      for (var i = 0; i < _outputs.length; i++)
                        Transform.translate(
                          offset: Offset(
                              (i - 1) * cardW * 0.34 * (0.9 + 0.1 * t),
                              i == 1 ? -4 * t : 2 * t),
                          child: Transform.rotate(
                            angle: (i - 1) * 0.12,
                            child: Container(
                              width: cardW * 0.82,
                              height: cardH * 0.9,
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                    color: i == 1
                                        ? AppColors.gold
                                        : Colors.white24,
                                    width: i == 1 ? 1.5 : 1),
                                boxShadow: const [
                                  BoxShadow(
                                      color: Colors.black54, blurRadius: 10),
                                ],
                              ),
                              child: _hubPhoto(_outputs[i], radius: 11),
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
          ],
        );
      }),
    );
  }
}

/// Analiz kartı: solda fotoğraf, sağda animasyonla dolan puan halkası +
/// kısa kriter çubukları.
class _AnalysisHubVisual extends StatelessWidget {
  const _AnalysisHubVisual();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: _hubVisualBackground(),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: LayoutBuilder(builder: (context, c) {
        final h = c.maxHeight;
        final photoW =
            (h * 0.72) < c.maxWidth * 0.36 ? h * 0.72 : c.maxWidth * 0.36;
        final ringMax = c.maxWidth * 0.26;
        final upper = ringMax < 48 ? 48.0 : (ringMax < 110 ? ringMax : 110.0);
        final ring = (h * 0.62).clamp(48.0, upper);
        return TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 1400),
          curve: Curves.easeOutCubic,
          builder: (_, v, _) => Row(
            children: [
              Container(
                width: photoW,
                height: h,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.borderSubtle),
                ),
                child: _hubPhoto('assets/dating/styles/traveller_1.jpg',
                    radius: 11),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Row(
                  children: [
                    SizedBox(
                      width: ring,
                      height: ring,
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          CircularProgressIndicator(
                            value: 0.87 * v,
                            strokeWidth: 7,
                            strokeCap: StrokeCap.round,
                            backgroundColor: AppColors.surface,
                            valueColor: const AlwaysStoppedAnimation(
                                AppColors.gold),
                          ),
                          Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text('${(87 * v).round()}',
                                    style: TextStyle(
                                        color: AppColors.textPrimary,
                                        fontSize: ring * 0.3,
                                        fontWeight: FontWeight.w900,
                                        height: 1)),
                                Text('Puan',
                                    style: TextStyle(
                                        color: AppColors.textSecondary,
                                        fontSize: ring * 0.12,
                                        fontWeight: FontWeight.w700)),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _metric('Işık', 0.9 * v),
                          _metric('Kadraj', 0.78 * v),
                          _metric('İfade', 0.84 * v),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      }),
    );
  }

  Widget _metric(String label, double value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label,
              style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 10,
                  fontWeight: FontWeight.w700)),
          const SizedBox(height: 3),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: value,
              minHeight: 5,
              backgroundColor: AppColors.surface,
              valueColor: const AlwaysStoppedAnimation(AppColors.gold),
            ),
          ),
        ],
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
          // "Ücretsiz" -> "Paket yok" (2026-09-15): ücretsiz hak kapatıldı,
          // paketi olmayan kullanıcıya ücretsiz kullanım vaat edilmemeli.
          Text(hasPack ? 'Paket aktif' : 'Paket yok',
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
