const Stripe = require("stripe");
const { PostHog } = require("posthog-node");

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
            source: "verify_payment_client",
          },
        });
        await ph.shutdown();
      }
    }

    return res.status(200).json({
      ok: true,
      paid,
      amount_total: session.amount_total ? session.amount_total / 100 : null,
      currency: session.currency,
      lead_id: session.client_reference_id || null,
      email: session.customer_details ? session.customer_details.email : null,
    });
  } catch (e) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }
};
