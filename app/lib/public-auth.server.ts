// Shared authentication wrapper for the public extension endpoints
// (/api/offer, /api/offer-extended, /api/sign-changeset, /api/events,
// /api/typ-offer). Two production-only concerns live here:
//
// 1. Rejections thrown by authenticate.public.checkout (401 bad/missing token,
//    410 bot UA) carry NO CORS headers, so from a browser or extension worker
//    the failure surfaces as an opaque "TypeError: Failed to fetch" instead of
//    a readable status — the developer cannot tell "wrong SHOPIFY_API_SECRET"
//    from "backend down". Re-throw the same response WITH CORS headers.
// 2. The library logs the verification failure only at DEBUG. Log one
//    actionable WARN line with the (unverified, log-only) shop domain from
//    the token payload so a secret mismatch is greppable in production logs.
//
// Security is unchanged: nothing is trusted from the failed token; the
// request is still rejected with the same status.

import { authenticate } from "../shopify.server";

type CheckoutAuth = Awaited<ReturnType<typeof authenticate.public.checkout>>;

/** Best-effort, UNVERIFIED payload peek — for log lines only, never trusted. */
function peekTokenShop(request: Request): string {
  try {
    const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const part = raw.split(".")[1];
    if (!part) return "-";
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    const domain = payload?.input_data?.shop?.domain ?? payload?.dest ?? "-";
    return typeof domain === "string" ? domain.replace(/^https?:\/\//, "") : "-";
  } catch {
    return "-";
  }
}

export async function authenticateCheckoutPublic(
  request: Request,
  route: string,
): Promise<CheckoutAuth> {
  try {
    return await authenticate.public.checkout(request);
  } catch (error) {
    if (error instanceof Response) {
      if (error.status === 401) {
        console.warn(
          `[${route}] rejected: extension token failed verification (401) — token shop=${peekTokenShop(request)}, hasAuthHeader=${request.headers.has("authorization")}. On a live store this almost always means SHOPIFY_API_SECRET on this server is not the client secret of the Partner app that serves the extension.`,
        );
      } else if (error.status === 410) {
        console.warn(
          `[${route}] rejected: user agent classified as a bot (410) — ua="${(request.headers.get("user-agent") ?? "").slice(0, 120)}"`,
        );
      }
      const headers = new Headers(error.headers);
      if (!headers.has("Access-Control-Allow-Origin")) {
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      }
      throw new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers,
      });
    }
    throw error;
  }
}
