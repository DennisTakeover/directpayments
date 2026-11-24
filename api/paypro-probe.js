// TIJDELIJK: verkent de PayPro API tijdens het bouwen van de PayPro-betaalstap.
// Alleen op previews (Vercel Authentication ervoor). Wordt verwijderd zodra de integratie staat.
//   ?op=methods | subs | hooks | sub&id=PS... | pay&id=PP...
//   ?op=post&path=payments|subscriptions|customers&body=<json>
const API = "https://api.paypro.nl";

function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (/secret|email|phone|first_name|last_name|address|postal|iban|account_holder|company_name|vat_number/i.test(k)) o[k] = val ? "<verborgen>" : val;
      else o[k] = redact(val);
    }
    return o;
  }
  return v;
}

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.PAYPRO_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data: redact(data) };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.VERCEL_ENV === "production") return res.status(404).end();
  if (!process.env.PAYPRO_API_KEY) return res.status(200).json({ ok: false, error: "no_key" });
  const q = req.query || {};
  try {
    switch (q.op) {
      case "methods": return res.json(await call("GET", "/pay_methods"));
      case "subs": return res.json(await call("GET", "/subscriptions?limit=3"));
      case "hooks": return res.json(await call("GET", "/webhooks"));
      case "sub": return res.json(await call("GET", "/subscriptions/" + encodeURIComponent(q.id || "")));
      case "pay": return res.json(await call("GET", "/payments/" + encodeURIComponent(q.id || "")));
      // Webhook naar de live site aanmaken (één keer, bij livegang). Bestaat hij al, dan niets doen.
      case "create_webhook": {
        const url = "https://landing.promo-view.io/api/paypro-webhook";
        const list = await call("GET", "/webhooks");
        const found = ((list.data && list.data.data) || []).find((w) => w.url === url);
        if (found) return res.json({ ok: true, created: false, id: found.id, active: found.active });
        const r = await call("POST", "/webhooks", {
          name: "PromoView landing",
          description: "Eigen betaalstap landing.promo-view.io (abonnementen 14 dagen test)",
          url,
          active: true,
          enabled_event_types: ["subscription.started", "subscription.canceled", "subscription.paused", "payment.paid", "payment.failed", "chargeback.created"],
        });
        return res.json({ ok: r.status < 300, created: true, status: r.status, id: r.data && r.data.id, error: r.data && r.data.error });
      }
      // Alleen testabonnementen (omschrijving begint met "TEST") annuleren.
      case "cancel_test": {
        const sub = await call("GET", "/subscriptions/" + encodeURIComponent(q.id || ""));
        if (!sub.data || !String(sub.data.description || "").startsWith("TEST")) return res.status(400).json({ error: "geen_test" });
        return res.json(await call("DELETE", "/subscriptions/" + encodeURIComponent(q.id)));
      }
      case "post": {
        if (!["payments", "subscriptions", "customers"].includes(q.path)) return res.status(400).json({ error: "path" });
        let body = {};
        try { body = JSON.parse(q.body || "{}"); } catch (_) { return res.status(400).json({ error: "body" }); }
        return res.json(await call("POST", "/" + q.path, body));
      }
      default: return res.status(400).json({ error: "op" });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message).slice(0, 200) });
  }
};
