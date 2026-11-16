// ŞABLON BİLGİ TABLOSU (2026-11-14, kullanıcı: "şimdilik sadece elegance/tall").
// İş sırasında her karede yeniden yapılan ÜCRETSİZ şablon ölçümlerini bir kez hesaplar:
// hazırlık (kırpım/kullanılabilirlik), 2B+3B poz, prompt pozu, şapka, ışık (faceTone),
// yüz yapısı (faceDetail), ışıklı arka plan kapısı (faceGlow). Ücretli Vision ölçümleri
// (gözlük judgeEyewear, ten MST estimateMst) BOŞ bırakılır (vision: null).
// Kod henüz bu tabloyu OKUMUYOR. Çıktı: functions/templateMeta/<stil>_<bant>.json
// Kullanım (functions klasöründen): node scripts/buildTemplateMeta.js elegance tall
"use strict";
process.chdir(__dirname + "/..");
const FN = process.cwd() + "/";
const fs = require("fs"), http = require("http"), Module = require("module"), path = require("path");
const sharp = require(process.cwd() + "/node_modules/sharp");
const admin = require(process.cwd() + "/node_modules/firebase-admin");
const STYLE = process.argv[2] || "elegance", BAND = process.argv[3] || "tall";
const PREFIX = `dating_templates/${STYLE}/${BAND}/`;
const OUT_DIR = FN + "templateMeta/"; fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = OUT_DIR + `${STYLE}_${BAND}.json`;
const CACHE = path.join(require("os").tmpdir(), "rise_tplmeta_img/"); fs.mkdirSync(CACHE, { recursive: true });

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(FN + "service-account-key.json")), storageBucket: "rise-up-9235f.firebasestorage.app" });
const m = new Module(FN + "falPhotos.js", null); m.filename = FN + "falPhotos.js"; m.paths = Module._nodeModulePaths(FN);
m._compile(fs.readFileSync(FN + "falPhotos.js", "utf8") + "\nmodule.exports.__t={prepareTemplate,basePromptPose,BOWED:require('./naturalSwap')._testables.BOWED_PITCH_DEG};", FN + "falPhotos.js");
const F = m.exports.__t;
const H = require(FN + "headPose3d"), FQ = require(FN + "faceQuality"), PT = require(FN + "postTasks");
const tone = require(FN + "faceTone"), T = tone._testables, det = require(FN + "faceDetail"), glow = require(FN + "faceGlow");
const Lab = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

async function lightOf(buf) {
  const md = await sharp(buf).metadata();
  const S = await T.probsOf(await sharp(buf).png().toBuffer(), md.width, md.height);
  if (!S) return { ok: false, reason: "no-face" };
  const st = T.skinStats(S); const ring = T.sceneRingL(S);
  const neck = T.neckFaceDelta(S, (i) => [S.work[i * 3], S.work[i * 3 + 1], S.work[i * 3 + 2]]);
  const faceL = st ? Lab(st.Y) : null;
  const fr = faceL != null && ring != null ? faceL - ring : null;
  return {
    ok: !!st, faceL: r2(faceL, 1), ringL: r2(ring, 1), faceMinusRing: r2(fr, 1),
    gu: r2(st && st.slope && st.slope.gu), gv: r2(st && st.slope && st.slope.gv), skinA: r2(st && st.a, 1), skinB: r2(st && st.b, 1),
    neckMinusFace: r2(neck && neck.delta, 1),
    darkScene: ring != null && ring <= T.DARK_SCENE.RING_MAX_L,
    backlit: ring != null && fr != null && ring >= T.BACKLIT.RING_MIN_L && fr <= -T.BACKLIT.FACE_RING_MIN,
    sideLight: !!(st && st.slope && Math.abs(st.slope.gu) >= T.SIDE_LIGHT.MIN_TPL_GU),
  };
}

