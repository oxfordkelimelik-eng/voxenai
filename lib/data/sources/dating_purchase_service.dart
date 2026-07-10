import 'dart:async';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:logger/logger.dart';
import '../../core/constants/dating_constants.dart';

/// Dating paketleri (tek seferlik, tüketilebilir) için Google Play / App
/// Store satın alma servisi. `BillingService` (Rise Up aboneliği,
/// non-consumable) ile karıştırılmamalı — bu servis `buyConsumable` kullanır
/// çünkü paketler tekrar tekrar satın alınabilir.
///
/// Akış: buy() → mağaza satın alma akışı → purchaseStream → sunucu tarafı
/// doğrulama (`verifyPurchase` Cloud Function, App Store/Play API ile
/// gerçek makbuz kontrolü + Firestore wallet güncellemesi) → yalnızca
/// doğrulama başarılı olduktan SONRA completePurchase() çağrılır (aksi
/// halde doğrulama geçici olarak başarısız olursa makbuz kaybolabilir).
class DatingPurchaseService {
  final InAppPurchase _iap = InAppPurchase.instance;
  final Logger _logger = Logger();

  StreamSubscription<List<PurchaseDetails>>? _sub;

  static const Set<String> productIds = {
    DatingConfig.analysisSingleProductId,
    DatingConfig.analysisStandardProductId,
    DatingConfig.photoStandardProductId,
    DatingConfig.photoPremiumProductId,
  };

  bool _available = false;
  List<ProductDetails> products = [];

  /// Bir satın alma sunucu tarafında doğrulanıp tamamlanınca çağrılır.
  void Function(PurchaseDetails)? onPurchaseVerified;

  /// Bir satın alma hata/iptal ile sonuçlanınca çağrılır.
  void Function(PurchaseDetails)? onPurchaseError;

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
    _logger.i('${products.length} dating paketi ürünü yüklendi.');
  }

  bool get isAvailable => _available;

  ProductDetails? productFor(String id) =>
      products.where((p) => p.id == id).firstOrNull;

  Future<void> buy(ProductDetails product) async {
    final param = PurchaseParam(productDetails: product);
    await _iap.buyConsumable(purchaseParam: param);
  }

  Future<void> restore() async {
    await _iap.restorePurchases();
  }

  Future<void> _onPurchaseUpdate(List<PurchaseDetails> purchases) async {
    for (final p in purchases) {
      if (p.status == PurchaseStatus.purchased ||
          p.status == PurchaseStatus.restored) {
        final verified = await _verifyOnServer(p);
        if (verified) {
          onPurchaseVerified?.call(p);
          _logger.i('Satın alma doğrulandı: ${p.productID}');
          if (p.pendingCompletePurchase) {
            await _iap.completePurchase(p);
          }
        } else {
          // Doğrulama başarısız — makbuzu TAMAMLAMIYORUZ, mağaza sonraki
          // açılışta tekrar teslim etsin diye (geçici sunucu hatası olabilir).
          onPurchaseError?.call(p);
          _logger.e('Satın alma doğrulanamadı: ${p.productID}');
        }
      } else if (p.status == PurchaseStatus.error) {
        onPurchaseError?.call(p);
        _logger.e('Satın alma hatası: ${p.error}');
        if (p.pendingCompletePurchase) {
          await _iap.completePurchase(p);
        }
      } else if (p.status == PurchaseStatus.canceled) {
        onPurchaseError?.call(p);
        if (p.pendingCompletePurchase) {
          await _iap.completePurchase(p);
        }
      }
    }
  }

  /// `verifyPurchase` Cloud Function'ını çağırır — Apple/Google makbuzunu
  /// sunucu tarafında doğrular ve başarılıysa Firestore wallet'ı günceller.
  Future<bool> _verifyOnServer(PurchaseDetails p) async {
    try {
      final platform = p.verificationData.source; // 'google_play' | 'app_store'
      final result = await FirebaseFunctions.instanceFor(region: 'europe-west1')
          .httpsCallable('verifyPurchase')
          .call({
        'platform': platform == 'app_store' ? 'ios' : 'android',
        'productId': p.productID,
        'purchaseToken': p.verificationData.serverVerificationData,
      });
      return result.data?['success'] == true;
    } catch (e) {
      _logger.e('verifyPurchase çağrısı başarısız: $e');
      return false;
    }
  }

  void dispose() {
    _sub?.cancel();
  }
}
