import 'package:flutter/material.dart';
import '../../../core/constants/app_colors.dart';

/// Bir AI foto paketinin ALTINA bağlı, opsiyonel "Foto Analizi" eklentisi —
/// e-ticaret sitelerindeki "bu ürüne şunu da ekle" satırı gibi.
///
/// TASARIM KURALLARI (2026-09-22, kullanıcı kararı):
///  • Üst paketin hemen ALTINDA ve ona BAĞLI görünür (girinti + bağlantı
///    çizgisi + ayraç), ayrı bir paket gibi durmaz.
///  • Üst paketle aynı dil, sadece DAHA KÜÇÜK font.
///  • Fiyat KIRMIZI ve PARANTEZSİZ, kendi başına bir rakam olarak durur —
///    "(+₺150)" değil, alt modülün sağında "+₺150".
///  • Aynı kart içinde seçilir; varsayılan işaretli/işaretsiz durumu bu
///    widget'ın DIŞINDA, çağıran ekran tarafından karar verilir (2026-09-23
///    kuralı: kullanıcı seçmedikçe hiçbir tik işaretli gelmez — istisna,
///    paywall'da zaten otomatik seçili duran orta paket).
///
/// Fiyat DIŞARIDAN verilir ve her zaman iki gerçek mağaza fiyatının farkıdır
/// (bkz. datingAddOnPriceLabel). Burada sabit bir etiket basmak App Store
/// "yanıltıcı fiyat" riski taşır; fiyat henüz yüklenmediyse [priceLabel] null
/// gelir ve yer tutucu gösterilir.
class AnalysisAddOnTile extends StatelessWidget {
  final bool checked;
  final int runs;
  final String? priceLabel;
  final ValueChanged<bool>? onChanged;

  /// Vitrin gibi dar listelerde biraz daha sıkışık çizilir.
  final bool compact;

  const AnalysisAddOnTile({
    super.key,
    required this.checked,
    required this.runs,
    required this.priceLabel,
    required this.onChanged,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final enabled = onChanged != null;
    return Semantics(
      checked: checked,
      button: true,
      label: '$runs foto analizi ekle',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? () => onChanged!(!checked) : null,
        child: Container(
          padding: EdgeInsets.fromLTRB(compact ? 10 : 14, compact ? 7 : 10,
              compact ? 10 : 14, compact ? 7 : 10),
          decoration: BoxDecoration(
            // Seçiliyken hafif altın zemin: aynı kart içinde neyin ödeneceği
            // tek bakışta görünsün.
            color: checked ? AppColors.goldSurface : AppColors.surface,
            border: const Border(
              top: BorderSide(color: AppColors.borderSubtle, width: 0.8),
            ),
          ),
          child: Row(
            children: [
              // ÜST PAKETE BAĞLILIK: girinti + dallanma oku. Eklenti tek
              // başına satılmadığı için görsel olarak da bağımsız durmamalı.
              SizedBox(width: compact ? 6 : 10),
              Icon(Icons.subdirectory_arrow_right_rounded,
                  size: compact ? 13 : 15, color: AppColors.textMuted),
              SizedBox(width: compact ? 6 : 8),
              _Box(checked: checked, enabled: enabled, compact: compact),
              SizedBox(width: compact ? 8 : 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.insights,
                            size: compact ? 12 : 14, color: AppColors.gold),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            'Foto Analizi',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: compact ? 11.5 : 13,
                              fontWeight: FontWeight.w800,
                              color: AppColors.textPrimary,
                            ),
                          ),
                        ),
                      ],
                    ),
                    SizedBox(height: compact ? 1 : 3),
                    Text(
                      '$runs fotoğraf analizi ekle',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: compact ? 9.5 : 11,
                        color: AppColors.textSecondary,
                        height: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              // FİYAT: kırmızı, parantezsiz, kendi başına.
              Text(
                priceLabel ?? '+…',
                style: TextStyle(
                  fontSize: compact ? 13 : 15,
                  fontWeight: FontWeight.w900,
                  color: AppColors.error,
                  height: 1.1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Kutucuk — Material [Checkbox] yerine elle çizildi: Checkbox kendi dokunma
/// alanını ve minimum boyutunu dayatıyor, bu satır ise dar ve tek dokunuşla
/// (tüm satırdan) seçilebilir olmak zorunda.
class _Box extends StatelessWidget {
  final bool checked;
  final bool enabled;
  final bool compact;
  const _Box({required this.checked, required this.enabled, required this.compact});

  @override
  Widget build(BuildContext context) {
    final side = compact ? 16.0 : 19.0;
    return Container(
      width: side,
      height: side,
      decoration: BoxDecoration(
        color: checked ? AppColors.gold : Colors.transparent,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(
          color: checked ? AppColors.gold : AppColors.borderGold,
          width: 1.4,
        ),
      ),
      child: checked
          ? Icon(Icons.check_rounded,
              size: side - 5, color: AppColors.textOnGold)
          : null,
    );
  }
}
