import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';

/// Hesap oluşturma / giriş ekranlarının altındaki yasal bilgilendirme:
/// "Devam ederek Kullanım Şartları ve Gizlilik Politikası'nı kabul etmiş
/// olursun." — burada Şartlar ve Politika GERÇEKTEN AÇILABİLİR bağlantılardır.
///
/// NEDEN AYRI BİR WIDGET (2026-08-20): daha önce login_screen'de bu cümle düz
/// metindi (dokunulamıyordu) ve onboarding'deki ZORUNLU giriş ekranında hiç
/// yoktu. Apple, hesap oluşturma akışında bu belgelere erişilebilmesini bekler
/// — belgelere atıfta bulunup açılmasını sağlamamak App Store 5.1.1 kapsamında
/// eksiklik sayılır. Tek yerden yönetilsin diye ortak bileşene alındı.
class LegalLinksText extends StatefulWidget {
  const LegalLinksText({super.key});

  @override
  State<LegalLinksText> createState() => _LegalLinksTextState();
}

class _LegalLinksTextState extends State<LegalLinksText> {
  // TapGestureRecognizer'lar elle dispose edilmeli, yoksa sızıntı olur.
  late final TapGestureRecognizer _termsTap;
  late final TapGestureRecognizer _privacyTap;

  @override
  void initState() {
    super.initState();
    _termsTap = TapGestureRecognizer()
      ..onTap = () => _open(DatingConfig.termsOfUseUrl, 'Kullanım Şartları');
    _privacyTap = TapGestureRecognizer()
      ..onTap = () =>
          _open(DatingConfig.privacyPolicyUrl, 'Gizlilik Politikası');
  }

  @override
  void dispose() {
    _termsTap.dispose();
    _privacyTap.dispose();
    super.dispose();
  }

  Future<void> _open(String url, String label) async {
    var ok = false;
    try {
      ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
    if (ok || !mounted) return;
    // Tarayıcı açılamazsa kullanıcı sessizce cevapsız kalmasın.
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('$label açılamadı. Adres: $url'),
      duration: const Duration(seconds: 6),
    ));
  }

  @override
  Widget build(BuildContext context) {
    const base = TextStyle(
      fontSize: 11,
      color: AppColors.textMuted,
      height: 1.45,
    );
    final link = base.copyWith(
      color: AppColors.gold,
      fontWeight: FontWeight.w700,
      decoration: TextDecoration.underline,
      decorationColor: AppColors.gold,
    );

    return Text.rich(
      TextSpan(
        style: base,
        children: [
          const TextSpan(text: 'Devam ederek '),
          TextSpan(
            text: 'Kullanım Şartları',
            style: link,
            recognizer: _termsTap,
          ),
          const TextSpan(text: ' ve '),
          TextSpan(
            text: 'Gizlilik Politikası',
            style: link,
            recognizer: _privacyTap,
          ),
          const TextSpan(text: '\'nı kabul etmiş olursun.'),
        ],
      ),
      textAlign: TextAlign.center,
    );
  }
}
