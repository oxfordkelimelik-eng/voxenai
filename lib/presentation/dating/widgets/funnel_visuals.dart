import 'dart:math';
import 'package:flutter/material.dart';
import '../../../core/constants/app_colors.dart';
import 'dating_widgets.dart';

/// Onboarding funnel'ının video-öncesi bölümü için görseller (2026-09-28).
/// Hepsi ikon/çizim tabanlı — gerçek foto/marka logosu asset'i gerektirmez,
/// asset yoksa çökme riski olmaz. Sayısal iddia taşıyan ekranlarda
/// [RepresentativeNote] eklenir (Bölüm 0, yasal koruma zorunluluğu).

// ============================================================
// EKRAN — "Eşleşme alamıyorsun": kırık kalp + "0 Eşleşme" + etrafında
// solup giden (ghostlanan) mesaj balonları.
// ============================================================
class BrokenHeartCounter extends StatefulWidget {
  const BrokenHeartCounter({super.key});
  @override
  State<BrokenHeartCounter> createState() => _BrokenHeartCounterState();
}

class _BrokenHeartCounterState extends State<BrokenHeartCounter>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  static const _ghosts = [
    'Merhaba 👋',
    'Naber?',
    'Bu akşam ne yapıyorsun?',
    'Selam :)',
  ];

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 5))
      ..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 300,
      height: 300,
      child: Stack(
        alignment: Alignment.center,
        children: [
          for (var i = 0; i < _ghosts.length; i++)
            _GhostBubble(
              controller: _c,
              delay: i / _ghosts.length,
              angle: (i / _ghosts.length) * 2 * pi,
              text: _ghosts[i],
            ),
          // Merkez: nabız gibi atan kırık kalp + sayaç.
          AnimatedBuilder(
            animation: _c,
            builder: (_, child) {
              final pulse = 0.94 + (sin(_c.value * 2 * pi * 2) + 1) / 2 * 0.08;
              return Transform.scale(scale: pulse, child: child);
            },
            child: Container(
              width: 148,
              height: 148,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.goldSurface,
                border: Border.all(color: AppColors.gold, width: 2),
                boxShadow: const [
                  BoxShadow(
                      color: AppColors.goldGlow, blurRadius: 30, spreadRadius: 6),
                ],
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.heart_broken_rounded,
                      color: AppColors.gold, size: 34),
                  const SizedBox(height: 4),
                  const Text('0',
                      style: TextStyle(
                          color: Colors.white,
                          fontSize: 40,
                          fontWeight: FontWeight.w900)),
                  Text('Eşleşme',
                      style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.7),
                          fontSize: 13,
                          fontWeight: FontWeight.w700)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GhostBubble extends StatelessWidget {
  final AnimationController controller;
  final double delay;
  final double angle;
  final String text;
  const _GhostBubble({
    required this.controller,
    required this.delay,
    required this.angle,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (_, _) {
        final t = (controller.value + delay) % 1.0;
        // 0 -> belirir, 0.5 -> tam görünür, 1 -> soluk (ghostlandı).
        final opacity = t < 0.5 ? (t / 0.5) : (1 - (t - 0.5) / 0.5);
        final r = 118.0;
        final dx = cos(angle) * r;
        final dy = sin(angle) * r * 0.62;
        return Positioned(
          left: 150 + dx - 62,
          top: 150 + dy - 16,
          child: Opacity(
            opacity: (opacity * 0.85).clamp(0.0, 0.85),
            child: Container(
              width: 124,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.borderSubtle),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Colors.white70,
                            fontSize: 11,
                            fontWeight: FontWeight.w600)),
                  ),
                  const SizedBox(width: 4),
                  const Icon(Icons.close_rounded,
                      color: AppColors.gold, size: 13),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

// ============================================================
// EKRAN — "Kendini sorguluyorsun": ortada asık suratlı ikon,
// etrafında yüzen kuşku balonları.
// ============================================================
class DoubtBubblesCloud extends StatefulWidget {
  const DoubtBubblesCloud({super.key});
  @override
  State<DoubtBubblesCloud> createState() => _DoubtBubblesCloudState();
}

class _DoubtBubblesCloudState extends State<DoubtBubblesCloud>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  static const _doubts = [
    'Acaba çirkin miyim?',
    'Fakir mi duruyorum?',
    'Ezik miyim ben?',
  ];

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 3400))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 280,
      height: 280,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Positioned(
            top: 10,
            left: 8,
            child: _DoubtBubble(controller: _c, delay: 0.0, text: _doubts[0]),
          ),
          Positioned(
            top: 30,
            right: 0,
            child: _DoubtBubble(controller: _c, delay: 0.35, text: _doubts[1]),
          ),
          Positioned(
            bottom: 24,
            left: 30,
            child: _DoubtBubble(controller: _c, delay: 0.65, text: _doubts[2]),
          ),
          // Merkez: asık suratlı silüet.
          Container(
            width: 128,
            height: 128,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AppColors.surfaceElevated,
              border: Border.all(color: AppColors.borderSubtle, width: 2),
            ),
            child: const Icon(Icons.sentiment_dissatisfied_rounded,
                color: AppColors.textSecondary, size: 56),
          ),
        ],
      ),
    );
  }
}

