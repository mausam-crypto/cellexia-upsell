// ─────────────────────────────────────────────────────────────────────────────
// Module C — AI copy & translations (SPEC §5-C).
//
// - claudeComplete: raw fetch to the Anthropic Messages API (no SDK).
// - DEFAULT_PROMPTS + template variable substitution for editable prompts.
//   The prompts follow classic direct-response principles (Schwartz: channel
//   the desire the order already proves; Bencivenga: proof beats claims) —
//   long copyLength produces a lead + bullets + "Why it works with your
//   order" paragraphs + a calm closer, with zero urgency/scarcity pressure.
// - generateCopy: sha256-keyed CopyCache, timeout race against Claude,
//   deterministic per-language fallback, background cache warming on failure.
//   CopyCache packs {bullets, paragraphs, closer, proof} into the existing
//   bulletsJson column (no schema migration; legacy array rows and packed
//   rows without `pr` still parse — missing proof degrades to []).
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
import { effectiveDescription } from "./catalog.server";
import { getSettings } from "./settings.server";

// ── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Generous timeout for background cache warming and previews. */
const BACKGROUND_TIMEOUT_MS = 45_000;
/** Timeout for translation calls (admin-triggered, not buyer-latency-critical). */
const TRANSLATE_TIMEOUT_MS = 30_000;

const HEADLINE_MAX = 60;
/** Lead (OfferCopy.body) — the 1–2 sentence promise above the fold. */
const LEAD_MAX = 240;
const BULLET_MAX = 90;
/** Each "Why it works with your order" paragraph (long copy only). */
const PARAGRAPH_MAX = 450;
/** One-line reassurance rendered directly above the buttons. */
const CLOSER_MAX = 120;
/** Each "What published research shows" statement (long copy only). */
const PROOF_MAX = 200;
/**
 * Cap per-product description text injected into prompts (word-boundary).
 * Matches the Products-tab AI-context storage cap so nothing a merchant
 * writes is ever silently dropped — Claude handles this size trivially
 * (200K-token context; ~5K tokens per maxed-out product).
 */
const PROMPT_DESCRIPTION_MAX = 20_000;
/**
 * Safety valve for pathological baskets (many products × huge descriptions):
 * if the combined summaries exceed this, the per-product cap is halved until
 * they fit, so buyer-path latency stays bounded. In practice never triggered
 * below ~3 maxed-out products.
 */
const TOTAL_DESCRIPTION_BUDGET = 60_000;

// ── Prompt templates ─────────────────────────────────────────────────────────

export type PromptKey = "single" | "bundle" | "sequential";

