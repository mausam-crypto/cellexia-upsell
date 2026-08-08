// ─────────────────────────────────────────────────────────────────────────────
// Debug tracing — full visibility into one offer assembly, end to end.
//
// A DebugTrace is an in-memory collector threaded through the orchestrator and
// the AI layer via optional fields (AssembleOfferOptions.debug /
// GenerateCopyArgs.debug). Every resolution step appends a structured entry:
// language, market matching, per-product name + grounding provenance, pricing,
// copy cache keys, the EXACT rendered prompts sent to Claude and its raw
// output. At the end of the assembly the trace is persisted to DebugEvent
// (fire-and-forget — never on the request's critical path) and, for admin
// previews, returned inline so the Preview page can render it immediately.
//
// The alias scan is the root-cause hunter: it searches every prompt text block
// for KNOWN product-name variants in OTHER languages (base titles, Translate &
// Adapt titles, manual name overrides — across all languages) and reports
// exactly which foreign-language name appears in which text block. "German
// product name in English copy" becomes a one-line finding instead of a
// guessing game.
//
// Never throws anywhere: tracing must not be able to break the traced path.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { jstr } from "../lib/json";
import type { CatalogProduct } from "./catalog.server";

/** One step in the trace. `data` must be JSON-serializable. */
export interface DebugEntry {
  stage: string;
  /** ms since the trace started — orders entries and shows where time went. */
  atMs: number;
  data: unknown;
}

export interface DebugTrace {
  startedAt: number;
  entries: DebugEntry[];
}

/** Cap any single captured text so a trace row stays a sane size. */
const TEXT_CAP = 20_000;
/** Cap the serialized trace persisted to the DB. */
const ROW_CAP = 400_000;
/** Traces older than this are pruned on every write. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createDebugTrace(): DebugTrace {
  return { startedAt: Date.now(), entries: [] };
}

/** Append a step. Safe on undefined traces so call sites stay one-liners. */
export function debugAdd(trace: DebugTrace | undefined, stage: string, data: unknown): void {
  if (!trace) return;
  try {
    trace.entries.push({ stage, atMs: Date.now() - trace.startedAt, data });
  } catch {
    // never let tracing break the traced path
  }
}

/** Truncate long text for capture, keeping the head (names live up front). */
export function debugText(value: unknown, cap: number = TEXT_CAP): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= cap ? text : `${text.slice(0, cap)}… [truncated ${text.length - cap} chars]`;
}

// ── Alias scan ───────────────────────────────────────────────────────────────

export interface AliasHit {
  /** The foreign-language name found verbatim in a prompt text block. */
  alias: string;
  /** Language key the alias belongs to ("base" = the base product title). */
  aliasLanguage: string;
  /** Where it came from: base title, T&A translation, or manual override. */
  aliasSource: "base_title" | "translation" | "name_override";
  productId: string;
  /** The buyer-language name the copy SHOULD be using for this product. */
  expectedName: string;
  /** Which prompt block contained it (basket_summary, offer_summary, …). */
  foundIn: string;
  /** Short excerpt around the first occurrence. */
  excerpt: string;
}

/**
 * Search prompt text blocks for product-name variants that are NOT the
 * buyer-language name. Every known name of every involved product — base
 * title, all T&A titles, all manual overrides — is a candidate alias; any
 * occurrence of one that differs from the buyer-language name is reported
 * with its location. Case-insensitive; aliases shorter than 5 chars are
 * skipped (too collision-prone).
 */
export function scanForForeignNames(
  products: Array<{ product: CatalogProduct; expectedName: string }>,
  textBlocks: Record<string, string>,
  buyerLanguage: string,
): AliasHit[] {
  const hits: AliasHit[] = [];
  try {
    for (const { product, expectedName } of products) {
      const aliases: Array<{ value: string; language: string; source: AliasHit["aliasSource"] }> = [
        { value: product.title, language: "base", source: "base_title" },
      ];
      for (const [lang, entry] of Object.entries(product.translations ?? {})) {
        if (entry?.title) aliases.push({ value: entry.title, language: lang, source: "translation" });
      }
      for (const [lang, value] of Object.entries(product.nameOverrides ?? {})) {
        if (value) aliases.push({ value, language: lang, source: "name_override" });
      }
      const expectedLc = expectedName.trim().toLowerCase();
      for (const alias of aliases) {
        const value = alias.value.trim();
        // The buyer-language name itself is expected to appear — skip it, and
        // skip near-collision short strings.
        if (value.length < 5 || value.toLowerCase() === expectedLc) continue;
        for (const [blockName, block] of Object.entries(textBlocks)) {
          if (!block) continue;
          const idx = block.toLowerCase().indexOf(value.toLowerCase());
          if (idx === -1) continue;
          hits.push({
            alias: value,
            aliasLanguage: alias.language,
            aliasSource: alias.source,
            productId: product.productId,
            expectedName,
            foundIn: blockName,
            excerpt: debugText(block.slice(Math.max(0, idx - 80), idx + value.length + 80), 400),
            // buyerLanguage recorded implicitly via expectedName; kept in the
            // summary by the caller.
          });
        }
      }
    }
  } catch {
    // diagnostic-only — a scan failure must never break anything
  }
  void buyerLanguage;
  return hits;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist a finished trace. Fire-and-forget by design: callers `void` this.
 * Prunes rows older than RETENTION_MS on every write so the table can never
 * grow unbounded, even with live-request logging left on.
 */
export async function persistDebugTrace(args: {
  shop: string;
  referenceId: string;
  surface: string;
  trace: DebugTrace;
  summary: Record<string, unknown>;
}): Promise<void> {
  try {
    let dataJson = jstr(args.trace.entries);
    if (dataJson.length > ROW_CAP) {
      // Keep the earliest entries (setup/resolution) and note the cut — the
      // tail is usually repeated raw model output.
      const kept: DebugEntry[] = [];
      let size = 2;
      for (const entry of args.trace.entries) {
        const s = jstr(entry).length + 1;
        if (size + s > ROW_CAP) break;
        kept.push(entry);
        size += s;
      }
      kept.push({ stage: "trace-truncated", atMs: 0, data: { dropped: args.trace.entries.length - kept.length } });
      dataJson = jstr(kept);
    }
    await prisma.debugEvent.create({
      data: {
        shop: args.shop,
        referenceId: args.referenceId,
        surface: args.surface,
        summaryJson: jstr(args.summary),
        dataJson,
      },
    });
    await prisma.debugEvent.deleteMany({
      where: { shop: args.shop, createdAt: { lt: new Date(Date.now() - RETENTION_MS) } },
    });
  } catch (error) {
    console.error(`[debug] trace persist failed for ${args.shop}`, error);
  }
}
