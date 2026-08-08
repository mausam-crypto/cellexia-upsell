// ─────────────────────────────────────────────────────────────────────────────
// Upsell products tab — the merchant-curated allowlist of products the engine
// may offer. Unchecking a product guarantees it is NEVER offered: not by
// rules, not by auto-pilot, not post-purchase, not on the thank-you page.
// Built for catalogs that contain internal-only rows (duplicates, imports,
// B2B/samples) that are ACTIVE in the admin but must never reach a buyer —
// e.g. an unpublished duplicate with a foreign-language base title.
//
// The flag lives on ProductCache.upsellEligible (default true) and is
// merchant-owned: catalog syncs and product webhooks never touch it. The
// engine enforces it in isSuppressed, the single gate every candidate passes.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Checkbox,
  Icon,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon, SearchIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings } from "../services/settings.server";
import { LANGUAGE_LABELS } from "../types";

const MAX_PRODUCTS = 500;

interface RowData {
  productId: string;
  /** The Shopify base title — exactly what buyers see when no name exists. */
  baseTitle: string;
  productType: string;
  status: string;
  imageUrl: string | null;
  price: number | null;
  upsellEligible: boolean;
  /** True when the default language has neither a manual name nor a T&A title
   *  — the base title is served verbatim (the "German base title" trap). */
  defaultNameIsBaseTitle: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [settings, rows] = await Promise.all([
    getSettings(shop),
    prisma.productCache.findMany({
      where: { shop },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      take: MAX_PRODUCTS,
    }),
  ]);

  const defaultLanguage = settings.defaultLanguage || "en";
  const products: RowData[] = rows.map((row) => {
    const variants = jparse<Array<{ price?: number }>>(row.variantsJson, []);
    const price = Number(variants[0]?.price);
    const overrides = jparse<Record<string, string>>(row.nameOverridesJson, {});
    const translations = jparse<Record<string, { title?: string }>>(row.translationsJson, {});
    const hasDefaultName =
      Boolean((overrides[defaultLanguage] ?? "").trim()) ||
      Boolean((translations[defaultLanguage]?.title ?? "").trim());
    return {
      productId: row.productId,
      baseTitle: row.title,
      productType: row.productType,
      status: row.status,
      imageUrl: row.imageUrl,
      price: Number.isFinite(price) ? price : null,
      upsellEligible: row.upsellEligible !== false,
      defaultNameIsBaseTitle: !hasDefaultName,
    };
  });

  return json({
    products,
    defaultLanguage,
    defaultLanguageLabel: LANGUAGE_LABELS[defaultLanguage] ?? defaultLanguage,
    truncated: rows.length === MAX_PRODUCTS,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "set") {
    const productId = String(formData.get("productId") ?? "");
    const eligible = String(formData.get("eligible") ?? "") === "1";
    if (!productId) {
      return json({ ok: false, message: "Missing product id." }, { status: 400 });
    }
    const result = await prisma.productCache.updateMany({
      where: { shop, productId },
      data: { upsellEligible: eligible },
    });
    if (result.count === 0) {
      return json({
        ok: false,
        message: "Product not found in the catalog cache — run a sync first.",
      });
    }
    return json({
      ok: true,
      message: eligible
        ? "Product can be offered as an upsell again."
        : "Product excluded — it will never be offered as an upsell.",
    });
  }

  return json({ ok: false, message: "Unknown action." }, { status: 400 });
};

function ProductRow({ product }: { product: RowData }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Optimistic: while a toggle is in flight, show the submitted value.
  const pending = fetcher.formData?.get("eligible");
  const eligible = pending !== undefined && pending !== null
    ? pending === "1"
    : product.upsellEligible;

  const toggle = (checked: boolean) => {
    const fd = new FormData();
    fd.set("intent", "set");
    fd.set("productId", product.productId);
    fd.set("eligible", checked ? "1" : "0");
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Box
      padding="300"
      borderRadius="200"
      background={eligible ? "bg-surface" : "bg-surface-secondary"}
    >
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <Thumbnail
          source={product.imageUrl ?? ImageIcon}
          alt={product.baseTitle}
          size="small"
        />
        <Box width="100%">
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Text as="span" variant="bodyMd" fontWeight="semibold" tone={eligible ? undefined : "subdued"}>
                {product.baseTitle}
              </Text>
              {product.status !== "ACTIVE" ? (
                <Badge tone="info">{product.status.toLowerCase()}</Badge>
              ) : null}
              {!eligible ? <Badge tone="critical">Never offered</Badge> : null}
            </InlineStack>
            <Text as="span" variant="bodySm" tone="subdued">
              {[
                product.productType || null,
                product.price !== null ? `${product.price.toFixed(2)} (shop currency)` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </BlockStack>
        </Box>
        <Box minWidth="170px">
          <Checkbox
            label="Can be offered"
            checked={eligible}
            onChange={toggle}
            disabled={fetcher.state !== "idle"}
          />
        </Box>
      </InlineStack>
    </Box>
  );
}

export default function UpsellProductsPage() {
  const data = useLoaderData<typeof loader>();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.products;
    return data.products.filter(
      (p) =>
        p.baseTitle.toLowerCase().includes(q) ||
        p.productType.toLowerCase().includes(q),
    );
  }, [query, data.products]);

  const excluded = data.products.filter((p) => !p.upsellEligible);
  const baseTitleOnly = data.products.filter(
    (p) => p.upsellEligible && p.defaultNameIsBaseTitle && p.status === "ACTIVE",
  );

  return (
    <Page
      title="Upsell products"
      subtitle="Choose which products the engine is allowed to offer. Unchecked products are never offered — not by rules, not by auto-pilot, on any surface."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {excluded.length > 0 ? (
              <Banner tone="info" title={`${excluded.length} product${excluded.length === 1 ? "" : "s"} excluded from upsells`}>
                <p>
                  Excluded products stay in your catalog and can still appear in
                  test-order baskets on the Preview page — they are only removed
                  from what the engine may offer. Offer rules that name an
                  excluded product as a candidate will silently skip it.
                </p>
              </Banner>
            ) : null}
            {baseTitleOnly.length > 0 ? (
              <Banner
                tone="warning"
                title={`${baseTitleOnly.length} offerable product${baseTitleOnly.length === 1 ? " has" : "s have"} no ${data.defaultLanguageLabel} name`}
              >
                <p>
                  These products have neither a manual name nor a Translate &amp;
                  Adapt title for your default language ({data.defaultLanguage}),
                  so their Shopify base title is shown verbatim to buyers. If a
                  base title is in another language (e.g. an imported duplicate),
                  either exclude the product below or give it names on the
                  Products tab: {baseTitleOnly.slice(0, 5).map((p) => `"${p.baseTitle}"`).join(", ")}
                  {baseTitleOnly.length > 5 ? ", …" : ""}.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <TextField
                  label="Search products"
                  labelHidden
                  prefix={<Icon source={SearchIcon} />}
                  placeholder="Search by title or product type"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
                {data.truncated ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Showing the first {MAX_PRODUCTS} products — use search to
                    reach the rest.
                  </Text>
                ) : null}
                {filtered.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {data.products.length === 0
                      ? "No products in the catalog cache — run “Sync catalog & translations” from the Products page first."
                      : "No products match the search."}
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {filtered.map((product) => (
                      <ProductRow key={product.productId} product={product} />
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
