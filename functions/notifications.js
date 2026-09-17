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

// opsPanel.js'teki OPS_EMAIL ile EL İLE senkron (döngüsel require'dan
// kaçınmak için ayrı tanımlandı — iki dosya birbirini import etmiyor).
const OPS_EMAIL = "destek@voxenai.com.tr";

// SATIŞ BİLDİRİMİ KANALI (Android). İstemcideki
// NotificationService._salesChannel ile AYNI OLMAK ZORUNDA — sunucu bu id ile
// gönderir, ses o kanaldan gelir. Eşleşmezse bildirim düşer ama SESSİZ olur
// (Android bilinmeyen kanal id'sini varsayılan kanala düşürür).
//
// Kanal 'voxen_reminders'tan AYRI: Android'de bir kanalın sesi oluşturulduktan
// sonra uygulama tarafından değiştirilemez, ayrıca satış sesinin kullanıcı
// hatırlatmalarından bağımsız olması isteniyor (admin bunu kapatmadan
// hatırlatmaları kapatabilsin).
const SALES_CHANNEL_ID = "voxen_sales";

const PRODUCT_PRICES_TRY = {
  dating_pack_photo10: 349, dating_pack_photo50: 999,
  dating_pack_analysis1: 99, dating_pack_analysis5: 249,
};
const PRODUCT_LABELS = {
  dating_pack_photo10: "AI Foto Standart (10 foto)",
  dating_pack_photo50: "AI Foto Premium (50 foto)",
  dating_pack_analysis1: "Analiz Tekli",
  dating_pack_analysis5: "Analiz Standart (5)",
};

// FCM tek çağrıda en fazla 500 token kabul eder — hem gönderim hem batch
// yazım bu sınıra göre parçalanır.
const FCM_BATCH_SIZE = 500;

