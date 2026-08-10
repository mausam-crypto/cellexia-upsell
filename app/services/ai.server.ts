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
//   The cache key is GROUNDING-AWARE: it includes the buyer-facing product
//   names (manual override → T&A → base title) and a signature of the
//   grounding descriptions, so fixing a name or editing AI context
//   regenerates copy on the next assembly instead of serving stale cache.
// - generateBuyerCopy / completeExtendedCopy: two-stage buyer path — one fast
//   CORE call (settings.coreCopyModel) inside the post-purchase time budget,
//   then a background call on the template's model for paragraphs/proof; the
//   merged result (never a core-only one) lands in CopyCache.
//   CopyCache packs {bullets, paragraphs, closer, proof} into the existing
//   bulletsJson column (no schema migration; legacy array rows and packed
//   rows without `pr` still parse — missing proof degrades to []).
// - UiString seeding + translation via Claude or DeepL. ensureUiStringsFresh
//   is the loader-cheap self-heal: keys added by app updates get seeded AND
//   auto-translated (scoped via translateUiStrings' keys option), and EN rows
//   still holding a superseded default (OLD_DEFAULTS) are upgraded with their
//   translations re-queued.
// - Buyer copy is em-dash/en-dash free by contract: SYSTEM_CORE rule 11 bans
//   them and stripDashes deterministically rewrites any that slip through —
//   in validateModelCopy, the extended-stage parse, and fallbackCopy alike.
//
// ensurePromptTemplates / ensureUiStrings / ensureUiStringsFresh /
// translateUiStrings never throw — they log and collect errors so bootstrap
// and admin actions degrade gracefully. translateTexts is the low-level
// primitive and DOES throw on provider failure; translateUiStrings catches it
// per language and reports it in `errors`.
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
import {
  effectiveDescription,
  effectiveTranslatedDescription,
  explainTranslatedDescription,
  languagesMatch,
} from "./catalog.server";
import { getSettings } from "./settings.server";
import { debugAdd, debugText, type DebugTrace } from "./debug.server";
import {
  applyFieldText,
  checkCopyLanguage,
  type FlaggedField,
} from "./language-guard.server";

// ── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Generous timeout for background cache warming and previews. */
const BACKGROUND_TIMEOUT_MS = 45_000;
/** Timeout for translation calls (admin-triggered, not buyer-latency-critical). */
const TRANSLATE_TIMEOUT_MS = 30_000;

// Two-tier length control: the PROMPT guides the model in words (models
// follow word counts far better than character counts), and the HARD caps
// below sit comfortably ABOVE that guidance so a natural overrun is shown
// intact instead of being chopped mid-sentence with an ellipsis (the "text
// not displayed completely" bug). Truncation is a last resort for runaway
// output, not the enforcement mechanism.
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
// Hard display caps (validator-side) — generous buffers over the guidance.
const BULLET_HARD_MAX = 170;
const PARAGRAPH_HARD_MAX = 620;
const CLOSER_HARD_MAX = 170;
const PROOF_HARD_MAX = 280;
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
1. Write every field in the language with IETF code "{{language}}". Never mix languages. This includes "proof" and "closer": research statements and reassurance lines are written in that language too. These instructions and their example sentences are in English, but your output must be in "{{language}}" unless that IS the language. Use the formal/informal register typical of premium skincare retail in that market.
2. The customer's completed purchase was an excellent choice. NEVER imply it was wrong, incomplete, insufficient, or missing anything. Frame the offer as amplifying and protecting the results they already secured — never as fixing a gap.
3. Cosmetic claims only. No medical, drug-like, or therapeutic claims: nothing that "treats", "cures", "heals", "repairs damage", "regenerates cells", or is "clinically proven". Speak only about the look and feel of skin — visible smoothness, hydration, radiance, the feeling of firmness.
4. Premium register, zero pressure. No emojis, no ALL-CAPS words, at most one exclamation mark across all fields — zero is better. No urgency, scarcity, or countdown language of any kind: never "limited", "only today", "last chance", "while stocks last", "hurry". The page handles timing; your copy persuades with facts.
5. Be concrete and specific — facts persuade, adjectives don't. Each product in the brief comes with a description: mine those descriptions for ingredients, actives, mechanisms, textures and usage moments, and build the argument from them, never from generic category assumptions. When the offered product serves a DIFFERENT area or purpose than the basket products (e.g. a face serum offered after a body cream), present it honestly as EXTENDING the routine to that new area — never claim it enhances, boosts, or completes the basket products' own results unless a description explicitly states a direct interaction.
6. Mention the {{discount_pct}}% discount exactly once across all fields — in the lead OR the closer, never in the paragraphs or bullets — framed as a private post-purchase courtesy that is applied automatically. Prices are in {{currency}}; never invent numbers that are not in the brief.
7. The brief is the complete universe of products AND facts. NEVER mention, imply, or invent any product, size, format, sample, sachet, mini, gift, or set component that is not explicitly listed in the brief. Every product name in your copy must appear verbatim in the basket list or the offer list — and only offered products are being sold.
8. Use every product name EXACTLY as written at the START of its brief line — those name fields are already in the customer's language; never translate, shorten, or restyle a product name. Descriptions are grounding material only: they may be written in another language and may refer to a product under a different or translated name — NEVER take a product name from inside a description text.
9. Fact discipline: every claim must trace to something stated in the brief — the product descriptions, the prices, or the brand context. No invented studies, statistics, awards, reviews, or ingredient percentages. If the brief lacks the proof for a claim, write the weaker statement that is true instead.
10. Research proof — the "proof" field ONLY. This is the single, narrow exception to rule 9's ban on studies, and every condition below is mandatory: (a) each statement is about exactly ONE ingredient, and that ingredient must appear BY NAME in the brief's product descriptions (e.g. retinol, vitamin C / ascorbic acid, peptides, hyaluronic acid, niacinamide, caffeine) — if the descriptions name no recognizable cosmetic ingredient, return "proof": []. (b) State only findings that are broadly established and replicated across the published literature — the kind summarized in dermatology reviews — never one study's isolated result. (c) NEVER invent or name specific journals, universities, authors, years, sample sizes, or precise percentages unless they are genuinely canonical; prefer formulations like "In published clinical studies, topical retinol has been shown to visibly reduce the appearance of fine lines over 8–12 weeks". (d) Each finding describes the INGREDIENT, never this product — "studies on niacinamide", never "studies on this cream". (e) Rule 3 applies in full: appearance, look and feel only, no medical claims. (f) Proof statements never mention the discount.
11. Never use em dashes (—) or en dashes (–) anywhere in your output, in any language. Use a comma, colon, or period instead.

