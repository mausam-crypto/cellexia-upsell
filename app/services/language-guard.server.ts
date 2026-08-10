// ─────────────────────────────────────────────────────────────────────────────
// Language guard — deterministic wrong-language detection for buyer copy.
//
// Root cause this exists for: the copy models receive an entirely ENGLISH
// scaffold (system prompt, JSON schema, rule-10's English example sentence,
// brand context), and rule 1 ("write in {{language}}") is a request, not a
// guarantee — smaller models drift into English on some fields (proof and
// closer most often). Whatever they write gets cached and then served to every
// buyer of that language. This module gives the pipeline a way to CHECK the
// output, so callers can retry and, as a last resort, machine-translate the
// offending fields before anything is cached.
//
// Method: per text field, count DISTINCT high-frequency function words
// ("markers") for every supported language. A field is flagged when some
// OTHER language scores ≥ MIN_FOREIGN_HITS distinct markers while the target
// language scores ≤ MAX_TARGET_HITS — i.e. the text clearly reads as another
// language. Product names are stripped first (brand names are legitimately
// language-invariant). Arabic / Japanese / Greek targets use script ranges
// instead. Short fields (< MIN_TOKENS tokens) are never judged — there is not
// enough signal, and headlines are short by contract.
//
// The marker lists are curated to avoid cross-language homographs (e.g. "is"
// is Dutch, "also" and "will" are German, "are" is Romanian "has", "most" is
// Hungarian "now") — see EN_EXCLUSIONS_BY_TARGET and the per-language lists.
// Pure functions, no I/O, never throws.
// ─────────────────────────────────────────────────────────────────────────────

import type { OfferCopy } from "../types";

/** Minimum tokens (after name-stripping) before a field is judged at all. */
const MIN_TOKENS = 5;
/** A foreign language must show at least this many DISTINCT markers. */
const MIN_FOREIGN_HITS = 3;
/** ... while the target language shows at most this many. */
const MAX_TARGET_HITS = 1;
/** Script-based targets: minimum letters before judging. */
const MIN_SCRIPT_LETTERS = 10;
/** ... and the minimum share of target-script letters expected. */
const MIN_SCRIPT_SHARE = 0.3;

/**
 * Distinct high-frequency words per language. English's list deliberately
 * avoids the worst homographs (no "is", "in", "on", "a", "as", "was", "at",
 * "of", "to", "it"); residual collisions are handled per target via
 * EN_EXCLUSIONS_BY_TARGET.
 */
const MARKERS: Record<string, string[]> = {
  en: [
    "the", "and", "your", "yours", "with", "this", "that", "these", "those",
    "from", "have", "has", "had", "been", "will", "would", "should", "could",
    "are", "were", "they", "them", "their", "which", "while", "also", "only",
    "every", "most", "than", "when", "where", "you", "not", "our", "what",
    "because", "after", "before", "without", "within", "through", "skin",
    // Domain words near-certain in English upsell copy — closers and proof
    // lines are short on pure function words, so these carry the detection.
    "by", "order", "cost", "guarantee", "money", "backed", "ships", "shipped",
    "shipping", "results", "weeks", "studies", "research", "shown", "visibly",
    "appearance", "reduce", "fine", "lines",
  ],
  fr: [
    "le", "la", "les", "des", "une", "et", "est", "sont", "votre", "vos",
    "avec", "pour", "que", "qui", "vous", "notre", "dans", "peau", "cette",
    "aux", "grâce", "chaque", "votre", "être", "plus",
  ],
  de: [
    "der", "die", "das", "und", "ist", "sind", "mit", "für", "ihre", "ihrer",
    "sie", "auf", "eine", "einen", "einem", "nicht", "haut", "wird", "wirkt",
    "von", "zu", "bei", "durch", "ihr", "dem", "den",
  ],
  es: [
    "el", "los", "las", "una", "es", "son", "su", "sus", "con", "para",
    "que", "piel", "cada", "más", "está", "cutis", "y", "usted", "esta",
    "como", "por",
  ],
  it: [
    "il", "lo", "gli", "una", "è", "sono", "con", "per", "che", "della",
    "pelle", "sua", "sue", "dei", "delle", "più", "ogni", "questa", "questo",
    "viene", "come",
  ],
  nl: [
    "de", "het", "een", "en", "met", "voor", "uw", "huid", "van", "wordt",
    "niet", "ook", "zich", "deze", "die", "dat", "je", "bij", "door", "elke",
  ],
  da: [
    "og", "er", "med", "til", "din", "dit", "dine", "hud", "huden", "ikke",
    "som", "på", "af", "det", "den", "hver", "giver", "mere", "ved", "kan",
  ],
  sv: [
    "och", "är", "med", "till", "din", "ditt", "dina", "hud", "huden",
    "inte", "som", "på", "av", "det", "den", "varje", "ger", "mer", "vid",
    "för",
  ],
  no: [
    "og", "er", "med", "til", "din", "ditt", "dine", "hud", "huden", "ikke",
    "som", "på", "av", "det", "den", "hver", "gir", "mer", "ved", "kan",
  ],
  fi: [
    "ja", "ovat", "iho", "ihon", "ihoa", "ihosi", "sinun", "että", "joka",
    "tämä", "myös", "ei", "sekä", "kanssa", "jokainen", "voide", "avulla",
  ],
  pl: [
    "i", "jest", "są", "z", "ze", "na", "do", "twoja", "twojej", "skóra",
    "skóry", "skórę", "nie", "się", "oraz", "która", "dla", "każdy", "przez",
  ],
  pt: [
    "é", "são", "com", "para", "sua", "seu", "pele", "que", "uma", "não",
    "da", "dos", "das", "cada", "mais", "pela", "ao", "você", "e",
  ],
  ro: [
    "și", "este", "sunt", "cu", "pentru", "pielea", "pielii", "care", "un",
    "nu", "mai", "din", "fiecare", "prin", "dumneavoastră", "acest",
    "această",
  ],
  hu: [
    "és", "az", "bőr", "bőre", "bőrét", "önnek", "nem", "hogy", "egy", "meg",
    "minden", "vagy", "által", "segít", "hatására",
  ],
};

