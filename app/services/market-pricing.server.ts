// ─────────────────────────────────────────────────────────────────────────────
// Market pricing — real per-country variant prices via Shopify's
// contextualPricing. This is the price a buyer in that country actually pays:
// market percentage adjustments and fixed price-list prices included, in the
// market's presentment currency. The FX-rate mechanism in the orchestrator
// remains the fallback when this lookup is unavailable (no offline session,
// API error, timeout) — display then degrades to base-price × rate exactly as
// before.
//
// Contract: getContextualPrices never throws and never hangs — the buyer path
// (ShouldRender's hard time budget) calls it inline. Results are cached in
// ContextualPriceCache per (shop, variantId, country) with a TTL; on fetch
// failure stale rows are served rather than nothing.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";

/** Real buyer-facing price of one variant in one country. */
export interface ContextualVariantPrice {
  /** Amount in `currency` — null when Shopify has no price for this context. */
  price: number | null;
  compareAtPrice: number | null;
  /** Presentment currency of the amounts (e.g. "USD"). */
  currency: string;
}

/** Cached rows younger than this are served without hitting Shopify. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Hard budget for the Admin API call — the buyer path must never wait long. */
const FETCH_TIMEOUT_MS = 2_000;

const CONTEXTUAL_PRICING_QUERY = `#graphql
  query cellexiaContextualPrices($ids: [ID!]!, $country: CountryCode!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        contextualPricing(context: { country: $country }) {
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

function toAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Admin GraphQL client from the shop's OFFLINE session (public buyer routes
 * have no admin auth of their own). Dynamic import keeps this module free of
 * a static dependency on shopify.server (which pulls in the bootstrap chain).
 */
async function offlineGraphql(
  shop: string,
): Promise<((query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>) | null> {
  try {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    return admin.graphql as unknown as (
      query: string,
      opts?: { variables?: Record<string, unknown> },
    ) => Promise<Response>;
  } catch (error) {
    console.error(`[market-pricing] offline admin session unavailable for ${shop}`, error);
    return null;
  }
}

/** Fetch contextual prices from Shopify for the given variants + country. */
async function fetchFromShopify(
  shop: string,
  variantIds: string[],
  country: string,
): Promise<Map<string, ContextualVariantPrice> | null> {
  const graphql = await offlineGraphql(shop);
  if (!graphql) return null;
  try {
    const call = (async () => {
      const response = await graphql(CONTEXTUAL_PRICING_QUERY, {
        variables: { ids: variantIds, country },
      });
      return (await response.json()) as any;
    })();
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), FETCH_TIMEOUT_MS).unref?.(),
    );
    const body = await Promise.race([call, timeout]);
    if (!body) {
      console.error(`[market-pricing] contextualPricing timed out for ${shop}/${country}`);
      return null;
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      console.error(`[market-pricing] contextualPricing errors for ${shop}/${country}`, body.errors);
      return null;
    }
    const nodes: any[] = Array.isArray(body?.data?.nodes) ? body.data.nodes : [];
    const result = new Map<string, ContextualVariantPrice>();
    for (const node of nodes) {
      if (!node || typeof node.id !== "string") continue;
      const pricing = node.contextualPricing;
      const price = toAmount(pricing?.price?.amount);
      const currency =
        typeof pricing?.price?.currencyCode === "string" ? pricing.price.currencyCode : "";
      result.set(node.id, {
        price,
        compareAtPrice: toAmount(pricing?.compareAtPrice?.amount),
        currency,
      });
    }
    // Variants Shopify returned nothing for (deleted, not in the query result)
    // are cached as explicit misses so hot paths don't re-fetch them.
    for (const id of variantIds) {
      if (!result.has(id)) result.set(id, { price: null, compareAtPrice: null, currency: "" });
    }
    return result;
  } catch (error) {
    console.error(`[market-pricing] contextualPricing fetch failed for ${shop}/${country}`, error);
    return null;
  }
}

/**
 * Real per-country prices for the given variants, DB-cached. Returns a map
 * keyed by variant gid — entries with price null are known misses. Returns
 * null only when nothing (fresh, fetched, or stale) is available at all.
 */
export async function getContextualPrices(
  shop: string,
  variantIds: string[],
  countryCode: string | null | undefined,
): Promise<Map<string, ContextualVariantPrice> | null> {
  const country = String(countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const ids = [...new Set(variantIds.filter((v) => typeof v === "string" && v.startsWith("gid://")))];
  if (ids.length === 0) return null;

  try {
    const rows = await prisma.contextualPriceCache.findMany({
      where: { shop, country, variantId: { in: ids } },
    });
    const rowByVariant = new Map(rows.map((r) => [r.variantId, r]));
    const freshCutoff = Date.now() - CACHE_TTL_MS;
    const stale = ids.filter((id) => {
      const row = rowByVariant.get(id);
      return !row || row.fetchedAt.getTime() < freshCutoff;
    });

    if (stale.length > 0) {
      const fetched = await fetchFromShopify(shop, stale, country);
      if (fetched) {
        // Persist best-effort — a cache write failure must not lose the fetch.
        await Promise.all(
          [...fetched].map(([variantId, p]) =>
            prisma.contextualPriceCache
              .upsert({
                where: { shop_variantId_country: { shop, variantId, country } },
                update: {
                  price: p.price,
                  compareAtPrice: p.compareAtPrice,
                  currency: p.currency,
                  fetchedAt: new Date(),
                },
                create: {
                  shop,
                  variantId,
                  country,
                  price: p.price,
                  compareAtPrice: p.compareAtPrice,
                  currency: p.currency,
                },
              })
              .catch((error: unknown) =>
                console.error(`[market-pricing] cache write failed for ${shop}/${variantId}`, error),
              ),
          ),
        );
        for (const [variantId, p] of fetched) {
          rowByVariant.set(variantId, {
            variantId,
            price: p.price,
            compareAtPrice: p.compareAtPrice,
            currency: p.currency,
          } as any);
        }
      }
      // fetched === null → stale rows (if any) below serve as the fallback.
    }

    const result = new Map<string, ContextualVariantPrice>();
    for (const id of ids) {
      const row = rowByVariant.get(id);
      if (!row) continue;
      result.set(id, {
        price: row.price,
        compareAtPrice: row.compareAtPrice,
        currency: row.currency ?? "",
      });
    }
    return result.size > 0 ? result : null;
  } catch (error) {
    console.error(`[market-pricing] lookup failed for ${shop}/${country}`, error);
    return null;
  }
}

/**
 * All-or-nothing display pricing for one offer response: every requested
 * variant must have a usable contextual price in the SAME currency, otherwise
 * null (the caller then falls back to the FX-rate display conversion). A page
 * mixing real USD prices with converted EUR ones would be worse than either.
 */
export function resolveUniformPricing(
  prices: Map<string, ContextualVariantPrice> | null,
  variantIds: string[],
): { byVariant: Map<string, ContextualVariantPrice>; currency: string } | null {
  if (!prices || variantIds.length === 0) return null;
  let currency = "";
  const byVariant = new Map<string, ContextualVariantPrice>();
  for (const id of variantIds) {
    const p = prices.get(id);
    if (!p || p.price === null || p.price <= 0 || !p.currency) return null;
    if (!currency) currency = p.currency;
    else if (currency !== p.currency) return null;
    byVariant.set(id, p);
  }
  return { byVariant, currency };
}
