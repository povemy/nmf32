import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeSearchQuery } from "@/lib/search-normalize";
import type { Prisma } from "@prisma/client";
import { productCardInclude, toProductCard, FALLBACK_IMG, type ProductWithRelations } from "../../../_shared/product-card";
import { tokenize, buildTokenWhere, scoreProduct } from "../../_shared/search";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type { MarketSuggestData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// PHASE 2 / C: header autocomplete — public read, cached 30 s. NOTE (Phase 2.1
// §9-C): the shopper UI is now SUBMIT-ONLY — no client surface fires requests
// per keystroke, and the storefront/market search boxes submit a complete
// keyword. The route remains available for API consumers but is hardened as a
// public, cache-keyed endpoint:
//   • PHASE 2.1 §9-B: the query is NORMALIZED before it can touch a cache key
//     (control chars stripped, ≤80 chars, whitespace collapsed/trimmed) — a
//     scripted client can no longer mint unbounded cache cardinality via
//     randomized raw strings.
//   • 30/min/IP rate limit (public read, unauthenticated).
//   • empty/junk queries short-circuit with ZERO cache interaction.
const loadSuggest = publicCache(
  async (raw: string) => {
    const tokens = tokenize(raw);
    if (tokens.length === 0) return { products: [], stores: [] };
    const tokenWhere = buildTokenWhere(tokens);
    const where: Prisma.ProductWhereInput = {
      status: "active",
      // C1.3 (seller publication governance): only an admin-approved seller's
      // live store may surface in public autocomplete.
      store: { is: { status: "live", seller: { is: { status: "active", marketplaceOptIn: true } } } },
      ...(tokenWhere ? { AND: [tokenWhere] } : {}),
    };
    const [rows, storeRows] = await Promise.all([
      db.product.findMany({ where, include: productCardInclude, orderBy: { salesCount: "desc" }, take: 30 }),
      db.store.findMany({
        where: {
          // C1.3: same seller-status defense-in-depth for the store suggestions.
          status: "live",
          seller: { is: { status: "active", marketplaceOptIn: true } },
          name: { contains: raw, mode: "insensitive" },
        },
        select: { name: true, slug: true, logoUrl: true },
        orderBy: { name: "asc" },
        take: 3,
      }),
    ]);
    const products = rows
      .map((p) => ({ p: p as ProductWithRelations, s: scoreProduct(p as ProductWithRelations, tokens, raw) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map(({ p }) => toProductCard(p));
    const stores = storeRows.map((s) => ({
      name: s.name,
      slug: s.slug,
      logoUrl: s.logoUrl ?? FALLBACK_IMG,
    }));
    return { products, stores };
  },
  ["market-suggest"],
  { ttl: 30, tags: [PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.stores] }
);

// GET /api/market/search/suggest?q= — header autocomplete (public market data).
// Returns up to 6 product cards (relevance-ranked) + up to 3 live stores whose
// name matches the normalized query.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "market-suggest", 30);
  const url = new URL(req.url);
  const raw = normalizeSearchQuery(url.searchParams.get("q"));
  if (raw === "") {
    // junk/empty ⇒ no cache entry
    const empty: MarketSuggestData = { products: [], stores: [] };
    return ok(empty);
  }
  const { products, stores } = await loadSuggest(raw);
  const payload: MarketSuggestData = { products, stores };
  return ok(payload);
});
