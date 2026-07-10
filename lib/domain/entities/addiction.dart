import 'package:equatable/equatable.dart';

/// Bilinen bağımlılık türleri — formdaki çoklu seçim ve takip ekranı bunu kullanır
class AddictionType {
  final String id;
  final String label;
  final String emoji;
  final String motivationLine; // kullanıcıyı içine çeken kısa cümle
  final List<String> recoverySteps; // ilk günlerde uygulanacak somut adımlar

  const AddictionType({
    required this.id,
    required this.label,
    required this.emoji,
    required this.motivationLine,
    required this.recoverySteps,
  });

  static const all = <AddictionType>[
    AddictionType(
      id: 'porn',
      label: 'Porno / Mastürbasyon',
      emoji: '🚫',
      motivationLine:
          'NoFap dopamin reseptörlerini sıfırlar. Enerji, odak ve özgüven geri gelir.',
      recoverySteps: [
        'Tetikleyici uygulamaları/siteleri engelle (blocker kur).',
        'Telefonu yatak odasından çıkar.',
        'Dürtü geldiğinde 10 şınav çek, ortamı değiştir.',
      ],
    ),
    AddictionType(
      id: 'social_media',
      label: 'Sosyal Medya / Kısa Video',
      emoji: '📱',
      motivationLine:
          'Sonsuz kaydırma odağını çalıyor. Geri kazandığın her saat seni rakiplerinden ayırır.',
      recoverySteps: [
        'Ana ekrandan sosyal medya ikonlarını kaldır.',
        'Uygulama başına günlük süre limiti koy.',
        'İlk 1 saat ve son 1 saat telefonsuz geçir.',
      ],
    ),
    AddictionType(
      id: 'smoking',
      label: 'Sigara / Nikotin',
      emoji: '🚬',
      motivationLine:
          'Nikotin testosteronu ve dayanıklılığı düşürür. Bırakmak yüz hatlarını bile keskinleştirir.',
      recoverySteps: [
        'Sigarayı ve çakmağı evden uzaklaştır.',
        'İstek anında bir bardak su iç, 5 dakika yürü.',
        'Tetikleyici ortamları (sigara molası grupları) değiştir.',
      ],
    ),
    AddictionType(
      id: 'sugar',
      label: 'Şeker / Junk Food',
      emoji: '🍩',
      motivationLine:
          'Şeker iltihabı artırır, cildi bozar, yağ depolar. Kesince yüzün netleşir.',
      recoverySteps: [
        'Evdeki şekerli/işlenmiş atıştırmalıkları at.',
        'Tatlı krizinde meyve veya su + protein al.',
        'Etiket oku: 5g üstü ilave şekeri reddet.',
      ],
    ),
    AddictionType(
      id: 'gaming',
      label: 'Aşırı Oyun',
      emoji: '🎮',
      motivationLine:
          'Sanal zaferler gerçek hayatta bir şey inşa etmez. Bu saatleri kendine yatır.',
      recoverySteps: [
        'Oyun oturumu için net saat limiti koy.',
        'Önce günlük görevleri bitir, sonra oyna.',
        'Oyun yerine 1 fiziksel/sosyal görev koy.',
      ],
    ),
    AddictionType(
      id: 'alcohol',
      label: 'Alkol',
      emoji: '🍺',
      motivationLine:
          'Alkol uykunu, hormonlarını ve kararlılığını bozar. Ayık kafa keskin karar verir.',
      recoverySteps: [
        'Evde alkol bulundurma.',
        'Sosyal ortamda alkolsüz alternatif sipariş et.',
        'İçme isteğini tetikleyen ortamları azalt.',
      ],
    ),
    AddictionType(
      id: 'caffeine',
      label: 'Aşırı Kafein',
      emoji: '☕',
      motivationLine:
          'Aşırı kafein kaygıyı ve uyku bozukluğunu besler. Dengelemek sakinliği geri getirir.',
      recoverySteps: [
        'Öğleden sonra kafeini kes.',
        'Günde maksimum 2 fincana in.',
        'Susuzluğu kafeinle değil suyla karşıla.',
      ],
    ),
  ];

  static AddictionType? byId(String id) {
    for (final a in all) {
      if (a.id == id) return a;
    }
    return null;
  }
}

/// Kullanıcının aktif olarak takip ettiği bir bağımlılık (temiz gün sayacı ile)
class Addiction extends Equatable {
  final String typeId;
  final DateTime startCleanDate; // son sıfırlama / başlangıç
  final int bestStreakDays;
  final int relapseCount;
  final List<String> checkInDays; // 'YYYY-MM-DD' — kullanıcının "temiz" işaretlediği günler
  final DateTime? lastCheckIn; // son check-in zamanı

  const Addiction({
    required this.typeId,
    required this.startCleanDate,
    this.bestStreakDays = 0,
    this.relapseCount = 0,
    this.checkInDays = const [],
    this.lastCheckIn,
  });

  static String dayKey(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  /// Bugün zaten check-in yapılmış mı?
  bool get checkedInToday => checkInDays.contains(dayKey(DateTime.now()));

  /// Bugünü "temiz" olarak işaretle (otomatik gün ekleme — kullanıcı etkileşimi)
  Addiction checkInToday() {
    final key = dayKey(DateTime.now());
    if (checkInDays.contains(key)) return this;
    return Addiction(
      typeId: typeId,
      startCleanDate: startCleanDate,
      bestStreakDays: bestStreakDays,
      relapseCount: relapseCount,
      checkInDays: [...checkInDays, key],
      lastCheckIn: DateTime.now(),
    );
  }

  /// Son [count] günün check-in durumu (bugün dahil, en eskiden yeniye).
  List<bool> recentCheckIns(int count) {
    final now = DateTime.now();
    return List.generate(count, (i) {
      final d = now.subtract(Duration(days: count - 1 - i));
      return checkInDays.contains(dayKey(d));
    });
  }

  AddictionType get type =>
      AddictionType.byId(typeId) ??
      const AddictionType(
        id: 'unknown',
        label: 'Bağımlılık',
        emoji: '⛓️',
        motivationLine: 'Her temiz gün bir zaferdir.',
        recoverySteps: [],
      );

  int get cleanDays => DateTime.now().difference(startCleanDate).inDays;

  /// Sonraki kilometre taşı (gün): 1, 3, 7, 14, 30, 60, 90, 180, 365
  int get nextMilestone {
    const milestones = [1, 3, 7, 14, 30, 60, 90, 180, 365];
    for (final m in milestones) {
      if (cleanDays < m) return m;
    }
    return 365;
  }

  double get milestoneProgress {
    const milestones = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365];
    final next = nextMilestone;
    final prevIndex = milestones.indexOf(next) - 1;
    final prev = prevIndex >= 0 ? milestones[prevIndex] : 0;
    if (next == prev) return 1;
    return ((cleanDays - prev) / (next - prev)).clamp(0.0, 1.0);
  }

  Addiction relapse() => Addiction(
    typeId: typeId,
    startCleanDate: DateTime.now(),
    bestStreakDays: cleanDays > bestStreakDays ? cleanDays : bestStreakDays,
    relapseCount: relapseCount + 1,
    checkInDays: const [], // düşüş → günlük takip sıfırlanır
  );

  Map<String, dynamic> toJson() => {
    'typeId': typeId,
    'startCleanDate': startCleanDate.toIso8601String(),
    'bestStreakDays': bestStreakDays,
    'relapseCount': relapseCount,
    'checkInDays': checkInDays,
    'lastCheckIn': lastCheckIn?.toIso8601String(),
  };

  factory Addiction.fromJson(Map<String, dynamic> j) => Addiction(
    typeId: j['typeId'] as String,
    startCleanDate: DateTime.parse(j['startCleanDate'] as String),
    bestStreakDays: j['bestStreakDays'] as int? ?? 0,
    relapseCount: j['relapseCount'] as int? ?? 0,
    checkInDays:
        (j['checkInDays'] as List?)?.map((e) => e as String).toList() ??
            const [],
    lastCheckIn: j['lastCheckIn'] != null
        ? DateTime.tryParse(j['lastCheckIn'] as String)
        : null,
  );

  @override
  List<Object?> get props =>
      [typeId, startCleanDate, relapseCount, checkInDays];
}
