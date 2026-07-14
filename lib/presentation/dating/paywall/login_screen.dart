import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/dating_routes.dart';
import '../../providers/app_providers.dart' show authServiceProvider;
import '../providers/dating_providers.dart';

/// Giriş ekranı (Bölüm 3 & 5). Yalnızca abonelik anında tetiklenir.
/// Apple + Google. Email/şifre YOK. Giriş → ödeme → abonelik aktifleşir.
///
/// NOT (üretim): Apple için `sign_in_with_apple`, Google için `google_sign_in`
/// (pubspec'te mevcut) ve ödeme için RevenueCat/`in_app_purchase` bağlanmalı.
/// Burada akış ve durum yönetimi kurulu; gerçek SDK çağrıları TODO olarak
/// işaretli yerlerde entegre edilecek.
class LoginScreen extends ConsumerStatefulWidget {
  final String plan; // seçilen plan (weekly/monthly)
  final bool restore;
  final bool trial; // true → 3 gün ücretsiz deneme; false → doğrudan abonelik
  const LoginScreen({
    super.key,
    required this.plan,
    this.restore = false,
    this.trial = true,
  });

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  bool _busy = false;
  bool _consent = false;

  Future<void> _signInAndContinue(String provider) async {
    if (!_consent && !widget.restore) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Devam etmek için gizlilik onayını işaretle.'),
      ));
      return;
    }
    setState(() => _busy = true);
    final ent = ref.read(entitlementProvider.notifier);

    // Gerçek Apple/Google (Firebase Auth) girişi. signIn içeride
    // linkWithApple/linkWithGoogle çağırır; başarısız/iptal olursa
    // signInProvider null kalir.
    try {
      await ent.signIn(provider);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(e.toString()),
        duration: const Duration(seconds: 6),
      ));
      return;
    }

    // Girişin GERÇEKTEN başarılı olup olmadığını Firebase Auth durumundan
    // dogrula — kullanici iptal ederse ya da yapilandirma eksikse buraya
    // dusup hub'a yonlendirmemeliyiz.
    final signedIn = ref.read(authServiceProvider).currentUser != null &&
        !ref.read(authServiceProvider).isAnonymous;
    if (!signedIn) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Giriş tamamlanamadı. Lütfen tekrar dene.'),
      ));
      return;
    }

    // Abonelik yok; giriş yalnızca satın alımları cihazlar arası saklamak
    // içindir. Geri yükleme istendiyse önceki paket bakiyeleri kontrol edilir.
    if (widget.restore) {
      await ent.restore();
    }

    if (!mounted) return;
    context.go(DatingRoutes.hub);
  }

  @override
  Widget build(BuildContext context) {
    final restore = widget.restore;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded,
                    size: 18, color: AppColors.textSecondary),
                onPressed: () => context.pop(),
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 12),
                    const Icon(Icons.lock_person_rounded,
                        color: AppColors.gold, size: 48),
                    const SizedBox(height: 20),
                    Text(
                      restore
                          ? 'Aboneliğini geri yükle'
                          : 'Aboneliğini güvenle sakla',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w900,
                          color: AppColors.textPrimary),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      restore
                          ? 'Giriş yaparak önceki aboneliğini bu cihaza taşı.'
                          : 'Hesabını oluştur; aboneliğin ve ürettiklerin '
                              'cihaz değişse bile kaybolmasın.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                          fontSize: 14,
                          color: AppColors.textSecondary,
                          height: 1.4),
                    ),
                    const SizedBox(height: 32),
                    _AuthButton(
                      label: 'Apple ile Giriş Yap',
                      icon: Icons.apple,
                      bg: Colors.white,
                      fg: Colors.black,
                      onTap: _busy
                          ? null
                          : () => _signInAndContinue('apple'),
                    ),
                    const SizedBox(height: 12),
                    _AuthButton(
                      label: 'Google ile Giriş Yap',
                      icon: Icons.g_mobiledata_rounded,
                      bg: AppColors.surfaceElevated,
                      fg: AppColors.textPrimary,
                      onTap: _busy
                          ? null
                          : () => _signInAndContinue('google'),
                    ),
                    if (_busy) ...[
                      const SizedBox(height: 24),
                      const Center(
                          child: CircularProgressIndicator(
                              color: AppColors.gold)),
                    ],
                    if (!restore) ...[
                      const SizedBox(height: 24),
                      _consentRow(),
                    ],
                  ],
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 0, 24, 16),
              child: Text(
                'Devam ederek Kullanım Şartları ve Gizlilik Politikası\'nı '
                'kabul etmiş olursun.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11, color: AppColors.textMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _consentRow() {
    return GestureDetector(
      onTap: () => setState(() => _consent = !_consent),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
              _consent
                  ? Icons.check_box_rounded
                  : Icons.check_box_outline_blank_rounded,
              color: _consent ? AppColors.gold : AppColors.textMuted),
          const SizedBox(width: 10),
          const Expanded(
            child: Text(
              'Fotoğraflarımın yalnızca analiz ve üretim için işlenmesine '
              'açık rıza veriyorum. (KVKK/GDPR)',
              style: TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                  height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _AuthButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color bg;
  final Color fg;
  final VoidCallback? onTap;
  const _AuthButton({
    required this.label,
    required this.icon,
    required this.bg,
    required this.fg,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 54,
      child: ElevatedButton.icon(
        onPressed: onTap,
        icon: Icon(icon, color: fg, size: 26),
        label: Text(label,
            style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w700, color: fg)),
        style: ElevatedButton.styleFrom(
          backgroundColor: bg,
          disabledBackgroundColor: bg.withValues(alpha: 0.5),
          elevation: 0,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
    );
  }
}
