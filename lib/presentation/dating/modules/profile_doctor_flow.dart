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
import 'package:flutter/services.dart';
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
      body: switch (_stage) {
        _Stage.loading => const AiLoadingView(
            steps: ['Profil okunuyor…', 'Fotoğraflar değerlendiriliyor…', 'Yeni bio yazılıyor…'],
            hint: 'Genelde 15-25 saniye sürer',
            progressDuration: Duration(seconds: 22),
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
        const Text('Profilinin ekran görüntüleri',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
        const SizedBox(height: 4),
        const Text(
          'Tinder, Bumble ya da Hinge\'deki profilini baştan sona ekran görüntüsü al: fotoğraflar, bio ve '
          'prompt\'lar görünsün. En fazla $kRizzMaxImages görüntü ya da tek uzun (kaydırmalı) görüntü.',
          style: TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.4),
        ),
        const SizedBox(height: 12),
        _shotsRow(),
        const SizedBox(height: 20),
        const Text('Ne arıyorsun?',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final e in kPdGoals.entries)
              ChoiceChip(
                label: Text(e.value),
                selected: _goal == e.key,
                onSelected: (_) => setState(() => _goal = e.key),
                selectedColor: AppColors.gold,
                backgroundColor: AppColors.surface,
                labelStyle: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                  color: _goal == e.key ? Colors.black : AppColors.textSecondary,
                ),
                side: BorderSide(color: _goal == e.key ? AppColors.gold : AppColors.borderSubtle),
                showCheckmark: false,
              ),
          ],
        ),
        const SizedBox(height: 18),
        TextField(
          controller: _note,
          maxLength: 300,
          maxLines: 2,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
          decoration: InputDecoration(
            hintText: 'İsteğe bağlı: işin, hobilerin, sevdiğin şeyler (bio\'lar yalnız gerçek bilgilerle yazılır)',
            hintStyle: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            filled: true,
            fillColor: AppColors.surface,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
          ),
        ),
        const SizedBox(height: 8),
        PrimaryButton(label: 'Profilimi İncele', onPressed: _shots.isEmpty ? null : _run),
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
                    Text(_shots.isEmpty ? 'Profil ekran görüntüsü ekle' : 'Ekle',
                        style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                  ],
                ),
              ),
            ),
        ],
      ),
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

  Widget _section(String title, {IconData? icon}) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 10),
        child: Row(
          children: [
            if (icon != null) ...[Icon(icon, size: 19, color: AppColors.gold), const SizedBox(width: 8)],
            Flexible(
              child: Text(title,
                  maxLines: 2,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
            ),
          ],
        ),
      );

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
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      children: [
        if (msg != null) _infoCard(Icons.info_outline_rounded, msg),
        if (r.firstImpression.isNotEmpty) _infoCard(Icons.visibility_outlined, 'İlk izlenim: ${r.firstImpression}', gold: true),
        if (r.strengths.isNotEmpty) ...[
          _section('İyi giden', icon: Icons.thumb_up_alt_outlined),
          for (final s in r.strengths) _bullet(s, Icons.check_circle_outline_rounded, AppColors.success),
          const SizedBox(height: 6),
        ],
        if (r.fixes.isNotEmpty) ...[
          _section('Önce bunları düzelt', icon: Icons.build_circle_outlined),
          for (int i = 0; i < r.fixes.length; i++) _fixRow(i + 1, r.fixes[i]),
          const SizedBox(height: 6),
        ],
        if (r.photos.isNotEmpty) ...[
          _section('Fotoğrafların', icon: Icons.photo_library_outlined),
          for (final p in r.photos) _photoRow(p),
          const SizedBox(height: 6),
        ],
        if (r.missingPhotos.isNotEmpty) _missingCard(r.missingPhotos),
        if (r.bioFeedback != null) _infoCard(Icons.short_text_rounded, 'Şu anki bio: ${r.bioFeedback!}'),
        if (r.firstImpression.isNotEmpty || r.photos.isNotEmpty || r.fixes.isNotEmpty)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => _report(_diagnosisText(r), diagnosis: true),
              icon: const Icon(Icons.outlined_flag_rounded, size: 16, color: AppColors.textMuted),
              label: const Text('Bu değerlendirmeyi bildir', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
          ),
        if (r.bios.isNotEmpty) ...[
          Row(
            children: [
              Expanded(child: _section('Yeni bio önerileri', icon: Icons.edit_note_rounded)),
              const Text('Dokun, kopyala', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ],
          ),
          for (final b in r.bios) _textCard(badge: kPdStyles[b.style] ?? b.style, text: b.text, why: b.why),
        ],
        if (r.prompts.isNotEmpty) ...[
          _section('Prompt cevapları', icon: Icons.question_answer_outlined),
          for (final p in r.prompts) _textCard(badge: p.question, text: p.answer, why: ''),
        ],
        if (r.tip != null) _infoCard(Icons.lightbulb_outline_rounded, r.tip!, gold: true),
        if (_parentId != null && (_followupsLeft > 0 || r.bios.isNotEmpty)) ...[
          const SizedBox(height: 4),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _followBusy || _followupsLeft <= 0 ? null : _moreBios,
              icon: _followBusy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.gold))
                  : const Icon(Icons.autorenew_rounded),
              label: Text(_followupsLeft <= 0
                  ? 'Ek öneri hakkı doldu'
                  : r.bios.isEmpty
                      ? 'Bio önerisi üret ($_followupsLeft)'
                      : 'Yeni bio önerileri ($_followupsLeft)'),
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
        PrimaryButton(label: 'Yeni İnceleme', onPressed: _reset),
        if (r.freeLeft != null && r.dailyFree != null) ...[
          const SizedBox(height: 10),
          Center(
            child: Text('Bugün kalan ücretsiz hak: ${r.freeLeft}/${r.dailyFree}',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
        ],
      ],
    );
  }

  Widget _bullet(String text, IconData icon, Color color) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 8),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.4))),
          ],
        ),
      );

  Widget _chip(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(8)),
        child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: color)),
      );

  Widget _fixRow(int n, PdFix f) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 12,
              backgroundColor: AppColors.gold,
              child: Text('$n', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900, color: Colors.white)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _chip(kPdAreas[f.area] ?? f.area, AppColors.textSecondary),
                  const SizedBox(height: 6),
                  Text(f.text, style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.4)),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _photoRow(PdPhoto p) {
    final color = switch (p.verdict) {
      'lead' => AppColors.gold,
      'drop' => AppColors.error,
      'retake' => AppColors.warning,
      _ => AppColors.success,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.verdict == 'lead' ? AppColors.borderGold : AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _chip(kPdVerdicts[p.verdict] ?? p.verdict, color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(p.description,
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
              ),
            ],
          ),
          if (p.why.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(p.why, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.35)),
          ],
        ],
      ),
    );
  }

  Widget _missingCard(List<String> missing) {
    // Kadraj/giyim/mekân türleri AI ile üretilebilir; yaşam tarzı türleri (arkadaş, evcil hayvan, hobi)
    // gerçek fotoğraf ister — sahip olunmayan bir yaşamı üretmek yanıltma olur (kullanım koşulları).
    final ai = missing.where((m) => !kPdLifestyle.contains(m)).toList();
    final real = missing.where(kPdLifestyle.contains).toList();
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.gold.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderGold),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Profilinde eksik olan fotoğraflar',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [for (final m in missing) _chip(kPdMissing[m] ?? m, AppColors.gold)],
          ),
          if (real.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              '${real.map((m) => kPdMissing[m] ?? m).join(', ')}: bunun için gerçek bir fotoğrafını ekle; '
              'gerçek hayatından bir an en iyi sohbeti açar.',
              style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.4),
            ),
          ],
          const SizedBox(height: 12),
          if (ai.isNotEmpty)
            PrimaryButton(
              label: 'AI ile Fotoğraf Üret (${ai.map((m) => kPdMissing[m] ?? m).join(', ')})',
              onPressed: () => context.push('${DatingRoutes.module}/${DatingModule.aiPhoto.id}'),
            ),
          const SizedBox(height: 4),
          TextButton(
            onPressed: () => context.push('${DatingRoutes.module}/${DatingModule.photoAnalysis.id}'),
            child: const Text('Elindeki fotoğrafları puanlat', style: TextStyle(color: AppColors.gold)),
          ),
        ],
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

  Widget _textCard({required String badge, required String text, required String why}) {
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
          await Clipboard.setData(ClipboardData(text: text));
          HapticFeedback.lightImpact();
          _snack('Kopyalandı — profiline yapıştırabilirsin');
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
                    _chip(badge, AppColors.gold),
                    const SizedBox(height: 8),
                    Text(text, style: const TextStyle(fontSize: 15, color: AppColors.textPrimary, height: 1.4)),
                    if (why.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(why, style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.3)),
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
                    onPressed: () => _report(text),
                  ),
                ],
              ),
            ],
          ),
        ),
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
      await reportRizzReply(text: text, reason: reason, requestId: _parentId, feature: 'profileDoctor');
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
          Icon(_noRetry ? Icons.hourglass_bottom_rounded : Icons.error_outline_rounded, size: 46, color: AppColors.gold),
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
