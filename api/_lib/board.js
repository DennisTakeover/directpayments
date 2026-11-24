// Trello-bord "PromoView – €49 testklanten" (https://trello.com/b/DnzwdniL), via Make
// (scenario "PromoView – testklanten naar Trello"). Make zoekt de kaart terug op `key`
// (abonnement- of betaal-id) en maakt, verplaatst, labelt of becommentarieert hem.
//
// Payload: { event, key, naam, insta, card_name?, card_desc?, due?, list?, label?, comment? }
//   list:  betaald | onboarding | koppelen | live | bijna | door | gestopt
//   label: v7 | v8 | link | tfa | opzeg | mislukt | laat
// Nodig in Vercel: MAKE_BOARD_WEBHOOK_URL. Ontbreekt die, dan slaat dit stil over.
const { sessionProps, amountOf, localPhone } = require("./payment");

async function boardEvent(payload) {
  const url = process.env.MAKE_BOARD_WEBHOOK_URL;
  if (!url || !payload || !payload.key) return { ok: false, skipped: "board_not_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
    return r.ok ? { ok: true } : { ok: false, error: `board_status_${r.status}` };
  } catch (e) {
    return { ok: false, error: "board_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

const DAY = 86400 * 1000;
const nlDate = (d) => new Date(d).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam" });
const euro = (n) => (n == null ? "?" : "€" + Number(n).toFixed(2).replace(".", ","));
const SOURCE = { ig: "Instagram-advertentie", fb: "Facebook-advertentie", an: "Audience Network", email: "e-mail" };

// Dezelfde sleutel in elk systeem: het abonnement als dat er is, anders de betaling.
function keyOf(session) {
  const sub = typeof session.subscription === "string" ? session.subscription : session.subscription && session.subscription.id;
  return sub || session.id;
}

function waLink(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 9 ? `https://wa.me/${d}` : null;
}

// Kaart voor een nieuwe betaling (Stripe Checkout of de eigen betaalstap).
function paymentCard(session, extra) {
  const cd = session.customer_details || {};
  const p = sessionProps(session);
  const paidAt = new Date((session.created || Date.now() / 1000) * 1000);
  const trialEnd = (extra && extra.trialEnd) || new Date(paidAt.getTime() + 14 * DAY);
  const name = cd.name || "Onbekend";
  const insta = p.insta ? String(p.insta).replace(/^@/, "") : "";
  const label = p.lp_variant === "betaallink" ? "link" : p.plan === "eenmalig" ? "v8" : "v7";
  const wat = p.plan === "eenmalig" ? "eenmalig, geen abonnement" : "daarna €190 per maand, tenzij opgezegd vóór dag 14";
  const bron = p.lp_variant === "betaallink" ? "vaste betaallink" : (SOURCE[p.utm_source] || p.utm_source || "direct") + (p.utm_content ? ` (${p.utm_content})` : "");
  const wa = waLink(cd.phone);
  const lines = [
    `**Naam:** ${name}`,
    `**Telefoon:** ${localPhone(cd.phone)}${wa ? ` · WhatsApp: ${wa}` : ""}`,
    `**E-mail:** ${cd.email || session.customer_email || "onbekend"}`,
    `**Instagram:** ${insta ? `https://instagram.com/${insta}` : "onbekend"}`,
    `**Branche:** ${p.niche || "-"} · **Doel:** ${p.doel || "-"}`,
    `**Betaald:** ${euro(amountOf(session))} incl. btw op ${nlDate(paidAt)} (${wat})`,
    `**Proef loopt tot:** ${nlDate(trialEnd)}`,
    `**Bron:** ${bron}`,
  ];
  if (session.provider === "paypro") lines.push(`**PayPro:** https://app.paypro.nl/subscriptions/${session.id}`);
  else if (session.customer) lines.push(`**Stripe:** https://dashboard.stripe.com/customers/${session.customer}`);
  lines.push("", `Ref: ${keyOf(session)}`);
  return {
    event: "betaald",
    key: keyOf(session),
    naam: name,
    insta,
    card_name: `${insta ? "@" + insta : name} · ${name}`,
    card_desc: lines.join("\n"),
    due: trialEnd.toISOString(),
    list: "betaald",
    label,
  };
}

module.exports = { boardEvent, paymentCard, keyOf, nlDate, euro };
