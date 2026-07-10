import 'package:flutter/material.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import 'voxen_visuals.dart';

/// VOXEN AI onboarding iskeleti — HER EKRANDA AYNI DÜZEN:
///   1) EN ÜSTTE: VOXEN AI logosu + ilerleme çubuğu
///   2) ORTADA: görsel/grafik (visual)
///   3) ALTTA (butonun hemen üstünde): BÜYÜK başlık + küçük açıklama
///   4) EN ALTTA: kırmızı arka planlı, beyaz yazılı, büyük "Devam Et" butonu
/// Klavye ASLA açılmaz (Bölüm 0).
class OnboardingScaffold extends StatelessWidget {
  final double progress; // 0.0 - 1.0
  final Widget? visual; // ortadaki görsel/grafik
  final Widget? child; // (quiz) etkileşimli içerik — visual yerine
  final String? title; // büyük font başlık (butonun üstünde)
  final String? subtitle; // küçük font açıklama
  final String buttonLabel;
  final VoidCallback? onContinue; // null → buton pasif
  final VoidCallback? onBack;

  const OnboardingScaffold({
    super.key,
    required this.progress,
    this.visual,
    this.child,
    this.title,
    this.subtitle,
    this.buttonLabel = 'Devam Et',
    required this.onContinue,
    this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            // 1) EN ÜSTTE: logo + geri + progress
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
              child: Column(
                children: [
                  Stack(
                    alignment: Alignment.center,
                    children: [
                      const Center(child: VoxenWordmark(fontSize: 20)),
                      if (onBack != null)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: GestureDetector(
                            onTap: onBack,
                            child: const Icon(
                                Icons.arrow_back_ios_new_rounded,
                                size: 18,
                                color: AppColors.textSecondary),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: TweenAnimationBuilder<double>(
                      tween: Tween(begin: 0, end: progress.clamp(0.0, 1.0)),
                      duration: const Duration(milliseconds: 400),
                      curve: Curves.easeOut,
                      builder: (_, value, _) => LinearProgressIndicator(
                        value: value,
                        minHeight: 6,
                        backgroundColor: AppColors.surfaceElevated,
                        valueColor:
                            const AlwaysStoppedAnimation(AppColors.gold),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            // 2) ORTADA: görsel dikey ortada; quiz içeriği yukarıdan akar
            Expanded(
              child: child != null
                  ? SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
                      child: child,
                    )
                  : LayoutBuilder(
                      builder: (ctx, c) => SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
                        child: ConstrainedBox(
                          constraints: BoxConstraints(minHeight: c.maxHeight),
                          child: Center(
                              child: visual ?? const SizedBox.shrink()),
                        ),
                      ),
                    ),
            ),
            // 3) ALTTA: büyük başlık + küçük açıklama
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                child: Column(
                  children: [
                    Text(title!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            fontSize: 27,
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary,
                            height: 1.15)),
                    if (subtitle != null) ...[
                      const SizedBox(height: 8),
                      Text(subtitle!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontSize: 14,
                              color: AppColors.textSecondary,
                              height: 1.4)),
                    ],
                  ],
                ),
              ),
            // 4) EN ALTTA: kırmızı büyük buton
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
              child: PrimaryButton(label: buttonLabel, onPressed: onContinue),
            ),
          ],
        ),
      ),
    );
  }
}

/// Büyük altın eylem butonu (tüm akış boyunca tek stil).
class PrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  const PrimaryButton(
      {super.key, required this.label, this.onPressed, this.loading = false});

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !loading;
    return SizedBox(
      width: double.infinity,
      height: 56,
      child: ElevatedButton(
        onPressed: enabled ? onPressed : null,
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.gold,
          foregroundColor: AppColors.textOnGold,
          disabledBackgroundColor: AppColors.surfaceElevated,
          disabledForegroundColor: AppColors.textMuted,
          elevation: enabled ? 8 : 0,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        ),
        child: loading
            ? const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                    strokeWidth: 2.5, color: AppColors.textOnGold),
              )
            : Text(label,
                style: const TextStyle(
                    fontSize: 19,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 0.5)),
      ),
    );
  }
}

