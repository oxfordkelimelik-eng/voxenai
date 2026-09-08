import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants/app_colors.dart';
import '../../core/router/dating_routes.dart';
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

  Future<void> _signIn() async {
    setState(() => _busy = true);
    try {
      await ref.read(authServiceProvider).linkWithGoogle();
    } catch (_) {
      // Sessizce yut — buton yeniden görünür, "admin" ima eden bir mesaj yok.
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
              ],
            ),
          ),
        ),
      );
    }

    if (email != kOpsEmail) {
      // Sessiz yönlendirme — hiçbir mesaj gösterme.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) context.go(DatingRoutes.splash);
      });
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: SizedBox.shrink(),
      );
    }

    return widget.builder(context);
  }
}