(async () => {
  const [files] = await admin.storage().bucket().getFiles({ prefix: PREFIX });
  const list = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
  console.log(`${PREFIX}: ${list.length} şablon`);
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { templates: {} };
  const bufs = {};
  const srv = http.createServer((q, r) => { const b = bufs[decodeURIComponent(q.url)]; if (!b) { r.statusCode = 404; return r.end(); } r.setHeader("content-type", "image/jpeg"); r.end(b); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const base = `http://127.0.0.1:${srv.address().port}`;
  const templates = {};
  let i = 0;
  for (const f of list) {
    i++;
    const md5 = f.metadata && f.metadata.md5Hash;
    const old = prev.templates[f.name];
    if (old && old.md5 === md5 && !process.env.FORCE) { templates[f.name] = old; continue; }
    const t0 = Date.now();
    const local = CACHE + require("crypto").createHash("sha1").update(f.name).digest("hex") + path.extname(f.name);
    if (!fs.existsSync(local)) await f.download({ destination: local });
    const src = fs.readFileSync(local);
    const row = { md5, size: +f.metadata.size, ms: {} };
    try {
      const md = await sharp(src).metadata(); row.width = md.width; row.height = md.height;
      // 1) Hazırlık (canlıdaki prepareTemplate; kırpılırsa tampon döner).
      const key = `/t/${i}`; bufs[key] = src;
      let t = Date.now();
      const pt = await F.prepareTemplate(base + key, "photos", i);
      const prepBuf = Buffer.isBuffer(pt.input) ? pt.input : src;
      const pm = await sharp(prepBuf).metadata();
      row.prep = { usable: pt.usable !== false, cropped: Buffer.isBuffer(pt.input), faceRatio: r2(pt.faceRatio, 3), blurScore: r2(pt.blurScore, 1), w: pm.width, h: pm.height };
      row.ms.prep = Date.now() - t;
      // 2) Poz: 2B (yaw kapısı/selfie sırası) + 3B ağ + prompt pozu — canlıda hazırlanmış tamponla.
      t = Date.now();
      const p2 = (await FQ.headPoseOf(prepBuf)) || (await FQ.headPoseOf(prepBuf, 0.1));
      row.pose2d = p2 ? { yaw: r2(p2.yaw), yawSigned: r2(p2.yawSigned) } : null;
      const p3 = await H.headPose3dOf(prepBuf);
      row.pose3d = p3 ? { src: p3.src, yaw: r2(p3.yaw, 1), pitch: r2(p3.pitch, 1), roll: r2(p3.roll, 1), chinX: r2(p3.chinX, 3), chinY: r2(p3.chinY, 3), faceW: r2(p3.faceW, 3) } : null;
      const pp = p3 ? await F.basePromptPose(prepBuf, p3) : null;
      row.promptPose = pp ? Object.fromEntries(Object.entries(pp).map(([k, v]) => [k, typeof v === "number" ? r2(v, 3) : v])) : null;
      row.ms.pose = Date.now() - t;
      // 3) Şapka (canlıdaki templateHat görevi).
      t = Date.now();
      const hat = await PT.templateHat({ tpl: prepBuf });
      row.hat = hat ? { hat: !!hat.hat, reason: hat.reason || null, area: r2(hat.area, 3), owl: r2(hat.owl, 2) } : null;
      row.ms.hat = Date.now() - t;
      // 4) Bitirme ölçüleri (özgün şablon üzerinde, faceTone/faceDetail/faceGlow ile aynı fonksiyonlar).
      t = Date.now();
      row.light = await lightOf(src);
      const st = await det.matchFaceStructure(src, src).catch(() => null);
      row.structure = st ? { rel: r2(st.tpl, 3) } : null;
      const gl = await glow.applyGlowFilter(src, { strength: 0.45, bgStrength: 0.45 }).catch(() => null);
      row.glowGate = gl ? { bgL: r2(gl.bgL, 1), gate: r2(gl.gate != null ? gl.gate : 0), applies: !!gl.applied } : null;
      row.ms.finish = Date.now() - t;
      // 5) Türetilmiş işaretler (bugünkü canlı eşiklerle).
      const yaw = p3 && p3.src === "mesh" ? p3.yaw : null, pitch = p3 && p3.src === "mesh" ? p3.pitch : null;
      row.flags = {
        bowed: pitch != null && pitch <= -F.BOWED,
        frontal: yaw != null && Math.abs(yaw) < 15,
        angled: yaw != null && Math.abs(yaw) >= 15 && Math.abs(yaw) <= 50,
        profile: yaw != null && Math.abs(yaw) > 50,
        smallFace: row.pose3d && row.pose3d.faceW != null && row.pose3d.faceW < 0.08,
        hat: !!(row.hat && row.hat.hat),
        darkScene: !!(row.light && row.light.darkScene), backlit: !!(row.light && row.light.backlit), sideLight: !!(row.light && row.light.sideLight),
      };
      row.vision = { eyewear: null, mst: null, note: "ücretli Vision ölçümü — doldurulmadı" };
      // CANLININ OKUDUĞU TAM DEĞERLER (yuvarlamasız; falPhotos templateMetaOf). Şapkalı şablonda maske
      // gerektiği için şapka canlıda ölçülür (raw.hat yalnız hat=false iken).
      row.raw = {
        faceRatio: Number.isFinite(pt.faceRatio) ? pt.faceRatio : null, cropped: Buffer.isBuffer(pt.input),
        pose2d: p2 ? { yaw: p2.yaw, yawSigned: p2.yawSigned != null ? p2.yawSigned : null } : null,
        pose3d: p3 || null, promptPose: pp || null,
        hat: hat && hat.hat === false ? { hat: false, reason: hat.reason || null, score: hat.score ?? null, hair: hat.hair ?? null, area: hat.area ?? null } : null,
      };
    } catch (e) {
      row.err = String(e.message || e);
    }
    row.ms.total = Date.now() - t0;
    templates[f.name] = row;
    console.log(`${i}/${list.length} ${path.basename(f.name).slice(0, 40)} yaw=${row.pose3d && row.pose3d.yaw} pitch=${row.pose3d && row.pose3d.pitch} şapka=${row.hat && row.hat.hat} ışık=${row.light && row.light.faceL}/${row.light && row.light.ringL} ${row.ms.total}ms${row.err ? " HATA " + row.err : ""}`);
    fs.writeFileSync(OUT, JSON.stringify({ version: 2, style: STYLE, band: BAND, prefix: PREFIX, builtAt: new Date().toISOString(), count: Object.keys(templates).length, templates }, null, 1));
  }
  srv.close();
  fs.writeFileSync(OUT, JSON.stringify({ version: 2, style: STYLE, band: BAND, prefix: PREFIX, builtAt: new Date().toISOString(), count: Object.keys(templates).length, templates }, null, 1));
  console.log("BİTTİ", OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
