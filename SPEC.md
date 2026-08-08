# SPEC — Cellexia Post-Purchase Upsell (build contract)

> **Status: this SPEC reflects the vNext state as implemented** — long-form
> direct-response copy (lead / bullets / paragraphs / proof / closer), the
> two-stage buyer copy pipeline (fast core call + background extended patch +
> `/api/offer-extended` polling), buyer-locale-first language resolution, the
> Products tab (per-product AI context + manual per-language product names),
> the Preview page, the EventDedup replay guard, multi-currency display
> (shop-currency engine, presentment display via the implied order rate,
> preview-only market FX rates), the em-dash policy, and self-healing
> UI-string translations. Where this document and the code disagree, the code
> plus its test harness are the tiebreaker — then fix whichever is wrong.

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
  the admin. Copy NEVER implies the customer bought the wrong products. Long
  copyLength produces a full direct-response page: headline + lead + bullets
  above the CTA, then "Why it works with your order" paragraphs and a
  "What published research shows" block below it, and a one-line closer above
  the buttons. Copy is grounded in per-product descriptions: the merchant's
  **AI context** (Products tab) wins over the synced Shopify description.
  Buyer-facing product NAMES are resolved per language with the precedence
  **manual override (`ProductCache.nameOverridesJson`, Products tab) >
  Translate & Adapt synced translation > base title** and used verbatim —
  the model never writes or translates a name. Buyer-facing text contains no
  em dashes (prompt rule + sanitizer; `DEFAULT_UI_STRINGS_EN` is itself
  em-dash-free).
- **Two-stage buyer copy pipeline**: the buyer-blocking call generates only
  the above-the-fold core (fast model, tight token cap, inside the
  post-purchase time budget); the below-CTA sections complete in a background
  call and the extension polls `/api/offer-extended` for them.
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
  `storage.initialData` is empty. Server side this re-fetch is **idempotent**:
  the orchestrator returns the already-issued pages for the referenceId (see
  §5-E) instead of re-running the bandit.
- Up to 3 offers can be accepted per checkout. Call `done()` when finished.
- Post-purchase page shows ONLY for plain credit-card payments (Shopify
  Payments + a few gateways). Never for wallets (Apple Pay, Google Pay),
  PayPal, installments, gift-card-only, orders < $0.50, local delivery.
- Thank-you extension: `@shopify/ui-extensions-react@^2025.7.0` (react 18 ok),
  toml `api_version = "2025-07"`, `type = "ui_extension"`, target
  `purchase.thank-you.block.render`, `[extensions.capabilities] network_access = true`,
  merchant-set `app_url` settings field.

### Claude API facts (verified against the live API — do not deviate)

- **Never send sampling parameters** (`temperature`/`top_p`/`top_k`): they are
  rejected with a 400 on `claude-sonnet-5` (our default translation model),
  `claude-opus-5`, and Claude 4.7+, and gain little on `claude-haiku-4-5`.
  Steer style via the prompt.
- **`claude-sonnet-5*` and `claude-opus-5*` run adaptive thinking BY DEFAULT
  when the `thinking` param is omitted**, and `max_tokens` caps thinking +
  output TOGETHER — long-form JSON then truncates with
  `stop_reason: "max_tokens"` and parses as garbage. `claudeComplete` must
  send `thinking: { type: "disabled" }` for models whose id starts with
  `claude-sonnet-5` or `claude-opus-5`, and must NOT send a `thinking` param
  for `claude-haiku-4-5` or any other model.
- **Check `stop_reason` before using the text**: `"max_tokens"` (truncated)
  and `"refusal"` (safety classifiers declined; HTTP 200) must both throw so
  callers hit their fallback paths instead of parsing garbage/empty content.
- `maxTokens` on prompt templates defaults to 4000 — it is headroom, not
  spend; a tight cap truncates the JSON mid-object on thinking-by-default
  models.

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
| E public api | `app/services/offer-orchestrator.server.ts`, `app/routes/api.offer.tsx`, `app/routes/api.offer-extended.tsx`, `app/routes/api.sign-changeset.tsx`, `app/routes/api.events.tsx`, `app/routes/api.typ-offer.tsx` |
| F webhooks | `app/routes/webhooks.tsx` |
| G dashboard UI | `app/routes/app._index.tsx`, `app/routes/app.analytics.tsx`, `app/components/MiniChart.tsx` |
| H offers UI | `app/routes/app.offers._index.tsx`, `app/routes/app.offers.$id.tsx` |
| I settings UI | `app/routes/app.prompts.tsx`, `app/routes/app.settings.tsx`, `app/routes/app.translations.tsx` |
| J pp extension | `extensions/post-purchase-upsell/shopify.extension.toml`, `extensions/post-purchase-upsell/package.json`, `extensions/post-purchase-upsell/src/index.jsx` |
| K typ extension | `extensions/thank-you-upsell/shopify.extension.toml`, `extensions/thank-you-upsell/package.json`, `extensions/thank-you-upsell/src/ThankYou.jsx`, `extensions/thank-you-upsell/locales/en.default.json` |
| L docs | `README.md`, `docs/IMPLEMENTATION_GUIDE.md`, `docs/MERCHANT_GUIDE.md`, `docs/ARCHITECTURE.md` |
| M products UI | `app/routes/app.products.tsx` |
| N preview UI | `app/routes/app.preview.tsx`, `app/components/PostPurchasePreview.tsx` |

