import 'package:flutter_test/flutter_test.dart';
import 'package:rise_up/presentation/screens/analysis/guided_capture_screen.dart';

void main() {
  group('guidedTurnProblem (yönlendirmeli çekim payı)', () {
    test('bant ±4° payla kabul', () {
      // turnR2 bandı 15..22 → 11..26
      expect(guidedTurnProblem(CaptureAngle.turnR2, 11.5, {}), isNull);
      expect(guidedTurnProblem(CaptureAngle.turnR2, 25.5, {}), isNull);
      expect(guidedTurnProblem(CaptureAngle.turnR2, 10, {}), contains('SAĞA'));
      expect(guidedTurnProblem(CaptureAngle.turnR2, 27, {}), contains('geri'));
      // turnL3 bandı -34..-26 → -38..-22
      expect(guidedTurnProblem(CaptureAngle.turnL3, -23, {}), isNull);
      expect(guidedTurnProblem(CaptureAngle.turnL3, -21, {}), contains('SOLA'));
      expect(guidedTurnProblem(CaptureAngle.turnL3, -39, {}), contains('geri'));
    });
    test('önceki kareden en az 3° dışarıda', () {
      final cap = {CaptureAngle.front: 7.0, CaptureAngle.turnR1: 14.0};
      expect(guidedTurnProblem(CaptureAngle.turnR1, 9, cap), contains('SAĞA')); // front 7 → ≥10
      expect(guidedTurnProblem(CaptureAngle.turnR2, 15, cap), contains('SAĞA')); // R1 14 → ≥17
      expect(guidedTurnProblem(CaptureAngle.turnR2, 17, cap), isNull);
      final capL = {CaptureAngle.front: -2.0};
      expect(guidedTurnProblem(CaptureAngle.turnL1, -4, capL), contains('SOLA')); // ≤ -5
      expect(guidedTurnProblem(CaptureAngle.turnL1, -5, capL), isNull);
    });
    test('sonraki açı denetlenmez (tek açı yeniden çekim kilitlenmez)', () {
      final cap = {CaptureAngle.turnR1: 12.0, CaptureAngle.turnR3: 16.0};
      expect(guidedTurnProblem(CaptureAngle.turnR2, 15, cap), isNull);
    });
  });

  group('guidedLevelPitchMessage', () {
    test('yukarı sınır aynı, aşağı payı 3°', () {
      expect(guidedLevelPitchMessage(4), isNull);
      expect(guidedLevelPitchMessage(5), contains('göz hizana'));
      expect(guidedLevelPitchMessage(-10.5), isNull);
      expect(guidedLevelPitchMessage(-12), contains('kaldır'));
    });
  });
}
