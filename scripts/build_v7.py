"""Bouwt v7.html (en v8.html) uit v5.html: PromoView 14 dagen testen voor €49.

Gebruik: wijzig v5.html (de bron), draai dan vanuit de repo-map:
    python3 scripts/build_v7.py .
v7.html is de live landingspagina (/). v5.html en v8.html zijn niet meer bereikbaar
(doorverwezen naar /), v5.html blijft alleen als bron voor deze build.

V7 'doorlopend': €49 voor 14 dagen, daarna automatisch €190 per maand tenzij je vóór dag 14 opzegt.
V8 'eenmalig'  : €49 eenmalig voor 14 dagen, daarna stopt het en bellen we je; jij kiest of je doorgaat.

Na de drie korte vragen gaat de bezoeker direct naar Stripe (via /api/checkout-test).
Elke vervanging controleert het verwachte aantal treffers.
"""
import re
import sys

REPO = sys.argv[1]


def rep(s, old, new, n=1, name=""):
    c = s.count(old)
    if c != n:
        raise SystemExit(f"{name}: verwacht {n}x, gevonden {c}x: {old[:100]!r}")
    return s.replace(old, new)


def between(s, start, end, new, name):
    """Vervangt het blok dat met `start` begint t/m het eerste `end` erna."""
    if s.count(start) != 1:
        raise SystemExit(f"{name}: begin {s.count(start)}x gevonden: {start[:70]!r}")
    i = s.find(start)
    j = s.find(end, i)
    if j < 0:
        raise SystemExit(f"{name}: einde niet gevonden")
    return s[:i] + new + s[j + len(end):]


CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'

VARIANTS = {
    "v7": dict(
        plan="doorlopend",
        native=True,
        page_version="v7.3-paypro",
        sub2="Binnen 48 uur live. Bevalt het, dan loopt het daarna door voor €190 per maand. Zeg je vóór dag 14 op, dan betaal je niets meer.",
        card_foot='<span>✓ Opzeggen vóór dag 14 = niets meer betalen</span><span>✓ Betalen met iDEAL | Wero</span><span>✓ Live binnen 48 uur</span>',
        offer_note="Daarna €190 per maand excl. btw, elke maand opzegbaar. Zeg je vóór dag 14 op? Eén bericht naar je contactpersoon en je betaalt niets meer.",
        risk_row='<span>✓ Opzeggen vóór dag 14 kan altijd</span><span>✓ Daarna elke maand opzegbaar</span><span>✓ Geen setupkosten</span>',
        g2_badge='<b>1</b><span>bericht</span>',
        g2_h3="Opzeggen vóór dag 14? Dan betaal je niets meer",
        g2_p="Bevalt het niet, stuur dan vóór dag 14 één bericht naar je contactpersoon. Dan stopt het en betaal je niets meer. Ga je door, dan is het €190 per maand en ook daarna elke maand opzegbaar.",
        faq_a="<strong>Dan loopt het door voor €190 per maand excl. btw.</strong> Wil je niet door? Stuur vóór dag 14 één bericht naar je contactpersoon, dan stopt het en betaal je niets meer. Ga je door, dan is het daarna elke maand opzegbaar.",
        chat_price="Je test PromoView 14 dagen voor €49 (incl. btw), met een gratis profielcheck en bio- en highlightoptimalisatie. Daarna loopt het door voor €190 per maand excl. btw, tenzij je vóór dag 14 opzegt.",
        chat_guar="Je test 14 dagen voor €49. Zeg je vóór dag 14 op, dan betaal je niets meer. Eén berichtje naar je contactpersoon is genoeg.",
        final_small="Daarna €190 per maand · elke maand opzegbaar · opzeggen vóór dag 14 kan altijd",
        modal_risk="🔒 Veilig betalen met iDEAL | Wero of Bancontact · opzeggen vóór dag 14 kan altijd",
        sticky_note="€49 ·<br>14 dagen",
    ),
    "v8": dict(
        plan="eenmalig",
        page_version="v8.1-test49-eenmalig",
        sub2="Binnen 48 uur live. Na 14 dagen stopt het vanzelf: we bellen je om je resultaten door te nemen en jij beslist of je doorgaat.",
        card_foot='<span>✓ Eenmalig €49, geen abonnement</span><span>✓ Veilig betalen via Stripe</span><span>✓ Live binnen 48 uur</span>',
        offer_note="Geen abonnement: na 14 dagen stopt je test vanzelf. We bellen je om je resultaten door te nemen en jij beslist of je doorgaat voor €190 per maand.",
        risk_row='<span>✓ Eenmalig €49</span><span>✓ Stopt vanzelf na 14 dagen</span><span>✓ Geen setupkosten</span>',
        g2_badge='<b>€0</b><span>daarna</span>',
        g2_h3="Stopt vanzelf na 14 dagen",
        g2_p="Geen abonnement en niets om op te zeggen. Na je test bellen we je om je resultaten door te nemen. Wil je door, dan is het €190 per maand en elke maand opzegbaar.",
        faq_a="<strong>Dan stopt je test vanzelf.</strong> Je zit nergens aan vast en hoeft niets op te zeggen. We bellen je om je resultaten door te nemen. Wil je door, dan is het €190 per maand excl. btw en elke maand opzegbaar.",
        chat_price="Je test PromoView 14 dagen voor eenmalig €49 (incl. btw), met een gratis profielcheck en bio- en highlightoptimalisatie. Daarna stopt het vanzelf. Wil je door, dan is het €190 per maand excl. btw.",
        chat_guar="Je test 14 dagen voor eenmalig €49. Daarna stopt het vanzelf, je zit nergens aan vast. We bellen je om je resultaten door te nemen.",
        final_small="Eenmalig €49 · geen abonnement · stopt vanzelf na 14 dagen",
        modal_risk="🔒 Veilig betalen via Stripe · eenmalig €49, geen abonnement",
        sticky_note="€49 ·<br>eenmalig",
    ),
}

CARD_GETS = ('<div class="pv-check-gets"><span>In 14 dagen krijg je:</span><ul>'
             '<li>✓ Het complete groeisysteem, live binnen 48 uur</li>'
             '<li>✓ <b>Gratis</b> profielcheck door een marketing- en contentspecialist</li>'
             '<li>✓ <b>Gratis</b> bio- en highlightoptimalisatie</li></ul></div>')
OLD_CARD_GETS = ('<div class="pv-check-gets"><span>In 15 minuten hoor je:</span><ul>'
                 '<li>✓ De 3 belangrijkste verbeterpunten voor jouw profiel</li>'
                 '<li>✓ Wie jouw doelgroep op Instagram is en hoe je die bereikt</li>'
                 '<li>✓ Wat je realistisch kunt verwachten aan groei</li></ul></div>')

