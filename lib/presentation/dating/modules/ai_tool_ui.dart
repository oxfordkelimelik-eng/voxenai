// AI ARAÇ EKRANLARI — ORTAK TASARIM (2026-11-23, kullanıcı: "genel yapı renklerine uygun, profesyonel, akıcı").
//
// RizzGPT (rizz_flow.dart) ve Profil Doktoru (profile_doctor_flow.dart) aynı görsel dili kullanır:
// koyu zemin + marka kırmızısı (AppColors.gold = kırmızı), 14-20 yuvarlak köşe, numaralı adımlar,
// altta sabit eylem çubuğu, kopyalanabilir öneri kartları, kademeli giriş animasyonu.
// Yalnız görünüm: iş mantığı akış dosyalarında.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/constants/app_colors.dart';
import '../widgets/dating_widgets.dart' show PrimaryButton;

/// Tek satırlık yazı: sığmazsa "…" ile KESİLMEZ, yazı tipi küçülerek sığar (2026-11-23, kullanıcı: "bitmeyen
/// yazılar görmek istemiyorum").
class ToolFitText extends StatelessWidget {
  final String text;
  final TextStyle style;
  final Alignment alignment;
  final TextAlign? textAlign;
  const ToolFitText(this.text, {super.key, required this.style, this.alignment = Alignment.centerLeft, this.textAlign});

  @override
  Widget build(BuildContext context) {
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: alignment,
      child: Text(text, maxLines: 1, softWrap: false, textAlign: textAlign, style: style),
    );
  }
}

/// Kırmızı vurgulu ince kenar (AppColors.borderGold eski altın tonunda kaldığı için yerel).
const Color kToolAccentBorder = Color(0x55FF2D55);

// ------------------------------------------------------------------ sayfa iskeleti

/// Kaydırılan içerik + altta sabit eylem çubuğu (klavye açılınca çubuk klavyenin üstüne çıkar).
class ToolPage extends StatelessWidget {
  final List<Widget> children;
  final Widget? bottom;
  const ToolPage({super.key, required this.children, this.bottom});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            children: children,
          ),
        ),
        if (bottom != null)
          Container(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 10),
            decoration: const BoxDecoration(
              color: AppColors.background,
              border: Border(top: BorderSide(color: AppColors.borderSubtle, width: 0.6)),
            ),
            child: bottom,
          ),
      ],
    );
  }
}

/// Ana eylem + altında küçük güven/kalan hak satırı.
class ToolCta extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final String? footnote;
  final IconData footnoteIcon;
  const ToolCta({
    super.key,
    required this.label,
    required this.onPressed,
    this.footnote,
    this.footnoteIcon = Icons.lock_outline_rounded,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        PrimaryButton(label: label, onPressed: onPressed),
        if (footnote != null) ...[
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(footnoteIcon, size: 13, color: AppColors.textMuted),
              const SizedBox(width: 6),
              Flexible(
                child: Text(footnote!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

// ------------------------------------------------------------------ giriş ekranı

/// Giriş başlığı (2026-11-23 sadeleştirme): kapak görseli + tek başlık + tek cümle. Eski kart, ikon
/// rozeti ve kazanım etiketleri kaldırıldı (kullanıcı: "çok yazı var, karmaşık").
class ToolIntroHeader extends StatelessWidget {
  final Widget visual;
  final String title;
  final String subtitle;
  const ToolIntroHeader({super.key, required this.visual, required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(22),
          child: SizedBox(height: 132, child: visual),
        ),
        const SizedBox(height: 14),
        Text(title,
            style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w900, height: 1.2, color: AppColors.textPrimary)),
        const SizedBox(height: 4),
        Text(subtitle, style: const TextStyle(fontSize: 13.5, height: 1.4, color: AppColors.textSecondary)),
      ],
    );
  }
}

/// Gradyanlı kare ikon rozeti (kırmızı, hafif parıltı).
class ToolIconBadge extends StatelessWidget {
  final IconData icon;
  final double size;
  const ToolIconBadge({super.key, required this.icon, this.size = 40});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: AppColors.goldGradient,
        borderRadius: BorderRadius.circular(size * 0.3),
        boxShadow: const [BoxShadow(color: AppColors.goldGlow, blurRadius: 14, offset: Offset(0, 4))],
      ),
      child: Icon(icon, color: AppColors.textOnGold, size: size * 0.5),
    );
  }
}

