// logo.jpg'den kare bir uygulama ikonu (assets/icon/icon.png) üretir.
// Yatay görselin ortasındaki kare bölge kırpılır ve 1024x1024'e ölçeklenir.
//
// Çalıştır: dart run tool/make_icon.dart
import 'dart:io';
import 'package:image/image.dart' as img;

void main() {
  final src = img.decodeImage(File('logo.jpg').readAsBytesSync());
  if (src == null) {
    stderr.writeln('logo.jpg okunamadı');
    exit(1);
  }

  final w = src.width;
  final h = src.height;
  // Kare kenar = kısa kenar. Merkezden kırp.
  final side = w < h ? w : h;
  final x = ((w - side) / 2).round();
  final y = ((h - side) / 2).round();

  final cropped = img.copyCrop(src, x: x, y: y, width: side, height: side);
  final resized = img.copyResize(
    cropped,
    width: 1024,
    height: 1024,
    interpolation: img.Interpolation.cubic,
  );

  Directory('assets/icon').createSync(recursive: true);
  File('assets/icon/icon.png').writeAsBytesSync(img.encodePng(resized));
  stdout.writeln('assets/icon/icon.png üretildi (1024x1024, kaynak ${w}x$h, kırpım ${side}x$side @ $x,$y)');

  // Adaptive icon foreground: güvenli bölge ~%66 olduğundan logoyu küçültüp
  // şeffaf bir tuvalin ortasına yerleştir (kenarlardan kırpılmasın).
  const canvas = 1024;
  const logoSize = 660; // ~%64 güvenli alan
  final fgLogo = img.copyResize(
    cropped,
    width: logoSize,
    height: logoSize,
    interpolation: img.Interpolation.cubic,
  );
  final fg = img.Image(width: canvas, height: canvas, numChannels: 4);
  // Tamamen şeffaf yap
  img.fill(fg, color: img.ColorRgba8(0, 0, 0, 0));
  const offset = (canvas - logoSize) ~/ 2;
  img.compositeImage(fg, fgLogo, dstX: offset, dstY: offset);
  File('assets/icon/icon_foreground.png').writeAsBytesSync(img.encodePng(fg));
  stdout.writeln('assets/icon/icon_foreground.png üretildi (1024x1024, logo $logoSize ortalı, şeffaf padding)');
}
