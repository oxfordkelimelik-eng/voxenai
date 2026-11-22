// FOTO DÜZENLEYİCİ (2026-11-22) — önizleme matematiği.
//
// Sunucudaki functions/photoEdits.js ile BİREBİR aynı formüller (PRESETS, ADJ, toneLut,
// renderPixels). Kaydedince sunucu asıl kareyi tam çözünürlükte aynı formüllerle üretir;
// altın değer testleri iki tarafta da aynı (functions/test/photoEdits.test.js,
// test/ops_photo_edits_test.dart). Formülü bir tarafta değiştirirsen öbürünü de değiştir.
//
// Önizlemeye özel yaklaşık iki adım: ışıklı (sunucuda yüz/kişi maskeli faceGlow; burada
// yalnız genel ton eğrisi) ve keskinlik (sunucuda sharp unsharp; burada 3×3).

import 'dart:math' as math;
import 'dart:typed_data';

class AdjSpec {
  final String key;
  final String label;
  final int min;
  final int max;
  const AdjSpec(this.key, this.label, this.min, this.max);
}

const List<AdjSpec> kAdjSpecs = [
  AdjSpec('exposure', 'Pozlama', -100, 100),
  AdjSpec('brightness', 'Parlaklık', -100, 100),
  AdjSpec('contrast', 'Kontrast', -100, 100),
  AdjSpec('saturation', 'Doygunluk', -100, 100),
  AdjSpec('warmth', 'Sıcaklık', -100, 100),
  AdjSpec('tint', 'Renk tonu', -100, 100),
  AdjSpec('highlights', 'Vurgular', -100, 100),
  AdjSpec('shadows', 'Gölgeler', -100, 100),
  AdjSpec('fade', 'Soldurma', 0, 100),
  AdjSpec('vignette', 'Vinyet', 0, 100),
  AdjSpec('sharpen', 'Keskinlik', 0, 100),
];

class PresetSpec {
  final String key;
  final String label;
  final Map<String, double> adj;
  const PresetSpec(this.key, this.label, this.adj);
}

const List<PresetSpec> kPresets = [
  PresetSpec('canli', 'Canlı', {'contrast': 22, 'saturation': 25, 'highlights': 8, 'warmth': -6}),
  PresetSpec('sicak', 'Sıcak', {'warmth': 28, 'saturation': 12, 'contrast': 8, 'tint': 4}),
  PresetSpec('aydinlik', 'Aydınlık', {'brightness': 18, 'shadows': 22, 'saturation': -8, 'warmth': -4}),
  PresetSpec('soluk', 'Soluk', {'fade': 35, 'contrast': -15, 'saturation': -12, 'warmth': 6}),
  PresetSpec('vintage', 'Vintage', {'warmth': 24, 'fade': 18, 'contrast': 6, 'brightness': 6, 'tint': 6}),
  PresetSpec('mat', 'Mat', {'fade': 22, 'contrast': -10, 'saturation': -15, 'highlights': -10}),
  PresetSpec('serin', 'Serin', {'warmth': -25, 'tint': -4, 'contrast': 10, 'saturation': -5}),
  PresetSpec('altin', 'Altın Saat', {'warmth': 35, 'exposure': 10, 'saturation': 10, 'shadows': 15}),
  PresetSpec('sinematik', 'Sinematik', {'contrast': 20, 'saturation': -12, 'tint': -6, 'warmth': -10, 'vignette': 30, 'fade': 10}),
  PresetSpec('dramatik', 'Dramatik', {'contrast': 35, 'shadows': -15, 'highlights': -10, 'saturation': -8, 'vignette': 35}),
  PresetSpec('sb', 'S/B', {'saturation': -100}),
  PresetSpec('sb_kontrast', 'S/B Kontrast', {'saturation': -100, 'contrast': 30, 'fade': 8}),
];

PresetSpec? presetByKey(String? k) {
  for (final p in kPresets) {
    if (p.key == k) return p;
  }
  return null;
}

/// Bir karenin düzenlemesi. Sunucuya `toJson()` gider (photoEdits.normalizeEdits).
class PhotoEdits {
  final String? preset;
  final int intensity;
  final Map<String, int> adj;
  final bool glow;

