// FOTO DÜZENLEYİCİ (2026-11-22, kullanıcı: "onay ekranında instagramdaki gibi farklı filtreler ...
// ışık açma kapama, sürükleme tarzında ton değiştiriciler ... fotoğrafların üstüne tıklayıp
// değiştirebilelim").
//
// Önizleme cihazda (photo_edits.dart, sunucuyla aynı formüller); "Kaydet" sunucuda asıl kareyi
// tam çözünürlükte üretir (opsApplyEdits). Teslim edilen kare kaydedilen hâldir.

import 'dart:async';
import 'dart:ui' as ui;

import 'package:cloud_functions/cloud_functions.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/constants/app_colors.dart';
import 'ops_providers.dart';
import 'photo_edits.dart';

class OpsPhotoEditResult {
  final String? url;
  final PhotoEdits edits;
  final String? originalUrl;
  const OpsPhotoEditResult(this.url, this.edits, [this.originalUrl]);
}

/// Kaydetme: düzenleme (null → asıl kare) sunucuda tam çözünürlükte uygulanır.
typedef PhotoEditApplyFn = Future<({String? url, Map<String, dynamic>? edits, String? originalUrl})> Function(
    Map<String, dynamic>? edits);

/// Flaş önizleme alanları (R ışık, G gölge PNG).
typedef PhotoFlashFieldsFn = Future<({Uint8List png, bool gray})> Function();

class OpsPhotoEditorScreen extends StatefulWidget {
  final String uid;
  final String jobId;
  final String ref;
  final String imageUrl;
  final PhotoEdits initial;

  /// Sunucuda kayıtlı düzenleme varken gösterilen görsel zaten düzenlenmiş hâldir; önizleme
  /// asıl kareden kurulmalı. originalUrl verilmezse imageUrl asıl kare sayılır.
  final String? originalUrl;

  /// KULLANICI DÜZENLEYİCİSİ (2026-11-22): verilirse kaydetme/flaş bu çağrılarla yapılır (teslim
  /// edilen kare, kullanıcının kendi yetkisiyle); verilmezse admin çağrıları (onay karesi).
  final PhotoEditApplyFn? applyFn;
  final PhotoFlashFieldsFn? flashFieldsFn;

  const OpsPhotoEditorScreen({
    super.key,
    required this.uid,
    required this.jobId,
    required this.ref,
    required this.imageUrl,
    required this.initial,
    this.originalUrl,
    this.applyFn,
    this.flashFieldsFn,
  });

  @override
  State<OpsPhotoEditorScreen> createState() => _OpsPhotoEditorScreenState();
}

class _OpsPhotoEditorScreenState extends State<OpsPhotoEditorScreen> {
  static const _previewHeight = 1000;
  static const _thumbHeight = 150;

  Uint8List? _base;
  int _w = 0, _h = 0;
  ui.Image? _orig;
  ui.Image? _preview;
  final Map<String, ui.Image> _thumbs = {};
  (Uint8List, int, int)? _thumbBase;

  // FLAŞ: ışık/gölge alanları sunucudan bir kez gelir (opsFlashFields); önizleme onlarla cihazda.
  FlashFields? _flash;
  // FLAŞ BEKLEME (2026-11-23, kullanıcı: "flaşa basınca çok bekletiyor; ekranın ortasında loader çıksın, efekt
  // bitene kadar kalsın"): flaş açıldığı andan, alanlarla çizilmiş önizleme ekrana gelene kadar true.
  bool _flashApplying = false;
  Future<bool>? _flashFuture;
  String _flashError = '';

  late PhotoEdits _edits = widget.initial;
  String _tab = 'filtre';
  String _adjKey = kAdjSpecs.first.key;
  bool _rendering = false, _pending = false, _saving = false, _showOriginal = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<(Uint8List, int, int, ui.Image)> _decode(Uint8List bytes, int height) async {
    final codec = await ui.instantiateImageCodec(bytes, targetHeight: height);
    final img = (await codec.getNextFrame()).image;
    final bd = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
    return (bd!.buffer.asUint8List(), img.width, img.height, img);
  }

  Future<ui.Image> _toImage(Uint8List rgba, int w, int h) {
    final c = Completer<ui.Image>();
    ui.decodeImageFromPixels(rgba, w, h, ui.PixelFormat.rgba8888, c.complete);
    return c.future;
  }

