# Design: Zorunlu göğüs-üstü referanslar + kalite sıkılaştırması

**Tarih:** 2026-09-06  
**Durum:** Onaylandı (tasarım)  
**Yaklaşım:** B — güçlü prompt + mevcut kapılar + yalnızca bariz Vision RED  
**Kapsam dışı:** face-swap / recomposite geri getirme, tam boy uzak foto zorunluluğu, dy/pitch sayısal kapı, cüzdan modeli değişikliği

## Problem

Dating foto üretiminde kimlik korunuyor ancak şu sorunlar devam ediyor:

1. Ten tonu yüzden kollara/ellere tutarsız kalabiliyor.
2. Kafa yönü şablon (base) ile uyuşmayabiliyor.
3. Bakış / göz yönü şablondan sapabiliyor.
4. Kafa “yapıştırılmış” görünebiliyor (boyun–omuz süreksizliği, hale, ışık kırığı).
5. Kafa ölçeği şablona göre fazla büyük / öne taşmış olabiliyor.
6. Kullanıcıdan yalnızca 3 yakın yüz selfie’si alınıyor; omuz–göğüs–kol oran ve ten sinyali zayıf. Tam boy uzak foto 2026-08-20’de kaldırılmıştı.

## Hedef

- Yakalama: **3 selfie + 2 zorunlu göğüs-üstü** galeri fotoğrafı.
- Beş referansın tamamı OpenAI edit girdisine gider.
- Göğüs-üstü çift, kafa ölçeği / omuz oranı / üst vücut teni için birincil beden sinyali olur.
- Kalite maddeleri 1–5 prompt ile güçlendirilir; kapılar yalnızca bariz ihlalde RED verir (yanlış pozitif artmaz).

## Kararlar (kilitli)

| Konu | Karar |
|------|--------|
| Göğüs-üstü | Zorunlu, tam 2 adet; atlanamaz |
| Sıkılık | Yaklaşım B |
| Face-swap | Yeniden açılmaz |
| dy / pitch kapısı | Eklenmez (önceki false-positive deneyimi) |
| Mevcut kapılar | `OUTPUT_HEAD_DX_MAX`, yaw-drift, `SKIN_MISMATCH_RATIO_MAX` (~0.60) kalır |
| Cüzdan | 1 stil ≈ 10 foto; değişmez |

## Mimari özet

```
[İstemci]
  3 yüz (kamera veya galeri) → 2 göğüs-üstü (galeri, zorunlu)
       ↓ Storage upload (mevcut job path)
[prepareReferencePhotos]
  yüz doğrulama + göğüs-üstü doğrulama (yüz var, omuz bandı, uzak değil)
  sıralama: [bestFace, face2, face3, chest1, chest2]
       ↓
[runOpenAiDirectChunk / submitStyleJob]
  image_urls = [template, ...orderedRefs]  // 1 + 5
  buildEditPrompt* — “LAST TWO = chest-up”
       ↓
[Kalite]
  mevcut: head-dx, yaw, skin chroma, Vision skin
  yeni (bariz): Vision ten yüz↔kol, yapışık kenar, aşırı büyük kafa → RED + retry
```

## Bileşenler

### 1. İstemci yakalama (`module_flows.dart`, `dating_constants.dart`)

- `faceCaptureCount = 3` (değişmez).
- Yeni: `chestUpPhotoCount = 2`.
- `referencePhotoCount = faceCaptureCount + chestUpPhotoCount` (= 5).
- Akış: paket/kredi kapısı → 3 yüz → **yeni adım** 2 göğüs-üstü → hazırlık/üretim.
- Göğüs-üstü yalnızca galeriden; tam 2 seçim zorunlu.
- UI kopyası: omuzlar + üst göğüs görünür, yüz net; tam boy uzak çekim ve sadece yakın yüz istenmez.
- İstemci: hafif yüz-var kontrolü (mevcut galeri yüz kontrolüne benzer); asıl red sunucuda.
- `_refsReady`: 3 yüz + 2 göğüs-üstü dolu olmalı.
- FAQ / `ai_consent_gate` metinleri 5 referansa güncellenir (tam boy ifadesi kaldırılır / düzeltilir).

### 2. Sabit senkronu

- Flutter `DatingConfig` ile Functions `FACE_PHOTO_COUNT` / yeni `CHEST_UP_PHOTO_COUNT` aynı sayıları tutmalı.
- Upload / job dokümanında `chestUpCount` veya refs uzunluğu 5 olarak loglanır (`referansSayisi=5`, `chestRefCount=2`).

### 3. Sunucu hazırlık (`falPhotos.js` — `uploadReferencePhotos` / `prepareReferencePhotos`)

- Ref listesi uzunluğu: 5 (3 yüz + 2 göğüs-üstü). Yükleme sırası istemciden sabit: önce yüzler, sonra göğüs-üstüler.
- `splitRefUrls(refUrls)`:
  - `faceUrls` = ilk 3
  - `chestUrls` = son 2
  - `bodyUrl` = null (eski distant full-body sözleşmesi kalkar)
- En iyi yüz seçimi yalnızca `faceUrls` üzerinde; sıralama sonrası: `[bestFace, ...otherFaces, chest1, chest2]`.
- Göğüs-üstü red (hazırlık, üretim başlamadan):
  - yüz yok / birden fazla baskın yüz belirsiz
  - kafa çok küçük (uzak / tam boy benzeri)
  - omuz / üst göğüs bandı yok (sadece yakın yüz crop)
- Kullanıcıya net hata: hangi foto neden reddedildi; yeniden seçim.

### 4. Prompt sözleşmesi (`buildEditPrompt` ve short / p300 / p800 / p1400)

