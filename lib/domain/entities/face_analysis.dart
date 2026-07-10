import 'package:equatable/equatable.dart';
import 'region_analysis.dart';

/// Yüz fotoğrafının analiz sonucu (jawline, cilt, saç-sakal) + öneriler.
/// Gemini API yoksa formdan akıllı fallback ile de üretilebilir.
class FaceAnalysisResult extends Equatable {
  final String faceShape;
  final int jawlineScore; // 0-100
  final int skinScore; // 0-100
  final int overallScore; // 0-100
  final bool asymmetryDetected;
  final double gonialAngleDeg;
  final double submentalFatScore; // 0-10
  final List<String> recommendations;
  final String mewingGuide;
  final List<String> masseterExercises;
  final List<String> skinMorningRoutine;
  final List<String> skinEveningRoutine;
  final List<String> hairStyles;
  final String beardGuide;

  // --- DETAYLI ÇENE (JAWLINE) ANALİZİ ---
  final String jawlineObservation; // Çene hattına dair ayrıntılı gözlem
  final List<String> jawlineExercises; // Çeneye özel egzersizler

  // --- BÖLGESEL YÜZ ANALİZİ (kaş, göz, burun, dudak, elmacık kemiği vb.) ---
  final List<RegionAnalysis> regions;

  final bool fromAi; // true: gerçek AI, false: formdan tahmini
  final DateTime analyzedAt;

  const FaceAnalysisResult({
    required this.faceShape,
    required this.jawlineScore,
    required this.skinScore,
    required this.overallScore,
    required this.asymmetryDetected,
    required this.gonialAngleDeg,
    required this.submentalFatScore,
    required this.recommendations,
    required this.mewingGuide,
    required this.masseterExercises,
    required this.skinMorningRoutine,
    required this.skinEveningRoutine,
    required this.hairStyles,
    required this.beardGuide,
    this.jawlineObservation = '',
    this.jawlineExercises = const [],
    this.regions = const [],
    required this.fromAi,
    required this.analyzedAt,
  });

  Map<String, dynamic> toJson() => {
        'faceShape': faceShape,
        'jawlineScore': jawlineScore,
        'skinScore': skinScore,
        'overallScore': overallScore,
        'asymmetryDetected': asymmetryDetected,
        'gonialAngleDeg': gonialAngleDeg,
        'submentalFatScore': submentalFatScore,
        'recommendations': recommendations,
        'mewingGuide': mewingGuide,
        'masseterExercises': masseterExercises,
        'skinMorningRoutine': skinMorningRoutine,
        'skinEveningRoutine': skinEveningRoutine,
        'hairStyles': hairStyles,
        'beardGuide': beardGuide,
        'jawlineObservation': jawlineObservation,
        'jawlineExercises': jawlineExercises,
        'regions': regions.map((r) => r.toJson()).toList(),
        'fromAi': fromAi,
        'analyzedAt': analyzedAt.toIso8601String(),
      };

  factory FaceAnalysisResult.fromJson(Map<String, dynamic> j) =>
      FaceAnalysisResult(
        faceShape: j['faceShape'] as String,
        jawlineScore: (j['jawlineScore'] as num).toInt(),
        skinScore: (j['skinScore'] as num).toInt(),
        overallScore: (j['overallScore'] as num).toInt(),
        asymmetryDetected: j['asymmetryDetected'] as bool,
        gonialAngleDeg: (j['gonialAngleDeg'] as num).toDouble(),
        submentalFatScore: (j['submentalFatScore'] as num).toDouble(),
        recommendations: List<String>.from(j['recommendations']),
        mewingGuide: j['mewingGuide'] as String,
        masseterExercises: List<String>.from(j['masseterExercises']),
        skinMorningRoutine: List<String>.from(j['skinMorningRoutine']),
        skinEveningRoutine: List<String>.from(j['skinEveningRoutine']),
        hairStyles: List<String>.from(j['hairStyles']),
        beardGuide: j['beardGuide'] as String,
        jawlineObservation: j['jawlineObservation'] as String? ?? '',
        jawlineExercises: List<String>.from(j['jawlineExercises'] ?? const []),
        regions: RegionAnalysis.listFromJson(j['regions']),
        fromAi: j['fromAi'] as bool? ?? false,
        analyzedAt: DateTime.parse(j['analyzedAt'] as String),
      );

  @override
  List<Object?> get props => [overallScore, analyzedAt];
}