  /// Flaş filtresi yoğunluğu (functions/flashEffect.js): 0 kapalı, 1..100.
  final int flash;

  const PhotoEdits({this.preset, this.intensity = 100, this.adj = const {}, this.glow = false, this.flash = 0});

  static const empty = PhotoEdits();

  bool get isEmpty =>
      presetByKey(preset) == null && !glow && flash == 0 && adj.values.every((v) => v == 0);

  PhotoEdits copyWith(
          {String? preset, bool clearPreset = false, int? intensity, Map<String, int>? adj, bool? glow, int? flash}) =>
      PhotoEdits(
        preset: clearPreset ? null : (preset ?? this.preset),
        intensity: intensity ?? this.intensity,
        adj: adj ?? this.adj,
        glow: glow ?? this.glow,
        flash: flash ?? this.flash,
      );

  PhotoEdits withAdj(String key, int value) {
    final m = Map<String, int>.from(adj);
    if (value == 0) {
      m.remove(key);
    } else {
      m[key] = value;
    }
    return copyWith(adj: m);
  }

  Map<String, dynamic> toJson() => {
        'preset': preset,
        'intensity': intensity,
        'adj': {for (final e in adj.entries) if (e.value != 0) e.key: e.value},
        'glow': glow,
        'flash': flash,
      };

  factory PhotoEdits.fromJson(Map<String, dynamic>? j) {
    if (j == null) return PhotoEdits.empty;
    final adj = <String, int>{};
    final a = j['adj'];
    if (a is Map) {
      for (final e in a.entries) {
        final v = e.value;
        if (v is num && v != 0) adj[e.key.toString()] = v.round();
      }
    }
    return PhotoEdits(
      preset: presetByKey(j['preset'] as String?)?.key,
      intensity: (j['intensity'] as num?)?.round() ?? 100,
      adj: adj,
      glow: j['glow'] == true,
      flash: ((j['flash'] as num?)?.round() ?? 0).clamp(0, 100),
    );
  }
}

double _clampTo(double v, AdjSpec s) => v < s.min ? s.min.toDouble() : (v > s.max ? s.max.toDouble() : v);

/// Hazır filtre × yoğunluk + kullanıcı ayarları (photoEdits.combine).
Map<String, double> combineEdits(PhotoEdits e) {
  final pr = presetByKey(e.preset);
  final k = pr == null ? 0.0 : e.intensity / 100;
  return {
    for (final s in kAdjSpecs)
      s.key: _clampTo((pr?.adj[s.key] ?? 0) * k + (e.adj[s.key] ?? 0), s),
  };
}

double _s2l(double v) => v <= 0.04045 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
double _l2s(double v) => v <= 0.0031308 ? v * 12.92 : 1.055 * math.pow(v, 1 / 2.4) - 0.055;
double _c01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);
double _smoothstep(double a, double b, double x) {
  final t = _c01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/// Kanal başına ton eğrisi (photoEdits.toneLut).
Float64List toneLut(Map<String, double> p) {
  final lut = Float64List(256);
  final ev = math.pow(2, p['exposure']! / 100).toDouble();
  final gamma = math.pow(2, -p['brightness']! / 100).toDouble();
  final ck = math.pow(2, p['contrast']! / 100).toDouble();
  for (var i = 0; i < 256; i++) {
    var x = i / 255;
    if (p['exposure'] != 0) x = _c01(_l2s(math.min(1.0, _s2l(x) * ev)));
    if (p['brightness'] != 0) x = math.pow(x, gamma).toDouble();
    if (p['contrast'] != 0) x = _c01((x - 0.5) * ck + 0.5);
    if (p['highlights'] != 0) x = _c01(x + (p['highlights']! / 100) * 0.2 * _smoothstep(0.5, 1, x));
    if (p['shadows'] != 0) x = _c01(x + (p['shadows']! / 100) * 0.2 * (1 - _smoothstep(0, 0.5, x)));
    if (p['fade'] != 0) x = _c01(x * (1 - (p['fade']! / 100) * 0.25) + (p['fade']! / 100) * 0.12);
    lut[i] = x;
  }
  return lut;
}

/// Ton + renk + vinyet (photoEdits.renderPixels), yerinde. channels 3 ya da 4.
void renderPixels(Uint8List data, int w, int h, int channels, Map<String, double> p) {
  final lut = toneLut(p);
  final sat = 1 + p['saturation']! / 100;
  final warm = (p['warmth']! / 100) * 0.08;
  final tint = p['tint']! / 100;
  final vig = p['vignette']! / 100;
  final cx = (w - 1) / 2, cy = (h - 1) / 2;
  final rd = math.sqrt(cx * cx + cy * cy) == 0 ? 1.0 : math.sqrt(cx * cx + cy * cy);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final o = (y * w + x) * channels;
      var r = lut[data[o]], g = lut[data[o + 1]], b = lut[data[o + 2]];
      if (sat != 1) {
        final l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }
      if (warm != 0) {
        r += warm;
        b -= warm;
      }
      if (tint != 0) {
        g -= tint * 0.06;
        r += tint * 0.02;
        b += tint * 0.02;
      }
      if (vig > 0) {
        final dx = x - cx, dy = y - cy;
        final f = 1 - vig * 0.6 * _smoothstep(0.35, 1, math.sqrt(dx * dx + dy * dy) / rd);
        r *= f;
        g *= f;
        b *= f;
      }
      data[o] = (_c01(r) * 255).round();
      data[o + 1] = (_c01(g) * 255).round();
      data[o + 2] = (_c01(b) * 255).round();
    }
  }
}

