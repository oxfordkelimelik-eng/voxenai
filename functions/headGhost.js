/**
 * KAFA ÇEVRESİ KALINTI KAPISI — şablon kişisinin izi (2026-10-10).
 *
 * SORUN (kullanıcı, teslim edilen ve reddedilen kareler): yeni kafanın
 * çevresinde şablondaki kişiden soluk bir iz kalıyor — kıvırcık saçın beyaz
 * silüeti (b602b4b0 c0 1. deneme), kafanın üstünde gri saç halesi (ec81364e
 * c9), gözün yanında güneş gözlüğü camı (b8ae3f8d c5), yüzün yanında saydam
 * profil (61079257 c6). Ortak nokta: şablon kişisi yeni kişiden daha geniş
 * bir alan kaplıyor (kabarık saç, gözlük, profil burnu) ve model o fazlalığı
 * arka plana çevirirken izini bırakıyor. Kafa küçültmesi de aynı izi
 * üretebiliyor (dolgu modeli kafayı eski boyunda çizerse).
 *
 * NEDEN VISION: dört piksel ölçüsü denendi, hiçbiri ayırmadı — şablon
 * kenarının çıktıdaki yankısı (yeni kişinin konturu şablonunkiyle zaten
 * çakışıyor), kafa kırpımında kişi maskesi (iz kişinin parçası sayılıyor),
 * aksesuar sınıfı (saat/kulaklık daha büyük alan), şablon karışım oranı
 * (maske saç tepesini kaçırınca yanlış alarm; ec81 c9 halesi karışım değil
 * açık renk leke). İz gözle bariz; faceArtifactCrop.js'te kanıtlanan
 * yakınlaştırılmış kırpma yöntemi kullanılır.
 *
 * ŞABLON KIRPIMI DA VERİLİR: iz şablon kişisinin şeklini taşır (onun saçı,
 * onun gözlüğü, onun profili). Model iki kırpımı karşılaştırınca yeni
 * kişinin kendi saç telini ya da arka plandaki nesneyi iz sanmaz.
 *
 * FAIL-SAFE: yüz yok / cevap okunamadı / ağ hatası -> ELEMEZ.
 */
const sharp = require("sharp");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// gpt-4.1: 91 etiketli karede v3 prompt ile 0/75 yanlış alarm, belirgin
// kalıntının 10/11'i (gpt-4o v1 promptta 31/83 yanlış alarm verdi; gpt-5
// aynı sette daha çok yanlış alarm).
const HEAD_GHOST_MODEL = "gpt-4.1";
// Kırpım yüz kutusu cinsinden: kalıntı kafanın üstünde (saç halesi) ve
// yanlarında (profil, gözlük) — yüz kutusunun çok dışına taşıyor.
const CROP_W = 3.0;
const CROP_UP = 1.4;
const CROP_DOWN = 1.3;
const CROP_LONG_EDGE = 768;
const FACE_MIN_BOX_PX = 32;

const SYSTEM_MSG =
  "You are an automated quality-assurance component inside an image-" +
  "generation pipeline. You report rendering defects only — you never " +
  "identify, name, or speculate about who anyone is.";

