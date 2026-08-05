import prisma from "../db.server";
import { DEFAULT_SETTINGS, type AppSettings } from "../types";
import { deepMerge, jparse, jstr } from "../lib/json";

export async function ensureShop(shop: string) {
  return prisma.shop.upsert({
    where: { shop },
    update: {},
    create: { shop, settingsJson: "{}" },
  });
}

/** Stored settings merged over defaults — always returns a complete object. */
export async function getSettings(shop: string): Promise<AppSettings> {
  const row = await prisma.shop.findUnique({ where: { shop } });
  const stored = jparse<Partial<AppSettings>>(row?.settingsJson, {});
  return deepMerge(structuredClone(DEFAULT_SETTINGS), stored);
}

/** Deep-merges `patch` into the stored settings (not into defaults, so unset keys keep tracking defaults). */
export async function saveSettings(
  shop: string,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const row = await ensureShop(shop);
  const stored = jparse<Partial<AppSettings>>(row.settingsJson, {});
  const next = deepMerge(stored, patch);
  await prisma.shop.update({
    where: { shop },
    data: { settingsJson: jstr(next) },
  });
  return deepMerge(structuredClone(DEFAULT_SETTINGS), next);
}
