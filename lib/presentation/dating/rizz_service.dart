// RIZZGPT İSTEMCİ SERVİSİ (2026-11-22). Sunucu: functions/rizz.js (rizzReply / rizzReport).
//
// Ekran görüntüleri cihazda JPEG'e küçültülüp (uzun kenar ≤ 2048, iOS ekran görüntüsü PNG'si birkaç MB)
// base64 olarak gönderilir; hiçbir yere yüklenmez. Prompt ve hak denetimi sunucudadır.
// Uzun (kaydırmalı) ekran görüntüsü tek parça küçültülürse yazı okunmaz (OpenAI da 2048 kareye sığdırır):
// en/boy > 2.6 ise genişlik korunarak üst üste binen dikey parçalara bölünür (toplam ≤ kRizzMaxParts).

import 'dart:convert';
import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

const _region = 'europe-west1';
const kRizzMaxImages = 3;

/// Sunucuya giden en çok parça (functions/rizz.js MAX_IMAGES ile aynı).
const kRizzMaxParts = 6;

/// Görsel çözülemedi (ör. HEIC/AVIF) — kullanıcıya anlaşılır mesaj gösterilir.
class RizzImageException implements Exception {
  const RizzImageException();
}

/// Kodlanmış görseller; [truncated] = parça sınırı yüzünden en eski kısım gönderilmedi.
class RizzImages {
  final List<Map<String, String>> images;
  final bool truncated;
  const RizzImages(this.images, this.truncated);
}

/// Ton anahtarı (sunucu enum'u) → etiket.
const Map<String, String> kRizzTones = {
  'auto': 'Otomatik',
  'playful': 'Esprili',
  'flirty': 'Flörtöz',
  'warm': 'Samimi',
  'bold': 'Cesur',
};

class RizzReply {
  final String text;
  final String tone;
  final String move;
  final String why;
  const RizzReply(this.text, this.tone, this.move, this.why);
}

class RizzMessage {
  final String speaker; // user | match | unknown
  final String text;
  const RizzMessage(this.speaker, this.text);
}

/// Sohbet Röntgeni: yalnız ekrandaki davranıştan ilgi, emek dengesi, işaretler, sıradaki adım.
class RizzInsight {
  final String interest; // low | medium | high | unclear
  final String investment; // user_more | balanced | match_more | unclear
  final List<String> greenFlags;
  final List<String> redFlags;
  final String nextStep; // ask_out | keep_building | slow_down | give_space | revive | unclear
  final String? summary;
  final RizzRisk? risk;
  const RizzInsight(this.interest, this.investment, this.greenFlags, this.redFlags, this.nextStep, this.summary, this.risk);

  static RizzInsight? fromJson(dynamic v) {
    if (v is! Map) return null;
    List<String> strs(dynamic x) => x is List ? x.whereType<String>().toList() : const [];
    return RizzInsight(
      (v['interest'] as String?) ?? 'unclear',
      (v['investment'] as String?) ?? 'unclear',
      strs(v['greenFlags']),
      strs(v['redFlags']),
      (v['nextStep'] as String?) ?? 'unclear',
      v['summary'] as String?,
      RizzRisk.fromJson(v['risk']),
    );
  }
}

/// Dolandırıcılık / güvenlik risk sinyali (seviye sunucuda sinyallerden hesaplanır).
class RizzRisk {
  final String level; // low | medium | high
  final List<String> signals;
  final String? note;
  const RizzRisk(this.level, this.signals, this.note);

  static RizzRisk? fromJson(dynamic v) {
    if (v is! Map) return null;
    final signals = v['signals'] is List ? (v['signals'] as List).whereType<String>().toList() : <String>[];
    if (signals.isEmpty) return null;
    return RizzRisk((v['level'] as String?) ?? 'low', signals, v['note'] as String?);
  }
}

/// Ağır sinyaller (functions/rizz.js RISK_HARD ile aynı): biri varsa seviye "high".
const Set<String> kRizzRiskHard = {
  'money_request',
  'crypto_investment',
  'suspicious_link',
  'personal_data_request',
  'sextortion',
};

/// İki risk okumasını birleştirir (sinyaller birleşir, seviye sunucu kuralıyla yeniden hesaplanır).
RizzRisk? mergeRizzRisk(RizzRisk? a, RizzRisk? b) {
  if (a == null) return b;
  if (b == null) return a;
  final signals = {...a.signals, ...b.signals}.toList();
  final level = signals.any(kRizzRiskHard.contains) ? 'high' : (signals.length >= 2 ? 'medium' : 'low');
  return RizzRisk(level, signals, b.note ?? a.note);
}