Admin nav (`app/routes/app.tsx`): Dashboard, Offer rules, Products,
AI & Prompts, Preview, Translations, Analytics, Settings.

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
/** Per-locale Translate & Adapt values mirrored from Shopify. */
export interface ProductTranslationEntry {
  title?: string;
  description?: string;     // plain text, capped at 2 000 chars
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
  descriptionShort: string; // plain text, first ~300 chars
  descriptionFull: string;  // plain text, full description, capped at 12 000 chars
  aiDescription: string;    // merchant-written AI grounding (Products tab); overrides descriptions when set
  variants: CachedVariant[];
  translations: Record<string, ProductTranslationEntry>;
  /** Merchant-set per-language names from the Products tab
   *  (ProductCache.nameOverridesJson). Name precedence everywhere a buyer
   *  sees a name: nameOverrides[lang] > translations[lang].title > title.
   *  Merchant-owned — never touched by syncs or webhooks. */
  nameOverrides: Record<string, string>;
}
/** aiDescription (non-empty) → descriptionFull → descriptionShort. */
export function effectiveDescription(p: { aiDescription?: string | null; descriptionFull?: string | null; descriptionShort?: string | null }): string;
export async function syncCatalog(graphql: AdminGraphql, shop: string): Promise<{ count: number }>;
export async function syncMarketsAndLocales(graphql: AdminGraphql, shop: string): Promise<void>;
export async function upsertProductFromWebhook(shop: string, payload: any): Promise<void>;
export async function deleteProductFromWebhook(shop: string, payload: any): Promise<void>;
export async function getProductsByIds(shop: string, productIds: string[]): Promise<CatalogProduct[]>;
export async function getActiveProducts(shop: string): Promise<CatalogProduct[]>;
export function pickPrimaryVariant(p: CatalogProduct): CachedVariant | null; // first in-stock (or first) variant
```

- `syncCatalog`: paginated Admin GraphQL (small pages — 20 products × 10
  variants — to stay under the single-query cost cap; hard page-count stops
  against runaway loops) fetching title/handle/productType/vendor/status/tags/
  featuredImage/description, variants (price, compareAtPrice,
  inventoryQuantity, `inventoryItem { unitCost { amount } }`, image, sku) and,
  for each language in settings beyond the default:
  `translations(locale: $locale) { key value }` — keep `key == "title"` and
  the description translation (plain-texted, capped at 2 000 chars) and MERGE
  into `translationsJson`. Descriptions are stored plain-text: strip HTML,
  decode common entities, collapse whitespace; `descriptionShort` cut at ~300
  chars, `descriptionFull` at 12 000. Upsert into `ProductCache`, PRESERVING
  `aiDescription` AND `nameOverridesJson` (merchant-owned, never touched by
  sync). Set `Shop.catalogSyncedAt`. Wrap per-locale translation fetch in
  try/catch (missing `read_locales` must not break sync).
- `syncMarketsAndLocales`: `shopLocales { locale primary published }` → update
  settings `languages`/`defaultLanguage` (published only, keep order, primary
  first) via `saveSettings`. `markets(first: 50) { nodes { handle name enabled
  regions(first: 100) { nodes { ... on MarketRegionCountry { code } } } } }` →
  upsert `MarketSetting` (do not overwrite admin-set overrides on re-sync;
  only name/countries/currency/new rows). Also sync each market's base
  currency into `MarketSetting.currency` (best-effort, from the Markets API's
  currency settings); NEVER touch `previewFxRate` — it is admin-owned and
  preview-only. Tolerate schema differences with try/catch — markets sync is
  best-effort.
- Webhook upserts map REST payload fields (`product_type`, `compare_at_price`,
  `inventory_quantity`, `image.src`, tags as comma string; `body_html` →
  plain-texted `descriptionShort`/`descriptionFull`); preserve existing
  `unitCost`/`translationsJson`/`aiDescription`/`nameOverridesJson` when the
  webhook lacks them.

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
export async function claudeComplete(args: { model: string; system: string; prompt: string; maxTokens: number; temperature?: number; timeoutMs: number }): Promise<string>; // throws on error/timeout/truncation/refusal; `temperature` is IGNORED (kept for signature compat, never sent)
export type CopyReason = "cache" | "generated" | "ai_disabled" | "no_key" | "timeout_or_error";
export interface GenerateCopyArgs {
  shop: string; settings: AppSettings; mode: PromptKey;
  position: number; totalOffers: number; language: string;
  basket: { title: string; productType: string; quantity: number; description?: string }[];
  offerProducts: SelectedOfferProduct[];
  discountPct: number; currency: string; copyLength: CopyLength;
  bypassCache?: boolean; timeoutMs?: number;
  /** productId → effective description of the offered products; grounds the
   *  long-form deterministic fallback. Filled internally when absent. */
  offerDescriptions?: Record<string, string>;
}
export async function generateCopy(args: GenerateCopyArgs): Promise<{ copy: OfferCopy; discountSuggestion: number | null; cached: boolean; fallbackUsed: boolean; reason: CopyReason }>;
export async function generateBuyerCopy(args: GenerateCopyArgs): Promise<{ copy: OfferCopy; cached: boolean; fallbackUsed: boolean; extendedPending: boolean; reason: CopyReason }>;
export async function completeExtendedCopy(args: GenerateCopyArgs, core: OfferCopy): Promise<{ paragraphs: string[]; proof: string[]; closer: string } | null>;
export function fallbackCopy(args: GenerateCopyArgs, strings: Record<string, string>): OfferCopy; // deterministic, per-language-safe
export async function ensureUiStrings(shop: string, languages: string[]): Promise<void>;
export async function ensureUiStringsFresh(shop: string): Promise<void>; // self-healing pass, fired fire-and-forget from the dashboard loader; cheap no-op when current; NEVER throws
export async function getUiStrings(shop: string, language: string): Promise<Record<string, string>>; // requested lang → base lang ("pt-PT"→"pt") → "en" → DEFAULT_UI_STRINGS_EN, per key
export async function translateUiStrings(shop: string, languages: string[], opts?: { onlyMissing?: boolean }): Promise<{ translated: number; errors: string[] }>;
export async function translateTexts(settings: AppSettings, texts: string[], targetLang: string): Promise<string[]>; // Claude or DeepL per settings.translationProvider
```

