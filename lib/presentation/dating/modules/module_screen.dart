import 'package:flutter/material.dart';
import 'module_flows.dart';

/// /module/:id dispatcher — her modül kendi özel ekranını açar.
class ModuleScreen extends StatelessWidget {
  final String moduleId;
  const ModuleScreen({super.key, required this.moduleId});

  @override
  Widget build(BuildContext context) {
    switch (moduleId) {
      case 'ai_photo':
        return const AiPhotoFlow();
      case 'photo_analysis':
        return const PhotoAnalysisFlow();
      case 'coach':
        return const CoachChatFlow();
      case 'rizz':
        return const RizzFlow();
      case 'bio':
        return const BioFlow();
      case 'looksmaxxing':
        return const LooksmaxxingFlow();
      default:
        return const AiPhotoFlow();
    }
  }
}
