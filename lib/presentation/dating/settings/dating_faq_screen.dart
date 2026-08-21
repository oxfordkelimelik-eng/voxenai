import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';

/// Sık Sorulan Sorular — "Bize Ulaşın" sekmesinden açılır.
/// Ayarlar ekranıyla aynı tasarım dilini kullanır (kart + kırmızı vurgu).
class DatingFaqScreen extends StatelessWidget {
  const DatingFaqScreen({super.key});

  static final List<_FaqCategory> _categories = [
    _FaqCategory('PAKETLER & ÖDEME', [
      _FaqItem(
        'Uygulamanın abonelik ücreti var mı?',
        'Hayır. VOXEN AI\'da abonelik yok. İlk çıktı (ilk fotoğraf / ilk analiz) '
            'her zaman ücretsiz gösterilir; devamını görmek istersen tek '
            'seferlik bir paket satın alırsın. Otomatik yenileme yapılmaz.',
      ),
      _FaqItem(
        'Paketler neler?',
        'AI Foto Üretimi: Standart paket ${DatingConfig.photoStandardPhotos} '
            'fotoğraf (1 stil), Premium paket '
            '${DatingConfig.photoPremiumPhotos} fotoğraf (5 stil).\n\n'
            'Fotoğraf Analizi: Tekli ${DatingConfig.analysisSingleRuns} '
            'analiz, Standart ${DatingConfig.analysisStandardRuns} analiz.\n\n'
            'Güncel fiyatlar "Paket Al" ekranında, kendi ülkenin para '
            'biriminde gösterilir.',
      ),
      _FaqItem(
        'Satın aldığım paketin hakları bitmezse ne olur?',
        'Paket hakların hesabında kalıcı olarak durur, süresi dolmaz. '
            'İstediğin zaman kullanabilirsin; kalan hakkını Ayarlar > '
            '"Paket Bakiyem" üzerinden görebilirsin.',
      ),
      _FaqItem(
        'Yanlışlıkla iki kere ödeme yaptım / satın alımım görünmüyor, ne yapmalıyım?',
        'Ayarlar ekranındaki "Satın Alımları Geri Yükle" butonuna dokun — '
            'mağazadaki (App Store / Google Play) geçmiş satın alımların '
            'kontrol edilip hesabına yeniden tanımlanır. Sorun devam ederse '
            '${DatingConfig.supportEmail} adresinden bize yaz.',
      ),
    ]),
    _FaqCategory('AI FOTO ÜRETİMİ', [
      _FaqItem(
        'AI fotoğraf üretmek için kaç fotoğraf yüklemem gerekiyor?',
        'Sadece ${DatingConfig.faceCaptureCount} canlı yüz çekimi: ön, sağ ve '
            'sol profil. Tam boy fotoğrafa gerek yok — boy ve vücut tipini '
            'zaten formda seçiyorsun, üretim onu kullanıyor. Karelerin net ve '
            'iyi ışıklandırılmış olması sonucu doğrudan etkiler.',
      ),
      _FaqItem(
        'Hangi stiller mevcut?',
        PhotoStyle.coreStyles.map((s) => '• ${s.label} — ${s.description}').join('\n'),
      ),
      _FaqItem(
        'Üretim ne kadar sürer?',
        'Genellikle birkaç dakika içinde tamamlanır. Üretim sırasında '
            'uygulamadan çıkabilirsin; sonuçların hazır olduğunda seni '
            'bilgilendiririz.',
      ),
      _FaqItem(
        'Fotoğraflarım kimlerle paylaşılıyor?',
        'Yüklediğin fotoğraflar yalnızca üretim ve kalite kontrolü amacıyla '
            'işlenir; bu işlem için tek yapay zekâ sağlayıcımız olan OpenAI '
            'kullanılır. '
            'Fotoğrafların başka bir amaçla kullanılmaz veya satılmaz. '
            'Detay için Ayarlar > "Gizlilik Politikası".',
      ),
    ]),
    _FaqCategory('FOTOĞRAF ANALİZİ', [
      _FaqItem(
        'Fotoğraf analizi nasıl çalışır?',
        'Yüklediğin fotoğrafları çekicilik, ışık, kadraj gibi kriterlere göre '
            'puanlar ve dating profilin için en iyi fotoğrafları önerir. İlk '
            'analiz sonucu ücretsiz gösterilir.',
      ),
      _FaqItem(
        'Analiz sonuçları kesin bir ölçüm mü?',
        'Hayır, sonuçlar temsili bir rehberliktir; tıbbi ya da bilimsel kesin '
            'bir ölçüm değildir. Amaç sana yapıcı bir yön göstermektir.',
      ),
    ]),
    _FaqCategory('HESAP & GİZLİLİK', [
      _FaqItem(
        'Hesabımı ve verilerimi nasıl silerim?',
        'Ayarlar > "Hesabımı ve Verilerimi Sil" ile paket bakiyen, ürettiğin '
            'fotoğraflar ve tüm verilerin kalıcı olarak silinir. Bu işlem '
            'geri alınamaz.',
      ),
      _FaqItem(
        'Yaş sınırı var mı?',
        'Evet, uygulama 18 yaş ve üzeri kullanıcılar içindir. Yalnızca kendine '
            'ait fotoğrafları yükleyebilirsin.',
      ),
      _FaqItem(
        'Verilerim ne kadar süre saklanıyor?',
        'Ürettiğin içerik hesabında saklanır, istediğin zaman silebilirsin. '
            'Detaylar için Ayarlar > "Veri İşleme Aydınlatması".',
      ),
    ]),
  ];

  @override
  Widget build(BuildContext context) {
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
        title: const Text('Sık Sorulan Sorular',
            style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final category in _categories) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 12, 4, 10),
              child: Text(category.title,
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1,
                      color: AppColors.textSecondary)),
            ),
            for (final item in category.items) _FaqTile(item: item),
          ],
          const SizedBox(height: 12),
          _ContactFooter(),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

class _FaqCategory {
  final String title;
  final List<_FaqItem> items;
  const _FaqCategory(this.title, this.items);
}

class _FaqItem {
  final String question;
  final String answer;
  const _FaqItem(this.question, this.answer);
}

class _FaqTile extends StatefulWidget {
  final _FaqItem item;
  const _FaqTile({required this.item});

  @override
  State<_FaqTile> createState() => _FaqTileState();
}

class _FaqTileState extends State<_FaqTile> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(widget.item.question,
                        style: const TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w700,
                            color: AppColors.textPrimary)),
                  ),
                  const SizedBox(width: 10),
                  AnimatedRotation(
                    turns: _open ? 0.5 : 0,
                    duration: const Duration(milliseconds: 200),
                    child: const Icon(Icons.keyboard_arrow_down_rounded,
                        color: AppColors.gold, size: 22),
                  ),
                ],
              ),
            ),
          ),
          AnimatedCrossFade(
            firstChild: const SizedBox(width: double.infinity),
            secondChild: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Text(widget.item.answer,
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.textSecondary, height: 1.5)),
            ),
            crossFadeState:
                _open ? CrossFadeState.showSecond : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 200),
            sizeCurve: Curves.easeInOut,
          ),
        ],
      ),
    );
  }
}

class _ContactFooter extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.goldSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: [
          const Icon(Icons.support_agent_outlined, color: AppColors.gold, size: 22),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Aradığını bulamadın mı?',
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textPrimary)),
                const SizedBox(height: 2),
                Text('Bize yaz: ${DatingConfig.supportEmail}',
                    style: const TextStyle(
                        fontSize: 12.5, color: AppColors.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
