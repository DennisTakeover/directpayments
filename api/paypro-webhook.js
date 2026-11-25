const { PostHog } = require("posthog-node");
const { sendToGhl } = require("./_lib/ghl");
const { sendMetaEvent } = require("./_lib/meta");
const { sendSlack } = require("./_lib/slack");
const { boardEvent, paymentCard, euro, nlDate } = require("./_lib/board");
const { stableUuid, capturePurchase, ghlPaymentPayload, slackPaymentText, contentName, amountOf } = require("./_lib/payment");
const { pp, OFFER, verifySignature, webhookSecret, paySession, claimOnceSub } = require("./_lib/paypro");

// PayPro stuurt hier events heen (webhook "PromoView landing" in PayPro, aangemaakt via
// /api/paypro-setup). Alleen abonnementen uit de eigen betaalstap (metadata.pv = "1") tellen.
//
//   subscription.started  eerste betaling (€49) binnen -> aankoop: PostHog, GHL, Slack, Meta, Trello
//   payment.paid          betaling op dag 14 en daarna maandelijks -> doorbetaald / maandbetaling
//   payment.failed        incasso mislukt -> Slack + rood label op de kaart
//   subscription.canceled abonnement gestopt -> kaart naar "Gestopt"
//   subscription.paused   gepauzeerd -> Slack + opmerking
//   chargeback.created    storno -> Slack
//
// Handtekening: HMAC-SHA256 over "<PayPro-Timestamp>.<ruwe body>" met het secret van de webhook.

