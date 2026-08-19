// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sign-changeset — body `{ referenceId, offerId }`. Looks up the
// non-expired IssuedOffer row for this checkout and signs ITS stored changes
// (never client-supplied changes) into a 10-minute JWT that the post-purchase
// extension passes to applyChangeset(). Never 500s.
// ─────────────────────────────────────────────────────────────────────────────

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateCheckoutPublic } from "../lib/public-auth.server";
import { jparse } from "../lib/json";
import { signChangesetToken } from "../lib/changeset-token.server";
import type { OfferChange } from "../types";

/** Answers CORS preflight / GET probes. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticateCheckoutPublic(request, "api.sign-changeset");
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticateCheckoutPublic(request, "api.sign-changeset");
  try {
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
    if (!referenceId || !offerId) {
      return cors(json({ error: "referenceId and offerId are required" }, { status: 400 }));
    }

    const token = sessionToken as any;
    const inputData: any = token?.input_data ?? {};
    const shop: string =
      typeof inputData?.shop?.domain === "string" && inputData.shop.domain
        ? inputData.shop.domain
        : new URL(typeof token?.dest === "string" ? token.dest : "https://x").hostname;

    const issued = await prisma.issuedOffer.findUnique({
      where: { referenceId_offerId: { referenceId, offerId } },
    });
    // NOTE: re-signing an offer within its expiry window is allowed on purpose
    // (the extension retries applyChangeset after transient failures); the harm
    // is bounded — the token only carries OUR stored changes and lives 10 min.
    if (!issued || issued.shop !== shop || issued.expiresAt.getTime() < Date.now()) {
      return cors(json({ error: "Offer not found or expired" }, { status: 404 }));
    }

    // Ownership: the checkout that authenticated this request may only sign
    // its own offer — the body referenceId must match the token's
    // initialPurchase.referenceId. Thank-you offers ("typ:…") are
    // discount-code based and are never signed into a changeset.
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
      return cors(json({ error: "Offer not found or expired" }, { status: 404 }));
    }

    const changes = jparse<OfferChange[]>(issued.changesJson, []);
    if (changes.length === 0) {
      return cors(json({ error: "Offer has no signable changes" }, { status: 404 }));
    }

    const signed = signChangesetToken(referenceId, changes);

    return cors(json({ token: signed }));
  } catch (error) {
    console.error("[api.sign-changeset] failed", error);
    return cors(json({ error: "Unable to sign changeset" }));
  }
};

/**
 * True when the two reference ids denote the same checkout. Compares trailing
 * numeric parts so format drift (e.g. gid vs bare id) between the token and
 * the body does not break signing.
 */
function sameReference(a: string, b: string): boolean {
  if (a === b) return true;
  const na = a.match(/(\d+)$/)?.[1];
  const nb = b.match(/(\d+)$/)?.[1];
  return na !== undefined && nb !== undefined && na === nb;
}
