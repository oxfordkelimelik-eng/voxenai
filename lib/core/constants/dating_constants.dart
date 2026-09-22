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
  // Model: foto ANALİZİ akışında yalnızca İLK ÇIKTI (1 analiz) ücretsiz
  // gösterilir; devamını görmek/indirmek için paket satın alınır. AI FOTO
  // ÜRETİMİNDEKİ ücretsiz ilk deneme 2026-09-09'da yorum satırına alındı
  // (bkz. functions/falPhotos.js startPhotoGeneration, dating_providers.dart
  // canAffordPhotos) — foto üretiminde artık baştan paket gerekiyor.
  // Yenilenen abonelik yoktur; paket biter, kullanıcı yeniden alır.
  //
  // PAKETLER (2026-09-21 hedef yapısı — geçiş sürüyor):
  //   AI Foto + OPSİYONEL analiz (varsayılan işaretli, kaldırılabilir):
  //     Başlangıç  5 foto  ₺349  (+1 analiz ₺150 → ₺499)
  //     Standart  10 foto  ₺499  (+3 analiz ₺300 → ₺799)
  //     Premium   25 foto  ₺999  (+5 analiz ₺300 → ₺1.299)
  //   Analiz paketleri TEK BAŞINA SATILMAZ (yeni kural). Analiz bakiyesi
  //   biten kullanıcı yukarıdaki foto+analiz seçeneklerine yönlendirilir.
  //
  //   GEÇİŞ NOTU: eski yapı (hediye analizli photos10/photos25 ve tek başına
  //   satılan dating_pack_analysis1/5) mağazada HÂLÂ satışta ve eski
  //   build'lerde hâlâ görünüyor; yeni paywall yayına girip yayılana kadar
  //   ikisi bir arada yaşayacak. Ayrıntı: aşağıdaki "OPSİYONEL ANALİZ
  //   EKLENTİLİ PAKETLER" başlığı.
  //   Not: yukarıdaki foto üretimi fiyatları mağaza (App Store Connect /
  //   Play Console) tarafında ayarlanır, bu dosyadaki *PriceLabel sabitleri
  //   artık UI'da kullanılmıyor (bkz. aşağıdaki uyarı) — gerçek tahsilat
  //   her zaman datingStorePrice() ile mağazadan gelir.
  // ============================================================

  // --- Üretim birimi ---
  // STİL MANTIĞI KALDIRILDI (2026-09-18, kullanıcı kararı). Artık kullanıcı
  // stil seçmiyor; paket yalnızca KAÇ FOTO üretileceğini belirliyor ve
  // şablonlar yalnızca BOY BANDINA (short / middle / tall) göre seçiliyor.
  //
  // Bir paket TEK ÜRETİMDE o kadar foto üretir: 10'luk paket iki adet 5'lik
  // üretim DEĞİLDİR, tek işte 10 fotoğraftır.
  // functions/falPhotos.js PHOTO_PACK_SIZES ile EL İLE senkron tutulmalı.
  static const List<int> photoPackSizes = [5, 10, 25];

  // Foto sayısı bunu aşan paketlerde üretim uzun sürer; loader'da kullanıcıya
  // beklemesi gerektiği açıkça söylenir (bkz. longJobNoticeText).
  static const int longJobPhotoThreshold = 25;
  static const String longJobNoticeText =
      'Bu paket 25 fotoğraf üretiyor — işlem 8-10 dakika sürebilir. '
      'Uygulamayı açık bırak.';

  // "Foto garantisi" (2026-08-16): bir chunk kalite kapısından geçemezse
  // sunucu FARKLI bir şablonla ta OPENAI_DIRECT_MAX_ATTEMPTS'e (6) kadar
  // yeniden dener; yine de eksik teslim olursa EKSİK KALAN HER FOTO için hak
  // iade edilir (bkz. functions/falPhotos.js missingPhotos).
  //
  // ESKİ SABİT — yalnızca güncellenmemiş istemcilerle uyum için duruyor:
  // sunucu `styles` gönderen eski istemcide stil başına bu kadar foto sayar
  // (bkz. functions/falPhotos.js LEGACY_PHOTOS_PER_STYLE). Yeni akışta
  // KULLANILMAZ.
  static const int photosPerSet = 10;

  // AI foto üretimi referansları: 3 canlı yüz (ön / sağ / sol).
  //
  // TAM BOY FOTOĞRAF KALDIRILDI (2026-08-20, kullanıcı kararı): boy ve vücut
  // tipi zaten onboarding formundan alınıyor (bodyProfile).
  // GÖĞÜS-ÜSTÜ 2 KARE DE KALDIRILDI (2026-09-06, kullanıcı kararı): o kareleri
  // okuyan tek yer üretim prompt'uydu, çıktıyı eleyen hiçbir kapı onlara
  // bakmıyordu (gerekçe: functions/faceQuality.js başındaki not).
  // functions/falPhotos.js FACE_PHOTO_COUNT ile senkron.
  static const int faceCaptureCount = 3;
  static const int referencePhotoCount = faceCaptureCount; // 3

  // --- İlk çıktı önizlemesi: ücretsiz gösterilen foto sayısı ---
  // AI foto üretiminde VE foto analizinde üretilen/işlenen ilk foto/sonuç
  // ücretsiz gösterilir; kalanlar için paket gerekir.
  static const int freePreviewCount = 1;

  // --- Foto Analizi paketleri ---
  //
  // UYARI (2026-08-20): aşağıdaki *PriceLabel sabitleri artık ARAYÜZDE
  // KULLANILMIYOR; yalnızca hangi fiyat basamağının hedeflendiğini belgeleyen
  // referanslardır. Kullanıcıya gösterilen fiyat HER ZAMAN mağazadan
  // (ProductDetails.price) gelir ve kullanıcının ülkesine göre yerelleşir.
  // Bunları tekrar UI'a bağlama: App Store Connect'teki gerçek fiyat
  // basamağıyla uyuşmazlarsa kullanıcıya tahsil edilenden farklı bir fiyat
  // gösterilir (App Store "yanıltıcı fiyat" reddi riski).
  // Bkz. datingStorePrice — dating_providers.dart.
  static const int analysisSingleRuns = 1; // Tekli
  static const String analysisSinglePriceLabel = '₺99';
  static const String analysisSingleProductId = 'dating_pack_analysis1';

  static const int analysisStandardRuns = 5; // Standart
  static const String analysisStandardPriceLabel = '₺249';
  static const String analysisStandardProductId = 'dating_pack_analysis5';

  // --- AI Foto Üretimi paketleri (2026-09-18 yapısı) ---
  //
  // ÜÇ PAKET, STİL YOK, HEDİYE ANALİZ VAR:
  //   Başlangıç :  5 foto              — ₺349
  //   Standart  : 10 foto + 1 analiz   — ₺499
  //   Premium   : 25 foto + 3 analiz   — ₺999
  //
  // YENİ ÜRÜN ID'LERİ: eski ID'ler ('...photo10' / '...photo50') farklı bir
  // içeriğe bağlıydı (₺349 = 10 foto, ₺999 = 50 foto). Aynı ID'yi yeni
  // içerikle yeniden kullanmak, mağazadan gelen eski makbuzların yanlış
  // kredilenmesine yol açardı; bu yüzden üç YENİ ID tanımlandı. Eski ID'ler
  // sunucuda hâlâ TANINIYOR (geri yükleme + yolda olan ödeme için) —
  // bkz. functions/payments.js PRODUCT_CREDITS.
  //
  // Mağaza kaydı (App Store Connect + Play Console) kullanıcı tarafından
  // yapılır; kod fiyatı doğrulayamaz, fiyat HER ZAMAN mağazadan gelir.
  static const int photoStarterPhotos = 5;
  static const int photoStarterGiftAnalyses = 0;
  static const String photoStarterPriceLabel = '₺349';
  static const String photoStarterProductId = 'dating_pack_photos5';

  static const int photoStandardPhotos = 10;
  static const int photoStandardGiftAnalyses = 1;
  static const String photoStandardPriceLabel = '₺499';
  static const String photoStandardProductId = 'dating_pack_photos10';

  static const int photoPremiumPhotos = 25;
  static const int photoPremiumGiftAnalyses = 3;
  static const String photoPremiumPriceLabel = '₺999';
  static const String photoPremiumProductId = 'dating_pack_photos25';

  // --- OPSİYONEL ANALİZ EKLENTİLİ PAKETLER (2026-09-21 yapısı) ---
  //
  // YENİ KURAL: analiz paketleri artık TEK BAŞINA satılmıyor; yalnızca bir
  // AI Foto paketinin yanına opsiyonel (varsayılan işaretli, kullanıcı
  // kaldırabilir) ek olarak eklenebiliyor. Yukarıdaki photoStandard/
  // photoPremiumProductId ("hediye" ID'leri) BİLEREK DOKUNULMADI — mevcut
  // paywall'da o ID'ler hâlâ "+1/+3 analiz hediye" diye satılıyor, kredi
  // tablosunu değiştirmek eski build'deki kullanıcıya verilen sözü keserdi
  // (bkz. functions/payments.js PRODUCT_CREDITS aynı başlıklı not). Bu
  // yüzden opsiyonel-analiz modeli TAMAMEN YENİ ürün ID'leriyle geliyor;
  // eskiler mağazadan kaldırılınca (Remove From Sale, asla silinmez) bu
  // yeni ID'ler onların yerini alacak.
  //
  // ÜÇ TIER'IN DE AYRI "_solo" ID'Sİ VAR (2026-09-21, kullanıcı kararı).
  // Başlangıç'ın sade hâli içerik ve fiyat olarak photoStarterProductId ile
  // aynı (5 foto, analizsiz, ₺349) ama yine de ayrı bir ID: yeni paywall
  // eski nesil ID'lerin hiçbirine bağlanmazsa, eski üçlü ileride tek
  // seferde satıştan kaldırılabilir. Eskiye bağlı kalsaydı o ürünü sonsuza
  // kadar satışta tutmak zorunda kalırdık.
  static const String photoStarterSoloProductId = 'dating_pack_photos5_solo';
  static const int photoStarterAnalysisAddOnRuns = 1;
  static const String photoStarterAnalysisAddOnPriceLabel = '₺150';
  static const String photoStarterAnalysisAddOnProductId =
      'dating_pack_photos5_analysis1';
  static const String photoStarterBundlePriceLabel = '₺499';

  static const String photoStandardSoloProductId = 'dating_pack_photos10_solo';
  static const int photoStandardAnalysisAddOnRuns = 3;
  static const String photoStandardAnalysisAddOnPriceLabel = '₺300';
  static const String photoStandardAnalysisAddOnProductId =
      'dating_pack_photos10_analysis3';
  static const String photoStandardBundlePriceLabel = '₺799';

  static const String photoPremiumSoloProductId = 'dating_pack_photos25_solo';
  static const int photoPremiumAnalysisAddOnRuns = 5;
  static const String photoPremiumAnalysisAddOnPriceLabel = '₺300';
  static const String photoPremiumAnalysisAddOnProductId =
      'dating_pack_photos25_analysis5';
  static const String photoPremiumBundlePriceLabel = '₺1.299';

  /// Paywall ve vitrinin ORTAK paket listesi (2026-09-22).
  ///
  /// İki ekran da aynı üçlüyü gösteriyor; ayrı ayrı tanımlanınca başlıklar,
  /// analiz adetleri ve ürün ID eşleşmeleri birbirinden kayma riski taşıyor
  /// (vitrinde "AI Foto Premium", paywall'da "Premium Paket" yazması gibi).
  /// Tek kaynak burada.
  ///
  /// Kullanıcıya gösterilen fiyat BURADA YOK ve olmamalı — hem paket hem
  /// eklenti fiyatı her zaman mağazadan gelir (bkz. datingStorePrice ve
  /// datingAddOnPriceLabel).
  static const List<PhotoPackTier> photoPackTiers = [
    PhotoPackTier(
      title: 'Başlangıç Paketi',
      photos: photoStarterPhotos,
      soloProductId: photoStarterSoloProductId,
      addOnProductId: photoStarterAnalysisAddOnProductId,
      addOnRuns: photoStarterAnalysisAddOnRuns,
    ),
    PhotoPackTier(
      title: 'Premium Paket',
      photos: photoStandardPhotos,
      soloProductId: photoStandardSoloProductId,
      addOnProductId: photoStandardAnalysisAddOnProductId,
      addOnRuns: photoStandardAnalysisAddOnRuns,
      badge: 'EN POPÜLER',
    ),
    PhotoPackTier(
      title: 'Diamond Paket',
      photos: photoPremiumPhotos,
      soloProductId: photoPremiumSoloProductId,
      addOnProductId: photoPremiumAnalysisAddOnProductId,
      addOnRuns: photoPremiumAnalysisAddOnRuns,
      badge: 'EN İYİ DEĞER',
    ),
  ];

  // FOTO PAKETLERİNİN "ESKİ FİYAT" SABİTLERİ KALDIRILDI (2026-09-18).
  // Paket içerikleri değişti (₺349 eskiden 10 fotoydu, artık 5); eski
  // rakamları üstü çizili "indirim" olarak göstermek yanıltıcı olurdu ve
  // App Store bunu "yanıltıcı fiyat" gerekçesiyle reddedebilir. Paywall ve
  // vitrin kartları artık foto paketlerinde indirim rozeti göstermiyor.
  // discountPercent yardımcısı duruyor — analiz paketleri için kullanılabilir.

  /// Eski/hedef TL'den yüzde indirim hesaplar — mağaza fiyat string'i
  /// PARSE EDİLMEZ (format riski, "$4.99"/"₺249,00" gibi yerel biçimler
  /// kırılgan olurdu). Sadece bu iki dokümante edilmiş TL sabitinden türer.
  static int discountPercent(int oldTl, int newTl) =>
      (((oldTl - newTl) / oldTl) * 100).round();

  // --- Dahili kredi altyapısı (yalnızca pasif modüller için — arka planda) ---
  static const int creditsAiPhoto = 10; // AI foto üretimi
  static const int creditsAnalysis = 3; // fotoğraf analizi
  static const int creditsText = 1; // (pasif modüller — arka planda)

  // --- Yasal sayfalar (App Store Privacy Policy URL + uygulama içi linkler) ---
  // docs/ klasörü voxenai.com.tr üzerinde yayınlanır.
  static const String privacyPolicyUrl = 'https://voxenai.com.tr/privacy.html';
  static const String termsOfUseUrl = 'https://voxenai.com.tr/terms.html';
  static const String dataProcessingUrl = 'https://voxenai.com.tr/data.html';
  static const String supportEmail = 'destek@voxenai.com.tr';
}

/// Bir AI foto paketi ve ona bağlı opsiyonel analiz eklentisi.
///
/// Kullanıcı eklentiyi işaretli bırakırsa [addOnProductId], kaldırırsa
/// [soloProductId] satın alınır — tek kart, iki ürün ID'si. Analiz paketi
/// tek başına satılmadığı için eklentinin kendi başına bir ürünü YOKTUR.
///
/// FİYAT BİLEREK YOK: paketin fiyatı da eklentinin farkı da mağazadan gelir
/// (bkz. datingStorePrice / datingAddOnPriceLabel). Buraya bir fiyat yazmak,
/// App Store Connect'teki gerçek basamakla uyuşmama riski demek.
class PhotoPackTier {
  final String title;
  final int photos;
  final String soloProductId;
  final String addOnProductId;
  final int addOnRuns;
  final String? badge;
  const PhotoPackTier({
    required this.title,
    required this.photos,
    required this.soloProductId,
    required this.addOnProductId,
    required this.addOnRuns,
    this.badge,
  });

  /// Eklenti durumuna göre gerçekte satın alınacak ürün.
  String productId({required bool withAnalysis}) =>
      withAnalysis ? addOnProductId : soloProductId;
}

/// ARTIK ARAYÜZDE KULLANILMIYOR (2026-09-18): stil seçimi tamamen kaldırıldı,
/// kullanıcı yalnızca paket (foto sayısı) seçiyor ve şablonlar boy bandına
/// göre geliyor. Bu sınıf SİLİNMEDİ çünkü sunucudaki sahne havuzu
/// (functions/falPhotos.js STYLE_SCENES) sahneleri hâlâ bu kategori adları
/// altında gruplu tutuyor — okunabilirlik için. Buraya yeni bir şey eklemek
/// artık arayüzde hiçbir şey değiştirmez.
///
/// NOT: Eskiden 7 stildi. "Old Money" ayrı bir seçenek olmaktan çıkarıldı —
/// o estetiğin taban fotoğrafları artık "elegance" ile aynı Storage
/// klasörüne yükleniyordu. "Beach Body" tamamen kaldırıldı.
class PhotoStyle {
  final String id;
  final String label;
  final String description;
  final IconData icon;
  const PhotoStyle(this.id, this.label, this.description, this.icon);

