const { pp, PayProError, OFFER } = require("./_lib/paypro");

// Eigen betaalstap op v7 via PayPro.
//
//   POST /api/pay-paypro  { name, email, phone, insta, country, method, lead_id, quiz/utm-velden }
//     1. klant aanmaken in PayPro
//     2. abonnement aanmaken: eerste periode 14 dagen €59,29 (€49 + btw), daarna elke maand
//        €229,90 (€190 + btw), ingaand op de dag dat de proef afloopt
//     3. de link teruggeven naar de gekozen betaalmethode (iDEAL opent de bank-app).
//        Die eerste betaling zet ook de machtiging voor de maandelijkse incasso.
//   Na betalen komt de klant op bedankt.html?pv_lead=...&pay=paypro; /api/verify-payment
//   zoekt het abonnement op en meldt de aankoop. /api/paypro-webhook doet hetzelfde
//   server-naar-server (ook als de klant de pagina sluit).

const METHODS = ["ideal", "bancontact"];
const COUNTRIES = ["NL", "BE"];
const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

function normPhone(v, country) {
  let d = String(v || "").replace(/[\s().-]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^0[1-9]\d{8}$/.test(d)) d = (country === "BE" ? "+32" : "+31") + d.slice(1);
  if (/^0[1-9]\d{7}$/.test(d) && country === "BE") d = "+32" + d.slice(1);
  return /^\+\d{8,15}$/.test(d) ? d : null;
}
function normInsta(v) {
  let u = String(v || "").trim();
  const m = u.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) u = m[1];
  u = u.replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}
function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
}

function metadataFor(b, d) {
  const m = {
    pv: "1",
    plan: "doorlopend",
    test: "49_14_dagen",
    lead_id: clean(b.lead_id, 100).replace(/[^A-Za-z0-9_-]/g, ""),
    insta: d.insta,
    land: d.country,
    niche: b.niche,
    doel: b.doel,
    account_ouder_dan_3_maanden: b.leeftijd,
    bron_knop: b.source,
    lp_variant: b.lp_variant || "v7",
    page_version: b.page_version,
    utm_source: b.utm_source,
    utm_campaign: b.utm_campaign,
    utm_content: b.utm_content,
    ad_id: b.ad_id,
    adset_id: b.adset_id,
    campaign_id: b.campaign_id,
  };
  const out = {};
  Object.keys(m).forEach((k) => { const v = clean(m[k], 200); if (v) out[k] = v; });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    return res.status(200).json({ ok: !!process.env.PAYPRO_API_KEY, methods: METHODS, amount: OFFER.first.amount, monthly: OFFER.period.amount });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const b = readBody(req);
  const country = COUNTRIES.includes(clean(b.country, 2).toUpperCase()) ? clean(b.country, 2).toUpperCase() : "NL";
  const name = clean(b.name, 100).replace(/\s+/g, " ");
  const d = {
    email: clean(b.email, 200).toLowerCase(),
    phone: normPhone(b.phone, country),
    insta: normInsta(b.insta),
    country,
    method: METHODS.includes(b.method) ? b.method : country === "BE" ? "bancontact" : "ideal",
  };
  if (name.length < 2) return res.status(400).json({ ok: false, error: "invalid_name" });
  if (!isEmail(d.email)) return res.status(400).json({ ok: false, error: "invalid_email" });
  if (!d.phone) return res.status(400).json({ ok: false, error: "invalid_phone" });
  if (!d.insta) return res.status(400).json({ ok: false, error: "invalid_insta" });

  const parts = name.split(" ");
  const first = parts.shift();
  const last = parts.join(" ");
  const base = baseUrl(req);
  const metadata = metadataFor(b, d);
  const leadQ = metadata.lead_id ? `pv_lead=${encodeURIComponent(metadata.lead_id)}&` : "";

  try {
    const customer = await pp("POST", "/customers", {
      email: d.email,
      first_name: first,
      last_name: last || undefined,
      phone_number: d.phone,
      country: d.country,
      company_name: clean(b.company, 100) || undefined,
    });
    const sub = await pp("POST", "/subscriptions", {
      customer: customer.id,
      description: OFFER.description,
      currency: "EUR",
      pay_methods: [d.method],
      first_period: OFFER.first,
      period: OFFER.period,
      // Niet betaald binnen 2 dagen? Dan vervalt de betaallink; er wordt nooit iets afgeschreven.
      expire_at: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
      payment_details: {
        return_url: `${base}/bedankt.html?${leadQ}pay=paypro&plan=doorlopend`,
        cancel_url: `${base}/v7.html?checkout=geannuleerd`,
      },
      metadata,
    });
    const checkout = sub && sub._links && sub._links.checkout;
    if (!checkout) {
      console.error("[pay-paypro] geen checkout-link", sub && sub.id, sub && sub.state);
      return res.status(502).json({ ok: false, error: "no_checkout" });
    }
    return res.status(200).json({ ok: true, subscription_id: sub.id, checkout_url: checkout, method: d.method });
  } catch (err) {
    const e = err instanceof PayProError ? err : { message: String(err && err.message), status: 0 };
    console.error("[pay-paypro]", e.status, e.param, e.message);
    const field = { email: "invalid_email", phone_number: "invalid_phone" }[e.param];
    return res.status(field ? 400 : 502).json({ ok: false, error: field || "paypro_error", param: e.param || null });
  }
};
