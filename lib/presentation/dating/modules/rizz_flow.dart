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
import 'ai_tool_ui.dart';
import 'ai_tool_visuals.dart';
import 'chat_xray_card.dart';
import 'module_flows.dart' show ModuleScaffold;

class RizzFlow extends ConsumerStatefulWidget {
  const RizzFlow({super.key, this.previewResult});

  /// Yalnız önizleme/test: verilirse ekran ağ çağrısı yapmadan doğrudan bu sonuçla açılır.
  @visibleForTesting
  final RizzResult? previewResult;
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
  void initState() {
    super.initState();
    final r = widget.previewResult;
    if (r == null) return;
    _result = r;
    _parentId = r.requestId;
    _followupsLeft = r.followupsLeft;
    _freeLeft = r.freeLeft;
    _dailyFree = r.dailyFree;
    _stage = _Stage.result;
  }

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
        _snack(_statusMessage(r) ?? 'Bu turda daha iyisi çıkmadı; bir daha dene. Hakkın düşmedi.');
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
                    ? const ['Profil didik didik okunuyor…', 'Kimsenin fark etmediği detay aranıyor…', '"Selam naber" çöpe atılıyor…']
                    : const ['Kim ne demiş, okunuyor…', 'Satır araları taranıyor…', 'Kozların cilalanıyor…'],
                hint: '5-10 saniye. Bu arada saçını düzeltebilirsin.',
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
  // SADELEŞTİRME (2026-11-23, kullanıcı: "çok yazı var, karmaşık; sade ve şık olsun"): kapak görseli + tek
  // başlık, mod seçici, büyük yükleme alanı, ton; not yalnız istenirse açılır. Numaralı adımlar ve
  // kazanım etiketleri kaldırıldı.

