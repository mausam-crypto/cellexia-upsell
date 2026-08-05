// ─────────────────────────────────────────────────────────────────────────────
// Module B — Recommendation engine.
//
// Implements SPEC.md §5-B:
//   selectOffers        — 9-step selection pipeline (frequency cap, market
//                         gating, suppression, rule matching with Thompson-
//                         sampling bandit, auto-pilot scoring, discount, display
//                         mode assembly).
//   resolveDiscountPct  — fixed / tiered / ai discount resolution with clamping.
//   resetExperimentStats— zero out candidate counters (optionally per rule).
//   autoPickWinners     — Monte-Carlo Beta posterior winner picking.
//
// Beta sampling is implemented via two Marsaglia–Tsang gamma draws.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { jparse, gidToNumber, toGid } from "../lib/json";
import {
  getActiveProducts,
  getProductsByIds,
  type CachedVariant,
  type CatalogProduct,
} from "./catalog.server";
import type {
  AppSettings,
  CopyLength,
  DiscountStrategy,
  DisplayMode,
  PurchaseContext,
  RuleTrigger,
  ScoringWeights,
  SelectedOffer,
  SelectedOfferProduct,
  SelectionResult,
} from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const HARD_MAX_OFFERS = 3;
const RECENT_ORDERS_CAP = 5000;
const MAX_BASKET_PRODUCTS_FOR_AFFINITY = 6;
const MONTE_CARLO_DRAWS = 2000;

function dbg(...args: unknown[]): void {
  console.debug("[engine]", ...args);
}

// ── Random sampling helpers (pure & deterministic given `rng`) ──────────────

type Rng = () => number;

/** Standard normal via Box–Muller. */
function sampleNormal(rng: Rng): number {
  let u1 = 0;
  do {
    u1 = rng();
  } while (u1 <= Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, 1) sampler — Marsaglia & Tsang (2000) "A simple method for
 * generating gamma variables". For shape < 1 uses the boosting identity
 * Gamma(a) = Gamma(a+1) · U^(1/a).
 */
export function sampleGamma(shape: number, rng: Rng = Math.random): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0;
  if (shape < 1) {
    const u = Math.max(rng(), Number.EPSILON);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), Number.EPSILON);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(alpha, beta) via two gamma draws. */
export function sampleBeta(alpha: number, beta: number, rng: Rng = Math.random): number {
  const a = Math.max(alpha, Number.EPSILON);
  const b = Math.max(beta, Number.EPSILON);
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  const sum = x + y;
  if (sum <= 0) return 0.5;
  return x / sum;
}

/**
 * Monte-Carlo posterior P(candidate i is best) with Beta(accepts+1,
 * impressions−accepts+1) posteriors. Returns one probability per input row.
 */
