// FOTO DÜZENLEYİCİ (2026-11-22): önizleme formülleri sunucuyla birebir aynı olmalı.
// Altın değerler functions/test/photoEdits.test.js ile AYNI.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:rise_up/presentation/ops/photo_edits.dart';

void main() {
  const px = [200, 150, 120, 30, 60, 200, 128, 128, 128, 10, 10, 10, 250, 240, 230];
  final golden = <(PhotoEdits, List<int>)>[
    (const PhotoEdits(preset: 'sicak'), [215, 150, 109, 26, 55, 216, 134, 127, 123, 9, 3, 0, 255, 246, 229]),
    (const PhotoEdits(preset: 'sb_kontrast'), [165, 165, 165, 50, 50, 50, 128, 128, 128, 2, 2, 2, 252, 252, 252]),
    (const PhotoEdits(preset: 'sinematik', intensity: 60, adj: {'exposure': 20}), [191, 146, 118, 27, 60, 206, 136, 138, 138, 2, 4, 4, 224, 226, 226]),
    (
      const PhotoEdits(adj: {'contrast': 40, 'saturation': -30, 'highlights': -50, 'shadows': 60, 'fade': 20, 'warmth': -40, 'tint': 30, 'brightness': -25}),
      [170, 135, 125, 35, 49, 160, 104, 106, 120, 29, 31, 45, 218, 220, 234]
    ),
  ];

  test('altın değerler sunucuyla aynı', () {
    for (final (e, want) in golden) {
      final d = Uint8List.fromList(px);
      renderPixels(d, 5, 1, 3, combineEdits(e));
      expect(d.toList(), want, reason: e.toJson().toString());
    }
  });

  test('vinyet kenarı karartır, merkeze dokunmaz', () {
    final d = Uint8List.fromList([200, 150, 120, 200, 150, 120, 200, 150, 120]);
    renderPixels(d, 3, 1, 3, combineEdits(const PhotoEdits(adj: {'vignette': 100})));
    expect(d.toList(), [80, 60, 48, 200, 150, 120, 80, 60, 48]);
  });

  test('boş düzenleme ve json gidiş-dönüş', () {
    expect(PhotoEdits.empty.isEmpty, isTrue);
    const e = PhotoEdits(preset: 'canli', intensity: 70, adj: {'contrast': 10}, glow: true);
    final back = PhotoEdits.fromJson(e.toJson());
    expect(back.preset, 'canli');
    expect(back.intensity, 70);
    expect(back.adj, {'contrast': 10});
    expect(back.glow, isTrue);
  });

  // FLAŞ (2026-11-22): functions/test/flashEffect.test.js ile AYNI altın değerler.
  group('flaş', () {
    const w = 9, h = 7, n = w * h;
    (Uint8List, Float32List, Float32List) input() {
      final d = Uint8List(n * 3);
      for (var i = 0; i < n; i++) {
        for (var c = 0; c < 3; c++) {
          d[i * 3 + c] = (i * 37 + c * 91) % 256;
        }
      }
      final f = Float32List(n), s = Float32List(n);
      for (var i = 0; i < n; i++) {
        f[i] = ((i * 13) % 100) / 100;
        s[i] = ((i * 7) % 30) / 100;
      }
      return (d, f, s);
    }

    final golden = <(double, bool, List<int>)>[
      (1.0, false, [0,24,53,3,56,99,37,102,0,84,155,26,128,199,64,157,10,96,192,58,134,2,78,139,0,31,61,19,66,0,58,119,8,118,190,53,194,124,166,234,98,175,0,112,207,60,155,233,17,74,0,41,85,10,81,131,36,166,88,134,205,54,140,0,98,186,69,175,255,105,206,0,61,133,12,97,157,47,138,72,110,142,42,99,100,150,194,45,140,225,122,224,15,75,146,29,102,174,44,141,16,90,146,32,98,0,62,119,38,98,151,85,159,13,132,216,48,100,170,48,163,78,129,181,46,124,0,84,159,107,155,199,121,160,83,86,134,37,132,0,81,104,16,69,167,47,117,0,88,164,77,138,193,69,141,4,113,175,49,103,1,62,50,6,33,86,23,60,97,131,160,134,168,199,71,139,9,96,160,35,129,1,77,143,39,98,71,23,51]),
      (0.55, false, [0,52,108,18,87,152,54,130,0,97,176,30,156,218,102,169,14,102,206,58,140,1,86,161,10,71,127,43,110,0,83,157,22,133,214,64,200,126,169,232,61,156,0,104,198,51,145,231,46,118,0,74,137,23,113,181,55,182,92,143,215,58,146,0,98,187,57,157,249,93,190,2,92,173,28,125,198,63,166,77,127,182,53,125,10,99,181,46,139,226,105,203,14,104,185,40,134,215,66,169,24,106,185,48,125,2,81,154,44,119,188,86,168,13,128,215,49,136,216,70,186,85,143,209,58,143,6,95,177,45,129,208,127,177,82,107,175,45,148,0,86,152,27,98,203,60,141,10,100,182,40,126,208,80,160,11,122,198,53,135,1,79,114,20,73,152,45,105,102,144,184,53,131,206,83,161,15,113,189,46,150,3,87,177,42,118,145,47,102]),
      (1.0, true, [0,21,52,8,53,98,40,100,0,85,154,27,127,199,65,162,8,95,193,57,135,3,77,139,0,29,60,22,65,0,58,118,9,116,190,55,198,123,165,236,97,176,0,110,208,58,154,237,23,72,0,43,84,10,80,131,37,170,86,133,208,52,140,0,96,186,66,174,255,101,206,3,65,131,12,97,157,48,141,70,110,145,41,99,102,150,194,44,139,227,118,224,20,80,144,29,103,174,45,149,13,89,151,30,98,0,61,119,38,97,152,83,159,15,128,216,51,102,169,48,170,75,127,186,43,123,1,82,158,107,155,200,120,160,84,84,134,39,136,0,80,111,13,67,173,45,116,5,86,163,78,137,194,68,141,5,110,175,52,106,0,62,54,4,32,90,21,59,98,130,160,134,168,200,70,139,11,94,160,37,132,0,76,143,38,99,74,22,51]),
    ];

    test('altın değerler sunucuyla aynı', () {
      for (final (k, gray, want) in golden) {
        final (d, f, s) = input();
        applyFlash(d, w, h, 3, f, s, k, gray);
        expect(d.toList(), want, reason: 'k=$k gray=$gray');
      }
    });

    test('mulberry32 JS ile aynı dizi', () {
      final r = mulberry32(12345);
      expect([r(), r(), r()], [0.9797282677609473,0.3067522644996643,0.484205421525985]);
    });

    test('flash alanı json gidiş-dönüş', () {
      const e = PhotoEdits(flash: 60);
      expect(e.isEmpty, isFalse);
      expect(PhotoEdits.fromJson(e.toJson()).flash, 60);
    });
  });
}
