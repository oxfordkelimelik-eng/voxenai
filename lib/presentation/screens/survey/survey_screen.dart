import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/router/app_router.dart';
import '../../../domain/entities/intake_profile.dart';
import '../../../domain/entities/addiction.dart';
import '../../providers/app_providers.dart';
import '../../providers/addiction_provider.dart';
import '../../providers/tasks_provider.dart';
import '../../providers/analysis_provider.dart';

/// İlk açılışta doldurulan detaylı çok bölümlü giriş formu.
/// 5 bölüm: Kişisel · Fiziksel · Zihinsel · Sosyal · Bağımlılık
/// Sonunda yüz & vücut foto adımlarına (analiz akışına) yönlendirir.
class SurveyScreen extends ConsumerStatefulWidget {
  const SurveyScreen({super.key});

  @override
  ConsumerState<SurveyScreen> createState() => _SurveyScreenState();
}

class _SurveyScreenState extends ConsumerState<SurveyScreen> {
  int _step = 0;

  // Kişisel
  final _nameCtrl = TextEditingController();
  int _age = 22;
  double _height = 175;
  double _weight = 75;

  // Cevaplar: anahtar -> seçili index
  final Map<String, int> _ans = {};
  // Bağımlılıklar (çoklu seçim)
  final Set<String> _addictions = {};

  late final List<_Section> _sections = _buildSections();

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  int get _totalSteps => _sections.length;

  void _next() {
    if (_step < _totalSteps - 1) {
      setState(() => _step++);
    } else {
      _finish();
    }
  }

  void _back() {
    if (_step > 0) setState(() => _step--);
  }

  bool get _canAdvance {
    final section = _sections[_step];
    if (section.id == 'personal') {
      return _nameCtrl.text.trim().isNotEmpty;
    }
    if (section.id == 'addiction') return true; // çoklu seçim opsiyonel
    // Her sorusunun cevabı olmalı
    return section.questions.every((q) => _ans.containsKey(q.key));
  }

  Future<void> _finish() async {
    final intake = IntakeProfile(
      name: _nameCtrl.text.trim().isEmpty ? 'Savaşçı' : _nameCtrl.text.trim(),
      age: _age,
      heightCm: _height,
      weightKg: _weight,
      fitnessLevel: _ans['fitnessLevel'] ?? 0,
      trainingPlace: 3, // antrenman yeri sorulmuyor — farketmez (default)
      bodyGoal: _ans['bodyGoal'] ?? 2,
      targetArea: _ans['targetArea'] ?? 3,
      dailyTime: _ans['weeklyDays'] ?? 1, // haftalık antrenman günü (0:1-2 .. 3:hergün)
      nutritionHabit: _ans['nutritionHabit'] ?? 0,
      sleepHabit: _ans['sleepHabit'] ?? 1,
      waterHabit: _ans['waterHabit'] ?? 1,
      mainStruggle: _ans['mainStruggle'] ?? 0,
      selfConfidence: _ans['selfConfidence'] ?? 1,
      discipline: _ans['discipline'] ?? 1,
      screenTime: _ans['screenTime'] ?? 1,
      socialAnxiety: _ans['socialAnxiety'] ?? 1,
      socialCircle: _ans['socialCircle'] ?? 1,
      datingExperience: _ans['datingExperience'] ?? 0,
      eyeContactComfort: _ans['eyeContactComfort'] ?? 1,
      addictionIds: _addictions.toList(),
      addictionSeverity: _ans['addictionSeverity'] ?? 1,
    );

    await ref.read(intakeProvider.notifier).save(intake);
    await ref.read(addictionProvider.notifier).initFromIds(_addictions.toList());

    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(StorageKeys.surveyDone, true);
    await prefs.setString(
      StorageKeys.trialStartDate,
      DateTime.now().toIso8601String(),
    );

    // Görevleri formdan üret (foto analizi sonra zenginleştirir)
    await ref.read(tasksProvider.notifier).regenerate();

    // Form verisinden sessizce tahmini skor üret (foto gerekmez) — böylece
    // ödeme ekranından sonra "tüm sonuçlar" boş kalmaz; foto çekilirse gerçek
    // AI analizi bunların üzerine yazar.
    await ref.read(faceAnalysisFlowProvider.notifier).run(null);
    await ref.read(bodyAnalysisFlowProvider.notifier).run(null);

    if (!mounted) return;
    // Çoktan seçmeli form bitti → DOĞRUDAN foto analizi ekranına geç.
    context.go(AppRoutes.analysis);
  }

