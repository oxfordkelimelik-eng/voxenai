import 'package:flutter/material.dart';
import '../../../core/constants/app_colors.dart';
import '../../../domain/entities/daily_task.dart';

/// Genişleyebilir, detaylı adım takibi yapan görev kartı.
/// - Başlık + kategori rozeti + XP
/// - "Neden" (rationale) açıklaması
/// - Adım checklist'i (her adım tek tek işaretlenir)
/// - Adım yoksa tek tik ile tamamlanır
class DetailedTaskCard extends StatefulWidget {
  final DailyTask task;
  final Color accent;
  final void Function(int stepIndex) onToggleStep;
  final void Function(String? note) onComplete;

  const DetailedTaskCard({
    super.key,
    required this.task,
    required this.accent,
    required this.onToggleStep,
    required this.onComplete,
  });

  @override
  State<DetailedTaskCard> createState() => _DetailedTaskCardState();
}

class _DetailedTaskCardState extends State<DetailedTaskCard> {
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    // Adımı olan görevler varsayılan açık değil; kullanıcı dokununca açılır
    _expanded = false;
  }

  DailyTask get task => widget.task;

  String get _categoryLabel => switch (task.category) {
        TaskCategory.face => 'YÜZ',
        TaskCategory.body => 'VÜCUT',
        TaskCategory.nutrition => 'BESLENME',
        TaskCategory.discipline => 'DİSİPLİN',
        TaskCategory.mindset => 'ZİHNİYET',
        TaskCategory.socialSkill => 'SOSYAL',
        TaskCategory.addiction => 'BAĞIMLILIK',
      };

  @override
  Widget build(BuildContext context) {
    final c = widget.accent;
    final completed = task.isCompleted;

    return AnimatedOpacity(
      opacity: completed ? 0.7 : 1,
      duration: const Duration(milliseconds: 250),
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: completed
                ? AppColors.borderSubtle
                : c.withValues(alpha: 0.3),
          ),
        ),
        child: Column(
          children: [
            // Üst satır
            InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Tamamla dairesi
                    GestureDetector(
                      onTap: completed
                          ? null
                          : () => _confirmComplete(context),
                      child: Container(
                        width: 38,
                        height: 38,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: completed
                              ? AppColors.success.withValues(alpha: 0.15)
                              : c.withValues(alpha: 0.1),
                          border: Border.all(
                            color: completed ? AppColors.success : c,
                            width: 1.5,
                          ),
                        ),
                        child: Icon(
                          completed
                              ? Icons.check_rounded
                              : Icons.radio_button_unchecked,
                          color: completed ? AppColors.success : c,
                          size: 20,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              _badge(_categoryLabel, c),
                              const SizedBox(width: 6),
                              if (task.isProOnly) _badge('PRO', AppColors.gold),
                              const Spacer(),
                              Text('+${task.xpReward} XP',
                                  style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w800,
                                      color: c)),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            task.title,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w800,
                              color: completed
                                  ? AppColors.textMuted
                                  : AppColors.textPrimary,
                              decoration: completed
                                  ? TextDecoration.lineThrough
                                  : null,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            task.description,
                            style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.textSecondary,
                                height: 1.4),
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              const Icon(Icons.timer_outlined,
                                  size: 12, color: AppColors.textMuted),
                              const SizedBox(width: 3),
                              Text('${task.durationMinutes} dk',
                                  style: const TextStyle(
                                      fontSize: 11, color: AppColors.textMuted)),
                              const SizedBox(width: 10),
                              const Icon(Icons.signal_cellular_alt_rounded,
                                  size: 12, color: AppColors.textMuted),
                              const SizedBox(width: 3),
                              Text(_difficulty(task.difficulty),
                                  style: const TextStyle(
                                      fontSize: 11, color: AppColors.textMuted)),
                              if (task.hasSteps) ...[
                                const SizedBox(width: 10),
                                Icon(Icons.checklist_rounded,
                                    size: 12, color: c),
                                const SizedBox(width: 3),
                                Text(
                                    '${task.doneStepCount}/${task.steps.length}',
                                    style: TextStyle(
                                        fontSize: 11,
                                        color: c,
                                        fontWeight: FontWeight.w700)),
                              ],
                              const Spacer(),
                              Icon(
                                _expanded
                                    ? Icons.keyboard_arrow_up_rounded
                                    : Icons.keyboard_arrow_down_rounded,
                                color: AppColors.textMuted,
                                size: 20,
                              ),
                            ],
                          ),
                          // Adım ilerleme çubuğu
                          if (task.hasSteps) ...[
                            const SizedBox(height: 8),
                            ClipRRect(
                              borderRadius: BorderRadius.circular(3),
                              child: LinearProgressIndicator(
                                value: task.stepProgress,
                                minHeight: 4,
                                backgroundColor: AppColors.borderSubtle,
                                valueColor: AlwaysStoppedAnimation(c),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // Genişletilmiş içerik
            if (_expanded)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (task.rationale != null) ...[
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: c.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(Icons.bolt_rounded, size: 14, color: c),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                task.rationale!,
                                style: TextStyle(
                                    fontSize: 12,
                                    color: AppColors.textSecondary,
                                    height: 1.4,
                                    fontStyle: FontStyle.italic),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (task.hasSteps)
                      ...List.generate(task.steps.length, (i) {
                        final step = task.steps[i];
                        return GestureDetector(
                          onTap: completed
                              ? null
                              : () => widget.onToggleStep(i),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 5),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  step.done
                                      ? Icons.check_box_rounded
                                      : Icons.check_box_outline_blank_rounded,
                                  color: step.done ? AppColors.success : c,
                                  size: 20,
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    step.label,
                                    style: TextStyle(
                                      fontSize: 13,
                                      height: 1.4,
                                      color: step.done
                                          ? AppColors.textMuted
                                          : AppColors.textPrimary,
                                      decoration: step.done
                                          ? TextDecoration.lineThrough
                                          : null,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      })
                    else if (!completed)
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: () => _confirmComplete(context),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: c,
                            padding: const EdgeInsets.symmetric(vertical: 12),
                          ),
                          child: const Text('TAMAMLA',
                              style: TextStyle(
                                  fontWeight: FontWeight.w800,
                                  color: Colors.white)),
                        ),
                      ),
                    if (completed && task.completionNote != null &&
                        task.completionNote!.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text('"${task.completionNote}"',
                          style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.textSecondary,
                              fontStyle: FontStyle.italic)),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _badge(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(text,
            style: TextStyle(
                fontSize: 9,
                fontWeight: FontWeight.w800,
                color: color,
                letterSpacing: 0.5)),
      );

  String _difficulty(TaskDifficulty d) => switch (d) {
        TaskDifficulty.easy => 'Kolay',
        TaskDifficulty.medium => 'Orta',
        TaskDifficulty.hard => 'Zor',
      };

  Future<void> _confirmComplete(BuildContext context) async {
    final controller = TextEditingController();
    final note = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        shape:
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Görevi Tamamla',
            style: TextStyle(
                color: AppColors.textPrimary, fontWeight: FontWeight.w800)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Nasıl geçti? (opsiyonel)',
                style:
                    TextStyle(color: AppColors.textSecondary, fontSize: 13)),
            const SizedBox(height: 10),
            TextField(
              controller: controller,
              maxLines: 3,
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'Örn: zorlandım ama yaptım...',
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
            onPressed: () => Navigator.pop(ctx, ''),
            child: const Text('Notsuz',
                style: TextStyle(color: AppColors.textMuted)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Tamamla'),
          ),
        ],
      ),
    );
    if (note != null) {
      widget.onComplete(note.isEmpty ? null : note);
    }
  }
}
