// GEÇİCİ MODEL KARŞILAŞTIRMA (A/B) ARACI — canlı üretim akışına DOKUNMAZ.
//
// AMAÇ: Aynı referans fotoğraflar + aynı prompt sistemi (falPhotos.js'in
// buildPrompt'u) ile birden fazla modelden birer set üretip, hangi modelin
// "telefonla çekilmiş gibi doğal" hedefine daha yakın olduğunu GÖZLE
// karşılaştırmak. Şimdiye kadar modeller hep tek yönlü değiştirildi (her
// seferinde farklı prompt sürümüyle), yani adil bir karşılaştırma hiç
// yapılmadı — bu araç onu kapatıyor.
//
// AYRICA MALİYET SORUSU: nano-banana-pro $0.15/foto iken alternatifleri
// $0.03-0.04 (4-5 kat ucuz). Ucuz modeller GÜNCEL prompt sistemiyle yeterince
// iyiyse paket maliyeti ~%75 düşer.
//
// KULLANIM (test bittiğinde bu dosya ve index.js kaydı SİLİNMELİ):
//   Client/curl ile callable çağrısı: runModelBakeoff({ jobId, style })
//   jobId = daha önce prepareReferencePhotos ile hazırlanmış bir iş
//           (falRefUrls + identityCaption zaten dokümanda duruyor).
//   Sonuçlar: Storage'da dating_bakeoff/{uid}/{runId}/{model}_{chunk}.jpg
//             ve Firestore users/{uid}/private/genData/bakeoffs/{runId}
//
// BU ARAÇ BAKİYE DÜŞMEZ ve kullanıcının normal foto akışını etkilemez —
// ödeme senin fal.ai hesabından doğrudan gider. Taban ~$1.05 (2 model x 5
// foto = 10 görsel) AMA çıktı artık canlının TAM KOPYASI: kimlik kapısı +
// otomatik retry (max 2) + telefon kamerası dokusu uygulanıyor. Kimlik
// eşiğini geçemeyen kareler yeniden üretildiği için maliyet deneme sayısına
// göre değişir (en kötü ~3 kat) — döndürülen estimatedCostUsd GERÇEK
// yapılan fal çağrısı sayısına göre hesaplanır.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_BASE = "https://fal.run"; // senkron endpoint (webhook yok — test aracı)

// Karşılaştırılacak modeller. İlk turda 4 model denendi (nano-banana-pro,
// nano-banana, seedream-v4.5, gpt-image-2); nano-banana ve seedream sonuçta
// zayıf çıktı verdiği için kapsam bu ikisine indirildi. Her birinin girdi
// şeması FARKLI olduğu için input'u model bazında kuran bir fonksiyon tutuluyor.
const CANDIDATES = [
  {
    id: "nano-banana-pro",
    endpoint: "fal-ai/nano-banana-pro/edit",
    pricePerImage: 0.15,
    buildInput: (prompt, urls, seed) => ({
      prompt,
      image_urls: urls,
      aspect_ratio: "3:4",
      resolution: "1K",
      num_images: 1,
      output_format: "jpeg",
      seed,
      safety_tolerance: "4",
    }),
  },
  {
    id: "gpt-image-2",
    endpoint: "openai/gpt-image-2/edit",
    // ORTA kalite seçildi: 1024x1024'te düşük $0.015 / orta $0.061 / yüksek
    // $0.219 — kimlik koruma + doku için "yüksek" gerekebilir ama önce ucuz
    // orta katmanla başlıyoruz (webte gördüğün "ucuz" izlenimi muhtemelen
    // düşük kaliteden; yüksek kalite şu anki nano-banana-pro'dan bile pahalı).
    pricePerImage: 0.061,
    // GPT Image 2 GERÇEK şeması (fal.ai resmi dokümantasyonu doğrulandı):
    // aspect_ratio/resolution/safety_tolerance YOK. ÖNCEKİ SÜRÜM YANLIŞTI:
    // "size" (string) şemada yok — muhtemelen sessizce yok sayılıp
    // varsayılana (image_size: auto, quality: high — yani gerçekte "orta"
    // değil "yüksek" kalite ve daha yüksek maliyetle) düşüyordu. Doğru isim:
    // image_size (obje/preset) + quality + num_images + output_format.
    //
    // image_size PRESET (özel {width,height} DEĞİL, bkz. falPhotos.js aynı
    // gerekçe): modelin native çözünürlük kovası, rastgele boyut zorlamıyor.
    buildInput: (prompt, urls, seed) => ({
      prompt,
      image_urls: urls,
      image_size: "portrait_4_3", // dikey dating fotoğrafı için en yakın preset
      quality: "medium",
      num_images: 1,
      output_format: "jpeg",
      seed,
    }),
  },
];