  @override
  Widget build(BuildContext context) {
    final section = _sections[_step];
    final progress = (_step + 1) / _totalSteps;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      ShaderMask(
                        shaderCallback: (b) =>
                            AppColors.goldGradient.createShader(b),
                        child: const Text(
                          'RISE UP',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                            color: Colors.white,
                            letterSpacing: 4,
                          ),
                        ),
                      ),
                      Text(
                        '${_step + 1} / $_totalSteps',
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppColors.textMuted,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: Stack(
                      children: [
                        Container(height: 4, color: AppColors.borderSubtle),
                        AnimatedFractionallySizedBox(
                          duration: const Duration(milliseconds: 350),
                          widthFactor: progress,
                          child: Container(
                            height: 4,
                            decoration: const BoxDecoration(
                              gradient: AppColors.goldGradient,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

            // Section content
            Expanded(
              child: SingleChildScrollView(
                key: ValueKey(section.id),
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _SectionHeader(section: section)
                        .animate(key: ValueKey('h${section.id}'))
                        .fadeIn(duration: 300.ms)
                        .slideX(begin: 0.06, end: 0),
                    const SizedBox(height: 24),
                    if (section.id == 'personal')
                      _buildPersonal()
                    else if (section.id == 'addiction')
                      _buildAddiction()
                    else
                      _buildQuestions(section),
                  ],
                ),
              ),
            ),

            // Footer nav
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
              child: Row(
                children: [
                  if (_step > 0)
                    IconButton(
                      onPressed: _back,
                      icon: const Icon(Icons.arrow_back_rounded),
                      color: AppColors.textSecondary,
                    ),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: _canAdvance ? _next : null,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.gold,
                        disabledBackgroundColor: AppColors.borderSubtle,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      child: Text(
                        _step == _totalSteps - 1
                            ? 'FORMU BİTİR → FOTO ANALİZİ'
                            : 'DEVAM',
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1,
                        ),
                      ),
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

  // ---- Bölüm: Kişisel ----
  Widget _buildPersonal() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _label('Adın ne?'),
        const SizedBox(height: 8),
        TextField(
          controller: _nameCtrl,
          onChanged: (_) => setState(() {}),
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 16),
          decoration: _inputDeco('İsmini yaz'),
        ),
        const SizedBox(height: 24),
        _label('Yaşın: $_age'),
        Slider(
          value: _age.toDouble(),
          min: 14,
          max: 60,
          activeColor: AppColors.gold,
          inactiveColor: AppColors.borderSubtle,
          onChanged: (v) => setState(() => _age = v.round()),
        ),
        const SizedBox(height: 12),
        _label('Boy: ${_height.round()} cm'),
        Slider(
          value: _height,
          min: 140,
          max: 215,
          activeColor: AppColors.gold,
          inactiveColor: AppColors.borderSubtle,
          onChanged: (v) => setState(() => _height = v),
        ),
        const SizedBox(height: 12),
        _label('Kilo: ${_weight.round()} kg'),
        Slider(
          value: _weight,
          min: 40,
          max: 160,
          activeColor: AppColors.gold,
          inactiveColor: AppColors.borderSubtle,
          onChanged: (v) => setState(() => _weight = v),
        ),
      ],
    );
  }

  // ---- Bölüm: Bağımlılık (çoklu seçim) ----
  Widget _buildAddiction() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _label('Seni geri tutan bağımlılıkların hangileri? (birden fazla seçebilirsin)'),
        const SizedBox(height: 12),
        ...AddictionType.all.map((a) {
          final selected = _addictions.contains(a.id);
          return GestureDetector(
            onTap: () => setState(() {
              if (selected) {
                _addictions.remove(a.id);
              } else {
                _addictions.add(a.id);
              }
            }),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(
                color: selected
                    ? AppColors.error.withValues(alpha: 0.1)
                    : AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: selected ? AppColors.error : AppColors.borderSubtle,
                  width: selected ? 1.5 : 0.5,
                ),
              ),
              child: Row(
                children: [
                  Text(a.emoji, style: const TextStyle(fontSize: 22)),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      a.label,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: selected
                            ? AppColors.textPrimary
                            : AppColors.textSecondary,
                      ),
                    ),
                  ),
                  Icon(
                    selected
                        ? Icons.check_circle_rounded
                        : Icons.radio_button_unchecked,
                    color: selected ? AppColors.error : AppColors.textMuted,
                    size: 22,
                  ),
                ],
              ),
            ),
          );
        }),
        if (_addictions.isNotEmpty) ...[
          const SizedBox(height: 12),
          _label('Bu bağımlılıklar hayatını ne kadar etkiliyor?'),
          const SizedBox(height: 8),
          _OptionList(
            options: const ['Hafif', 'Orta', 'Belirgin', 'Ciddi'],
            selected: _ans['addictionSeverity'],
            color: AppColors.error,
            onSelect: (i) => setState(() => _ans['addictionSeverity'] = i),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          'Seçtiklerin için temiz gün sayacı ve özel kurtulma görevleri açılacak.',
          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4),
        ),
      ],
    );
  }

  // ---- Bölüm: Standart sorular ----
  Widget _buildQuestions(_Section section) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (int i = 0; i < section.questions.length; i++) ...[
          if (i > 0) const SizedBox(height: 28),
          _label(section.questions[i].text),
          const SizedBox(height: 10),
          _OptionList(
            options: section.questions[i].options,
            selected: _ans[section.questions[i].key],
            color: section.color,
            onSelect: (idx) =>
                setState(() => _ans[section.questions[i].key] = idx),
          ),
        ],
      ],
    );
  }

  Widget _label(String text) => Text(
        text,
        style: const TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.w700,
          color: AppColors.textPrimary,
          height: 1.3,
        ),
      );

  InputDecoration _inputDeco(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.textMuted),
        filled: true,
        fillColor: AppColors.surfaceElevated,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      );

  // ---- Bölüm tanımları ----
  List<_Section> _buildSections() => [
        _Section(
          id: 'personal',
          title: 'Seni Tanıyalım',
          subtitle:
              'İlk kısımda planını sana göre kuracağız. Dürüst ol — bu sadece sana özel. Bilgilerin KVKK gereği kimse ile paylaşılmayacaktır.',
          icon: Icons.person_rounded,
          color: AppColors.gold,
          questions: const [],
        ),
        _Section(
          id: 'physical',
          title: 'Fiziksel Durum',
          subtitle: 'Vücudunu ve haftalık antrenman temponu anlayalım.',
          icon: Icons.fitness_center_rounded,
          color: AppColors.physical,
          questions: const [
            _Q('fitnessLevel', 'Fitness geçmişin nasıl?',
                ['Hiç yapmadım', 'Ara sıra', 'Düzenli', 'Profesyonel']),
            _Q('bodyGoal', 'Vücut hedefin ne?',
                ['Yağ yakmak', 'Kas yapmak', 'İkisi birden', 'Sadece sağlık']),
            _Q('targetArea', 'En çok hangi bölgeyi geliştirmek istersin?',
                ['Karın / Core', 'Üst vücut', 'Bacak / Alt vücut', 'Genel vücut']),
            _Q('weeklyDays', 'Haftada kaç gün antrenmana vakit ayırabilirsin?',
                ['1-2 gün', '3-4 gün', '5-6 gün', 'Her gün']),
            _Q('nutritionHabit', 'Beslenme alışkanlığın?', [
              'Düzensiz, dikkat etmem',
              'Bazen dikkat ederim',
              'Genelde dengeli',
              'Tam kontrollü'
            ]),
            _Q('sleepHabit', 'Uyku düzenin?', [
              'Düzensiz / az',
              'Orta',
              'Genelde düzenli',
              'Çok düzenli'
            ]),
            _Q('waterHabit', 'Günlük su tüketimin?',
                ['Çok az', 'Az', 'Yeterli', 'Bol']),
          ],
        ),
        _Section(
          id: 'mental',
          title: 'Zihin & Disiplin',
          subtitle: 'Seni neyin zorladığını ve zihniyetini öğrenelim.',
          icon: Icons.psychology_rounded,
          color: AppColors.mental,
          questions: const [
            _Q('mainStruggle', 'Seni en çok zorlayan ne?', [
              'Motivasyon eksikliği',
              'Bilgi eksikliği',
              'Tutarsızlık',
              'Sosyal kaygı',
              'Özgüven eksikliği'
            ]),
            _Q('selfConfidence', 'Özgüven seviyen?',
                ['Çok düşük', 'Düşük', 'Orta', 'Yüksek']),
            _Q('discipline', 'Kendini ne kadar disiplinli görürsün?',
                ['Hiç', 'Az', 'Orta', 'Çok disiplinli']),
            _Q('screenTime', 'Günlük ekran süren?', [
              'Çok yüksek (6+ saat)',
              'Yüksek',
              'Orta',
              'Düşük'
            ]),
          ],
        ),
        _Section(
          id: 'social',
          title: 'Sosyal & Anksiyete',
          subtitle: 'Sosyal hayatını ve kaygı seviyeni anlayalım — yargı yok.',
          icon: Icons.groups_rounded,
          color: AppColors.social,
          questions: const [
            _Q('socialAnxiety', 'Sosyal ortamlarda ne kadar kaygılanırsın?', [
              'Hiç',
              'Biraz',
              'Oldukça',
              'Çok yüksek'
            ]),
            _Q('socialCircle', 'Sosyal çevren nasıl?', [
              'Neredeyse yalnızım',
              'Birkaç kişi',
              'Orta',
              'Geniş çevre'
            ]),
            _Q('eyeContactComfort', 'Göz teması kurmak senin için?',
                ['Çok zor', 'Zor', 'İdare eder', 'Rahat']),
            _Q('datingExperience', 'Flört / ilişki deneyimin?',
                ['Hiç yok', 'Az', 'Orta', 'Deneyimli']),
          ],
        ),
        _Section(
          id: 'addiction',
          title: 'Bağımlılıklar',
          subtitle: 'Seni esir alan alışkanlıkları kıralım. Bu liste gizli kalır.',
          icon: Icons.link_off_rounded,
          color: AppColors.error,
          questions: const [],
        ),
      ];
}

