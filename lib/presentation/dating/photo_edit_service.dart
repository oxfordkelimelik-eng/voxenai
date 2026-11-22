// KULLANICI FOTO DÜZENLEYİCİSİ (2026-11-22, kullanıcı: "12 filtre, flaş, 11 sürgülü ayar ve ışıklı hem
// kullanıcı tarafında hem admin tarafında değiştirilebilsin").
//
// Kullanıcı yalnız kendisine teslim edilmiş kareyi (dating_results) düzenler. Ekran admin
// düzenleyicisiyle aynıdır (OpsPhotoEditorScreen); yalnız kaydetme ve flaş alanları kullanıcının kendi
// yetkisiyle çalışan sunucu fonksiyonlarına gider (functions/opsPanel.js applyPhotoEdits /
// photoFlashFields — sahiplik ve teslim listesi sunucuda denetlenir).
//
// Kayıtlı düzenleme iş belgesinin `resultPhotoEdits` alanındadır (admin onayda yaptığı düzenleme de
// buraya taşınır); asıl kare dosyanın yanında `.orijinal.jpg` olarak durur.

import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_storage/firebase_storage.dart';

import '../ops/photo_edits.dart';

const _region = 'europe-west1';
const _editBackupSuffix = '.orijinal.jpg';

/// gs://bucket/dating_results/{uid}/{jobId}/{dosya} → jobId (biçim tutmazsa null).
String? jobIdOfResultRef(String gsUrl) {
  final m = RegExp(r'dating_results/[^/]+/([^/]+)/[^/]+$').firstMatch(gsUrl);
  return m?.group(1);
}

/// Düzenleyiciyi açmak için gereken durum: gösterilen kare, varsa asıl kare ve kayıtlı düzenleme.
class UserPhotoEditState {
  final String jobId;
  final String imageUrl;
  final String? originalUrl;
  final PhotoEdits edits;
  const UserPhotoEditState(this.jobId, this.imageUrl, this.originalUrl, this.edits);
}

/// Kayıtlı düzenlemeyi iş belgesinden okur; asıl kare yalnız düzenleme varsa aranır.
Future<UserPhotoEditState> loadUserPhotoEditState({required String uid, required String ref}) async {
  final jobId = jobIdOfResultRef(ref);
  if (jobId == null) throw StateError('Bu fotoğraf düzenlenemez.');
  final storage = FirebaseStorage.instance;
  final imageUrl = await storage.refFromURL(ref).getDownloadURL();
  var edits = PhotoEdits.empty;
  try {
    final snap = await FirebaseFirestore.instance.doc('users/$uid/private/genData/genJobs/$jobId').get();
    final list = snap.data()?['resultPhotoEdits'];
    if (list is List) {
      for (final r in list) {
        if (r is Map && r['ref'] == ref && r['edits'] is Map) {
          edits = PhotoEdits.fromJson(Map<String, dynamic>.from(r['edits'] as Map));
        }
      }
    }
  } catch (_) {
    // Okunamazsa düzenlemesiz açılır; asıl kare yine yedekten bulunur.
  }
  String? originalUrl;
  try {
    originalUrl = await storage.refFromURL('$ref$_editBackupSuffix').getDownloadURL();
  } catch (_) {
    originalUrl = null; // yedek yok: gösterilen kare asıl karedir
  }
  // Yedek yoksa kayıt düzenlemesi asıl kareye yeniden uygulanmasın (eski teslimlerde düzenleme dosyaya
  // gömülü olabilir): düzenleyici boş başlar.
  if (originalUrl == null) edits = PhotoEdits.empty;
  return UserPhotoEditState(jobId, imageUrl, originalUrl, edits);
}

Future<({String? url, Map<String, dynamic>? edits, String? originalUrl})> applyUserPhotoEdits({
  required String ref,
  required Map<String, dynamic>? edits,
}) async {
  final callable = FirebaseFunctions.instanceFor(
    region: _region,
  ).httpsCallable('applyPhotoEdits', options: HttpsCallableOptions(timeout: const Duration(seconds: 120)));
  final result = await callable.call(<String, dynamic>{'ref': ref, 'edits': edits});
  final data = Map<String, dynamic>.from(result.data as Map);
  return (
    url: data['url'] as String?,
    edits: data['edits'] is Map ? Map<String, dynamic>.from(data['edits'] as Map) : null,
    originalUrl: data['originalUrl'] as String?,
  );
}

Future<({Uint8List png, bool gray})> userPhotoFlashFields({required String ref}) async {
  final callable = FirebaseFunctions.instanceFor(
    region: _region,
  ).httpsCallable('photoFlashFields', options: HttpsCallableOptions(timeout: const Duration(seconds: 120)));
  final result = await callable.call(<String, dynamic>{'ref': ref});
  final data = Map<String, dynamic>.from(result.data as Map);
  return (png: base64Decode(data['png'] as String), gray: data['gray'] == true);
}
