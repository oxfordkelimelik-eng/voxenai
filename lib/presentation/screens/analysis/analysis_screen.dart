import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/app_router.dart';
import '../../providers/analysis_provider.dart';
import '../../providers/app_providers.dart';
import 'guided_capture_screen.dart';

/// Ayrı yüz & vücut analiz merkezi.
/// Form sonrası ilk kez buraya gelinir; sonra her ekrandaki Analiz butonundan.
class AnalysisScreen extends ConsumerStatefulWidget {
  const AnalysisScreen({super.key});

  @override
  ConsumerState<AnalysisScreen> createState() => _AnalysisScreenState();
}

class _AnalysisScreenState extends ConsumerState<AnalysisScreen> {
  // Rehberli çekimden dönen [ön, sağ, sol] listeleri.
  List<File>? _facePhotos;
  List<File>? _bodyPhotos;

  Future<void> _capture(CaptureKind kind) async {
    final result = await Navigator.of(context).push<List<File>>(
      MaterialPageRoute(builder: (_) => GuidedCaptureScreen(kind: kind)),
    );
    if (result == null || result.length < 3 || !mounted) return;
    setState(() {
      if (kind == CaptureKind.face) {
        _facePhotos = result;
      } else {
        _bodyPhotos = result;
      }
    });
  }

  Future<void> _runFace() async {
    await ref.read(faceAnalysisFlowProvider.notifier).run(_facePhotos);
  }

  Future<void> _runBody() async {
    await ref.read(bodyAnalysisFlowProvider.notifier).run(_bodyPhotos);
  }

  /// İkisi de tamamlanınca: Pro değilse sonuçları görmeden önce ödeme
  /// ekranına (paywall) yönlendir; Pro ise doğrudan ana sayfaya geç.
  void _proceed() {
    final isPro = ref.read(isProProvider);
    context.go(isPro ? AppRoutes.home : AppRoutes.trial);
  }

  @override
  Widget build(BuildContext context) {
    final faceState = ref.watch(faceAnalysisFlowProvider);
    final bodyState = ref.watch(bodyAnalysisFlowProvider);
    final bothDone = faceState.value != null && bodyState.value != null;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('AI ANALİZ'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () =>
              context.canPop() ? context.pop() : context.go(AppRoutes.home),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'YÜZ & VÜCUT\nANALİZİ',
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary,
                  height: 1.1,
                  letterSpacing: 1,
                ),
              ).animate().fadeIn(duration: 400.ms),
              const SizedBox(height: 8),
              const Text(
                'Yüzünü ve vücudunu ÖN / SAĞ / SOL açılardan rehberli çek; '
                'çizgiye oturunca yeşile döner ve kaydeder.',
                style: TextStyle(
                  fontSize: 14,
                  color: AppColors.textSecondary,
                  height: 1.5,
                ),
              ).animate(delay: 100.ms).fadeIn(),
              const SizedBox(height: 20),

              // YÜZ
              _AnalysisCard(
                title: 'Yüz Analizi',
                subtitle: 'Çene hattı, cilt, saç & sakal',
                icon: Icons.face_retouching_natural,
                color: AppColors.gold,
                photos: _facePhotos,
                isLoading: faceState.isLoading,
                hasResult: faceState.value != null,
                onCapture: () => _capture(CaptureKind.face),
                onRemove: () => setState(() => _facePhotos = null),
                onAnalyze: _runFace,
              ),
              const SizedBox(height: 16),

              // VÜCUT
              _AnalysisCard(
                title: 'Vücut Analizi',
                subtitle: 'Kompozisyon, postür, kas',
                icon: Icons.accessibility_new_rounded,
                color: AppColors.physical,
                photos: _bodyPhotos,
                isLoading: bodyState.isLoading,
                hasResult: bodyState.value != null,
                onCapture: () => _capture(CaptureKind.body),
                onRemove: () => setState(() => _bodyPhotos = null),
                onAnalyze: _runBody,
              ),