- `claudeComplete`: `fetch("https://api.anthropic.com/v1/messages")`, headers
  `x-api-key: process.env.ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`,
  body `{ model, max_tokens, system, messages: [{role:"user",content:prompt}] }`,
  `AbortSignal.timeout(timeoutMs)`. Return concatenated text blocks.
  **Never send sampling params** and **disable thinking for
  `claude-sonnet-5*` / `claude-opus-5*` only** (`thinking: {type:"disabled"}`;
  no thinking param for any other model) — see §2 Claude API facts. Throw on
  `stop_reason === "max_tokens"` ("raise the template's max tokens") and
  `stop_reason === "refusal"` BEFORE concatenating text blocks; throw on empty
  text.
- Prompt templating: replace `{{brand_context}} {{tone}} {{language}}
  {{length}} {{basket_summary}} {{offer_summary}} {{discount_pct}} {{currency}}
  {{position}} {{total_offers}}` in both system and user templates.
  `basket_summary`: one line per basket item —
  `"2× Retinol Night Cream (Cream) — <full effective description>"`.
  `offer_summary` includes title (translated when available), type, price,
  discounted price, and the product's effective description.
- **Description budget**: per-product description text in prompts is capped at
  **20 000 chars** (word-boundary; matches the Products-tab AI-context cap so
  merchant text is never silently dropped). Safety valve: if
  basket_summary + offer_summary exceed **60 000 chars** combined, halve the
  per-product cap (floor 1 000) until they fit.
- Offered-product descriptions come from `ProductCache` via
  `effectiveDescription` (merchant `aiDescription` > `descriptionFull` >
  `descriptionShort`); lookup failure degrades to an empty map, never throws.
- DEFAULT_PROMPTS (direct-response tradition — channel proven desire, mine
  descriptions for actives/mechanisms, proof beats claims) must instruct:
  write in `{{language}}`; output ONLY one minified JSON object with the
  exact schema `{"headline": string, "lead": string, "bullets": string[],
  "paragraphs": string[], "proof": string[], "closer": string,
  "discount_suggestion": number|null}`; headline ≤ 60 chars, lead ≤ 240 chars
  (1–2 sentences, the promise), bullets 3–4 × 8–18 words (hard display cap 170 chars — validator buffers sit above prompt guidance so overruns render intact, never chopped with an ellipsis) (bundle: EXACTLY one
  bullet per offered product), paragraphs `{{length}}` (long: 2–3 × ≤ 450
  chars under "Why it works with your order" — mechanism / proof /
  relevance; short: `[]`), closer ≤ 120 chars (one calm reassurance line, no
  urgency), proof (long only): 2–3 × ≤ 200 chars of **widely-established
  published findings about ingredients explicitly named in the brief's
  descriptions** — never product-level claims, never invented
  journals/authors/statistics; no recognizable named ingredient → `[]`.
  NEVER imply the original purchase was wrong or incomplete; cosmetic claims
  only (no medical/drug claims); no emojis, no urgency/scarcity language;
  NEVER use an em dash (—) in any field — restructure with commas, periods
  or colons instead; mention the discount exactly once (lead or closer, never
  bullets/paragraphs/proof); every product name verbatim from the brief; the
  brief is the complete universe of products and facts. `bundle` variant
  sells the set as one routine; `sequential` variant fixes a distinct angle
  per position (1: natural companion, 2: new area/time of day, 3: rounding
  out long-term results).