CSS = (
    '<style>'
    '.pv-price-tag{display:inline-flex;align-items:baseline;gap:8px;margin:2px auto 14px;padding:8px 16px;border-radius:999px;background:#FFF1F4;border:1.5px solid rgba(222,47,85,.35);font-weight:700;color:#14121A}'
    '.pv-price-tag b{font-size:22px;color:#DE2F55;letter-spacing:-.01em}.pv-price-tag s{color:#807889;font-weight:600}.pv-price-tag small{font-size:13px;color:#585161;font-weight:600}'
    '.pv-offer li.pv-free{background:#F2FBF5;margin:0 -10px;padding-left:10px;padding-right:10px;border-radius:10px}'
    '.pv-offer li.pv-free span b{display:block;font-size:15px}.pv-offer li.pv-free span small{display:block;font-size:13px;color:#585161;font-weight:500;line-height:1.4}'
    '.pv-offer-sep{font-size:12.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#807889;margin:14px 0 2px}'
    '.pv-test-note{margin:12px 0 16px;padding:12px 14px;border:1.5px dashed rgba(222,47,85,.45);border-radius:12px;background:#FFF7F9;font-size:14px;line-height:1.5;color:#3d3746;text-align:left}'
    '.pv-cancel-bar{position:sticky;top:0;z-index:60;background:#14121A;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;font-size:14.5px;text-align:center}'
    '.pv-cancel-bar button{background:#DE2F55;color:#fff;border:0;border-radius:10px;padding:9px 14px;font:inherit;font-weight:800;cursor:pointer}'
    '.pv-fallback{text-align:center;padding:8px 2px 4px}.pv-fallback h3{margin-bottom:8px}.pv-fallback p{color:#585161;margin:0 0 14px}'
    '.pv-fallback a{display:inline-block;margin-top:4px;font-weight:700;color:#DE2F55}'
    '.pv-hero-under{margin:-12px 0 20px;font-size:13.5px;color:#585161;text-align:center}'
    '.pv-stars{color:#00B67A;letter-spacing:1px;font-size:15px}'
    '.pv-trust-wrap{text-align:center;margin:4px 0 20px}'
    '.pv-stats-low{margin-top:6px}'
    '.pv-trust{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:#14121A;font-size:14px;text-align:left;padding:8px 14px 8px 10px;border-radius:999px;background:#fff;border:1px solid #E5E0EA;box-shadow:0 6px 18px rgba(26,22,32,.06)}'
    '.pv-trust-avs{display:flex;flex:none}.pv-trust-avs img{width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid #fff;margin-left:-9px;background:#F3EEF6}.pv-trust-avs img:first-child{margin-left:0}'
    '.pv-trust-txt{line-height:1.3}.pv-trust-txt small{display:block;color:#585161;font-size:12.5px}'
    '.pv-quote{max-width:560px;margin:22px auto 0;background:#fff;border:1px solid #E5E0EA;border-radius:16px;padding:16px 18px;text-align:left;box-shadow:0 10px 30px rgba(26,22,32,.06)}'
    '.pv-quote blockquote{margin:6px 0 12px;font-size:15.5px;line-height:1.5;color:#14121A;font-weight:600}'
    '.pv-quote figcaption{display:flex;gap:10px;align-items:center}.pv-quote figcaption img{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#F3EEF6}'
    '.pv-quote figcaption b{display:block;font-size:14px}.pv-quote figcaption small{color:#585161;font-size:12.5px}.pv-quote figcaption a{color:#585161}'
    '.am-final .pv-quote{margin:18px auto 22px}'
    '.pv-res-trust{margin:12px 0 0;font-size:13px;color:#585161}.pv-res-trust b{color:#14121A}'
    '.pv-res-quote{margin:8px 0 0;padding:10px 12px;background:#F7F5F9;border-radius:10px;font-size:13.5px;line-height:1.45;text-align:left;color:#3d3746}.pv-res-quote b{color:#14121A;font-weight:700}'
    '.pv-res{text-align:center}.pv-res h3{margin:8px 0 10px}.pv-res .qz-sub{margin:0 0 12px}'
    '.pv-res-ico{width:56px;height:56px;border-radius:50%;margin:0 auto 6px;display:grid;place-items:center;background:#15A34A;color:#fff;font-size:28px;font-weight:800;box-shadow:0 8px 24px rgba(21,163,74,.3)}'
    '.pv-res-ico-no{background:#EEF8F1;box-shadow:none;font-size:30px}'
    '.pv-res-list{list-style:none;margin:0 0 12px;padding:12px 14px;text-align:left;background:#F2FBF5;border-radius:12px;display:grid;gap:6px;font-size:14.5px;font-weight:600}'
    '.pv-res-price{display:flex;justify-content:space-between;align-items:baseline;padding:4px 2px;font-weight:700}.pv-res-price b{font-size:26px}.pv-res-price small{font-size:13px;color:#585161;font-weight:600}'
    '.pv-res-note{font-size:13px;color:#585161;text-align:left;margin:4px 0 12px;line-height:1.45}'
    '.pv-sum{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 14px;margin:6px 0 14px;background:#F2FBF5;border-radius:12px;text-align:left}'
    '.pv-sum b{display:block;font-size:15px}.pv-sum small{display:block;font-size:12.5px;color:#585161;line-height:1.35}.pv-sum-p{text-align:right;flex:none}.pv-sum-p b{font-size:22px}'
    '#pvPayForm{text-align:left}.pv-fld{margin:0 0 10px}.pv-fld label{display:block;font-size:13.5px;font-weight:700;margin:0 0 4px;color:#14121A}.pv-fld label span{font-weight:500;color:#585161}'
    '.pv-fld input{width:100%;font:inherit;font-size:16px;padding:12px 13px;border:1.5px solid #D9D3DF;border-radius:10px;background:#fff;color:#14121A}'
    '.pv-fld input:focus{outline:none;border-color:#DE2F55;box-shadow:0 0 0 3px rgba(222,47,85,.15)}'
    '.pv-at{display:flex;align-items:center;border:1.5px solid #D9D3DF;border-radius:10px;background:#fff}.pv-at span{padding:0 0 0 13px;color:#807889;font-weight:700}.pv-at input{border:0;padding-left:4px}.pv-at:focus-within{border-color:#DE2F55;box-shadow:0 0 0 3px rgba(222,47,85,.15)}.pv-at input:focus{box-shadow:none}'
    '.pv-fe{display:none;color:#9b1c3a;font-size:12.5px;margin-top:4px}.pv-fld.bad .pv-fe{display:block}.pv-fld.bad input,.pv-fld.bad .pv-at{border-color:#D23B5C}'
    '.pv-land{display:flex;gap:8px;margin:2px 0 14px}.pv-land button{flex:1;font:inherit;font-size:14px;font-weight:700;padding:9px 8px;border-radius:10px;border:1.5px solid #D9D3DF;background:#fff;color:#14121A;cursor:pointer}.pv-land button.on{border-color:#DE2F55;background:#FFF1F4}'
    '.pv-pe{min-height:120px;margin:0 0 12px}.pv-pe-load{color:#807889;font-size:14px;text-align:center;padding:30px 0}'
    '.pv-pm-h{font-size:13.5px;font-weight:700;margin:2px 0 6px;color:#14121A}'
    '.pv-pm{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}.pv-pm button{font:inherit;text-align:left;padding:11px 12px;border-radius:12px;border:1.5px solid #D9D3DF;background:#fff;color:#14121A;cursor:pointer}'
    '.pv-pm button{display:flex;align-items:center;gap:10px;min-width:0}.pv-pm button img{flex:none;width:40px;height:30px;border-radius:5px}.pv-pm button span{min-width:0}'
    '.pv-pm button b{white-space:nowrap}.pv-pm button::after{content:"";margin-left:auto;flex:none;width:18px;height:18px;border-radius:50%;border:2px solid #D9D3DF;box-sizing:border-box}.pv-pm button.on::after{border:6px solid #DE2F55}'
    '@media(max-width:480px){.pv-pm{grid-template-columns:1fr}.pv-pm button{padding:10px 12px}}'
    '.pv-pm button b{display:block;font-size:15px}.pv-pm button small{display:block;font-size:12px;color:#585161;margin-top:2px}.pv-pm button.on{border-color:#DE2F55;background:#FFF1F4;box-shadow:0 0 0 3px rgba(222,47,85,.12)}'
    '.pv-secure a{color:#585161}'
    '#pvPaySubmit{width:100%;margin-top:4px}#pvPaySubmit:disabled{opacity:.6;cursor:wait}'
    '.pv-terms{font-size:12.5px;color:#585161;line-height:1.45;margin:10px 0 8px}'
    '.pv-secure{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12.5px;color:#585161;font-weight:600}'
    '#pvPayForm .pv-res-trust{text-align:center}'
    '.pv-pay-err{margin:10px 0 0;padding:10px 12px;border-radius:10px;background:#FFF1F4;color:#9b1c3a;font-size:14px}.pv-pay-err a{color:#9b1c3a;font-weight:700}'
    '</style>'
)

