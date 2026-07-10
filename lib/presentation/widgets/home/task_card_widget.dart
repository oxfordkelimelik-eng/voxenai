import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../../core/constants/app_colors.dart';
import '../../../domain/entities/daily_task.dart';

class TaskCardWidget extends StatelessWidget {
  final DailyTask task;
  final void Function(String? note) onComplete;

  const TaskCardWidget({
    super.key,
    required this.task,
    required this.onComplete,
  });

  Future<void> _showCompletionDialog(BuildContext context) async {
    final controller = TextEditingController();
    final note = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text(
          'Görevi Tamamla',
          style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w800),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Bugün nasıl geçti? (opsiyonel)',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: controller,
              maxLines: 3,
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'Örn: 3 set yaptım, biraz zorlandım...',
                hintStyle: const TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.surface,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, ''),
            child: const Text('Notsuz Tamamla', style: TextStyle(color: AppColors.textMuted)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text.trim()),
            child: const Text('Tamamla'),
          ),
        ],
      ),
    );

    if (note != null) {
      onComplete(note.isEmpty ? null : note);
    }
  }

  @override
  Widget build(BuildContext context) {
    final typeColor = _typeColor(task.type);
    final typeIcon = _typeIcon(task.type);
    final typeLabel = _typeLabel(task.type);
    final isCompleted = task.isCompleted;

    return AnimatedOpacity(
      opacity: isCompleted ? 0.6 : 1.0,
      duration: const Duration(milliseconds: 300),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: isCompleted
              ? AppColors.surfaceElevated.withValues(alpha: 0.5)
              : AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isCompleted
                ? AppColors.borderSubtle
                : typeColor.withValues(alpha: 0.3),
            width: 1,
          ),
        ),
        child: Row(
          children: [
            // Kategori renk çubuğu
            Container(
              width: 4,
              height: 50,
              decoration: BoxDecoration(
                color: isCompleted ? AppColors.borderSubtle : typeColor,
                borderRadius: BorderRadius.circular(2),
                boxShadow: isCompleted
                    ? []
                    : [
                        BoxShadow(
                          color: typeColor.withValues(alpha: 0.4),
                          blurRadius: 6,
                        ),
                      ],
              ),
            ),

            const SizedBox(width: 14),

            // İkon
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: typeColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                typeIcon,
                color: isCompleted ? AppColors.textMuted : typeColor,
                size: 22,
              ),
            ),

            const SizedBox(width: 14),

            // Metin
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: typeColor.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          typeLabel,
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: typeColor,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      if (task.isProOnly)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.goldSurface,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            'PRO',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w700,
                              color: AppColors.gold,
                              letterSpacing: 0.5,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    task.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: isCompleted
                          ? AppColors.textMuted
                          : AppColors.textPrimary,
                      decoration: isCompleted
                          ? TextDecoration.lineThrough
                          : null,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    task.description,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textSecondary,
                      height: 1.4,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Icon(Icons.timer_outlined, size: 12, color: AppColors.textMuted),
                      const SizedBox(width: 3),
                      Text(
                        '${task.durationMinutes} dk',
                        style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                      ),
                      const SizedBox(width: 10),
                      Icon(Icons.signal_cellular_alt_rounded, size: 12, color: AppColors.textMuted),
                      const SizedBox(width: 3),
                      Text(
                        _difficultyLabel(task.difficulty),
                        style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                      ),
                    ],
                  ),
                  if (isCompleted && task.completionNote != null && task.completionNote!.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      decoration: BoxDecoration(
                        color: AppColors.surface,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        '"${task.completionNote}"',
                        style: const TextStyle(
                          fontSize: 11,
                          color: AppColors.textSecondary,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(width: 12),

            // Tamamla butonu
            GestureDetector(
              onTap: isCompleted ? null : () => _showCompletionDialog(context),
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isCompleted
                      ? AppColors.success.withValues(alpha: 0.15)
                      : typeColor.withValues(alpha: 0.1),
                  border: Border.all(
                    color: isCompleted ? AppColors.success : typeColor,
                    width: 1.5,
                  ),
                ),
                child: Icon(
                  isCompleted
                      ? Icons.check_rounded
                      : Icons.radio_button_unchecked,
                  color: isCompleted ? AppColors.success : typeColor,
                  size: 20,
                ),
              ),
            ),
          ],
        ),
      ),
    ).animate().fadeIn(duration: 300.ms).slideX(begin: 0.05, end: 0);
  }

  String _difficultyLabel(TaskDifficulty difficulty) {
    switch (difficulty) {
      case TaskDifficulty.easy:
        return 'Kolay';
      case TaskDifficulty.medium:
        return 'Orta';
      case TaskDifficulty.hard:
        return 'Zor';
    }
  }

  Color _typeColor(TaskType type) {
    switch (type) {
      case TaskType.physical:
        return AppColors.physical;
      case TaskType.mental:
        return AppColors.mental;
      case TaskType.social:
        return AppColors.social;
    }
  }

  IconData _typeIcon(TaskType type) {
    switch (type) {
      case TaskType.physical:
        return Icons.fitness_center_rounded;
      case TaskType.mental:
        return Icons.psychology_rounded;
      case TaskType.social:
        return Icons.people_rounded;
    }
  }

  String _typeLabel(TaskType type) {
    switch (type) {
      case TaskType.physical:
        return 'FİZİKSEL';
      case TaskType.mental:
        return 'ZİHİNSEL';
      case TaskType.social:
        return 'SOSYAL';
    }
  }
}

