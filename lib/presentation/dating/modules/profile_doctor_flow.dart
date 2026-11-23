// PROFİL DOKTORU (2026-11-22, kullanıcı: "1 ve 2'yi yapalım").
//
// Akış: kendi profilinin 1-3 ekran görüntüsü + hedef (ciddi/rahat/açık/emin değil) + isteğe bağlı not →
// giriş + OpenAI onayı → sunucu (functions/profileDoctor.js).
// Sonuç: ilk izlenim, güçlü yanlar, öncelikli düzeltmeler, fotoğraf fotoğraf karar (başa al / kalsın /
// çıkar / yeniden çek), eksik fotoğraf türleri → AI Fotoğraf Üretimi ve Fotoğraf Analizi'ne geçiş, mevcut bio
// yorumu, 3 yeni bio + 3 prompt cevabı (dokun-kopyala, bildir), "yeni bio önerileri" (aynı görüntü, 2 kez
// ücretsiz; analiz korunur, yalnız metin yenilenir).

import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/constants/app_colors.dart';
import '../../../core/constants/dating_constants.dart';
import '../../../core/router/dating_routes.dart';
import '../../providers/app_providers.dart' show authServiceProvider;
import '../paywall/purchase_auth_gate.dart';
import '../profile_doctor_service.dart';
import '../rizz_service.dart' show encodeRizzImages, kRizzMaxImages, RizzImageException, reportRizzReply;
import '../widgets/ai_consent_gate.dart';
import '../widgets/dating_widgets.dart' show PrimaryButton;
import '../widgets/shared_widgets.dart' show AiLoadingView;
import 'ai_tool_ui.dart';
import 'module_flows.dart' show ModuleScaffold;

class ProfileDoctorFlow extends ConsumerStatefulWidget {
  const ProfileDoctorFlow({super.key});
  @override
  ConsumerState<ProfileDoctorFlow> createState() => _ProfileDoctorFlowState();
}

enum _Stage { intro, loading, result, error }

class _ProfileDoctorFlowState extends ConsumerState<ProfileDoctorFlow> {
  _Stage _stage = _Stage.intro;
  final List<File> _shots = [];
  String _goal = 'unsure';
  final _note = TextEditingController();