TP_URL = "https://www.trustpilot.com/review/promo-view.io"
IMG = "https://framerusercontent.com/images/"
# Echte reviews van Trustpilot (staan al op de site in PV_SITE_REVIEWS).
REVIEWS = {
    "novio": ("Noviofit.pt", IMG + "BmDeKPkh3UUvP0UYc0NG2CPyvw.jpg", "Fitnessclub",
              "Door Promoview zijn we van 850 naar 3200 volgers gegaan in een tijdsbestek van 3 maanden. Ik heb hier tientallen nieuwe klanten uitgehaald."),
    "lure": ("lureparts.nl", IMG + "NBGfQ8nKnyh1HTQUyBY6XBA2xzQ.png", "Webshop",
             "Was eerst wat sceptisch, maar het heeft nu wel echt toegevoegde waarde. In een maand tijd plusminus 700 volgers erbij."),
    "rachel": ("Rachel_spier", IMG + "o98uA5vBAmLxqDHej15SycGnITs.jpg", "Trustpilot-review",
               "Kundigheid en expertise maakte onze samenwerking tot een succes. Mijn volgers gingen van 120 naar 402 na 1 maand."),
    "sven": ("Svenschilten", IMG + "RGoKhny5mxBlx8knAcgjmbHep8Y.jpg", "Trustpilot-review", ""),
    "jordy": ("Jordy.schilten", IMG + "uSJQoWKl3kc7u4Pe6KYK1Ug3HYU.jpg", "bol.com-cursussen", ""),
}
STARS = '<span class="pv-stars" aria-label="5 sterren">★★★★★</span>'


def quote(key, src):
    name, img, role, text = REVIEWS[key]
    return (f'<figure class="pv-quote">{STARS}<blockquote>“{text}”</blockquote>'
            f'<figcaption><img src="{img}" alt="" loading="lazy" width="36" height="36"><span><b>@{name}</b><small>{role} · '
            f'<a href="{TP_URL}" target="_blank" rel="noopener" onclick=\'track("trustpilot_click",{{source:"{src}"}})\'>Trustpilot</a></small></span></figcaption></figure>')


TRUST_STRIP = (
    f'<div class="pv-trust-wrap"><a class="pv-trust" href="{TP_URL}" target="_blank" rel="noopener" onclick=\'track("trustpilot_click",{{source:"hero_strip"}})\'>'
    '<span class="pv-trust-avs">' + "".join(f'<img src="{REVIEWS[k][1]}" alt="" loading="lazy" width="32" height="32">' for k in ("novio", "rachel", "sven", "jordy")) + '</span>'
    f'<span class="pv-trust-txt">{STARS} <b>4,8</b> op Trustpilot · 114 reviews<small>1.500+ ondernemers gingen je voor</small></span></a></div>'
)


# ── Klantvideo's in de hero: één grote speler met pijltjes; na afloop start de volgende ──
HERO_VIDEOS = [
    ("203hiq923r", "Horeca", "Café de Muurbloem", "Van Instagram-volger naar gast aan de bar.", 290, "49d06f537a9320caf269be9981d33b7a35c802e2"),
    ("tl7c2g7l8g", "Coach", "Maud van der Meer", "Elke nieuwe volger begon een gesprek.", 334, "d57747fa46d82995f60461dbd0d35baeab45abe7"),
    ("i931wdmjlb", "Kledingwinkel", "Us Hoekje", "'s Morgens gepost, 's middags stonden ze in de winkel.", 195, "7b71dea87d4d19d34e0aa18423455a66e64e1f50"),
    ("3yybqmwrpw", "Hovenier", "De Bevlogen Tuincoach", "Mijn DM's ontploften.", 257, "6769add8d2cac5533bc37de7931e1b1271ad2cc4"),
    ("9l0iz2lszo", "Sport", "Padeltrainer Bob", "Ik krijg boekingen en lokale bekendheid.", 262, "eee73581e7857178b770ef810fbbd36174542754"),
    ("6wkajknszc", "Fotograaf", "Jaap Vliegenthart", "Je maakt een soort custom plan voor mijn branche.", 157, "864056218a7b3e0ace90e4d8581e1c144ad7a996"),
    ("i51jnuxo4x", "Coach", "Borntolove.be", "Twee retreat-deelnemers vonden haar via een simpele follow.", 286, "4a7091d0cec1a77c87f83c27bcc1137dd0c0a93c"),
    ("e5shed6837", "Sieradenmerk", "Stenn Jewelry", "Promoview geeft kwalitatief resultaat.", 508, "e3975ade042aadc9c5c2afb8208e9d75a8896b5f"),
]


