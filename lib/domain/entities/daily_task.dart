import 'package:equatable/equatable.dart';

/// Görevin ait olduğu ana yaşam alanı (Görevler ekranındaki tab'lar bununla eşleşir)
enum TaskType { physical, mental, social }

/// Daha ince alan etiketi — UI'da rozet/ikon ve filtre için kullanılır
enum TaskCategory {
  face, // yüz / jawline / cilt / saç-sakal
  body, // vücut / kas / yağ / postür
  nutrition, // beslenme & su
  discipline, // disiplin / rutin / uyku
  mindset, // zihniyet / öz değer / redpill çerçeve
  socialSkill, // sosyalleşme / iletişim / flört
  addiction, // bağımlılıktan kurtulma
}

enum TaskStatus { pending, completed, skipped }

enum TaskDifficulty { easy, medium, hard }

/// Görev içindeki tek bir takip adımı (sadece tik değil — detaylı checklist)
class TaskStep extends Equatable {
  final String label;
  final bool done;

  const TaskStep({required this.label, this.done = false});

  TaskStep copyWith({bool? done}) =>
      TaskStep(label: label, done: done ?? this.done);

  Map<String, dynamic> toJson() => {'label': label, 'done': done};

  factory TaskStep.fromJson(Map<String, dynamic> j) =>
      TaskStep(label: j['label'] as String, done: j['done'] as bool? ?? false);

  @override
  List<Object?> get props => [label, done];
}

/// Günlük görev entity
class DailyTask extends Equatable {
  final String id;
  final TaskType type;
  final TaskCategory category;
  final String title;
  final String description;
  final int xpReward;
  final TaskStatus status;
  final bool isProOnly;
  final DateTime? completedAt;
  final String? completionNote;
  final int durationMinutes;
  final TaskDifficulty difficulty;

  /// Görevin "neden"i — kullanıcıyı içine çeken kısa motivasyon/açıklama
  final String? rationale;

  /// Detaylı takip adımları (boşsa tek tik ile tamamlanır)
  final List<TaskStep> steps;

  const DailyTask({
    required this.id,
    required this.type,
    this.category = TaskCategory.discipline,
    required this.title,
    required this.description,
    required this.xpReward,
    required this.status,
    required this.isProOnly,
    this.completedAt,
    this.completionNote,
    this.durationMinutes = 10,
    this.difficulty = TaskDifficulty.medium,
    this.rationale,
    this.steps = const [],
  });

  DailyTask copyWith({
    TaskStatus? status,
    DateTime? completedAt,
    String? completionNote,
    List<TaskStep>? steps,
  }) {
    return DailyTask(
      id: id,
      type: type,
      category: category,
      title: title,
      description: description,
      xpReward: xpReward,
      status: status ?? this.status,
      isProOnly: isProOnly,
      completedAt: completedAt ?? this.completedAt,
      completionNote: completionNote ?? this.completionNote,
      durationMinutes: durationMinutes,
      difficulty: difficulty,
      rationale: rationale,
      steps: steps ?? this.steps,
    );
  }

  bool get isCompleted => status == TaskStatus.completed;
  bool get isPending => status == TaskStatus.pending;
  bool get hasSteps => steps.isNotEmpty;
  int get doneStepCount => steps.where((s) => s.done).length;
  double get stepProgress =>
      steps.isEmpty ? (isCompleted ? 1 : 0) : doneStepCount / steps.length;

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.name,
    'category': category.name,
    'title': title,
    'description': description,
    'xpReward': xpReward,
    'status': status.name,
    'isProOnly': isProOnly,
    'completedAt': completedAt?.toIso8601String(),
    'completionNote': completionNote,
    'durationMinutes': durationMinutes,
    'difficulty': difficulty.name,
    'rationale': rationale,
    'steps': steps.map((s) => s.toJson()).toList(),
  };

  factory DailyTask.fromJson(Map<String, dynamic> json) {
    return DailyTask(
      id: json['id'] as String,
      type: TaskType.values.byName(json['type'] as String),
      category: json['category'] != null
          ? TaskCategory.values.byName(json['category'] as String)
          : TaskCategory.discipline,
      title: json['title'] as String,
      description: json['description'] as String,
      xpReward: json['xpReward'] as int,
      status: TaskStatus.values.byName(json['status'] as String),
      isProOnly: json['isProOnly'] as bool,
      completedAt: json['completedAt'] != null
          ? DateTime.parse(json['completedAt'] as String)
          : null,
      completionNote: json['completionNote'] as String?,
      durationMinutes: json['durationMinutes'] as int? ?? 10,
      difficulty: TaskDifficulty.values.byName(
        json['difficulty'] as String? ?? 'medium',
      ),
      rationale: json['rationale'] as String?,
      steps: (json['steps'] as List?)
              ?.map((e) => TaskStep.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );
  }

  @override
  List<Object?> get props => [id, status, steps];
}

/// Haftalık ilerleme verisi
class WeeklyProgress extends Equatable {
  final DateTime weekStart;
  final List<DayProgress> days;

  const WeeklyProgress({required this.weekStart, required this.days});

  int get totalCompleted => days.fold(0, (sum, d) => sum + d.completedCount);
  int get totalTasks => days.fold(0, (sum, d) => sum + d.totalCount);
  double get completionRate =>
      totalTasks == 0 ? 0 : totalCompleted / totalTasks;

  @override
  List<Object?> get props => [weekStart];
}

class DayProgress extends Equatable {
  final DateTime date;
  final int completedCount;
  final int totalCount;
  final int xpEarned;

  const DayProgress({
    required this.date,
    required this.completedCount,
    required this.totalCount,
    required this.xpEarned,
  });

  bool get isComplete => completedCount == totalCount && totalCount > 0;

  @override
  List<Object?> get props => [date];
}
