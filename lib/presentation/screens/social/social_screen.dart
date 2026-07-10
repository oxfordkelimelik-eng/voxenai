import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/router/app_router.dart';
import '../../providers/app_providers.dart';

/// Anksiyete seviyesine göre kişiselleştirilmiş karşılama metni
String _anxietyHeadline(int anxiety) => switch (anxiety) {
      >= 3 =>
        'Sosyal kaygı gerçek — ama sen ondan büyüksün. Bugün sadece tek bir küçük adım at, gerisi gelecek.',
      2 =>
        'Her konuşma bir tekrar, her tekrar seni güçlendirir. Mükemmel olmana gerek yok, sadece dene.',
      1 =>
        'İyi gidiyorsun. Konfor alanının kenarını biraz daha zorla.',
      _ =>
        'Sosyal gücün yüksek — şimdi liderlik et ve başkalarını da yukarı çek.',
    };

enum SocialLevel { warmup, indirect, advanced }

extension on SocialLevel {
  String get label => switch (this) {
    SocialLevel.warmup => 'Isınma Seviyesi',
    SocialLevel.indirect => 'Dolaylı İletişim',
    SocialLevel.advanced => 'İleri Seviye (Daygame)',
  };

  String get apiKey => switch (this) {
    SocialLevel.warmup => 'warmup',
    SocialLevel.indirect => 'indirect',
    SocialLevel.advanced => 'advanced',
  };
}

class SocialScreen extends ConsumerStatefulWidget {
  const SocialScreen({super.key});

  @override
  ConsumerState<SocialScreen> createState() => _SocialScreenState();
}

class _SocialScreenState extends ConsumerState<SocialScreen> {
  final List<Map<String, String>> _chatHistory = [];
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  bool _isTyping = false;
  String _selectedScenario = 'sokak';
  bool _simulationActive = false;

  SocialLevel _unlockedLevel = SocialLevel.warmup;
  SocialLevel _activeLevel = SocialLevel.warmup;
  final Set<String> _completedWarmupTasks = {};
  final List<int> _eqScores = [];

  // Daygame sahneleri — AI bunlara göre gerçek bir kız karakteri canlandırır
  static const _scenarios = [
    ('sokak', 'Sokakta Tanışma', Icons.directions_walk_rounded),
    ('kafe', 'Kafede Yaklaşma', Icons.local_cafe_rounded),
    ('market', 'Markette Sohbet', Icons.shopping_cart_rounded),
    ('etkinlik', 'Etkinlik / Parti', Icons.celebration_rounded),
  ];

  // Sahneye göre hazır açılış cümlesi kütüphanesi (kopyalanıp kullanılabilir)
  static const Map<String, List<String>> _openerLibrary = {
    'sokak': [
      'Selam, kusura bakma seni durdurdum ama dikkatimi çektin, kendimi tanıtmadan geçemezdim.',
      'Bir saniye — tarzın gerçekten güzel, bunu söylemeden gidemezdim. Ben [isim].',
      'Tam bir yabancı olarak geliyorum ama gülümsemen çok samimiydi, merhaba demek istedim.',
    ],
    'kafe': [
      'Ne okuduğunu merak ettim, yüzünde gülümseme bıraktı — iyi olmalı.',
      'Buranın kahvesi gerçekten iyi mi, yoksa sadece ben mi şanslıyım? Bu arada merhaba.',
      'Rahatsız ediyorum ama enerjin sıcak görünüyordu, tanışmak istedim.',
    ],
    'market': [
      'Affedersin, şunlardan hangisi daha iyi sence? Bir de bu arada merhaba.',
      'Senin sepetin benimkinden çok daha sağlıklı görünüyor, bir önerine ihtiyacım var.',
      'Burada en çok neyi tavsiye edersin? Soruyu bahane ettim aslında, tanışmak istedim.',
    ],
    'etkinlik': [
      'Buradaki en ilginç insan sensin gibi duruyor, kontrol etmeye geldim.',
      'Kimseyi tam tanımıyorum ama seninle tanışmak en doğru başlangıç gibi göründü.',
      'Selam, bu kalabalıkta gerçek bir sohbet arıyordum — aday gibisin.',
    ],
  };

