// A/B-test landingspagina: V1 (index.html) vs V2 (v2.html), 50/50.
// - Nieuwe bezoeker krijgt willekeurig v1 of v2; cookie pv_lp onthoudt dat 30 dagen.
// - Handmatig forceren (testen): ?lp=v1 of ?lp=v2
// - De URL in de browser blijft "/"; V2 wordt server-side ge-rewrite naar /v2.html.
// - V1 gaat naar start.html (betaalpagina 1), V2 naar start2.html (betaalpagina 2).
// - Uitzetten: zet AB_SPLIT_V2 op 0 (iedereen V1) of 1 (iedereen V2).
import { next, rewrite } from "@vercel/edge";

export const config = { matcher: ["/", "/index.html"] };

const AB_SPLIT_V2 = 0.5; // aandeel bezoekers dat V2 ziet

export default function middleware(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("lp");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)pv_lp=(v1|v2)\b/);
  let variant;
  if (forced === "v1" || forced === "v2") variant = forced;
  else if (m) variant = m[1];
  else variant = Math.random() < AB_SPLIT_V2 ? "v2" : "v1";

  const headers = {
    "set-cookie": `pv_lp=${variant}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    "cache-control": "private, no-store",
    "x-pv-variant": variant,
  };
  if (variant === "v2") return rewrite(new URL("/v2.html" + url.search, url), { headers });
  return next({ headers });
}
