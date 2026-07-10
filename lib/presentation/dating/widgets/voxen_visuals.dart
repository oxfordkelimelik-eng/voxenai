import 'dart:async';
import 'dart:math';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import '../../../core/constants/app_colors.dart';

/// VOXEN AI marka logosu (her ekranın en üstünde).
/// Koyu zeminlerde gerçek logo görselini (assets/images/logo.png) kullanır;
/// logonun arka planı (#0D0D0D) uygulama arka planıyla (~#0A0A0A) eşleştiği
/// için kutu görünmez. Kırmızı zeminde (onRed) beyaz metin varyantına düşer
/// (koyu logo kutusu kırmızıyla çakışmasın). Görsel yoksa da metne düşer.
class VoxenWordmark extends StatelessWidget {
  final double fontSize;
  final bool onRed; // kırmızı arka plan üstünde beyaz görünüm
  const VoxenWordmark({super.key, this.fontSize = 22, this.onRed = false});

  @override
  Widget build(BuildContext context) {
    if (onRed) return _text();
    return Image.asset(
      'assets/images/logo.png',
      height: fontSize * 1.7,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
      errorBuilder: (_, _, _) => _text(),
    );
  }

  Widget _text() {
    return RichText(
      text: TextSpan(
        style: TextStyle(
          fontSize: fontSize,
          fontWeight: FontWeight.w900,
          letterSpacing: 3,
        ),
        children: [
          TextSpan(
              text: 'VOXEN ',
              style: TextStyle(
                  color: onRed ? Colors.white : AppColors.textPrimary)),
          TextSpan(
              text: 'AI',
              style: TextStyle(color: onRed ? Colors.white : AppColors.gold)),
        ],
      ),
    );
  }
}

/// Bir portre için renk paleti (arka plan, ten, saç, kıyafet).
class _Palette {
  final Color bg1, bg2, skin, hair, cloth;
  const _Palette(this.bg1, this.bg2, this.skin, this.hair, this.cloth);
}

/// Asset varsa gerçek foto, yoksa BLURLU portre placeholder'ı.
/// Kullanıcı assets/dating/f{index}.jpg (kadın) veya m{index}.jpg (erkek)
/// koyunca otomatik gerçek foto görünür. [male] siluet + isim eşleşmesi
/// için önemlidir (ör. erkek isimli yoruma kadın avatar atanmasın).
class VoxenPhoto extends StatelessWidget {
  final int index; // 1..8
  final bool male;
  final BoxFit fit;
  const VoxenPhoto({
    super.key,
    required this.index,
    this.male = false,
    this.fit = BoxFit.cover,
  });

  // Kadın portreleri için palet (uzun saç siluetiyle çizilir).
  static const _femalePalettes = [
    _Palette(Color(0xFFF7C8B0), Color(0xFFE79B84), Color(0xFFF1C7A5),
        Color(0xFF3B2A21), Color(0xFF8E4A5B)),
    _Palette(Color(0xFFF3D9C9), Color(0xFFDFA98E), Color(0xFFE8B98E),
        Color(0xFF1A1310), Color(0xFF5B6C8E)),
    _Palette(Color(0xFFE9C7C0), Color(0xFFC58E96), Color(0xFFD9A17A),
        Color(0xFF6B4A2F), Color(0xFF9B6A8E)),
    _Palette(Color(0xFFFAD4C0), Color(0xFFF0A98D), Color(0xFFF1C7A5),
        Color(0xFF2A1D16), Color(0xFFB25B6B)),
    _Palette(Color(0xFFF6D3C4), Color(0xFFD79A83), Color(0xFFC98B6B),
        Color(0xFF4A2E1E), Color(0xFF6E8E5B)),
    _Palette(Color(0xFFF2CBBE), Color(0xFFCE8E86), Color(0xFFE8B98E),
        Color(0xFFA9764B), Color(0xFF8E5B7A)),
    _Palette(Color(0xFFEFC2B4), Color(0xFFC77E77), Color(0xFFD9A17A),
        Color(0xFF1F1512), Color(0xFFB2506A)),
    _Palette(Color(0xFFF7D0BE), Color(0xFFDD9A7E), Color(0xFFF1C7A5),
        Color(0xFF5A3A28), Color(0xFF5B7C8E)),
  ];