// ---- Önizlemeye özel yaklaşık adımlar ----

// faceGlow.js ton eğrileri (elle mod, güç 0.6, kişi maskesi/cilt ekleri yok).
const _glowDL = [[0.0, 0.0], [5.0, 2.0], [15.0, 5.4], [25.0, 7.3], [35.0, 8.9], [45.0, 10.3], [55.0, 10.9], [65.0, 10.3], [75.0, 9.0], [85.0, 6.2], [95.0, 2.1], [100.0, 0.0]];
const _glowDA = [[0.0, 0.0], [5.0, 0.6], [15.0, 1.1], [25.0, 1.6], [35.0, 1.8], [45.0, 1.3], [55.0, 0.8], [65.0, 0.0], [100.0, 0.0]];
const _glowDB = [[0.0, 0.0], [5.0, 0.3], [15.0, 1.2], [25.0, 2.3], [35.0, 3.2], [45.0, 2.7], [55.0, 1.9], [65.0, 1.0], [80.0, 0.8], [100.0, 0.0]];
const double kGlowStrength = 0.6;

double _curve(List<List<double>> c, double x) {
  if (x <= c.first[0]) return c.first[1];
  for (var i = 1; i < c.length; i++) {
    if (x <= c[i][0]) {
      final t = (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + t * (c[i][1] - c[i - 1][1]);
    }
  }
  return c.last[1];
}

double _labF(double t) => t > 0.008856 ? math.pow(t, 1 / 3).toDouble() : 7.787 * t + 16 / 116;
double _labFi(double t) => t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787;

void applyGlowApprox(Uint8List data, int w, int h, int channels) {
  for (var i = 0; i < w * h; i++) {
    final o = i * channels;
    final r = _s2l(data[o] / 255), g = _s2l(data[o + 1] / 255), b = _s2l(data[o + 2] / 255);
    final x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    final y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    final z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    final fx = _labF(x), fy = _labF(y), fz = _labF(z);
    var L = 116 * fy - 16, A = 500 * (fx - fy), B = 200 * (fy - fz);
    L = math.min(100, L + kGlowStrength * _curve(_glowDL, L));
    A += kGlowStrength * _curve(_glowDA, L);
    B += kGlowStrength * _curve(_glowDB, L);
    final ny = (L + 16) / 116, nx = ny + A / 500, nz = ny - B / 200;
    final X = _labFi(nx) * 0.95047, Y = _labFi(ny), Z = _labFi(nz) * 1.08883;
    final rl = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    final gl = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    final bl = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    data[o] = (_c01(_l2s(_c01(rl))) * 255).round();
    data[o + 1] = (_c01(_l2s(_c01(gl))) * 255).round();
    data[o + 2] = (_c01(_l2s(_c01(bl))) * 255).round();
  }
}

void applySharpenApprox(Uint8List data, int w, int h, int channels, double amount) {
  if (amount <= 0) return;
  final k = amount / 100 * 1.2;
  final src = Uint8List.fromList(data);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      for (var c = 0; c < 3; c++) {
        final o = (y * w + x) * channels + c;
        var s = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            s += src[((y + dy) * w + (x + dx)) * channels + c];
          }
        }
        final v = src[o] + k * (src[o] - s / 9);
        data[o] = v < 0 ? 0 : (v > 255 ? 255 : v.round());
      }
    }
  }
}