// Örnek ifade VERİLMEZ (2026-10-10 ilk ölçüm): "grey hair halo above the
// head" örneği varken model 83 temiz karenin 31'ine aynı cümleyle GHOST
// dedi. Önce her bölgede gerçekte ne gördüğü yazdırılır, karar sonra.
const PROMPT =
  "Two crops of the same scene. IMAGE 1 is the ORIGINAL photo. IMAGE 2 is an edited " +
  "version in which the man's head was replaced by a different man's head.\n\n" +
  "Step 1. Describe, in 3 to 8 plain words each, exactly what is visible in IMAGE 2 in " +
  "these three places, just outside the new man's head and hair:\n" +
  "ABOVE: the area right above his hair\n" +
  "LEFT: the area right beside the left side of his head\n" +
  "RIGHT: the area right beside the right side of his head\n" +
  "Describe only what you actually see (for example a wall, sky, a curtain, leaves, a " +
  "window, a lamp, a person in the background).\n\n" +
  "Step 2. Decide. Answer GHOST only if in one of those places you can clearly see a " +
  "faint or see-through copy of part of the ORIGINAL man from IMAGE 1 — his hair, " +
  "head outline, face profile or glasses — that is not attached to the new man and " +
  "should have been replaced by background. This includes thin loose strands or loops " +
  "of hair floating over the background beyond the new man's hairline, where the " +
  "ORIGINAL man's bigger or curlier hair used to be. Background that also appears in IMAGE 1, " +
  "the new man's own hair and glasses on his face are NOT a ghost. When unsure, answer NONE.\n\n" +
  "Reply on exactly five lines:\n" +
  "ABOVE: <words>\n" +
  "LEFT: <words>\n" +
  "RIGHT: <words>\n" +
  "LEFTOVER: <NONE | GHOST>\n" +
  "WHERE: <ABOVE | LEFT | RIGHT | NONE>";

const REGIONS = ["ABOVE", "LEFT", "RIGHT"];

/**
 * Cevabı ayrıştırır. SAF — testten çağrılır.
 * Döner: { ok:true, bad, where, detail } | { ok:false, reason }
 * LEFTOVER satırı bağlayıcıdır; yoksa okunamadı sayılır (ELEMEZ).
 */
function parseHeadGhostReply(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
  const line = /LEFTOVER\s*:\s*(NONE|GHOST)/i.exec(raw);
  if (!line) return { ok: false, reason: "unparsable" };
  const bad = line[1].toUpperCase() === "GHOST";
  const lines = raw.split("\n").map((l) => l.trim());
  const field = (k) => {
    const l = lines.find((x) => x.toUpperCase().startsWith(k + ":"));
    return l ? l.slice(k.length + 1).trim() : "";
  };
  const where = field("WHERE").toUpperCase().slice(0, 20);
  const detail = (REGIONS.includes(where) ? field(where) : REGIONS.map(field).join(" / ")).slice(0, 120);
  return { ok: true, bad, where, detail };
}

/** Kırpım dikdörtgeni (görüntü sınırlarına kırpılmış). SAF. */
function headCropRect(faceBox, W, H) {
  const cx = faceBox.x + faceBox.width / 2;
  const half = (CROP_W * faceBox.width) / 2;
  const left = Math.max(0, Math.round(cx - half));
  const right = Math.min(W, Math.round(cx + half));
  const top = Math.max(0, Math.round(faceBox.y - CROP_UP * faceBox.height));
  const bottom = Math.min(H, Math.round(faceBox.y + faceBox.height + CROP_DOWN * faceBox.height));
  return { left, top, width: Math.max(16, right - left), height: Math.max(16, bottom - top) };
}

/**
 * @param {Buffer} buf çıktı karesi
 * @param {Buffer} templateBuf şablon (herhangi boyut; çıktı boyutuna gerilir)
 * @param {{x,y,width,height}} faceBox çıktıdaki yüz kutusu
 * @param {string} apiKey
 */
