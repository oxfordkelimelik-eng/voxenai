// Sunucu tabanlı satın alma hatırlatma kampanyası.
//
// AMAÇ: ücretsiz denemeyi (foto veya analiz) kullanmış ama hiç satın alma
// yapmamış kullanıcılara, satın alım yapana ya da 4 gün dolana kadar günde
// bir kez (TR saati 20:00) push bildirimi göndermek. Mevcut yerel bildirim
// sistemi (notification_service.dart, syncEngagementReminders) SADECE
// uygulama en az bir kez açıldığında zamanlanıyor ve sunucu satın alma
// durumundan habersiz — bu, ondan tamamen AYRI, uygulama kapalı olsa da
// çalışan bir mekanizma.
//
// VERİ MODELİ: yeni root koleksiyon notificationCampaigns/{uid}. Firestore
// rules'a dokunulmadı — dosya sonundaki "match /{document=**} { allow
// read, write: if false; }" zaten bu koleksiyona client erişimini kapatıyor,
// yalnızca Admin SDK (bu dosyadaki fonksiyonlar) okur/yazar. wallet'a
// karıştırılmadı: wallet para/hak taşıyan kritik bir doküman, kampanya
// durumu onunla aynı yazma yoluna girmemeli.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  admin, db, enforceRateLimit, checkAppAttestation,
} = require("./_shared");

const CAMPAIGNS_COL = "notificationCampaigns";
const MAX_REMINDER_DAY = 4; // gün 0-3 gönderilir, gün 4'te durur (4 bildirim)

// FCM tek çağrıda en fazla 500 token kabul eder — hem gönderim hem batch
// yazım bu sınıra göre parçalanır.
const FCM_BATCH_SIZE = 500;

/** Gün 0-3 için bildirim metinleri. "what" mevcut notification_service.dart
 * mantığıyla aynı: hangi ücretsiz hak kullanılmadıysa o. */
function reminderCopyFor(day, what) {
  const copies = [
    { title: `✨ ${what} seni bekliyor`,
      body: "Birkaç selfie yükle, profilin için hazır kareyi gör." },
    { title: "📸 Profil fotoğrafın eşleşmelerini belirliyor",
      body: `${what} hâlâ kullanılmadı — denemek birkaç dakika sürüyor.` },
    { title: "💬 Doğru fotoğraf fark yaratır",
      body: "Ücretsiz hakkını kullanmadan bunu görmeyeceksin. Şimdi dene." },
    { title: "⏳ Ücretsiz hakkın hâlâ dokunulmadı",
      body: "Bugün son hatırlatma — birkaç saniyeni ayır." },
  ];
  return copies[day] || copies[copies.length - 1];
}

/** wallet durumuna göre "what" kelimesi — syncEngagementReminders'daki
 * mantıkla aynı (notification_service.dart). */
