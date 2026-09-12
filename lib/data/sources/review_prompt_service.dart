import 'package:in_app_review/in_app_review.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:logger/logger.dart';
import '../../core/constants/dating_constants.dart';

/// Apple'ın SKStoreReviewController / Android In-App Review API'sini
/// tetikler — kullanıcı uygulamadan hiç çıkmadan App Store/Play Store'a
/// yıldız verebilir.
///
/// NEDEN BÖYLE: Apple'ın App Store Review Guidelines 5.6.3'ü, kullanıcıyı
/// belirli bir puana yönlendirmeyi veya önceden seçilmiş yıldızla bir ekran
/// göstermeyi YASAKLAR — bu ret sebebidir. Bu yüzden burada özel bir "5
/// yıldız ver" ekranı YOK, yalnızca Apple/Google'ın kendi resmi, tarafsız
/// pop-up'ı çağrılıyor. Bu pop-up boş gelir, kullanıcı kendi yıldızını seçer.
///
/// Apple'ın kendisi bu pop-up'ın YILDA EN FAZLA 3 KEZ gösterilmesini
/// zaten kendi tarafında sınırlıyor (bizim kontrolümüzde değil) — burada
/// tuttuğumuz `reviewPromptShown` bayrağı ayrı bir katman: "biz zaten bir
/// kez ÇAĞIRDIK, tekrar çağırmaya gerek yok" bilgisini taşır. Kullanıcı
/// puan verdi mi vermedi mi bilgisini API bize DÖNMEZ (gizlilik gereği) —
/// bu yüzden "puanlamamışsa" sorusunu cevaplayamayız, sadece "daha önce
/// hiç sormadık mı" sorusunu cevaplarız.
class ReviewPromptService {
  final Logger _logger = Logger();
  final InAppReview _inAppReview;

  ReviewPromptService({InAppReview? inAppReview})
    : _inAppReview = inAppReview ?? InAppReview.instance;

  /// Başarılı bir üretim/analiz sonucunun gösterildiği an çağrılır —
  /// kullanıcının deneyimden en memnun olduğu nokta (Apple'ın kendi
  /// rehberi de "doruk anı" için bu tür yerleri öneriyor).
  ///
  /// Daha önce hiç çağrılmadıysa VE cihaz destekliyorsa pop-up'ı tetikler.
  /// Hata sessizce yutulur — bu ikincil bir özellik, ana akışı bloklamamalı.
  Future<void> maybePromptAfterSuccess() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool(DatingKeys.reviewPromptShown) == true) return;

      final isAvailable = await _inAppReview.isAvailable();
      if (!isAvailable) return;

      // Bayrağı ÇAĞRIMADAN ÖNCE yaz: requestReview() bir Future döner ama
      // pop-up'ın gerçekten görünüp görünmediğini bildirmez (Apple/Google
      // kendi sınırına göre sessizce atlayabilir) — "bir daha deneme"
      // niyeti, gösterimin kendisinden değil ÇAĞRI girişiminden gelir.
      await prefs.setBool(DatingKeys.reviewPromptShown, true);
      await _inAppReview.requestReview();
    } catch (e) {
      _logger.w('ReviewPromptService: pop-up tetiklenemedi: $e');
    }
  }
}
