// ─────────────────────────────────────────────────────────────────────────────
// Markets admin tab — proves the market → country → currency → language
// mapping is right before buyers see it.
//
// One row per MarketSetting with the synced facts (name, handle, countries,
// currency) and the app-level knobs (enabled, previewFxRate). The preview FX
// rate is used ONLY by the Preview page to simulate a market: live buyers see
// prices converted by Shopify on their own order, and the app reads the exact
// presentment rate from that order — it never invents FX for live buyers.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  Checkbox,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings } from "../services/settings.server";
import { syncMarketsAndLocales } from "../services/catalog.server";
import { LANGUAGE_LABELS, type AdminGraphql } from "../types";

// ── Server helpers ───────────────────────────────────────────────────────────

function fstr(fd: FormData, name: string, fallback = ""): string {
  const value = fd.get(name);
  return typeof value === "string" ? value : fallback;
}

interface MarketView {
  marketHandle: string;
  name: string;
  countries: string[];
  enabled: boolean;
  currency: string;
  languageOverride: string | null;
  discountOverride: number | null;
  maxOffersOverride: number | null;
  previewFxRate: number | null;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, marketRows, recentOrder, catalogCount] = await Promise.all([
    getSettings(shop),
    prisma.marketSetting.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    prisma.orderRecord.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { currency: true },
    }),
    prisma.productCache.count({ where: { shop } }),
  ]);

  const markets: MarketView[] = marketRows.map((m) => ({
    marketHandle: m.marketHandle,
    name: m.name,
    countries: jparse<string[]>(m.countriesJson, []).map((c) => String(c)),
    enabled: m.enabled,
    currency: (m.currency ?? "").trim(),
    languageOverride: m.languageOverride,
    discountOverride: m.discountOverride,
    maxOffersOverride: m.maxOffersOverride,
    previewFxRate: m.previewFxRate,
  }));

  // Shop currency label: engine math runs in shop currency, and every
  // OrderRecord stores it — the most recent order is the live source of
  // truth for the label. Cellexia's store currency is EUR, so that is the
  // fallback before the first order is recorded.
  const shopCurrency = recentOrder?.currency?.trim() || "EUR";

  // Health check 1 — markets whose base currency has not been synced yet.
  const noCurrency = markets.filter((m) => !m.currency).map((m) => m.name);

  // Health check 2 — a country claimed by MULTIPLE markets: the buyer-country
  // market lookup picks the first match, so overlaps make routing ambiguous.
  const marketsByCountry = new Map<string, string[]>();
  for (const m of markets) {
    const codes = new Set(
      m.countries.map((c) => c.trim().toUpperCase()).filter(Boolean),
    );
    for (const code of codes) {
      marketsByCountry.set(code, [...(marketsByCountry.get(code) ?? []), m.name]);
    }
  }
  const countryConflicts = [...marketsByCountry.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([country, names]) => ({ country, markets: names }))
    .sort((a, b) => a.country.localeCompare(b.country));

  // Health check 3 — enabled store languages no market routes to: not the
  // store default and not the languageOverride of any enabled market. Buyers
  // still reach them, but only when their own checkout locale matches.
  const overriddenLanguages = new Set(
    markets
      .filter((m) => m.enabled && m.languageOverride)
      .map((m) => String(m.languageOverride)),
  );
  const localeOnlyLanguages = settings.languages.filter(
    (l) => l !== settings.defaultLanguage && !overriddenLanguages.has(l),
  );

  return json({
    markets,
    languages: settings.languages,
    defaultLanguage: settings.defaultLanguage,
    shopCurrency,
    currencyFromOrders: Boolean(recentOrder?.currency?.trim()),
    catalogCount,
    health: { noCurrency, countryConflicts, localeOnlyLanguages },
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const respond = (ok: boolean, message: string, status = 200) =>
    json({ ok, message, intent }, { status });

  switch (intent) {
    case "resync": {
      try {
        await syncMarketsAndLocales(
          admin.graphql as unknown as AdminGraphql,
          shop,
        );
        return respond(true, "Markets and locales re-synced from Shopify.");
      } catch (error) {
        console.error("[markets] re-sync failed", error);
        return respond(false, "Market re-sync failed. Check the server logs.");
      }
    }

    case "saveRates": {
      const rows = jparse<
        Array<{
          marketHandle?: unknown;
          name?: unknown;
          enabled?: unknown;
          previewFxRate?: unknown;
        }>
      >(fstr(fd, "rowsJson", "[]"), []);

      // Validate everything before writing anything: a bad rate in one row
      // must not leave the table half-saved.
      const updates: Array<{
        marketHandle: string;
        enabled: boolean;
        previewFxRate: number | null;
      }> = [];
      for (const row of rows) {
        if (!row || typeof row.marketHandle !== "string" || !row.marketHandle) {
          continue;
        }
        const label =
          typeof row.name === "string" && row.name ? row.name : row.marketHandle;
        let rate: number | null = null;
        const raw = row.previewFxRate;
        if (raw !== null && raw !== undefined) {
          const text = String(raw).trim();
          if (text !== "") {
            // Accept a comma decimal separator ("1,08") when unambiguous.
            const normalized =
              text.includes(",") && !text.includes(".")
                ? text.replace(",", ".")
                : text;
            const n = Number(normalized);
            if (!Number.isFinite(n) || n <= 0) {
              return respond(
                false,
                `Preview FX rate for "${label}" must be a number greater than 0, or empty to unset.`,
                400,
              );
            }
            rate = n;
          }
        }
        updates.push({
          marketHandle: row.marketHandle,
          enabled: Boolean(row.enabled),
          previewFxRate: rate,
        });
      }

      for (const u of updates) {
        await prisma.marketSetting.updateMany({
          where: { shop, marketHandle: u.marketHandle },
          data: { enabled: u.enabled, previewFxRate: u.previewFxRate },
        });
      }
      return respond(
        true,
        updates.length > 0
          ? "Preview FX rates and market toggles saved."
          : "Nothing to save yet. Re-sync from Shopify to import your markets.",
      );
    }

    default:
      return respond(false, "Unknown action.", 400);
  }
};

// ── Client helpers ───────────────────────────────────────────────────────────

/** Per-row unsaved edits, keyed by marketHandle; absent = loader values. */
interface RowDraft {
  enabled: boolean;
  previewFxRate: string;
}

function CheckItem({
  tone,
  badge,
  children,
}: {
  tone?: "success" | "info" | "warning" | "critical";
  badge: string;
  children: ReactNode;
}) {
  return (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <Box>
        <Badge tone={tone}>{badge}</Badge>
      </Box>
      <Text as="p" variant="bodyMd">
        {children}
      </Text>
    </InlineStack>
  );
}

function countriesLabel(countries: string[]): string {
  if (countries.length === 0) return "No countries";
  const shown = countries.slice(0, 8).join(", ");
  const more = countries.length - 8;
  return more > 0 ? `${shown} +${more} more` : shown;
}

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ? `${LANGUAGE_LABELS[code]} (${code})` : code;
}

