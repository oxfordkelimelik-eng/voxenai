"use strict";
// PROFİL DOKTORU + SOHBET RÖNTGENİ + ORTAK AI METİN ALTYAPISI (2026-11-22).
const test = require("node:test");
const assert = require("node:assert");
const P = require("../profileDoctor")._testables;
const R = require("../rizz")._testables;
const T = require("../aiText");

const img = { data: "QUJD".repeat(10), mimeType: "image/jpeg" };
const bio = (style, text) => ({ style, text, why: "neden" });

test("profil isteği: odak yalnız ana isteğe bağlıyken 'rewrite', enum dışı değerler varsayılana", () => {
  const r = P.parseRequest({ images: [img], goal: "x", gender: "male", focus: "rewrite", note: "<b>hemşire</b>" });
  assert.strictEqual(r.focus, "full", "ana istek yoksa tam analiz");
  assert.strictEqual(r.goal, "unsure");
  assert.ok(!("gender" in r) && !P.buildRequestText(r).includes("gender"), "cinsiyet gönderilmez");
  assert.ok(!/[<>]/.test(r.note));
  assert.strictEqual(P.parseRequest({ images: [img], focus: "rewrite", parentId: "abc123" }).focus, "rewrite");
  assert.strictEqual(P.parseRequest({ images: [img], focus: "full", parentId: "abc123" }).focus, "rewrite", "takipte tam analiz yok");
  assert.throws(() => P.parseRequest({ images: Array(P.MAX_IMAGES + 1).fill(img) }), (e) => e.code === "invalid-argument");
});

test("profil son denetim: görünüş hükmü, klişe bio, benzer bio düşer; tek 'lead'; eksik tür süzülür", () => {
  const req = P.parseRequest({ images: [img], avoid: ["eski bio metni burada duruyor ve tekrar etmemeli"] });
  const out = P.postValidate({
    status: "ok", platform: "tinder", first_impression: "Sıcak ama fotoğraflar uzak.",
    strengths: ["köpekli foto sohbet açtırır", "biraz kilo vermelisin"],
    photos: [
      { description: "kafede gülümseyen yakın çekim", verdict: "lead", why: "yüz net, ışık iyi" },
      { description: "plajda uzak çekim", verdict: "lead", why: "yüz seçilmiyor" },
      { description: "ayna selfiesi", verdict: "drop", why: "burnun büyük görünüyor" },
    ],
    missing_photos: ["full_body", "unicorn", "full_body", "social"],
    fixes: [{ area: "photos", text: "İlk fotoğrafı kafedeki yakın çekim yap" }, { area: "x", text: "zayıflaman lazım" }],
    bio_feedback: "Bio boş.",
    bios: [
      bio("playful", "kahve konusunda tartışmaya hazırım: filtre kahve abartılıyor mu, ikna et beni bakalım"),
      bio("sincere", "Seyahat etmeyi seven, hayatı dolu dolu yaşayan biriyim"),
      bio("confident", "Eski bio metni burada duruyor ve tekrar etmemeli!"),
      bio("sincere", "hafta içi hastanede nöbet, hafta sonu köpeğim Zeytin'le sahil yürüyüşü. sen hangi taraftasın?"),
      bio("confident", "çok kısa"),
    ],
    prompts: [{ question: "Beni en iyi anlatan şey…", answer: "pazar sabahı menemen soğanlı mı soğansız mı kavgası" }],
    tip: null,
  }, req);
  assert.deepStrictEqual(out.photos.map((p) => p.verdict), ["lead", "keep", "drop"], "ikinci lead keep'e iner");
  assert.strictEqual(out.photos[2].why, "", "görünüş hükmü olan gerekçe boşaltılır, foto kalır");
  assert.deepStrictEqual(out.strengths, ["köpekli foto sohbet açtırır"]);
  assert.deepStrictEqual(out.fixes.map((f) => f.area), ["photos"]);
  assert.deepStrictEqual(out.missingPhotos, ["full_body", "social"]);
  assert.deepStrictEqual(out.bios.map((b) => b.style), ["playful", "sincere"]);
  assert.strictEqual(out.prompts.length, 1);
  assert.ok(out.dropped.looks >= 3 && out.dropped.cliche === 1 && out.dropped.dup === 1 && out.dropped.length === 1, JSON.stringify(out.dropped));
});

test("görünüş filtresi: olağan profil içeriği geçer, hüküm yakalanır", () => {
  for (const ok of ["Diyetisyenim ama pizzaya hayır demem", "Göbeklitepe'de gün batımı, uzak çekim", "göbek dansı dersi alıyorum",
    "spor salonunda kilo kaldırırım", "Burnundan kıl aldırmaz derler", "10 kilometre koştum", "manzara çok güzel"]) {
    assert.strictEqual(P.looksJudgement(ok), false, ok);
  }
  for (const bad of ["Yakışıklı görünüyorsun, ilk foto çok çekici", "bu fotoda çok güzelsin", "zayıf görünüyorsun bu fotoda",
    "KİLO vermelisin", "kısa boylu görünüyorsun", "sakalını kes", "yaşlı gösteriyor", "you should lose some weight", "cildin parlıyor"]) {
    assert.strictEqual(P.looksJudgement(bad), true, bad);
  }
  const out = P.postValidate({ status: "ok", bios: [bio("sincere", "Diyetisyenim; hafta sonu göbek dansı, hafta içi menü planı. Sen tatlıcı mısın tuzlucu mu?")] }, P.parseRequest({ images: [img] }));
  assert.strictEqual(out.bios.length, 1, "bio metnine görünüş filtresi uygulanmaz");
});

test("profil: lead, süzülen fotoğraftan sonra atanır", () => {
  const out = P.postValidate({ status: "ok", photos: [
    { description: "", verdict: "lead", why: "x" },
    { description: "kafede yakın çekim", verdict: "lead", why: "net" },
  ] }, P.parseRequest({ images: [img] }));
  assert.deepStrictEqual(out.photos.map((p) => p.verdict), ["lead"]);
});

test("profil: ücretsiz sonuçta analiz boşaltılır; moderasyon dizin hizası", () => {
  const full = P.parseRequest({ images: [img] });
  assert.strictEqual(P.isChargeable({ status: "ok", bios: [], fixes: [], photos: [{}], firstImpression: "" }, full), true, "analiz de üründür");
  const r = { status: "ok", firstImpression: "a", strengths: ["s1"], photos: [{ description: "d", verdict: "lead", why: "w" }], missingPhotos: ["full_body"],
    fixes: [{ area: "bio", text: "f1" }, { area: "bio", text: "f2" }], bioFeedback: "bf", bios: [{ text: "b1" }, { text: "b2" }], prompts: [{ answer: "p1" }], tip: "t" };
  const stripped = P.stripUnpaid(r);
  assert.ok(!stripped.firstImpression && !stripped.photos.length && !stripped.fixes.length && !stripped.missingPhotos.length && stripped.bioFeedback === null);
  assert.ok(!stripped.prompts.length && !stripped.bios.length, "hak düşmeyen sonuçta prompt cevabı da verilmez");
  const texts = P.moderationTexts(r);
  assert.deepStrictEqual(texts, ["b1", "b2", "p1", "a", "s1", "w", "f1", "f2", "bf", "t"]);
  const flagged = texts.map((t) => ["b2", "w", "f1", "t"].includes(t));
  const m = P.applyModeration(r, { flagged });
  assert.deepStrictEqual(m.bios.map((b) => b.text), ["b1"]);
  assert.strictEqual(m.photos[0].why, "");
  assert.deepStrictEqual(m.fixes.map((f) => f.text), ["f2"]);
  assert.strictEqual(m.tip, null);
  assert.strictEqual(m.firstImpression, "a");
  assert.strictEqual(m.flaggedCount, 4);
});

