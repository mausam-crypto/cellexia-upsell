import { useEffect, useState } from "react";
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
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings } from "../services/settings.server";
import {
  DEFAULT_PROMPTS,
  ensurePromptTemplates,
  generateCopy,
  type PromptKey,
} from "../services/ai.server";
import {
  LANGUAGE_LABELS,
  type OfferCopy,
  type SelectedOfferProduct,
} from "../types";

const PROMPT_LABELS: Record<PromptKey, string> = {
  single: "Single product",
  bundle: "Bundle",
  sequential: "Sequenced offers",
};

const TEMPLATE_VARIABLES: Array<{
  name: string;
  description: string;
  example: string;
}> = [
  {
    name: "brand_context",
    description: "Brand voice and positioning from Settings → General.",
    example: "Cellexia Labs — Precision Beauty™. Professional-grade anti-aging skincare…",
  },
  {
    name: "tone",
    description: "Copy tone from Settings → General.",
    example: "warm, expert, confident — never salesy",
  },
  {
    name: "language",
    description: "The buyer's language for this offer.",
    example: "fr",
  },
  {
    name: "length",
    description: 'Requested copy length: "short" or "long".',
    example: "short",
  },
  {
    name: "basket_summary",
    description:
      "What the buyer just ordered — quantity, title, product type and a detailed description per product (the AI context from the Products tab when set, otherwise the Shopify description).",
    example:
      "2× Retinol Night Cream (Cream) — slow-release retinol that smooths fine lines overnight…",
  },
  {
    name: "offer_summary",
    description:
      "The offered product(s) — title, type, price and a detailed description per product (the AI context from the Products tab when set, otherwise the Shopify description).",
    example: "Collagen Eye Serum (Serum, 49.00 EUR) — firms and brightens the eye area…",
  },
  {
    name: "discount_pct",
    description: "The discount percentage applied to this offer.",
    example: "12",
  },
  {
    name: "currency",
    description: "The order's currency code.",
    example: "EUR",
  },
  {
    name: "position",
    description: "Position of this offer page in the sequenced flow (1-based).",
    example: "2",
  },
  {
    name: "total_offers",
    description: "Total number of offer pages in the flow.",
    example: "3",
  },
];

// What the model is asked to return — mirrored by OfferCopy in app/types.ts.
const OUTPUT_FIELDS: Array<{ name: string; description: string }> = [
  {
    name: "headline",
    description: "The hook — ≤ 60 characters.",
  },
  {
    name: "body",
    description:
      "The lead: 1–2 sentences shown above the fold, next to the buy button.",
  },
  {
    name: "bullets",
    description: "2–3 concrete benefit bullets.",
  },
  {
    name: "paragraphs",
    description:
      "Long copy only — 2–3 short paragraphs of mechanism, proof and relevance to the order, rendered below the buy button under a “Why it works with your order” heading.",
  },
  {
    name: "proof",
    description:
      "Long copy only — 2–3 established research findings about ingredients named in the product descriptions, rendered under the paragraphs; never invented citations.",
  },
  {
    name: "closer",
    description:
      "Long copy only — a one-line premium reassurance rendered directly above the buttons.",
  },
  {
    name: "discount_suggestion",
    description:
      "Optional discount percentage — applied only when the discount mode is “AI”, clamped to your min/max.",
  },
];

interface PreviewVariant {
  id: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
  inventoryQuantity: number | null;
  unitCost: number | null;
  imageUrl: string | null;
  sku: string;
}

interface PreviewResult {
  key: string;
  language: string;
  copy: OfferCopy;
  latencyMs: number;
  cached: boolean;
  fallbackUsed: boolean;
}