export function probBest(
  stats: Array<{ accepts: number; impressions: number }>,
  draws = MONTE_CARLO_DRAWS,
  rng: Rng = Math.random,
): number[] {
  if (stats.length === 0) return [];
  if (stats.length === 1) return [1];
  const wins = new Array<number>(stats.length).fill(0);
  for (let d = 0; d < draws; d++) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      const alpha = Math.max(s.accepts, 0) + 1;
      const beta = Math.max(s.impressions - s.accepts, 0) + 1;
      const v = sampleBeta(alpha, beta, rng);
      if (v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    wins[bestIdx]++;
  }
  return wins.map((w) => w / draws);
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Normalize any product/variant/customer id (gid or raw numeric) to its numeric tail. */
function normId(id: string | null | undefined): string {
  if (!id) return "";
  const n = gidToNumber(String(id));
  return Number.isNaN(n) ? String(id) : String(n);
}

/** All plausible stored representations of a customer id (raw, numeric, gid). */
function customerIdVariants(customerId: string): string[] {
  const out = new Set<string>();
  out.add(customerId);
  const n = gidToNumber(customerId);
  if (!Number.isNaN(n)) {
    out.add(String(n));
    out.add(toGid("Customer", n));
  }
  return [...out];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseTrigger(json: string): RuleTrigger {
  const raw = jparse<Partial<RuleTrigger>>(json, {});
  return {
    productIds: Array.isArray(raw.productIds) ? raw.productIds : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    productTypes: Array.isArray(raw.productTypes) ? raw.productTypes : [],
    minItems: typeof raw.minItems === "number" ? raw.minItems : null,
    maxItems: typeof raw.maxItems === "number" ? raw.maxItems : null,
    minTotal: typeof raw.minTotal === "number" ? raw.minTotal : null,
    maxTotal: typeof raw.maxTotal === "number" ? raw.maxTotal : null,
    countries: Array.isArray(raw.countries) ? raw.countries : [],
  };
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

function resolveDisplayMode(ruleValue: string | null | undefined, settings: AppSettings): DisplayMode {
  return ruleValue === "bundle" || ruleValue === "sequential" ? ruleValue : settings.defaultDisplayMode;
}

function resolveCopyLength(ruleValue: string | null | undefined, settings: AppSettings): CopyLength {
  return ruleValue === "short" || ruleValue === "long" ? ruleValue : settings.copyLength;
}

function normalizeWeights(w: ScoringWeights): ScoringWeights {
  const compatibility = Math.max(Number(w?.compatibility) || 0, 0);
  const repeatPurchase = Math.max(Number(w?.repeatPurchase) || 0, 0);
  const acceptance = Math.max(Number(w?.acceptance) || 0, 0);
  const margin = Math.max(Number(w?.margin) || 0, 0);
  const sum = compatibility + repeatPurchase + acceptance + margin;
  if (sum <= 0) {
    return { compatibility: 0.25, repeatPurchase: 0.25, acceptance: 0.25, margin: 0.25 };
  }
  return {
    compatibility: compatibility / sum,
    repeatPurchase: repeatPurchase / sum,
    acceptance: acceptance / sum,
    margin: margin / sum,
  };
}

function discountedPriceOf(variant: CachedVariant, discountPct: number): number {
  return variant.price * (1 - discountPct / 100);
}

/** Unit gross margin in currency: discounted price − (unit cost ?? 55% of price). */
function unitMargin(variant: CachedVariant, discountPct: number): number {
  const discounted = discountedPriceOf(variant, discountPct);
  const cost = variant.unitCost ?? variant.price * 0.55;
  return discounted - cost;
}

function jaccard(tags: string[], union: Set<string>): number {
  const set = new Set(tags.map(lc).filter(Boolean));
  if (set.size === 0 || union.size === 0) return 0;
  let inter = 0;
  for (const t of set) if (union.has(t)) inter++;
  const u = set.size + union.size - inter;
  return u === 0 ? 0 : inter / u;
}

function toOfferProduct(p: CatalogProduct, v: CachedVariant): SelectedOfferProduct {
  return {
    productId: p.productId,
    variantId: v.id,
    title: p.title,
    image: v.imageUrl ?? p.imageUrl,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    unitCost: v.unitCost,
    productType: p.productType,
    tags: p.tags,
  };
}

// ── Discount resolution (SPEC §5-B step 7) ───────────────────────────────────

export function resolveDiscountPct(
  strategy: DiscountStrategy,
  orderTotal: number,
  overridePct?: number | null,
): number {
  const minRaw = Number.isFinite(strategy?.min) ? strategy.min : 0;
  const maxRaw = Number.isFinite(strategy?.max) ? strategy.max : 100;
  const lo = Math.min(minRaw, maxRaw);
  const hi = Math.max(minRaw, maxRaw);

  let pct: number;
  if (overridePct != null && Number.isFinite(overridePct)) {
    pct = overridePct;
  } else {
    switch (strategy?.mode) {
      case "tiered": {
        const tiers = Array.isArray(strategy.tiers) ? strategy.tiers : [];
        const eligible = tiers.filter(
          (t) => Number.isFinite(t?.minOrderValue) && Number.isFinite(t?.pct) && t.minOrderValue <= orderTotal,
        );
        if (eligible.length > 0) {
          let best = eligible[0];
          for (const t of eligible) {
            if (t.minOrderValue >= best.minOrderValue) best = t;
          }
          pct = best.pct;
        } else {
          pct = Number.isFinite(strategy.value) ? strategy.value : lo;
        }
        break;
      }
      case "ai":
        pct = (lo + hi) / 2;
        break;
      case "fixed":
      default:
        pct = Number.isFinite(strategy?.value) ? strategy.value : lo;
        break;
    }
  }

  const clamped = Math.min(hi, Math.max(lo, pct));
  return Math.round(Math.min(100, Math.max(0, clamped)));
}

// ── Trigger matching (AND semantics, empty = any) ────────────────────────────

function triggerMatches(
  trigger: RuleTrigger,
  ctx: PurchaseContext,
  basketProducts: CatalogProduct[],
  distinctProducts: number,
): boolean {
  if (trigger.productIds.length > 0) {
    const basketIds = new Set(ctx.lineItems.map((li) => normId(li.productId)));
    if (!trigger.productIds.some((id) => basketIds.has(normId(id)))) return false;
  }
  if (trigger.tags.length > 0) {
    const basketTags = new Set<string>();
    for (const p of basketProducts) for (const t of p.tags) basketTags.add(lc(t));
    if (!trigger.tags.some((t) => basketTags.has(lc(t)))) return false;
  }
  if (trigger.productTypes.length > 0) {
    const basketTypes = new Set(basketProducts.map((p) => lc(p.productType)));
    if (!trigger.productTypes.some((t) => basketTypes.has(lc(t)))) return false;
  }
  if (trigger.minItems != null && distinctProducts < trigger.minItems) return false;
  if (trigger.maxItems != null && distinctProducts > trigger.maxItems) return false;
  if (trigger.minTotal != null && ctx.totalAmount < trigger.minTotal) return false;
  if (trigger.maxTotal != null && ctx.totalAmount > trigger.maxTotal) return false;
  if (trigger.countries.length > 0) {
    const cc = (ctx.countryCode ?? "").trim().toUpperCase();
    if (!cc) return false;
    if (!trigger.countries.some((c) => String(c).trim().toUpperCase() === cc)) return false;
  }
  return true;
}

// ── Bandit over slot candidates ──────────────────────────────────────────────

interface CandidateRow {
  id: string;
  slotId: string;
  productId: string;
  variantId: string;
  weight: number;
  enabled: boolean;
  impressions: number;
  accepts: number;
  revenue: number;
  isWinner: boolean;
}

interface BanditEntry {
  cand: CandidateRow;
  product: CatalogProduct;
  variant: CachedVariant;
}

/** Smoothed acceptance from candidate counters — Laplace-style prior. */
function candidateAcceptanceMean(cand: CandidateRow): number {
  return (Math.max(cand.accepts, 0) + 1) / (Math.max(cand.impressions, 0) + 4);
}

function banditValue(entry: BanditEntry, sample: number, settings: AppSettings, discountPct: number): number {
  let v = sample * Math.max(entry.cand.weight, 0);
  if (settings.optimizeMetric === "gp_per_impression") {
    v *= Math.max(unitMargin(entry.variant, discountPct), 0.01);
  }
  return v;
}

function pickViaBandit(
  entries: BanditEntry[],
  settings: AppSettings,
  discountPct: number,
  rng: Rng = Math.random,
): { entry: BanditEntry; score: number } {
  // Winner short-circuit: exploit the picked winner except explorationPct% of
  // the time, when we keep Thompson-sampling everyone.
  const winners = entries.filter((e) => e.cand.isWinner);
  if (settings.rotation.autoPickWinner && winners.length > 0) {
    const explore = Math.min(Math.max(settings.rotation.explorationPct, 0), 100) / 100;
    if (rng() >= explore) {
      const winner = winners[0];
      dbg("bandit: exploiting winner", winner.cand.id);
      return {
        entry: winner,
        score: banditValue(winner, candidateAcceptanceMean(winner.cand), settings, discountPct),
      };
    }
    dbg("bandit: exploration draw — Thompson-sampling all candidates");
  }

  let best: BanditEntry = entries[0];
  let bestValue = -Infinity;
  for (const e of entries) {
    const alpha = Math.max(e.cand.accepts, 0) + 1;
    const beta = Math.max(e.cand.impressions - e.cand.accepts, 0) + 1;
    const sample = sampleBeta(alpha, beta, rng);
    const value = banditValue(e, sample, settings, discountPct);
    if (value > bestValue) {
      bestValue = value;
      best = e;
    }
  }
  return { entry: best, score: bestValue };
}

// ── Order-history affinity (auto-pilot inputs) ───────────────────────────────

interface AffinityData {
  /** basket product (normalized id) → # of recent orders containing it */
  ordersWith: Map<string, number>;
  /** basket product → (candidate product → co-occurring order count) */
  coCount: Map<string, Map<string, number>>;
  /** product → smoothed share of its customers who bought it ≥2 times */
  repeatShare: Map<string, number>;
}

async function loadOrderAffinity(shop: string, basketNormIds: string[]): Promise<AffinityData> {
  const ordersWith = new Map<string, number>();
  const coCount = new Map<string, Map<string, number>>();
  for (const a of basketNormIds) {
    ordersWith.set(a, 0);
    coCount.set(a, new Map());
  }
  const repeatShare = new Map<string, number>();

  const recent = await prisma.orderRecord.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: RECENT_ORDERS_CAP,
    select: { id: true, customerId: true },
  });
  if (recent.length === 0) return { ordersWith, coCount, repeatShare };

  const customerByOrder = new Map<string, string | null>(recent.map((r) => [r.id, r.customerId]));
  const lines: Array<{ orderRecordId: string; productId: string }> = [];
  for (const batch of chunk(recent.map((r) => r.id), 500)) {
    const rows = await prisma.orderLine.findMany({
      where: { orderRecordId: { in: batch } },
      select: { orderRecordId: true, productId: true },
    });
    lines.push(...rows);
  }

  const productsOfOrder = new Map<string, Set<string>>();
  for (const line of lines) {
    let set = productsOfOrder.get(line.orderRecordId);
    if (!set) {
      set = new Set();
      productsOfOrder.set(line.orderRecordId, set);
    }
    set.add(normId(line.productId));
  }

  // Co-occurrence with each basket product A.
  for (const products of productsOfOrder.values()) {
    for (const a of basketNormIds) {
      if (!products.has(a)) continue;
      ordersWith.set(a, (ordersWith.get(a) ?? 0) + 1);
      const counts = coCount.get(a)!;
      for (const p of products) {
        if (p === a) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
  }

  // Repeat-purchase share: per product, share of its customers with ≥2 orders
  // containing it (rule-of-succession smoothing toward 0.5).
  const ordersPerCustomerByProduct = new Map<string, Map<string, number>>();
  for (const [orderId, products] of productsOfOrder) {
    const customer = customerByOrder.get(orderId);
    if (!customer) continue;
    for (const p of products) {
      let m = ordersPerCustomerByProduct.get(p);
      if (!m) {
        m = new Map();
        ordersPerCustomerByProduct.set(p, m);
      }
      m.set(customer, (m.get(customer) ?? 0) + 1);
    }
  }
  for (const [p, byCustomer] of ordersPerCustomerByProduct) {
    let repeat = 0;
    for (const n of byCustomer.values()) if (n >= 2) repeat++;
    repeatShare.set(p, (repeat + 1) / (byCustomer.size + 2));
  }

  return { ordersWith, coCount, repeatShare };
}

async function loadAcceptanceByProduct(
  shop: string,
): Promise<Map<string, { impressions: number; accepts: number }>> {
  const map = new Map<string, { impressions: number; accepts: number }>();
  const [impressions, accepts] = await Promise.all([
    prisma.offerEvent.groupBy({
      by: ["productId"],
      where: { shop, eventType: "impression", productId: { not: null } },
      _count: { _all: true },
    }),
    prisma.offerEvent.groupBy({
      by: ["productId"],
      where: { shop, eventType: "accepted", productId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  for (const row of impressions) {
    if (!row.productId) continue;
    map.set(normId(row.productId), { impressions: row._count._all, accepts: 0 });
  }
  for (const row of accepts) {
    if (!row.productId) continue;
    const key = normId(row.productId);
    const entry = map.get(key) ?? { impressions: 0, accepts: 0 };
    entry.accepts = row._count._all;
    map.set(key, entry);
  }
  return map;
}

// ── selectOffers — the 9-step pipeline ───────────────────────────────────────

interface OfferPick {
  product: SelectedOfferProduct;
  candidateId: string | null;
  score: number;
  expectedGp: number;
}

function assembleOffers(
  picks: OfferPick[],
  displayMode: DisplayMode,
  discountPct: number,
  ruleId: string | null,
): SelectedOffer[] {
  const capped = picks.slice(0, HARD_MAX_OFFERS);
  if (capped.length === 0) return [];

  if (displayMode === "bundle" && capped.length > 1) {
    const totalGp = capped.reduce((s, p) => s + p.expectedGp, 0);
    const avgScore = capped.reduce((s, p) => s + p.score, 0) / capped.length;
    return [
      {
        ruleId,
        candidateIds: capped.flatMap((p) => (p.candidateId ? [p.candidateId] : [])),
        products: capped.map((p) => p.product),
        discountPct,
        score: avgScore,
        expectedGpPerImpression: totalGp,
        position: 1,
      },
    ];
  }

  // Picks arrive already ordered: rule slots by admin-defined position, and
  // auto-pilot by the configured optimizeMetric. Re-sorting here would
  // override both — keep the caller's order.
  return capped.map((p, i) => ({
    ruleId,
    candidateIds: p.candidateId ? [p.candidateId] : [],
    products: [p.product],
    discountPct,
    score: p.score,
    expectedGpPerImpression: p.expectedGp,
    position: i + 1,
  }));
}

export async function selectOffers(
  ctx: PurchaseContext,
  settings: AppSettings,
): Promise<SelectionResult> {
  const empty = (matchedRuleId: string | null = null): SelectionResult => ({
    offers: [],
    displayMode: settings.defaultDisplayMode,
    matchedRuleId,
    copyLength: settings.copyLength,
  });

  try {
    // Step 1 — global kill switch.
    if (settings.enabled === false) {
      dbg("step1: app disabled — no offers");
      return empty();
    }

    // Step 2 — frequency cap (applies whenever we know the customer).
    if (ctx.customerId && settings.frequencyCapDays > 0) {
      const states = await prisma.customerState.findMany({
        where: { shop: ctx.shop, customerId: { in: customerIdVariants(ctx.customerId) } },
      });
      let lastOfferAt: Date | null = null;
      for (const s of states) {
        if (s.lastOfferAt && (!lastOfferAt || s.lastOfferAt > lastOfferAt)) lastOfferAt = s.lastOfferAt;
      }
      if (lastOfferAt && Date.now() - lastOfferAt.getTime() < settings.frequencyCapDays * DAY_MS) {
        dbg("step2: frequency cap hit for customer", ctx.customerId, "last offer", lastOfferAt.toISOString());
        return empty();
      }
    }
    dbg("step2: frequency cap passed");

    // Step 3 — market gating.
    let market: {
      enabled: boolean;
      discountOverride: number | null;
      maxOffersOverride: number | null;
    } | null = null;
    if (ctx.countryCode) {
      const cc = ctx.countryCode.trim().toUpperCase();
      const markets = await prisma.marketSetting.findMany({ where: { shop: ctx.shop } });
      const hit = markets.find((m) =>
        jparse<string[]>(m.countriesJson, []).some((c) => String(c).trim().toUpperCase() === cc),
      );
      if (hit) {
        if (hit.enabled === false) {
          dbg("step3: market", hit.marketHandle, "disabled for", cc, "— no offers");
          return empty();
        }
        market = {
          enabled: hit.enabled,
          discountOverride: hit.discountOverride,
          maxOffersOverride: hit.maxOffersOverride,
        };
        dbg("step3: market", hit.marketHandle, "matched for", cc);
      }
    }

    // Step 4 — offer count.
    const distinctProducts = new Set(ctx.lineItems.map((li) => normId(li.productId))).size;
    let maxOffers =
      distinctProducts <= 1 ? settings.singleProductOrderOffers : settings.multiProductOrderOffers;
    if (market?.maxOffersOverride != null) maxOffers = Math.min(maxOffers, market.maxOffersOverride);
    maxOffers = Math.min(maxOffers, HARD_MAX_OFFERS);
    if (ctx.surface === "thank_you") maxOffers = Math.min(maxOffers, 1);
    maxOffers = Math.floor(maxOffers);
    dbg("step4: distinctProducts =", distinctProducts, "maxOffers =", maxOffers);
    if (!Number.isFinite(maxOffers) || maxOffers < 1) return empty();

    // Step 5 — suppression set.
    const suppressed = new Set<string>();
    for (const li of ctx.lineItems) suppressed.add(normId(li.productId));
    if (ctx.customerId && settings.suppressionDays > 0) {
      const since = new Date(Date.now() - settings.suppressionDays * DAY_MS);
      const recentOrders = await prisma.orderRecord.findMany({
        where: {
          shop: ctx.shop,
          customerId: { in: customerIdVariants(ctx.customerId) },
          createdAt: { gte: since },
        },
        select: { lines: { select: { productId: true } } },
        take: 250,
      });
      for (const order of recentOrders) {
        for (const line of order.lines) suppressed.add(normId(line.productId));
      }
    }
    dbg("step5: suppression set size =", suppressed.size);

    const isSuppressed = (p: CatalogProduct, v: CachedVariant | null): boolean => {
      if (!v) return true;
      if (suppressed.has(normId(p.productId))) return true;
      if (p.status !== "ACTIVE") return true;
      if (v.inventoryQuantity !== null && v.inventoryQuantity < settings.minInventory) return true;
      if (!(v.price > 0)) return true;
      return false;
    };

    // Step 6 — rule matching (first match wins, priority asc).
    const basketIds = [...new Set(ctx.lineItems.map((li) => li.productId))];
    const basketProducts = basketIds.length > 0 ? await getProductsByIds(ctx.shop, basketIds) : [];
    const rules = await prisma.offerRule.findMany({
      where: { shop: ctx.shop, enabled: true },
      orderBy: { priority: "asc" },
      include: {
        slots: { include: { candidates: true }, orderBy: { position: "asc" } },
      },
    });

    let matchedRule: (typeof rules)[number] | null = null;
    for (const rule of rules) {
      const trigger = parseTrigger(rule.triggerJson);
      if (triggerMatches(trigger, ctx, basketProducts, distinctProducts)) {
        matchedRule = rule;
        break;
      }
    }
    dbg("step6: matched rule =", matchedRule ? `${matchedRule.id} (${matchedRule.name})` : "none (auto-pilot)");

    // Step 7 — discount (resolved up-front; used in scoring too).
    const ruleDiscount = matchedRule ? jparse<DiscountStrategy | null>(matchedRule.discountJson, null) : null;
    const discountPct = resolveDiscountPct(
      ruleDiscount ?? settings.discount,
      ctx.totalAmount,
      market?.discountOverride ?? null,
    );
    dbg("step7: discountPct =", discountPct);

    let picks: OfferPick[] = [];
    let displayMode: DisplayMode;
    let copyLength: CopyLength;
    let matchedRuleId: string | null = null;

    if (matchedRule) {
      matchedRuleId = matchedRule.id;
      if (matchedRule.maxOffers != null) maxOffers = Math.min(maxOffers, matchedRule.maxOffers);
      if (maxOffers < 1) return empty(matchedRule.id);
      displayMode = resolveDisplayMode(matchedRule.displayMode, settings);
      copyLength = resolveCopyLength(matchedRule.copyLength, settings);

      const candidateProductIds = [
        ...new Set(matchedRule.slots.flatMap((s) => s.candidates.map((c) => c.productId))),
      ];
      const candidateProducts =
        candidateProductIds.length > 0 ? await getProductsByIds(ctx.shop, candidateProductIds) : [];
      const productById = new Map(candidateProducts.map((p) => [normId(p.productId), p]));

      const chosenProductIds = new Set<string>();
      const slots = [...matchedRule.slots].sort((a, b) => a.position - b.position);
      for (const slot of slots) {
        if (picks.length >= maxOffers) break;
        const eligible: BanditEntry[] = [];
        for (const cand of slot.candidates) {
          if (!cand.enabled) continue;
          if (chosenProductIds.has(normId(cand.productId))) continue;
          const product = productById.get(normId(cand.productId));
          if (!product) continue;
          const targetVariant = normId(cand.variantId);
          const variant = product.variants.find((v) => normId(v.id) === targetVariant) ?? null;
          if (isSuppressed(product, variant)) continue;
          eligible.push({ cand, product, variant: variant! });
        }
        if (eligible.length === 0) {
          dbg("step6: slot", slot.position, "has no eligible candidates — skipped");
          continue;
        }
        const { entry, score } = pickViaBandit(eligible, settings, discountPct);
        chosenProductIds.add(normId(entry.cand.productId));
        const expectedGp = candidateAcceptanceMean(entry.cand) * unitMargin(entry.variant, discountPct);
        picks.push({
          product: toOfferProduct(entry.product, entry.variant),
          candidateId: entry.cand.id,
          score,
          expectedGp,
        });
        dbg("step6: slot", slot.position, "picked candidate", entry.cand.id, "product", entry.product.title);
      }
    } else {
      // Step 6b — auto-pilot scoring over the whole active catalog.
      displayMode = settings.defaultDisplayMode;
      copyLength = settings.copyLength;

      const active = await getActiveProducts(ctx.shop);
      const pool: Array<{ product: CatalogProduct; variant: CachedVariant }> = [];
      for (const p of active) {
        // First variant passing suppression (untracked or qty >= minInventory,
        // price > 0) — skip the product only when NO variant qualifies.
        const v = p.variants.find((cand) => !isSuppressed(p, cand)) ?? null;
        if (!v) continue;
        pool.push({ product: p, variant: v });
      }
      dbg("step6b: auto-pilot pool size =", pool.length);
      if (pool.length === 0) return empty();

      const basketNormIds = [...new Set(ctx.lineItems.map((li) => normId(li.productId)))]
        .filter(Boolean)
        .slice(0, MAX_BASKET_PRODUCTS_FOR_AFFINITY);
      const [affinity, acceptanceByProduct] = await Promise.all([
        loadOrderAffinity(ctx.shop, basketNormIds),
        loadAcceptanceByProduct(ctx.shop),
      ]);

      const basketTypes = new Set(basketProducts.map((p) => lc(p.productType)));
      const basketTagUnion = new Set<string>();
      for (const p of basketProducts) for (const t of p.tags) basketTagUnion.add(lc(t));
      const weights = normalizeWeights(settings.weights);

      const scored = pool.map(({ product, variant }) => {
        const key = normId(product.productId);

        // coPurchase = max over basket products A of Laplace-smoothed P(candidate | A).
        let coPurchase = basketNormIds.length === 0 ? 0.5 : 0;
        for (const a of basketNormIds) {
          const nA = affinity.ordersWith.get(a) ?? 0;
          const co = affinity.coCount.get(a)?.get(key) ?? 0;
          coPurchase = Math.max(coPurchase, (co + 1) / (nA + 2));
        }

        const typeAffinity = basketTypes.has(lc(product.productType)) ? 0.4 : 1;
        const tagOverlap = jaccard(product.tags, basketTagUnion);
        const compatibility = 0.6 * coPurchase + 0.25 * typeAffinity + 0.15 * tagOverlap;

        const repeatPurchase = affinity.repeatShare.get(key) ?? 0.5;

        const acc = acceptanceByProduct.get(key) ?? { impressions: 0, accepts: 0 };
        const acceptance = (acc.accepts + 1) / (acc.impressions + 4);

        const discounted = discountedPriceOf(variant, discountPct);
        const margin =
          variant.unitCost != null && discounted > 0
            ? Math.min(Math.max((discounted - variant.unitCost) / discounted, 0), 1)
            : 0.5;

        const score =
          weights.compatibility * compatibility +
          weights.repeatPurchase * repeatPurchase +
          weights.acceptance * acceptance +
          weights.margin * margin;
        const expectedGp = acceptance * (discounted - (variant.unitCost ?? variant.price * 0.55));
        const revenuePerImpression = acceptance * discounted;

        return { product, variant, score, acceptance, expectedGp, revenuePerImpression };
      });

      switch (settings.optimizeMetric) {
        case "conversion":
          scored.sort((a, b) => b.acceptance - a.acceptance || b.score - a.score);
          break;
        case "revenue_per_impression":
          scored.sort((a, b) => b.revenuePerImpression - a.revenuePerImpression || b.score - a.score);
          break;
        case "gp_per_impression":
        default:
          scored.sort((a, b) => b.expectedGp - a.expectedGp || b.score - a.score);
          break;
      }

      picks = scored.slice(0, maxOffers).map((s) => ({
        product: toOfferProduct(s.product, s.variant),
        candidateId: null,
        score: s.score,
        expectedGp: s.expectedGp,
      }));
      dbg(
        "step6b: auto-pilot picked",
        picks.map((p) => p.product.title),
        "by",
        settings.optimizeMetric,
      );
    }

    // Step 9 — never more than 3; empty candidates → empty result.
    if (picks.length === 0) {
      dbg("step9: no eligible picks — empty result");
      return empty(matchedRuleId);
    }

    // Step 8 — display mode assembly (+ step 9 hard cap inside).
    const offers = assembleOffers(picks, displayMode, discountPct, matchedRuleId);
    dbg("step8: displayMode =", displayMode, "offers =", offers.length);

    return { offers, displayMode, matchedRuleId, copyLength };
  } catch (error) {
    console.error("[engine] selectOffers failed — degrading to empty result", error);
    return empty();
  }
}

// ── Experiment maintenance ───────────────────────────────────────────────────

export async function resetExperimentStats(shop: string, ruleId?: string): Promise<void> {
  await prisma.offerCandidate.updateMany({
    where: { slot: { rule: { shop, ...(ruleId ? { id: ruleId } : {}) } } },
    data: { impressions: 0, accepts: 0, revenue: 0, isWinner: false },
  });
  dbg("resetExperimentStats: shop =", shop, "ruleId =", ruleId ?? "(all)");
}

/**
 * Auto-declare winners: for every slot with ≥2 enabled candidates, when the
 * leading candidate has enough impressions and its Monte-Carlo posterior
 * P(best) clears the confidence threshold, mark it the winner (and clear the
 * flag on siblings). Returns the number of NEW winners declared.
 */
export async function autoPickWinners(shop: string, settings: AppSettings): Promise<number> {
  try {
    const rotation = settings.rotation;
    if (!rotation.enabled || !rotation.autoPickWinner) return 0;

    const slots = await prisma.offerSlot.findMany({
      where: { rule: { shop } },
      include: { candidates: true },
    });

    let newWinners = 0;
    for (const slot of slots) {
      const enabled = slot.candidates.filter((c) => c.enabled);
      if (enabled.length < 2) continue;

      const probs = probBest(
        enabled.map((c) => ({ accepts: c.accepts, impressions: c.impressions })),
        MONTE_CARLO_DRAWS,
      );
      let bestIdx = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[bestIdx]) bestIdx = i;
      }
      const best = enabled[bestIdx];
      if (best.impressions < rotation.minImpressionsToPick) continue;
      if (probs[bestIdx] < rotation.winnerConfidence) continue;

      const alreadyConsistent =
        best.isWinner && slot.candidates.every((c) => c.id === best.id || !c.isWinner);
      if (alreadyConsistent) continue;

      await prisma.$transaction([
        prisma.offerCandidate.updateMany({
          where: { slotId: slot.id },
          data: { isWinner: false },
        }),
        prisma.offerCandidate.update({
          where: { id: best.id },
          data: { isWinner: true },
        }),
      ]);
      if (!best.isWinner) {
        newWinners++;
        dbg(
          "autoPickWinners: slot",
          slot.id,
          "winner =",
          best.id,
          "P(best) =",
          probs[bestIdx].toFixed(3),
        );
      }
    }
    return newWinners;
  } catch (error) {
    console.error("[engine] autoPickWinners failed", error);
    return 0;
  }
}
