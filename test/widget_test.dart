import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rise_up/app.dart';

void main() {
  testWidgets('Rise Up smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: RiseUpApp()));
    // MaterialApp.router yine bir MaterialApp örneği oluşturur.
    expect(find.byType(MaterialApp), findsOneWidget);
    // Splash ekranı 2.5sn'lik bir gecikme başlatır; bekleyen timer'ı boşalt.
    await tester.pump(const Duration(seconds: 3));
  });
}
