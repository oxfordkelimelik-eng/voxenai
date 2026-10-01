import 'dart:math';
import 'package:flutter/material.dart';

/// Onboarding funnel ekranları (2026-09-30, kullanıcının referans tasarımları).
///
/// Metin, buton, çerçeve, neon ışık ve grafikler KODLA çizilir (keskin kalır,
/// animasyonludur); fotoğraflar kullanıcının verdiği tasarımlardan kesilmiş
/// parçalardır (assets/dating/funnel/parts/). Her ekranın görsel alanı sabit
/// 340 genişlikli bir tuvalde tasarlanır ve FittedBox ile ekrana ölçeklenir —
/// küçük/büyük telefonda taşma olmaz.

const _red = Color(0xFFFF2D55);
const _redLight = Color(0xFFFF7A95);
const _redDeep = Color(0xFFD1123F);
const _green = Color(0xFF22C55E);
const _glass = Color(0xCC15121A);

Widget _part(String name, {Alignment alignment = Alignment.center}) =>
    Image.asset(
      'assets/dating/funnel/parts/$name.jpg',
      fit: BoxFit.cover,
      alignment: alignment,
      filterQuality: FilterQuality.high,
      errorBuilder: (_, _, _) => Container(color: const Color(0xFF1A1A1E)),
    );

// ============================================================
// SAYFA İSKELETİ
// ============================================================

/// Ortak funnel sayfası: ışık hüzmeli arka plan → logo → (adım etiketi) →
/// iki renkli başlık → açıklama → ölçeklenen görsel → parlayan CTA.
///
/// Başlık/açıklama işaretleri: `##metin##` kırmızı vurgu, `**metin**` kalın
/// beyaz.
class FunnelPage extends StatelessWidget {
  final List<String> headline;
  final String? sub;
  final String? subSmall;
  final String? step;
  final Widget visual;
  final Size canvas;
  final String cta;
  final bool ctaArrow;
  final VoidCallback onNext;
  final VoidCallback? onBack;
  final double headlineSize;

  const FunnelPage({
    super.key,
    required this.headline,
    required this.visual,
    required this.canvas,
    required this.onNext,
    this.onBack,
    this.sub,
    this.subSmall,
    this.step,
    this.cta = 'Devam Et',
    this.ctaArrow = false,
    this.headlineSize = 32,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          const Positioned.fill(child: FunnelBackground()),
          SafeArea(
            child: Column(
              children: [
                _FadeUp(
                  delay: 0,
                  child: SizedBox(
                    height: 44,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        const _Logo(),
                        if (onBack != null)
                          Align(
                            alignment: Alignment.centerLeft,
                            child: IconButton(
                              onPressed: onBack,
                              icon: const Icon(
                                Icons.arrow_back_ios_new_rounded,
                                size: 17,
                                color: Colors.white54,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                if (step != null) ...[
                  const SizedBox(height: 4),
                  _FadeUp(delay: 60, child: _StepPill(step!)),
                ],
                const SizedBox(height: 6),
                _FadeUp(
                  delay: 120,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    child: _Headline(headline, size: headlineSize),
                  ),
                ),
                if (sub != null) ...[
                  const SizedBox(height: 8),
                  _FadeUp(
                    delay: 220,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 26),
                      child: _RichLine(
                        sub!,
                        size: 13.5,
                        color: const Color(0xFFD9D4D6),
                      ),
                    ),
                  ),
                ],
                if (subSmall != null) ...[
                  const SizedBox(height: 4),
                  _FadeUp(
                    delay: 260,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 30),
                      child: _RichLine(
                        subSmall!,
                        size: 11,
                        color: const Color(0xFF9C9498),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                Expanded(
                  child: _FadeUp(
                    delay: 320,
                    scaleFrom: 0.94,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Center(
                        child: FittedBox(
                          fit: BoxFit.contain,
                          child: SizedBox(
                            width: canvas.width,
                            height: canvas.height,
                            child: visual,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                _FadeUp(
                  delay: 450,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
                    child: FunnelCta(
                      label: cta,
                      arrow: ctaArrow,
                      onTap: onNext,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Logo extends StatelessWidget {
  const _Logo();
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: _red.withValues(alpha: 0.7)),
            gradient: const LinearGradient(
              colors: [Color(0xFF3A0A16), Color(0xFF12060A)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            boxShadow: [
              BoxShadow(color: _red.withValues(alpha: 0.45), blurRadius: 12),
            ],
          ),
          child: const Icon(Icons.show_chart_rounded, color: _red, size: 20),
        ),
        const SizedBox(width: 8),
        const Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: 'Voxen ',
                style: TextStyle(color: Colors.white),
              ),
              TextSpan(
                text: 'AI',
                style: TextStyle(color: _red),
              ),
            ],
          ),
          style: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.2,
          ),
        ),
      ],
    );
  }
}

class _StepPill extends StatelessWidget {
  final String label;
  const _StepPill(this.label);
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 3),
      decoration: BoxDecoration(
        color: _red.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _red.withValues(alpha: 0.8)),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: _redLight,
          fontSize: 12,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

/// `##vurgu##` ve `**kalın**` işaretlerini parçalar.
List<InlineSpan> _spans(
  String text,
  TextStyle base,
  TextStyle accent,
  TextStyle bold,
) {
  final out = <InlineSpan>[];
  final re = RegExp(r'(##.+?##|\*\*.+?\*\*)');
  var i = 0;
  for (final m in re.allMatches(text)) {
    if (m.start > i)
      out.add(TextSpan(text: text.substring(i, m.start), style: base));
    final t = m.group(0)!;
    out.add(
      TextSpan(
        text: t.substring(2, t.length - 2),
        style: t.startsWith('##') ? accent : bold,
      ),
    );
    i = m.end;
  }
  if (i < text.length) out.add(TextSpan(text: text.substring(i), style: base));
  return out;
}

/// Büyük iki renkli başlık. Her satır kendi başına genişliğe sığdırılır.
class _Headline extends StatelessWidget {
  final List<String> lines;
  final double size;
  const _Headline(this.lines, {required this.size});

  @override
  Widget build(BuildContext context) {
    final base = TextStyle(
      color: Colors.white,
      fontSize: size,
      fontWeight: FontWeight.w900,
      height: 1.08,
      letterSpacing: -0.6,
      shadows: [
        Shadow(color: Colors.white.withValues(alpha: 0.25), blurRadius: 14),
      ],
    );
    // TextStyle'da color ve foreground aynı anda olamaz — vurgu stili sıfırdan.
    final accent = TextStyle(
      fontSize: size,
      fontWeight: FontWeight.w900,
      height: 1.08,
      letterSpacing: -0.6,
      foreground: Paint()
        ..shader = const LinearGradient(
          colors: [_redLight, _red],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ).createShader(Rect.fromLTWH(0, 0, 10, size * 1.1)),
      shadows: [Shadow(color: _red.withValues(alpha: 0.65), blurRadius: 18)],
    );
    return Column(
      children: [
        for (final l in lines)
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text.rich(
              TextSpan(children: _spans(l, base, accent, base)),
              textAlign: TextAlign.center,
              maxLines: 1,
            ),
          ),
      ],
    );
  }
}

class _RichLine extends StatelessWidget {
  final String text;
  final double size;
  final Color color;
  const _RichLine(this.text, {required this.size, required this.color});

  @override
  Widget build(BuildContext context) {
    final base = TextStyle(
      color: color,
      fontSize: size,
      height: 1.35,
      fontWeight: FontWeight.w500,
    );
    return Text.rich(
      TextSpan(
        children: _spans(
          text,
          base,
          base.copyWith(color: _red, fontWeight: FontWeight.w800),
          base.copyWith(color: Colors.white, fontWeight: FontWeight.w800),
        ),
      ),
      textAlign: TextAlign.center,
    );
  }
}

/// Parlayan, hafifçe nabız atan kırmızı CTA.
class FunnelCta extends StatefulWidget {
  final String label;
  final bool arrow;
  final VoidCallback onTap;
  const FunnelCta({
    super.key,
    required this.label,
    required this.onTap,
    this.arrow = false,
  });

  @override
  State<FunnelCta> createState() => _FunnelCtaState();
}

class _FunnelCtaState extends State<FunnelCta>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat(reverse: true);
  bool _down = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: (_) => setState(() => _down = true),
      onTapCancel: () => setState(() => _down = false),
      onTapUp: (_) {
        setState(() => _down = false);
        widget.onTap();
      },
      child: AnimatedScale(
        scale: _down ? 0.97 : 1,
        duration: const Duration(milliseconds: 90),
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, child) => Container(
            height: 58,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(30),
              gradient: const LinearGradient(
                colors: [Color(0xFFFF4D72), _red, _redDeep],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              border: Border.all(
                color: Colors.white.withValues(alpha: 0.22),
                width: 1,
              ),
              boxShadow: [
                BoxShadow(
                  color: _red.withValues(alpha: 0.35 + 0.25 * _c.value),
                  blurRadius: 18 + 12 * _c.value,
                  spreadRadius: 1,
                ),
              ],
            ),
            child: child,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                widget.label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                ),
              ),
              if (widget.arrow) ...[
                const SizedBox(width: 10),
                const Icon(
                  Icons.arrow_forward_rounded,
                  color: Colors.white,
                  size: 24,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Siyah zemin + yavaşça kayan kırmızı ışık hüzmeleri + köşe ışımaları.
class FunnelBackground extends StatefulWidget {
  const FunnelBackground({super.key});
  @override
  State<FunnelBackground> createState() => _FunnelBackgroundState();
}

class _FunnelBackgroundState extends State<FunnelBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 9),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, _) => CustomPaint(painter: _BeamsPainter(_c.value)),
      ),
    );
  }
}

class _BeamsPainter extends CustomPainter {
  final double t;
  _BeamsPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.black);
    void glow(Offset c, double r, double a) {
      canvas.drawCircle(
        c,
        r,
        Paint()
          ..shader = RadialGradient(
            colors: [
              _red.withValues(alpha: a),
              _red.withValues(alpha: 0),
            ],
          ).createShader(Rect.fromCircle(center: c, radius: r)),
      );
    }

    glow(Offset(w * 0.05, h * 0.02), w * 0.55, 0.22);
    glow(Offset(w * 1.0, h * 0.35), w * 0.5, 0.16);
    glow(Offset(w * 0.0, h * 0.8), w * 0.55, 0.14);

    void beam(
      double x0,
      double y0,
      double x1,
      double y1,
      double width,
      double alpha,
    ) {
      final p = Paint()
        ..strokeWidth = width
        ..strokeCap = StrokeCap.round
        ..shader = LinearGradient(
          colors: [
            _red.withValues(alpha: 0),
            _red.withValues(alpha: alpha),
            _redLight.withValues(alpha: alpha * 0.9),
            _red.withValues(alpha: 0),
          ],
          stops: const [0, 0.45, 0.55, 1],
        ).createShader(Rect.fromPoints(Offset(x0, y0), Offset(x1, y1)))
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, width * 0.9);
      canvas.drawLine(Offset(x0, y0), Offset(x1, y1), p);
      final core = Paint()
        ..strokeWidth = max(1.2, width * 0.12)
        ..shader = LinearGradient(
          colors: [
            Colors.white.withValues(alpha: 0),
            Colors.white.withValues(alpha: alpha * 0.55),
            Colors.white.withValues(alpha: 0),
          ],
        ).createShader(Rect.fromPoints(Offset(x0, y0), Offset(x1, y1)));
      canvas.drawLine(Offset(x0, y0), Offset(x1, y1), core);
    }

