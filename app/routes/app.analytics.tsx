// ─────────────────────────────────────────────────────────────────────────────
// Analytics — funnel stats, offer performance, breakdowns, A/B experiment
// results and 60/90-day CLV cohorts, with a 7/30/90-day range selector and
// CSV export (?export=offers|events) handled directly in the loader.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getBreakdown,
  getClvCohorts,
  getDashboardStats,
  getExperimentResults,
  getOfferPerformance,
  toCsv,
} from "../services/analytics.server";
import type {
  DashboardStats,
  ExperimentRow,
  OfferPerfRow,
} from "../services/analytics.server";

type BreakdownRow = {
  key: string;
  impressions: number;
  accepts: number;
  acceptanceRate: number;
  revenue: number;
};

type ClvRow = {
  cohort: "accepted" | "declined" | "not_shown";
  customers: number;
  avgFollowOnRevenue: number;
  avgFollowOnOrders: number;
};

interface AnalyticsLoaderData {
  days: number;
  stats: DashboardStats;
  offerRows: OfferPerfRow[];
  byCountry: BreakdownRow[];
  byLanguage: BreakdownRow[];
  bySurface: BreakdownRow[];
  experiments: ExperimentRow[];
  clv60: ClvRow[];
  clv90: ClvRow[];
}