Output contract — any violation breaks the page:
- Respond with ONLY one minified JSON object. No markdown, no code fences, no text before or after it.
- Exact schema: {"headline": string, "lead": string, "bullets": string[], "paragraphs": string[], "closer": string, "proof": string[], "discount_suggestion": number|null}
- "headline": at most 8 words (~60 characters), benefit-led, no trailing punctuation.
- "lead": 1–2 complete sentences, at most ~40 words — the promise: the concrete result the offered product adds on top of the order they just placed.
- "bullets": 3 or 4 items (unless the brief fixes an exact count), each ONE concrete fact or benefit stated in 8–18 words as a COMPLETE statement — an ingredient, a percentage from the brief, a mechanism, a texture, a sensory result. Never a cut-off phrase, never filler like "premium quality", no trailing periods. A bullet may only reference products listed in the brief — never pad the list by inventing an item.
- "paragraphs": {{length}}
- "proof": when "paragraphs" are required (long copy), 2 or 3 statements, each ONE complete sentence of at most ~30 words; otherwise the empty array []. The page renders them under the heading "What published research shows", so each statement must read like sourced evidence — calm, specific, factual, no hype. Governed entirely by rule 10: widely-established published findings about ingredients explicitly named in the brief's product descriptions; no recognizable named ingredient → [].
- "closer": ONE calm, complete reassurance sentence of at most ~18 words — e.g. the guarantee or the ships-with-their-order framing. No urgency.
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

/**
 * Surgical, edit-preserving upgrades to stored prompt templates: when a rule
 * sentence is improved in SYSTEM_CORE, existing shops' templates still carry
 * the old sentence (templates are seeded once and never overwritten). Each
 * entry replaces the OLD sentence verbatim wherever it still appears — a
 * merchant's other edits are untouched, and a template where the merchant
 * rewrote the sentence itself is left alone. Applying an upgrade bumps the
 * template version, which also invalidates cached copy (promptVersion is in
 * the cache key), so the improved rule takes effect on the next generation.
 */
const PROMPT_RULE_UPGRADES: Array<{ from: string; to: string }> = [
  {
    // Rule 8 sharpening: descriptions may be in another language and contain
    // the product's name in that language — the model must never take a name
    // from description text (observed: German name echoed into English copy).
    from: "8. Use every product name EXACTLY as written in the brief — the names are already in the customer's language; never translate, shorten, or restyle a product name.",
    to: "8. Use every product name EXACTLY as written at the START of its brief line — those name fields are already in the customer's language; never translate, shorten, or restyle a product name. Descriptions are grounding material only: they may be written in another language and may refer to a product under a different or translated name — NEVER take a product name from inside a description text.",
  },
  {
    // Rule 1 sharpening: models drifted into English on "proof" (rule 10's
    // example sentence is English) and "closer" — observed as English research
    // bullets and closers on non-English pages. The language guard enforces
    // this mechanically; the rule makes the first attempt more likely to pass.
    from: '1. Write every field in the language with IETF code "{{language}}". Never mix languages. Use the formal/informal register typical of premium skincare retail in that market.',
    to: '1. Write every field in the language with IETF code "{{language}}". Never mix languages. This includes "proof" and "closer": research statements and reassurance lines are written in that language too. These instructions and their example sentences are in English, but your output must be in "{{language}}" unless that IS the language. Use the formal/informal register typical of premium skincare retail in that market.',
  },
];

/**
 * Self-heal stored prompt templates (fire-and-forget from the dashboard
 * loader, like ensureUiStringsFresh). Never throws.
 */
export async function ensurePromptRulesFresh(shop: string): Promise<void> {
  try {
    const rows = await prisma.promptTemplate.findMany({ where: { shop } });
    for (const row of rows) {
      let systemPrompt = row.systemPrompt;
      let userPrompt = row.userPrompt;
      for (const { from, to } of PROMPT_RULE_UPGRADES) {
        systemPrompt = systemPrompt.split(from).join(to);
        userPrompt = userPrompt.split(from).join(to);
      }
      if (systemPrompt === row.systemPrompt && userPrompt === row.userPrompt) {
        continue;
      }
      // Optimistic write: only apply the patch if the template still holds
      // the exact text we read. A merchant Save/Reset landing in between
      // makes the where-clause miss (0 rows) — their edit wins, and the next
      // dashboard load re-patches if the old sentence is still present. This
      // also collapses concurrent dashboard loads to a single version bump.
      const { count } = await prisma.promptTemplate.updateMany({
        where: {
          id: row.id,
          systemPrompt: row.systemPrompt,
          userPrompt: row.userPrompt,
        },
        data: { systemPrompt, userPrompt, version: { increment: 1 } },
      });
      if (count > 0) {
        console.log(`[ai] prompt rules self-healed for ${shop}/${row.key}`);
      }
    }
  } catch (error) {
    console.error(`[ai] ensurePromptRulesFresh failed for ${shop}:`, error);
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
    // 0 is unreachable for real templates (versions start at 1 and only
    // increment). Falling back to 1 here would recompute the version-1-era
    // cache keys during a DB blip and serve exactly the stale rows a later
    // version bump (merchant save, reset, or rule self-heal) was issued to
    // retire. Version 0 keys are their own consistent "defaults era":
    // worst case is a spurious regeneration, never resurrected copy.
    version: 0,
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

  // claude-sonnet-5* and claude-opus-5* run ADAPTIVE THINKING BY DEFAULT when
  // the thinking param is omitted, and max_tokens caps thinking + output
  // TOGETHER — long-form JSON then truncates with stop_reason "max_tokens"
  // and parses as garbage. Disable thinking explicitly for those models only;
  // never send a thinking param for claude-haiku-4-5 or other models.
  const disableThinking =
    args.model.startsWith("claude-sonnet-5") || args.model.startsWith("claude-opus-5");

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
      ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
  };
  // A truncated or refused response parses as garbage downstream — fail loudly
  // BEFORE concatenating text blocks so callers hit their fallback paths.
  if (data.stop_reason === "max_tokens") {
    throw new Error(
      "anthropic output truncated (stop_reason=max_tokens) — raise the template's max tokens",
    );
  }
  if (data.stop_reason === "refusal") {
    throw new Error("anthropic refused the request");
  }
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
    ? `exactly 2 or 3 paragraphs, each 2–4 complete sentences (~40–80 words per paragraph), rendered under the heading "Why it works with your order". Paragraph 1 — the MECHANISM: how the offered product's ingredients and actions produce the visible result, concrete and specific to THIS product. Paragraph 2 — PROOF and believability: composition facts, textures, usage specifics, and the money-back guarantee from the brand context — only facts stated in the brief count as proof. Optional paragraph 3 — RELEVANCE: tie the offer back to the exact products they bought and the routine the two form together. Never mention the discount inside paragraphs. Below the paragraphs the page renders the "proof" research block — fill it per its own contract line and rule 10.`
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
 * Buyer-language Translate & Adapt description from a ProductCache row's
 * translationsJson column — the same exact → case-insensitive → base-prefix
 * chain the orchestrator uses for translated titles ("pt-PT" matches "pt").
 * Never throws — unparseable JSON degrades to undefined.
 */
function translatedDescription(
  translationsJson: string,
  language: string,
): string | undefined {
  const translations = jparse<Record<string, { description?: string }>>(
    translationsJson,
    {},
  );
  if (!translations || typeof translations !== "object") return undefined;
  // Single source of truth for the language chain — drifting local copies of
  // this lookup are what let the preview and live paths ground differently.
  return effectiveTranslatedDescription(translations, language);
}

/**
 * Copywriting grounding for the offered products: merchant aiDescription wins,
 * then — when a buyer `language` is given — the Translate & Adapt description
 * for that language (keeps fallback copy consistent with translated product
 * names), then the full synced description, then the short one
 * (effectiveDescription). Never throws — a failed lookup degrades to an
 * empty map.
 */
/** Where one product's grounding text came from — debug/diagnostics only. */
export interface GroundingExplain {
  source: "ai_context" | "translation" | "description_full" | "description_short" | "missing";
  /** Translation map key that matched (translation source only). */
  matchedKey?: string;
  length: number;
  snippet: string;
}

async function loadOfferDescriptions(
  shop: string,
  productIds: string[],
  language?: string,
  explain?: Map<string, GroundingExplain>,
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
        translationsJson: true,
      },
    });
    return new Map(
      rows.map((row): [string, string] => {
        const record = (
          value: string,
          source: GroundingExplain["source"],
          matchedKey?: string,
        ): [string, string] => {
          explain?.set(row.productId, {
            source,
            ...(matchedKey ? { matchedKey } : {}),
            length: value.length,
            snippet: debugText(value, 600),
          });
          return [row.productId, value];
        };
        if (language && !(row.aiDescription ?? "").trim()) {
          const translated = explainTranslatedDescription(
            jparse<Record<string, { title?: string; description?: string }>>(
              row.translationsJson,
              {},
            ),
            language,
          );
          if (translated) return record(translated.value, "translation", translated.matchedKey);
        }
        const value = effectiveDescription(row);
        const source: GroundingExplain["source"] = (row.aiDescription ?? "").trim()
          ? "ai_context"
          : (row.descriptionFull ?? "").trim()
            ? "description_full"
            : value
              ? "description_short"
              : "missing";
        return record(value, source);
      }),
    );
  } catch (error) {
    console.error(`[ai] product description lookup failed for ${shop}:`, error);
    return new Map();
  }
}

