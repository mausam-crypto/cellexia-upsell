// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — 30-day KPIs, impressions/accepts chart, top offers and a setup
// checklist. The "Sync catalog & markets" action refreshes the local product
// cache and market/locale settings via the Admin API.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  DataTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../services/settings.server";
import {
  getDashboardStats,
  getOfferPerformance,
  getTimeSeries,
} from "../services/analytics.server";
import { autoPickWinners } from "../services/recommendation.server";
import { ensurePromptRulesFresh, ensureUiStringsFresh } from "../services/ai.server";
import { syncCatalog, syncMarketsAndLocales } from "../services/catalog.server";
import { getLatestHealthRun, maybeAutoRunHealthChecks, maybeSamplePostPurchaseGate } from "../services/health.server";
import { inquiryStats } from "../services/inquiry-log.server";
import type { AdminGraphql } from "../types";
import { MiniChart } from "../components/MiniChart";

const DASHBOARD_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getSettings(shop);

  // Opportunistic: promote experiment winners whenever the merchant looks at
  // the dashboard. Cheap, and must never break the page.
  try {
    await autoPickWinners(shop, settings);
  } catch (error) {
    console.error("[dashboard] autoPickWinners failed", error);
  }

  // Fire-and-forget: self-heal buyer-facing UI strings. Newly added keys in
  // DEFAULT_UI_STRINGS_EN are seeded and auto-translated in the background —
  // no reinstall needed — and stale old-default values are normalized. Must
  // never block or break the dashboard.
  try {
    void ensureUiStringsFresh(shop).catch((error: unknown) => {
      console.error("[dashboard] ensureUiStringsFresh failed", error);
    });
    // Same self-heal for prompt templates: improved rule sentences are
    // patched into stored templates (edit-preserving) without a manual
    // "Reset prompts"; the version bump regenerates cached copy.
    void ensurePromptRulesFresh(shop).catch((error: unknown) => {
      console.error("[dashboard] ensurePromptRulesFresh failed", error);
    });
  } catch (error) {
    console.error("[dashboard] ensureUiStringsFresh failed", error);
  }

  // Housekeeping: prune IssuedOffer rows that expired more than a day ago,
  // EventDedup claims older than 7 days (replay protection only needs to
  // outlive the offer TTL; OfferEvent rows are the durable analytics record),
  // and CopyCache rows older than 45 days — the grounding-aware cache key
  // orphans rows whenever a product name or description changes, so old rows
  // are unreachable garbage, and 45 days comfortably outlives any hot entry.
  // Rows holding a discountSuggestion are EXEMPT: the baseline-pct row keeps
  // the adopted AI discount alive via peekDiscountSuggestion on every
  // assembly but is never rewritten, so age says nothing about its liveness
  // — pruning it would silently reset discount convergence.
  try {
    await prisma.issuedOffer.deleteMany({
      where: { shop, expiresAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    await prisma.eventDedup.deleteMany({
      where: { shop, createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
    });
    await prisma.copyCache.deleteMany({
      where: {
        shop,
        createdAt: { lt: new Date(Date.now() - 45 * 24 * 3600 * 1000) },
        discountSuggestion: null,
      },
    });
  } catch (error) {
    console.error("[dashboard] housekeeping prune failed", error);
  }

  // Keep the live health-check battery running on its 6h cadence whenever the
  // admin is used (fire-and-forget), and surface the latest verdict below.
  maybeAutoRunHealthChecks(shop);
  maybeSamplePostPurchaseGate(shop);

  const [stats, timeSeries, offerRows, shopRow, enabledRuleCount, healthRun, inquiries24h] =
    await Promise.all([
      getDashboardStats(shop, DASHBOARD_DAYS),
      getTimeSeries(shop, DASHBOARD_DAYS),
      getOfferPerformance(shop, DASHBOARD_DAYS),
      prisma.shop.findUnique({ where: { shop } }),
      prisma.offerRule.count({ where: { shop, enabled: true } }),
      getLatestHealthRun(shop),
      // ShouldRender calls Shopify sent in the last 24 h (v1.9 inquiry log);
      // null when the table is missing (deployment skipped `prisma db push`).
      inquiryStats(shop, 24 * 3600 * 1000, { light: true }).catch(() => null),
    ]);

  return json({
    inquiries24h: inquiries24h
      ? { total: inquiries24h.total, withOffers: inquiries24h.withOffers, avgTookMs: inquiries24h.avgTookMs }
      : null,
    health: healthRun
      ? {
          status: healthRun.status,
          failCount: healthRun.failCount,
          warnCount: healthRun.warnCount,
          createdAt: healthRun.createdAt,
          failing: healthRun.results
            .filter((r) => r.status === "fail")
            .slice(0, 3)
            .map((r) => r.name),
          // Shopify's own per-store gate for the post-purchase page — surfaced
          // separately because when it is closed NOTHING else in this app can
          // make an offer appear (the backend is never called).
          postPurchaseAvailable: (() => {
            const row = healthRun.results.find((r) => r.id === "shopify.post-purchase-availability");
            if (!row) return null;
            return row.status === "ok" ? true : row.status === "fail" ? false : null;
          })(),
          currencyEligibility: (() => {
            const row = healthRun.results.find((r) => r.id === "flow.currency-eligibility");
            return row && row.status !== "skip" ? row.summary : null;
          })(),
        }
      : null,
    stats,
    series: timeSeries.map((point) => ({
      date: point.date,
      impressions: point.impressions,
      accepts: point.accepts,
    })),
    topOffers: offerRows.slice(0, 5),
    checklist: {
      appEnabled: settings.enabled,
      thankYouEnabled: settings.thankYouEnabled,
      catalogSynced: Boolean(shopRow?.catalogSyncedAt),
      catalogSyncedAt: shopRow?.catalogSyncedAt
        ? shopRow.catalogSyncedAt.toISOString()
        : null,
      aiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
      enabledRuleCount,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync") {
    try {
      const graphql = admin.graphql as unknown as AdminGraphql;
      // Markets & locales first: freshly published locales land in
      // settings.languages before syncCatalog runs its translation pass, so
      // the same run covers them.
      await syncMarketsAndLocales(graphql, session.shop);
      const { count } = await syncCatalog(graphql, session.shop);
      return json({
        ok: true,
        message: `Catalog synced — ${count} products cached. Markets and locales refreshed.`,
      });
    } catch (error) {
      console.error("[dashboard] sync failed", error);
      return json({
        ok: false,
        message: "Sync failed — check the server logs and try again.",
      });
    }
  }

  return json({ ok: false, message: "Unknown action." });
};

function formatMoney(amount: number, currency: string, locale = "en"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      amount,
    );
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const { stats, series, topOffers, checklist, health } = data;
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const syncing = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const handleSync = () => {
    fetcher.submit({ intent: "sync" }, { method: "post" });
  };

  const kpis = [
    { label: "Impressions", value: stats.impressions.toLocaleString("en") },
    { label: "Acceptance rate", value: formatPct(stats.acceptanceRate) },
    {
      label: "Upsell revenue",
      value: formatMoney(stats.upsellRevenue, stats.currency),
    },
    {
      label: "Gross profit",
      value: formatMoney(stats.upsellGrossProfit, stats.currency),
    },
    {
      label: "GP / impression",
      value: formatMoney(stats.gpPerImpression, stats.currency),
    },
  ];

  const coreSetupDone =
    checklist.appEnabled && checklist.catalogSynced && checklist.aiKeySet;

  const checklistItems: Array<{
    key: string;
    done: boolean;
    badge: string;
    tone: "success" | "attention" | "info" | "critical";
    text: string;
  }> = [
    {
      key: "enabled",
      done: checklist.appEnabled,
      badge: checklist.appEnabled ? "Done" : "To do",
      tone: checklist.appEnabled ? "success" : "attention",
      text: checklist.appEnabled
        ? "Post-purchase offers are enabled."
        : "Offers are turned off — enable them under Settings → General.",
    },
    {
      key: "catalog",
      done: checklist.catalogSynced,
      badge: checklist.catalogSynced ? "Done" : "To do",
      tone: checklist.catalogSynced ? "success" : "attention",
      text: checklist.catalogSynced
        ? `Catalog synced${
            checklist.catalogSyncedAt
              ? ` — last run ${checklist.catalogSyncedAt.slice(0, 10)}`
              : ""
          }.`
        : "Run “Sync catalog & markets” (top right) so the engine knows your products, prices and inventory.",
    },
    {
      key: "ai",
      done: checklist.aiKeySet,
      badge: checklist.aiKeySet ? "Done" : "To do",
      tone: checklist.aiKeySet ? "success" : "attention",
      text: checklist.aiKeySet
        ? "ANTHROPIC_API_KEY is set — AI-written offer copy is active."
        : "Set ANTHROPIC_API_KEY in the server environment to activate AI-written copy (template fallback copy is used until then).",
    },
    {
      key: "rules",
      done: checklist.enabledRuleCount > 0,
      badge: checklist.enabledRuleCount > 0 ? "Done" : "Optional",
      tone: checklist.enabledRuleCount > 0 ? "success" : "info",
      text:
        checklist.enabledRuleCount > 0
          ? `${checklist.enabledRuleCount} active offer rule${
              checklist.enabledRuleCount === 1 ? "" : "s"
            }.`
          : "No offer rules yet — auto-pilot ranks your catalog automatically (compatibility, margin, acceptance). Create rules under Offer rules to take control of specific baskets.",
    },
    {
      key: "checkout",
      done: health?.postPurchaseAvailable === true,
      badge:
        health?.postPurchaseAvailable === true
          ? "Done"
          : health?.postPurchaseAvailable === false
            ? "Blocked"
            : "Verify",
      tone:
        health?.postPurchaseAvailable === true
          ? "success"
          : health?.postPurchaseAvailable === false
            ? "critical"
            : "info",
      text:
        health?.postPurchaseAvailable === true
          ? `Shopify exposes the post-purchase page for this store (health check verified the live checkout flag).${
              data.inquiries24h
                ? data.inquiries24h.total > 0
                  ? ` Shopify sent ${data.inquiries24h.total} ShouldRender inquir${data.inquiries24h.total === 1 ? "y" : "ies"} in the last 24 h (${data.inquiries24h.withOffers} answered with an offer, avg ${data.inquiries24h.avgTookMs ?? "-"} ms) — details under Debug → Post-purchase inquiries.`
                  : " No ShouldRender inquiry has reached this backend in the last 24 h yet — the gate may have opened only recently; any checkout opened in the shop currency shows up under Debug → Post-purchase inquiries within seconds of the checkout page loading (the payment method only decides later whether the page is shown)."
                : ""
            }`
          : health?.postPurchaseAvailable === false
            ? "Shopify does NOT currently expose the post-purchase page for this store — no buyer can see an offer until this is fixed. Needed: (1) Partner Dashboard → this app → API access → 'Access post-purchase extensions' (mandatory on live stores), (2) a released app version containing the post-purchase extension, (3) Settings → Checkout → Post-purchase page → select this app → Save. Details in Debug → Health checks."
            : "Shopify must expose the post-purchase page for this store: your developer requests 'Access post-purchase extensions' in the Partner Dashboard (live stores only), releases the extension, and you select this app under Settings → Checkout → Post-purchase page. Run the health checks (Debug tab) to verify — offers cannot appear until that check is green.",
    },
  ];

  return (
    <Page
      title="Dashboard"
      subtitle="Post-purchase upsell performance — last 30 days"
      primaryAction={{
        content: "Sync catalog & markets",
        onAction: handleSync,
        loading: syncing,
      }}
      secondaryActions={[{ content: "View analytics", url: "/app/analytics" }]}
    >
      <Layout>
        {health && health.status === "fail" ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title={`${health.failCount} live health check${health.failCount === 1 ? " is" : "s are"} failing${health.failing.length > 0 ? `: ${health.failing.join(", ")}` : ""}`}
              action={{ content: "Open health checks", url: "/app/debug" }}
            >
              <Text as="p">
                Detected {new Date(health.createdAt).toLocaleString("en-GB")} — buyers may be affected.
                The Debug tab shows exactly what is broken and how to fix it.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
            {kpis.map((kpi) => (
              <Card key={kpi.label}>
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {kpi.label}
                  </Text>
                  <Text as="p" variant="headingLg">
                    {kpi.value}
                  </Text>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Impressions &amp; accepts — last 30 days
              </Text>
              <MiniChart
                series={series.map((point) => ({
                  date: point.date,
                  values: [point.impressions, point.accepts],
                }))}
                labels={["Impressions", "Accepts"]}
                height={160}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Top offers — last 30 days
              </Text>
              {topOffers.length === 0 ? (
                <Text as="p" tone="subdued">
                  No offer activity yet. Once buyers start seeing offers, your
                  best performers show up here.
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Product",
                    "Surface",
                    "Impressions",
                    "Accepts",
                    "Accept rate",
                    "Revenue",
                    "GP / impression",
                  ]}
                  rows={topOffers.map((row) => [
                    row.title,
                    row.surface === "thank_you" ? "Thank-you page" : "Post-purchase",
                    row.impressions.toLocaleString("en"),
                    row.accepts.toLocaleString("en"),
                    formatPct(row.acceptanceRate),
                    formatMoney(row.revenue, stats.currency),
                    formatMoney(row.gpPerImpression, stats.currency),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Setup checklist
              </Text>
              {coreSetupDone ? (
                <Banner tone="success" title="Core setup complete">
                  <p>
                    Catalog is synced, AI copy is active and offers are enabled.
                    Double-check the checkout setting below if offers are not
                    appearing.
                  </p>
                </Banner>
              ) : (
                <Banner tone="warning" title="Finish setting up">
                  <p>
                    A few steps are still needed before offers run at full
                    strength — see the list below.
                  </p>
                </Banner>
              )}
              <BlockStack gap="200">
                {checklistItems.map((item) => (
                  <InlineStack key={item.key} gap="200" blockAlign="start" wrap={false}>
                    <Badge tone={item.tone}>{item.badge}</Badge>
                    <Text as="span" variant="bodyMd">
                      {item.text}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
              <Banner tone="info" title="Who can see the post-purchase page (Shopify rules)">
                <p>
                  Shopify shows the post-purchase page only for plain
                  credit-card payments checked out in the store&apos;s own
                  currency — never for Apple Pay, Google Pay, PayPal,
                  installments or gift-card-only orders, and never when the
                  buyer paid in another currency (a Markets local currency)
                  or the order carried duties. These are platform
                  limitations. The thank-you page fallback offer
                  {checklist.thankYouEnabled
                    ? " is enabled and covers all those orders automatically."
                    : " covers all those orders — it is currently disabled under Settings → General."}
                  {health?.currencyEligibility ? ` ${health.currencyEligibility}` : ""}
                </p>
              </Banner>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