// ── Page component ───────────────────────────────────────────────────────────

export default function MarketsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const busy = (intent: string) =>
    navigation.state === "submitting" &&
    String(navigation.formData?.get("intent") ?? "") === intent;

  const send = (intent: string, fields: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    submit(fd, { method: "post" });
  };

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const draftFor = (m: (typeof data.markets)[number]): RowDraft =>
    drafts[m.marketHandle] ?? {
      enabled: m.enabled,
      previewFxRate: m.previewFxRate === null ? "" : String(m.previewFxRate),
    };
  const updateDraft = (
    m: (typeof data.markets)[number],
    patch: Partial<RowDraft>,
  ) =>
    setDrafts((prev) => {
      const base = prev[m.marketHandle] ?? {
        enabled: m.enabled,
        previewFxRate: m.previewFxRate === null ? "" : String(m.previewFxRate),
      };
      return { ...prev, [m.marketHandle]: { ...base, ...patch } };
    });

  // Drop the drafts once a save round-trips (revalidated loader data is in),
  // so the table shows exactly what was stored — including server-side
  // normalization of the rates.
  const consumedSaveRef = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (navigation.state !== "idle") return;
    if (!actionData || actionData.intent !== "saveRates" || !actionData.ok) {
      return;
    }
    if (consumedSaveRef.current === actionData) return;
    consumedSaveRef.current = actionData;
    setDrafts({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state, actionData]);

  const saveRates = () =>
    send("saveRates", {
      rowsJson: JSON.stringify(
        data.markets.map((m) => {
          const draft = draftFor(m);
          return {
            marketHandle: m.marketHandle,
            name: m.name,
            enabled: draft.enabled,
            // Sent as the raw string — the server parses and validates it, so
            // a typo errors loudly instead of silently becoming null.
            previewFxRate: draft.previewFxRate,
          };
        }),
      ),
    });

  const { health } = data;
  const enabledCount = data.markets.filter((m) => m.enabled).length;
  const enabledLanguageSet = new Set(data.languages);

  const tableRows = data.markets.map((m) => {
    const draft = draftFor(m);
    return [
      <Text key={`${m.marketHandle}-name`} as="span" fontWeight="semibold">
        {m.name}
      </Text>,
      <Text key={`${m.marketHandle}-handle`} as="span" tone="subdued">
        {m.marketHandle}
      </Text>,
      <Text key={`${m.marketHandle}-countries`} as="span">
        {countriesLabel(m.countries)}
      </Text>,
      <InlineStack
        key={`${m.marketHandle}-enabled`}
        gap="200"
        blockAlign="center"
        wrap={false}
      >
        <Checkbox
          label={`Offers enabled for ${m.name}`}
          labelHidden
          checked={draft.enabled}
          onChange={(v) => updateDraft(m, { enabled: v })}
        />
        {draft.enabled ? (
          <Badge tone="success">Enabled</Badge>
        ) : (
          <Badge>Disabled</Badge>
        )}
      </InlineStack>,
      m.currency ? (
        <Badge key={`${m.marketHandle}-currency`}>{m.currency}</Badge>
      ) : (
        <Badge key={`${m.marketHandle}-currency`} tone="warning">
          No currency synced
        </Badge>
      ),
      m.languageOverride ? (
        <InlineStack
          key={`${m.marketHandle}-language`}
          gap="100"
          blockAlign="center"
          wrap={false}
        >
          <Text as="span">{languageLabel(m.languageOverride)}</Text>
          {!enabledLanguageSet.has(m.languageOverride) && (
            <Badge tone="warning">(disabled language)</Badge>
          )}
        </InlineStack>
      ) : (
        <Text key={`${m.marketHandle}-language`} as="span" tone="subdued">
          Store default
        </Text>
      ),
      m.discountOverride === null ? (
        <Text key={`${m.marketHandle}-discount`} as="span" tone="subdued">
          Default
        </Text>
      ) : (
        <Text key={`${m.marketHandle}-discount`} as="span">
          {`${m.discountOverride}%`}
        </Text>
      ),
      m.maxOffersOverride === null ? (
        <Text key={`${m.marketHandle}-max`} as="span" tone="subdued">
          Default
        </Text>
      ) : (
        <Text key={`${m.marketHandle}-max`} as="span">
          {String(m.maxOffersOverride)}
        </Text>
      ),
      <Box key={`${m.marketHandle}-rate`} minWidth="180px">
        <TextField
          label={`Preview FX rate for ${m.name}`}
          labelHidden
          type="number"
          step={0.0001}
          min={0}
          value={draft.previewFxRate}
          onChange={(v) => updateDraft(m, { previewFxRate: v })}
          autoComplete="off"
          placeholder="e.g. 1.08"
          suffix={
            m.currency ? `${m.currency}/${data.shopCurrency}` : undefined
          }
          helpText="Used only by the Preview page to simulate this market. Live buyers use the exact rate from their own order."
        />
      </Box>,
    ];
  });

  return (
    <Page
      title="Markets"
      subtitle="Verify the market, country, currency and language mapping buyers will hit."
      primaryAction={{
        content: "Save rates & toggles",
        onAction: saveRates,
        loading: busy("saveRates"),
        disabled: data.markets.length === 0,
      }}
      secondaryActions={[
        {
          content: "Re-sync from Shopify",
          onAction: () => send("resync"),
          loading: busy("resync"),
        },
      ]}
    >
      <Layout>
        {/* ── Health checks ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Health checks
              </Text>
              <InlineStack gap="200" wrap>
                <Badge>{`Shop currency: ${data.shopCurrency}`}</Badge>
                <Badge>{`Default language: ${languageLabel(data.defaultLanguage)}`}</Badge>
                <Badge>{`${data.languages.length} languages enabled`}</Badge>
                <Badge>{`${enabledCount} of ${data.markets.length} markets enabled`}</Badge>
                <Badge>{`${data.catalogCount} products cached`}</Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {data.currencyFromOrders
                  ? "Shop currency label derived from your most recent recorded order."
                  : "No orders recorded yet, assuming EUR until the first order lands."}
              </Text>

              {health.noCurrency.length > 0 ? (
                <CheckItem tone="warning" badge="No currency synced">
                  {`${health.noCurrency.join(", ")} ${
                    health.noCurrency.length === 1 ? "has" : "have"
                  } no base currency yet. Re-sync from Shopify to pull each market's currency.`}
                </CheckItem>
              ) : data.markets.length > 0 ? (
                <CheckItem tone="success" badge="Currencies OK">
                  Every market has a synced base currency.
                </CheckItem>
              ) : null}

              {health.countryConflicts.length > 0 ? (
                <CheckItem tone="warning" badge="Country in several markets">
                  {`Some countries are listed by more than one market: ${health.countryConflicts
                    .map((c) => `${c.country} (${c.markets.join(", ")})`)
                    .join("; ")}. Buyers there follow the MOST SPECIFIC market (fewest countries), like Shopify — enable/disable that one to control the country.`}
                </CheckItem>
              ) : data.markets.length > 0 ? (
                <CheckItem tone="success" badge="Countries OK">
                  No country appears in more than one market.
                </CheckItem>
              ) : null}

              {health.localeOnlyLanguages.length > 0 && (
                <CheckItem tone="info" badge="Locale-only languages">
                  {`No market routes to ${health.localeOnlyLanguages.join(
                    ", ",
                  )} and none is the store default. Buyers see these languages only when their own checkout locale matches.`}
                </CheckItem>
              )}

              <Banner tone="warning" title="Markets that sell in a local currency never see the post-purchase page">
                <p>
                  Shopify only shows the one-click post-purchase page when
                  the checkout was in the shop currency ({data.shopCurrency});
                  a market whose base currency differs (see the currency
                  badge on each row) is excluded by Shopify itself, however
                  it is configured here — buyers there get the thank-you page
                  offer instead. Enabling such a market below still governs
                  its thank-you offers, discount and language overrides.
                </p>
              </Banner>
              <Banner tone="info">
                <p>
                  Live buyers always see prices in the display currency of
                  their own order: Shopify converts the order, and the app
                  reads the exact presentment rate implied by that order's
                  totals. The app never invents an FX rate for a live buyer.
                  The preview FX rates below feed the Preview page only, so
                  you can simulate any market before it gets traffic.
                </p>
              </Banner>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Markets table ── */}
        <Layout.Section>
          <Card padding="0">
            {data.markets.length === 0 ? (
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No markets synced yet. Import your Shopify Markets to see
                    the mapping.
                  </Text>
                  <Box>
                    <Button loading={busy("resync")} onClick={() => send("resync")}>
                      Re-sync from Shopify
                    </Button>
                  </Box>
                </BlockStack>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "Market",
                  "Handle",
                  "Countries",
                  "Enabled",
                  "Currency",
                  "Language override",
                  "Discount override",
                  "Max offers",
                  "Preview FX rate",
                ]}
                rows={tableRows}
              />
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Text as="p" variant="bodySm" tone="subdued">
            Language, discount and max-offer overrides are edited on the
            Settings page. Enabled toggles and preview FX rates save here.
          </Text>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