  Future<void> _load() async {
    try {
      final res = await Dio().get<List<int>>(widget.originalUrl ?? widget.imageUrl,
          options: Options(responseType: ResponseType.bytes));
      final bytes = Uint8List.fromList(res.data!);
      final (rgba, w, h, img) = await _decode(bytes, _previewHeight);
      if (!mounted) return;
      setState(() {
        _base = rgba;
        _w = w;
        _h = h;
        _orig = img;
      });
      _schedule();
      // Flaş alanları açılışta arka planda hazırlanır: kullanıcı flaşa bastığında çoğu zaman hazırdır
      // (sunucu da karede bir kez hesaplayıp önbelleğe yazar). Kayıtlı düzenlemede flaş açıksa bekleme gösterilir.
      if (_edits.flash > 0) {
        setState(() => _flashApplying = true);
        _ensureFlash();
      } else {
        _loadFlash();
      }
      // Hazır filtre küçük resimleri (sırayla, arka planda).
      final (trgba, tw, th, timg) = await _decode(bytes, _thumbHeight);
      if (!mounted) return;
      _thumbBase = (trgba, tw, th);
      setState(() => _thumbs['_'] = timg);
      if (_flash != null) _renderFlashThumb();
      for (final p in kPresets) {
        final out = await compute(renderPreview, PreviewJob(trgba, tw, th, PhotoEdits(preset: p.key).toJson()));
        final im = await _toImage(out, tw, th);
        if (!mounted) return;
        setState(() => _thumbs[p.key] = im);
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Görsel yüklenemedi: $e');
    }
  }

  /// Flaş alanlarını sunucudan alır (karede bir kez; sunucu da önbelleğe yazar). Aynı anda gelen çağrılar
  /// tek isteği bekler. Hata sessizdir: kullanıcıya yalnız flaşı kendisi açtıysa söylenir (_ensureFlash).
  Future<bool> _loadFlash() {
    if (_flash != null) return Future.value(true);
    return _flashFuture ??= _fetchFlash().whenComplete(() => _flashFuture = null);
  }

  Future<bool> _fetchFlash() async {
    try {
      final r = widget.flashFieldsFn != null
          ? await widget.flashFieldsFn!()
          : await opsFlashFields(uid: widget.uid, jobId: widget.jobId, ref: widget.ref);
      final codec = await ui.instantiateImageCodec(r.png);
      final img = (await codec.getNextFrame()).image;
      final bd = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (!mounted) return false;
      _flash = FlashFields(bd!.buffer.asUint8List(), img.width, img.height, r.gray);
      _schedule();
      _renderFlashThumb();
      return true;
    } on FirebaseFunctionsException catch (e) {
      _flashError = e.message ?? e.code;
      return false;
    } catch (e) {
      _flashError = '$e';
      return false;
    }
  }

  /// Kullanıcı flaşı açtı: alanlar gelmezse uyarı verir ve flaşı kapatır.
  Future<void> _ensureFlash() async {
    final ok = await _loadFlash();
    if (ok || !mounted) return;
    _snack('Flaş hazırlanamadı: $_flashError');
    setState(() => _flashApplying = false);
    _update(_edits.copyWith(flash: 0));
  }

  Future<void> _renderFlashThumb() async {
    final tb = _thumbBase, ff = _flash;
    if (tb == null || ff == null) return;
    final (trgba, tw, th) = tb;
    final out = await compute(renderPreview, PreviewJob(trgba, tw, th, const PhotoEdits(flash: 100).toJson(), ff));
    final im = await _toImage(out, tw, th);
    if (mounted) setState(() => _thumbs['flash'] = im);
  }

  // Kaydırarak filtre değiştirme: sıra Orijinal → hazır filtreler (flaş ayrı açılıp kapanır,
  // renk filtresiyle birlikte kullanılabildiği için kaydırma sırasında yok).
  String? _swipeLabel;
  bool _swipeLabelVisible = false;
  Timer? _swipeTimer;
  final ScrollController _filterScroll = ScrollController();

  void _swipePreset(int dir) {
    final keys = <String?>[null, ...kPresets.map((p) => p.key)];
    final cur = keys.indexOf(presetByKey(_edits.preset)?.key);
    final next = (cur + dir).clamp(0, keys.length - 1);
    if (next == cur) return;
    final key = keys[next];
    _update(key == null ? _edits.copyWith(clearPreset: true) : _edits.copyWith(preset: key, intensity: 100));
    setState(() {
      _tab = 'filtre';
      _swipeLabel = key == null ? 'Orijinal' : presetByKey(key)!.label;
      _swipeLabelVisible = true;
    });
    _swipeTimer?.cancel();
    _swipeTimer = Timer(const Duration(milliseconds: 900), () {
      if (mounted) setState(() => _swipeLabelVisible = false);
    });
    // alttaki şeridi seçilen filtreye kaydır (Orijinal + Flaş + önceki filtreler)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_filterScroll.hasClients) return;
      final tileW = (_compactTiles ? 56.0 : 84.0) * 0.8 + 8;
      final target = (next + 1) * tileW - 40;
      _filterScroll.animateTo(
        target.clamp(0.0, _filterScroll.position.maxScrollExtent),
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  void dispose() {
    _swipeTimer?.cancel();
    _filterScroll.dispose();
    super.dispose();
  }

  void _toggleFlash() {
    if (_edits.flash > 0) {
      setState(() => _flashApplying = false);
      _update(_edits.copyWith(flash: 0));
    } else {
      setState(() => _flashApplying = true);
      _update(_edits.copyWith(flash: 100));
      _ensureFlash();
    }
  }

  /// Önizlemeyi yeniden üretir; çalışırken gelen değişiklik bitince tek seferde işlenir.
  Future<void> _schedule() async {
    if (_base == null) return;
    if (_rendering) {
      _pending = true;
      return;
    }
    _rendering = true;
    try {
      final edits = _edits;
      final ff = _flash;
      final out = await compute(renderPreview, PreviewJob(_base!, _w, _h, edits.toJson(), ff));
      final img = await _toImage(out, _w, _h);
      if (!mounted) return;
      setState(() {
        _preview = img;
        // Bekleme göstergesi ancak flaş alanlarıyla çizilmiş önizleme ekrana gelince kalkar.
        // (Kapatma ve hata yolu bayrağı kendisi indirir; flaşsız eski bir çizim onu erken kaldırmamalı.)
        if (_flashApplying && edits.flash > 0 && ff != null) _flashApplying = false;
      });
    } finally {
      _rendering = false;
      if (_pending && mounted) {
        _pending = false;
        _schedule();
      }
    }
  }

  void _update(PhotoEdits e) {
    setState(() => _edits = e);
    _schedule();
  }

  Future<void> _save({bool revert = false}) async {
    if (_saving) return;
    setState(() => _saving = true);
    final edits = revert ? PhotoEdits.empty : _edits;
    try {
      final json = edits.isEmpty ? null : edits.toJson();
      final r = widget.applyFn != null
          ? await widget.applyFn!(json)
          : await opsApplyEdits(uid: widget.uid, jobId: widget.jobId, ref: widget.ref, edits: json);
      if (!mounted) return;
      Navigator.of(context).pop(OpsPhotoEditResult(r.url, PhotoEdits.fromJson(r.edits), r.originalUrl));
    } on FirebaseFunctionsException catch (e) {
      _snack('Kaydedilemedi: ${e.message ?? e.code}');
    } catch (e) {
      _snack('Kaydedilemedi: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg), backgroundColor: AppColors.error));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        title: const Text('Düzenle'),
        actions: [
          TextButton(
            onPressed: _saving ? null : () => _save(revert: true),
            child: const Text('Orijinale dön', style: TextStyle(color: AppColors.textSecondary)),
          ),
          TextButton(
            onPressed: _saving || _base == null ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
                : const Text('Kaydet', style: TextStyle(color: AppColors.gold, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(child: _imageArea()),
            _toolbar(),
            const SizedBox(height: 4),
            _tabBar(),
            SizedBox(
                height: _tab == 'filtre' && presetByKey(_edits.preset) != null && _edits.flash > 0 ? 196 : 150,
                child: _tab == 'filtre' ? _filterPanel() : _adjustPanel()),
          ],
        ),
      ),
    );
  }

  Widget _imageArea() {
    if (_error != null) {
      return Center(child: Text(_error!, style: const TextStyle(color: AppColors.error)));
    }
    final img = _showOriginal ? _orig : (_preview ?? _orig);
    if (img == null) return const Center(child: CircularProgressIndicator(color: AppColors.gold));
    return GestureDetector(
      onLongPressStart: (_) => setState(() => _showOriginal = true),
      onLongPressEnd: (_) => setState(() => _showOriginal = false),
      // Instagram gibi: fotoğrafı sola kaydır → sonraki filtre, sağa → önceki.
      onHorizontalDragEnd: (d) {
        final v = d.primaryVelocity ?? 0;
        if (v.abs() < 150) return;
        _swipePreset(v < 0 ? 1 : -1);
      },
      child: Stack(
        fit: StackFit.expand,
        children: [
          RawImage(image: img, fit: BoxFit.contain),
          if (_swipeLabel != null)
            Center(
              child: IgnorePointer(
                child: AnimatedOpacity(
                  opacity: _swipeLabelVisible ? 1 : 0,
                  duration: const Duration(milliseconds: 250),
                  child: Text(
                    _swipeLabel!,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 28,
                      fontWeight: FontWeight.w700,
                      shadows: [Shadow(blurRadius: 8, color: Colors.black54)],
                    ),
                  ),
                ),
              ),
            ),
          if (_flashApplying)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black.withValues(alpha: 0.35),
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.72),
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: const Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 34,
                          height: 34,
                          child: CircularProgressIndicator(strokeWidth: 3, color: AppColors.gold),
                        ),
                        SizedBox(height: 12),
                        Text('Flaş patlıyor…',
                            style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 12,
            top: 10,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(6)),
              child: Text(_showOriginal ? 'ÖNCE' : 'Basılı tut: önceki hâl',
                  style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _toolbar() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            FilterChip(
              avatar: Icon(_edits.glow ? Icons.wb_sunny_rounded : Icons.wb_sunny_outlined,
                  size: 18, color: _edits.glow ? AppColors.textOnGold : AppColors.gold),
              label: const Text('Işıklı'),
              selected: _edits.glow,
              showCheckmark: false,
              selectedColor: AppColors.gold,
              labelStyle: TextStyle(color: _edits.glow ? AppColors.textOnGold : AppColors.textPrimary),
              onSelected: (v) => _update(_edits.copyWith(glow: v)),
            ),
            const SizedBox(width: 8),
            const Expanded(
              child: Text('Önizleme küçük boyutta; kaydedince tam çözünürlükte uygulanır',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 11)),
            ),
            TextButton(
              onPressed: _edits.isEmpty ? null : () => _update(PhotoEdits.empty),
              child: const Text('Sıfırla'),
            ),
          ],
        ),
      );

  Widget _tabBar() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            for (final (k, label) in const [('filtre', 'Filtreler'), ('ayar', 'Ayarlar')])
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text(label),
                  selected: _tab == k,
                  selectedColor: AppColors.goldSurface,
                  labelStyle: TextStyle(
                      color: _tab == k ? AppColors.gold : AppColors.textSecondary, fontWeight: FontWeight.w600),
                  onSelected: (_) => setState(() => _tab = k),
                ),
              ),
          ],
        ),
      );

  bool get _compactTiles => presetByKey(_edits.preset) != null || _edits.flash > 0;

  Widget _filterPanel() {
    final pr = presetByKey(_edits.preset);
    return Column(
      children: [
        SizedBox(
          height: _compactTiles ? 96 : 140,
          child: ListView(
            controller: _filterScroll,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            children: [
              _presetTile(null, 'Orijinal', _thumbs['_']),
              _flashTile(),
              for (final p in kPresets) _presetTile(p.key, p.label, _thumbs[p.key]),
            ],
          ),
        ),
        if (_edits.flash > 0)
          _slider(
            label: 'Flaş',
            value: _edits.flash.toDouble(),
            min: 1,
            max: 100,
            onChanged: (v) => _update(_edits.copyWith(flash: v.round())),
          ),
        if (pr != null)
          _slider(
            label: '${pr.label} yoğunluğu',
            value: _edits.intensity.toDouble(),
            min: 0,
            max: 100,
            onChanged: (v) => _update(_edits.copyWith(intensity: v.round())),
          ),
      ],
    );
  }

  /// Flaş karesi: renk filtrelerinden bağımsız açılıp kapanır (ikisi birlikte kullanılabilir).
  Widget _flashTile() {
    final on = _edits.flash > 0;
    return _tile(
      label: 'Flaş',
      selected: on,
      thumb: _thumbs['flash'] ?? _thumbs['_'],
      onTap: _toggleFlash,
      overlay: _flashApplying
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
          : Icon(on ? Icons.flash_on_rounded : Icons.flash_off_rounded,
              size: 20, color: on ? AppColors.gold : Colors.white70),
    );
  }

  Widget _presetTile(String? key, String label, ui.Image? thumb) {
    final selected = _edits.preset == key;
    return _tile(
      label: label,
      selected: selected,
      thumb: thumb,
      onTap: () => _update(key == null
          ? _edits.copyWith(clearPreset: true)
          : _edits.copyWith(preset: key, intensity: selected ? _edits.intensity : 100)),
    );
  }

  Widget _tile({
    required String label,
    required bool selected,
    required ui.Image? thumb,
    required VoidCallback onTap,
    Widget? overlay,
  }) {
    final size = _compactTiles ? 56.0 : 84.0;
    return GestureDetector(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.only(right: 8),
        child: Column(
          children: [
            Container(
              width: size * 0.8,
              height: size,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: selected ? AppColors.gold : AppColors.borderSubtle, width: selected ? 2 : 1),
              ),
              clipBehavior: Clip.antiAlias,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  thumb == null
                      ? const ColoredBox(color: AppColors.surfaceElevated)
                      : RawImage(image: thumb, fit: BoxFit.cover),
                  if (overlay != null)
                    Center(
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.45), shape: BoxShape.circle),
                        child: overlay,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 3),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: selected ? AppColors.gold : AppColors.textSecondary,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  Widget _adjustPanel() {
    final spec = kAdjSpecs.firstWhere((s) => s.key == _adjKey);
    final value = (_edits.adj[spec.key] ?? 0).toDouble();
    return Column(
      children: [
        SizedBox(
          height: 52,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            children: [
              for (final s in kAdjSpecs)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    label: Text((_edits.adj[s.key] ?? 0) == 0
                        ? s.label
                        : '${s.label} ${_signed(_edits.adj[s.key]!)}'),
                    selected: _adjKey == s.key,
                    selectedColor: AppColors.goldSurface,
                    labelStyle: TextStyle(
                      fontSize: 12,
                      color: _adjKey == s.key
                          ? AppColors.gold
                          : ((_edits.adj[s.key] ?? 0) != 0 ? AppColors.goldLight : AppColors.textSecondary),
                    ),
                    onSelected: (_) => setState(() => _adjKey = s.key),
                  ),
                ),
            ],
          ),
        ),
        _slider(
          label: spec.label,
          value: value,
          min: spec.min.toDouble(),
          max: spec.max.toDouble(),
          onChanged: (v) => _update(_edits.withAdj(spec.key, v.round())),
          onReset: value == 0 ? null : () => _update(_edits.withAdj(spec.key, 0)),
        ),
      ],
    );
  }

  String _signed(int v) => v > 0 ? '+$v' : '$v';

  Widget _slider({
    required String label,
    required double value,
    required double min,
    required double max,
    required ValueChanged<double> onChanged,
    VoidCallback? onReset,
  }) =>
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            SizedBox(
              width: 110,
              child: Text('$label  ${_signed(value.round())}',
                  style: const TextStyle(color: AppColors.textPrimary, fontSize: 12)),
            ),
            Expanded(
              child: Slider(
                value: value.clamp(min, max),
                min: min,
                max: max,
                activeColor: AppColors.gold,
                inactiveColor: AppColors.surfaceHighest,
                onChanged: onChanged,
              ),
            ),
            IconButton(
              tooltip: 'Sıfırla',
              icon: const Icon(Icons.restart_alt_rounded, size: 20),
              color: AppColors.textMuted,
              onPressed: onReset,
            ),
          ],
        ),
      );
}