def _hero_video():
    import json as _json
    thumb = lambda h: f"https://embed-ssl.wistia.com/deliveries/{h}.jpg?image_crop_resized=720x720"
    data = [{"id": v[0], "tag": v[1], "name": v[2], "quote": v[3], "dur": f"{v[4] // 60}:{v[4] % 60:02d}", "thumb": thumb(v[5])} for v in HERO_VIDEOS]
    first = data[0]
    dots = "".join(f'<button type="button" class="pv-hv-dot{" on" if i == 0 else ""}" data-i="{i}" aria-label="Video {i + 1}: {d["name"]}"></button>' for i, d in enumerate(data))
    arrow = lambda d: f'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="{d}"/></svg>'
    css = (
        '<style>'
        '.pv-hv{position:relative;width:min(100%,500px);margin:22px auto 6px;text-align:left}'
        '.pv-hv-stage{position:relative;aspect-ratio:1/1;border-radius:20px;overflow:hidden;background:#14121A;'
        'box-shadow:0 18px 50px rgba(20,18,26,.22),0 0 0 1px rgba(20,18,26,.06)}'
        '.pv-hv-stage .wistia_embed,.pv-hv-stage iframe{position:absolute;inset:0;width:100%!important;height:100%!important}'
        '.pv-hv-poster{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;cursor:pointer;background:#14121A;display:block}'
        '.pv-hv-poster img{width:100%;height:100%;object-fit:cover;display:block}'
        '.pv-hv-poster::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(20,18,26,0) 55%,rgba(20,18,26,.55))}'
        '.pv-hv-play{position:absolute;left:50%;top:50%;width:78px;height:78px;margin:-39px 0 0 -39px;border-radius:50%;'
        'background:#DE2F55;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(222,47,85,.45);z-index:1;transition:transform .2s}'
        '.pv-hv-poster:hover .pv-hv-play{transform:scale(1.06)}'
        '.pv-hv-play svg{width:34px;height:34px;fill:#fff;margin-left:4px}'
        '.pv-hv-meta{position:absolute;left:14px;bottom:12px;right:14px;z-index:1;display:flex;justify-content:space-between;align-items:center;color:#fff;font-size:13px;font-weight:600}'
        '.pv-hv-meta span{background:rgba(20,18,26,.55);padding:4px 9px;border-radius:999px}'
        '.pv-hv-nav{position:absolute;top:calc(50% - 22px);z-index:3;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;'
        'background:#fff;color:#14121A;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(20,18,26,.22)}'
        '.pv-hv-nav svg{width:24px;height:24px;fill:currentColor}'
        '.pv-hv-nav:focus-visible,.pv-hv-dot:focus-visible,.pv-hv-poster:focus-visible{outline:3px solid #DE2F55;outline-offset:2px}'
        '.pv-hv-prev{left:-22px}.pv-hv-next{right:-22px}'
        '@media(max-width:600px){.pv-hv-prev{left:8px}.pv-hv-next{right:8px}.pv-hv-nav{width:40px;height:40px;top:calc(50% - 20px)}}'
        '.pv-hv-cap{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:12px}'
        '.pv-hv-cap b{display:block;font-size:16px;color:#14121A}'
        '.pv-hv-cap q{display:block;font-size:14px;color:#585161;margin-top:2px;quotes:"\\201C" "\\201D"}'
        '.pv-hv-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#DE2F55;margin-bottom:2px}'
        '.pv-hv-count{flex:none;font-size:13px;font-weight:700;color:#585161;padding-top:2px}'
        '.pv-hv-dots{display:flex;justify-content:center;gap:6px;margin-top:10px}'
        '.pv-hv-dot{width:8px;height:8px;padding:0;border:0;border-radius:999px;background:#D9D3DF;cursor:pointer;transition:width .2s,background .2s}'
        '.pv-hv-dot.on{width:22px;background:#DE2F55}'
        '.pv-hv-auto{text-align:center;font-size:12.5px;color:#585161;margin:6px 0 0}'
        '</style>'
    )
    html = (
        '<div class="pv-hv" id="pvHv" role="region" aria-roledescription="carrousel" aria-label="Klantvideo\'s">'
        '<div class="pv-hv-stage" id="pvHvStage">'
        f'<button type="button" class="pv-hv-poster" id="pvHvPoster" aria-label="Speel video af: {first["name"]}">'
        f'<img id="pvHvImg" src="{first["thumb"]}" alt="" width="500" height="500" fetchpriority="high">'
        '<span class="pv-hv-play">' + arrow("M8 5v14l11-7z") + '</span>'
        f'<span class="pv-hv-meta"><span>Klantverhaal</span><span id="pvHvDur">{first["dur"]}</span></span></button></div>'
        '<button type="button" class="pv-hv-nav pv-hv-prev" id="pvHvPrev" aria-label="Vorige video">' + arrow("M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z") + '</button>'
        '<button type="button" class="pv-hv-nav pv-hv-next" id="pvHvNext" aria-label="Volgende video">' + arrow("M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z") + '</button>'
        f'<div class="pv-hv-cap" aria-live="polite"><div><span class="pv-hv-tag" id="pvHvTag">{first["tag"]}</span>'
        f'<b id="pvHvName">{first["name"]}</b><q id="pvHvQuote">{first["quote"]}</q></div>'
        f'<span class="pv-hv-count" id="pvHvCount">1 / {len(data)}</span></div>'
        f'<div class="pv-hv-dots" id="pvHvDots">{dots}</div>'
        '<p class="pv-hv-auto">Na elke video start automatisch de volgende klant.</p></div>'
    )
    js = (
        '<script>(function(){'
        'var V=' + _json.dumps(data, ensure_ascii=False) + ';'
        'var $=function(id){return document.getElementById(id)},stage=$("pvHvStage"),i=0,playing=false,api=false,gen=0;if(!stage)return;'
        'function t(e,p){try{window.track&&track(e,p)}catch(_){}}'
        'function caption(){var v=V[i];$("pvHvTag").textContent=v.tag;$("pvHvName").textContent=v.name;$("pvHvQuote").textContent=v.quote;'
        '$("pvHvCount").textContent=(i+1)+" / "+V.length;[].forEach.call(document.querySelectorAll(".pv-hv-dot"),function(d,k){d.classList.toggle("on",k===i)})}'
        'function poster(){var v=V[i];stage.innerHTML=\'<button type="button" class="pv-hv-poster" id="pvHvPoster" aria-label="Speel video af: \'+v.name+\'">\''
        '+\'<img src="\'+v.thumb+\'" alt="" width="500" height="500"><span class="pv-hv-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>\''
        '+\'<span class="pv-hv-meta"><span>Klantverhaal</span><span>\'+v.dur+\'</span></span></button>\';$("pvHvPoster").onclick=function(){play("klik")}}'
        'function loadApi(){if(api)return;api=true;window._wq=window._wq||[];var s=document.createElement("script");s.src="https://fast.wistia.com/assets/external/E-v1.js";s.async=true;document.head.appendChild(s)}'
        'function play(how){var v=V[i],my=++gen;playing=true;loadApi();'
        'stage.innerHTML=\'<div class="wistia_embed wistia_async_\'+v.id+\' autoPlay=true playerColor=DE2F55 videoFoam=false" style="height:100%;width:100%">&nbsp;</div>\';'
        'window._wq.push({id:v.id,onReady:function(video){if(my!==gen)return;try{video.play()}catch(_){}'
        'video.bind("end",function(){if(my===gen){t("hero_video_ended",{video:v.name,index:i});go(i+1,"auto")}return video.unbind})}});'
        't("video_play",{video:v.name,video_id:v.id,source:"hero",index:i,how:how});if(how!=="auto")t("vsl_started",{video:v.name,video_id:v.id,is_primary_vsl:i===0,source:"hero"})}'
        'function go(n,how){gen++;i=(n+V.length)%V.length;caption();if(playing)play(how);else poster();if(how!=="auto")t("hero_video_nav",{to:i,video:V[i].name,how:how})}'
        '$("pvHvPrev").onclick=function(){go(i-1,"pijl")};$("pvHvNext").onclick=function(){go(i+1,"pijl")};'
        '[].forEach.call(document.querySelectorAll(".pv-hv-dot"),function(d){d.onclick=function(){go(+d.dataset.i,"bolletje")}});'
        '$("pvHvPoster").onclick=function(){play("klik")};'
        '$("pvHv").addEventListener("keydown",function(e){if(e.key==="ArrowRight"){go(i+1,"toets")}else if(e.key==="ArrowLeft"){go(i-1,"toets")}});'
        'var x0=null;stage.addEventListener("touchstart",function(e){x0=e.touches[0].clientX},{passive:true});'
        'stage.addEventListener("touchend",function(e){if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;x0=null;if(Math.abs(dx)>45)go(i+(dx<0?1:-1),"swipe")},{passive:true});'
        '})();</script>'
    )
    return css + html + js


HERO_VIDEO = _hero_video()

def opt(v, ico, label=None):
    return f'<button type="button" class="opt" data-v="{v}"><span class="ico">{ico}</span>{label or v}<span class="chev">›</span></button> '


def quiz_steps(cfg):
    """Vraag 2 en 3 van de check, plus het resultaat. Vervangt de Instagram- en contactstap van V5."""
    return (
        '<div class="qz-step" data-q="leeftijd" hidden><h3>Bestaat je Instagram-account langer dan 3 maanden?</h3>'
        '<p class="qz-sub">Twijfel je? Op je profiel zie je het onder “Over dit account”.</p><div class="opts">'
        + opt("Ja", "✅", "Ja, langer dan 3 maanden") + opt("Nee", "🌱", "Nee, korter dan 3 maanden") +
        '</div></div>'
        '<div class="qz-step" data-q="doel" hidden><h3>Wat wil je vooral bereiken met Instagram?</h3><div class="opts">'
        + opt("Meer klanten en aanvragen", "📈") + opt("Meer bekendheid in mijn regio", "📍")
        + opt("Meer verkoop in mijn webshop", "🛒") + opt("Een sterker personal brand", "🎯") +
        '</div></div>'
        '<div class="qz-step" data-q="resultaat" hidden>'
        '<div class="pv-res" id="pvResOk" hidden><div class="pv-res-ico">✓</div>'
        '<h3>Goed nieuws: je komt in aanmerking!</h3>'
        '<p class="qz-sub" id="pvResWhy">Je account is oud genoeg. Je kunt vandaag nog starten.</p>'
        '<ul class="pv-res-list"><li>✓ 14 dagen het complete groeisysteem, live binnen 48 uur</li>'
        '<li>✓ <b>Gratis</b> profielcheck door een marketing- en contentspecialist</li>'
        '<li>✓ <b>Gratis</b> bio- en highlightoptimalisatie</li></ul>'
        '<div class="pv-res-price"><span>14 dagen testen</span><b>€49 <small>incl. btw</small></b></div>'
        f'<p class="pv-res-note">{cfg["offer_note"]}</p>'
        '<button type="button" class="btn" id="pvPayBtn">Start mijn test voor €49 <span class="arrow">→</span></button>'
        '<p class="pv-pay-err" id="pvPayErr" hidden></p>'
        f'<p class="modal-risk">{cfg["modal_risk"]}</p>'
        f'<div class="pv-res-trust">{STARS} <b>4,8</b> op Trustpilot · 114 reviews · 1.500+ ondernemers</div>'
        f'<p class="pv-res-quote">“{REVIEWS["lure"][3]}” <b>@{REVIEWS["lure"][0]}</b></p></div>'
        '<div class="pv-res" id="pvResNo" hidden><div class="pv-res-ico pv-res-ico-no">🌱</div>'
        '<h3>Je account is nog te jong</h3>'
        '<p class="qz-sub">Bij accounts die korter dan 3 maanden bestaan, werkt ons systeem nog niet goed genoeg. Daarom laten we je nu niet betalen.</p>'
        '<p class="qz-sub">Kom terug zodra je account 3 maanden bestaat. Vragen? <a href="https://wa.me/31685888134" target="_blank" rel="noopener">Stuur ons een WhatsApp</a>.</p></div>'
        # Het oude script verwacht dit formulier; het blijft leeg en onzichtbaar.
        '<form id="leadForm" novalidate hidden></form></div>'
        + (PAY_STEP if cfg.get("native") else "")
    )


