// RIZZGPT — EKRAN GÖRÜNTÜSÜNDEN MESAJ CEVABI (2026-11-22, kullanıcı: "RizzGPT'yi gerçek hale getirelim").
//
// Akış: mod (mesaja cevap / profilden ilk mesaj) → 1-3 ekran görüntüsü → ton (otomatik/esprili/flörtöz/
// samimi/cesur) + isteğe bağlı not → giriş + OpenAI onayı → sunucu (functions/rizz.js rizzReply).
// Sonuç: okunan konuşma (Sen / O — yanlışsa "taraflar ters"), Sohbet Röntgeni (chat_xray_card.dart), 3 cevap kartı (dokun-kopyala, neden,
// bildir), ipucu, "daha fazla" ve ton değiştirme (aynı görüntü için 30 dk içinde 3 kez ücretsiz).
// Eski sürüm (module_flows.dart) 2 sn bekleyip sabit cevap gösteriyordu; bu dosya onun yerini aldı.

import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/constants/app_colors.dart';
import '../../providers/app_providers.dart' show authServiceProvider;
import '../paywall/purchase_auth_gate.dart';
import '../providers/dating_providers.dart' show datingAnswersProvider;
import '../rizz_service.dart';
import '../widgets/ai_consent_gate.dart';
import '../widgets/dating_widgets.dart' show PrimaryButton;
import '../widgets/shared_widgets.dart' show AiLoadingView;
import 'chat_xray_card.dart';
import 'module_flows.dart' show ModuleScaffold;

class RizzFlow extends ConsumerStatefulWidget {
  const RizzFlow({super.key});
  @override
  ConsumerState<RizzFlow> createState() => _RizzFlowState();
}

enum _Stage { intro, loading, result, error }

class _RizzFlowState extends ConsumerState<RizzFlow> {
  _Stage _stage = _Stage.intro;
  String _mode = 'reply';
  final List<File> _shots = [];
  String _tone = 'auto';
  final _note = TextEditingController();

