import "@shopify/shopify-app-remix/adapters/node";

// Last-resort process guards: Node's default is to KILL the process on an
// unhandled promise rejection — on a single-instance host (Render/Fly) that
// turns one stray async error anywhere (including inside dependencies) into
// a full 502 outage for every buyer. Log loudly and stay alive instead.
// Registered once per process; individual code paths still carry their own
// try/catch — this is the safety net, not the error handling.
const processGuards = globalThis as typeof globalThis & { __upsellProcessGuards?: boolean };
if (!processGuards.__upsellProcessGuards) {
  processGuards.__upsellProcessGuards = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[process] UNHANDLED REJECTION — kept alive, please report:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] UNCAUGHT EXCEPTION — kept alive, please report:", error);
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