/// Küçük bölüm etiketi ("Ton", "Hedefin"); numara ve rozet yok.
class ToolLabel extends StatelessWidget {
  final String text;
  final String? trailing;
  const ToolLabel(this.text, {super.key, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(text,
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
          ),
          if (trailing != null)
            Text(trailing!, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ],
      ),
    );
  }
}

/// İki-üç seçenekli bölmeli seçici (seçili: kırmızı dolgu, beyaz yazı).
class ToolSegmented<T> extends StatelessWidget {
  final T value;
  final List<(T, String, IconData)> options;
  final ValueChanged<T> onChanged;
  const ToolSegmented({super.key, required this.value, required this.options, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: [
          for (final o in options)
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () {
                  if (o.$1 == value) return;
                  HapticFeedback.selectionClick();
                  onChanged(o.$1);
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOut,
                  padding: const EdgeInsets.symmetric(vertical: 11),
                  decoration: BoxDecoration(
                    color: o.$1 == value ? AppColors.gold : Colors.transparent,
                    borderRadius: BorderRadius.circular(12),
                    boxShadow: o.$1 == value
                        ? const [BoxShadow(color: AppColors.goldGlow, blurRadius: 12, offset: Offset(0, 3))]
                        : null,
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(o.$3, size: 16, color: o.$1 == value ? AppColors.textOnGold : AppColors.textSecondary),
                      const SizedBox(width: 6),
                      Flexible(
                        child: ToolFitText(o.$2,
                            style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w800,
                                color: o.$1 == value ? AppColors.textOnGold : AppColors.textSecondary)),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Tek seçimli hap butonlar (ton, hedef). HER ZAMAN TEK SATIR (2026-11-23, kullanıcı: "kaydırmaya
/// yönlendirme"): seçenekler eşit genişlikte yan yana; dar ekranda yazı satır kırmak yerine küçülür.
class ToolPills extends StatelessWidget {
  final Map<String, String> options;
  final String selected;
  final ValueChanged<String> onSelect;
  final bool enabled;
  const ToolPills({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelect,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final entries = options.entries.toList();
    return Row(
      children: [
        for (int i = 0; i < entries.length; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          Expanded(child: _pill(entries[i].key, entries[i].value, entries[i].key == selected)),
        ],
      ],
    );
  }

  Widget _pill(String key, String label, bool on) {
    return Opacity(
      opacity: enabled || on ? 1 : 0.45,
      child: GestureDetector(
        onTap: enabled && !on
            ? () {
                HapticFeedback.selectionClick();
                onSelect(key);
              }
            : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          height: 38,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? AppColors.gold : AppColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: on ? AppColors.gold : AppColors.borderSubtle),
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(label,
                maxLines: 1,
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: on ? AppColors.textOnGold : AppColors.textSecondary)),
          ),
        ),
      ),
    );
  }
}

/// Ekran görüntüsü seçici: boşken kesikli çerçeveli büyük alan, doluyken numaralı küçük resimler + ekle.
class ToolShotPicker extends StatelessWidget {
  final List<File> files;
  final int max;
  final VoidCallback onAdd;
  final ValueChanged<int> onRemove;
  final String emptyTitle;
  final String emptyHint;
  const ToolShotPicker({
    super.key,
    required this.files,
    required this.max,
    required this.onAdd,
    required this.onRemove,
    required this.emptyTitle,
    required this.emptyHint,
  });

  @override
  Widget build(BuildContext context) {
    if (files.isEmpty) {
      return GestureDetector(
        onTap: onAdd,
        child: CustomPaint(
          painter: const _DashedRRectPainter(color: Color(0x99FF2D55), radius: 18),
          child: Container(
            constraints: const BoxConstraints(minHeight: 112),
            padding: const EdgeInsets.symmetric(vertical: 14),
            decoration: BoxDecoration(
              color: AppColors.goldSurface.withValues(alpha: 0.05),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(color: AppColors.goldSurface, shape: BoxShape.circle),
                  child: const Icon(Icons.add_photo_alternate_rounded, color: AppColors.gold, size: 23),
                ),
                const SizedBox(height: 8),
                Text(emptyTitle,
                    style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                const SizedBox(height: 3),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(emptyHint,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return SizedBox(
      height: 132,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (int i = 0; i < files.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Stack(
                children: [
                  Container(
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AppColors.borderSubtle),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(13),
                      child: Image.file(files[i], width: 76, height: 132, fit: BoxFit.cover),
                    ),
                  ),
                  Positioned(
                    left: 6,
                    bottom: 6,
                    child: Container(
                      width: 22,
                      height: 22,
                      alignment: Alignment.center,
                      decoration: const BoxDecoration(color: AppColors.gold, shape: BoxShape.circle),
                      child: Text('${i + 1}',
                          style: const TextStyle(
                              fontSize: 11, fontWeight: FontWeight.w900, color: AppColors.textOnGold)),
                    ),
                  ),
                  Positioned(
                    top: 5,
                    right: 5,
                    child: GestureDetector(
                      onTap: () => onRemove(i),
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: const BoxDecoration(color: Color(0xB3000000), shape: BoxShape.circle),
                        child: const Icon(Icons.close_rounded, size: 15, color: Colors.white),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (files.length < max)
            GestureDetector(
              onTap: onAdd,
              child: CustomPaint(
                painter: const _DashedRRectPainter(color: Color(0x99FF2D55), radius: 14),
                child: SizedBox(
                  width: 76,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.add_rounded, color: AppColors.gold, size: 28),
                      const SizedBox(height: 4),
                      Text('${files.length}/$max',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DashedRRectPainter extends CustomPainter {
  final Color color;
  final double radius;
  const _DashedRRectPainter({required this.color, required this.radius});

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius((Offset.zero & size).deflate(0.7), Radius.circular(radius));
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    for (final m in (Path()..addRRect(rrect)).computeMetrics()) {
      for (double d = 0; d < m.length; d += 11) {
        canvas.drawPath(m.extractPath(d, d + 6), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRRectPainter old) => old.color != color || old.radius != radius;
}

/// İsteğe bağlı not (2026-11-23, kullanıcı: "küçük bir kutucuk olsun, oraya yazı yazılabileceği anlaşılsın"):
/// başlık + "İsteğe bağlı" etiketi ve altında kalem simgeli, tek satırdan başlayan küçük yazı kutusu.
/// Yazdıkça 4 satıra kadar büyür; karakter sayacı yalnız sınıra yaklaşınca görünür.
class ToolOptionalNote extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final String hint;

  /// true: kutu sohbet balonu biçiminde, solunda kişi simgesi ("kendinden bahset" — sana bir mesaj yazar gibi).
  final bool bubble;
  const ToolOptionalNote({
    super.key,
    required this.controller,
    required this.label,
    required this.hint,
    this.bubble = false,
  });

  static const _max = 300;

  @override
  Widget build(BuildContext context) {
    final radius = bubble
        ? const BorderRadius.only(
            topLeft: Radius.circular(20),
            topRight: Radius.circular(20),
            bottomRight: Radius.circular(20),
            bottomLeft: Radius.circular(6),
          )
        : BorderRadius.circular(14);
    OutlineInputBorder b(Color c) => OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c));
    final field = TextField(
          controller: controller,
          maxLength: _max,
          minLines: 1,
          maxLines: 4,
          textCapitalization: TextCapitalization.sentences,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14, height: 1.4),
          buildCounter: (_, {required currentLength, required isFocused, maxLength}) =>
              currentLength > _max - 50
                  ? Text('$currentLength/$_max', style: const TextStyle(color: AppColors.textMuted, fontSize: 11))
                  : null,
          decoration: InputDecoration(
            hintText: hint,
            hintMaxLines: 1,
            hintStyle: const TextStyle(color: AppColors.textMuted, fontSize: 13.5),
            prefixIcon: bubble ? null : const Icon(Icons.edit_outlined, size: 18, color: AppColors.textMuted),
            prefixIconConstraints: const BoxConstraints(minWidth: 42),
            isDense: true,
            filled: true,
            fillColor: bubble ? AppColors.surfaceElevated : AppColors.surface,
            contentPadding: bubble ? const EdgeInsets.fromLTRB(16, 14, 16, 14) : const EdgeInsets.fromLTRB(0, 13, 14, 13),
            enabledBorder: b(bubble ? kToolAccentBorder : AppColors.borderSubtle),
            focusedBorder: b(AppColors.gold),
            border: b(AppColors.borderSubtle),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ToolLabel(label, trailing: 'İsteğe bağlı'),
        if (!bubble)
          field
        else
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                width: 34,
                height: 34,
                margin: const EdgeInsets.only(bottom: 2),
                decoration: const BoxDecoration(gradient: AppColors.goldGradient, shape: BoxShape.circle),
                child: const Icon(Icons.person_rounded, size: 19, color: AppColors.textOnGold),
              ),
              const SizedBox(width: 8),
              Expanded(child: field),
            ],
          ),
      ],
    );
  }
}

/// Bölüm başlığı: başlık + isteğe bağlı sağ öğe (ikon rozeti yok — sade).
class ToolSectionHeader extends StatelessWidget {
  final String title;
  final Widget? trailing;
  const ToolSectionHeader({super.key, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 18, bottom: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(title,
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
          ),
          if (trailing case final w?) ...[const SizedBox(width: 8), w],
        ],
      ),
    );
  }
}

enum ToolNoticeKind { info, tip, warn }

/// Bilgi kartı: durum mesajı (info), ipucu (tip, kırmızı vurgulu), uyarı (warn, turuncu).
class ToolNotice extends StatelessWidget {
  final IconData icon;
  final String text;
  final String? title;
  final ToolNoticeKind kind;
  const ToolNotice({super.key, required this.icon, required this.text, this.title, this.kind = ToolNoticeKind.info});

  @override
  Widget build(BuildContext context) {
    final accent = switch (kind) {
      ToolNoticeKind.tip => AppColors.gold,
      ToolNoticeKind.warn => AppColors.warning,
      ToolNoticeKind.info => AppColors.textSecondary,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: kind == ToolNoticeKind.info ? AppColors.surface : accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
            color: kind == ToolNoticeKind.info ? AppColors.borderSubtle : accent.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 19, color: accent),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title != null) ...[
                  Text(title!,
                      style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.3,
                          color: kind == ToolNoticeKind.info ? AppColors.textSecondary : accent)),
                  const SizedBox(height: 3),
                ],
                Text(text, style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.42)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Kopyalanabilir öneri kartı: üst satırda rozet (ton / stil) ya da soru + kopyala ve bildir simgeleri,
/// altında büyük metin ve soluk tek satırlık gerekçe. Karta dokunmak da kopyalar; kopyalanınca kenar kırmızı.
class ToolCopyCard extends StatefulWidget {
  final String? badge;
  final String? question;
  final String text;
  final String why;
  final VoidCallback? onReport;
  const ToolCopyCard({super.key, this.badge, this.question, required this.text, this.why = '', this.onReport});

  @override
  State<ToolCopyCard> createState() => _ToolCopyCardState();
}

class _ToolCopyCardState extends State<ToolCopyCard> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    HapticFeedback.lightImpact();
    if (!mounted) return;
    setState(() => _copied = true);
    await Future.delayed(const Duration(milliseconds: 1600));
    if (mounted) setState(() => _copied = false);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 180),
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _copied ? AppColors.gold : AppColors.borderSubtle),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: _copy,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 6, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: widget.question != null
                          ? Text(widget.question!,
                              style: const TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w800,
                                  color: AppColors.textSecondary,
                                  height: 1.3))
                          : Align(
                              alignment: Alignment.centerLeft,
                              child: widget.badge == null ? const SizedBox.shrink() : ToolChip(widget.badge!),
                            ),
                    ),
                    if (widget.onReport != null)
                      _iconBtn(Icons.outlined_flag_rounded, 'Bildir', AppColors.textMuted, widget.onReport!),
                    _iconBtn(_copied ? Icons.check_rounded : Icons.copy_rounded, _copied ? 'Kopyalandı' : 'Kopyala',
                        AppColors.gold, _copy),
                  ],
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Text(widget.text,
                      style: const TextStyle(
                          fontSize: 15.5, fontWeight: FontWeight.w500, color: AppColors.textPrimary, height: 1.45)),
                ),
                if (widget.why.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Padding(
                    padding: const EdgeInsets.only(right: 10),
                    child: Text(widget.why,
                        style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.35)),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _iconBtn(IconData icon, String tip, Color color, VoidCallback onTap) => SizedBox(
        width: 36,
        height: 32,
        child: IconButton(
          tooltip: tip,
          padding: EdgeInsets.zero,
          iconSize: 18,
          icon: Icon(icon, color: color),
          onPressed: onTap,
        ),
      );
}

/// Küçük renkli etiket.
class ToolChip extends StatelessWidget {
  final String text;
  final Color color;
  const ToolChip(this.text, {super.key, this.color = AppColors.gold});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(8)),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: color)),
    );
  }
}

/// İkincil eylem (ana butonun altında, kırmızı çerçeveli; meşgulken dönen gösterge).
class ToolSecondaryButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool busy;
  const ToolSecondaryButton({super.key, required this.label, required this.icon, this.onPressed, this.busy = false});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 50,
      child: OutlinedButton.icon(
        onPressed: busy ? null : onPressed,
        icon: busy
            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
            : Icon(icon, size: 19),
        label: Text(label, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800)),
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.gold,
          disabledForegroundColor: AppColors.textMuted,
          side: BorderSide(color: onPressed == null && !busy ? AppColors.borderSubtle : AppColors.gold),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        ),
      ),
    );
  }
}