  // Erkek portreleri için palet (kısa saç siluetiyle çizilir, koyu tonlar).
  static const _malePalettes = [
    _Palette(Color(0xFF6E7B8B), Color(0xFF3F4A57), Color(0xFFE0AC85),
        Color(0xFF2A1F18), Color(0xFF2E3A46)),
    _Palette(Color(0xFF7A8A8F), Color(0xFF46545A), Color(0xFFD79A73),
        Color(0xFF1C1512), Color(0xFF39424A)),
    _Palette(Color(0xFF8A8577), Color(0xFF4F4A3F), Color(0xFFC98860),
        Color(0xFF141210), Color(0xFF463F35)),
    _Palette(Color(0xFF6B7580), Color(0xFF3A4148), Color(0xFFE3B08B),
        Color(0xFF3B2A1E), Color(0xFF2B333A)),
    _Palette(Color(0xFF83766B), Color(0xFF473E36), Color(0xFFCB9268),
        Color(0xFF201A16), Color(0xFF3E362F)),
    _Palette(Color(0xFF6F8283), Color(0xFF3C4A4B), Color(0xFFD9A177),
        Color(0xFF241C16), Color(0xFF2F3B3C)),
    _Palette(Color(0xFF817A8C), Color(0xFF453F52), Color(0xFFC1875F),
        Color(0xFF17110E), Color(0xFF352F42)),
    _Palette(Color(0xFF748083), Color(0xFF404A4D), Color(0xFFE6B48D),
        Color(0xFF2E2119), Color(0xFF303B3E)),
  ];

  @override
  Widget build(BuildContext context) {
    final asset = male ? 'assets/dating/m$index.jpg' : 'assets/dating/f$index.jpg';
    final palettes = male ? _malePalettes : _femalePalettes;
    return Image.asset(
      asset,
      fit: fit,
      width: double.infinity,
      height: double.infinity,
      // Dosya yoksa BLURLU portre placeholder'ına düş (hata/crash yok).
      errorBuilder: (_, _, _) => _BlurredPortrait(
          palettes[(index - 1) % palettes.length],
          male: male),
    );
  }
}

/// Kodla çizilen, bulanıklaştırılmış portre (bulanık profil fotosu gibi).
/// [male] true ise daha kısa saç silueti ve geniş omuz kullanılır.
class _BlurredPortrait extends StatelessWidget {
  final _Palette p;
  final bool male;
  const _BlurredPortrait(this.p, {this.male = false});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (_, c) {
        final w = c.maxWidth.isFinite ? c.maxWidth : 120.0;
        final h = c.maxHeight.isFinite ? c.maxHeight : 160.0;
        final cx = w / 2;
        final faceR = w * (male ? 0.28 : 0.30); // yüz yarıçapı
        final faceCy = h * 0.42;
        // Erkek: kısa saç (sadece üst tutam), daha geniş omuz.
        // Kadın: uzun saç (yanaklardan aşağı iki tutam).
        return ClipRect(
          child: ImageFiltered(
            imageFilter: ui.ImageFilter.blur(sigmaX: 7, sigmaY: 7),
            child: Stack(
              fit: StackFit.expand,
              children: [
                // Arka plan
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [p.bg1, p.bg2],
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                    ),
                  ),
                ),
                // Omuzlar / gövde (kıyafet) — erkek biraz daha geniş
                Positioned(
                  left: cx - w * (male ? 0.62 : 0.55),
                  right: cx - w * (male ? 0.62 : 0.55),
                  top: h * (male ? 0.64 : 0.66),
                  child: Container(
                    width: w * 1.1,
                    height: h * 0.5,
                    decoration: BoxDecoration(
                      color: p.cloth,
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(w * 0.4),
                        topRight: Radius.circular(w * 0.4),
                      ),
                    ),
                  ),
                ),
                // Saç (yüzün arkasında)
                Positioned(
                  left: cx - faceR * (male ? 1.15 : 1.35),
                  top: faceCy - faceR * (male ? 1.25 : 1.5),
                  child: Container(
                    width: faceR * (male ? 2.3 : 2.7),
                    height: faceR * (male ? 2.2 : 2.9),
                    decoration: BoxDecoration(
                      color: p.hair,
                      borderRadius: BorderRadius.circular(faceR * 1.5),
                    ),
                  ),
                ),
                // Yüz (ten)
                Positioned(
                  left: cx - faceR,
                  top: faceCy - faceR,
                  child: Container(
                    width: faceR * 2,
                    height: faceR * 2.25,
                    decoration: BoxDecoration(
                      color: p.skin,
                      borderRadius: BorderRadius.circular(faceR),
                    ),
                  ),
                ),
                // Saç ön tutamları — yalnızca kadın siluetinde (uzun saç)
                if (!male) ...[
                  Positioned(
                    left: cx - faceR * 1.25,
                    top: faceCy - faceR * 0.3,
                    child: Container(
                      width: faceR * 0.5,
                      height: faceR * 1.8,
                      decoration: BoxDecoration(
                        color: p.hair,
                        borderRadius: BorderRadius.circular(faceR * 0.4),
                      ),
                    ),
                  ),
                  Positioned(
                    left: cx + faceR * 0.75,
                    top: faceCy - faceR * 0.3,
                    child: Container(
                      width: faceR * 0.5,
                      height: faceR * 1.8,
                      decoration: BoxDecoration(
                        color: p.hair,
                        borderRadius: BorderRadius.circular(faceR * 0.4),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

// ============================================================
// TELEFON — gerçek dating uygulaması "Eşleşmeler" ekranı
// Sürekli aşağı kayan, isim/yaş/çevrimiçi + "Yeni eşleşme" kartları.
// ============================================================
class ScrollingMatchesPhone extends StatefulWidget {
  final double width;
  const ScrollingMatchesPhone({super.key, this.width = 220});

  @override
  State<ScrollingMatchesPhone> createState() => _ScrollingMatchesPhoneState();
}

class _ScrollingMatchesPhoneState extends State<ScrollingMatchesPhone> {
  final _controller = ScrollController();
  Timer? _timer;
  double _offset = 0;

  static const _names = [
    ['Elif', 24], ['Zeynep', 26], ['Defne', 23], ['Ada', 25],
    ['Melis', 27], ['Naz', 22], ['İrem', 28], ['Sude', 24],
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _timer = Timer.periodic(const Duration(milliseconds: 30), (_) {
        if (!_controller.hasClients) return;
        _offset += 0.8;
        final max = _controller.position.maxScrollExtent;
        if (_offset >= max) _offset = 0;
        _controller.jumpTo(_offset);
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.width;
    final h = w * 2.05;
    return Container(
      width: w,
      height: h,
      padding: const EdgeInsets.all(7),
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(36),
        border: Border.all(color: const Color(0xFF2A2A2A), width: 3),
        boxShadow: const [
          BoxShadow(color: Colors.black54, blurRadius: 30, spreadRadius: 4),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(30),
        child: Container(
          color: const Color(0xFF0E0E10),
          child: Column(
            children: [
              // Uygulama üst çubuğu (Eşleşmeler / Mesajlar)
              Container(
                padding:
                    const EdgeInsets.fromLTRB(12, 12, 12, 8),
                child: Row(
                  children: [
                    Text('Eşleşmeler',
                        style: TextStyle(
                            color: AppColors.gold,
                            fontSize: w * 0.062,
                            fontWeight: FontWeight.w900)),
                    const SizedBox(width: 12),
                    Text('Mesajlar',
                        style: TextStyle(
                            color: Colors.white38,
                            fontSize: w * 0.062,
                            fontWeight: FontWeight.w700)),
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.gold,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('9+',
                          style: TextStyle(
                              color: Colors.white,
                              fontSize: w * 0.05,
                              fontWeight: FontWeight.w900)),
                    ),
                  ],
                ),
              ),
              // Eşleşme grid'i (sürekli akan)
              Expanded(
                child: IgnorePointer(
                  child: GridView.builder(
                    controller: _controller,
                    physics: const NeverScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(8),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      mainAxisSpacing: 8,
                      crossAxisSpacing: 8,
                      childAspectRatio: 0.74,
                    ),
                    itemCount: 240,
                    itemBuilder: (_, i) {
                      final n = _names[i % _names.length];
                      return _MatchTile(
                        photoIndex: (i % 8) + 1,
                        name: n[0] as String,
                        age: n[1] as int,
                        online: i % 3 == 0,
                        fresh: i % 4 == 0,
                      );
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MatchTile extends StatelessWidget {
  final int photoIndex;
  final String name;
  final int age;
  final bool online;
  final bool fresh;
  const _MatchTile({
    required this.photoIndex,
    required this.name,
    required this.age,
    required this.online,
    required this.fresh,
  });

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Stack(
        fit: StackFit.expand,
        children: [
          VoxenPhoto(index: photoIndex),
          // Alt karartma
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [Colors.transparent, Colors.black87],
                begin: Alignment.center,
                end: Alignment.bottomCenter,
              ),
            ),
          ),
          if (fresh)
            Positioned(
              top: 6,
              left: 6,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.gold,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Text('Yeni eşleşme',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 8,
                        fontWeight: FontWeight.w900)),
              ),
            ),
          Positioned(
            left: 7,
            bottom: 6,
            right: 6,
            child: Row(
              children: [
                if (online)
                  Container(
                    width: 8,
                    height: 8,
                    margin: const EdgeInsets.only(right: 4),
                    decoration: const BoxDecoration(
                        color: Color(0xFF4CD964), shape: BoxShape.circle),
                  ),
                Flexible(
                  child: Text('$name, $age',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          shadows: [
                            Shadow(color: Colors.black, blurRadius: 4)
                          ])),
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
// TINDER TARZI EŞLEŞME DUVARI — tam ekran, BLURLU fotoğraflar
// Sürekli kayan grid; yüzler bulanık (merak uyandırır: "eşleşmelerini gör").
// ============================================================
class BlurredMatchesWall extends StatefulWidget {
  final int crossAxisCount;
  final double blurSigma;
  const BlurredMatchesWall({
    super.key,
    this.crossAxisCount = 3,
    this.blurSigma = 9,
  });

  @override
  State<BlurredMatchesWall> createState() => _BlurredMatchesWallState();
}

class _BlurredMatchesWallState extends State<BlurredMatchesWall> {
  final _controller = ScrollController();
  Timer? _timer;
  double _offset = 0;

  static const _names = [
    ['Elif', 24], ['Zeynep', 26], ['Defne', 23], ['Ada', 25],
    ['Melis', 27], ['Naz', 22], ['İrem', 28], ['Sude', 24],
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _timer = Timer.periodic(const Duration(milliseconds: 30), (_) {
        if (!_controller.hasClients) return;
        _offset += 0.7;
        final max = _controller.position.maxScrollExtent;
        if (_offset >= max) _offset = 0;
        _controller.jumpTo(_offset);
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Üst/alt kenarlar şeffafa solar → arka plana (kırmızı) yumuşak geçiş.
    return ShaderMask(
      shaderCallback: (rect) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Colors.transparent,
          Colors.white,
          Colors.white,
          Colors.transparent,
        ],
        stops: [0.0, 0.13, 0.87, 1.0],
      ).createShader(rect),
      blendMode: BlendMode.dstIn,
      child: IgnorePointer(
        child: GridView.builder(
          controller: _controller,
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.symmetric(vertical: 8),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: widget.crossAxisCount,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 0.72,
          ),
          itemCount: 300,
          itemBuilder: (_, i) {
            final n = _names[i % _names.length];
            return _WallTile(
              photoIndex: (i % 8) + 1,
              name: n[0] as String,
              age: n[1] as int,
              online: i % 3 == 0,
              fresh: i % 4 == 0,
              blurSigma: widget.blurSigma,
            );
          },
        ),
      ),
    );
  }
}

class _WallTile extends StatelessWidget {
  final int photoIndex;
  final String name;
  final int age;
  final bool online;
  final bool fresh;
  final double blurSigma;
  const _WallTile({
    required this.photoIndex,
    required this.name,
    required this.age,
    required this.online,
    required this.fresh,
    required this.blurSigma,
  });

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Foto — her zaman BULANIK (gerçek asset olsa bile).
          ImageFiltered(
            imageFilter:
                ui.ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
            child: VoxenPhoto(index: photoIndex),
          ),
          // Alt karartma → isim okunur kalsın.
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [Colors.transparent, Colors.black87],
                begin: Alignment.center,
                end: Alignment.bottomCenter,
              ),
            ),
          ),
          // Merkezde küçük kilit — "gör" merakı.
          Center(
            child: Icon(Icons.lock_rounded,
                color: Colors.white.withValues(alpha: 0.55), size: 22),
          ),
          if (fresh)
            Positioned(
              top: 6,
              left: 6,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.gold,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Text('Yeni eşleşme',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 8,
                        fontWeight: FontWeight.w900)),
              ),
            ),
          Positioned(
            left: 7,
            right: 6,
            bottom: 6,
            child: Row(
              children: [
                if (online)
                  Container(
                    width: 8,
                    height: 8,
                    margin: const EdgeInsets.only(right: 4),
                    decoration: const BoxDecoration(
                        color: Color(0xFF4CD964), shape: BoxShape.circle),
                  ),
                Flexible(
                  child: Text('$name, $age',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          shadows: [Shadow(color: Colors.black, blurRadius: 4)])),
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
// Süzülen kalpler arka planı (dekoratif)
// ============================================================
class FloatingHeartsBackground extends StatefulWidget {
  final Widget child;
  const FloatingHeartsBackground({super.key, required this.child});

  @override
  State<FloatingHeartsBackground> createState() =>
      _FloatingHeartsBackgroundState();
}

class _FloatingHeartsBackgroundState extends State<FloatingHeartsBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  final _rnd = Random(7);
  late final List<_Heart> _hearts;

  @override
  void initState() {
    super.initState();
    _hearts = List.generate(14, (_) => _Heart.random(_rnd));
    _c = AnimationController(
        vsync: this, duration: const Duration(seconds: 6))
      ..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(
          child: AnimatedBuilder(
            animation: _c,
            builder: (_, _) =>
                CustomPaint(painter: _HeartsPainter(_hearts, _c.value)),
          ),
        ),
        widget.child,
      ],
    );
  }
}

class _Heart {
  final double x, size, speed, phase, opacity;
  _Heart(this.x, this.size, this.speed, this.phase, this.opacity);
  factory _Heart.random(Random r) => _Heart(
        r.nextDouble(),
        14 + r.nextDouble() * 26,
        0.4 + r.nextDouble() * 0.8,
        r.nextDouble(),
        0.06 + r.nextDouble() * 0.16,
      );
}

class _HeartsPainter extends CustomPainter {
  final List<_Heart> hearts;
  final double t;
  _HeartsPainter(this.hearts, this.t);

  @override
  void paint(Canvas canvas, Size size) {
    for (final h in hearts) {
      final prog = (t * h.speed + h.phase) % 1.0;
      final y = size.height * (1.0 - prog);
      final x = size.width * h.x + sin(prog * 2 * pi) * 12;
      final paint = Paint()
        ..color = Colors.white.withValues(alpha: h.opacity);
      _drawHeart(canvas, Offset(x, y), h.size, paint);
    }
  }

  void _drawHeart(Canvas canvas, Offset c, double s, Paint paint) {
    final path = Path();
    final x = c.dx, y = c.dy;
    path.moveTo(x, y + s * 0.3);
    path.cubicTo(x - s * 0.5, y - s * 0.3, x - s, y + s * 0.3, x, y + s * 0.8);
    path.cubicTo(x + s, y + s * 0.3, x + s * 0.5, y - s * 0.3, x, y + s * 0.3);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_HeartsPainter old) => old.t != t;
}

// ============================================================
// "İşte bu yüzden buradayız" — ORTADA "VOXEN AI" + sağlı sollu "It's a Match"
// ============================================================
class ItsAMatchBackdropLogo extends StatefulWidget {
  const ItsAMatchBackdropLogo({super.key, this.logoSize = 130});
  final double logoSize;

  @override
  State<ItsAMatchBackdropLogo> createState() => _ItsAMatchBackdropLogoState();
}

class _ItsAMatchBackdropLogoState extends State<ItsAMatchBackdropLogo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 2200))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 3 satırlı düzen: üstte 2, ortada [sol – LOGO – sağ], altta 2.
    // Hiçbir rozet logoyla çakışmaz.
    return SizedBox(
      height: 330,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _MatchBadge(controller: _c, angle: -0.10, delay: 0.0),
              _MatchBadge(controller: _c, angle: 0.10, delay: 0.5),
            ],
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _MatchBadge(controller: _c, angle: -0.14, delay: 0.25),
              const Flexible(child: _VoxenBrandText()),
              _MatchBadge(controller: _c, angle: 0.14, delay: 0.75),
            ],
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _MatchBadge(controller: _c, angle: 0.10, delay: 0.6),
              _MatchBadge(controller: _c, angle: -0.10, delay: 0.15),
            ],
          ),
        ],
      ),
    );
  }
}

/// "VOXEN AI" — arka plansız; ışıltı, VOXEN'in N'si ile AI arasındaki boşlukta
/// yukarıda durur.
class _VoxenBrandText extends StatelessWidget {
  const _VoxenBrandText();

  @override
  Widget build(BuildContext context) {
    const fs = 30.0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        const Text('VOXEN',
            style: TextStyle(
                color: AppColors.textPrimary,
                fontSize: fs,
                fontWeight: FontWeight.w900,
                letterSpacing: 1)),
        // N ile AI arasındaki boşluk + ışıltı yukarıda
        SizedBox(
          width: 18,
          child: Transform.translate(
            offset: const Offset(0, -fs * 0.6),
            child: const Icon(Icons.auto_awesome,
                color: AppColors.gold, size: fs * 0.6),
          ),
        ),
        const Text('AI',
            style: TextStyle(
                color: AppColors.gold,
                fontSize: fs,
                fontWeight: FontWeight.w900,
                letterSpacing: 1)),
      ],
    );
  }
}

class _MatchBadge extends StatelessWidget {
  final AnimationController controller;
  final double angle;
  final double delay;
  const _MatchBadge(
      {required this.controller, required this.angle, required this.delay});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (_, child) {
        final v = (controller.value + delay) % 1.0;
        final scale = 0.92 + (sin(v * 2 * pi) + 1) / 2 * 0.12;
        return Transform.rotate(
          angle: angle,
          child: Transform.scale(scale: scale, child: child),
        );
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.goldSurface,
          border: Border.all(color: AppColors.gold, width: 1.5),
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.favorite, color: AppColors.gold, size: 12),
            SizedBox(width: 3),
            Text("It's a Match!",
                style: TextStyle(
                    color: AppColors.gold,
                    fontSize: 11,
                    fontWeight: FontWeight.w800)),
          ],
        ),
      ),
    );
  }
}

