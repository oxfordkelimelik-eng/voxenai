import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import 'dating_widgets.dart' show PrimaryButton;

/// ÜÇÜNCÜ TARAF AI VERİ PAYLAŞIMI — AÇIK RIZA KAPISI
///
/// App Store Review 5.1.1(i) / 5.1.2(i) (2026-08-19 reddi) uygulamanın, kişisel
/// veriyi bir üçüncü taraf AI servisine GÖNDERMEDEN ÖNCE şunları yapmasını
/// zorunlu kılıyor:
///   • hangi verinin gönderileceğini açıkça söylemek,
///   • verinin KİME gönderildiğini isim vererek belirtmek,
///   • kullanıcının iznini almak.
/// Apple ayrıca "bu bilgiyi yalnızca Gizlilik Politikası'na koymak YETERLİ
/// DEĞİLDİR" diyor — bu yüzden onay, fotoğrafların yüklendiği anın hemen
/// öncesinde, uygulama içinde ve açık bir eylemle alınıyor.
///
/// Onay akış başına bir kez alınır ve saklanır; kullanıcı Ayarlar >
/// "Yapay Zekâ Veri Paylaşımı" ekranından dilediği an geri çekebilir
/// (bkz. showAiDataSharingSettings).
enum AiFlowKind {
  /// AI dating fotoğrafı üretimi — canlı selfie'ler.
  photoGeneration,

  /// Fotoğraf analizi & seçimi — kullanıcının seçtiği fotoğraflar.
  photoAnalysis,

  /// RizzGPT — sohbet ya da eşleşme profili ekran görüntüsü (üçüncü kişinin mesajlarını içerir).
  chatReply,

  /// Profil Doktoru — kullanıcının KENDİ dating profilinin ekran görüntüleri (kendi fotoğrafları dahil).
  profileReview,
}

String _prefsKeyFor(AiFlowKind kind) => switch (kind) {
      AiFlowKind.photoGeneration => DatingKeys.aiConsentPhoto,
      AiFlowKind.photoAnalysis => DatingKeys.aiConsentAnalysis,
      AiFlowKind.chatReply => DatingKeys.aiConsentChat,
      AiFlowKind.profileReview => DatingKeys.aiConsentProfile,
    };

/// Fotoğraflar gönderilmeden ÖNCE çağrılır. Kullanıcı daha önce bu akış için
/// onay verdiyse doğrudan `true` döner; vermediyse açıklama sayfası gösterilir.
/// `false` dönerse çağıran taraf HİÇBİR veri göndermemelidir.
Future<bool> ensureAiProcessingConsent(
  BuildContext context, {
  required AiFlowKind kind,
}) async {
  final prefs = await SharedPreferences.getInstance();
  final key = _prefsKeyFor(kind);
  if (prefs.getBool(key) ?? false) return true;
  if (!context.mounted) return false;

  final approved = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: AppColors.surface,
    isScrollControlled: true,
    // Açık bir seçim yapılmadan kapatılamaz — "izin alındı" iddiasının
    // kazara bir dokunuşla değil, bilinçli bir eylemle karşılanması için.
    isDismissible: false,
    enableDrag: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
    ),
    builder: (_) => _AiConsentSheet(kind: kind),
  );

  if (approved != true) return false;
  await prefs.setBool(key, true);
  return true;
}

/// Ayarlar ekranı için: aynı açıklamayı gösterir ve rızayı geri çekmeye izin
/// verir. Rıza geri çekilirse bir sonraki üretim/analiz denemesinde onay
/// ekranı yeniden çıkar.
Future<void> showAiDataSharingSettings(BuildContext context) async {
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: AppColors.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
    ),
    builder: (_) => const _AiConsentSheet(kind: null),
  );
}

class _AiConsentSheet extends StatelessWidget {
  /// null → Ayarlar'dan açıldı (bilgi + rıza geri çekme modu).
  final AiFlowKind? kind;
  const _AiConsentSheet({required this.kind});

  bool get _isSettingsMode => kind == null;

