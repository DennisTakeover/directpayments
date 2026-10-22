// GoHighLevel inbound webhooks.
// - Leads           -> GHL_WEBHOOK_URL         (workflow "PV - Nieuwe lead")
// - Betalingen      -> GHL_PAYMENT_WEBHOOK_URL (workflow "PV - Betaald")
// Bewust geen terugval van betalingen naar de lead-URL: dan zou een betaalde
// klant in de lead-workflow belanden en alsnog een beltaak krijgen.
async function sendToGhl(kind, payload) {
  const url = kind === "payment" ? process.env.GHL_PAYMENT_WEBHOOK_URL : process.env.GHL_WEBHOOK_URL;
  if (!url) return { ok: false, error: "ghl_webhook_url_not_configured" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return r.ok ? { ok: true } : { ok: false, error: `ghl_status_${r.status}` };
  } catch (e) {
    return { ok: false, error: "ghl_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendToGhl };
