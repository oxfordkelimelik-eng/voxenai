import 'package:app_tracking_transparency/app_tracking_transparency.dart';
import 'package:facebook_app_events/facebook_app_events.dart';
import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:logger/logger.dart';

/// Meta (Facebook) Ads — satış/ROAS ölçümü için App Events.
///
/// iOS'ta ATT izni verilmeden event'ler kişi bazlı eşlenemez, yalnızca
/// SKAdNetwork üzerinden agregatif gider — bu yüzden izin akışı SDK init'ten
/// önce çalıştırılır.
class MetaEventsService {
  MetaEventsService._();
  static final MetaEventsService instance = MetaEventsService._();

  final FacebookAppEvents _events = FacebookAppEvents();
  final Logger _logger = Logger();

  Future<void> init() async {
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      await _requestAttIfNeeded();
    }
    // ATT sonucundan bağımsız olarak SDK başlatılır: izin verilmezse Meta
    // SDK zaten yalnızca agregatif (SKAdNetwork) veri gönderir.
    await _events.setAutoLogAppEventsEnabled(true);
    await _events.setAdvertiserTracking(enabled: true);
  }

  Future<void> _requestAttIfNeeded() async {
    try {
      final status = await AppTrackingTransparency.trackingAuthorizationStatus;
      if (status == TrackingStatus.notDetermined) {
        // Sistem prompt'undan hemen önce kısa bir çerçeve bekletmek Apple'ın
        // önerdiği pratiktir (ekran geçişiyle çakışmasın diye).
        await Future.delayed(const Duration(milliseconds: 200));
        await AppTrackingTransparency.requestTrackingAuthorization();
      }
    } catch (e) {
      _logger.w('ATT izin isteği başarısız: $e');
    }
  }

  /// Satın alma sunucu tarafında DOĞRULANDIKTAN sonra çağrılmalı.
  /// [valueUsd]: ürünün USD karşılığı (ROAS hesaplaması için Meta bunu bekler).
  Future<void> logPurchase({
    required double valueUsd,
    required String currency,
    required String productId,
  }) async {
    try {
      await _events.logPurchase(
        amount: valueUsd,
        currency: currency,
        parameters: {'product_id': productId},
      );
      _logger.i('Meta logPurchase gönderildi: $productId $valueUsd $currency');
    } catch (e) {
      _logger.e('Meta logPurchase hata: $e');
    }
  }

  Future<void> logCompletedRegistration() async {
    try {
      await _events.logCompletedRegistration();
    } catch (e) {
      _logger.e('Meta logCompletedRegistration hata: $e');
    }
  }

  /// ProductDetails.rawPrice zaten cihazın mağaza para birimindeki tutardır;
  /// Meta, farklı para birimlerini kendi tarafında USD'ye çevirir — bu yüzden
  /// ham fiyatı ve mağaza para birimini olduğu gibi göndermek yeterlidir.
  Future<void> logPurchaseFromProduct(ProductDetails product) {
    return logPurchase(
      valueUsd: product.rawPrice,
      currency: product.currencyCode,
      productId: product.id,
    );
  }
}
