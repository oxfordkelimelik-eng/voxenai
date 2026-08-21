const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'rise-up-9235f' });
const db = admin.firestore();

(async () => {
  const snap = await db.collectionGroup('genJobs').orderBy('createdAt', 'desc').limit(3).get();
  snap.forEach(doc => {
    const d = doc.data();
    console.log('PATH:', doc.ref.path);
    console.log('  status:', d.status, 'styles:', d.styles, 'createdAt:', d.createdAt && d.createdAt.toDate());
  });
})().catch(e => { console.error(e); process.exit(1); });