/**
 * EN marker words that are ALSO common words in a given target language —
 * removed from the English set when judging text for that target, so native
 * target text can never be mistaken for English.
 */
const EN_EXCLUSIONS_BY_TARGET: Record<string, string[]> = {
  de: ["also", "will"], //   German "also" (= so), "will" (= wants)
  ro: ["are", "reduce"], //  Romanian "are" (= has), "reduce" (verb)
  hu: ["most"], //           Hungarian "most" (= now)
  da: ["have", "by"], //     Danish "at have" (= to have), "by" (= town)
  no: ["have", "by"], //     Norwegian "have"/"by" likewise
  nl: ["been", "had"], //    Dutch "been" (= leg), "had" (= had)
  es: ["reduce"], //         Spanish "reduce" (él reduce las arrugas)
  it: ["fine"], //           Italian "fine" (= end)
};

/** Script ranges for non-Latin targets. */
const SCRIPT_RANGES: Record<string, RegExp> = {
  ar: /[؀-ۿݐ-ݿ]/,
  el: /[Ͱ-Ͽἀ-῿]/,
  ja: /[぀-ゟ゠-ヿ一-鿿]/,
};

function baseLang(language: string): string {
  return String(language ?? "").trim().toLowerCase().split("-")[0];
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((t) => t.length > 0);
}

function distinctHits(tokens: string[], markers: string[], exclude?: Set<string>): number {
  const present = new Set(tokens);
  let hits = 0;
  for (const marker of markers) {
    if (exclude?.has(marker)) continue;
    if (present.has(marker)) hits++;
  }
  return hits;
}

/** Strip known product names so brand names never count as "foreign text". */
function stripNames(text: string, ignoreNames: string[]): string {
  let out = text;
  for (const name of ignoreNames) {
    const trimmed = (name ?? "").trim();
    if (trimmed.length < 3) continue;
    // Plain case-insensitive removal; regex-escape the name.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), " ");
  }
  return out;
}

/**
 * Does `text` clearly read as a language other than `language`? Deterministic
 * and conservative: short or ambiguous text is never flagged. `ignoreNames`
 * lists product names that may legitimately appear untranslated.
 */
export function isWrongLanguage(
  text: string,
  language: string,
  ignoreNames: string[] = [],
): boolean {
  try {
    const target = baseLang(language);
    if (!target) return false;
    const cleaned = stripNames(String(text ?? ""), ignoreNames);

    const script = SCRIPT_RANGES[target];
    if (script) {
      const letters = cleaned.match(/\p{L}/gu) ?? [];
      if (letters.length < MIN_SCRIPT_LETTERS) return false;
      const inScript = letters.filter((ch) => script.test(ch)).length;
      return inScript / letters.length < MIN_SCRIPT_SHARE;
    }

    const tokens = tokenize(cleaned);
    if (tokens.length < MIN_TOKENS) return false;
    const targetMarkers = MARKERS[target];
    const targetHits = targetMarkers ? distinctHits(tokens, targetMarkers) : 0;
    if (targetHits > MAX_TARGET_HITS) return false;

    const enExclusions = new Set(EN_EXCLUSIONS_BY_TARGET[target] ?? []);
    for (const [lang, markers] of Object.entries(MARKERS)) {
      if (lang === target) continue;
      const exclude = lang === "en" ? enExclusions : undefined;
      if (distinctHits(tokens, markers, exclude) >= MIN_FOREIGN_HITS) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // the guard must never break the pipeline
  }
}

/** A flagged copy field, addressable for surgical correction. */
export interface FlaggedField {
  field: "headline" | "body" | "closer" | "bullets" | "paragraphs" | "proof";
  index?: number;
  /** Human-readable path, e.g. "proof[0]". */
  path: string;
  text: string;
}

/** Check every field of an OfferCopy; returns the flagged fields (empty = clean). */
export function checkCopyLanguage(
  copy: OfferCopy,
  language: string,
  ignoreNames: string[] = [],
): FlaggedField[] {
  const flagged: FlaggedField[] = [];
  const single = (field: "headline" | "body" | "closer", text: string | undefined): void => {
    if (typeof text === "string" && text && isWrongLanguage(text, language, ignoreNames)) {
      flagged.push({ field, path: field, text });
    }
  };
  const list = (field: "bullets" | "paragraphs" | "proof", items: string[] | undefined): void => {
    (items ?? []).forEach((text, index) => {
      if (typeof text === "string" && text && isWrongLanguage(text, language, ignoreNames)) {
        flagged.push({ field, index, path: `${field}[${index}]`, text });
      }
    });
  };
  single("headline", copy.headline);
  single("body", copy.body);
  single("closer", copy.closer);
  list("bullets", copy.bullets);
  list("paragraphs", copy.paragraphs);
  list("proof", copy.proof);
  return flagged;
}

/** Write corrected text back into a copy object at a flagged field's address. */
export function applyFieldText(copy: OfferCopy, field: FlaggedField, text: string): void {
  const value = (text ?? "").trim();
  if (!value) return;
  if (field.field === "headline") copy.headline = value;
  else if (field.field === "body") copy.body = value;
  else if (field.field === "closer") copy.closer = value;
  else if (field.index !== undefined) {
    const arr = copy[field.field];
    if (Array.isArray(arr) && field.index < arr.length) arr[field.index] = value;
  }
}
