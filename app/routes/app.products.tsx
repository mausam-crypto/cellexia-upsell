// ─────────────────────────────────────────────────────────────────────────────
// Products — the AI copywriter's product knowledge, per product.
//
// Shows the cached catalog with name coverage and Shopify description
// presence, and lets the merchant (a) write an "AI context" per product that
// overrides the Shopify description as copywriting grounding, and (b) set
// manual per-language product names (ProductCache.nameOverridesJson). Name
// precedence everywhere buyers see a name: manual override > Translate &
// Adapt synced translation > base title. Manual names always win over
// Translate & Adapt and survive every sync.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Form,
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse, jstr } from "../lib/json";
import { getSettings } from "../services/settings.server";
import { syncCatalog, syncMarketsAndLocales } from "../services/catalog.server";
import { LANGUAGE_LABELS } from "../types";
import type { AdminGraphql } from "../types";

const PAGE_SIZE = 20;
// Fed to the AI copywriter in full (the prompt-side cap matches) — give the
// merchant room for genuinely detailed product knowledge.
const AI_DESCRIPTION_MAX = 20_000;
// Manual per-language product names are buyer-facing titles — keep them short.
const NAME_OVERRIDE_MAX = 300;

/** nameOverridesJson, sanitized: only non-empty string values survive. */
function parseNameOverrides(raw: string): Record<string, string> {
  const parsed = jparse<Record<string, unknown>>(raw, {});
  const out: Record<string, string> = {};
  for (const [lang, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) out[lang] = value;
  }
  return out;
}

// ── Loader ──────────────────────────────────────────────────────────────────

interface ProductRowData {
  productId: string;
  title: string;
  productType: string;
  imageUrl: string | null;
  /** Length of the plain-text Shopify description (full, else short excerpt). */
  descriptionLength: number;
  aiDescription: string;
  /**
   * Languages covered by a name: manual override OR synced Translate & Adapt
   * translation OR the default language (covered by the base title).
   */
  coveredCount: number;
  /** Manual per-language name overrides ({ [lang]: name }). */
  nameOverrides: Record<string, string>;
  /** Synced Translate & Adapt titles ({ [lang]: title }). */
  translatedTitles: Record<string, string>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const rawPage = Number(url.searchParams.get("page") ?? "1");
  const requestedPage =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const settings = await getSettings(shop);