  static const List<PhotoStyle> coreStyles = [
    PhotoStyle(
      'elegance',
      'Elegance / Karizma',
      'Şık, karizmatik, bakımlı',
      Icons.diamond_outlined,
    ),
    PhotoStyle(
      'athletic',
      'Athletic',
      'Atletik, dinamik, formda',
      Icons.fitness_center,
    ),
    PhotoStyle(
      'traveller',
      'World Traveller',
      'Dünya gezgini, maceracı',
      Icons.travel_explore,
    ),
    PhotoStyle('nightout', 'Night Out', 'Gece çıkışı, sosyal', Icons.nightlife),
    PhotoStyle('car', 'Car', 'Arabayla, prestij', Icons.directions_car_filled),
    // Kaldırılanlar (Storage klasörleri artık yok, kod referansı da silindi):
    // PhotoStyle('oldmoney', 'Old Money', 'Klasik varlık estetiği',
    //     Icons.account_balance_outlined), // -> elegance'a birleşti
    // PhotoStyle('beach', 'Beach Body', 'Plaj, fit vücut', Icons.beach_access),
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
    this.id,
    this.title,
    this.subtitle,
    this.icon,
    this.creditCost,
  );

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
  static const List<DatingModule> all = [aiPhoto, photoAnalysis];
}

