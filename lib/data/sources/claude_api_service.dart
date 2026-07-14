import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:logger/logger.dart';
import '../../core/constants/app_constants.dart';
import '../../domain/entities/face_analysis.dart';
import '../../domain/entities/body_analysis.dart';
import '../../domain/entities/region_analysis.dart';
import '../../domain/entities/intake_profile.dart';
import '../../domain/repositories/repositories.dart';

/// Google Gemini API ile multimodal vision analizi + form tabanlı fallback.
class ClaudeApiService {
  final Dio _dio;
  final FlutterSecureStorage _secureStorage;
  final Logger _logger = Logger();

  ClaudeApiService({required FlutterSecureStorage secureStorage})
    : _dio = Dio(
        BaseOptions(
          baseUrl: ApiConfig.geminiBaseUrl,
          connectTimeout: const Duration(seconds: ApiConfig.connectTimeout),
          receiveTimeout: const Duration(seconds: ApiConfig.receiveTimeout),
          headers: {'content-type': 'application/json'},
        ),
      ),
      _secureStorage = secureStorage;

  /// Yalnızca kullanıcının ELLE girdiği anahtarı döner. Gömülü/varsayılan
  /// anahtar YOKTUR — gerçek anahtar sunucudaki proxy'de gizlidir.
  Future<String?> _getUserApiKey() async {
    final stored = await _secureStorage.read(key: StorageKeys.apiKey);
    if (stored != null && stored.isNotEmpty) return stored;
    return null;
  }

  /// AI analizi mümkün mü? Proxy açıksa anahtar gerekmez (sunucu sağlar);
  /// kapalıysa yalnızca kullanıcı kendi anahtarını girdiyse mümkündür.
  Future<bool> hasApiKey() async {
    if (ApiConfig.useProxy) return true;
    return (await _getUserApiKey()) != null;
  }

  // ============================================================
  // YÜZ ANALİZİ (ön + sağ + sol açı)
  // ============================================================
  Future<FaceAnalysisResult> analyzeFace(
    List<File> imageFiles, {
    IntakeProfile? intake,
  }) async {
    final raw = await _callVision(
      imageFiles,
      '${_faceSystemPrompt()}\n\nSANA 3 YÜZ FOTOĞRAFI VERİLDİ (sırayla: 1) ÖN, 2) SAĞ profil, 3) SOL profil). '
          'Üçünü birlikte değerlendir; asimetriyi ön ve iki profili karşılaştırarak belirle. '
          'Belirtilen JSON formatında Türkçe tek bir birleşik rapor ver.',
    );
    return _parseFace(raw, fromAi: true);
  }

  // ============================================================
  // DATING FOTOĞRAFI PUANLAMA & SEÇİM
  // ============================================================
  /// Verilen fotoğrafları TEK çağrıda AI'ye puanlatır (model fotoları
  /// birbiriyle karşılaştırıp en iyisini seçebilsin diye). Her foto için
  /// 0-100 çekicilik/dating-uygunluk skoru + kısa güçlü/zayıf yön döner.
  /// Sonuç, skora göre AZALAN sıralı gelir (ilk = en iyi kare).
  Future<List<PhotoScore>> scoreDatingPhotos(List<File> imageFiles) async {
    if (imageFiles.isEmpty) {
      throw const ValidationFailure('En az bir fotoğraf gerekli.');
    }
    final prompt =
        'Sen bir dating/profil fotoğrafı uzmanısın. Sana ${imageFiles.length} '
        'fotoğraf VERİLDİ (1. fotoğraf, 2. fotoğraf ... sırayla). Her fotoğrafı '
        'bir dating/eşleşme uygulaması profili için DEĞERLENDİR: yüz netliği, '
        'ışık, kompozisyon, ifade/gülümseme, arka plan, genel çekicilik ve ilk '
        'izlenim. Kişiyi aşağılamadan, yapıcı ve dürüst ol.\n\n'
        'YALNIZCA şu formatta geçerli bir JSON DİZİSİ döndür (başka metin yok), '
        'giriş sırasıyla her fotoğraf için bir nesne:\n'
        '[{"index":1,"score":0-100 arası tam sayı,'
        '"strengths":"bu fotoğrafın güçlü yönü (Türkçe, tek cümle)",'
        '"weaknesses":"geliştirilebilecek yönü (Türkçe, tek cümle)"}]';

    final raw = await _callVision(imageFiles, prompt);
    final list = _extractJsonArray(raw);
    final scores = <PhotoScore>[];
    for (var i = 0; i < imageFiles.length; i++) {
      // Modelin sırayı koruduğunu varsayıyoruz; eksik/bozuk öğede nötr değer.
      final item = (i < list.length && list[i] is Map)
          ? list[i] as Map<String, dynamic>
          : const <String, dynamic>{};
      scores.add(PhotoScore(
        file: imageFiles[i],
        score: ((item['score'] as num?)?.toInt() ?? 0).clamp(0, 100),
        strengths: (item['strengths'] as String?)?.trim() ?? '',
        weaknesses: (item['weaknesses'] as String?)?.trim() ?? '',
      ));
    }
    // En iyi kare önce gelsin (ücretsiz önizleme en iyisini göstersin).
    scores.sort((a, b) => b.score.compareTo(a.score));
    return scores;
  }