async function exportCsv(
  shop: string,
  days: number,
  kind: "offers" | "events",
): Promise<Response> {
  let rows: Array<Record<string, unknown>>;
  if (kind === "offers") {
    const perf = await getOfferPerformance(shop, days);
    rows = perf.map((row) => ({ ...row }));
  } else {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = await prisma.offerEvent.findMany({
      where: { shop, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10000,
    });
    rows = events.map((event) => ({
      createdAt: event.createdAt.toISOString(),
      eventType: event.eventType,
      surface: event.surface,
      referenceId: event.referenceId,
      orderId: event.orderId ?? "",
      customerId: event.customerId ?? "",
      ruleId: event.ruleId ?? "",
      candidateId: event.candidateId ?? "",
      productId: event.productId ?? "",
      variantId: event.variantId ?? "",
      position: event.position ?? "",
      revenue: event.revenue,
      grossProfit: event.grossProfit,
      discountPct: event.discountPct,
      market: event.market ?? "",
      country: event.country ?? "",
      language: event.language ?? "",
    }));
  }
  const csv = await toCsv(rows);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="upsell-${kind}-${days}d.csv"`,
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = daysParam === 7 || daysParam === 90 ? daysParam : 30;
  const exportKind = url.searchParams.get("export");

  if (exportKind === "offers" || exportKind === "events") {
    return exportCsv(shop, days, exportKind);
  }

  const [
    stats,
    offerRows,
    byCountry,
    byLanguage,
    bySurface,
    experiments,
    clv60,
    clv90,
  ] = await Promise.all([
    getDashboardStats(shop, days),
    getOfferPerformance(shop, days),
    getBreakdown(shop, days, "country"),
    getBreakdown(shop, days, "language"),
    getBreakdown(shop, days, "surface"),
    getExperimentResults(shop),
    getClvCohorts(shop, 60),
    getClvCohorts(shop, 90),
  ]);

  const data: AnalyticsLoaderData = {
    days,
    stats,
    offerRows,
    byCountry,
    byLanguage,
    bySurface,
    experiments,
    clv60: clv60 as ClvRow[],
    clv90: clv90 as ClvRow[],
  };
  return json(data);
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

function surfaceLabel(key: string): string {
  if (key === "thank_you") return "Thank-you page";
  if (key === "post_purchase") return "Post-purchase";
  return key || "—";
}

const COHORT_LABELS: Record<ClvRow["cohort"], string> = {
  accepted: "Accepted an upsell",
  declined: "Saw offers, never accepted",
  not_shown: "Never shown an offer",
};

function BreakdownCard({
  title,
  keyHeading,
  rows,
  currency,
  mapKey,
}: {
  title: string;
  keyHeading: string;
  rows: BreakdownRow[];
  currency: string;
  mapKey?: (key: string) => string;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        {rows.length === 0 ? (
          <Text as="p" tone="subdued">
            No data for this period.
          </Text>
        ) : (
          <DataTable
            columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
            headings={[keyHeading, "Impr.", "Accepts", "Rate", "Revenue"]}
            rows={rows.map((row) => [
              mapKey ? mapKey(row.key) : row.key || "—",
              row.impressions.toLocaleString("en"),
              row.accepts.toLocaleString("en"),
              formatPct(row.acceptanceRate),
              formatMoney(row.revenue, currency),
            ])}
          />
        )}
      </BlockStack>
    </Card>
  );
}

function ClvWindowCard({
  windowDays,
  rows,
  currency,
}: {
  windowDays: number;
  rows: ClvRow[];
  currency: string;
}) {
  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          {windowDays}-day window
        </Text>
        {rows.every((row) => row.customers === 0) ? (
          <Text as="p" tone="subdued">
            Not enough history yet — this cohort appears once first offers are
            at least {windowDays} days old.
          </Text>
        ) : (
          <DataTable
            columnContentTypes={["text", "numeric", "numeric", "numeric"]}
            headings={["Cohort", "Customers", "Avg follow-on revenue", "Avg follow-on orders"]}
            rows={rows.map((row) => [
              COHORT_LABELS[row.cohort] ?? row.cohort,
              row.customers.toLocaleString("en"),
              formatMoney(row.avgFollowOnRevenue, currency),
              row.avgFollowOnOrders.toFixed(2),
            ])}
          />
        )}
      </BlockStack>
    </Box>
  );
}

export default function AnalyticsPage() {
  // The loader's return type is widened by the CSV-export Response branch, so
  // the render-path data shape is pinned explicitly here.
  const data = useLoaderData<typeof loader>() as unknown as AnalyticsLoaderData;
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const [exporting, setExporting] = useState<"offers" | "events" | null>(null);
  const { days, stats } = data;
  const currency = stats.currency;

  const handleDaysChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("days", value);
    next.delete("export");
    setSearchParams(next);
  };

  // Same-origin fetch: App Bridge injects the session token, which a plain
  // new-tab navigation would lack (it would bounce to /auth/login instead of
  // returning the file). Download the CSV via a temporary Blob anchor.
  const handleExport = async (kind: "offers" | "events") => {
    setExporting(kind);
    try {
      const response = await fetch(
        `/app/analytics?days=${days}&export=${kind}`,
      );
      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }
      const csv = await response.text();
      const blobUrl = URL.createObjectURL(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `upsell-${kind}-${days}d.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("[analytics] CSV export failed", error);
      shopify.toast.show("CSV export failed — please try again.", {
        isError: true,
      });
    } finally {
      setExporting(null);
    }
  };

  const funnelStats = [
    { label: "Impressions", value: stats.impressions.toLocaleString("en") },
    { label: "Accepts", value: stats.accepts.toLocaleString("en") },
    { label: "Declines", value: stats.declines.toLocaleString("en") },
    { label: "Acceptance rate", value: formatPct(stats.acceptanceRate) },
    {
      label: "Upsell revenue",
      value: formatMoney(stats.upsellRevenue, currency),
    },
    {
      label: "Gross profit",
      value: formatMoney(stats.upsellGrossProfit, currency),
    },
    {
      label: "GP / impression",
      value: formatMoney(stats.gpPerImpression, currency),
    },
    {
      label: "Offer pages / order",
      value: stats.offersPerOrderShown.toFixed(2),
    },
  ];

  return (
    <Page
      title="Analytics"
      subtitle="How your post-purchase and thank-you offers are performing"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="180px">
                <Select
                  label="Date range"
                  options={[
                    { label: "Last 7 days", value: "7" },
                    { label: "Last 30 days", value: "30" },
                    { label: "Last 90 days", value: "90" },
                  ]}
                  value={String(days)}
                  onChange={handleDaysChange}
                />
              </Box>
              <Button
                onClick={() => handleExport("offers")}
                loading={exporting === "offers"}
                disabled={exporting !== null}
              >
                Export offers CSV
              </Button>
              <Button
                onClick={() => handleExport("events")}
                loading={exporting === "events"}
                disabled={exporting !== null}
              >
                Export events CSV
              </Button>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Funnel — last {days} days
              </Text>
              <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
                {funnelStats.map((stat) => (
                  <BlockStack key={stat.label} gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {stat.label}
                    </Text>
                    <Text as="p" variant="headingMd">
                      {stat.value}
                    </Text>
                  </BlockStack>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Offer performance — last {days} days
              </Text>
              {data.offerRows.length === 0 ? (
                <Text as="p" tone="subdued">
                  No offers were shown in this period.
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
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Product",
                    "Surface",
                    "Impressions",
                    "Accepts",
                    "Accept rate",
                    "Avg discount",
                    "Revenue",
                    "Gross profit",
                    "GP / impression",
                  ]}
                  rows={data.offerRows.map((row) => [
                    row.title,
                    surfaceLabel(row.surface),
                    row.impressions.toLocaleString("en"),
                    row.accepts.toLocaleString("en"),
                    formatPct(row.acceptanceRate),
                    `${row.avgDiscountPct.toFixed(1)}%`,
                    formatMoney(row.revenue, currency),
                    formatMoney(row.grossProfit, currency),
                    formatMoney(row.gpPerImpression, currency),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BreakdownCard
            title="By country"
            keyHeading="Country"
            rows={data.byCountry}
            currency={currency}
          />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <BreakdownCard
            title="By language"
            keyHeading="Language"
            rows={data.byLanguage}
            currency={currency}
          />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <BreakdownCard
            title="By surface"
            keyHeading="Surface"
            rows={data.bySurface}
            currency={currency}
            mapKey={surfaceLabel}
          />
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                A/B experiments
              </Text>
              <Text as="p" tone="subdued">
                Slots with two or more candidate products rotate via Thompson
                sampling. “P(best)” is the posterior probability that a
                candidate is the best performer in its slot; a winner is
                auto-picked once it clears your confidence threshold.
              </Text>
              {data.experiments.length === 0 ? (
                <Text as="p" tone="subdued">
                  No experiments running — add two or more candidate products
                  to a rule slot to start a rotation.
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "numeric",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                  ]}
                  headings={[
                    "Rule",
                    "Slot",
                    "Candidate",
                    "Impressions",
                    "Accepts",
                    "Accept rate",
                    "Revenue",
                    "P(best)",
                    "Status",
                  ]}
                  rows={data.experiments.map((row) => [
                    row.ruleName,
                    String(row.slotPosition),
                    row.productTitle,
                    row.impressions.toLocaleString("en"),
                    row.accepts.toLocaleString("en"),
                    formatPct(row.acceptanceRate),
                    formatMoney(row.revenue, currency),
                    `${Math.round(row.probBest * 100)}%`,
                    row.isWinner ? (
                      <Badge tone="success">Winner</Badge>
                    ) : (
                      <Badge>Testing</Badge>
                    ),
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
                Customer lifetime value cohorts
              </Text>
              <Text as="p" tone="subdued">
                In plain English: we take customers whose first upsell offer is
                at least 60 (or 90) days old and compare what each group spent
                with you in the 60 (or 90) days after that offer — excluding
                the order that triggered it. If customers who accepted an
                upsell go on to spend more than those who declined or were
                never shown one, your offers are building long-term value
                rather than just one-off revenue.
              </Text>
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                <ClvWindowCard
                  windowDays={60}
                  rows={data.clv60}
                  currency={currency}
                />
                <ClvWindowCard
                  windowDays={90}
                  rows={data.clv90}
                  currency={currency}
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
