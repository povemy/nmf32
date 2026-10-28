// Shared search machinery for the market search system (S1).
// Powers /api/market/products (results page), /api/market/search/suggest
// (header autocomplete) and /api/market/search/related (similar products).
//
// Postgres `contains` is CASE-SENSITIVE in Prisma unless mode:"insensitive" —
// the original single-field sensitive match was the root cause of "searching
// available product, but none shows".

import type { Prisma } from "@prisma/client";

/** Split a raw query into lowercase tokens (letters/digits/%), dropping noise.
 *  "Aurora Ceramic Vase — large" → ["aurora","ceramic","vase","large"] */
export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

export type SearchableProduct = {
  title: string;
  description?: string | null;
  category?: { name?: string | null } | null;
  store?: { name?: string | null } | null;
  salesCount?: number;
  ratingAvg?: number;
};

/** Relevance score for one product against a query. Higher = better.
 *  Weights: phrase-in-title 60 ▸ every-token-in-title 30 ▸
 *          per-token title 20 ▸ category 8 ▸ store 6 ▸ description 3;
 *  popularity/ratings only nudge ties. */
export function scoreProduct(p: SearchableProduct, tokens: string[], rawQuery: string): number {
  const title = (p.title ?? "").toLowerCase();
  const desc = (p.description ?? "").toLowerCase();
  const cat = (p.category?.name ?? "").toLowerCase();
  const store = (p.store?.name ?? "").toLowerCase();

  let score = 0;
  const phrase = rawQuery.trim().toLowerCase();
  if (phrase.length > 1 && title.includes(phrase)) score += 60;

  for (const t of tokens) {
    if (title.includes(t)) score += 20;
    if (cat.includes(t)) score += 8;
    if (store.includes(t)) score += 6;
    if (desc.includes(t)) score += 3;
  }
  if (tokens.length > 0 && tokens.every((t) => title.includes(t))) score += 30;

  score += (p.salesCount ?? 0) * 0.05 + (p.ratingAvg ?? 0) * 2;
  return score;
}

/** Prisma WHERE fragment: every token must hit ≥1 searchable field
 *  (title, description, category name, store name) — case-insensitively.
 *  Returns null when there are no usable tokens (caller skips filtering). */
export function buildTokenWhere(tokens: string[]): Prisma.ProductWhereInput | null {
  if (tokens.length === 0) return null;
  const fieldHit = (t: string): Prisma.ProductWhereInput => ({
    OR: [
      { title: { contains: t, mode: "insensitive" as const } },
      { description: { contains: t, mode: "insensitive" as const } },
      { category: { is: { name: { contains: t, mode: "insensitive" as const } } } },
      { store: { is: { name: { contains: t, mode: "insensitive" as const } } } },
    ],
  });
  return { AND: tokens.map(fieldHit) };
}

/** Looser fragment for "similar products": ANY token may hit any field. */
export function buildAnyTokenWhere(tokens: string[]): Prisma.ProductWhereInput | null {
  if (tokens.length === 0) return null;
  const fieldHit = (t: string): Prisma.ProductWhereInput => ({
    OR: [
      { title: { contains: t, mode: "insensitive" as const } },
      { description: { contains: t, mode: "insensitive" as const } },
      { category: { is: { name: { contains: t, mode: "insensitive" as const } } } },
      { store: { is: { name: { contains: t, mode: "insensitive" as const } } } },
    ],
  });
  return { OR: tokens.map(fieldHit) };
}

export function rankByRelevance<T extends SearchableProduct>(rows: T[], rawQuery: string): T[] {
  const tokens = tokenize(rawQuery);
  return [...rows].sort((a, b) => scoreProduct(b, tokens, rawQuery) - scoreProduct(a, tokens, rawQuery));
}
