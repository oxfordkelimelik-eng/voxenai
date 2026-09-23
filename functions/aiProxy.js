const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, enforceRateLimit, checkAppAttestation } = require("./_shared");

// ============================================================
// AI PROXY — OpenAI (eski adı gemini.js)
// ------------------------------------------------------------
// GEÇMİŞ (2026-08-20): bu dosya eskiden Google Gemini'yi (Generative Language
// API) çağırıyordu. Gemini PROJEDEN TAMAMEN KALDIRILDI; tek AI sağlayıcı artık
// OpenAI. Gerekçe iki katlı:
//   1) Bağımlılığı teke indirmek — foto üretimi zaten OpenAI'ye gidiyordu.
//   2) Gemini anahtarı ÜCRETSİZ tier'daydı; Google'ın ücretsiz kotasında
//      gönderilen içerik (burada: kullanıcıların YÜZ FOTOĞRAFLARI) ürün/model
//      geliştirmede kullanılabiliyor ve insan gözden geçiriciler tarafından
//      incelenebiliyor. Bu, gizlilik politikamızdaki "yalnızca ilgili işlem
//      için işlenir" taahhüdüyle ve App Store 5.1.2(i) ile çelişiyordu.
//
// Dışa açılan fonksiyon ADLARI ve veri sözleşmeleri BİLEREK DEĞİŞTİRİLMEDİ
// (analyzeImage / chat) — istemci tarafında hiçbir değişiklik gerekmesin diye.
// ============================================================

// HIZ SINIRLARI — her iki uç nokta da istemciden gelen SERBEST metni
// (analyzeImage: prompt, chat: contents) modele iletiyor. Sınır olmadan
// bunlar bizim kotamız üzerinden çalışan ücretsiz bir LLM proxy'sine dönüşür:
// geçerli bir kimlik belirteci olan biri, uygulamayla hiç ilgisi olmayan
// istekleri döngüde gönderebilir. Sınırlar gerçek kullanımın üstünde
// (bir analiz turu birkaç çağrı, koç sohbeti dakikada birkaç mesaj).
const RL_ANALYZE = { max: 30, windowMs: 60 * 60 * 1000,
  message: "Çok fazla analiz isteği gönderdin. Bir saat sonra tekrar dene." };
const RL_CHAT = { max: 60, windowMs: 60 * 60 * 1000,
  message: "Çok fazla mesaj gönderdin. Biraz sonra tekrar dene." };

// OpenAI anahtarı Firebase Secret olarak saklanır (kodda/APK'da görünmez).
// falPhotos.js ile AYNI secret — tek anahtar, tek fatura.
const OPENAI_KEY = defineSecret("OPENAI_API_KEY");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// falPhotos.js'teki VISION_MODEL ile aynı model — çıktı kalite kapısında
// zaten bu kullanılıyor, çok görselli karşılaştırmada güvenilir.
const VISION_MODEL = "gpt-4o";

// Foto analizinde ömür boyu ücretsiz gösterilen foto sayısı (hesap başına 1).
// dating_constants.dart DatingConfig.freePreviewCount ile senkron tutulmalı.
const FREE_ANALYSIS_PHOTOS = 1;

/**
 * OpenAI chat/completions çağrısı; 429/5xx'te kısa bekleyip yeniden dener.
 * Gemini sürümündeki "model değiştir" mantığının karşılığı: OpenAI'de tek
 * model yeterli, geçici hatalar backoff ile çözülüyor.
 */
