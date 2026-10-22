// Meta Conversions API (server-side events).
// Werkt alleen als META_PIXEL_ID en META_CAPI_TOKEN in Vercel staan; anders
// slaat het stil over. Persoonsgegevens gaan altijd gehasht (SHA-256) naar Meta.
// Dezelfde event_id als de browser-pixel zorgt dat Meta browser + server
// als één event telt (deduplicatie).
const crypto = require("crypto");

const GRAPH_VERSION = "v21.0";

function sha(v) {
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  return crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");
}

// Meta wil telefoonnummers met landcode, alleen cijfers. NL 06 -> 316, BE 04 -> 324.
function normPhone(p) {
  if (!p) return undefined;
  let d = String(p).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (/^06\d{8}$/.test(d)) d = "31" + d.slice(1);
  else if (/^04\d{8}$/.test(d)) d = "32" + d.slice(1);
  d = d.replace(/\D/g, "");
  return d.length >= 8 ? d : undefined;
}

function clientIp(req) {
  const xf = req && req.headers && (req.headers["x-forwarded-for"] || "");
  return String(xf).split(",")[0].trim() || undefined;
}

function clean(obj) {
  Object.keys(obj).forEach((k) => obj[k] === undefined && delete obj[k]);
  return obj;
}

async function sendMetaEvent({ eventName, eventId, eventSourceUrl, user = {}, customData = {} }) {
  const pixel = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token) return { ok: false, skipped: "meta_not_configured" };

  const firstName = user.name ? String(user.name).trim().split(/\s+/)[0] : undefined;
  const phone = normPhone(user.phone);
  const userData = clean({
    em: user.email ? [sha(user.email)] : undefined,
    ph: phone ? [sha(phone)] : undefined,
    fn: firstName ? [sha(firstName)] : undefined,
    external_id: user.externalId ? [sha(user.externalId)] : undefined,
    client_ip_address: user.ip,
    client_user_agent: user.ua,
    fbp: user.fbp || undefined,
    fbc: user.fbc || undefined,
  });

  const event = clean({
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: eventSourceUrl || undefined,
    user_data: userData,
    custom_data: clean(Object.assign({}, customData)),
  });

  const body = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
    );
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: "meta_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendMetaEvent, clientIp, normPhone };
