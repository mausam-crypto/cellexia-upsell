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
//
// POST-PURCHASE INQUIRIES (v1.9): every ShouldRender call Shopify sent to
// /api/offer (OfferInquiry) and, for the latest real orders, the three facts
// that explain "it did not show": did Shopify's rules allow the page for that
// order (payment method / currency / channel), did Shopify call us, and what
// did we answer. This is the first place to look after a test order.
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
  listGateSamples,
  listHealthRuns,
  maybeAutoRunHealthChecks,
  maybeSamplePostPurchaseGate,
  postPurchasePlatformGate,
  runHealthChecks,
  samplePostPurchaseGate,
  type HealthCheckResult,
  type HealthRun,
} from "../services/health.server";
import { INQUIRY_RETENTION_MS, inquiryStats, recentInquiries } from "../services/inquiry-log.server";
import { APP_VERSION, APP_VERSION_DATE } from "../lib/version";

const DAY_MS = 24 * 60 * 60 * 1000;

interface OrderDiagRow {
  orderId: string;
  createdAt: string;
  country: string | null;
  customer: boolean;
  gateway: string | null;
  presentment: string | null;
  sourceName: string | null;
  platformGate: string | null;
  inquiries: number;
  lastInquiry: { at: string; offers: number; emptyReason: string | null; tookMs: number } | null;
  rendered: boolean;
  verdict: string;
  verdictTone: "success" | "warning" | "critical" | "info";
}

/**
 * Latest real orders annotated with the three facts a merchant needs after a
 * test order: (1) could Shopify ever show the page for it, (2) did Shopify call
 * this backend, (3) what did we answer — plus whether a page was rendered.
 */
