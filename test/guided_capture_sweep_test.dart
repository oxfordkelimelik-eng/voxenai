import 'package:flutter_test/flutter_test.dart';
import 'package:rise_up/presentation/screens/analysis/guided_capture_screen.dart';

void main() {
  group('sweepAngleFor', () {
    test('düz bakış = ön', () {
      expect(sweepAngleFor(0, 0), CaptureAngle.front);
      expect(sweepAngleFor(-4.5, 3), CaptureAngle.front);
    });
    test('yön bantları', () {
      expect(sweepAngleFor(9, 0), CaptureAngle.turnR1);
      expect(sweepAngleFor(18, -2), CaptureAngle.turnR2);
      expect(sweepAngleFor(30, 0), CaptureAngle.turnR3);
      expect(sweepAngleFor(50, 0), CaptureAngle.turnR4);
      expect(sweepAngleFor(-9, 0), CaptureAngle.turnL1);
      expect(sweepAngleFor(-18, 0), CaptureAngle.turnL2);
      expect(sweepAngleFor(-30, 0), CaptureAngle.turnL3);
      expect(sweepAngleFor(-50, 0), CaptureAngle.turnL4);
    });
    test('bant araları ve eğik baş boş', () {
      expect(sweepAngleFor(13.5, 0), isNull);
      expect(sweepAngleFor(37, 0), isNull);
      expect(sweepAngleFor(70, 0), isNull);
      expect(sweepAngleFor(18, 6), isNull); // yukarı bakıyor
    });
    test('çene aşağı', () {
      expect(sweepAngleFor(2, -18), CaptureAngle.chinDown);
      expect(sweepAngleFor(12, -18), isNull);
    });
  });

  group('sweepHint', () {
    test('sağ hedefe yönlendirir', () {
      expect(sweepHint(CaptureAngle.turnR2, 3, 0), contains('SAĞA'));
      expect(sweepHint(CaptureAngle.turnR2, 30, 0), contains('geri'));
    });
    test('sol hedefe yönlendirir; sağdaysa önce kameraya', () {
      expect(sweepHint(CaptureAngle.turnL1, 40, 0), contains('kameraya'));
      expect(sweepHint(CaptureAngle.turnL1, 0, 0), contains('SOLA'));
      expect(sweepHint(CaptureAngle.turnL4, -70, 0), contains('geri'));
    });
    test('baş eğimi önce düzeltilir', () {
      expect(sweepHint(CaptureAngle.turnR3, 0, 9), contains('göz hizana'));
    });
    test('çene aşağı', () {
      expect(sweepHint(CaptureAngle.chinDown, 0, 0), contains('ÖNE'));
    });
  });

  group('sweepStillMatches', () {
    test('±4° pay, işaretten bağımsız', () {
      expect(sweepStillMatches(CaptureAngle.turnR2, 24, 0), isTrue);
      expect(sweepStillMatches(CaptureAngle.turnR2, -18, 0), isTrue);
      expect(sweepStillMatches(CaptureAngle.turnR2, 28, 0), isFalse);
      expect(sweepStillMatches(CaptureAngle.front, 8, 0), isTrue);
      expect(sweepStillMatches(CaptureAngle.front, 11, 0), isFalse);
      expect(sweepStillMatches(CaptureAngle.turnR1, 9, 15), isFalse);
      expect(sweepStillMatches(CaptureAngle.chinDown, 3, -15), isTrue);
      expect(sweepStillMatches(CaptureAngle.chinDown, 3, 0), isFalse);
    });
  });

  group('sweepFramingProblem', () {
    // 9:16 dik görüntü, yüz kutusu kare (genişlik birimiyle)
    const aspect = 16 / 9;
    String? frame(double cx, double cy, double w, double hInWidths) {
      final h = hInWidths / aspect;
      return sweepFramingProblem(
          left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2, aspect: aspect);
    }

    test('ovalde ortalı yüz geçer', () {
      expect(frame(0.5, 0.42, 0.55, 0.6), isNull);
    });
    test('yana dönük daralmış kutu "yaklaş" demez (boy ölçer)', () {
      expect(frame(0.62, 0.42, 0.34, 0.55), isNull);
    });
    test('uzak / yakın / taşan', () {
      expect(frame(0.5, 0.42, 0.3, 0.3), contains('yaklaş'));
      expect(frame(0.5, 0.42, 0.85, 0.85), contains('uzaklaş'));
      expect(frame(0.8, 0.42, 0.5, 0.5), isNotNull);
    });
  });
}
