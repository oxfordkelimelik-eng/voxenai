import 'package:flutter/material.dart';

/// VOXEN AI — Marka Renk Paleti
/// Karanlık zemin + CANLI KIRMIZI vurgular (dating/çekim estetiği).
/// NOT: Geriye dönük uyum için sabit adları `gold*` olarak korunmuştur ama
/// değerleri VOXEN AI kırmızısıdır — böylece tüm uygulama tek yerden kırmızıya
/// döner. `gold` = marka kırmızısı olarak okunmalıdır.
class AppColors {
  AppColors._();

  // === ANA RENKLER ===
  static const Color background = Color(0xFF0A0A0A);
  static const Color surface = Color(0xFF161113);
  static const Color surfaceElevated = Color(0xFF201619);
  static const Color surfaceHighest = Color(0xFF2A1C20);

  // === KIRMIZI (Primary Brand — VOXEN AI) ===
  static const Color gold = Color(0xFFFF2D55); // marka kırmızısı
  static const Color goldLight = Color(0xFFFF5C7A);
  static const Color goldDark = Color(0xFFD11640);
  static const Color goldGlow = Color(0x40FF2D55);
  static const Color goldSurface = Color(0x1AFF2D55);

  // === METİN ===
  static const Color textPrimary = Color(0xFFF5F5F5);
  static const Color textSecondary = Color(0xFFB0A6A9);
  static const Color textMuted = Color(0xFF6E5C61);
  static const Color textOnGold = Color(0xFFFFFFFF); // kırmızı üstünde beyaz

  // === DURUM RENKLERİ ===
  static const Color success = Color(0xFF4CAF50);
  static const Color successGlow = Color(0x304CAF50);
  static const Color error = Color(0xFFEF5350);
  static const Color errorGlow = Color(0x30EF5350);
  static const Color warning = Color(0xFFFFA726);
  static const Color warningGlow = Color(0x30FFA726);
  static const Color info = Color(0xFF42A5F5);

  // === GÖREV KATEGORİ RENKLERİ ===
  static const Color physical = Color(0xFFEF5350); // Fiziksel — Kırmızı
  static const Color mental = Color(0xFF42A5F5); // Zihinsel — Mavi
  static const Color social = Color(0xFF4CAF50); // Sosyal — Yeşil
  static const Color physicalGlow = Color(0x30EF5350);
  static const Color mentalGlow = Color(0x3042A5F5);
  static const Color socialGlow = Color(0x304CAF50);

  // === GRADYANLAR ===
  static const LinearGradient goldGradient = LinearGradient(
    colors: [goldDark, gold, goldLight],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  /// Karşılama ekranı için canlı kırmızı arka plan gradyanı (VOXEN AI).
  static const LinearGradient brandRedBackground = LinearGradient(
    colors: [Color(0xFFE0113E), Color(0xFF8E0C2A), Color(0xFF2A0810)],
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
  );

  static const LinearGradient backgroundGradient = LinearGradient(
    colors: [background, Color(0xFF0F0F0F), Color(0xFF0A0A0A)],
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
  );

  static const LinearGradient cardGradient = LinearGradient(
    colors: [surfaceElevated, surface],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const LinearGradient xpGradient = LinearGradient(
    colors: [Color(0xFF6A3DE8), Color(0xFFD4AF37)],
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
  );

  // === BORDER ===
  static const Color borderSubtle = Color(0xFF2A2A2A);
  static const Color borderGold = Color(0x60D4AF37);
  static const Color borderActive = Color(0xFFD4AF37);

  // === SKOR RENKLERİ (0-100) ===
  static Color scoreColor(int score) {
    if (score >= 80) return const Color(0xFFFF2D55); // Marka kırmızısı
    if (score >= 60) return const Color(0xFF4CAF50); // Yeşil
    if (score >= 40) return const Color(0xFFFFA726); // Turuncu
    return const Color(0xFFEF5350); // Kırmızı
  }
}
