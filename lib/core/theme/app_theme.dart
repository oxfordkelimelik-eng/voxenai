import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../constants/app_colors.dart';

const _fontBebasNeue = 'BebasNeue';
const _fontInter = 'Inter';

class AppTheme {
  AppTheme._();

  static ThemeData get darkTheme {
    return ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.gold,
        onPrimary: AppColors.textOnGold,
        secondary: AppColors.goldLight,
        onSecondary: AppColors.textOnGold,
        surface: AppColors.surface,
        onSurface: AppColors.textPrimary,
        error: AppColors.error,
        onError: Colors.white,
      ),
      textTheme: _buildTextTheme(),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: SystemUiOverlayStyle.light,
        titleTextStyle: TextStyle(
          fontFamily: _fontBebasNeue,
          fontSize: 22,
          color: AppColors.textPrimary,
          letterSpacing: 2,
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AppColors.surface,
        selectedItemColor: AppColors.gold,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: AppColors.surfaceElevated,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: AppColors.borderSubtle, width: 0.5),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.gold,
          foregroundColor: AppColors.textOnGold,
          minimumSize: const Size(double.infinity, 56),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(
            fontFamily: _fontBebasNeue,
            fontSize: 18,
            letterSpacing: 2,
          ),
          elevation: 0,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.gold,
          minimumSize: const Size(double.infinity, 56),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          side: const BorderSide(color: AppColors.gold, width: 1.5),
          textStyle: const TextStyle(
            fontFamily: _fontBebasNeue,
            fontSize: 18,
            letterSpacing: 2,
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceElevated,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.borderSubtle),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.borderSubtle),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.gold, width: 1.5),
        ),
        labelStyle: const TextStyle(color: AppColors.textSecondary),
        hintStyle: const TextStyle(color: AppColors.textMuted),
      ),
      dividerTheme: const DividerThemeData(
        color: AppColors.borderSubtle,
        thickness: 0.5,
      ),
      iconTheme: const IconThemeData(color: AppColors.textPrimary, size: 24),
    );
  }

  static TextTheme _buildTextTheme() {
    return const TextTheme(
      displayLarge: TextStyle(fontFamily: _fontBebasNeue, fontSize: 57, color: AppColors.textPrimary, letterSpacing: 2),
      displayMedium: TextStyle(fontFamily: _fontBebasNeue, fontSize: 45, color: AppColors.textPrimary, letterSpacing: 2),
      displaySmall: TextStyle(fontFamily: _fontBebasNeue, fontSize: 36, color: AppColors.textPrimary, letterSpacing: 1.5),
      headlineLarge: TextStyle(fontFamily: _fontBebasNeue, fontSize: 32, color: AppColors.textPrimary, letterSpacing: 1.5),
      headlineMedium: TextStyle(fontFamily: _fontBebasNeue, fontSize: 28, color: AppColors.textPrimary, letterSpacing: 1),
      headlineSmall: TextStyle(fontFamily: _fontBebasNeue, fontSize: 24, color: AppColors.textPrimary, letterSpacing: 1),
      titleLarge: TextStyle(fontFamily: _fontInter, fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.textPrimary),
      titleMedium: TextStyle(fontFamily: _fontInter, fontSize: 18, fontWeight: FontWeight.w600, color: AppColors.textPrimary),
      titleSmall: TextStyle(fontFamily: _fontInter, fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
      bodyLarge: TextStyle(fontFamily: _fontInter, fontSize: 16, color: AppColors.textPrimary, height: 1.5),
      bodyMedium: TextStyle(fontFamily: _fontInter, fontSize: 14, color: AppColors.textPrimary, height: 1.5),
      bodySmall: TextStyle(fontFamily: _fontInter, fontSize: 12, color: AppColors.textSecondary, height: 1.4),
      labelLarge: TextStyle(fontFamily: _fontInter, fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textPrimary, letterSpacing: 0.5),
      labelMedium: TextStyle(fontFamily: _fontInter, fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
      labelSmall: TextStyle(fontFamily: _fontInter, fontSize: 11, fontWeight: FontWeight.w500, color: AppColors.textMuted),
    );
  }
}
