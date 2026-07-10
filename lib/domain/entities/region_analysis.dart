import 'package:equatable/equatable.dart';

/// Bir yüz/vücut alt bölgesinin (çene, kaş, göz, burun, dudak; omuz, kol vb.)
/// detaylı analizi: skor + gözlem + o bölgeye özel egzersiz/öneri listesi.
class RegionAnalysis extends Equatable {
  final String name; // Örn. "Çene Hattı", "Kaşlar", "Gözler"
  final int score; // 0-100
  final String observation; // Bölgeye dair kısa AI gözlemi
  final List<String> exercises; // Bölgeye özel egzersiz/öneriler

  const RegionAnalysis({
    required this.name,
    required this.score,
    required this.observation,
    required this.exercises,
  });

  Map<String, dynamic> toJson() => {
        'name': name,
        'score': score,
        'observation': observation,
        'exercises': exercises,
      };

  factory RegionAnalysis.fromJson(Map<String, dynamic> j) => RegionAnalysis(
        name: j['name'] as String? ?? '',
        score: (j['score'] as num?)?.toInt() ?? 0,
        observation: j['observation'] as String? ?? '',
        exercises: List<String>.from(j['exercises'] ?? const []),
      );

  /// AI listesinden güvenli ayrıştırma (null/eksik alanlara dayanıklı).
  static List<RegionAnalysis> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((e) => RegionAnalysis.fromJson(Map<String, dynamic>.from(e)))
        .where((r) => r.name.isNotEmpty)
        .toList();
  }

  @override
  List<Object?> get props => [name, score, observation, exercises];
}