  static const _warmupTasks = [
    'Bugün sokakta yürürken başın dik, omuzların geride, bakışın ufukta yürü.',
    'Karşılaştığın 3 kişiyle 2 saniye göz teması kurup hafifçe gülümse.',
    'Bir kadına (kasiyer, barista) içten bir iltifat et — görünüş değil, bir tercih/enerji üzerine.',
    'Bir yabancıyla 60 saniyelik gerçek bir küçük sohbet başlat ve doğal bitir.',
  ];

  static const _indirectTasks = [
    'Bir kadına yön/öneri sor, cevabını al, bir takip sorusuyla sohbeti 30 sn uzat.',
    'Kafede/kuyrukta yanındaki kişiye durumla ilgili rahat bir yorum at (baskısız).',
    'Bir mağazada görevliyle ürün üzerinden küçük bir espri/sohbet kur.',
    'Bir kadına ismini söyleyip ismini sor, gülümseyerek "memnun oldum" de ve devam et.',
  ];

  // İleri seviye gerçek hayat daygame saha görevleri
  static const _fieldTasks = [
    'Gündüz bir kadını durdurup içten bir açılış yap (kabul/ret önemli değil, hamle önemli).',
    'Bir yaklaşımda telefon numarası iste — reddedilsen bile gülümseyip teşekkür et.',
    'Aynı gün 3 farklı kadına selam ver/kısa sohbet aç (3 yaklaşım kuralı).',
    'Bir sohbeti, kadının adını öğrenip ortak bir nokta bulacak kadar uzat.',
  ];

  @override
  void initState() {
    super.initState();
    _loadSocialLevel();
  }

  Future<void> _loadSocialLevel() async {
    final prefs = await SharedPreferences.getInstance();
    final levelIndex = prefs.getInt(StorageKeys.socialLevel) ?? 0;
    if (!mounted) return;
    setState(() {
      _unlockedLevel = SocialLevel.values[levelIndex.clamp(0, 2)];
    });
  }

  Future<void> _unlockNextLevel(SocialLevel completed) async {
    final nextIndex = completed.index + 1;
    if (nextIndex >= SocialLevel.values.length) return;
    if (_unlockedLevel.index >= nextIndex) return;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(StorageKeys.socialLevel, nextIndex);
    if (!mounted) return;
    setState(() => _unlockedLevel = SocialLevel.values[nextIndex]);
  }

