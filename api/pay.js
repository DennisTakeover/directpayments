const Stripe = require("stripe");
const { TRIAL_DAYS, offerPrices, resetCache } = require("./_lib/offer");

// De eigen betaalstap op v7: de bezoeker blijft op onze pagina en betaalt via de
// Stripe Payment Element (kaart, Apple Pay, Google Pay). Geen doorsturen naar
// checkout.stripe.com.
//
//   POST /api/pay            maakt klant + abonnement (€49 nu, 14 dagen proef, daarna
//                            €190 per maand) en geeft de client_secret van de eerste
//                            betaling terug. De browser bevestigt die met Stripe.js.
//   GET  /api/pay?config=1   publishable key en bedrag voor de betaalstap.
//   GET  /api/pay?check=1    (alleen previews of met x-test-secret) maakt een proef-
//                            abonnement, leest de status en ruimt alles direct op.
//
// Het abonnement start als "incomplete": pas als de €49 betaald is, gaat de proef in.
// Wordt er niet betaald, dan laat Stripe het na 23 uur vanzelf verlopen. Er wordt
// dus nooit iets afgeschreven zonder dat de klant zelf betaald heeft.
//
// Nodig in Vercel: STRIPE_SECRET_KEY en STRIPE_PUBLISHABLE_KEY (pk_live_...).

const PM_TYPES = ["card"]; // kaart + Apple Pay + Google Pay. iDEAL kan niet bij een abonnement zonder SEPA-incasso.
const COUNTRIES = ["NL", "BE"];

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));
const hideKeys = (m) => String(m || "").replace(/[a-z]+_(live|test)_\w+/g, "<sleutel>").slice(0, 300);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

// 06 12345678 -> +31612345678, 0470 12 34 56 -> +32470123456. Anders null.
function normPhone(v, country) {
  let d = String(v || "").replace(/[\s().-]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^0[1-9]\d{8}$/.test(d)) d = (country === "BE" ? "+32" : "+31") + d.slice(1);
  if (/^0[1-9]\d{7}$/.test(d) && country === "BE") d = "+32" + d.slice(1);
  if (/^\+\d{8,15}$/.test(d)) return d;
  return null;
}

// "@Bakkerij.Jan", "instagram.com/bakkerij.jan/" -> "bakkerij.jan"
function normInsta(v) {
  let u = String(v || "").trim();
  const m = u.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) u = m[1];
  u = u.replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}

function allowedTest(req) {
  return process.env.VERCEL_ENV !== "production" ||
    (process.env.TEST_SECRET && req.headers["x-test-secret"] === process.env.TEST_SECRET);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
}