// Bir cihazın token'ı bu kodlarla dönerse token GERÇEKTEN ölüdür ve
// listeden çıkarılmalı. Başka hatalar (ağ, kota, sunucu) GEÇİCİDİR —
// onlarda token'a DOKUNULMAZ, yoksa geçici bir aksaklık kullanıcının
// bildirimlerini kalıcı olarak kapatır.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Bir kampanya dokümanından gönderilecek TÜM token'ları çıkarır.
 *
 * Hem yeni `fcmTokens` dizisini hem eski tekil `fcmToken` alanını okur:
 * eski dokümanlar ve bu sürümü henüz almamış istemciler tekil alanı
 * yazmaya devam ediyor (bkz. registerFcmToken'daki geriye uyumluluk notu).
 * Tekrarlar ayıklanır.
 */
function collectTokens(data) {
  if (!data) return [];
  const out = new Set();
  if (Array.isArray(data.fcmTokens)) {
    for (const t of data.fcmTokens) {
      if (typeof t === "string" && t.length > 0) out.add(t);
    }
  }
  if (typeof data.fcmToken === "string" && data.fcmToken.length > 0) {
    out.add(data.fcmToken);
  }
  return [...out];
}

/**
 * Ölü token'ları dokümandan çıkarır. Yalnızca DEAD_TOKEN_CODES ile
 * işaretlenenleri siler; tekil `fcmToken` alanı da o token'a eşitse
 * temizlenir ki eski okuyucular ölü token'ı görmesin.
 */
async function pruneDeadTokens(ref, deadTokens, currentSingle) {
  if (!deadTokens.length) return;
  const update = {
    fcmTokens: admin.firestore.FieldValue.arrayRemove(...deadTokens),
  };
  if (currentSingle && deadTokens.includes(currentSingle)) update.fcmToken = null;
  await ref.set(update, { merge: true });
}

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
  // 128MiB YETMİYOR (2026-09-11 gerçek olay): Node.js 20 runtime'ının kendisi
  // zaten 130-154 MiB kullanıyor, konteyner PORT=8080'de dinlemeye
  // başlamadan bellek limitini aşıp health check'te düşüyordu — deploy
  // "Container Healthcheck failed" hatasıyla başarısız oluyordu (aralıklı:
  // bazı deploy'larda konteyner limitin altında kalacak kadar şanslı
  // başlıyordu, bu yüzden hata her seferinde görünmüyordu).
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 15 },
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

      // ÇOK CİHAZ TOKEN LİSTESİ (2026-09-17) — "bildirim bazen geliyor
      // bazen gelmiyor" şikayetinin kök nedeni.
      //
      // Eskiden tek bir `fcmToken` alanı vardı ve her kayıt öncekini
      // EZİYORDU. Sonuçları:
      //  - İki cihazda giriş yapılmışsa yalnızca SON cihaz bildirim alırdı.
      //  - FCM token'ı yenilendiğinde (Android periyodik yeniler, uygulama
      //    silinip kurulunca da değişir) eski token ölür; gönderim
      //    'registration-token-not-registered' alıp alanı null'lardı ve
      //    kullanıcı uygulamayı bir daha AÇANA KADAR hiç bildirim gelmezdi.
      //    Gerçek kanıt: admin token'ı 2026-09-17 18:46'da kaydedildi, o
      //    günün üç satışı (07:15 / 09:59 / 17:39) bildirimsiz geçti.
      //
      // Artık token'lar `fcmTokens` DİZİSİNDE birikiyor; gönderim hepsine
      // yapılır ve yalnızca mağazanın "bu token ölü" dediği tekil token
      // listeden çıkarılır — diğer cihazlar çalışmaya devam eder.
      //
      // `fcmToken` (tekil) alanı GERİYE UYUMLULUK için yazılmaya devam
      // ediyor: bu sürümü henüz almamış istemcilerden gelen kayıtlar ve
      // eski dokümanlar okunabilir kalsın (bkz. collectTokens).
      const update = {
        uid,
        fcmToken: token,
        fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Admin hesabı (destek@voxenai.com.tr) hiçbir zaman "satın almadın"
      // kampanyasına girmez — panelin kendisini kullanan hesabın bakiyesi
      // hep 0 olur, bu bir satın alma-yapmama sinyali değildir.
      const isOpsAccount = (request.auth.token.email || "").toLowerCase().trim() === OPS_EMAIL;

      // Hiç satın alma yapmamışsa (bakiyesi yoksa) VE kampanya daha önce
      // hiç başlatılmamışsa (campaign == null) başlat. Kampanya zaten var
      // ama active:false ise (daha önce satın alıp durdurulmuş olabilir,
      // ya da MAX_REMINDER_DAY'e ulaşıp otomatik kapanmış olabilir) DOKUNMA
      // — "satın almış birine sırf token yenilendi diye kampanyayı yeniden
      // başlatma" ve "4 günü dolmuş kampanyayı sıfırlama" riskini önler.
      if (!isOpsAccount && !hasAnyBalance && campaign === null) {
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
 * Admin'e (destek@voxenai.com.tr) yeni satış olduğunda push bildirimi
 * gönderir — panel açık ya da kapalı, sonuç aynı (bu yüzden "canlı gösterge"
 * değil FCM push seçildi). Admin'in kendi notificationCampaigns/{uid}
 * dokümanındaki fcmToken kullanılır (registerFcmToken zaten her giriş
 * yapmış kullanıcı için, admin dahil, token kaydediyor).
 */
async function notifyOpsOfNewSale(uid, purchase) {
  let adminUid;
  try {
    adminUid = (await admin.auth().getUserByEmail(OPS_EMAIL)).uid;
  } catch (e) {
    console.error("SATIŞ BİLDİRİMİ: admin kullanıcı bulunamadı:", e.message || e);
    return;
  }
  if (uid === adminUid) return; // admin kendi hesabıyla test satın alması yaptıysa bildirim gönderme

  // HEDEF YALNIZCA ADMIN: token'lar admin'in KENDİ kampanya dokümanından
  // okunur (adminUid, e-postadan çözüldü). Satın almayı yapan kullanıcının
  // dokümanına hiç bakılmaz — yani bu bildirim başka kimseye gidemez.
  // Admin birden fazla cihazdan panele girdiyse HEPSİNE gider.
  const adminCampRef = db.doc(`${CAMPAIGNS_COL}/${adminUid}`);
  const adminCampSnap = await adminCampRef.get();
  const adminData = adminCampSnap.exists ? adminCampSnap.data() : null;
  const tokens = collectTokens(adminData);
  if (tokens.length === 0) {
    console.warn("SATIŞ BİLDİRİMİ: admin FCM token yok, gönderilemedi.");
    return;
  }

  let buyerEmail = uid;
  try { buyerEmail = (await admin.auth().getUser(uid)).email || uid; } catch { /* uid ile devam */ }

  const label = PRODUCT_LABELS[purchase.productId] || purchase.productId;
  const price = PRODUCT_PRICES_TRY[purchase.productId] || 0;

  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: "💰 Yeni satış",
        body: `${label} — ${price} TL — ${buyerEmail}`,
      },
      // SATIŞ SESİ (2026-09-16) — kullanıcı isteği: "bildirim geliyor ama
      // bildirim sesi gelmiyor, Shopify satış para sesini ekleyelim".
      //
      // Ses PLATFORM BLOKLARINDA verilmek ZORUNDA; üstteki ortak
      // `notification` nesnesinin sound alanı yok. İki platform ayrı davranır:
      //
      // ANDROID: ses KANALA bağlıdır, mesaja değil. channelId burada verilen
      // kanal, istemcide sesli olarak oluşturulmuş olmalı (bkz.
      // notification_service.dart _salesChannel). Kanal adı res/raw/sale.mp3
      // dosyasını gösterir. UYARI: Android'de var olan bir kanalın sesi
      // sonradan DEĞİŞTİRİLEMEZ — bu yüzden mevcut sessiz 'voxen_reminders'
      // kanalı kullanılmıyor, satışa özel YENİ bir kanal açıldı.
      //
      // iOS: ses doğrudan mesajda taşınır ve UZANTIYLA verilir ('sale.wav').
      // Dosya MP3 OLAMAZ — Apple yalnızca Linear PCM / IMA4 / µLaw / aLaw
      // kabul eder (.wav/.aiff/.caf kabında) ve 30 saniyeden kısa olmalı.
      // Bu yüzden aynı ses iki formatta paketleniyor: Android .mp3, iOS .wav.
      android: {
        priority: "high",
        notification: { channelId: SALES_CHANNEL_ID, sound: "sale" },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "sale.wav" } },
      },
      data: { type: "new_sale", productId: purchase.productId || "" },
    });

    // Cihaz cihaz sonuç: biri başarısız olsa bile diğerleri gitmiş olabilir.
    const dead = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (DEAD_TOKEN_CODES.has(code)) dead.push(tokens[i]);
      else console.warn(`SATIŞ BİLDİRİMİ: cihaz ${i + 1} geçici hata kod=${code}`);
    });
    console.log(
      `SATIŞ BİLDİRİMİ: ${res.successCount}/${tokens.length} cihaza gönderildi` +
      (dead.length ? ` — ${dead.length} ölü token temizlendi` : "")
    );
    // Ölü token'ları çıkar; geçici hata alanlara DOKUNMA (bkz.
    // DEAD_TOKEN_CODES gerekçesi).
    await pruneDeadTokens(adminCampRef, dead, adminData && adminData.fcmToken);
  } catch (e) {
    // Buraya yalnızca çağrının KENDİSİ patlarsa düşülür (ağ/kimlik).
    // Tekil cihaz hataları yukarıda ele alındı.
    console.warn("SATIŞ BİLDİRİMİ: gönderim başarısız kod=", e && e.code);
  }
}

