// Gedeelde logica voor een geslaagde Stripe-betaling, gebruikt door
// /api/verify-payment (bedankpagina) en /api/stripe-webhook (Stripe zelf).
// Beide mogen afgaan voor dezelfde betaling: PostHog en Meta tellen hem één keer.
const crypto = require("crypto");

// PostHog accepteert alleen echte UUID's. Afgeleid van de Stripe-id, zodat de
// bedankpagina en de webhook exact dezelfde uuid sturen en PostHog ze samenvoegt.
function stableUuid(key) {
  const h = crypto.createHash("sha256").update(String(key)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const VARIANT_BY_PLAN = { doorlopend: "v7", eenmalig: "v8" };

// Alles wat we over de koper en de bron weten, uit de Checkout Session.
function sessionProps(session) {
  const md = session.metadata || {};
  const ig = (session.custom_fields || []).find((f) => f.key === "instagram");
  const plan = md.plan || null;
  const props = {
    stripe_session_id: session.id,
    plan,
    product: plan ? "test_49_14_dagen" : "groeisysteem_190",
    insta: ig && ig.text && ig.text.value ? String(ig.text.value).trim() : null,
    lp_variant: md.lp_variant || VARIANT_BY_PLAN[plan] || null,
  };
  ["page_version", "niche", "doel", "utm_source", "utm_campaign", "utm_content", "ad_id", "adset_id", "campaign_id"].forEach(
    (k) => { if (md[k]) props[k] = md[k]; }
  );
  return props;
}

function amountOf(session) {
  return session.amount_total != null ? session.amount_total / 100 : null;
}

// purchase_completed in PostHog, op de persoon van de bezoeker (lead_id = client_reference_id).
function capturePurchase(ph, session, source) {
  if (!ph) return;
  const leadId = session.client_reference_id || null;
  ph.capture({
    distinctId: leadId || session.id,
    event: "purchase_completed",
    uuid: stableUuid(`purchase_${session.id}`),
    timestamp: new Date((session.created || Date.now() / 1000) * 1000),
    properties: Object.assign(
      { amount_total: amountOf(session), currency: session.currency, lead_id: leadId, source },
      sessionProps(session)
    ),
  });
}

// Payload voor de GoHighLevel-workflow "PV - Betaald".
function ghlPaymentPayload(session, source) {
  const cd = session.customer_details || {};
  const p = sessionProps(session);
  return {
    event: "payment_completed",
    payment_status: "betaald",
    lead_id: session.client_reference_id || null,
    email: cd.email || session.customer_email || null,
    phone: cd.phone || null,
    name: cd.name || null,
    insta: p.insta,
    niche: p.niche || null,
    doel: p.doel || null,
    plan: p.plan,
    product: p.product,
    lp_variant: p.lp_variant,
    amount: amountOf(session),
    currency: session.currency ? String(session.currency).toUpperCase() : "EUR",
    stripe_session_id: session.id,
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.subscription || null,
    paid_at: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
    source,
  };
}

function contentName(session) {
  return session.metadata && session.metadata.plan ? "PromoView 14 dagen testen" : "PromoView Groeisysteem";
}

// Eén keer melden per betaling (GoHighLevel en Slack), ook al komen de bedankpagina
// én de Stripe-webhook langs, of laadt de klant de bedankpagina opnieuw. De stempel
// staat in Stripe zelf, op het abonnement of de betaling.
async function claimOnce(s, session) {
  try {
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription && session.subscription.id;
    const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent && session.payment_intent.id;
    const api = subId ? s.subscriptions : piId ? s.paymentIntents : null;
    const id = subId || piId;
    if (!api) return true;
    const obj = await api.retrieve(id);
    if (obj.metadata && obj.metadata.pv_gemeld) return false;
    await api.update(id, { metadata: { pv_gemeld: new Date().toISOString() } });
    return true;
  } catch (e) {
    // Liever één melding te veel dan een gemiste betaling.
    console.error("[claimOnce]", e && e.message);
    return true;
  }
}

// +31612345678 -> 06 12345678, zodat het team meteen kan bellen.
function localPhone(p) {
  if (!p) return "onbekend";
  const d = String(p).replace(/[^\d+]/g, "");
  if (/^\+316\d{8}$/.test(d)) return "06 " + d.slice(4);
  if (/^\+324\d{8}$/.test(d)) return "04" + d.slice(4, 6) + " " + d.slice(6);
  return d;
}

const SOURCE = { ig: "Instagram-advertentie", fb: "Facebook-advertentie", an: "Audience Network", email: "e-mail" };

function stripeLink(path) { return `https://dashboard.stripe.com/${path}`; }

// Slack-bericht voor een nieuwe betaling.
function slackPaymentText(session) {
  const cd = session.customer_details || {};
  const p = sessionProps(session);
  const bedrag = amountOf(session);
  const wat = p.plan === "doorlopend" ? "€49 test (14 dagen, daarna €190 p/m)" : p.plan === "eenmalig" ? "€49 test (eenmalig)" : "Groeisysteem";
  const bron = p.lp_variant === "betaallink" ? "vaste betaallink" : (SOURCE[p.utm_source] || p.utm_source || "direct") + (p.utm_content ? ` (${p.utm_content})` : "");
  const lines = [
    `:moneybag: *Nieuwe betaling: ${wat}*  €${bedrag != null ? bedrag.toFixed(2).replace(".", ",") : "?"} incl. btw`,
    `*Naam:* ${cd.name || "onbekend"}   *Tel:* ${localPhone(cd.phone)}`,
    `*E-mail:* ${cd.email || session.customer_email || "onbekend"}   *Instagram:* ${p.insta || "onbekend"}`,
  ];
  if (p.niche || p.doel) lines.push(`*Branche:* ${p.niche || "-"}   *Doel:* ${p.doel || "-"}`);
  lines.push(`*Bron:* ${bron}`);
  if (session.customer) lines.push(`<${stripeLink("customers/" + session.customer)}|Bekijk in Stripe>`);
  lines.push("_Volgende stap: onboarding (Typeform). Bel of app de klant als die niet binnen een dag is ingevuld._");
  return lines.join("\n");
}

// Bij een aankoop via een vaste betaallink staat het plan op de link; zet het op de sessie.
async function withLinkMetadata(s, session) {
  if (!session || !session.payment_link || (session.metadata && session.metadata.plan)) return session;
  try {
    const id = typeof session.payment_link === "string" ? session.payment_link : session.payment_link.id;
    const pl = await s.paymentLinks.retrieve(id);
    return Object.assign({}, session, { metadata: Object.assign({}, pl.metadata || {}, session.metadata || {}) });
  } catch (_) {
    return session;
  }
}

module.exports = { claimOnce, localPhone, slackPaymentText, withLinkMetadata, stableUuid, sessionProps, amountOf, capturePurchase, ghlPaymentPayload, contentName };