function isPromptKey(key: string): key is PromptKey {
  return key === "single" || key === "bundle" || key === "sequential";
}

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensurePromptTemplates(shop);
  const [rows, settings] = await Promise.all([
    prisma.promptTemplate.findMany({ where: { shop } }),
    getSettings(shop),
  ]);

  const keys: PromptKey[] = ["single", "bundle", "sequential"];
  const prompts = keys.map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      systemPrompt: row?.systemPrompt ?? DEFAULT_PROMPTS[key].systemPrompt,
      userPrompt: row?.userPrompt ?? DEFAULT_PROMPTS[key].userPrompt,
      model: row?.model ?? "claude-haiku-4-5",
      temperature: row?.temperature ?? 0.7,
      maxTokens: row?.maxTokens ?? 4000,
      version: row?.version ?? 1,
    };
  });

  return json({
    prompts,
    languages: settings.languages,
    defaultLanguage: settings.defaultLanguage,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const key = String(formData.get("key") ?? "");

  const respond = (
    ok: boolean,
    message: string,
    preview: PreviewResult | null = null,
    status = 200,
  ) => json({ ok, message, intent, preview }, { status });

  if (!isPromptKey(key)) {
    return respond(false, "Unknown prompt key.", null, 400);
  }

  await ensurePromptTemplates(shop);

  if (intent === "save") {
    const systemPrompt = String(formData.get("systemPrompt") ?? "");
    const userPrompt = String(formData.get("userPrompt") ?? "");
    if (!systemPrompt.trim() || !userPrompt.trim()) {
      return respond(false, "System and user prompts cannot be empty.");
    }
    // Floor of 1000: max_tokens caps thinking + output together on current
    // Claude models, so anything lower risks truncating the JSON mid-object.
    const maxTokens = Math.round(
      clampNumber(Number(formData.get("maxTokens")), 1000, 8000, 4000),
    );
    const model = String(formData.get("model") ?? "claude-haiku-4-5");
    await prisma.promptTemplate.update({
      where: { shop_key: { shop, key } },
      data: {
        systemPrompt,
        userPrompt,
        model,
        maxTokens,
        version: { increment: 1 },
      },
    });
    return respond(true, `${PROMPT_LABELS[key]} prompt saved.`);
  }

  if (intent === "reset") {
    await prisma.promptTemplate.update({
      where: { shop_key: { shop, key } },
      data: {
        systemPrompt: DEFAULT_PROMPTS[key].systemPrompt,
        userPrompt: DEFAULT_PROMPTS[key].userPrompt,
        model: "claude-haiku-4-5",
        temperature: 0.7,
        maxTokens: 4000,
        version: { increment: 1 },
      },
    });
    return respond(true, `${PROMPT_LABELS[key]} prompt reset to default.`);
  }

  if (intent === "preview") {
    const settings = await getSettings(shop);
    const language = String(formData.get("language") ?? settings.defaultLanguage);

    let products = await prisma.productCache.findMany({
      where: { shop, status: "ACTIVE" },
      orderBy: { title: "asc" },
      take: 3,
    });
    if (products.length === 0) {
      products = await prisma.productCache.findMany({
        where: { shop },
        orderBy: { title: "asc" },
        take: 3,
      });
    }
    if (products.length === 0) {
      return respond(
        false,
        "No products in the catalog cache yet — run a sync from the dashboard first.",
      );
    }

    // A bundle preview must offer MULTIPLE products — previewing the bundle
    // template with a single offered product forces the model to invent set
    // members to satisfy the "one bullet per offered product" contract.
    if (key === "bundle" && products.length < 3) {
      return respond(
        false,
        "The bundle preview needs at least 3 products in the catalog (1 basket + 2 offered) — run a sync from the dashboard first.",
      );
    }
    const basketRows = key === "bundle" ? products.slice(0, 1) : products.slice(0, 2);
    const offerRows =
      key === "bundle"
        ? products.slice(1, 3)
        : [products.length > 2 ? products[2] : products[products.length - 1]];

    const toOfferProduct = (row: (typeof products)[number]): SelectedOfferProduct | null => {
      const variants = jparse<PreviewVariant[]>(row.variantsJson, []);
      const variant =
        variants.find(
          (v) => v.inventoryQuantity === null || v.inventoryQuantity > 0,
        ) ?? variants[0];
      if (!variant) return null;
      return {
        productId: row.productId,
        variantId: variant.id,
        title: row.title,
        image: variant.imageUrl ?? row.imageUrl,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        unitCost: variant.unitCost,
        productType: row.productType,
        tags: row.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
    };

    const offerProducts = offerRows
      .map(toOfferProduct)
      .filter((p): p is SelectedOfferProduct => p !== null);
    if (offerProducts.length === 0) {
      return respond(
        false,
        "The sample product has no variants — re-run the catalog sync.",
      );
    }

    const discount = settings.discount;
    const rawPct = discount.mode === "ai" ? (discount.min + discount.max) / 2 : discount.value;
    const discountPct = Math.round(
      clampNumber(rawPct, discount.min, discount.max, discount.min),
    );

    const started = Date.now();
    try {
      const result = await generateCopy({
        shop,
        settings,
        mode: key,
        position: key === "sequential" ? 2 : 1,
        totalOffers: key === "sequential" ? 3 : 1,
        language,
        basket: basketRows.map((p) => ({
          title: p.title,
          productType: p.productType,
          quantity: 1,
          // Same precedence the live engine uses: merchant-written AI context
          // (Products tab) → full Shopify description → short excerpt.
          description: p.aiDescription || p.descriptionFull || p.descriptionShort,
        })),
        offerProducts,
        discountPct,
        currency: "EUR",
        copyLength: settings.copyLength,
        bypassCache: true,
        timeoutMs: 15000,
      });
      const latencyMs = Date.now() - started;
      return respond(true, "Preview generated.", {
        key,
        language,
        copy: result.copy,
        latencyMs,
        cached: result.cached,
        fallbackUsed: result.fallbackUsed,
      });
    } catch (error) {
      console.error("[prompts] preview generation failed", error);
      return respond(false, "Preview generation failed — check the server logs.");
    }
  }

  return respond(false, "Unknown action.", null, 400);
};

function modelOptions(current: string) {
  const options = [
    { label: "claude-haiku-4-5 (fast)", value: "claude-haiku-4-5" },
    { label: "claude-sonnet-5 (best)", value: "claude-sonnet-5" },
  ];
  if (!options.some((o) => o.value === current) && current) {
    options.push({ label: current, value: current });
  }
  return options;
}

interface PromptFields {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens: string;
}

function PromptCard({
  prompt,
  saving,
  resetting,
  onSave,
  onReset,
}: {
  prompt: {
    key: PromptKey;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    maxTokens: number;
    version: number;
  };
  saving: boolean;
  resetting: boolean;
  onSave: (fields: PromptFields) => void;
  onReset: () => void;
}) {
  const [systemPrompt, setSystemPrompt] = useState(prompt.systemPrompt);
  const [userPrompt, setUserPrompt] = useState(prompt.userPrompt);
  const [model, setModel] = useState(prompt.model);
  const [maxTokens, setMaxTokens] = useState(String(prompt.maxTokens));

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">
              {PROMPT_LABELS[prompt.key]}
            </Text>
            <Badge>{`v${prompt.version}`}</Badge>
          </InlineStack>
          <Button
            variant="plain"
            tone="critical"
            onClick={onReset}
            loading={resetting}
          >
            Reset to default
          </Button>
        </InlineStack>
        <TextField
          label="System prompt"
          value={systemPrompt}
          onChange={setSystemPrompt}
          multiline={8}
          autoComplete="off"
        />
        <TextField
          label="User prompt"
          value={userPrompt}
          onChange={setUserPrompt}
          multiline={12}
          autoComplete="off"
          helpText={
            "Template variables like {{basket_summary}} are replaced at generation time — see the reference card."
          }
        />
        <InlineStack gap="400" wrap blockAlign="end">
          <Box minWidth="220px">
            <Select
              label="Model"
              options={modelOptions(model)}
              value={model}
              onChange={setModel}
            />
          </Box>
          <Box minWidth="140px">
            <TextField
              label="Max tokens"
              type="number"
              value={maxTokens}
              onChange={setMaxTokens}
              min={1000}
              max={8000}
              helpText="Caps thinking + output together; keep ≥1000"
              autoComplete="off"
            />
          </Box>
        </InlineStack>
        <InlineStack align="end">
          <Button
            variant="primary"
            loading={saving}
            onClick={() =>
              onSave({ systemPrompt, userPrompt, model, maxTokens })
            }
          >
            Save
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function PromptsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const submittingIntent =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("intent") ?? "")
      : "";
  const submittingKey =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("key") ?? "")
      : "";

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const [previewLanguage, setPreviewLanguage] = useState(
    data.defaultLanguage || data.languages[0] || "en",
  );
  const [previewMode, setPreviewMode] = useState<string>("single");

  const languageOptions = data.languages.map((code) => ({
    label: LANGUAGE_LABELS[code] ?? code,
    value: code,
  }));

  const handleSave = (key: string, fields: PromptFields) => {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("key", key);
    fd.set("systemPrompt", fields.systemPrompt);
    fd.set("userPrompt", fields.userPrompt);
    fd.set("model", fields.model);
    fd.set("maxTokens", fields.maxTokens);
    submit(fd, { method: "post" });
  };

  const handleReset = (key: string) => {
    const fd = new FormData();
    fd.set("intent", "reset");
    fd.set("key", key);
    submit(fd, { method: "post" });
  };

  const handlePreview = () => {
    const fd = new FormData();
    fd.set("intent", "preview");
    fd.set("key", previewMode);
    fd.set("language", previewLanguage);
    submit(fd, { method: "post" });
  };

  const preview = actionData?.preview ?? null;

  return (
    <Page
      title="AI & Prompts"
      subtitle="Edit the Claude prompts that write your post-purchase upsell copy."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {data.prompts.map((prompt) => (
              <PromptCard
                key={`${prompt.key}-v${prompt.version}`}
                prompt={prompt}
                saving={submittingIntent === "save" && submittingKey === prompt.key}
                resetting={
                  submittingIntent === "reset" && submittingKey === prompt.key
                }
                onSave={(fields) => handleSave(prompt.key, fields)}
                onReset={() => handleReset(prompt.key)}
              />
            ))}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Preview
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Generates live copy with the saved prompts, using the first
                  products of your catalog cache as a sample basket. The copy
                  cache is bypassed, so this always makes a fresh call. Save
                  your edits above before previewing them. For a pixel-faithful
                  preview of the full widget with layout, use Preview in the
                  navigation.
                </Text>
                <InlineStack gap="400" wrap blockAlign="end">
                  <Box minWidth="220px">
                    <Select
                      label="Language"
                      options={languageOptions}
                      value={previewLanguage}
                      onChange={setPreviewLanguage}
                    />
                  </Box>
                  <Box minWidth="220px">
                    <Select
                      label="Prompt"
                      options={[
                        { label: "Single product", value: "single" },
                        { label: "Bundle", value: "bundle" },
                        { label: "Sequenced offers", value: "sequential" },
                      ]}
                      value={previewMode}
                      onChange={setPreviewMode}
                    />
                  </Box>
                  <Button
                    variant="primary"
                    onClick={handlePreview}
                    loading={submittingIntent === "preview"}
                  >
                    Generate preview
                  </Button>
                </InlineStack>

                {preview && (
                  <>
                    <Divider />
                    <BlockStack gap="300">
                      <InlineStack gap="200">
                        <Badge>{`${preview.latencyMs} ms`}</Badge>
                        <Badge tone="info">
                          {LANGUAGE_LABELS[preview.language] ?? preview.language}
                        </Badge>
                        <Badge>
                          {PROMPT_LABELS[preview.key as PromptKey] ?? preview.key}
                        </Badge>
                        {preview.cached ? <Badge tone="info">Cached</Badge> : null}
                      </InlineStack>
                      {preview.fallbackUsed && (
                        <Banner tone="warning" title="Fallback copy was used">
                          <p>
                            Claude did not return usable copy (missing API key,
                            timeout, or an API error), so this is the
                            deterministic fallback template. Check the AI
                            section in Settings.
                          </p>
                        </Banner>
                      )}
                      <Text as="h3" variant="headingLg">
                        {preview.copy.headline}
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {preview.copy.body}
                      </Text>
                      <BlockStack gap="100">
                        {preview.copy.bullets.map((bullet, i) => (
                          <Text key={i} as="p" variant="bodyMd">
                            {`• ${bullet}`}
                          </Text>
                        ))}
                      </BlockStack>
                      {(preview.copy.paragraphs?.length ?? 0) > 0 && (
                        <BlockStack gap="200">
                          <Text as="h4" variant="headingSm" tone="subdued">
                            Why it works with your order
                          </Text>
                          {(preview.copy.paragraphs ?? []).map((paragraph, i) => (
                            <Text key={i} as="p" variant="bodyMd">
                              {paragraph}
                            </Text>
                          ))}
                        </BlockStack>
                      )}
                      {(preview.copy.proof?.length ?? 0) > 0 && (
                        <BlockStack gap="200">
                          <Text as="h4" variant="headingSm" tone="subdued">
                            What published research shows
                          </Text>
                          {(preview.copy.proof ?? []).map((line, i) => (
                            <Text key={i} as="p" variant="bodyMd">
                              {line}
                            </Text>
                          ))}
                        </BlockStack>
                      )}
                      {preview.copy.closer && (
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {preview.copy.closer}
                        </Text>
                      )}
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Template variables
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                These placeholders are replaced in both the system and the user
                prompt before every generation call. Current Claude models
                control sampling automatically, so there is no temperature
                setting — steer the style through the prompts instead.
              </Text>
              <Divider />
              {TEMPLATE_VARIABLES.map((variable) => (
                <BlockStack key={variable.name} gap="050">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {`{{${variable.name}}}`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {variable.description}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`e.g. ${variable.example}`}
                  </Text>
                </BlockStack>
              ))}
              <Divider />
              <Text as="h3" variant="headingSm">
                Output fields
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                The prompts ask Claude for a single JSON object with these
                fields. The long-form fields are only produced when the copy
                length is “long” (the default).
              </Text>
              {OUTPUT_FIELDS.map((field) => (
                <BlockStack key={field.name} gap="050">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {field.name}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {field.description}
                  </Text>
                </BlockStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