let posthog = null;
function getPostHog() {
  if (!process.env.POSTHOG_KEY) return null;
  if (!posthog) posthog = new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" });
  return posthog;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function subProps(sub) {
  const md = (sub && sub.metadata) || {};
  const props = { paypro_subscription_id: sub ? sub.id : null, plan: md.plan || null, lp_variant: md.lp_variant || null, provider: "paypro" };
  ["page_version", "niche", "doel", "utm_source", "utm_campaign", "utm_content", "ad_id", "adset_id", "campaign_id"].forEach((k) => { if (md[k]) props[k] = md[k]; });
  return props;
}

async function getSub(id) {
  try { return id ? await pp("GET", "/subscriptions/" + encodeURIComponent(id)) : null; } catch (_) { return null; }
}

// Klantgegevens voor Meta: e-mail, telefoon, naam (gehasht in meta.js), lead-id en de
// browser-id's/IP/UA die de betaalstap in de metadata bewaarde.
function metaUser(session) {
  const cd = session.customer_details || {};
  const md = session.metadata || {};
  return { email: cd.email, phone: cd.phone, name: cd.name, externalId: session.client_reference_id || null, fbp: md.fbp, fbc: md.fbc, ip: md.ip, ua: md.ua };
}

// De eerste betaling: precies dezelfde meldingen als bij Stripe (en als de bedankpagina).
async function onStarted(ph, subId) {
  const { sub, paid, session } = await paySession(subId);
  if (!session || !paid) return;
  capturePurchase(ph, session, "paypro_webhook");
  const first = await claimOnceSub(sub);
  await Promise.all([
    first ? sendToGhl("payment", ghlPaymentPayload(session, "paypro_webhook")) : null,
    first ? sendSlack(slackPaymentText(session)) : null,
    first ? boardEvent(paymentCard(session)) : null,
    sendMetaEvent({
      eventName: "Purchase",
      eventId: `purchase_${session.id}`,
      eventSourceUrl: "https://landing.promo-view.io/",
      user: metaUser(session),
      customData: { value: amountOf(session), currency: "EUR", content_name: contentName(session) },
    }),
  ]);
}

async function handle(ph, event) {
  const o = event.payload || {};
  const base = { paypro_event_id: event.id, source: "paypro_webhook", omgeving: process.env.VERCEL_ENV === "production" ? "live" : "test" };

  switch (event.event_type) {
    case "subscription.started":
      if (o.metadata && o.metadata.pv === "1") return onStarted(ph, o.id);
      return;

    case "payment.paid": {
      if (!o.subscription) return;
      const sub = await getSub(o.subscription);
      if (!sub || !sub.metadata || sub.metadata.pv !== "1") return;
      // De eerste betaling (€49) loopt via subscription.started; mist die, dan vangt dit hem op.
      if (o.amount === OFFER.first.amount && !sub.metadata.pv_doorbetaald) return onStarted(ph, sub.id);
      const md = sub.metadata;
      const who = `${md.insta ? "@" + md.insta : "klant"}`;
      const amount = (o.amount || 0) / 100;
      const firstAfterTrial = await claimOnceSub(sub, "pv_doorbetaald");
      // trial_converted telt één keer per klant: ook het slepen naar "Doorbetaald" in Trello
      // meldt dit (api/board-status.js). Wie eerst is zet de stempel pv_trial_ph.
      const countTrial = firstAfterTrial && await claimOnceSub(sub, "pv_trial_ph");
      if (ph && (!firstAfterTrial || countTrial)) ph.capture({
        distinctId: md.lead_id || sub.customer,
        event: firstAfterTrial ? "trial_converted" : "subscription_renewed",
        uuid: stableUuid(firstAfterTrial ? `trial_converted_${sub.id}` : `paypro_payment_${o.id}`),
        properties: Object.assign({ amount, currency: "EUR", paypro_payment_id: o.id, lead_id: md.lead_id || null }, subProps(sub), base),
      });
      await Promise.all([
        sendSlack(firstAfterTrial
          ? `:tada: *Doorbetaald na de proef:* ${who} betaalt nu ${euro(amount)} per maand (incl. btw). <https://app.paypro.nl/subscriptions/${sub.id}|PayPro>`
          : `:repeat: *Maandbetaling ontvangen:* ${who}, ${euro(amount)}. <https://app.paypro.nl/subscriptions/${sub.id}|PayPro>`),
        boardEvent(firstAfterTrial
          ? { event: "doorbetaald", key: sub.id, list: "door", comment: `✅ Doorbetaald na de proef: ${euro(amount)} per maand (incl. btw).` }
          : { event: "maandbetaling", key: sub.id, comment: `🔁 Maandbetaling ontvangen: ${euro(amount)}.` }),
        firstAfterTrial ? paySession(sub.id).then(({ session }) => sendMetaEvent({
          eventName: "Subscribe",
          eventId: `subscribe_${o.id}`,
          eventSourceUrl: "https://landing.promo-view.io/",
          user: session ? metaUser(session) : { externalId: md.lead_id || null },
          customData: { value: amount, currency: "EUR", content_name: "PromoView Groeisysteem" },
        })) : null,
      ]);
      return;
    }

    case "payment.failed": {
      if (!o.subscription) return;
      const sub = await getSub(o.subscription);
      if (!sub || !sub.metadata || sub.metadata.pv !== "1") return;
      const md = sub.metadata;
      const amount = (o.amount || 0) / 100;
      if (ph) ph.capture({ distinctId: md.lead_id || sub.customer, event: "payment_failed", uuid: stableUuid(event.id), properties: Object.assign({ amount, reason: "paypro_payment_failed" }, subProps(sub), base) });
      await Promise.all([
        sendSlack(`:warning: *Incasso mislukt:* ${md.insta ? "@" + md.insta : "klant"}, ${euro(amount)}. Even contact opnemen. <https://app.paypro.nl/subscriptions/${sub.id}|PayPro>`),
        boardEvent({ event: "betaling_mislukt", key: sub.id, label: "mislukt", comment: `⚠️ Incasso van ${euro(amount)} mislukt. Neem contact op met de klant.` }),
      ]);
      return;
    }

    case "subscription.canceled": {
      const md = o.metadata || {};
      if (md.pv !== "1") return;
      const trialEnd = new Date(new Date(o.start_at || o.created_at).getTime() + 14 * 86400 * 1000);
      const duringTrial = Date.now() < trialEnd.getTime();
      if (ph) ph.capture({ distinctId: md.lead_id || o.customer, event: "subscription_cancelled", uuid: stableUuid(event.id), properties: Object.assign({ during_trial: duringTrial }, subProps(o), base) });
      await Promise.all([
        sendSlack(`:no_entry_sign: *Abonnement gestopt*${duringTrial ? " tijdens de proef" : ""}: ${md.insta ? "@" + md.insta : "klant"}. <https://app.paypro.nl/subscriptions/${o.id}|PayPro>`),
        boardEvent({ event: "gestopt", key: o.id, list: "gestopt", comment: `❌ Abonnement gestopt${duringTrial ? ` tijdens de proef (proef liep tot ${nlDate(trialEnd)})` : ""}.` }),
      ]);
      return;
    }

    case "subscription.paused": {
      const md = o.metadata || {};
      if (md.pv !== "1") return;
      await Promise.all([
        sendSlack(`:double_vertical_bar: *Abonnement gepauzeerd:* ${md.insta ? "@" + md.insta : "klant"}. <https://app.paypro.nl/subscriptions/${o.id}|PayPro>`),
        boardEvent({ event: "gepauzeerd", key: o.id, label: "opzeg", comment: "⏸️ Abonnement gepauzeerd in PayPro." }),
      ]);
      return;
    }

    case "chargeback.created": {
      const pay = o.payment ? await pp("GET", "/payments/" + encodeURIComponent(o.payment)).catch(() => null) : null;
      const sub = pay && pay.subscription ? await getSub(pay.subscription) : null;
      if (!sub || !sub.metadata || sub.metadata.pv !== "1") return;
      await Promise.all([
        sendSlack(`:rotating_light: *Storno:* ${sub.metadata.insta ? "@" + sub.metadata.insta : "klant"} heeft ${euro((pay.amount || 0) / 100)} teruggeboekt. <https://app.paypro.nl/subscriptions/${sub.id}|PayPro>`),
        boardEvent({ event: "storno", key: sub.id, label: "mislukt", comment: `🚨 Storno: ${euro((pay.amount || 0) / 100)} teruggeboekt.` }),
      ]);
      return;
    }

    default:
      return;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const raw = await readRawBody(req);
  let secret = null;
  try { secret = await webhookSecret(); } catch (_) {}
  if (!secret) return res.status(500).json({ ok: false, error: "webhook_secret_missing" });
  if (!verifySignature(raw, req.headers["paypro-signature"], req.headers["paypro-timestamp"], secret)) {
    return res.status(400).json({ ok: false, error: "invalid_signature" });
  }
  let event;
  try { event = JSON.parse(raw); } catch (_) { return res.status(400).json({ ok: false, error: "invalid_json" }); }

  const ph = getPostHog();
  try {
    await handle(ph, event);
  } catch (err) {
    // Niet laten herhalen door PayPro: dat kan meldingen dubbel sturen.
    console.error("[paypro-webhook]", event && event.event_type, err && err.message);
  }
  if (ph) await ph.shutdown();
  return res.status(200).json({ received: true, type: event.event_type });
};

module.exports.config = { api: { bodyParser: false } };
