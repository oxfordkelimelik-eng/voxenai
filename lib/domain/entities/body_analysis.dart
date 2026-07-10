import 'package:equatable/equatable.dart';
import 'region_analysis.dart';

/// Vücut fotoğrafının analiz sonucu (kompozisyon, postür, kas) + öneriler.
class BodyAnalysisResult extends Equatable {
  final int overallScore; // 0-100
  final int postureScore; // 0-100
  final int muscleScore; // 0-100
  final double estimatedBodyFatPercent;
  final String weightCategory; // Zayıf|Normal|Fazla Kilolu|Obez
  final String bodyType; // Ektomorf|Mezomorf|Endomorf (tahmini)
  final bool kyphosisDetected;
  final double forwardHeadAngleDeg;
  final String shoulderAsymmetry;
  final int dailyCalorieTarget;
  final int recommendedDeficit; // + açık / - fazla
  final int cardioStepGoal;
  final int proteinTargetG;
  final List<String> priorityExercises;
  final List<String> postureExercises;
  final List<String> recommendations;

  // --- DETAYLI BÖLGESEL VÜCUT ANALİZİ ---
  // Omuz, göğüs, kol, sırt, karın/core, bacak vb. her biri skor + gözlem + egzersiz.
  final List<RegionAnalysis> regions;
  final int symmetryScore; // 0-100 — sağ/sol denge
  final int proportionScore; // 0-100 — V-taper / oran
  final String symmetryObservation;

  final bool fromAi;
  final DateTime analyzedAt;

  const BodyAnalysisResult({
    required this.overallScore,
    required this.postureScore,
    required this.muscleScore,
    required this.estimatedBodyFatPercent,
    required this.weightCategory,
    required this.bodyType,
    required this.kyphosisDetected,
    required this.forwardHeadAngleDeg,
    required this.shoulderAsymmetry,
    required this.dailyCalorieTarget,
    required this.recommendedDeficit,
    required this.cardioStepGoal,
    required this.proteinTargetG,
    required this.priorityExercises,
    required this.postureExercises,
    required this.recommendations,
    this.regions = const [],
    this.symmetryScore = 0,
    this.proportionScore = 0,
    this.symmetryObservation = '',
    required this.fromAi,
    required this.analyzedAt,
  });

  Map<String, dynamic> toJson() => {
        'overallScore': overallScore,
        'postureScore': postureScore,
        'muscleScore': muscleScore,
        'estimatedBodyFatPercent': estimatedBodyFatPercent,
        'weightCategory': weightCategory,
        'bodyType': bodyType,
        'kyphosisDetected': kyphosisDetected,
        'forwardHeadAngleDeg': forwardHeadAngleDeg,
        'shoulderAsymmetry': shoulderAsymmetry,
        'dailyCalorieTarget': dailyCalorieTarget,
        'recommendedDeficit': recommendedDeficit,
        'cardioStepGoal': cardioStepGoal,
        'proteinTargetG': proteinTargetG,
        'priorityExercises': priorityExercises,
        'postureExercises': postureExercises,
        'recommendations': recommendations,
        'regions': regions.map((r) => r.toJson()).toList(),
        'symmetryScore': symmetryScore,
        'proportionScore': proportionScore,
        'symmetryObservation': symmetryObservation,
        'fromAi': fromAi,
        'analyzedAt': analyzedAt.toIso8601String(),
      };

  factory BodyAnalysisResult.fromJson(Map<String, dynamic> j) =>
      BodyAnalysisResult(
        overallScore: (j['overallScore'] as num).toInt(),
        postureScore: (j['postureScore'] as num).toInt(),
        muscleScore: (j['muscleScore'] as num).toInt(),
        estimatedBodyFatPercent:
            (j['estimatedBodyFatPercent'] as num).toDouble(),
        weightCategory: j['weightCategory'] as String,
        bodyType: j['bodyType'] as String,
        kyphosisDetected: j['kyphosisDetected'] as bool,
        forwardHeadAngleDeg: (j['forwardHeadAngleDeg'] as num).toDouble(),
        shoulderAsymmetry: j['shoulderAsymmetry'] as String,
        dailyCalorieTarget: (j['dailyCalorieTarget'] as num).toInt(),
        recommendedDeficit: (j['recommendedDeficit'] as num).toInt(),
        cardioStepGoal: (j['cardioStepGoal'] as num).toInt(),
        proteinTargetG: (j['proteinTargetG'] as num).toInt(),
        priorityExercises: List<String>.from(j['priorityExercises']),
        postureExercises: List<String>.from(j['postureExercises']),
        recommendations: List<String>.from(j['recommendations']),
        regions: RegionAnalysis.listFromJson(j['regions']),
        symmetryScore: (j['symmetryScore'] as num?)?.toInt() ?? 0,
        proportionScore: (j['proportionScore'] as num?)?.toInt() ?? 0,
        symmetryObservation: j['symmetryObservation'] as String? ?? '',
        fromAi: j['fromAi'] as bool? ?? false,
        analyzedAt: DateTime.parse(j['analyzedAt'] as String),
      );

  @override
  List<Object?> get props => [overallScore, analyzedAt];
}