/// Bugün kalan ücretsiz hak: nokta göstergesi + metin.
/// Kalan paket hakkı (2026-11-24: günlük ücretsiz hak kalktı; hak foto paketiyle hediye gelir).
class ToolQuotaLine extends StatelessWidget {
  final int left;
  final String unit; // 'RizzGPT' | 'Profil Doktoru'
  const ToolQuotaLine({super.key, required this.left, required this.unit});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(left > 0 ? Icons.bolt_rounded : Icons.lock_outline_rounded,
            size: 14, color: left > 0 ? AppColors.gold : AppColors.textMuted),
        const SizedBox(width: 4),
        Flexible(
          child: ToolFitText(
              left > 0 ? 'Kalan $unit hakkın: $left' : '$unit hakkın bitti · AI foto paketlerinde hediye',
              style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
        ),
      ],
    );
  }
}

/// Kademeli giriş: hafif yukarı kayarak belirir (index'e göre gecikmeli).
class ToolFadeIn extends StatelessWidget {
  final int index;
  final Widget child;
  const ToolFadeIn({super.key, this.index = 0, required this.child});

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 320 + 70 * index.clamp(0, 8)),
      curve: Curves.easeOutCubic,
      builder: (_, v, c) => Opacity(
        opacity: v,
        child: Transform.translate(offset: Offset(0, 14 * (1 - v)), child: c),
      ),
      child: child,
    );
  }
}

