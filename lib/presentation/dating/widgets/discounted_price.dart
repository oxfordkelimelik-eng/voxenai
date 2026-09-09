import 'package:flutter/material.dart';
import '../../../core/constants/app_colors.dart';

/// Paket kartlarında "eski fiyattan indirimli" görünümü.
///
/// ÖNEMLİ: [price] HER ZAMAN mağazadan (datingStorePrice) gelen GERÇEK
/// fiyat olmalı — burada asla sabit bir ₺ metni geçirilmemeli. [oldPriceLabel]
/// ise sadece geçmişe dönük, statik bir referanstır (App Store review
/// riskini azaltmak için — bkz. dating_constants.dart'taki uyarı). Bu widget
/// mağaza fiyatının gerçekten hedeflenen tutarla eşleşip eşleşmediğini
/// doğrulamaz; bu kullanıcının mağaza konsollarında sağlaması gereken bir
/// tutarlılıktır.
class DiscountedPrice extends StatelessWidget {
  final String oldPriceLabel;
  final String price;
  final String discountPercentLabel;
  final CrossAxisAlignment alignment;
  final double priceFontSize;

  const DiscountedPrice({
    super.key,
    required this.oldPriceLabel,
    required this.price,
    required this.discountPercentLabel,
    this.alignment = CrossAxisAlignment.end,
    this.priceFontSize = 20,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: alignment,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              oldPriceLabel,
              style: const TextStyle(
                fontSize: 11,
                color: AppColors.textMuted,
                decoration: TextDecoration.lineThrough,
              ),
            ),
            const SizedBox(width: 4),
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              decoration: BoxDecoration(
                color: AppColors.gold,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                discountPercentLabel,
                style: const TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textOnGold,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 1),
        Text(
          price,
          style: TextStyle(
            fontSize: priceFontSize,
            fontWeight: FontWeight.w900,
            color: AppColors.gold,
            height: 1.1,
          ),
        ),
      ],
    );
  }
}