const SYSTEM_CORE = `You are the senior direct-response copywriter for a premium anti-aging skincare brand, writing in the tradition of Eugene Schwartz and Gary Bencivenga: channel desire the customer has already proven, name the concrete mechanism behind the result, and prove every claim — proof beats claims, always.

Brand context: {{brand_context}}

Voice and tone: {{tone}}

You are writing a post-purchase upsell page shown seconds after a customer completed checkout. This is the most-aware audience there is: they proved their desire minutes ago with their own money, on these exact products. Do not re-sell the category and do not manufacture excitement — channel the desire their order already demonstrates onto the offered product. The offer can be added with ONE click, is charged to the payment method they just used, and ships together with their order at no extra shipping cost. The customer is in a moment of confidence about their purchase — extend that confidence, never question it.

Non-negotiable rules:
1. Write every field in the language with IETF code "{{language}}". Never mix languages. Use the formal/informal register typical of premium skincare retail in that market.
2. The customer's completed purchase was an excellent choice. NEVER imply it was wrong, incomplete, insufficient, or missing anything. Frame the offer as amplifying and protecting the results they already secured — never as fixing a gap.
3. Cosmetic claims only. No medical, drug-like, or therapeutic claims: nothing that "treats", "cures", "heals", "repairs damage", "regenerates cells", or is "clinically proven". Speak only about the look and feel of skin — visible smoothness, hydration, radiance, the feeling of firmness.
4. Premium register, zero pressure. No emojis, no ALL-CAPS words, at most one exclamation mark across all fields — zero is better. No urgency, scarcity, or countdown language of any kind: never "limited", "only today", "last chance", "while stocks last", "hurry". The page handles timing; your copy persuades with facts.
5. Be concrete and specific — facts persuade, adjectives don't. Each product in the brief comes with a description: mine those descriptions for ingredients, actives, mechanisms, textures and usage moments, and build the argument from them, never from generic category assumptions.
6. Mention the {{discount_pct}}% discount exactly once across all fields — in the lead OR the closer, never in the paragraphs or bullets — framed as a private post-purchase courtesy that is applied automatically. Prices are in {{currency}}; never invent numbers that are not in the brief.
7. The brief is the complete universe of products AND facts. NEVER mention, imply, or invent any product, size, format, sample, sachet, mini, gift, or set component that is not explicitly listed in the brief. Every product name in your copy must appear verbatim in the basket list or the offer list — and only offered products are being sold.
8. Use every product name EXACTLY as written in the brief — the names are already in the customer's language; never translate, shorten, or restyle a product name.
9. Fact discipline: every claim must trace to something stated in the brief — the product descriptions, the prices, or the brand context. No invented studies, statistics, awards, reviews, or ingredient percentages. If the brief lacks the proof for a claim, write the weaker statement that is true instead.
10. Research proof — the "proof" field ONLY. This is the single, narrow exception to rule 9's ban on studies, and every condition below is mandatory: (a) each statement is about exactly ONE ingredient, and that ingredient must appear BY NAME in the brief's product descriptions (e.g. retinol, vitamin C / ascorbic acid, peptides, hyaluronic acid, niacinamide, caffeine) — if the descriptions name no recognizable cosmetic ingredient, return "proof": []. (b) State only findings that are broadly established and replicated across the published literature — the kind summarized in dermatology reviews — never one study's isolated result. (c) NEVER invent or name specific journals, universities, authors, years, sample sizes, or precise percentages unless they are genuinely canonical; prefer formulations like "In published clinical studies, topical retinol has been shown to visibly reduce the appearance of fine lines over 8–12 weeks". (d) Each finding describes the INGREDIENT, never this product — "studies on niacinamide", never "studies on this cream". (e) Rule 3 applies in full: appearance, look and feel only, no medical claims. (f) Proof statements never mention the discount.

Output contract — any violation breaks the page:
- Respond with ONLY one minified JSON object. No markdown, no code fences, no text before or after it.
- Exact schema: {"headline": string, "lead": string, "bullets": string[], "paragraphs": string[], "closer": string, "proof": string[], "discount_suggestion": number|null}
- "headline": at most 60 characters, benefit-led, no trailing punctuation.
- "lead": 1–2 sentences, at most 240 characters — the promise: the concrete result the offered product adds on top of the order they just placed.
- "bullets": 3 or 4 items (unless the brief fixes an exact count), each at most 90 characters, no trailing periods. Each bullet is ONE concrete fact or benefit — an ingredient, a percentage from the brief, a mechanism, a texture, a sensory result. Never filler like "premium quality". A bullet may only reference products listed in the brief — never pad the list by inventing an item.
- "paragraphs": {{length}}
- "proof": when "paragraphs" are required (long copy), 2 or 3 statements, each at most ${PROOF_MAX} characters; otherwise the empty array []. The page renders them under the heading "What published research shows", so each statement must read like sourced evidence — calm, specific, factual, no hype. Governed entirely by rule 10: widely-established published findings about ingredients explicitly named in the brief's product descriptions; no recognizable named ingredient → [].
- "closer": ONE calm reassurance line, at most 120 characters — e.g. the guarantee or the ships-with-their-order framing. No urgency.
- "discount_suggestion": an integer percentage ONLY if you are confident a different discount inside the merchant's allowed range would clearly convert better for this specific basket; otherwise null.`;