  String get _whatIsSent => switch (kind) {
        AiFlowKind.photoGeneration =>
          'Çektiğin ${DatingConfig.faceCaptureCount} yüz fotoğrafı '
              '(ön, sağa ve sola dönük açılar, çene aşağı); yüz analizi, sahne kompozisyonu, ön işleme ve '
              'kalite kontrolden geçirildikten sonra işlenmek üzere OpenAI '
              'altyapısına iletilir.',
        AiFlowKind.photoAnalysis =>
          'Analiz için seçtiğin fotoğraflar, çok kriterli skorlama '
              'modelimiz üzerinden işlenmek üzere OpenAI altyapısına '
              'iletilir.',
        AiFlowKind.chatReply =>
          'Seçtiğin sohbet ya da profil ekran görüntüleri, yazdığın kısa '
              'not ve başta seçtiğin cinsiyet (yalnız cevapta kendinden '
              'doğru söz edilsin diye), cevap önerisi ve Sohbet Röntgeni '
              '(karşı tarafın ekranda görünen mesaj davranışından anlık ilgi '
              've emek değerlendirmesi ile dolandırıcılık risk işaretleri) '
              'üretmek için OpenAI\'a iletilir.',
        AiFlowKind.profileReview =>
          'Seçtiğin kendi profil ekran görüntülerin (profil fotoğrafların ve '
              'yazıların), seçtiğin hedef ve notun, profil önerileri üretmek '
              'için OpenAI\'a iletilir. Fotoğrafların yalnızca fotoğraf '
              'niteliği (ışık, kadraj, ifade) açısından yorumlanır; görünüşün '
              'değerlendirilmez.',
        null =>
          'Foto üretiminde çektiğin yüz fotoğrafları ile foto '
              'analizinde seçtiğin fotoğraflar; kompozisyon, kalite kontrolü '
              've skorlama içeren işleme hatlarımızdan geçirilip OpenAI '
              'altyapısına iletilir. RizzGPT\'de seçtiğin sohbet/profil ekran '
              'görüntüleri ve notun cevap önerisi ve Sohbet Röntgeni (ilgi/emek '
              'tahmini, dolandırıcılık risk işaretleri) için; Profil Doktoru\'nda '
              'seçtiğin kendi profil ekran görüntülerin profil önerisi için '
              'OpenAI\'a iletilir.',
      };

  bool get _isChat => kind == AiFlowKind.chatReply;

  /// Ekran görüntüsü akışları (RizzGPT, Profil Doktoru): hiçbir yere kaydedilmez, Firebase'e yazılmaz.
  bool get _isShot => _isChat || kind == AiFlowKind.profileReview;