Tüm aktif prompt builder’larda aynı sözleşme:

- Referanslar: close-up yüzler = kimlik + saç + göz şekli.
- **Son iki** = göğüs-üstü beden ipucu: omuz genişliği, kafa–omuz oranı, üst vücut / kol teni, gövde doluluğu.
- Eski “LAST one is distant full-body” dili kaldırılır.
- Explicit maddeler:
  1. **Ten:** yüz → boyun → göğüs → kollar → eller tek tutarlı ton; göğüs-üstü ten/kol sinyali; şablon kişisinin teni kalmaz.
  2. **Kafa yönü:** şablon pitch/yaw/roll; selfie açısı sahneye taşınmaz.
  3. **Bakış:** şablon bakış yönü; kimlik göz geometrisi yüz selfielerinden.
  4. **Yapışık kafa yok:** boyun–omuz sürekliliği, tek ışık ailesi, kenar halesi / sert gölge bandı yok.
  5. **Kafa ölçeği:** şablon omuz genişliğine göre; yakın selfie zoom’u ölçek kaynağı değil; göğüs-üstü oran rehberi.

`buildEditPromptSimple` kullanılmıyorsa dokunulmaz; kullanılıyorsa aynı chest-up sözleşmesine çekilir.

### 5. Kalite kapıları (`falPhotos.js`, `faceQuality.js`)

**Korunanlar**

- `OUTPUT_HEAD_DX_MAX` (dx RED)
- yaw-drift RED
- `SKIN_MISMATCH_RATIO_MAX` (~0.60)
- mevcut Vision skin yolu

**Yeni / sıkılaştırma (yalnız bariz)**

Vision değerlendirmesine net kriterler:

- yüz–kol teni bariz farklı → `vision-skin` / eşdeğer RED
- boyun–omuz’da yapıştırma / hale → RED
- kafa omuzlara göre aşırı büyük → RED

Eşikler mevcut soft-gate felsefesine uygun tutulur: gri alan geçsin, yalnızca net bozukluk retry’a gitsin. Retry mevcut `OPENAI_DIRECT_MAX_ATTEMPTS` ve şablon değiştirme mantığı içinde kalır.

**Eklenmeyecekler**

- dy veya pitch farkı sayısal kapısı
- bakış için sert sayısal eşik (prompt birincil)
- face-swap / post-recomposite

### 6. Hata ve iade davranışı

- Hazırlık red’i: kredi düşmez / üretim başlamaz (mevcut prepare semantiği korunur).
- Üretim ortası Vision/kapı RED: mevcut incomplete delivery + kısmi iade kuralları aynen.
- Callable kopsa bile Firestore dinleme davranışı (önceki istemci düzeltmesi) bu işle çelişmez; yeni APK gerekir (ayrı iş, bu spec’in parçası değil ama bağımlılık notu).

## Veri akışı (özet)

1. Kullanıcı 3 yüz + 2 göğüs-üstü seçer.
2. İstemci Storage’a yükler; callable `startPhotoGeneration` / prepare.
3. Sunucu 5 ref doğrular, sıralar, `falRefUrls` yazar.
4. Her chunk: `[template, ...5 refs]` + güncel prompt → OpenAI.
5. Kapılar + Vision; RED ise şablon değiştirerek retry.
6. Job `done` / kısmi teslim mevcut kurallarla.

## Maliyet notu

- Girdi görsel sayısı 3 → 5; gpt-image-2 edit maliyeti oturum başına artar (beklenen: birkaç on sent mertebesi, deneme sayısına bağlı).
- Retry sayısı aynı tavanla sınırlı; yeni sert kapılar yanlış pozitif üretmemeli.

## Test planı (manuel)

1. 2 göğüs-üstü olmadan “Oluştur” → engellenir.
2. 1 göğüs-üstü / 3 göğüs-üstü → engellenir (tam 2).
3. Uzak tam boy seçimi → prepare red + anlaşılır mesaj.
4. Sadece yüz crop → prepare red.
5. Geçerli 5 ref → log `referansSayisi=5`, `chestRefCount=2`.
6. Çıktı örnekleri: ten sürekliliği, kafa ölçeği, bakış/yön, yapıştırma azalması (görsel A/B).
7. Incomplete delivery oranı önceki baseline’ı belirgin bozmamalı.

## Dosya dokunuşları

| Dosya | Değişiklik |
|-------|------------|
| `lib/core/constants/dating_constants.dart` | `chestUpPhotoCount`, `referencePhotoCount` |
| `lib/presentation/dating/modules/module_flows.dart` | 2. adım yakalama, `_refsReady`, upload |
| `lib/presentation/dating/widgets/ai_consent_gate.dart` | metin |
| `lib/presentation/dating/settings/dating_faq_screen.dart` | metin |
| `functions/falPhotos.js` | counts, split, prepare, prompt, Vision, log |
| `functions/faceQuality.js` | gerekirse Vision/skin yardımcıları |

## Başarı ölçütleri

- Zorunlu 2 göğüs-üstü olmadan üretim yok.
- OpenAI’ye 5 kullanıcı referansı gider; prompt chest-up sözleşmesini kullanır.
- Madde 1–5 için prompt + bariz Vision RED aktif; dy/pitch kapısı yok.
- Face-swap kapalı kalır.
- Kullanıcıya hazırlık red’leri anlaşılır.

## Uygulama sırası (yüksek seviye)

1. Sabitler + istemci akış (3+2).
2. Prepare / split / log sunucu.
3. Prompt sözleşmesi tüm builder’larda.
4. Vision bariz kapıları.
5. Metinler (FAQ, consent).
6. Manuel test listesi.
