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

// Vercel parseert de body normaliter als JSON; voor Stripe-signature-verificatie
// hebben we de RAW body nodig, dus body-parsing staat hier uit.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// De bron van waarheid voor `purchase_completed` / `payment_failed`: Stripe
// roept dit endpoint server-naar-server aan, dus het werkt ook als de klant
// na betalen het tabblad sluit voordat bedankt.html laadt.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const s = getStripe();
  if (!s || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ ok: false, error: "stripe_not_configured" });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];

  let event;
  try {
    event = s.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ ok: false, error: "invalid_signature" });
  }

  const ph = getPostHog();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const leadId = session.client_reference_id || null;
    if (session.payment_status === "paid" && ph) {
      ph.capture({
        distinctId: leadId || session.id,
        event: "purchase_completed",
        uuid: `stripe_${session.id}`, // dedupe met /api/verify-payment
        properties: {
          amount_total: session.amount_total ? session.amount_total / 100 : null,
          currency: session.currency,
          lead_id: leadId,
          source: "stripe_webhook",
        },
      });
    }
  }

  if (event.type === "checkout.session.async_payment_failed") {
    const session = event.data.object;
    if (ph) {
      ph.capture({
        distinctId: session.client_reference_id || session.id,
        event: "payment_failed",
        properties: {
          lead_id: session.client_reference_id || null,
          reason: "async_payment_failed",
        },
      });
    }
  }

  if (ph) await ph.shutdown();
  return res.status(200).json({ received: true });
};
