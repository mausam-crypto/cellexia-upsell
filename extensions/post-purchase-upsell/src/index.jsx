/**
 * Cellexia Post-Purchase Upsell — buyer-facing checkout extension.
 *
 * Flow:
 *   1. ShouldRender asks the app backend for offers and stashes the response
 *      in extension storage.
 *   2. Render reads storage.initialData (re-fetching when empty — Shop Pay
 *      may not persist ShouldRender storage) and walks the buyer through the
 *      offer pages one at a time (or a single bundle page).
 *   3. Accepting an offer signs the changeset server-side, applies it with
 *      one click (charged to the card just used), then advances.
 *
 * Timing: Shopify runs ShouldRender when the payment page loads (and again
 * whenever the total / currency / country changes) and only takes the
 * post-purchase detour if it has resolved by the time the order is processed
 * — so the backend answers /api/offer within a fixed budget. Pages whose AI
 * copy was not ready arrive with `corePending: true` and provisional fallback
 * copy; Render (which happens after payment, seconds later) polls
 * /api/offer-extended immediately and swaps the real copy in.
 *
 * Analytics events (impression / accepted / declined / error) are strictly
 * fire-and-forget: they can never break or block the buyer's order.
 */

import { useEffect, useRef, useState } from "react";
import {
  extend,
  render,
  useExtensionInput,
  BlockStack,
  InlineStack,
  Button,
  CalloutBanner,
  Heading,
  Image,
  Layout,
  TextBlock,
  TextContainer,
  Text,
  Separator,
  Tiles,
  View,
  Banner,
  Spinner,
} from "@shopify/post-purchase-ui-extensions-react";

// ════════════════════════════════════════════════════════════════════════════
// ▸▸▸ TODO — REQUIRED BEFORE DEPLOY ◂◂◂
//
// Replace APP_URL with the public HTTPS URL of YOUR deployed app backend
// (the Remix app that serves /api/offer, /api/sign-changeset, /api/events).
// During `shopify app dev` this is the tunnel URL printed by the CLI; in
// production it is your hosting URL, e.g. "https://cellexia-upsell.fly.dev".
// NO trailing slash. See docs/IMPLEMENTATION_GUIDE.md.
// ════════════════════════════════════════════════════════════════════════════
const APP_URL = "https://REPLACE-WITH-YOUR-APP-URL.example.com";

/** Inline English fallbacks — used only when the server strings are missing. */
const FALLBACK_STRINGS = {
  offer_badge: "Exclusive one-time offer",
  offer_x_of_y: "Offer {x} of {y}",
  time_left: "Offer reserved for",
  add_to_order: "Add to my order",
  add_all_to_order: "Add all to my order",
  decline: "No thanks, complete my order",
  was: "Was",
  now: "Now",
  save_pct: "Save {pct}%",
  ships_free: "Ships with your order, no extra shipping",
  one_click_note: "One click, charged to the payment method you just used",
  processing: "Adding to your order…",
  error_try_again: "Something went wrong. Your original order is not affected.",
  discount_applied: "{pct}% off, post-purchase exclusive",
  why_it_works: "Why it works with your order",
  research_shows: "What published research shows",
};

/**
 * Extended-copy poll gaps (ms between attempts). Attempts land at roughly
 * 1.2s, 3s, 6s, 11s, 19s and 29s after the pending page becomes active —
 * max 6 per offer, covering the typical 5-10s generation window and most
 * of the worst case.
 */
const EXTENDED_POLL_GAPS_MS = [1200, 1800, 3000, 5000, 8000, 10000];

/**
 * Pages issued with `corePending` shipped with deterministic fallback copy
 * because the AI copy was not ready inside the ShouldRender budget; by the
 * time Render runs (after payment — many seconds later) the real copy is
 * almost always stored server-side. Poll for it IMMEDIATELY on mount and
 * hold the first paint for at most this long so the buyer sees the real
 * headline rather than a headline that swaps a moment later.
 */
const CORE_POLL_GAPS_MS = [0, 1200, 2500, 4000, 6000, 8000];
const CORE_FIRST_PAINT_HOLD_MS = 900;

