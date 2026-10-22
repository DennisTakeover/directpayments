const { PostHog } = require("posthog-node");
const { sendToGhl } = require("./_lib/ghl");
const { sendMetaEvent, clientIp, normPhone } = require("./_lib/meta");

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

// Ontvangt een lead van de landingspagina (quiz + contactformulier), stuurt
// hem server-side door naar GoHighLevel en bevestigt pas dan `lead_submitted`
// in PostHog. Een klik op "Versturen" in de browser is nog geen opgeslagen lead -
// dat gebeurt pas als dit endpoint 200 teruggeeft.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const lead = {
    lead_id: String(body.lead_id || "").trim(),
    name: String(body.name || "").trim(),
    email: String(body.email || "").trim(),
    phone: String(body.phone || "").trim(),
    insta: String(body.insta || "").trim(),
    niche: body.niche || null,
    followers: body.followers || null,
    lead_type: body.lead_type || "pakket_check",
    recommended_package: body.recommended_package || null,
    quiz_preset: body.quiz_preset || null,
    source: body.source || null,
    utm_source: body.utm_source || null,
    utm_medium: body.utm_medium || null,
    utm_campaign: body.utm_campaign || null,
    page_version: body.page_version || null,
    created: body.created || new Date().toISOString(),
  };

  if (!lead.lead_id || !lead.name || !lead.phone) {
    return res.status(400).json({ ok: false, error: "missing_required_fields" });
  }

  // Naar GoHighLevel: event "lead" + status "niet_betaald". De GHL-workflow
  // start hiermee de opvolging; /api/stripe-webhook stuurt later
  // "payment_completed" voor wie wel betaalt.
  const [crm, meta] = await Promise.all([
    sendToGhl("lead", Object.assign({ event: "lead", payment_status: "niet_betaald", phone_e164: normPhone(lead.phone) ? "+" + normPhone(lead.phone) : null }, lead)),
    // Meta Conversions API: zelfde event_id als de browser-pixel (lead_<id>) voor deduplicatie.
    sendMetaEvent({
      eventName: "Lead",
      eventId: `lead_${lead.lead_id}`,
      eventSourceUrl: body.event_source_url || lead.source || undefined,
      user: {
        email: lead.email,
        phone: lead.phone,
        name: lead.name,
        externalId: lead.lead_id,
        ip: clientIp(req),
        ua: req.headers["user-agent"],
        fbp: body.fbp,
        fbc: body.fbc,
      },
      customData: { value: 190, currency: "EUR", content_name: "PromoView Groeisysteem", lead_type: lead.lead_type },
    }),
  ]);
  const crmOk = crm.ok;
  const crmError = crm.ok ? null : crm.error;

  const ph = getPostHog();
  if (ph) {
    ph.capture({
      distinctId: lead.lead_id,
      event: "lead_submitted",
      properties: {
        $set: { name: lead.name, phone: lead.phone, email: lead.email, insta: lead.insta },
        niche: lead.niche,
        followers: lead.followers,
        recommended_package: lead.recommended_package,
        utm_source: lead.utm_source,
        utm_medium: lead.utm_medium,
        utm_campaign: lead.utm_campaign,
        page_version: lead.page_version,
        crm_synced: crmOk,
        meta_capi_sent: !!meta.ok,
      },
    });
    await ph.shutdown();
  }

  if (!crmOk) {
    // De lead is wel geregistreerd in PostHog (met crm_synced:false) zodat we
    // een mislukte CRM-sync kunnen zien, maar we melden dit als fout aan de
    // bezoeker zodat diegene het weet i.p.v. te denken dat we hem bellen.
    return res.status(502).json({ ok: false, error: crmError });
  }

  return res.status(200).json({ ok: true, lead_id: lead.lead_id });
};
