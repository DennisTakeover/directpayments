// A/B-test landingspagina: V2 (v2.html, groeicheck) vs V3 (v3.html, "bereken je maandprijs"), 50/50.
// - Nieuwe bezoeker krijgt willekeurig v2 of v3; cookie pv_lp2 onthoudt dat 30 dagen.
//   (Nieuwe cookienaam: bezoekers uit de vorige test V1 vs V2 worden opnieuw verdeeld.)
// - Handmatig forceren (testen): ?lp=v1, ?lp=v2 of ?lp=v3
// - De URL in de browser blijft "/"; de variant wordt server-side ge-rewrite.
// - V1 -> start.html, V2 -> start2.html, V3 -> start3.html.
// - Uitzetten: zet AB_SPLIT_V3 op 0 (iedereen V2) of 1 (iedereen V3).
import { next, rewrite } from "@vercel/edge";

export const config = { matcher: ["/", "/index.html"] };

const AB_SPLIT_V3 = 0.5; // aandeel bezoekers dat V3 ziet
const PAGES = { v2: "/v2.html", v3: "/v3.html" };

export default function middleware(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("lp");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)pv_lp2=(v2|v3)\b/);
  let variant;
  if (forced === "v1" || forced === "v2" || forced === "v3") variant = forced;
  else if (m) variant = m[1];
  else variant = Math.random() < AB_SPLIT_V3 ? "v3" : "v2";

  const headers = {
    "cache-control": "private, no-store",
    "x-pv-variant": variant,
  };
  // Alleen testvarianten in de cookie zetten; ?lp=v1 is om te bekijken.
  if (variant !== "v1") headers["set-cookie"] = `pv_lp2=${variant}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;

  if (PAGES[variant]) return rewrite(new URL(PAGES[variant] + url.search, url), { headers });
  return next({ headers });
}
