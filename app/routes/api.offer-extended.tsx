// ─────────────────────────────────────────────────────────────────────────────
// POST /api/offer-extended — polling endpoint for the below-CTA extended copy
// sections of a post-purchase page issued with extendedPending: true. Body is
// { referenceId, offerId }. Responds { ready: false } until the background
// completion has patched the IssuedOffer meta (meta.extendedReady), then
// { ready: true, paragraphs, proof, closer } for the extension to merge in.
// Same auth + shop derivation as /api/events, same ownership rule as
// /api/sign-changeset: the checkout that authenticated this request may only
// read its own non-expired offer. Unknown/mismatch → { ready: false }.
// This endpoint never 500s.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { jparse } from "../lib/json";

const REFERENCE_ID_RE = /^[A-Za-z0-9:/_.-]{1,80}$/;
const OFFER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

/** Non-empty strings only — the stored meta is data, never trusted as typed. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

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

    const referenceId =
      body?.referenceId !== null && body?.referenceId !== undefined
        ? String(body.referenceId)
        : "";
    const offerId =
      body?.offerId !== null && body?.offerId !== undefined ? String(body.offerId) : "";
    if (!REFERENCE_ID_RE.test(referenceId) || !OFFER_ID_RE.test(offerId)) {
      return cors(json({ ready: false }));
    }

    // Ownership (mirrors /api/sign-changeset): the body referenceId must match
    // the token's initialPurchase.referenceId. Thank-you offers ("typ:…") are
    // never issued with extendedPending and post-purchase tokens carry numeric
    // referenceIds, so typ refs are rejected here too.
    const tokenReferenceId =
      inputData?.initialPurchase?.referenceId !== null &&
      inputData?.initialPurchase?.referenceId !== undefined
        ? String(inputData.initialPurchase.referenceId)
        : "";
    if (
      referenceId.startsWith("typ:") ||
      !tokenReferenceId ||
      !sameReference(referenceId, tokenReferenceId)
    ) {
      return cors(json({ ready: false }));
    }

    const row = await prisma.issuedOffer.findUnique({
      where: { referenceId_offerId: { referenceId, offerId } },
    });
    if (!row || row.shop !== shop || row.expiresAt.getTime() < Date.now()) {
      return cors(json({ ready: false }));
    }

    const meta = jparse<any>(row.offerMetaJson, null);
    const copy = meta?.page?.copy;
    if (meta?.extendedReady === true && copy && typeof copy === "object") {
      return cors(
        json({
          ready: true,
          paragraphs: stringArray(copy.paragraphs),
          proof: stringArray(copy.proof),
          closer: typeof copy.closer === "string" ? copy.closer : "",
        }),
      );
    }
    return cors(json({ ready: false }));
  } catch (error) {
    console.error("[api.offer-extended] failed", error);
    return cors(json({ ready: false }));
  }
};

/**
 * True when the two reference ids denote the same checkout. Compares trailing
 * numeric parts so format drift (e.g. gid vs bare id) between the token and
 * the body does not break polling.
 */
function sameReference(a: string, b: string): boolean {
  if (a === b) return true;
  const na = a.match(/(\d+)$/)?.[1];
  const nb = b.match(/(\d+)$/)?.[1];
  return na !== undefined && nb !== undefined && na === nb;
}