export const DEFAULT_PROMPTS: Record<
  PromptKey,
  { systemPrompt: string; userPrompt: string }
> = {
  single: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page presents ONE complementary product. Sell the specific incremental result it adds on top of the order — not the product in isolation.`,
    userPrompt: `The customer just completed this order (each line carries that product's full description — ingredients, actions, textures, usage):
{{basket_summary}}

The product being offered (one-click add, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Work in two steps. First, mine the descriptions on both sides for actives, ingredients, mechanisms, textures and usage moments. Then select the ONE strongest connection between the offered product and what they just bought — a layering pair with a specific purchased product, a shared active carried to a new area (eyes, lips, neck, body), or the morning/evening rhythm the two complete — and build every field on that single connection. Their order already proves the desire; aim it at the offered product instead of restating it. Anchor the headline or the first bullet to a product they actually bought, using its exact name. The lead states the promise; the paragraphs deliver the mechanism, the proof and the tie-back to their order; the closer reassures. Mention the {{discount_pct}}% discount exactly once, in the lead or the closer. Return the JSON object only.`,
  },
  bundle: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page presents a SET of products offered as one decision, added together with one click. Sell the routine the set creates, not any single item.`,
    userPrompt: `The customer just completed this order (each line carries that product's full description — ingredients, actions, textures, usage):
{{basket_summary}}

The set being offered as ONE decision (all items added together with one click, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Write ONE combined copy block for the whole set. Mine every description for actives, ingredients, mechanisms, textures and usage moments, then select the ONE strongest way this set extends what the purchased products already do — how the pieces layer with them, divide the routine across morning and evening, or carry the same result across face, eyes and body — and build the copy on it. The headline sells the set as a whole. Bullets: write EXACTLY one bullet per offered product — two offered products means exactly two bullets, three means exactly three; this exact count overrides the default bullet count. Each bullet names one offered product by its exact name and states its one concrete role. Never write a bullet for a basket item, and never invent an extra item to fill a bullet. The paragraphs argue for the set as one routine: mechanism first, then proof drawn from the descriptions and brand context, then the tie-back to their order. Mention the {{discount_pct}}% discount exactly once — in the lead or the closer — as applying to the whole set. Return the JSON object only.`,
  },
  sequential: {
    systemPrompt:
      SYSTEM_CORE +
      `\n\nThis page is offer {{position}} of {{total_offers}} in a one-at-a-time sequence. Each page must take a genuinely different persuasive angle, so the customer never reads the same pitch twice.`,
    userPrompt: `The customer just completed this order (each line carries that product's full description — ingredients, actions, textures, usage):
{{basket_summary}}

This is offer {{position}} of {{total_offers}}, shown one page at a time after checkout. The product on this page (one-click add, {{discount_pct}}% off, ships with their order at no extra cost):
{{offer_summary}}

Choose the persuasive angle by position so no two pages repeat each other: position 1 — the single most natural routine companion to what they bought; position 2 — a different benefit dimension entirely, such as a new area (eyes, lips, neck, body) or a different time of day; position 3 — rounding out and protecting long-term results across the full routine. Within that angle, mine the descriptions for actives, ingredients, mechanisms, textures and usage moments, select the ONE strongest connection between this product and what they actually bought, and build lead, bullets and paragraphs on it — the desire is already proven by their order, so aim it rather than restate it. Anchor at least one field to a purchased product by its exact name. Do not reference other pages or other offers, and never suggest they should have bought more in the first place. Mention the {{discount_pct}}% discount exactly once, in the lead or the closer. Return the JSON object only.`,
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
    // max_tokens is a cap, not a target: on models with thinking on by
    // default (claude-sonnet-5+) it bounds thinking AND the JSON output
    // together, so a tight cap truncates mid-object. 4000 is headroom, not
    // spend — short outputs cost the same.
    maxTokens: 4000,
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
    ? `exactly 2 or 3 paragraphs, each 2–4 sentences and at most ${PARAGRAPH_MAX} characters, rendered under the heading "Why it works with your order". Paragraph 1 — the MECHANISM: how the offered product's ingredients and actions produce the visible result, concrete and specific to THIS product. Paragraph 2 — PROOF and believability: composition facts, textures, usage specifics, and the money-back guarantee from the brand context — only facts stated in the brief count as proof. Optional paragraph 3 — RELEVANCE: tie the offer back to the exact products they bought and the routine the two form together. Never mention the discount inside paragraphs. Below the paragraphs the page renders the "proof" research block — fill it per its own contract line and rule 10.`
    : `the empty array [] — this page uses only headline, lead and bullets; write no paragraphs, and return "proof": [] as well.`;
}

function buildBasketSummary(
  basket: Array<{ title: string; productType: string; quantity: number; description?: string }>,
  cap: number = PROMPT_DESCRIPTION_MAX,
): string {
  if (basket.length === 0) return "(no line items)";
  return basket
    .map((line) => {
      const head = `- ${line.quantity}× ${line.title}${line.productType ? ` (${line.productType})` : ""}`;
      const description = truncate((line.description ?? "").trim(), cap);
      return description ? `${head} — ${description}` : head;
    })
    .join("\n");
}

function buildOfferSummary(
  products: SelectedOfferProduct[],
  descriptions: Map<string, string>,
  currency: string,
  discountPct: number,
  cap: number = PROMPT_DESCRIPTION_MAX,
): string {
  return products
    .map((product) => {
      const title = product.translatedTitle ?? product.title;
      const discounted = product.price * (1 - discountPct / 100);
      const head = `${title}${product.productType ? ` (${product.productType})` : ""} — ${product.price.toFixed(2)} ${currency}, ${Math.round(discountPct)}% off → ${discounted.toFixed(2)} ${currency}`;
      const description = truncate(
        (descriptions.get(product.productId) ?? "").trim(),
        cap,
      );
      return description ? `- ${head}. ${description}` : `- ${head}`;
    })
    .join("\n");
}

/**
 * Copywriting grounding for the offered products: merchant aiDescription wins,
 * then the full synced description, then the short one (effectiveDescription).
 * Never throws — a failed lookup degrades to an empty map.
 */
async function loadOfferDescriptions(
  shop: string,
  productIds: string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  try {
    const rows = await prisma.productCache.findMany({
      where: { shop, productId: { in: productIds } },
      select: {
        productId: true,
        aiDescription: true,
        descriptionFull: true,
        descriptionShort: true,
      },
    });
    return new Map(rows.map((row) => [row.productId, effectiveDescription(row)]));
  } catch (error) {
    console.error(`[ai] product description lookup failed for ${shop}:`, error);
    return new Map();
  }
}

async function buildTemplateVars(args: GenerateCopyArgs): Promise<Record<string, string>> {
  const descriptions = await loadOfferDescriptions(
    args.shop,
    args.offerProducts.map((p) => p.productId),
  );
  // Feed everything the merchant stored; halve the per-product cap only if
  // the combined summaries blow the total safety budget.
  let cap = PROMPT_DESCRIPTION_MAX;
  let basketSummary = buildBasketSummary(args.basket, cap);
  let offerSummary = buildOfferSummary(
    args.offerProducts,
    descriptions,
    args.currency,
    args.discountPct,
    cap,
  );
  while (basketSummary.length + offerSummary.length > TOTAL_DESCRIPTION_BUDGET && cap > 1_000) {
    cap = Math.floor(cap / 2);
    basketSummary = buildBasketSummary(args.basket, cap);
    offerSummary = buildOfferSummary(
      args.offerProducts,
      descriptions,
      args.currency,
      args.discountPct,
      cap,
    );
  }
  return {
    brand_context: args.settings.brandContext,
    tone: args.settings.tone,
    language: args.language,
    length: lengthSpec(args.copyLength),
    basket_summary: basketSummary,
    offer_summary: offerSummary,
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

/** Non-empty strings from a model array, truncated at `max`, capped at `count`. */
function stringItems(value: unknown, max: number, count: number): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => truncate(item, max))
    .slice(0, count);
}

function validateModelCopy(
  parsed: Record<string, unknown>,
  copyLength: CopyLength,
): { copy: OfferCopy; discountSuggestion: number | null } {
  const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
  // The contract field is "lead"; merchant-edited legacy templates may still
  // instruct the model to emit "body" — accept either so old prompts keep
  // producing valid pages.
  const leadSource =
    typeof parsed.lead === "string" && parsed.lead.trim().length > 0
      ? parsed.lead
      : typeof parsed.body === "string"
        ? parsed.body
        : "";
  const lead = leadSource.trim();
  if (!headline || !lead) {
    throw new Error("Model output missing headline or lead");
  }
  const bullets = stringItems(parsed.bullets, BULLET_MAX, 4);
  // "short" is lead + bullets only — drop paragraphs even if the model wrote them.
  const paragraphs =
    copyLength === "long" ? stringItems(parsed.paragraphs, PARAGRAPH_MAX, 3) : [];
  // Research block is long-copy only — same discipline as paragraphs.
  const proof = copyLength === "long" ? stringItems(parsed.proof, PROOF_MAX, 3) : [];
  const closer =
    typeof parsed.closer === "string" ? truncate(parsed.closer.trim(), CLOSER_MAX) : "";
  const suggestionRaw = parsed.discount_suggestion;
  const discountSuggestion =
    typeof suggestionRaw === "number" && Number.isFinite(suggestionRaw)
      ? Math.round(suggestionRaw)
      : null;
  return {
    copy: {
      headline: truncate(headline, HEADLINE_MAX + 20),
      body: truncate(lead, LEAD_MAX + 60),
      bullets,
      paragraphs,
      closer,
      proof,
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
  basket: { title: string; productType: string; quantity: number; description?: string }[];
  offerProducts: SelectedOfferProduct[];
  discountPct: number;
  currency: string;
  copyLength: CopyLength;
  bypassCache?: boolean;
  timeoutMs?: number;
  /**
   * productId → effective description of the offered products (merchant AI
   * context > full description > short). Grounds the deterministic long-form
   * fallback paragraphs; generateCopy fills it internally when absent.
   */
  offerDescriptions?: Record<string, string>;
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

/**
 * CopyCache stores paragraphs/closer/proof WITHOUT a schema migration by
 * packing {b: bullets, p: paragraphs, c: closer, pr: proof} into the existing
 * bulletsJson column. Legacy rows hold a plain array (bullets only), and
 * packed rows written before the research block lack `pr` — both must keep
 * parsing, with missing proof degrading to [].
 */
function packBulletsJson(copy: OfferCopy): string {
  return jstr({
    b: copy.bullets,
    p: copy.paragraphs ?? [],
    c: copy.closer ?? "",
    pr: copy.proof ?? [],
  });
}

function unpackBulletsJson(bulletsJson: string): {
  bullets: string[];
  paragraphs: string[];
  closer: string;
  proof: string[];
} {
  const parsed = jparse<unknown>(bulletsJson, []);
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
  if (Array.isArray(parsed)) {
    // Legacy format: the column held the bullets array directly.
    return { bullets: strings(parsed), paragraphs: [], closer: "", proof: [] };
  }
  if (parsed && typeof parsed === "object") {
    const packed = parsed as Record<string, unknown>;
    return {
      bullets: strings(packed.b),
      paragraphs: strings(packed.p),
      closer: typeof packed.c === "string" ? packed.c : "",
      // Rows packed before the research block have no `pr` → [].
      proof: strings(packed.pr),
    };
  }
  return { bullets: [], paragraphs: [], closer: "", proof: [] };
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
      bulletsJson: packBulletsJson(copy),
      discountSuggestion,
    },
    create: {
      shop: args.shop,
      cacheKey,
      language: args.language,
      headline: copy.headline,
      body: copy.body,
      bulletsJson: packBulletsJson(copy),
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
        const extras = unpackBulletsJson(hit.bulletsJson);
        return {
          copy: {
            headline: hit.headline,
            body: hit.body,
            bullets: extras.bullets,
            paragraphs: extras.paragraphs,
            closer: extras.closer,
            proof: extras.proof,
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
      copy: fallbackCopy(await withOfferDescriptions(args), strings),
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
      copy: fallbackCopy(await withOfferDescriptions(args), strings),
      discountSuggestion: null,
      cached: false,
      fallbackUsed: true,
    };
  }
}

/**
 * Fill args.offerDescriptions ahead of a long-form fallback so its paragraphs
 * can be grounded in real product text. No-op for short copy or when the
 * caller already supplied descriptions. Never throws.
 */
async function withOfferDescriptions(args: GenerateCopyArgs): Promise<GenerateCopyArgs> {
  if (args.copyLength !== "long" || args.offerDescriptions) return args;
  const byId = await loadOfferDescriptions(
    args.shop,
    args.offerProducts.map((p) => p.productId),
  );
  return { ...args, offerDescriptions: Object.fromEntries(byId) };
}

/** First ~`count` sentences of a text, word-boundary capped at `max` chars. */
function firstSentences(text: string, count = 2, max = PARAGRAPH_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*/g);
  const joined = sentences
    ? sentences
        .slice(0, count)
        .map((sentence) => sentence.trim())
        .join(" ")
    : clean;
  return truncate(joined, max);
}

/** The sentence in the merchant's brand context that states the guarantee. */
function guaranteeLine(brandContext: string): string {
  const sentences = brandContext.match(/[^.!?…]+[.!?…]*/g) ?? [];
  const hit = sentences.find((sentence) => /guarantee|money.?back/i.test(sentence));
  return hit ? hit.trim() : "";
}

/**
 * Deterministic copy built only from translated UI strings and (translated)
 * product titles — used when AI is disabled, unavailable, or slower than the
 * timeout. For long copyLength it also grounds 1–2 paragraphs in the offered
 * products' effective descriptions (args.offerDescriptions, store language)
 * and closes with the merchant's guarantee line or the ships_free string —
 * real product/brand text only, never invented.
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
  const body = truncate(
    [s("offer_badge"), discountLine].filter(Boolean).join(" — "),
    LEAD_MAX,
  );
  const bullets = [saveLine, s("ships_free"), s("one_click_note")]
    .filter((b) => b.length > 0)
    .slice(0, 3);
  if (args.copyLength !== "long") {
    return { headline, body, bullets };
  }

  // Long form: one paragraph per offered product (first ~2 sentences of its
  // effective description), capped at 2. No description → no paragraph.
  const paragraphs = args.offerProducts
    .map((p) => firstSentences(args.offerDescriptions?.[p.productId] ?? ""))
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, 2);
  const closer = truncate(
    guaranteeLine(args.settings.brandContext) || s("ships_free"),
    CLOSER_MAX,
  );
  // Research proof stays EMPTY in the deterministic fallback — by design.
  // Even when a merchant's aiDescription/description contains an explicit
  // "studies/research/clinical" sentence, extracting it heuristically risks
  // rendering a mangled or out-of-context fragment under the "What published
  // research shows" heading — a fabricated-looking citation is the #1 risk of
  // this feature. Only the AI path, constrained by prompt rule 10, may
  // populate proof; empty simply hides the block.
  return { headline, body, bullets, paragraphs, closer, proof: [] };
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
