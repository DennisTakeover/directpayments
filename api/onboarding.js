const Stripe = require("stripe");
const { PostHog } = require("posthog-node");
const { sendSlack, ONBOARDING_CHANNEL } = require("./_lib/slack");
const { boardEvent } = require("./_lib/board");
const { sendProfielcheck } = require("./_lib/profielcheck");
const { nativeSession, stableUuid, localPhone } = require("./_lib/payment");
const { paySession } = require("./_lib/paypro");
const { sendMetaEvent, clientIp, fbFromCookies } = require("./_lib/meta");

// De eigen onboarding (onboarding.html), een kortere versie van de Typeform.
//
//   GET  /api/onboarding?ref=sub_...|cs_...  wat we al weten (voornaam, Instagram, branche),
//                                            zodat de klant dat niet opnieuw hoeft in te vullen.
//   POST /api/onboarding                     de antwoorden. Gaan naar:
//     - Make (MAKE_ONBOARDING_WEBHOOK_URL): hetzelfde vervolg als de Typeform (Google Sheet,
//       Trello-kaart, Trengo, Airtable, Slack-melding voor het team). De antwoorden staan
//       onder dezelfde veld-id's als in de Typeform, zodat dat vervolg één op één werkt.
//     - Slack #direct-payment (korte melding), PostHog (onboarding_completed) en Stripe
//       (stempel onboarding_ingevuld op het abonnement).

// Veld-id's van de Typeform "kjy12kQE" (zoals Make ze kent als mappable_answers).
const F = {
  kanaal: "19b052d5-1b2b-4824-9196-924b7a9b2548",
  insta: "8d493c5f-72b6-4c77-83c0-71194048f63b",
  voornaam: "5f645a10-b3c5-4d8b-99c0-67bc83f43a8c",
  email_groep: "794d92b9-5bf0-4d17-a446-a0e9a9076615",
  telefoon_groep: "33c90315-fc3c-49b3-97fd-87b8c46216bb",
  bedrijf: "029fdf1f-2a56-46b3-910a-e300c5ab5102",
  product_dienst: "e343fd04-dbac-4762-98e5-fc64f6b90efe",
  geslacht: "764b5850-41b7-45f4-803c-5b21a03beedb",
  leeftijd: "7c8bef7f-3029-47d8-addc-e02265363b13",
  locatie: "d689ed4d-bee2-4a1b-954c-8a896874e5bc",
  interesses: "ded1b452-dd8e-4b5c-bd0a-5cc485bfa3d2",
  profielen: "021d1d6b-becb-402f-ac7a-7b646d338a41",
  twee_fa: "b0e8a9dc-8a34-4469-9ea4-15cddc41db20",
  welkomstbericht: "42060be8-8b71-443c-be1e-71419f75aaf9",
  email: "338ec791-e49d-491a-8fba-6022f7716295",
  telefoon: "4252b924-bb27-4386-b7a0-1aafa947b1ff",
};

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}
let posthog = null;
function getPostHog() {
  if (!process.env.POSTHOG_KEY) return null;
  if (!posthog) posthog = new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" });
  return posthog;
}

const clean = (v, max) => (v == null ? "" : String(v).replace(/\r/g, "").trim().slice(0, max || 300));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const handle = (v) => {
  let u = clean(v, 120);
  const m = u.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) u = m[1];
  u = u.replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : "";
};
function e164(v) {
  let d = String(v || "").replace(/[\s().-]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^06\d{8}$/.test(d)) return "+31" + d.slice(1);
  if (/^04\d{8}$/.test(d)) return "+32" + d.slice(1);
  if (/^0[1-9]\d{8}$/.test(d)) return "+31" + d.slice(1);
  return /^\+\d{8,15}$/.test(d) ? d : "";
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
}

