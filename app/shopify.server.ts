import "@shopify/shopify-app-remix/adapters/node";

// Last-resort process guards: Node's default is to KILL the process on an
// unhandled promise rejection — on a single-instance host (Render/Fly) that
// turns one stray async error anywhere (including inside dependencies) into
// a full 502 outage for every buyer. Registered once per process; individual
// code paths still carry their own try/catch — this is the safety net, not
// the error handling. The two guards are deliberately asymmetric:
// - unhandledRejection: a rejected promise is a CONTAINED failure — no stack
//   was unwound, shared state is intact — so log loudly and keep serving.
// - uncaughtException: the stack unwound mid-operation, so in-process state
//   (locks, partial writes, connection pools) is undefined. Log, flag the
//   exit code, give in-flight responses a short drain window, then exit so
//   the platform restarts the process into a known-good state. The drain is
//   deliberately minimal (1.5s): under bare remix-serve we do not own the
//   HTTP server instance, so we cannot stop the listener from ACCEPTING NEW
//   connections during the drain — every extra second of drain is a second
//   in which fresh requests land on a process whose state is undefined. A
//   custom server entry could call server.close() first (stop accepting,
//   then drain longer); that is the documented trade-off of staying on
//   remix-serve. The timer is unref()ed so an already-idle process exits
//   without waiting out the drain.
const processGuards = globalThis as typeof globalThis & { __upsellProcessGuards?: boolean };
if (!processGuards.__upsellProcessGuards) {
  processGuards.__upsellProcessGuards = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[process] UNHANDLED REJECTION — kept alive, please report:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] UNCAUGHT EXCEPTION — restarting after 1.5s drain, please report:", error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500).unref();
  });
}
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { bootstrapShop } from "./services/bootstrap.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.SingleMerchant,
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Seed shop settings, prompts, UI strings and kick off catalog sync.
      // Fire-and-forget so installation never blocks on the sync.
      bootstrapShop(session.shop, admin).catch((error) =>
        console.error(`[bootstrap] failed for ${session.shop}`, error),
      );
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