/**
 * Yeni bir satın alma kaydı oluştuğunda kampanyayı hemen durdurur — bu,
 * onWalletWrite'tan daha doğrudan bir durdurma sinyali (satın alma anında
 * durur, sonraki bir wallet yazımını beklemez). Aynı olayda admin'e satış
 * bildirimi de gönderir (bkz. notifyOpsOfNewSale).
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
    await notifyOpsOfNewSale(uid, event.data.after.data());
  }
);

/**
 * TEK SEFERLİK TELAFİ BİLDİRİMİ (2026-09-10 olayı).
 *
 * NEDEN: cleanupStuckGenJobs 'ready' işleri de tarayıp "Zaman aşımı" yazıyordu
 * (bkz. falPhotos.js'teki cleanupStuckGenJobs açıklaması). Kullanıcı stil
 * seçim ekranındayken ekranı hata ekranına dönüyordu; parası düşülmemişti ama
 * "paketim yandı" sanıp tekrar satın alanlar oldu. Hata düzeltildi; bu fonksiyon
 * mağdurlara "kredileriniz duruyor, kullanabilirsiniz" bilgisini iletir.
 *
 * ELLE TETİKLENİR — otomatik çalışmaz. FCM token kaydı yeni sürümle geldiği
 * için, canlı kullanıcılar güncelleyip token gönderene kadar hedeflerin
 * çoğunda token olmayacak; bu yüzden fonksiyon tekrar tekrar çağrılabilir ve
 * her seferinde SADECE henüz bildirim almamış (notifiedAt yok) ve token'ı
 * OLAN hedeflere gönderir. dryRun ile önce kimlere gideceği görülebilir.
 */
