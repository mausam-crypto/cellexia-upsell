// ─────────────────────────────────────────────────────────────────────────────
// Shared domain types for the Cellexia Post-Purchase Upsell app.
// This file is the contract between services, routes, and the extensions.
// ─────────────────────────────────────────────────────────────────────────────

export type DisplayMode = "sequential" | "bundle";
export type CopyLength = "short" | "long";
export type OptimizeMetric =
  | "gp_per_impression"
  | "conversion"
  | "revenue_per_impression";
export type Surface = "post_purchase" | "thank_you";

/** Shape of the `graphql` function on the admin client from shopify-app-remix. */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// ── Settings ────────────────────────────────────────────────────────────────

export interface DiscountTier {
  minOrderValue: number;
  pct: number;
}

export interface DiscountStrategy {
  /** fixed: always `value`. tiered: by order total. ai: Claude proposes within [min,max]. */
  mode: "fixed" | "tiered" | "ai";
  value: number;
  min: number;
  max: number;
  tiers: DiscountTier[];
}

export interface RotationSettings {
  enabled: boolean;
  /** % of impressions that keep exploring even after a winner is picked. */
  explorationPct: number;
  minImpressionsToPick: number;
  /** Posterior probability threshold to auto-declare a winner (0..1). */
  winnerConfidence: number;
  autoPickWinner: boolean;
}

export interface CountdownSettings {
  enabled: boolean;
  minutes: number;
}

export interface ScoringWeights {
  compatibility: number;
  repeatPurchase: number;
  acceptance: number;
  margin: number;
}

export interface AppSettings {
  enabled: boolean;
  thankYouEnabled: boolean;
  /** Offers shown when the original order has ONE distinct product. */
  singleProductOrderOffers: number;
  /** Offers shown (sequenced) when the original order has 2+ distinct products. */
  multiProductOrderOffers: number;
  defaultDisplayMode: DisplayMode;
  discount: DiscountStrategy;
  /** Min days between post-purchase offers for the same customer. */
  frequencyCapDays: number;
  /** Don't offer products the customer bought within this many days. */
  suppressionDays: number;
  /** Hide offers whose variant has tracked inventory below this. */
  minInventory: number;
  copyLength: CopyLength;
  tone: string;
  /** Brand voice / positioning injected into every AI prompt. Editable. */
  brandContext: string;
  aiEnabled: boolean;
  aiModel: string;
  /**
   * Model for the buyer-blocking CORE copy call (headline/lead/bullets/closer).
   * Must be fast — the post-purchase callback has a hard time budget. The
   * extended sections (paragraphs/proof) use the prompt template's model in a
   * background call where latency doesn't matter.
   */
  coreCopyModel: string;
  aiTimeoutMs: number;
  translationProvider: "claude" | "deepl";
  translationModel: string;
  optimizeMetric: OptimizeMetric;
  rotation: RotationSettings;
  countdown: CountdownSettings;
  showComparePrice: boolean;
  /** Store locales (synced from Shopify, editable). */
  languages: string[];
  defaultLanguage: string;
  /**
   * Shopify locales already seen by the sync — new published locales are
   * ADDED to `languages` once; locales the merchant then disables are never
   * re-added by later syncs (curation survives).
   */
  knownShopifyLocales: string[];
  weights: ScoringWeights;
}

