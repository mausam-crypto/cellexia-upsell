// ─────────────────────────────────────────────────────────────────────────────
// POST /api/events — analytics event sink for both extensions. Body is an
// ExtensionEventPayload (impression | accepted | declined | error). Events are
// denormalized against the IssuedOffer meta by the analytics service. Fire and
// forget from the extensions' point of view: this endpoint never 500s.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordExtensionEvent } from "../services/analytics.server";
import type { ExtensionEventPayload } from "../types";

const EVENT_TYPES = ["impression", "accepted", "declined", "error"] as const;
const REFERENCE_ID_RE = /^[A-Za-z0-9:/_.-]{1,80}$/;
const OFFER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  try {
    const token = sessionToken as any;
    const inputData: any = token?.input_data ?? {};
    const shop: string =
      typeof inputData?.shop?.domain === "string" && inputData.shop.domain
        ? inputData.shop.domain
        : new URL(typeof token?.dest === "string" ? token.dest : "https://x").hostname;

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    if (!body || typeof body !== "object") body = {};

    const eventType = EVENT_TYPES.find((t) => t === body?.eventType);
    const referenceId =
      body?.referenceId !== null && body?.referenceId !== undefined
        ? String(body.referenceId)
        : "";
    const offerId =
      body?.offerId !== null && body?.offerId !== undefined ? String(body.offerId) : "";
    if (!eventType || !REFERENCE_ID_RE.test(referenceId) || !OFFER_ID_RE.test(offerId)) {
      return cors(json({ ok: false }));
    }

    // No client-supplied customerId is forwarded — recordExtensionEvent
    // derives customer/market/product data from the stored IssuedOffer meta.
    const revenue = Number(body?.revenue);
    const payload: ExtensionEventPayload = {
      referenceId,
      offerId,
      eventType,
      revenue: Number.isFinite(revenue) ? revenue : undefined,
      currency: typeof body?.currency === "string" ? body.currency : undefined,
      surface:
        body?.surface === "thank_you" || body?.surface === "post_purchase"
          ? body.surface
          : undefined,
      message: typeof body?.message === "string" ? body.message.slice(0, 500) : undefined,
    };

    await recordExtensionEvent(shop, payload);
    return cors(json({ ok: true }));
  } catch (error) {
    console.error("[api.events] failed", error);
    return cors(json({ ok: false }));
  }
};