              const SizedBox(height: 20),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.borderSubtle),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.info_outline_rounded,
                        color: AppColors.textMuted, size: 16),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '3 açı (ön/sağ/sol) çekersen AI gerçek analiz yapar; '
                        'foto yoksa form verilerinden tahmini analiz üretilir. '
                        'Analizler yol göstericidir.',
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.textMuted,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 24),
              // İkisi de tamamlanmadan devam edilemez
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: bothDone ? _proceed : null,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    disabledBackgroundColor: AppColors.borderSubtle,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: Text(
                    bothDone
                        ? 'KENDİNİN EN İYİ VERSİYONUNA GEÇ'
                        : 'ÖNCE İKİ ANALİZİ DE TAMAMLA',
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.5,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AnalysisCard extends StatelessWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final List<File>? photos;
  final bool isLoading;
  final bool hasResult;
  final VoidCallback onCapture;
  final VoidCallback onRemove;
  final VoidCallback onAnalyze;

  const _AnalysisCard({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.photos,
    required this.isLoading,
    required this.hasResult,
    required this.onCapture,
    required this.onRemove,
    required this.onAnalyze,
  });

  static const _angleLabels = ['ÖN', 'SAĞ', 'SOL'];

  bool get _hasPhotos => photos != null && photos!.length >= 3;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                            color: AppColors.textPrimary)),
                    Text(subtitle,
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textSecondary)),
                  ],
                ),
              ),
              if (hasResult)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: AppColors.success.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.check_circle_rounded,
                          color: AppColors.success, size: 14),
                      SizedBox(width: 4),
                      Text('Analiz tamamlandı',
                          style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: AppColors.success)),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),

          // Foto alanı: 3 açı önizleme veya rehberli çekim butonu
          if (_hasPhotos)
            Column(
              children: [
                Row(
                  children: List.generate(3, (i) {
                    return Expanded(
                      child: Padding(
                        padding: EdgeInsets.only(right: i < 2 ? 8 : 0),
                        child: _thumb(photos![i], _angleLabels[i]),
                      ),
                    );
                  }),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Icon(Icons.check_circle_rounded,
                        color: AppColors.success, size: 16),
                    const SizedBox(width: 6),
                    const Text('3 açı hazır',
                        style: TextStyle(
                            fontSize: 12,
                            color: AppColors.success,
                            fontWeight: FontWeight.w700)),
                    const Spacer(),
                    GestureDetector(
                      onTap: onRemove,
                      child: const Text('Yeniden çek',
                          style: TextStyle(
                              fontSize: 12, color: AppColors.textMuted)),
                    ),
                  ],
                ),
              ],
            )
          else
            _captureBtn(),

          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: isLoading ? null : onAnalyze,
              style: ElevatedButton.styleFrom(
                backgroundColor: color,
                disabledBackgroundColor: AppColors.borderSubtle,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              child: isLoading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                          color: Colors.white, strokeWidth: 2),
                    )
                  : Text(
                      _hasPhotos ? '3 AÇIYI ANALİZ ET' : 'TAHMİNİ ANALİZ ÜRET',
                      style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5,
                          color: Colors.white),
                    ),
            ),
          ),
          if (isLoading && _hasPhotos) ...[
            const SizedBox(height: 12),
            _AnalyzingHint(color: color),
          ],
        ],
      ),
    );
  }

  Widget _captureBtn() {
    return GestureDetector(
      onTap: onCapture,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 22),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.3)),
        ),
        child: Column(
          children: [
            Icon(Icons.camera_alt_rounded, color: color, size: 26),
            const SizedBox(height: 8),
            Text('REHBERLİ ÇEKİM (3 AÇI)',
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: color)),
            const SizedBox(height: 2),
            const Text('Ön • Sağ • Sol',
                style:
                    TextStyle(fontSize: 11, color: AppColors.textSecondary)),
          ],
        ),
      ),
    );
  }

  Widget _thumb(File file, String label) {
    return Column(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.file(file,
              width: double.infinity, height: 90, fit: BoxFit.cover),
        ),
        const SizedBox(height: 4),
        Text(label,
            style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: AppColors.textSecondary)),
      ],
    );
  }
}

/// Analiz sürerken sırayla değişen ipucu metni — kullanıcıya ne yapıldığını anlatır.
class _AnalyzingHint extends StatefulWidget {
  final Color color;
  const _AnalyzingHint({required this.color});

  @override
  State<_AnalyzingHint> createState() => _AnalyzingHintState();
}

class _AnalyzingHintState extends State<_AnalyzingHint> {
  static const _hints = [
    'Ön açı inceleniyor…',
    'Sağ profil değerlendiriliyor…',
    'Sol profil değerlendiriliyor…',
    'Simetri ve oranlar ölçülüyor…',
    'Sana özel öneriler hazırlanıyor…',
  ];
  int _i = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(milliseconds: 1800), (_) {
      if (!mounted) return;
      setState(() => _i = (_i + 1) % _hints.length);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(
          width: 14,
          height: 14,
          child: CircularProgressIndicator(strokeWidth: 2, color: widget.color),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 350),
            child: Text(
              _hints[_i],
              key: ValueKey(_i),
              style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                  fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ],
    );
  }
}