  /// Ham metinden ilk JSON DİZİSİNİ ([...]) ayıklayıp çözer.
  List<dynamic> _extractJsonArray(String rawText) {
    var jsonStr = rawText.trim();
    final match = RegExp(r'\[[\s\S]*\]').firstMatch(jsonStr);
    if (match != null) jsonStr = match.group(0)!;
    final decoded = jsonDecode(jsonStr);
    if (decoded is! List) {
      throw const ServerFailure('AI yanıtı beklenen formatta değil.');
    }
    return decoded;
  }

  // ============================================================
  // VÜCUT ANALİZİ (ön + sağ + sol açı)
  // ============================================================
  Future<BodyAnalysisResult> analyzeBody(
    List<File> imageFiles, {
    IntakeProfile? intake,
  }) async {
    final raw = await _callVision(
      imageFiles,
      '${_bodySystemPrompt(intake)}\n\nSANA 3 VÜCUT FOTOĞRAFI VERİLDİ (sırayla: 1) ÖN, 2) SAĞ profil, 3) SOL profil). '
          'Postür ve omuz asimetrisini yan profillerden, kompozisyonu önden değerlendir. '
          'Belirtilen JSON formatında Türkçe tek bir birleşik rapor ver.',
    );
    return _parseBody(raw, fromAi: true);
  }

  Future<String> _callVision(List<File> imageFiles, String promptText) async {
    if (imageFiles.isEmpty) {
      throw const ValidationFailure('En az bir fotoğraf gerekli.');
    }
    final images = <Map<String, String>>[];
    for (final f in imageFiles) {
      final bytes = await f.readAsBytes();
      images.add({
        'data': base64Encode(bytes),
        'mimeType': _getMimeType(f.path),
      });
    }

    // 1) Önce Cloud Function proxy'yi dene (anahtar sunucuda gizli)
    if (ApiConfig.useProxy) {
      try {
        return await _callVisionProxy(images, promptText);
      } catch (e) {
        _logger.w('Proxy başarısız, doğrudan API\'ye düşülüyor: $e');
        // proxy başarısızsa aşağıdaki doğrudan çağrıya devam et
      }
    }

    // 2) Doğrudan Gemini API — yalnızca kullanıcı KENDİ anahtarını girdiyse.
    //    Gömülü anahtar yoktur; aksi halde yetkisiz hatası verilir.
    final apiKey = await _getUserApiKey();
    if (apiKey == null || apiKey.isEmpty) {
      throw const UnauthorizedFailure();
    }

    try {
      final parts = <Map<String, dynamic>>[
        {'text': promptText},
        for (final img in images)
          {
            'inline_data': {
              'mime_type': img['mimeType'],
              'data': img['data'],
            },
          },
      ];
      final response = await _dio.post(
        '/models/${ApiConfig.geminiModel}:generateContent',
        queryParameters: {'key': apiKey},
        data: {
          'contents': [
            {'parts': parts},
          ],
          'generationConfig': {
            'maxOutputTokens': ApiConfig.maxTokensAnalysis,
            'temperature': 0.4,
          },
        },
      );

      return _extractText(response.data);
    } on DioException catch (e) {
      _logger.e('Dio Hatası: ${e.message}');
      if (e.response?.statusCode == 401 || e.response?.statusCode == 403) {
        throw const UnauthorizedFailure();
      }
      throw NetworkFailure(e.message ?? 'Bağlantı hatası');
    }
  }

  /// Görsel analizini Cloud Function proxy üzerinden yapar (anahtar sunucuda).
  /// [images] her biri {data, mimeType} olan çok açılı liste.
  Future<String> _callVisionProxy(
    List<Map<String, String>> images,
    String promptText,
  ) async {
    final functions = FirebaseFunctions.instanceFor(
      region: ApiConfig.functionsRegion,
    );
    final callable = functions.httpsCallable('analyzeImage');
    final result = await callable.call<Map<String, dynamic>>({
      'prompt': promptText,
      'images': images,
      // Geriye dönük uyum: tek görsel alanları da doldur.
      'imageBase64': images.first['data'],
      'mimeType': images.first['mimeType'],
    });
    final text = result.data['text'] as String?;
    if (text == null || text.isEmpty) {
      throw const ServerFailure('Proxy boş yanıt');
    }
    return text;
  }

