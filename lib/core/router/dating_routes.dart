/// Dating Asistanı rota adları (Bölüm 7 — akış özeti).
class DatingRoutes {
  DatingRoutes._();
  static const String splash = '/'; // açılış ekranı (logo)
  static const String onboarding = '/onboarding'; // funnel (girişsiz)
  static const String modules = '/modules'; // modül vitrini (girişsiz)
  static const String paywall = '/paywall'; // abonelik
  static const String login = '/login'; // Apple + Google (abonelik anında)
  static const String hub = '/hub'; // giriş sonrası modül merkezi
  static const String settings = '/settings'; // gizlilik + hesap
  static const String module = '/module'; // /module/:id
}
