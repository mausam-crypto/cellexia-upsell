// ─────────────────────────────────────────────────────────────────────────────
// POST /api/offer — called by the post-purchase extension's ShouldRender (and
// again by Render in the Shop Pay re-fetch case) with the checkout JWT as
// `Authorization: Bearer <token>`. Builds a PurchaseContext EXCLUSIVELY from
// the token's input_data — the request body is never read — and returns the
// assembled OfferResponse. Never 500s — internal errors → `{ offers: [] }`.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticateCheckoutPublic } from "../lib/public-auth.server";
import { gidToNumber, toGid } from "../lib/json";
import { recordOfferInquiry } from "../services/inquiry-log.server";
import {
  assembleOfferResponse,
  POST_PURCHASE_ASSEMBLY_BUDGET_MS,
  type AssembleOfferOptions,
} from "../services/offer-orchestrator.server";
import type { PurchaseContext, PurchaseLineItem } from "../types";

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticateCheckoutPublic(request, "api.offer");
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const startedAt = Date.now();
  const { cors, sessionToken } = await authenticateCheckoutPublic(request, "api.offer");
  let shopForLog = "?";
  let refForLog = "?";
  try {
    const token = sessionToken as any;
    const inputData: any = token?.input_data ?? {};
    const purchase: any = inputData?.initialPurchase ?? {};

    const shop: string =
      typeof inputData?.shop?.domain === "string" && inputData.shop.domain
        ? inputData.shop.domain
        : new URL(typeof token?.dest === "string" ? token.dest : "https://x").hostname;
    shopForLog = shop;

    const built = buildPurchaseContext(shop, inputData, purchase);
    const ctx = built.ctx;
    refForLog = ctx.referenceId;
    // ShouldRender budget: Shopify only takes the post-purchase detour when
    // this call has resolved BEFORE the order is processed (and it re-runs
    // the inquiry on every total/currency/country change), so the assembly
    // is time-boxed — see POST_PURCHASE_ASSEMBLY_BUDGET_MS.
    const options: AssembleOfferOptions = {
      deadlineAt: startedAt + POST_PURCHASE_ASSEMBLY_BUDGET_MS,
    };
    const response = await assembleOfferResponse(ctx, options);
    // One line per ShouldRender call — the only production trace of WHY a
    // buyer did or did not get a page (Debug-tab traces are opt-in).
    const tookMs = Date.now() - startedAt;
    const corePending = response.offers.some((o) => o.corePending);
    console.log(
      `[api.offer] shop=${shop} ref=${ctx.referenceId} country=${ctx.countryCode ?? "-"} locale=${ctx.locale || "-"} currency=${ctx.currency}${ctx.presentmentCurrency ? `/${ctx.presentmentCurrency}` : ""} lines=${ctx.lineItems.length} total=${ctx.totalAmount}${built.totalSource !== "total" ? `(${built.totalSource})` : ""} customer=${ctx.customerId ? "yes" : "guest"} offers=${response.offers.length}${corePending ? " corePending" : ""} tookMs=${tookMs}${response.offers.length === 0 && options.emptyReason ? ` reason="${options.emptyReason}"` : ""}`,
    );
    // Durable twin of the log line (Debug tab → ShouldRender inquiries; the
    // extension-traffic health check). Fire-and-forget, after the response
    // is fully computed — adds nothing to the ShouldRender latency.
    recordOfferInquiry({
      shop,
      referenceId: ctx.referenceId,
      countryCode: ctx.countryCode,
      currency: ctx.currency,
      presentment: ctx.presentmentCurrency ?? null,
      customerId: ctx.customerId,
      lines: ctx.lineItems.length,
      totalAmount: ctx.totalAmount,
      totalSource: built.totalSource,
      offers: response.offers.length,
      corePending,
      emptyReason: response.offers.length === 0 ? (options.emptyReason ?? "no reason recorded") : null,
      tookMs,
    });
    return cors(json(response));
  } catch (error) {
    const tookMs = Date.now() - startedAt;
    console.error(`[api.offer] failed shop=${shopForLog} ref=${refForLog} tookMs=${tookMs}`, error);
    if (shopForLog !== "?" && refForLog !== "?") {
      recordOfferInquiry({
        shop: shopForLog,
        referenceId: refForLog,
        countryCode: null,
        currency: null,
        presentment: null,
        customerId: null,
        lines: 0,
        totalAmount: 0,
        totalSource: "none",
        offers: 0,
        corePending: false,
        emptyReason: `route crashed: ${error instanceof Error ? error.message : String(error)}`,
        tookMs,
      });
    }
    return cors(json({ offers: [] }));
  }
};

