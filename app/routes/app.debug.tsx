// ─────────────────────────────────────────────────────────────────────────────
// Debug tab — two surfaces in one place:
//
// HEALTH CHECKS (default): the live self-test battery from
// services/health.server.ts. Every key feature — billing/changeset signing,
// scopes, webhooks, payment-recovery retries, languages, catalog, AI models,
// contextual pricing — is probed against the REAL store through the same code
// paths buyers hit, so "green here" means "works on the live store", not
// "worked on my machine". Runs on demand (Run checks / Run deep checks),
// automatically every 6h while the admin is used, and via the external
// monitor endpoint (/api/health) whose URL is shown below.
//
// OFFER TRACES: every recorded offer-assembly trace, newest first. Admin
// previews are ALWAYS traced; live buyer requests are traced when the
// "Record live buyer requests" toggle is on (7-day retention).
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
  Tabs,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings, saveSettings } from "../services/settings.server";
import type { DebugEntry } from "../services/debug.server";
import {
  healthMonitorToken,
  listHealthRuns,
  maybeAutoRunHealthChecks,
  runHealthChecks,
  type HealthCheckResult,
  type HealthRun,
} from "../services/health.server";

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

  // Keep the battery running on a cadence as long as the admin is in use.
  maybeAutoRunHealthChecks(shop);

  const [settings, rows, healthRuns] = await Promise.all([
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
    listHealthRuns(shop, 10),
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

  const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
  const monitorUrl =
    appUrl && process.env.SHOPIFY_API_SECRET
      ? `${appUrl}/api/health?shop=${encodeURIComponent(shop)}&token=${healthMonitorToken(shop)}`
      : null;

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
    healthRuns,
    monitorUrl,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "runHealth" || intent === "runHealthDeep") {
    const run = await runHealthChecks(shop, { trigger: "manual", deep: intent === "runHealthDeep" });
    const message =
      run.status === "ok"
        ? `All checks passed (${run.okCount} ok, ${run.skipCount} skipped) in ${(run.tookMs / 1000).toFixed(1)}s.`
        : run.status === "warn"
          ? `${run.warnCount} warning${run.warnCount === 1 ? "" : "s"} — review below.`
          : `${run.failCount} check${run.failCount === 1 ? "" : "s"} FAILING — buyers may be affected.`;
    return json({ ok: run.status !== "fail", message });
  }

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

const STATUS_ORDER: Record<HealthCheckResult["status"], number> = { fail: 0, warn: 1, ok: 2, skip: 3 };

function statusBadge(status: HealthCheckResult["status"]) {
  if (status === "ok") return <Badge tone="success">OK</Badge>;
  if (status === "warn") return <Badge tone="warning">Warning</Badge>;
  if (status === "fail") return <Badge tone="critical">Failing</Badge>;
  return <Badge>Skipped</Badge>;
}

function runBadge(run: HealthRun) {
  if (run.status === "ok") return <Badge tone="success">Healthy</Badge>;
  if (run.status === "warn") return <Badge tone="warning">{`${run.warnCount} warning${run.warnCount === 1 ? "" : "s"}`}</Badge>;
  return <Badge tone="critical">{`${run.failCount} failing`}</Badge>;
}

function HealthSection({
  runs,
  monitorUrl,
}: {
  runs: HealthRun[];
  monitorUrl: string | null;
}) {
  // Shared key: the page-level toast effect watches this same fetcher, so
  // run-result messages ("all passed" / "N failing") actually surface.
  const fetcher = useFetcher<typeof action>({ key: "debug-actions" });
  const running = fetcher.state !== "idle";
  const runningDeep = running && fetcher.formData?.get("intent") === "runHealthDeep";
  const latest = runs[0] ?? null;

  const submit = (intent: string) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fetcher.submit(fd, { method: "post" });
  };

  const groups: Array<{ group: string; results: HealthCheckResult[] }> = [];
  if (latest) {
    for (const result of latest.results) {
      let bucket = groups.find((g) => g.group === result.group);
      if (!bucket) {
        bucket = { group: result.group, results: [] };
        groups.push(bucket);
      }
      bucket.results.push(result);
    }
    for (const bucket of groups) {
      bucket.results.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    }
  }

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap gap="200">
            <BlockStack gap="050">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Live store health
                </Text>
                {latest ? runBadge(latest) : <Badge>Never run</Badge>}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {latest
                  ? `Last run ${formatTime(latest.createdAt)} (${latest.trigger}${latest.deep ? ", deep" : ""}) — ${latest.okCount} ok, ${latest.warnCount} warnings, ${latest.failCount} failing, ${latest.skipCount} skipped in ${(latest.tookMs / 1000).toFixed(1)}s. Re-runs automatically every 6 hours while the admin is open.`
                  : "Every key feature — billing, signing, retries, languages, webhooks, AI — verified against the live store through the real code paths."}
              </Text>
            </BlockStack>
            <InlineStack gap="200">
              <Button variant="primary" onClick={() => submit("runHealth")} loading={running && !runningDeep} disabled={running}>
                Run checks
              </Button>
              <Button onClick={() => submit("runHealthDeep")} loading={runningDeep} disabled={running}>
                Run deep checks
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Standard checks are read-only apart from self-cleaning database probes; they include tiny live pings
            of your configured AI models (~10 tokens each, fractions of a cent — background runs ping only the
            core model). Deep checks additionally make one live translation call and create then immediately
            delete a 1% test discount code, proving thank-you codes mint end-to-end.
          </Text>
        </BlockStack>
      </Card>

      {latest && latest.failCount > 0 ? (
        <Banner
          tone="critical"
          title={`${latest.failCount} check${latest.failCount === 1 ? " is" : "s are"} failing — buyers may be affected right now. Fix the red rows below before relying on the app.`}
        />
      ) : null}

      {latest ? (
        <Card>
          <BlockStack gap="300">
            {groups.map((bucket, gi) => (
              <BlockStack gap="150" key={bucket.group}>
                {gi > 0 ? <Divider /> : null}
                <Text as="h3" variant="headingSm">
                  {bucket.group}
                </Text>
                <BlockStack gap="100">
                  {bucket.results.map((result) => (
                    <details key={result.id}>
                      <summary style={{ cursor: "pointer", padding: "2px 0" }}>
                        <InlineStack gap="200" blockAlign="center" wrap>
                          {statusBadge(result.status)}
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {result.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {result.summary}
                          </Text>
                        </InlineStack>
                      </summary>
                      <Box paddingBlockStart="150" paddingBlockEnd="200" paddingInlineStart="200">
                        <BlockStack gap="150">
                          {result.fix ? (
                            <Text as="p" variant="bodySm">
                              <Text as="span" fontWeight="semibold">
                                Fix:
                              </Text>{" "}
                              {result.fix}
                            </Text>
                          ) : null}
                          <Text as="p" variant="bodySm" tone="subdued">
                            {`Check id ${result.id} · ${result.tookMs} ms`}
                          </Text>
                          {result.detail !== undefined && result.detail !== null ? (
                            <pre
                              style={{
                                margin: 0,
                                padding: "8px 12px",
                                background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                                borderRadius: 8,
                                fontSize: 11,
                                lineHeight: 1.45,
                                overflow: "auto",
                                maxHeight: 320,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                              }}
                            >
                              {JSON.stringify(result.detail, null, 2)}
                            </pre>
                          ) : null}
                        </BlockStack>
                      </Box>
                    </details>
                  ))}
                </BlockStack>
              </BlockStack>
            ))}
          </BlockStack>
        </Card>
      ) : (
        <Card>
          <Text as="p" tone="subdued">
            No health run recorded yet — click “Run checks” to verify every key feature against the live store.
          </Text>
        </Card>
      )}

      {monitorUrl ? (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              External uptime monitoring
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Point an uptime monitor (UptimeRobot, Pingdom, a cron…) at this URL. It answers HTTP 200 while
              checks pass and 503 when any check fails, so a plain “alert on non-200” monitor emails you the
              moment a live feature breaks. Append <code>&amp;run=1</code> to also trigger a fresh run on each
              poll (rate-limited to one per 10 minutes). Keep the URL private — it contains an access token.
            </Text>
            <pre
              style={{
                margin: 0,
                padding: "8px 12px",
                background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                borderRadius: 8,
                fontSize: 11,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {monitorUrl}
            </pre>
          </BlockStack>
        </Card>
      ) : null}

      {runs.length > 1 ? (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Recent runs
            </Text>
            <BlockStack gap="100">
              {runs.map((run) => (
                <InlineStack key={run.id} gap="200" blockAlign="center" wrap>
                  {runBadge(run)}
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`${formatTime(run.createdAt)} · ${run.trigger}${run.deep ? " · deep" : ""} · ${run.okCount} ok / ${run.warnCount} warn / ${run.failCount} fail · ${(run.tookMs / 1000).toFixed(1)}s`}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      ) : null}
    </BlockStack>
  );
}

export default function DebugPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  // Same key as HealthSection's fetcher — one toast effect covers all intents.
  const fetcher = useFetcher<typeof action>({ key: "debug-actions" });
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
    setSearchParams({ view: "traces" }, { replace: true });
  };

  const detail = data.detail;
  // A deep link to a trace (?event=…) lands on the traces tab.
  const tracesSelected = searchParams.get("view") === "traces" || Boolean(searchParams.get("event"));
  const selectedTab = tracesSelected ? 1 : 0;

  return (
    <Page
      title="Debug"
      subtitle="Live health checks for every key feature, plus full traces of offer generations."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Tabs
              tabs={[
                { id: "health", content: "Health checks" },
                { id: "traces", content: "Offer traces" },
              ]}
              selected={selectedTab}
              onSelect={(index) =>
                setSearchParams(index === 1 ? { view: "traces" } : {}, { replace: true })
              }
            />

            {selectedTab === 0 ? (
              <HealthSection runs={data.healthRuns} monitorUrl={data.monitorUrl} />
            ) : (
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
                        <Link to="/app/debug?view=traces">Back to list</Link>
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
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