    final d = (t - 0.5) * 30;
    beam(-w * 0.2, h * 0.30 + d, w * 1.2, h * 0.02 + d, 16, 0.55);
    beam(-w * 0.1, h * 0.72 - d, w * 1.2, h * 0.52 - d, 12, 0.45);
    beam(w * 0.6, -h * 0.05, w * 1.3, h * 0.25 + d, 10, 0.4);
    beam(-w * 0.3, h * 0.98 + d, w * 0.9, h * 0.82 + d, 14, 0.4);

    // Kenar kararması.
    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = RadialGradient(
          radius: 0.95,
          colors: [Colors.transparent, Colors.black.withValues(alpha: 0.55)],
        ).createShader(Offset.zero & size),
    );
  }

  @override
  bool shouldRepaint(_BeamsPainter old) => old.t != t;
}

// ============================================================
// ANİMASYON YARDIMCILARI
// ============================================================

class _FadeUp extends StatelessWidget {
  final Widget child;
  final int delay; // ms
  final double scaleFrom;
  const _FadeUp({required this.child, required this.delay, this.scaleFrom = 1});

  @override
  Widget build(BuildContext context) {
    final total = delay + 550;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: total),
      curve: Interval(delay / total, 1, curve: Curves.easeOutCubic),
      builder: (_, v, c) => Opacity(
        opacity: v,
        child: Transform.translate(
          offset: Offset(0, (1 - v) * 18),
          child: Transform.scale(
            scale: scaleFrom + (1 - scaleFrom) * v,
            child: c,
          ),
        ),
      ),
      child: child,
    );
  }
}

/// Sonsuz, yumuşak süzülme (yukarı-aşağı + hafif dönüş).
class Floaty extends StatefulWidget {
  final Widget child;
  final double dy;
  final double rot;
  final int periodMs;
  final double phase;
  const Floaty({
    super.key,
    required this.child,
    this.dy = 5,
    this.rot = 0.02,
    this.periodMs = 2600,
    this.phase = 0,
  });
  @override
  State<Floaty> createState() => _FloatyState();
}

class _FloatyState extends State<Floaty> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(
          vsync: this,
          duration: Duration(milliseconds: widget.periodMs),
        )
        ..value = widget.phase
        ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, c) {
        final v = Curves.easeInOut.transform(_c.value) * 2 - 1;
        return Transform.translate(
          offset: Offset(0, v * widget.dy),
          child: Transform.rotate(angle: v * widget.rot, child: c),
        );
      },
      child: widget.child,
    );
  }
}

/// Nabız (ölçek) animasyonu.
class Pulse extends StatefulWidget {
  final Widget child;
  final double amount;
  final int periodMs;
  const Pulse({
    super.key,
    required this.child,
    this.amount = 0.08,
    this.periodMs = 1100,
  });
  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Duration(milliseconds: widget.periodMs),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, c) => Transform.scale(
        scale: 1 + widget.amount * Curves.easeInOut.transform(_c.value),
        child: c,
      ),
      child: widget.child,
    );
  }
}

/// Gecikmeli beliren öğe (listeler için).
class _Appear extends StatelessWidget {
  final Widget child;
  final int delay;
  final Offset from;
  const _Appear({
    required this.child,
    required this.delay,
    this.from = const Offset(0, 14),
  });

  @override
  Widget build(BuildContext context) {
    final total = delay + 500;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: total),
      curve: Interval(delay / total, 1, curve: Curves.easeOutBack),
      builder: (_, v, c) => Opacity(
        opacity: v.clamp(0.0, 1.0),
        child: Transform.translate(offset: from * (1 - v), child: c),
      ),
      child: child,
    );
  }
}

// ============================================================
// ORTAK GÖRSEL PARÇALAR
// ============================================================

/// Neon çerçeveli fotoğraf kartı.
class GlowFrame extends StatelessWidget {
  final Widget child;
  final double width, height;
  final double radius;
  final Color color;
  final double glow;
  final double borderWidth;
  final double angle;
  final bool dim;
  const GlowFrame({
    super.key,
    required this.child,
    required this.width,
    required this.height,
    this.radius = 12,
    this.color = _red,
    this.glow = 1,
    this.borderWidth = 1.5,
    this.angle = 0,
    this.dim = false,
  });

  @override
  Widget build(BuildContext context) {
    Widget inner = ClipRRect(
      borderRadius: BorderRadius.circular(radius - borderWidth),
      child: dim
          ? ColorFiltered(
              colorFilter: ColorFilter.mode(
                Colors.black.withValues(alpha: 0.35),
                BlendMode.darken,
              ),
              child: child,
            )
          : child,
    );
    return Transform.rotate(
      angle: angle,
      child: Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(
            color: color.withValues(alpha: 0.9),
            width: borderWidth,
          ),
          boxShadow: glow > 0
              ? [
                  BoxShadow(
                    color: color.withValues(alpha: 0.5 * glow),
                    blurRadius: 18 * glow,
                    spreadRadius: 0.5,
                  ),
                ]
              : null,
        ),
        child: inner,
      ),
    );
  }
}