// ── Purchase context construction ────────────────────────────────────────────

function buildPurchaseContext(
  shop: string,
  inputData: any,
  purchase: any,
): { ctx: PurchaseContext; totalSource: "total" | "lines" | "none" } {
  // Everything comes exclusively from the verified token's input_data — the
  // request body is untrusted and never read. Shop money preferred (rule
  // min/max totals, discount tiers and catalog prices are shop-currency, so
  // threshold math in presentment currency would be wrong); presentment only
  // when shopMoney is absent.
  const money =
    purchase?.totalPriceSet?.shopMoney ?? purchase?.totalPriceSet?.presentmentMoney ?? null;
  const reportedTotal = toAmount(money?.amount) ?? 0;
  const currency =
    typeof money?.currencyCode === "string" && money.currencyCode
      ? money.currencyCode
      : "EUR";
  // Buyer-facing DISPLAY conversion implied by this order's own totals —
  // engine math stays on the shop-currency values above; the orchestrator
  // only uses these to convert the prices shown on the page.
  const presentment = derivePresentment(purchase?.totalPriceSet);

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

  // Observed on the live store (2026-08-18): Shopify runs ShouldRender as soon
  // as the checkout mounts and again on every total/currency/country change,
  // and the EARLY inquiries carry initialPurchase.totalPriceSet = 0.0 while
  // the line items already carry their real totals. A zero total would make
  // every rule with a minimum order value miss and pick the lowest discount
  // tier for that inquiry — so when the reported total is not positive, fall
  // back to the sum of the line totals (basket value; shipping/tax excluded,
  // which is what rule thresholds mean anyway). Which one was used is logged.
  const linesTotal = lineItems.reduce((sum, li) => sum + (li.priceAmount ?? 0), 0);
  let totalAmount = reportedTotal;
  let totalSource: "total" | "lines" | "none" = "total";
  if (!(reportedTotal > 0)) {
    if (linesTotal > 0) {
      totalAmount = Math.round(linesTotal * 100) / 100;
      totalSource = "lines";
    } else {
      totalAmount = 0;
      totalSource = "none";
    }
  }

  const ctx: PurchaseContext = {
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
    presentmentCurrency: presentment.currency,
    presentmentRate: presentment.rate,
  };
  return { ctx, totalSource };
}

/**
 * Derives the buyer's display currency and the FX rate implied by the order's
 * own totals: presentmentMoney.amount / shopMoney.amount, only when BOTH
 * amounts parse to > 0 and the two currency codes are present and differ.
 * Same currency (or missing/unparseable amounts) → rate null, so display
 * falls back to shop-currency prices, which are always correct.
 */
function derivePresentment(totalPriceSet: any): {
  currency: string | null;
  rate: number | null;
} {
  const shopMoney = totalPriceSet?.shopMoney;
  const presentmentMoney = totalPriceSet?.presentmentMoney;
  const shopCurrency =
    typeof shopMoney?.currencyCode === "string" ? shopMoney.currencyCode : "";
  const presentmentCurrency =
    typeof presentmentMoney?.currencyCode === "string" ? presentmentMoney.currencyCode : "";
  if (!shopCurrency || !presentmentCurrency || shopCurrency === presentmentCurrency) {
    return { currency: null, rate: null };
  }
  const shopAmount = toAmount(shopMoney?.amount);
  const presentmentAmount = toAmount(presentmentMoney?.amount);
  const rate =
    shopAmount !== null && presentmentAmount !== null && shopAmount > 0 && presentmentAmount > 0
      ? presentmentAmount / shopAmount
      : null;
  return { currency: presentmentCurrency, rate };
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
