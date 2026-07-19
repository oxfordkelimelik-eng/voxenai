/// Dating Asistanı rota adları (Bölüm 7 — akış özeti).
class DatingRoutes {
  DatingRoutes._();
  static const String splash = '/'; // açılış ekranı (logo)
  static const String onboarding = '/onboarding'; // funnel (girişsiz)
  static const String modules = '/modules'; // modül vitrini (girişsiz)
  static const String paywall = '/paywall'; // ?mode=analysis | ai_photo
  static const String login = '/login'; // Apple + Google (abonelik anında)
  static const String hub = '/hub'; // giriş sonrası modül merkezi
  static const String settings = '/settings'; // gizlilik + hesap
  static const String module = '/module'; // /module/:id
  // GEÇİCİ geliştirici aracı — model A/B karşılaştırması. Test bitince
  // bu rota, ModelBakeoffScreen ve functions/modelBakeoff.js silinmeli.
  static const String modelBakeoff = '/dev/model-bakeoff';
}
