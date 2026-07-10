import 'package:uuid/uuid.dart';
import '../../domain/entities/daily_task.dart';
import '../../domain/entities/intake_profile.dart';
import '../../domain/entities/face_analysis.dart';
import '../../domain/entities/body_analysis.dart';
import '../../domain/entities/addiction.dart';
import '../constants/app_constants.dart';

/// Detaylı giriş formu (IntakeProfile) + opsiyonel yüz/vücut analizlerinden
/// kişiselleştirilmiş, kategorize edilmiş ve detaylı takip adımları olan
/// görev seti üreten saf fonksiyonlar.
///
/// Görevler 3 ana tab'a dağılır (TaskType): physical, mental, social.
/// TaskCategory ince etiketleme sağlar (face/body/nutrition/discipline/
/// mindset/socialSkill/addiction).
class TaskGenerator {
  TaskGenerator._();

  static const _uuid = Uuid();

  /// Ana üretici. Analiz sonuçları varsa onları da harmanlar.
  static List<DailyTask> generate(
    IntakeProfile p, {
    FaceAnalysisResult? face,
    BodyAnalysisResult? body,
    List<Addiction> addictions = const [],
  }) {
    return [
      ..._physicalTasks(p, body),
      ..._faceTasks(p, face),
      ..._mentalTasks(p),
      ..._socialTasks(p),
      ..._addictionTasks(p, addictions),
    ];
  }

