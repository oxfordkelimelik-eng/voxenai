import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../domain/entities/daily_task.dart';
import '../../core/constants/app_constants.dart';
import '../../core/services/task_generator.dart';
import 'app_providers.dart';
import 'addiction_provider.dart';

/// Görev durumu provider'ı
final tasksProvider = AsyncNotifierProvider<TasksNotifier, List<DailyTask>>(
  TasksNotifier.new,
);

/// Belirli bir tab (TaskType) için filtrelenmiş görevler
final tasksByTypeProvider =
    Provider.family<List<DailyTask>, TaskType>((ref, type) {
  final tasks = ref.watch(tasksProvider).value ?? [];
  return tasks.where((t) => t.type == type).toList();
});

/// Tamamlanan görevlerin kalıcı geçmişi
final taskHistoryProvider =
    StateNotifierProvider<TaskHistoryNotifier, List<DailyTask>>(
      (ref) => TaskHistoryNotifier(),
    );

class TaskHistoryNotifier extends StateNotifier<List<DailyTask>> {
  TaskHistoryNotifier() : super([]) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.taskHistory);
    if (raw == null) return;
    final list = (jsonDecode(raw) as List)
        .map((e) => DailyTask.fromJson(e as Map<String, dynamic>))
        .toList();
    state = list;
  }

  Future<void> addCompletedTask(DailyTask task) async {
    final updated = [task, ...state];
    state = updated;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      StorageKeys.taskHistory,
      jsonEncode(updated.map((t) => t.toJson()).toList()),
    );
  }

  Future<void> clear() async {
    state = [];
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.taskHistory);
  }
}

class TasksNotifier extends AsyncNotifier<List<DailyTask>> {
  @override
  Future<List<DailyTask>> build() async {
    final prefs = await SharedPreferences.getInstance();

    // Bugünün görevleri zaten kaydedilmişse onları yükle (gün içi kalıcılık)
    final savedDate = prefs.getString('tasks_date');
    final today = _todayKey();
    final savedRaw = prefs.getString(StorageKeys.dailyTasks);
    if (savedDate == today && savedRaw != null) {
      try {
        return (jsonDecode(savedRaw) as List)
            .map((e) => DailyTask.fromJson(e as Map<String, dynamic>))
            .toList();
      } catch (_) {}
    }

    // Aksi halde intake + analizlerden üret
    final tasks = _buildFromData();
    await _persist(tasks);
    return tasks;
  }

  List<DailyTask> _buildFromData() {
    final intake = ref.read(intakeProvider);
    final face = ref.read(faceAnalysisProvider);
    final body = ref.read(bodyAnalysisProvider);
    final addictions = ref.read(addictionProvider);

    if (intake == null) return TaskGenerator.defaultTasks();
    return TaskGenerator.generate(
      intake,
      face: face,
      body: body,
      addictions: addictions,
    );
  }

  String _todayKey() {
    final d = DateTime.now();
    return '${d.year}-${d.month}-${d.day}';
  }

  Future<void> _persist(List<DailyTask> tasks) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('tasks_date', _todayKey());
    await prefs.setString(
      StorageKeys.dailyTasks,
      jsonEncode(tasks.map((t) => t.toJson()).toList()),
    );
    // Yerel değişikliği buluta aynala (offline ise sessizce atlanır)
    await pushSync(ref);
  }

  /// Tüm verilerden görevleri yeniden üret (form/analiz tamamlanınca çağrılır)
  Future<void> regenerate() async {
    final tasks = _buildFromData();
    state = AsyncData(tasks);
    await _persist(tasks);
  }

  /// Bir görevin tek bir adımını işaretle/kaldır
  Future<void> toggleStep(String taskId, int stepIndex) async {
    final current = state.value ?? [];
    final updated = current.map((t) {
      if (t.id != taskId) return t;
      final steps = [...t.steps];
      if (stepIndex < 0 || stepIndex >= steps.length) return t;
      steps[stepIndex] = steps[stepIndex].copyWith(done: !steps[stepIndex].done);
      return t.copyWith(steps: steps);
    }).toList();
    state = AsyncData(updated);
    await _persist(updated);

    // Tüm adımlar bitti ve görev henüz tamamlanmadıysa otomatik tamamla
    final task = updated.firstWhere((t) => t.id == taskId);
    if (task.hasSteps && task.doneStepCount == task.steps.length && !task.isCompleted) {
      await completeTask(taskId);
    }
  }

  Future<void> completeTask(String taskId, {String? note}) async {
    final current = state.value ?? [];
    DailyTask? completedTask;
    final updated = current.map((t) {
      if (t.id == taskId && !t.isCompleted) {
        final done = t.copyWith(
          status: TaskStatus.completed,
          completedAt: DateTime.now(),
          completionNote: note,
          steps: t.steps.map((s) => s.copyWith(done: true)).toList(),
        );
        completedTask = done;
        return done;
      }
      return t;
    }).toList();

    if (completedTask == null) return;

    state = AsyncData(updated);
    await _persist(updated);

    await ref.read(userProfileProvider.notifier).addXp(completedTask!.xpReward);
    await ref.read(taskHistoryProvider.notifier).addCompletedTask(completedTask!);

    final allDone = updated.every((t) => t.isCompleted || t.isProOnly);
    if (allDone) {
      await ref.read(userProfileProvider.notifier).updateStreak();
    }
  }
}