async function callOpenAiWithRetry(key, body) {
  const maxAttempts = 3;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) return await resp.json();

    lastStatus = resp.status;
    lastBody = await resp.text().catch(() => "");
    // Kalıcı hata (400/401/403) — tekrar denemenin anlamı yok.
    if ([400, 401, 403].includes(resp.status)) {
      console.error(`OpenAI kalıcı hata: ${resp.status} ${lastBody.slice(0, 200)}`);
      throw new HttpsError("internal", `AI hatası: ${resp.status}`);
    }
    console.warn(`OpenAI ${resp.status} (deneme ${attempt}/${maxAttempts})`);
    if (attempt < maxAttempts) {
      // 429'da OpenAI ne kadar bekleneceğini cevabın içinde söyleyebiliyor.
      let waitMs = attempt * 1500;
      const m = lastBody.match(/try again in ([\d.]+)\s*(ms|s)\b/i);
      if (m) {
        const v = parseFloat(m[1]);
        waitMs = Math.min((/ms/i.test(m[2]) ? v : v * 1000) + 500, 20000);
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new HttpsError(
    "unavailable",
    `AI servisi şu an meşgul (son durum ${lastStatus}). Lütfen biraz sonra tekrar deneyin.`
  );
}

function firstText(json) {
  const text = json?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text : null;
}

/**
 * Foto analizi proxy'si: istemci görseli + prompt gönderir, anahtar burada
 * eklenir. Sadece giriş yapmış kullanıcılar çağırabilir.
 *
 * data: { prompt: string, images?: [{data, mimeType}], imageBase64?, mimeType? }
 * dönüş: { text: string }  (modelin ham metin yanıtı)
 */
// BELLEK 256MiB'DEN 1GiB'A ÇIKARILDI (2026-09-23 gerçek olay): dating foto
// puanlaması tek çağrıda 6 fotoğrafa kadar (bkz. module_flows.dart
// _pickAndValidate limit:6) base64 + "detail:high" gönderiyor. Loglarda 2
// görselle bile "Memory limit of 256 MiB exceeded with 296 MiB used" OOM
// çökmesi görüldü — fonksiyon hiç HttpsError fırlatmadan öldüğü için
// istemci bunu kredi hatasından AYIRT EDEMİYOR, jenerik "şu an yapılamadı"
// mesajına düşüyordu.
exports.analyzeImage = onCall(
  { secrets: [OPENAI_KEY], region: "europe-west1", memory: "1GiB", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    checkAppAttestation(request, "analyzeImage");
    await enforceRateLimit(request.auth.uid, "analyzeImage", RL_ANALYZE);
    const { prompt, imageBase64, mimeType, images } = request.data || {};
    // Çok açılı (ön/sağ/sol) destek: images = [{data, mimeType}]. Tek görsel için
    // geriye dönük olarak imageBase64/mimeType da kabul edilir.
    const imgList = Array.isArray(images) && images.length > 0
      ? images
      : imageBase64
        ? [{ data: imageBase64, mimeType }]
        : [];
    if (!prompt || imgList.length === 0) {
      throw new HttpsError("invalid-argument", "prompt ve en az bir görsel zorunlu.");
    }

    // ANALİZ HAKKI ÖN KONTROLÜ (2026-09-15) — MALİYETİ KESEN KATMAN.
    //
    // Ücretsiz analiz hakkı kapatıldı. Eski akışta kontrol analiz BİTTİKTEN
    // sonra (consumeAnalysis) yapılıyordu: kullanıcı fotoğrafları yüklüyor,
    // OpenAI çağrısı çalışıp ücretlendiriliyor, sonra "hakkın yok" denip tüm
    // sonuçlar kilitli gösteriliyordu. Hak kapatılınca bu, her denemede boşa
    // OpenAI maliyeti demekti (ölçüm: 119 hesabın ücretsiz analiz hakkı hâlâ
    // kullanılmamış durumda). Kontrol buraya alındı — hakkı olmayan çağrı
    // modele hiç gitmiyor.
    //
    // YALNIZCA DATING SKORLAMASINI KAPSAR. analyzeImage üç ayrı özelliğe
    // hizmet ediyor (bkz. claude_api_service.dart): scoreDatingPhotos (hak
    // gerektirir), analyzeFace ve analyzeBody (gerektirmez — bunlar
    // uygulamanın ücretsiz temel özellikleri). Ayrım prompt'un kendisinden
    // yapılıyor: yalnızca dating skorlama prompt'u "dating/profil fotoğrafı
    // uzmanısın" ifadesiyle başlar ve JSON dizisi ister.
    const isDatingScoring = /dating\/profil fotoğrafı uzmanısın/i.test(String(prompt));
    if (isDatingScoring) {
      const walletSnap = await db.doc(`users/${request.auth.uid}/private/wallet`).get();
      const w = walletSnap.data() || {};
      const analysisBalance = w.analysisBalance || 0;
      if (analysisBalance <= 0) {
        // Mesaj mevcut bakiyeyi AÇIKÇA söylüyor (2026-09-23 kullanıcı kararı)
        // — "hakkın yok" gibi belirsiz bir ifade yerine "kredi yetersiz" +
        // rakam, kullanıcının ne kadar eksik olduğunu net görmesini sağlar.
        throw new HttpsError(
          "failed-precondition",
          `Kredi yetersiz. Mevcut analiz krediniz: ${analysisBalance}. Devam etmek için analiz paketi al.`
        );
      }
    }

    // detail:"high" — analizde yüz ayrıntısı şart; "low" (512px) kadraj/ışık
    // dışındaki nüansları ayırt etmeye yetmiyor.
    const content = [
      { type: "text", text: prompt },
      ...imgList.map((img) => ({
        type: "image_url",
        image_url: {
          url: `data:${img.mimeType || "image/jpeg"};base64,${img.data}`,
          detail: "high",
        },
      })),
    ];

    const body = {
      model: VISION_MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 8192,
      temperature: 0.4,
    };

    try {
      const json = await callOpenAiWithRetry(OPENAI_KEY.value(), body);
      const text = firstText(json);
      if (!text) {
        throw new HttpsError("internal", "AI yanıtı boş.");
      }
      if (json.usage) {
        console.log(
          `MALIYET ANALIZ: girdi=${json.usage.prompt_tokens ?? "?"} ` +
          `cikti=${json.usage.completion_tokens ?? "?"} ` +
          `model=${VISION_MODEL} gorselSayisi=${imgList.length}`
        );
      }
      return { text };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("analyzeImage hata:", e);
      throw new HttpsError("internal", "Analiz başarısız.");
    }
  }
);

/**
 * Sohbet (sosyal antrenman) proxy'si.
 *
 * İstemci hâlâ Gemini'nin `contents` biçimini gönderiyor
 * ([{role:'user'|'model', parts:[{text}]}]) — istemciyi değiştirmemek için
 * dönüşüm BURADA yapılıyor: 'model' rolü OpenAI'de 'assistant' olur.
 *
 * data: { contents: [...] }
 * dönüş: { text: string }
 */
exports.chat = onCall(
  { secrets: [OPENAI_KEY], region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    checkAppAttestation(request, "chat");
    await enforceRateLimit(request.auth.uid, "chat", RL_CHAT);
    const { contents } = request.data || {};
    if (!Array.isArray(contents) || contents.length === 0) {
      throw new HttpsError("invalid-argument", "contents zorunlu.");
    }
    // Girdi boyutu sınırı: devasa bir bağlam hem maliyeti hem gecikmeyi
    // patlatır. Normal koç sohbeti bunun çok altında kalır.
    const totalChars = JSON.stringify(contents).length;
    if (totalChars > 20000) {
      throw new HttpsError("invalid-argument", "Mesaj geçmişi çok uzun.");
    }

    const messages = contents.map((c) => {
      const text = (c?.parts || [])
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("\n")
        .trim();
      return {
        role: c?.role === "model" ? "assistant" : "user",
        content: text,
      };
    }).filter((m) => m.content);

    if (messages.length === 0) {
      throw new HttpsError("invalid-argument", "Boş mesaj geçmişi.");
    }

    const body = {
      model: VISION_MODEL,
      messages,
      max_tokens: 2048,
      temperature: 0.8,
    };

    try {
      const json = await callOpenAiWithRetry(OPENAI_KEY.value(), body);
      return { text: firstText(json) || "" };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("chat hata:", e);
      throw new HttpsError("internal", "Sohbet başarısız.");
    }
  }
);

/**
 * Foto analizi sonuçlarının kaç tanesinin AÇIK gösterileceğini SUNUCU
 * TARAFINDA atomik olarak belirler ve tüketir. İstemcinin yerel bakiyeyle
 * oynamasını engeller (analiz "kredi/hak" taşıyan bir kaynaktır).
 *
 * NOT: AI sağlayıcısıyla ilgisi yoktur; tarihsel olarak bu dosyada durduğu
 * için burada bırakıldı (adı ve sözleşmesi değişmedi).
 *
 * Kural:
 *  - Hesap başına ömür boyu ilk [FREE_ANALYSIS_PHOTOS] foto ücretsiz açılır
 *    (freeAnalysisUsed bir kez true olur, bir daha ücretsiz verilmez).
 *  - Kalan fotolar analysisBalance'tan foto başına 1 hak düşülerek açılır.
 *  - Bakiye yetmezse yetebildiği kadar açılır; gerisi kilitli (blur) kalır.
 *
 * data: { requested: number, alreadyUnlocked?: number }
 * dönüş: { unlocked: number, usedFree: boolean, analysisBalance: number }
 */
exports.consumeAnalysis = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const uid = request.auth.uid;
    const requested = Number(request.data?.requested);
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new HttpsError("invalid-argument", "requested pozitif tam sayı olmalı.");
    }
    let alreadyUnlocked = Number(request.data?.alreadyUnlocked || 0);
    if (!Number.isInteger(alreadyUnlocked) || alreadyUnlocked < 0) {
      alreadyUnlocked = 0;
    }
    alreadyUnlocked = Math.min(alreadyUnlocked, requested);
    // Yeni açılması gereken (henüz açılmamış) foto sayısı.
    const toUnlock = requested - alreadyUnlocked;
    if (toUnlock <= 0) {
      return { success: true, unlocked: requested, usedFree: false };
    }

    const walletRef = db.doc(`users/${uid}/private/wallet`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(walletRef);
      const wallet = snap.data() || {};
      const analysisBalance = (wallet.analysisBalance || 0);
      const freeUsed = wallet.freeAnalysisUsed === true;

      // 1) ÜCRETSİZ ANALİZ HAKKI KAPATILDI (2026-09-15, kullanıcı kararı).
      //
      // Foto üretimindeki ücretsiz deneme daha önce kapatılmıştı; analiz de
      // aynı karara bağlandı. Blok SİLİNMEDİ, etkisiz bırakıldı: geçmişte
      // ücretsiz hakkını kullanmış hesaplarda freeAnalysisUsed=true olarak
      // kalıyor ve ileride geri açılmak istenirse tek satır yeter.
      //
      // ASIL ENGEL BURADA DEĞİL: bu fonksiyon analiz ZATEN ÇALIŞTIKTAN sonra
      // çağrılıyor, yani burada reddetmek OpenAI maliyetini önlemez —
      // yalnızca sonuçları kilitler. Maliyeti kesen kontrol analyzeImage'ın
      // başındadır (bkz. oradaki "ANALİZ HAKKI ÖN KONTROLÜ"). Bu satır o
      // kontrolü atlatan eski istemciler için ikinci savunma katmanıdır.
      const FREE_ANALYSIS_ENABLED = false;
      let newlyUnlocked = 0;
      let usedFree = false;
      if (FREE_ANALYSIS_ENABLED && !freeUsed && alreadyUnlocked === 0) {
        newlyUnlocked = Math.min(FREE_ANALYSIS_PHOTOS, toUnlock);
        usedFree = newlyUnlocked > 0;
      }

      // 2) Kalanları paket bakiyesinden karşıla (foto başına 1 hak).
      const stillLocked = toUnlock - newlyUnlocked;
      const fromPack = Math.min(stillLocked, analysisBalance);
      newlyUnlocked += fromPack;

      const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (usedFree) update.freeAnalysisUsed = true;
      if (fromPack > 0) update.analysisBalance = analysisBalance - fromPack;
      // Yazılacak bir şey yoksa (hepsi kilitli) transaction'ı boşuna yazma.
      if (usedFree || fromPack > 0) {
        tx.set(walletRef, update, { merge: true });
      }

      return {
        unlocked: alreadyUnlocked + newlyUnlocked,
        usedFree,
        analysisBalance: analysisBalance - fromPack,
      };
    });

    return { success: true, ...result };
  }
);