// Klantgegevens bij de betaling: eigen betaalstap (sub_...) of Stripe Checkout (cs_...).
async function lookup(s, ref) {
  ref = clean(ref, 120);
  if (!ref) return null;
  try {
    if (/^PS[A-Z0-9]+$/.test(ref)) {
      const { session, paid } = await paySession(ref);
      if (!session || !paid) return null;
      const cd = session.customer_details || {};
      return { ref, subId: ref, name: cd.name, email: cd.email, phone: cd.phone, insta: (session.metadata || {}).insta, md: session.metadata || {}, leadId: session.client_reference_id, paypro: true };
    }
    if (!s) return null;
    if (/^sub_\w+$/.test(ref)) {
      const { session, paid } = await nativeSession(s, ref);
      if (!session || !paid) return null;
      const cd = session.customer_details || {};
      return { ref, subId: ref, name: cd.name, email: cd.email, phone: cd.phone, insta: (session.metadata || {}).insta, md: session.metadata || {}, leadId: session.client_reference_id };
    }
    if (/^cs_\w+$/.test(ref)) {
      const cs = await s.checkout.sessions.retrieve(ref);
      if (cs.payment_status !== "paid") return null;
      const cd = cs.customer_details || {};
      const ig = (cs.custom_fields || []).find((f) => f.key === "instagram");
      return {
        ref, subId: typeof cs.subscription === "string" ? cs.subscription : null,
        name: cd.name, email: cd.email || cs.customer_email, phone: cd.phone,
        insta: ig && ig.text ? ig.text.value : null, md: cs.metadata || {}, leadId: cs.client_reference_id,
      };
    }
  } catch (_) {}
  return null;
}

