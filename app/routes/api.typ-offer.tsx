// ─────────────────────────────────────────────────────────────────────────────
// POST /api/typ-offer — called by the thank-you-page extension (covers wallet
// and PayPal orders that never see the post-purchase page). Authenticated with
// the checkout session token; the shop comes from the token's `dest` claim.
// SECURITY: the purchase context is built exclusively from server-side data —
// the OrderRecord captured by the orders/create webhook, or (fallback) ONE
// admin API order lookup. The request body may only contribute the display
// locale and the order id; client-supplied totals, line items, country,
// currency and customer id are ignored so they can never influence offer
// selection or the discount percentage. The request is bound to the order:
// orders created more than 60 minutes ago are refused (no code minting for
// arbitrary historical order ids), and when both the session token and the
// order carry a customer id they must denote the same customer.
// Returns `{ offer: ThankYouOffer | null }`. Never 500s.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { gidToNumber, toGid } from "../lib/json";
import { getSettings } from "../services/settings.server";
import { assembleThankYouOffer } from "../services/offer-orchestrator.server";
import type { AdminGraphql, PurchaseContext, PurchaseLineItem } from "../types";

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  try {
    const token = sessionToken as any;
    const shop: string =
      typeof token?.dest === "string" && token.dest
        ? new URL(token.dest).hostname
        : typeof token?.input_data?.shop?.domain === "string"
          ? token.input_data.shop.domain
          : "";
    if (!shop) return cors(json({ offer: null }));

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    if (!body || typeof body !== "object") body = {};

    const settings = await getSettings(shop);
    if (settings.thankYouEnabled === false) return cors(json({ offer: null }));

    // The order id (gid or numeric) is required — it is the only untrusted
    // body field that drives the lookup, and it is verified server-side below.
    const orderIdRaw =
      body?.orderId !== null && body?.orderId !== undefined && body?.orderId !== ""
        ? String(body.orderId)
        : null;
    if (!orderIdRaw) return cors(json({ offer: null }));
    const orderNumericId = gidToNumber(orderIdRaw);
    if (!Number.isFinite(orderNumericId)) return cors(json({ offer: null }));

    // Body may only contribute the display language. A missing locale stays
    // empty so resolveLanguageWithSource applies the market override → store
    // default chain instead of forcing English.
    const locale = typeof body?.locale === "string" && body.locale ? body.locale : "";

    // Offline admin client — used for the order fallback fetch and for
    // discountCodeBasicCreate. Best-effort: without it the orchestrator
    // degrades to a code-less offer (or no offer when the order is unknown).
    let graphql: AdminGraphql | null = null;
    try {
      const { admin } = await unauthenticated.admin(shop);
      graphql = admin.graphql as unknown as AdminGraphql;
    } catch (error) {
      console.error(`[api.typ-offer] unauthenticated admin unavailable for ${shop}`, error);
    }

    const ctx =
      (await contextFromOrderRecord(shop, orderNumericId, locale)) ??
      (graphql ? await contextFromAdminOrder(graphql, shop, orderNumericId, locale) : null);
    if (!ctx) return cors(json({ offer: null }));

    // Customer binding: when the verified session token identifies a customer
    // AND the order has one, they must denote the same customer — a logged-in
    // buyer must not mint codes against someone else's order. Skipped when
    // either side is absent (guest checkout, tokens without a sub claim).
    const tokenCustomer = numericTail(token?.sub ?? token?.input_data?.customer?.id);
    const orderCustomer = numericTail(ctx.customerId);
    if (tokenCustomer && orderCustomer && tokenCustomer !== orderCustomer) {
      return cors(json({ offer: null }));
    }

    const offer = await assembleThankYouOffer(ctx, graphql);
    return cors(json({ offer }));
  } catch (error) {
    console.error("[api.typ-offer] failed", error);
    return cors(json({ offer: null }));
  }
};

// ── Server-side purchase context builders ────────────────────────────────────

/** Orders older than this are refused — the thank-you page is shown right
 *  after checkout, so anything beyond an hour is not a live thank-you visit. */
const ORDER_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * True when the order was created within ORDER_MAX_AGE_MS. Accepts a Date or
 * an ISO string (webhook `created_at` / admin `createdAt`); missing or
 * unparseable values fail closed so freshness can never be skipped.
 */
function isRecentOrder(createdAt: unknown): boolean {
  const t =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ""));
  return Number.isFinite(t) && Date.now() - t <= ORDER_MAX_AGE_MS;
}

/**
 * Build the context from the OrderRecord captured by the orders/create
 * webhook. The stored orderId may be a gid or a numeric string — endsWith
 * narrows the scan, the exact trailing-numeric match below decides.
 */