  // Sonuç ve takip istekleri (aynı görüntü yeniden gönderilir; sunucu hiçbir şey saklamaz).
  List<Map<String, String>>? _images;
  RizzResult? _result;
  String? _parentId;
  int _followupsLeft = 0;
  final List<String> _shown = [];
  // "Taraflar ters" sonrası düzeltilen okuma: sonraki takiplerde de gönderilir ki düzeltme kalıcı olsun.
  List<RizzMessage> _swapFrom = const [];
  int? _freeLeft;
  int? _dailyFree;
  bool _followBusy = false;
  String? _error;
  bool _noRetry = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? AppColors.error : null,
      duration: const Duration(seconds: 3),
    ));
  }

  Future<void> _pick() async {
    final left = kRizzMaxImages - _shots.length;
    if (left <= 0) return;
    final picker = ImagePicker();
    // pickMultiImage limit ≥ 2 ister: tek boş yer kaldıysa tekli seçici.
    // imageQuality: iOS HEIC'i JPEG'e çevirtir (package:image HEIC çözemez).
    final List<XFile> xs;
    if (left == 1) {
      final x = await picker.pickImage(source: ImageSource.gallery, imageQuality: 95);
      xs = x == null ? const [] : [x];
    } else {
      xs = await picker.pickMultiImage(limit: left, imageQuality: 95);
    }
    if (!mounted || xs.isEmpty) return;
    setState(() => _shots.addAll(xs.take(left).map((x) => File(x.path))));
  }

  Future<bool> _ensureSignedIn() async {
    final auth = ref.read(authServiceProvider);
    if (auth.currentUser != null && !auth.isAnonymous) return true;
    return ensureSignedInForPurchase(
      context,
      ref,
      title: 'RizzGPT için giriş yap',
      body: 'Günlük ücretsiz cevap hakların hesabına tanımlanır; bu yüzden '
          'giriş yapman gerekiyor. Ücret alınmaz.',
    );
  }

  Future<void> _run() async {
    if (_shots.isEmpty) return;
    if (!await _ensureSignedIn()) return;
    if (!mounted) return;
    if (!await ensureAiProcessingConsent(context, kind: AiFlowKind.chatReply)) return;
    setState(() {
      _stage = _Stage.loading;
      _error = null;
      _noRetry = false;
    });
    try {
      final enc = await encodeRizzImages(_shots);
      if (enc.truncated) _snack('Konuşma çok uzun; son kısmını okuyoruz.');
      final r = await requestRizzReplies(
        images: enc.images,
        mode: _mode,
        tone: _tone,
        gender: ref.read(datingAnswersProvider).gender,
        note: _note.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _images = enc.images;
        _result = r;
        _parentId = r.requestId;
        _followupsLeft = r.requestId != null ? r.followupsLeft : 0;
        _swapFrom = const [];
        _freeLeft = r.freeLeft;
        _dailyFree = r.dailyFree;
        _shown
          ..clear()
          ..addAll(r.replies.map((e) => e.text));
        _stage = _Stage.result;
      });
    } on RizzImageException {
      if (!mounted) return;
      setState(() {
        _error = 'Bu görsel türü okunamadı. Telefonun ekran görüntüsü özelliğiyle aldığın bir görüntü seç.';
        _noRetry = true;
        _stage = _Stage.error;
      });
    } on FirebaseFunctionsException catch (e) {
      await _handleError(e);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Cevap şu an üretilemedi. Lütfen biraz sonra tekrar dene.';
        _stage = _Stage.error;
      });
    }
  }

  String? _reasonOf(FirebaseFunctionsException e) {
    final d = e.details;
    return d is Map ? d['reason'] as String? : null;
  }

  Future<void> _handleError(FirebaseFunctionsException e) async {
    final reason = _reasonOf(e);
    if (reason == 'login-required') {
      if (!mounted) return;
      setState(() => _stage = _Stage.intro);
      if (await _ensureSignedIn()) _run();
      return;
    }
    if (!mounted) return;
    setState(() {
      // Hak bitti / günlük deneme sınırı / konuşma çok uzun: aynı istek tekrar denense de aynı sonuç.
      _noRetry = reason == 'quota' || reason == 'attempts' || reason == 'too-long';
      _error = e.code == 'failed-precondition' || e.code == 'resource-exhausted' || e.code == 'unavailable'
          ? (e.message ?? 'Şu an cevap üretilemiyor.')
          : 'Cevap şu an üretilemedi. Lütfen biraz sonra tekrar dene.';
      _stage = _Stage.error;
    });
  }

  /// Daha fazla / taraflar ters / ton değiştir: aynı görüntü, ana isteğe bağlı (ücretsiz, en çok 3).
  /// Sonuç gösterilemezse (cevap yok) eldeki sonuç KORUNUR, sunucu hakkı iade eder.
  Future<void> _followup({String? tone, bool swap = false}) async {
    final images = _images;
    final current = _result;
    if (images == null || current == null || _parentId == null || _followBusy) return;
    if (_followupsLeft <= 0) {
      _snack('Bu ekran görüntüsü için ek cevap hakkın doldu. Yeni bir istek başlat.');
      return;
    }
    setState(() => _followBusy = true);
    // Ters çevirme: ekrandaki (yanlış bulunan) okuma gönderilir; ikinci basış düzeltilmişi geri çevirir.
    final swapFrom = swap ? current.transcript : _swapFrom;
    try {
      final r = await requestRizzReplies(
        images: images,
        mode: _mode,
        tone: tone ?? _tone,
        gender: ref.read(datingAnswersProvider).gender,
        note: _note.text.trim(),
        // Taraf değişince eski cevaplar zaten yanlış kişiye yazılmıştı: tekrar yasağı yalnız "daha fazla"da.
        avoid: swap ? const [] : _shown.reversed.take(9).toList(),
        swapFrom: swapFrom,
        parentId: _parentId,
      );
      if (!mounted) return;
      if (!r.charged || r.replies.isEmpty) {
        setState(() {
          _followupsLeft = r.followupsLeft;
          // Cevap çıkmasa da yeni bulunan dolandırıcılık riski (güvenlik bilgisi) eldeki sonuca eklenir.
          final extra = r.insight?.risk;
          if (extra != null) _result = current.withInsight(withMergedRisk(current.insight, extra));
        });
        _snack(_statusMessage(r) ?? 'Bu sefer uygun öneri çıkmadı, tekrar dene. Hakkın düşmedi.');
        return;
      }
      setState(() {
        if (tone != null) _tone = tone;
        _swapFrom = swapFrom;
        // Röntgen tona göre değişmesin: yalnız "taraflar ters"te yenilenir; yeni bulunan risk her durumda eklenir.
        _result = swap ? r : r.withInsight(withMergedRisk(current.insight ?? r.insight, r.insight?.risk));
        _followupsLeft = r.followupsLeft;
        _shown.addAll(r.replies.map((e) => e.text));
      });
    } on FirebaseFunctionsException catch (e) {
      final reason = _reasonOf(e);
      if (mounted && (reason == 'followup-limit' || reason == 'parent-expired' || reason == 'parent-mismatch')) {
        setState(() => _followupsLeft = 0);
      }
      _snack(e.message ?? 'Cevap şu an üretilemedi.', error: true);
    } catch (_) {
      _snack('Cevap şu an üretilemedi. Lütfen tekrar dene.', error: true);
    } finally {
      if (mounted) setState(() => _followBusy = false);
    }
  }

  void _reset() {
    setState(() {
      _stage = _Stage.intro;
      _shots.clear();
      _images = null;
      _result = null;
      _parentId = null;
      _shown.clear();
      _note.clear();
      _swapFrom = const [];
    });
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'RizzGPT',
      body: switch (_stage) {
        _Stage.loading => AiLoadingView(
            steps: _mode == 'opener'
                ? const ['Profil okunuyor…', 'Yakalanacak detaylar aranıyor…', 'İlk mesajlar yazılıyor…']
                : const ['Ekran görüntüsü okunuyor…', 'Kim ne yazdı, çıkarılıyor…', 'Cevaplar yazılıyor…'],
            hint: 'Genelde 5-10 saniye sürer',
            progressDuration: const Duration(seconds: 12),
          ),
        _Stage.result => _resultView(),
        _Stage.error => _errorView(),
        _Stage.intro => _intro(),
      },
    );
  }

  // ------------------------------------------------------------ giriş

  Widget _intro() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      children: [
        _segmented(),
        const SizedBox(height: 18),
        Text(
          _mode == 'opener' ? 'Eşleşmenin profilinin ekran görüntüsü' : 'Konuşmanın ekran görüntüsü',
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: AppColors.textPrimary),
        ),
        const SizedBox(height: 4),
        Text(
          _mode == 'opener'
              ? 'Bio ve fotoğraflardaki bir detayı yakalayan ilk mesajlar yazarız.'
              : 'Uzun sohbette en fazla $kRizzMaxImages görüntü ekleyebilirsin (eskiden yeniye).',
          style: const TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.4),
        ),
        const SizedBox(height: 12),
        _shotsRow(),
        const SizedBox(height: 8),
        const Text(
          'Karşı tarafın telefon numarası ya da adresi görünüyorsa göndermeden önce kırp.',
          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.35),
        ),
        const SizedBox(height: 16),
        const Text('Ton', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
        const SizedBox(height: 8),
        _toneChips(_tone, (t) => setState(() => _tone = t)),
        const SizedBox(height: 18),
        TextField(
          controller: _note,
          maxLength: 300,
          maxLines: 2,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
          decoration: InputDecoration(
            hintText: 'İsteğe bağlı: nerede tanıştınız, ne istiyorsun? (ör. "buluşma teklif etmek istiyorum")',
            hintStyle: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            filled: true,
            fillColor: AppColors.surface,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
          ),
        ),
        const SizedBox(height: 8),
        PrimaryButton(
          label: _mode == 'opener' ? 'İlk Mesajları Üret' : 'Cevapları Üret',
          onPressed: _shots.isEmpty ? null : _run,
        ),
        const SizedBox(height: 12),
        const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline_rounded, size: 14, color: AppColors.textMuted),
            SizedBox(width: 6),
            Flexible(
              child: Text('Günlük ücretsiz hak • Ekran görüntün kaydedilmez',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
          ],
        ),
      ],
    );
  }

  Widget _segmented() {
    Widget seg(String key, String label, IconData icon) {
      final on = _mode == key;
      return Expanded(
        child: GestureDetector(
          onTap: () => setState(() => _mode = key),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            padding: const EdgeInsets.symmetric(vertical: 11),
            decoration: BoxDecoration(
              color: on ? AppColors.gold : Colors.transparent,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 16, color: on ? Colors.black : AppColors.textSecondary),
                const SizedBox(width: 6),
                Text(label,
                    style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w800,
                        color: on ? Colors.black : AppColors.textSecondary)),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        seg('reply', 'Mesaja cevap', Icons.chat_bubble_outline_rounded),
        seg('opener', 'İlk mesaj', Icons.waving_hand_outlined),
      ]),
    );
  }

  Widget _shotsRow() {
    return SizedBox(
      height: 170,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (int i = 0; i < _shots.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(_shots[i], width: 96, height: 170, fit: BoxFit.cover),
                  ),
                  Positioned(
                    top: 4,
                    right: 4,
                    child: GestureDetector(
                      onTap: () => setState(() => _shots.removeAt(i)),
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                        child: const Icon(Icons.close_rounded, size: 16, color: Colors.white),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (_shots.length < kRizzMaxImages)
            GestureDetector(
              onTap: _pick,
              child: Container(
                width: _shots.isEmpty ? MediaQuery.of(context).size.width - 40 : 96,
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.borderGold),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(Icons.add_photo_alternate_outlined, color: AppColors.gold, size: 32),
                    const SizedBox(height: 6),
                    Text(_shots.isEmpty ? 'Ekran görüntüsü ekle' : 'Ekle',
                        style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _toneChips(String selected, ValueChanged<String> onSelect, {bool enabled = true}) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final e in kRizzTones.entries)
          ChoiceChip(
            label: Text(e.value),
            selected: selected == e.key,
            onSelected: enabled ? (_) => onSelect(e.key) : null,
            selectedColor: AppColors.gold,
            backgroundColor: AppColors.surface,
            labelStyle: TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: 13,
              color: selected == e.key ? Colors.black : AppColors.textSecondary,
            ),
            side: BorderSide(color: selected == e.key ? AppColors.gold : AppColors.borderSubtle),
            showCheckmark: false,
          ),
      ],
    );
  }

  // ------------------------------------------------------------ sonuç

  String? _statusMessage(RizzResult r) => switch (r.status) {
        'not_a_chat' => 'Bu bir sohbet ya da profil ekran görüntüsüne benzemiyor. Hakkın düşmedi.',
        'unreadable' => 'Son mesajı okuyamadık. Daha net ya da daha yakın bir ekran görüntüsü dene. Hakkın düşmedi.',
        'unsafe_minor' => 'Bu konuşmada 18 yaşından küçük biri olabileceği için öneri veremiyoruz.',
        'declined' => 'Karşı taraf ilgisiz ya da durmanı istemiş görünüyor; ısrar etmeni önermiyoruz. Hakkın düşmedi.',
        'sensitive' => 'Bu konuşmada hassas bir durum görünüyor; flört önerisi vermiyoruz. Hakkın düşmedi.',
        'refused' => 'Bu içerik için öneri üretemiyoruz. Hakkın düşmedi.',
        'ok' when r.replies.isEmpty => 'Uygun bir cevap üretemedik, tekrar dene. Hakkın düşmedi.',
        _ => null,
      };

  Widget _resultView() {
    final r = _result!;
    final msg = _statusMessage(r);
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      children: [
        if (r.transcript.isNotEmpty) ...[
          _transcriptCard(r),
          const SizedBox(height: 14),
        ],
        if (msg != null) _infoCard(Icons.info_outline_rounded, msg),
        if (r.notice != null) _infoCard(Icons.help_outline_rounded, r.notice!),
        if (r.insight != null) ChatXrayCard(insight: r.insight!, onReport: (t) => _report(t, xray: true)),
        if (r.tip != null) _infoCard(Icons.lightbulb_outline_rounded, r.tip!, gold: true),
        if (r.replies.isNotEmpty) ...[
          Row(
            children: [
              Text(_mode == 'opener' ? 'İlk mesaj önerileri' : 'Cevap önerileri',
                  style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
              const Spacer(),
              const Text('Dokun, kopyala', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ],
          ),
          const SizedBox(height: 10),
          for (final rep in r.replies) _replyCard(rep),
        ],
        const SizedBox(height: 6),
        if (_parentId != null) ...[
          const Text('Tonu değiştir',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
          const SizedBox(height: 8),
          _toneChips(_tone, (t) => _followup(tone: t), enabled: !_followBusy && _followupsLeft > 0),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _followBusy || _followupsLeft <= 0 ? null : () => _followup(),
              icon: _followBusy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
                  : const Icon(Icons.autorenew_rounded),
              label: Text(_followupsLeft > 0 ? 'Daha fazla öner ($_followupsLeft)' : 'Ek öneri hakkı doldu'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.gold,
                side: const BorderSide(color: AppColors.gold),
                padding: const EdgeInsets.symmetric(vertical: 13),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(height: 10),
        ],
        PrimaryButton(label: 'Yeni Ekran Görüntüsü', onPressed: _reset),
        if (_freeLeft != null && _dailyFree != null) ...[
          const SizedBox(height: 10),
          Center(
            child: Text('Bugün kalan ücretsiz hak: $_freeLeft/$_dailyFree',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
        ],
      ],
    );
  }

  Widget _transcriptCard(RizzResult r) {
    final last = r.transcript.length > 4 ? r.transcript.sublist(r.transcript.length - 4) : r.transcript;
    final canSwap = _parentId != null &&
        _mode == 'reply' &&
        _followupsLeft > 0 &&
        !_followBusy &&
        r.transcript.any((m) => m.speaker != 'unknown');
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: r.confidence == 'low' ? AppColors.gold : AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Text('Okuduğumuz konuşma',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
              const Spacer(),
              if (_mode == 'reply')
                TextButton.icon(
                  onPressed: canSwap
                      ? () => _followup(swap: true)
                      : null,
                  icon: const Icon(Icons.swap_horiz_rounded, size: 18),
                  label: const Text('Taraflar ters mi?'),
                  style: TextButton.styleFrom(
                    foregroundColor: AppColors.gold,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    visualDensity: VisualDensity.compact,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          for (final m in last) _bubble(m),
        ],
      ),
    );
  }

  Widget _bubble(RizzMessage m) {
    final mine = m.speaker == 'user';
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        constraints: const BoxConstraints(maxWidth: 260),
        decoration: BoxDecoration(
          color: mine ? AppColors.gold.withValues(alpha: 0.18) : AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text.rich(
          TextSpan(children: [
            TextSpan(
              text: mine ? 'Sen  ' : (m.speaker == 'match' ? 'O  ' : '?  '),
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w900, color: AppColors.gold),
            ),
            TextSpan(text: m.text, style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.35)),
          ]),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }

  Widget _infoCard(IconData icon, String text, {bool gold = false}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: gold ? AppColors.gold.withValues(alpha: 0.10) : AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: gold ? AppColors.borderGold : AppColors.borderSubtle),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: gold ? AppColors.gold : AppColors.textSecondary),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.4))),
        ],
      ),
    );
  }

  Widget _replyCard(RizzReply rep) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () async {
          await Clipboard.setData(ClipboardData(text: rep.text));
          HapticFeedback.lightImpact();
          _snack('Kopyalandı — sohbete yapıştırabilirsin');
        },
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.gold.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(kRizzTones[rep.tone] ?? rep.tone,
                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: AppColors.gold)),
                    ),
                    const SizedBox(height: 8),
                    Text(rep.text, style: const TextStyle(fontSize: 15, color: AppColors.textPrimary, height: 1.4)),
                    if (rep.why.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(rep.why, style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.3)),
                    ],
                  ],
                ),
              ),
              Column(
                children: [
                  const Padding(
                    padding: EdgeInsets.all(8),
                    child: Icon(Icons.copy_rounded, color: AppColors.textMuted, size: 18),
                  ),
                  IconButton(
                    tooltip: 'Bildir',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.outlined_flag_rounded, color: AppColors.textMuted, size: 18),
                    onPressed: () => _report(rep.text),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Bildirim: cevap kartı (feature 'rizz') ya da Sohbet Röntgeni (feature 'xray').
  Future<void> _report(String text, {bool xray = false}) async {
    final reasons = xray
        ? const {
            'unfair': 'Haksız / yanlış değerlendirme',
            'offensive': 'Kırıcı ya da saldırgan',
            'wrong_person': 'Taraflar yanlış okunmuş',
            'other': 'Diğer',
          }
        : const {
            'offensive': 'Kırıcı ya da saldırgan',
            'sexual': 'Cinsel / uygunsuz',
            'wrong_person': 'Yanlış kişiye cevap',
            'bad_quality': 'Kötü / anlamsız',
            'other': 'Diğer',
          };
    final reason = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.surface,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 18, 20, 8),
              child: Text('Bu öneriyi neden bildiriyorsun?',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
            ),
            for (final e in reasons.entries)
              ListTile(
                title: Text(e.value, style: const TextStyle(color: AppColors.textPrimary)),
                onTap: () => Navigator.pop(ctx, e.key),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (reason == null) return;
    try {
      await reportRizzReply(text: text, reason: reason, requestId: _parentId, feature: xray ? 'xray' : 'rizz');
      _snack('Teşekkürler, bildirimin alındı.');
    } catch (_) {
      _snack('Bildirim gönderilemedi. Lütfen tekrar dene.', error: true);
    }
  }

  // ------------------------------------------------------------ hata

  Widget _errorView() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(_noRetry ? Icons.hourglass_bottom_rounded : Icons.error_outline_rounded,
              size: 46, color: AppColors.gold),
          const SizedBox(height: 14),
          Text(_error ?? 'Bir şeyler ters gitti.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15, color: AppColors.textPrimary, height: 1.45)),
          const SizedBox(height: 22),
          if (!_noRetry) PrimaryButton(label: 'Tekrar Dene', onPressed: _run),
          TextButton(
            onPressed: () => setState(() => _stage = _Stage.intro),
            child: const Text('Geri dön', style: TextStyle(color: AppColors.textSecondary)),
          ),
        ],
      ),
    );
  }
}
