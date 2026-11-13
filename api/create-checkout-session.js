const Stripe = require("stripe");

// Maakt een Stripe Checkout Session voor de ingebouwde checkout op afrekenen.html
// (ui_mode "embedded"): de klant betaalt op ons eigen domein in plaats van op
// buy.stripe.com. Product en prijs komen uit de bestaande Payment Link, zodat er
// één plek blijft waar de prijs staat.
//
// Nodig in Vercel: STRIPE_SECRET_KEY (bestond al) en STRIPE_PUBLISHABLE_KEY.
// Ontbreekt er iets of weigert Stripe de aanvraag, dan antwoordt dit endpoint met
// ok:false + fallback_url en stuurt afrekenen.html de klant door naar de Payment Link.

const PAYMENT_LINK_URL =
  process.env.STRIPE_PAYMENT_LINK_URL || "https://buy.stripe.com/14A9AVd2t5yQ8OK1uPb7y08";

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

// Product/prijs + instellingen van de Payment Link, één keer per warme functie opgehaald.
let offerCache = null;
async function getOffer(s) {
  if (offerCache && Date.now() - offerCache.at < 10 * 60 * 1000) return offerCache.value;
  let value;
  if (process.env.STRIPE_PRICE_ID) {
    const price = await s.prices.retrieve(process.env.STRIPE_PRICE_ID);
    value = { lineItems: [{ price: price.id, quantity: 1 }], recurring: !!price.recurring, link: null };
  } else {
    let link = null;
    for await (const pl of s.paymentLinks.list({ limit: 100 })) {
      if (pl.url === PAYMENT_LINK_URL) { link = pl; break; }
    }
    if (!link) throw new Error("payment_link_not_found");
    const items = await s.paymentLinks.listLineItems(link.id, { limit: 20 });
    const lineItems = items.data
      .filter((li) => li.price && li.price.id)
      .map((li) => ({ price: li.price.id, quantity: li.quantity || 1 }));
    if (!lineItems.length) throw new Error("payment_link_has_no_prices");
    value = { lineItems, recurring: items.data.some((li) => li.price && li.price.recurring), link };
  }
  offerCache = { at: Date.now(), value };
  return value;
}

const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

function fallbackUrl(leadId, email) {
  const u = new URL(PAYMENT_LINK_URL);
  if (leadId) u.searchParams.set("client_reference_id", leadId);
  if (email) u.searchParams.set("prefilled_email", email);
  return u.toString();
}

// "live" of "test" op basis van het voorvoegsel van een Stripe-key (sk_live_, rk_test_, pk_live_ ...).
function keyMode(key) {
  const m = /^[a-z]+_(live|test)_/.exec(String(key || "").trim());
  return m ? m[1] : null;
}