  // ============================================================
  // FİZİKSEL — vücut, kas, postür, beslenme, kardiyo
  // ============================================================
  static List<DailyTask> _physicalTasks(
    IntakeProfile p,
    BodyAnalysisResult? body,
  ) {
    final tasks = <DailyTask>[];
    final envLabel = switch (p.trainingPlace) {
      1 => 'spor salonunda',
      2 => 'açık havada',
      _ => 'evde',
    };

    // 1) Ana antrenman — fitness seviyesine göre
    if (p.fitnessLevel == 0) {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.body,
        title: 'Başlangıç Tam Vücut',
        description: '$envLabel temel hareketlerle vücudunu uyandır.',
        rationale:
            'Hiç başlamamış olman sorun değil — ilk hafta kas hafızasını açmak için.',
        difficulty: TaskDifficulty.easy,
        minutes: p.dailyTime <= 0 ? 12 : 20,
        steps: const [
          '3×10 squat (çömelme)',
          '3×8 şınav (dizden olabilir)',
          '3×30sn plank',
          '2×15 köprü (glute bridge)',
        ],
      ));
    } else if (p.fitnessLevel == 1) {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.body,
        title: 'Kuvvet Devresi',
        description: '$envLabel orta yoğunlukta kuvvet devresi.',
        rationale: 'Düzenliliği yakaladın — şimdi yükü artırma zamanı.',
        difficulty: TaskDifficulty.medium,
        minutes: 30,
        steps: const [
          '4×12 squat',
          '4×10 şınav',
          '3×8 ters kürek / negatif barfiks',
          '3×45sn plank',
          '10 dk tempolu yürüyüş',
        ],
      ));
    } else {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.body,
        title: 'Hipertrofi Bloğu',
        description: '$envLabel bileşik hareket odaklı yüklenme.',
        rationale: 'Seviyen yüksek — ilerlemeli aşırı yükle kas inşa et.',
        difficulty: TaskDifficulty.hard,
        minutes: 45,
        steps: const [
          'Isınma 5 dk',
          '4×8 ana bileşik hareket (squat/deadlift/bench)',
          '4×10 yardımcı hareket',
          '3×12 izolasyon',
          'Soğuma + esneme 5 dk',
        ],
      ));
    }

    // 2) Postür — analiz varsa ona göre, yoksa genel
    final hasPostureIssue =
        body?.kyphosisDetected == true || (body?.postureScore ?? 100) < 60;
    if (hasPostureIssue || p.fitnessLevel == 0) {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.body,
        title: 'Postür Düzeltme',
        description:
            'Öne eğik baş ve kambur duruşu düzelt — daha uzun ve dominant görün.',
        rationale:
            'Dik duruş anında daha güvenli, daha çekici ve daha sağlıklı algılanmanı sağlar.',
        difficulty: TaskDifficulty.easy,
        minutes: 10,
        steps: const [
          '3×12 Wall Angels (duvar melekleri)',
          '3×30sn çene çekme (chin tuck)',
          '2×15 face pull / band çekme',
          'Gün içinde 3 kez duruşunu kontrol et',
        ],
      ));
    }

    // 2.5) Hedef bölge — kullanıcının seçtiği önceliğe nokta atışı
    final (areaTitle, areaDesc, areaSteps) = switch (p.targetArea) {
      0 => (
        'Core & Karın Bloğu',
        'Seçtiğin öncelik karın bölgesi — core\'u sıkılaştır.',
        const [
          '3×20 crunch',
          '3×30sn plank',
          '3×15 bisiklet mekik',
          '3×20 dağ tırmanışı (mountain climber)',
        ],
      ),
      1 => (
        'Üst Vücut Bloğu',
        'Seçtiğin öncelik üst vücut — göğüs, omuz ve sırtı yükle.',
        const [
          '4×10 şınav',
          '3×8 ters kürek / barfiks',
          '3×12 omuz pres (dumbbell varsa)',
          '3×15 dips / triceps',
        ],
      ),
      2 => (
        'Bacak & Alt Vücut Bloğu',
        'Seçtiğin öncelik bacaklar — alt vücudu güçlendir.',
        const [
          '4×15 squat',
          '3×12 hamle (lunge) her bacak',
          '3×20 köprü (glute bridge)',
          '3×15 baldır kaldırma (calf raise)',
        ],
      ),
      _ => (
        'Dengeli Tam Vücut',
        'Tüm vücudu dengeli geliştir — zayıf halka bırakma.',
        const [
          '3×12 squat',
          '3×10 şınav',
          '3×30sn plank',
          '3×12 ters kürek',
        ],
      ),
    };
    tasks.add(_task(
      type: TaskType.physical,
      category: TaskCategory.body,
      title: areaTitle,
      description: areaDesc,
      rationale: 'Hedef bölgene odaklı çalışmak motivasyonu ve sonucu hızlandırır.',
      difficulty: TaskDifficulty.medium,
      minutes: 20,
      steps: areaSteps,
    ));

    // 3) Kardiyo / adım hedefi
    final stepGoal = body?.cardioStepGoal ?? (p.bodyGoal == 0 ? 10000 : 8000);
    tasks.add(_task(
      type: TaskType.physical,
      category: TaskCategory.body,
      title: 'Günlük $stepGoal Adım',
      description: 'Hareket et — yağ yak, kafanı boşalt, enerjini aç.',
      rationale: 'Adım sayısı sağlığın ve yağ yakımının en az takdir edilen kaldıracı.',
      difficulty: TaskDifficulty.easy,
      minutes: 30,
    ));

    // 4) Beslenme — alışkanlığa göre
    if (p.nutritionHabit == 0) {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.nutrition,
        title: 'Beslenme Sıfırlama',
        description: 'Tek günde devrim değil — bugün 3 küçük doğru hamle.',
        rationale: 'Beslenme görünüşünün %70\'i. Küçük başla, kalıcı yap.',
        difficulty: TaskDifficulty.easy,
        minutes: 5,
        steps: const [
          'Her öğüne bir avuç protein ekle',
          'İşlenmiş şekeri bugün sıfırla',
          'En az 1 porsiyon sebze ye',
        ],
      ));
    } else {
      final protein = body?.proteinTargetG ?? (p.weightKg * 1.8).round();
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.nutrition,
        title: 'Protein Hedefi (~$protein g)',
        description: 'Kas inşası ve tokluk için günlük protein hedefini tuttur.',
        rationale: 'Yeterli protein olmadan antrenman kas yapmaz, sadece yorar.',
        difficulty: TaskDifficulty.medium,
        minutes: 5,
      ));
    }

    // 5) Su
    if (p.waterHabit <= 1) {
      tasks.add(_task(
        type: TaskType.physical,
        category: TaskCategory.nutrition,
        title: 'Hidrasyon',
        description: 'Gün boyu su iç — cilt, enerji ve odak için.',
        rationale: 'Hafif su kaybı bile yorgunluk ve donuk cilt yapar.',
        difficulty: TaskDifficulty.easy,
        minutes: 1,
        steps: const [
          'Sabah uyanınca 500 ml su',
          'Öğle ve akşam birer bardak',
          'Toplam ~2.5-3 L hedefle',
        ],
      ));
    }

    return tasks;
  }

  // ============================================================
  // YÜZ — jawline, cilt, saç & sakal (analiz varsa zenginleşir)
  // ============================================================
  static List<DailyTask> _faceTasks(IntakeProfile p, FaceAnalysisResult? face) {
    final tasks = <DailyTask>[];

    // Mewing & jawline — herkes için temel
    tasks.add(_task(
      type: TaskType.physical,
      category: TaskCategory.face,
      title: 'Jawline & Mewing',
      description: face?.mewingGuide ??
          'Dilini damağa yasla, çene hattını çalıştır.',
      rationale:
          'Doğru dil postürü ve çiğneme kası egzersizi zamanla çene hattını belirginleştirir.',
      difficulty: TaskDifficulty.easy,
      minutes: 8,
      steps: [
        'Gün boyu dil damakta (mewing) — düz dur',
        ...(face?.masseterExercises.isNotEmpty == true
            ? face!.masseterExercises
            : const ['2×20 çene açma-kapama direnci', '3×15 chin-up (çene yukarı)']),
        'Sakız çiğneyerek masseter kasını çalıştır (10 dk)',
      ],
    ));

    // Cilt rutini
    final morning = face?.skinMorningRoutine.isNotEmpty == true
        ? face!.skinMorningRoutine
        : const ['Yüzünü yıka', 'Nemlendirici sür', 'SPF 30+ güneş kremi'];
    final evening = face?.skinEveningRoutine.isNotEmpty == true
        ? face!.skinEveningRoutine
        : const ['Temizleyici ile yıka', 'Nemlendirici', 'Haftada 2 peeling'];
    tasks.add(_task(
      type: TaskType.physical,
      category: TaskCategory.face,
      title: 'Cilt Bakım Rutini',
      description: 'Sabah & akşam temel cilt rutinini uygula.',
      rationale: 'Temiz, bakımlı cilt anında bakımlı ve sağlıklı algılanmanı sağlar.',
      difficulty: TaskDifficulty.easy,
      minutes: 6,
      steps: [
        '☀️ Sabah: ${morning.join(" → ")}',
        '🌙 Akşam: ${evening.join(" → ")}',
      ],
    ));

    // Saç & sakal bakımı (analiz varsa öneri ekle)
    tasks.add(_task(
      type: TaskType.physical,
      category: TaskCategory.face,
      title: 'Saç & Sakal Bakımı',
      description: face?.beardGuide ??
          'Yüz şekline uygun saç/sakal hattını koru, düzgün görün.',
      rationale: 'Doğru saç & sakal çerçevesi yüz oranlarını dengeler.',
      difficulty: TaskDifficulty.easy,
      minutes: 10,
      steps: [
        if (face != null && face.hairStyles.isNotEmpty)
          'Önerilen kesim: ${face.hairStyles.join(", ")}',
        'Sakal hattını temizle / şekillendir',
        'Saçını düzelt, dağınıklığı gider',
      ],
    ));

    return tasks;
  }

  // ============================================================
  // ZİHİNSEL — disiplin, uyku, ekran, zihniyet (redpill çerçeve)
  // ============================================================
  static List<DailyTask> _mentalTasks(IntakeProfile p) {
    final tasks = <DailyTask>[];

    // Uyku
    if (p.sleepHabit <= 1) {
      tasks.add(_task(
        type: TaskType.mental,
        category: TaskCategory.discipline,
        title: 'Uyku Hijyeni',
        description: 'Erken ve kaliteli uyku — testosteron, cilt ve odak için.',
        rationale: 'Kötü uyku her alanı sabote eder: hormon, görünüş, ruh hali.',
        difficulty: TaskDifficulty.medium,
        minutes: 5,
        steps: const [
          'Yatmadan 1 saat önce ekranı bırak',
          'Oda karanlık ve serin olsun',
          'Aynı saatte yat (±30 dk)',
          '7-8 saat hedefle',
        ],
      ));
    }

    // Zihniyet / öz değer — mainStruggle'a göre
    final mindset = switch (p.mainStruggle) {
      0 => _task(
          type: TaskType.mental,
          category: TaskCategory.mindset,
          title: 'Motivasyon Değil, Sistem',
          description:
              'Motivasyon gelip gider; bugün küçük bir görevi "canın istemese de" yap.',
          rationale:
              'Disiplin = canın istemediğinde de yapmak. Kimliğini eylemle inşa et.',
          difficulty: TaskDifficulty.medium,
          minutes: 5,
        ),
      1 => _task(
          type: TaskType.mental,
          category: TaskCategory.mindset,
          title: 'Bilinçli Öğrenme',
          description: 'Gelişimine dair 15 dk kaliteli içerik oku/izle ve 1 not al.',
          rationale: 'Bilgi boşluğunu kapatmak özgüvenin temelidir.',
          difficulty: TaskDifficulty.easy,
          minutes: 15,
        ),
      2 => _task(
          type: TaskType.mental,
          category: TaskCategory.discipline,
          title: 'Tutarlılık Zinciri',
          description: 'Bugünün planını sabah yaz, akşam ne kadarını yaptığını işaretle.',
          rationale: 'Zinciri kırma. Her tamamlanan gün bir sonrakini kolaylaştırır.',
          difficulty: TaskDifficulty.medium,
          minutes: 5,
          steps: const [
            'Sabah: günün 3 önceliğini yaz',
            'Akşam: tamamladıklarını işaretle',
            'Yarına 1 ders çıkar',
          ],
        ),
      _ => _task(
          type: TaskType.mental,
          category: TaskCategory.mindset,
          title: 'Çerçeveni Koru',
          description:
              'Bugün küçük bir isteği nazikçe reddet veya bir sınırını koy — açıklama yapmadan.',
          rationale:
              'Onay aramayı bırak. Kendi değerini dışarıdan değil içeriden onayla (abundance mindset).',
          difficulty: TaskDifficulty.medium,
          minutes: 5,
        ),
    };
    tasks.add(mindset);

    // Öz değer günlüğü — düşük özgüven için
    if (p.selfConfidence <= 1) {
      tasks.add(_task(
        type: TaskType.mental,
        category: TaskCategory.mindset,
        title: 'Zafer Günlüğü',
        description: 'Bugün yaptığın, sadece senin gözünde değerli 1 şeyi yaz.',
        rationale:
            'Kendi başarılarını kayıt altına almak öz değeri dışarıdan bağımsız hale getirir.',
        difficulty: TaskDifficulty.easy,
        minutes: 5,
      ));
    }

    // Ekran detoksu (bağımlılık olarak işaretlenmediyse genel zihinsel)
    if (p.screenTime <= 1 && !p.addictionIds.contains('social_media')) {
      tasks.add(_task(
        type: TaskType.mental,
        category: TaskCategory.discipline,
        title: 'Derin Odak Bloğu',
        description: 'Telefonu başka odaya koy, 25 dk tek işe odaklan (Pomodoro).',
        rationale: 'Dikkat senin en değerli para birimin. Onu geri al.',
        difficulty: TaskDifficulty.medium,
        minutes: 25,
      ));
    }

    // Soğuk duş — herkese absürt-ama-etkili challenge
    tasks.add(_task(
      type: TaskType.mental,
      category: TaskCategory.discipline,
      title: 'Soğuk Duş Challenge',
      description: 'Duşun son 30 saniyesini buz gibi soğuk bitir.',
      rationale:
          'İradeyi çelikleştirir, dopamini dengeler, "rahatsızlığı seçme" kasını çalıştırır.',
      difficulty: TaskDifficulty.medium,
      minutes: 2,
    ));

    return tasks;
  }

  // ============================================================
  // SOSYAL — sosyalleşme, iletişim, flört (anksiyeteye göre kademeli)
  // ============================================================
  static List<DailyTask> _socialTasks(IntakeProfile p) {
    final tasks = <DailyTask>[];
    final anxiety = p.socialAnxiety; // 0..3

    if (anxiety >= 2) {
      // Yüksek anksiyete — çok küçük, güvenli adımlar
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Mikro Maruz Kalma',
        description: 'Bugün tek bir küçük sosyal teması başar — baskı yok.',
        rationale:
            'Sosyal kaygı kaçındıkça büyür, küçük adımlarla maruz kaldıkça küçülür. Bugün sadece 1 adım.',
        difficulty: TaskDifficulty.easy,
        minutes: 5,
        steps: const [
          'Bir kasiyere/komşuya gülümseyip "merhaba" de',
          'Sesini titrese bile söyle — amaç mükemmellik değil, tekrar',
          'Sonrasında kendini tebrik et',
        ],
      ));
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Göz Teması Kası',
        description: 'Bugün 3 farklı kişiyle 2 saniye göz teması kur.',
        rationale: 'Göz teması güven sinyalidir; kas gibi tekrarla güçlenir.',
        difficulty: TaskDifficulty.easy,
        minutes: 5,
      ));
    } else if (anxiety == 1) {
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Sohbet Başlat',
        description: 'Tanımadığın biriyle 1 dakikalık gerçek bir sohbet başlat.',
        rationale: 'Küçük sohbetler sosyal sezgini ve rahatlığını büyütür.',
        difficulty: TaskDifficulty.medium,
        minutes: 10,
        steps: const [
          'Bir gözlem/iltifatla aç ("Bu mekan güzelmiş")',
          'Açık uçlu 1 soru sor',
          'Karşının cevabına gerçekten kulak ver',
        ],
      ));
    } else {
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Liderlik Anı',
        description: 'Bir grup ortamında inisiyatif al: plan öner veya konuyu yönlendir.',
        rationale: 'Sosyal rahatlığın var — şimdi alanı domine etme pratiği yap.',
        difficulty: TaskDifficulty.hard,
        minutes: 15,
      ));
    }

    // Flört / kadınlarla iletişim — deneyime ve hedefe göre (redpill çerçeve, saygılı)
    if (p.datingExperience <= 1) {
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Tanışma Adımı',
        description:
            'Bugün ilgini çeken biriyle (kadın/erkek farketmez) saygılı, kısa bir iletişim kur.',
        rationale:
            'Flört bir beceridir, doğuştan değil. Reddedilme korkusunu küçük tekrarla aş.',
        difficulty: TaskDifficulty.medium,
        minutes: 10,
        steps: const [
          'Dürüst ve net bir açılış yap (oyun değil)',
          'Baskı kurma, sonucu umursamamayı pratik et',
          'Reddedilirsen "tecrübe +1" say, devam et',
        ],
      ));
    } else {
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Çekim & Çerçeve',
        description:
            'Bir etkileşimde muhtaç olmadan, özgüvenli ve eğlenceli kalmayı pratik et.',
        rationale:
            'Muhtaçlık (neediness) çekiciliği öldürür. Kendi değerinden emin ol.',
        difficulty: TaskDifficulty.hard,
        minutes: 15,
      ));
    }

    // Sosyal çevre küçükse — ağ kurma
    if (p.socialCircle <= 1) {
      tasks.add(_task(
        type: TaskType.social,
        category: TaskCategory.socialSkill,
        title: 'Bağ Kur',
        description: 'Eski bir arkadaşa yaz veya yeni bir kişiyle iletişimi sürdür.',
        rationale: 'Güçlü bir sosyal çevre özgüvenin ve fırsatların temelidir.',
        difficulty: TaskDifficulty.easy,
        minutes: 5,
      ));
    }

    return tasks;
  }

  // ============================================================
  // BAĞIMLILIK — seçilen her bağımlılık için kurtulma görevi
  // ============================================================
  static List<DailyTask> _addictionTasks(
    IntakeProfile p,
    List<Addiction> addictions,
  ) {
    // Aktif takip edilen bağımlılıklar varsa onları kullan; yoksa formdakiler
    final ids = addictions.isNotEmpty
        ? addictions.map((a) => a.typeId).toList()
        : p.addictionIds;

    final tasks = <DailyTask>[];
    for (final id in ids) {
      final type = AddictionType.byId(id);
      if (type == null) continue;
      tasks.add(_task(
        type: TaskType.mental,
        category: TaskCategory.addiction,
        title: '${type.emoji} ${type.label} — Temiz Kal',
        description: type.motivationLine,
        rationale:
            'Bugün temiz kalmak streak\'ini büyütür. Her gün öncekinden kolaylaşır.',
        difficulty: TaskDifficulty.hard,
        minutes: 5,
        steps: type.recoverySteps,
      ));
    }
    return tasks;
  }

  // ============================================================
  // Yardımcı
  // ============================================================
  static DailyTask _task({
    required TaskType type,
    required TaskCategory category,
    required String title,
    required String description,
    String? rationale,
    TaskDifficulty difficulty = TaskDifficulty.medium,
    int minutes = 10,
    List<String> steps = const [],
    bool isProOnly = false,
  }) {
    final xp = switch (type) {
      TaskType.social => XpConfig.xpSocialTask,
      _ => XpConfig.xpPerTask,
    };
    return DailyTask(
      id: _uuid.v4(),
      type: type,
      category: category,
      title: title,
      description: description,
      rationale: rationale,
      xpReward: difficulty == TaskDifficulty.hard ? xp + 25 : xp,
      status: TaskStatus.pending,
      isProOnly: isProOnly,
      durationMinutes: minutes,
      difficulty: difficulty,
      steps: steps.map((s) => TaskStep(label: s)).toList(),
    );
  }

  /// Hiç veri yoksa kullanılan güvenli varsayılan set
  static List<DailyTask> defaultTasks() {
    return generate(const IntakeProfile(
      name: 'Savaşçı',
      age: 20,
      heightCm: 175,
      weightKg: 75,
    ));
  }
}