test("profil: yaşam tarzı eksikleri AI'a yönlendirilmez; prompt grup kuralı", () => {
  assert.deepStrictEqual(P.LIFESTYLE_MISSING.sort(), ["hobby_activity", "social", "with_pet"]);
  assert.ok(P.SYSTEM_PROMPT.includes("never be nudged to fake a lifestyle") && P.SYSTEM_PROMPT.includes('"grup"'));
});

test("profil son denetim: rewrite odakta analiz boş; ok dışı durumda her şey boş", () => {
  const rw = P.postValidate({ status: "ok", first_impression: "x", fixes: [{ area: "bio", text: "y" }],
    bios: [bio("playful", "a".repeat(40) + " b c d")] }, P.parseRequest({ images: [img], parentId: "p1", focus: "rewrite" }));
  assert.strictEqual(rw.firstImpression, "");
  assert.strictEqual(rw.fixes.length, 0);
  assert.strictEqual(rw.bios.length, 1);
  const bad = P.postValidate({ status: "not_a_profile", bios: [bio("playful", "x".repeat(60))], fixes: [{ area: "bio", text: "y" }] }, P.parseRequest({ images: [img] }));
  assert.strictEqual(bad.bios.length + bad.fixes.length + bad.photos.length, 0);
  assert.strictEqual(P.postValidate(null, P.parseRequest({ images: [img] })).status, "unreadable");
  assert.strictEqual(P.postValidate({ status: "refused" }, P.parseRequest({ images: [img] })).status, "refused");
});

test("profil hak: ok + bio, ya da tam analizde düzeltme", () => {
  const full = P.parseRequest({ images: [img] });
  const rw = P.parseRequest({ images: [img], parentId: "p1", focus: "rewrite" });
  assert.strictEqual(P.isChargeable({ status: "ok", bios: [{}], fixes: [] }, full), true);
  assert.strictEqual(P.isChargeable({ status: "ok", bios: [], fixes: [{}], photos: [] }, full), true);
  assert.strictEqual(P.isChargeable({ status: "ok", bios: [], fixes: [{}], photos: [{}], firstImpression: "x" }, rw), false, "yalnız metin isteğinde bio şart");
  assert.strictEqual(P.isChargeable({ status: "ok", bios: [], fixes: [], photos: [], firstImpression: "" }, full), false);
  assert.strictEqual(P.isChargeable({ status: "unsafe_minor", bios: [{}], fixes: [] }, full), false);
});

test("profil şeması katı mod; prompt görünüş yasağını ve odak kuralını içerir", () => {
  const check = (s, path) => {
    if (s.type === "object") {
      assert.strictEqual(s.additionalProperties, false, path);
      assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
      for (const [k, v] of Object.entries(s.properties)) check(v, `${path}.${k}`);
    }
    if (s.type === "array") check(s.items, `${path}[]`);
  };
  check(P.RESPONSE_SCHEMA, "$");
  assert.ok(P.SYSTEM_PROMPT.includes("NEVER judge or rate the person's face") && P.SYSTEM_PROMPT.includes("focus: rewrite"));
  for (const m of P.MISSING) assert.ok(P.SYSTEM_PROMPT.includes(m), m);
});

test("takip bağı: profil özeti RizzGPT özetinden ayrı (aynı görüntüyle çapraz kullanım yok)", () => {
  const pr = P.parseRequest({ images: [img] });
  const rz = R.parseRequest({ images: [img], mode: "reply" });
  assert.notStrictEqual(P.digestOf(pr)("tuz"), R.digestOf(rz)("tuz"));
});