/**
 * Tek bir görsel üretir (senkron). Hata durumunda { ok:false, error } döner —
 * bir modelin patlaması diğerlerinin testini bozmaz.
 */
async function generateOne(candidate, prompt, urls, seed) {
  try {
    const resp = await fetch(`${FAL_BASE}/${candidate.endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY.value()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(candidate.buildInput(prompt, urls, seed)),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return { ok: false, error: `${resp.status} ${txt.slice(0, 200)}` };
    }
    const json = await resp.json();
    const url = json?.images?.[0]?.url;
    if (!url) return { ok: false, error: "yanıtta görsel yok" };
    const imgResp = await fetch(url);
    if (!imgResp.ok) return { ok: false, error: `indirilemedi: ${imgResp.status}` };
    return { ok: true, buf: Buffer.from(await imgResp.arrayBuffer()) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Canlı akıştaki MAX_CHUNK_RETRIES ile aynı — kimlik eşiğini geçemeyen bir
// çıktı en fazla bu kadar yeniden üretilir.
const BAKEOFF_MAX_RETRIES = 2;

/**
 * Canlı akışın TAM KOPYASI üretim: bir görsel üretir, kimlik kapısından
 * (matchesIdentity, job.refDescriptor) geçirir; geçemezse yeni seed ile
 * yeniden üretir (max BAKEOFF_MAX_RETRIES). Bu, falInferenceWebhook'un
 * kimlik-kapısı + maybeRetryChunk davranışının senkron karşılığıdır.
 *
 * Döner:
 *   { ok:true, buf, distance, retries, passedIdentity, attemptsMade }
 *   { ok:false, error, attemptsMade }
 * passedIdentity: true=geçti, false=tüm denemeler geçemedi (canlıda bu kare
 *   ATILIRDI — yine de son deneme etiketlenip gösterilir), null=kimlik kapısı
 *   yok/hatalı (fail-safe, canlıdaki gibi filtresiz kabul).
 *
 * refDescriptor yoksa (eski iş / hesaplanamamış) kapı devre dışı — ilk
 * başarılı çıktı kabul edilir (canlı fail-safe ile birebir).
 */
async function generateWithGate(candidate, prompt, urls, seed, refDescriptor, matchesIdentity) {
  let attemptSeed = seed;
  let lastFailBuf = null;
  let lastFailDistance = null;
  let lastError = null;
  let attemptsMade = 0;

  for (let attempt = 0; attempt <= BAKEOFF_MAX_RETRIES; attempt++) {
    const raw = await generateOne(candidate, prompt, urls, attemptSeed);
    attemptsMade++;
    // Sonraki deneme için yeni seed (canlı maybeRetryChunk ile aynı).
    attemptSeed = Math.floor(Math.random() * 2147483647);

    if (!raw.ok) {
      // Üretim hatası — GERÇEK sebebi sakla (ör. "422 ..." şema hatası); tüm
      // denemeler tükenirse bu kaybolmasın, arayüzde görünsün.
      lastError = raw.error;
      continue;
    }
    // Kimlik kapısı yok / hatalı → filtresiz kabul (canlı fail-safe).
    if (!refDescriptor) {
      return { ok: true, buf: raw.buf, distance: null, retries: attempt, passedIdentity: null, attemptsMade };
    }
    let distance = null;
    let passed = true;
    try {
      const res = await matchesIdentity(raw.buf, refDescriptor);
      distance = res.distance;
      passed = res.match;
    } catch (e) {
      console.error("bakeoff kimlik kontrolü hata (filtresiz kabul):", e.message || e);
      return { ok: true, buf: raw.buf, distance: null, retries: attempt, passedIdentity: null, attemptsMade };
    }
    if (passed) {
      return { ok: true, buf: raw.buf, distance, retries: attempt, passedIdentity: true, attemptsMade };
    }
    // Kimlik eşiğini geçemedi — son çareye sakla ve yeniden dene.
    lastFailBuf = raw.buf;
    lastFailDistance = distance;
  }

  // Tüm denemeler kimlik eşiğini geçemedi. Canlıda bu kare ATILIRDI; bakeoff'ta
  // modelin kimlik zayıflığını görebilmen için son deneme "başarısız" etiketiyle
  // yine de gösterilir.
  if (lastFailBuf) {
    return { ok: true, buf: lastFailBuf, distance: lastFailDistance, retries: BAKEOFF_MAX_RETRIES, passedIdentity: false, attemptsMade };
  }
  return {
    ok: false,
    error: lastError || "tüm denemeler başarısız (üretim)",
    attemptsMade,
  };
}

/**
 * data: { jobId: string, style?: string }
 * Belirtilen (hazırlanmış) işin referanslarıyla, her aday modelden 5 foto
 * (5 farklı kompozisyon) üretir. Toplam 2 model x 5 = 10 görsel.
 */
exports.runModelBakeoff = onCall(
  {
    secrets: [FAL_KEY],
    region: "europe-west1",
    // Kimlik kapısı (matchesIdentity) tfjs + 3 face-api modeli yükler; canlı
    // akışta bu 2GiB gerektiriyordu (1GiB'de OOM — bkz. falPhotos.js). Doku
    // (sharp) hafif.
    memory: "2GiB",
    timeoutSeconds: 540, // 20 üretim + retry + kimlik kontrolü uzun sürebilir
  },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Giriş gerekli.");
    const uid = request.auth.uid;
    const { jobId, style = "elegance", runId: clientRunId } = request.data || {};

    // jobId verilmezse EN SON referansı olan işi kendisi bulur — böylece
    // kullanıcının Firestore'dan elle jobId kopyalaması gerekmez.
    // NOT: fal CDN'deki referans görseller silinmiyor (yalnızca Firebase
    // Storage kopyaları KVKK gereği siliniyor), bu yüzden eski bir işin
    // falRefUrls'ü hâlâ kullanılabilir.
    let job;
    let usedJobId = jobId;
    if (jobId) {
      const snap = await db.doc(`users/${uid}/private/genData/genJobs/${jobId}`).get();
      if (!snap.exists) throw new HttpsError("not-found", "jobId bulunamadı.");
      job = snap.data();
    } else {
      const recent = await db
        .collection(`users/${uid}/private/genData/genJobs`)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
      const usable = recent.docs.find(
        (d) => Array.isArray(d.data().falRefUrls) && d.data().falRefUrls.length > 0
      );
      if (!usable) {
        throw new HttpsError(
          "failed-precondition",
          "Referansı olan bir iş bulunamadı. Önce uygulamadan bir AI foto " +
          "üretimi başlat (fotoğrafları yükleyip doğrulamadan geçir), sonra " +
          "bu testi tekrar çalıştır."
        );
      }
      job = usable.data();
      usedJobId = usable.id;
    }

    const refUrls = job.falRefUrls;
    if (!Array.isArray(refUrls) || refUrls.length === 0) {
      throw new HttpsError("failed-precondition", "Bu işte falRefUrls yok.");
    }
    // Canlı akışın prompt'una giren TÜM sinyaller — test birebir aynı olmalı:
    //   identityCaption : yüz/kimlik tarifi (Gemini)
    //   bodyCaption     : tam boy fotodan beden oranı (Gemini) — BİRİNCİL beden
    //   bodyProfile     : formdan boy/vücut tipi — İKİNCİL beden ipucu
    //   styleWardrobes  : stil başına kıyafet/duruş notu (Gemini)
    // Eski işlerde (bu alanlar eklenmeden önce hazırlanmış) yoksa buildPrompt
    // null'ları sessizce atlar — o durumda ilgili blok prompt'a hiç girmez.
    const identityCaption = job.identityCaption || null;
    const bodyCaption = job.bodyCaption || null;
    const bodyProfile = job.bodyProfile || null;
    const styleWardrobes = job.styleWardrobes || {};
    // Canlının TAM KOPYASI için kimlik kapısı + doku. refDescriptor yoksa kapı
    // devre dışı (canlı fail-safe ile aynı). Lazy require — bu ağır modüller
    // (tfjs) yalnızca bakeoff çalışırken yüklensin, tüm deployment cold-start'ında
    // değil (bkz. falPhotos.js aynı desen).
    const refDescriptor = job.refDescriptor || null;
    const { matchesIdentity } = require("./faceQuality");
    const { addPhoneCameraTexture } = require("./postProcess");

    // falPhotos'un GERÇEK prompt üreticisini kullan — testin adil olması için
    // canlı sistemle birebir aynı prompt gitmeli.
    const { buildPromptForBakeoff, IMAGES_PER_STYLE_FOR_BAKEOFF } = require("./falPhotos");

    // runId'yi client verirse onu kullan — böylece client callable kopsa/timeout
    // olsa bile bu id'den Firestore'daki sonucu okuyup gösterebilir (para boşa
    // gitmez). Verilmezse kendimiz üretiriz (geriye dönük uyumlu).
    const runId = (typeof clientRunId === "string" && clientRunId.trim())
      ? clientRunId.trim()
      : `bakeoff_${Date.now()}`;

    // TÜM (model x chunk) kombinasyonları PARALEL çalıştırılır (2 model x 5
    // chunk = 10 eşzamanlı istek). Önceden sırayla (20 kez sıra sıra) çalışıyordu
    // — 540 saniyelik zaman aşımına yaklaşıyordu ve gereksiz yavaştı; her
    // istek bağımsız olduğu için paralelleştirmenin hiçbir sakıncası yok.
    const tasks = [];
    for (const candidate of CANDIDATES) {
      for (let i = 0; i < IMAGES_PER_STYLE_FOR_BAKEOFF; i++) {
        // Canlı submitStyleJob ile BİREBİR aynı imza: kimlik + beden profili
        // (form) + bodyCaption (foto) + o stile ait wardrobe notu.
        const prompt = buildPromptForBakeoff(style, i, identityCaption, bodyProfile, {
          bodyCaption,
          wardrobeNote: styleWardrobes[style] || null,
        });
        // İlk deneme için AYNI seed kullanılır ki modeller arası fark seed
        // rastgeleliğinden değil, modelden gelsin. (Kimlik retry'lerinde canlı
        // gibi yeni seed'e geçilir — bkz. generateWithGate.)
        const seed = 1000 + i;
        tasks.push(
          generateWithGate(candidate, prompt, refUrls, seed, refDescriptor, matchesIdentity)
            .then((r) => ({ candidate, chunk: i, prompt, r }))
        );
      }
    }
    const settled = await Promise.all(tasks);

    // Storage'a yazma işlemleri de paralel — indirilen buffer zaten elimizde,
    // yalnızca fal'a giden ağ isteği paralelleştirmenin asıl faydasıydı.
    const results = {};
    let totalCost = 0;
    await Promise.all(settled.map(async ({ candidate, chunk, prompt, r }) => {
      if (!results[candidate.id]) {
        results[candidate.id] = {
          endpoint: candidate.endpoint,
          pricePerImage: candidate.pricePerImage,
          images: [],
        };
      }
      // Maliyet GERÇEK yapılan fal çağrısı sayısına göre (retry'ler dahil).
      totalCost += candidate.pricePerImage * (r.attemptsMade || 1);
      if (!r.ok) {
        console.error(`bakeoff ${candidate.id} chunk ${chunk} hata: ${r.error}`);
        results[candidate.id].images.push({ chunk, error: r.error });
        return;
      }
      // Canlının TAM KOPYASI: telefon kamerası dokusu (grain + gerçekçi JPEG).
      // Fail-safe: doku hata verirse ham buffer kaydedilir.
      let outBuf = r.buf;
      try {
        outBuf = await addPhoneCameraTexture(r.buf);
      } catch (e) {
        console.error(`bakeoff doku hata (${candidate.id} #${chunk}, ham kaydedildi):`, e.message || e);
      }
      const path = `dating_bakeoff/${uid}/${runId}/${candidate.id}_${chunk}.jpg`;
      await bucket().file(path).save(outBuf, {
        metadata: { contentType: "image/jpeg" },
      });
      // Prompt + kimlik/retry meta'sı kaydedilir — "model mi saptı, prompt mu
      // eksikti" ve "hangi model kimliği zor tutuyor" sorularını kanıtla
      // cevaplamak için. passedIdentity:false = canlıda bu kare atılırdı.
      results[candidate.id].images.push({
        chunk,
        gsUrl: `gs://${bucket().name}/${path}`,
        prompt,
        retries: r.retries,
        attemptsMade: r.attemptsMade,
        identityDistance: r.distance != null ? Number(r.distance.toFixed(3)) : null,
        identityPassed: r.passedIdentity,
      });
    }));

    // images dizilerini chunk sırasına göre düzelt (paralel yazım karıştırmış olabilir).
    for (const modelResult of Object.values(results)) {
      modelResult.images.sort((a, b) => a.chunk - b.chunk);
    }

    await db.doc(`users/${uid}/private/genData/bakeoffs/${runId}`).set({
      style,
      sourceJobId: usedJobId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      estimatedCostUsd: Number(totalCost.toFixed(3)),
      results,
    });

    return {
      runId,
      sourceJobId: usedJobId,
      estimatedCostUsd: Number(totalCost.toFixed(3)),
      results,
    };
  }
);
