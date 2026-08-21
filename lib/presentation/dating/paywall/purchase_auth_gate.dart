import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../../providers/app_providers.dart' show authServiceProvider;
import '../providers/dating_providers.dart';

/// SATIN ALMA ÖNCESİ OTURUM KAPISI
///
/// NEDEN VAR (2026-08-19 App Store reddi, Guideline 2.1(b) "the purchase
/// failed"): paywall ve modül vitrini GİRİŞSİZ gezilebiliyordu, ama satın
/// almanın sunucu doğrulaması (`verifyPurchase`) `request.auth` ZORUNLU
/// tutuyor. Giriş yapmamış bir kullanıcı satın al'a bastığında mağaza işlemi
/// BAŞARIYLA tamamlanıyor, ardından doğrulama `unauthenticated` ile düşüyor ve
/// kullanıcı "Satın alma tamamlanamadı" hatası görüyordu — üstelik işlem
/// `completePurchase` edilmediği için mağazada askıda kalıyordu. Apple hakemi
/// tam olarak bu yolu denedi (girişsiz vitrin → Ayarlar → Paket Al).
///
/// Bu kapı, mağaza akışı HİÇ başlamadan önce girişi garantiler.
Future<bool> ensureSignedInForPurchase(
  BuildContext context,
  WidgetRef ref,
) async {
  final auth = ref.read(authServiceProvider);
  if (auth.currentUser != null && !auth.isAnonymous) return true;

  final signedIn = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: AppColors.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
    ),
    builder: (_) => const _PurchaseAuthSheet(),
  );
  return signedIn == true;
}

class _PurchaseAuthSheet extends ConsumerStatefulWidget {
  const _PurchaseAuthSheet();

  @override
  ConsumerState<_PurchaseAuthSheet> createState() => _PurchaseAuthSheetState();
}

class _PurchaseAuthSheetState extends ConsumerState<_PurchaseAuthSheet> {
  bool _busy = false;

  Future<void> _signIn(String provider) async {
    setState(() => _busy = true);
    try {
      await ref.read(entitlementProvider.notifier).signIn(provider);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(e.toString()),
        duration: const Duration(seconds: 6),
      ));
      return;
    }
    if (!mounted) return;
    // Girişin GERÇEKTEN tamamlandığını Firebase Auth durumundan doğrula —
    // kullanıcı iptal ederse signIn sessizce dönebiliyor (bkz. login_screen).
    final auth = ref.read(authServiceProvider);
    final ok = auth.currentUser != null && !auth.isAnonymous;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Giriş tamamlanamadı. Lütfen tekrar dene.'),
      ));
      return;
    }
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            22, 14, 22, 18 + MediaQuery.of(context).padding.bottom),
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
            const Icon(Icons.lock_person_rounded,
                color: AppColors.gold, size: 40),
            const SizedBox(height: 14),
            const Text(
              'Satın almadan önce giriş yap',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w900,
                  color: AppColors.textPrimary),
            ),
            const SizedBox(height: 8),
            const Text(
              'Aldığın paketin hesabına tanımlanabilmesi ve cihaz değiştirsen '
              'bile kaybolmaması için giriş yapman gerekiyor. Abonelik yok — '
              'ödeme yine tek seferlik.',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 13,
                  color: AppColors.textSecondary,
                  height: 1.45),
            ),
            const SizedBox(height: 26),
            // Apple, "Google ile giriş" sunan uygulamalarda "Apple ile giriş"i
            // de ZORUNLU tutar (App Store Review 4.8) — Apple ilk sırada.
            _AuthButton(
              label: 'Apple ile Giriş Yap',
              icon: Icons.apple,
              bg: Colors.white,
              fg: Colors.black,
              onTap: _busy ? null : () => _signIn('apple'),
            ),
            const SizedBox(height: 12),
            _AuthButton(
              label: 'Google ile Giriş Yap',
              icon: Icons.g_mobiledata_rounded,
              bg: AppColors.surfaceElevated,
              fg: AppColors.textPrimary,
              onTap: _busy ? null : () => _signIn('google'),
            ),
            if (_busy) ...[
              const SizedBox(height: 20),
              const Center(
                  child: CircularProgressIndicator(color: AppColors.gold)),
            ],
            const SizedBox(height: 10),
            TextButton(
              onPressed: _busy ? null : () => Navigator.pop(context, false),
              child: const Text('Vazgeç',
                  style:
                      TextStyle(fontSize: 13, color: AppColors.textSecondary)),
            ),
          ],
        ),
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
            style:
                TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: fg)),
        style: ElevatedButton.styleFrom(
          backgroundColor: bg,
          disabledBackgroundColor: bg.withValues(alpha: 0.5),
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
    );
  }
}
