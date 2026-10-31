import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import type { Prisma } from "@prisma/client";
import { productCardInclude, toProductCard, FALLBACK_IMG, type ProductWithRelations } from "../../../_shared/product-card";
import { tokenize, buildTokenWhere, scoreProduct } from "../../_shared/search";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// PHASE 2 / C: header autocomplete — the highest-frequency public read (every
// keystroke). Cached 30 s per raw query string; products+stores tags busted on
// mutations. Per-prefix entries expire with the TTL, bounding cardinality.
const loadSuggest = publicCache(
  async (raw: string) => {
    const tokens = tokenize(raw);
    if (tokens.length === 0) return { products: [], stores: [] };
    const tokenWhere = buildTokenWhere(tokens);
    const where: Prisma.ProductWhereInput = {
      status: "active",
      store: { is: { status: "live", seller: { is: { marketplaceOptIn: true } } } },
      ...(tokenWhere ? { AND: [tokenWhere] } : {}),
    };
    const [rows, storeRows] = await Promise.all([
      db.product.findMany({ where, include: productCardInclude, orderBy: { salesCount: "desc" }, take: 30 }),
      db.store.findMany({
        where: {
          status: "live",
          seller: { is: { marketplaceOptIn: true } },
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
// name matches the raw query. Powers the top-bar suggestion dropdown.
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim();
  const { products, stores } = await loadSuggest(raw);
  return ok({ products, stores });
});
