// JSON columns are stored as strings for SQLite portability.

export function jparse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function jstr(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Deep-merge `patch` onto `base`. Arrays and primitives are replaced. */
export function deepMerge<T>(base: T, patch: Partial<T> | undefined | null): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (
      v &&
      cur &&
      typeof v === "object" &&
      typeof cur === "object" &&
      !Array.isArray(v) &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** "gid://shopify/ProductVariant/123" -> 123 */
export function gidToNumber(gid: string): number {
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

/** 123 or "123" -> "gid://shopify/Product/123" */
export function toGid(kind: "Product" | "ProductVariant" | "Order" | "Customer", id: string | number): string {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/${kind}/${s}`;
}