// GET: laat zien of de ingebouwde betaling klaarstaat, zonder iets aan te maken en
// zonder sleutels te tonen. De startpagina's gebruiken `native` om te kiezen tussen
// /afrekenen en de Payment Link; met ?check=1 wordt ook het product bij Stripe opgezocht.
async function status(req, res) {
  const sk = process.env.STRIPE_SECRET_KEY, pk = process.env.STRIPE_PUBLISHABLE_KEY;
  const out = {
    ok: true,
    secret_key: sk ? keyMode(sk) || "onbekend formaat" : "ontbreekt",
    publishable_key: pk ? (/^pk_/.test(pk.trim()) ? keyMode(pk) || "onbekend formaat" : "geen pk_-sleutel") : "ontbreekt",
  };
  out.keys_match = !!keyMode(sk) && keyMode(sk) === keyMode(pk) && /^pk_/.test(String(pk).trim());
  out.native = out.keys_match;
  if (req.query && req.query.check && sk) {
    try {
      offerCache = null;
      const offer = await getOffer(getStripe());
      out.product = { gevonden: true, soort: offer.recurring ? "abonnement" : "eenmalig", prijzen: offer.lineItems.length };
    } catch (err) {
      out.product = {
        gevonden: false,
        fout: String((err && (err.code || err.type)) || "onbekend"),
        melding: String((err && err.message) || "").replace(/[a-z]+_(live|test)_\w+/g, "<sleutel>").slice(0, 200),
      };
      out.native = false;
    }
  }
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return status(req, res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // client_reference_id mag alleen letters, cijfers, - en _ bevatten.
  const leadId = clean(body.lead_id, 100).replace(/[^A-Za-z0-9_-]/g, "");
  const email = isEmail(clean(body.email, 200)) ? clean(body.email, 200) : "";
  const fail = (status, error) =>
    res.status(status).json({ ok: false, error, fallback_url: fallbackUrl(leadId, email) });

  const s = getStripe();
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!s || !publishableKey) return fail(503, "native_checkout_not_configured");
  // Een live secret key met een test publishable key (of andersom) geeft een leeg
  // betaalformulier: dan liever meteen naar de Payment Link.
  if (!/^pk_/.test(publishableKey.trim()) || keyMode(process.env.STRIPE_SECRET_KEY) !== keyMode(publishableKey)) {
    return fail(503, "stripe_keys_mismatch");
  }

  try {
    const offer = await getOffer(s);
    const mode = offer.recurring ? "subscription" : "payment";

    // Komt terug op de sessie (en via de webhook), zodat een betaling aan de
    // lead, de landingspagina-variant en de advertentie te koppelen is.
    const metadata = {};
    const meta = {
      lead_id: leadId,
      lp_variant: body.lp_variant,
      page_version: body.page_version,
      niche: body.niche,
      insta: body.insta,
      utm_source: body.utm_source,
      utm_campaign: body.utm_campaign,
      utm_content: body.utm_content,
      ad_id: body.ad_id,
      adset_id: body.adset_id,
      campaign_id: body.campaign_id,
      checkout: "native",
    };
    Object.keys(meta).forEach((k) => { const v = clean(meta[k], 200); if (v) metadata[k] = v; });

    const minimal = {
      ui_mode: "embedded",
      mode,
      line_items: offer.lineItems,
      return_url: `${baseUrl(req)}/bedankt.html?session_id={CHECKOUT_SESSION_ID}`,
      locale: "nl",
      metadata,
    };
    if (leadId) minimal.client_reference_id = leadId;
    if (email) minimal.customer_email = email;

    // Zelfde instellingen als de Payment Link, plus telefoonnummer verplicht:
    // dat ontbrak tot nu toe bij directe kopers.
    const full = Object.assign({}, minimal, { phone_number_collection: { enabled: true } });
    const link = offer.link;
    if (link) {
      if (link.allow_promotion_codes) full.allow_promotion_codes = true;
      if (link.billing_address_collection) full.billing_address_collection = link.billing_address_collection;
      if (link.automatic_tax && link.automatic_tax.enabled) full.automatic_tax = { enabled: true };
      if (link.tax_id_collection && link.tax_id_collection.enabled) full.tax_id_collection = { enabled: true };
      if (mode === "subscription" && link.subscription_data && link.subscription_data.trial_period_days) {
        full.subscription_data = { trial_period_days: link.subscription_data.trial_period_days };
      }
    }
    if (mode === "subscription") {
      full.subscription_data = Object.assign({}, full.subscription_data, { metadata });
    }

    let session;
    try {
      session = await s.checkout.sessions.create(full);
    } catch (err) {
      // Een overgenomen instelling die Stripe in deze combinatie niet accepteert
      // mag de betaling niet blokkeren: probeer het met alleen het noodzakelijke.
      if (!err || err.type !== "StripeInvalidRequestError") throw err;
      console.error("[create-checkout-session] volledige aanvraag geweigerd:", err.message);
      session = await s.checkout.sessions.create(minimal);
    }

    return res.status(200).json({
      ok: true,
      client_secret: session.client_secret,
      publishable_key: publishableKey.trim(),
      session_id: session.id,
      mode,
    });
  } catch (err) {
    console.error("[create-checkout-session]", err && err.message);
    return fail(502, "stripe_error");
  }
};
