// GoHighLevel inbound webhook. Leads gaan naar GHL_WEBHOOK_URL.
// Betalingen gaan naar GHL_PAYMENT_WEBHOOK_URL als die bestaat (aparte
// workflow "Betaald"), anders naar dezelfde GHL_WEBHOOK_URL met
// event: "payment_completed", zodat één workflow op het veld kan filteren.
async function sendToGhl(kind, payload) {
  const url =
    kind === "payment"
      ? process.env.GHL_PAYMENT_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL
      : process.env.GHL_WEBHOOK_URL;
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