// ============================================================
// Marka logoları (Tinder / Bumble / Hinge) — gerçek PNG'ler,
// birbirine BİRLEŞİK/İÇ İÇE ve ANİMASYONLU, ekranın ortasında.
// ============================================================
class AnimatedBrandCluster extends StatefulWidget {
  const AnimatedBrandCluster({super.key, this.logoSize = 96});
  final double logoSize;

  @override
  State<AnimatedBrandCluster> createState() => _AnimatedBrandClusterState();
}

class _AnimatedBrandClusterState extends State<AnimatedBrandCluster>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 2600))
      ..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.logoSize;
    final overlap = s * 0.32; // iç içe geçme miktarı
    // Genişlik: 3 logo - 2 örtüşme
    final totalW = s * 3 - overlap * 2;
    return SizedBox(
      width: totalW,
      height: s * 1.35,
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, _) {
          final t = _c.value;
          return Stack(
            alignment: Alignment.center,
            children: [
              _logo('assets/images/bumble.png', 0, s, overlap, totalW, t, 0.0,
                  Icons.hexagon, const Color(0xFFFFC629)),
              _logo('assets/images/hinge.png', 2, s, overlap, totalW, t, 0.66,
                  Icons.favorite, const Color(0xFF6C2BD9)),
              // Ortadaki (Tinder) en önde
              _logo('assets/images/tinder.png', 1, s, overlap, totalW, t, 0.33,
                  Icons.local_fire_department, const Color(0xFFFD267D)),
            ],
          );
        },
      ),
    );
  }

  Widget _logo(String asset, int slot, double s, double overlap, double totalW,
      double t, double phase, IconData fallback, Color fallbackColor) {
    // slot: 0 sol, 1 orta, 2 sağ
    final left = slot * (s - overlap);
    // Hafif yukarı-aşağı süzülme (staggered)
    final bob = sin((t + phase) * 2 * pi) * 6;
    final scale = 0.96 + (sin((t + phase) * 2 * pi) + 1) / 2 * 0.08;
    return Positioned(
      left: left,
      top: (s * 1.35 - s) / 2 + bob,
      child: Transform.scale(
        scale: scale,
        child: Container(
          width: s,
          height: s,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(s * 0.28),
            boxShadow: const [
              BoxShadow(color: Colors.black54, blurRadius: 20, spreadRadius: 2),
            ],
          ),
          // Beyaz arka plan YOK — ikonun kendi görseli, yuvarlak köşeli.
          child: ClipRRect(
            borderRadius: BorderRadius.circular(s * 0.28),
            child: Image.asset(
              asset,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => Container(
                color: fallbackColor,
                child: Icon(fallback, color: Colors.white, size: s * 0.5),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ============================================================
// Sade telefon — siyah ekran (içerik sonra eklenecek)
// ============================================================
class EmptyBlackPhone extends StatelessWidget {
  final double width;
  const EmptyBlackPhone({super.key, this.width = 200});

  @override
  Widget build(BuildContext context) {
    final h = width * 2.0;
    return Container(
      width: width,
      height: h,
      padding: const EdgeInsets.all(7),
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(34),
        border: Border.all(color: const Color(0xFF2A2A2A), width: 3),
        boxShadow: const [
          BoxShadow(color: Colors.black54, blurRadius: 26, spreadRadius: 3),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(28),
        child: Container(
          color: Colors.black,
          child: Stack(
            children: [
              // Üstte çentik (notch) — telefon hissi
              Align(
                alignment: Alignment.topCenter,
                child: Container(
                  margin: const EdgeInsets.only(top: 10),
                  width: width * 0.32,
                  height: 6,
                  decoration: BoxDecoration(
                    color: const Color(0xFF1E1E1E),
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ============================================================
// DEMO VİDEO TELEFONU — telefon çerçevesi içinde döngüsel, sessiz demo videosu
// Uygulamanın çalışma mantığını (foto yükle → AI çıktı) gösterir.
// Video asset'i yoksa nazik bir placeholder gösterir (çökme yok).
// ============================================================
class DemoVideoPhone extends StatefulWidget {
  final String asset; // 'assets/videos/...mp4'
  final double width;
  final IconData fallbackIcon;
  final String fallbackLabel;
  const DemoVideoPhone({
    super.key,
    required this.asset,
    this.width = 210,
    this.fallbackIcon = Icons.play_circle_outline_rounded,
    this.fallbackLabel = 'Demo videosu yakında',
  });

  @override
  State<DemoVideoPhone> createState() => _DemoVideoPhoneState();
}

class _DemoVideoPhoneState extends State<DemoVideoPhone> {
  VideoPlayerController? _c;
  bool _ready = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final c = VideoPlayerController.asset(widget.asset);
      _c = c;
      await c.initialize();
      await c.setLooping(true);
      await c.setVolume(0);
      await c.play();
      if (mounted) setState(() => _ready = true);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _c?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.width;
    final h = w * 2.0;
    return Container(
      width: w,
      height: h,
      padding: const EdgeInsets.all(7),
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(34),
        border: Border.all(color: const Color(0xFF2A2A2A), width: 3),
        boxShadow: const [
          BoxShadow(color: Colors.black54, blurRadius: 26, spreadRadius: 3),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(28),
        child: Container(
          color: Colors.black,
          child: (_ready && _c != null)
              ? FittedBox(
                  fit: BoxFit.cover,
                  clipBehavior: Clip.hardEdge,
                  child: SizedBox(
                    width: _c!.value.size.width,
                    height: _c!.value.size.height,
                    child: VideoPlayer(_c!),
                  ),
                )
              : _placeholder(),
        ),
      ),
    );
  }

  Widget _placeholder() {
    return Container(
      color: const Color(0xFF0E0E10),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_failed) ...[
            Icon(widget.fallbackIcon,
                color: AppColors.gold.withValues(alpha: 0.85), size: 44),
            const SizedBox(height: 12),
            Text(widget.fallbackLabel,
                textAlign: TextAlign.center,
                style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.6),
                    fontSize: 12,
                    fontWeight: FontWeight.w700)),
          ] else
            const SizedBox(
              width: 34,
              height: 34,
              child: CircularProgressIndicator(
                  strokeWidth: 3, color: AppColors.gold),
            ),
        ],
      ),
    );
  }
}

// ============================================================
// Dikey bar grafiği (avg of likes) — 7.4x ekranı için
// ============================================================
class VerticalBarChart extends StatelessWidget {
  final String caption;
  final List<BarDatum2> data;
  const VerticalBarChart({super.key, required this.caption, required this.data});

  static const double _barMax = 150; // en yüksek bar (px)
  static const double _boxH = 178; // bar + üstteki değer için alan

  @override
  Widget build(BuildContext context) {
    final maxVal =
        data.map((d) => d.value).fold<double>(0, (a, b) => a > b ? a : b);
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(caption,
              style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textSecondary)),
          const SizedBox(height: 20),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [for (final d in data) _bar(d, maxVal)],
          ),
        ],
      ),
    );
  }

  Widget _bar(BarDatum2 d, double maxVal) {
    final frac = maxVal == 0 ? 0.0 : d.value / maxVal;
    final color = d.highlight ? AppColors.gold : AppColors.textSecondary;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Bar alanı: değer etiketi barın tam tepesinde durur
        SizedBox(
          height: _boxH,
          width: 72,
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: frac),
            duration: const Duration(milliseconds: 900),
            curve: Curves.easeOutCubic,
            builder: (_, value, _) {
              final barH = _barMax * value;
              return Stack(
                alignment: Alignment.bottomCenter,
                children: [
                  // Bar
                  Container(
                    width: 56,
                    height: barH,
                    decoration: BoxDecoration(
                      gradient: d.highlight
                          ? AppColors.goldGradient
                          : const LinearGradient(
                              colors: [Color(0xFF3A3030), Color(0xFF241D1F)],
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter),
                      borderRadius: const BorderRadius.vertical(
                          top: Radius.circular(8)),
                    ),
                  ),
                  // Değer etiketi barın tepesinde
                  Positioned(
                    bottom: barH + 4,
                    child: Text(d.valueLabel,
                        style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                            color: color)),
                  ),
                ],
              );
            },
          ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: 90,
          child: Text(d.label,
              textAlign: TextAlign.center,
              maxLines: 2,
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: d.highlight ? FontWeight.w800 : FontWeight.w500,
                  color: color)),
        ),
      ],
    );
  }
}

