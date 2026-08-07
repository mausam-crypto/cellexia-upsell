// ─────────────────────────────────────────────────────────────────────────────
// PostPurchasePreview — buyer-faithful replica of the post-purchase upsell
// page rendered by extensions/post-purchase-upsell/src/index.jsx.
//
// Plain JSX + inline styles on purpose: the real page lives in Shopify's
// checkout chrome, not Polaris, so the replica must not inherit admin styling.
// It is purely visual — buttons are inert, the countdown is a static reading,
// and no analytics events fire. When the extension layout changes, mirror the
// change here (section order, strings usage and price math are copied 1:1).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { DEFAULT_UI_STRINGS_EN } from "../types";
import type { OfferPage, OfferResponse } from "../types";

export interface PostPurchasePreviewProps {
  response: OfferResponse;
  device: "mobile" | "desktop";
}

// Inline English fallbacks — same safety net the extension carries, so a
// missing UiString row can never blank out a label in the preview either.
// Sourced from the canonical contract constant (em-dash-free) so this replica
// can never drift from the seeded strings; the extension keeps a hand copy
// only because it cannot import app code.
const FALLBACK_STRINGS: Record<string, string> = DEFAULT_UI_STRINGS_EN;

// Checkout-like palette (matches the tones the post-purchase UI kit renders).
const FONT =
  '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const COLOR_TEXT = "#202223";
const COLOR_SUBDUED = "#6d7175";
const COLOR_CRITICAL = "#d72c0d";
const COLOR_SUCCESS = "#108043";
const COLOR_LINK = "#2c6ecb";
const COLOR_BORDER = "#e1e3e5";
const CALLOUT_BG = "#eaf4fa";
const PAGE_BG = "#fafafa";

// ── Helpers (copied from the extension so preview math matches production) ──

/** Localized string lookup with English fallback and {var} interpolation. */
function t(
  strings: Record<string, string>,
  key: string,
  vars?: Record<string, string | number>,
): string {
  let template =
    (typeof strings[key] === "string" && strings[key]) ||
    FALLBACK_STRINGS[key] ||
    key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      template = template.split(`{${name}}`).join(String(value));
    }
  }
  return template;
}

