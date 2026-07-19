import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/dating_widgets.dart';
import '../widgets/voxen_visuals.dart';

/// VOXEN AI onboarding funnel'ı (Bölüm 1 & 2).
/// Tek yönlü stack: PageView + üstte logo & ilerleme çubuğu. Klavye açılmaz.
/// Düzen: EN ÜSTTE VOXEN AI logosu → ORTADA görsel → BÜYÜK başlık + açıklama
/// → EN ALTTA kırmızı "Devam Et" butonu.
class OnboardingFlow extends ConsumerStatefulWidget {
  const OnboardingFlow({super.key});
  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  final _pc = PageController();
  int _index = 0;
  bool _blockedUnder18 = false;

  // Sorular: cinsiyet, yaş, vücut tipi, boy, uygulamalar, eşleşme + auth…
  // → 16 adım (vücut tipi + boy AI foto üretiminde kullanılır).
  static const int _totalSteps = 16;
  bool _signedIn = false;

  void _next() {
    if (_index >= _totalSteps - 1) {
      _finish();
      return;
    }
    setState(() => _index++);
    _pc.animateToPage(_index,
        duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
  }

  void _back() {
    if (_index == 0) return;
    setState(() => _index--);
    _pc.animateToPage(_index,
        duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
  }

  Future<void> _finish() async {
    await markDatingOnboardingDone();
    if (mounted) context.go(DatingRoutes.modules);
  }

  @override
  void dispose() {
    _pc.dispose();
    super.dispose();
  }

  double get _progress => (_index + 1) / _totalSteps;

  @override
  Widget build(BuildContext context) {
    if (_blockedUnder18) return const _Under18Block();

    final answers = ref.watch(datingAnswersProvider);

    final steps = <Widget Function()>[
      () => _welcome(), // 1
      () => _frustration(), // 2  — Kullanıcıların %89'u hayal kırıklığında
      () => _competition(), // 3
      () => _solution(), // 4
      () => _modulePhoto(), // 5  — AI foto generator tanıtımı (video)
      () => _moduleAnalysis(), // 6  — Foto skor analizi tanıtımı (video)
      () => _qGender(answers), // 7
      () => _qAge(answers), // 8
      () => _qBodyType(answers), // 9 — AI foto beden ipucu
      () => _qHeight(answers), // 10 — AI foto boy ipucu
      () => _qApps(answers), // 11
      () => _qMatches(answers), // 12
      () => _authStep(), // 13 — Google/Apple ile giriş (formlar sonrası)
      () => _beforeAfter(), // 14 — 7 kat fazla eşleşme
      () => _top1Review(), // 15
      () => _preparing(), // 16
    ];

    return PopScope(
      canPop: false,
      child: PageView.builder(
        controller: _pc,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: _totalSteps,
        itemBuilder: (_, i) => steps[i](),
      ),
    );
  }

  // ---- Bilgi ekranı çerçevesi (logo → görsel → başlık → açıklama → buton) ----
  Widget _info({
    required Widget visual,
    required String title,
    String? subtitle,
    bool canContinue = true,
    String button = 'Devam Et',
    VoidCallback? onContinue,
  }) {
    return OnboardingScaffold(
      progress: _progress,
      onBack: _index == 0 ? null : _back,
      visual: visual,
      title: title,
      subtitle: subtitle,
      buttonLabel: button,
      onContinue: canContinue ? (onContinue ?? _next) : null,
    );
  }

  // ---- Quiz ekranı çerçevesi (logo → soru + seçenekler → buton) ----
  Widget _quiz({
    required Widget child,
    required bool canContinue,
    VoidCallback? onContinue,
  }) {
    return OnboardingScaffold(
      progress: _progress,
      onBack: _index == 0 ? null : _back,
      onContinue: canContinue ? (onContinue ?? _next) : null,
      child: child,
    );
  }

  // === EKRAN 1 — Karşılama (ÖZEL: kırmızı arka plan + telefon + kalpler) ===
  Widget _welcome() => _WelcomeScreen(onStart: _next);

  // === EKRAN 2 — Frustrasyon (ortada animasyonlu birleşik marka logoları) ===
  Widget _frustration() => _info(
        visual: const AnimatedBrandCluster(logoSize: 132),
        title: 'Kullanıcıların %89\'u hayal kırıklığında',
        subtitle:
            'Bu dating uygulamalarında bir gerçek var: çoğu kişi memnun değil.',
      );

  // === EKRAN 4 — Rekabet gerçeği + grafik ===
  Widget _competition() => _info(
        visual: const AnimatedBarChart(
          caption: 'Eşleşmelerin dağılımı (profil sıralamasına göre)',
          data: [
            BarDatum('En üstteki %10 profil', 78, highlight: true),
            BarDatum('Ortadaki %40 profil', 18),
            BarDatum('Alttaki %50 profil', 4),
          ],
        ),
        title: 'Eşleşmeler en iyi profillere gidiyor',
        subtitle:
            'En iyi profile sahip olmadan bu markette başarı elde etmek zor.',
      );

  // === EKRAN 5 — Biz buradayız (ortada logo + arkada silik It's a Match) ===
  Widget _solution() => _info(
        visual: const ItsAMatchBackdropLogo(logoSize: 130),
        title: 'İşte tam bu yüzden buradayız',
        subtitle: 'Seni bu marketin en üstüne taşımak için.',
      );

  // === EKRAN 5 — AI foto generator tanıtımı (demo video + açıklama) ===
  Widget _modulePhoto() => _info(
        visual: const DemoVideoPhone(
          asset: 'assets/videos/ai_photo_demo.mp4',
          width: 205,
          fallbackIcon: Icons.auto_awesome,
          fallbackLabel: 'Foto yükle → AI yeni\nfotoğraflarını üretsin',
        ),
        title: 'Sana en iyi profili biz kuruyoruz',
        subtitle:
            'En güçlü yapay zeka modelleri ile en çok eşleşme yakalayacak '
            'profilleri oluşturuyoruz.',
      );

  // === EKRAN 7 — Foto skor analizi modülü tanıtımı (demo video + açıklama) ===
  Widget _moduleAnalysis() => _info(
        visual: const DemoVideoPhone(
          asset: 'assets/videos/analysis_demo.mp4',
          width: 205,
          fallbackIcon: Icons.insights_rounded,
          fallbackLabel: 'Fotoğraflarını yükle →\nen iyi kareyi seçelim',
        ),
        title: 'En çok eşleşme getirecek kareyi seç',
        subtitle:
            'Yüklediğin fotoğrafa göre seni analiz ediyoruz. Sana maksimum '
            'eşleşme aldıracak öneriler sunuyoruz.',
      );

  // === EKRAN 7 — Soru: Cinsiyet ===
  Widget _qGender(DatingAnswers a) => _quiz(
        canContinue: a.gender != null,
        child: _QuizBlock(
          intro: 'Şimdi sana birkaç soru soralım — sana en uygun deneyimi '
              'hazırlayabilmemiz için.',
          title: 'Cinsiyetin nedir?',
          child: Column(
            children: [
              _opt('Erkek', a.gender == 'male',
                  () => ref.read(datingAnswersProvider.notifier).setGender('male')),
              _opt('Kadın', a.gender == 'female',
                  () => ref.read(datingAnswersProvider.notifier).setGender('female')),
              _opt('Belirtmek istemiyorum', a.gender == 'na',
                  () => ref.read(datingAnswersProvider.notifier).setGender('na')),
            ],
          ),
        ),
      );

  // === EKRAN 8 — Soru: Yaş (Under 18 → durdur) ===
  Widget _qAge(DatingAnswers a) {
    const ranges = [
      ['under18', '18 yaş altı'],
      ['18-24', '18–24'],
      ['25-34', '25–34'],
      ['35-44', '35–44'],
      ['45-54', '45–54'],
      ['55-64', '55–64'],
      ['64+', '64+'],
    ];
    return _quiz(
      canContinue: a.ageRange != null,
      onContinue: () {
        if (a.ageRange == 'under18') {
          setState(() => _blockedUnder18 = true);
        } else {
          _next();
        }
      },
      child: _QuizBlock(
        title: 'Yaş aralığın?',
        child: Column(
          children: [
            for (final r in ranges)
              _opt(r[1], a.ageRange == r[0],
                  () => ref.read(datingAnswersProvider.notifier).setAgeRange(r[0])),
          ],
        ),
      ),
    );
  }

  // === Soru: Vücut tipi (AI foto üretiminde ikincil beden ipucu) ===
  Widget _qBodyType(DatingAnswers a) {
    const opts = [
      ['slim', 'İnce'],
      ['athletic', 'Atletik / sporcu'],
      ['average', 'Ortalama'],
      ['solid', 'Dolgun'],
    ];
    return _quiz(
      canContinue: a.bodyType != null,
      child: _QuizBlock(
        title: 'Vücut tipin hangisine daha yakın?',
        subtitle: 'AI fotoğraflarında oranını doğru tutmak için kullanılır.',
        child: Column(
          children: [
            for (final o in opts)
              _opt(o[1], a.bodyType == o[0],
                  () => ref.read(datingAnswersProvider.notifier).setBodyType(o[0])),
          ],
        ),
      ),
    );
  }

  // === Soru: Boy aralığı ===
  Widget _qHeight(DatingAnswers a) {
    const ranges = [
      ['under160', '160 cm altı'],
      ['160-165', '160–165 cm'],
      ['165-170', '165–170 cm'],
      ['170-175', '170–175 cm'],
      ['175-180', '175–180 cm'],
      ['180-185', '180–185 cm'],
      ['185-190', '185–190 cm'],
      ['190+', '190 cm ve üzeri'],
    ];
    return _quiz(
      canContinue: a.heightRange != null,
      child: _QuizBlock(
        title: 'Boyun hangi aralıkta?',
        subtitle: 'Tam boy fotoğraflarda oran için kullanılır; fotoğraf her zaman önceliklidir.',
        child: Column(
          children: [
            for (final r in ranges)
              _opt(r[1], a.heightRange == r[0],
                  () =>
                      ref.read(datingAnswersProvider.notifier).setHeightRange(r[0])),
          ],
        ),
      ),
    );
  }

  // === Soru: Uygulamalar (çoklu seçim) ===
  Widget _qApps(DatingAnswers a) {
    const apps = [
      'Tinder', 'Bumble', 'Hinge', 'Badoo',
      'OkCupid', 'Coffee Meets Bagel', 'Grindr', 'Diğer'
    ];
    return _quiz(
      canContinue: a.apps.isNotEmpty,
      child: _QuizBlock(
        title: 'En çok kullandığın dating uygulaması?',
        subtitle: 'Birden fazla seçebilirsin.',
        child: Column(
          children: [
            for (final app in apps)
              ChoiceOption(
                label: app,
                selected: a.apps.contains(app),
                multi: true,
                onTap: () =>
                    ref.read(datingAnswersProvider.notifier).toggleApp(app),
              ),
          ],
        ),
      ),
    );
  }

  // === EKRAN 10 — Soru: Günlük eşleşme ===
  Widget _qMatches(DatingAnswers a) {
    const opts = [
      ['none', 'Hiç yok / 1 tane bile değil'],
      ['1-2', 'Günlük 1–2'],
      ['3-10', 'Günlük 3–10'],
      ['10+', 'Günlük 10+'],
    ];
    return _quiz(
      canContinue: a.matchesPerDay != null,
      child: _QuizBlock(
        title: 'Günde kaç eşleşme alıyorsun?',
        child: Column(
          children: [
            for (final o in opts)
              _opt(o[1], a.matchesPerDay == o[0],
                  () => ref.read(datingAnswersProvider.notifier).setMatches(o[0])),
          ],
        ),
      ),
    );
  }

  // === EKRAN 11 — Formlar sonrası Google/Apple ile giriş (ZORUNLU) ===
  Widget _authStep() => _AuthOnboardingScreen(
        signedIn: _signedIn,
        onSignedIn: () {
          setState(() => _signedIn = true);
          _next();
        },
      );

  // === EKRAN 14 — 7.4x (dikey bar grafiği: beğeni oranı %) ===
  Widget _beforeAfter() => _info(
        visual: const VerticalBarChart(
          caption: 'Beğeni / eşleşme oranı',
          data: [
            BarDatum2('Bizden önce', 12, '%12'),
            BarDatum2('VOXEN AI', 89, '%89', highlight: true),
          ],
        ),
        title: 'Bizimle birlikte günde 7 kat fazla eşleşme',
        subtitle: 'Farkı hisset — veya iade al.',
      );

  // === EKRAN 15 — Top %1 + önce/sonra telefon + yorum (arkada foto) ===
  Widget _top1Review() => _info(
        visual: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const BeforeAfterPhones(),
            const SizedBox(height: 20),
            // Yorum kartı — arkasında silik gerçek profil fotosu
            ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Opacity(
                      opacity: 0.18,
                      child: VoxenPhoto(index: 3),
                    ),
                  ),
                  Container(
                    decoration: BoxDecoration(
                      color: AppColors.surface.withValues(alpha: 0.82),
                      border: Border.all(color: AppColors.borderGold),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: List.generate(
                              5,
                              (_) => const Icon(Icons.star_rounded,
                                  color: AppColors.gold, size: 22)),
                        ),
                        const SizedBox(height: 10),
                        const Text(
                            '"İlk haftada eşleşmelerim ikiye katlandı."',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                                fontSize: 15,
                                fontStyle: FontStyle.italic,
                                fontWeight: FontWeight.w600,
                                color: AppColors.textPrimary)),
                        const SizedBox(height: 8),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            ClipOval(
                              child: SizedBox(
                                  width: 22,
                                  height: 22,
                                  child: VoxenPhoto(index: 5, male: true)),
                            ),
                            const SizedBox(width: 6),
                            const Text('Kaan, 27',
                                style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w800,
                                    color: AppColors.textSecondary)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        title: 'Dating marketinin top %1\'ine gir',
        subtitle: 'Bizimle birlikte en üst lige çık.',
      );

  // === EKRAN 14 — Hazırlanıyor (loading) → modül vitrini ===
  Widget _preparing() => _PreparingScreen(onDone: _finish);

  Widget _opt(String label, bool selected, VoidCallback onTap) =>
      ChoiceOption(label: label, selected: selected, onTap: onTap);
}

// ============================================================
// EKRAN 11 — Formlar sonrası Google/Apple ile giriş — ZORUNLU.
// Giriş yapmadan sisteme (hub/modüller) girilemez. Önce KVKK/GDPR açık
// rıza onayı alınır, ardından giriş butonları etkinleşir.
// ============================================================
class _AuthOnboardingScreen extends ConsumerStatefulWidget {
  final bool signedIn;
  final VoidCallback onSignedIn;
  const _AuthOnboardingScreen({
    required this.signedIn,
    required this.onSignedIn,
  });

