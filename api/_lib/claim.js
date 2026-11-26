// Eén keer melden, ook als meerdere routes tegelijk binnenkomen (PayPro subscription.started,
// payment.paid en de bedankpagina komen vaak binnen dezelfde seconde).
//
// De beslissing ligt bij één plek: Make-scenario "PromoView – eenmalig melden (claim)". Dat
// schrijft de sleutel in een data store zonder overschrijven; de data store weigert een tweede
// record met dezelfde sleutel. Alleen wie het record kon aanmaken krijgt { claimed: true }.
//
// Geeft true/false terug, of null als Make niet antwoordt (dan valt de aanroeper terug op de
// oude stempel in PayPro- of Stripe-metadata).
async function claim(key, bron) {
  const url = process.env.MAKE_CLAIM_WEBHOOK_URL;
  const s = process.env.PROFIELCHECK_SECRET;
  if (!url || !s || !key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: String(key).slice(0, 200), bron: String(bron || "").slice(0, 60), s }),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    const d = JSON.parse(txt);
    return typeof d.claimed === "boolean" ? d.claimed : null;
  } catch (e) {
    console.error("[claim]", key, e && e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { claim };
