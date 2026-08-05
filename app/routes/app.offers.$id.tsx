import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Form,
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
  Checkbox,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  RadioButton,
  Select,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse, jstr } from "../lib/json";
import {
  EMPTY_TRIGGER,
  type DiscountStrategy,
  type RuleTrigger,
} from "../types";

// ── Form state (serialized into a hidden input on submit) ───────────────────

interface CandidateForm {
  productId: string;
  variantId: string;
  title: string;
  image: string | null;
  weight: string; // numeric string, edited via a type="number" TextField
  enabled: boolean;
  impressions: number;
  accepts: number;
  isWinner: boolean;
}

interface SlotForm {
  position: number; // 1..3
  candidates: CandidateForm[];
}

interface TriggerForm {
  products: { id: string; title: string }[];
  tags: string; // CSV
  productTypes: string; // CSV
  minItems: string;
  maxItems: string;
  minTotal: string;
  maxTotal: string;
  countries: string; // CSV of ISO codes
}

interface RuleFormState {
  name: string;
  enabled: boolean;
  priority: string;
  trigger: TriggerForm;
  displayMode: string; // "" = store default | "sequential" | "bundle"
  copyLength: string; // "" = store default | "short" | "long"
  maxOffers: string; // "1" | "2" | "3"
  discountMode: string; // "none" | "fixed"
  discountPct: string;
  discountMin: string;
  discountMax: string;
  slots: SlotForm[];
}

function blankFormState(): RuleFormState {
  return {
    name: "",
    enabled: true,
    priority: "0",
    trigger: {
      products: [],
      tags: "",
      productTypes: "",
      minItems: "",
      maxItems: "",
      minTotal: "",
      maxTotal: "",
      countries: "",
    },
    displayMode: "",
    copyLength: "",
    maxOffers: "3",
    discountMode: "none",
    discountPct: "12",
    discountMin: "10",
    discountMax: "15",
    slots: [
      { position: 1, candidates: [] },
      { position: 2, candidates: [] },
      { position: 3, candidates: [] },
    ],
  };
}

/** "gid://shopify/Product/123" → "Product 123" (fallback title). */
function shortGid(gid: string): string {
  const tail = String(gid).split("/").pop() ?? gid;
  return `Product ${tail}`;
}

// ── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id ?? "new";

  if (id === "new") {
    return json({ isNew: true, ruleId: null, formState: blankFormState() });
  }

  const rule = await prisma.offerRule.findFirst({
    where: { id, shop },
    include: {
      slots: {
        include: { candidates: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!rule) {
    throw redirect(`/app/offers?toast=${encodeURIComponent("Rule not found")}`);
  }

  const trigger: RuleTrigger = {
    ...EMPTY_TRIGGER,
    ...jparse<Partial<RuleTrigger>>(rule.triggerJson, {}),
  };

  // Enrich candidate + trigger products with title/image from the catalog cache.
  const productIds = new Set<string>(trigger.productIds ?? []);
  for (const slot of rule.slots) {
    for (const c of slot.candidates) productIds.add(c.productId);
  }
  const cached =
    productIds.size > 0
      ? await prisma.productCache.findMany({
          where: { shop, productId: { in: [...productIds] } },
          select: { productId: true, title: true, imageUrl: true },
        })
      : [];
  const info = new Map(cached.map((p) => [p.productId, p]));

  const slots: SlotForm[] = [1, 2, 3].map((position) => {
    const slot = rule.slots.find((s) => s.position === position);
    return {
      position,
      candidates: (slot?.candidates ?? []).map((c) => ({
        productId: c.productId,
        variantId: c.variantId,
        title: info.get(c.productId)?.title ?? shortGid(c.productId),
        image: info.get(c.productId)?.imageUrl ?? null,
        weight: String(c.weight),
        enabled: c.enabled,
        impressions: c.impressions,
        accepts: c.accepts,
        isWinner: c.isWinner,
      })),
    };
  });

  const discount = rule.discountJson
    ? jparse<Partial<DiscountStrategy>>(rule.discountJson, {})
    : null;

  const formState: RuleFormState = {
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    trigger: {
      products: (trigger.productIds ?? []).map((pid) => ({
        id: pid,
        title: info.get(pid)?.title ?? shortGid(pid),
      })),
      tags: (trigger.tags ?? []).join(", "),
      productTypes: (trigger.productTypes ?? []).join(", "),
      minItems: trigger.minItems == null ? "" : String(trigger.minItems),
      maxItems: trigger.maxItems == null ? "" : String(trigger.maxItems),
      minTotal: trigger.minTotal == null ? "" : String(trigger.minTotal),
      maxTotal: trigger.maxTotal == null ? "" : String(trigger.maxTotal),
      countries: (trigger.countries ?? []).join(", "),
    },
    displayMode: rule.displayMode ?? "",
    copyLength: rule.copyLength ?? "",
    maxOffers: String(rule.maxOffers ?? 3),
    discountMode: discount ? "fixed" : "none",
    discountPct: String(discount?.value ?? 12),
    discountMin: String(discount?.min ?? 10),
    discountMax: String(discount?.max ?? 15),
    slots,
  };

  return json({ isNew: false, ruleId: rule.id, formState });
};

// ── Action (save / delete) ──────────────────────────────────────────────────

function parseNullableNumber(value: string | undefined | null): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(value: string | undefined | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id ?? "new";
  const isNew = id === "new";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "delete") {
    if (!isNew) {
      try {
        await prisma.offerRule.deleteMany({ where: { id, shop } });
      } catch (error) {
        console.error("[offers] delete failed", error);
        return json({ errors: ["Deleting the rule failed. Try again."] }, { status: 500 });
      }
    }
    return redirect(`/app/offers?toast=${encodeURIComponent("Rule deleted")}`);
  }

  if (intent !== "save") {
    return json({ errors: ["Unknown action."] }, { status: 400 });
  }

  const state = jparse<RuleFormState | null>(String(form.get("state") ?? ""), null);
  if (!state) {
    return json({ errors: ["Invalid form payload."] }, { status: 400 });
  }

  // ── Validate ──
  const errors: string[] = [];
  const name = String(state.name ?? "").trim();
  if (!name) errors.push("Rule name is required.");

  const slots = (Array.isArray(state.slots) ? state.slots : [])
    .filter((s) => s && [1, 2, 3].includes(Number(s.position)))
    .map((s) => {
      const valid = (Array.isArray(s.candidates) ? s.candidates : []).filter(
        (c) =>
          c &&
          typeof c.productId === "string" &&
          c.productId.length > 0 &&
          typeof c.variantId === "string" &&
          c.variantId.length > 0,
      );
      // Dedupe per slot by variantId — first occurrence wins.
      const seen = new Set<string>();
      return {
        position: Number(s.position),
        candidates: valid.filter((c) => {
          if (seen.has(c.variantId)) return false;
          seen.add(c.variantId);
          return true;
        }),
      };
    });
  const slot1 = slots.find((s) => s.position === 1);
  if (!slot1 || slot1.candidates.length === 0) {
    errors.push("Slot 1 needs at least one product candidate.");
  }

  const discountMode = state.discountMode === "fixed" ? "fixed" : "none";
  const pct = Number(String(state.discountPct ?? "").trim());
  if (discountMode === "fixed" && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    errors.push("Discount percentage must be between 0 and 100.");
  }

  if (errors.length > 0) {
    return json({ errors }, { status: 400 });
  }

  // ── Build persisted shapes ──
  const trigger: RuleTrigger = {
    productIds: (Array.isArray(state.trigger?.products) ? state.trigger.products : [])
      .map((p) => String(p?.id ?? ""))
      .filter((pid) => pid.length > 0),
    tags: parseCsv(state.trigger?.tags),
    productTypes: parseCsv(state.trigger?.productTypes),
    minItems: parseNullableNumber(state.trigger?.minItems),
    maxItems: parseNullableNumber(state.trigger?.maxItems),
    minTotal: parseNullableNumber(state.trigger?.minTotal),
    maxTotal: parseNullableNumber(state.trigger?.maxTotal),
    countries: parseCsv(state.trigger?.countries).map((c) => c.toUpperCase()),
  };
  if (trigger.minItems != null) trigger.minItems = Math.max(0, Math.round(trigger.minItems));
  if (trigger.maxItems != null) trigger.maxItems = Math.max(0, Math.round(trigger.maxItems));

  let discountJson: string | null = null;
  if (discountMode === "fixed") {
    const clampPct = (n: number) => Math.min(100, Math.max(0, n));
    const rawMin = clampPct(parseNullableNumber(state.discountMin) ?? pct);
    const rawMax = clampPct(parseNullableNumber(state.discountMax) ?? pct);
    const min = Math.min(rawMin, rawMax);
    const max = Math.max(rawMin, rawMax);
    const strategy: DiscountStrategy = {
      mode: "fixed",
      value: clampPct(pct),
      min,
      max,
      tiers: [],
    };
    discountJson = jstr(strategy);
  }

  const priorityNum = parseNullableNumber(state.priority);
  const priority = priorityNum == null ? 0 : Math.round(priorityNum);
  const maxOffersNum = parseNullableNumber(state.maxOffers);
  const maxOffers = Math.min(3, Math.max(1, maxOffersNum == null ? 3 : Math.round(maxOffersNum)));
  const displayMode =
    state.displayMode === "sequential" || state.displayMode === "bundle"
      ? state.displayMode
      : null;
  const copyLength =
    state.copyLength === "short" || state.copyLength === "long"
      ? state.copyLength
      : null;

  const data = {
    name,
    enabled: Boolean(state.enabled),
    priority,
    triggerJson: jstr(trigger),
    displayMode,
    copyLength,
    maxOffers,
    discountJson,
  };

  try {
    await prisma.$transaction(async (tx) => {
      let ruleId: string;
      // Stats to carry over for candidates whose variantId survives the edit.
      const oldStats = new Map<
        string,
        { impressions: number; accepts: number; revenue: number; isWinner: boolean }
      >();

      if (isNew) {
        const created = await tx.offerRule.create({ data: { shop, ...data } });
        ruleId = created.id;
      } else {
        const existing = await tx.offerRule.findFirst({
          where: { id, shop },
          select: { id: true },
        });
        if (!existing) throw new Error(`rule ${id} not found for ${shop}`);

        const oldCandidates = await tx.offerCandidate.findMany({
          where: { slot: { ruleId: id } },
          include: { slot: { select: { position: true } } },
        });
        for (const c of oldCandidates) {
          const stats = {
            impressions: c.impressions,
            accepts: c.accepts,
            revenue: c.revenue,
            isWinner: c.isWinner,
          };
          // Prefer a same-slot match; fall back to any-slot match by variantId.
          oldStats.set(`${c.slot.position}:${c.variantId}`, stats);
          if (!oldStats.has(c.variantId)) oldStats.set(c.variantId, stats);
        }

        await tx.offerRule.update({ where: { id }, data });
        // Cascade removes candidates; they are recreated below with preserved stats.
        await tx.offerSlot.deleteMany({ where: { ruleId: id } });
        ruleId = id;
      }

      for (const slot of slots) {
        if (slot.candidates.length === 0) continue;
        await tx.offerSlot.create({
          data: {
            ruleId,
            position: slot.position,
            candidates: {
              create: slot.candidates.map((c) => {
                const stats =
                  oldStats.get(`${slot.position}:${c.variantId}`) ??
                  oldStats.get(c.variantId) ?? {
                    impressions: 0,
                    accepts: 0,
                    revenue: 0,
                    isWinner: false,
                  };
                const w = Number(c.weight);
                return {
                  productId: c.productId,
                  variantId: c.variantId,
                  // Weight 0 is valid ("parked" candidate); only NaN/negative coerce to 1.
                  weight: Number.isFinite(w) && w >= 0 ? w : 1,
                  enabled: Boolean(c.enabled),
                  impressions: stats.impressions,
                  accepts: stats.accepts,
                  revenue: stats.revenue,
                  isWinner: stats.isWinner,
                };
              }),
            },
          },
        });
      }
    });
  } catch (error) {
    console.error("[offers] save failed", error);
    return json(
      { errors: ["Saving failed — the rule may have been deleted. Go back to the rules list and try again."] },
      { status: 400 },
    );
  }

  return redirect(
    `/app/offers?toast=${encodeURIComponent(isNew ? "Rule created" : "Rule saved")}`,
  );
};

// ── Component ───────────────────────────────────────────────────────────────

/** Minimal shape of a product returned by the App Bridge resource picker. */
interface PickedProduct {
  id: string;
  title?: string;
  images?: { originalSrc?: string }[];
  variants?: { id?: string }[];
}

const DISPLAY_MODE_OPTIONS = [
  { label: "Store default", value: "" },
  { label: "Sequential (one page per product)", value: "sequential" },
  { label: "Bundle (all products on one page)", value: "bundle" },
];

const COPY_LENGTH_OPTIONS = [
  { label: "Store default", value: "" },
  { label: "Short", value: "short" },
  { label: "Long", value: "long" },
];

const MAX_OFFERS_OPTIONS = [
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
];

const SLOT_HINTS = [
  "Shown first — required. This is the highest-value page of the sequence.",
  "Shown second (multi-product orders only, when max offers allows).",
  "Shown third (multi-product orders only, when max offers allows).",
];

export default function OfferRuleEditorRoute() {
  const data = useLoaderData<typeof loader>();
  // Key by rule id so client state resets if the route stays mounted while
  // the id param changes (e.g. editor → editor navigation).
  return (
    <OfferRuleEditor
      key={data.ruleId ?? "new"}
      isNew={data.isNew}
      initialState={data.formState as RuleFormState}
    />
  );
}

function OfferRuleEditor({
  isNew,
  initialState,
}: {
  isNew: boolean;
  initialState: RuleFormState;
}) {
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [state, setState] = useState<RuleFormState>(() => initialState);
  const serialized = useMemo(() => JSON.stringify(state), [state]);
  const errors = actionData?.errors ?? [];

  const patch = (p: Partial<RuleFormState>) =>
    setState((s) => ({ ...s, ...p }));
  const patchTrigger = (p: Partial<TriggerForm>) =>
    setState((s) => ({ ...s, trigger: { ...s.trigger, ...p } }));
  const patchCandidate = (
    slotIndex: number,
    candidateIndex: number,
    p: Partial<CandidateForm>,
  ) =>
    setState((s) => ({
      ...s,
      slots: s.slots.map((slot, i) =>
        i !== slotIndex
          ? slot
          : {
              ...slot,
              candidates: slot.candidates.map((c, j) =>
                j === candidateIndex ? { ...c, ...p } : c,
              ),
            },
      ),
    }));
  const removeCandidate = (slotIndex: number, candidateIndex: number) =>
    setState((s) => ({
      ...s,
      slots: s.slots.map((slot, i) =>
        i !== slotIndex
          ? slot
          : {
              ...slot,
              candidates: slot.candidates.filter((_, j) => j !== candidateIndex),
            },
      ),
    }));

  /** Open the product picker and append the selection to a slot. */
  const addCandidate = async (slotIndex: number) => {
    const selected = (await shopify.resourcePicker({
      type: "product",
    })) as unknown as PickedProduct[] | undefined;
    if (!selected || selected.length === 0) return; // picker cancelled
    const picked = selected[0];
    const variantId = picked?.variants?.[0]?.id;
    if (!picked?.id || !variantId) {
      shopify.toast.show("Selected product has no variants", { isError: true });
      return;
    }
    if (
      state.slots[slotIndex]?.candidates.some((c) => c.variantId === variantId)
    ) {
      shopify.toast.show("This product is already in this slot", {
        isError: true,
      });
      return;
    }
    const candidate: CandidateForm = {
      productId: picked.id,
      variantId,
      title: picked.title ?? shortGid(picked.id),
      image: picked.images?.[0]?.originalSrc ?? null,
      weight: "1",
      enabled: true,
      impressions: 0,
      accepts: 0,
      isWinner: false,
    };
    setState((s) => ({
      ...s,
      slots: s.slots.map((slot, i) =>
        i !== slotIndex
          ? slot
          : { ...slot, candidates: [...slot.candidates, candidate] },
      ),
    }));
  };

  /** Open the multi-product picker for the trigger's product condition. */
  const pickTriggerProducts = async () => {
    const selected = (await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: state.trigger.products.map((p) => ({ id: p.id })),
    })) as unknown as PickedProduct[] | undefined;
    if (!selected) return; // picker cancelled — keep the current selection
    patchTrigger({
      products: selected
        .filter((p) => Boolean(p?.id))
        .map((p) => ({ id: p.id, title: p.title ?? shortGid(p.id) })),
    });
  };

  const removeTriggerProduct = (productId: string) =>
    patchTrigger({
      products: state.trigger.products.filter((p) => p.id !== productId),
    });

  const handleDelete = () => {
    submit({ intent: "delete" }, { method: "post" });
  };

  return (
    <Page
      title={isNew ? "New offer rule" : "Edit offer rule"}
      backAction={{ content: "Offer rules", url: "/app/offers" }}
    >
      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="state" value={serialized} />
        <Layout>
          {errors.length > 0 && (
            <Layout.Section>
              <Banner tone="critical" title="The rule could not be saved">
                <ul>
                  {errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </Banner>
            </Layout.Section>
          )}

          {/* ── 1. Basics ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Rule
                </Text>
                <FormLayout>
                  <TextField
                    label="Name"
                    value={state.name}
                    onChange={(value) => patch({ name: value })}
                    autoComplete="off"
                    requiredIndicator
                    placeholder="e.g. Serum buyers → eye serum"
                  />
                  <FormLayout.Group>
                    <TextField
                      label="Priority"
                      type="number"
                      value={state.priority}
                      onChange={(value) => patch({ priority: value })}
                      autoComplete="off"
                      helpText="Lower numbers are evaluated first. The first matching rule wins."
                    />
                    <Checkbox
                      label="Enabled"
                      checked={state.enabled}
                      onChange={(checked) => patch({ enabled: checked })}
                      helpText="Disabled rules are skipped; auto-pilot still runs as fallback."
                    />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── 2. Trigger ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Trigger
                  </Text>
                  <Text as="p" tone="subdued">
                    All conditions are combined with AND. Leave a condition
                    empty to match any order.
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Order contains any of these products
                  </Text>
                  {state.trigger.products.length > 0 && (
                    <InlineStack gap="200" wrap>
                      {state.trigger.products.map((p) => (
                        <Tag key={p.id} onRemove={() => removeTriggerProduct(p.id)}>
                          {p.title}
                        </Tag>
                      ))}
                    </InlineStack>
                  )}
                  <InlineStack>
                    <Button onClick={() => void pickTriggerProducts()}>
                      {state.trigger.products.length > 0
                        ? "Edit products"
                        : "Select products"}
                    </Button>
                  </InlineStack>
                </BlockStack>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Tags"
                      value={state.trigger.tags}
                      onChange={(value) => patchTrigger({ tags: value })}
                      autoComplete="off"
                      helpText="Comma-separated. Matches orders containing a product with any of these tags."
                    />
                    <TextField
                      label="Product types"
                      value={state.trigger.productTypes}
                      onChange={(value) => patchTrigger({ productTypes: value })}
                      autoComplete="off"
                      helpText="Comma-separated, e.g. Serum, Cream."
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField
                      label="Min distinct items"
                      type="number"
                      value={state.trigger.minItems}
                      onChange={(value) => patchTrigger({ minItems: value })}
                      autoComplete="off"
                    />
                    <TextField
                      label="Max distinct items"
                      type="number"
                      value={state.trigger.maxItems}
                      onChange={(value) => patchTrigger({ maxItems: value })}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField
                      label="Min order total"
                      type="number"
                      value={state.trigger.minTotal}
                      onChange={(value) => patchTrigger({ minTotal: value })}
                      autoComplete="off"
                      helpText="In shop currency."
                    />
                    <TextField
                      label="Max order total"
                      type="number"
                      value={state.trigger.maxTotal}
                      onChange={(value) => patchTrigger({ maxTotal: value })}
                      autoComplete="off"
                      helpText="In shop currency."
                    />
                  </FormLayout.Group>
                  <TextField
                    label="Countries"
                    value={state.trigger.countries}
                    onChange={(value) => patchTrigger({ countries: value })}
                    autoComplete="off"
                    helpText="Comma-separated ISO codes, e.g. FR, DE, US. Empty = all countries."
                  />
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── 3. Offers ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Offers
                  </Text>
                  <Text as="p" tone="subdued">
                    Each slot is one page in the sequenced flow. Add more than
                    one candidate to a slot to A/B rotate — Thompson sampling
                    picks among them and a winner is declared automatically once
                    there is enough data. Rotation stats are preserved for
                    candidates you keep.
                  </Text>
                </BlockStack>
                <FormLayout>
                  <FormLayout.Group>
                    <Select
                      label="Display mode"
                      options={DISPLAY_MODE_OPTIONS}
                      value={state.displayMode}
                      onChange={(value) => patch({ displayMode: value })}
                    />
                    <Select
                      label="Copy length"
                      options={COPY_LENGTH_OPTIONS}
                      value={state.copyLength}
                      onChange={(value) => patch({ copyLength: value })}
                    />
                    <Select
                      label="Max offers"
                      options={MAX_OFFERS_OPTIONS}
                      value={state.maxOffers}
                      onChange={(value) => patch({ maxOffers: value })}
                      helpText="Hard cap for this rule (1–3)."
                    />
                  </FormLayout.Group>
                </FormLayout>
                <BlockStack gap="300">
                  {state.slots.map((slot, slotIndex) => (
                    <Box
                      key={slot.position}
                      padding="300"
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                    >
                      <BlockStack gap="300">
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingSm">
                              Slot {slot.position}
                            </Text>
                            {slot.position === 1 && (
                              <Badge tone="attention">Required</Badge>
                            )}
                          </InlineStack>
                          <Text as="p" tone="subdued" variant="bodySm">
                            {SLOT_HINTS[slot.position - 1]}
                          </Text>
                        </BlockStack>
                        {slot.candidates.length === 0 ? (
                          <Text as="p" tone="subdued">
                            No candidates yet.
                          </Text>
                        ) : (
                          <BlockStack gap="200">
                            {slot.candidates.map((candidate, candidateIndex) => (
                              <BlockStack
                                key={`${candidate.variantId}-${candidateIndex}`}
                                gap="200"
                              >
                                {candidateIndex > 0 && <Divider />}
                                <InlineStack
                                  gap="300"
                                  blockAlign="center"
                                  wrap={false}
                                >
                                  <Thumbnail
                                    source={candidate.image ?? ImageIcon}
                                    alt={candidate.title}
                                    size="small"
                                  />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <BlockStack gap="050">
                                      <InlineStack gap="200" blockAlign="center">
                                        <Text
                                          as="span"
                                          variant="bodyMd"
                                          fontWeight="semibold"
                                        >
                                          {candidate.title}
                                        </Text>
                                        {candidate.isWinner && (
                                          <Badge tone="success">Winner</Badge>
                                        )}
                                      </InlineStack>
                                      <Text
                                        as="span"
                                        tone="subdued"
                                        variant="bodySm"
                                      >
                                        {candidate.accepts}/{candidate.impressions}{" "}
                                        accepted
                                      </Text>
                                    </BlockStack>
                                  </div>
                                  <div style={{ width: 96 }}>
                                    <TextField
                                      label="Weight"
                                      labelHidden
                                      type="number"
                                      min={0}
                                      step={0.1}
                                      value={candidate.weight}
                                      onChange={(value) =>
                                        patchCandidate(slotIndex, candidateIndex, {
                                          weight: value,
                                        })
                                      }
                                      autoComplete="off"
                                    />
                                  </div>
                                  <Checkbox
                                    label="Enabled"
                                    checked={candidate.enabled}
                                    onChange={(checked) =>
                                      patchCandidate(slotIndex, candidateIndex, {
                                        enabled: checked,
                                      })
                                    }
                                  />
                                  <Button
                                    variant="plain"
                                    tone="critical"
                                    onClick={() =>
                                      removeCandidate(slotIndex, candidateIndex)
                                    }
                                  >
                                    Remove
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            ))}
                          </BlockStack>
                        )}
                        <InlineStack>
                          <Button onClick={() => void addCandidate(slotIndex)}>
                            Add product
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── 4. Discount override ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Discount override
                  </Text>
                  <Text as="p" tone="subdued">
                    Overrides the store-wide discount strategy for offers issued
                    by this rule.
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  <RadioButton
                    label="Use store default discount settings"
                    id="discount-none"
                    name="discountModeChoice"
                    checked={state.discountMode !== "fixed"}
                    onChange={() => patch({ discountMode: "none" })}
                  />
                  <RadioButton
                    label="Fixed percentage for this rule"
                    id="discount-fixed"
                    name="discountModeChoice"
                    checked={state.discountMode === "fixed"}
                    onChange={() => patch({ discountMode: "fixed" })}
                  />
                </BlockStack>
                {state.discountMode === "fixed" && (
                  <FormLayout>
                    <FormLayout.Group condensed>
                      <TextField
                        label="Discount"
                        type="number"
                        suffix="%"
                        min={0}
                        max={100}
                        value={state.discountPct}
                        onChange={(value) => patch({ discountPct: value })}
                        autoComplete="off"
                      />
                      <TextField
                        label="Min clamp"
                        type="number"
                        suffix="%"
                        min={0}
                        max={100}
                        value={state.discountMin}
                        onChange={(value) => patch({ discountMin: value })}
                        autoComplete="off"
                        helpText="Lowest % ever applied."
                      />
                      <TextField
                        label="Max clamp"
                        type="number"
                        suffix="%"
                        min={0}
                        max={100}
                        value={state.discountMax}
                        onChange={(value) => patch({ discountMax: value })}
                        autoComplete="off"
                        helpText="Highest % ever applied."
                      />
                    </FormLayout.Group>
                  </FormLayout>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Actions ── */}
          <Layout.Section>
            <InlineStack align="end" gap="300">
              {!isNew && (
                <Button
                  tone="critical"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  Delete rule
                </Button>
              )}
              <Button variant="primary" submit loading={saving}>
                Save rule
              </Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Form>
    </Page>
  );
}
