import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/router/dating_routes.dart';
import '../providers/dating_providers.dart';

/// Ayarlar & Gizlilik (Bölüm 9). Politika, şartlar, abonelik, restore,
/// hesap/veri silme, destek. KVKK/GDPR + App Store gerekleri.
class DatingSettingsScreen extends ConsumerWidget {
  const DatingSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pack = ref.watch(packBalanceProvider);
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded,
              size: 18, color: AppColors.textSecondary),
          onPressed: () => context.pop(),
        ),
        title: const Text('Ayarlar',
            style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _section('SATIN ALMALAR'),
          _tile(Icons.workspace_premium_outlined, 'Paket Bakiyem',
              subtitle: (pack.photo > 0 || pack.analysis > 0)
                  ? '${pack.photo} stil · ${pack.analysis} analiz kaldı'
                  : 'Paket yok — ilk çıktı her zaman ücretsiz gösterilir',
              onTap: () => _info(context, 'Paket Bakiyem',
                  'AI foto üretimi: ${pack.photo} stil hakkı\nFotoğraf analizi: ${pack.analysis} analiz hakkı\n\nAbonelik yoktur; ihtiyacın kadar tek seferlik paket alırsın.')),
          _tile(Icons.shopping_bag_outlined, 'Paket Al',
              onTap: () => context.push(DatingRoutes.paywall)),
          _tile(Icons.restore_rounded, 'Satın Alımları Geri Yükle',
              onTap: () async {
            await ref.read(entitlementProvider.notifier).restore();
            await ref.read(datingPurchaseServiceProvider).restore();
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text('Satın alımlar kontrol edildi.')));
            }
          }),

          const SizedBox(height: 20),
          _section('GİZLİLİK & YASAL'),
          _tile(Icons.privacy_tip_outlined, 'Gizlilik Politikası',
              onTap: () => _policySheet(context, _privacyText)),
          _tile(Icons.description_outlined, 'Kullanım Şartları',
              onTap: () => _policySheet(context, _termsText)),
          _tile(Icons.info_outline_rounded, 'Veri İşleme Aydınlatması',
              onTap: () => _policySheet(context, _dataText)),

          const SizedBox(height: 20),
          _section('HESAP'),
          _tile(Icons.support_agent_outlined, 'Destek / İletişim',
              subtitle: 'destek@voxenai.app',
              onTap: () => _info(context, 'Destek',
                  'Her türlü soru için: destek@voxenai.app')),
          _tile(Icons.delete_forever_outlined, 'Hesabımı ve Verilerimi Sil',
              danger: true,
              onTap: () => _confirmDelete(context, ref)),

          // GEÇİCİ GELİŞTİRİCİ ARACI — model A/B karşılaştırması.
          // Karşılaştırma bitip bir modele karar verilince BU BLOK,
          // ModelBakeoffScreen, DatingRoutes.modelBakeoff rotası ve
          // functions/modelBakeoff.js silinmeli.
          _section('GELİŞTİRİCİ (geçici)'),
          _tile(Icons.science_outlined, 'Model Karşılaştırma Testi',
              subtitle: '4 modelden 5\'er foto üretir (~\$1.45, paket harcamaz)',
              onTap: () => context.push(DatingRoutes.modelBakeoff)),

          const SizedBox(height: 24),
          const Center(
            child: Text('VOXEN AI · v1.0.0',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
          const SizedBox(height: 8),
          const Center(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                'Grafik ve istatistikler temsilidir; kesin ölçüm değildir.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10, color: AppColors.textMuted),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 8, 4, 10),
        child: Text(t,
            style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
                letterSpacing: 1,
                color: AppColors.textSecondary)),
      );

  Widget _tile(IconData icon, String title,
      {String? subtitle, VoidCallback? onTap, bool danger = false}) {
    final color = danger ? AppColors.error : AppColors.textPrimary;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: [
            Icon(icon,
                color: danger ? AppColors.error : AppColors.gold, size: 22),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: color)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle,
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textMuted)),
                  ],
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded,
                color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }

  void _info(BuildContext context, String title, String body) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        title: Text(title,
            style: const TextStyle(color: AppColors.textPrimary)),
        content: Text(body,
            style: const TextStyle(color: AppColors.textSecondary)),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Tamam',
                  style: TextStyle(color: AppColors.gold))),
        ],
      ),
    );
  }

  void _policySheet(BuildContext context, String text) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        builder: (_, controller) => SingleChildScrollView(
          controller: controller,
          padding: const EdgeInsets.all(20),
          child: Text(text,
              style: const TextStyle(
                  fontSize: 13,
                  color: AppColors.textSecondary,
                  height: 1.5)),
        ),
      ),
    );
  }

  void _confirmDelete(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceElevated,
        title: const Text('Hesabını sil?',
            style: TextStyle(color: AppColors.textPrimary)),
        content: const Text(
            'Paket bakiyen, ürettiğin fotoğraflar ve tüm verilerin kalıcı '
            'olarak silinir. Bu işlem geri alınamaz.',
            style: TextStyle(color: AppColors.textSecondary)),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Vazgeç',
                  style: TextStyle(color: AppColors.textSecondary))),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              showDialog<void>(
                context: context,
                barrierDismissible: false,
                builder: (ctx) => const PopScope(
                  canPop: false,
                  child: AlertDialog(
                    backgroundColor: AppColors.surfaceElevated,
                    content: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircularProgressIndicator(color: AppColors.gold),
                        SizedBox(height: 18),
                        Text(
                          'Hesabın ve verilerin siliniyor…',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 14,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
              try {
                await ref.read(entitlementProvider.notifier).deleteAccount();
                if (context.mounted) {
                  Navigator.pop(context);
                  context.go(DatingRoutes.onboarding);
                }
              } catch (_) {
                if (context.mounted) {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text(
                        'Silme işlemi tamamlanamadı. Lütfen tekrar dene.'),
                  ));
                }
              }
            },
            child: const Text('Sil',
                style: TextStyle(
                    color: AppColors.error, fontWeight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }

  static const String _privacyText =
      'GİZLİLİK POLİTİKASI\n\n'
      'VOXEN AI, hizmetleri sunmak için fotoğraf ve profil bilgilerini '
      'işler. Fotoğraflarınız yalnızca analiz ve AI fotoğraf üretimi amacıyla '
      'işlenir.\n\n'
      '• Toplanan veriler: fotoğraflar, kullanım verisi, satın alma bilgisi.\n'
      '• İşleme amacı: AI foto üretimi, fotoğraf analizi, looksmaxxing önerileri, '
      'coach/rizz/bio yardımcıları.\n'
      '• Üçüncü taraf işleme: AI üretimi/analizi harici model sağlayıcılarına '
      '(ör. fal.ai, Google Gemini) iletilebilir; yalnızca işlem için kullanılır.\n'
      '• Saklama: Ürettiğiniz içerik hesabınızda saklanır; istediğinizde '
      'silebilirsiniz.\n'
      '• Haklarınız (KVKK/GDPR): erişim, düzeltme, silme. "Hesabımı ve '
      'Verilerimi Sil" ile tüm verileriniz kalıcı silinir.\n\n'
      'Grafik ve istatistikler temsilidir; kesin ölçüm değildir.';

  static const String _termsText =
      'KULLANIM ŞARTLARI\n\n'
      '• Uygulama 18 yaş ve üzeri kullanıcılar içindir.\n'
      '• Yalnızca kendinize ait fotoğrafları yükleyebilirsiniz.\n'
      '• Üretilen içerik yasa dışı, aldatıcı veya başkasını taklit edecek '
      'şekilde kullanılamaz.\n'
      '• Abonelikler seçtiğiniz dönem sonunda otomatik yenilenir; App Store / '
      'Google Play üzerinden iptal edilebilir.\n'
      '• Looksmaxxing önerileri yapıcı rehberliktir; tıbbi tavsiye değildir.';

  static const String _dataText =
      'VERİ İŞLEME AYDINLATMASI\n\n'
      'Fotoğraf yüklediğinizde, bu görseller yalnızca seçtiğiniz işlemi '
      '(AI üretim / analiz) gerçekleştirmek için işlenir. İşlem tamamlandıktan '
      'sonra kaynak fotoğraflar sonuçları üretmek dışında kullanılmaz.\n\n'
      'Fotoğraflarınızın işlenmesine başlamadan önce açık rızanız alınır. '
      'Rızanızı dilediğiniz an geri çekebilir ve verilerinizi silebilirsiniz.';
}
