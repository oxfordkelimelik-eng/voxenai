// Sunucu tabanlı satın alma hatırlatma kampanyası.
//
// AMAÇ (2026-09-10'da basitleştirildi — kullanıcı kararı): uygulamayı
// indirip giriş yapmış (token almış) ama HİÇ satın alma yapmamış her
// kullanıcıya, satın alım yapana ya da 4 gün dolana kadar günde bir kez
// (TR saati 20:00) push bildirimi göndermek. ESKİDEN kampanya yalnızca
// "ücretsiz deneme kullanıldıysa" başlıyordu (tekli-foto/tekli-analiz
// hakkı harcanınca) — artık bu şart YOK, tek koşul "satın alma sıfır".
// Mevcut yerel bildirim sistemi (notification_service.dart,
// syncEngagementReminders) SADECE uygulama en az bir kez açıldığında
// zamanlanıyor ve sunucu satın alma durumundan habersiz — bu, ondan
// tamamen AYRI, uygulama kapalı olsa da çalışan bir mekanizma.
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

/** Gün 0-3 için bildirim metinleri (2026-09-10'da basitleştirildi — artık
 * "ücretsiz hakkını kullan" değil, genel bir davet: kullanıcı daha hiç
 * paket almamış, amaç ilk satın almayı tetiklemek). */
function reminderCopyFor(day) {
  const copies = [
    { title: "✨ Profilini hazırlamaya hazır mısın?",
      body: "Birkaç selfie yükle, AI fotoğrafların ve analizin seni bekliyor." },
    { title: "📸 Doğru fotoğraf eşleşmeleri belirliyor",
      body: "Voxen AI ile profilini birkaç dakikada güçlendir." },
    { title: "💬 Fark yaratan bir profil bir tık uzağında",
      body: "AI foto veya analiz paketiyle hemen başla." },
    { title: "⏳ Son hatırlatma",
      body: "Profilini güçlendirmek için bugün birkaç saniyeni ayır." },
  ];
  return copies[day] || copies[copies.length - 1];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * FCM token kaydı — client, giriş yapmış her kullanıcı için (anonim dahil,
 * ensureSignedIn() zaten her açılışta en az anonim oturum sağlıyor) token
 * alır almaz burayı çağırır.
 *
 * KAMPANYA BAŞLATMA BURADA (2026-09-10, basitleştirildi): eskiden kampanya
 * yalnızca ücretsiz deneme kullanılınca (onWalletWrite'ta) başlıyordu.
 * Artık tek koşul "kullanıcı uygulamaya girdi VE hiç satın alma yapmamış" —
 * bunu en güvenilir yakalayabileceğimiz an token kaydı anı (uygulama her
 * açıldığında/ilk kez açıldığında tetiklenir). wallet'a bakılır: bakiye
 * sıfırsa VE zaten aktif bir kampanya yoksa (satın alıp durdurulmuş bir
 * kampanyayı yanlışlıkla yeniden başlatmamak için) kampanya başlatılır.
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

    const uid = request.auth.uid;
    const campaignRef = db.doc(`${CAMPAIGNS_COL}/${uid}`);
    const walletRef = db.doc(`users/${uid}/private/wallet`);

    await db.runTransaction(async (tx) => {
      const [campaignSnap, walletSnap] = await Promise.all([
        tx.get(campaignRef), tx.get(walletRef),
      ]);
      const campaign = campaignSnap.exists ? campaignSnap.data() : null;
      const wallet = walletSnap.exists ? walletSnap.data() : null;
      const hasAnyBalance = !!wallet &&
        ((wallet.photoBalance || 0) > 0 || (wallet.analysisBalance || 0) > 0);

      const update = {
        uid,
        fcmToken: token,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Hiç satın alma yapmamışsa (bakiyesi yoksa) VE kampanya daha önce
      // hiç başlatılmamışsa (campaign == null) başlat. Kampanya zaten var
      // ama active:false ise (daha önce satın alıp durdurulmuş olabilir,
      // ya da MAX_REMINDER_DAY'e ulaşıp otomatik kapanmış olabilir) DOKUNMA
      // — "satın almış birine sırf token yenilendi diye kampanyayı yeniden
      // başlatma" ve "4 günü dolmuş kampanyayı sıfırlama" riskini önler.
      if (!hasAnyBalance && campaign === null) {
        update.active = true;
        update.reminderDay = 0;
        update.lastSentAt = null;
      }
      tx.set(campaignRef, update, { merge: true });
    });

    return { ok: true };
  }
);

/**
 * wallet yazıldığında tetiklenir — SADECE durdurma sinyali (2026-09-10'da
 * basitleştirildi). Bakiye satın alma ile arttıysa (paket kredisi eklendi)
 * kampanyayı DURDURUR. Başlatma artık burada değil: registerFcmToken
 * (token kaydı anı = kullanıcının uygulamaya girdiği an) tek koşulla
 * ("hiç satın alma yapmamış") kampanyayı başlatıyor — bkz. o fonksiyonun
 * başındaki not. Bu trigger'ı da (onPurchaseWrite gibi) sadece durdurma
 * için tutmak, "satın alma = kampanya biter" sinyalini iki ayrı yoldan
 * (buradan ve onPurchaseWrite'tan) yakalayıp kaçırma riskini azaltıyor.
 */
exports.onWalletWrite = onDocumentWritten(
  { document: "users/{uid}/private/wallet", region: "europe-west1" },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // silindi, ilgilenmiyoruz

    const beforePhoto = (before && before.photoBalance) || 0;
    const beforeAnalysis = (before && before.analysisBalance) || 0;
    const afterPhoto = after.photoBalance || 0;
    const afterAnalysis = after.analysisBalance || 0;
    if (afterPhoto > beforePhoto || afterAnalysis > beforeAnalysis) {
      await db.doc(`${CAMPAIGNS_COL}/${uid}`).set(
        { active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
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
        const copy = reminderCopyFor(day);
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
