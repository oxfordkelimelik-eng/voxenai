// SOHBET RÖNTGENİ KARTI (2026-11-22) — RizzGPT sonucunda, aynı çağrıdan (functions/rizz.js insight).
// Yalnız ekrandaki davranıştan: karşı tarafın ilgisi, emek dengesi, olumlu/olumsuz işaretler, sıradaki adım.
// Kesin hüküm değil, tahmin olduğu kartta yazar. 2026-11-23: ortak tasarım dili (ai_tool_ui.dart).

import 'package:flutter/material.dart';

import '../../../core/constants/app_colors.dart';
import '../rizz_service.dart';
import 'ai_tool_ui.dart' show ToolFitText, ToolIconBadge, kToolAccentBorder;

class ChatXrayCard extends StatefulWidget {
  final RizzInsight insight;

  /// Değerlendirmeyi bildir (Play AI içerik politikası). Metin: özet + işaretler.
  final ValueChanged<String>? onReport;
  const ChatXrayCard({super.key, required this.insight, this.onReport});

  @override
  State<ChatXrayCard> createState() => _ChatXrayCardState();
}

class _ChatXrayCardState extends State<ChatXrayCard> {
  // 2026-11-23 sadeleştirme: varsayılan KAPALI; başlıkta tek satırlık özet (ilgi + sıradaki adım).
  bool _open = false;

  static const _interest = {'low': 'Düşük', 'medium': 'Orta', 'high': 'Yüksek'};
  static const _investment = {
    'user_more': 'Sen daha çok çabalıyorsun',
    'balanced': 'Dengeli — ikiniz de çabalıyorsunuz',
    'match_more': 'O daha çok çabalıyor',
  };
  // Emek göstergesindeki nokta: -1 Sen tarafı, 0 orta, 1 O tarafı.
  static const _investmentPos = {'user_more': -1.0, 'balanced': 0.0, 'match_more': 1.0};
  static const _next = {
    'ask_out': ('Buluşma teklif etmenin tam zamanı', Icons.event_available_rounded),
    'keep_building': ('Sohbeti biraz daha derinleştir', Icons.forum_outlined),
    'slow_down': ('Biraz yavaşla, ona alan bırak', Icons.slow_motion_video_rounded),
    'give_space': ('Alan tanı, ısrar etme', Icons.pause_circle_outline_rounded),
    'revive': ('Sohbeti yeni bir konuyla canlandır', Icons.local_fire_department_outlined),
  };
  // Kapalı kartın başlığındaki tek satırlık özet için kısa adlar (uzun cümle kesik görünüyordu).
  static const _nextShort = {
    'ask_out': 'Buluşma teklif et',
    'keep_building': 'Sohbeti derinleştir',
    'slow_down': 'Biraz yavaşla',
    'give_space': 'Alan tanı',
    'revive': 'Sohbeti canlandır',
  };

