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
- **Live health checks (Debug tab)** — a ~33-check battery that verifies every
  key feature against the LIVE store through the real code paths: billing/
  changeset signing, scopes, webhooks, payment-recovery retries, all 17
  languages, catalog, AI models, per-country pricing, discount codes, and
  extension reachability. Runs on demand, automatically every 6h, and via a
  token-protected `/api/health` endpoint for external uptime monitors
  (HTTP 200 healthy / 503 failing).

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
order with a test credit card (shipping to a shop-currency country), and the
offer appears after payment. On a **live** store one more step is mandatory
first: request **"Access post-purchase extensions"** for the app in the
Partner Dashboard (see the guide, §7.1).

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
  lib/version.ts                  APP_VERSION — shown in the Debug tab and by GET /api/health?probe=version
  services/
    settings.server.ts            Per-shop settings (deep-merged over defaults)
    catalog.server.ts             Product catalog cache, markets & locales sync
    bootstrap.server.ts           Post-install bootstrap + GDPR redaction
    recommendation.server.ts      Offer selection engine (rules, bandit, auto-pilot, discounts)
    ai.server.ts                  Claude copywriting, prompt templates, UI-string translation
    analytics.server.ts           Event recording, dashboards, experiments, CLV cohorts
    market-pricing.server.ts      Real per-country prices (Shopify contextualPricing, cached)
    debug.server.ts               Diagnostic traces (Debug tab): prompts, provenance, name scan
    health.server.ts              Live health-check battery (Debug tab): ~35 checks against the real store
    inquiry-log.server.ts         ShouldRender inquiry log (one row per /api/offer call) + funnel stats
    language-guard.server.ts      Wrong-language detection + enforcement for buyer copy
    offer-orchestrator.server.ts  Assembles the full offer response for the extensions
  routes/
    app._index.tsx                Admin: dashboard
    app.analytics.tsx             Admin: analytics & CSV export
    app.offers._index.tsx         Admin: offer rules list
    app.offers.$id.tsx            Admin: rule editor
    app.preview.tsx               Admin: offer preview sandbox (production pipeline, no analytics)
    app.products.tsx              Admin: AI-context editor + translated-name coverage
    app.upsell-products.tsx       Admin: allowlist of products the engine may offer
    app.prompts.tsx               Admin: AI prompt templates + preview
    app.settings.tsx              Admin: settings (discount, markets, languages, AI, ...)
    app.translations.tsx          Admin: buyer-facing UI strings per language
    app.debug.tsx                 Admin: live health checks + post-purchase inquiries + generation traces
    api.offer.tsx                 Public: post-purchase offer endpoint (JWT-verified)
    api.offer-extended.tsx        Public: below-CTA copy sections, polled while extendedPending
    api.sign-changeset.tsx        Public: signs changesets from server-side IssuedOffer rows
    api.events.tsx                Public: impression/accept/decline/error events
    api.typ-offer.tsx             Public: thank-you-page offer (discount-code based)
    api.health.tsx                Public: health-echo probe + token-protected uptime-monitor status
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

## When Shopify shows the post-purchase page (platform limitations)

| Situation | Post-purchase page | Thank-you fallback |
|---|---|---|
| Credit / debit card (Shopify Payments and supported gateways), checkout in the **shop currency** | ✓ | ✓ |
| Checkout in any **other currency** (Markets local currencies), or orders with duties | ✗ | ✓ |
| Apple Pay / Google Pay | ✗ | ✓ |
| PayPal | ✗ | ✓ |
| Klarna / installments | ✗ | ✓ |
| Gift-card-only, < $0.50, local delivery, non-Online-Store channel | ✗ | ✓ |

These are Shopify platform restrictions, not app limitations — see
[Shopify's product-offers documentation](https://shopify.dev/docs/apps/build/checkout/product-offers)
("Limitations"). In addition, on a **live** store Shopify only exposes the
post-purchase page after the app has been granted **"Access post-purchase
extensions"** in the Partner Dashboard (development stores are exempt) — see
[IMPLEMENTATION_GUIDE.md §7](docs/IMPLEMENTATION_GUIDE.md#7-enable-the-post-purchase-page).
The Debug tab's health check *"Shopify checkout: post-purchase extension
available"* verifies the live flag in one click, and Debug → **Post-purchase
inquiries** shows every ShouldRender call Shopify actually sent, the app's
answer, and a per-order verdict (Shopify's rules / Shopify's gate / the app).
Verified live on 2026-08-18: a non-shop-currency checkout (observed on the
NOK market) is refused by Shopify's own `PostPurchaseData` query with
`code: MULTI_CURRENCY` before the extension is even loaded; the same query for
a EUR checkout, while the gate was open, served this app's extension and its
ShouldRender returned `render: true`. Also verified: the gate itself is live
state — it read off, on and off again within one hour, together with
`isPostPurchaseAppInUse` — so the Debug tab keeps a timestamped **gate
timeline** and exposes a gate-only monitor URL (`/api/health?…&gate=1`,
200 open / 503 closed).
