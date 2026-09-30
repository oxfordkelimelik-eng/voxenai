import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';
import '../widgets/dating_widgets.dart';
import '../widgets/funnel_visuals.dart';
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

  // Video-öncesi funnel (2026-09-28, kullanıcı referans görselleri):
  // karşılama → hayal kırıklığı → kuşku → yeniden çerçeveleme → veri →
  // 0,1sn karar → foto çekiciliği → teknoloji köprüsü → AI karşılaştırma →
  // optimize → sosyal kanıt → (sonra) video modülleri → sorular + auth…
  // "Sizden gelenler" ve "Çıktılar" form sorularından SONRA gelir.
  // → 23 adım (vücut tipi + boy AI foto üretiminde kullanılır).
  static const int _totalSteps = 23;
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
      () => _frustration(), // 2  — "Eşleşme alamıyorsun"
      () => _selfDoubt(), // 3  — "Kendini sorguluyorsun"
      () => _reframe(), // 4  — "Sorun sen değilsin"
      () => _competition(), // 5  — en iyi %10, beğenilerin %60'ı
      () => _swipeDecision(), // 6  — 0,1 saniyede karar
      () => _photoMatters(), // 7  — fotoğraf çekiciliği en önemli faktör
      () => _solution(), // 8  — "3D AI Yüz Teknolojisi ile tanış" (köprü)
      () => _aiComparison(), // 9  — ChatGPT/Gemini karşısında Voxen AI
      () => _datingOptimize(), // 10 — dating'e özel optimizasyon
      () => _modulePhoto(), // 11 — AI foto generator tanıtımı (video)
      () => _moduleAnalysis(), // 12 — Foto skor analizi tanıtımı (video)
      () => _qGender(answers), // 13
      () => _qAge(answers), // 14
      () => _qBodyType(answers), // 15 — AI foto beden ipucu
      () => _qHeight(answers), // 16 — AI foto boy ipucu
      () => _qApps(answers), // 17
      () => _qMatches(answers), // 18
      // Form verileri girildikten SONRA (2026-09-28 kullanıcı kararı):
      () => _socialProof(), // 19 — "Sizden gelenler" (önce/sonra)
      () => _outputs(), // 20 — örnek çıktılar (4 stil)
      () => _authStep(), // 21 — Google/Apple ile giriş (formlar sonrası)
      () => _beforeAfter(), // 22 — 7 kat fazla eşleşme
      () => _preparing(), // 23
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

  // === EKRAN 2 — "Eşleşme alamıyorsun" (kırık kalp + ghostlanan mesajlar) ===
  Widget _frustration() => _info(
        visual: const BrokenHeartCounter(),
        title: 'Eşleşme alamıyorsun',
        subtitle: 'Belki 0, belki 2-3 tane uygulamalarda eşleşme alamıyorsun. '
            '3-4 kişiye mesaj atıyorsun, onlar da seni anında ghostluyor.',
      );

  // === EKRAN 3 — "Kendini sorguluyorsun" (kuşku balonları) ===
  Widget _selfDoubt() => _info(
        visual: const DoubtBubblesCloud(),
        title: 'Kendini sorguluyorsun',
      );

  // === EKRAN 4 — "Sorun sen değilsin" (1 kadına 3 erkek oranı) ===
  Widget _reframe() => _info(
        visual: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            GenderRatioComparison(),
            SizedBox(height: 10),
            RepresentativeNote(),
          ],
        ),
        title: 'Sorun sen değilsin',
        subtitle: 'Sorun uygulamaya adapte olamaman. 1 kadına ortalama 3 '
            'erkek düşüyor ve kadınlar erkeklere göre çok daha seçici '
            'davranıyor.',
      );

  // === EKRAN 5 — En iyi %10, beğenilerin %60'ını alıyor (bar grafiği) ===
  Widget _competition() => _info(
        visual: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            VerticalBarChart(
              caption: 'Haftalık ort. beğeni sayısı',
              data: [
                BarDatum2('%10', 3, '3'),
                BarDatum2('%20', 5, '5'),
                BarDatum2('%30', 6, '6'),
                BarDatum2('%40', 8, '8'),
                BarDatum2('%50', 10, '10'),
                BarDatum2('%60', 13, '13'),
                BarDatum2('%70', 17, '17'),
                BarDatum2('%80', 20, '20'),
                BarDatum2('En iyi\n%10', 39, '39', highlight: true),
              ],
            ),
            SizedBox(height: 10),
            RepresentativeNote(),
          ],
        ),
        title: 'En iyi %10, beğenilerin %60\'ını alıyor',
        subtitle:
            'En iyi %10 profil, geri kalanlara göre ortalama 13 kat daha '
            'fazla beğeni topluyor.',
      );

  // === EKRAN 6 — Sağa kaydırma kararı 0,1 saniyede veriliyor ===
  Widget _swipeDecision() => _info(
        visual: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SwipeDecisionDemo(),
            SizedBox(height: 10),
            RepresentativeNote(),
          ],
        ),
        title: 'Kaydırma kararı sadece 0,1 saniyede veriliyor',
        subtitle: 'Sağ ya da sol, fotoğrafına baktığı ilk 0,1 saniyede karar '
            'veriyor. Daha uzun bakıyorsa bile fikri değişmiyor, sadece '
            'daha emin oluyor.',
      );

  // === EKRAN 7 — Bu kararı etkileyen en önemli şey: fotoğrafın çekiciliği ===
  Widget _photoMatters() => _info(
        visual: const ProfileAttractivenessCompare(),
        title: 'En önemli şey fotoğrafının çekiciliği',
        subtitle:
            'En iyi %10 profil, ortalama profilin aksine güzel ortamda, iyi '
            'ışıkla, doğru poz ve stille çekiliyor.',
      );

  // === EKRAN 8 — Köprü: "3D AI Yüz Teknolojisi ile tanış" ===
  Widget _solution() => _info(
        visual: const ItsAMatchBackdropLogo(logoSize: 130),
        title: '3D AI Yüz Teknolojisi ile tanış',
        subtitle: 'Özel 3D yüz taramasıyla sadece 3 dakikada eşleşme '
            'sayını katlayacak fotoğraflar üretiyoruz.',
      );

  // === EKRAN 9 — ChatGPT / Gemini karşısında Voxen AI (hiperrealizm) ===
  Widget _aiComparison() => _info(
        visual: const AiComparisonTable(
          columns: [
            ComparisonColumn('ChatGPT', [
              ComparisonRow('Yapay durur'),
              ComparisonRow('Detaylar eksik'),
              ComparisonRow('Gerçekçi değil'),
            ]),
            ComparisonColumn('Gemini', [
              ComparisonRow('Gerçeklikten uzak'),
              ComparisonRow('Yüz detayları tutarsız'),
              ComparisonRow('Kolayca ayırt edilir'),
            ]),
            ComparisonColumn(
              'Voxen AI',
              [
                ComparisonRow('Hiperrealist sonuçlar', positive: true),
                ComparisonRow('Gerçek cilt dokusu', positive: true),
                ComparisonRow('Kolayca ayırt edilemez', positive: true),
              ],
              highlight: true,
            ),
          ],
        ),
        title: 'Diğerlerinden üstün teknoloji',
        subtitle: 'ChatGPT ve Gemini\'nin aksine yüzünü hiperrealistik '
            'üretiyoruz. Gerçekten ayırt edilmesi çok zor.',
      );

  // === EKRAN 10 — Dating app'e özel optimizasyon ===
  Widget _datingOptimize() => _info(
        visual: const AiComparisonTable(
          columns: [
            ComparisonColumn('ChatGPT', [
              ComparisonRow('Dating odaklı değil'),
              ComparisonRow('Kadın zevkine uygun değil'),
              ComparisonRow('Optimize edilmemiş'),
            ]),
            ComparisonColumn('Gemini', [
              ComparisonRow('Dating odaklı değil'),
              ComparisonRow('Kadın zevkine uygun değil'),
              ComparisonRow('Optimize edilmemiş'),
            ]),
            ComparisonColumn(
              'Voxen AI',
              [
                ComparisonRow('Dating\'e özel optimize', positive: true),
                ComparisonRow('Kadın zevkine uygun', positive: true),
                ComparisonRow('Sana özel, kaliteli sonuç', positive: true),
              ],
              highlight: true,
            ),
          ],
        ),
        title: 'Dating app\'e göre optimize',
        subtitle:
            'Kadınların zevkine uygun, 100\'den fazla şablondan seçilerek '
            'sana özel üretim yapılır.',
      );

  // === EKRAN 19 — Sosyal kanıt: önce/sonra (form sonrası) ===
  Widget _socialProof() => _info(
        visual: const MatchesBeforeAfterPhone(),
        title: 'Sizden gelenler',
        subtitle: 'Voxen AI ile kullanıcılarımız çok daha fazla eşleşme '
            'alıyor.',
      );

  // === EKRAN 20 — Örnek çıktılar: 4 stil (form sonrası) ===
  Widget _outputs() => _info(
        visual: const StyleOutputsGallery(),
        title: 'Seni bekleyen fotoğraflar',
        subtitle: 'Elegance, Date Night, Traveller ve Old Money — '
            'istediğin stilde, yüzün aynı kalarak üretilir.',
      );

  // === EKRAN 11 — AI foto generator tanıtımı (demo video + açıklama) ===
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

  // === EKRAN 12 — Foto skor analizi modülü tanıtımı (demo video + açıklama) ===
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

  // === EKRAN 13 — Soru: Cinsiyet ===
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

  // === EKRAN 14 — Soru: Yaş (Under 18 → durdur) ===
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

  // === EKRAN 18 — Soru: Günlük eşleşme ===
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

  // === EKRAN 21 — Formlar sonrası Google/Apple ile giriş (ZORUNLU) ===
  Widget _authStep() => _AuthOnboardingScreen(
        signedIn: _signedIn,
        onSignedIn: () {
          setState(() => _signedIn = true);
          _next();
        },
      );

  // === EKRAN 22 — 7.4x (dikey bar grafiği: beğeni oranı %) ===
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

  // === EKRAN 23 — Hazırlanıyor (loading) → modül vitrini ===
  Widget _preparing() => _PreparingScreen(onDone: _finish);

  Widget _opt(String label, bool selected, VoidCallback onTap) =>
      ChoiceOption(label: label, selected: selected, onTap: onTap);
}

// ============================================================
// EKRAN 21 — Formlar sonrası Google/Apple ile giriş — ZORUNLU.
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

// ============================================================
// EKRAN 1 — KARŞILAMA (özel kırmızı tasarım)
// EN ÜSTTE: VOXEN AI logosu · ORTADA: telefon içinde kayan eşleşmeler +
// arkada kalpler · ALTTA: büyük "Voxen'e hoş geldin." + açıklama +
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
                  'Voxen\'e hoş geldin.\nMilisaniyeler içerisinde sola '
                  'kaydırılmaya SON.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w900,
                      color: Colors.white,
                      height: 1.15),
                ),
              ),
              const Padding(
                padding: EdgeInsets.fromLTRB(28, 0, 28, 16),
                child: Text(
                  '3D yüz taramasıyla yüzün aynı kalır ve sadece 3 dakikada '
                  'model kalitesinde fotoğraflar üretilir.',
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
                    child: const Text('Hemen Başla',
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
