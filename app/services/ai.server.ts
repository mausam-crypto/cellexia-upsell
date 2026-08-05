// ─────────────────────────────────────────────────────────────────────────────
// Module C — AI copy & translations (SPEC §5-C).
//
// - claudeComplete: raw fetch to the Anthropic Messages API (no SDK).
// - DEFAULT_PROMPTS + template variable substitution for editable prompts.
// - generateCopy: sha256-keyed CopyCache, timeout race against Claude,
//   deterministic per-language fallback, background cache warming on failure.
// - UiString seeding + translation via Claude or DeepL.
//
// ensurePromptTemplates / ensureUiStrings / translateUiStrings never throw —
// they log and collect errors so bootstrap and admin actions degrade
// gracefully. translateTexts is the low-level primitive and DOES throw on
// provider failure; translateUiStrings catches it per language and reports it
// in `errors`.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import prisma from "../db.server";
import {
  DEFAULT_UI_STRINGS_EN,
  UI_STRING_KEYS,
  type AppSettings,
  type CopyLength,
  type OfferCopy,
  type SelectedOfferProduct,
} from "../types";
import { jparse, jstr } from "../lib/json";
import { getSettings } from "./settings.server";

// ── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Generous timeout for background cache warming and previews. */
const BACKGROUND_TIMEOUT_MS = 45_000;
/** Timeout for translation calls (admin-triggered, not buyer-latency-critical). */
const TRANSLATE_TIMEOUT_MS = 30_000;

const HEADLINE_MAX = 60;
const BULLET_MAX = 90;
const BODY_MAX_SHORT = 220;
const BODY_MAX_LONG = 450;

// ── Prompt templates ─────────────────────────────────────────────────────────

export type PromptKey = "single" | "bundle" | "sequential";

const SYSTEM_CORE = `You are the senior conversion copywriter for a premium anti-aging skincare brand.

Brand context: {{brand_context}}

Voice and tone: {{tone}}

You are writing the copy for a post-purchase upsell page shown seconds after a customer completed checkout. The offered product can be added with ONE click, is charged to the payment method they just used, and ships together with their order at no extra shipping cost. The customer is still in a moment of confidence about their purchase — your job is to extend that confidence, never to question it.

Non-negotiable rules:
1. Write every field in the language with IETF code "{{language}}". Never mix languages. Use the formal/informal register typical of premium skincare retail in that market.
2. The customer's completed purchase was an excellent choice. NEVER imply it was wrong, incomplete, insufficient, or missing anything. Frame the offer as amplifying and protecting the results they already secured — never as fixing a gap.
3. Cosmetic claims only. No medical, drug-like, or therapeutic claims: nothing that "treats", "cures", "heals", "repairs damage", "regenerates cells", or is "clinically proven". Speak only about the look and feel of skin — visible smoothness, hydration, radiance, the feeling of firmness.
4. No emojis. No ALL-CAPS words. No fake scarcity or invented urgency. At most one exclamation mark across all fields — zero is better.
5. Be concrete and specific. Name the offered product, and connect its benefit to at least one product that is already in the order.
6. Mention the {{discount_pct}}% discount exactly once, framed as a private post-purchase courtesy that is applied automatically. Prices are in {{currency}}; never invent numbers that are not in the brief.

Output contract — any violation breaks the page:
- Respond with ONLY one minified JSON object. No markdown, no code fences, no text before or after it.
- Exact schema: {"headline": string, "body": string, "bullets": string[], "discount_suggestion": number|null}
- "headline": at most 60 characters, benefit-led, no trailing punctuation.
- "body": {{length}}
- "bullets": exactly 2 or 3 items, each at most 90 characters, each a distinct concrete benefit, no trailing periods.
- "discount_suggestion": an integer percentage ONLY if you are confident a different discount inside the merchant's allowed range would clearly convert better for this specific basket; otherwise null.`;

export const DEFAULT_PROMPTS: Record<
  PromptKey,
  { systemPrompt: string; userPrompt: string }