  Future<void> _openPolicy() async {
    final uri = Uri.parse(DatingConfig.privacyPolicyUrl);
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // Tarayıcı açılamazsa sessiz geç — metnin tamamı zaten bu sayfada.
    }
  }

  Future<void> _withdraw(BuildContext context) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(DatingKeys.aiConsentPhoto);
    await prefs.remove(DatingKeys.aiConsentAnalysis);
    await prefs.remove(DatingKeys.aiConsentChat);
    await prefs.remove(DatingKeys.aiConsentChatLegacy);
    await prefs.remove(DatingKeys.aiConsentProfile);
    if (!context.mounted) return;
    Navigator.pop(context);
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content: Text(
          'Rızan geri çekildi. Yeniden onay vermeden hiçbir görsel gönderilmeyecek.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            22, 14, 22, 18 + MediaQuery.of(context).padding.bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.borderSubtle,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              const Icon(Icons.privacy_tip_outlined,
                  color: AppColors.gold, size: 40),
              const SizedBox(height: 14),
              Text(
                _isSettingsMode
                    ? 'Veri Paylaşımı'
                    : _isChat
                        ? 'Ekran görüntün gönderilecek'
                        : kind == AiFlowKind.profileReview
                        ? 'Profil ekran görüntülerin gönderilecek'
                        : 'Fotoğrafların gönderilecek',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 19,
                    fontWeight: FontWeight.w900,
                    color: AppColors.textPrimary,
                    height: 1.3),
              ),
              const SizedBox(height: 8),
              Text(
                _isSettingsMode
                    ? 'Fotoğraflarının kime, ne için gönderildiği aşağıda '
                        'açıklanmıştır.'
                    : 'Devam etmeden önce ne gönderildiğini bilmeni '
                        'istiyoruz.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
                    height: 1.45),
              ),
              const SizedBox(height: 22),
              _Row(
                icon: Icons.photo_library_outlined,
                title: 'Ne gönderiliyor, kime?',
                body: _isShot
                    ? _whatIsSent
                    : '$_whatIsSent\nFirebase, işlem sürerken geçici '
                        'depolama için kullanılır (altyapı sağlayıcımız).',
              ),
              const _Divider(),
              _Row(
                icon: Icons.lock_clock_outlined,
                title: 'Ne kadar saklanıyor?',
                body: _isShot
                    ? 'Ekran görüntülerin ve notun sunucularımıza kaydedilmez; '
                        'yalnızca öneri üretilirken işlenir. OpenAI, kötüye '
                        'kullanımı önlemek için gelen istekleri en fazla 30 gün '
                        'tutabilir ve bunları model eğitiminde kullanmaz.'
                    : 'Kaynak fotoğrafların, işlem biter bitmez (başarılı ya '
                        'da başarısız fark etmeksizin) sunucularımızdan kalıcı '
                        'olarak silinir. Üretilen sonuçlar yalnızca sen silene '
                        'kadar hesabında kalır.',
              ),
              if (_isChat) ...[
                const _Divider(),
                const _Row(
                  icon: Icons.people_outline_rounded,
                  title: 'Karşı tarafın bilgileri',
                  body: 'Ekran görüntüsü karşındaki kişinin mesajlarını, adını '
                      'ya da fotoğrafını içerebilir. Yalnızca paylaşmaya hakkın '
                      'olan içerik gönder; göndermeden önce isim ve '
                      'fotoğrafı kırp, telefon numarası ya da adres gibi '
                      'bilgileri hiç gönderme. Sohbet Röntgeni yalnızca ekranda '
                      'görünen mesajlardan o an sana gösterilen bir tahmindir; '
                      'saklanmaz ve bu kişi hakkında kalıcı profil oluşturulmaz.',
                ),
              ],
              if (kind == AiFlowKind.profileReview) ...[
                const _Divider(),
                const _Row(
                  icon: Icons.people_outline_rounded,
                  title: 'Fotoğraflardaki diğer kişiler',
                  body: 'Grup fotoğraflarında arkadaşların da görünebilir. '
                      'Onlar değerlendirilmez, tarif edilmez ve saklanmaz; '
                      'yalnızca "grup fotoğrafı" olarak anılır.',
                ),
              ],
              const _Divider(),
              const _Row(
                icon: Icons.block_rounded,
                title: 'Ne YAPILMIYOR?',
                body: 'Fotoğrafların yüz tanıma, kimlik doğrulama veya '
                    'herhangi bir biyometrik veritabanıyla eşleştirme için '
                    'KULLANILMAZ. Satılmaz, reklam/pazarlama amacıyla '
                    'kullanılmaz.',
              ),
              const SizedBox(height: 18),
              GestureDetector(
                onTap: _openPolicy,
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.open_in_new_rounded,
                        size: 14, color: AppColors.gold),
                    SizedBox(width: 6),
                    Text('Gizlilik Politikası\'nın tamamını oku',
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: AppColors.gold)),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              if (_isSettingsMode) ...[
                PrimaryButton(
                  label: 'Kapat',
                  onPressed: () => Navigator.pop(context),
                ),
                const SizedBox(height: 6),
                TextButton(
                  onPressed: () => _withdraw(context),
                  child: const Text('Rızamı geri çek',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: AppColors.error)),
                ),
              ] else ...[
                PrimaryButton(
                  label: 'Onaylıyorum, Devam Et',
                  onPressed: () => Navigator.pop(context, true),
                ),
                const SizedBox(height: 6),
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Vazgeç',
                      style: TextStyle(
                          fontSize: 13, color: AppColors.textSecondary)),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  const _Row({required this.icon, required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppColors.gold, size: 19),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textPrimary)),
              const SizedBox(height: 4),
              Text(body,
                  style: const TextStyle(
                      fontSize: 12.5,
                      color: AppColors.textSecondary,
                      height: 1.45)),
            ],
          ),
        ),
      ],
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Divider(height: 1, color: AppColors.borderSubtle),
      );
}
