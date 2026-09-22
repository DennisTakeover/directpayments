# directpayments

Landingspagina PromoView v11.4 + gemeten verkoopfunnel.

De volledige specificatie (paginastructuur, event-meetplan, architectuur) staat in het gedeelde document
"PromoView Verkoopfunnel — Specificatie".

## Structuur

- `index.html` — landingspagina (belofte, VSL, hoe-het-werkt, groeicijfers, cases, reviews, aanbod, FAQ) met
  de kwalificatie-quiz + leadformulier ("bespreek de mogelijkheden voor mijn account").
- `start.html` — "wat je kunt verwachten"-pagina met de eigenlijke koopknop (`startGroei()` → Stripe Payment Link).
- `bedankt.html` — bevestigingspagina na Stripe-checkout; bevestigt de betaling via de backend voordat
  `purchase_completed` getrackt wordt.
- `api/` — Vercel Functions (backend):
  - `lead.js` — ontvangt leads van `index.html`, stuurt ze server-side door naar GoHighLevel, bevestigt pas dan `lead_submitted`.
  - `verify-payment.js` — door `bedankt.html` aangeroepen om een Stripe Checkout Session te verifiëren voor `purchase_completed` getrackt wordt.
  - `stripe-webhook.js` — de betrouwbare bron voor `purchase_completed` / `payment_failed`: Stripe roept dit server-naar-server aan, ook als de klant het tabblad sluit.
  - `ghl-webhook.js` — ontvangt statusupdates vanuit GoHighLevel-workflows (`contacted`, `qualified`, `not_qualified`, `won`, `lost`) en stuurt ze door als `lead_contacted` / `lead_qualified` / `sale_closed` naar PostHog.

## Analytics

Elke pagina stuurt events naar drie plekken via `track(event, props)`:

1. `window.dataLayer` (GTM, ongewijzigd).
2. Meta Pixel (`fbq`, ongewijzigd — alleen actief zodra `CONFIG.META_PIXEL_ID` is ingevuld).
3. **PostHog** (nieuw) — het hoofddashboard voor de funnel: events, sessieopnames en experimenten op één plek.

Event-namen volgen het meetplan uit de specificatie: `landing_viewed`, `section_viewed`, `vsl_started`,
`vsl_progress`, `vsl_paused`, `vsl_completed`, `cta_clicked`, `lead_form_started`, `lead_form_error`,
`lead_submitted`, `checkout_started`, `purchase_completed`, `payment_failed`, `lead_contacted`,
`lead_qualified`, `sale_closed`. Bestaande events (`video_play`, `quiz_*`, `checkout_start`, …) blijven
staan voor de Meta Pixel-koppeling en achterwaartse compatibiliteit.

## Setup — wat nog moet gebeuren voor het live/compleet is

1. **PostHog project API key toevoegen.** Vervang `PLAATS_HIER_JE_POSTHOG_PROJECT_KEY` in `index.html`,
   `start.html` en `bedankt.html` door je echte PostHog project-API-key (Project Settings → Project API
   Key, begint met `phc_`). Dit is een publieke, write-only key — veilig om in de HTML te zetten.
   Standaard staat de EU-cloud (`https://eu.i.posthog.com`) ingesteld; pas `POSTHOG_HOST` aan als je
   account op US-cloud draait.
2. **Vercel environment variables instellen** (Project Settings → Environment Variables), zie
   `.env.example` voor de volledige lijst: `GHL_WEBHOOK_URL`, `GHL_SHARED_SECRET`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `POSTHOG_KEY`, `POSTHOG_HOST`.
3. **Stripe webhook aanmaken**: Developers → Webhooks → endpoint `https://<jouw-domein>/api/stripe-webhook`,
   events `checkout.session.completed` en `checkout.session.async_payment_failed`. Het signing secret gaat
   in `STRIPE_WEBHOOK_SECRET`.
4. **Stripe Payment Link confirmatiepagina instellen**: bewerk de Payment Link → "Na betaling" → stuur door
   naar `https://<jouw-domein>/bedankt.html?session_id={CHECKOUT_SESSION_ID}`. Zonder dit kan `bedankt.html`
   de betaling niet verifiëren (de Stripe-webhook blijft wel werken als achtervang).
5. **GoHighLevel inbound webhook**: maak een workflow met een "Inbound Webhook"-trigger, zet de URL in
   `GHL_WEBHOOK_URL`.
6. **GoHighLevel → terugkoppeling naar de funnel**: laat een workflow-actie in GoHighLevel (bij het zetten
   van een status door sales) een POST doen naar `https://<jouw-domein>/api/ghl-webhook` met body
   `{"lead_id": "...", "status": "contacted|qualified|not_qualified|won|lost", "reason": "...", "value": ...}`
   en header `x-ghl-secret: <GHL_SHARED_SECRET>`.

Tot deze stappen zijn ingevuld draait de pagina gewoon door (alle bestaande gedrag blijft werken), maar
worden er geen events naar PostHog gestuurd en gaat de lead-opslag naar `/api/lead` die zonder
`GHL_WEBHOOK_URL` een foutmelding teruggeeft aan de bezoeker in plaats van een lead stil te laten verdwijnen.
