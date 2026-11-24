// PayPro API (https://docs.paypro.nl). Nodig in Vercel: PAYPRO_API_KEY.
// Bedragen zijn in centen INCLUSIEF btw (veld `vat` geeft het percentage).
const crypto = require("crypto");

const API = process.env.PAYPRO_API_URL || "https://api.paypro.nl";
const WEBHOOK_PATH = "/api/paypro-webhook";

// Het aanbod: 14 dagen voor €49 excl. btw, daarna €190 per maand excl. btw,
// ingaand op de dag dat de proef afloopt.
const OFFER = {
  first: { amount: 5929, vat: 21, interval: "day", multiplier: 14 },   // €49 + 21% btw
  period: { amount: 22990, vat: 21, interval: "month", multiplier: 1 }, // €190 + 21% btw
  description: "PromoView – 14 dagen testen, daarna €190 p/m",
};

class PayProError extends Error {
  constructor(status, data) {
    const e = (data && data.error) || {};
    super(e.message || `paypro_status_${status}`);
    this.status = status;
    this.param = e.param || null;
    this.type = e.type || null;
  }
}

async function pp(method, path, body) {
  const key = process.env.PAYPRO_API_KEY;
  if (!key) throw new PayProError(0, { error: { message: "paypro_not_configured" } });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "PromoView landing (Vercel)" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status >= 400) throw new PayProError(r.status, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Webhook-handtekening: HMAC-SHA256 over "<PayPro-Timestamp>.<ruwe body>" met het webhook-secret.
function verifySignature(rawBody, signature, timestamp, secret, toleranceSec) {
  if (!signature || !timestamp || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(String(signature)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  return age <= (toleranceSec || 600);
}

// Het secret van onze eigen webhook. Uit Vercel (PAYPRO_WEBHOOK_SECRET) of, als dat ontbreekt,
// opgehaald bij PayPro (het webhook-object bevat het secret). 10 minuten bewaard per warme functie.
let secretCache = null;
async function webhookSecret() {
  if (process.env.PAYPRO_WEBHOOK_SECRET) return process.env.PAYPRO_WEBHOOK_SECRET;
  if (secretCache && Date.now() - secretCache.at < 10 * 60 * 1000) return secretCache.value;
  const list = await pp("GET", "/webhooks");
  const hook = ((list && list.data) || []).find((w) => w.active && String(w.url || "").endsWith(WEBHOOK_PATH));
  secretCache = { at: Date.now(), value: hook ? hook.secret : null };
  return secretCache.value;
}

// Abonnement + klant van PayPro omgezet naar dezelfde vorm als een Stripe Checkout Session,
// zodat PostHog, Slack, GoHighLevel, Meta en Trello één codepad houden.
async function paySession(subId) {
  const sub = await pp("GET", "/subscriptions/" + encodeURIComponent(subId));
  const md = sub.metadata || {};
  if (md.pv !== "1") return { sub, paid: false, session: null };
  let cust = {};
  try { cust = await pp("GET", "/customers/" + encodeURIComponent(sub.customer)); } catch (_) {}
  // "active": de eerste betaling (€59,29) is binnen en de machtiging staat.
  const paid = sub.state === "active" || sub.state === "paused" || sub.state === "canceled" && !!md.pv_gemeld;
  const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ") || null;
  const session = {
    id: sub.id,
    provider: "paypro",
    payment_status: paid ? "paid" : "unpaid",
    amount_total: OFFER.first.amount,
    currency: "eur",
    customer: sub.customer,
    subscription: sub.id,
    client_reference_id: md.lead_id || null,
    customer_email: cust.email || null,
    customer_details: { name, email: cust.email || null, phone: cust.phone_number || null },
    custom_fields: md.insta ? [{ key: "instagram", text: { value: md.insta } }] : [],
    metadata: md,
    created: Math.floor(new Date(sub.start_at || sub.created_at || Date.now()).getTime() / 1000),
  };
  return { sub, paid, session };
}

// Eén keer melden per betaling: stempel in de metadata van het abonnement.
async function claimOnceSub(sub, field) {
  const key = field || "pv_gemeld";
  try {
    const fresh = await pp("GET", "/subscriptions/" + encodeURIComponent(sub.id));
    const md = fresh.metadata || {};
    if (md[key]) return false;
    await pp("PATCH", "/subscriptions/" + encodeURIComponent(sub.id), { metadata: Object.assign({}, md, { [key]: new Date().toISOString() }) });
    return true;
  } catch (e) {
    console.error("[paypro claimOnce]", e && e.message);
    return true; // liever één melding te veel dan een gemiste betaling
  }
}

// Abonnement terugvinden op lead_id (staat in de return_url), voor als de klant na iDEAL
// in een andere browser terugkomt dan waar hij begon (bijv. vanuit de Instagram-app).
async function findSubByLead(leadId) {
  if (!leadId) return null;
  const list = await pp("GET", "/subscriptions?limit=50");
  const hit = ((list && list.data) || []).find((x) => x.metadata && x.metadata.pv === "1" && x.metadata.lead_id === leadId);
  return hit ? hit.id : null;
}

module.exports = { findSubByLead, pp, PayProError, OFFER, WEBHOOK_PATH, verifySignature, webhookSecret, paySession, claimOnceSub };
