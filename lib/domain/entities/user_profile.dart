import 'package:equatable/equatable.dart';

/// Kullanıcı profili entity
class UserProfile extends Equatable {
  final String id;
  final String name;
  final int age;
  final double heightCm;
  final double weightKg;
  final int totalXp;
  final int currentStreak;
  final int longestStreak;
  final bool isPro;
  final DateTime? proExpiryDate;
  final DateTime createdAt;
  final DateTime lastActiveAt;

  /// Ayrı analiz skorları (0-100, -1 = henüz analiz edilmedi)
  final int faceScore;
  final int bodyScore;

  const UserProfile({
    required this.id,
    required this.name,
    required this.age,
    required this.heightCm,
    required this.weightKg,
    required this.totalXp,
    required this.currentStreak,
    required this.longestStreak,
    required this.isPro,
    this.proExpiryDate,
    required this.createdAt,
    required this.lastActiveAt,
    this.faceScore = -1,
    this.bodyScore = -1,
  });

  int get level {
    const thresholds = [
      0,
      500,
      1200,
      2500,
      4500,
      7000,
      10000,
      15000,
      22000,
      30000,
    ];
    for (int i = thresholds.length - 1; i >= 0; i--) {
      if (totalXp >= thresholds[i]) return i + 1;
    }
    return 1;
  }

  double get levelProgress {
    const thresholds = [
      0,
      500,
      1200,
      2500,
      4500,
      7000,
      10000,
      15000,
      22000,
      30000,
    ];
    final lv = level;
    if (lv >= thresholds.length) return 1.0;
    return (totalXp - thresholds[lv - 1]) /
        (thresholds[lv] - thresholds[lv - 1]);
  }

  double get bmi => weightKg / ((heightCm / 100) * (heightCm / 100));

  UserProfile copyWith({
    String? name,
    int? age,
    double? heightCm,
    double? weightKg,
    int? totalXp,
    int? currentStreak,
    int? longestStreak,
    bool? isPro,
    DateTime? lastActiveAt,
    int? faceScore,
    int? bodyScore,
  }) {
    return UserProfile(
      id: id,
      name: name ?? this.name,
      age: age ?? this.age,
      heightCm: heightCm ?? this.heightCm,
      weightKg: weightKg ?? this.weightKg,
      totalXp: totalXp ?? this.totalXp,
      currentStreak: currentStreak ?? this.currentStreak,
      longestStreak: longestStreak ?? this.longestStreak,
      isPro: isPro ?? this.isPro,
      proExpiryDate: proExpiryDate,
      createdAt: createdAt,
      lastActiveAt: lastActiveAt ?? this.lastActiveAt,
      faceScore: faceScore ?? this.faceScore,
      bodyScore: bodyScore ?? this.bodyScore,
    );
  }

  @override
  List<Object?> get props => [
    id,
    totalXp,
    currentStreak,
    isPro,
    faceScore,
    bodyScore,
  ];
}