  List<Map<String, String>>? _images;
  ProfileDoctorResult? _result;
  String? _parentId;
  int _followupsLeft = 0;
  final List<String> _shown = [];
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
      title: 'Profil Doktoru için giriş yap',
      body: 'Günlük ücretsiz hakların hesabına tanımlanır; bu yüzden giriş '
          'yapman gerekiyor. Ücret alınmaz.',
    );
  }

  String? _reasonOf(FirebaseFunctionsException e) {
    final d = e.details;
    return d is Map ? d['reason'] as String? : null;
  }

  Future<void> _run() async {
    if (_shots.isEmpty) return;
    if (!await _ensureSignedIn()) return;
    if (!mounted) return;
    if (!await ensureAiProcessingConsent(context, kind: AiFlowKind.profileReview)) return;
    setState(() {
      _stage = _Stage.loading;
      _error = null;
      _noRetry = false;
    });
    try {
      // Profilde baş kısım (ilk fotoğraf, ilk izlenim) önemli: sınır aşılırsa SONU kesilir.
      final enc = await encodeRizzImages(_shots, keepNewest: false);
      if (enc.truncated) _snack('Profil çok uzun; sonundaki kısım okunmadı.');
      final r = await requestProfileDoctor(
        images: enc.images,
        goal: _goal,
        note: _note.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _images = enc.images;
        _result = r;
        _parentId = r.requestId;
        _followupsLeft = r.requestId != null ? r.followupsLeft : 0;
        _shown
          ..clear()
          ..addAll(r.bios.map((b) => b.text))
          ..addAll(r.prompts.map((p) => p.answer));
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
      final reason = _reasonOf(e);
      if (reason == 'login-required') {
        if (!mounted) return;
        setState(() => _stage = _Stage.intro);
        if (await _ensureSignedIn()) _run();
        return;
      }
      if (!mounted) return;
      setState(() {
        _noRetry = reason == 'quota' || reason == 'attempts' || reason == 'too-long';
        _error = e.code == 'failed-precondition' || e.code == 'resource-exhausted' || e.code == 'unavailable'
            ? (e.message ?? 'Şu an inceleme yapılamıyor.')
            : 'İnceleme şu an yapılamadı. Lütfen biraz sonra tekrar dene.';
        _stage = _Stage.error;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'İnceleme şu an yapılamadı. Lütfen biraz sonra tekrar dene.';
        _stage = _Stage.error;
      });
    }
  }

  /// Yeni bio/prompt önerileri: aynı görüntü, analiz korunur (ücretsiz, en çok 2).
  Future<void> _moreBios() async {
    final images = _images;
    final current = _result;
    if (images == null || current == null || _parentId == null || _followBusy) return;
    if (_followupsLeft <= 0) {
      _snack('Bu profil için ek öneri hakkın doldu. Yeni bir inceleme başlat.');
      return;
    }
    setState(() => _followBusy = true);
    try {
      final r = await requestProfileDoctor(
        images: images,
        goal: _goal,
        note: _note.text.trim(),
        avoid: _shown.reversed.take(12).toList(),
        parentId: _parentId,
        rewrite: true,
      );
      if (!mounted) return;
      if (!r.charged || r.bios.isEmpty) {
        setState(() => _followupsLeft = r.followupsLeft);
        _snack('Bu sefer uygun yeni öneri çıkmadı, tekrar dene. Hakkın düşmedi.');
        return;
      }
      setState(() {
        _result = current.withTexts(r);
        _followupsLeft = r.followupsLeft;
        _shown
          ..addAll(r.bios.map((b) => b.text))
          ..addAll(r.prompts.map((p) => p.answer));
      });
    } on FirebaseFunctionsException catch (e) {
      final reason = _reasonOf(e);
      if (mounted && (reason == 'followup-limit' || reason == 'parent-expired' || reason == 'parent-mismatch')) {
        setState(() => _followupsLeft = 0);
      }
      _snack(e.message ?? 'Öneri şu an üretilemedi.', error: true);
    } catch (_) {
      _snack('Öneri şu an üretilemedi. Lütfen tekrar dene.', error: true);
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
    });
  }

  @override
  Widget build(BuildContext context) {
    return ModuleScaffold(
      title: 'Profil Doktoru',
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 260),
        child: KeyedSubtree(
          key: ValueKey(_stage),
          child: switch (_stage) {
            _Stage.loading => const AiLoadingView(
                steps: ['Profil okunuyor…', 'Fotoğraflar değerlendiriliyor…', 'Yeni bio yazılıyor…'],
                hint: 'Genelde 15-25 saniye sürer',
                progressDuration: Duration(seconds: 22),
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
    return ToolPage(
      bottom: ToolCta(
        label: 'Profilimi İncele',
        onPressed: _shots.isEmpty ? null : _run,
        footnote: 'Günlük ücretsiz hak • Ekran görüntün kaydedilmez',
      ),
      children: [
        const ToolHero(
          icon: Icons.medical_services_outlined,
          title: 'Profilini bir uzman gözüyle incele',
          subtitle: 'Tinder, Bumble ya da Hinge profilinin ekran görüntülerini yükle; neyin işe yaradığını, '
              'neyin eşleşme kaçırdığını söyleyelim.',
          perks: [
            (Icons.photo_library_outlined, 'Fotoğraf sırası'),
            (Icons.build_circle_outlined, 'Öncelikli düzeltmeler'),
            (Icons.edit_note_rounded, '3 yeni bio'),
          ],
        ),
        ToolStep(
          n: 1,
          title: 'Profilinin ekran görüntüleri',
          trailing: _shots.isEmpty ? null : '${_shots.length}/$kRizzMaxImages',
        ),
        ToolShotPicker(
          files: _shots,
          max: kRizzMaxImages,
          onAdd: _pick,
          onRemove: (i) => setState(() => _shots.removeAt(i)),
          emptyTitle: 'Profil ekran görüntüsü ekle',
          emptyHint: 'Fotoğraflar, bio ve prompt\'lar görünsün',
        ),
        const ToolHint(
          icon: Icons.view_day_outlined,
          text: 'Profilini baştan sona ekran görüntüsü al: en fazla $kRizzMaxImages görüntü ya da tek uzun '
              '(kaydırmalı) görüntü.',
        ),
        const ToolStep(n: 2, title: 'Ne arıyorsun?'),
        ToolPills(options: kPdGoals, selected: _goal, onSelect: (g) => setState(() => _goal = g)),
        const ToolStep(n: 3, title: 'Kendinden bahset', trailing: 'İsteğe bağlı'),
        ToolNoteField(
          controller: _note,
          hint: 'İşin, hobilerin, sevdiğin şeyler (bio\'lar yalnız gerçek bilgilerle yazılır)',
        ),
      ],
    );
  }

  // ------------------------------------------------------------ sonuç

  String? _statusMessage(ProfileDoctorResult r) => switch (r.status) {
        'not_a_profile' => 'Bu bir dating profili ekran görüntüsüne benzemiyor. Hakkın düşmedi.',
        'unreadable' => 'Profili okuyamadık. Daha net ekran görüntüleri dene. Hakkın düşmedi.',
        'unsafe_minor' => '18 yaşından küçük biri olabileceği için inceleme yapamıyoruz.',
        'refused' => 'Bu içerik için öneri üretemiyoruz. Hakkın düşmedi.',
        'ok' when !r.charged => 'Uygun bir öneri üretemedik, tekrar dene. Hakkın düşmedi.',
        _ => null,
      };

  /// Teşhis metnini tek parça bildirim için birleştirir (Play AI içerik politikası).
  String _diagnosisText(ProfileDoctorResult r) => [
        if (r.firstImpression.isNotEmpty) r.firstImpression,
        ...r.strengths,
        for (final p in r.photos) '${p.description}: ${p.why}',
        for (final f in r.fixes) f.text,
        if (r.bioFeedback != null) r.bioFeedback!,
      ].join(' | ');

  Widget _resultView() {
    final r = _result!;
    final msg = _statusMessage(r);
    var k = 0;
    Widget fx(Widget w) => ToolFadeIn(index: k++, child: w);
    final hasDiagnosis = r.firstImpression.isNotEmpty || r.photos.isNotEmpty || r.fixes.isNotEmpty;
    return ToolPage(
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          PrimaryButton(label: 'Yeni İnceleme', onPressed: _reset),
          if (r.freeLeft != null && r.dailyFree != null) ...[
            const SizedBox(height: 8),
            ToolQuotaLine(left: r.freeLeft!, total: r.dailyFree!),
          ],
        ],
      ),
      children: [
        const SizedBox(height: 4),
        if (msg != null) fx(ToolNotice(icon: Icons.info_outline_rounded, text: msg)),
        if (r.firstImpression.isNotEmpty) fx(_impressionCard(r)),
        if (r.fixes.isNotEmpty) ...[
          fx(const ToolSectionHeader(icon: Icons.build_circle_outlined, title: 'Önce bunları düzelt')),
          fx(_fixesCard(r.fixes)),
        ],
        if (r.photos.isNotEmpty) ...[
          fx(const ToolSectionHeader(icon: Icons.photo_library_outlined, title: 'Fotoğrafların')),
          for (int i = 0; i < r.photos.length; i++) fx(_photoRow(i + 1, r.photos[i])),
        ],
        if (r.missingPhotos.isNotEmpty) fx(_missingCard(r.missingPhotos)),
        if (r.bioFeedback != null)
          fx(ToolNotice(icon: Icons.short_text_rounded, title: 'ŞU ANKİ BİO', text: r.bioFeedback!)),
        if (hasDiagnosis)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => _report(_diagnosisText(r), diagnosis: true),
              icon: const Icon(Icons.outlined_flag_rounded, size: 15, color: AppColors.textMuted),
              label: const Text('Bu değerlendirmeyi bildir', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
          ),
        if (r.bios.isNotEmpty) ...[
          fx(const ToolSectionHeader(
            icon: Icons.edit_note_rounded,
            title: 'Yeni bio önerileri',
            trailing: Text('Dokun, kopyala', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          )),
          for (final b in r.bios)
            ToolFadeIn(
              key: ValueKey('bio:${b.text}'),
              index: k++,
              child: ToolCopyCard(
                badge: kPdStyles[b.style] ?? b.style,
                text: b.text,
                why: b.why,
                onReport: () => _report(b.text),
              ),
            ),
        ],
        if (r.prompts.isNotEmpty) ...[
          fx(const ToolSectionHeader(icon: Icons.question_answer_outlined, title: 'Prompt cevapları')),
          for (final p in r.prompts)
            ToolFadeIn(
              key: ValueKey('prompt:${p.answer}'),
              index: k++,
              child: ToolCopyCard(question: p.question, text: p.answer, onReport: () => _report(p.answer)),
            ),
        ],
        if (r.tip != null)
          fx(ToolNotice(icon: Icons.lightbulb_outline_rounded, title: 'İPUCU', text: r.tip!, kind: ToolNoticeKind.tip)),
        if (_parentId != null && (_followupsLeft > 0 || r.bios.isNotEmpty))
          fx(Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 8),
            child: ToolSecondaryButton(
              label: _followupsLeft <= 0
                  ? 'Ek öneri hakkı doldu'
                  : r.bios.isEmpty
                      ? 'Bio önerisi üret ($_followupsLeft)'
                      : 'Yeni bio önerileri ($_followupsLeft)',
              icon: Icons.autorenew_rounded,
              busy: _followBusy,
              onPressed: _followBusy || _followupsLeft <= 0 ? null : _moreBios,
            ),
          )),
      ],
    );
  }

  /// İlk izlenim + iyi giden yanlar (sonucun en üstündeki özet kart).
  Widget _impressionCard(ProfileDoctorResult r) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0x2EFF2D55), AppColors.surface],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: kToolAccentBorder, width: 0.8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Row(
            children: [
              ToolIconBadge(icon: Icons.visibility_outlined, size: 34),
              SizedBox(width: 10),
              Text('İLK İZLENİM',
                  style: TextStyle(
                      fontSize: 12, fontWeight: FontWeight.w900, letterSpacing: 0.8, color: AppColors.gold)),
            ],
          ),
          const SizedBox(height: 12),
          Text(r.firstImpression,
              style: const TextStyle(
                  fontSize: 15.5, fontWeight: FontWeight.w600, height: 1.45, color: AppColors.textPrimary)),
          if (r.strengths.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Divider(height: 1, color: AppColors.borderSubtle),
            const SizedBox(height: 12),
            const Text('İyi giden',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
            const SizedBox(height: 8),
            for (final s in r.strengths)
              Padding(
                padding: const EdgeInsets.only(bottom: 7),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.check_circle_rounded, size: 17, color: AppColors.success),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(s, style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.4)),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  /// Öncelik sırasına göre numaralı düzeltmeler (tek kart, aralarında ayraç).
  Widget _fixesCard(List<PdFix> fixes) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        children: [
          for (int i = 0; i < fixes.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 52, color: AppColors.borderSubtle),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 26,
                    height: 26,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      gradient: i == 0 ? AppColors.goldGradient : null,
                      color: i == 0 ? null : AppColors.surfaceHighest,
                      shape: BoxShape.circle,
                    ),
                    child: Text('${i + 1}',
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w900,
                            color: i == 0 ? AppColors.textOnGold : AppColors.textPrimary)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        ToolChip(kPdAreas[fixes[i].area] ?? fixes[i].area, color: AppColors.textSecondary),
                        const SizedBox(height: 6),
                        Text(fixes[i].text,
                            style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.42)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _photoRow(int n, PdPhoto p) {
    final (color, icon) = switch (p.verdict) {
      'lead' => (AppColors.gold, Icons.vertical_align_top_rounded),
      'drop' => (AppColors.error, Icons.remove_circle_outline_rounded),
      'retake' => (AppColors.warning, Icons.photo_camera_outlined),
      _ => (AppColors.success, Icons.check_circle_outline_rounded),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: p.verdict == 'lead' ? kToolAccentBorder : AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(width: 4, color: color),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text('#$n',
                            style: const TextStyle(
                                fontSize: 12, fontWeight: FontWeight.w900, color: AppColors.textMuted)),
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                              color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(8)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(icon, size: 13, color: color),
                              const SizedBox(width: 4),
                              Text(kPdVerdicts[p.verdict] ?? p.verdict,
                                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: color)),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(p.description,
                        style: const TextStyle(
                            fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.textPrimary, height: 1.35)),
                    if (p.why.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(p.why, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.4)),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _missingCard(List<String> missing) {
    // Kadraj/giyim/mekân türleri AI ile üretilebilir; yaşam tarzı türleri (arkadaş, evcil hayvan, hobi)
    // gerçek fotoğraf ister — sahip olunmayan bir yaşamı üretmek yanıltma olur (kullanım koşulları).
    final ai = missing.where((m) => !kPdLifestyle.contains(m)).toList();
    final real = missing.where(kPdLifestyle.contains).toList();
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0x26FF2D55), Color(0x0AFF2D55)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: kToolAccentBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Row(
            children: [
              ToolIconBadge(icon: Icons.add_a_photo_outlined, size: 34),
              SizedBox(width: 10),
              Expanded(
                child: Text('Profilinde eksik olan fotoğraflar',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [for (final m in missing) ToolChip(kPdMissing[m] ?? m)],
          ),
          if (real.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              '${real.map((m) => kPdMissing[m] ?? m).join(', ')}: bunun için gerçek bir fotoğrafını ekle; '
              'gerçek hayatından bir an en iyi sohbeti açar.',
              style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.4),
            ),
          ],
          const SizedBox(height: 14),
          if (ai.isNotEmpty) ...[
            PrimaryButton(
              label: 'AI ile Fotoğraf Üret',
              onPressed: () => context.push('${DatingRoutes.module}/${DatingModule.aiPhoto.id}'),
            ),
            const SizedBox(height: 6),
            Text(
              'Üretilebilecekler: ${ai.map((m) => kPdMissing[m] ?? m).join(', ')}',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
            ),
          ],
          TextButton.icon(
            onPressed: () => context.push('${DatingRoutes.module}/${DatingModule.photoAnalysis.id}'),
            icon: const Icon(Icons.insights_rounded, size: 17, color: AppColors.gold),
            label: const Text('Elindeki fotoğrafları puanlat',
                style: TextStyle(color: AppColors.gold, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }

  Future<void> _report(String text, {bool diagnosis = false}) async {
    final reasons = diagnosis
        ? const {
            'unfair': 'Görünüşümle ilgili ya da haksız yorum',
            'offensive': 'Kırıcı ya da saldırgan',
            'bad_quality': 'Yanlış / anlamsız',
            'other': 'Diğer',
          }
        : const {
            'offensive': 'Kırıcı ya da saldırgan',
            'sexual': 'Cinsel / uygunsuz',
            'bad_quality': 'Kötü / anlamsız / uydurma',
            'other': 'Diğer',
          };
    final reason = await showToolReportSheet(
      context,
      title: diagnosis ? 'Bu değerlendirmeyi neden bildiriyorsun?' : 'Bu öneriyi neden bildiriyorsun?',
      reasons: reasons,
    );
    if (reason == null) return;
    try {
      await reportRizzReply(text: text, reason: reason, requestId: _parentId, feature: 'profileDoctor');
      _snack('Teşekkürler, bildirimin alındı.');
    } catch (_) {
      _snack('Bildirim gönderilemedi. Lütfen tekrar dene.', error: true);
    }
  }
}