async function judgeHeadGhost(buf, templateBuf, faceBox, apiKey, { model = HEAD_GHOST_MODEL, prompt = PROMPT, rectOf = headCropRect, enhance = false } = {}) {
  try {
    if (!Buffer.isBuffer(buf) || !Buffer.isBuffer(templateBuf) || !faceBox || !apiKey) {
      return { ok: false, reason: "insufficient-input" };
    }
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "insufficient-input" };
    if (faceBox.width < FACE_MIN_BOX_PX || faceBox.height < FACE_MIN_BOX_PX) {
      return { ok: false, reason: "face-too-small" };
    }
    const r = rectOf(faceBox, meta.width, meta.height);
    const scale = CROP_LONG_EDGE / Math.max(r.width, r.height);
    const size = [Math.max(1, Math.round(r.width * scale)), Math.max(1, Math.round(r.height * scale))];
    const tFull = await sharp(templateBuf).rotate().resize(meta.width, meta.height, { fit: "fill" }).toBuffer();
    const crop = async (b) => {
      let img = sharp(b).extract(r).resize(size[0], size[1], { fit: "fill" });
      if (enhance) img = img.normalise({ lower: 1, upper: 99 });
      return img.jpeg({ quality: 92 }).toBuffer();
    };
    const [tCrop, oCrop] = await Promise.all([crop(tFull), crop(buf)]);
    const img = (b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}`, detail: "high" } });
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        // gpt-5 ailesi temperature/max_tokens almıyor.
        ...(/^gpt-5|^o\d/.test(model) ? { max_completion_tokens: 4000 } : { temperature: 0, max_tokens: 120 }),
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: [{ type: "text", text: prompt }, img(tCrop), img(oCrop)] },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    const json = await resp.json();
    if (json.usage) {
      const u = json.usage;
      require("./jobContext").recordUsage(model, u);
      console.log(`MALIYET KAFA KALINTI: girdi=${u.prompt_tokens ?? "?"} cikti=${u.completion_tokens ?? "?"} model=${model}`);
    }
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    return { ...parseHeadGhostReply(raw), raw };
  } catch (e) {
    console.error("Kafa kalıntı yargısı hata verdi (atlanıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

// KÜÇÜLTME İZİ (2026-10-16, c29a2b31 c1): kafa küçültüldükten sonra eski,
// büyük kafanın yarı saydam koyu izi saçın üstünde kaldı ve judgeHeadGhost
// "kalıntı yok" dedi — o soru ŞABLON kişisinin izini arar ve "yeni adamın
// kendi saçı kalıntı değildir" der; buradaki iz yeni adamın kendi eski
// boyudur. Bu soru küçültme ÖNCESİ kareyle karşılaştırır. Kişi maskesi
// saçın üstündeki koyu kirişi saç sayıp kafayla taşıyordu; piksel ölçüleri
// (delikte saç olasılığı, maskede kafa olmayan pus) izi saç gördü.
const SCALE_PROMPT =
  "Two crops of the same photo. In IMAGE 2 the man's head was made smaller than in IMAGE 1 " +
  "and the uncovered area was filled with background.\n\n" +
  "Step 1. Describe, in 3 to 8 plain words each, exactly what is visible in IMAGE 2 just " +
  "outside the smaller head and hair:\n" +
  "ABOVE: the area right above his hair\n" +
  "LEFT: the area right beside the left side of his head\n" +
  "RIGHT: the area right beside the right side of his head\n\n" +
  "Step 2. Decide. Answer GHOST only if in one of those places IMAGE 2 clearly shows a " +
  "leftover of the BIGGER head from IMAGE 1: a dark or see-through HAIR-SHAPED bump or cap, a " +
  "second hair outline above or beside the real one, in the shape of the old head, sitting over " +
  "the background. NOT a ghost: the smaller head's own hair, background objects that also " +
  "appear in IMAGE 1, and a smooth, soft or slightly blurred patch of plain background where the " +
  "old head was filled in. When unsure, answer NONE.\n\n" +
  "Reply on exactly five lines:\n" +
  "ABOVE: <words>\n" +
  "LEFT: <words>\n" +
  "RIGHT: <words>\n" +
  "LEFTOVER: <NONE | GHOST>\n" +
  "WHERE: <ABOVE | LEFT | RIGHT | NONE>";

/**
 * Küçültme sonrası eski kafanın izi var mı? preBuf: küçültme öncesi kare,
 * buf: sonrası (aynı boyut). Döner judgeHeadGhost ile aynı biçim.
 * FAIL-SAFE: okunamazsa { ok:false } — çağıran elemez.
 */
async function judgeScaleResidue(buf, preBuf, faceBox, apiKey, { model = HEAD_GHOST_MODEL } = {}) {
  return judgeHeadGhost(buf, preBuf, faceBox, apiKey, { model, prompt: SCALE_PROMPT, rectOf: headTopCropRect, enhance: true });
}

/**
 * Kafanın üstü ve yanları, sıkı kırpım (yüz kutusu cinsinden). Geniş
 * kırpımda ve karanlık sahnede iz görünmedi (c1: iki denemede NONE); bu
 * kırpım + kontrast açma ile c1 GHOST 2/2, temiz c7 NONE 2/2. SAF.
 */
function headTopCropRect(faceBox, W, H) {
  const cx = faceBox.x + faceBox.width / 2;
  const left = Math.max(0, Math.round(cx - 1.2 * faceBox.width));
  const top = Math.max(0, Math.round(faceBox.y - 1.1 * faceBox.height));
  const right = Math.min(W, Math.round(cx + 1.2 * faceBox.width));
  const bottom = Math.min(H, Math.round(faceBox.y + 0.4 * faceBox.height));
  return { left, top, width: Math.max(16, right - left), height: Math.max(16, bottom - top) };
}

// ŞABLONDA GÖZLÜK (2026-10-10, kullanıcı kararı: "base'de gözlük varsa
// çıktıda da gözlük olsun"). Gözlüklü çıktıda gözler görünmez ve sayısal
// kimlik mesafesi eşiği aşar; bu soru o mesafenin güvenilir olup olmadığını
// söyler (bkz. falPhotos kimlik kapısı, profil istisnasıyla aynı usul).
const EYEWEAR_PROMPT =
  "Is the person in this photo wearing glasses or sunglasses ON THEIR EYES right now " +
  "(not pushed up on the head, not held in the hand)?\n" +
  "If yes: can you see their eyes through the lenses (clear or tinted lenses), or are the lenses opaque/dark?\n" +
  "Reply on two lines:\nEYEWEAR: <YES | NO>\nEYES_VISIBLE: <YES | NO>";

/** SAF. Döner { ok, eyewear, eyesVisible } | { ok:false, reason }. */
function parseEyewearReply(raw) {
  const m = /EYEWEAR\s*:\s*(YES|NO)/i.exec(raw || "");
  if (!m) return { ok: false, reason: "unparsable" };
  // Gözler camdan görünüyor mu (eyewear.keepOwnEyes). Okunamazsa null (2026-11-04
  // inceleme): eskiden false sayılıyordu ve koyu cam taşıması (sunglassTransfer)
  // renkli camlı base'de çalışıp base kişinin camın arkasındaki gözlerini
  // kullanıcının yüzüne taşıyabiliyordu (80fc7ec4 c2 yerel deneme). Taşıma artık
  // yalnız açık "NO"da; null'da yapay zeka yolu (gözsüz cam) — eski AI davranışı.
  const v = /EYES_VISIBLE\s*:\s*(YES|NO)/i.exec(raw || "");
  return { ok: true, eyewear: m[1].toUpperCase() === "YES", eyesVisible: v ? v[1].toUpperCase() === "YES" : null };
}

/**
 * Şablon kişisinin gözlüğü var mı? Yüz kutusu çevresi kırpılıp sorulur.
 * FAIL-SAFE: okunamazsa { ok:false } — çağıran gözlük YOK sayar (eski davranış).
 */
async function judgeEyewear(templateBuf, faceBox, apiKey) {
  try {
    if (!Buffer.isBuffer(templateBuf) || !faceBox || !apiKey) return { ok: false, reason: "insufficient-input" };
    const meta = await sharp(templateBuf).metadata();
    const pad = 0.4;
    const left = Math.max(0, Math.round(faceBox.x - pad * faceBox.width));
    const top = Math.max(0, Math.round(faceBox.y - pad * faceBox.height));
    const width = Math.min(meta.width - left, Math.round(faceBox.width * (1 + 2 * pad)));
    const height = Math.min(meta.height - top, Math.round(faceBox.height * (1 + 2 * pad)));
    if (width < 16 || height < 16) return { ok: false, reason: "face-too-small" };
    const crop = await sharp(templateBuf).extract({ left, top, width, height })
      .resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: HEAD_GHOST_MODEL,
        temperature: 0,
        max_tokens: 24,
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: [{ type: "text", text: EYEWEAR_PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${crop.toString("base64")}`, detail: "low" } }] },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    const json = await resp.json();
    if (json.usage) require("./jobContext").recordUsage(HEAD_GHOST_MODEL, json.usage);
    return parseEyewearReply((json?.choices?.[0]?.message?.content || "").trim());
  } catch (e) {
    console.error("Gözlük yargısı hata verdi (gözlük yok sayılıyor):", e.message || e);
    return { ok: false, reason: "error" };
  }
}

