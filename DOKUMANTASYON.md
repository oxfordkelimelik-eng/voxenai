# Rise Up — Uygulama Çalışma Mantığı (Taslak Doküman)

> **Rise Up**: AI destekli erkek kişisel gelişim & "looksmaxxing" platformu.
> Flutter (Dart) + Firebase + Google Gemini Vision API üzerine kurulu, yerel-öncelikli (offline-first) bir mobil uygulama.

---

## 1. Tek Cümlede Uygulama

Kullanıcı bir anket doldurur ve isteğe bağlı yüz/vücut fotoğrafı yükler; uygulama bu verilerden **AI ile analiz** yapıp kişiye özel **günlük görevler** üretir; kullanıcı görevleri tamamladıkça **XP/seviye/streak** kazanır, ilerlemesini takip eder ve **3 günlük deneme** sonrası **PRO aboneliğe** yönlendirilir.

---

## 2. Teknoloji Yığını

| Katman | Teknoloji |
|--------|-----------|
| Framework | Flutter (Dart SDK ^3.11) |
| State Management | Riverpod (`flutter_riverpod`) |
| Navigasyon | `go_router` |
| Network | `dio` (Gemini REST), `cloud_functions` (proxy) |
| Kimlik | Firebase Auth (anonim + Google) |
| Bulut DB | Cloud Firestore |
| Sunucu | Firebase Cloud Functions (Node.js, `europe-west1`) |
| AI | Google Gemini Vision (`gemini-2.5-flash` + yedek modeller) |
| Yerel depolama | `shared_preferences` (durum), `flutter_secure_storage` (API anahtarı) |
| Ödeme | Google Play Billing (`in_app_purchase`) |
| Medya | `image_picker` |

---

## 3. Mimari (Clean Architecture)

```
lib/
├── main.dart                 → Firebase init, sistem UI, runApp
├── app.dart                  → MaterialApp.router + yaşam döngüsü gözlemcisi
├── firebase_options.dart
│
├── core/                     → Çekirdek (UI'dan bağımsız)
│   ├── constants/            → ApiConfig, StorageKeys, XpConfig, renkler, metinler
│   ├── router/               → go_router rota tanımları (AppRoutes)
│   ├── services/             → task_generator.dart (saf görev üretim mantığı)
│   └── theme/                → koyu tema
│
├── domain/                   → İş kuralları (entity'ler + soyut sözleşmeler)
│   ├── entities/             → UserProfile, IntakeProfile, DailyTask,
│   │                           FaceAnalysis, BodyAnalysis, Addiction
│   └── repositories/         → Failure tipleri (Network/Unauthorized/Server...)
│
├── data/                     → Dış dünyaya bağlanan katman
│   └── sources/              → auth_service, claude_api_service (Gemini),
│                               sync_service (Firestore), billing_service
│
└── presentation/             → UI
    ├── providers/            → Riverpod provider'ları (uygulama beyni)
    ├── screens/              → Ekranlar (splash, survey, home, analysis...)
    └── widgets/              → Tekrar kullanılan parçalar (streak, xp bar...)
```

**Veri akışı yönü:** `presentation` → `providers` → `data/sources` → (Firebase / Gemini).
`domain` katmanı hiçbir şeye bağımlı değildir; her şey ona bağımlıdır.

---

## 4. Açılış (Bootstrap) Akışı

`main()` çalıştığında:

