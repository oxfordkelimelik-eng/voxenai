import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';
import 'app.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Firebase'i başlat (auth + firestore senkronu için)
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  // App Check: çağrının gerçekten bu uygulamadan geldiğini kanıtlar.
  //
  // NEDEN: Firebase Web API anahtarı uygulama paketinden çıkarılabilir; onunla
  // anonim hesap açıp Cloud Functions'ı doğrudan çağırmak mümkün. Kullanıcı
  // başına hız sınırı bunu tek başına durdurmaz, çünkü saldırgan her denemede
  // YENİ bir anonim kimlik alabilir. App Check bu boşluğu kapatan kontroldür.
  //
  // Sunucu tarafı şu an İZLEME modunda (functions/_shared.js
  // APP_CHECK_ENFORCED=false): belirteç gelmezse istek reddedilmez, yalnızca
  // loglanır. Firebase Console > App Check'te sağlayıcılar kaydedilip
  // doğrulanmış istek oranı ~%100 olduğunda sunucuda zorlama açılmalı.
  //
  // Hata yutuluyor: App Check kurulmadan da uygulama çalışmaya devam etmeli
  // (aksi hâlde konsol yapılandırması tamamlanana kadar uygulama açılmazdı).
  try {
    await FirebaseAppCheck.instance.activate(
      // Yayın: donanım destekli doğrulama. Hata ayıklama: simülatör/emülatörde
      // App Attest çalışmadığı için debug sağlayıcı.
      // App Attest iOS 14+ ister; eski cihazlarda DeviceCheck'e düşen varyant
      // kullanılıyor ki bu kullanıcılar dışarıda kalmasın.
      providerApple: kDebugMode
          ? const AppleDebugProvider()
          : const AppleAppAttestWithDeviceCheckFallbackProvider(),
      providerAndroid: kDebugMode
          ? const AndroidDebugProvider()
          : const AndroidPlayIntegrityProvider(),
    );
  } catch (e) {
    debugPrint('App Check başlatılamadı (uygulama çalışmaya devam ediyor): $e');
  }

  // Fontları runtime'da indirme — sadece önbellek veya bundle kullan
  GoogleFonts.config.allowRuntimeFetching = false;

  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF0A0A0A),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );

  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const ProviderScope(child: RiseUpApp()));
}