/// Hata görünümü (ikon dairesi + mesaj + tekrar dene / geri dön).
class ToolErrorView extends StatelessWidget {
  final String message;
  final bool canRetry;
  final VoidCallback onRetry;
  final VoidCallback onBack;
  const ToolErrorView({
    super.key,
    required this.message,
    required this.canRetry,
    required this.onRetry,
    required this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 76,
                height: 76,
                decoration: BoxDecoration(
                  color: AppColors.goldSurface,
                  shape: BoxShape.circle,
                  border: Border.all(color: kToolAccentBorder),
                ),
                child: Icon(canRetry ? Icons.wifi_tethering_error_rounded : Icons.hourglass_bottom_rounded,
                    size: 34, color: AppColors.gold),
              ),
            ),
            const SizedBox(height: 18),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15, color: AppColors.textPrimary, height: 1.5)),
            const SizedBox(height: 26),
            if (canRetry) PrimaryButton(label: 'Tekrar Dene', onPressed: onRetry),
            const SizedBox(height: 6),
            TextButton(
              onPressed: onBack,
              child: const Text('Geri dön', style: TextStyle(color: AppColors.textSecondary)),
            ),
          ],
        ),
      ),
    );
  }
}

/// Bildirim sebebi seçimi (tutamaçlı alt sayfa). Seçilen anahtarı döner.
Future<String?> showToolReportSheet(
  BuildContext context, {
  required String title,
  required Map<String, String> reasons,
}) {
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: AppColors.surface,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(color: AppColors.surfaceHighest, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                const Icon(Icons.outlined_flag_rounded, color: AppColors.gold, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(title,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text('Bildirimin incelenir ve sonuçların iyileştirilmesinde kullanılır.',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            const SizedBox(height: 12),
            for (final e in reasons.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Material(
                  color: AppColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(14),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () => Navigator.pop(ctx, e.key),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(e.value,
                                style: const TextStyle(
                                    fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
                          ),
                          const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted, size: 20),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}
