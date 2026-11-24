// Slack-melding in #direct-payment, via een Make.com-webhook (scenario
// "PromoView – betaling naar Slack" zet {{1.text}} in het kanaal).
// Nodig in Vercel: SLACK_WEBHOOK_URL (de Make-webhook-URL; een Slack
// Incoming Webhook werkt ook). Ontbreekt die, dan slaat dit stil over.
// Kanaal voor onboarding en koppeling (betalingen blijven in #direct-payment).
const ONBOARDING_CHANNEL = process.env.SLACK_ONBOARDING_CHANNEL || "#directpayments-onboarding";

async function sendSlack(text, channel) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: "slack_not_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ text, unfurl_links: false, unfurl_media: false }, channel ? { channel } : {})),
      signal: ctrl.signal,
    });
    return r.ok ? { ok: true } : { ok: false, error: `slack_status_${r.status}` };
  } catch (e) {
    return { ok: false, error: "slack_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendSlack, ONBOARDING_CHANNEL };
