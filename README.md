# Dating Asistanı Uygulaması — Build Spesifikasyonu

Bu doküman, uygulamanın onboarding akışını, sorularını, modüllerini ve giriş sonrası özelliklerini ekran ekran tanımlar. Amaç: Claude'un (veya herhangi bir geliştiricinin) bu dokümanı okuyarak uygulamayı baştan sona kurabilmesidir.

---

## 0. Genel Konsept

Kullanıcının dating uygulamalarında (Tinder, Bumble, Hinge) daha fazla eşleşme almasını sağlayan bir **AI dating asistanı**. Uygulama 6 modül sunar: AI dating fotoğrafı üretimi, fotoğraf analizi & seçimi, dating coach (sohbet koçluğu), RizzGPT (esprili cevaplar), bio & prompt yardımcısı ve looksmaxxing (yüz & vücut iyileştirme önerileri).

Onboarding, klasik "quiz funnel" mantığında çalışır: **önce değer ve sosyal kanıt göster → kullanıcıyı küçük sorularla içeri çek → giriş al → kişisel sonuç → paywall.**

### Teknik

- **Platform:** Flutter (iOS + Android tek kod tabanı)
- **State yönetimi:** Provider veya Riverpod (tercih Riverpod)
- **Navigasyon:** Onboarding tek yönlü stack; her ekranda üstte ilerleme çubuğu (progress bar)
- **Giriş:** Girişsiz kullanım. Uygulamanın ücretsiz/keşif kısmı hesap gerektirmez. Giriş (Apple + Google) **yalnızca abonelik satın alma anında** istenir. Email/şifre YOK.
- **Gelir modeli:** Abonelik (haftalık / aylık). Paywall funnel sonunda. **Giriş ↔ abonelik birbirine bağlıdır:** ücretsiz gezen kullanıcı hesap açmaz; ödeme yapan kullanıcı hesap açar.

### Temel Tasarım Prensipleri (ZORUNLU)

1. **Kullanıcı asla klavye açmaz.** Tüm girişler buton, çoklu seçim, kaydırma veya seçici (picker) ile yapılır. Metin girişi yok.
2. **Her ekranda tek bir net eylem** vardır: altta büyük bir "Devam Et" / "Continue" butonu.
3. Üstte **ilerleme çubuğu** her adımda dolar ("az kaldı" hissi).
4. Ekranlar sade, tek odaklı, hızlı geçişli.
5. Grafikler (bar chart) animasyonlu şekilde aşağıdan yukarı dolarak gelir.
6. **Tüm grafik/istatistik verileri temsilidir** (gerçek ölçüm değil). Bu yüzden grafiklerin görünür bir yerinde küçük ve okunur bir **"*Temsili veriler"** notu bulunur. (Yasal koruma + dürüstlük için zorunlu.)

---

## 1. ONBOARDING AKIŞI (Ekran Ekran)

> **NOT:** Mevcut "Seni Tanıyalım" sayfası ve şu anki tüm form yapısı **tamamen kaldırılacak.** Aşağıdaki yeni akış onun yerine gelir.

### Ekran 1 — Karşılama / Açılış

- Başlık: **"Hoş geldiniz — Daha fazla eşleşme alın"**
- Alt metin: "Bumble, Tinder ve Hinge'de daha fazla eşleşme almak için ilk adımı atın."
- Altta büyük buton: **"Haydi Başlayalım"**
- Tıklanınca → Ekran 2

### Ekran 2 — Problem Kurulumu + Bar Grafiği (İstatistik)

- Üstte metin: "Bugün dating uygulamaları, insanların tanışması için 1 numaralı araç. İnsanların bu şekilde tanıştığı ilk jenerasyonda yaşıyoruz."
- Ortada **bar grafiği**: "İnsanlar birbiriyle nereden tanışıyor?" — yüzdelerle, en yüksekten aşağı sıralı:
  - Dating uygulamaları — %XX (1. sıra)
  - Instagram / sosyal medya — %XX
  - Arkadaş aracılığıyla — %XX
  - İş / okul — %XX
  - Diğer — %XX
  - (Yüzdeler animasyonlu dolar. Gerçekçi değerler kullan, "top uygulama" ilk sırada.)
- Altta: **"Devam Et"** → Ekran 3

### Ekran 3 — Acı Nokta: Uygulama İkonları + Frustrasyon İstatistiği

- Ortada üç uygulama ikonu yan yana: **Bumble, Tinder, Hinge**
- Altında metin: "Ama bu dating uygulamalarında bir gerçek var: kullanıcıların **%89'u hayal kırıklığına uğramış** durumda (ölçümlere göre)."
- (İngilizce orijinal fikir "89% frustrated according to measure" → Türkçeye çevrilmiş hali kullanılacak.)
- Altta: **"Devam Et"** → Ekran 4