function buildMetadata(b, insta) {
  const meta = {
    native: "1",
    plan: "doorlopend",
    test: "49_14_dagen",
    lead_id: clean(b.lead_id, 100).replace(/[^A-Za-z0-9_-]/g, ""),
    insta,
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
  Object.keys(meta).forEach((k) => { const v = clean(meta[k], 200); if (v) out[k] = v; });
  return out;
}

function piOf(sub) {
  const inv = sub && sub.latest_invoice;
  return inv && typeof inv === "object" && inv.payment_intent && typeof inv.payment_intent === "object" ? inv.payment_intent : null;
}

function answer(sub) {
  const inv = sub.latest_invoice;
  const pi = piOf(sub);
  return {
    ok: true,
    subscription_id: sub.id,
    client_secret: pi ? pi.client_secret : null,
    amount: inv ? inv.amount_due : null,
    currency: inv ? inv.currency : "eur",
    status: pi ? pi.status : null,
  };
}

async function createSubscription(s, b, d) {
  const { test, monthly, tax } = await offerPrices(s);
  const metadata = buildMetadata(b, d.insta);
  const customer = await s.customers.create({
    name: d.name,
    email: d.email,
    phone: d.phone,
    address: { country: d.country },
    preferred_locales: ["nl"],
    metadata: { lead_id: metadata.lead_id || "", insta: d.insta, bron: "eigen_betaalstap" },
  });
  const params = {
    customer: customer.id,
    items: [{ price: monthly.id, quantity: 1 }],
    add_invoice_items: [{ price: test.id, quantity: 1 }],
    trial_period_days: TRIAL_DAYS,
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription", payment_method_types: PM_TYPES },
    metadata,
    expand: ["latest_invoice.payment_intent"],
  };
  if (tax) params.automatic_tax = { enabled: true };
  return s.subscriptions.create(params);
}

// Tweede poging in dezelfde sessie (bijv. kaart geweigerd of typfout in het e-mailadres):
// hetzelfde abonnement hergebruiken in plaats van een nieuwe klant aan te maken.
async function reuseSubscription(s, b, d) {
  const id = clean(b.subscription_id, 60);
  if (!/^sub_\w+$/.test(id)) return null;
  let sub;
  try { sub = await s.subscriptions.retrieve(id, { expand: ["latest_invoice.payment_intent"] }); } catch (_) { return null; }
  const leadId = clean(b.lead_id, 100).replace(/[^A-Za-z0-9_-]/g, "");
  const pi = piOf(sub);
  if (!sub.metadata || sub.metadata.native !== "1" || !leadId || sub.metadata.lead_id !== leadId) return null;
  if (sub.status !== "incomplete" || !pi || !["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) return null;
  const custId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  await s.customers.update(custId, { name: d.name, email: d.email, phone: d.phone, metadata: { insta: d.insta } });
  if (sub.metadata.insta !== d.insta) await s.subscriptions.update(sub.id, { metadata: { insta: d.insta } });
  return sub;
}

async function check(req, res, s) {
  if (!allowedTest(req)) return res.status(403).json({ ok: false, error: "check_not_allowed" });
  if (!s) return res.status(200).json({ ok: false, error: "stripe_not_configured" });
  resetCache();
  const out = { ok: true, publishable_key_in_vercel: !!process.env.STRIPE_PUBLISHABLE_KEY };
  let customer = null;
  try {
    const sub = await createSubscription(s, { lead_id: "check_" + Date.now().toString(36), page_version: "check" }, {
      name: "Controle Betaalstap", email: `controle+${Date.now()}@example.com`, phone: "+31600000000", insta: "controle", country: "NL",
    });
    customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const inv = sub.latest_invoice, pi = piOf(sub);
    Object.assign(out, {
      abonnement_status: sub.status,
      proef_tot: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      factuur: inv ? { status: inv.status, bedrag_nu: inv.amount_due / 100, btw: (inv.tax || 0) / 100, subtotaal: inv.subtotal / 100 } : null,
      betaling: pi ? { status: pi.status, betaalmethodes: pi.payment_method_types, setup_future_usage: pi.setup_future_usage, client_secret: !!pi.client_secret } : null,
    });
    await s.subscriptions.cancel(sub.id);
    if (inv && inv.status === "open") { try { await s.invoices.voidInvoice(inv.id); } catch (_) {} }
  } catch (err) {
    out.ok = false;
    out.fout = String((err && (err.code || err.type)) || "onbekend");
    out.melding = hideKeys(err && err.message);
  }
  if (customer) { try { await s.customers.del(customer); out.opgeruimd = true; } catch (_) { out.opgeruimd = false; } }

  // Apple Pay en Google Pay werken alleen op domeinen die bij Stripe geregistreerd zijn.
  try {
    const hosts = ["landing.promo-view.io", String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0]];
    const have = await s.paymentMethodDomains.list({ limit: 100 });
    out.domeinen = {};
    for (const h of [...new Set(hosts)].filter(Boolean)) {
      let dom = have.data.find((x) => x.domain_name === h);
      if (!dom) { try { dom = await s.paymentMethodDomains.create({ domain_name: h }); } catch (e) { out.domeinen[h] = { fout: hideKeys(e.message) }; continue; } }
      out.domeinen[h] = { apple_pay: dom.apple_pay && dom.apple_pay.status, google_pay: dom.google_pay && dom.google_pay.status };
    }
  } catch (err) {
    out.domeinen = { fout: hideKeys(err && err.message) };
  }
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const s = getStripe();

  if (req.method === "GET") {
    if (req.query && req.query.check) return check(req, res, s);
    let tax = true;
    try { if (s) tax = (await offerPrices(s)).tax; } catch (_) {}
    return res.status(200).json({
      ok: !!(s && process.env.STRIPE_PUBLISHABLE_KEY),
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
      amount: tax ? 5929 : 4900,
      currency: "eur",
      payment_method_types: PM_TYPES,
    });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!s) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

  const b = readBody(req);
  const country = COUNTRIES.includes(clean(b.country, 2).toUpperCase()) ? clean(b.country, 2).toUpperCase() : "NL";
  const d = {
    name: clean(b.name, 100),
    email: clean(b.email, 200).toLowerCase(),
    phone: normPhone(b.phone, country),
    insta: normInsta(b.insta),
    country,
  };
  if (d.name.length < 2) return res.status(400).json({ ok: false, error: "invalid_name" });
  if (!isEmail(d.email)) return res.status(400).json({ ok: false, error: "invalid_email" });
  if (!d.phone) return res.status(400).json({ ok: false, error: "invalid_phone" });
  if (!d.insta) return res.status(400).json({ ok: false, error: "invalid_insta" });

  try {
    const sub = (await reuseSubscription(s, b, d)) || (await createSubscription(s, b, d));
    const out = answer(sub);
    if (!out.client_secret) {
      console.error("[pay] geen client_secret", sub.id, sub.status);
      return res.status(502).json({ ok: false, error: "no_payment_intent" });
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error("[pay]", err && (err.code || err.type), hideKeys(err && err.message));
    return res.status(502).json({ ok: false, error: "stripe_error", code: String((err && err.code) || "") });
  }
};
