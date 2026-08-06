# Implementation Guide — Cellexia Post-Purchase Upsell

This is the complete, ordered runbook for a Shopify developer setting this app
up from a fresh clone through to production. Every step is copy-pasteable.
For what the app does and how it is structured, read
[ARCHITECTURE.md](ARCHITECTURE.md). For how the merchant team uses the admin,
read [MERCHANT_GUIDE.md](MERCHANT_GUIDE.md).

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Create the app in the Partner Dashboard](#2-create-the-app-in-the-partner-dashboard)
3. [Link the repo to the app](#3-link-the-repo-to-the-app)
4. [Environment variables (.env)](#4-environment-variables-env)
5. [Install and run locally](#5-install-and-run-locally)
6. [Install on a development store](#6-install-on-a-development-store)
7. [Enable the post-purchase page](#7-enable-the-post-purchase-page)
8. [Set APP_URL in the post-purchase extension](#8-set-app_url-in-the-post-purchase-extension)
9. [Configure the thank-you extension](#9-configure-the-thank-you-extension)
10. [Test with Shopify's test credit card](#10-test-with-shopifys-test-credit-card)
11. [Deploy the extensions](#11-deploy-the-extensions)
12. [Production hosting](#12-production-hosting)
13. [Switch the database to Postgres](#13-switch-the-database-to-postgres)
14. [Protected customer data access](#14-protected-customer-data-access)
15. [Network access approval (thank-you extension)](#15-network-access-approval-thank-you-extension)
16. [Payment method support](#16-payment-method-support)
17. [Testing checklist](#17-testing-checklist)
18. [Troubleshooting](#18-troubleshooting)
19. [GDPR / privacy notes](#19-gdpr--privacy-notes)
20. [Known dependency advisories](#20-known-dependency-advisories)
21. [The offer copy JSON contract (prompt editing)](#21-the-offer-copy-json-contract-prompt-editing)

---

## 1. Prerequisites

- **Node.js 20.10+** (`package.json` enforces `"node": ">=20.10"`). Check with
  `node --version`.
- **Shopify CLI** v3.60+ / v4 (the repo pins `@shopify/cli ^4.0.0` as a dev
  dependency, so `npm install` also gives you a local copy runnable via
  `npx shopify`). Global install: `npm install -g @shopify/cli`.
- **A Shopify Partner account** — <https://partners.shopify.com>.
- **A development store** with **checkout** capability (create one in the
  Partner Dashboard → Stores → Add store → Development store). Post-purchase
  offers require a store where you can complete test payments.
- **An Anthropic API key** for AI copywriting —
  <https://console.anthropic.com/> → API Keys. The app works without it
  (deterministic fallback copy), but AI copy is the point.
- Optional: a **DeepL API key** if you prefer DeepL over Claude for translating
  the static buyer-facing UI strings.

## 2. Create the app in the Partner Dashboard

1. Partner Dashboard → **Apps** → **Create app** → **Create app manually**.
2. Name it (e.g. `Cellexia Post-Purchase Upsell`). The URLs can be placeholders
   — the CLI overwrites them during development
   (`automatically_update_urls_on_dev = true` in `shopify.app.toml`).
3. Note the **Client ID** and **Client secret** (Overview / Settings page of
   the app). You will not usually need to copy them by hand — step 3 below
   pulls them in — but you need them for production env vars later.

## 3. Link the repo to the app

From the repo root:

```bash
shopify app config link
# or, using the repo-local CLI after npm install:
npm run config:link
```

Pick your organization and the app you created. This rewrites
`shopify.app.toml` with the real `client_id` and keeps `application_url` /
`redirect_urls` in sync while `shopify app dev` runs.

What's already configured in `shopify.app.toml` (do not remove):

- `embedded = true` — the admin UI runs embedded in the Shopify admin.
- `[access_scopes] scopes = "read_products,read_orders,read_inventory,read_locales,read_markets,write_discounts"`
- `[webhooks] api_version = "2026-01"` with subscriptions for
  `app/uninstalled`, `app/scopes_update`, `orders/create`, `products/create`,
  `products/update`, `products/delete`, and the three GDPR compliance topics —
  all delivered to `/webhooks` (handled by `app/routes/webhooks.tsx`).
- `include_config_on_deploy = true` — `shopify app deploy` pushes this config
  (scopes, webhook subscriptions) to Shopify, so webhooks need no manual
  registration.

`shopify.web.toml` tells the CLI how to run the web process:
`predev = "npx prisma generate && npx prisma db push"` (so the SQLite schema is
always up to date before dev starts) and `dev = "npx remix vite:dev"`.

## 4. Environment variables (.env)

```bash
cp .env.example .env
```

| Variable | Required | Where it comes from |
|---|---|---|
| `SHOPIFY_API_KEY` | prod | The app's **Client ID** — Partner Dashboard → your app → Overview. In dev, `shopify app dev` injects it automatically; you can leave it blank in `.env`. |
| `SHOPIFY_API_SECRET` | prod | The app's **Client secret** — same page. Also injected by the CLI in dev. Used to verify post-purchase JWTs and sign changesets, so it must be set (by CLI or env) wherever the app runs. |
| `SHOPIFY_APP_URL` | prod | The app's public HTTPS URL. In dev the CLI provides a tunnel URL automatically. In production: your host URL, e.g. `https://cellexia-upsell.fly.dev`. |
| `SCOPES` | prod | `read_products,read_orders,read_inventory,read_locales,read_markets,write_discounts` — must match `shopify.app.toml`. |
| `DATABASE_URL` | always | Dev default: `file:dev.sqlite` (SQLite, zero setup). Production: a Postgres connection string — see [§13](#13-switch-the-database-to-postgres). |
| `ANTHROPIC_API_KEY` | strongly recommended | <https://console.anthropic.com/> → API Keys. **The Shopify CLI does not inject this** — set it in `.env` even in dev, or all copy falls back to the deterministic non-AI templates. |
| `DEEPL_API_KEY` | optional | <https://www.deepl.com/pro-api>. Only used when the admin sets Settings → AI → Translation provider to DeepL. Keys ending in `:fx` are free-plan keys — the app automatically uses the `api-free.deepl.com` host for those. |

> **Dev vs prod:** during `shopify app dev` the CLI supplies
> `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` and `SCOPES` to
> the process itself. The only variables you genuinely must put in `.env` for
> local development are `DATABASE_URL` (already defaulted in `.env.example`)
> and `ANTHROPIC_API_KEY`.

## 5. Install and run locally

```bash
npm install        # also runs `prisma generate` via postinstall
npm run setup      # prisma generate && prisma db push  → creates dev.sqlite
npm run dev        # shopify app dev
```

`npm run dev` starts the Remix server behind a Shopify-managed tunnel, watches
both extensions, and prints a preview URL. Keep it running for the next steps.

Schema changes are applied the same way: re-run `npm run setup` (i.e.
`prisma db push`) after pulling updates. The schema has grown since the
initial release — e.g. the `EventDedup` replay-guard table, and more recently
two `ProductCache` columns: `descriptionFull` (the full plain-text Shopify
product description, synced and capped at ~12,000 chars) and `aiDescription`
(merchant-written AI context from the admin's Products tab, which overrides
the Shopify description as copywriting grounding when non-empty) — and
`prisma db push` adds any missing tables/columns without touching existing
data. (During `npm run dev` the `predev` hook in `shopify.web.toml` does this
automatically.) After pulling the `ProductCache` change, run a catalog
**Sync** from the dashboard once so `descriptionFull` gets populated for
existing products.

## 6. Install on a development store

1. When `shopify app dev` starts it asks which store to use — pick your dev
   store (or pass `--store your-store.myshopify.com`).
2. Open the printed preview URL and click **Install app**.
3. On install, the `afterAuth` hook in `app/shopify.server.ts` runs
   `bootstrapShop` (`app/services/bootstrap.server.ts`) in the background:
   it creates the shop row, seeds the AI prompt templates, syncs the store's
   published locales and Markets, seeds buyer-facing UI strings for every
   language, and syncs the product catalog into `ProductCache`.
4. Open the app in the store admin. The **Dashboard** shows a setup checklist:
   catalog synced, `ANTHROPIC_API_KEY` present, rules/auto-pilot status, and
   the two reminders below (post-purchase page selection, payment-method
   coverage). If the catalog shows as not synced, press the dashboard's
   **Sync** action (it re-runs `syncCatalog` + `syncMarketsAndLocales`).

Catalog freshness after install is two-speed by design: a `products/create` /
`products/update` webhook refreshes **that product's** cache row — including
its Translate & Adapt translated names — while the full **Sync** refreshes
everything (all products, full descriptions, and every language's translated
names). Day-to-day product edits take care of themselves; run a full Sync
after bulk imports or bulk translation work in Translate & Adapt.

## 7. Enable the post-purchase page

Shopify only renders ONE app on the post-purchase page, and the merchant must
select it explicitly:

1. Store admin → **Settings → Checkout**.
2. Scroll to **Post-purchase page**.
3. Select **Cellexia Post-Purchase Upsell** (the app must be installed and the
   post-purchase extension must be available — during `shopify app dev` it is
   served automatically; in production it must have been deployed, see §11).
4. Save.

If this step is skipped, `Checkout::PostPurchase::ShouldRender` never runs and
no offer can ever appear — it is the single most common "offer not showing"
cause.

## 8. Set APP_URL in the post-purchase extension

The post-purchase extension runs inside Shopify's checkout sandbox and needs
the absolute URL of your backend. Open
`extensions/post-purchase-upsell/src/index.jsx` — at the top of the file:

```js
const APP_URL = "https://REPLACE-WITH-YOUR-APP-URL.example.com";
```

- **During `shopify app dev`** you must set this to the tunnel URL the CLI
  prints (it changes between runs unless you configure a static tunnel). The
  extension cannot read env vars — this constant is the only wiring.
- **Before `shopify app deploy`** (production), set it to your permanent
  production URL (e.g. `https://cellexia-upsell.fly.dev`) — the deployed
  extension bundle bakes this string in. If you forget, `ShouldRender`'s fetch
  fails, the try/catch returns `{ render: false }`, and buyers silently never
  see offers.

The extension calls three endpoints on that host, all implemented in this
repo: `POST /api/offer` (`app/routes/api.offer.tsx`),
`POST /api/sign-changeset` (`app/routes/api.sign-changeset.tsx`) and
`POST /api/events` (`app/routes/api.events.tsx`). All are authenticated with
the JWT Shopify hands the extension (`inputData.token`) — see
[ARCHITECTURE.md](ARCHITECTURE.md#security-model).

## 9. Configure the thank-you extension

The thank-you extension (`extensions/thank-you-upsell/`) is a checkout UI
extension targeting `purchase.thank-you.block.render`. Unlike the
post-purchase extension it is a **block the merchant places in the checkout
editor**, and its backend URL is a merchant-editable setting:

1. Store admin → **Settings → Checkout** → click **Customize** on the
   published checkout profile.
2. In the editor, switch the page selector (top center) to **Thank you**.
3. **Add app block** → pick **Cellexia Thank You Upsell** and place it in the
   order summary/main column.
4. Select the block; in the settings panel on the right, set **App URL**
   (the `app_url` field from `extensions/thank-you-upsell/shopify.extension.toml`)
   to the same URL as `APP_URL` above. Optionally set a title override.
5. **Save** the checkout profile.

The block calls `POST /api/typ-offer` (`app/routes/api.typ-offer.tsx`) with the
buyer session token; the server responds with a single offer plus a one-time
48-hour discount code and a prefilled cart permalink. It renders for **all**
payment methods, which is exactly why it exists (see §16).

## 10. Test with Shopify's test credit card

Post-purchase offers only trigger on **card** payments, so you must test with
a test card — not a manual/COD order:

1. On the dev store: **Settings → Payments**. Either:
   - **Shopify Payments in test mode**: activate Shopify Payments, then enable
     **Test mode**; or
   - the **Bogus Gateway** ("Shopify's test gateway" under third-party
     providers), available on development stores.
2. Place an order on the storefront and pay:
   - Shopify Payments test mode: card number `4242 4242 4242 4242`, any future
     expiry, any 3-digit CVC, any name/ZIP.
   - Bogus Gateway: card number `1`, any expiry/CVC.
3. After clicking **Pay now**, the post-purchase offer page appears **between
   payment and the thank-you page**. Accepting adds the variant to the same
   order with the discount, charged to the same (test) card.
4. Continue to the thank-you page to also see the fallback block (if you added
   it in §9).

Notes:

- Orders under $0.50, gift-card-only payments and local delivery never get a
  post-purchase page (platform rule).
- The frequency cap applies to test customers too: by default a customer who
  saw an offer is not shown another for 14 days (`frequencyCapDays`). Test as
  guest, use different customer emails, or lower the cap in Settings.

You don't need a test order just to look at offers and copy: the admin's
**Preview** page (`/app/preview`, route `app/routes/app.preview.tsx`)
simulates a purchase — basket, country, language, device — through the
**production pipeline** (real `selectOffers`, real AI copy generation) and
renders the result. It records no analytics events and cleans up the
`IssuedOffer` rows it creates, so previews never pollute stats and can never
be accepted by a buyer. Test-card orders are still required to verify the
end-to-end mechanics (changeset signing, payment, webhooks, events).

## 11. Deploy the extensions

When the extension code and configuration are final (APP_URL set!):

```bash
npm run deploy        # = shopify app deploy
```

This creates a new app version containing both extensions **and** the config
in `shopify.app.toml` (scopes + webhook subscriptions, because
`include_config_on_deploy = true`), and releases it. Re-run after every
extension change; the hosted Remix app deploys separately (§12).

### Extension bundle size limits

Shopify enforces file-size limits on deployed extension bundles (not on the
Remix app — that runs on your own hosting):

| What | Limit | This app (measured, minified + deps) |
|---|---|---|
| UI extension bundle, API version **2025-10 and later** | **64 KB gzipped** (hard, at deploy) | thank-you: ~39 KB gzipped ✓ |
| UI extension bundle, API version 2025-07 (what we ship) | 2 MB | thank-you: ~123 KB raw ✓ |
| Post-purchase extension script (`checkout_post_purchase`) | 2 MB-era limits (not under the new 64 KB rule) | ~118 KB raw / ~36 KB gzipped ✓ |
| Locale files per extension | 256 KB total | 269 bytes ✓ |

Check a built bundle the way Shopify staff recommend:

```bash
gzip -c extensions/<name>/dist/<file>.js | wc -c
```

Both extensions are comfortably inside today's limits **and** inside the
stricter 64 KB-gzipped rule that applies when you upgrade the thank-you
extension's `api_version` to 2025-10+. If a future dependency pushes a bundle
over, the levers are: audit imports (`npx esbuild <entry> --bundle --minify
--analyze`), avoid adding client-side libraries to extensions, and as a last
resort rewrite the extension against the vanilla (non-React)
`@shopify/ui-extensions` API, which removes react + react-reconciler
(~60 KB raw) from the bundle.

Note: `extensions/thank-you-upsell/package.json` deliberately lists
`react-reconciler` — it is a required peer of the React bindings that npm does
not reliably auto-install in this workspace layout, and the deploy-time bundler
fails without it. Don't remove it.

## 12. Production hosting

The web app is a standard Remix (Vite) Node server:

- Build: `npm run build` (→ `build/`)
- Start: `npm run start` (= `remix-serve ./build/server/index.js`, listens on
  `PORT`, default 3000)

### Option A — Fly.io walkthrough

```bash
# 1. Install flyctl and log in
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From the repo root, scaffold (generates fly.toml + a Node Dockerfile)
fly launch --no-deploy
#    - pick an app name, e.g. cellexia-upsell  → https://cellexia-upsell.fly.dev
#    - pick a region close to the store's customers (e.g. cdg/ams for EU)
#    - say NO to deploying immediately

# 3. Provision Postgres (recommended over SQLite-on-a-volume; see §13)
fly postgres create --name cellexia-upsell-db
fly postgres attach cellexia-upsell-db     # sets DATABASE_URL as a secret

# 4. Set the remaining secrets
fly secrets set \
  SHOPIFY_API_KEY="<client id>" \
  SHOPIFY_API_SECRET="<client secret>" \
  SHOPIFY_APP_URL="https://cellexia-upsell.fly.dev" \
  SCOPES="read_products,read_orders,read_inventory,read_locales,read_markets,write_discounts" \
  ANTHROPIC_API_KEY="<key>"
# optional: DEEPL_API_KEY="<key>"

# 5. Deploy
fly deploy
```

If `fly launch` did not generate a Dockerfile you're happy with, this minimal
one works (place it at the repo root):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npx prisma generate
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]
```

(`prisma db push` on boot keeps the schema in sync; for stricter setups run it
as a Fly release command instead.)

After the first deploy, point Shopify at the production URL:

1. Edit `shopify.app.toml`: set `application_url` to
   `https://cellexia-upsell.fly.dev` and update the three `redirect_urls` to
   the same host. (Alternatively manage a separate production config with
   `shopify app config link` and multiple toml files.)
2. Set `APP_URL` in `extensions/post-purchase-upsell/src/index.jsx` to the
   production URL, and the thank-you block's App URL in the checkout editor.
3. `npm run deploy` to release the config + extensions.
4. Reinstall / open the app once so OAuth completes against the new URL.

### Option B — any Node host (Render, Railway, Heroku, a VM…)

1. Node 20.10+, HTTPS termination in front (Shopify requires HTTPS).
2. Set env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`,
   `SCOPES`, `DATABASE_URL`, `ANTHROPIC_API_KEY` (+ `DEEPL_API_KEY`).
3. Build & run:

   ```bash
   npm ci
   npx prisma generate
   npx prisma db push        # creates/updates the schema
   npm run build
   npm run start             # respects $PORT
   ```

4. Update `shopify.app.toml` URLs and the extension `APP_URL` as in Option A,
   then `npm run deploy`.

Keep exactly **one** primary region/instance if you stay on SQLite (single
writer file DB); with Postgres you can scale instances freely — the app is
otherwise stateless (sessions and all state live in the DB).

## 13. Switch the database to Postgres

The schema was written to be portable: all JSON payloads are `String` columns
(see the header comment in `prisma/schema.prisma`), so the switch is
three steps and **no model changes**:

1. In `prisma/schema.prisma`, change the datasource:

   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. Set `DATABASE_URL` to your Postgres connection string, e.g.
   `postgres://user:pass@host:5432/cellexia?sslmode=require`.
3. Push the schema:

   ```bash
   npx prisma db push
   ```

Do this **before** going to production. SQLite is for development; it does not
survive most container redeploys and cannot serve multiple instances.

## 14. Protected customer data access

The app subscribes to `orders/create` and requests `read_orders` — Shopify
classifies order/customer data as **protected customer data**, which affects
how you distribute the app:

- **Custom / single-merchant distribution (recommended for cellexialabs.com):**
  a custom app installed on the merchant's own store does not go through app
  review, and protected customer data approval is not required. If you choose
  this, also change `distribution: AppDistribution.AppStore` to
  `AppDistribution.SingleMerchant` in `app/shopify.server.ts`, and select
  custom distribution in the Partner Dashboard (Apps → your app →
  Distribution). Note: distribution choice is permanent per app.
- **Public (App Store) distribution:** you must request access in the Partner
  Dashboard → your app → **API access** → **Protected customer data access**:
  request the "Protected customer data" (orders) level, plus the specific
  fields used — this app stores customer **ID** and shipping **country code**
  only (see `OrderRecord` in `prisma/schema.prisma`; it keeps no names,
  emails, or addresses). Fill in the data-protection questionnaire and pass
  app review. Until approval, `orders/create` webhooks and order queries
  return redacted/denied data on non-development stores.

Development stores are exempt, so everything works in dev either way.

## 15. Network access approval (thank-you extension)

`extensions/thank-you-upsell/shopify.extension.toml` declares:

```toml
[extensions.capabilities]
network_access = true
```

Checkout UI extensions need Shopify's approval to use `fetch`. Request it in
the Partner Dashboard → your app → **API access** → **Allow network access in
checkout UI extensions** (provide a short justification: "fetch a personalized
post-purchase offer + one-time discount code from the app backend"). On
development stores the capability works without approval, so you can build and
test first. Without approval in production the block's fetch fails and the
component renders nothing (it fails silent by design).

The **post-purchase** extension does **not** need this toggle — post-purchase
extensions may call external APIs natively.

## 16. Payment method support

Shopify renders the post-purchase page **only for plain credit-card payments**
(Shopify Payments and a small set of card gateways). This is a platform
limitation — documented at
<https://shopify.dev/docs/apps/build/checkout/product-offers/post-purchase> —
and no app can bypass it. That is exactly what the thank-you fallback is for:

| Payment method | Post-purchase upsell (one-click, same card) | Thank-you fallback (discount code) |
|---|---|---|
| Credit / debit card via Shopify Payments | ✓ | ✓ (post-purchase takes precedence in practice) |
| Credit card via supported third-party gateways | ✓ | ✓ |
| Apple Pay | ✗ | ✓ |
| Google Pay | ✗ | ✓ |
| Shop Pay Installments / Klarna / other installments | ✗ | ✓ |
| PayPal | ✗ | ✓ |
| Gift-card-only orders, orders < $0.50, local delivery | ✗ | ✓ |

Set expectations with the merchant accordingly: the share of orders that can
see the one-click page equals the share paid by plain card.

## 17. Testing checklist

Work through this on a dev store before go-live:

- [ ] `npm run dev` runs clean; app installs; dashboard loads with the setup
      checklist all green (catalog synced, AI key present).
- [ ] Dashboard **Sync** action refreshes the catalog and markets without error.
- [ ] **Single-product order** (test card) → exactly **1** offer page appears.
- [ ] **Multi-product order** (2+ distinct products) → up to **3** offers,
      one page at a time, with "Offer x of y" in the banner.
- [ ] **Accept** adds the variant to the same order (check the order in admin:
      extra line item with the % discount) with no re-entry of payment.
- [ ] **Decline** advances to the next offer or completes the order.
- [ ] Countdown appears (default 10 min) and the page closes on expiry.
- [ ] Offered products are never products already in the order.
- [ ] Analytics shows the impressions/accepts/declines from your tests within
      a minute; revenue and GP look plausible.
- [ ] Second order with the **same customer** within the cap window → **no**
      offer (frequency cap works). As guest / different email → offer shows.
- [ ] A rule with a product trigger fires only on matching orders; delete or
      disable it → auto-pilot still offers something sensible.
- [ ] Bundle mode rule shows all products on one page with a single
      "Add all to my order" button.
- [ ] Store language switched (e.g. French storefront) → offer copy and all
      buttons/labels are in that language.
- [ ] **Preview page** (`/app/preview`): generate an advanced preview in 2–3
      languages and verify translated product names and copy in each.
- [ ] Thank-you block renders on the thank-you page, shows a discount code,
      and its CTA opens a cart link with the code applied.
- [ ] Thank-you block appears for a wallet-paid order (or simulate by only
      checking the thank-you page), proving the fallback path.
- [ ] Analytics → Export CSV downloads valid files for offers and events.
- [ ] `shopify app webhook trigger --topic=orders/create` (or a real order)
      creates an `OrderRecord`; GDPR topics return 200:
      `shopify app webhook trigger --topic=customers/redact`.
- [ ] With `ANTHROPIC_API_KEY` removed, offers still render with fallback copy
      (no 500s, no blank page).

## 18. Troubleshooting

### Setup / build failures

| Symptom | Cause & fix |
|---|---|
| `npm run setup` or `npm run dev` fails with `Validation Error Count: 1 [Context: getConfig]` / `Environment variable not found: DATABASE_URL` | No `.env` file yet. Since v1.4 the setup scripts create one automatically from `.env.example`; on older copies run `cp .env.example .env` first. |
| `shopify app dev` exits complaining about the client ID / can't find the app | `shopify.app.toml` still has the placeholder `client_id`. Run `shopify app config link` (§3) after creating the app in the Partner Dashboard — the CLI fills it in. |
| Extension bundling fails resolving `react-reconciler` | Run `npm install` from the repo root (workspaces install it); the dependency is pinned in `extensions/thank-you-upsell/package.json` — do not remove it. |



### The post-purchase offer doesn't show

Check in this order — the first four cover ~90% of cases:

1. **Payment method.** Only plain credit-card payments qualify. Wallets
   (Apple Pay / Google Pay), PayPal, Klarna/installments, gift-card-only,
   orders under $0.50, and local delivery orders never see the page
   (see §16). Pay with the test card per §10.
2. **Post-purchase app not selected.** Settings → Checkout → Post-purchase
   page must have this app selected (§7). Only one app can occupy that slot.
3. **`APP_URL` wrong or stale.** The constant in
   `extensions/post-purchase-upsell/src/index.jsx` must be the URL currently
   serving the app. During dev the tunnel URL changes between CLI restarts —
   update the constant and let the CLI hot-reload the extension. On any fetch
   failure `ShouldRender` returns `{ render: false }` silently.
4. **App disabled.** Settings → General → "enabled" toggle
   (`settings.enabled`) turns everything off.
5. **Frequency cap.** If the buyer has a customer account and saw any offer
   in the last `frequencyCapDays` (default 14), they get nothing. Check
   `CustomerState` or test as a fresh customer.
6. **Market disabled.** Settings → Markets: if the destination country's
   market row is disabled, no offers there.
7. **No eligible products.** Everything was suppressed: products already in
   the order, products the customer bought within `suppressionDays`
   (default 60), non-ACTIVE products, variants with tracked inventory below
   `minInventory`, or price ≤ 0. A tiny dev catalog often trips this — add
   more active, in-stock products.
8. **Catalog not synced.** Dashboard checklist warns; press Sync. Products
   are served from the local `ProductCache`, not live from Shopify.
9. **Extension not deployed/released** (production): `npm run deploy` and
   confirm the new version is released in the Partner Dashboard.
10. **Server errors.** The public endpoints never 500 by design — they
    degrade to `{ offers: [] }`. So a "healthy but empty" response means an
    internal error was swallowed: check server logs for `[offer]`/`[engine]`
    prefixed errors.

### Accept button fails ("Something went wrong")

- The changeset token from `/api/sign-changeset` expires in **10 minutes**,
  and issued offers expire **2 hours** after creation — a buyer parked on the
  page too long gets an error; the original order is unaffected.
- `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` on the server must be the same app
  credentials the extension runs under — a mismatch makes signature
  verification fail.
- Check the order in admin: if the item was added but the UI errored, look
  for the `accepted` event in Analytics before retrying anything.

### Thank-you block doesn't render

- Block not added in the checkout editor, or checkout profile not saved (§9).
- **App URL** setting on the block is empty or wrong.
- `Settings → General → thank-you offers` disabled (`settings.thankYouEnabled`).
- Network access not approved for production (§15) — works on dev stores,
  silently fails live.
- The block renders `null` on any missing data by design; check the browser
  console on the thank-you page and server logs for `[typ-offer]`.
- Discount code creation requires the `write_discounts` scope — if the scope
  was added after install, reinstall/re-auth the app. If code creation fails
  the block still shows the offer with a plain product link (no code).

### Copy is in English on a non-English storefront

- The buyer's checkout `locale` is matched against Settings → Languages; add
  the locale (or its base language) there and make sure it's published in
  Shopify → Settings → Languages.
- UI strings (buttons/labels) come from the Translations page — run
  "Auto-translate missing".
- AI copy falls back to English-ish templates when `ANTHROPIC_API_KEY` is
  missing or Claude timed out (the response is cached in the background, so
  the *next* buyer in that language usually gets real copy).
- Product **names** inside the copy come verbatim from Shopify's Translate &
  Adapt — the AI never translates names itself. If a name shows untranslated,
  add the translation in Translate & Adapt, then either edit/save the product
  (the `products/update` webhook refreshes that product's translated names)
  or run the dashboard **Sync** (refreshes everything). The admin's Products
  tab shows per-product translated-name coverage badges.

### Webhooks not arriving

- Webhook subscriptions ship with the app config
  (`include_config_on_deploy = true`) — run `npm run deploy` after changing
  `shopify.app.toml`.
- Inspect delivery attempts: Partner Dashboard → your app → recent webhook
  metrics, or `shopify app webhook trigger` locally.
- The handler (`app/routes/webhooks.tsx`) always returns 200 even on internal
  errors (to avoid retry storms) — so "delivered but nothing happened" means
  a swallowed error: check logs for `[webhooks]`.

## 19. GDPR / privacy notes

- The app stores the minimum needed: customer **ID** (numeric Shopify ID) and
  shipping **country code** with orders/events — no names, emails, or
  addresses (`OrderRecord`, `OfferEvent`, `CustomerState` in
  `prisma/schema.prisma`).
- The three mandatory compliance webhooks are implemented in
  `app/routes/webhooks.tsx`:
  - `customers/data_request` → acknowledged and logged (the stored data is
    minimal; export from the DB by customer ID if the merchant asks).
  - `customers/redact` → `redactCustomer` in
    `app/services/bootstrap.server.ts` nulls/deletes customer-linked rows.
  - `shop/redact` → `redactShop` deletes every row for the shop.
- `app/uninstalled` deletes the shop's sessions but keeps data for a
  potential reinstall; `shop/redact` (sent by Shopify ~48h later) performs the
  actual purge.
- AI note for the privacy policy: product titles/types and basket composition
  are sent to Anthropic (and optionally DeepL) to generate copy — **no
  personal data** is included in prompts.

## 20. Known dependency advisories

`npm audit` currently reports advisories in Remix 2.x's bundled
`react-router` 6 / `turbo-stream` packages:

- an open redirect via a backslash-prefixed URL in `Link` / `useNavigate`;
- a denial-of-service in the single-fetch request handling;
- a `deserializeErrors` issue during single-fetch hydration.

How they apply to this app:

- The app does **not** enable the `v3_singleFetch` future flag (see
  `vite.config.ts`), so the vulnerable single-fetch / `turbo-stream` path is
  not used at runtime.
- The embedded admin does not navigate from user-supplied URLs, which the
  open-redirect advisory requires.
- There is **no non-breaking upstream fix within Remix 2** — the advisories
  are fixed in React Router 7.17.1+. The long-term remediation is migrating
  the app shell from Remix 2 to React Router 7; the app code itself
  (services, routes, extensions) is unaffected by that migration.

Re-run `npm audit` periodically and reassess whenever new advisories appear.

## 21. The offer copy JSON contract (prompt editing)

The prompt templates (admin → Prompts) instruct the model to return **only
minified JSON**. If you edit or rewrite a prompt, the output shape you must
preserve is (authoritative type: `OfferCopy` in `app/types.ts`):

```json
{
  "headline": "…",
  "body": "…",
  "bullets": ["…", "…", "…"],
  "paragraphs": ["…", "…"],
  "proof": ["…", "…"],
  "closer": "…",
  "discount_suggestion": null
}
```

| Field | What it is | Where it renders |
|---|---|---|
| `headline` | The hook | Top of the offer page |
| `body` | The **lead** — the promise, 1–2 sentences | Above the fold, next to the CTA |
| `bullets` | 3–4 concrete fact bullets | Under the lead |
| `closer` | One-line premium reassurance | Directly **above the buttons** |
| `paragraphs` | 2–3 short paragraphs — mechanism / proof / relevance-to-order | **Below the CTA**, under the "Why it works with your order" heading (the translatable `why_it_works` UI string) |
| `proof` | 2–3 one-line **research statements** — established published findings about ingredients named in the brief; ingredient-level only, never product-level, no invented citations | Under the paragraphs, beneath the "What published research shows" subheading (the translatable `research_shows` UI string) |
| `discount_suggestion` | number or `null` | Not rendered — only honored when Settings → Discount mode is *AI-adjusted*, then clamped to the [min, max] band |

Rules that keep the pipeline healthy:

- `paragraphs`, `proof` and `closer` are **optional** in the type
  (`paragraphs?` / `proof?` / `closer?`) and are expected only for
  `{{length}}` = `long` (the default since `copyLength` moved to `"long"`).
  For `short`, the model should produce lead + bullets only. An empty or
  absent `paragraphs` simply hides the "Why it works" section on the offer
  page, and an empty or absent `proof` hides the research block — nothing
  breaks.
- Everything must be written in `{{language}}`, and product names must be
  used **verbatim** as given in the prompt — they come from Translate & Adapt
  and must never be re-translated by the model.
- The parser is defensive (strips code fences, seeks the first `{`), fields
  are validated/truncated, and every failure path degrades to deterministic
  fallback copy. A broken prompt never breaks checkout — it just wastes the
  AI call, so use the Prompts page's **Preview** after any edit.