  @override
  void dispose() {
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _sendMessage(String text) async {
    if (text.trim().isEmpty) return;
    _messageController.clear();

    setState(() {
      _chatHistory.add({'role': 'user', 'text': text});
      _isTyping = true;
    });

    _scrollToBottom();

    final service = ref.read(claudeApiServiceProvider);
    try {
      final messages = _chatHistory
          .where((m) =>
              m['role'] == 'user' || m['role'] == 'assistant')
          .map((m) => {'role': m['role'], 'content': m['text']!})
          .toList();

      final response = await service.chat(
        messages: messages,
        scenario: _selectedScenario,
        socialLevel: _activeLevel.apiKey,
      );

      final eqMatch = RegExp(r'\[EQ_SKOR\]:\s*(\d{1,3})').firstMatch(response);
      final cleanResponse = response
          .replaceAll(RegExp(r'\n?\[EQ_SKOR\]:\s*\d{1,3}\.?'), '')
          .trim();

      setState(() {
        _chatHistory.add({'role': 'assistant', 'text': cleanResponse});
        _isTyping = false;
        if (eqMatch != null) {
          final score = int.tryParse(eqMatch.group(1)!);
          if (score != null) _eqScores.add(score.clamp(0, 100));
        }
      });

      await _unlockNextLevel(SocialLevel.advanced);
    } catch (e) {
      setState(() {
        _chatHistory.add({'role': 'error', 'text': 'Hata: $e'});
        _isTyping = false;
      });
    }

    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _completeStageTask(SocialLevel level, String task) {
    setState(() => _completedWarmupTasks.add(task));
    _unlockNextLevel(level);
  }

  /// Sahneyi tanıtan bir kurulum mesajıyla simülasyonu başlat.
  void _startSimulation() {
    final sceneIntro = switch (_selectedScenario) {
      'sokak' =>
        '📍 İşlek bir caddedesin. Karşıdan gülümseyerek yürüyen bir kadın geliyor, birazdan yanından geçecek. Onu durdurup açılışını yap.',
      'kafe' =>
        '☕ Sakin bir kafedesin. Yan masada tek başına oturan, kitabına dalmış bir kadın var. Sohbeti başlat.',
      'market' =>
        '🛒 Markette reyonların arasındasın. Yakınında bir kadın ürünlere bakıyor. Doğal bir bahaneyle yaklaş.',
      'etkinlik' =>
        '🎉 Bir etkinliktesin. Kenarda içeceğini yudumlayan, sana doğru bakmış bir kadın var. Tanışmak için git.',
      _ => 'Bir kadınla tanışma fırsatın var. Açılışını yap.',
    };
    setState(() {
      _chatHistory.clear();
      _chatHistory.add({'role': 'scene', 'text': sceneIntro});
      _simulationActive = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final isPro = ref.watch(isProProvider);

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('SOSYAL ANTRENMAN'),
        actions: [
          if (_simulationActive)
            IconButton(
              icon: const Icon(Icons.refresh_rounded),
              onPressed: () => setState(() {
                _chatHistory.clear();
                _simulationActive = false;
              }),
              tooltip: 'Sıfırla',
            ),
        ],
      ),
      body: Column(
        children: [
          if (!_simulationActive) ...[
            _AnxietyBanner(
              text: _anxietyHeadline(
                ref.watch(intakeProvider)?.socialAnxiety ?? 1,
              ),
            ),
            _LevelSelector(
              unlockedLevel: _unlockedLevel,
              activeLevel: _activeLevel,
              onSelect: (l) => setState(() => _activeLevel = l),
            ),
            Expanded(
              child: switch (_activeLevel) {
                SocialLevel.warmup => _StageTaskList(
                  tasks: _warmupTasks,
                  completed: _completedWarmupTasks,
                  color: AppColors.social,
                  onComplete: (t) => _completeStageTask(SocialLevel.warmup, t),
                ),
                SocialLevel.indirect => _StageTaskList(
                  tasks: _indirectTasks,
                  completed: _completedWarmupTasks,
                  color: AppColors.mental,
                  onComplete: (t) => _completeStageTask(SocialLevel.indirect, t),
                ),
                SocialLevel.advanced => ListView(
                  padding: const EdgeInsets.only(bottom: 24),
                  children: [
                    _ScenarioSelector(
                      scenarios: _scenarios,
                      selected: _selectedScenario,
                      onSelect: (s) => setState(() => _selectedScenario = s),
                    ),
                    const SizedBox(height: 8),
                    _OpenerLibrary(
                      openers: _openerLibrary[_selectedScenario] ?? const [],
                    ),
                    const SizedBox(height: 8),
                    _FieldMissions(tasks: _fieldTasks),
                    const SizedBox(height: 16),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      child: ElevatedButton.icon(
                        onPressed:
                            isPro ? _startSimulation : () => context.push(AppRoutes.trial),
                        icon: Icon(
                          isPro ? Icons.play_arrow_rounded : Icons.lock_rounded,
                        ),
                        label: Text(
                          isPro
                              ? 'Canlı Simülasyonu Başlat'
                              : 'PRO ile Aç',
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        style: ElevatedButton.styleFrom(
                          backgroundColor:
                              isPro ? AppColors.gold : AppColors.borderSubtle,
                          foregroundColor: AppColors.textOnGold,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                  ],
                ),
              },
            ),
          ] else ...[
            if (_eqScores.isNotEmpty) _EqProgressBar(scores: _eqScores),
            Expanded(
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.all(16),
                itemCount: _chatHistory.length + (_isTyping ? 1 : 0),
                itemBuilder: (context, index) {
                  if (_isTyping && index == _chatHistory.length) {
                    return _TypingIndicator();
                  }
                  final msg = _chatHistory[index];
                  return _ChatBubble(message: msg);
                },
              ),
            ),
            _ChatInput(controller: _messageController, onSend: _sendMessage),
          ],
        ],
      ),
    );
  }
}

class _AnxietyBanner extends StatelessWidget {
  final String text;
  const _AnxietyBanner({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [
          AppColors.social.withValues(alpha: 0.18),
          AppColors.social.withValues(alpha: 0.06),
        ]),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.social.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.favorite_rounded, color: AppColors.social, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 13,
                color: AppColors.textPrimary,
                height: 1.4,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    ).animate().fadeIn(duration: 300.ms);
  }
}

class _LevelSelector extends StatelessWidget {
  final SocialLevel unlockedLevel;
  final SocialLevel activeLevel;
  final void Function(SocialLevel) onSelect;

  const _LevelSelector({
    required this.unlockedLevel,
    required this.activeLevel,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Row(
        children: SocialLevel.values.map((level) {
          final isUnlocked = level.index <= unlockedLevel.index;
          final isActive = level == activeLevel;
          return Expanded(
            child: GestureDetector(
              onTap: isUnlocked ? () => onSelect(level) : null,
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 4),
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  color: isActive ? AppColors.goldSurface : AppColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: isActive ? AppColors.gold : AppColors.borderSubtle,
                  ),
                ),
                child: Column(
                  children: [
                    Icon(
                      isUnlocked ? Icons.check_circle_outline_rounded : Icons.lock_rounded,
                      size: 16,
                      color: isUnlocked
                          ? (isActive ? AppColors.gold : AppColors.textSecondary)
                          : AppColors.textMuted,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      level.label,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: isUnlocked
                            ? (isActive ? AppColors.gold : AppColors.textSecondary)
                            : AppColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _StageTaskList extends StatelessWidget {
  final List<String> tasks;
  final Set<String> completed;
  final Color color;
  final void Function(String) onComplete;

  const _StageTaskList({
    required this.tasks,
    required this.completed,
    required this.color,
    required this.onComplete,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: tasks.map((task) {
        final isDone = completed.contains(task);
        return Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: isDone ? AppColors.surfaceElevated.withValues(alpha: 0.5) : color.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: color.withValues(alpha: 0.3)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                isDone ? Icons.check_circle_rounded : Icons.bolt_rounded,
                color: isDone ? AppColors.success : color,
                size: 22,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  task,
                  style: TextStyle(
                    fontSize: 14,
                    color: isDone ? AppColors.textMuted : AppColors.textPrimary,
                    decoration: isDone ? TextDecoration.lineThrough : null,
                    height: 1.4,
                  ),
                ),
              ),
              if (!isDone)
                TextButton(
                  onPressed: () => onComplete(task),
                  child: const Text('Tamamla'),
                ),
            ],
          ),
        ).animate().fadeIn(duration: 300.ms);
      }).toList(),
    );
  }
}

class _ScenarioSelector extends StatelessWidget {
  final List<(String, String, IconData)> scenarios;
  final String selected;
  final void Function(String) onSelect;

  const _ScenarioSelector({
    required this.scenarios,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 16, bottom: 12),
            child: Text(
              'SENARYO SEÇ',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: AppColors.textSecondary,
                letterSpacing: 1,
              ),
            ),
          ),
          GridView.count(
            shrinkWrap: true,
            crossAxisCount: 2,
            crossAxisSpacing: 10,
            mainAxisSpacing: 10,
            childAspectRatio: 3,
            children: scenarios
                .map(
                  (s) => GestureDetector(
                    onTap: () => onSelect(s.$1),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 10,
                      ),
                      decoration: BoxDecoration(
                        color: selected == s.$1
                            ? AppColors.goldSurface
                            : AppColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: selected == s.$1
                              ? AppColors.gold
                              : AppColors.borderSubtle,
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            s.$3,
                            size: 18,
                            color: selected == s.$1
                                ? AppColors.gold
                                : AppColors.textSecondary,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              s.$2,
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: selected == s.$1
                                    ? AppColors.gold
                                    : AppColors.textSecondary,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
        ],
      ),
    );
  }
}

/// Sahneye göre hazır açılış cümleleri — kopyalanabilir, kullanıcıyı cesaretlendirir.
class _OpenerLibrary extends StatelessWidget {
  final List<String> openers;
  const _OpenerLibrary({required this.openers});

  @override
  Widget build(BuildContext context) {
    if (openers.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.social.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.social.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.auto_awesome_rounded,
                  color: AppColors.social, size: 16),
              SizedBox(width: 6),
              Text(
                'AÇILIŞ CÜMLELERİ',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: AppColors.social,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'İlham al ya da olduğu gibi dene. Dokun → kopyala.',
            style: TextStyle(fontSize: 11, color: AppColors.textMuted),
          ),
          const SizedBox(height: 10),
          ...openers.map((o) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: o));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Açılış kopyalandı 👍'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  },
                  child: Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceElevated,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.borderSubtle),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            o,
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.textPrimary,
                              height: 1.35,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        const Icon(Icons.copy_rounded,
                            size: 15, color: AppColors.textMuted),
                      ],
                    ),
                  ),
                ),
              )),
        ],
      ),
    );
  }
}