/// Beyaz kenarlı polaroid.
class Polaroid extends StatelessWidget {
  final Widget child;
  final double width, height;
  final double angle;
  final String? label;
  const Polaroid({
    super.key,
    required this.child,
    required this.width,
    required this.height,
    this.angle = 0,
    this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Transform.rotate(
      angle: angle,
      child: Container(
        width: width,
        height: height,
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 12),
        decoration: BoxDecoration(
          color: const Color(0xFFF3EFEF),
          borderRadius: BorderRadius.circular(4),
          boxShadow: [
            BoxShadow(color: _red.withValues(alpha: 0.45), blurRadius: 18),
            const BoxShadow(color: Colors.black54, blurRadius: 8),
          ],
        ),
        child: ClipRRect(borderRadius: BorderRadius.circular(2), child: child),
      ),
    );
  }
}

/// Neon kalp kutucuğu.
class NeonHeart extends StatelessWidget {
  final double size;
  const NeonHeart({super.key, this.size = 28});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.3),
        gradient: const LinearGradient(
          colors: [_redLight, _red],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        boxShadow: [
          BoxShadow(color: _red.withValues(alpha: 0.8), blurRadius: size * 0.7),
        ],
      ),
      child: Icon(
        Icons.favorite_rounded,
        color: Colors.white,
        size: size * 0.6,
      ),
    );
  }
}

Widget _xBadge(double s) => Container(
  width: s,
  height: s,
  decoration: BoxDecoration(
    shape: BoxShape.circle,
    color: Colors.black.withValues(alpha: 0.55),
    border: Border.all(color: _red, width: 1.6),
    boxShadow: [BoxShadow(color: _red.withValues(alpha: 0.5), blurRadius: 8)],
  ),
  child: Icon(Icons.close_rounded, color: _red, size: s * 0.62),
);

Widget _heartBadge(double s, {Color color = _red}) => Container(
  width: s,
  height: s,
  decoration: BoxDecoration(
    shape: BoxShape.circle,
    color: color,
    border: Border.all(color: Colors.white, width: 1.6),
    boxShadow: [BoxShadow(color: color.withValues(alpha: 0.7), blurRadius: 12)],
  ),
  child: Icon(Icons.favorite_rounded, color: Colors.white, size: s * 0.55),
);

/// Telefon gövdesi (dinamik ada + neon/gri çerçeve).
class PhoneFrame extends StatelessWidget {
  final double width, height;
  final Widget screen;
  final bool neon;
  final Color screenColor;
  const PhoneFrame({
    super.key,
    required this.width,
    required this.height,
    required this.screen,
    this.neon = false,
    this.screenColor = Colors.white,
  });

