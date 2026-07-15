import 'package:flutter/material.dart';

/// Dating Asistanı — merkezi sabitler (metinler, krediler, stiller, storage).
/// README "Build Spesifikasyonu" bölümlerine göre yapılandırılmıştır.
class DatingConfig {
  DatingConfig._();

  // === Temsili veri notu (Bölüm 0 — zorunlu) ===
  static const String representativeNote = '*Temsili veriler';

  // ============================================================
  // FİYATLANDIRMA — ABONELİK YOK, TEK SEFERLİK PAKET MODELİ
  // ------------------------------------------------------------
  // Model: her üretim/analiz akışında yalnızca İLK ÇIKTI (1 foto) ücretsiz
  // gösterilir; devamını görmek/indirmek için paket satın alınır. Yenilenen
  // abonelik yoktur; paket biter, kullanıcı yeniden alır.
  //
  // PAKETLER:
  //   Foto Analizi : Tekli   1 analiz  → ₺99
  //                  Standart 5 analiz  → ₺249
  //   AI Foto Üretimi : Standart 10 foto (1 stil)  → ₺249
  //                     Premium  50 foto (5 stil)  → ₺999
  // ============================================================

  // --- Üretim birimi ---
  static const int photosPerSet = 10; // tek üretimde/stilde çıkan foto sayısı

  // --- İlk çıktı önizlemesi: ücretsiz gösterilen foto sayısı ---
  // AI foto üretiminde VE foto analizinde üretilen/işlenen ilk foto/sonuç
  // ücretsiz gösterilir; kalanlar için paket gerekir.
  static const int freePreviewCount = 1;

  // --- Foto Analizi paketleri ---
  static const int analysisSingleRuns = 1; // Tekli
  static const String analysisSinglePriceLabel = '₺99';
  static const String analysisSingleProductId = 'dating_pack_analysis1';

  static const int analysisStandardRuns = 5; // Standart
  static const String analysisStandardPriceLabel = '₺249';
  static const String analysisStandardProductId = 'dating_pack_analysis5';

  // --- AI Foto Üretimi paketleri ---
  static const int photoStandardSets = 1; // Standart: 1 stil (10 foto)
  static const int photoStandardPhotos = photosPerSet * photoStandardSets; // 10
  static const String photoStandardPriceLabel = '₺249';
  static const String photoStandardProductId = 'dating_pack_photo10';

  static const int photoPremiumSets = 5; // Premium: 5 stil (50 foto)
  static const int photoPremiumPhotos = photosPerSet * photoPremiumSets; // 50
  static const String photoPremiumPriceLabel = '₺999';
  static const String photoPremiumProductId = 'dating_pack_photo50';

  // --- Dahili kredi altyapısı (yalnızca pasif modüller için — arka planda) ---
  static const int creditsAiPhoto = 10; // AI foto üretimi
  static const int creditsAnalysis = 3; // fotoğraf analizi
  static const int creditsText = 1; // (pasif modüller — arka planda)
}

/// AI foto üretimi stilleri (Bölüm 6.3 — çekirdek 7 stil)
class PhotoStyle {
  final String id;
  final String label;
  final String description;
  final IconData icon;
  const PhotoStyle(this.id, this.label, this.description, this.icon);

  static const List<PhotoStyle> coreStyles = [
    PhotoStyle('elegance', 'Elegance / Karizma', 'Şık, karizmatik, bakımlı',
        Icons.diamond_outlined),
    PhotoStyle('athletic', 'Athletic', 'Atletik, dinamik, formda',
        Icons.fitness_center),
    PhotoStyle('traveller', 'World Traveller', 'Dünya gezgini, maceracı',
        Icons.travel_explore),
    PhotoStyle('oldmoney', 'Old Money', 'Klasik varlık estetiği',
        Icons.account_balance_outlined),
    PhotoStyle('nightout', 'Night Out', 'Gece çıkışı, sosyal',
        Icons.nightlife),
    PhotoStyle('beach', 'Beach Body', 'Plaj, fit vücut', Icons.beach_access),
    PhotoStyle('car', 'Car', 'Arabayla, prestij', Icons.directions_car_filled),
  ];
}

