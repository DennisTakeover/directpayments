const { PostHog } = require("posthog-node");

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

const STATUS_TO_EVENT = {
  contacted: "lead_contacted",
  qualified: "lead_qualified",
  not_qualified: "lead_qualified", // properties.qualified:false onderscheidt dit
  won: "sale_closed",
  lost: "sale_closed", // properties.won:false + reden
};

// Ontvangt updates VANUIT GoHighLevel (een workflow-actie die dit endpoint
// aanroept als sales een status zet: gebeld, gekwalificeerd, gewonnen/verloren).
// Verwacht JSON: { lead_id, status: "contacted"|"qualified"|"not_qualified"|"won"|"lost", reason?, value? }
// Beveiligd met een gedeeld geheim (header x-ghl-secret) - stel dit in de
// GoHighLevel-workflow in en in de GHL_SHARED_SECRET env var op Vercel.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  if (process.env.GHL_SHARED_SECRET) {
    const provided = req.headers["x-ghl-secret"];
    if (provided !== process.env.GHL_SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const leadId = String(body.lead_id || "").trim();
  const status = String(body.status || "").trim();
  const event = STATUS_TO_EVENT[status];

  if (!leadId || !event) {
    return res.status(400).json({ ok: false, error: "missing_or_unknown_lead_id_or_status" });
  }

  const ph = getPostHog();
  if (ph) {
    ph.capture({
      distinctId: leadId,
      event,
      properties: {
        lead_id: leadId,
        status,
        qualified: status === "qualified" ? true : status === "not_qualified" ? false : undefined,
        won: status === "won" ? true : status === "lost" ? false : undefined,
        reason: body.reason || null,
        value: body.value || null,
        source: "gohighlevel",
      },
    });
    await ph.shutdown();
  }

  return res.status(200).json({ ok: true });
};
