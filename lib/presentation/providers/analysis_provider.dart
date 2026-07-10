import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../domain/entities/face_analysis.dart';
import '../../domain/entities/body_analysis.dart';
import '../../domain/repositories/repositories.dart';
import '../providers/app_providers.dart';
import '../providers/tasks_provider.dart';
import '../providers/progress_provider.dart';

/// Yüz analizi akışı — AI varsa AI, yoksa formdan fallback üretir.
final faceAnalysisFlowProvider =
    AsyncNotifierProvider<FaceAnalysisFlowNotifier, FaceAnalysisResult?>(
  FaceAnalysisFlowNotifier.new,
);

class FaceAnalysisFlowNotifier extends AsyncNotifier<FaceAnalysisResult?> {
  @override
  Future<FaceAnalysisResult?> build() async =>
      ref.read(faceAnalysisProvider);

  /// imageFiles null/boş ise doğrudan formdan fallback üretilir.
  /// Dolu ise sırayla [ön, sağ, sol] fotoğrafları beklenir.
  Future<void> run(List<File>? imageFiles) async {
    state = const AsyncLoading();
    final service = ref.read(claudeApiServiceProvider);
    final intake = ref.read(intakeProvider);
    try {
      FaceAnalysisResult result;
      final hasKey = await service.hasApiKey();
      final hasPhotos = imageFiles != null && imageFiles.isNotEmpty;
      if (hasPhotos && hasKey) {
        result = await service.analyzeFace(imageFiles, intake: intake);
      } else if (intake != null) {
        result = service.fallbackFace(intake);
      } else {
        throw const ValidationFailure('Önce formu doldurman gerekiyor.');
      }
      await ref.read(faceAnalysisProvider.notifier).save(result);
      await ref.read(progressProvider.notifier).addEntry(
            type: 'face',
            score: result.overallScore,
            photo: hasPhotos ? imageFiles.first : null,
          );
      await ref.read(tasksProvider.notifier).regenerate();
      state = AsyncData(result);
    } catch (e, st) {
      // AI hatası olursa fallback'e düş
      if (intake != null) {
        final fb = service.fallbackFace(intake);
        await ref.read(faceAnalysisProvider.notifier).save(fb);
        await ref.read(progressProvider.notifier).addEntry(
              type: 'face',
              score: fb.overallScore,
              photo: (imageFiles != null && imageFiles.isNotEmpty)
                  ? imageFiles.first
                  : null,
            );
        await ref.read(tasksProvider.notifier).regenerate();
        state = AsyncData(fb);
      } else {
        state = AsyncError(e, st);
      }
    }
  }
}

/// Vücut analizi akışı
final bodyAnalysisFlowProvider =
    AsyncNotifierProvider<BodyAnalysisFlowNotifier, BodyAnalysisResult?>(
  BodyAnalysisFlowNotifier.new,
);

class BodyAnalysisFlowNotifier extends AsyncNotifier<BodyAnalysisResult?> {
  @override
  Future<BodyAnalysisResult?> build() async =>
      ref.read(bodyAnalysisProvider);

  Future<void> run(List<File>? imageFiles) async {
    state = const AsyncLoading();
    final service = ref.read(claudeApiServiceProvider);
    final intake = ref.read(intakeProvider);
    final hasPhotos = imageFiles != null && imageFiles.isNotEmpty;
    try {
      BodyAnalysisResult result;
      final hasKey = await service.hasApiKey();
      if (hasPhotos && hasKey) {
        result = await service.analyzeBody(imageFiles, intake: intake);
      } else if (intake != null) {
        result = service.fallbackBody(intake);
      } else {
        throw const ValidationFailure('Önce formu doldurman gerekiyor.');
      }
      await ref.read(bodyAnalysisProvider.notifier).save(result);
      await ref.read(progressProvider.notifier).addEntry(
            type: 'body',
            score: result.overallScore,
            photo: hasPhotos ? imageFiles.first : null,
          );
      await ref.read(tasksProvider.notifier).regenerate();
      state = AsyncData(result);
    } catch (e, st) {
      if (intake != null) {
        final fb = service.fallbackBody(intake);
        await ref.read(bodyAnalysisProvider.notifier).save(fb);
        await ref.read(progressProvider.notifier).addEntry(
              type: 'body',
              score: fb.overallScore,
              photo: hasPhotos ? imageFiles.first : null,
            );
        await ref.read(tasksProvider.notifier).regenerate();
        state = AsyncData(fb);
      } else {
        state = AsyncError(e, st);
      }
    }
  }
}