/// Gerçek hayatta yapılacak daygame saha görevleri — cesaret kası.
class _FieldMissions extends StatelessWidget {
  final List<String> tasks;
  const _FieldMissions({required this.tasks});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.gold.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderGold),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.flag_rounded, color: AppColors.gold, size: 16),
              SizedBox(width: 6),
              Text(
                'BUGÜNÜN SAHA GÖREVLERİ',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: AppColors.gold,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Gerçek dünyada uygula — cesaret tekrar ile gelir.',
            style: TextStyle(fontSize: 11, color: AppColors.textMuted),
          ),
          const SizedBox(height: 10),
          ...tasks.map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.bolt_rounded,
                        color: AppColors.gold, size: 16),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        t,
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppColors.textPrimary,
                          height: 1.35,
                        ),
                      ),
                    ),
                  ],
                ),
              )),
        ],
      ),
    );
  }
}

class _EqProgressBar extends StatelessWidget {
  final List<int> scores;
  const _EqProgressBar({required this.scores});

  @override
  Widget build(BuildContext context) {
    final average = scores.reduce((a, b) => a + b) / scores.length;
    final isImproving = scores.length > 1 && scores.last >= scores[scores.length - 2];

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.mentalGlow,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.mental.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.psychology_alt_rounded, color: AppColors.mental, size: 18),
          const SizedBox(width: 8),
          Text(
            'Ortalama EQ: ${average.toStringAsFixed(0)}',
            style: const TextStyle(
              color: AppColors.mental,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            isImproving ? Icons.trending_up_rounded : Icons.trending_down_rounded,
            color: isImproving ? AppColors.success : AppColors.error,
            size: 16,
          ),
          const Spacer(),
          Text(
            'Son: ${scores.last}',
            style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _ChatBubble extends StatelessWidget {
  final Map<String, String> message;

  const _ChatBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final isUser = message['role'] == 'user';
    final isError = message['role'] == 'error';
    final isScene = message['role'] == 'scene';
    final text = message['text'] ?? '';

    // Sahne tanıtımı — ortada özel bir kart olarak göster
    if (isScene) {
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [
            AppColors.social.withValues(alpha: 0.15),
            AppColors.gold.withValues(alpha: 0.08),
          ]),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.social.withValues(alpha: 0.35)),
        ),
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 13.5,
            color: AppColors.textPrimary,
            height: 1.45,
            fontWeight: FontWeight.w600,
          ),
        ),
      );
    }

    // Geri bildirim mesajını ayır
    final hasFeedback = text.contains('[GERİ BİLDİRİM]:');
    final parts = hasFeedback ? text.split('[GERİ BİLDİRİM]:') : null;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: isUser
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          // Ana mesaj balonu
          Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.78,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: isUser
                  ? AppColors.goldSurface
                  : isError
                  ? AppColors.errorGlow
                  : AppColors.surfaceElevated,
              borderRadius: BorderRadius.only(
                topLeft: const Radius.circular(16),
                topRight: const Radius.circular(16),
                bottomLeft: Radius.circular(isUser ? 16 : 4),
                bottomRight: Radius.circular(isUser ? 4 : 16),
              ),
              border: Border.all(
                color: isUser
                    ? AppColors.borderGold
                    : isError
                    ? AppColors.error.withValues(alpha: 0.3)
                    : AppColors.borderSubtle,
              ),
            ),
            child: Text(
              hasFeedback ? parts!.first.trim() : text,
              style: TextStyle(
                color: isError ? AppColors.error : AppColors.textPrimary,
                fontSize: 14,
                height: 1.4,
              ),
            ),
          ),

          // Geri bildirim kartı
          if (hasFeedback && parts!.length > 1) ...[
            const SizedBox(height: 6),
            Container(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.78,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.mentalGlow,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: AppColors.mental.withValues(alpha: 0.3),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.psychology_rounded,
                    color: AppColors.mental,
                    size: 16,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '[GERİ BİLDİRİM]: ${parts.last.trim()}',
                      style: const TextStyle(
                        color: AppColors.mental,
                        fontSize: 12,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _TypingIndicator extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: AppColors.surfaceElevated,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.borderSubtle),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _Dot(delay: 0),
                const SizedBox(width: 4),
                _Dot(delay: 200),
                const SizedBox(width: 4),
                _Dot(delay: 400),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Dot extends StatefulWidget {
  final int delay;
  const _Dot({required this.delay});
  @override
  State<_Dot> createState() => _DotState();
}

class _DotState extends State<_Dot> with SingleTickerProviderStateMixin {
  late AnimationController _c;
  late Animation<double> _a;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _a = Tween(begin: 0.3, end: 1.0).animate(_c);
    Future.delayed(Duration(milliseconds: widget.delay), () {
      if (mounted) _c.repeat(reverse: true);
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _a,
      builder: (context, child) => Opacity(
        opacity: _a.value,
        child: Container(
          width: 8,
          height: 8,
          decoration: const BoxDecoration(
            color: AppColors.gold,
            shape: BoxShape.circle,
          ),
        ),
      ),
    );
  }
}

class _ChatInput extends StatelessWidget {
  final TextEditingController controller;
  final void Function(String) onSend;

  const _ChatInput({required this.controller, required this.onSend});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
        color: AppColors.surface,
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'Yanıtını yaz...',
                hintStyle: const TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.surfaceElevated,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
              ),
              onSubmitted: onSend,
              textInputAction: TextInputAction.send,
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: () => onSend(controller.text),
            child: Container(
              width: 44,
              height: 44,
              decoration: const BoxDecoration(
                gradient: AppColors.goldGradient,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.send_rounded,
                color: AppColors.textOnGold,
                size: 20,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
