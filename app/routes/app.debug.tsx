// ─────────────────────────────────────────────────────────────────────────────
// Debug tab — every recorded offer-assembly trace, newest first.
//
// Admin previews are ALWAYS traced. Live buyer requests are traced when the
// "Record live buyer requests" toggle is on (settings.debugLiveRequests) —
// tracing is in-memory during the request with one fire-and-forget DB write
// at the end, so it never slows or breaks the buyer path. Rows are pruned
// after 7 days automatically. Thank-you-page offers are not traced yet.
//
// Each trace carries: purchase context, settings snapshot, market matching
// (including duplicate-row detection), language resolution, per-product name
// + grounding provenance with cache-row timestamps, contextual pricing per
// variant with the accept/reject reason, copy cache keys and hits, the EXACT
// rendered prompts, the raw model output, and a foreign-language product-name
// scan across all of it.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useEffect } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings, saveSettings } from "../services/settings.server";
import type { DebugEntry } from "../services/debug.server";

interface EventSummary {
  language?: string;
  languageSource?: string | null;
  market?: string | null;
  country?: string | null;
  offers?: number;
  currency?: string;
  pricingSource?: string | null;
  copySources?: string[];
  aliasHits?: number;
  tookMs?: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const eventId = url.searchParams.get("event");

  const [settings, rows] = await Promise.all([
    getSettings(shop),
    prisma.debugEvent.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        referenceId: true,
        surface: true,
        summaryJson: true,
        createdAt: true,
      },
    }),
  ]);

  let detail: {
    id: string;
    referenceId: string;
    surface: string;
    createdAt: string;
    summary: EventSummary;
    entries: DebugEntry[];
  } | null = null;
  if (eventId) {
    const row = await prisma.debugEvent.findUnique({ where: { id: eventId } });
    if (row && row.shop === shop) {
      detail = {
        id: row.id,
        referenceId: row.referenceId,
        surface: row.surface,
        createdAt: row.createdAt.toISOString(),
        summary: jparse<EventSummary>(row.summaryJson, {}),
        entries: jparse<DebugEntry[]>(row.dataJson, []),
      };
    }
  }

  return json({
    events: rows.map((row) => ({
      id: row.id,
      referenceId: row.referenceId,
      surface: row.surface,
      createdAt: row.createdAt.toISOString(),
      summary: jparse<EventSummary>(row.summaryJson, {}),
    })),
    detail,
    debugLiveRequests: settings.debugLiveRequests,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggleLive") {
    const on = String(formData.get("value") ?? "") === "1";
    await saveSettings(shop, { debugLiveRequests: on });
    return json({
      ok: true,
      message: on
        ? "Live buyer requests now record debug traces (7-day retention). Turn this off again after diagnosing."
        : "Live debug recording is off — previews are still always traced.",
    });
  }

  if (intent === "clear") {
    const { count } = await prisma.debugEvent.deleteMany({ where: { shop } });
    return json({ ok: true, message: `Cleared ${count} trace${count === 1 ? "" : "s"}.` });
  }

  return json({ ok: false, message: "Unknown action." }, { status: 400 });
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function DebugPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const toggleLive = (checked: boolean) => {
    const fd = new FormData();
    fd.set("intent", "toggleLive");
    fd.set("value", checked ? "1" : "0");
    fetcher.submit(fd, { method: "post" });
  };

  const clearAll = () => {
    const fd = new FormData();
    fd.set("intent", "clear");
    fetcher.submit(fd, { method: "post" });
    setSearchParams({}, { replace: true });
  };

  const detail = data.detail;

  return (
    <Page
      title="Debug"
      subtitle="Full traces of offer generations — resolution steps, exact prompts, raw model output, and the foreign-language name scan."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Checkbox
                    label="Record live buyer requests"
                    checked={data.debugLiveRequests}
                    onChange={toggleLive}
                    helpText="Previews are always traced. Turn this on to also trace real post-purchase requests, then reproduce the problem and check back here. Traces auto-delete after 7 days."
                  />
                  <Button
                    tone="critical"
                    variant="secondary"
                    onClick={clearAll}
                    disabled={data.events.length === 0}
                  >
                    Clear all traces
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {detail ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingMd">
                        {detail.referenceId}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`${detail.surface} · ${formatTime(detail.createdAt)}`}
                      </Text>
                    </BlockStack>
                    <Link to="/app/debug">Back to list</Link>
                  </InlineStack>
                  {typeof detail.summary.aliasHits === "number" &&
                  detail.summary.aliasHits > 0 ? (
                    <Banner
                      tone="critical"
                      title={`${detail.summary.aliasHits} foreign-language product name hit${detail.summary.aliasHits === 1 ? "" : "s"} — open the alias-scan entry below for exact locations`}
                    />
                  ) : null}
                  <Divider />
                  <BlockStack gap="100">
                    {detail.entries.map((entry, i) => (
                      <details key={i} open={entry.stage === "alias-scan" || entry.stage === "summary"}>
                        <summary style={{ cursor: "pointer", padding: "2px 0" }}>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {entry.stage}
                          </Text>{" "}
                          <Text as="span" variant="bodySm" tone="subdued">
                            {`+${entry.atMs} ms`}
                          </Text>
                        </summary>
                        <pre
                          style={{
                            margin: "4px 0 8px",
                            padding: "8px 12px",
                            background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                            borderRadius: 8,
                            fontSize: 11,
                            lineHeight: 1.45,
                            overflow: "auto",
                            maxHeight: 480,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {JSON.stringify(entry.data, null, 2)}
                        </pre>
                      </details>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent traces
                </Text>
                {data.events.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No traces yet. Generate a preview (always traced) or enable
                    live recording above and place a test order.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {data.events.map((event) => {
                      const s = event.summary;
                      const isOpen = searchParams.get("event") === event.id;
                      return (
                        <Box
                          key={event.id}
                          padding="200"
                          borderRadius="200"
                          background={isOpen ? "bg-surface-active" : "bg-surface-secondary"}
                        >
                          <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                            <BlockStack gap="050">
                              <Link to={`/app/debug?event=${event.id}`}>
                                <Text as="span" variant="bodySm" fontWeight="semibold">
                                  {event.referenceId}
                                </Text>
                              </Link>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {`${event.surface} · ${formatTime(event.createdAt)}${typeof s.tookMs === "number" ? ` · ${s.tookMs} ms` : ""}`}
                              </Text>
                            </BlockStack>
                            <InlineStack gap="150" blockAlign="center" wrap>
                              {s.language ? <Badge>{`lang: ${s.language}${s.languageSource ? ` (${s.languageSource})` : ""}`}</Badge> : null}
                              {s.country ? <Badge>{`country: ${s.country}`}</Badge> : null}
                              {s.market ? <Badge>{`market: ${s.market}`}</Badge> : null}
                              {s.pricingSource ? (
                                <Badge tone={s.pricingSource === "contextual" ? "success" : s.pricingSource === "fx" ? "warning" : undefined}>
                                  {`pricing: ${s.pricingSource}`}
                                </Badge>
                              ) : null}
                              {typeof s.offers === "number" ? <Badge>{`${s.offers} offer${s.offers === 1 ? "" : "s"}`}</Badge> : null}
                              {typeof s.aliasHits === "number" && s.aliasHits > 0 ? (
                                <Badge tone="critical">{`${s.aliasHits} foreign-name hit${s.aliasHits === 1 ? "" : "s"}`}</Badge>
                              ) : null}
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
