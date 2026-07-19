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
// ödeme senin fal.ai hesabından doğrudan gider (tek seferlik ~$1.15).

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { admin, db, bucket } = require("./_shared");

const FAL_KEY = defineSecret("FAL_KEY");
const FAL_BASE = "https://fal.run"; // senkron endpoint (webhook yok — test aracı)

// Karşılaştırılacak modeller. Her birinin girdi şeması FARKLI olduğu için
// input'u model bazında kuran bir fonksiyon tutuluyor.
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
    id: "nano-banana",
    endpoint: "fal-ai/nano-banana/edit",
    pricePerImage: 0.039,
    buildInput: (prompt, urls, seed) => ({
      prompt,
      image_urls: urls,
      aspect_ratio: "3:4",
      num_images: 1,
      output_format: "jpeg",
      seed,
      safety_tolerance: "4",
    }),
  },
  {
    id: "seedream-v45",
    endpoint: "fal-ai/bytedance/seedream/v4.5/edit",
    pricePerImage: 0.04,
    // Seedream: aspect_ratio/resolution YOK, image_size var. 3:4 dikey için
    // özel boyut (izin verilen aralık 1920-4096).
    buildInput: (prompt, urls, seed) => ({
      prompt,
      image_urls: urls,
      image_size: { width: 1920, height: 2560 },
      num_images: 1,
      max_images: 1,
      seed,
      enable_safety_checker: false,
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

/**
 * data: { jobId: string, style?: string }
 * Belirtilen (hazırlanmış) işin referanslarıyla, her aday modelden 5 foto
 * (5 farklı kompozisyon) üretir. Toplam 3 model x 5 = 15 görsel.
 */
exports.runModelBakeoff = onCall(
  {
    secrets: [FAL_KEY],
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 540, // 15 senkron üretim uzun sürebilir
  },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Giriş gerekli.");
    const uid = request.auth.uid;
    const { jobId, style = "elegance" } = request.data || {};

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
    const identityCaption = job.identityCaption || null;

    // falPhotos'un GERÇEK prompt üreticisini kullan — testin adil olması için
    // canlı sistemle birebir aynı prompt gitmeli.
    const { buildPromptForBakeoff, IMAGES_PER_STYLE_FOR_BAKEOFF } = require("./falPhotos");

    const runId = `bakeoff_${Date.now()}`;
    const results = {};
    let totalCost = 0;

    for (const candidate of CANDIDATES) {
      const perModel = [];
      // Her kompozisyon için AYNI seed kullanılır ki modeller arası fark
      // seed rastgeleliğinden değil, modelden gelsin.
      for (let i = 0; i < IMAGES_PER_STYLE_FOR_BAKEOFF; i++) {
        const prompt = buildPromptForBakeoff(style, i, identityCaption);
        const seed = 1000 + i; // sabit, modeller arası karşılaştırılabilir
        const r = await generateOne(candidate, prompt, refUrls, seed);
        if (!r.ok) {
          console.error(`bakeoff ${candidate.id} chunk ${i} hata: ${r.error}`);
          perModel.push({ chunk: i, error: r.error });
          continue;
        }
        const path = `dating_bakeoff/${uid}/${runId}/${candidate.id}_${i}.jpg`;
        await bucket().file(path).save(r.buf, {
          metadata: { contentType: "image/jpeg" },
        });
        perModel.push({ chunk: i, gsUrl: `gs://${bucket().name}/${path}` });
        totalCost += candidate.pricePerImage;
      }
      results[candidate.id] = {
        endpoint: candidate.endpoint,
        pricePerImage: candidate.pricePerImage,
        images: perModel,
      };
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