/// Dating akışına özel SharedPreferences anahtarları
class DatingKeys {
  DatingKeys._();
  static const String onboardingDone = 'dating_onboarding_done';
  static const String answers = 'dating_answers'; // JSON — quiz cevapları
  static const String credits = 'dating_credits';
  static const String signedInProvider = 'dating_signin_provider';
  static const String consentGiven = 'dating_consent';
  // Üçüncü taraf AI sağlayıcısına (OpenAI) fotoğraf
  // gönderilmeden ÖNCE alınan açık rıza — App Store 5.1.1(i)/5.1.2(i) gereği
  // akış başına ayrı tutulur (bkz. ai_consent_gate.dart).
  static const String aiConsentPhoto = 'dating_ai_consent_photo';
  static const String aiConsentAnalysis = 'dating_ai_consent_analysis';
  // Modül başına ücretsiz deneme hakkı kullanıldı mı?
  static const String freePhotoUsed = 'dating_free_photo_used';
  static const String freeAnalysisUsed = 'dating_free_analysis_used';
  // Tek seferlik paketle satın alınan bakiye
  static const String packPhotoBalance = 'dating_pack_photo';
  static const String packAnalysisBalance = 'dating_pack_analysis';
  // Kullanıcı App Store/Play Store puanlama pop-up'ını daha önce tetikledik mi?
  // (bkz. review_prompt_service.dart) — Apple'ın kendisi zaten pop-up'ın kaç
  // kez GÖRÜNECEĞİNİ sınırlıyor, bu ayrıca "bir daha hiç çağırma" bayrağı.
  static const String reviewPromptShown = 'dating_review_prompt_shown';
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