async function toMake(payload) {
  const url = process.env.MAKE_ONBOARDING_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: "make_not_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: "make_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const s = getStripe();

  if (req.method === "GET") {
    const k = await lookup(s, req.query && req.query.ref);
    if (!k) return res.status(200).json({ ok: true, known: false });
    return res.status(200).json({
      ok: true,
      known: true,
      voornaam: k.name ? String(k.name).trim().split(/\s+/)[0] : null,
      insta: k.insta || null,
      niche: k.md.niche || null,
      doel: k.md.doel || null,
    });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const b = readBody(req);
  const k = await lookup(s, b.ref);

  const name = clean((k && k.name) || b.naam, 100);
  const email = clean((k && k.email) || b.email, 200).toLowerCase();
  const phone = (k && k.phone) || e164(b.telefoon);
  const insta = handle(b.insta) || handle(k && k.insta);
  const profielen = (Array.isArray(b.profielen) ? b.profielen : []).map(handle).filter(Boolean).slice(0, 6);
  const a = {
    bedrijf: clean(b.bedrijf, 1500),
    product_dienst: clean(b.product_dienst, 20),
    geslacht: clean(b.geslacht, 20),
    leeftijd: (Array.isArray(b.leeftijd) ? b.leeftijd : [b.leeftijd]).map((x) => clean(x, 12)).filter(Boolean).join(", "),
    locatie: clean(b.locatie, 300),
    interesses: clean(b.interesses, 600),
    twee_fa: clean(b.twee_fa, 20),
    welkomstbericht: clean(b.welkomstbericht, 1000),
  };

  const missing = [];
  if (!insta) missing.push("insta");
  if (a.bedrijf.length < 5) missing.push("bedrijf");
  if (!a.product_dienst) missing.push("product_dienst");
  if (!a.geslacht) missing.push("geslacht");
  if (!a.leeftijd) missing.push("leeftijd");
  if (a.locatie.length < 2) missing.push("locatie");
  if (a.interesses.length < 2) missing.push("interesses");
  if (profielen.length < 3) missing.push("profielen");
  if (!k) {
    if (name.length < 2) missing.push("naam");
    if (!isEmail(email)) missing.push("email");
    if (!phone) missing.push("telefoon");
  }
  if (missing.length) return res.status(400).json({ ok: false, error: "missing_fields", fields: missing });

  const voornaam = name.split(/\s+/)[0] || "";
  const answers = {
    [F.kanaal]: "Website (eigen onboarding)",
    [F.insta]: insta,
    [F.voornaam]: voornaam,
    [F.email_groep]: email,
    [F.telefoon_groep]: phone,
    [F.email]: email,
    [F.telefoon]: phone,
    [F.bedrijf]: a.bedrijf,
    [F.product_dienst]: a.product_dienst,
    [F.geslacht]: a.geslacht,
    [F.leeftijd]: a.leeftijd,
    [F.locatie]: a.locatie,
    [F.interesses]: a.interesses,
    [F.profielen]: profielen.join("\n"),
    [F.twee_fa]: a.twee_fa,
    [F.welkomstbericht]: a.welkomstbericht,
  };

  const md = (k && k.md) || {};
  const payload = {
    bron: "eigen_onboarding",
    ref: k ? k.ref : null,
    naam: name,
    plan: md.plan || null,
    niche: md.niche || null,
    doel: md.doel || null,
    ingevuld_op: new Date().toISOString(),
    mappable_answers: answers,
  };

  const make = await toMake(payload);
  if (!make.ok) console.error("[onboarding] make", make);

  const lines = [
    `:clipboard: *Onboarding ingevuld:* ${name || "onbekend"} (@${insta})${k ? "" : " _(zonder betaling gekoppeld)_"}`,
    `*Tel:* ${localPhone(phone)}   *E-mail:* ${email || "onbekend"}`,
    `*Bedrijf:* ${a.bedrijf.slice(0, 200)}${a.bedrijf.length > 200 ? "…" : ""}`,
    `*Doelgroep:* ${a.geslacht}, ${a.leeftijd}, ${a.locatie}. Interesses: ${a.interesses.slice(0, 150)}`,
    `*Accounts:* ${profielen.map((p) => "@" + p).join(", ")}`,
    `_Volgende stap: de klant koppelt zijn Instagram-account._${make.ok ? "" : "   :warning: _niet doorgestuurd naar Make, handmatig verwerken_"}`,
  ];

  // Trello: kaart naar "Onboarding binnen", antwoorden als opmerking. Zonder gekoppelde
  // betaling (of als de kaart nog niet bestaat) maakt Make er een nieuwe kaart voor.
  const board = boardEvent({
    event: "onboarding",
    key: k ? k.subId || k.ref : "onboarding_" + (email || insta),
    naam: name,
    insta,
    list: "onboarding",
    label: a.twee_fa === "Weet ik niet" ? "tfa" : undefined,
    card_name: `@${insta} · ${name || "onbekend"}`,
    card_desc: [`**Naam:** ${name || "onbekend"}`, `**Telefoon:** ${localPhone(phone)}`, `**E-mail:** ${email || "onbekend"}`,
      `**Instagram:** https://instagram.com/${insta}`, "", k ? `Ref: ${k.subId || k.ref}` : "_Onboarding zonder gekoppelde betaling: controleer of deze klant betaald heeft._"].join("\n"),
    comment: [
      "📝 **Onboarding ingevuld**",
      `**Bedrijf:** ${a.bedrijf}`,
      `**Product of dienst:** ${a.product_dienst}`,
      `**Doelgroep:** ${a.geslacht}, ${a.leeftijd}`,
      `**Locatie:** ${a.locatie}`,
      `**Interesses:** ${a.interesses}`,
      `**Vergelijkbare accounts:** ${profielen.map((p) => "@" + p).join(", ")}`,
      a.welkomstbericht ? `**Welkomstbericht:** ${a.welkomstbericht}` : "**Welkomstbericht:** schrijven wij",
    ].join("\n"),
  });

  const ph = getPostHog();
  const distinct = (k && (k.leadId || md.lead_id)) || email || insta;
  // Meta: CompleteRegistration, met dezelfde event-id als de pixel op de onboardingpagina
  // ("onb_" + ref, anders lead-id), zodat Meta browser + server als één event telt.
  const leadId = (k && (k.leadId || md.lead_id)) || clean(b.lead_id, 100) || null;
  const fb = fbFromCookies(req);
  const metaOnb = sendMetaEvent({
    eventName: "CompleteRegistration",
    eventId: "onb_" + (clean(b.ref, 100) || leadId || email),
    eventSourceUrl: req.headers.referer || "https://landing.promo-view.io/onboarding",
    user: { email, phone, name, externalId: leadId, ip: clientIp(req), ua: req.headers["user-agent"], fbp: fb.fbp, fbc: fb.fbc },
    customData: { content_name: "PromoView onboarding" },
  });
  await Promise.all([
    board,
    metaOnb,
    sendSlack(lines.join("\n"), ONBOARDING_CHANNEL),
    sendProfielcheck({ ref: k ? k.subId || k.ref : null, insta, naam: name, ...a, profielen, niche: md.niche, doel: md.doel })
      .then((r) => { if (!r.ok && !r.skipped) console.error("[onboarding] profielcheck", r); }),
    k && k.subId && s && !k.paypro ? s.subscriptions.update(k.subId, { metadata: { onboarding_ingevuld: new Date().toISOString() } }).catch(() => null) : null,
  ]);
  if (ph) {
    ph.capture({
      distinctId: distinct,
      event: "onboarding_completed",
      uuid: stableUuid(`onboarding_${(k && k.ref) || email}_${new Date().toISOString().slice(0, 10)}`),
      properties: { source: "server", omgeving: process.env.VERCEL_ENV === "production" ? "live" : "test", lead_id: leadId, ref: k ? k.ref : null, plan: md.plan || null, lp_variant: md.lp_variant || null, niche: md.niche || null, gekoppeld: !!k, make_ok: make.ok, profielen: profielen.length, twee_fa: a.twee_fa || null },
    });
    await ph.shutdown();
  }
  return res.status(200).json({ ok: true, voornaam });
};