class _DoubtBubble extends StatelessWidget {
  final AnimationController controller;
  final double delay;
  final String text;
  const _DoubtBubble(
      {required this.controller, required this.delay, required this.text});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (_, child) {
        final v = (controller.value + delay) % 1.0;
        final bob = sin(v * 2 * pi) * 6;
        return Transform.translate(offset: Offset(0, bob), child: child);
      },
      child: Container(
        constraints: const BoxConstraints(maxWidth: 148),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.gold.withValues(alpha: 0.4)),
        ),
        child: Text(text,
            style: const TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                height: 1.3)),
      ),
    );
  }
}

// ============================================================
// EKRAN — "Sorun sen değilsin": 1 kadına karşı 3 erkek oranı.
// ============================================================
class GenderRatioComparison extends StatelessWidget {
  const GenderRatioComparison({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 26),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _side(count: 1, icon: Icons.female_rounded, label: '1 Kadın'),
          const Icon(Icons.close_rounded,
              color: AppColors.textMuted, size: 22),
          _side(
              count: 3,
              icon: Icons.male_rounded,
              label: '3 Erkek',
              highlight: true),
        ],
      ),
    );
  }

  Widget _side(
      {required int count,
      required IconData icon,
      required String label,
      bool highlight = false}) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          spacing: 4,
          alignment: WrapAlignment.center,
          children: List.generate(
            count,
            (_) => Container(
              width: 46,
              height: 46,
              margin: const EdgeInsets.only(bottom: 4),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: highlight
                    ? AppColors.goldSurface
                    : AppColors.surfaceElevated,
                border: Border.all(
                    color: highlight
                        ? AppColors.gold
                        : AppColors.borderSubtle),
              ),
              child: Icon(icon,
                  color: highlight ? AppColors.gold : AppColors.textSecondary,
                  size: 24),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(label,
            style: TextStyle(
                color: highlight ? AppColors.gold : AppColors.textSecondary,
                fontSize: 13,
                fontWeight: FontWeight.w800)),
      ],
    );
  }
}

// ============================================================
// EKRAN — "0,1 saniyede karar": ortada kart, solda X sağda kalp,
// üstte "0,1 saniye" rozeti.
// ============================================================
class SwipeDecisionDemo extends StatefulWidget {
  const SwipeDecisionDemo({super.key});
  @override
  State<SwipeDecisionDemo> createState() => _SwipeDecisionDemoState();
}

class _SwipeDecisionDemoState extends State<SwipeDecisionDemo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1800))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(
            color: AppColors.gold,
            borderRadius: BorderRadius.circular(20),
            boxShadow: const [
              BoxShadow(
                  color: AppColors.goldGlow, blurRadius: 16, spreadRadius: 1),
            ],
          ),
          child: const Text('0,1 SANİYE',
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.5)),
        ),
        const SizedBox(height: 18),
        SizedBox(
          width: 260,
          height: 170,
          child: Stack(
            alignment: Alignment.center,
            children: [
              AnimatedBuilder(
                animation: _c,
                builder: (_, child) => Transform.rotate(
                  angle: (_c.value - 0.5) * 0.12,
                  child: child,
                ),
                child: Container(
                  width: 116,
                  height: 150,
                  decoration: BoxDecoration(
                    gradient: AppColors.cardGradient,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: AppColors.borderSubtle),
                    boxShadow: const [
                      BoxShadow(color: Colors.black54, blurRadius: 16),
                    ],
                  ),
                  child: const Icon(Icons.person_rounded,
                      color: AppColors.textMuted, size: 56),
                ),
              ),
              Positioned(
                left: 0,
                child: _decisionButton(Icons.close_rounded, AppColors.error),
              ),
              Positioned(
                right: 0,
                child: _decisionButton(Icons.favorite_rounded, AppColors.gold),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _decisionButton(IconData icon, Color color) {
    return Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: AppColors.surface,
        border: Border.all(color: color, width: 2),
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: 0.35), blurRadius: 14),
        ],
      ),
      child: Icon(icon, color: color, size: 26),
    );
  }
}

