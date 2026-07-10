import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/constants/app_constants.dart';
import '../../domain/entities/addiction.dart';

/// Kullanıcının aktif olarak takip ettiği bağımlılıklar (temiz gün sayaçları)
final addictionProvider =
    StateNotifierProvider<AddictionNotifier, List<Addiction>>((ref) {
  return AddictionNotifier();
});

class AddictionNotifier extends StateNotifier<List<Addiction>> {
  AddictionNotifier() : super([]) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(StorageKeys.addictions);
    if (raw == null) return;
    try {
      state = (jsonDecode(raw) as List)
          .map((e) => Addiction.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {}
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      StorageKeys.addictions,
      jsonEncode(state.map((a) => a.toJson()).toList()),
    );
  }

  /// Formdan seçilen bağımlılıkları ilk kez kur (varsa korunur)
  Future<void> initFromIds(List<String> ids) async {
    final existing = {for (final a in state) a.typeId: a};
    final now = DateTime.now();
    state = ids
        .map((id) =>
            existing[id] ?? Addiction(typeId: id, startCleanDate: now))
        .toList();
    await _persist();
  }

  Future<void> add(String typeId) async {
    if (state.any((a) => a.typeId == typeId)) return;
    state = [...state, Addiction(typeId: typeId, startCleanDate: DateTime.now())];
    await _persist();
  }

  Future<void> remove(String typeId) async {
    state = state.where((a) => a.typeId != typeId).toList();
    await _persist();
  }

  Future<void> relapse(String typeId) async {
    state = state
        .map((a) => a.typeId == typeId ? a.relapse() : a)
        .toList();
    await _persist();
  }

  /// "Bugün de temiz" günlük check-in — bugünü temiz olarak işaretler.
  Future<void> checkInToday(String typeId) async {
    state = state
        .map((a) => a.typeId == typeId ? a.checkInToday() : a)
        .toList();
    await _persist();
  }

  Future<void> clear() async {
    state = [];
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(StorageKeys.addictions);
  }

  Future<void> resetCounter(String typeId) async {
    state = state
        .map((a) => a.typeId == typeId
            ? Addiction(
                typeId: a.typeId,
                startCleanDate: DateTime.now(),
                bestStreakDays: a.bestStreakDays,
                relapseCount: a.relapseCount,
              )
            : a)
        .toList();
    await _persist();
  }
}