/// Uygulama modülleri (Bölüm 4 — 6 modül)
class DatingModule {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final int creditCost;
  const DatingModule(
      this.id, this.title, this.subtitle, this.icon, this.creditCost);

  static const aiPhoto = DatingModule(
    'ai_photo',
    'AI Dating Fotoğrafı Üretimi',
    'Kendi fotoğrafından farklı stillerde çekici dating fotoğrafları oluştur.',
    Icons.auto_awesome,
    DatingConfig.creditsAiPhoto,
  );
  static const photoAnalysis = DatingModule(
    'photo_analysis',
    'Fotoğraf Analizi & Seçimi',
    'Fotoğraflarını puanlar, çekicilik skoru verir, en iyileri önerir.',
    Icons.insights,
    DatingConfig.creditsAnalysis,
  );
  static const coach = DatingModule(
    'coach',
    'Dating Coach',
    'Sohbet & strateji koçluğu; ne yazacağın konusunda yönlendirir.',
    Icons.chat_bubble_outline,
    DatingConfig.creditsText,
  );
  static const rizz = DatingModule(
    'rizz',
    'RizzGPT — Witty Replies',
    'Konuşma/mesaj için esprili, çekici cevap önerileri.',
    Icons.bolt,
    DatingConfig.creditsText,
  );
  static const bio = DatingModule(
    'bio',
    'Bio & Prompt Yardımcısı',
    'Bio ve Hinge prompt\'larını yazar, geliştirir, geri bildirim verir.',
    Icons.edit_note,
    DatingConfig.creditsText,
  );
  static const looksmaxxing = DatingModule(
    'looksmaxxing',
    'Looksmaxxing — Yüz & Vücut',
    'Yüz ve vücut için yapıcı iyileştirme önerileri.',
    Icons.face_retouching_natural,
    DatingConfig.creditsAnalysis,
  );

  // Aktif modüller. Diğer modüllerin (coach, rizz, bio, looksmaxxing) kodları
  // arka planda korunur ancak şu an pasif — sadece bu ikisi gösterilir.
  static const List<DatingModule> all = [
    aiPhoto,
    photoAnalysis,
  ];
}

/// Dating akışına özel SharedPreferences anahtarları
class DatingKeys {
  DatingKeys._();
  static const String onboardingDone = 'dating_onboarding_done';
  static const String answers = 'dating_answers'; // JSON — quiz cevapları
  static const String credits = 'dating_credits';
  static const String signedInProvider = 'dating_signin_provider';
  static const String consentGiven = 'dating_consent';
  // Modül başına ücretsiz deneme hakkı kullanıldı mı?
  static const String freePhotoUsed = 'dating_free_photo_used';
  static const String freeAnalysisUsed = 'dating_free_analysis_used';
  // Tek seferlik paketle satın alınan bakiye
  static const String packPhotoBalance = 'dating_pack_photo';
  static const String packAnalysisBalance = 'dating_pack_analysis';
}

/// Mock / gerçek modül görselleri için dosya yolları.
/// Görselleri bu yollara koy; yoksa uygulama placeholder gösterir.
class DatingAssetPaths {
  DatingAssetPaths._();

  /// Stil örnek fotoğrafları: assets/dating/styles/{styleId}_1.jpg … _3.jpg
  static String styleSample(String styleId, int index) =>
      'assets/dating/styles/${styleId}_$index.jpg';

  static const moduleAiPhotoHero = 'assets/dating/modules/ai_photo_hero.jpg';
  static const moduleAnalysisHero =
      'assets/dating/modules/photo_analysis_hero.jpg';

  /// Onboarding / vitrin slider görselleri
  static const showcaseSlide1 = 'assets/dating/showcase/slide_1.jpg';
  static const showcaseSlide2 = 'assets/dating/showcase/slide_2.jpg';
  static const showcaseSlide3 = 'assets/dating/showcase/slide_3.jpg';

  /// Modül hub kart görselleri
  static const hubAiPhoto = 'assets/dating/modules/hub_ai_photo.jpg';
  static const hubAnalysis = 'assets/dating/modules/hub_analysis.jpg';
}
