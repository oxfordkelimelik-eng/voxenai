const admin = require("firebase-admin");

// Bir process içinde yalnızca bir kez başlatılmalı — tüm modüller bu
// dosyayı import ederek aynı admin/db örneğini paylaşır.
if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Bucket erişimi lazy (getter) — modül yüklenirken değil, ilk gerçek
// kullanımda çözülür. Bu, storageBucket config'i henüz hazır olmayan
// yerel/test ortamlarında import zincirinin kırılmasını önler.
let _bucket = null;
function bucket() {
  if (!_bucket) _bucket = admin.storage().bucket();
  return _bucket;
}

module.exports = { admin, db, bucket };
