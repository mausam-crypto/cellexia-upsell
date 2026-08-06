# Architecture — Cellexia Post-Purchase Upsell

Technical reference for developers working on this codebase. Setup and
operations live in [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md); the
original build contract is [SPEC.md](../SPEC.md).

---

## 1. System overview

Three runtime pieces share one database:

```
┌────────────────────────────┐        ┌──────────────────────────────────┐
│  Shopify checkout sandbox  │        │  Remix app (Node 20, Vite build) │
│                            │        │                                  │
│  post-purchase extension   │ HTTPS  │  /app/*      embedded admin UI   │
│  (React 17, Checkout::     │───────▶│  /api/*      public JWT-verified │
│   PostPurchase::*)         │        │              endpoints           │
│                            │        │  /webhooks   Shopify webhooks    │
│  thank-you extension       │───────▶│  /auth/*     OAuth               │
│  (React 18, checkout UI    │        │                                  │
│   extension, thank-you     │        │  app/services/*  domain logic    │
│   block)                   │        └───────────┬──────────────────────┘
└────────────────────────────┘                    │ Prisma
                                                  ▼
                              ┌──────────────────────────────────┐
                              │  SQLite (dev) / Postgres (prod)  │
                              └──────────────────────────────────┘
                                                  ▲
        Shopify Admin GraphQL  ◀──────────────────┘  (catalog sync, markets,
        Anthropic API, DeepL API                      discount codes, AI copy)
```

- The **Remix app** is both the embedded admin (Polaris v13 + App Bridge v4)
  and the API backend for the two extensions. It is stateless — all state is
  in the DB — so it scales horizontally once on Postgres.
- The **post-purchase extension** renders Shopify's between-payment-and-thank-
  you page for card payments and applies accepted offers to the *same order*
  via signed changesets.
- The **thank-you extension** is the fallback surface for all payment methods:
  it shows one offer with a single-use 48h discount code and a cart permalink.

Multi-tenancy: every table and every service function is keyed by `shop`
(the `*.myshopify.com` domain). There are no hardcoded shop domains.

## 2. Repository map

```
app/
  shopify.server.ts                shopifyApp() config: OAuth, Prisma session
                                   storage, afterAuth → bootstrapShop()
  db.server.ts                     Prisma client singleton
  types.ts                         All shared domain types, DEFAULT_SETTINGS,
                                   DEFAULT_UI_STRINGS_EN, language catalog
  entry.server.tsx, root.tsx       Remix boilerplate
  lib/
    json.ts                        jparse/jstr (JSON-in-string columns),
                                   deepMerge, gidToNumber, toGid
  services/
    settings.server.ts             getSettings/saveSettings (deep-merge over
                                   DEFAULT_SETTINGS), ensureShop
    catalog.server.ts              syncCatalog, syncMarketsAndLocales, webhook
                                   upsert/delete, product lookups
    bootstrap.server.ts            bootstrapShop (post-install seed + sync),
                                   redactCustomer/redactShop (GDPR)
    recommendation.server.ts       selectOffers (rules → bandit → auto-pilot),
                                   resolveDiscountPct, autoPickWinners,
                                   resetExperimentStats
    ai.server.ts                   DEFAULT_PROMPTS, claudeComplete, generateCopy
                                   (+ CopyCache), fallbackCopy, UI-string
                                   seeding/lookup/translation, DeepL client
    analytics.server.ts            recordExtensionEvent, recordOrderFromWebhook,
                                   dashboard stats, time series, breakdowns,
                                   experiment posteriors, CLV cohorts, toCsv
    offer-orchestrator.server.ts   assembleOfferResponse / assembleThankYouOffer
                                   (language resolution, copy, IssuedOffer)
  routes/
    app.tsx                        Embedded app frame + nav
    app._index.tsx                 Dashboard (KPIs, chart, checklist, sync)
    app.analytics.tsx              Analytics + CSV export
    app.offers._index.tsx          Rules list
    app.offers.$id.tsx             Rule editor ("new" = create)
    app.preview.tsx                Offer preview sandbox — runs the production
                                   pipeline, cleans up its IssuedOffer rows,
                                   records no analytics
    app.products.tsx               Products tab: AI-context editor +
                                   translated-name coverage
    app.prompts.tsx                Prompt templates + live preview
    app.settings.tsx               Settings sections
    app.translations.tsx           UI-string editor + auto-translate
    api.offer.tsx                  POST: offers for a post-purchase checkout
    api.sign-changeset.tsx         POST: JWT for applyChangeset (server-side
                                   validated against IssuedOffer)
    api.events.tsx                 POST: impression/accepted/declined/error
    api.typ-offer.tsx              POST: thank-you offer + discount code
    webhooks.tsx                   All webhook topics incl. GDPR
    auth.$.tsx, _index.tsx         OAuth + login redirect
  components/
    MiniChart.tsx                  Dependency-free SVG sparkline/area chart
extensions/
  post-purchase-upsell/
    shopify.extension.toml         type = "checkout_post_purchase"
    package.json                   react ^17.0.2 (hard peer dep of the
                                   post-purchase UI kit — do not bump)
    src/index.jsx                  ShouldRender + Render app; APP_URL constant
  thank-you-upsell/
    shopify.extension.toml         type = "ui_extension", api_version 2025-07,
                                   target purchase.thank-you.block.render,
                                   network_access = true, app_url setting
    package.json                   react ^18, @shopify/ui-extensions-react
    src/ThankYou.jsx               reactExtension block
    locales/en.default.json        extension name + static fallbacks
prisma/schema.prisma               Schema (SQLite dev / Postgres prod)
shopify.app.toml                   Scopes, webhooks (api 2026-01), URLs
shopify.web.toml                   CLI: predev prisma, dev remix vite:dev
.env.example                       Documented env vars
```

## 3. Data flows

### 3.1 Post-purchase offer (happy path)

```
Buyer pays by card
        │
        ▼
Checkout::PostPurchase::ShouldRender            extensions/post-purchase-upsell/src/index.jsx
  POST ${APP_URL}/api/offer
  Authorization: Bearer inputData.token  ──▶  app/routes/api.offer.tsx
                                                authenticate.public.checkout(request)
                                                  → verifies JWT (app secret), gives cors()
                                                build PurchaseContext from
                                                sessionToken.input_data.initialPurchase
                                                  (numeric ids → gids via toGid)
                                                        │
                                                        ▼
                                        offer-orchestrator.assembleOfferResponse
                                          ├─ settings.server.getSettings(shop)
                                          ├─ recommendation.selectOffers(ctx, settings)
                                          │    frequency cap → market → suppression
                                          │    → rule match (bandit) | auto-pilot
                                          │    → discount → display mode
                                          ├─ language resolution (market override →
                                          │    locale match → default)
                                          ├─ ai.getUiStrings(shop, language)
                                          ├─ ai.generateCopy(...)  [CopyCache | Claude
                                          │    | fallback + background warm]
                                          └─ persist IssuedOffer (changesJson,
                                               offerMetaJson, expiresAt = now+2h)
                                                        │
  storage.update(OfferResponse)  ◀─────  cors(json(OfferResponse))
  render: offers.length > 0
        │
        ▼
Render app (per offer page)
  mount → calculateChangeset({changes})   (accurate presentment totals)
        → POST /api/events {impression}
  accept → POST /api/sign-changeset {referenceId, offerId}
              └▶ api.sign-changeset.tsx: load *non-expired* IssuedOffer,
                 jwt.sign({iss: API_KEY, jti, sub: referenceId,
                           changes: <from DB>}, API_SECRET, 10m)
         → applyChangeset(token)          (Shopify adds item to the SAME order)
         → POST /api/events {accepted, revenue}   (client revenue is ignored —
                                           the server recomputes it from the
                                           stored IssuedOffer meta)
         → next page | done()
  decline → POST /api/events {declined} → next page | done()
```

Shop Pay caveat: `Render` may not see what `ShouldRender` stored — the render
app re-fetches `/api/offer` in a `useEffect` when `storage.initialData` is
empty.

### 3.2 Thank-you fallback

```
Thank-you page loads (any payment method)
        │
extensions/thank-you-upsell/src/ThankYou.jsx
  reads merchant setting app_url, buyer sessionToken, lines/cost/locale
  POST ${app_url}/api/typ-offer  (Bearer session token)
        │
        ▼
app/routes/api.typ-offer.tsx
  authenticate.public.checkout → shop from sessionToken.dest
  settings.thankYouEnabled? ── no ──▶ { offer: null }
  ctx (surface "thank_you", referenceId "typ:<orderId|uuid>")
  assembleThankYouOffer
    ├─ selectOffers (max 1 offer on this surface)
    ├─ generateCopy
    ├─ unauthenticated.admin(shop) → GraphQL discountCodeBasicCreate
    │    code THANKYOU-XXXXXX, pct off, once per customer, usageLimit 1,
    │    48h expiry, scoped to the offered product
    │    (failure → offer still returned, no code, plain product URL)
    └─ checkoutUrl = https://<shop>/cart/<variantNumericId>:1?discount=<code>
        │
        ▼
Block renders offer; impression/accepted(click)/declined → POST /api/events
(surface "thank_you")
```

### 3.3 Webhooks

```
Shopify ──▶ POST /webhooks (app/routes/webhooks.tsx)
             authenticate.webhook(request)   ← HMAC verified by the library
  orders/create        → analytics.recordOrderFromWebhook
                          upsert OrderRecord + OrderLine[],
                          match accepted OfferEvents by order/reference id →
                          hadUpsellOffer / acceptedUpsell / line.isUpsell,
                          backfill OfferEvent.orderId
  products/create|update → catalog.upsertProductFromWebhook (ProductCache,
                          incl. refreshing that product's Translate & Adapt
                          translated names; a full sync refreshes everything)
  products/delete       → catalog.deleteProductFromWebhook
  app/uninstalled       → delete Sessions for shop (data kept for reinstall)
  customers/data_request→ log + 200 (minimal data held)
  customers/redact      → bootstrap.redactCustomer
  shop/redact           → bootstrap.redactShop (full purge)
  app/scopes_update     → update session scope
  (all handlers try/catch — always 200 to avoid retry storms)
```

Order history is what powers co-purchase affinity, "already owns it"
suppression, and CLV cohorts — the app never queries Shopify for orders at
offer time; everything is served from local tables in a single request cycle.

### 3.4 Install / bootstrap

```
OAuth afterAuth (app/shopify.server.ts)
  └▶ bootstrapShop(shop, admin)          fire-and-forget, never blocks install
       ├─ ensureShop                      Shop row + settings
       ├─ ensurePromptTemplates           seed single/bundle/sequential prompts
       ├─ syncMarketsAndLocales           published locales → settings.languages,
       │                                  Markets → MarketSetting rows
       ├─ ensureUiStrings(languages)      seed EN strings, auto-translate rest
       └─ syncCatalog                     paginated Admin GraphQL → ProductCache
                                          (+ per-locale title translations)
```

## 4. Database (prisma/schema.prisma)

JSON payloads are stored in `String` columns for SQLite/Postgres portability;
always read/write them with `jparse`/`jstr` from `app/lib/json.ts`.

| Model | Purpose |
|---|---|
| `Session` | Shopify OAuth sessions — required shape for `@shopify/shopify-app-session-storage-prisma`; never alter. |
| `Shop` | One row per installed shop. `settingsJson` holds a *partial* `AppSettings` that `getSettings` deep-merges over `DEFAULT_SETTINGS` (unset keys keep tracking defaults). `catalogSyncedAt` drives the dashboard checklist. |
| `ProductCache` | Local catalog: title/handle/type/vendor/status/tags/image, `descriptionShort` (~300 chars, basket summaries), `descriptionFull` (full plain-text Shopify description, capped ~12,000 chars), `aiDescription` (merchant-written AI context from the admin's Products tab), `variantsJson: CachedVariant[]` (price, compare-at, inventory, unit cost, sku), `translationsJson` per-locale titles from Translate & Adapt. Copywriting grounds each offered product in its **effective description**: `aiDescription` when non-empty, otherwise `descriptionFull`. Kept fresh by `products/*` webhooks (which refresh that product's row incl. translated names) + manual full sync. All offer selection reads this, never live Shopify. |
| `OfferRule` | Admin-defined rule: `triggerJson: RuleTrigger` (AND semantics, empty = any), priority (asc, first match wins), optional per-rule `displayMode` / `discountJson` / `copyLength` / `maxOffers`. |
| `OfferSlot` | One "page" position (1..3) in a rule's sequenced flow. Cascade-deleted with the rule. |
| `OfferCandidate` | A rotation candidate within a slot: product/variant, weight, enabled, running `impressions`/`accepts`/`revenue` counters (the Thompson-sampling posteriors), `isWinner` flag set by `autoPickWinners`. |
| `PromptTemplate` | Editable AI prompts per shop and key (`single`/`bundle`/`sequential`) with model/maxTokens (a legacy `temperature` column remains in the schema but is no longer surfaced in the admin or sent to the API). `version` bumps on save and is part of the copy cache key — editing a prompt invalidates cached copy. |
| `CopyCache` | Generated copy keyed by sha256 of (mode, offer variants, basket signature, language, length, discount, prompt version). Makes repeat baskets instant and cuts AI spend. |
| `IssuedOffer` | **Security-critical.** The server-side source of truth for what may be added to a checkout: `changesJson` (the exact changeset), `offerMetaJson` (denormalized context for analytics), `expiresAt` (now + 2h). `/api/sign-changeset` signs *only* what is stored here — never client input. Unique on `(referenceId, offerId)`. |
| `OfferEvent` | Append-only analytics stream: impression/accepted/declined/error with denormalized rule/candidate/product/price/discount/market/country/language/surface. Everything in Analytics is computed from this table (+ OrderRecord). |
| `EventDedup` | Race-proof replay guard for extension events: one claim per offer page and event type, unique on `(shop, referenceId, position, eventType)`, inserted in the **same transaction** as the `OfferEvent` rows — concurrent duplicates lose the insert and are dropped, and a failed write releases the claim instead of losing the event. Claims older than 7 days are pruned from the dashboard loader (replay protection only needs to outlive the offer TTL). |
| `OrderRecord` / `OrderLine` | Order history from `orders/create`: totals, currency, country, customer id, per-line product/variant/qty/price, `isUpsell` marking, `hadUpsellOffer`/`acceptedUpsell` flags. Powers co-purchase affinity, suppression, repeat-purchase rates and CLV cohorts. |
| `CustomerState` | Per-customer frequency capping: `lastOfferAt`, counters. Only exists for logged-in customers (guests can't be capped). |
| `MarketSetting` | Per-Shopify-Market overrides: enabled, discount %, language, max offers, `countriesJson`. Seeded from the Markets API; re-sync never overwrites admin-set overrides. |
| `UiString` | Buyer-facing static strings per (shop, language, key). Seeded from `DEFAULT_UI_STRINGS_EN`, editable, auto-translatable. Lookup falls back requested lang → base lang (`pt-PT`→`pt`) → `en` → compiled defaults, per key. |

## 5. The recommendation engine (technical)

`app/services/recommendation.server.ts` → `selectOffers(ctx, settings)`:

1. Kill switches: `settings.enabled`, frequency cap
   (`CustomerState.lastOfferAt` within `frequencyCapDays`, post-purchase
   surface), market disabled for `ctx.countryCode`.
2. Offer count: 1 distinct product in the order →
   `singleProductOrderOffers` (1), else `multiProductOrderOffers` (3);
   clamped by market override, rule `maxOffers`, hard cap 3, and 1 on the
   thank-you surface.
3. Suppression set: products in the order; the customer's purchases within
   `suppressionDays`; non-ACTIVE products; tracked inventory below
   `minInventory`; price ≤ 0.
4. **Rule path:** first enabled rule (priority asc) whose trigger matches
   (AND semantics). Per slot, one candidate is chosen by Thompson sampling —
   `Beta(accepts+1, impressions−accepts+1)` sampled via Marsaglia–Tsang gamma
   draws, multiplied by candidate weight and (for `gp_per_impression`) unit
   margin. A declared winner short-circuits the draw except with probability
   `explorationPct/100`.
5. **Auto-pilot path** (no rule matched): every eligible product is scored
   `weights · [compatibility, repeatPurchase, acceptance, margin]` where
   compatibility = 0.6·co-purchase P(candidate|basket product) (Laplace-
   smoothed over the most recent ≤5000 orders) + 0.25·type affinity
   (cross-type preferred) + 0.15·tag Jaccard; acceptance =
   (accepts+1)/(impressions+4) from `OfferEvent`; margin uses unit cost with a
   55%-of-price fallback. Final ordering by `optimizeMetric`, default
   expected GP/impression = acceptance × (discounted price − unit cost).
6. Discount via `resolveDiscountPct` (fixed / highest matching tier /
   AI-band midpoint, market override, clamped to [min,max], integer).
7. Display mode → one bundle `SelectedOffer` or N sequential ones. Assembly
   preserves the order the picks arrived in — rule offers keep the admin's
   slot-position order, auto-pilot offers keep the `optimizeMetric` ranking —
   and never re-sorts. Never more than 3 products total.

`autoPickWinners` runs opportunistically from the dashboard loader and from a
settings action: for each contested slot it Monte-Carlo estimates P(best) from
the Beta posteriors (2000 draws) and flags a winner at
`impressions ≥ minImpressionsToPick` and `P ≥ winnerConfidence`.

## 6. AI copy pipeline

`app/services/ai.server.ts`:

- `generateCopy` resolves the `PromptTemplate` for the mode, interpolates the
  `{{...}}` variables, and checks `CopyCache` by content hash.
- **Grounding precedence:** each offered product's description in the prompt
  is its *effective description* — `ProductCache.aiDescription`
  (merchant-written AI context, Products tab) when non-empty, otherwise
  `ProductCache.descriptionFull` (the synced full Shopify description).
- Cache miss → `claudeComplete` (plain `fetch` to
  `api.anthropic.com/v1/messages`, no SDK, `AbortSignal.timeout`), racing the
  configured `aiTimeoutMs` (default 2500 ms). No sampling parameters
  (`temperature`/`top_p`/`top_k`) are ever sent — newer Claude models reject
  them — so style is steered entirely through the prompts. The response must
  be minified JSON (`headline`, `body` = the lead, `bullets[3..4]`, plus
  `paragraphs[2..3]`, `proof[2..3]` (ingredient-level research statements) and
  `closer` for long copy, `discount_suggestion` — see
  IMPLEMENTATION_GUIDE §21 for the full contract); parsing is defensive
  (strips code fences, seeks the first `{`), fields are validated/truncated,
  then cached.
- Timeout/error → deterministic `fallbackCopy` built from UI strings and
  product titles is returned **immediately**, while the same generation is
  fired again *without* timeout in the background to warm the cache for the
  next buyer. The buyer-facing path never waits on the AI and never throws.
- `discount_suggestion` is only honored when `settings.discount.mode === "ai"`,
  and is clamped to the configured [min, max] band by the orchestrator.
- Translation of static UI strings goes through Claude or DeepL
  (`translationProvider`); the Claude path likewise sends no temperature
  parameter. DeepL keys ending `:fx` are routed to the free-tier host.

### 6.1 `OfferCopy` — the extended shape and where each part renders

`OfferCopy` (`app/types.ts`) is the contract between the copy pipeline and
both extensions. Relative to the CTA buttons, the parts render:

```
headline                          ─┐
body        (the lead — the       │  above the fold /
             promise, 1–2         │  next to the CTA
             sentences)           │
bullets     (3–4 fact bullets)    │
closer?     (one-line premium    ─┘  directly above the buttons
             reassurance)
[ CTA buttons ]
paragraphs? (2–3 short paragraphs:   below the CTA, under the
             mechanism / proof /     "why_it_works" UI-string heading
             relevance-to-order)     ("Why it works with your order")
proof?      (2–3 research            under the paragraphs, with its own
             statements —            "research_shows" UI-string subheading
             established findings    ("What published research shows")
             about ingredients
             named in the brief)
```

`paragraphs`, `proof` and `closer` are optional (`paragraphs?` / `proof?` /
`closer?`): empty or absent simply hides those pieces — which is exactly what
`copyLength: "short"` produces (lead + bullets only). The default
`copyLength` is `"long"` (`DEFAULT_SETTINGS` in `app/types.ts`), overridable
globally in Settings and per rule. Putting `paragraphs` **below** the CTA is
deliberate: the full persuasion argument is there for buyers who scroll,
while the button stays above the fold on mobile. The section headings are the
`why_it_works` and `research_shows` UI strings — seeded, editable and
translatable like every other `UiString`. The `why_it_works` heading renders
whenever paragraphs **or** proof are present, so the research subheading
never appears without its parent section.

`proof` is the **research block**: 2–3 statements of widely established
published findings, constrained to the ingredient level (never claims about
the product itself), to ingredients actually named in the product's grounding
text, and to citation-free phrasing (no invented studies, journals, or
percentages). The merchant-facing rules and the compliance note live in
MERCHANT_GUIDE ("The research block").

Full render order of a sequential post-purchase page (top → bottom), as
implemented in `extensions/post-purchase-upsell/src/index.jsx`:

1. `CalloutBanner` — `offer_badge` (+ `offer_x_of_y` when the flow has
   multiple pages)
2. Product image (left column on medium/large viewports)
3. `headline` → `body` (the lead) → `bullets`
4. Product title + price row — `was` (strikethrough) / `now` / `save_pct`
5. Trust lines — `ships_free`, `one_click_note` — and the countdown
   (`time_left` + mm:ss, when enabled)
6. Error banner (only after a failed accept)
7. `closer`
8. Accept + decline buttons
9. "Why it works with your order" (`why_it_works`) — the `paragraphs`
10. "What published research shows" (`research_shows`) — the `proof` lines,
    as bullets

The bundle page keeps the same tail (4→10, with a combined price row and one
accept-all button) but opens with per-product tiles (image, title, was/now
price) before the combined headline/lead/bullets.

### 6.2 Translated product names

Product names shown to buyers are never generated or translated by the model
— they flow verbatim from Shopify:

```
Translate & Adapt (merchant edits names per locale)
      │  Admin GraphQL: translations(locale:) per store language
      ▼
ProductCache.translationsJson   { [locale]: { title } }
      │
      ├─▶ prompt interpolation   (the model is instructed to use the
      │                           given name verbatim, never re-translate)
      └─▶ buyer payload          (SelectedOfferProduct.translatedTitle →
                                  the titles the extensions display)
```

Freshness: a `products/create|update` webhook refreshes **that product's**
translated names; a full catalog sync refreshes every product. The admin's
Products tab surfaces per-product translated-name coverage so missing locales
are visible before buyers see a default-language name.

## 7. The two extensions

| | post-purchase-upsell | thank-you-upsell |
|---|---|---|
| Type | `checkout_post_purchase` | `ui_extension`, target `purchase.thank-you.block.render` |
| UI kit | `@shopify/post-purchase-ui-extensions-react` (**React 17 peer dep** — its `package.json` must stay on `react ^17.0.2`) | `@shopify/ui-extensions-react@^2025.7.0` (React 18), toml `api_version = "2025-07"` |
| When it shows | Between payment and thank-you page; **card payments only** (platform rule) | On the thank-you page, all payment methods, where the merchant placed the block |
| Backend URL | `APP_URL` constant compiled into `src/index.jsx` | Merchant-set `app_url` settings field (checkout editor) |
| Auth to backend | `inputData.token` — a JWT Shopify signs with the app secret | Buyer session token from `useApi().sessionToken` |
| Accept mechanics | Signed changeset → `applyChangeset` → item added to the **same order**, same card | Single-use 48h discount code + `/cart/<variant>:1?discount=<code>` permalink (new checkout) |
| Offer count | Up to 3, sequential pages or one bundle page | Exactly 1 |
| Money display | `calculateChangeset({changes})` per page for exact presentment totals | Prices from the offer payload |
| Text | 100% from `OfferResponse.strings` + AI copy — no hardcoded buyer-facing English | Same (`strings`, `copy`), inline English fallbacks only |
| Failure mode | Any error → `{ render: false }` / banner; checkout never blocked | Any missing data or error → renders `null` |

## 8. Security model

- **Admin routes** (`/app/*`): `authenticate.admin(request)` — embedded-app
  session tokens verified by `@shopify/shopify-app-remix`; tenancy from
  `session.shop`. Sessions live in Prisma (`Session` model).
- **Public API routes** (`/api/*`): `authenticate.public.checkout(request)`
  verifies the `Authorization: Bearer <JWT>` — for the post-purchase surface
  that JWT is `inputData.token`, signed by Shopify with the **app secret**;
  its `input_data` claim is the trusted purchase context. The server derives
  the shop from the verified token (`input_data.shop.domain` / `dest`), never
  from the request body. Every response is wrapped in the library's `cors()`;
  each route's `loader` answers preflight.
- **Changeset signing is the core trust boundary.** The extension never sends
  what to add — it sends only `{ referenceId, offerId }`. `/api/sign-changeset`
  loads the matching, **non-expired** `IssuedOffer` row and signs the
  `changes` stored there (`jsonwebtoken`, `iss` = API key, `jti` = UUID,
  `sub` = referenceId, 10-minute expiry, HMAC with the app secret). A tampered
  client can therefore only apply exactly the offer (product, quantity 1,
  clamped discount) the server previously issued for that specific checkout,
  within a 2-hour window. Discounts are also server-clamped to the configured
  [min, max] before an offer is ever issued.
- **Event ingestion trusts nothing from the client.** `/api/events` only
  records events that match an `IssuedOffer` previously issued to that shop
  for `(referenceId, offerId)` — events for unknown offers are dropped
  entirely. Revenue and gross profit are computed **exclusively** from the
  stored `IssuedOffer` meta (client-reported revenue is logged for debugging
  and otherwise ignored), and replays are rejected via the `EventDedup`
  unique claim taken in the same transaction as the event rows.
- **Thank-you offers are idempotent per order.** The offer id is
  deterministic (`typ-<order id>`), so combined with `IssuedOffer`'s unique
  `(referenceId, offerId)` a refreshed or replayed `/api/typ-offer` request
  returns the already-issued offer instead of minting another discount code;
  code creation is additionally capped per shop per hour.
- **Webhooks**: HMAC-verified by `authenticate.webhook`; handlers are
  idempotent upserts.
- **Failure posture**: public endpoints never return 500 — internal errors are
  logged (`[module]` prefixes) and degrade to `{ offers: [] }` / `{ ok: false }`
  with status 200, so checkout is never disrupted by the app.
- **Secrets** only via env (`SHOPIFY_API_SECRET`, `ANTHROPIC_API_KEY`,
  `DEEPL_API_KEY`); nothing baked into extension bundles except the public
  `APP_URL`.
- **PII minimization**: customer numeric ID + country code only; GDPR redaction
  paths in `app/services/bootstrap.server.ts` (see IMPLEMENTATION_GUIDE §19).

## 9. Scaling & operational notes

- **Database**: SQLite is a dev convenience (single writer, file-local).
  Production must run Postgres — provider swap + `prisma db push`, no model
  changes (all JSON is in `String` columns). After that the Remix app is
  stateless and horizontally scalable.
- **Hot path budget**: `/api/offer` does a handful of indexed reads
  (`Shop`, `CustomerState`, `MarketSetting`, `OfferRule`+slots+candidates or
  `ProductCache` scan, `OrderRecord/OrderLine` for suppression/affinity) plus
  one `IssuedOffer` write. The AI call is capped at `aiTimeoutMs` (2.5 s
  default) and falls back instantly — worst-case latency is bounded.
- **Co-purchase affinity** scans are capped at the most recent 5000 orders by
  design; at higher volumes, precompute an affinity table on a schedule
  instead.
- **Copy cache** absorbs most Anthropic traffic: common basket+offer+language
  combinations generate once per prompt version. Background warm-on-timeout
  means slow generations penalize at most one buyer.
- **Counters vs events**: `OfferCandidate.impressions/accepts/revenue` are
  denormalized running counters for the bandit (cheap reads at selection
  time); `OfferEvent` is the append-only source of truth for analytics. If
  they ever drift, events win — `resetExperimentStats` zeroes the counters.
- **Growth-bound tables**: `OfferEvent`, `OrderRecord`/`OrderLine`,
  `CopyCache`, `IssuedOffer`, `EventDedup`. The dashboard loader already does
  the routine housekeeping: it deletes `IssuedOffer` rows expired for more
  than a day and `EventDedup` claims older than 7 days. `CopyCache` is
  invalidated by prompt-version bumps and is safe to prune by `createdAt`
  with a periodic job; events/orders should be archived past your analytics
  horizon (CLV needs 90 days + lookback).
- **Webhook bursts** (flash sales): handlers are small upserts and always
  return 200; Postgres connection pooling (e.g. pgbouncer or Prisma pool
  limits) is the main knob.
- **Single hard limits to remember**: max 3 offers per checkout (Shopify),
  changeset JWT 10 min, issued offer 2 h, discount clamped to
  `settings.discount.min/max`, thank-you surface always 1 offer.
