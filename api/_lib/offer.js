// Het aanbod "PromoView 14 dagen testen voor €49, daarna €190 per maand":
// prijzen en Stripe-instellingen, gedeeld door /api/checkout-test (Stripe Checkout)
// en /api/pay (de eigen betaalstap op de landingspagina).

const PAYMENT_LINK_URL =
  process.env.STRIPE_PAYMENT_LINK_URL || "https://buy.stripe.com/14A9AVd2t5yQ8OK1uPb7y08";

const TEST_CENTS = 4900;
const MONTH_CENTS = 19000;
const TRIAL_DAYS = 14;
const TEST_NAME = "PromoView – 14 dagen testen";
const TEST_DESC = "Het groeisysteem 14 dagen, plus gratis profielcheck en bio- en highlightoptimalisatie";

// Instellingen + maandprijs van de €190-Payment Link, 10 minuten per warme functie bewaard.
let linkCache = null;
async function getLinkSettings(s, fresh) {
  if (!fresh && linkCache && Date.now() - linkCache.at < 10 * 60 * 1000) return linkCache.value;
  let link = null;
  for await (const pl of s.paymentLinks.list({ limit: 100 })) {
    if (pl.url === PAYMENT_LINK_URL) { link = pl; break; }
  }
  let monthly = null;
  if (link) {
    const items = await s.paymentLinks.listLineItems(link.id, { limit: 20 });
    const li = items.data.find((x) => x.price && x.price.recurring && x.price.recurring.interval === "month");
    if (li) monthly = li.price;
  }
  const value = { link, monthly };
  linkCache = { at: Date.now(), value };
  return value;
}

async function findOrCreatePrice(s, lookupKey, params) {
  const found = await s.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (found.data[0]) return found.data[0];
  return s.prices.create(Object.assign({ lookup_key: lookupKey }, params));
}

// De twee prijzen van het aanbod: €49 eenmalig (de test) en €190 per maand.
let priceCache = null;
async function offerPrices(s) {
  if (priceCache && Date.now() - priceCache.at < 10 * 60 * 1000) return priceCache.value;
  const settings = await getLinkSettings(s);
  const link = settings.link;
  const tax = !!(link && link.automatic_tax && link.automatic_tax.enabled);
  const taxB = tax ? { tax_behavior: "exclusive" } : {};
  const test = await findOrCreatePrice(s, "pv_test49_14_dagen_v1",
    Object.assign({ currency: "eur", unit_amount: TEST_CENTS, product_data: { name: TEST_NAME } }, taxB));
  const monthly = settings.monthly || await findOrCreatePrice(s, "pv_groeisysteem_190_maand_v1",
    Object.assign({ currency: "eur", unit_amount: MONTH_CENTS, recurring: { interval: "month" }, product_data: { name: "PromoView Groeisysteem" } }, taxB));
  const value = { test, monthly, tax, link };
  priceCache = { at: Date.now(), value };
  return value;
}

module.exports = {
  PAYMENT_LINK_URL, TEST_CENTS, MONTH_CENTS, TRIAL_DAYS, TEST_NAME, TEST_DESC,
  getLinkSettings, findOrCreatePrice, offerPrices,
  resetCache() { linkCache = null; priceCache = null; },
};
