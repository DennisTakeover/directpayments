const crypto = require("crypto");
const { PostHog } = require("posthog-node");
const { pp, OFFER, claimOnceSub } = require("./_lib/paypro");
const { stableUuid } = require("./_lib/payment");

// POST /api/board-status   (alleen voor Make, header x-pv-secret = PROFIELCHECK_SECRET)
// Body: { status: "doorbetaald", card_id, card_name, desc }
//
// Make-scenario "PromoView – Trello Doorbetaald naar PostHog" roept dit aan zodra iemand in
// het bord "PromoView – €49 testklanten" een kaart naar "✅ Doorbetaald" sleept. We sturen dan
// trial_converted naar PostHog, op dezelfde persoon als het bezoek en de betaling (lead-id uit
// het PayPro-abonnement; de kaart heeft "Ref: PS..." in de beschrijving).
// Eén keer per klant: de stempel pv_trial_ph op het abonnement wordt ook door de
// PayPro-webhook gezet, dus slepen + automatische betaling tellen samen als één conversie.

let posthog = null;
function getPostHog() {
  if (!process.env.POSTHOG_KEY) return null;
  if (!posthog) posthog = new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" });
  return posthog;
}

function secretOk(given) {
  const want = process.env.PROFIELCHECK_SECRET || "";
  if (want.length < 24 || !given) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
}

const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!secretOk(req.headers["x-pv-secret"])) return res.status(403).json({ ok: false, error: "geen_toegang" });

  const b = readBody(req);
  const status = clean(b.status, 30);
  if (status !== "doorbetaald") return res.status(400).json({ ok: false, error: "onbekende_status" });
  const cardId = clean(b.card_id, 40);
  // Testkaarten (naam met "TEST") tellen nooit mee.
  if (/\bTEST\b/.test(String(b.card_name || ""))) return res.status(200).json({ ok: true, skipped: "testkaart" });
  const ref = (String(b.desc || "").match(/Ref:\s*\**\s*([A-Za-z0-9_]+)/) || [])[1] || "";

  let sub = null, md = {};
  if (/^PS[A-Z0-9]+$/.test(ref)) {
    try { sub = await pp("GET", "/subscriptions/" + encodeURIComponent(ref)); md = sub.metadata || {}; } catch (_) { sub = null; }
  }
  // Al geteld (door de webhook bij de eerste maandbetaling, of eerder slepen)? Dan niets doen.
  if (sub && !(await claimOnceSub(sub, "pv_trial_ph"))) return res.status(200).json({ ok: true, skipped: "al_geteld", ref });

  const key = (sub && sub.id) || ref || "trello_" + cardId;
  const props = {
    amount: OFFER.period.amount / 100,
    currency: "EUR",
    source: "trello",
    trello_card_id: cardId || null,
    trello_card: clean(b.card_name, 120) || null,
    lead_id: md.lead_id || null,
    paypro_subscription_id: sub ? sub.id : null,
    provider: sub ? "paypro" : null,
    plan: md.plan || null,
    lp_variant: md.lp_variant || null,
    omgeving: process.env.VERCEL_ENV === "production" ? "live" : "test",
  };
  ["page_version", "niche", "doel", "utm_source", "utm_campaign", "utm_content", "ad_id", "adset_id", "campaign_id"].forEach((k) => { if (md[k]) props[k] = md[k]; });

  const ph = getPostHog();
  if (ph) {
    ph.capture({ distinctId: md.lead_id || key, event: "trial_converted", uuid: stableUuid(`trial_converted_${key}`), properties: props });
    await ph.shutdown();
  }
  return res.status(200).json({ ok: true, counted: true, ref: ref || null, lead: !!md.lead_id });
};
