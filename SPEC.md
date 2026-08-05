# SPEC — Cellexia Post-Purchase Upsell (build contract)

This document is the single source of truth for every module in this app.
Read it fully before writing any file. Also read: `prisma/schema.prisma`,
`app/types.ts`, `app/lib/json.ts`, `app/services/settings.server.ts`,
`app/shopify.server.ts`, `package.json`.

## 1. What the app does

A Shopify app for the store **cellexialabs.com** (anti-aging skincare, 17
languages, ~80 markets, EUR default) that shows **post-purchase upsell offers**
right after checkout:

- **Rule-based recommendation engine** ranks upsell products by compatibility
  (co-purchase affinity + manual rules), repeat-purchase logic, inventory,
  historical acceptance rate, and expected **gross profit per impression**.
- **AI-written copy** (Claude) explains — in the buyer's language — why the
  offered product(s) complement what was just bought. Prompts are editable in
  the admin. Copy NEVER implies the customer bought the wrong products.
- Default behavior: single-product order → 1 highly complementary offer;
  multi-product order → up to 3 offers **one at a time in a sequenced flow**,
  ordered by expected gross profit per impression. Admin can switch any rule
  to **bundle** mode (all products on one page, combined copy).
- One-click acceptance (Shopify changesets — charged to the same card), 10–15%
  configurable discount (fixed/tiered/AI-adjusted), strict frequency cap,
  suppression of owned/recent products, A/B rotation with Thompson sampling
  and auto-picked winners, per-market overrides, full analytics incl. 60/90-day
  CLV cohorts.
- **Thank-you-page fallback extension** (discount-code based) covers orders
  paid with Apple Pay / Google Pay / PayPal etc., which Shopify excludes from
  the post-purchase page (platform limitation: credit card only).

## 2. Verified platform facts (do not deviate)

- Post-purchase extension points: `Checkout::PostPurchase::ShouldRender` and
  `Checkout::PostPurchase::Render` via `@shopify/post-purchase-ui-extensions-react`
  (**React 17 peer dep** — the extension package.json must use react `^17.0.2`).
- `ShouldRender` receives `{ inputData, storage }`. `inputData` has: `token`
  (JWT signed with the app secret), `locale`, `shop { id, domain, metafields }`,
  `initialPurchase { referenceId, customerId, destinationCountryCode,
  totalPriceSet { shopMoney, presentmentMoney }, lineItems [{ quantity,
  totalPriceSet, product { id, title, variant { id, title, metafields } } }] }`.
  Product/variant ids in `initialPurchase` are numeric — convert with
  `toGid()` from `app/lib/json.ts` before hitting our DB.
- The extension calls our backend with `Authorization: Bearer ${inputData.token}`.
  Server side, `const { cors, sessionToken } = await authenticate.public.checkout(request)`
  from `app/shopify.server.ts` verifies it. The decoded post-purchase token has
  `input_data` (the full inputData). Wrap every JSON response in `cors(...)` and
  implement a `loader` that answers preflight with `cors()`.
- Changeset signing (`/api/sign-changeset`): sign with `jsonwebtoken`:
  `jwt.sign({ iss: process.env.SHOPIFY_API_KEY, jti: crypto.randomUUID(),
  sub: String(referenceId), changes }, process.env.SHOPIFY_API_SECRET,
  { expiresIn: "10m" })`. `changes` MUST come from our `IssuedOffer` table —
  never sign client-supplied changes.
- Change shape: `{ type: "add_variant", variantID: <number>, quantity: 1,
  discount: { value: <pct>, valueType: "percentage", title: "…" } }`.
- Extension money display: call `calculateChangeset({ changes })` per offer to
  show accurate totals (returns `calculatedPurchase` with
  `totalPriceSet`/`updatedShippingLines` etc.).
- **Shop Pay caveat**: `Render` may NOT be able to read what `ShouldRender`
  stored. The Render app must re-fetch offers from `/api/offer` when
  `storage.initialData` is empty.
- Up to 3 offers can be accepted per checkout. Call `done()` when finished.
- Post-purchase page shows ONLY for plain credit-card payments (Shopify
  Payments + a few gateways). Never for wallets (Apple Pay, Google Pay),
  PayPal, installments, gift-card-only, orders < $0.50, local delivery.
- Thank-you extension: `@shopify/ui-extensions-react@^2025.7.0` (react 18 ok),
  toml `api_version = "2025-07"`, `type = "ui_extension"`, target
  `purchase.thank-you.block.render`, `[extensions.capabilities] network_access = true`,
  merchant-set `app_url` settings field.

## 3. Conventions

- TypeScript strict; `json()` / types from `@remix-run/node`; **relative imports
  only** (no path aliases). React components: Polaris v13
  (`@shopify/polaris`), icons from `@shopify/polaris-icons`.
- No new npm dependencies beyond root `package.json`. Anthropic/DeepL are
  called with plain `fetch` (no SDK).
