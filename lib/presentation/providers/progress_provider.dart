import 'dart:convert';
import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/constants/app_constants.dart';
import '../../domain/entities/progress_entry.dart';
import 'app_providers.dart';

/// İlerleme geçmişi: her analiz anının {tarih, tip, skor, foto} kaydı.
/// Önce/sonra foto karşılaştırması ve skor zaman çizelgesi için kullanılır.
final progressProvider =
    StateNotifierProvider<ProgressNotifier, List<ProgressEntry>>(
  (ref) => ProgressNotifier(ref),
);

/// Sadece yüz kayıtları (eskiden yeniye)
final faceProgressProvider = Provider<List<ProgressEntry>>((ref) {
  return ref.watch(progressProvider).where((e) => e.isFace).toList()
    ..sort((a, b) => a.date.compareTo(b.date));
});

/// Sadece vücut kayıtları (eskiden yeniye)
final bodyProgressProvider = Provider<List<ProgressEntry>>((ref) {
  return ref.watch(progressProvider).where((e) => e.isBody).toList()
    ..sort((a, b) => a.date.compareTo(b.date));
});

class ProgressNotifier extends StateNotifier<List<ProgressEntry>> {
  final Ref _ref;
  ProgressNotifier(this._ref) : super([]) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.progressHistory);
    if (raw == null) return;
    try {
      state = (jsonDecode(raw) as List)
          .map((e) => ProgressEntry.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {}
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      StorageKeys.progressHistory,
      jsonEncode(state.map((e) => e.toJson()).toList()),
    );
    // Buluta aynala (skorlar/tarihler senkronlanır; foto yolu cihaza özel kalır)
    await pushSync(_ref);
  }

  /// Bir analiz tamamlandığında çağrılır. Foto verildiyse kalıcı bir kopya
  /// oluşturup yolunu kaydeder (galeriden seçilen geçici dosya silinebilir).
  Future<void> addEntry({
    required String type,
    required int score,
    File? photo,
  }) async {
    String? savedPath;
    if (photo != null) {
      try {
        final dir = await getApplicationDocumentsDirectory();
        final progressDir = Directory('${dir.path}/progress');
        if (!progressDir.existsSync()) {
          progressDir.createSync(recursive: true);
        }
        final ext = photo.path.split('.').last;
        final fileName =
            '${type}_${DateTime.now().millisecondsSinceEpoch}.$ext';
        final dest = '${progressDir.path}/$fileName';
        await photo.copy(dest);
        savedPath = dest;
      } catch (_) {
        // Foto kopyalanamazsa skoru yine de kaydet
      }
    }

    final entry = ProgressEntry(
      date: DateTime.now(),
      type: type,
      score: score,
      photoPath: savedPath,
    );
    state = [...state, entry];
    await _persist();
  }

  Future<void> clear() async {
    state = [];
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.progressHistory);
  }
}