async function loadOrderDiagnostics(
  shop: string,
  shopCurrency: string,
): Promise<{ rows: OrderDiagRow[]; tableMissing: boolean; ordersUnreadable: boolean; joinSuspect: boolean }> {
  let orders: Awaited<ReturnType<typeof prisma.orderRecord.findMany>>;
  try {
    orders = await prisma.orderRecord.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  } catch {
    // v1.9 columns missing (db push not run yet) — the read-back of every
    // scalar fails; say so instead of "no orders".
    return { rows: [], tableMissing: true, ordersUnreadable: true, joinSuspect: false };
  }
  if (orders.length === 0) return { rows: [], tableMissing: false, ordersUnreadable: false, joinSuspect: false };
  const tokens = orders.map((o) => o.checkoutToken).filter((t): t is string => Boolean(t));
  const orderIds = orders.map((o) => o.orderId);
  let tableMissing = false;
  // Orders older than the inquiry log's retention (or than its first row on
  // this deployment) cannot be judged "never called" — the evidence is gone
  // or was never collected.
  const earliestInquiry = await prisma.offerInquiry
    .findFirst({ where: { shop }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
    .catch(() => null);
  const judgeableSince = new Date(Math.max(Date.now() - INQUIRY_RETENTION_MS, earliestInquiry?.createdAt.getTime() ?? 0));
  const [inquiries, impressions] = await Promise.all([
    tokens.length
      ? prisma.offerInquiry
          .findMany({ where: { shop, referenceId: { in: tokens } }, orderBy: { createdAt: "asc" } })
          .catch(() => {
            tableMissing = true;
            return [];
          })
      : Promise.resolve([]),
    prisma.offerEvent
      .findMany({
        where: {
          shop,
          surface: "post_purchase",
          eventType: "impression",
          OR: [{ orderId: { in: orderIds } }, ...(tokens.length ? [{ referenceId: { in: tokens } }] : [])],
        },
        select: { orderId: true, referenceId: true },
      })
      .catch(() => []),
  ]);
  const rows: OrderDiagRow[] = orders.map((o) => {
    // OrderRecord.currency is the shop currency at order time — the right
    // fallback when the Admin API lookup of the shop currency failed.
    const gate = postPurchasePlatformGate(o.gateway, o.presentment, o.sourceName, shopCurrency || o.currency);
    const mine = o.checkoutToken ? inquiries.filter((i) => i.referenceId === o.checkoutToken) : [];
    const last = mine.length ? mine[mine.length - 1] : null;
    const rendered = impressions.some((e) => e.orderId === o.orderId || (o.checkoutToken && e.referenceId === o.checkoutToken));
    let verdict: string;
    let verdictTone: OrderDiagRow["verdictTone"];
    if (rendered) {
      verdict = "Post-purchase page rendered.";
      verdictTone = "success";
    } else if (gate) {
      verdict = `Never eligible by Shopify's rules: ${gate}.`;
      verdictTone = "info";
    } else if (!o.checkoutToken) {
      verdict = "No checkout token stored (order predates v1.9, the deployment had not run db push yet, or the order was not created from a web checkout): cannot join to inquiries.";
      verdictTone = "info";
    } else if (mine.length === 0 && tableMissing) {
      verdict = "Inquiry log unavailable on this deployment (run npx prisma db push): cannot tell whether Shopify called the app.";
      verdictTone = "info";
    } else if (mine.length === 0 && o.createdAt < judgeableSince) {
      verdict = "No inquiry on record, but the inquiry log did not cover this order's time (retention 30 days / log started later): cannot judge.";
      verdictTone = "info";
    } else if (mine.length === 0) {
      verdict = "Shopify never called this backend for this checkout: the Shopify-side gate (availability flag / app selection) was closed at that moment, or the deployed extension points at another host.";
      verdictTone = "critical";
    } else if (last && last.offers === 0) {
      verdict = `Called, app answered NO offer: ${last.emptyReason ?? "no reason recorded"}.`;
      verdictTone = "warning";
    } else if (last && last.tookMs > 2000) {
      verdict = `Called, page issued, but the answer took ${last.tookMs} ms: if the buyer paid before it arrived, Shopify skips the page.`;
      verdictTone = "warning";
    } else {
      verdict = "Called, page issued (offer returned), not rendered: Shopify's receipt-side rules (card could not be vaulted, wallet button, duties, local delivery, order-creation delay; possibly some 3-D Secure flows, unconfirmed).";
      verdictTone = "warning";
    }
    return {
      orderId: o.orderId,
      createdAt: o.createdAt.toISOString(),
      country: o.country ?? null,
      customer: Boolean(o.customerId),
      gateway: o.gateway ?? null,
      presentment: o.presentment ?? null,
      sourceName: o.sourceName ?? null,
      platformGate: gate,
      inquiries: mine.length,
      lastInquiry: last
        ? { at: last.createdAt.toISOString(), offers: last.offers, emptyReason: last.emptyReason, tookMs: last.tookMs }
        : null,
      rendered,
      verdict,
      verdictTone,
    };
  });
  // Self-check of the join assumption (referenceId = checkout_token): if
  // ShouldRender inquiries exist in the same period as tokened orders but
  // NONE joins, say so instead of printing confident "never called" verdicts.
  let joinSuspect = false;
  if (tokens.length >= 5 && inquiries.length === 0 && !tableMissing) {
    const oldest = orders[orders.length - 1].createdAt;
    const inWindow = await prisma.offerInquiry.count({ where: { shop, createdAt: { gte: oldest } } }).catch(() => 0);
    joinSuspect = inWindow >= 5;
  }
  return { rows, tableMissing, ordersUnreadable: false, joinSuspect };
}

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
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const eventId = url.searchParams.get("event");

  // Keep the battery running on a cadence as long as the admin is in use, and
  // keep sampling Shopify's post-purchase gate (throttled to 10 min).
  maybeAutoRunHealthChecks(shop);
  maybeSamplePostPurchaseGate(shop);

  // Shop currency for the platform-gate verdicts (best-effort; EUR fallback
  // only if the Admin API is unreachable — the verdict text names the code).
  let shopCurrency = "";
  try {
    const res = await admin.graphql(`#graphql
      query cellexiaDebugShopCurrency { shop { currencyCode } }`);
    const body = (await res.json()) as any;
    shopCurrency = String(body?.data?.shop?.currencyCode ?? "");
  } catch {
    shopCurrency = "";
  }

  const [settings, rows, healthRuns, stats24h, stats7d, inquiries, orderDiag, gateSamples] = await Promise.all([
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
    inquiryStats(shop, DAY_MS).catch(() => null),
    inquiryStats(shop, 7 * DAY_MS).catch(() => null),
    recentInquiries(shop, 60).catch(() => null),
    loadOrderDiagnostics(shop, shopCurrency).catch(() => ({ rows: [] as OrderDiagRow[], tableMissing: true, ordersUnreadable: true, joinSuspect: false })),
    listGateSamples(shop, 100),
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
    backend: { version: APP_VERSION, date: APP_VERSION_DATE, appUrl },
    shopCurrency,
    inquiryLogAvailable: inquiries !== null,
    stats24h: stats24h
      ? { ...stats24h, since: stats24h.since.toISOString(), lastAt: stats24h.lastAt?.toISOString() ?? null }
      : null,
    stats7d: stats7d
      ? { ...stats7d, since: stats7d.since.toISOString(), lastAt: stats7d.lastAt?.toISOString() ?? null }
      : null,
    inquiries: (inquiries ?? []).map((i) => ({
      id: i.id,
      referenceId: i.referenceId,
      createdAt: i.createdAt.toISOString(),
      countryCode: i.countryCode,
      currency: i.currency,
      presentment: i.presentment,
      customer: Boolean(i.customerId),
      lines: i.lines,
      totalAmount: i.totalAmount,
      totalSource: i.totalSource,
      offers: i.offers,
      corePending: i.corePending,
      emptyReason: i.emptyReason,
      tookMs: i.tookMs,
      appVersion: i.appVersion,
    })),
    orderDiag: orderDiag.rows,
    orderDiagTableMissing: orderDiag.tableMissing,
    orderDiagOrdersUnreadable: orderDiag.ordersUnreadable,
    orderDiagJoinSuspect: orderDiag.joinSuspect,
    gateSamples,
    gateMonitorUrl: monitorUrl ? `${monitorUrl}&gate=1` : null,
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

  if (intent === "sampleGate") {
    const sample = await samplePostPurchaseGate(shop, "manual");
    if (!sample) return json({ ok: false, message: "Could not sample the gate." }, { status: 500 });
    const open = sample.storefrontFlag === true && sample.inUse !== false;
    return json({
      ok: open,
      message: open
        ? "Gate sampled: OPEN. Shopify's checkout flag is on and this app is the selected post-purchase app."
        : `Gate sampled: CLOSED. Storefront flag ${sample.storefrontFlag === null ? "unreadable" : sample.storefrontFlag ? "on" : "OFF"}, app selected ${sample.inUse === null ? "unknown" : sample.inUse ? "yes" : "NO"}.`,
    });
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

function GateTimelineCard({
  samples,
  monitorUrl,
}: {
  samples: Array<{ at: string; storefrontFlag: boolean | null; inUse: boolean | null; source: string; note: string | null }>;
  monitorUrl: string | null;
}) {
  const fetcher = useFetcher<typeof action>({ key: "debug-actions" });
  const sampleNow = () => {
    const fd = new FormData();
    fd.set("intent", "sampleGate");
    fetcher.submit(fd, { method: "post" });
  };
  const state = (s: { storefrontFlag: boolean | null; inUse: boolean | null }) =>
    s.storefrontFlag === true && s.inUse !== false ? "open" : s.storefrontFlag === null && s.inUse === null ? "unknown" : "closed";
  // Oldest → newest for the transition list; keep only rows where the state
  // changed (plus the newest), so an hour of identical samples is one line.
  const chrono = [...samples].reverse();
  const transitions: typeof chrono = [];
  for (let i = 0; i < chrono.length; i++) {
    if (i === 0 || state(chrono[i]) !== state(chrono[i - 1]) || i === chrono.length - 1) transitions.push(chrono[i]);
  }
  const latest = samples[0] ?? null;
  const latestState = latest ? state(latest) : "unknown";
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
          <Text as="h2" variant="headingMd">
            Shopify post-purchase gate: timeline
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={latestState === "open" ? "success" : latestState === "closed" ? "critical" : "attention"}>
              {latest ? `now: ${latestState.toUpperCase()} (sampled ${formatTime(latest.at)})` : "no sample yet"}
            </Badge>
            <Button onClick={sampleNow} loading={fetcher.state !== "idle"} size="slim">
              Sample now
            </Button>
          </InlineStack>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          Two Shopify-side facts sampled together: the checkout's <code>postPurchaseExtensionAvailable</code> flag (read from a real storefront checkout) and whether this app is
          the selected post-purchase app (Admin API). Both must be on for any buyer to see the page, and both can flip either way without a deploy (a re-saved checkout
          selection, an uninstall, a released version without the extension, a lapsed approval), so the timeline below matters more than any single reading. Samples are taken
          by every health run, whenever the admin is open (every 10 min), and by the external gate monitor below. A test order placed while the timeline says CLOSED could
          never show the page.
        </Text>
        {transitions.length === 0 ? (
          <Text as="p" tone="subdued">
            No samples yet. Click Sample now, or open the Health checks tab.
          </Text>
        ) : (
          <BlockStack gap="100">
            {transitions.map((s, i) => {
              const st = state(s);
              return (
                <InlineStack key={`${s.at}-${i}`} gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {formatTime(s.at)}
                  </Text>
                  <Badge tone={st === "open" ? "success" : st === "closed" ? "critical" : "attention"}>{st.toUpperCase()}</Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {`flag ${s.storefrontFlag === null ? "?" : s.storefrontFlag ? "on" : "off"} · selected ${s.inUse === null ? "?" : s.inUse ? "yes" : "no"} · ${s.source}`}
                  </Text>
                </InlineStack>
              );
            })}
          </BlockStack>
        )}
        {monitorUrl ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {"External gate monitor (HTTP 200 while open, 503 when closed; keep private): "}
            <code style={{ wordBreak: "break-all" }}>{monitorUrl}</code>
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function InquiriesSection({ data }: { data: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const s24 = data.stats24h;
  const s7 = data.stats7d;
  const orders = data.orderDiag;
  const notCalled = orders.filter((o) => o.verdictTone === "critical").length;
  const shopCcy = data.shopCurrency || "the shop currency";
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            How to read this tab
          </Text>
          <Text as="p" tone="subdued">
            Shopify runs this app's <b>ShouldRender</b> in the buyer's checkout as soon as the page loads (and again whenever the total, currency or shipping country changes)
            once two Shopify-side conditions hold: the store's post-purchase gate is open (timeline below; Health checks: "Shopify checkout: post-purchase extension available") and
            the checkout is in {shopCcy} (a checkout in another presentment currency gets Shopify's own <code>MULTI_CURRENCY</code> refusal before the app is ever called; observed on
            the NOK market, expected for every non-{shopCcy} currency). The payment method decides LATER whether the page is shown, not whether the app is called: only plain card
            payments qualify (never PayPal, Klarna, Apple Pay, Google Pay, gift cards). Every call that reaches this backend is listed below with the app's answer. After a test order,
            find it in "Recent orders": the verdict tells you which of the three parties said no: Shopify's rules, Shopify's gate, or this app. Shopify test-mode / bogus-gateway
            orders are not listed there (analytics ignore test orders); their calls still appear in the raw inquiry list.
          </Text>
          <InlineStack gap="200" wrap>
            <Badge>{`backend v${data.backend.version} (${data.backend.date})`}</Badge>
            <Badge tone={data.inquiryLogAvailable ? "success" : "critical"}>
              {data.inquiryLogAvailable ? "inquiry log active" : "inquiry log table missing: run npx prisma db push"}
            </Badge>
            {s24 ? <Badge>{`24 h: ${s24.checkouts} checkouts / ${s24.total} calls · ${s24.withOffers} calls with offers · avg ${s24.avgTookMs ?? "-"} ms · ${s24.slowCount} over 2 s`}</Badge> : null}
            {s7 ? <Badge>{`7 d: ${s7.checkouts} checkouts / ${s7.total} calls · ${s7.checkoutsWithOffers} checkouts with a page issued`}</Badge> : null}
          </InlineStack>
          {s7 && s7.total > 0 && s7.topEmptyReasons.length > 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {`Top reasons this app answered "no offer" (7 d): ${s7.topEmptyReasons.map((r) => `${r.reason} ×${r.count}`).join(" · ")}`}
            </Text>
          ) : null}
          {s7 && s7.total === 0 && data.inquiryLogAvailable ? (
            <Banner tone="warning" title="No ShouldRender inquiry has reached this backend in the last 7 days">
              <p>
                Either the Shopify-side gate is closed (see the timeline below and the availability row under Health checks), or no {shopCcy} checkout has been opened since this
                version was deployed. Open a checkout in {shopCcy} and reload this tab: a row must appear here within seconds of the checkout page loading, long before
                you pay (any payment method; the method only decides whether the page is shown afterwards).
              </p>
            </Banner>
          ) : null}
        </BlockStack>
      </Card>

      <GateTimelineCard samples={data.gateSamples} monitorUrl={data.gateMonitorUrl} />

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Recent orders: was the page possible, was the app called, what did it answer
          </Text>
          {data.orderDiagOrdersUnreadable ? (
            <Banner tone="critical" title="Orders cannot be read on this deployment: the v1.9 database columns are missing">
              <p>Run `npx prisma db push` (Render Pre-Deploy command) and redeploy. Orders are still being stored, without eligibility annotations.</p>
            </Banner>
          ) : orders.length === 0 ? (
            <Text as="p" tone="subdued">
              No orders ingested yet (orders/create webhook).
            </Text>
          ) : (
            <BlockStack gap="200">
              {data.orderDiagTableMissing ? (
                <Banner tone="warning" title="Inquiry log unavailable: run npx prisma db push">
                  <p>The OfferInquiry table does not exist on this deployment, so no order can be joined to its ShouldRender calls yet.</p>
                </Banner>
              ) : null}
              {data.orderDiagJoinSuspect ? (
                <Banner tone="warning" title="Inquiries and orders exist for the same period, but no order matches any inquiry">
                  <p>
                    The per-order join relies on Shopify's ShouldRender referenceId being the order's checkout token. If that assumption does not hold on this store, use the raw
                    inquiry list below and match by time and country instead; the verdicts on this list would then be unreliable.
                  </p>
                </Banner>
              ) : null}
              {notCalled > 0 && !data.orderDiagJoinSuspect ? (
                <Banner tone="critical" title={`${notCalled} eligible recent order${notCalled === 1 ? "" : "s"} never reached this backend`}>
                  <p>
                    For these checkouts Shopify did not run the extension at all. Check the gate timeline above for the moment they were placed: if the gate was closed, that is
                    the answer; if it reads open now, place a fresh card order in {shopCcy}. If it is closed, fix the Shopify-side selection first.
                  </p>
                </Banner>
              ) : null}
              {orders.map((o) => (
                <Box key={o.orderId} padding="200" borderRadius="200" background="bg-surface-secondary">
                  <BlockStack gap="100">
                    <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                      <InlineStack gap="150" blockAlign="center" wrap>
                        <Text as="span" variant="bodySm" fontWeight="semibold">
                          {`Order ${o.orderId}`}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {formatTime(o.createdAt)}
                        </Text>
                        {o.country ? <Badge>{o.country}</Badge> : null}
                        <Badge>{o.customer ? "customer" : "guest"}</Badge>
                        {o.gateway ? <Badge>{o.gateway}</Badge> : null}
                        {o.presentment ? <Badge tone={data.shopCurrency && o.presentment !== data.shopCurrency ? "attention" : undefined}>{o.presentment}</Badge> : null}
                        {o.sourceName && o.sourceName !== "web" ? <Badge tone="attention">{o.sourceName}</Badge> : null}
                      </InlineStack>
                      <Badge tone={o.verdictTone === "success" ? "success" : o.verdictTone === "critical" ? "critical" : o.verdictTone === "warning" ? "warning" : "info"}>
                        {`${o.inquiries} inquir${o.inquiries === 1 ? "y" : "ies"}${o.rendered ? " · rendered" : ""}`}
                      </Badge>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone={o.verdictTone === "critical" ? "critical" : o.verdictTone === "success" ? "success" : "subdued"}>
                      {o.verdict}
                    </Text>
                    {o.lastInquiry ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`Last inquiry ${formatTime(o.lastInquiry.at)} · ${o.lastInquiry.tookMs} ms · ${o.lastInquiry.offers} offer(s)${o.lastInquiry.emptyReason ? ` · ${o.lastInquiry.emptyReason}` : ""}`}
                      </Text>
                    ) : null}
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Recent ShouldRender inquiries (newest first)
          </Text>
          {data.inquiries.length === 0 ? (
            <Text as="p" tone="subdued">
              {data.inquiryLogAvailable ? "No inquiries recorded yet." : "The OfferInquiry table does not exist on this deployment. Run `npx prisma db push` (Render Pre-Deploy command) and redeploy."}
            </Text>
          ) : (
            <BlockStack gap="150">
              {data.inquiries.map((i) => (
                <Box key={i.id} padding="150" borderRadius="200" background="bg-surface-secondary">
                  <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {i.referenceId}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${formatTime(i.createdAt)} · ${i.tookMs} ms · ${i.lines} line(s) · total ${i.totalAmount.toFixed(2)} ${i.currency ?? ""}${i.totalSource !== "total" ? ` (from ${i.totalSource})` : ""}${i.presentment ? ` · presentment ${i.presentment}` : ""}${i.appVersion ? ` · v${i.appVersion}` : ""}`}
                      </Text>
                      {i.emptyReason ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {i.emptyReason}
                        </Text>
                      ) : null}
                    </BlockStack>
                    <InlineStack gap="150" blockAlign="center" wrap>
                      {i.countryCode ? <Badge>{i.countryCode}</Badge> : <Badge tone="attention">no address yet</Badge>}
                      <Badge>{i.customer ? "customer" : "guest"}</Badge>
                      <Badge tone={i.offers > 0 ? "success" : "warning"}>{i.offers > 0 ? `${i.offers} offer${i.offers === 1 ? "" : "s"}${i.corePending ? " (copy pending)" : ""}` : "no offer"}</Badge>
                      {i.tookMs > 2000 ? <Badge tone="critical">slow</Badge> : null}
                    </InlineStack>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
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
  const view = searchParams.get("view");
  const tracesSelected = view === "traces" || Boolean(searchParams.get("event"));
  const selectedTab = tracesSelected ? 1 : view === "inquiries" ? 2 : 0;

  return (
    <Page
      title="Debug"
      subtitle={`Live health checks, ShouldRender inquiries and offer traces · backend v${data.backend.version} (${data.backend.date})`}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Tabs
              tabs={[
                { id: "health", content: "Health checks" },
                { id: "traces", content: "Offer traces" },
                { id: "inquiries", content: "Post-purchase inquiries" },
              ]}
              selected={selectedTab}
              onSelect={(index) =>
                setSearchParams(index === 1 ? { view: "traces" } : index === 2 ? { view: "inquiries" } : {}, { replace: true })
              }
            />

            {selectedTab === 0 ? (
              <HealthSection runs={data.healthRuns} monitorUrl={data.monitorUrl} />
            ) : selectedTab === 2 ? (
              <InquiriesSection data={data} />
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
