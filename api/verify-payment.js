const Stripe = require("stripe");
const { PostHog } = require("posthog-node");
const { sendMetaEvent, clientIp } = require("./_lib/meta");
const { sendSlack } = require("./_lib/slack");
const { boardEvent, paymentCard } = require("./_lib/board");
const { paySession, claimOnceSub, findSubByLead } = require("./_lib/paypro");
const { nativeSession, claimOnce, slackPaymentText, withLinkMetadata, sessionProps, amountOf, capturePurchase, contentName } = require("./_lib/payment");

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
// Beide sturen dezelfde uuid/event_id, dus PostHog en Meta tellen één aankoop.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const sessionId = req.query && req.query.session_id;
  // ?sub=... komt van de eigen betaalstap (/api/pay): abonnement in plaats van Checkout Session.
  const subId = req.query && req.query.sub;
  // PayPro: ?pp=PS... of ?pay=paypro&pv_lead=... (het abonnement wordt dan op lead_id gezocht).
  const ppLead = req.query && req.query.pay === "paypro" ? req.query.pv_lead : null;
  let ppSub = req.query && req.query.pp;
  if (!sessionId && !subId && !ppSub && !ppLead) return res.status(400).json({ ok: false, error: "missing_session_id" });

  const s = getStripe();
  if (!s && !ppSub && !ppLead) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

  let session, ppData = null;
  if (ppSub || ppLead) {
    try {
      if (!ppSub) ppSub = await findSubByLead(String(ppLead));
      ppData = ppSub ? await paySession(String(ppSub)) : null;
    } catch (e) { ppData = null; }
    session = ppData && ppData.session;
    if (!session) return res.status(404).json({ ok: false, error: "session_not_found" });
  } else if (subId) {
    try { session = (await nativeSession(s, subId)).session; } catch (e) { session = null; }
    if (!session) return res.status(404).json({ ok: false, error: "session_not_found" });
  } else {
    try {
      session = await s.checkout.sessions.retrieve(String(sessionId));
    } catch (e) {
      return res.status(404).json({ ok: false, error: "session_not_found" });
    }
    session = await withLinkMetadata(s, session);
  }

  // "paid" bij een losse betaling en bij de €49 + proefperiode van V7.
  const paid = session.payment_status === "paid";
  const props = sessionProps(session);

  if (paid) {
    const ph = getPostHog();
    capturePurchase(ph, session, "verify_payment_client");
    if (ph) await ph.shutdown();

    // Slack #direct-payment en Trello: één keer per betaling (centrale claim, zie _lib/claim.js).
    // Wie eerst is (bedankpagina, PayPro- of Stripe-webhook) meldt.
    if (ppData ? await claimOnceSub(ppData.sub) : await claimOnce(s, session)) {
      await Promise.all([
        sendSlack(slackPaymentText(session)),
        boardEvent(paymentCard(session)),
      ]);
    }

    const cd = session.customer_details || {};
    await sendMetaEvent({
      eventName: "Purchase",
      eventId: `purchase_${session.id}`,
      eventSourceUrl: req.headers.referer || undefined,
      user: {
        email: cd.email || session.customer_email,
        phone: cd.phone,
        name: cd.name,
        externalId: session.client_reference_id || null,
        ip: clientIp(req),
        ua: req.headers["user-agent"],
        fbp: req.query.fbp,
        fbc: req.query.fbc,
      },
      customData: {
        value: amountOf(session),
        currency: session.currency ? String(session.currency).toUpperCase() : "EUR",
        content_name: contentName(session),
      },
    });
  }

  return res.status(200).json({
    ok: true,
    paid,
    amount_total: amountOf(session),
    currency: session.currency,
    lead_id: session.client_reference_id || null,
    plan: props.plan,
    lp_variant: props.lp_variant,
    stripe_session_id: session.id,
    // Voor het vooraf invullen van de onboarding (Typeform) op de bedankpagina.
    email: paid ? ((session.customer_details && session.customer_details.email) || session.customer_email || null) : null,
    name: paid ? ((session.customer_details && session.customer_details.name) || null) : null,
    insta: paid ? props.insta : null,
  });
};
