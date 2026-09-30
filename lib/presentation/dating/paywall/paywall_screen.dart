import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../providers/dating_providers.dart';
import '../widgets/analysis_addon_tile.dart';
import '../widgets/discounted_price.dart';
import 'purchase_auth_gate.dart';

/// Hangi paket grubunun gösterileceği.
enum PaywallMode { all, analysis, aiPhoto }

PaywallMode paywallModeFromQuery(String? mode) => switch (mode) {
  'analysis' => PaywallMode.analysis,
  'ai_photo' => PaywallMode.aiPhoto,
  _ => PaywallMode.all,
};

// Paket listesi ORTAK (bkz. DatingConfig.photoPackTiers) — vitrin ekranı da
// aynı listeyi kullanıyor, başlıklar/analiz adetleri iki yerde ayrışmasın.
const _tiers = DatingConfig.photoPackTiers;

/// Paket satın alma ekranı (abonelik YOK). Modül bağlamına göre yalnızca
/// ilgili paketler gösterilebilir (analysis / ai_photo query param).
class PaywallScreen extends ConsumerStatefulWidget {
  final PaywallMode mode;
  const PaywallScreen({super.key, this.mode = PaywallMode.all});
  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  bool _busy = false;
  String? _busyProductId;

  // SEÇİLİ TIER. _selectedTierId, seçili paketin SOLO ürün ID'sini tutar
  // (tier'ı tekil tanımlayan anahtar). Satın alınan ürün her zaman analiz
  // HEDİYELİ bundle ID'sidir (2026-09-28 fiyatlandırması: 5+1 ₺799,
  // 10+3 ₺999, 25+5 ₺1.799 — analiz artık seçilmiyor, pakete dahil).
  late String _selectedTierId;

  @override
  void initState() {
    super.initState();
    // Varsayılan seçim: analiz modunda en UCUZ paket, diğer modlarda orta
    // paket (10 foto).
    _selectedTierId = widget.mode == PaywallMode.analysis
        ? _tiers[0].soloProductId
        : _tiers[1].soloProductId;
    _loadStorePrices();
  }

  String _effectiveProductId(PhotoPackTier tier) =>
      tier.productId(withAnalysis: true);

  PhotoPackTier get _selectedTier => _tiers.firstWhere(
    (t) => t.soloProductId == _selectedTierId,
    orElse: () => _tiers[1],
  );

  String get _selectedProductId => _effectiveProductId(_selectedTier);

  Future<void> _loadStorePrices() async {
    await ref.read(datingPurchaseServiceProvider).init();
    if (mounted) setState(() {});
  }

  String _price(String productId) =>
      datingStorePrice(ref.read(datingPurchaseServiceProvider), productId);

  String get _title => switch (widget.mode) {
    PaywallMode.analysis => 'Fotoğraf Analizini Aç',
    PaywallMode.aiPhoto => 'AI Dating Fotoğraf Paketi',
    PaywallMode.all => 'Devam etmek için paket al',
  };

  String get _subtitle => switch (widget.mode) {
    // Analiz artık tek başına satılmıyor (2026-09-21 kuralı) — bir AI
    // foto paketinin yanına eklenti olarak geliyor, varsayılan işaretli.
    PaywallMode.analysis =>
      'Foto analizi artık her AI foto paketinde HEDİYE olarak geliyor. '
          'Bir paket seç, analiz hakların otomatik eklenir.',
    PaywallMode.aiPhoto =>
      'Kalan AI fotoğraflarını açmak için tek seferlik paket al.',
    PaywallMode.all =>
      'Abonelik yok. Tek ödemeyle belirli sayıda kullanım al; bitince istersen yeniden alırsın.',
  };

  void _selectTier(String soloId) {
    if (soloId == _selectedTierId) return; // zaten seçili, dokunma
    setState(() => _selectedTierId = soloId);
  }