async function buildTemplateVars(args: GenerateCopyArgs): Promise<Record<string, string>> {
  // LANGUAGE-AWARE, exactly like the basket side (buildBasket): merchant AI
  // context > the T&A description for the buyer's language > synced full >
  // short. Feeding the primary-locale description to a foreign-language buyer
  // grounds the model in wrong-language text — and when that text contains
  // the product's name in the store's primary language, the model echoes THAT
  // name into the copy, overriding the correct name field of the brief line
  // (observed in production: German name inside English copy). Shared with
  // buildCacheKey via the request-scoped memo — one read, one view.
  const descriptions = await groundingDescriptions(args);
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
  if (args.debug) {
    // The exact text blocks the prompt is assembled from — this is where a
    // wrong-language product name hides. Captured verbatim (truncated).
    debugAdd(args.debug, "prompt-blocks", {
      language: args.language,
      mode: args.mode,
      position: args.position,
      discountPct: Math.round(args.discountPct),
      currency: args.currency,
      copyLength: args.copyLength,
      brand_context: debugText(args.settings.brandContext),
      tone: debugText(args.settings.tone),
      basket_summary: debugText(basketSummary),
      offer_summary: debugText(offerSummary),
    });
    debugAdd(args.debug, "grounding-provenance", {
      note: "per offered product: which stored text grounds the copy (ai_context = merchant AI context, translation = T&A description for the buyer language, description_full/short = base Shopify description)",
      products: Object.fromEntries(args.groundingExplain ?? new Map()),
    });
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

/**
 * Deterministic em/en-dash removal for every buyer-facing string. SYSTEM_CORE
 * rule 11 bans dashes, but models slip and merchant-stored strings (edited UI
 * strings, product names, brand context) predate the rule — so the ban is
 * ENFORCED here, not just requested. Spaced (" — ") and bare ("—"/"–") dashes
 * both become ", ", then the artifacts the swap can leave behind are
 * collapsed (", ," → ","; "  " → " ").
 */
function stripDashes(value: string): string {
  if (!/[—–]/.test(value)) return value;
  let out = value.replace(/ [—–] /g, ", ").replace(/[—–]/g, ", ");
  while (/,\s*,/.test(out)) out = out.replace(/,\s*,/g, ",");
  return out
    .replace(/ {2,}/g, " ")
    .replace(/ +,/g, ",")
    .replace(/^[\s,]+/, "")
    .trimEnd();
}

/**
 * Non-empty strings from a model array, dash-sanitized, truncated at `max`,
 * capped at `count`. Used by validateModelCopy AND the extended-stage parse,
 * so both stages emit dash-free items.
 */
function stringItems(value: unknown, max: number, count: number): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => truncate(stripDashes(item), max))
    .filter((item) => item.length > 0)
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
  const bullets = stringItems(parsed.bullets, BULLET_HARD_MAX, 4);
  // "short" is lead + bullets only — drop paragraphs even if the model wrote them.
  const paragraphs =
    copyLength === "long" ? stringItems(parsed.paragraphs, PARAGRAPH_HARD_MAX, 3) : [];
  // Research block is long-copy only — same discipline as paragraphs.
  const proof = copyLength === "long" ? stringItems(parsed.proof, PROOF_HARD_MAX, 3) : [];
  const closer =
    typeof parsed.closer === "string"
      ? truncate(stripDashes(parsed.closer.trim()), CLOSER_HARD_MAX)
      : "";
  const suggestionRaw = parsed.discount_suggestion;
  const discountSuggestion =
    typeof suggestionRaw === "number" && Number.isFinite(suggestionRaw)
      ? Math.round(suggestionRaw)
      : null;
  return {
    copy: {
      headline: truncate(stripDashes(headline), HEADLINE_MAX + 20),
      body: truncate(stripDashes(lead), LEAD_MAX + 60),
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
  /**
   * INTERNAL request-scoped memo — never set by callers. The grounding
   * descriptions are read ONCE per args object and shared by buildCacheKey
   * and buildTemplateVars: if the two performed separate reads, a transient
   * DB failure (or a merchant edit) landing between them would cache copy
   * generated from one grounding under a key that hashes another — a blip
   * would permanently poison the row for every healthy future request.
   */
  groundingMemo?: Promise<Map<string, string>>;
  /**
   * Optional diagnostic trace (admin preview / live debug logging). Purely
   * observational: entries are appended, nothing reads them on this path.
   */
  debug?: DebugTrace;
  /** INTERNAL — grounding provenance captured by the memoized read. */
  groundingExplain?: Map<string, GroundingExplain>;
}

/** The one grounding read per generation request (see groundingMemo). */
function groundingDescriptions(args: GenerateCopyArgs): Promise<Map<string, string>> {
  if (!args.groundingMemo) {
    if (args.debug && !args.groundingExplain) {
      args.groundingExplain = new Map();
    }
    args.groundingMemo = loadOfferDescriptions(
      args.shop,
      args.offerProducts.map((p) => p.productId),
      args.language,
      args.groundingExplain,
    );
  }
  return args.groundingMemo;
}

async function buildCacheKey(
  args: GenerateCopyArgs,
  promptVersion: number,
): Promise<string> {
  // variantId alone is NOT enough: the buyer-facing name (manual override or
  // Translate & Adapt) and the grounding description both feed the prompt, so
  // a merchant fixing either must invalidate the cached copy — otherwise the
  // old name keeps serving from cache forever. Pair each id with the exact
  // name the prompt will use.
  const offerSig = args.offerProducts
    .map((p) =>
      JSON.stringify([p.variantId, p.translatedTitle || p.title, p.price]),
    )
    .sort();
  // Signature of the grounding text. CRITICAL: this is the SAME memoized
  // read buildTemplateVars uses for the prompt (language-aware: merchant AI
  // context > T&A description for the buyer's language > synced full >
  // short) — one read per request, so key and prompt can never see
  // different grounding, even across a mid-request merchant edit or a
  // transient DB failure. On a blip the shared read yields an empty Map
  // (loadOfferDescriptions never throws): the copy generates ungrounded AND
  // its key hashes the same empty grounding — an orphan row no healthy
  // request ever reads, never a poisoned one. Buyer path stays never-throw.
  const descriptions = await groundingDescriptions(args);
  const descSig = [...descriptions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, text]) =>
      createHash("sha256").update(JSON.stringify([id, text])).digest("hex").slice(0, 16),
    );
  // Basket lines carry the exact titles AND grounding descriptions the prompt
  // uses (buildBasketSummary injects both) — hash both, for every line, so a
  // basket-side name or description fix also regenerates copy. Descriptions
  // are hashed short to keep the key material bounded.
  const basketSig = args.basket
    .map((line) =>
      JSON.stringify([
        line.title,
        createHash("sha256")
          .update(line.description ?? "")
          .digest("hex")
          .slice(0, 16),
      ]),
    )
    .sort();
  // Everything else the rendered prompt consumes must be in the key too:
  // position/totalOffers (the sequential template mandates a DIFFERENT angle
  // per position — sharing rows across positions serves page-2-angled copy
  // on page 1), the display currency, prices (in offerSig above), and the
  // brand context/tone from settings (edited in the admin; feeds every
  // system prompt).
  const brandSig = createHash("sha256")
    .update(
      JSON.stringify([args.settings.brandContext ?? "", args.settings.tone ?? ""]),
    )
    .digest("hex")
    .slice(0, 16);
  // JSON.stringify keeps every component unambiguously delimited — titles or
  // ids containing "," / "|" can no longer collide with a different basket.
  const material = JSON.stringify([
    args.mode,
    offerSig,
    descSig,
    basketSig,
    args.language,
    args.copyLength,
    String(Math.round(args.discountPct)),
    String(promptVersion),
    String(args.position),
    String(args.totalOffers),
    args.currency,
    brandSig,
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

/** Product names that may legitimately appear untranslated in any language. */
function guardIgnoreNames(args: GenerateCopyArgs): string[] {
  return [
    ...args.offerProducts.flatMap((p) => [p.translatedTitle ?? "", p.title]),
    ...args.basket.map((line) => line.title),
  ].filter(Boolean);
}

/** Corrective instruction appended to the system prompt for the retry pass. */
function languageCorrection(flagged: FlaggedField[], language: string): string {
  return (
    `\n\nLANGUAGE CORRECTION — your previous attempt wrote these fields in the wrong language: ${flagged
      .map((f) => f.path)
      .join(", ")}. Every field of the JSON must be written STRICTLY in the language with IETF code "${language}". ` +
    "The instructions and examples are English; your output must not be, unless that IS the language. Rewrite ALL fields now."
  );
}

/**
 * ENFORCE the output language on generated copy (the deep fix for "parts of
 * the copy are sometimes in English"): after a failed check the copy is
 * regenerated ONCE with an explicit correction; any fields still flagged are
 * machine-translated via the configured provider as a last resort. Callers
 * receive copy that passed the guard (or the best achievable) — only that is
 * ever cached. `regenerate` runs the caller's own generation pass again.
 * Never throws; on total failure the original copy is returned unchanged.
 */
async function enforceCopyLanguage(
  args: GenerateCopyArgs,
  copy: OfferCopy,
  regenerate: () => Promise<OfferCopy>,
): Promise<{ copy: OfferCopy; action: "clean" | "retried" | "translated" | "unresolved" }> {
  const ignore = guardIgnoreNames(args);
  let flagged = checkCopyLanguage(copy, args.language, ignore);
  if (flagged.length === 0) return { copy, action: "clean" };
  debugAdd(args.debug, "language-guard", {
    position: args.position,
    language: args.language,
    flagged: flagged.map((f) => ({ path: f.path, text: debugText(f.text, 200) })),
    action: "retrying with correction",
  });

  // Pass 2 — one corrective regeneration. Keep whichever result is cleaner.
  try {
    const retried = await regenerate();
    const retriedFlagged = checkCopyLanguage(retried, args.language, ignore);
    if (retriedFlagged.length < flagged.length) {
      copy = retried;
      flagged = retriedFlagged;
    }
    if (flagged.length === 0) {
      debugAdd(args.debug, "language-guard", { position: args.position, action: "retry produced clean copy" });
      return { copy, action: "retried" };
    }
  } catch (error) {
    console.error(`[ai] language-guard retry failed for ${args.shop}:`, error);
  }

  // Pass 3 — machine-translate ONLY the still-flagged fields.
  try {
    const translated = await translateTexts(
      args.settings,
      flagged.map((f) => f.text),
      args.language,
    );
    flagged.forEach((field, i) => applyFieldText(copy, field, translated[i] ?? ""));
    const remaining = checkCopyLanguage(copy, args.language, ignore);
    debugAdd(args.debug, "language-guard", {
      position: args.position,
      action: "translated flagged fields via provider",
      translatedPaths: flagged.map((f) => f.path),
      stillFlagged: remaining.map((f) => f.path),
    });
    return { copy, action: remaining.length === 0 ? "translated" : "unresolved" };
  } catch (error) {
    console.error(`[ai] language-guard translation fallback failed for ${args.shop}:`, error);
    debugAdd(args.debug, "language-guard", {
      position: args.position,
      action: "unresolved — provider translation failed",
      stillFlagged: flagged.map((f) => f.path),
    });
    return { copy, action: "unresolved" };
  }
}

async function generateAndCache(
  args: GenerateCopyArgs,
  template: ResolvedPromptTemplate,
  cacheKey: string,
  timeoutMs: number,
): Promise<{ copy: OfferCopy; discountSuggestion: number | null }> {
  const vars = await buildTemplateVars(args);
  const system = renderTemplate(template.systemPrompt, vars);
  const prompt = renderTemplate(template.userPrompt, vars);
  debugAdd(args.debug, "claude-request", {
    position: args.position,
    model: template.model,
    templateVersion: template.version,
    maxTokens: template.maxTokens,
    timeoutMs,
    cacheKey,
    systemPrompt: debugText(system, 40_000),
    userPrompt: debugText(prompt, 40_000),
  });
  let raw: string;
  try {
    raw = await claudeComplete({
      model: template.model,
      system,
      prompt,
      maxTokens: template.maxTokens,
      temperature: template.temperature,
      timeoutMs,
    });
  } catch (error) {
    debugAdd(args.debug, "claude-error", {
      position: args.position,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  debugAdd(args.debug, "claude-response", {
    position: args.position,
    raw: debugText(raw, 40_000),
  });
  const validated = validateModelCopy(parseModelObject(raw), args.copyLength);
  const discountSuggestion = validated.discountSuggestion;
  // Language enforcement: retry once with a correction, then translate any
  // still-flagged fields — only guard-passed copy is ever cached.
  const enforced = await enforceCopyLanguage(args, validated.copy, async () => {
    const retryRaw = await claudeComplete({
      model: template.model,
      system: system + languageCorrection(
        checkCopyLanguage(validated.copy, args.language, guardIgnoreNames(args)),
        args.language,
      ),
      prompt,
      maxTokens: template.maxTokens,
      temperature: template.temperature,
      timeoutMs,
    });
    return validateModelCopy(parseModelObject(retryRaw), args.copyLength).copy;
  });
  const copy = enforced.copy;
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
/** Why generateCopy returned what it returned — surfaced in admin previews. */
export type CopyReason =
  | "cache"
  | "generated"
  | "ai_disabled"
  | "no_key"
  | "timeout_or_error";

export async function generateCopy(args: GenerateCopyArgs): Promise<{
  copy: OfferCopy;
  discountSuggestion: number | null;
  cached: boolean;
  fallbackUsed: boolean;
  reason: CopyReason;
}> {
  const template = await getPromptTemplate(args.shop, args.mode, args.settings);
  const cacheKey = await buildCacheKey(args, template.version);
  debugAdd(args.debug, "prompt-template", {
    position: args.position,
    mode: args.mode,
    model: template.model,
    version: template.version,
    usingStoredTemplate: template.version > 0,
    // The v1.6.2 rule-8 hardening sentence — false means the stored template
    // never received the upgrade (merchant-edited or self-heal never ran).
    rule8DescriptionBanPresent: template.systemPrompt.includes(
      "NEVER take a product name from inside a description text",
    ),
  });

  if (!args.bypassCache) {
    try {
      const hit = await prisma.copyCache.findUnique({
        where: { shop_cacheKey: { shop: args.shop, cacheKey } },
      });
      debugAdd(args.debug, "copy-cache", {
        position: args.position,
        cacheKey,
        hit: Boolean(hit),
        ...(hit ? { language: hit.language, headline: hit.headline } : {}),
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
          reason: "cache",
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
      reason: args.settings.aiEnabled ? "no_key" : "ai_disabled",
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
      reason: "generated",
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
      reason: "timeout_or_error",
    };
  }
}

/**
 * Fill args.offerDescriptions ahead of a long-form fallback so its paragraphs
 * can be grounded in real product text — preferring the buyer-language
 * Translate & Adapt description when the merchant wrote no aiDescription.
 * No-op for short copy or when the caller already supplied descriptions.
 * Exported so the orchestrator can ground ITS fallback paths (no-discount
 * pages, defensive exception fallbacks) in the same product text.
 * Never throws.
 */
export async function withOfferDescriptions(args: GenerateCopyArgs): Promise<GenerateCopyArgs> {
  if (args.copyLength !== "long" || args.offerDescriptions) return args;
  // The deterministic fallback QUOTES this text verbatim on the buyer's page
  // — no model rewrites or translates it, and no prompt rule protects it. So
  // only text known to be in the buyer's language may be embedded: the T&A
  // description for that language, or any grounding text when the buyer
  // reads the store's default language. Anything else is omitted — a shorter
  // fallback beats wrong-language paragraphs (production symptom: German
  // paragraphs, German product name, on an English page).
  const byId = await loadVerbatimSafeDescriptions(
    args.shop,
    args.offerProducts.map((p) => p.productId),
    args.language,
    args.settings.defaultLanguage,
  );
  return { ...args, offerDescriptions: Object.fromEntries(byId) };
}

/**
 * Descriptions safe to render VERBATIM to a buyer reading `language` (see
 * withOfferDescriptions). Same never-throw contract as loadOfferDescriptions:
 * a lookup failure degrades to an empty map (the fallback simply loses its
 * grounded paragraphs).
 */
async function loadVerbatimSafeDescriptions(
  shop: string,
  productIds: string[],
  language: string,
  defaultLanguage: string,
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
        translationsJson: true,
      },
    });
    const out = new Map<string, string>();
    for (const row of rows) {
      const translated = translatedDescription(row.translationsJson, language);
      if (translated) {
        out.set(row.productId, translated);
        continue;
      }
      if (languagesMatch(language, defaultLanguage)) {
        const text = effectiveDescription(row);
        if (text) out.set(row.productId, text);
      }
    }
    return out;
  } catch (error) {
    console.error(`[ai] verbatim-safe description load failed for ${shop}:`, error);
    return new Map();
  }
}

/**
 * Read the discount suggestion a PREVIOUS generation stored under exactly the
 * template version + cache key that `args` resolves to — the same resolution
 * generateCopy/generateBuyerCopy perform. This lets the orchestrator adopt an
 * AI-suggested discount BEFORE any copy is generated for an assembly, so a
 * suggestion takes effect via convergence on the next page build instead of
 * mutating a page whose copy was written at a different pct. Returns null
 * when there is no cached row or the row carries no suggestion. Never throws.
 */
export async function peekDiscountSuggestion(
  args: GenerateCopyArgs,
): Promise<number | null> {
  try {
    const template = await getPromptTemplate(args.shop, args.mode, args.settings);
    const cacheKey = await buildCacheKey(args, template.version);
    const row = await prisma.copyCache.findUnique({
      where: { shop_cacheKey: { shop: args.shop, cacheKey } },
      select: { discountSuggestion: true },
    });
    return row?.discountSuggestion ?? null;
  } catch (error) {
    console.error(`[ai] discount suggestion peek failed for ${args.shop}:`, error);
    return null;
  }
}

// ── Two-stage buyer copy (fast CORE call + background extended sections) ─────

/**
 * max_tokens for the buyer-blocking CORE call. Headline + lead + bullets +
 * closer fit comfortably; a cap this tight keeps worst-case latency bounded.
 */
const CORE_MAX_TOKENS = 1500;

/**
 * Stage override appended to the rendered system prompt AFTER template
 * variable substitution — narrows the output contract to the core fields
 * while every other rule (language, claims, discount mention) stands.
 */
const CORE_STAGE_OVERRIDE =
  'FOR THIS CALL ONLY, OVERRIDE THE OUTPUT SCHEMA: respond with {"headline":string,"lead":string,"bullets":string[],"closer":string,"discount_suggestion":number|null} — do NOT write paragraphs or proof (they are generated separately). Every other rule stands, above all rule 1: every field is written in the buyer language from rule 1, never the language of these instructions.';

/**
 * Upsert a CopyCache row. `discountSuggestion === undefined` leaves an
 * existing row's suggestion untouched (extended-stage writes have none of
 * their own); when the row is CREATED while `discountSuggestion` is
 * undefined, `createDiscountSuggestion` is stored instead — this is how the
 * fast core call's suggestion survives the long-copy path, where ONLY
 * completeExtendedCopy ever writes the row under the full cacheKey.
 */
async function upsertCopyCache(
  shop: string,
  cacheKey: string,
  language: string,
  copy: OfferCopy,
  discountSuggestion: number | null | undefined,
  createDiscountSuggestion: number | null = null,
): Promise<void> {
  await prisma.copyCache.upsert({
    where: { shop_cacheKey: { shop, cacheKey } },
    update: {
      language,
      headline: copy.headline,
      body: copy.body,
      bulletsJson: packBulletsJson(copy),
      ...(discountSuggestion !== undefined ? { discountSuggestion } : {}),
    },
    create: {
      shop,
      cacheKey,
      language,
      headline: copy.headline,
      body: copy.body,
      bulletsJson: packBulletsJson(copy),
      discountSuggestion:
        discountSuggestion !== undefined ? discountSuggestion : createDiscountSuggestion,
    },
  });
}

/**
 * Buyer-blocking copy generation for the post-purchase callback's hard time
 * budget. Cache-first; on miss makes ONE fast CORE call (headline / lead /
 * bullets / closer) on settings.coreCopyModel. For "long" copyLength the
 * below-CTA sections (paragraphs/proof) are NOT generated here — the caller
 * fires completeExtendedCopy in the background and the page polls for them
 * (extendedPending: true). "short" copy is complete after the core call and
 * is cached under the standard cacheKey. A core-only "long" result is NEVER
 * cached under the full cacheKey — only completeExtendedCopy writes the
 * merged copy. Timeout/error degrades to the deterministic fallback and warms
 * the full cache in the background, exactly like generateCopy. Never throws.
 */
export async function generateBuyerCopy(args: GenerateCopyArgs): Promise<{
  copy: OfferCopy;
  discountSuggestion: number | null;
  cached: boolean;
  fallbackUsed: boolean;
  extendedPending: boolean;
  reason: CopyReason;
  /** The grounding-aware key this result was computed under. Callers MUST
   *  pass it to completeExtendedCopy so the background merge lands on the
   *  same row even if a grounding edit shifts the key in the meantime. */
  cacheKey: string;
}> {
  const template = await getPromptTemplate(args.shop, args.mode, args.settings);
  const cacheKey = await buildCacheKey(args, template.version);
  debugAdd(args.debug, "prompt-template", {
    position: args.position,
    mode: args.mode,
    model: args.settings.coreCopyModel || "claude-haiku-4-5",
    templateModel: template.model,
    version: template.version,
    usingStoredTemplate: template.version > 0,
    rule8DescriptionBanPresent: template.systemPrompt.includes(
      "NEVER take a product name from inside a description text",
    ),
  });

  if (!args.bypassCache) {
    try {
      const hit = await prisma.copyCache.findUnique({
        where: { shop_cacheKey: { shop: args.shop, cacheKey } },
      });
      debugAdd(args.debug, "copy-cache", {
        position: args.position,
        cacheKey,
        hit: Boolean(hit),
        ...(hit ? { language: hit.language, headline: hit.headline } : {}),
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
          extendedPending: false,
          reason: "cache",
      cacheKey,
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
      extendedPending: false,
      reason: args.settings.aiEnabled ? "no_key" : "ai_disabled",
      cacheKey,
    };
  }

  const timeoutMs = args.timeoutMs ?? args.settings.aiTimeoutMs;
  try {
    const vars = await buildTemplateVars(args);
    const system = renderTemplate(template.systemPrompt, vars) + "\n\n" + CORE_STAGE_OVERRIDE;
    const prompt = renderTemplate(template.userPrompt, vars);
    debugAdd(args.debug, "claude-request", {
      position: args.position,
      stage: "core",
      model: args.settings.coreCopyModel || "claude-haiku-4-5",
      maxTokens: CORE_MAX_TOKENS,
      timeoutMs,
      cacheKey,
      systemPrompt: debugText(system, 40_000),
      userPrompt: debugText(prompt, 40_000),
    });
    let raw: string;
    try {
      raw = await claudeComplete({
        model: args.settings.coreCopyModel || "claude-haiku-4-5",
        system,
        prompt,
        maxTokens: CORE_MAX_TOKENS,
        timeoutMs,
      });
    } catch (coreError) {
      debugAdd(args.debug, "claude-error", {
        position: args.position,
        stage: "core",
        error: coreError instanceof Error ? coreError.message : String(coreError),
      });
      throw coreError;
    }
    debugAdd(args.debug, "claude-response", {
      position: args.position,
      stage: "core",
      raw: debugText(raw, 40_000),
    });
    const { copy, discountSuggestion } = validateModelCopy(
      parseModelObject(raw),
      args.copyLength,
    );
    // The core stage never carries the below-CTA sections — drop anything the
    // model wrote despite the override so the page renders a clean core.
    const coreCopy: OfferCopy = { ...copy, paragraphs: [], proof: [] };

    // Language guard (pure string check — no latency): a core result in the
    // wrong language must never reach a buyer or the cache. Throwing routes
    // to the catch below: the buyer gets the translated deterministic
    // fallback NOW, and the background full-generation warms the cache with
    // enforcement (retry + provider translation) for the next buyer.
    const coreFlagged = checkCopyLanguage(coreCopy, args.language, guardIgnoreNames(args));
    if (coreFlagged.length > 0) {
      debugAdd(args.debug, "language-guard", {
        position: args.position,
        stage: "core",
        language: args.language,
        flagged: coreFlagged.map((f) => ({ path: f.path, text: debugText(f.text, 200) })),
        action: "core copy rejected — serving fallback, warming cache with enforcement",
      });
      throw new Error(
        `core copy failed the language guard (${coreFlagged.map((f) => f.path).join(", ")}) for ${args.language}`,
      );
    }

    if (args.copyLength === "long") {
      // NEVER cache a core-only result under the full cacheKey — the merged
      // copy is written by completeExtendedCopy when the background call lands.
      return {
        copy: coreCopy,
        discountSuggestion,
        cached: false,
        fallbackUsed: false,
        extendedPending: true,
        reason: "generated",
      cacheKey,
      };
    }

    // "short" copy IS complete — persist it for the next buyer.
    try {
      await upsertCopyCache(args.shop, cacheKey, args.language, coreCopy, discountSuggestion);
    } catch (error) {
      console.error(`[ai] core copy cache write failed for ${args.shop}:`, error);
    }
    return {
      copy: coreCopy,
      discountSuggestion,
      cached: false,
      fallbackUsed: false,
      extendedPending: false,
      reason: "generated",
      cacheKey,
    };
  } catch (error) {
    console.error(
      `[ai] core copy generation failed for ${args.shop} (${args.mode}, ${args.language}):`,
      error,
    );
    // Warm the FULL cache for the next buyer — fire and forget, generous timeout.
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
      extendedPending: false,
      reason: "timeout_or_error",
      cacheKey,
    };
  }
}

/**
 * Background completion of the below-CTA sections (paragraphs + proof) for a
 * core copy that is already live on the buyer's page. Uses the prompt
 * template's own model and maxTokens with the generous background timeout.
 * On success writes the FULL merged copy (core + extended) to CopyCache under
 * the standard cacheKey and returns the extended parts; on any error it logs
 * and returns null. `coreDiscountSuggestion` is the suggestion the fast core
 * call returned: when this write CREATES the merged row it is persisted so
 * the next assembly's peekDiscountSuggestion can converge on it (an existing
 * row's suggestion is left untouched). Never throws.
 */
export async function completeExtendedCopy(
  args: GenerateCopyArgs,
  core: OfferCopy,
  coreDiscountSuggestion: number | null,
  /** Key the core call was computed under. Passing it pins the merged write
   *  to the SAME row as the core's assembly even when a grounding edit (or a
   *  transient ProductCache read failure) would shift a re-derived key in
   *  the background window — re-deriving here could otherwise write a
   *  mixed-grounding row under a key fresh assemblies treat as current. */
  pinnedCacheKey?: string,
): Promise<{ paragraphs: string[]; proof: string[]; closer: string } | null> {
  try {
    const template = await getPromptTemplate(args.shop, args.mode, args.settings);
    const cacheKey = pinnedCacheKey ?? (await buildCacheKey(args, template.version));
    const vars = await buildTemplateVars(args);
    const stageOverride =
      'The core copy for this page is already live (verbatim below). FOR THIS CALL ONLY output {"paragraphs":string[],"proof":string[]} completing it — same angle, no repetition of the lead or bullets, all standing rules apply (mechanism/proof/relevance, research guardrails, no discount mention). ' +
      `Write every string strictly in the language with IETF code "${args.language}" — the language of the core copy below, never the language of these instructions. CORE COPY: ` +
      JSON.stringify(core);
    const system = renderTemplate(template.systemPrompt, vars) + "\n\n" + stageOverride;
    const prompt = renderTemplate(template.userPrompt, vars);
    const extendedPass = async (extraSystem = ""): Promise<{ paragraphs: string[]; proof: string[] } | null> => {
      const raw = await claudeComplete({
        model: template.model,
        system: system + extraSystem,
        prompt,
        maxTokens: template.maxTokens,
        timeoutMs: BACKGROUND_TIMEOUT_MS,
      });
      const parsed = parseModelObject(raw);
      const paragraphs = stringItems(parsed.paragraphs, PARAGRAPH_HARD_MAX, 3);
      const proof = stringItems(parsed.proof, PROOF_HARD_MAX, 3);
      return paragraphs.length > 0 ? { paragraphs, proof } : null;
    };
    const first = await extendedPass();
    if (!first) {
      // A "merged" copy without paragraphs is a core-only result in disguise —
      // never cache it under the full cacheKey (proof alone may be [] by rule 10).
      console.error(
        `[ai] extended copy returned no paragraphs for ${args.shop} (${args.mode}, ${args.language})`,
      );
      return null;
    }
    // The extended schema carries no closer — the live core's closer stands.
    const closer = core.closer ?? "";
    let merged: OfferCopy = { ...core, paragraphs: first.paragraphs, closer, proof: first.proof };
    // Language enforcement for the below-CTA sections — the observed failure
    // mode ("research bullets in English on a French page"). Retry once with
    // a correction, then provider-translate anything still flagged; only
    // guard-passed sections are cached and patched into the live page.
    const enforced = await enforceCopyLanguage(args, merged, async () => {
      const retried = await extendedPass(
        languageCorrection(
          checkCopyLanguage(merged, args.language, guardIgnoreNames(args)),
          args.language,
        ),
      );
      if (!retried) throw new Error("extended retry returned no paragraphs");
      return { ...core, paragraphs: retried.paragraphs, closer, proof: retried.proof };
    });
    merged = enforced.copy;
    const paragraphs = merged.paragraphs ?? [];
    const proof = merged.proof ?? [];
    try {
      // undefined: never clobber an existing row's suggestion; on CREATE the
      // core call's suggestion is stored so the next assembly can peek it.
      await upsertCopyCache(
        args.shop,
        cacheKey,
        args.language,
        merged,
        undefined,
        coreDiscountSuggestion,
      );
    } catch (error) {
      // The buyer still gets the extended parts via the poll — only future
      // cache warmth is lost.
      console.error(`[ai] extended copy cache write failed for ${args.shop}:`, error);
    }
    return { paragraphs, proof, closer };
  } catch (error) {
    console.error(
      `[ai] extended copy generation failed for ${args.shop} (${args.mode}, ${args.language}):`,
      error,
    );
    return null;
  }
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
 * products' descriptions (args.offerDescriptions — buyer-language Translate &
 * Adapt text when available, unless a merchant aiDescription wins) and closes
 * with the merchant's guarantee line or the ships_free string — real
 * product/brand text only, never invented.
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

  // stripDashes is the final pass over every assembled field: the UI-string
  // DEFAULTS are dash-free, but merchant-EDITED strings, product names and
  // brand-context text may not be.
  const headline = truncate(stripDashes(titles.join(" + ")), HEADLINE_MAX);
  const body = truncate(
    stripDashes([s("offer_badge"), discountLine].filter(Boolean).join(", ")),
    LEAD_MAX,
  );
  const bullets = [saveLine, s("ships_free"), s("one_click_note")]
    .map((b) => stripDashes(b))
    .filter((b) => b.length > 0)
    .slice(0, 3);
  if (args.copyLength !== "long") {
    return { headline, body, bullets };
  }

  // Long form: one paragraph per offered product (first ~2 sentences of its
  // effective description), capped at 2. No description → no paragraph.
  const paragraphs = args.offerProducts
    .map((p) => stripDashes(firstSentences(args.offerDescriptions?.[p.productId] ?? "")))
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, 2);
  // The guarantee sentence is quoted VERBATIM from the merchant's brand
  // context, which has one language (English here) — quoting it on any other
  // language's page was a hard-coded wrong-language leak. Only buyers of the
  // store's default language may see it; everyone else gets the translated
  // ships_free string.
  const guaranteeSafe = languagesMatch(args.language, args.settings.defaultLanguage)
    ? guaranteeLine(args.settings.brandContext)
    : "";
  const closer = truncate(stripDashes(guaranteeSafe || s("ships_free")), CLOSER_MAX);
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
 * best-effort translate missing strings for the other languages. Keys seeded
 * on an EXISTING shop (i.e. added by an app update after install — the
 * "research heading is English-only" root cause) additionally get their own
 * fire-and-forget translation scoped to exactly those keys, and are excluded
 * from the awaited pass so the two never race on the same rows and callers on
 * a request path return fast. Never throws.
 */
export async function ensureUiStrings(shop: string, languages: string[]): Promise<void> {
  let seededKeys: string[] = [];
  let existingShop = false;
  try {
    const existing = await prisma.uiString.findMany({
      where: { shop, language: "en" },
      select: { key: true },
    });
    const have = new Set(existing.map((row) => row.key));
    existingShop = have.size > 0;
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
      seededKeys = missing;
    }
  } catch (error) {
    console.error(`[ai] ensureUiStrings seeding failed for ${shop}:`, error);
  }

  const others = languages.filter((lang) => lang && lang !== "en");
  if (others.length === 0) return;

  // New keys on an existing shop: translate exactly those in the background.
  const backgroundKeys = existingShop ? seededKeys : [];
  if (backgroundKeys.length > 0) {
    void translateUiStrings(shop, others, {
      onlyMissing: true,
      keys: backgroundKeys,
    }).catch((error) =>
      console.error(
        `[ai] ensureUiStrings background translation failed for ${shop}:`,
        error,
      ),
    );
  }

  try {
    // Awaited pass over the remaining keys (all keys on a fresh install). On
    // a healthy existing shop nothing is missing here, so it costs one DB
    // query per language and no provider calls.
    const foregroundKeys =
      backgroundKeys.length > 0
        ? UI_STRING_KEYS.filter((key) => !backgroundKeys.includes(key))
        : undefined;
    if (foregroundKeys && foregroundKeys.length === 0) return;
    const { errors } = await translateUiStrings(shop, others, {
      onlyMissing: true,
      ...(foregroundKeys ? { keys: foregroundKeys } : {}),
    });
    for (const message of errors) {
      console.error(`[ai] ensureUiStrings translation issue for ${shop}: ${message}`);
    }
  } catch (error) {
    // translateUiStrings collects its own errors; this is belt-and-braces.
    console.error(`[ai] ensureUiStrings translation pass failed for ${shop}:`, error);
  }
}

/**
 * Superseded English defaults: the four strings that carried em dashes before
 * the em-dash-free copy contract. A stored EN row whose value still matches
 * one of these VERBATIM is an untouched old seed, never a merchant edit, so
 * it is safe to upgrade in place. Extend this map whenever a default in
 * DEFAULT_UI_STRINGS_EN is reworded, keyed by UI string key → old value.
 */
const OLD_DEFAULTS: Record<string, string> = {
  ships_free: "Ships with your order — no extra shipping",
  one_click_note: "One click — charged to the payment method you just used",
  discount_applied: "{pct}% off — post-purchase exclusive",
  thank_you_code_note: "Code {code} — applied automatically at checkout",
};

/**
 * Loader-cheap self-heal for UI strings — safe to call from any request path.
 * ONE small DB read decides everything; all repair work is fire-and-forget:
 * - EN keys missing (added by an app update after install): ensureUiStrings
 *   seeds them and auto-translates exactly those keys in the background.
 * - EN rows still holding a superseded default (OLD_DEFAULTS): upgraded to
 *   the current DEFAULT_UI_STRINGS_EN value and their translations re-queued
 *   for every configured non-default language (overwriting the stale ones).
 * Never throws.
 */
export async function ensureUiStringsFresh(shop: string): Promise<void> {
  try {
    const [settings, allRows] = await Promise.all([
      getSettings(shop),
      prisma.uiString.findMany({
        where: { shop },
        select: { language: true, key: true, value: true },
      }),
    ]);
    const enRows = allRows.filter((row) => row.language === "en");
    const have = new Set(enRows.map((row) => row.key));
    const missing = UI_STRING_KEYS.some((key) => !have.has(key));
    const staleKeys = enRows
      .filter((row) => OLD_DEFAULTS[row.key] === row.value)
      .map((row) => row.key);
    // Gap repair for the OTHER configured languages too: a language whose
    // translation pass once failed (provider timeout, lost placeholder) kept
    // missing keys FOREVER — every missing key fell back to the English
    // default on the buyer page. Re-queue exactly the gap languages.
    const keysByLanguage = new Map<string, Set<string>>();
    for (const row of allRows) {
      let set = keysByLanguage.get(row.language);
      if (!set) {
        set = new Set();
        keysByLanguage.set(row.language, set);
      }
      set.add(row.key);
    }
    const gapLanguages = (settings.languages ?? []).filter((lang) => {
      if (!lang || lang === "en") return false;
      const keys = keysByLanguage.get(lang);
      return !keys || UI_STRING_KEYS.some((key) => !keys.has(key));
    });
    if (!missing && staleKeys.length === 0 && gapLanguages.length === 0) return;

    void (async () => {
      if (staleKeys.length > 0) {
        for (const key of staleKeys) {
          const value = DEFAULT_UI_STRINGS_EN[key];
          if (!value) continue;
          await prisma.uiString.update({
            where: { shop_language_key: { shop, language: "en", key } },
            data: { value },
          });
        }
        const others = settings.languages.filter((lang) => lang && lang !== "en");
        if (others.length > 0) {
          // NOT onlyMissing — the stale translations must be overwritten. The
          // EN rows were updated first, so the new values are the source.
          const { errors } = await translateUiStrings(shop, others, {
            keys: staleKeys,
          });
          for (const message of errors) {
            console.error(
              `[ai] ensureUiStringsFresh retranslation issue for ${shop}: ${message}`,
            );
          }
        }
      }
      if (missing) {
        await ensureUiStrings(shop, settings.languages);
      }
      // Fill per-language gaps last (after any EN re-seeding above): only
      // missing rows are written, so merchant edits are never overwritten.
      if (gapLanguages.length > 0) {
        const { errors } = await translateUiStrings(shop, gapLanguages, {
          onlyMissing: true,
        });
        for (const message of errors) {
          console.error(`[ai] ensureUiStringsFresh gap repair issue for ${shop}: ${message}`);
        }
      }
    })().catch((error) =>
      console.error(`[ai] ensureUiStringsFresh repair failed for ${shop}:`, error),
    );
  } catch (error) {
    console.error(`[ai] ensureUiStringsFresh failed for ${shop}:`, error);
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
 * `opts.keys` scopes the pass to exactly those keys (unknown keys are
 * ignored); `opts.onlyMissing` further filters to keys the target language
 * has no row for — the two compose. Never throws — failures are collected
 * per language into `errors`.
 */
export async function translateUiStrings(
  shop: string,
  languages: string[],
  opts?: { onlyMissing?: boolean; keys?: string[] },
): Promise<{ translated: number; errors: string[] }> {
  const onlyMissing = opts?.onlyMissing ?? false;
  const keyScope = opts?.keys;
  const scopedKeys = keyScope
    ? UI_STRING_KEYS.filter((key) => keyScope.includes(key))
    : UI_STRING_KEYS;
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
      let keys = [...scopedKeys];
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
