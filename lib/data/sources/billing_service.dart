import 'dart:async';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:logger/logger.dart';

/// Google Play Billing — Rise Up PRO aboneliği.
/// Play Console'da tanımlanacak ürün ID'leri aşağıdaki sabitlerle eşleşmeli.
class BillingService {
  final InAppPurchase _iap = InAppPurchase.instance;
  final Logger _logger = Logger();

  StreamSubscription<List<PurchaseDetails>>? _sub;

  /// Play Console > Monetize > Subscriptions altında bu ID'lerle ürün oluşturulmalı
  static const String weeklyId = 'riseup_pro_weekly';
  static const String monthlyId = 'riseup_pro_monthly';
  static const Set<String> productIds = {weeklyId, monthlyId};

  bool _available = false;
  List<ProductDetails> products = [];

  /// Satın alma başarılı olunca çağrılır (PRO'yu açmak için)
  void Function(PurchaseDetails)? onPurchaseSuccess;

  /// Mağaza hazır mı, ürünleri yükle ve satın alma akışını dinlemeye başla.
  Future<void> init() async {
    _available = await _iap.isAvailable();
    if (!_available) {
      _logger.w('IAP mağazası kullanılamıyor (emülatör/yapılandırma).');
      return;
    }

    _sub = _iap.purchaseStream.listen(
      _onPurchaseUpdate,
      onError: (e) => _logger.e('Satın alma akışı hatası: $e'),
    );

    final resp = await _iap.queryProductDetails(productIds);
    if (resp.error != null) {
      _logger.e('Ürün sorgu hatası: ${resp.error}');
    }
    products = resp.productDetails;
    _logger.i('${products.length} abonelik ürünü yüklendi.');
  }

  bool get isAvailable => _available;

  /// Belirli bir aboneliği satın al.
  Future<void> buy(ProductDetails product) async {
    final param = PurchaseParam(productDetails: product);
    await _iap.buyNonConsumable(purchaseParam: param);
  }

  /// Önceki satın alımları geri yükle (yeni cihaz / yeniden kurulum).
  Future<void> restore() async {
    await _iap.restorePurchases();
  }

  Future<void> _onPurchaseUpdate(List<PurchaseDetails> purchases) async {
    for (final p in purchases) {
      if (p.status == PurchaseStatus.purchased ||
          p.status == PurchaseStatus.restored) {
        // NOT: Üretimde burada satın alma, Cloud Function ile sunucu tarafında
        // doğrulanmalı (Play Developer API). Şimdilik istemci tarafı kabul.
        onPurchaseSuccess?.call(p);
        _logger.i('Satın alma başarılı: ${p.productID}');
      } else if (p.status == PurchaseStatus.error) {
        _logger.e('Satın alma hatası: ${p.error}');
      }

      if (p.pendingCompletePurchase) {
        await _iap.completePurchase(p);
      }
    }
  }

  void dispose() {
    _sub?.cancel();
  }
}
