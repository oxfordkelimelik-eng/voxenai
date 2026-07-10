/// Rise Up — Gemini API Yapılandırması
class ApiConfig {
  ApiConfig._();

  /// Gemini API anahtarı güvenli depolamadan okunur
  static const String geminiBaseUrl =
      'https://generativelanguage.googleapis.com/v1beta';
  static const String geminiModel = 'gemini-2.5-flash';

  /// Uygulamaya GÖMÜLÜ anahtar YOKTUR. Anahtar yalnızca Cloud Function
  /// (Firebase Secret: GEMINI_KEY) içinde tutulur; APK/kaynak kodda görünmez.
  /// İsteğe bağlı olarak kullanıcı kendi anahtarını ayarlardan girebilir;
  /// bu anahtar yalnızca o cihazda güvenli depoda saklanır.

  /// true: foto/sohbet çağrıları Cloud Function proxy üzerinden gider (anahtar
  /// sunucuda gizli kalır). Üretimde her zaman true olmalı.
  static const bool useProxy = true;

  /// Cloud Functions bölgesi (index.js ile aynı olmalı)
  static const String functionsRegion = 'europe-west1';

  /// Multimodal vision için max token (detaylı bölgesel analiz için yükseltildi)
  static const int maxTokensAnalysis = 8192;
  static const int maxTokensChat = 2048;

  /// Timeout süreleri (saniye)
  static const int connectTimeout = 30;
  static const int receiveTimeout = 60;
}

/// SharedPreferences anahtarları
class StorageKeys {
  StorageKeys._();

  static const String apiKey = 'gemini_api_key';
  static const String userProfile = 'user_profile';
  static const String currentStreak = 'current_streak';
  static const String totalXp = 'total_xp';
  static const String userLevel = 'user_level';
  static const String dailyTasks = 'daily_tasks';
  static const String lastTaskDate = 'last_task_date';
  static const String isPro = 'is_pro';
  static const String proExpiry = 'pro_expiry';
  static const String analysisHistory = 'analysis_history';
  static const String onboardingDone = 'onboarding_done';
  static const String macroGoals = 'macro_goals';
  static const String waterToday = 'water_today';
  static const String workoutHistory = 'workout_history';
  static const String taskHistory = 'task_history';
  static const String socialLevel = 'social_level';
  static const String fastingStartTime = 'fasting_start_time';
  static const String dailySteps = 'daily_steps';
  static const String dailyStepsDate = 'daily_steps_date';
  static const String dailyStepGoal = 'daily_step_goal';

  // Anket & Deneme
  static const String surveyDone = 'survey_done';
  static const String trialStartDate = 'trial_start_date';
  static const String surveyAnswers = 'survey_answers';

  // Detaylı giriş formu (intake)
  static const String intakeData = 'intake_data'; // JSON — IntakeProfile
  static const String facePhotoPath = 'face_photo_path';
  static const String bodyPhotoPath = 'body_photo_path';

  // Ayrı analizler
  static const String faceAnalysisData = 'face_analysis_data'; // JSON
  static const String bodyAnalysisData = 'body_analysis_data'; // JSON

  // Bağımlılık takibi
  static const String addictions = 'addictions'; // JSON — List<Addiction>

  // İlerleme takibi (önce/sonra + skor çizelgesi)
  static const String progressHistory =
      'progress_history'; // JSON — List<ProgressEntry>
}

/// XP ve Seviye sistemi
class XpConfig {
  XpConfig._();

  static const int xpPerTask = 50;
  static const int xpPerAnalysis = 200;
  static const int xpStreakBonus = 25; // Her seri günü için ek XP
  static const int xpSocialTask = 75;

  /// Seviye eşikleri (0. index = Level 1 minimum XP)
  static const List<int> levelThresholds = [
    0, // Level 1
    500, // Level 2
    1200, // Level 3
    2500, // Level 4
    4500, // Level 5
    7000, // Level 6
    10000, // Level 7
    15000, // Level 8
    22000, // Level 9
    30000, // Level 10 — MAX
  ];

  static const List<String> levelTitles = [
    'Çaylak',
    'Arayıcı',
    'Disiplinli',
    'Kararlı',
    'Odaklı',
    'Güçlü',
    'Elit',
    'İstilacı',
    'Dominant',
    'APEX',
  ];

  static int getLevelFromXp(int xp) {
    for (int i = levelThresholds.length - 1; i >= 0; i--) {
      if (xp >= levelThresholds[i]) return i + 1;
    }
    return 1;
  }

  static int getXpForNextLevel(int xp) {
    final level = getLevelFromXp(xp);
    if (level >= levelThresholds.length) return 0;
    return levelThresholds[level] - xp;
  }

  static double getLevelProgress(int xp) {
    final level = getLevelFromXp(xp);
    if (level >= levelThresholds.length) return 1.0;
    final currentMin = levelThresholds[level - 1];
    final nextMin = levelThresholds[level];
    return (xp - currentMin) / (nextMin - currentMin);
  }
}
