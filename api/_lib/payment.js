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

module.exports = { withLinkMetadata, stableUuid, sessionProps, amountOf, capturePurchase, ghlPaymentPayload, contentName };
