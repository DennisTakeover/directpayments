// A/B-test landingspagina: V3 (v3.html, prijs na gegevens) vs V6 (v6.html, zelf een afspraak
// inplannen in de agenda), 50/50.
// - Nieuwe bezoeker krijgt willekeurig v3 of v6; cookie pv_lp6 onthoudt dat 30 dagen.
//   (Nieuwe cookienaam: bezoekers uit eerdere tests worden opnieuw verdeeld.)
// - Handmatig bekijken: ?lp=v1 t/m ?lp=v6. V4 en V5 doen niet meer mee aan de test.
// - De URL in de browser blijft "/"; de variant wordt server-side ge-rewrite.
// - V1 -> start.html, V2 -> start2.html, V3 -> start3.html, V4 -> start4.html, V5 -> start5.html, V6 -> start6.html (na het inplannen).
// - Uitzetten: zet AB_SPLIT_B op 0 (iedereen V3) of 1 (iedereen V6).
import { next, rewrite } from "@vercel/edge";

export const config = { matcher: ["/", "/index.html"] };

const A = "v3", B = "v6";
const AB_SPLIT_B = 0.5; // aandeel bezoekers dat variant B ziet
const PAGES = { v2: "/v2.html", v3: "/v3.html", v4: "/v4.html", v5: "/v5.html", v6: "/v6.html" };

export default function middleware(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("lp");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)pv_lp6=(v3|v6)\b/);
  let variant, isForced = false;
  if (forced === "v1" || PAGES[forced]) { variant = forced; isForced = true; }
  else if (m) variant = m[1];
  else variant = Math.random() < AB_SPLIT_B ? B : A;

  const headers = {
    "cache-control": "private, no-store",
    "x-pv-variant": variant,
  };
  // Alleen de testvarianten in de cookie zetten; ?lp=v1/v2 is alleen om te bekijken.
  if (variant === A || variant === B) headers["set-cookie"] = `pv_lp6=${variant}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;

  if (PAGES[variant]) return rewrite(new URL(PAGES[variant] + url.search, url), { headers });
  return next({ headers });
}