function whatFor(freePhotoUsed, freeAnalysisUsed) {
  if (!freePhotoUsed && !freeAnalysisUsed) return "Ücretsiz fotoğrafın ve analizin";
  if (!freePhotoUsed) return "Ücretsiz fotoğrafın";
  if (!freeAnalysisUsed) return "Ücretsiz analizin";
  return "Ücretsiz hakkın";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * FCM token kaydı — client, giriş yapmış her kullanıcı için (anonim dahil,
 * ensureSignedIn() zaten her açılışta en az anonim oturum sağlıyor) token
 * alır almaz burayı çağırır. notificationCampaigns/{uid} dokümanına merge
 * yazar; doküman yoksa oluşturur (kampanya henüz başlamamış olabilir,
 * bu durumda sadece token saklanır, onWalletWrite tetiklendiğinde aktive
 * olur).
 */
exports.registerFcmToken = onCall(
  { region: "europe-west1", memory: "128MiB", timeoutSeconds: 15 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const { token } = request.data || {};
    // FCM token'ları assertSafeId'nin dar regex'ine uymaz (uzun, özel
    // karakterler içerir) — burada sadece kaba bir uzunluk/tip kontrolü.
    if (typeof token !== "string" || token.length < 1 || token.length > 4096) {
      throw new HttpsError("invalid-argument", "Geçersiz token.");
    }
    checkAppAttestation(request, "registerFcmToken");
    await enforceRateLimit(request.auth.uid, "registerFcmToken",
      { max: 10, windowMs: 10 * 60 * 1000, message: "Çok fazla istek." });

    await db.doc(`${CAMPAIGNS_COL}/${request.auth.uid}`).set({
      uid: request.auth.uid,
      fcmToken: token,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { ok: true };
  }
);

/**
 * wallet yazıldığında tetiklenir. İki iş yapar:
 *  1) freePhotoUsed/freeAnalysisUsed false->true geçtiyse VE kullanıcı hiç
 *     satın alma yapmamışsa (photoBalance/analysisBalance hâlâ 0/başlangıç
 *     seviyesindeyse) kampanyayı BAŞLATIR (active:true, reminderDay:0).
 *  2) Bakiye satın alma ile arttıysa (paket kredisi eklendi) kampanyayı
 *     DURDURUR — bu, tek trigger'ın hem başlatma hem durdurma sinyalini
 *     yakalamasını sağlar (satın alma sonrası wallet.photoBalance/
 *     analysisBalance yükselir, bkz. payments.js verifyPurchase).
 */
exports.onWalletWrite = onDocumentWritten(
  { document: "users/{uid}/private/wallet", region: "europe-west1" },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // silindi, ilgilenmiyoruz

    const campaignRef = db.doc(`${CAMPAIGNS_COL}/${uid}`);

    // Bakiye YÜKSELDİYSE (satın alma) — kampanyayı durdur.
    const beforePhoto = (before && before.photoBalance) || 0;
    const beforeAnalysis = (before && before.analysisBalance) || 0;
    const afterPhoto = after.photoBalance || 0;
    const afterAnalysis = after.analysisBalance || 0;
    if (afterPhoto > beforePhoto || afterAnalysis > beforeAnalysis) {
      await campaignRef.set({ active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return;
    }

    // Ücretsiz hak YENİ kullanıldıysa VE hâlâ hiç bakiyesi yoksa — başlat.
    const freePhotoJustUsed = !(before && before.freePhotoUsed) && after.freePhotoUsed === true;
    const freeAnalysisJustUsed = !(before && before.freeAnalysisUsed) && after.freeAnalysisUsed === true;
    if ((freePhotoJustUsed || freeAnalysisJustUsed) && afterPhoto === 0 && afterAnalysis === 0) {
      await campaignRef.set({
        uid,
        active: true,
        reminderDay: 0,
        lastSentAt: null,
        freePhotoUsed: !!after.freePhotoUsed,
        freeAnalysisUsed: !!after.freeAnalysisUsed,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

/**
 * Yeni bir satın alma kaydı oluştuğunda kampanyayı hemen durdurur — bu,
 * onWalletWrite'tan daha doğrudan bir durdurma sinyali (satın alma anında
 * durur, sonraki bir wallet yazımını beklemez).
 */
exports.onPurchaseWrite = onDocumentWritten(
  { document: "users/{uid}/private/payments/processedPurchases/{orderId}", region: "europe-west1" },
  async (event) => {
    if (!event.data.after.exists) return; // silme, ilgilenmiyoruz
    const uid = event.params.uid;
    await db.doc(`${CAMPAIGNS_COL}/${uid}`).set({
      active: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
);

/**
 * Günlük kampanya gönderimi — TR saati 20:00. Aktif kampanyaları tarar,
 * FCM push gönderir, sayaç/durumu günceller, geçersiz token'ları temizler.
 */
exports.sendEngagementReminders = onSchedule(
  { schedule: "0 20 * * *", timeZone: "Europe/Istanbul", region: "europe-west1", timeoutSeconds: 300 },
  async () => {
    const snap = await db.collection(CAMPAIGNS_COL)
      .where("active", "==", true)
      .where("reminderDay", "<", MAX_REMINDER_DAY)
      .get();

    if (snap.empty) {
      console.log("ENGAGEMENT HATIRLATMA: aktif kampanya yok.");
      return;
    }

    const candidates = snap.docs
      .map((doc) => ({ ref: doc.ref, data: doc.data() }))
      .filter((c) => typeof c.data.fcmToken === "string" && c.data.fcmToken.length > 0);

    console.log(`ENGAGEMENT HATIRLATMA: ${snap.size} aktif kampanya, ${candidates.length} geçerli token.`);
    if (candidates.length === 0) return;

    let sentCount = 0, failedCount = 0, cleanedCount = 0;

    for (const group of chunk(candidates, FCM_BATCH_SIZE)) {
      const messages = group.map((c) => {
        const day = c.data.reminderDay || 0;
        const what = whatFor(c.data.freePhotoUsed, c.data.freeAnalysisUsed);
        const copy = reminderCopyFor(day, what);
        return {
          token: c.data.fcmToken,
          notification: { title: copy.title, body: copy.body },
          data: { type: "engagement_reminder", day: String(day) },
        };
      });

      let response;
      try {
        response = await admin.messaging().sendEachForMulticast(messages);
      } catch (e) {
        console.error("ENGAGEMENT HATIRLATMA: toplu gönderim hata verdi:", e.message || e);
        continue;
      }

      const batch = db.batch();
      response.responses.forEach((r, i) => {
        const c = group[i];
        if (r.success) {
          sentCount++;
          const nextDay = (c.data.reminderDay || 0) + 1;
          const update = {
            reminderDay: nextDay,
            lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (nextDay >= MAX_REMINDER_DAY) update.active = false;
          batch.set(c.ref, update, { merge: true });
        } else {
          failedCount++;
          const code = r.error && r.error.code;
          if (code === "messaging/registration-token-not-registered" ||
              code === "messaging/invalid-registration-token") {
            // Token geçersiz — yenilenene kadar tekrar denemenin anlamı yok.
            cleanedCount++;
            batch.set(c.ref, { fcmToken: null }, { merge: true });
          } else {
            console.warn(`ENGAGEMENT HATIRLATMA: gönderim başarısız uid=${c.data.uid} kod=${code}`);
          }
        }
      });
      await batch.commit();
    }

    console.log(`ENGAGEMENT HATIRLATMA sonucu: gönderildi=${sentCount} başarısız=${failedCount} temizlenen-token=${cleanedCount}`);
  }
);