- DB JSON columns are strings — always use `jparse`/`jstr` from `app/lib/json.ts`.
- Every service function takes `shop` (the `*.myshopify.com` domain) as its
  tenancy key.
- Admin routes authenticate with `const { session, admin } = await
  authenticate.admin(request)` and use `session.shop`.
- Log errors with a `[module]` prefix; never let an exception produce a 500 on
  the public endpoints — degrade to an empty offer list instead.
- Currency formatting helper (shared idea, implement locally where needed):
  `formatMoney(amount: number, currency: string, locale: string)` using
  `Intl.NumberFormat` with try/catch fallback to `"${amount.toFixed(2)} ${currency}"`.

## 4. File ownership (each module owns exactly these files)

| Module | Files |
|---|---|
| A catalog | `app/services/catalog.server.ts`, `app/services/bootstrap.server.ts` |
| B engine | `app/services/recommendation.server.ts` |
| C ai | `app/services/ai.server.ts` |
| D analytics | `app/services/analytics.server.ts` |
| E public api | `app/services/offer-orchestrator.server.ts`, `app/routes/api.offer.tsx`, `app/routes/api.sign-changeset.tsx`, `app/routes/api.events.tsx`, `app/routes/api.typ-offer.tsx` |
| F webhooks | `app/routes/webhooks.tsx` |
| G dashboard UI | `app/routes/app._index.tsx`, `app/routes/app.analytics.tsx`, `app/components/MiniChart.tsx` |
| H offers UI | `app/routes/app.offers._index.tsx`, `app/routes/app.offers.$id.tsx` |
| I settings UI | `app/routes/app.prompts.tsx`, `app/routes/app.settings.tsx`, `app/routes/app.translations.tsx` |
| J pp extension | `extensions/post-purchase-upsell/shopify.extension.toml`, `extensions/post-purchase-upsell/package.json`, `extensions/post-purchase-upsell/src/index.jsx` |
| K typ extension | `extensions/thank-you-upsell/shopify.extension.toml`, `extensions/thank-you-upsell/package.json`, `extensions/thank-you-upsell/src/ThankYou.jsx`, `extensions/thank-you-upsell/locales/en.default.json` |
| L docs | `README.md`, `docs/IMPLEMENTATION_GUIDE.md`, `docs/MERCHANT_GUIDE.md`, `docs/ARCHITECTURE.md` |

## 5. Service contracts

### A — `catalog.server.ts`

```ts
export interface CachedVariant {
  id: string;               // gid
  title: string;
  price: number;
  compareAtPrice: number | null;
  inventoryQuantity: number | null; // null = not tracked
  unitCost: number | null;
  imageUrl: string | null;
  sku: string;
}
export interface CatalogProduct {
  productId: string;        // gid
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string;           // "ACTIVE" | ...
  tags: string[];
  imageUrl: string | null;
  descriptionShort: string; // plain text, first ~300 chars — used in AI prompts
  variants: CachedVariant[];
  translations: Record<string, { title?: string }>;
}
export async function syncCatalog(graphql: AdminGraphql, shop: string): Promise<{ count: number }>;
export async function syncMarketsAndLocales(graphql: AdminGraphql, shop: string): Promise<void>;
export async function upsertProductFromWebhook(shop: string, payload: any): Promise<void>;
export async function deleteProductFromWebhook(shop: string, payload: any): Promise<void>;
export async function getProductsByIds(shop: string, productIds: string[]): Promise<CatalogProduct[]>;
export async function getActiveProducts(shop: string): Promise<CatalogProduct[]>;
export function pickPrimaryVariant(p: CatalogProduct): CachedVariant | null; // first in-stock (or first) variant
```

- `syncCatalog`: paginated Admin GraphQL (`products(first: 100, after:)`)
  fetching title/handle/productType/vendor/status/tags/featuredImage/description,
  variants (price, compareAtPrice, inventoryQuantity,
  `inventoryItem { unitCost { amount } }`, image, sku) and, for each language
  in settings beyond the default: `translations(locale: $locale) { key value }`
  (keep `key == "title"`). Upsert into `ProductCache`. Set `Shop.catalogSyncedAt`.
  Wrap per-locale translation fetch in try/catch (missing `read_locales` must
  not break sync).
- `syncMarketsAndLocales`: `shopLocales { locale primary published }` → update
  settings `languages`/`defaultLanguage` (published only, keep order, primary
  first) via `saveSettings`. `markets(first: 50) { nodes { handle name enabled
  regions(first: 100) { nodes { ... on MarketRegionCountry { code } } } } }` →
  upsert `MarketSetting` (do not overwrite admin-set overrides on re-sync;
  only name/countries/new rows). Tolerate schema differences with try/catch —
  markets sync is best-effort.