# De eigen betaalstap (alleen V7): gegevens + keuze betaalmethode, daarna direct naar iDEAL/Bancontact via PayPro.
PAY_STEP = (
    '<div class="qz-step" data-q="betalen" hidden>'
    '<h3>Start je test van 14 dagen</h3>'
    '<div class="pv-sum"><div><b>PromoView 14 dagen testen</b><small>Groeisysteem + gratis profielcheck en bio-optimalisatie</small></div>'
    '<div class="pv-sum-p"><b>€49</b><small>incl. btw</small></div></div>'
    '<form id="pvPayForm" novalidate>'
    '<div class="pv-fld" data-f="name"><label for="pfNaam">Voor- en achternaam</label><input id="pfNaam" autocomplete="name" required><small class="pv-fe">Vul je naam in.</small></div>'
    '<div class="pv-fld" data-f="email"><label for="pfEmail">E-mailadres</label><input id="pfEmail" type="email" autocomplete="email" inputmode="email" required><small class="pv-fe">Vul een geldig e-mailadres in.</small></div>'
    '<div class="pv-fld" data-f="phone"><label for="pfTel">Telefoonnummer <span>(voor WhatsApp)</span></label><input id="pfTel" type="tel" autocomplete="tel" inputmode="tel" placeholder="06 12345678" required><small class="pv-fe">Vul een geldig nummer in, bijvoorbeeld 06 12345678.</small></div>'
    '<div class="pv-fld" data-f="insta"><label for="pfInsta">Instagram-gebruikersnaam</label><div class="pv-at"><span>@</span><input id="pfInsta" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="jouwbedrijf" required></div><small class="pv-fe">Vul je Instagram-naam in, zonder spaties.</small></div>'
    '<div class="pv-land" aria-label="Land"><button type="button" class="on" data-c="NL" aria-pressed="true">🇳🇱 Nederland</button><button type="button" data-c="BE" aria-pressed="false">🇧🇪 België</button></div>'
    '<p class="pv-pm-h">Betalen met</p>'
    '<div class="pv-pm" role="radiogroup" aria-label="Betaalmethode">'
    '<button type="button" class="on" data-m="ideal" role="radio" aria-checked="true"><img src="assets/pay/ideal-wero.svg" alt="" width="40" height="30"><span><b>iDEAL | Wero</b><small>Via je bank-app</small></span></button>'
    '<button type="button" data-m="bancontact" role="radio" aria-checked="false"><img src="assets/pay/bancontact.svg" alt="" width="40" height="30"><span><b>Bancontact</b><small>Belgische banken</small></span></button>'
    '</div>'
    '<p class="pv-pay-err" id="pvPayErr2" role="alert" hidden></p>'
    '<button type="submit" class="btn" id="pvPaySubmit">🔒 Betaal €49 met iDEAL</button>'
    '<p class="pv-terms">Vandaag betaal je €49 (incl. btw) voor 14 dagen. Daarna loopt het door voor €229,90 per maand (€190 + btw) via automatische incasso, tenzij je vóór dag 14 opzegt. Daarna is het elke maand opzegbaar.</p>'
    '<div class="pv-secure"><span>🔒 Veilig betalen via PayPro</span><a href="#" id="pvCard">Liever met creditcard?</a></div>'
    f'<div class="pv-res-trust">{STARS} <b>4,8</b> op Trustpilot · 114 reviews</div>'
    '</form></div>'
)


# Na de check: wie in aanmerking komt, gaat met één klik naar Stripe. Geen naam of nummer vooraf:
# telefoon en Instagram-naam vraagt Stripe op de betaalpagina. Mislukt Stripe, dan een nette melding.
JS = r"""<script>
(function(){
var ST=[].slice.call(document.querySelectorAll(".qz-step"));
function ix(q){for(var i=0;i<ST.length;i++)if(ST[i].dataset.q===q)return i;return -1}
var IR=ix("resultaat"),IL=ix("leeftijd");
function showResult(){
  var ok=quizAnswers.leeftijd!=="Nee";
  document.getElementById("pvResOk").hidden=!ok;document.getElementById("pvResNo").hidden=ok;
  var w=document.getElementById("pvResWhy");if(ok&&w&&quizAnswers.doel)w.textContent="Je account is oud genoeg. We zetten het systeem in op jouw doel: "+String(quizAnswers.doel).toLowerCase()+".";
  var er=document.getElementById("pvPayErr");if(er)er.hidden=true;
  track("qualify_result",{eligible:ok,reason:ok?null:"account_te_jong",niche:quizAnswers.niche||null,doel:quizAnswers.doel||null});
  if(ok){try{fbq("trackCustom","InAanmerking",{niche:quizAnswers.niche||""})}catch(e){}}
}
var _go=goStep;
goStep=function(e,t){
  var q=ST[e]&&ST[e].dataset.q;
  if(q==="doel"&&quizAnswers.leeftijd==="Nee"){if(t){e=IL;q="leeftijd"}else{e=IR;q="resultaat"}}
  if(q==="resultaat")showResult();
  _go(e,t);
  if(q==="resultaat"){var c=document.getElementById("qzCount");if(c)c.textContent="Je resultaat"}
};
var busy=false;
function newId(){return"pv_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5)}
function payload(id,src){var b={};try{b=pvBaseProps()}catch(e){}var u=(typeof PV_UTM!=="undefined"&&PV_UTM)||{},a=(typeof quizAnswers!=="undefined"&&quizAnswers)||{};
  return{plan:CONFIG.PLAN,lead_id:id,niche:a.niche||"",doel:a.doel||"",leeftijd:a.leeftijd||"",source:src,lp_variant:b.lp_variant||CONFIG.LP,page_version:CONFIG.PAGE_VERSION,utm_source:u.utm_source||"",utm_campaign:u.utm_campaign||"",utm_content:u.utm_content||"",ad_id:u.ad_id||"",adset_id:u.adset_id||"",campaign_id:u.campaign_id||""}}
function fail(btn,html){var er=document.getElementById("pvPayErr"),bar=document.getElementById("pvCancelBar");
  if(btn&&btn.id==="pvPayBtn"&&er){er.innerHTML=html;er.hidden=false}else if(bar){bar.innerHTML="<span>"+html+"</span>"}else alert(html.replace(/<[^>]+>/g,""))}
window.goCheckout=async function(btn,src){
  if(busy)return;busy=true;
  var id=newId(),label=btn?btn.innerHTML:"";
  try{localStorage.setItem("pv_lead",JSON.stringify({lead_id:id,plan:CONFIG.PLAN,created:new Date().toISOString()}))}catch(e){}
  try{window.posthog&&posthog.identify(id)}catch(e){}
  if(btn){btn.disabled=true;btn.textContent="Je gaat naar de betaling…"}
  track("checkout_started",{plan:CONFIG.PLAN,lead_id:id,source:src||"check"});
  try{fbq("track","InitiateCheckout",{value:49,currency:"EUR",content_name:"PromoView 14 dagen testen"},{eventID:"ic_"+id})}catch(e){}
  var url=null,err="network";
  try{var ctrl=new AbortController(),t=setTimeout(function(){ctrl.abort()},12000);
    var r=await fetch("/api/checkout-test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload(id,src)),signal:ctrl.signal});clearTimeout(t);
    var d=null;try{d=await r.json()}catch(e){}
    if(d&&d.ok&&d.url)url=d.url;else err=(d&&d.error)||("status_"+r.status)}catch(e){err="network"}
  if(url){track("payment_redirect",{checkout:"test49",plan:CONFIG.PLAN,lead_id:id},{send_instantly:true});setTimeout(function(){location.href=url},200);return}
  track("checkout_fallback",{plan:CONFIG.PLAN,reason:String(err).slice(0,60)});
  busy=false;if(btn){btn.disabled=false;btn.innerHTML=label}
  fail(btn,'Betalen lukt op dit moment even niet. Probeer het zo nog eens, of <a href="https://wa.me/31685888134" target="_blank" rel="noopener">stuur ons een WhatsApp</a>.')};
document.getElementById("pvPayBtn").addEventListener("click",function(){if(window.openPay)openPay(this,"check");else goCheckout(this,"check")});
try{var q=new URLSearchParams(location.search);if(q.get("checkout")==="geannuleerd"){track("checkout_cancelled",{plan:CONFIG.PLAN});
  var bar=document.createElement("div");bar.className="pv-cancel-bar";bar.id="pvCancelBar";bar.innerHTML='<span>Je test is nog niet gestart: de betaling is niet afgerond.</span><button type="button">Rond af voor €49 →</button>';document.body.insertBefore(bar,document.body.firstChild);bar.querySelector("button").addEventListener("click",function(){if(window.openPay)openQuiz("cancel_bar");else goCheckout(this,"cancel_bar")});
  try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}}}catch(e){}
})();
</script>"""


