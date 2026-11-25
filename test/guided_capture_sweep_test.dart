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

  group('SweepMotion (2026-11-25 durgunluk penceresi)', () {
    final t0 = DateTime(2026, 11, 25, 12);
    DateTime at(int ms) => t0.add(Duration(milliseconds: ms));
    test('sakin baş 500 ms ve 3 ölçüde durgun; daha erken değil', () {
      final m = SweepMotion();
      m.add(20, 0, 0, at(0));
      m.add(20.8, -0.5, 0.4, at(200)); // ML Kit titremesi ~1°
      expect(m.steady(at(200)), isFalse);
      m.add(19.6, 0.3, -0.3, at(400));
      expect(m.steady(at(400)), isFalse); // 400 ms
      m.add(20.4, 0, 0, at(520));
      expect(m.steady(at(520)), isTrue);
    });
    test('25°/sn dönüş pencereyi sıfırlar, durgun olmaz', () {
      final m = SweepMotion();
      for (int i = 0; i <= 10; i++) {
        m.add(10 + 2.5 * i, 0, 0, at(100 * i)); // 25°/sn
      }
      expect(m.steady(at(1000)), isFalse);
    });
    test('yaw sabitken pitch ya da roll oynaması da sıfırlar', () {
      final p = SweepMotion()..add(20, 0, 0, at(0))..add(20, 5, 0, at(300))..add(20, 5, 0, at(600));
      expect(p.steady(at(600)), isFalse);
      final r = SweepMotion()..add(20, 0, 0, at(0))..add(20, 0, 5, at(300))..add(20, 0, 5, at(600));
      expect(r.steady(at(600)), isFalse);
    });
    test('kayan pencere: 7°/sn yavaş dönüş geçer, 10°/sn geçmez', () {
      final slow = SweepMotion();
      for (int i = 0; i <= 6; i++) {
        slow.add(20 + 0.7 * i, 0, 0, at(100 * i));
      }
      expect(slow.steady(at(600)), isTrue);
      final fast = SweepMotion();
      for (int i = 0; i <= 10; i++) {
        fast.add(20 + 1.0 * i, 0, 0, at(100 * i));
      }
      expect(fast.steady(at(1000)), isFalse);
    });
    test('≥1 sn ölçü boşluğu pencereyi sıfırlar (eskiden durgun sayılıyordu)', () {
      final m = SweepMotion()..add(20, 0, 0, at(0))..add(20, 0, 0, at(1200));
      expect(m.samples, 1);
      expect(m.steady(at(1200)), isFalse);
    });
    test('sabitler: 500 ms, 4°, en az 3 ölçü', () {
      expect(kSweepDwell, const Duration(milliseconds: 500));
      expect(kSweepMaxRange, 4.0);
      expect(kSweepMinSamples, 3);
    });
  });

  group('netlik (2026-11-25)', () {
    test('laplacianEnergy kontrasttan bağımsız (gölgeli açı bulanık sayılmasın)', () {
      const w = 16, h = 16;
      final hi = [for (int i = 0; i < w * h; i++) ((i % w) + (i ~/ w)).isEven ? 160 : 80];
      final lo = [for (int i = 0; i < w * h; i++) ((i % w) + (i ~/ w)).isEven ? 150 : 90]; // 0.75 kontrast
      final r = laplacianEnergy(lo, w, h) / laplacianEnergy(hi, w, h);
      expect(r, greaterThan(kStillSharpRatio));
    });
    test('laplacianEnergy: düz alan 0, desen > 0, bulanık < net', () {
      const w = 16, h = 16;
      final flat = List<int>.filled(w * h, 120);
      expect(laplacianEnergy(flat, w, h), 0);
      final sharp = [for (int i = 0; i < w * h; i++) ((i % w) + (i ~/ w)).isEven ? 160 : 80];
      final soft = [for (int i = 0; i < w * h; i++) ((i % w) + (i ~/ w)).isEven ? 125 : 115];
      expect(laplacianEnergy(sharp, w, h), greaterThan(laplacianEnergy(soft, w, h)));
    });
    test('stillSharpEnough: referans azken geçer, medyanın %60 altı reddedilir', () {
      expect(stillSharpEnough(1, [100]), isTrue);
      expect(stillSharpEnough(70, [100, 110, 90]), isTrue);
      expect(stillSharpEnough(50, [100, 110, 90]), isFalse);
      expect(stillSharpEnough(59, [100, 100]), isFalse);
    });
  });
}