  Widget _intro() {
    final opener = _mode == 'opener';
    return ToolPage(
      bottom: ToolCta(
        label: opener ? 'Açılışımı Yaz ⚡' : 'Cevaplarımı Getir ⚡',
        onPressed: _shots.isEmpty ? null : _run,
        footnote: 'Her gün ücretsiz • Ekran görüntün bizde kalmaz',
      ),
      children: [
        ToolIntroHeader(
          visual: const RizzCoverVisual(),
          title: opener ? '"Selam naber"e veda et' : 'Top sende, smaç bizden',
          subtitle: opener
              ? 'Onun profilini at; kimsenin yazmadığı 3 açılış yazalım.'
              : 'Sohbeti at; "bunu nasıl düşündün?" dedirtecek 3 cevap yazalım.',
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
        const SizedBox(height: 12),
        ToolShotPicker(
          files: _shots,
          max: kRizzMaxImages,
          onAdd: _pick,
          onRemove: (i) => setState(() => _shots.removeAt(i)),
          emptyTitle: opener ? 'Onun profilini buraya bırak' : 'Sohbeti buraya bırak',
          emptyHint: 'En fazla $kRizzMaxImages • numara ya da adres görünüyorsa kırp',
        ),
        const ToolLabel('Bugün hangi moddasın?'),
        ToolPills(options: kRizzTones, selected: _tone, onSelect: (t) => setState(() => _tone = t)),
        ToolOptionalNote(
          controller: _note,
          label: 'Bilmemiz gereken bir şey?',
          hint: 'ör. bu cuma onu bir yere çağırmak istiyorum',
        ),
      ],
    );
  }

  // ------------------------------------------------------------ sonuç

  String? _statusMessage(RizzResult r) => switch (r.status) {
        'not_a_chat' => 'Bu bir sohbete benzemiyor; biz mesajlaşma ekranlarında iddialıyız. Hakkın düşmedi.',
        'unreadable' => 'Son mesaj biraz bulanık kaldı. Daha net bir ekran görüntüsü atar mısın? Hakkın düşmedi.',
        'unsafe_minor' => 'Bu konuşmada 18 yaşından küçük biri olabileceği için öneri veremiyoruz.',
        'declined' => 'Karşı taraf ilgisiz ya da durmanı istemiş görünüyor; ısrar etmeni önermiyoruz. Hakkın düşmedi.',
        'sensitive' => 'Bu konuşmada hassas bir durum görünüyor; flört önerisi vermiyoruz. Hakkın düşmedi.',
        'refused' => 'Bu içerik için öneri üretemiyoruz. Hakkın düşmedi.',
        'ok' when r.replies.isEmpty => 'İlham perisi bu sefer gelmedi; bir daha dene. Hakkın düşmedi.',
        _ => null,
      };

  /// SONUÇ (2026-11-23 ikinci sadeleştirme, kullanıcı: "daha sade, anlaşılır ve şık"):
  /// üstte karşı tarafın son mesajları (neye cevap verildiği), büyük "Cevabın hazır" başlığı, cevaplar
  /// gönderilmeye hazır sohbet balonları (dokun → kopyala), tek satırda başka ton + daha fazla, kapalı
  /// Sohbet Röntgeni ve tek satırlık ipucu. Cevap gerekçeleri gösterilmez (yazı kalabalığı).
  /// Dolandırıcılık riski varsa Röntgen en üste çıkar (güvenlik bilgisi önce).
  Widget _resultView() {
    final r = _result!;
    final msg = _statusMessage(r);
    final opener = _mode == 'opener';
    final riskFirst = r.insight?.risk != null;
    var k = 0;
    Widget fx(Widget w) => ToolFadeIn(index: k++, child: w);
    Widget xray() => fx(ChatXrayCard(insight: r.insight!, onReport: (t) => _report(t, xray: true)));
    return ToolPage(
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          PrimaryButton(label: 'Yeni Sohbet At', onPressed: _reset),
          if (_freeLeft != null && _dailyFree != null) ...[
            const SizedBox(height: 8),
            ToolQuotaLine(left: _freeLeft!, total: _dailyFree!),
          ],
        ],
      ),
      children: [
        const SizedBox(height: 4),
        if (msg != null) fx(ToolNotice(icon: Icons.info_outline_rounded, text: msg)),
        if (r.notice != null) fx(ToolNotice(icon: Icons.help_outline_rounded, text: r.notice!, kind: ToolNoticeKind.warn)),
        if (riskFirst && r.insight != null) xray(),
        if (r.transcript.isNotEmpty) fx(_context(r)),
        if (r.replies.isNotEmpty) ...[
          fx(Padding(
            padding: const EdgeInsets.only(top: 18, bottom: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(opener ? 'İlk hamlen hazır' : 'Kozların hazır',
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
                const SizedBox(height: 4),
                const Text('Birine dokun, kopyalansın. Gerisi senin karizman.',
                    style: TextStyle(fontSize: 13.5, color: AppColors.textSecondary)),
              ],
            ),
          )),
          for (final rep in r.replies)
            ToolFadeIn(
              key: ValueKey('rep:${rep.text}'),
              index: k++,
              child: _ReplyBubble(
                tone: kRizzTones[rep.tone] ?? rep.tone,
                text: rep.text,
                onReport: () => _report(rep.text),
              ),
            ),
        ],
        if (_parentId != null) fx(_toneBar()),
        if (!riskFirst && r.insight != null) xray(),
        if (r.tip != null)
          fx(Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.lightbulb_outline_rounded, size: 17, color: AppColors.gold),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(r.tip!, style: const TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.4)),
                ),
              ],
            ),
          )),
      ],
    );
  }

  /// Başka ton (tek satır, kaydırmasız) + başlık satırında "daha fazla" düğmesi. Aynı görüntü, ücretsiz takip hakkı.
  Widget _toneBar() {
    final can = !_followBusy && _followupsLeft > 0;
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text('Başka bir havada dene',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
              ),
              Text(_followupsLeft > 0 ? '$_followupsLeft hak' : 'Hak kalmadı',
                  style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              const SizedBox(width: 6),
              TextButton.icon(
                onPressed: can ? () => _followup() : null,
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  foregroundColor: AppColors.gold,
                  disabledForegroundColor: AppColors.textMuted,
                ),
                icon: _followBusy
                    ? const SizedBox(
                        width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
                    : const Icon(Icons.autorenew_rounded, size: 17),
                label: const Text('Yenilerini getir', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ToolPills(options: kRizzTones, selected: _tone, onSelect: (t) => _followup(tone: t), enabled: can),
        ],
      ),
    );
  }

  /// Neye cevap verildiği: konuşmanın son iki mesajı (soluk balonlar) + "Taraflar ters mi?".
  /// Kimin yazdığından emin değilsek uyarı gösterilir (yanlış tarafa cevap yazılmasın).
  Widget _context(RizzResult r) {
    final last = r.transcript.length > 2 ? r.transcript.sublist(r.transcript.length - 2) : r.transcript;
    final canSwap = _parentId != null &&
        _mode == 'reply' &&
        _followupsLeft > 0 &&
        !_followBusy &&
        r.transcript.any((m) => m.speaker != 'unknown');
    final low = r.confidence == 'low' && _mode == 'reply';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final m in last) _bubble(m),
        if (low)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('Kimin yazdığından emin değiliz; yanlışsa tarafları çevir.',
                style: TextStyle(fontSize: 12, color: AppColors.warning, height: 1.35)),
          ),
        if (_mode == 'reply')
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: canSwap ? () => _followup(swap: true) : null,
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 4),
                foregroundColor: AppColors.textSecondary,
                disabledForegroundColor: AppColors.textMuted,
              ),
              icon: const Icon(Icons.swap_horiz_rounded, size: 16),
              label: const Text('Taraflar ters mi?', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
            ),
          ),
      ],
    );
  }

  /// Konuşmadaki bir mesaj (soluk, bağlam için): sağda sen, solda o.
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
          color: mine ? AppColors.surfaceHighest : AppColors.surfaceElevated,
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
              style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: AppColors.textMuted),
            ),
            const SizedBox(height: 2),
            Text(
              m.text,
              style: const TextStyle(fontSize: 13.5, height: 1.35, color: AppColors.textSecondary),
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

/// Gönderilmeye hazır cevap balonu (sağa yaslı, kırmızı tonlu): üstte ton, sağda bildir + kopyala.
/// Dokununca kopyalar; 1.6 sn "Kopyalandı" görünür ve kenar parlar.
class _ReplyBubble extends StatefulWidget {
  final String tone;
  final String text;
  final VoidCallback onReport;
  const _ReplyBubble({required this.tone, required this.text, required this.onReport});

  @override
  State<_ReplyBubble> createState() => _ReplyBubbleState();
}

class _ReplyBubbleState extends State<_ReplyBubble> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    HapticFeedback.lightImpact();
    if (!mounted) return;
    setState(() => _copied = true);
    await Future.delayed(const Duration(milliseconds: 1600));
    if (mounted) setState(() => _copied = false);
  }

  @override
  Widget build(BuildContext context) {
    const radius = BorderRadius.only(
      topLeft: Radius.circular(20),
      topRight: Radius.circular(20),
      bottomLeft: Radius.circular(20),
      bottomRight: Radius.circular(6),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 12, left: 28),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            colors: [Color(0x33FF2D55), Color(0x14FF2D55)],
            begin: Alignment.topRight,
            end: Alignment.bottomLeft,
          ),
          borderRadius: radius,
          border: Border.all(color: _copied ? AppColors.gold : kToolAccentBorder, width: _copied ? 1.4 : 0.8),
          boxShadow: _copied ? const [BoxShadow(color: AppColors.goldGlow, blurRadius: 16)] : null,
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: radius,
            onTap: _copy,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 6, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(widget.tone.toUpperCase(),
                            style: const TextStyle(
                                fontSize: 10.5, fontWeight: FontWeight.w900, letterSpacing: 0.7, color: AppColors.goldLight)),
                      ),
                      SizedBox(
                        width: 34,
                        height: 30,
                        child: IconButton(
                          tooltip: 'Bildir',
                          padding: EdgeInsets.zero,
                          iconSize: 17,
                          icon: const Icon(Icons.outlined_flag_rounded, color: AppColors.textMuted),
                          onPressed: widget.onReport,
                        ),
                      ),
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 160),
                        child: _copied
                            ? const Padding(
                                key: ValueKey('ok'),
                                padding: EdgeInsets.symmetric(horizontal: 8),
                                child: Text('Kopyalandı ✓',
                                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: AppColors.gold)),
                              )
                            : SizedBox(
                                key: const ValueKey('copy'),
                                width: 34,
                                height: 30,
                                child: IconButton(
                                  tooltip: 'Kopyala',
                                  padding: EdgeInsets.zero,
                                  iconSize: 18,
                                  icon: const Icon(Icons.copy_rounded, color: AppColors.gold),
                                  onPressed: _copy,
                                ),
                              ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Padding(
                    padding: const EdgeInsets.only(right: 10),
                    child: Text(widget.text,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w500, color: AppColors.textPrimary, height: 1.45)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