async function contextFromOrderRecord(
  shop: string,
  orderNumericId: number,
  locale: string,
): Promise<PurchaseContext | null> {
  try {
    const candidates = await prisma.orderRecord.findMany({
      where: { shop, orderId: { endsWith: String(orderNumericId) } },
      include: { lines: true },
    });
    const record = candidates.find((r) => gidToNumber(r.orderId) === orderNumericId);
    if (!record) return null;
    if (!isRecentOrder(record.createdAt)) return null;

    const lineItems: PurchaseLineItem[] = record.lines.map((line) => ({
      productId: toGid("Product", line.productId),
      variantId: line.variantId ? toGid("ProductVariant", line.variantId) : null,
      quantity: line.quantity,
      priceAmount: line.price,
      title: line.title || undefined,
    }));

    return {
      shop,
      referenceId: `typ:${orderNumericId}`,
      customerId: record.customerId ?? null,
      countryCode: record.country ?? null,
      locale,
      currency: record.currency || "EUR",
      totalAmount: record.totalPrice,
      lineItems,
      surface: "thank_you",
    };
  } catch (error) {
    console.error(`[api.typ-offer] order record lookup failed for ${shop}`, error);
    return null;
  }
}

const ORDER_LOOKUP_QUERY = `#graphql
  query cellexiaThankYouOrder($id: ID!) {
    order(id: $id) {
      id
      createdAt
      customer {
        id
      }
      shippingAddress {
        countryCode
      }
      totalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          product {
            id
          }
          variant {
            id
          }
          originalUnitPriceSet {
            presentmentMoney {
              amount
            }
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

/**
 * Fallback when the webhook has not landed yet: ONE server-side order fetch
 * via the offline admin client. Returns null when the order does not exist
 * for this shop (an attacker cannot fabricate a context for it).
 */
async function contextFromAdminOrder(
  graphql: AdminGraphql,
  shop: string,
  orderNumericId: number,
  locale: string,
): Promise<PurchaseContext | null> {
  try {
    const response = await graphql(ORDER_LOOKUP_QUERY, {
      variables: { id: toGid("Order", orderNumericId) },
    });
    const body: any = await response.json();
    const order = body?.data?.order;
    if (!order) return null;
    if (!isRecentOrder(order?.createdAt ?? order?.created_at)) return null;

    // Shop money preferred (mirrors api.offer.tsx: rule min/max totals,
    // discount tiers and catalog prices are shop-currency, so threshold math
    // in presentment currency would be wrong); presentment only as fallback.
    const money = order?.totalPriceSet?.shopMoney ?? order?.totalPriceSet?.presentmentMoney;
    const nodes: any[] = Array.isArray(order?.lineItems?.nodes) ? order.lineItems.nodes : [];
    const lineItems: PurchaseLineItem[] = [];
    for (const node of nodes) {
      const productId = node?.product?.id;
      if (typeof productId !== "string" || !productId) continue;
      const unitMoney =
        node?.originalUnitPriceSet?.shopMoney ?? node?.originalUnitPriceSet?.presentmentMoney;
      lineItems.push({
        productId,
        variantId:
          typeof node?.variant?.id === "string" && node.variant.id ? node.variant.id : null,
        quantity: toQuantity(node?.quantity),
        priceAmount: toAmount(unitMoney?.amount),
        title: typeof node?.title === "string" ? node.title : undefined,
      });
    }

    return {
      shop,
      referenceId: `typ:${orderNumericId}`,
      customerId: normalizeId(order?.customer?.id),
      countryCode:
        typeof order?.shippingAddress?.countryCode === "string" &&
        order.shippingAddress.countryCode
          ? order.shippingAddress.countryCode
          : null,
      locale,
      currency:
        typeof money?.currencyCode === "string" && money.currencyCode
          ? money.currencyCode
          : "EUR",
      totalAmount: toAmount(money?.amount) ?? 0,
      lineItems,
      surface: "thank_you",
    };
  } catch (error) {
    console.error(`[api.typ-offer] admin order lookup failed for ${shop}`, error);
    return null;
  }
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Trailing digits of an id ("gid://shopify/Customer/777" | 777 | "777" →
 * "777"); absent or non-numeric → null so comparisons can be skipped.
 */
function numericTail(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).match(/(\d+)$/)?.[1] ?? null;
}

/** "gid://shopify/Customer/123" | 123 | "123" → "123"; empty → null. */
function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  if (s.startsWith("gid://")) {
    const n = gidToNumber(s);
    return Number.isNaN(n) ? s : String(n);
  }
  return s;
}

function toQuantity(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function toAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
