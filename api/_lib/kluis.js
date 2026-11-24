// Versleuteling van Instagram-inloggegevens uit de koppelpagina (www.promo-view.io/onboarding-v2).
// AES-256-GCM met een sleutel die alleen in Vercel staat (KOPPEL_KEY, 32 bytes base64).
// Het resultaat (een token) mag overal staan, bijv. in een Trello-link: zonder de sleutel
// én de teamcode (KOPPEL_TEAM_CODE) is het onleesbaar. Wachtwoorden komen nooit in Slack,
// Trello, PostHog of de logs.
const crypto = require("crypto");

// KOPPEL_KEY: een lange willekeurige tekst (minstens 32 tekens, bijv. uit een wachtwoordgenerator).
// Wordt met SHA-256 omgezet naar een sleutel van 256 bits. Niet meer wijzigen zodra er koppelingen
// binnen zijn: oude links zijn daarna niet meer te openen.
function key() {
  const raw = process.env.KOPPEL_KEY || "";
  if (raw.length < 32) throw new Error("koppel_key_missing");
  return crypto.createHash("sha256").update(raw).digest();
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

function open(token) {
  const buf = Buffer.from(String(token || ""), "base64url");
  if (buf.length < 29) throw new Error("bad_token");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

function codeOk(given) {
  const want = process.env.KOPPEL_TEAM_CODE || "";
  if (!want || !given) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { seal, open, codeOk };
