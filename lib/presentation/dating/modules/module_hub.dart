import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../../../data/sources/review_prompt_service.dart';
import '../providers/dating_providers.dart';
import 'ai_tool_ui.dart' show ToolFitText;
import 'ai_tool_visuals.dart';
import 'module_flows.dart' show GeneratedPhotosScreen;

/// Giriş/abonelik sonrası ana merkez (Bölüm 6). Alt menü: Modüller / Bize
/// Ulaşın / Ayarlar. 2 aktif modül + kredi bakiyesi.
class ModuleHubScreen extends ConsumerStatefulWidget {
  /// Hangi sekmeyle açılacağı. Üretim bitip iş onaya düştüğünde kullanıcı
  /// doğrudan "Fotoğraflarım" (1) sekmesine bırakılıyor.
  final int initialTab;
  /// Sekme isteğinin kimliği (?r=...). Hub zaten açıkken (modül onun üstüne
  /// push edilmişti) go('/hub?tab=photos') aynı State'i yeniden kullanıyor —
  /// GoRouter'ın sayfa anahtarı sorguyu içermiyor — ve initialTab ilk
  /// oluşturmadan sonra okunmadığı için kullanıcı Modüller'de kalıyordu
  /// (2026-10-11, kullanıcı bildirimi). Her yeni istek farklı kimlikle gelir;
  /// didUpdateWidget sekmeyi değiştirir, aynı istek art arda gelse de çalışır.
  final String? tabRequest;
  const ModuleHubScreen({super.key, this.initialTab = 0, this.tabRequest});
  @override
  ConsumerState<ModuleHubScreen> createState() => _ModuleHubScreenState();
}

class _ModuleHubScreenState extends ConsumerState<ModuleHubScreen> {
  late int _tab = widget.initialTab;

  @override
  void didUpdateWidget(ModuleHubScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.tabRequest != oldWidget.tabRequest ||
        widget.initialTab != oldWidget.initialTab) {
      _tab = widget.initialTab;
    }
  }

  /// Modüle her zaman girilebilir: ilk çıktı ekranda ücretsiz gösterilir,
  /// devamı için paket gerekiyorsa akış (module_flows) içinde paywall'a
  /// yönlendirilir.
  void _openModule(DatingModule m) {
    context.push('${DatingRoutes.module}/${m.id}');
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
  // DÜZEN (2026-11-23, kullanıcı: "ana odakta AI foto üretimi olsun; analiz, RizzGPT ve Profil Doktoru onun
  // gölgesinde kalsa da kendi büyük kartı olsun"): en üstte geniş AI Foto kartı, altında Foto Analizi,
  // en altta yan yana RizzGPT ve Profil Doktoru. Sayfa her zaman kayar (dört kart tek ekrana sığmaz).
  Widget _modules() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Merhaba 👋',
                style: TextStyle(fontSize: 14, color: AppColors.textSecondary),
              ),
            ),
            Builder(
              builder: (_) {
                final pack = ref.watch(packBalanceProvider);
                return _PlanBadge(hasPack: pack.photo > 0 || pack.analysis > 0);
              },
            ),
          ],
        ),
        const SizedBox(height: 8),
        const Text(
          'Bugün kimi şaşırtıyoruz?',
          style: TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w900,
            height: 1.15,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: 16),
        _ModuleCard(
          visual: const _AiPhotoHubVisual(),
          aspectRatio: 1.75,
          badge: 'EN POPÜLER',
          title: 'AI Dating Fotoğrafları',
          pitch: 'Fotoğrafçı yok, stüdyo yok. Selfie\'lerin yeter, gerisi bizde.',
          hero: true,
          onTap: () => _openModule(DatingModule.aiPhoto),
        ),
        const SizedBox(height: 12),
        _ModuleCard(
          visual: const _AnalysisHubVisual(),
          aspectRatio: 2.2,
          title: 'Fotoğraf Analizi',
          pitch: 'Hangi fotoğrafın sağa kaydırttığını AI fısıldasın.',
          onTap: () => _openModule(DatingModule.photoAnalysis),
        ),
        const SizedBox(height: 12),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: _MiniCard(
                  visual: const RizzCoverVisual(),
                  title: 'RizzGPT',
                  pitch: 'Beynin dondu mu? 3 cevap çoktan hazır.',
                  onTap: () => _openModule(DatingModule.rizz),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _MiniCard(
                  visual: const DoctorCoverVisual(),
                  title: 'Profil Doktoru',
                  pitch: 'Profiline dürüst bir ikinci göz',
                  onTap: () => _openModule(DatingModule.profileDoctor),
                ),
              ),
            ],
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