- Webhook upserts map REST payload fields (`product_type`, `compare_at_price`,
  `inventory_quantity`, `image.src`, tags as comma string); preserve existing
  `unitCost`/`translationsJson` when the webhook lacks them.

### A — `bootstrap.server.ts`

```ts
export async function bootstrapShop(shop: string, admin?: { graphql: AdminGraphql } | null): Promise<void>;
export async function redactCustomer(shop: string, customerId: string): Promise<void>; // null-out/delete customer-linked rows
export async function redactShop(shop: string): Promise<void>;                          // delete all rows for shop
```
`bootstrapShop`: ensureShop → ensurePromptTemplates → syncMarketsAndLocales →
ensureUiStrings(settings.languages) → syncCatalog. Each step try/catch-logged.

### B — `recommendation.server.ts`

```ts
export async function selectOffers(ctx: PurchaseContext, settings: AppSettings): Promise<SelectionResult>;
export function resolveDiscountPct(strategy: DiscountStrategy, orderTotal: number, overridePct?: number | null): number;
export async function resetExperimentStats(shop: string, ruleId?: string): Promise<void>;
export async function autoPickWinners(shop: string, settings: AppSettings): Promise<number>; // returns # of new winners
```

`selectOffers` pipeline (each step logged at debug level):
1. `settings.enabled === false` → empty result.
2. Frequency cap: if `ctx.customerId` and `CustomerState.lastOfferAt` within
   `frequencyCapDays` → empty result (surface `post_purchase` only; thank-you
   surface respects the same cap when customerId present).
3. Market: find `MarketSetting` where `countriesJson` includes
   `ctx.countryCode`; if found and `enabled === false` → empty. Keep
   `discountOverride`/`maxOffersOverride` for later steps.
4. `distinctProducts = new Set(lineItems.productId).size`;
   `maxOffers = distinctProducts <= 1 ? singleProductOrderOffers : multiProductOrderOffers`,
   clamped by market override, then rule `maxOffers`, hard cap 3, and 1 for
   surface `thank_you`.
5. Build suppression set: products in the order; products from
   `OrderRecord`/`OrderLine` for this customer within `suppressionDays`;
   products not ACTIVE; variants with tracked inventory < `minInventory`;
   price <= 0.
6. Rule matching: enabled `OfferRule`s ordered by `priority` asc, first whose
   `RuleTrigger` matches (AND semantics, empty=any, see `app/types.ts`).
   - Matched: for each slot (position asc, up to maxOffers), choose ONE
     candidate among enabled, non-suppressed candidates via bandit:
     if a candidate `isWinner` and rotation.autoPickWinner → pick it except
     with probability `explorationPct/100` (then Thompson-sample all).
     Thompson: sample `Beta(accepts+1, impressions-accepts+1)` per candidate
     (implement a small beta sampler via two gamma draws — Marsaglia-Tsang),
     multiply by candidate weight and by unit margin when optimizeMetric is
     `gp_per_impression`; highest sample wins.
   - Not matched → **auto-pilot**: score every non-suppressed active product:
     `compatibility` = 0.6·coPurchase + 0.25·typeAffinity + 0.15·tagOverlap where
       coPurchase = max over order products A of P(candidate|A) from OrderLine
       co-occurrence (Laplace-smoothed, computed with a groupBy over order ids
       containing A — cap the scan at the most recent 5000 orders);
       typeAffinity = 1 if productType differs from ALL basket types (cross-sell)
       else 0.4 (same-type repurchase is fine but weaker); tagOverlap = Jaccard
       of tags vs union of basket tags.
     `repeatPurchase` = share of customers who bought this product ≥2 times
       (from OrderLine history, smoothed; 0.5 default when no data).
     `acceptance` = (accepts+1)/(impressions+4) from `OfferEvent` by productId.
     `margin` = (discountedPrice − unitCost)/discountedPrice (0.5 when unknown).
     Weighted sum with `settings.weights` (normalize weights to sum 1).
     `expectedGpPerImpression = acceptance × (discountedPrice − (unitCost ?? 55% of price))`.
     Order by optimizeMetric: `gp_per_impression` → expectedGp; `conversion` →
     acceptance then score; `revenue_per_impression` → acceptance × discountedPrice.
     Take top `maxOffers` distinct products.
7. Discount: `resolveDiscountPct(ruleDiscount ?? settings.discount, ctx.totalAmount, marketOverride)`
   — fixed → value; tiered → highest tier with `minOrderValue <= orderTotal`;
   ai → midpoint of [min,max] (orchestrator may replace with Claude's
   suggestion clamped to [min,max]); always clamp to [min,max]; round to int.
8. displayMode: rule.displayMode ?? settings.defaultDisplayMode. Bundle → ONE
   SelectedOffer with up to maxOffers products (positions merged); sequential →
   one SelectedOffer per product. Ordering: rule-matched offers keep the
   admin's slot-position order; auto-pilot offers keep the optimizeMetric
   ranking. Assembly must NOT re-sort picks (doing so would override both).
