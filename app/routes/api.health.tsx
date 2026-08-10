// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health — two public probes, no Shopify session involved:
//
// 1. ?probe=echo&nonce=<n>            → { ok, echo, known } — used by the
//    battery's self-reachability check. `known` is true only when the nonce
//    exists as a claim row in THIS deployment's database (the check writes it
//    before fetching), so a stale or foreign deployment answering on the URL
//    is detected: it can reflect the nonce but cannot know it.
//
// 2. ?shop=<domain>&token=<t>[&run=1] → latest health-run summary for external
//    uptime monitors (UptimeRobot etc.). Token is derived from the app secret
//    + rotatable HEALTH_MONITOR_SALT (see healthMonitorToken; shown in the
//    Debug tab), compared timing-safe. HTTP 200 when ok/warn, 503 when the
//    latest run has failures — so a plain "alert on non-200" monitor catches
//    broken live features. &run=1 kicks off a FRESH run in the background,
//    throttled by BOTH the persisted-run age and an in-memory per-shop
//    timestamp (so a missing/broken HealthCheckRun table can never turn a
//    noisy monitor into unlimited paid runs); concurrent runs additionally
//    coalesce inside runHealthChecks itself.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { timingSafeEqual, createHash } from "node:crypto";
import prisma from "../db.server";
import {
  getLatestHealthRun,
  healthMonitorToken,
  runHealthChecks,
} from "../services/health.server";

const FRESH_RUN_MIN_AGE_MS = 10 * 60 * 1000;

// Second throttle for &run=1, independent of DB persistence.
const lastExternalRunAt = new Map<string, number>();

function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Summaries cross a trust boundary here: crash-path summaries embed raw
 * internal error text (hosts, stack fragments). Serve the monitor a scrubbed
 * line — the full detail stays in the admin Debug tab.
 */
function scrubSummary(id: string, summary: string): string {
  if (id === "runner" || summary.startsWith("Check crashed:") || summary.startsWith("The runner itself failed")) {
    return "Internal error while probing — open the app's Debug tab for details.";
  }
  return summary.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("probe") === "echo") {
    const nonce = url.searchParams.get("nonce") ?? "";
    let known = false;
    if (nonce && nonce.length <= 64) {
      try {
        known =
          (await prisma.eventDedup.findFirst({
            where: { referenceId: `health:echo:${nonce}`, eventType: "echo" },
            select: { id: true },
          })) !== null;
      } catch {
        known = false;
      }
    }
    return json({ ok: true, echo: nonce, known });
  }

  const shop = url.searchParams.get("shop") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!shop || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(shop)) {
    return json({ error: "not found" }, { status: 404 });
  }
  if (!process.env.SHOPIFY_API_SECRET || !tokensMatch(token, healthMonitorToken(shop))) {
    // Same shape as the missing-parameter case — no oracle for probing shops.
    return json({ error: "not found" }, { status: 404 });
  }

  const run = await getLatestHealthRun(shop);

  if (url.searchParams.get("run") === "1") {
    const persistedAge = run ? Date.now() - Date.parse(run.createdAt) : Infinity;
    const memoryAge = Date.now() - (lastExternalRunAt.get(shop) ?? 0);
    if (persistedAge > FRESH_RUN_MIN_AGE_MS && memoryAge > FRESH_RUN_MIN_AGE_MS) {
      lastExternalRunAt.set(shop, Date.now());
      // Fire-and-forget — monitors need a fast response; the fresh result is
      // served on their next poll. runHealthChecks coalesces concurrent runs.
      runHealthChecks(shop, { trigger: "external" }).catch((error) =>
        console.error(`[health] external-triggered run failed for ${shop}`, error),
      );
    }
  }

  if (!run) {
    return json(
      { status: "unknown", message: "No health run recorded yet — open the app's Debug tab once or pass &run=1." },
      { status: 200 },
    );
  }

  return json(
    {
      status: run.status,
      createdAt: run.createdAt,
      trigger: run.trigger,
      deep: run.deep,
      ok: run.okCount,
      warnings: run.warnCount,
      failures: run.failCount,
      skipped: run.skipCount,
      tookMs: run.tookMs,
      failing: run.results
        .filter((r) => r.status === "fail")
        .map((r) => ({ id: r.id, name: r.name, summary: scrubSummary(r.id, r.summary) })),
      warning: run.results
        .filter((r) => r.status === "warn")
        .map((r) => ({ id: r.id, name: r.name, summary: scrubSummary(r.id, r.summary) })),
    },
    { status: run.status === "fail" ? 503 : 200 },
  );
};
