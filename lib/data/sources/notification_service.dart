import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'package:logger/logger.dart';

/// Tüm bildirim altyapısı:
///  • Push (Firebase Cloud Messaging) — sunucudan/kampanyadan gelen bildirimler
///  • Yerel zamanlı hatırlatmalar (flutter_local_notifications) — günlük görev
///    ve streak hatırlatması (retention'ın #1 kaldıracı, sunucu gerektirmez)
class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final _local = FlutterLocalNotificationsPlugin();
  final _logger = Logger();
  bool _initialized = false;

  // Bildirim kimlikleri (sabit — yeniden zamanlamada eskisini ezer)
  static const int _dailyTaskId = 1001;
  static const int _streakId = 1002;

  static const _androidChannel = AndroidNotificationChannel(
    'riseup_reminders',
    'Hatırlatmalar',
    description: 'Günlük görev ve streak hatırlatmaları',
    importance: Importance.high,
  );

  /// Uygulama açılışında çağrılır. İzin ister, kanalı kurar, FCM'i bağlar
  /// ve varsayılan günlük hatırlatmaları zamanlar. Hata olursa sessizce geçer.
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
      await androidImpl?.requestNotificationsPermission();
      await androidImpl?.requestExactAlarmsPermission();

      // FCM izni + token (push için)
      await _initFcm();

      // Varsayılan günlük hatırlatmaları kur
      await scheduleDailyReminders();

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
          _showNow(n.title ?? 'Rise Up', n.body ?? '');
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

  /// Her gün tekrar eden 2 hatırlatma kurar:
  ///  • 09:00 — günlük görevler hazır
  ///  • 20:00 — streak'ini kaybetme (gün bitmeden görevleri tamamla)
  Future<void> scheduleDailyReminders() async {
    try {
      await _scheduleDaily(
        id: _dailyTaskId,
        hour: 9,
        minute: 0,
        title: '🔥 Günlük görevlerin hazır',
        body: 'Bugünün planını aç ve serini büyütmeye devam et.',
      );
      await _scheduleDaily(
        id: _streakId,
        hour: 20,
        minute: 0,
        title: '⚠️ Serini kaybetme!',
        body: 'Gün bitmeden bugünkü görevlerini tamamla. Zinciri kırma.',
      );
    } catch (e) {
      _logger.w('Hatırlatma zamanlama atlandı: $e');
    }
  }

  Future<void> _scheduleDaily({
    required int id,
    required int hour,
    required int minute,
    required String title,
    required String body,
  }) async {
    await _local.zonedSchedule(
      id,
      title,
      body,
      _nextInstanceOf(hour, minute),
      _details(),
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      matchDateTimeComponents: DateTimeComponents.time, // her gün tekrarla
    );
  }

  tz.TZDateTime _nextInstanceOf(int hour, int minute) {
    final now = tz.TZDateTime.now(tz.local);
    var scheduled = tz.TZDateTime(
      tz.local,
      now.year,
      now.month,
      now.day,
      hour,
      minute,
    );
    if (scheduled.isBefore(now)) {
      scheduled = scheduled.add(const Duration(days: 1));
    }
    return scheduled;
  }

  /// Kullanıcı bildirimleri kapatmak isterse hepsini iptal eder.
  Future<void> cancelAll() async => _local.cancelAll();
}