  // ============================================================
  // FORM TABANLI FALLBACK (API anahtarı yoksa)
  // ============================================================
  FaceAnalysisResult fallbackFace(IntakeProfile p) {
    // Form sinyallerinden kaba ama tutarlı tahmin
    final base = 55 +
        (p.nutritionHabit * 4) +
        (p.sleepHabit * 4) -
        (p.addictionIds.contains('sugar') ? 8 : 0) -
        (p.addictionIds.contains('smoking') ? 6 : 0);
    final skin = base.clamp(30, 90);
    final jaw = (base - 5 + (p.bodyGoal == 0 ? 5 : 0)).clamp(30, 90);
    final overall = ((skin + jaw) / 2).round();

    return FaceAnalysisResult(
      faceShape: 'Oval',
      jawlineScore: jaw,
      skinScore: skin,
      overallScore: overall,
      asymmetryDetected: false,
      gonialAngleDeg: 120,
      submentalFatScore: p.bmi > 25 ? 5 : 3,
      recommendations: const [
        'Düzenli mewing ile çene hattını netleştir.',
        'Cilt rutinini her gün uygula.',
        'Şeker ve işlenmiş gıdayı azalt — cilt netleşir.',
      ],
      mewingGuide:
          'Dilini tamamen damağa yasla, dudakları kapat, burundan nefes al. Gün boyu sürdür.',
      masseterExercises: const [
        '2×20 çene açma-kapama (dirençli)',
        'Günde 15 dk sert sakız çiğne',
      ],
      skinMorningRoutine: const [
        'Yüz yıkama',
        'Nemlendirici',
        'SPF 30+ güneş kremi',
      ],
      skinEveningRoutine: const [
        'Temizleyici ile yıka',
        'Nemlendirici',
        'Haftada 2 nazik peeling',
      ],
      hairStyles: const ['Yüz oranına uygun yanları kısa üstü dolgun kesim'],
      beardGuide: 'Sakal hattını net tut, boyun çizgisini temizle.',
      jawlineObservation:
          'Formuna göre tahmini: çene hattı ${jaw >= 65 ? "belirgin" : "orta netlikte"}, '
          'submental (çene altı) yağ ${p.bmi > 25 ? "hafif fazla" : "düşük"}. '
          'Fotoğraf çekersen gonial açı ve simetri gerçek olarak ölçülür.',
      jawlineExercises: const [
        'Mewing: dili tamamen damağa yasla, gün boyu sürdür',
        'Chin tuck: 3×15 (çeneyi geriye çek, boyun hizala)',
        'Masseter: 2×20 dirençli çene açma-kapama',
        'Sert sakız: günde 10-15 dk (aşırıya kaçma)',
        'Boyun germe: 2×30sn her yön',
      ],
      regions: [
        RegionAnalysis(
          name: 'Kaşlar',
          score: (base - 2).clamp(30, 90),
          observation:
              'Kaş formu ve simetrisi fotoğrafla netleşir. Bakımlı, doğal kalınlıkta kaş yüz harmonisini artırır.',
          exercises: const [
            'Kaş kası germe: kaşları yukarı kaldır-indir 2×15',
            'Düzenli şekillendirme/bakım (aşırı almaktan kaçın)',
          ],
        ),
        RegionAnalysis(
          name: 'Gözler',
          score: (skin - 3).clamp(30, 90),
          observation:
              'Göz altı ödemi ve canlılık uyku + su ile doğrudan ilişkili. Bakışın açıklığı harmoniyi belirler.',
          exercises: const [
            'Göz çevresi: uzağa/yakına odak 3×10',
            'Uyku 7-8 saat + tuzu azalt (ödem düşer)',
            'Sabah soğuk kompres (2-3 dk)',
          ],
        ),
        RegionAnalysis(
          name: 'Burun',
          score: (base).clamp(35, 88),
          observation:
              'Burun sırtı ve uç oranı yüz orta hattının merkezidir. Nefes alışkanlığı postürü de etkiler.',
          exercises: const [
            'Burundan nefes farkındalığı (ağızdan nefesi bırak)',
            'Diyafram nefesi 5 dk/gün',
          ],
        ),
        RegionAnalysis(
          name: 'Dudaklar',
          score: (skin).clamp(35, 90),
          observation:
              'Dudak nemi ve formu bakımla iyileşir. Simetri gülümseme kaslarıyla desteklenir.',
          exercises: const [
            'Günlük nemlendirme (SPF\'li balm)',
            'Gülümseme kası egzersizi 2×15',
          ],
        ),
        RegionAnalysis(
          name: 'Elmacık Kemikleri',
          score: (jaw - 2).clamp(35, 90),
          observation:
              'Belirgin elmacık kemiği yüze yapı katar; düşük yağ oranı ve yanak kaslarıyla öne çıkar.',
          exercises: const [
            'Buccal (yanak) egzersizi: yanakları şişir-çek 2×15',
            'Genel yağ oranını düşür (yüz netliği artar)',
          ],
        ),
        RegionAnalysis(
          name: 'Alın',
          score: (base + 2).clamp(35, 90),
          observation:
              'Mimik gerginliği alında çizgi yapar. Gevşemiş, pürüzsüz alın dingin bir ifade verir.',
          exercises: const [
            'Mimik gevşetme: kaş arası gerginliği bırak',
            'Gün içi alın kası farkındalığı',
          ],
        ),
        RegionAnalysis(
          name: 'Cilt Dokusu',
          score: skin,
          observation:
              'Cilt netliği beslenme, su ve rutine bağlı. Şeker/işlenmiş gıda azaldıkça doku iyileşir.',
          exercises: const [
            'Sabah-akşam temizleme + nemlendirme',
            'Haftada 2 nazik peeling',
            'Günlük SPF 30+',
          ],
        ),
        RegionAnalysis(
          name: 'Saç Çizgisi',
          score: (base).clamp(35, 88),
          observation:
              'Saç çizgisi ve yoğunluğu yüz çerçevesini belirler. Sağlıklı saç bakımı ve beslenme korur.',
          exercises: const [
            'Saç derisi masajı 5 dk/gün',
            'Protein + biotin açısından dengeli beslen',
          ],
        ),
      ],
      fromAi: false,
      analyzedAt: DateTime.now(),
    );
  }