// CAMDAN GÖZ GÖRÜNÜYOR MU — İKİNCİ YARGI (2026-11-06). judgeEyewear bütün
// yüzü 512'ye küçültüp düşük çözünürlükte soruyor; renkli/açık camda bazen
// EYES_VISIBLE NO diyor ve sunglassTransfer base'in camını İÇİNDEKİ base
// gözleriyle kullanıcının yüzüne taşıyor (80fc7ec4 c2 yerel deneme, 7e04933e
// c4 11-03 teslimi). Yerel ölçüler (L* yayılımı "Kapı D", geçirgenlik
// oranları, OWLv2) koyu renkli camda sızdı ya da doğrulanmış temiz koyu/ayna
// taşımalarını (80f c3/c8, b932 c9) yanlış eledi. Bu soru yalnız iki camı
// kapsayan sıkı, büyütülmüş bir bantta sorulur; taşıma ancak İKİ yargı da
// NO derse yapılır. Bant göz noktalarından (face-api 68 nokta) çıkarılır.
// PROMPT ÖLÇÜMÜ (2026-11-06, 48 etiketli base + 12 yapay koyu renkli cam):
// tek soruluk "can you see the eyes? YES|NO" ve "önce betimle" sürümleri
// 80fc7ec4 c2'de (göz ve parıltılar camdan açıkça görünürken) NO dedi; "her
// cam ayrı YES|MAYBE|NO" + "camın arkasında göz VAR, gizli mi?" çerçevesi ile
// ölçülen V/F karelerin 12/13'ünde YES, doğrulanmış temiz koyu/ayna camlarda
// (80f c1/c3/c8, b932 c2/c9) NO. MAYBE = görünüyor sayılır (temkinli taraf).
// KESİN DEĞİL: prompt aynı karelerde ayarlandı (ayrı test kümesi yok).
// BİLİNEN SIZINTILAR (iki kez NO/NO): d87c25b4 c6 (gerçek base, sol camda
// iris ve kapak görünüyor), 9c8f2cb5 c0 (soluk göz), yapay 80fc7ec4 c2
// t<=0.3 ve 7e04933e c4 t=0.3 (sağ camda göz akı parıltısı).
const LENS_EYES_PROMPT =
  "This is a close-up crop of the eye area of a person wearing glasses or sunglasses. " +
  "Its local contrast has been enhanced so that details behind dark lenses are easier to see.\n\n" +
  "Behind each lens is one of the person's eyes. Look only at the lenses. For EACH lens separately, say whether that eye " +
  "shows through the glass: you can make out its almond shape, the iris or pupil, the white of the eye, the eyelid or the lashes — " +
  "even if the lens is dark and the eye is dim. Small bright glints sitting on the eye count as part of the eye.\n" +
  "Answer YES (the eye shows through), MAYBE (possibly, unclear) or NO. Answer NO only if the eye behind that lens is hidden: " +
  "the lens is opaque, solid black, or a mirror showing only reflected scenery, sky, buildings or lights.\n\n" +
  "Reply on exactly two lines:\n" +
  "LEFT_LENS: <YES | MAYBE | NO>\n" +
  "RIGHT_LENS: <YES | MAYBE | NO>";
