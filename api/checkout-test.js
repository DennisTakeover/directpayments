const Stripe = require("stripe");

// Maakt een Stripe Checkout (betaalpagina op checkout.stripe.com) voor de test
// "PromoView 14 dagen testen voor €49" op v7.html en v8.html.
//
//   plan "doorlopend" (V7): €49 nu, 14 dagen proefperiode, daarna automatisch
//                           €190 per maand tot de klant opzegt.
//   plan "eenmalig"   (V8): €49 eenmalig, geen abonnement. Na 14 dagen belt het
//                           team en kiest de klant zelf of hij doorgaat.
//
// Er is geen leadformulier vooraf: telefoonnummer en Instagram-naam vraagt Stripe
// op de betaalpagina. De antwoorden van de check (branche, accountleeftijd, doel)
// gaan mee als metadata.
//
// Het maandbedrag en de instellingen (btw, adres, btw-nummer, kortingscodes)
// komen van de bestaande €190-Payment Link, zodat de test op hetzelfde product
// en dezelfde belastinginstellingen draait als de gewone verkoop.
//
// Nodig in Vercel: STRIPE_SECRET_KEY met schrijfrechten op Checkout Sessions
// (en leesrechten op Payment Links en Prices).
//
// GET ?check=1 maakt van beide varianten een proef-sessie, leest het bedrag en
// laat hem direct verlopen. Alleen op previews, of met header x-test-secret.

const { TEST_CENTS, TEST_PRICE_KEY, MONTH_CENTS, TRIAL_DAYS, TEST_NAME, TEST_DESC, getLinkSettings, findOrCreatePrice, resetCache } = require("./_lib/offer");

const PLANS = {
  doorlopend: {
    page: "/v7.html",
    message: "Je betaalt nu €49 voor 14 dagen. Daarna loopt het door voor €190 per maand, tenzij je vóór dag 14 opzegt. Daarna is het elke maand opzegbaar.",
  },
  eenmalig: {
    page: "/v8.html",
    message: "Je betaalt eenmalig €49 voor 14 dagen. Dit is geen abonnement: na 14 dagen stopt je test vanzelf.",
  },
};

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}


const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

