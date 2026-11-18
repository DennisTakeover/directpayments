// Landingspagina: iedereen ziet V7 (v7.html): PromoView 14 dagen testen voor €49,
// daarna €190 per maand. Na een korte check (3 vragen) direct naar Stripe.
// - De URL in de browser blijft "/"; de variant wordt server-side ge-rewrite.
// - Handmatig een oudere versie bekijken: ?lp=v1 t/m ?lp=v8 (telt niet mee).
// - Terug naar een A/B-test: zet B op een variant en AB_SPLIT_B op bijv. 0.5;
//   de cookie pv_lp8 onthoudt dan wie wat zag.
import { next, rewrite } from "@vercel/edge";

export const config = { matcher: ["/", "/index.html"] };

const A = "v7", B = null;
const AB_SPLIT_B = 0; // aandeel bezoekers dat variant B ziet (0 = iedereen A)
const PAGES = { v2: "/v2.html", v3: "/v3.html", v4: "/v4.html", v5: "/v5.html", v6: "/v6.html", v7: "/v7.html", v8: "/v8.html" };

export default function middleware(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("lp");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)pv_lp8=(v\d)\b/);
  let variant, isForced = false;
  if (forced === "v1" || PAGES[forced]) { variant = forced; isForced = true; }
  else if (B && m && (m[1] === A || m[1] === B)) variant = m[1];
  else variant = B && Math.random() < AB_SPLIT_B ? B : A;

  const headers = {
    "cache-control": "private, no-store",
    "x-pv-variant": variant,
  };
  if (B && !isForced) headers["set-cookie"] = `pv_lp8=${variant}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;

  if (PAGES[variant]) return rewrite(new URL(PAGES[variant] + url.search, url), { headers });
  return next({ headers });
}
