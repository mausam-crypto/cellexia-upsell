// ─────────────────────────────────────────────────────────────────────────────
// Module A — Shop bootstrap & GDPR redaction.
//
// bootstrapShop runs after OAuth (fire-and-forget from shopify.server.ts) and
// seeds everything a fresh install needs. It must NEVER throw — every step is
// individually guarded and logged.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { gidToNumber, jparse, jstr, toGid } from "../lib/json";
import type { AdminGraphql } from "../types";
import { ensureShop, getSettings } from "./settings.server";
import { syncCatalog, syncMarketsAndLocales } from "./catalog.server";
import { ensurePromptTemplates, ensureUiStrings } from "./ai.server";
import { resetOrderHistoryCache } from "./recommendation.server";

/**
 * Seed shop row, prompt templates, locales/markets, UI strings, and catalog.
 * Every step is try/catch-logged so installation never fails on a bad step.
 * `admin` is optional — without it the GraphQL-backed steps are skipped and
 * can be re-run later from the dashboard's "Sync" action.
 */
export async function bootstrapShop(
  shop: string,
  admin?: { graphql: AdminGraphql } | null,
): Promise<void> {
  if (!shop) return;

  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      console.error(`[bootstrap] ${name} failed for ${shop}`, error);
    }
  };

  const graphql = admin?.graphql ?? null;

  await step("ensureShop", () => ensureShop(shop));
  await step("ensurePromptTemplates", () => ensurePromptTemplates(shop));
  if (graphql) {
    await step("syncMarketsAndLocales", () => syncMarketsAndLocales(graphql, shop));
  }
  await step("ensureUiStrings", async () => {
    const settings = await getSettings(shop);
    await ensureUiStrings(shop, settings.languages);
  });
  if (graphql) {
    await step("syncCatalog", () => syncCatalog(graphql, shop));
  }
}

/**
 * GDPR customers/redact: unlink or delete every row tied to this customer.
 * The id may arrive as a numeric REST id or a gid — both forms are matched.
 */
export async function redactCustomer(shop: string, customerId: string): Promise<void> {
  const raw = String(customerId ?? "").trim();
  if (!shop || !raw) return;

  const numericPart = raw.startsWith("gid://") ? String(gidToNumber(raw)) : raw;
  const candidates = Array.from(
    new Set([raw, numericPart, toGid("Customer", numericPart)]),
  ).filter((c) => c && c !== "NaN" && c !== "gid://shopify/Customer/NaN");
  if (candidates.length === 0) return;

  // Unlink analytics events and order history (keep anonymized aggregates for
  // co-purchase stats), delete per-customer frequency-cap state.
  await prisma.offerEvent.updateMany({
    where: { shop, customerId: { in: candidates } },
    data: { customerId: null },
  });
  await prisma.orderRecord.updateMany({
    where: { shop, customerId: { in: candidates } },
    data: { customerId: null },
  });
  await prisma.customerState.deleteMany({
    where: { shop, customerId: { in: candidates } },
  });
  // v1.9 ShouldRender inquiry log keeps the customer id for 30 days (the
  // engine reason text is stored already scrubbed of ids). Tolerate a
  // deployment without the table.
  await prisma.offerInquiry
    .updateMany({ where: { shop, customerId: { in: candidates } }, data: { customerId: null } })
    .catch((error) => {
      if (!isMissingTableError(error)) throw error;
    });

  // IssuedOffer.offerMetaJson denormalizes customerId — scrub matching rows.
  // (These rows expire within 2h anyway; the `contains` filter keeps the scan
  // narrow.)
  const suspects = await prisma.issuedOffer.findMany({
    where: { shop, offerMetaJson: { contains: numericPart } },
  });
  for (const offer of suspects) {
    const meta = jparse<Record<string, unknown>>(offer.offerMetaJson, {});
    const metaCustomerId = meta?.customerId;
    if (
      metaCustomerId !== undefined &&
      metaCustomerId !== null &&
      candidates.includes(String(metaCustomerId))
    ) {
      await prisma.issuedOffer.update({
        where: { id: offer.id },
        data: { offerMetaJson: jstr({ ...meta, customerId: null }) },
      });
    }
  }
}

/** Prisma P2021 (table does not exist) / P2022 (column does not exist) or the raw driver text. */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /does not exist|no such table|no such column|Unknown column|has no column named/i.test(msg);
}

/** GDPR shop/redact: delete every row belonging to this shop. */
export async function redactShop(shop: string): Promise<void> {
  if (!shop) return;

  resetOrderHistoryCache(shop);
  // Tables added after v1.6.x (DebugEvent, HealthCheckRun, OfferInquiry,
  // GateSample, ContextualPriceCache) are wiped OUTSIDE the atomic batch,
  // each tolerating "table does not exist": a deployment that skipped
  // `prisma db push` must not turn the whole shop redaction into a no-op.
  for (const del of [
    () => prisma.offerInquiry.deleteMany({ where: { shop } }),
    () => prisma.gateSample.deleteMany({ where: { shop } }),
    () => prisma.debugEvent.deleteMany({ where: { shop } }),
    () => prisma.healthCheckRun.deleteMany({ where: { shop } }),
    () => prisma.contextualPriceCache.deleteMany({ where: { shop } }),
  ]) {
    try {
      await del();
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
  // Children first (explicit deletes — don't rely on DB-level cascades).
  await prisma.$transaction([
    prisma.offerEvent.deleteMany({ where: { shop } }),
    prisma.eventDedup.deleteMany({ where: { shop } }),
    prisma.issuedOffer.deleteMany({ where: { shop } }),
    prisma.copyCache.deleteMany({ where: { shop } }),
    prisma.customerState.deleteMany({ where: { shop } }),
    prisma.marketSetting.deleteMany({ where: { shop } }),
    prisma.uiString.deleteMany({ where: { shop } }),
    prisma.promptTemplate.deleteMany({ where: { shop } }),
    prisma.productCache.deleteMany({ where: { shop } }),
    prisma.orderLine.deleteMany({ where: { order: { shop } } }),
    prisma.orderRecord.deleteMany({ where: { shop } }),
    prisma.offerCandidate.deleteMany({ where: { slot: { rule: { shop } } } }),
    prisma.offerSlot.deleteMany({ where: { rule: { shop } } }),
    prisma.offerRule.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
    prisma.shop.deleteMany({ where: { shop } }),
  ]);
}
