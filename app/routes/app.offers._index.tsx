import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  EmptyState,
  IndexTable,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { EMPTY_TRIGGER, type RuleTrigger } from "../types";

// ── Loader ──────────────────────────────────────────────────────────────────

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  triggerSummary: string;
  slotCount: number;
  productCount: number;
  impressions30d: number;
  accepts30d: number;
}

/** Human-readable one-liner describing a rule's trigger conditions. */
function summarizeTrigger(triggerJson: string): string {
  const t: RuleTrigger = {
    ...EMPTY_TRIGGER,
    ...jparse<Partial<RuleTrigger>>(triggerJson, {}),
  };
  const parts: string[] = [];
  const productIds = t.productIds ?? [];
  const tags = t.tags ?? [];
  const productTypes = t.productTypes ?? [];
  const countries = t.countries ?? [];

  if (productIds.length > 0) {
    parts.push(
      productIds.length === 1
        ? "contains 1 specific product"
        : `contains any of ${productIds.length} products`,
    );
  }
  if (tags.length > 0) parts.push(`tags: ${tags.join(", ")}`);
  if (productTypes.length > 0) parts.push(`types: ${productTypes.join(", ")}`);

  if (t.minItems != null && t.maxItems != null) {
    parts.push(`${t.minItems}–${t.maxItems} distinct items`);
  } else if (t.minItems != null) {
    parts.push(`≥ ${t.minItems} distinct items`);
  } else if (t.maxItems != null) {
    parts.push(`≤ ${t.maxItems} distinct items`);
  }

  if (t.minTotal != null && t.maxTotal != null) {
    parts.push(`order total ${t.minTotal}–${t.maxTotal}`);
  } else if (t.minTotal != null) {
    parts.push(`order total ≥ ${t.minTotal}`);
  } else if (t.maxTotal != null) {
    parts.push(`order total ≤ ${t.maxTotal}`);
  }

  if (countries.length > 0) parts.push(`countries: ${countries.join(", ")}`);

  return parts.length > 0 ? parts.join(" · ") : "Any order";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const rules = await prisma.offerRule.findMany({
    where: { shop },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: {
      slots: { include: { candidates: { select: { productId: true } } } },
    },
  });

  // 30-day impression/accept counts per rule from the analytics event stream.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const grouped =
    rules.length > 0
      ? await prisma.offerEvent.groupBy({
          by: ["ruleId", "eventType"],
          where: {
            shop,
            createdAt: { gte: since },
            ruleId: { in: rules.map((r) => r.id) },
          },
          _count: { _all: true },
        })
      : [];

  const stats = new Map<string, { impressions: number; accepts: number }>();
  for (const g of grouped) {
    if (!g.ruleId) continue;
    const entry = stats.get(g.ruleId) ?? { impressions: 0, accepts: 0 };
    if (g.eventType === "impression") entry.impressions += g._count._all;
    if (g.eventType === "accepted") entry.accepts += g._count._all;
    stats.set(g.ruleId, entry);
  }

  const rows: RuleRow[] = rules.map((r) => {
    const productIds = new Set<string>();
    for (const slot of r.slots) {
      for (const c of slot.candidates) productIds.add(c.productId);
    }
    const s = stats.get(r.id) ?? { impressions: 0, accepts: 0 };
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      priority: r.priority,
      triggerSummary: summarizeTrigger(r.triggerJson),
      slotCount: r.slots.filter((slot) => slot.candidates.length > 0).length,
      productCount: productIds.size,
      impressions30d: s.impressions,
      accepts30d: s.accepts,
    };
  });

  return json({ rules: rows });
};

// ── Action (toggle / delete intents) ────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ruleId = String(form.get("ruleId") ?? "");

  try {
    if (intent === "toggle" && ruleId) {
      const enabled = String(form.get("enabled")) === "true";
      const result = await prisma.offerRule.updateMany({
        where: { id: ruleId, shop },
        data: { enabled },
      });
      if (result.count === 0) {
        return json({ ok: false, message: "Rule not found" }, { status: 404 });
      }
      return json({ ok: true, message: enabled ? "Rule enabled" : "Rule disabled" });
    }

    if (intent === "delete" && ruleId) {
      const result = await prisma.offerRule.deleteMany({
        where: { id: ruleId, shop },
      });
      if (result.count === 0) {
        return json({ ok: false, message: "Rule not found" }, { status: 404 });
      }
      return json({ ok: true, message: "Rule deleted" });
    }
  } catch (error) {
    console.error("[offers] action failed", error);
    return json({ ok: false, message: "Something went wrong" }, { status: 500 });
  }

  return json({ ok: false, message: "Unknown action" }, { status: 400 });
};

