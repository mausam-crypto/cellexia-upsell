// ─────────────────────────────────────────────────────────────────────────────
// Module A — Catalog sync & product cache.
//
// Keeps a local mirror of the shop's products (ProductCache) fresh via
// paginated Admin GraphQL syncs and products/* REST webhooks, plus the
// shop's locales (settings.languages) and Shopify Markets (MarketSetting).
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { jparse, jstr, toGid } from "../lib/json";
import type { AdminGraphql } from "../types";
import { getSettings, saveSettings } from "./settings.server";

// ── Contract types ───────────────────────────────────────────────────────────

export interface CachedVariant {
  id: string; // gid
  title: string;
  price: number;
  compareAtPrice: number | null;
  inventoryQuantity: number | null; // null = not tracked
  unitCost: number | null;
  imageUrl: string | null;
  sku: string;
}

export interface CatalogProduct {
  productId: string; // gid
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string; // "ACTIVE" | ...
  tags: string[];
  imageUrl: string | null;
  descriptionShort: string; // plain text, first ~300 chars — used in AI prompts
  variants: CachedVariant[];
  translations: Record<string, { title?: string }>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// Page sizes are kept small so each query stays under the Admin GraphQL
// single-query cost cap (1,000 points): 20 products × 10 variants per page.
const PRODUCTS_PAGE_SIZE = 20;
const VARIANTS_PAGE_SIZE = 10;
const MAX_PAGES = 500; // 500 × 20 products (≥ 10,000) — hard stop against runaway loops
const MAX_VARIANT_PAGES = 20; // follow-up variant pages per product (10 + 20 × 10 = 210 variants)
const DESCRIPTION_MAX = 300;

/**
 * Executes a GraphQL call, awaits the fetch Response, and throws a descriptive
 * Error on transport errors, GraphQL `errors`, or any `userErrors` found on
 * top-level payload objects. Callers wrap this in try/catch.
 */
async function gqlJson(
  graphql: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const json: any = await response.json();
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    const message = json.errors
      .map((e: any) => (typeof e?.message === "string" ? e.message : "unknown error"))
      .join("; ");
    throw new Error(`GraphQL errors: ${message}`);
  }
  const data = json?.data;
  if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      const userErrors = (value as any)?.userErrors;
      if (Array.isArray(userErrors) && userErrors.length > 0) {
        const message = userErrors
          .map((e: any) => (typeof e?.message === "string" ? e.message : "unknown error"))
          .join("; ");
        throw new Error(`GraphQL userErrors: ${message}`);
      }
    }
  }
  return json;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Strip HTML, decode common entities, collapse whitespace, cut at ~maxLen. */
