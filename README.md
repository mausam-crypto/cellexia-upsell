# Cellexia Post-Purchase Upsell

A Shopify app built for **cellexialabs.com** (anti-aging skincare, 17 languages,
~80 markets, EUR default) that shows one-click **post-purchase upsell offers**
immediately after checkout, plus a **thank-you-page fallback** for payment
methods Shopify excludes from the post-purchase page.

## What it does

- **Rule-based recommendation engine** — ranks upsell products by co-purchase
  affinity, manual rules, repeat-purchase behavior, inventory, historical
  acceptance rate, and expected **gross profit per impression**. If no rule
  matches, an auto-pilot scorer picks the best complementary product
  automatically.
- **AI-written copy (Claude)** — explains, in the buyer's language, why the
  offer complements what they just bought. Prompts are fully editable in the
  admin. Copy never implies the customer bought the wrong products.
- **One-click acceptance** — offers are added to the just-placed order via
  Shopify changesets and charged to the same card. No re-entry of payment
  details.
- **Smart defaults** — single-product order → 1 highly complementary offer;
  multi-product order → up to 3 offers shown one at a time, ordered by expected
  gross profit per impression. Any rule can switch to **bundle** mode instead.
- **10–15% configurable discounts** (fixed / tiered by order value /
  AI-adjusted), strict frequency capping, suppression of owned or recently
  purchased products.
- **A/B rotation with Thompson sampling** and automatic winner picking.
- **Per-market overrides** (enable/disable, discount, language, max offers) and
  per-language buyer-facing strings for all 17 store locales.
- **Real per-country prices** — offer pages display Shopify's contextual
  pricing for the buyer's country (market price adjustments and price lists
  included, in the market's currency), DB-cached with a 6h TTL, falling back
  to an FX-rate conversion of the base price when unavailable.
- **Full analytics** — funnel, per-offer performance, country/language/surface
  breakdowns, experiment results, and 60/90-day **CLV cohorts** comparing
  customers who accepted, declined, or never saw an offer.
- **Thank-you-page fallback extension** — discount-code based, covers orders
  paid with Apple Pay / Google Pay / PayPal / Klarna etc., which Shopify
  excludes from the post-purchase page (platform limitation: plain credit-card
  payments only).

## Quick start

