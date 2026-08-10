// The ONE place a changeset JWT is minted. /api/sign-changeset signs the
// changes stored on a validated IssuedOffer row through this function, and the
// health-check battery signs (and verifies) a synthetic offer through the SAME
// function — so a green "changeset signing" check certifies the exact code
// path a live buyer's accept uses, not a lookalike.

import jwt from "jsonwebtoken";
import type { OfferChange } from "../types";

/** Signed changeset lifetime — Shopify rejects older applyChangeset tokens. */
export const CHANGESET_TOKEN_TTL = "10m";

/**
 * Mint the JWT that the post-purchase extension passes to applyChangeset().
 * Claims: iss = API key, jti = unique id, sub = the checkout's referenceId,
 * changes = the server-stored changeset. HMAC-signed with the app secret —
 * the same secret Shopify verifies against.
 */
export function signChangesetToken(referenceId: string, changes: OfferChange[]): string {
  return jwt.sign(
    {
      iss: process.env.SHOPIFY_API_KEY,
      jti: crypto.randomUUID(),
      sub: String(referenceId),
      changes,
    },
    process.env.SHOPIFY_API_SECRET || "",
    { expiresIn: CHANGESET_TOKEN_TTL },
  );
}

/**
 * Decode + verify a changeset token with the app secret. Used only by the
 * health check to prove sign→verify round-trips with the configured secret;
 * throws on any mismatch (bad secret, expired, malformed).
 */
export function verifyChangesetToken(token: string): {
  iss?: string;
  sub?: string;
  changes?: OfferChange[];
} {
  return jwt.verify(token, process.env.SHOPIFY_API_SECRET || "") as {
    iss?: string;
    sub?: string;
    changes?: OfferChange[];
  };
}