// ============================================================
// EKRAN — "Fotoğraf çekiciliği en önemli şey": kötü profil vs iyi profil.
// ============================================================
class ProfileAttractivenessCompare extends StatelessWidget {
  const ProfileAttractivenessCompare({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _card(
          label: 'Kötü Profil',
          badgeIcon: Icons.close_rounded,
          badgeColor: AppColors.error,
          dim: true,
        ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 10),
          child: Icon(Icons.arrow_forward_rounded,
              color: AppColors.gold, size: 26),
        ),
        _card(
          label: 'İyi Profil',
          badgeIcon: Icons.check_rounded,
          badgeColor: AppColors.success,
          dim: false,
        ),
      ],
    );
  }

  Widget _card({
    required String label,
    required IconData badgeIcon,
    required Color badgeColor,
    required bool dim,
  }) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              width: 118,
              height: 150,
              decoration: BoxDecoration(
                color: dim ? AppColors.surface : AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                    color: dim ? AppColors.borderSubtle : AppColors.gold,
                    width: dim ? 1 : 2),
                boxShadow: dim
                    ? null
                    : const [
                        BoxShadow(
                            color: AppColors.goldGlow,
                            blurRadius: 18,
                            spreadRadius: 1),
                      ],
              ),
              child: Icon(Icons.person_rounded,
                  color: dim
                      ? AppColors.textMuted.withValues(alpha: 0.5)
                      : AppColors.textSecondary,
                  size: 56),
            ),
            Positioned(
              top: -8,
              right: -8,
              child: Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: badgeColor,
                  border: Border.all(color: AppColors.background, width: 2),
                ),
                child: Icon(badgeIcon, color: Colors.white, size: 16),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(label,
            style: TextStyle(
                color: dim ? AppColors.textMuted : AppColors.textPrimary,
                fontSize: 12,
                fontWeight: FontWeight.w800)),
      ],
    );
  }
}

// ============================================================
// 3 sütunlu karşılaştırma tablosu (ChatGPT / Gemini / Voxen AI vb.)
// Ortadaki/son sütun vurgulanabilir (highlight).
// ============================================================
class ComparisonRow {
  final String text;
  final bool positive;
  const ComparisonRow(this.text, {this.positive = false});
}

class ComparisonColumn {
  final String title;
  final List<ComparisonRow> rows;
  final bool highlight;
  const ComparisonColumn(this.title, this.rows, {this.highlight = false});
}