exports.opsSendCompensationNotice = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Giriş gerekli.");
    }
    const email = (request.auth.token.email || "").toLowerCase().trim();
    if (email !== "destek@voxenai.com.tr" || request.auth.token.email_verified === false) {
      throw new HttpsError("permission-denied", "Yetkisiz.");
    }
    const dryRun = (request.data || {}).dryRun !== false; // varsayılan: dryRun

    // Hedefler: 'ready' iken haksız "Zaman aşımı" almış VE hâlâ kullanılmamış
    // kredisi olan kullanıcılar. Bu iki koşulun kesişimi kasıtlı: kredisi
    // kalmamış birine "kredilerin duruyor" demek yanlış olurdu.
    const since = admin.firestore.Timestamp.fromMillis(
      Date.now() - 30 * 24 * 60 * 60 * 1000);
    const jobSnap = await db.collectionGroup("genJobs")
      .where("createdAt", ">=", since)
      .get();

    const affectedUids = new Set();
    for (const doc of jobSnap.docs) {
      const d = doc.data();
      if (d.status !== "failed") continue;
      if (d.errorMessage !== "Zaman aşımı — işlem tamamlanamadı.") continue;
      if (d.styles) continue; // stil seçilmiş = gerçek üretim denemesi, bu ayrı bir hata
      let cur = doc.ref;
      while (cur.parent && cur.parent.id !== "users") cur = cur.parent.parent;
      if (cur) affectedUids.add(cur.id);
    }

    const targets = [];
    const skipped = { noCredit: 0, alreadyNotified: 0, noToken: 0 };
    for (const uid of affectedUids) {
      const walletSnap = await db.doc(`users/${uid}/private/wallet`).get();
      const w = walletSnap.data() || {};
      const photo = w.photoBalance || 0;
      const analysis = w.analysisBalance || 0;
      if (photo === 0 && analysis === 0) { skipped.noCredit++; continue; }

      const campRef = db.doc(`${CAMPAIGNS_COL}/${uid}`);
      const camp = (await campRef.get()).data() || {};
      if (camp.compensationNotifiedAt) { skipped.alreadyNotified++; continue; }
      // Çok cihaz: tek seferlik bir duyuru, kullanıcı başına TEK cihaza
      // gider (aynı bilgiyi her cihazda tekrar göstermenin anlamı yok).
      const campTokens = collectTokens(camp);
      if (campTokens.length === 0) { skipped.noToken++; continue; }

      targets.push({ uid, ref: campRef, token: campTokens[0], photo, analysis });
    }

    if (dryRun) {
      return {
        dryRun: true,
        affectedTotal: affectedUids.size,
        wouldSend: targets.length,
        skipped,
        preview: targets.map((t) => ({ uid: t.uid, photo: t.photo, analysis: t.analysis })),
      };
    }

    let sent = 0, failed = 0;
    for (const group of chunk(targets, FCM_BATCH_SIZE)) {
      const messages = group.map((t) => {
        // Metin kişiye göre: elinde ne varsa onu söyle.
        const parts = [];
        if (t.photo > 0) parts.push(`${t.photo} AI foto`);
        if (t.analysis > 0) parts.push(`${t.analysis} analiz`);
        return {
          token: t.token,
          notification: {
            title: "🎁 Kredilerin hesabında duruyor",
            body: `Yaşanan teknik aksaklık giderildi. ${parts.join(" ve ")} hakkın ` +
              "kullanılmadan bekliyor — hemen üretime başlayabilirsin.",
          },
          data: { type: "compensation_notice" },
        };
      });

      let response;
      try {
        response = await admin.messaging().sendEachForMulticast(messages);
      } catch (e) {
        console.error("TELAFİ BİLDİRİMİ: toplu gönderim hata verdi:", e.message || e);
        continue;
      }

      const batch = db.batch();
      response.responses.forEach((r, i) => {
        if (r.success) {
          sent++;
          batch.set(group[i].ref, {
            compensationNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          failed++;
          const code = r.error && r.error.code;
          console.warn(`TELAFİ BİLDİRİMİ: başarısız uid=${group[i].uid} kod=${code}`);
          if (DEAD_TOKEN_CODES.has(code)) {
            // Yalnızca denenen token'ı çıkar — diğer cihazlar kalsın.
            const dead = group[i].token;
            batch.set(group[i].ref, {
              fcmTokens: admin.firestore.FieldValue.arrayRemove(dead),
            }, { merge: true });
          }
        }
      });
      await batch.commit();
    }

    console.log(`TELAFİ BİLDİRİMİ sonucu: gönderildi=${sent} başarısız=${failed}`);
    return { dryRun: false, affectedTotal: affectedUids.size, sent, failed, skipped };
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

    // ÇOK CİHAZ (2026-09-17): artık token'lar dizide tutuluyor (bkz.
    // registerFcmToken). Hatırlatma "günde bir kez" mantığıyla çalıştığı
    // ve reminderDay KULLANICI başına ilerlediği için, kullanıcının TÜM
    // cihazlarına aynı anda göndermek onu aynı gün birden çok kez rahatsız
    // ederdi. Bu yüzden kullanıcı başına TEK cihaz seçilir; ölü çıkarsa
    // sonraki turda listeden düşer ve sıradaki cihaz devreye girer.
    const candidates = snap.docs
      .map((doc) => ({ ref: doc.ref, data: doc.data(), tokens: collectTokens(doc.data()) }))
      .filter((c) => c.tokens.length > 0);

    console.log(`ENGAGEMENT HATIRLATMA: ${snap.size} aktif kampanya, ${candidates.length} geçerli token.`);
    if (candidates.length === 0) return;

    let sentCount = 0, failedCount = 0, cleanedCount = 0;

    for (const group of chunk(candidates, FCM_BATCH_SIZE)) {
      const messages = group.map((c) => {
        const day = c.data.reminderDay || 0;
        const copy = reminderCopyFor(day);
        return {
          token: c.tokens[0],
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
          if (DEAD_TOKEN_CODES.has(code)) {
            // Token GERÇEKTEN ölü — yalnızca onu listeden çıkar. Kullanıcının
            // diğer cihazları dokunulmadan kalır ve sonraki turda denenir
            // (eskiden tüm alan null'lanıyordu, bu da diğer cihazları da
            // sessizce kapatıyordu).
            cleanedCount++;
            const dead = c.tokens[0];
            const update = {
              fcmTokens: admin.firestore.FieldValue.arrayRemove(dead),
            };
            if (c.data.fcmToken === dead) update.fcmToken = null;
            batch.set(c.ref, update, { merge: true });
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

// Saf yardımcılar — test edilebilsin diye dışa açılır. index.js'teki seçili
// export listesine EKLENMEZ, dolayısıyla Cloud Function olarak deploy
// edilmez (aynı desen: opsPanel.js _testables).
exports._testables = { collectTokens, DEAD_TOKEN_CODES };
