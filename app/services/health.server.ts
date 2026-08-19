// ─────────────────────────────────────────────────────────────────────────────
// Live health checks — "will this break on the live store?" as running code.
//
// Local debugging can't see production-only failure modes: a stale APP_URL
// baked into the deployed extension, a missing scope after reinstall, an
// unregistered webhook, an invalid model id, a language with untranslated
// strings, SQLite in production, clock skew breaking 10-minute changeset JWTs.
// This module turns each of those into an explicit check that runs against the
// REAL store through the SAME code paths buyers hit (selectOffers,
// signChangesetToken, getContextualPrices, claudeComplete, Admin GraphQL via
// the offline session) — never lookalike re-implementations.
//
// Contracts:
// - runHealthChecks never throws; a crashed check is itself a "fail" finding.
// - Checks are read-only against live data except three self-cleaning probes:
//   changeset-signing (writes + deletes one synthetic IssuedOffer row),
//   event-dedup (two inserts, expects the unique-constraint loss, deletes),
//   and — DEEP RUNS ONLY, explicit button — discount-roundtrip (creates and
//   immediately deletes a 1% test discount code).
// - Every check has a per-check timeout so one hung dependency can't stall
//   the battery, and a `fix` hint so a red row says what to do next.
// - Results persist to HealthCheckRun (pruned to the last 50 runs) so the
//   Debug tab shows history and /api/health can serve external monitors.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import prisma from "../db.server";
import { jparse, jstr, gidToNumber } from "../lib/json";
import { signChangesetToken, verifyChangesetToken } from "../lib/changeset-token.server";
import { getSettings } from "./settings.server";
import {
  getActiveProducts,
  pickPrimaryVariant,
  explainProductName,
  languagesMatch,
  type CatalogProduct,
} from "./catalog.server";
import { selectOffers } from "./recommendation.server";
import { getContextualPrices } from "./market-pricing.server";
import { claudeComplete, translateTexts, type PromptKey } from "./ai.server";
import {
  UI_STRING_KEYS,
  type AdminGraphql,
  type AppSettings,
  type OfferChange,
  type PurchaseContext,
} from "../types";
import { inquiryStats, scrubReason } from "./inquiry-log.server";
import { APP_VERSION } from "../lib/version";

// ── Public types ─────────────────────────────────────────────────────────────

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheckResult {
  /** Stable id, e.g. "billing.changeset-signing". */
  id: string;
  group: string;
  name: string;
  status: HealthStatus;
  /** One-line human outcome. */
  summary: string;
  /** JSON-serializable evidence (counts, latencies, offending rows). */
  detail?: unknown;
  /** What to do when not ok. */
  fix?: string;
  tookMs: number;
}

export interface HealthRun {
  id: string;
  trigger: string;
  deep: boolean;
  status: "ok" | "warn" | "fail";
  okCount: number;
  warnCount: number;
  failCount: number;
  skipCount: number;
  tookMs: number;
  createdAt: string;
  results: HealthCheckResult[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Scopes the app's features need — mirror of shopify.app.toml / .env SCOPES. */
const REQUIRED_SCOPES: Array<{ scope: string; breaks: string }> = [
  { scope: "read_products", breaks: "catalog sync — offers select from stale/empty data" },
  { scope: "read_orders", breaks: "order history, analytics, thank-you order guard" },
  { scope: "read_inventory", breaks: "inventory-based offer suppression" },
  { scope: "read_locales", breaks: "language sync for the 17-language store" },
  { scope: "read_markets", breaks: "per-market pricing, gating and language overrides" },
  { scope: "read_translations", breaks: "Translate & Adapt name/description sync — buyers see base-language product names in all 17 languages" },
  { scope: "write_discounts", breaks: "thank-you page discount codes (offers go codeless)" },
];

/**
 * Webhook topics shopify.app.toml must declare (toml notation). This app's
 * webhooks are app-config-managed (include_config_on_deploy) — Shopify's
 * webhookSubscriptions query does NOT return TOML-declared subscriptions, so
 * registration is verified by (a) parsing the toml when it ships with the
 * deployment and (b) delivery evidence (order-ingestion / catalog checks).
 */
const REQUIRED_WEBHOOK_TOPICS: Array<{ topic: string; breaks: string }> = [
  { topic: "orders/create", breaks: "order history, suppression, affinity, analytics" },
  { topic: "orders/updated", breaks: "payment-recovery revenue backfill (failed one-click charges stay at €0)" },
  { topic: "products/create", breaks: "catalog freshness for new products" },
  { topic: "products/update", breaks: "catalog freshness — price/status/translation changes" },
  { topic: "products/delete", breaks: "removing deleted products from the offer pool" },
  { topic: "app/uninstalled", breaks: "session cleanup on uninstall" },
  { topic: "app/scopes_update", breaks: "session scope tracking after permission changes" },
];

const CHECK_TIMEOUT_MS = 12_000;
const AUTO_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000; // background cadence via admin loaders
const RUNS_KEPT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Shared per-run context ───────────────────────────────────────────────────

interface Ctx {
  shop: string;
  settings: AppSettings;
  deep: boolean;
  /** What started this run — background triggers keep external costs minimal. */
  trigger: "manual" | "auto" | "external";
  /** Admin GraphQL client from the shop's offline session; null when broken. */
  graphql: AdminGraphql | null;
  graphqlError: string | null;
  shopInfo: {
    name: string;
    currencyCode: string;
    primaryDomainHost: string | null;
  } | null;
  graphqlLatencyMs: number | null;
  deprecationReason: string | null;
  /** Shopify's Date response header, ms since epoch — clock-skew reference. */
  shopifyDateMs: number | null;
}

/** Parse an admin.graphql Response; throw a descriptive error on failures. */
async function gql(
  graphql: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: any; response: Response }> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as any;
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(body.errors.map((e: any) => e?.message ?? "unknown").join("; "));
  }
  return { data: body?.data ?? {}, response };
}

async function buildContext(
  shop: string,
  deep: boolean,
  trigger: Ctx["trigger"],
): Promise<Ctx> {
  const ctx: Ctx = {
    shop,
    settings: null as unknown as AppSettings,
    deep,
    trigger,
    graphql: null,
    graphqlError: null,
    shopInfo: null,
    graphqlLatencyMs: null,
    deprecationReason: null,
    shopifyDateMs: null,
  };
  // Settings must load or nothing else is meaningful — but even that failure
  // must surface as check results, so fall back to defaults via getSettings's
  // own resilience and record DB trouble in the database check.
  ctx.settings = await getSettings(shop);

  try {
    // Same offline-session pattern the live pricing/thank-you paths use.
    // Bounded — a hung session store must not stall the whole battery before
    // the per-check timeouts even start.
    const admin = await Promise.race([
      (async () => {
        const { unauthenticated } = await import("../shopify.server");
        return (await unauthenticated.admin(shop)).admin;
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("offline session lookup timed out (8s)")), 8000).unref?.();
      }),
    ]);
    ctx.graphql = admin.graphql as unknown as AdminGraphql;
  } catch (error) {
    ctx.graphqlError = error instanceof Error ? error.message : String(error);
  }

  if (ctx.graphql) {
    try {
      const started = Date.now();
      const { data, response } = await Promise.race([
        gql(
          ctx.graphql,
          `#graphql
          query cellexiaHealthShop {
            shop {
              name
              currencyCode
              primaryDomain { host }
            }
          }`,
        ),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("shop query timed out (8s)")), 8000).unref?.();
        }),
      ]);
      ctx.graphqlLatencyMs = Date.now() - started;
      ctx.deprecationReason = response.headers.get("x-shopify-api-deprecated-reason");
      const dateHeader = response.headers.get("date");
      if (dateHeader) {
        const ms = Date.parse(dateHeader);
        if (Number.isFinite(ms)) ctx.shopifyDateMs = ms;
      }
      const s = data?.shop;
      if (s?.name) {
        ctx.shopInfo = {
          name: String(s.name),
          currencyCode: String(s.currencyCode ?? ""),
          primaryDomainHost: s.primaryDomain?.host ? String(s.primaryDomain.host) : null,
        };
      }
    } catch (error) {
      ctx.graphqlError = error instanceof Error ? error.message : String(error);
    }
  }
  return ctx;
}

// ── Small helpers ────────────────────────────────────────────────────────────

type CheckOutcome = Omit<HealthCheckResult, "id" | "group" | "name" | "tookMs">;
interface CheckDef {
  id: string;
  group: string;
  name: string;
  run: (ctx: Ctx) => Promise<CheckOutcome>;
}

function ok(summary: string, detail?: unknown): CheckOutcome {
  return { status: "ok", summary, ...(detail !== undefined ? { detail } : {}) };
}
function warn(summary: string, fix: string, detail?: unknown): CheckOutcome {
  return { status: "warn", summary, fix, ...(detail !== undefined ? { detail } : {}) };
}
function fail(summary: string, fix: string, detail?: unknown): CheckOutcome {
  return { status: "fail", summary, fix, ...(detail !== undefined ? { detail } : {}) };
}
function skip(summary: string): CheckOutcome {
  return { status: "skip", summary };
}