// ---- FLAŞ (functions/flashEffect.js flashPixels ile BİREBİR; altın değerler iki tarafta) ----

const double _fAmb = 0.3, _fPeak = 1.38, _fFlat = 0.14, _fTeal = 0.035, _fWarm = 0.02;
const double _fContrast = 1.12, _fVignette = 0.6, _fGrain = 0.03, _fDust = 0.6;
const int _m32 = 0xFFFFFFFF;

int _imul(int a, int b) => (a * b) & _m32;

/// JS mulberry32 ile aynı dizi (32 bit işaretsiz aritmetik).
double Function() mulberry32(int seed) {
  var a = seed & _m32;
  return () {
    a = (a + 0x6d2b79f5) & _m32;
    var t = _imul(a ^ (a >> 15), 1 | a);
    t = ((t + _imul(t ^ (t >> 7), 61 | t)) & _m32) ^ t;
    return ((t ^ (t >> 14)) & _m32) / 4294967296;
  };
}

/// Flaş piksel işlemi, yerinde. f: ışık alanı, sh: gölge (0..1, w*h); k 0..1; gray → renk yok.
void applyFlash(Uint8List data, int w, int h, int channels, Float32List f, Float32List sh, double k, bool gray) {
  final colorK = gray ? 0.0 : k;
  final cx = (w - 1) / 2, cy = (h - 1) * 0.45;
  final rd = math.sqrt((w / 2) * (w / 2) + (h / 2) * (h / 2));
  final rnd = mulberry32(12345);
  const kn = 0.72;
  // beyaz tavanı yoğunlukla ölçeklenir (k=0 → kare aynen kalır)
  double soft(double v) => v <= kn ? v : v + k * (kn + (1 - kn) * (1 - math.exp(-(v - kn) / (1 - kn))) - v);
  final amb = 1 - (1 - _fAmb) * k, fl = (_fPeak - _fAmb) * k;
  final ck = 1 + (_fContrast - 1) * k;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x, o = i * channels;
      final ff = f[i] * (1 - sh[i]);
      var r = _s2l(data[o] / 255), g = _s2l(data[o + 1] / 255), b = _s2l(data[o + 2] / 255);
      final gm = 1 - _fFlat * k * f[i];
      if (gm != 1) {
        r = math.pow(r, gm).toDouble();
        g = math.pow(g, gm).toDouble();
        b = math.pow(b, gm).toDouble();
      }
      final gain = amb + fl * ff - 0.35 * k * sh[i] * amb;
      r = _l2s(soft(r * gain));
      g = _l2s(soft(g * gain));
      b = _l2s(soft(b * gain));
      final l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      final tl = _fTeal * colorK * (1 - _smoothstep(0.15, 0.75, l)) * (1 - 0.6 * ff);
      final wm = _fWarm * colorK * ff * _smoothstep(0.2, 0.7, l);
      r += -tl + wm;
      g += tl * 0.45;
      b += tl * 0.15 - wm;
      r = (r - 0.5) * ck + 0.5;
      g = (g - 0.5) * ck + 0.5;
      b = (b - 0.5) * ck + 0.5;
      final dx = x - cx, dy = y - cy;
      final vf = 1 - _fVignette * k * _smoothstep(0.25, 1.05, math.sqrt(dx * dx + dy * dy) / rd);
      r *= vf;
      g *= vf;
      b *= vf;
      final lc = _c01(0.2126 * r + 0.7152 * g + 0.0722 * b);
      final nz = (rnd() + rnd() + rnd() - 1.5) * _fGrain * k * 1.4 * (4 * lc * (1 - lc) + 0.25);
      data[o] = (_c01(r + nz) * 255).round();
      data[o + 1] = (_c01(g + nz) * 255).round();
      data[o + 2] = (_c01(b + nz) * 255).round();
    }
  }
  if (_fDust > 0 && k > 0) {
    final rr = mulberry32(0x9e3779b9);
    final sc = math.max(w, h) / 1536;
    void put(double px, double py, double a) {
      final ix = px.round(), iy = py.round();
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
      final o = (iy * w + ix) * channels;
      for (var c = 0; c < 3; c++) {
        data[o + c] = (data[o + c] + (225 - data[o + c]) * a).round();
      }
    }

    final nd = (25 * _fDust * k).round();
    for (var d = 0; d < nd; d++) {
      final x0 = rr() * w, y0 = rr() * h, rad = (0.6 + rr() * 1.4) * sc, a = 0.2 + rr() * 0.35;
      for (var yy = -3; yy <= 3; yy++) {
        for (var xx = -3; xx <= 3; xx++) {
          final dd = math.sqrt(xx * xx + yy * yy) / rad;
          if (dd <= 1) put(x0 + xx, y0 + yy, a * (1 - dd * dd));
        }
      }
    }
    final nh = (4 * _fDust * k).round();
    for (var hh = 0; hh < nh; hh++) {
      var x0 = rr() * w, y0 = rr() * h, ang = rr() * 6.283;
      final len = (15 + rr() * 40) * sc, a = 0.15 + rr() * 0.2;
      for (var s = 0; s < len; s++) {
        ang += (rr() - 0.5) * 0.25;
        x0 += math.cos(ang);
        y0 += math.sin(ang);
        put(x0, y0, a);
      }
    }
  }
}