// Bant göz arası (iod) cinsinden: cam merkezi gözün biraz altında, yarıçapı
// ~0.66 iod yatay / ~0.46 iod dikey (sunglassTransfer LENS_*); pay cömert.
const LENS_BAND_SIDE = 0.95;
const LENS_BAND_UP = 0.65;
const LENS_BAND_DOWN = 0.8;
// Yan dönük yüzde görüntüdeki göz arası kısalır; cam yine de yüz genişliğine
// yakın yer kaplar — en az yüz kutusunun bu oranı kadar alınır.
const LENS_BAND_MIN_IOD_BOX = 0.42;
// Görsel bu kutuya sığacak kadar BÜYÜTÜLÜR (high ayrıntıda tek karo; bantlar
// çoğunlukla 100-400 px, 512 bilgi kaybettirmiyor).
const LENS_BAND_MAX_W = 512;
const LENS_BAND_MAX_H = 512;
const LENS_BAND_MIN_PX = 24;
const LENS_CLAHE_TILE = 48;
const LENS_CLAHE_SLOPE = 4;
// Ölçülen yanıt 1-2 sn; asılı kalan istek iş süresini (900 sn) yemesin.
// Zaman aşımı = hata = göz görünüyor (taşıma yok).
const LENS_JUDGE_TIMEOUT_MS = 20000;