function toPlainTextShort(input: unknown, maxLen = DESCRIPTION_MAX): string {
  if (input === null || input === undefined) return "";
  const text = String(input)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(#39|#x27|apos);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function rowToProduct(row: {
  productId: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string;
  tags: string;
  imageUrl: string | null;
  descriptionShort: string;
  variantsJson: string;
  translationsJson: string;
}): CatalogProduct {
  return {
    productId: row.productId,
    title: row.title,
    handle: row.handle,
    productType: row.productType,
    vendor: row.vendor,
    status: row.status,
    tags: normalizeTags(row.tags),
    imageUrl: row.imageUrl,
    descriptionShort: row.descriptionShort,
    variants: jparse<CachedVariant[]>(row.variantsJson, []),
    translations: jparse<Record<string, { title?: string }>>(row.translationsJson, {}),
  };
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const PRODUCTS_PAGE_QUERY = `#graphql
  query CatalogProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        productType
        vendor
        status
        tags
        description
        featuredImage {
          url
        }
        variants(first: ${VARIANTS_PAGE_SIZE}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
            image {
              url
            }
            inventoryItem {
              tracked
              unitCost {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

// Follow-up query for products with more variants than one base page — scoped
// to a single product (mirrors the market-regions follow-up pattern). Cost per
// call stays far under the 1,000-point cap (one product × 10 variants).
const PRODUCT_VARIANTS_QUERY = `#graphql
  query CatalogProductVariantsPage($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: ${VARIANTS_PAGE_SIZE}, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          inventoryQuantity
          image {
            url
          }
          inventoryItem {
            tracked
            unitCost {
              amount
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_TRANSLATIONS_QUERY = `#graphql
  query CatalogProductTranslations($first: Int!, $after: String, $locale: String!) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        translations(locale: $locale) {
          key
          value
        }
      }
    }
  }
`;

const SHOP_LOCALES_QUERY = `#graphql
  query ShopLocales {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

// Unified markets shape (2026-01+): Market.enabled/regions are deprecated in
// favour of status + conditions.regionsCondition. Page sizes (20 markets ×
// 40 regions) keep each query under the 1,000-point cost cap.
const MARKETS_QUERY_UNIFIED = `#graphql
  query MarketsWithConditions($after: String) {
    markets(first: 20, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        name
        status
        conditions {
          regionsCondition {
            regions(first: 40) {
              nodes {
                ... on MarketRegionCountry {
                  code
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    }
  }
`;

const MARKET_REGIONS_QUERY_UNIFIED = `#graphql
  query MarketRegionsPage($id: ID!, $after: String) {
    market(id: $id) {
      conditions {
        regionsCondition {
          regions(first: 40, after: $after) {
            nodes {
              ... on MarketRegionCountry {
                code
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }
`;

// Legacy markets shape (pre-2026-01) — used as a fallback when the unified
// query is rejected by older API versions.
const MARKETS_QUERY_LEGACY = `#graphql
  query MarketsWithRegions($after: String) {
    markets(first: 20, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        name
        enabled
        regions(first: 40) {
          nodes {
            ... on MarketRegionCountry {
              code
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const MARKET_REGIONS_QUERY_LEGACY = `#graphql
  query MarketRegionsPageLegacy($id: ID!, $after: String) {
    market(id: $id) {
      regions(first: 40, after: $after) {
        nodes {
          ... on MarketRegionCountry {
            code
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// ── Mapping ──────────────────────────────────────────────────────────────────

function mapGraphqlVariant(node: any): CachedVariant {
  const tracked: unknown = node?.inventoryItem?.tracked;
  const quantity = num(node?.inventoryQuantity);
  return {
    id: String(node?.id ?? ""),
    title: String(node?.title ?? ""),
    price: num(node?.price) ?? 0,
    compareAtPrice: num(node?.compareAtPrice),
    inventoryQuantity: tracked === false ? null : quantity,
    unitCost: num(node?.inventoryItem?.unitCost?.amount),
    imageUrl: typeof node?.image?.url === "string" ? node.image.url : null,
    sku: String(node?.sku ?? ""),
  };
}

function mapGraphqlProduct(node: any): CatalogProduct {
  const variantNodes: any[] = Array.isArray(node?.variants?.nodes) ? node.variants.nodes : [];
  return {
    productId: String(node?.id ?? ""),
    title: String(node?.title ?? ""),
    handle: String(node?.handle ?? ""),
    productType: String(node?.productType ?? ""),
    vendor: String(node?.vendor ?? ""),
    status: String(node?.status ?? "ACTIVE"),
    tags: normalizeTags(node?.tags),
    imageUrl: typeof node?.featuredImage?.url === "string" ? node.featuredImage.url : null,
    descriptionShort: toPlainTextShort(node?.description),
    variants: variantNodes.map(mapGraphqlVariant),
    translations: {},
  };
}

// ── Catalog sync ─────────────────────────────────────────────────────────────

/**
 * Full paginated catalog sync into ProductCache, including per-locale title
 * translations for every settings language beyond the default. Sets
 * Shop.catalogSyncedAt on completion. Throws only when the very first page
 * cannot be fetched at all; later-page and translation errors are logged and
 * the sync continues with what was retrieved.
 */
export async function syncCatalog(
  graphql: AdminGraphql,
  shop: string,
): Promise<{ count: number }> {
  const settings = await getSettings(shop);

  // 1) Base product pass.
  const products: CatalogProduct[] = [];
  let after: string | null = null;
  let hasNextPage = true;
  let page = 0;
  let endedEarly = false; // pagination stopped before exhausting hasNextPage
  while (hasNextPage && page < MAX_PAGES) {
    page += 1;
    let connection: any = null;
    try {
      const json = await gqlJson(graphql, PRODUCTS_PAGE_QUERY, {
        first: PRODUCTS_PAGE_SIZE,
        after,
      });
      connection = json?.data?.products;
      if (!connection) throw new Error("products connection missing from response");
    } catch (error) {
      if (page === 1) {
        console.error(`[catalog] product sync failed on first page for ${shop}`, error);
        throw new Error(
          `Catalog sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.error(`[catalog] product sync failed on page ${page} for ${shop} — continuing with partial data`, error);
      endedEarly = true;
      break;
    }
    const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
    for (const node of nodes) {
      const product = mapGraphqlProduct(node);
      if (!product.productId) continue;

      // Follow-up variant pages for products with more variants than one base
      // page (mirrors the market-regions follow-up pattern), bounded by
      // MAX_VARIANT_PAGES. Best-effort: a failed follow-up keeps the variants
      // fetched so far.
      const variantsConnection: any = node?.variants;
      let vHasNext = Boolean(variantsConnection?.pageInfo?.hasNextPage);
      let vAfter: string | null =
        typeof variantsConnection?.pageInfo?.endCursor === "string"
          ? variantsConnection.pageInfo.endCursor
          : null;
      let vPage = 0;
      try {
        while (vHasNext && vAfter && vPage < MAX_VARIANT_PAGES) {
          vPage += 1;
          const vJson = await gqlJson(graphql, PRODUCT_VARIANTS_QUERY, {
            id: product.productId,
            after: vAfter,
          });
          const vConnection: any = vJson?.data?.product?.variants;
          if (!vConnection) break;
          const vNodes: any[] = Array.isArray(vConnection?.nodes) ? vConnection.nodes : [];
          product.variants.push(...vNodes.map(mapGraphqlVariant));
          vHasNext = Boolean(vConnection?.pageInfo?.hasNextPage);
          vAfter =
            typeof vConnection?.pageInfo?.endCursor === "string"
              ? vConnection.pageInfo.endCursor
              : null;
        }
      } catch (error) {
        console.error(
          `[catalog] variant pagination failed for ${product.productId} on ${shop} — keeping first ${VARIANTS_PAGE_SIZE} variants`,
          error,
        );
      }

      products.push(product);
    }
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = typeof connection?.pageInfo?.endCursor === "string" ? connection.pageInfo.endCursor : null;
    if (hasNextPage && !after) {
      endedEarly = true; // cannot continue without a cursor
      hasNextPage = false;
    }
  }
  if (hasNextPage) endedEarly = true; // stopped at MAX_PAGES with pages remaining

  // 2) Per-locale title translations (best-effort — a missing read_locales
  //    scope or a bad locale must never break the sync).
  const extraLocales = (settings.languages ?? []).filter(
    (l) => typeof l === "string" && l && l !== settings.defaultLanguage,
  );
  const translationsByProduct = new Map<string, Record<string, { title?: string }>>();
  const syncedLocales = new Set<string>(); // locales fully fetched this run — safe to overlay
  for (const locale of extraLocales) {
    try {
      let tAfter: string | null = null;
      let tHasNext = true;
      let tPage = 0;
      while (tHasNext && tPage < MAX_PAGES) {
        tPage += 1;
        const json = await gqlJson(graphql, PRODUCT_TRANSLATIONS_QUERY, {
          first: PRODUCTS_PAGE_SIZE,
          after: tAfter,
          locale,
        });
        const connection: any = json?.data?.products;
        if (!connection) throw new Error("products connection missing from translations response");
        const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        for (const node of nodes) {
          const productId = String(node?.id ?? "");
          if (!productId) continue;
          const list: any[] = Array.isArray(node?.translations) ? node.translations : [];
          const title = list.find(
            (t) => t?.key === "title" && typeof t?.value === "string" && t.value.length > 0,
          );
          if (title) {
            const existing = translationsByProduct.get(productId) ?? {};
            existing[locale] = { title: title.value as string };
            translationsByProduct.set(productId, existing);
          }
        }
        tHasNext = Boolean(connection?.pageInfo?.hasNextPage);
        tAfter =
          typeof connection?.pageInfo?.endCursor === "string" ? connection.pageInfo.endCursor : null;
        if (!tAfter) tHasNext = false;
      }
      if (!tHasNext) {
        syncedLocales.add(locale);
      } else {
        console.error(`[catalog] translations fetch for locale "${locale}" on ${shop} hit the page cap — treating as partial`);
      }
    } catch (error) {
      console.error(`[catalog] translations fetch failed for locale "${locale}" on ${shop} — skipping`, error);
    }
  }

  // 3) Upsert into ProductCache. Translations are MERGED with each existing
  //    row's translationsJson: only locales that were fully fetched this run
  //    are overlaid, so a failed per-locale fetch never wipes prior entries.
  const existingTranslationsByProduct = new Map<string, Record<string, { title?: string }>>();
  try {
    const existingRows = await prisma.productCache.findMany({
      where: { shop },
      select: { productId: true, translationsJson: true },
    });
    for (const row of existingRows) {
      existingTranslationsByProduct.set(
        row.productId,
        jparse<Record<string, { title?: string }>>(row.translationsJson, {}),
      );
    }
  } catch (error) {
    console.error(`[catalog] failed to load existing translations for ${shop} — proceeding without merge`, error);
  }

  let count = 0;
  for (const product of products) {
    const fetched = translationsByProduct.get(product.productId) ?? {};
    const translations: Record<string, { title?: string }> = {
      ...(existingTranslationsByProduct.get(product.productId) ?? {}),
    };
    for (const locale of syncedLocales) {
      const entry = fetched[locale];
      if (entry) translations[locale] = entry;
      else delete translations[locale];
    }
    const data = {
      title: product.title,
      handle: product.handle,
      productType: product.productType,
      vendor: product.vendor,
      status: product.status,
      tags: product.tags.join(","),
      imageUrl: product.imageUrl,
      descriptionShort: product.descriptionShort,
      variantsJson: jstr(product.variants),
      translationsJson: jstr(translations),
    };
    try {
      await prisma.productCache.upsert({
        where: { shop_productId: { shop, productId: product.productId } },
        update: data,
        create: { shop, productId: product.productId, ...data },
      });
      count += 1;
    } catch (error) {
      console.error(`[catalog] upsert failed for ${product.productId} on ${shop}`, error);
    }
  }

  // 3b) Remove stale rows — only when the base pass fully enumerated the
  //     catalog (never after an early break or partial pagination).
  if (!endedEarly) {
    try {
      const syncedIds = products.map((p) => p.productId);
      const removed = await prisma.productCache.deleteMany({
        where: { shop, productId: { notIn: syncedIds } },
      });
      console.log(`[catalog] removed ${removed.count} stale products for ${shop}`);
    } catch (error) {
      console.error(`[catalog] stale product reconciliation failed for ${shop}`, error);
    }
  } else {
    console.log(`[catalog] sync ended early for ${shop} — skipping stale product reconciliation`);
  }

  // 4) Mark the sync time on the Shop row.
  try {
    await prisma.shop.upsert({
      where: { shop },
      update: { catalogSyncedAt: new Date() },
      create: { shop, settingsJson: "{}", catalogSyncedAt: new Date() },
    });
  } catch (error) {
    console.error(`[catalog] failed to set catalogSyncedAt for ${shop}`, error);
  }

  console.log(`[catalog] synced ${count} products for ${shop}`);
  return { count };
}

// ── Locales & markets sync ───────────────────────────────────────────────────

const MAX_MARKET_PAGES = 20; // bound for both market and per-market region loops

interface FetchedMarket {
  handle: string;
  name: string;
  enabled: boolean;
  countries: string[];
}

function regionCodes(connection: any): string[] {
  const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
  return nodes
    .map((r) => (typeof r?.code === "string" ? r.code : ""))
    .filter(Boolean);
}

/**
 * Fetches every market (cursor-paginated) with its full country list. When a
 * market's first regions page has more (Cellexia can have ~80 countries in one
 * market) the remaining regions are fetched with follow-up market-scoped
 * queries until exhausted. Both loops are bounded by MAX_MARKET_PAGES.
 * Throws on GraphQL errors so callers can fall back to the other shape.
 */
async function fetchMarkets(
  graphql: AdminGraphql,
  shape: "unified" | "legacy",
): Promise<FetchedMarket[]> {
  const marketsQuery = shape === "unified" ? MARKETS_QUERY_UNIFIED : MARKETS_QUERY_LEGACY;
  const regionsQuery =
    shape === "unified" ? MARKET_REGIONS_QUERY_UNIFIED : MARKET_REGIONS_QUERY_LEGACY;
  const pickRegions = (market: any): any =>
    shape === "unified" ? market?.conditions?.regionsCondition?.regions : market?.regions;

  const result: FetchedMarket[] = [];
  let after: string | null = null;
  let hasNextPage = true;
  let page = 0;
  while (hasNextPage && page < MAX_MARKET_PAGES) {
    page += 1;
    const json = await gqlJson(graphql, marketsQuery, { after });
    const connection: any = json?.data?.markets;
    if (!connection) throw new Error("markets connection missing from response");
    const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
    for (const market of nodes) {
      const handle = String(market?.handle ?? "");
      if (!handle) continue;
      const regionsConnection = pickRegions(market);
      const countries = regionCodes(regionsConnection);

      // Follow-up region pages for markets with more countries than one page.
      const marketId = String(market?.id ?? "");
      let rHasNext = Boolean(regionsConnection?.pageInfo?.hasNextPage);
      let rAfter: string | null =
        typeof regionsConnection?.pageInfo?.endCursor === "string"
          ? regionsConnection.pageInfo.endCursor
          : null;
      let rPage = 0;
      while (rHasNext && rAfter && marketId && rPage < MAX_MARKET_PAGES) {
        rPage += 1;
        const rJson = await gqlJson(graphql, regionsQuery, { id: marketId, after: rAfter });
        const rConnection: any = pickRegions(rJson?.data?.market);
        if (!rConnection) break;
        countries.push(...regionCodes(rConnection));
        rHasNext = Boolean(rConnection?.pageInfo?.hasNextPage);
        rAfter =
          typeof rConnection?.pageInfo?.endCursor === "string"
            ? rConnection.pageInfo.endCursor
            : null;
      }

      const enabled =
        shape === "unified"
          ? String(market?.status ?? "ACTIVE").toUpperCase() === "ACTIVE"
          : market?.enabled === false
            ? false
            : true;
      result.push({ handle, name: String(market?.name ?? handle), enabled, countries });
    }
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after =
      typeof connection?.pageInfo?.endCursor === "string" ? connection.pageInfo.endCursor : null;
    if (!after) hasNextPage = false;
  }
  return result;
}

/**
 * Syncs shop locales into settings.languages/defaultLanguage (published only,
 * original order, primary first) and Shopify Markets into MarketSetting rows.
 * Best-effort: every GraphQL call is guarded, and re-syncs never overwrite
 * admin-set overrides (enabled/discount/language/maxOffers) on existing rows.
 */
export async function syncMarketsAndLocales(
  graphql: AdminGraphql,
  shop: string,
): Promise<void> {
  // Locales → settings.languages / defaultLanguage.
  try {
    const json = await gqlJson(graphql, SHOP_LOCALES_QUERY);
    const locales: any[] = Array.isArray(json?.data?.shopLocales) ? json.data.shopLocales : [];
    const published = locales.filter(
      (l) => l?.published === true && typeof l?.locale === "string" && l.locale.length > 0,
    );
    const primary = published.find((l) => l?.primary === true);
    const languages: string[] = [
      ...(primary ? [String(primary.locale)] : []),
      ...published.filter((l) => l?.primary !== true).map((l) => String(l.locale)),
    ];
    if (languages.length > 0) {
      await saveSettings(shop, {
        languages,
        defaultLanguage: primary ? String(primary.locale) : languages[0],
      });
    }
  } catch (error) {
    console.error(`[catalog] shopLocales sync failed for ${shop}`, error);
  }

  // Markets → MarketSetting. Prefer the unified (2026-01) shape — status +
  // conditions.regionsCondition — and fall back to the legacy enabled/regions
  // shape on older API versions. Best-effort overall.
  try {
    let markets: FetchedMarket[];
    try {
      markets = await fetchMarkets(graphql, "unified");
    } catch (error) {
      console.error(
        `[catalog] unified markets query failed for ${shop} — falling back to legacy shape`,
        error,
      );
      markets = await fetchMarkets(graphql, "legacy");
    }
    for (const market of markets) {
      try {
        await prisma.marketSetting.upsert({
          where: { shop_marketHandle: { shop, marketHandle: market.handle } },
          // Never clobber admin-set overrides on re-sync — name/countries only.
          update: { name: market.name, countriesJson: jstr(market.countries) },
          create: {
            shop,
            marketHandle: market.handle,
            name: market.name,
            countriesJson: jstr(market.countries),
            enabled: market.enabled,
          },
        });
      } catch (error) {
        console.error(`[catalog] market upsert failed for "${market.handle}" on ${shop}`, error);
      }
    }
  } catch (error) {
    console.error(`[catalog] markets sync failed for ${shop} (best-effort, continuing)`, error);
  }
}

// ── Webhook upserts (REST payloads) ──────────────────────────────────────────

/**
 * Upserts one product from a products/create or products/update REST webhook.
 * REST payloads carry no unit cost and no translations, so existing
 * unitCost values (matched by variant gid) and translationsJson are preserved.
 */
export async function upsertProductFromWebhook(shop: string, payload: any): Promise<void> {
  const rawId = payload?.admin_graphql_api_id ?? payload?.id;
  if (rawId === undefined || rawId === null || rawId === "") {
    console.error(`[catalog] product webhook without id for ${shop} — ignoring`);
    return;
  }
  const productId = toGid("Product", rawId);

  const existing = await prisma.productCache.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  const existingVariants = jparse<CachedVariant[]>(existing?.variantsJson, []);
  const unitCostByVariantId = new Map<string, number | null>(
    existingVariants.map((v) => [v.id, v.unitCost]),
  );

  const images: any[] = Array.isArray(payload?.images) ? payload.images : [];
  const imageSrcById = new Map<string, string>();
  for (const img of images) {
    if (img?.id !== undefined && typeof img?.src === "string") {
      imageSrcById.set(String(img.id), img.src);
    }
  }

  let variants: CachedVariant[];
  if (Array.isArray(payload?.variants)) {
    variants = payload.variants.map((v: any): CachedVariant => {
      const id = toGid("ProductVariant", v?.admin_graphql_api_id ?? v?.id ?? "");
      // REST: inventory_management null ⇒ inventory not tracked.
      const tracked =
        v?.inventory_management !== undefined ? v.inventory_management != null : undefined;
      return {
        id,
        title: String(v?.title ?? ""),
        price: num(v?.price) ?? 0,
        compareAtPrice: num(v?.compare_at_price),
        inventoryQuantity: tracked === false ? null : num(v?.inventory_quantity),
        unitCost: unitCostByVariantId.get(id) ?? null, // preserved — REST has no cost
        imageUrl:
          v?.image_id !== undefined && v?.image_id !== null
            ? imageSrcById.get(String(v.image_id)) ?? null
            : null,
        sku: String(v?.sku ?? ""),
      };
    });
  } else {
    variants = existingVariants; // webhook without variants — keep what we have
  }

  const data = {
    title: String(payload?.title ?? existing?.title ?? ""),
    handle: String(payload?.handle ?? existing?.handle ?? ""),
    productType: String(payload?.product_type ?? existing?.productType ?? ""),
    vendor: String(payload?.vendor ?? existing?.vendor ?? ""),
    status: String(payload?.status ?? existing?.status ?? "active").toUpperCase(),
    tags: normalizeTags(payload?.tags).join(","),
    imageUrl:
      typeof payload?.image?.src === "string"
        ? payload.image.src
        : typeof images[0]?.src === "string"
          ? images[0].src
          : null,
    descriptionShort:
      payload && Object.prototype.hasOwnProperty.call(payload, "body_html")
        ? toPlainTextShort(payload.body_html)
        : existing?.descriptionShort ?? "",
    variantsJson: jstr(variants),
    translationsJson: existing?.translationsJson ?? "{}", // preserved
  };

  await prisma.productCache.upsert({
    where: { shop_productId: { shop, productId } },
    update: data,
    create: { shop, productId, ...data },
  });
}

/** Removes a product from the cache on products/delete. */
export async function deleteProductFromWebhook(shop: string, payload: any): Promise<void> {
  const rawId = payload?.admin_graphql_api_id ?? payload?.id;
  if (rawId === undefined || rawId === null || rawId === "") return;
  const productId = toGid("Product", rawId);
  await prisma.productCache.deleteMany({ where: { shop, productId } });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Fetch cached products by product gid, preserving the order of `productIds`. */
export async function getProductsByIds(
  shop: string,
  productIds: string[],
): Promise<CatalogProduct[]> {
  const ids = Array.from(
    new Set(productIds.filter(Boolean).map((id) => toGid("Product", id))),
  );
  if (ids.length === 0) return [];
  const rows = await prisma.productCache.findMany({
    where: { shop, productId: { in: ids } },
  });
  const byId = new Map(rows.map((row) => [row.productId, rowToProduct(row)]));
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is CatalogProduct => p !== undefined);
}

/** All cached products with status ACTIVE. */
export async function getActiveProducts(shop: string): Promise<CatalogProduct[]> {
  const rows = await prisma.productCache.findMany({
    where: { shop, status: "ACTIVE" },
    orderBy: { title: "asc" },
  });
  return rows.map(rowToProduct);
}

/** First in-stock variant (untracked counts as in stock), else first variant. */
export function pickPrimaryVariant(p: CatalogProduct): CachedVariant | null {
  if (!p.variants.length) return null;
  const inStock = p.variants.find(
    (v) => v.inventoryQuantity === null || v.inventoryQuantity > 0,
  );
  return inStock ?? p.variants[0] ?? null;
}
