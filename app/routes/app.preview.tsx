// ─────────────────────────────────────────────────────────────────────────────
// Preview — see exactly what a buyer sees after checkout.
//
// The merchant builds a fake basket, picks a country + language, and the page
// runs the REAL pipeline (selectOffers → generateCopy → assembleOfferResponse)
// under a throwaway "preview:" referenceId, then renders the response through
// PostPurchasePreview — a faithful replica of the post-purchase extension
// layout. IssuedOffer rows created by the preview are always deleted so the
// preview never pollutes analytics or the sign-changeset table.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  Combobox,
  Divider,
  Icon,
  InlineStack,
  Layout,
  Listbox,
  Page,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, SearchIcon } from "@shopify/polaris-icons";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings } from "../services/settings.server";
import {
  assembleOfferResponse,
  type AssembleOfferOptions,
  type LanguageSource,
  type PageCopyDiagnostic,
} from "../services/offer-orchestrator.server";
import {
  LANGUAGE_LABELS,
  type OfferResponse,
  type PurchaseContext,
  type PurchaseLineItem,
} from "../types";
import { PostPurchasePreview } from "../components/PostPurchasePreview";

// Countries the store commonly sells to — merged with every country present in
// the shop's MarketSetting rows so any configured market can be simulated.
const COMMON_COUNTRIES = [
  "FR", "DE", "US", "GB", "ES", "IT", "NL", "BE", "CH", "AT",
  "SE", "DK", "NO", "FI", "PT", "PL", "IE", "CA", "AU", "JP",
  "AE", "GR", "HU", "RO",
];

const MAX_QTY = 99;

/** The subset of a CachedVariant the picker needs (parsed from variantsJson). */
interface VariantLite {
  id: string;
  price: number;
  inventoryQuantity: number | null;
  imageUrl: string | null;
}

interface PickerProduct {
  productId: string;
  variantId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  productType: string;
}

/** First in-stock variant (untracked counts as in stock), else first variant. */
function primaryVariant(variantsJson: string): VariantLite | null {
  const variants = jparse<VariantLite[]>(variantsJson, []);
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const inStock = variants.find(
    (v) => v && (v.inventoryQuantity === null || v.inventoryQuantity > 0),
  );
  return inStock ?? variants[0] ?? null;
}

// ── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, rows, markets] = await Promise.all([
    getSettings(shop),
    // "ACTIVE" < "ARCHIVED" < "DRAFT" alphabetically, so status asc puts the
    // sellable products first inside the 250-product cap.
    prisma.productCache.findMany({
      where: { shop },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      take: 250,
    }),
    prisma.marketSetting.findMany({ where: { shop } }),
  ]);

  const products: PickerProduct[] = [];
  for (const row of rows) {
    const variant = primaryVariant(row.variantsJson);
    if (!variant) continue; // unpriceable — cannot participate in a basket
    products.push({
      productId: row.productId,
      variantId: variant.id,
      title: row.title,
      price: Number.isFinite(Number(variant.price)) ? Number(variant.price) : 0,
      imageUrl: variant.imageUrl ?? row.imageUrl,
      productType: row.productType,
    });
  }

  const countrySet = new Set<string>(COMMON_COUNTRIES);
  for (const market of markets) {
    for (const code of jparse<string[]>(market.countriesJson, [])) {
      const cc = String(code).trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(cc)) countrySet.add(cc);
    }
  }
  // FR pinned first (EUR-default French store), the rest alphabetical.
  const countries = [...countrySet].sort((a, b) =>
    a === "FR" ? -1 : b === "FR" ? 1 : a.localeCompare(b),
  );

  return json({
    products,
    languages: settings.languages,
    defaultLanguage: settings.defaultLanguage,
    countries,
    // Market simulation choices for the primary "Market" select. countries
    // are pre-cleaned so every market's first country is guaranteed to exist
    // in the country select above (the loader merges them into countrySet).
    markets: markets
      .map((m) => ({
        handle: m.marketHandle,
        name: m.name,
        currency: (m.currency || "").trim().toUpperCase(),
        countries: jparse<string[]>(m.countriesJson, [])
          .map((c) => String(c).trim().toUpperCase())
          .filter((c) => /^[A-Z]{2}$/.test(c)),
        enabled: m.enabled,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    aiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    aiEnabled: settings.aiEnabled,
  });
};

// ── Action ──────────────────────────────────────────────────────────────────

interface GenerateResult {
  response: OfferResponse;
  latencyMs: number;
  offerCount: number;
  /** Model of the prompt template the copy path used (null = unknown). */
  model: string | null;
  aiKeySet: boolean;
  aiEnabled: boolean;
  regenerated: boolean;
  /** Monotonic-enough key so the client can reset the pager per generation. */
  generatedAt: number;
  /** True per-page copy provenance from the engine (ai/cache/fallback/reused). */
  diagnostics: PageCopyDiagnostic[];
  /**
   * How the orchestrator chose the response language — out-param read back
   * from AssembleOfferOptions after the call. Null only when the engine
   * failed before language resolution (it never throws on the public path,
   * so the preview still renders; the chip is simply hidden).
   */
  languageResolution: { language: string; source: LanguageSource } | null;
  /**
   * Market/currency simulation summary for the result header chips.
   * marketName is the market resolved from the shipping country (same
   * first-match-by-country logic as the orchestrator) regardless of whether
   * presentment was simulated. rate is the ctx.presentmentRate the action
   * passed to the engine — null means no simulation ran and prices are plain
   * shop-currency amounts. rateIsDefault flags the 1.0 fallback used when
   * the market has no preview FX rate configured yet. pricingSource is the
   * engine's out-param: "contextual" = real per-country Shopify prices were
   * used and the FX rate was NOT applied; "fx" = converted base prices;
   * "shop" = plain shop-currency prices.
   */
  presentment: {
    marketName: string | null;
    rate: number | null;
    rateIsDefault: boolean;
    pricingSource: "contextual" | "fx" | "shop" | null;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const fail = (message: string, status = 200) =>
    json({ ok: false as const, message, result: null }, { status });

  if (intent !== "generate") return fail("Unknown action.", 400);

  // Throwaway reference — unique per click, so the orchestrator's per-
  // referenceId offer reuse never kicks in and every Generate is a fresh run.
  const referenceId = `preview:${crypto.randomUUID()}`;
  try {
    const settings = await getSettings(shop);

    // Passed through UNCLAMPED as ctx.locale — the orchestrator's
    // resolveLanguageWithSource genuinely decides, so the market-override and
    // store-default chips are reachable (e.g. via the "zz" simulate option).
    const requestedLanguage = String(formData.get("language") ?? "");
    const countryRaw = String(formData.get("countryCode") ?? "").trim().toUpperCase();
    const countryCode = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null;
    const marketHandle = String(formData.get("marketHandle") ?? "").trim();
    const regenerate = String(formData.get("regenerate") ?? "") === "1";

    // Market simulation. The MarketSetting row is re-read server-side (the
    // client only names a handle, never currency or rate); an unknown/stale
    // handle simply degrades to a plain country preview.
    const marketRows = await prisma.marketSetting.findMany({ where: { shop } });
    const simulatedMarket = marketHandle
      ? marketRows.find((m) => m.marketHandle === marketHandle) ?? null
      : null;

    // Keep the country consistent with the simulated market: if the submitted
    // country is not one of the market's countries (stale client state), snap
    // to the market's first country — the value the Market select applies.
    let effectiveCountry = countryCode;
    if (simulatedMarket) {
      const marketCountries = jparse<string[]>(simulatedMarket.countriesJson, [])
        .map((c) => String(c).trim().toUpperCase())
        .filter((c) => /^[A-Z]{2}$/.test(c));
      if (!effectiveCountry || !marketCountries.includes(effectiveCountry)) {
        effectiveCountry = marketCountries[0] ?? effectiveCountry;
      }
    }

    // Simulated presentment: the display currency comes from the market when
    // synced; the rate is the merchant-set preview FX rate, defaulting to 1
    // (flagged as the default in the result header). Currency and rate travel
    // as a pair — a market with no synced currency simulates nothing rather
    // than converting amounts that would still be labelled in shop currency.
    const presentmentCurrency = simulatedMarket?.currency?.trim().toUpperCase() || null;
    const presentmentRate = presentmentCurrency
      ? simulatedMarket?.previewFxRate ?? 1
      : null;

    // Resolved the way the orchestrator resolves it (first market whose
    // country list contains the shipping country) — differs from the selected
    // market only in the "No market" case where the chosen country happens to
    // belong to one; the chip then shows the market that actually applied.
    const resolvedMarket = effectiveCountry
      ? marketRows.find((m) =>
          jparse<string[]>(m.countriesJson, []).some(
            (c) => String(c).trim().toUpperCase() === effectiveCountry,
          ),
        ) ?? null
      : null;

    // Re-derive prices/variants server-side from the catalog cache — the
    // client only names products and quantities, never money.
    const rawBasket = jparse<unknown>(String(formData.get("basket") ?? "[]"), []);
    const picks: Array<{ productId: string; quantity: number }> = [];
    if (Array.isArray(rawBasket)) {
      for (const item of rawBasket) {
        if (!item || typeof item !== "object") continue;
        const productId = String((item as { productId?: unknown }).productId ?? "");
        if (!productId.startsWith("gid://")) continue;
        const qty = Math.floor(Number((item as { quantity?: unknown }).quantity));
        picks.push({
          productId,
          quantity: Number.isFinite(qty) ? Math.min(Math.max(qty, 1), MAX_QTY) : 1,
        });
      }
    }
    if (picks.length === 0) {
      return fail("Pick at least one product for the test order.");
    }

    const rows = await prisma.productCache.findMany({
      where: { shop, productId: { in: picks.map((p) => p.productId) } },
    });
    const rowById = new Map(rows.map((row) => [row.productId, row]));
    const lineItems: PurchaseLineItem[] = [];
    let totalAmount = 0;
    for (const pick of picks) {
      const row = rowById.get(pick.productId);
      if (!row) continue;
      const variant = primaryVariant(row.variantsJson);
      const price =
        variant && Number.isFinite(Number(variant.price)) ? Number(variant.price) : null;
      lineItems.push({
        productId: row.productId,
        variantId: variant?.id ?? null,
        quantity: pick.quantity,
        priceAmount: price,
        title: row.title,
      });
      if (price !== null) totalAmount += price * pick.quantity;
    }
    if (lineItems.length === 0) {
      return fail(
        "None of the picked products are in the catalog cache anymore — reload the page and rebuild the basket.",
      );
    }
    totalAmount = Math.round(totalAmount * 100) / 100;

    if (regenerate) {
      // "Regenerate copy" wipes the WHOLE copy cache for this shop. Deliberate
      // tradeoff: generateCopy's bypassCache flag is not reachable through
      // assembleOfferResponse (and we must not touch the orchestrator), and
      // CopyCache rows are cheap — they simply regenerate on demand for the
      // next buyer. Scoping the delete tighter would require re-deriving the
      // sha256 cache key (mode × variants × basket × language × prompt
      // version) here, duplicating ai.server internals.
      await prisma.copyCache.deleteMany({ where: { shop } });
    }

    const ctx: PurchaseContext = {
      shop,
      referenceId,
      customerId: null, // frequency caps never apply to previews
      countryCode: effectiveCountry,
      locale: requestedLanguage,
      currency: "EUR", // shop currency — catalog prices/tiers are EUR amounts
      totalAmount,
      lineItems,
      surface: "post_purchase",
      // Simulated buyer-facing display currency + rate (engine math stays in
      // shop currency; live buyers get the rate implied by their own order).
      presentmentCurrency,
      presentmentRate,
    };

    const started = Date.now();
    // Admin preview: wait for REAL AI copy (30s) instead of the 3.5s buyer
    // budget — long-form generation takes ~5-10s cold, so the buyer timeout
    // would show fallback copy on almost every cold-cache preview. Buyers hit
    // the strict budget + background cache warming instead; this tool's job
    // is to show what warmed copy looks like. diagnostics receives the true
    // per-page provenance (ai / cache / fallback / reused).
    const diagnostics: PageCopyDiagnostic[] = [];
    // Named options object (not an inline literal) so the orchestrator's
    // languageResolution out-param can be read back after the call.
    const options: AssembleOfferOptions = {
      copyTimeoutMs: 30_000,
      diagnostics,
    };
    const response = await assembleOfferResponse(ctx, options);
    const latencyMs = Date.now() - started;

    // The orchestrator does not expose which prompt template ran — re-derive
    // the mode the same way buildOfferPage does and report that template's
    // model as a best-effort hint.
    const mode =
      response.displayMode === "bundle" &&
      (response.offers[0]?.products.length ?? 0) > 1
        ? "bundle"
        : response.offers.length > 1
          ? "sequential"
          : "single";
    let model: string | null = settings.aiModel ?? null;
    try {
      const template = await prisma.promptTemplate.findUnique({
        where: { shop_key: { shop, key: mode } },
      });
      if (template?.model) model = template.model;
    } catch {
      // keep the settings default
    }

    const result: GenerateResult = {
      response,
      latencyMs,
      offerCount: response.offers.length,
      model,
      aiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
      aiEnabled: settings.aiEnabled,
      regenerated: regenerate,
      generatedAt: Date.now(),
      diagnostics,
      languageResolution: options.languageResolution ?? null,
      presentment: {
        marketName: resolvedMarket?.name ?? null,
        rate: presentmentRate,
        rateIsDefault:
          presentmentRate !== null && simulatedMarket?.previewFxRate == null,
        pricingSource: options.pricingSource ?? null,
      },
    };
    return json({ ok: true as const, message: "", result });
  } catch (error) {
    console.error("[preview] generation failed", error);
    return fail("Preview generation failed — check the server logs.");
  } finally {
    // The preview must NEVER leave IssuedOffer rows behind: they would sit in
    // the sign-changeset lookup table (and count toward nothing useful) until
    // expiry. referenceId is unique per click, so this only touches our rows.
    try {
      await prisma.issuedOffer.deleteMany({ where: { shop, referenceId } });
    } catch (cleanupError) {
      console.error("[preview] IssuedOffer cleanup failed", cleanupError);
    }
  }
};

// ── UI helpers ──────────────────────────────────────────────────────────────

function formatEur(amount: number): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} EUR`;
  }
}

function countryLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** Badge presentation for each language-resolution source. */
const LANGUAGE_SOURCE_META: Record<
  LanguageSource,
  { label: string; tone: "success" | "warning" | "info" }
> = {
  buyer_locale: { label: "Buyer locale", tone: "success" },
  market_override: { label: "Market override", tone: "warning" },
  store_default: { label: "Store default", tone: "info" },
};

/** Tiny-text label per copy source for the per-page provenance strip. */
const PAGE_SOURCE_LABELS: Record<PageCopyDiagnostic["source"], string> = {
  ai: "fresh AI",
  cache: "cached",
  fallback: "fallback",
  reused: "reused",
  no_discount_fallback: "fallback (no discount)",
};

interface BasketLine {
  productId: string;
  quantity: number;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PreviewPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const generating =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "generate";

  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  // "" = no market (store default) — the free country select is the driver.
  const [market, setMarket] = useState("");
  const [country, setCountry] = useState(data.countries[0] ?? "FR");
  const [language, setLanguage] = useState(
    data.defaultLanguage || data.languages[0] || "en",
  );
  const [regenerate, setRegenerate] = useState(false);
  const [device, setDevice] = useState<"mobile" | "desktop">("desktop");

  const productById = useMemo(
    () => new Map(data.products.map((p) => [p.productId, p])),
    [data.products],
  );

  const pickerOptions = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const pool = q
      ? data.products.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.productType.toLowerCase().includes(q),
        )
      : data.products;
    return pool.slice(0, 30);
  }, [pickerQuery, data.products]);

  const addProduct = (productId: string) => {
    setBasket((prev) => {
      const existing = prev.find((line) => line.productId === productId);
      if (existing) {
        return prev.map((line) =>
          line.productId === productId
            ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QTY) }
            : line,
        );
      }
      return [...prev, { productId, quantity: 1 }];
    });
    setPickerQuery("");
  };

  const setQuantity = (productId: string, value: string) => {
    const qty = Math.floor(Number(value));
    setBasket((prev) =>
      prev.map((line) =>
        line.productId === productId
          ? {
              ...line,
              quantity: Number.isFinite(qty) ? Math.min(Math.max(qty, 1), MAX_QTY) : 1,
            }
          : line,
      ),
    );
  };

  const removeProduct = (productId: string) => {
    setBasket((prev) => prev.filter((line) => line.productId !== productId));
  };

  const basketTotal = basket.reduce((sum, line) => {
    const product = productById.get(line.productId);
    return sum + (product ? product.price * line.quantity : 0);
  }, 0);

  // Market select drives the country: picking a market snaps the country to
  // the market's first country (always present in the country options — the
  // loader merges every market country into the list).
  const handleMarketChange = (value: string) => {
    setMarket(value);
    if (!value) return;
    const picked = data.markets.find((m) => m.handle === value);
    if (picked && picked.countries.length > 0) setCountry(picked.countries[0]);
  };

  // The country select stays available as a secondary control for non-market
  // countries: picking a country outside the selected market clears the
  // market (keeping it would simulate a currency that country never sees).
  const handleCountryChange = (value: string) => {
    setCountry(value);
    if (!market) return;
    const picked = data.markets.find((m) => m.handle === market);
    if (!picked || !picked.countries.includes(value)) setMarket("");
  };

  const handleGenerate = () => {
    const fd = new FormData();
    fd.set("intent", "generate");
    fd.set("basket", JSON.stringify(basket));
    fd.set("marketHandle", market);
    fd.set("countryCode", country);
    fd.set("language", language);
    fd.set("regenerate", regenerate ? "1" : "0");
    submit(fd, { method: "post" });
  };

  const result = actionData?.ok ? actionData.result : null;
  const errorMessage = actionData && !actionData.ok ? actionData.message : null;
  // True provenance from the engine, per page.
  const diags = result?.diagnostics ?? [];
  const anyFallback = diags.some((d) => d.source === "fallback");
  const anyNoDiscountFallback = diags.some(
    (d) => d.source === "no_discount_fallback",
  );
  const anyAi = diags.some((d) => d.source === "ai");
  const anyCache = diags.some((d) => d.source === "cache");
  const fallbackReason = diags.find((d) => d.source === "fallback")?.reason ?? null;

  const marketOptions = [
    { label: "No market (store default)", value: "" },
    ...data.markets.map((m) => ({
      label: `${m.name}${m.currency ? `, ${m.currency}` : ""}${
        m.enabled ? "" : " (disabled)"
      }`,
      value: m.handle,
    })),
  ];
  const countryOptions = data.countries.map((code) => ({
    label: countryLabel(code),
    value: code,
  }));
  const languageOptions = [
    ...data.languages.map((code) => ({
      label: LANGUAGE_LABELS[code] ?? code,
      value: code,
    })),
    // Deliberately NOT an enabled store language — submitting it lets the
    // merchant watch the market-override / store-default fallback path fire.
    { label: "Unsupported language (simulate fallback)", value: "zz" },
  ];

  return (
    <Page
      title="Preview"
      subtitle="Exactly what a buyer sees after checkout — real engine, real AI copy."
      fullWidth
    >
      <Layout>
        {/* ── Controls ── */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Test order
              </Text>
              {data.products.length === 0 ? (
                <Banner tone="warning" title="No products in the catalog cache">
                  <p>
                    Run “Sync catalog &amp; translations” from the Products page
                    first — the preview builds its basket from the cache.
                  </p>
                </Banner>
              ) : (
                <Combobox
                  activator={
                    <Combobox.TextField
                      prefix={<Icon source={SearchIcon} />}
                      label="Add a product to the order"
                      value={pickerQuery}
                      onChange={setPickerQuery}
                      placeholder="Search products"
                      autoComplete="off"
                    />
                  }
                >
                  {pickerOptions.length > 0 ? (
                    <Listbox onSelect={addProduct}>
                      {pickerOptions.map((product) => (
                        <Listbox.Option
                          key={product.productId}
                          value={product.productId}
                        >
                          {`${product.title} — ${formatEur(product.price)}${
                            product.productType ? ` · ${product.productType}` : ""
                          }`}
                        </Listbox.Option>
                      ))}
                    </Listbox>
                  ) : null}
                </Combobox>
              )}

              {basket.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  Add at least one product — the engine recommends complements
                  to what is “already in the order”.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {basket.map((line) => {
                    const product = productById.get(line.productId);
                    if (!product) return null;
                    return (
                      <InlineStack
                        key={line.productId}
                        gap="200"
                        blockAlign="center"
                        wrap={false}
                      >
                        <Thumbnail
                          source={product.imageUrl ?? ImageIcon}
                          alt={product.title}
                          size="small"
                        />
                        <Box width="100%">
                          <BlockStack gap="050">
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {product.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {formatEur(product.price)}
                            </Text>
                          </BlockStack>
                        </Box>
                        <Box width="76px">
                          <TextField
                            label="Qty"
                            labelHidden
                            type="number"
                            min={1}
                            max={MAX_QTY}
                            value={String(line.quantity)}
                            onChange={(value) => setQuantity(line.productId, value)}
                            autoComplete="off"
                          />
                        </Box>
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          tone="critical"
                          accessibilityLabel={`Remove ${product.title}`}
                          onClick={() => removeProduct(line.productId)}
                        />
                      </InlineStack>
                    );
                  })}
                  <Divider />
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Order total (sets the discount tier)
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatEur(Math.round(basketTotal * 100) / 100)}
                    </Text>
                  </InlineStack>
                </BlockStack>
              )}

              <Divider />
              <Select
                label="Market"
                options={marketOptions}
                value={market}
                onChange={handleMarketChange}
                helpText="Uses the real per-country prices from Shopify when available, falling back to the market's display currency with its preview FX rate. Picking a market sets the shipping country."
              />
              <Select
                label="Shipping country"
                options={countryOptions}
                value={country}
                onChange={handleCountryChange}
                helpText="Drives market overrides (enabled, discount, language, max offers). A country outside the selected market clears the market."
              />
              <Select
                label="Buyer language"
                options={languageOptions}
                value={language}
                onChange={setLanguage}
              />
              <Checkbox
                label="Regenerate copy (bypass cache)"
                checked={regenerate}
                onChange={setRegenerate}
                helpText="Clears this shop's copy cache before generating, forcing fresh AI copy."
              />
              <Button
                variant="primary"
                fullWidth
                onClick={handleGenerate}
                loading={generating}
                disabled={basket.length === 0}
              >
                Generate preview
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Preview ── */}
        <Layout.Section>
          <BlockStack gap="400">
            {!data.aiKeySet ? (
              <Banner
                tone="warning"
                title="ANTHROPIC_API_KEY is not set — previews use deterministic fallback copy"
              >
                <p>
                  The layout, engine selection, discounts and translated strings
                  are still real; only the persuasion copy falls back to the
                  built-in template.
                </p>
              </Banner>
            ) : null}
            {errorMessage ? (
              <Banner tone="critical" title={errorMessage} />
            ) : null}

            <Card>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <ButtonGroup variant="segmented">
                  <Button
                    pressed={device === "desktop"}
                    onClick={() => setDevice("desktop")}
                  >
                    Desktop
                  </Button>
                  <Button
                    pressed={device === "mobile"}
                    onClick={() => setDevice("mobile")}
                  >
                    Mobile (390px)
                  </Button>
                </ButtonGroup>
                {result ? (
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge>{`${result.latencyMs} ms`}</Badge>
                    {anyAi ? <Badge tone="success">AI copy</Badge> : null}
                    {anyCache ? <Badge tone="info">Cached AI copy</Badge> : null}
                    {anyFallback ? <Badge tone="warning">Fallback copy</Badge> : null}
                    {anyNoDiscountFallback ? (
                      <Badge tone="warning">Fallback copy (0% discount)</Badge>
                    ) : null}
                    {(anyAi || anyCache) && result.model ? (
                      <Badge tone="info">{result.model}</Badge>
                    ) : null}
                    {result.languageResolution ? (
                      <>
                        <Badge>{`Language: ${result.languageResolution.language}`}</Badge>
                        <Badge
                          tone={
                            LANGUAGE_SOURCE_META[result.languageResolution.source]
                              .tone
                          }
                        >
                          {
                            LANGUAGE_SOURCE_META[result.languageResolution.source]
                              .label
                          }
                        </Badge>
                      </>
                    ) : null}
                    <Badge tone="info">
                      {result.presentment.marketName
                        ? `Market: ${result.presentment.marketName}`
                        : "No market (store default)"}
                    </Badge>
                    <Badge>{`Display currency: ${result.response.currency}`}</Badge>
                    {result.presentment.pricingSource === "contextual" ? (
                      <Badge tone="success">Real market prices</Badge>
                    ) : null}
                    {result.presentment.pricingSource === "fx" &&
                    result.presentment.rate !== null ? (
                      <Badge
                        tone={result.presentment.rateIsDefault ? "warning" : "info"}
                      >
                        {`FX rate: ${result.presentment.rate}`}
                      </Badge>
                    ) : null}
                    <Badge>
                      {`${result.offerCount} offer${result.offerCount === 1 ? "" : "s"}`}
                    </Badge>
                    {result.regenerated ? <Badge tone="info">Cache cleared</Badge> : null}
                  </InlineStack>
                ) : null}
              </InlineStack>
              {result && anyFallback ? (
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {fallbackReason === "no_key"
                      ? "Fallback cause: ANTHROPIC_API_KEY is not set on the server."
                      : fallbackReason === "ai_disabled"
                        ? "Fallback cause: AI copy is disabled in Settings → AI."
                        : fallbackReason === "timeout_or_error"
                          ? "Fallback cause: the Claude API call failed or timed out (previews wait up to 30s — check the server logs for the exact error)."
                          : "Fallback cause: internal error — check the server logs."}
                  </Text>
                </Box>
              ) : null}
              {result && anyNoDiscountFallback ? (
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Fallback cause: this offer carries a 0% discount, so the AI
                    call is skipped by design — the prompts mandate mentioning
                    the discount, which would render as “0% off”. The
                    deterministic fallback omits discount phrasing entirely.
                  </Text>
                </Box>
              ) : null}
              {result?.languageResolution?.source === "market_override" ? (
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    The selected country’s market has a language override
                    configured in Settings → Markets — it applied because the
                    selected language is not an enabled store language.
                  </Text>
                </Box>
              ) : null}
              {result?.presentment.pricingSource === "contextual" ? (
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Prices are the real per-country prices fetched from Shopify
                    (contextual pricing — market price adjustments and price
                    lists included). The preview FX rate was not needed. Live
                    buyers see these same amounts.
                  </Text>
                </Box>
              ) : result &&
                result.presentment.pricingSource === "fx" &&
                result.presentment.rate !== null ? (
                <Box paddingBlockStart="200">
                  <Text
                    as="p"
                    variant="bodySm"
                    tone={result.presentment.rateIsDefault ? "caution" : "subdued"}
                  >
                    {result.presentment.rateIsDefault
                      ? "Real per-country prices were unavailable, so prices are simulated with the market's preview FX rate (1, the default — no rate is configured for this market yet, so amounts equal shop-currency values). Live buyers see Shopify's exact checkout conversion; set a preview FX rate in Settings → Markets for realistic amounts."
                      : `Real per-country prices were unavailable, so prices are simulated with the market's preview FX rate (${result.presentment.rate}) — live buyers see Shopify's exact checkout conversion.`}
                  </Text>
                </Box>
              ) : null}
            </Card>

            {result && result.offerCount === 0 ? (
              <Banner tone="info" title="The engine returned no offers for this basket">
                <p>
                  Frequency caps never apply here (previews have no customer).
                  Likely causes: the app is disabled in Settings, the market for
                  this country is disabled, or no eligible products remain —
                  candidates already in the basket, inactive, below the minimum
                  inventory, or priced at zero are all suppressed.
                </p>
              </Banner>
            ) : null}

            {result && result.offerCount > 0 ? (
              <BlockStack gap="100">
                <PostPurchasePreview
                  key={result.generatedAt}
                  response={result.response}
                  device={device}
                />
                {diags.length > 0 ? (
                  // Per-page copy provenance — rendered for single-offer runs
                  // too, so provenance is always visible. The pager itself
                  // lives inside PostPurchasePreview (a shared component this
                  // route must not modify), so the strip sits directly
                  // beneath the preview frame.
                  <InlineStack gap="300" align="center" wrap>
                    {[...diags]
                      .sort((a, b) => a.position - b.position)
                      .map((d) => (
                        <Text
                          key={d.position}
                          as="span"
                          variant="bodySm"
                          tone="subdued"
                        >
                          {`Page ${d.position}: ${PAGE_SOURCE_LABELS[d.source]}`}
                        </Text>
                      ))}
                  </InlineStack>
                ) : null}
              </BlockStack>
            ) : null}

            {!result && !errorMessage ? (
              <Card>
                <BlockStack gap="200" inlineAlign="center">
                  <Box paddingBlock="600">
                    <BlockStack gap="200" inlineAlign="center">
                      <Text as="h3" variant="headingMd">
                        Build a test order to see the buyer page
                      </Text>
                      <Text as="p" tone="subdued" alignment="center">
                        Pick the products a customer “just bought”, choose the
                        market, country and language, then generate. The preview runs
                        the live recommendation engine and the live AI
                        copywriter — the same code path buyers hit after
                        checkout.
                      </Text>
                    </BlockStack>
                  </Box>
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