  @override
  Widget build(BuildContext context) {
    final r = width * 0.16;
    return Container(
      width: width,
      height: height,
      padding: EdgeInsets.all(width * 0.035),
      decoration: BoxDecoration(
        color: const Color(0xFF0B0B0D),
        borderRadius: BorderRadius.circular(r),
        border: Border.all(
          color: neon ? _red : const Color(0xFF4A4A52),
          width: 2,
        ),
        boxShadow: [
          BoxShadow(
            color: neon
                ? _red.withValues(alpha: 0.6)
                : _red.withValues(alpha: 0.18),
            blurRadius: neon ? 30 : 26,
            spreadRadius: neon ? 1 : 0,
          ),
          const BoxShadow(color: Colors.black87, blurRadius: 16),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(r - width * 0.035),
        child: Stack(
          fit: StackFit.expand,
          children: [
            ColoredBox(color: screenColor),
            screen,
            Align(
              alignment: Alignment.topCenter,
              child: Container(
                margin: EdgeInsets.only(top: width * 0.03),
                width: width * 0.32,
                height: width * 0.085,
                decoration: BoxDecoration(
                  color: Colors.black,
                  borderRadius: BorderRadius.circular(20),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Widget _statusBar(double w, Color c) => Padding(
  padding: EdgeInsets.fromLTRB(w * 0.09, w * 0.035, w * 0.08, 0),
  child: Row(
    children: [
      Text(
        '9:41',
        style: TextStyle(
          color: c,
          fontSize: w * 0.05,
          fontWeight: FontWeight.w700,
        ),
      ),
      const Spacer(),
      Icon(Icons.signal_cellular_alt_rounded, color: c, size: w * 0.055),
      SizedBox(width: w * 0.01),
      Icon(Icons.wifi_rounded, color: c, size: w * 0.055),
      SizedBox(width: w * 0.01),
      Icon(Icons.battery_full_rounded, color: c, size: w * 0.06),
    ],
  ),
);

/// Parlayan kıvrık ok.
class CurvedArrow extends StatelessWidget {
  final Offset from, to, control;
  final Color color;
  const CurvedArrow({
    super.key,
    required this.from,
    required this.to,
    required this.control,
    this.color = _red,
  });

  @override
  Widget build(BuildContext context) =>
      CustomPaint(painter: _ArrowPainter(from, to, control, color));
}

class _ArrowPainter extends CustomPainter {
  final Offset a, b, c;
  final Color color;
  _ArrowPainter(this.a, this.b, this.c, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..moveTo(a.dx, a.dy)
      ..quadraticBezierTo(c.dx, c.dy, b.dx, b.dy);
    final glow = Paint()
      ..color = color.withValues(alpha: 0.6)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 5
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4);
    final line = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    canvas.drawPath(path, glow);
    canvas.drawPath(path, line);
    final dir = (b - c);
    final ang = atan2(dir.dy, dir.dx);
    Offset p(double da, double l) =>
        b - Offset(cos(ang + da), sin(ang + da)) * l;
    final head = Path()
      ..moveTo(p(0.5, 9).dx, p(0.5, 9).dy)
      ..lineTo(b.dx, b.dy)
      ..lineTo(p(-0.5, 9).dx, p(-0.5, 9).dy);
    canvas.drawPath(head, glow);
    canvas.drawPath(head, line);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Koyu cam kart.
class GlassCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final Color border;
  final bool neon;
  const GlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(10),
    this.radius = 14,
    this.border = const Color(0x33FFFFFF),
    this.neon = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: _glass,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: neon ? _red : border, width: neon ? 1.6 : 1),
        boxShadow: neon
            ? [BoxShadow(color: _red.withValues(alpha: 0.55), blurRadius: 20)]
            : const [BoxShadow(color: Colors.black54, blurRadius: 10)],
      ),
      child: child,
    );
  }
}

// ============================================================
// 1 — KARŞILAMA (eşleşme listeli telefon)
// ============================================================

class WelcomeVisual extends StatelessWidget {
  const WelcomeVisual({super.key});
  static const size = Size(340, 400);

  static const _names = [
    'Merve',
    'Defne',
    'Ece',
    'Zeynep',
    'Duru',
    'Nisa',
    'Lara',
    'Aslı',
  ];

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        // Sağ: 3D yüz taraması
        Positioned(
          right: -6,
          top: 0,
          width: 96,
          height: 210,
          child: ShaderMask(
            shaderCallback: (r) => const LinearGradient(
              colors: [Colors.transparent, Colors.white],
              stops: [0, 0.35],
            ).createShader(r),
            blendMode: BlendMode.dstIn,
            child: Stack(
              fit: StackFit.expand,
              children: [
                _part('08_w_scan', alignment: Alignment.centerRight),
                const _ScanLine(),
              ],
            ),
          ),
        ),
        const Positioned(
          right: 36,
          top: 180,
          width: 60,
          height: 70,
          child: CurvedArrow(
            from: Offset(40, 0),
            to: Offset(48, 62),
            control: Offset(4, 30),
          ),
        ),
        Positioned(
          right: 4,
          top: 232,
          child: Floaty(
            phase: 0.3,
            child: GlowFrame(
              width: 68,
              height: 84,
              angle: 0.1,
              child: _part('08_w_sm1'),
            ),
          ),
        ),
        Positioned(
          right: 0,
          top: 316,
          child: Floaty(
            phase: 0.7,
            child: GlowFrame(
              width: 72,
              height: 84,
              angle: -0.07,
              child: _part('08_w_sm2'),
            ),
          ),
        ),
        // Sol: polaroidler + neon kalpler
        Positioned(
          left: 4,
          top: 118,
          child: Floaty(
            rot: 0.03,
            child: Polaroid(
              width: 78,
              height: 96,
              angle: -0.12,
              child: _part('08_w_pol1'),
            ),
          ),
        ),
        Positioned(
          left: -2,
          top: 214,
          child: Floaty(
            phase: 0.5,
            rot: 0.03,
            child: Polaroid(
              width: 80,
              height: 98,
              angle: 0.08,
              child: _part('08_w_pol2'),
            ),
          ),
        ),
        const Positioned(
          left: 36,
          top: 60,
          child: Floaty(dy: 7, child: NeonHeart(size: 30)),
        ),
        const Positioned(
          left: 8,
          top: 318,
          child: Floaty(phase: 0.4, dy: 6, child: NeonHeart(size: 26)),
        ),
        const Positioned(
          left: 44,
          top: 356,
          child: Floaty(phase: 0.8, dy: 6, child: NeonHeart(size: 30)),
        ),
        // Orta: telefon
        Positioned(
          left: 82,
          top: 6,
          child: PhoneFrame(
            width: 184,
            height: 390,
            screen: _matchesScreen(184),
          ),
        ),
      ],
    );
  }

  Widget _matchesScreen(double w) {
    return Column(
      children: [
        _statusBar(w, Colors.black87),
        const SizedBox(height: 10),
        const Text(
          'Matches',
          style: TextStyle(
            color: Colors.black87,
            fontSize: 11,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 6),
        Expanded(
          child: Column(
            children: [
              for (var i = 0; i < _names.length; i++)
                _Appear(
                  delay: 500 + i * 110,
                  from: const Offset(24, 0),
                  child: _matchRow(i),
                ),
            ],
          ),
        ),
        Container(
          height: 34,
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Color(0x14000000))),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              Text(
                'H',
                style: TextStyle(
                  color: Colors.black87,
                  fontWeight: FontWeight.w900,
                  fontSize: 14,
                ),
              ),
              Icon(Icons.star_border_rounded, size: 17, color: Colors.black54),
              Icon(
                Icons.favorite_border_rounded,
                size: 17,
                color: Colors.black54,
              ),
              Icon(
                Icons.chat_bubble_outline_rounded,
                size: 16,
                color: Colors.black54,
              ),
              Icon(
                Icons.person_outline_rounded,
                size: 17,
                color: Colors.black54,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _matchRow(int i) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 3, 8, 3),
      child: Row(
        children: [
          SizedBox(
            width: 30,
            height: 30,
            child: Stack(
              children: [
                ClipOval(
                  child: SizedBox(
                    width: 30,
                    height: 30,
                    child: _part('08_av${i % 7}'),
                  ),
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: _green,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 1.2),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _names[i],
                  style: const TextStyle(
                    color: Colors.black87,
                    fontSize: 9.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const Text(
                  'Sohbete başla',
                  style: TextStyle(color: Colors.black38, fontSize: 7.5),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
            decoration: BoxDecoration(
              color: _red,
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Text(
              'Sohbete başla',
              style: TextStyle(
                color: Colors.white,
                fontSize: 6.5,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Yüz taramasının üstünde aşağı-yukarı gezen kırmızı tarama çizgisi.
class _ScanLine extends StatefulWidget {
  const _ScanLine();
  @override
  State<_ScanLine> createState() => _ScanLineState();
}

class _ScanLineState extends State<_ScanLine>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (_, box) => AnimatedBuilder(
        animation: _c,
        builder: (_, _) {
          final y = Curves.easeInOut.transform(_c.value) * box.maxHeight;
          return Stack(
            children: [
              Positioned(
                top: y - 1,
                left: 0,
                right: 0,
                child: Container(
                  height: 2,
                  decoration: BoxDecoration(
                    color: _redLight,
                    boxShadow: [
                      BoxShadow(
                        color: _red.withValues(alpha: 0.9),
                        blurRadius: 10,
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

// ============================================================
// 2 — EŞLEŞME ALAMIYORSUN
// ============================================================

class NoMatchVisual extends StatelessWidget {
  const NoMatchVisual({super.key});
  static const size = Size(340, 420);

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(
          left: 6,
          top: 14,
          child: Floaty(
            child: GlowFrame(
              width: 74,
              height: 96,
              angle: -0.14,
              dim: true,
              glow: 0.6,
              child: _part('02_g1'),
            ),
          ),
        ),
        Positioned(
          left: -4,
          top: 150,
          child: Floaty(
            phase: 0.5,
            child: GlowFrame(
              width: 80,
              height: 104,
              angle: 0.06,
              dim: true,
              glow: 0.6,
              child: _part('02_g2'),
            ),
          ),
        ),
        Positioned(
          right: 4,
          top: 30,
          child: Floaty(
            phase: 0.3,
            child: GlowFrame(
              width: 72,
              height: 98,
              angle: 0.13,
              dim: true,
              glow: 0.6,
              child: _part('02_g3'),
            ),
          ),
        ),
        Positioned(
          right: -2,
          top: 160,
          child: Floaty(
            phase: 0.8,
            child: GlowFrame(
              width: 66,
              height: 104,
              angle: -0.08,
              dim: true,
              glow: 0.6,
              child: _part('02_g4'),
            ),
          ),
        ),
        Positioned(
          left: 72,
          top: 4,
          child: PhoneFrame(
            width: 196,
            height: 380,
            neon: true,
            screenColor: const Color(0xFF0E0D10),
            screen: Column(
              children: [
                _statusBar(196, Colors.white70),
                const SizedBox(height: 14),
                const Icon(
                  Icons.local_fire_department_rounded,
                  color: _red,
                  size: 26,
                ),
                const Spacer(),
                Pulse(
                  child: Icon(
                    Icons.heart_broken_rounded,
                    color: _red,
                    size: 60,
                    shadows: [
                      Shadow(
                        color: _red.withValues(alpha: 0.9),
                        blurRadius: 24,
                      ),
                    ],
                  ),
                ),
                Text(
                  '0',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 64,
                    height: 1,
                    fontWeight: FontWeight.w900,
                    shadows: [
                      Shadow(
                        color: _red.withValues(alpha: 0.9),
                        blurRadius: 22,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Eşleşme',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const Spacer(flex: 2),
                const Padding(
                  padding: EdgeInsets.only(bottom: 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      Icon(
                        Icons.local_fire_department_rounded,
                        size: 17,
                        color: _red,
                      ),
                      Icon(
                        Icons.grid_view_rounded,
                        size: 16,
                        color: Colors.white38,
                      ),
                      Icon(Icons.auto_awesome, size: 16, color: Colors.white38),
                      Icon(
                        Icons.chat_bubble_outline_rounded,
                        size: 16,
                        color: Colors.white38,
                      ),
                      Icon(
                        Icons.person_outline_rounded,
                        size: 17,
                        color: Colors.white38,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        Positioned(
          left: 0,
          top: 262,
          child: _Appear(
            delay: 700,
            child: _bubble('02_g1', 'Merhaba 👋', 'Görüldü 12:02'),
          ),
        ),
        Positioned(
          right: 0,
          top: 292,
          child: _Appear(
            delay: 950,
            child: _bubble('02_g3', 'Nasılsın?', 'Görüldü 18:32'),
          ),
        ),
        Positioned(
          left: 8,
          top: 330,
          child: _Appear(
            delay: 1200,
            child: _bubble('02_g2', 'Bu hafta müsait misin?', 'Görüldü 20:01'),
          ),
        ),
        Positioned(
          right: 4,
          top: 362,
          child: _Appear(
            delay: 1450,
            child: _bubble('02_g4', 'Bir kahve içelim mi?', 'Görüldü 22:05'),
          ),
        ),
      ],
    );
  }

  Widget _bubble(String avatar, String text, String seen) {
    return GlassCard(
      padding: const EdgeInsets.fromLTRB(6, 6, 10, 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipOval(
            child: SizedBox(
              width: 24,
              height: 24,
              child: ColorFiltered(
                colorFilter: const ColorFilter.matrix([
                  0.33, 0.33, 0.33, 0, 0, //
                  0.33, 0.33, 0.33, 0, 0, //
                  0.33, 0.33, 0.33, 0, 0, //
                  0, 0, 0, 1, 0,
                ]),
                child: _part(avatar),
              ),
            ),
          ),
          const SizedBox(width: 7),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                text,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 2),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    seen,
                    style: const TextStyle(
                      color: Colors.white38,
                      fontSize: 7.5,
                    ),
                  ),
                  const SizedBox(width: 3),
                  const Icon(
                    Icons.done_all_rounded,
                    size: 10,
                    color: Colors.white38,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ============================================================
// 3 — KENDİNİ SORGULUYORSUN
// ============================================================

class SelfDoubtVisual extends StatelessWidget {
  const SelfDoubtVisual({super.key});
  static const size = Size(340, 430);

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(
          left: -12,
          right: -12,
          top: 96,
          bottom: 0,
          child: ShaderMask(
            shaderCallback: (r) => const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Colors.transparent,
                Colors.white,
                Colors.white,
                Colors.transparent,
              ],
              stops: [0, 0.22, 0.85, 1],
            ).createShader(r),
            blendMode: BlendMode.dstIn,
            child: _KenBurns(child: _part('03_scene')),
          ),
        ),
        Positioned(
          left: 0,
          top: 6,
          child: Floaty(
            child: GlowFrame(
              width: 64,
              height: 92,
              angle: -0.15,
              glow: 0.7,
              child: _part('03_c1'),
            ),
          ),
        ),
        Positioned(
          right: 0,
          top: 20,
          child: Floaty(
            phase: 0.6,
            child: GlowFrame(
              width: 58,
              height: 90,
              angle: 0.13,
              glow: 0.7,
              child: _part('03_c2'),
            ),
          ),
        ),
        const Positioned(
          left: 50,
          top: 118,
          child: _Appear(
            delay: 500,
            child: Floaty(
              dy: 4,
              child: _ThoughtBubble(
                'Acaba\nçirkin miyim?',
                angle: -0.1,
                tailRight: true,
              ),
            ),
          ),
        ),
        const Positioned(
          left: 118,
          top: 44,
          child: _Appear(
            delay: 800,
            child: Floaty(
              phase: 0.4,
              dy: 4,
              child: _ThoughtBubble(
                'Fakir mi\nduruyorum yoksa?',
                angle: -0.05,
                tailRight: true,
              ),
            ),
          ),
        ),
        const Positioned(
          left: 232,
          top: 98,
          child: _Appear(
            delay: 1100,
            child: Floaty(
              phase: 0.7,
              dy: 4,
              child: _ThoughtBubble(
                'Ezik\nmiyim ben?',
                angle: 0.1,
                tailRight: false,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _ThoughtBubble extends StatelessWidget {
  final String text;
  final double angle;
  final bool tailRight;
  const _ThoughtBubble(this.text, {this.angle = 0, this.tailRight = true});

  @override
  Widget build(BuildContext context) {
    Widget dot(double s) => Container(
      width: s,
      height: s,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.black.withValues(alpha: 0.7),
        border: Border.all(color: _red, width: 1.2),
        boxShadow: [
          BoxShadow(color: _red.withValues(alpha: 0.6), blurRadius: 6),
        ],
      ),
    );
    return Transform.rotate(
      angle: angle,
      child: Column(
        crossAxisAlignment: tailRight
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.72),
              borderRadius: BorderRadius.circular(30),
              border: Border.all(color: _red, width: 1.4),
              boxShadow: [
                BoxShadow(color: _red.withValues(alpha: 0.6), blurRadius: 14),
              ],
            ),
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 11.5,
                height: 1.2,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Padding(
            padding: EdgeInsets.only(
              right: tailRight ? 18 : 0,
              left: tailRight ? 0 : 18,
              top: 3,
            ),
            child: dot(8),
          ),
          Padding(
            padding: EdgeInsets.only(
              right: tailRight ? 10 : 0,
              left: tailRight ? 0 : 26,
              top: 2,
            ),
            child: dot(5),
          ),
        ],
      ),
    );
  }
}

/// Fotoğrafa yavaş yakınlaşma (Ken Burns).
class _KenBurns extends StatefulWidget {
  final Widget child;
  const _KenBurns({required this.child});
  @override
  State<_KenBurns> createState() => _KenBurnsState();
}

class _KenBurnsState extends State<_KenBurns>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 10),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, c) => Transform.scale(
          scale: 1 + 0.07 * Curves.easeInOut.transform(_c.value),
          child: c,
        ),
        child: SizedBox.expand(child: widget.child),
      ),
    );
  }
}

// ============================================================
// 4 — SORUN SEN DEĞİLSİN
// ============================================================

class NotYouVisual extends StatelessWidget {
  const NotYouVisual({super.key});
  static const size = Size(340, 420);

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (r) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Colors.transparent,
          Colors.white,
          Colors.white,
          Colors.transparent,
        ],
        stops: [0, 0.12, 0.88, 1],
      ).createShader(r),
      blendMode: BlendMode.dstIn,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: _KenBurns(child: _part('04_bar')),
      ),
    );
  }
}

// ============================================================
// 5 — EN İYİ %10 (grafik + kart yelpazesi)
// ============================================================

class TopTenVisual extends StatelessWidget {
  const TopTenVisual({super.key});
  static const size = Size(340, 440);

  static const _vals = [0, 0, 0, 0, 1, 2, 4, 8, 17, 39];
  static const _labels = [
    '%10',
    '%20',
    '%30',
    '%40',
    '%50',
    '%60',
    '%70',
    '%80',
    '%90',
    'En iyi\n%10',
  ];

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(
          left: 0,
          right: 0,
          top: 0,
          height: 250,
          child: GlassCard(
            neon: true,
            radius: 18,
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.favorite_rounded, color: Colors.white, size: 12),
                    SizedBox(width: 6),
                    Text(
                      'HAFTALIK ORT. BEĞENİ SAYISI',
                      style: TextStyle(
                        color: Colors.white70,
                        fontSize: 9,
                        letterSpacing: 0.4,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Expanded(child: _chart()),
                const Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    '*Temsili veriler',
                    style: TextStyle(
                      color: Colors.white30,
                      fontSize: 7,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        // Kart yelpazesi
        for (var i = 0; i < 5; i++)
          Positioned(
            left: 4.0 + i * 38,
            top: 318.0 - i * 5,
            child: _Appear(
              delay: 900 + i * 90,
              child: GlowFrame(
                width: 40 + i * 3.0,
                height: 70 + i * 6.0,
                radius: 8,
                angle: -0.12 + i * 0.03,
                glow: 0.3,
                dim: true,
                color: const Color(0xFF7A2A3A),
                child: _part('05_k${i + 1}'),
              ),
            ),
          ),
        Positioned(
          right: 6,
          top: 280,
          child: _Appear(
            delay: 1400,
            child: Floaty(
              rot: 0.02,
              child: SizedBox(
                width: 118,
                height: 150,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    GlowFrame(
                      width: 108,
                      height: 142,
                      angle: 0.06,
                      glow: 1.3,
                      borderWidth: 2,
                      child: _part('05_k6'),
                    ),
                    Positioned(
                      right: 0,
                      bottom: 0,
                      child: Pulse(child: _heartBadge(34)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _chart() {
    const maxV = 40.0;
    return LayoutBuilder(
      builder: (_, box) {
        const labelH = 22.0;
        const topPad = 14.0;
        final plotH = box.maxHeight - labelH - topPad;
        final colW = (box.maxWidth - 22) / _vals.length;
        return TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 1500),
          curve: Curves.easeOutCubic,
          builder: (_, v, _) => Stack(
            children: [
              // Y ekseni etiketleri + ızgara
              for (final t in [0, 10, 20, 30, 40])
                Positioned(
                  left: 0,
                  right: 0,
                  top: topPad + plotH * (1 - t / maxV) - 5,
                  child: Row(
                    children: [
                      SizedBox(
                        width: 18,
                        child: Text(
                          '$t',
                          style: const TextStyle(
                            color: Colors.white38,
                            fontSize: 7,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Container(
                          height: 0.5,
                          color: Colors.white.withValues(alpha: 0.08),
                        ),
                      ),
                    ],
                  ),
                ),
              for (var i = 0; i < _vals.length; i++) ...[
                Positioned(
                  left: 22 + colW * i + colW * 0.18,
                  width: colW * 0.64,
                  bottom: labelH,
                  height: max(2.0, plotH * _vals[i] / maxV * v),
                  child: Container(
                    decoration: BoxDecoration(
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(4),
                      ),
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: i == _vals.length - 1
                            ? const [_redLight, _red]
                            : const [Color(0xFFB0203F), Color(0xFF5A1022)],
                      ),
                      boxShadow: i == _vals.length - 1
                          ? [
                              BoxShadow(
                                color: _red.withValues(alpha: 0.8),
                                blurRadius: 14,
                              ),
                            ]
                          : null,
                    ),
                  ),
                ),
                Positioned(
                  left: 22 + colW * i,
                  width: colW,
                  bottom: labelH + max(2.0, plotH * _vals[i] / maxV * v) + 2,
                  child: Text(
                    '${(_vals[i] * v).round()}',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: i == _vals.length - 1
                          ? Colors.white
                          : Colors.white60,
                      fontSize: i == _vals.length - 1 ? 11 : 7.5,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                Positioned(
                  left: 22 + colW * i - 4,
                  width: colW + 8,
                  bottom: 0,
                  height: labelH,
                  child: Text(
                    _labels[i],
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: i == _vals.length - 1
                          ? Colors.white
                          : Colors.white38,
                      fontSize: 6.8,
                      height: 1.1,
                      fontWeight: i == _vals.length - 1
                          ? FontWeight.w800
                          : FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

// ============================================================
// 6 — 0,1 SANİYE
// ============================================================

class SwipeSecondVisual extends StatelessWidget {
  const SwipeSecondVisual({super.key});
  static const size = Size(340, 400);

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(
          left: -4,
          top: 22,
          child: GlowFrame(
            width: 104,
            height: 168,
            angle: -0.07,
            dim: true,
            glow: 0.5,
            child: _part('06_left'),
          ),
        ),
        Positioned(
          right: -4,
          top: 22,
          child: GlowFrame(
            width: 104,
            height: 168,
            angle: 0.07,
            dim: true,
            glow: 0.5,
            child: _part('06_right'),
          ),
        ),
        Positioned(
          left: 92,
          top: 0,
          child: Pulse(
            amount: 0.02,
            periodMs: 1600,
            child: GlowFrame(
              width: 156,
              height: 212,
              radius: 16,
              borderWidth: 2.2,
              glow: 1.4,
              child: _part('06_mid'),
            ),
          ),
        ),
        // Karar çizgisi
        Positioned(
          left: 0,
          right: 0,
          top: 88,
          height: 44,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Container(
                height: 2,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [
                      Colors.transparent,
                      _redLight,
                      _redLight,
                      Colors.transparent,
                    ],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: _red.withValues(alpha: 0.8),
                      blurRadius: 8,
                    ),
                  ],
                ),
              ),
              const Positioned(
                left: 0,
                child: Icon(
                  Icons.chevron_left_rounded,
                  color: _redLight,
                  size: 26,
                ),
              ),
              const Positioned(
                right: 0,
                child: Icon(
                  Icons.chevron_right_rounded,
                  color: _redLight,
                  size: 26,
                ),
              ),
              Positioned(left: 24, child: _xBadge(40)),
              Positioned(right: 24, child: Pulse(child: _heartBadge(40))),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(colors: [_redLight, _red]),
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(
                      color: _red.withValues(alpha: 0.8),
                      blurRadius: 16,
                    ),
                  ],
                ),
                child: const Text(
                  '0,1 saniye',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
        ),
        // Alt sıra
        for (var i = 0; i < 5; i++)
          Positioned(
            left: 2.0 + i * 44,
            top: 300.0 - i * 6,
            child: _Appear(
              delay: 800 + i * 90,
              child: GlowFrame(
                width: 44 + i * 2.0,
                height: 74 + i * 4.0,
                radius: 8,
                angle: -0.1 + i * 0.03,
                glow: 0.3,
                dim: true,
                color: const Color(0xFF7A2A3A),
                child: _part('06_b${i + 1}'),
              ),
            ),
          ),
        Positioned(
          right: 8,
          top: 250,
          child: _Appear(
            delay: 1300,
            child: Floaty(
              child: SizedBox(
                width: 104,
                height: 140,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    GlowFrame(
                      width: 96,
                      height: 130,
                      angle: 0.06,
                      glow: 1.3,
                      borderWidth: 2,
                      child: _part('06_b6'),
                    ),
                    Positioned(
                      right: 0,
                      bottom: 0,
                      child: Pulse(child: _heartBadge(32)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

// ============================================================
// 7 & 8 — FOTOĞRAFIN ÇEKİCİLİĞİ / "SEN OLSAN HANGİSİNİ" (kötü → iyi profil)
// ============================================================

class AttractivenessVisual extends StatelessWidget {
  const AttractivenessVisual({super.key});
  static const size = Size(340, 450);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 1; i <= 3; i++) ...[
          if (i > 1) const SizedBox(height: 10),
          _Appear(delay: 300 + i * 220, child: _pair(i)),
        ],
      ],
    );
  }

  Widget _pair(int i) {
    Widget side(String part, bool good) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: good ? _green : _red, width: 1),
          ),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: good ? '%10 ' : '%90 ',
                  style: TextStyle(color: good ? _green : _red),
                ),
                TextSpan(
                  text: good ? '(İyi Profil)' : '(Kötü Profil)',
                  style: const TextStyle(color: Colors.white),
                ),
              ],
            ),
            style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800),
          ),
        ),
        const SizedBox(height: 4),
        SizedBox(
          width: 132,
          height: 106,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.bottomCenter,
            children: [
              GlowFrame(
                width: 132,
                height: 106,
                glow: good ? 1.1 : 0.6,
                borderWidth: good ? 2 : 1.4,
                dim: !good,
                child: _part(part),
              ),
              Positioned(
                bottom: -12,
                child: good
                    ? Pulse(child: _heartBadge(30, color: _green))
                    : _xBadge(30),
              ),
            ],
          ),
        ),
      ],
    );
    return SizedBox(
      height: 136,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          side('07_bad$i', false),
          const Icon(Icons.arrow_forward_rounded, color: _red, size: 26),
          side('07_good$i', true),
        ],
      ),
    );
  }
}

// ============================================================
// 9 & 10 — ChatGPT / Gemini / Voxen AI karşılaştırması
// ============================================================

class CompareVisual extends StatelessWidget {
  final String prefix; // '09' veya '10'
  final List<List<String>> rows; // [chatgpt, gemini, voxen]
  /// false → fotoğraf yok, sütunlar yalnızca madde listesi (ekran 10).
  final bool photos;
  const CompareVisual({
    super.key,
    required this.prefix,
    required this.rows,
    this.photos = true,
  });
  static const size = Size(340, 350);
  static const sizeNoPhotos = Size(340, 270);

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(child: _col(0, 'ChatGPT', 'cg')),
        const SizedBox(width: 8),
        Expanded(child: _col(1, 'Gemini', 'gm')),
        const SizedBox(width: 8),
        Expanded(child: _Appear(delay: 700, child: _col(2, 'Voxen AI', 'vx'))),
      ],
    );
  }

  Widget _col(int idx, String title, String part) {
    final voxen = idx == 2;
    final Widget icon = switch (idx) {
      0 => const Icon(Icons.hub_outlined, color: Colors.white, size: 15),
      1 => ShaderMask(
        shaderCallback: (r) => const LinearGradient(
          colors: [Color(0xFF4E8CFF), Color(0xFFB36BFF)],
        ).createShader(r),
        child: const Icon(Icons.auto_awesome, color: Colors.white, size: 15),
      ),
      _ => Container(
        width: 17,
        height: 17,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          color: const Color(0xFF2A0A12),
          border: Border.all(color: _red, width: 0.8),
        ),
        child: const Icon(Icons.show_chart_rounded, color: _red, size: 12),
      ),
    };
    return Pulse(
      amount: voxen ? 0.015 : 0.0,
      periodMs: 1800,
      child: GlassCard(
        neon: voxen,
        radius: 14,
        padding: const EdgeInsets.fromLTRB(6, 8, 6, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                icon,
                const SizedBox(width: 5),
                Flexible(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text.rich(
                      voxen
                          ? const TextSpan(
                              children: [
                                TextSpan(text: 'Voxen '),
                                TextSpan(
                                  text: 'AI',
                                  style: TextStyle(color: _red),
                                ),
                              ],
                            )
                          : TextSpan(text: title),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (photos) ...[
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: _part(
                    '${prefix}_$part',
                    alignment: Alignment.topCenter,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              for (final r in rows[idx]) _bullet(r, voxen, 7.6, 5),
            ] else ...[
              Container(
                height: 1,
                color: (voxen ? _red : Colors.white).withValues(
                  alpha: voxen ? 0.5 : 0.12,
                ),
              ),
              const SizedBox(height: 10),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var k = 0; k < rows[idx].length; k++)
                      _Appear(
                        delay: 400 + idx * 250 + k * 90,
                        child: _bullet(rows[idx][k], voxen, 9.4, 0),
                      ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _bullet(String r, bool voxen, double fontSize, double gap) => Padding(
    padding: EdgeInsets.only(bottom: gap),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          voxen ? Icons.check_circle_rounded : Icons.cancel_rounded,
          color: voxen ? _green : _red,
          size: fontSize + 3.4,
        ),
        const SizedBox(width: 4),
        Expanded(
          child: Text(
            r,
            style: TextStyle(
              color: voxen ? Colors.white : Colors.white70,
              fontSize: fontSize,
              height: 1.25,
              fontWeight: voxen ? FontWeight.w700 : FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

// ============================================================
// 11 — SELFIE İLE YÜZ TARAMASI
// ============================================================

class FaceScanVisual extends StatelessWidget {
  const FaceScanVisual({super.key});
  static const size = Size(340, 440);

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(
          left: 86,
          top: 0,
          child: PhoneFrame(
            width: 172,
            height: 372,
            screenColor: Colors.black,
            screen: Stack(
              fit: StackFit.expand,
              children: [
                _part('11_face', alignment: Alignment.topCenter),
                const _ScanLine(),
                const Positioned.fill(child: _ScanCorners()),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 34,
                  child: Center(
                    child: Pulse(
                      child: Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: Colors.white,
                          border: Border.all(color: _red, width: 3),
                          boxShadow: [
                            BoxShadow(
                              color: _red.withValues(alpha: 0.8),
                              blurRadius: 14,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                const Positioned(
                  left: 0,
                  right: 0,
                  bottom: 14,
                  child: Text(
                    'Yüzünüz taranıyor...',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: Colors.white70,
                      fontSize: 8,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Positioned(
          left: 0,
          top: 40,
          child: Floaty(
            child: Polaroid(
              width: 84,
              height: 112,
              angle: -0.08,
              child: _part('11_selfie'),
            ),
          ),
        ),
        const Positioned(
          left: 30,
          top: 150,
          width: 70,
          height: 60,
          child: CurvedArrow(
            from: Offset(4, 0),
            to: Offset(62, 48),
            control: Offset(8, 46),
          ),
        ),
        Positioned(
          left: 0,
          top: 228,
          width: 82,
          child: _Appear(
            delay: 900,
            child: _infoCard(
              Icons.photo_camera_outlined,
              'Sadece\nbir selfie\nyeter.',
            ),
          ),
        ),
        for (var i = 0; i < 3; i++)
          Positioned(
            right: 0,
            top: 8.0 + i * 76,
            child: _Appear(
              delay: 500 + i * 200,
              child: GlowFrame(
                width: 72,
                height: 68,
                radius: 10,
                glow: 0.7,
                child: _part('11_m${i + 1}'),
              ),
            ),
          ),
        Positioned(
          right: 0,
          top: 252,
          width: 80,
          child: _Appear(
            delay: 1200,
            child: _infoCard(
              Icons.auto_awesome,
              'Yüz hatlarınız\n3D olarak\nanaliz edilir.',
            ),
          ),
        ),
      ],
    );
  }

  Widget _infoCard(IconData icon, String text) => GlassCard(
    padding: const EdgeInsets.all(8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: _red, size: 20),
        const SizedBox(height: 5),
        Text(
          text,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 9.5,
            height: 1.25,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    ),
  );
}

class _ScanCorners extends StatelessWidget {
  const _ScanCorners();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _CornersPainter());
}

class _CornersPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size s) {
    final p = Paint()
      ..color = _redLight
      ..strokeWidth = 2.2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    const m = 16.0, l = 20.0;
    final r = Rect.fromLTRB(m, m + 24, s.width - m, s.height * 0.66);
    for (final c in [
      [r.topLeft, const Offset(1, 0), const Offset(0, 1)],
      [r.topRight, const Offset(-1, 0), const Offset(0, 1)],
      [r.bottomLeft, const Offset(1, 0), const Offset(0, -1)],
      [r.bottomRight, const Offset(-1, 0), const Offset(0, -1)],
    ]) {
      canvas.drawLine(c[0], c[0] + c[1] * l, p);
      canvas.drawLine(c[0], c[0] + c[2] * l, p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

// ============================================================
// 13 — SİZDEN GELENLER (önce / sonra Hinge + yorum)
// ============================================================

class TestimonialVisual extends StatelessWidget {
  const TestimonialVisual({super.key});
  static const size = Size(340, 470);

  static const _matches = [
    ('Melis', '3 dk önce'),
    ('Zeynep', '12 dk önce'),
    ('Defne', '28 dk önce'),
    ('Ece', '1 saat önce'),
    ('İpek', '2 saat önce'),
    ('Lara', '3 saat önce'),
  ];

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned(left: 0, top: 0, width: 164, child: _head(false)),
        Positioned(right: 0, top: 0, width: 164, child: _head(true)),
        Positioned(
          left: 0,
          top: 64,
          child: PhoneFrame(
            width: 162,
            height: 300,
            screen: _hinge(empty: true),
          ),
        ),
        Positioned(
          right: 0,
          top: 64,
          child: PhoneFrame(
            width: 162,
            height: 300,
            neon: true,
            screen: _hinge(empty: false),
          ),
        ),
        const Positioned(
          right: -6,
          top: 40,
          child: Floaty(
            dy: 6,
            child: Icon(Icons.favorite_rounded, color: _red, size: 22),
          ),
        ),
        const Positioned(
          right: -10,
          top: 200,
          child: Floaty(
            phase: 0.5,
            dy: 6,
            child: Icon(Icons.favorite_rounded, color: _red, size: 20),
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          top: 378,
          child: _Appear(
            delay: 1100,
            child: GlassCard(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white38),
                    ),
                    child: ClipOval(child: _part('13_mert')),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _reviewText(
                      'Mert K.',
                      'İstanbul, TR',
                      '"Voxen AI\'den önce Hinge\'de hiç eşleşmem yoktu. Şimdi her '
                          'hafta onlarca eşleşme alıyorum. Fotoğraflarımın kalitesi '
                          've tarzı tamamen değişti."',
                      9,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _head(bool after) => Column(
    children: [
      Container(
        width: 104,
        padding: const EdgeInsets.symmetric(vertical: 3),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.6),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: after ? _red : Colors.white24,
            width: after ? 1.4 : 1,
          ),
          boxShadow: after
              ? [BoxShadow(color: _red.withValues(alpha: 0.5), blurRadius: 10)]
              : null,
        ),
        child: Text(
          after ? 'Sonra' : 'Önce',
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 12,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
      const SizedBox(height: 3),
      const Text('Hinge', style: TextStyle(color: Colors.white54, fontSize: 9)),
      Text(
        after ? '+65 Eşleşme' : '0 Eşleşme',
        style: TextStyle(
          color: after ? _green : Colors.white,
          fontSize: 15,
          fontWeight: FontWeight.w900,
        ),
      ),
    ],
  );

  Widget _hinge({required bool empty}) {
    return Column(
      children: [
        _statusBar(162, Colors.black87),
        const SizedBox(height: 10),
        const Text(
          'Hinge',
          style: TextStyle(
            color: Colors.black87,
            fontSize: 12,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  children: [
                    const Text(
                      'Matches',
                      style: TextStyle(
                        color: Colors.black87,
                        fontSize: 7.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Container(height: 1.4, color: Colors.black87),
                  ],
                ),
              ),
              const Expanded(
                child: Text(
                  'Requests',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.black38, fontSize: 7.5),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: empty
              ? const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.favorite_border_rounded,
                        color: Colors.black54,
                        size: 22,
                      ),
                      SizedBox(height: 6),
                      Text(
                        'Henüz eşleşmen yok.',
                        style: TextStyle(
                          color: Colors.black87,
                          fontSize: 8.5,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      SizedBox(height: 3),
                      Text(
                        'Profilini geliştirmeye devam et ve daha fazla '
                        'kişinin seni görmesini sağla.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.black45, fontSize: 6.5),
                      ),
                      SizedBox(height: 8),
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: Color(0xFF222226),
                          borderRadius: BorderRadius.all(Radius.circular(12)),
                        ),
                        child: Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 5,
                          ),
                          child: Text(
                            'Profilini Düzenle',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 7,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                )
              : Column(
                  children: [
                    const SizedBox(height: 4),
                    for (var i = 0; i < _matches.length; i++)
                      _Appear(
                        delay: 600 + i * 120,
                        from: const Offset(20, 0),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(9, 3, 6, 3),
                          child: Row(
                            children: [
                              ClipOval(
                                child: SizedBox(
                                  width: 26,
                                  height: 26,
                                  child: _part('08_av$i'),
                                ),
                              ),
                              const SizedBox(width: 6),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _matches[i].$1,
                                    style: const TextStyle(
                                      color: Colors.black87,
                                      fontSize: 8.5,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  Row(
                                    children: [
                                      Container(
                                        width: 4,
                                        height: 4,
                                        decoration: const BoxDecoration(
                                          color: Color(0xFF7C3AED),
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                                      const SizedBox(width: 3),
                                      Text(
                                        'Yeni eşleşme · ${_matches[i].$2}',
                                        style: const TextStyle(
                                          color: Color(0xFF7C3AED),
                                          fontSize: 6.2,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
        ),
        const SizedBox(
          height: 24,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              Icon(Icons.explore_outlined, size: 12, color: Colors.black45),
              Icon(
                Icons.favorite_border_rounded,
                size: 12,
                color: Colors.black45,
              ),
              Icon(Icons.chat_bubble_rounded, size: 12, color: Colors.black87),
              Icon(
                Icons.person_outline_rounded,
                size: 12,
                color: Colors.black45,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

Widget _stars(double s) => Row(
  mainAxisSize: MainAxisSize.min,
  children: [
    for (var i = 0; i < 5; i++)
      Icon(Icons.star_rounded, color: const Color(0xFFFFC53D), size: s),
  ],
);

Widget _reviewText(String name, String city, String quote, double fs) => Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  mainAxisSize: MainAxisSize.min,
  children: [
    Row(
      children: [
        Text(
          name,
          style: TextStyle(
            color: Colors.white,
            fontSize: fs + 2,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(width: 4),
        Icon(Icons.verified_rounded, color: _red, size: fs + 3),
      ],
    ),
    Text(
      city,
      style: TextStyle(color: Colors.white54, fontSize: fs - 0.5),
    ),
    const SizedBox(height: 2),
    _stars(fs + 3),
    const SizedBox(height: 3),
    Text(
      quote,
      style: TextStyle(
        color: Colors.white.withValues(alpha: 0.85),
        fontSize: fs - 0.5,
        height: 1.3,
      ),
    ),
  ],
);

// ============================================================
// 14 — SİZDEN GELENLER 2 (5 yorum + mini önce/sonra)
// ============================================================

class TestimonialListVisual extends StatelessWidget {
  const TestimonialListVisual({super.key});
  static const size = Size(340, 520);

  static const _items = [
    (
      'Mert K.',
      'İstanbul, TR',
      '"Voxen AI sayesinde Hinge\'de eşleşmelerim 0\'dan 67\'ye çıktı. '
          'Artık çok daha fazla kaliteli eşleşme alıyorum."',
      0,
      67,
    ),
    (
      'Kerem A.',
      'Ankara, TR',
      '"Fotoğraflarım komple değişti. Hinge\'de eskiden hiç eşleşme '
          'almıyordum, şimdi her hafta onlarca eşleşme geliyor."',
      1,
      48,
    ),
    (
      'Emre Y.',
      'İzmir, TR',
      '"Voxen AI gerçekten işe yarıyor. Çok daha doğal ve çekici '
          'fotoğraflar oluşturuyor. Eşleşmelerim ciddi şekilde arttı."',
      0,
      52,
    ),
    (
      'Can D.',
      'Antalya, TR',
      '"Daha önce Hinge\'yi neredeyse bırakmıştım. Voxen AI sonrası hem '
          'eşleşme sayım hem de sohbet kalitesi arttı."',
      2,
      39,
    ),
    (
      'Arda T.',
      'Bursa, TR',
      '"Fotoğraf seçimi ve stil optimizasyonu gerçekten fark yaratıyor. '
          'Hinge\'de eşleşmelerim 0\'dan 55\'e çıktı."',
      0,
      55,
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < _items.length; i++) ...[
          if (i > 0) const SizedBox(height: 7),
          _Appear(
            delay: 350 + i * 160,
            from: const Offset(30, 0),
            child: _row(i),
          ),
        ],
      ],
    );
  }

  Widget _row(int i) {
    final it = _items[i];
    return SizedBox(
      height: 98,
      child: GlassCard(
        padding: const EdgeInsets.all(7),
        child: Row(
          children: [
            Container(
              width: 62,
              height: 62,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white38),
                boxShadow: [
                  BoxShadow(color: _red.withValues(alpha: 0.3), blurRadius: 8),
                ],
              ),
              child: ClipOval(child: _part('14_t$i')),
            ),
            const SizedBox(width: 8),
            Expanded(child: _reviewText(it.$1, it.$2, it.$3, 7.2)),
            const SizedBox(width: 6),
            _mini(before: true, count: it.$4),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 3),
              child: Icon(Icons.arrow_forward_rounded, color: _red, size: 14),
            ),
            _mini(before: false, count: it.$5, seed: i),
          ],
        ),
      ),
    );
  }

  Widget _mini({required bool before, required int count, int seed = 0}) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
          decoration: BoxDecoration(
            color: before ? Colors.white12 : _red,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(
            before ? 'Önce' : 'Sonra',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 6.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const SizedBox(height: 2),
        Container(
          width: 46,
          height: 64,
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(
              color: before ? Colors.white30 : _red,
              width: before ? 1 : 1.5,
            ),
            boxShadow: before
                ? null
                : [
                    BoxShadow(
                      color: _red.withValues(alpha: 0.6),
                      blurRadius: 8,
                    ),
                  ],
          ),
          child: Column(
            children: [
              const Text(
                'Hinge',
                style: TextStyle(
                  color: Colors.black87,
                  fontSize: 6,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const Spacer(),
              if (before)
                const Icon(
                  Icons.favorite_border_rounded,
                  size: 9,
                  color: Colors.black38,
                )
              else
                SizedBox(
                  height: 12,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      for (var k = 0; k < 3; k++)
                        Align(
                          widthFactor: 0.75,
                          child: ClipOval(
                            child: SizedBox(
                              width: 12,
                              height: 12,
                              child: _part('08_av${(seed + k) % 7}'),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              Text(
                before ? '$count' : '+$count',
                style: TextStyle(
                  color: before ? Colors.black87 : _red,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const Text(
                'Eşleşme',
                style: TextStyle(color: Colors.black45, fontSize: 5),
              ),
              const Spacer(),
            ],
          ),
        ),
      ],
    );
  }
}