  BodyAnalysisResult fallbackBody(IntakeProfile p) {
    final bmi = p.bmi;
    final category = bmi < 18.5
        ? 'Zayıf'
        : bmi < 25
            ? 'Normal'
            : bmi < 30
                ? 'Fazla Kilolu'
                : 'Obez';
    final bf = (bmi < 18.5
            ? 12.0
            : bmi < 25
                ? 18.0
                : bmi < 30
                    ? 26.0
                    : 33.0)
        .toDouble();
    final muscle = (40 + p.fitnessLevel * 15).clamp(20, 95);
    final posture = (75 - (p.screenTime <= 1 ? 15 : 0)).clamp(30, 95);
    final overall = ((muscle + posture + (category == 'Normal' ? 80 : 55)) / 3)
        .round();

    final maintenance = (p.weightKg * 31).round();
    final deficit = p.bodyGoal == 0
        ? 400
        : p.bodyGoal == 1
            ? -300
            : 0;

    return BodyAnalysisResult(
      overallScore: overall,
      postureScore: posture,
      muscleScore: muscle,
      estimatedBodyFatPercent: bf,
      weightCategory: category,
      bodyType: p.fitnessLevel >= 2 ? 'Mezomorf' : 'Ektomorf',
      kyphosisDetected: p.screenTime <= 1,
      forwardHeadAngleDeg: p.screenTime <= 1 ? 16 : 8,
      shoulderAsymmetry: 'Hafif',
      dailyCalorieTarget: maintenance - deficit,
      recommendedDeficit: deficit,
      cardioStepGoal: p.bodyGoal == 0 ? 10000 : 8000,
      proteinTargetG: (p.weightKg * 1.8).round(),
      priorityExercises: p.fitnessLevel == 0
          ? const ['Squat', 'Şınav', 'Plank', 'Glute bridge']
          : const ['Squat', 'Deadlift', 'Bench press', 'Barfiks', 'Face pull'],
      postureExercises: const [
        'Wall Angels 3×12',
        'Chin tuck 3×30sn',
        'Face pull 3×15',
      ],
      recommendations: [
        if (category == 'Fazla Kilolu' || category == 'Obez')
          'Hafif kalori açığı + kardiyo ile yağ yak.',
        if (category == 'Zayıf') 'Kalori fazlası + ağırlık ile kas yap.',
        'Haftada en az 3 kuvvet antrenmanı yap.',
        'Protein hedefini her gün tuttur.',
      ],
      symmetryScore: (75 + p.fitnessLevel * 4).clamp(50, 92),
      proportionScore: (60 + p.fitnessLevel * 8).clamp(40, 92),
      symmetryObservation:
          'Formuna göre tahmini denge iyi. Fotoğraf çekersen sağ/sol kas dengesi '
          've V-taper (omuz/bel oranı) gerçek olarak ölçülür.',
      regions: _fallbackBodyRegions(p),
      fromAi: false,
      analyzedAt: DateTime.now(),
    );
  }

