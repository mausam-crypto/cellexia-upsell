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
  getProductsByIds,
  type CatalogProduct,
} from "./catalog.server";

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

/** Best-effort translated title lookup from the catalog translations map. */
function translationTitle(
  translations: Record<string, { title?: string }> | undefined,
  language: string,
): string | undefined {
  if (!translations) return undefined;
  const direct = translations[language]?.title;
  if (direct) return direct;
  const lower = language.toLowerCase();
  for (const [key, value] of Object.entries(translations)) {
    if (key.toLowerCase() === lower && value?.title) return value.title;
  }
  const base = lower.split("-")[0];
  for (const [key, value] of Object.entries(translations)) {
    if (key.toLowerCase().split("-")[0] === base && value?.title) return value.title;
  }
  return undefined;
}

/** Best-effort translated description lookup from the catalog translations map. */
function translationDescription(
  translations: Record<string, { title?: string; description?: string }> | undefined,
  language: string,
): string | undefined {
  if (!translations) return undefined;
  const direct = translations[language]?.description;
  if (direct) return direct;
  const lower = language.toLowerCase();
  for (const [key, value] of Object.entries(translations)) {
    if (key.toLowerCase() === lower && value?.description) return value.description;
  }
  const base = lower.split("-")[0];
  for (const [key, value] of Object.entries(translations)) {
    if (key.toLowerCase().split("-")[0] === base && value?.description) {
      return value.description;
    }
  }
  return undefined;
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
      // Exact Translate & Adapt name for the buyer's language, so prompts
      // reference products by the names the customer actually shopped.
      title:
        (cached ? translationTitle(cached.translations, language) : undefined) ??
        cached?.title ??
        line.title ??
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

function toProductView(p: SelectedOfferProduct, discountPct: number): OfferProductView {
  const discounted = Math.round(p.price * (1 - discountPct / 100) * 100) / 100;
  return {
    productId: p.productId,
    variantId: p.variantId,
    title: p.translatedTitle ?? p.title,
    image: p.image,
    price: p.price.toFixed(2),
    discountedPrice: discounted.toFixed(2),
    compareAtPrice: p.compareAtPrice != null ? p.compareAtPrice.toFixed(2) : null,
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
}): Promise<void> {
  try {
    const extended = await completeExtendedCopy(
      args.copyArgs,
      args.coreCopy,
      args.coreDiscountSuggestion,
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
    options,
  } = args;

  // Attach translated titles and drop any product whose variant id cannot be
  // converted to the numeric changeset format (it could never be signed).
  const products: SelectedOfferProduct[] = offer.products
    .map((p) => ({
      ...p,
      translatedTitle:
        translationTitle(catalogById.get(p.productId)?.translations, language) ??
        p.translatedTitle,
    }))
    .filter((p) => Number.isFinite(gidToNumber(p.variantId)));
  if (products.length === 0) return null;

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
  };

  let copy: OfferCopy;
  let discountSuggestion: number | null = null;
  let extendedPending = false;
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
  const page: OfferPage = {
    offerId,
    ruleId: offer.ruleId,
    candidateIds: offer.candidateIds,
    products: products.map((p) => toProductView(p, discountPct)),
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
      currency: ctx.currency,
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
  // Idempotency first: a re-fetch for a referenceId we already issued offers
  // for returns the stored pages — no new selection, no new rows.
  const stored = await findStoredOfferResponse(ctx);
  if (stored) {
    for (const page of stored.offers) {
      options?.diagnostics?.push({ position: page.position, source: "reused" });
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
    const market = await findMarketForCountry(ctx.shop, ctx.countryCode);
    marketHandle = market?.marketHandle ?? null;
    const resolved = resolveLanguageWithSource(
      ctx.locale,
      settings,
      market?.languageOverride ?? null,
    );
    language = resolved.language;
    if (options) options.languageResolution = resolved;
    strings = await safeGetUiStrings(ctx.shop, language);
    try {
      selection = await selectOffers(ctx, settings);
    } catch (error) {
      console.error(`[orchestrator] selectOffers failed for ${ctx.shop}`, error);
      selection = null;
    }
  } catch (error) {
    console.error(`[orchestrator] assembleOfferResponse setup failed for ${ctx.shop}`, error);
  }

  const displayMode: DisplayMode =
    selection?.displayMode ?? settings?.defaultDisplayMode ?? "sequential";
  const copyLength: CopyLength = selection?.copyLength ?? settings?.copyLength ?? "short";

  const response: OfferResponse = {
    offers: [],
    displayMode,
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

  if (!settings || !selection || selection.offers.length === 0) return response;

  const catalogById = await loadCatalog(ctx, selection);
  const basket = buildBasket(ctx, catalogById, language);
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

  return response;
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
  const currency =
    typeof meta?.currency === "string" && meta.currency ? meta.currency : ctx.currency;

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

    const enriched: SelectedOfferProduct = {
      ...product,
      translatedTitle:
        translationTitle(catalogById.get(product.productId)?.translations, language) ??
        product.translatedTitle,
    };

    // Plain product URL used when no discount code could be created.
    const handle = catalogById.get(product.productId)?.handle ?? "";
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
    const productView = toProductView(enriched, discountPct);
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
      currency: ctx.currency,
    };
  } catch (error) {
    console.error(`[orchestrator] assembleThankYouOffer failed for ${ctx.shop}`, error);
    return null;
  }
}
