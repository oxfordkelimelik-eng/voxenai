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
import 'ai_tool_ui.dart';
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
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 260),
        child: KeyedSubtree(
          key: ValueKey(_stage),
          child: switch (_stage) {
            _Stage.loading => AiLoadingView(
                steps: _mode == 'opener'
                    ? const ['Profil okunuyor…', 'Yakalanacak detaylar aranıyor…', 'İlk mesajlar yazılıyor…']
                    : const ['Ekran görüntüsü okunuyor…', 'Kim ne yazdı, çıkarılıyor…', 'Cevaplar yazılıyor…'],
                hint: 'Genelde 5-10 saniye sürer',
                progressDuration: const Duration(seconds: 12),
              ),
            _Stage.result => _resultView(),
            _Stage.error => ToolErrorView(
                message: _error ?? 'Bir şeyler ters gitti.',
                canRetry: !_noRetry,
                onRetry: _run,
                onBack: () => setState(() => _stage = _Stage.intro),
              ),
            _Stage.intro => _intro(),
          },
        ),
      ),
    );
  }

  // ------------------------------------------------------------ giriş

  Widget _intro() {
    final opener = _mode == 'opener';
    return ToolPage(
      bottom: ToolCta(
        label: opener ? 'İlk Mesajları Üret' : 'Cevapları Üret',
        onPressed: _shots.isEmpty ? null : _run,
        footnote: 'Günlük ücretsiz hak • Ekran görüntün kaydedilmez',
      ),
      children: [
        ToolHero(
          icon: Icons.bolt_rounded,
          title: opener ? 'İlk mesajı sana yazalım' : 'Ne yazacağını bilemedin mi?',
          subtitle: opener
              ? 'Eşleşmenin profilinin ekran görüntüsünü yükle; profilindeki bir detayı yakalayan 3 ilk mesaj yazalım.'
              : 'Sohbetin ekran görüntüsünü yükle; 3 farklı cevap ve sohbetin nasıl gittiğine dair bir röntgen al.',
          perks: opener
              ? const [
                  (Icons.waving_hand_outlined, '3 ilk mesaj'),
                  (Icons.center_focus_strong_outlined, 'Profile özel'),
                  (Icons.tune_rounded, 'Ton seçimi'),
                ]
              : const [
                  (Icons.chat_bubble_outline_rounded, '3 cevap'),
                  (Icons.radar_rounded, 'Sohbet Röntgeni'),
                  (Icons.shield_outlined, 'Dolandırıcılık uyarısı'),
                ],
        ),
        const SizedBox(height: 16),
        ToolSegmented<String>(
          value: _mode,
          options: const [
            ('reply', 'Mesaja cevap', Icons.chat_bubble_outline_rounded),
            ('opener', 'İlk mesaj', Icons.waving_hand_outlined),
          ],
          onChanged: (m) => setState(() => _mode = m),
        ),
        ToolStep(
          n: 1,
          title: opener ? 'Eşleşmenin profili' : 'Konuşmanın ekran görüntüsü',
          trailing: _shots.isEmpty ? null : '${_shots.length}/$kRizzMaxImages',
        ),
        ToolShotPicker(
          files: _shots,
          max: kRizzMaxImages,
          onAdd: _pick,
          onRemove: (i) => setState(() => _shots.removeAt(i)),
          emptyTitle: opener ? 'Profil ekran görüntüsü ekle' : 'Ekran görüntüsü ekle',
          emptyHint: opener
              ? 'Bio ve fotoğraflar görünsün'
              : 'Uzun sohbette en fazla $kRizzMaxImages görüntü, eskiden yeniye',
        ),
        const ToolHint(
          icon: Icons.privacy_tip_outlined,
          text: 'Karşı tarafın telefon numarası ya da adresi görünüyorsa göndermeden önce kırp.',
        ),
        const ToolStep(n: 2, title: 'Ton'),
        ToolPills(options: kRizzTones, selected: _tone, onSelect: (t) => setState(() => _tone = t)),
        const ToolStep(n: 3, title: 'Not', trailing: 'İsteğe bağlı'),
        ToolNoteField(
          controller: _note,
          hint: 'Nerede tanıştınız, ne istiyorsun? (ör. "buluşma teklif etmek istiyorum")',
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
    final opener = _mode == 'opener';
    var k = 0;
    Widget fx(Widget w) => ToolFadeIn(index: k++, child: w);
    return ToolPage(
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          PrimaryButton(label: 'Yeni Ekran Görüntüsü', onPressed: _reset),
          if (_freeLeft != null && _dailyFree != null) ...[
            const SizedBox(height: 8),
            ToolQuotaLine(left: _freeLeft!, total: _dailyFree!),
          ],
        ],
      ),
      children: [
        const SizedBox(height: 4),
        if (r.transcript.isNotEmpty) fx(_transcriptCard(r)),
        if (msg != null) fx(ToolNotice(icon: Icons.info_outline_rounded, text: msg)),
        if (r.notice != null) fx(ToolNotice(icon: Icons.help_outline_rounded, text: r.notice!, kind: ToolNoticeKind.warn)),
        if (r.insight != null) fx(ChatXrayCard(insight: r.insight!, onReport: (t) => _report(t, xray: true))),
        if (r.replies.isNotEmpty) ...[
          fx(ToolSectionHeader(
            icon: opener ? Icons.waving_hand_outlined : Icons.chat_bubble_outline_rounded,
            title: opener ? 'İlk mesaj önerileri' : 'Cevap önerileri',
            trailing: const Text('Dokun, kopyala', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          )),
          for (final rep in r.replies)
            ToolFadeIn(
              key: ValueKey('rep:${rep.text}'),
              index: k++,
              child: ToolCopyCard(
                badge: kRizzTones[rep.tone] ?? rep.tone,
                text: rep.text,
                why: rep.why,
                onReport: () => _report(rep.text),
              ),
            ),
        ],
        if (r.tip != null)
          fx(ToolNotice(icon: Icons.lightbulb_outline_rounded, title: 'İPUCU', text: r.tip!, kind: ToolNoticeKind.tip)),
        if (_parentId != null) fx(_morePanel()),
      ],
    );
  }

  /// Ton değiştir / daha fazla öner (aynı görüntü, ücretsiz takip hakları).
  Widget _morePanel() {
    final can = !_followBusy && _followupsLeft > 0;
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text('Beğenmedin mi?',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
              ),
              ToolChip(
                _followupsLeft > 0 ? '$_followupsLeft ek deneme' : 'Ek deneme kalmadı',
                color: _followupsLeft > 0 ? AppColors.gold : AppColors.textMuted,
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('Tonu değiştir ya da aynı tonda yeni öneriler al. Hakkından düşmez.',
              style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.35)),
          const SizedBox(height: 12),
          ToolPills(options: kRizzTones, selected: _tone, onSelect: (t) => _followup(tone: t), enabled: can),
          const SizedBox(height: 14),
          ToolSecondaryButton(
            label: _followupsLeft > 0 ? 'Daha fazla öner' : 'Ek öneri hakkı doldu',
            icon: Icons.autorenew_rounded,
            busy: _followBusy,
            onPressed: can ? () => _followup() : null,
          ),
        ],
      ),
    );
  }

  Widget _transcriptCard(RizzResult r) {
    final last = r.transcript.length > 4 ? r.transcript.sublist(r.transcript.length - 4) : r.transcript;
    final canSwap = _parentId != null &&
        _mode == 'reply' &&
        _followupsLeft > 0 &&
        !_followBusy &&
        r.transcript.any((m) => m.speaker != 'unknown');
    final low = r.confidence == 'low';
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: low ? AppColors.warning.withValues(alpha: 0.6) : AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.forum_outlined, size: 17, color: AppColors.textSecondary),
              const SizedBox(width: 8),
              const Expanded(
                child: Text('Okuduğumuz konuşma',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
              ),
              if (_mode == 'reply')
                Opacity(
                  opacity: canSwap ? 1 : 0.4,
                  child: Material(
                    color: AppColors.goldSurface,
                    borderRadius: BorderRadius.circular(20),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(20),
                      onTap: canSwap ? () => _followup(swap: true) : null,
                      child: const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.swap_horiz_rounded, size: 15, color: AppColors.gold),
                            SizedBox(width: 4),
                            Text('Taraflar ters mi?',
                                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: AppColors.gold)),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          if (low && _mode == 'reply') ...[
            const SizedBox(height: 6),
            const Text('Kimin yazdığından tam emin değiliz; yanlışsa tarafları çevir.',
                style: TextStyle(fontSize: 12, color: AppColors.warning, height: 1.35)),
          ],
          const SizedBox(height: 10),
          for (final m in last) _bubble(m),
        ],
      ),
    );
  }

  Widget _bubble(RizzMessage m) {
    final mine = m.speaker == 'user';
    const r = Radius.circular(16);
    const tail = Radius.circular(4);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: const BoxConstraints(maxWidth: 270),
        decoration: BoxDecoration(
          color: mine ? AppColors.gold.withValues(alpha: 0.88) : AppColors.surfaceElevated,
          borderRadius: BorderRadius.only(
            topLeft: r,
            topRight: r,
            bottomLeft: mine ? r : tail,
            bottomRight: mine ? tail : r,
          ),
        ),
        child: Column(
          crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              mine ? 'Sen' : (m.speaker == 'match' ? 'O' : '?'),
              style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w900,
                  color: mine ? const Color(0xCCFFFFFF) : AppColors.gold),
            ),
            const SizedBox(height: 2),
            Text(
              m.text,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 13.5, height: 1.35, color: mine ? AppColors.textOnGold : AppColors.textPrimary),
            ),
          ],
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
    final reason = await showToolReportSheet(
      context,
      title: xray ? 'Bu değerlendirmeyi neden bildiriyorsun?' : 'Bu öneriyi neden bildiriyorsun?',
      reasons: reasons,
    );
    if (reason == null) return;
    try {
      await reportRizzReply(text: text, reason: reason, requestId: _parentId, feature: xray ? 'xray' : 'rizz');
      _snack('Teşekkürler, bildirimin alındı.');
    } catch (_) {
      _snack('Bildirim gönderilemedi. Lütfen tekrar dene.', error: true);
    }
  }
}