/// Başlık + alt metin bloğu (onboarding üst kısmı).
class OnboardingHeadline extends StatelessWidget {
  final String title;
  final String? subtitle;
  final TextAlign align;
  const OnboardingHeadline(
      {super.key,
      required this.title,
      this.subtitle,
      this.align = TextAlign.center});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: align == TextAlign.center
          ? CrossAxisAlignment.center
          : CrossAxisAlignment.start,
      children: [
        Text(title,
            textAlign: align,
            style: const TextStyle(
                fontSize: 26,
                fontWeight: FontWeight.w900,
                color: AppColors.textPrimary,
                height: 1.2)),
        if (subtitle != null) ...[
          const SizedBox(height: 12),
          Text(subtitle!,
              textAlign: align,
              style: const TextStyle(
                  fontSize: 15,
                  color: AppColors.textSecondary,
                  height: 1.45)),
        ],
      ],
    );
  }
}

/// Bir bar grafiği verisi.
class BarDatum {
  final String label;
  final double value; // 0-100 (yüzde)
  final bool highlight;
  const BarDatum(this.label, this.value, {this.highlight = false});
}

/// Animasyonlu yatay bar grafiği (aşağıdan/soldan dolar).
/// "*Temsili veriler" notu zorunlu olarak altında gösterilir (Bölüm 0).
class AnimatedBarChart extends StatelessWidget {
  final String? caption;
  final List<BarDatum> data;
  final bool showRepresentativeNote;
  const AnimatedBarChart({
    super.key,
    this.caption,
    required this.data,
    this.showRepresentativeNote = true,
  });

  @override
  Widget build(BuildContext context) {
    final maxVal =
        data.map((d) => d.value).fold<double>(0, (a, b) => a > b ? a : b);
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (caption != null) ...[
            Text(caption!,
                style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary)),
            const SizedBox(height: 16),
          ],
          ...data.map((d) => _bar(d, maxVal)),
          if (showRepresentativeNote) ...[
            const SizedBox(height: 8),
            const RepresentativeNote(),
          ],
        ],
      ),
    );
  }

  Widget _bar(BarDatum d, double maxVal) {
    final frac = maxVal == 0 ? 0.0 : d.value / maxVal;
    final color = d.highlight ? AppColors.gold : AppColors.textSecondary;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Flexible(
                child: Text(d.label,
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight:
                            d.highlight ? FontWeight.w800 : FontWeight.w500,
                        color: d.highlight
                            ? AppColors.gold
                            : AppColors.textSecondary)),
              ),
              Text('%${d.value.toInt()}',
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: color)),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: frac),
              duration: const Duration(milliseconds: 900),
              curve: Curves.easeOutCubic,
              builder: (_, value, _) => Stack(
                children: [
                  Container(height: 12, color: AppColors.surfaceElevated),
                  FractionallySizedBox(
                    widthFactor: value,
                    child: Container(
                      height: 12,
                      decoration: BoxDecoration(
                        gradient: d.highlight
                            ? AppColors.goldGradient
                            : LinearGradient(colors: [
                                color.withValues(alpha: 0.6),
                                color.withValues(alpha: 0.4)
                              ]),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "*Temsili veriler" notu (yasal koruma — Bölüm 0, zorunlu).
class RepresentativeNote extends StatelessWidget {
  const RepresentativeNote({super.key});
  @override
  Widget build(BuildContext context) {
    return Text(DatingConfig.representativeNote,
        style: const TextStyle(
            fontSize: 11,
            fontStyle: FontStyle.italic,
            color: AppColors.textMuted));
  }
}

/// Tek/çoklu seçim butonu (klavyesiz giriş — Bölüm 0).
class ChoiceOption extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool multi; // çoklu seçim → tik ikonu
  const ChoiceOption({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.multi = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        decoration: BoxDecoration(
          color: selected ? AppColors.goldSurface : AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: selected ? AppColors.gold : AppColors.borderSubtle,
              width: selected ? 1.5 : 1),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      fontSize: 16,
                      fontWeight:
                          selected ? FontWeight.w700 : FontWeight.w500,
                      color: selected
                          ? AppColors.gold
                          : AppColors.textPrimary)),
            ),
            Icon(
              multi
                  ? (selected
                      ? Icons.check_box_rounded
                      : Icons.check_box_outline_blank_rounded)
                  : (selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked),
              color: selected ? AppColors.gold : AppColors.textMuted,
              size: 22,
            ),
          ],
        ),
      ),
    );
  }
}