- Model output validation (`validateModelCopy`): parse defensively (strip
  ``` fences, slice first `{` … last `}`); accept legacy `body` where `lead`
  is absent (merchant-edited old templates); require headline + lead;
  truncate word-boundary-aware (headline cap +20 slack, lead +60); bullets ≤ 4;
  paragraphs/proof kept ONLY when copyLength is `long` (≤ 3 each), else `[]`.
- **Em-dash policy (prompt rule + sanitizer)**: buyer-facing text must never
  contain an em dash. Layer 1: the copy AND translation prompts forbid it
  (see the DEFAULT_PROMPTS rules above). Layer 2: a sanitizer in
  `ai.server.ts` rewrites any em dash that slips through — in validated
  model copy and in translated UI strings — to natural punctuation BEFORE
  the text is cached or served, so a merchant-edited prompt that drops the
  rule can never leak one to a buyer. `DEFAULT_UI_STRINGS_EN`
  (`app/types.ts`) is itself em-dash-free (commas instead). Admin-facing
  text is out of scope.
- `generateCopy`: cacheKey = sha256 of
  `JSON.stringify([mode, sortedOfferSig, descSig, sortedBasketTitles(first 6),
  language, copyLength, String(roundedDiscountPct), String(promptVersion)])`
  (JSON keeps components unambiguously delimited). The key is
  **grounding-aware** (async — `await buildCacheKey(...)`): `offerSig` pairs
  each variantId with the buyer-facing name the prompt will use
  (`translatedTitle || title`, i.e. manual override → T&A → base title);
  `descSig` is a per-product sha256 (first 16 hex chars) of the offered
  products' grounding text from the **language-aware**
  `loadOfferDescriptions(shop, ids, language)` — the same call, with the
  same argument, that `buildTemplateVars` uses to build the prompt (AI
  context > T&A description for the buyer's language > full > short). The
  prompt is language-aware BY REQUIREMENT: feeding the primary-locale
  description to a foreign-language buyer makes the model echo the
  wrong-language product name embedded in it (production bug: German name
  inside English copy despite a correct manual name). Key and prompt MUST
  always call loadOfferDescriptions identically — if they diverge, edits on
  one side stop invalidating while the other side invalidates for nothing;
  `basketSig` pairs every basket line's title with a sha256(16) of its
  grounding description (basket lines DO carry per-language T&A text —
  hashed because the prompt consumes it). Fixing a name or editing grounding
  text therefore regenerates copy on the next assembly; unchanged catalogs
  still hit. `generateBuyerCopy` returns its `cacheKey` and callers pass it
  to `completeExtendedCopy` (pinned key), so the background merged write
  lands on the same row even if a grounding edit shifts the key mid-window.
  Rows orphaned by a grounding change are pruned by dashboard housekeeping
  (CopyCache `createdAt` older than 45 days, **except** rows holding a
  `discountSuggestion` — the baseline-pct row keeps AI discount convergence
  alive via peek and must never age out). Check `CopyCache` first.
  On miss: if `!settings.aiEnabled || !process.env.ANTHROPIC_API_KEY` →
  fallback (reason `ai_disabled`/`no_key`). Else race Claude with timeout
  (`args.timeoutMs ?? settings.aiTimeoutMs`); validate; store in cache. On
  timeout/error: return `fallbackCopy` AND fire the same generation without
  timeout in the background (45 s budget, `void promise.catch(...)`) to warm
  the cache for the next buyer (reason `timeout_or_error`).
- **CopyCache packing (no schema migration)**: paragraphs/closer/proof are
  packed into the existing `bulletsJson` column as
  `{"b": bullets, "p": paragraphs, "c": closer, "pr": proof}`. Legacy rows
  holding a plain array (bullets only) and packed rows written before the
  research block (no `pr`) must keep parsing — missing fields degrade to
  `[]`/`""`.
- **Two-stage buyer pipeline**:
  - `generateBuyerCopy` (buyer-blocking, hard ShouldRender budget):
    cache-first (a full cached row returns complete copy,
    `extendedPending: false`). On miss: ONE fast CORE call on
    `settings.coreCopyModel` (default `claude-haiku-4-5`) with
    `maxTokens = 1500` and a stage override appended to the rendered system
    prompt AFTER variable substitution, narrowing the output schema to
    `{"headline","lead","bullets","closer","discount_suggestion"}` (all other
    rules stand). Anything the model writes for paragraphs/proof is dropped.
    `copyLength === "short"` → the core result IS complete: cache it under
    the standard cacheKey, return `extendedPending: false`.
    `copyLength === "long"` → return the core copy with
    `extendedPending: true`; a core-only result is NEVER cached under the
    full cacheKey. Timeout/error → deterministic fallback + background FULL
    generation to warm the cache (same as `generateCopy`). Never throws.
  - `completeExtendedCopy(args, core)` (background): uses the prompt
    template's own model and maxTokens with the 45 s background timeout and a
    stage override carrying the live core copy verbatim, requesting
    `{"paragraphs","proof"}` only (same angle, no repetition, research
    guardrails, no discount mention). Requires ≥ 1 paragraph (proof alone may
    legitimately be `[]` under rule 10) — otherwise return null and cache
    nothing. On success writes the FULL merged copy (core + extended; the
    core's closer stands) to CopyCache under the standard cacheKey and
    returns `{ paragraphs, proof, closer }`. Logs and returns null on any
    error; never throws.
- `fallbackCopy` (deterministic, never invents facts): headline = joined
  (translated) product titles; body = offer_badge + discount line; bullets =
  save_pct / ships_free / one_click_note. A non-positive discount must never
  surface as "0% off" — omit discount phrasing entirely. Long copyLength
  additionally grounds 1–2 paragraphs in the offered products' effective
  descriptions (first ~2 sentences each; no description → no paragraph),
  closer = the guarantee sentence found in `settings.brandContext` (regex
  `guarantee|money.?back`) else ships_free, and **proof is ALWAYS `[]`** —
  the deterministic path must never render anything under the research
  heading (a mangled or out-of-context fragment would read as a fabricated
  citation).
- `ensureUiStrings`: seed `en` rows from `DEFAULT_UI_STRINGS_EN` (skip
  existing), then `translateUiStrings(shop, otherLangs, { onlyMissing: true })`
  best-effort (catch errors — never throw from bootstrap). UI string keys
  include the long-copy headings `why_it_works` ("Why it works with your
  order") and `research_shows` ("What published research shows").
- `ensureUiStringsFresh(shop)` (**self-healing UI strings** — bootstrap only
  runs at install, so keys added to `DEFAULT_UI_STRINGS_EN` by later app
  updates would otherwise wait for a reinstall): (a) seed missing `en` rows
  for newly added keys; (b) **old-default normalization** — rows still
  holding a PREVIOUS compiled default value (e.g. the pre-policy em-dash
  variants) are updated to the current default and their translations
  refreshed; merchant-edited values are NEVER overwritten; (c) translate the
  missing keys for the other enabled languages
  (`translateUiStrings(..., { onlyMissing: true })`). Must be a cheap no-op
  when everything is current (the dashboard calls it on every load,
  fire-and-forget) and must never throw.
- Translations: preserve `{placeholders}`; an empty or placeholder-losing
  translation is skipped (never upsert the English source — `onlyMissing`
  would never retry it).
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
export async function backfillPendingRevenue(shop: string, payload: any): Promise<void>;
export async function toCsv(rows: Array<Record<string, unknown>>): Promise<string>;
```

- `recordExtensionEvent`: look up `IssuedOffer` by `(referenceId, offerId)`;
  denormalize meta (ruleId, candidateIds, products with price/unitCost,
  discountPct, language, country, customerId, market, surface) into one
  `OfferEvent` row per event (for multi-product bundles write one row per
  product on `accepted`/`impression`, one aggregate row otherwise).
  `grossProfit` = Σ(discountedPrice − (unitCost ?? 0.55·price)).
  **Replay/race protection (`EventDedup`)**: at most one event of each type
  per offer page — `(shop, referenceId, position, eventType)` unique
  constraint claimed via `prisma.$transaction([eventDedup.create,
  offerEvent.createMany])` so the claim and the event rows commit atomically:
  concurrent duplicates lose on P2002 and are dropped; a failed write rolls
  back the claim instead of silently losing the event forever. Bandit
  counters increment for the shown candidateIds on `impression` and
  `accepted`; if a rule re-save recreated candidate rows (stale ids), fall
  back to matching the rule's current candidates by variantId. On
  `impression` (position 1 only) upsert
  `CustomerState.lastOfferAt/offersShown`; on `accepted` also increment
  `offersAccepted`. Never throw.
- `recordOrderFromWebhook`: upsert `OrderRecord` + lines from REST order
  payload (`id`, `customer.id`, `total_price`, `currency`,
  `shipping_address.country_code`, `line_items[]`). Match upsell: if an
  `OfferEvent` with `eventType="accepted"` exists whose `referenceId` numeric
  part equals the order id (or `orderId` matches), set `hadUpsellOffer`,
  `acceptedUpsell`, and mark matching lines `isUpsell` (variantId match) and
  backfill `OfferEvent.orderId`. Any impression event with same reference →
  `hadUpsellOffer = true`.
- **Payment-pending zero-revenue marker** (in `recordExtensionEvent`): an
  `accepted` event the extension flags with `message === "partially_processed"`
  (order edited but the changeset charge FAILED — Shopify runs its own
  payment recovery) still counts as an accept, but is recorded with
  revenue/grossProfit 0 and contributes 0 to candidate revenue. The flag can
  only ZERO revenue, never set it, so unlike raw client revenue it is safe
  to honor.
- `backfillPendingRevenue` (payment-recovery reconciliation, called from the
  orders/updated webhook when `payload.financial_status === "paid"`):
  restore the withheld money. Find this order's `accepted` OfferEvent rows
  with `revenue === 0` — referenceId/orderId matched by numeric tail against
  `payload.id` / `payload.admin_graphql_api_id`. Recompute revenue/GP from
  the IssuedOffer meta products (same math as the accept would have written)
  when the row still exists; else from the order's own `line_items` price
  for the line whose variant_id numeric tail matches the event's variantId
  (GP then uses the default unit-cost ratio). Add the same delta to the
  matching `OfferCandidate.revenue` counters — direct candidate id when it
  still exists, else the variantId fallback matching of the stale-candidate
  helper; revenue ONLY, the accept was already counted. ORDERS_UPDATED fires
  on every order edit: exit fast when no zero-revenue accepted rows match.
  Idempotent (restored rows stop matching the zero-revenue filter). Log what
  was backfilled; never throw.
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
export interface PageCopyDiagnostic {
  position: number;
  source: "ai" | "cache" | "fallback" | "reused" | "no_discount_fallback";
  reason?: string; // CopyReason / "exception"
}
export type LanguageSource = "buyer_locale" | "market_override" | "store_default";
export interface AssembleOfferOptions {
  copyTimeoutMs?: number;               // admin preview: generous budget, one-shot generateCopy
  diagnostics?: PageCopyDiagnostic[];   // out-param: per-page copy provenance
  languageResolution?: { language: string; source: LanguageSource }; // out-param
}
export async function assembleOfferResponse(ctx: PurchaseContext, options?: AssembleOfferOptions): Promise<OfferResponse>;
export async function assembleThankYouOffer(ctx: PurchaseContext, graphql: AdminGraphql | null): Promise<ThankYouOffer | null>;
```

`assembleOfferResponse`:
1. **Idempotent re-issue first**: if live (non-expired) `IssuedOffer` rows
   exist for `(shop, referenceId)` whose meta is `surface: "post_purchase"`
   and carries a stored `page` view, return those pages verbatim (sorted by
   position, diagnostics `reused`) — no new selection, no new rows. This is
   the Shop Pay re-fetch path: re-running the bandit there could credit
   impressions to candidate A and accepts to candidate B.
2. `getSettings` → `selectOffers` (empty → `{ offers: [], ... }` with strings
   still populated).
3. **Language: the buyer's OWN checkout locale wins** whenever it maps to an
   enabled store language (exact → case-insensitive → base-prefix before
   `-`, "pt-PT" matches "pt"). A market `languageOverride` applies ONLY when
   the buyer locale is missing or maps to no enabled language — a buyer who
   checked out in English must never be flipped to German by their shipping
   country. Fall back to `settings.defaultLanguage`. Report the resolution
   via `options.languageResolution`.
4. `getUiStrings(shop, language)` (merged over `DEFAULT_UI_STRINGS_EN`).
5. For each SelectedOffer (`buildOfferPage`): attach buyer-facing product
   titles with the **name precedence** — manual override
   (`nameOverrides[lang]`) → Translate & Adapt translation
   (`translations[lang].title`) → base title — each level matched exact →
   case-insensitive → base-prefix; the resolved name feeds BOTH the prompt
   brief (used verbatim by the model) and the payload
   (`SelectedOfferProduct.translatedTitle` → `OfferProductView.title`). Drop
   products whose variant id can't convert to the numeric changeset format.
   Basket lines carry the same name resolution and grounding descriptions
   (merchant `aiDescription` → translated description for the buyer's
   language → synced description). Copy mode: `bundle` if displayMode bundle
   && >1 product; `sequential` if totalOffers>1; else `single`. Copy path:
   - `roundedDiscountPct <= 0` → deterministic `fallbackCopy` (the prompts
     mandate mentioning the discount, which would surface "0% off"); empty
     `discountTitle`; changes carry no discount. Diagnostic
     `no_discount_fallback`.
   - `options.copyTimeoutMs` set (admin preview) → one-shot `generateCopy`
     with that budget: previews always show the REAL, complete AI copy — no
     background stage.
   - otherwise (buyer path) → `generateBuyerCopy`; `extendedPending` from its
     result.
   - **AI-discount convergence invariant** (`settings.discount.mode ===
     "ai"`): the pct a page is issued with ALWAYS equals the pct its copy
     was generated with — the copy can mention the discount, so the two must
     never diverge. A `discount_suggestion` returned by the CURRENT
     generation is therefore never applied to the page it came from; it is
     persisted alongside the cached copy, and suggestions take effect from
     the NEXT assembly via a cache peek: before generating copy, the
     orchestrator peeks the CopyCache row for the offer's signature, clamps
     any stored suggestion to [min,max], and derives the final pct — copy,
     prices, changes and discount title are all produced from that one pct.
6. Build `OfferChange[]` (`variantID: gidToNumber(variantId)`, quantity 1,
   discount title = strings.discount_applied with `{pct}` replaced; discount
   omitted when pct ≤ 0).
7. `offerId = crypto.randomUUID()`; persist `IssuedOffer` (changesJson,
   offerMetaJson with everything `recordExtensionEvent` needs — ruleId,
   candidateIds, products, discountPct, language, country, market,
   customerId, surface, position, currency, displayMode — PLUS the complete
   buyer-facing `page` view for idempotent re-issue; expiresAt now + 2h).
8. **Only after the row exists**, if `extendedPending`: fire-and-forget
   `patchExtendedCopy` — run `completeExtendedCopy`, then PATCH the stored
   meta: `page.copy.paragraphs`/`page.copy.proof` (closer only filled when
   the core produced none), `page.extendedPending = false`,
   `meta.extendedReady = true`. Every step guarded; a failure leaves the page
   permanently on its complete-in-itself core copy.
9. Prices in `OfferProductView` as decimal strings rounded to 2.
   **Multi-currency display**: when `ctx.presentmentCurrency` and
   `ctx.presentmentRate` are present (and the currency differs from the shop
   currency), the `OfferProductView` prices are converted with that rate for
   DISPLAY and the response `currency` names the display currency — engine
   math, rule thresholds, discount tiers, changesets, `IssuedOffer` meta and
   analytics revenue/GP all stay in SHOP currency (percentage discounts are
   currency-agnostic). Fields absent → shop-currency display. The response
   `ui` object carries `{ showCountdown, countdownMinutes, copyLength,
   showComparePrice }`.

Routes (all: `action` = POST logic, `loader` = `const { cors } = await
authenticate.public.checkout(request); return cors(json({ ok: true }))` so
preflight/GET succeed; wrap responses in `cors(...)`; on any internal error
return `cors(json({ offers: [] }))` (or `{ ok: false }` / `{ ready: false }`)
with status 200):

- **`api.offer.tsx`**: shop = `sessionToken.input_data?.shop?.domain ?? new
  URL((sessionToken as any).dest ?? "https://x").hostname`; build
  `PurchaseContext` from `input_data.initialPurchase` (ids via `toGid`,
  `locale` from input_data, surface "post_purchase"). `ctx.totalAmount` and
  `ctx.currency` MUST come from **shopMoney** (fallback presentment only when
  shopMoney is absent): rule min/max totals, discount tiers, and catalog
  prices are all shop-currency, so threshold math in another currency is
  wrong (a ¥12,000 order is not "≥ €120"). Additionally set
  `ctx.presentmentCurrency`/`ctx.presentmentRate` from the order's
  presentmentMoney — the rate is the **implied order rate**
  `presentmentTotal / shopTotal`, i.e. Shopify's own conversion for this
  exact order; leave both unset when presentment equals the shop currency or
  either total is missing/unparseable/zero. These drive DISPLAY-only price
  conversion (§5-E step 9); buyer-exact accept totals still come from
  `calculateChangeset` client-side. The request body is
  NEVER read: `referenceId` comes EXCLUSIVELY from the verified token's
  `initialPurchase` — when the token carries none (e.g. a thank-you token),
  fall back to `crypto.randomUUID()` so IssuedOffers are never minted under
  an attacker-chosen id — and customerId ONLY from the verified token.
  Return `assembleOfferResponse`.
- **`api.offer-extended.tsx`**: POST `{ referenceId, offerId }` (both
  regex-validated: referenceId `[A-Za-z0-9:/_.-]{1,80}`, offerId
  `[A-Za-z0-9-]{1,64}`); shop derived like api.events. Look up
  `IssuedOffer` by `(referenceId, offerId)`, verify `row.shop === shop`.
  Respond `{ ready: false }` until the background completion has patched the
  meta (`meta.extendedReady === true`), then `{ ready: true, paragraphs,
  proof, closer }` (string-array-sanitized from the stored meta — stored data
  is never trusted as typed). Never 500s.
- **`api.sign-changeset.tsx`**: body `{ referenceId, offerId }`; look up
  non-expired `IssuedOffer`; sign per §2; `cors(json({ token }))`; 404-style
  `{ error }` JSON if unknown.
- **`api.events.tsx`**: body = `ExtensionEventPayload` (eventType allow-list,
  referenceId/offerId regex-validated, message capped at 500 chars); derive
  shop like api.offer; no client-supplied customerId is forwarded —
  `recordExtensionEvent` derives everything from the stored IssuedOffer meta;
  `{ ok: true }`.
- **`api.typ-offer.tsx`**: body is `{ orderId, locale? }` ONLY — `orderId`
  (gid or numeric) is REQUIRED and serves purely as a lookup key, `locale`
  may set the display language; every other client field (line items,
  totals, currency, country, customerId) is ignored. Shop from
  `sessionToken.dest` hostname; if `settings.thankYouEnabled === false` →
  `{ offer: null }`. The purchase context is rebuilt EXCLUSIVELY from
  server-side data: the OrderRecord captured by orders/create, else ONE
  admin API order lookup (surface "thank_you", referenceId =
  `typ:${orderNumericId}`). Two guards, both failing closed to
  `{ offer: null }`: **60-minute recency** — orders created more than 60
  minutes ago (or whose creation date is missing/unparseable) are refused,
  so a captured or replayed token cannot mint discount codes against stale
  historical order ids; and **token-customer binding** — when both the
  verified session token and the order carry a customer id, they must
  denote the same customer (numeric-tail comparison; skipped when either
  side is absent, e.g. guest checkout). Response
  `{ offer: ThankYouOffer | null }` — `ThankYouOffer` carries `referenceId`
  which the extension must echo verbatim in `/api/events` payloads.

`assembleThankYouOffer` (never throws; null on any failure):
1. **Idempotency — at most one discount code per order.** The offerId is
   DETERMINISTIC for numeric references: `typ-${numericRef}`; combined with
   the `IssuedOffer @@unique([referenceId, offerId])` constraint this makes
   minting race-proof (P2002 losers rebuild and return the winner's stored
   offer instead of minting more codes). Before the hourly cap and before any
   code creation, check the deterministic slot **without an expiry filter**
   (a >2h revisit must not mint a fresh code, collide on insert and orphan
   it): a foreign-shop slot → null; a rebuildable slot → extend its
   `expiresAt` (so `/api/events` keeps matching) and return the rebuilt
   offer; a non-rebuildable slot (pre-`productView`/`copy`/`checkoutUrl`
   meta) → null, never a second code. Also scan live `typ:`-prefixed rows
   whose trailing numeric matches.
2. Abuse bound: max **20** thank-you offers minted per shop per hour
   (`typ:` reference prefix count) — over the cap → null.
3. `selectOffers` (1 offer) → first product; market/language/strings/basket
   as in assembleOfferResponse (buyer-locale-first language resolution).
4. **Create the discount code FIRST** so the copy is generated with the
   final, redeemable percentage: `unauthenticated.admin(shop)` GraphQL
   `discountCodeBasicCreate` (code `THANKYOU-${6 random A-Z0-9}` via
   crypto.getRandomValues, pct off, `appliesOncePerCustomer: true`,
   `usageLimit: 1`, ends in 48h, applies to the offer product) and
   `checkoutUrl = https://${shop}/cart/${gidToNumber(variantId)}:1?discount=${code}`.
   If code creation fails or graphql is null → **discountPct = 0** (never
   promise a discount the buyer cannot redeem), plain product URL
   (`/products/${handle}`, else cart permalink), deterministic fallback copy.
5. Copy: always `copyLength: "short"` (the thank-you card is a small block on
   a busy page); with a working code → `generateCopy` (fallback on error);
   without → `fallbackCopy` directly.
6. Persist IssuedOffer with meta incl. `productView`, `copy`, `discountCode`,
   `checkoutUrl` (needed for rebuild); changes = [].

### F — `webhooks.tsx`

`const { topic, shop, payload } = await authenticate.webhook(request);`
switch (topic): ORDERS_CREATE → `recordOrderFromWebhook`; ORDERS_UPDATED →
when `payload.financial_status === "paid"` → `backfillPendingRevenue`
(payment-recovery revenue backfill for accepted-with-pending-payment events;
any other update is ignored); PRODUCTS_CREATE /
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
  opportunistically in loader (try/catch). The loader additionally fires
  `ensureUiStringsFresh(shop)` (ai.server) **fire-and-forget** — `void
  promise.catch(log)` inside a try/catch — so UI-string keys added by app
  updates self-heal their translations without waiting for a reinstall; it
  must never block or break the dashboard.
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
  model Select (`claude-haiku-4-5` "fast", `claude-sonnet-5` "best"; an
  unknown stored model is kept as an extra option), maxTokens (default 4000 —
  caps thinking + output on current Claude models, so keep ≥1000; no
  temperature control, sampling params are not sent); Save (bumps `version`);
  "Reset to default" (intent per key); Preview section: language Select +
  "Generate preview" → action uses catalog products as fake basket + offer,
  `bypassCache: true`, renders headline/lead/bullets/paragraphs/proof/closer
  + latency + fallback flag. Info Card documenting all template variables.
  **I `app.settings.tsx`**: sections per §5 settings: General, Discount
  (mode select + value/min/max + tier rows add/remove), Frequency & hygiene,
  Optimization (metric, rotation fields, "Reset experiment stats" + "Pick
  winners now" buttons), Markets (table from MarketSetting: enabled,
  discountOverride, languageOverride, maxOffersOverride, the synced
  `currency` (read-only) and an editable `previewFxRate` — **preview-only**,
  used exclusively to simulate the market's currency on the Preview page,
  never on a live-buyer path (live buyers get the rate implied by their own
  order); per-row **health checks** flag a market with no synced currency
  (fix: "Re-sync") and a market whose currency differs from the shop
  currency but has no previewFxRate (its previews fall back to shop-currency
  display; live buyers unaffected); "Re-sync" button — never overwrites
  admin-set overrides incl. previewFxRate),
  Languages (checkboxes from settings.languages ∪ CELLEXIA_LANGUAGES,
  defaultLanguage select), AI (aiEnabled, **copy model** + **core copy
  model** — the core model generates the above-the-fold copy inside the
  checkout time budget (`claude-haiku-4-5` recommended); the template's model
  generates the detailed sections in the background —, timeout,
  translationProvider + translationModel, banner if `ANTHROPIC_API_KEY`
  missing). Each section its own submit intent.
  **I `app.translations.tsx`**: language Select (settings.languages);
  editable table key → value for `UI_STRING_KEYS` (missing = placeholder from
  EN); Save all; "Auto-translate missing" and "Re-translate all" buttons
  calling `translateUiStrings`; note that offer copy itself is generated
  per-language by AI, these are the static button/labels.
- **M `app.products.tsx` (Products — the AI copywriter's product knowledge)**:
  paginated (20/page), title-searchable list of the `ProductCache` rows.
  Per product: thumbnail, type, name-coverage badge
  (`x/y names covered` — a language counts when it has a manual override OR
  a synced Translate & Adapt translation OR is the default language, covered
  by the base title), Shopify-description length badge (or "No Shopify
  description" warning), "AI context set" badge, and a collapsible section
  with (a) the **AI context** editor (multiline TextField, `maxLength`
  20 000 with character count — the cap is ALSO enforced server-side; saved
  via a `saveAi` intent into `ProductCache.aiDescription`; empty = cleared,
  Shopify description used) and (b) the **"Product names by language"
  grid**: one TextField per enabled language (settings.languages, default
  language first), prefilled with the manual override, placeholder = the
  synced Translate & Adapt name, else the base title with a subdued
  "(default title)" note; helpText "Manual names always win over Translate &
  Adapt and survive every sync."; per-product **Save names** button →
  `saveNames` intent writing `ProductCache.nameOverridesJson` (values
  trimmed, capped at 300 chars each — server-enforced; empty = remove the
  override; submitted keys restricted to enabled languages; overrides for
  since-disabled languages are preserved). Primary action "Sync catalog &
  translations" (`sync` intent → syncCatalog + syncMarketsAndLocales).
  Explainer card: grounding precedence AI context → full Shopify description
  → short excerpt; NAME precedence manual override → Translate & Adapt →
  base title. Empty state prompts a first sync.
- **N `app.preview.tsx` (Preview — exactly what a buyer sees)**: merchant
  builds a fake basket (Combobox picker over the catalog cache, quantities,
  EUR total), picks shipping country (COMMON_COUNTRIES ∪ all MarketSetting
  countries) + buyer language, optional "Regenerate copy" checkbox (clears
  this shop's ENTIRE CopyCache first — deliberate: the sha256 key can't be
  re-derived here without duplicating ai.server internals, and rows are
  cheap). Action runs the REAL pipeline: server-side price re-derivation
  (client never sends money), `PurchaseContext` with a throwaway
  `referenceId = "preview:" + uuid` (so per-referenceId reuse never kicks
  in), `assembleOfferResponse(ctx, { copyTimeoutMs: 30_000, diagnostics })` —
  previews wait for real AI copy instead of the buyer budget.
  **Market currency simulation**: when the selected country's MarketSetting
  has a `currency` differing from the shop currency AND a `previewFxRate`,
  set `ctx.presentmentCurrency`/`ctx.presentmentRate` from them so the
  preview shows that market's prices in its own currency (display-only, per
  §5-E step 9); without a rate the preview falls back to shop-currency
  display (surfaced by the Markets health checks). Live buyers never read
  `previewFxRate` — their rate is implied by their own order. `finally`:
  delete the preview's IssuedOffer rows (never pollute the sign-changeset
  table or analytics). Renders through `PostPurchasePreview` (module N shared
  component — a faithful replica of the extension layout, desktop/390px
  mobile toggle) plus badges: latency, AI/cached/fallback copy (+ fallback
  cause), model, resolved language + resolution source
  (buyer locale / market override / store default), offer count; per-page
  copy-provenance strip for multi-page runs; empty-result Banner explaining
  likely causes; warning Banner when `ANTHROPIC_API_KEY` is missing.

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
  Image left, right column: Heading (copy.headline), TextBlock (copy.body —
  the lead), bullets as TextBlock rows prefixed "• ", price row, subdued
  strings.ships_free + strings.one_click_note, countdown line (strings.time_left
  + mm:ss ticking, only when ui.showCountdown; on expiry call done()).
  **Long copy (below the CTA, so the button stays above the fold on
  mobile)**: `copy.paragraphs` rendered under a strings.why_it_works heading;
  `copy.proof` rendered under a strings.research_shows heading; `copy.closer`
  as a one-line reassurance directly above the buttons. Empty/absent arrays
  hide their section entirely.
- **Extended-copy polling**: a page may arrive with `extendedPending: true`
  while its below-CTA sections are still generating server-side. Poll
  `POST ${APP_URL}/api/offer-extended` `{ referenceId, offerId }` for the
  ACTIVE page only — attempt gaps ~1.2s / 1.8s / 3s / 5s / 8s / 10s
  (attempts land at roughly 1.2s, 3s, 6s, 11s, 19s and 29s), max 6 attempts
  per offerId; skip when the inline copy
  already carries below-CTA content or the page was already merged. On
  `{ ready: true }` merge paragraphs/proof/closer into local state so the
  sections appear when ready. Strictly best-effort: failures leave the
  sections hidden and never touch accept/decline/countdown/analytics.
- Bundle page: BlockStack of product rows (small Image, title, price each) +
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
"thank_you") **using `offer.referenceId` verbatim**.
`locales/en.default.json`: `{ "name": "Cellexia Thank You Upsell" }`
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
(plain English); how prompts/variables work (incl. the two-stage pipeline and
the Products-tab AI context); analytics definitions incl. CLV cohorts; GDPR
notes. MERCHANT_GUIDE: how to use each admin page (incl. Products and
Preview), strategy best practices (10–15% discount, one offer for
single-product orders, etc.). README.md: short overview + quick start + doc
links + repo map.

## 10. Definition of done (every module)

- Compiles under `tsc --noEmit` with the repo tsconfig (strict).
- Only exports/imports declared here; no new dependencies.
- No hardcoded shop domains or API keys; everything per-shop from the DB.
- Public endpoints never 500 (degrade gracefully) and always use `cors()`.
- UI text in admin: English. Buyer-facing text: from UiString/AI only.
