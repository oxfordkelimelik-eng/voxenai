import 'package:equatable/equatable.dart';

/// İlk açılışta doldurulan detaylı giriş formunun ham verisi.
/// TaskGenerator bu profili okuyarak kişiselleştirilmiş görev seti üretir.
///
/// Tüm çoktan seçmeli alanlar seçilen seçeneğin index'ini tutar (-1 = boş).
class IntakeProfile extends Equatable {
  // --- Kişisel ---
  final String name;
  final int age;
  final double heightCm;
  final double weightKg;

  // --- Fiziksel ---
  final int fitnessLevel; // 0 hiç .. 3 profesyonel
  final int trainingPlace; // 0 ev,1 salon,2 açık hava,3 farketmez (artık sorulmuyor)
  final int bodyGoal; // 0 yağ yak,1 kas yap,2 hem,3 sadece sağlık
  final int targetArea; // 0 karın/core,1 üst vücut,2 bacak/alt,3 genel
  final int dailyTime; // haftalık antrenman günü: 0:1-2 gün 1:3-4 gün 2:5-6 gün 3:her gün

  // --- Beslenme & Uyku (disiplin) ---
  final int nutritionHabit; // 0 düzensiz .. 3 tam kontrol
  final int sleepHabit; // 0 düzensiz .. 3 çok düzenli
  final int waterHabit; // 0 az .. 3 bol

  // --- Zihinsel ---
  final int mainStruggle; // 0 motivasyon,1 bilgi,2 tutarlılık,3 sosyal kaygı,4 özgüven
  final int selfConfidence; // 0 çok düşük .. 3 yüksek
  final int discipline; // 0 dağınık .. 3 çok disiplinli
  final int screenTime; // 0 çok yüksek .. 3 düşük

  // --- Sosyal / Anksiyete ---
  final int socialAnxiety; // 0 hiç .. 3 çok yüksek
  final int socialCircle; // 0 yalnız .. 3 geniş
  final int datingExperience; // 0 hiç,1 az,2 orta,3 deneyimli
  final int eyeContactComfort; // 0 zor .. 3 rahat

  // --- Bağımlılıklar (çoklu seçim — seçilenlerin id'leri) ---
  final List<String> addictionIds; // 'porn','social_media','smoking','sugar','gaming','alcohol','caffeine'
  final int addictionSeverity; // 0 hafif .. 3 ciddi (genel)

  // --- Foto yolları (opsiyonel) ---
  final String? facePhotoPath;
  final String? bodyPhotoPath;

  const IntakeProfile({
    required this.name,
    required this.age,
    required this.heightCm,
    required this.weightKg,
    this.fitnessLevel = 0,
    this.trainingPlace = 0,
    this.bodyGoal = 2,
    this.targetArea = 3,
    this.dailyTime = 1,
    this.nutritionHabit = 0,
    this.sleepHabit = 1,
    this.waterHabit = 1,
    this.mainStruggle = 0,
    this.selfConfidence = 1,
    this.discipline = 1,
    this.screenTime = 1,
    this.socialAnxiety = 1,
    this.socialCircle = 1,
    this.datingExperience = 0,
    this.eyeContactComfort = 1,
    this.addictionIds = const [],
    this.addictionSeverity = 1,
    this.facePhotoPath,
    this.bodyPhotoPath,
  });

  IntakeProfile copyWith({
    String? facePhotoPath,
    String? bodyPhotoPath,
  }) {
    return IntakeProfile(
      name: name,
      age: age,
      heightCm: heightCm,
      weightKg: weightKg,
      fitnessLevel: fitnessLevel,
      trainingPlace: trainingPlace,
      bodyGoal: bodyGoal,
      targetArea: targetArea,
      dailyTime: dailyTime,
      nutritionHabit: nutritionHabit,
      sleepHabit: sleepHabit,
      waterHabit: waterHabit,
      mainStruggle: mainStruggle,
      selfConfidence: selfConfidence,
      discipline: discipline,
      screenTime: screenTime,
      socialAnxiety: socialAnxiety,
      socialCircle: socialCircle,
      datingExperience: datingExperience,
      eyeContactComfort: eyeContactComfort,
      addictionIds: addictionIds,
      addictionSeverity: addictionSeverity,
      facePhotoPath: facePhotoPath ?? this.facePhotoPath,
      bodyPhotoPath: bodyPhotoPath ?? this.bodyPhotoPath,
    );
  }

