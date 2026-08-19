// ShouldRender inquiry log — one row per /api/offer call (see OfferInquiry in
// prisma/schema.prisma). This is the record that separates the three worlds
// a merchant cannot tell apart from the thank-you page alone:
//
//   1. Shopify never calls us (rows = 0 while orders flow) → the Shopify-side
//      gate: post-purchase flag / app selection / payment method / currency.
//   2. Shopify calls us and we decline (offers = 0) → `emptyReason` names the
//      engine step (frequency cap, suppression, market off, empty pool …).
//   3. We issue pages (offers > 0) but nothing shows → Shopify's receipt-side
//      rules (card vaulting, wallet, 3-D Secure, order-creation delay) or the
//      extension bundle (stale APP_URL) — see docs/IMPLEMENTATION_GUIDE.md §27.
//
// Writes are fire-and-forget and swallow every error: the request path must
// never wait on or fail because of this table (a missing table on a
// deployment that skipped `prisma db push` degrades to a single WARN line).

import prisma from "../db.server";
import { APP_VERSION } from "../lib/version";

export const INQUIRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type OfferInquiryInput = {
  shop: string;
  referenceId: string;
  surface?: string;
  countryCode: string | null;
  currency: string | null;
  presentment: string | null;
  customerId: string | null;
  lines: number;
  totalAmount: number;
  totalSource: "total" | "lines" | "none";
  offers: number;
  corePending: boolean;
  emptyReason: string | null;
  tookMs: number;
};

/**
 * Engine reasons name the customer ("step2: frequency cap — customer 123 …")
 * and carry ISO timestamps; strip both before anything is stored or shown so
 * the only personal datum in this table is the customerId column (which the
 * GDPR customers/redact hook nulls) and so identical reasons group together.
 */
export function scrubReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason
    .replace(/customer \S+/g, "customer <id>")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "<date>")
    .slice(0, 500);
}

let warnedMissingTable = false;
let lastOtherWarnAt = 0;
const lastPruneAtByShop = new Map<string, number>();

function isMissingTableOrColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /does not exist|no such table|no such column|Unknown column|has no column named/i.test(msg);
}

/** Fire-and-forget persist + occasional prune. Never throws, never awaited by callers. */
export function recordOfferInquiry(input: OfferInquiryInput): void {
  void (async () => {
    try {
      await prisma.offerInquiry.create({
        data: {
          shop: input.shop,
          referenceId: input.referenceId,
          surface: input.surface ?? "post_purchase",
          countryCode: input.countryCode,
          currency: input.currency,
          presentment: input.presentment,
          customerId: input.customerId,
          lines: input.lines,
          totalAmount: Number.isFinite(input.totalAmount) ? input.totalAmount : 0,
          totalSource: input.totalSource,
          offers: input.offers,
          corePending: input.corePending,
          emptyReason: scrubReason(input.emptyReason),
          tookMs: Math.max(0, Math.round(input.tookMs)),
          appVersion: APP_VERSION,
        },
        select: { id: true },
      });
      // Prune at most once an hour PER SHOP — cheap, keeps the table small.
      const lastPrune = lastPruneAtByShop.get(input.shop) ?? 0;
      if (Date.now() - lastPrune > 60 * 60 * 1000) {
        lastPruneAtByShop.set(input.shop, Date.now());
        await prisma.offerInquiry.deleteMany({
          where: { shop: input.shop, createdAt: { lt: new Date(Date.now() - INQUIRY_RETENTION_MS) } },
        });
      }
    } catch (error) {
      if (isMissingTableOrColumn(error)) {
        if (!warnedMissingTable) {
          warnedMissingTable = true;
          console.warn(
            `[inquiry-log] could not persist ShouldRender inquiry for ${input.shop} — run \`npx prisma db push\` on this deployment (OfferInquiry table). Further schema failures are silent.`,
            error instanceof Error ? error.message : error,
          );
        }
      } else if (Date.now() - lastOtherWarnAt > 60 * 1000) {
        lastOtherWarnAt = Date.now();
        console.warn(`[inquiry-log] persist failed for ${input.shop} (logged at most once a minute)`, error instanceof Error ? error.message : error);
      }
    }
  })();
}

export type InquiryStats = {
  since: Date;
  /** ShouldRender calls (one checkout produces several: mount + every total/currency/country change). */
  total: number;
  withOffers: number;
  empty: number;
  /** Distinct checkouts (referenceIds) — the number a merchant should compare with orders. */
  checkouts: number;
  checkoutsWithOffers: number;
  guests: number;
  avgTookMs: number | null;
  maxTookMs: number | null;
  slowCount: number; // > 2000 ms (Shopify's guidance for ShouldRender network calls)
  byCurrency: Record<string, number>;
  byCountry: Record<string, number>;
  topEmptyReasons: Array<{ reason: string; count: number }>;
  lastAt: Date | null;
  /** True when the per-row breakdown was skipped (light mode) or capped at the sample size. */
  sampled: boolean;
};

const SAMPLE_ROWS = 2000;

/**
 * Aggregates over the last `windowMs` — used by the health check, the Debug tab
 * and (light mode) the dashboard. Exact counts always come from COUNT/aggregate
 * queries; the per-row breakdown (currencies, countries, reasons, distinct
 * checkouts) reads at most SAMPLE_ROWS recent rows and is skipped entirely
 * in light mode so a busy store never ships thousands of rows to render three
 * numbers.
 */
export async function inquiryStats(shop: string, windowMs: number, opts: { light?: boolean } = {}): Promise<InquiryStats> {
  const since = new Date(Date.now() - windowMs);
  const where = { shop, surface: "post_purchase", createdAt: { gte: since } };
  const [totalExact, withOffersExact, slowExact, agg, last] = await Promise.all([
    prisma.offerInquiry.count({ where }),
    prisma.offerInquiry.count({ where: { ...where, offers: { gt: 0 } } }),
    prisma.offerInquiry.count({ where: { ...where, tookMs: { gt: 2000 } } }),
    prisma.offerInquiry.aggregate({ where, _avg: { tookMs: true }, _max: { tookMs: true } }),
    prisma.offerInquiry.findFirst({ where, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const base: InquiryStats = {
    since,
    total: totalExact,
    withOffers: withOffersExact,
    empty: totalExact - withOffersExact,
    checkouts: 0,
    checkoutsWithOffers: 0,
    guests: 0,
    avgTookMs: agg._avg.tookMs === null ? null : Math.round(agg._avg.tookMs),
    maxTookMs: agg._max.tookMs ?? null,
    slowCount: slowExact,
    byCurrency: {},
    byCountry: {},
    topEmptyReasons: [],
    lastAt: last?.createdAt ?? null,
    sampled: true,
  };
  if (opts.light || totalExact === 0) return base;

  const rows = await prisma.offerInquiry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: SAMPLE_ROWS,
    select: { referenceId: true, offers: true, customerId: true, currency: true, presentment: true, countryCode: true, emptyReason: true },
  });
  const byCurrency: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const reasons = new Map<string, number>();
  const refs = new Set<string>();
  const refsWithOffers = new Set<string>();
  let guests = 0;
  for (const r of rows) {
    refs.add(r.referenceId);
    if (r.offers > 0) refsWithOffers.add(r.referenceId);
    if (!r.customerId) guests++;
    const cur = r.presentment ?? r.currency ?? "?";
    byCurrency[cur] = (byCurrency[cur] ?? 0) + 1;
    const cc = r.countryCode ?? "?";
    byCountry[cc] = (byCountry[cc] ?? 0) + 1;
    if (r.offers === 0) {
      const key = (scrubReason(r.emptyReason) ?? "no reason recorded").slice(0, 160);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  return {
    ...base,
    checkouts: refs.size,
    checkoutsWithOffers: refsWithOffers.size,
    guests,
    byCurrency,
    byCountry,
    topEmptyReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
    sampled: rows.length >= SAMPLE_ROWS,
  };
}

/** Most recent inquiries for the Debug tab list. */
export async function recentInquiries(shop: string, take = 60) {
  return prisma.offerInquiry.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}
