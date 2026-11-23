// RIZZGPT VE PROFİL DOKTORU KAPAK GÖRSELLERİ (2026-11-23, kullanıcı: "kendine ait fotosu ve kartı olsun").
//
// Ana sayfa kartında ve aracın giriş ekranında aynı görsel kullanılır. Hazır fotoğraflardan (assets/dating)
// kodla kurulur: görsel dosyası yerine canlı bileşen olduğu için her ekran boyutunda net kalır. İçerik sabit
// bir tasarım alanında (240x160) çizilip FittedBox ile alana sığdırılır (dar kartta taşma olmaz).

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/constants/app_colors.dart';

const _bgDeep = Color(0xFF2A0D16);
const _bgWarm = Color(0xFF55182A);

/// Kartların ortak zemini: koyu bordo gradyan + sağ üstte hafif kırmızı parıltı.
class _CoverBackdrop extends StatelessWidget {
  final Widget child;
  const _CoverBackdrop({required this.child});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [_bgWarm, _bgDeep],
          begin: Alignment.topRight,
          end: Alignment.bottomLeft,
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned(
            right: -40,
            top: -50,
            child: SizedBox(
              width: 180,
              height: 180,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(colors: [Color(0x55FF2D55), Color(0x00FF2D55)]),
                ),
              ),
            ),
          ),
          Center(
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: FittedBox(fit: BoxFit.contain, child: SizedBox(width: 240, height: 160, child: child)),
            ),
          ),
        ],
      ),
    );
  }
}

/// RizzGPT: karşı tarafın mesajı + AI'ın önerdiği cevap (sohbet baloncukları).
class RizzCoverVisual extends StatelessWidget {
  const RizzCoverVisual({super.key});

  @override
  Widget build(BuildContext context) {
    return _CoverBackdrop(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              ClipOval(
                child: Image.asset('assets/dating/f5.jpg',
                    width: 28, height: 28, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox(width: 28)),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
                  decoration: const BoxDecoration(
                    color: Color(0x2EFFFFFF),
                    borderRadius: BorderRadius.only(
                      topLeft: Radius.circular(14),
                      topRight: Radius.circular(14),
                      bottomRight: Radius.circular(14),
                      bottomLeft: Radius.circular(4),
                    ),
                  ),
                  child: const Text('Hafta sonu planın ne? 😊',
                      style: TextStyle(fontSize: 12.5, color: Colors.white, height: 1.3)),
                ),
              ),
              const SizedBox(width: 30),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
                  decoration: const BoxDecoration(
                    gradient: AppColors.goldGradient,
                    borderRadius: BorderRadius.only(
                      topLeft: Radius.circular(14),
                      topRight: Radius.circular(14),
                      bottomLeft: Radius.circular(14),
                      bottomRight: Radius.circular(4),
                    ),
                    boxShadow: [BoxShadow(color: Color(0x66FF2D55), blurRadius: 14, offset: Offset(0, 4))],
                  ),
                  child: const Text('Plan B hazır; plan A için senin "evet" demen lazım 😏',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Colors.white, height: 1.3)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Align(
            alignment: Alignment.centerRight,
            child: _GlassPill(icon: Icons.bolt_rounded, text: '3 cevap hazır'),
          ),
        ],
      ),
    );
  }
}

/// Profil Doktoru: yelpaze şeklinde üç profil fotoğrafı, her birinde karar etiketi.
class DoctorCoverVisual extends StatelessWidget {
  const DoctorCoverVisual({super.key});

  @override
  Widget build(BuildContext context) {
    Widget card(String asset, double angle, double dx, double scale, Widget tag) => Transform.translate(
          offset: Offset(dx, 0),
          child: Transform.rotate(
            angle: angle * math.pi / 180,
            child: Transform.scale(
              scale: scale,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 74,
                    height: 98,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.white, width: 2),
                      boxShadow: const [BoxShadow(color: Color(0x80000000), blurRadius: 12, offset: Offset(0, 6))],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.asset(asset,
                          fit: BoxFit.cover, errorBuilder: (_, _, _) => const ColoredBox(color: _bgDeep)),
                    ),
                  ),
                  const SizedBox(height: 6),
                  tag,
                ],
              ),
            ),
          ),
        );
    return _CoverBackdrop(
      child: Stack(
        alignment: Alignment.center,
        children: [
          card('assets/dating/styles/nightout_1.jpg', -10, -66, 0.86,
              const _Verdict('Çıkar', AppColors.textSecondary, Icons.close_rounded)),
          card('assets/dating/styles/traveller_1.jpg', 10, 66, 0.86,
              const _Verdict('Kalsın', AppColors.success, Icons.check_rounded)),
          card('assets/dating/styles/elegance_1.jpg', 0, 0, 1.0,
              const _Verdict('Başa al', AppColors.gold, Icons.north_rounded, filled: true)),
        ],
      ),
    );
  }
}

class _Verdict extends StatelessWidget {
  final String text;
  final Color color;
  final IconData icon;
  final bool filled;
  const _Verdict(this.text, this.color, this.icon, {this.filled = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: filled ? color : const Color(0xCC1A0A10),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: filled ? color : color.withValues(alpha: 0.7)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 11, color: filled ? Colors.white : color),
          const SizedBox(width: 3),
          Text(text,
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: filled ? Colors.white : color)),
        ],
      ),
    );
  }
}

class _GlassPill extends StatelessWidget {
  final IconData icon;
  final String text;
  const _GlassPill({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0x33000000),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x33FFFFFF)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: AppColors.goldLight),
          const SizedBox(width: 4),
          Text(text, style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: Colors.white)),
        ],
      ),
    );
  }
}