/// Röntgen [base] korunur, risk [extra] ile birleşir (takipte yeni bulunan risk kaybolmasın).
RizzInsight? withMergedRisk(RizzInsight? base, RizzRisk? extra) {
  if (base == null) {
    return extra == null ? null : RizzInsight('unclear', 'unclear', const [], const [], 'unclear', null, extra);
  }
  return RizzInsight(base.interest, base.investment, base.greenFlags, base.redFlags, base.nextStep, base.summary,
      mergeRizzRisk(base.risk, extra));
}

/// Risk sinyali anahtarı → kullanıcıya gösterilen kısa açıklama.
const Map<String, String> kRizzRiskSignals = {
  'money_request': 'Para, hediye ya da ödeme istiyor',
  'crypto_investment': 'Kripto / yatırım fırsatı öneriyor',
  'suspicious_link': 'Şüpheli bağlantı ya da uygulama gönderiyor',
  'personal_data_request': 'Doğrulama kodu, kimlik, kart ya da şifre istiyor',
  'sextortion': 'Mahrem fotoğraf istiyor ya da tehdit ediyor',
  'move_off_app': 'Çok erken başka uygulamaya çekmeye çalışıyor',
  'love_bombing': 'Çok erken, çok yoğun ilgi gösteriyor',
  'inconsistent_story': 'Anlattıkları birbirini tutmuyor',
  'avoids_meeting': 'Görüntülü görüşmeden / buluşmadan kaçıyor',
  'pressure_secrecy': 'Acele ettiriyor ya da gizlilik istiyor',
};

class RizzResult {
  final String? requestId;
  final bool charged;
  final String status;
  final String userSide;
  final String confidence;
  final List<RizzMessage> transcript;
  final String turn;
  final String stage;
  final List<RizzReply> replies;
  final String? tip;
  final String? notice;
  final RizzInsight? insight;
  final int? freeLeft;
  final int? dailyFree;
  final int followupsLeft;

  const RizzResult({
    required this.requestId,
    required this.charged,
    required this.status,
    required this.userSide,
    required this.confidence,
    required this.transcript,
    required this.turn,
    required this.stage,
    required this.replies,
    required this.tip,
    required this.notice,
    required this.insight,
    required this.freeLeft,
    required this.dailyFree,
    required this.followupsLeft,
  });

  /// "Daha fazla" / ton takibinde Sohbet Röntgeni korunur (aynı sohbet; tona göre değişmemeli).
  RizzResult withInsight(RizzInsight? keep) => RizzResult(
        requestId: requestId,
        charged: charged,
        status: status,
        userSide: userSide,
        confidence: confidence,
        transcript: transcript,
        turn: turn,
        stage: stage,
        replies: replies,
        tip: tip,
        notice: notice,
        insight: keep,
        freeLeft: freeLeft,
        dailyFree: dailyFree,
        followupsLeft: followupsLeft,
      );

