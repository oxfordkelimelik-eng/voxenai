import 'package:equatable/equatable.dart';

/// Tek bir analiz anının kalıcı kaydı — ilerleme (önce/sonra) takibi için.
/// type: 'face' | 'body'. photoPath cihaza özel kalıcı kopyanın yolu (boş olabilir).
class ProgressEntry extends Equatable {
  final DateTime date;
  final String type; // 'face' | 'body'
  final int score; // genel skor 0-100
  final String? photoPath;

  const ProgressEntry({
    required this.date,
    required this.type,
    required this.score,
    this.photoPath,
  });

  bool get isFace => type == 'face';
  bool get isBody => type == 'body';

  Map<String, dynamic> toJson() => {
        'date': date.toIso8601String(),
        'type': type,
        'score': score,
        'photoPath': photoPath,
      };

  factory ProgressEntry.fromJson(Map<String, dynamic> j) => ProgressEntry(
        date: DateTime.parse(j['date'] as String),
        type: j['type'] as String,
        score: (j['score'] as num).toInt(),
        photoPath: j['photoPath'] as String?,
      );

  @override
  List<Object?> get props => [date, type, score, photoPath];
}