Prerequisites: Node 20.10+, [Shopify CLI](https://shopify.dev/docs/api/shopify-cli),
a Shopify Partner account, and a development store.

```bash
# 1. Create the app in the Partner Dashboard, then link this repo to it:
shopify app config link

# 2. Configure environment:
cp .env.example .env      # fill in ANTHROPIC_API_KEY (and optionally DEEPL_API_KEY)

# 3. Install dependencies and create the database:
npm install
npm run setup             # prisma generate + prisma db push

# 4. Run in development (tunnels, hot reload, extension preview):
npm run dev
```

Then, on the dev store: install the app, go to **Settings → Checkout →
Post-purchase page** and select **Cellexia Post-Purchase Upsell**, place a test
order with a test credit card, and the offer appears after payment.

Before `shopify app deploy`, set the `APP_URL` constant at the top of
`extensions/post-purchase-upsell/src/index.jsx` to your production app URL, and
set the thank-you block's **App URL** setting in the checkout editor.

Full step-by-step instructions (including Fly.io hosting, the Postgres switch,
protected customer data approval, and troubleshooting):
**[docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md)**.

## Documentation

| Document | Audience | Contents |
|---|---|---|
| [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md) | Developers | Complete setup runbook: Partner app creation, `.env`, dev loop, extension configuration, testing, production hosting, Postgres, approvals, troubleshooting |
| [docs/MERCHANT_GUIDE.md](docs/MERCHANT_GUIDE.md) | Merchant team | Every admin page explained, strategy defaults and best practices, analytics definitions, CLV cohorts |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Developers | Repo map, data flows, database schema, extension design, security model, scaling notes |
| [SPEC.md](SPEC.md) | Developers | The original build contract for every module |

## Repository map

```
app/
  shopify.server.ts               Shopify app config (OAuth, session storage, bootstrap hook)
  db.server.ts                    Prisma client singleton
  types.ts                        Shared domain types + DEFAULT_SETTINGS + UI string catalog
  lib/json.ts                     JSON-column helpers, gid <-> numeric id conversion
  services/
    settings.server.ts            Per-shop settings (deep-merged over defaults)
    catalog.server.ts             Product catalog cache, markets & locales sync
    bootstrap.server.ts           Post-install bootstrap + GDPR redaction
    recommendation.server.ts      Offer selection engine (rules, bandit, auto-pilot, discounts)
    ai.server.ts                  Claude copywriting, prompt templates, UI-string translation
    analytics.server.ts           Event recording, dashboards, experiments, CLV cohorts
    market-pricing.server.ts      Real per-country prices (Shopify contextualPricing, cached)
    debug.server.ts               Diagnostic traces (Debug tab): prompts, provenance, name scan
    offer-orchestrator.server.ts  Assembles the full offer response for the extensions
  routes/
    app._index.tsx                Admin: dashboard
    app.analytics.tsx             Admin: analytics & CSV export
    app.offers._index.tsx         Admin: offer rules list
    app.offers.$id.tsx            Admin: rule editor
    app.preview.tsx               Admin: offer preview sandbox (production pipeline, no analytics)
    app.products.tsx              Admin: AI-context editor + translated-name coverage
    app.prompts.tsx               Admin: AI prompt templates + preview
    app.settings.tsx              Admin: settings (discount, markets, languages, AI, ...)
    app.translations.tsx          Admin: buyer-facing UI strings per language
    app.debug.tsx                 Admin: full generation traces (prompts, provenance, name scan)
    api.offer.tsx                 Public: post-purchase offer endpoint (JWT-verified)
    api.offer-extended.tsx        Public: below-CTA copy sections, polled while extendedPending
    api.sign-changeset.tsx        Public: signs changesets from server-side IssuedOffer rows
    api.events.tsx                Public: impression/accept/decline/error events
    api.typ-offer.tsx             Public: thank-you-page offer (discount-code based)
    auth.login.tsx                Shop-domain login form into the OAuth flow
    webhooks.tsx                  Webhooks: orders, products, app lifecycle, GDPR
  components/
    MiniChart.tsx                 Dependency-free SVG line/area chart
    PostPurchasePreview.tsx       Buyer-faithful replica of the offer page (admin Preview)
extensions/
  post-purchase-upsell/           Checkout::PostPurchase extension (React 17)
  thank-you-upsell/               purchase.thank-you.block.render UI extension (React 18)
prisma/schema.prisma              Database schema (SQLite dev / Postgres prod)
shopify.app.toml                  App config: scopes, webhooks, URLs
shopify.web.toml                  CLI web process config (predev runs ensure-env + prisma)
.env.example                      All environment variables, documented
```

## Environment variables

See `.env.example`. In short: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL` and `SCOPES` are managed by the Shopify CLI in development
and must be set manually in production; `DATABASE_URL` points at SQLite in dev
and Postgres in production; `ANTHROPIC_API_KEY` powers AI copy (without it the
app degrades to deterministic fallback copy); `DEEPL_API_KEY` is optional for
DeepL-based UI-string translation.

## Payment method support (platform limitation)

| Payment method | Post-purchase page | Thank-you fallback |
|---|---|---|
| Credit / debit card (Shopify Payments and supported gateways) | ✓ | ✓ |
| Apple Pay / Google Pay | ✗ | ✓ |
| PayPal | ✗ | ✓ |
| Klarna / installments | ✗ | ✓ |

This is a Shopify platform restriction, not an app limitation — see
[Shopify's post-purchase documentation](https://shopify.dev/docs/apps/build/checkout/product-offers/post-purchase).