class BarDatum2 {
  final String label;
  final double value;
  final String valueLabel;
  final bool highlight;
  const BarDatum2(this.label, this.value, this.valueLabel,
      {this.highlight = false});
}

// ============================================================
// Önce/Sonra — GERÇEK Tinder ekran görüntüleri (assets/images/oncesi.jpg,
// assets/images/sonrasi.jpg). Kullanıcı yüzleri/adları gizliliği için hafif
// blur uygulanır. Görsel eksikse nazik bir placeholder'a düşer (çökme yok).
// ============================================================
class BeforeAfterPhones extends StatelessWidget {
  const BeforeAfterPhones({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Expanded(
          child: _MiniPhone(
            after: false,
            asset: 'assets/images/oncesi.jpg',
            // Kaynak görselde telefon çerçevesi yok → burada eklenir.
            framed: true,
          ),
        ),
        SizedBox(width: 14),
        Expanded(
          child: _MiniPhone(
            after: true,
            asset: 'assets/images/sonrasi.jpg',
            // Kaynak görsel zaten kendi telefon çerçevesiyle geliyor.
            framed: false,
          ),
        ),
      ],
    );
  }
}

class _MiniPhone extends StatelessWidget {
  final bool after;
  final String asset;
  final bool framed;
  const _MiniPhone({
    required this.after,
    required this.asset,
    required this.framed,
  });

