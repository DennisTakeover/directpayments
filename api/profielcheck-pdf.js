const crypto = require("crypto");
const { maakRapporten } = require("./_lib/pdfrapport");

// POST /api/profielcheck-pdf (alleen voor Make, met header x-pv-secret = PROFIELCHECK_SECRET)
// Body: { insta, test, analyse: {...}, highlights: [{ naam, inhoud, img (base64) }], infographic (base64) }
// Antwoord: { ok, pdf1, pdf1_naam, pdf2, pdf2_naam } met de PDF's als base64.
// De analyse en afbeeldingen komen uit het Make-scenario "PromoView – profielcheck (AI)".

function secretOk(given) {
  const want = process.env.PROFIELCHECK_SECRET || "";
  if (want.length < 24 || !given) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function parse(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(v || "null"); } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!secretOk(req.headers["x-pv-secret"])) return res.status(403).json({ ok: false, error: "geen_toegang" });

  const b = parse(req.body) || {};
  const insta = String(b.insta || "").replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(insta)) return res.status(400).json({ ok: false, error: "ongeldige_instagram" });
  const analyse = parse(b.analyse);
  if (!analyse) return res.status(400).json({ ok: false, error: "geen_analyse" });
  const highlights = (parse(b.highlights) || []).filter((h) => h && typeof h === "object").slice(0, 6);
  const test = b.test === true || b.test === "true";

  try {
    const out = await maakRapporten({ analyse, highlights, infographic: b.infographic || null, insta, test });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error("[profielcheck-pdf]", e && e.message);
    return res.status(500).json({ ok: false, error: "pdf_mislukt" });
  }
};