test("röntgen: yalnız reply modunda ve ok/declined; etiketler ve tutarsız adım temizlenir", () => {
  const raw = { interest: "high", investment: "balanced", green_flags: ["sana geri soru soruyor", "tam bir narsist değil", ""],
    red_flags: ["x".repeat(81)], next_step: "give_space", summary: "İlgili görünüyor." };
  const a = R.sanitizeInsight(raw, "ok", "reply");
  assert.deepStrictEqual(a.greenFlags, ["sana geri soru soruyor"]);
  assert.deepStrictEqual(a.redFlags, []);
  assert.strictEqual(a.nextStep, "unclear", "ok durumunda 'uzak dur' gösterilmez");
  assert.strictEqual(R.sanitizeInsight({ ...raw, next_step: "ask_out" }, "declined", "reply").nextStep, "give_space");
  assert.strictEqual(R.sanitizeInsight(raw, "ok", "opener"), null);
  assert.strictEqual(R.sanitizeInsight(raw, "sensitive", "reply"), null);
  assert.strictEqual(R.sanitizeInsight({ interest: "unclear", investment: "unclear", green_flags: [], red_flags: [], next_step: "unclear", summary: "" }, "ok", "reply"), null);
  assert.strictEqual(R.sanitizeInsight({ ...raw, summary: "bence toksik biri" }, "ok", "reply").summary, null);
  assert.strictEqual(R.sanitizeInsight(raw, "ok", "reply", { turn: "no_messages" }), null, "profil: röntgen yok");
  assert.strictEqual(R.sanitizeInsight(raw, "ok", "reply", { confidence: "low" }), null, "taraflar belirsiz: röntgen yok");
  const few = R.sanitizeInsight({ ...raw, next_step: "ask_out" }, "ok", "reply", { messages: 2 });
  assert.strictEqual(few.interest, "unclear");
  assert.strictEqual(few.nextStep, "unclear", "az mesajdan adım çıkmaz");
});

test("röntgen: şemada ve promptta, cevaplardan önce", () => {
  const req = R.RESPONSE_SCHEMA.required;
  assert.ok(req.indexOf("insight") > -1 && req.indexOf("insight") < req.indexOf("replies"));
  assert.ok(R.SYSTEM_PROMPT.includes("G. insight"));
  const out = R.postValidate({ status: "ok", attribution_confidence: "high", transcript: [1, 2, 3, 4].map((n) => ({ speaker: "match", text: "m" + n })), insight: { interest: "medium", investment: "user_more", green_flags: [], red_flags: ["cevapları kısa"], next_step: "slow_down", summary: "" }, replies: [] }, R.parseRequest({ images: [img] }));
  assert.strictEqual(out.insight.investment, "user_more");
});

test("ortak: hak kararı, deneme tavanı varsayılanları, gün anahtarı", () => {
  assert.deepStrictEqual(T.quotaDecision({ usedToday: 2, dailyFree: 2, balance: 1 }), { source: "balance" });
  assert.ok(P.DEFAULTS.dailyAttempts >= P.DEFAULTS.dailyFree * (P.FOLLOWUP_MAX + 1));
  assert.ok(R.DEFAULTS.dailyAttempts >= R.DEFAULTS.dailyFree * (R.FOLLOWUP_MAX + 1));
  // 2026-11-24: en büyük paketin hakkı (10) ek haklarıyla bir günde kullanılabilsin.
  assert.strictEqual(P.DEFAULTS.dailyFree, 0);
  assert.ok(P.DEFAULTS.dailyAttempts >= 10 * (P.FOLLOWUP_MAX + 1));
  assert.ok(R.DEFAULTS.dailyAttempts >= 10 * (R.FOLLOWUP_MAX + R.SWAP_FIX_MAX + 1));
  assert.strictEqual(T.dayKey(Date.UTC(2026, 10, 22, 21, 30)), "2026-11-23");
});