class AiComparisonTable extends StatelessWidget {
  final List<ComparisonColumn> columns;
  const AiComparisonTable({super.key, required this.columns});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < columns.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Expanded(child: _column(columns[i])),
        ],
      ],
    );
  }

  Widget _column(ComparisonColumn c) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      decoration: BoxDecoration(
        color: c.highlight ? AppColors.goldSurface : AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
            color: c.highlight ? AppColors.gold : AppColors.borderSubtle,
            width: c.highlight ? 1.5 : 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(c.title,
              textAlign: TextAlign.center,
              style: TextStyle(
                  color: c.highlight ? AppColors.gold : AppColors.textPrimary,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900)),
          const SizedBox(height: 10),
          for (final r in c.rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    r.positive ? Icons.check_circle_rounded : Icons.cancel_rounded,
                    color: r.positive ? AppColors.success : AppColors.error,
                    size: 14,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(r.text,
                        style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w600,
                            height: 1.25)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ============================================================
// EKRAN — "Sizden gelenler": önce/sonra mini eşleşme telefonu.
// Belirli bir kullanıcıya atfedilmiş isim/foto/yıldız YOK — genel/temsili
// çıktı iddiası bir yorum gibi değil, bir grafik gibi sunulur (yasal koruma).
// ============================================================
class MatchesBeforeAfterPhone extends StatefulWidget {
  const MatchesBeforeAfterPhone({super.key});
  @override
  State<MatchesBeforeAfterPhone> createState() =>
      _MatchesBeforeAfterPhoneState();
}

class _MatchesBeforeAfterPhoneState extends State<MatchesBeforeAfterPhone>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1600))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            _phone(
                asset: 'assets/images/oncesi.jpg',
                label: 'Önce',
                caption: '0 Beğeni',
                highlight: false),
            AnimatedBuilder(
              animation: _c,
              builder: (_, child) => Transform.translate(
                  offset: Offset(_c.value * 6 - 3, 0), child: child),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: Icon(Icons.arrow_forward_rounded,
                    color: AppColors.gold, size: 26),
              ),
            ),
            _phone(
                asset: 'assets/images/sonrasi.jpg',
                label: 'Sonra',
                caption: '+58 Beğeni',
                highlight: true),
          ],
        ),
        const SizedBox(height: 12),
        const RepresentativeNote(),
      ],
    );
  }

  Widget _phone({
    required String asset,
    required String label,
    required String caption,
    required bool highlight,
  }) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          decoration: BoxDecoration(
            color: highlight ? AppColors.gold : AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(label,
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                  fontWeight: FontWeight.w900)),
        ),
        const SizedBox(height: 8),
        Container(
          width: 128,
          height: 262,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
                color: highlight ? AppColors.gold : AppColors.borderSubtle,
                width: highlight ? 2 : 1),
            boxShadow: highlight
                ? const [
                    BoxShadow(
                        color: AppColors.goldGlow,
                        blurRadius: 20,
                        spreadRadius: 1),
                  ]
                : null,
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(18),
            child: Image.asset(asset,
                fit: BoxFit.cover,
                alignment: Alignment.topCenter,
                errorBuilder: (_, _, _) => Container(
                    color: AppColors.surface,
                    child: const Icon(Icons.favorite_border_rounded,
                        color: Colors.white24, size: 30))),
          ),
        ),
        const SizedBox(height: 8),
        Text(caption,
            style: TextStyle(
                color: highlight ? AppColors.gold : AppColors.textMuted,
                fontSize: 14,
                fontWeight: FontWeight.w900)),
      ],
    );
  }
}

// ============================================================
// EKRAN — "Çıktılar": 4 stilden örnek AI çıktıları, yavaşça kayan iki
// sıra halinde (sonsuz döngü).
// ============================================================
class StyleOutputsGallery extends StatefulWidget {
  const StyleOutputsGallery({super.key});
  @override
  State<StyleOutputsGallery> createState() => _StyleOutputsGalleryState();
}

class _StyleOutputsGalleryState extends State<StyleOutputsGallery>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  static const _rowA = [
    ('elegance_1', 'Elegance'),
    ('nightout_1', 'Date Night'),
    ('traveller_2', 'Traveller'),
    ('oldmoney_1', 'Old Money'),
    ('elegance_2', 'Elegance'),
    ('nightout_2', 'Date Night'),
  ];
  static const _rowB = [
    ('oldmoney_2', 'Old Money'),
    ('traveller_1', 'Traveller'),
    ('elegance_3', 'Elegance'),
    ('nightout_3', 'Date Night'),
    ('oldmoney_3', 'Old Money'),
    ('traveller_3', 'Traveller'),
  ];

  static const double _tileW = 112;
  static const double _tileH = 150;
  static const double _gap = 10;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 18))
      ..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _row(_rowA, reverse: false),
        const SizedBox(height: _gap),
        _row(_rowB, reverse: true),
        const SizedBox(height: 12),
        const RepresentativeNote(),
      ],
    );
  }

  Widget _row(List<(String, String)> items, {required bool reverse}) {
    final loopW = items.length * (_tileW + _gap);
    return SizedBox(
      height: _tileH,
      child: ClipRect(
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, _) {
            final t = reverse ? 1 - _c.value : _c.value;
            return OverflowBox(
              alignment: Alignment.centerLeft,
              maxWidth: double.infinity,
              child: Transform.translate(
                offset: Offset(-t * loopW, 0),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (var k = 0; k < 2; k++)
                      for (final it in items) _tile(it.$1, it.$2),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _tile(String key, String label) {
    return Container(
      width: _tileW,
      height: _tileH,
      margin: const EdgeInsets.only(right: _gap),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(13),
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.asset('assets/dating/styles/$key.jpg',
                fit: BoxFit.cover,
                alignment: Alignment.topCenter,
                errorBuilder: (_, _, _) =>
                    Container(color: AppColors.surfaceElevated)),
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Colors.transparent, Colors.black87],
                  begin: Alignment.center,
                  end: Alignment.bottomCenter,
                ),
              ),
            ),
            Positioned(
              left: 8,
              bottom: 6,
              child: Text(label,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w900)),
            ),
          ],
        ),
      ),
    );
  }
}