  @override
  ConsumerState<_AuthOnboardingScreen> createState() =>
      _AuthOnboardingScreenState();
}

class _AuthOnboardingScreenState
    extends ConsumerState<_AuthOnboardingScreen> {
  bool _busy = false;
  bool _consent = false;

  Future<void> _signIn(String provider) async {
    if (!_consent) return;
    setState(() => _busy = true);
    if (!ref.read(entitlementProvider).consentGiven) {
      await ref.read(entitlementProvider.notifier).giveConsent();
    }
    String? errorDetail;
    try {
      await ref.read(entitlementProvider.notifier).signIn(provider);
    } catch (e) {
      errorDetail = e.toString();
    }
    if (!mounted) return;
    setState(() => _busy = false);
    final signedIn = ref.read(entitlementProvider).isSignedIn;
    if (!signedIn) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(errorDetail ?? 'Giriş tamamlanamadı. Lütfen tekrar dene.'),
        duration: const Duration(seconds: 6),
      ));
      return;
    }
    widget.onSignedIn();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 16),
              child: VoxenWordmark(fontSize: 22),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 24),
                    const Icon(Icons.lock_person_rounded,
                        color: AppColors.gold, size: 48),
                    const SizedBox(height: 20),
                    const Text('Hesabını oluştur',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary)),
                    const SizedBox(height: 8),
                    const Text(
                        'Ürettiklerin, cihaz değişse bile kaybolmasın. '
                        'Devam etmek için giriş yapman gerekiyor.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: 14,
                            color: AppColors.textSecondary,
                            height: 1.4)),
                    const SizedBox(height: 28),
                    _consentRow(),
                    const SizedBox(height: 20),
                    // Apple, "Google ile giris" sunan uygulamalarda "Apple
                    // ile giris"i de ZORUNLU tutar (App Store Review 4.8) —
                    // bu yuzden Apple butonu ilk sirada.
                    _AuthButton(
                      label: 'Apple ile Giriş Yap',
                      icon: Icons.apple,
                      bg: Colors.white,
                      fg: Colors.black,
                      onTap: (_busy || !_consent)
                          ? null
                          : () => _signIn('apple'),
                    ),
                    const SizedBox(height: 12),
                    _AuthButton(
                      label: 'Google ile Giriş Yap',
                      icon: Icons.g_mobiledata_rounded,
                      bg: AppColors.surfaceElevated,
                      fg: AppColors.textPrimary,
                      onTap: (_busy || !_consent)
                          ? null
                          : () => _signIn('google'),
                    ),
                    if (_busy) ...[
                      const SizedBox(height: 24),
                      const Center(
                          child: CircularProgressIndicator(
                              color: AppColors.gold)),
                    ],
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _consentRow() {
    return GestureDetector(
      onTap: () => setState(() => _consent = !_consent),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
              _consent
                  ? Icons.check_box_rounded
                  : Icons.check_box_outline_blank_rounded,
              color: _consent ? AppColors.gold : AppColors.textMuted),
          const SizedBox(width: 10),
          const Expanded(
            child: Text(
              'Fotoğraflarımın yalnızca analiz ve üretim için işlenmesine '
              'açık rıza veriyorum. (KVKK/GDPR)',
              style: TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                  height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _AuthButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color bg;
  final Color fg;
  final VoidCallback? onTap;
  const _AuthButton({
    required this.label,
    required this.icon,
    required this.bg,
    required this.fg,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 54,
      child: ElevatedButton.icon(
        onPressed: onTap,
        icon: Icon(icon, color: fg, size: 26),
        label: Text(label,
            style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w700, color: fg)),
        style: ElevatedButton.styleFrom(
          backgroundColor: bg,
          disabledBackgroundColor: bg.withValues(alpha: 0.5),
          elevation: 0,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
    );
  }
}

// ============================================================
// EKRAN 1 — KARŞILAMA (özel kırmızı tasarım)
// EN ÜSTTE: VOXEN AI logosu · ORTADA: telefon içinde kayan eşleşmeler +
// arkada kalpler · ALTTA: büyük "VOXEN AI'a Hoş Geldiniz" + açıklama +
// en altta büyük buton.
// ============================================================
class _WelcomeScreen extends StatelessWidget {
  final VoidCallback onStart;
  const _WelcomeScreen({required this.onStart});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
            gradient: AppColors.brandRedBackground),
        child: SafeArea(
          child: Column(
            children: [
              // EN ÜSTTE: logo
              const Padding(
                padding: EdgeInsets.only(top: 12, bottom: 4),
                child: VoxenWordmark(fontSize: 24, onRed: true),
              ),
              // ORTADA: Tinder tarzı blurlu eşleşme duvarı + kalpler
              Expanded(
                child: FloatingHeartsBackground(
                  child: const Padding(
                    padding: EdgeInsets.fromLTRB(14, 4, 14, 4),
                    child: BlurredMatchesWall(),
                  ),
                ),
              ),
              // ALTTA: büyük karşılama + açıklama
              const Padding(
                padding: EdgeInsets.fromLTRB(24, 8, 24, 4),
                child: Text(
                  'VOXEN AI\'a Hoş Geldiniz',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 30,
                      fontWeight: FontWeight.w900,
                      color: Colors.white,
                      height: 1.1),
                ),
              ),
              const Padding(
                padding: EdgeInsets.fromLTRB(28, 0, 28, 16),
                child: Text(
                  'Bumble, Tinder ve Hinge\'de daha fazla eşleşme almak için '
                  'ilk adımı atın.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 14, color: Colors.white70, height: 1.4),
                ),
              ),
              // EN ALTTA: büyük buton (kırmızı zemin üstünde beyaz buton, güçlü CTA)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 22),
                child: SizedBox(
                  width: double.infinity,
                  height: 60,
                  child: ElevatedButton(
                    onPressed: onStart,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: AppColors.goldDark,
                      elevation: 10,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(18)),
                    ),
                    child: const Text('Haydi Başlayalım',
                        style: TextStyle(
                            fontSize: 21,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 0.5)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Quiz sorusu düzeni: opsiyonel intro + başlık + (alt başlık) + seçenekler.
class _QuizBlock extends StatelessWidget {
  final String? intro;
  final String title;
  final String? subtitle;
  final Widget child;
  const _QuizBlock({
    this.intro,
    required this.title,
    this.subtitle,
    required this.child,
  });
  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (intro != null) ...[
          Text(intro!,
              style: const TextStyle(
                  fontSize: 14,
                  color: AppColors.textSecondary,
                  height: 1.45)),
          const SizedBox(height: 20),
        ],
        Text(title,
            style: const TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary,
                height: 1.2)),
        if (subtitle != null) ...[
          const SizedBox(height: 6),
          Text(subtitle!,
              style: const TextStyle(
                  fontSize: 14, color: AppColors.textSecondary)),
        ],
        const SizedBox(height: 20),
        child,
      ],
    );
  }
}


/// "Under 18" güvenlik durdurma ekranı (Bölüm 2 — zorunlu).
class _Under18Block extends StatelessWidget {
  const _Under18Block();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: const [
                Icon(Icons.lock_outline_rounded,
                    color: AppColors.gold, size: 64),
                SizedBox(height: 24),
                Text('Bu uygulama 18 yaş ve üzeri\nkullanıcılar içindir.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary,
                        height: 1.4)),
                SizedBox(height: 12),
                Text('Katılımın için teşekkürler.',
                    style: TextStyle(
                        fontSize: 14, color: AppColors.textSecondary)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "Senin için hazırlıyoruz" loading ekranı (Bölüm 4 — girişsiz).
class _PreparingScreen extends StatefulWidget {
  final VoidCallback onDone;
  const _PreparingScreen({required this.onDone});
  @override
  State<_PreparingScreen> createState() => _PreparingScreenState();
}

class _PreparingScreenState extends State<_PreparingScreen> {
  final _steps = const [
    'Profilin analiz ediliyor…',
    'Fotoğraf önerileri hesaplanıyor…',
    'Sana özel modüller hazırlanıyor…',
  ];
  int _i = 0;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 1300), (t) {
      if (!mounted) return;
      if (_i >= _steps.length - 1) {
        t.cancel();
        Future.delayed(const Duration(milliseconds: 900), widget.onDone);
      } else {
        setState(() => _i++);
      }
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 16),
              child: VoxenWordmark(fontSize: 22),
            ),
            Expanded(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox(
                      width: 72,
                      height: 72,
                      child: CircularProgressIndicator(
                          strokeWidth: 5, color: AppColors.gold),
                    ),
                    const SizedBox(height: 32),
                    const Text('Senin için hazırlıyoruz…',
                        style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary)),
                    const SizedBox(height: 20),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 400),
                      child: Text(_steps[_i],
                          key: ValueKey(_i),
                          style: const TextStyle(
                              fontSize: 14, color: AppColors.textSecondary)),
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
