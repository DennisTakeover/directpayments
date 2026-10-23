// Testendpoint: stuurt een NAGEBOOTSTE betaling door, zonder Stripe.
// Zelfde payload als /api/verify-payment en /api/stripe-webhook, zodat je de
// GoHighLevel-workflow "PV - Betaald" (en optioneel Meta) kunt testen.
//
// Gebruik (in je browser):
//   /api/test-payment?key=<TEST_SECRET>&email=jij@voorbeeld.nl&phone=0612345678&name=Test
// Optioneel Meta-test (komt alleen in Events Manager > Testgebeurtenissen):
//   &test_event_code=TEST12345
//
// Beveiligd met TEST_SECRET (Vercel env). Zonder geldige key: 404.
const { sendToGhl } = require("./_lib/ghl");
const { sendMetaEvent } = require("./_lib/meta");

module.exports = async (req, res) => {
  const q = req.query || {};
  if (!process.env.TEST_SECRET || q.key !== process.env.TEST_SECRET) {
    return res.status(404).json({ ok: false });
  }
  const email = String(q.email || "").trim();
  if (!email) return res.status(400).json({ ok: false, error: "email verplicht (gebruik het e-mailadres van je testlead)" });

  const sessionId = "cs_test_sim_" + Date.now().toString(36);
  const payload = {
    event: "payment_completed",
    payment_status: "betaald",
    lead_id: q.lead_id || null,
    email,
    phone: q.phone || null,
    name: q.name || "Test",
    amount: 190,
    currency: "EUR",
    stripe_session_id: sessionId,
    stripe_customer_id: null,
    paid_at: new Date().toISOString(),
    source: "test_simulatie",
    test: true,
  };

  const ghl = await sendToGhl("payment", payload);
  let meta = { skipped: "geen test_event_code meegegeven" };
  if (q.test_event_code) {
    meta = await sendMetaEvent({
      eventName: "Purchase",
      eventId: `purchase_${sessionId}`,
      user: { email, phone: q.phone, name: q.name, externalId: q.lead_id },
      customData: { value: 190, currency: "EUR", content_name: "PromoView Groeisysteem" },
      testEventCode: String(q.test_event_code),
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: ghl.ok, ghl, meta, verstuurd_naar_ghl: payload });
};