  /// Formdan tahmini bölgesel vücut analizi (fotoğraf yokken).
  List<RegionAnalysis> _fallbackBodyRegions(IntakeProfile p) {
    final beginner = p.fitnessLevel == 0;
    final base = (40 + p.fitnessLevel * 15).clamp(25, 90);
    List<String> ex(String beg, String adv) =>
        beginner ? [beg] : [beg, adv];
    return [
      RegionAnalysis(
        name: 'Omuzlar',
        score: base,
        observation:
            'Geniş, dengeli omuz V-taper görünümünü belirler. Yan/arka deltoid çoğu kişide zayıf kalır.',
        exercises: ex('Omuz press 3×12', 'Lateral raise 3×15 + Face pull 3×15'),
      ),
      RegionAnalysis(
        name: 'Göğüs',
        score: base,
        observation:
            'Üst göğüs dengeli bir gövde için önemli. Eğimli hareketlerle doldurulur.',
        exercises: ex('Şınav 4×maks', 'Incline bench 4×10 + Dip 3×12'),
      ),
      RegionAnalysis(
        name: 'Kollar',
        score: base,
        observation:
            'Biceps ve triceps kol hacmini birlikte belirler; triceps kolun 2/3\'üdür.',
        exercises: ex('Diamond şınav 3×12', 'Curl 3×12 + Triceps pushdown 3×12'),
      ),
      RegionAnalysis(
        name: 'Sırt',
        score: base,
        observation:
            'Güçlü sırt postürü düzeltir ve genişlik katar. Çekiş hareketleri önceliklidir.',
        exercises: ex('Ters kürek (masa altı) 3×10', 'Barfiks 4×maks + Kürek 4×10'),
      ),
      RegionAnalysis(
        name: 'Karın (Core)',
        score: (base - 3).clamp(25, 90),
        observation:
            'Core stabilite tüm hareketlerin temeli. Görünürlük yağ oranına bağlı.',
        exercises: ex('Plank 3×40sn', 'Hanging leg raise 3×12 + Plank 3×60sn'),
      ),
      RegionAnalysis(
        name: 'Bacaklar',
        score: base,
        observation:
            'Bacaklar en büyük kas grubu; genel gelişim ve hormon için kritik ama sık ihmal edilir.',
        exercises: ex('Squat 4×15 + Lunge 3×12', 'Barbell squat 4×8 + RDL 3×10'),
      ),
      RegionAnalysis(
        name: 'Kalça/Glute',
        score: base,
        observation:
            'Güçlü glute postürü ve atletik görünümü destekler, bel ağrısını azaltır.',
        exercises: ex('Glute bridge 3×15', 'Hip thrust 4×12 + Bulgarian split 3×10'),
      ),
    ];
  }

  // ============================================================
  // CHAT (Sosyal Simülatör)
  // ============================================================
  Future<String> chat({
    required List<Map<String, dynamic>> messages,
    required String scenario,
    String socialLevel = 'advanced',
  }) async {
    final systemPrompt = _buildChatSystemPrompt(scenario, socialLevel);

    // Gemini'de ayrı bir "system" rolü yoktur; ilk kullanıcı turunun önüne
    // sistem talimatını ekleyip role'leri user/model'e çeviriyoruz.
    final contents = <Map<String, dynamic>>[];
    for (var i = 0; i < messages.length; i++) {
      final m = messages[i];
      final role = m['role'] == 'assistant' ? 'model' : 'user';
      var text = m['content'] as String;
      if (i == 0) {
        text = '$systemPrompt\n\nKullanıcı: $text';
      }
      contents.add({'role': role, 'parts': [{'text': text}]});
    }

    // 1) Önce Cloud Function proxy (anahtar sunucuda gizli)
    if (ApiConfig.useProxy) {
      try {
        return await _callChatProxy(contents);
      } catch (e) {
        _logger.w('Chat proxy başarısız, doğrudan API deneniyor: $e');
      }
    }

    // 2) Doğrudan Gemini — yalnızca kullanıcı kendi anahtarını girdiyse
    final apiKey = await _getUserApiKey();
    if (apiKey == null || apiKey.isEmpty) {
      throw const UnauthorizedFailure();
    }

    try {
      final response = await _dio.post(
        '/models/${ApiConfig.geminiModel}:generateContent',
        queryParameters: {'key': apiKey},
        data: {
          'contents': contents,
          'generationConfig': {
            'maxOutputTokens': ApiConfig.maxTokensChat,
            'temperature': 0.8,
          },
        },
      );
      return _extractText(response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 401 || e.response?.statusCode == 403) {
        throw const UnauthorizedFailure();
      }
      throw NetworkFailure(e.message ?? 'Bağlantı hatası');
    }
  }

  /// Sohbeti Cloud Function proxy üzerinden yapar (anahtar sunucuda).
  Future<String> _callChatProxy(List<Map<String, dynamic>> contents) async {
    final functions = FirebaseFunctions.instanceFor(
      region: ApiConfig.functionsRegion,
    );
    final callable = functions.httpsCallable('chat');
    final result = await callable.call<Map<String, dynamic>>({
      'contents': contents,
    });
    final text = result.data['text'] as String?;
    if (text == null || text.isEmpty) {
      throw const ServerFailure('Proxy boş yanıt');
    }
    return text;
  }