# De eigen betaalstap via PayPro: de browser stuurt naam, e-mail, nummer, Instagram en de gekozen
# methode naar /api/pay-paypro. Die maakt klant + abonnement aan (€49 incl. btw nu, 14 dagen, daarna
# €190 + btw per maand) en geeft de link naar iDEAL/Bancontact terug; de bezoeker gaat daar direct
# heen (op mobiel opent de bank-app). Creditcard of een storing: Stripe Checkout als vangnet.
PAY_JS = r"""<script>
(function(){
var ST=[].slice.call(document.querySelectorAll(".qz-step"));
function ix(q){for(var i=0;i<ST.length;i++)if(ST[i].dataset.q===q)return i;return -1}
var IP=ix("betalen"),IR=ix("resultaat");if(IP<0)return;
var $=function(id){return document.getElementById(id)};
var P={id:null,country:"NL",method:"ideal",busy:false};
var NAME={ideal:"iDEAL",bancontact:"Bancontact"};
var _go=goStep;
goStep=function(e,t){_go(e,t);var c=$("qzCount");if(!c)return;if(e===IP)c.textContent="Afrekenen";else if(e<IR)c.textContent="Vraag "+(e+1)+" van "+IR};
function newId(){return"pv_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5)}
function lead(){try{return JSON.parse(localStorage.getItem("pv_lead"))||{}}catch(e){return{}}}
function saveLead(o){try{localStorage.setItem("pv_lead",JSON.stringify(Object.assign(lead(),o)))}catch(e){}}
function base(src){var b={},f={};try{b=pvBaseProps()}catch(e){}try{f=pvFbIds()}catch(e){}var u=(typeof PV_UTM!=="undefined"&&PV_UTM)||{},a=(typeof quizAnswers!=="undefined"&&quizAnswers)||{};
  return{plan:CONFIG.PLAN,lead_id:P.id,niche:a.niche||"",doel:a.doel||"",leeftijd:a.leeftijd||"",source:src,lp_variant:b.lp_variant||CONFIG.LP,page_version:CONFIG.PAGE_VERSION,utm_source:u.utm_source||"",utm_campaign:u.utm_campaign||"",utm_content:u.utm_content||"",ad_id:u.ad_id||"",adset_id:u.adset_id||"",campaign_id:u.campaign_id||"",fbp:f.fbp||"",fbc:f.fbc||""}}
function err(html){var e=$("pvPayErr2");if(!html){e.hidden=true;return}e.innerHTML=html;e.hidden=false;var a=e.querySelector("[data-card]");if(a)a.addEventListener("click",toCard)}
function label(){return"🔒 Betaal €49 met "+NAME[P.method]}
function setMethod(m){P.method=m;[].forEach.call(document.querySelectorAll(".pv-pm button"),function(x){var on=x.dataset.m===m;x.classList.toggle("on",on);x.setAttribute("aria-checked",on?"true":"false")});if(!P.busy)$("pvPaySubmit").innerHTML=label()}
function toCard(ev){if(ev)ev.preventDefault();var v=vals();saveLead({name:v.name,email:v.email,phone:v.phone,insta:v.insta});track("checkout_card_choice",{plan:CONFIG.PLAN});goCheckout(null,"creditcard")}
window.openPay=function(btn,src){
  if(!P.id){P.id=newId();saveLead({lead_id:P.id,plan:CONFIG.PLAN,created:new Date().toISOString()});try{window.posthog&&posthog.identify(P.id)}catch(e){}}
  track("checkout_started",{plan:CONFIG.PLAN,lead_id:P.id,source:src||"check",checkout:"paypro"});
  try{fbq("track","InitiateCheckout",{value:49,currency:"EUR",content_name:"PromoView 14 dagen testen"},{eventID:"ic_"+P.id})}catch(e){}
  var l=lead();[["pfNaam","name"],["pfEmail","email"],["pfTel","phone"],["pfInsta","insta"]].forEach(function(f){if(l[f[1]]&&!$(f[0]).value)$(f[0]).value=l[f[1]]});
  goStep(IP);
  setTimeout(function(){var n=$("pfNaam");if(n&&!n.value&&innerWidth>=768)n.focus()},300)};
[].forEach.call(document.querySelectorAll(".pv-land button"),function(b){b.addEventListener("click",function(){P.country=b.dataset.c;
  [].forEach.call(document.querySelectorAll(".pv-land button"),function(x){x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",x===b?"true":"false")});
  setMethod(P.country==="BE"?"bancontact":"ideal")})});
[].forEach.call(document.querySelectorAll(".pv-pm button"),function(b){b.addEventListener("click",function(){setMethod(b.dataset.m);track("payment_method_choice",{method:b.dataset.m})})});
$("pvCard").addEventListener("click",toCard);
function vals(){return{name:$("pfNaam").value.trim(),email:$("pfEmail").value.trim(),phone:$("pfTel").value.trim(),insta:$("pfInsta").value.trim().replace(/^@+/,"").replace(/.*instagram\.com\//i,"").replace(/[\/?#].*$/,"")}}
function bad(f,on){var el=document.querySelector('.pv-fld[data-f="'+f+'"]');if(el)el.classList.toggle("bad",!!on)}
function validate(v){var ph=v.phone.replace(/[\s().-]/g,"");var r={name:v.name.length<2,email:!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email),phone:!/^(\+\d{8,15}|00\d{8,15}|0[1-9]\d{7,8})$/.test(ph),insta:!/^[A-Za-z0-9._]{1,30}$/.test(v.insta)};
  var first=null;Object.keys(r).forEach(function(k){bad(k,r[k]);if(r[k]&&!first)first=k});return first}
["pfNaam","pfEmail","pfTel","pfInsta"].forEach(function(id){$(id).addEventListener("input",function(){var f=this.closest(".pv-fld");if(f)f.classList.remove("bad")})});
var MSG={invalid_name:"name",invalid_email:"email",invalid_phone:"phone",invalid_insta:"insta"};
function done(btn){P.busy=false;btn.disabled=false;btn.innerHTML=label()}
$("pvPayForm").addEventListener("submit",async function(ev){ev.preventDefault();if(P.busy)return;
  var btn=$("pvPaySubmit"),v=vals();err("");
  var f=validate(v);if(f){track("payment_form_invalid",{field:f});var el=document.querySelector('.pv-fld[data-f="'+f+'"] input');if(el)el.focus();return}
  P.busy=true;btn.disabled=true;btn.textContent="Even geduld…";
  saveLead({name:v.name,email:v.email,phone:v.phone,insta:v.insta});
  track("payment_submit",{plan:CONFIG.PLAN,country:P.country,method:P.method});
  var d=null;
  try{var ctrl=new AbortController(),t=setTimeout(function(){ctrl.abort()},15000);
    var r=await fetch("/api/pay-paypro",{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,
      body:JSON.stringify(Object.assign(base("betaalstap"),{name:v.name,email:v.email,phone:v.phone,insta:v.insta,country:P.country,method:P.method}))});
    clearTimeout(t);try{d=await r.json()}catch(e){}}catch(e){}
  if(!d||!d.ok||!d.checkout_url){var code=(d&&d.error)||"network";track("payment_error",{stage:"server",code:code,provider:"paypro"});
    if(MSG[code]){bad(MSG[code],true);err("Controleer het rode veld en probeer het opnieuw.")}
    else err('Betalen via '+NAME[P.method]+' lukt op dit moment even niet. Probeer het zo nog eens, <a href="#" data-card>betaal met creditcard</a> of <a href="https://wa.me/31685888134" target="_blank" rel="noopener">stuur ons een WhatsApp</a>.');
    done(btn);return}
  saveLead({sub:d.subscription_id,provider:"paypro"});
  try{fbq("track","AddPaymentInfo",{value:49,currency:"EUR",content_name:"PromoView 14 dagen testen"},{eventID:"api_"+P.id})}catch(e){}
  track("payment_redirect",{checkout:"paypro",plan:CONFIG.PLAN,lead_id:P.id,method:P.method},{send_instantly:true});
  btn.textContent="Je gaat naar "+NAME[P.method]+"…";setTimeout(function(){location.href=d.checkout_url},200)});
})();
</script>"""