1. **Firebase başlatılır** (`Firebase.initializeApp`).
2. `RiseUpApp` açılışta arka planda iki iş tetikler (UI'yı bloklamadan):
   - `appBootstrapProvider` → **anonim Firebase oturumu** açar, sonra buluttaki veri yereldekinden yeniyse indirir.
   - `billingServiceProvider` → Play Billing'i başlatır, abonelik ürünlerini yükler, satın alma akışını dinler.
3. Uygulama arka plana alındığında (`paused/inactive`) tüm yerel durum **buluta aynalanır** (`pushSyncW`).

---

## 5. Kullanıcı Yolculuğu (Routing Mantığı)

Splash ekranı (`/`) 2.5 sn sonra şu karara göre yönlendirir:

```
                 ┌─────────────────────────────┐
                 │   SPLASH (/)                │
                 └──────────────┬──────────────┘
                                │
              Anket yapılmış mı? (surveyDone)
                                │
              ┌──── HAYIR ──────┴──────── EVET ────┐
              ▼                                     ▼
        ANKET (/survey)                      PRO üye mi?
              │                          ┌──── EVET ──── HOME
   18 bölümlük form + bağımlılık seçimi  │
              │                          └──── HAYIR ──── Deneme kontrolü
   intake kaydet, trial başlat,                          │
   görevleri üret                          3 günden az geçti mi?
              ▼                            ┌── EVET ── HOME (/home)
        ANALİZ (/analysis)                 └── HAYIR ─ TRIAL/PAYWALL
   (yüz + vücut foto — opsiyonel)
              ▼
        ONBOARDING (/onboarding)
              ▼
        HOME (/home)
```

**Sert duvar (hard paywall):** Deneme süresi dolan ve PRO olmayan kullanıcı, uygulamayı açıkken bile `HomeScreen`'den otomatik olarak `/trial` ekranına itilir (içerik gösterilmez).

### Ana ekranlar
- `/home` — Kişisel pano (seviye, streak, skorlar, bağımlılık sayaçları). Alt menü: Görevler / Sosyal / Bağımlılık.
- `/tasks` — Günlük görev listesi (fiziksel / zihinsel / sosyal sekmeleri).
- `/analysis`, `/analysis/face`, `/analysis/body` — Foto analizi ve sonuç ekranları.
- `/social` — AI sohbet (daygame / sosyal antrenman simülatörü).
- `/addiction` — Bağımlılık takibi ve temiz kalma sayaçları.
- `/paywall`, `/trial` — Abonelik ekranları.
- `/settings`, `/leaderboard` — Ayarlar ve liderlik tablosu.

---

## 6. Çekirdek Mekanikler

### 6.1 Anket → Profil (IntakeProfile)
18 bölümlük anket; tüm çoktan seçmeli cevaplar **index** olarak saklanır. Boyutlar:
- **Fiziksel:** fitness seviyesi, hedef (yağ yak/kas yap), hedef bölge, haftalık antrenman günü
- **Disiplin:** beslenme, uyku, su alışkanlığı
- **Zihinsel:** ana zorluk, özgüven, disiplin, ekran süresi
- **Sosyal:** sosyal kaygı, sosyal çevre, flört deneyimi, göz teması rahatlığı
- **Bağımlılıklar:** porno, sosyal medya, sigara, şeker, oyun, alkol, kafein (çoklu seçim)

Anket bittiğinde: `IntakeProfile` kaydedilir → `surveyDone=true` → deneme başlatılır → görevler üretilir → analiz ekranına geçilir.

### 6.2 AI Foto Analizi (ClaudeApiService — Gemini kullanır)
> Not: Sınıf adı `ClaudeApiService` ama aslında **Google Gemini** API'sini çağırır.

İki analiz türü:
- **Yüz analizi:** yüz şekli, çene hattı/cilt/genel skor, asimetri, gonial açı, mewing rehberi, masseter egzersizleri, cilt rutini, saç/sakal kılavuzu.
- **Vücut analizi:** genel/postür/kas skoru, vücut yağ oranı, kilo kategorisi, vücut tipi, kamburluk, kalori/protein hedefi, öncelikli egzersizler.

**Çağrı stratejisi (`_callVision`):**
1. Önce **Cloud Function proxy** (`analyzeImage`) denenir — API anahtarı sunucuda gizli kalır.
2. Proxy başarısızsa → doğrudan Gemini REST API (gömülü yedek anahtarla).
3. Tümü başarısızsa → **form tabanlı fallback** (`fallbackFace` / `fallbackBody`): anket verisinden kaba ama tutarlı skor üretir (internet/AI gerekmez).

AI yanıtı katı JSON formatında istenir; `_extractJson` ile ayrıştırılıp entity'e dönüştürülür.

### 6.3 Görev Üretimi (TaskGenerator)
Saf (yan etkisiz) fonksiyonlarla `IntakeProfile` + opsiyonel analiz sonuçları + bağımlılıklardan **kişiselleştirilmiş görev seti** üretir. Görevler 3 ana tipe dağılır:

| TaskType | Örnek kategoriler | Örnek görevler |
|----------|-------------------|----------------|
| **physical** | body, face, nutrition | Antrenman (seviyeye göre), postür düzeltme, jawline/mewing, cilt rutini, protein/su hedefi, adım hedefi |
| **mental** | discipline, mindset, addiction | Uyku hijyeni, soğuk duş, derin odak, zihniyet görevi, bağımlılık "temiz kal" görevi |
| **social** | socialSkill | Anksiyete seviyesine göre kademeli: mikro maruz kalma → sohbet başlat → liderlik anı; flört/çerçeve |

Her görev: başlık, açıklama, **rationale (neden)**, zorluk, süre, XP ödülü ve isteğe bağlı **adım listesi (checklist)** içerir. Görevler analiz sonuçlarıyla zenginleşir (ör. AI'nın önerdiği mewing rehberi/protein hedefi görevlere işlenir).

### 6.4 Görev Tamamlama & Gamification
`TasksNotifier` (AsyncNotifier) görev durumunu yönetir:
- Görevler **gün bazında** kalıcıdır (`tasks_date` ile aynı günse tekrar üretilmez).
- Bir görevin tüm adımları işaretlenince görev otomatik tamamlanır.
- Tamamlanınca: **XP eklenir**, görev geçmişine yazılır, bulut senkronu tetiklenir.
- **Günün tüm görevleri bitince streak güncellenir** (ardışık gün = +1; gün atlanırsa sıfırlanır).

**XP & Seviye sistemi (`XpConfig`):**
- Görev başına 50 XP, sosyal görev 75 XP, analiz 200 XP, zor görev +25 bonus.
- 10 seviye (0 → 30.000 XP): *Çaylak → Arayıcı → Disiplinli → ... → APEX*.

### 6.5 Bağımlılık Takibi
Kullanıcının seçtiği her bağımlılık için "temiz kal" sayaçları ve günlük kurtulma görevleri (`_addictionTasks`). Her bağımlılık tipinin emoji'si, motivasyon cümlesi ve kurtulma adımları vardır.

### 6.6 Sosyal Simülatör (AI Chat)
Gemini ile **daygame/sosyal antrenman** rol-yapma. AI hem gerçekçi bir kadın karakteri canlandırır hem de koç olarak `[GERİ BİLDİRİM]` ve `[EQ_SKOR]` üretir. Senaryolar: sokak, kafe, market, etkinlik. Seviyeler: dolaylı / ileri (daygame).

---

## 7. Veri Saklama & Senkronizasyon (Offline-First)

```
   ┌──────────────────┐    push (her değişiklikte +     ┌────────────────────┐
   │ SharedPreferences │ ── app arka plana alınınca) ──▶ │ Firestore           │
   │ (yerel, kaynak)   │                                 │ users/{uid}         │
   │                   │ ◀── pull (açılışta, bulut      │  ├ updatedAt        │
   └──────────────────┘     daha yeniyse)                │  └ data: {...}      │
                                                          └────────────────────┘
```

- **Yerel öncelikli:** Uygulama internetsiz çalışır; `shared_preferences` ana doğruluk kaynağıdır.
- **SyncService** yerel anahtarları Firestore `users/{uid}` dokümanıyla aynalar.
- **Çakışma çözümü:** "en son güncelleyen kazanır" (`updatedAt` zaman damgası).
- Fotoğraf yolları cihaza özeldir, **buluta gönderilmez**.
- **Güvenlik (Firestore rules):** Her kullanıcı yalnızca kendi `users/{uid}` dokümanına erişebilir; diğer her şey kapalı.

**Hassas veri:** Gemini API anahtarı `flutter_secure_storage` ile şifreli tutulur. Üretimde anahtar Cloud Function'da **Firebase Secret** (`GEMINI_KEY`) olarak saklanır ve APK'da görünmez.

---

## 8. Sunucu Tarafı (Cloud Functions)

`functions/index.js` — iki callable fonksiyon (`europe-west1`):

| Fonksiyon | Görev |
|-----------|-------|
| `analyzeImage` | Foto + prompt alır, gizli anahtarla Gemini'yi çağırır, ham metni döner |
| `chat` | Sosyal simülatör mesajlarını Gemini'ye iletir |

- Sadece **giriş yapmış** (anonim dahil) kullanıcı çağırabilir (`request.auth` kontrolü).
- **Dayanıklılık:** Model meşgulse (503/429) önce kısa bekleyip yeniden dener, olmazsa sıradaki yedek modele geçer (`gemini-2.5-flash → 2.0-flash → flash-latest → 2.0-flash-lite`).

---

## 9. Para Kazanma (Monetization)

- **3 günlük ücretsiz deneme** (anket bitince otomatik başlar).
- Deneme dolunca **sert paywall** devreye girer.
- **Google Play Billing** ile haftalık (`riseup_pro_weekly`) ve aylık (`riseup_pro_monthly`) abonelik.
- Satın alma/geri yükleme başarılı olunca `isPro=true` yapılır ve buluta senkronlanır.
- ⚠️ **Not (koddaki uyarı):** Üretimde satın alma Play Developer API ile **sunucu tarafında doğrulanmalı**; şu an istemci tarafı kabul ediliyor.

---

## 10. Özet Akış Şeması

```
Kullanıcı                 Uygulama                      Firebase/Gemini
   │                         │                                │
   │── açılış ──────────────▶│── anonim giriş ───────────────▶│ Auth
   │                         │── bulut verisi indir ─────────▶│ Firestore
   │── anket doldur ────────▶│── IntakeProfile kaydet         │
   │                         │── görevleri üret (TaskGen)     │
   │── foto yükle ──────────▶│── analyzeImage proxy ─────────▶│ Cloud Fn → Gemini
   │                         │◀─ skorlar + öneriler ──────────│
   │                         │── görevleri zenginleştir       │
   │── görev tamamla ───────▶│── +XP, +streak, geçmiş         │
   │                         │── arka planda push ───────────▶│ Firestore
   │── 3 gün sonra ─────────▶│── PAYWALL                      │
   │── PRO satın al ────────▶│── Play Billing ── isPro=true   │
```

---

## 11. Çözülen Sorunlar (2026-06-30)

1. **✅ API anahtarı güvenlik açığı kapatıldı.** Kaynak koda gömülü gerçek Gemini
   anahtarı (`ApiConfig.defaultGeminiKey`) kaldırıldı (artık boş string). Hem foto
   analizi hem de **sohbet (`chat`)** çağrıları artık **Cloud Function proxy**
   üzerinden gider; gerçek anahtar yalnızca Firebase Secret (`GEMINI_KEY`) içinde
   tutulur ve APK'ya hiç inmez. Kullanıcıdan **API anahtarı istenmez** —
   ayarlardaki ve analiz ekranındaki anahtar giriş diyalogları ile gereksiz
   `apiKeyProvider` kaldırıldı. (Kullanıcı yine de proxy kapalıyken çalışacak
   isteğe bağlı kendi anahtarını güvenli depoya girebilir, ama bu artık UI'da
   istenmiyor.)
2. **✅ Streak tarih hatası düzeltildi.** `lastTaskDate` sıfır dolgusuz formatta
   (`2026-6-30`) yazılıp `DateTime.parse` ile okununca exception fırlatıyordu.
   Artık tarih `YYYY-MM-DD` formatında yazılıyor, güvenli `_parseDateKey` ile
   ayrıştırılıyor, gün başına sabitlenerek karşılaştırılıyor ve `diff==0` (aynı
   gün) açıkça ele alınıyor.
3. **✅ Equatable kısıtı giderildi.** `IntakeProfile.props` artık tüm profil
   alanlarını içerir; farklı profiller yanlışlıkla eşit sayılmaz.

## 12. Kalan Teknik Borç

1. **İsimlendirme tutarsızlığı:** `ClaudeApiService` ve `claude_api_service.dart`
   aslında **Gemini** kullanır — yanıltıcı (işlevsel sorun değil).
2. **İstemci tarafı satın alma doğrulaması:** Play Developer API ile sunucu
   tarafı doğrulama henüz yok (kodda not düşülmüş).
```