9. Never return more than 3 offers/products. Empty candidates → empty result.

`autoPickWinners`: for every slot with ≥2 enabled candidates and rotation
enabled + autoPickWinner: if best candidate has
`impressions ≥ minImpressionsToPick` and Monte-Carlo posterior
P(best) ≥ winnerConfidence (2000 beta draws), set `isWinner = true` on it and
false on others. Cheap enough to call opportunistically from the dashboard
loader; also exposed as a settings-page action.

### C — `ai.server.ts`

```ts
export type PromptKey = "single" | "bundle" | "sequential";
export const DEFAULT_PROMPTS: Record<PromptKey, { systemPrompt: string; userPrompt: string }>;
export async function ensurePromptTemplates(shop: string): Promise<void>;
export async function claudeComplete(args: { model: string; system: string; prompt: string; maxTokens: number; temperature: number; timeoutMs: number }): Promise<string>; // throws on error/timeout
export interface GenerateCopyArgs {
  shop: string; settings: AppSettings; mode: PromptKey;
  position: number; totalOffers: number; language: string;
  basket: { title: string; productType: string; quantity: number }[];
  offerProducts: SelectedOfferProduct[];
  discountPct: number; currency: string; copyLength: CopyLength;
  bypassCache?: boolean; timeoutMs?: number;
}
export async function generateCopy(args: GenerateCopyArgs): Promise<{ copy: OfferCopy; discountSuggestion: number | null; cached: boolean; fallbackUsed: boolean }>;
export function fallbackCopy(args: GenerateCopyArgs, strings: Record<string, string>): OfferCopy; // deterministic, per-language-safe (uses product titles + generic phrasing)
export async function ensureUiStrings(shop: string, languages: string[]): Promise<void>;
export async function getUiStrings(shop: string, language: string): Promise<Record<string, string>>; // requested lang → base lang ("pt-PT"→"pt") → "en" → DEFAULT_UI_STRINGS_EN, per key
export async function translateUiStrings(shop: string, languages: string[], opts?: { onlyMissing?: boolean }): Promise<{ translated: number; errors: string[] }>;
export async function translateTexts(settings: AppSettings, texts: string[], targetLang: string): Promise<string[]>; // Claude or DeepL per settings.translationProvider
```

- `claudeComplete`: `fetch("https://api.anthropic.com/v1/messages")`, headers
  `x-api-key: process.env.ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`,
  body `{ model, max_tokens, system, messages: [{role:"user",content:prompt}] }`,
  `AbortSignal.timeout(timeoutMs)`. Return concatenated text blocks.
  **Never send `temperature`/`top_p`/`top_k`**: sampling parameters are
  rejected with a 400 on claude-sonnet-5 / claude-opus-5 / Claude 4.7+ —
  including our default translation model — and gain little on
  claude-haiku-4-5. Steer style via the prompt.
- Prompt templating: replace `{{brand_context}} {{tone}} {{language}}
  {{length}} {{basket_summary}} {{offer_summary}} {{discount_pct}} {{currency}}
  {{position}} {{total_offers}}` in both system and user templates.
  `basket_summary`: "2× Retinol Night Cream (Cream); 1× Vitamin C Serum (Serum)".
  `offer_summary` includes title, type, price, short description per offered product.
- DEFAULT_PROMPTS must instruct: write in `{{language}}`; output ONLY minified
  JSON `{"headline": string, "body": string, "bullets": string[2..3],
  "discount_suggestion": number|null}`; headline ≤ 60 chars, body ≤ 220 chars
  (short) / ≤ 450 (long); concrete incremental benefit tied to the basket;
  NEVER imply the original purchase was wrong or incomplete; no medical claims;
  no emojis; mention the discount naturally. `bundle` variant explains why the
  set works together; `sequential` variant must not repeat previous offers'
  angles (mention position N of M).