// ============================================================
// Yardımcı widget'lar & modeller
// ============================================================

class _SectionHeader extends StatelessWidget {
  final _Section section;
  const _SectionHeader({required this.section});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            color: section.color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: section.color.withValues(alpha: 0.3)),
          ),
          child: Icon(section.icon, color: section.color, size: 28),
        ),
        const SizedBox(height: 16),
        Text(
          section.title,
          style: const TextStyle(
            fontSize: 26,
            fontWeight: FontWeight.w900,
            color: AppColors.textPrimary,
            height: 1.1,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          section.subtitle,
          style: const TextStyle(
            fontSize: 14,
            color: AppColors.textSecondary,
            height: 1.4,
          ),
        ),
      ],
    );
  }
}

class _OptionList extends StatelessWidget {
  final List<String> options;
  final int? selected;
  final Color color;
  final void Function(int) onSelect;

  const _OptionList({
    required this.options,
    required this.selected,
    required this.color,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (int i = 0; i < options.length; i++)
          GestureDetector(
            onTap: () => onSelect(i),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
              decoration: BoxDecoration(
                color: selected == i
                    ? color.withValues(alpha: 0.1)
                    : AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: selected == i ? color : AppColors.borderSubtle,
                  width: selected == i ? 1.5 : 0.5,
                ),
              ),
              child: Row(
                children: [
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: selected == i ? color : Colors.transparent,
                      border: Border.all(
                        color: selected == i ? color : AppColors.borderSubtle,
                        width: 1.5,
                      ),
                    ),
                    child: selected == i
                        ? const Icon(Icons.check_rounded,
                            color: Colors.white, size: 13)
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      options[i],
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: selected == i
                            ? AppColors.textPrimary
                            : AppColors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Section {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final List<_Q> questions;

  const _Section({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.questions,
  });
}

class _Q {
  final String key;
  final String text;
  final List<String> options;
  const _Q(this.key, this.text, this.options);
}