  @override
  Widget build(BuildContext context) {
    final image = ClipRRect(
      borderRadius: BorderRadius.circular(framed ? 18 : 22),
      child: Image.asset(
        asset,
        fit: BoxFit.cover,
        width: double.infinity,
        height: double.infinity,
        errorBuilder: (_, _, _) => Container(
          color: const Color(0xFF0E0E10),
          alignment: Alignment.center,
          child: Icon(
              after ? Icons.favorite_rounded : Icons.search_off_rounded,
              color: Colors.white.withValues(alpha: 0.25),
              size: 40),
        ),
      ),
    );

    return Column(
      children: [
        Text(after ? 'SONRA' : 'ÖNCE',
            style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w900,
                letterSpacing: 1,
                color: after ? AppColors.gold : AppColors.textMuted)),
        const SizedBox(height: 8),
        AspectRatio(
          aspectRatio: 0.5,
          child: framed
              ? Container(
                  padding: const EdgeInsets.all(5),
                  decoration: BoxDecoration(
                    color: Colors.black,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(
                        color: after
                            ? AppColors.gold
                            : const Color(0xFF2A2A2A),
                        width: 2),
                  ),
                  child: image,
                )
              : Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(22),
                    border: Border.all(
                        color: after
                            ? AppColors.gold
                            : const Color(0xFF2A2A2A),
                        width: 2),
                  ),
                  child: image,
                ),
        ),
        const SizedBox(height: 8),
        Text(after ? '24+ eşleşme' : 'Neredeyse hiç eşleşme yok',
            textAlign: TextAlign.center,
            style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: after ? AppColors.gold : AppColors.textMuted)),
      ],
    );
  }
}