// ── Small helpers ────────────────────────────────────────────────────────────

/** Localized string lookup with English fallback and {var} interpolation. */
function t(strings, key, vars) {
  let template =
    (strings && typeof strings[key] === "string" && strings[key]) ||
    FALLBACK_STRINGS[key] ||
    key;
  if (vars) {
    // Object.keys (ES5) rather than Object.entries — the post-purchase
    // sandbox only guarantees ES2015 built-ins.
    const names = Object.keys(vars);
    for (let i = 0; i < names.length; i++) {
      template = template.split(`{${names[i]}}`).join(String(vars[names[i]]));
    }
  }
  return template;
}

function toAmount(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Currency formatting with a plain-text fallback when Intl rejects inputs. */
function formatMoney(amount, currency, locale) {
  const n = toAmount(amount);
  try {
    return new Intl.NumberFormat(locale || "en", {
      style: "currency",
      currency: currency || "EUR",
    }).format(n);
  } catch (error) {
    return `${n.toFixed(2)} ${currency || ""}`.trim();
  }
}

/** Seconds → "mm:ss". */
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
  const mm = pad2(Math.floor(s / 60));
  const ss = pad2(s % 60);
  return `${mm}:${ss}`;
}

/** POST /api/offer — returns the OfferResponse JSON (throws on failure). */
async function fetchOfferResponse(token, referenceId) {
  const response = await fetch(`${APP_URL}/api/offer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ referenceId }),
  });
  if (!response.ok) {
    throw new Error(`Offer request failed with status ${response.status}`);
  }
  return response.json();
}

/** Validate/clean an OfferResponse. Returns null when there is nothing to show. */
function normalizeOfferResponse(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.offers)) {
    return null;
  }
  const offers = data.offers.filter(
    (offer) =>
      offer &&
      typeof offer.offerId === "string" &&
      Array.isArray(offer.products) &&
      offer.products.length > 0 &&
      Array.isArray(offer.changes) &&
      offer.changes.length > 0,
  );
  if (offers.length === 0) return null;
  return { ...data, offers };
}

/**
 * Pull an accurate presentment total out of a calculateChangeset result.
 * Shape differs across API versions — parse defensively; null means
 * "fall back to the server-provided prices".
 */
function extractCalculatedTotal(result) {
  try {
    const purchase =
      result && typeof result === "object"
        ? result.calculatedPurchase || result
        : null;
    if (!purchase || typeof purchase !== "object") return null;
    const candidates = [
      purchase.totalOutstandingSet && purchase.totalOutstandingSet.presentmentMoney,
      purchase.totalOutstandingSet && purchase.totalOutstandingSet.shopMoney,
    ];
    for (const money of candidates) {
      if (!money) continue;
      const amount =
        typeof money.amount === "number" ? money.amount : parseFloat(money.amount);
      if (Number.isFinite(amount) && amount > 0) return round2(amount);
    }
    return null;
  } catch (error) {
    return null;
  }
}

/** Fire-and-forget analytics event — must NEVER throw or block the UX. */
function sendEvent(token, payload) {
  try {
    fetch(`${APP_URL}/api/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ surface: "post_purchase", ...payload }),
      keepalive: true,
    }).catch(() => {
      /* analytics are best-effort */
    });
  } catch (error) {
    /* analytics are best-effort */
  }
}

// ── ShouldRender ─────────────────────────────────────────────────────────────

extend(
  "Checkout::PostPurchase::ShouldRender",
  async ({ inputData, storage }) => {
    try {
      const referenceId =
        inputData && inputData.initialPurchase
          ? inputData.initialPurchase.referenceId
          : null;
      const offerResponse = await fetchOfferResponse(
        inputData && inputData.token,
        referenceId,
      );
      try {
        await storage.update(offerResponse);
      } catch (error) {
        // Storage failure is fine — Render re-fetches when initialData is empty.
      }
      const hasOffers = Boolean(
        offerResponse &&
          Array.isArray(offerResponse.offers) &&
          offerResponse.offers.length > 0,
      );
      return { render: hasOffers };
    } catch (error) {
      // Any failure → skip the page entirely; never delay the buyer.
      return { render: false };
    }
  },
);

