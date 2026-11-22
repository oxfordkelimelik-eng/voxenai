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
    required this.freeLeft,
    required this.dailyFree,
    required this.followupsLeft,
  });

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

/// Seçilen görüntüleri (eskiden yeniye) kodlar. Parça sınırı aşılırsa EN YENİ kısım tutulur.
Future<RizzImages> encodeRizzImages(List<File> files) async {
  final parts = <Uint8List>[];
  for (final f in files.take(kRizzMaxImages)) {
    final p = await compute(_shrinkToParts, await f.readAsBytes());
    if (p.isEmpty) throw const RizzImageException();
    parts.addAll(p);
  }
  final kept = parts.length > kRizzMaxParts ? parts.sublist(parts.length - kRizzMaxParts) : parts;
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

Future<void> reportRizzReply({required String text, required String reason, String? requestId}) async {
  final callable = FirebaseFunctions.instanceFor(region: _region).httpsCallable('rizzReport');
  await callable.call(<String, dynamic>{'text': text, 'reason': reason, 'requestId': requestId});
}