function buildParams(plan, body, base, settings, minimal) {
  const { link, monthly } = settings;
  const tax = !!(link && link.automatic_tax && link.automatic_tax.enabled);
  const leadId = clean(body.lead_id, 100).replace(/[^A-Za-z0-9_-]/g, "");
  const email = isEmail(clean(body.email, 200)) ? clean(body.email, 200) : "";

  // Komt terug op de sessie (en via de bedankpagina in PostHog en GoHighLevel).
  const metadata = {};
  const meta = {
    plan,
    test: "49_14_dagen",
    lead_id: leadId,
    name: body.name,
    phone: body.phone,
    insta: body.insta,
    niche: body.niche,
    doel: body.doel,
    account_ouder_dan_3_maanden: body.leeftijd,
    bron_knop: body.source,
    lp_variant: body.lp_variant,
    page_version: body.page_version,
    utm_source: body.utm_source,
    utm_campaign: body.utm_campaign,
    utm_content: body.utm_content,
    ad_id: body.ad_id,
    adset_id: body.adset_id,
    campaign_id: body.campaign_id,
  };
  Object.keys(meta).forEach((k) => { const v = clean(meta[k], 200); if (v) metadata[k] = v; });

  const testItem = {
    price_data: Object.assign(
      { currency: "eur", unit_amount: TEST_CENTS, product_data: { name: TEST_NAME, description: TEST_DESC } },
      tax ? { tax_behavior: "inclusive" } : {}
    ),
    quantity: 1,
  };

  const p = {
    line_items: [testItem],
    success_url: `${base}/bedankt.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
    cancel_url: `${base}${PLANS[plan].page}?checkout=geannuleerd`,
    locale: "nl",
    metadata,
    // Zonder leadformulier is dit de enige plek waar we nummer en account krijgen.
    phone_number_collection: { enabled: true },
    custom_fields: [
      {
        key: "instagram",
        label: { type: "custom", custom: "Instagram-gebruikersnaam" },
        type: "text",
        text: { minimum_length: 2, maximum_length: 40 },
      },
    ],
  };
  if (leadId) p.client_reference_id = leadId;
  if (email) p.customer_email = email;

  if (plan === "doorlopend") {
    p.mode = "subscription";
    // De bestaande maandprijs van €190; ontbreekt die, dan een nieuwe op hetzelfde bedrag.
    const month = monthly
      ? { price: monthly.id, quantity: 1 }
      : {
          price_data: Object.assign(
            { currency: "eur", unit_amount: MONTH_CENTS, recurring: { interval: "month" }, product_data: { name: "PromoView Groeisysteem" } },
            tax ? { tax_behavior: "exclusive" } : {}
          ),
          quantity: 1,
        };
    p.line_items = [month, testItem];
    p.subscription_data = { trial_period_days: TRIAL_DAYS, metadata };
  } else {
    p.mode = "payment";
    p.customer_creation = "always";
    p.payment_intent_data = { description: TEST_NAME, metadata };
    p.invoice_creation = { enabled: true, invoice_data: { description: TEST_NAME, metadata } };
  }

  if (minimal) return p;

  p.custom_text = { submit: { message: PLANS[plan].message } };
  if (tax) p.automatic_tax = { enabled: true };
  if (link) {
    if (link.allow_promotion_codes) p.allow_promotion_codes = true;
    if (link.billing_address_collection) p.billing_address_collection = link.billing_address_collection;
    if (link.tax_id_collection && link.tax_id_collection.enabled) p.tax_id_collection = { enabled: true };
  }
  return p;
}

async function createSession(s, plan, body, base) {
  const settings = await getLinkSettings(s);
  try {
    return { session: await s.checkout.sessions.create(buildParams(plan, body, base, settings, false)), settings, minimal: false };
  } catch (err) {
    // Een overgenomen instelling die Stripe in deze combinatie niet accepteert mag
    // de betaling niet blokkeren: probeer het met alleen het noodzakelijke.
    if (!err || err.type !== "StripeInvalidRequestError") throw err;
    console.error("[checkout-test] volledige aanvraag geweigerd:", plan, err.message);
    return { session: await s.checkout.sessions.create(buildParams(plan, body, base, settings, true)), settings, minimal: true };
  }
}

const hideKeys = (m) => String(m || "").replace(/[a-z]+_(live|test)_\w+/g, "<sleutel>").slice(0, 300);

async function check(req, res, s) {
  const allowed =
    process.env.VERCEL_ENV !== "production" ||
    (process.env.TEST_SECRET && req.headers["x-test-secret"] === process.env.TEST_SECRET);
  if (!allowed) return res.status(403).json({ ok: false, error: "check_not_allowed" });
  if (!s) return res.status(200).json({ ok: false, error: "stripe_not_configured" });

  const out = { ok: true, plans: {} };
  resetCache();
  for (const plan of Object.keys(PLANS)) {
    try {
      const { session, settings, minimal } = await createSession(
        s, plan, { lead_id: "check_" + Date.now().toString(36), name: "Controle" }, baseUrl(req)
      );
      out.plans[plan] = {
        ok: true,
        mode: session.mode,
        bedrag_nu: session.amount_total != null ? session.amount_total / 100 : null,
        subtotaal: session.amount_subtotal != null ? session.amount_subtotal / 100 : null,
        btw: session.total_details ? session.total_details.amount_tax / 100 : null,
        btw_automatisch: !!(session.automatic_tax && session.automatic_tax.enabled),
        payment_link_gevonden: !!settings.link,
        maandprijs: settings.monthly
          ? { bedrag: settings.monthly.unit_amount / 100, valuta: settings.monthly.currency, bestaand: true }
          : { bedrag: MONTH_CENTS / 100, valuta: "eur", bestaand: false },
        met_minimale_instellingen: minimal,
      };
      try { await s.checkout.sessions.expire(session.id); } catch (_) {}
    } catch (err) {
      out.ok = false;
      out.plans[plan] = { ok: false, fout: String((err && (err.code || err.type)) || "onbekend"), melding: hideKeys(err && err.message) };
    }
  }
  out.webhook = await webhookStatus(s);
  return res.status(200).json(out);
}

// Staat er in Stripe een webhook naar /api/stripe-webhook, met de juiste events?
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.trial_will_end",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
async function webhookStatus(s) {
  try {
    const list = await s.webhookEndpoints.list({ limit: 100 });
    const ep = list.data.find((e) => /\/api\/stripe-webhook$/.test(e.url) && e.status === "enabled");
    if (!ep) return { gevonden: false, secret_in_vercel: !!process.env.STRIPE_WEBHOOK_SECRET, nodig: WEBHOOK_EVENTS };
    const all = ep.enabled_events.includes("*");
    return {
      gevonden: true,
      url: ep.url,
      api_versie: ep.api_version || "standaard",
      ontbrekende_events: all ? [] : WEBHOOK_EVENTS.filter((e) => !ep.enabled_events.includes(e)),
      secret_in_vercel: !!process.env.STRIPE_WEBHOOK_SECRET,
    };
  } catch (err) {
    return { gevonden: null, fout: String((err && (err.code || err.type)) || "onbekend"), melding: hideKeys(err && err.message), secret_in_vercel: !!process.env.STRIPE_WEBHOOK_SECRET };
  }
}

// Vaste betaallinks voor de test (om te delen via WhatsApp, DM of e-mail). Zelfde aanbod
// als de landingspagina; aankopen krijgen lp_variant "betaallink" zodat ze de A/B-test
// niet vertroebelen. Bestaat de link al, dan wordt hij hergebruikt.
const LINK_BASE = "https://landing.promo-view.io";
async function createLinks(req, res, s) {
  const allowed =
    process.env.VERCEL_ENV !== "production" ||
    (process.env.TEST_SECRET && req.headers["x-test-secret"] === process.env.TEST_SECRET);
  if (!allowed) return res.status(403).json({ ok: false, error: "not_allowed" });
  if (!s) return res.status(200).json({ ok: false, error: "stripe_not_configured" });
  const out = { ok: true, links: {} };
  try {
    resetCache();
    const settings = await getLinkSettings(s);
    const link = settings.link;
    const tax = !!(link && link.automatic_tax && link.automatic_tax.enabled);
    const taxB = tax ? { tax_behavior: "exclusive" } : {};
    const testPrice = await findOrCreatePrice(s, TEST_PRICE_KEY, Object.assign({ currency: "eur", unit_amount: TEST_CENTS, product_data: { name: TEST_NAME } }, tax ? { tax_behavior: "inclusive" } : {}));
    const monthly = settings.monthly || await findOrCreatePrice(s, "pv_groeisysteem_190_maand_v1", Object.assign({ currency: "eur", unit_amount: MONTH_CENTS, recurring: { interval: "month" }, product_data: { name: "PromoView Groeisysteem" } }, taxB));

    // We gaan verder met één aanbod: €49 voor 14 dagen, daarna €190 per maand (V7).
    for (const plan of ["doorlopend"]) {
      try {
        let existing = null;
        for await (const pl of s.paymentLinks.list({ active: true, limit: 100 })) {
          if (pl.metadata && pl.metadata.test === "49_14_dagen" && pl.metadata.plan === plan) { existing = pl; break; }
        }
        if (existing && existing.metadata.prijs === "incl_btw") { out.links[plan] = { ok: true, url: existing.url, nieuw: false }; continue; }
        // De oude link (€49 + btw) blijft werken voor wie hem al heeft; zet hem zelf uit in Stripe.
        if (existing) out.links[plan + "_oud_nog_actief"] = existing.url;
        const metadata = { test: "49_14_dagen", plan, lp_variant: "betaallink", bron: "betaallink", prijs: "incl_btw" };
        const p = {
          metadata,
          line_items: plan === "doorlopend" ? [{ price: monthly.id, quantity: 1 }, { price: testPrice.id, quantity: 1 }] : [{ price: testPrice.id, quantity: 1 }],
          after_completion: { type: "redirect", redirect: { url: `${LINK_BASE}/bedankt.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}` } },
          phone_number_collection: { enabled: true },
          custom_fields: [{ key: "instagram", label: { type: "custom", custom: "Instagram-gebruikersnaam" }, type: "text", text: { minimum_length: 2, maximum_length: 40 } }],
          custom_text: { submit: { message: PLANS[plan].message } },
        };
        if (plan === "doorlopend") p.subscription_data = { trial_period_days: TRIAL_DAYS, metadata };
        else {
          p.customer_creation = "always";
          p.payment_intent_data = { description: TEST_NAME, metadata };
          p.invoice_creation = { enabled: true, invoice_data: { description: TEST_NAME, metadata } };
        }
        if (tax) p.automatic_tax = { enabled: true };
        if (link) {
          if (link.allow_promotion_codes) p.allow_promotion_codes = true;
          if (link.billing_address_collection) p.billing_address_collection = link.billing_address_collection;
          if (link.tax_id_collection && link.tax_id_collection.enabled) p.tax_id_collection = { enabled: true };
        }
        const created = await s.paymentLinks.create(p);
        out.links[plan] = { ok: true, url: created.url, nieuw: true };
      } catch (err) {
        out.ok = false;
        out.links[plan] = { ok: false, fout: String((err && (err.code || err.type)) || "onbekend"), melding: hideKeys(err && err.message) };
      }
    }
  } catch (err) {
    out.ok = false;
    out.fout = String((err && (err.code || err.type)) || "onbekend");
    out.melding = hideKeys(err && err.message);
  }
  return res.status(200).json(out);
}

// GET ?slack_test=1 stuurt één testbericht naar #direct-payment (via Make).
// Zelfde beveiliging als ?check=1: alleen previews, of met header x-test-secret.
async function slackTest(req, res) {
  const allowed =
    process.env.VERCEL_ENV !== "production" ||
    (process.env.TEST_SECRET && req.headers["x-test-secret"] === process.env.TEST_SECRET);
  if (!allowed) return res.status(403).json({ ok: false, error: "check_not_allowed" });
  const { sendSlack } = require("./_lib/slack");
  const { slackPaymentText } = require("./_lib/payment");
  const voorbeeld = slackPaymentText({
    id: "cs_voorbeeld", amount_total: 4900, currency: "eur", customer: null,
    customer_details: { name: "TEST Jan Voorbeeld", phone: "+31612345678", email: "test@voorbeeld.nl" },
    custom_fields: [{ key: "instagram", text: { value: "@testaccount" } }],
    metadata: { plan: "doorlopend", lp_variant: "v7", niche: "Kapper / salon", doel: "Meer klanten", utm_source: "ig" },
  });
  // ?slack_test=1&board=1: alleen een testkaart op het Trello-bord (geen Slack-bericht).
  if (req.query.board) {
    const { boardEvent, paymentCard } = require("./_lib/board");
    const card = paymentCard({
      id: "test_" + Date.now().toString(36), amount_total: 4900, currency: "eur", created: Math.floor(Date.now() / 1000),
      customer_details: { name: "TEST Jan Voorbeeld (mag weg)", phone: "+31612345678", email: "test@voorbeeld.nl" },
      custom_fields: [{ key: "instagram", text: { value: "testaccount" } }],
      metadata: { plan: "doorlopend", lp_variant: "v7", niche: "Kapper / salon", doel: "Meer klanten", utm_source: "ig" },
    });
    const first = await boardEvent(card);
    await new Promise((r) => setTimeout(r, 4000));
    const second = await boardEvent({ event: "onboarding", key: card.key, list: "onboarding", label: "tfa", comment: "📝 TEST: onboarding ingevuld (kaart mag weg)." });
    return res.status(200).json({ ok: first.ok && second.ok, key: card.key, first, second });
  }
  const r = await sendSlack(":test_tube: _TESTBERICHT, geen echte betaling. Check van de koppeling Make → Slack._\n" + voorbeeld);
  return res.status(200).json(r);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const s = getStripe();
  if (req.method === "GET") {
    if (req.query && req.query.slack_test) return slackTest(req, res);
    if (req.query && req.query.check) return check(req, res, s);
    if (req.query && req.query.create_links) return createLinks(req, res, s);
    return res.status(200).json({ ok: true, configured: !!s, plans: Object.keys(PLANS) });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const plan = clean(body.plan, 20);
  if (!PLANS[plan]) return res.status(400).json({ ok: false, error: "unknown_plan" });
  if (!s) return res.status(503).json({ ok: false, error: "stripe_not_configured" });

  try {
    const { session } = await createSession(s, plan, body, baseUrl(req));
    return res.status(200).json({ ok: true, url: session.url, id: session.id });
  } catch (err) {
    console.error("[checkout-test]", plan, err && (err.code || err.type), hideKeys(err && err.message));
    return res.status(502).json({ ok: false, error: String((err && (err.code || err.type)) || "stripe_error").slice(0, 60) });
  }
};