- `generateCopy`: cacheKey = sha256 of
  `mode|sortedOfferVariantIds|sortedBasketProductIds(first 6)|language|copyLength|discountPct|promptVersion`
  (node `crypto.createHash`). Check `CopyCache` first. On miss: if
  `!settings.aiEnabled || !process.env.ANTHROPIC_API_KEY` → fallback. Else
  race Claude with timeout (`args.timeoutMs ?? settings.aiTimeoutMs`); parse
  JSON defensively (strip ``` fences, find first `{`); validate/truncate
  fields; store in cache. On timeout/error: return `fallbackCopy` AND fire the
  same generation without timeout in the background (`void promise.catch(...)`)
  to warm the cache for the next buyer.
- `ensureUiStrings`: seed `en` rows from `DEFAULT_UI_STRINGS_EN` (skip
  existing), then `translateUiStrings(shop, otherLangs, { onlyMissing: true })`
  best-effort (catch errors — never throw from bootstrap).
- DeepL: `https://api.deepl.com/v2/translate` (fallback to `api-free.deepl.com`
  host when key ends in `:fx`), form body `text`(repeated)/`target_lang`;
  map `pt-PT`→`PT-PT`, `no`→`NB`, else uppercase 2-letter.

### D — `analytics.server.ts`

```ts
export interface DashboardStats {
  impressions: number; accepts: number; declines: number;
  acceptanceRate: number;            // accepts / max(1, impressions)
  upsellRevenue: number; upsellGrossProfit: number;
  gpPerImpression: number;
  offersPerOrderShown: number;       // avg pages per referenceId
  currency: string;
}
export async function recordExtensionEvent(shop: string, payload: ExtensionEventPayload): Promise<void>;
export async function getDashboardStats(shop: string, days: number): Promise<DashboardStats>;
export async function getTimeSeries(shop: string, days: number): Promise<Array<{ date: string; impressions: number; accepts: number; revenue: number; grossProfit: number }>>;
export interface OfferPerfRow { productId: string; title: string; surface: string; impressions: number; accepts: number; acceptanceRate: number; revenue: number; grossProfit: number; gpPerImpression: number; avgDiscountPct: number; }
export async function getOfferPerformance(shop: string, days: number): Promise<OfferPerfRow[]>;
export async function getBreakdown(shop: string, days: number, dim: "country" | "language" | "market" | "surface"): Promise<Array<{ key: string; impressions: number; accepts: number; acceptanceRate: number; revenue: number }>>;
export interface ExperimentRow { ruleId: string; ruleName: string; slotPosition: number; candidateId: string; productTitle: string; impressions: number; accepts: number; acceptanceRate: number; revenue: number; probBest: number; isWinner: boolean; }
export async function getExperimentResults(shop: string): Promise<ExperimentRow[]>;
export async function getClvCohorts(shop: string, windowDays: number): Promise<Array<{ cohort: "accepted" | "declined" | "not_shown"; customers: number; avgFollowOnRevenue: number; avgFollowOnOrders: number }>>;
export async function recordOrderFromWebhook(shop: string, payload: any): Promise<void>;
export async function toCsv(rows: Array<Record<string, unknown>>): Promise<string>;
```

- `recordExtensionEvent`: look up `IssuedOffer` by `(referenceId, offerId)`;
  denormalize meta (ruleId, candidateIds, products with price/unitCost,
  discountPct, language, country, customerId, market, surface) into one
  `OfferEvent` row per event (for multi-product bundles write one row per
  product on `accepted`, one aggregate row otherwise). `grossProfit` =
  Σ(discountedPrice − (unitCost ?? 0.55·price)). On `impression` (position 1
  only) upsert `CustomerState.lastOfferAt/offersShown`; on `accepted` also
  increment `offersAccepted` and each candidate's counters
  (`impressions` counters increment on impression events for the shown
  candidateIds). Never throw.
- `recordOrderFromWebhook`: upsert `OrderRecord` + lines from REST order
  payload (`id`, `customer.id`, `total_price`, `currency`,
  `shipping_address.country_code`, `line_items[]`). Match upsell: if an
  `OfferEvent` with `eventType="accepted"` exists whose `referenceId` numeric
  part equals the order id (or `orderId` matches), set `hadUpsellOffer`,
  `acceptedUpsell`, and mark matching lines `isUpsell` (variantId match) and
  backfill `OfferEvent.orderId`. Any impression event with same reference →
  `hadUpsellOffer = true`.
- `getClvCohorts(windowDays)`: for customers whose FIRST offer event (any
  type) is ≥ windowDays old: cohort by whether they ever accepted (accepted),
  saw-but-never-accepted (declined), or had orders but no offer events in the
  period (not_shown). Follow-on = Σ OrderRecord.totalPrice within windowDays
  AFTER that first event (accepted/declined) or after their first order in the
  period (not_shown), excluding the triggering order itself.
- `getExperimentResults`: per rule slot with ≥2 candidates: Monte-Carlo
  posterior P(best) with Beta(accepts+1, impressions−accepts+1), 2000 draws.

### E — `offer-orchestrator.server.ts` + public routes

```ts
export async function assembleOfferResponse(ctx: PurchaseContext): Promise<OfferResponse>;
export async function assembleThankYouOffer(ctx: PurchaseContext, graphql: AdminGraphql | null): Promise<ThankYouOffer | null>;
```

`assembleOfferResponse`:
1. `getSettings` → `selectOffers` (empty → `{ offers: [], ... }` with strings still populated).
2. Language: market `languageOverride` → else best match of `ctx.locale`
   against `settings.languages` (exact, then case-insensitive, then prefix
   before `-`), else `settings.defaultLanguage`.
3. `getUiStrings(shop, language)`.
4. For each SelectedOffer: translated titles from catalog translations
   (`translations[language]?.title`); copy via `generateCopy`
   (mode: `bundle` if displayMode bundle && >1 product; `sequential` if
   totalOffers>1; else `single`). If `settings.discount.mode === "ai"` and
   `discountSuggestion` present → clamp to [min,max], recompute prices.
5. Build `OfferChange[]` (`variantID: gidToNumber(variantId)`, quantity 1,
   discount title = strings.discount_applied with `{pct}` replaced).
6. `offerId = crypto.randomUUID()`; persist `IssuedOffer` (changesJson,
   offerMetaJson with everything `recordExtensionEvent` needs, expiresAt
   now + 2h).
7. Prices in `OfferProductView` as decimal strings rounded to 2.

Routes (all: `action` = POST logic, `loader` = `const { cors } = await
authenticate.public.checkout(request); return cors(json({ ok: true }))` so
preflight/GET succeed; wrap responses in `cors(...)`; on any internal error
return `cors(json({ offers: [] }))` (or `{ ok: false }`) with status 200):

- **`api.offer.tsx`**: shop = `sessionToken.input_data?.shop?.domain ?? new
  URL((sessionToken as any).dest ?? "https://x").hostname`; build
  `PurchaseContext` from `input_data.initialPurchase` (ids via `toGid`,
  `locale` from input_data, surface "post_purchase"). `ctx.totalAmount` and
  `ctx.currency` MUST come from **shopMoney** (fallback presentment only when
  shopMoney is absent): rule min/max totals, discount tiers, and catalog
  prices are all shop-currency, so threshold math in another currency is
  wrong (a ¥12,000 order is not "≥ €120"). Buyer-accurate presentment totals
  come from `calculateChangeset` client-side for display. Merge body fields
  as fallback only (referenceId). Return `assembleOfferResponse`.
- **`api.sign-changeset.tsx`**: body `{ referenceId, offerId }`; look up
  non-expired `IssuedOffer`; sign per §2; `cors(json({ token }))`; 404-style
  `{ error }` JSON if unknown.
- **`api.events.tsx`**: body = `ExtensionEventPayload`; derive shop like
  api.offer; `recordExtensionEvent`; `{ ok: true }`.
- **`api.typ-offer.tsx`**: body `{ orderId?, countryCode?, locale?,
  lineItems?: [{productId, variantId, quantity}], totalAmount?, currency?,
  customerId? }` from the thank-you extension; shop from `sessionToken.dest`
  hostname; if `settings.thankYouEnabled === false` → `{ offer: null }`.
  Build ctx (surface "thank_you", referenceId = `typ:${orderId ?? uuid}`);
  `assembleThankYouOffer` uses `selectOffers` (1 offer), `generateCopy`, then
  creates a one-time discount code via `unauthenticated.admin(shop)` GraphQL
  `discountCodeBasicCreate` (code `THANKYOU-${6 random A-Z0-9}`, pct off,
  `appliesOncePerCustomer: true`, `usageLimit: 1`, ends in 48h, applies to the
  offer product) and builds
  `checkoutUrl = https://${shop}/cart/${gidToNumber(variantId)}:1?discount=${code}`.
  If discount creation fails → still return the offer with empty code and a
  plain product URL. Response `{ offer: ThankYouOffer | null }`.

### F — `webhooks.tsx`

`const { topic, shop, payload } = await authenticate.webhook(request);`
switch (topic): ORDERS_CREATE → `recordOrderFromWebhook`; PRODUCTS_CREATE /
PRODUCTS_UPDATE → `upsertProductFromWebhook`; PRODUCTS_DELETE →
`deleteProductFromWebhook`; APP_UNINSTALLED → delete sessions for shop (keep
data for reinstall); CUSTOMERS_DATA_REQUEST → log (data is minimal) + 200;
CUSTOMERS_REDACT → `redactCustomer(shop, String(payload.customer?.id ?? ""))`;
SHOP_REDACT → `redactShop`; APP_SCOPES_UPDATE → update session scope if
present; default → 200. Wrap handler bodies in try/catch (log, still return
200 so Shopify doesn't retry-storm). Always `return new Response()`.

## 6. Admin UI (Polaris v13, embedded)

Shared style: `<Page>` with title + `<Layout>`; save via `<Form method="post">`
or `useSubmit`; success feedback via `shopify.toast.show(...)` from
`useAppBridge()` (App Bridge v4). Product selection uses
`const shopify = useAppBridge(); const sel = await shopify.resourcePicker({
type: "product", multiple: ... })` — take `sel?.[0]?.id`, `title`,
`images?.[0]?.originalSrc`, `variants?.[0]?.id`.
`useLoaderData<typeof loader>()`; actions dispatch on a hidden `intent` field.

- **G `app._index.tsx` (Dashboard)**: KPI cards (impressions, acceptance rate,
  upsell revenue, gross profit, GP/impression — 30d), line chart of
  impressions & accepts (use `MiniChart`), top 5 offers table, setup checklist
  Banner card (catalog synced? `ANTHROPIC_API_KEY` set? ≥1 rule or auto-pilot
  note; reminder to enable the post-purchase page in Settings → Checkout and
  to select this app; reminder that post-purchase shows for card payments only
  + thank-you fallback covers the rest). Action `intent=sync` → syncCatalog +
  syncMarketsAndLocales with the admin client; also call `autoPickWinners`
  opportunistically in loader (try/catch).
  **G `app.analytics.tsx`**: `?days=7|30|90` Select; funnel stats; offer
  performance table; breakdowns by country / language / surface; experiment
  table (probBest %, winner badge); CLV cohort cards for 60 and 90 days with a
  short explanation; Export CSV button (loader `?export=offers|events` returns
  `text/csv` via `toCsv`).
  **G `MiniChart.tsx`**: dependency-free inline SVG line/area chart component
  `({ series: Array<{date: string; values: number[]}>, labels: string[],
  height?: number })` — clean axis-less sparkline style with dots + legend.
- **H `app.offers._index.tsx`**: IndexTable of rules (name, status Badge,
  priority, trigger summary, slots/products count, 30d accept rate), toggle
  enable, delete, "Create rule" primary action → `/app/offers/new`; empty
  state explains auto-pilot is always on as fallback. Card on top explaining
  evaluation order (priority, first match wins, auto-pilot fallback).
  **H `app.offers.$id.tsx`** (`id === "new"` → create): form sections
  1) Name/enabled/priority; 2) Trigger (product picker multi, tags, product
  types, min/max distinct items, min/max order total, countries CSV);
  3) Offers: displayMode select (Store default/Sequential/Bundle), copyLength
  (default/short/long), maxOffers (1–3), three slot cards each with candidate
  rows (image thumb, title, weight number field, enabled toggle, stats text
  `x/y accepted`, winner Badge, remove) + "Add product" per slot;
  4) Discount override (none / fixed pct with min-max clamp).
  Save = transaction: upsert rule, delete+recreate slots/candidates BUT
  preserve stats for candidates whose variantId survives (match by variantId).