  // ============================================================
  // PROMPTLAR
  // ============================================================
  String _faceSystemPrompt() {
    return '''
Sen Voxen AI uygulamasının PROFESYONEL yüz estetiği & harmoni analiz motorusun.
Kullanıcının YÜZ fotoğraf(lar)ını klinik bir estetisyen/koç titizliğiyle analiz et.
Genel skorlar VE yüzün HER küçük bölgesi için ayrı ayrı DETAYLI değerlendirme yap.

DEĞERLENDİRECEĞİN GENEL ALANLAR:
- yüz şekli (Oval|Kare|Dikdörtgen|Yuvarlak|Elmas|Kalp|Üçgen)
- çene hattı skoru, cilt skoru, genel skor (hepsi 0-100)
- asimetri, gonial açı (derece), submental (çene altı) yağ (0-10)

ÇENE (JAWLINE) — DERİNLEMESİNE:
- "jawlineObservation": çene hattının netliği, gonial açı, submental yağ, çene ucu
  (chin) projeksiyonu ve simetrisi hakkında 2-3 cümlelik ayrıntılı gözlem.
- "jawlineExercises": çeneyi netleştirecek 4-6 SOMUT egzersiz (mewing, masseter,
  chin tuck, dil bası, sert sakız, boyun germe vb. — set/tekrar/süre ver).

BÖLGESEL ANALİZ ("regions" dizisi) — ŞU BÖLGELERİN HER BİRİ için bir nesne üret:
Kaşlar, Gözler, Burun, Dudaklar, Elmacık Kemikleri (yanak), Alın, Cilt Dokusu, Saç Çizgisi.
Her bölge için:
  - "name": bölge adı (Türkçe, yukarıdaki gibi)
  - "score": 0-100
  - "observation": o bölgeye özel 1-2 cümle net gözlem (simetri, oran, form)
  - "exercises": o bölgeye özel 2-4 SOMUT egzersiz/bakım önerisi
    (ör. kaş için kaş kası germe & bakım; göz için göz çevresi egzersizi, uyku/ödem;
     burun için nefes/burun kası farkındalığı; dudak için nemlendirme/form;
     elmacık için buccal/yanak egzersizi; alın için mimik gevşetme; cilt için bakım).

YALNIZCA şu JSON'u döndür, başka metin yok, markdown kod bloğu kullanma:
{
  "status": "success",
  "faceShape": "string",
  "jawlineScore": 0,
  "skinScore": 0,
  "overallScore": 0,
  "asymmetryDetected": false,
  "gonialAngleDeg": 0,
  "submentalFatScore": 0,
  "jawlineObservation": "",
  "jawlineExercises": ["", "", "", ""],
  "regions": [
    {"name": "Kaşlar", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Gözler", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Burun", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Dudaklar", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Elmacık Kemikleri", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Alın", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Cilt Dokusu", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Saç Çizgisi", "score": 0, "observation": "", "exercises": ["", ""]}
  ],
  "recommendations": ["", "", ""],
  "mewingGuide": "",
  "masseterExercises": ["", ""],
  "skinMorningRoutine": ["", "", ""],
  "skinEveningRoutine": ["", "", ""],
  "hairStyles": ["", ""],
  "beardGuide": ""
}
Yüz net değilse: {"status":"error","message":"Lütfen yüzünüzün net göründüğü bir fotoğraf yükleyin."}
''';
  }

  String _bodySystemPrompt(IntakeProfile? p) {
    final ctx = p == null
        ? ''
        : 'Kullanıcı bilgisi: boy ${p.heightCm.round()}cm, kilo ${p.weightKg.round()}kg, hedef index ${p.bodyGoal}, fitness seviye ${p.fitnessLevel}.';
    return '''
Sen Voxen AI uygulamasının PROFESYONEL vücut kompozisyonu & postür analiz motorusun.
Kullanıcının VÜCUT fotoğraf(lar)ını bir kişisel antrenör titizliğiyle analiz et. $ctx
Genel skorlar VE her kas bölgesi için ayrı ayrı DETAYLI değerlendirme yap.

GENEL DEĞERLENDİRME:
- genel skor, postür skoru, kas skoru (0-100)
- tahmini vücut yağ oranı (%), kilo kategorisi (Zayıf|Normal|Fazla Kilolu|Obez),
  vücut tipi (Ektomorf|Mezomorf|Endomorf)
- kamburluk (kifoz), baş öne eğim açısı (derece), omuz asimetrisi
- günlük kalori hedefi, önerilen açık (+/-), kardiyo adım hedefi, protein hedefi (g)
- "symmetryScore" (0-100 sağ/sol denge), "proportionScore" (0-100 V-taper/oran),
  "symmetryObservation": simetri ve oran hakkında 1-2 cümle gözlem.

BÖLGESEL ANALİZ ("regions" dizisi) — ŞU BÖLGELERİN HER BİRİ için bir nesne üret:
Omuzlar, Göğüs, Kollar (Biceps/Triceps), Sırt, Karın (Core), Bacaklar, Kalça/Glute.
Her bölge için:
  - "name": bölge adı (Türkçe, yukarıdaki gibi)
  - "score": 0-100 (gelişmişlik/form)
  - "observation": o bölgeye özel 1-2 cümle gözlem (kas kütlesi, denge, zayıf nokta)
  - "exercises": o bölgeye özel 2-4 SOMUT egzersiz (set×tekrar ver;
    kullanıcının fitness seviyesine uygun ekipmansız ya da ağırlıklı seçenek).

YALNIZCA şu JSON'u döndür, başka metin yok, markdown kod bloğu kullanma:
{
  "status": "success",
  "overallScore": 0,
  "postureScore": 0,
  "muscleScore": 0,
  "estimatedBodyFatPercent": 0,
  "weightCategory": "string",
  "bodyType": "string",
  "kyphosisDetected": false,
  "forwardHeadAngleDeg": 0,
  "shoulderAsymmetry": "string",
  "symmetryScore": 0,
  "proportionScore": 0,
  "symmetryObservation": "",
  "dailyCalorieTarget": 0,
  "recommendedDeficit": 0,
  "cardioStepGoal": 0,
  "proteinTargetG": 0,
  "regions": [
    {"name": "Omuzlar", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Göğüs", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Kollar", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Sırt", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Karın (Core)", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Bacaklar", "score": 0, "observation": "", "exercises": ["", ""]},
    {"name": "Kalça/Glute", "score": 0, "observation": "", "exercises": ["", ""]}
  ],
  "priorityExercises": ["", "", ""],
  "postureExercises": ["", "", ""],
  "recommendations": ["", "", ""]
}
Vücut net değilse: {"status":"error","message":"Lütfen vücudunuzun göründüğü bir fotoğraf yükleyin."}
''';
  }

