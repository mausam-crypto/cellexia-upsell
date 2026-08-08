// ─────────────────────────────────────────────────────────────────────────────
// Offer orchestrator — assembles the buyer-facing offer payloads served by the
// public API routes. Coordinates the recommendation engine, the AI copywriter,
// catalog translations and UI strings, and persists IssuedOffer rows that
// /api/sign-changeset later validates against (never sign client-supplied
// changes). Public-endpoint contract: these functions never throw — every
// failure degrades to an empty offer list / null offer.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { gidToNumber, jparse, jstr } from "../lib/json";
import {
  DEFAULT_UI_STRINGS_EN,
  type AdminGraphql,
  type AppSettings,
  type CopyLength,
  type DisplayMode,
  type OfferChange,
  type OfferCopy,
  type OfferPage,
  type OfferProductView,
  type OfferResponse,
  type PurchaseContext,
  type SelectedOffer,
  type SelectedOfferProduct,
  type SelectionResult,
  type ThankYouOffer,
} from "../types";
import { getSettings } from "./settings.server";
import { selectOffers } from "./recommendation.server";
import {
  completeExtendedCopy,
  fallbackCopy,
  generateBuyerCopy,
  generateCopy,
  getUiStrings,
  peekDiscountSuggestion,
  withOfferDescriptions,
  type GenerateCopyArgs,
  type PromptKey,
} from "./ai.server";
import {
  effectiveDescription,
  effectiveProductName,
  effectiveTranslatedDescription,
  explainProductName,
  explainTranslatedDescription,
  getProductsByIds,
  type CatalogProduct,
} from "./catalog.server";
import {
  getContextualPrices,
  resolveUniformPricing,
  type ContextualVariantPrice,
} from "./market-pricing.server";
import {
  createDebugTrace,
  debugAdd,
  debugText,
  persistDebugTrace,
  scanForForeignNames,
  type DebugTrace,
} from "./debug.server";

/** Issued offers can be signed for up to 2 hours after they were assembled. */
const OFFER_TTL_MS = 2 * 60 * 60 * 1000;

/** Where each page's copy actually came from — surfaced in admin previews. */
export interface PageCopyDiagnostic {
  position: number;
  source: "ai" | "cache" | "fallback" | "reused" | "no_discount_fallback";
  reason?: string;
}

/**
 * Caller options for assembleOfferResponse. The buyer path passes nothing
 * (strict aiTimeoutMs budget — ShouldRender must answer fast); admin previews
 * pass a generous copyTimeoutMs so they always show REAL AI copy, plus a
 * diagnostics array to receive per-page copy provenance.
 */
export interface AssembleOfferOptions {
  copyTimeoutMs?: number;
  diagnostics?: PageCopyDiagnostic[];
  /** Out-param: how the response language was chosen (admin preview trace). */
  languageResolution?: { language: string; source: LanguageSource };
  /**
   * Out-param: how the displayed prices were produced. "contextual" = real
   * per-country prices from Shopify contextualPricing; "fx" = base prices
   * converted with the presentment rate; "shop" = plain shop-currency prices.
   */
  pricingSource?: "contextual" | "fx" | "shop";
  /**
   * Diagnostic trace: pass a fresh createDebugTrace() to capture every
   * resolution step (language, market, names, grounding, pricing, the exact
   * prompts and raw model output). The finished trace is persisted to
   * DebugEvent (Debug tab) AND left on this field for the caller to render.
   * When absent, live requests self-instrument if settings.debugLiveRequests
   * is on. Purely observational — never changes the assembled response.
   */
  debug?: DebugTrace;
}

/** Uniform contextual pricing applied to one response's product views. */
interface ContextualPricingResult {
  byVariant: Map<string, ContextualVariantPrice>;
  currency: string;
}

/**
 * Real per-country display pricing for every offered variant, all-or-nothing:
 * either ALL variants have a contextual price in one shared currency (then it
 * is used for the buyer-facing views) or null (then the FX-rate conversion —
 * or plain shop currency — applies as before). Never throws.
 */
async function resolveContextualPricing(
  ctx: PurchaseContext,
  variantIds: string[],
  trace?: DebugTrace,
): Promise<ContextualPricingResult | null> {
  if (!ctx.countryCode || variantIds.length === 0) {
    debugAdd(trace, "contextual-pricing", {
      skipped: !ctx.countryCode ? "no country code in context" : "no offered variants",
    });
    return null;
  }
  try {
    const prices = await getContextualPrices(ctx.shop, variantIds, ctx.countryCode);
    if (trace) {
      // Per-variant raw result + WHY the all-or-nothing check accepts/rejects.
      let rejectedBecause: string | null = prices === null ? "no contextual prices available at all (offline session missing, Shopify error/timeout with no cached rows, or invalid country)" : null;
      let currency = "";
      if (prices !== null) {
        for (const id of variantIds) {
          const p = prices.get(id);
          if (!p) { rejectedBecause = `variant ${id}: no contextual price row`; break; }
          if (p.price === null || p.price <= 0) { rejectedBecause = `variant ${id}: Shopify returned no buyer price for ${ctx.countryCode} (variant likely not published in that market's catalog) — cached as a miss for up to 6h`; break; }
          if (!p.currency) { rejectedBecause = `variant ${id}: price row has no currency`; break; }
          if (!currency) currency = p.currency;
          else if (currency !== p.currency) { rejectedBecause = `currency mismatch across variants: ${currency} vs ${p.currency} (${id})`; break; }
        }
      }
      debugAdd(trace, "contextual-pricing", {
        country: ctx.countryCode,
        variants: variantIds.map((id) => {
          const p = prices?.get(id);
          return {
            variantId: id,
            price: p?.price ?? null,
            compareAtPrice: p?.compareAtPrice ?? null,
            currency: p?.currency || null,
            rowPresent: Boolean(p),
          };
        }),
        accepted: rejectedBecause === null,
        ...(rejectedBecause ? { rejectedBecause } : {}),
      });
    }
    return resolveUniformPricing(prices, variantIds);
  } catch (error) {
    debugAdd(trace, "contextual-pricing", {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[orchestrator] contextual pricing failed for ${ctx.shop}`, error);
    return null;
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

function clampDiscount(suggestion: number, settings: AppSettings): number {
  const lo = Math.min(settings.discount.min, settings.discount.max);
  const hi = Math.max(settings.discount.min, settings.discount.max);
  return Math.round(Math.min(hi, Math.max(lo, suggestion)));
}

function randomCode(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export type LanguageSource = "buyer_locale" | "market_override" | "store_default";

/**
 * Language resolution: the buyer's OWN checkout locale wins whenever it maps
 * to an enabled store language (exact → case-insensitive → base-prefix,
 * "pt-PT" matches "pt"). A market languageOverride applies only when the
 * buyer locale is missing or not an enabled language — a buyer who checked
 * out in English must never be flipped to another language by their shipping
 * country (that produced "German product names in an English preview").
 * Falls back to the store default.
 */
function resolveLanguageWithSource(
  locale: string | null | undefined,
  settings: AppSettings,
  marketLanguageOverride: string | null | undefined,
): { language: string; source: LanguageSource } {
  const languages = Array.isArray(settings.languages) ? settings.languages : [];
  const loc = String(locale ?? "").trim();
  if (loc.length > 0) {
    const exact = languages.find((l) => l === loc);
    if (exact) return { language: exact, source: "buyer_locale" };
    const ci = languages.find((l) => l.toLowerCase() === loc.toLowerCase());
    if (ci) return { language: ci, source: "buyer_locale" };
    const base = loc.split("-")[0].toLowerCase();
    const prefix = languages.find((l) => l.toLowerCase().split("-")[0] === base);
    if (prefix) return { language: prefix, source: "buyer_locale" };
  }
  if (marketLanguageOverride && marketLanguageOverride.trim().length > 0) {
    return { language: marketLanguageOverride.trim(), source: "market_override" };
  }
  return { language: settings.defaultLanguage || "en", source: "store_default" };
}

function resolveLanguage(
  locale: string | null | undefined,
  settings: AppSettings,
  marketLanguageOverride: string | null | undefined,
): string {
  return resolveLanguageWithSource(locale, settings, marketLanguageOverride).language;
}

// Product NAME resolution lives in catalog.server's effectiveProductName
// (merchant nameOverrides → Translate & Adapt title → base title, same
// exact → case-insensitive → base-prefix language chain as before). Only the
// DESCRIPTION lookup below stays local — descriptions have no override layer.

/** Best-effort translated description lookup from the catalog translations map. */
function translationDescription(
  translations: Record<string, { title?: string; description?: string }> | undefined,
  language: string,
): string | undefined {
  // Delegates to the catalog's single language-chain implementation so this
  // path can never drift from previews and prompt grounding again.
  return effectiveTranslatedDescription(translations, language);
}

async function safeGetUiStrings(
  shop: string,
  language: string,
): Promise<Record<string, string>> {
  try {
    const strings = await getUiStrings(shop, language);
    return { ...DEFAULT_UI_STRINGS_EN, ...strings };
  } catch (error) {
    console.error(`[orchestrator] getUiStrings failed for ${shop}/${language}`, error);
    return { ...DEFAULT_UI_STRINGS_EN };
  }
}

/**
 * Ground a deterministic-fallback's args in real product text (fills
 * offerDescriptions via ai.server's withOfferDescriptions, a no-op for short
 * copy). Guarded: a lookup failure degrades to the ungrounded args instead
 * of throwing — fallback paths run on the public never-throw contract.
 */
async function groundedCopyArgs(copyArgs: GenerateCopyArgs): Promise<GenerateCopyArgs> {
  try {
    return await withOfferDescriptions(copyArgs);
  } catch (error) {
    console.error(`[orchestrator] fallback grounding failed for ${copyArgs.shop}`, error);
    return copyArgs;
  }
}

/** Find the MarketSetting whose country list contains the buyer country. */
async function findMarketForCountry(shop: string, countryCode: string | null) {
  if (!countryCode) return null;
  try {
    const rows = await prisma.marketSetting.findMany({ where: { shop } });
    const cc = countryCode.trim().toUpperCase();
    return (
      rows.find((m) =>
        jparse<string[]>(m.countriesJson, []).some(
          (c) => String(c).trim().toUpperCase() === cc,
        ),
      ) ?? null
    );
  } catch (error) {
    console.error(`[orchestrator] market lookup failed for ${shop}`, error);
    return null;
  }
}

/** One catalog fetch for basket + offered products (translations, handles). */
async function loadCatalog(
  ctx: PurchaseContext,
  selection: SelectionResult,
): Promise<Map<string, CatalogProduct>> {
  const ids = new Set<string>();
  for (const line of ctx.lineItems) ids.add(line.productId);
  for (const offer of selection.offers) {
    for (const product of offer.products) ids.add(product.productId);
  }
  if (ids.size === 0) return new Map();
  try {
    const rows = await getProductsByIds(ctx.shop, [...ids]);
    return new Map(rows.map((p) => [p.productId, p]));
  } catch (error) {
    console.error(`[orchestrator] catalog lookup failed for ${ctx.shop}`, error);
    return new Map();
  }
}

function buildBasket(
  ctx: PurchaseContext,
  catalogById: Map<string, CatalogProduct>,
  language: string,
): { title: string; productType: string; quantity: number; description: string }[] {
  return ctx.lineItems.map((line) => {
    const cached = catalogById.get(line.productId);
    // Grounding text for the copywriter, best first: merchant-written AI
    // context (aiDescription, via effectiveDescription) → the Translate &
    // Adapt description for the buyer's language (keeps the pitch consistent
    // with the translated product names) → the synced Shopify description.
    const translatedDescription =
      cached && !cached.aiDescription.trim()
        ? translationDescription(cached.translations, language)
        : undefined;
    return {
      // Buyer-facing name for the buyer's language (merchant nameOverrides →
      // Translate & Adapt → base title), so prompts reference products by the
      // names the customer actually shopped.
      title:
        (cached ? effectiveProductName(cached, language) : undefined) ||
        line.title ||
        "Item from this order",
      productType: cached?.productType ?? "",
      quantity: line.quantity,
      // What the purchased product does — lets the copywriter ground the
      // pitch in the customer's actual routine instead of category guesses.
      description: cached ? translatedDescription ?? effectiveDescription(cached) : "",
    };
  });
}

function metaProduct(p: SelectedOfferProduct) {
  return {
    productId: p.productId,
    variantId: p.variantId,
    title: p.title,
    price: p.price,
    unitCost: p.unitCost,
  };
}

/** Display-only FX conversion for the buyer-facing product views. */
interface DisplayFx {
  currency: string;
  rate: number;
}

/**
 * The display conversion implied by the buyer's own order, when the context
 * carries one (presentmentRate = presentmentTotal / shopTotal). Engine math,
 * changesets, discount pct and IssuedOffer meta prices ALL stay shop-currency
 * — this only converts what the buyer SEES. Null when the context has no
 * usable rate/currency pair (then views stay shop-currency, always correct).
 */
function displayFxFromContext(ctx: PurchaseContext): DisplayFx | null {
  const rate = ctx.presentmentRate;
  const currency = ctx.presentmentCurrency;
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    typeof currency !== "string" ||
    !currency ||
    currency === ctx.currency
  ) {
    return null;
  }
  return { currency, rate };
}

function toProductView(
  p: SelectedOfferProduct,
  discountPct: number,
  fx?: DisplayFx | null,
  ctxPrice?: ContextualVariantPrice | null,
): OfferProductView {
  // Real per-country price wins outright: the amounts ARE what the buyer's
  // checkout charges (market adjustments / price lists included), so no rate
  // math applies. compareAt comes only from the same context — mixing a
  // converted base compareAt with a contextual price could contradict it.
  if (ctxPrice && ctxPrice.price !== null && ctxPrice.price > 0) {
    const discounted = Math.round(ctxPrice.price * (1 - discountPct / 100) * 100) / 100;
    return {
      productId: p.productId,
      variantId: p.variantId,
      title: p.translatedTitle ?? p.title,
      image: p.image,
      price: ctxPrice.price.toFixed(2),
      discountedPrice: discounted.toFixed(2),
      compareAtPrice:
        ctxPrice.compareAtPrice !== null && ctxPrice.compareAtPrice > ctxPrice.price
          ? ctxPrice.compareAtPrice.toFixed(2)
          : null,
    };
  }
  // Shop-currency math first (identical to the signed changeset amounts),
  // then the optional display conversion: multiply by the rate, round to 2dp.
  const discounted = Math.round(p.price * (1 - discountPct / 100) * 100) / 100;
  const display = (amount: number): string =>
    (fx ? Math.round(amount * fx.rate * 100) / 100 : amount).toFixed(2);
  return {
    productId: p.productId,
    variantId: p.variantId,
    title: p.translatedTitle ?? p.title,
    image: p.image,
    price: display(p.price),
    discountedPrice: display(discounted),
    compareAtPrice: p.compareAtPrice != null ? display(p.compareAtPrice) : null,
  };
}

async function persistIssuedOffer(args: {
  ctx: PurchaseContext;
  offerId: string;
  changes: OfferChange[];
  meta: Record<string, unknown>;
}): Promise<void> {
  await prisma.issuedOffer.create({
    data: {
      shop: args.ctx.shop,
      referenceId: args.ctx.referenceId,
      offerId: args.offerId,
      changesJson: jstr(args.changes),
      offerMetaJson: jstr(args.meta),
      expiresAt: new Date(Date.now() + OFFER_TTL_MS),
    },
  });
}

/**
 * Background stage for pages issued with extendedPending: generate the
 * below-CTA sections (paragraphs/proof) via completeExtendedCopy, then PATCH
 * the stored IssuedOffer meta so /api/offer-extended (and stored-page reuse
 * for the same referenceId) serve the completed copy. Every step is guarded —
 * this must never affect the request path; a failure simply leaves the page
 * permanently on its (complete-in-itself) core copy.
 */
async function patchExtendedCopy(args: {
  shop: string;
  referenceId: string;
  offerId: string;
  copyArgs: GenerateCopyArgs;
  coreCopy: OfferCopy;
  /** The fast core call's suggestion — persisted when the merged CopyCache
   *  row is created, so the NEXT assembly's peek can converge on it. */
  coreDiscountSuggestion: number | null;
  /** The core call's cache key — pins the merged write to the same row. */
  coreCacheKey?: string;
}): Promise<void> {
  try {
    const extended = await completeExtendedCopy(
      args.copyArgs,
      args.coreCopy,
      args.coreDiscountSuggestion,
      args.coreCacheKey,
    );
    if (!extended) return;
    // Read-modify-write inside ONE transaction so a concurrent writer (e.g. a
    // GDPR scrub nulling customerId) is never resurrected or clobbered: the
    // merge starts from the FRESH meta and touches ONLY the extended keys.
    await prisma.$transaction(async (tx) => {
      const row = await tx.issuedOffer.findUnique({
        where: {
          referenceId_offerId: { referenceId: args.referenceId, offerId: args.offerId },
        },
      });
      if (!row || row.shop !== args.shop) return;
      const meta = jparse<any>(row.offerMetaJson, null);
      if (!meta || typeof meta !== "object") return;
      const page = meta.page;
      if (!page || typeof page !== "object" || !page.copy || typeof page.copy !== "object") {
        return;
      }
      page.copy.paragraphs = extended.paragraphs;
      page.copy.proof = extended.proof;
      // The buyer already saw the core closer — only fill it in when the core
      // stage produced none and the extended stage did.
      const coreCloser =
        typeof page.copy.closer === "string" ? page.copy.closer.trim() : "";
      if (!coreCloser && extended.closer) page.copy.closer = extended.closer;
      page.extendedPending = false;
      meta.extendedReady = true;
      await tx.issuedOffer.update({
        where: {
          referenceId_offerId: { referenceId: args.referenceId, offerId: args.offerId },
        },
        data: { offerMetaJson: jstr(meta) },
      });
    });
  } catch (error) {
    console.error(
      `[orchestrator] extended copy patch failed for ${args.shop} ${args.referenceId}/${args.offerId}`,
      error,
    );
  }
}

// ── Post-purchase offer assembly ─────────────────────────────────────────────

async function buildOfferPage(args: {
  ctx: PurchaseContext;
  settings: AppSettings;
  selection: SelectionResult;
  offer: SelectedOffer;
  totalOffers: number;
  language: string;
  strings: Record<string, string>;
  basket: { title: string; productType: string; quantity: number; description: string }[];
  catalogById: Map<string, CatalogProduct>;
  marketHandle: string | null;
  /** Resolved after the copy call — overlaps the Shopify pricing round-trip. */
  ctxPricingPromise: Promise<ContextualPricingResult | null>;
  options?: AssembleOfferOptions;
}): Promise<OfferPage | null> {
  const {
    ctx,
    settings,
    selection,
    offer,
    totalOffers,
    language,
    strings,
    basket,
    catalogById,
    marketHandle,
    ctxPricingPromise,
    options,
  } = args;

  // Attach buyer-facing names (merchant overrides → T&A → base title) and
  // drop any product whose variant id cannot be converted to the numeric
  // changeset format (it could never be signed).
  const products: SelectedOfferProduct[] = offer.products
    .map((p) => {
      const cached = catalogById.get(p.productId);
      return {
        ...p,
        translatedTitle:
          (cached ? effectiveProductName(cached, language) : undefined) ||
          p.translatedTitle,
      };
    })
    .filter((p) => Number.isFinite(gidToNumber(p.variantId)));
  if (products.length === 0) return null;

  if (options?.debug) {
    debugAdd(options.debug, "offer-names", {
      position: offer.position,
      language,
      products: products.map((p) => {
        const cached = catalogById.get(p.productId);
        return {
          productId: p.productId,
          briefName: p.translatedTitle ?? p.title,
          ...(cached
            ? { resolution: explainProductName(cached, language), baseTitle: cached.title }
            : { resolution: null, note: "product missing from catalog cache — engine title used as-is" }),
        };
      }),
    });
  }

  const mode: PromptKey =
    selection.displayMode === "bundle" && products.length > 1
      ? "bundle"
      : totalOffers > 1
        ? "sequential"
        : "single";

  const copyArgs: GenerateCopyArgs = {
    shop: ctx.shop,
    settings,
    mode,
    position: offer.position,
    totalOffers,
    language,
    basket,
    offerProducts: products,
    discountPct: offer.discountPct,
    currency: ctx.currency,
    copyLength: selection.copyLength,
    ...(options?.copyTimeoutMs ? { timeoutMs: options.copyTimeoutMs } : {}),
    ...(options?.debug ? { debug: options.debug } : {}),
  };

  let copy: OfferCopy;
  let discountSuggestion: number | null = null;
  let extendedPending = false;
  let coreCacheKey: string | undefined;
  // The working discount for EVERYTHING on this page — prompt, prices,
  // changes, title. INVARIANT: this pct always equals the pct the copy was
  // generated with; copy and charge can never disagree.
  let discountPct = offer.discountPct;

  if (Math.round(discountPct) <= 0) {
    // Legal config (fixed value 0): the AI prompts mandate mentioning the
    // discount, which would surface as "0% off" copy — use the deterministic
    // fallback (which omits discount phrasing entirely) and skip the AI call.
    copy = fallbackCopy(await groundedCopyArgs(copyArgs), strings);
    options?.diagnostics?.push({ position: offer.position, source: "no_discount_fallback" });
  } else {
    // AI-mode discount convergence: a suggestion stored by a PREVIOUS
    // generation (peeked at the baseline pct's cache key) switches the
    // working pct BEFORE any copy is produced, so the prompt, the cache key,
    // the views, the changes and the title all speak the same number. The
    // switched pct cache-misses at its new key and the copy regenerates AT
    // that pct (then caches, converging every later assembly). Suggestions
    // returned by the calls below are only PERSISTED (short copy via the
    // generateBuyerCopy cache write, long copy via completeExtendedCopy's
    // create) — never applied to a page whose copy said a different pct.
    if (settings.discount.mode === "ai") {
      const peeked = await peekDiscountSuggestion(copyArgs);
      if (peeked != null) {
        const clamped = clampDiscount(peeked, settings);
        if (clamped !== discountPct) {
          discountPct = clamped;
          copyArgs.discountPct = clamped;
        }
      }
    }

    if (options?.copyTimeoutMs) {
      // Admin preview (generous copyTimeoutMs): one-shot generation so the
      // preview always shows the REAL, complete AI copy — no background stage.
      try {
        const generated = await generateCopy(copyArgs);
        copy = generated.copy;
        discountSuggestion = generated.discountSuggestion;
        options?.diagnostics?.push({
          position: offer.position,
          source: generated.cached ? "cache" : generated.fallbackUsed ? "fallback" : "ai",
          reason: generated.reason,
        });
      } catch (error) {
        console.error(`[orchestrator] generateCopy failed for ${ctx.shop}`, error);
        copy = fallbackCopy(await groundedCopyArgs(copyArgs), strings);
        options?.diagnostics?.push({
          position: offer.position,
          source: "fallback",
          reason: "exception",
        });
      }
    } else {
      // Buyer path (hard ShouldRender time budget): fast CORE copy now; for
      // long copyLength the below-CTA sections (paragraphs/proof) complete in
      // the background and the extension polls /api/offer-extended for them.
      try {
        const generated = await generateBuyerCopy(copyArgs);
        copy = generated.copy;
        discountSuggestion = generated.discountSuggestion;
        extendedPending = generated.extendedPending;
        coreCacheKey = generated.cacheKey;
        options?.diagnostics?.push({
          position: offer.position,
          source: generated.cached ? "cache" : generated.fallbackUsed ? "fallback" : "ai",
          reason: generated.reason,
        });
      } catch (error) {
        console.error(`[orchestrator] generateBuyerCopy failed for ${ctx.shop}`, error);
        copy = fallbackCopy(await groundedCopyArgs(copyArgs), strings);
        options?.diagnostics?.push({
          position: offer.position,
          source: "fallback",
          reason: "exception",
        });
      }
    }
  }

  // Neutral (empty) title when there is no discount — never "0% off".
  const discountTitle =
    discountPct > 0
      ? fillTemplate(
          strings["discount_applied"] ?? DEFAULT_UI_STRINGS_EN["discount_applied"] ?? "{pct}% off",
          { pct: String(discountPct) },
        )
      : "";

  const changes: OfferChange[] = products.map((p) => {
    const change: OfferChange = {
      type: "add_variant",
      variantID: gidToNumber(p.variantId),
      quantity: 1,
    };
    if (discountPct > 0) {
      change.discount = { value: discountPct, valueType: "percentage", title: discountTitle };
    }
    return change;
  });

  const offerId = crypto.randomUUID();
  // Buyer-facing display prices, best first: real per-country contextual
  // prices when uniformly available, else the FX-rate conversion. The page
  // (with its final prices) is persisted in the meta below, so stored-page
  // reuse displays identically without re-deriving anything. Awaited here —
  // after the copy call above — so the pricing round-trip cost overlapped it.
  const ctxPricing = await ctxPricingPromise;
  const fx = ctxPricing ? null : displayFxFromContext(ctx);
  const page: OfferPage = {
    offerId,
    ruleId: offer.ruleId,
    candidateIds: offer.candidateIds,
    products: products.map((p) =>
      toProductView(p, discountPct, fx, ctxPricing?.byVariant.get(p.variantId) ?? null),
    ),
    discountPct,
    discountTitle,
    copy,
    changes,
    position: offer.position,
    // Only set when true — absent/false means the copy is complete.
    ...(extendedPending ? { extendedPending: true } : {}),
  };
  await persistIssuedOffer({
    ctx,
    offerId,
    changes,
    meta: {
      ruleId: offer.ruleId,
      candidateIds: offer.candidateIds,
      products: products.map(metaProduct),
      discountPct,
      language,
      country: ctx.countryCode,
      market: marketHandle,
      customerId: ctx.customerId,
      surface: ctx.surface,
      position: offer.position,
      currency: ctx.currency,
      // Display currency actually APPLIED to the stored page views (null =
      // views are shop-currency). Meta product prices above stay shop-currency
      // — these fields exist for reuse fidelity and diagnostics. Contextual
      // prices carry no rate (they are Shopify's own per-country amounts).
      presentmentCurrency: ctxPricing?.currency ?? fx?.currency ?? null,
      presentmentRate: fx?.rate ?? null,
      pricingSource: ctxPricing ? "contextual" : fx ? "fx" : "shop",
      displayMode: selection.displayMode,
      // Complete buyer-facing view — lets a Shop Pay re-fetch for the same
      // referenceId return the SAME pages instead of re-running the bandit.
      page,
    },
  });

  if (extendedPending) {
    // Only AFTER the row exists: complete the extended sections in the
    // background and patch the stored meta. Fire-and-forget — the buyer-
    // blocking request path must never wait on (or fail because of) this.
    void patchExtendedCopy({
      shop: ctx.shop,
      referenceId: ctx.referenceId,
      offerId,
      copyArgs,
      coreCopy: copy,
      coreDiscountSuggestion: discountSuggestion,
      coreCacheKey,
    }).catch((error) =>
      console.error(
        `[orchestrator] extended copy background task failed for ${ctx.shop}`,
        error,
      ),
    );
  }

  return page;
}

/**
 * Idempotent re-issue: return the already-issued post-purchase pages for this
 * (shop, referenceId) when live IssuedOffer rows carry a stored page view.
 * Shop Pay's Render app re-fetches /api/offer without extension storage —
 * re-running the bandit there could pick DIFFERENT candidates (impressions
 * credited to A, accepts to B) and regenerate copy. Returns null when nothing
 * reusable exists (then normal selection runs); never throws.
 */
async function findStoredOfferResponse(ctx: PurchaseContext): Promise<OfferResponse | null> {
  try {
    const rows = await prisma.issuedOffer.findMany({
      where: {
        shop: ctx.shop,
        referenceId: ctx.referenceId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) return null;

    const pages: OfferPage[] = [];
    let language = "en";
    let displayMode: DisplayMode | null = null;
    let presentmentCurrency: string | null = null;
    for (const row of rows) {
      const meta = jparse<any>(row.offerMetaJson, null);
      if (!meta || meta.surface !== "post_purchase") continue;
      const page = meta.page;
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.products) ||
        !Array.isArray(page.changes)
      ) {
        continue;
      }
      pages.push(page as OfferPage);
      if (typeof meta.language === "string" && meta.language) language = meta.language;
      if (meta.displayMode === "sequential" || meta.displayMode === "bundle") {
        displayMode = meta.displayMode;
      }
      // Present only when a display conversion was applied to the stored page
      // views at issue time — the reused response must be labeled with the
      // SAME currency those stored prices are denominated in.
      if (typeof meta.presentmentCurrency === "string" && meta.presentmentCurrency) {
        presentmentCurrency = meta.presentmentCurrency;
      }
    }
    if (pages.length === 0) return null;
    pages.sort((a, b) => a.position - b.position);

    let settings: AppSettings | null = null;
    try {
      settings = await getSettings(ctx.shop);
    } catch (error) {
      console.error(`[orchestrator] getSettings failed on re-issue for ${ctx.shop}`, error);
    }
    const strings = await safeGetUiStrings(ctx.shop, language);
    return {
      offers: pages,
      displayMode: displayMode ?? settings?.defaultDisplayMode ?? "sequential",
      // Stored views keep the prices they were issued with — label them with
      // the stored display currency, never the (possibly different) live one.
      currency: presentmentCurrency ?? ctx.currency,
      language,
      strings,
      ui: {
        showCountdown: settings?.countdown?.enabled ?? false,
        countdownMinutes: settings?.countdown?.minutes ?? 10,
        copyLength: settings?.copyLength ?? "short",
        showComparePrice: settings?.showComparePrice ?? true,
      },
    };
  } catch (error) {
    console.error(`[orchestrator] stored-offer lookup failed for ${ctx.shop}`, error);
    return null;
  }
}

export async function assembleOfferResponse(
  ctx: PurchaseContext,
  options?: AssembleOfferOptions,
): Promise<OfferResponse> {
  options = options ?? {};
  // Idempotency first: a re-fetch for a referenceId we already issued offers
  // for returns the stored pages — no new selection, no new rows.
  const stored = await findStoredOfferResponse(ctx);
  if (stored) {
    for (const page of stored.offers) {
      options?.diagnostics?.push({ position: page.position, source: "reused" });
    }
    if (options.debug) {
      debugAdd(options.debug, "stored-reuse", {
        note: "live IssuedOffer rows for this referenceId already carry pages — returned verbatim, no selection/copy/pricing ran",
        pages: stored.offers.map((p) => p.position),
        language: stored.language,
        currency: stored.currency,
      });
      finalizeDebug({
        trace: options.debug,
        ctx,
        language: stored.language,
        catalogById: new Map(),
        response: stored,
        options,
        marketHandle: null,
      });
    }
    return stored;
  }

  let settings: AppSettings | null = null;
  let selection: SelectionResult | null = null;
  let language = "en";
  let strings: Record<string, string> = { ...DEFAULT_UI_STRINGS_EN };
  let marketHandle: string | null = null;

  try {
    settings = await getSettings(ctx.shop);
    // Live-request self-instrumentation: when the Debug tab's "record live
    // buyer requests" toggle is on and the caller passed no trace (the buyer
    // routes never do), create one here. Purely additive — the buyer path
    // only ever appends to it in memory; the single DB write is
    // fire-and-forget at the end.
    if (!options.debug && settings.debugLiveRequests) {
      options.debug = createDebugTrace();
    }
    debugAdd(options.debug, "context", {
      shop: ctx.shop,
      referenceId: ctx.referenceId,
      surface: ctx.surface,
      countryCode: ctx.countryCode,
      locale: ctx.locale,
      currency: ctx.currency,
      totalAmount: ctx.totalAmount,
      presentmentCurrency: ctx.presentmentCurrency ?? null,
      presentmentRate: ctx.presentmentRate ?? null,
      lineItems: ctx.lineItems.map((li) => ({
        productId: li.productId,
        variantId: li.variantId,
        quantity: li.quantity,
        title: li.title ?? null,
      })),
    });
    debugAdd(options.debug, "settings", {
      defaultLanguage: settings.defaultLanguage,
      languages: settings.languages,
      aiEnabled: settings.aiEnabled,
      aiModel: settings.aiModel,
      coreCopyModel: settings.coreCopyModel,
      copyLength: settings.copyLength,
      discountMode: settings.discount.mode,
      brandContextLength: (settings.brandContext ?? "").length,
    });
    const market = await findMarketForCountry(ctx.shop, ctx.countryCode);
    marketHandle = market?.marketHandle ?? null;
    if (options.debug && ctx.countryCode) {
      // ALL market rows matching this country — more than one match means
      // duplicate/stale MarketSetting rows, where "first match wins" is
      // effectively arbitrary (unordered findMany).
      try {
        const rows = await prisma.marketSetting.findMany({ where: { shop: ctx.shop } });
        const cc = ctx.countryCode.trim().toUpperCase();
        debugAdd(options.debug, "market-resolution", {
          country: cc,
          chosen: marketHandle,
          matches: rows
            .filter((m) =>
              jparse<string[]>(m.countriesJson, []).some(
                (c) => String(c).trim().toUpperCase() === cc,
              ),
            )
            .map((m) => ({
              handle: m.marketHandle,
              name: m.name,
              enabled: m.enabled,
              currency: m.currency,
              discountOverride: m.discountOverride,
              languageOverride: m.languageOverride,
              maxOffersOverride: m.maxOffersOverride,
              previewFxRate: m.previewFxRate,
            })),
        });
      } catch {
        // diagnostics only
      }
    }
    const resolved = resolveLanguageWithSource(
      ctx.locale,
      settings,
      market?.languageOverride ?? null,
    );
    language = resolved.language;
    if (options) options.languageResolution = resolved;
    debugAdd(options.debug, "language-resolution", {
      requestedLocale: ctx.locale ?? null,
      resolvedLanguage: resolved.language,
      source: resolved.source,
      marketLanguageOverride: market?.languageOverride ?? null,
      enabledLanguages: settings.languages,
      defaultLanguage: settings.defaultLanguage,
    });
    strings = await safeGetUiStrings(ctx.shop, language);
    try {
      selection = await selectOffers(ctx, settings);
      debugAdd(options.debug, "selection", {
        matchedRuleId: selection.matchedRuleId,
        displayMode: selection.displayMode,
        copyLength: selection.copyLength,
        offers: selection.offers.map((o) => ({
          position: o.position,
          discountPct: o.discountPct,
          products: o.products.map((p) => ({
            productId: p.productId,
            variantId: p.variantId,
            engineTitle: p.title,
            price: p.price,
          })),
        })),
      });
    } catch (error) {
      console.error(`[orchestrator] selectOffers failed for ${ctx.shop}`, error);
      selection = null;
    }
  } catch (error) {
    debugAdd(options.debug, "setup-error", {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[orchestrator] assembleOfferResponse setup failed for ${ctx.shop}`, error);
  }

  const displayMode: DisplayMode =
    selection?.displayMode ?? settings?.defaultDisplayMode ?? "sequential";
  const copyLength: CopyLength = selection?.copyLength ?? settings?.copyLength ?? "short";

  // Buyer-facing display pricing, best first: real per-country prices from
  // Shopify contextualPricing (market price adjustments and price lists
  // included) for ALL offered variants, else the FX-rate conversion implied
  // by the order (see toProductView), else plain shop currency. Only variants
  // that survive buildOfferPage's signability filter participate in the
  // all-or-nothing check — an unsignable product never blocks real pricing.
  // Kicked off NOW and awaited inside buildOfferPage AFTER the (much slower)
  // copy call, so the Shopify round-trip overlaps copy generation and the
  // buyer path's ShouldRender budget pays ~nothing for it.
  const offeredVariantIds = (selection?.offers ?? [])
    .flatMap((o) => o.products.map((p) => p.variantId))
    .filter((v) => Number.isFinite(gidToNumber(v)));
  const ctxPricingPromise = resolveContextualPricing(ctx, offeredVariantIds, options.debug);
  const response: OfferResponse = {
    offers: [],
    displayMode,
    // Provisional — finalized below once the pricing promise resolves.
    currency: ctx.currency,
    language,
    strings,
    ui: {
      showCountdown: settings?.countdown?.enabled ?? false,
      countdownMinutes: settings?.countdown?.minutes ?? 10,
      copyLength,
      showComparePrice: settings?.showComparePrice ?? true,
    },
  };

  if (!settings || !selection || selection.offers.length === 0) {
    const fx = displayFxFromContext(ctx);
    response.currency = fx?.currency ?? ctx.currency;
    debugAdd(options.debug, "empty-result", {
      reason: !settings
        ? "settings unavailable"
        : !selection
          ? "selection failed"
          : "engine returned no offers (kill switch, market gating, or no eligible candidates — see the [engine] server logs)",
    });
    finalizeDebug({
      trace: options.debug,
      ctx,
      language,
      catalogById: new Map(),
      response,
      options,
      marketHandle,
    });
    return response;
  }

  const catalogById = await loadCatalog(ctx, selection);
  if (options.debug) {
    // Snapshot of every catalog row involved (basket + offers): staleness
    // (cacheRowUpdatedAt), the base title/description ACTUALLY in the cache,
    // which languages have T&A entries / manual names, and how the name
    // resolves for the buyer language. A German descriptionFullSnippet on an
    // English page is visible right here.
    let updatedAtById = new Map<string, Date>();
    try {
      const metaRows = await prisma.productCache.findMany({
        where: { shop: ctx.shop, productId: { in: [...catalogById.keys()] } },
        select: { productId: true, updatedAt: true },
      });
      updatedAtById = new Map(metaRows.map((r) => [r.productId, r.updatedAt]));
    } catch {
      // diagnostics only
    }
    debugAdd(options.debug, "catalog-products", {
      language,
      products: [...catalogById.values()].map((p) => ({
        productId: p.productId,
        baseTitle: p.title,
        status: p.status,
        cacheRowUpdatedAt: updatedAtById.get(p.productId)?.toISOString() ?? null,
        aiContextLength: p.aiDescription.trim().length,
        aiContextSnippet: p.aiDescription.trim() ? debugText(p.aiDescription, 400) : null,
        descriptionFullLength: p.descriptionFull.length,
        descriptionFullSnippet: debugText(p.descriptionFull, 400),
        translationLanguages: Object.keys(p.translations),
        nameOverrides: p.nameOverrides,
        nameForThisLanguage: explainProductName(p, language),
      })),
    });
  }
  const basket = buildBasket(ctx, catalogById, language);
  if (options.debug) {
    debugAdd(options.debug, "basket-grounding", {
      language,
      lines: ctx.lineItems.map((line) => {
        const cached = catalogById.get(line.productId);
        if (!cached) {
          return {
            productId: line.productId,
            cached: false,
            titleUsed: line.title ?? null,
            note: "not in catalog cache — order-line title used",
          };
        }
        const name = explainProductName(cached, language);
        const hasAi = Boolean(cached.aiDescription.trim());
        const translated = hasAi
          ? undefined
          : explainTranslatedDescription(cached.translations, language);
        const text = hasAi
          ? cached.aiDescription
          : translated?.value ?? effectiveDescription(cached);
        return {
          productId: line.productId,
          quantity: line.quantity,
          titleUsed: name.value,
          titleResolution: name,
          descriptionSource: hasAi
            ? "ai_context"
            : translated
              ? `translation:${translated.matchedKey}`
              : cached.descriptionFull.trim()
                ? "description_full"
                : cached.descriptionShort.trim()
                  ? "description_short"
                  : "missing",
          descriptionSnippet: debugText(text, 400),
        };
      }),
    });
  }
  const totalOffers = selection.offers.length;

  for (const offer of selection.offers) {
    try {
      const page = await buildOfferPage({
        ctx,
        settings,
        selection,
        offer,
        totalOffers,
        language,
        strings,
        basket,
        catalogById,
        marketHandle,
        ctxPricingPromise,
        options,
      });
      if (page) response.offers.push(page);
    } catch (error) {
      console.error(
        `[orchestrator] failed to build offer page ${offer.position} for ${ctx.shop}`,
        error,
      );
    }
  }

  // Already resolved — the page loop above awaited it (or the selection was
  // empty and it resolved to null without any Shopify call).
  const ctxPricing = await ctxPricingPromise;
  const fx = ctxPricing ? null : displayFxFromContext(ctx);
  if (options) options.pricingSource = ctxPricing ? "contextual" : fx ? "fx" : "shop";
  response.currency = ctxPricing?.currency ?? fx?.currency ?? ctx.currency;
  debugAdd(options.debug, "display-pricing", {
    pricingSource: options.pricingSource,
    responseCurrency: response.currency,
    ...(fx ? { fxCurrency: fx.currency, fxRate: fx.rate } : {}),
    ...(ctxPricing ? { contextualCurrency: ctxPricing.currency } : {}),
    note:
      options.pricingSource === "contextual"
        ? "real per-country Shopify prices — the FX rate was NOT applied"
        : options.pricingSource === "fx"
          ? "shop-currency prices multiplied by the presentment rate (preview: the market's previewFxRate, default 1 — amounts are NOT converted when the rate is 1)"
          : "plain shop-currency prices",
  });

  finalizeDebug({
    trace: options.debug,
    ctx,
    language,
    catalogById,
    response,
    options,
    marketHandle,
  });
  return response;
}

/**
 * Close out a debug trace: run the foreign-name alias scan over every captured
 * prompt/output text block, append the summary, and persist to DebugEvent
 * (fire-and-forget). The scan is the root-cause hunter for wrong-language
 * product names: every known name of every involved product (base title, T&A
 * titles, manual overrides — all languages) is searched in every block, and
 * any occurrence that is not the buyer-language name is reported with its
 * exact location (brand_context, page1:offer_summary, page1:model_output, …).
 * Never throws.
 */
function finalizeDebug(args: {
  trace: DebugTrace | undefined;
  ctx: PurchaseContext;
  language: string;
  catalogById: Map<string, CatalogProduct>;
  response: OfferResponse;
  options?: AssembleOfferOptions;
  marketHandle: string | null;
}): void {
  const { trace, ctx, language, catalogById, response, options, marketHandle } = args;
  if (!trace) return;
  try {
    const blocks: Record<string, string> = {};
    for (const entry of trace.entries) {
      const d = entry.data as Record<string, unknown>;
      if (!d || typeof d !== "object") continue;
      const position = typeof d.position === "number" ? d.position : "?";
      if (entry.stage === "prompt-blocks") {
        blocks[`page${position}:basket_summary`] = String(d.basket_summary ?? "");
        blocks[`page${position}:offer_summary`] = String(d.offer_summary ?? "");
        blocks["brand_context"] = String(d.brand_context ?? "");
        blocks["tone"] = String(d.tone ?? "");
      } else if (entry.stage === "claude-request") {
        blocks[`page${position}:system_prompt`] = String(d.systemPrompt ?? "");
        blocks[`page${position}:user_prompt`] = String(d.userPrompt ?? "");
      } else if (entry.stage === "claude-response") {
        blocks[`page${position}:model_output`] = String(d.raw ?? "");
      }
    }
    const hits = scanForForeignNames(
      [...catalogById.values()].map((p) => ({
        product: p,
        expectedName: effectiveProductName(p, language),
      })),
      blocks,
      language,
    );
    debugAdd(trace, "alias-scan", {
      note: "product names in OTHER languages found inside the prompts or the model output — each hit is a wrong-language name with its exact location. A hit in *_summary/system_prompt means bad INPUT data reached the prompt; a hit ONLY in model_output means the model produced it despite clean input.",
      buyerLanguage: language,
      scannedBlocks: Object.keys(blocks),
      hits,
    });
    const summary = {
      language,
      languageSource: options?.languageResolution?.source ?? null,
      market: marketHandle,
      country: ctx.countryCode ?? null,
      offers: response.offers.length,
      currency: response.currency,
      pricingSource: options?.pricingSource ?? null,
      copySources: (options?.diagnostics ?? []).map((d) => `p${d.position}:${d.source}`),
      aliasHits: hits.length,
      tookMs: Date.now() - trace.startedAt,
    };
    debugAdd(trace, "summary", summary);
    void persistDebugTrace({
      shop: ctx.shop,
      referenceId: ctx.referenceId,
      surface: ctx.surface ?? "post_purchase",
      trace,
      summary,
    });
  } catch (error) {
    console.error(`[orchestrator] debug finalize failed for ${ctx.shop}`, error);
  }
}

// ── Thank-you-page offer assembly ────────────────────────────────────────────

const DISCOUNT_CODE_BASIC_CREATE = `#graphql
  mutation cellexiaThankYouDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** How long a thank-you discount code stays redeemable after minting. */
const THANK_YOU_CODE_TTL_MS = 48 * 60 * 60 * 1000;

/** Create a one-time discount code for the thank-you offer. Best-effort. */
async function createThankYouDiscount(
  graphql: AdminGraphql,
  shop: string,
  code: string,
  discountPct: number,
  productId: string,
  endsAt: string,
): Promise<boolean> {
  try {
    const response = await graphql(DISCOUNT_CODE_BASIC_CREATE, {
      variables: {
        basicCodeDiscount: {
          title: `Cellexia thank-you offer ${code}`,
          code,
          startsAt: new Date().toISOString(),
          endsAt,
          usageLimit: 1,
          appliesOncePerCustomer: true,
          customerSelection: { all: true },
          customerGets: {
            value: { percentage: discountPct / 100 },
            items: { products: { productsToAdd: [productId] } },
          },
        },
      },
    });
    const body: any = await response.json();
    const result = body?.data?.discountCodeBasicCreate;
    const userErrors: any[] = Array.isArray(result?.userErrors) ? result.userErrors : [];
    if (result?.codeDiscountNode?.id && userErrors.length === 0) return true;
    console.error(`[orchestrator] discountCodeBasicCreate errors for ${shop}`, userErrors);
    return false;
  } catch (error) {
    console.error(`[orchestrator] discountCodeBasicCreate failed for ${shop}`, error);
    return false;
  }
}

/** Max thank-you offers (each may mint a discount code) per shop per hour. */
const THANK_YOU_HOURLY_CAP = 20;

/**
 * Rebuild a previously issued thank-you offer from its stored meta so a page
 * refresh (or a replayed request) returns the SAME offer instead of minting a
 * fresh discount code. When the stored code's `discountEndsAt` has passed,
 * the rebuilt offer degrades exactly like a failed mint — full price, no
 * code, plain product URL, deterministic pct-0 copy — never a promise of a
 * discount the buyer can no longer redeem. Returns null when the stored meta
 * predates the `productView`/`copy`/`checkoutUrl` fields needed for
 * reconstruction.
 */
async function rebuildStoredThankYouOffer(
  ctx: PurchaseContext,
  row: { offerId: string; referenceId: string },
  meta: any,
  settings: AppSettings,
): Promise<ThankYouOffer | null> {
  const view = meta?.productView;
  const copy = meta?.copy;
  if (
    !view ||
    typeof view.price !== "string" ||
    typeof view.discountedPrice !== "string" ||
    !copy ||
    typeof copy.headline !== "string" ||
    typeof copy.body !== "string"
  ) {
    return null;
  }
  const language = typeof meta?.language === "string" && meta.language ? meta.language : "en";
  const strings = await safeGetUiStrings(ctx.shop, language);
  const discountPct = Number(meta?.discountPct);
  const discountCode = typeof meta?.discountCode === "string" ? meta.discountCode : "";
  const checkoutUrl = typeof meta?.checkoutUrl === "string" ? meta.checkoutUrl : "";
  // Display currency of the STORED view: when the offer was minted with a
  // presentment conversion, the productView prices are already converted —
  // the rebuilt offer must be labeled with that same currency. Shop currency
  // (meta.currency) otherwise; rows predating either field use ctx.currency.
  const currency =
    typeof meta?.presentmentCurrency === "string" && meta.presentmentCurrency
      ? meta.presentmentCurrency
      : typeof meta?.currency === "string" && meta.currency
        ? meta.currency
        : ctx.currency;

  // Expired discount code: rows minted before `discountEndsAt` existed have
  // no expiry stored and round-trip as before; an unparseable date never
  // triggers the degrade (NaN comparisons are false).
  const endsAtMs =
    discountCode && typeof meta?.discountEndsAt === "string"
      ? Date.parse(meta.discountEndsAt)
      : Number.NaN;
  if (Number.isFinite(endsAtMs) && endsAtMs <= Date.now()) {
    const priceNum = Number(view.price);
    const fullPriceProduct: SelectedOfferProduct = {
      productId: typeof view.productId === "string" ? view.productId : "",
      variantId: typeof view.variantId === "string" ? view.variantId : "",
      title: typeof view.title === "string" ? view.title : "",
      image: typeof view.image === "string" ? view.image : null,
      price: Number.isFinite(priceNum) ? priceNum : 0,
      compareAtPrice: null,
      unitCost: null,
      productType: "",
      tags: [],
    };
    const copyArgs: GenerateCopyArgs = {
      shop: ctx.shop,
      settings,
      mode: "single",
      position: 1,
      totalOffers: 1,
      language,
      basket: [],
      offerProducts: [fullPriceProduct],
      discountPct: 0,
      currency,
      copyLength: "short",
    };
    return {
      offerId: row.offerId,
      referenceId: row.referenceId,
      product: { ...(view as OfferProductView), discountedPrice: view.price },
      discountPct: 0,
      discountCode: "",
      // Strip the ?discount=CODE query — the plain product/cart URL remains.
      checkoutUrl: checkoutUrl.split("?")[0],
      // discountPct is 0 here — deterministic fallback copy cannot promise a
      // discount the way the stored AI copy does.
      copy: fallbackCopy(copyArgs, strings),
      strings,
      language,
      currency,
    };
  }
  // Optional copy fields round-trip verbatim: a rebuilt offer must render
  // exactly like the original, so stored paragraphs/closer are never stripped.
  const rebuiltCopy: OfferCopy = {
    headline: copy.headline,
    body: copy.body,
    bullets: Array.isArray(copy.bullets)
      ? copy.bullets.filter((b: unknown): b is string => typeof b === "string")
      : [],
  };
  if (Array.isArray(copy.paragraphs)) {
    rebuiltCopy.paragraphs = copy.paragraphs.filter(
      (p: unknown): p is string => typeof p === "string",
    );
  }
  if (typeof copy.closer === "string" && copy.closer) {
    rebuiltCopy.closer = copy.closer;
  }
  return {
    offerId: row.offerId,
    referenceId: row.referenceId,
    product: view as OfferProductView,
    discountPct: Number.isFinite(discountPct) ? discountPct : 0,
    discountCode,
    checkoutUrl,
    copy: rebuiltCopy,
    strings,
    language,
    currency,
  };
}

export async function assembleThankYouOffer(
  ctx: PurchaseContext,
  graphql: AdminGraphql | null,
): Promise<ThankYouOffer | null> {
  try {
    const settings = await getSettings(ctx.shop);
    if (settings.thankYouEnabled === false) return null;

    // Idempotency: at most one discount code per order. If a live thank-you
    // offer already exists for this order's numeric reference, return it
    // verbatim — never mint a second code for the same order. Thank-you rows
    // always carry a "typ:" reference prefix; the exact trailing-numeric
    // match below tolerates gid-vs-numeric storage of the order id.
    const numericRef = gidToNumber(ctx.referenceId);
    if (Number.isFinite(numericRef)) {
      // The deterministic (referenceId, "typ-<n>") slot is owned by whichever
      // row was inserted first — even after it EXPIRES. Without this
      // no-expiry-filter lookup, a thank-you revisit >2h later would mint a
      // real discount code, then collide (P2002) on insert and orphan the new
      // code, while also bypassing the hourly cap. Check the slot owner
      // BEFORE the cap and BEFORE any code creation; extend its expiry so
      // /api/events keeps matching the row.
      const slotOfferId = `typ-${numericRef}`;
      const slotRow = await prisma.issuedOffer.findUnique({
        where: {
          referenceId_offerId: { referenceId: ctx.referenceId, offerId: slotOfferId },
        },
      });
      if (slotRow) {
        if (slotRow.shop !== ctx.shop) {
          console.warn(
            `[orchestrator] thank-you slot ${slotOfferId} for ${ctx.referenceId} belongs to another shop — refusing to mint a code for ${ctx.shop}`,
          );
          return null;
        }
        const slotMeta = jparse<any>(slotRow.offerMetaJson, null);
        const rebuilt = slotMeta
          ? await rebuildStoredThankYouOffer(ctx, slotRow, slotMeta, settings)
          : null;
        if (!rebuilt) {
          console.warn(
            `[orchestrator] existing thank-you offer ${slotRow.offerId} for ${ctx.shop} cannot be rebuilt — refusing to mint another code`,
          );
          return null;
        }
        await prisma.issuedOffer.update({
          where: {
            referenceId_offerId: { referenceId: ctx.referenceId, offerId: slotOfferId },
          },
          data: { expiresAt: new Date(Date.now() + OFFER_TTL_MS) },
        });
        return rebuilt;
      }
    }
    if (Number.isFinite(numericRef)) {
      const liveRows = await prisma.issuedOffer.findMany({
        where: {
          shop: ctx.shop,
          referenceId: { startsWith: "typ:" },
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      for (const row of liveRows) {
        if (gidToNumber(row.referenceId) !== numericRef) continue;
        const meta = jparse<any>(row.offerMetaJson, null);
        if (!meta || meta.surface !== "thank_you") continue;
        const rebuilt = await rebuildStoredThankYouOffer(ctx, row, meta, settings);
        if (!rebuilt) {
          console.warn(
            `[orchestrator] existing thank-you offer ${row.offerId} for ${ctx.shop} cannot be rebuilt — refusing to mint another code`,
          );
        }
        return rebuilt;
      }
    }

    // Abuse bound: cap thank-you offer creation per shop per hour. Thank-you
    // rows are identified by their "typ:" reference prefix (offerMetaJson is
    // an opaque JSON string and cannot be filtered in SQL).
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await prisma.issuedOffer.count({
      where: {
        shop: ctx.shop,
        referenceId: { startsWith: "typ:" },
        createdAt: { gte: hourAgo },
      },
    });
    if (recentCount > THANK_YOU_HOURLY_CAP) {
      console.warn(
        `[orchestrator] thank-you offer cap reached for ${ctx.shop} (${recentCount} in the past hour)`,
      );
      return null;
    }

    const selection = await selectOffers(ctx, settings);
    const offer = selection.offers[0];
    const product = offer?.products?.[0];
    if (!offer || !product) return null;
    const variantNumericId = gidToNumber(product.variantId);
    if (!Number.isFinite(variantNumericId)) return null;

    const market = await findMarketForCountry(ctx.shop, ctx.countryCode);
    const language = resolveLanguage(ctx.locale, settings, market?.languageOverride ?? null);
    const strings = await safeGetUiStrings(ctx.shop, language);
    const catalogById = await loadCatalog(ctx, selection);
    const basket = buildBasket(ctx, catalogById, language);

    const cachedOffer = catalogById.get(product.productId);
    const enriched: SelectedOfferProduct = {
      ...product,
      // Buyer-facing name: merchant nameOverrides → T&A → base title.
      translatedTitle:
        (cachedOffer ? effectiveProductName(cachedOffer, language) : undefined) ||
        product.translatedTitle,
    };

    // Plain product URL used when no discount code could be created.
    const handle = cachedOffer?.handle ?? "";
    const productUrl = handle
      ? `https://${ctx.shop}/products/${handle}`
      : `https://${ctx.shop}/cart/${variantNumericId}:1`;

    // Create the discount code FIRST so the copy below is generated with the
    // final, redeemable percentage — never a discount the buyer cannot use.
    let discountPct = offer.discountPct;
    let discountCode = "";
    let checkoutUrl = productUrl;
    // ISO expiry of the minted code — persisted in the meta so a slot reuse
    // after the code lapses degrades to full price instead of promising a
    // discount the buyer can no longer redeem.
    let discountEndsAt: string | null = null;
    if (graphql && discountPct > 0) {
      const code = `THANKYOU-${randomCode(6)}`;
      const endsAt = new Date(Date.now() + THANK_YOU_CODE_TTL_MS).toISOString();
      const created = await createThankYouDiscount(
        graphql,
        ctx.shop,
        code,
        discountPct,
        product.productId,
        endsAt,
      );
      if (created) {
        discountCode = code;
        discountEndsAt = endsAt;
        checkoutUrl = `https://${ctx.shop}/cart/${variantNumericId}:1?discount=${encodeURIComponent(code)}`;
      }
    }
    // Graceful degradation: without a working code we must not promise a
    // discount the buyer cannot redeem — show the offer at full price.
    if (!discountCode) discountPct = 0;

    const copyArgs: GenerateCopyArgs = {
      shop: ctx.shop,
      settings,
      mode: "single",
      position: 1,
      totalOffers: 1,
      language,
      basket,
      offerProducts: [enriched],
      discountPct,
      currency: ctx.currency,
      // The thank-you card is a small block on an already-busy page — always
      // short copy, never the extended paragraphs section long copy carries.
      copyLength: "short",
    };

    let copy: OfferCopy;
    if (discountCode) {
      try {
        copy = (await generateCopy(copyArgs)).copy;
      } catch (error) {
        console.error(`[orchestrator] thank-you generateCopy failed for ${ctx.shop}`, error);
        copy = fallbackCopy(copyArgs, strings);
      }
    } else {
      // discountPct is 0 here — deterministic fallback copy cannot promise a
      // discount the way AI copy might.
      copy = fallbackCopy(copyArgs, strings);
    }

    // Deterministic offerId per order: combined with the IssuedOffer
    // @@unique([referenceId, offerId]) constraint this makes minting
    // race-proof — concurrent requests for the same order collide on the
    // insert and the losers return the winner's stored offer instead of
    // minting additional discount codes.
    const offerId = Number.isFinite(numericRef)
      ? `typ-${numericRef}`
      : crypto.randomUUID();
    // Buyer-facing display price for the stored view, best first: the real
    // per-country contextual price, else the FX-rate conversion. The discount
    // code percentage and all meta prices stay shop-currency.
    const ctxPricing = await resolveContextualPricing(ctx, [enriched.variantId]);
    const fx = ctxPricing ? null : displayFxFromContext(ctx);
    const productView = toProductView(
      enriched,
      discountPct,
      fx,
      ctxPricing?.byVariant.get(enriched.variantId) ?? null,
    );
    try {
      await persistIssuedOffer({
        ctx,
        offerId,
        changes: [],
        meta: {
          ruleId: offer.ruleId,
          candidateIds: offer.candidateIds,
          products: [metaProduct(enriched)],
          discountPct,
          discountCode,
          discountEndsAt,
          checkoutUrl,
          productView,
          copy,
          language,
          country: ctx.countryCode,
          market: market?.marketHandle ?? null,
          customerId: ctx.customerId,
          surface: ctx.surface,
          position: 1,
          currency: ctx.currency,
          // Display currency actually APPLIED to the stored productView
          // (null = view is shop-currency) — rebuilds label prices with it.
          presentmentCurrency: ctxPricing?.currency ?? fx?.currency ?? null,
          presentmentRate: fx?.rate ?? null,
          pricingSource: ctxPricing ? "contextual" : fx ? "fx" : "shop",
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Lost the race — another request already issued this order's offer.
        const winner = await prisma.issuedOffer.findUnique({
          where: { referenceId_offerId: { referenceId: ctx.referenceId, offerId } },
        });
        if (winner && winner.shop === ctx.shop) {
          const winnerMeta = jparse<any>(winner.offerMetaJson, null);
          if (winnerMeta) {
            const rebuilt = await rebuildStoredThankYouOffer(ctx, winner, winnerMeta, settings);
            if (rebuilt) {
              if (discountCode) {
                console.warn(
                  `[orchestrator] raced thank-you mint for ${ctx.shop} ${ctx.referenceId} — orphan code ${discountCode} superseded by ${rebuilt.discountCode || "(none)"}`,
                );
              }
              return rebuilt;
            }
          }
        }
        return null;
      }
      throw error;
    }

    return {
      offerId,
      referenceId: ctx.referenceId,
      product: productView,
      discountPct,
      discountCode,
      checkoutUrl,
      copy,
      strings,
      language,
      currency: ctxPricing?.currency ?? fx?.currency ?? ctx.currency,
    };
  } catch (error) {
    console.error(`[orchestrator] assembleThankYouOffer failed for ${ctx.shop}`, error);
    return null;
  }
}