- **I `app.prompts.tsx`**: one Card per PromptKey (Single product / Bundle /
  Sequenced offers): system + user prompt TextFields (multiline 8/12),
  model Select (`claude-haiku-4-5` "fast", `claude-sonnet-5` "best"),
  temperature (0–1 step .1), maxTokens; Save (bumps `version`); "Reset to
  default" (intent per key); Preview section: language Select + "Generate
  preview" → action uses first 2 catalog products as fake basket + 1 as offer,
  `bypassCache: true`, renders headline/body/bullets + latency + fallback flag.
  Info Card documenting all template variables.
  **I `app.settings.tsx`**: sections per SPEC §5 settings: General, Discount
  (mode select + value/min/max + tier rows add/remove), Frequency & hygiene,
  Optimization (metric, rotation fields, "Reset experiment stats" + "Pick
  winners now" buttons), Markets (table from MarketSetting: enabled,
  discountOverride, languageOverride, maxOffersOverride; "Re-sync" button),
  Languages (checkboxes from settings.languages ∪ CELLEXIA_LANGUAGES,
  defaultLanguage select), AI (aiEnabled, model, timeout, translationProvider,
  banner if `ANTHROPIC_API_KEY` missing). Each section its own submit intent.
  **I `app.translations.tsx`**: language Select (settings.languages);
  editable table key → value for `UI_STRING_KEYS` (missing = placeholder from
  EN); Save all; "Auto-translate missing" and "Re-translate all" buttons
  calling `translateUiStrings`; note that offer copy itself is generated
  per-language by AI, these are the static button/labels.