test("risk: seviye sunucuda sinyallerden; kesin hüküm notu düşer; enum dışı sinyal süzülür", () => {
  assert.strictEqual(R.sanitizeRisk({ level: "high", signals: [], note: "x" }), null, "sinyal yoksa risk yok");
  assert.strictEqual(R.sanitizeRisk({ level: "none", signals: ["money_request"], note: "IBAN istedi; asla para gönderme." }).level, "high", "model 'none' dese de ağır sinyal = high");
  assert.strictEqual(R.sanitizeRisk({ level: "high", signals: ["love_bombing"], note: "" }).level, "low");
  assert.strictEqual(R.sanitizeRisk({ level: "low", signals: ["love_bombing", "move_off_app", "love_bombing", "bogus"] }).level, "medium");
  assert.deepStrictEqual(R.sanitizeRisk({ signals: ["bogus", "sextortion"] }).signals, ["sextortion"]);
  const fb = R.sanitizeRisk({ signals: ["money_request"], note: "Bu kişi dolandırıcı, engelle." }).note;
  assert.ok(fb && fb.includes("işareti olabilir"), "kesin hüküm sabit korumacı notla değişir");
  for (const v of ["Karşındaki büyük ihtimalle dolandırıcı, görüntülü görüşme iste.", "Bu hesap sahte, engelle.", "Bu klasik bir dolandırıcılık, engelle ve bildir.", "DOLANDIRICIDIR, para gönderme."]) {
    assert.notStrictEqual(R.sanitizeRisk({ signals: ["money_request"], note: v }).note, v, v);
  }
  for (const h of ["Bu kişi dolandırıcı olabilir; asla para gönderme.", "Kesin dolandırıcı diyemeyiz ama IBAN istemesi dolandırıcılık işareti olabilir; para gönderme."]) {
    assert.strictEqual(R.sanitizeRisk({ signals: ["money_request"], note: h }).note, h, h);
  }
  assert.ok(R.sanitizeRisk({ signals: ["sextortion"], note: "Bu kişi dolandırıcı." }).note.includes("Mahrem"), "şantajda kendi notu");
  assert.deepStrictEqual(R.sanitizeRisk({ signals: ["love_bombing", "money_request"] }, { hardOnly: true }).signals, ["money_request"], "belirsiz tarafta yalnız ağır");
  assert.strictEqual(R.sanitizeRisk({ signals: ["love_bombing"] }, { hardOnly: true }), null);
  assert.ok(R.sanitizeRisk({ signals: ["money_request"], note: "Dolandırıcılık işareti olabilir; para gönderme." }).note);
});

test("risk: belirsiz tarafta, sensitive'te ve az mesajda yalnız risk gösterilir; opener'da hiç", () => {
  const raw = { interest: "high", investment: "balanced", green_flags: ["soru soruyor"], red_flags: [], next_step: "ask_out", summary: "İlgili görünüyor.",
    risk: { level: "high", signals: ["crypto_investment"], note: "Yatırım teklifi var; para gönderme." } };
  const low = R.sanitizeInsight(raw, "ok", "reply", { confidence: "low" });
  assert.strictEqual(low.interest, "unclear");
  assert.strictEqual(low.greenFlags.length, 0);
  assert.strictEqual(low.risk.level, "high");
  assert.strictEqual(R.sanitizeInsight(raw, "sensitive", "reply").risk.signals[0], "crypto_investment");
  assert.strictEqual(R.sanitizeInsight(raw, "ok", "opener"), null);
  assert.strictEqual(R.sanitizeInsight(raw, "not_a_chat", "reply"), null);
  assert.strictEqual(R.sanitizeInsight(raw, "ok", "reply", { turn: "no_messages" }), null);
  const full = R.sanitizeInsight(raw, "ok", "reply", { confidence: "high", messages: 6 });
  assert.strictEqual(full.interest, "high");
  assert.strictEqual(full.risk.level, "high");
  assert.strictEqual(R.riskOnly(null), null);
});

test("risk: şemada ve promptta; sinyal listesi promptla uyumlu", () => {
  const ins = R.RESPONSE_SCHEMA.properties.insight;
  assert.ok(ins.required.includes("risk"));
  for (const sig of ins.properties.risk.properties.signals.items.enum) assert.ok(R.SYSTEM_PROMPT.includes(sig + ":"), sig);
  assert.ok(R.SYSTEM_PROMPT.includes("never that the person IS a scammer"));
  assert.ok(R.SYSTEM_PROMPT.includes("Asking for Instagram") && R.SYSTEM_PROMPT.includes("NOT a signal: splitting a shared bill"));
  assert.ok(!/home address/.test(R.SYSTEM_PROMPT), "ev adresi sinyal değil");
});

test("2026-11-23: başka reçete yaz hakkı sonuç başına 1", () => {
  assert.strictEqual(P.FOLLOWUP_MAX, 1);
});