function hostOf(url: string | undefined | null): string | null {
  try {
    return url ? new URL(url).host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function baseLang(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

/** One plain HTTPS GET (no auto-headers, no redirect following, no gzip). */
function httpsGet(
  url: string,
  cookie: string,
  timeoutMs: number,
): Promise<{ status: number; location: string | null; setCookies: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          // Shopify's checkout serves the full page only to browser-like
          // clients — and refuses undici/fetch, which stamps
          // `sec-fetch-mode: cors` on every request (403 "Request Forbidden").
          // A plain node:https GET with browser-like headers is accepted.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en",
          "Accept-Encoding": "identity",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          // The checkout HTML is ~400 KB; cap defensively.
          if (body.length < 2_000_000) body += chunk;
        });
        res.on("end", () => {
          const sc = res.headers["set-cookie"];
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [],
            body,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`storefront request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a storefront page the way a browser would: follow redirects by hand
 * and carry the cookies each host sets. A cart permalink (/cart/<variant>:1)
 * redirects (via shop.app) to the checkout page, which answers 403 unless the
 * cart cookies from the first hop are presented — so cookies are kept per
 * host across hops. Bounded to 6 hops and ~9s total.
 */
async function fetchStorefrontPage(
  startUrl: string,
  deadlineAt: number = Date.now() + 9000,
): Promise<{ finalUrl: string; status: number; html: string }> {
  const deadline = deadlineAt;
  const jar = new Map<string, Map<string, string>>();
  let url = startUrl;
  for (let hop = 0; hop < 6; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("storefront fetch timed out");
    const host = new URL(url).host;
    const cookies = jar.get(host) ?? new Map<string, string>();
    jar.set(host, cookies);
    const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await httpsGet(url, cookieHeader, remaining);
    for (const raw of response.setCookies) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) return { finalUrl: url, status: response.status, html: "" };
      url = new URL(response.location, url).toString();
      continue;
    }
    return { finalUrl: url, status: response.status, html: response.body };
  }
  throw new Error("too many redirects");
}

/**
 * Shopify never surfaces the post-purchase page for wallets, installment
 * services, PayPal, gift cards, bank transfers or COD ("any payment method
 * other than a credit card"). Gateway names as they appear in
 * Order.paymentGatewayNames / the orders webhook payment_gateway_names.
 * `shopify_payments` covers cards AND Shop Pay (eligible) — wallets paid
 * through Shopify Payments show up as separate names (apple_pay/google_pay)
 * only on some payloads, so this is a best-effort classification: it never
 * flags a card as ineligible; it may miss a wallet hidden behind
 * shopify_payments.
 */
export function isNonCardGateway(gateway: string): boolean {
  const g = gateway.toLowerCase();
  return /paypal|klarna|afterpay|clearpay|affirm|sezzle|installment|apple[_ ]?pay|google[_ ]?pay|android[_ ]?pay|amazon|ideal|bancontact|sofort|giropay|\beps\b|przelewy|\bp24\b|blik|mobilepay|vipps|swish|twint|bank[_ ]?deposit|bank[_ ]?transfer|money[_ ]?order|\bcash\b|\bcod\b|manual|gift[_ ]?card|bogus|\btest\b/.test(g);
}

/**
 * Why Shopify itself would never show the post-purchase page for an order,
 * from the facts the orders webhook gives us. Returns null when no platform
 * gate is known to apply (the page may still be skipped for reasons only
 * Shopify sees: card vaulting / 3-D Secure, duties, local delivery, order-
 * creation delay). Verified on the live store 2026-08-18: non-shop-currency
 * checkouts get `PostPurchaseDataFailed { code: MULTI_CURRENCY }` before any
 * ShouldRender runs.
 */
export function postPurchasePlatformGate(
  gateway: string | null | undefined,
  presentment: string | null | undefined,
  sourceName: string | null | undefined,
  shopCurrency: string,
): string | null {
  const gates: string[] = [];
  if (presentment && shopCurrency && presentment !== shopCurrency) {
    gates.push(`paid in ${presentment} ≠ shop currency ${shopCurrency} (Shopify: MULTI_CURRENCY)`);
  }
  if (gateway) {
    const bad = gateway.split(",").map((g) => g.trim()).filter((g) => g && isNonCardGateway(g));
    if (bad.length > 0) gates.push(`payment method ${bad.join("/")} (Shopify: cards only)`);
  }
  if (sourceName && sourceName !== "web") {
    gates.push(`sales channel "${sourceName}" (Shopify: Online Store only)`);
  }
  return gates.length > 0 ? gates.join("; ") : null;
}

/**
 * Card-only rule from Shopify's transaction paymentDetails (precise: wallets
 * paid THROUGH Shopify Payments still show gateway "shopify_payments" but a
 * CardPaymentDetails.wallet of APPLE_PAY/GOOGLE_PAY/ANDROID_PAY; PayPal, local
 * methods and Shop Pay Installments carry their own paymentDetails types).
 * SHOPIFY_PAY (Shop Pay) stays eligible per Shopify's docs. Returns null when
 * nothing is known (no transactions readable) so callers fall back to the
 * gateway-name heuristic.
 */
export function nonCardFromTransactions(
  transactions: Array<{ gateway?: string | null; paymentDetails?: { __typename?: string; wallet?: string | null } | null }> | null | undefined,
): string | null {
  if (!transactions || transactions.length === 0) return null;
  for (const t of transactions) {
    const pd = t.paymentDetails;
    if (!pd || !pd.__typename) continue;
    if (pd.__typename !== "CardPaymentDetails") return pd.__typename.replace(/PaymentDetails$/, "") || pd.__typename;
    const wallet = (pd.wallet ?? "").toUpperCase();
    if (wallet && wallet !== "SHOPIFY_PAY") return wallet;
  }
  return null;
}

/** Offer-eligible products exactly as the engine's suppression sees them. */
function offerablePool(products: CatalogProduct[], settings: AppSettings) {
  const gates = { notEligible: 0, noVariant: 0, zeroPrice: 0, lowInventory: 0 };
  const eligible: Array<{ product: CatalogProduct; variant: NonNullable<ReturnType<typeof pickPrimaryVariant>> }> = [];
  for (const product of products) {
    if (!product.upsellEligible) {
      gates.notEligible++;
      continue;
    }
    const variant = pickPrimaryVariant(product);
    if (!variant) {
      gates.noVariant++;
      continue;
    }
    if (!(variant.price > 0)) {
      gates.zeroPrice++;
      continue;
    }
    if (variant.inventoryQuantity !== null && variant.inventoryQuantity < settings.minInventory) {
      gates.lowInventory++;
      continue;
    }
    eligible.push({ product, variant });
  }
  return { eligible, gates };
}

// ── The checks ───────────────────────────────────────────────────────────────

const CHECKS: CheckDef[] = [
  // ═══ Environment & deployment ═══════════════════════════════════════════
  {
    id: "env.vars",
    group: "Environment",
    name: "Environment variables",
    run: async (ctx) => {
      const required = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "DATABASE_URL"];
      const missing = required.filter((k) => !process.env[k]);
      if (ctx.settings.aiEnabled && !process.env.ANTHROPIC_API_KEY) {
        missing.push("ANTHROPIC_API_KEY (AI copy is enabled)");
      }
      if (ctx.settings.translationProvider === "deepl" && !process.env.DEEPL_API_KEY) {
        missing.push("DEEPL_API_KEY (translation provider is DeepL)");
      }
      const envScopes = (process.env.SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const missingScopes = REQUIRED_SCOPES.filter((r) => !envScopes.includes(r.scope));
      if (missing.length > 0) {
        return fail(
          `Missing: ${missing.join(", ")}`,
          "Set the missing variables in the hosting provider's environment settings and redeploy.",
          { missing },
        );
      }
      if (missingScopes.length > 0) {
        return warn(
          `SCOPES env is missing: ${missingScopes.map((m) => m.scope).join(", ")}`,
          "Add the missing scopes to SCOPES (comma-separated) and to shopify.app.toml, then run `shopify app deploy` and re-open the app to re-authorize.",
          { missingScopes },
        );
      }
      return ok("All required environment variables are set.");
    },
  },
  {
    id: "env.app-url",
    group: "Environment",
    name: "App URL & deployed extension URL",
    run: async () => {
      const appUrl = process.env.SHOPIFY_APP_URL ?? "";
      const appHost = hostOf(appUrl);
      const problems: string[] = [];
      const detail: Record<string, unknown> = { appUrl };
      if (!appUrl) return fail("SHOPIFY_APP_URL is not set.", "Set SHOPIFY_APP_URL to the public https URL of this deployment.");
      if (!appUrl.startsWith("https://")) problems.push("SHOPIFY_APP_URL is not https — Shopify requires https in production.");
      if (/example\.com|replace/i.test(appUrl)) problems.push("SHOPIFY_APP_URL still looks like a placeholder.");

      // The post-purchase extension bakes its backend URL in at deploy time —
      // the #1 silent live-breaker. Compare the source constant when the repo
      // ships alongside the server (be honest in the summary when it doesn't:
      // the DEPLOYED bundle can only be judged by the extension-traffic check).
      let extensionSourceRead = false;
      try {
        const src = await readFile(
          path.resolve(process.cwd(), "extensions/post-purchase-upsell/src/index.jsx"),
          "utf8",
        );
        const m = src.match(/APP_URL\s*=\s*["']([^"']+)["']/);
        if (m) {
          extensionSourceRead = true;
          detail.extensionAppUrl = m[1];
          if (/replace|example\.com/i.test(m[1])) {
            problems.push(
              "extensions/post-purchase-upsell/src/index.jsx APP_URL is still the placeholder — the DEPLOYED extension cannot reach this backend and buyers never see post-purchase offers.",
            );
          } else if (hostOf(m[1]) !== appHost) {
            problems.push(
              `Extension APP_URL (${m[1]}) points at a different host than SHOPIFY_APP_URL — if that's what was last deployed with \`shopify app deploy\`, live buyers are calling the wrong backend.`,
            );
          }
        }
      } catch {
        detail.extensionAppUrl = "source not readable from this deployment — verified indirectly by the extension-traffic check";
      }

      try {
        const toml = await readFile(path.resolve(process.cwd(), "shopify.app.toml"), "utf8");
        const clientId = toml.match(/^client_id\s*=\s*"([^"]*)"/m)?.[1];
        const applicationUrl = toml.match(/^application_url\s*=\s*"([^"]*)"/m)?.[1];
        detail.tomlClientId = clientId;
        detail.tomlApplicationUrl = applicationUrl;
        if (clientId && /replace/i.test(clientId)) problems.push("shopify.app.toml client_id is still the placeholder.");
        else if (clientId && process.env.SHOPIFY_API_KEY && clientId !== process.env.SHOPIFY_API_KEY) {
          problems.push("shopify.app.toml client_id differs from SHOPIFY_API_KEY — the CLI would deploy extensions to a DIFFERENT app than this backend serves.");
        }
        if (applicationUrl && hostOf(applicationUrl) !== appHost && !/replace/i.test(applicationUrl)) {
          problems.push("shopify.app.toml application_url host differs from SHOPIFY_APP_URL.");
        }
      } catch {
        // toml not shipped — fine
      }

      const hard = problems.some((p) => /DEPLOYED extension|placeholder — the DEPLOYED|DIFFERENT app/.test(p));
      if (problems.length > 0) {
        return (hard ? fail : warn)(
          problems[0],
          "Align SHOPIFY_APP_URL, shopify.app.toml and the extension's APP_URL constant, then `shopify app deploy` so the deployed extension bundle carries the right URL.",
          { ...detail, problems },
        );
      }
      return ok(
        extensionSourceRead
          ? `App URL ${appUrl} is consistent across config and extension source. Note: this verifies the SOURCE — the last deployed bundle is judged by the extension-traffic check.`
          : `App URL ${appUrl} looks valid (extension source not shipped with this deployment — the deployed bundle's URL is only verifiable via the extension-traffic check).`,
        detail,
      );
    },
  },
  {
    id: "env.database",
    group: "Environment",
    name: "Database & schema",
    run: async (ctx) => {
      const url = process.env.DATABASE_URL ?? "";
      const isSqlite = url.startsWith("file:");
      const isProd = process.env.NODE_ENV === "production";
      const started = Date.now();
      await prisma.shop.count({ where: { shop: ctx.shop } });
      const latencyMs = Date.now() - started;
      // Schema-drift probes: select the NEWEST columns/tables — a deploy that
      // skipped `prisma db push` fails here with P2021/P2022 long before a
      // buyer request would.
      try {
        await prisma.productCache.findFirst({
          where: { shop: ctx.shop },
          select: { descriptionFull: true, aiDescription: true, nameOverridesJson: true, upsellEligible: true },
        });
        await prisma.marketSetting.findFirst({
          where: { shop: ctx.shop },
          select: { currency: true, previewFxRate: true },
        });
        await prisma.eventDedup.count({ where: { shop: ctx.shop } });
        await prisma.debugEvent.count({ where: { shop: ctx.shop } });
        await prisma.healthCheckRun.count({ where: { shop: ctx.shop } });
        // v1.9: the ShouldRender inquiry log, the gate timeline and the order
        // eligibility columns (the orders webhook falls back to storing orders
        // without the annotations, but every v1.9 diagnostic stays blind).
        await prisma.offerInquiry.count({ where: { shop: ctx.shop } });
        await prisma.gateSample.count({ where: { shop: ctx.shop } });
        await prisma.orderRecord.findFirst({
          where: { shop: ctx.shop },
          select: { checkoutToken: true, gateway: true, presentment: true, sourceName: true },
        });
      } catch (error) {
        return fail(
          "Database schema is missing columns/tables this app version needs (v1.9 adds the OfferInquiry and GateSample tables and four OrderRecord columns). Orders are still stored, but without their post-purchase eligibility annotations, the ShouldRender inquiry log and the gate timeline cannot be written, and Debug → Post-purchase inquiries stays empty.",
          "Run `npx prisma db push` against the production database (Render: Pre-Deploy command) and redeploy.",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      if (isSqlite && isProd) {
        return fail(
          "Production is running on SQLite — data is lost on redeploy and concurrent writes contend.",
          "Provision Postgres, switch prisma/schema.prisma provider to \"postgresql\", set DATABASE_URL, run `npx prisma db push`.",
          { latencyMs },
        );
      }
      return ok(
        `Database reachable (${isSqlite ? "SQLite" : "Postgres"}), query in ${latencyMs} ms, schema current.`,
        { latencyMs, provider: isSqlite ? "sqlite" : "postgres" },
      );
    },
  },
  {
    id: "env.self-reach",
    group: "Environment",
    name: "Public URL reaches this app",
    run: async (ctx) => {
      const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
      if (!appUrl) return skip("SHOPIFY_APP_URL not set — covered by the environment-variables check.");
      // The nonce is written to OUR database first; the echo endpoint answers
      // known:true only when it finds the row in ITS database. A reflected
      // nonce alone would also come back from a stale/foreign deployment —
      // the shared-database lookup is what proves the URL routes to THIS
      // deployment (any replica of it). EventDedup doubles as the claim
      // table: unique, self-pruned by the 7-day housekeeping sweep.
      const nonce = crypto.randomUUID();
      const claim = { shop: ctx.shop, referenceId: `health:echo:${nonce}`, position: 0, eventType: "echo" };
      const target = `${appUrl}/api/health?probe=echo&nonce=${nonce}`;
      try {
        await prisma.eventDedup.create({ data: claim });
        const response = await fetch(target, {
          signal: AbortSignal.timeout(6000),
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          return warn(
            `${appUrl} answers with a redirect (${response.status}) — embedded auth and extension calls can break on redirects.`,
            "Serve the app directly on SHOPIFY_APP_URL without http→https or www redirects.",
            { status: response.status, location: response.headers.get("location") },
          );
        }
        const body = (await response.json().catch(() => null)) as any;
        if (!response.ok || body?.echo !== nonce) {
          return fail(
            `${appUrl} did not echo this server's probe — the public URL is unreachable or answers with something else entirely.`,
            "Point SHOPIFY_APP_URL (and the platform's domain config) at this deployment; extensions and OAuth both depend on it.",
            { status: response.status, body },
          );
        }
        if (body?.known !== true) {
          return fail(
            `${appUrl} answered, but from a DIFFERENT deployment (it does not share this database) — extensions are calling the wrong backend.`,
            "SHOPIFY_APP_URL points at a stale or foreign deployment. Update the DNS/platform config so the URL serves THIS app instance.",
            { status: response.status, body },
          );
        }
        return ok(`Public URL round-trip OK — ${appUrl} routes to this deployment (database identity confirmed).`);
      } catch (error) {
        return fail(
          `Fetching ${appUrl} from the server failed — DNS, TLS or the host is down.`,
          "Verify the domain, certificate and that the app is actually serving on this URL; buyers' extensions get the same failure.",
          { error: error instanceof Error ? error.message : String(error) },
        );
      } finally {
        await prisma.eventDedup.deleteMany({ where: { shop: ctx.shop, referenceId: claim.referenceId } }).catch(() => {});
      }
    },
  },
  {
    id: "env.clock",
    group: "Environment",
    name: "Server clock vs Shopify",
    run: async (ctx) => {
      if (ctx.shopifyDateMs === null) return skip("No Shopify response timestamp available (Admin API unreachable).");
      const skewMs = Date.now() - ctx.shopifyDateMs;
      const abs = Math.abs(skewMs);
      const detail = { skewMs };
      if (abs > 120_000) {
        return fail(
          `Server clock is ${Math.round(abs / 1000)}s off Shopify's — 10-minute changeset JWTs and session tokens can be rejected.`,
          "Enable NTP time sync on the host (or contact the platform provider).",
          detail,
        );
      }
      if (abs > 30_000) {
        return warn(`Server clock is ${Math.round(abs / 1000)}s off Shopify's.`, "Enable NTP time sync on the host before the drift grows.", detail);
      }
      return ok(`Clock within ${Math.round(abs / 1000)}s of Shopify.`, detail);
    },
  },

  // ═══ Shopify connection ═════════════════════════════════════════════════
  {
    id: "shopify.session",
    group: "Shopify connection",
    name: "Offline admin session",
    run: async (ctx) => {
      const session = await prisma.session.findFirst({ where: { shop: ctx.shop, isOnline: false } });
      if (!session?.accessToken || !ctx.graphql) {
        return fail(
          "No usable offline admin session — catalog sync, markets, contextual pricing and thank-you discount codes are all dead.",
          "Re-install / re-authorize the app on the store to mint a fresh offline token.",
          { sessionRow: Boolean(session), clientBuilt: Boolean(ctx.graphql), error: ctx.graphqlError },
        );
      }
      return ok("Offline session present and admin client constructed.", { scope: session.scope });
    },
  },
  {
    id: "shopify.admin-api",
    group: "Shopify connection",
    name: "Admin GraphQL reachability",
    run: async (ctx) => {
      if (!ctx.shopInfo) {
        return fail(
          "Admin GraphQL query failed — every Shopify-dependent feature is degraded.",
          "Check the offline session (previous check), network egress, and Shopify status; error attached.",
          { error: ctx.graphqlError },
        );
      }
      if (ctx.deprecationReason) {
        return warn(
          `Admin API answered but flags a deprecation: ${ctx.deprecationReason}`,
          "Update the pinned API version / queries before Shopify removes the deprecated behavior.",
          { latencyMs: ctx.graphqlLatencyMs },
        );
      }
      return ok(
        `Connected to ${ctx.shopInfo.name} (${ctx.shopInfo.currencyCode}) in ${ctx.graphqlLatencyMs} ms.`,
        { latencyMs: ctx.graphqlLatencyMs, primaryDomain: ctx.shopInfo.primaryDomainHost },
      );
    },
  },
  {
    id: "shopify.scopes",
    group: "Shopify connection",
    name: "Granted access scopes",
    run: async (ctx) => {
      if (!ctx.graphql) return skip("Admin API unavailable — see the offline-session check.");
      const { data } = await gql(
        ctx.graphql,
        `#graphql
        query cellexiaHealthScopes { currentAppInstallation { accessScopes { handle } } }`,
      );
      const granted: string[] = (data?.currentAppInstallation?.accessScopes ?? [])
        .map((s: any) => String(s?.handle ?? ""))
        .filter(Boolean);
      const missing = REQUIRED_SCOPES.filter((r) => !granted.includes(r.scope));
      if (missing.length > 0) {
        return fail(
          `Store has NOT granted: ${missing.map((m) => m.scope).join(", ")}.`,
          "Add the scopes to shopify.app.toml + SCOPES env, `shopify app deploy`, then re-open the app so the merchant re-approves. Broken until then: " +
            missing.map((m) => m.breaks).join(" · "),
          { granted, missing },
        );
      }
      return ok(`All ${REQUIRED_SCOPES.length} required scopes granted.`, { granted });
    },
  },
  {
    id: "shopify.webhooks",
    group: "Shopify connection",
    name: "Webhook configuration & delivery",
    run: async (ctx) => {
      // This app's webhooks are APP-CONFIG subscriptions (shopify.app.toml,
      // include_config_on_deploy) — Shopify's webhookSubscriptions query
      // deliberately does NOT return those, so an empty query result is the
      // healthy norm here, never a finding. What we CAN verify:
      // 1. the shipped toml still declares every required topic (config drift);
      // 2. delivery evidence — most recent webhook-fed rows (the
      //    order-ingestion and catalog checks judge the rates);
      // 3. stray SHOP-SCOPED subscriptions pointing at wrong hosts (hygiene).
      const detail: Record<string, unknown> = {};
      const problems: string[] = [];
      try {
        const toml = await readFile(path.resolve(process.cwd(), "shopify.app.toml"), "utf8");
        const declared = [...toml.matchAll(/topics\s*=\s*\[([^\]]*)\]/g)]
          .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
        detail.declaredTopics = declared;
        const missing = REQUIRED_WEBHOOK_TOPICS.filter((r) => !declared.includes(r.topic));
        if (missing.length > 0) {
          return fail(
            `shopify.app.toml no longer declares: ${missing.map((m) => m.topic).join(", ")} — after the next \`shopify app deploy\` those webhooks stop.`,
            "Restore the [[webhooks.subscriptions]] entries. Broken without them: " +
              missing.map((m) => m.breaks).join(" · "),
            detail,
          );
        }
      } catch {
        detail.declaredTopics = "shopify.app.toml not readable from this deployment — config drift not checkable here";
      }

      // Delivery evidence: webhook-fed tables should move when the store does.
      const [latestOrder, latestProductUpdate] = await Promise.all([
        prisma.orderRecord.findFirst({ where: { shop: ctx.shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.productCache.findFirst({ where: { shop: ctx.shop }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
      ]);
      detail.latestOrderWebhook = latestOrder?.createdAt ?? null;
      detail.latestProductRowUpdate = latestProductUpdate?.updatedAt ?? null;

      if (ctx.graphql) {
        try {
          const { data } = await gql(
            ctx.graphql,
            `#graphql
            query cellexiaHealthWebhooks {
              webhookSubscriptions(first: 50) {
                edges {
                  node {
                    topic
                    endpoint {
                      __typename
                      ... on WebhookHttpEndpoint { callbackUrl }
                    }
                  }
                }
              }
            }`,
          );
          const strays: Array<{ topic: string; callbackUrl: string | null }> = (
            data?.webhookSubscriptions?.edges ?? []
          ).map((e: any) => ({
            topic: String(e?.node?.topic ?? ""),
            callbackUrl: e?.node?.endpoint?.callbackUrl ? String(e.node.endpoint.callbackUrl) : null,
          }));
          const appHost = hostOf(process.env.SHOPIFY_APP_URL);
          const wrongHost = strays.filter((s) => s.callbackUrl && appHost && hostOf(s.callbackUrl) !== appHost);
          if (strays.length > 0) detail.shopScopedSubscriptions = strays;
          if (wrongHost.length > 0) {
            problems.push(
              `${wrongHost.length} shop-scoped webhook subscription(s) deliver to a DIFFERENT host than SHOPIFY_APP_URL (left over from an old install/tunnel)`,
            );
          }
        } catch {
          // hygiene probe is best-effort
        }
      }

      if (problems.length > 0) {
        return warn(
          problems[0],
          "Delete the stray subscriptions (Admin API webhookSubscriptionDelete) or ignore if intentional; the app-config webhooks are unaffected.",
          detail,
        );
      }
      return ok(
        "All required topics declared in the app config (registration ships with `shopify app deploy`; actual delivery is judged by the order-ingestion and catalog checks).",
        detail,
      );
    },
  },
  {
    id: "shopify.locales",
    group: "Shopify connection",
    name: "Published locales vs enabled languages",
    run: async (ctx) => {
      if (!ctx.graphql) return skip("Admin API unavailable — see the offline-session check.");
      const { data } = await gql(
        ctx.graphql,
        `#graphql
        query cellexiaHealthLocales { shopLocales { locale published primary } }`,
      );
      const locales: Array<{ locale: string; published: boolean; primary: boolean }> = (
        data?.shopLocales ?? []
      ).map((l: any) => ({
        locale: String(l?.locale ?? ""),
        published: Boolean(l?.published),
        primary: Boolean(l?.primary),
      }));
      const enabled = ctx.settings.languages;
      const uncovered = locales.filter(
        (l) => l.published && !enabled.some((lang) => languagesMatch(lang, l.locale)),
      );
      const deliberate = uncovered.filter((l) =>
        ctx.settings.knownShopifyLocales.some((k) => languagesMatch(k, l.locale)),
      );
      const surprising = uncovered.filter((l) => !deliberate.includes(l));
      const primary = locales.find((l) => l.primary);
      const detail = { published: locales, enabledLanguages: enabled };
      if (surprising.length > 0) {
        return warn(
          `Storefront publishes ${surprising.map((l) => l.locale).join(", ")} but the app has no matching language — those buyers get ${ctx.settings.defaultLanguage} copy.`,
          "Run Sync on the Dashboard (new locales are picked up automatically) or add the language in Settings → Languages.",
          detail,
        );
      }
      if (primary && !languagesMatch(ctx.settings.defaultLanguage, primary.locale)) {
        return warn(
          `Store primary locale is ${primary.locale} but the app default language is ${ctx.settings.defaultLanguage}.`,
          "Align Settings → Languages default with the store's primary locale unless this is deliberate.",
          detail,
        );
      }
      return ok(
        `${locales.filter((l) => l.published).length} published locales all covered by enabled languages${deliberate.length > 0 ? ` (${deliberate.map((l) => l.locale).join(", ")} deliberately disabled)` : ""}.`,
        detail,
      );
    },
  },
  {
    id: "shopify.post-purchase-availability",
    group: "Shopify connection",
    name: "Shopify checkout: post-purchase extension available",
    run: async (ctx) => {
      // THE gate every other post-purchase check sits behind. Shopify's checkout
      // decides per store whether ANY post-purchase extension exists before it
      // ever loads a ShouldRender script: the checkout page's serialized shop
      // configuration carries `postPurchaseExtensionAvailable`. When it is
      // false, no ShouldRender runs, /api/offer is never called and every
      // buyer goes straight to the thank-you page — regardless of currency,
      // language, market or payment method. Nothing inside this app can
      // change that flag; only (a) the Partner Dashboard "Access post-purchase
      // extensions" approval (required on live stores; dev stores are exempt),
      // (b) a RELEASED app version that contains the post-purchase extension
      // and (c) selecting this app under Settings → Checkout → Post-purchase
      // page. The flag is public: a cart permalink for any active variant
      // redirects to a checkout page whose HTML embeds it — read it exactly
      // the way a buyer's browser would.
      // Shopify's own answer to "is THIS app the selected post-purchase app":
      // App.isPostPurchaseAppInUse (Admin API, queried with the app's own
      // token, so it is unambiguous even when several apps carry similar
      // names). Combined with the storefront flag below it separates
      // "not selected / selection reset" from "selected but Shopify has no
      // usable extension for it".
      const checkStart = Date.now();
      let inUse: boolean | null = null;
      let appTitle = "";
      let appHandle = "";
      let appGid = "";
      let appApiKey = "";
      if (ctx.graphql) {
        // apiKey (= client_id) and the numeric app id are the two values the
        // developer must match against the Partner Dashboard app that holds
        // the post-purchase approval and the released extension — several
        // apps can share the display name. Each attempt is bounded (3 s) so
        // the storefront probe below always keeps its share of the 12 s
        // check budget; the apiKey-less retry only runs for a schema error.
        for (const fields of ["id title handle apiKey isPostPurchaseAppInUse", "id title handle isPostPurchaseAppInUse"]) {
          try {
            const { data } = await Promise.race([
              gql(
                ctx.graphql,
                `#graphql
                query cellexiaHealthPostPurchaseApp { app { ${fields} } }`,
              ),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("app query timed out (3s)")), 3000).unref?.();
              }),
            ]);
            if (typeof data?.app?.isPostPurchaseAppInUse === "boolean") inUse = data.app.isPostPurchaseAppInUse;
            appTitle = String(data?.app?.title ?? "");
            appHandle = String(data?.app?.handle ?? "");
            appGid = String(data?.app?.id ?? "");
            appApiKey = String(data?.app?.apiKey ?? "");
            break;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (fields.includes("apiKey") && /apiKey|Field|doesn't exist|does not exist/i.test(msg)) continue; // older API version without App.apiKey
            console.error(`[health] isPostPurchaseAppInUse query failed for ${ctx.shop}`, error);
            break;
          }
        }
      }

      const products = await getActiveProducts(ctx.shop);
      const { eligible } = offerablePool(products, ctx.settings);
      // Offerable variants first (they are what a buyer would check out with),
      // then any cached variant; a stale cache row (deleted product → 404/410)
      // must not fail the probe, so up to three candidates are tried.
      const candidates: number[] = [];
      for (const v of [
        ...eligible.map((e) => e.variant),
        ...products.map((p) => pickPrimaryVariant(p)),
      ]) {
        const n = v ? gidToNumber(v.id) : Number.NaN;
        if (Number.isFinite(n) && !candidates.includes(n)) candidates.push(n);
        if (candidates.length >= 3) break;
      }
      if (candidates.length === 0) {
        return skip("No cached product variant to open a checkout with — run Sync on the Dashboard first.");
      }
      const host = ctx.shopInfo?.primaryDomainHost || ctx.shop;
      const attempts: Array<{ permalink: string; finalUrl: string; status: number; htmlBytes: number; error?: string }> = [];
      let match: RegExpMatchArray | null = null;
      // One deadline shared by all candidates so the whole check stays inside
      // the runner's 12 s budget even when the first stale variant hangs or
      // the Admin API calls above were slow.
      const probeDeadline = Math.min(checkStart + 10_500, Date.now() + 9000);
      for (const variantNumeric of candidates) {
        if (Date.now() >= probeDeadline) break;
        const permalink = `https://${host}/cart/${variantNumeric}:1`;
        try {
          const page = await fetchStorefrontPage(permalink, probeDeadline);
          attempts.push({ permalink, finalUrl: page.finalUrl, status: page.status, htmlBytes: page.html.length });
          match = page.html.match(/postPurchaseExtensionAvailable(?:&quot;|")\s*:\s*(true|false)/);
          if (match) break;
          // Rate-limited / bot-blocked: stop hammering — more candidates only
          // make the block last longer (a 404/410 still advances to the next).
          if (page.status === 429 || page.status === 403) break;
        } catch (error) {
          attempts.push({ permalink, finalUrl: permalink, status: 0, htmlBytes: 0, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (attempts.every((a) => a.status === 0)) {
        return warn(
          "Could not open a storefront checkout to read Shopify's post-purchase availability flag.",
          "Transient network issue or the storefront is password-protected — re-run later, or verify manually: open any checkout page on the store, view source, and search for postPurchaseExtensionAvailable.",
          { attempts },
        );
      }
      const last = attempts[attempts.length - 1];
      const flag: "true" | "false" | null = match ? (match[1] as "true" | "false") : null;
      const detail = {
        checkedAt: new Date().toISOString(),
        backendVersion: APP_VERSION,
        // Shopify Admin API: is THIS app the shop's selected post-purchase app?
        isPostPurchaseAppInUse: inUse,
        // Identity of THIS app as Shopify sees it — match these against the
        // Partner Dashboard app that shows the post-purchase approval and the
        // released extension (client id = apiKey; several apps can share a name).
        appTitle: appTitle || null,
        appHandle: appHandle || null,
        appId: appGid || null,
        appClientId: appApiKey || process.env.SHOPIFY_API_KEY || null,
        // Shopify checkout: does the store expose ANY post-purchase extension?
        storefrontFlag: flag,
        attempts,
        finalUrl: last.finalUrl,
      };
      // inUse === false is decisive on its own (handled below as a fail);
      // the storefront-probe outcomes only matter when Shopify says we ARE
      // the selected app or could not tell us.
      if (!match && inUse !== false && attempts.some((a) => a.status === 429 || a.status === 403)) {
        return warn(
          `Shopify ${attempts.some((a) => a.status === 429) ? "rate-limited (HTTP 429)" : "blocked (HTTP 403)"} the storefront probe — the flag could not be read this time.${inUse === true ? " Shopify does report this app as the selected post-purchase app." : ""}`,
          "Transient: re-run checks in a few minutes (repeated probes from one server can trip Shopify's storefront rate limit). Or verify by hand: open a checkout page, view source, search for postPurchaseExtensionAvailable — it must read true.",
          detail,
        );
      }
      if (!match && inUse !== false && attempts.length > 0 && attempts.every((a) => a.status === 404 || a.status === 410)) {
        return warn(
          `Every cached variant tried (${attempts.length}) returned ${attempts[0].status} from the storefront — the catalog cache is stale, so no checkout could be opened to read the flag.`,
          "Run Sync on the Dashboard, then re-run checks.",
          detail,
        );
      }
      if (inUse === false) {
        return fail(
          `Shopify reports that this app ("${appTitle || "this app"}") is NOT the store's selected post-purchase app — no ShouldRender of ours can run.`,
          "Shopify admin → Settings → Checkout → Post-purchase page: select this app and click SAVE, then re-run this check. NOTE: the selection is silently cleared whenever the app is uninstalled/reinstalled (e.g. to re-approve new scopes) and can drop when a released app version no longer contains the post-purchase extension — re-select after any of those. If several apps carry a similar name (a `shopify app dev` development app next to the production app), make sure the PRODUCTION app is the one selected: a dev app's extension only exists while `shopify app dev` is running.",
          detail,
        );
      }
      if (!match) {
        return warn(
          `Opened ${last.finalUrl.split("?")[0]} (HTTP ${last.status}) but the page carried no postPurchaseExtensionAvailable flag — the store may be password-protected or Shopify changed the checkout markup.${inUse === true ? " Shopify does report this app as the selected post-purchase app." : ""}`,
          "Verify manually: open a checkout page in a browser, view source, search for postPurchaseExtensionAvailable — it must read true. If the storefront is password-protected, disable the password or test after launch.",
          detail,
        );
      }
      if (flag === "false") {
        if (inUse === true) {
          return fail(
            "Shopify has this app selected as the post-purchase app, yet its checkout still reports NO post-purchase extension available for the store — Shopify has no usable post-purchase extension to serve for this app, so ShouldRender never runs and buyers can NEVER see the page (any currency, language or payment method).",
            "This is decided by Shopify, not by this app. Check, in order: (1) Partner Dashboard → this app → Versions: the ACTIVE (released) version must list the post-purchase extension 'Cellexia Post-Purchase Upsell' (type checkout_post_purchase) — a `shopify app deploy` run from a copy without extensions/post-purchase-upsell (or with `--no-release`) drops it; redeploy from the full repo with APP_URL set and confirm the release; (2) Partner Dashboard → this app → API access → 'Access post-purchase extensions' must show as granted (required on live stores; dev stores work without it); (3) after fixing, re-save Settings → Checkout → Post-purchase page and re-run this check — the storefront flag must read true; if it still reads false with all three in place, open a Shopify Partner support ticket quoting: shop domain, app client id, active version id, and 'postPurchaseExtensionAvailable is false in the checkout shop configuration'.",
            detail,
          );
        }
        return fail(
          "Shopify's checkout reports NO post-purchase extension available for this store — ShouldRender never runs, so buyers can NEVER see the post-purchase page (any currency, language or payment method).",
          "This is decided by Shopify, not by this app. In order: (1) Partner Dashboard → Apps → this app → API access → 'Access post-purchase extensions' → Request access — REQUIRED on live stores (dev stores are exempt), approval can take up to 7 days; (2) make sure the RELEASED app version includes the post-purchase extension (`shopify app deploy` from a clean checkout of this repo, then check the version's extensions in the Partner Dashboard); (3) Shopify admin → Settings → Checkout → Post-purchase page → select this app → Save; (4) re-run this check — the flag must read true before any test order can show an offer.",
          detail,
        );
      }
      if (inUse === null) {
        return ok(
          "Shopify's checkout reports a post-purchase extension as available for this store (could not confirm via the Admin API that it is THIS app — verify Settings → Checkout → Post-purchase page).",
          detail,
        );
      }
      return ok(
        "Shopify has this app selected as the post-purchase app AND its checkout reports the post-purchase extension as available — ShouldRender will run for eligible (card, shop-currency) checkouts.",
        detail,
      );
    },
  },

  // ═══ Billing & accept path ══════════════════════════════════════════════
  {
    id: "billing.changeset-signing",
    group: "Billing & accept path",
    name: "Changeset signing round-trip",
    run: async (ctx) => {
      // Exercises the EXACT accept path: IssuedOffer write → read → sign via
      // the same signChangesetToken the route uses → verify with the secret.
      if (!process.env.SHOPIFY_API_SECRET || !process.env.SHOPIFY_API_KEY) {
        return fail(
          "SHOPIFY_API_KEY / SHOPIFY_API_SECRET missing — changesets cannot be signed, so NO accept can succeed.",
          "Set both in the environment (Partner Dashboard → app credentials) and redeploy.",
          {},
        );
      }
      const referenceId = `health:sign:${crypto.randomUUID()}`;
      const products = await getActiveProducts(ctx.shop);
      const { eligible } = offerablePool(products, ctx.settings);
      const variantGid = eligible[0]?.variant.id ?? "gid://shopify/ProductVariant/1";
      const variantID = gidToNumber(variantGid);
      const changes: OfferChange[] = [
        {
          type: "add_variant",
          variantID: Number.isFinite(variantID) ? variantID : 1,
          quantity: 1,
          discount: { value: 10, valueType: "percentage", title: "10% off" },
        },
      ];
      try {
        await prisma.issuedOffer.create({
          data: {
            shop: ctx.shop,
            referenceId,
            offerId: "health-check",
            changesJson: jstr(changes),
            offerMetaJson: "{}",
            expiresAt: new Date(Date.now() + 2 * 60 * 1000),
          },
        });
        const row = await prisma.issuedOffer.findUnique({
          where: { referenceId_offerId: { referenceId, offerId: "health-check" } },
        });
        if (!row) return fail("IssuedOffer write/read failed — offers cannot be persisted.", "Check database connectivity and schema.", {});
        const stored = jparse<OfferChange[]>(row.changesJson, []);
        const token = signChangesetToken(referenceId, stored);
        const claims = verifyChangesetToken(token);
        if (claims.iss !== process.env.SHOPIFY_API_KEY || claims.sub !== referenceId || (claims.changes ?? []).length !== 1) {
          return fail(
            "Signed changeset verified but claims are wrong — accepts would be rejected by Shopify.",
            "Check SHOPIFY_API_KEY/SHOPIFY_API_SECRET match the app the extensions are deployed to.",
            { claims: { iss: claims.iss, sub: claims.sub } },
          );
        }
        return ok("IssuedOffer persisted, changeset signed and verified with the configured app secret.", {
          variantUsed: variantGid,
        });
      } finally {
        await prisma.issuedOffer.deleteMany({ where: { shop: ctx.shop, referenceId } }).catch(() => {});
      }
    },
  },
  {
    id: "billing.accept-errors",
    group: "Billing & accept path",
    name: "Live accept failures (48h)",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2 * DAY_MS);
      const [errors, accepted] = await Promise.all([
        prisma.offerEvent.count({ where: { shop: ctx.shop, eventType: "error", createdAt: { gte: since } } }),
        prisma.offerEvent.count({ where: { shop: ctx.shop, eventType: "accepted", createdAt: { gte: since } } }),
      ]);
      if (errors === 0) return ok(`No buyer-side accept errors in 48h (${accepted} accepts).`, { errors, accepted });
      const latest = await prisma.offerEvent.findMany({
        where: { shop: ctx.shop, eventType: "error", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { createdAt: true, referenceId: true, surface: true, productId: true },
      });
      const severe = errors >= Math.max(3, accepted * 0.2);
      return (severe ? fail : warn)(
        `${errors} buyer-side error event(s) in 48h against ${accepted} accepts.`,
        "Open the latest offer traces below (enable live recording if needed), reproduce with a test order, and check applyChangeset failures — often expired offers (2h TTL) or payment gateway declines.",
        { errors, accepted, latest },
      );
    },
  },
  {
    id: "billing.payment-recovery",
    group: "Billing & accept path",
    name: "Payment-recovery backfill (retries)",
    run: async (ctx) => {
      // An accepted upsell whose one-click charge failed is recorded with €0
      // revenue; the orders/updated webhook restores it once Shopify's payment
      // recovery collects. Old zero-revenue accepts = retries not landing.
      const now = Date.now();
      const pending = await prisma.offerEvent.count({
        where: {
          shop: ctx.shop,
          eventType: "accepted",
          revenue: 0,
          createdAt: { lt: new Date(now - 2 * DAY_MS), gte: new Date(now - 30 * DAY_MS) },
        },
      });
      if (pending === 0) return ok("No accepted upsells stuck at zero revenue — payment-recovery backfill is healthy.");
      return warn(
        `${pending} accepted upsell(s) older than 48h still show zero revenue.`,
        "Either Shopify's payment recovery hasn't collected yet, or the orders/updated webhook isn't delivering (see Webhook registration). Revenue is restored automatically when the order turns paid.",
        { pending },
      );
    },
  },
  {
    id: "billing.event-dedup",
    group: "Billing & accept path",
    name: "Replay-guard unique constraint",
    run: async (ctx) => {
      // The EventDedup unique index is what stops double-counted events. Prove
      // it exists IN THIS database: second identical insert must lose.
      const key = { shop: ctx.shop, referenceId: `health:dedup:${crypto.randomUUID()}`, position: 0, eventType: "health" };
      try {
        await prisma.eventDedup.create({ data: key });
        try {
          await prisma.eventDedup.create({ data: key });
          return fail(
            "Duplicate EventDedup insert SUCCEEDED — the unique constraint is missing, replayed events would double-count revenue.",
            "Run `npx prisma db push` against the production database to restore the @@unique index.",
            {},
          );
        } catch (error: any) {
          if (error?.code === "P2002") return ok("Replay guard verified — duplicate event claims are rejected by the database.");
          throw error;
        }
      } finally {
        await prisma.eventDedup.deleteMany({ where: { shop: ctx.shop, referenceId: key.referenceId } }).catch(() => {});
      }
    },
  },
  {
    id: "billing.housekeeping",
    group: "Billing & accept path",
    name: "Offer housekeeping & trace hygiene",
    run: async (ctx) => {
      const now = Date.now();
      const [expiredBacklog, issued24h, oldDedup, debugCount] = await Promise.all([
        prisma.issuedOffer.count({ where: { shop: ctx.shop, expiresAt: { lt: new Date(now - DAY_MS) } } }),
        prisma.issuedOffer.count({ where: { shop: ctx.shop, createdAt: { gte: new Date(now - DAY_MS) } } }),
        prisma.eventDedup.count({ where: { shop: ctx.shop, createdAt: { lt: new Date(now - 7 * DAY_MS) } } }),
        prisma.debugEvent.count({ where: { shop: ctx.shop } }),
      ]);
      const detail = { expiredBacklog, issued24h, oldDedup, debugTraces: debugCount, liveTracing: ctx.settings.debugLiveRequests };
      if (ctx.settings.debugLiveRequests) {
        return warn(
          "Live debug tracing is ON — every buyer request writes a trace row. Fine for diagnosing, not for always-on.",
          "Turn off \"Record live buyer requests\" on this page once done diagnosing.",
          detail,
        );
      }
      if (expiredBacklog > 5000 || oldDedup > 10000) {
        return warn(
          "Housekeeping backlog is growing (expired offers / old dedup claims) — the dashboard loader that prunes them may not be running.",
          "Open the Dashboard once (it prunes on load), and if the backlog persists check the [dashboard] logs.",
          detail,
        );
      }
      return ok(`Housekeeping healthy — ${issued24h} offers issued in 24h, no backlog.`, detail);
    },
  },

  // ═══ Offer engine & catalog ═════════════════════════════════════════════
  {
    id: "catalog.freshness",
    group: "Offer engine & catalog",
    name: "Catalog cache freshness",
    run: async (ctx) => {
      const [shopRow, cacheCount] = await Promise.all([
        prisma.shop.findUnique({ where: { shop: ctx.shop } }),
        prisma.productCache.count({ where: { shop: ctx.shop } }),
      ]);
      if (!shopRow?.catalogSyncedAt || cacheCount === 0) {
        return fail(
          cacheCount === 0 ? "Product cache is EMPTY — no offers can be selected." : "Catalog has never completed a full sync.",
          "Run \"Sync catalog & markets\" on the Dashboard and check the [catalog] logs if it fails.",
          { cacheCount, catalogSyncedAt: shopRow?.catalogSyncedAt ?? null },
        );
      }
      const detail: Record<string, unknown> = { cacheCount, catalogSyncedAt: shopRow.catalogSyncedAt };
      if (ctx.graphql) {
        try {
          const { data } = await gql(ctx.graphql, `#graphql
            query cellexiaHealthProductsCount { productsCount { count } }`);
          const live = Number(data?.productsCount?.count ?? NaN);
          if (Number.isFinite(live)) {
            detail.liveCount = live;
            if (live >= 10 && Math.abs(live - cacheCount) / live > 0.15) {
              return warn(
                `Cache holds ${cacheCount} products but Shopify reports ${live} — webhooks may be missing bulk changes.`,
                "Run \"Sync catalog & markets\" on the Dashboard; if divergence returns, check Webhook registration.",
                detail,
              );
            }
          }
        } catch {
          // count probe is best-effort
        }
      }
      const ageDays = (Date.now() - shopRow.catalogSyncedAt.getTime()) / DAY_MS;
      if (ageDays > 30) {
        return warn(
          `Last full catalog sync was ${Math.round(ageDays)} days ago — product webhooks cover single edits, but bulk imports/edits need a full sync.`,
          "Run \"Sync catalog & markets\" on the Dashboard.",
          detail,
        );
      }
      return ok(`${cacheCount} products cached, full sync ${Math.round(ageDays)}d ago${detail.liveCount !== undefined ? `, Shopify reports ${detail.liveCount}` : ""}.`, detail);
    },
  },
  {
    id: "catalog.offerable",
    group: "Offer engine & catalog",
    name: "Offerable product pool",
    run: async (ctx) => {
      const products = await getActiveProducts(ctx.shop);
      const { eligible, gates } = offerablePool(products, ctx.settings);
      const detail = { activeProducts: products.length, eligible: eligible.length, excludedBy: gates, minInventory: ctx.settings.minInventory };
      if (eligible.length === 0) {
        return fail(
          "ZERO products are offerable — every buyer gets an empty post-purchase page.",
          "Check the exclusion counts: re-enable products in the Upsell products tab, restock, or fix prices. (ACTIVE products excluded by: " +
            `not eligible ${gates.notEligible}, no variant ${gates.noVariant}, zero price ${gates.zeroPrice}, low inventory ${gates.lowInventory}.)`,
          detail,
        );
      }
      if (eligible.length < 3) {
        return warn(
          `Only ${eligible.length} product(s) offerable — bundle/sequential flows and rotation have nothing to pick from.`,
          "Enable more products in the Upsell products tab or relax the inventory threshold in Settings.",
          detail,
        );
      }
      return ok(`${eligible.length} of ${products.length} active products are offerable.`, detail);
    },
  },
  {
    id: "engine.rules",
    group: "Offer engine & catalog",
    name: "Offer rules integrity",
    run: async (ctx) => {
      const rules = await prisma.offerRule.findMany({
        where: { shop: ctx.shop, enabled: true },
        orderBy: { priority: "asc" },
        include: { slots: { include: { candidates: true }, orderBy: { position: "asc" } } },
      });
      if (rules.length === 0) return ok("No enabled rules — the auto-pilot engine selects offers (that's a valid setup).");
      const products = await getActiveProducts(ctx.shop);
      const byId = new Map(products.map((p) => [p.productId, p]));
      const broken: Array<{ rule: string; slot: number; productId: string; problem: string }> = [];
      const deadRules: string[] = [];
      for (const rule of rules) {
        let ruleHasValid = false;
        for (const slot of rule.slots) {
          for (const cand of slot.candidates) {
            if (!cand.enabled) continue;
            const product = byId.get(cand.productId);
            let problem: string | null = null;
            if (!product) problem = "product missing from catalog cache (deleted or archived)";
            else if (!product.upsellEligible) problem = "product excluded in Upsell products tab";
            else {
              const variant = product.variants.find((v) => v.id === cand.variantId);
              if (!variant) problem = "variant no longer exists on the product";
              else if (!(variant.price > 0)) problem = "variant price is 0";
              else if (variant.inventoryQuantity !== null && variant.inventoryQuantity < ctx.settings.minInventory)
                problem = `inventory ${variant.inventoryQuantity} below minimum ${ctx.settings.minInventory}`;
            }
            if (problem) broken.push({ rule: rule.name, slot: slot.position, productId: cand.productId, problem });
            else ruleHasValid = true;
          }
        }
        if (!ruleHasValid) deadRules.push(rule.name);
      }
      if (deadRules.length > 0) {
        return fail(
          `Rule(s) with NO valid candidates: ${deadRules.join(", ")} — when they match, buyers may get nothing.`,
          "Open the rule and repoint its candidates at in-stock, eligible products.",
          { deadRules, broken },
        );
      }
      if (broken.length > 0) {
        return warn(
          `${broken.length} rule candidate(s) can no longer serve (details attached) — rotation silently skips them.`,
          "Open each rule listed in the detail and fix or remove the broken candidates.",
          { broken },
        );
      }
      return ok(`${rules.length} enabled rule(s), every slot has valid candidates.`);
    },
  },
  {
    id: "engine.dry-run",
    group: "Offer engine & catalog",
    name: "Offer selection dry-run (live data)",
    run: async (ctx) => {
      // Run the REAL selection pipeline (read-only) against the most recent
      // real order's basket — the closest thing to "would the next buyer get
      // an offer?" without a test purchase.
      if (!ctx.settings.enabled) {
        return warn(
          "The app kill-switch is OFF — the engine returns zero offers by design.",
          "Enable in Settings → General when you want offers live, then re-run checks.",
          {},
        );
      }
      const latestOrder = await prisma.orderRecord.findFirst({
        where: { shop: ctx.shop },
        orderBy: { createdAt: "desc" },
        include: { lines: true },
      });
      const products = await getActiveProducts(ctx.shop);
      const { eligible } = offerablePool(products, ctx.settings);
      let lineItems: PurchaseContext["lineItems"];
      let totalAmount: number;
      let basketSource: string;
      if (latestOrder && latestOrder.lines.length > 0) {
        lineItems = latestOrder.lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          priceAmount: l.price,
        }));
        totalAmount = latestOrder.totalPrice;
        basketSource = `latest real order (${latestOrder.orderId})`;
      } else if (eligible.length > 0) {
        const seed = eligible[0];
        lineItems = [{ productId: seed.product.productId, variantId: seed.variant.id, quantity: 1, priceAmount: seed.variant.price }];
        totalAmount = seed.variant.price;
        basketSource = "synthetic basket (no orders recorded yet)";
      } else {
        return skip("No orders and no offerable products to build a test basket from — fix the pool check first.");
      }
      const dryCtx: PurchaseContext = {
        shop: ctx.shop,
        referenceId: `health:engine:${crypto.randomUUID()}`,
        customerId: null, // no frequency-cap side effects
        countryCode: latestOrder?.country ?? null,
        locale: ctx.settings.defaultLanguage,
        currency: latestOrder?.currency ?? ctx.shopInfo?.currencyCode ?? "EUR",
        totalAmount,
        lineItems,
        surface: "post_purchase",
      };
      const result = await selectOffers(dryCtx, ctx.settings);
      if (result.offers.length === 0) {
        // Zero offers from a DELIBERATE configuration is a note, not an
        // emergency — only unexplained zero drives the red banner / 503.
        if (dryCtx.countryCode) {
          const markets = await prisma.marketSetting.findMany({ where: { shop: ctx.shop, enabled: false } });
          const disabledFor = markets.find((m) =>
            jparse<string[]>(m.countriesJson, []).includes(dryCtx.countryCode as string),
          );
          if (disabledFor) {
            return warn(
              `Zero offers for the ${basketSource} — its country ${dryCtx.countryCode} belongs to the DISABLED market "${disabledFor.name}", so the engine suppresses offers there by design.`,
              "If that market should get offers, enable it in Settings → Markets; otherwise this is working as configured.",
              { basketSource, countryCode: dryCtx.countryCode, disabledMarket: disabledFor.name },
            );
          }
        }
        const suppressedByBasket = eligible.length > 0 && lineItems.length >= eligible.length;
        if (suppressedByBasket) {
          return warn(
            `Zero offers for the ${basketSource} — every offerable product is already in that basket (suppression working as designed on a small catalog).`,
            "Add more offerable products in the Upsell products tab so multi-product baskets still have something to offer.",
            { basketSource, eligible: eligible.length },
          );
        }
        return fail(
          `The engine returned ZERO offers for the ${basketSource} — and no deliberate setting explains it.`,
          "Reproduce in Preview for the full step-by-step trace (rules, market gating, suppression, pool).",
          { basketSource, countryCode: dryCtx.countryCode },
        );
      }
      return ok(
        `Engine produced ${result.offers.length} offer(s) [${result.displayMode}] for the ${basketSource}${result.matchedRuleId ? " via rule match" : " via auto-pilot"}.`,
        {
          basketSource,
          matchedRuleId: result.matchedRuleId,
          offers: result.offers.map((o) => ({ position: o.position, products: o.products.map((p) => p.title), discountPct: o.discountPct })),
        },
      );
    },
  },
  {
    id: "engine.recent-orders-replay",
    group: "Offer engine & catalog",
    name: "Last real orders: what happened vs what the engine would offer",
    run: async (ctx) => {
      // Two views per recent order, side by side:
      //   ACTUAL — the ShouldRender inquiries Shopify really sent for that
      //            checkout (OfferInquiry joined on checkout token, v1.9) plus
      //            the platform gates that decide whether Shopify would ever
      //            show the page (payment method, presentment currency, sales
      //            channel — from the orders webhook, v1.9 columns);
      //   REPLAY — the engine run again NOW with the same customer/country/
      //            basket. Read-only (selectOffers never writes). Caveat: the
      //            replay is "as of now" — the order's own thank-you impression
      //            or later purchases can make it report a frequency cap /
      //            suppression that did not exist at checkout time; the ACTUAL
      //            column is authoritative when present.
      if (!ctx.settings.enabled) return warn("App kill-switch is OFF — nothing would be offered by design.", "Enable in Settings → General when you want offers live, then re-run checks.", {});
      const orders = await prisma.orderRecord.findMany({
        where: { shop: ctx.shop },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { lines: true },
      });
      const withLines = orders.filter((o) => o.lines.length > 0);
      if (withLines.length === 0) return skip("No real orders with line items recorded yet.");
      const tokens = withLines.map((o) => o.checkoutToken).filter((t): t is string => Boolean(t));
      const inquiries = tokens.length
        ? await prisma.offerInquiry.findMany({ where: { shop: ctx.shop, referenceId: { in: tokens } }, orderBy: { createdAt: "asc" } }).catch(() => [])
        : [];
      const shopCurrency = ctx.shopInfo?.currencyCode || "";
      const rows: Array<{
        orderId: string;
        createdAt: string;
        customer: string;
        country: string | null;
        gateway: string | null;
        presentment: string | null;
        platformGate: string | null;
        actualInquiries: number;
        actualLast: string | null;
        replayOffers: number;
        replayReason: string | null;
      }> = [];
      for (const order of withLines) {
        const gate = postPurchasePlatformGate(order.gateway, order.presentment, order.sourceName, shopCurrency || order.currency);
        const mine = order.checkoutToken ? inquiries.filter((i) => i.referenceId === order.checkoutToken) : [];
        const last = mine.length ? mine[mine.length - 1] : null;
        const base = {
          orderId: order.orderId,
          createdAt: order.createdAt.toISOString(),
          customer: order.customerId ? "yes" : "guest",
          country: order.country ?? null,
          gateway: order.gateway ?? null,
          presentment: order.presentment ?? null,
          platformGate: gate,
          actualInquiries: mine.length,
          actualLast: last
            ? `${last.offers > 0 ? `${last.offers} offer(s) issued` : `no offer — ${scrubReason(last.emptyReason) ?? "no reason"}`} (${last.tookMs} ms, ${last.createdAt.toISOString()})`
            : order.checkoutToken
              ? "no ShouldRender inquiry reached this backend for this checkout (or the inquiry log did not exist yet / was pruned)"
              : "no checkout token stored (order predates v1.9, the deployment had not run db push yet, or the order was not created from a web checkout) — cannot join",
        };
        const replayCtx: PurchaseContext = {
          shop: ctx.shop,
          referenceId: `health:replay:${crypto.randomUUID()}`,
          customerId: order.customerId ?? null,
          countryCode: order.country ?? null,
          locale: ctx.settings.defaultLanguage,
          currency: order.currency || ctx.shopInfo?.currencyCode || "EUR",
          totalAmount: order.totalPrice,
          lineItems: order.lines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity,
            priceAmount: l.price,
          })),
          surface: "post_purchase",
        };
        try {
          const result = await selectOffers(replayCtx, ctx.settings);
          rows.push({
            ...base,
            replayOffers: result.offers.length,
            replayReason: result.offers.length === 0 ? scrubReason(result.emptyReason) ?? "unknown" : null,
          });
        } catch (error) {
          rows.push({
            ...base,
            replayOffers: 0,
            replayReason: `engine crashed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const detail = {
        note: "ACTUAL = ShouldRender inquiries Shopify sent for that checkout (joined on checkout token) + Shopify platform gate from payment method / currency / channel; REPLAY = engine run now (as-of-now caveat: later impressions/purchases can add a cap or suppression that did not apply at checkout time).",
        rows,
      };
      const gated = rows.filter((r) => r.platformGate);
      const called = rows.filter((r) => r.actualInquiries > 0);
      const issued = called.filter((r) => /offer\(s\) issued/.test(r.actualLast ?? ""));
      const replayEmpty = rows.filter((r) => r.replayOffers === 0);
      const summaryBits: string[] = [];
      summaryBits.push(`${gated.length}/${rows.length} ineligible by Shopify's rules (${[...new Set(gated.map((g) => g.platformGate))].join("; ") || "-"})`);
      summaryBits.push(`${called.length}/${rows.length} received a ShouldRender inquiry, ${issued.length} got a page issued`);
      summaryBits.push(`replay: ${rows.length - replayEmpty.length}/${rows.length} would get offers now`);
      const eligibleNotCalled = rows.filter((r) => !r.platformGate && r.actualInquiries === 0 && !/predates/.test(r.actualLast ?? ""));
      if (eligibleNotCalled.length > 0 && eligibleNotCalled.length === rows.filter((r) => !r.platformGate && !/predates/.test(r.actualLast ?? "")).length) {
        return warn(
          `Every eligible recent order (${eligibleNotCalled.length}) was placed WITHOUT Shopify calling this backend's ShouldRender — the Shopify-side gate was closed for them (see the availability check). ${summaryBits.join("; ")}.`,
          "If the availability row is green NOW, the gate opened after those orders — place a fresh card order in the shop currency and re-run. If it is red, fix it first.",
          detail,
        );
      }
      if (replayEmpty.length === rows.length) {
        return warn(
          `None of the last ${rows.length} real orders would get an offer from the engine — reasons: ${[...new Set(replayEmpty.map((r) => (r.replayReason ?? "").split(" — ")[0]))].join("; ")}. ${summaryBits.join("; ")}.`,
          "Each row's replay reason names the engine step. 'step2: frequency cap' on your own test orders means the customer account already saw an offer (a thank-you-page offer counts) — test as guest or set the cap to 0 while testing; 'step6b: auto-pilot pool is empty' means suppression/allowlist emptied the catalog for that buyer.",
          detail,
        );
      }
      return ok(`${summaryBits.join("; ")}.`, detail);
    },
  },
  {
    id: "markets.config",
    group: "Offer engine & catalog",
    name: "Markets configuration",
    run: async (ctx) => {
      const markets = await prisma.marketSetting.findMany({ where: { shop: ctx.shop } });
      if (markets.length === 0) {
        return warn(
          "No markets synced — per-country gating, discounts and language overrides are inactive.",
          "Run \"Sync catalog & markets\" on the Dashboard.",
          {},
        );
      }
      const problems: string[] = [];
      const seenCountry = new Map<string, string>();
      for (const m of markets) {
        const countries = jparse<string[]>(m.countriesJson, []);
        if (m.enabled) {
          for (const c of countries) {
            if (seenCountry.has(c)) problems.push(`country ${c} appears in BOTH "${seenCountry.get(c)}" and "${m.name}" — market resolution is arbitrary`);
            else seenCountry.set(c, m.name);
          }
        }
        if (!m.currency) problems.push(`market "${m.name}" has no synced currency — re-sync markets`);
        if (m.languageOverride && !ctx.settings.languages.some((l) => languagesMatch(l, m.languageOverride!))) {
          problems.push(`market "${m.name}" overrides language to "${m.languageOverride}" which is NOT an enabled language`);
        }
      }
      const disabled = markets.filter((m) => !m.enabled).map((m) => m.name);
      const detail = { markets: markets.length, disabled, problems };
      const hard = problems.some((p) => /BOTH|NOT an enabled/.test(p));
      if (problems.length > 0) {
        return (hard ? fail : warn)(
          problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : ""),
          "Fix in Settings → Markets; duplicate-country rows and invalid language overrides directly affect live buyers.",
          detail,
        );
      }
      return ok(`${markets.length} market(s) configured cleanly${disabled.length > 0 ? ` (${disabled.join(", ")} disabled)` : ""}.`, detail);
    },
  },
  {
    id: "markets.contextual-pricing",
    group: "Offer engine & catalog",
    name: "Per-country contextual pricing",
    run: async (ctx) => {
      const markets = await prisma.marketSetting.findMany({ where: { shop: ctx.shop, enabled: true } });
      const products = await getActiveProducts(ctx.shop);
      const { eligible } = offerablePool(products, ctx.settings);
      if (eligible.length === 0) return skip("No offerable products to price — fix the pool check first.");
      const probe = markets
        .map((m) => ({ m, countries: jparse<string[]>(m.countriesJson, []) }))
        .find((x) => x.countries.length > 0 && x.m.currency && x.m.currency !== (ctx.shopInfo?.currencyCode ?? ""))
        ?? markets.map((m) => ({ m, countries: jparse<string[]>(m.countriesJson, []) })).find((x) => x.countries.length > 0);
      if (!probe) return skip("No enabled market with countries to probe.");
      const country = probe.countries[0];
      const variantId = eligible[0].variant.id;
      const prices = await getContextualPrices(ctx.shop, [variantId], country);
      const entry = prices?.get(variantId);
      if (!entry) {
        return warn(
          `No contextual price for ${country} (market "${probe.m.name}") — buyers there see FX-converted prices instead of real market prices.`,
          "Check the offline session and Shopify status; the pricing path degrades gracefully but real market prices are better.",
          { country, variantId },
        );
      }
      if (entry.price === null || entry.price <= 0) {
        return warn(
          `Shopify returns NO price for the probe variant in ${country} — the product may not be published in the "${probe.m.name}" market catalog.`,
          "Check the product's market publication; misses are cached up to 6h.",
          { country, variantId },
        );
      }
      return ok(`Real market price fetched for ${country}: ${entry.price} ${entry.currency}.`, { country, price: entry.price, currency: entry.currency });
    },
  },

  // ═══ Languages & translations ═══════════════════════════════════════════
  {
    id: "lang.config",
    group: "Languages & translations",
    name: "Language configuration",
    run: async (ctx) => {
      const { languages, defaultLanguage } = ctx.settings;
      if (languages.length === 0) return fail("No languages enabled — every buyer falls back to compiled English defaults.", "Add the store's languages in Settings → Languages or run Sync.", {});
      if (!languages.some((l) => languagesMatch(l, defaultLanguage))) {
        return fail(
          `Default language "${defaultLanguage}" is not in the enabled languages list.`,
          "Pick a default that is enabled in Settings → Languages.",
          { languages, defaultLanguage },
        );
      }
      return ok(`${languages.length} languages enabled, default ${defaultLanguage}.`, { languages });
    },
  },
  {
    id: "lang.ui-strings",
    group: "Languages & translations",
    name: "UI string coverage",
    run: async (ctx) => {
      const rows = await prisma.uiString.findMany({ where: { shop: ctx.shop }, select: { language: true, key: true, value: true } });
      const byLang = new Map<string, Map<string, string>>();
      for (const row of rows) {
        if (!byLang.has(row.language)) byLang.set(row.language, new Map());
        byLang.get(row.language)!.set(row.key, row.value);
      }
      const gaps: Record<string, number> = {};
      // Em-dash policy scan — ENABLED languages only (rows of languages the
      // merchant later disabled are never served and not editable, so they
      // must not produce a permanent unfixable warn).
      const emDashHits: Array<{ language: string; key: string }> = [];
      for (const row of rows) {
        if (!row.value.includes("—")) continue;
        if (!ctx.settings.languages.some((l) => languagesMatch(l, row.language))) continue;
        if (emDashHits.length < 10) emDashHits.push({ language: row.language, key: row.key });
      }
      const emDashes = emDashHits.length;
      for (const lang of ctx.settings.languages) {
        if (languagesMatch(lang, "en")) continue; // en falls back to compiled defaults by design
        const exact = byLang.get(lang);
        const base = byLang.get(baseLang(lang));
        let missing = 0;
        for (const key of UI_STRING_KEYS) {
          const value = exact?.get(key) || base?.get(key);
          if (!value || !value.trim()) missing++;
        }
        if (missing > 0) gaps[lang] = missing;
      }
      const langsWithGaps = Object.keys(gaps);
      const detail = { keysPerLanguage: UI_STRING_KEYS.length, gaps, emDashViolations: emDashHits };
      if (langsWithGaps.length > 0) {
        const systemic = langsWithGaps.filter((l) => gaps[l] >= UI_STRING_KEYS.length / 2);
        return (systemic.length > 0 ? fail : warn)(
          `Untranslated UI strings: ${langsWithGaps.map((l) => `${l} (${gaps[l]})`).join(", ")} — those buyers see English text.`,
          "Open Translations and run auto-translate for the flagged languages (the dashboard's self-healing pass usually fixes this on next load — if gaps persist, the translation provider is failing; run deep checks).",
          detail,
        );
      }
      if (emDashes > 0) {
        return warn(
          `${emDashes} UI string(s) contain an em dash — against the brand copy policy (language/key pairs in the detail).`,
          "Edit the flagged strings in Translations (the self-healing pass normalizes old defaults but never merchant edits).",
          detail,
        );
      }
      return ok(`All ${UI_STRING_KEYS.length} UI strings covered in every enabled language.`, detail);
    },
  },
  {
    id: "lang.product-names",
    group: "Languages & translations",
    name: "Product name coverage per language",
    run: async (ctx) => {
      const products = await getActiveProducts(ctx.shop);
      const { eligible } = offerablePool(products, ctx.settings);
      if (eligible.length === 0) return skip("No offerable products — fix the pool check first.");
      const perLang: Record<string, { missing: number; examples: string[] }> = {};
      for (const lang of ctx.settings.languages) {
        if (languagesMatch(lang, ctx.settings.defaultLanguage)) continue;
        let missing = 0;
        const examples: string[] = [];
        for (const { product } of eligible) {
          const res = explainProductName(product, lang);
          if (res.source === "base_title") {
            missing++;
            if (examples.length < 5) examples.push(product.title);
          }
        }
        if (missing > 0) perLang[lang] = { missing, examples };
      }
      const langs = Object.keys(perLang);
      if (langs.length > 0) {
        return warn(
          `${langs.length} language(s) show base-language product names to buyers: ${langs.map((l) => `${l} (${perLang[l].missing}/${eligible.length})`).join(", ")}.`,
          "Add manual names in the Products tab (instant) or translate titles in Translate & Adapt then Sync.",
          { perLanguage: perLang, offerableProducts: eligible.length },
        );
      }
      return ok(`Every offerable product has a name in all ${ctx.settings.languages.length} languages.`, { offerableProducts: eligible.length });
    },
  },
  {
    id: "lang.translation-probe",
    group: "Languages & translations",
    name: "Translation provider (live call)",
    run: async (ctx) => {
      if (!ctx.deep) return skip("Deep checks only — runs one real translation API call.");
      const target = ctx.settings.languages.find((l) => !languagesMatch(l, ctx.settings.defaultLanguage) && !languagesMatch(l, "en")) ?? "fr";
      const started = Date.now();
      try {
        const [translated] = await translateTexts(ctx.settings, ["Thank you for your order."], target);
        if (!translated || !translated.trim()) {
          return fail(
            `Translation provider (${ctx.settings.translationProvider}) returned an empty result for ${target}.`,
            "Check the provider API key and model in Settings → AI; auto-translation and the language-enforcement pipeline are degraded until fixed.",
            { target },
          );
        }
        return ok(`${ctx.settings.translationProvider} translated a probe to ${target} in ${Date.now() - started} ms.`, { target, sample: translated.slice(0, 80) });
      } catch (error) {
        return fail(
          `Translation provider (${ctx.settings.translationProvider}) call FAILED.`,
          "Check the provider API key (Settings → AI / env vars). Until fixed: UI-string auto-translation and wrong-language copy correction are broken.",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  },

  // ═══ AI copywriting ═════════════════════════════════════════════════════
  {
    id: "ai.templates",
    group: "AI copywriting",
    name: "Prompt templates",
    run: async (ctx) => {
      const keys: PromptKey[] = ["single", "bundle", "sequential"];
      const rows = await prisma.promptTemplate.findMany({ where: { shop: ctx.shop } });
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const missing = keys.filter((k) => !byKey.has(k));
      const lowTokens = rows.filter((r) => keys.includes(r.key as PromptKey) && r.maxTokens < 2000);
      const detail = {
        templates: rows.filter((r) => keys.includes(r.key as PromptKey)).map((r) => ({ key: r.key, model: r.model, maxTokens: r.maxTokens, version: r.version })),
      };
      if (missing.length > 0) {
        return warn(
          `Prompt template(s) missing: ${missing.join(", ")} — copy falls back to built-in defaults until re-seeded.`,
          "Open the Dashboard once (templates self-seed) or the AI & Prompts tab.",
          { ...detail, missing },
        );
      }
      if (lowTokens.length > 0) {
        return warn(
          `Template(s) with maxTokens < 2000: ${lowTokens.map((r) => `${r.key} (${r.maxTokens})`).join(", ")} — long copy risks mid-JSON truncation → silent fallback.`,
          "Raise max tokens to 4000 in AI & Prompts (it's headroom, not spend).",
          detail,
        );
      }
      return ok("All three prompt templates present with sane token budgets.", detail);
    },
  },
  {
    id: "ai.models",
    group: "AI copywriting",
    name: "Anthropic key & model ids (live call)",
    run: async (ctx) => {
      if (!ctx.settings.aiEnabled) return skip("AI copy is disabled in Settings — buyers get deterministic fallback copy by design.");
      if (!process.env.ANTHROPIC_API_KEY) {
        return fail(
          "ANTHROPIC_API_KEY is not set — every buyer silently gets fallback copy.",
          "Set the key in the environment and redeploy.",
          {},
        );
      }
      // Live pings are ~10 output tokens each (fractions of a cent). Manual
      // and deep runs verify every configured model; background runs (auto /
      // external monitor polls) ping only the buyer-blocking core model so an
      // aggressive monitor cadence stays effectively free.
      const templates = await prisma.promptTemplate.findMany({ where: { shop: ctx.shop }, select: { model: true } });
      const backgroundRun = ctx.trigger !== "manual" && !ctx.deep;
      const models = backgroundRun
        ? [ctx.settings.coreCopyModel].filter(Boolean)
        : [...new Set([
            ctx.settings.coreCopyModel,
            ...templates.map((t) => t.model),
            ...(ctx.settings.translationProvider === "claude" ? [ctx.settings.translationModel] : []),
          ].filter(Boolean))].slice(0, 5);
      const results = await Promise.all(
        models.map(async (model) => {
          const started = Date.now();
          try {
            await claudeComplete({ model, system: "Health check.", prompt: "Reply with exactly: OK", maxTokens: 200, timeoutMs: 10_000 });
            return { model, ok: true as const, latencyMs: Date.now() - started };
          } catch (error) {
            return { model, ok: false as const, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        const auth = failed.find((f) => /401|authentication|invalid x-api-key/i.test(f.error ?? ""));
        const notFound = failed.filter((f) => /404|not_found/i.test(f.error ?? ""));
        if (auth) {
          return fail(
            "Anthropic rejected the API key — ALL live copy is silently falling back to templates.",
            "Replace ANTHROPIC_API_KEY (console.anthropic.com) and redeploy.",
            { results },
          );
        }
        if (notFound.length > 0) {
          return fail(
            `Model id(s) not found: ${notFound.map((f) => f.model).join(", ")} — generations with them silently fall back.`,
            "Fix the model ids in Settings → AI and AI & Prompts (typo or retired model).",
            { results },
          );
        }
        return warn(
          `${failed.length} model probe(s) failed (timeout or transient error) — buyers may be getting fallback copy right now.`,
          "Re-run checks; if it persists, check Anthropic status and the aiTimeoutMs budget.",
          { results },
        );
      }
      const slowest = Math.max(...results.map((r) => r.latencyMs));
      return ok(
        `${results.length} model(s) verified live: ${results.map((r) => `${r.model} ${r.latencyMs}ms`).join(", ")}.`,
        { results, note: slowest > 3000 ? "Slowest probe exceeded 3s — the buyer path's core call budget is tight; consider a faster core model." : undefined },
      );
    },
  },
  {
    id: "ai.copy-pipeline",
    group: "AI copywriting",
    name: "Copy pipeline output (7 days)",
    run: async (ctx) => {
      if (!ctx.settings.aiEnabled || !process.env.ANTHROPIC_API_KEY) {
        return skip(
          "AI copy is disabled (setting or missing key) — buyers get deterministic fallback copy and an empty copy cache is expected. See the checks above.",
        );
      }
      const since = new Date(Date.now() - 7 * DAY_MS);
      const [impressions, cacheWrites, cacheTotal, recentTraces] = await Promise.all([
        prisma.offerEvent.count({ where: { shop: ctx.shop, eventType: "impression", createdAt: { gte: since } } }),
        prisma.copyCache.count({ where: { shop: ctx.shop, createdAt: { gte: since } } }),
        prisma.copyCache.count({ where: { shop: ctx.shop } }),
        prisma.debugEvent.findMany({ where: { shop: ctx.shop }, orderBy: { createdAt: "desc" }, take: 20, select: { summaryJson: true } }),
      ]);
      const detail: Record<string, unknown> = { impressions7d: impressions, cacheWrites7d: cacheWrites, cacheTotal };
      let fallbackTraces = 0;
      let tracesWithSources = 0;
      for (const t of recentTraces) {
        const sources = jparse<{ copySources?: string[] }>(t.summaryJson, {}).copySources;
        if (Array.isArray(sources) && sources.length > 0) {
          tracesWithSources++;
          if (sources.every((s) => s === "fallback" || s === "no_discount_fallback")) fallbackTraces++;
        }
      }
      if (tracesWithSources > 0) detail.recentTracesAllFallback = `${fallbackTraces}/${tracesWithSources}`;
      if (impressions >= 20 && cacheTotal === 0) {
        return fail(
          `${impressions} impressions in 7 days but the copy cache is EMPTY — AI generation has likely never succeeded on this deployment.`,
          "Check the Anthropic model probe above and open a recent trace to see the exact error.",
          detail,
        );
      }
      if (tracesWithSources >= 5 && fallbackTraces / tracesWithSources > 0.5) {
        return warn(
          `${fallbackTraces} of the last ${tracesWithSources} traced generations served FALLBACK copy.`,
          "Open a recent trace below — the claude-error stage shows why (timeout, key, model, truncation).",
          detail,
        );
      }
      return ok(
        impressions === 0
          ? "No impressions in 7 days to evaluate (see extension-traffic check)."
          : `${impressions} impressions served, ${cacheWrites} fresh copy generations cached this week.`,
        detail,
      );
    },
  },

  // ═══ Thank-you surface ══════════════════════════════════════════════════
  {
    id: "typ.flow",
    group: "Thank-you surface",
    name: "Thank-you offer flow",
    run: async (ctx) => {
      if (!ctx.settings.thankYouEnabled) {
        return warn(
          "Thank-you offers are disabled in Settings — non-card buyers (PayPal, Klarna…) see no offers at all.",
          "Enable in Settings → General if this is unintentional.",
          {},
        );
      }
      const since = new Date(Date.now() - 7 * DAY_MS);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const [orders7d, typImpressions7d, typLastHour] = await Promise.all([
        prisma.orderRecord.count({ where: { shop: ctx.shop, createdAt: { gte: since } } }),
        prisma.offerEvent.count({ where: { shop: ctx.shop, surface: "thank_you", eventType: "impression", createdAt: { gte: since } } }),
        prisma.issuedOffer.count({ where: { shop: ctx.shop, referenceId: { startsWith: "typ:" }, createdAt: { gte: hourAgo } } }),
      ]);
      const detail = { orders7d, typImpressions7d, typOffersLastHour: typLastHour };
      if (typLastHour >= 20) {
        return warn(
          `The 20/hour thank-you safety cap was reached this hour (${typLastHour} offers) — buyers beyond the cap saw no thank-you offer.`,
          "Great traffic problem to have. The cap protects against discount-code abuse; ask your developer to raise THANK_YOU_HOURLY_CAP in offer-orchestrator.server.ts if this happens during normal peaks.",
          detail,
        );
      }
      if (orders7d >= 5 && typImpressions7d === 0) {
        return fail(
          `${orders7d} orders this week but ZERO thank-you impressions — the block is not reaching this backend.`,
          "Check: (1) the block is added in Settings → Checkout → Thank-you page editor, (2) its App URL setting points at this app, (3) network access is approved for the extension (Partner Dashboard).",
          detail,
        );
      }
      return ok(
        typImpressions7d > 0
          ? `Thank-you surface live — ${typImpressions7d} impressions on ${orders7d} orders this week.`
          : `Enabled; ${orders7d} order(s) this week — too few to judge traffic yet.`,
        detail,
      );
    },
  },
  {
    id: "typ.discount-roundtrip",
    group: "Thank-you surface",
    name: "Discount code mint & delete (live)",
    run: async (ctx) => {
      if (!ctx.deep) return skip("Deep checks only — creates and immediately deletes a 1% test code (proves write_discounts end-to-end).");
      if (!ctx.graphql) return fail("Admin API unavailable — thank-you codes cannot be minted.", "Fix the offline session first.", {});
      const code = `HEALTH-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const { data } = await gql(
        ctx.graphql,
        `#graphql
        mutation cellexiaHealthDiscountCreate($discount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $discount) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }`,
        {
          discount: {
            title: "Health check — safe to delete",
            code,
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            customerSelection: { all: true },
            customerGets: { value: { percentage: 0.01 }, items: { all: true } },
            appliesOncePerCustomer: true,
            usageLimit: 1,
          },
        },
      );
      const errors = data?.discountCodeBasicCreate?.userErrors ?? [];
      const nodeId = data?.discountCodeBasicCreate?.codeDiscountNode?.id;
      if (errors.length > 0 || !nodeId) {
        return fail(
          `Discount code creation FAILED — live thank-you offers are going out codeless (full price).`,
          "Usual cause: write_discounts scope missing (see the scopes check) or Shopify plan restrictions.",
          { errors, code },
        );
      }
      // The delete may throw (throttle, network) — that must surface as "code
      // left behind, remove it manually", never as a generic check crash that
      // hides which code leaked.
      try {
        const del = await gql(
          ctx.graphql,
          `#graphql
          mutation cellexiaHealthDiscountDelete($id: ID!) {
            discountCodeDelete(id: $id) { userErrors { field message } }
          }`,
          { id: nodeId },
        );
        const delErrors = del.data?.discountCodeDelete?.userErrors ?? [];
        if (delErrors.length > 0) {
          return warn(
            `Test code ${code} was created but could NOT be deleted — remove it manually in Discounts.`,
            `Delete the discount named "Health check — safe to delete" in the Shopify admin. (1% code, single-use, expires in 10 minutes — harmless meanwhile.)`,
            { delErrors, code },
          );
        }
      } catch (error) {
        return warn(
          `Test code ${code} was created but the delete call failed — remove it manually in Discounts.`,
          `Delete the discount named "Health check — safe to delete" in the Shopify admin. (1% code, single-use, expires in 10 minutes — harmless meanwhile.)`,
          { code, error: error instanceof Error ? error.message : String(error) },
        );
      }
      return ok(`Discount round-trip verified — code ${code} minted and deleted.`, { code });
    },
  },

  // ═══ Order & event flow ═════════════════════════════════════════════════
  {
    id: "flow.order-ingestion",
    group: "Order & event flow",
    name: "Order webhook ingestion",
    run: async (ctx) => {
      const since = new Date(Date.now() - 7 * DAY_MS);
      const [local7d, latest, zeroLine] = await Promise.all([
        prisma.orderRecord.count({ where: { shop: ctx.shop, createdAt: { gte: since } } }),
        prisma.orderRecord.findFirst({ where: { shop: ctx.shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.orderRecord.count({ where: { shop: ctx.shop, createdAt: { gte: since }, totalPrice: { gt: 0 }, lines: { none: {} } } }),
      ]);
      const detail: Record<string, unknown> = { localOrders7d: local7d, latestOrderAt: latest?.createdAt ?? null, zeroLineOrders7d: zeroLine };
      if (ctx.graphql) {
        try {
          const sinceDate = since.toISOString().slice(0, 10);
          const { data } = await gql(ctx.graphql, `#graphql
            query cellexiaHealthOrdersCount($q: String) { ordersCount(query: $q) { count } }`, { q: `created_at:>=${sinceDate}` });
          const live = Number(data?.ordersCount?.count ?? NaN);
          if (Number.isFinite(live)) {
            detail.shopifyOrders7d = live;
            // Shopify's count includes TEST orders, which ingestion skips by
            // design — so a partial gap is only a warn; hard fail is reserved
            // for "orders exist but NOTHING arrived", which no test-order mix
            // explains on a live store.
            if (live >= 5 && local7d === 0) {
              return fail(
                `Shopify has ${live} orders this week but NONE arrived via webhook — order ingestion is dead.`,
                "Check the Webhook configuration check above and the [webhooks] logs. Until fixed: analytics, suppression, affinity and the thank-you order guard degrade.",
                detail,
              );
            }
            if (live >= 5 && local7d < live * 0.5) {
              return warn(
                `Shopify has ${live} orders this week but only ${local7d} arrived via webhook — either many are test-gateway orders (skipped by design) or some deliveries are dropping.`,
                "If these are real orders, check the [webhooks] logs; if you've been placing test orders, this gap is expected.",
                detail,
              );
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/ACCESS_DENIED|access denied|protected/i.test(msg)) {
            return warn(
              "Shopify denied the orders query — protected customer data access may not be approved for this app on a live store.",
              "In the Partner Dashboard, request Protected Customer Data access (level: name-free order data) — without it order webhooks arrive redacted.",
              { ...detail, error: msg },
            );
          }
          detail.liveCountError = msg;
        }
      }
      if (zeroLine > 0) {
        return warn(
          `${zeroLine} order(s) this week recorded with no line items — a webhook redelivery may have been interrupted.`,
          "Harmless in small numbers; investigate the [webhooks] logs if it grows.",
          detail,
        );
      }
      if (local7d === 0 && detail.shopifyOrders7d === undefined) {
        return warn(
          "No orders ingested in 7 days and the live count is unavailable — cannot confirm the orders webhook works.",
          "Place a (non-test-gateway) test order, or verify Webhook registration above.",
          detail,
        );
      }
      return ok(`${local7d} order(s) ingested this week${detail.shopifyOrders7d !== undefined ? ` (Shopify total ${detail.shopifyOrders7d})` : ""}.`, detail);
    },
  },
  {
    id: "flow.extension-traffic",
    group: "Order & event flow",
    name: "Post-purchase extension traffic (ShouldRender → this backend)",
    run: async (ctx) => {
      // Three-stage funnel, each stage answering one question a merchant
      // cannot answer from the thank-you page:
      //   inquiries  = ShouldRender calls that reached /api/offer (OfferInquiry,
      //                v1.9) → "does Shopify call us at all?"
      //   issued     = inquiries answered with ≥1 offer → "do we say yes?"
      //   impressions= post-purchase pages actually rendered (OfferEvent from
      //                the Render step) → "does Shopify then show the page?"
      // Zero inquiries while orders flow = the Shopify-side gate (see the
      // availability check); inquiries but zero issued = engine reasons
      // (listed); issued but zero impressions = Shopify's receipt-side rules
      // (card vaulting / wallet / 3-D Secure / multi-currency) or a stale
      // extension bundle.
      const since24h = new Date(Date.now() - DAY_MS);
      const since7d = new Date(Date.now() - 7 * DAY_MS);
      const shopCurrency = ctx.shopInfo?.currencyCode || "";
      // Stage-1 denominator = orders that COULD have produced an inquiry: web
      // checkouts in the shop currency, recorded with a checkout token (i.e.
      // after v1.9 was live). Non-shop-currency orders never reach ShouldRender
      // (MULTI_CURRENCY) and must not count against the app.
      const eligibleWhere = {
        shop: ctx.shop,
        checkoutToken: { not: null },
        ...(shopCurrency ? { OR: [{ presentment: shopCurrency }, { presentment: null }] } : {}),
        AND: [{ OR: [{ sourceName: "web" }, { sourceName: null }] }],
      };
      const [orders24h, orders7d, eligible7d, ppImpressions7d, ppImpressions24h, lastImpression, stats24h, stats7d, convertedTokens] = await Promise.all([
        prisma.orderRecord.count({ where: { shop: ctx.shop, createdAt: { gte: since24h } } }),
        prisma.orderRecord.count({ where: { shop: ctx.shop, createdAt: { gte: since7d } } }),
        prisma.orderRecord.count({ where: { ...eligibleWhere, createdAt: { gte: since7d } } }).catch(() => -1),
        prisma.offerEvent.count({ where: { shop: ctx.shop, surface: "post_purchase", eventType: "impression", createdAt: { gte: since7d } } }),
        prisma.offerEvent.count({ where: { shop: ctx.shop, surface: "post_purchase", eventType: "impression", createdAt: { gte: since24h } } }),
        prisma.offerEvent.findFirst({ where: { shop: ctx.shop, surface: "post_purchase" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        inquiryStats(ctx.shop, DAY_MS).catch(() => null),
        inquiryStats(ctx.shop, 7 * DAY_MS).catch(() => null),
        // Converted checkouts this week (orders with a token) — Stage 3 compares
        // pages issued for THESE with rendered impressions; abandoned checkouts
        // that re-ran ShouldRender five times must not read as "Shopify skipped".
        prisma.orderRecord
          .findMany({ where: { shop: ctx.shop, createdAt: { gte: since7d }, checkoutToken: { not: null } }, select: { checkoutToken: true } })
          .then((rows) => rows.map((r) => r.checkoutToken).filter((t): t is string => Boolean(t)))
          .catch(() => [] as string[]),
      ]);
      const issuedForConverted7d =
        convertedTokens.length > 0
          ? await prisma.offerInquiry
              .findMany({ where: { shop: ctx.shop, referenceId: { in: convertedTokens }, offers: { gt: 0 } }, select: { referenceId: true }, distinct: ["referenceId"] })
              .then((rows) => rows.length)
              .catch(() => 0)
          : 0;
      const detail = {
        orders24h,
        orders7d,
        eligibleOrders7d: eligible7d < 0 ? null : eligible7d,
        inquiries24h: stats24h?.total ?? null,
        inquiriesWithOffers24h: stats24h?.withOffers ?? null,
        inquiries7d: stats7d?.total ?? null,
        inquiriesWithOffers7d: stats7d?.withOffers ?? null,
        checkouts7d: stats7d?.checkouts ?? null,
        checkoutsWithOffers7d: stats7d?.checkoutsWithOffers ?? null,
        convertedCheckouts7d: convertedTokens.length,
        convertedCheckoutsWithPageIssued7d: issuedForConverted7d,
        avgInquiryMs24h: stats24h?.avgTookMs ?? null,
        slowInquiries24h: stats24h?.slowCount ?? null,
        topEmptyReasons7d: stats7d?.topEmptyReasons ?? null,
        inquiriesByCurrency7d: stats7d?.byCurrency ?? null,
        lastInquiryAt: stats7d?.lastAt ?? null,
        postPurchaseImpressions24h: ppImpressions24h,
        postPurchaseImpressions7d: ppImpressions7d,
        lastImpressionAt: lastImpression?.createdAt ?? null,
      };
      if (!ctx.settings.enabled) return warn("The app kill-switch is OFF — no offers anywhere.", "Enable in Settings → General.", detail);
      if (stats7d === null) {
        return warn(
          "The ShouldRender inquiry log (OfferInquiry table) is not readable — the deployment has not run `npx prisma db push` since v1.9.",
          "Run `npx prisma db push` on the deployment (Render Pre-Deploy command), then re-run checks. Until then this check falls back to impressions only.",
          detail,
        );
      }
      const inq7d = stats7d.total;
      const issued7d = stats7d.withOffers;
      const checkouts7d = stats7d.checkouts;
      const denominator = eligible7d >= 0 ? eligible7d : orders7d;
      // Stage 1 — nobody calls us (judged against orders that COULD have).
      if (denominator >= 5 && inq7d === 0) {
        return fail(
          `${denominator} shop-currency web orders this week (of ${orders7d} total) but ZERO ShouldRender inquiries reached this backend — Shopify is not running the post-purchase extension on this store.`,
          "Check in order: (1) the 'Shopify checkout: post-purchase extension available' row must be green (Partner Dashboard 'Access post-purchase extensions' approval + a released version containing the extension + Settings → Checkout → Post-purchase page selection); (2) the deployed extension bundle must point at THIS backend (Debug → Post-purchase inquiries shows the app URL the last deploy baked in once a call arrives; the App URL check compares the source); (3) if the flag only just turned true, place a card order in the shop currency and re-run.",
          detail,
        );
      }
      // Stage 2 — we are called but always decline (distinct checkouts, not calls).
      if (checkouts7d >= 5 && issued7d === 0) {
        return fail(
          `${checkouts7d} checkouts (${inq7d} ShouldRender calls) this week and this backend answered ALL of them with no offer — reasons: ${stats7d.topEmptyReasons.map((r) => `${r.reason} (×${r.count})`).join("; ") || "not recorded"}.`,
          "Each reason names the engine step (Settings → General kill-switch / frequency cap, Markets, Upsell products allowlist, catalog Sync, offer rules). Fix the top reason and re-run; Debug → Post-purchase inquiries lists every call.",
          detail,
        );
      }
      // Stage 3 — pages issued for checkouts that CONVERTED, yet none rendered.
      if (issuedForConverted7d >= 5 && ppImpressions7d === 0) {
        return warn(
          `${issuedForConverted7d} converted checkouts this week had a post-purchase page issued but ZERO pages were rendered — Shopify accepted our answer and then skipped the page after payment every time.`,
          "This is decided by Shopify after payment: the page is skipped for wallets / PayPal / Klarna / gift cards / bank methods, for orders with duties or local delivery, when the order-creation step is delayed, and when the card could not be vaulted (receipt postPurchaseVaultedPaymentMethodStatus ≠ READY; possibly some 3-D Secure flows — unconfirmed). Compare with the payment-method split in the 'Orders eligible…' check; test with a plain Shopify Payments card in the shop currency and no wallet button.",
          detail,
        );
      }
      const slowNote = stats24h && stats24h.slowCount > 0 ? ` ${stats24h.slowCount} of the last 24h calls took over 2 s (avg ${stats24h.avgTookMs} ms) — Shopify only opens the page when ShouldRender finished before the buyer paid.` : "";
      if (issued7d > 0 && ppImpressions7d > 0) {
        return ok(
          `Live: ${checkouts7d} checkouts / ${inq7d} ShouldRender calls → ${stats7d.checkoutsWithOffers} checkouts with a page issued → ${ppImpressions7d} rendered this week (${stats24h?.total ?? 0} calls in the last 24 h).${slowNote}`,
          detail,
        );
      }
      if (inq7d > 0) {
        return ok(
          `${checkouts7d} checkouts / ${inq7d} ShouldRender calls this week (${stats7d.checkoutsWithOffers} checkouts with a page issued, ${ppImpressions7d} pages rendered) — traffic is arriving; too few conversions to judge the render rate yet.${slowNote}`,
          detail,
        );
      }
      return ok(`${orders7d} order(s) this week (${eligible7d >= 0 ? eligible7d : "?"} shop-currency web orders) and no ShouldRender inquiries yet — too few eligible orders to judge extension traffic.`, detail);
    },
  },
  {
    id: "flow.currency-eligibility",
    group: "Order & event flow",
    name: "Orders eligible for the post-purchase page (currency + payment method)",
    run: async (ctx) => {
      // Shopify platform rules, both verified on the live store on 2026-08-18:
      // (a) the checkout's own PostPurchaseData query answers
      //     `PostPurchaseDataFailed { code: MULTI_CURRENCY }` for every checkout
      //     whose presentment currency differs from the shop currency — no
      //     ShouldRender runs for those buyers at all; (b) docs: the page is
      //     never surfaced for wallets / installments / PayPal / gift cards
      //     ("any payment method other than a credit card"). On a Markets store
      //     selling in many local currencies with PayPal + Klarna enabled that
      //     silently removes a large share of orders from the one-click surface
      //     — those buyers can only be reached by the thank-you block. Measure
      //     it on the last 50 real orders.
      if (!ctx.graphql) return skip("Admin API unavailable — see the offline-session check.");
      const shopCurrency = ctx.shopInfo?.currencyCode || "";
      let orders: Array<{ presentment: string; shopCcy: string; test: boolean; gateways: string[]; source: string; nonCard: string | null }> = [];
      try {
        // transactions.paymentDetails tells wallets/BNPL paid THROUGH Shopify
        // Payments apart from real cards (gateway name alone cannot). Queried
        // first; if the API version rejects it, fall back to gateway names.
        let nodes: any[] = [];
        try {
          const { data } = await gql(
            ctx.graphql,
            `#graphql
            query cellexiaHealthOrderCurrencies {
              orders(first: 50, sortKey: CREATED_AT, reverse: true) {
                nodes {
                  test currencyCode presentmentCurrencyCode paymentGatewayNames sourceName
                  transactions(first: 5) { gateway kind status paymentDetails { __typename ... on CardPaymentDetails { wallet } } }
                }
              }
            }`,
          );
          nodes = data?.orders?.nodes ?? [];
        } catch {
          const { data } = await gql(
            ctx.graphql,
            `#graphql
            query cellexiaHealthOrderCurrenciesLite {
              orders(first: 50, sortKey: CREATED_AT, reverse: true) {
                nodes { test currencyCode presentmentCurrencyCode paymentGatewayNames sourceName }
              }
            }`,
          );
          nodes = data?.orders?.nodes ?? [];
        }
        orders = nodes.map((o: any) => {
          const gateways: string[] = Array.isArray(o?.paymentGatewayNames) ? o.paymentGatewayNames.map((g: unknown) => String(g)) : [];
          const fromTx = nonCardFromTransactions(Array.isArray(o?.transactions) ? o.transactions : null);
          const fromName = gateways.find((g) => isNonCardGateway(g)) ?? null;
          return {
            presentment: String(o?.presentmentCurrencyCode ?? ""),
            shopCcy: String(o?.currencyCode ?? ""),
            test: Boolean(o?.test),
            gateways,
            source: String(o?.sourceName ?? ""),
            nonCard: fromTx ?? fromName,
          };
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/ACCESS_DENIED|access denied|protected/i.test(msg)) {
          return skip("Shopify denied the orders query (protected customer data not approved) — cannot measure currency eligibility.");
        }
        return warn("Could not read recent orders to measure currency eligibility.", "Re-run later; if it persists check the Admin API check.", { error: msg });
      }
      const real = orders.filter((o) => !o.test);
      if (real.length === 0) return skip("No real orders yet to measure.");
      const base = shopCurrency || real[0].shopCcy;
      const foreign = real.filter((o) => o.presentment && o.presentment !== base);
      const byCurrency: Record<string, number> = {};
      for (const o of foreign) byCurrency[o.presentment] = (byCurrency[o.presentment] ?? 0) + 1;
      // Card-only rule: wallets / BNPL / PayPal / local methods are ineligible
      // (from transaction paymentDetails when available, else gateway names).
      const nonCard = real.filter((o) => o.nonCard !== null);
      const byGateway: Record<string, number> = {};
      for (const o of real) {
        const label = o.nonCard ?? o.gateways.join("+") ?? "?";
        byGateway[label] = (byGateway[label] ?? 0) + 1;
      }
      const notOnlineStore = real.filter((o) => o.source && o.source !== "web");
      const eligible = real.filter(
        (o) => !(o.presentment && o.presentment !== base) && o.nonCard === null && (!o.source || o.source === "web"),
      );
      const share = foreign.length / real.length;
      const eligibleShare = eligible.length / real.length;
      const detail = {
        sampled: real.length,
        shopCurrency: base,
        nonShopCurrencyOrders: foreign.length,
        byCurrency,
        nonCardOrders: nonCard.length,
        byGateway,
        nonOnlineStoreOrders: notOnlineStore.length,
        eligibleOrders: eligible.length,
        eligibleShare: Math.round(eligibleShare * 100),
      };
      const nonCardCounts: Record<string, number> = {};
      for (const o of nonCard) nonCardCounts[o.nonCard ?? "?"] = (nonCardCounts[o.nonCard ?? "?"] ?? 0) + 1;
      const gatewayNote = nonCard.length > 0 ? ` and ${nonCard.length} used a non-card method (${Object.entries(nonCardCounts).map(([g, n]) => `${g}×${n}`).join(", ")})` : "";
      const channelNote = notOnlineStore.length > 0 ? ` and ${notOnlineStore.length} came through another sales channel` : "";
      if (eligibleShare < 0.5) {
        return warn(
          `Only ${eligible.length} of the last ${real.length} orders (${Math.round(eligibleShare * 100)}%) had no known Shopify gate against the post-purchase page: ${foreign.length} were paid in a currency other than ${base} (${Object.entries(byCurrency).map(([c, n]) => `${c}×${n}`).join(", ")} — Shopify answers MULTI_CURRENCY and never runs the extension)${gatewayNote}${channelNote}.`,
          "Nothing in this app can change that. Keep the thank-you block installed and enabled (it works for every currency and payment method). When testing the post-purchase page: check out in a " + base + " market, pay with a plain card in the card form (Shopify Payments), not PayPal / Klarna / Apple Pay / Google Pay.",
          detail,
        );
      }
      if (share > 0 || nonCard.length > 0 || notOnlineStore.length > 0) {
        return ok(
          `${eligible.length} of the last ${real.length} orders (${Math.round(eligibleShare * 100)}%) had no known Shopify gate against the post-purchase page — ${foreign.length} in a non-${base} currency (MULTI_CURRENCY)${gatewayNote}${channelNote} can only see the thank-you offer.`,
          detail,
        );
      }
      return ok(`None of the last ${real.length} orders hit a known Shopify gate: all card payments in ${base} through the Online Store (a wallet hidden behind a card gateway can only be told apart when Shopify exposes the transaction's payment details, which this check reads when available).`, detail);
    },
  },
  {
    id: "flow.analytics-integrity",
    group: "Order & event flow",
    name: "Analytics data integrity",
    run: async (ctx) => {
      const since = new Date(Date.now() - 30 * DAY_MS);
      const dayAgo = new Date(Date.now() - DAY_MS);
      const [byLanguage, issued24h, events24h] = await Promise.all([
        prisma.offerEvent.groupBy({
          by: ["language"],
          where: { shop: ctx.shop, eventType: "impression", createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.issuedOffer.count({ where: { shop: ctx.shop, createdAt: { gte: dayAgo }, NOT: { referenceId: { startsWith: "health:" } } } }),
        prisma.offerEvent.count({ where: { shop: ctx.shop, createdAt: { gte: dayAgo } } }),
      ]);
      const total = byLanguage.reduce((sum, row) => sum + row._count._all, 0);
      const unknown = byLanguage.filter((r) => !r.language).reduce((sum, row) => sum + row._count._all, 0);
      const detail = { impressions30d: total, unknownLanguage: unknown, issued24h, events24h };
      if (total > 20 && unknown / total > 0.1) {
        return warn(
          `${Math.round((unknown / total) * 100)}% of impressions have no language stamp — per-language analytics are unreliable.`,
          "Open a recent trace and check the language-resolution stage; events inherit language from the issued offer meta.",
          detail,
        );
      }
      if (issued24h > 0 && events24h === 0) {
        return warn(
          `${issued24h} offers issued in 24h but ZERO events came back — buyers see pages, or the events endpoint is broken.`,
          "If impressions also flatlined (extension-traffic check), the extension→backend path is down; otherwise check /api/events and the [analytics] logs.",
          detail,
        );
      }
      return ok(total === 0 ? "No recent events to audit." : `Event stream consistent — ${total} impressions audited, ${unknown} without language.`, detail);
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

function withTimeout(promise: Promise<CheckOutcome>, ms: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(fail(`Check timed out after ${Math.round(ms / 1000)}s.`, "The probed dependency is hanging — investigate it directly.", {}));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve(
          fail(
            `Check crashed: ${error instanceof Error ? error.message : String(error)}`,
            "A crash here usually means the probed subsystem is broken — the error message points at it.",
            {},
          ),
        );
      },
    );
  });
}

function rowToRun(row: {
  id: string;
  trigger: string;
  deep: boolean;
  status: string;
  okCount: number;
  warnCount: number;
  failCount: number;
  skipCount: number;
  tookMs: number;
  resultsJson: string;
  createdAt: Date;
}): HealthRun {
  return {
    id: row.id,
    trigger: row.trigger,
    deep: row.deep,
    status: (row.status as HealthRun["status"]) ?? "warn",
    okCount: row.okCount,
    warnCount: row.warnCount,
    failCount: row.failCount,
    skipCount: row.skipCount,
    tookMs: row.tookMs,
    createdAt: row.createdAt.toISOString(),
    results: jparse<HealthCheckResult[]>(row.resultsJson, []),
  };
}

// One battery per shop at a time, whatever triggered it: concurrent calls
// (double-clicked button, auto-run racing an external poll, hammered &run=1)
// coalesce onto the in-flight run instead of stacking paid probes.
const runsInFlight = new Map<string, Promise<HealthRun>>();

/**
 * Run the full battery against the live store and persist the result.
 * Never throws. `deep` additionally runs the two checks that call paid /
 * mutating externals (translation probe, discount code round-trip).
 * Concurrent calls for the same shop share one run.
 */
/**
 * Run ONE check by id against a hand-built context — for smoke tests and
 * one-off diagnostics (e.g. probing a specific store's checkout flag from a
 * script). Returns null for an unknown id. Never throws.
 */
export async function runSingleHealthCheck(
  id: string,
  ctx: {
    shop: string;
    settings?: AppSettings;
    graphql?: AdminGraphql | null;
    shopInfo?: Ctx["shopInfo"];
    deep?: boolean;
  },
): Promise<HealthCheckResult | null> {
  const def = CHECKS.find((c) => c.id === id);
  if (!def) return null;
  const full: Ctx = {
    shop: ctx.shop,
    settings: ctx.settings ?? (await getSettings(ctx.shop)),
    deep: ctx.deep ?? false,
    trigger: "manual",
    graphql: ctx.graphql ?? null,
    graphqlError: null,
    shopInfo: ctx.shopInfo ?? null,
    graphqlLatencyMs: null,
    deprecationReason: null,
    shopifyDateMs: null,
  };
  const started = Date.now();
  try {
    const outcome = await withTimeout(def.run(full), CHECK_TIMEOUT_MS);
    return { id: def.id, group: def.group, name: def.name, tookMs: Date.now() - started, ...outcome };
  } catch (error) {
    return {
      id: def.id,
      group: def.group,
      name: def.name,
      tookMs: Date.now() - started,
      ...fail("Check crashed.", "See the attached error.", { error: error instanceof Error ? error.message : String(error) }),
    };
  }
}

export function runHealthChecks(
  shop: string,
  opts: { trigger: "manual" | "auto" | "external"; deep?: boolean },
): Promise<HealthRun> {
  const inFlight = runsInFlight.get(shop);
  if (inFlight) return inFlight;
  const promise = executeHealthRun(shop, opts).finally(() => runsInFlight.delete(shop));
  runsInFlight.set(shop, promise);
  return promise;
}

async function executeHealthRun(
  shop: string,
  opts: { trigger: "manual" | "auto" | "external"; deep?: boolean },
): Promise<HealthRun> {
  const startedAt = Date.now();
  let results: HealthCheckResult[];
  try {
    // Sweep debris from earlier crashed/timed-out runs BEFORE probing — the
    // self-cleaning probes delete their own rows in finally blocks, but a
    // process death mid-run can strand them, and the timeout wrapper cannot
    // cancel an in-flight probe.
    // (the >60s age guard leaves a concurrent replica's fresh probes alone)
    await prisma.issuedOffer
      .deleteMany({ where: { shop, referenceId: { startsWith: "health:" }, createdAt: { lt: new Date(startedAt - 60_000) } } })
      .catch(() => {});
    await prisma.eventDedup
      .deleteMany({ where: { shop, referenceId: { startsWith: "health:" }, createdAt: { lt: new Date(startedAt - 60_000) } } })
      .catch(() => {});

    const ctx = await buildContext(shop, Boolean(opts.deep), opts.trigger);
    results = await Promise.all(
      CHECKS.map(async (def) => {
        const checkStarted = Date.now();
        const outcome = await withTimeout(
          Promise.resolve().then(() => def.run(ctx)),
          CHECK_TIMEOUT_MS,
        );
        return { id: def.id, group: def.group, name: def.name, tookMs: Date.now() - checkStarted, ...outcome };
      }),
    );
  } catch (error) {
    // Even context construction failing must produce a stored, visible run.
    results = [
      {
        id: "runner",
        group: "Environment",
        name: "Health-check runner",
        status: "fail",
        summary: `The runner itself failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: "This usually means the database is unreachable — nothing else can work either.",
        tookMs: Date.now() - startedAt,
      },
    ];
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  const status: HealthRun["status"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "ok";
  const tookMs = Date.now() - startedAt;

  // Every full run also leaves a timestamped gate sample (see GateSample).
  const availability = results.find((r) => r.id === "shopify.post-purchase-availability");
  if (availability) void recordGateSample(shop, availability, "health").catch(() => {});

  try {
    const row = await prisma.healthCheckRun.create({
      data: {
        shop,
        trigger: opts.trigger,
        deep: Boolean(opts.deep),
        status,
        okCount,
        warnCount,
        failCount,
        skipCount,
        tookMs,
        resultsJson: jstr(results),
      },
    });
    // Prune history beyond the last RUNS_KEPT.
    const stale = await prisma.healthCheckRun.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: RUNS_KEPT,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.healthCheckRun.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
    return rowToRun(row);
  } catch (error) {
    console.error(`[health] persisting run failed for ${shop}`, error);
    return {
      id: "unpersisted",
      trigger: opts.trigger,
      deep: Boolean(opts.deep),
      status,
      okCount,
      warnCount,
      failCount,
      skipCount,
      tookMs,
      createdAt: new Date().toISOString(),
      results,
    };
  }
}

export async function getLatestHealthRun(shop: string): Promise<HealthRun | null> {
  try {
    const row = await prisma.healthCheckRun.findFirst({ where: { shop }, orderBy: { createdAt: "desc" } });
    return row ? rowToRun(row) : null;
  } catch {
    return null;
  }
}

export async function listHealthRuns(shop: string, take: number = 10): Promise<HealthRun[]> {
  try {
    const rows = await prisma.healthCheckRun.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take });
    return rows.map(rowToRun);
  } catch {
    return [];
  }
}

// One auto-run at a time per process; admin loaders call this fire-and-forget.
const autoRunsInFlight = new Set<string>();

/**
 * Kick off a background run when the latest run is older than the auto-run
 * interval (6h). Called (void'ed) from admin loaders so the battery keeps
 * running as long as anyone opens the admin — no cron infrastructure needed.
 * Never throws; never blocks the caller.
 */
export function maybeAutoRunHealthChecks(shop: string): void {
  if (autoRunsInFlight.has(shop)) return;
  autoRunsInFlight.add(shop);
  (async () => {
    try {
      const latest = await prisma.healthCheckRun.findFirst({
        where: { shop },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < AUTO_RUN_INTERVAL_MS) return;
      await runHealthChecks(shop, { trigger: "auto" });
    } catch (error) {
      console.error(`[health] auto run failed for ${shop}`, error);
    } finally {
      autoRunsInFlight.delete(shop);
    }
  })();
}

// ── Post-purchase gate monitor ───────────────────────────────────────────────
//
// Shopify's gate for the post-purchase page — the checkout's
// `postPurchaseExtensionAvailable` flag plus `app { isPostPurchaseAppInUse }` —
// is LIVE STATE: on cellexialabs.com it read off → on → off within one hour on
// 2026-08-18 without any deploy (a re-saved checkout selection, an uninstall/
// reinstall, a released version without the extension, or a lapsed approval
// all move it). A single reading therefore proves nothing about the moment a
// test order was placed; a timeline does. Samples come from every full health
// run, from admin loaders (throttled), and from the external monitor
// (`/api/health?…&gate=1`).

const GATE_SAMPLE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const GATE_SAMPLE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const gateSamplesInFlight = new Set<string>();
const lastGateSampleAt = new Map<string, number>();

export interface GateSampleRow {
  at: string;
  storefrontFlag: boolean | null;
  inUse: boolean | null;
  source: string;
  note: string | null;
}

async function recordGateSample(shop: string, result: HealthCheckResult, source: string): Promise<GateSampleRow> {
  const detail = (result.detail ?? {}) as { storefrontFlag?: string | null; isPostPurchaseAppInUse?: boolean | null };
  const flag = detail.storefrontFlag === "true" ? true : detail.storefrontFlag === "false" ? false : null;
  const inUse = typeof detail.isPostPurchaseAppInUse === "boolean" ? detail.isPostPurchaseAppInUse : null;
  const note = `${result.status}: ${result.summary}`.slice(0, 300);
  const row = await prisma.gateSample.create({ data: { shop, storefrontFlag: flag, inUse, source, note } });
  await prisma.gateSample
    .deleteMany({ where: { shop, at: { lt: new Date(Date.now() - GATE_SAMPLE_RETENTION_MS) } } })
    .catch(() => {});
  return { at: row.at.toISOString(), storefrontFlag: flag, inUse, source, note };
}

/**
 * Take one gate sample now (one Admin GraphQL query + one storefront checkout
 * fetch). Used by the throttled admin sampler and the external monitor; the
 * full battery records its own sample.
 */
export async function samplePostPurchaseGate(shop: string, source: string): Promise<GateSampleRow | null> {
  const ctx = await buildContext(shop, false, "auto");
  const def = CHECKS.find((c) => c.id === "shopify.post-purchase-availability");
  if (!def) return null;
  const started = Date.now();
  let outcome: Omit<HealthCheckResult, "id" | "group" | "name" | "tookMs">;
  try {
    outcome = await withTimeout(def.run(ctx), CHECK_TIMEOUT_MS);
  } catch (error) {
    outcome = { status: "fail", summary: `Check crashed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result: HealthCheckResult = { id: def.id, group: def.group, name: def.name, tookMs: Date.now() - started, ...outcome };
  return recordGateSample(shop, result, source);
}

/** Fire-and-forget, throttled sampler for admin loaders (dashboard, Debug). */
export function maybeSamplePostPurchaseGate(shop: string): void {
  const last = lastGateSampleAt.get(shop) ?? 0;
  if (Date.now() - last < GATE_SAMPLE_MIN_INTERVAL_MS || gateSamplesInFlight.has(shop)) return;
  gateSamplesInFlight.add(shop);
  (async () => {
    try {
      const latest = await prisma.gateSample.findFirst({ where: { shop }, orderBy: { at: "desc" }, select: { at: true } });
      if (latest && Date.now() - latest.at.getTime() < GATE_SAMPLE_MIN_INTERVAL_MS) {
        lastGateSampleAt.set(shop, latest.at.getTime());
        return;
      }
      lastGateSampleAt.set(shop, Date.now());
      await samplePostPurchaseGate(shop, "auto");
    } catch (error) {
      console.error(`[health] gate sample failed for ${shop}`, error);
    } finally {
      gateSamplesInFlight.delete(shop);
    }
  })();
}

/** Latest gate samples (newest first) for the Debug tab timeline; [] when the table is missing. */
export async function listGateSamples(shop: string, take = 100): Promise<GateSampleRow[]> {
  try {
    const rows = await prisma.gateSample.findMany({ where: { shop }, orderBy: { at: "desc" }, take });
    return rows.map((r) => ({ at: r.at.toISOString(), storefrontFlag: r.storefrontFlag, inUse: r.inUse, source: r.source, note: r.note }));
  } catch {
    return [];
  }
}

/**
 * Token for the external monitor endpoint (/api/health?shop=…&token=…) —
 * derived from the app secret so it needs no storage and no extra config.
 * If the URL ever leaks, set (or change) HEALTH_MONITOR_SALT in the
 * environment: every monitor URL rotates immediately without touching the
 * app secret. The Debug tab always shows the current URL.
 */
export function healthMonitorToken(shop: string): string {
  const salt = process.env.HEALTH_MONITOR_SALT ?? "v1";
  return createHash("sha256")
    .update(`${process.env.SHOPIFY_API_SECRET ?? ""}:health-monitor:${salt}:${shop}`)
    .digest("hex")
    .slice(0, 32);
}
