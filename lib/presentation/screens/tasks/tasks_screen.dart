import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../../../domain/entities/daily_task.dart';
import '../../providers/tasks_provider.dart';
import '../../providers/app_providers.dart';
import '../../widgets/tasks/detailed_task_card.dart';

/// Görevler ekranı — Fiziksel / Zihinsel / Sosyal tab'larına ayrılmış,
/// her görev detaylı adım takibi sunar (sadece tik değil).
class TasksScreen extends ConsumerStatefulWidget {
  const TasksScreen({super.key});

  @override
  ConsumerState<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends ConsumerState<TasksScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  static const _tabs = [
    (TaskType.physical, 'FİZİKSEL', AppColors.physical),
    (TaskType.mental, 'ZİHİNSEL', AppColors.mental),
    (TaskType.social, 'SOSYAL', AppColors.social),
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _tabController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final activeColor = _tabs[_tabController.index].$3;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('GÖREVLERİM'),
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: activeColor,
          indicatorWeight: 3,
          labelColor: activeColor,
          unselectedLabelColor: AppColors.textMuted,
          labelStyle:
              const TextStyle(fontSize: 13, fontWeight: FontWeight.w800),
          tabs: _tabs.map((t) => Tab(text: t.$2)).toList(),
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: _tabs.map((t) => _TaskTab(type: t.$1, color: t.$3)).toList(),
      ),
    );
  }
}

class _TaskTab extends ConsumerWidget {
  final TaskType type;
  final Color color;
  const _TaskTab({required this.type, required this.color});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasks = ref.watch(tasksByTypeProvider(type));

    if (tasks.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text('Bu kategoride görev yok.',
              style: TextStyle(color: AppColors.textMuted)),
        ),
      );
    }

    final completed = tasks.where((t) => t.isCompleted).length;
    final progress = tasks.isEmpty ? 0.0 : completed / tasks.length;

    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: _PersonalizedBanner(color: color),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: _ProgressHeader(
              completed: completed,
              total: tasks.length,
              progress: progress,
              color: color,
            ),
          ),
        ),
        SliverList(
          delegate: SliverChildBuilderDelegate(
            (context, index) {
              final task = tasks[index];
              return Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
                child: DetailedTaskCard(
                  task: task,
                  accent: color,
                  onToggleStep: (i) => ref
                      .read(tasksProvider.notifier)
                      .toggleStep(task.id, i),
                  onComplete: (note) => ref
                      .read(tasksProvider.notifier)
                      .completeTask(task.id, note: note),
                ).animate().fadeIn(duration: 250.ms).slideX(begin: 0.04, end: 0),
              );
            },
            childCount: tasks.length,
          ),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 40)),
      ],
    );
  }
}

/// Görevlerin kullanıcının form profiline göre üretildiğini vurgular.
class _PersonalizedBanner extends ConsumerWidget {
  final Color color;
  const _PersonalizedBanner({required this.color});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(intakeProvider)?.name;
    final greeting = (name != null && name.isNotEmpty && name != 'Savaşçı')
        ? '$name, bu plan sana özel. '
        : 'Bu plan sana özel. ';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.auto_awesome_rounded, size: 15, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: const TextStyle(
                  fontSize: 11.5,
                  color: AppColors.textSecondary,
                  height: 1.35,
                ),
                children: [
                  TextSpan(
                    text: greeting,
                    style: TextStyle(
                      color: color,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const TextSpan(
                    text:
                        'Bu görevler formda verdiğin cevaplara ve yüz/vücut analizine göre, '
                        'sadece senin için seçildi. Her görevin altındaki "Neden?" '
                        'kısmı bunu sana özel açıklıyor.',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProgressHeader extends StatelessWidget {
  final int completed;
  final int total;
  final double progress;
  final Color color;

  const _ProgressHeader({
    required this.completed,
    required this.total,
    required this.progress,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final done = progress >= 1.0;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: done
            ? LinearGradient(colors: [color.withValues(alpha: 0.3), color.withValues(alpha: 0.1)])
            : const LinearGradient(
                colors: [AppColors.surfaceElevated, AppColors.surface]),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 0.5),
      ),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                done ? 'MÜKEMMEL! 🔥' : 'BUGÜNÜN İLERLEMESİ',
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: color,
                    letterSpacing: 1),
              ),
              const SizedBox(height: 4),
              Text(
                '$completed / $total',
                style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary,
                    height: 1.1),
              ),
              Text(
                done ? 'Bu alanı bugün domine ettin.' : 'Adım adım ilerle.',
                style: const TextStyle(
                    fontSize: 12, color: AppColors.textSecondary),
              ),
            ],
          ),
          const Spacer(),
          SizedBox(
            width: 64,
            height: 64,
            child: Stack(
              alignment: Alignment.center,
              children: [
                CircularProgressIndicator(
                  value: progress,
                  strokeWidth: 6,
                  backgroundColor: AppColors.borderSubtle,
                  valueColor: AlwaysStoppedAnimation(color),
                ),
                Text('${(progress * 100).toInt()}',
                    style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w900,
                        color: color)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
