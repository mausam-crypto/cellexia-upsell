// ─────────────────────────────────────────────────────────────────────────────
// Module D — Analytics.
//
// Ingests extension events (impression / accepted / declined / error) and
// orders/create webhooks, and serves every aggregate the dashboard and the
// analytics page need: KPI stats, time series, per-offer performance,
// dimensional breakdowns, A/B experiment posteriors and CLV cohorts.
//
// Conventions honored here:
// - `shop` (the *.myshopify.com domain) is the tenancy key on every call.
// - JSON columns are strings — read them with `jparse`.
// - `recordExtensionEvent` NEVER throws (public endpoint path).
// - Prisma aggregate/groupBy where possible; bounded in-memory aggregation
//   where SQLite/Prisma cannot express the query (day bucketing, CLV cohorts).
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { gidToNumber, jparse } from "../lib/json";
import type { ExtensionEventPayload, Surface } from "../types";

const MS_PER_DAY = 86_400_000;
/** When a product has no known unit cost, assume cost = 55% of its price. */
const DEFAULT_UNIT_COST_RATIO = 0.55;
const MONTE_CARLO_DRAWS = 2000;
/** Hard bounds for in-memory aggregation fallbacks. */
const MAX_EVENT_SCAN = 100_000;
const MAX_ORDER_SCAN = 200_000;

// ── Exported row shapes (SPEC §5-D) ─────────────────────────────────────────

export interface DashboardStats {
  impressions: number;
  accepts: number;
  declines: number;
  acceptanceRate: number; // accepts / max(1, impressions)
  upsellRevenue: number;
  upsellGrossProfit: number;
  gpPerImpression: number;
  offersPerOrderShown: number; // avg pages per referenceId
  currency: string;
}

export interface OfferPerfRow {
  productId: string;
  title: string;
  surface: string;
  impressions: number;
  accepts: number;
  acceptanceRate: number;
  revenue: number;
  grossProfit: number;
  gpPerImpression: number;
  avgDiscountPct: number;
}

export interface ExperimentRow {
  ruleId: string;
  ruleName: string;
  slotPosition: number;
  candidateId: string;
  productTitle: string;
  impressions: number;
  accepts: number;
  acceptanceRate: number;
  revenue: number;
  probBest: number;
  isWinner: boolean;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Shape of IssuedOffer.offerMetaJson as written by the offer orchestrator.
 * Parsed defensively — every field may be missing on old/foreign rows.
 */
interface IssuedOfferMeta {
  ruleId?: string | null;
  candidateIds?: unknown;
  products?: unknown;
  discountPct?: number;
  language?: string | null;
  country?: string | null;
  customerId?: string | number | null;
  market?: string | null;
  surface?: Surface | string;
  position?: number;
}

interface MetaProduct {
  productId: string | null;
  variantId: string | null;
  discountedPrice: number;
  grossProfit: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clampDays(days: number): number {
  const d = Number.isFinite(days) ? Math.floor(days) : 30;
  return Math.max(1, Math.min(365, d));
}

function windowStart(days: number): Date {
  return new Date(Date.now() - clampDays(days) * MS_PER_DAY);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseMetaProducts(meta: IssuedOfferMeta, discountPct: number): MetaProduct[] {
  if (!Array.isArray(meta.products)) return [];
  const out: MetaProduct[] = [];
  for (const raw of meta.products) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const price = asFiniteNumber(p.price, 0);
    const rawCost = p.unitCost;
    const unitCost =
      rawCost === null || rawCost === undefined || !Number.isFinite(Number(rawCost))
        ? null
        : Number(rawCost);
    const discountedPrice = price * (1 - discountPct / 100);
    const grossProfit = discountedPrice - (unitCost ?? DEFAULT_UNIT_COST_RATIO * price);
    out.push({
      productId: typeof p.productId === "string" && p.productId ? p.productId : null,
      variantId: typeof p.variantId === "string" && p.variantId ? p.variantId : null,
      discountedPrice,
      grossProfit,
    });
  }
  return out;
}

function parseCandidateIds(meta: IssuedOfferMeta): string[] {
  if (!Array.isArray(meta.candidateIds)) return [];
  return meta.candidateIds.filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
}

/**
 * Fallback for stale bandit counters. Rule saves recreate OfferCandidate rows
 * with new ids, so `updateMany({ id: { in: candidateIds } })` silently no-ops
 * for offers issued before the save. For each entry whose candidate id no
 * longer exists, find the rule's CURRENT candidate whose variantId numeric
 * part matches the shown product's variantId — preferring the slot at the
 * expected position (sequential pages carry the slot position as the page
 * position; bundle pages list candidates in slot order), falling back to any
 * slot in the rule — and apply the increment there instead. Bounded to one
 * rule's slots; never throws.
 */
async function bumpStaleCandidateCounters(
  shop: string,
  ruleId: string | null | undefined,
  entries: Array<{
    candidateId: string;
    variantId: string | null;
    slotPosition: number;
    /** null → impression bump; number → accept bump with this revenue share. */
    revenueShare: number | null;
  }>,
): Promise<void> {
  if (!ruleId || entries.length === 0) return;
  try {
    const existing = await prisma.offerCandidate.findMany({
      where: { id: { in: entries.map((e) => e.candidateId) } },
      select: { id: true },
    });
    const alive = new Set(existing.map((c) => c.id));
    const stale = entries.filter((e) => !alive.has(e.candidateId));
    if (stale.length === 0) return;

    const slots = await prisma.offerSlot.findMany({
      where: { ruleId, rule: { shop } },
      orderBy: { position: "asc" },
      select: {
        position: true,
        candidates: { select: { id: true, variantId: true } },
      },
    });
    if (slots.length === 0) return;
    const allCandidates = slots.flatMap((s) => s.candidates);

    for (const e of stale) {
      if (!e.variantId) continue;
      const variantNum = gidToNumber(e.variantId);
      if (!Number.isFinite(variantNum)) continue;
      const positioned = slots.find((s) => s.position === e.slotPosition)?.candidates ?? [];
      const match =
        positioned.find((c) => gidToNumber(c.variantId) === variantNum) ??
        allCandidates.find((c) => gidToNumber(c.variantId) === variantNum);
      if (!match) continue;
      await prisma.offerCandidate.updateMany({
        where: { id: match.id },
        data:
          e.revenueShare === null
            ? { impressions: { increment: 1 } }
            : {
                accepts: { increment: 1 },
                revenue: {
                  increment: round2(Number.isFinite(e.revenueShare) ? e.revenueShare : 0),
                },
              },
      });
    }
  } catch (error) {
    console.warn(`[analytics] stale candidate counter fallback failed for ${shop}`, error);
  }
}

// Marsaglia–Tsang gamma sampler + Box–Muller gaussian, for Beta posteriors.

function sampleGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number): number {
  const k = Math.max(shape, 1e-6);
  if (k < 1) {
    // Boost: Gamma(k) = Gamma(k + 1) * U^(1/k)
    const u = Math.random();
    return sampleGamma(k + 1) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleGaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(a: number, b: number): number {
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  const sum = x + y;
  return sum > 0 ? x / sum : 0;
}

// ── Event ingestion ──────────────────────────────────────────────────────────

/**
 * Record an event sent by one of the extensions. Requires a matching
 * IssuedOffer for (referenceId, offerId) issued to this shop — anything else
 * is dropped (trust boundary), as are replays of an already-recorded
 * (referenceId, position, eventType). Denormalizes the stored meta into
 * OfferEvent rows (one row per product for "impression"/"accepted", one
 * aggregate row for "declined"/"error"), with revenue always computed from the
 * stored offer prices, bumps candidate bandit counters, upserts CustomerState
 * and flags the matching OrderRecord/OrderLine rows when the orders/create
 * webhook already landed. Never throws — analytics must not break the buyer
 * flow.
 */
export async function recordExtensionEvent(
  shop: string,
  payload: ExtensionEventPayload,
): Promise<void> {
  try {
    if (!payload || !payload.referenceId || !payload.eventType) return;
    const eventType = payload.eventType;
    if (!["impression", "accepted", "declined", "error"].includes(eventType)) return;
    const referenceId = String(payload.referenceId);
    const offerId = payload.offerId ? String(payload.offerId) : "";

    const issued = offerId
      ? await prisma.issuedOffer.findUnique({
          where: { referenceId_offerId: { referenceId, offerId } },
        })
      : null;
    // Trust boundary: only events matching an offer WE issued to THIS shop are
    // recorded. Unknown/missing offerId or a row issued to a different shop is
    // dropped entirely — no bare-event fallback.
    const valid = issued && issued.shop === shop ? issued : null;
    if (!valid) {
      console.warn(
        `[analytics] no IssuedOffer for ${shop} ref=${referenceId} offer=${offerId || "(none)"} — ignoring event`,
      );
      return;
    }

    const meta = jparse<IssuedOfferMeta>(valid.offerMetaJson, {});
    const discountPct = asFiniteNumber(meta.discountPct, 0);
    const products = parseMetaProducts(meta, discountPct);
    const candidateIds = parseCandidateIds(meta);
    const position = Math.max(1, Math.floor(asFiniteNumber(meta.position, 1)));
    const surface: string =
      (typeof meta.surface === "string" && meta.surface) ||
      payload.surface ||
      "post_purchase";
    const customerId =
      meta.customerId !== null && meta.customerId !== undefined && String(meta.customerId) !== ""
        ? String(meta.customerId)
        : null;
    const reportedRevenue =
      typeof payload.revenue === "number" && Number.isFinite(payload.revenue)
        ? payload.revenue
        : null;

    const base = {
      shop,
      referenceId,
      ruleId: meta.ruleId ?? null,
      customerId,
      position,
      discountPct,
      market: meta.market ?? null,
      country: meta.country ?? null,
      language: meta.language ?? null,
      surface,
    };

    if (eventType === "accepted" && reportedRevenue !== null) {
      // Client-reported revenue is never trusted — logged for debugging only;
      // revenue is always recomputed from the stored offer meta below.
      console.debug(
        `[analytics] client reported revenue ${reportedRevenue} for ${shop} ref=${referenceId} offer=${offerId} — using stored offer prices`,
      );
    }

    // Payment-pending marker: applyChangeset returned "partially_processed"
    // (order edited, charge FAILED — Shopify runs its own payment recovery).
    // The extension flags this via `message`; the flag can only ZERO revenue,
    // never set it, so unlike raw client revenue it is safe to honor. The
    // accept itself still counts (real conversion signal); only the money is
    // withheld until proven.
    const paymentPending =
      eventType === "accepted" && payload.message === "partially_processed";
    if (paymentPending) {
      console.warn(
        `[analytics] accepted with pending payment for ${shop} ref=${referenceId} — recording zero revenue`,
      );
    }

    // One row per offered product for impressions/accepts (so per-product
    // acceptance ratios and dimension breakdowns stay consistent, with exact
    // per-product revenue/GP attribution on accepts); a single row otherwise.
    const rows =
      (eventType === "impression" || eventType === "accepted") && products.length > 0
        ? products.map((p, i) => ({
            ...base,
            eventType,
            candidateId: candidateIds[i] ?? candidateIds[0] ?? null,
            productId: p.productId,
            variantId: p.variantId,
            revenue:
              eventType === "accepted" && !paymentPending ? round2(p.discountedPrice) : 0,
            grossProfit:
              eventType === "accepted" && !paymentPending ? round2(p.grossProfit) : 0,
          }))
        : [
            {
              ...base,
              eventType,
              candidateId: candidateIds[0] ?? null,
              productId: products[0]?.productId ?? null,
              variantId: products[0]?.variantId ?? null,
              revenue: 0,
              grossProfit: 0,
            },
          ];

    // Replay protection: at most one event of each type per offer page.
    // (referenceId, position) identifies the page — every page issued for a
    // reference carries its own position, and a re-issued page (Shop Pay
    // re-fetch) must dedupe anyway. The dedupe claim is taken through the
    // EventDedup unique constraint IN THE SAME TRANSACTION as the event rows:
    // concurrent duplicates cannot both pass, and a failed write releases the
    // claim instead of silently dropping the event forever.
    try {
      await prisma.$transaction([
        prisma.eventDedup.create({
          data: { shop, referenceId, position, eventType },
        }),
        prisma.offerEvent.createMany({ data: rows }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return; // duplicate (possibly concurrent) — already recorded
      }
      throw error;
    }

    // Bandit counters on the rotation candidates that were actually shown.
    // A rule re-save recreates candidate rows with new ids, so a shortfall in
    // updated counts means this offer references stale ids — fall back to
    // matching the rule's current candidates by variantId.
    if (candidateIds.length > 0) {
      if (eventType === "impression") {
        const updated = await prisma.offerCandidate.updateMany({
          where: { id: { in: candidateIds } },
          data: { impressions: { increment: 1 } },
        });
        if (updated.count < candidateIds.length) {
          await bumpStaleCandidateCounters(
            shop,
            meta.ruleId,
            candidateIds.map((cid, i) => ({
              candidateId: cid,
              variantId: products[i]?.variantId ?? null,
              slotPosition: candidateIds.length === 1 ? position : i + 1,
              revenueShare: null,
            })),
          );
        }
      } else if (eventType === "accepted") {
        const totalRevenue = products.reduce((sum, p) => sum + p.discountedPrice, 0);
        const shareAt = (i: number): number => {
          if (paymentPending) return 0; // charge failed — accept counts, money doesn't
          const share = products[i]?.discountedPrice ?? totalRevenue / candidateIds.length;
          return Number.isFinite(share) ? share : 0;
        };
        const results = await Promise.all(
          candidateIds.map((cid, i) =>
            prisma.offerCandidate.updateMany({
              where: { id: cid },
              data: {
                accepts: { increment: 1 },
                revenue: { increment: round2(shareAt(i)) },
              },
            }),
          ),
        );
        if (results.some((r) => r.count === 0)) {
          await bumpStaleCandidateCounters(
            shop,
            meta.ruleId,
            candidateIds.flatMap((cid, i) =>
              results[i].count > 0
                ? []
                : [
                    {
                      candidateId: cid,
                      variantId: products[i]?.variantId ?? null,
                      slotPosition: candidateIds.length === 1 ? position : i + 1,
                      revenueShare: shareAt(i),
                    },
                  ],
            ),
          );
        }
      }
    }

    // Frequency-cap state. offersShown counts checkout flows, so it only
    // increments on the first page's impression.
    if (customerId) {
      if (eventType === "impression" && position === 1) {
        await prisma.customerState.upsert({
          where: { shop_customerId: { shop, customerId } },
          create: { shop, customerId, lastOfferAt: new Date(), offersShown: 1 },
          update: { lastOfferAt: new Date(), offersShown: { increment: 1 } },
        });
      } else if (eventType === "accepted") {
        await prisma.customerState.upsert({
          where: { shop_customerId: { shop, customerId } },
          create: { shop, customerId, lastOfferAt: new Date(), offersShown: 1, offersAccepted: 1 },
          update: { offersAccepted: { increment: 1 } },
        });
      }
    }

    // orders/create fires BEFORE the buyer accepts, so the webhook usually
    // cannot see these events yet — flag the matching OrderRecord from the
    // event side too (recordOrderFromWebhook keeps its own matching for the
    // reverse race: accept recorded before the webhook arrives).
    if (eventType === "impression" || eventType === "accepted") {
      const refNum = gidToNumber(referenceId);
      if (Number.isFinite(refNum)) {
        const orderCandidates = await prisma.orderRecord.findMany({
          where: { shop, orderId: { endsWith: String(refNum) } },
          select: { id: true, orderId: true },
        });
        const order = orderCandidates.find((o) => gidToNumber(o.orderId) === refNum);
        if (order) {
          await prisma.orderRecord.update({
            where: { id: order.id },
            data:
              eventType === "accepted"
                ? { hadUpsellOffer: true, acceptedUpsell: true }
                : { hadUpsellOffer: true },
            // read back nothing — survives a database without the v1.9 columns
            select: { id: true },
          });
          if (eventType === "accepted") {
            await prisma.offerEvent.updateMany({
              where: { shop, referenceId, orderId: null },
              data: { orderId: order.orderId },
            });
            const acceptedVariantNums = new Set<number>();
            for (const p of products) {
              if (!p.variantId) continue;
              const n = gidToNumber(p.variantId);
              if (Number.isFinite(n)) acceptedVariantNums.add(n);
            }
            if (acceptedVariantNums.size > 0) {
              const orderLines = await prisma.orderLine.findMany({
                where: { orderRecordId: order.id },
                select: { id: true, variantId: true },
              });
              const upsellLineIds = orderLines
                .filter(
                  (l) => l.variantId !== null && acceptedVariantNums.has(gidToNumber(l.variantId)),
                )
                .map((l) => l.id);
              if (upsellLineIds.length > 0) {
                await prisma.orderLine.updateMany({
                  where: { id: { in: upsellLineIds } },
                  data: { isUpsell: true },
                });
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`[analytics] recordExtensionEvent failed for ${shop}`, error);
  }
}

// ── Order ingestion (orders/create webhook) ─────────────────────────────────

/**
 * Upsert an OrderRecord (+ lines) from a REST orders/create payload and match
 * it against offer events: any event whose referenceId's numeric part equals
 * the order id (or whose orderId already matches) marks the order as having
 * had an upsell offer; accepted events flip `acceptedUpsell`, mark matching
 * lines `isUpsell` (variant match) and get their `orderId` backfilled.
 */
let warnedMissingOrderColumns = false;
function warnMissingOrderColumnsOnce(error: unknown): void {
  if (warnedMissingOrderColumns) return;
  warnedMissingOrderColumns = true;
  console.warn(
    "[analytics] OrderRecord is missing the v1.9 columns (checkoutToken/gateway/presentment/sourceName) — orders are stored WITHOUT eligibility annotations until `npx prisma db push` runs on this deployment.",
    error instanceof Error ? error.message : error,
  );
}

/** Prisma P2022 (column does not exist) or the raw driver message for it. */
function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2022" || code === "P2021") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /does not exist|no such column|Unknown column|has no column named/i.test(msg);
}

export async function recordOrderFromWebhook(shop: string, payload: any): Promise<void> {
  try {
    // Shopify test orders (test gateway / bogus payments) must not pollute
    // CLV cohorts, product affinity or suppression — skip them entirely.
    if (payload?.test === true) {
      console.debug(
        `[analytics] ignoring test order ${payload?.id ?? "(no id)"} for ${shop}`,
      );
      return;
    }
    const rawId = payload?.id;
    if (rawId === undefined || rawId === null || String(rawId) === "") return;
    const orderId = String(rawId);
    const orderIdNum = Number(orderId);

    const customerId =
      payload?.customer?.id !== undefined && payload?.customer?.id !== null
        ? String(payload.customer.id)
        : null;
    const totalPrice = asFiniteNumber(payload?.total_price, 0);
    const currency =
      typeof payload?.currency === "string" && payload.currency ? payload.currency : "EUR";
    const country =
      payload?.shipping_address?.country_code ??
      payload?.billing_address?.country_code ??
      null;
    const createdAtRaw = payload?.created_at ? new Date(payload.created_at) : new Date();
    const createdAt = Number.isNaN(createdAtRaw.getTime()) ? new Date() : createdAtRaw;
    // Post-purchase eligibility annotations (v1.9, see OrderRecord in schema).
    const checkoutToken =
      typeof payload?.checkout_token === "string" && payload.checkout_token
        ? payload.checkout_token.slice(0, 64)
        : null;
    const gateway = Array.isArray(payload?.payment_gateway_names)
      ? payload.payment_gateway_names.map((g: unknown) => String(g)).join(", ").slice(0, 120) || null
      : typeof payload?.gateway === "string" && payload.gateway
        ? String(payload.gateway).slice(0, 120)
        : null;
    const presentment =
      typeof payload?.presentment_currency === "string" && payload.presentment_currency
        ? payload.presentment_currency.slice(0, 8)
        : null;
    const sourceName =
      typeof payload?.source_name === "string" && payload.source_name
        ? payload.source_name.slice(0, 40)
        : null;

    // Match offer events by orderId or by the numeric part of referenceId
    // (post-purchase referenceIds are the numeric order id; thank-you ones are
    // "typ:<orderId>"). endsWith narrows the scan; exact numeric match below.
    const candidates = await prisma.offerEvent.findMany({
      where: {
        shop,
        OR: [{ orderId }, { referenceId: { endsWith: orderId } }],
      },
      select: { id: true, eventType: true, variantId: true, orderId: true, referenceId: true },
    });
    const matched = candidates.filter(
      (e) =>
        e.orderId === orderId ||
        (Number.isFinite(orderIdNum) && gidToNumber(e.referenceId) === orderIdNum),
    );

    const hadUpsellOffer = matched.length > 0;
    const acceptedEvents = matched.filter((e) => e.eventType === "accepted");
    const acceptedUpsell = acceptedEvents.length > 0;
    const acceptedVariantNums = new Set<number>();
    for (const e of acceptedEvents) {
      if (!e.variantId) continue;
      const n = gidToNumber(e.variantId);
      if (Number.isFinite(n)) acceptedVariantNums.add(n);
    }

    const rawLines: any[] = Array.isArray(payload?.line_items) ? payload.line_items : [];
    const lines = rawLines
      .filter((li) => li?.product_id !== undefined && li?.product_id !== null)
      .map((li) => {
        const variantNum =
          li?.variant_id !== undefined && li?.variant_id !== null
            ? Number(li.variant_id)
            : null;
        return {
          productId: `gid://shopify/Product/${String(li.product_id)}`,
          variantId: variantNum !== null ? `gid://shopify/ProductVariant/${variantNum}` : null,
          title: typeof li?.title === "string" ? li.title : "",
          quantity: Math.max(1, Math.floor(asFiniteNumber(li?.quantity, 1))),
          price: asFiniteNumber(li?.price, 0),
          isUpsell: variantNum !== null && acceptedVariantNums.has(variantNum),
        };
      });

    const baseCreate = { shop, orderId, customerId, totalPrice, currency, country, hadUpsellOffer, acceptedUpsell, createdAt };
    const baseUpdate = { customerId, totalPrice, currency, country, hadUpsellOffer, acceptedUpsell };
    // v1.9 eligibility annotations. orders/updated redeliveries carry the same
    // values; never blank a value we already have with a null from a partial
    // payload.
    const annotationsCreate = { checkoutToken, gateway, presentment, sourceName };
    const annotationsUpdate = {
      ...(checkoutToken ? { checkoutToken } : {}),
      ...(gateway ? { gateway } : {}),
      ...(presentment ? { presentment } : {}),
      ...(sourceName ? { sourceName } : {}),
    };
    // `select: { id }` on BOTH writes: Prisma reads back every scalar of the
    // model after a write, so without it even the fallback below would fail
    // with P2022 on a database that lacks the v1.9 columns (verified against a
    // v1.8-shaped SQLite file). Only the id is used afterwards.
    let record: { id: string };
    try {
      record = await prisma.orderRecord.upsert({
        where: { shop_orderId: { shop, orderId } },
        create: { ...baseCreate, ...annotationsCreate },
        update: { ...baseUpdate, ...annotationsUpdate },
        select: { id: true },
      });
    } catch (error) {
      // A deployment that skipped `prisma db push` has no v1.9 columns yet:
      // an order must NEVER be dropped because of diagnostics columns — store
      // it without them and let the env.database health check shout.
      if (!isMissingColumnError(error)) throw error;
      warnMissingOrderColumnsOnce(error);
      record = await prisma.orderRecord.upsert({
        where: { shop_orderId: { shop, orderId } },
        create: baseCreate,
        update: baseUpdate,
        select: { id: true },
      });
    }

    // Replace lines idempotently (webhooks may be redelivered).
    await prisma.orderLine.deleteMany({ where: { orderRecordId: record.id } });
    if (lines.length > 0) {
      await prisma.orderLine.createMany({
        data: lines.map((l) => ({ ...l, orderRecordId: record.id })),
      });
    }

    // Backfill OfferEvent.orderId on every matched event that lacks it.
    const backfillIds = matched.filter((e) => !e.orderId).map((e) => e.id);
    if (backfillIds.length > 0) {
      await prisma.offerEvent.updateMany({
        where: { id: { in: backfillIds } },
        data: { orderId },
      });
    }
  } catch (error) {
    console.error(`[analytics] recordOrderFromWebhook failed for ${shop}`, error);
  }
}

// ── Payment-recovery revenue backfill (orders/updated webhook) ───────────────

/**
 * Revenue-only bandit counter restore for backfillPendingRevenue. The accept
 * itself was already counted when the buyer accepted (the payment-pending
 * marker only withholds the money), so ONLY `revenue` is incremented — never
 * `accepts`. Direct increment when the candidate id still exists; when a rule
 * re-save recreated the candidate rows (stale id), fall back to the rule's
 * CURRENT candidate whose variantId numeric part matches, preferring the slot
 * at the expected position — the same matching the stale-candidate helper
 * uses. Never throws.
 */
async function bumpCandidateRevenueOnly(
  shop: string,
  ruleId: string | null | undefined,
  candidateId: string | null | undefined,
  variantId: string | null | undefined,
  slotPosition: number,
  delta: number,
): Promise<void> {
  if (!Number.isFinite(delta) || delta <= 0) return;
  try {
    if (candidateId) {
      const updated = await prisma.offerCandidate.updateMany({
        where: { id: candidateId },
        data: { revenue: { increment: round2(delta) } },
      });
      if (updated.count > 0) return;
    }
    if (!ruleId || !variantId) return;
    const variantNum = gidToNumber(variantId);
    if (!Number.isFinite(variantNum)) return;
    const slots = await prisma.offerSlot.findMany({
      where: { ruleId, rule: { shop } },
      orderBy: { position: "asc" },
      select: {
        position: true,
        candidates: { select: { id: true, variantId: true } },
      },
    });
    if (slots.length === 0) return;
    const positioned = slots.find((s) => s.position === slotPosition)?.candidates ?? [];
    const match =
      positioned.find((c) => gidToNumber(c.variantId) === variantNum) ??
      slots.flatMap((s) => s.candidates).find((c) => gidToNumber(c.variantId) === variantNum);
    if (!match) return;
    await prisma.offerCandidate.updateMany({
      where: { id: match.id },
      data: { revenue: { increment: round2(delta) } },
    });
  } catch (error) {
    console.warn(`[analytics] candidate revenue backfill failed for ${shop}`, error);
  }
}

/**
 * Payment-recovery reconciliation, driven by the orders/updated webhook when
 * `financial_status` reaches "paid". An accepted post-purchase upsell whose
 * changeset charge FAILED ("partially_processed") was recorded with zero
 * revenue — the accept counted, the money was withheld (see the
 * payment-pending marker in recordExtensionEvent). Shopify runs its own
 * payment recovery on such orders; once the order is actually paid, this
 * restores the withheld revenue/grossProfit on those zero-revenue accepted
 * OfferEvent rows and mirrors the same delta into the matching
 * OfferCandidate.revenue counters.
 *
 * Values are restored from the IssuedOffer meta products (exact
 * discounted-price / gross-profit recomputation) when the row still exists;
 * when it was already pruned, from the order's own line_items price for the
 * line whose variant_id numeric tail matches the event's variantId (gross
 * profit then falls back to the default unit-cost ratio).
 *
 * ORDERS_UPDATED fires on every order edit, so the common path must be cheap:
 * one indexed query, exiting immediately when no zero-revenue accepted rows
 * match this order. Idempotent — restored rows no longer match the
 * zero-revenue filter, so redeliveries are no-ops. Never throws.
 */
export async function backfillPendingRevenue(shop: string, payload: any): Promise<void> {
  try {
    // Order id numeric tail: REST `id` preferred, admin_graphql_api_id gid
    // fallback ("gid://shopify/Order/123" → 123).
    const restNum = gidToNumber(String(payload?.id ?? ""));
    const gidNum = gidToNumber(String(payload?.admin_graphql_api_id ?? ""));
    const orderNum = Number.isFinite(restNum) ? restNum : gidNum;
    if (!Number.isFinite(orderNum)) return;
    const orderKey = String(orderNum);

    // Fast exit: match accepted zero-revenue events by orderId or by the
    // numeric part of referenceId (post-purchase referenceIds are the numeric
    // order id). endsWith narrows the scan; exact numeric match below.
    const candidates = await prisma.offerEvent.findMany({
      where: {
        shop,
        eventType: "accepted",
        revenue: 0,
        OR: [{ orderId: { endsWith: orderKey } }, { referenceId: { endsWith: orderKey } }],
      },
      select: {
        id: true,
        referenceId: true,
        orderId: true,
        position: true,
        ruleId: true,
        candidateId: true,
        variantId: true,
      },
    });
    const rows = candidates.filter(
      (e) =>
        (e.orderId !== null && gidToNumber(e.orderId) === orderNum) ||
        gidToNumber(e.referenceId) === orderNum,
    );
    if (rows.length === 0) return;

    // Primary value source: the IssuedOffer meta products for each event's
    // page — the same numbers recordExtensionEvent would have written had the
    // charge succeeded. Keyed by (referenceId, page position).
    const refIds = [...new Set(rows.map((e) => e.referenceId))];
    const issuedRows = await prisma.issuedOffer.findMany({
      where: { shop, referenceId: { in: refIds } },
      select: { referenceId: true, offerMetaJson: true },
    });
    const metaByPage = new Map<string, MetaProduct[]>();
    for (const issued of issuedRows) {
      const meta = jparse<IssuedOfferMeta>(issued.offerMetaJson, {});
      const discountPct = asFiniteNumber(meta.discountPct, 0);
      const products = parseMetaProducts(meta, discountPct);
      if (products.length === 0) continue;
      const position = Math.max(1, Math.floor(asFiniteNumber(meta.position, 1)));
      metaByPage.set(`${issued.referenceId}|${position}`, products);
    }

    // Fallback value source: the order's own line prices by variant numeric
    // tail (used when the IssuedOffer row was already pruned).
    const linePriceByVariant = new Map<number, number>();
    const rawLines: any[] = Array.isArray(payload?.line_items) ? payload.line_items : [];
    for (const li of rawLines) {
      const variantNum = gidToNumber(String(li?.variant_id ?? ""));
      if (!Number.isFinite(variantNum) || linePriceByVariant.has(variantNum)) continue;
      const price = asFiniteNumber(li?.price, Number.NaN);
      if (Number.isFinite(price) && price > 0) linePriceByVariant.set(variantNum, price);
    }

    let backfilled = 0;
    let totalRevenue = 0;
    for (const event of rows) {
      const variantNum = event.variantId ? gidToNumber(event.variantId) : Number.NaN;
      let revenue: number | null = null;
      let grossProfit = 0;

      const products = metaByPage.get(`${event.referenceId}|${event.position ?? 1}`);
      const metaMatch =
        products && Number.isFinite(variantNum)
          ? products.find(
              (p) => p.variantId !== null && gidToNumber(p.variantId) === variantNum,
            )
          : undefined;
      if (metaMatch) {
        revenue = round2(metaMatch.discountedPrice);
        grossProfit = round2(metaMatch.grossProfit);
      } else if (Number.isFinite(variantNum)) {
        const linePrice = linePriceByVariant.get(variantNum);
        if (linePrice !== undefined) {
          revenue = round2(linePrice);
          grossProfit = round2(linePrice * (1 - DEFAULT_UNIT_COST_RATIO));
        }
      }
      if (revenue === null || revenue <= 0) continue;

      await prisma.offerEvent.update({
        where: { id: event.id },
        data: { revenue, grossProfit },
      });
      await bumpCandidateRevenueOnly(
        shop,
        event.ruleId,
        event.candidateId,
        event.variantId,
        event.position ?? 1,
        revenue,
      );
      backfilled += 1;
      totalRevenue += revenue;
    }

    if (backfilled > 0) {
      console.log(
        `[analytics] payment recovery for ${shop} order ${orderKey}: backfilled ${backfilled} accepted event(s), ${round2(totalRevenue)} revenue restored`,
      );
    }
  } catch (error) {
    console.error(`[analytics] backfillPendingRevenue failed for ${shop}`, error);
  }
}

// ── Dashboard KPIs ───────────────────────────────────────────────────────────

export async function getDashboardStats(shop: string, days: number): Promise<DashboardStats> {
  const gte = windowStart(days);
  const where = { shop, createdAt: { gte } };

  const [impressionPages, declines, acceptedPages, latestOrder] = await Promise.all([
    // Impressions and acceptances are stored one row per offered product —
    // group by page (referenceId, position) so both KPIs count pages, not
    // rows, while the accepted group sums still add up to true revenue/GP.
    prisma.offerEvent.groupBy({
      by: ["referenceId", "position"],
      where: { ...where, eventType: "impression" },
    }),
    prisma.offerEvent.count({ where: { ...where, eventType: "declined" } }),
    prisma.offerEvent.groupBy({
      by: ["referenceId", "position"],
      where: { ...where, eventType: "accepted" },
      _sum: { revenue: true, grossProfit: true },
    }),
    prisma.orderRecord.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { currency: true },
    }),
  ]);

  const impressions = impressionPages.length;
  const accepts = acceptedPages.length;
  let upsellRevenue = 0;
  let upsellGrossProfit = 0;
  for (const g of acceptedPages) {
    upsellRevenue += g._sum.revenue ?? 0;
    upsellGrossProfit += g._sum.grossProfit ?? 0;
  }
  const distinctRefs = new Set(impressionPages.map((g) => g.referenceId)).size;

  return {
    impressions,
    accepts,
    declines,
    acceptanceRate: accepts / Math.max(1, impressions),
    upsellRevenue: round2(upsellRevenue),
    upsellGrossProfit: round2(upsellGrossProfit),
    gpPerImpression: round2(upsellGrossProfit / Math.max(1, impressions)),
    offersPerOrderShown: round2(impressions / Math.max(1, distinctRefs)),
    currency: latestOrder?.currency ?? "EUR",
  };
}

// ── Time series (zero-filled days, ISO date keys) ───────────────────────────

export async function getTimeSeries(
  shop: string,
  days: number,
): Promise<Array<{ date: string; impressions: number; accepts: number; revenue: number; grossProfit: number }>> {
  const d = clampDays(days);
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = todayUtcMs - (d - 1) * MS_PER_DAY;

  // Pre-fill every day with zeros so charts get a continuous series.
  const buckets = new Map<
    string,
    { date: string; impressions: number; accepts: number; revenue: number; grossProfit: number }
  >();
  for (let i = 0; i < d; i++) {
    const date = new Date(startMs + i * MS_PER_DAY).toISOString().slice(0, 10);
    buckets.set(date, { date, impressions: 0, accepts: 0, revenue: 0, grossProfit: 0 });
  }

  // Day bucketing isn't expressible in Prisma groupBy portably — bounded
  // in-memory aggregation over a minimal projection instead.
  const events = await prisma.offerEvent.findMany({
    where: {
      shop,
      createdAt: { gte: new Date(startMs) },
      eventType: { in: ["impression", "accepted"] },
    },
    select: {
      createdAt: true,
      eventType: true,
      revenue: true,
      grossProfit: true,
      referenceId: true,
      position: true,
    },
    orderBy: { createdAt: "asc" },
    take: MAX_EVENT_SCAN,
  });

  const seenImpressionPages = new Set<string>();
  const seenAcceptedPages = new Set<string>();
  for (const e of events) {
    const bucket = buckets.get(e.createdAt.toISOString().slice(0, 10));
    if (!bucket) continue;
    const pageKey = `${e.referenceId}|${e.position ?? 0}`;
    if (e.eventType === "impression") {
      // impressions are stored one row per offered product — count each offer
      // page once.
      if (!seenImpressionPages.has(pageKey)) {
        seenImpressionPages.add(pageKey);
        bucket.impressions += 1;
      }
    } else {
      // accepted: revenue/GP add up across per-product rows, but the accept
      // itself is counted once per offer page.
      bucket.revenue = round2(bucket.revenue + e.revenue);
      bucket.grossProfit = round2(bucket.grossProfit + e.grossProfit);
      if (!seenAcceptedPages.has(pageKey)) {
        seenAcceptedPages.add(pageKey);
        bucket.accepts += 1;
      }
    }
  }

  return [...buckets.values()];
}

// ── Per-offer performance ────────────────────────────────────────────────────

export async function getOfferPerformance(shop: string, days: number): Promise<OfferPerfRow[]> {
  const gte = windowStart(days);

  const groups = await prisma.offerEvent.groupBy({
    by: ["productId", "surface", "eventType"],
    where: { shop, createdAt: { gte }, productId: { not: null } },
    _count: { _all: true },
    _sum: { revenue: true, grossProfit: true, discountPct: true },
  });

  interface Acc {
    productId: string;
    surface: string;
    impressions: number;
    accepts: number;
    revenue: number;
    grossProfit: number;
    discountSum: number;
    rowCount: number;
  }
  const byKey = new Map<string, Acc>();
  for (const g of groups) {
    if (!g.productId) continue;
    const key = `${g.productId}|${g.surface}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        productId: g.productId,
        surface: g.surface,
        impressions: 0,
        accepts: 0,
        revenue: 0,
        grossProfit: 0,
        discountSum: 0,
        rowCount: 0,
      };
      byKey.set(key, acc);
    }
    const count = g._count._all;
    if (g.eventType === "impression") acc.impressions += count;
    else if (g.eventType === "accepted") acc.accepts += count;
    acc.revenue += g._sum.revenue ?? 0;
    acc.grossProfit += g._sum.grossProfit ?? 0;
    acc.discountSum += g._sum.discountPct ?? 0;
    acc.rowCount += count;
  }

  const productIds = [...new Set([...byKey.values()].map((a) => a.productId))];
  const titles = new Map<string, string>();
  if (productIds.length > 0) {
    const cached = await prisma.productCache.findMany({
      where: { shop, productId: { in: productIds } },
      select: { productId: true, title: true },
    });
    for (const p of cached) titles.set(p.productId, p.title);
  }

  const rows: OfferPerfRow[] = [...byKey.values()].map((a) => ({
    productId: a.productId,
    title: titles.get(a.productId) ?? a.productId,
    surface: a.surface,
    impressions: a.impressions,
    accepts: a.accepts,
    acceptanceRate: a.accepts / Math.max(1, a.impressions),
    revenue: round2(a.revenue),
    grossProfit: round2(a.grossProfit),
    gpPerImpression: round2(a.grossProfit / Math.max(1, a.impressions)),
    avgDiscountPct: round2(a.discountSum / Math.max(1, a.rowCount)),
  }));

  rows.sort(
    (x, y) => y.revenue - x.revenue || y.accepts - x.accepts || y.impressions - x.impressions,
  );
  return rows;
}

// ── Dimensional breakdowns ───────────────────────────────────────────────────

export async function getBreakdown(
  shop: string,
  days: number,
  dim: "country" | "language" | "market" | "surface",
): Promise<Array<{ key: string; impressions: number; accepts: number; acceptanceRate: number; revenue: number }>> {
  const gte = windowStart(days);

  // Impressions and accepts are stored one row PER offered product, so
  // counting raw rows would inflate bundle offers k× against the page-deduped
  // dashboard KPIs. Fetch a minimal projection and page-dedupe in memory with
  // a referenceId|position set per eventType per dimension key (the same
  // technique getTimeSeries uses); revenue still sums across per-product rows.
  const events = await prisma.offerEvent.findMany({
    where: {
      shop,
      createdAt: { gte },
      eventType: { in: ["impression", "accepted"] },
    },
    select: {
      eventType: true,
      revenue: true,
      referenceId: true,
      position: true,
      country: true,
      language: true,
      market: true,
      surface: true,
    },
    take: MAX_EVENT_SCAN,
  });

  const byKey = new Map<
    string,
    { key: string; impressions: number; accepts: number; revenue: number }
  >();
  const seenPages = new Map<string, Set<string>>(); // `${eventType}|${key}` → pages
  for (const e of events) {
    const key = String(e[dim] ?? "unknown");
    let acc = byKey.get(key);
    if (!acc) {
      acc = { key, impressions: 0, accepts: 0, revenue: 0 };
      byKey.set(key, acc);
    }
    if (e.eventType === "accepted") acc.revenue += e.revenue;
    const seenKey = `${e.eventType}|${key}`;
    let pages = seenPages.get(seenKey);
    if (!pages) {
      pages = new Set<string>();
      seenPages.set(seenKey, pages);
    }
    const pageKey = `${e.referenceId}|${e.position ?? 0}`;
    if (pages.has(pageKey)) continue;
    pages.add(pageKey);
    if (e.eventType === "impression") acc.impressions += 1;
    else acc.accepts += 1;
  }

  return [...byKey.values()]
    .map((a) => ({
      key: a.key,
      impressions: a.impressions,
      accepts: a.accepts,
      acceptanceRate: a.accepts / Math.max(1, a.impressions),
      revenue: round2(a.revenue),
    }))
    .sort((x, y) => y.impressions - x.impressions || y.revenue - x.revenue);
}

// ── Experiment results (Thompson-sampling posteriors) ───────────────────────

export async function getExperimentResults(shop: string): Promise<ExperimentRow[]> {
  const rules = await prisma.offerRule.findMany({
    where: { shop },
    orderBy: { priority: "asc" },
    include: {
      slots: { orderBy: { position: "asc" }, include: { candidates: true } },
    },
  });

  // Only ENABLED candidates count as an experiment — disabled ones never
  // rotate (selectOffers skips them and autoPickWinners ignores them), so the
  // admin table must mirror live behavior: a slot is contested only when ≥2
  // candidates are enabled, and posteriors are computed over those alone.
  const productIds = new Set<string>();
  for (const rule of rules) {
    for (const slot of rule.slots) {
      const enabled = slot.candidates.filter((c) => c.enabled);
      if (enabled.length < 2) continue;
      for (const c of enabled) productIds.add(c.productId);
    }
  }
  const titles = new Map<string, string>();
  if (productIds.size > 0) {
    const cached = await prisma.productCache.findMany({
      where: { shop, productId: { in: [...productIds] } },
      select: { productId: true, title: true },
    });
    for (const p of cached) titles.set(p.productId, p.title);
  }

  const rows: ExperimentRow[] = [];
  for (const rule of rules) {
    for (const slot of rule.slots) {
      const enabled = slot.candidates.filter((c) => c.enabled);
      if (enabled.length < 2) continue;

      // Monte-Carlo P(best): Beta(accepts+1, impressions−accepts+1) posterior
      // per candidate, 2000 joint draws, count wins.
      const params = enabled.map((c) => ({
        a: c.accepts + 1,
        b: Math.max(0, c.impressions - c.accepts) + 1,
      }));
      const wins = new Array<number>(enabled.length).fill(0);
      for (let draw = 0; draw < MONTE_CARLO_DRAWS; draw++) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (let i = 0; i < params.length; i++) {
          const v = sampleBeta(params[i].a, params[i].b);
          if (v > bestVal) {
            bestVal = v;
            bestIdx = i;
          }
        }
        wins[bestIdx] += 1;
      }

      const slotRows = enabled.map((c, i) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        slotPosition: slot.position,
        candidateId: c.id,
        productTitle: titles.get(c.productId) ?? c.productId,
        impressions: c.impressions,
        accepts: c.accepts,
        acceptanceRate: c.accepts / Math.max(1, c.impressions),
        revenue: round2(c.revenue),
        probBest: wins[i] / MONTE_CARLO_DRAWS,
        isWinner: c.isWinner,
      }));
      slotRows.sort((x, y) => y.probBest - x.probBest);
      rows.push(...slotRows);
    }
  }
  return rows;
}

// ── CLV cohorts ──────────────────────────────────────────────────────────────

/**
 * 60/90-day CLV cohorts. Customers whose FIRST offer event is at least
 * `windowDays` old are cohorted by whether they ever accepted an offer
 * ("accepted") or only saw offers ("declined"); customers with orders but no
 * offer events form the "not_shown" baseline. Follow-on value is the sum of
 * their order totals within `windowDays` after the first event (or after
 * their first order for "not_shown"), excluding the triggering order.
 */
export async function getClvCohorts(
  shop: string,
  windowDays: number,
): Promise<Array<{ cohort: "accepted" | "declined" | "not_shown"; customers: number; avgFollowOnRevenue: number; avgFollowOnOrders: number }>> {
  const window = Math.max(1, Math.floor(Number.isFinite(windowDays) ? windowDays : 60));
  const windowMs = window * MS_PER_DAY;
  const cutoff = new Date(Date.now() - windowMs);

  const events = await prisma.offerEvent.findMany({
    where: { shop, customerId: { not: null } },
    select: {
      customerId: true,
      createdAt: true,
      eventType: true,
      orderId: true,
      referenceId: true,
    },
    orderBy: { createdAt: "asc" },
    take: MAX_EVENT_SCAN,
  });

  interface FirstTouch {
    firstAt: Date;
    accepted: boolean;
    trigOrderId: string | null;
  }
  const eventsByCustomer = new Map<string, FirstTouch>();
  for (const e of events) {
    const cid = e.customerId;
    if (!cid) continue;
    let cur = eventsByCustomer.get(cid);
    if (!cur) {
      const numeric = gidToNumber(e.referenceId);
      cur = {
        firstAt: e.createdAt,
        accepted: false,
        trigOrderId: e.orderId ?? (Number.isFinite(numeric) ? String(numeric) : null),
      };
      eventsByCustomer.set(cid, cur);
    }
    if (e.eventType === "accepted") cur.accepted = true;
  }

  const orders = await prisma.orderRecord.findMany({
    where: { shop, customerId: { not: null } },
    select: { customerId: true, orderId: true, totalPrice: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: MAX_ORDER_SCAN,
  });
  const ordersByCustomer = new Map<
    string,
    Array<{ orderId: string; totalPrice: number; createdAt: Date }>
  >();
  for (const o of orders) {
    const cid = o.customerId;
    if (!cid) continue;
    const list = ordersByCustomer.get(cid);
    const entry = { orderId: o.orderId, totalPrice: o.totalPrice, createdAt: o.createdAt };
    if (list) list.push(entry);
    else ordersByCustomer.set(cid, [entry]);
  }

  const totals: Record<
    "accepted" | "declined" | "not_shown",
    { customers: number; revenue: number; orders: number }
  > = {
    accepted: { customers: 0, revenue: 0, orders: 0 },
    declined: { customers: 0, revenue: 0, orders: 0 },
    not_shown: { customers: 0, revenue: 0, orders: 0 },
  };

  // Offer-exposed customers with a complete observation window.
  for (const [cid, touch] of eventsByCustomer) {
    if (touch.firstAt > cutoff) continue;
    const cohort = touch.accepted ? "accepted" : "declined";
    const windowEndMs = touch.firstAt.getTime() + windowMs;
    let revenue = 0;
    let count = 0;
    for (const o of ordersByCustomer.get(cid) ?? []) {
      if (touch.trigOrderId !== null && o.orderId === touch.trigOrderId) continue;
      // When the triggering order id is unknown, skip orders landing within
      // 10 minutes of the first event — that is the triggering checkout
      // arriving via the (slightly delayed) orders/create webhook.
      if (
        touch.trigOrderId === null &&
        Math.abs(o.createdAt.getTime() - touch.firstAt.getTime()) <= 10 * 60 * 1000
      ) {
        continue;
      }
      const t = o.createdAt.getTime();
      if (t > touch.firstAt.getTime() && t <= windowEndMs) {
        revenue += o.totalPrice;
        count += 1;
      }
    }
    totals[cohort].customers += 1;
    totals[cohort].revenue += revenue;
    totals[cohort].orders += count;
  }

  // Baseline: customers with orders but no offer events at all.
  for (const [cid, list] of ordersByCustomer) {
    if (eventsByCustomer.has(cid)) continue;
    const first = list[0];
    if (!first || first.createdAt > cutoff) continue;
    const windowEndMs = first.createdAt.getTime() + windowMs;
    let revenue = 0;
    let count = 0;
    for (const o of list) {
      if (o.orderId === first.orderId) continue;
      const t = o.createdAt.getTime();
      if (t > first.createdAt.getTime() && t <= windowEndMs) {
        revenue += o.totalPrice;
        count += 1;
      }
    }
    totals.not_shown.customers += 1;
    totals.not_shown.revenue += revenue;
    totals.not_shown.orders += count;
  }

  return (["accepted", "declined", "not_shown"] as const).map((cohort) => {
    const t = totals[cohort];
    return {
      cohort,
      customers: t.customers,
      avgFollowOnRevenue: t.customers > 0 ? round2(t.revenue / t.customers) : 0,
      avgFollowOnOrders: t.customers > 0 ? round2(t.orders / t.customers) : 0,
    };
  });
}

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * Serialize rows to RFC-4180-style CSV. Columns are the union of all row keys
 * (first-seen order). Values containing commas, quotes or newlines are quoted
 * with internal quotes doubled; null/undefined become empty cells.
 */
export async function toCsv(rows: Array<Record<string, unknown>>): Promise<string> {
  if (rows.length === 0) return "";

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const escapeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let s: string;
    if (value instanceof Date) s = value.toISOString();
    else if (typeof value === "object") s = JSON.stringify(value);
    else s = String(value);
    // Neutralize spreadsheet formula injection: a leading =, +, -, @, tab or
    // CR would otherwise be evaluated by Excel/Sheets on import.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines: string[] = [columns.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\n");
}