def build(key, cfg):
    s = open(f"{REPO}/v5.html", encoding="utf-8").read()
    R = lambda old, new, n=1, nm="": rep(s, old, new, n, f"{key}:{nm or old[:30]}")

    # ── Config en meting ──
    s = R('<title>Gratis Instagram-consult voor je bedrijf | PromoView</title>', '<title>Test PromoView 14 dagen voor €49 | PromoView</title>')
    s = R('Volledig beheerd. 14 dagen geld-terug-garantie. Binnen 48 uur actief.',
          'Volledig beheerd. Test het 14 dagen voor €49, inclusief gratis profielcheck. Binnen 48 uur actief.')
    s = R('PRIJS:190,VALUTA:"EUR",PAGE_VERSION:"v5.2-consult"',
          f'PRIJS:49,VALUTA:"EUR",PAGE_VERSION:"{cfg["page_version"]}",PLAN:"{cfg["plan"]}",LP:"{key}"')
    s = R('lp_variant:"v5"', f'lp_variant:"{key}"')
    s = R('lead_type:"gratis_consult"', f'lead_type:"test49_{cfg["plan"]}"')
    s = R('s.textContent="Je consult wordt aangevraagd…",location.href="start5.html"', 'goCheckout(s,"quiz")')

    # ── Hero ──
    s = R('<span class="am-dot"></span>Gratis en vrijblijvend · we bellen je binnen 1 werkdag</div>',
          '<span class="am-dot"></span>Nieuw: 14 dagen testen · inclusief 2 gratis extra\'s</div>')
    s = R('? Wij laten je gratis zien hoe.</h1>', '? Test het 14 dagen voor €49.</h1>')
    s = R('<p class="am-sub1">Gratis <u>Instagram-consult</u> van 15 minuten.</p>',
          '<p class="am-sub1">Het complete groeisysteem, plus een <u>gratis profielcheck</u> en bio-optimalisatie.</p>')
    s = R('<p class="am-sub2">Een specialist bekijkt je account vooraf en belt je met concrete verbeterpunten voor jouw profiel, jouw doelgroep en jouw groei. Persoonlijk advies over jouw account.</p>',
          f'<p class="am-sub2">{cfg["sub2"]}</p>')
    s = R('<a href="#check" class="am-btn pv-hero-go" data-cta="hero_scroll" onclick=\'track("cta_clicked",{source:"hero_scroll"})\'>Vraag je gratis consult aan ↓</a>',
          '<div><span class="pv-price-tag"><b>€49</b><small>voor 14 dagen · incl. btw</small></span></div>'
          '<button type="button" class="am-btn pv-hero-go" data-cta="hero" onclick=\'openQuiz("hero")\'>Check of je in aanmerking komt →</button>'
          '<p class="pv-hero-under">3 vragen · 30 seconden · daarna start je direct</p>')

    # ── Hoe het werkt ──
    s = R('>Vraag mijn gratis consult aan →</button><small>3 korte vragen · je betaalt niets</small>',
          '>Check of je in aanmerking komt →</button><small>3 vragen · 30 seconden</small>')

    # ── Startkaart (staat 2x: bovenaan en onderaan) ──
    s = R('<span class="am-eyebrow">Gratis Instagram-consult</span><h2 class="am-h2">Dit bespreken we in <span class="acc">jouw consult</span></h2>',
          '<span class="am-eyebrow">14 dagen testen</span><h2 class="am-h2">Dit krijg je voor <span class="acc">€49</span></h2>')
    s = R('<b>Vraag je gratis consult aan</b><span>3 korte vragen · we bellen je binnen 1 werkdag · je betaalt niets</span>',
          '<b>Check of je in aanmerking komt</b><span>3 vragen · 30 seconden · daarna start je direct</span>', 2)
    s = R(OLD_CARD_GETS, CARD_GETS, 2)
    s = R('👇 Tik op je branche om je consult aan te vragen', '👇 Tik op je branche om de check te starten', 2)
    s = R('<button type="button" class="am-btn pv-sc-start">Vraag mijn consult aan →</button>',
          '<button type="button" class="am-btn pv-sc-start">Check of ik in aanmerking kom →</button>', 2)
    s = R('<span>✓ Gratis en vrijblijvend</span><span>✓ Geen betaalgegevens nodig</span><span>✓ We bellen je binnen 1 werkdag</span>',
          cfg["card_foot"], 2)

    # ── Aanbod ──
    s = R('<h2 class="am-h2 pv-deal-h">Eén vast bedrag,<br><span class="acc">alles geregeld</span></h2><p class="am-lead">Geen setupkosten en elke maand opzegbaar. We nemen maximaal <b>20 nieuwe klanten</b> per maand aan.</p>',
          '<h2 class="am-h2 pv-deal-h">14 dagen testen,<br><span class="acc">alles geregeld</span></h2><p class="am-lead">Het complete groeisysteem plus twee gratis extra\'s. We nemen maximaal <b>20 nieuwe klanten</b> per maand aan.</p>')
    s = R('<div class="pv-offer-h">Dit zit erin</div><ul>',
          '<div class="pv-offer-h">Dit zit erin</div><ul>'
          f'<li class="pv-free">{CHECK}<span><b>Profielcheck door een marketing- en contentspecialist</b><small>Concrete verbeterpunten, zodat nieuwe bezoekers sneller volgen en contact opnemen.</small></span><em class="am-free">GRATIS</em></li>'
          f'<li class="pv-free">{CHECK}<span><b>Bio- en highlightoptimalisatie</b><small>We herschrijven je bio en zetten je highlights strak, zodat meteen duidelijk is wat je doet.</small></span><em class="am-free">GRATIS</em></li>'
          '</ul><div class="pv-offer-sep">Plus het complete groeisysteem</div><ul>')
    s = R('<div class="am-offer-total"><span>Jouw prijs</span><b>Vast per maand<small> · hoor je in je consult</small></b></div><button class="am-btn pv-btn-big" data-cta="offer" onclick=\'openQuiz("offer")\'>Vraag mijn gratis consult aan →</button><div class="pv-risk-row"><span>✓ 14 dagen geld terug</span><span>✓ Elke maand opzegbaar, ook na maand 1</span><span>✓ Geen setupkosten</span></div>',
          f'<div class="am-offer-total"><span>14 dagen testen</span><b>€49<small> incl. btw</small></b></div><p class="pv-test-note">{cfg["offer_note"]}</p>'
          '<button class="am-btn pv-btn-big" data-cta="offer" onclick=\'openQuiz("offer")\'>Check of ik in aanmerking kom →</button>'
          f'<div class="pv-risk-row">{cfg["risk_row"]}</div>')

    # ── Zonder risico ──
    s = R('<p class="am-lead">Wij geloven in wat we doen. Daarom zit je nergens aan vast.</p>',
          '<p class="am-lead">Je hoeft ons niet op ons woord te geloven. Voor €49 zie je het zelf.</p>')
    s = R('<b>14</b><span>dagen</span></div><div><h3>14 dagen geld terug</h3><p>Niet tevreden in de eerste twee weken? Eén berichtje naar je contactpersoon en je krijgt je geld terug. Zonder gedoe, zonder discussie.</p>',
          '<b>14</b><span>dagen</span></div><div><h3>Twee weken om het zelf te zien</h3><p>Binnen 48 uur draait het systeem. In je groei-dashboard zie je elke dag wat het voor jouw account doet.</p>')
    s = R('<b>1</b><span>maand</span></div><div><h3>Elke maand opnieuw kiezen</h3><p>Ook na de eerste maand beslis je elke maand zelf of je doorgaat. Geen jaarcontract en geen opzegtermijn. Stoppen doe je met één bericht.</p>',
          f'{cfg["g2_badge"]}</div><div><h3>{cfg["g2_h3"]}</h3><p>{cfg["g2_p"]}</p>')

    # ── Veelgestelde vragen ──
    s = R('<details data-faq="consult-gratis" data-topic="prijs"><summary>Is het consult echt gratis?</summary><div class="a"><strong>Ja.</strong> Het consult kost niets en je zit nergens aan vast. Een specialist bekijkt je account vooraf en belt je met concrete verbeterpunten. Daarna beslis je zelf of je met PromoView wilt starten.</div></details>',
          '<details data-faq="test-49" data-topic="prijs"><summary>Wat krijg ik voor €49?</summary><div class="a"><strong>Het complete groeisysteem, 14 dagen lang.</strong> Plus een gratis profielcheck door een marketing- en contentspecialist en een gratis bio- en highlightoptimalisatie. Binnen 48 uur na je onboarding is het live.</div></details>'
          f'<details data-faq="na-14-dagen" data-topic="prijs"><summary>Wat gebeurt er na de 14 dagen?</summary><div class="a">{cfg["faq_a"]}</div></details>')
    s = R('<details data-faq="garantie" data-topic="prijs"><summary>Hoe werkt de geld-terug-garantie?</summary><div class="a"><strong>Simpel: 14 dagen, geen vragen.</strong> Ben je in de eerste 14 dagen niet tevreden, dan krijg je je geld terug. Eén berichtje naar je contactpersoon is genoeg.</div></details>', '')
    s = R('a:"Je betaalt een vast bedrag per maand, zonder setupkosten en maandelijks opzegbaar. Je ziet je maandprijs direct nadat je je gratis consult hebt aangevraagd."',
          f'a:"{cfg["chat_price"]}"')
    s = R('a:"14 dagen geld terug, geen vragen. Niet tevreden? Eén berichtje naar je contactpersoon en je krijgt je geld terug."',
          f'a:"{cfg["chat_guar"]}"')

    # ── Slot ──
    s = R('<span class="am-eyebrow">Start vandaag</span>\n<h2 class="am-h2">Vraag je gratis <span class="acc">Instagram-consult</span> aan</h2>\n<p class="am-lead">Hoor eerst wat er beter kan aan jouw account. Daarna beslis je zelf of je wilt starten.</p>',
          '<span class="am-eyebrow">Start vandaag</span>\n<h2 class="am-h2">Test PromoView <span class="acc">14 dagen voor €49</span></h2>\n<p class="am-lead">Zie in twee weken zelf wat het systeem voor jouw account doet.</p>')
    s = R('<p class="am-small">Maandelijks opzegbaar · geen jaarcontract · 14 dagen geld terug</p>',
          '')  # de vinkjes onder de slotknop zeggen hetzelfde
    s = R('>Gratis consult →</button> <span class="note">15 minuten ·<br>je betaalt niets</span>',
          f'>Doe de check →</button> <span class="note">{cfg["sticky_note"]}</span>')

    # ── Vragenlijst ──
    s = R('aria-label="Gratis Instagram-consult"', 'aria-label="Check of je in aanmerking komt"')
    s = R('<div class="qz-step" data-q="niche"><h3>Wat voor bedrijf heb je?</h3>',
          '<div class="qz-step" data-q="niche"><h3>Wat voor bedrijf heb je?</h3><p class="qz-sub">Check in 30 seconden of je in aanmerking komt voor de test.</p>')
    s = between(s, '<div class="qz-step" data-q="insta" hidden>', 'geen spam</p></div>', quiz_steps(cfg), f"{key}:vragen")

    # ── Focus op het aanbod: geen startkaart met branches meer ──
    # De check-sectie gaat eruit, het aanbod komt direct onder de hero en onderaan staat
    # alleen een knop. Alle knoppen openen de check (3 vragen) en daarna Stripe.
    s = between(s, '<section class="am-sec pv-checksec" id="check">', '</section>', '', f"{key}:check-sectie")
    a = s.find('<section class="am-sec pv-deal" id="aanbod">')
    b = s.find('</section>', a) + len('</section>')
    if a < 0 or s.count('<section class="am-sec pv-deal" id="aanbod">') != 1:
        raise SystemExit(f"{key}: aanbod-sectie niet (uniek) gevonden")
    deal = s[a:b]
    s = s[:a] + s[b:]
    s = R('</div></header>', '</div></header>\n' + deal)
    s = between(s, '<div class="am-startcard" data-src="final_card">', cfg["card_foot"] + '</div></div>',
                '<button class="am-btn pv-btn-big" data-cta="final" onclick=\'openQuiz("final")\'>Check of ik in aanmerking kom →</button>'
                f'<div class="pv-risk-row">{cfg["risk_row"]}</div>', f"{key}:slotkaart")
    # ── Vertrouwen door de hele pagina ──
    # Hero: Trustpilot-balk direct onder de kop (op mobiel meteen in beeld); de cijfers
    # verhuizen naar onder de knop, met 'max. 20 klanten' i.p.v. een tweede '4,8'.
    a = s.find('<div class="am-stats">')
    b = s.find('<div><span class="pv-price-tag">')
    if a < 0 or b < a:
        raise SystemExit(f"{key}: hero-cijfers niet gevonden")
    s = s[:a] + TRUST_STRIP + '\n' + HERO_VIDEO + '\n' + s[b:]
    # Met de video in de hero valt de knop op mobiel onder de vouw: de vaste knop onderaan
    # verschijnt zodra de hero-knop zelf niet in beeld is (ook vóórdat je erlangs scrolt).
    s = R('observe(document.querySelector(".hero")||document.querySelector(".am-hero"))',
          'observe(document.querySelector(".pv-hero-go")||document.querySelector(".am-hero"))')
    s = R('<p class="pv-hero-under">3 vragen · 30 seconden · daarna start je direct</p>',
          '<p class="pv-hero-under">3 vragen · 30 seconden · daarna start je direct</p>'
          '<div class="am-stats pv-stats-low"><div><b>1.500+</b><span>bedrijven geholpen</span></div><div><b>3M+</b><span>volgers gegenereerd</span></div>'
          '<div><b>48 uur</b><span>en je bent live</span></div><div><b>Max. 20</b><span>nieuwe klanten per maand</span></div></div>')
    a = s.find('<section class="am-sec pv-deal" id="aanbod">')
    b = s.find('</div></section>', a)
    s = s[:a] + s[a:b] + quote("novio", "aanbod") + s[b:]   # review direct onder het aanbod

    def cut(s, start):
        if s.count(start) != 1:
            raise SystemExit(f"{key}: sectie niet uniek: {start[:50]!r}")
        i = s.find(start)
        j = s.find('</section>', i) + len('</section>')
        return s[:i] + s[j:], s[i:j]

    def after(s, start, block):
        i = s.find(start)
        j = s.find('</section>', i) + len('</section>')
        return s[:j] + block + s[j:]

    s, cases = cut(s, '<section class="am-sec pv-res" id="cases">')
    s = after(s, '<section class="am-sec pv-deal" id="aanbod">', cases)   # resultaten direct na het aanbod
    s, reviews = cut(s, '<section class="am-sec am-reviews">')
    s = after(s, '<section class="am-sec pv-how" id="hoe">', reviews)     # reviews direct na 'hoe het werkt'
    s = R('<p class="am-lead">Zie in twee weken zelf wat het systeem voor jouw account doet.</p>',
          '<p class="am-lead">Zie in twee weken zelf wat het systeem voor jouw account doet.</p>' + quote("rachel", "slot"))
    if "am-startcard\" data-src" in s or 'am-sc-opt" data-v' in s:
        raise SystemExit(f"{key}: er staat nog een startkaart op de pagina")

    s = R('</head>', CSS + '</head>')
    s = R('</body>', JS + (PAY_JS if cfg.get("native") else "") + '</body>')

    # Niets mag nog naar het gratis consult of de oude garantie verwijzen.
    body = re.sub(r'keys:\[[^\]]*\]', '', s[s.find('<body'):])  # zoekwoorden van de chat tellen niet
    for bad in ["consult", "geld terug", "Geen betaalgegevens", "15 minuten", "start5", "korte vragen", "Mobiel nummer"]:
        hits = [m.start() for m in re.finditer(bad, body)]
        if hits:
            raise SystemExit(f"{key}: '{bad}' komt nog {len(hits)}x voor: {body[hits[0]-80:hits[0]+80]!r}")
    open(f"{REPO}/{key}.html", "w", encoding="utf-8").write(s)
    print(key, len(s))


for k, c in VARIANTS.items():
    build(k, c)
