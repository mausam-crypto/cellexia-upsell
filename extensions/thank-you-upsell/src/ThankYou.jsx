// Cellexia — Thank-you page upsell fallback (Module K).
//
// Covers orders paid with Apple Pay / Google Pay / PayPal / Klarna etc., which
// Shopify excludes from the post-purchase page (credit-card-only platform
// limitation). Renders ONE discount-code-based offer on the thank-you page.
//
// Defensive by design: if anything essential is missing (the app_url block
// setting, the session token, the network, or the offer itself), the block
// renders null. It must NEVER break the thank-you page.

import { Component, useEffect, useRef, useState } from "react";
import {
  reactExtension,
  useApi,
  useSettings,
  BlockStack,
  InlineLayout,
  View,
  Image,
  Text,
  Heading,
  Link,
  Banner,
  SkeletonImage,
  SkeletonText,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.thank-you.block.render", () => (
  <SafeBoundary>
    <ThankYouUpsell />
  </SafeBoundary>
));

/**
 * Error boundary of last resort: any render/runtime error inside the block
 * collapses it to null instead of breaking the merchant's thank-you page.
 */
class SafeBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try {
      console.error("[thank-you-upsell] render error", error);
    } catch {
      // ignore — never throw from the boundary itself
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ThankYouUpsell() {
  const api = useApi();
  const settings = useSettings() || {};

  const appUrl = normalizeAppUrl(settings.app_url);
  const titleOverride =
    typeof settings.title_override === "string" &&
    settings.title_override.trim() !== ""
      ? settings.title_override.trim()
      : null;

  const [offer, setOffer] = useState(null);
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "empty"
  const [dismissed, setDismissed] = useState(false);
  const fetchStartedRef = useRef(false);
  const impressionSentRef = useRef(false);
  const sentOrderIdRef = useRef(null);

  // Fetch the offer once. Any failure degrades to "empty" (renders null).
  useEffect(() => {
    if (!appUrl || fetchStartedRef.current) return undefined;
    fetchStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const token = await api?.sessionToken?.get?.();
        if (!token) throw new Error("no session token");

        const body = buildOfferRequestBody(api);
        sentOrderIdRef.current = body.orderId || null;

        let signal;
        try {
          signal = AbortSignal.timeout(10000);
        } catch {
          signal = undefined;
        }

        const response = await fetch(`${appUrl}/api/typ-offer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw new Error(`typ-offer status ${response.status}`);

        const data = await response.json();
        const nextOffer = data && typeof data === "object" ? data.offer : null;
        if (cancelled) return;

        if (
          nextOffer &&
          nextOffer.offerId &&
          nextOffer.product &&
          nextOffer.product.title &&
          nextOffer.checkoutUrl
        ) {
          setOffer(nextOffer);
          setStatus("ready");
        } else {
          setStatus("empty");
        }
      } catch (error) {
        try {
          console.error("[thank-you-upsell] offer fetch failed", error);
        } catch {
          // ignore
        }
        if (!cancelled) setStatus("empty");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, appUrl]);

  // Impression event — once, when the offer becomes visible. Fire-and-forget.
  useEffect(() => {
    if (status !== "ready" || !offer || dismissed || impressionSentRef.current) {
      return;
    }
    impressionSentRef.current = true;
    void postEvent(api, appUrl, {
      referenceId: referenceIdFor(offer, sentOrderIdRef.current),
      offerId: offer.offerId,
      eventType: "impression",
      currency: offer.currency || undefined,
      surface: "thank_you",
    });
  }, [api, appUrl, status, offer, dismissed]);

  if (!appUrl || dismissed || status === "empty") return null;
  if (status === "loading") return <LoadingCard />;
  if (!offer || !offer.product) return null;

  const product = offer.product;
  const strings =
    offer.strings && typeof offer.strings === "object" ? offer.strings : {};
  const copy = offer.copy && typeof offer.copy === "object" ? offer.copy : {};
  const locale = typeof offer.language === "string" ? offer.language : undefined;
  const currency = typeof offer.currency === "string" ? offer.currency : "EUR";

  const heading =
    titleOverride ||
    firstNonEmpty(copy.headline, strings.thank_you_title, "A little something extra");
  const bodyText = typeof copy.body === "string" ? copy.body : "";
  const bullets = Array.isArray(copy.bullets)
    ? copy.bullets
        .filter((bullet) => typeof bullet === "string" && bullet.trim() !== "")
        .slice(0, 3)
    : [];

  const wasText = formatMoney(product.price, currency, locale);
  const nowText = formatMoney(product.discountedPrice, currency, locale);
  const pct = Math.round(Number(offer.discountPct) || 0);
  const hasDiscount =
    (Number(offer.discountPct) || 0) > 0 &&
    Number(product.discountedPrice) < Number(product.price);
  const saveText =
    pct > 0 ? tpl(firstNonEmpty(strings.save_pct, "Save {pct}%"), { pct }) : "";
  const code =
    typeof offer.discountCode === "string" ? offer.discountCode.trim() : "";
  const codeNote = code
    ? tpl(
        firstNonEmpty(
          strings.thank_you_code_note,
          "Code {code} — applied automatically at checkout",
        ),
        { code },
      )
    : "";
  const ctaLabel = firstNonEmpty(strings.thank_you_cta, "Claim this offer");
  const declineLabel = firstNonEmpty(strings.decline, "No thanks");

  const handleAccept = () => {
    void postEvent(api, appUrl, {
      referenceId: referenceIdFor(offer, sentOrderIdRef.current),
      offerId: offer.offerId,
      eventType: "accepted",
      revenue: Number(product.discountedPrice) || 0,
      currency,
      surface: "thank_you",
    });
  };

  const handleDecline = () => {
    void postEvent(api, appUrl, {
      referenceId: referenceIdFor(offer, sentOrderIdRef.current),
      offerId: offer.offerId,
      eventType: "declined",
      currency,
      surface: "thank_you",
    });
    setDismissed(true);
  };

  return (
    <View border="base" cornerRadius="base" padding="base">
      <BlockStack spacing="base">
        <Heading level={2}>{heading}</Heading>
        <InlineLayout columns={[96, "fill"]} spacing="base" blockAlignment="start">
          {product.image ? (
            <Image
              source={product.image}
              accessibilityDescription={product.title}
              cornerRadius="base"
              aspectRatio={1}
              fit="cover"
            />
          ) : (
            <View border="base" cornerRadius="base" />
          )}
          <BlockStack spacing="extraTight">
            <Text emphasis="bold">{product.title}</Text>
            {bodyText ? <Text appearance="subdued">{bodyText}</Text> : null}
            {bullets.map((bullet, index) => (
              <Text key={index} size="small" appearance="subdued">
                {`• ${bullet}`}
              </Text>
            ))}
            {hasDiscount && nowText ? (
              <InlineLayout
                columns={["auto", "auto", "fill"]}
                spacing="tight"
                blockAlignment="center"
              >
                {wasText ? (
                  <Text appearance="subdued" accessibilityRole="deletion">
                    {`${firstNonEmpty(strings.was, "Was")} ${wasText}`}
                  </Text>
                ) : (
                  <View />
                )}
                <Text emphasis="bold">
                  {`${firstNonEmpty(strings.now, "Now")} ${nowText}`}
                </Text>
                {saveText ? (
                  <Text size="small" appearance="subdued">
                    {saveText}
                  </Text>
                ) : (
                  <View />
                )}
              </InlineLayout>
            ) : nowText || wasText ? (
              <Text emphasis="bold">{nowText || wasText}</Text>
            ) : null}
          </BlockStack>
        </InlineLayout>
        {codeNote ? (
          <Banner status="success">
            <Text size="small">{codeNote}</Text>
          </Banner>
        ) : null}
        <BlockStack spacing="tight">
          <Link to={offer.checkoutUrl} external onPress={handleAccept}>
            <View
              border="base"
              cornerRadius="base"
              padding="base"
              inlineAlignment="center"
            >
              <Text emphasis="bold">{ctaLabel}</Text>
            </View>
          </Link>
          <BlockStack spacing="none" inlineAlignment="center">
            <Link onPress={handleDecline}>
              <Text size="small" appearance="subdued">
                {declineLabel}
              </Text>
            </Link>
          </BlockStack>
        </BlockStack>
      </BlockStack>
    </View>
  );
}

/** Skeleton card shown while the offer request is in flight. */
function LoadingCard() {
  return (
    <View border="base" cornerRadius="base" padding="base">
      <BlockStack spacing="base">
        <SkeletonText inlineSize="small" />
        <InlineLayout columns={[96, "fill"]} spacing="base" blockAlignment="start">
          <SkeletonImage aspectRatio={1} />
          <BlockStack spacing="tight">
            <SkeletonText inlineSize="large" />
            <SkeletonText inlineSize="large" />
            <SkeletonText inlineSize="small" />
          </BlockStack>
        </InlineLayout>
      </BlockStack>
    </View>
  );
}

/**
 * Build the POST body for /api/typ-offer from whatever the thank-you API
 * exposes. Every field is optional and read defensively — missing pieces are
 * simply omitted and the backend fills the gaps.
 */
function buildOfferRequestBody(api) {
  const body = {};

  try {
    const orderId = api?.orderConfirmation?.current?.order?.id;
    if (orderId) body.orderId = String(orderId);
  } catch {
    // omit orderId
  }

  try {
    const lines = api?.lines?.current;
    if (Array.isArray(lines) && lines.length > 0) {
      const lineItems = lines
        .map((line) => ({
          productId: line?.merchandise?.product?.id ?? null,
          variantId: line?.merchandise?.id ?? null,
          quantity: Number(line?.quantity ?? 1) || 1,
        }))
        .filter((line) => line.productId || line.variantId);
      if (lineItems.length > 0) body.lineItems = lineItems;
    }
  } catch {
    // omit lineItems
  }

  try {
    const total = api?.cost?.totalAmount?.current;
    if (total) {
      const amount = Number(total.amount);
      if (Number.isFinite(amount)) body.totalAmount = amount;
      if (total.currencyCode) body.currency = String(total.currencyCode);
    }
  } catch {
    // omit totals
  }

  try {
    const language = api?.localization?.language?.current?.isoCode;
    if (language) body.locale = String(language);
  } catch {
    // omit locale
  }

  try {
    const country = api?.localization?.country?.current?.isoCode;
    if (country) body.countryCode = String(country);
  } catch {
    // omit countryCode
  }

  try {
    const customerId = api?.buyerIdentity?.customer?.current?.id;
    if (customerId) body.customerId = String(customerId);
  } catch {
    // omit customerId
  }

  return body;
}

/**
 * Fire-and-forget analytics event to /api/events. Never throws.
 */
async function postEvent(api, appUrl, payload) {
  try {
    if (!appUrl) return;
    const token = await api?.sessionToken?.get?.();
    if (!token) return;
    await fetch(`${appUrl}/api/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // fire-and-forget — analytics must never affect the thank-you page
  }
}

/**
 * The backend returns the exact referenceId it issued the offer under — use
 * it verbatim. Only when it is missing (older server), fall back to the old
 * local reconstruction: `typ:<orderId>` when we sent an order id, else the
 * offer id so events still carry a stable, non-empty reference.
 */
function referenceIdFor(offer, sentOrderId) {
  if (
    offer &&
    typeof offer.referenceId === "string" &&
    offer.referenceId !== ""
  ) {
    return offer.referenceId;
  }
  if (sentOrderId) return `typ:${sentOrderId}`;
  return `typ:${offer && offer.offerId ? offer.offerId : "unknown"}`;
}

/** Trim, add https:// when missing, and strip trailing slashes. */
function normalizeAppUrl(raw) {
  if (typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/** First argument that is a non-empty string (else ""). */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/** Replace `{key}` placeholders in a template string. */
function tpl(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    vars && vars[key] != null ? String(vars[key]) : match,
  );
}

/** Locale-aware currency formatting with a plain-text fallback. */
function formatMoney(amount, currency, locale) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    try {
      return `${value.toFixed(2)} ${currency || ""}`.trim();
    } catch {
      return "";
    }
  }
}
