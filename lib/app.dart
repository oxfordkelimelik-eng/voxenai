import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';
import 'presentation/providers/app_providers.dart';
import 'data/sources/notification_service.dart';

class RiseUpApp extends ConsumerStatefulWidget {
  const RiseUpApp({super.key});

  @override
  ConsumerState<RiseUpApp> createState() => _RiseUpAppState();
}

class _RiseUpAppState extends ConsumerState<RiseUpApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Arka planda anonim giriş + bulut senkronunu başlat (UI'yı bloklamaz)
    ref.read(appBootstrapProvider);
    // Play Billing'i başlat (ürünleri yükle, satın alma akışını dinle)
    ref.read(billingServiceProvider);
    // Bildirimleri başlat (push + günlük hatırlatmalar) — UI'yı bloklamaz
    NotificationService.instance.init();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Uygulama arka plana alınınca tüm yerel durumu buluta aynala
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      pushSyncW(ref);
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      title: 'VOXEN AI',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      routerConfig: router,
    );
  }
}