function toAmount(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Currency formatting with a plain-text fallback when Intl rejects inputs.
 * Formats with the RESPONSE currency (EUR/USD/CAD/JPY…), so simulated-market
 * previews render real symbols ($, CA$, €) exactly as Intl localizes them.
 * The response language is tried first, then plain English — a malformed
 * locale tag alone must not degrade prices to the bare "12.34 USD" form.
 * Identical output to the extension's formatMoney for all valid inputs.
 */
function formatMoney(amount: unknown, currency: string, locale: string): string {
  const n = toAmount(amount);
  const code = (currency || "EUR").toUpperCase();
  for (const loc of [locale || "en", "en"]) {
    try {
      return new Intl.NumberFormat(loc, {
        style: "currency",
        currency: code,
      }).format(n);
    } catch {
      // invalid locale tag or currency code — try the next candidate
    }
  }
  return `${n.toFixed(2)} ${currency || ""}`.trim();
}

/** Seconds → "mm:ss". */
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function cleanStrings(items: string[] | undefined): string[] {
  return (items ?? []).filter(
    (item) => typeof item === "string" && item.trim().length > 0,
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────

function SeparatorLine() {
  return (
    <hr
      style={{
        border: "none",
        borderTop: `1px solid ${COLOR_BORDER}`,
        margin: 0,
        width: "100%",
      }}
    />
  );
}

function ProductImage({
  src,
  alt,
  height,
}: {
  src: string | null;
  alt: string;
  height?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={{
          display: "block",
          width: "100%",
          maxWidth: "100%",
          height: height ?? "auto",
          objectFit: "cover",
          borderRadius: 8,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: "100%",
        height: height ?? 220,
        borderRadius: 8,
        background: "#f1f2f4",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: COLOR_SUBDUED,
        fontSize: 13,
      }}
    >
      {alt || "No image"}
    </div>
  );
}

function PriceRow({
  strings,
  currency,
  locale,
  wasAmount,
  nowAmount,
  discountPct,
  showWas,
}: {
  strings: Record<string, string>;
  currency: string;
  locale: string;
  wasAmount: number;
  nowAmount: number;
  discountPct: number;
  showWas: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      {showWas ? (
        <span
          style={{
            textDecoration: "line-through",
            color: COLOR_SUBDUED,
            fontSize: 16,
          }}
        >
          {`${t(strings, "was")} ${formatMoney(wasAmount, currency, locale)}`}
        </span>
      ) : null}
      <span style={{ color: COLOR_CRITICAL, fontWeight: 600, fontSize: 18 }}>
        {`${t(strings, "now")} ${formatMoney(nowAmount, currency, locale)}`}
      </span>
      {discountPct > 0 ? (
        <span style={{ color: COLOR_SUCCESS, fontWeight: 600, fontSize: 13 }}>
          {t(strings, "save_pct", { pct: discountPct })}
        </span>
      ) : null}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function PostPurchasePreview({ response, device }: PostPurchasePreviewProps) {
  const [pageIndex, setPageIndex] = useState(0);

  const offers: OfferPage[] = Array.isArray(response.offers) ? response.offers : [];
  if (offers.length === 0) return null;

  const isMobile = device === "mobile";
  const safeIndex = Math.min(Math.max(0, pageIndex), offers.length - 1);
  const offer = offers[safeIndex];
  const strings = response.strings ?? {};
  const ui = response.ui;
  const currency = response.currency || "EUR";
  const locale = response.language || "en";
  // No dir/RTL handling on purpose: the shipped extension has none, and the
  // replica must match it — RTL parity is deferred until the extension itself
  // implements it.

  const totalPages = offers.length;
  const pageNumber = safeIndex + 1;
  const products = offer.products;
  const copy = offer.copy ?? { headline: "", body: "", bullets: [] };
  const bullets = cleanStrings(copy.bullets);
  const paragraphs = cleanStrings(copy.paragraphs);
  const proof = cleanStrings(copy.proof);
  const closer =
    typeof copy.closer === "string" && copy.closer.trim().length > 0
      ? copy.closer
      : null;

  const discountPct = Math.round(toAmount(offer.discountPct));
  const showComparePrice = ui.showComparePrice !== false;
  const isBundle = response.displayMode === "bundle" && products.length > 1;

  // price/discountedPrice arrive already in the response DISPLAY currency
  // (presentment-converted server-side when a market/rate applies), so the
  // was/now/save row sums payload values as-is — no client-side conversion.
  const originalTotal = round2(
    products.reduce((sum, p) => sum + toAmount(p.price), 0),
  );
  const nowTotal = round2(
    products.reduce((sum, p) => sum + toAmount(p.discountedPrice), 0),
  );

  // Static countdown reading — the live page ticks down from the configured
  // minutes; "-2s" shows a mid-flight value (10 min → "09:58"), not a reset.
  const countdownMinutes =
    Number.isFinite(ui.countdownMinutes) && ui.countdownMinutes > 0
      ? ui.countdownMinutes
      : 10;
  const clockText = formatClock(Math.round(countdownMinutes * 60) - 2);

  // ── Shared blocks (order copied from the extension) ────────────────────────

  const callout = (
    <div style={{ background: CALLOUT_BG, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: COLOR_TEXT }}>
        {t(strings, "offer_badge")}
      </div>
      {totalPages > 1 ? (
        <div style={{ fontSize: 13, color: COLOR_SUBDUED, marginTop: 2 }}>
          {t(strings, "offer_x_of_y", { x: pageNumber, y: totalPages })}
        </div>
      ) : null}
    </div>
  );

  const bulletsBlock =
    bullets.length > 0 ? (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {bullets.map((bullet, i) => (
          <p key={i} style={{ margin: 0, fontSize: 14, color: COLOR_SUBDUED }}>
            {`• ${bullet}`}
          </p>
        ))}
      </div>
    ) : null;

  const trustAndCountdown = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p style={{ margin: 0, fontSize: 12, color: COLOR_SUBDUED }}>
        {t(strings, "ships_free")}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: COLOR_SUBDUED }}>
        {t(strings, "one_click_note")}
      </p>
      {ui.showCountdown ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-start",
            background: "#f6f6f7",
            border: `1px solid ${COLOR_BORDER}`,
            borderRadius: 999,
            padding: "3px 12px",
            marginTop: 4,
            fontSize: 12,
          }}
        >
          <span style={{ color: COLOR_SUBDUED }}>{t(strings, "time_left")}</span>
          <span
            style={{
              fontWeight: 600,
              color: COLOR_TEXT,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {clockText}
          </span>
        </span>
      ) : null}
    </div>
  );

  const closerLine = closer ? (
    <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: COLOR_TEXT }}>
      {closer}
    </p>
  ) : null;

  // The real extension button renders only the string — no price suffix.
  const acceptLabel = t(strings, isBundle ? "add_all_to_order" : "add_to_order");
  const actionButtons = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        style={{
          width: "100%",
          background: "#202223",
          color: "#ffffff",
          border: "none",
          borderRadius: 6,
          padding: "14px 20px",
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "default",
        }}
      >
        {acceptLabel}
      </button>
      <button
        type="button"
        style={{
          width: "100%",
          background: "transparent",
          color: COLOR_LINK,
          border: "none",
          padding: "10px 12px",
          fontSize: 14,
          fontFamily: "inherit",
          cursor: "default",
        }}
      >
        {t(strings, "decline")}
      </button>
    </div>
  );

  // Long-copy deep dive — below the CTA, exactly like the extension: separator,
  // "Why it works with your order" + paragraphs, then the research sub-heading
  // with the proof statements as bullets.
  const whyItWorks =
    paragraphs.length > 0 || proof.length > 0 ? (
      <div
        style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}
      >
        <SeparatorLine />
        {/* Heading renders unconditionally inside this section, matching the
            extension — it gives the research block context even when there
            are no paragraphs. */}
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: COLOR_TEXT }}>
          {t(strings, "why_it_works")}
        </p>
        {paragraphs.map((paragraph, i) => (
          <p key={i} style={{ margin: 0, fontSize: 13, color: COLOR_TEXT }}>
            {paragraph}
          </p>
        ))}
        {proof.length > 0 ? (
          <>
            <p
              style={{
                margin: 0,
                marginTop: paragraphs.length > 0 ? 4 : 0,
                fontSize: 13,
                fontWeight: 600,
                color: COLOR_SUBDUED,
              }}
            >
              {t(strings, "research_shows")}
            </p>
            {proof.map((line, i) => (
              <p key={i} style={{ margin: 0, fontSize: 13, color: COLOR_SUBDUED }}>
                {`• ${line}`}
              </p>
            ))}
          </>
        ) : null}
      </div>
    ) : null;

  const headlineBlock = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 21,
          lineHeight: 1.3,
          fontWeight: 600,
          color: COLOR_TEXT,
        }}
      >
        {copy.headline}
      </h2>
      <p style={{ margin: 0, fontSize: 14, color: COLOR_TEXT }}>{copy.body}</p>
    </div>
  );

  // ── Page variants ──────────────────────────────────────────────────────────

  let pageContent: ReactNode;
  if (isBundle) {
    // Bundle: product tile row + combined copy + one accept-all button.
    pageContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {callout}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.min(products.length, 3)}, 1fr)`,
            gap: isMobile ? 10 : 16,
          }}
        >
          {products.map((product) => (
            <div
              key={product.variantId || product.productId}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                textAlign: "center",
              }}
            >
              <ProductImage
                src={product.image}
                alt={product.title}
                height={isMobile ? 96 : 140}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLOR_TEXT }}>
                {product.title}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
                {showComparePrice ? (
                  <span
                    style={{
                      textDecoration: "line-through",
                      color: COLOR_SUBDUED,
                      fontSize: 12,
                    }}
                  >
                    {formatMoney(product.price, currency, locale)}
                  </span>
                ) : null}
                <span
                  style={{ color: COLOR_CRITICAL, fontWeight: 600, fontSize: 13 }}
                >
                  {formatMoney(product.discountedPrice, currency, locale)}
                </span>
              </span>
            </div>
          ))}
        </div>
        <SeparatorLine />
        {headlineBlock}
        {bulletsBlock}
        <SeparatorLine />
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
        {closerLine}
        {actionButtons}
        {whyItWorks}
      </div>
    );
  } else {
    // Sequential: image left / content right on desktop, stacked on mobile.
    const product = products[0];
    pageContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {callout}
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: isMobile ? 16 : 38,
            alignItems: "flex-start",
          }}
        >
          <div style={{ flex: isMobile ? undefined : "1 1 55%", width: "100%" }}>
            <ProductImage src={product.image} alt={product.title} />
          </div>
          <div
            style={{
              flex: isMobile ? undefined : "1 1 45%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {headlineBlock}
            {bulletsBlock}
            <SeparatorLine />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: COLOR_TEXT }}>
                {product.title}
              </span>
              <PriceRow
                strings={strings}
                currency={currency}
                locale={locale}
                wasAmount={originalTotal}
                nowAmount={nowTotal}
                discountPct={discountPct}
                showWas={showComparePrice}
              />
            </div>
            {trustAndCountdown}
            {closerLine}
            {actionButtons}
          </div>
        </div>
        {whyItWorks}
      </div>
    );
  }

  const card = (
    <div
      style={{
        background: "#ffffff",
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 8,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        padding: isMobile ? 16 : 24,
        fontFamily: FONT,
        color: COLOR_TEXT,
        fontSize: 14,
        lineHeight: 1.5,
        boxSizing: "border-box",
      }}
    >
      {pageContent}
    </div>
  );

  // ── Preview-only pager (not part of the buyer page) ────────────────────────

  const pagerButton: CSSProperties = {
    border: "1px solid #c9cccf",
    borderRadius: 6,
    background: "#ffffff",
    color: COLOR_TEXT,
    padding: "4px 12px",
    fontSize: 12,
    fontFamily: FONT,
    cursor: "pointer",
  };
  const pager =
    totalPages > 1 ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          marginBottom: 12,
          fontFamily: FONT,
        }}
      >
        <button
          type="button"
          style={{ ...pagerButton, opacity: safeIndex === 0 ? 0.4 : 1 }}
          disabled={safeIndex === 0}
          onClick={() => setPageIndex(safeIndex - 1)}
        >
          ‹ Previous
        </button>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          {offers.map((page, i) => (
            <button
              key={page.offerId}
              type="button"
              aria-label={`Go to offer ${i + 1}`}
              onClick={() => setPageIndex(i)}
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                border: "none",
                padding: 0,
                cursor: "pointer",
                background: i === safeIndex ? COLOR_TEXT : "#c9cccf",
              }}
            />
          ))}
        </span>
        <span style={{ fontSize: 12, color: COLOR_SUBDUED }}>
          {`Offer ${pageNumber} of ${totalPages}`}
        </span>
        <button
          type="button"
          style={{
            ...pagerButton,
            opacity: safeIndex + 1 >= totalPages ? 0.4 : 1,
          }}
          disabled={safeIndex + 1 >= totalPages}
          onClick={() => setPageIndex(safeIndex + 1)}
        >
          Next ›
        </button>
      </div>
    ) : null;

  // ── Device chrome: gray checkout page, optional phone frame ────────────────

  return (
    <div>
      {pager}
      <div
        style={{
          background: PAGE_BG,
          border: "1px solid #ebebeb",
          borderRadius: 12,
          padding: isMobile ? "28px 12px" : 32,
          display: "flex",
          justifyContent: "center",
        }}
      >
        {isMobile ? (
          <div
            style={{
              width: 390,
              maxWidth: "100%",
              boxSizing: "border-box",
              border: "1px solid #d0d3d8",
              borderRadius: 32,
              padding: "18px 10px",
              background: "#ffffff",
              boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
            }}
          >
            <div
              style={{
                width: 110,
                height: 5,
                borderRadius: 999,
                background: COLOR_BORDER,
                margin: "0 auto 14px",
              }}
            />
            <div
              style={{
                background: PAGE_BG,
                borderRadius: 18,
                padding: 12,
                maxHeight: 760,
                overflowY: "auto",
              }}
            >
              {card}
            </div>
          </div>
        ) : (
          <div style={{ width: "100%", maxWidth: 572 }}>{card}</div>
        )}
      </div>
    </div>
  );
}