export const DEFAULT_SETTINGS: AppSettings = {
  enabled: true,
  thankYouEnabled: true,
  singleProductOrderOffers: 1,
  multiProductOrderOffers: 3,
  defaultDisplayMode: "sequential",
  discount: {
    mode: "tiered",
    value: 12,
    min: 10,
    max: 15,
    tiers: [
      { minOrderValue: 0, pct: 10 },
      { minOrderValue: 60, pct: 12 },
      { minOrderValue: 120, pct: 15 },
    ],
  },
  frequencyCapDays: 14,
  suppressionDays: 60,
  minInventory: 1,
  copyLength: "long",
  tone: "warm, expert, confident — never salesy, never implying the original purchase was incomplete",
  brandContext:
    "Cellexia Labs — Precision Beauty™. Professional-grade anti-aging skincare for mature skin: serums, creams, eye serums, lip formulas, body creams and neck treatments. 60-day money-back guarantee. Customers are discerning adults who value efficacy and ingredient science.",
  aiEnabled: true,
  aiModel: "claude-haiku-4-5",
  coreCopyModel: "claude-haiku-4-5",
  aiTimeoutMs: 3500,
  translationProvider: "claude",
  translationModel: "claude-sonnet-5",
  optimizeMetric: "gp_per_impression",
  rotation: {
    enabled: true,
    explorationPct: 10,
    minImpressionsToPick: 200,
    winnerConfidence: 0.95,
    autoPickWinner: true,
  },
  countdown: { enabled: true, minutes: 10 },
  showComparePrice: true,
  languages: [
    "en", "fr", "de", "da", "sv", "fi", "nl", "it", "es",
    "ar", "pl", "pt-PT", "ja", "no", "ro", "hu", "el",
  ],
  defaultLanguage: "en",
  knownShopifyLocales: [],
  weights: { compatibility: 0.35, repeatPurchase: 0.2, acceptance: 0.25, margin: 0.2 },
};

// ── Offer rules ─────────────────────────────────────────────────────────────

/** All conditions are AND-ed; empty arrays / nulls mean "any". */
export interface RuleTrigger {
  /** Order contains at least one of these products (gids). */
  productIds: string[];
  /** Order contains a product with at least one of these tags. */
  tags: string[];
  /** Order contains a product of one of these product types. */
  productTypes: string[];
  minItems: number | null; // distinct products in order
  maxItems: number | null;
  minTotal: number | null; // order total, shop currency
  maxTotal: number | null;
  /** ISO country codes; empty = all. */
  countries: string[];
}

export const EMPTY_TRIGGER: RuleTrigger = {
  productIds: [],
  tags: [],
  productTypes: [],
  minItems: null,
  maxItems: null,
  minTotal: null,
  maxTotal: null,
  countries: [],
};

// ── Purchase context (input to the engine) ──────────────────────────────────

export interface PurchaseLineItem {
  productId: string; // gid
  variantId: string | null; // gid
  quantity: number;
  priceAmount: number | null;
  title?: string;
}

export interface PurchaseContext {
  shop: string;
  referenceId: string;
  customerId: string | null;
  countryCode: string | null;
  locale: string;
  /** SHOP currency (not presentment) — must match totalAmount. */
  currency: string;
  /**
   * Order total in SHOP currency. Rule min/max totals, discount tiers and
   * catalog prices are shop-currency amounts; comparing a presentment total
   * (e.g. ¥12,000) against them would be meaningless.
   */
  totalAmount: number;
  lineItems: PurchaseLineItem[];
  surface: Surface;
}

// ── Engine output ───────────────────────────────────────────────────────────

export interface SelectedOfferProduct {
  productId: string;
  variantId: string;
  title: string;
  translatedTitle?: string;
  image: string | null;
  price: number;
  compareAtPrice: number | null;
  unitCost: number | null;
  productType: string;
  tags: string[];
}

export interface SelectedOffer {
  ruleId: string | null;
  candidateIds: string[];
  products: SelectedOfferProduct[]; // 1 for sequential pages, up to 3 for bundle
  discountPct: number;
  score: number;
  expectedGpPerImpression: number;
  position: number; // 1-based
}

export interface SelectionResult {
  offers: SelectedOffer[];
  displayMode: DisplayMode;
  matchedRuleId: string | null;
  copyLength: CopyLength;
}

// ── Extension-facing payloads ───────────────────────────────────────────────

export interface OfferChange {
  type: "add_variant";
  variantID: number; // numeric id — Shopify changeset format
  quantity: number;
  discount?: { value: number; valueType: "percentage"; title: string };
}

export interface OfferProductView {
  productId: string;
  variantId: string;
  title: string;
  image: string | null;
  price: string; // decimal string
  discountedPrice: string;
  compareAtPrice: string | null;
}