## 7. Post-purchase extension (module J)

`extensions/post-purchase-upsell/shopify.extension.toml`:
```toml
name = "Cellexia Post-Purchase Upsell"
type = "checkout_post_purchase"
metafields = []
```
`package.json`: name `post-purchase-upsell`, private, dependencies
`react ^17.0.2`, `@shopify/post-purchase-ui-extensions-react ^0.13.5`.

`src/index.jsx` requirements:
- `const APP_URL = "https://REPLACE-WITH-YOUR-APP-URL.example.com";` top of
  file with a loud TODO comment (documented in the guide).
- ShouldRender: POST `${APP_URL}/api/offer` (Bearer inputData.token, JSON body
  `{ referenceId }`), `storage.update(response)`, `render: offers.length > 0`.
  Wrap in try/catch → `{ render: false }` on failure.
- Render app: offers from `storage.initialData`; **if empty, re-fetch the same
  endpoint in a useEffect (Shop Pay case)**; loading state = Spinner centered.
- Sequential flow: page i of N. Per page: `calculateChangeset({ changes })`
  on mount → accurate money (presentment); show original total vs discounted:
  price row = strings.was + strikethrough-style original (Text appearance
  "subdued") and strings.now + discounted (Text emphasized, appearance
  "critical"), `save_pct` badge text.
