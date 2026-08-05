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
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings, saveSettings } from "../services/settings.server";
import {
  autoPickWinners,
  resetExperimentStats,
} from "../services/recommendation.server";
import { syncMarketsAndLocales } from "../services/catalog.server";
import {
  CELLEXIA_LANGUAGES,
  DEFAULT_SETTINGS,
  LANGUAGE_LABELS,
  type AdminGraphql,
  type AppSettings,
  type DiscountTier,
  type OptimizeMetric,
} from "../types";

// ── Server helpers ───────────────────────────────────────────────────────────

function fstr(fd: FormData, name: string, fallback = ""): string {
  const value = fd.get(name);
  return typeof value === "string" ? value : fallback;
}

function fbool(fd: FormData, name: string): boolean {
  return fstr(fd, name) === "true";
}

function fnum(
  fd: FormData,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(fstr(fd, name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function fint(
  fd: FormData,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.round(fnum(fd, name, fallback, min, max));
}

function normFloat(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function normInt(value: unknown, min: number, max: number): number | null {
  const f = normFloat(value, min, max);
  return f === null ? null : Math.round(f);
}

// ── Loader / action ──────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, marketRows] = await Promise.all([
    getSettings(shop),
    prisma.marketSetting.findMany({ where: { shop }, orderBy: { name: "asc" } }),
  ]);

  return json({
    settings,
    markets: marketRows.map((m) => ({
      marketHandle: m.marketHandle,
      name: m.name,
      countries: jparse<string[]>(m.countriesJson, []),
      enabled: m.enabled,
      discountOverride: m.discountOverride,
      languageOverride: m.languageOverride,
      maxOffersOverride: m.maxOffersOverride,
    })),
    // Only a boolean crosses the wire — never the key itself.
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const respond = (ok: boolean, message: string, status = 200) =>
    json({ ok, message, intent }, { status });

  switch (intent) {
    case "general": {
      const displayMode = fstr(fd, "defaultDisplayMode");
      const copyLength = fstr(fd, "copyLength");
      const patch: Partial<AppSettings> = {
        enabled: fbool(fd, "enabled"),
        thankYouEnabled: fbool(fd, "thankYouEnabled"),
        singleProductOrderOffers: fint(fd, "singleProductOrderOffers", 1, 1, 3),
        multiProductOrderOffers: fint(fd, "multiProductOrderOffers", 3, 1, 3),
        defaultDisplayMode: displayMode === "bundle" ? "bundle" : "sequential",
        copyLength: copyLength === "long" ? "long" : "short",
        tone: fstr(fd, "tone", DEFAULT_SETTINGS.tone),
        brandContext: fstr(fd, "brandContext", DEFAULT_SETTINGS.brandContext),
        showComparePrice: fbool(fd, "showComparePrice"),
        countdown: {
          enabled: fbool(fd, "countdownEnabled"),
          minutes: fint(fd, "countdownMinutes", 10, 1, 60),
        },
      };
      await saveSettings(shop, patch);
      return respond(true, "General settings saved.");
    }

    case "discount": {
      const rawMode = fstr(fd, "mode");
      const mode: "fixed" | "tiered" | "ai" =
        rawMode === "fixed" ? "fixed" : rawMode === "ai" ? "ai" : "tiered";
      let min = fint(fd, "min", 10, 0, 90);
      let max = fint(fd, "max", 15, 0, 90);
      if (min > max) {
        const t = min;
        min = max;
        max = t;
      }
      const value = fint(fd, "value", 12, 0, 90);
      const tiers: DiscountTier[] = jparse<
        Array<{ minOrderValue: unknown; pct: unknown }>
      >(fstr(fd, "tiersJson", "[]"), [])
        .map((t) => ({
          minOrderValue: Number(t.minOrderValue),
          pct: Number(t.pct),
        }))
        .filter(
          (t) =>
            Number.isFinite(t.minOrderValue) &&
            Number.isFinite(t.pct) &&
            t.minOrderValue >= 0 &&
            t.pct >= 0 &&
            t.pct <= 90,
        )
        .sort((a, b) => a.minOrderValue - b.minOrderValue);
      await saveSettings(shop, { discount: { mode, value, min, max, tiers } });
      return respond(true, "Discount settings saved.");
    }

    case "hygiene": {
      await saveSettings(shop, {
        frequencyCapDays: fint(fd, "frequencyCapDays", 14, 0, 365),
        suppressionDays: fint(fd, "suppressionDays", 60, 0, 730),
        minInventory: fint(fd, "minInventory", 1, 0, 100000),
      });
      return respond(true, "Frequency & hygiene settings saved.");
    }

    case "optimization": {
      const rawMetric = fstr(fd, "optimizeMetric");
      const optimizeMetric: OptimizeMetric =
        rawMetric === "conversion" || rawMetric === "revenue_per_impression"
          ? rawMetric
          : "gp_per_impression";
      await saveSettings(shop, {
        optimizeMetric,
        rotation: {
          enabled: fbool(fd, "rotationEnabled"),
          explorationPct: fnum(fd, "explorationPct", 10, 0, 100),
          minImpressionsToPick: fint(fd, "minImpressionsToPick", 200, 0, 1000000),
          winnerConfidence: fnum(fd, "winnerConfidence", 0.95, 0.5, 0.999),
          autoPickWinner: fbool(fd, "autoPickWinner"),
        },
        weights: {
          compatibility: fnum(fd, "wCompatibility", 0.35, 0, 10),
          repeatPurchase: fnum(fd, "wRepeatPurchase", 0.2, 0, 10),
          acceptance: fnum(fd, "wAcceptance", 0.25, 0, 10),
          margin: fnum(fd, "wMargin", 0.2, 0, 10),
        },
      });
      return respond(true, "Optimization settings saved.");
    }

    case "reset-stats": {
      try {
        await resetExperimentStats(shop);
        return respond(true, "Experiment stats reset.");
      } catch (error) {
        console.error("[settings] reset experiment stats failed", error);
        return respond(false, "Could not reset experiment stats.");
      }
    }

    case "pick-winners": {
      try {
        const settings = await getSettings(shop);
        const picked = await autoPickWinners(shop, settings);
        return respond(
          true,
          picked > 0
            ? `Picked ${picked} new winner${picked === 1 ? "" : "s"}.`
            : "No new winners — not enough data or confidence yet.",
        );
      } catch (error) {
        console.error("[settings] pick winners failed", error);
        return respond(false, "Could not pick winners.");
      }
    }

    case "markets": {
      const rows = jparse<
        Array<{
          marketHandle: unknown;
          enabled: unknown;
          discountOverride: unknown;
          languageOverride: unknown;
          maxOffersOverride: unknown;
        }>
      >(fstr(fd, "rowsJson", "[]"), []);
      for (const row of rows) {
        if (!row || typeof row.marketHandle !== "string" || !row.marketHandle) {
          continue;
        }
        await prisma.marketSetting.updateMany({
          where: { shop, marketHandle: row.marketHandle },
          data: {
            enabled: Boolean(row.enabled),
            discountOverride: normFloat(row.discountOverride, 0, 90),
            languageOverride:
              typeof row.languageOverride === "string" && row.languageOverride
                ? row.languageOverride
                : null,
            maxOffersOverride: normInt(row.maxOffersOverride, 1, 3),
          },
        });
      }
      return respond(true, "Market overrides saved.");
    }

    case "resync-markets": {
      try {
        await syncMarketsAndLocales(
          admin.graphql as unknown as AdminGraphql,
          shop,
        );
        return respond(true, "Markets and locales re-synced from Shopify.");
      } catch (error) {
        console.error("[settings] market re-sync failed", error);
        return respond(false, "Market re-sync failed — check the server logs.");
      }
    }

    case "languages": {
      const current = await getSettings(shop);
      const selected = fd.getAll("languages").map(String).filter(Boolean);
      const order = [...new Set([...current.languages, ...CELLEXIA_LANGUAGES])];
      const languages = order.filter((l) => selected.includes(l));
      for (const l of selected) {
        if (!languages.includes(l)) languages.push(l);
      }
      if (languages.length === 0) languages.push("en");
      let defaultLanguage = fstr(fd, "defaultLanguage", "en");
      if (!languages.includes(defaultLanguage)) defaultLanguage = languages[0];
      await saveSettings(shop, { languages, defaultLanguage });
      return respond(true, "Languages saved.");
    }

    case "ai": {
      const provider = fstr(fd, "translationProvider");
      await saveSettings(shop, {
        aiEnabled: fbool(fd, "aiEnabled"),
        aiModel: fstr(fd, "aiModel", "claude-haiku-4-5"),
        aiTimeoutMs: fint(fd, "aiTimeoutMs", 2500, 500, 30000),
        translationProvider: provider === "deepl" ? "deepl" : "claude",
        translationModel: fstr(fd, "translationModel", "claude-sonnet-5"),
      });
      return respond(true, "AI settings saved.");
    }

    default:
      return respond(false, "Unknown action.", 400);
  }
};

// ── Client state shapes ──────────────────────────────────────────────────────

interface GeneralState {
  enabled: boolean;
  thankYouEnabled: boolean;
  singleProductOrderOffers: string;
  multiProductOrderOffers: string;
  defaultDisplayMode: string;
  copyLength: string;
  tone: string;
  brandContext: string;
  showComparePrice: boolean;
  countdownEnabled: boolean;
  countdownMinutes: string;
}

interface DiscountState {
  mode: string;
  value: string;
  min: string;
  max: string;
  tiers: Array<{ minOrderValue: string; pct: string }>;
}

interface HygieneState {
  frequencyCapDays: string;
  suppressionDays: string;
  minInventory: string;
}

interface OptimizationState {
  optimizeMetric: string;
  rotationEnabled: boolean;
  explorationPct: string;
  minImpressionsToPick: string;
  winnerConfidence: string;
  autoPickWinner: boolean;
  wCompatibility: string;
  wRepeatPurchase: string;
  wAcceptance: string;
  wMargin: string;
}

interface MarketRowState {
  marketHandle: string;
  name: string;
  countries: string[];
  enabled: boolean;
  discountOverride: string;
  languageOverride: string;
  maxOffersOverride: string;
}

interface AiState {
  aiEnabled: boolean;
  aiModel: string;
  aiTimeoutMs: string;
  translationProvider: string;
  translationModel: string;
}

const OFFER_COUNT_OPTIONS = [
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
];

const MAX_OFFERS_OVERRIDE_OPTIONS = [
  { label: "Store default", value: "" },
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
];

function aiModelOptions(current: string) {
  const options = [
    { label: "claude-haiku-4-5 (fast)", value: "claude-haiku-4-5" },
    { label: "claude-sonnet-5 (best)", value: "claude-sonnet-5" },
  ];
  if (!options.some((o) => o.value === current) && current) {
    options.push({ label: current, value: current });
  }
  return options;
}

// ── Page component ───────────────────────────────────────────────────────────

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const s = data.settings;

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const busy = (intent: string) =>
    navigation.state === "submitting" &&
    String(navigation.formData?.get("intent") ?? "") === intent;

  const saveSection = (
    intent: string,
    fields: Record<string, string | string[]> = {},
  ) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        for (const v of value) fd.append(key, v);
      } else {
        fd.set(key, value);
      }
    }
    submit(fd, { method: "post" });
  };

  // General
  const [general, setGeneral] = useState<GeneralState>({
    enabled: s.enabled,
    thankYouEnabled: s.thankYouEnabled,
    singleProductOrderOffers: String(s.singleProductOrderOffers),
    multiProductOrderOffers: String(s.multiProductOrderOffers),
    defaultDisplayMode: s.defaultDisplayMode,
    copyLength: s.copyLength,
    tone: s.tone,
    brandContext: s.brandContext,
    showComparePrice: s.showComparePrice,
    countdownEnabled: s.countdown.enabled,
    countdownMinutes: String(s.countdown.minutes),
  });
  const setG = (patch: Partial<GeneralState>) =>
    setGeneral((prev) => ({ ...prev, ...patch }));

  // Discount
  const [discount, setDiscount] = useState<DiscountState>({
    mode: s.discount.mode,
    value: String(s.discount.value),
    min: String(s.discount.min),
    max: String(s.discount.max),
    tiers: s.discount.tiers.map((t) => ({
      minOrderValue: String(t.minOrderValue),
      pct: String(t.pct),
    })),
  });
  const setD = (patch: Partial<DiscountState>) =>
    setDiscount((prev) => ({ ...prev, ...patch }));
  const updateTier = (
    index: number,
    patch: Partial<{ minOrderValue: string; pct: string }>,
  ) =>
    setDiscount((prev) => ({
      ...prev,
      tiers: prev.tiers.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    }));
  const removeTier = (index: number) =>
    setDiscount((prev) => ({
      ...prev,
      tiers: prev.tiers.filter((_, i) => i !== index),
    }));
  const addTier = () =>
    setDiscount((prev) => ({
      ...prev,
      tiers: [...prev.tiers, { minOrderValue: "0", pct: "10" }],
    }));

  // Frequency & hygiene
  const [hygiene, setHygiene] = useState<HygieneState>({
    frequencyCapDays: String(s.frequencyCapDays),
    suppressionDays: String(s.suppressionDays),
    minInventory: String(s.minInventory),
  });
  const setH = (patch: Partial<HygieneState>) =>
    setHygiene((prev) => ({ ...prev, ...patch }));

  // Optimization
  const [optimization, setOptimization] = useState<OptimizationState>({
    optimizeMetric: s.optimizeMetric,
    rotationEnabled: s.rotation.enabled,
    explorationPct: String(s.rotation.explorationPct),
    minImpressionsToPick: String(s.rotation.minImpressionsToPick),
    winnerConfidence: String(s.rotation.winnerConfidence),
    autoPickWinner: s.rotation.autoPickWinner,
    wCompatibility: String(s.weights.compatibility),
    wRepeatPurchase: String(s.weights.repeatPurchase),
    wAcceptance: String(s.weights.acceptance),
    wMargin: String(s.weights.margin),
  });
  const setO = (patch: Partial<OptimizationState>) =>
    setOptimization((prev) => ({ ...prev, ...patch }));

  // Markets
  const toMarketRow = (m: (typeof data.markets)[number]): MarketRowState => ({
    marketHandle: m.marketHandle,
    name: m.name,
    countries: m.countries,
    enabled: m.enabled,
    discountOverride:
      m.discountOverride === null ? "" : String(m.discountOverride),
    languageOverride: m.languageOverride ?? "",
    maxOffersOverride:
      m.maxOffersOverride === null ? "" : String(m.maxOffersOverride),
  });
  const [marketRows, setMarketRows] = useState<MarketRowState[]>(() =>
    data.markets.map(toMarketRow),
  );
  const marketsKey = data.markets.map((m) => m.marketHandle).join("|");
  useEffect(() => {
    setMarketRows(data.markets.map(toMarketRow));
    // Re-initialize only when the set of markets changes (e.g. after re-sync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketsKey]);
  const updateMarketRow = (index: number, patch: Partial<MarketRowState>) =>
    setMarketRows((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );

  // Languages
  const unionLanguages = [...new Set([...s.languages, ...CELLEXIA_LANGUAGES])];
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(
    s.languages,
  );
  const [defaultLanguage, setDefaultLanguage] = useState(s.defaultLanguage);
  const toggleLanguage = (code: string, checked: boolean) => {
    const set = new Set(selectedLanguages);
    if (checked) {
      set.add(code);
    } else if (set.size > 1) {
      set.delete(code);
    }
    const next = unionLanguages.filter((l) => set.has(l));
    setSelectedLanguages(next);
    if (!next.includes(defaultLanguage)) {
      setDefaultLanguage(next[0] ?? "en");
    }
  };

  // AI
  const [ai, setAi] = useState<AiState>({
    aiEnabled: s.aiEnabled,
    aiModel: s.aiModel,
    aiTimeoutMs: String(s.aiTimeoutMs),
    translationProvider: s.translationProvider,
    translationModel: s.translationModel,
  });
  const setA = (patch: Partial<AiState>) =>
    setAi((prev) => ({ ...prev, ...patch }));

  // Union of enabled languages and every stored override, so a stale override
  // (language later disabled) still displays as itself instead of "Store default".
  const marketLanguageCodes = [
    ...new Set([
      ...s.languages,
      ...data.markets
        .map((m) => m.languageOverride)
        .filter((code): code is string => Boolean(code)),
    ]),
  ];
  const marketLanguageOptions = [
    { label: "Store default", value: "" },
    ...marketLanguageCodes.map((code) => ({
      label: s.languages.includes(code)
        ? LANGUAGE_LABELS[code] ?? code
        : `${LANGUAGE_LABELS[code] ?? code} (disabled)`,
      value: code,
    })),
  ];

  return (
    <Page
      title="Settings"
      subtitle="Global configuration for post-purchase and thank-you offers."
    >
      <Layout>
        {/* ── General ── */}
        <Layout.AnnotatedSection
          id="general"
          title="General"
          description="Turn offers on or off and control how many are shown and how they display."
        >
          <Card>
            <BlockStack gap="400">
              <Checkbox
                label="Post-purchase offers enabled"
                checked={general.enabled}
                onChange={(v) => setG({ enabled: v })}
              />
              <Checkbox
                label="Thank-you page fallback enabled"
                helpText="Covers Apple Pay, Google Pay, PayPal and other orders Shopify excludes from the post-purchase page."
                checked={general.thankYouEnabled}
                onChange={(v) => setG({ thankYouEnabled: v })}
              />
              <InlineStack gap="400" wrap>
                <Box minWidth="220px">
                  <Select
                    label="Offers for single-product orders"
                    options={OFFER_COUNT_OPTIONS}
                    value={general.singleProductOrderOffers}
                    onChange={(v) => setG({ singleProductOrderOffers: v })}
                  />
                </Box>
                <Box minWidth="220px">
                  <Select
                    label="Offers for multi-product orders"
                    options={OFFER_COUNT_OPTIONS}
                    value={general.multiProductOrderOffers}
                    onChange={(v) => setG({ multiProductOrderOffers: v })}
                  />
                </Box>
              </InlineStack>
              <InlineStack gap="400" wrap>
                <Box minWidth="220px">
                  <Select
                    label="Default display mode"
                    options={[
                      {
                        label: "Sequential — one offer at a time",
                        value: "sequential",
                      },
                      { label: "Bundle — all offers on one page", value: "bundle" },
                    ]}
                    value={general.defaultDisplayMode}
                    onChange={(v) => setG({ defaultDisplayMode: v })}
                  />
                </Box>
                <Box minWidth="220px">
                  <Select
                    label="Default copy length"
                    options={[
                      { label: "Short", value: "short" },
                      { label: "Long", value: "long" },
                    ]}
                    value={general.copyLength}
                    onChange={(v) => setG({ copyLength: v })}
                  />
                </Box>
              </InlineStack>
              <TextField
                label="Copy tone"
                value={general.tone}
                onChange={(v) => setG({ tone: v })}
                multiline={2}
                autoComplete="off"
                helpText="Injected into every AI prompt as {{tone}}."
              />
              <TextField
                label="Brand context"
                value={general.brandContext}
                onChange={(v) => setG({ brandContext: v })}
                multiline={4}
                autoComplete="off"
                helpText="Injected into every AI prompt as {{brand_context}}."
              />
              <Checkbox
                label="Show compare-at price"
                checked={general.showComparePrice}
                onChange={(v) => setG({ showComparePrice: v })}
              />
              <InlineStack gap="400" wrap blockAlign="end">
                <Checkbox
                  label="Show countdown timer"
                  checked={general.countdownEnabled}
                  onChange={(v) => setG({ countdownEnabled: v })}
                />
                <Box minWidth="160px">
                  <TextField
                    label="Countdown minutes"
                    type="number"
                    value={general.countdownMinutes}
                    onChange={(v) => setG({ countdownMinutes: v })}
                    min={1}
                    max={60}
                    autoComplete="off"
                    disabled={!general.countdownEnabled}
                  />
                </Box>
              </InlineStack>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("general")}
                  onClick={() =>
                    saveSection("general", {
                      enabled: String(general.enabled),
                      thankYouEnabled: String(general.thankYouEnabled),
                      singleProductOrderOffers: general.singleProductOrderOffers,
                      multiProductOrderOffers: general.multiProductOrderOffers,
                      defaultDisplayMode: general.defaultDisplayMode,
                      copyLength: general.copyLength,
                      tone: general.tone,
                      brandContext: general.brandContext,
                      showComparePrice: String(general.showComparePrice),
                      countdownEnabled: String(general.countdownEnabled),
                      countdownMinutes: general.countdownMinutes,
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Discount ── */}
        <Layout.AnnotatedSection
          id="discount"
          title="Discount"
          description="How much discount each offer carries. All modes are clamped to the min/max range."
        >
          <Card>
            <BlockStack gap="400">
              <Select
                label="Mode"
                options={[
                  { label: "Fixed percentage", value: "fixed" },
                  { label: "Tiered by order total", value: "tiered" },
                  { label: "AI-adjusted (within min/max)", value: "ai" },
                ]}
                value={discount.mode}
                onChange={(v) => setD({ mode: v })}
              />
              <InlineStack gap="400" wrap>
                <Box minWidth="140px">
                  <TextField
                    label="Value"
                    type="number"
                    suffix="%"
                    value={discount.value}
                    onChange={(v) => setD({ value: v })}
                    min={0}
                    max={90}
                    autoComplete="off"
                    helpText="Used in fixed mode."
                    disabled={discount.mode !== "fixed"}
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label="Min"
                    type="number"
                    suffix="%"
                    value={discount.min}
                    onChange={(v) => setD({ min: v })}
                    min={0}
                    max={90}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label="Max"
                    type="number"
                    suffix="%"
                    value={discount.max}
                    onChange={(v) => setD({ max: v })}
                    min={0}
                    max={90}
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>
              {discount.mode === "tiered" && (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Tiers
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The highest tier whose minimum order value is at or below
                    the order total applies.
                  </Text>
                  {discount.tiers.map((tier, index) => (
                    <InlineStack key={index} gap="300" blockAlign="end" wrap>
                      <Box minWidth="180px">
                        <TextField
                          label="Min order value"
                          type="number"
                          value={tier.minOrderValue}
                          onChange={(v) => updateTier(index, { minOrderValue: v })}
                          min={0}
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="140px">
                        <TextField
                          label="Discount"
                          type="number"
                          suffix="%"
                          value={tier.pct}
                          onChange={(v) => updateTier(index, { pct: v })}
                          min={0}
                          max={90}
                          autoComplete="off"
                        />
                      </Box>
                      <Button
                        icon={DeleteIcon}
                        accessibilityLabel={`Remove tier ${index + 1}`}
                        onClick={() => removeTier(index)}
                      />
                    </InlineStack>
                  ))}
                  <Box>
                    <Button onClick={addTier}>Add tier</Button>
                  </Box>
                </BlockStack>
              )}
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("discount")}
                  onClick={() =>
                    saveSection("discount", {
                      mode: discount.mode,
                      value: discount.value,
                      min: discount.min,
                      max: discount.max,
                      tiersJson: JSON.stringify(discount.tiers),
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Frequency & hygiene ── */}
        <Layout.AnnotatedSection
          id="hygiene"
          title="Frequency & hygiene"
          description="Protect the customer experience: cap how often offers appear and never offer what the customer already owns."
        >
          <Card>
            <BlockStack gap="400">
              <TextField
                label="Frequency cap"
                type="number"
                suffix="days"
                value={hygiene.frequencyCapDays}
                onChange={(v) => setH({ frequencyCapDays: v })}
                min={0}
                max={365}
                autoComplete="off"
                helpText="Minimum days between post-purchase offers for the same customer."
              />
              <TextField
                label="Suppression window"
                type="number"
                suffix="days"
                value={hygiene.suppressionDays}
                onChange={(v) => setH({ suppressionDays: v })}
                min={0}
                max={730}
                autoComplete="off"
                helpText="Don't offer products the customer bought within this many days."
              />
              <TextField
                label="Minimum inventory"
                type="number"
                value={hygiene.minInventory}
                onChange={(v) => setH({ minInventory: v })}
                min={0}
                autoComplete="off"
                helpText="Hide offers whose variant has tracked stock below this."
              />
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("hygiene")}
                  onClick={() =>
                    saveSection("hygiene", {
                      frequencyCapDays: hygiene.frequencyCapDays,
                      suppressionDays: hygiene.suppressionDays,
                      minInventory: hygiene.minInventory,
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Optimization ── */}
        <Layout.AnnotatedSection
          id="optimization"
          title="Optimization"
          description="What the engine optimizes for, A/B rotation behavior, and ranking weights."
        >
          <Card>
            <BlockStack gap="400">
              <Select
                label="Optimize for"
                options={[
                  {
                    label: "Gross profit per impression",
                    value: "gp_per_impression",
                  },
                  { label: "Conversion (acceptance rate)", value: "conversion" },
                  {
                    label: "Revenue per impression",
                    value: "revenue_per_impression",
                  },
                ]}
                value={optimization.optimizeMetric}
                onChange={(v) => setO({ optimizeMetric: v })}
              />
              <Checkbox
                label="A/B rotation enabled"
                helpText="Thompson sampling across the candidates of each slot."
                checked={optimization.rotationEnabled}
                onChange={(v) => setO({ rotationEnabled: v })}
              />
              <InlineStack gap="400" wrap>
                <Box minWidth="160px">
                  <TextField
                    label="Exploration"
                    type="number"
                    suffix="%"
                    value={optimization.explorationPct}
                    onChange={(v) => setO({ explorationPct: v })}
                    min={0}
                    max={100}
                    autoComplete="off"
                    helpText="Impressions that keep exploring after a winner is picked."
                  />
                </Box>
                <Box minWidth="200px">
                  <TextField
                    label="Min impressions to pick"
                    type="number"
                    value={optimization.minImpressionsToPick}
                    onChange={(v) => setO({ minImpressionsToPick: v })}
                    min={0}
                    autoComplete="off"
                    helpText="Required before a winner can be declared."
                  />
                </Box>
                <Box minWidth="160px">
                  <TextField
                    label="Winner confidence"
                    type="number"
                    value={optimization.winnerConfidence}
                    onChange={(v) => setO({ winnerConfidence: v })}
                    min={0.5}
                    max={0.999}
                    step={0.01}
                    autoComplete="off"
                    helpText="Posterior probability threshold (0.5–0.999)."
                  />
                </Box>
              </InlineStack>
              <Checkbox
                label="Auto-pick winners"
                checked={optimization.autoPickWinner}
                onChange={(v) => setO({ autoPickWinner: v })}
              />
              <Divider />
              <Text as="h3" variant="headingSm">
                Ranking weights
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Used by auto-pilot scoring. Weights are normalized to sum to 1.
              </Text>
              <InlineStack gap="400" wrap>
                <Box minWidth="140px">
                  <TextField
                    label="Compatibility"
                    type="number"
                    step={0.05}
                    value={optimization.wCompatibility}
                    onChange={(v) => setO({ wCompatibility: v })}
                    min={0}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label="Repeat purchase"
                    type="number"
                    step={0.05}
                    value={optimization.wRepeatPurchase}
                    onChange={(v) => setO({ wRepeatPurchase: v })}
                    min={0}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label="Acceptance"
                    type="number"
                    step={0.05}
                    value={optimization.wAcceptance}
                    onChange={(v) => setO({ wAcceptance: v })}
                    min={0}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label="Margin"
                    type="number"
                    step={0.05}
                    value={optimization.wMargin}
                    onChange={(v) => setO({ wMargin: v })}
                    min={0}
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("optimization")}
                  onClick={() =>
                    saveSection("optimization", {
                      optimizeMetric: optimization.optimizeMetric,
                      rotationEnabled: String(optimization.rotationEnabled),
                      explorationPct: optimization.explorationPct,
                      minImpressionsToPick: optimization.minImpressionsToPick,
                      winnerConfidence: optimization.winnerConfidence,
                      autoPickWinner: String(optimization.autoPickWinner),
                      wCompatibility: optimization.wCompatibility,
                      wRepeatPurchase: optimization.wRepeatPurchase,
                      wAcceptance: optimization.wAcceptance,
                      wMargin: optimization.wMargin,
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" wrap>
                <Button
                  tone="critical"
                  loading={busy("reset-stats")}
                  onClick={() => saveSection("reset-stats")}
                >
                  Reset experiment stats
                </Button>
                <Button
                  loading={busy("pick-winners")}
                  onClick={() => saveSection("pick-winners")}
                >
                  Pick winners now
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Resetting clears impressions, accepts and winner flags on all
                rotation candidates. Picking winners runs the same check the
                dashboard runs automatically.
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Markets ── */}
        <Layout.AnnotatedSection
          id="markets"
          title="Markets"
          description="Per-market overrides, seeded from your Shopify Markets. Leave a field on its default to inherit the global setting."
        >
          <Card>
            <BlockStack gap="400">
              {marketRows.length === 0 && (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No markets synced yet. Click "Re-sync from Shopify" to import
                  your Shopify Markets.
                </Text>
              )}
              {marketRows.map((row, index) => (
                <BlockStack key={row.marketHandle} gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {row.name}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {row.countries.length > 0
                          ? `${row.countries.length} ${
                              row.countries.length === 1 ? "country" : "countries"
                            }: ${row.countries.slice(0, 8).join(", ")}${
                              row.countries.length > 8 ? "…" : ""
                            }`
                          : "No countries"}
                      </Text>
                    </BlockStack>
                    <Checkbox
                      label="Enabled"
                      checked={row.enabled}
                      onChange={(v) => updateMarketRow(index, { enabled: v })}
                    />
                  </InlineStack>
                  <InlineStack gap="300" wrap>
                    <Box minWidth="160px">
                      <TextField
                        label="Discount override"
                        type="number"
                        suffix="%"
                        placeholder="Default"
                        value={row.discountOverride}
                        onChange={(v) =>
                          updateMarketRow(index, { discountOverride: v })
                        }
                        min={0}
                        max={90}
                        autoComplete="off"
                      />
                    </Box>
                    <Box minWidth="200px">
                      <Select
                        label="Language override"
                        options={marketLanguageOptions}
                        value={row.languageOverride}
                        onChange={(v) =>
                          updateMarketRow(index, { languageOverride: v })
                        }
                      />
                    </Box>
                    <Box minWidth="160px">
                      <Select
                        label="Max offers override"
                        options={MAX_OFFERS_OVERRIDE_OPTIONS}
                        value={row.maxOffersOverride}
                        onChange={(v) =>
                          updateMarketRow(index, { maxOffersOverride: v })
                        }
                      />
                    </Box>
                  </InlineStack>
                  <Divider />
                </BlockStack>
              ))}
              <InlineStack align="end" gap="300">
                <Button
                  loading={busy("resync-markets")}
                  onClick={() => saveSection("resync-markets")}
                >
                  Re-sync from Shopify
                </Button>
                <Button
                  variant="primary"
                  loading={busy("markets")}
                  disabled={marketRows.length === 0}
                  onClick={() =>
                    saveSection("markets", {
                      rowsJson: JSON.stringify(
                        marketRows.map((r) => ({
                          marketHandle: r.marketHandle,
                          enabled: r.enabled,
                          discountOverride:
                            r.discountOverride.trim() === ""
                              ? null
                              : Number(r.discountOverride),
                          languageOverride: r.languageOverride || null,
                          maxOffersOverride:
                            r.maxOffersOverride === ""
                              ? null
                              : Number(r.maxOffersOverride),
                        })),
                      ),
                    })
                  }
                >
                  Save markets
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Languages ── */}
        <Layout.AnnotatedSection
          id="languages"
          title="Languages"
          description="Languages offers can be shown in. Synced from your store locales; you can enable or disable them here."
        >
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" wrap>
                {unionLanguages.map((code) => (
                  <Checkbox
                    key={code}
                    label={`${LANGUAGE_LABELS[code] ?? code} (${code})`}
                    checked={selectedLanguages.includes(code)}
                    onChange={(v) => toggleLanguage(code, v)}
                  />
                ))}
              </InlineStack>
              <Box maxWidth="280px">
                <Select
                  label="Default language"
                  options={selectedLanguages.map((code) => ({
                    label: LANGUAGE_LABELS[code] ?? code,
                    value: code,
                  }))}
                  value={defaultLanguage}
                  onChange={setDefaultLanguage}
                  helpText="Used when the buyer's locale matches no enabled language."
                />
              </Box>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("languages")}
                  onClick={() =>
                    saveSection("languages", {
                      languages: selectedLanguages,
                      defaultLanguage,
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── AI ── */}
        <Layout.AnnotatedSection
          id="ai"
          title="AI"
          description="Claude writes the offer copy in the buyer's language. Configure the model, time budget and translation provider."
        >
          <Card>
            <BlockStack gap="400">
              {!data.hasAnthropicKey && (
                <Banner tone="warning" title="ANTHROPIC_API_KEY is not set">
                  <p>
                    AI copy generation and Claude translations are disabled
                    until the key is configured in your server environment.
                    Buyers will see deterministic fallback copy instead.
                  </p>
                </Banner>
              )}
              <Checkbox
                label="AI copy enabled"
                helpText="When off, buyers see the deterministic fallback copy."
                checked={ai.aiEnabled}
                onChange={(v) => setA({ aiEnabled: v })}
              />
              <InlineStack gap="400" wrap>
                <Box minWidth="220px">
                  <Select
                    label="Copy model"
                    options={aiModelOptions(ai.aiModel)}
                    value={ai.aiModel}
                    onChange={(v) => setA({ aiModel: v })}
                  />
                </Box>
                <Box minWidth="160px">
                  <TextField
                    label="Timeout"
                    type="number"
                    suffix="ms"
                    value={ai.aiTimeoutMs}
                    onChange={(v) => setA({ aiTimeoutMs: v })}
                    min={500}
                    max={30000}
                    autoComplete="off"
                    helpText="Time budget before falling back to template copy."
                  />
                </Box>
              </InlineStack>
              <InlineStack gap="400" wrap>
                <Box minWidth="220px">
                  <Select
                    label="Translation provider"
                    options={[
                      { label: "Claude", value: "claude" },
                      { label: "DeepL", value: "deepl" },
                    ]}
                    value={ai.translationProvider}
                    onChange={(v) => setA({ translationProvider: v })}
                    helpText="DeepL requires DEEPL_API_KEY on the server."
                  />
                </Box>
                <Box minWidth="220px">
                  <Select
                    label="Translation model"
                    options={aiModelOptions(ai.translationModel)}
                    value={ai.translationModel}
                    onChange={(v) => setA({ translationModel: v })}
                    disabled={ai.translationProvider !== "claude"}
                  />
                </Box>
              </InlineStack>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy("ai")}
                  onClick={() =>
                    saveSection("ai", {
                      aiEnabled: String(ai.aiEnabled),
                      aiModel: ai.aiModel,
                      aiTimeoutMs: ai.aiTimeoutMs,
                      translationProvider: ai.translationProvider,
                      translationModel: ai.translationModel,
                    })
                  }
                >
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