export interface OfferCopy {
  headline: string;
  /** Lead — the promise, 1–2 sentences shown above the fold next to the CTA. */
  body: string;
  bullets: string[];
  /**
   * Extended persuasion section (copyLength "long"): 2–3 short paragraphs of
   * mechanism / proof / relevance-to-order, rendered BELOW the CTA so the
   * button stays above the fold on mobile. Empty/absent → section hidden.
   */
  paragraphs?: string[];
  /** One-line premium reassurance rendered directly above the buttons. */
  closer?: string;
  /**
   * Research block (copyLength "long"): 2–3 statements of widely-established
   * published findings about ingredients explicitly named in the brief —
   * rendered under the paragraphs with its own heading. Never product-level
   * claims, never invented citations. Empty/absent → block hidden.
   */
  proof?: string[];
}

export interface OfferPage {
  offerId: string;
  ruleId: string | null;
  candidateIds: string[];
  products: OfferProductView[];
  discountPct: number;
  discountTitle: string;
  copy: OfferCopy;
  changes: OfferChange[];
  position: number;
  /**
   * True when the below-CTA sections (paragraphs/proof) are still being
   * generated in the background — the extension polls /api/offer-extended
   * and merges them in when ready. Absent/false = copy is complete.
   */
  extendedPending?: boolean;
}

export interface OfferResponse {
  offers: OfferPage[];
  displayMode: DisplayMode;
  currency: string;
  language: string;
  strings: Record<string, string>;
  ui: {
    showCountdown: boolean;
    countdownMinutes: number;
    copyLength: CopyLength;
    showComparePrice: boolean;
  };
}

/** Thank-you page offer (discount-code based, works for all payment methods). */
export interface ThankYouOffer {
  offerId: string;
  /** Server-side reference key for this offer — the extension must echo it verbatim in /api/events payloads. */
  referenceId: string;
  product: OfferProductView;
  discountPct: number;
  discountCode: string;
  checkoutUrl: string;
  copy: OfferCopy;
  strings: Record<string, string>;
  language: string;
  currency: string;
}

export interface ExtensionEventPayload {
  referenceId: string;
  offerId: string;
  eventType: "impression" | "accepted" | "declined" | "error";
  revenue?: number;
  currency?: string;
  surface?: Surface;
  message?: string;
}

// ── Buyer-facing UI strings (seeded per language, editable, AI-translatable) ─

export const DEFAULT_UI_STRINGS_EN: Record<string, string> = {
  offer_badge: "Exclusive one-time offer",
  offer_x_of_y: "Offer {x} of {y}",
  time_left: "Offer reserved for",
  add_to_order: "Add to my order",
  add_all_to_order: "Add all to my order",
  decline: "No thanks, complete my order",
  was: "Was",
  now: "Now",
  save_pct: "Save {pct}%",
  ships_free: "Ships with your order — no extra shipping",
  one_click_note: "One click — charged to the payment method you just used",
  processing: "Adding to your order…",
  error_try_again: "Something went wrong. Your original order is not affected.",
  discount_applied: "{pct}% off — post-purchase exclusive",
  why_it_works: "Why it works with your order",
  research_shows: "What published research shows",
  thank_you_title: "A little something extra",
  thank_you_cta: "Claim this offer",
  thank_you_code_note: "Code {code} — applied automatically at checkout",
};

export const UI_STRING_KEYS = Object.keys(DEFAULT_UI_STRINGS_EN);

/** Store languages on cellexialabs.com (Translate & Adapt). */
export const CELLEXIA_LANGUAGES = [
  "en", "fr", "de", "da", "sv", "fi", "nl", "it", "es",
  "ar", "pl", "pt-PT", "ja", "no", "ro", "hu", "el",
];

export const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  fr: "Français",
  de: "Deutsch",
  da: "Dansk",
  sv: "Svenska",
  fi: "Suomi",
  nl: "Nederlands",
  it: "Italiano",
  es: "Español",
  ar: "العربية",
  pl: "Polski",
  "pt-PT": "Português (Portugal)",
  ja: "日本語",
  no: "Norsk",
  ro: "Română",
  hu: "Magyar",
  el: "Ελληνικά",
};