// ── Component ───────────────────────────────────────────────────────────────

export default function OfferRulesIndex() {
  const { rules } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toastParam = searchParams.get("toast");

  // Toast handed over from the editor via ?toast= after a save/delete redirect.
  useEffect(() => {
    if (!toastParam) return;
    shopify.toast.show(toastParam);
    const next = new URLSearchParams(searchParams);
    next.delete("toast");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastParam]);

  // Toast for toggle/delete actions on this page.
  useEffect(() => {
    if (!actionData?.message) return;
    shopify.toast.show(actionData.message, { isError: !actionData.ok });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  const toggleRule = (id: string, enabled: boolean) => {
    submit({ intent: "toggle", ruleId: id, enabled: String(enabled) }, { method: "post" });
  };
  const deleteRule = (id: string) => {
    submit({ intent: "delete", ruleId: id }, { method: "post" });
  };

  const emptyState = (
    <EmptyState
      heading="No offer rules yet"
      action={{ content: "Create rule", url: "/app/offers/new" }}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>
        You don't need a rule to start selling: auto-pilot is always on as a
        fallback and automatically picks the most profitable complementary
        products for every order. Create a rule when you want to hand-pick
        offers, A/B rotate candidates, or override the discount for specific
        baskets.
      </p>
    </EmptyState>
  );

  return (
    <Page
      title="Offer rules"
      subtitle="Hand-picked upsell offers with A/B rotation — auto-pilot covers everything else"
      primaryAction={{ content: "Create rule", url: "/app/offers/new" }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                How rules are evaluated
              </Text>
              <Text as="p" tone="subdued">
                Enabled rules run in priority order — the lowest priority number
                is checked first. The first rule whose trigger matches the order
                wins and supplies the offers (all trigger conditions are
                combined with AND; empty conditions match anything). When no
                rule matches, the auto-pilot engine takes over and ranks your
                whole catalog by compatibility, repeat-purchase behavior,
                acceptance history and gross profit per impression — so buyers
                always see an offer even with zero rules configured.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {rules.length === 0 ? (
              emptyState
            ) : (
              <IndexTable
                resourceName={{ singular: "rule", plural: "rules" }}
                itemCount={rules.length}
                selectable={false}
                headings={[
                  { title: "Rule" },
                  { title: "Status" },
                  { title: "Priority" },
                  { title: "Trigger" },
                  { title: "Products" },
                  { title: "30d acceptance" },
                  { title: "Actions" },
                ]}
              >
                {rules.map((rule, index) => {
                  const rate =
                    rule.impressions30d > 0
                      ? (rule.accepts30d / rule.impressions30d) * 100
                      : null;
                  return (
                    <IndexTable.Row
                      id={rule.id}
                      key={rule.id}
                      position={index}
                      onClick={() => navigate(`/app/offers/${rule.id}`)}
                    >
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {rule.name}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {rule.enabled ? (
                          <Badge tone="success">Enabled</Badge>
                        ) : (
                          <Badge>Disabled</Badge>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span">{rule.priority}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {rule.triggerSummary}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span">
                          {rule.productCount}{" "}
                          {rule.productCount === 1 ? "product" : "products"} in{" "}
                          {rule.slotCount} {rule.slotCount === 1 ? "slot" : "slots"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {rate == null ? (
                          <Text as="span" tone="subdued">
                            No data
                          </Text>
                        ) : (
                          <Text as="span">
                            {rate.toFixed(1)}% ({rule.accepts30d}/{rule.impressions30d})
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {/* Stop propagation so the buttons don't also open the editor. */}
                        <div onClick={(e) => e.stopPropagation()}>
                          <ButtonGroup>
                            <Button
                              size="slim"
                              onClick={() => toggleRule(rule.id, !rule.enabled)}
                            >
                              {rule.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => deleteRule(rule.id)}
                            >
                              Delete
                            </Button>
                          </ButtonGroup>
                        </div>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