/**
 * SAF. Her cam için YES | MAYBE | NO. İki satır da okunmalı; herhangi bir camda
 * YES ya da MAYBE -> göz görünüyor (taşıma yok). Döner { ok:true, eyesThrough,
 * lenses:[sol, sağ] } | { ok:false, reason, eyesThrough:null }.
 */
function parseLensEyesReply(raw) {
  const s = raw || "";
  const l = /LEFT_LENS\W*(YES|MAYBE|NO)\b/i.exec(s), r = /RIGHT_LENS\W*(YES|MAYBE|NO)\b/i.exec(s);
  if (!l || !r) return { ok: false, reason: "unparsable", eyesThrough: null };
  const lenses = [l[1].toUpperCase(), r[1].toUpperCase()];
  return { ok: true, eyesThrough: lenses.some((v) => v !== "NO"), lenses };
}

/**
 * SAF. Taşımaya izin: yalnız okunmuş ve iki camda da NO. Hata, zaman aşımı,
 * okunamayan cevap, MAYBE -> izin yok (yapay zeka yolu, base gözü taşınmaz).
 */
function lensJudgeAllowsTransfer(r) {
  return !!r && r.ok === true && r.eyesThrough === false;
}

/**
 * SAF. İki camı kapsayan bant (orijinal görsel pikselleri). pts: face-api
 * 68 nokta (36-41 ve 42-47 gözler) ya da null; box: yüz kutusu. Göz noktası
 * yoksa yüz kutusundan tahmin edilir. Döner { left, top, width, height } | null.
 */