/// Sunucudan gelen flaş alanları (opsFlashFields): RGBA, R = ışık, G = gölge.
class FlashFields {
  final Uint8List rgba;
  final int width;
  final int height;
  final bool gray;
  const FlashFields(this.rgba, this.width, this.height, this.gray);
}

/// Alanları önizleme boyutuna çift doğrusal büyütür.
(Float32List, Float32List) sampleFlashFields(FlashFields ff, int w, int h) {
  final f = Float32List(w * h), sh = Float32List(w * h);
  final sw = ff.width, shh = ff.height;
  for (var y = 0; y < h; y++) {
    final fy = math.min(shh - 1.0, math.max(0.0, (y + 0.5) * shh / h - 0.5));
    final y0 = fy.floor(), y1 = math.min(shh - 1, y0 + 1), ty = fy - y0;
    for (var x = 0; x < w; x++) {
      final fx = math.min(sw - 1.0, math.max(0.0, (x + 0.5) * sw / w - 0.5));
      final x0 = fx.floor(), x1 = math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (var c = 0; c < 2; c++) {
        double at(int xx, int yy) => ff.rgba[(yy * sw + xx) * 4 + c] / 255;
        final v = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
        (c == 0 ? f : sh)[y * w + x] = v;
      }
    }
  }
  return (f, sh);
}

/// Önizleme girdisi (isolate'e gider).
class PreviewJob {
  final Uint8List rgba;
  final int width;
  final int height;
  final Map<String, dynamic> edits;
  final FlashFields? flash;
  const PreviewJob(this.rgba, this.width, this.height, this.edits, [this.flash]);
}

/// Önizleme: ışıklı (yaklaşık) → flaş (sunucu alanlarıyla, aynı formül) → ton/renk/vinyet
/// (sunucuyla aynı) → keskinlik (yaklaşık). Flaş alanları henüz gelmediyse flaş atlanır.
Uint8List renderPreview(PreviewJob job) {
  final e = PhotoEdits.fromJson(job.edits);
  final out = Uint8List.fromList(job.rgba);
  if (e.glow) applyGlowApprox(out, job.width, job.height, 4);
  final ff = job.flash;
  if (e.flash > 0 && ff != null) {
    final (f, sh) = sampleFlashFields(ff, job.width, job.height);
    applyFlash(out, job.width, job.height, 4, f, sh, e.flash / 100, ff.gray);
  }
  final p = combineEdits(e);
  renderPixels(out, job.width, job.height, 4, p);
  applySharpenApprox(out, job.width, job.height, 4, p['sharpen']!);
  return out;
}
