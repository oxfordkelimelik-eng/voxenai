import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'package:logger/logger.dart';

/// Tüm bildirim altyapısı:
///  • Push (Firebase Cloud Messaging) — sunucudan/kampanyadan gelen bildirimler
///  • Yerel zamanlı hatırlatmalar (flutter_local_notifications)
///
/// BİLDİRİM STRATEJİSİ (2026-08-02'de yeniden yazıldı):
/// Eskiden "Rise Up" (alışkanlık/streak uygulaması) döneminden kalma, her gün
/// tekrar eden 2 sabit bildirim vardı: 09:00 "günlük görevlerin hazır" ve
/// 20:00 "serini kaybetme". Voxen AI'da ne günlük görev ne de streak var —
/// bu ekranlar router'da bile yok, yani kullanıcı OLMAYAN bir özellik için
/// günde 2 kez rahatsız ediliyordu.
///
/// Voxen AI ara sıra kullanılan bir fotoğraf aracı; günlük ritim uygulaması
/// DEĞİL. Bu yüzden sabit tekrarlayan bildirim YOK. Bildirimler yalnızca
/// GERÇEK bir duruma bağlı olarak, tek seferlik ve seyrek zamanlanır:
///   • Ücretsiz hakkını hiç kullanmamış   -> 1. gün + 3. gün
///   • Ücretsiz fotoyu üretmiş, 4'ü kilitli -> 2. gün
/// Durum değişince (hak kullanıldı / paket alındı) ilgili bildirim iptal
/// edilir — bkz. syncEngagementReminders.
class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final _local = FlutterLocalNotificationsPlugin();
  final _logger = Logger();
  bool _initialized = false;

  // Bildirim kimlikleri (sabit — yeniden zamanlamada eskisini ezer)
  static const int _freeTrialDay1Id = 2001;
  static const int _freeTrialDay3Id = 2002;
  static const int _lockedPhotosId = 2003;

  /// Eski "Rise Up" döneminden kalan bildirim kimlikleri — güncelleme ile
  /// gelen kullanıcılarda zamanlanmış hâlde kalmasınlar diye iptal edilir.
  static const List<int> _legacyIds = [1001, 1002];

  /// Eski kanal: 'riseup_reminders' ("Günlük görev ve streak hatırlatmaları").
  /// Android'de var olan bir kanalın adı/açıklaması uygulama tarafından
  /// DEĞİŞTİRİLEMEZ — bu yüzden yeni bir kanal açılıp eskisi siliniyor,
  /// yoksa kullanıcı ayarlarında hâlâ "streak" yazan bir kanal görünürdü.
  static const String _legacyChannelId = 'riseup_reminders';

  static const _androidChannel = AndroidNotificationChannel(
    'voxen_reminders',
    'Hatırlatmalar',
    description: 'Ücretsiz hakkın ve bekleyen fotoğrafların için hatırlatmalar',
    importance: Importance.high,
  );

  /// Uygulama açılışında çağrılır. İzin ister, kanalı kurar, FCM'i bağlar.
  /// Hata olursa sessizce geçer.
  ///
  /// NOT: Burada artık bildirim ZAMANLANMAZ. Zamanlama cüzdan durumuna
  /// bağlı olduğu için syncEngagementReminders ile yapılır.
  Future<void> init() async {
    if (_initialized) return;
    try {
      tzdata.initializeTimeZones();

      const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
      const iosInit = DarwinInitializationSettings();
      await _local.initialize(
        const InitializationSettings(android: androidInit, iOS: iosInit),
      );

      // Android bildirim kanalı + izin
      final androidImpl = _local
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>();
      await androidImpl?.createNotificationChannel(_androidChannel);
      await androidImpl?.deleteNotificationChannel(_legacyChannelId);
      await androidImpl?.requestNotificationsPermission();
      await androidImpl?.requestExactAlarmsPermission();

      // Güncellemeyle gelen kullanıcılarda eski (artık anlamsız) günlük
      // görev/streak hatırlatmalarını temizle.
      for (final id in _legacyIds) {
        await _local.cancel(id);
      }

      // FCM izni + token (push için)
      await _initFcm();

      _initialized = true;
    } catch (e) {
      _logger.w('Bildirim init atlandı: $e');
    }
  }

  Future<void> _initFcm() async {
    try {
      final messaging = FirebaseMessaging.instance;
      await messaging.requestPermission();
      final token = await messaging.getToken();
      _logger.i('FCM token: $token');

      // Uygulama ön plandayken gelen push'u yerel bildirime çevir
      FirebaseMessaging.onMessage.listen((RemoteMessage m) {
        final n = m.notification;
        if (n != null) {
          _showNow(n.title ?? 'Voxen AI', n.body ?? '');
        }
      });
    } catch (e) {
      _logger.w('FCM init atlandı: $e');
    }
  }

  Future<void> _showNow(String title, String body) async {
    await _local.show(
      DateTime.now().millisecondsSinceEpoch ~/ 1000,
      title,
      body,
      _details(),
    );
  }

  NotificationDetails _details() => NotificationDetails(
        android: AndroidNotificationDetails(
          _androidChannel.id,
          _androidChannel.name,
          channelDescription: _androidChannel.description,
          importance: Importance.high,
          priority: Priority.high,
          icon: '@mipmap/ic_launcher',
        ),
        iOS: const DarwinNotificationDetails(),
      );

  /// Kullanıcının GERÇEK durumuna göre hatırlatmaları yeniden kurar.
  /// Uygulama her açıldığında ve cüzdan durumu değiştiğinde çağrılmalı —
  /// her çağrıda ilgili bildirimler önce iptal edilip koşul hâlâ geçerliyse
  /// yeniden zamanlanır (böylece hak kullanılınca bildirim kendiliğinden
  /// susar ve süre baştan başlar).
  ///
  /// [freePhotoUsed]    : AI foto ücretsiz hakkı kullanıldı mı
  /// [freeAnalysisUsed] : foto analizi ücretsiz hakkı kullanıldı mı
  /// [hasLockedPhotos]  : ücretsiz üretimden kilitli kalan fotoğraf var mı
  ///                      (paket alınmamışsa 5'in 4'ü kilitli kalır)
  Future<void> syncEngagementReminders({
    required bool freePhotoUsed,
    required bool freeAnalysisUsed,
    required bool hasLockedPhotos,
  }) async {
    // init() henüz bitmemiş olabilir (ikisi de uygulama açılışında paralel
    // tetikleniyor) — plugin hazır değilken zamanlama sessizce düşerdi.
    // init() idempotent, ikinci çağrı hemen döner.
    await init();
    try {
      // Her seferinde sıfırla — koşul artık geçerli değilse yeniden kurulmaz.
      await _local.cancel(_freeTrialDay1Id);
      await _local.cancel(_freeTrialDay3Id);
      await _local.cancel(_lockedPhotosId);

      // 1) Ücretsiz hakkını hiç kullanmamış: 1. ve 3. gün hatırlat.
      final hasUnusedFreeTrial = !freePhotoUsed || !freeAnalysisUsed;
      if (hasUnusedFreeTrial) {
        final what = !freePhotoUsed && !freeAnalysisUsed
            ? 'Ücretsiz fotoğrafın ve analizin'
            : (!freePhotoUsed ? 'Ücretsiz fotoğrafın' : 'Ücretsiz analizin');
        await _scheduleIn(
          id: _freeTrialDay1Id,
          delay: const Duration(days: 1),
          title: '✨ $what seni bekliyor',
          body: 'Birkaç selfie yükle, profilin için hazır kareyi gör.',
        );
        await _scheduleIn(
          id: _freeTrialDay3Id,
          delay: const Duration(days: 3),
          title: '📸 Profil fotoğrafın eşleşmelerini belirliyor',
          body: '$what hâlâ kullanılmadı. Denemek birkaç dakika sürüyor.',
        );
      }

      // 2) Ücretsiz fotoyu üretmiş ama kalanlar kilitli: 2. gün hatırlat.
      if (hasLockedPhotos) {
        await _scheduleIn(
          id: _lockedPhotosId,
          delay: const Duration(days: 2),
          title: '🔒 Fotoğraflarının kilidi hâlâ kapalı',
          body: 'Senin için hazırlanan kareleri açmak için pakete göz at.',
        );
      }
    } catch (e) {
      _logger.w('Hatırlatma zamanlama atlandı: $e');
    }
  }

  /// Belirtilen süre sonrası için TEK SEFERLİK bildirim kurar
  /// (matchDateTimeComponents YOK — tekrar etmez).
  Future<void> _scheduleIn({
    required int id,
    required Duration delay,
    required String title,
    required String body,
  }) async {
    await _local.zonedSchedule(
      id,
      title,
      body,
      tz.TZDateTime.now(tz.local).add(delay),
      _details(),
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
    );
  }

  /// Kullanıcı bildirimleri kapatmak isterse hepsini iptal eder.
  Future<void> cancelAll() async => _local.cancelAll();
}