  Widget _tierCard(PhotoPackTier tier) {
    final effectiveId = _effectiveProductId(tier);
    return _PackCard(
      icon: Icons.auto_awesome,
      title: tier.title,
      sub: '${tier.photos} fotoğraf + ${tier.addOnRuns} analiz',
      // Fiyat analiz hediyeli paketin KENDİ mağaza fiyatı.
      price: _price(effectiveId),
      badge: tier.badge,
      selected: _selectedTierId == tier.soloProductId,
      busy: _busyProductId == effectiveId,
      onTap: _busy ? null : () => _selectTier(tier.soloProductId),
      addOnRow: GiftAnalysisRow(compact: true, runs: tier.addOnRuns),
    );
  }

  Future<void> _buy(String productId) async {
    // Mağaza akışı BAŞLAMADAN önce giriş şart: sunucu doğrulaması
    // (`verifyPurchase`) oturum ister; giriş olmadan satın alma tamamlanır ama
    // hesaba tanımlanamaz ve işlem askıda kalır (bkz. purchase_auth_gate.dart).
    if (!await ensureSignedInForPurchase(context, ref)) return;
    if (!mounted) return;
    setState(() {
      _busy = true;
      _busyProductId = productId;
    });
    final service = ref.read(datingPurchaseServiceProvider);
    final ok = await service.purchaseAndWait(productId);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _busyProductId = null;
    });
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Satın alma başarılı! Paketin hesabına eklendi.'),
        ),
      );
      context.pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Satın alma tamamlanamadı. Lütfen tekrar dene.'),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: IconButton(
                icon: const Icon(
                  Icons.close_rounded,
                  color: AppColors.textSecondary,
                ),
                onPressed: () => context.pop(false),
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(
                      Icons.workspace_premium_rounded,
                      color: AppColors.gold,
                      size: 52,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      _title,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w900,
                        color: AppColors.textPrimary,
                        height: 1.25,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _subtitle,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 14,
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 28),
                    // ANALİZ ARTIK TEK BAŞINA SATILMIYOR; her AI foto
                    // paketinde hediye olarak geliyor (2026-09-28). Üstü çizili "eski fiyat" GÖSTERİLMİYOR: paketlerin
                    // içeriği zaman içinde değişti, eski rakamı indirim gibi
                    // göstermek yanıltıcı olur (App Store "yanıltıcı fiyat").
                    const _SectionLabel('AI DATING FOTOĞRAFI'),
                    const SizedBox(height: 10),
                    for (var i = 0; i < _tiers.length; i++) ...[
                      if (i > 0) const SizedBox(height: 10),
                      _tierCard(_tiers[i]),
                    ],
                  ],
                ),
              ),
            ),
            // SATIN ALMA TEK BUTONDA (2026-09-20). Kartlar artık yalnızca
            // SEÇİYOR; ödeme akışı buradan başlıyor. Seçili paketin fiyatı
            // butonun ÜZERİNDE yazıyor — mağaza ekranı açılmadan önceki son
            // teyit noktası burası. (Fiyat henüz mağazadan yüklenmediyse
            // kartlardakiyle aynı "…" yer tutucusu görünür.)
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 8),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _busy ? null : () => _buy(_selectedProductId),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.gold,
                    foregroundColor: AppColors.textOnGold,
                    disabledBackgroundColor: AppColors.goldSurface,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: _busy
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          // Zemin altın olduğu için gösterge altın DEĞİL,
                          // altın üstü metin rengiyle çizilir — aksi halde
                          // görünmez olur.
                          child: CircularProgressIndicator(
                            strokeWidth: 2.2,
                            color: AppColors.textOnGold,
                          ),
                        )
                      : Text(
                          'Satın Al · ${_price(_selectedProductId)}',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                ),
              ),
            ),
            TextButton(
              onPressed: _busy
                  ? null
                  : () async {
                      // Geri yükleme de sunucu doğrulaması yapar → oturum şart.
                      if (!await ensureSignedInForPurchase(context, ref))
                        return;
                      if (!context.mounted) return;
                      await ref.read(entitlementProvider.notifier).restore();
                      await ref.read(datingPurchaseServiceProvider).restore();
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Satın alımlar kontrol edildi.'),
                        ),
                      );
                    },
              child: const Text(
                'Satın Alımları Geri Yükle',
                style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
              ),
            ),
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text(
                'Tek seferlik ödeme · otomatik yenileme yok.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10, color: AppColors.textMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String label;
  const _SectionLabel(this.label);

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w900,
          letterSpacing: 1,
          color: AppColors.textMuted,
        ),
      ),
    );
  }
}

class _PackCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  final String price;
  final String? badge;
  final bool busy;
  final VoidCallback? onTap;

  /// Seçili kart: kalın altın çerçeve + hafif altın zemin + tik işareti.
  /// Satın alma artık karttan değil alttaki tek butondan yapılıyor, bu yüzden
  /// hangi paketin ödeneceği GÖRSEL olarak net belli olmak zorunda.
  final bool selected;
  // null ise indirim gösterilmez (geriye uyumlu — analiz kartları için
  // null bırakılır, sadece bu foto üretimi kartları için doldurulur).
  final String? oldPriceLabel;
  final String? discountPercentLabel;
  /// Kartın ALTINA, seçim dokunuşunun DIŞINA eklenen bağlı satır — opsiyonel
  /// analiz eklentisi (bkz. AnalysisAddOnTile).
  ///
  /// DOKUNMA ALANININ DIŞINDA OLMASI ŞART: iç içe GestureDetector'da hangi
  /// dinleyicinin kazandığı Flutter'ın gesture arena'sına kalır. Eklentiyi
  /// kartın kendi onTap'inin içine koymak, kutucuğa basan kullanıcının aynı
  /// anda paketi de seçmesine (ya da tam tersine, seçimin hiç çalışmamasına)
  /// yol açabilirdi. Ayrı kardeş widget olunca iki dokunuş da tek anlamlı.
  final Widget? addOnRow;
  const _PackCard({
    required this.icon,
    required this.title,
    required this.sub,
    required this.price,
    required this.onTap,
    this.badge,
    this.busy = false,
    this.selected = false,
    this.oldPriceLabel,
    this.discountPercentLabel,
    this.addOnRow,
  });

  @override
  Widget build(BuildContext context) {
    // Vitrin ekranıyla (modules_showcase) AYNI küçük/sade satır tasarımı
    // (2026-09-23 kullanıcı kararı) — tek fark, burada tek bir CTA butonu
    // hangi paketin ödeneceğine bağlı olduğu için sağda bir seçim işareti
    // (chevron yerine dolu/boş daire) var.
    return Container(
      decoration: BoxDecoration(
        color: selected ? AppColors.goldSurface : AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: selected ? AppColors.gold : AppColors.borderSubtle,
          width: selected ? 1.4 : 0.8,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (badge != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              color: AppColors.gold,
              child: Text(
                badge!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.8,
                  color: AppColors.textOnGold,
                ),
              ),
            ),
          // Yalnızca PAKET SATIRI seçim için dokunulabilir; eklenti aşağıda
          // kendi dokunma alanına sahip (bkz. addOnRow'un açıklaması).
          GestureDetector(
            onTap: onTap,
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Icon(icon, color: AppColors.gold, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        Text(
                          sub,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  if (busy)
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: AppColors.gold,
                      ),
                    )
                  else if (oldPriceLabel != null)
                    DiscountedPrice(
                      oldPriceLabel: oldPriceLabel!,
                      price: price,
                      discountPercentLabel: discountPercentLabel ?? '',
                    )
                  else
                    Text(
                      price,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                        color: AppColors.gold,
                      ),
                    ),
                  const SizedBox(width: 8),
                  Icon(
                    selected
                        ? Icons.check_circle_rounded
                        : Icons.circle_outlined,
                    size: 18,
                    color: selected ? AppColors.gold : AppColors.textMuted,
                  ),
                ],
              ),
            ),
          ),
          if (addOnRow != null) addOnRow!,
        ],
      ),
    );
  }
}
