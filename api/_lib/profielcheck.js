// Gratis profielcheck + bio- en highlightoptimalisatie, automatisch na de onboarding.
// Stuurt de onboarding naar Make (MAKE_PROFIELCHECK_WEBHOOK_URL, scenario "PromoView –
// profielcheck (AI)"). Make haalt het Instagram-profiel op (Apify), laat het beste
// OpenAI-redeneermodel de check schrijven, maakt highlight-iconen en een tips-infographic
// (beeldmodel) en zet alles in #directpayments-onboarding (bericht + bestanden in de thread).
// Geen wachtwoorden of contactgegevens: alleen wat nodig is voor de analyse.
async function sendProfielcheck(p) {
  const url = process.env.MAKE_PROFIELCHECK_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: "profielcheck_not_configured" };
  const body = {
    test: !!p.test,
    ref: p.ref || null,
    insta: p.insta,
    naam: p.naam || "",
    bedrijf: p.bedrijf || "",
    product_dienst: p.product_dienst || "",
    geslacht: p.geslacht || "",
    leeftijd: p.leeftijd || "",
    locatie: p.locatie || "",
    interesses: p.interesses || "",
    profielen: (p.profielen || []).map((x) => "@" + x).join(", "),
    niche: p.niche || "",
    doel: p.doel || "",
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    return { ok: r.ok, status: r.status };
  } catch (_) {
    return { ok: false, error: "profielcheck_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendProfielcheck };
