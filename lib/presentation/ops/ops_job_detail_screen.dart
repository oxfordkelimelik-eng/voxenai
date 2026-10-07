import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import '../../core/constants/app_colors.dart';
import 'ops_gate.dart';
import 'ops_models.dart';
import 'ops_providers.dart';

/// Onay ızgarasındaki bir kare: gösterim URL'i, gs:// kimliği, ret kapısı
/// (reddedildiyse) ve üretildiği şablon (biliniyorsa).
typedef _Frame = ({String url, String? ref, String? gate, OpsTemplate? template});

class OpsJobDetailScreen extends StatelessWidget {
  final String uid;
  final String jobId;
  const OpsJobDetailScreen({required this.uid, required this.jobId, super.key});

  @override
  Widget build(BuildContext context) {
    return OpsGate(
      builder: (context) => _JobDetailBody(uid: uid, jobId: jobId),
    );
  }
}

class _JobDetailBody extends ConsumerWidget {
  final String uid;
  final String jobId;
  const _JobDetailBody({required this.uid, required this.jobId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = (uid: uid, jobId: jobId);
    final detail = ref.watch(opsJobDetailProvider(key));

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded,
              size: 18, color: AppColors.textSecondary),
          onPressed: () => context.pop(),
        ),
        title: Text(jobId.substring(0, jobId.length > 8 ? 8 : jobId.length),
            style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textPrimary)),
      ),
      body: detail.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: AppColors.gold),
        ),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('Yüklenemedi: $e',
                style: const TextStyle(color: AppColors.textSecondary)),
          ),
        ),
        data: (data) => _DetailContent(data: data),
      ),
    );
  }
}

class _DetailContent extends ConsumerStatefulWidget {
  final OpsJobDetail data;
  const _DetailContent({required this.data});

  @override
  ConsumerState<_DetailContent> createState() => _DetailContentState();
}

class _DetailContentState extends ConsumerState<_DetailContent> {
  /// Seçili karelerin HAM gs:// adresleri (imzalı URL süreli, kimlik olamaz).
  final Set<String> _selected = {};
  bool _busy = false;

  OpsJobDetail get data => widget.data;

  /// Üretilen tüm kareler: (gösterim URL'i, gs:// adresi) çiftleri.
  /// photoRefs ile photoUrls aynı sıradadır (sunucu öyle döndürüyor); eski
  /// yanıtlarda photoRefs boş gelebilir, o zaman seçim yapılamaz ve kare
  /// yalnızca görüntülenir.
  ///
  /// Reddedilen kareler de sona eklenir (2026-10-07): kalite kapısı
  /// yanılabildiği için admin onları da teslim edebilir. `gate` doluysa kare
  /// reddedilmiştir ve üzerinde kapı adı gösterilir.
  ///
  /// Her karenin üretildiği şablon da taşınır (2026-10-07) — köşede küçük
  /// önizleme, tam ekranda çıktı/şablon geçişi.
  List<_Frame> get _staged {
    final out = <_Frame>[];
    for (final r in data.results.values) {
      for (var i = 0; i < r.photoUrls.length; i++) {
        final ref = i < r.photoRefs.length ? r.photoRefs[i] : null;
        out.add((url: r.photoUrls[i], ref: ref, gate: null, template: data.templateFor(ref)));
      }
    }
    for (final f in data.rejectedFrames) {
      if (f.url == null) continue;
      out.add((
        url: f.url!,
        ref: f.ref,
        gate: f.gate ?? 'reddedildi',
        template: data.templateFor(f.ref),
      ));
    }
    return out;
  }