  String _buildChatSystemPrompt(String scenario, String socialLevel) {
    // Daygame senaryosuna göre AI'nın canlandıracağı kız karakterin sahnesi
    final scene = switch (scenario) {
      'sokak' =>
        'Gündüz işlek bir caddede yürüyorsun. Kullanıcı (erkek) seni durdurup yaklaşıyor. Sen 23 yaşında, akıllı, hafif temkinli ama açık fikirli bir kadınsın. Aceleniz var ama gerçekten ilgi çekici biri olursa duraksarsın.',
      'kafe' =>
        'Bir kafede tek başına oturmuş kitap okuyor/telefonuna bakıyorsun. Kullanıcı (erkek) yan masadan sohbet başlatmaya çalışıyor. Sen 24 yaşında, sıcak ama kendine güvenli bir kadınsın; klişe repliklerden sıkılırsın, özgün yaklaşımı ödüllendirirsin.',
      'market' =>
        'Bir markette/alışveriş ortamındasın. Kullanıcı (erkek) doğal bir bahaneyle (ürün önerisi vb.) sohbet açıyor. Sen 22 yaşında, neşeli ama meşgul bir kadınsın; rahat ve mizahi yaklaşımları seversin.',
      'etkinlik' =>
        'Bir sosyal etkinlik/partidesin. Kullanıcı (erkek) seninle tanışmak istiyor. Sen 25 yaşında, sosyal ve seçici bir kadınsın; özgüveni ölçer, yapışkanlıktan kaçarsın.',
      _ =>
        'Gündüz bir ortamda kullanıcı (erkek) seninle tanışmaya çalışıyor. Gerçekçi bir genç kadın gibi davran.',
    };

    final levelInstruction = switch (socialLevel) {
      'indirect' =>
        'Bu DOLAYLI seviye: kullanıcı düşük riskli, flört içermeyen bir başlangıç yapıyor olabilir (yol/öneri sorma). Baskısız, kısa ve doğal karşılık ver.',
      'advanced' =>
        'Bu İLERİ (Daygame) seviyesi: kullanıcı doğrudan ilgisini belli eden bir açılış yapabilir. Mükemmel olmasını bekleme ama özgüven, mizah ve özgünlük gördüğünde ısın; klişe, yapışkan, onay arayan veya kaba tavırlarda mesafeli/soğuk ol.',
      _ => 'Genel sosyal pratik.',
    };

    return '''
Sen Voxen AI uygulamasının DAYGAME (gündüz tanışma) antrenörüsün. Amacın: kullanıcının (erkek) sosyal kaygıyı yenmesi ve kadınlarla rahat, özgüvenli, saygılı konuşmayı öğrenmesi.

SAHNE: $scene
$levelInstruction

NASIL DAVRANACAKSIN:
1. Önce GERÇEK BİR KADIN KARAKTER olarak rol yap — kullanıcının yaklaşımına gerçekçi, doğal tepki ver (kısa, sohbet havasında, abartısız). Hak ettiyse ilgi göster, hak etmediyse kibarca mesafeli ol. Asla küfür/aşağılama yok; gerçekçi ama yapıcı kal.
2. Sonra KOÇ olarak, kullanıcının son hamlesini değerlendir ve net bir tavsiye ver. Bunu SADECE "[GERİ BİLDİRİM]:" ile başlayan tek bir satırda yaz (ne iyiydi, neyi nasıl daha iyi yapabilirdi — somut alternatif cümle öner).
3. Kullanıcı tıkanırsa/utanırsa cesaretlendir, küçük bir sonraki adım öner.

Değerlendirme kriterleri: özgüven, özgünlük (klişe değil), mizah, kadının konforuna saygı, takılmadan akışı sürdürme.

Yanıtının en sonuna, kullanıcıya gösterilmeyen ayrı bir satırda "[EQ_SKOR]: <0-100>" ekle (bu yaklaşımın kalitesi).
Türkçe yanıt ver. Yanıtı kısa tut (karakter repliği 1-3 cümle + 1 geri bildirim satırı).
''';
  }

