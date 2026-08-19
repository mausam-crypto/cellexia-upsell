// Country → MarketSetting resolution shared by the engine (gating, discount /
// max-offers overrides), the orchestrator (language override, meta) and the
// admin. A country can legitimately appear in MORE than one Shopify market
// (e.g. DE in both "germany" and a broader "eu" market, or a stale row for a
// market that was since removed in Shopify): resolution must be deterministic
// and mirror Shopify's own ranking — the MOST SPECIFIC market (fewest
// countries) wins, ties broken by handle. Never "whichever row the database
// happened to return first".

import { jparse } from "./json";

export interface MarketRowLike {
  marketHandle: string;
  countriesJson: string;
}

export function marketCountries(row: MarketRowLike): string[] {
  return jparse<string[]>(row.countriesJson, [])
    .map((c) => String(c).trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
}

/** All rows listing the country, most specific first. */
export function marketsForCountry<T extends MarketRowLike>(
  rows: T[],
  countryCode: string | null | undefined,
): T[] {
  const cc = String(countryCode ?? "").trim().toUpperCase();
  if (!cc) return [];
  return rows
    .map((row) => ({ row, countries: marketCountries(row) }))
    .filter(({ countries }) => countries.includes(cc))
    .sort(
      (a, b) =>
        a.countries.length - b.countries.length ||
        a.row.marketHandle.localeCompare(b.row.marketHandle),
    )
    .map(({ row }) => row);
}

/** The single market that governs the country (most specific), or null. */
export function resolveMarketForCountry<T extends MarketRowLike>(
  rows: T[],
  countryCode: string | null | undefined,
): T | null {
  return marketsForCountry(rows, countryCode)[0] ?? null;
}
