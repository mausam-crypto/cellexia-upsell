// ─────────────────────────────────────────────────────────────────────────────
// Module F — Webhooks (SPEC §5-F).
//
// Single endpoint for every webhook topic the app subscribes to. Each handler
// body is wrapped in try/catch: we log with the [webhooks] prefix and STILL
// return 200 so Shopify does not retry-storm us over a transient handler
// failure. authenticate.webhook() itself is allowed to throw — the library
// throws a proper 401 Response for bad HMACs, which Remix returns as-is.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { toGid } from "../lib/json";
import { authenticate } from "../shopify.server";
import type { AdminGraphql } from "../types";
import { recordOrderFromWebhook } from "../services/analytics.server";
import {
  deleteProductFromWebhook,
  syncProductTranslations,
  upsertProductFromWebhook,
} from "../services/catalog.server";
import { getSettings } from "../services/settings.server";
import { redactCustomer, redactShop } from "../services/bootstrap.server";

/** Webhooks are POST-only. Answer GET (and anything else) with a 405. */
export const loader = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });

/**
 * Runs a handler body, logging (but swallowing) any error so the route can
 * still acknowledge the delivery with a 200.
 */
async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[webhooks] ${label} handler failed`, error);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload, admin } = await authenticate.webhook(request);
  const body = (payload ?? {}) as Record<string, any>;

  switch (topic) {
    case "ORDERS_CREATE": {
      await safely(`ORDERS_CREATE (${shop})`, () =>
        recordOrderFromWebhook(shop, body),
      );
      break;
    }

    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE": {
      await safely(`${topic} (${shop})`, () =>
        upsertProductFromWebhook(shop, body),
      );
      // Freshness: pull this product's Translate & Adapt values (title +
      // description per enabled language) in the background when the delivery
      // carries an admin client. Fire-and-forget — the 200 acknowledgment is
      // never delayed or failed by GraphQL calls.
      try {
        const rawId = body.admin_graphql_api_id ?? body.id;
        if (admin && rawId !== undefined && rawId !== null && rawId !== "") {
          const graphql = admin.graphql as unknown as AdminGraphql;
          const productId = toGid("Product", rawId);
          void (async () => {
            const settings = await getSettings(shop);
            await syncProductTranslations(graphql, shop, {
              productIds: [productId],
              locales: settings.languages,
            });
          })().catch((error) =>
            console.error(
              `[webhooks] ${topic} translations refresh failed for ${shop}`,
              error,
            ),
          );
        }
      } catch (error) {
        console.error(
          `[webhooks] ${topic} translations refresh setup failed for ${shop}`,
          error,
        );
      }
      break;
    }

    case "PRODUCTS_DELETE": {
      await safely(`PRODUCTS_DELETE (${shop})`, () =>
        deleteProductFromWebhook(shop, body),
      );
      break;
    }

    case "APP_UNINSTALLED": {
      // Remove sessions so tokens are invalidated, but KEEP shop data
      // (settings, rules, analytics) so a reinstall picks up where it left off.
      await safely(`APP_UNINSTALLED (${shop})`, () =>
        prisma.session.deleteMany({ where: { shop } }),
      );
      break;
    }

    case "APP_SCOPES_UPDATE": {
      await safely(`APP_SCOPES_UPDATE (${shop})`, async () => {
        const current = body.current;
        if (session && Array.isArray(current)) {
          await prisma.session.update({
            where: { id: session.id },
            data: { scope: current.join(",") },
          });
        }
      });
      break;
    }

    case "CUSTOMERS_DATA_REQUEST": {
      // GDPR: we hold only minimal, pseudonymous data (customer id linked to
      // offer events / order records). Log the request for the merchant's
      // records; no automated export is produced.
      console.log(
        `[webhooks] CUSTOMERS_DATA_REQUEST for ${shop}, customer ${String(
          body.customer?.id ?? "unknown",
        )} — stored customer data is minimal (offer events + order history).`,
      );
      break;
    }

    case "CUSTOMERS_REDACT": {
      await safely(`CUSTOMERS_REDACT (${shop})`, () =>
        redactCustomer(shop, String(body.customer?.id ?? "")),
      );
      break;
    }

    case "SHOP_REDACT": {
      await safely(`SHOP_REDACT (${shop})`, () => redactShop(shop));
      break;
    }

    default: {
      console.log(`[webhooks] unhandled topic ${topic} for ${shop}`);
      break;
    }
  }

  // Always acknowledge with 200 so Shopify marks the delivery as successful.
  return new Response();
};