  @override
  Widget build(BuildContext context) {
    final i = widget.insight;
    final level = switch (i.interest) { 'low' => 1, 'medium' => 2, 'high' => 3, _ => 0 };
    final next = _next[i.nextStep];
    // Risk dışında gösterilecek bir şey var mı (yoksa aç/kapa düğmesi anlamsız).
    final hasBody = level > 0 ||
        _investment[i.investment] != null ||
        i.greenFlags.isNotEmpty ||
        i.redFlags.isNotEmpty ||
        next != null ||
        i.summary != null;
    final open = _open && hasBody;
    final summary = [
      if (level > 0) 'İlgi: ${_interest[i.interest]}',
      ?_nextShort[i.nextStep],
    ].join(' • ');
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: hasBody ? () => setState(() => _open = !_open) : null,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 12, 12),
              child: Row(
                children: [
                  const ToolIconBadge(icon: Icons.radar_rounded, size: 32),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Sohbet Röntgeni',
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
                        const SizedBox(height: 2),
                        ToolFitText(summary.isEmpty ? 'Sohbet nasıl gidiyor?' : summary,
                            style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
                      ],
                    ),
                  ),
                  if (hasBody)
                    AnimatedRotation(
                      turns: _open ? 0.5 : 0,
                      duration: const Duration(milliseconds: 200),
                      child: const Icon(Icons.expand_more_rounded, color: AppColors.textMuted),
                    ),
                ],
              ),
            ),
          ),
          // Risk sinyali kart kapalıyken de görünür (güvenlik bilgisi).
          if (i.risk != null) Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 12), child: _riskBox(i.risk!)),
          AnimatedSize(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
            alignment: Alignment.topCenter,
            child: !open
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (level > 0 || _investment[i.investment] != null)
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (level > 0) Expanded(child: _interestTile(level, i.interest)),
                              if (level > 0 && _investment[i.investment] != null) const SizedBox(width: 10),
                              if (_investment[i.investment] != null) Expanded(child: _investmentTile(i.investment)),
                            ],
                          ),
                        if (i.greenFlags.isNotEmpty || i.redFlags.isNotEmpty) ...[
                          const SizedBox(height: 14),
                          for (final f in i.greenFlags) _flag(f, good: true),
                          for (final f in i.redFlags) _flag(f, good: false),
                        ],
                        if (next != null) ...[
                          const SizedBox(height: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                            decoration: BoxDecoration(
                              gradient: const LinearGradient(
                                colors: [Color(0x33FF2D55), Color(0x0FFF2D55)],
                                begin: Alignment.centerLeft,
                                end: Alignment.centerRight,
                              ),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: kToolAccentBorder),
                            ),
                            child: Row(
                              children: [
                                Icon(next.$2, size: 20, color: AppColors.gold),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text('SIRADAKİ ADIM',
                                          style: TextStyle(
                                              fontSize: 10.5,
                                              fontWeight: FontWeight.w900,
                                              letterSpacing: 0.6,
                                              color: AppColors.gold)),
                                      const SizedBox(height: 2),
                                      Text(next.$1,
                                          style: const TextStyle(
                                              fontSize: 13.5, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                        if (i.summary != null) ...[
                          const SizedBox(height: 12),
                          Text(i.summary!,
                              style: const TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.45)),
                        ],
                      ],
                    ),
                  ),
          ),
          // Açıklama + bildir HER ZAMAN görünür (kart kapalıyken risk kutusu görünürken de itiraz edilebilsin).
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 2, 4, 6),
            child: Row(
              children: [
                const Icon(Icons.info_outline_rounded, size: 13, color: AppColors.textMuted),
                const SizedBox(width: 6),
                const Expanded(
                  child: Text('Ekrandaki mesajlara dayalı tahmin, kesin hüküm değil.',
                      style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                ),
                if (widget.onReport != null)
                  IconButton(
                    tooltip: 'Bildir',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.outlined_flag_rounded, color: AppColors.textMuted, size: 18),
                    // Bildirimde risk notu (karşı tarafın yazdıklarını anlatan serbest metin) gönderilmez; yalnız
                    // seviye ve sinyal anahtarları (gizlilik metni: bildirilen değerlendirme metni saklanır).
                    onPressed: () => widget.onReport!(
                      [
                        'ilgi=${i.interest} emek=${i.investment} adım=${i.nextStep}',
                        if (i.summary != null) i.summary!,
                        ...i.greenFlags,
                        ...i.redFlags,
                        if (i.risk != null) 'risk=${i.risk!.level}:${i.risk!.signals.join('+')}',
                      ].join(' | '),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _tile({required String label, required Widget child}) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
            const SizedBox(height: 8),
            child,
          ],
        ),
      );

  Widget _interestTile(int level, String interest) {
    return _tile(
      label: 'İlgi seviyesi',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_interest[interest] ?? '',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
          const SizedBox(height: 8),
          Row(
            children: [
              for (int k = 1; k <= 3; k++) ...[
                Expanded(
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: k <= level ? 1 : 0),
                    duration: Duration(milliseconds: 300 + 150 * k),
                    curve: Curves.easeOut,
                    builder: (_, v, _) => Container(
                      height: 6,
                      decoration: BoxDecoration(
                        color: Color.lerp(AppColors.surfaceHighest, AppColors.gold, v),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                  ),
                ),
                if (k < 3) const SizedBox(width: 4),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _investmentTile(String investment) {
    final pos = _investmentPos[investment] ?? 0;
    return _tile(
      label: 'Emek dengesi',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(_investment[investment]!,
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.textPrimary, height: 1.3)),
          const SizedBox(height: 8),
          SizedBox(
            height: 12,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(
                  height: 4,
                  decoration: BoxDecoration(color: AppColors.surfaceHighest, borderRadius: BorderRadius.circular(2)),
                ),
                Align(
                  alignment: Alignment(pos * 0.95, 0),
                  child: Container(
                    width: 12,
                    height: 12,
                    decoration: const BoxDecoration(
                      color: AppColors.gold,
                      shape: BoxShape.circle,
                      boxShadow: [BoxShadow(color: AppColors.goldGlow, blurRadius: 6)],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          const Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Sen', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
              Text('O', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _riskBox(RizzRisk r) {
    final high = r.level == 'high';
    final color = high ? AppColors.error : AppColors.warning;
    final title = switch (r.level) {
      'high' => 'Dikkat: dolandırıcılık işareti olabilir',
      'medium' => 'Dikkatli ol: birkaç risk işareti var',
      _ => 'Küçük bir risk işareti',
    };
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(color: color.withValues(alpha: 0.18), shape: BoxShape.circle),
                child: Icon(high ? Icons.gpp_maybe_rounded : Icons.shield_outlined, size: 17, color: color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(title, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w900, color: color)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          for (final s in r.signals)
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Container(width: 5, height: 5, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(kRizzRiskSignals[s] ?? s,
                        style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.35)),
                  ),
                ],
              ),
            ),
          if (r.note != null) ...[
            const SizedBox(height: 4),
            Text(r.note!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.4)),
          ],
          if (high || r.level == 'medium') ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.background.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                r.signals.contains('sextortion')
                    // Şantajda görüntülü görüşme önerilmez (kayıt genelde orada alınır).
                    ? 'Mahrem fotoğraf ya da video gönderme. Tehdit edilirsen ödeme yapma, mesajların ekran '
                        'görüntüsünü alıp sakla, eşleştiğin uygulamanın (Tinder, Bumble vb.) şikâyet/engelle '
                        'özelliğiyle bildir ve polise başvur (155).'
                    : 'Para, kod, kimlik ya da kart bilgisi asla gönderme; görüntülü görüşme iste. Şüphelenirsen '
                        'eşleştiğin uygulamanın (Tinder, Bumble vb.) şikâyet/engelle özelliğiyle bildir. Para '
                        'kaybettiysen hemen bankanı ve 155\'i ara.',
                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.45),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _flag(String text, {required bool good}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(good ? Icons.check_circle_rounded : Icons.error_rounded,
              size: 17, color: good ? AppColors.success : AppColors.warning),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.4))),
        ],
      ),
    );
  }
}
