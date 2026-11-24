const Stripe = require("stripe");
const { PostHog } = require("posthog-node");
const { sendToGhl } = require("./_lib/ghl");
const { sendMetaEvent } = require("./_lib/meta");
const { sendSlack } = require("./_lib/slack");
const { nativeSession, claimOnce, localPhone, slackPaymentText, withLinkMetadata, stableUuid, amountOf, capturePurchase, ghlPaymentPayload, contentName } = require("./_lib/payment");

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

// Vercel parseert de body normaliter als JSON; voor Stripe-signature-verificatie
// hebben we de RAW body nodig, dus body-parsing staat hier uit.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const VARIANT_BY_PLAN = { doorlopend: "v7", eenmalig: "v8" };

// Stripe stuurt dit endpoint server-naar-server een melding, ook als de klant
// het tabblad sluit voordat bedankt.html laadt. In Stripe aan te zetten:
//   checkout.session.completed, checkout.session.async_payment_succeeded,
//   checkout.session.async_payment_failed, invoice.paid, invoice.payment_failed,
//   customer.subscription.trial_will_end, customer.subscription.updated,
//   customer.subscription.deleted
//
// Eerste betaling  -> purchase_completed (PostHog), "PV - Betaald" (GHL), Purchase (Meta)
// V7 na 14 dagen   -> trial_converted / subscription_renewed (PostHog), Subscribe (Meta)
// Opzeggen e.d.    -> subscription_cancel_requested / subscription_cancelled /
//                     trial_ending / payment_failed (PostHog)

// Metadata van het abonnement (lead_id, plan, variant, advertentie) bij een invoice.
async function subscriptionFor(s, invoice) {
  const id =
    (typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription && invoice.subscription.id) ||
    (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription) ||
    null;
  if (!id) return null;
  try { return await s.subscriptions.retrieve(id); } catch (_) { return null; }
}

function subProps(sub) {
  const md = (sub && sub.metadata) || {};
  const props = { stripe_subscription_id: sub ? sub.id : null, plan: md.plan || null, lp_variant: md.lp_variant || VARIANT_BY_PLAN[md.plan] || null };
  ["page_version", "niche", "doel", "utm_source", "utm_campaign", "utm_content", "ad_id", "adset_id", "campaign_id"].forEach(
    (k) => { if (md[k]) props[k] = md[k]; }
  );
  return props;
}

function distinctFor(sub, fallback) {
  return (sub && sub.metadata && sub.metadata.lead_id) || fallback;
}

async function onPaidSession(s, ph, session) {
  session = await withLinkMetadata(s, session);
  capturePurchase(ph, session, "stripe_webhook");
  const cd = session.customer_details || {};
  // GHL en Slack één keer per betaling (de bedankpagina kan al gemeld hebben).
  const first = await claimOnce(s, session);
  await Promise.all([
    // GoHighLevel: contact als betaald markeren (of aanmaken), zodat de juiste opvolging start.
    first ? sendToGhl("payment", ghlPaymentPayload(session, "stripe_webhook")) : null,
    first ? sendSlack(slackPaymentText(session)) : null,
    // Meta: zelfde event_id als bedankt.html en /api/verify-payment -> één aankoop.
    sendMetaEvent({
      eventName: "Purchase",
      eventId: `purchase_${session.id}`,
      user: { email: cd.email || session.customer_email, phone: cd.phone, name: cd.name, externalId: session.client_reference_id || null },
      customData: {
        value: amountOf(session),
        currency: session.currency ? String(session.currency).toUpperCase() : "EUR",
        content_name: contentName(session),
      },
    }),
  ]);
}

