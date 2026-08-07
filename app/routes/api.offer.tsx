// ─────────────────────────────────────────────────────────────────────────────
// POST /api/offer — called by the post-purchase extension's ShouldRender (and
// again by Render in the Shop Pay re-fetch case) with the checkout JWT as
// `Authorization: Bearer <token>`. Builds a PurchaseContext EXCLUSIVELY from
// the token's input_data — the request body is never read — and returns the
// assembled OfferResponse. Never 500s — internal errors → `{ offers: [] }`.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { gidToNumber, toGid } from "../lib/json";
import { assembleOfferResponse } from "../services/offer-orchestrator.server";
import type { PurchaseContext, PurchaseLineItem } from "../types";

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  try {
    const token = sessionToken as any;
    const inputData: any = token?.input_data ?? {};
    const purchase: any = inputData?.initialPurchase ?? {};

    const shop: string =
      typeof inputData?.shop?.domain === "string" && inputData.shop.domain
        ? inputData.shop.domain
        : new URL(typeof token?.dest === "string" ? token.dest : "https://x").hostname;

    const ctx = buildPurchaseContext(shop, inputData, purchase);
    const response = await assembleOfferResponse(ctx);
    return cors(json(response));
  } catch (error) {
    console.error("[api.offer] failed", error);
    return cors(json({ offers: [] }));
  }
};

// ── Purchase context construction ────────────────────────────────────────────

function buildPurchaseContext(
  shop: string,
  inputData: any,
  purchase: any,
): PurchaseContext {
  // Everything comes exclusively from the verified token's input_data — the
  // request body is untrusted and never read. Shop money preferred (rule
  // min/max totals, discount tiers and catalog prices are shop-currency, so
  // threshold math in presentment currency would be wrong); presentment only
  // when shopMoney is absent.
  const money =
    purchase?.totalPriceSet?.shopMoney ?? purchase?.totalPriceSet?.presentmentMoney ?? null;
  const totalAmount = toAmount(money?.amount) ?? 0;
  const currency =
    typeof money?.currencyCode === "string" && money.currencyCode
      ? money.currencyCode
      : "EUR";

  const rawLines: any[] = Array.isArray(purchase?.lineItems) ? purchase.lineItems : [];
  const lineItems: PurchaseLineItem[] = [];
  for (const line of rawLines) {
    const productId = line?.product?.id;
    if (productId === null || productId === undefined || productId === "") continue;
    const lineMoney =
      line?.totalPriceSet?.shopMoney ?? line?.totalPriceSet?.presentmentMoney ?? null;
    const variantId = line?.product?.variant?.id;
    lineItems.push({
      productId: toGid("Product", productId),
      variantId:
        variantId !== null && variantId !== undefined && variantId !== ""
          ? toGid("ProductVariant", variantId)
          : null,
      quantity: toQuantity(line?.quantity),
      priceAmount: toAmount(lineMoney?.amount),
      title: typeof line?.product?.title === "string" ? line.product.title : undefined,
    });
  }
  // referenceId comes EXCLUSIVELY from the verified token's initialPurchase —
  // a session token without one (e.g. a thank-you token) must never mint
  // IssuedOffers under an attacker-chosen id from the request body.
  const referenceId =
    purchase?.referenceId !== null &&
    purchase?.referenceId !== undefined &&
    purchase?.referenceId !== ""
      ? String(purchase.referenceId)
      : crypto.randomUUID();

  return {
    shop,
    referenceId,
    // customerId comes ONLY from the verified token (null for guest checkout)
    // — never from the request body.
    customerId: normalizeId(purchase?.customerId),
    countryCode:
      typeof purchase?.destinationCountryCode === "string" && purchase.destinationCountryCode
        ? purchase.destinationCountryCode
        : null,
    // Missing locale stays empty so resolveLanguageWithSource applies the
    // market override → store default chain instead of forcing English.
    locale:
      typeof inputData?.locale === "string" && inputData.locale ? inputData.locale : "",
    currency,
    totalAmount,
    lineItems,
    surface: "post_purchase",
  };
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