  // SQLite's LIKE is case-insensitive, so `contains` matches regardless of case.
  const where = q ? { shop, title: { contains: q } } : { shop };
  const [totalCount, shopRow] = await Promise.all([
    prisma.productCache.count({ where }),
    prisma.shop.findUnique({ where: { shop } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await prisma.productCache.findMany({
    where,
    orderBy: { title: "asc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Enabled languages, default language first — the order of the names grid.
  const languages = [
    ...settings.languages.filter((lang) => lang === settings.defaultLanguage),
    ...settings.languages.filter((lang) => lang !== settings.defaultLanguage),
  ];
  const products: ProductRowData[] = rows.map((row) => {
    const translations = jparse<Record<string, { title?: string }>>(
      row.translationsJson,
      {},
    );
    const nameOverrides = parseNameOverrides(row.nameOverridesJson);
    const translatedTitles: Record<string, string> = {};
    for (const lang of languages) {
      const title = translations[lang]?.title;
      if (typeof title === "string" && title.trim()) {
        translatedTitles[lang] = title;
      }
    }
    // Coverage: manual override OR synced translation OR default language
    // (the base title covers the default language by definition).
    const coveredCount = languages.filter(
      (lang) =>
        Boolean(nameOverrides[lang]) ||
        Boolean(translatedTitles[lang]) ||
        lang === settings.defaultLanguage,
    ).length;
    return {
      productId: row.productId,
      title: row.title,
      productType: row.productType,
      imageUrl: row.imageUrl,
      descriptionLength: (row.descriptionFull || row.descriptionShort).length,
      aiDescription: row.aiDescription,
      coveredCount,
      nameOverrides,
      translatedTitles,
    };
  });

  return json({
    products,
    totalCount,
    page,
    totalPages,
    q,
    languages,
    defaultLanguage: settings.defaultLanguage,
    catalogSynced: Boolean(shopRow?.catalogSyncedAt),
  });
};

// ── Action (sync / saveAi / saveNames intents) ──────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync") {
    try {
      const graphql = admin.graphql as unknown as AdminGraphql;
      // Markets & locales first: freshly published locales land in
      // settings.languages before syncCatalog runs its translation pass, so
      // the same run covers them.
      await syncMarketsAndLocales(graphql, shop);
      const { count } = await syncCatalog(graphql, shop);
      return json({
        ok: true,
        message: `Catalog synced — ${count} products cached. Translations, markets and locales refreshed.`,
      });
    } catch (error) {
      console.error("[products] sync failed", error);
      return json({
        ok: false,
        message: "Sync failed — check the server logs and try again.",
      });
    }
  }

  if (intent === "saveAi") {
    const productId = String(formData.get("productId") ?? "");
    // Server-side cap — the UI limits input too, but never trust the client.
    const text = String(formData.get("text") ?? "")
      .trim()
      .slice(0, AI_DESCRIPTION_MAX);
    if (!productId) {
      return json({ ok: false, message: "Missing product id." }, { status: 400 });
    }
    try {
      const result = await prisma.productCache.updateMany({
        where: { shop, productId },
        data: { aiDescription: text },
      });
      if (result.count === 0) {
        return json({
          ok: false,
          message: "Product not found in the catalog cache — run a sync first.",
        });
      }
      return json({
        ok: true,
        message: text
          ? "AI context saved."
          : "AI context cleared — the Shopify description will be used.",
      });
    } catch (error) {
      console.error("[products] saveAi failed", error);
      return json({ ok: false, message: "Saving failed — try again." });
    }
  }

  if (intent === "saveNames") {
    const productId = String(formData.get("productId") ?? "");
    if (!productId) {
      return json({ ok: false, message: "Missing product id." }, { status: 400 });
    }
    // Submitted names, restricted to the enabled languages — never trust the
    // client with arbitrary keys.
    const submitted = jparse<Record<string, unknown>>(
      String(formData.get("namesJson") ?? "{}"),
      {},
    );
    try {
      const settings = await getSettings(shop);
      const enabled = new Set(settings.languages);
      const row = await prisma.productCache.findUnique({
        where: { shop_productId: { shop, productId } },
      });
      if (!row) {
        return json({
          ok: false,
          message: "Product not found in the catalog cache — run a sync first.",
        });
      }
      // Start from what is stored (preserves overrides for languages the
      // merchant has since disabled), then apply the submitted values:
      // trimmed, capped at NAME_OVERRIDE_MAX; empty = remove the override.
      const merged = parseNameOverrides(row.nameOverridesJson);
      for (const [lang, value] of Object.entries(submitted)) {
        if (!enabled.has(lang)) continue;
        const text =
          typeof value === "string"
            ? value.trim().slice(0, NAME_OVERRIDE_MAX).trim()
            : "";
        if (text) merged[lang] = text;
        else delete merged[lang];
      }
      await prisma.productCache.update({
        where: { shop_productId: { shop, productId } },
        data: { nameOverridesJson: jstr(merged) },
      });
      return json({
        ok: true,
        message: Object.keys(merged).length
          ? "Names saved. Manual names always win over Translate & Adapt."
          : "Names cleared — Translate & Adapt translations will be used.",
      });
    } catch (error) {
      console.error("[products] saveNames failed", error);
      return json({ ok: false, message: "Saving names failed — try again." });
    }
  }

  return json({ ok: false, message: "Unknown action." }, { status: 400 });
};

// ── Per-product row ─────────────────────────────────────────────────────────

function ProductRow({
  product,
  languages,
  defaultLanguage,
}: {
  product: ProductRowData;
  languages: string[];
  defaultLanguage: string;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const namesFetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(product.aiDescription);
  const [names, setNames] = useState<Record<string, string>>(
    product.nameOverrides,
  );
  const saving = fetcher.state !== "idle";
  const savingNames = namesFetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  useEffect(() => {
    if (namesFetcher.state === "idle" && namesFetcher.data) {
      shopify.toast.show(namesFetcher.data.message, {
        isError: !namesFetcher.data.ok,
      });
    }
  }, [namesFetcher.state, namesFetcher.data, shopify]);

  const handleSave = () => {
    fetcher.submit(
      { intent: "saveAi", productId: product.productId, text },
      { method: "post" },
    );
  };

  const handleSaveNames = () => {
    namesFetcher.submit(
      {
        intent: "saveNames",
        productId: product.productId,
        namesJson: JSON.stringify(names),
      },
      { method: "post" },
    );
  };

  const languageCount = languages.length;
  const namesComplete = product.coveredCount >= languageCount;

  return (
    <BlockStack gap="200">
      <InlineStack gap="300" blockAlign="center" wrap={false} align="space-between">
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumbnail
            source={product.imageUrl ?? ImageIcon}
            size="small"
            alt={product.title}
          />
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {product.title}
            </Text>
            <InlineStack gap="200" blockAlign="center" wrap>
              {product.productType ? (
                <Text as="span" variant="bodySm" tone="subdued">
                  {product.productType}
                </Text>
              ) : null}
              <Badge tone={namesComplete ? "success" : "warning"}>
                {`${product.coveredCount}/${languageCount} names covered`}
              </Badge>
              {product.descriptionLength > 0 ? (
                <Badge>
                  {`Shopify description: ${product.descriptionLength.toLocaleString("en")} chars`}
                </Badge>
              ) : (
                <Badge tone="warning">No Shopify description</Badge>
              )}
              {product.aiDescription ? (
                <Badge tone="info">AI context set</Badge>
              ) : null}
            </InlineStack>
          </BlockStack>
        </InlineStack>
        <Button
          variant="plain"
          disclosure={open ? "up" : "down"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Edit AI context & names"}
        </Button>
      </InlineStack>
      <Collapsible
        open={open}
        id={`ai-context-${product.productId}`}
        transition={{ duration: "150ms", timingFunction: "ease" }}
      >
        <Box paddingBlockStart="100">
          <BlockStack gap="400">
            <BlockStack gap="200">
              <TextField
                label="AI context"
                value={text}
                onChange={setText}
                multiline={8}
                maxLength={AI_DESCRIPTION_MAX}
                showCharacterCount
                autoComplete="off"
                helpText="Used as the AI copywriter's product knowledge. Leave empty to use the product's full Shopify description."
              />
              <InlineStack align="end">
                <Button variant="primary" loading={saving} onClick={handleSave}>
                  Save
                </Button>
              </InlineStack>
            </BlockStack>

            <Divider />

            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Product names by language
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Manual names always win over Translate &amp; Adapt and survive
                every sync.
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="200">
                {languages.map((lang) => {
                  const syncedTitle = product.translatedTitles[lang];
                  const isDefault = lang === defaultLanguage;
                  const label = `${LANGUAGE_LABELS[lang] ?? lang} (${lang}${
                    isDefault ? ", default" : ""
                  })`;
                  return (
                    <TextField
                      key={lang}
                      label={label}
                      value={names[lang] ?? ""}
                      onChange={(value) =>
                        setNames((prev) => ({ ...prev, [lang]: value }))
                      }
                      placeholder={syncedTitle ?? product.title}
                      maxLength={NAME_OVERRIDE_MAX}
                      autoComplete="off"
                      helpText={syncedTitle ? undefined : "(default title)"}
                    />
                  );
                })}
              </InlineGrid>
              <InlineStack align="end">
                <Button loading={savingNames} onClick={handleSaveNames}>
                  Save names
                </Button>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Box>
      </Collapsible>
    </BlockStack>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const syncFetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(data.q);
  const syncing = syncFetcher.state !== "idle";

  // Keep the search box in step with back/forward navigation.
  useEffect(() => {
    setQuery(data.q);
  }, [data.q]);

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data) {
      shopify.toast.show(syncFetcher.data.message, {
        isError: !syncFetcher.data.ok,
      });
    }
  }, [syncFetcher.state, syncFetcher.data, shopify]);

  const handleSync = () => {
    syncFetcher.submit({ intent: "sync" }, { method: "post" });
  };

  const goToPage = (page: number) => {
    const params = new URLSearchParams(searchParams);
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    setSearchParams(params);
  };

  const showEmptyState = data.totalCount === 0 && !data.q;

  return (
    <Page
      title="Products"
      subtitle="What the AI copywriter knows about each product"
      primaryAction={{
        content: "Sync catalog & translations",
        onAction: handleSync,
        loading: syncing,
      }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Product knowledge for offer copy
              </Text>
              <Text as="p" tone="subdued">
                Every offer's copy is grounded in a product description. The AI
                uses, in order of precedence: the AI context you write here →
                the product's full Shopify description → its short excerpt.
                Write an AI context when the Shopify description is thin,
                off-tone, or missing the selling points you want the copy to
                lean on. Product names shown to buyers follow their own
                precedence: a manual name you set here → the Translate &amp;
                Adapt translation (synced from Shopify — run "Sync catalog
                &amp; translations" after editing there) → the base title.
                Manual names always win over Translate &amp; Adapt and survive
                every sync.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {showEmptyState ? (
            <Card>
              <EmptyState
                heading="No products in the catalog cache yet"
                action={{
                  content: "Sync catalog & translations",
                  onAction: handleSync,
                  loading: syncing,
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Run a sync to pull your products, variants, descriptions and
                  translated names from Shopify. Everything on this page — and
                  the recommendation engine itself — works from that cache.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="400">
                <Form method="get">
                  <InlineStack gap="200" blockAlign="end" wrap={false}>
                    <Box width="100%">
                      <TextField
                        label="Search products"
                        labelHidden
                        placeholder="Search by product title"
                        name="q"
                        value={query}
                        onChange={setQuery}
                        autoComplete="off"
                        clearButton
                        onClearButtonClick={() => {
                          setQuery("");
                          const params = new URLSearchParams(searchParams);
                          params.delete("q");
                          params.delete("page");
                          setSearchParams(params);
                        }}
                      />
                    </Box>
                    <Button submit>Search</Button>
                  </InlineStack>
                </Form>

                <Text as="p" variant="bodySm" tone="subdued">
                  {data.q
                    ? `${data.totalCount.toLocaleString("en")} product${
                        data.totalCount === 1 ? "" : "s"
                      } matching “${data.q}”`
                    : `${data.totalCount.toLocaleString("en")} product${
                        data.totalCount === 1 ? "" : "s"
                      } in the catalog cache`}
                </Text>

                {data.products.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No products match your search.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {data.products.map((product, index) => (
                      <BlockStack key={product.productId} gap="300">
                        {index > 0 ? <Divider /> : null}
                        <ProductRow
                          product={product}
                          languages={data.languages}
                          defaultLanguage={data.defaultLanguage}
                        />
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}

                {data.totalPages > 1 ? (
                  <InlineStack align="center">
                    <Pagination
                      hasPrevious={data.page > 1}
                      onPrevious={() => goToPage(data.page - 1)}
                      hasNext={data.page < data.totalPages}
                      onNext={() => goToPage(data.page + 1)}
                      label={`Page ${data.page} of ${data.totalPages}`}
                    />
                  </InlineStack>
                ) : null}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