  // ============================================================
  // PARSE
  // ============================================================
  String _extractText(dynamic data) {
    try {
      final candidates = data['candidates'] as List;
      if (candidates.isEmpty) {
        throw ServerFailure('API yanıtı boş');
      }
      final parts = candidates[0]['content']['parts'] as List;
      final text = parts.firstWhere(
        (p) => p['text'] != null,
        orElse: () => throw ServerFailure('API yanıtı boş'),
      );
      final rawText = text['text'] as String;
      _logger.d('Gemini API yanıtı: $rawText');
      return rawText;
    } catch (e) {
      if (e is ServerFailure) rethrow;
      _logger.e('Yanıt ayrıştırma hatası: $e');
      throw ServerFailure('API yanıtı ayrıştırılamadı');
    }
  }

  FaceAnalysisResult _parseFace(String rawText, {required bool fromAi}) {
    final data = _extractJson(rawText);
    if (data['status'] == 'error') {
      throw ValidationFailure(data['message'] ?? 'Analiz başarısız');
    }
    return FaceAnalysisResult(
      faceShape: data['faceShape'] as String? ?? 'Oval',
      jawlineScore: (data['jawlineScore'] as num).toInt(),
      skinScore: (data['skinScore'] as num).toInt(),
      overallScore: (data['overallScore'] as num).toInt(),
      asymmetryDetected: data['asymmetryDetected'] as bool? ?? false,
      gonialAngleDeg: (data['gonialAngleDeg'] as num?)?.toDouble() ?? 120,
      submentalFatScore: (data['submentalFatScore'] as num?)?.toDouble() ?? 3,
      recommendations: List<String>.from(data['recommendations'] ?? []),
      mewingGuide: data['mewingGuide'] as String? ?? '',
      masseterExercises: List<String>.from(data['masseterExercises'] ?? []),
      skinMorningRoutine: List<String>.from(data['skinMorningRoutine'] ?? []),
      skinEveningRoutine: List<String>.from(data['skinEveningRoutine'] ?? []),
      hairStyles: List<String>.from(data['hairStyles'] ?? []),
      beardGuide: data['beardGuide'] as String? ?? '',
      jawlineObservation: data['jawlineObservation'] as String? ?? '',
      jawlineExercises: List<String>.from(data['jawlineExercises'] ?? []),
      regions: RegionAnalysis.listFromJson(data['regions']),
      fromAi: fromAi,
      analyzedAt: DateTime.now(),
    );
  }

  BodyAnalysisResult _parseBody(String rawText, {required bool fromAi}) {
    final data = _extractJson(rawText);
    if (data['status'] == 'error') {
      throw ValidationFailure(data['message'] ?? 'Analiz başarısız');
    }
    return BodyAnalysisResult(
      overallScore: (data['overallScore'] as num).toInt(),
      postureScore: (data['postureScore'] as num).toInt(),
      muscleScore: (data['muscleScore'] as num).toInt(),
      estimatedBodyFatPercent:
          (data['estimatedBodyFatPercent'] as num).toDouble(),
      weightCategory: data['weightCategory'] as String? ?? 'Normal',
      bodyType: data['bodyType'] as String? ?? 'Mezomorf',
      kyphosisDetected: data['kyphosisDetected'] as bool? ?? false,
      forwardHeadAngleDeg:
          (data['forwardHeadAngleDeg'] as num?)?.toDouble() ?? 8,
      shoulderAsymmetry: data['shoulderAsymmetry'] as String? ?? 'Hafif',
      dailyCalorieTarget: (data['dailyCalorieTarget'] as num).toInt(),
      recommendedDeficit: (data['recommendedDeficit'] as num).toInt(),
      cardioStepGoal: (data['cardioStepGoal'] as num).toInt(),
      proteinTargetG: (data['proteinTargetG'] as num).toInt(),
      priorityExercises: List<String>.from(data['priorityExercises'] ?? []),
      postureExercises: List<String>.from(data['postureExercises'] ?? []),
      recommendations: List<String>.from(data['recommendations'] ?? []),
      regions: RegionAnalysis.listFromJson(data['regions']),
      symmetryScore: (data['symmetryScore'] as num?)?.toInt() ?? 0,
      proportionScore: (data['proportionScore'] as num?)?.toInt() ?? 0,
      symmetryObservation: data['symmetryObservation'] as String? ?? '',
      fromAi: fromAi,
      analyzedAt: DateTime.now(),
    );
  }

  Map<String, dynamic> _extractJson(String rawText) {
    String jsonStr = rawText;
    final match = RegExp(r'\{[\s\S]*\}').firstMatch(rawText);
    if (match != null) jsonStr = match.group(0)!;
    return jsonDecode(jsonStr) as Map<String, dynamic>;
  }

  String _getMimeType(String path) {
    final ext = path.split('.').last.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/jpeg';
    }
  }
}

/// Bir dating fotoğrafının AI puanlama sonucu.
class PhotoScore {
  final File file;
  final int score; // 0-100
  final String strengths;
  final String weaknesses;

  const PhotoScore({
    required this.file,
    required this.score,
    required this.strengths,
    required this.weaknesses,
  });
}
