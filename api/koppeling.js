const { PostHog } = require("posthog-node");
const { sendSlack, ONBOARDING_CHANNEL } = require("./_lib/slack");
const { boardEvent } = require("./_lib/board");
const { seal, open, codeOk } = require("./_lib/kluis");
const { pp } = require("./_lib/paypro");

// Koppelpagina (Framer, www.promo-view.io/onboarding-v2): Instagram-naam, wachtwoord en
// back-upcode. Twee acties:
//
//   POST /api/koppeling            { instagram, wachtwoord, backup_code, ref? }
//     - versleutelt wachtwoord + back-upcode (zie _lib/kluis.js)
//     - Trello: kaart naar "Account koppelen" met een link om de gegevens te bekijken
//     - Slack #direct-payment: melding ZONDER gegevens
//   POST /api/koppeling?bekijk=1   { token, code }
//     - alleen met de teamcode (KOPPEL_TEAM_CODE): geeft de gegevens terug aan
//       landing.promo-view.io/intern/koppeling
//
// Nodig in Vercel: KOPPEL_KEY (sleutel) en KOPPEL_TEAM_CODE (code voor het team).

const ORIGINS = ["https://www.promo-view.io", "https://promo-view.io", "https://landing.promo-view.io", "null"];
const BASE = "https://landing.promo-view.io";

let posthog = null;
function getPostHog() {
  if (!process.env.POSTHOG_KEY) return null;
  if (!posthog) posthog = new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com" });
  return posthog;
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
}
const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max || 200));
function handle(v) {
  let u = clean(v, 120);
  const m = u.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) u = m[1];
  u = u.replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : "";
}

// Welke klant is dit? Via de ref uit de link, anders het PayPro-abonnement met deze Instagram-naam.
async function findKey(ref, insta) {
  if (/^(PS[A-Z0-9]+|sub_\w+|cs_\w+)$/.test(ref)) return ref;
  try {
    const list = await pp("GET", "/subscriptions?limit=50");
    const hit = ((list && list.data) || []).find((x) => x.metadata && x.metadata.pv === "1" && String(x.metadata.insta || "").toLowerCase() === insta);
    if (hit) return hit.id;
  } catch (_) {}
  return null;
}

// Eenvoudige rem op het raden van de teamcode (per warme functie).
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 15 * 60 * 1000);
  tries.set(ip, t);
  return t.length >= 10;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  const b = readBody(req);

  // Bekijken door het team.
  if (req.query && req.query.bekijk) {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    if (tooMany(ip)) return res.status(429).json({ ok: false, error: "te_vaak" });
    if (!process.env.KOPPEL_TEAM_CODE) return res.status(503).json({ ok: false, error: "teamcode_niet_ingesteld" });
    if (!codeOk(b.code)) {
      tries.get(ip).push(Date.now());
      await new Promise((r) => setTimeout(r, 800));
      return res.status(403).json({ ok: false, error: "verkeerde_code" });
    }
    try {
      const d = open(b.token);
      return res.status(200).json({ ok: true, instagram: d.u, wachtwoord: d.p, backup_code: d.c || null, ontvangen: d.t || null });
    } catch (_) {
      return res.status(400).json({ ok: false, error: "ongeldige_link" });
    }
  }

  // Nieuwe koppeling van de klant.
  const insta = handle(b.instagram);
  const pass = String(b.wachtwoord || "");
  const code = clean(b.backup_code, 64);
  if (!insta || pass.length < 4 || pass.length > 200) return res.status(400).json({ ok: false, error: "ongeldig" });

  // Demo-modus (alleen previews, zonder KOPPEL_KEY): de flow werkt, maar wachtwoord en
  // back-upcode worden weggegooid, nergens opgeslagen of doorgestuurd. Live blijft het streng.
  let token = null, demo = false;
  try { token = seal({ u: insta, p: pass, c: code, t: new Date().toISOString() }); }
  catch (e) {
    if (process.env.VERCEL_ENV === "production") {
      console.error("[koppeling] sleutel ontbreekt");
      return res.status(503).json({ ok: false, error: "niet_ingesteld" });
    }
    demo = true;
  }
  const link = token ? `${BASE}/intern/koppeling#${token}` : null;
  const key = await findKey(clean(b.ref, 60), insta);
  const now = new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", dateStyle: "short", timeStyle: "short" });
  const where = demo
    ? "\n_DEMO (preview zonder KOPPEL_KEY): de gegevens zijn niet opgeslagen._"
    : `\nBekijken (alleen team, met de teamcode): ${link}\nZet daarna het vinkje "Instagram gekoppeld" op deze kaart.`;

  await Promise.all([
    boardEvent({
      event: "koppeling",
      key: key || "koppeling_" + insta,
      naam: "@" + insta,
      insta,
      list: "koppelen",
      card_name: `@${insta} · koppeling (zonder betaling gevonden)`,
      card_desc: `**Instagram:** https://instagram.com/${insta}\n\n_Koppeling binnengekomen zonder gekoppelde betaling. Zoek de klant op in PayPro en zet deze info op de juiste kaart._`,
      comment: `🔐 **Instagram-gegevens ontvangen** (${now}) via de koppelpagina${code ? ", inclusief back-upcode" : ""}.${where}`,
    }),
    sendSlack(`:closed_lock_with_key: *Account gekoppeld:* @${insta} heeft zijn Instagram-gegevens doorgegeven${code ? " (met back-upcode)" : ""}.${demo ? " _(demo: gegevens niet opgeslagen)_" : " Staat op de Trello-kaart, alleen zichtbaar met de teamcode."}${key ? "" : " _Geen betaling gevonden bij deze Instagram-naam: even controleren._"}`, ONBOARDING_CHANNEL),
  ]);
  const ph = getPostHog();
  if (ph) {
    ph.capture({ distinctId: key || "koppeling_" + insta, event: "instagram_gekoppeld", properties: { met_backupcode: !!code, betaling_gevonden: !!key, demo, source: "koppelpagina" } });
    await ph.shutdown();
  }
  return res.status(200).json({ ok: true });
};