- Layout: `CalloutBanner` title = strings.offer_badge (+ `offer_x_of_y` with
  {x}/{y} replaced when N>1); `Layout media={[{viewportSize:"small",
  sizes:[1,0,1],maxInlineSize:0.9},{viewportSize:"medium",sizes:[532,0,1],
  maxInlineSize:420},{viewportSize:"large",sizes:[560,38,340]}]}` — product
  Image left, right column: Heading (copy.headline), TextBlock (copy.body),
  bullets as TextBlock rows prefixed "• ", price row, subdued
  strings.ships_free + strings.one_click_note, countdown line (strings.time_left
  + mm:ss ticking, only when ui.showCountdown; on expiry call done()).
  Bundle page: BlockStack of product rows (small Image, title, price each) +
  combined copy + one accept-all Button (strings.add_all_to_order).
- Buttons: primary `Button submit loading={processing}` = strings.add_to_order;
  plain Button = strings.decline.
- Accept: POST `/api/events` impression is sent on each page mount (fire and
  forget); on accept POST `/api/sign-changeset` `{ referenceId, offerId }` →
  `applyChangeset(token)` → POST accepted event with revenue = discounted
  total of the page → advance to next page (brief success state) or `done()`.
  On error: Banner critical strings.error_try_again + error event, keep page.
- Decline: declined event → next page or `done()`.
- All user-visible text from `response.strings` — NO hardcoded English in JSX
  (fallbacks inline `strings.x ?? "English default"` are fine).
- Money formatting: `new Intl.NumberFormat(locale, { style: "currency",
  currency })` in try/catch, fallback `${amount} ${currency}`.

## 8. Thank-you extension (module K)

toml per §2 (api_version 2025-07, target `purchase.thank-you.block.render`,
network_access, settings fields: `app_url` single_line_text_field, optional
`title_override`). `package.json`: react ^18.2.0,
`@shopify/ui-extensions-react ^2025.7.0` (+ `@shopify/ui-extensions ^2025.7.0`).
`src/ThankYou.jsx`: `reactExtension("purchase.thank-you.block.render", () =>
<ThankYouUpsell />)`. Use `useApi()` — read `settings` (via `useSettings()`),
`sessionToken`, `localization`, `lines`/`cost`/`buyerIdentity` defensively
(optional chaining; try/catch around everything; render `null` when anything
essential is missing). POST `${appUrl}/api/typ-offer` with
`Authorization: Bearer ${await sessionToken.get()}` and body built from
available data (order id from `useApi().orderConfirmation?.current?.order?.id`
if available). Render: BlockStack in a section — Heading (copy.headline or
strings.thank_you_title), InlineLayout image + body text, discounted price vs
original, strings.thank_you_code_note with the code, primary Button/Link
`to={offer.checkoutUrl}` (external) = strings.thank_you_cta. Send
impression/accepted(click)/declined events to `/api/events` (surface
"thank_you"). `locales/en.default.json`: `{ "name": "Cellexia Thank You Upsell" }`
plus any static fallbacks you need.

## 9. Docs (module L)

Write for a mid-level Shopify dev who has never seen this repo, and for the
merchant. Cover: what it is; architecture at a glance; **exact step-by-step
setup** (Partner app creation → `shopify app config link` → `.env` → `npm
install` → `npm run setup` → `npm run dev` → install on dev store → Settings →
Checkout → select post-purchase app → test with test credit card); the
APP_URL constant in the post-purchase extension and app_url setting in the
thank-you extension; deploy (`shopify app deploy`) and hosting (Fly.io
walkthrough + generic Node instructions; Postgres switch: change provider in
schema.prisma + DATABASE_URL, `prisma db push`); protected customer data
(orders scopes) request in Partner Dashboard for public distribution vs
custom-app distribution recommendation; network access approval for the
thank-you extension; **payment method support table** (credit cards ✓;
Apple Pay/Google Pay/PayPal/Klarna → thank-you fallback, Shopify platform
limitation with docs link); testing checklist; troubleshooting (offer not
showing: payment method, order < $0.50, frequency cap, no eligible products,
post-purchase app not selected in checkout settings…); how the engine ranks
(plain English); how prompts/variables work; analytics definitions incl. CLV
cohorts; GDPR notes. MERCHANT_GUIDE: how to use each admin page, strategy
best practices (10–15% discount, one offer for single-product orders, etc.).
README.md: short overview + quick start + doc links + repo map.

## 10. Definition of done (every module)

- Compiles under `tsc --noEmit` with the repo tsconfig (strict).
- Only exports/imports declared here; no new dependencies.
- No hardcoded shop domains or API keys; everything per-shop from the DB.
- Public endpoints never 500 (degrade gracefully) and always use `cors()`.
- UI text in admin: English. Buyer-facing text: from UiString/AI only.