> = {
  single: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page presents ONE complementary product. Sell the specific incremental result it adds on top of the order — not the product in isolation.`,
    userPrompt: `The customer just completed this order:
{{basket_summary}}

The product being offered (one-click add, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Write copy that makes adding it feel like the obvious next step. Name the concrete, incremental result this product delivers that their current order does not already cover — framed as building on what they bought: layering with it, completing the morning/evening rhythm, or extending their results to a new area (eyes, lips, neck, body). Anchor the headline or the first bullet to a product they actually bought. Work the {{discount_pct}}% discount naturally into the body. Return the JSON object only.`,
  },
  bundle: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page presents a SET of products offered as one decision, added together with one click. Sell the routine the set creates, not any single item.`,
    userPrompt: `The customer just completed this order:
{{basket_summary}}

The set being offered as ONE decision (all items added together with one click, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Write ONE combined copy block for the whole set. Explain why these products work better together and with the order the customer just placed — how they layer, how they divide the routine across morning and evening or across face, eyes and body, and how together they carry the results of the purchased products further. The headline sells the set as a whole. Give each offered product (or natural pairing) exactly one concrete role in one bullet. Mention the {{discount_pct}}% discount once, as applying to the whole set. Return the JSON object only.`,
  },
  sequential: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page is offer {{position}} of {{total_offers}} in a one-at-a-time sequence. Each page must take a genuinely different persuasive angle, so the customer never reads the same pitch twice.`,
    userPrompt: `The customer just completed this order:
{{basket_summary}}

This is offer {{position}} of {{total_offers}}, shown one page at a time after checkout. The product on this page (one-click add, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Choose the persuasive angle by position so no two pages repeat each other: position 1 — the single most natural routine companion to what they bought; position 2 — a different benefit dimension entirely, such as a new area (eyes, lips, neck, body) or a different time of day; position 3 — rounding out and protecting long-term results across the full routine. Do not reference other pages or other offers, and never suggest they should have bought more in the first place. Tie the benefit concretely to their basket, and mention the {{discount_pct}}% discount once. Return the JSON object only.`,
  },
};

const PROMPT_KEYS: PromptKey[] = ["single", "bundle", "sequential"];

/** Seed default prompt templates for a shop (never overwrites edits, never throws). */
export async function ensurePromptTemplates(shop: string): Promise<void> {
  for (const key of PROMPT_KEYS) {
    try {
      const existing = await prisma.promptTemplate.findUnique({
        where: { shop_key: { shop, key } },
      });
      if (existing) continue;
      await prisma.promptTemplate.create({
        data: {
          shop,
          key,
          systemPrompt: DEFAULT_PROMPTS[key].systemPrompt,
          userPrompt: DEFAULT_PROMPTS[key].userPrompt,
        },
      });
    } catch (error) {
      // Unique-constraint races on concurrent bootstrap are harmless.
      console.error(`[ai] ensurePromptTemplates failed for ${shop}/${key}:`, error);
    }
  }
}

interface ResolvedPromptTemplate {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  version: number;
}

async function getPromptTemplate(
  shop: string,
  key: PromptKey,
  settings: AppSettings,
): Promise<ResolvedPromptTemplate> {
  try {
    const row = await prisma.promptTemplate.findUnique({
      where: { shop_key: { shop, key } },
    });
    if (row) {
      return {
        systemPrompt: row.systemPrompt,
        userPrompt: row.userPrompt,
        model: row.model,
        temperature: row.temperature,
        maxTokens: row.maxTokens,
        version: row.version,
      };
    }
  } catch (error) {
    console.error(`[ai] prompt template lookup failed for ${shop}/${key}:`, error);
  }
  return {
    systemPrompt: DEFAULT_PROMPTS[key].systemPrompt,
    userPrompt: DEFAULT_PROMPTS[key].userPrompt,
    model: settings.aiModel,
    temperature: 0.7,
    maxTokens: 600,
    version: 1,
  };
}

// ── Claude Messages API ──────────────────────────────────────────────────────

/** Raw call to the Anthropic Messages API. Throws on HTTP error or timeout. */
export async function claudeComplete(args: {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /**
   * Ignored — kept only for signature compatibility. Sampling parameters
   * (temperature/top_p/top_k) are rejected with a 400 on claude-sonnet-5
   * (our default translationModel), claude-opus-5 and Claude 4.7+, so they
   * are never sent in the request body.
   */
  temperature?: number;
  timeoutMs: number;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    // No sampling params (temperature/top_p/top_k) — they 400 on
    // claude-sonnet-5 / claude-opus-5 / Claude 4.7+.
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (data.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  if (!text.trim()) throw new Error("Anthropic API returned no text content");
  return text;
}

// ── Template rendering ───────────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? "") : match,
  );
}

function lengthSpec(copyLength: CopyLength): string {
  return copyLength === "long"
    ? `up to ${BODY_MAX_LONG} characters — two to four sentences with room for texture and specifics.`
    : `at most ${BODY_MAX_SHORT} characters — one to two crisp sentences.`;
}

function buildBasketSummary(
  basket: Array<{ title: string; productType: string; quantity: number }>,
): string {
  if (basket.length === 0) return "(no line items)";
  return basket
    .map(
      (line) =>
        `${line.quantity}× ${line.title}${line.productType ? ` (${line.productType})` : ""}`,
    )
    .join("; ");
}

function buildOfferSummary(
  products: SelectedOfferProduct[],
  descriptions: Map<string, string>,
  currency: string,
  discountPct: number,
): string {
  return products
    .map((product) => {
      const title = product.translatedTitle ?? product.title;
      const discounted = product.price * (1 - discountPct / 100);
      const head = `${title}${product.productType ? ` (${product.productType})` : ""} — ${product.price.toFixed(2)} ${currency}, ${Math.round(discountPct)}% off → ${discounted.toFixed(2)} ${currency}`;
      const description = (descriptions.get(product.productId) ?? "").trim();
      return description ? `- ${head}. ${description}` : `- ${head}`;
    })
    .join("\n");
}

async function buildTemplateVars(args: GenerateCopyArgs): Promise<Record<string, string>> {
  let descriptions = new Map<string, string>();
  try {
    const rows = await prisma.productCache.findMany({
      where: {
        shop: args.shop,
        productId: { in: args.offerProducts.map((p) => p.productId) },
      },
      select: { productId: true, descriptionShort: true },
    });
    descriptions = new Map(rows.map((r) => [r.productId, r.descriptionShort]));
  } catch (error) {
    console.error(`[ai] product description lookup failed for ${args.shop}:`, error);
  }
  return {
    brand_context: args.settings.brandContext,
    tone: args.settings.tone,
    language: args.language,
    length: lengthSpec(args.copyLength),
    basket_summary: buildBasketSummary(args.basket),
    offer_summary: buildOfferSummary(
      args.offerProducts,
      descriptions,
      args.currency,
      args.discountPct,
    ),
    discount_pct: String(Math.round(args.discountPct)),
    currency: args.currency,
    position: String(args.position),
    total_offers: String(args.totalOffers),
  };
}

// ── Defensive parsing / validation of model output ───────────────────────────

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseModelObject(raw: string): Record<string, unknown> {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Model output contained no JSON object: ${text.slice(0, 120)}`);
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model output was not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseModelArray(raw: string): unknown[] {
  const text = stripFences(raw);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error(`Model output contained no JSON array: ${text.slice(0, 120)}`);
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Model output was not a JSON array");
  return parsed;
}

/** Word-boundary-aware truncation with an ellipsis. */
function truncate(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

function validateModelCopy(
  parsed: Record<string, unknown>,
  copyLength: CopyLength,
): { copy: OfferCopy; discountSuggestion: number | null } {
  const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!headline || !body) {
    throw new Error("Model output missing headline or body");
  }
  const bullets = (Array.isArray(parsed.bullets) ? parsed.bullets : [])
    .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    .map((b) => truncate(b, BULLET_MAX))
    .slice(0, 3);
  const suggestionRaw = parsed.discount_suggestion;
  const discountSuggestion =
    typeof suggestionRaw === "number" && Number.isFinite(suggestionRaw)
      ? Math.round(suggestionRaw)
      : null;
  const bodyMax = copyLength === "long" ? BODY_MAX_LONG : BODY_MAX_SHORT;
  return {
    copy: {
      headline: truncate(headline, HEADLINE_MAX + 20),
      body: truncate(body, bodyMax + 60),
      bullets,
    },
    discountSuggestion,
  };
}

// ── Copy generation ──────────────────────────────────────────────────────────

export interface GenerateCopyArgs {
  shop: string;
  settings: AppSettings;
  mode: PromptKey;
  position: number;
  totalOffers: number;
  language: string;
  basket: { title: string; productType: string; quantity: number }[];
  offerProducts: SelectedOfferProduct[];
  discountPct: number;
  currency: string;
  copyLength: CopyLength;
  bypassCache?: boolean;
  timeoutMs?: number;
}

function buildCacheKey(args: GenerateCopyArgs, promptVersion: number): string {
  const offerIds = args.offerProducts.map((p) => p.variantId).sort();
  // GenerateCopyArgs carries basket titles (no product ids) — the sorted titles
  // are the basket signature. Capped at 6 to keep the key stable for big carts.
  const basketSig = args.basket
    .map((line) => line.title)
    .sort()
    .slice(0, 6);
  // JSON.stringify keeps every component unambiguously delimited — titles or
  // ids containing "," / "|" can no longer collide with a different basket.
  const material = JSON.stringify([
    args.mode,
    offerIds,
    basketSig,
    args.language,
    args.copyLength,
    String(Math.round(args.discountPct)),
    String(promptVersion),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

async function generateAndCache(
  args: GenerateCopyArgs,
  template: ResolvedPromptTemplate,
  cacheKey: string,
  timeoutMs: number,
): Promise<{ copy: OfferCopy; discountSuggestion: number | null }> {
  const vars = await buildTemplateVars(args);
  const raw = await claudeComplete({
    model: template.model,
    system: renderTemplate(template.systemPrompt, vars),
    prompt: renderTemplate(template.userPrompt, vars),
    maxTokens: template.maxTokens,
    temperature: template.temperature,
    timeoutMs,
  });
  const { copy, discountSuggestion } = validateModelCopy(
    parseModelObject(raw),
    args.copyLength,
  );
  await prisma.copyCache.upsert({
    where: { shop_cacheKey: { shop: args.shop, cacheKey } },
    update: {
      language: args.language,
      headline: copy.headline,
      body: copy.body,
      bulletsJson: jstr(copy.bullets),
      discountSuggestion,
    },
    create: {
      shop: args.shop,
      cacheKey,
      language: args.language,
      headline: copy.headline,
      body: copy.body,
      bulletsJson: jstr(copy.bullets),
      discountSuggestion,
    },
  });
  return { copy, discountSuggestion };
}

async function safeGetUiStrings(
  shop: string,
  language: string,
): Promise<Record<string, string>> {
  try {
    return await getUiStrings(shop, language);
  } catch (error) {
    console.error(`[ai] UI string lookup failed for ${shop}/${language}:`, error);
    return { ...DEFAULT_UI_STRINGS_EN };
  }
}

/**
 * Generate (or fetch cached) buyer-facing offer copy.
 *
 * Cache-first; on miss races Claude against the configured timeout. On
 * timeout/error it returns deterministic fallback copy immediately AND fires
 * the same generation in the background (long timeout) to warm the cache for
 * the next buyer.
 */
export async function generateCopy(args: GenerateCopyArgs): Promise<{
  copy: OfferCopy;
  discountSuggestion: number | null;
  cached: boolean;
  fallbackUsed: boolean;
}> {
  const template = await getPromptTemplate(args.shop, args.mode, args.settings);
  const cacheKey = buildCacheKey(args, template.version);

  if (!args.bypassCache) {
    try {
      const hit = await prisma.copyCache.findUnique({
        where: { shop_cacheKey: { shop: args.shop, cacheKey } },
      });
      if (hit) {
        return {
          copy: {
            headline: hit.headline,
            body: hit.body,
            bullets: jparse<string[]>(hit.bulletsJson, []),
          },
          discountSuggestion: hit.discountSuggestion ?? null,
          cached: true,
          fallbackUsed: false,
        };
      }
    } catch (error) {
      console.error(`[ai] copy cache lookup failed for ${args.shop}:`, error);
    }
  }

  if (!args.settings.aiEnabled || !process.env.ANTHROPIC_API_KEY) {
    const strings = await safeGetUiStrings(args.shop, args.language);
    return {
      copy: fallbackCopy(args, strings),
      discountSuggestion: null,
      cached: false,
      fallbackUsed: true,
    };
  }

  const timeoutMs = args.timeoutMs ?? args.settings.aiTimeoutMs;
  try {
    const generated = await generateAndCache(args, template, cacheKey, timeoutMs);
    return {
      copy: generated.copy,
      discountSuggestion: generated.discountSuggestion,
      cached: false,
      fallbackUsed: false,
    };
  } catch (error) {
    console.error(
      `[ai] copy generation failed for ${args.shop} (${args.mode}, ${args.language}):`,
      error,
    );
    // Warm the cache for the next buyer — fire and forget, generous timeout.
    void generateAndCache(args, template, cacheKey, BACKGROUND_TIMEOUT_MS).catch(
      (bgError) =>
        console.error(`[ai] background cache warming failed for ${args.shop}:`, bgError),
    );
    const strings = await safeGetUiStrings(args.shop, args.language);
    return {
      copy: fallbackCopy(args, strings),
      discountSuggestion: null,
      cached: false,
      fallbackUsed: true,
    };
  }
}

/**
 * Deterministic, per-language-safe copy built only from translated UI strings
 * and (translated) product titles — used when AI is disabled, unavailable, or
 * slower than the timeout.
 */
export function fallbackCopy(
  args: GenerateCopyArgs,
  strings: Record<string, string>,
): OfferCopy {
  const s = (key: string): string => strings[key] ?? DEFAULT_UI_STRINGS_EN[key] ?? "";
  const pct = String(Math.round(args.discountPct));
  const titles = args.offerProducts.map((p) => p.translatedTitle ?? p.title);
  // A non-positive discount must never surface as "0% off" — omit the
  // discount phrasing entirely (e.g. thank-you offers whose code creation
  // failed are shown at full price).
  const hasDiscount = Math.round(args.discountPct) > 0;
  const discountLine = hasDiscount ? s("discount_applied").replace("{pct}", pct) : "";
  const saveLine = hasDiscount ? s("save_pct").replace("{pct}", pct) : "";

  const headline = truncate(titles.join(" + "), HEADLINE_MAX);
  const bodyMax = args.copyLength === "long" ? BODY_MAX_LONG : BODY_MAX_SHORT;
  const body = truncate(
    [s("offer_badge"), discountLine].filter(Boolean).join(" — "),
    bodyMax,
  );
  const bullets = [saveLine, s("ships_free"), s("one_click_note")]
    .filter((b) => b.length > 0)
    .slice(0, 3);
  return { headline, body, bullets };
}

// ── Buyer-facing UI strings ──────────────────────────────────────────────────

/**
 * Seed English UI strings from the defaults (skipping existing rows), then
 * best-effort translate missing strings for the other languages. Never throws.
 */
export async function ensureUiStrings(shop: string, languages: string[]): Promise<void> {
  try {
    const existing = await prisma.uiString.findMany({
      where: { shop, language: "en" },
      select: { key: true },
    });
    const have = new Set(existing.map((row) => row.key));
    const missing = UI_STRING_KEYS.filter((key) => !have.has(key));
    if (missing.length > 0) {
      await prisma.uiString.createMany({
        data: missing.map((key) => ({
          shop,
          language: "en",
          key,
          value: DEFAULT_UI_STRINGS_EN[key] ?? "",
        })),
      });
    }
  } catch (error) {
    console.error(`[ai] ensureUiStrings seeding failed for ${shop}:`, error);
  }

  const others = languages.filter((lang) => lang && lang !== "en");
  if (others.length === 0) return;
  try {
    const { errors } = await translateUiStrings(shop, others, { onlyMissing: true });
    for (const message of errors) {
      console.error(`[ai] ensureUiStrings translation issue for ${shop}: ${message}`);
    }
  } catch (error) {
    // translateUiStrings collects its own errors; this is belt-and-braces.
    console.error(`[ai] ensureUiStrings translation pass failed for ${shop}:`, error);
  }
}

/**
 * Resolve buyer-facing strings for a language with a per-key fallback chain:
 * requested language → base language ("pt-PT" → "pt") → "en" → built-in EN.
 */
export async function getUiStrings(
  shop: string,
  language: string,
): Promise<Record<string, string>> {
  const base = language.includes("-") ? (language.split("-")[0] ?? "") : "";
  const lookup = [language];
  if (base && base !== language) lookup.push(base);
  if (!lookup.includes("en")) lookup.push("en");

  const byLang = new Map<string, Map<string, string>>();
  try {
    const rows = await prisma.uiString.findMany({
      where: { shop, language: { in: lookup } },
    });
    for (const row of rows) {
      let bucket = byLang.get(row.language);
      if (!bucket) {
        bucket = new Map<string, string>();
        byLang.set(row.language, bucket);
      }
      bucket.set(row.key, row.value);
    }
  } catch (error) {
    console.error(`[ai] getUiStrings query failed for ${shop}/${language}:`, error);
  }

  const out: Record<string, string> = {};
  for (const key of UI_STRING_KEYS) {
    out[key] =
      byLang.get(language)?.get(key) ??
      (base ? byLang.get(base)?.get(key) : undefined) ??
      byLang.get("en")?.get(key) ??
      DEFAULT_UI_STRINGS_EN[key] ??
      "";
  }
  return out;
}

/** Placeholders like {pct} / {x} / {code} that must survive translation. */
function extractPlaceholders(text: string): string[] {
  return text.match(/\{[a-z_]+\}/g) ?? [];
}

/**
 * Translate UI strings into the given languages using the configured provider.
 * Never throws — failures are collected per language into `errors`.
 */
export async function translateUiStrings(
  shop: string,
  languages: string[],
  opts?: { onlyMissing?: boolean },
): Promise<{ translated: number; errors: string[] }> {
  const onlyMissing = opts?.onlyMissing ?? false;
  let translated = 0;
  const errors: string[] = [];

  let settings: AppSettings;
  try {
    settings = await getSettings(shop);
  } catch (error) {
    errors.push(
      `settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { translated, errors };
  }

  // English source values: merchant-edited rows win over built-in defaults.
  const sourceMap: Record<string, string> = { ...DEFAULT_UI_STRINGS_EN };
  try {
    const enRows = await prisma.uiString.findMany({ where: { shop, language: "en" } });
    for (const row of enRows) sourceMap[row.key] = row.value;
  } catch (error) {
    console.error(`[ai] English source lookup failed for ${shop}:`, error);
  }

  for (const language of languages) {
    if (!language || language === "en") continue;
    try {
      let keys = [...UI_STRING_KEYS];
      if (onlyMissing) {
        const existing = await prisma.uiString.findMany({
          where: { shop, language },
          select: { key: true },
        });
        const have = new Set(existing.map((row) => row.key));
        keys = keys.filter((key) => !have.has(key));
      }
      if (keys.length === 0) continue;

      const sources = keys.map((key) => sourceMap[key] ?? "");
      const values = await translateTexts(settings, sources, language);

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] ?? "";
        const source = sources[i] ?? "";
        const value = (values[i] ?? "").trim();
        if (!key) continue;
        if (!value) {
          errors.push(`${language}: empty translation for "${key}" — kept missing`);
          continue;
        }
        const lost = extractPlaceholders(source).filter((ph) => !value.includes(ph));
        if (lost.length > 0) {
          errors.push(`${language}: placeholder ${lost.join(", ")} lost in "${key}" — kept fallback`);
          continue;
        }
        await prisma.uiString.upsert({
          where: { shop_language_key: { shop, language, key } },
          update: { value },
          create: { shop, language, key, value },
        });
        translated++;
      }
    } catch (error) {
      errors.push(
        `${language}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { translated, errors };
}

// ── Translation providers ────────────────────────────────────────────────────

/**
 * Translate texts into `targetLang` with the provider from settings
 * (`claude` or `deepl`). Returns translations in input order. Throws on
 * provider failure — callers with an error channel (translateUiStrings)
 * catch and collect.
 */
export async function translateTexts(
  settings: AppSettings,
  texts: string[],
  targetLang: string,
): Promise<string[]> {
  if (texts.length === 0) return [];
  if (settings.translationProvider === "deepl") {
    return deeplTranslate(texts, targetLang);
  }
  return claudeTranslate(settings, texts, targetLang);
}

const DEEPL_LANG_OVERRIDES: Record<string, string> = {
  "pt-PT": "PT-PT",
  no: "NB",
};

function deeplTargetLang(lang: string): string {
  const override = DEEPL_LANG_OVERRIDES[lang];
  if (override) return override;
  return (lang.split("-")[0] ?? lang).slice(0, 2).toUpperCase();
}

async function deeplTranslate(texts: string[], targetLang: string): Promise<string[]> {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) throw new Error("DEEPL_API_KEY is not set");
  const host = apiKey.trim().endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";

  const body = new URLSearchParams();
  for (const text of texts) body.append("text", text);
  body.append("target_lang", deeplTargetLang(targetLang));

  const response = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey.trim()}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepL API error ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    translations?: Array<{ text?: string }>;
  };
  const out = (data.translations ?? []).map((t) => t.text ?? "");
  if (out.length !== texts.length) {
    throw new Error(`DeepL returned ${out.length} translations for ${texts.length} texts`);
  }
  return out;
}

async function claudeTranslate(
  settings: AppSettings,
  texts: string[],
  targetLang: string,
): Promise<string[]> {
  const system = `You are a professional e-commerce localization specialist translating storefront UI strings for a premium anti-aging skincare brand into the language with IETF code "${targetLang}".

Rules:
- Preserve placeholders wrapped in curly braces (such as {pct}, {x}, {y}, {code}) EXACTLY as written — never translate, remove, or reformat them.
- Keep each string short and natural for its role (button labels, badges, price rows). Match the register of premium beauty retail in that market.
- Do not add quotation marks, emojis, or explanations.
- Respond with ONLY a minified JSON array of strings — the translations in the SAME order and of the SAME length as the input array. No code fences, no commentary.`;

  const raw = await claudeComplete({
    model: settings.translationModel,
    system,
    prompt: JSON.stringify(texts),
    maxTokens: 2000,
    timeoutMs: TRANSLATE_TIMEOUT_MS,
  });
  const parsed = parseModelArray(raw);
  if (parsed.length !== texts.length) {
    throw new Error(
      `Claude returned ${parsed.length} translations for ${texts.length} texts`,
    );
  }
  // Non-string/empty elements become "" — never the English source text,
  // which would be upserted and permanently poison that language (onlyMissing
  // never retries an existing row). The empty-value guard in
  // translateUiStrings skips the upsert so the key stays missing.
  return parsed.map((value) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : "",
  );
}