/// Geniş modül kartı: üstte kapak görseli, altta başlık + kısa açıklama + ok düğmesi.
/// [hero]: ana ürün (AI Foto) için daha büyük yazı, kırmızı kenar ve parıltı.
class _ModuleCard extends StatelessWidget {
  final Widget visual;
  final double aspectRatio;
  final String? badge;
  final String title;
  final String pitch;
  final bool hero;
  final VoidCallback onTap;
  const _ModuleCard({
    required this.visual,
    required this.aspectRatio,
    this.badge,
    required this.title,
    required this.pitch,
    this.hero = false,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return _CardShell(
      onTap: onTap,
      highlight: hero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AspectRatio(
            aspectRatio: aspectRatio,
            child: Stack(
              fit: StackFit.expand,
              children: [
                visual,
                if (badge != null) Positioned(left: 12, top: 12, child: _Badge(badge!)),
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(16, hero ? 14 : 12, 14, hero ? 16 : 14),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ToolFitText(
                        title,
                        style: TextStyle(
                          fontSize: hero ? 19 : 16,
                          fontWeight: FontWeight.w900,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        pitch,
                        style: TextStyle(
                          fontSize: hero ? 13.5 : 12.5,
                          height: 1.3,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                _GoButton(size: hero ? 46 : 38),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Yan yana iki kart (RizzGPT, Profil Doktoru): üstte kendi görseli, altta başlık + kısa açıklama.
class _MiniCard extends StatelessWidget {
  final Widget visual;
  final String title;
  final String pitch;
  final VoidCallback onTap;
  const _MiniCard({required this.visual, required this.title, required this.pitch, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return _CardShell(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 140,
            child: Stack(
              fit: StackFit.expand,
              children: [
                visual,
                const Positioned(left: 10, top: 10, child: _Badge('YENİ')),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: ToolFitText(
                        title,
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: AppColors.textPrimary),
                      ),
                    ),
                    const Icon(Icons.arrow_forward_rounded, size: 17, color: AppColors.gold),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  pitch,
                  style: const TextStyle(fontSize: 12, height: 1.3, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Kart kabuğu: yüzey rengi, ince kenar, dokunma efekti. Ana ürün kartında kenar kırmızı.
class _CardShell extends StatelessWidget {
  final Widget child;
  final VoidCallback onTap;
  final bool highlight;
  const _CardShell({required this.child, required this.onTap, this.highlight = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: highlight ? const Color(0x66FF2D55) : AppColors.borderSubtle, width: 0.8),
        boxShadow: highlight
            ? const [BoxShadow(color: Color(0x1FFF2D55), blurRadius: 20, offset: Offset(0, 2))]
            : null,
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        color: Colors.transparent,
        child: InkWell(onTap: onTap, child: child),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  final String text;
  const _Badge(this.text);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: AppColors.gold, borderRadius: BorderRadius.circular(6)),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 9.5,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.6,
          color: AppColors.textOnGold,
        ),
      ),
    );
  }
}

class _GoButton extends StatelessWidget {
  final double size;
  const _GoButton({required this.size});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        gradient: AppColors.goldGradient,
        shape: BoxShape.circle,
        boxShadow: [BoxShadow(color: AppColors.goldGlow, blurRadius: 12, offset: Offset(0, 4))],
      ),
      child: Icon(Icons.arrow_forward_rounded, color: AppColors.textOnGold, size: size * 0.46),
    );
  }
}

/// AI Foto kartı (2026-10-01): kullanıcının hazırladığı "Girdi → Sonuçlar"
/// kapak görseli. Kırpılmadan sığdırılır; kalan boşluk görselin kenar
/// renkleriyle dolar.
class _AiPhotoHubVisual extends StatelessWidget {
  const _AiPhotoHubVisual();

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFF511224), Color(0xFF42332C)],
        ),
      ),
      child: Image.asset(
        'assets/dating/modules/hub_ai_cover.jpg',
        fit: BoxFit.contain,
        errorBuilder: (_, _, _) => const SizedBox.shrink(),
      ),
    );
  }
}

/// Analiz kartı (2026-10-01): kullanıcının hazırladığı "Fotoğraf Analizi"
/// kapak görseli; kırpılmadan sığdırılır, boşluk görselin zemin rengiyle dolar.
class _AnalysisHubVisual extends StatelessWidget {
  const _AnalysisHubVisual();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0xFF4E1725),
      child: Image.asset(
        'assets/dating/modules/hub_analysis_cover.jpg',
        fit: BoxFit.contain,
        errorBuilder: (_, _, _) => const SizedBox.shrink(),
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
