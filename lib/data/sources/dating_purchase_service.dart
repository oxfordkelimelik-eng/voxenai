import 'dart:async';
import 'dart:convert';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:logger/logger.dart';
import '../../core/constants/dating_constants.dart';

/// Dating paketleri (tek seferlik, tüketilebilir) için Google Play / App
/// Store satın alma servisi.
///
/// Akış: buy() → mağaza → purchaseStream → sunucu doğrulama
/// (`verifyPurchase`) → yalnızca doğrulama OK ise completePurchase().
class DatingPurchaseService {
  final InAppPurchase _iap = InAppPurchase.instance;
  final Logger _logger = Logger();

  StreamSubscription<List<PurchaseDetails>>? _sub;

  /// Aynı satın alma (purchaseID) için sunucu doğrulamasının birden çok kez
  /// eş zamanlı başlatılmasını engeller (mağaza aynı satın almayı birden
  /// fazla event olarak yeniden gönderebilir — bkz. _onPurchaseUpdate).
  final Set<String> _verifying = {};
  final Set<String> _handled = {};

  static const Set<String> productIds = {
    DatingConfig.analysisSingleProductId,
    DatingConfig.analysisStandardProductId,
    DatingConfig.photoStandardProductId,
    DatingConfig.photoPremiumProductId,
  };

  bool _available = false;
  List<ProductDetails> products = [];

  void Function(PurchaseDetails)? onPurchaseVerified;
  void Function(PurchaseDetails)? onPurchaseError;

  Future<void> init() async {
    _available = await _iap.isAvailable();
    if (!_available) {
      _logger.w('IAP mağazası kullanılamıyor (emülatör/yapılandırma).');
      return;
    }

    _sub ??= _iap.purchaseStream.listen(
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

  /// Ürünü satın alır ve sunucu doğrulamasını bekler.
  /// Bir kez başarı olduktan sonra gelen hata event'leri yok sayılır
  /// (iOS aynı satın alma için birden fazla event gönderebilir).
  Future<bool> purchaseAndWait(String productId) async {
    if (!_available) await init();
    final product = productFor(productId);
    if (product == null) {
      _logger.e('Ürün bulunamadı: $productId');
      return false;
    }

    final completer = Completer<bool>();
    var succeeded = false;

    void onVerified(PurchaseDetails p) {
      if (p.productID != productId) return;
      succeeded = true;
      if (!completer.isCompleted) completer.complete(true);
    }

    void onError(PurchaseDetails p) {
      if (p.productID != productId) return;
      if (succeeded) {
        _logger.w('Başarı sonrası hata event yok sayıldı: ${p.productID}');
        return;
      }
      if (!completer.isCompleted) completer.complete(false);
    }

    final prevVerified = onPurchaseVerified;
    final prevError = onPurchaseError;
    onPurchaseVerified = onVerified;
    onPurchaseError = onError;
    try {
      await buy(product);
      return await completer.future.timeout(
        const Duration(minutes: 3),
        onTimeout: () => succeeded,
      );
    } catch (e) {
      _logger.e('purchaseAndWait hata: $e');
      return succeeded;
    } finally {
      onPurchaseVerified = prevVerified;
      onPurchaseError = prevError;
    }
  }

  /// Bir PurchaseDetails'i tekil olarak tanımlayan anahtar (dedup için).
  /// purchaseID bazı platformlarda/timing'lerde boş olabileceğinden
  /// serverVerificationData'ya düşer — aynı işlem için her zaman aynıdır.
  String _purchaseKey(PurchaseDetails p) =>
      p.purchaseID?.isNotEmpty == true
          ? p.purchaseID!
          : '${p.productID}:${p.verificationData.serverVerificationData}';

  Future<void> _onPurchaseUpdate(List<PurchaseDetails> purchases) async {
    for (final p in purchases) {
      if (p.status == PurchaseStatus.purchased ||
          p.status == PurchaseStatus.restored) {
        final key = _purchaseKey(p);
        // Mağaza aynı satın almayı birden fazla event olarak yeniden
        // gönderebilir — zaten sonuçlanmış veya doğrulanmakta olan bir
        // işlemi tekrar işlemeye çalışmayı engelle (çapraz "başarılı/
        // başarısız" event'lerinin birbirini ezmesinin asıl nedeni buydu).
        if (_handled.contains(key) || _verifying.contains(key)) continue;
        _verifying.add(key);
        bool verified;
        try {
          verified = await _verifyOnServer(p);
        } finally {
          _verifying.remove(key);
        }
        _handled.add(key);
        if (verified) {
          onPurchaseVerified?.call(p);
          _logger.i('Satın alma doğrulandı: ${p.productID}');
          if (p.pendingCompletePurchase) {
            await _iap.completePurchase(p);
          }
        } else {
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

  /// iOS StoreKit 2: serverVerificationData çoğu zaman JWS olur;
  /// App Store Server API transactionId ister.
  String _appleTransactionId(PurchaseDetails p) {
    final id = p.purchaseID;
    if (id != null && id.isNotEmpty && !id.contains('.')) return id;

    final raw = p.verificationData.serverVerificationData;
    final parts = raw.split('.');
    if (parts.length >= 2) {
      try {
        final payload = utf8.decode(base64Url.decode(_padBase64(parts[1])));
        final map = jsonDecode(payload) as Map<String, dynamic>;
        final tx = map['transactionId'] as String?;
        if (tx != null && tx.isNotEmpty) return tx;
        final orig = map['originalTransactionId'] as String?;
        if (orig != null && orig.isNotEmpty) return orig;
      } catch (e) {
        _logger.w('JWS decode başarısız: $e');
      }
    }
    return id ?? raw;
  }

  static String _padBase64(String input) {
    final rem = input.length % 4;
    if (rem == 0) return input;
    return input + ('=' * (4 - rem));
  }

  Future<bool> _verifyOnServer(PurchaseDetails p) async {
    try {
      final source = p.verificationData.source;
      final isIos = source == 'app_store' || source.contains('app_store');
      final token = isIos
          ? _appleTransactionId(p)
          : p.verificationData.serverVerificationData;

      _logger.i(
          'verifyPurchase → ${p.productID} ${isIos ? 'ios' : 'android'} '
          'tokenLen=${token.length}');

      final result = await FirebaseFunctions.instanceFor(region: 'europe-west1')
          .httpsCallable('verifyPurchase')
          .call({
        'platform': isIos ? 'ios' : 'android',
        'productId': p.productID,
        'purchaseToken': token,
      });
      return result.data?['success'] == true;
    } on FirebaseFunctionsException catch (e) {
      _logger.e('verifyPurchase CF hata: ${e.code} ${e.message}');
      return false;
    } catch (e) {
      _logger.e('verifyPurchase çağrısı başarısız: $e');
      return false;
    }
  }

  void dispose() {
    _sub?.cancel();
    _sub = null;
  }
}