  void _toggle(String ref) {
    setState(() {
      if (_selected.contains(ref)) {
        _selected.remove(ref);
      } else if (_selected.length < data.photoCount) {
        _selected.add(ref);
      }
    });
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? AppColors.error : null,
    ));
  }

  Future<void> _approve() async {
    if (_selected.isEmpty || _busy) return;
    setState(() => _busy = true);
    try {
      final n = await opsApprovePhotos(
        uid: data.uid,
        jobId: data.jobId,
        selectedRefs: _selected.toList(),
      );
      _snack('$n fotoğraf teslim edildi, kullanıcıya bildirim gönderildi.');
      _selected.clear();
      ref.invalidate(opsJobDetailProvider);
    } catch (e) {
      _snack('Onay başarısız: $e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Dışarıdan fotoğraf ekleme: dosya doğrudan Storage'a yüklenir, sonra
  /// sunucuya ONAY HAVUZUNA (staging) eklenmesi söylenir. Dosya adı
  /// "manual_" ile başlamak ZORUNDA — storage.rules yalnızca bu ön eke
  /// yazma izni veriyor.
  ///
  /// STAGING'E YÜKLENİR, dating_results'a DEĞİL (2026-09-23) — üretilen
  /// karelerle AYNI seçim ızgarasında görünmesi ve normal onay akışından
  /// (Teslim Et) geçmesi için. Doğrudan teslim listesine yazmak, seçim
  /// adımını atlayıp yüklemeyi anında kullanıcıya gösterirdi.
  Future<void> _upload() async {
    if (_busy) return;
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      imageQuality: 92,
    );
    if (picked == null) return;
    setState(() => _busy = true);
    try {
      final name = 'manual_${DateTime.now().millisecondsSinceEpoch}.jpg';
      final path = 'dating_staging/${data.uid}/${data.jobId}/$name';
      await FirebaseStorage.instance.ref(path).putFile(
            File(picked.path),
            SettableMetadata(contentType: 'image/jpeg'),
          );
      await opsAttachUploadedPhoto(
        uid: data.uid,
        jobId: data.jobId,
        path: path,
      );
      _snack('Fotoğraf yüklendi — onay ızgarasında seçilebilir.');
      ref.invalidate(opsJobDetailProvider);
    } catch (e) {
      _snack('Yükleme başarısız: $e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Teslim edilmiş kareler: yeni işlerde approvedPhotos, ONAY AKIŞINDAN
    // ÖNCEKİ işlerde results.photoUrls'ün kendisi (o işlerde onay kavramı
    // yoktu ve kareler zaten kullanıcıdaydı).
    final delivered = data.approvedPhotos.isNotEmpty
        ? data.approvedPhotos
        : (data.approvedAtMillis == null && !data.awaitingApproval
            ? data.results.values.expand((r) => r.photoUrls).toList()
            : const <String>[]);
    // Teslim edilenlerin şablonları — aynı sırayla (approvedRefs ya da eski
    // işlerde photoRefs).
    final deliveredRefs = data.approvedPhotos.isNotEmpty
        ? data.approvedRefs
        : data.results.values.expand((r) => r.photoRefs).toList();
    final deliveredTemplates = [
      for (var i = 0; i < delivered.length; i++)
        data.templateFor(i < deliveredRefs.length ? deliveredRefs[i] : null),
    ];
    final staged = _staged;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _infoCard(),
        if (data.awaitingApproval || staged.isNotEmpty) ...[
          const SizedBox(height: 20),
          _sectionTitle(
            'ONAY — ${_selected.length}/${data.photoCount} SEÇİLDİ '
            '(${staged.length - data.rejectedFrames.length} üretildi'
            '${data.rejectedFrames.isEmpty ? '' : ' + ${data.rejectedFrames.length} reddedilen'})',
          ),
          _approvalBar(),
          const SizedBox(height: 10),
          _selectableGrid(staged),
        ],
        const SizedBox(height: 24),
        _sectionTitle('TESLİM EDİLEN FOTOĞRAFLAR (${delivered.length})'),
        if (delivered.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Yok', style: TextStyle(color: AppColors.textMuted)),
          )
        else
          _photoGrid(delivered, deliveredTemplates),
        const SizedBox(height: 24),
        _sectionTitle('REDDEDİLEN KARELER (${data.rejectedFrames.length})'),
        if (data.rejectedFrames.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Yok', style: TextStyle(color: AppColors.textMuted)),
          )
        else
          _rejectedGrid(data.rejectedFrames),
      ],
    );
  }

  Widget _approvalBar() => Row(
        children: [
          Expanded(
            child: ElevatedButton.icon(
              onPressed: _busy || _selected.isEmpty ? null : _approve,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: AppColors.textOnGold),
                    )
                  : const Icon(Icons.check_rounded, size: 18),
              label: Text('Teslim Et (${_selected.length})'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.gold,
                foregroundColor: AppColors.textOnGold,
                disabledBackgroundColor: AppColors.surfaceElevated,
              ),
            ),
          ),
          const SizedBox(width: 8),
          // EXPANDED OLMADAN "sonsuz genişlik" isteyen tema çarpışması
          // (2026-09-24 gerçek olay): app_theme.dart'taki hem
          // ElevatedButtonThemeData hem OutlinedButtonThemeData
          // `minimumSize: Size(double.infinity, 56)` veriyor (büyük tek
          // CTA butonları için). Bu satır Expanded'sız bırakılınca Row,
          // sonsuz genişlik isteyen bir çocukla layout hesaplayamıyor —
          // release build'de kırmızı hata ekranı yerine SESSİZCE boş alan
          // bırakıyor (admin panelinde "Teslim Et"/"Yükle" hiç görünmüyordu).
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _busy ? null : _upload,
              icon: const Icon(Icons.upload_rounded, size: 18),
              label: const Text('Yükle'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.gold,
                side: const BorderSide(color: AppColors.borderGold),
              ),
            ),
          ),
        ],
      );

  /// Seçilebilir kare ızgarası. Dokunmak SEÇER; büyütmek için uzun bas —
  /// onay ekranında asıl eylem seçim olduğu için kısa dokunuş ona ayrıldı.
  Widget _selectableGrid(List<_Frame> items) =>
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 6,
          mainAxisSpacing: 6,
        ),
        itemCount: items.length,
        itemBuilder: (context, i) {
          final item = items[i];
          final ref = item.ref;
          final isSelected = ref != null && _selected.contains(ref);
          final urls = items.map((e) => e.url).toList();
          final templates = items.map((e) => e.template).toList();
          return GestureDetector(
            onTap: ref == null ? null : () => _toggle(ref),
            onLongPress: () =>
                _openFullscreenViewer(context, urls, i, templates: templates),
            child: Stack(
              fit: StackFit.expand,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: CachedNetworkImage(
                    imageUrl: item.url,
                    fit: BoxFit.cover,
                    placeholder: (c, u) =>
                        const ColoredBox(color: AppColors.surfaceElevated),
                    errorWidget: (c, u, e) => const ColoredBox(
                      color: AppColors.surfaceElevated,
                      child: Icon(Icons.broken_image_outlined,
                          color: AppColors.textMuted),
                    ),
                  ),
                ),
                if (item.template != null)
                  Positioned(top: 4, left: 4, child: _templateThumb(item.template!)),
                if (item.gate != null)
                  Positioned(
                    left: 4,
                    right: 30,
                    bottom: 4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 5, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.error.withValues(alpha: 0.85),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        'RED · ${item.gate}',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 9,
                          fontWeight: FontWeight.w800,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                if (isSelected)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.gold, width: 3),
                      color: AppColors.gold.withValues(alpha: 0.18),
                    ),
                  ),
                Positioned(
                  top: 4,
                  right: 4,
                  child: Container(
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: isSelected
                          ? AppColors.gold
                          : Colors.black.withValues(alpha: 0.45),
                      border: Border.all(color: Colors.white70, width: 1),
                    ),
                    child: isSelected
                        ? const Icon(Icons.check_rounded,
                            size: 15, color: AppColors.textOnGold)
                        : null,
                  ),
                ),
              ],
            ),
          );
        },
      );

  Widget _infoCard() => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (data.email != null) _row('Kullanıcı', data.email!),
            _row('Durum', opsStatusLabel(data.status)),
            _row('Model', data.model ?? '?'),
            _row('Mod', data.photoMode ?? '?'),
            _row('Ücretsiz Deneme', data.usedFreeTier ? 'Evet' : 'Hayır'),
            _row('Ücret (birim)', '${data.packUnitsCharged}'),
            if (data.errorMessage != null)
              _row('Hata', data.errorMessage!, valueColor: AppColors.error),
          ],
        ),
      );

  Widget _row(String label, String value, {Color? valueColor}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 13)),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                      color: valueColor ?? AppColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      );

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text,
            style: const TextStyle(
                color: AppColors.textMuted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6)),
      );

  Widget _photoGrid(List<String> urls, List<OpsTemplate?> templates) =>
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 6,
          mainAxisSpacing: 6,
        ),
        itemCount: urls.length,
        itemBuilder: (context, i) => GestureDetector(
          onTap: () =>
              _openFullscreenViewer(context, urls, i, templates: templates),
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: CachedNetworkImage(
                  imageUrl: urls[i],
                  fit: BoxFit.cover,
                  placeholder: (c, u) =>
                      const ColoredBox(color: AppColors.surfaceElevated),
                  errorWidget: (c, u, e) => const ColoredBox(
                    color: AppColors.surfaceElevated,
                    child: Icon(Icons.broken_image_outlined,
                        color: AppColors.textMuted),
                  ),
                ),
              ),
              if (i < templates.length && templates[i] != null)
                Positioned(top: 4, left: 4, child: _templateThumb(templates[i]!)),
            ],
          ),
        ),
      );

  /// Karenin köşesindeki küçük şablon önizlemesi. Kesin değilse (eski iş,
  /// yalnızca ilk seçilen şablon biliniyor) kenarlığı soluk ve üstünde "?"
  /// var.
  Widget _templateThumb(OpsTemplate t) => Container(
        width: 30,
        height: 40,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          border: Border.all(
            color: t.exact ? Colors.white : Colors.white38,
            width: 1.5,
          ),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: Stack(
            fit: StackFit.expand,
            children: [
              CachedNetworkImage(
                imageUrl: t.url,
                fit: BoxFit.cover,
                placeholder: (c, u) =>
                    const ColoredBox(color: AppColors.surfaceElevated),
                errorWidget: (c, u, e) =>
                    const ColoredBox(color: AppColors.surfaceElevated),
              ),
              if (!t.exact)
                const Center(
                  child: Text('?',
                      style: TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w900,
                          shadows: [Shadow(blurRadius: 3)])),
                ),
            ],
          ),
        ),
      );

  /// Tam ekran, pinch-to-zoom destekli fotoğraf görüntüleyici — birden fazla
  /// fotoğraf arasında kaydırarak geçilebilir (PageView). [templates] aynı
  /// sırada verilirse her sayfada çıktı/şablon geçişi açılır.
  void _openFullscreenViewer(BuildContext context, List<String> urls, int initialIndex,
      {List<OpsTemplate?> templates = const []}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (context) => _FullscreenPhotoViewer(
        urls: urls,
        initialIndex: initialIndex,
        templates: templates,
      ),
      fullscreenDialog: true,
    ));
  }

  Widget _rejectedGrid(List<OpsRejectedFrame> frames) => GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          crossAxisSpacing: 6,
          mainAxisSpacing: 6,
          childAspectRatio: 0.78,
        ),
        itemCount: frames.length,
        itemBuilder: (context, i) {
          final f = frames[i];
          return GestureDetector(
            onTap: () => _showRejectedFrameDetail(context, f),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: f.url != null
                        ? CachedNetworkImage(
                            imageUrl: f.url!,
                            fit: BoxFit.cover,
                            placeholder: (c, u) => const ColoredBox(
                                color: AppColors.surfaceElevated),
                            errorWidget: (c, u, e) => const ColoredBox(
                              color: AppColors.surfaceElevated,
                              child: Icon(Icons.broken_image_outlined,
                                  color: AppColors.textMuted),
                            ),
                          )
                        : const ColoredBox(color: AppColors.surfaceElevated),
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  f.gate ?? '?',
                  style: const TextStyle(
                      color: AppColors.error,
                      fontSize: 10,
                      fontWeight: FontWeight.w700),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          );
        },
      );

  Widget _labeledImage(String url, String label) => Column(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: CachedNetworkImage(
              imageUrl: url,
              height: 220,
              fit: BoxFit.contain,
              errorWidget: (c, u, e) => const SizedBox(
                height: 120,
                child: Center(
                  child: Icon(Icons.broken_image_outlined,
                      color: AppColors.textMuted),
                ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(label,
              style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 11,
                  fontWeight: FontWeight.w700)),
        ],
      );

  void _showRejectedFrameDetail(BuildContext context, OpsRejectedFrame f) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (f.url != null)
              GestureDetector(
                onTap: () => _openFullscreenViewer(context, [f.url!], 0,
                    templates: [data.templateFor(f.ref)]),
                child: Row(
                  children: [
                    Expanded(child: _labeledImage(f.url!, 'Çıktı')),
                    if (data.templateFor(f.ref) != null) ...[
                      const SizedBox(width: 8),
                      Expanded(
                        child: _labeledImage(
                          data.templateFor(f.ref)!.url,
                          data.templateFor(f.ref)!.exact
                              ? 'Şablon'
                              : 'Şablon (tahmini)',
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            const SizedBox(height: 14),
            _row('Kapı (gate)', f.gate ?? '?', valueColor: AppColors.error),
            if (f.reason != null) _row('Gerekçe', f.reason!),
            if (f.detail != null) _row('Detay', f.detail!),
            if (f.chunkIdx != null) _row('Chunk', '${f.chunkIdx}'),
            if (f.attempt != null) _row('Deneme', '${f.attempt}'),
          ],
        ),
      ),
    );
  }
}

/// Tam ekran fotoğraf görüntüleyici — InteractiveViewer ile pinch-to-zoom,
/// PageView ile fotoğraflar arası kaydırma. Ekstra paket gerektirmez.
///
/// ŞABLON GEÇİŞİ (2026-10-07): kare bir şablondan üretildiyse app bar'daki
/// düğme o sayfayı çıktı ile şablon arasında çevirir. Yan yana değil üst
/// üste çevirmek bilinçli: kafa boyutu/konumu farkı ancak aynı yerde gidip
/// gelerek göze çarpar.
class _FullscreenPhotoViewer extends StatefulWidget {
  final List<String> urls;
  final int initialIndex;
  final List<OpsTemplate?> templates;
  const _FullscreenPhotoViewer({
    required this.urls,
    required this.initialIndex,
    this.templates = const [],
  });

  @override
  State<_FullscreenPhotoViewer> createState() => _FullscreenPhotoViewerState();
}

class _FullscreenPhotoViewerState extends State<_FullscreenPhotoViewer> {
  late final PageController _controller =
      PageController(initialPage: widget.initialIndex);
  late int _currentIndex = widget.initialIndex;
  bool _showTemplate = false;

  OpsTemplate? _templateAt(int i) =>
      i < widget.templates.length ? widget.templates[i] : null;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.close_rounded, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(
          [
            if (widget.urls.length > 1)
              '${_currentIndex + 1} / ${widget.urls.length}',
            if (_showTemplate && _templateAt(_currentIndex) != null)
              _templateAt(_currentIndex)!.exact ? 'ŞABLON' : 'ŞABLON (tahmini)',
          ].join('  ·  '),
          style: const TextStyle(color: Colors.white, fontSize: 14),
        ),
        actions: [
          if (_templateAt(_currentIndex) != null)
            TextButton.icon(
              onPressed: () => setState(() => _showTemplate = !_showTemplate),
              icon: Icon(
                _showTemplate ? Icons.photo_rounded : Icons.compare_rounded,
                color: AppColors.gold,
                size: 18,
              ),
              label: Text(
                _showTemplate ? 'Çıktı' : 'Şablon',
                style: const TextStyle(color: AppColors.gold),
              ),
            ),
        ],
      ),
      body: PageView.builder(
        controller: _controller,
        itemCount: widget.urls.length,
        onPageChanged: (i) => setState(() {
          _currentIndex = i;
          _showTemplate = false;
        }),
        itemBuilder: (context, i) => InteractiveViewer(
          minScale: 1,
          maxScale: 5,
          child: Center(
            child: CachedNetworkImage(
              imageUrl: _showTemplate && i == _currentIndex && _templateAt(i) != null
                  ? _templateAt(i)!.url
                  : widget.urls[i],
              fit: BoxFit.contain,
              placeholder: (c, u) => const Center(
                child: CircularProgressIndicator(color: AppColors.gold),
              ),
              errorWidget: (c, u, e) => const Icon(Icons.broken_image_outlined,
                  color: AppColors.textMuted, size: 48),
            ),
          ),
        ),
      ),
    );
  }
}
