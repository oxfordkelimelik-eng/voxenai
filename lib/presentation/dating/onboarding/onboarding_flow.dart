import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/dating_widgets.dart';
import 'funnel_screens.dart';
import '../widgets/legal_links.dart';
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

  // FUNNEL (2026-09-30, kullanıcının referans tasarımları): video öncesi 12
  // ekran ve form sonrası 2 "Sizden gelenler" ekranı. Tasarım kodla çizilir
  // (funnel_screens.dart); fotoğraflar tasarımlardan kesilmiş parçalardır.
  // → 25 adım (vücut tipi + boy AI foto üretiminde kullanılır).
  static const int _totalSteps = 25;
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
      () => _funnel1(), // 1
      () => _funnel2(), // 2
      () => _funnel3(), // 3
      () => _funnel4(), // 4
      () => _funnel5(), // 5
      () => _funnel6(), // 6
      () => _funnel7(), // 7
      () => _funnel8(), // 8
      () => _funnel9(), // 9
      () => _funnel10(), // 10
      () => _funnel11(), // 11
      () => _funnel12(), // 12
      () => _modulePhoto(), // 13 — AI foto generator tanıtımı (video)
      () => _moduleAnalysis(), // 14 — Foto skor analizi tanıtımı (video)
      () => _qGender(answers), // 15
      () => _qAge(answers), // 16
      () => _qBodyType(answers), // 17 — AI foto beden ipucu
      () => _qHeight(answers), // 18 — AI foto boy ipucu
      () => _qApps(answers), // 19
      () => _qMatches(answers), // 20
      // Form verileri girildikten SONRA (kullanıcı kararı):
      () => _funnel13(), // 21
      () => _funnel14(), // 22
      () => _authStep(), // 23 — Google/Apple ile giriş (formlar sonrası)
      () => _beforeAfter(), // 24 — 7 kat fazla eşleşme
      () => _preparing(), // 25
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

  // === FUNNEL EKRANLARI (kullanıcının referans tasarımları, kodla) ===
  // Bkz. funnel_screens.dart. `##..##` kırmızı vurgu, `**..**` kalın.
  Widget _fp({
    required List<String> headline,
    required Widget visual,
    required Size canvas,
    String? sub,
    String? subSmall,
    String? step,
    String cta = 'Devam Et',
    bool arrow = false,
    double headlineSize = 32,
  }) =>
      FunnelPage(
        headline: headline,
        sub: sub,
        subSmall: subSmall,
        step: step,
        visual: visual,
        canvas: canvas,
        cta: cta,
        ctaArrow: arrow,
        headlineSize: headlineSize,
        onNext: _next,
        onBack: _index == 0 ? null : _back,
      );

  Widget _funnel1() => _fp(
        headline: const [
          'Voxen\'e hoş geldin.',
          '##Milisaniyeler içerisinde##',
          '##sola kaydırılmaya SON.##',
        ],
        sub: '3D yüz taramasıyla yüzün aynı kalır ve sadece **3 dakika\'da** '
            'model kalitesinde fotolar üretilir.',
        visual: const WelcomeVisual(),
        canvas: WelcomeVisual.size,
        cta: 'Hemen Başla',
        headlineSize: 28,
      );

  Widget _funnel2() => _fp(
        headline: const ['Eşleşme', '##alamıyorsun.##'],
        sub: 'Belki **0**, belki 2-3 ama uygulamalarda eşleşme alamıyorsun.\n'
            '**3–4** kişiye mesaj atıyorsun, onlar da seni anında ghostluyor.',
        visual: const NoMatchVisual(),
        canvas: NoMatchVisual.size,
        headlineSize: 40,
      );

  Widget _funnel3() => _fp(
        headline: const ['Kendini', '##sorguluyorsun.##'],
        sub: 'Acaba çirkin miyim?\nFakir mi duruyorum yoksa?\nEzik miyim ben?',
        visual: const SelfDoubtVisual(),
        canvas: SelfDoubtVisual.size,
        headlineSize: 40,
      );

  Widget _funnel4() => _fp(
        headline: const [
          'Sorun sen değilsin.',
          '##Sorun uygulamaya##',
          '##adapte olamaman.##',
        ],
        sub: '1 kadına ortalama 3 erkek düşüyor\nve kadınlar erkeklere göre\n'
            'çok daha seçici davranıyor.',
        visual: const NotYouVisual(),
        canvas: NotYouVisual.size,
        arrow: true,
        headlineSize: 30,
      );

  Widget _funnel5() => _fp(
        headline: const [
          'En İyi %10,',
          '##Beğenilerin %60\'ını##',
          '##Alıyor.##',
        ],
        sub: 'En iyi %10 geri kalanlardan ortalama\n'
            '**13 kat** daha fazla beğeni topluyor.',
        visual: const TopTenVisual(),
        canvas: TopTenVisual.size,
      );

  Widget _funnel6() => _fp(
        headline: const [
          'Ve sağa kaydırma',
          '##kararı sadece##',
          '##0,1 saniyede veriliyor.##',
        ],
        sub: 'Sağ ya da Sol. Fotoğrafına baktığı ilk **0,1 saniyede** karar '
            'veriyor. Daha uzun baksa da fikri değişmiyor, sadece daha emin '
            'oluyor.',
        visual: const SwipeSecondVisual(),
        canvas: SwipeSecondVisual.size,
        headlineSize: 30,
      );

  Widget _funnel7() => _fp(
        headline: const [
          'Ve bu kararı etkileyen',
          '##en önemli şey##',
          '##fotoğrafın çekiciliği.##',
        ],
        sub: 'En iyi **%10** profiller, averaj profillerin aksine çekici '
            'ortamlarda düzgün ışıklandırma, pozlama ve stil içeriyor.',
        visual: const AttractivenessVisual(),
        canvas: AttractivenessVisual.size,
        headlineSize: 28,
      );

  Widget _funnel8() => _fp(
        headline: const [
          'Voxen Teknolojisi.',
          '##3D AI Yüz Teknolojisi##',
          '##ile tanışın.##',
        ],
        sub: 'Özel 3D Yüz Taramasıyla\nsadece 3 dakika\'da eşleşme sayınızı\n'
            'katlayacak fotoğraflar ürettirin.',
        visual: const WelcomeVisual(),
        canvas: WelcomeVisual.size,
        cta: 'Hemen Başla',
        headlineSize: 30,
      );

  Widget _funnel9() => _fp(
        headline: const ['Diğerlerinden', '##Üstün Teknoloji##'],
        sub: 'ChatGPT, Gemini aksine yüzünüzü\nhiperrealistik olarak üretir.\n'
            'Gerçekten ayırt edilmesi çok zordur.',
        visual: const CompareVisual(prefix: '09', rows: [
          ['Yapay durur', 'Detaylar eksiktir', 'Gerçekçi değildir'],
          [
            'Doğallıktan uzaktır',
            'Yüz detayları tutarsızdır',
            'Kolayca ayırt edilir'
          ],
          [
            'Hiperrealist sonuçlar',
            'Gerçek cilt dokusu',
            'Kolayca ayırt edilemez'
          ],
        ]),
        canvas: CompareVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 36,
      );

  Widget _funnel10() => _fp(
        headline: const ['Dating App', '##Optimize.##'],
        sub: 'Kadınların zevkine uygun ve optimize\n'
            '##100\'den fazla şablondan## seçilerek\nsize özel üretim yapılır.',
        subSmall: 'Diğer çözümlerde ve yapay zeka modellerinde bu optimizasyon '
            'bulunmamaktadır.',
        visual: const CompareVisual(prefix: '10', rows: [
          [
            'Dating odaklı değil',
            'Kadın zevkine uygun değil',
            'Optimize edilmemiş',
            'Standart ve sıradan sonuçlar'
          ],
          [
            'Dating odaklı değil',
            'Kadın zevkine uygun değil',
            'Optimize edilmemiş',
            'Standart ve sıradan sonuçlar'
          ],
          [
            'Dating odaklı optimize',
            'Kadın zevkine uygun',
            '100+ özel şablon',
            'Size özel, kaliteli sonuçlar'
          ],
        ]),
        canvas: CompareVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 40,
      );

  Widget _funnel11() => _fp(
        step: 'Adım - 1',
        headline: const ['Selfie ile', '##Yüz Taraması##', 'Yaptırın.'],
        visual: const FaceScanVisual(),
        canvas: FaceScanVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 36,
      );

  Widget _funnel12() => _fp(
        step: 'Adım - 3',
        headline: const ['Sonuç:', '##Dating App Optimize##'],
        sub: 'Kadınların zevkine uygun ve optimize\nfotoğraflar elde edersiniz.',
        subSmall: 'HD bir şekilde indirip kullanmaya başlayabilirsiniz.',
        visual: const ResultVisual(),
        canvas: ResultVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 34,
      );

  Widget _funnel13() => _fp(
        headline: const ['Sizden ##Gelenler##'],
        sub: 'Voxen AI ile binlerce kişi daha fazla eşleşme alıyor.',
        visual: const TestimonialVisual(),
        canvas: TestimonialVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 40,
      );

  Widget _funnel14() => _fp(
        headline: const ['Sizden ##Gelenler##'],
        sub: 'Voxen AI ile binlerce kişi daha fazla eşleşme alıyor.',
        visual: const TestimonialListVisual(),
        canvas: TestimonialListVisual.size,
        cta: 'Hemen Başla',
        arrow: true,
        headlineSize: 40,
      );

  // === EKRAN 13 — AI foto generator tanıtımı (demo video + açıklama) ===
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

  // === EKRAN 14 — Foto skor analizi modülü tanıtımı (demo video + açıklama) ===
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

  // === EKRAN 15 — Soru: Cinsiyet ===
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

  // === EKRAN 16 — Soru: Yaş (Under 18 → durdur) ===
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

  // === EKRAN 20 — Soru: Günlük eşleşme ===
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

  // === EKRAN 23 — Formlar sonrası Google/Apple ile giriş (ZORUNLU) ===
  Widget _authStep() => _AuthOnboardingScreen(
        signedIn: _signedIn,
        onSignedIn: () {
          setState(() => _signedIn = true);
          _next();
        },
      );

  // === EKRAN 24 — 7.4x (dikey bar grafiği: beğeni oranı %) ===
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

  // === EKRAN 25 — Hazırlanıyor (loading) → modül vitrini ===
  Widget _preparing() => _PreparingScreen(onDone: _finish);

  Widget _opt(String label, bool selected, VoidCallback onTap) =>
      ChoiceOption(label: label, selected: selected, onTap: onTap);
}

// ============================================================
// EKRAN 23 — Formlar sonrası Google/Apple ile giriş — ZORUNLU.
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
                    const SizedBox(height: 22),
                    // Hesap oluşturma noktasında Şartlar/Politika ERİŞİLEBİLİR
                    // olmalı (App Store 5.1.1) — bkz. LegalLinksText.
                    const LegalLinksText(),
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
              'Fotoğraflarımın AI foto üretimi, kalite kontrolü ve fotoğraf '
              'analizi için OpenAI\'a gönderilmesine ve yalnızca bu işlemler '
              'için işlenmesine açık rıza veriyorum. (KVKK/GDPR)',
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
