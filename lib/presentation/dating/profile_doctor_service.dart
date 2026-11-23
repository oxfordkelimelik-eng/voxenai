// PROFİL DOKTORU İSTEMCİ SERVİSİ (2026-11-22). Sunucu: functions/profileDoctor.js (profileDoctor).
// Görüntüler RizzGPT ile aynı yoldan kodlanır (rizz_service.dart encodeRizzImages: JPEG, uzun görüntü
// parçalama); hiçbir yere yüklenmez. Takip isteği ("yeni bio") AYNI kodlanmış görüntülerle gider.

import 'package:cloud_functions/cloud_functions.dart';

const _region = 'europe-west1';

const Map<String, String> kPdGoals = {
  'serious': 'Ciddi ilişki',
  'casual': 'Eğlence',
  'open': 'Açığım',
  'unsure': 'Emin değilim',
};

const Map<String, String> kPdMissing = {
  'full_body': 'Tam boy',
  'social': 'Arkadaşlarla',
  'hobby_activity': 'Hobi / aktivite',
  'smiling_closeup': 'Gülümseyen yakın çekim',
  'outdoor_travel': 'Dış mekân / gezi',
  'dressed_up': 'Şık giyimli',
  'with_pet': 'Evcil hayvanla',
};

/// Yaşam tarzı türleri: AI ile ÜRETİLMEZ (sahip olunmayan arkadaş/hayvan/hobi = yanıltma), "gerçek
/// fotoğraf ekle" denir. functions/profileDoctor.js LIFESTYLE_MISSING ile aynı.
const Set<String> kPdLifestyle = {'social', 'with_pet', 'hobby_activity'};

const Map<String, String> kPdVerdicts = {
  'lead': 'Başa al',
  'keep': 'Kalsın',
  'drop': 'Çıkar',
  'retake': 'Yeniden çek',
};

const Map<String, String> kPdStyles = {
  'playful': 'Esprili',
  'sincere': 'Samimi',
  'confident': 'Özgüvenli',
};

const Map<String, String> kPdAreas = {
  'photos': 'Fotoğraf',
  'bio': 'Bio',
  'prompts': 'Prompt',
  'basics': 'Temel bilgi',
};

class PdPhoto {
  final String description;
  final String verdict;
  final String why;
  const PdPhoto(this.description, this.verdict, this.why);
}

class PdFix {
  final String area;
  final String text;
  const PdFix(this.area, this.text);
}

class PdBio {
  final String style;
  final String text;
  final String why;
  const PdBio(this.style, this.text, this.why);
}

class PdPrompt {
  final String question;
  final String answer;
  const PdPrompt(this.question, this.answer);
}

class ProfileDoctorResult {
  final String? requestId;
  final bool charged;
  final String focus;
  final String status;
  final String firstImpression;
  final List<String> strengths;
  final List<PdPhoto> photos;
  final List<String> missingPhotos;
  final List<PdFix> fixes;
  final String? bioFeedback;
  final List<PdBio> bios;
  final List<PdPrompt> prompts;
  final String? tip;
  final int? freeLeft;
  final int? dailyFree;
  final int followupsLeft;

  const ProfileDoctorResult({
    required this.requestId,
    required this.charged,
    required this.focus,
    required this.status,
    required this.firstImpression,
    required this.strengths,
    required this.photos,
    required this.missingPhotos,
    required this.fixes,
    required this.bioFeedback,
    required this.bios,
    required this.prompts,
    required this.tip,
    required this.freeLeft,
    required this.dailyFree,
    required this.followupsLeft,
  });

  /// "Yeni bio" takibinde analiz korunur, yalnız metinler değişir.
  ProfileDoctorResult withTexts(ProfileDoctorResult next) => ProfileDoctorResult(
        requestId: requestId,
        charged: charged,
        focus: focus,
        status: status,
        firstImpression: firstImpression,
        strengths: strengths,
        photos: photos,
        missingPhotos: missingPhotos,
        fixes: fixes,
        bioFeedback: bioFeedback,
        bios: next.bios,
        prompts: next.prompts.isNotEmpty ? next.prompts : prompts,
        tip: next.tip ?? tip,
        freeLeft: freeLeft,
        dailyFree: dailyFree,
        followupsLeft: next.followupsLeft,
      );

  factory ProfileDoctorResult.fromJson(Map<String, dynamic> d) {
    final quota = d['quota'] is Map ? Map<String, dynamic>.from(d['quota'] as Map) : null;
    List<Map<String, dynamic>> list(dynamic v) =>
        v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : const [];
    List<String> strs(dynamic v) => v is List ? v.whereType<String>().toList() : const [];
    String s(Map<String, dynamic> m, String k) => (m[k] as String?) ?? '';
    return ProfileDoctorResult(
      requestId: d['requestId'] as String?,
      charged: d['charged'] == true,
      focus: (d['focus'] as String?) ?? 'full',
      status: (d['status'] as String?) ?? 'unreadable',
      firstImpression: (d['firstImpression'] as String?) ?? '',
      strengths: strs(d['strengths']),
      photos: [for (final p in list(d['photos'])) PdPhoto(s(p, 'description'), s(p, 'verdict'), s(p, 'why'))],
      missingPhotos: strs(d['missingPhotos']),
      fixes: [for (final f in list(d['fixes'])) PdFix(s(f, 'area'), s(f, 'text'))],
      bioFeedback: d['bioFeedback'] as String?,
      bios: [for (final b in list(d['bios'])) PdBio(s(b, 'style'), s(b, 'text'), s(b, 'why'))],
      prompts: [for (final p in list(d['prompts'])) PdPrompt(s(p, 'question'), s(p, 'answer'))],
      tip: d['tip'] as String?,
      freeLeft: (quota?['freeLeft'] as num?)?.toInt(),
      dailyFree: (quota?['dailyFree'] as num?)?.toInt(),
      followupsLeft: (d['followupsLeft'] as num?)?.toInt() ?? 0,
    );
  }
}

Future<ProfileDoctorResult> requestProfileDoctor({
  required List<Map<String, String>> images,
  required String goal,
  String note = '',
  List<String> avoid = const [],
  String? parentId,
  bool rewrite = false,
}) async {
  final callable = FirebaseFunctions.instanceFor(region: _region)
      .httpsCallable('profileDoctor', options: HttpsCallableOptions(timeout: const Duration(seconds: 120)));
  final result = await callable.call(<String, dynamic>{
    'images': images,
    'goal': goal,
    'note': note,
    'avoid': avoid,
    'parentId': parentId,
    'focus': rewrite ? 'rewrite' : 'full',
  });
  return ProfileDoctorResult.fromJson(Map<String, dynamic>.from(result.data as Map));
}
