import 'package:flutter/material.dart';
import 'package:in_app_review/in_app_review.dart';
import 'package:logger/logger.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/constants/app_colors.dart';
import '../../core/constants/dating_constants.dart';

/// Soft gate: önce "Beğendim / Sorun var", sonra mağaza veya geri bildirim.
///
/// App Store 5.6.1/5.6.3 — özel yıldız ekranı + yalnızca yüksek puanı
/// mağazaya göndermek yasak. Bu yüzden yıldız sormuyoruz; memnuniyet
/// soruyoruz. Mutlu → resmi in-app review; mutsuz → App Store'a gitmeden form.
enum ReviewSoftChoice { happy, unhappy }

class ReviewPromptService {
  final Logger _logger = Logger();
  final InAppReview _inAppReview;

  ReviewPromptService({InAppReview? inAppReview})
      : _inAppReview = inAppReview ?? InAppReview.instance;

  /// Başarılı üretim/analiz sonrası — bir kez soft gate gösterir.
  Future<void> maybePromptAfterSuccess(BuildContext context) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool(DatingKeys.reviewPromptShown) == true) return;
      if (!context.mounted) return;

      // Bayrak sheet AÇILMADAN önce: kullanıcı kapatırsa da tekrar sorma.
      await prefs.setBool(DatingKeys.reviewPromptShown, true);
      if (!context.mounted) return;

      await promptNow(context);
    } catch (e) {
      _logger.w('ReviewPromptService: soft gate açılamadı: $e');
    }
  }

  /// Kullanıcı "Bizi Değerlendir" dediğinde — prefs'e bakmadan sor.
  Future<void> promptNow(BuildContext context) async {
    if (!context.mounted) return;
    final choice = await showModalBottomSheet<ReviewSoftChoice>(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (_) => const _ReviewSoftGateSheet(),
    );
    if (!context.mounted || choice == null) return;

    if (choice == ReviewSoftChoice.happy) {
      await _openStoreReview();
    } else {
      await showModalBottomSheet<void>(
        context: context,
        backgroundColor: AppColors.surface,
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
        builder: (_) => const _FeedbackFormSheet(),
      );
    }
  }

  Future<void> _openStoreReview() async {
    try {
      if (await _inAppReview.isAvailable()) {
        await _inAppReview.requestReview();
        return;
      }
      await _inAppReview.openStoreListing();
    } catch (e) {
      _logger.w('ReviewPromptService: mağaza açılamadı: $e');
    }
  }
}

class _ReviewSoftGateSheet extends StatelessWidget {
  const _ReviewSoftGateSheet();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppColors.borderSubtle,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 20),
            const Icon(Icons.favorite_rounded, color: AppColors.gold, size: 40),
            const SizedBox(height: 14),
            const Text(
              'Deneyimin nasıl?',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Kısa bir geri bildirim, uygulamayı herkes için daha iyi yapmamıza yardım eder.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                height: 1.35,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 22),
            SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton(
                onPressed: () =>
                    Navigator.of(context).pop(ReviewSoftChoice.happy),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.gold,
                  foregroundColor: AppColors.textOnGold,
                  elevation: 8,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                child: const Text(
                  'Beğendim',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: OutlinedButton(
                onPressed: () =>
                    Navigator.of(context).pop(ReviewSoftChoice.unhappy),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.textPrimary,
                  side: const BorderSide(color: AppColors.borderSubtle),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                child: const Text(
                  'Sorun var',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FeedbackFormSheet extends StatefulWidget {
  const _FeedbackFormSheet();

  @override
  State<_FeedbackFormSheet> createState() => _FeedbackFormSheetState();
}

class _FeedbackFormSheetState extends State<_FeedbackFormSheet> {
  final _controller = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final uri = Uri(
      scheme: 'mailto',
      path: DatingConfig.supportEmail,
      queryParameters: {
        'subject': 'Voxen AI — Geri bildirim',
        'body': text,
      },
    );
    try {
      final ok = await launchUrl(uri);
      if (!mounted) return;
      if (ok) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Teşekkürler — mesajını mail uygulamasında gönder.'),
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Mail açılamadı. Bize yaz: ${DatingConfig.supportEmail}',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final canSend = _controller.text.trim().isNotEmpty && !_sending;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.borderSubtle,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              const Text(
                'Bize bildirin',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Ne ters gitti? Kısa yazman yeterli — mağazaya yönlendirme yok, '
                'doğrudan bize gelir.',
                style: TextStyle(
                  fontSize: 14,
                  height: 1.35,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _controller,
                maxLines: 5,
                maxLength: 800,
                autofocus: true,
                style: const TextStyle(color: AppColors.textPrimary),
                decoration: InputDecoration(
                  hintText:
                      'Örn. fotoğraflar yüzüme benzemedi, bakış yanlıştı…',
                  hintStyle: TextStyle(
                    color: AppColors.textMuted.withValues(alpha: 0.9),
                  ),
                  filled: true,
                  fillColor: AppColors.surfaceElevated,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: AppColors.borderSubtle),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: AppColors.borderSubtle),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: AppColors.gold),
                  ),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: canSend ? _send : null,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                    disabledBackgroundColor: AppColors.surfaceElevated,
                    disabledForegroundColor: AppColors.textMuted,
                    elevation: canSend ? 8 : 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  child: _sending
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.5,
                            color: AppColors.textOnGold,
                          ),
                        )
                      : const Text(
                          'Gönder',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
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
