import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/constants/app_colors.dart';
import '../providers/app_providers.dart' show authServiceProvider;

/// Bu email dışındaki kimse içeriği görmez — tek güvenlik sınırı sunucu
/// tarafındadır (opsPanel.js), burası sadece UX (yanlış kullanıcıya ekran
/// göstermemek).
const String kOpsEmail = 'kutayalptekin3@gmail.com';

/// `/ops` altındaki her ekranı sarar: email eşleşmiyorsa sessizce ana ekrana
/// döner (hata mesajı yok, panelin varlığını ifşa etmez).
class OpsGate extends ConsumerStatefulWidget {
  final WidgetBuilder builder;
  const OpsGate({required this.builder, super.key});

  @override
  ConsumerState<OpsGate> createState() => _OpsGateState();
}

class _OpsGateState extends ConsumerState<OpsGate> {
  bool _busy = false;
  String? _lastError; // TANI (2026-09-10, GEÇİCİ)

  Future<void> _signIn() async {
    setState(() {
      _busy = true;
      _lastError = null;
    });
    try {
      await ref.read(authServiceProvider).linkWithGoogle();
    } catch (e) {
      _lastError = e.toString();
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final email = ref.watch(authServiceProvider).currentUser?.email?.toLowerCase().trim();

    if (email == null) {
      return Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.lock_outline_rounded,
                    color: AppColors.textMuted, size: 40),
                const SizedBox(height: 16),
                const Text(
                  'Devam etmek için giriş yap',
                  style: TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: _busy ? null : _signIn,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 14),
                  ),
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white),
                        )
                      : const Text('Google ile Giriş'),
                ),
                if (_lastError != null) ...[
                  const SizedBox(height: 16),
                  Text('Hata: $_lastError',
                      style: const TextStyle(
                          color: AppColors.textMuted, fontSize: 12)),
                ],
              ],
            ),
          ),
        ),
      );
    }

    if (email != kOpsEmail) {
      // TANI (2026-09-10, GEÇİCİ): giriş sonrası yanlış yönlendirme
      // şikayeti üzerine — hangi email geldiğini ekranda gösterir + tekrar
      // giriş denemek için buton. Kök sebep netleşince bu blok eski
      // (sessiz yönlendirme) haline döndürülecek.
      return Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('TANI (geçici ekran)',
                    style: TextStyle(
                        color: AppColors.textPrimary,
                        fontWeight: FontWeight.w800)),
                const SizedBox(height: 12),
                Text('Algılanan email: "$email"',
                    style: const TextStyle(color: AppColors.textPrimary)),
                const SizedBox(height: 6),
                Text('Beklenen: "$kOpsEmail"',
                    style: const TextStyle(color: AppColors.textMuted)),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: _busy ? null : _signIn,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                  ),
                  child: const Text('Farklı Google Hesabıyla Tekrar Dene'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return widget.builder(context);
  }
}