// ── Render ───────────────────────────────────────────────────────────────────

render("Checkout::PostPurchase::Render", () => <App />);

export function App() {
  const input = useExtensionInput() || {};
  const { storage, inputData, calculateChangeset, applyChangeset, done } = input;

  const token = inputData ? inputData.token : null;
  const referenceId =
    inputData && inputData.initialPurchase
      ? inputData.initialPurchase.referenceId
      : null;
  const locale = (inputData && inputData.locale) || "en";

  const [offerData, setOfferData] = useState(() =>
    normalizeOfferResponse(storage ? storage.initialData : null),
  );
  const [loading, setLoading] = useState(() => offerData === null);
  const [pageIndex, setPageIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [justAccepted, setJustAccepted] = useState(false);
  const [errorText, setErrorText] = useState(null);
  const [calculatedTotal, setCalculatedTotal] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);

  const doneRef = useRef(false);
  const expiredRef = useRef(false);
  const processingRef = useRef(false);
  processingRef.current = processing || justAccepted;
  const impressionsSentRef = useRef({});
  const advanceTimerRef = useRef(null);
  // Late-arriving copy (offerId → {paragraphs, proof, closer} and, for pages
  // issued with corePending, also {headline, body, bullets}).
  const [extendedByOfferId, setExtendedByOfferId] = useState({});
  const extendedTriesRef = useRef({});
  const extendedTimerRef = useRef(null);
  // Brief first-paint hold for corePending pages (see CORE_FIRST_PAINT_HOLD_MS).
  const [holdingCoreFor, setHoldingCoreFor] = useState(null);
  const coreHoldTimerRef = useRef(null);

  /** done() exactly once, and never let it throw into the render tree. */
  function safeDone() {
    if (doneRef.current) return;
    doneRef.current = true;
    try {
      Promise.resolve(done()).catch(() => {});
    } catch (error) {
      /* completing the order is Shopify's job from here */
    }
  }

  const hasOffers = Boolean(
    offerData && Array.isArray(offerData.offers) && offerData.offers.length > 0,
  );
  const offers = hasOffers ? offerData.offers : [];
  const safeIndex = Math.min(pageIndex, Math.max(0, offers.length - 1));
  const offer = hasOffers ? offers[safeIndex] : null;
  const currentOfferId = offer ? offer.offerId : null;
  const strings = (offerData && offerData.strings) || {};
  const ui = (offerData && offerData.ui) || {};
  const currency = (offerData && offerData.currency) || "EUR";
  const showCountdown = Boolean(hasOffers && ui.showCountdown);

  // Shop Pay caveat: Render may not see what ShouldRender stored — re-fetch.
  useEffect(() => {
    if (offerData) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const refreshed = await fetchOfferResponse(token, referenceId);
        if (cancelled) return;
        const normalized = normalizeOfferResponse(refreshed);
        if (normalized) {
          setOfferData(normalized);
        } else {
          safeDone();
        }
      } catch (error) {
        if (!cancelled) safeDone(); // never trap the buyer on an empty page
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown: starts once offers are visible; single timer for the whole flow.
  useEffect(() => {
    if (!showCountdown) return undefined;
    const minutes = Number(ui.countdownMinutes);
    const totalSeconds =
      Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 600;
    setSecondsLeft(totalSeconds);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, totalSeconds - elapsed);
      setSecondsLeft(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCountdown]);

  // Countdown expiry → close the offer flow (unless an accept is in flight —
  // in that case advance() (success) or handleAccept's catch (failure)
  // notices the expiry flag once it completes).
  useEffect(() => {
    if (!showCountdown || secondsLeft !== 0) return;
    expiredRef.current = true;
    if (!processingRef.current) safeDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, showCountdown]);

  // Impression event on each page mount (deduplicated per offerId).
  useEffect(() => {
    if (!currentOfferId || impressionsSentRef.current[currentOfferId]) return;
    impressionsSentRef.current[currentOfferId] = true;
    sendEvent(token, {
      referenceId,
      offerId: currentOfferId,
      eventType: "impression",
      currency,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOfferId]);

  // calculateChangeset per page → accurate presentment totals for the money row.
  useEffect(() => {
    setCalculatedTotal(null);
    if (!currentOfferId || !offer || typeof calculateChangeset !== "function") {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await calculateChangeset({ changes: offer.changes });
        if (cancelled) return;
        const total = extractCalculatedTotal(result);
        if (total !== null) setCalculatedTotal(total);
      } catch (error) {
        // Fall back to the server-provided prices — never surface this.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOfferId]);

  // Extended-copy polling: a page may arrive with extendedPending while its
  // below-CTA sections (paragraphs/proof) are still generating server-side.
  // Poll /api/offer-extended for the ACTIVE page only — attempts at ~1.2s,
  // 3s, 6s, 11s, 19s and 29s, max 6 per offerId — and merge the result into
  // extendedByOfferId so the "Why it works" section appears when ready.
  // Strictly best-effort: failures leave the section hidden and never touch
  // accept/decline/countdown/analytics behaviour.
  useEffect(() => {
    let cancelled = false;
    try {
      if (!currentOfferId || !offer) return undefined;
      const corePending = offer.corePending === true;
      if (!corePending && offer.extendedPending !== true) return undefined;
      if (extendedByOfferId[currentOfferId]) return undefined; // already merged
      const inline = offer.copy || {};
      const hasBelowCta =
        (Array.isArray(inline.paragraphs) &&
          inline.paragraphs.some(
            (p) => typeof p === "string" && p.trim().length > 0,
          )) ||
        (Array.isArray(inline.proof) && inline.proof.length > 0);
      // Extended-only pages whose content already shipped need no poll; a
      // corePending page always polls (its whole copy is provisional).
      if (!corePending && hasBelowCta) return undefined;

      const offerId = currentOfferId;
      const gaps = corePending ? CORE_POLL_GAPS_MS : EXTENDED_POLL_GAPS_MS;

      // corePending: hold the first paint briefly so the real headline lands
      // before the buyer reads the fallback one. Released by the first poll
      // result (either way) or the timer, whichever comes first.
      if (corePending) {
        setHoldingCoreFor(offerId);
        coreHoldTimerRef.current = setTimeout(() => {
          coreHoldTimerRef.current = null;
          if (!cancelled) setHoldingCoreFor(null);
        }, CORE_FIRST_PAINT_HOLD_MS);
      }
      function releaseHold() {
        if (coreHoldTimerRef.current) {
          clearTimeout(coreHoldTimerRef.current);
          coreHoldTimerRef.current = null;
        }
        setHoldingCoreFor((current) => (current === offerId ? null : current));
      }

      function scheduleNext() {
        try {
          const used = extendedTriesRef.current[offerId] || 0;
          if (cancelled || used >= gaps.length) return;
          extendedTimerRef.current = setTimeout(attempt, gaps[used]);
        } catch (error) {
          /* best-effort */
        }
      }

      function attempt() {
        extendedTimerRef.current = null;
        const used = extendedTriesRef.current[offerId] || 0;
        if (cancelled || used >= gaps.length) return;
        extendedTriesRef.current[offerId] = used + 1;
        (async () => {
          let ready = false;
          try {
            const response = await fetch(`${APP_URL}/api/offer-extended`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ referenceId, offerId }),
            });
            if (response.ok) {
              const data = await response.json();
              if (!cancelled && data && data.ready === true) {
                // Fields may sit at the top level or under a nested object.
                const src =
                  (data.extended && typeof data.extended === "object"
                    ? data.extended
                    : null) ||
                  (data.copy && typeof data.copy === "object"
                    ? data.copy
                    : null) ||
                  data;
                const coreReady =
                  data.coreReady === true &&
                  typeof src.headline === "string" &&
                  src.headline.trim().length > 0;
                // A corePending page keeps polling until the CORE is ready;
                // extended-only pages are done as soon as anything is ready.
                ready = corePending ? coreReady : true;
                if (ready) {
                  setExtendedByOfferId((prev) => ({
                    ...prev,
                    [offerId]: {
                      paragraphs: Array.isArray(src.paragraphs)
                        ? src.paragraphs
                        : [],
                      proof: Array.isArray(src.proof) ? src.proof : [],
                      closer:
                        typeof src.closer === "string" ? src.closer : null,
                      ...(coreReady
                        ? {
                            headline: src.headline,
                            body: typeof src.body === "string" ? src.body : "",
                            bullets: Array.isArray(src.bullets)
                              ? src.bullets
                              : [],
                          }
                        : {}),
                    },
                  }));
                }
              }
            }
          } catch (error) {
            /* best-effort — retry on the schedule until tries run out */
          }
          if (corePending && !cancelled) releaseHold();
          if (!cancelled && !ready) scheduleNext();
        })();
      }

      scheduleNext();
    } catch (error) {
      /* best-effort — polling must never break the page */
    }
    return () => {
      cancelled = true;
      if (extendedTimerRef.current) {
        clearTimeout(extendedTimerRef.current);
        extendedTimerRef.current = null;
      }
      if (coreHoldTimerRef.current) {
        clearTimeout(coreHoldTimerRef.current);
        coreHoldTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOfferId]);

  // Clear the brief-success timer if the extension unmounts mid-transition.
  useEffect(
    () => () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    },
    [],
  );

  /** Move to the next offer page, or finish the flow. */
  function advance() {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    // Terminal condition FIRST: when the countdown expired or this was the
    // last page there is no incoming page to prepare — call safeDone() and
    // leave processing/justAccepted/calculatedTotal untouched so the success
    // state is not wiped (flashing back to an actionable-looking page) while
    // Shopify dismisses the page.
    if (expiredRef.current || safeIndex + 1 >= offers.length) {
      safeDone();
      return;
    }
    setProcessing(false);
    setJustAccepted(false);
    setErrorText(null);
    // Clear in the same batch as the page change so the incoming product
    // never renders the previous page's calculated total for one frame.
    setCalculatedTotal(null);
    setPageIndex(safeIndex + 1);
  }

  /** One-click accept: sign server-side → applyChangeset → event → advance. */
  async function handleAccept() {
    if (processing || justAccepted || !offer) return;
    setProcessing(true);
    setErrorText(null);
    try {
      const response = await fetch(`${APP_URL}/api/sign-changeset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ referenceId, offerId: offer.offerId }),
      });
      const signed = await response.json();
      if (
        !response.ok ||
        !signed ||
        typeof signed.token !== "string" ||
        signed.token.length === 0
      ) {
        throw new Error(
          (signed && signed.error) || "Unable to sign the changeset",
        );
      }
      const result = await applyChangeset(signed.token);
      const status =
        result && result.status ? String(result.status).toLowerCase() : "";
      if (status === "unprocessed") {
        const detail =
          result && Array.isArray(result.errors) && result.errors.length > 0
            ? result.errors
                .map((e) => (e && e.message) || (e && e.code) || "")
                .filter(Boolean)
                .join("; ")
            : "Changeset was not processed";
        throw new Error(detail || "Changeset was not processed");
      }
      // "partially_processed": the order WAS edited but the charge failed —
      // Shopify runs its own payment recovery with the buyer, so the flow
      // still advances as a success. Report zero revenue (with a marker) so
      // analytics and the bandit never count unpaid revenue.
      const partiallyProcessed = status === "partially_processed";
      const revenue = partiallyProcessed
        ? 0
        : round2(
            offer.products.reduce(
              (sum, p) => sum + toAmount(p.discountedPrice),
              0,
            ),
          );
      const acceptedEvent = {
        referenceId,
        offerId: offer.offerId,
        eventType: "accepted",
        revenue,
        currency,
      };
      if (partiallyProcessed) acceptedEvent.message = "partially_processed";
      sendEvent(token, acceptedEvent);
      setJustAccepted(true);
      // Brief success beat so the buyer sees the confirmation, then move on.
      advanceTimerRef.current = setTimeout(() => {
        advance();
      }, 1200);
    } catch (error) {
      sendEvent(token, {
        referenceId,
        offerId: offer.offerId,
        eventType: "error",
        message:
          error && error.message
            ? String(error.message).slice(0, 500)
            : "accept_failed",
      });
      setErrorText(t(strings, "error_try_again"));
      setProcessing(false);
      // If the countdown expired while this accept was in flight, the expiry
      // effect already fired (secondsLeft stays 0, so it never re-runs) and
      // deferred to us — terminate the flow now so the buyer is never left on
      // a dead-end page. The error Banner stays visible until Shopify closes
      // the page once done() resolves.
      if (expiredRef.current) safeDone();
    }
  }

  /** Decline: event, then next page / finish. Always available. */
  function handleDecline() {
    if (processing || justAccepted) return;
    if (offer) {
      sendEvent(token, {
        referenceId,
        offerId: offer.offerId,
        eventType: "declined",
        currency,
      });
    }
    advance();
  }

  // ── Loading / empty states ─────────────────────────────────────────────────

  if (
    loading ||
    !hasOffers ||
    !offer ||
    (holdingCoreFor !== null && holdingCoreFor === currentOfferId)
  ) {
    // While loading (or after safeDone() on an empty result, or during the
    // brief corePending first-paint hold) show a quiet centered spinner —
    // Shopify closes the page once done() resolves.
    return (
      <BlockStack spacing="loose" alignment="center">
        <Spinner />
      </BlockStack>
    );
  }

  // ── Page data ──────────────────────────────────────────────────────────────

  const totalPages = offers.length;
  const pageNumber = safeIndex + 1;
  const products = offer.products;
  // Long-form copy (optional): deep-dive paragraphs + one-line closer.
  // When the server deferred it (extendedPending), the polled result stored
  // in extendedByOfferId fills the gap; inline copy always wins when present.
  // For corePending pages the polled result ALSO carries the real
  // headline/lead/bullets, which replace the provisional fallback copy.
  const extended =
    (currentOfferId && extendedByOfferId[currentOfferId]) || null;
  const inlineCopy = offer.copy || { headline: "", body: "", bullets: [] };
  const copy =
    offer.corePending === true &&
    extended &&
    typeof extended.headline === "string" &&
    extended.headline.trim().length > 0
      ? {
          ...inlineCopy,
          headline: extended.headline,
          body: extended.body || "",
          bullets: Array.isArray(extended.bullets) ? extended.bullets : [],
          // The real copy replaces the fallback wholesale — its own
          // below-CTA sections (possibly empty) win over fallback text.
          paragraphs: Array.isArray(extended.paragraphs) ? extended.paragraphs : [],
          proof: Array.isArray(extended.proof) ? extended.proof : [],
          closer: typeof extended.closer === "string" ? extended.closer : "",
        }
      : inlineCopy;
  const bullets = Array.isArray(copy.bullets) ? copy.bullets.filter(Boolean) : [];
  const paragraphsSrc =
    Array.isArray(copy.paragraphs) &&
    copy.paragraphs.some((p) => typeof p === "string" && p.trim().length > 0)
      ? copy.paragraphs
      : (extended && extended.paragraphs) || [];
  const paragraphs = Array.isArray(paragraphsSrc)
    ? paragraphsSrc.filter(
        (p) => typeof p === "string" && p.trim().length > 0,
      )
    : [];
  // Research statements (optional): rendered under the paragraphs with their
  // own sub-heading. Coerce finite numbers, drop anything else non-string.
  const proofSrc =
    Array.isArray(copy.proof) && copy.proof.length > 0
      ? copy.proof
      : (extended && extended.proof) || [];
  const proof = Array.isArray(proofSrc)
    ? proofSrc
        .map((item) =>
          typeof item === "string"
            ? item
            : typeof item === "number" && Number.isFinite(item)
              ? String(item)
              : "",
        )
        .filter((item) => item.trim().length > 0)
    : [];
  const closerSrc =
    typeof copy.closer === "string" && copy.closer.trim().length > 0
      ? copy.closer
      : extended
        ? extended.closer
        : null;
  const closer =
    typeof closerSrc === "string" && closerSrc.trim().length > 0
      ? closerSrc
      : null;
  const discountPct = Math.round(toAmount(offer.discountPct));
  const showComparePrice = ui.showComparePrice !== false;

  const originalTotal = round2(
    products.reduce((sum, p) => sum + toAmount(p.price), 0),
  );
  const discountedTotalServer = round2(
    products.reduce((sum, p) => sum + toAmount(p.discountedPrice), 0),
  );
  // Prefer the accurate presentment total from calculateChangeset.
  const nowTotal =
    calculatedTotal !== null ? calculatedTotal : discountedTotalServer;

  const isBundle =
    offerData.displayMode === "bundle" && products.length > 1;

  const banners = (
    <BlockStack spacing="tight">
      {errorText ? <Banner status="critical">{errorText}</Banner> : null}
      {justAccepted ? (
        <Banner status="success">
          {offer.discountTitle ||
            t(strings, "discount_applied", { pct: discountPct })}
        </Banner>
      ) : null}
    </BlockStack>
  );

  const trustAndCountdown = (
    <BlockStack spacing="xtight">
      <TextBlock subdued size="small">
        {t(strings, "ships_free")}
      </TextBlock>
      <TextBlock subdued size="small">
        {t(strings, "one_click_note")}
      </TextBlock>
      {showCountdown && secondsLeft !== null ? (
        <InlineStack spacing="xtight">
          <Text subdued size="small">
            {t(strings, "time_left")}
          </Text>
          <Text emphasized size="small">
            {formatClock(secondsLeft)}
          </Text>
        </InlineStack>
      ) : null}
    </BlockStack>
  );

  const actionButtons = (
    <BlockStack spacing="tight">
      <Button submit loading={processing} onPress={handleAccept}>
        {isBundle
          ? t(strings, "add_all_to_order")
          : t(strings, "add_to_order")}
      </Button>
      <Button plain disabled={processing || justAccepted} onPress={handleDecline}>
        {t(strings, "decline")}
      </Button>
      {processing && !justAccepted ? (
        <TextBlock subdued size="small">
          {t(strings, "processing")}
        </TextBlock>
      ) : null}
    </BlockStack>
  );

  // Calm one-line reassurance rendered directly above the buttons.
  const closerLine = closer ? <Text emphasized>{closer}</Text> : null;

  // Deep-dive persuasion (long copy) — rendered BELOW the buttons so the CTA
  // stays high on every viewport. Hidden entirely when there are neither
  // paragraphs nor research statements; the section heading always renders
  // when proof is present so the research block has context.
  const whyItWorks =
    paragraphs.length > 0 || proof.length > 0 ? (
      <BlockStack spacing="tight">
        <Separator />
        <TextBlock emphasized>{t(strings, "why_it_works")}</TextBlock>
        {paragraphs.map((paragraph, i) => (
          <TextBlock key={i} size="small">
            {paragraph}
          </TextBlock>
        ))}
        {proof.length > 0 ? (
          <BlockStack spacing="xtight">
            <TextBlock emphasized size="small">
              {t(strings, "research_shows")}
            </TextBlock>
            {proof.map((item, i) => (
              <TextBlock key={i} subdued size="small">
                {`• ${item}`}
              </TextBlock>
            ))}
          </BlockStack>
        ) : null}
      </BlockStack>
    ) : null;

  const callout = (
    <CalloutBanner title={t(strings, "offer_badge")}>
      {totalPages > 1
        ? t(strings, "offer_x_of_y", { x: pageNumber, y: totalPages })
        : null}
    </CalloutBanner>
  );

  // ── Bundle page: product tiles + combined copy + one accept-all button ────
  if (isBundle) {
    return (
      <BlockStack spacing="loose">
        {callout}
        <Tiles maxPerLine={3}>
          {products.map((product) => (
            <BlockStack
              key={product.variantId || product.productId}
              spacing="tight"
              alignment="center"
            >
              {product.image ? (
                <Image source={product.image} description={product.title} />
              ) : (
                <View />
              )}
              <TextContainer alignment="center" spacing="tight">
                <Text emphasized>{product.title}</Text>
              </TextContainer>
              <InlineStack spacing="xtight">
                {showComparePrice ? (
                  <Text role="deletion" subdued size="small">
                    {formatMoney(product.price, currency, locale)}
                  </Text>
                ) : null}
                <Text emphasized appearance="critical">
                  {formatMoney(product.discountedPrice, currency, locale)}
                </Text>
              </InlineStack>
            </BlockStack>
          ))}
        </Tiles>
        <Separator />
        <TextContainer spacing="tight">
          <Heading>{copy.headline}</Heading>
          <TextBlock>{copy.body}</TextBlock>
        </TextContainer>
        {bullets.length > 0 ? (
          <BlockStack spacing="xtight">
            {bullets.map((bullet, i) => (
              <TextBlock key={i} subdued>
                {`• ${bullet}`}
              </TextBlock>
            ))}
          </BlockStack>
        ) : null}
        <Separator />
        <PriceRow
          strings={strings}
          currency={currency}
          locale={locale}
          wasAmount={originalTotal}
          nowAmount={nowTotal}
          discountPct={discountPct}
          showWas={showComparePrice}
        />
        {trustAndCountdown}
        {banners}
        {closerLine}
        {actionButtons}
        {whyItWorks}
      </BlockStack>
    );
  }

  // ── Sequential page: image left, copy + price + actions right ─────────────
  const product = products[0];
  return (
    <BlockStack spacing="loose">
      {callout}
      <Layout
        media={[
          { viewportSize: "small", sizes: [1, 0, 1], maxInlineSize: 0.9 },
          { viewportSize: "medium", sizes: [532, 0, 1], maxInlineSize: 420 },
          { viewportSize: "large", sizes: [560, 38, 340] },
        ]}
      >
        {product.image ? (
          <Image source={product.image} description={product.title} />
        ) : (
          <View />
        )}
        <BlockStack />
        <BlockStack spacing="loose">
          <TextContainer spacing="tight">
            <Heading>{copy.headline}</Heading>
            <TextBlock>{copy.body}</TextBlock>
          </TextContainer>
          {bullets.length > 0 ? (
            <BlockStack spacing="xtight">
              {bullets.map((bullet, i) => (
                <TextBlock key={i} subdued>
                  {`• ${bullet}`}
                </TextBlock>
              ))}
            </BlockStack>
          ) : null}
          <Separator />
          <BlockStack spacing="xtight">
            <Text emphasized>{product.title}</Text>
            <PriceRow
              strings={strings}
              currency={currency}
              locale={locale}
              wasAmount={originalTotal}
              nowAmount={nowTotal}
              discountPct={discountPct}
              showWas={showComparePrice}
            />
          </BlockStack>
          {trustAndCountdown}
          {banners}
          {closerLine}
          {actionButtons}
        </BlockStack>
      </Layout>
      {whyItWorks}
    </BlockStack>
  );
}

/** Was/Now money row with the save-percentage badge text. */
function PriceRow({
  strings,
  currency,
  locale,
  wasAmount,
  nowAmount,
  discountPct,
  showWas,
}) {
  return (
    <InlineStack spacing="tight">
      {showWas ? (
        <Text role="deletion" subdued size="large">
          {`${t(strings, "was")} ${formatMoney(wasAmount, currency, locale)}`}
        </Text>
      ) : null}
      <Text emphasized appearance="critical" size="large">
        {`${t(strings, "now")} ${formatMoney(nowAmount, currency, locale)}`}
      </Text>
      {discountPct > 0 ? (
        <Text emphasized appearance="success">
          {t(strings, "save_pct", { pct: discountPct })}
        </Text>
      ) : null}
    </InlineStack>
  );
}