  double get bmi => weightKg / ((heightCm / 100) * (heightCm / 100));

  bool get hasHighSocialAnxiety => socialAnxiety >= 2;
  bool get hasAddictions => addictionIds.isNotEmpty;

  Map<String, dynamic> toJson() => {
    'name': name,
    'age': age,
    'heightCm': heightCm,
    'weightKg': weightKg,
    'fitnessLevel': fitnessLevel,
    'trainingPlace': trainingPlace,
    'bodyGoal': bodyGoal,
    'targetArea': targetArea,
    'dailyTime': dailyTime,
    'nutritionHabit': nutritionHabit,
    'sleepHabit': sleepHabit,
    'waterHabit': waterHabit,
    'mainStruggle': mainStruggle,
    'selfConfidence': selfConfidence,
    'discipline': discipline,
    'screenTime': screenTime,
    'socialAnxiety': socialAnxiety,
    'socialCircle': socialCircle,
    'datingExperience': datingExperience,
    'eyeContactComfort': eyeContactComfort,
    'addictionIds': addictionIds,
    'addictionSeverity': addictionSeverity,
    'facePhotoPath': facePhotoPath,
    'bodyPhotoPath': bodyPhotoPath,
  };

  factory IntakeProfile.fromJson(Map<String, dynamic> j) => IntakeProfile(
    name: j['name'] as String? ?? 'Savaşçı',
    age: j['age'] as int? ?? 20,
    heightCm: (j['heightCm'] as num?)?.toDouble() ?? 175,
    weightKg: (j['weightKg'] as num?)?.toDouble() ?? 75,
    fitnessLevel: j['fitnessLevel'] as int? ?? 0,
    trainingPlace: j['trainingPlace'] as int? ?? 0,
    bodyGoal: j['bodyGoal'] as int? ?? 2,
    targetArea: j['targetArea'] as int? ?? 3,
    dailyTime: j['dailyTime'] as int? ?? 1,
    nutritionHabit: j['nutritionHabit'] as int? ?? 0,
    sleepHabit: j['sleepHabit'] as int? ?? 1,
    waterHabit: j['waterHabit'] as int? ?? 1,
    mainStruggle: j['mainStruggle'] as int? ?? 0,
    selfConfidence: j['selfConfidence'] as int? ?? 1,
    discipline: j['discipline'] as int? ?? 1,
    screenTime: j['screenTime'] as int? ?? 1,
    socialAnxiety: j['socialAnxiety'] as int? ?? 1,
    socialCircle: j['socialCircle'] as int? ?? 1,
    datingExperience: j['datingExperience'] as int? ?? 0,
    eyeContactComfort: j['eyeContactComfort'] as int? ?? 1,
    addictionIds:
        (j['addictionIds'] as List?)?.map((e) => e as String).toList() ??
            const [],
    addictionSeverity: j['addictionSeverity'] as int? ?? 1,
    facePhotoPath: j['facePhotoPath'] as String?,
    bodyPhotoPath: j['bodyPhotoPath'] as String?,
  );

  @override
  List<Object?> get props => [
        name,
        age,
        heightCm,
        weightKg,
        fitnessLevel,
        trainingPlace,
        bodyGoal,
        targetArea,
        dailyTime,
        nutritionHabit,
        sleepHabit,
        waterHabit,
        mainStruggle,
        selfConfidence,
        discipline,
        screenTime,
        socialAnxiety,
        socialCircle,
        datingExperience,
        eyeContactComfort,
        addictionIds,
        addictionSeverity,
        facePhotoPath,
        bodyPhotoPath,
      ];
}