async function handle(s, ph, event) {
  const o = event.data.object;
  const base = { stripe_event_id: event.id, source: "stripe_webhook" };

  switch (event.type) {
    case "checkout.session.completed":
      if (o.payment_status === "paid") return onPaidSession(s, ph, o);
      // Bijv. SEPA-incasso: de betaling volgt later via async_payment_succeeded.
      if (ph) ph.capture({ distinctId: o.client_reference_id || o.id, event: "payment_pending", uuid: stableUuid(event.id), properties: Object.assign({ stripe_session_id: o.id, lead_id: o.client_reference_id || null }, base) });
      return;

    case "checkout.session.async_payment_succeeded":
      return onPaidSession(s, ph, o);

    case "checkout.session.async_payment_failed":
      if (ph) ph.capture({ distinctId: o.client_reference_id || o.id, event: "payment_failed", uuid: stableUuid(event.id), properties: Object.assign({ stripe_session_id: o.id, lead_id: o.client_reference_id || null, reason: "async_payment_failed" }, base) });
      return;

    case "invoice.paid": {
      // Eerste factuur van de eigen betaalstap (/api/pay): dit is de aankoop van €49.
      if (o.billing_reason === "subscription_create" && o.amount_paid) {
        const subId = (typeof o.subscription === "string" ? o.subscription : o.subscription && o.subscription.id) ||
          (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
        if (!subId) return;
        const { paid, session } = await nativeSession(s, subId);
        if (paid && session) return onPaidSession(s, ph, session);
        return;
      }
      // Bij Stripe Checkout telt de eerste factuur al via checkout.session.completed.
      if (o.billing_reason !== "subscription_cycle" || !o.amount_paid) return;
      const sub = await subscriptionFor(s, o);
      const afterTrial = !!(sub && sub.trial_end && Math.abs((o.period_start || 0) - sub.trial_end) < 2 * 86400);
      const amount = o.amount_paid / 100;
      if (ph) ph.capture({
        distinctId: distinctFor(sub, o.customer || o.id),
        event: afterTrial ? "trial_converted" : "subscription_renewed",
        uuid: stableUuid(`invoice_${o.id}`),
        properties: Object.assign({ amount, currency: o.currency, stripe_invoice_id: o.id, lead_id: distinctFor(sub, null) }, subProps(sub), base),
      });
      const who = `${o.customer_name || o.customer_email || "klant"}${o.customer_phone ? " (" + localPhone(o.customer_phone) + ")" : ""}`;
      await sendSlack(afterTrial
        ? `:tada: *Doorbetaald na de proef:* ${who} betaalt nu €${amount.toFixed(2).replace(".", ",")} per maand. <https://dashboard.stripe.com/customers/${o.customer}|Stripe>`
        : `:repeat: *Maandbetaling ontvangen:* ${who}, €${amount.toFixed(2).replace(".", ",")}. <https://dashboard.stripe.com/customers/${o.customer}|Stripe>`);
      if (afterTrial) {
        await sendMetaEvent({
          eventName: "Subscribe",
          eventId: `subscribe_${o.id}`,
          user: { email: o.customer_email, phone: o.customer_phone, name: o.customer_name, externalId: distinctFor(sub, null) },
          customData: { value: amount, currency: String(o.currency || "eur").toUpperCase(), content_name: "PromoView Groeisysteem" },
        });
      }
      return;
    }

    case "invoice.payment_failed": {
      const sub = await subscriptionFor(s, o);
      await sendSlack(`:warning: *Betaling mislukt:* ${o.customer_name || o.customer_email || "klant"}${o.customer_phone ? " (" + localPhone(o.customer_phone) + ")" : ""}, €${((o.amount_due || 0) / 100).toFixed(2).replace(".", ",")} (poging ${o.attempt_count || 1}). Even contact opnemen. <https://dashboard.stripe.com/customers/${o.customer}|Stripe>`);
      if (ph) ph.capture({
        distinctId: distinctFor(sub, o.customer || o.id),
        event: "payment_failed",
        uuid: stableUuid(event.id),
        properties: Object.assign({ amount: (o.amount_due || 0) / 100, stripe_invoice_id: o.id, billing_reason: o.billing_reason, attempt: o.attempt_count, reason: "invoice_payment_failed" }, subProps(sub), base),
      });
      return;
    }

    case "customer.subscription.trial_will_end":
      if (ph) ph.capture({ distinctId: distinctFor(o, o.customer), event: "trial_ending", uuid: stableUuid(event.id), properties: Object.assign({ trial_end: o.trial_end ? new Date(o.trial_end * 1000).toISOString() : null }, subProps(o), base) });
      return;

    case "customer.subscription.updated": {
      const prev = (event.data.previous_attributes) || {};
      // Opzegging aangevraagd (stopt aan het eind van de proef of de maand).
      if (o.cancel_at_period_end && prev.cancel_at_period_end === false) {
        const end = o.cancel_at || o.current_period_end || o.trial_end || 0;
        await sendSlack(`:no_entry_sign: *Opzegging aangevraagd*${o.status === "trialing" ? " tijdens de proef" : ""}${end ? `, stopt op ${new Date(end * 1000).toLocaleDateString("nl-NL", { timeZone: "Europe/Amsterdam" })}` : ""}. <https://dashboard.stripe.com/customers/${o.customer}|Stripe>`);
      }
      if (o.cancel_at_period_end && prev.cancel_at_period_end === false && ph) {
        ph.capture({ distinctId: distinctFor(o, o.customer), event: "subscription_cancel_requested", uuid: stableUuid(event.id), properties: Object.assign({ during_trial: o.status === "trialing" }, subProps(o), base) });
      }
      return;
    }

    case "customer.subscription.deleted":
      if (ph) ph.capture({
        distinctId: distinctFor(o, o.customer),
        event: "subscription_cancelled",
        uuid: stableUuid(event.id),
        properties: Object.assign({ during_trial: !!(o.trial_end && o.ended_at && o.ended_at <= o.trial_end + 3600) }, subProps(o), base),
      });
      return;

    default:
      return;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const s = getStripe();
  if (!s || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ ok: false, error: "stripe_not_configured" });
  }

  const rawBody = await readRawBody(req);
  let event;
  try {
    event = s.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ ok: false, error: "invalid_signature" });
  }

  const ph = getPostHog();
  try {
    await handle(s, ph, event);
  } catch (err) {
    // Niet opnieuw laten proberen door Stripe: dat zou GHL/Meta dubbel kunnen raken.
    console.error("[stripe-webhook]", event.type, err && err.message);
  }
  if (ph) await ph.shutdown();
  return res.status(200).json({ received: true, type: event.type });
};

// Na de handler zetten: anders overschrijft `module.exports = ...` deze config.
module.exports.config = { api: { bodyParser: false } };