function lensBandRect(pts, box, W, H) {
  if (!box || !(W > 0) || !(H > 0)) return null;
  let cR = null, cL = null;
  if (Array.isArray(pts) && pts.length >= 48) {
    const c = (a, b) => { let x = 0, y = 0; for (let i = a; i <= b; i++) { x += pts[i].x; y += pts[i].y; } return [x / (b - a + 1), y / (b - a + 1)]; };
    cR = c(36, 41); cL = c(42, 47);
  }
  let x0, x1, y0, y1;
  if (cR && cL) {
    const s = Math.max(Math.hypot(cL[0] - cR[0], cL[1] - cR[1]), LENS_BAND_MIN_IOD_BOX * box.width);
    x0 = Math.min(cR[0], cL[0]) - LENS_BAND_SIDE * s; x1 = Math.max(cR[0], cL[0]) + LENS_BAND_SIDE * s;
    y0 = Math.min(cR[1], cL[1]) - LENS_BAND_UP * s; y1 = Math.max(cR[1], cL[1]) + LENS_BAND_DOWN * s;
  } else {
    x0 = box.x - 0.05 * box.width; x1 = box.x + 1.05 * box.width;
    y0 = box.y + 0.05 * box.height; y1 = box.y + 0.65 * box.height;
  }
  const left = Math.max(0, Math.round(x0)), top = Math.max(0, Math.round(y0));
  const right = Math.min(W, Math.round(x1)), bottom = Math.min(H, Math.round(y1));
  if (right - left < LENS_BAND_MIN_PX || bottom - top < LENS_BAND_MIN_PX) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Camın arkasında göz görünüyor mu? eyeBand: lensBandRect çıktısı.
 * FAIL-SAFE: girdi yok / ağ hatası / zaman aşımı / http hatası / okunamadı ->
 * { ok:false, eyesThrough:null } — çağıran bunu "göz görünüyor" sayar (taşıma
 * YOK). Retry yok. Çağrı ~$0.0011 (gpt-4.1, high, tek karo: ~500 girdi jetonu).
 */
async function judgeLensEyes(templateBuf, eyeBand, apiKey, { detail = "high", enhance = true, timeoutMs = LENS_JUDGE_TIMEOUT_MS } = {}) {
  try {
    if (!Buffer.isBuffer(templateBuf) || !eyeBand || !apiKey) return { ok: false, reason: "insufficient-input", eyesThrough: null };
    // Döndürme YOK: bant face-api noktalarından, onlar da EXIF'siz piksellerden.
    const big = await sharp(templateBuf).extract(eyeBand)
      .resize({ width: LENS_BAND_MAX_W, height: LENS_BAND_MAX_H, fit: "inside", kernel: "lanczos3" }).toBuffer();
    // YEREL KONTRAST (CLAHE): koyu camın arkasındaki göz yerelce açılınca
    // belirginleşiyor (0eeb75c8 c1 t=0.2 yapay tonda göz net), opak camda
    // (10ee6a46 c5) göz çıkmıyor. Daha sert ayar (slope 12) yüzü bozdu.
    const img = enhance ? sharp(big).clahe({ width: LENS_CLAHE_TILE, height: LENS_CLAHE_TILE, maxSlope: LENS_CLAHE_SLOPE }) : sharp(big);
    const crop = await img.jpeg({ quality: 92 }).toBuffer();
    const resp = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: HEAD_GHOST_MODEL,
        temperature: 0,
        max_tokens: 24,
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: [{ type: "text", text: LENS_EYES_PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${crop.toString("base64")}`, detail } }] },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}`, eyesThrough: null };
    const json = await resp.json();
    if (json.usage) require("./jobContext").recordUsage(HEAD_GHOST_MODEL, json.usage);
    const text = (json?.choices?.[0]?.message?.content || "").trim();
    // Ham yanıt loga gider (taşıma ATLANDI[lens-judge] satırı): canlı yanlış
    // ret oranı ilk işlerden sayılabilsin.
    return { ...parseLensEyesReply(text), raw: text.replace(/\s+/g, " ").slice(0, 80) };
  } catch (e) {
    console.error("Cam göz yargısı hata verdi (göz görünüyor sayılıyor, taşıma yok):", e.message || e);
    return { ok: false, reason: "error", eyesThrough: null };
  }
}

module.exports = { judgeHeadGhost, judgeScaleResidue, parseHeadGhostReply, headCropRect, judgeEyewear, parseEyewearReply, judgeLensEyes, parseLensEyesReply, lensJudgeAllowsTransfer, lensBandRect, PROMPT, SCALE_PROMPT, LENS_EYES_PROMPT };
