const Stripe = require("stripe");
const { PostHog } = require("posthog-node");
const { sendMetaEvent, clientIp } = require("./_lib/meta");
const { sendToGhl } = require("./_lib/ghl");

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

let posthog = null;
function getPostHog() {
  if (!process.env.POSTHOG_KEY) return null;
  if (!posthog) {
    posthog = new PostHog(process.env.POSTHOG_KEY, {
      host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com",
    });
  }
  return posthog;
}

// Wordt aangeroepen vanaf bedankt.html met ?session_id=... (de Stripe Checkout
// Session ID). Bevestigt de betaling bij Stripe zelf voor we `purchase_completed`
// tracken - een bezoek aan de bedankpagina is nog geen geslaagde betaling.
// Dit endpoint is de client-side bevestiging; /api/stripe-webhook is de
// betrouwbare server-naar-server bron (ook als de klant het tabblad sluit).
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const sessionId = req.query && req.query.session_id;
  if (!sessionId) return res.status(400).json({ ok: false, error: "missing_session_id" });

  const s = getStripe();
  if (!s) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

  try {
    const session = await s.checkout.sessions.retrieve(String(sessionId));
    const paid = session.payment_status === "paid";
    // Bij de €49-test (v7/v8) staat het plan in de metadata: "doorlopend" of "eenmalig".
    const plan = (session.metadata && session.metadata.plan) || null;
    // Bij de €49-test vraagt Stripe de Instagram-naam (custom field "instagram").
    const igField = (session.custom_fields || []).find((f) => f.key === "instagram");
    const insta = igField && igField.text && igField.text.value ? String(igField.text.value).trim() : null;

    if (paid) {
      const leadId = session.client_reference_id || null;
      const ph = getPostHog();
      if (ph) {
        ph.capture({
          distinctId: leadId || session.id,
          event: "purchase_completed",
          // stable uuid: dezelfde sessie via client én webhook telt maar één keer
          uuid: `stripe_${session.id}`,
          properties: {
            amount_total: session.amount_total ? session.amount_total / 100 : null,
            currency: session.currency,
            lead_id: leadId,
            plan,
            insta,
            source: "verify_payment_client",
          },
        });
        await ph.shutdown();
      }
      // Meta Conversions API vanuit de browser-sessie van de koper: met IP,
      // user agent en fbp/fbc voor een betere match. Zelfde event_id als de
      // pixel op bedankt.html en /api/stripe-webhook -> telt als één aankoop.
      const cd = session.customer_details || {};
      // GoHighLevel "PV - Betaald": vanaf de bedankpagina, na verificatie bij
      // Stripe (een los bezoek aan bedankt.html telt dus nooit als betaling).
      // Staat de Stripe-webhook ingesteld, dan stuurt die het seintje al en
      // slaan we het hier over om dubbele meldingen in GHL te voorkomen.
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        await sendToGhl("payment", {
          event: "payment_completed",
          payment_status: "betaald",
          lead_id: leadId,
          email: cd.email || session.customer_email || null,
          phone: cd.phone || null,
          name: cd.name || null,
          amount: session.amount_total ? session.amount_total / 100 : null,
          currency: session.currency ? String(session.currency).toUpperCase() : "EUR",
          stripe_session_id: session.id,
          stripe_customer_id: session.customer || null,
          paid_at: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
          plan,
          insta,
          niche: (session.metadata && session.metadata.niche) || null,
          doel: (session.metadata && session.metadata.doel) || null,
          product: plan ? "test_49_14_dagen" : "groeisysteem_190",
          source: "bedankt_pagina",
        });
      }
      await sendMetaEvent({
        eventName: "Purchase",
        eventId: `purchase_${session.id}`,
        eventSourceUrl: req.headers.referer || undefined,
        user: {
          email: cd.email || session.customer_email,
          phone: cd.phone,
          name: cd.name,
          externalId: leadId,
          ip: clientIp(req),
          ua: req.headers["user-agent"],
          fbp: req.query.fbp,
          fbc: req.query.fbc,
        },
        customData: {
          value: session.amount_total ? session.amount_total / 100 : null,
          currency: session.currency ? String(session.currency).toUpperCase() : "EUR",
          content_name: plan ? "PromoView 14 dagen testen" : "PromoView Groeisysteem",
        },
      });
    }

    return res.status(200).json({
      ok: true,
      paid,
      amount_total: session.amount_total ? session.amount_total / 100 : null,
      currency: session.currency,
      lead_id: session.client_reference_id || null,
      plan: (session.metadata && session.metadata.plan) || null,
      email: session.customer_details ? session.customer_details.email : null,
    });
  } catch (e) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }
};