### Ekran 4 — Acı Nokta: Rekabet Gerçeği + Grafik

- Metin: "Top bir dating profiline sahip olmadığın sürece bu markette başarı elde edemiyorsun. Eşleşmeler en iyi profillere gidiyor."
- **Farklı bir grafik**: Örneğin "Eşleşmelerin dağılımı" — üstteki %10'luk profillerin eşleşmelerin %XX'ini aldığını gösteren bir bar/pasta grafiği.
- Altta: **"Devam Et"** → Ekran 5

### Ekran 5 — Çözüm: Biz Buradayız

- Ortada **bizim uygulama ikonumuz / logomuz**
- Metin: "İşte tam bu yüzden buradayız. Seni bu marketin en üstüne taşımak için."
- Altta: **"Devam Et"** → Ekran 6

### Ekran 6 — Ne Yapıyoruz (Örnek İşler)

- Bizim yaptığımız işlerin (önce/sonra profil örnekleri, düzenlenmiş fotoğraflar, geliştirilmiş bio'lar) gösterildiği ekran + açıklayıcı yazılar.
- **ÖNEMLİ (revizyon):** Önceki fikir 3-4 ayrı sayfaydı. Kullanıcı düşmesini önlemek için bunu **tek ekranda 3-4 örnek** olarak sıkıştır (yatay kaydırılabilir kart / carousel). Her kartta kısa bir "önce → sonra" görseli ve tek satır açıklama.
- Altta: **"Devam Et"** → Ekran 7 (Sorular)

---

## 2. SORULAR (Quiz Bölümü)

Geçiş metni: "Şimdi sana birkaç soru soralım — sana en uygun deneyimi hazırlayabilmemiz için."

Tüm sorular **butonla** cevaplanır. Klavye asla açılmaz. Her soruda üstteki ilerleme çubuğu dolar.

### Soru 1 — Cinsiyet
- Seçenekler: **Erkek** / **Kadın**
- (İstersen "Belirtmek istemiyorum" 3. seçenek olarak eklenebilir — opsiyonel.)

### Soru 2 — Yaş Aralığı (butonlarla)
- **Under 18 (18 yaş altı)**
- 18–24
- 25–34
- 35–44
- 45–54
- 55–64
- **64+**
- ⚠️ **Güvenlik notu:** "Under 18" seçilirse akış durur. Nazik bir ekran: "Bu uygulama 18 yaş ve üzeri kullanıcılar içindir." Kullanıcı akışa devam ettirilmez. (App Store / Google Play uyumu için zorunlu.)

### Soru 3 — En Çok Kullandığın Dating Uygulaması (ÇOKLU SEÇİM)
- Alt alta listelenir, kullanıcı birden fazla seçebilir:
  - Tinder
  - Bumble
  - Hinge
  - Badoo
  - OkCupid
  - Coffee Meets Bagel
  - Grindr
  - Diğer
- Altta: **"Devam Et"**

### Soru 4 — Günde Kaç Eşleşme Alıyorsun? (4 seçenek)
- **Hiç yok / 1 tane bile değil**
- Günlük 1–2
- Günlük 3–10
- Günlük 10+

### Ekran — Önce/Sonra Grafiği (Sonuç Vaadi)
- Soru 4'ten sonra: "Bizden önce" vs "Bizimle birlikte" karşılaştırmalı bar grafiği.
- Vurgulanan mesaj: **"Bizimle birlikte 7.4x daha fazla eşleşme."**
- Animasyonlu: "bizimle" barı dramatik şekilde yukarı fırlar.
- Altta: **"Devam Et"**

### Ekran — Bildirimleri Aç
- "Yeni eşleşme fırsatlarını ve profil önerilerini kaçırma."
- Sistem bildirim izni istenir (Flutter `permission_handler` / `firebase_messaging`).
- (Konum: kullanıcı ilk değeri gördükten sonra — bu yüzden burada, çok erken değil.)
- Altta: **"Devam Et"**

### Soru 5 — Dating Deneyiminden Memnun musun? (4 şık)
- Hiç memnun değilim
- Pek memnun değilim
- İdare eder
- Memnunum

### Ekran — "Top %1'e Gir" + Yorum
- Metin: "Bizimle birlikte dating marketinin **top %1'ine** gir."
- Altında **5 yıldız** + gerçekçi bir kullanıcı yorumu (sosyal kanıt).
  - Örn: "İlk haftada eşleşmelerim ikiye katlandı. — Kaan, 27"
- Altta: **"Devam Et"**

---

## 3. GİRİŞ MANTIĞI (Girişsiz Kullanım — Giriş Sadece Abonelikte)

> **Karar:** Uygulamanın ücretsiz/keşif kısmı tamamen **girişsiz** çalışır. Kullanıcı onboarding'i, soruları, modül vitrinini hesap açmadan gezer. Giriş **yalnızca abonelik satın alma anında** istenir.

### Neden böyle?
- **Sürtünme minimum:** Ücretsiz gezen kullanıcı hesap ekranıyla karşılaşmaz, düşme oranı düşer.
- **Ödeme = hesap:** Asıl korunması gereken şey (abonelik + kullanıcının ürettiği fotoğraflar/analizler) ödeme yapan kullanıcıda başlar. Giriş de tam oraya konur.
- **Abonelik senkronizasyonu:** Hesap, aboneliği cihaza değil kullanıcıya bağlar — cihaz değişimi, yeniden kurulum, restore durumlarını çözer.

### Ekran — Giriş (Paywall'ın İçinde Tetiklenir)
- Kullanıcı paywall'da bir plan seçip "Devam Et / Abone Ol" dediğinde **önce giriş** ekranı gelir, sonra ödeme.
- Kısa başlık: "Aboneliğini güvenle sakla — hesabını oluştur."
- İki buton:
  - **Apple ile Giriş Yap** (iOS'ta zorunlu — `sign_in_with_apple`)
  - **Google ile Giriş Yap** (`google_sign_in`)
- Email/şifre YOK.
- Giriş başarılı → ödeme akışı (`in_app_purchase` / RevenueCat) → aboneli kullanıcı deneyimi açılır.

### Girişsiz gezerken sınır nerede?
- Onboarding, sorular, sonuç grafikleri, modül vitrini → **girişsiz.**
- Bir modülü gerçekten **kullanmak** (AI foto üretmek, analiz almak, coach'a sormak) → **abonelik gerekir → giriş gerekir.**
- Yani doğal sınır: "gezmek serbest, kullanmak abonelik+giriş."

---

## 4. "SENİN İÇİN HAZIRLIYORUZ" + MODÜLLER

> Bu bölüm **girişsiz** gösterilir. Kullanıcı henüz hesap açmadı; sadece geziyor ve değeri görüyor.

### Ekran — Hazırlanıyor (Loading / Kişiselleştirme)
- "Senin için hazırlıyoruz…" animasyonlu yükleniyor ekranı.
- Sahte de olsa "Profilin analiz ediliyor…", "Fotoğraf önerileri hesaplanıyor…" gibi ilerleme adımları (algılanan değeri artırır).
- Sonra → Modüller ekranı

### Ekran — Modüllerimiz (Özellik Vitrini)
- **Sol üstte kapatma (X) butonu** olacak — kullanıcı bu ekranı kapatabilsin.
- "Bunlar bizim modüllerimiz" başlığı.
- Aşağıdaki modüller kart/liste halinde, her biri kısa açıklamayla gösterilir:
  1. **AI Dating Fotoğrafı Üretimi** — Kendi fotoğrafından farklı stillerde çekici dating fotoğrafları oluştur (uygulamanın yıldız özelliği).
  2. **Fotoğraf Analizi & Seçimi** — Fotoğraflarını puanlar, çekicilik skoru verir, en iyi olanları önerir. (Eski "Dating Photos Seçimi" + "Fotoğraf Analizi" + "Çekicilik Skoru" tek modülde birleşti.)
  3. **Dating Coach** — Sohbet & strateji koçluğu; konuşmalarında ne yazacağın konusunda yönlendirir.
  4. **RizzGPT — Witty Replies** — Konuşma/mesaj için hazır, esprili ve çekici cevap önerileri (yüksek viral potansiyel).
  5. **Bio & Prompt Yardımcısı** — Bio ve Hinge prompt'larını yazar ve geliştirir, geri bildirim verir. (Eski "Prompt/Bio" + "Prompt Feedback" birleşti.)
  6. **Looksmaxxing — Yüz & Vücut Analizi** — Yüz ve vücut için yapıcı iyileştirme önerileri sunar (puan/skor vermez; Umax vb. popüler uygulamalar gibi öneri odaklı).
- Her modülün detayları kullanıcıya gösterilir (tıklayınca kısa açıklama açılır).

> **Modül sadeleştirmesi (karar):** İlk lansmanda **6 modül** var. Önceki 10 modüldeki tekrarlar birleştirildi (fotoğrafla ilgili 3 modül → 1; prompt/bio ile ilgili 2 modül → 1). **Backlog (sonraki sürümler):** Dating Profile Reviewer (tüm çıktıları birleştiren özet skor), Hotel Lounge/Fashion/Luxury vb. ek foto stilleri. Az ama iyi çalışan modüllerle çıkmak, her birini kaliteli tutmayı ve kullanıcıyı yormamayı sağlar.

---

## 5. PAYWALL (Abonelik)

> Gelir modeli abonelik olduğu için paywall funnel'ın kalbidir.

### Ekran — Abonelik

> **Paywall yeri (karar):** Paywall **modül vitrininin hemen ardından, ana dönüşüm anı olarak bir kez** gösterilir. Kullanıcı bunu sol üstteki X ile kapatabilir (zorlama yok). Kapatırsa uygulamada gezmeye devam eder ama **herhangi bir modülü kullanmaya kalkınca paywall tekrar açılır** (soft gate). Yani iki tetikleyici var: (1) vitrin sonrası ilk gösterim, (2) bir modülü kullanma denemesi. Bu ikili yapı, hem yüksek niyetli kullanıcıyı hemen yakalar hem de kararsız olana keşif alanı bırakır.

- Modüller vitrininden sonra (veya bir modülü kullanmaya çalışınca) paywall gelir.
- Paketler (piyasa referansı: kategori lideri Rizz ~$7/hafta veya ~$20/ay, ilk hafta ücretsiz; güncel kur ~1 USD = 46.8 TL):
  - **Haftalık plan:** ~₺299–349
  - **Aylık plan:** ~₺899–999 (indirimli / "en popüler" rozetli — haftalığa göre daha avantajlı gösterilir)
  - (App Store / Play fiyat basamaklarına göre yuvarlanır. Fiyatlar launch öncesi netleştirilir — Bölüm 8.)
- **Ücretsiz deneme:** 3 günlük ücretsiz deneme sunulur (kategori standardı, dönüşümü ciddi artırır). Deneme süresince AI foto üretimi sınırlıdır (ör. tek üretim) — asıl maliyet orada olduğu için.
- "Top %1'e katıl", özellik listesi, sosyal kanıt tekrar burada gösterilir.
- Kapatma butonu (X) sol üstte — zorlamadan.

### Ücretsiz (Abonesiz) Sürüm — ÇOK KISITLI
> **Karar:** Ücretsiz sürümde erişim çok kısıtlıdır. Amaç: kullanıcı değeri görsün ama gerçek faydayı yalnızca abone olunca alsın.

- Ücretsiz kullanıcı **sadece gezebilir:** onboarding, sorular, sonuç grafikleri, modül vitrini ve her modülün örnek (önce/sonra) boş durum ekranları.
- **Hiçbir modülü çalıştıramaz:** AI foto üretimi, fotoğraf analizi, looksmaxxing, coach, rizz, bio — hepsi abonelik ister.
- Bir modülü kullanmaya kalkınca → paywall (soft gate).
- İstisna: yalnızca deneme (trial) başlatan kullanıcı, deneme kurallarına göre sınırlı kullanım alır.

### Paywall → Giriş → Ödeme akışı (SIRALAMA ÖNEMLİ)
1. Kullanıcı plan seçip **"Abone Ol"** der.
2. **Giriş ekranı** açılır (Apple + Google). Buradan önce hesap YOK.
3. Giriş başarılı olunca **ödeme** başlar: `in_app_purchase` (Flutter) veya **RevenueCat** (önerilen — abonelik durumunu hesapla senkronlar).
4. Ödeme tamam → abonelik hesaba bağlanır → tüm modüller açılır.
- **"Restore Purchases"** butonu da bu ekranda olmalı (App Store zorunluluğu): cihaz değiştiren kullanıcı giriş yapıp aboneliğini geri yükler.

---

## 6. GİRİŞ SONRASI ÇEKİRDEK ÖZELLİKLER

Kullanıcı giriş yapıp (ve/veya abone olup) uygulamaya girince şu 6 modül aktif olur:

### 6.1 Fotoğraf Analizi & Seçimi
- Kullanıcı fotoğraflarını yükler.
- AI her fotoğrafı puanlar, çekicilik skoru verir, güçlü/zayıf yönleri belirtir ve en iyi olanları önerir.
- (Eski ayrı "profil analizi", "fotoğraf analizi", "çekicilik skoru" tek yerde.)

### 6.2 Chat Koçluğu (Dating Coach)
- Kullanıcı gerçek konuşma ekran görüntüsü yükleyebilir veya durumu anlatabilir.
- AI, ne cevap yazması gerektiği konusunda koçluk yapar.

### 6.3 AI Dating Fotoğrafı Üretimi
Kullanıcının kendi fotoğraflarından farklı **tarz/tema** seçenekleriyle, ona **gerçekten benzeyen** AI dating fotoğrafları oluşturulur.

**Akış (kimlik benzerliği için kritik):**
1. **Birkaç foto seç (3-5 adet):** Kullanıcı galeriden **çoklu seçimle, tek adımda** 3-5 fotoğrafını seçer. Tek tek yükleme yok — galeri bir kez açılır, hepsi bir dokunuşta seçilir (sürtünme minimum).
   - Neden 3-5: Tek foto benzerlik için yetersiz kalır; 8-15 ise kullanıcıyı yorup terk ettirir. 3-5, "kolay seçim" ile "kullanıcıya benzeyen sonuç" arasındaki tatlı noktadır.
   - Yükleme ekranında kalite rehberi gösterilir (bkz. 6.8b): net, iyi ışıklı, yüz görünür fotolar.
2. **Model hazırlanıyor:** Seçilen fotolarla kişiselleştirme/hazırlık yapılır. Burada gerçek bir bekleme vardır → 6.8'deki yükleme deneyimi kullanılır (ilerleme yüzdesi + akan durum metinleri: "Fotoların işleniyor…", "Yüz hatların öğreniliyor…").
3. **Stil seç & üret:** Kullanıcı bir veya birkaç stil seçip "Oluştur" der; sonuç fotoları üretilir.

**İlk lansmanda (çekirdek 7 stil):**
- Elegance / Karizma (şık)
- Athletic (atletik)
- World Traveller (dünya gezgini)
- Old Money (klasik varlık estetiği)
- Night Out (gece çıkışı)
- Beach Body (plaj / fit vücut)
- Car (arabayla)

**Sonraki sürümlerde eklenecek (backlog):** Hotel Lounge, Köpek Sevgisi (evcil hayvan teması), Fashion, Zenginlik/Luxury, Boxer, Motor.

> **Neden az stille başlıyoruz:** Çok seçenek kullanıcıyı yorar ve karar felcine sokar. 7 güçlü, net stille başlamak hem daha iyi bir deneyim verir hem de her stili kaliteli tutmayı kolaylaştırır. (Her stil bir kart olarak seçilir.)

> **Kimlik benzerliği (identity preservation) — kritik teknik risk:** Üretilen fotoğrafın kullanıcıya benzemesi bu modülün başarısını belirler. Benzemezse kullanıcı hem terk eder hem de gerçek buluşmada güven sorunu yaşar (itibar riski). Çoklu foto + kişiselleştirme adımı tam da bu yüzden vardır.

**Model/servis seçimi (piyasa araştırmasına dayalı — launch öncesi güncel fiyatları teyit et):**
- Piyasadaki en iyi dating foto uygulamaları (DatePhotos.AI vb.) **Flux LoRA** mimarisi kullanıyor: kullanıcının selfie'leriyle ona özel bir model eğitiliyor. Bu uygulamalar tipik olarak **8-15 kaynak fotoğraf** ister — çünkü çok foto = daha iyi benzerlik.
- **Ama biz 3-5 foto + düşük sürtünme seçtik.** Bu yüzden klasik LoRA yerine **kimlik-adaptörü yolu (InstantID / PuLID tarzı)** önerilir: model eğitimi yok, yüz embedding'i her üretime uygulanır, az fotoyla (hatta 1-3) çalışır, anında ve daha ucuzdur. FreshFrame gibi "kimlik-öncelikli" uygulamalar bu mantıkta yürüyor.
- **İki yol:**
  - **Yol A — LoRA eğitimi:** En yüksek benzerlik, ama daha çok foto (ideal 8-15) ve ~15-20 dk eğitim. Maliyet ~$0.025/görsel + eğitim.
  - **Yol B — Kimlik adaptörü (ÖNERİLEN başlangıç):** 3-5 fotoyla çalışır, anında, ucuz. Benzerlik LoRA kadar mükemmel olmayabilir.
- **Strateji:** Yol B ile başla; kalite yetersiz kalırsa "premium" bir seçenek olarak Yol A'yı (LoRA) ekle.
- **Base model:** fal.ai üzerinden Flux ekosistemi (Flux 2 Pro fotorealizmde güçlü). Görüntü başına maliyet ~$0.02–0.055 arası, seçilen modele göre.
- Metin işlemleri (coach / rizz / bio) için ayrı bir LLM kullanılır.

> **NOT (8-15 foto sorusu):** Evet, en iyi çıktı veren uygulamalar genelde 8-15 foto ister. Biz bilinçli olarak 3-5 ile gidiyoruz (sürtünme için) ve bunu telafi etmek için kimlik-adaptörü yolunu seçiyoruz. Eğer benzerlik testlerinde sonuç zayıf çıkarsa, istenen foto sayısını 6-8'e çıkarmak ilk ayar noktası olmalı.

### 6.4 Looksmaxxing — Yüz & Vücut Analizi (Ayrı Bölüm)
- **Yüz analizi:** yüz oranları, simetri, çene, ten vb. üzerinden **yapıcı iyileştirme önerileri.**
- **Vücut analizi:** fizik değerlendirmesi ve iyileştirme önerileri.
- **PUAN/SKOR VERİLMEZ.** Modül kullanıcıyı puanlamaz; yalnızca somut, uygulanabilir iyileştirme önerileri sunar (Umax vb. popüler uygulamaların öneri odaklı yaklaşımı gibi). Bu hem etik açıdan daha sağlıklı hem de App Store onayı için daha güvenli.
- Bu bölüm kendi ekranında (fotoğraf yükle → analiz → öneriler).

### 6.5 Bio & Prompt Yardımcısı
- Kullanıcının bio ve Hinge prompt'larını yazar/geliştirir ve geri bildirim verir.

### 6.6 RizzGPT — Witty Replies
- Konuşma ekran görüntüsü / mesaj → esprili, çekici cevap önerileri.

### 6.7 Boş Durum & İlk Kullanım (TÜM MODÜLLER İÇİN — ZORUNLU)

> Kullanıcı abone olup içeri ilk girdiğinde ne göreceği kritik. Boş bir "fotoğraf yükle" ekranı terk oranını yükseltir. Bu yüzden **her modül**, kullanıcı henüz hiçbir şey yüklemeden önce değer gösteren bir **boş durum (empty state)** ekranına sahiptir.

Her modülün boş durumunda şunlar bulunur:
- **Kısa "nasıl çalışır" anlatımı:** 1-2 cümle + küçük bir görsel adım (yükle → analiz → sonuç).
- **Önce/Sonra örneği:** Modülün ne ürettiğini gösteren gerçek bir örnek. Örn:
  - AI Foto → örnek bir "önce" fotoğraf ve üretilmiş "sonra" fotoğrafı.
  - Fotoğraf Analizi → örnek bir analiz kartı (öne çıkanlar, öneriler).
  - Coach / RizzGPT → örnek bir konuşma ve önerilen cevap.
  - Bio & Prompt → zayıf bir bio ve geliştirilmiş hali.
  - Looksmaxxing → örnek iyileştirme önerileri (puansız).
- **Net başlangıç butonu:** "Fotoğrafını Yükle" / "Başla" gibi tek çağrı.
- Amaç: kullanıcı daha ilk saniyede "bu modül bana ne verecek" görsün ve hemen değeri hissetsin.

### 6.8 Sonuç Bekleme / Yükleme Deneyimi (ZORUNLU)

> AI foto üretimi ve analizler saniyeler sürer. Kötü tasarlanmış bir bekleme ekranı "takıldı mı?" hissi verir ve kullanıcı çıkar. Onboarding'deki "Senin için hazırlıyoruz" animasyonunun aynısı burada da kullanılır.

Her AI işleminde (foto üretimi, fotoğraf analizi, looksmaxxing, coach/rizz yanıtı):
- **İlerleme yüzdesi / dolan çubuk:** %0 → %100 dolan bir gösterge (gerçek ilerleme yoksa bile tahmini/animasyonlu doluş).
- **Adım adım durum metinleri:** işlem türüne göre değişen, akan yazılar. Örn foto üretiminde: "Fotoğrafın hazırlanıyor…" → "Stil uygulanıyor…" → "Son rötuşlar…". Analizde: "Yüz hatları inceleniyor…" → "Öneriler hazırlanıyor…".
- **Görsel süreklilik:** onboarding'deki hazırlanıyor ekranıyla aynı animasyon dili (tutarlı marka hissi).
- **Hata durumu:** işlem başarısız olursa net ve nazik bir mesaj + "Tekrar Dene" butonu (kullanıcı asla boş/donuk ekranda kalmaz).
- **Tahmini süre hissi:** kullanıcı beklerken "genelde ~10 saniye sürer" gibi bir ipucu, belirsizliği azaltır.

### 6.8b Fotoğraf Yükleme Kalitesi Rehberi (ZORUNLU)

> AI foto ve analiz sonuçları, girdi fotoğrafın kalitesine doğrudan bağlıdır. Kullanıcı bulanık/karanlık foto yüklerse sonuç kötü olur ve kullanıcı bunu ürünü suçlayarak yorumlar. Bu yüzden fotoğraf isteyen her modülde yükleme öncesi kısa bir kalite rehberi gösterilir.

- **Yükleme ekranında kısa rehber:** "En iyi sonuç için: net, iyi ışıklı, yüzün açıkça göründüğü bir fotoğraf seç. Filtreli, bulanık veya çok karanlık fotoğraflardan kaçın."
- **Görsel örnekler:** İyi ✅ / kötü ❌ örnek küçük görseller (net vs bulanık, iyi ışık vs karanlık, yüz görünür vs kapalı).
- **Otomatik kalite uyarısı (opsiyonel, güçlü):** Yüklenen foto çok düşük çözünürlük/karanlık/yüz algılanamıyorsa, işlem başlamadan nazik bir uyarı: "Bu fotoğraf sonucu düşürebilir. Yine de devam et / başka foto seç." Bu, hem memnuniyeti hem de boşa kredi harcanmasını önler.
- Bu rehber özellikle şu modüllerde: AI Foto Üretimi, Fotoğraf Analizi & Seçimi, Looksmaxxing.

---

## 6.9 Kredi & Kullanım Limiti Sistemi (ZORUNLU)

> AI foto üretimi ve analizler sana para (API maliyeti) mal olur. Sınırsız kullanım maliyeti kontrolden çıkarır. Bu yüzden abonelik bir **aylık kredi havuzu** ile gelir.

- **Kredi havuzu:** Abonelik her yenilendiğinde kullanıcıya plana göre kredi verilir (kesin değerler aşağıda). Haftalık ve aylık planların kredi miktarı farklıdır.
- **Kredi harcama (önerilen başlangıç değerleri — gerçek API maliyetiyle kalibre edilecek):**
  - AI foto üretimi → **10 kredi** (en pahalı işlem; API maliyeti ~$0.02–0.055/görsel)
  - Looksmaxxing / fotoğraf analizi → **3 kredi**
  - Coach / RizzGPT / bio yanıtı → **1 kredi** (metin işlemleri, ~$0.001–0.01/çağrı)
- **Plan başına aylık kredi havuzu (önerilen):**
  - Haftalık plan → haftada ~150 kredi
  - Aylık plan → ayda ~600–700 kredi
  - (Normal kullanıcıya "sınırsız gibi" hissettirir, ama suistimali ve maliyet patlamasını kapar. Fiyat/kredi dengesi çok cimri olursa App Store puanı düşer — dengeyi koru.)
- **Ücretsiz (abonesiz) sürüm:** Kredisi yoktur / sıfırdır. Hiçbir AI işlemi çalıştıramaz (bkz. Bölüm 5). Yalnızca deneme başlatan kullanıcı sınırlı kredi/kullanım alır.
- **Bakiye görünürlüğü:** Kalan kredi her zaman görünür (üst köşede sayaç). İşlem öncesi "bu X kredi harcayacak" bilgisi gösterilir.
- **Kredi bitince:** Nazik bir ekran — "Kredin bitti. Yenilenmesini bekle veya ek kredi al." Kullanıcı boş ekranda kalmaz.
- **Ek gelir kapısı (backlog):** İleride "kredi paketi" satışı (tek seferlik ek kredi) ek gelir modeli olarak açılabilir. Mimariyi baştan buna uygun kur (krediler abonelikten bağımsız artırılabilir olmalı).
- **Yenilenme:** Krediler her fatura döneminde sıfırlanıp yeniden yüklenir (devretmez — maliyet öngörülebilirliği için).

---

## 7. AKIŞ ÖZETİ (Hızlı Referans)


```
1.  Karşılama → "Haydi Başlayalım"
2.  İstatistik + bar grafiği (nereden tanışıyoruz)
3.  Bumble/Tinder/Hinge ikonları + %89 frustrasyon
4.  Rekabet gerçeği + grafik
5.  "Biz buradayız" + logo
6.  Örnek işlerimiz (tek ekran, carousel)
7.  Soru: Cinsiyet
8.  Soru: Yaş aralığı (Under 18 → durdur)
9.  Soru: Dating uygulamaları (çoklu seçim)
10. Soru: Günlük eşleşme sayısı
11. Önce/Sonra grafiği (7.4x)
12. Bildirimleri aç
13. Soru: Memnuniyet (4 şık)
14. "Top %1'e gir" + 5 yıldız yorum
15. "Senin için hazırlıyoruz" (loading)        ← girişsiz
16. Modüller vitrini (sol üstte X)             ← girişsiz gezilir
17. Paywall (haftalık / aylık)                 ← "Abone Ol" deyince ↓
18.   → GİRİŞ (Apple + Google)                 ← giriş TAM BURADA
19.   → Ödeme (in_app_purchase / RevenueCat)
20. Uygulama içi (6 modül): AI foto üretimi, fotoğraf analizi & seçimi, coach, rizz, bio & prompt, looksmaxxing
21. Ayarlar: gizlilik, şartlar, abonelik yönet, restore, hesap/veri sil
```

> **Kural:** 1–16 arası girişsiz. Giriş sadece 17→18 geçişinde, abone olmaya karar verince. Ücretsiz gezmek serbest; bir modülü kullanmak için abonelik + giriş şart.

---

## 8. AÇIK / KARARLAŞTIRILACAK NOKTALAR

- Fiyatlar ve AI model maliyetleri sık değişir → **launch öncesi güncel piyasa fiyatlarını ve kuru teyit et.** (Bu README'deki rakamlar ~1 USD = 46.8 TL kuruna ve mevcut piyasa referanslarına dayanır.)
- Kimlik-adaptörü (Yol B) benzerlik testlerinde yetersiz kalırsa: istenen foto sayısını 6-8'e çıkarmak veya LoRA'ya (Yol A) geçmek.
- Kredi değerlerinin gerçek API maliyetiyle son kalibrasyonu.

> **Çözülen kararlar:**
> - Giriş → girişsiz kullanım, giriş sadece abonelik anında (Apple + Google). (Bölüm 3)
> - Grafik verileri → **temsili**, "*Temsili veriler" notuyla. (Bölüm 0)
> - Paywall yeri → **modül vitrini sonrası bir kez + modül kullanımında soft gate**. (Bölüm 5)
> - Modül sayısı → 10'dan **6'ya** indirildi, tekrarlar birleşti. (Bölüm 4)
> - Foto stilleri → **7 çekirdek stil** ile başla, gerisi backlog. (Bölüm 6.3)
> - AI foto akışı → **3-5 foto çoklu seçim → model hazırlanıyor → üret**; model olarak **kimlik-adaptörü (Yol B) başlangıç**. (Bölüm 6.3)
> - Looksmaxxing → **puan vermez**, sadece iyileştirme önerileri. (Bölüm 6.4)
> - Abonelik → **Haftalık ~₺299–349 / Aylık ~₺899–999**, 3 günlük ücretsiz deneme. (Bölüm 5)
> - Ücretsiz sürüm → **çok kısıtlı**, sadece gezme; modül kullanımı yok. (Bölüm 5)
> - Kredi değerleri → foto 10 / analiz 3 / metin 1 kredi; havuz plana göre. (Bölüm 6.9)
> - Boş durum + yükleme deneyimi eklendi. (Bölüm 6.7 / 6.8)
> - Gizlilik → politika, rıza, veri silme, ayarlar ekranı uygulamaya dahil. (Bölüm 9)
> - "Under 18" → akış durdurulur. (Bölüm 2)

---

## 9. GÜVENLİK, GİZLİLİK & UYUMLULUK

### Genel
- Uygulama **18+**. Yaş kapısı zorunlu ("Under 18" → durdur).
- iOS: üçüncü parti giriş varsa **Apple ile Giriş zorunlu**.
- **Looksmaxxing puan/skor VERMEZ**, yalnızca yapıcı iyileştirme önerileri sunar (Umax vb. gibi). Kullanıcıyı fiziksel olarak puanlamak hem etik açıdan sakıncalı hem de App Store onayında risklidir. Dil daima teşvik edici ve koçvari olmalı; aşağılayıcı/utandırıcı ifadelerden ve "kusur" dilinden kaçınılmalı. Bu bir tıbbi/kesin değerlendirme değildir; ekranda kısa bir sorumluluk reddi bulunmalı.

### Gizlilik (uygulamaya DAHİL edilecek)
Uygulama fotoğraf ve yüz/vücut verisi işlediği için gizlilik en baştan tasarıma girer:

- **Gizlilik Politikası ve Kullanım Şartları:** Ayarlar ekranından her zaman erişilebilir; ayrıca ilk giriş/abonelik anında kullanıcı onayı alınır. Metinler uygulama içinde açılabilir (in-app WebView veya sayfa).
- **Veri işleme aydınlatması:** Fotoğraf yüklerken kısa bir bilgilendirme: "Fotoğrafların yalnızca analiz/üretim için işlenir." Kullanıcı ne için, ne kadar süre saklandığını görebilmeli.
- **Rıza (consent):** Fotoğraf/biyometrik benzeri veri için açık rıza kutusu. Bildirim izni ayrı istenir.
- **Veri silme hakkı:** Ayarlarda **"Hesabımı ve verilerimi sil"** butonu (GDPR/KVKK + App Store gereği). Kullanıcı fotoğraflarını ve hesabını kalıcı silebilmeli.
- **Veri saklama:** AI üretilen fotoğraflar ve analizler kullanıcı hesabında saklanır; kullanıcı istediğinde tek tek silebilir.
- **Üçüncü parti işleme şeffaflığı:** AI üretimi/analizi harici bir servise gidiyorsa (model sağlayıcı), bu gizlilik politikasında belirtilir.
- **App Store / Play gereksinimleri:** Apple "App Privacy" ve Google "Data Safety" formları için hangi verinin toplandığı net listelenir (fotoğraf, kullanım verisi, satın alma).
- **Temsili veri notu:** Grafiklerdeki istatistikler temsilidir; bu, gizlilik politikası/şartlar metninde de teyit edilir.

### Ayarlar Ekranı (yeni — bu gereksinimleri barındırır)
- Gizlilik Politikası
- Kullanım Şartları
- Aboneliği Yönet (App Store/Play aboneliğine yönlendirir)
- Restore Purchases
- Hesabımı ve Verilerimi Sil
- Destek / İletişim
