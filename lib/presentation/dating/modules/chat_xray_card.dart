// SOHBET RÖNTGENİ KARTI (2026-11-22) — RizzGPT sonucunda, aynı çağrıdan (functions/rizz.js insight).
// Yalnız ekrandaki davranıştan: karşı tarafın ilgisi, emek dengesi, olumlu/olumsuz işaretler, sıradaki adım.
// Kesin hüküm değil, tahmin olduğu kartta yazar.

import 'package:flutter/material.dart';

import '../../../core/constants/app_colors.dart';
import '../rizz_service.dart';

class ChatXrayCard extends StatefulWidget {
  final RizzInsight insight;

  /// Değerlendirmeyi bildir (Play AI içerik politikası). Metin: özet + işaretler.
  final ValueChanged<String>? onReport;
  const ChatXrayCard({super.key, required this.insight, this.onReport});

  @override
  State<ChatXrayCard> createState() => _ChatXrayCardState();
}

class _ChatXrayCardState extends State<ChatXrayCard> {
  bool _open = true;

  static const _interest = {'low': 'Düşük', 'medium': 'Orta', 'high': 'Yüksek'};
  static const _investment = {
    'user_more': 'Sen daha çok çabalıyorsun',
    'balanced': 'Dengeli — ikiniz de çabalıyorsunuz',
    'match_more': 'O daha çok çabalıyor',
  };
  static const _next = {
    'ask_out': ('Buluşma teklif etmenin tam zamanı', Icons.event_available_rounded),
    'keep_building': ('Sohbeti biraz daha derinleştir', Icons.forum_outlined),
    'slow_down': ('Biraz yavaşla, ona alan bırak', Icons.slow_motion_video_rounded),
    'give_space': ('Alan tanı, ısrar etme', Icons.pause_circle_outline_rounded),
    'revive': ('Sohbeti yeni bir konuyla canlandır', Icons.local_fire_department_outlined),
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
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: hasBody ? () => setState(() => _open = !_open) : null,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
              child: Row(
                children: [
                  const Icon(Icons.radar_rounded, size: 20, color: AppColors.gold),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text('Sohbet Röntgeni',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: AppColors.textPrimary)),
                  ),
                  if (hasBody)
                    Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: AppColors.textMuted),
                ],
              ),
            ),
          ),
          // Risk sinyali kart kapalıyken de görünür (güvenlik bilgisi).
          if (i.risk != null) Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 12), child: _riskBox(i.risk!)),
          if (open)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (level > 0) ...[
                    _label('İlgi seviyesi'),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        for (int k = 1; k <= 3; k++) ...[
                          Expanded(
                            child: Container(
                              height: 7,
                              decoration: BoxDecoration(
                                color: k <= level ? AppColors.gold : AppColors.surfaceElevated,
                                borderRadius: BorderRadius.circular(4),
                              ),
                            ),
                          ),
                          if (k < 3) const SizedBox(width: 4),
                        ],
                        const SizedBox(width: 10),
                        Text(_interest[i.interest] ?? '',
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (_investment[i.investment] != null) ...[
                    _label('Emek dengesi'),
                    const SizedBox(height: 4),
                    Text(_investment[i.investment]!,
                        style: const TextStyle(fontSize: 13.5, color: AppColors.textPrimary, height: 1.35)),
                    const SizedBox(height: 12),
                  ],
                  for (final f in i.greenFlags) _flag(f, good: true),
                  for (final f in i.redFlags) _flag(f, good: false),
                  if (i.greenFlags.isNotEmpty || i.redFlags.isNotEmpty) const SizedBox(height: 8),
                  if (next != null)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: AppColors.gold.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.borderGold),
                      ),
                      child: Row(
                        children: [
                          Icon(next.$2, size: 18, color: AppColors.gold),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text('Sıradaki adım: ${next.$1}',
                                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                          ),
                        ],
                      ),
                    ),
                  if (i.summary != null) ...[
                    const SizedBox(height: 10),
                    Text(i.summary!, style: const TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.4)),
                  ],
                ],
              ),
            ),
          // Açıklama + bildir HER ZAMAN görünür (kart kapalıyken risk kutusu görünürken de itiraz edilebilsin).
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 4, 6),
            child: Row(
              children: [
                const Expanded(
                  child: Text('Yalnız ekrandaki mesajlara dayanan bir tahmin; kesin hüküm değil.',
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

  Widget _riskBox(RizzRisk r) {
    final high = r.level == 'high';
    final color = high ? AppColors.error : AppColors.warning;
    final title = switch (r.level) {
      'high' => 'Dikkat: dolandırıcılık işareti olabilir',
      'medium' => 'Dikkatli ol: birkaç risk işareti var',
      _ => 'Küçük bir risk işareti',
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(high ? Icons.gpp_maybe_rounded : Icons.shield_outlined, size: 19, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(title, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w900, color: color)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final s in r.signals)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text('• ${kRizzRiskSignals[s] ?? s}',
                  style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.35)),
            ),
          if (r.note != null) ...[
            const SizedBox(height: 4),
            Text(r.note!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.4)),
          ],
          if (high || r.level == 'medium') ...[
            const SizedBox(height: 8),
            Text(
              r.signals.contains('sextortion')
                  // Şantajda görüntülü görüşme önerilmez (kayıt genelde orada alınır).
                  ? 'Mahrem fotoğraf ya da video gönderme. Tehdit edilirsen ödeme yapma, mesajların ekran '
                      'görüntüsünü alıp sakla, eşleştiğin uygulamanın (Tinder, Bumble vb.) şikâyet/engelle '
                      'özelliğiyle bildir ve polise başvur (155).'
                  : 'Para, kod, kimlik ya da kart bilgisi asla gönderme; görüntülü görüşme iste. Şüphelenirsen '
                      'eşleştiğin uygulamanın (Tinder, Bumble vb.) şikâyet/engelle özelliğiyle bildir. Para '
                      'kaybettiysen hemen bankanı ve 155\'i ara.',
              style: const TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.4),
            ),
          ],
        ],
      ),
    );
  }

  Widget _label(String t) => Text(t,
      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: AppColors.textSecondary));

  Widget _flag(String text, {required bool good}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(good ? Icons.check_circle_outline_rounded : Icons.error_outline_rounded,
              size: 17, color: good ? AppColors.success : AppColors.warning),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.35))),
        ],
      ),
    );
  }
}