  factory RizzResult.fromJson(Map<String, dynamic> d) {
    final quota = d['quota'] is Map ? Map<String, dynamic>.from(d['quota'] as Map) : null;
    List<Map<String, dynamic>> list(dynamic v) =>
        v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : const [];
    return RizzResult(
      requestId: d['requestId'] as String?,
      charged: d['charged'] == true,
      status: (d['status'] as String?) ?? 'unreadable',
      userSide: (d['userSide'] as String?) ?? 'unknown',
      confidence: (d['confidence'] as String?) ?? 'low',
      transcript: [
        for (final m in list(d['transcript'])) RizzMessage((m['speaker'] as String?) ?? 'unknown', (m['text'] as String?) ?? ''),
      ],
      turn: (d['turn'] as String?) ?? 'user_to_reply',
      stage: (d['stage'] as String?) ?? '',
      replies: [
        for (final r in list(d['replies']))
          RizzReply((r['text'] as String?) ?? '', (r['tone'] as String?) ?? 'warm', (r['move'] as String?) ?? '',
              (r['why'] as String?) ?? ''),
      ],
      tip: d['tip'] as String?,
      notice: d['notice'] as String?,
      insight: RizzInsight.fromJson(d['insight']),
      freeLeft: (quota?['freeLeft'] as num?)?.toInt(),
      dailyFree: (quota?['dailyFree'] as num?)?.toInt(),
      followupsLeft: (d['followupsLeft'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Görseli JPEG'e çevirip küçültür; uzun ekran görüntüsünü dikey parçalara böler (izolatta).
/// Çözülemezse boş liste (çağıran RizzImageException fırlatır). Küçültme ortalama (alan) örneklemeyle:
/// varsayılan en-yakın-komşu ince yazı çizgilerini koparıyordu.
List<Uint8List> _shrinkToParts(Uint8List bytes) {
  final decoded = img.decodeImage(bytes);
  if (decoded == null) return const [];
  Uint8List jpg(img.Image im) => Uint8List.fromList(img.encodeJpg(im, quality: 82));
  img.Image resize(img.Image im, {int? width, int? height}) =>
      img.copyResize(im, width: width, height: height, interpolation: img.Interpolation.average);
  var im = decoded;
  final ratio = im.height / im.width;
  if (ratio <= 2.6) {
    const maxSide = 2048;
    final long = im.width > im.height ? im.width : im.height;
    if (long > maxSide) im = im.width >= im.height ? resize(im, width: maxSide) : resize(im, height: maxSide);
    return [jpg(im)];
  }
  // Kaydırmalı ekran görüntüsü: genişlik ≤ 1080, parça yüksekliği 2.2×genişlik, %10 bindirme (sınırda kesilen
  // mesaj iki parçada da tam görünsün; prompt tekrarı saymamasını söyler).
  if (im.width > 1080) im = resize(im, width: 1080);
  final w = im.width;
  final tileH = (w * 2.2).round();
  final step = tileH - (w * 0.1).round();
  final parts = <Uint8List>[];
  for (var y = 0; y < im.height; y += step) {
    final h = (y + tileH > im.height) ? im.height - y : tileH;
    parts.add(jpg(img.copyCrop(im, x: 0, y: y, width: w, height: h)));
    if (y + h >= im.height) break;
  }
  return parts;
}

/// Seçilen görüntüleri (eskiden yeniye) kodlar. Parça sınırı aşılırsa sohbette EN YENİ kısım tutulur
/// ([keepNewest]); profilde (Profil Doktoru) baş kısım — ilk fotoğraf ve ilk izlenim — tutulur.
Future<RizzImages> encodeRizzImages(List<File> files, {bool keepNewest = true}) async {
  final parts = <Uint8List>[];
  for (final f in files.take(kRizzMaxImages)) {
    final p = await compute(_shrinkToParts, await f.readAsBytes());
    if (p.isEmpty) throw const RizzImageException();
    parts.addAll(p);
  }
  final kept = parts.length <= kRizzMaxParts
      ? parts
      : keepNewest
          ? parts.sublist(parts.length - kRizzMaxParts)
          : parts.sublist(0, kRizzMaxParts);
  return RizzImages(
    [for (final b in kept) {'data': base64Encode(b), 'mimeType': 'image/jpeg'}],
    kept.length < parts.length,
  );
}

/// Sunucu çağrısı. images: encodeRizzImages çıktısı (takip isteklerinde AYNISI gönderilmeli: sunucu takip
/// isteğini ilk görüntülere özetle bağlar). swapFrom: "taraflar ters" — yanlış bulunan okuma.
Future<RizzResult> requestRizzReplies({
  required List<Map<String, String>> images,
  required String mode,
  required String tone,
  String? gender,
  String note = '',
  List<String> avoid = const [],
  List<RizzMessage> swapFrom = const [],
  String? parentId,
}) async {
  final callable = FirebaseFunctions.instanceFor(region: _region)
      .httpsCallable('rizzReply', options: HttpsCallableOptions(timeout: const Duration(seconds: 120)));
  final result = await callable.call(<String, dynamic>{
    'images': images,
    'mode': mode,
    'tone': tone,
    'gender': gender ?? 'na',
    'note': note,
    'avoid': avoid,
    'swapFrom': [for (final m in swapFrom) {'speaker': m.speaker, 'text': m.text}],
    'parentId': parentId,
  });
  return RizzResult.fromJson(Map<String, dynamic>.from(result.data as Map));
}

/// Öneri bildirimi (RizzGPT cevabı ya da Profil Doktoru metni). feature: 'rizz' | 'profileDoctor'.
Future<void> reportRizzReply({
  required String text,
  required String reason,
  String? requestId,
  String feature = 'rizz',
}) async {
  final callable = FirebaseFunctions.instanceFor(region: _region).httpsCallable('rizzReport');
  await callable.call(<String, dynamic>{'text': text, 'reason': reason, 'requestId': requestId, 'feature': feature});
}
